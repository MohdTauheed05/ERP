import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft,
  Barcode,
  ChevronDown,
  ChevronRight,
  Download,
  Plus,
  Printer,
  Save,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import { SearchableSelect } from './SearchableSelect';
import {
  downloadLineItemsExcelTemplate,
  exportStandardErpPdf,
  parseLineItemsExcelFile,
} from '../utils/export';
import { useCompany } from '../context/CompanyContext';
import { apiRequest } from '../services/api';

export interface ErpFormItemMaster {
  id: number;
  item_code: string;
  name: string;
  barcode?: string;
  stock_uom?: string;
  purchase_uom?: string;
  sales_uom?: string;
  standard_cost?: number;
  average_cost?: number;
  selling_price?: number;
  vat_rate?: number;
}

export interface ErpFormParty {
  id: number;
  code: string;
  name: string;
  trn?: string;
  address?: string;
  country?: string;
  contact_person?: string;
  telephone?: string;
  email?: string;
  currency?: string;
  payment_term_id?: number | null;
}

export interface ErpFormTank {
  id: number;
  tank_code: string;
  name: string;
  warehouse_id: number;
  assigned_item_id: number | null;
  current_qty: number;
  capacity_qty: number;
  uom: string;
  is_active: number;
}

export interface ErpFormLine {
  item_id: number | '';
  po_item_id?: number;
  ordered_qty?: number;
  qty: number;
  rate: number;
  discount_pct: number;
  vat_rate: number;
  batch_number?: string;
  tank_id?: number | '';
  required_by?: string;
}

export interface ErpDocMetaState {
  doc_date: string;
  delivery_date: string;
  party_id: number | '';
  warehouse_id: number | '';
  target_warehouse_id: number | '';
  payment_term_id: number | '';
  price_list_id: number | '';
  currency: string;
  exchange_rate: string;
  linked_po_id: number | '';
  linked_grn_id: number | '';
  linked_rfq_id: number | '';
  party_ref_no: string;
  supplier_inv_no: string;
  supplier_dn_no: string;
  delivery_terms: string;
  delivery_place: string;
  revision_no: string;
  freight_amount: string;
  tax_template: 'UAE VAT 5%' | 'Zero Rated 0%' | 'Exempt';
  tax_category: string;
  disable_rounded_total: boolean;
  additional_discount_pct: string;
  reason: string;
  remarks: string;
}

export interface ErpDocumentFormProps {
  title: string;
  seriesCode: string;
  docTitleForPdf: string;
  docNumberLabel: string;
  companyRole: 'Buyer' | 'Seller';
  partyRole: 'Buyer' | 'Seller';
  partyLabel?: string;
  partyRefLabel?: string;
  warehouseLabel?: string;
  showParty?: boolean;
  showPaymentTerms?: boolean;
  showPriceList?: boolean;
  showTankColumn?: boolean;
  showBatchColumn?: boolean;
  showFreight?: boolean;
  showLinkedPo?: boolean;
  showLinkedGrn?: boolean;
  showLinkedRfq?: boolean;
  showSupplierInv?: boolean;
  showSupplierDn?: boolean;
  showReason?: boolean;
  linkedPoOptions?: { id: number; label: string }[];
  linkedGrnOptions?: { id: number; label: string }[];
  linkedRfqOptions?: { id: number; label: string }[];
  onSelectLinkedPo?: (poId: number) => void;
  parties: ErpFormParty[];
  items: ErpFormItemMaster[];
  warehouses: { id: number; code?: string; name: string }[];
  tanks?: ErpFormTank[];
  paymentTerms?: { id: number; name: string }[];
  priceLists?: { id: number; name: string }[];
  meta: ErpDocMetaState;
  setMeta: React.Dispatch<React.SetStateAction<ErpDocMetaState>>;
  lines: ErpFormLine[];
  setLines: React.Dispatch<React.SetStateAction<ErpFormLine[]>>;
  onItemLookupRate?: (idx: number, itemId: number, qty: number) => Promise<void> | void;
  onSave: (e: React.FormEvent) => Promise<void> | void;
  onCancel: () => void;
  onOpenBulkImport?: () => void;
  extraHeaderSlot?: React.ReactNode;
  submitting?: boolean;
  saveLabel?: string;
  editingDocNumber?: string;
  statusBadge?: string;
  amendedFrom?: string;
}

type DocFormTab = 'details' | 'address' | 'terms' | 'more';
type QuickCreateState = { kind: 'item'; query: string; lineIndex: number } | { kind: 'party'; query: string };
type QuickCreateCategory = { id: number; name: string; parent_id?: number | null; is_group?: number };

export function ErpDocumentForm({
  title,
  seriesCode,
  docTitleForPdf,
  docNumberLabel,
  companyRole,
  partyRole,
  partyLabel = 'Supplier',
  partyRefLabel = 'Ref. No.',
  warehouseLabel = 'Set Target Warehouse',
  showParty = true,
  showPaymentTerms = true,
  showPriceList = false,
  showTankColumn = false,
  showBatchColumn = false,
  showFreight = true,
  showLinkedPo = false,
  showLinkedGrn = false,
  showLinkedRfq = false,
  showSupplierInv = false,
  showSupplierDn = false,
  showReason = false,
  linkedPoOptions = [],
  linkedGrnOptions = [],
  linkedRfqOptions = [],
  onSelectLinkedPo,
  parties,
  items,
  warehouses,
  tanks = [],
  paymentTerms = [],
  priceLists = [],
  meta,
  setMeta,
  lines,
  setLines,
  onItemLookupRate,
  onSave,
  onCancel,
  onOpenBulkImport,
  extraHeaderSlot,
  submitting = false,
  saveLabel = 'Save',
  editingDocNumber,
  statusBadge,
  amendedFrom,
}: ErpDocumentFormProps) {
  const { company, logoUrl } = useCompany();
  const [activeTab, setActiveTab] = useState<DocFormTab>('details');
  const [showAccDim, setShowAccDim] = useState(false);
  const [showCurrencySec, setShowCurrencySec] = useState(false);
  const [showDiscountSec, setShowDiscountSec] = useState(false);
  const [barcodeInput, setBarcodeInput] = useState('');
  const [selectedRows, setSelectedRows] = useState<number[]>([]);
  const [showAddMultiple, setShowAddMultiple] = useState(false);
  const [multiSearch, setMultiSearch] = useState('');
  const [multiSelected, setMultiSelected] = useState<number[]>([]);
  const [gridMsg, setGridMsg] = useState('');
  const [quickCreate, setQuickCreate] = useState<QuickCreateState | null>(null);
  const [quickCreateCategories, setQuickCreateCategories] = useState<QuickCreateCategory[]>([]);
  const [createdItems, setCreatedItems] = useState<ErpFormItemMaster[]>([]);
  const [createdParties, setCreatedParties] = useState<ErpFormParty[]>([]);
  const [quickCreateName, setQuickCreateName] = useState('');
  const [quickCreateCode, setQuickCreateCode] = useState('');
  const [quickCreateCategoryId, setQuickCreateCategoryId] = useState('');
  const [quickCreateUom, setQuickCreateUom] = useState('PCS');
  const [quickCreatePurchasePrice, setQuickCreatePurchasePrice] = useState('0');
  const [quickCreateSellingPrice, setQuickCreateSellingPrice] = useState('0');
  const [quickCreateVatRate, setQuickCreateVatRate] = useState('5');
  const [quickCreateContact, setQuickCreateContact] = useState('');
  const [quickCreateEmail, setQuickCreateEmail] = useState('');
  const [quickCreateTelephone, setQuickCreateTelephone] = useState('');
  const [quickCreateTrn, setQuickCreateTrn] = useState('');
  const [quickCreateCurrency, setQuickCreateCurrency] = useState(meta.currency || 'AED');
  const [quickCreateError, setQuickCreateError] = useState('');
  const [quickCreateSaving, setQuickCreateSaving] = useState(false);
  const uploadInputRef = useRef<HTMLInputElement | null>(null);

  const availableParties = useMemo(() => [...parties, ...createdParties], [parties, createdParties]);
  const availableItems = useMemo(() => [...items, ...createdItems], [items, createdItems]);
  const selectedParty = useMemo(
    () => availableParties.find((p) => p.id === Number(meta.party_id)),
    [availableParties, meta.party_id]
  );

  const itemById = useMemo(() => new Map(availableItems.map((i) => [i.id, i])), [availableItems]);

  useEffect(() => {
    if (quickCreate?.kind !== 'item') return;
    let cancelled = false;
    apiRequest<{ items: QuickCreateCategory[] }>('/api/masters/categories')
      .then((result) => {
        if (cancelled) return;
        setQuickCreateCategories(result.items);
        setQuickCreateCategoryId((current) => current || String(result.items.find((c) => !c.is_group)?.id || result.items[0]?.id || ''));
      })
      .catch((error: unknown) => {
        if (!cancelled) setQuickCreateError(error instanceof Error ? error.message : 'Could not load item categories.');
      });
    return () => { cancelled = true; };
  }, [quickCreate?.kind, quickCreate?.query]);

  const beginQuickCreate = (kind: 'item' | 'party', query: string, lineIndex?: number) => {
    const cleanName = query.trim();
    setQuickCreateError('');
    setQuickCreateName(cleanName);
    setQuickCreateCode(cleanName.toUpperCase().replace(/[^A-Z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 32));
    setQuickCreateContact('');
    setQuickCreateEmail('');
    setQuickCreateTelephone('');
    setQuickCreateTrn('');
    setQuickCreateCurrency(meta.currency || 'AED');
    setQuickCreateCategoryId('');
    setQuickCreateUom(companyRole === 'Buyer' ? 'LTR' : 'PCS');
    setQuickCreatePurchasePrice('0');
    setQuickCreateSellingPrice('0');
    setQuickCreateVatRate('5');
    setQuickCreate(kind === 'item' ? { kind, query: cleanName, lineIndex: lineIndex ?? 0 } : { kind, query: cleanName });
  };

  const saveQuickCreate = async () => {
    if (!quickCreate) return;
    setQuickCreateError('');
    if (!quickCreateName.trim()) {
      setQuickCreateError('Enter a name to continue.');
      return;
    }
    setQuickCreateSaving(true);
    try {
      if (quickCreate.kind === 'item') {
        if (!quickCreateCategoryId) throw new Error('Select an item category before saving.');
        if (!quickCreateCode.trim()) throw new Error('Enter an item code before saving.');
        const payload = {
          item_code: quickCreateCode.trim().toUpperCase(),
          name: quickCreateName.trim(),
          category_id: Number(quickCreateCategoryId),
          purchase_uom: quickCreateUom,
          stock_uom: quickCreateUom,
          sales_uom: quickCreateUom,
          standard_cost: Number(quickCreatePurchasePrice || 0),
          last_purchase_price: Number(quickCreatePurchasePrice || 0),
          selling_price: Number(quickCreateSellingPrice || 0),
          vat_rate: Number(quickCreateVatRate || 0),
          batch_tracking: 0,
          expiry_tracking: 0,
          is_active: 1,
        };
        const result = await apiRequest<{ id: number }>('/api/masters/items', { method: 'POST', body: JSON.stringify(payload) });
        const created: ErpFormItemMaster = {
          ...payload,
          id: result.id,
          barcode: '',
        };
        setCreatedItems((current) => [...current.filter((item) => item.id !== created.id), created]);
        setLines((current) => current.map((line, index) => index === quickCreate.lineIndex ? {
          ...line,
          item_id: created.id,
          rate: companyRole === 'Seller' ? Number(created.selling_price || 0) : Number(created.standard_cost || 0),
          vat_rate: meta.tax_template === 'UAE VAT 5%' ? Number(created.vat_rate ?? 5) : 0,
          tank_id: findMatchingTank(created.id, meta.warehouse_id),
        } : line));
        setQuickCreate(null);
        if (onItemLookupRate) {
          try {
            await onItemLookupRate(quickCreate.lineIndex, created.id, lines[quickCreate.lineIndex]?.qty || 1);
          } catch {
            setGridMsg(`${created.item_code} was created and added. Review the unit price before saving.`);
          }
        }
      } else {
        const isSupplier = partyRole === 'Seller' && !partyLabel.toLowerCase().includes('customer');
        const endpoint = isSupplier ? '/api/masters/suppliers' : '/api/masters/customers';
        const result = await apiRequest<{ id: number; code: string }>(endpoint, {
          method: 'POST',
          body: JSON.stringify({
            name: quickCreateName.trim(),
            contact_person: quickCreateContact.trim(),
            email: quickCreateEmail.trim(),
            telephone: quickCreateTelephone.trim(),
            trn: quickCreateTrn.trim(),
            currency: quickCreateCurrency,
          }),
        });
        const created: ErpFormParty = {
          id: result.id,
          code: result.code,
          name: quickCreateName.trim(),
          contact_person: quickCreateContact.trim(),
          email: quickCreateEmail.trim(),
          telephone: quickCreateTelephone.trim(),
          trn: quickCreateTrn.trim(),
          currency: quickCreateCurrency,
        };
        setCreatedParties((current) => [...current.filter((party) => party.id !== created.id), created]);
        setMeta((current) => ({ ...current, party_id: created.id, currency: created.currency || current.currency }));
      }
      setQuickCreate(null);
    } catch (error) {
      setQuickCreateError(error instanceof Error ? error.message : 'Could not create this record.');
    } finally {
      setQuickCreateSaving(false);
    }
  };

  const findMatchingTank = (itemId: number | '', whId: number | ''): number | '' => {
    if (!itemId || !whId) return '';
    const match = tanks.find((t) => t.is_active && t.warehouse_id === Number(whId) && t.assigned_item_id === Number(itemId));
    return match ? match.id : '';
  };

  const totals = useMemo(() => {
    let totalQty = 0;
    let netTotal = 0;
    let vatTotal = 0;
    lines.forEach((l) => {
      if (!l.item_id) return;
      const q = Number(l.qty || 0);
      const r = Number(l.rate || 0);
      const disc = (q * r * Number(l.discount_pct || 0)) / 100;
      const net = q * r - disc;
      const taxRate = meta.tax_template === 'UAE VAT 5%' ? Number(l.vat_rate ?? 5) : 0;
      const vat = (net * taxRate) / 100;
      totalQty += q;
      netTotal += net;
      vatTotal += vat;
    });
    const addDiscPct = Number(meta.additional_discount_pct || 0);
    const addDiscAmt = addDiscPct > 0 ? (netTotal * addDiscPct) / 100 : 0;
    const discountedNet = Math.max(0, netTotal - addDiscAmt);
    const discountedVat = netTotal > 0 ? vatTotal * (discountedNet / netTotal) : 0;
    const freight = Number(meta.freight_amount || 0);
    const rawGrand = discountedNet + discountedVat + freight;
    const grandTotal = meta.disable_rounded_total ? rawGrand : Math.round(rawGrand);
    return {
      totalQty,
      netTotal: discountedNet,
      vatTotal: discountedVat,
      addDiscAmt,
      freight,
      grandTotal,
    };
  }, [lines, meta.tax_template, meta.additional_discount_pct, meta.freight_amount, meta.disable_rounded_total]);

  const handleBarcodeEnter = async (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const q = barcodeInput.trim().toLowerCase();
    if (!q) return;
    const found = items.find(
      (i) => i.item_code.toLowerCase() === q || (i.barcode && i.barcode.toLowerCase() === q) || i.name.toLowerCase().includes(q)
    );
    if (!found) {
      setGridMsg(`No item matched code/barcode "${barcodeInput.trim()}"`);
      return;
    }
    setBarcodeInput('');
    setGridMsg('');
    const existingIdx = lines.findIndex((l) => Number(l.item_id) === found.id);
    if (existingIdx >= 0) {
      const next = [...lines];
      next[existingIdx] = { ...next[existingIdx], qty: Number(next[existingIdx].qty || 0) + 1 };
      setLines(next);
      return;
    }
    const defaultRate = companyRole === 'Seller' ? Number(found.selling_price || 0) : Number(found.standard_cost || found.average_cost || 0);
    const newRow: ErpFormLine = {
      item_id: found.id,
      qty: 1,
      rate: defaultRate,
      discount_pct: 0,
      vat_rate: meta.tax_template === 'UAE VAT 5%' ? Number(found.vat_rate ?? 5) : 0,
      batch_number: '',
      tank_id: findMatchingTank(found.id, meta.warehouse_id),
      required_by: meta.delivery_date,
    };
    const emptyIdx = lines.findIndex((l) => l.item_id === '');
    if (emptyIdx >= 0) {
      const next = [...lines];
      next[emptyIdx] = newRow;
      setLines(next);
      if (onItemLookupRate) await onItemLookupRate(emptyIdx, found.id, 1);
    } else {
      const targetIdx = lines.length;
      setLines((prev) => [...prev, newRow]);
      if (onItemLookupRate) await onItemLookupRate(targetIdx, found.id, 1);
    }
  };

  const handleTemplateDownload = () => {
    const exportRows = lines
      .filter((l) => l.item_id !== '')
      .map((l) => {
        const it = itemById.get(Number(l.item_id));
        const tk = tanks.find((t) => t.id === Number(l.tank_id));
        return {
          item_code: it?.item_code || '',
          item_name: it?.name || '',
          qty: l.qty,
          uom: (companyRole === 'Seller' ? it?.sales_uom : it?.purchase_uom) || it?.stock_uom || 'LTR',
          rate: l.rate,
          vat_rate: l.vat_rate,
          batch_number: l.batch_number || '',
          tank_code: tk?.tank_code || '',
        };
      });
    downloadLineItemsExcelTemplate(`${seriesCode.replace(/[^A-Z0-9]+/gi, '_')}_items_template`, exportRows);
  };

  const handleUploadItemsExcel = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    try {
      const parsed = await parseLineItemsExcelFile(file);
      if (parsed.length === 0) {
        setGridMsg('No valid Item Code & Quantity rows found in uploaded Excel file.');
        return;
      }
      const mapped: ErpFormLine[] = [];
      let unmatched = 0;
      for (const row of parsed) {
        const it = items.find((x) => x.item_code.toUpperCase() === row.item_code.toUpperCase());
        if (!it) {
          unmatched++;
          continue;
        }
        const tk = row.tank_code ? tanks.find((t) => t.tank_code.toUpperCase() === row.tank_code!.toUpperCase()) : undefined;
        const defaultRate = companyRole === 'Seller' ? Number(it.selling_price || 0) : Number(it.standard_cost || it.average_cost || 0);
        mapped.push({
          item_id: it.id,
          qty: row.qty,
          rate: row.rate !== undefined ? row.rate : defaultRate,
          discount_pct: 0,
          vat_rate: row.vat_rate !== undefined ? row.vat_rate : meta.tax_template === 'UAE VAT 5%' ? Number(it.vat_rate ?? 5) : 0,
          batch_number: row.batch_number || '',
          tank_id: tk ? tk.id : findMatchingTank(it.id, meta.warehouse_id),
          required_by: meta.delivery_date,
        });
      }
      if (mapped.length > 0) {
        setLines(mapped);
        setGridMsg(`Loaded ${mapped.length} item line(s) from Excel${unmatched > 0 ? ` (${unmatched} unknown item codes skipped)` : ''}.`);
      } else {
        setGridMsg('None of the Item Codes in the uploaded Excel matched Master Items.');
      }
    } catch (err) {
      setGridMsg(err instanceof Error ? err.message : 'Failed to read Excel file');
    }
  };

  const handlePrintPreview = () => {
    const ptName = paymentTerms.find((p) => p.id === Number(meta.payment_term_id))?.name || '';
    const whName = warehouses.find((w) => w.id === Number(meta.warehouse_id))?.name || '';
    const pdfLines = lines
      .filter((l) => l.item_id !== '')
      .map((l) => {
        const it = itemById.get(Number(l.item_id));
        const tk = tanks.find((t) => t.id === Number(l.tank_id));
        const net = Number(l.qty || 0) * Number(l.rate || 0) * (1 - Number(l.discount_pct || 0) / 100);
        const taxPct = meta.tax_template === 'UAE VAT 5%' ? Number(l.vat_rate ?? 5) : 0;
        const vatAmt = (net * taxPct) / 100;
        return {
          item_code: it?.item_code || '',
          description: `${it?.name || ''}${tk ? ` [Tank: ${tk.tank_code}]` : ''}`,
          qty: Number(l.qty || 0),
          uom: (companyRole === 'Seller' ? it?.sales_uom : it?.purchase_uom) || it?.stock_uom || 'LTR',
          unit_price: Number(l.rate || 0),
          vat_pct: taxPct,
          vat_amount: vatAmt,
          total: net + vatAmt,
        };
      });

    void exportStandardErpPdf({
      docTitle: docTitleForPdf,
      docNumberLabel,
      docNumber: editingDocNumber || `${seriesCode} (DRAFT PREVIEW)`,
      docDate: meta.doc_date,
      company,
      logoUrl,
      companyRole,
      partyRole,
      partyName: selectedParty?.name || company.name || '-',
      partyTrn: selectedParty?.trn || '',
      partyAddress: selectedParty?.address || '',
      partyCountry: selectedParty?.country || '',
      partyContactPerson: selectedParty?.contact_person || '',
      paymentTerms: ptName,
      deliveryTerms: meta.delivery_terms,
      deliveryDate: meta.delivery_date,
      deliveryPlace: meta.delivery_place || whName,
      partyRefLabel,
      partyRefNo: meta.party_ref_no || '-',
      exchangeRate: Number(meta.exchange_rate || 1),
      revisionNo: meta.revision_no || 'Original',
      currency: meta.currency || company.currency || 'AED',
      items: pdfLines,
      netTotal: totals.netTotal,
      vatTotal: totals.vatTotal,
      grandTotal: totals.grandTotal,
      remarks: meta.remarks || meta.reason,
      filename: `${docTitleForPdf.toLowerCase().replace(/\s+/g, '_')}_preview`,
    });
  };

  const vatAccountHead =
    companyRole === 'Buyer' ? '1400 - VAT INPUT ACCOUNT (PURCHASES)' : '2200 - VAT OUTPUT PAYABLE (SALES)';
  const vatDisplayRate = meta.tax_template === 'UAE VAT 5%' ? 5 : 0;

  return (
    <form onSubmit={onSave} className="bg-white border border-slate-200 rounded-lg overflow-hidden shadow-xs">
      {/* Top Document Bar matching reference layout */}
      <div className="px-5 py-3 border-b border-slate-200 bg-white flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2.5">
          <button
            type="button"
            onClick={onCancel}
            className="p-1.5 text-slate-500 hover:text-slate-900 rounded hover:bg-slate-100"
            title="Back to list"
          >
            <ArrowLeft className="w-4 h-4" />
          </button>
          <h2 className="text-base font-semibold text-slate-900">{title}</h2>
          {editingDocNumber && (
            <span className="font-mono text-xs font-medium text-slate-700 bg-slate-100 border border-slate-200 px-2 py-0.5 rounded">
              {editingDocNumber}
            </span>
          )}
          <span className="text-[11px] font-medium text-amber-700 bg-amber-50 border border-amber-200 px-2 py-0.5 rounded">
            {statusBadge || 'Not Saved'}
          </span>
          {amendedFrom && (
            <span className="text-[11px] text-slate-500">
              Amended From: <span className="font-mono font-medium text-slate-700">{amendedFrom}</span>
            </span>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {showLinkedPo && linkedPoOptions.length > 0 && (
            <select
              value={meta.linked_po_id}
              onChange={(e) => {
                const v = Number(e.target.value);
                setMeta((m) => ({ ...m, linked_po_id: v || '' }));
                if (v && onSelectLinkedPo) onSelectLinkedPo(v);
              }}
              className="px-2.5 py-1.5 text-xs border border-slate-300 rounded-md bg-slate-50 text-slate-800"
              title="Get Items From Purchase Order"
            >
              <option value="">Get Items From PO...</option>
              {linkedPoOptions.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.label}
                </option>
              ))}
            </select>
          )}
          {onOpenBulkImport && (
            <button
              type="button"
              onClick={onOpenBulkImport}
              className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium text-slate-700 bg-slate-50 border border-slate-300 rounded-md hover:bg-slate-100"
            >
              <Upload className="w-3.5 h-3.5" /> Bulk Import Excel
            </button>
          )}
          <button
            type="button"
            onClick={handlePrintPreview}
            className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded-md hover:bg-slate-50"
            title="Print Preview PDF before saving"
          >
            <Printer className="w-3.5 h-3.5" /> Print Preview
          </button>
          <button
            type="button"
            onClick={onCancel}
            className="px-3 py-1.5 text-xs font-medium text-slate-600 border border-slate-300 rounded-md hover:bg-slate-50"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={submitting}
            className="inline-flex items-center gap-1.5 px-4 py-1.5 text-xs font-medium bg-slate-900 text-white rounded-md hover:bg-slate-800 disabled:opacity-50"
          >
            <Save className="w-3.5 h-3.5" /> {submitting ? 'Saving...' : saveLabel}
          </button>
        </div>
      </div>

      {/* Underline Tab Strip: Details | Address & Contact | Terms | More Info */}
      <div className="px-5 border-b border-slate-200 flex items-center gap-6 text-xs bg-white">
        {[
          { id: 'details', label: 'Details' },
          { id: 'address', label: 'Address & Contact' },
          { id: 'terms', label: 'Terms' },
          { id: 'more', label: 'More Info' },
        ].map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setActiveTab(t.id as DocFormTab)}
            className={`py-2.5 border-b-2 transition-colors whitespace-nowrap ${
              activeTab === t.id
                ? 'border-slate-900 text-slate-900 font-semibold'
                : 'border-transparent text-slate-500 hover:text-slate-800'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Tab Body */}
      <div className="p-5 space-y-5 text-xs">
        {activeTab === 'details' && (
          <>
            {/* Top 3-Column Header Metadata Grid */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div>
                <label className="block text-[11px] font-medium text-slate-600 mb-1">
                  Series <span className="text-red-600">*</span>
                </label>
                <input
                  readOnly
                  value={seriesCode}
                  className="w-full px-3 py-1.5 bg-slate-100 border border-slate-200 rounded text-slate-700 font-mono"
                />
              </div>
              <div>
                <label className="block text-[11px] font-medium text-slate-600 mb-1">
                  Date <span className="text-red-600">*</span>
                </label>
                <input
                  type="date"
                  required
                  value={meta.doc_date}
                  onChange={(e) => setMeta((m) => ({ ...m, doc_date: e.target.value }))}
                  className="w-full px-3 py-1.5 bg-slate-50 border border-slate-200 rounded font-mono"
                />
              </div>
              <div>
                <label className="block text-[11px] font-medium text-slate-600 mb-1">
                  Company <span className="text-red-600">*</span>
                </label>
                <input
                  readOnly
                  value={company.name || 'Company Name'}
                  className="w-full px-3 py-1.5 bg-slate-100 border border-slate-200 rounded text-slate-800 font-medium"
                />
              </div>

              {showParty && (
                <div>
                  <label className="block text-[11px] font-medium text-slate-600 mb-1">
                    {partyLabel} <span className="text-red-600">*</span>
                  </label>
                  <SearchableSelect
                    options={availableParties.map((p) => ({ value: p.id, label: `${p.code} - ${p.name}`, sublabel: [p.currency, p.contact_person].filter(Boolean).join(' · ') }))}
                    value={meta.party_id}
                    onChange={(v) => {
                      if (v === '') {
                        setMeta((m) => ({ ...m, party_id: '' }));
                        return;
                      }
                      const p = parties.find((x) => x.id === Number(v));
                      setMeta((m) => ({
                        ...m,
                        party_id: Number(v),
                        payment_term_id: p?.payment_term_id || m.payment_term_id,
                        currency: p?.currency || m.currency,
                        delivery_place: companyRole === 'Seller' && p?.address ? p.address : m.delivery_place,
                      }));
                    }}
                    placeholder={`Type to select ${partyLabel}...`}
                    createOptionLabel={partyRole === 'Seller' ? 'supplier' : 'customer'}
                    onCreateOption={(query) => beginQuickCreate('party', query)}
                  />
                </div>
              )}

              <div>
                <label className="block text-[11px] font-medium text-slate-600 mb-1">Required By / Delivery Date</label>
                <input
                  type="date"
                  value={meta.delivery_date}
                  onChange={(e) => setMeta((m) => ({ ...m, delivery_date: e.target.value }))}
                  className="w-full px-3 py-1.5 bg-slate-50 border border-slate-200 rounded font-mono"
                />
              </div>

              {showSupplierInv && (
                <div>
                  <label className="block text-[11px] font-medium text-slate-600 mb-1">Supplier Invoice #</label>
                  <input
                    required
                    value={meta.supplier_inv_no}
                    onChange={(e) => setMeta((m) => ({ ...m, supplier_inv_no: e.target.value }))}
                    placeholder="SUP-INV-2026-01"
                    className="w-full px-3 py-1.5 bg-slate-50 border border-slate-200 rounded font-mono"
                  />
                </div>
              )}

              {showSupplierDn && (
                <div>
                  <label className="block text-[11px] font-medium text-slate-600 mb-1">Supplier DN #</label>
                  <input
                    value={meta.supplier_dn_no}
                    onChange={(e) => setMeta((m) => ({ ...m, supplier_dn_no: e.target.value }))}
                    placeholder="DN-8891"
                    className="w-full px-3 py-1.5 bg-slate-50 border border-slate-200 rounded font-mono"
                  />
                </div>
              )}

              {showLinkedGrn && (
                <div>
                  <label className="block text-[11px] font-medium text-slate-600 mb-1">Link GRN (3-Way Match)</label>
                  <select
                    value={meta.linked_grn_id}
                    onChange={(e) => setMeta((m) => ({ ...m, linked_grn_id: Number(e.target.value) || '' }))}
                    className="w-full px-3 py-1.5 bg-slate-50 border border-slate-200 rounded"
                  >
                    <option value="">No GRN</option>
                    {linkedGrnOptions.map((g) => (
                      <option key={g.id} value={g.id}>
                        {g.label}
                      </option>
                    ))}
                  </select>
                </div>
              )}

              {showLinkedRfq && (
                <div>
                  <label className="block text-[11px] font-medium text-slate-600 mb-1">Linked RFQ</label>
                  <select
                    value={meta.linked_rfq_id}
                    onChange={(e) => setMeta((m) => ({ ...m, linked_rfq_id: Number(e.target.value) || '' }))}
                    className="w-full px-3 py-1.5 bg-slate-50 border border-slate-200 rounded"
                  >
                    <option value="">Standalone Quote</option>
                    {linkedRfqOptions.map((r) => (
                      <option key={r.id} value={r.id}>
                        {r.label}
                      </option>
                    ))}
                  </select>
                </div>
              )}

              {showReason && (
                <div className="md:col-span-2">
                  <label className="block text-[11px] font-medium text-slate-600 mb-1">Return Reason</label>
                  <input
                    required
                    value={meta.reason}
                    onChange={(e) => setMeta((m) => ({ ...m, reason: e.target.value }))}
                    placeholder="Damaged packaging / Off-spec batch"
                    className="w-full px-3 py-1.5 bg-slate-50 border border-slate-200 rounded"
                  />
                </div>
              )}

              {extraHeaderSlot}
            </div>

            {/* Collapsible Section: Accounting Dimensions */}
            <div className="border-t border-slate-200 pt-3">
              <button
                type="button"
                onClick={() => setShowAccDim((v) => !v)}
                className="flex items-center gap-1.5 text-xs font-semibold text-slate-800 hover:text-slate-950"
              >
                <span>Accounting Dimensions</span>
                {showAccDim ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
              </button>
              {showAccDim && (
                <div className="mt-3 grid grid-cols-1 md:grid-cols-3 gap-4">
                  <div>
                    <label className="block text-[11px] text-slate-600 mb-1">{partyRefLabel}</label>
                    <input
                      value={meta.party_ref_no}
                      onChange={(e) => setMeta((m) => ({ ...m, party_ref_no: e.target.value }))}
                      placeholder="External Ref / LPO / Quote #"
                      className="w-full px-3 py-1.5 bg-slate-50 border border-slate-200 rounded"
                    />
                  </div>
                  <div>
                    <label className="block text-[11px] text-slate-600 mb-1">Revision No.</label>
                    <input
                      value={meta.revision_no}
                      onChange={(e) => setMeta((m) => ({ ...m, revision_no: e.target.value }))}
                      className="w-full px-3 py-1.5 bg-slate-50 border border-slate-200 rounded"
                    />
                  </div>
                </div>
              )}
            </div>

            {/* Collapsible Section: Currency and Price List */}
            <div className="border-t border-slate-200 pt-3">
              <button
                type="button"
                onClick={() => setShowCurrencySec((v) => !v)}
                className="flex items-center gap-1.5 text-xs font-semibold text-slate-800 hover:text-slate-950"
              >
                <span>Currency and Price List</span>
                {showCurrencySec ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
              </button>
              {showCurrencySec && (
                <div className="mt-3 grid grid-cols-1 md:grid-cols-3 gap-4">
                  <div>
                    <label className="block text-[11px] text-slate-600 mb-1">Currency</label>
                    <select
                      value={meta.currency}
                      onChange={(e) => setMeta((m) => ({ ...m, currency: e.target.value }))}
                      className="w-full px-3 py-1.5 bg-slate-50 border border-slate-200 rounded"
                    >
                      <option value="AED">AED</option>
                      <option value="USD">USD</option>
                      <option value="EUR">EUR</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-[11px] text-slate-600 mb-1">Exchange Rate</label>
                    <input
                      type="number"
                      step="0.0001"
                      value={meta.exchange_rate}
                      onChange={(e) => setMeta((m) => ({ ...m, exchange_rate: e.target.value }))}
                      className="w-full px-3 py-1.5 bg-slate-50 border border-slate-200 rounded font-mono"
                    />
                  </div>
                  {showPriceList && (
                    <div>
                      <label className="block text-[11px] text-slate-600 mb-1">Price List</label>
                      <select
                        value={meta.price_list_id}
                        onChange={(e) => setMeta((m) => ({ ...m, price_list_id: Number(e.target.value) || '' }))}
                        className="w-full px-3 py-1.5 bg-slate-50 border border-slate-200 rounded"
                      >
                        <option value="">Customer / Item Default</option>
                        {priceLists.map((pl) => (
                          <option key={pl.id} value={pl.id}>
                            {pl.name}
                          </option>
                        ))}
                      </select>
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Scan Barcode + Set Warehouse Row */}
            <div className="border-t border-slate-200 pt-4 grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="block text-[11px] font-medium text-slate-600 mb-1">Scan Barcode / Item Code</label>
                <div className="relative">
                  <input
                    value={barcodeInput}
                    onChange={(e) => setBarcodeInput(e.target.value)}
                    onKeyDown={(e) => void handleBarcodeEnter(e)}
                    placeholder="Type or scan SKU / Barcode and press Enter..."
                    className="w-full pl-3 pr-9 py-1.5 bg-slate-50 border border-slate-200 rounded font-mono"
                  />
                  <Barcode className="w-4 h-4 text-slate-400 absolute right-2.5 top-1/2 -translate-y-1/2" />
                </div>
              </div>
              <div>
                <label className="block text-[11px] font-medium text-slate-600 mb-1">{warehouseLabel}</label>
                <select
                  value={meta.warehouse_id}
                  onChange={(e) => {
                    const nextWh = Number(e.target.value);
                    setMeta((m) => ({ ...m, warehouse_id: nextWh }));
                    setLines((prev) =>
                      prev.map((row) => ({ ...row, tank_id: findMatchingTank(row.item_id, nextWh) }))
                    );
                  }}
                  className="w-full px-3 py-1.5 bg-slate-50 border border-slate-200 rounded"
                >
                  {warehouses.map((w) => (
                    <option key={w.id} value={w.id}>
                      {w.code ? `${w.code} — ${w.name}` : w.name}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            {gridMsg && (
              <div className="px-3 py-2 bg-slate-50 border border-slate-200 rounded text-[11px] text-slate-700">
                {gridMsg}
              </div>
            )}

            {/* Spreadsheet Items Grid matching attached screenshot */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-[11px] font-medium text-slate-600">Items</span>
              </div>

              <div className="border border-slate-200 rounded-md overflow-x-auto">
                <table className="w-full text-left border-collapse text-xs">
                  <thead>
                    <tr className="bg-slate-50 border-b border-slate-200 text-[11px] font-medium text-slate-600">
                      <th className="w-8 px-2 py-2 text-center border-r border-slate-200">
                        <input
                          type="checkbox"
                          checked={lines.length > 0 && selectedRows.length === lines.length}
                          onChange={(e) => setSelectedRows(e.target.checked ? lines.map((_, idx) => idx) : [])}
                        />
                      </th>
                      <th className="w-10 px-2 py-2 text-center border-r border-slate-200">No.</th>
                      <th className="min-w-[230px] px-2.5 py-2 border-r border-slate-200">
                        Item Code <span className="text-red-600">*</span>
                      </th>
                      <th className="w-24 px-2.5 py-2 text-right border-r border-slate-200">Quantity</th>
                      <th className="w-16 px-2 py-2 text-center border-r border-slate-200">UOM</th>
                      <th className="w-28 px-2.5 py-2 text-right border-r border-slate-200">Rate ({meta.currency})</th>
                      <th className="w-28 px-2.5 py-2 text-right border-r border-slate-200">Amount ({meta.currency})</th>
                      {showTankColumn && <th className="w-40 px-2.5 py-2 border-r border-slate-200">Storage Tank</th>}
                      {showBatchColumn && <th className="w-28 px-2.5 py-2 border-r border-slate-200">Batch #</th>}
                      <th className="w-16 px-2 py-2 text-center">Del</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-200">
                    {lines.map((li, idx) => {
                      const it = li.item_id ? itemById.get(Number(li.item_id)) : undefined;
                      const uom =
                        (companyRole === 'Seller' ? it?.sales_uom : it?.purchase_uom) || it?.stock_uom || '-';
                      const amount = Number(li.qty || 0) * Number(li.rate || 0) * (1 - Number(li.discount_pct || 0) / 100);
                      const whTanks = tanks.filter(
                        (t) => t.is_active && (!meta.warehouse_id || t.warehouse_id === Number(meta.warehouse_id))
                      );
                      return (
                        <tr key={idx} className="hover:bg-slate-50/60">
                          <td className="px-2 py-1.5 text-center border-r border-slate-200">
                            <input
                              type="checkbox"
                              checked={selectedRows.includes(idx)}
                              onChange={(e) =>
                                setSelectedRows((prev) =>
                                  e.target.checked ? [...prev, idx] : prev.filter((x) => x !== idx)
                                )
                              }
                            />
                          </td>
                          <td className="px-2 py-1.5 text-center text-slate-500 font-mono border-r border-slate-200">
                            {idx + 1}
                          </td>
                          <td className="px-2 py-1 border-r border-slate-200">
                            <SearchableSelect
                              options={availableItems.map((i) => ({
                                value: i.id,
                                label: `${i.item_code} - ${i.name}`,
                                sublabel: i.stock_uom,
                              }))}
                              value={li.item_id}
                              onChange={async (v) => {
                                if (v === '') {
                                  setLines((prev) => {
                                    const next = [...prev];
                                    next[idx] = { ...next[idx], item_id: '', rate: 0, tank_id: '' };
                                    return next;
                                  });
                                  return;
                                }
                                const numId = Number(v);
                                const found = itemById.get(numId);
                                const defaultRate =
                                  companyRole === 'Seller'
                                    ? Number(found?.selling_price || 0)
                                    : Number(found?.standard_cost || found?.average_cost || 0);
                                setLines((prev) => {
                                  const next = [...prev];
                                  next[idx] = {
                                    ...next[idx],
                                    item_id: numId,
                                    rate: defaultRate,
                                    vat_rate: meta.tax_template === 'UAE VAT 5%' ? Number(found?.vat_rate ?? 5) : 0,
                                    tank_id: findMatchingTank(numId, meta.warehouse_id),
                                  };
                                  return next;
                                });
                                if (onItemLookupRate) await onItemLookupRate(idx, numId, li.qty);
                              }}
                              placeholder="Type to select item..."
                              createOptionLabel="item"
                              onCreateOption={(query) => beginQuickCreate('item', query, idx)}
                            />
                          </td>
                          <td className="px-2 py-1 border-r border-slate-200">
                            <input
                              type="number"
                              step="0.01"
                              value={li.qty}
                              onChange={(e) => {
                                const q = Number(e.target.value);
                                setLines((prev) => {
                                  const next = [...prev];
                                  next[idx] = { ...next[idx], qty: q };
                                  return next;
                                });
                                if (li.item_id && onItemLookupRate) void onItemLookupRate(idx, Number(li.item_id), q);
                              }}
                              className="w-full text-right px-2 py-1 border border-transparent focus:border-slate-300 rounded font-mono tabular-nums"
                            />
                          </td>
                          <td className="px-2 py-1.5 text-center text-slate-600 border-r border-slate-200">{uom}</td>
                          <td className="px-2 py-1 border-r border-slate-200">
                            <input
                              type="number"
                              step="0.01"
                              value={li.rate}
                              onChange={(e) => {
                                const r = Number(e.target.value);
                                setLines((prev) => {
                                  const next = [...prev];
                                  next[idx] = { ...next[idx], rate: r };
                                  return next;
                                });
                              }}
                              className="w-full text-right px-2 py-1 border border-transparent focus:border-slate-300 rounded font-mono tabular-nums"
                            />
                          </td>
                          <td className="px-2.5 py-1.5 text-right font-mono tabular-nums text-slate-800 border-r border-slate-200">
                            {amount.toFixed(2)}
                          </td>
                          {showTankColumn && (
                            <td className="px-2 py-1 border-r border-slate-200">
                              <select
                                value={li.tank_id ?? ''}
                                onChange={(e) => {
                                  const tv = e.target.value ? Number(e.target.value) : '';
                                  setLines((prev) => {
                                    const next = [...prev];
                                    next[idx] = { ...next[idx], tank_id: tv };
                                    return next;
                                  });
                                }}
                                className="w-full px-1.5 py-1 border border-slate-200 rounded text-[11px]"
                              >
                                <option value="">Warehouse Bin</option>
                                {whTanks.map((t) => (
                                  <option key={t.id} value={t.id}>
                                    {t.tank_code} ({t.current_qty}/{t.capacity_qty})
                                  </option>
                                ))}
                              </select>
                            </td>
                          )}
                          {showBatchColumn && (
                            <td className="px-2 py-1 border-r border-slate-200">
                              <input
                                value={li.batch_number || ''}
                                onChange={(e) => {
                                  const val = e.target.value;
                                  setLines((prev) => {
                                    const next = [...prev];
                                    next[idx] = { ...next[idx], batch_number: val };
                                    return next;
                                  });
                                }}
                                placeholder="Auto"
                                className="w-full px-1.5 py-1 border border-transparent focus:border-slate-300 rounded font-mono text-[11px]"
                              />
                            </td>
                          )}
                          <td className="px-2 py-1.5 text-center">
                            <button
                              type="button"
                              onClick={() => setLines(lines.filter((_, j) => j !== idx))}
                              className="p-1 text-slate-400 hover:text-red-600"
                              title="Remove row"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              {/* Grid Action Toolbar: Add Row | Add Multiple ... Download | Upload */}
              <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() =>
                      setLines((prev) => [
                        ...prev,
                        {
                          item_id: '',
                          qty: 1,
                          rate: 0,
                          discount_pct: 0,
                          vat_rate: meta.tax_template === 'UAE VAT 5%' ? 5 : 0,
                          batch_number: '',
                          tank_id: '',
                          required_by: meta.delivery_date,
                        },
                      ])
                    }
                    className="px-2.5 py-1 text-[11px] font-medium bg-slate-100 hover:bg-slate-200 text-slate-800 rounded border border-slate-200"
                  >
                    Add Row
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setMultiSelected([]);
                      setMultiSearch('');
                      setShowAddMultiple(true);
                    }}
                    className="px-2.5 py-1 text-[11px] font-medium bg-slate-100 hover:bg-slate-200 text-slate-800 rounded border border-slate-200"
                  >
                    Add Multiple
                  </button>
                  {selectedRows.length > 0 && (
                    <button
                      type="button"
                      onClick={() => {
                        setLines(lines.filter((_, idx) => !selectedRows.includes(idx)));
                        setSelectedRows([]);
                      }}
                      className="px-2.5 py-1 text-[11px] font-medium bg-red-50 hover:bg-red-100 text-red-700 rounded border border-red-200"
                    >
                      Delete Selected ({selectedRows.length})
                    </button>
                  )}
                </div>

                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={handleTemplateDownload}
                    className="inline-flex items-center gap-1 px-2.5 py-1 text-[11px] font-medium bg-slate-100 hover:bg-slate-200 text-slate-800 rounded border border-slate-200"
                    title="Download Excel line-items template"
                  >
                    <Download className="w-3 h-3" /> Download
                  </button>
                  <button
                    type="button"
                    onClick={() => uploadInputRef.current?.click()}
                    className="inline-flex items-center gap-1 px-2.5 py-1 text-[11px] font-medium bg-slate-100 hover:bg-slate-200 text-slate-800 rounded border border-slate-200"
                    title="Upload Excel line items directly into this table"
                  >
                    <Upload className="w-3 h-3" /> Upload
                  </button>
                  <input
                    ref={uploadInputRef}
                    type="file"
                    accept=".xlsx,.xls,.csv"
                    onChange={(e) => void handleUploadItemsExcel(e)}
                    className="hidden"
                  />
                </div>
              </div>

              {/* Total Quantity & Total (AED) */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4 pt-2">
                <div>
                  <label className="block text-[11px] text-slate-600 mb-1">Total Quantity</label>
                  <input
                    readOnly
                    value={totals.totalQty.toLocaleString('en-US', { maximumFractionDigits: 4 })}
                    className="w-full px-3 py-1.5 bg-slate-100 border border-slate-200 rounded font-mono tabular-nums text-slate-800"
                  />
                </div>
                <div>
                  <label className="block text-[11px] text-slate-600 mb-1">Total ({meta.currency})</label>
                  <input
                    readOnly
                    value={totals.netTotal.toFixed(2)}
                    className="w-full px-3 py-1.5 bg-slate-100 border border-slate-200 rounded font-mono tabular-nums text-slate-800 text-right"
                  />
                </div>
              </div>
            </div>

            {/* Taxes and Charges Section */}
            <div className="border-t border-slate-200 pt-4 space-y-3">
              <h4 className="text-xs font-semibold text-slate-900">Taxes and Charges</h4>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div>
                  <label className="block text-[11px] text-slate-600 mb-1">Tax Category</label>
                  <input
                    value={meta.tax_category}
                    onChange={(e) => setMeta((m) => ({ ...m, tax_category: e.target.value }))}
                    placeholder="Standard Rated"
                    className="w-full px-3 py-1.5 bg-slate-50 border border-slate-200 rounded"
                  />
                </div>
                {showFreight && (
                  <div>
                    <label className="block text-[11px] text-slate-600 mb-1">Shipping / Freight ({meta.currency})</label>
                    <input
                      type="number"
                      step="0.01"
                      value={meta.freight_amount}
                      onChange={(e) => setMeta((m) => ({ ...m, freight_amount: e.target.value }))}
                      className="w-full px-3 py-1.5 bg-slate-50 border border-slate-200 rounded font-mono"
                    />
                  </div>
                )}
                <div>
                  <label className="block text-[11px] text-slate-600 mb-1">Incoterm / Delivery Terms</label>
                  <input
                    value={meta.delivery_terms}
                    onChange={(e) => setMeta((m) => ({ ...m, delivery_terms: e.target.value }))}
                    placeholder="CIF / FOB / Ex-Works"
                    className="w-full px-3 py-1.5 bg-slate-50 border border-slate-200 rounded"
                  />
                </div>
                <div>
                  <label className="block text-[11px] text-slate-600 mb-1">Taxes and Charges Template</label>
                  <select
                    value={meta.tax_template}
                    onChange={(e) => {
                      const nextTpl = e.target.value as ErpDocMetaState['tax_template'];
                      const nextRate = nextTpl === 'UAE VAT 5%' ? 5 : 0;
                      setMeta((m) => ({ ...m, tax_template: nextTpl }));
                      setLines((prev) => prev.map((l) => ({ ...l, vat_rate: nextRate })));
                    }}
                    className="w-full px-3 py-1.5 bg-slate-50 border border-slate-200 rounded"
                  >
                    <option value="UAE VAT 5%">UAE VAT 5%</option>
                    <option value="Zero Rated 0%">Zero Rated 0%</option>
                    <option value="Exempt">Exempt</option>
                  </select>
                </div>
              </div>

              <div className="border border-slate-200 rounded-md overflow-x-auto">
                <table className="w-full text-left border-collapse text-xs">
                  <thead>
                    <tr className="bg-slate-50 border-b border-slate-200 text-[11px] font-medium text-slate-600">
                      <th className="w-10 px-2 py-2 text-center border-r border-slate-200">No.</th>
                      <th className="w-36 px-2.5 py-2 border-r border-slate-200">Type *</th>
                      <th className="px-2.5 py-2 border-r border-slate-200">Account Head *</th>
                      <th className="w-20 px-2.5 py-2 text-right border-r border-slate-200">Tax Rate</th>
                      <th className="w-28 px-2.5 py-2 text-right border-r border-slate-200">Amount ({meta.currency})</th>
                      <th className="w-28 px-2.5 py-2 text-right">Total ({meta.currency})</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr>
                      <td className="px-2 py-2 text-center font-mono text-slate-500 border-r border-slate-200">1</td>
                      <td className="px-2.5 py-2 border-r border-slate-200">On Net Total</td>
                      <td className="px-2.5 py-2 font-mono text-[11px] border-r border-slate-200">{vatAccountHead}</td>
                      <td className="px-2.5 py-2 text-right font-mono tabular-nums border-r border-slate-200">{vatDisplayRate}</td>
                      <td className="px-2.5 py-2 text-right font-mono tabular-nums border-r border-slate-200">{totals.vatTotal.toFixed(2)}</td>
                      <td className="px-2.5 py-2 text-right font-mono tabular-nums">{totals.grandTotal.toFixed(2)}</td>
                    </tr>
                  </tbody>
                </table>
              </div>

              <div className="flex justify-end">
                <div className="w-full md:w-72">
                  <label className="block text-[11px] text-slate-600 mb-1">Total Taxes and Charges ({meta.currency})</label>
                  <input
                    readOnly
                    value={totals.vatTotal.toFixed(2)}
                    className="w-full px-3 py-1.5 bg-slate-100 border border-slate-200 rounded font-mono tabular-nums text-right"
                  />
                </div>
              </div>
            </div>

            {/* Totals Section */}
            <div className="border-t border-slate-200 pt-4 space-y-3">
              <h4 className="text-xs font-semibold text-slate-900">Totals</h4>
              <div className="flex flex-col items-end gap-2">
                <div className="w-full md:w-72">
                  <label className="block text-[11px] text-slate-600 mb-1">Grand Total ({meta.currency})</label>
                  <input
                    readOnly
                    value={totals.grandTotal.toFixed(2)}
                    className="w-full px-3 py-1.5 bg-slate-100 border border-slate-200 rounded font-mono tabular-nums font-semibold text-slate-900 text-right"
                  />
                </div>
                <label className="w-full md:w-72 inline-flex items-center gap-2 text-xs text-slate-700 pt-1">
                  <input
                    type="checkbox"
                    checked={meta.disable_rounded_total}
                    onChange={(e) => setMeta((m) => ({ ...m, disable_rounded_total: e.target.checked }))}
                  />
                  <span>Disable Rounded Total</span>
                </label>
              </div>
            </div>

            {/* Additional Discount Section */}
            <div className="border-t border-slate-200 pt-3">
              <button
                type="button"
                onClick={() => setShowDiscountSec((v) => !v)}
                className="flex items-center gap-1.5 text-xs font-semibold text-slate-800 hover:text-slate-950"
              >
                <span>Additional Discount</span>
                {showDiscountSec ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
              </button>
              {showDiscountSec && (
                <div className="mt-3 grid grid-cols-1 md:grid-cols-3 gap-4">
                  <div>
                    <label className="block text-[11px] text-slate-600 mb-1">Additional Discount %</label>
                    <input
                      type="number"
                      step="0.1"
                      value={meta.additional_discount_pct}
                      onChange={(e) => setMeta((m) => ({ ...m, additional_discount_pct: e.target.value }))}
                      className="w-full px-3 py-1.5 bg-slate-50 border border-slate-200 rounded font-mono"
                    />
                  </div>
                  <div>
                    <label className="block text-[11px] text-slate-600 mb-1">Discount Amount ({meta.currency})</label>
                    <input
                      readOnly
                      value={totals.addDiscAmt.toFixed(2)}
                      className="w-full px-3 py-1.5 bg-slate-100 border border-slate-200 rounded font-mono"
                    />
                  </div>
                </div>
              )}
            </div>
          </>
        )}

        {activeTab === 'address' && (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-[11px] font-medium text-slate-600 mb-1">{partyLabel} Address</label>
              <textarea
                readOnly
                rows={3}
                value={[selectedParty?.address, selectedParty?.country].filter(Boolean).join(', ') || 'Select a party to view registered address'}
                className="w-full px-3 py-2 bg-slate-100 border border-slate-200 rounded text-slate-700"
              />
            </div>
            <div className="space-y-3">
              <div>
                <label className="block text-[11px] font-medium text-slate-600 mb-1">{partyLabel} TRN</label>
                <input readOnly value={selectedParty?.trn || '-'} className="w-full px-3 py-1.5 bg-slate-100 border border-slate-200 rounded font-mono" />
              </div>
              <div>
                <label className="block text-[11px] font-medium text-slate-600 mb-1">Contact Person & Tel</label>
                <input
                  readOnly
                  value={[selectedParty?.contact_person, selectedParty?.telephone].filter(Boolean).join(' · ') || '-'}
                  className="w-full px-3 py-1.5 bg-slate-100 border border-slate-200 rounded"
                />
              </div>
            </div>
            <div className="md:col-span-2">
              <label className="block text-[11px] font-medium text-slate-600 mb-1">Delivery Place / Shipping Destination</label>
              <input
                value={meta.delivery_place}
                onChange={(e) => setMeta((m) => ({ ...m, delivery_place: e.target.value }))}
                placeholder="Plant Warehouse / Jebel Ali Port / Customer Site"
                className="w-full px-3 py-1.5 bg-slate-50 border border-slate-200 rounded"
              />
            </div>
          </div>
        )}

        {activeTab === 'terms' && (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {showPaymentTerms && (
              <div>
                <label className="block text-[11px] font-medium text-slate-600 mb-1">Payment Terms Template</label>
                <select
                  value={meta.payment_term_id}
                  onChange={(e) => setMeta((m) => ({ ...m, payment_term_id: Number(e.target.value) || '' }))}
                  className="w-full px-3 py-1.5 bg-slate-50 border border-slate-200 rounded"
                >
                  <option value="">Default</option>
                  {paymentTerms.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </div>
            )}
            <div>
              <label className="block text-[11px] font-medium text-slate-600 mb-1">Delivery Terms / Incoterms</label>
              <input
                value={meta.delivery_terms}
                onChange={(e) => setMeta((m) => ({ ...m, delivery_terms: e.target.value }))}
                placeholder="CIF / FOB / Ex-Works / Delivered"
                className="w-full px-3 py-1.5 bg-slate-50 border border-slate-200 rounded"
              />
            </div>
            <div>
              <label className="block text-[11px] font-medium text-slate-600 mb-1">{partyRefLabel}</label>
              <input
                value={meta.party_ref_no}
                onChange={(e) => setMeta((m) => ({ ...m, party_ref_no: e.target.value }))}
                placeholder="External Quote / LPO Reference"
                className="w-full px-3 py-1.5 bg-slate-50 border border-slate-200 rounded"
              />
            </div>
            <div>
              <label className="block text-[11px] font-medium text-slate-600 mb-1">Revision No.</label>
              <input
                value={meta.revision_no}
                onChange={(e) => setMeta((m) => ({ ...m, revision_no: e.target.value }))}
                className="w-full px-3 py-1.5 bg-slate-50 border border-slate-200 rounded"
              />
            </div>
            <div className="md:col-span-2">
              <label className="block text-[11px] font-medium text-slate-600 mb-1">Terms, Conditions & Remarks</label>
              <textarea
                rows={4}
                value={meta.remarks}
                onChange={(e) => setMeta((m) => ({ ...m, remarks: e.target.value }))}
                placeholder="Notes printed at the bottom of the PDF document..."
                className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded"
              />
            </div>
          </div>
        )}

        {activeTab === 'more' && (
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div>
              <label className="block text-[11px] font-medium text-slate-600 mb-1">Document Series</label>
              <input readOnly value={seriesCode} className="w-full px-3 py-1.5 bg-slate-100 border border-slate-200 rounded font-mono" />
            </div>
            <div>
              <label className="block text-[11px] font-medium text-slate-600 mb-1">Company TRN</label>
              <input readOnly value={company.trn || '-'} className="w-full px-3 py-1.5 bg-slate-100 border border-slate-200 rounded font-mono" />
            </div>
            <div>
              <label className="block text-[11px] font-medium text-slate-600 mb-1">Default VAT Rate</label>
              <input readOnly value={`${company.vat_rate ?? 5}%`} className="w-full px-3 py-1.5 bg-slate-100 border border-slate-200 rounded font-mono" />
            </div>
            <div className="md:col-span-3">
              <label className="block text-[11px] font-medium text-slate-600 mb-1">Internal Remarks</label>
              <textarea
                rows={3}
                value={meta.remarks}
                onChange={(e) => setMeta((m) => ({ ...m, remarks: e.target.value }))}
                className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded"
              />
            </div>
          </div>
        )}
      </div>

      {/* Add Multiple Items Picker Modal */}
      {showAddMultiple && (
        <div className="fixed inset-0 bg-slate-900/50 z-[60] flex items-center justify-center p-4">
          <div className="bg-white border border-slate-200 rounded-lg w-full max-w-2xl max-h-[80vh] flex flex-col overflow-hidden text-xs">
            <div className="px-4 py-3 border-b border-slate-200 flex items-center justify-between">
              <h4 className="font-semibold text-slate-900">Select Multiple Items</h4>
              <button type="button" onClick={() => setShowAddMultiple(false)} className="p-1 text-slate-500 hover:text-slate-900">
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="p-3 border-b border-slate-200">
              <input
                value={multiSearch}
                onChange={(e) => setMultiSearch(e.target.value)}
                placeholder="Search item code or description..."
                className="w-full px-3 py-1.5 border border-slate-300 rounded"
              />
            </div>
            <div className="flex-1 overflow-y-auto divide-y divide-slate-100">
              {items
                .filter((it) => {
                  const q = multiSearch.trim().toLowerCase();
                  if (!q) return true;
                  return it.item_code.toLowerCase().includes(q) || it.name.toLowerCase().includes(q);
                })
                .map((it) => {
                  const checked = multiSelected.includes(it.id);
                  return (
                    <label key={it.id} className="flex items-center justify-between px-4 py-2 hover:bg-slate-50 cursor-pointer">
                      <div className="flex items-center gap-2.5">
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={(e) =>
                            setMultiSelected((prev) =>
                              e.target.checked ? [...prev, it.id] : prev.filter((id) => id !== it.id)
                            )
                          }
                        />
                        <span className="font-mono font-semibold text-slate-900">{it.item_code}</span>
                        <span className="text-slate-700">{it.name}</span>
                      </div>
                      <span className="text-slate-500 font-mono">{it.stock_uom || 'LTR'}</span>
                    </label>
                  );
                })}
            </div>
            <div className="px-4 py-3 border-t border-slate-200 bg-slate-50 flex justify-end gap-2">
              <button type="button" onClick={() => setShowAddMultiple(false)} className="px-3 py-1.5 border border-slate-300 rounded bg-white">
                Cancel
              </button>
              <button
                type="button"
                onClick={() => {
                  const toAdd: ErpFormLine[] = multiSelected.map((id) => {
                    const it = itemById.get(id);
                    const defaultRate =
                      companyRole === 'Seller' ? Number(it?.selling_price || 0) : Number(it?.standard_cost || it?.average_cost || 0);
                    return {
                      item_id: id,
                      qty: 100,
                      rate: defaultRate,
                      discount_pct: 0,
                      vat_rate: meta.tax_template === 'UAE VAT 5%' ? Number(it?.vat_rate ?? 5) : 0,
                      batch_number: '',
                      tank_id: findMatchingTank(id, meta.warehouse_id),
                      required_by: meta.delivery_date,
                    };
                  });
                  setLines((prev) => [...prev.filter((l) => l.item_id !== ''), ...toAdd]);
                  setShowAddMultiple(false);
                }}
                className="inline-flex items-center gap-1 px-4 py-1.5 bg-slate-900 text-white rounded font-medium"
              >
                <Plus className="w-3.5 h-3.5" /> Add {multiSelected.length} Item(s)
              </button>
            </div>
          </div>
        </div>
      )}

      {quickCreate && (
        <div className="fixed inset-0 z-[80] flex items-center justify-center bg-slate-950/45 p-4" role="presentation">
          <section
            role="dialog"
            aria-modal="true"
            aria-labelledby="quick-create-title"
            onKeyDown={(event) => { if (event.key === 'Enter') event.preventDefault(); }}
            className="w-full max-w-xl overflow-hidden rounded-xl border border-slate-200 bg-white shadow-2xl"
          >
            <div className="flex items-start justify-between border-b border-slate-200 px-5 py-4">
              <div>
                <h3 id="quick-create-title" className="text-base font-semibold text-slate-900">
                  Create {quickCreate.kind === 'item' ? 'item' : partyRole === 'Seller' ? 'supplier' : 'customer'}
                </h3>
                <p className="mt-1 text-xs text-slate-500">
                  Save this record and select it in the current {quickCreate.kind === 'item' ? 'order line' : 'document'}.
                </p>
              </div>
              <button type="button" onClick={() => setQuickCreate(null)} className="rounded-md p-1.5 text-slate-500 hover:bg-slate-100 hover:text-slate-900" aria-label="Close">
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="space-y-3 p-5" onKeyDown={(event) => { if (event.key === 'Enter') event.preventDefault(); }}>
              <label className="block">
                <span className="mb-1 block text-xs font-medium text-slate-700">{quickCreate.kind === 'item' ? 'Item name' : `${partyRole === 'Seller' ? 'Supplier' : 'Customer'} name`} <span className="text-red-600">*</span></span>
                <input autoFocus required value={quickCreateName} onChange={(event) => setQuickCreateName(event.target.value)} className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-slate-500 focus:outline-none focus:ring-2 focus:ring-slate-200" />
              </label>

              {quickCreate.kind === 'item' ? (
                <>
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    <label className="block">
                      <span className="mb-1 block text-xs font-medium text-slate-700">Item code <span className="text-red-600">*</span></span>
                      <input required value={quickCreateCode} onChange={(event) => setQuickCreateCode(event.target.value.toUpperCase())} className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm font-mono uppercase" />
                    </label>
                    <label className="block">
                      <span className="mb-1 block text-xs font-medium text-slate-700">Category <span className="text-red-600">*</span></span>
                      <select required value={quickCreateCategoryId} onChange={(event) => setQuickCreateCategoryId(event.target.value)} className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm">
                        <option value="">{quickCreateCategories.length ? 'Choose a category' : 'Loading categories...'}</option>
                        {quickCreateCategories.map((category) => <option key={category.id} value={category.id}>{category.parent_id ? '↳ ' : ''}{category.name}</option>)}
                      </select>
                    </label>
                    <label className="block">
                      <span className="mb-1 block text-xs font-medium text-slate-700">Unit of measure</span>
                      <select value={quickCreateUom} onChange={(event) => setQuickCreateUom(event.target.value)} className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm">
                        {['PCS', 'LTR', 'KG', 'MT', 'DRUM', 'PAIL', 'CAN', 'CARTON', 'BOX', 'SET'].map((uom) => <option key={uom} value={uom}>{uom}</option>)}
                      </select>
                    </label>
                    <label className="block">
                      <span className="mb-1 block text-xs font-medium text-slate-700">VAT rate (%)</span>
                      <input type="number" min="0" max="100" step="0.01" value={quickCreateVatRate} onChange={(event) => setQuickCreateVatRate(event.target.value)} className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm" />
                    </label>
                    <label className="block">
                      <span className="mb-1 block text-xs font-medium text-slate-700">Purchase price ({meta.currency})</span>
                      <input type="number" min="0" step="0.01" value={quickCreatePurchasePrice} onChange={(event) => setQuickCreatePurchasePrice(event.target.value)} className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm" />
                    </label>
                    <label className="block">
                      <span className="mb-1 block text-xs font-medium text-slate-700">Selling price ({meta.currency})</span>
                      <input type="number" min="0" step="0.01" value={quickCreateSellingPrice} onChange={(event) => setQuickCreateSellingPrice(event.target.value)} className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm" />
                    </label>
                  </div>
                  {!quickCreateCategories.length && <p className="text-[11px] text-slate-500">Item categories are loading. You can continue once they appear.</p>}
                </>
              ) : (
                <>
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    <label className="block">
                      <span className="mb-1 block text-xs font-medium text-slate-700">Contact person</span>
                      <input value={quickCreateContact} onChange={(event) => setQuickCreateContact(event.target.value)} className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm" />
                    </label>
                    <label className="block">
                      <span className="mb-1 block text-xs font-medium text-slate-700">Phone</span>
                      <input value={quickCreateTelephone} onChange={(event) => setQuickCreateTelephone(event.target.value)} className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm" />
                    </label>
                    <label className="block">
                      <span className="mb-1 block text-xs font-medium text-slate-700">Email</span>
                      <input type="email" value={quickCreateEmail} onChange={(event) => setQuickCreateEmail(event.target.value)} className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm" />
                    </label>
                    <label className="block">
                      <span className="mb-1 block text-xs font-medium text-slate-700">TRN</span>
                      <input value={quickCreateTrn} onChange={(event) => setQuickCreateTrn(event.target.value)} className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm" />
                    </label>
                    <label className="block">
                      <span className="mb-1 block text-xs font-medium text-slate-700">Currency</span>
                      <select value={quickCreateCurrency} onChange={(event) => setQuickCreateCurrency(event.target.value)} className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm">
                        {['AED', 'USD', 'EUR', 'CNY', 'INR'].map((currency) => <option key={currency} value={currency}>{currency}</option>)}
                      </select>
                    </label>
                  </div>
                  <p className="text-[11px] text-slate-500">A record code will be assigned automatically. You can complete more details later in Master Data.</p>
                </>
              )}

              {quickCreateError && <p role="alert" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">{quickCreateError}</p>}
            </div>

            <div className="flex justify-end gap-2 border-t border-slate-200 bg-slate-50 px-5 py-3">
              <button type="button" onClick={() => setQuickCreate(null)} disabled={quickCreateSaving} className="rounded-md border border-slate-300 bg-white px-3 py-2 text-xs font-medium text-slate-700 hover:bg-slate-100 disabled:opacity-50">Cancel</button>
              <button type="button" onClick={() => void saveQuickCreate()} disabled={quickCreateSaving || (quickCreate.kind === 'item' && (!quickCreateCategories.length || !quickCreateCategoryId))} className="inline-flex items-center gap-1.5 rounded-md bg-slate-900 px-4 py-2 text-xs font-semibold text-white hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50">
                <Plus className="h-3.5 w-3.5" /> {quickCreateSaving ? 'Saving...' : `Create and select ${quickCreate.kind === 'item' ? 'item' : partyRole === 'Seller' ? 'supplier' : 'customer'}`}
              </button>
            </div>
          </section>
        </div>
      )}
    </form>
  );
}

