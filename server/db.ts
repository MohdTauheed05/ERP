import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { nowISO, todayISO } from './utils/helpers.ts';

function resolveSqlitePath(): string {
  const dbUrl = process.env.DATABASE_URL || 'sqlite:///./data/lubricants_erp.db';
  if (dbUrl.startsWith('sqlite:///')) {
    const raw = dbUrl.replace('sqlite:///', '');
    return path.resolve(process.cwd(), raw);
  }
  throw new Error(
    'Unsupported DATABASE_URL. The Express ERP API currently supports SQLite only; PostgreSQL/Firebase SQL Connect support is not implemented. Refusing to silently start with a new local SQLite database.'
  );
}

export const DB_FILE_PATH = resolveSqlitePath();
export const UPLOAD_DIR = path.resolve(process.cwd(), process.env.UPLOAD_DIR || './uploads');

let dbInstance: Database.Database | null = null;

export function getDb(): Database.Database {
  if (!dbInstance) {
    fs.mkdirSync(path.dirname(DB_FILE_PATH), { recursive: true });
    fs.mkdirSync(UPLOAD_DIR, { recursive: true });
    fs.mkdirSync(path.resolve(process.cwd(), process.env.BACKUP_DIR || './backups'), { recursive: true });

    dbInstance = new Database(DB_FILE_PATH);
    dbInstance.pragma('journal_mode = WAL');
    dbInstance.pragma('foreign_keys = ON');
    dbInstance.pragma('busy_timeout = 5000');
    initializeSchema(dbInstance);
    seedReferenceData(dbInstance);
  }
  return dbInstance;
}

export function resetDbConnection(): void {
  if (dbInstance) {
    dbInstance.close();
    dbInstance = null;
  }
}

export function withTransaction<T>(fn: (db: Database.Database) => T): T {
  const db = getDb();
  const tx = db.transaction(() => fn(db));
  return tx();
}

function initializeSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      description TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS companies (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      short_name TEXT DEFAULT '',
      logo_path TEXT DEFAULT '',
      address TEXT DEFAULT '',
      po_box TEXT DEFAULT '',
      country TEXT DEFAULT 'United Arab Emirates',
      trn TEXT DEFAULT '',
      telephone TEXT DEFAULT '',
      email TEXT DEFAULT '',
      website TEXT DEFAULT '',
      currency TEXT NOT NULL DEFAULT 'AED',
      financial_year_start TEXT DEFAULT '2026-01-01',
      financial_year_end TEXT DEFAULT '2026-12-31',
      vat_rate REAL NOT NULL DEFAULT 5.0,
      vat_enabled INTEGER NOT NULL DEFAULT 1,
      letterhead_html TEXT DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS roles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      description TEXT DEFAULT '',
      is_system INTEGER NOT NULL DEFAULT 0,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS role_permissions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      role_id INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
      module TEXT NOT NULL,
      doc_type TEXT NOT NULL,
      can_view INTEGER NOT NULL DEFAULT 0,
      can_create INTEGER NOT NULL DEFAULT 0,
      can_edit INTEGER NOT NULL DEFAULT 0,
      can_delete INTEGER NOT NULL DEFAULT 0,
      can_submit INTEGER NOT NULL DEFAULT 0,
      can_cancel INTEGER NOT NULL DEFAULT 0,
      can_amend INTEGER NOT NULL DEFAULT 0,
      can_approve INTEGER NOT NULL DEFAULT 0,
      can_export INTEGER NOT NULL DEFAULT 0,
      can_print INTEGER NOT NULL DEFAULT 0,
      UNIQUE(role_id, module, doc_type)
    );

    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE,
      email TEXT NOT NULL UNIQUE,
      full_name TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      role_id INTEGER NOT NULL REFERENCES roles(id),
      department TEXT DEFAULT 'Management',
      is_active INTEGER NOT NULL DEFAULT 1,
      last_login_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS login_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER REFERENCES users(id),
      username TEXT NOT NULL,
      ip_address TEXT DEFAULT '',
      user_agent TEXT DEFAULT '',
      success INTEGER NOT NULL,
      reason TEXT DEFAULT '',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS audit_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER REFERENCES users(id),
      username TEXT NOT NULL,
      doc_type TEXT NOT NULL,
      doc_id INTEGER,
      doc_number TEXT DEFAULT '',
      action TEXT NOT NULL,
      changes_json TEXT DEFAULT '{}',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS document_sequences (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      doc_type TEXT NOT NULL UNIQUE,
      prefix TEXT NOT NULL,
      next_number INTEGER NOT NULL DEFAULT 1,
      digits INTEGER NOT NULL DEFAULT 4,
      financial_year TEXT DEFAULT '2026',
      include_fy INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS system_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT 'general',
      description TEXT DEFAULT '',
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS saved_filters (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      doc_type TEXT NOT NULL,
      name TEXT NOT NULL,
      filter_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER REFERENCES users(id),
      role_id INTEGER REFERENCES roles(id),
      type TEXT NOT NULL,
      title TEXT NOT NULL,
      message TEXT NOT NULL,
      doc_type TEXT DEFAULT '',
      doc_id INTEGER,
      is_read INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS attachments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      doc_type TEXT NOT NULL,
      doc_id INTEGER NOT NULL,
      file_name TEXT NOT NULL,
      stored_name TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      uploaded_by INTEGER REFERENCES users(id),
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS approval_rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      doc_type TEXT NOT NULL,
      department TEXT DEFAULT '',
      role_id INTEGER NOT NULL REFERENCES roles(id),
      min_amount REAL NOT NULL DEFAULT 0,
      max_amount REAL,
      currency TEXT DEFAULT 'AED',
      warehouse_id INTEGER,
      priority INTEGER NOT NULL DEFAULT 1,
      is_active INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS approval_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      doc_type TEXT NOT NULL,
      doc_id INTEGER NOT NULL,
      doc_number TEXT NOT NULL,
      rule_id INTEGER REFERENCES approval_rules(id),
      required_role_id INTEGER REFERENCES roles(id),
      requested_by INTEGER REFERENCES users(id),
      amount REAL NOT NULL DEFAULT 0,
      currency TEXT NOT NULL DEFAULT 'AED',
      status TEXT NOT NULL DEFAULT 'Pending',
      comments TEXT DEFAULT '',
      decided_by INTEGER REFERENCES users(id),
      decided_at TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS approval_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      request_id INTEGER NOT NULL REFERENCES approval_requests(id) ON DELETE CASCADE,
      doc_type TEXT NOT NULL,
      doc_id INTEGER NOT NULL,
      action TEXT NOT NULL,
      actor_id INTEGER REFERENCES users(id),
      comments TEXT DEFAULT '',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS currencies (
      code TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      symbol TEXT NOT NULL,
      is_base INTEGER NOT NULL DEFAULT 0,
      is_active INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS exchange_rates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      from_currency TEXT NOT NULL REFERENCES currencies(code),
      to_currency TEXT NOT NULL REFERENCES currencies(code),
      rate REAL NOT NULL,
      effective_date TEXT NOT NULL,
      created_by INTEGER REFERENCES users(id),
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS uoms (
      code TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      is_active INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS item_categories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      group_code TEXT DEFAULT '',
      name TEXT NOT NULL UNIQUE,
      parent_id INTEGER REFERENCES item_categories(id),
      is_group INTEGER NOT NULL DEFAULT 1,
      description TEXT DEFAULT '',
      is_raw_material INTEGER NOT NULL DEFAULT 0,
      is_finished_good INTEGER NOT NULL DEFAULT 0,
      is_packaging INTEGER NOT NULL DEFAULT 0,
      sort_order INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS warehouses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      location TEXT DEFAULT '',
      warehouse_type TEXT NOT NULL DEFAULT 'Standard',
      is_subcontractor INTEGER NOT NULL DEFAULT 0,
      is_active INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS storage_tanks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tank_code TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      warehouse_id INTEGER NOT NULL REFERENCES warehouses(id),
      tank_type TEXT NOT NULL DEFAULT 'Base Oil',
      capacity_qty REAL NOT NULL DEFAULT 50000,
      uom TEXT NOT NULL DEFAULT 'LTR',
      assigned_item_id INTEGER REFERENCES items(id),
      current_qty REAL NOT NULL DEFAULT 0,
      min_heel_qty REAL NOT NULL DEFAULT 0,
      temperature_c REAL,
      notes TEXT DEFAULT '',
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS payment_terms (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      description TEXT DEFAULT '',
      is_active INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS payment_term_lines (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      payment_term_id INTEGER NOT NULL REFERENCES payment_terms(id) ON DELETE CASCADE,
      installment_no INTEGER NOT NULL,
      percentage REAL NOT NULL,
      days_due INTEGER NOT NULL DEFAULT 0,
      payment_mode TEXT NOT NULL DEFAULT 'Bank Transfer'
    );

    CREATE TABLE IF NOT EXISTS suppliers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      contact_person TEXT DEFAULT '',
      email TEXT DEFAULT '',
      telephone TEXT DEFAULT '',
      whatsapp TEXT DEFAULT '',
      address TEXT DEFAULT '',
      country TEXT DEFAULT 'United Arab Emirates',
      payment_term_id INTEGER REFERENCES payment_terms(id),
      credit_limit REAL NOT NULL DEFAULT 0,
      trn TEXT DEFAULT '',
      opening_balance REAL NOT NULL DEFAULT 0,
      bank_details TEXT DEFAULT '',
      category TEXT DEFAULT 'Raw Material Supplier',
      currency TEXT NOT NULL DEFAULT 'AED',
      is_active INTEGER NOT NULL DEFAULT 1,
      created_by INTEGER REFERENCES users(id),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS customers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      contact_person TEXT DEFAULT '',
      telephone TEXT DEFAULT '',
      email TEXT DEFAULT '',
      whatsapp TEXT DEFAULT '',
      address TEXT DEFAULT '',
      country TEXT DEFAULT 'United Arab Emirates',
      payment_term_id INTEGER REFERENCES payment_terms(id),
      credit_limit REAL NOT NULL DEFAULT 0,
      trn TEXT DEFAULT '',
      opening_balance REAL NOT NULL DEFAULT 0,
      category TEXT DEFAULT 'Distributor',
      currency TEXT NOT NULL DEFAULT 'AED',
      is_active INTEGER NOT NULL DEFAULT 1,
      created_by INTEGER REFERENCES users(id),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      item_code TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      description TEXT DEFAULT '',
      category_id INTEGER NOT NULL REFERENCES item_categories(id),
      brand TEXT DEFAULT '',
      sku TEXT DEFAULT '',
      barcode TEXT DEFAULT '',
      purchase_uom TEXT NOT NULL DEFAULT 'LTR',
      stock_uom TEXT NOT NULL DEFAULT 'LTR',
      sales_uom TEXT NOT NULL DEFAULT 'LTR',
      conversion_factor REAL NOT NULL DEFAULT 1,
      reorder_level REAL NOT NULL DEFAULT 0,
      min_stock REAL NOT NULL DEFAULT 0,
      max_stock REAL NOT NULL DEFAULT 0,
      safety_stock REAL NOT NULL DEFAULT 0,
      lead_time_days INTEGER NOT NULL DEFAULT 7,
      moq REAL NOT NULL DEFAULT 1,
      preferred_supplier_id INTEGER REFERENCES suppliers(id),
      standard_cost REAL NOT NULL DEFAULT 0,
      average_cost REAL NOT NULL DEFAULT 0,
      last_purchase_price REAL NOT NULL DEFAULT 0,
      selling_price REAL NOT NULL DEFAULT 0,
      vat_rate REAL NOT NULL DEFAULT 5.0,
      tax_category TEXT NOT NULL DEFAULT 'Standard Rated',
      batch_tracking INTEGER NOT NULL DEFAULT 1,
      expiry_tracking INTEGER NOT NULL DEFAULT 0,
      default_warehouse_id INTEGER REFERENCES warehouses(id),
      valuation_method TEXT NOT NULL DEFAULT 'Moving Average',
      is_active INTEGER NOT NULL DEFAULT 1,
      created_by INTEGER REFERENCES users(id),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS uom_conversions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      item_id INTEGER REFERENCES items(id) ON DELETE CASCADE,
      from_uom TEXT NOT NULL,
      to_uom TEXT NOT NULL,
      factor REAL NOT NULL
    );

    CREATE TABLE IF NOT EXISTS price_lists (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      list_type TEXT NOT NULL DEFAULT 'Sales',
      currency TEXT NOT NULL DEFAULT 'AED',
      country TEXT DEFAULT '',
      category_id INTEGER REFERENCES item_categories(id),
      brand TEXT DEFAULT '',
      party_type TEXT DEFAULT '',
      party_id INTEGER,
      effective_from TEXT DEFAULT '',
      effective_to TEXT DEFAULT '',
      is_active INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS price_list_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      price_list_id INTEGER NOT NULL REFERENCES price_lists(id) ON DELETE CASCADE,
      item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
      min_qty REAL NOT NULL DEFAULT 1,
      rate REAL NOT NULL,
      discount_pct REAL NOT NULL DEFAULT 0,
      is_promotional INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS stock_batches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      batch_number TEXT NOT NULL UNIQUE,
      item_id INTEGER NOT NULL REFERENCES items(id),
      warehouse_id INTEGER NOT NULL REFERENCES warehouses(id),
      source_type TEXT NOT NULL DEFAULT 'Opening',
      source_doc_id INTEGER,
      source_doc_number TEXT DEFAULT '',
      supplier_id INTEGER REFERENCES suppliers(id),
      mfg_date TEXT DEFAULT '',
      expiry_date TEXT DEFAULT '',
      initial_qty REAL NOT NULL DEFAULT 0,
      available_qty REAL NOT NULL DEFAULT 0,
      reserved_qty REAL NOT NULL DEFAULT 0,
      unit_cost REAL NOT NULL DEFAULT 0,
      qc_status TEXT NOT NULL DEFAULT 'Pending',
      is_on_hold INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS stock_ledger (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      posting_date TEXT NOT NULL,
      doc_type TEXT NOT NULL,
      doc_id INTEGER NOT NULL,
      doc_number TEXT NOT NULL,
      item_id INTEGER NOT NULL REFERENCES items(id),
      warehouse_id INTEGER NOT NULL REFERENCES warehouses(id),
      batch_id INTEGER REFERENCES stock_batches(id),
      batch_number TEXT DEFAULT '',
      opening_qty REAL NOT NULL DEFAULT 0,
      inward_qty REAL NOT NULL DEFAULT 0,
      outward_qty REAL NOT NULL DEFAULT 0,
      closing_qty REAL NOT NULL DEFAULT 0,
      unit_cost REAL NOT NULL DEFAULT 0,
      stock_value REAL NOT NULL DEFAULT 0,
      valuation_method TEXT NOT NULL DEFAULT 'Moving Average',
      remarks TEXT DEFAULT '',
      created_by INTEGER REFERENCES users(id),
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS stock_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      entry_number TEXT NOT NULL UNIQUE,
      entry_type TEXT NOT NULL,
      entry_date TEXT NOT NULL,
      from_warehouse_id INTEGER REFERENCES warehouses(id),
      to_warehouse_id INTEGER REFERENCES warehouses(id),
      status TEXT NOT NULL DEFAULT 'Draft',
      approval_status TEXT NOT NULL DEFAULT 'Not Required',
      remarks TEXT DEFAULT '',
      total_value REAL NOT NULL DEFAULT 0,
      created_by INTEGER REFERENCES users(id),
      submitted_by INTEGER REFERENCES users(id),
      submitted_at TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS stock_entry_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      stock_entry_id INTEGER NOT NULL REFERENCES stock_entries(id) ON DELETE CASCADE,
      item_id INTEGER NOT NULL REFERENCES items(id),
      batch_id INTEGER REFERENCES stock_batches(id),
      batch_number TEXT DEFAULT '',
      qty REAL NOT NULL,
      uom TEXT NOT NULL,
      unit_cost REAL NOT NULL DEFAULT 0,
      total_cost REAL NOT NULL DEFAULT 0,
      system_qty REAL DEFAULT 0,
      variance_qty REAL DEFAULT 0,
      reason TEXT DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS stock_reservations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      doc_type TEXT NOT NULL,
      doc_id INTEGER NOT NULL,
      doc_number TEXT NOT NULL,
      item_id INTEGER NOT NULL REFERENCES items(id),
      warehouse_id INTEGER NOT NULL REFERENCES warehouses(id),
      batch_id INTEGER REFERENCES stock_batches(id),
      qty REAL NOT NULL,
      status TEXT NOT NULL DEFAULT 'Active',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS material_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      mr_number TEXT NOT NULL UNIQUE,
      request_type TEXT NOT NULL DEFAULT 'Raw Materials',
      request_date TEXT NOT NULL,
      required_date TEXT NOT NULL,
      requested_by TEXT DEFAULT '',
      department TEXT DEFAULT 'Production',
      warehouse_id INTEGER REFERENCES warehouses(id),
      source_doc_type TEXT DEFAULT '',
      source_doc_id INTEGER,
      status TEXT NOT NULL DEFAULT 'Draft',
      remarks TEXT DEFAULT '',
      created_by INTEGER REFERENCES users(id),
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS material_request_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      mr_id INTEGER NOT NULL REFERENCES material_requests(id) ON DELETE CASCADE,
      item_id INTEGER NOT NULL REFERENCES items(id),
      description TEXT DEFAULT '',
      qty REAL NOT NULL,
      uom TEXT NOT NULL,
      ordered_qty REAL NOT NULL DEFAULT 0,
      warehouse_id INTEGER REFERENCES warehouses(id)
    );

    CREATE TABLE IF NOT EXISTS purchase_requisitions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pr_number TEXT NOT NULL UNIQUE,
      mr_id INTEGER REFERENCES material_requests(id),
      request_date TEXT NOT NULL,
      required_date TEXT NOT NULL,
      requested_by TEXT DEFAULT '',
      department TEXT DEFAULT 'Procurement',
      warehouse_id INTEGER REFERENCES warehouses(id),
      status TEXT NOT NULL DEFAULT 'Draft',
      approval_status TEXT NOT NULL DEFAULT 'Pending',
      remarks TEXT DEFAULT '',
      created_by INTEGER REFERENCES users(id),
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS purchase_requisition_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pr_id INTEGER NOT NULL REFERENCES purchase_requisitions(id) ON DELETE CASCADE,
      item_id INTEGER NOT NULL REFERENCES items(id),
      description TEXT DEFAULT '',
      qty REAL NOT NULL,
      uom TEXT NOT NULL,
      warehouse_id INTEGER REFERENCES warehouses(id),
      estimated_rate REAL NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS rfqs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      rfq_number TEXT NOT NULL UNIQUE,
      pr_id INTEGER REFERENCES purchase_requisitions(id),
      rfq_date TEXT NOT NULL,
      valid_until TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'Draft',
      remarks TEXT DEFAULT '',
      created_by INTEGER REFERENCES users(id),
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS rfq_suppliers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      rfq_id INTEGER NOT NULL REFERENCES rfqs(id) ON DELETE CASCADE,
      supplier_id INTEGER NOT NULL REFERENCES suppliers(id),
      sent_at TEXT,
      status TEXT NOT NULL DEFAULT 'Pending'
    );

    CREATE TABLE IF NOT EXISTS rfq_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      rfq_id INTEGER NOT NULL REFERENCES rfqs(id) ON DELETE CASCADE,
      item_id INTEGER NOT NULL REFERENCES items(id),
      description TEXT DEFAULT '',
      qty REAL NOT NULL,
      uom TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS supplier_quotations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sq_number TEXT NOT NULL UNIQUE,
      rfq_id INTEGER REFERENCES rfqs(id),
      supplier_id INTEGER NOT NULL REFERENCES suppliers(id),
      quotation_date TEXT NOT NULL,
      valid_until TEXT NOT NULL,
      currency TEXT NOT NULL DEFAULT 'AED',
      exchange_rate REAL NOT NULL DEFAULT 1.0,
      payment_term_id INTEGER REFERENCES payment_terms(id),
      delivery_days INTEGER NOT NULL DEFAULT 7,
      freight_amount REAL NOT NULL DEFAULT 0,
      total_amount REAL NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'Draft',
      remarks TEXT DEFAULT '',
      created_by INTEGER REFERENCES users(id),
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS supplier_quotation_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sq_id INTEGER NOT NULL REFERENCES supplier_quotations(id) ON DELETE CASCADE,
      item_id INTEGER NOT NULL REFERENCES items(id),
      description TEXT DEFAULT '',
      qty REAL NOT NULL,
      uom TEXT NOT NULL,
      unit_price REAL NOT NULL,
      moq REAL NOT NULL DEFAULT 1,
      vat_rate REAL NOT NULL DEFAULT 5.0,
      vat_amount REAL NOT NULL DEFAULT 0,
      line_total REAL NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS purchase_orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      po_number TEXT NOT NULL UNIQUE,
      po_date TEXT NOT NULL,
      delivery_date TEXT NOT NULL,
      supplier_id INTEGER NOT NULL REFERENCES suppliers(id),
      supplier_ref TEXT DEFAULT '',
      sq_id INTEGER REFERENCES supplier_quotations(id),
      pr_id INTEGER REFERENCES purchase_requisitions(id),
      currency TEXT NOT NULL DEFAULT 'AED',
      exchange_rate REAL NOT NULL DEFAULT 1.0,
      payment_term_id INTEGER REFERENCES payment_terms(id),
      warehouse_id INTEGER NOT NULL REFERENCES warehouses(id),
      subtotal REAL NOT NULL DEFAULT 0,
      discount_amount REAL NOT NULL DEFAULT 0,
      freight_amount REAL NOT NULL DEFAULT 0,
      vat_amount REAL NOT NULL DEFAULT 0,
      total_amount REAL NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'Draft',
      approval_status TEXT NOT NULL DEFAULT 'Not Required',
      remarks TEXT DEFAULT '',
      created_by INTEGER REFERENCES users(id),
      submitted_by INTEGER REFERENCES users(id),
      submitted_at TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS purchase_order_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      po_id INTEGER NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
      item_id INTEGER NOT NULL REFERENCES items(id),
      description TEXT DEFAULT '',
      qty REAL NOT NULL,
      received_qty REAL NOT NULL DEFAULT 0,
      billed_qty REAL NOT NULL DEFAULT 0,
      uom TEXT NOT NULL,
      rate REAL NOT NULL,
      discount_pct REAL NOT NULL DEFAULT 0,
      vat_rate REAL NOT NULL DEFAULT 5.0,
      vat_amount REAL NOT NULL DEFAULT 0,
      line_total REAL NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS purchase_receipts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      grn_number TEXT NOT NULL UNIQUE,
      receipt_date TEXT NOT NULL,
      po_id INTEGER REFERENCES purchase_orders(id),
      supplier_id INTEGER NOT NULL REFERENCES suppliers(id),
      supplier_dn_number TEXT DEFAULT '',
      warehouse_id INTEGER NOT NULL REFERENCES warehouses(id),
      status TEXT NOT NULL DEFAULT 'Draft',
      remarks TEXT DEFAULT '',
      created_by INTEGER REFERENCES users(id),
      submitted_by INTEGER REFERENCES users(id),
      submitted_at TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS purchase_receipt_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      grn_id INTEGER NOT NULL REFERENCES purchase_receipts(id) ON DELETE CASCADE,
      po_item_id INTEGER REFERENCES purchase_order_items(id),
      item_id INTEGER NOT NULL REFERENCES items(id),
      ordered_qty REAL NOT NULL DEFAULT 0,
      received_qty REAL NOT NULL,
      accepted_qty REAL NOT NULL,
      rejected_qty REAL NOT NULL DEFAULT 0,
      uom TEXT NOT NULL,
      rate REAL NOT NULL,
      warehouse_id INTEGER NOT NULL REFERENCES warehouses(id),
      batch_number TEXT DEFAULT '',
      mfg_date TEXT DEFAULT '',
      expiry_date TEXT DEFAULT '',
      qc_required INTEGER NOT NULL DEFAULT 1,
      qc_status TEXT NOT NULL DEFAULT 'Pending'
    );

    CREATE TABLE IF NOT EXISTS purchase_invoices (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pi_number TEXT NOT NULL UNIQUE,
      supplier_invoice_number TEXT NOT NULL,
      invoice_date TEXT NOT NULL,
      due_date TEXT NOT NULL,
      supplier_id INTEGER NOT NULL REFERENCES suppliers(id),
      po_id INTEGER REFERENCES purchase_orders(id),
      grn_id INTEGER REFERENCES purchase_receipts(id),
      is_direct INTEGER NOT NULL DEFAULT 0,
      currency TEXT NOT NULL DEFAULT 'AED',
      exchange_rate REAL NOT NULL DEFAULT 1.0,
      payment_term_id INTEGER REFERENCES payment_terms(id),
      subtotal REAL NOT NULL DEFAULT 0,
      discount_amount REAL NOT NULL DEFAULT 0,
      freight_amount REAL NOT NULL DEFAULT 0,
      additional_charges REAL NOT NULL DEFAULT 0,
      vat_amount REAL NOT NULL DEFAULT 0,
      total_amount REAL NOT NULL DEFAULT 0,
      paid_amount REAL NOT NULL DEFAULT 0,
      outstanding_amount REAL NOT NULL DEFAULT 0,
      matching_status TEXT NOT NULL DEFAULT 'Pending',
      matching_notes_json TEXT DEFAULT '[]',
      status TEXT NOT NULL DEFAULT 'Draft',
      approval_status TEXT NOT NULL DEFAULT 'Not Required',
      remarks TEXT DEFAULT '',
      created_by INTEGER REFERENCES users(id),
      posted_by INTEGER REFERENCES users(id),
      posted_at TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS purchase_invoice_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pi_id INTEGER NOT NULL REFERENCES purchase_invoices(id) ON DELETE CASCADE,
      po_item_id INTEGER REFERENCES purchase_order_items(id),
      grn_item_id INTEGER REFERENCES purchase_receipt_items(id),
      item_id INTEGER NOT NULL REFERENCES items(id),
      description TEXT DEFAULT '',
      qty REAL NOT NULL,
      uom TEXT NOT NULL,
      rate REAL NOT NULL,
      discount_pct REAL NOT NULL DEFAULT 0,
      vat_rate REAL NOT NULL DEFAULT 5.0,
      tax_category TEXT NOT NULL DEFAULT 'Standard Rated',
      vat_amount REAL NOT NULL DEFAULT 0,
      line_total REAL NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS purchase_returns (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      prn_number TEXT NOT NULL UNIQUE,
      return_date TEXT NOT NULL,
      supplier_id INTEGER NOT NULL REFERENCES suppliers(id),
      grn_id INTEGER REFERENCES purchase_receipts(id),
      pi_id INTEGER REFERENCES purchase_invoices(id),
      warehouse_id INTEGER NOT NULL REFERENCES warehouses(id),
      reason TEXT NOT NULL,
      total_amount REAL NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'Draft',
      created_by INTEGER REFERENCES users(id),
      submitted_at TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS purchase_return_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      prn_id INTEGER NOT NULL REFERENCES purchase_returns(id) ON DELETE CASCADE,
      item_id INTEGER NOT NULL REFERENCES items(id),
      batch_id INTEGER REFERENCES stock_batches(id),
      batch_number TEXT DEFAULT '',
      qty REAL NOT NULL,
      uom TEXT NOT NULL,
      rate REAL NOT NULL,
      vat_amount REAL NOT NULL DEFAULT 0,
      line_total REAL NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS subcontractors (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      contact_person TEXT DEFAULT '',
      phone TEXT DEFAULT '',
      email TEXT DEFAULT '',
      address TEXT DEFAULT '',
      warehouse_id INTEGER REFERENCES warehouses(id),
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS subcontracting_orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sub_number TEXT NOT NULL UNIQUE,
      order_date TEXT NOT NULL,
      expected_date TEXT NOT NULL,
      subcontractor_id INTEGER NOT NULL REFERENCES subcontractors(id),
      finished_item_id INTEGER NOT NULL REFERENCES items(id),
      planned_qty REAL NOT NULL,
      received_qty REAL NOT NULL DEFAULT 0,
      bom_id INTEGER,
      service_rate REAL NOT NULL DEFAULT 0,
      freight_charge REAL NOT NULL DEFAULT 0,
      total_service_cost REAL NOT NULL DEFAULT 0,
      source_warehouse_id INTEGER NOT NULL REFERENCES warehouses(id),
      target_warehouse_id INTEGER NOT NULL REFERENCES warehouses(id),
      status TEXT NOT NULL DEFAULT 'Draft',
      remarks TEXT DEFAULT '',
      created_by INTEGER REFERENCES users(id),
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS subcontracting_materials (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sub_order_id INTEGER NOT NULL REFERENCES subcontracting_orders(id) ON DELETE CASCADE,
      item_id INTEGER NOT NULL REFERENCES items(id),
      batch_id INTEGER REFERENCES stock_batches(id),
      batch_number TEXT DEFAULT '',
      issued_qty REAL NOT NULL DEFAULT 0,
      consumed_qty REAL NOT NULL DEFAULT 0,
      returned_qty REAL NOT NULL DEFAULT 0,
      process_loss_qty REAL NOT NULL DEFAULT 0,
      uom TEXT NOT NULL,
      unit_cost REAL NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS boms (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      bom_number TEXT NOT NULL UNIQUE,
      version TEXT NOT NULL DEFAULT 'v1.0',
      finished_item_id INTEGER NOT NULL REFERENCES items(id),
      batch_size REAL NOT NULL DEFAULT 1000,
      uom TEXT NOT NULL DEFAULT 'LTR',
      labour_cost REAL NOT NULL DEFAULT 0,
      overhead_cost REAL NOT NULL DEFAULT 0,
      expected_wastage_pct REAL NOT NULL DEFAULT 0.5,
      effective_date TEXT NOT NULL,
      is_active INTEGER NOT NULL DEFAULT 1,
      is_approved INTEGER NOT NULL DEFAULT 0,
      approved_by INTEGER REFERENCES users(id),
      notes TEXT DEFAULT '',
      created_by INTEGER REFERENCES users(id),
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS bom_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      bom_id INTEGER NOT NULL REFERENCES boms(id) ON DELETE CASCADE,
      item_id INTEGER NOT NULL REFERENCES items(id),
      component_type TEXT NOT NULL DEFAULT 'Formula',
      qty REAL NOT NULL,
      uom TEXT NOT NULL,
      standard_cost REAL NOT NULL DEFAULT 0,
      wastage_pct REAL NOT NULL DEFAULT 0,
      is_alternative INTEGER NOT NULL DEFAULT 0,
      alternative_for_item_id INTEGER REFERENCES items(id),
      sub_bom_id INTEGER REFERENCES boms(id),
      carton_packing_qty REAL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS production_plans (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      plan_number TEXT NOT NULL UNIQUE,
      plan_date TEXT NOT NULL,
      from_date TEXT NOT NULL,
      to_date TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'Draft',
      remarks TEXT DEFAULT '',
      created_by INTEGER REFERENCES users(id),
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS production_orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      prod_number TEXT NOT NULL UNIQUE,
      plan_id INTEGER REFERENCES production_plans(id),
      bom_id INTEGER NOT NULL REFERENCES boms(id),
      finished_item_id INTEGER NOT NULL REFERENCES items(id),
      sales_order_id INTEGER,
      planned_qty REAL NOT NULL,
      completed_qty REAL NOT NULL DEFAULT 0,
      rejected_qty REAL NOT NULL DEFAULT 0,
      uom TEXT NOT NULL,
      production_line TEXT DEFAULT 'Blending Line 1',
      warehouse_id INTEGER NOT NULL REFERENCES warehouses(id),
      target_warehouse_id INTEGER NOT NULL REFERENCES warehouses(id),
      scheduled_date TEXT NOT NULL,
      responsible_employee_id INTEGER,
      actual_material_cost REAL NOT NULL DEFAULT 0,
      actual_labour_cost REAL NOT NULL DEFAULT 0,
      actual_overhead_cost REAL NOT NULL DEFAULT 0,
      total_actual_cost REAL NOT NULL DEFAULT 0,
      unit_actual_cost REAL NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'Draft',
      remarks TEXT DEFAULT '',
      created_by INTEGER REFERENCES users(id),
      completed_at TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS blending_batches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      blend_number TEXT NOT NULL UNIQUE,
      production_order_id INTEGER NOT NULL REFERENCES production_orders(id),
      bom_id INTEGER NOT NULL REFERENCES boms(id),
      finished_item_id INTEGER NOT NULL REFERENCES items(id),
      planned_qty REAL NOT NULL,
      actual_qty REAL NOT NULL DEFAULT 0,
      process_loss_qty REAL NOT NULL DEFAULT 0,
      wastage_qty REAL NOT NULL DEFAULT 0,
      blend_date TEXT NOT NULL,
      operator_name TEXT DEFAULT '',
      equipment_name TEXT DEFAULT 'Blending Kettle K-01',
      quality_status TEXT NOT NULL DEFAULT 'Pending',
      batch_id INTEGER REFERENCES stock_batches(id),
      status TEXT NOT NULL DEFAULT 'In Progress',
      remarks TEXT DEFAULT '',
      created_by INTEGER REFERENCES users(id),
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS blending_consumptions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      blend_id INTEGER REFERENCES blending_batches(id) ON DELETE CASCADE,
      production_order_id INTEGER NOT NULL REFERENCES production_orders(id) ON DELETE CASCADE,
      item_id INTEGER NOT NULL REFERENCES items(id),
      component_type TEXT NOT NULL DEFAULT 'Formula',
      batch_id INTEGER REFERENCES stock_batches(id),
      batch_number TEXT DEFAULT '',
      planned_qty REAL NOT NULL,
      actual_qty REAL NOT NULL DEFAULT 0,
      wastage_qty REAL NOT NULL DEFAULT 0,
      uom TEXT NOT NULL,
      unit_cost REAL NOT NULL DEFAULT 0,
      total_cost REAL NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS filling_orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      fill_number TEXT NOT NULL UNIQUE,
      production_order_id INTEGER NOT NULL REFERENCES production_orders(id),
      blend_id INTEGER REFERENCES blending_batches(id),
      container_item_id INTEGER REFERENCES items(id),
      container_size TEXT DEFAULT '1L',
      target_units REAL NOT NULL,
      filled_units REAL NOT NULL DEFAULT 0,
      rejected_units REAL NOT NULL DEFAULT 0,
      filling_line TEXT DEFAULT 'Filling Line A',
      carton_packing_qty REAL NOT NULL DEFAULT 12,
      calculated_cartons REAL NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'Pending',
      filled_date TEXT NOT NULL,
      created_by INTEGER REFERENCES users(id),
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS qc_parameters (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      unit TEXT DEFAULT '',
      method TEXT DEFAULT '',
      default_min REAL,
      default_max REAL,
      data_type TEXT NOT NULL DEFAULT 'numeric',
      is_active INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS quality_inspections (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      qc_number TEXT NOT NULL UNIQUE,
      inspection_type TEXT NOT NULL,
      doc_type TEXT DEFAULT '',
      doc_id INTEGER,
      doc_number TEXT DEFAULT '',
      item_id INTEGER NOT NULL REFERENCES items(id),
      batch_id INTEGER REFERENCES stock_batches(id),
      batch_number TEXT DEFAULT '',
      inspection_date TEXT NOT NULL,
      inspector_name TEXT DEFAULT '',
      overall_status TEXT NOT NULL DEFAULT 'Pending',
      batch_action TEXT NOT NULL DEFAULT 'Hold',
      remarks TEXT DEFAULT '',
      approved_by INTEGER REFERENCES users(id),
      created_by INTEGER REFERENCES users(id),
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS quality_results (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      qc_id INTEGER NOT NULL REFERENCES quality_inspections(id) ON DELETE CASCADE,
      parameter_id INTEGER REFERENCES qc_parameters(id),
      parameter_name TEXT NOT NULL,
      unit TEXT DEFAULT '',
      min_val REAL,
      max_val REAL,
      actual_val REAL,
      text_val TEXT DEFAULT '',
      result_status TEXT NOT NULL DEFAULT 'Pass'
    );

    CREATE TABLE IF NOT EXISTS sales_quotations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sq_number TEXT NOT NULL UNIQUE,
      customer_id INTEGER NOT NULL REFERENCES customers(id),
      quotation_date TEXT NOT NULL,
      valid_until TEXT NOT NULL,
      currency TEXT NOT NULL DEFAULT 'AED',
      exchange_rate REAL NOT NULL DEFAULT 1.0,
      price_list_id INTEGER REFERENCES price_lists(id),
      subtotal REAL NOT NULL DEFAULT 0,
      discount_amount REAL NOT NULL DEFAULT 0,
      vat_amount REAL NOT NULL DEFAULT 0,
      total_amount REAL NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'Draft',
      terms TEXT DEFAULT '',
      created_by INTEGER REFERENCES users(id),
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sales_quotation_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sq_id INTEGER NOT NULL REFERENCES sales_quotations(id) ON DELETE CASCADE,
      item_id INTEGER NOT NULL REFERENCES items(id),
      description TEXT DEFAULT '',
      qty REAL NOT NULL,
      uom TEXT NOT NULL,
      rate REAL NOT NULL,
      discount_pct REAL NOT NULL DEFAULT 0,
      vat_rate REAL NOT NULL DEFAULT 5.0,
      vat_amount REAL NOT NULL DEFAULT 0,
      line_total REAL NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS sales_orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      so_number TEXT NOT NULL UNIQUE,
      customer_id INTEGER NOT NULL REFERENCES customers(id),
      sq_id INTEGER REFERENCES sales_quotations(id),
      order_date TEXT NOT NULL,
      delivery_date TEXT NOT NULL,
      payment_term_id INTEGER REFERENCES payment_terms(id),
      currency TEXT NOT NULL DEFAULT 'AED',
      exchange_rate REAL NOT NULL DEFAULT 1.0,
      warehouse_id INTEGER NOT NULL REFERENCES warehouses(id),
      price_list_id INTEGER REFERENCES price_lists(id),
      subtotal REAL NOT NULL DEFAULT 0,
      discount_amount REAL NOT NULL DEFAULT 0,
      vat_amount REAL NOT NULL DEFAULT 0,
      total_amount REAL NOT NULL DEFAULT 0,
      delivered_status TEXT NOT NULL DEFAULT 'Pending',
      billed_status TEXT NOT NULL DEFAULT 'Pending',
      status TEXT NOT NULL DEFAULT 'Draft',
      approval_status TEXT NOT NULL DEFAULT 'Not Required',
      remarks TEXT DEFAULT '',
      created_by INTEGER REFERENCES users(id),
      submitted_at TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sales_order_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      so_id INTEGER NOT NULL REFERENCES sales_orders(id) ON DELETE CASCADE,
      item_id INTEGER NOT NULL REFERENCES items(id),
      description TEXT DEFAULT '',
      qty REAL NOT NULL,
      delivered_qty REAL NOT NULL DEFAULT 0,
      billed_qty REAL NOT NULL DEFAULT 0,
      reserved_qty REAL NOT NULL DEFAULT 0,
      uom TEXT NOT NULL,
      rate REAL NOT NULL,
      discount_pct REAL NOT NULL DEFAULT 0,
      vat_rate REAL NOT NULL DEFAULT 5.0,
      vat_amount REAL NOT NULL DEFAULT 0,
      line_total REAL NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS delivery_notes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      dn_number TEXT NOT NULL UNIQUE,
      so_id INTEGER REFERENCES sales_orders(id),
      customer_id INTEGER NOT NULL REFERENCES customers(id),
      delivery_date TEXT NOT NULL,
      warehouse_id INTEGER NOT NULL REFERENCES warehouses(id),
      vehicle_number TEXT DEFAULT '',
      driver_name TEXT DEFAULT '',
      customer_signature TEXT DEFAULT '',
      status TEXT NOT NULL DEFAULT 'Draft',
      remarks TEXT DEFAULT '',
      created_by INTEGER REFERENCES users(id),
      submitted_at TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS delivery_note_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      dn_id INTEGER NOT NULL REFERENCES delivery_notes(id) ON DELETE CASCADE,
      so_item_id INTEGER REFERENCES sales_order_items(id),
      item_id INTEGER NOT NULL REFERENCES items(id),
      batch_id INTEGER REFERENCES stock_batches(id),
      batch_number TEXT DEFAULT '',
      qty REAL NOT NULL,
      uom TEXT NOT NULL,
      unit_cost REAL NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS sales_invoices (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      si_number TEXT NOT NULL UNIQUE,
      customer_invoice_ref TEXT DEFAULT '',
      invoice_date TEXT NOT NULL,
      due_date TEXT NOT NULL,
      customer_id INTEGER NOT NULL REFERENCES customers(id),
      so_id INTEGER REFERENCES sales_orders(id),
      dn_id INTEGER REFERENCES delivery_notes(id),
      currency TEXT NOT NULL DEFAULT 'AED',
      exchange_rate REAL NOT NULL DEFAULT 1.0,
      payment_term_id INTEGER REFERENCES payment_terms(id),
      subtotal REAL NOT NULL DEFAULT 0,
      discount_amount REAL NOT NULL DEFAULT 0,
      freight_amount REAL NOT NULL DEFAULT 0,
      vat_amount REAL NOT NULL DEFAULT 0,
      total_amount REAL NOT NULL DEFAULT 0,
      paid_amount REAL NOT NULL DEFAULT 0,
      outstanding_amount REAL NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'Draft',
      remarks TEXT DEFAULT '',
      created_by INTEGER REFERENCES users(id),
      posted_by INTEGER REFERENCES users(id),
      posted_at TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sales_invoice_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      si_id INTEGER NOT NULL REFERENCES sales_invoices(id) ON DELETE CASCADE,
      so_item_id INTEGER REFERENCES sales_order_items(id),
      item_id INTEGER NOT NULL REFERENCES items(id),
      description TEXT DEFAULT '',
      qty REAL NOT NULL,
      uom TEXT NOT NULL,
      rate REAL NOT NULL,
      discount_pct REAL NOT NULL DEFAULT 0,
      vat_rate REAL NOT NULL DEFAULT 5.0,
      tax_category TEXT NOT NULL DEFAULT 'Standard Rated',
      vat_amount REAL NOT NULL DEFAULT 0,
      line_total REAL NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS sales_returns (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sr_number TEXT NOT NULL UNIQUE,
      return_date TEXT NOT NULL,
      customer_id INTEGER NOT NULL REFERENCES customers(id),
      dn_id INTEGER REFERENCES delivery_notes(id),
      si_id INTEGER REFERENCES sales_invoices(id),
      warehouse_id INTEGER NOT NULL REFERENCES warehouses(id),
      reason TEXT NOT NULL,
      total_amount REAL NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'Draft',
      created_by INTEGER REFERENCES users(id),
      submitted_at TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sales_return_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sr_id INTEGER NOT NULL REFERENCES sales_returns(id) ON DELETE CASCADE,
      item_id INTEGER NOT NULL REFERENCES items(id),
      batch_id INTEGER REFERENCES stock_batches(id),
      batch_number TEXT DEFAULT '',
      qty REAL NOT NULL,
      uom TEXT NOT NULL,
      rate REAL NOT NULL,
      vat_amount REAL NOT NULL DEFAULT 0,
      line_total REAL NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS chart_of_accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      account_code TEXT NOT NULL UNIQUE,
      account_name TEXT NOT NULL,
      account_type TEXT NOT NULL,
      parent_id INTEGER REFERENCES chart_of_accounts(id),
      currency TEXT NOT NULL DEFAULT 'AED',
      is_group INTEGER NOT NULL DEFAULT 0,
      is_bank INTEGER NOT NULL DEFAULT 0,
      is_cash INTEGER NOT NULL DEFAULT 0,
      balance REAL NOT NULL DEFAULT 0,
      is_active INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS bank_accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      account_name TEXT NOT NULL,
      bank_name TEXT NOT NULL,
      account_number TEXT NOT NULL,
      iban TEXT DEFAULT '',
      swift TEXT DEFAULT '',
      currency TEXT NOT NULL DEFAULT 'AED',
      gl_account_id INTEGER NOT NULL REFERENCES chart_of_accounts(id),
      current_balance REAL NOT NULL DEFAULT 0,
      is_active INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS journal_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      je_number TEXT NOT NULL UNIQUE,
      posting_date TEXT NOT NULL,
      entry_type TEXT NOT NULL DEFAULT 'Journal Entry',
      ref_doc_type TEXT DEFAULT '',
      ref_doc_id INTEGER,
      ref_doc_number TEXT DEFAULT '',
      narration TEXT DEFAULT '',
      total_debit REAL NOT NULL DEFAULT 0,
      total_credit REAL NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'Posted',
      reversed_je_id INTEGER REFERENCES journal_entries(id),
      created_by INTEGER REFERENCES users(id),
      posted_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS journal_entry_lines (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      je_id INTEGER NOT NULL REFERENCES journal_entries(id) ON DELETE CASCADE,
      account_id INTEGER NOT NULL REFERENCES chart_of_accounts(id),
      party_type TEXT DEFAULT '',
      party_id INTEGER,
      debit REAL NOT NULL DEFAULT 0,
      credit REAL NOT NULL DEFAULT 0,
      currency TEXT NOT NULL DEFAULT 'AED',
      exchange_rate REAL NOT NULL DEFAULT 1.0,
      debit_base REAL NOT NULL DEFAULT 0,
      credit_base REAL NOT NULL DEFAULT 0,
      description TEXT DEFAULT '',
      reconciled INTEGER NOT NULL DEFAULT 0,
      reconciled_date TEXT
    );

    CREATE TABLE IF NOT EXISTS payment_schedules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      party_type TEXT NOT NULL,
      party_id INTEGER NOT NULL,
      doc_type TEXT NOT NULL,
      doc_id INTEGER NOT NULL,
      doc_number TEXT NOT NULL,
      installment_no INTEGER NOT NULL,
      due_date TEXT NOT NULL,
      amount REAL NOT NULL,
      paid_amount REAL NOT NULL DEFAULT 0,
      outstanding_amount REAL NOT NULL,
      payment_mode TEXT NOT NULL DEFAULT 'Bank Transfer',
      status TEXT NOT NULL DEFAULT 'Pending'
    );

    CREATE TABLE IF NOT EXISTS payment_vouchers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pv_number TEXT NOT NULL UNIQUE,
      voucher_type TEXT NOT NULL,
      payment_date TEXT NOT NULL,
      party_type TEXT NOT NULL,
      party_id INTEGER NOT NULL,
      payment_mode TEXT NOT NULL DEFAULT 'Bank Transfer',
      bank_account_id INTEGER REFERENCES bank_accounts(id),
      cheque_number TEXT DEFAULT '',
      cheque_date TEXT DEFAULT '',
      currency TEXT NOT NULL DEFAULT 'AED',
      exchange_rate REAL NOT NULL DEFAULT 1.0,
      amount REAL NOT NULL,
      base_amount REAL NOT NULL,
      allocated_doc_type TEXT DEFAULT '',
      allocated_doc_id INTEGER,
      status TEXT NOT NULL DEFAULT 'Draft',
      approval_status TEXT NOT NULL DEFAULT 'Not Required',
      remarks TEXT DEFAULT '',
      created_by INTEGER REFERENCES users(id),
      posted_at TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS expenses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      exp_number TEXT NOT NULL UNIQUE,
      expense_date TEXT NOT NULL,
      category TEXT NOT NULL,
      account_id INTEGER NOT NULL REFERENCES chart_of_accounts(id),
      bank_account_id INTEGER REFERENCES bank_accounts(id),
      project_id INTEGER,
      amount REAL NOT NULL,
      vat_amount REAL NOT NULL DEFAULT 0,
      total_amount REAL NOT NULL,
      description TEXT DEFAULT '',
      status TEXT NOT NULL DEFAULT 'Posted',
      created_by INTEGER REFERENCES users(id),
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS fixed_assets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      asset_code TEXT NOT NULL UNIQUE,
      asset_name TEXT NOT NULL,
      category TEXT NOT NULL,
      purchase_date TEXT NOT NULL,
      purchase_cost REAL NOT NULL,
      salvage_value REAL NOT NULL DEFAULT 0,
      useful_life_months INTEGER NOT NULL DEFAULT 60,
      depreciation_method TEXT NOT NULL DEFAULT 'Straight Line',
      accumulated_depreciation REAL NOT NULL DEFAULT 0,
      net_book_value REAL NOT NULL,
      location TEXT DEFAULT '',
      responsible_employee_id INTEGER,
      asset_account_id INTEGER REFERENCES chart_of_accounts(id),
      dep_expense_account_id INTEGER REFERENCES chart_of_accounts(id),
      accum_dep_account_id INTEGER REFERENCES chart_of_accounts(id),
      status TEXT NOT NULL DEFAULT 'Active',
      created_by INTEGER REFERENCES users(id),
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS depreciation_schedules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      asset_id INTEGER NOT NULL REFERENCES fixed_assets(id) ON DELETE CASCADE,
      period_date TEXT NOT NULL,
      depreciation_amount REAL NOT NULL,
      accumulated_amount REAL NOT NULL,
      book_value REAL NOT NULL,
      is_posted INTEGER NOT NULL DEFAULT 0,
      je_id INTEGER REFERENCES journal_entries(id)
    );

    CREATE TABLE IF NOT EXISTS financial_periods (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      start_date TEXT NOT NULL,
      end_date TEXT NOT NULL,
      is_closed INTEGER NOT NULL DEFAULT 0,
      closed_by INTEGER REFERENCES users(id),
      closed_at TEXT
    );

    CREATE TABLE IF NOT EXISTS departments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      manager_name TEXT DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS designations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE
    );

    CREATE TABLE IF NOT EXISTS employees (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      emp_code TEXT NOT NULL UNIQUE,
      full_name TEXT NOT NULL,
      email TEXT DEFAULT '',
      phone TEXT DEFAULT '',
      department_id INTEGER REFERENCES departments(id),
      designation_id INTEGER REFERENCES designations(id),
      join_date TEXT NOT NULL,
      basic_salary REAL NOT NULL DEFAULT 0,
      allowances REAL NOT NULL DEFAULT 0,
      user_id INTEGER REFERENCES users(id),
      status TEXT NOT NULL DEFAULT 'Active',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS attendance (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      employee_id INTEGER NOT NULL REFERENCES employees(id),
      attendance_date TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'Present',
      check_in TEXT DEFAULT '08:00',
      check_out TEXT DEFAULT '17:00',
      hours_worked REAL NOT NULL DEFAULT 8.0,
      UNIQUE(employee_id, attendance_date)
    );

    CREATE TABLE IF NOT EXISTS leave_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      employee_id INTEGER NOT NULL REFERENCES employees(id),
      leave_type TEXT NOT NULL,
      start_date TEXT NOT NULL,
      end_date TEXT NOT NULL,
      days REAL NOT NULL,
      reason TEXT DEFAULT '',
      status TEXT NOT NULL DEFAULT 'Pending',
      approved_by INTEGER REFERENCES users(id),
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS payroll_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      payroll_number TEXT NOT NULL UNIQUE,
      month INTEGER NOT NULL,
      year INTEGER NOT NULL,
      total_gross REAL NOT NULL DEFAULT 0,
      total_deductions REAL NOT NULL DEFAULT 0,
      total_net REAL NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'Draft',
      je_id INTEGER REFERENCES journal_entries(id),
      created_by INTEGER REFERENCES users(id),
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS payroll_lines (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      payroll_id INTEGER NOT NULL REFERENCES payroll_runs(id) ON DELETE CASCADE,
      employee_id INTEGER NOT NULL REFERENCES employees(id),
      basic_salary REAL NOT NULL,
      allowances REAL NOT NULL,
      deductions REAL NOT NULL DEFAULT 0,
      net_pay REAL NOT NULL
    );

    CREATE TABLE IF NOT EXISTS crm_leads (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      lead_number TEXT NOT NULL UNIQUE,
      company_name TEXT NOT NULL,
      contact_person TEXT DEFAULT '',
      email TEXT DEFAULT '',
      phone TEXT DEFAULT '',
      source TEXT DEFAULT 'Direct',
      stage TEXT NOT NULL DEFAULT 'New',
      estimated_value REAL NOT NULL DEFAULT 0,
      currency TEXT NOT NULL DEFAULT 'AED',
      assigned_to INTEGER REFERENCES users(id),
      notes TEXT DEFAULT '',
      converted_customer_id INTEGER REFERENCES customers(id),
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS crm_activities (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      lead_id INTEGER REFERENCES crm_leads(id) ON DELETE CASCADE,
      customer_id INTEGER REFERENCES customers(id) ON DELETE CASCADE,
      activity_type TEXT NOT NULL DEFAULT 'Call',
      subject TEXT NOT NULL,
      notes TEXT DEFAULT '',
      follow_up_date TEXT DEFAULT '',
      completed INTEGER NOT NULL DEFAULT 0,
      created_by INTEGER REFERENCES users(id),
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS crm_complaints (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      complaint_number TEXT NOT NULL UNIQUE,
      customer_id INTEGER NOT NULL REFERENCES customers(id),
      item_id INTEGER REFERENCES items(id),
      batch_number TEXT DEFAULT '',
      subject TEXT NOT NULL,
      description TEXT DEFAULT '',
      severity TEXT NOT NULL DEFAULT 'Medium',
      status TEXT NOT NULL DEFAULT 'Open',
      resolution TEXT DEFAULT '',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_code TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      customer_id INTEGER REFERENCES customers(id),
      start_date TEXT NOT NULL,
      end_date TEXT NOT NULL,
      budget REAL NOT NULL DEFAULT 0,
      actual_cost REAL NOT NULL DEFAULT 0,
      revenue REAL NOT NULL DEFAULT 0,
      progress_pct REAL NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'Active',
      manager_id INTEGER REFERENCES employees(id),
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS project_tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      assigned_employee_id INTEGER REFERENCES employees(id),
      start_date TEXT NOT NULL,
      due_date TEXT NOT NULL,
      progress_pct REAL NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'Open'
    );

    CREATE TABLE IF NOT EXISTS backup_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      file_name TEXT NOT NULL,
      file_path TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      backup_type TEXT NOT NULL DEFAULT 'Manual',
      created_by INTEGER REFERENCES users(id),
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_stock_ledger_item_wh ON stock_ledger(item_id, warehouse_id, id);
    CREATE INDEX IF NOT EXISTS idx_stock_ledger_doc ON stock_ledger(doc_type, doc_id);
    CREATE INDEX IF NOT EXISTS idx_stock_batches_item ON stock_batches(item_id, warehouse_id);
    CREATE INDEX IF NOT EXISTS idx_je_lines_account ON journal_entry_lines(account_id);
    CREATE INDEX IF NOT EXISTS idx_je_lines_party ON journal_entry_lines(party_type, party_id);
    CREATE INDEX IF NOT EXISTS idx_payment_schedules_party ON payment_schedules(party_type, party_id, status);
    CREATE INDEX IF NOT EXISTS idx_audit_logs_doc ON audit_logs(doc_type, doc_id);
    CREATE INDEX IF NOT EXISTS idx_storage_tanks_wh ON storage_tanks(warehouse_id);
  `);

  const ensureColumn = (table: string, column: string, defSql: string) => {
    const cols = db.prepare(`PRAGMA table_info("${table}")`).all() as { name: string }[];
    if (!cols.some((c) => c.name === column)) {
      db.exec(`ALTER TABLE "${table}" ADD COLUMN ${column} ${defSql}`);
    }
  };

  ensureColumn('companies', 'short_name', "TEXT DEFAULT ''");
  ensureColumn('companies', 'po_box', "TEXT DEFAULT ''");
  ensureColumn('item_categories', 'group_code', "TEXT DEFAULT ''");
  ensureColumn('item_categories', 'parent_id', 'INTEGER REFERENCES item_categories(id)');
  ensureColumn('item_categories', 'is_group', 'INTEGER NOT NULL DEFAULT 1');
  ensureColumn('item_categories', 'sort_order', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn('purchase_orders', 'delivery_terms', "TEXT DEFAULT ''");
  ensureColumn('purchase_orders', 'delivery_place', "TEXT DEFAULT ''");
  ensureColumn('purchase_orders', 'revision_no', "TEXT DEFAULT 'Original'");
  ensureColumn('purchase_orders', 'revision_date', "TEXT DEFAULT ''");
  ensureColumn('purchase_orders', 'amended_from', "TEXT DEFAULT ''");
  ensureColumn('sales_orders', 'customer_ref', "TEXT DEFAULT ''");
  ensureColumn('sales_orders', 'delivery_terms', "TEXT DEFAULT ''");
  ensureColumn('sales_orders', 'delivery_place', "TEXT DEFAULT ''");
  ensureColumn('sales_orders', 'revision_no', "TEXT DEFAULT 'Original'");
  ensureColumn('sales_orders', 'revision_date', "TEXT DEFAULT ''");
  ensureColumn('sales_orders', 'amended_from', "TEXT DEFAULT ''");
  ensureColumn('sales_quotations', 'amended_from', "TEXT DEFAULT ''");
  ensureColumn('sales_quotations', 'revision_no', "TEXT DEFAULT 'Original'");
  ensureColumn('sales_quotations', 'revision_date', "TEXT DEFAULT ''");
  ensureColumn('sales_invoices', 'delivery_terms', "TEXT DEFAULT ''");
  ensureColumn('sales_invoices', 'delivery_place', "TEXT DEFAULT ''");
  ensureColumn('sales_invoices', 'revision_no', "TEXT DEFAULT 'Original'");
  ensureColumn('sales_invoices', 'revision_date', "TEXT DEFAULT ''");
  ensureColumn('stock_batches', 'tank_id', 'INTEGER REFERENCES storage_tanks(id)');
  ensureColumn('stock_ledger', 'tank_id', 'INTEGER REFERENCES storage_tanks(id)');
  ensureColumn('purchase_receipt_items', 'tank_id', 'INTEGER REFERENCES storage_tanks(id)');
  ensureColumn('stock_entry_items', 'from_tank_id', 'INTEGER REFERENCES storage_tanks(id)');
  ensureColumn('stock_entry_items', 'to_tank_id', 'INTEGER REFERENCES storage_tanks(id)');
  ensureColumn('blending_consumptions', 'tank_id', 'INTEGER REFERENCES storage_tanks(id)');

  // Idempotent backfill for existing databases created prior to group hierarchy & storage tanks
  const comp = db.prepare('SELECT id, short_name, po_box, country FROM companies LIMIT 1').get() as
    | { id: number; short_name: string; po_box: string; country: string }
    | undefined;
  if (comp) {
    if (!comp.short_name || !comp.po_box) {
      db.prepare("UPDATE companies SET short_name = CASE WHEN COALESCE(short_name,'') = '' THEN 'PetroBlend ERP' ELSE short_name END, po_box = CASE WHEN COALESCE(po_box,'') = '' THEN '83575' ELSE po_box END WHERE id = ?").run(comp.id);
    }
  }

  const groupCodeMap: [string, string, number][] = [
    ['Base Oil', 'BASE OIL', 1],
    ['Additives', 'ADDITIVES', 2],
    ['Finished Lubricants', 'FG LUBRICANTS', 3],
    ['Semi-Finished Products', 'SEMI-FINISHED', 4],
    ['Empty Cans', 'CAN', 5],
    ['Plastic Bottles', 'BOTTLES', 6],
    ['Caps', 'CAPS', 7],
    ['Cartons', 'CARTON', 8],
    ['Labels', 'LABELS', 9],
    ['Drums', 'DRUMS', 10],
    ['Pails', 'PAILS', 11],
    ['Chemicals', 'CHEMICALS', 12],
    ['Consumables', 'CONSUMABLE', 13],
    ['Spare Parts', 'SPARE PARTS', 14],
    ['Services', 'SERVICES', 15],
    ['Packaging Materials', 'PACKAGING', 16],
  ];
  for (const [catName, gCode, sOrder] of groupCodeMap) {
    db.prepare(
      "UPDATE item_categories SET group_code = CASE WHEN COALESCE(group_code,'') = '' THEN ? ELSE group_code END, sort_order = CASE WHEN sort_order = 0 THEN ? ELSE sort_order END WHERE name = ?"
    ).run(gCode, sOrder, catName);
  }

  const canParentRow = db.prepare("SELECT id FROM item_categories WHERE name = 'Empty Cans' LIMIT 1").get() as { id: number } | undefined;
  const rmCanCmExists = db.prepare("SELECT id FROM item_categories WHERE name = 'RM CAN C.M' OR group_code = 'RM CAN C.M' LIMIT 1").get();
  if (canParentRow && !rmCanCmExists) {
    db.prepare(
      'INSERT INTO item_categories (group_code, name, parent_id, is_group, description, is_raw_material, is_finished_good, is_packaging, sort_order) VALUES (?, ?, ?, 1, ?, 0, 0, 1, 17)'
    ).run('RM CAN C.M', 'RM CAN C.M', canParentRow.id, 'Round Metal Cans (C.M) — Gold, Red, Blue & custom litho');
  }

  const tankCount = (db.prepare('SELECT COUNT(*) as c FROM storage_tanks').get() as { c: number }).c;
  if (tankCount === 0) {
    const rmWh = db.prepare("SELECT id FROM warehouses WHERE code = 'WH-RM' LIMIT 1").get() as { id: number } | undefined;
    if (rmWh) {
      const now = nowISO();
      const defaultTanks = [
        ['TK-BO-01', 'Base Oil Tank 01 (SN150)', rmWh.id, 'Base Oil', 50000, 'LTR', 500, 'Primary virgin SN150 vertical tank'],
        ['TK-BO-02', 'Base Oil Tank 02 (SN500)', rmWh.id, 'Base Oil', 50000, 'LTR', 500, 'Primary heavy SN500 vertical tank'],
        ['TK-BO-03', 'Base Oil Tank 03 (Bright Stock)', rmWh.id, 'Base Oil', 30000, 'LTR', 300, 'BS150 / heavy base stock tank'],
        ['TK-BO-04', 'Base Oil Tank 04 (Group III Synthetic)', rmWh.id, 'Base Oil', 25000, 'LTR', 250, 'Group III 4cSt / 6cSt synthetic base oil tank'],
        ['TK-ADD-01', 'Additive Bulk Tank A1 (DI Package)', rmWh.id, 'Additive', 10000, 'KG', 100, 'Heated additive package storage tank'],
        ['TK-ADD-02', 'Additive Bulk Tank A2 (VII Polymer)', rmWh.id, 'Additive', 10000, 'KG', 100, 'Viscosity index improver tank'],
      ] as const;
      const insTank = db.prepare(
        `INSERT INTO storage_tanks (tank_code, name, warehouse_id, tank_type, capacity_qty, uom, min_heel_qty, notes, is_active, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`
      );
      for (const [tc, tn, wid, tt, cap, uom, heel, notes] of defaultTanks) {
        insTank.run(tc, tn, wid, tt, cap, uom, heel, notes, now);
      }
    }
  }
}

function seedReferenceData(db: Database.Database): void {
  const migCount = (db.prepare('SELECT COUNT(*) as c FROM schema_migrations').get() as { c: number }).c;
  if (migCount > 0) return;

  const now = nowISO();
  const today = todayISO();

  const tx = db.transaction(() => {
    db.prepare('INSERT INTO schema_migrations (version, description, applied_at) VALUES (?, ?, ?)').run(
      '0001_initial_enterprise_erp',
      'Complete Enterprise Lubricants ERP schema and reference masters',
      now
    );

    // Company Master
    db.prepare(`
      INSERT INTO companies (name, short_name, address, po_box, country, trn, telephone, email, website, currency, financial_year_start, financial_year_end, vat_rate, vat_enabled, letterhead_html, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'Al-Nisr PetroBlend Lubricants L.L.C.',
      'PetroBlend ERP',
      'Plot 42, Industrial City (ICAD II), Mussafah, Abu Dhabi',
      '83575',
      'UNITED ARAB EMIRATES',
      '100482910300003',
      '+971 2 555 0190',
      'operations@petroblend-erp.local',
      'https://petroblend.local',
      'AED',
      '2026-01-01',
      '2026-12-31',
      5.0,
      1,
      '<div style="border-bottom:2px solid #0f172a;padding-bottom:8px;"><strong>Al-Nisr PetroBlend Lubricants L.L.C.</strong> — ICAD II, Abu Dhabi, UAE | TRN: 100482910300003</div>',
      now,
      now
    );

    // 15 Default Roles
    const defaultRoles = [
      ['Super Admin', 'Full unrestricted enterprise access across all modules and security settings', 1],
      ['Administrator', 'System administration, master data, and operational oversight', 1],
      ['Purchase Manager', 'Procurement approvals, supplier management, and purchasing oversight', 1],
      ['Purchase Officer', 'Material requests, RFQs, PO creation, and supplier coordination', 1],
      ['Sales Manager', 'Sales approvals, pricing overrides, customer credit, and invoicing', 1],
      ['Sales Officer', 'Sales quotations, sales orders, and delivery scheduling', 1],
      ['Store Manager', 'Warehouse oversight, stock adjustments, and inventory reconciliation', 1],
      ['Storekeeper', 'GRN receiving, material issues, warehouse transfers, and deliveries', 1],
      ['Production Manager', 'BOM approvals, production planning, MRP, and batch release', 1],
      ['Production Operator', 'Blending batch execution, filling lines, and material consumption', 1],
      ['Accountant', 'General ledger, invoicing, payment/receipt vouchers, and VAT filing', 1],
      ['Finance Manager', 'Financial approvals, bank reconciliation, fixed assets, and period closing', 1],
      ['HR Manager', 'Employee master, attendance, leave approvals, and payroll', 1],
      ['Quality Control', 'Incoming/blending/finished QC lab inspections, COA, and batch hold/release', 1],
      ['Management / Read Only', 'Executive read-only visibility across dashboards and reports', 1],
    ] as const;

    const insertRole = db.prepare('INSERT INTO roles (name, description, is_system, is_active, created_at) VALUES (?, ?, ?, 1, ?)');
    for (const [name, desc, sys] of defaultRoles) {
      insertRole.run(name, desc, sys, now);
    }

    const modulesList = [
      ['dashboard', 'Dashboard'],
      ['masters', 'MasterData'],
      ['procurement', 'Procurement'],
      ['inventory', 'Inventory'],
      ['manufacturing', 'Manufacturing'],
      ['quality', 'QualityControl'],
      ['subcontracting', 'Subcontracting'],
      ['sales', 'Sales'],
      ['accounting', 'Accounting'],
      ['hr', 'HR'],
      ['crm', 'CRM'],
      ['projects', 'Projects'],
      ['assets', 'FixedAssets'],
      ['reports', 'Reports'],
      ['settings', 'Settings'],
    ];

    const allRoles = db.prepare('SELECT id, name FROM roles').all() as { id: number; name: string }[];
    const insertPerm = db.prepare(`
      INSERT INTO role_permissions (role_id, module, doc_type, can_view, can_create, can_edit, can_delete, can_submit, can_cancel, can_amend, can_approve, can_export, can_print)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (const r of allRoles) {
      for (const [mod, docType] of modulesList) {
        const isSuper = r.name === 'Super Admin' || r.name === 'Administrator';
        const isReadOnly = r.name === 'Management / Read Only';
        let canView = 1;
        let canCreate = isSuper ? 1 : 0;
        let canEdit = isSuper ? 1 : 0;
        let canDelete = r.name === 'Super Admin' ? 1 : 0;
        let canSubmit = isSuper ? 1 : 0;
        let canCancel = isSuper ? 1 : 0;
        let canAmend = isSuper ? 1 : 0;
        let canApprove = isSuper ? 1 : 0;
        const canExport = 1;
        const canPrint = 1;

        if (!isSuper && !isReadOnly) {
          if (r.name.includes('Purchase') && ['masters', 'procurement', 'inventory', 'subcontracting', 'reports'].includes(mod)) {
            canCreate = 1; canEdit = 1; canSubmit = 1;
            if (r.name === 'Purchase Manager') { canApprove = 1; canCancel = 1; canAmend = 1; }
          } else if (r.name.includes('Sales') && ['masters', 'sales', 'crm', 'inventory', 'reports'].includes(mod)) {
            canCreate = 1; canEdit = 1; canSubmit = 1;
            if (r.name === 'Sales Manager') { canApprove = 1; canCancel = 1; canAmend = 1; }
          } else if (r.name.includes('Store') && ['masters', 'inventory', 'procurement', 'sales', 'reports'].includes(mod)) {
            canCreate = 1; canEdit = 1; canSubmit = 1;
            if (r.name === 'Store Manager') { canApprove = 1; canCancel = 1; }
          } else if (r.name.includes('Production') && ['masters', 'manufacturing', 'inventory', 'quality', 'subcontracting', 'reports'].includes(mod)) {
            canCreate = 1; canEdit = 1; canSubmit = 1;
            if (r.name === 'Production Manager') { canApprove = 1; canCancel = 1; }
          } else if ((r.name === 'Accountant' || r.name === 'Finance Manager') && ['masters', 'accounting', 'procurement', 'sales', 'assets', 'reports'].includes(mod)) {
            canCreate = 1; canEdit = 1; canSubmit = 1;
            if (r.name === 'Finance Manager') { canApprove = 1; canCancel = 1; canAmend = 1; }
          } else if (r.name === 'HR Manager' && ['hr', 'projects', 'reports'].includes(mod)) {
            canCreate = 1; canEdit = 1; canSubmit = 1; canApprove = 1;
          } else if (r.name === 'Quality Control' && ['quality', 'manufacturing', 'inventory', 'reports'].includes(mod)) {
            canCreate = 1; canEdit = 1; canSubmit = 1; canApprove = 1;
          }
          if (mod === 'settings') canView = 0;
        }

        insertPerm.run(r.id, mod, docType, canView, canCreate, canEdit, canDelete, canSubmit, canCancel, canAmend, canApprove, canExport, canPrint);
      }
    }

    // Currencies & Exchange Rates
    const currencies = [
      ['AED', 'UAE Dirham', 'AED', 1],
      ['USD', 'US Dollar', '$', 0],
      ['EUR', 'Euro', '€', 0],
      ['CNY', 'Chinese Yuan', '¥', 0],
      ['INR', 'Indian Rupee', '₹', 0],
    ] as const;
    const insCurr = db.prepare('INSERT INTO currencies (code, name, symbol, is_base, is_active) VALUES (?, ?, ?, ?, 1)');
    for (const [code, name, symbol, isBase] of currencies) insCurr.run(code, name, symbol, isBase);

    const rates = [
      ['USD', 'AED', 3.6725],
      ['EUR', 'AED', 3.98],
      ['CNY', 'AED', 0.51],
      ['INR', 'AED', 0.044],
      ['AED', 'AED', 1.0],
    ] as const;
    const insRate = db.prepare('INSERT INTO exchange_rates (from_currency, to_currency, rate, effective_date, created_at) VALUES (?, ?, ?, ?, ?)');
    for (const [f, t, r] of rates) insRate.run(f, t, r, today, now);

    // UOMs
    const uoms = [
      ['LTR', 'Liter'],
      ['KG', 'Kilogram'],
      ['MT', 'Metric Ton'],
      ['PCS', 'Pieces'],
      ['DRUM', 'Drum (208L)'],
      ['PAIL', 'Pail (20L)'],
      ['CAN', 'Can'],
      ['CARTON', 'Carton'],
      ['BOX', 'Box'],
      ['SET', 'Set'],
    ] as const;
    const insUom = db.prepare('INSERT INTO uoms (code, name, is_active) VALUES (?, ?, 1)');
    for (const [code, name] of uoms) insUom.run(code, name);

    // 16 Item Categories + Hierarchical Parent/Sub-Groups
    const categories = [
      ['BASE OIL', 'Base Oil', 'Virgin & Group I/II/III base oils', 1, 0, 0],
      ['ADDITIVES', 'Additives', 'VI improvers, detergent-dispersant & EP packages', 1, 0, 0],
      ['FG LUBRICANTS', 'Finished Lubricants', 'Engine, hydraulic, gear & industrial oils', 0, 1, 0],
      ['SEMI-FINISHED', 'Semi-Finished Products', 'Bulk blended oil ready for filling', 0, 0, 0],
      ['CAN', 'Empty Cans', 'Tin & metal cans', 0, 0, 1],
      ['BOTTLES', 'Plastic Bottles', 'HDPE 1L / 4L / 5L bottles', 0, 0, 1],
      ['CAPS', 'Caps', 'Induction-sealed screw caps', 0, 0, 1],
      ['CARTON', 'Cartons', 'Corrugated outer cartons', 0, 0, 1],
      ['LABELS', 'Labels', 'Front & back product labels', 0, 0, 1],
      ['DRUMS', 'Drums', '208L steel & plastic drums', 0, 0, 1],
      ['PAILS', 'Pails', '20L / 25L pails & buckets', 0, 0, 1],
      ['CHEMICALS', 'Chemicals', 'Solvents, pour point depressants, dyes', 1, 0, 0],
      ['CONSUMABLE', 'Consumables', 'Filters, lab reagents, grease rags', 0, 0, 0],
      ['SPARE PARTS', 'Spare Parts', 'Filling nozzle seals, pump impellers', 0, 0, 0],
      ['SERVICES', 'Services', 'Subcontract blending, freight & lab testing', 0, 0, 0],
      ['PACKAGING', 'Packaging Materials', 'Shrink film, pallets, induction foils & seals', 0, 0, 1],
    ] as const;
    const insCat = db.prepare(
      'INSERT INTO item_categories (group_code, name, parent_id, is_group, description, is_raw_material, is_finished_good, is_packaging, sort_order) VALUES (?, ?, NULL, 1, ?, ?, ?, ?, ?)'
    );
    categories.forEach(([gc, n, d, rm, fg, pkg], idx) => insCat.run(gc, n, d, rm, fg, pkg, idx + 1));

    const canParent = db.prepare("SELECT id FROM item_categories WHERE name = 'Empty Cans'").get() as { id: number } | undefined;
    if (canParent) {
      db.prepare(
        'INSERT INTO item_categories (group_code, name, parent_id, is_group, description, is_raw_material, is_finished_good, is_packaging, sort_order) VALUES (?, ?, ?, 1, ?, 0, 0, 1, 17)'
      ).run('RM CAN C.M', 'RM CAN C.M', canParent.id, 'Round Metal Cans (C.M) — Gold, Red, Blue & custom litho');
    }

    // Warehouses
    const warehouses = [
      ['WH-RM', 'Raw Materials & Tank Farm', 'ICAD II Bay A', 'Raw Material', 0],
      ['WH-PKG', 'Packaging Materials Store', 'ICAD II Bay B', 'Packaging', 0],
      ['WH-WIP', 'Blending & Filling Floor', 'Production Hall 1', 'WIP', 0],
      ['WH-FG', 'Finished Goods Warehouse', 'ICAD II Bay C', 'Finished Goods', 0],
      ['WH-QC', 'Quarantine / QC Hold Store', 'Lab Annex', 'Quarantine', 0],
      ['WH-SUB', 'Subcontractor External Store', 'External Partner Site', 'Subcontractor', 1],
    ] as const;
    const insWh = db.prepare('INSERT INTO warehouses (code, name, location, warehouse_type, is_subcontractor, is_active) VALUES (?, ?, ?, ?, ?, 1)');
    for (const [c, n, l, t, s] of warehouses) insWh.run(c, n, l, t, s);

    // Default Base Oil & Additive Storage Tanks inside WH-RM
    const rmWh = db.prepare("SELECT id FROM warehouses WHERE code = 'WH-RM'").get() as { id: number } | undefined;
    if (rmWh) {
      const tanks = [
        ['TK-BO-01', 'Base Oil Tank 01 (SN150)', rmWh.id, 'Base Oil', 50000, 'LTR', 500, 'Primary virgin SN150 vertical tank'],
        ['TK-BO-02', 'Base Oil Tank 02 (SN500)', rmWh.id, 'Base Oil', 50000, 'LTR', 500, 'Primary heavy SN500 vertical tank'],
        ['TK-BO-03', 'Base Oil Tank 03 (Bright Stock)', rmWh.id, 'Base Oil', 30000, 'LTR', 300, 'BS150 / heavy base stock tank'],
        ['TK-BO-04', 'Base Oil Tank 04 (Group III Synthetic)', rmWh.id, 'Base Oil', 25000, 'LTR', 250, 'Group III 4cSt / 6cSt synthetic base oil tank'],
        ['TK-ADD-01', 'Additive Bulk Tank A1 (DI Package)', rmWh.id, 'Additive', 10000, 'KG', 100, 'Heated additive package storage tank'],
        ['TK-ADD-02', 'Additive Bulk Tank A2 (VII Polymer)', rmWh.id, 'Additive', 10000, 'KG', 100, 'Viscosity index improver tank'],
      ] as const;
      const insTank = db.prepare(
        `INSERT INTO storage_tanks (tank_code, name, warehouse_id, tank_type, capacity_qty, uom, min_heel_qty, notes, is_active, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`
      );
      for (const [tc, tn, wid, tt, cap, uom, heel, notes] of tanks) {
        insTank.run(tc, tn, wid, tt, cap, uom, heel, notes, now);
      }
    }

    // Payment Terms
    const insPt = db.prepare('INSERT INTO payment_terms (name, description, is_active) VALUES (?, ?, 1)');
    const insPtl = db.prepare('INSERT INTO payment_term_lines (payment_term_id, installment_no, percentage, days_due, payment_mode) VALUES (?, ?, ?, ?, ?)');

    const ptDefs = [
      { name: 'Cash', desc: 'Immediate Cash Settlement', lines: [[1, 100, 0, 'Cash']] },
      { name: 'Advance Payment', desc: '100% Advance before dispatch', lines: [[1, 100, 0, 'Bank Transfer']] },
      { name: 'CDC', desc: 'Current Dated Cheque on Delivery', lines: [[1, 100, 0, 'CDC']] },
      { name: 'CDC Deposit', desc: 'Cheque deposited upon receipt', lines: [[1, 100, 3, 'CDC Deposit']] },
      { name: 'Net 30 Days', desc: 'Full payment within 30 days', lines: [[1, 100, 30, 'Bank Transfer']] },
      { name: 'Net 45 Days', desc: 'Full payment within 45 days', lines: [[1, 100, 45, 'Bank Transfer']] },
      { name: 'Net 60 Days', desc: 'Full payment within 60 days', lines: [[1, 100, 60, 'Bank Transfer']] },
      { name: 'Net 90 Days', desc: 'Full payment within 90 days', lines: [[1, 100, 90, 'Bank Transfer']] },
      { name: '50% 50d / 50% 80d', desc: '50% after 50 days, 50% after 80 days', lines: [[1, 50, 50, 'PDC'], [2, 50, 80, 'PDC']] },
    ];
    for (const pt of ptDefs) {
      const res = insPt.run(pt.name, pt.desc);
      for (const [no, pct, days, mode] of pt.lines) {
        insPtl.run(res.lastInsertRowid, no, pct, days, mode);
      }
    }

    // Document Sequences
    const sequences = [
      ['MR', 'MR-', 1, 4],
      ['PR', 'PR-', 1, 4],
      ['RFQ', 'RFQ-', 1, 4],
      ['SQ', 'SQ-', 1, 4],
      ['PO', 'PO-', 1, 4],
      ['GRN', 'GRN-', 1, 4],
      ['PI', 'PI-', 1, 4],
      ['PRN', 'PRN-', 1, 4],
      ['SUB', 'SUB-', 1, 4],
      ['SO', 'SO-', 1, 4],
      ['SQUOTE', 'QT-', 1, 4],
      ['DN', 'DN-', 1, 4],
      ['SI', 'SI-', 1, 4],
      ['SR', 'SR-', 1, 4],
      ['PV', 'PV-', 1, 4],
      ['RV', 'RV-', 1, 4],
      ['JE', 'JE-', 1, 4],
      ['SE', 'SE-', 1, 4],
      ['BOM', 'BOM-', 1, 4],
      ['PLAN', 'PLAN-', 1, 4],
      ['PROD', 'PROD-', 1, 4],
      ['BLEND', 'BLEND-', 1, 4],
      ['FILL', 'FILL-', 1, 4],
      ['QC', 'QC-', 1, 4],
      ['EXP', 'EXP-', 1, 4],
      ['AST', 'AST-', 1, 4],
      ['PAY', 'PAY-', 1, 4],
      ['LEAD', 'LD-', 1, 4],
      ['CMP', 'CMP-', 1, 4],
      ['PRJ', 'PRJ-', 1, 4],
    ] as const;
    const insSeq = db.prepare('INSERT INTO document_sequences (doc_type, prefix, next_number, digits, financial_year, include_fy) VALUES (?, ?, ?, ?, ?, 0)');
    for (const [dt, p, n, d] of sequences) insSeq.run(dt, p, n, d, '2026');

    // Chart of Accounts (Double-Entry Core)
    const accounts = [
      ['1000', 'Assets', 'Asset', 1, 0, 0],
      ['1100', 'Cash on Hand', 'Asset', 0, 0, 1],
      ['1110', 'Emirates NBD Operating Bank', 'Asset', 0, 1, 0],
      ['1120', 'ADCB USD Trade Account', 'Asset', 0, 1, 0],
      ['1200', 'Accounts Receivable', 'Asset', 0, 0, 0],
      ['1300', 'Inventory - Raw Materials & Packaging', 'Asset', 0, 0, 0],
      ['1310', 'Inventory - Work In Progress (Blending)', 'Asset', 0, 0, 0],
      ['1320', 'Inventory - Finished Lubricants', 'Asset', 0, 0, 0],
      ['1330', 'Inventory - Subcontractor Held Stock', 'Asset', 0, 0, 0],
      ['1400', 'VAT Input Recoverable (5%)', 'Asset', 0, 0, 0],
      ['1500', 'Fixed Assets - Blending Plant & Machinery', 'Asset', 0, 0, 0],
      ['1590', 'Accumulated Depreciation', 'Asset', 0, 0, 0],
      ['2000', 'Liabilities', 'Liability', 1, 0, 0],
      ['2100', 'Accounts Payable', 'Liability', 0, 0, 0],
      ['2110', 'Goods Received Not Invoiced (GRNI)', 'Liability', 0, 0, 0],
      ['2200', 'VAT Output Payable (5%)', 'Liability', 0, 0, 0],
      ['2300', 'Accrued Payroll & Expenses', 'Liability', 0, 0, 0],
      ['3000', 'Equity', 'Equity', 1, 0, 0],
      ['3100', 'Share Capital', 'Equity', 0, 0, 0],
      ['3200', 'Retained Earnings', 'Equity', 0, 0, 0],
      ['4000', 'Revenue', 'Income', 1, 0, 0],
      ['4100', 'Lubricant Sales Revenue', 'Income', 0, 0, 0],
      ['4200', 'Sales Returns & Allowances', 'Income', 0, 0, 0],
      ['4300', 'Foreign Exchange Gain', 'Income', 0, 0, 0],
      ['5000', 'Cost of Goods Sold & Expenses', 'Expense', 1, 0, 0],
      ['5100', 'Cost of Goods Sold (COGS)', 'Expense', 0, 0, 0],
      ['5200', 'Subcontracting Service Expense', 'Expense', 0, 0, 0],
      ['5300', 'Manufacturing Labour & Overhead Absorbed', 'Expense', 0, 0, 0],
      ['5400', 'Freight & Logistics Expense', 'Expense', 0, 0, 0],
      ['5500', 'Inventory Adjustment & Wastage', 'Expense', 0, 0, 0],
      ['5600', 'Salaries & Wages Expense', 'Expense', 0, 0, 0],
      ['5700', 'Depreciation Expense', 'Expense', 0, 0, 0],
      ['5800', 'Foreign Exchange Loss', 'Expense', 0, 0, 0],
      ['5900', 'General Operating Expenses', 'Expense', 0, 0, 0],
    ] as const;

    const insAcc = db.prepare('INSERT INTO chart_of_accounts (account_code, account_name, account_type, is_group, is_bank, is_cash, currency, balance, is_active) VALUES (?, ?, ?, ?, ?, ?, ?, 0, 1)');
    for (const [code, name, type, grp, bank, cash] of accounts) {
      insAcc.run(code, name, type, grp, bank, cash, code === '1120' ? 'USD' : 'AED');
    }

    const bankGl = (db.prepare("SELECT id FROM chart_of_accounts WHERE account_code = '1110'").get() as { id: number }).id;
    const usdGl = (db.prepare("SELECT id FROM chart_of_accounts WHERE account_code = '1120'").get() as { id: number }).id;
    db.prepare('INSERT INTO bank_accounts (account_name, bank_name, account_number, iban, swift, currency, gl_account_id, current_balance, is_active) VALUES (?, ?, ?, ?, ?, ?, ?, 0, 1)').run(
      'ENBD Main AED Account', 'Emirates NBD', '101488291001', 'AE07026000101488291001', 'EBILAEAD', 'AED', bankGl
    );
    db.prepare('INSERT INTO bank_accounts (account_name, bank_name, account_number, iban, swift, currency, gl_account_id, current_balance, is_active) VALUES (?, ?, ?, ?, ?, ?, ?, 0, 1)').run(
      'ADCB USD Trade Account', 'Abu Dhabi Commercial Bank', '409921004412', 'AE44003000409921004412', 'ADCBAEAA', 'USD', usdGl
    );

    // QC Parameters for Lubricants Lab
    const qcParams = [
      ['Kinematic Viscosity @ 100°C', 'cSt', 'ASTM D445', 16.3, 21.9, 'numeric'],
      ['Kinematic Viscosity @ 40°C', 'cSt', 'ASTM D445', 140.0, 185.0, 'numeric'],
      ['Viscosity Index', 'VI', 'ASTM D2270', 120.0, 160.0, 'numeric'],
      ['Density @ 15°C', 'g/cm³', 'ASTM D4052', 0.85, 0.90, 'numeric'],
      ['Flash Point (COC)', '°C', 'ASTM D92', 215.0, 265.0, 'numeric'],
      ['Pour Point', '°C', 'ASTM D97', -36.0, -15.0, 'numeric'],
      ['Total Base Number (TBN)', 'mg KOH/g', 'ASTM D2896', 6.5, 12.0, 'numeric'],
      ['Appearance', 'Visual', 'Visual', null, null, 'text'],
      ['ASTM Colour', 'ASTM', 'ASTM D1500', 1.0, 4.5, 'numeric'],
    ] as const;
    const insQc = db.prepare('INSERT INTO qc_parameters (name, unit, method, default_min, default_max, data_type, is_active) VALUES (?, ?, ?, ?, ?, ?, 1)');
    for (const [n, u, m, mn, mx, dt] of qcParams) insQc.run(n, u, m, mn, mx, dt);

    // Default Configurable Approval Rules
    const roleMap = Object.fromEntries(allRoles.map((r) => [r.name, r.id]));
    const insRule = db.prepare('INSERT INTO approval_rules (doc_type, department, role_id, min_amount, max_amount, currency, priority, is_active) VALUES (?, ?, ?, ?, ?, ?, ?, 1)');
    // PO rules: <=5000 Purchase Manager, 5001-25000 Purchase/Dept Manager, >25000 Super Admin/GM
    insRule.run('PurchaseOrder', '', roleMap['Purchase Manager'], 0, 5000, 'AED', 1);
    insRule.run('PurchaseOrder', '', roleMap['Finance Manager'], 5000.01, 25000, 'AED', 2);
    insRule.run('PurchaseOrder', '', roleMap['Super Admin'], 25000.01, null, 'AED', 3);
    // Payment Voucher rules
    insRule.run('PaymentVoucher', '', roleMap['Finance Manager'], 0, 5000, 'AED', 1);
    insRule.run('PaymentVoucher', '', roleMap['Super Admin'], 5000.01, null, 'AED', 2);
    // Stock Adjustment rules
    insRule.run('StockAdjustment', '', roleMap['Store Manager'], 0, 2000, 'AED', 1);
    insRule.run('StockAdjustment', '', roleMap['Finance Manager'], 2000.01, null, 'AED', 2);

    // Departments & Designations
    for (const d of ['Management', 'Procurement', 'Production & Blending', 'Quality Control', 'Warehouse & Logistics', 'Sales & Distribution', 'Finance & Accounts', 'HR & Admin']) {
      db.prepare('INSERT INTO departments (name, manager_name) VALUES (?, ?)').run(d, '');
    }
    for (const des of ['General Manager', 'Plant Manager', 'Master Blender', 'QC Lab Chemist', 'Procurement Lead', 'Storekeeper', 'Sales Executive', 'Chief Accountant', 'Filling Line Operator']) {
      db.prepare('INSERT INTO designations (name) VALUES (?)').run(des);
    }

    // Financial Period 2026
    db.prepare('INSERT INTO financial_periods (name, start_date, end_date, is_closed) VALUES (?, ?, ?, 0)').run(
      'FY 2026', '2026-01-01', '2026-12-31'
    );

    // System Settings
    const sysSettings = [
      ['allow_negative_stock', 'false', 'inventory', 'Allow stock ledger transactions that result in negative inventory'],
      ['default_valuation_method', 'Moving Average', 'inventory', 'Default inventory valuation method (Moving Average or FIFO)'],
      ['three_way_match_qty_tolerance_pct', '2.0', 'procurement', 'Allowed quantity variance percentage for 3-way invoice matching'],
      ['three_way_match_price_tolerance_pct', '1.5', 'procurement', 'Allowed price variance percentage for 3-way invoice matching'],
      ['default_vat_rate', '5.0', 'accounting', 'Default UAE VAT rate percentage'],
      ['auto_backup_enabled', 'true', 'backup', 'Enable scheduled local database snapshots'],
      ['email_notifications_enabled', 'false', 'notifications', 'Enable SMTP email alerts (configured in server environment)'],
    ] as const;
    const insSet = db.prepare('INSERT INTO system_settings (key, value, category, description, updated_at) VALUES (?, ?, ?, ?, ?)');
    for (const [k, v, c, d] of sysSettings) insSet.run(k, v, c, d, now);
  });

  tx();
}
