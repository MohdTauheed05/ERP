import fs from 'fs';
import path from 'path';
import multer from 'multer';
import { Router } from 'express';
import { DB_FILE_PATH, getDb, resetDbConnection, withTransaction } from '../db.ts';
import { authenticate, recordAuditLog, requirePermission, type AuthRequest } from '../middleware/auth.ts';
import { nowISO, roundMoney, safeResolveWithin, todayISO } from '../utils/helpers.ts';
import { postVoucherInternal } from './accounting.ts';

const UPLOAD_DIR = path.resolve(process.cwd(), process.env.UPLOAD_DIR || './uploads');
const BACKUP_DIR = path.resolve(process.cwd(), process.env.BACKUP_DIR || './backups');
const MAX_UPLOAD_BYTES = (Number(process.env.MAX_UPLOAD_MB) || 25) * 1024 * 1024;

const ALLOWED_MIME = new Set([
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/webp',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-excel',
  'text/csv',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/msword',
]);

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => {
      fs.mkdirSync(UPLOAD_DIR, { recursive: true });
      cb(null, UPLOAD_DIR);
    },
    filename: (_req, file, cb) => {
      const safeOrig = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
      cb(null, `${Date.now()}_${Math.random().toString(36).slice(2, 8)}_${safeOrig}`);
    },
  }),
  limits: { fileSize: MAX_UPLOAD_BYTES },
  fileFilter: (_req, file, cb) => {
    if (ALLOWED_MIME.has(file.mimetype)) cb(null, true);
    else cb(new Error('Unsupported file type. Allowed: PDF, Excel, CSV, Word, PNG, JPEG, WebP'));
  },
});

const router = Router();
router.use(authenticate);

// ---------------- REAL-TIME DASHBOARD ----------------
router.get('/dashboard', requirePermission('dashboard', 'can_view'), (_req, res) => {
  const db = getDb();
  const today = todayISO();

  const totalPurchase = (db.prepare("SELECT COALESCE(SUM(total_amount * exchange_rate), 0) as v FROM purchase_invoices WHERE status = 'Posted'").get() as { v: number }).v;
  const totalSales = (db.prepare("SELECT COALESCE(SUM(total_amount * exchange_rate), 0) as v FROM sales_invoices WHERE status = 'Posted'").get() as { v: number }).v;

  const latestStock = db
    .prepare(
      `SELECT sl.stock_value, w.warehouse_type, c.name as category_name
       FROM stock_ledger sl
       INNER JOIN (SELECT item_id, warehouse_id, MAX(id) as max_id FROM stock_ledger GROUP BY item_id, warehouse_id) l ON l.max_id = sl.id
       JOIN warehouses w ON w.id = sl.warehouse_id
       JOIN items i ON i.id = sl.item_id
       JOIN item_categories c ON c.id = i.category_id`
    )
    .all() as { stock_value: number; warehouse_type: string; category_name: string }[];

  const inventoryValuation = roundMoney(latestStock.reduce((s, r) => s + r.stock_value, 0));
  const rawMaterialStock = roundMoney(latestStock.filter((r) => ['Raw Material', 'Packaging'].includes(r.warehouse_type)).reduce((s, r) => s + r.stock_value, 0));
  const finishedGoodsStock = roundMoney(latestStock.filter((r) => r.warehouse_type === 'Finished Goods').reduce((s, r) => s + r.stock_value, 0));

  const pendingPOs = (db.prepare("SELECT COUNT(*) as c FROM purchase_orders WHERE status IN ('Draft', 'Pending Approval', 'Submitted', 'Partially Received')").get() as { c: number }).c;
  const pendingSOs = (db.prepare("SELECT COUNT(*) as c FROM sales_orders WHERE status IN ('Draft', 'Submitted', 'Partially Delivered')").get() as { c: number }).c;
  const prodInProgress = (db.prepare("SELECT COUNT(*) as c FROM production_orders WHERE status IN ('Draft', 'Planned', 'In Progress')").get() as { c: number }).c;
  const supplierOutstanding = (db.prepare("SELECT COALESCE(SUM(outstanding_amount * exchange_rate), 0) as v FROM purchase_invoices WHERE status = 'Posted'").get() as { v: number }).v;
  const customerOutstanding = (db.prepare("SELECT COALESCE(SUM(outstanding_amount * exchange_rate), 0) as v FROM sales_invoices WHERE status = 'Posted'").get() as { v: number }).v;
  const overdueInvoices = (db.prepare("SELECT COUNT(*) as c FROM payment_schedules WHERE outstanding_amount > 0 AND due_date < ?").get(today) as { c: number }).c;
  const pendingApprovals = (db.prepare("SELECT COUNT(*) as c FROM approval_requests WHERE status = 'Pending'").get() as { c: number }).c;

  // Low stock count
  const items = db.prepare('SELECT id, reorder_level FROM items WHERE is_active = 1 AND reorder_level > 0').all() as { id: number; reorder_level: number }[];
  let lowStockAlerts = 0;
  for (const it of items) {
    const qty =
      (
        db
          .prepare(
            `SELECT COALESCE(SUM(sl.closing_qty), 0) as q FROM stock_ledger sl
             INNER JOIN (SELECT warehouse_id, MAX(id) as max_id FROM stock_ledger WHERE item_id = ? GROUP BY warehouse_id) m ON m.max_id = sl.id`
          )
          .get(it.id) as { q: number }
      ).q || 0;
    if (qty <= it.reorder_level) lowStockAlerts++;
  }

  // Monthly Charts
  const monthlySales = db
    .prepare("SELECT substr(invoice_date, 1, 7) as month, ROUND(SUM(total_amount * exchange_rate), 2) as amount FROM sales_invoices WHERE status = 'Posted' GROUP BY substr(invoice_date, 1, 7) ORDER BY month ASC")
    .all() as { month: string; amount: number }[];
  const monthlyPurchases = db
    .prepare("SELECT substr(invoice_date, 1, 7) as month, ROUND(SUM(total_amount * exchange_rate), 2) as amount FROM purchase_invoices WHERE status = 'Posted' GROUP BY substr(invoice_date, 1, 7) ORDER BY month ASC")
    .all() as { month: string; amount: number }[];
  const monthlyProduction = db
    .prepare("SELECT substr(scheduled_date, 1, 7) as month, ROUND(SUM(completed_qty), 2) as qty FROM production_orders WHERE status = 'Completed' GROUP BY substr(scheduled_date, 1, 7) ORDER BY month ASC")
    .all();

  const monthsSet = Array.from(new Set([...monthlySales.map((m) => m.month), ...monthlyPurchases.map((m) => m.month)])).sort();
  const salesVsPurchase = monthsSet.map((m) => ({
    month: m,
    sales: monthlySales.find((x) => x.month === m)?.amount || 0,
    purchases: monthlyPurchases.find((x) => x.month === m)?.amount || 0,
  }));

  const stockByCategoryMap: Record<string, number> = {};
  for (const r of latestStock) {
    stockByCategoryMap[r.category_name] = roundMoney((stockByCategoryMap[r.category_name] || 0) + r.stock_value);
  }
  const stockByCategory = Object.entries(stockByCategoryMap).map(([category, value]) => ({ category, value }));

  const topCustomers = db
    .prepare("SELECT c.name, ROUND(SUM(si.total_amount * si.exchange_rate), 2) as total FROM sales_invoices si JOIN customers c ON c.id = si.customer_id WHERE si.status = 'Posted' GROUP BY c.id ORDER BY total DESC LIMIT 5")
    .all();
  const topSuppliers = db
    .prepare("SELECT s.name, ROUND(SUM(pi.total_amount * pi.exchange_rate), 2) as total FROM purchase_invoices pi JOIN suppliers s ON s.id = pi.supplier_id WHERE pi.status = 'Posted' GROUP BY s.id ORDER BY total DESC LIMIT 5")
    .all();

  const recentAudit = db.prepare('SELECT * FROM audit_logs ORDER BY id DESC LIMIT 12').all();

  res.json({
    kpis: {
      totalPurchase: roundMoney(totalPurchase),
      totalSales: roundMoney(totalSales),
      inventoryValuation,
      rawMaterialStock,
      finishedGoodsStock,
      pendingPOs,
      pendingSOs,
      prodInProgress,
      supplierOutstanding: roundMoney(supplierOutstanding),
      customerOutstanding: roundMoney(customerOutstanding),
      lowStockAlerts,
      overdueInvoices,
      pendingApprovals,
    },
    charts: {
      salesVsPurchase,
      monthlyProduction,
      stockByCategory,
      topCustomers,
      topSuppliers,
    },
    recentAudit,
  });
});

// ---------------- GLOBAL SEARCH ----------------
router.get('/search', (req, res) => {
  const q = String(req.query.q || '').trim();
  if (!q) {
    res.json({ results: [] });
    return;
  }
  const like = `%${q}%`;
  const db = getDb();
  const results: { type: string; id: number; number: string; title: string; subtitle: string; module: string }[] = [];

  for (const r of db.prepare('SELECT id, item_code, name, brand FROM items WHERE item_code LIKE ? OR name LIKE ? OR brand LIKE ? LIMIT 8').all(like, like, like) as { id: number; item_code: string; name: string; brand: string }[]) {
    results.push({ type: 'Item', id: r.id, number: r.item_code, title: r.name, subtitle: r.brand || 'Item Master', module: 'masters' });
  }
  for (const r of db.prepare('SELECT id, code, name FROM suppliers WHERE code LIKE ? OR name LIKE ? LIMIT 6').all(like, like) as { id: number; code: string; name: string }[]) {
    results.push({ type: 'Supplier', id: r.id, number: r.code, title: r.name, subtitle: 'Supplier Master', module: 'masters' });
  }
  for (const r of db.prepare('SELECT id, code, name FROM customers WHERE code LIKE ? OR name LIKE ? LIMIT 6').all(like, like) as { id: number; code: string; name: string }[]) {
    results.push({ type: 'Customer', id: r.id, number: r.code, title: r.name, subtitle: 'Customer Master', module: 'masters' });
  }
  for (const r of db.prepare('SELECT id, po_number, status, total_amount FROM purchase_orders WHERE po_number LIKE ? LIMIT 6').all(like) as { id: number; po_number: string; status: string; total_amount: number }[]) {
    results.push({ type: 'Purchase Order', id: r.id, number: r.po_number, title: `${r.po_number} (${r.status})`, subtitle: `AED ${r.total_amount}`, module: 'procurement' });
  }
  for (const r of db.prepare('SELECT id, grn_number, status FROM purchase_receipts WHERE grn_number LIKE ? LIMIT 6').all(like) as { id: number; grn_number: string; status: string }[]) {
    results.push({ type: 'Purchase Receipt', id: r.id, number: r.grn_number, title: `${r.grn_number} (${r.status})`, subtitle: 'Goods Receipt Note', module: 'procurement' });
  }
  for (const r of db.prepare('SELECT id, pi_number, supplier_invoice_number, status FROM purchase_invoices WHERE pi_number LIKE ? OR supplier_invoice_number LIKE ? LIMIT 6').all(like, like) as { id: number; pi_number: string; supplier_invoice_number: string; status: string }[]) {
    results.push({ type: 'Purchase Invoice', id: r.id, number: r.pi_number, title: `${r.pi_number} (${r.supplier_invoice_number})`, subtitle: r.status, module: 'procurement' });
  }
  for (const r of db.prepare('SELECT id, so_number, status FROM sales_orders WHERE so_number LIKE ? LIMIT 6').all(like) as { id: number; so_number: string; status: string }[]) {
    results.push({ type: 'Sales Order', id: r.id, number: r.so_number, title: `${r.so_number} (${r.status})`, subtitle: 'Sales Order', module: 'sales' });
  }
  for (const r of db.prepare('SELECT id, si_number, status FROM sales_invoices WHERE si_number LIKE ? LIMIT 6').all(like) as { id: number; si_number: string; status: string }[]) {
    results.push({ type: 'Sales Invoice', id: r.id, number: r.si_number, title: `${r.si_number} (${r.status})`, subtitle: 'Sales Invoice', module: 'sales' });
  }
  for (const r of db.prepare('SELECT id, prod_number, status FROM production_orders WHERE prod_number LIKE ? LIMIT 6').all(like) as { id: number; prod_number: string; status: string }[]) {
    results.push({ type: 'Production Order', id: r.id, number: r.prod_number, title: `${r.prod_number} (${r.status})`, subtitle: 'Manufacturing', module: 'manufacturing' });
  }
  for (const r of db.prepare('SELECT id, batch_number, qc_status FROM stock_batches WHERE batch_number LIKE ? LIMIT 6').all(like) as { id: number; batch_number: string; qc_status: string }[]) {
    results.push({ type: 'Batch', id: r.id, number: r.batch_number, title: r.batch_number, subtitle: `QC: ${r.qc_status}`, module: 'manufacturing' });
  }

  res.json({ results });
});

// ---------------- DOCUMENT LINKING ----------------
router.get('/links/:docType/:docId', (req, res) => {
  const db = getDb();
  const { docType, docId } = req.params;
  const id = Number(docId);
  const links: { docType: string; id: number; docNumber: string; status: string; relation: string }[] = [];

  if (docType === 'MaterialRequest') {
    for (const pr of db.prepare('SELECT id, pr_number, status FROM purchase_requisitions WHERE mr_id = ?').all(id) as { id: number; pr_number: string; status: string }[]) {
      links.push({ docType: 'PurchaseRequisition', id: pr.id, docNumber: pr.pr_number, status: pr.status, relation: 'Purchase Requisition' });
    }
  } else if (docType === 'PurchaseRequisition') {
    const prRow = db.prepare('SELECT mr_id FROM purchase_requisitions WHERE id = ?').get(id) as { mr_id: number | null } | undefined;
    if (prRow?.mr_id) {
      const mr = db.prepare('SELECT id, mr_number, status FROM material_requests WHERE id = ?').get(prRow.mr_id) as { id: number; mr_number: string; status: string } | undefined;
      if (mr) links.push({ docType: 'MaterialRequest', id: mr.id, docNumber: mr.mr_number, status: mr.status, relation: 'Source Material Request' });
    }
    for (const rfq of db.prepare('SELECT id, rfq_number, status FROM rfqs WHERE pr_id = ?').all(id) as { id: number; rfq_number: string; status: string }[]) {
      links.push({ docType: 'RFQ', id: rfq.id, docNumber: rfq.rfq_number, status: rfq.status, relation: 'Request for Quotation' });
    }
    for (const po of db.prepare('SELECT id, po_number, status FROM purchase_orders WHERE pr_id = ?').all(id) as { id: number; po_number: string; status: string }[]) {
      links.push({ docType: 'PurchaseOrder', id: po.id, docNumber: po.po_number, status: po.status, relation: 'Purchase Order' });
    }
  } else if (docType === 'RFQ') {
    const rfqRow = db.prepare('SELECT pr_id FROM rfqs WHERE id = ?').get(id) as { pr_id: number | null } | undefined;
    if (rfqRow?.pr_id) {
      const pr = db.prepare('SELECT id, pr_number, status FROM purchase_requisitions WHERE id = ?').get(rfqRow.pr_id) as { id: number; pr_number: string; status: string } | undefined;
      if (pr) links.push({ docType: 'PurchaseRequisition', id: pr.id, docNumber: pr.pr_number, status: pr.status, relation: 'Source Requisition' });
    }
    for (const sq of db.prepare('SELECT id, sq_number, status FROM supplier_quotations WHERE rfq_id = ?').all(id) as { id: number; sq_number: string; status: string }[]) {
      links.push({ docType: 'SupplierQuotation', id: sq.id, docNumber: sq.sq_number, status: sq.status, relation: 'Supplier Quotation' });
    }
  } else if (docType === 'SupplierQuotation') {
    const sqRow = db.prepare('SELECT rfq_id FROM supplier_quotations WHERE id = ?').get(id) as { rfq_id: number | null } | undefined;
    if (sqRow?.rfq_id) {
      const rfq = db.prepare('SELECT id, rfq_number, status FROM rfqs WHERE id = ?').get(sqRow.rfq_id) as { id: number; rfq_number: string; status: string } | undefined;
      if (rfq) links.push({ docType: 'RFQ', id: rfq.id, docNumber: rfq.rfq_number, status: rfq.status, relation: 'Source RFQ' });
    }
    for (const po of db.prepare('SELECT id, po_number, status FROM purchase_orders WHERE sq_id = ?').all(id) as { id: number; po_number: string; status: string }[]) {
      links.push({ docType: 'PurchaseOrder', id: po.id, docNumber: po.po_number, status: po.status, relation: 'Purchase Order' });
    }
  } else if (docType === 'PurchaseOrder') {
    const poRow = db.prepare('SELECT po_number, amended_from, sq_id, pr_id FROM purchase_orders WHERE id = ?').get(id) as
      | { po_number: string; amended_from: string; sq_id: number | null; pr_id: number | null }
      | undefined;
    if (poRow?.amended_from) {
      const prev = db.prepare('SELECT id, po_number, status FROM purchase_orders WHERE po_number = ?').get(poRow.amended_from) as { id: number; po_number: string; status: string } | undefined;
      if (prev) links.push({ docType: 'PurchaseOrder', id: prev.id, docNumber: prev.po_number, status: prev.status, relation: 'Amended From' });
    }
    if (poRow?.po_number) {
      for (const nextPo of db.prepare('SELECT id, po_number, status FROM purchase_orders WHERE amended_from = ?').all(poRow.po_number) as { id: number; po_number: string; status: string }[]) {
        links.push({ docType: 'PurchaseOrder', id: nextPo.id, docNumber: nextPo.po_number, status: nextPo.status, relation: 'Revised To' });
      }
    }
    if (poRow?.sq_id) {
      const sq = db.prepare('SELECT id, sq_number, status FROM supplier_quotations WHERE id = ?').get(poRow.sq_id) as { id: number; sq_number: string; status: string } | undefined;
      if (sq) links.push({ docType: 'SupplierQuotation', id: sq.id, docNumber: sq.sq_number, status: sq.status, relation: 'Supplier Quotation' });
    }
    if (poRow?.pr_id) {
      const pr = db.prepare('SELECT id, pr_number, status FROM purchase_requisitions WHERE id = ?').get(poRow.pr_id) as { id: number; pr_number: string; status: string } | undefined;
      if (pr) links.push({ docType: 'PurchaseRequisition', id: pr.id, docNumber: pr.pr_number, status: pr.status, relation: 'Source Requisition' });
    }
    for (const g of db.prepare('SELECT id, grn_number, status FROM purchase_receipts WHERE po_id = ?').all(id) as { id: number; grn_number: string; status: string }[]) {
      links.push({ docType: 'PurchaseReceipt', id: g.id, docNumber: g.grn_number, status: g.status, relation: 'Goods Receipt (GRN)' });
    }
    for (const p of db.prepare('SELECT id, pi_number, status FROM purchase_invoices WHERE po_id = ?').all(id) as { id: number; pi_number: string; status: string }[]) {
      links.push({ docType: 'PurchaseInvoice', id: p.id, docNumber: p.pi_number, status: p.status, relation: 'Purchase Invoice' });
    }
  } else if (docType === 'PurchaseReceipt') {
    const grnRow = db.prepare('SELECT po_id FROM purchase_receipts WHERE id = ?').get(id) as { po_id: number | null } | undefined;
    if (grnRow?.po_id) {
      const po = db.prepare('SELECT id, po_number, status FROM purchase_orders WHERE id = ?').get(grnRow.po_id) as { id: number; po_number: string; status: string } | undefined;
      if (po) links.push({ docType: 'PurchaseOrder', id: po.id, docNumber: po.po_number, status: po.status, relation: 'Source Purchase Order' });
    }
    for (const p of db.prepare('SELECT id, pi_number, status FROM purchase_invoices WHERE grn_id = ?').all(id) as { id: number; pi_number: string; status: string }[]) {
      links.push({ docType: 'PurchaseInvoice', id: p.id, docNumber: p.pi_number, status: p.status, relation: 'Purchase Invoice' });
    }
    for (const q of db.prepare("SELECT id, qc_number, overall_status FROM quality_inspections WHERE doc_type = 'PurchaseReceipt' AND doc_id = ?").all(id) as { id: number; qc_number: string; overall_status: string }[]) {
      links.push({ docType: 'QualityInspection', id: q.id, docNumber: q.qc_number, status: q.overall_status, relation: 'QC Inspection' });
    }
    for (const je of db.prepare("SELECT id, je_number, status FROM journal_entries WHERE ref_doc_type = 'PurchaseReceipt' AND ref_doc_id = ?").all(id) as { id: number; je_number: string; status: string }[]) {
      links.push({ docType: 'JournalEntry', id: je.id, docNumber: je.je_number, status: je.status, relation: 'GRN Accrual Entry' });
    }
  } else if (docType === 'PurchaseInvoice') {
    const piRow = db.prepare('SELECT po_id, grn_id FROM purchase_invoices WHERE id = ?').get(id) as { po_id: number | null; grn_id: number | null } | undefined;
    if (piRow?.po_id) {
      const po = db.prepare('SELECT id, po_number, status FROM purchase_orders WHERE id = ?').get(piRow.po_id) as { id: number; po_number: string; status: string } | undefined;
      if (po) links.push({ docType: 'PurchaseOrder', id: po.id, docNumber: po.po_number, status: po.status, relation: 'Purchase Order' });
    }
    if (piRow?.grn_id) {
      const grn = db.prepare('SELECT id, grn_number, status FROM purchase_receipts WHERE id = ?').get(piRow.grn_id) as { id: number; grn_number: string; status: string } | undefined;
      if (grn) links.push({ docType: 'PurchaseReceipt', id: grn.id, docNumber: grn.grn_number, status: grn.status, relation: 'Goods Receipt' });
    }
    for (const je of db.prepare("SELECT id, je_number, status FROM journal_entries WHERE ref_doc_type = 'PurchaseInvoice' AND ref_doc_id = ?").all(id) as { id: number; je_number: string; status: string }[]) {
      links.push({ docType: 'JournalEntry', id: je.id, docNumber: je.je_number, status: je.status, relation: 'Accounting Entry' });
    }
  } else if (docType === 'PurchaseReturn' || docType === 'SubcontractingOrder' || docType === 'StockEntry') {
    for (const je of db.prepare('SELECT id, je_number, status FROM journal_entries WHERE ref_doc_type = ? AND ref_doc_id = ?').all(docType, id) as { id: number; je_number: string; status: string }[]) {
      links.push({ docType: 'JournalEntry', id: je.id, docNumber: je.je_number, status: je.status, relation: 'Accounting Entry' });
    }
  } else if (docType === 'SalesQuotation') {
    const sqRow = db.prepare('SELECT sq_number, amended_from FROM sales_quotations WHERE id = ?').get(id) as { sq_number: string; amended_from: string } | undefined;
    if (sqRow?.amended_from) {
      const prev = db.prepare('SELECT id, sq_number, status FROM sales_quotations WHERE sq_number = ?').get(sqRow.amended_from) as { id: number; sq_number: string; status: string } | undefined;
      if (prev) links.push({ docType: 'SalesQuotation', id: prev.id, docNumber: prev.sq_number, status: prev.status, relation: 'Amended From' });
    }
    for (const so of db.prepare('SELECT id, so_number, status FROM sales_orders WHERE sq_id = ?').all(id) as { id: number; so_number: string; status: string }[]) {
      links.push({ docType: 'SalesOrder', id: so.id, docNumber: so.so_number, status: so.status, relation: 'Sales Order' });
    }
  } else if (docType === 'SalesOrder') {
    const soRow = db.prepare('SELECT so_number, amended_from, sq_id FROM sales_orders WHERE id = ?').get(id) as { so_number: string; amended_from: string; sq_id: number | null } | undefined;
    if (soRow?.amended_from) {
      const prev = db.prepare('SELECT id, so_number, status FROM sales_orders WHERE so_number = ?').get(soRow.amended_from) as { id: number; so_number: string; status: string } | undefined;
      if (prev) links.push({ docType: 'SalesOrder', id: prev.id, docNumber: prev.so_number, status: prev.status, relation: 'Amended From' });
    }
    if (soRow?.so_number) {
      for (const nextSo of db.prepare('SELECT id, so_number, status FROM sales_orders WHERE amended_from = ?').all(soRow.so_number) as { id: number; so_number: string; status: string }[]) {
        links.push({ docType: 'SalesOrder', id: nextSo.id, docNumber: nextSo.so_number, status: nextSo.status, relation: 'Revised To' });
      }
    }
    if (soRow?.sq_id) {
      const sq = db.prepare('SELECT id, sq_number, status FROM sales_quotations WHERE id = ?').get(soRow.sq_id) as { id: number; sq_number: string; status: string } | undefined;
      if (sq) links.push({ docType: 'SalesQuotation', id: sq.id, docNumber: sq.sq_number, status: sq.status, relation: 'Source Quotation' });
    }
    for (const d of db.prepare('SELECT id, dn_number, status FROM delivery_notes WHERE so_id = ?').all(id) as { id: number; dn_number: string; status: string }[]) {
      links.push({ docType: 'DeliveryNote', id: d.id, docNumber: d.dn_number, status: d.status, relation: 'Delivery Note' });
    }
    for (const s of db.prepare('SELECT id, si_number, status FROM sales_invoices WHERE so_id = ?').all(id) as { id: number; si_number: string; status: string }[]) {
      links.push({ docType: 'SalesInvoice', id: s.id, docNumber: s.si_number, status: s.status, relation: 'Sales Invoice' });
    }
  } else if (docType === 'DeliveryNote') {
    const dnRow = db.prepare('SELECT so_id FROM delivery_notes WHERE id = ?').get(id) as { so_id: number | null } | undefined;
    if (dnRow?.so_id) {
      const so = db.prepare('SELECT id, so_number, status FROM sales_orders WHERE id = ?').get(dnRow.so_id) as { id: number; so_number: string; status: string } | undefined;
      if (so) links.push({ docType: 'SalesOrder', id: so.id, docNumber: so.so_number, status: so.status, relation: 'Sales Order' });
    }
    for (const si of db.prepare('SELECT id, si_number, status FROM sales_invoices WHERE dn_id = ?').all(id) as { id: number; si_number: string; status: string }[]) {
      links.push({ docType: 'SalesInvoice', id: si.id, docNumber: si.si_number, status: si.status, relation: 'Sales Invoice' });
    }
    for (const je of db.prepare("SELECT id, je_number, status FROM journal_entries WHERE ref_doc_type = 'DeliveryNote' AND ref_doc_id = ?").all(id) as { id: number; je_number: string; status: string }[]) {
      links.push({ docType: 'JournalEntry', id: je.id, docNumber: je.je_number, status: je.status, relation: 'COGS Journal Entry' });
    }
  } else if (docType === 'SalesInvoice') {
    const siRow = db.prepare('SELECT so_id, dn_id FROM sales_invoices WHERE id = ?').get(id) as { so_id: number | null; dn_id: number | null } | undefined;
    if (siRow?.so_id) {
      const so = db.prepare('SELECT id, so_number, status FROM sales_orders WHERE id = ?').get(siRow.so_id) as { id: number; so_number: string; status: string } | undefined;
      if (so) links.push({ docType: 'SalesOrder', id: so.id, docNumber: so.so_number, status: so.status, relation: 'Sales Order' });
    }
    if (siRow?.dn_id) {
      const dn = db.prepare('SELECT id, dn_number, status FROM delivery_notes WHERE id = ?').get(siRow.dn_id) as { id: number; dn_number: string; status: string } | undefined;
      if (dn) links.push({ docType: 'DeliveryNote', id: dn.id, docNumber: dn.dn_number, status: dn.status, relation: 'Delivery Note' });
    }
    for (const je of db.prepare("SELECT id, je_number, status FROM journal_entries WHERE ref_doc_type = 'SalesInvoice' AND ref_doc_id = ?").all(id) as { id: number; je_number: string; status: string }[]) {
      links.push({ docType: 'JournalEntry', id: je.id, docNumber: je.je_number, status: je.status, relation: 'Accounting Entry' });
    }
  } else if (docType === 'SalesReturn') {
    for (const je of db.prepare("SELECT id, je_number, status FROM journal_entries WHERE ref_doc_type = 'SalesReturn' AND ref_doc_id = ?").all(id) as { id: number; je_number: string; status: string }[]) {
      links.push({ docType: 'JournalEntry', id: je.id, docNumber: je.je_number, status: je.status, relation: 'Credit Note Entry' });
    }
  } else if (docType === 'BOM') {
    for (const p of db.prepare('SELECT id, prod_number, status FROM production_orders WHERE bom_id = ?').all(id) as { id: number; prod_number: string; status: string }[]) {
      links.push({ docType: 'ProductionOrder', id: p.id, docNumber: p.prod_number, status: p.status, relation: 'Production Order' });
    }
  } else if (docType === 'ProductionOrder') {
    const prodRow = db.prepare('SELECT bom_id FROM production_orders WHERE id = ?').get(id) as { bom_id: number | null } | undefined;
    if (prodRow?.bom_id) {
      const bom = db.prepare('SELECT id, bom_number, version FROM boms WHERE id = ?').get(prodRow.bom_id) as { id: number; bom_number: string; version: string } | undefined;
      if (bom) links.push({ docType: 'BOM', id: bom.id, docNumber: bom.bom_number, status: bom.version, relation: 'Source BOM' });
    }
    for (const q of db.prepare("SELECT id, qc_number, overall_status FROM quality_inspections WHERE doc_type = 'ProductionOrder' AND doc_id = ?").all(id) as { id: number; qc_number: string; overall_status: string }[]) {
      links.push({ docType: 'QualityInspection', id: q.id, docNumber: q.qc_number, status: q.overall_status, relation: 'QC Inspection' });
    }
    for (const je of db.prepare("SELECT id, je_number, status FROM journal_entries WHERE ref_doc_type = 'ProductionOrder' AND ref_doc_id = ?").all(id) as { id: number; je_number: string; status: string }[]) {
      links.push({ docType: 'JournalEntry', id: je.id, docNumber: je.je_number, status: je.status, relation: 'Accounting Entry' });
    }
  }

  const audit = db.prepare('SELECT * FROM audit_logs WHERE doc_type = ? AND doc_id = ? ORDER BY id DESC').all(docType, id);
  res.json({ links, audit });
});

// ---------------- NOTIFICATIONS ----------------
router.get('/notifications', (req: AuthRequest, res) => {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT * FROM notifications
       WHERE (user_id IS NULL OR user_id = ?) AND (role_id IS NULL OR role_id = ?)
       ORDER BY id DESC LIMIT 50`
    )
    .all(req.user!.id, req.user!.role_id);
  res.json({ items: rows });
});

router.post('/notifications/mark-read', (req: AuthRequest, res) => {
  const { id } = req.body as { id?: number };
  const db = getDb();
  if (id) db.prepare('UPDATE notifications SET is_read = 1 WHERE id = ?').run(id);
  else db.prepare('UPDATE notifications SET is_read = 1 WHERE (user_id IS NULL OR user_id = ?)').run(req.user!.id);
  res.json({ ok: true });
});

// ---------------- APPROVAL MATRIX & REQUESTS ----------------
router.get('/approvals', (_req, res) => {
  const db = getDb();
  const rules = db
    .prepare('SELECT ar.*, r.name as role_name FROM approval_rules ar JOIN roles r ON r.id = ar.role_id ORDER BY ar.doc_type, ar.priority ASC')
    .all();
  const requests = db
    .prepare(
      `SELECT req.*, r.name as required_role_name, u.full_name as requested_by_name
       FROM approval_requests req
       LEFT JOIN roles r ON r.id = req.required_role_id
       LEFT JOIN users u ON u.id = req.requested_by
       ORDER BY req.id DESC`
    )
    .all();
  const history = db
    .prepare('SELECT ah.*, u.full_name as actor_name FROM approval_history ah LEFT JOIN users u ON u.id = ah.actor_id ORDER BY ah.id DESC')
    .all();
  res.json({ rules, requests, history });
});

router.post('/approvals/rules', requirePermission('settings', 'can_edit'), (req, res) => {
  const { doc_type, department, role_id, min_amount, max_amount, currency, priority } = req.body as Record<string, unknown>;
  const r = getDb()
    .prepare('INSERT INTO approval_rules (doc_type, department, role_id, min_amount, max_amount, currency, priority, is_active) VALUES (?, ?, ?, ?, ?, ?, ?, 1)')
    .run(doc_type, department || '', role_id, Number(min_amount || 0), max_amount !== undefined && max_amount !== '' && max_amount !== null ? Number(max_amount) : null, currency || 'AED', Number(priority || 1));
  res.status(201).json({ id: r.lastInsertRowid });
});

router.post('/approvals/requests/:id/decide', (req: AuthRequest, res) => {
  const reqId = Number(req.params.id);
  const { decision, comments } = req.body as { decision: 'Approved' | 'Rejected' | 'Changes Requested'; comments?: string };
  if (!['Approved', 'Rejected', 'Changes Requested'].includes(decision)) {
    res.status(400).json({ error: 'Invalid decision' });
    return;
  }

  try {
    withTransaction((db) => {
      const appReq = db.prepare('SELECT * FROM approval_requests WHERE id = ?').get(reqId) as
        | { id: number; doc_type: string; doc_id: number; doc_number: string; required_role_id: number | null; status: string }
        | undefined;
      if (!appReq) throw new Error('Approval request not found');
      if (appReq.status !== 'Pending') throw new Error('Request already decided');

      if (req.user!.role_name !== 'Super Admin' && appReq.required_role_id && req.user!.role_id !== appReq.required_role_id) {
        throw new Error('Unauthorized: You do not hold the required approver role for this threshold');
      }

      db.prepare('UPDATE approval_requests SET status = ?, comments = ?, decided_by = ?, decided_at = ? WHERE id = ?').run(
        decision,
        comments || '',
        req.user!.id,
        nowISO(),
        reqId
      );
      db.prepare('INSERT INTO approval_history (request_id, doc_type, doc_id, action, actor_id, comments, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
        reqId,
        appReq.doc_type,
        appReq.doc_id,
        decision,
        req.user!.id,
        comments || '',
        nowISO()
      );

      if (appReq.doc_type === 'PurchaseOrder') {
        if (decision === 'Approved') {
          db.prepare("UPDATE purchase_orders SET status = 'Submitted', approval_status = 'Approved', submitted_by = ?, submitted_at = ? WHERE id = ?").run(
            req.user!.id,
            nowISO(),
            appReq.doc_id
          );
        } else {
          db.prepare("UPDATE purchase_orders SET status = 'Draft', approval_status = ? WHERE id = ?").run(decision, appReq.doc_id);
        }
      } else if (appReq.doc_type === 'PaymentVoucher') {
        if (decision === 'Approved') {
          postVoucherInternal(db, appReq.doc_id, req.user!);
        } else {
          db.prepare("UPDATE payment_vouchers SET status = 'Draft', approval_status = ? WHERE id = ?").run(decision, appReq.doc_id);
        }
      }

      recordAuditLog(db, req.user, appReq.doc_type, appReq.doc_id, appReq.doc_number, `Approval: ${decision}`, { comments });
    });
    res.json({ ok: true });
  } catch (err: unknown) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Approval decision failed' });
  }
});

// ---------------- ATTACHMENTS ----------------
router.get('/attachments', (req, res) => {
  const docType = String(req.query.doc_type || '');
  const docId = Number(req.query.doc_id || 0);
  const rows = getDb()
    .prepare('SELECT a.*, u.full_name as uploaded_by_name FROM attachments a LEFT JOIN users u ON u.id = a.uploaded_by WHERE a.doc_type = ? AND a.doc_id = ? ORDER BY a.id DESC')
    .all(docType, docId);
  res.json({ items: rows });
});

router.post('/attachments/upload', upload.single('file'), (req: AuthRequest, res) => {
  if (!req.file) {
    res.status(400).json({ error: 'No file uploaded' });
    return;
  }
  const { doc_type, doc_id } = req.body as { doc_type?: string; doc_id?: string };
  if (!doc_type || !doc_id) {
    res.status(400).json({ error: 'doc_type and doc_id are required' });
    return;
  }
  const db = getDb();
  const r = db
    .prepare('INSERT INTO attachments (doc_type, doc_id, file_name, stored_name, mime_type, size_bytes, uploaded_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(doc_type, Number(doc_id), req.file.originalname, req.file.filename, req.file.mimetype, req.file.size, req.user!.id, nowISO());
  recordAuditLog(db, req.user, doc_type, Number(doc_id), `${doc_type}-${doc_id}`, 'Upload Attachment', { file: req.file.originalname });
  res.status(201).json({ id: r.lastInsertRowid, file_name: req.file.originalname });
});

router.get('/attachments/:id/download', (req, res) => {
  const att = getDb().prepare('SELECT * FROM attachments WHERE id = ?').get(Number(req.params.id)) as
    | { file_name: string; stored_name: string; mime_type: string }
    | undefined;
  if (!att) {
    res.status(404).json({ error: 'Attachment not found' });
    return;
  }
  const filePath = safeResolveWithin(UPLOAD_DIR, att.stored_name);
  if (!fs.existsSync(filePath)) {
    res.status(404).json({ error: 'Attachment file missing on storage' });
    return;
  }
  res.setHeader('Content-Type', att.mime_type);
  res.download(filePath, att.file_name);
});

// ---------------- SETTINGS, SEQUENCES, AUDIT LOGS, BACKUP & POSTGRES MIGRATION ----------------
router.get('/settings', requirePermission('settings', 'can_view'), (_req, res) => {
  const db = getDb();
  res.json({
    settings: db.prepare('SELECT * FROM system_settings ORDER BY category, key').all(),
    sequences: db.prepare('SELECT * FROM document_sequences ORDER BY doc_type').all(),
    migrations: db.prepare('SELECT * FROM schema_migrations ORDER BY applied_at DESC').all(),
    financialPeriods: db.prepare('SELECT * FROM financial_periods ORDER BY id DESC').all(),
    dbEngine: (process.env.DATABASE_URL || 'sqlite:///./data/lubricants_erp.db').startsWith('postgresql') ? 'PostgreSQL' : 'SQLite (Local)',
    dbPath: 'Configured on server',
  });
});

router.put('/settings', requirePermission('settings', 'can_edit'), (req: AuthRequest, res) => {
  const { key, value } = req.body as { key: string; value: string };
  getDb().prepare('UPDATE system_settings SET value = ?, updated_at = ? WHERE key = ?').run(String(value), nowISO(), key);
  recordAuditLog(getDb(), req.user, 'SystemSetting', null, key, 'Update Setting', { value });
  res.json({ ok: true });
});

router.put('/sequences/:id', requirePermission('settings', 'can_edit'), (req: AuthRequest, res) => {
  const { prefix, next_number, digits, financial_year, include_fy } = req.body as Record<string, unknown>;
  getDb()
    .prepare('UPDATE document_sequences SET prefix = ?, next_number = ?, digits = ?, financial_year = ?, include_fy = ? WHERE id = ?')
    .run(prefix, Number(next_number), Number(digits), financial_year || '2026', include_fy ? 1 : 0, Number(req.params.id));
  recordAuditLog(getDb(), req.user, 'DocumentSequence', Number(req.params.id), String(prefix), 'Update Numbering Series', req.body);
  res.json({ ok: true });
});

router.get('/audit-logs', requirePermission('settings', 'can_view'), (_req, res) => {
  res.json({ items: getDb().prepare('SELECT * FROM audit_logs ORDER BY id DESC LIMIT 300').all() });
});

router.get('/backups', requirePermission('settings', 'can_view'), (_req, res) => {
  res.json({ items: getDb().prepare('SELECT * FROM backup_history ORDER BY id DESC').all() });
});

router.post('/backups/create', requirePermission('settings', 'can_create'), async (req: AuthRequest, res) => {
  try {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const fileName = `lubricants_erp_backup_${stamp}.db`;
    const targetPath = safeResolveWithin(BACKUP_DIR, fileName);
    const db = getDb();
    await db.backup(targetPath);
    const stats = fs.statSync(targetPath);
    const r = db
      .prepare("INSERT INTO backup_history (file_name, file_path, size_bytes, backup_type, created_by, created_at) VALUES (?, ?, ?, 'Manual', ?, ?)")
      .run(fileName, targetPath, stats.size, req.user!.id, nowISO());
    recordAuditLog(db, req.user, 'Backup', Number(r.lastInsertRowid), fileName, 'Create Database Backup', { size_bytes: stats.size });
    res.status(201).json({ id: r.lastInsertRowid, file_name: fileName, size_bytes: stats.size });
  } catch (err: unknown) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Backup failed' });
  }
});

router.get('/backups/:id/download', requirePermission('settings', 'can_export'), (req, res) => {
  const row = getDb().prepare('SELECT file_name FROM backup_history WHERE id = ?').get(Number(req.params.id)) as { file_name: string } | undefined;
  if (!row) {
    res.status(404).json({ error: 'Backup record not found' });
    return;
  }
  const filePath = safeResolveWithin(BACKUP_DIR, row.file_name);
  if (!fs.existsSync(filePath)) {
    res.status(404).json({ error: 'Backup file missing' });
    return;
  }
  res.download(filePath, row.file_name);
});

router.post('/backups/:id/restore', requirePermission('settings', 'can_edit'), async (req: AuthRequest, res) => {
  if (req.user!.role_name !== 'Super Admin') {
    res.status(403).json({ error: 'Only Super Admin can restore database backups' });
    return;
  }
  try {
    const row = getDb().prepare('SELECT file_name FROM backup_history WHERE id = ?').get(Number(req.params.id)) as { file_name: string } | undefined;
    if (!row) {
      res.status(404).json({ error: 'Backup not found' });
      return;
    }
    const backupFile = safeResolveWithin(BACKUP_DIR, row.file_name);
    if (!fs.existsSync(backupFile)) {
      res.status(404).json({ error: 'Backup file missing' });
      return;
    }
    // Save safety pre-restore snapshot first
    const safetyPath = safeResolveWithin(BACKUP_DIR, `pre_restore_safety_${Date.now()}.db`);
    await getDb().backup(safetyPath);
    resetDbConnection();
    fs.copyFileSync(backupFile, DB_FILE_PATH);
    getDb();
    res.json({ ok: true, message: 'Database restored cleanly. Pre-restore safety snapshot saved.' });
  } catch (err: unknown) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Restore failed' });
  }
});

router.post('/backups/integrity-check', requirePermission('settings', 'can_view'), (_req, res) => {
  const db = getDb();
  const integrity = db.pragma('integrity_check') as { integrity_check: string }[];
  const fkCheck = db.pragma('foreign_key_check') as unknown[];
  const tbDiff = db
    .prepare('SELECT ROUND(COALESCE(SUM(total_debit),0) - COALESCE(SUM(total_credit),0), 2) as diff FROM journal_entries')
    .get() as { diff: number };
  res.json({
    sqlite_integrity: integrity[0]?.integrity_check || 'ok',
    foreign_key_violations: fkCheck.length,
    accounting_trial_balance_diff: tbDiff.diff,
    healthy: integrity[0]?.integrity_check === 'ok' && fkCheck.length === 0 && Math.abs(tbDiff.diff) < 0.05,
  });
});

// Export SQLite data bundle for PostgreSQL Migration
router.get('/backups/postgres-export', requirePermission('settings', 'can_export'), (_req, res) => {
  const db = getDb();
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name ASC")
    .all() as { name: string }[];
  const payload: Record<string, unknown[]> = {};
  for (const t of tables) {
    payload[t.name] = db.prepare(`SELECT * FROM "${t.name}"`).all();
  }
  res.setHeader('Content-Disposition', 'attachment; filename="lubricants_erp_pg_migration_bundle.json"');
  res.json({ exported_at: nowISO(), source_engine: 'sqlite', target_engine: 'postgresql', tables: payload });
});

export default router;
