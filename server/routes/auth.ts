Attempting to perform the InitializeDefaultDrives operation on the 'FileSystem' provider failed.
import bcrypt from 'bcryptjs';
import fs from 'fs';
import path from 'path';
import { Router } from 'express';
import { UPLOAD_DIR, getDb, USE_POSTGRES, withTransaction } from '../db.ts';
import { authenticate, getJwtSecret, recordAuditLog, signToken, type AuthRequest } from '../middleware/auth.ts';
import { nowISO, safeResolveWithin, todayISO } from '../utils/helpers.ts';
import { postStockMovement } from '../services/inventory.ts';
import { postJournalEntry } from '../services/accounting.ts';

const router = Router();
const BRANDING_DIR = path.join(UPLOAD_DIR, 'branding');

router.get('/status', (_req, res) => {
  const db = getDb();
  const count = (db.prepare('SELECT COUNT(*) as c FROM users').get() as { c: number }).c;
  const company = db
    .prepare(
      'SELECT id, name, short_name, logo_path, logo_blob, logo_mime_type, address, po_box, country, trn, telephone, email, website, currency, vat_rate, vat_enabled FROM companies LIMIT 1'
    )
    .get() as Record<string, unknown> | undefined;

  res.json({
    needsSetup: count === 0,
    hasEnvAdminPassword: Boolean(process.env.ADMIN_INITIAL_PASSWORD && process.env.ADMIN_INITIAL_PASSWORD.trim()),
    company: company
      ? {
          ...company,
          logo_url: company.logo_path ? `/api/auth/logo?v=${encodeURIComponent(String(company.logo_path))}` : '',
        }
      : null,
  });
});

router.get('/logo', (_req, res) => {
  const db = getDb();
  const row = db.prepare('SELECT logo_path, logo_blob, logo_mime_type FROM companies LIMIT 1').get() as { logo_path?: string; logo_blob?: Buffer | null; logo_mime_type?: string } | undefined;
  const fileName = row?.logo_path ? path.basename(String(row.logo_path)) : '';
  if (!fileName) {
    res.status(404).end();
    return;
  }
  if (row?.logo_blob) {
    res.setHeader('Content-Type', row.logo_mime_type || 'image/png');
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.send(row.logo_blob);
    return;
  }
  try {
    const filePath = safeResolveWithin(BRANDING_DIR, fileName);
    if (!fs.existsSync(filePath)) {
      res.status(404).end();
      return;
    }
    res.setHeader('Cache-Control', 'no-store, max-age=0');
    res.sendFile(filePath);
  } catch {
    res.status(404).end();
  }
});

router.post('/setup-admin', (req, res) => {
  const { username, email, fullName, password } = req.body as {
    username?: string;
    email?: string;
    fullName?: string;
    password?: string;
  };

  if (!username || !email || !fullName || !password) {
    res.status(400).json({ error: 'Username, email, full name, and password are required' });
    return;
  }
  if (password.length < 8) {
    res.status(400).json({ error: 'Password must be at least 8 characters' });
    return;
  }
  try {
    getJwtSecret();
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Production JWT configuration is missing' });
    return;
  }

  try {
    const result = withTransaction((db) => {
      if (USE_POSTGRES) db.prepare('SELECT pg_advisory_xact_lock(624830212)').get();
      const existing = (db.prepare('SELECT COUNT(*) as c FROM users').get() as { c: number }).c;
      if (existing > 0) {
        throw new Error('Administrator account already initialized. Please sign in.');
      }
      const superRole = db.prepare("SELECT id, name FROM roles WHERE name = 'Super Admin'").get() as { id: number; name: string };
      const hash = bcrypt.hashSync(password, 10);
      const now = nowISO();
      const ins = db
        .prepare(
          `INSERT INTO users (username, email, full_name, password_hash, role_id, department, is_active, last_login_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 'Management', 1, ?, ?, ?)`
        )
        .run(username.trim(), email.trim().toLowerCase(), fullName.trim(), hash, superRole.id, now, now, now);

      const user = {
        id: Number(ins.lastInsertRowid),
        username: username.trim(),
        email: email.trim().toLowerCase(),
        full_name: fullName.trim(),
        role_id: superRole.id,
        role_name: superRole.name,
        department: 'Management',
      };
      recordAuditLog(db, user, 'User', user.id, user.username, 'Initial Admin Setup', { role: superRole.name });
      return user;
    });

    const token = signToken(result);
    res.status(201).json({ token, user: result });
  } catch (err: unknown) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Setup failed' });
  }
});

router.post('/login', (req, res) => {
  const { username, password } = req.body as { username?: string; password?: string };
  if (!username || !password) {
    res.status(400).json({ error: 'Username and password are required' });
    return;
  }

  const db = getDb();
  const ident = username.trim();
  const row = db
    .prepare(
      `SELECT u.*, r.name as role_name
       FROM users u
       JOIN roles r ON r.id = u.role_id
       WHERE u.username = ? OR LOWER(u.email) = LOWER(?)`
    )
    .get(ident, ident) as
    | {
        id: number;
        username: string;
        email: string;
        full_name: string;
        password_hash: string;
        role_id: number;
        role_name: string;
        department: string;
        is_active: number;
      }
    | undefined;

  const ip = req.ip || '';
  const ua = req.headers['user-agent'] || '';

  if (!row || !row.is_active) {
    db.prepare('INSERT INTO login_history (user_id, username, ip_address, user_agent, success, reason, created_at) VALUES (?, ?, ?, ?, 0, ?, ?)').run(
      row?.id ?? null,
      ident,
      ip,
      ua,
      !row ? 'User not found' : 'User inactive',
      nowISO()
    );
    res.status(401).json({ error: 'Invalid credentials or inactive account' });
    return;
  }

  // Optional ADMIN_INITIAL_PASSWORD override for Super Admin if configured via server env
  const envPass = process.env.ADMIN_INITIAL_PASSWORD;
  const envOverrideOk = Boolean(envPass && row.role_name === 'Super Admin' && password === envPass);
  const valid = envOverrideOk || bcrypt.compareSync(password, row.password_hash);

  if (!valid) {
    db.prepare('INSERT INTO login_history (user_id, username, ip_address, user_agent, success, reason, created_at) VALUES (?, ?, ?, ?, 0, ?, ?)').run(
      row.id,
      row.username,
      ip,
      ua,
      'Invalid password',
      nowISO()
    );
    res.status(401).json({ error: 'Invalid credentials' });
    return;
  }

  db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(nowISO(), row.id);
  db.prepare('INSERT INTO login_history (user_id, username, ip_address, user_agent, success, reason, created_at) VALUES (?, ?, ?, ?, 1, ?, ?)').run(
    row.id,
    row.username,
    ip,
    ua,
    'Login successful',
    nowISO()
  );

  const user = {
    id: row.id,
    username: row.username,
    email: row.email,
    full_name: row.full_name,
    role_id: row.role_id,
    role_name: row.role_name,
    department: row.department,
  };
  const permissions = db.prepare('SELECT * FROM role_permissions WHERE role_id = ?').all(row.role_id);
  const token = signToken(user);
  res.json({ token, user, permissions });
});

router.post('/logout', authenticate, (req: AuthRequest, res) => {
  const db = getDb();
  recordAuditLog(db, req.user, 'Session', req.user?.id ?? null, req.user?.username ?? '', 'Logout', {});
  res.json({ ok: true });
});

router.get('/me', authenticate, (req: AuthRequest, res) => {
  const db = getDb();
  const permissions = db.prepare('SELECT * FROM role_permissions WHERE role_id = ?').all(req.user!.role_id);
  res.json({ user: req.user, permissions });
});

router.get('/login-history', authenticate, (req: AuthRequest, res) => {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM login_history ORDER BY id DESC LIMIT 100').all();
  res.json({ items: rows });
});

// Optional helper to populate realistic Lubricant Plant Master Data (idempotent)
router.post('/seed-sample-lubricants', authenticate, (req: AuthRequest, res) => {
  if (!['Super Admin', 'Administrator'].includes(req.user!.role_name)) {
    res.status(403).json({ error: 'Only Administrators can load sample lubricant master data' });
    return;
  }

  try {
    const summary = withTransaction((db) => {
      const existingItems = (db.prepare('SELECT COUNT(*) as c FROM items').get() as { c: number }).c;
      if (existingItems > 0) {
        return { alreadyPopulated: true, message: 'Master items already exist in database' };
      }

      const now = nowISO();
      const today = todayISO();
      const catRows = db.prepare('SELECT id, name FROM item_categories').all() as { id: number; name: string }[];
      const catMap = Object.fromEntries(catRows.map((c) => [c.name, c.id]));
      const whRows = db.prepare('SELECT id, code FROM warehouses').all() as { id: number; code: string }[];
      const whMap = Object.fromEntries(whRows.map((w) => [w.code, w.id]));
      const ptRows = db.prepare('SELECT id, name FROM payment_terms').all() as { id: number; name: string }[];
      const ptMap = Object.fromEntries(ptRows.map((p) => [p.name, p.id]));

      // Suppliers
      const suppliers = [
        ['SUP-001', 'ADNOC Base Oils Distribution', 'Khalid Al Mansoori', 'sales@adnoc-base.local', '+971 2 602 0000', 'United Arab Emirates', ptMap['Net 30 Days'], 500000, '100112233400003', 'AED', 'Base Oil Supplier'],
        ['SUP-002', 'Lubrizol Additives Middle East', 'Sarah Jenkins', 'orders@lubrizol-me.local', '+971 4 881 4400', 'United Arab Emirates', ptMap['50% 50d / 50% 80d'], 350000, '100223344500003', 'USD', 'Additive Supplier'],
        ['SUP-003', 'Emirates Blow Moulding & Packaging', 'Tariq Mahmood', 'supply@ebmp.local', '+971 6 534 2100', 'United Arab Emirates', ptMap['Net 45 Days'], 150000, '100334455600003', 'AED', 'Packaging Supplier'],
      ] as const;
      const insSup = db.prepare(`
        INSERT INTO suppliers (code, name, contact_person, email, telephone, country, payment_term_id, credit_limit, trn, currency, category, is_active, created_by, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
      `);
      for (const s of suppliers) insSup.run(...s, req.user!.id, now, now);

      const supMap = Object.fromEntries(
        (db.prepare('SELECT id, code FROM suppliers').all() as { id: number; code: string }[]).map((s) => [s.code, s.id])
      );

      // Customers
      const customers = [
        ['CUST-001', 'Gulf Fleet Transport & Logistics LLC', 'Omar Al Hashimi', 'procurement@gulffleet.local', '+971 4 331 9900', 'United Arab Emirates', ptMap['Net 30 Days'], 250000, '100556677800003', 'AED', 'Fleet Account'],
        ['CUST-002', 'Al-Futtaim Heavy Equipment Trading', 'Rami Khoury', 'parts@afheavy.local', '+971 4 206 7700', 'United Arab Emirates', ptMap['50% 50d / 50% 80d'], 400000, '100667788900003', 'AED', 'Authorized Distributor'],
        ['CUST-003', 'Muscat Marine & Industrial Lubes', 'Salim Al Harthi', 'imports@muscatmarine.local', '+968 24 590 120', 'Oman', ptMap['Net 45 Days'], 300000, 'OM110029384', 'USD', 'Export Distributor'],
      ] as const;
      const insCust = db.prepare(`
        INSERT INTO customers (code, name, contact_person, email, telephone, country, payment_term_id, credit_limit, trn, currency, category, is_active, created_by, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
      `);
      for (const c of customers) insCust.run(...c, req.user!.id, now, now);

      // Items (Raw materials, Additives, Packaging, Semi-finished, Finished Lubricants)
      const items = [
        ['RM-SN150', 'Base Oil Group I SN150', 'Virgin solvent neutral base oil SN150', catMap['Base Oil'], 'ADNOC', 'LTR', 'LTR', 'LTR', 1, 5000, 2000, 30000, 1500, 5, 2000, supMap['SUP-001'], 3.85, 3.85, 0, whMap['WH-RM'], 1, 0],
        ['RM-SN500', 'Base Oil Group I SN500', 'Heavy solvent neutral base oil SN500', catMap['Base Oil'], 'ADNOC', 'LTR', 'LTR', 'LTR', 1, 8000, 3000, 40000, 2000, 5, 2000, supMap['SUP-001'], 4.10, 4.10, 0, whMap['WH-RM'], 1, 0],
        ['ADD-DI20W50', 'Additive Package API SL/CF', 'Multifunctional engine oil additive package', catMap['Additives'], 'Lubrizol', 'KG', 'KG', 'KG', 1, 800, 300, 5000, 200, 14, 200, supMap['SUP-002'], 18.50, 18.50, 0, whMap['WH-RM'], 1, 1],
        ['ADD-VII', 'Viscosity Index Improver OCP', 'Shear-stable olefin copolymer VII', catMap['Additives'], 'Lubrizol', 'KG', 'KG', 'KG', 1, 500, 200, 3000, 150, 14, 200, supMap['SUP-002'], 15.20, 15.20, 0, whMap['WH-RM'], 1, 1],
        ['PKG-BTL-1L', '1L HDPE Bottle (Navy)', '1 Liter high-density polyethylene bottle', catMap['Plastic Bottles'], 'EBMP', 'PCS', 'PCS', 'PCS', 1, 2000, 1000, 20000, 500, 7, 1000, supMap['SUP-003'], 0.85, 0.85, 0, whMap['WH-PKG'], 1, 0],
        ['PKG-CAP-38', '38mm Induction Cap (Gold)', 'Tamper-evident cap with induction wad', catMap['Caps'], 'EBMP', 'PCS', 'PCS', 'PCS', 1, 2000, 1000, 25000, 500, 7, 1000, supMap['SUP-003'], 0.18, 0.18, 0, whMap['WH-PKG'], 1, 0],
        ['PKG-LBL-20W50', 'Label Set 1L 20W50', 'Front & back laminated BOPP label', catMap['Labels'], 'EBMP', 'PCS', 'PCS', 'PCS', 1, 2000, 1000, 25000, 500, 7, 1000, supMap['SUP-003'], 0.22, 0.22, 0, whMap['WH-PKG'], 1, 0],
        ['PKG-CTN-12X1L', 'Master Carton 12x1L', '5-ply corrugated carton holding 12x1L bottles', catMap['Cartons'], 'EBMP', 'CARTON', 'CARTON', 'CARTON', 1, 300, 150, 3000, 100, 7, 200, supMap['SUP-003'], 1.95, 1.95, 0, whMap['WH-PKG'], 1, 0],
        ['PKG-DRUM-208', '208L Steel Drum (Lined)', 'UN-certified 208L closed-head steel drum', catMap['Drums'], 'EBMP', 'DRUM', 'DRUM', 'DRUM', 1, 50, 20, 400, 20, 7, 50, supMap['SUP-003'], 78.00, 78.00, 0, whMap['WH-PKG'], 1, 0],
        ['SF-20W50-BLK', 'Engine Oil 20W50 Bulk Blend', 'Unpackaged blended 20W50 motor oil', catMap['Semi-Finished Products'], 'PetroBlend', 'LTR', 'LTR', 'LTR', 1, 2000, 1000, 25000, 500, 2, 1000, null, 6.20, 6.20, 0, whMap['WH-WIP'], 1, 0],
        ['FG-20W50-1L', 'PetroBlend Super 20W50 SL/CF (1L)', 'High-performance mineral motor oil 1L bottle', catMap['Finished Lubricants'], 'PetroBlend', 'PCS', 'PCS', 'PCS', 1, 600, 300, 12000, 200, 3, 12, null, 8.20, 8.20, 15.50, whMap['WH-FG'], 1, 1],
        ['FG-AW68-DRUM', 'PetroBlend Hydraulic AW 68 (208L Drum)', 'Anti-wear hydraulic oil ISO VG 68 in 208L drum', catMap['Finished Lubricants'], 'PetroBlend', 'DRUM', 'DRUM', 'DRUM', 1, 10, 5, 150, 5, 3, 1, null, 980.00, 980.00, 1590.00, whMap['WH-FG'], 1, 1],
      ] as const;

      const insItem = db.prepare(`
        INSERT INTO items (
          item_code, name, description, category_id, brand, purchase_uom, stock_uom, sales_uom, conversion_factor,
          reorder_level, min_stock, max_stock, safety_stock, lead_time_days, moq, preferred_supplier_id,
          standard_cost, average_cost, selling_price, default_warehouse_id, batch_tracking, expiry_tracking,
          vat_rate, tax_category, valuation_method, is_active, created_by, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 5.0, 'Standard Rated', 'Moving Average', 1, ?, ?, ?)
      `);

      for (const it of items) {
        insItem.run(...it, req.user!.id, now, now);
      }

      const itemMap = Object.fromEntries(
        (db.prepare('SELECT id, item_code FROM items').all() as { id: number; item_code: string }[]).map((i) => [i.item_code, i.id])
      );

      const tankRows = db.prepare('SELECT id, tank_code FROM storage_tanks').all() as { id: number; tank_code: string }[];
      const tankMap = Object.fromEntries(tankRows.map((t) => [t.tank_code, t.id]));

      // Opening Inventory + Balanced Equity Journal Entry
      const openingStock: [string, number, number, string, string, string | null][] = [
        ['RM-SN150', 18000, 3.85, 'WH-RM', 'B-SN150-2026-01', 'TK-BO-01'],
        ['RM-SN500', 22000, 4.10, 'WH-RM', 'B-SN500-2026-01', 'TK-BO-02'],
        ['ADD-DI20W50', 2400, 18.50, 'WH-RM', 'B-DI50-2026-01', 'TK-ADD-01'],
        ['ADD-VII', 1500, 15.20, 'WH-RM', 'B-VII-2026-01', 'TK-ADD-02'],
        ['PKG-BTL-1L', 12000, 0.85, 'WH-PKG', 'B-BTL1L-2026-01', null],
        ['PKG-CAP-38', 15000, 0.18, 'WH-PKG', 'B-CAP38-2026-01', null],
        ['PKG-LBL-20W50', 15000, 0.22, 'WH-PKG', 'B-LBL20W50-2026-01', null],
        ['PKG-CTN-12X1L', 1200, 1.95, 'WH-PKG', 'B-CTN12-2026-01', null],
        ['PKG-DRUM-208', 120, 78.00, 'WH-PKG', 'B-DRM208-2026-01', null],
        ['FG-20W50-1L', 1800, 8.20, 'WH-FG', 'B-FG20W50-2601', null],
        ['FG-AW68-DRUM', 24, 980.00, 'WH-FG', 'B-FGAW68-2601', null],
      ];

      let rmVal = 0;
      let fgVal = 0;
      for (const [code, qty, cost, whCode, batchNo, tankCode] of openingStock) {
        postStockMovement(db, {
          postingDate: today,
          docType: 'OpeningStock',
          docId: 1,
          docNumber: 'OPEN-2026',
          itemId: itemMap[code],
          warehouseId: whMap[whCode],
          tankId: tankCode ? tankMap[tankCode] ?? null : null,
          batchNumber: batchNo,
          inwardQty: qty,
          unitCost: cost,
          mfgDate: today,
          qcStatus: 'Released',
          remarks: 'Opening inventory balance',
          userId: req.user!.id,
        });
        if (whCode === 'WH-FG') fgVal += qty * cost;
        else rmVal += qty * cost;
      }

      const cashCapital = 500000;
      const totalEquity = rmVal + fgVal + cashCapital;
      postJournalEntry(db, {
        postingDate: today,
        entryType: 'Opening Entry',
        refDocType: 'OpeningBalance',
        refDocId: 1,
        refDocNumber: 'OPEN-2026',
        narration: 'Opening capital, bank cash, and lubricant inventory balances',
        lines: [
          { accountCode: '1110', debit: cashCapital, description: 'Opening Bank Balance (ENBD)' },
          { accountCode: '1300', debit: rmVal, description: 'Opening Raw Material & Packaging Stock' },
          { accountCode: '1320', debit: fgVal, description: 'Opening Finished Lubricants Stock' },
          { accountCode: '3100', credit: totalEquity, description: 'Owner Share Capital' },
        ],
        userId: req.user!.id,
      });

      db.prepare('UPDATE bank_accounts SET current_balance = ? WHERE account_number = ?').run(cashCapital, '101488291001');

      // Approved BOM for Engine Oil 20W50 (1L Bottle, Batch Size 1000 units = 1000 LTR)
      const bomRes = db
        .prepare(
          `INSERT INTO boms (bom_number, version, finished_item_id, batch_size, uom, labour_cost, overhead_cost, expected_wastage_pct, effective_date, is_active, is_approved, approved_by, notes, created_by, created_at)
           VALUES ('BOM-0001', 'v1.0', ?, 1000, 'PCS', 450, 350, 0.5, ?, 1, 1, ?, 'Standard 1000-unit (1000L) 20W50 API SL/CF formulation & 12x1L carton pack', ?, ?)`
        )
        .run(itemMap['FG-20W50-1L'], today, req.user!.id, req.user!.id, now);
      const bomId = Number(bomRes.lastInsertRowid);
      db.prepare("UPDATE document_sequences SET next_number = 2 WHERE doc_type = 'BOM'").run();

      const bomLines: [string, string, number, string, number, number][] = [
        ['RM-SN150', 'Formula', 420, 'LTR', 3.85, 0],
        ['RM-SN500', 'Formula', 460, 'LTR', 4.10, 0],
        ['ADD-DI20W50', 'Formula', 85, 'KG', 18.50, 0],
        ['ADD-VII', 'Formula', 35, 'KG', 15.20, 0],
        ['PKG-BTL-1L', 'Packaging', 1000, 'PCS', 0.85, 0],
        ['PKG-CAP-38', 'Packaging', 1000, 'PCS', 0.18, 0],
        ['PKG-LBL-20W50', 'Packaging', 1000, 'PCS', 0.22, 0],
        ['PKG-CTN-12X1L', 'Packaging', 84, 'CARTON', 1.95, 12],
      ];
      const insBomItem = db.prepare(
        `INSERT INTO bom_items (bom_id, item_id, component_type, qty, uom, standard_cost, wastage_pct, carton_packing_qty)
         VALUES (?, ?, ?, ?, ?, ?, 0, ?)`
      );
      for (const [code, ctype, q, u, cost, cpq] of bomLines) {
        insBomItem.run(bomId, itemMap[code], ctype, q, u, cost, cpq);
      }

      // Price List
      const plRes = db
        .prepare("INSERT INTO price_lists (name, list_type, currency, effective_from, is_active) VALUES ('UAE Wholesale Distributor 2026', 'Sales', 'AED', ?, 1)")
        .run(today);
      db.prepare('INSERT INTO price_list_items (price_list_id, item_id, min_qty, rate, discount_pct) VALUES (?, ?, 1, 15.50, 0)').run(plRes.lastInsertRowid, itemMap['FG-20W50-1L']);
      db.prepare('INSERT INTO price_list_items (price_list_id, item_id, min_qty, rate, discount_pct) VALUES (?, ?, 100, 14.25, 5)').run(plRes.lastInsertRowid, itemMap['FG-20W50-1L']);
      db.prepare('INSERT INTO price_list_items (price_list_id, item_id, min_qty, rate, discount_pct) VALUES (?, ?, 1, 1590.00, 0)').run(plRes.lastInsertRowid, itemMap['FG-AW68-DRUM']);

      // Subcontractor
      db.prepare(
        `INSERT INTO subcontractors (code, name, contact_person, phone, email, address, warehouse_id, is_active, created_at)
         VALUES ('SUB-001', 'Sharjah Toll Blending Services LLC', 'Faisal Al Qasimi', '+971 6 558 1122', 'ops@sharjahblend.local', 'Sajaa Industrial Area, Sharjah', ?, 1, ?)`
      ).run(whMap['WH-SUB'], now);

      // Sample Employee
      const dept = db.prepare("SELECT id FROM departments WHERE name = 'Production & Blending'").get() as { id: number };
      const des = db.prepare("SELECT id FROM designations WHERE name = 'Master Blender'").get() as { id: number };
      db.prepare(
        `INSERT INTO employees (emp_code, full_name, email, phone, department_id, designation_id, join_date, basic_salary, allowances, user_id, status, created_at)
         VALUES ('EMP-001', 'Hassan Al Zaabi', 'hassan@petroblend-erp.local', '+971 50 555 8120', ?, ?, '2024-03-01', 9500, 3500, ?, 'Active', ?)`
      ).run(dept.id, des.id, req.user!.id, now);

      recordAuditLog(db, req.user, 'System', null, 'SEED', 'Load Sample Lubricant Dataset', { items: items.length, bomId });
      return { alreadyPopulated: false, itemsCreated: items.length, suppliersCreated: suppliers.length, customersCreated: customers.length, bomNumber: 'BOM-0001' };
    });

    res.json(summary);
  } catch (err: unknown) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Failed to load sample dataset' });
  }
});

export default router;
