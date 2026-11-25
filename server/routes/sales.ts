import { Router } from 'express';
import { getDb, withTransaction } from '../db.ts';
import { authenticate, createNotification, recordAuditLog, requirePermission, type AuthRequest } from '../middleware/auth.ts';
import { addDaysISO, nowISO, roundMoney, roundQty, todayISO } from '../utils/helpers.ts';
import { getNextDocumentNumber } from '../services/numbering.ts';
import { getTotalItemStock, postStockMovement } from '../services/inventory.ts';
import { postJournalEntry, type JournalLineInput } from '../services/accounting.ts';
import { generatePaymentSchedules } from '../services/paymentTerms.ts';

const router = Router();
router.use(authenticate);

// ---------------- SALES QUOTATIONS ----------------
router.get('/quotations', requirePermission('sales', 'can_view'), (_req, res) => {
  const db = getDb();
  const list = db
    .prepare(
      `SELECT sq.*, c.name as customer_name, c.code as customer_code,
              c.address as customer_address, c.country as customer_country, c.trn as customer_trn,
              c.contact_person as customer_contact_person, c.telephone as customer_telephone,
              cr.full_name as creator_name
       FROM sales_quotations sq
       JOIN customers c ON c.id = sq.customer_id
       LEFT JOIN users cr ON cr.id = sq.created_by
       ORDER BY sq.id DESC`
    )
    .all() as Record<string, unknown>[];
  const items = db
    .prepare('SELECT sqi.*, i.item_code, i.name as item_name FROM sales_quotation_items sqi JOIN items i ON i.id = sqi.item_id')
    .all() as { sq_id: number }[];
  res.json({ items: list.map((q) => ({ ...q, items: items.filter((it) => it.sq_id === Number(q.id)) })) });
});

router.post('/quotations', requirePermission('sales', 'can_create'), (req: AuthRequest, res) => {
  const b = req.body as {
    customer_id: number;
    quotation_date?: string;
    valid_until?: string;
    currency?: string;
    exchange_rate?: number;
    price_list_id?: number;
    terms?: string;
    items: { item_id: number; qty: number; rate: number; discount_pct?: number; vat_rate?: number }[];
  };
  if (!b.customer_id || !Array.isArray(b.items) || b.items.length === 0) {
    res.status(400).json({ error: 'Customer and items are required' });
    return;
  }
  try {
    const result = withTransaction((db) => {
      const sqNumber = getNextDocumentNumber(db, 'SQUOTE');
      let subtotal = 0;
      let discTotal = 0;
      let vatTotal = 0;
      const lines = b.items.map((l) => {
        const item = db.prepare('SELECT name, sales_uom, vat_rate FROM items WHERE id = ?').get(l.item_id) as { name: string; sales_uom: string; vat_rate: number };
        const gross = roundMoney(l.qty * l.rate);
        const disc = roundMoney((gross * (l.discount_pct || 0)) / 100);
        const net = roundMoney(gross - disc);
        const vatRate = l.vat_rate ?? item.vat_rate ?? 5;
        const vatAmt = roundMoney((net * vatRate) / 100);
        subtotal = roundMoney(subtotal + net);
        discTotal = roundMoney(discTotal + disc);
        vatTotal = roundMoney(vatTotal + vatAmt);
        return { ...l, name: item.name, uom: item.sales_uom, vatRate, vatAmt, total: roundMoney(net + vatAmt) };
      });
      const grandTotal = roundMoney(subtotal + vatTotal);
      const r = db
        .prepare(
          `INSERT INTO sales_quotations (sq_number, customer_id, quotation_date, valid_until, currency, exchange_rate, price_list_id, subtotal, discount_amount, vat_amount, total_amount, status, terms, created_by, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Sent', ?, ?, ?)`
        )
        .run(
          sqNumber,
          b.customer_id,
          b.quotation_date || todayISO(),
          b.valid_until || addDaysISO(todayISO(), 15),
          b.currency || 'AED',
          b.exchange_rate || 1,
          b.price_list_id || null,
          subtotal,
          discTotal,
          vatTotal,
          grandTotal,
          b.terms || '',
          req.user!.id,
          nowISO()
        );
      const sqId = Number(r.lastInsertRowid);
      const ins = db.prepare(
        'INSERT INTO sales_quotation_items (sq_id, item_id, description, qty, uom, rate, discount_pct, vat_rate, vat_amount, line_total) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
      );
      for (const l of lines) ins.run(sqId, l.item_id, l.name, roundQty(l.qty), l.uom, roundMoney(l.rate), l.discount_pct || 0, l.vatRate, l.vatAmt, l.total);
      recordAuditLog(db, req.user, 'SalesQuotation', sqId, sqNumber, 'Create Sales Quotation', { total: grandTotal });
      return { id: sqId, sq_number: sqNumber, total_amount: grandTotal };
    });
    res.status(201).json(result);
  } catch (err: unknown) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Failed to create quotation' });
  }
});

router.post('/quotations/:id/revise', requirePermission('sales', 'can_amend'), (req: AuthRequest, res) => {
  const sqId = Number(req.params.id);
  try {
    const result = withTransaction((db) => {
      const orig = db.prepare('SELECT * FROM sales_quotations WHERE id = ?').get(sqId) as
        | {
            id: number;
            sq_number: string;
            customer_id: number;
            valid_until: string;
            currency: string;
            exchange_rate: number;
            price_list_id: number | null;
            subtotal: number;
            discount_amount: number;
            vat_amount: number;
            total_amount: number;
            status: string;
            terms: string;
            amended_from?: string;
          }
        | undefined;
      if (!orig) throw new Error('Sales Quotation not found');
      if (orig.status === 'Converted') throw new Error('Cannot revise a Sales Quotation already converted to a Sales Order');
      if (orig.status === 'Cancelled') throw new Error('Cannot revise a Cancelled Sales Quotation');

      const baseNumber = orig.amended_from ? orig.sq_number.replace(/-\d+$/, '') : orig.sq_number;
      const existing = db
        .prepare('SELECT sq_number FROM sales_quotations WHERE sq_number LIKE ?')
        .all(`${baseNumber}-%`) as { sq_number: string }[];
      let maxSuffix = 0;
      for (const row of existing) {
        const rest = row.sq_number.slice(baseNumber.length + 1);
        if (/^\d+$/.test(rest)) maxSuffix = Math.max(maxSuffix, Number(rest));
      }
      const nextSuffix = maxSuffix + 1;
      const newSqNumber = `${baseNumber}-${nextSuffix}`;
      const revNo = `R${nextSuffix}`;
      const revDate = todayISO();

      db.prepare("UPDATE sales_quotations SET status = 'Cancelled' WHERE id = ?").run(sqId);
      const origItems = db.prepare('SELECT * FROM sales_quotation_items WHERE sq_id = ? ORDER BY id ASC').all(sqId) as {
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
          `INSERT INTO sales_quotations (sq_number, customer_id, quotation_date, valid_until, currency, exchange_rate, price_list_id, subtotal, discount_amount, vat_amount, total_amount, status, terms, amended_from, revision_no, revision_date, created_by, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Sent', ?, ?, ?, ?, ?, ?)`
        )
        .run(
          newSqNumber,
          orig.customer_id,
          todayISO(),
          orig.valid_until,
          orig.currency || 'AED',
          orig.exchange_rate || 1,
          orig.price_list_id,
          orig.subtotal,
          orig.discount_amount,
          orig.vat_amount,
          orig.total_amount,
          orig.terms || '',
          orig.sq_number,
          revNo,
          revDate,
          req.user!.id,
          nowISO()
        );
      const newSqId = Number(r.lastInsertRowid);
      const ins = db.prepare(
        'INSERT INTO sales_quotation_items (sq_id, item_id, description, qty, uom, rate, discount_pct, vat_rate, vat_amount, line_total) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
      );
      for (const l of origItems) {
        ins.run(newSqId, l.item_id, l.description, l.qty, l.uom, l.rate, l.discount_pct, l.vat_rate, l.vat_amount, l.line_total);
      }

      recordAuditLog(db, req.user, 'SalesQuotation', sqId, orig.sq_number, `Amended to ${newSqNumber}`, {});
      recordAuditLog(db, req.user, 'SalesQuotation', newSqId, newSqNumber, `Created Revision ${revNo} from ${orig.sq_number}`, {});
      return { id: newSqId, sq_number: newSqNumber, amended_from: orig.sq_number, revision_no: revNo };
    });
    res.status(201).json(result);
  } catch (err: unknown) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Failed to revise quotation' });
  }
});

// ---------------- SALES ORDERS ----------------
router.get('/orders', requirePermission('sales', 'can_view'), (_req, res) => {
  const db = getDb();
  const orders = db
    .prepare(
      `SELECT so.*, c.name as customer_name, c.code as customer_code,
              c.address as customer_address, c.country as customer_country, c.trn as customer_trn,
              c.contact_person as customer_contact_person, c.telephone as customer_telephone,
              w.name as warehouse_name, w.location as warehouse_location,
              pt.name as payment_term_name, cr.full_name as creator_name
       FROM sales_orders so
       JOIN customers c ON c.id = so.customer_id
       JOIN warehouses w ON w.id = so.warehouse_id
       LEFT JOIN payment_terms pt ON pt.id = so.payment_term_id
       LEFT JOIN users cr ON cr.id = so.created_by
       ORDER BY so.id DESC`
    )
    .all() as Record<string, unknown>[];
  const items = db
    .prepare('SELECT soi.*, i.item_code, i.name as item_name FROM sales_order_items soi JOIN items i ON i.id = soi.item_id')
    .all() as { so_id: number }[];
  res.json({ items: orders.map((o) => ({ ...o, items: items.filter((it) => it.so_id === Number(o.id)) })) });
});

router.post('/orders', requirePermission('sales', 'can_create'), (req: AuthRequest, res) => {
  const b = req.body as {
    customer_id: number;
    sq_id?: number;
    order_date?: string;
    delivery_date?: string;
    customer_ref?: string;
    delivery_terms?: string;
    delivery_place?: string;
    revision_no?: string;
    revision_date?: string;
    payment_term_id?: number;
    currency?: string;
    exchange_rate?: number;
    warehouse_id: number;
    price_list_id?: number;
    reserve_stock?: boolean;
    remarks?: string;
    items: { item_id: number; qty: number; rate: number; discount_pct?: number; vat_rate?: number }[];
  };
  if (!b.customer_id || !b.warehouse_id || !Array.isArray(b.items) || b.items.length === 0) {
    res.status(400).json({ error: 'Customer, warehouse, and items are required' });
    return;
  }

  try {
    const result = withTransaction((db) => {
      const cust = db.prepare('SELECT name, address, credit_limit, payment_term_id FROM customers WHERE id = ?').get(b.customer_id) as {
        name: string;
        address: string;
        credit_limit: number;
        payment_term_id: number | null;
      };
      const soNumber = getNextDocumentNumber(db, 'SO');
      let subtotal = 0;
      let discTotal = 0;
      let vatTotal = 0;
      const lines = b.items.map((l) => {
        const item = db.prepare('SELECT name, sales_uom, vat_rate FROM items WHERE id = ?').get(l.item_id) as { name: string; sales_uom: string; vat_rate: number };
        const gross = roundMoney(l.qty * l.rate);
        const disc = roundMoney((gross * (l.discount_pct || 0)) / 100);
        const net = roundMoney(gross - disc);
        const vatRate = l.vat_rate ?? item.vat_rate ?? 5;
        const vatAmt = roundMoney((net * vatRate) / 100);
        subtotal = roundMoney(subtotal + net);
        discTotal = roundMoney(discTotal + disc);
        vatTotal = roundMoney(vatTotal + vatAmt);
        return { ...l, name: item.name, uom: item.sales_uom, vatRate, vatAmt, total: roundMoney(net + vatAmt) };
      });
      const grandTotal = roundMoney(subtotal + vatTotal);

      // Check credit limit warning
      const existingOutstanding =
        (db.prepare("SELECT COALESCE(SUM(outstanding_amount), 0) as s FROM sales_invoices WHERE customer_id = ? AND status = 'Posted'").get(b.customer_id) as { s: number }).s || 0;
      if (cust.credit_limit > 0 && existingOutstanding + grandTotal * (b.exchange_rate || 1) > cust.credit_limit) {
        createNotification(db, {
          type: 'credit_limit',
          title: `Customer Credit Limit Exceeded: ${cust.name}`,
          message: `Order ${soNumber} pushes ${cust.name} exposure above credit limit (${cust.credit_limit}).`,
          docType: 'SalesOrder',
        });
      }

      const r = db
        .prepare(
          `INSERT INTO sales_orders (so_number, customer_id, sq_id, order_date, delivery_date, customer_ref, delivery_terms, delivery_place, revision_no, revision_date, payment_term_id, currency, exchange_rate, warehouse_id, price_list_id, subtotal, discount_amount, vat_amount, total_amount, status, approval_status, remarks, created_by, submitted_at, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Submitted', 'Approved', ?, ?, ?, ?)`
        )
        .run(
          soNumber,
          b.customer_id,
          b.sq_id || null,
          b.order_date || todayISO(),
          b.delivery_date || addDaysISO(todayISO(), 5),
          b.customer_ref || '',
          b.delivery_terms || '',
          b.delivery_place || cust.address || '',
          b.revision_no || 'Original',
          b.revision_date || '',
          b.payment_term_id || cust.payment_term_id || null,
          b.currency || 'AED',
          b.exchange_rate || 1,
          b.warehouse_id,
          b.price_list_id || null,
          subtotal,
          discTotal,
          vatTotal,
          grandTotal,
          b.remarks || '',
          req.user!.id,
          nowISO(),
          nowISO()
        );
      const soId = Number(r.lastInsertRowid);
      const ins = db.prepare(
        `INSERT INTO sales_order_items (so_id, item_id, description, qty, reserved_qty, uom, rate, discount_pct, vat_rate, vat_amount, line_total)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      for (const l of lines) {
        const avail = getTotalItemStock(db, l.item_id);
        const reserved = b.reserve_stock !== false ? Math.min(avail, roundQty(l.qty)) : 0;
        ins.run(soId, l.item_id, l.name, roundQty(l.qty), reserved, l.uom, roundMoney(l.rate), l.discount_pct || 0, l.vatRate, l.vatAmt, l.total);
        if (reserved > 0) {
          db.prepare(
            "INSERT INTO stock_reservations (doc_type, doc_id, doc_number, item_id, warehouse_id, qty, status, created_at) VALUES ('SalesOrder', ?, ?, ?, ?, ?, 'Active', ?)"
          ).run(soId, soNumber, l.item_id, b.warehouse_id, reserved, nowISO());
        }
      }
      if (b.sq_id) db.prepare("UPDATE sales_quotations SET status = 'Converted' WHERE id = ?").run(b.sq_id);
      recordAuditLog(db, req.user, 'SalesOrder', soId, soNumber, 'Create & Submit Sales Order', { total_amount: grandTotal });
      return { id: soId, so_number: soNumber, total_amount: grandTotal };
    });
    res.status(201).json(result);
  } catch (err: unknown) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Failed to create sales order' });
  }
});

router.put('/orders/:id', requirePermission('sales', 'can_edit'), (req: AuthRequest, res) => {
  const soId = Number(req.params.id);
  const b = req.body as {
    customer_id: number;
    order_date?: string;
    delivery_date?: string;
    customer_ref?: string;
    delivery_terms?: string;
    delivery_place?: string;
    revision_no?: string;
    revision_date?: string;
    payment_term_id?: number;
    currency?: string;
    exchange_rate?: number;
    warehouse_id: number;
    price_list_id?: number;
    remarks?: string;
    items: { item_id: number; qty: number; rate: number; discount_pct?: number; vat_rate?: number }[];
  };
  if (!b.customer_id || !b.warehouse_id || !Array.isArray(b.items) || b.items.length === 0) {
    res.status(400).json({ error: 'Customer, warehouse, and items are required' });
    return;
  }

  try {
    const result = withTransaction((db) => {
      const so = db.prepare('SELECT id, so_number, status, order_date, delivery_date, revision_no, revision_date FROM sales_orders WHERE id = ?').get(soId) as
        | { id: number; so_number: string; status: string; order_date: string; delivery_date: string; revision_no: string; revision_date: string }
        | undefined;
      if (!so) throw new Error('Sales Order not found');
      if (so.status !== 'Draft') throw new Error('Only Draft Sales Orders can be edited directly. Use Revise / Amend for Submitted orders.');

      const cust = db.prepare('SELECT address, payment_term_id FROM customers WHERE id = ?').get(b.customer_id) as
        | { address: string; payment_term_id: number | null }
        | undefined;
      if (!cust) throw new Error('Customer not found');

      let subtotal = 0;
      let discTotal = 0;
      let vatTotal = 0;
      const lines = b.items.map((l) => {
        const item = db.prepare('SELECT name, sales_uom, vat_rate FROM items WHERE id = ?').get(l.item_id) as { name: string; sales_uom: string; vat_rate: number } | undefined;
        if (!item) throw new Error(`Invalid item ID ${l.item_id}`);
        const gross = roundMoney(l.qty * l.rate);
        const disc = roundMoney((gross * (l.discount_pct || 0)) / 100);
        const net = roundMoney(gross - disc);
        const vatRate = l.vat_rate ?? item.vat_rate ?? 5;
        const vatAmt = roundMoney((net * vatRate) / 100);
        subtotal = roundMoney(subtotal + net);
        discTotal = roundMoney(discTotal + disc);
        vatTotal = roundMoney(vatTotal + vatAmt);
        return { ...l, name: item.name, uom: item.sales_uom, vatRate, vatAmt, total: roundMoney(net + vatAmt) };
      });
      const grandTotal = roundMoney(subtotal + vatTotal);

      db.prepare(
        `UPDATE sales_orders
         SET customer_id = ?, order_date = ?, delivery_date = ?, customer_ref = ?, delivery_terms = ?, delivery_place = ?,
             revision_no = ?, revision_date = ?, payment_term_id = ?, currency = ?, exchange_rate = ?, warehouse_id = ?, price_list_id = ?,
             subtotal = ?, discount_amount = ?, vat_amount = ?, total_amount = ?, remarks = ?
         WHERE id = ?`
      ).run(
        b.customer_id,
        b.order_date || so.order_date,
        b.delivery_date || so.delivery_date,
        b.customer_ref || '',
        b.delivery_terms || '',
        b.delivery_place || cust.address || '',
        b.revision_no || so.revision_no || 'Original',
        b.revision_date ?? so.revision_date ?? '',
        b.payment_term_id || cust.payment_term_id || null,
        b.currency || 'AED',
        b.exchange_rate || 1,
        b.warehouse_id,
        b.price_list_id || null,
        subtotal,
        discTotal,
        vatTotal,
        grandTotal,
        b.remarks || '',
        soId
      );

      db.prepare('DELETE FROM sales_order_items WHERE so_id = ?').run(soId);
      const ins = db.prepare(
        `INSERT INTO sales_order_items (so_id, item_id, description, qty, reserved_qty, uom, rate, discount_pct, vat_rate, vat_amount, line_total)
         VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?)`
      );
      for (const l of lines) {
        ins.run(soId, l.item_id, l.name, roundQty(l.qty), l.uom, roundMoney(l.rate), l.discount_pct || 0, l.vatRate, l.vatAmt, l.total);
      }

      recordAuditLog(db, req.user, 'SalesOrder', soId, so.so_number, 'Edit Sales Order', { total_amount: grandTotal });
      return { id: soId, so_number: so.so_number, total_amount: grandTotal };
    });
    res.json(result);
  } catch (err: unknown) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Failed to update sales order' });
  }
});

router.post('/orders/:id/submit', requirePermission('sales', 'can_submit'), (req: AuthRequest, res) => {
  const soId = Number(req.params.id);
  try {
    const result = withTransaction((db) => {
      const so = db.prepare('SELECT * FROM sales_orders WHERE id = ?').get(soId) as
        | { id: number; so_number: string; status: string; warehouse_id: number }
        | undefined;
      if (!so) throw new Error('Sales Order not found');
      if (so.status !== 'Draft') throw new Error('Sales Order is already submitted or cancelled');

      const lines = db.prepare('SELECT id, item_id, qty FROM sales_order_items WHERE so_id = ?').all(soId) as { id: number; item_id: number; qty: number }[];
      for (const l of lines) {
        const avail = getTotalItemStock(db, l.item_id);
        const reserved = Math.min(avail, roundQty(l.qty));
        db.prepare('UPDATE sales_order_items SET reserved_qty = ? WHERE id = ?').run(reserved, l.id);
        if (reserved > 0) {
          db.prepare(
            "INSERT INTO stock_reservations (doc_type, doc_id, doc_number, item_id, warehouse_id, qty, status, created_at) VALUES ('SalesOrder', ?, ?, ?, ?, ?, 'Active', ?)"
          ).run(soId, so.so_number, l.item_id, so.warehouse_id, reserved, nowISO());
        }
      }

      db.prepare("UPDATE sales_orders SET status = 'Submitted', approval_status = 'Approved', submitted_at = ? WHERE id = ?").run(nowISO(), soId);
      recordAuditLog(db, req.user, 'SalesOrder', soId, so.so_number, 'Submit Sales Order', {});
      return { id: soId, so_number: so.so_number, status: 'Submitted' };
    });
    res.json(result);
  } catch (err: unknown) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Failed to submit sales order' });
  }
});

router.post('/orders/:id/cancel', requirePermission('sales', 'can_cancel'), (req: AuthRequest, res) => {
  const soId = Number(req.params.id);
  try {
    withTransaction((db) => {
      const so = db.prepare('SELECT id, so_number, status FROM sales_orders WHERE id = ?').get(soId) as { id: number; so_number: string; status: string } | undefined;
      if (!so) throw new Error('Sales Order not found');
      const dnCount = (db.prepare("SELECT COUNT(*) as c FROM delivery_notes WHERE so_id = ? AND status != 'Cancelled'").get(soId) as { c: number }).c;
      if (dnCount > 0) throw new Error('Cannot cancel Sales Order that already has Delivery Notes');
      const siCount = (db.prepare("SELECT COUNT(*) as c FROM sales_invoices WHERE so_id = ? AND status != 'Cancelled'").get(soId) as { c: number }).c;
      if (siCount > 0) throw new Error('Cannot cancel Sales Order that already has Sales Invoices');

      db.prepare("UPDATE stock_reservations SET status = 'Released' WHERE doc_type = 'SalesOrder' AND doc_id = ? AND status = 'Active'").run(soId);
      db.prepare("UPDATE sales_orders SET status = 'Cancelled', delivered_status = 'Cancelled', billed_status = 'Cancelled' WHERE id = ?").run(soId);
      recordAuditLog(db, req.user, 'SalesOrder', soId, so.so_number, 'Cancel Sales Order', {});
    });
    res.json({ ok: true });
  } catch (err: unknown) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Failed to cancel sales order' });
  }
});

router.post('/orders/:id/revise', requirePermission('sales', 'can_amend'), (req: AuthRequest, res) => {
  const soId = Number(req.params.id);
  try {
    const result = withTransaction((db) => {
      const orig = db.prepare('SELECT * FROM sales_orders WHERE id = ?').get(soId) as
        | {
            id: number;
            so_number: string;
            customer_id: number;
            sq_id: number | null;
            order_date: string;
            delivery_date: string;
            customer_ref: string;
            delivery_terms: string;
            delivery_place: string;
            payment_term_id: number | null;
            currency: string;
            exchange_rate: number;
            warehouse_id: number;
            price_list_id: number | null;
            subtotal: number;
            discount_amount: number;
            vat_amount: number;
            total_amount: number;
            status: string;
            remarks: string;
            amended_from?: string;
          }
        | undefined;
      if (!orig) throw new Error('Sales Order not found');
      if (orig.status === 'Cancelled') throw new Error('Cannot revise an already Cancelled Sales Order');

      const dnCount = (db.prepare("SELECT COUNT(*) as c FROM delivery_notes WHERE so_id = ? AND status != 'Cancelled'").get(soId) as { c: number }).c;
      if (dnCount > 0) throw new Error('Cannot revise Sales Order that already has Delivery Notes');
      const siCount = (db.prepare("SELECT COUNT(*) as c FROM sales_invoices WHERE so_id = ? AND status != 'Cancelled'").get(soId) as { c: number }).c;
      if (siCount > 0) throw new Error('Cannot revise Sales Order that already has Sales Invoices');

      const baseNumber = orig.amended_from ? orig.so_number.replace(/-\d+$/, '') : orig.so_number;
      const existing = db
        .prepare('SELECT so_number FROM sales_orders WHERE so_number LIKE ?')
        .all(`${baseNumber}-%`) as { so_number: string }[];
      let maxSuffix = 0;
      for (const row of existing) {
        const rest = row.so_number.slice(baseNumber.length + 1);
        if (/^\d+$/.test(rest)) maxSuffix = Math.max(maxSuffix, Number(rest));
      }
      const nextSuffix = maxSuffix + 1;
      const newSoNumber = `${baseNumber}-${nextSuffix}`;
      const revNo = `R${nextSuffix}`;
      const revDate = todayISO();

      db.prepare("UPDATE stock_reservations SET status = 'Released' WHERE doc_type = 'SalesOrder' AND doc_id = ? AND status = 'Active'").run(soId);
      db.prepare("UPDATE sales_orders SET status = 'Cancelled', delivered_status = 'Cancelled', billed_status = 'Cancelled' WHERE id = ?").run(soId);

      const origItems = db.prepare('SELECT * FROM sales_order_items WHERE so_id = ? ORDER BY id ASC').all(soId) as {
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
          `INSERT INTO sales_orders (so_number, customer_id, sq_id, order_date, delivery_date, customer_ref, delivery_terms, delivery_place, revision_no, revision_date, amended_from, payment_term_id, currency, exchange_rate, warehouse_id, price_list_id, subtotal, discount_amount, vat_amount, total_amount, status, approval_status, remarks, created_by, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Draft', 'Not Submitted', ?, ?, ?)`
        )
        .run(
          newSoNumber,
          orig.customer_id,
          orig.sq_id,
          todayISO(),
          orig.delivery_date,
          orig.customer_ref || '',
          orig.delivery_terms || '',
          orig.delivery_place || '',
          revNo,
          revDate,
          orig.so_number,
          orig.payment_term_id,
          orig.currency || 'AED',
          orig.exchange_rate || 1,
          orig.warehouse_id,
          orig.price_list_id,
          orig.subtotal,
          orig.discount_amount,
          orig.vat_amount,
          orig.total_amount,
          orig.remarks || '',
          req.user!.id,
          nowISO()
        );
      const newSoId = Number(r.lastInsertRowid);
      const ins = db.prepare(
        `INSERT INTO sales_order_items (so_id, item_id, description, qty, reserved_qty, uom, rate, discount_pct, vat_rate, vat_amount, line_total)
         VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?)`
      );
      for (const l of origItems) {
        ins.run(newSoId, l.item_id, l.description, l.qty, l.uom, l.rate, l.discount_pct, l.vat_rate, l.vat_amount, l.line_total);
      }

      recordAuditLog(db, req.user, 'SalesOrder', soId, orig.so_number, `Amended to ${newSoNumber}`, { amended_to: newSoNumber });
      recordAuditLog(db, req.user, 'SalesOrder', newSoId, newSoNumber, `Created Revision ${revNo} from ${orig.so_number}`, {
        amended_from: orig.so_number,
      });

      return { id: newSoId, so_number: newSoNumber, amended_from: orig.so_number, revision_no: revNo };
    });
    res.status(201).json(result);
  } catch (err: unknown) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Failed to revise sales order' });
  }
});

// ---------------- DELIVERY NOTES ----------------
router.get('/delivery-notes', requirePermission('sales', 'can_view'), (_req, res) => {
  const db = getDb();
  const list = db
    .prepare(
      `SELECT dn.*, c.name as customer_name, c.address as customer_address, c.country as customer_country,
              c.trn as customer_trn, c.contact_person as customer_contact_person,
              so.so_number, w.name as warehouse_name, cr.full_name as creator_name
       FROM delivery_notes dn
       JOIN customers c ON c.id = dn.customer_id
       LEFT JOIN sales_orders so ON so.id = dn.so_id
       JOIN warehouses w ON w.id = dn.warehouse_id
       LEFT JOIN users cr ON cr.id = dn.created_by
       ORDER BY dn.id DESC`
    )
    .all() as Record<string, unknown>[];
  const items = db
    .prepare('SELECT dni.*, i.item_code, i.name as item_name FROM delivery_note_items dni JOIN items i ON i.id = dni.item_id')
    .all() as { dn_id: number }[];
  res.json({ items: list.map((d) => ({ ...d, items: items.filter((it) => it.dn_id === Number(d.id)) })) });
});

router.post('/delivery-notes', requirePermission('sales', 'can_create'), (req: AuthRequest, res) => {
  const b = req.body as {
    so_id?: number;
    customer_id: number;
    delivery_date?: string;
    warehouse_id: number;
    vehicle_number?: string;
    driver_name?: string;
    customer_signature?: string;
    remarks?: string;
    items: { so_item_id?: number; item_id: number; batch_number?: string; qty: number; uom?: string }[];
  };
  if (!b.customer_id || !b.warehouse_id || !Array.isArray(b.items) || b.items.length === 0) {
    res.status(400).json({ error: 'Customer, warehouse, and delivery items are required' });
    return;
  }

  try {
    const result = withTransaction((db) => {
      const dnNumber = getNextDocumentNumber(db, 'DN');
      const dDate = b.delivery_date || todayISO();
      const r = db
        .prepare(
          `INSERT INTO delivery_notes (dn_number, so_id, customer_id, delivery_date, warehouse_id, vehicle_number, driver_name, customer_signature, status, remarks, created_by, submitted_at, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'Submitted', ?, ?, ?, ?)`
        )
        .run(
          dnNumber,
          b.so_id || null,
          b.customer_id,
          dDate,
          b.warehouse_id,
          b.vehicle_number || '',
          b.driver_name || '',
          b.customer_signature || '',
          b.remarks || '',
          req.user!.id,
          nowISO(),
          nowISO()
        );
      const dnId = Number(r.lastInsertRowid);
      const ins = db.prepare('INSERT INTO delivery_note_items (dn_id, so_item_id, item_id, batch_id, batch_number, qty, uom, unit_cost) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');

      let totalCogs = 0;
      for (const l of b.items) {
        const item = db.prepare('SELECT sales_uom FROM items WHERE id = ?').get(l.item_id) as { sales_uom: string };
        const mov = postStockMovement(db, {
          postingDate: dDate,
          docType: 'DeliveryNote',
          docId: dnId,
          docNumber: dnNumber,
          itemId: l.item_id,
          warehouseId: b.warehouse_id,
          batchNumber: l.batch_number,
          outwardQty: l.qty,
          remarks: `Delivery Note ${dnNumber}`,
          userId: req.user!.id,
        });
        totalCogs = roundMoney(totalCogs + l.qty * mov.unitCost);
        ins.run(dnId, l.so_item_id || null, l.item_id, mov.batchId, l.batch_number || '', roundQty(l.qty), l.uom || item.sales_uom, mov.unitCost);

        if (l.so_item_id) {
          db.prepare('UPDATE sales_order_items SET delivered_qty = ROUND(delivered_qty + ?, 4) WHERE id = ?').run(l.qty, l.so_item_id);
        }
      }

      if (b.so_id) {
        const soItems = db.prepare('SELECT qty, delivered_qty FROM sales_order_items WHERE so_id = ?').all(b.so_id) as { qty: number; delivered_qty: number }[];
        const allDel = soItems.every((i) => i.delivered_qty >= i.qty - 0.0001);
        db.prepare('UPDATE sales_orders SET delivered_status = ?, status = ? WHERE id = ?').run(
          allDel ? 'Delivered' : 'Partially Delivered',
          allDel ? 'Delivered' : 'Partially Delivered',
          b.so_id
        );
        db.prepare("UPDATE stock_reservations SET status = 'Consumed' WHERE doc_type = 'SalesOrder' AND doc_id = ?").run(b.so_id);
      }

      // Post COGS Accounting Entry (DR 5100 COGS / CR 1320 Finished Goods Inventory)
      if (totalCogs > 0) {
        postJournalEntry(db, {
          postingDate: dDate,
          entryType: 'Delivery COGS',
          refDocType: 'DeliveryNote',
          refDocId: dnId,
          refDocNumber: dnNumber,
          narration: `COGS on Delivery Note ${dnNumber}`,
          lines: [
            { accountCode: '5100', debit: totalCogs, description: `Cost of goods delivered (${dnNumber})` },
            { accountCode: '1320', credit: totalCogs, description: `Finished lubricants dispatched (${dnNumber})` },
          ],
          userId: req.user!.id,
        });
      }

      recordAuditLog(db, req.user, 'DeliveryNote', dnId, dnNumber, 'Submit Delivery Note', { totalCogs });
      return { id: dnId, dn_number: dnNumber, total_cogs: totalCogs };
    });
    res.status(201).json(result);
  } catch (err: unknown) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Failed to create delivery note' });
  }
});

// ---------------- SALES INVOICES ----------------
router.get('/invoices', requirePermission('sales', 'can_view'), (_req, res) => {
  const db = getDb();
  const list = db
    .prepare(
      `SELECT si.*, c.name as customer_name, c.code as customer_code,
              c.address as customer_address, c.country as customer_country, c.trn as customer_trn,
              c.contact_person as customer_contact_person, c.telephone as customer_telephone,
              so.so_number, dn.dn_number, pt.name as payment_term_name,
              cr.full_name as creator_name, ps.full_name as approver_name
       FROM sales_invoices si
       JOIN customers c ON c.id = si.customer_id
       LEFT JOIN sales_orders so ON so.id = si.so_id
       LEFT JOIN delivery_notes dn ON dn.id = si.dn_id
       LEFT JOIN payment_terms pt ON pt.id = si.payment_term_id
       LEFT JOIN users cr ON cr.id = si.created_by
       LEFT JOIN users ps ON ps.id = si.posted_by
       ORDER BY si.id DESC`
    )
    .all() as Record<string, unknown>[];
  const items = db
    .prepare('SELECT sii.*, i.item_code, i.name as item_name FROM sales_invoice_items sii JOIN items i ON i.id = sii.item_id')
    .all() as { si_id: number }[];
  const schedules = db.prepare("SELECT * FROM payment_schedules WHERE doc_type = 'SalesInvoice' ORDER BY installment_no ASC").all() as { doc_id: number }[];

  res.json({
    items: list.map((inv) => ({
      ...inv,
      items: items.filter((it) => it.si_id === Number(inv.id)),
      payment_schedules: schedules.filter((ps) => ps.doc_id === Number(inv.id)),
    })),
  });
});

router.post('/invoices', requirePermission('sales', 'can_create'), (req: AuthRequest, res) => {
  const b = req.body as {
    customer_id: number;
    so_id?: number;
    dn_id?: number;
    customer_invoice_ref?: string;
    invoice_date?: string;
    due_date?: string;
    delivery_terms?: string;
    delivery_place?: string;
    revision_no?: string;
    revision_date?: string;
    currency?: string;
    exchange_rate?: number;
    payment_term_id?: number;
    freight_amount?: number;
    remarks?: string;
    post_now?: boolean;
    items: { so_item_id?: number; item_id: number; qty: number; rate: number; discount_pct?: number; vat_rate?: number; tax_category?: string }[];
  };
  if (!b.customer_id || !Array.isArray(b.items) || b.items.length === 0) {
    res.status(400).json({ error: 'Customer and invoice items are required' });
    return;
  }

  try {
    const result = withTransaction((db) => {
      const cust = db.prepare('SELECT address FROM customers WHERE id = ?').get(b.customer_id) as { address?: string } | undefined;
      const siNumber = getNextDocumentNumber(db, 'SI');
      const invDate = b.invoice_date || todayISO();
      let subtotal = 0;
      let discTotal = 0;
      let vatTotal = 0;
      const lines = b.items.map((l) => {
        const item = db.prepare('SELECT name, sales_uom, vat_rate, tax_category FROM items WHERE id = ?').get(l.item_id) as {
          name: string;
          sales_uom: string;
          vat_rate: number;
          tax_category: string;
        };
        const gross = roundMoney(l.qty * l.rate);
        const disc = roundMoney((gross * (l.discount_pct || 0)) / 100);
        const net = roundMoney(gross - disc);
        const taxCat = l.tax_category || item.tax_category || 'Standard Rated';
        const vatRate = taxCat === 'Standard Rated' ? l.vat_rate ?? item.vat_rate ?? 5 : 0;
        const vatAmt = roundMoney((net * vatRate) / 100);
        subtotal = roundMoney(subtotal + net);
        discTotal = roundMoney(discTotal + disc);
        vatTotal = roundMoney(vatTotal + vatAmt);
        return { ...l, name: item.name, uom: item.sales_uom, taxCat, vatRate, vatAmt, total: roundMoney(net + vatAmt) };
      });
      const freight = roundMoney(b.freight_amount || 0);
      const grandTotal = roundMoney(subtotal + vatTotal + freight);

      const r = db
        .prepare(
          `INSERT INTO sales_invoices (si_number, customer_invoice_ref, invoice_date, due_date, delivery_terms, delivery_place, revision_no, revision_date, customer_id, so_id, dn_id, currency, exchange_rate, payment_term_id, subtotal, discount_amount, freight_amount, vat_amount, total_amount, paid_amount, outstanding_amount, status, remarks, created_by, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, 'Draft', ?, ?, ?)`
        )
        .run(
          siNumber,
          b.customer_invoice_ref || siNumber,
          invDate,
          b.due_date || addDaysISO(invDate, 30),
          b.delivery_terms || '',
          b.delivery_place || cust?.address || '',
          b.revision_no || 'Original',
          b.revision_date || '',
          b.customer_id,
          b.so_id || null,
          b.dn_id || null,
          b.currency || 'AED',
          b.exchange_rate || 1,
          b.payment_term_id || null,
          subtotal,
          discTotal,
          freight,
          vatTotal,
          grandTotal,
          grandTotal,
          b.remarks || '',
          req.user!.id,
          nowISO()
        );
      const siId = Number(r.lastInsertRowid);
      const ins = db.prepare(
        'INSERT INTO sales_invoice_items (si_id, so_item_id, item_id, description, qty, uom, rate, discount_pct, vat_rate, tax_category, vat_amount, line_total) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
      );
      for (const l of lines) {
        ins.run(siId, l.so_item_id || null, l.item_id, l.name, roundQty(l.qty), l.uom, roundMoney(l.rate), l.discount_pct || 0, l.vatRate, l.taxCat, l.vatAmt, l.total);
        if (l.so_item_id) db.prepare('UPDATE sales_order_items SET billed_qty = ROUND(billed_qty + ?, 4) WHERE id = ?').run(l.qty, l.so_item_id);
      }

      if (b.post_now !== false) {
        postSalesInvoiceInternal(db, siId, req.user!);
      }
      return { id: siId, si_number: siNumber, total_amount: grandTotal };
    });
    res.status(201).json(result);
  } catch (err: unknown) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Failed to create sales invoice' });
  }
});

function postSalesInvoiceInternal(db: ReturnType<typeof getDb>, siId: number, user: NonNullable<AuthRequest['user']>) {
  const si = db.prepare('SELECT * FROM sales_invoices WHERE id = ?').get(siId) as
    | {
        id: number;
        si_number: string;
        invoice_date: string;
        customer_id: number;
        so_id: number | null;
        currency: string;
        exchange_rate: number;
        payment_term_id: number | null;
        subtotal: number;
        freight_amount: number;
        vat_amount: number;
        total_amount: number;
        status: string;
      }
    | undefined;
  if (!si) throw new Error('Sales invoice not found');
  if (si.status === 'Posted') throw new Error('Sales invoice already posted');

  const fx = si.exchange_rate || 1;
  const lines: JournalLineInput[] = [
    {
      accountCode: '1200',
      partyType: 'Customer',
      partyId: si.customer_id,
      debit: si.total_amount,
      currency: si.currency,
      exchangeRate: fx,
      description: `Accounts Receivable (${si.si_number})`,
    },
    {
      accountCode: '4100',
      credit: roundMoney(si.subtotal + si.freight_amount),
      currency: si.currency,
      exchangeRate: fx,
      description: `Lubricant Sales Revenue (${si.si_number})`,
    },
  ];
  if (si.vat_amount > 0) {
    lines.push({
      accountCode: '2200',
      partyType: '',
      partyId: 0,
      credit: si.vat_amount,
      currency: si.currency,
      exchangeRate: fx,
      description: `VAT Output 5% (${si.si_number})`,
    });
  }

  const je = postJournalEntry(db, {
    postingDate: si.invoice_date,
    entryType: 'Sales Invoice',
    refDocType: 'SalesInvoice',
    refDocId: si.id,
    refDocNumber: si.si_number,
    narration: `Post Sales Invoice ${si.si_number}`,
    lines: lines.map((l) => ({ ...l, partyId: l.partyId || null })),
    userId: user.id,
  });

  generatePaymentSchedules(db, {
    partyType: 'Customer',
    partyId: si.customer_id,
    docType: 'SalesInvoice',
    docId: si.id,
    docNumber: si.si_number,
    baseDate: si.invoice_date,
    totalAmount: si.total_amount,
    paymentTermId: si.payment_term_id,
  });

  if (si.so_id) {
    db.prepare("UPDATE sales_orders SET billed_status = 'Billed', status = 'Completed' WHERE id = ?").run(si.so_id);
  }

  db.prepare("UPDATE sales_invoices SET status = 'Posted', posted_by = ?, posted_at = ? WHERE id = ?").run(user.id, nowISO(), siId);
  recordAuditLog(db, user, 'SalesInvoice', siId, si.si_number, 'Post Sales Invoice', { je_number: je.jeNumber });
  return je;
}

router.post('/invoices/:id/post', requirePermission('accounting', 'can_submit'), (req: AuthRequest, res) => {
  try {
    const je = withTransaction((db) => postSalesInvoiceInternal(db, Number(req.params.id), req.user!));
    res.json({ ok: true, je_number: je.jeNumber });
  } catch (err: unknown) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Failed to post sales invoice' });
  }
});

// ---------------- SALES RETURNS ----------------
router.get('/returns', requirePermission('sales', 'can_view'), (_req, res) => {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT sr.*, c.name as customer_name, c.address as customer_address, c.country as customer_country,
              c.trn as customer_trn, c.contact_person as customer_contact_person,
              w.name as warehouse_name, cr.full_name as creator_name
       FROM sales_returns sr
       JOIN customers c ON c.id = sr.customer_id
       JOIN warehouses w ON w.id = sr.warehouse_id
       LEFT JOIN users cr ON cr.id = sr.created_by
       ORDER BY sr.id DESC`
    )
    .all() as Record<string, unknown>[];
  const items = db
    .prepare('SELECT sri.*, i.item_code, i.name as item_name FROM sales_return_items sri JOIN items i ON i.id = sri.item_id')
    .all() as { sr_id: number }[];
  res.json({ items: rows.map((r) => ({ ...r, items: items.filter((it) => it.sr_id === Number(r.id)) })) });
});

router.post('/returns', requirePermission('sales', 'can_create'), (req: AuthRequest, res) => {
  const b = req.body as {
    customer_id: number;
    dn_id?: number;
    si_id?: number;
    warehouse_id: number;
    return_date?: string;
    reason: string;
    items: { item_id: number; batch_number?: string; qty: number; rate: number; vat_rate?: number }[];
  };
  if (!b.customer_id || !b.warehouse_id || !b.reason || !Array.isArray(b.items) || b.items.length === 0) {
    res.status(400).json({ error: 'Customer, warehouse, reason, and items are required' });
    return;
  }
  try {
    const result = withTransaction((db) => {
      const srNumber = getNextDocumentNumber(db, 'SR');
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
          `INSERT INTO sales_returns (sr_number, return_date, customer_id, dn_id, si_id, warehouse_id, reason, total_amount, status, created_by, submitted_at, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'Submitted', ?, ?, ?)`
        )
        .run(srNumber, rDate, b.customer_id, b.dn_id || null, b.si_id || null, b.warehouse_id, b.reason, grandTotal, req.user!.id, nowISO(), nowISO());
      const srId = Number(r.lastInsertRowid);

      const ins = db.prepare(
        'INSERT INTO sales_return_items (sr_id, item_id, batch_id, batch_number, qty, uom, rate, vat_amount, line_total) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
      );
      let cogsRev = 0;
      for (const l of lines) {
        const item = db.prepare('SELECT sales_uom, average_cost FROM items WHERE id = ?').get(l.item_id) as { sales_uom: string; average_cost: number };
        const mov = postStockMovement(db, {
          postingDate: rDate,
          docType: 'SalesReturn',
          docId: srId,
          docNumber: srNumber,
          itemId: l.item_id,
          warehouseId: b.warehouse_id,
          batchNumber: l.batch_number,
          inwardQty: l.qty,
          unitCost: item.average_cost,
          qcStatus: 'Pending',
          isOnHold: true,
          remarks: `Sales Return: ${b.reason}`,
          userId: req.user!.id,
        });
        cogsRev = roundMoney(cogsRev + l.qty * item.average_cost);
        ins.run(srId, l.item_id, mov.batchId, l.batch_number || '', roundQty(l.qty), item.sales_uom, roundMoney(l.rate), l.vat, l.lineTotal);
      }

      postJournalEntry(db, {
        postingDate: rDate,
        entryType: 'Credit Note',
        refDocType: 'SalesReturn',
        refDocId: srId,
        refDocNumber: srNumber,
        narration: `Sales Return Credit Note ${srNumber}: ${b.reason}`,
        lines: [
          { accountCode: '4200', debit: netTotal, description: `Sales Return (${srNumber})` },
          { accountCode: '2200', debit: vatTotal, description: `VAT Output reversed (${srNumber})` },
          { accountCode: '1200', partyType: 'Customer', partyId: b.customer_id, credit: grandTotal, description: `Customer Credit Note (${srNumber})` },
        ],
        userId: req.user!.id,
      });

      if (cogsRev > 0) {
        postJournalEntry(db, {
          postingDate: rDate,
          entryType: 'Sales Return Inventory',
          refDocType: 'SalesReturn',
          refDocId: srId,
          refDocNumber: srNumber,
          narration: `Inventory restored from Sales Return ${srNumber}`,
          lines: [
            { accountCode: '1320', debit: cogsRev, description: `Returned goods inventory` },
            { accountCode: '5100', credit: cogsRev, description: `COGS reversed` },
          ],
          userId: req.user!.id,
        });
      }

      if (b.si_id) {
        db.prepare('UPDATE sales_invoices SET outstanding_amount = MAX(0, ROUND(outstanding_amount - ?, 2)) WHERE id = ?').run(grandTotal, b.si_id);
      }
      recordAuditLog(db, req.user, 'SalesReturn', srId, srNumber, 'Submit Sales Return', { total: grandTotal });
      return { id: srId, sr_number: srNumber, total_amount: grandTotal };
    });
    res.status(201).json(result);
  } catch (err: unknown) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Failed to create sales return' });
  }
});

export default router;
