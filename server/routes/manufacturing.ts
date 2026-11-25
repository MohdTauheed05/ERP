import { Router } from 'express';
import { getDb, withTransaction } from '../db.ts';
import { authenticate, recordAuditLog, requirePermission, type AuthRequest } from '../middleware/auth.ts';
import { nowISO, roundMoney, roundQty, todayISO } from '../utils/helpers.ts';
import { getNextDocumentNumber } from '../services/numbering.ts';
import { postStockMovement } from '../services/inventory.ts';
import { postJournalEntry } from '../services/accounting.ts';

const router = Router();
router.use(authenticate);

// ---------------- BILL OF MATERIALS (BOM) ----------------
router.get('/boms', requirePermission('manufacturing', 'can_view'), (_req, res) => {
  const db = getDb();
  const boms = db
    .prepare(
      `SELECT b.*, i.item_code as finished_item_code, i.name as finished_item_name
       FROM boms b
       JOIN items i ON i.id = b.finished_item_id
       ORDER BY b.id DESC`
    )
    .all() as Record<string, unknown>[];
  const items = db
    .prepare(
      `SELECT bi.*, i.item_code, i.name as item_name, i.average_cost, i.standard_cost as item_std_cost
       FROM bom_items bi
       JOIN items i ON i.id = bi.item_id
       ORDER BY bi.id ASC`
    )
    .all() as { bom_id: number; qty: number; standard_cost: number; wastage_pct: number }[];

  res.json({
    items: boms.map((b) => {
      const lines = items.filter((l) => l.bom_id === Number(b.id));
      const materialCost = roundMoney(lines.reduce((s, l) => s + l.qty * l.standard_cost * (1 + l.wastage_pct / 100), 0));
      const totalCost = roundMoney(materialCost + Number(b.labour_cost || 0) + Number(b.overhead_cost || 0));
      const unitCost = Number(b.batch_size) > 0 ? roundMoney(totalCost / Number(b.batch_size)) : 0;
      return { ...b, items: lines, material_cost: materialCost, total_batch_cost: totalCost, unit_standard_cost: unitCost };
    }),
  });
});

router.post('/boms', requirePermission('manufacturing', 'can_create'), (req: AuthRequest, res) => {
  const b = req.body as {
    finished_item_id: number;
    version?: string;
    batch_size: number;
    uom?: string;
    labour_cost?: number;
    overhead_cost?: number;
    expected_wastage_pct?: number;
    effective_date?: string;
    notes?: string;
    items: {
      item_id: number;
      component_type: 'Formula' | 'Packaging';
      qty: number;
      uom?: string;
      standard_cost?: number;
      wastage_pct?: number;
      is_alternative?: boolean;
      alternative_for_item_id?: number;
      sub_bom_id?: number;
      carton_packing_qty?: number;
    }[];
  };
  if (!b.finished_item_id || !b.batch_size || !Array.isArray(b.items) || b.items.length === 0) {
    res.status(400).json({ error: 'Finished item, batch size, and BOM components are required' });
    return;
  }
  try {
    const result = withTransaction((db) => {
      const bomNumber = getNextDocumentNumber(db, 'BOM');
      const fg = db.prepare('SELECT stock_uom FROM items WHERE id = ?').get(b.finished_item_id) as { stock_uom: string };
      const r = db
        .prepare(
          `INSERT INTO boms (bom_number, version, finished_item_id, batch_size, uom, labour_cost, overhead_cost, expected_wastage_pct, effective_date, is_active, is_approved, approved_by, notes, created_by, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1, ?, ?, ?, ?)`
        )
        .run(
          bomNumber,
          b.version || 'v1.0',
          b.finished_item_id,
          roundQty(b.batch_size),
          b.uom || fg.stock_uom,
          roundMoney(b.labour_cost || 0),
          roundMoney(b.overhead_cost || 0),
          b.expected_wastage_pct ?? 0.5,
          b.effective_date || todayISO(),
          req.user!.id,
          b.notes || '',
          req.user!.id,
          nowISO()
        );
      const bomId = Number(r.lastInsertRowid);
      const ins = db.prepare(
        `INSERT INTO bom_items (bom_id, item_id, component_type, qty, uom, standard_cost, wastage_pct, is_alternative, alternative_for_item_id, sub_bom_id, carton_packing_qty)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      for (const l of b.items) {
        const comp = db.prepare('SELECT stock_uom, average_cost, standard_cost FROM items WHERE id = ?').get(l.item_id) as {
          stock_uom: string;
          average_cost: number;
          standard_cost: number;
        };
        ins.run(
          bomId,
          l.item_id,
          l.component_type || 'Formula',
          roundQty(l.qty),
          l.uom || comp.stock_uom,
          roundMoney(l.standard_cost ?? (comp.average_cost || comp.standard_cost)),
          l.wastage_pct || 0,
          l.is_alternative ? 1 : 0,
          l.alternative_for_item_id || null,
          l.sub_bom_id || null,
          l.carton_packing_qty || 0
        );
      }
      recordAuditLog(db, req.user, 'BOM', bomId, bomNumber, 'Create & Approve BOM', { version: b.version || 'v1.0' });
      return { id: bomId, bom_number: bomNumber };
    });
    res.status(201).json(result);
  } catch (err: unknown) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Failed to create BOM' });
  }
});

router.get('/boms/:id/scale', requirePermission('manufacturing', 'can_view'), (req, res) => {
  const db = getDb();
  const bomId = Number(req.params.id);
  const targetQty = Number(req.query.qty || 0);
  const bom = db.prepare('SELECT * FROM boms WHERE id = ?').get(bomId) as { id: number; batch_size: number; labour_cost: number; overhead_cost: number } | undefined;
  if (!bom) {
    res.status(404).json({ error: 'BOM not found' });
    return;
  }
  const scale = targetQty > 0 && bom.batch_size > 0 ? targetQty / bom.batch_size : 1;
  const items = db
    .prepare(
      `SELECT bi.*, i.item_code, i.name as item_name, i.average_cost
       FROM bom_items bi
       JOIN items i ON i.id = bi.item_id
       WHERE bi.bom_id = ?`
    )
    .all(bomId) as { item_id: number; item_code: string; item_name: string; component_type: string; qty: number; uom: string; average_cost: number; carton_packing_qty: number }[];

  const scaled = items.map((l) => {
    let requiredQty = roundQty(l.qty * scale);
    if (l.carton_packing_qty && l.carton_packing_qty > 0 && targetQty > 0) {
      requiredQty = Math.ceil(targetQty / l.carton_packing_qty);
    }
    return {
      ...l,
      required_qty: requiredQty,
      estimated_cost: roundMoney(requiredQty * l.average_cost),
    };
  });

  res.json({
    bom_id: bomId,
    target_qty: targetQty || bom.batch_size,
    scale_factor: scale,
    scaled_labour: roundMoney(bom.labour_cost * scale),
    scaled_overhead: roundMoney(bom.overhead_cost * scale),
    components: scaled,
  });
});

// ---------------- PRODUCTION ORDERS, BLENDING & FILLING ----------------
router.get('/production-orders', requirePermission('manufacturing', 'can_view'), (_req, res) => {
  const db = getDb();
  const orders = db
    .prepare(
      `SELECT po.*, b.bom_number, b.version as bom_version, i.item_code, i.name as finished_item_name,
              sw.name as source_warehouse_name, tw.name as target_warehouse_name, cr.full_name as creator_name
       FROM production_orders po
       JOIN boms b ON b.id = po.bom_id
       JOIN items i ON i.id = po.finished_item_id
       JOIN warehouses sw ON sw.id = po.warehouse_id
       JOIN warehouses tw ON tw.id = po.target_warehouse_id
       LEFT JOIN users cr ON cr.id = po.created_by
       ORDER BY po.id DESC`
    )
    .all() as Record<string, unknown>[];

  const consumptions = db
    .prepare(
      `SELECT bc.*, i.item_code, i.name as item_name, st.tank_code, st.name as tank_name
       FROM blending_consumptions bc
       JOIN items i ON i.id = bc.item_id
       LEFT JOIN storage_tanks st ON st.id = bc.tank_id`
    )
    .all() as { production_order_id: number }[];
  const blends = db.prepare('SELECT * FROM blending_batches ORDER BY id DESC').all() as { production_order_id: number }[];
  const fillings = db.prepare('SELECT * FROM filling_orders ORDER BY id DESC').all() as { production_order_id: number }[];

  res.json({
    items: orders.map((o) => ({
      ...o,
      consumptions: consumptions.filter((c) => c.production_order_id === Number(o.id)),
      blends: blends.filter((bl) => bl.production_order_id === Number(o.id)),
      fillings: fillings.filter((f) => f.production_order_id === Number(o.id)),
    })),
  });
});

router.post('/production-orders', requirePermission('manufacturing', 'can_create'), (req: AuthRequest, res) => {
  const b = req.body as {
    bom_id: number;
    planned_qty: number;
    sales_order_id?: number;
    production_line?: string;
    warehouse_id: number;
    target_warehouse_id: number;
    scheduled_date?: string;
    operator_name?: string;
    equipment_name?: string;
    carton_packing_qty?: number;
    remarks?: string;
  };
  if (!b.bom_id || !b.planned_qty || !b.warehouse_id || !b.target_warehouse_id) {
    res.status(400).json({ error: 'BOM, planned quantity, and source/target warehouses are required' });
    return;
  }

  try {
    const result = withTransaction((db) => {
      const bom = db.prepare('SELECT * FROM boms WHERE id = ?').get(b.bom_id) as
        | { id: number; finished_item_id: number; batch_size: number; uom: string; labour_cost: number; overhead_cost: number }
        | undefined;
      if (!bom) throw new Error('BOM not found');

      const prodNumber = getNextDocumentNumber(db, 'PROD');
      const blendNumber = getNextDocumentNumber(db, 'BLEND');
      const fillNumber = getNextDocumentNumber(db, 'FILL');
      const scale = b.planned_qty / bom.batch_size;
      const schedDate = b.scheduled_date || todayISO();

      const poRes = db
        .prepare(
          `INSERT INTO production_orders (prod_number, bom_id, finished_item_id, sales_order_id, planned_qty, uom, production_line, warehouse_id, target_warehouse_id, scheduled_date, actual_labour_cost, actual_overhead_cost, status, remarks, created_by, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'In Progress', ?, ?, ?)`
        )
        .run(
          prodNumber,
          bom.id,
          bom.finished_item_id,
          b.sales_order_id || null,
          roundQty(b.planned_qty),
          bom.uom,
          b.production_line || 'Blending Line 1',
          b.warehouse_id,
          b.target_warehouse_id,
          schedDate,
          roundMoney(bom.labour_cost * scale),
          roundMoney(bom.overhead_cost * scale),
          b.remarks || '',
          req.user!.id,
          nowISO()
        );
      const prodId = Number(poRes.lastInsertRowid);

      const blendRes = db
        .prepare(
          `INSERT INTO blending_batches (blend_number, production_order_id, bom_id, finished_item_id, planned_qty, blend_date, operator_name, equipment_name, quality_status, status, created_by, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'Pending', 'In Progress', ?, ?)`
        )
        .run(blendNumber, prodId, bom.id, bom.finished_item_id, roundQty(b.planned_qty), schedDate, b.operator_name || req.user!.full_name, b.equipment_name || 'Blending Kettle K-01', req.user!.id, nowISO());
      const blendId = Number(blendRes.lastInsertRowid);

      const cartonPack = b.carton_packing_qty || 12;
      const calcCartons = Math.ceil(b.planned_qty / cartonPack);
      db.prepare(
        `INSERT INTO filling_orders (fill_number, production_order_id, blend_id, container_size, target_units, filling_line, carton_packing_qty, calculated_cartons, status, filled_date, created_by, created_at)
         VALUES (?, ?, ?, '1L / Standard', ?, 'Filling Line A', ?, ?, 'Scheduled', ?, ?, ?)`
      ).run(fillNumber, prodId, blendId, roundQty(b.planned_qty), cartonPack, calcCartons, schedDate, req.user!.id, nowISO());

      const bomItems = db.prepare('SELECT bi.*, i.average_cost FROM bom_items bi JOIN items i ON i.id = bi.item_id WHERE bi.bom_id = ?').all(bom.id) as {
        item_id: number;
        component_type: string;
        qty: number;
        uom: string;
        average_cost: number;
        carton_packing_qty: number;
      }[];

      const insCons = db.prepare(
        `INSERT INTO blending_consumptions (blend_id, production_order_id, item_id, component_type, planned_qty, actual_qty, wastage_qty, uom, unit_cost, total_cost)
         VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`
      );
      for (const bi of bomItems) {
        let reqQty = roundQty(bi.qty * scale);
        if (bi.carton_packing_qty && bi.carton_packing_qty > 0) {
          reqQty = Math.ceil(b.planned_qty / bi.carton_packing_qty);
        }
        insCons.run(blendId, prodId, bi.item_id, bi.component_type, reqQty, reqQty, bi.uom, bi.average_cost, roundMoney(reqQty * bi.average_cost));
      }

      recordAuditLog(db, req.user, 'ProductionOrder', prodId, prodNumber, 'Create Production, Blend & Filling Orders', {
        blendNumber,
        fillNumber,
        planned_qty: b.planned_qty,
      });

      return { id: prodId, prod_number: prodNumber, blend_number: blendNumber, fill_number: fillNumber };
    });
    res.status(201).json(result);
  } catch (err: unknown) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Failed to create production order' });
  }
});

router.post('/production-orders/:id/complete', requirePermission('manufacturing', 'can_submit'), (req: AuthRequest, res) => {
  const prodId = Number(req.params.id);
  const {
    completed_qty,
    rejected_qty,
    batch_number,
    consumptions,
    pkg_warehouse_id,
    qc_release_immediately,
  } = req.body as {
    completed_qty?: number;
    rejected_qty?: number;
    batch_number?: string;
    pkg_warehouse_id?: number;
    qc_release_immediately?: boolean;
    consumptions?: { id: number; actual_qty: number; wastage_qty?: number; batch_number?: string; tank_id?: number | null }[];
  };

  try {
    const result = withTransaction((db) => {
      const po = db.prepare('SELECT * FROM production_orders WHERE id = ?').get(prodId) as
        | {
            id: number;
            prod_number: string;
            bom_id: number;
            finished_item_id: number;
            planned_qty: number;
            warehouse_id: number;
            target_warehouse_id: number;
            actual_labour_cost: number;
            actual_overhead_cost: number;
            status: string;
          }
        | undefined;
      if (!po) throw new Error('Production Order not found');
      if (po.status === 'Completed') throw new Error('Production Order already completed');

      const goodQty = roundQty(completed_qty ?? po.planned_qty);
      const rejQty = roundQty(rejected_qty ?? 0);
      if (goodQty <= 0) throw new Error('Completed quantity must be greater than zero');

      const pkgWh =
        pkg_warehouse_id ||
        (db.prepare("SELECT id FROM warehouses WHERE code = 'WH-PKG'").get() as { id: number } | undefined)?.id ||
        po.warehouse_id;

      const consRows = db.prepare('SELECT * FROM blending_consumptions WHERE production_order_id = ?').all(prodId) as {
        id: number;
        item_id: number;
        component_type: string;
        planned_qty: number;
        actual_qty: number;
        tank_id: number | null;
        uom: string;
      }[];

      let totalMaterialCost = 0;
      for (const c of consRows) {
        const override = consumptions?.find((x) => x.id === c.id);
        const actualQty = roundQty(override?.actual_qty ?? c.actual_qty);
        const wasteQty = roundQty(override?.wastage_qty ?? 0);
        const totalOut = roundQty(actualQty + wasteQty);

        // Determine source warehouse: Packaging from WH-PKG if stock exists there, else production source warehouse
        const sourceWh = c.component_type === 'Packaging' ? pkgWh : po.warehouse_id;
        const selectedTankId = override?.tank_id !== undefined ? override.tank_id : c.tank_id;

        const outMov = postStockMovement(db, {
          postingDate: todayISO(),
          docType: 'ProductionConsumption',
          docId: po.id,
          docNumber: po.prod_number,
          itemId: c.item_id,
          warehouseId: sourceWh,
          tankId: selectedTankId,
          batchNumber: override?.batch_number,
          outwardQty: totalOut,
          remarks: `Consumed for ${po.prod_number}`,
          userId: req.user!.id,
        });

        const lineCost = roundMoney(totalOut * outMov.unitCost);
        totalMaterialCost = roundMoney(totalMaterialCost + lineCost);
        db.prepare(
          'UPDATE blending_consumptions SET actual_qty = ?, wastage_qty = ?, batch_id = ?, batch_number = COALESCE(?, batch_number), tank_id = COALESCE(?, tank_id), unit_cost = ?, total_cost = ? WHERE id = ?'
        ).run(actualQty, wasteQty, outMov.batchId, override?.batch_number || null, selectedTankId || null, outMov.unitCost, lineCost, c.id);
      }

      const totalActualCost = roundMoney(totalMaterialCost + po.actual_labour_cost + po.actual_overhead_cost);
      const unitActualCost = roundMoney(totalActualCost / goodQty);
      const fgBatchNo = batch_number?.trim() || `FG-${po.prod_number}-${Date.now().toString().slice(-4)}`;

      // Receive Finished Lubricant into Finished Goods Warehouse
      const fgMov = postStockMovement(db, {
        postingDate: todayISO(),
        docType: 'ProductionOutput',
        docId: po.id,
        docNumber: po.prod_number,
        itemId: po.finished_item_id,
        warehouseId: po.target_warehouse_id,
        batchNumber: fgBatchNo,
        inwardQty: goodQty,
        unitCost: unitActualCost,
        mfgDate: todayISO(),
        qcStatus: qc_release_immediately ? 'Released' : 'Pending',
        isOnHold: !qc_release_immediately,
        remarks: `Finished goods produced from ${po.prod_number}`,
        userId: req.user!.id,
      });

      // Trigger Finished Goods QC Inspection if not released immediately
      if (!qc_release_immediately) {
        const qcNumber = getNextDocumentNumber(db, 'QC');
        db.prepare(
          `INSERT INTO quality_inspections (qc_number, inspection_type, doc_type, doc_id, doc_number, item_id, batch_id, batch_number, inspection_date, inspector_name, overall_status, batch_action, remarks, created_by, created_at)
           VALUES (?, 'Finished Lubricant', 'ProductionOrder', ?, ?, ?, ?, ?, ?, ?, 'Pending', 'Hold', 'Finished batch lab verification before dispatch', ?, ?)`
        ).run(qcNumber, po.id, po.prod_number, po.finished_item_id, fgMov.batchId, fgBatchNo, todayISO(), req.user!.full_name, req.user!.id, nowISO());
      }

      // Post Double-Entry Manufacturing Accounting (DR 1320 Finished Goods / CR 1300 Raw Materials & Pkg + CR 5300 Absorbed Labour/Overhead)
      const creditLines = [{ accountCode: '1300', credit: totalMaterialCost, description: `Raw & packaging materials consumed (${po.prod_number})` }];
      const absorbed = roundMoney(po.actual_labour_cost + po.actual_overhead_cost);
      if (absorbed > 0) {
        creditLines.push({ accountCode: '5300', credit: absorbed, description: `Labour & overhead absorbed (${po.prod_number})` });
      }
      postJournalEntry(db, {
        postingDate: todayISO(),
        entryType: 'Production Completion',
        refDocType: 'ProductionOrder',
        refDocId: po.id,
        refDocNumber: po.prod_number,
        narration: `Production completion ${po.prod_number} — Batch ${fgBatchNo}`,
        lines: [
          { accountCode: '1320', debit: totalActualCost, description: `Finished lubricant batch ${fgBatchNo}` },
          ...creditLines,
        ],
        userId: req.user!.id,
      });

      db.prepare(
        `UPDATE production_orders SET completed_qty = ?, rejected_qty = ?, actual_material_cost = ?, total_actual_cost = ?, unit_actual_cost = ?, status = 'Completed', completed_at = ?
         WHERE id = ?`
      ).run(goodQty, rejQty, totalMaterialCost, totalActualCost, unitActualCost, nowISO(), prodId);

      db.prepare("UPDATE blending_batches SET actual_qty = ?, wastage_qty = ?, batch_id = ?, quality_status = ?, status = 'Completed' WHERE production_order_id = ?").run(
        goodQty,
        rejQty,
        fgMov.batchId,
        qc_release_immediately ? 'Passed' : 'Pending QC',
        prodId
      );

      db.prepare("UPDATE filling_orders SET filled_units = ?, rejected_units = ?, status = 'Completed' WHERE production_order_id = ?").run(goodQty, rejQty, prodId);

      recordAuditLog(db, req.user, 'ProductionOrder', prodId, po.prod_number, 'Complete Production', {
        batch_number: fgBatchNo,
        goodQty,
        totalActualCost,
        unitActualCost,
      });

      return { ok: true, batch_number: fgBatchNo, total_actual_cost: totalActualCost, unit_actual_cost: unitActualCost };
    });
    res.json(result);
  } catch (err: unknown) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Failed to complete production order' });
  }
});

// ---------------- TWO-WAY BATCH TRACEABILITY & GENEALOGY ----------------
router.get('/traceability/:batchNumber', requirePermission('manufacturing', 'can_view'), (req, res) => {
  const db = getDb();
  const batchNo = req.params.batchNumber.trim();
  const batch = db
    .prepare(
      `SELECT sb.*, i.item_code, i.name as item_name, w.name as warehouse_name, s.name as supplier_name
       FROM stock_batches sb
       JOIN items i ON i.id = sb.item_id
       JOIN warehouses w ON w.id = sb.warehouse_id
       LEFT JOIN suppliers s ON s.id = sb.supplier_id
       WHERE sb.batch_number = ?`
    )
    .get(batchNo) as Record<string, unknown> | undefined;

  if (!batch) {
    res.status(404).json({ error: `Batch ${batchNo} not found` });
    return;
  }

  // Backward traceability: If produced via ProductionOrder, trace consumed raw material batches -> GRNs -> POs -> Suppliers -> Purchase Invoices
  let backward: Record<string, unknown> | null = null;
  if (batch.source_type === 'ProductionOutput' && batch.source_doc_id) {
    const prodOrder = db
      .prepare(
        `SELECT po.*, b.bom_number, b.version as bom_version, bb.blend_number, bb.blend_date, bb.operator_name
         FROM production_orders po
         JOIN boms b ON b.id = po.bom_id
         LEFT JOIN blending_batches bb ON bb.production_order_id = po.id
         WHERE po.id = ?`
      )
      .get(batch.source_doc_id);

    const consumed = db
      .prepare(
        `SELECT bc.*, i.item_code, i.name as item_name, sb.source_type, sb.source_doc_number, sb.supplier_id,
                s.name as supplier_name, grn.po_id, po.po_number, pi.pi_number, pi.supplier_invoice_number
         FROM blending_consumptions bc
         JOIN items i ON i.id = bc.item_id
         LEFT JOIN stock_batches sb ON sb.id = bc.batch_id
         LEFT JOIN suppliers s ON s.id = sb.supplier_id
         LEFT JOIN purchase_receipts grn ON sb.source_type = 'PurchaseReceipt' AND grn.id = sb.source_doc_id
         LEFT JOIN purchase_orders po ON po.id = grn.po_id
         LEFT JOIN purchase_invoices pi ON pi.grn_id = grn.id
         WHERE bc.production_order_id = ?`
      )
      .all(batch.source_doc_id);

    backward = { production_order: prodOrder, consumed_materials: consumed };
  } else if (batch.source_type === 'PurchaseReceipt' && batch.source_doc_id) {
    const grn = db
      .prepare(
        `SELECT grn.*, s.name as supplier_name, po.po_number, pi.pi_number, pi.supplier_invoice_number
         FROM purchase_receipts grn
         JOIN suppliers s ON s.id = grn.supplier_id
         LEFT JOIN purchase_orders po ON po.id = grn.po_id
         LEFT JOIN purchase_invoices pi ON pi.grn_id = grn.id
         WHERE grn.id = ?`
      )
      .get(batch.source_doc_id);
    backward = { purchase_receipt: grn };
  }

  // Forward traceability: Where did this batch go? (Into Blending Production OR Delivery Notes -> Customers -> Sales Invoices)
  const usedInProduction = db
    .prepare(
      `SELECT bc.production_order_id, po.prod_number, po.finished_item_id, fg.item_code as fg_code, fg.name as fg_name,
              sb_out.batch_number as fg_batch_number
       FROM blending_consumptions bc
       JOIN production_orders po ON po.id = bc.production_order_id
       JOIN items fg ON fg.id = po.finished_item_id
       LEFT JOIN stock_batches sb_out ON sb_out.source_type = 'ProductionOutput' AND sb_out.source_doc_id = po.id
       WHERE bc.batch_id = ?`
    )
    .all(batch.id);

  const dispatches = db
    .prepare(
      `SELECT dni.qty, dn.dn_number, dn.delivery_date, dn.vehicle_number, dn.driver_name,
              c.code as customer_code, c.name as customer_name, so.so_number, si.si_number
       FROM delivery_note_items dni
       JOIN delivery_notes dn ON dn.id = dni.dn_id
       JOIN customers c ON c.id = dn.customer_id
       LEFT JOIN sales_orders so ON so.id = dn.so_id
       LEFT JOIN sales_invoices si ON si.dn_id = dn.id
       WHERE dni.batch_id = ?`
    )
    .all(batch.id);

  const qcInspections = db
    .prepare('SELECT * FROM quality_inspections WHERE batch_id = ? OR batch_number = ? ORDER BY id DESC')
    .all(batch.id, batchNo);

  res.json({
    batch,
    backward,
    forward: {
      used_in_production: usedInProduction,
      dispatched_to_customers: dispatches,
    },
    qc_inspections: qcInspections,
  });
});

export default router;
