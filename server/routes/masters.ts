import fs from 'fs';
import path from 'path';
import multer from 'multer';
import { Router } from 'express';
import { UPLOAD_DIR, getDb, withTransaction } from '../db.ts';
import { authenticate, recordAuditLog, requirePermission, type AuthRequest } from '../middleware/auth.ts';
import { nowISO, parsePagination, roundMoney, safeResolveWithin, todayISO } from '../utils/helpers.ts';
import { getTotalItemStock } from '../services/inventory.ts';

const router = Router();
router.use(authenticate);

const BRANDING_DIR = path.join(UPLOAD_DIR, 'branding');
fs.mkdirSync(BRANDING_DIR, { recursive: true });

const logoUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = ['image/png', 'image/jpeg', 'image/jpg', 'image/webp'];
    if (allowed.includes(file.mimetype.toLowerCase())) {
      cb(null, true);
    } else {
      cb(new Error('Only PNG, JPEG, or WebP images are allowed for company logo'));
    }
  },
});

function removeBrandingFile(logoPath?: string | null) {
  if (!logoPath) return;
  try {
    const full = safeResolveWithin(BRANDING_DIR, path.basename(logoPath));
    if (fs.existsSync(full)) fs.unlinkSync(full);
  } catch {
    // ignore cleanup errors
  }
}

// Company Master
router.get('/company', (_req, res) => {
  const db = getDb();
  const company = db.prepare('SELECT * FROM companies LIMIT 1').get() as Record<string, unknown> | undefined;
  res.json({
    company: company
      ? {
          ...company,
          logo_url: company.logo_path ? `/api/auth/logo?v=${encodeURIComponent(String(company.logo_path))}` : '',
        }
      : null,
  });
});

router.put('/company', requirePermission('settings', 'can_edit'), (req: AuthRequest, res) => {
  const body = req.body as Record<string, unknown>;
  try {
    const company = withTransaction((db) => {
      db.prepare(
        `UPDATE companies SET
          name = COALESCE(?, name),
          short_name = COALESCE(?, short_name),
          logo_path = COALESCE(?, logo_path),
          address = COALESCE(?, address),
          po_box = COALESCE(?, po_box),
          country = COALESCE(?, country),
          trn = COALESCE(?, trn),
          telephone = COALESCE(?, telephone),
          email = COALESCE(?, email),
          website = COALESCE(?, website),
          currency = COALESCE(?, currency),
          financial_year_start = COALESCE(?, financial_year_start),
          financial_year_end = COALESCE(?, financial_year_end),
          vat_rate = COALESCE(?, vat_rate),
          vat_enabled = COALESCE(?, vat_enabled),
          letterhead_html = COALESCE(?, letterhead_html),
          updated_at = ?
         WHERE id = (SELECT id FROM companies LIMIT 1)`
      ).run(
        body.name ?? null,
        body.short_name ?? null,
        body.logo_path ?? null,
        body.address ?? null,
        body.po_box ?? null,
        body.country ?? null,
        body.trn ?? null,
        body.telephone ?? null,
        body.email ?? null,
        body.website ?? null,
        body.currency ?? null,
        body.financial_year_start ?? null,
        body.financial_year_end ?? null,
        body.vat_rate ?? null,
        body.vat_enabled ?? null,
        body.letterhead_html ?? null,
        nowISO()
      );
      recordAuditLog(db, req.user, 'Company', 1, String(body.name || 'Company'), 'Update Company Profile', body);
      return db.prepare('SELECT * FROM companies LIMIT 1').get() as Record<string, unknown>;
    });
    res.json({
      ok: true,
      company: {
        ...company,
        logo_url: company.logo_path ? `/api/auth/logo?v=${encodeURIComponent(String(company.logo_path))}` : '',
      },
    });
  } catch (err: unknown) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Failed to update company' });
  }
});

router.post('/company/logo', requirePermission('settings', 'can_edit'), logoUpload.single('logo'), (req: AuthRequest, res) => {
  if (!req.file) {
    res.status(400).json({ error: 'Logo image file is required' });
    return;
  }
  try {
    const extMap: Record<string, string> = {
      'image/png': '.png',
      'image/jpeg': '.jpg',
      'image/jpg': '.jpg',
      'image/webp': '.webp',
    };
    const ext = extMap[req.file.mimetype.toLowerCase()] || '.png';
    const fileName = `company-logo-${Date.now()}${ext}`;
    fs.mkdirSync(BRANDING_DIR, { recursive: true });
    const targetPath = safeResolveWithin(BRANDING_DIR, fileName);
    fs.writeFileSync(targetPath, req.file.buffer);

    const existing = getDb().prepare('SELECT logo_path FROM companies LIMIT 1').get() as { logo_path?: string } | undefined;
    if (existing?.logo_path && existing.logo_path !== fileName) {
      removeBrandingFile(existing.logo_path);
    }

    withTransaction((db) => {
      db.prepare('UPDATE companies SET logo_path = ?, updated_at = ? WHERE id = (SELECT id FROM companies LIMIT 1)').run(fileName, nowISO());
      recordAuditLog(db, req.user, 'Company', 1, fileName, 'Upload Company Logo', { fileName, size: req.file!.size });
    });

    res.json({
      ok: true,
      logo_path: fileName,
      logo_url: `/api/auth/logo?v=${encodeURIComponent(fileName)}`,
    });
  } catch (err: unknown) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Failed to upload company logo' });
  }
});

router.delete('/company/logo', requirePermission('settings', 'can_edit'), (req: AuthRequest, res) => {
  try {
    const existing = getDb().prepare('SELECT logo_path FROM companies LIMIT 1').get() as { logo_path?: string } | undefined;
    removeBrandingFile(existing?.logo_path);
    withTransaction((db) => {
      db.prepare("UPDATE companies SET logo_path = '', updated_at = ? WHERE id = (SELECT id FROM companies LIMIT 1)").run(nowISO());
      recordAuditLog(db, req.user, 'Company', 1, 'Logo', 'Remove Company Logo', {});
    });
    res.json({ ok: true });
  } catch (err: unknown) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Failed to remove company logo' });
  }
});

// Suppliers
router.get('/suppliers', requirePermission('masters', 'can_view'), (req, res) => {
  const db = getDb();
  const { search } = parsePagination(req.query as Record<string, unknown>);
  const like = `%${search}%`;
  const rows = db
    .prepare(
      `SELECT s.*, pt.name as payment_term_name,
         COALESCE((SELECT SUM(outstanding_amount) FROM purchase_invoices WHERE supplier_id = s.id AND status = 'Posted'), 0) as current_outstanding
       FROM suppliers s
       LEFT JOIN payment_terms pt ON pt.id = s.payment_term_id
       WHERE (? = '' OR s.code LIKE ? OR s.name LIKE ? OR s.email LIKE ?)
       ORDER BY s.id DESC`
    )
    .all(search, like, like, like);
  res.json({ items: rows });
});

router.post('/suppliers', requirePermission('masters', 'can_create'), (req: AuthRequest, res) => {
  const b = req.body as Record<string, unknown>;
  if (!b.name) {
    res.status(400).json({ error: 'Supplier name is required' });
    return;
  }
  try {
    const result = withTransaction((db) => {
      const count = (db.prepare('SELECT COUNT(*) as c FROM suppliers').get() as { c: number }).c;
      const code = String(b.code || `SUP-${String(count + 1).padStart(3, '0')}`).trim();
      const now = nowISO();
      const ins = db
        .prepare(
          `INSERT INTO suppliers (code, name, contact_person, email, telephone, whatsapp, address, country, payment_term_id, credit_limit, trn, opening_balance, bank_details, category, currency, is_active, created_by, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          code,
          String(b.name).trim(),
          b.contact_person ?? '',
          b.email ?? '',
          b.telephone ?? '',
          b.whatsapp ?? '',
          b.address ?? '',
          b.country ?? 'United Arab Emirates',
          b.payment_term_id || null,
          Number(b.credit_limit || 0),
          b.trn ?? '',
          Number(b.opening_balance || 0),
          b.bank_details ?? '',
          b.category ?? 'Raw Material Supplier',
          b.currency ?? 'AED',
          b.is_active === 0 ? 0 : 1,
          req.user!.id,
          now,
          now
        );
      const id = Number(ins.lastInsertRowid);
      recordAuditLog(db, req.user, 'Supplier', id, code, 'Create Supplier', { name: b.name });
      return { id, code };
    });
    res.status(201).json(result);
  } catch (err: unknown) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Failed to create supplier' });
  }
});

router.put('/suppliers/:id', requirePermission('masters', 'can_edit'), (req: AuthRequest, res) => {
  const id = Number(req.params.id);
  const b = req.body as Record<string, unknown>;
  try {
    withTransaction((db) => {
      db.prepare(
        `UPDATE suppliers SET
          name = COALESCE(?, name), contact_person = COALESCE(?, contact_person), email = COALESCE(?, email),
          telephone = COALESCE(?, telephone), whatsapp = COALESCE(?, whatsapp), address = COALESCE(?, address),
          country = COALESCE(?, country), payment_term_id = COALESCE(?, payment_term_id), credit_limit = COALESCE(?, credit_limit),
          trn = COALESCE(?, trn), bank_details = COALESCE(?, bank_details), category = COALESCE(?, category),
          currency = COALESCE(?, currency), is_active = COALESCE(?, is_active), updated_at = ?
         WHERE id = ?`
      ).run(
        b.name ?? null, b.contact_person ?? null, b.email ?? null, b.telephone ?? null, b.whatsapp ?? null,
        b.address ?? null, b.country ?? null, b.payment_term_id ?? null, b.credit_limit ?? null, b.trn ?? null,
        b.bank_details ?? null, b.category ?? null, b.currency ?? null, b.is_active ?? null, nowISO(), id
      );
      recordAuditLog(db, req.user, 'Supplier', id, String(b.code || id), 'Update Supplier', b);
    });
    res.json({ ok: true });
  } catch (err: unknown) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Failed to update supplier' });
  }
});

// Customers
router.get('/customers', requirePermission('masters', 'can_view'), (req, res) => {
  const db = getDb();
  const { search } = parsePagination(req.query as Record<string, unknown>);
  const like = `%${search}%`;
  const rows = db
    .prepare(
      `SELECT c.*, pt.name as payment_term_name,
         COALESCE((SELECT SUM(outstanding_amount) FROM sales_invoices WHERE customer_id = c.id AND status = 'Posted'), 0) as current_outstanding
       FROM customers c
       LEFT JOIN payment_terms pt ON pt.id = c.payment_term_id
       WHERE (? = '' OR c.code LIKE ? OR c.name LIKE ? OR c.email LIKE ?)
       ORDER BY c.id DESC`
    )
    .all(search, like, like, like);
  res.json({ items: rows });
});

router.post('/customers', requirePermission('masters', 'can_create'), (req: AuthRequest, res) => {
  const b = req.body as Record<string, unknown>;
  if (!b.name) {
    res.status(400).json({ error: 'Customer name is required' });
    return;
  }
  try {
    const result = withTransaction((db) => {
      const count = (db.prepare('SELECT COUNT(*) as c FROM customers').get() as { c: number }).c;
      const code = String(b.code || `CUST-${String(count + 1).padStart(3, '0')}`).trim();
      const now = nowISO();
      const ins = db
        .prepare(
          `INSERT INTO customers (code, name, contact_person, telephone, email, whatsapp, address, country, payment_term_id, credit_limit, trn, opening_balance, category, currency, is_active, created_by, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          code,
          String(b.name).trim(),
          b.contact_person ?? '',
          b.telephone ?? '',
          b.email ?? '',
          b.whatsapp ?? '',
          b.address ?? '',
          b.country ?? 'United Arab Emirates',
          b.payment_term_id || null,
          Number(b.credit_limit || 0),
          b.trn ?? '',
          Number(b.opening_balance || 0),
          b.category ?? 'Distributor',
          b.currency ?? 'AED',
          b.is_active === 0 ? 0 : 1,
          req.user!.id,
          now,
          now
        );
      const id = Number(ins.lastInsertRowid);
      recordAuditLog(db, req.user, 'Customer', id, code, 'Create Customer', { name: b.name });
      return { id, code };
    });
    res.status(201).json(result);
  } catch (err: unknown) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Failed to create customer' });
  }
});

router.put('/customers/:id', requirePermission('masters', 'can_edit'), (req: AuthRequest, res) => {
  const id = Number(req.params.id);
  const b = req.body as Record<string, unknown>;
  try {
    withTransaction((db) => {
      db.prepare(
        `UPDATE customers SET
          name = COALESCE(?, name), contact_person = COALESCE(?, contact_person), telephone = COALESCE(?, telephone),
          email = COALESCE(?, email), whatsapp = COALESCE(?, whatsapp), address = COALESCE(?, address),
          country = COALESCE(?, country), payment_term_id = COALESCE(?, payment_term_id), credit_limit = COALESCE(?, credit_limit),
          trn = COALESCE(?, trn), category = COALESCE(?, category), currency = COALESCE(?, currency),
          is_active = COALESCE(?, is_active), updated_at = ?
         WHERE id = ?`
      ).run(
        b.name ?? null, b.contact_person ?? null, b.telephone ?? null, b.email ?? null, b.whatsapp ?? null,
        b.address ?? null, b.country ?? null, b.payment_term_id ?? null, b.credit_limit ?? null, b.trn ?? null,
        b.category ?? null, b.currency ?? null, b.is_active ?? null, nowISO(), id
      );
      recordAuditLog(db, req.user, 'Customer', id, String(b.code || id), 'Update Customer', b);
    });
    res.json({ ok: true });
  } catch (err: unknown) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Failed to update customer' });
  }
});

// Items & Products (supports hierarchical parent/sub-group filtering)
router.get('/items', requirePermission('masters', 'can_view'), (req, res) => {
  const db = getDb();
  const { search } = parsePagination(req.query as Record<string, unknown>);
  const categoryId = req.query.category_id ? Number(req.query.category_id) : null;
  const like = `%${search}%`;
  const rows = db
    .prepare(
      `WITH RECURSIVE cat_tree(id) AS (
         SELECT id FROM item_categories WHERE id = ?
         UNION ALL
         SELECT ic.id FROM item_categories ic JOIN cat_tree ct ON ic.parent_id = ct.id
       )
       SELECT i.*, c.name as category_name, c.group_code, c.parent_id,
              p.name as parent_category_name, p.group_code as parent_group_code,
              w.name as warehouse_name, s.name as preferred_supplier_name
       FROM items i
       JOIN item_categories c ON c.id = i.category_id
       LEFT JOIN item_categories p ON p.id = c.parent_id
       LEFT JOIN warehouses w ON w.id = i.default_warehouse_id
       LEFT JOIN suppliers s ON s.id = i.preferred_supplier_id
       WHERE (? = '' OR i.item_code LIKE ? OR i.name LIKE ? OR i.brand LIKE ? OR i.sku LIKE ? OR c.name LIKE ? OR c.group_code LIKE ?)
         AND (? IS NULL OR i.category_id IN (SELECT id FROM cat_tree))
       ORDER BY i.id DESC`
    )
    .all(categoryId, search, like, like, like, like, like, like, categoryId) as Record<string, unknown>[];

  const enriched = rows.map((r) => ({
    ...r,
    current_stock: getTotalItemStock(db, Number(r.id)),
  }));
  res.json({ items: enriched });
});

router.post('/items', requirePermission('masters', 'can_create'), (req: AuthRequest, res) => {
  const b = req.body as Record<string, unknown>;
  if (!b.item_code || !b.name || !b.category_id) {
    res.status(400).json({ error: 'Item code, name, and category are required' });
    return;
  }
  try {
    const id = withTransaction((db) => {
      const now = nowISO();
      const ins = db
        .prepare(
          `INSERT INTO items (
            item_code, name, description, category_id, brand, sku, barcode,
            purchase_uom, stock_uom, sales_uom, conversion_factor,
            reorder_level, min_stock, max_stock, safety_stock, lead_time_days, moq, preferred_supplier_id,
            standard_cost, average_cost, last_purchase_price, selling_price, vat_rate, tax_category,
            batch_tracking, expiry_tracking, default_warehouse_id, valuation_method, is_active, created_by, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          String(b.item_code).trim().toUpperCase(),
          String(b.name).trim(),
          b.description ?? '',
          Number(b.category_id),
          b.brand ?? '',
          b.sku ?? '',
          b.barcode ?? '',
          b.purchase_uom ?? 'LTR',
          b.stock_uom ?? 'LTR',
          b.sales_uom ?? 'LTR',
          Number(b.conversion_factor || 1),
          Number(b.reorder_level || 0),
          Number(b.min_stock || 0),
          Number(b.max_stock || 0),
          Number(b.safety_stock || 0),
          Number(b.lead_time_days || 7),
          Number(b.moq || 1),
          b.preferred_supplier_id || null,
          Number(b.standard_cost || 0),
          Number(b.average_cost ?? b.standard_cost ?? 0),
          Number(b.last_purchase_price || 0),
          Number(b.selling_price || 0),
          Number(b.vat_rate ?? 5.0),
          b.tax_category ?? 'Standard Rated',
          b.batch_tracking === 0 ? 0 : 1,
          b.expiry_tracking ? 1 : 0,
          b.default_warehouse_id || null,
          b.valuation_method ?? 'Moving Average',
          b.is_active === 0 ? 0 : 1,
          req.user!.id,
          now,
          now
        );
      const itemId = Number(ins.lastInsertRowid);
      recordAuditLog(db, req.user, 'Item', itemId, String(b.item_code), 'Create Item', { name: b.name });
      return itemId;
    });
    res.status(201).json({ id });
  } catch (err: unknown) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Failed to create item' });
  }
});

router.put('/items/:id', requirePermission('masters', 'can_edit'), (req: AuthRequest, res) => {
  const id = Number(req.params.id);
  const b = req.body as Record<string, unknown>;
  try {
    withTransaction((db) => {
      db.prepare(
        `UPDATE items SET
          item_code = COALESCE(?, item_code), name = COALESCE(?, name), description = COALESCE(?, description),
          category_id = COALESCE(?, category_id), brand = COALESCE(?, brand), sku = COALESCE(?, sku), barcode = COALESCE(?, barcode),
          purchase_uom = COALESCE(?, purchase_uom), stock_uom = COALESCE(?, stock_uom),
          sales_uom = COALESCE(?, sales_uom), conversion_factor = COALESCE(?, conversion_factor),
          reorder_level = COALESCE(?, reorder_level), min_stock = COALESCE(?, min_stock), max_stock = COALESCE(?, max_stock),
          safety_stock = COALESCE(?, safety_stock), lead_time_days = COALESCE(?, lead_time_days), moq = COALESCE(?, moq),
          preferred_supplier_id = COALESCE(?, preferred_supplier_id), standard_cost = COALESCE(?, standard_cost),
          selling_price = COALESCE(?, selling_price), vat_rate = COALESCE(?, vat_rate), tax_category = COALESCE(?, tax_category),
          batch_tracking = COALESCE(?, batch_tracking), expiry_tracking = COALESCE(?, expiry_tracking),
          default_warehouse_id = COALESCE(?, default_warehouse_id), valuation_method = COALESCE(?, valuation_method),
          is_active = COALESCE(?, is_active), updated_at = ?
         WHERE id = ?`
      ).run(
        b.item_code ? String(b.item_code).trim().toUpperCase() : null,
        b.name ?? null,
        b.description ?? null,
        b.category_id ?? null,
        b.brand ?? null,
        b.sku ?? null,
        b.barcode ?? null,
        b.purchase_uom ?? null,
        b.stock_uom ?? null,
        b.sales_uom ?? null,
        b.conversion_factor ?? null,
        b.reorder_level ?? null,
        b.min_stock ?? null,
        b.max_stock ?? null,
        b.safety_stock ?? null,
        b.lead_time_days ?? null,
        b.moq ?? null,
        b.preferred_supplier_id ?? null,
        b.standard_cost ?? null,
        b.selling_price ?? null,
        b.vat_rate ?? null,
        b.tax_category ?? null,
        b.batch_tracking ?? null,
        b.expiry_tracking ?? null,
        b.default_warehouse_id ?? null,
        b.valuation_method ?? null,
        b.is_active ?? null,
        nowISO(),
        id
      );
      recordAuditLog(db, req.user, 'Item', id, String(b.item_code || id), 'Update Item', b);
    });
    res.json({ ok: true });
  } catch (err: unknown) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Failed to update item' });
  }
});

// Hierarchical Item Categories / Groups
router.get('/categories', (_req, res) => {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT c.*, p.name as parent_name, p.group_code as parent_group_code,
              (SELECT COUNT(*) FROM items i WHERE i.category_id = c.id) as item_count
       FROM item_categories c
       LEFT JOIN item_categories p ON p.id = c.parent_id
       ORDER BY COALESCE(c.parent_id, 0) ASC, c.sort_order ASC, c.id ASC`
    )
    .all();
  res.json({ items: rows });
});

router.post('/categories', requirePermission('masters', 'can_create'), (req: AuthRequest, res) => {
  const { name, group_code, parent_id, is_group, description, is_raw_material, is_finished_good, is_packaging, sort_order } =
    req.body as Record<string, unknown>;
  if (!name || !String(name).trim()) {
    res.status(400).json({ error: 'Group / Category name is required' });
    return;
  }
  try {
    const cleanName = String(name).trim();
    const cleanCode = String(group_code || cleanName).trim().toUpperCase();
    const r = getDb()
      .prepare(
        `INSERT INTO item_categories (group_code, name, parent_id, is_group, description, is_raw_material, is_finished_good, is_packaging, sort_order)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        cleanCode,
        cleanName,
        parent_id ? Number(parent_id) : null,
        is_group === 0 ? 0 : 1,
        description || '',
        is_raw_material ? 1 : 0,
        is_finished_good ? 1 : 0,
        is_packaging ? 1 : 0,
        Number(sort_order || 0)
      );
    const id = Number(r.lastInsertRowid);
    recordAuditLog(getDb(), req.user, 'ItemGroup', id, cleanCode, 'Create Item Group', { name: cleanName, parent_id });
    res.status(201).json({ id, group_code: cleanCode, name: cleanName });
  } catch (err: unknown) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Failed to create category' });
  }
});

router.put('/categories/:id', requirePermission('masters', 'can_edit'), (req: AuthRequest, res) => {
  const id = Number(req.params.id);
  const b = req.body as Record<string, unknown>;
  if (b.parent_id && Number(b.parent_id) === id) {
    res.status(400).json({ error: 'A group cannot be its own parent' });
    return;
  }
  try {
    getDb()
      .prepare(
        `UPDATE item_categories SET
          name = COALESCE(?, name),
          group_code = COALESCE(?, group_code),
          parent_id = ?,
          is_group = COALESCE(?, is_group),
          description = COALESCE(?, description),
          is_raw_material = COALESCE(?, is_raw_material),
          is_finished_good = COALESCE(?, is_finished_good),
          is_packaging = COALESCE(?, is_packaging),
          sort_order = COALESCE(?, sort_order)
         WHERE id = ?`
      )
      .run(
        b.name ? String(b.name).trim() : null,
        b.group_code ? String(b.group_code).trim().toUpperCase() : null,
        b.parent_id ? Number(b.parent_id) : null,
        b.is_group ?? null,
        b.description ?? null,
        b.is_raw_material ?? null,
        b.is_finished_good ?? null,
        b.is_packaging ?? null,
        b.sort_order ?? null,
        id
      );
    recordAuditLog(getDb(), req.user, 'ItemGroup', id, String(b.group_code || id), 'Update Item Group', b);
    res.json({ ok: true });
  } catch (err: unknown) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Failed to update category' });
  }
});

router.get('/uoms', (_req, res) => {
  const db = getDb();
  const uoms = db.prepare('SELECT * FROM uoms ORDER BY code ASC').all();
  const conversions = db
    .prepare('SELECT uc.*, i.item_code, i.name as item_name FROM uom_conversions uc LEFT JOIN items i ON i.id = uc.item_id')
    .all();
  res.json({ uoms, conversions });
});

router.post('/uoms', requirePermission('masters', 'can_create'), (req, res) => {
  const { code, name } = req.body as { code?: string; name?: string };
  if (!code || !name) {
    res.status(400).json({ error: 'UOM code and name are required' });
    return;
  }
  try {
    getDb().prepare('INSERT INTO uoms (code, name, is_active) VALUES (?, ?, 1)').run(code.trim().toUpperCase(), name.trim());
    res.status(201).json({ ok: true });
  } catch (err: unknown) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Failed to add UOM' });
  }
});

router.post('/uom-conversions', requirePermission('masters', 'can_create'), (req, res) => {
  const { item_id, from_uom, to_uom, factor } = req.body as { item_id?: number; from_uom?: string; to_uom?: string; factor?: number };
  if (!from_uom || !to_uom || !factor) {
    res.status(400).json({ error: 'From UOM, To UOM, and conversion factor are required' });
    return;
  }
  const r = getDb()
    .prepare('INSERT INTO uom_conversions (item_id, from_uom, to_uom, factor) VALUES (?, ?, ?, ?)')
    .run(item_id || null, from_uom, to_uom, factor);
  res.status(201).json({ id: r.lastInsertRowid });
});

router.get('/warehouses', (_req, res) => {
  res.json({ items: getDb().prepare('SELECT * FROM warehouses ORDER BY id ASC').all() });
});

router.post('/warehouses', requirePermission('masters', 'can_create'), (req: AuthRequest, res) => {
  const { code, name, location, warehouse_type, is_subcontractor } = req.body as Record<string, unknown>;
  if (!code || !name) {
    res.status(400).json({ error: 'Warehouse code and name are required' });
    return;
  }
  try {
    const cleanCode = String(code).trim().toUpperCase();
    const r = getDb()
      .prepare('INSERT INTO warehouses (code, name, location, warehouse_type, is_subcontractor, is_active) VALUES (?, ?, ?, ?, ?, 1)')
      .run(cleanCode, String(name).trim(), location || '', warehouse_type || 'Standard', is_subcontractor ? 1 : 0);
    recordAuditLog(getDb(), req.user, 'Warehouse', Number(r.lastInsertRowid), cleanCode, 'Create Warehouse', { name });
    res.status(201).json({ id: r.lastInsertRowid });
  } catch (err: unknown) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Failed to create warehouse' });
  }
});

router.put('/warehouses/:id', requirePermission('masters', 'can_edit'), (req: AuthRequest, res) => {
  const id = Number(req.params.id);
  const b = req.body as Record<string, unknown>;
  try {
    getDb()
      .prepare(
        `UPDATE warehouses SET
          code = COALESCE(?, code),
          name = COALESCE(?, name),
          location = COALESCE(?, location),
          warehouse_type = COALESCE(?, warehouse_type),
          is_subcontractor = COALESCE(?, is_subcontractor),
          is_active = COALESCE(?, is_active)
         WHERE id = ?`
      )
      .run(
        b.code ? String(b.code).trim().toUpperCase() : null,
        b.name ?? null,
        b.location ?? null,
        b.warehouse_type ?? null,
        b.is_subcontractor ?? null,
        b.is_active ?? null,
        id
      );
    recordAuditLog(getDb(), req.user, 'Warehouse', id, String(b.code || id), 'Update Warehouse', b);
    res.json({ ok: true });
  } catch (err: unknown) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Failed to update warehouse' });
  }
});

// Storage Tanks (for Base Oils, Additives, Solvents, Bulk Blends)
router.get('/tanks', (_req, res) => {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT st.*, w.code as warehouse_code, w.name as warehouse_name,
              i.item_code as assigned_item_code, i.name as assigned_item_name, i.stock_uom as item_uom,
              CASE WHEN st.capacity_qty > 0 THEN ROUND((st.current_qty / st.capacity_qty) * 100, 1) ELSE 0 END as fill_pct
       FROM storage_tanks st
       JOIN warehouses w ON w.id = st.warehouse_id
       LEFT JOIN items i ON i.id = st.assigned_item_id
       ORDER BY w.id ASC, st.tank_code ASC`
    )
    .all();
  res.json({ items: rows });
});

router.post('/tanks', requirePermission('masters', 'can_create'), (req: AuthRequest, res) => {
  const b = req.body as Record<string, unknown>;
  if (!b.tank_code || !b.name || !b.warehouse_id) {
    res.status(400).json({ error: 'Tank code, name, and warehouse are required' });
    return;
  }
  try {
    const cleanCode = String(b.tank_code).trim().toUpperCase();
    const r = getDb()
      .prepare(
        `INSERT INTO storage_tanks (tank_code, name, warehouse_id, tank_type, capacity_qty, uom, assigned_item_id, current_qty, min_heel_qty, temperature_c, notes, is_active, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        cleanCode,
        String(b.name).trim(),
        Number(b.warehouse_id),
        b.tank_type || 'Base Oil',
        Number(b.capacity_qty || 10000),
        b.uom || 'LTR',
        b.assigned_item_id ? Number(b.assigned_item_id) : null,
        Number(b.current_qty || 0),
        Number(b.min_heel_qty || 0),
        Number(b.temperature_c ?? 25),
        b.notes || '',
        b.is_active === 0 ? 0 : 1,
        nowISO()
      );
    const id = Number(r.lastInsertRowid);
    recordAuditLog(getDb(), req.user, 'StorageTank', id, cleanCode, 'Create Storage Tank', { name: b.name });
    res.status(201).json({ id, tank_code: cleanCode });
  } catch (err: unknown) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Failed to create storage tank' });
  }
});

router.put('/tanks/:id', requirePermission('masters', 'can_edit'), (req: AuthRequest, res) => {
  const id = Number(req.params.id);
  const b = req.body as Record<string, unknown>;
  try {
    const db = getDb();
    const existing = db.prepare('SELECT * FROM storage_tanks WHERE id = ?').get(id) as
      | { current_qty: number; assigned_item_id: number | null; tank_code: string }
      | undefined;
    if (!existing) {
      res.status(404).json({ error: 'Tank not found' });
      return;
    }
    const newItemId = b.assigned_item_id === undefined ? existing.assigned_item_id : b.assigned_item_id ? Number(b.assigned_item_id) : null;
    if (existing.current_qty > 0 && b.assigned_item_id !== undefined && newItemId !== existing.assigned_item_id) {
      res.status(400).json({ error: `Cannot change assigned material while tank ${existing.tank_code} has ${existing.current_qty} remaining.` });
      return;
    }
    db.prepare(
      `UPDATE storage_tanks SET
        tank_code = COALESCE(?, tank_code),
        name = COALESCE(?, name),
        warehouse_id = COALESCE(?, warehouse_id),
        tank_type = COALESCE(?, tank_type),
        capacity_qty = COALESCE(?, capacity_qty),
        uom = COALESCE(?, uom),
        assigned_item_id = ?,
        min_heel_qty = COALESCE(?, min_heel_qty),
        temperature_c = COALESCE(?, temperature_c),
        notes = COALESCE(?, notes),
        is_active = COALESCE(?, is_active)
       WHERE id = ?`
    ).run(
      b.tank_code ? String(b.tank_code).trim().toUpperCase() : null,
      b.name ?? null,
      b.warehouse_id ? Number(b.warehouse_id) : null,
      b.tank_type ?? null,
      b.capacity_qty !== undefined ? Number(b.capacity_qty) : null,
      b.uom ?? null,
      newItemId,
      b.min_heel_qty !== undefined ? Number(b.min_heel_qty) : null,
      b.temperature_c !== undefined ? Number(b.temperature_c) : null,
      b.notes ?? null,
      b.is_active ?? null,
      id
    );
    recordAuditLog(db, req.user, 'StorageTank', id, existing.tank_code, 'Update Storage Tank', b);
    res.json({ ok: true });
  } catch (err: unknown) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Failed to update storage tank' });
  }
});

router.post('/tanks/:id/assign', requirePermission('inventory', 'can_edit'), (req: AuthRequest, res) => {
  const id = Number(req.params.id);
  const { item_id } = req.body as { item_id?: number | null };
  try {
    const db = getDb();
    const existing = db.prepare('SELECT * FROM storage_tanks WHERE id = ?').get(id) as
      | { current_qty: number; assigned_item_id: number | null; tank_code: string }
      | undefined;
    if (!existing) {
      res.status(404).json({ error: 'Tank not found' });
      return;
    }
    if (existing.current_qty > 0 && item_id !== existing.assigned_item_id) {
      res.status(400).json({ error: `Tank ${existing.tank_code} has ${existing.current_qty} remaining. Drain tank before reassigning.` });
      return;
    }
    db.prepare('UPDATE storage_tanks SET assigned_item_id = ? WHERE id = ?').run(item_id || null, id);
    recordAuditLog(db, req.user, 'StorageTank', id, existing.tank_code, 'Assign Tank Material', { item_id: item_id || null });
    res.json({ ok: true });
  } catch (err: unknown) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Failed to assign material to tank' });
  }
});

router.get('/currencies', (_req, res) => {
  const db = getDb();
  const currencies = db.prepare('SELECT * FROM currencies ORDER BY is_base DESC, code ASC').all();
  const exchangeRates = db.prepare('SELECT * FROM exchange_rates ORDER BY effective_date DESC, id DESC').all();
  res.json({ currencies, exchangeRates });
});

router.post('/exchange-rates', requirePermission('masters', 'can_create'), (req: AuthRequest, res) => {
  const { from_currency, to_currency, rate, effective_date } = req.body as {
    from_currency?: string;
    to_currency?: string;
    rate?: number;
    effective_date?: string;
  };
  if (!from_currency || !to_currency || !rate) {
    res.status(400).json({ error: 'Currencies and rate are required' });
    return;
  }
  const r = getDb()
    .prepare('INSERT INTO exchange_rates (from_currency, to_currency, rate, effective_date, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(from_currency, to_currency, rate, effective_date || todayISO(), req.user!.id, nowISO());
  res.status(201).json({ id: r.lastInsertRowid });
});

router.get('/payment-terms', (_req, res) => {
  const db = getDb();
  const terms = db.prepare('SELECT * FROM payment_terms ORDER BY id ASC').all() as Record<string, unknown>[];
  const lines = db.prepare('SELECT * FROM payment_term_lines ORDER BY payment_term_id, installment_no').all() as { payment_term_id: number }[];
  const enriched = terms.map((t) => ({
    ...t,
    lines: lines.filter((l) => l.payment_term_id === Number(t.id)),
  }));
  res.json({ items: enriched });
});

router.post('/payment-terms', requirePermission('masters', 'can_create'), (req, res) => {
  const { name, description, lines } = req.body as {
    name?: string;
    description?: string;
    lines?: { installment_no: number; percentage: number; days_due: number; payment_mode: string }[];
  };
  if (!name || !lines || lines.length === 0) {
    res.status(400).json({ error: 'Name and installment lines are required' });
    return;
  }
  const totalPct = lines.reduce((s, l) => s + Number(l.percentage || 0), 0);
  if (Math.abs(totalPct - 100) > 0.01) {
    res.status(400).json({ error: 'Installment percentages must total 100%' });
    return;
  }
  try {
    const id = withTransaction((db) => {
      const r = db.prepare('INSERT INTO payment_terms (name, description, is_active) VALUES (?, ?, 1)').run(name.trim(), description || '');
      const ptId = Number(r.lastInsertRowid);
      const ins = db.prepare('INSERT INTO payment_term_lines (payment_term_id, installment_no, percentage, days_due, payment_mode) VALUES (?, ?, ?, ?, ?)');
      for (const l of lines) ins.run(ptId, l.installment_no, l.percentage, l.days_due, l.payment_mode || 'Bank Transfer');
      return ptId;
    });
    res.status(201).json({ id });
  } catch (err: unknown) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Failed to create payment term' });
  }
});

// Price Lists & Automatic Price Lookup
router.get('/price-lists', (_req, res) => {
  const db = getDb();
  const lists = db.prepare('SELECT * FROM price_lists ORDER BY id DESC').all() as Record<string, unknown>[];
  const items = db
    .prepare(
      `SELECT pli.*, i.item_code, i.name as item_name
       FROM price_list_items pli
       JOIN items i ON i.id = pli.item_id
       ORDER BY pli.id ASC`
    )
    .all() as { price_list_id: number }[];
  res.json({
    items: lists.map((l) => ({
      ...l,
      lines: items.filter((it) => it.price_list_id === Number(l.id)),
    })),
  });
});

router.post('/price-lists', requirePermission('masters', 'can_create'), (req, res) => {
  const { name, list_type, currency, country, party_type, party_id, effective_from, effective_to, lines } = req.body as {
    name?: string;
    list_type?: string;
    currency?: string;
    country?: string;
    party_type?: string;
    party_id?: number;
    effective_from?: string;
    effective_to?: string;
    lines?: { item_id: number; min_qty: number; rate: number; discount_pct: number; is_promotional?: number }[];
  };
  if (!name) {
    res.status(400).json({ error: 'Price list name is required' });
    return;
  }
  try {
    const id = withTransaction((db) => {
      const r = db
        .prepare(
          `INSERT INTO price_lists (name, list_type, currency, country, party_type, party_id, effective_from, effective_to, is_active)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`
        )
        .run(name, list_type || 'Sales', currency || 'AED', country || '', party_type || '', party_id || null, effective_from || '', effective_to || '');
      const plId = Number(r.lastInsertRowid);
      if (Array.isArray(lines)) {
        const ins = db.prepare('INSERT INTO price_list_items (price_list_id, item_id, min_qty, rate, discount_pct, is_promotional) VALUES (?, ?, ?, ?, ?, ?)');
        for (const l of lines) ins.run(plId, l.item_id, l.min_qty || 1, l.rate, l.discount_pct || 0, l.is_promotional ? 1 : 0);
      }
      return plId;
    });
    res.status(201).json({ id });
  } catch (err: unknown) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Failed to create price list' });
  }
});

router.get('/price-lookup', (req, res) => {
  const db = getDb();
  const itemId = Number(req.query.item_id);
  const qty = Number(req.query.qty || 1);
  const priceListId = req.query.price_list_id ? Number(req.query.price_list_id) : null;
  const partyId = req.query.party_id ? Number(req.query.party_id) : null;
  const listType = String(req.query.list_type || 'Sales');

  const item = db.prepare('SELECT standard_cost, last_purchase_price, selling_price, vat_rate FROM items WHERE id = ?').get(itemId) as
    | { standard_cost: number; last_purchase_price: number; selling_price: number; vat_rate: number }
    | undefined;
  if (!item) {
    res.status(404).json({ error: 'Item not found' });
    return;
  }

  let match: { rate: number; discount_pct: number; source: string } | null = null;
  if (priceListId) {
    const row = db
      .prepare(
        `SELECT rate, discount_pct FROM price_list_items
         WHERE price_list_id = ? AND item_id = ? AND min_qty <= ?
         ORDER BY min_qty DESC LIMIT 1`
      )
      .get(priceListId, itemId, qty) as { rate: number; discount_pct: number } | undefined;
    if (row) match = { rate: row.rate, discount_pct: row.discount_pct, source: 'Selected Price List' };
  }

  if (!match && partyId) {
    const row = db
      .prepare(
        `SELECT pli.rate, pli.discount_pct, pl.name
         FROM price_list_items pli
         JOIN price_lists pl ON pl.id = pli.price_list_id
         WHERE pl.list_type = ? AND pl.party_id = ? AND pli.item_id = ? AND pli.min_qty <= ? AND pl.is_active = 1
         ORDER BY pli.min_qty DESC LIMIT 1`
      )
      .get(listType, partyId, itemId, qty) as { rate: number; discount_pct: number; name: string } | undefined;
    if (row) match = { rate: row.rate, discount_pct: row.discount_pct, source: row.name };
  }

  const fallbackRate = listType === 'Purchase' ? item.last_purchase_price || item.standard_cost : item.selling_price;
  res.json({
    rate: roundMoney(match ? match.rate : fallbackRate),
    discount_pct: match ? match.discount_pct : 0,
    vat_rate: item.vat_rate,
    source: match ? match.source : 'Item Master Default',
  });
});

export default router;
