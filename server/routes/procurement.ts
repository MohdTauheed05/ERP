import { Router } from 'express';
import { getDb, withTransaction } from '../db.ts';
import { authenticate, createNotification, recordAuditLog, requirePermission, type AuthRequest } from '../middleware/auth.ts';
import { addDaysISO, nowISO, roundMoney, roundQty, todayISO } from '../utils/helpers.ts';
import { getNextDocumentNumber } from '../services/numbering.ts';
import { postStockMovement } from '../services/inventory.ts';
import { postJournalEntry } from '../services/accounting.ts';
import { requestDocumentApproval } from '../services/approvals.ts';
import { generatePaymentSchedules } from '../services/paymentTerms.ts';

const router = Router();
router.use(authenticate);

// ---------------- MATERIAL REQUESTS ----------------
router.get('/material-requests', requirePermission('procurement', 'can_view'), (_req, res) => {
  const db = getDb();
  const list = db
    .prepare(
      `SELECT mr.*, w.name as warehouse_name, cr.full_name as creator_name
       FROM material_requests mr
       LEFT JOIN warehouses w ON w.id = mr.warehouse_id
       LEFT JOIN users cr ON cr.id = mr.created_by
       ORDER BY mr.id DESC`
    )
    .all() as Record<string, unknown>[];
  const items = db
    .prepare('SELECT mri.*, i.item_code, i.name as item_name FROM material_request_items mri JOIN items i ON i.id = mri.item_id')
    .all() as { mr_id: number }[];
  res.json({ items: list.map((m) => ({ ...m, items: items.filter((it) => it.mr_id === Number(m.id)) })) });
});

router.post('/material-requests', requirePermission('procurement', 'can_create'), (req: AuthRequest, res) => {
  const b = req.body as {
    request_type?: string;
    request_date?: string;
    required_date?: string;
    department?: string;
    warehouse_id?: number;
    remarks?: string;
    items: { item_id: number; description?: string; qty: number; uom?: string }[];
  };
  if (!Array.isArray(b.items) || b.items.length === 0) {
    res.status(400).json({ error: 'At least one item is required' });
    return;
  }
  try {
    const result = withTransaction((db) => {
      const mrNumber = getNextDocumentNumber(db, 'MR');
      const r = db
        .prepare(
          `INSERT INTO material_requests (mr_number, request_type, request_date, required_date, requested_by, department, warehouse_id, status, remarks, created_by, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'Submitted', ?, ?, ?)`
        )
        .run(
          mrNumber,
          b.request_type || 'Raw Materials',
          b.request_date || todayISO(),
          b.required_date || addDaysISO(todayISO(), 7),
          req.user!.full_name,
          b.department || req.user!.department,
          b.warehouse_id || null,
          b.remarks || '',
          req.user!.id,
          nowISO()
        );
      const mrId = Number(r.lastInsertRowid);
      const insItem = db.prepare(
        'INSERT INTO material_request_items (mr_id, item_id, description, qty, uom, warehouse_id) VALUES (?, ?, ?, ?, ?, ?)'
      );
      for (const line of b.items) {
        const item = db.prepare('SELECT name, purchase_uom FROM items WHERE id = ?').get(line.item_id) as { name: string; purchase_uom: string };
        insItem.run(mrId, line.item_id, line.description || item.name, roundQty(line.qty), line.uom || item.purchase_uom, b.warehouse_id || null);
      }
      recordAuditLog(db, req.user, 'MaterialRequest', mrId, mrNumber, 'Create & Submit MR', { items: b.items.length });
      return { id: mrId, mr_number: mrNumber };
    });
    res.status(201).json(result);
  } catch (err: unknown) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Failed to create material request' });
  }
});

// ---------------- PURCHASE REQUISITIONS ----------------
router.get('/purchase-requisitions', requirePermission('procurement', 'can_view'), (_req, res) => {
  const db = getDb();
  const list = db
    .prepare(
      `SELECT pr.*, mr.mr_number, w.name as warehouse_name, cr.full_name as creator_name
       FROM purchase_requisitions pr
       LEFT JOIN material_requests mr ON mr.id = pr.mr_id
       LEFT JOIN warehouses w ON w.id = pr.warehouse_id
       LEFT JOIN users cr ON cr.id = pr.created_by
       ORDER BY pr.id DESC`
    )
    .all() as Record<string, unknown>[];
  const items = db
    .prepare('SELECT pri.*, i.item_code, i.name as item_name FROM purchase_requisition_items pri JOIN items i ON i.id = pri.item_id')
    .all() as { pr_id: number }[];
  res.json({ items: list.map((p) => ({ ...p, items: items.filter((it) => it.pr_id === Number(p.id)) })) });
});

router.post('/purchase-requisitions', requirePermission('procurement', 'can_create'), (req: AuthRequest, res) => {
  const b = req.body as {
    mr_id?: number;
    request_date?: string;
    required_date?: string;
    department?: string;
    warehouse_id?: number;
    remarks?: string;
    items: { item_id: number; description?: string; qty: number; uom?: string; estimated_rate?: number }[];
  };
  if (!Array.isArray(b.items) || b.items.length === 0) {
    res.status(400).json({ error: 'At least one requisition line is required' });
    return;
  }
  try {
    const result = withTransaction((db) => {
      const prNumber = getNextDocumentNumber(db, 'PR');
      const r = db
        .prepare(
          `INSERT INTO purchase_requisitions (pr_number, mr_id, request_date, required_date, requested_by, department, warehouse_id, status, approval_status, remarks, created_by, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'Submitted', 'Approved', ?, ?, ?)`
        )
        .run(
          prNumber,
          b.mr_id || null,
          b.request_date || todayISO(),
          b.required_date || addDaysISO(todayISO(), 7),
          req.user!.full_name,
          b.department || req.user!.department,
          b.warehouse_id || null,
          b.remarks || '',
          req.user!.id,
          nowISO()
        );
      const prId = Number(r.lastInsertRowid);
      const ins = db.prepare(
        'INSERT INTO purchase_requisition_items (pr_id, item_id, description, qty, uom, warehouse_id, estimated_rate) VALUES (?, ?, ?, ?, ?, ?, ?)'
      );
      for (const line of b.items) {
        const item = db.prepare('SELECT name, purchase_uom, last_purchase_price, standard_cost FROM items WHERE id = ?').get(line.item_id) as {
          name: string;
          purchase_uom: string;
          last_purchase_price: number;
          standard_cost: number;
        };
        ins.run(
          prId,
          line.item_id,
          line.description || item.name,
          roundQty(line.qty),
          line.uom || item.purchase_uom,
          b.warehouse_id || null,
          roundMoney(line.estimated_rate ?? (item.last_purchase_price || item.standard_cost))
        );
      }
      if (b.mr_id) {
        db.prepare("UPDATE material_requests SET status = 'Converted to PR' WHERE id = ?").run(b.mr_id);
      }
      recordAuditLog(db, req.user, 'PurchaseRequisition', prId, prNumber, 'Create PR', { mr_id: b.mr_id });
      return { id: prId, pr_number: prNumber };
    });
    res.status(201).json(result);
  } catch (err: unknown) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Failed to create PR' });
  }
});

// ---------------- RFQs & SUPPLIER QUOTATIONS ----------------
router.get('/rfqs', requirePermission('procurement', 'can_view'), (_req, res) => {
  const db = getDb();
  const rfqs = db
    .prepare(
      `SELECT r.*, pr.pr_number, cr.full_name as creator_name
       FROM rfqs r
       LEFT JOIN purchase_requisitions pr ON pr.id = r.pr_id
       LEFT JOIN users cr ON cr.id = r.created_by
       ORDER BY r.id DESC`
    )
    .all() as Record<string, unknown>[];
  const items = db.prepare('SELECT ri.*, i.item_code, i.name as item_name FROM rfq_items ri JOIN items i ON i.id = ri.item_id').all() as { rfq_id: number }[];
  const sups = db.prepare('SELECT rs.*, s.code, s.name as supplier_name FROM rfq_suppliers rs JOIN suppliers s ON s.id = rs.supplier_id').all() as { rfq_id: number }[];
  res.json({
    items: rfqs.map((r) => ({
      ...r,
      items: items.filter((i) => i.rfq_id === Number(r.id)),
      suppliers: sups.filter((s) => s.rfq_id === Number(r.id)),
    })),
  });
});

router.post('/rfqs', requirePermission('procurement', 'can_create'), (req: AuthRequest, res) => {
  const b = req.body as {
    pr_id?: number;
    rfq_date?: string;
    valid_until?: string;
    supplier_ids: number[];
    remarks?: string;
    items: { item_id: number; description?: string; qty: number; uom?: string }[];
  };
  if (!Array.isArray(b.supplier_ids) || b.supplier_ids.length === 0 || !Array.isArray(b.items) || b.items.length === 0) {
    res.status(400).json({ error: 'Suppliers and items are required for RFQ' });
    return;
  }
  try {
    const result = withTransaction((db) => {
      const rfqNumber = getNextDocumentNumber(db, 'RFQ');
      const r = db
        .prepare('INSERT INTO rfqs (rfq_number, pr_id, rfq_date, valid_until, status, remarks, created_by, created_at) VALUES (?, ?, ?, ?, \'Sent\', ?, ?, ?)')
        .run(rfqNumber, b.pr_id || null, b.rfq_date || todayISO(), b.valid_until || addDaysISO(todayISO(), 14), b.remarks || '', req.user!.id, nowISO());
      const rfqId = Number(r.lastInsertRowid);
      const insSup = db.prepare('INSERT INTO rfq_suppliers (rfq_id, supplier_id, sent_at, status) VALUES (?, ?, ?, \'Sent\')');
      for (const sid of b.supplier_ids) insSup.run(rfqId, sid, nowISO());
      const insItem = db.prepare('INSERT INTO rfq_items (rfq_id, item_id, description, qty, uom) VALUES (?, ?, ?, ?, ?)');
      for (const line of b.items) {
        const item = db.prepare('SELECT name, purchase_uom FROM items WHERE id = ?').get(line.item_id) as { name: string; purchase_uom: string };
        insItem.run(rfqId, line.item_id, line.description || item.name, roundQty(line.qty), line.uom || item.purchase_uom);
      }
      recordAuditLog(db, req.user, 'RFQ', rfqId, rfqNumber, 'Create & Send RFQ', { suppliers: b.supplier_ids.length });
      return { id: rfqId, rfq_number: rfqNumber };
    });
    res.status(201).json(result);
  } catch (err: unknown) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Failed to create RFQ' });
  }
});

router.get('/supplier-quotations', requirePermission('procurement', 'can_view'), (_req, res) => {
  const db = getDb();
  const list = db
    .prepare(
      `SELECT sq.*, s.name as supplier_name, s.code as supplier_code, s.address as supplier_address,
              s.country as supplier_country, s.trn as supplier_trn, s.contact_person as supplier_contact_person,
              s.telephone as supplier_telephone, rfq.rfq_number, pt.name as payment_term_name,
              cr.full_name as creator_name
       FROM supplier_quotations sq
       JOIN suppliers s ON s.id = sq.supplier_id
       LEFT JOIN rfqs rfq ON rfq.id = sq.rfq_id
       LEFT JOIN payment_terms pt ON pt.id = sq.payment_term_id
       LEFT JOIN users cr ON cr.id = sq.created_by
       ORDER BY sq.id DESC`
    )
    .all() as Record<string, unknown>[];
  const items = db
    .prepare('SELECT sqi.*, i.item_code, i.name as item_name FROM supplier_quotation_items sqi JOIN items i ON i.id = sqi.item_id')
    .all() as { sq_id: number }[];
  res.json({ items: list.map((q) => ({ ...q, items: items.filter((it) => it.sq_id === Number(q.id)) })) });
});

router.post('/supplier-quotations', requirePermission('procurement', 'can_create'), (req: AuthRequest, res) => {
  const b = req.body as {
    rfq_id?: number;
    supplier_id: number;
    quotation_date?: string;
    valid_until?: string;
    currency?: string;
    exchange_rate?: number;
    payment_term_id?: number;
    delivery_days?: number;
    freight_amount?: number;
    remarks?: string;
    items: { item_id: number; description?: string; qty: number; uom?: string; unit_price: number; moq?: number; vat_rate?: number }[];
  };
  if (!b.supplier_id || !Array.isArray(b.items) || b.items.length === 0) {
    res.status(400).json({ error: 'Supplier and quoted items are required' });
    return;
  }
  try {
    const result = withTransaction((db) => {
      const sqNumber = getNextDocumentNumber(db, 'SQ');
      const freight = roundMoney(b.freight_amount || 0);
      let itemsTotal = 0;
      const computed = b.items.map((l) => {
        const item = db.prepare('SELECT name, purchase_uom, vat_rate FROM items WHERE id = ?').get(l.item_id) as { name: string; purchase_uom: string; vat_rate: number };
        const net = roundMoney(l.qty * l.unit_price);
        const vatRate = l.vat_rate ?? item.vat_rate ?? 5;
        const vatAmt = roundMoney((net * vatRate) / 100);
        const lineTotal = roundMoney(net + vatAmt);
        itemsTotal = roundMoney(itemsTotal + lineTotal);
        return { ...l, description: l.description || item.name, uom: l.uom || item.purchase_uom, vatRate, vatAmt, lineTotal };
      });
      const grandTotal = roundMoney(itemsTotal + freight);

      const r = db
        .prepare(
          `INSERT INTO supplier_quotations (sq_number, rfq_id, supplier_id, quotation_date, valid_until, currency, exchange_rate, payment_term_id, delivery_days, freight_amount, total_amount, status, remarks, created_by, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Submitted', ?, ?, ?)`
        )
        .run(
          sqNumber,
          b.rfq_id || null,
          b.supplier_id,
          b.quotation_date || todayISO(),
          b.valid_until || addDaysISO(todayISO(), 30),
          b.currency || 'AED',
          b.exchange_rate || 1,
          b.payment_term_id || null,
          b.delivery_days || 7,
          freight,
          grandTotal,
          b.remarks || '',
          req.user!.id,
          nowISO()
        );
      const sqId = Number(r.lastInsertRowid);
      const insItem = db.prepare(
        `INSERT INTO supplier_quotation_items (sq_id, item_id, description, qty, uom, unit_price, moq, vat_rate, vat_amount, line_total)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      for (const c of computed) {
        insItem.run(sqId, c.item_id, c.description, roundQty(c.qty), c.uom, roundMoney(c.unit_price), roundQty(c.moq || 1), c.vatRate, c.vatAmt, c.lineTotal);
      }
      if (b.rfq_id) {
        db.prepare("UPDATE rfq_suppliers SET status = 'Quoted' WHERE rfq_id = ? AND supplier_id = ?").run(b.rfq_id, b.supplier_id);
      }
      recordAuditLog(db, req.user, 'SupplierQuotation', sqId, sqNumber, 'Record Supplier Quotation', { total: grandTotal });
      return { id: sqId, sq_number: sqNumber, total_amount: grandTotal };
    });
    res.status(201).json(result);
  } catch (err: unknown) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Failed to record supplier quotation' });
  }
});

router.get('/rfqs/:id/comparison', requirePermission('procurement', 'can_view'), (req, res) => {
  const db = getDb();
  const rfqId = Number(req.params.id);
  const quotes = db
    .prepare(
      `SELECT sq.*, s.name as supplier_name, pt.name as payment_term_name
       FROM supplier_quotations sq
       JOIN suppliers s ON s.id = sq.supplier_id
       LEFT JOIN payment_terms pt ON pt.id = sq.payment_term_id
       WHERE sq.rfq_id = ?
       ORDER BY (sq.total_amount * sq.exchange_rate) ASC`
    )
    .all(rfqId) as Record<string, unknown>[];

  const items = db
    .prepare(
      `SELECT sqi.*, i.item_code, i.name as item_name
       FROM supplier_quotation_items sqi
       JOIN items i ON i.id = sqi.item_id
       WHERE sqi.sq_id IN (SELECT id FROM supplier_quotations WHERE rfq_id = ?)`
    )
    .all(rfqId) as { sq_id: number }[];

  res.json({
    quotations: quotes.map((q) => ({
      ...q,
      landed_total_base: roundMoney(Number(q.total_amount) * Number(q.exchange_rate || 1)),
      items: items.filter((i) => i.sq_id === Number(q.id)),
    })),
  });
});

// ---------------- PURCHASE ORDERS ----------------
router.get('/purchase-orders', requirePermission('procurement', 'can_view'), (_req, res) => {
  const db = getDb();
  const orders = db
    .prepare(
      `SELECT po.*, s.name as supplier_name, s.code as supplier_code,
              s.address as supplier_address, s.country as supplier_country, s.trn as supplier_trn,
              s.contact_person as supplier_contact_person, s.telephone as supplier_telephone,
              w.name as warehouse_name, w.location as warehouse_location,
              pt.name as payment_term_name,
              cr.full_name as creator_name, ap.full_name as approver_name
       FROM purchase_orders po
       JOIN suppliers s ON s.id = po.supplier_id
       JOIN warehouses w ON w.id = po.warehouse_id
       LEFT JOIN payment_terms pt ON pt.id = po.payment_term_id
       LEFT JOIN users cr ON cr.id = po.created_by
       LEFT JOIN users ap ON ap.id = po.submitted_by
       ORDER BY po.id DESC`
    )
    .all() as Record<string, unknown>[];
  const items = db
    .prepare('SELECT poi.*, i.item_code, i.name as item_name FROM purchase_order_items poi JOIN items i ON i.id = poi.item_id')
    .all() as { po_id: number }[];
  res.json({ items: orders.map((o) => ({ ...o, items: items.filter((it) => it.po_id === Number(o.id)) })) });
});

router.post('/purchase-orders', requirePermission('procurement', 'can_create'), (req: AuthRequest, res) => {
  const b = req.body as {
    supplier_id: number;
    po_date?: string;
    delivery_date?: string;
    supplier_ref?: string;
    delivery_terms?: string;
    delivery_place?: string;
    revision_no?: string;
    revision_date?: string;
    sq_id?: number;
    pr_id?: number;
    currency?: string;
    exchange_rate?: number;
    payment_term_id?: number;
    warehouse_id: number;
    freight_amount?: number;
    remarks?: string;
    items: { item_id: number; description?: string; qty: number; uom?: string; rate: number; discount_pct?: number; vat_rate?: number }[];
  };
  if (!b.supplier_id || !b.warehouse_id || !Array.isArray(b.items) || b.items.length === 0) {
    res.status(400).json({ error: 'Supplier, warehouse, and at least one line item are required' });
    return;
  }

  try {
    const result = withTransaction((db) => {
      const poNumber = getNextDocumentNumber(db, 'PO');
      let subtotal = 0;
      let discountTotal = 0;
      let vatTotal = 0;
      const lines = b.items.map((l) => {
        const item = db.prepare('SELECT name, purchase_uom, vat_rate FROM items WHERE id = ?').get(l.item_id) as { name: string; purchase_uom: string; vat_rate: number };
        const gross = roundMoney(l.qty * l.rate);
        const disc = roundMoney((gross * (l.discount_pct || 0)) / 100);
        const net = roundMoney(gross - disc);
        const vatRate = l.vat_rate ?? item.vat_rate ?? 5;
        const vatAmt = roundMoney((net * vatRate) / 100);
        const total = roundMoney(net + vatAmt);
        subtotal = roundMoney(subtotal + net);
        discountTotal = roundMoney(discountTotal + disc);
        vatTotal = roundMoney(vatTotal + vatAmt);
        return { ...l, description: l.description || item.name, uom: l.uom || item.purchase_uom, vatRate, vatAmt, total };
      });
      const freight = roundMoney(b.freight_amount || 0);
      const grandTotal = roundMoney(subtotal + vatTotal + freight);

      const wh = db.prepare('SELECT name, location FROM warehouses WHERE id = ?').get(b.warehouse_id) as { name: string; location: string } | undefined;
      const delPlace = b.delivery_place || (wh ? wh.location || wh.name : '');

      const r = db
        .prepare(
          `INSERT INTO purchase_orders (po_number, po_date, delivery_date, supplier_id, supplier_ref, delivery_terms, delivery_place, revision_no, revision_date, sq_id, pr_id, currency, exchange_rate, payment_term_id, warehouse_id, subtotal, discount_amount, freight_amount, vat_amount, total_amount, status, approval_status, remarks, created_by, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Draft', 'Not Submitted', ?, ?, ?)`
        )
        .run(
          poNumber,
          b.po_date || todayISO(),
          b.delivery_date || addDaysISO(todayISO(), 7),
          b.supplier_id,
          b.supplier_ref || '',
          b.delivery_terms || '',
          delPlace,
          b.revision_no || 'Original',
          b.revision_date || '',
          b.sq_id || null,
          b.pr_id || null,
          b.currency || 'AED',
          b.exchange_rate || 1,
          b.payment_term_id || null,
          b.warehouse_id,
          subtotal,
          discountTotal,
          freight,
          vatTotal,
          grandTotal,
          b.remarks || '',
          req.user!.id,
          nowISO()
        );
      const poId = Number(r.lastInsertRowid);
      const insItem = db.prepare(
        `INSERT INTO purchase_order_items (po_id, item_id, description, qty, uom, rate, discount_pct, vat_rate, vat_amount, line_total)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      for (const l of lines) {
        insItem.run(poId, l.item_id, l.description, roundQty(l.qty), l.uom, roundMoney(l.rate), l.discount_pct || 0, l.vatRate, l.vatAmt, l.total);
      }
      if (b.sq_id) db.prepare("UPDATE supplier_quotations SET status = 'Selected' WHERE id = ?").run(b.sq_id);
      recordAuditLog(db, req.user, 'PurchaseOrder', poId, poNumber, 'Create PO', { total_amount: grandTotal });
      return { id: poId, po_number: poNumber, total_amount: grandTotal };
    });
    res.status(201).json(result);
  } catch (err: unknown) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Failed to create PO' });
  }
});

router.post('/purchase-orders/:id/submit', requirePermission('procurement', 'can_submit'), (req: AuthRequest, res) => {
  const poId = Number(req.params.id);
  try {
    const result = withTransaction((db) => {
      const po = db.prepare('SELECT * FROM purchase_orders WHERE id = ?').get(poId) as
        | { id: number; po_number: string; total_amount: number; exchange_rate: number; currency: string; warehouse_id: number; status: string }
        | undefined;
      if (!po) throw new Error('Purchase Order not found');
      if (po.status === 'Submitted' || po.status === 'Completed') throw new Error('Purchase Order already submitted');

      const baseAmount = roundMoney(po.total_amount * (po.exchange_rate || 1));
      const approval = requestDocumentApproval(db, {
        docType: 'PurchaseOrder',
        docId: po.id,
        docNumber: po.po_number,
        amount: baseAmount,
        currency: 'AED',
        warehouseId: po.warehouse_id,
        user: req.user!,
      });

      if (approval.status === 'Pending') {
        db.prepare("UPDATE purchase_orders SET status = 'Pending Approval', approval_status = 'Pending' WHERE id = ?").run(poId);
        recordAuditLog(db, req.user, 'PurchaseOrder', poId, po.po_number, 'Sent for Approval', { requiredRole: approval.requiredRoleName });
        return { status: 'Pending Approval', approval_status: 'Pending', requiredRole: approval.requiredRoleName };
      }

      db.prepare("UPDATE purchase_orders SET status = 'Submitted', approval_status = 'Approved', submitted_by = ?, submitted_at = ? WHERE id = ?").run(
        req.user!.id,
        nowISO(),
        poId
      );
      recordAuditLog(db, req.user, 'PurchaseOrder', poId, po.po_number, 'Submit PO', {});
      return { status: 'Submitted', approval_status: 'Approved' };
    });
    res.json(result);
  } catch (err: unknown) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Failed to submit PO' });
  }
});

router.post('/purchase-orders/:id/cancel', requirePermission('procurement', 'can_cancel'), (req: AuthRequest, res) => {
  const poId = Number(req.params.id);
  try {
    withTransaction((db) => {
      const po = db.prepare('SELECT id, po_number, status FROM purchase_orders WHERE id = ?').get(poId) as { id: number; po_number: string; status: string } | undefined;
      if (!po) throw new Error('PO not found');
      const grnCount = (db.prepare("SELECT COUNT(*) as c FROM purchase_receipts WHERE po_id = ? AND status = 'Submitted'").get(poId) as { c: number }).c;
      if (grnCount > 0) throw new Error('Cannot cancel Purchase Order that already has submitted Goods Receipt Notes');
      const piCount = (db.prepare("SELECT COUNT(*) as c FROM purchase_invoices WHERE po_id = ? AND status != 'Cancelled'").get(poId) as { c: number }).c;
      if (piCount > 0) throw new Error('Cannot cancel Purchase Order that already has active Purchase Invoices');
      db.prepare("UPDATE purchase_orders SET status = 'Cancelled' WHERE id = ?").run(poId);
      recordAuditLog(db, req.user, 'PurchaseOrder', poId, po.po_number, 'Cancel PO', {});
    });
    res.json({ ok: true });
  } catch (err: unknown) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Failed to cancel PO' });
  }
});

router.put('/purchase-orders/:id', requirePermission('procurement', 'can_edit'), (req: AuthRequest, res) => {
  const poId = Number(req.params.id);
  const b = req.body as {
    supplier_id: number;
    po_date?: string;
    delivery_date?: string;
    supplier_ref?: string;
    delivery_terms?: string;
    delivery_place?: string;
    revision_no?: string;
    revision_date?: string;
    currency?: string;
    exchange_rate?: number;
    payment_term_id?: number;
    warehouse_id: number;
    freight_amount?: number;
    remarks?: string;
    items: { item_id: number; description?: string; qty: number; uom?: string; rate: number; discount_pct?: number; vat_rate?: number }[];
  };
  if (!b.supplier_id || !b.warehouse_id || !Array.isArray(b.items) || b.items.length === 0) {
    res.status(400).json({ error: 'Supplier, warehouse, and at least one line item are required' });
    return;
  }

  try {
    const result = withTransaction((db) => {
      const po = db.prepare('SELECT id, po_number, status, po_date, delivery_date, revision_no, revision_date FROM purchase_orders WHERE id = ?').get(poId) as
        | { id: number; po_number: string; status: string; po_date: string; delivery_date: string; revision_no: string; revision_date: string }
        | undefined;
      if (!po) throw new Error('Purchase Order not found');
      if (!['Draft', 'Pending Approval'].includes(po.status)) {
        throw new Error('Only Draft or Pending Approval Purchase Orders can be edited directly. Use Revise / Amend for Submitted orders.');
      }

      let subtotal = 0;
      let discountTotal = 0;
      let vatTotal = 0;
      const lines = b.items.map((l) => {
        const item = db.prepare('SELECT name, purchase_uom, vat_rate FROM items WHERE id = ?').get(l.item_id) as { name: string; purchase_uom: string; vat_rate: number } | undefined;
        if (!item) throw new Error(`Invalid item ID ${l.item_id}`);
        const gross = roundMoney(l.qty * l.rate);
        const disc = roundMoney((gross * (l.discount_pct || 0)) / 100);
        const net = roundMoney(gross - disc);
        const vatRate = l.vat_rate ?? item.vat_rate ?? 5;
        const vatAmt = roundMoney((net * vatRate) / 100);
        const total = roundMoney(net + vatAmt);
        subtotal = roundMoney(subtotal + net);
        discountTotal = roundMoney(discountTotal + disc);
        vatTotal = roundMoney(vatTotal + vatAmt);
        return { ...l, description: l.description || item.name, uom: l.uom || item.purchase_uom, vatRate, vatAmt, total };
      });
      const freight = roundMoney(b.freight_amount || 0);
      const grandTotal = roundMoney(subtotal + vatTotal + freight);

      const wh = db.prepare('SELECT name, location FROM warehouses WHERE id = ?').get(b.warehouse_id) as { name: string; location: string } | undefined;
      const delPlace = b.delivery_place || (wh ? wh.location || wh.name : '');

      db.prepare(
        `UPDATE purchase_orders
         SET po_date = ?, delivery_date = ?, supplier_id = ?, supplier_ref = ?, delivery_terms = ?, delivery_place = ?,
             revision_no = ?, revision_date = ?, currency = ?, exchange_rate = ?, payment_term_id = ?, warehouse_id = ?,
             subtotal = ?, discount_amount = ?, freight_amount = ?, vat_amount = ?, total_amount = ?,
             status = 'Draft', approval_status = 'Not Submitted', remarks = ?
         WHERE id = ?`
      ).run(
        b.po_date || po.po_date,
        b.delivery_date || po.delivery_date,
        b.supplier_id,
        b.supplier_ref || '',
        b.delivery_terms || '',
        delPlace,
        b.revision_no || po.revision_no || 'Original',
        b.revision_date ?? po.revision_date ?? '',
        b.currency || 'AED',
        b.exchange_rate || 1,
        b.payment_term_id || null,
        b.warehouse_id,
        subtotal,
        discountTotal,
        freight,
        vatTotal,
        grandTotal,
        b.remarks || '',
        poId
      );

      db.prepare('DELETE FROM purchase_order_items WHERE po_id = ?').run(poId);
      const insItem = db.prepare(
        `INSERT INTO purchase_order_items (po_id, item_id, description, qty, uom, rate, discount_pct, vat_rate, vat_amount, line_total)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      for (const l of lines) {
        insItem.run(poId, l.item_id, l.description, roundQty(l.qty), l.uom, roundMoney(l.rate), l.discount_pct || 0, l.vatRate, l.vatAmt, l.total);
      }

      db.prepare("DELETE FROM approval_requests WHERE doc_type = 'PurchaseOrder' AND doc_id = ? AND status = 'Pending'").run(poId);
      recordAuditLog(db, req.user, 'PurchaseOrder', poId, po.po_number, 'Edit PO', { total_amount: grandTotal });
      return { id: poId, po_number: po.po_number, total_amount: grandTotal };
    });
    res.json(result);
  } catch (err: unknown) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Failed to update PO' });
  }
});

router.post('/purchase-orders/:id/revise', requirePermission('procurement', 'can_amend'), (req: AuthRequest, res) => {
  const poId = Number(req.params.id);
  try {
    const result = withTransaction((db) => {
      const orig = db.prepare('SELECT * FROM purchase_orders WHERE id = ?').get(poId) as
        | {
            id: number;
            po_number: string;
            po_date: string;
            delivery_date: string;
            supplier_id: number;
            supplier_ref: string;
            delivery_terms: string;
            delivery_place: string;
            sq_id: number | null;
            pr_id: number | null;
            currency: string;
            exchange_rate: number;
            payment_term_id: number | null;
            warehouse_id: number;
            subtotal: number;
            discount_amount: number;
            freight_amount: number;
            vat_amount: number;
            total_amount: number;
            status: string;
            remarks: string;
            amended_from?: string;
          }
        | undefined;
      if (!orig) throw new Error('Purchase Order not found');
      if (orig.status === 'Cancelled') throw new Error('Cannot revise an already Cancelled Purchase Order');

      const grnCount = (db.prepare("SELECT COUNT(*) as c FROM purchase_receipts WHERE po_id = ? AND status = 'Submitted'").get(poId) as { c: number }).c;
      if (grnCount > 0) throw new Error('Cannot revise Purchase Order that already has submitted Goods Receipt Notes');
      const piCount = (db.prepare("SELECT COUNT(*) as c FROM purchase_invoices WHERE po_id = ? AND status != 'Cancelled'").get(poId) as { c: number }).c;
      if (piCount > 0) throw new Error('Cannot revise Purchase Order that already has active Purchase Invoices');

      const baseNumber = orig.amended_from ? orig.po_number.replace(/-\d+$/, '') : orig.po_number;
      const existing = db
        .prepare('SELECT po_number FROM purchase_orders WHERE po_number LIKE ?')
        .all(`${baseNumber}-%`) as { po_number: string }[];
      let maxSuffix = 0;
      for (const row of existing) {
        const rest = row.po_number.slice(baseNumber.length + 1);
        if (/^\d+$/.test(rest)) maxSuffix = Math.max(maxSuffix, Number(rest));
      }
      const nextSuffix = maxSuffix + 1;
      const newPoNumber = `${baseNumber}-${nextSuffix}`;
      const revNo = `R${nextSuffix}`;
      const revDate = todayISO();

      db.prepare("UPDATE purchase_orders SET status = 'Cancelled' WHERE id = ?").run(poId);
      db.prepare("DELETE FROM approval_requests WHERE doc_type = 'PurchaseOrder' AND doc_id = ? AND status = 'Pending'").run(poId);

      const origItems = db.prepare('SELECT * FROM purchase_order_items WHERE po_id = ? ORDER BY id ASC').all(poId) as {
        item_id: number;
        description: string;
        qty: number;
        uom: string;
        rate: number;
        discount_pct: number;
        vat_rate: number;
        vat_amount: number;
        line_total: number;
      }[];

      const r = db
        .prepare(
          `INSERT INTO purchase_orders (po_number, po_date, delivery_date, supplier_id, supplier_ref, delivery_terms, delivery_place, revision_no, revision_date, amended_from, sq_id, pr_id, currency, exchange_rate, payment_term_id, warehouse_id, subtotal, discount_amount, freight_amount, vat_amount, total_amount, status, approval_status, remarks, created_by, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Draft', 'Not Submitted', ?, ?, ?)`
        )
        .run(
          newPoNumber,
          todayISO(),
          orig.delivery_date,
          orig.supplier_id,
          orig.supplier_ref || '',
          orig.delivery_terms || '',
          orig.delivery_place || '',
          revNo,
          revDate,
          orig.po_number,
          orig.sq_id,
          orig.pr_id,
          orig.currency || 'AED',
          orig.exchange_rate || 1,
          orig.payment_term_id,
          orig.warehouse_id,
          orig.subtotal,
          orig.discount_amount,
          orig.freight_amount,
          orig.vat_amount,
          orig.total_amount,
          orig.remarks || '',
          req.user!.id,
          nowISO()
        );
      const newPoId = Number(r.lastInsertRowid);
      const insItem = db.prepare(
        `INSERT INTO purchase_order_items (po_id, item_id, description, qty, uom, rate, discount_pct, vat_rate, vat_amount, line_total)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      for (const l of origItems) {
        insItem.run(newPoId, l.item_id, l.description, l.qty, l.uom, l.rate, l.discount_pct, l.vat_rate, l.vat_amount, l.line_total);
      }

      recordAuditLog(db, req.user, 'PurchaseOrder', poId, orig.po_number, `Amended to ${newPoNumber}`, { amended_to: newPoNumber });
      recordAuditLog(db, req.user, 'PurchaseOrder', newPoId, newPoNumber, `Created Revision ${revNo} from ${orig.po_number}`, {
        amended_from: orig.po_number,
      });

      return { id: newPoId, po_number: newPoNumber, amended_from: orig.po_number, revision_no: revNo };
    });
    res.status(201).json(result);
  } catch (err: unknown) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Failed to revise PO' });
  }
});

// ---------------- PURCHASE RECEIPTS / GRN ----------------
router.get('/purchase-receipts', requirePermission('procurement', 'can_view'), (_req, res) => {
  const db = getDb();
  const list = db
    .prepare(
      `SELECT grn.*, s.name as supplier_name, s.address as supplier_address, s.country as supplier_country,
              s.trn as supplier_trn, s.contact_person as supplier_contact_person,
              po.po_number, w.name as warehouse_name,
              cr.full_name as creator_name, sb.full_name as approver_name
       FROM purchase_receipts grn
       JOIN suppliers s ON s.id = grn.supplier_id
       LEFT JOIN purchase_orders po ON po.id = grn.po_id
       JOIN warehouses w ON w.id = grn.warehouse_id
       LEFT JOIN users cr ON cr.id = grn.created_by
       LEFT JOIN users sb ON sb.id = grn.submitted_by
       ORDER BY grn.id DESC`
    )
    .all() as Record<string, unknown>[];
  const items = db
    .prepare(
      `SELECT pri.*, i.item_code, i.name as item_name, st.tank_code, st.name as tank_name
       FROM purchase_receipt_items pri
       JOIN items i ON i.id = pri.item_id
       LEFT JOIN storage_tanks st ON st.id = pri.tank_id`
    )
    .all() as { grn_id: number }[];
  res.json({ items: list.map((g) => ({ ...g, items: items.filter((it) => it.grn_id === Number(g.id)) })) });
});

router.post('/purchase-receipts', requirePermission('procurement', 'can_create'), (req: AuthRequest, res) => {
  const b = req.body as {
    po_id?: number;
    supplier_id: number;
    receipt_date?: string;
    supplier_dn_number?: string;
    warehouse_id: number;
    remarks?: string;
    submit_now?: boolean;
    items: {
      po_item_id?: number;
      item_id: number;
      tank_id?: number | null;
      ordered_qty?: number;
      received_qty: number;
      accepted_qty: number;
      rejected_qty?: number;
      uom?: string;
      rate: number;
      batch_number?: string;
      mfg_date?: string;
      expiry_date?: string;
      qc_required?: boolean;
    }[];
  };
  if (!b.supplier_id || !b.warehouse_id || !Array.isArray(b.items) || b.items.length === 0) {
    res.status(400).json({ error: 'Supplier, warehouse, and receipt items are required' });
    return;
  }
  try {
    const result = withTransaction((db) => {
      if (b.po_id) {
        const po = db.prepare('SELECT status FROM purchase_orders WHERE id = ?').get(b.po_id) as { status: string } | undefined;
        if (!po || !['Submitted', 'Partially Received'].includes(po.status)) {
          throw new Error('Purchase Order must be Submitted/Approved before receiving goods');
        }
      }
      const grnNumber = getNextDocumentNumber(db, 'GRN');
      const r = db
        .prepare(
          `INSERT INTO purchase_receipts (grn_number, receipt_date, po_id, supplier_id, supplier_dn_number, warehouse_id, status, remarks, created_by, created_at)
           VALUES (?, ?, ?, ?, ?, ?, 'Draft', ?, ?, ?)`
        )
        .run(grnNumber, b.receipt_date || todayISO(), b.po_id || null, b.supplier_id, b.supplier_dn_number || '', b.warehouse_id, b.remarks || '', req.user!.id, nowISO());
      const grnId = Number(r.lastInsertRowid);
      const ins = db.prepare(
        `INSERT INTO purchase_receipt_items (grn_id, po_item_id, item_id, tank_id, ordered_qty, received_qty, accepted_qty, rejected_qty, uom, rate, warehouse_id, batch_number, mfg_date, expiry_date, qc_required, qc_status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Pending')`
      );
      for (const l of b.items) {
        const item = db.prepare('SELECT stock_uom, item_code FROM items WHERE id = ?').get(l.item_id) as { stock_uom: string; item_code: string };
        const batchNo = l.batch_number?.trim() || `B-${item.item_code}-${grnNumber}`;
        ins.run(
          grnId,
          l.po_item_id || null,
          l.item_id,
          l.tank_id || null,
          roundQty(l.ordered_qty || l.received_qty),
          roundQty(l.received_qty),
          roundQty(l.accepted_qty),
          roundQty(l.rejected_qty || 0),
          l.uom || item.stock_uom,
          roundMoney(l.rate),
          b.warehouse_id,
          batchNo,
          l.mfg_date || '',
          l.expiry_date || '',
          l.qc_required === false ? 0 : 1
        );
      }
      recordAuditLog(db, req.user, 'PurchaseReceipt', grnId, grnNumber, 'Create GRN', { po_id: b.po_id });
      if (b.submit_now) {
        submitGrnInternal(db, grnId, req.user!);
      }
      return { id: grnId, grn_number: grnNumber };
    });
    res.status(201).json(result);
  } catch (err: unknown) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Failed to create GRN' });
  }
});

function submitGrnInternal(db: ReturnType<typeof getDb>, grnId: number, user: NonNullable<AuthRequest['user']>) {
  const grn = db.prepare('SELECT * FROM purchase_receipts WHERE id = ?').get(grnId) as
    | { id: number; grn_number: string; receipt_date: string; po_id: number | null; supplier_id: number; warehouse_id: number; status: string }
    | undefined;
  if (!grn) throw new Error('GRN not found');
  if (grn.status === 'Submitted') throw new Error('GRN already submitted');

  const lines = db.prepare('SELECT * FROM purchase_receipt_items WHERE grn_id = ?').all(grnId) as {
    id: number;
    po_item_id: number | null;
    item_id: number;
    tank_id: number | null;
    accepted_qty: number;
    rate: number;
    warehouse_id: number;
    batch_number: string;
    mfg_date: string;
    expiry_date: string;
    qc_required: number;
  }[];

  let totalInventoryValue = 0;
  let fxRate = 1;
  if (grn.po_id) {
    const po = db.prepare('SELECT exchange_rate FROM purchase_orders WHERE id = ?').get(grn.po_id) as { exchange_rate: number } | undefined;
    if (po) fxRate = po.exchange_rate || 1;
  }

  for (const l of lines) {
    if (l.accepted_qty > 0) {
      const baseRate = roundMoney(l.rate * fxRate);
      const mov = postStockMovement(db, {
        postingDate: grn.receipt_date,
        docType: 'PurchaseReceipt',
        docId: grn.id,
        docNumber: grn.grn_number,
        itemId: l.item_id,
        warehouseId: l.warehouse_id,
        tankId: l.tank_id,
        batchNumber: l.batch_number,
        inwardQty: l.accepted_qty,
        unitCost: baseRate,
        supplierId: grn.supplier_id,
        mfgDate: l.mfg_date,
        expiryDate: l.expiry_date,
        qcStatus: l.qc_required ? 'Pending' : 'Released',
        isOnHold: l.qc_required === 1,
        remarks: `GRN ${grn.grn_number}`,
        userId: user.id,
      });
      totalInventoryValue = roundMoney(totalInventoryValue + l.accepted_qty * baseRate);

      if (l.qc_required) {
        const qcNumber = getNextDocumentNumber(db, 'QC');
        db.prepare(
          `INSERT INTO quality_inspections (qc_number, inspection_type, doc_type, doc_id, doc_number, item_id, batch_id, batch_number, inspection_date, inspector_name, overall_status, batch_action, remarks, created_by, created_at)
           VALUES (?, 'Incoming Raw Material', 'PurchaseReceipt', ?, ?, ?, ?, ?, ?, ?, 'Pending', 'Hold', 'Auto-triggered by GRN submission', ?, ?)`
        ).run(qcNumber, grn.id, grn.grn_number, l.item_id, mov.batchId, l.batch_number, grn.receipt_date, user.full_name, user.id, nowISO());
      }
    }
    if (l.po_item_id) {
      db.prepare('UPDATE purchase_order_items SET received_qty = ROUND(received_qty + ?, 4) WHERE id = ?').run(l.accepted_qty, l.po_item_id);
    }
  }

  // Update PO status (Partially Received vs Completed)
  if (grn.po_id) {
    const poItems = db.prepare('SELECT qty, received_qty FROM purchase_order_items WHERE po_id = ?').all(grn.po_id) as { qty: number; received_qty: number }[];
    const allReceived = poItems.every((i) => i.received_qty >= i.qty - 0.0001);
    db.prepare('UPDATE purchase_orders SET status = ? WHERE id = ?').run(allReceived ? 'Completed' : 'Partially Received', grn.po_id);
  }

  // Post GRNI accounting accrual (DR 1300 Inventory / CR 2110 GRNI)
  if (totalInventoryValue > 0) {
    postJournalEntry(db, {
      postingDate: grn.receipt_date,
      entryType: 'Purchase Receipt',
      refDocType: 'PurchaseReceipt',
      refDocId: grn.id,
      refDocNumber: grn.grn_number,
      narration: `Goods Receipt ${grn.grn_number} into Inventory`,
      lines: [
        { accountCode: '1300', debit: totalInventoryValue, description: `Inventory received (${grn.grn_number})` },
        { accountCode: '2110', credit: totalInventoryValue, description: `GRNI Accrual (${grn.grn_number})` },
      ],
      userId: user.id,
    });
  }

  db.prepare("UPDATE purchase_receipts SET status = 'Submitted', submitted_by = ?, submitted_at = ? WHERE id = ?").run(user.id, nowISO(), grnId);
  recordAuditLog(db, user, 'PurchaseReceipt', grnId, grn.grn_number, 'Submit GRN', { totalInventoryValue });
}

router.post('/purchase-receipts/:id/submit', requirePermission('procurement', 'can_submit'), (req: AuthRequest, res) => {
  try {
    withTransaction((db) => submitGrnInternal(db, Number(req.params.id), req.user!));
    res.json({ ok: true });
  } catch (err: unknown) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Failed to submit GRN' });
  }
});

// ---------------- PURCHASE INVOICES & 3-WAY MATCHING ----------------
router.get('/purchase-invoices', requirePermission('procurement', 'can_view'), (_req, res) => {
  const db = getDb();
  const list = db
    .prepare(
      `SELECT pi.*, s.name as supplier_name, s.code as supplier_code, s.address as supplier_address,
              s.country as supplier_country, s.trn as supplier_trn, s.contact_person as supplier_contact_person,
              po.po_number, grn.grn_number, pt.name as payment_term_name,
              cr.full_name as creator_name, ps.full_name as approver_name
       FROM purchase_invoices pi
       JOIN suppliers s ON s.id = pi.supplier_id
       LEFT JOIN purchase_orders po ON po.id = pi.po_id
       LEFT JOIN purchase_receipts grn ON grn.id = pi.grn_id
       LEFT JOIN payment_terms pt ON pt.id = pi.payment_term_id
       LEFT JOIN users cr ON cr.id = pi.created_by
       LEFT JOIN users ps ON ps.id = pi.posted_by
       ORDER BY pi.id DESC`
    )
    .all() as Record<string, unknown>[];
  const items = db
    .prepare('SELECT pii.*, i.item_code, i.name as item_name FROM purchase_invoice_items pii JOIN items i ON i.id = pii.item_id')
    .all() as { pi_id: number }[];
  const schedules = db
    .prepare("SELECT * FROM payment_schedules WHERE doc_type = 'PurchaseInvoice' ORDER BY installment_no ASC")
    .all() as { doc_id: number }[];

  res.json({
    items: list.map((inv) => ({
      ...inv,
      matching_notes: JSON.parse(String(inv.matching_notes_json || '[]')),
      items: items.filter((it) => it.pi_id === Number(inv.id)),
      payment_schedules: schedules.filter((ps) => ps.doc_id === Number(inv.id)),
    })),
  });
});

function runThreeWayMatching(
  db: ReturnType<typeof getDb>,
  params: {
    supplierId: number;
    supplierInvoiceNumber: string;
    poId?: number | null;
    grnId?: number | null;
    isDirect?: boolean;
    items: { item_id: number; qty: number; rate: number; vat_rate?: number }[];
  }
): { status: 'Matched' | 'Mismatch' | 'Direct'; flags: string[] } {
  const flags: string[] = [];

  // Duplicate Supplier Invoice check
  const dup = db
    .prepare("SELECT pi_number FROM purchase_invoices WHERE supplier_id = ? AND supplier_invoice_number = ? AND status != 'Cancelled'")
    .get(params.supplierId, params.supplierInvoiceNumber) as { pi_number: string } | undefined;
  if (dup) {
    flags.push(`Duplicate supplier invoice number already recorded on ${dup.pi_number}`);
  }

  if (params.isDirect && !params.poId && !params.grnId) {
    return { status: flags.length > 0 ? 'Mismatch' : 'Direct', flags };
  }

  if (!params.poId || !params.grnId) {
    flags.push('Missing linked Purchase Order or GRN for mandatory 3-way matching');
    return { status: 'Mismatch', flags };
  }

  const qtyTol = Number((db.prepare("SELECT value FROM system_settings WHERE key = 'three_way_match_qty_tolerance_pct'").get() as { value: string } | undefined)?.value || 2);
  const priceTol = Number((db.prepare("SELECT value FROM system_settings WHERE key = 'three_way_match_price_tolerance_pct'").get() as { value: string } | undefined)?.value || 1.5);

  const poItems = db.prepare('SELECT item_id, qty, rate FROM purchase_order_items WHERE po_id = ?').all(params.poId) as {
    item_id: number;
    qty: number;
    rate: number;
  }[];
  const grnItems = db.prepare('SELECT item_id, SUM(accepted_qty) as accepted_qty FROM purchase_receipt_items WHERE grn_id = ? GROUP BY item_id').all(params.grnId) as {
    item_id: number;
    accepted_qty: number;
  }[];

  for (const invLine of params.items) {
    const poLine = poItems.find((p) => p.item_id === invLine.item_id);
    const grnLine = grnItems.find((g) => g.item_id === invLine.item_id);
    const item = db.prepare('SELECT item_code FROM items WHERE id = ?').get(invLine.item_id) as { item_code: string };

    if (!poLine) {
      flags.push(`${item.item_code}: Not found on linked Purchase Order`);
      continue;
    }
    if (!grnLine || grnLine.accepted_qty <= 0) {
      flags.push(`${item.item_code}: Unreceived goods (0 accepted on linked GRN)`);
      continue;
    }

    const maxAllowedQty = grnLine.accepted_qty * (1 + qtyTol / 100);
    if (invLine.qty > maxAllowedQty) {
      flags.push(`${item.item_code}: Over-invoiced qty (${invLine.qty}) exceeds GRN accepted qty (${grnLine.accepted_qty}) beyond ${qtyTol}% tolerance`);
    }
    if (invLine.qty > poLine.qty * (1 + qtyTol / 100)) {
      flags.push(`${item.item_code}: Invoiced qty (${invLine.qty}) exceeds PO ordered qty (${poLine.qty})`);
    }
    const priceDiffPct = poLine.rate > 0 ? (Math.abs(invLine.rate - poLine.rate) / poLine.rate) * 100 : 0;
    if (priceDiffPct > priceTol) {
      flags.push(`${item.item_code}: Unit price variance (${invLine.rate} vs PO ${poLine.rate}, ${priceDiffPct.toFixed(1)}% diff)`);
    }
  }

  return {
    status: flags.length === 0 ? 'Matched' : 'Mismatch',
    flags,
  };
}

router.post('/purchase-invoices', requirePermission('procurement', 'can_create'), (req: AuthRequest, res) => {
  const b = req.body as {
    supplier_id: number;
    supplier_invoice_number: string;
    invoice_date?: string;
    due_date?: string;
    po_id?: number;
    grn_id?: number;
    is_direct?: boolean;
    currency?: string;
    exchange_rate?: number;
    payment_term_id?: number;
    freight_amount?: number;
    additional_charges?: number;
    remarks?: string;
    items: {
      po_item_id?: number;
      grn_item_id?: number;
      item_id: number;
      description?: string;
      qty: number;
      uom?: string;
      rate: number;
      discount_pct?: number;
      vat_rate?: number;
      tax_category?: string;
    }[];
  };

  if (!b.supplier_id || !b.supplier_invoice_number || !Array.isArray(b.items) || b.items.length === 0) {
    res.status(400).json({ error: 'Supplier, supplier invoice number, and items are required' });
    return;
  }

  try {
    const result = withTransaction((db) => {
      const piNumber = getNextDocumentNumber(db, 'PI');
      const match = runThreeWayMatching(db, {
        supplierId: b.supplier_id,
        supplierInvoiceNumber: b.supplier_invoice_number.trim(),
        poId: b.po_id,
        grnId: b.grn_id,
        isDirect: b.is_direct,
        items: b.items,
      });

      let subtotal = 0;
      let discountTotal = 0;
      let vatTotal = 0;
      const lines = b.items.map((l) => {
        const item = db.prepare('SELECT name, purchase_uom, vat_rate, tax_category FROM items WHERE id = ?').get(l.item_id) as {
          name: string;
          purchase_uom: string;
          vat_rate: number;
          tax_category: string;
        };
        const gross = roundMoney(l.qty * l.rate);
        const disc = roundMoney((gross * (l.discount_pct || 0)) / 100);
        const net = roundMoney(gross - disc);
        const taxCat = l.tax_category || item.tax_category || 'Standard Rated';
        const vatRate = taxCat === 'Standard Rated' ? l.vat_rate ?? item.vat_rate ?? 5 : 0;
        const vatAmt = roundMoney((net * vatRate) / 100);
        const total = roundMoney(net + vatAmt);
        subtotal = roundMoney(subtotal + net);
        discountTotal = roundMoney(discountTotal + disc);
        vatTotal = roundMoney(vatTotal + vatAmt);
        return { ...l, description: l.description || item.name, uom: l.uom || item.purchase_uom, taxCat, vatRate, vatAmt, total };
      });

      const freight = roundMoney(b.freight_amount || 0);
      const addCharges = roundMoney(b.additional_charges || 0);
      const grandTotal = roundMoney(subtotal + vatTotal + freight + addCharges);
      const invDate = b.invoice_date || todayISO();

      const r = db
        .prepare(
          `INSERT INTO purchase_invoices (
            pi_number, supplier_invoice_number, invoice_date, due_date, supplier_id, po_id, grn_id, is_direct,
            currency, exchange_rate, payment_term_id, subtotal, discount_amount, freight_amount, additional_charges,
            vat_amount, total_amount, paid_amount, outstanding_amount, matching_status, matching_notes_json,
            status, approval_status, remarks, created_by, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, 'Draft', ?, ?, ?, ?)`
        )
        .run(
          piNumber,
          b.supplier_invoice_number.trim(),
          invDate,
          b.due_date || addDaysISO(invDate, 30),
          b.supplier_id,
          b.po_id || null,
          b.grn_id || null,
          b.is_direct ? 1 : 0,
          b.currency || 'AED',
          b.exchange_rate || 1,
          b.payment_term_id || null,
          subtotal,
          discountTotal,
          freight,
          addCharges,
          vatTotal,
          grandTotal,
          grandTotal,
          match.status,
          JSON.stringify(match.flags),
          match.status === 'Mismatch' ? 'Pending Approval' : 'Approved',
          b.remarks || '',
          req.user!.id,
          nowISO()
        );
      const piId = Number(r.lastInsertRowid);
      const insItem = db.prepare(
        `INSERT INTO purchase_invoice_items (pi_id, po_item_id, grn_item_id, item_id, description, qty, uom, rate, discount_pct, vat_rate, tax_category, vat_amount, line_total)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      for (const l of lines) {
        insItem.run(piId, l.po_item_id || null, l.grn_item_id || null, l.item_id, l.description, roundQty(l.qty), l.uom, roundMoney(l.rate), l.discount_pct || 0, l.vatRate, l.taxCat, l.vatAmt, l.total);
      }

      if (match.status === 'Mismatch') {
        createNotification(db, {
          type: 'three_way_mismatch',
          title: `3-Way Match Variance: ${piNumber}`,
          message: match.flags.join('; '),
          docType: 'PurchaseInvoice',
          docId: piId,
        });
      }

      recordAuditLog(db, req.user, 'PurchaseInvoice', piId, piNumber, 'Create Purchase Invoice', {
        matching_status: match.status,
        flags: match.flags,
        total_amount: grandTotal,
      });

      return { id: piId, pi_number: piNumber, matching_status: match.status, matching_notes: match.flags, total_amount: grandTotal };
    });
    res.status(201).json(result);
  } catch (err: unknown) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Failed to create purchase invoice' });
  }
});

router.post('/purchase-invoices/:id/approve-mismatch', requirePermission('procurement', 'can_approve'), (req: AuthRequest, res) => {
  const piId = Number(req.params.id);
  try {
    withTransaction((db) => {
      const pi = db.prepare('SELECT pi_number FROM purchase_invoices WHERE id = ?').get(piId) as { pi_number: string } | undefined;
      if (!pi) throw new Error('Purchase invoice not found');
      db.prepare("UPDATE purchase_invoices SET approval_status = 'Approved' WHERE id = ?").run(piId);
      recordAuditLog(db, req.user, 'PurchaseInvoice', piId, pi.pi_number, 'Approve 3-Way Match Variance', {});
    });
    res.json({ ok: true });
  } catch (err: unknown) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Approval failed' });
  }
});

router.post('/purchase-invoices/:id/post', requirePermission('accounting', 'can_submit'), (req: AuthRequest, res) => {
  const piId = Number(req.params.id);
  try {
    const result = withTransaction((db) => {
      const pi = db.prepare('SELECT * FROM purchase_invoices WHERE id = ?').get(piId) as
        | {
            id: number;
            pi_number: string;
            invoice_date: string;
            supplier_id: number;
            grn_id: number | null;
            is_direct: number;
            currency: string;
            exchange_rate: number;
            payment_term_id: number | null;
            subtotal: number;
            freight_amount: number;
            additional_charges: number;
            vat_amount: number;
            total_amount: number;
            matching_status: string;
            approval_status: string;
            status: string;
          }
        | undefined;
      if (!pi) throw new Error('Purchase invoice not found');
      if (pi.status === 'Posted') throw new Error('Purchase invoice already posted');
      if (pi.matching_status === 'Mismatch' && pi.approval_status !== 'Approved') {
        throw new Error('Purchase invoice has 3-way matching variances and requires authorized approval before posting');
      }

      const fx = pi.exchange_rate || 1;
      const lines = [];
      // Debit GRNI (2110) if linked to GRN, else Expense/Inventory (1300)
      lines.push({
        accountCode: pi.grn_id ? '2110' : '1300',
        debit: pi.subtotal,
        currency: pi.currency,
        exchangeRate: fx,
        description: `Purchase goods (${pi.pi_number})`,
      });
      if (pi.freight_amount + pi.additional_charges > 0) {
        lines.push({
          accountCode: '5400',
          debit: roundMoney(pi.freight_amount + pi.additional_charges),
          currency: pi.currency,
          exchangeRate: fx,
          description: `Freight & additional charges (${pi.pi_number})`,
        });
      }
      if (pi.vat_amount > 0) {
        lines.push({
          accountCode: '1400',
          debit: pi.vat_amount,
          currency: pi.currency,
          exchangeRate: fx,
          description: `VAT Input 5% (${pi.pi_number})`,
        });
      }
      lines.push({
        accountCode: '2100',
        partyType: 'Supplier',
        partyId: pi.supplier_id,
        credit: pi.total_amount,
        currency: pi.currency,
        exchangeRate: fx,
        description: `Accounts Payable (${pi.pi_number})`,
      });

      const je = postJournalEntry(db, {
        postingDate: pi.invoice_date,
        entryType: 'Purchase Invoice',
        refDocType: 'PurchaseInvoice',
        refDocId: pi.id,
        refDocNumber: pi.pi_number,
        narration: `Post Purchase Invoice ${pi.pi_number}`,
        lines,
        userId: req.user!.id,
      });

      // Generate multi-installment Payment Schedules
      generatePaymentSchedules(db, {
        partyType: 'Supplier',
        partyId: pi.supplier_id,
        docType: 'PurchaseInvoice',
        docId: pi.id,
        docNumber: pi.pi_number,
        baseDate: pi.invoice_date,
        totalAmount: pi.total_amount,
        paymentTermId: pi.payment_term_id,
      });

      db.prepare("UPDATE purchase_invoices SET status = 'Posted', posted_by = ?, posted_at = ? WHERE id = ?").run(req.user!.id, nowISO(), piId);
      recordAuditLog(db, req.user, 'PurchaseInvoice', piId, pi.pi_number, 'Post Purchase Invoice', { je_number: je.jeNumber });
      return { ok: true, je_number: je.jeNumber };
    });
    res.json(result);
  } catch (err: unknown) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Failed to post purchase invoice' });
  }
});

// ---------------- PURCHASE RETURNS ----------------
router.get('/purchase-returns', requirePermission('procurement', 'can_view'), (_req, res) => {
  const db = getDb();
  const list = db
    .prepare(
      `SELECT prn.*, s.name as supplier_name, s.address as supplier_address, s.country as supplier_country,
              s.trn as supplier_trn, s.contact_person as supplier_contact_person,
              w.name as warehouse_name, cr.full_name as creator_name
       FROM purchase_returns prn
       JOIN suppliers s ON s.id = prn.supplier_id
       JOIN warehouses w ON w.id = prn.warehouse_id
       LEFT JOIN users cr ON cr.id = prn.created_by
       ORDER BY prn.id DESC`
    )
    .all() as Record<string, unknown>[];
  const items = db
    .prepare('SELECT pri.*, i.item_code, i.name as item_name FROM purchase_return_items pri JOIN items i ON i.id = pri.item_id')
    .all() as { prn_id: number }[];
  res.json({ items: list.map((r) => ({ ...r, items: items.filter((it) => it.prn_id === Number(r.id)) })) });
});

router.post('/purchase-returns', requirePermission('procurement', 'can_create'), (req: AuthRequest, res) => {
  const b = req.body as {
    supplier_id: number;
    grn_id?: number;
    pi_id?: number;
    warehouse_id: number;
    return_date?: string;
    reason: string;
    items: { item_id: number; batch_number?: string; qty: number; uom?: string; rate: number; vat_rate?: number }[];
  };
  if (!b.supplier_id || !b.warehouse_id || !b.reason || !Array.isArray(b.items) || b.items.length === 0) {
    res.status(400).json({ error: 'Supplier, warehouse, reason, and return items are required' });
    return;
  }
  try {
    const result = withTransaction((db) => {
      const prnNumber = getNextDocumentNumber(db, 'PRN');
      const rDate = b.return_date || todayISO();
      let netTotal = 0;
      let vatTotal = 0;
      const lines = b.items.map((l) => {
        const net = roundMoney(l.qty * l.rate);
        const vat = roundMoney((net * (l.vat_rate ?? 5)) / 100);
        netTotal = roundMoney(netTotal + net);
        vatTotal = roundMoney(vatTotal + vat);
        return { ...l, vat, lineTotal: roundMoney(net + vat) };
      });
      const grandTotal = roundMoney(netTotal + vatTotal);

      const r = db
        .prepare(
          `INSERT INTO purchase_returns (prn_number, return_date, supplier_id, grn_id, pi_id, warehouse_id, reason, total_amount, status, created_by, submitted_at, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'Submitted', ?, ?, ?)`
        )
        .run(prnNumber, rDate, b.supplier_id, b.grn_id || null, b.pi_id || null, b.warehouse_id, b.reason, grandTotal, req.user!.id, nowISO(), nowISO());
      const prnId = Number(r.lastInsertRowid);

      const insItem = db.prepare(
        'INSERT INTO purchase_return_items (prn_id, item_id, batch_id, batch_number, qty, uom, rate, vat_amount, line_total) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
      );
      for (const l of lines) {
        const mov = postStockMovement(db, {
          postingDate: rDate,
          docType: 'PurchaseReturn',
          docId: prnId,
          docNumber: prnNumber,
          itemId: l.item_id,
          warehouseId: b.warehouse_id,
          batchNumber: l.batch_number,
          outwardQty: l.qty,
          unitCost: l.rate,
          remarks: `Purchase Return: ${b.reason}`,
          userId: req.user!.id,
        });
        const item = db.prepare('SELECT stock_uom FROM items WHERE id = ?').get(l.item_id) as { stock_uom: string };
        insItem.run(prnId, l.item_id, mov.batchId, l.batch_number || '', roundQty(l.qty), l.uom || item.stock_uom, roundMoney(l.rate), l.vat, l.lineTotal);
      }

      postJournalEntry(db, {
        postingDate: rDate,
        entryType: 'Debit Note',
        refDocType: 'PurchaseReturn',
        refDocId: prnId,
        refDocNumber: prnNumber,
        narration: `Purchase Return Debit Note ${prnNumber}: ${b.reason}`,
        lines: [
          { accountCode: '2100', partyType: 'Supplier', partyId: b.supplier_id, debit: grandTotal, description: `Supplier Debit Note (${prnNumber})` },
          { accountCode: '1300', credit: netTotal, description: `Inventory reversed (${prnNumber})` },
          { accountCode: '1400', credit: vatTotal, description: `VAT Input reversed (${prnNumber})` },
        ],
        userId: req.user!.id,
      });

      if (b.pi_id) {
        db.prepare('UPDATE purchase_invoices SET outstanding_amount = MAX(0, ROUND(outstanding_amount - ?, 2)) WHERE id = ?').run(grandTotal, b.pi_id);
      }

      recordAuditLog(db, req.user, 'PurchaseReturn', prnId, prnNumber, 'Submit Purchase Return', { total: grandTotal });
      return { id: prnId, prn_number: prnNumber, total_amount: grandTotal };
    });
    res.status(201).json(result);
  } catch (err: unknown) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Failed to create purchase return' });
  }
});

// ---------------- SUBCONTRACTING ----------------
router.get('/subcontracting', requirePermission('subcontracting', 'can_view'), (_req, res) => {
  const db = getDb();
  const subcontractors = db.prepare('SELECT s.*, w.name as warehouse_name FROM subcontractors s LEFT JOIN warehouses w ON w.id = s.warehouse_id').all();
  const orders = db
    .prepare(
      `SELECT so.*, sub.name as subcontractor_name, sub.address as subcontractor_address, sub.contact_person as subcontractor_contact_person,
              i.item_code, i.name as finished_item_name, cr.full_name as creator_name
       FROM subcontracting_orders so
       JOIN subcontractors sub ON sub.id = so.subcontractor_id
       JOIN items i ON i.id = so.finished_item_id
       LEFT JOIN users cr ON cr.id = so.created_by
       ORDER BY so.id DESC`
    )
    .all() as Record<string, unknown>[];
  const materials = db
    .prepare('SELECT sm.*, i.item_code, i.name as item_name FROM subcontracting_materials sm JOIN items i ON i.id = sm.item_id')
    .all() as { sub_order_id: number }[];
  res.json({
    subcontractors,
    orders: orders.map((o) => ({ ...o, materials: materials.filter((m) => m.sub_order_id === Number(o.id)) })),
  });
});

router.post('/subcontractors', requirePermission('subcontracting', 'can_create'), (req, res) => {
  const b = req.body as Record<string, unknown>;
  if (!b.name) {
    res.status(400).json({ error: 'Subcontractor name is required' });
    return;
  }
  const db = getDb();
  const count = (db.prepare('SELECT COUNT(*) as c FROM subcontractors').get() as { c: number }).c;
  const code = String(b.code || `SUB-${String(count + 1).padStart(3, '0')}`);
  const subWh = db.prepare("SELECT id FROM warehouses WHERE is_subcontractor = 1 LIMIT 1").get() as { id: number } | undefined;
  const r = db
    .prepare('INSERT INTO subcontractors (code, name, contact_person, phone, email, address, warehouse_id, is_active, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)')
    .run(code, b.name, b.contact_person || '', b.phone || '', b.email || '', b.address || '', b.warehouse_id || subWh?.id || null, nowISO());
  res.status(201).json({ id: r.lastInsertRowid, code });
});

router.post('/subcontracting-orders', requirePermission('subcontracting', 'can_create'), (req: AuthRequest, res) => {
  const b = req.body as {
    subcontractor_id: number;
    finished_item_id: number;
    planned_qty: number;
    bom_id?: number;
    service_rate: number;
    freight_charge?: number;
    source_warehouse_id: number;
    target_warehouse_id: number;
    expected_date?: string;
    remarks?: string;
    materials: { item_id: number; issued_qty: number; batch_number?: string }[];
  };
  if (!b.subcontractor_id || !b.finished_item_id || !b.planned_qty || !Array.isArray(b.materials) || b.materials.length === 0) {
    res.status(400).json({ error: 'Subcontractor, finished item, planned qty, and raw materials are required' });
    return;
  }
  try {
    const result = withTransaction((db) => {
      const subNumber = getNextDocumentNumber(db, 'SUB');
      const sub = db.prepare('SELECT warehouse_id FROM subcontractors WHERE id = ?').get(b.subcontractor_id) as { warehouse_id: number | null };
      const subWhId = sub?.warehouse_id || (db.prepare('SELECT id FROM warehouses WHERE is_subcontractor = 1 LIMIT 1').get() as { id: number }).id;

      const r = db
        .prepare(
          `INSERT INTO subcontracting_orders (sub_number, order_date, expected_date, subcontractor_id, finished_item_id, planned_qty, bom_id, service_rate, freight_charge, source_warehouse_id, target_warehouse_id, status, remarks, created_by, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Materials Issued', ?, ?, ?)`
        )
        .run(
          subNumber,
          todayISO(),
          b.expected_date || addDaysISO(todayISO(), 10),
          b.subcontractor_id,
          b.finished_item_id,
          roundQty(b.planned_qty),
          b.bom_id || null,
          roundMoney(b.service_rate),
          roundMoney(b.freight_charge || 0),
          b.source_warehouse_id,
          b.target_warehouse_id,
          b.remarks || '',
          req.user!.id,
          nowISO()
        );
      const subOrderId = Number(r.lastInsertRowid);
      const insMat = db.prepare(
        'INSERT INTO subcontracting_materials (sub_order_id, item_id, batch_id, batch_number, issued_qty, uom, unit_cost) VALUES (?, ?, ?, ?, ?, ?, ?)'
      );

      let totalTransferVal = 0;
      for (const m of b.materials) {
        const item = db.prepare('SELECT stock_uom FROM items WHERE id = ?').get(m.item_id) as { stock_uom: string };
        const outMov = postStockMovement(db, {
          postingDate: todayISO(),
          docType: 'SubcontractTransfer',
          docId: subOrderId,
          docNumber: subNumber,
          itemId: m.item_id,
          warehouseId: b.source_warehouse_id,
          batchNumber: m.batch_number,
          outwardQty: m.issued_qty,
          remarks: `Issued to Subcontractor (${subNumber})`,
          userId: req.user!.id,
        });
        postStockMovement(db, {
          postingDate: todayISO(),
          docType: 'SubcontractTransfer',
          docId: subOrderId,
          docNumber: subNumber,
          itemId: m.item_id,
          warehouseId: subWhId,
          batchNumber: m.batch_number || `SUB-${subNumber}-${m.item_id}`,
          inwardQty: m.issued_qty,
          unitCost: outMov.unitCost,
          remarks: `Held at Subcontractor (${subNumber})`,
          userId: req.user!.id,
        });
        totalTransferVal = roundMoney(totalTransferVal + m.issued_qty * outMov.unitCost);
        insMat.run(subOrderId, m.item_id, outMov.batchId, m.batch_number || '', roundQty(m.issued_qty), item.stock_uom, outMov.unitCost);
      }

      if (totalTransferVal > 0) {
        postJournalEntry(db, {
          postingDate: todayISO(),
          entryType: 'Subcontract Material Transfer',
          refDocType: 'SubcontractingOrder',
          refDocId: subOrderId,
          refDocNumber: subNumber,
          narration: `Materials transferred to subcontractor (${subNumber})`,
          lines: [
            { accountCode: '1330', debit: totalTransferVal, description: `Subcontractor-held stock (${subNumber})` },
            { accountCode: '1300', credit: totalTransferVal, description: `Raw materials issued (${subNumber})` },
          ],
          userId: req.user!.id,
        });
      }

      recordAuditLog(db, req.user, 'SubcontractingOrder', subOrderId, subNumber, 'Create & Issue Materials', { totalTransferVal });
      return { id: subOrderId, sub_number: subNumber };
    });
    res.status(201).json(result);
  } catch (err: unknown) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Failed to create subcontracting order' });
  }
});

router.post('/subcontracting-orders/:id/receive', requirePermission('subcontracting', 'can_submit'), (req: AuthRequest, res) => {
  const subOrderId = Number(req.params.id);
  const { received_qty, batch_number, consumptions } = req.body as {
    received_qty: number;
    batch_number?: string;
    consumptions?: { material_id: number; consumed_qty: number; returned_qty?: number; process_loss_qty?: number }[];
  };
  if (!received_qty || received_qty <= 0) {
    res.status(400).json({ error: 'Valid received_qty is required' });
    return;
  }
  try {
    const result = withTransaction((db) => {
      const order = db.prepare('SELECT * FROM subcontracting_orders WHERE id = ?').get(subOrderId) as
        | {
            id: number;
            sub_number: string;
            subcontractor_id: number;
            finished_item_id: number;
            service_rate: number;
            freight_charge: number;
            source_warehouse_id: number;
            target_warehouse_id: number;
            status: string;
          }
        | undefined;
      if (!order) throw new Error('Subcontracting order not found');
      if (order.status === 'Completed') throw new Error('Subcontracting order already completed');

      const sub = db.prepare('SELECT warehouse_id FROM subcontractors WHERE id = ?').get(order.subcontractor_id) as { warehouse_id: number | null };
      const subWhId = sub?.warehouse_id || (db.prepare('SELECT id FROM warehouses WHERE is_subcontractor = 1 LIMIT 1').get() as { id: number }).id;

      const mats = db.prepare('SELECT * FROM subcontracting_materials WHERE sub_order_id = ?').all(subOrderId) as {
        id: number;
        item_id: number;
        batch_number: string;
        issued_qty: number;
        unit_cost: number;
      }[];

      let consumedMaterialCost = 0;
      for (const m of mats) {
        const c = consumptions?.find((x) => x.material_id === m.id);
        const consumed = roundQty(c?.consumed_qty ?? m.issued_qty);
        const returned = roundQty(c?.returned_qty ?? 0);
        const loss = roundQty(c?.process_loss_qty ?? Math.max(0, m.issued_qty - consumed - returned));

        // Deduct consumed + loss from subcontractor warehouse
        if (consumed + loss > 0) {
          postStockMovement(db, {
            postingDate: todayISO(),
            docType: 'SubcontractConsumption',
            docId: order.id,
            docNumber: order.sub_number,
            itemId: m.item_id,
            warehouseId: subWhId,
            outwardQty: consumed + loss,
            unitCost: m.unit_cost,
            remarks: `Consumed at Subcontractor (${order.sub_number})`,
            userId: req.user!.id,
            allowNegativeOverride: true,
          });
        }
        if (returned > 0) {
          postStockMovement(db, {
            postingDate: todayISO(),
            docType: 'SubcontractReturn',
            docId: order.id,
            docNumber: order.sub_number,
            itemId: m.item_id,
            warehouseId: subWhId,
            outwardQty: returned,
            unitCost: m.unit_cost,
            userId: req.user!.id,
            allowNegativeOverride: true,
          });
          postStockMovement(db, {
            postingDate: todayISO(),
            docType: 'SubcontractReturn',
            docId: order.id,
            docNumber: order.sub_number,
            itemId: m.item_id,
            warehouseId: order.source_warehouse_id,
            inwardQty: returned,
            unitCost: m.unit_cost,
            userId: req.user!.id,
          });
        }
        consumedMaterialCost = roundMoney(consumedMaterialCost + (consumed + loss) * m.unit_cost);
        db.prepare('UPDATE subcontracting_materials SET consumed_qty = ?, returned_qty = ?, process_loss_qty = ? WHERE id = ?').run(consumed, returned, loss, m.id);
      }

      const serviceCost = roundMoney(received_qty * order.service_rate + order.freight_charge);
      const totalFgCost = roundMoney(consumedMaterialCost + serviceCost);
      const unitFgCost = roundMoney(totalFgCost / received_qty);
      const fgBatchNo = batch_number || `SUB-FG-${order.sub_number}`;

      postStockMovement(db, {
        postingDate: todayISO(),
        docType: 'SubcontractReceipt',
        docId: order.id,
        docNumber: order.sub_number,
        itemId: order.finished_item_id,
        warehouseId: order.target_warehouse_id,
        batchNumber: fgBatchNo,
        inwardQty: received_qty,
        unitCost: unitFgCost,
        mfgDate: todayISO(),
        qcStatus: 'Released',
        remarks: `Finished goods received from Subcontractor (${order.sub_number})`,
        userId: req.user!.id,
      });

      postJournalEntry(db, {
        postingDate: todayISO(),
        entryType: 'Subcontract Completion',
        refDocType: 'SubcontractingOrder',
        refDocId: order.id,
        refDocNumber: order.sub_number,
        narration: `Subcontracting finished receipt & service accrual (${order.sub_number})`,
        lines: [
          { accountCode: '1320', debit: totalFgCost, description: `Finished lubricants received (${order.sub_number})` },
          { accountCode: '1330', credit: consumedMaterialCost, description: `Subcontractor raw material consumed (${order.sub_number})` },
          { accountCode: '2110', credit: serviceCost, description: `Subcontractor service & freight accrued (${order.sub_number})` },
        ],
        userId: req.user!.id,
      });

      db.prepare("UPDATE subcontracting_orders SET received_qty = ?, total_service_cost = ?, status = 'Completed' WHERE id = ?").run(
        roundQty(received_qty),
        serviceCost,
        subOrderId
      );
      recordAuditLog(db, req.user, 'SubcontractingOrder', subOrderId, order.sub_number, 'Receive Subcontracted Goods', {
        received_qty,
        totalFgCost,
        unitFgCost,
      });
      return { ok: true, batch_number: fgBatchNo, total_fg_cost: totalFgCost, unit_cost: unitFgCost };
    });
    res.json(result);
  } catch (err: unknown) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Failed to receive subcontracted goods' });
  }
});

export default router;
