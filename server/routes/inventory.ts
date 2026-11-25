import { Router } from 'express';
import { getDb, withTransaction } from '../db.ts';
import { authenticate, recordAuditLog, requirePermission, type AuthRequest } from '../middleware/auth.ts';
import { addDaysISO, nowISO, roundMoney, roundQty, todayISO } from '../utils/helpers.ts';
import { getNextDocumentNumber } from '../services/numbering.ts';
import { getItemWarehouseBalance, getTotalItemStock, postStockMovement } from '../services/inventory.ts';
import { postJournalEntry } from '../services/accounting.ts';
import { requestDocumentApproval } from '../services/approvals.ts';

const router = Router();
router.use(authenticate);

// Stock Balances across warehouses
router.get('/balances', requirePermission('inventory', 'can_view'), (_req, res) => {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT sl.item_id, i.item_code, i.name as item_name, i.stock_uom, c.name as category_name,
              sl.warehouse_id, w.code as warehouse_code, w.name as warehouse_name,
              sl.closing_qty, sl.unit_cost, sl.stock_value, sl.valuation_method
       FROM stock_ledger sl
       INNER JOIN (
         SELECT item_id, warehouse_id, MAX(id) as max_id
         FROM stock_ledger
         GROUP BY item_id, warehouse_id
       ) latest ON latest.max_id = sl.id
       JOIN items i ON i.id = sl.item_id
       JOIN item_categories c ON c.id = i.category_id
       JOIN warehouses w ON w.id = sl.warehouse_id
       ORDER BY i.item_code ASC, w.code ASC`
    )
    .all();
  res.json({ items: rows });
});

// Stock Ledger / Stock Register
router.get('/ledger', requirePermission('inventory', 'can_view'), (req, res) => {
  const db = getDb();
  const itemId = req.query.item_id ? Number(req.query.item_id) : null;
  const warehouseId = req.query.warehouse_id ? Number(req.query.warehouse_id) : null;
  const rows = db
    .prepare(
      `SELECT sl.*, i.item_code, i.name as item_name, w.name as warehouse_name,
              st.tank_code, st.name as tank_name
       FROM stock_ledger sl
       JOIN items i ON i.id = sl.item_id
       JOIN warehouses w ON w.id = sl.warehouse_id
       LEFT JOIN storage_tanks st ON st.id = sl.tank_id
       WHERE (? IS NULL OR sl.item_id = ?) AND (? IS NULL OR sl.warehouse_id = ?)
       ORDER BY sl.id DESC LIMIT 500`
    )
    .all(itemId, itemId, warehouseId, warehouseId);
  res.json({ items: rows });
});

// Stock Batches & Ageing
router.get('/batches', requirePermission('inventory', 'can_view'), (_req, res) => {
  const db = getDb();
  const today = new Date(todayISO()).getTime();
  const rows = db
    .prepare(
      `SELECT sb.*, i.item_code, i.name as item_name, i.stock_uom, w.name as warehouse_name, s.name as supplier_name,
              st.tank_code, st.name as tank_name
       FROM stock_batches sb
       JOIN items i ON i.id = sb.item_id
       JOIN warehouses w ON w.id = sb.warehouse_id
       LEFT JOIN suppliers s ON s.id = sb.supplier_id
       LEFT JOIN storage_tanks st ON st.id = sb.tank_id
       ORDER BY sb.id DESC`
    )
    .all() as Record<string, unknown>[];

  const enriched = rows.map((b) => {
    const created = new Date(String(b.created_at).slice(0, 10)).getTime();
    const ageDays = Math.max(0, Math.floor((today - created) / (1000 * 60 * 60 * 24)));
    return { ...b, age_days: ageDays };
  });
  res.json({ items: enriched });
});

// Stock Entries (Receipt, Issue, Transfer, Adjustment, Reconciliation)
router.get('/entries', requirePermission('inventory', 'can_view'), (_req, res) => {
  const db = getDb();
  const entries = db
    .prepare(
      `SELECT se.*, fw.name as from_warehouse_name, tw.name as to_warehouse_name, cr.full_name as creator_name
       FROM stock_entries se
       LEFT JOIN warehouses fw ON fw.id = se.from_warehouse_id
       LEFT JOIN warehouses tw ON tw.id = se.to_warehouse_id
       LEFT JOIN users cr ON cr.id = se.created_by
       ORDER BY se.id DESC`
    )
    .all() as Record<string, unknown>[];
  const items = db
    .prepare(
      `SELECT sei.*, i.item_code, i.name as item_name,
              ft.tank_code as from_tank_code, ft.name as from_tank_name,
              tt.tank_code as to_tank_code, tt.name as to_tank_name
       FROM stock_entry_items sei
       JOIN items i ON i.id = sei.item_id
       LEFT JOIN storage_tanks ft ON ft.id = sei.from_tank_id
       LEFT JOIN storage_tanks tt ON tt.id = sei.to_tank_id`
    )
    .all() as { stock_entry_id: number }[];
  res.json({ items: entries.map((e) => ({ ...e, items: items.filter((it) => it.stock_entry_id === Number(e.id)) })) });
});

router.post('/entries', requirePermission('inventory', 'can_create'), (req: AuthRequest, res) => {
  const b = req.body as {
    entry_type: 'Stock Receipt' | 'Stock Issue' | 'Warehouse Transfer' | 'Stock Adjustment' | 'Stock Reconciliation';
    entry_date?: string;
    from_warehouse_id?: number;
    to_warehouse_id?: number;
    from_tank_id?: number | null;
    to_tank_id?: number | null;
    remarks?: string;
    items: {
      item_id: number;
      batch_number?: string;
      qty: number;
      unit_cost?: number;
      reason?: string;
      from_tank_id?: number | null;
      to_tank_id?: number | null;
    }[];
  };
  if (!b.entry_type || !Array.isArray(b.items) || b.items.length === 0) {
    res.status(400).json({ error: 'Entry type and at least one item are required' });
    return;
  }

  try {
    const result = withTransaction((db) => {
      const seNumber = getNextDocumentNumber(db, 'SE');
      const entryDate = b.entry_date || todayISO();
      let totalValue = 0;

      const computed = b.items.map((l) => {
        const item = db.prepare('SELECT stock_uom, average_cost, standard_cost FROM items WHERE id = ?').get(l.item_id) as {
          stock_uom: string;
          average_cost: number;
          standard_cost: number;
        };
        const whForCost = b.from_warehouse_id || b.to_warehouse_id || 1;
        const current = getItemWarehouseBalance(db, l.item_id, whForCost);
        const cost = roundMoney(l.unit_cost || current.avgCost || item.average_cost || item.standard_cost);
        const varianceQty = b.entry_type === 'Stock Reconciliation' ? roundQty(l.qty - current.qty) : roundQty(l.qty);
        const lineVal = roundMoney(Math.abs(varianceQty) * cost);
        totalValue = roundMoney(totalValue + lineVal);
        return { ...l, uom: item.stock_uom, cost, systemQty: current.qty, varianceQty, lineVal };
      });

      const r = db
        .prepare(
          `INSERT INTO stock_entries (entry_number, entry_type, entry_date, from_warehouse_id, to_warehouse_id, status, approval_status, remarks, total_value, created_by, created_at)
           VALUES (?, ?, ?, ?, ?, 'Draft', 'Not Required', ?, ?, ?, ?)`
        )
        .run(
          seNumber,
          b.entry_type,
          entryDate,
          b.from_warehouse_id || null,
          b.to_warehouse_id || null,
          b.remarks || '',
          totalValue,
          req.user!.id,
          nowISO()
        );
      const seId = Number(r.lastInsertRowid);
      const ins = db.prepare(
        'INSERT INTO stock_entry_items (stock_entry_id, item_id, batch_number, from_tank_id, to_tank_id, qty, uom, unit_cost, total_cost, system_qty, variance_qty, reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
      );
      for (const c of computed) {
        ins.run(
          seId,
          c.item_id,
          c.batch_number || '',
          c.from_tank_id ?? b.from_tank_id ?? null,
          c.to_tank_id ?? b.to_tank_id ?? null,
          roundQty(c.qty),
          c.uom,
          c.cost,
          c.lineVal,
          c.systemQty,
          c.varianceQty,
          c.reason || ''
        );
      }
      recordAuditLog(db, req.user, 'StockEntry', seId, seNumber, `Create ${b.entry_type}`, { totalValue });
      return { id: seId, entry_number: seNumber, total_value: totalValue };
    });
    res.status(201).json(result);
  } catch (err: unknown) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Failed to create stock entry' });
  }
});

router.post('/entries/:id/submit', requirePermission('inventory', 'can_submit'), (req: AuthRequest, res) => {
  const seId = Number(req.params.id);
  try {
    const result = withTransaction((db) => {
      const se = db.prepare('SELECT * FROM stock_entries WHERE id = ?').get(seId) as
        | {
            id: number;
            entry_number: string;
            entry_type: string;
            entry_date: string;
            from_warehouse_id: number | null;
            to_warehouse_id: number | null;
            status: string;
            total_value: number;
          }
        | undefined;
      if (!se) throw new Error('Stock entry not found');
      if (se.status === 'Submitted') throw new Error('Stock entry already submitted');

      if (['Stock Adjustment', 'Stock Reconciliation'].includes(se.entry_type)) {
        const app = requestDocumentApproval(db, {
          docType: 'StockAdjustment',
          docId: se.id,
          docNumber: se.entry_number,
          amount: se.total_value,
          currency: 'AED',
          warehouseId: se.from_warehouse_id || se.to_warehouse_id,
          user: req.user!,
        });
        if (app.status === 'Pending') {
          db.prepare("UPDATE stock_entries SET status = 'Pending Approval', approval_status = 'Pending' WHERE id = ?").run(seId);
          return { status: 'Pending Approval', requiredRole: app.requiredRoleName };
        }
      }

      const lines = db.prepare('SELECT * FROM stock_entry_items WHERE stock_entry_id = ?').all(seId) as {
        item_id: number;
        batch_number: string;
        from_tank_id: number | null;
        to_tank_id: number | null;
        qty: number;
        unit_cost: number;
        variance_qty: number;
      }[];

      let adjDebit = 0;
      let adjCredit = 0;

      for (const l of lines) {
        if (se.entry_type === 'Warehouse Transfer') {
          if (!se.from_warehouse_id || !se.to_warehouse_id) throw new Error('Source and target warehouses required for transfer');
          const out = postStockMovement(db, {
            postingDate: se.entry_date,
            docType: 'WarehouseTransfer',
            docId: se.id,
            docNumber: se.entry_number,
            itemId: l.item_id,
            warehouseId: se.from_warehouse_id,
            tankId: l.from_tank_id,
            batchNumber: l.batch_number,
            outwardQty: l.qty,
            unitCost: l.unit_cost,
            userId: req.user!.id,
          });
          postStockMovement(db, {
            postingDate: se.entry_date,
            docType: 'WarehouseTransfer',
            docId: se.id,
            docNumber: se.entry_number,
            itemId: l.item_id,
            warehouseId: se.to_warehouse_id,
            tankId: l.to_tank_id,
            batchNumber: l.batch_number || `TR-${se.entry_number}-${l.item_id}`,
            inwardQty: l.qty,
            unitCost: out.unitCost,
            userId: req.user!.id,
          });
        } else if (se.entry_type === 'Stock Receipt') {
          if (!se.to_warehouse_id) throw new Error('Target warehouse required');
          postStockMovement(db, {
            postingDate: se.entry_date,
            docType: 'StockReceipt',
            docId: se.id,
            docNumber: se.entry_number,
            itemId: l.item_id,
            warehouseId: se.to_warehouse_id,
            tankId: l.to_tank_id,
            batchNumber: l.batch_number,
            inwardQty: l.qty,
            unitCost: l.unit_cost,
            userId: req.user!.id,
          });
        } else if (se.entry_type === 'Stock Issue') {
          if (!se.from_warehouse_id) throw new Error('Source warehouse required');
          postStockMovement(db, {
            postingDate: se.entry_date,
            docType: 'StockIssue',
            docId: se.id,
            docNumber: se.entry_number,
            itemId: l.item_id,
            warehouseId: se.from_warehouse_id,
            tankId: l.from_tank_id,
            batchNumber: l.batch_number,
            outwardQty: l.qty,
            unitCost: l.unit_cost,
            userId: req.user!.id,
          });
          adjDebit = roundMoney(adjDebit + l.qty * l.unit_cost);
        } else if (se.entry_type === 'Stock Adjustment' || se.entry_type === 'Stock Reconciliation') {
          const whId = se.to_warehouse_id || se.from_warehouse_id;
          if (!whId) throw new Error('Warehouse required');
          const delta = se.entry_type === 'Stock Reconciliation' ? l.variance_qty : l.qty;
          const adjTankId = l.to_tank_id || l.from_tank_id || null;
          if (delta > 0) {
            postStockMovement(db, {
              postingDate: se.entry_date,
              docType: 'StockAdjustment',
              docId: se.id,
              docNumber: se.entry_number,
              itemId: l.item_id,
              warehouseId: whId,
              tankId: adjTankId,
              batchNumber: l.batch_number,
              inwardQty: delta,
              unitCost: l.unit_cost,
              userId: req.user!.id,
            });
            adjCredit = roundMoney(adjCredit + delta * l.unit_cost);
          } else if (delta < 0) {
            postStockMovement(db, {
              postingDate: se.entry_date,
              docType: 'StockAdjustment',
              docId: se.id,
              docNumber: se.entry_number,
              itemId: l.item_id,
              warehouseId: whId,
              tankId: adjTankId,
              batchNumber: l.batch_number,
              outwardQty: Math.abs(delta),
              unitCost: l.unit_cost,
              userId: req.user!.id,
            });
            adjDebit = roundMoney(adjDebit + Math.abs(delta) * l.unit_cost);
          }
        }
      }

      if (adjDebit > 0) {
        postJournalEntry(db, {
          postingDate: se.entry_date,
          entryType: 'Inventory Adjustment',
          refDocType: 'StockEntry',
          refDocId: se.id,
          refDocNumber: se.entry_number,
          narration: `${se.entry_type} ${se.entry_number} write-off/issue`,
          lines: [
            { accountCode: '5500', debit: adjDebit, description: `${se.entry_type} expense` },
            { accountCode: '1300', credit: adjDebit, description: `Inventory reduced` },
          ],
          userId: req.user!.id,
        });
      }
      if (adjCredit > 0) {
        postJournalEntry(db, {
          postingDate: se.entry_date,
          entryType: 'Inventory Adjustment',
          refDocType: 'StockEntry',
          refDocId: se.id,
          refDocNumber: se.entry_number,
          narration: `${se.entry_type} ${se.entry_number} gain`,
          lines: [
            { accountCode: '1300', debit: adjCredit, description: `Inventory gain` },
            { accountCode: '5500', credit: adjCredit, description: `${se.entry_type} gain offset` },
          ],
          userId: req.user!.id,
        });
      }

      db.prepare("UPDATE stock_entries SET status = 'Submitted', approval_status = 'Approved', submitted_by = ?, submitted_at = ? WHERE id = ?").run(
        req.user!.id,
        nowISO(),
        seId
      );
      recordAuditLog(db, req.user, 'StockEntry', seId, se.entry_number, `Submit ${se.entry_type}`, {});
      return { status: 'Submitted' };
    });
    res.json(result);
  } catch (err: unknown) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Failed to submit stock entry' });
  }
});

// ---------------- REORDER AUTOMATION & MRP ENGINE ----------------
function calculateReorderAndMrp(db: ReturnType<typeof getDb>) {
  const items = db
    .prepare(
      `SELECT i.*, c.name as category_name, s.name as preferred_supplier_name
       FROM items i
       JOIN item_categories c ON c.id = i.category_id
       LEFT JOIN suppliers s ON s.id = i.preferred_supplier_id
       WHERE i.is_active = 1`
    )
    .all() as {
    id: number;
    item_code: string;
    name: string;
    category_name: string;
    purchase_uom: string;
    stock_uom: string;
    reorder_level: number;
    min_stock: number;
    max_stock: number;
    safety_stock: number;
    lead_time_days: number;
    moq: number;
    preferred_supplier_id: number | null;
    preferred_supplier_name: string | null;
    default_warehouse_id: number | null;
  }[];

  return items.map((item) => {
    const availableStock = getTotalItemStock(db, item.id);
    const pendingPo =
      (
        db
          .prepare(
            `SELECT COALESCE(SUM(poi.qty - poi.received_qty), 0) as qty
             FROM purchase_order_items poi
             JOIN purchase_orders po ON po.id = poi.po_id
             WHERE poi.item_id = ? AND po.status IN ('Submitted', 'Partially Received', 'Pending Approval')`
          )
          .get(item.id) as { qty: number }
      ).qty || 0;

    const pendingMr =
      (
        db
          .prepare(
            `SELECT COALESCE(SUM(mri.qty - mri.ordered_qty), 0) as qty
             FROM material_request_items mri
             JOIN material_requests mr ON mr.id = mri.mr_id
             WHERE mri.item_id = ? AND mr.status IN ('Draft', 'Submitted')`
          )
          .get(item.id) as { qty: number }
      ).qty || 0;

    const reservedSales =
      (
        db
          .prepare(
            `SELECT COALESCE(SUM(soi.qty - soi.delivered_qty), 0) as qty
             FROM sales_order_items soi
             JOIN sales_orders so ON so.id = soi.so_id
             WHERE soi.item_id = ? AND so.status IN ('Submitted', 'Partially Delivered')`
          )
          .get(item.id) as { qty: number }
      ).qty || 0;

    // Expected consumption from open production orders (BOM scaled)
    const openProdOrders = db
      .prepare(
        `SELECT po.planned_qty, po.completed_qty, b.batch_size, bi.qty as bom_qty
         FROM production_orders po
         JOIN boms b ON b.id = po.bom_id
         JOIN bom_items bi ON bi.bom_id = b.id
         WHERE bi.item_id = ? AND po.status IN ('Draft', 'Planned', 'In Progress')`
      )
      .all(item.id) as { planned_qty: number; completed_qty: number; batch_size: number; bom_qty: number }[];

    const expectedProdConsumption = openProdOrders.reduce((sum, p) => {
      const remainingFg = Math.max(0, p.planned_qty - p.completed_qty);
      const scale = p.batch_size > 0 ? remainingFg / p.batch_size : 0;
      return sum + p.bom_qty * scale;
    }, 0);

    const netProjected = roundQty(availableStock + pendingPo - reservedSales - expectedProdConsumption);
    const targetLevel = Math.max(item.reorder_level, item.min_stock + item.safety_stock);
    let suggestedQty = 0;

    if (netProjected <= item.reorder_level || netProjected < 0) {
      const desiredCeiling = item.max_stock > targetLevel ? item.max_stock : targetLevel + Math.abs(Math.min(0, netProjected));
      const rawShortfall = Math.max(0, desiredCeiling - netProjected - pendingMr);
      if (rawShortfall > 0) {
        suggestedQty = roundQty(Math.max(rawShortfall, item.moq));
      }
    }

    return {
      item_id: item.id,
      item_code: item.item_code,
      item_name: item.name,
      category_name: item.category_name,
      uom: item.purchase_uom,
      available_stock: availableStock,
      reorder_level: item.reorder_level,
      safety_stock: item.safety_stock,
      min_stock: item.min_stock,
      max_stock: item.max_stock,
      pending_po_qty: roundQty(pendingPo),
      pending_mr_qty: roundQty(pendingMr),
      reserved_qty: roundQty(reservedSales),
      expected_production_qty: roundQty(expectedProdConsumption),
      net_projected_qty: netProjected,
      suggested_purchase_qty: suggestedQty,
      preferred_supplier_id: item.preferred_supplier_id,
      preferred_supplier_name: item.preferred_supplier_name || 'Unassigned',
      lead_time_days: item.lead_time_days,
      default_warehouse_id: item.default_warehouse_id,
      has_open_mr: pendingMr > 0,
      status: netProjected <= item.reorder_level ? 'Shortage' : 'Healthy',
    };
  });
}

router.get('/reorder-suggestions', requirePermission('inventory', 'can_view'), (_req, res) => {
  const db = getDb();
  const all = calculateReorderAndMrp(db);
  res.json({
    shortages: all.filter((r) => r.status === 'Shortage'),
    all,
  });
});

router.post('/reorder-generate-mr', requirePermission('procurement', 'can_create'), (req: AuthRequest, res) => {
  const { item_ids } = req.body as { item_ids?: number[] };
  try {
    const result = withTransaction((db) => {
      const all = calculateReorderAndMrp(db);
      const candidates = all.filter((r) => r.suggested_purchase_qty > 0 && !r.has_open_mr && (!item_ids || item_ids.includes(r.item_id)));

      if (candidates.length === 0) {
        return { created: false, message: 'No new shortage items without open Material Requests' };
      }

      const mrNumber = getNextDocumentNumber(db, 'MR');
      const r = db
        .prepare(
          `INSERT INTO material_requests (mr_number, request_type, request_date, required_date, requested_by, department, warehouse_id, source_doc_type, status, remarks, created_by, created_at)
           VALUES (?, 'Reorder Automation', ?, ?, ?, 'Inventory Planning', ?, 'ReorderEngine', 'Submitted', 'Auto-generated from Reorder & MRP Planning', ?, ?)`
        )
        .run(
          mrNumber,
          todayISO(),
          addDaysISO(todayISO(), 7),
          req.user!.full_name,
          candidates[0].default_warehouse_id || 1,
          req.user!.id,
          nowISO()
        );
      const mrId = Number(r.lastInsertRowid);
      const ins = db.prepare('INSERT INTO material_request_items (mr_id, item_id, description, qty, uom, warehouse_id) VALUES (?, ?, ?, ?, ?, ?)');
      for (const c of candidates) {
        ins.run(mrId, c.item_id, c.item_name, c.suggested_purchase_qty, c.uom, c.default_warehouse_id || 1);
      }
      recordAuditLog(db, req.user, 'MaterialRequest', mrId, mrNumber, 'Auto-generate Reorder MR', { items: candidates.length });
      return { created: true, id: mrId, mr_number: mrNumber, item_count: candidates.length };
    });
    res.json(result);
  } catch (err: unknown) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Failed to generate reorder MR' });
  }
});

export default router;
