import { Router } from 'express';
import multer from 'multer';
import * as XLSX from 'xlsx';
import { getDb, withTransaction } from '../db.ts';
import { authenticate, recordAuditLog, requirePermission, type AuthRequest } from '../middleware/auth.ts';
import { nowISO, roundMoney, roundQty, todayISO } from '../utils/helpers.ts';
import { getNextDocumentNumber } from '../services/numbering.ts';
import { postStockMovement } from '../services/inventory.ts';
import { postJournalEntry } from '../services/accounting.ts';

const router = Router();
router.use(authenticate);

export type ImportType =
  | 'opening_stock'
  | 'stock_adjustment'
  | 'boms'
  | 'items'
  | 'item_groups'
  | 'tanks'
  | 'suppliers'
  | 'customers';

interface ImportSpec {
  type: ImportType;
  label: string;
  description: string;
  permModule: string;
  columns: { key: string; header: string; required?: boolean; note: string }[];
  sampleRows: Record<string, string | number>[];
}

const IMPORT_SPECS: Record<ImportType, ImportSpec> = {
  opening_stock: {
    type: 'opening_stock',
    label: 'Opening Stock & Warehouse / Tank Balances',
    description: 'Upload all opening inventory balances (Base Oils into Tanks, Additives, Packaging, Finished Lubricants) in one Excel sheet.',
    permModule: 'inventory',
    columns: [
      { key: 'item_code', header: 'Item Code*', required: true, note: 'Existing Item Code (e.g. RM-SN150)' },
      { key: 'warehouse_code', header: 'Warehouse Code*', required: true, note: 'Warehouse Code (e.g. WH-RM, WH-PKG, WH-FG)' },
      { key: 'tank_code', header: 'Tank Code', note: 'Optional Storage Tank Code for Base Oils / Additives (e.g. TK-BO-01)' },
      { key: 'batch_number', header: 'Batch Number', note: 'Optional Batch/Lot # (auto-generated if empty)' },
      { key: 'qty', header: 'Quantity*', required: true, note: 'Opening Quantity (> 0)' },
      { key: 'unit_cost', header: 'Unit Cost', note: 'Optional cost per unit (defaults to Item Standard Cost)' },
      { key: 'mfg_date', header: 'Mfg Date', note: 'YYYY-MM-DD (optional)' },
      { key: 'expiry_date', header: 'Expiry Date', note: 'YYYY-MM-DD (optional)' },
      { key: 'qc_status', header: 'QC Status', note: 'Released or Pending (default: Released)' },
      { key: 'remarks', header: 'Remarks', note: 'Optional note' },
    ],
    sampleRows: [
      {
        item_code: 'RM-SN150',
        warehouse_code: 'WH-RM',
        tank_code: 'TK-BO-01',
        batch_number: 'OPEN-SN150-01',
        qty: 5000,
        unit_cost: 3.85,
        mfg_date: todayISO(),
        expiry_date: '',
        qc_status: 'Released',
        remarks: 'Opening tank stock',
      },
      {
        item_code: 'PKG-BTL-1L',
        warehouse_code: 'WH-PKG',
        tank_code: '',
        batch_number: 'OPEN-BTL-01',
        qty: 3000,
        unit_cost: 0.85,
        mfg_date: todayISO(),
        expiry_date: '',
        qc_status: 'Released',
        remarks: 'Opening packaging stock',
      },
    ],
  },
  stock_adjustment: {
    type: 'stock_adjustment',
    label: 'Stock Movements (Receipts, Issues & Tank Transfers)',
    description: 'Bulk post warehouse receipts, issues, or tank-to-tank transfers in a single batch.',
    permModule: 'inventory',
    columns: [
      { key: 'entry_type', header: 'Entry Type*', required: true, note: 'Stock Receipt | Stock Issue | Warehouse Transfer' },
      { key: 'item_code', header: 'Item Code*', required: true, note: 'Existing Item Code' },
      { key: 'from_warehouse_code', header: 'From Warehouse Code', note: 'Required for Issue / Transfer' },
      { key: 'to_warehouse_code', header: 'To Warehouse Code', note: 'Required for Receipt / Transfer' },
      { key: 'from_tank_code', header: 'From Tank Code', note: 'Optional source tank' },
      { key: 'to_tank_code', header: 'To Tank Code', note: 'Optional destination tank' },
      { key: 'batch_number', header: 'Batch Number', note: 'Optional batch number' },
      { key: 'qty', header: 'Quantity*', required: true, note: 'Movement quantity (> 0)' },
      { key: 'unit_cost', header: 'Unit Cost', note: 'Optional unit cost' },
      { key: 'remarks', header: 'Remarks', note: 'Movement reason' },
    ],
    sampleRows: [
      {
        entry_type: 'Stock Receipt',
        item_code: 'RM-SN150',
        from_warehouse_code: '',
        to_warehouse_code: 'WH-RM',
        from_tank_code: '',
        to_tank_code: 'TK-BO-01',
        batch_number: 'IMP-REC-01',
        qty: 1000,
        unit_cost: 3.9,
        remarks: 'Bulk receipt import',
      },
    ],
  },
  boms: {
    type: 'boms',
    label: 'Bills of Materials (BOM & Formulas)',
    description: 'Import lubricant formulations & packaging BOMs. Rows sharing the same Finished Item Code & Version automatically group into one multi-line BOM.',
    permModule: 'manufacturing',
    columns: [
      { key: 'finished_item_code', header: 'Finished Item Code*', required: true, note: 'Finished Goods SKU Code' },
      { key: 'version', header: 'Version*', required: true, note: 'e.g. v1.0, v2.0' },
      { key: 'batch_size', header: 'Batch Size*', required: true, note: 'Standard output qty (e.g. 1000)' },
      { key: 'labour_cost', header: 'Labour Cost', note: 'Total batch labour cost' },
      { key: 'overhead_cost', header: 'Overhead Cost', note: 'Total batch overhead cost' },
      { key: 'expected_wastage_pct', header: 'Expected Wastage %', note: 'Default 0.5' },
      { key: 'component_item_code', header: 'Component Item Code*', required: true, note: 'Raw Material, Additive, or Packaging Item Code' },
      { key: 'component_type', header: 'Component Type*', required: true, note: 'Formula or Packaging' },
      { key: 'component_qty', header: 'Component Qty*', required: true, note: 'Qty per Batch Size' },
      { key: 'wastage_pct', header: 'Line Wastage %', note: 'Optional line wastage %' },
      { key: 'carton_packing_qty', header: 'Carton Packing Qty', note: 'Units per carton (e.g. 12 for Master Cartons)' },
      { key: 'notes', header: 'Notes', note: 'Formulation notes' },
    ],
    sampleRows: [
      {
        finished_item_code: 'FG-20W50-1L',
        version: 'v1.0',
        batch_size: 1000,
        labour_cost: 450,
        overhead_cost: 350,
        expected_wastage_pct: 0.5,
        component_item_code: 'RM-SN150',
        component_type: 'Formula',
        component_qty: 420,
        wastage_pct: 0.5,
        carton_packing_qty: 0,
        notes: 'Standard 20W50 API SL/CF formulation',
      },
      {
        finished_item_code: 'FG-20W50-1L',
        version: 'v1.0',
        batch_size: 1000,
        labour_cost: 450,
        overhead_cost: 350,
        expected_wastage_pct: 0.5,
        component_item_code: 'PKG-BTL-1L',
        component_type: 'Packaging',
        component_qty: 1000,
        wastage_pct: 0,
        carton_packing_qty: 0,
        notes: 'Standard 20W50 API SL/CF formulation',
      },
    ],
  },
  items: {
    type: 'items',
    label: 'Items & Group-Wise SKUs',
    description: 'Bulk import or update items across hierarchical parent/sub-groups (e.g. CAN -> RM CAN C.M -> EMPTY CAN (1L) GOLD C.M).',
    permModule: 'masters',
    columns: [
      { key: 'item_code', header: 'Item Code*', required: true, note: 'Unique SKU / Item Code' },
      { key: 'name', header: 'Item Name*', required: true, note: 'Full Item Description' },
      { key: 'parent_group', header: 'Parent Group', note: 'Optional Parent Group (e.g. CAN, BASE OIL, CARTON)' },
      { key: 'category_name', header: 'Sub-Group / Category*', required: true, note: 'Group Name (auto-created under Parent Group if new)' },
      { key: 'brand', header: 'Brand', note: 'Optional brand' },
      { key: 'purchase_uom', header: 'Purchase UOM', note: 'LTR, KG, PCS, DRUM, CARTON (default LTR)' },
      { key: 'stock_uom', header: 'Stock UOM', note: 'Default matches Purchase UOM' },
      { key: 'sales_uom', header: 'Sales UOM', note: 'Default matches Stock UOM' },
      { key: 'standard_cost', header: 'Standard Cost', note: 'Default cost per stock UOM' },
      { key: 'selling_price', header: 'Selling Price', note: 'Default sales price' },
      { key: 'vat_rate', header: 'VAT %', note: 'Default 5' },
      { key: 'reorder_level', header: 'Reorder Level', note: 'MRP reorder trigger' },
      { key: 'default_warehouse_code', header: 'Default Warehouse Code', note: 'e.g. WH-RM, WH-PKG, WH-FG' },
      { key: 'batch_tracking', header: 'Batch Tracking (1/0)', note: '1 = Yes, 0 = No (default 1)' },
    ],
    sampleRows: [
      {
        item_code: 'CAN-1L-GOLD',
        name: 'EMPTY CAN (1L) GOLD C.M',
        parent_group: 'CAN',
        category_name: 'RM CAN C.M',
        brand: 'Standard',
        purchase_uom: 'PCS',
        stock_uom: 'PCS',
        sales_uom: 'PCS',
        standard_cost: 2.15,
        selling_price: 0,
        vat_rate: 5,
        reorder_level: 1000,
        default_warehouse_code: 'WH-PKG',
        batch_tracking: 1,
      },
    ],
  },
  item_groups: {
    type: 'item_groups',
    label: 'Hierarchical Item Groups',
    description: 'Create parent item groups (CAN, CARTON, LABELS, BASE OIL, CONSUMABLE) and nested sub-groups.',
    permModule: 'masters',
    columns: [
      { key: 'group_code', header: 'Group Code*', required: true, note: 'Unique Group Code (e.g. RM-CAN-CM)' },
      { key: 'name', header: 'Group Name*', required: true, note: 'e.g. RM CAN C.M' },
      { key: 'parent_group_code', header: 'Parent Group Code', note: 'Leave blank for Top-Level Parent Group' },
      { key: 'is_raw_material', header: 'Raw Material (1/0)', note: '1 or 0' },
      { key: 'is_packaging', header: 'Packaging (1/0)', note: '1 or 0' },
      { key: 'is_finished_good', header: 'Finished Good (1/0)', note: '1 or 0' },
      { key: 'description', header: 'Description', note: 'Optional notes' },
    ],
    sampleRows: [
      { group_code: 'CAN', name: 'CAN', parent_group_code: '', is_raw_material: 0, is_packaging: 1, is_finished_good: 0, description: 'All Metal & Tin Cans' },
      { group_code: 'RM-CAN-CM', name: 'RM CAN C.M', parent_group_code: 'CAN', is_raw_material: 0, is_packaging: 1, is_finished_good: 0, description: 'C.M Litho Cans' },
    ],
  },
  tanks: {
    type: 'tanks',
    label: 'Warehouse Storage Tanks',
    description: 'Create multiple Base Oil, Additive, Solvent, and Bulk Blend storage tanks per warehouse.',
    permModule: 'masters',
    columns: [
      { key: 'tank_code', header: 'Tank Code*', required: true, note: 'Unique Tank Code (e.g. TK-BO-04)' },
      { key: 'name', header: 'Tank Name*', required: true, note: 'e.g. Base Oil SN150 Tank #4' },
      { key: 'warehouse_code', header: 'Warehouse Code*', required: true, note: 'e.g. WH-RM' },
      { key: 'tank_type', header: 'Tank Type', note: 'Base Oil | Additive | Solvent | Bulk Blend' },
      { key: 'capacity_qty', header: 'Capacity*', required: true, note: 'Max capacity (e.g. 50000)' },
      { key: 'uom', header: 'UOM', note: 'LTR or KG (default LTR)' },
      { key: 'assigned_item_code', header: 'Assigned Item Code', note: 'Optional dedicated Base Oil / Additive code' },
      { key: 'min_heel_qty', header: 'Min Heel Qty', note: 'Minimum pumpable heel' },
      { key: 'temperature_c', header: 'Temp (°C)', note: 'Operating temperature' },
    ],
    sampleRows: [
      {
        tank_code: 'TK-BO-04',
        name: 'Base Oil Group II N150 Tank 4',
        warehouse_code: 'WH-RM',
        tank_type: 'Base Oil',
        capacity_qty: 50000,
        uom: 'LTR',
        assigned_item_code: 'RM-SN150',
        min_heel_qty: 1000,
        temperature_c: 28,
      },
    ],
  },
  suppliers: {
    type: 'suppliers',
    label: 'Suppliers Master',
    description: 'Bulk import vendor / supplier accounts with TRN, currency, and contact details.',
    permModule: 'masters',
    columns: [
      { key: 'code', header: 'Supplier Code', note: 'Auto-generated if blank' },
      { key: 'name', header: 'Supplier Name*', required: true, note: 'Legal vendor name' },
      { key: 'contact_person', header: 'Contact Person', note: 'Primary contact' },
      { key: 'email', header: 'Email', note: 'Email address' },
      { key: 'telephone', header: 'Telephone', note: 'Phone number' },
      { key: 'address', header: 'Address', note: 'Street / Industrial area' },
      { key: 'country', header: 'Country', note: 'Default United Arab Emirates' },
      { key: 'trn', header: 'TRN', note: 'Tax Registration Number' },
      { key: 'currency', header: 'Currency', note: 'AED / USD / EUR' },
      { key: 'credit_limit', header: 'Credit Limit', note: 'Numeric credit limit' },
    ],
    sampleRows: [
      {
        code: 'SUP-IMP-01',
        name: 'Emirates Packaging Industries LLC',
        contact_person: 'Rashid Al Nuaimi',
        email: 'sales@epi.local',
        telephone: '+971 4 555 2100',
        address: 'Jebel Ali Industrial 1, Dubai',
        country: 'United Arab Emirates',
        trn: '100445566700003',
        currency: 'AED',
        credit_limit: 200000,
      },
    ],
  },
  customers: {
    type: 'customers',
    label: 'Customers Master',
    description: 'Bulk import customer / distributor accounts with TRN, credit limit, and contact details.',
    permModule: 'masters',
    columns: [
      { key: 'code', header: 'Customer Code', note: 'Auto-generated if blank' },
      { key: 'name', header: 'Customer Name*', required: true, note: 'Legal customer name' },
      { key: 'contact_person', header: 'Contact Person', note: 'Primary contact' },
      { key: 'email', header: 'Email', note: 'Email address' },
      { key: 'telephone', header: 'Telephone', note: 'Phone number' },
      { key: 'address', header: 'Address', note: 'Delivery address' },
      { key: 'country', header: 'Country', note: 'Default United Arab Emirates' },
      { key: 'trn', header: 'TRN', note: 'Tax Registration Number' },
      { key: 'currency', header: 'Currency', note: 'AED / USD / EUR' },
      { key: 'credit_limit', header: 'Credit Limit', note: 'Numeric credit limit' },
    ],
    sampleRows: [
      {
        code: 'CUST-IMP-01',
        name: 'Desert Express Fleet Services LLC',
        contact_person: 'Tariq Saeed',
        email: 'orders@desertfleet.local',
        telephone: '+971 2 555 3400',
        address: 'Mussafah M-14, Abu Dhabi',
        country: 'United Arab Emirates',
        trn: '100778899000003',
        currency: 'AED',
        credit_limit: 150000,
      },
    ],
  },
};

const sheetUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const lower = file.originalname.toLowerCase();
    if (lower.endsWith('.xlsx') || lower.endsWith('.xls') || lower.endsWith('.csv')) {
      cb(null, true);
    } else {
      cb(new Error('Only .xlsx, .xls, or .csv spreadsheet files are allowed'));
    }
  },
});

function normalizeHeaderKey(raw: string): string {
  return String(raw || '')
    .trim()
    .toLowerCase()
    .replace(/\*/g, '')
    .replace(/\(1\/0\)/g, '')
    .replace(/[()%]/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

const HEADER_ALIASES: Record<string, string> = {
  item: 'item_code',
  sku: 'item_code',
  code: 'code',
  item_name: 'name',
  description: 'description',
  warehouse: 'warehouse_code',
  wh_code: 'warehouse_code',
  tank: 'tank_code',
  quantity: 'qty',
  opening_qty: 'qty',
  cost: 'unit_cost',
  rate: 'unit_cost',
  batch: 'batch_number',
  batch_no: 'batch_number',
  finished_item: 'finished_item_code',
  fg_code: 'finished_item_code',
  fg_item_code: 'finished_item_code',
  component_code: 'component_item_code',
  component_item: 'component_item_code',
  raw_material_code: 'component_item_code',
  type: 'component_type',
  sub_group_category: 'category_name',
  sub_group: 'category_name',
  category: 'category_name',
  group: 'category_name',
  group_name: 'name',
  vat: 'vat_rate',
  capacity: 'capacity_qty',
  assigned_item: 'assigned_item_code',
  temp_c: 'temperature_c',
  temp: 'temperature_c',
  supplier_code: 'code',
  supplier_name: 'name',
  customer_code: 'code',
  customer_name: 'name',
  raw_material: 'is_raw_material',
  packaging: 'is_packaging',
  finished_good: 'is_finished_good',
  batch_tracking_1_0: 'batch_tracking',
};

function mapRawRow(raw: Record<string, unknown>, spec: ImportSpec): Record<string, string> {
  const out: Record<string, string> = {};
  const validKeys = new Set(spec.columns.map((c) => c.key));
  for (const [k, v] of Object.entries(raw)) {
    const norm = normalizeHeaderKey(k);
    const target = validKeys.has(norm) ? norm : HEADER_ALIASES[norm] && validKeys.has(HEADER_ALIASES[norm]) ? HEADER_ALIASES[norm] : norm;
    if (v !== undefined && v !== null) {
      out[target] = String(v).trim();
    }
  }
  return out;
}

function parseUploadedSpreadsheet(buffer: Buffer): Record<string, unknown>[] {
  const wb = XLSX.read(buffer, { type: 'buffer', cellDates: true });
  const sheetName = wb.SheetNames[0];
  if (!sheetName) throw new Error('Uploaded workbook contains no sheets');
  const ws = wb.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(ws, { defval: '' });
  return rows.filter((r) => Object.values(r).some((v) => String(v ?? '').trim() !== ''));
}

function isValidType(type: string): type is ImportType {
  return type in IMPORT_SPECS;
}

function validateAndNormalizeRows(type: ImportType, rawRows: Record<string, unknown>[]) {
  const spec = IMPORT_SPECS[type];
  const db = getDb();

  const itemsList = db.prepare('SELECT id, item_code, name, standard_cost, stock_uom FROM items').all() as {
    id: number;
    item_code: string;
    name: string;
    standard_cost: number;
    stock_uom: string;
  }[];
  const itemByCode = new Map(itemsList.map((i) => [i.item_code.toUpperCase(), i]));

  const whList = db.prepare('SELECT id, code, name FROM warehouses').all() as { id: number; code: string; name: string }[];
  const whByCode = new Map(whList.map((w) => [w.code.toUpperCase(), w]));

  const tankList = db
    .prepare('SELECT id, tank_code, warehouse_id, capacity_qty, current_qty, assigned_item_id FROM storage_tanks')
    .all() as { id: number; tank_code: string; warehouse_id: number; capacity_qty: number; current_qty: number; assigned_item_id: number | null }[];
  const tankByCode = new Map(tankList.map((t) => [t.tank_code.toUpperCase(), t]));

  const catList = db.prepare('SELECT id, group_code, name FROM item_categories').all() as { id: number; group_code: string; name: string }[];
  const catByCodeOrName = new Map<string, number>();
  for (const c of catList) {
    if (c.group_code) catByCodeOrName.set(c.group_code.toUpperCase(), c.id);
    catByCodeOrName.set(c.name.toUpperCase(), c.id);
  }

  // Track cumulative tank levels in preview so capacity & anti-mix errors surface immediately
  const simulatedTankQty = new Map<number, number>(tankList.map((t) => [t.id, Number(t.current_qty || 0)]));
  const simulatedTankItem = new Map<number, number | null>(tankList.map((t) => [t.id, t.assigned_item_id]));

  const validated = rawRows.map((raw, idx) => {
    const rowNumber = idx + 2; // Excel row index (1 = header)
    const mapped = mapRawRow(raw, spec);
    const errors: string[] = [];

    for (const col of spec.columns) {
      if (col.required && !mapped[col.key]) {
        errors.push(`Missing required field: ${col.header.replace('*', '')}`);
      }
    }

    if (type === 'opening_stock') {
      const item = mapped.item_code ? itemByCode.get(mapped.item_code.toUpperCase()) : undefined;
      if (mapped.item_code && !item) errors.push(`Unknown Item Code: ${mapped.item_code}`);
      const wh = mapped.warehouse_code ? whByCode.get(mapped.warehouse_code.toUpperCase()) : undefined;
      if (mapped.warehouse_code && !wh) errors.push(`Unknown Warehouse Code: ${mapped.warehouse_code}`);
      const qty = Number(mapped.qty || 0);
      if (!(qty > 0)) errors.push('Quantity must be greater than 0');

      if (mapped.tank_code) {
        const tk = tankByCode.get(mapped.tank_code.toUpperCase());
        if (!tk) {
          errors.push(`Unknown Tank Code: ${mapped.tank_code}`);
        } else {
          if (wh && tk.warehouse_id !== wh.id) {
            errors.push(`Tank ${tk.tank_code} does not belong to warehouse ${wh.code}`);
          }
          if (item) {
            const curQty = simulatedTankQty.get(tk.id) || 0;
            const curItem = simulatedTankItem.get(tk.id);
            if (curQty > 0 && curItem && curItem !== item.id) {
              errors.push(`Tank ${tk.tank_code} already contains another material`);
            } else if (tk.capacity_qty > 0 && curQty + qty > tk.capacity_qty) {
              errors.push(`Tank ${tk.tank_code} capacity (${tk.capacity_qty}) exceeded (${curQty + qty})`);
            } else {
              simulatedTankQty.set(tk.id, curQty + qty);
              simulatedTankItem.set(tk.id, item.id);
            }
          }
        }
      }
    } else if (type === 'stock_adjustment') {
      const et = mapped.entry_type;
      if (et && !['Stock Receipt', 'Stock Issue', 'Warehouse Transfer'].includes(et)) {
        errors.push('Entry Type must be Stock Receipt, Stock Issue, or Warehouse Transfer');
      }
      const item = mapped.item_code ? itemByCode.get(mapped.item_code.toUpperCase()) : undefined;
      if (mapped.item_code && !item) errors.push(`Unknown Item Code: ${mapped.item_code}`);
      if (!(Number(mapped.qty || 0) > 0)) errors.push('Quantity must be greater than 0');
      if (['Stock Receipt', 'Warehouse Transfer'].includes(et) && (!mapped.to_warehouse_code || !whByCode.has(mapped.to_warehouse_code.toUpperCase()))) {
        errors.push(`Valid To Warehouse Code required for ${et}`);
      }
      if (['Stock Issue', 'Warehouse Transfer'].includes(et) && (!mapped.from_warehouse_code || !whByCode.has(mapped.from_warehouse_code.toUpperCase()))) {
        errors.push(`Valid From Warehouse Code required for ${et}`);
      }
      if (mapped.from_tank_code && !tankByCode.has(mapped.from_tank_code.toUpperCase())) {
        errors.push(`Unknown From Tank Code: ${mapped.from_tank_code}`);
      }
      if (mapped.to_tank_code && !tankByCode.has(mapped.to_tank_code.toUpperCase())) {
        errors.push(`Unknown To Tank Code: ${mapped.to_tank_code}`);
      }
    } else if (type === 'boms') {
      if (mapped.finished_item_code && !itemByCode.has(mapped.finished_item_code.toUpperCase())) {
        errors.push(`Unknown Finished Item Code: ${mapped.finished_item_code}`);
      }
      if (mapped.component_item_code && !itemByCode.has(mapped.component_item_code.toUpperCase())) {
        errors.push(`Unknown Component Item Code: ${mapped.component_item_code}`);
      }
      if (!(Number(mapped.batch_size || 0) > 0)) errors.push('Batch Size must be > 0');
      if (!(Number(mapped.component_qty || 0) > 0)) errors.push('Component Qty must be > 0');
      if (mapped.component_type && !['Formula', 'Packaging'].includes(mapped.component_type)) {
        errors.push('Component Type must be Formula or Packaging');
      }
    } else if (type === 'items') {
      if (mapped.default_warehouse_code && !whByCode.has(mapped.default_warehouse_code.toUpperCase())) {
        errors.push(`Unknown Default Warehouse Code: ${mapped.default_warehouse_code}`);
      }
    } else if (type === 'tanks') {
      if (mapped.warehouse_code && !whByCode.has(mapped.warehouse_code.toUpperCase())) {
        errors.push(`Unknown Warehouse Code: ${mapped.warehouse_code}`);
      }
      if (!(Number(mapped.capacity_qty || 0) > 0)) errors.push('Capacity must be > 0');
      if (mapped.assigned_item_code && !itemByCode.has(mapped.assigned_item_code.toUpperCase())) {
        errors.push(`Unknown Assigned Item Code: ${mapped.assigned_item_code}`);
      }
    }

    return {
      rowNumber,
      valid: errors.length === 0,
      errors,
      normalized: mapped,
    };
  });

  const validCount = validated.filter((r) => r.valid).length;
  return {
    type,
    totalRows: validated.length,
    validCount,
    errorCount: validated.length - validCount,
    rows: validated,
  };
}

// List available import types & column specs
router.get('/types', (_req, res) => {
  res.json({
    types: Object.values(IMPORT_SPECS).map((s) => ({
      type: s.type,
      label: s.label,
      description: s.description,
      columns: s.columns,
    })),
  });
});

// Download ready-to-fill .xlsx template (with example rows + live reference sheet)
router.get('/template/:type', (req, res) => {
  const type = String(req.params.type);
  if (!isValidType(type)) {
    res.status(400).json({ error: `Unsupported template type: ${type}` });
    return;
  }
  const spec = IMPORT_SPECS[type];
  const db = getDb();

  // Build Template sheet using canonical machine-friendly headers (human readable)
  const headers = spec.columns.map((c) => c.header);
  const sampleAoA = [
    headers,
    ...spec.sampleRows.map((row) => spec.columns.map((c) => row[c.key] ?? '')),
  ];

  // Dynamically populate first sample row codes from live DB if available so first-time users get real codes
  if (type === 'opening_stock' || type === 'stock_adjustment') {
    const firstItem = db.prepare('SELECT item_code, standard_cost FROM items ORDER BY id ASC LIMIT 1').get() as { item_code: string; standard_cost: number } | undefined;
    const firstWh = db.prepare('SELECT code FROM warehouses ORDER BY id ASC LIMIT 1').get() as { code: string } | undefined;
    const firstTk = db.prepare('SELECT tank_code FROM storage_tanks ORDER BY id ASC LIMIT 1').get() as { tank_code: string } | undefined;
    if (firstItem && firstWh && sampleAoA[1]) {
      const codeIdx = spec.columns.findIndex((c) => c.key === 'item_code');
      const whIdx = spec.columns.findIndex((c) => c.key === 'warehouse_code' || c.key === 'to_warehouse_code');
      const tkIdx = spec.columns.findIndex((c) => c.key === 'tank_code' || c.key === 'to_tank_code');
      const costIdx = spec.columns.findIndex((c) => c.key === 'unit_cost');
      if (codeIdx >= 0) sampleAoA[1][codeIdx] = firstItem.item_code;
      if (whIdx >= 0) sampleAoA[1][whIdx] = firstWh.code;
      if (tkIdx >= 0 && firstTk) sampleAoA[1][tkIdx] = firstTk.tank_code;
      if (costIdx >= 0 && firstItem.standard_cost) sampleAoA[1][costIdx] = firstItem.standard_cost;
    }
  }

  const wb = XLSX.utils.book_new();
  const templateWs = XLSX.utils.aoa_to_sheet(sampleAoA);
  templateWs['!cols'] = spec.columns.map((c) => ({ wch: Math.max(18, c.header.length + 4) }));
  XLSX.utils.book_append_sheet(wb, templateWs, 'Import_Template');

  // Sheet 2: Field Guide & Live Database Codes
  const guideRows: (string | number)[][] = [
    ['Column Header', 'Required', 'Instructions'],
    ...spec.columns.map((c) => [c.header, c.required ? 'YES' : 'Optional', c.note]),
    [],
    ['--- LIVE WAREHOUSE CODES ---', 'Name', 'Type'],
    ...(db.prepare('SELECT code, name, warehouse_type FROM warehouses ORDER BY id ASC').all() as { code: string; name: string; warehouse_type: string }[]).map((w) => [
      w.code,
      w.name,
      w.warehouse_type,
    ]),
    [],
    ['--- LIVE STORAGE TANK CODES ---', 'Warehouse', 'Assigned Item / Capacity'],
    ...(
      db
        .prepare(
          `SELECT st.tank_code, w.code as wh_code, i.item_code, st.capacity_qty, st.uom
           FROM storage_tanks st JOIN warehouses w ON w.id = st.warehouse_id LEFT JOIN items i ON i.id = st.assigned_item_id`
        )
        .all() as { tank_code: string; wh_code: string; item_code: string | null; capacity_qty: number; uom: string }[]
    ).map((t) => [t.tank_code, t.wh_code, `${t.item_code || 'Unassigned'} (${t.capacity_qty} ${t.uom})`]),
    [],
    ['--- LIVE ITEM CODES (Top 100) ---', 'Item Name', 'Group / UOM'],
    ...(
      db
        .prepare(
          `SELECT i.item_code, i.name, c.name as category_name, i.stock_uom
           FROM items i JOIN item_categories c ON c.id = i.category_id ORDER BY i.id ASC LIMIT 100`
        )
        .all() as { item_code: string; name: string; category_name: string; stock_uom: string }[]
    ).map((i) => [i.item_code, i.name, `${i.category_name} (${i.stock_uom})`]),
  ];

  const guideWs = XLSX.utils.aoa_to_sheet(guideRows);
  guideWs['!cols'] = [{ wch: 28 }, { wch: 36 }, { wch: 46 }];
  XLSX.utils.book_append_sheet(wb, guideWs, 'Instructions_And_Codes');

  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${type}_import_template.xlsx"`);
  res.send(buf);
});

// Preview & validate uploaded Excel/CSV file before committing
router.post('/preview/:type', sheetUpload.single('file'), (req: AuthRequest, res) => {
  const type = String(req.params.type);
  if (!isValidType(type)) {
    res.status(400).json({ error: `Unsupported import type: ${type}` });
    return;
  }
  const spec = IMPORT_SPECS[type];
  // Permission check matching target module
  const permRow = req.user!.role_name === 'Super Admin'
    ? { can_create: 1 }
    : (getDb()
        .prepare('SELECT can_create FROM role_permissions WHERE role_id = ? AND module = ?')
        .get(req.user!.role_id, spec.permModule) as { can_create: number } | undefined);
  if (!permRow || !permRow.can_create) {
    res.status(403).json({ error: `Missing create permission for module: ${spec.permModule}` });
    return;
  }

  try {
    const rawRows = req.file
      ? parseUploadedSpreadsheet(req.file.buffer)
      : Array.isArray((req.body as { rows?: unknown[] }).rows)
      ? ((req.body as { rows: Record<string, unknown>[] }).rows)
      : [];
    if (rawRows.length === 0) {
      res.status(400).json({ error: 'Spreadsheet is empty or contains no data rows' });
      return;
    }
    const validation = validateAndNormalizeRows(type, rawRows);
    res.json(validation);
  } catch (err: unknown) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Failed to parse spreadsheet' });
  }
});

// Commit validated rows into database inside atomic transaction
router.post('/commit/:type', sheetUpload.single('file'), (req: AuthRequest, res) => {
  const type = String(req.params.type);
  if (!isValidType(type)) {
    res.status(400).json({ error: `Unsupported import type: ${type}` });
    return;
  }
  const spec = IMPORT_SPECS[type];
  const permRow = req.user!.role_name === 'Super Admin'
    ? { can_create: 1 }
    : (getDb()
        .prepare('SELECT can_create FROM role_permissions WHERE role_id = ? AND module = ?')
        .get(req.user!.role_id, spec.permModule) as { can_create: number } | undefined);
  if (!permRow || !permRow.can_create) {
    res.status(403).json({ error: `Missing create permission for module: ${spec.permModule}` });
    return;
  }

  try {
    const bodyObj = req.body as { rows?: Record<string, unknown>[]; post_gl?: boolean | string };
    const rawRows = req.file ? parseUploadedSpreadsheet(req.file.buffer) : Array.isArray(bodyObj.rows) ? bodyObj.rows : [];
    if (rawRows.length === 0) {
      res.status(400).json({ error: 'No rows provided to import' });
      return;
    }

    const validation = validateAndNormalizeRows(type, rawRows);
    if (validation.errorCount > 0) {
      const firstErr = validation.rows.find((r) => !r.valid);
      res.status(400).json({
        error: `Validation failed on ${validation.errorCount} row(s). Row ${firstErr?.rowNumber}: ${firstErr?.errors.join('; ')}`,
        validation,
      });
      return;
    }

    const postGl = bodyObj.post_gl === undefined ? true : bodyObj.post_gl === true || bodyObj.post_gl === 'true';

    const summary = withTransaction((db) => {
      const now = nowISO();
      const today = todayISO();

      const getItem = (code: string) =>
        db.prepare('SELECT id, item_code, name, standard_cost, average_cost, stock_uom, category_id FROM items WHERE UPPER(item_code) = UPPER(?)').get(code) as
          | { id: number; item_code: string; name: string; standard_cost: number; average_cost: number; stock_uom: string; category_id: number }
          | undefined;
      const getWh = (code: string) =>
        db.prepare('SELECT id, code, warehouse_type FROM warehouses WHERE UPPER(code) = UPPER(?)').get(code) as
          | { id: number; code: string; warehouse_type: string }
          | undefined;
      const getTank = (code: string) =>
        db.prepare('SELECT id, tank_code FROM storage_tanks WHERE UPPER(tank_code) = UPPER(?)').get(code) as
          | { id: number; tank_code: string }
          | undefined;

      if (type === 'opening_stock') {
        const docNumber = `IMP-OPEN-${Date.now().toString().slice(-6)}`;
        let rmTotalVal = 0;
        let fgTotalVal = 0;
        let count = 0;

        for (const row of validation.rows) {
          const r = row.normalized;
          const item = getItem(r.item_code)!;
          const wh = getWh(r.warehouse_code)!;
          const tk = r.tank_code ? getTank(r.tank_code) : undefined;
          const qty = roundQty(Number(r.qty));
          const cost = Number(r.unit_cost) > 0 ? roundMoney(Number(r.unit_cost)) : roundMoney(item.standard_cost || item.average_cost || 0);
          const qcStatus = r.qc_status === 'Pending' ? 'Pending' : 'Released';

          const mv = postStockMovement(db, {
            postingDate: today,
            docType: 'OpeningStock',
            docId: 1,
            docNumber,
            itemId: item.id,
            warehouseId: wh.id,
            tankId: tk?.id ?? null,
            batchNumber: r.batch_number || undefined,
            inwardQty: qty,
            unitCost: cost,
            mfgDate: r.mfg_date || today,
            expiryDate: r.expiry_date || '',
            qcStatus,
            isOnHold: qcStatus === 'Pending',
            remarks: r.remarks || 'Excel Bulk Opening Stock Import',
            userId: req.user!.id,
          });
          const lineVal = roundMoney(qty * (cost || mv.unitCost));
          if (wh.warehouse_type === 'Finished Goods') fgTotalVal = roundMoney(fgTotalVal + lineVal);
          else rmTotalVal = roundMoney(rmTotalVal + lineVal);
          count++;
        }

        const totalEquity = roundMoney(rmTotalVal + fgTotalVal);
        if (postGl && totalEquity > 0) {
          const lines: { accountCode: string; debit?: number; credit?: number; description: string }[] = [];
          if (rmTotalVal > 0) lines.push({ accountCode: '1300', debit: rmTotalVal, description: `Bulk Opening RM/Pkg Inventory (${docNumber})` });
          if (fgTotalVal > 0) lines.push({ accountCode: '1320', debit: fgTotalVal, description: `Bulk Opening Finished Stock (${docNumber})` });
          lines.push({ accountCode: '3100', credit: totalEquity, description: `Opening Inventory Capital Offset (${docNumber})` });
          postJournalEntry(db, {
            postingDate: today,
            entryType: 'Opening Entry',
            refDocType: 'OpeningBalance',
            refDocId: 1,
            refDocNumber: docNumber,
            narration: `Bulk Excel Opening Stock Import (${count} lines)`,
            lines,
            userId: req.user!.id,
          });
        }

        recordAuditLog(db, req.user, 'Import', null, docNumber, 'Bulk Import Opening Stock', { rows: count, totalValue: totalEquity });
        return { imported: count, doc_number: docNumber, total_value: totalEquity };
      }

      if (type === 'stock_adjustment') {
        const docNumber = getNextDocumentNumber(db, 'SE');
        let totalValue = 0;
        const firstRow = validation.rows[0].normalized;
        const firstFromWh = firstRow.from_warehouse_code ? getWh(firstRow.from_warehouse_code)?.id : null;
        const firstToWh = firstRow.to_warehouse_code ? getWh(firstRow.to_warehouse_code)?.id : null;

        const seRes = db
          .prepare(
            `INSERT INTO stock_entries (entry_number, entry_type, entry_date, from_warehouse_id, to_warehouse_id, status, approval_status, remarks, total_value, created_by, submitted_by, submitted_at, created_at)
             VALUES (?, ?, ?, ?, ?, 'Submitted', 'Approved', 'Bulk Excel Stock Movement Import', 0, ?, ?, ?, ?)`
          )
          .run(docNumber, firstRow.entry_type, today, firstFromWh, firstToWh, req.user!.id, req.user!.id, now, now);
        const seId = Number(seRes.lastInsertRowid);

        const insLine = db.prepare(
          'INSERT INTO stock_entry_items (stock_entry_id, item_id, batch_number, from_tank_id, to_tank_id, qty, uom, unit_cost, total_cost, system_qty, variance_qty, reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)'
        );

        let count = 0;
        for (const row of validation.rows) {
          const r = row.normalized;
          const item = getItem(r.item_code)!;
          const qty = roundQty(Number(r.qty));
          const cost = Number(r.unit_cost) > 0 ? roundMoney(Number(r.unit_cost)) : roundMoney(item.average_cost || item.standard_cost || 0);
          const fromWh = r.from_warehouse_code ? getWh(r.from_warehouse_code) : undefined;
          const toWh = r.to_warehouse_code ? getWh(r.to_warehouse_code) : undefined;
          const fromTk = r.from_tank_code ? getTank(r.from_tank_code) : undefined;
          const toTk = r.to_tank_code ? getTank(r.to_tank_code) : undefined;

          if (r.entry_type === 'Warehouse Transfer') {
            const outMv = postStockMovement(db, {
              postingDate: today,
              docType: 'StockTransfer',
              docId: seId,
              docNumber,
              itemId: item.id,
              warehouseId: fromWh!.id,
              tankId: fromTk?.id ?? null,
              batchNumber: r.batch_number || undefined,
              outwardQty: qty,
              remarks: r.remarks || `Bulk transfer out (${docNumber})`,
              userId: req.user!.id,
            });
            postStockMovement(db, {
              postingDate: today,
              docType: 'StockTransfer',
              docId: seId,
              docNumber,
              itemId: item.id,
              warehouseId: toWh!.id,
              tankId: toTk?.id ?? null,
              batchNumber: r.batch_number || undefined,
              inwardQty: qty,
              unitCost: outMv.unitCost,
              remarks: r.remarks || `Bulk transfer in (${docNumber})`,
              userId: req.user!.id,
            });
          } else if (r.entry_type === 'Stock Receipt') {
            postStockMovement(db, {
              postingDate: today,
              docType: 'StockReceipt',
              docId: seId,
              docNumber,
              itemId: item.id,
              warehouseId: toWh!.id,
              tankId: toTk?.id ?? null,
              batchNumber: r.batch_number || undefined,
              inwardQty: qty,
              unitCost: cost,
              remarks: r.remarks || `Bulk stock receipt (${docNumber})`,
              userId: req.user!.id,
            });
          } else if (r.entry_type === 'Stock Issue') {
            postStockMovement(db, {
              postingDate: today,
              docType: 'StockIssue',
              docId: seId,
              docNumber,
              itemId: item.id,
              warehouseId: fromWh!.id,
              tankId: fromTk?.id ?? null,
              batchNumber: r.batch_number || undefined,
              outwardQty: qty,
              remarks: r.remarks || `Bulk stock issue (${docNumber})`,
              userId: req.user!.id,
            });
          }

          const lineVal = roundMoney(qty * cost);
          totalValue = roundMoney(totalValue + lineVal);
          insLine.run(seId, item.id, r.batch_number || '', fromTk?.id ?? null, toTk?.id ?? null, qty, item.stock_uom, cost, lineVal, qty, r.remarks || '');
          count++;
        }

        db.prepare('UPDATE stock_entries SET total_value = ? WHERE id = ?').run(totalValue, seId);
        recordAuditLog(db, req.user, 'Import', seId, docNumber, 'Bulk Import Stock Movements', { rows: count, totalValue });
        return { imported: count, doc_number: docNumber, total_value: totalValue };
      }

      if (type === 'boms') {
        const groups = new Map<string, typeof validation.rows>();
        for (const row of validation.rows) {
          const r = row.normalized;
          const k = `${r.finished_item_code.toUpperCase()}::${(r.version || 'v1.0').trim()}`;
          const list = groups.get(k) || [];
          list.push(row);
          groups.set(k, list);
        }

        let bomsCreated = 0;
        let linesCreated = 0;
        const bomNumbers: string[] = [];

        for (const [, grpRows] of groups) {
          const head = grpRows[0].normalized;
          const fg = getItem(head.finished_item_code)!;
          const bomNumber = getNextDocumentNumber(db, 'BOM');
          bomNumbers.push(bomNumber);
          const bRes = db
            .prepare(
              `INSERT INTO boms (bom_number, version, finished_item_id, batch_size, uom, labour_cost, overhead_cost, expected_wastage_pct, effective_date, is_active, is_approved, approved_by, notes, created_by, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1, ?, ?, ?, ?)`
            )
            .run(
              bomNumber,
              head.version || 'v1.0',
              fg.id,
              roundQty(Number(head.batch_size)),
              fg.stock_uom,
              roundMoney(Number(head.labour_cost || 0)),
              roundMoney(Number(head.overhead_cost || 0)),
              Number(head.expected_wastage_pct || 0.5),
              today,
              req.user!.id,
              head.notes || 'Bulk Excel BOM Import',
              req.user!.id,
              now
            );
          const bomId = Number(bRes.lastInsertRowid);
          const insItem = db.prepare(
            `INSERT INTO bom_items (bom_id, item_id, component_type, qty, uom, standard_cost, wastage_pct, is_alternative, carton_packing_qty)
             VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)`
          );
          for (const gRow of grpRows) {
            const c = gRow.normalized;
            const comp = getItem(c.component_item_code)!;
            insItem.run(
              bomId,
              comp.id,
              c.component_type || 'Formula',
              roundQty(Number(c.component_qty)),
              comp.stock_uom,
              roundMoney(comp.average_cost || comp.standard_cost || 0),
              Number(c.wastage_pct || 0),
              Number(c.carton_packing_qty || 0)
            );
            linesCreated++;
          }
          bomsCreated++;
        }
        recordAuditLog(db, req.user, 'Import', null, bomNumbers.join(','), 'Bulk Import BOMs', { bomsCreated, linesCreated });
        return { imported: linesCreated, boms_created: bomsCreated, bom_numbers: bomNumbers };
      }

      if (type === 'item_groups') {
        let count = 0;
        for (const row of validation.rows) {
          const r = row.normalized;
          const code = r.group_code.trim().toUpperCase();
          const parent = r.parent_group_code
            ? (db.prepare('SELECT id FROM item_categories WHERE UPPER(group_code) = UPPER(?) OR UPPER(name) = UPPER(?)').get(r.parent_group_code, r.parent_group_code) as { id: number } | undefined)
            : undefined;
          const existing = db.prepare('SELECT id FROM item_categories WHERE UPPER(group_code) = ? OR UPPER(name) = UPPER(?)').get(code, r.name) as { id: number } | undefined;
          if (existing) {
            db.prepare(
              'UPDATE item_categories SET name = ?, group_code = ?, parent_id = COALESCE(?, parent_id), is_raw_material = ?, is_packaging = ?, is_finished_good = ?, description = ? WHERE id = ?'
            ).run(
              r.name,
              code,
              parent?.id ?? null,
              Number(r.is_raw_material || 0) ? 1 : 0,
              Number(r.is_packaging || 0) ? 1 : 0,
              Number(r.is_finished_good || 0) ? 1 : 0,
              r.description || '',
              existing.id
            );
          } else {
            db.prepare(
              'INSERT INTO item_categories (group_code, name, parent_id, is_group, description, is_raw_material, is_finished_good, is_packaging, sort_order) VALUES (?, ?, ?, 1, ?, ?, ?, ?, 0)'
            ).run(
              code,
              r.name,
              parent?.id ?? null,
              r.description || '',
              Number(r.is_raw_material || 0) ? 1 : 0,
              Number(r.is_finished_good || 0) ? 1 : 0,
              Number(r.is_packaging || 0) ? 1 : 0
            );
          }
          count++;
        }
        recordAuditLog(db, req.user, 'Import', null, 'GROUPS', 'Bulk Import Item Groups', { count });
        return { imported: count };
      }

      if (type === 'items') {
        let created = 0;
        let updated = 0;

        const ensureCategory = (parentGroupName: string, catName: string): number => {
          let parentId: number | null = null;
          if (parentGroupName) {
            const pRow = db
              .prepare('SELECT id FROM item_categories WHERE UPPER(group_code) = UPPER(?) OR UPPER(name) = UPPER(?)')
              .get(parentGroupName, parentGroupName) as { id: number } | undefined;
            if (pRow) {
              parentId = pRow.id;
            } else {
              const pIns = db
                .prepare('INSERT INTO item_categories (group_code, name, parent_id, is_group, is_raw_material, is_packaging, is_finished_good) VALUES (?, ?, NULL, 1, 1, 0, 0)')
                .run(parentGroupName.toUpperCase(), parentGroupName);
              parentId = Number(pIns.lastInsertRowid);
            }
          }
          const cRow = db
            .prepare('SELECT id FROM item_categories WHERE UPPER(group_code) = UPPER(?) OR UPPER(name) = UPPER(?)')
            .get(catName, catName) as { id: number } | undefined;
          if (cRow) return cRow.id;
          const cIns = db
            .prepare('INSERT INTO item_categories (group_code, name, parent_id, is_group, is_raw_material, is_packaging, is_finished_good) VALUES (?, ?, ?, 1, 1, 0, 0)')
            .run(catName.toUpperCase(), catName, parentId);
          return Number(cIns.lastInsertRowid);
        };

        for (const row of validation.rows) {
          const r = row.normalized;
          const itemCode = r.item_code.trim().toUpperCase();
          const catId = ensureCategory(r.parent_group || '', r.category_name);
          const wh = r.default_warehouse_code ? getWh(r.default_warehouse_code) : undefined;
          const pUom = r.purchase_uom || 'LTR';
          const sUom = r.stock_uom || pUom;
          const saUom = r.sales_uom || sUom;
          const existing = getItem(itemCode);

          if (existing) {
            db.prepare(
              `UPDATE items SET name = ?, category_id = ?, brand = ?, purchase_uom = ?, stock_uom = ?, sales_uom = ?,
               standard_cost = ?, selling_price = ?, vat_rate = ?, reorder_level = ?, default_warehouse_id = COALESCE(?, default_warehouse_id),
               batch_tracking = ?, updated_at = ? WHERE id = ?`
            ).run(
              r.name,
              catId,
              r.brand || '',
              pUom,
              sUom,
              saUom,
              Number(r.standard_cost || 0),
              Number(r.selling_price || 0),
              r.vat_rate !== '' && r.vat_rate !== undefined ? Number(r.vat_rate) : 5,
              Number(r.reorder_level || 0),
              wh?.id ?? null,
              r.batch_tracking === '0' ? 0 : 1,
              now,
              existing.id
            );
            updated++;
          } else {
            db.prepare(
              `INSERT INTO items (
                item_code, name, description, category_id, brand, purchase_uom, stock_uom, sales_uom, conversion_factor,
                reorder_level, min_stock, max_stock, safety_stock, lead_time_days, moq,
                standard_cost, average_cost, selling_price, vat_rate, tax_category, batch_tracking,
                default_warehouse_id, valuation_method, is_active, created_by, created_at, updated_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, 0, 0, 0, 7, 1, ?, ?, ?, ?, 'Standard Rated', ?, ?, 'Moving Average', 1, ?, ?, ?)`
            ).run(
              itemCode,
              r.name,
              r.name,
              catId,
              r.brand || '',
              pUom,
              sUom,
              saUom,
              Number(r.reorder_level || 0),
              Number(r.standard_cost || 0),
              Number(r.standard_cost || 0),
              Number(r.selling_price || 0),
              r.vat_rate !== '' && r.vat_rate !== undefined ? Number(r.vat_rate) : 5,
              r.batch_tracking === '0' ? 0 : 1,
              wh?.id ?? null,
              req.user!.id,
              now,
              now
            );
            created++;
          }
        }
        recordAuditLog(db, req.user, 'Import', null, 'ITEMS', 'Bulk Import Items', { created, updated });
        return { imported: created + updated, created, updated };
      }

      if (type === 'tanks') {
        let count = 0;
        for (const row of validation.rows) {
          const r = row.normalized;
          const wh = getWh(r.warehouse_code)!;
          const assigned = r.assigned_item_code ? getItem(r.assigned_item_code) : undefined;
          const tkCode = r.tank_code.trim().toUpperCase();
          const existing = getTank(tkCode);
          if (existing) {
            db.prepare(
              'UPDATE storage_tanks SET name = ?, warehouse_id = ?, tank_type = ?, capacity_qty = ?, uom = ?, min_heel_qty = ?, temperature_c = ? WHERE id = ?'
            ).run(
              r.name,
              wh.id,
              r.tank_type || 'Base Oil',
              Number(r.capacity_qty),
              r.uom || 'LTR',
              Number(r.min_heel_qty || 0),
              Number(r.temperature_c || 25),
              existing.id
            );
          } else {
            db.prepare(
              `INSERT INTO storage_tanks (tank_code, name, warehouse_id, tank_type, capacity_qty, uom, assigned_item_id, current_qty, min_heel_qty, temperature_c, is_active, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, 1, ?)`
            ).run(
              tkCode,
              r.name,
              wh.id,
              r.tank_type || 'Base Oil',
              Number(r.capacity_qty),
              r.uom || 'LTR',
              assigned?.id ?? null,
              Number(r.min_heel_qty || 0),
              Number(r.temperature_c || 25),
              now
            );
          }
          count++;
        }
        recordAuditLog(db, req.user, 'Import', null, 'TANKS', 'Bulk Import Storage Tanks', { count });
        return { imported: count };
      }

      if (type === 'suppliers') {
        let count = 0;
        for (const row of validation.rows) {
          const r = row.normalized;
          const existingCount = (db.prepare('SELECT COUNT(*) as c FROM suppliers').get() as { c: number }).c;
          const code = (r.code || `SUP-${String(existingCount + 1).padStart(3, '0')}`).trim().toUpperCase();
          const existing = db.prepare('SELECT id FROM suppliers WHERE UPPER(code) = ?').get(code) as { id: number } | undefined;
          if (existing) {
            db.prepare(
              'UPDATE suppliers SET name = ?, contact_person = ?, email = ?, telephone = ?, address = ?, country = ?, trn = ?, currency = ?, credit_limit = ?, updated_at = ? WHERE id = ?'
            ).run(
              r.name,
              r.contact_person || '',
              r.email || '',
              r.telephone || '',
              r.address || '',
              r.country || 'United Arab Emirates',
              r.trn || '',
              r.currency || 'AED',
              Number(r.credit_limit || 0),
              now,
              existing.id
            );
          } else {
            db.prepare(
              `INSERT INTO suppliers (code, name, contact_person, email, telephone, address, country, trn, currency, credit_limit, is_active, created_by, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`
            ).run(
              code,
              r.name,
              r.contact_person || '',
              r.email || '',
              r.telephone || '',
              r.address || '',
              r.country || 'United Arab Emirates',
              r.trn || '',
              r.currency || 'AED',
              Number(r.credit_limit || 0),
              req.user!.id,
              now,
              now
            );
          }
          count++;
        }
        recordAuditLog(db, req.user, 'Import', null, 'SUPPLIERS', 'Bulk Import Suppliers', { count });
        return { imported: count };
      }

      // customers
      let count = 0;
      for (const row of validation.rows) {
        const r = row.normalized;
        const existingCount = (db.prepare('SELECT COUNT(*) as c FROM customers').get() as { c: number }).c;
        const code = (r.code || `CUST-${String(existingCount + 1).padStart(3, '0')}`).trim().toUpperCase();
        const existing = db.prepare('SELECT id FROM customers WHERE UPPER(code) = ?').get(code) as { id: number } | undefined;
        if (existing) {
          db.prepare(
            'UPDATE customers SET name = ?, contact_person = ?, email = ?, telephone = ?, address = ?, country = ?, trn = ?, currency = ?, credit_limit = ?, updated_at = ? WHERE id = ?'
          ).run(
            r.name,
            r.contact_person || '',
            r.email || '',
            r.telephone || '',
            r.address || '',
            r.country || 'United Arab Emirates',
            r.trn || '',
            r.currency || 'AED',
            Number(r.credit_limit || 0),
            now,
            existing.id
          );
        } else {
          db.prepare(
            `INSERT INTO customers (code, name, contact_person, email, telephone, address, country, trn, currency, credit_limit, is_active, created_by, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`
          ).run(
            code,
            r.name,
            r.contact_person || '',
            r.email || '',
            r.telephone || '',
            r.address || '',
            r.country || 'United Arab Emirates',
            r.trn || '',
            r.currency || 'AED',
            Number(r.credit_limit || 0),
            req.user!.id,
            now,
            now
          );
        }
        count++;
      }
      recordAuditLog(db, req.user, 'Import', null, 'CUSTOMERS', 'Bulk Import Customers', { count });
      return { imported: count };
    });

    res.json({ ok: true, type, summary });
  } catch (err: unknown) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Bulk import failed' });
  }
});

export default router;
