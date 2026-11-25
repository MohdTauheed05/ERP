import React, { useEffect, useState } from 'react';
import { ArrowRightLeft, Cylinder, FileSpreadsheet, FileText, Plus, RefreshCw } from 'lucide-react';
import { apiRequest } from '../../services/api';
import { DataTable, type ColumnDef } from '../../components/DataTable';
import { ErpDocumentForm, type ErpDocMetaState, type ErpFormItemMaster, type ErpFormLine } from '../../components/ErpDocumentForm';
import { ErpDocumentViewer, type ErpViewerItemLine } from '../../components/ErpDocumentViewer';
import { ExcelImportModal } from '../../components/ExcelImportModal';
import { exportStandardErpPdf } from '../../utils/export';
import { useCompany } from '../../context/CompanyContext';

type InvTab = 'balances' | 'tanks' | 'ledger' | 'batches' | 'entries' | 'reorder';

interface TankRow {
  id: number;
  tank_code: string;
  name: string;
  warehouse_id: number;
  warehouse_name: string;
  tank_type: string;
  capacity_qty: number;
  current_qty: number;
  fill_pct: number;
  uom: string;
  min_heel_qty: number;
  temperature_c: number;
  assigned_item_id: number | null;
  assigned_item_code: string | null;
  assigned_item_name: string | null;
  is_active: number;
}

export function InventoryView() {
  const { company, logoUrl } = useCompany();
  const [tab, setTab] = useState<InvTab>('balances');
  const [balances, setBalances] = useState<Record<string, unknown>[]>([]);
  const [tanks, setTanks] = useState<TankRow[]>([]);
  const [ledger, setLedger] = useState<Record<string, unknown>[]>([]);
  const [batches, setBatches] = useState<Record<string, unknown>[]>([]);
  const [entries, setEntries] = useState<Record<string, unknown>[]>([]);
  const [reorderAll, setReorderAll] = useState<Record<string, unknown>[]>([]);

  const [items, setItems] = useState<ErpFormItemMaster[]>([]);
  const [warehouses, setWarehouses] = useState<{ id: number; code: string; name: string }[]>([]);
  const [showEntryModal, setShowEntryModal] = useState(false);
  const [viewingEntryId, setViewingEntryId] = useState<number | null>(null);
  const [showImportModal, setShowImportModal] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const [entryType, setEntryType] = useState<'Warehouse Transfer' | 'Stock Receipt' | 'Stock Issue' | 'Stock Adjustment' | 'Stock Reconciliation'>('Warehouse Transfer');
  const [toWh, setToWh] = useState<number | ''>('');
  const [fromTankId, setFromTankId] = useState<number | ''>('');
  const [toTankId, setToTankId] = useState<number | ''>('');

  const todayStr = new Date().toISOString().slice(0, 10);
  const [docMeta, setDocMeta] = useState<ErpDocMetaState>({
    doc_date: todayStr,
    delivery_date: todayStr,
    party_id: '',
    warehouse_id: '',
    target_warehouse_id: '',
    payment_term_id: '',
    price_list_id: '',
    currency: 'AED',
    exchange_rate: '1',
    linked_po_id: '',
    linked_grn_id: '',
    linked_rfq_id: '',
    party_ref_no: '',
    supplier_inv_no: '',
    supplier_dn_no: '',
    delivery_terms: '',
    delivery_place: '',
    revision_no: 'Original',
    freight_amount: '0',
    tax_template: 'Exempt',
    tax_category: 'Internal Stock Movement',
    disable_rounded_total: true,
    additional_discount_pct: '0',
    reason: '',
    remarks: '',
  });
  const [lines, setLines] = useState<ErpFormLine[]>([{ item_id: '', qty: 100, rate: 0, discount_pct: 0, vat_rate: 0, batch_number: '', tank_id: '' }]);

  const [assignTank, setAssignTank] = useState<TankRow | null>(null);
  const [assignItemId, setAssignItemId] = useState<string>('');
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');

  const loadAll = async () => {
    try {
      const [b, tk, l, bt, e, r, it, wh] = await Promise.all([
        apiRequest<{ items: Record<string, unknown>[] }>('/api/inventory/balances'),
        apiRequest<{ items: TankRow[] }>('/api/masters/tanks'),
        apiRequest<{ items: Record<string, unknown>[] }>('/api/inventory/ledger'),
        apiRequest<{ items: Record<string, unknown>[] }>('/api/inventory/batches'),
        apiRequest<{ items: Record<string, unknown>[] }>('/api/inventory/entries'),
        apiRequest<{ all: Record<string, unknown>[] }>('/api/inventory/reorder-suggestions'),
        apiRequest<{ items: ErpFormItemMaster[] }>('/api/masters/items'),
        apiRequest<{ items: typeof warehouses }>('/api/masters/warehouses'),
      ]);
      setBalances(b.items);
      setTanks(tk.items);
      setLedger(l.items);
      setBatches(bt.items);
      setEntries(e.items);
      setReorderAll(r.all);
      setItems(it.items);
      setWarehouses(wh.items);
      if (wh.items[0]) {
        setDocMeta((m) => ({ ...m, warehouse_id: m.warehouse_id || wh.items[0].id }));
      }
      if (!toWh && wh.items[1]) setToWh(wh.items[1].id);
      else if (!toWh && wh.items[0]) setToWh(wh.items[0].id);
    } catch (ex: unknown) {
      setErr(ex instanceof Error ? ex.message : 'Failed to load inventory data');
    }
  };

  useEffect(() => {
    void loadAll();
  }, []);

  const openNewStockEntry = () => {
    const wh1 = warehouses[0]?.id || '';
    const wh2 = warehouses[1]?.id || wh1;
    setEntryType('Warehouse Transfer');
    setToWh(wh2);
    setFromTankId('');
    setToTankId('');
    setDocMeta({
      doc_date: todayStr,
      delivery_date: todayStr,
      party_id: '',
      warehouse_id: wh1,
      target_warehouse_id: wh2,
      payment_term_id: '',
      price_list_id: '',
      currency: company.currency || 'AED',
      exchange_rate: '1',
      linked_po_id: '',
      linked_grn_id: '',
      linked_rfq_id: '',
      party_ref_no: '',
      supplier_inv_no: '',
      supplier_dn_no: '',
      delivery_terms: '',
      delivery_place: '',
      revision_no: 'Original',
      freight_amount: '0',
      tax_template: 'Exempt',
      tax_category: 'Internal Stock Movement',
      disable_rounded_total: true,
      additional_discount_pct: '0',
      reason: '',
      remarks: '',
    });
    setLines([{ item_id: '', qty: 100, rate: 0, discount_pct: 0, vat_rate: 0, batch_number: '', tank_id: '' }]);
    setErr('');
    setShowEntryModal(true);
  };

  const openTankTransfer = (tank: TankRow) => {
    const found = tank.assigned_item_id ? items.find((i) => i.id === tank.assigned_item_id) : undefined;
    setEntryType('Warehouse Transfer');
    setToWh(tank.warehouse_id);
    setFromTankId(tank.id);
    setToTankId('');
    setDocMeta((m) => ({
      ...m,
      doc_date: todayStr,
      warehouse_id: tank.warehouse_id,
      target_warehouse_id: tank.warehouse_id,
      remarks: `Tank movement from ${tank.tank_code}`,
    }));
    setLines([
      {
        item_id: tank.assigned_item_id || '',
        qty: 100,
        rate: found ? Number(found.average_cost || found.standard_cost || 0) : 0,
        discount_pct: 0,
        vat_rate: 0,
        batch_number: '',
        tank_id: tank.id,
      },
    ]);
    setErr('');
    setShowEntryModal(true);
  };

  const submitEntry = async (ev: React.FormEvent) => {
    ev.preventDefault();
    setErr('');
    setMsg('');
    const validLines = lines.filter((l) => Number(l.item_id) > 0 && Number(l.qty) > 0);
    if (validLines.length === 0) {
      setErr('Add at least one item line with quantity > 0.');
      return;
    }
    setSubmitting(true);
    try {
      const activeWh = docMeta.warehouse_id ? Number(docMeta.warehouse_id) : undefined;
      const targetWh = toWh ? Number(toWh) : activeWh;
      const fromWarehouseId = ['Warehouse Transfer', 'Stock Issue', 'Stock Adjustment'].includes(entryType) ? activeWh : undefined;
      const toWarehouseId =
        entryType === 'Warehouse Transfer'
          ? targetWh
          : ['Stock Receipt', 'Stock Reconciliation'].includes(entryType)
          ? activeWh
          : undefined;

      const created = await apiRequest<{ id: number; entry_number: string }>('/api/inventory/entries', {
        method: 'POST',
        body: JSON.stringify({
          entry_type: entryType,
          entry_date: docMeta.doc_date,
          from_warehouse_id: fromWarehouseId,
          to_warehouse_id: toWarehouseId,
          from_tank_id: fromTankId ? Number(fromTankId) : null,
          to_tank_id: toTankId ? Number(toTankId) : null,
          remarks: docMeta.remarks,
          items: validLines.map((l) => {
            const rowTank = l.tank_id ? Number(l.tank_id) : null;
            return {
              item_id: Number(l.item_id),
              qty: Number(l.qty),
              unit_cost: Number(l.rate || 0),
              batch_number: l.batch_number || '',
              from_tank_id:
                entryType === 'Warehouse Transfer'
                  ? (fromTankId ? Number(fromTankId) : rowTank)
                  : ['Stock Issue', 'Stock Adjustment'].includes(entryType)
                  ? (rowTank ?? (fromTankId ? Number(fromTankId) : null))
                  : null,
              to_tank_id:
                entryType === 'Warehouse Transfer'
                  ? (toTankId ? Number(toTankId) : null)
                  : ['Stock Receipt', 'Stock Reconciliation'].includes(entryType)
                  ? (rowTank ?? (toTankId ? Number(toTankId) : null))
                  : null,
            };
          }),
        }),
      });
      const subRes = await apiRequest<{ status: string; requiredRole?: string }>(`/api/inventory/entries/${created.id}/submit`, { method: 'POST' });
      setShowEntryModal(false);
      setFromTankId('');
      setToTankId('');
      setMsg(
        subRes.status === 'Pending Approval'
          ? `${created.entry_number} routed to ${subRes.requiredRole} for adjustment approval.`
          : `${created.entry_number} posted to immutable Stock Ledger.`
      );
      await loadAll();
    } catch (ex: unknown) {
      setErr(ex instanceof Error ? ex.message : 'Failed to process stock entry');
    } finally {
      setSubmitting(false);
    }
  };

  const printStockEntryPdf = (r: Record<string, unknown>) => {
    const rawItems = (r.items as Record<string, unknown>[]) || [];
    const mapped = rawItems.map((it) => {
      const qty = Number(it.qty || 0);
      const cost = Number(it.unit_cost || 0);
      const total = Number(it.total_cost || qty * cost);
      const tankLabel = it.from_tank_code || it.to_tank_code ? ` [${it.from_tank_code || ''} -> ${it.to_tank_code || ''}]` : '';
      return {
        item_code: String(it.item_code || ''),
        description: `${String(it.item_name || '')}${tankLabel}${it.batch_number ? ` (Batch: ${String(it.batch_number)})` : ''}`,
        qty,
        uom: String(it.uom || 'LTR'),
        unit_price: cost,
        vat_pct: 0,
        vat_amount: 0,
        total,
      };
    });
    const totalVal = Number(r.total_value || mapped.reduce((s, x) => s + x.total, 0));
    void exportStandardErpPdf({
      docTitle: `STOCK ENTRY — ${String(r.entry_type || '').toUpperCase()}`,
      docNumberLabel: 'Entry No.',
      docNumber: String(r.entry_number || ''),
      docDate: String(r.entry_date || ''),
      company,
      logoUrl,
      companyRole: 'Buyer',
      partyRole: 'Seller',
      partyName: String(r.to_warehouse_name || r.from_warehouse_name || company.name || 'Warehouse'),
      deliveryPlace: `${String(r.from_warehouse_name || '-')} -> ${String(r.to_warehouse_name || '-')}`,
      partyRefLabel: 'Movement Type',
      partyRefNo: String(r.entry_type || ''),
      currency: company.currency || 'AED',
      items: mapped,
      netTotal: totalVal,
      vatTotal: 0,
      grandTotal: totalVal,
      remarks: String(r.remarks || ''),
      preparedBy: String(r.creator_name || ''),
      creatorName: String(r.creator_name || ''),
    });
  };

  const generateReorderMr = async () => {
    setErr('');
    setMsg('');
    try {
      const res = await apiRequest<{ created: boolean; mr_number?: string; item_count?: number; message?: string }>('/api/inventory/reorder-generate-mr', {
        method: 'POST',
        body: JSON.stringify({}),
      });
      setMsg(res.created ? `Generated ${res.mr_number} for ${res.item_count} shortage items.` : res.message || 'No new shortages.');
      await loadAll();
    } catch (ex: unknown) {
      setErr(ex instanceof Error ? ex.message : 'Failed to generate MR');
    }
  };

  const fromTanks = tanks.filter((t) => t.is_active && (!docMeta.warehouse_id || t.warehouse_id === Number(docMeta.warehouse_id)));
  const toTanks = tanks.filter((t) => t.is_active && (!toWh || t.warehouse_id === Number(toWh)));

  const tabs: { id: InvTab; label: string }[] = [
    { id: 'balances', label: 'Warehouse Stock' },
    { id: 'tanks', label: 'Tank Farm (Base Oil & Additives)' },
    { id: 'ledger', label: 'Stock Register / Ledger' },
    { id: 'batches', label: 'Batches & Ageing' },
    { id: 'entries', label: 'Transfers & Adjustments' },
    { id: 'reorder', label: 'Reorder & MRP Planning' },
  ];

  const ledgerCols: ColumnDef<Record<string, unknown>>[] = [
    { key: 'posting_date', header: 'Date' },
    { key: 'doc_number', header: 'Ref #' },
    { key: 'doc_type', header: 'Movement Type' },
    { key: 'item_code', header: 'Item Code' },
    { key: 'warehouse_name', header: 'Warehouse' },
    { key: 'tank_code', header: 'Tank', render: (r) => (r.tank_code ? <span className="font-mono text-xs">{String(r.tank_code)}</span> : '-') },
    { key: 'batch_number', header: 'Batch #' },
    { key: 'opening_qty', header: 'Opening', numeric: true },
    { key: 'inward_qty', header: 'Inward', numeric: true },
    { key: 'outward_qty', header: 'Outward', numeric: true },
    { key: 'closing_qty', header: 'Closing', numeric: true },
    { key: 'unit_cost', header: 'Unit Cost', numeric: true, render: (r) => Number(r.unit_cost || 0).toFixed(2) },
    { key: 'stock_value', header: 'Value', numeric: true, render: (r) => Number(r.stock_value || 0).toFixed(2) },
  ];

  if (showEntryModal) {
    return (
      <div className="space-y-4">
        {err && <div className="p-3 bg-red-50 border border-red-200 rounded text-xs text-red-700">{err}</div>}
        <ErpDocumentForm
          title="New Stock / Tank Entry"
          seriesCode="MAT-STE-.YYYY.-"
          docTitleForPdf={`STOCK ENTRY (${entryType.toUpperCase()})`}
          docNumberLabel="Entry No."
          companyRole="Buyer"
          partyRole="Seller"
          warehouseLabel={entryType === 'Warehouse Transfer' ? 'From Warehouse (Source)' : entryType === 'Stock Issue' ? 'From Warehouse' : 'Target Warehouse'}
          showParty={false}
          showPaymentTerms={false}
          showPriceList={false}
          showFreight={false}
          showTankColumn={true}
          showBatchColumn={true}
          parties={[]}
          items={items}
          warehouses={warehouses}
          tanks={tanks}
          meta={docMeta}
          setMeta={setDocMeta}
          lines={lines}
          setLines={setLines}
          onSave={submitEntry}
          onCancel={() => setShowEntryModal(false)}
          onOpenBulkImport={() => setShowImportModal(true)}
          submitting={submitting}
          saveLabel="Save & Post"
          extraHeaderSlot={
            <>
              <div>
                <label className="block text-[11px] font-medium text-slate-600 mb-1">
                  Stock Entry Type <span className="text-red-600">*</span>
                </label>
                <select
                  value={entryType}
                  onChange={(e) => setEntryType(e.target.value as typeof entryType)}
                  className="w-full px-3 py-1.5 bg-slate-50 border border-slate-200 rounded"
                >
                  <option value="Warehouse Transfer">Warehouse / Tank Transfer</option>
                  <option value="Stock Receipt">Stock Receipt</option>
                  <option value="Stock Issue">Stock Issue</option>
                  <option value="Stock Adjustment">Stock Adjustment</option>
                  <option value="Stock Reconciliation">Stock Reconciliation</option>
                </select>
              </div>
              {entryType === 'Warehouse Transfer' && (
                <div>
                  <label className="block text-[11px] font-medium text-slate-600 mb-1">
                    To / Target Warehouse <span className="text-red-600">*</span>
                  </label>
                  <select
                    value={toWh}
                    onChange={(e) => {
                      setToWh(Number(e.target.value));
                      setToTankId('');
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
              )}
              {['Warehouse Transfer', 'Stock Issue', 'Stock Adjustment'].includes(entryType) && fromTanks.length > 0 && (
                <div>
                  <label className="block text-[11px] font-medium text-slate-600 mb-1">Source Tank (Optional)</label>
                  <select
                    value={fromTankId}
                    onChange={(e) => setFromTankId(e.target.value ? Number(e.target.value) : '')}
                    className="w-full px-3 py-1.5 bg-slate-50 border border-slate-200 rounded"
                  >
                    <option value="">-- Floor / Row Tank --</option>
                    {fromTanks.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.tank_code} — {t.assigned_item_code || t.name} ({t.current_qty}/{t.capacity_qty} {t.uom})
                      </option>
                    ))}
                  </select>
                </div>
              )}
              {['Warehouse Transfer', 'Stock Receipt', 'Stock Reconciliation'].includes(entryType) && toTanks.length > 0 && (
                <div>
                  <label className="block text-[11px] font-medium text-slate-600 mb-1">Destination Tank (Optional)</label>
                  <select
                    value={toTankId}
                    onChange={(e) => setToTankId(e.target.value ? Number(e.target.value) : '')}
                    className="w-full px-3 py-1.5 bg-slate-50 border border-slate-200 rounded"
                  >
                    <option value="">-- Floor / Row Tank --</option>
                    {toTanks.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.tank_code} — {t.assigned_item_code || t.name} ({t.current_qty}/{t.capacity_qty} {t.uom})
                      </option>
                    ))}
                  </select>
                </div>
              )}
            </>
          }
        />
        <ExcelImportModal
          open={showImportModal}
          initialType="stock_adjustment"
          onClose={() => setShowImportModal(false)}
          onImported={(m) => {
            setMsg(m);
            setShowEntryModal(false);
            void loadAll();
          }}
        />
      </div>
    );
  }

  if (viewingEntryId !== null) {
    const idx = entries.findIndex((x) => Number(x.id) === viewingEntryId);
    const rec = idx >= 0 ? entries[idx] : undefined;
    if (rec) {
      const rawItems = (rec.items as Record<string, unknown>[]) || [];
      const viewerItems: ErpViewerItemLine[] = rawItems.map((it) => {
        const qty = Number(it.qty || 0);
        const cost = Number(it.unit_cost || 0);
        const tankLabel = it.from_tank_code || it.to_tank_code ? `${it.from_tank_code || '-'} -> ${it.to_tank_code || '-'}` : undefined;
        return {
          item_code: String(it.item_code || ''),
          description: String(it.item_name || ''),
          uom: String(it.uom || 'LTR'),
          qty,
          rate: cost,
          vat_rate: 0,
          line_total: Number(it.total_cost || qty * cost),
          tank_code: tankLabel,
          batch_number: it.batch_number ? String(it.batch_number) : undefined,
        };
      });
      const totalVal = Number(rec.total_value || viewerItems.reduce((s, x) => s + x.line_total, 0));

      return (
        <div className="space-y-4">
          <ErpDocumentViewer
            docType="StockEntry"
            docId={Number(rec.id)}
            docNumber={String(rec.entry_number || '')}
            title={`Stock Entry — ${String(rec.entry_type || '')}`}
            status={String(rec.status || '')}
            docDate={String(rec.entry_date || '')}
            companyRole="Buyer"
            partyLabel="Warehouse Movement"
            partyName={String(rec.to_warehouse_name || rec.from_warehouse_name || company.name || '')}
            warehouseName={`${String(rec.from_warehouse_name || '-')} -> ${String(rec.to_warehouse_name || '-')}`}
            warehouseLabel="Warehouse Route"
            refLabel="Entry Type"
            refNo={String(rec.entry_type || '')}
            currency={company.currency || 'AED'}
            remarks={String(rec.remarks || '')}
            creatorName={String(rec.creator_name || '')}
            createdAt={String(rec.created_at || '')}
            subtotal={totalVal}
            vatAmount={0}
            totalAmount={totalVal}
            items={viewerItems}
            showTankCol={true}
            showBatchCol={true}
            createActions={[
              {
                label: 'Duplicate Entry',
                variant: 'secondary',
                onClick: () => {
                  openNewStockEntry();
                  setEntryType((String(rec.entry_type || 'Warehouse Transfer') as typeof entryType));
                  setDocMeta((m) => ({
                    ...m,
                    warehouse_id: Number(rec.from_warehouse_id || warehouses[0]?.id || ''),
                    target_warehouse_id: Number(rec.to_warehouse_id || warehouses[0]?.id || ''),
                    remarks: `Copied from ${String(rec.entry_number || '')}`,
                  }));
                  if (rawItems.length > 0) {
                    setLines(
                      rawItems.map((it) => ({
                        item_id: Number(it.item_id),
                        qty: Number(it.qty || 1),
                        rate: Number(it.unit_cost || 0),
                        discount_pct: 0,
                        vat_rate: 0,
                        batch_number: String(it.batch_number || ''),
                        tank_id: it.to_tank_id ? Number(it.to_tank_id) : it.from_tank_id ? Number(it.from_tank_id) : '',
                      }))
                    );
                  }
                  setViewingEntryId(null);
                  setShowEntryModal(true);
                },
              },
            ]}
            onBack={() => setViewingEntryId(null)}
            hasPrev={idx > 0}
            hasNext={idx >= 0 && idx < entries.length - 1}
            onPrev={() => {
              if (idx > 0) setViewingEntryId(Number(entries[idx - 1].id));
            }}
            onNext={() => {
              if (idx < entries.length - 1) setViewingEntryId(Number(entries[idx + 1].id));
            }}
            onPrintPreview={() => printStockEntryPdf(rec)}
          />
        </div>
      );
    }
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-slate-900">Perpetual Inventory, Tank Farm & MRP</h1>
          <p className="text-xs text-slate-500">Multi-tank Base Oil & Additive storage, FIFO / Moving Average valuation, warehouse transfers & reorder planning</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => setShowImportModal(true)}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded-md hover:bg-slate-50"
          >
            <FileSpreadsheet className="w-3.5 h-3.5 text-emerald-700" /> Import Stock (Excel)
          </button>
          <button
            type="button"
            onClick={openNewStockEntry}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-white bg-slate-900 rounded-md hover:bg-slate-800"
          >
            <Plus className="w-3.5 h-3.5" /> New Stock / Tank Entry
          </button>
          <button
            type="button"
            onClick={generateReorderMr}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded-md hover:bg-slate-50"
          >
            <RefreshCw className="w-3.5 h-3.5" /> Auto-Generate Reorder MR
          </button>
        </div>
      </div>

      <div className="flex flex-wrap gap-1 p-1 bg-slate-100 rounded-lg w-fit">
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setTab(t.id)}
            className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 ${
              tab === t.id ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {msg && <div className="p-3 bg-emerald-50 border border-emerald-200 rounded text-xs text-emerald-800">{msg}</div>}
      {err && <div className="p-3 bg-red-50 border border-red-200 rounded text-xs text-red-700">{err}</div>}

      {tab === 'balances' && (
        <DataTable
          title="Warehouse Stock Balances"
          columns={[
            { key: 'item_code', header: 'Item Code' },
            { key: 'item_name', header: 'Description' },
            { key: 'category_name', header: 'Category' },
            { key: 'warehouse_name', header: 'Warehouse' },
            { key: 'stock_uom', header: 'UOM' },
            { key: 'closing_qty', header: 'Available Qty', numeric: true },
            { key: 'unit_cost', header: 'Unit Cost', numeric: true, render: (r) => Number(r.unit_cost || 0).toFixed(2) },
            { key: 'stock_value', header: 'Stock Value', numeric: true, render: (r) => Number(r.stock_value || 0).toFixed(2) },
          ]}
          data={balances}
          exportFilename="warehouse_stock_balances"
        />
      )}

      {tab === 'tanks' && (
        <div className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {tanks.map((t) => {
              const pct = Math.min(100, Math.max(0, Number(t.fill_pct || 0)));
              const belowHeel = t.min_heel_qty > 0 && t.current_qty > 0 && t.current_qty <= t.min_heel_qty;
              return (
                <div key={t.id} className="bg-white border border-slate-200 rounded-lg p-4 space-y-3 text-xs">
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <div className="p-2 rounded bg-slate-100 text-slate-700">
                        <Cylinder className="w-4 h-4" />
                      </div>
                      <div>
                        <p className="font-mono font-semibold text-slate-900">{t.tank_code}</p>
                        <p className="text-slate-600 font-medium">{t.name}</p>
                      </div>
                    </div>
                    <span className="px-2 py-0.5 rounded text-[11px] font-medium bg-slate-100 text-slate-700 border border-slate-200">
                      {t.tank_type}
                    </span>
                  </div>

                  <div className="space-y-1">
                    <div className="flex justify-between text-[11px] text-slate-500">
                      <span>Warehouse: <strong className="text-slate-800">{t.warehouse_name}</strong></span>
                      <span>Temp: <strong className="font-mono text-slate-800">{t.temperature_c}°C</strong></span>
                    </div>
                    <div className="text-[11px] text-slate-600">
                      Assigned Material:{' '}
                      {t.assigned_item_code ? (
                        <strong className="text-slate-900">{t.assigned_item_code} — {t.assigned_item_name}</strong>
                      ) : (
                        <span className="text-amber-700 font-medium">Unassigned (Open Tank)</span>
                      )}
                    </div>
                  </div>

                  <div className="space-y-1">
                    <div className="flex justify-between font-mono text-[11px]">
                      <span>{Number(t.current_qty).toLocaleString()} / {Number(t.capacity_qty).toLocaleString()} {t.uom}</span>
                      <span className={pct > 90 ? 'text-amber-700 font-semibold' : 'text-slate-700 font-semibold'}>{pct.toFixed(1)}%</span>
                    </div>
                    <div className="w-full h-2.5 bg-slate-100 rounded overflow-hidden border border-slate-200">
                      <div
                        className={`h-full ${belowHeel ? 'bg-amber-500' : pct > 90 ? 'bg-red-600' : 'bg-slate-800'}`}
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                    {belowHeel && <p className="text-[10px] text-amber-700 font-medium">Below Min Heel ({t.min_heel_qty} {t.uom})</p>}
                  </div>

                  <div className="flex items-center justify-between gap-2 pt-1 border-t border-slate-100">
                    <button
                      type="button"
                      onClick={() => {
                        setAssignTank(t);
                        setAssignItemId(t.assigned_item_id ? String(t.assigned_item_id) : '');
                      }}
                      className="px-2.5 py-1 text-[11px] font-medium border border-slate-300 rounded hover:bg-slate-50"
                    >
                      Assign Material
                    </button>
                    <button
                      type="button"
                      onClick={() => openTankTransfer(t)}
                      className="inline-flex items-center gap-1 px-2.5 py-1 text-[11px] font-medium bg-slate-900 text-white rounded hover:bg-slate-800"
                    >
                      <ArrowRightLeft className="w-3 h-3" /> Transfer / Pump
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {tab === 'ledger' && <DataTable title="Immutable Stock Ledger" columns={ledgerCols} data={ledger} exportFilename="stock_ledger" />}

      {tab === 'batches' && (
        <DataTable
          title="Stock Batches & Ageing"
          columns={[
            { key: 'batch_number', header: 'Batch #' },
            { key: 'item_code', header: 'Item' },
            { key: 'item_name', header: 'Product' },
            { key: 'warehouse_name', header: 'Warehouse' },
            { key: 'tank_code', header: 'Tank', render: (r) => (r.tank_code ? String(r.tank_code) : '-') },
            { key: 'available_qty', header: 'Avail Qty', numeric: true },
            { key: 'age_days', header: 'Age (Days)', numeric: true },
            { key: 'qc_status', header: 'QC Status' },
            { key: 'is_on_hold', header: 'Hold', render: (r) => (r.is_on_hold ? 'ON HOLD' : 'Released') },
          ]}
          data={batches}
          exportFilename="stock_batches"
        />
      )}

      {tab === 'entries' && (
        <DataTable
          title="Stock Transfers, Issues & Adjustments"
          columns={[
            { key: 'entry_number', header: 'Entry #' },
            { key: 'entry_type', header: 'Type' },
            { key: 'entry_date', header: 'Date' },
            { key: 'from_warehouse_name', header: 'From Warehouse' },
            { key: 'to_warehouse_name', header: 'To Warehouse' },
            { key: 'total_value', header: 'Value', numeric: true, render: (r) => Number(r.total_value || 0).toFixed(2) },
            { key: 'status', header: 'Status' },
            {
              key: 'actions',
              header: 'Actions',
              render: (r) => (
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    printStockEntryPdf(r);
                  }}
                  className="inline-flex items-center gap-1 px-2 py-1 text-xs border border-slate-300 rounded hover:bg-slate-50"
                  title="Open Print Preview before downloading PDF"
                >
                  <FileText className="w-3 h-3" /> Preview PDF
                </button>
              ),
            },
          ]}
          data={entries}
          onRowClick={(r) => setViewingEntryId(Number(r.id))}
          exportFilename="stock_entries"
        />
      )}

      {tab === 'reorder' && (
        <DataTable
          title="MRP & Shortage Planning Dashboard"
          columns={[
            { key: 'item_code', header: 'Item Code' },
            { key: 'item_name', header: 'Description' },
            { key: 'available_stock', header: 'On Hand', numeric: true },
            { key: 'pending_po_qty', header: 'Pending PO', numeric: true },
            { key: 'reserved_qty', header: 'Reserved SO', numeric: true },
            { key: 'expected_production_qty', header: 'Prod Req', numeric: true },
            { key: 'reorder_level', header: 'Reorder Lvl', numeric: true },
            { key: 'suggested_purchase_qty', header: 'Suggested Buy', numeric: true },
            { key: 'preferred_supplier_name', header: 'Preferred Supplier' },
            {
              key: 'status',
              header: 'Status',
              render: (r) => <span className={r.status === 'Shortage' ? 'text-red-600 font-semibold' : 'text-emerald-700'}>{String(r.status)}</span>,
            },
          ]}
          data={reorderAll}
          exportFilename="mrp_reorder_plan"
          statusFilterKey="status"
          statusOptions={['Shortage', 'Healthy']}
        />
      )}

      <ExcelImportModal
        open={showImportModal}
        initialType="opening_stock"
        onClose={() => setShowImportModal(false)}
        onImported={(m) => {
          setMsg(m);
          void loadAll();
        }}
      />

      {assignTank && (
        <div className="fixed inset-0 bg-slate-900/40 z-50 flex items-center justify-center p-4">
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              setErr('');
              try {
                await apiRequest(`/api/masters/tanks/${assignTank.id}/assign`, {
                  method: 'POST',
                  body: JSON.stringify({ item_id: assignItemId ? Number(assignItemId) : null }),
                });
                setAssignTank(null);
                setMsg(`Assigned material updated on tank ${assignTank.tank_code}.`);
                await loadAll();
              } catch (ex: unknown) {
                setErr(ex instanceof Error ? ex.message : 'Failed to assign material');
              }
            }}
            className="bg-white border border-slate-200 rounded-lg w-full max-w-md p-6 space-y-3 text-xs"
          >
            <h3 className="text-base font-semibold text-slate-900">Assign Material — {assignTank.tank_code} ({assignTank.name})</h3>
            <p className="text-slate-500">Current Tank Level: {assignTank.current_qty} / {assignTank.capacity_qty} {assignTank.uom}</p>
            <select value={assignItemId} onChange={(e) => setAssignItemId(e.target.value)} className="w-full px-3 py-1.5 border border-slate-300 rounded">
              <option value="">-- Clear Material Assignment --</option>
              {items.map((it) => (
                <option key={it.id} value={String(it.id)}>{it.item_code} — {it.name}</option>
              ))}
            </select>
            <div className="flex justify-end gap-2 pt-2">
              <button type="button" onClick={() => setAssignTank(null)} className="px-3 py-1.5 border border-slate-300 rounded">Cancel</button>
              <button type="submit" className="px-4 py-1.5 bg-slate-900 text-white rounded font-medium">Save Assignment</button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}

