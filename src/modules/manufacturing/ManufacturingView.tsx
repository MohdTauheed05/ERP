import React, { useEffect, useRef, useState } from 'react';
import { ArrowLeft, Calculator, CheckCircle2, Download, Factory, FileSpreadsheet, FileText, GitBranch, Plus, Printer, Save, Search, Trash2, Upload } from 'lucide-react';
import { apiRequest } from '../../services/api';
import { DataTable, type ColumnDef } from '../../components/DataTable';
import { SearchableSelect } from '../../components/SearchableSelect';
import { DocumentPanel } from '../../components/DocumentPanel';
import { ErpDocumentViewer, type ErpViewerAction, type ErpViewerItemLine } from '../../components/ErpDocumentViewer';
import { ExcelImportModal } from '../../components/ExcelImportModal';
import { downloadLineItemsExcelTemplate, exportStandardErpPdf, parseLineItemsExcelFile } from '../../utils/export';
import { useCompany } from '../../context/CompanyContext';

type MfgTab = 'boms' | 'production' | 'blending' | 'traceability';

interface BomLineDraft {
  item_id: number;
  component_type: 'Formula' | 'Packaging';
  qty: number;
  wastage_pct: number;
  carton_packing_qty: number;
}

export function ManufacturingView() {
  const { company, logoUrl } = useCompany();
  const [tab, setTab] = useState<MfgTab>('boms');
  const [boms, setBoms] = useState<Record<string, unknown>[]>([]);
  const [orders, setOrders] = useState<Record<string, unknown>[]>([]);
  const [items, setItems] = useState<{ id: number; item_code: string; name: string; stock_uom: string; average_cost: number; standard_cost: number; is_finished_good?: number }[]>([]);
  const [warehouses, setWarehouses] = useState<{ id: number; code: string; name: string; warehouse_type: string }[]>([]);
  const [tanks, setTanks] = useState<{ id: number; tank_code: string; name: string; warehouse_id: number; assigned_item_id: number | null; current_qty: number; capacity_qty: number; uom: string; is_active: number }[]>([]);
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');

  // Modals & Drawers
  const [showBomModal, setShowBomModal] = useState(false);
  const [showProdModal, setShowProdModal] = useState(false);
  const [viewingDoc, setViewingDoc] = useState<{ type: 'bom' | 'prod'; id: number } | null>(null);
  const [showImportModal, setShowImportModal] = useState(false);
  const [bomTab, setBomTab] = useState<'details' | 'more'>('details');
  const [prodTab, setProdTab] = useState<'details' | 'more'>('details');
  const [bomGridMsg, setBomGridMsg] = useState('');
  const bomExcelRef = useRef<HTMLInputElement | null>(null);
  const [scaleBom, setScaleBom] = useState<Record<string, unknown> | null>(null);
  const [scaleTargetQty, setScaleTargetQty] = useState('5000');
  const [scaleResult, setScaleResult] = useState<Record<string, unknown> | null>(null);
  const [completeOrder, setCompleteOrder] = useState<Record<string, unknown> | null>(null);
  const [completeForm, setCompleteForm] = useState({ completed_qty: '', rejected_qty: '0', batch_number: '', qc_release_immediately: false });
  const [consumptionEdits, setConsumptionEdits] = useState<{ id: number; item_id: number; component_type: string; item_name: string; planned_qty: number; actual_qty: string; wastage_qty: string; batch_number: string; tank_id: number | '' }[]>([]);
  const [panelDoc, setPanelDoc] = useState<{ docType: string; docId: number; docNumber: string } | null>(null);

  // Batch Traceability
  const [batches, setBatches] = useState<{ batch_number: string; item_name: string; available_qty: number; qc_status: string }[]>([]);
  const [traceQuery, setTraceQuery] = useState('');
  const [traceData, setTraceData] = useState<Record<string, unknown> | null>(null);

  // New BOM Form
  const [bomForm, setBomForm] = useState({
    finished_item_id: 0,
    version: 'v1.0',
    batch_size: '1000',
    labour_cost: '450',
    overhead_cost: '320',
    expected_wastage_pct: '0.5',
    notes: '',
  });
  const [bomLines, setBomLines] = useState<BomLineDraft[]>([
    { item_id: 0, component_type: 'Formula', qty: 800, wastage_pct: 0.5, carton_packing_qty: 0 },
  ]);

  // New Production Order Form
  const [prodForm, setProdForm] = useState({
    bom_id: 0,
    planned_qty: '1000',
    production_line: 'Blending Kettle Line 1',
    warehouse_id: 0,
    target_warehouse_id: 0,
    operator_name: '',
    equipment_name: 'Blending Kettle K-01',
    carton_packing_qty: '12',
    remarks: '',
  });

  const loadAll = async () => {
    setLoading(true);
    try {
      const [bRes, pRes, iRes, wRes, batchRes, tankRes] = await Promise.all([
        apiRequest<{ items: Record<string, unknown>[] }>('/api/manufacturing/boms'),
        apiRequest<{ items: Record<string, unknown>[] }>('/api/manufacturing/production-orders'),
        apiRequest<{ items: typeof items }>('/api/masters/items'),
        apiRequest<{ items: typeof warehouses }>('/api/masters/warehouses'),
        apiRequest<{ items: typeof batches }>('/api/inventory/batches'),
        apiRequest<{ items: typeof tanks }>('/api/masters/tanks'),
      ]);
      setBoms(bRes.items);
      setOrders(pRes.items);
      setItems(iRes.items);
      setWarehouses(wRes.items);
      setBatches(batchRes.items);
      setTanks(tankRes.items);
      const rmWh = wRes.items.find((w) => w.warehouse_type === 'Raw Material')?.id || wRes.items[0]?.id || 0;
      const fgWh = wRes.items.find((w) => w.warehouse_type === 'Finished Goods')?.id || wRes.items[0]?.id || 0;
      setProdForm((f) => ({
        ...f,
        bom_id: f.bom_id || Number(bRes.items[0]?.id || 0),
        warehouse_id: f.warehouse_id || rmWh,
        target_warehouse_id: f.target_warehouse_id || fgWh,
      }));
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : 'Failed to load manufacturing data');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadAll();
  }, []);

  const itemOptions = items.map((i) => ({
    value: i.id,
    label: `${i.item_code} — ${i.name}`,
    sublabel: `${i.stock_uom} · Cost AED ${Number(i.average_cost || i.standard_cost || 0).toFixed(2)}`,
  }));

  const createBom = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr('');
    try {
      const validLines = bomLines.filter((l) => l.item_id > 0 && l.qty > 0);
      if (!bomForm.finished_item_id || validLines.length === 0) {
        setErr('Select finished lubricant SKU and at least one formula/packaging component.');
        return;
      }
      const res = await apiRequest<{ bom_number: string }>('/api/manufacturing/boms', {
        method: 'POST',
        body: JSON.stringify({
          finished_item_id: bomForm.finished_item_id,
          version: bomForm.version,
          batch_size: Number(bomForm.batch_size),
          labour_cost: Number(bomForm.labour_cost),
          overhead_cost: Number(bomForm.overhead_cost),
          expected_wastage_pct: Number(bomForm.expected_wastage_pct),
          notes: bomForm.notes,
          items: validLines,
        }),
      });
      setShowBomModal(false);
      setMsg(`BOM ${res.bom_number} created and approved.`);
      await loadAll();
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : 'Failed to create BOM');
    }
  };

  const runBomScaling = async (bomId: number, qty: number) => {
    try {
      const res = await apiRequest<Record<string, unknown>>(`/api/manufacturing/boms/${bomId}/scale?qty=${qty}`);
      setScaleResult(res);
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : 'Scaling calculation failed');
    }
  };

  const createProductionOrder = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr('');
    try {
      const res = await apiRequest<{ prod_number: string; blend_number: string; fill_number: string }>('/api/manufacturing/production-orders', {
        method: 'POST',
        body: JSON.stringify({
          ...prodForm,
          bom_id: Number(prodForm.bom_id),
          planned_qty: Number(prodForm.planned_qty),
          warehouse_id: Number(prodForm.warehouse_id),
          target_warehouse_id: Number(prodForm.target_warehouse_id),
          carton_packing_qty: Number(prodForm.carton_packing_qty || 12),
        }),
      });
      setShowProdModal(false);
      setMsg(`Created ${res.prod_number} + Blend ${res.blend_number} + Filling ${res.fill_number}.`);
      await loadAll();
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : 'Failed to create production order');
    }
  };

  const openCompleteModal = (order: Record<string, unknown>) => {
    setCompleteOrder(order);
    setCompleteForm({
      completed_qty: String(order.planned_qty || ''),
      rejected_qty: '0',
      batch_number: `FG-${String(order.prod_number)}`,
      qc_release_immediately: false,
    });
    const cons = (order.consumptions as Record<string, unknown>[]) || [];
    const srcWhId = Number(order.warehouse_id || 0);
    setConsumptionEdits(
      cons.map((c) => {
        const compType = String(c.component_type || 'Formula');
        const itemId = Number(c.item_id || 0);
        const autoTank =
          compType === 'Formula'
            ? tanks.find((t) => t.is_active && t.warehouse_id === srcWhId && t.assigned_item_id === itemId && t.current_qty > 0)?.id ||
              tanks.find((t) => t.is_active && t.assigned_item_id === itemId && t.current_qty > 0)?.id ||
              ''
            : '';
        return {
          id: Number(c.id),
          item_id: itemId,
          component_type: compType,
          item_name: `${String(c.item_code)} — ${String(c.item_name)} (${compType})`,
          planned_qty: Number(c.planned_qty || 0),
          actual_qty: String(c.planned_qty || 0),
          wastage_qty: '0',
          batch_number: '',
          tank_id: c.tank_id ? Number(c.tank_id) : autoTank,
        };
      })
    );
  };

  const submitCompletion = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!completeOrder) return;
    setErr('');
    try {
      const res = await apiRequest<{ batch_number: string; total_actual_cost: number; unit_actual_cost: number }>(
        `/api/manufacturing/production-orders/${completeOrder.id}/complete`,
        {
          method: 'POST',
          body: JSON.stringify({
            completed_qty: Number(completeForm.completed_qty),
            rejected_qty: Number(completeForm.rejected_qty || 0),
            batch_number: completeForm.batch_number,
            qc_release_immediately: completeForm.qc_release_immediately,
            consumptions: consumptionEdits.map((c) => ({
              id: c.id,
              actual_qty: Number(c.actual_qty),
              wastage_qty: Number(c.wastage_qty || 0),
              batch_number: c.batch_number || undefined,
              tank_id: c.tank_id ? Number(c.tank_id) : null,
            })),
          }),
        }
      );
      setCompleteOrder(null);
      setMsg(
        `Production completed. Batch ${res.batch_number} received (Total Cost: AED ${res.total_actual_cost.toFixed(2)}, Unit Cost: AED ${res.unit_actual_cost.toFixed(2)}).`
      );
      await loadAll();
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : 'Failed to complete production');
    }
  };

  const lookupTraceability = async (batchNo: string) => {
    if (!batchNo.trim()) return;
    setErr('');
    try {
      const res = await apiRequest<Record<string, unknown>>(`/api/manufacturing/traceability/${encodeURIComponent(batchNo.trim())}`);
      setTraceData(res);
    } catch (e: unknown) {
      setTraceData(null);
      setErr(e instanceof Error ? e.message : 'Batch not found');
    }
  };

  const printBomPdf = (r: Record<string, unknown>) => {
    const bomItems = (r.items as Record<string, unknown>[]) || [];
    const totalBatch = Number(r.total_batch_cost || 0);
    void exportStandardErpPdf({
      docTitle: 'BILL OF MATERIALS',
      docNumberLabel: 'BOM No.',
      docNumber: String(r.bom_number || ''),
      docDate: String(r.effective_date || String(r.created_at || '').slice(0, 10)),
      company,
      logoUrl,
      companyRole: 'Seller',
      partyRole: 'Buyer',
      partyName: `${String(r.finished_item_code || '')} — ${String(r.finished_item_name || '')}`,
      partyRefLabel: 'Batch Size',
      partyRefNo: `${String(r.batch_size || 0)} ${String(r.uom || '')}`,
      revisionNo: String(r.version || 'v1.0'),
      currency: company.currency || 'AED',
      items: bomItems.map((l) => {
        const q = Number(l.qty || 0);
        const c = Number(l.standard_cost || 0);
        return {
          item_code: String(l.item_code || ''),
          description: `${String(l.item_name || '')} [${String(l.component_type || 'Formula')}]`,
          qty: q,
          uom: String(l.uom || ''),
          unit_price: c,
          vat_pct: Number(l.wastage_pct || 0),
          vat_amount: 0,
          total: q * c,
        };
      }),
      netTotal: Number(r.material_cost || 0),
      vatTotal: Number(r.labour_cost || 0) + Number(r.overhead_cost || 0),
      grandTotal: totalBatch,
      remarks: String(r.notes || `Std Unit Cost: ${Number(r.unit_standard_cost || 0).toFixed(2)}`),
    });
  };

  const printProdPdf = (r: Record<string, unknown>) => {
    const cons = (r.consumptions as Record<string, unknown>[]) || [];
    const matCost = cons.reduce((s, c) => s + Number(c.total_cost || 0), 0);
    const laborOh = Number(r.actual_labour_cost || 0) + Number(r.actual_overhead_cost || 0);
    const totalCost = Number(r.total_actual_cost || matCost + laborOh);
    void exportStandardErpPdf({
      docTitle: 'PRODUCTION ORDER',
      docNumberLabel: 'Prod. No.',
      docNumber: String(r.prod_number || ''),
      docDate: String(r.scheduled_date || ''),
      company,
      logoUrl,
      companyRole: 'Seller',
      partyRole: 'Buyer',
      partyName: `${String(r.item_code || '')} — ${String(r.finished_item_name || '')}`,
      deliveryTerms: String(r.production_line || ''),
      deliveryPlace: `${String(r.source_warehouse_name || '')} -> ${String(r.target_warehouse_name || '')}`,
      partyRefLabel: 'BOM Ref.',
      partyRefNo: `${String(r.bom_number || '')} (${String(r.bom_version || '')})`,
      currency: company.currency || 'AED',
      items: cons.map((c) => {
        const q = Number(c.actual_qty || c.planned_qty || 0);
        const uc = Number(c.unit_cost || 0);
        return {
          item_code: String(c.item_code || ''),
          description: `${String(c.item_name || '')} (${String(c.component_type || '')}${c.tank_code ? ` · Tank ${String(c.tank_code)}` : ''})`,
          qty: q,
          uom: String(c.uom || ''),
          unit_price: uc,
          vat_pct: 0,
          vat_amount: 0,
          total: Number(c.total_cost || q * uc),
        };
      }),
      netTotal: matCost,
      vatTotal: laborOh,
      grandTotal: totalCost,
      remarks: `Planned: ${String(r.planned_qty)} ${String(r.uom || '')} · Completed: ${String(r.completed_qty || 0)} · ${String(r.remarks || '')}`,
      preparedBy: String(r.creator_name || ''),
      creatorName: String(r.creator_name || ''),
    });
  };

  const bomCols: ColumnDef<Record<string, unknown>>[] = [
    { key: 'bom_number', header: 'BOM #' },
    { key: 'version', header: 'Version' },
    { key: 'finished_item_code', header: 'SKU' },
    { key: 'finished_item_name', header: 'Finished Lubricant' },
    { key: 'batch_size', header: 'Batch Size', numeric: true, render: (r) => `${r.batch_size} ${r.uom}` },
    { key: 'material_cost', header: 'Material Cost', numeric: true, render: (r) => Number(r.material_cost || 0).toFixed(2) },
    { key: 'total_batch_cost', header: 'Total Cost', numeric: true, render: (r) => Number(r.total_batch_cost || 0).toFixed(2) },
    { key: 'unit_standard_cost', header: 'Unit Std Cost', numeric: true, render: (r) => Number(r.unit_standard_cost || 0).toFixed(2) },
    {
      key: 'actions',
      header: 'Actions',
      render: (r) => (
        <div className="flex items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
          <button
            type="button"
            onClick={() => {
              setScaleBom(r);
              setScaleTargetQty(String(Number(r.batch_size || 1000) * 2));
              void runBomScaling(Number(r.id), Number(r.batch_size || 1000) * 2);
            }}
            className="inline-flex items-center gap-1 px-2 py-1 text-xs font-medium text-slate-700 border border-slate-300 rounded hover:bg-slate-50"
          >
            <Calculator className="w-3 h-3" /> Scale Formula
          </button>
          <button
            type="button"
            onClick={() => printBomPdf(r)}
            className="p-1 text-slate-600 hover:text-slate-900"
            title="Download BOM PDF"
          >
            <FileText className="w-3.5 h-3.5" />
          </button>
        </div>
      ),
    },
  ];

  const prodCols: ColumnDef<Record<string, unknown>>[] = [
    { key: 'prod_number', header: 'Production #' },
    { key: 'finished_item_name', header: 'Finished Lubricant' },
    { key: 'bom_number', header: 'BOM' },
    { key: 'planned_qty', header: 'Planned', numeric: true },
    { key: 'completed_qty', header: 'Completed', numeric: true },
    { key: 'unit_actual_cost', header: 'Actual Unit Cost', numeric: true, render: (r) => Number(r.unit_actual_cost || 0).toFixed(2) },
    { key: 'scheduled_date', header: 'Date' },
    { key: 'status', header: 'Status' },
    {
      key: 'actions',
      header: 'Actions',
      render: (r) => (
        <div className="flex items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
          {r.status !== 'Completed' && (
            <button
              type="button"
              onClick={() => openCompleteModal(r)}
              className="inline-flex items-center gap-1 px-2 py-1 text-xs font-medium bg-emerald-700 text-white rounded hover:bg-emerald-800"
            >
              <CheckCircle2 className="w-3 h-3" /> Complete & Cost
            </button>
          )}
          <button
            type="button"
            onClick={() => printProdPdf(r)}
            className="p-1 text-slate-600 hover:text-slate-900"
            title="Download Production Order PDF"
          >
            <FileText className="w-3.5 h-3.5" />
          </button>
          <button
            type="button"
            onClick={() => setPanelDoc({ docType: 'ProductionOrder', docId: Number(r.id), docNumber: String(r.prod_number) })}
            className="px-2 py-1 text-xs border border-slate-300 rounded hover:bg-slate-50"
          >
            Links
          </button>
        </div>
      ),
    },
  ];

  const blendFillRows = orders.flatMap((o) => {
    const blends = (o.blends as Record<string, unknown>[]) || [];
    const fillings = (o.fillings as Record<string, unknown>[]) || [];
    return blends.map((bl, idx) => ({
      id: `${o.id}-${bl.id}`,
      prod_number: o.prod_number,
      finished_item_name: o.finished_item_name,
      blend_number: bl.blend_number,
      equipment_name: bl.equipment_name,
      operator_name: bl.operator_name,
      fill_number: fillings[idx]?.fill_number || '-',
      calculated_cartons: fillings[idx]?.calculated_cartons || 0,
      planned_qty: bl.planned_qty,
      actual_qty: bl.actual_qty || 0,
      quality_status: bl.quality_status,
      status: bl.status,
    }));
  });

  const previewDraftBomPdf = () => {
    const fgItem = items.find((i) => i.id === bomForm.finished_item_id);
    const mapped = bomLines
      .filter((l) => l.item_id > 0)
      .map((l) => {
        const it = items.find((i) => i.id === l.item_id);
        const rate = Number(it?.average_cost || it?.standard_cost || 0);
        return {
          item_code: it?.item_code || '',
          description: `${it?.name || ''} [${l.component_type}]`,
          qty: Number(l.qty || 0),
          uom: it?.stock_uom || 'LTR',
          unit_price: rate,
          vat_pct: Number(l.wastage_pct || 0),
          vat_amount: 0,
          total: Number(l.qty || 0) * rate,
        };
      });
    const matCost = mapped.reduce((s, m) => s + m.total, 0);
    const labOh = Number(bomForm.labour_cost || 0) + Number(bomForm.overhead_cost || 0);
    void exportStandardErpPdf({
      docTitle: 'BILL OF MATERIALS',
      docNumberLabel: 'BOM No.',
      docNumber: 'MFG-BOM (DRAFT PREVIEW)',
      docDate: new Date().toISOString().slice(0, 10),
      company,
      logoUrl,
      companyRole: 'Seller',
      partyRole: 'Buyer',
      partyName: fgItem ? `${fgItem.item_code} — ${fgItem.name}` : 'Select Finished SKU',
      partyRefLabel: 'Batch Size',
      partyRefNo: `${bomForm.batch_size} ${fgItem?.stock_uom || 'LTR'}`,
      revisionNo: bomForm.version || 'v1.0',
      currency: company.currency || 'AED',
      items: mapped,
      netTotal: matCost,
      vatTotal: labOh,
      grandTotal: matCost + labOh,
      remarks: bomForm.notes || `Expected Wastage: ${bomForm.expected_wastage_pct}%`,
      filename: 'bom_draft_preview',
    });
  };

  const previewDraftProdPdf = () => {
    const selBom = boms.find((b) => Number(b.id) === Number(prodForm.bom_id));
    const bomBatch = Number(selBom?.batch_size || 1000) || 1000;
    const planned = Number(prodForm.planned_qty || 0);
    const scale = planned / bomBatch;
    const bomItems = (selBom?.items as Record<string, unknown>[]) || [];
    const mapped = bomItems.map((l) => {
      const q = Number(l.qty || 0) * scale;
      const rate = Number(l.standard_cost || 0);
      return {
        item_code: String(l.item_code || ''),
        description: `${String(l.item_name || '')} (${String(l.component_type || 'Formula')})`,
        qty: Number(q.toFixed(2)),
        uom: String(l.uom || 'LTR'),
        unit_price: rate,
        vat_pct: 0,
        vat_amount: 0,
        total: q * rate,
      };
    });
    const matCost = mapped.reduce((s, m) => s + m.total, 0);
    const labOh = (Number(selBom?.labour_cost || 0) + Number(selBom?.overhead_cost || 0)) * scale;
    const srcWh = warehouses.find((w) => w.id === Number(prodForm.warehouse_id))?.name || '';
    const dstWh = warehouses.find((w) => w.id === Number(prodForm.target_warehouse_id))?.name || '';
    void exportStandardErpPdf({
      docTitle: 'PRODUCTION ORDER',
      docNumberLabel: 'Prod. No.',
      docNumber: 'MFG-WO (DRAFT PREVIEW)',
      docDate: new Date().toISOString().slice(0, 10),
      company,
      logoUrl,
      companyRole: 'Seller',
      partyRole: 'Buyer',
      partyName: selBom ? `${String(selBom.finished_item_code || '')} — ${String(selBom.finished_item_name || '')}` : 'Production Order',
      deliveryTerms: prodForm.production_line,
      deliveryPlace: `${srcWh} -> ${dstWh}`,
      partyRefLabel: 'BOM Ref.',
      partyRefNo: selBom ? `${String(selBom.bom_number)} (${String(selBom.version)})` : '-',
      currency: company.currency || 'AED',
      items: mapped,
      netTotal: matCost,
      vatTotal: labOh,
      grandTotal: matCost + labOh,
      remarks: `Planned Qty: ${planned} · Kettle: ${prodForm.equipment_name} · ${prodForm.remarks}`,
      filename: 'production_order_draft_preview',
    });
  };

  const handleDownloadBomExcel = () => {
    const exportRows = bomLines
      .filter((l) => l.item_id > 0)
      .map((l) => {
        const it = items.find((i) => i.id === l.item_id);
        return {
          item_code: it?.item_code || '',
          item_name: it?.name || '',
          qty: l.qty,
          uom: it?.stock_uom || 'LTR',
          rate: Number(it?.average_cost || it?.standard_cost || 0),
          vat_rate: l.wastage_pct,
        };
      });
    downloadLineItemsExcelTemplate('bom_components_template', exportRows);
  };

  const handleUploadBomExcel = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    try {
      const parsed = await parseLineItemsExcelFile(file);
      const mapped: BomLineDraft[] = [];
      let skipped = 0;
      for (const row of parsed) {
        const it = items.find((x) => x.item_code.toUpperCase() === row.item_code.toUpperCase());
        if (!it) {
          skipped++;
          continue;
        }
        mapped.push({
          item_id: it.id,
          component_type: it.stock_uom === 'PCS' || it.stock_uom === 'CTN' ? 'Packaging' : 'Formula',
          qty: row.qty,
          wastage_pct: row.vat_rate ?? 0,
          carton_packing_qty: 0,
        });
      }
      if (mapped.length > 0) {
        setBomLines(mapped);
        setBomGridMsg(`Loaded ${mapped.length} component line(s) from Excel${skipped > 0 ? ` (${skipped} unmatched codes skipped)` : ''}.`);
      } else {
        setBomGridMsg('No matching Item Codes found in uploaded Excel.');
      }
    } catch (ex: unknown) {
      setBomGridMsg(ex instanceof Error ? ex.message : 'Failed to parse Excel');
    }
  };

  if (showBomModal) {
    const matCost = bomLines.reduce((sum, l) => {
      const it = items.find((i) => i.id === l.item_id);
      return sum + Number(l.qty || 0) * Number(it?.average_cost || it?.standard_cost || 0);
    }, 0);
    const totalBatchCost = matCost + Number(bomForm.labour_cost || 0) + Number(bomForm.overhead_cost || 0);
    const batchQty = Number(bomForm.batch_size || 0);
    const unitStdCost = batchQty > 0 ? totalBatchCost / batchQty : 0;

    return (
      <div className="space-y-4">
        {err && <div className="p-3 bg-red-50 border border-red-200 rounded text-xs text-red-700">{err}</div>}
        <form onSubmit={createBom} className="bg-white border border-slate-200 rounded-lg overflow-hidden shadow-xs">
          <div className="px-5 py-3 border-b border-slate-200 bg-white flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <button type="button" onClick={() => setShowBomModal(false)} className="p-1.5 text-slate-500 hover:text-slate-900 rounded hover:bg-slate-100" title="Back to list">
                <ArrowLeft className="w-4 h-4" />
              </button>
              <h2 className="text-base font-semibold text-slate-900">New Bill of Materials (Lubricant BOM)</h2>
              <span className="text-[11px] font-medium text-amber-700 bg-amber-50 border border-amber-200 px-2 py-0.5 rounded">Not Saved</span>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <button type="button" onClick={() => setShowImportModal(true)} className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium text-slate-700 bg-slate-50 border border-slate-300 rounded-md hover:bg-slate-100">
                <FileSpreadsheet className="w-3.5 h-3.5 text-emerald-700" /> Bulk Import BOMs
              </button>
              <button type="button" onClick={previewDraftBomPdf} className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded-md hover:bg-slate-50">
                <Printer className="w-3.5 h-3.5" /> Print Preview
              </button>
              <button type="button" onClick={() => setShowBomModal(false)} className="px-3 py-1.5 text-xs font-medium text-slate-600 border border-slate-300 rounded-md hover:bg-slate-50">Cancel</button>
              <button type="submit" className="inline-flex items-center gap-1.5 px-4 py-1.5 text-xs font-medium bg-slate-900 text-white rounded-md hover:bg-slate-800">
                <Save className="w-3.5 h-3.5" /> Save & Approve BOM
              </button>
            </div>
          </div>

          <div className="px-5 border-b border-slate-200 flex items-center gap-6 text-xs bg-white">
            {[
              { id: 'details', label: 'Details' },
              { id: 'more', label: 'More Info' },
            ].map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => setBomTab(t.id as 'details' | 'more')}
                className={`py-2.5 border-b-2 transition-colors whitespace-nowrap ${
                  bomTab === t.id ? 'border-slate-900 text-slate-900 font-semibold' : 'border-transparent text-slate-500 hover:text-slate-800'
                }`}
              >
                {t.label}
              </button>
            ))}
          </div>

          <div className="p-5 space-y-5 text-xs">
            {bomTab === 'details' ? (
              <>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                  <div>
                    <label className="block text-[11px] font-medium text-slate-600 mb-1">Series <span className="text-red-600">*</span></label>
                    <input readOnly value="MFG-BOM-.YYYY.-" className="w-full px-3 py-1.5 bg-slate-100 border border-slate-200 rounded text-slate-700 font-mono" />
                  </div>
                  <div>
                    <label className="block text-[11px] font-medium text-slate-600 mb-1">Company <span className="text-red-600">*</span></label>
                    <input readOnly value={company.name || 'Company Name'} className="w-full px-3 py-1.5 bg-slate-100 border border-slate-200 rounded text-slate-800 font-medium" />
                  </div>
                  <div>
                    <label className="block text-[11px] font-medium text-slate-600 mb-1">Version <span className="text-red-600">*</span></label>
                    <input value={bomForm.version} onChange={(e) => setBomForm({ ...bomForm, version: e.target.value })} className="w-full px-3 py-1.5 bg-slate-50 border border-slate-200 rounded font-mono" />
                  </div>
                  <div className="md:col-span-2">
                    <label className="block text-[11px] font-medium text-slate-600 mb-1">Finished Lubricant SKU <span className="text-red-600">*</span></label>
                    <SearchableSelect options={itemOptions} value={bomForm.finished_item_id} onChange={(v) => setBomForm({ ...bomForm, finished_item_id: Number(v) })} placeholder="Select finished SKU..." />
                  </div>
                  <div>
                    <label className="block text-[11px] font-medium text-slate-600 mb-1">Standard Batch Size <span className="text-red-600">*</span></label>
                    <input type="number" step="0.01" value={bomForm.batch_size} onChange={(e) => setBomForm({ ...bomForm, batch_size: e.target.value })} className="w-full px-3 py-1.5 bg-slate-50 border border-slate-200 rounded font-mono tabular-nums" />
                  </div>
                  <div>
                    <label className="block text-[11px] font-medium text-slate-600 mb-1">Labour Cost ({company.currency || 'AED'})</label>
                    <input type="number" step="0.01" value={bomForm.labour_cost} onChange={(e) => setBomForm({ ...bomForm, labour_cost: e.target.value })} className="w-full px-3 py-1.5 bg-slate-50 border border-slate-200 rounded font-mono tabular-nums" />
                  </div>
                  <div>
                    <label className="block text-[11px] font-medium text-slate-600 mb-1">Overhead Cost ({company.currency || 'AED'})</label>
                    <input type="number" step="0.01" value={bomForm.overhead_cost} onChange={(e) => setBomForm({ ...bomForm, overhead_cost: e.target.value })} className="w-full px-3 py-1.5 bg-slate-50 border border-slate-200 rounded font-mono tabular-nums" />
                  </div>
                  <div>
                    <label className="block text-[11px] font-medium text-slate-600 mb-1">Expected Wastage %</label>
                    <input type="number" step="0.1" value={bomForm.expected_wastage_pct} onChange={(e) => setBomForm({ ...bomForm, expected_wastage_pct: e.target.value })} className="w-full px-3 py-1.5 bg-slate-50 border border-slate-200 rounded font-mono tabular-nums" />
                  </div>
                </div>

                {bomGridMsg && <div className="px-3 py-2 bg-slate-50 border border-slate-200 rounded text-[11px] text-slate-700">{bomGridMsg}</div>}

                <div className="space-y-2 border-t border-slate-200 pt-4">
                  <span className="text-[11px] font-medium text-slate-600 block">Formula & Packaging Components</span>
                  <div className="border border-slate-200 rounded-md overflow-x-auto">
                    <table className="w-full text-left border-collapse text-xs">
                      <thead>
                        <tr className="bg-slate-50 border-b border-slate-200 text-[11px] font-medium text-slate-600">
                          <th className="w-10 px-2 py-2 text-center border-r border-slate-200">No.</th>
                          <th className="min-w-[240px] px-2.5 py-2 border-r border-slate-200">Component Item <span className="text-red-600">*</span></th>
                          <th className="w-32 px-2.5 py-2 border-r border-slate-200">Type</th>
                          <th className="w-28 px-2.5 py-2 text-right border-r border-slate-200">Quantity</th>
                          <th className="w-28 px-2.5 py-2 text-right border-r border-slate-200">Units/Carton</th>
                          <th className="w-28 px-2.5 py-2 text-right border-r border-slate-200">Est. Cost</th>
                          <th className="w-12 px-2 py-2 text-center">Del</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-200">
                        {bomLines.map((line, idx) => {
                          const it = items.find((i) => i.id === line.item_id);
                          const estLineCost = Number(line.qty || 0) * Number(it?.average_cost || it?.standard_cost || 0);
                          return (
                            <tr key={idx}>
                              <td className="px-2 py-1.5 text-center text-slate-500 font-mono border-r border-slate-200">{idx + 1}</td>
                              <td className="px-2 py-1 border-r border-slate-200">
                                <SearchableSelect
                                  options={itemOptions}
                                  value={line.item_id}
                                  onChange={(v) => {
                                    const copy = [...bomLines];
                                    copy[idx].item_id = Number(v);
                                    setBomLines(copy);
                                  }}
                                  placeholder="Select base oil, additive, or bottle..."
                                />
                              </td>
                              <td className="px-2 py-1 border-r border-slate-200">
                                <select
                                  value={line.component_type}
                                  onChange={(e) => {
                                    const copy = [...bomLines];
                                    copy[idx].component_type = e.target.value as 'Formula' | 'Packaging';
                                    setBomLines(copy);
                                  }}
                                  className="w-full px-2 py-1 border border-slate-200 rounded"
                                >
                                  <option value="Formula">Formula</option>
                                  <option value="Packaging">Packaging</option>
                                </select>
                              </td>
                              <td className="px-2 py-1 border-r border-slate-200">
                                <input
                                  type="number"
                                  step="0.01"
                                  value={line.qty}
                                  onChange={(e) => {
                                    const copy = [...bomLines];
                                    copy[idx].qty = Number(e.target.value);
                                    setBomLines(copy);
                                  }}
                                  className="w-full text-right px-2 py-1 border border-transparent focus:border-slate-300 rounded font-mono tabular-nums"
                                />
                              </td>
                              <td className="px-2 py-1 border-r border-slate-200">
                                <input
                                  type="number"
                                  value={line.carton_packing_qty}
                                  onChange={(e) => {
                                    const copy = [...bomLines];
                                    copy[idx].carton_packing_qty = Number(e.target.value);
                                    setBomLines(copy);
                                  }}
                                  title="If > 0, cartons = ceil(target_qty / packing_qty)"
                                  className="w-full text-right px-2 py-1 border border-transparent focus:border-slate-300 rounded font-mono tabular-nums"
                                />
                              </td>
                              <td className="px-2.5 py-1.5 text-right font-mono tabular-nums text-slate-800 border-r border-slate-200">
                                {estLineCost.toFixed(2)}
                              </td>
                              <td className="px-2 py-1.5 text-center">
                                <button type="button" onClick={() => setBomLines(bomLines.filter((_, i) => i !== idx))} className="p-1 text-slate-400 hover:text-red-600">
                                  <Trash2 className="w-3.5 h-3.5" />
                                </button>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>

                  <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
                    <button
                      type="button"
                      onClick={() => setBomLines([...bomLines, { item_id: 0, component_type: 'Formula', qty: 100, wastage_pct: 0, carton_packing_qty: 0 }])}
                      className="px-2.5 py-1 text-[11px] font-medium bg-slate-100 hover:bg-slate-200 text-slate-800 rounded border border-slate-200"
                    >
                      Add Row
                    </button>
                    <div className="flex items-center gap-2">
                      <button type="button" onClick={handleDownloadBomExcel} className="inline-flex items-center gap-1 px-2.5 py-1 text-[11px] font-medium bg-slate-100 hover:bg-slate-200 text-slate-800 rounded border border-slate-200">
                        <Download className="w-3 h-3" /> Download
                      </button>
                      <button type="button" onClick={() => bomExcelRef.current?.click()} className="inline-flex items-center gap-1 px-2.5 py-1 text-[11px] font-medium bg-slate-100 hover:bg-slate-200 text-slate-800 rounded border border-slate-200">
                        <Upload className="w-3 h-3" /> Upload
                      </button>
                      <input ref={bomExcelRef} type="file" accept=".xlsx,.xls,.csv" onChange={(e) => void handleUploadBomExcel(e)} className="hidden" />
                    </div>
                  </div>
                </div>

                <div className="border-t border-slate-200 pt-4 grid grid-cols-1 md:grid-cols-2 gap-6 items-start">
                  <div>
                    <h4 className="text-xs font-semibold text-slate-800 mb-2">Batch Cost Summary</h4>
                    <div className="grid grid-cols-2 gap-3 text-[11px]">
                      <div>
                        <span className="text-slate-500 block">Material Cost</span>
                        <input readOnly value={matCost.toFixed(2)} className="w-full px-3 py-1.5 bg-slate-100 border border-slate-200 rounded font-mono tabular-nums" />
                      </div>
                      <div>
                        <span className="text-slate-500 block">Unit Std Cost</span>
                        <input readOnly value={unitStdCost.toFixed(4)} className="w-full px-3 py-1.5 bg-slate-100 border border-slate-200 rounded font-mono tabular-nums" />
                      </div>
                    </div>
                  </div>
                  <div className="space-y-2">
                    <h4 className="text-xs font-semibold text-slate-800">Totals</h4>
                    <div>
                      <label className="block text-[11px] text-slate-600 mb-1">Total Batch Cost ({company.currency || 'AED'})</label>
                      <input readOnly value={totalBatchCost.toFixed(2)} className="w-full px-3 py-2 bg-slate-100 border border-slate-200 rounded font-mono font-semibold text-slate-900 tabular-nums" />
                    </div>
                  </div>
                </div>
              </>
            ) : (
              <div className="grid grid-cols-1 gap-4">
                <div>
                  <label className="block text-[11px] font-medium text-slate-600 mb-1">Formulation Notes & Quality Specification</label>
                  <textarea rows={4} value={bomForm.notes} onChange={(e) => setBomForm({ ...bomForm, notes: e.target.value })} placeholder="API SP / ACEA C3 / Kinematic Viscosity @ 100°C spec" className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded" />
                </div>
              </div>
            )}
          </div>
        </form>
        <ExcelImportModal
          open={showImportModal}
          initialType="boms"
          onClose={() => setShowImportModal(false)}
          onImported={(m) => {
            setMsg(m);
            setShowBomModal(false);
            void loadAll();
          }}
        />
      </div>
    );
  }

  if (showProdModal) {
    const selBom = boms.find((b) => Number(b.id) === Number(prodForm.bom_id));
    const bomBatch = Number(selBom?.batch_size || 1000) || 1000;
    const scale = Number(prodForm.planned_qty || 0) / bomBatch;
    const previewComponents = (selBom?.items as Record<string, unknown>[]) || [];

    return (
      <div className="space-y-4">
        {err && <div className="p-3 bg-red-50 border border-red-200 rounded text-xs text-red-700">{err}</div>}
        <form onSubmit={createProductionOrder} className="bg-white border border-slate-200 rounded-lg overflow-hidden shadow-xs">
          <div className="px-5 py-3 border-b border-slate-200 bg-white flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <button type="button" onClick={() => setShowProdModal(false)} className="p-1.5 text-slate-500 hover:text-slate-900 rounded hover:bg-slate-100" title="Back to list">
                <ArrowLeft className="w-4 h-4" />
              </button>
              <h2 className="text-base font-semibold text-slate-900">New Production, Blending & Filling Order</h2>
              <span className="text-[11px] font-medium text-amber-700 bg-amber-50 border border-amber-200 px-2 py-0.5 rounded">Not Saved</span>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <button type="button" onClick={previewDraftProdPdf} className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded-md hover:bg-slate-50">
                <Printer className="w-3.5 h-3.5" /> Print Preview
              </button>
              <button type="button" onClick={() => setShowProdModal(false)} className="px-3 py-1.5 text-xs font-medium text-slate-600 border border-slate-300 rounded-md hover:bg-slate-50">Cancel</button>
              <button type="submit" className="inline-flex items-center gap-1.5 px-4 py-1.5 text-xs font-medium bg-slate-900 text-white rounded-md hover:bg-slate-800">
                <Save className="w-3.5 h-3.5" /> Create & Schedule
              </button>
            </div>
          </div>

          <div className="px-5 border-b border-slate-200 flex items-center gap-6 text-xs bg-white">
            {[
              { id: 'details', label: 'Details' },
              { id: 'more', label: 'More Info' },
            ].map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => setProdTab(t.id as 'details' | 'more')}
                className={`py-2.5 border-b-2 transition-colors whitespace-nowrap ${
                  prodTab === t.id ? 'border-slate-900 text-slate-900 font-semibold' : 'border-transparent text-slate-500 hover:text-slate-800'
                }`}
              >
                {t.label}
              </button>
            ))}
          </div>

          <div className="p-5 space-y-5 text-xs">
            {prodTab === 'details' ? (
              <>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                  <div>
                    <label className="block text-[11px] font-medium text-slate-600 mb-1">Series <span className="text-red-600">*</span></label>
                    <input readOnly value="MFG-WO-.YYYY.-" className="w-full px-3 py-1.5 bg-slate-100 border border-slate-200 rounded text-slate-700 font-mono" />
                  </div>
                  <div>
                    <label className="block text-[11px] font-medium text-slate-600 mb-1">Company <span className="text-red-600">*</span></label>
                    <input readOnly value={company.name || 'Company Name'} className="w-full px-3 py-1.5 bg-slate-100 border border-slate-200 rounded text-slate-800 font-medium" />
                  </div>
                  <div>
                    <label className="block text-[11px] font-medium text-slate-600 mb-1">Approved BOM <span className="text-red-600">*</span></label>
                    <select value={prodForm.bom_id} onChange={(e) => setProdForm({ ...prodForm, bom_id: Number(e.target.value) })} className="w-full px-3 py-1.5 bg-slate-50 border border-slate-200 rounded">
                      {boms.map((b) => (
                        <option key={String(b.id)} value={String(b.id)}>
                          {String(b.bom_number)} ({String(b.version)}) — {String(b.finished_item_name)}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="block text-[11px] font-medium text-slate-600 mb-1">Planned Batch Qty <span className="text-red-600">*</span></label>
                    <input type="number" step="0.01" required value={prodForm.planned_qty} onChange={(e) => setProdForm({ ...prodForm, planned_qty: e.target.value })} className="w-full px-3 py-1.5 bg-slate-50 border border-slate-200 rounded font-mono tabular-nums" />
                  </div>
                  <div>
                    <label className="block text-[11px] font-medium text-slate-600 mb-1">Raw Material Warehouse</label>
                    <select value={prodForm.warehouse_id} onChange={(e) => setProdForm({ ...prodForm, warehouse_id: Number(e.target.value) })} className="w-full px-3 py-1.5 bg-slate-50 border border-slate-200 rounded">
                      {warehouses.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
                    </select>
                  </div>
                  <div>
                    <label className="block text-[11px] font-medium text-slate-600 mb-1">Finished Goods Warehouse</label>
                    <select value={prodForm.target_warehouse_id} onChange={(e) => setProdForm({ ...prodForm, target_warehouse_id: Number(e.target.value) })} className="w-full px-3 py-1.5 bg-slate-50 border border-slate-200 rounded">
                      {warehouses.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
                    </select>
                  </div>
                  <div>
                    <label className="block text-[11px] font-medium text-slate-600 mb-1">Kettle / Equipment</label>
                    <input value={prodForm.equipment_name} onChange={(e) => setProdForm({ ...prodForm, equipment_name: e.target.value })} className="w-full px-3 py-1.5 bg-slate-50 border border-slate-200 rounded" />
                  </div>
                  <div>
                    <label className="block text-[11px] font-medium text-slate-600 mb-1">Production Line</label>
                    <input value={prodForm.production_line} onChange={(e) => setProdForm({ ...prodForm, production_line: e.target.value })} className="w-full px-3 py-1.5 bg-slate-50 border border-slate-200 rounded" />
                  </div>
                  <div>
                    <label className="block text-[11px] font-medium text-slate-600 mb-1">Carton Packing (Units/Carton)</label>
                    <input type="number" value={prodForm.carton_packing_qty} onChange={(e) => setProdForm({ ...prodForm, carton_packing_qty: e.target.value })} className="w-full px-3 py-1.5 bg-slate-50 border border-slate-200 rounded font-mono tabular-nums" />
                  </div>
                </div>

                {previewComponents.length > 0 && (
                  <div className="space-y-2 border-t border-slate-200 pt-4">
                    <span className="text-[11px] font-medium text-slate-600 block">Scaled Formula & Packaging Plan (for {prodForm.planned_qty} {String(selBom?.uom || 'LTR')})</span>
                    <div className="border border-slate-200 rounded-md overflow-x-auto">
                      <table className="w-full text-left border-collapse text-xs">
                        <thead>
                          <tr className="bg-slate-50 border-b border-slate-200 text-[11px] font-medium text-slate-600">
                            <th className="w-10 px-2 py-2 text-center border-r border-slate-200">No.</th>
                            <th className="px-2.5 py-2 border-r border-slate-200">Item Code</th>
                            <th className="px-2.5 py-2 border-r border-slate-200">Component</th>
                            <th className="px-2.5 py-2 border-r border-slate-200">Type</th>
                            <th className="px-2.5 py-2 text-right border-r border-slate-200">Required Qty</th>
                            <th className="px-2.5 py-2 text-center">UOM</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-200">
                          {previewComponents.map((c, idx) => (
                            <tr key={idx}>
                              <td className="px-2 py-1.5 text-center font-mono text-slate-500 border-r border-slate-200">{idx + 1}</td>
                              <td className="px-2.5 py-1.5 font-mono border-r border-slate-200">{String(c.item_code || '')}</td>
                              <td className="px-2.5 py-1.5 border-r border-slate-200">{String(c.item_name || '')}</td>
                              <td className="px-2.5 py-1.5 border-r border-slate-200">{String(c.component_type || 'Formula')}</td>
                              <td className="px-2.5 py-1.5 text-right font-mono tabular-nums border-r border-slate-200">{(Number(c.qty || 0) * scale).toFixed(2)}</td>
                              <td className="px-2.5 py-1.5 text-center">{String(c.uom || 'LTR')}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}
              </>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label className="block text-[11px] font-medium text-slate-600 mb-1">Lead Operator Name</label>
                  <input value={prodForm.operator_name} onChange={(e) => setProdForm({ ...prodForm, operator_name: e.target.value })} placeholder="Shift Blending Operator" className="w-full px-3 py-1.5 bg-slate-50 border border-slate-200 rounded" />
                </div>
                <div>
                  <label className="block text-[11px] font-medium text-slate-600 mb-1">Batch Remarks</label>
                  <input value={prodForm.remarks} onChange={(e) => setProdForm({ ...prodForm, remarks: e.target.value })} placeholder="Blending temperature / QC instructions" className="w-full px-3 py-1.5 bg-slate-50 border border-slate-200 rounded" />
                </div>
              </div>
            )}
          </div>
        </form>
      </div>
    );
  }

  if (viewingDoc) {
    const activeList = viewingDoc.type === 'bom' ? boms : orders;
    const idx = activeList.findIndex((x) => Number(x.id) === viewingDoc.id);
    const rec = idx >= 0 ? activeList[idx] : undefined;

    if (rec) {
      if (viewingDoc.type === 'bom') {
        const bomItems = (rec.items as Record<string, unknown>[]) || [];
        const viewerItems: ErpViewerItemLine[] = bomItems.map((l) => {
          const q = Number(l.qty || 0);
          const c = Number(l.standard_cost || 0);
          return {
            item_code: String(l.item_code || ''),
            description: String(l.item_name || ''),
            uom: String(l.uom || 'LTR'),
            qty: q,
            rate: c,
            vat_rate: Number(l.wastage_pct || 0),
            line_total: q * c,
            extra_badge: String(l.component_type || 'Formula'),
          };
        });
        const actions: ErpViewerAction[] = [
          {
            label: 'Create Production Order',
            variant: 'primary',
            onClick: () => {
              setProdForm((f) => ({ ...f, bom_id: Number(rec.id), planned_qty: String(rec.batch_size || 1000) }));
              setViewingDoc(null);
              setShowProdModal(true);
            },
          },
          {
            label: 'Scale Formula',
            variant: 'secondary',
            onClick: () => {
              setScaleBom(rec);
              setScaleTargetQty(String(Number(rec.batch_size || 1000) * 2));
              void runBomScaling(Number(rec.id), Number(rec.batch_size || 1000) * 2);
              setViewingDoc(null);
              setTab('boms');
            },
          },
        ];

        return (
          <div className="space-y-4">
            <ErpDocumentViewer
              docType="BOM"
              docId={Number(rec.id)}
              docNumber={String(rec.bom_number || '')}
              title={`${String(rec.finished_item_code || '')} — ${String(rec.finished_item_name || '')}`}
              status={rec.is_approved ? 'Approved' : 'Draft'}
              docDate={String(rec.effective_date || String(rec.created_at || '').slice(0, 10))}
              companyRole="Seller"
              partyLabel="Finished Lubricant SKU"
              partyName={`${String(rec.finished_item_code || '')} — ${String(rec.finished_item_name || '')}`}
              refLabel="Batch Size"
              refNo={`${String(rec.batch_size || 0)} ${String(rec.uom || '')}`}
              revisionNo={String(rec.version || 'v1.0')}
              currency={company.currency || 'AED'}
              remarks={String(rec.notes || `Std Unit Cost: ${Number(rec.unit_standard_cost || 0).toFixed(2)}`)}
              createdAt={String(rec.created_at || '')}
              subtotal={Number(rec.material_cost || 0)}
              vatAmount={Number(rec.labour_cost || 0) + Number(rec.overhead_cost || 0)}
              totalAmount={Number(rec.total_batch_cost || 0)}
              items={viewerItems}
              createActions={actions}
              onBack={() => setViewingDoc(null)}
              hasPrev={idx > 0}
              hasNext={idx >= 0 && idx < activeList.length - 1}
              onPrev={() => {
                if (idx > 0) setViewingDoc({ type: 'bom', id: Number(activeList[idx - 1].id) });
              }}
              onNext={() => {
                if (idx < activeList.length - 1) setViewingDoc({ type: 'bom', id: Number(activeList[idx + 1].id) });
              }}
              onPrintPreview={() => printBomPdf(rec)}
              onNavigateLink={(link) => {
                if (link.docType === 'ProductionOrder') {
                  setTab('production');
                  setViewingDoc({ type: 'prod', id: link.id });
                }
              }}
            />
          </div>
        );
      }

      const cons = (rec.consumptions as Record<string, unknown>[]) || [];
      const matCost = cons.reduce((s, c) => s + Number(c.total_cost || 0), 0);
      const laborOh = Number(rec.actual_labour_cost || 0) + Number(rec.actual_overhead_cost || 0);
      const totalCost = Number(rec.total_actual_cost || matCost + laborOh);
      const viewerItems: ErpViewerItemLine[] = cons.map((c) => {
        const q = Number(c.actual_qty || c.planned_qty || 0);
        const uc = Number(c.unit_cost || 0);
        return {
          item_code: String(c.item_code || ''),
          description: String(c.item_name || ''),
          uom: String(c.uom || 'LTR'),
          qty: q,
          rate: uc,
          vat_rate: 0,
          line_total: Number(c.total_cost || q * uc),
          tank_code: c.tank_code ? String(c.tank_code) : undefined,
          batch_number: c.batch_number ? String(c.batch_number) : undefined,
          extra_badge: String(c.component_type || 'Formula'),
        };
      });

      const actions: ErpViewerAction[] = [];
      if (rec.status !== 'Completed') {
        actions.push({
          label: 'Complete & Cost Batch',
          variant: 'emerald',
          onClick: () => {
            openCompleteModal(rec);
            setViewingDoc(null);
            setTab('production');
          },
        });
      }

      return (
        <div className="space-y-4">
          <ErpDocumentViewer
            docType="ProductionOrder"
            docId={Number(rec.id)}
            docNumber={String(rec.prod_number || '')}
            title={`${String(rec.item_code || '')} — ${String(rec.finished_item_name || '')}`}
            status={String(rec.status || '')}
            docDate={String(rec.scheduled_date || '')}
            companyRole="Seller"
            partyLabel="Finished Lubricant"
            partyName={`${String(rec.item_code || '')} — ${String(rec.finished_item_name || '')}`}
            warehouseName={`${String(rec.source_warehouse_name || '')} -> ${String(rec.target_warehouse_name || '')}`}
            warehouseLabel="RM -> FG Warehouses"
            refLabel="BOM Reference"
            refNo={`${String(rec.bom_number || '')} (${String(rec.bom_version || '')})`}
            deliveryTerms={String(rec.production_line || '')}
            currency={company.currency || 'AED'}
            remarks={`Planned: ${String(rec.planned_qty)} ${String(rec.uom || '')} · Completed: ${String(rec.completed_qty || 0)} · ${String(rec.remarks || '')}`}
            creatorName={String(rec.creator_name || '')}
            createdAt={String(rec.created_at || '')}
            subtotal={matCost}
            vatAmount={laborOh}
            totalAmount={totalCost}
            items={viewerItems}
            showTankCol={true}
            showBatchCol={true}
            createActions={actions}
            onBack={() => setViewingDoc(null)}
            hasPrev={idx > 0}
            hasNext={idx >= 0 && idx < activeList.length - 1}
            onPrev={() => {
              if (idx > 0) setViewingDoc({ type: 'prod', id: Number(activeList[idx - 1].id) });
            }}
            onNext={() => {
              if (idx < activeList.length - 1) setViewingDoc({ type: 'prod', id: Number(activeList[idx + 1].id) });
            }}
            onPrintPreview={() => printProdPdf(rec)}
            onNavigateLink={(link) => {
              if (link.docType === 'BOM') {
                setTab('boms');
                setViewingDoc({ type: 'bom', id: link.id });
              }
            }}
          />
        </div>
      );
    }
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-slate-900">Manufacturing, Blending & Batch Traceability</h1>
          <p className="text-xs text-slate-500">Multi-level lubricant BOMs, dynamic scaling, blending & filling execution, actual batch costing, and two-way genealogy</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" onClick={() => setShowImportModal(true)} className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded-md hover:bg-slate-50">
            <FileSpreadsheet className="w-3.5 h-3.5 text-emerald-700" /> Import BOMs (Excel)
          </button>
          <button type="button" onClick={() => setShowBomModal(true)} className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded-md hover:bg-slate-50">
            <Plus className="w-3.5 h-3.5" /> New BOM
          </button>
          <button type="button" onClick={() => setShowProdModal(true)} className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-white bg-slate-900 rounded-md hover:bg-slate-800">
            <Factory className="w-3.5 h-3.5" /> New Production Order
          </button>
        </div>
      </div>

      <div className="flex flex-wrap gap-1 p-1 bg-slate-100 rounded-lg w-fit">
        {[
          { id: 'boms', label: 'Bill of Materials (BOM)' },
          { id: 'production', label: 'Production Orders' },
          { id: 'blending', label: 'Blending & Filling Lines' },
          { id: 'traceability', label: 'Two-Way Batch Traceability' },
        ].map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setTab(t.id as MfgTab)}
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

      {tab === 'boms' && (
        <DataTable
          title="Lubricant Bills of Materials"
          columns={bomCols}
          data={boms}
          loading={loading}
          onRowClick={(r) => setViewingDoc({ type: 'bom', id: Number(r.id) })}
          exportFilename="lubricant_boms"
        />
      )}

      {tab === 'production' && (
        <DataTable
          title="Production Orders"
          columns={prodCols}
          data={orders}
          loading={loading}
          onRowClick={(r) => setViewingDoc({ type: 'prod', id: Number(r.id) })}
          statusFilterKey="status"
          statusOptions={['In Progress', 'Completed']}
          exportFilename="production_orders"
        />
      )}

      {tab === 'blending' && (
        <DataTable
          title="Blending Kettle & Filling Line Execution"
          columns={[
            { key: 'blend_number', header: 'Blend #' },
            { key: 'fill_number', header: 'Filling #' },
            { key: 'prod_number', header: 'Production #' },
            { key: 'finished_item_name', header: 'Product' },
            { key: 'equipment_name', header: 'Kettle / Line' },
            { key: 'operator_name', header: 'Operator' },
            { key: 'planned_qty', header: 'Planned', numeric: true },
            { key: 'calculated_cartons', header: 'Cartons', numeric: true },
            { key: 'quality_status', header: 'QC Status' },
            { key: 'status', header: 'Status' },
          ]}
          data={blendFillRows}
          loading={loading}
          exportFilename="blending_and_filling"
        />
      )}

      {tab === 'traceability' && (
        <div className="space-y-4">
          <div className="bg-white border border-slate-200 rounded-lg p-5">
            <h3 className="text-sm font-semibold text-slate-900 mb-3 flex items-center gap-2">
              <GitBranch className="w-4 h-4 text-slate-500" />
              Batch Genealogy & Recall Investigation
            </h3>
            <div className="flex flex-wrap gap-3 items-center">
              <div className="relative flex-1 min-w-[260px]">
                <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
                <input
                  value={traceQuery}
                  onChange={(e) => setTraceQuery(e.target.value)}
                  placeholder="Enter exact batch number (e.g. FG-PROD-2026-0001 or RM batch)..."
                  className="w-full pl-9 pr-3 py-2 text-xs border border-slate-300 rounded-md font-mono"
                />
              </div>
              <button
                type="button"
                onClick={() => void lookupTraceability(traceQuery)}
                className="px-4 py-2 text-xs font-medium bg-slate-900 text-white rounded-md hover:bg-slate-800"
              >
                Trace Two-Way Genealogy
              </button>
              <select
                value=""
                onChange={(e) => {
                  if (e.target.value) {
                    setTraceQuery(e.target.value);
                    void lookupTraceability(e.target.value);
                  }
                }}
                className="px-3 py-2 text-xs border border-slate-300 rounded-md bg-white"
              >
                <option value="">Quick-pick existing batch...</option>
                {batches.map((b) => (
                  <option key={b.batch_number} value={b.batch_number}>
                    {b.batch_number} — {b.item_name} ({b.qc_status})
                  </option>
                ))}
              </select>
            </div>
          </div>

          {traceData && (
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
              <div className="bg-white border border-slate-200 rounded-lg p-4 space-y-2 text-xs">
                <h4 className="font-semibold text-slate-900 border-b border-slate-100 pb-2">Selected Batch Details</h4>
                {(() => {
                  const b = traceData.batch as Record<string, unknown>;
                  return (
                    <dl className="space-y-1.5">
                      <div className="flex justify-between"><dt className="text-slate-500">Batch #:</dt><dd className="font-mono font-semibold">{String(b.batch_number)}</dd></div>
                      <div className="flex justify-between"><dt className="text-slate-500">Item:</dt><dd className="font-medium text-right">{String(b.item_name)}</dd></div>
                      <div className="flex justify-between"><dt className="text-slate-500">Warehouse:</dt><dd>{String(b.warehouse_name)}</dd></div>
                      <div className="flex justify-between"><dt className="text-slate-500">Source:</dt><dd className="font-mono">{String(b.source_doc_number || b.source_type)}</dd></div>
                      <div className="flex justify-between"><dt className="text-slate-500">Available Qty:</dt><dd className="font-mono tabular-nums">{String(b.available_qty)}</dd></div>
                      <div className="flex justify-between"><dt className="text-slate-500">QC Status:</dt><dd className={b.is_on_hold ? 'text-amber-700 font-semibold' : 'text-emerald-700 font-semibold'}>{String(b.qc_status)}</dd></div>
                    </dl>
                  );
                })()}
              </div>

              <div className="bg-white border border-slate-200 rounded-lg p-4 space-y-2 text-xs">
                <h4 className="font-semibold text-slate-900 border-b border-slate-100 pb-2">Backward Traceability (Origin & Raw Batches)</h4>
                {(() => {
                  const back = traceData.backward as Record<string, unknown> | null;
                  if (!back) return <p className="text-slate-500">Opening stock or direct receipt.</p>;
                  if (back.production_order) {
                    const po = back.production_order as Record<string, unknown>;
                    const mats = (back.consumed_materials as Record<string, unknown>[]) || [];
                    return (
                      <div className="space-y-2">
                        <p className="text-slate-700">Produced via <span className="font-mono font-semibold">{String(po.prod_number)}</span> (Blend <span className="font-mono">{String(po.blend_number)}</span>, BOM {String(po.bom_number)})</p>
                        <div className="divide-y divide-slate-100 border border-slate-200 rounded">
                          {mats.map((m, i) => (
                            <div key={i} className="p-2">
                              <p className="font-medium text-slate-800">{String(m.item_code)} — {String(m.item_name)}</p>
                              <p className="text-[11px] text-slate-500 font-mono">
                                Batch: {String(m.batch_number || 'FIFO')} · Qty: {String(m.actual_qty)} {String(m.uom)}
                                {m.supplier_name ? ` · Sup: ${String(m.supplier_name)}` : ''}
                                {m.po_number ? ` · ${String(m.po_number)}` : ''}
                              </p>
                            </div>
                          ))}
                        </div>
                      </div>
                    );
                  }
                  if (back.purchase_receipt) {
                    const grn = back.purchase_receipt as Record<string, unknown>;
                    return (
                      <div className="space-y-1">
                        <p>Supplier: <span className="font-semibold">{String(grn.supplier_name)}</span></p>
                        <p>GRN: <span className="font-mono">{String(grn.grn_number)}</span></p>
                        <p>PO: <span className="font-mono">{String(grn.po_number || '-')}</span></p>
                        <p>Purchase Invoice: <span className="font-mono">{String(grn.pi_number || '-')}</span></p>
                      </div>
                    );
                  }
                  return null;
                })()}
              </div>

              <div className="bg-white border border-slate-200 rounded-lg p-4 space-y-2 text-xs">
                <h4 className="font-semibold text-slate-900 border-b border-slate-100 pb-2">Forward Traceability (Blends & Customers)</h4>
                {(() => {
                  const fwd = traceData.forward as { used_in_production: Record<string, unknown>[]; dispatched_to_customers: Record<string, unknown>[] };
                  return (
                    <div className="space-y-3">
                      <div>
                        <p className="font-medium text-slate-700 mb-1">Consumed in Production ({fwd.used_in_production.length})</p>
                        {fwd.used_in_production.length === 0 ? (
                          <p className="text-slate-400">Not consumed in blending.</p>
                        ) : (
                          fwd.used_in_production.map((u, idx) => (
                            <div key={idx} className="p-2 bg-slate-50 rounded border border-slate-200 mb-1">
                              <span className="font-mono font-semibold">{String(u.prod_number)}</span> → {String(u.fg_name)} (FG Batch: <span className="font-mono">{String(u.fg_batch_number || 'Pending')}</span>)
                            </div>
                          ))
                        )}
                      </div>
                      <div>
                        <p className="font-medium text-slate-700 mb-1">Dispatched to Customers ({fwd.dispatched_to_customers.length})</p>
                        {fwd.dispatched_to_customers.length === 0 ? (
                          <p className="text-slate-400">No customer deliveries yet.</p>
                        ) : (
                          fwd.dispatched_to_customers.map((d, idx) => (
                            <div key={idx} className="p-2 bg-slate-50 rounded border border-slate-200 mb-1">
                              <p className="font-semibold text-slate-900">{String(d.customer_name)}</p>
                              <p className="font-mono text-[11px] text-slate-600">
                                DN: {String(d.dn_number)} · Qty: {String(d.qty)} · SI: {String(d.si_number || 'Unbilled')}
                              </p>
                            </div>
                          ))
                        )}
                      </div>
                    </div>
                  );
                })()}
              </div>
            </div>
          )}
        </div>
      )}



      {/* BOM Scaling Modal */}
      {scaleBom && (
        <div className="fixed inset-0 bg-slate-900/40 z-50 flex items-center justify-center p-4">
          <div className="bg-white border border-slate-200 rounded-lg w-full max-w-2xl p-6 space-y-4 text-xs">
            <div className="flex items-center justify-between">
              <h3 className="text-base font-semibold text-slate-900">Dynamic BOM Scaling — {String(scaleBom.bom_number)}</h3>
              <button type="button" onClick={() => { setScaleBom(null); setScaleResult(null); }} className="text-slate-500 hover:text-slate-900">Close</button>
            </div>
            <div className="flex items-center gap-3">
              <label className="font-medium text-slate-700">Target Batch Quantity ({String(scaleBom.uom)}):</label>
              <input type="number" value={scaleTargetQty} onChange={(e) => setScaleTargetQty(e.target.value)} className="px-3 py-1.5 border border-slate-300 rounded font-mono w-32" />
              <button type="button" onClick={() => void runBomScaling(Number(scaleBom.id), Number(scaleTargetQty))} className="px-3 py-1.5 bg-slate-900 text-white rounded font-medium">Recalculate</button>
            </div>
            {scaleResult && (
              <div className="border border-slate-200 rounded overflow-hidden">
                <table className="w-full text-left">
                  <thead className="bg-slate-50 border-b border-slate-200">
                    <tr>
                      <th className="px-3 py-2">Component</th>
                      <th className="px-3 py-2">Type</th>
                      <th className="px-3 py-2 text-right">Scaled Qty</th>
                      <th className="px-3 py-2 text-right">Est. Cost (AED)</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {((scaleResult.components as Record<string, unknown>[]) || []).map((c, i) => (
                      <tr key={i}>
                        <td className="px-3 py-2">{String(c.item_code)} — {String(c.item_name)}</td>
                        <td className="px-3 py-2">{String(c.component_type)}</td>
                        <td className="px-3 py-2 text-right font-mono tabular-nums">{String(c.required_qty)} {String(c.uom)}</td>
                        <td className="px-3 py-2 text-right font-mono tabular-nums">{Number(c.estimated_cost || 0).toFixed(2)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <div className="px-3 py-2 bg-slate-50 border-t border-slate-200 flex justify-between font-medium">
                  <span>Scaled Labour: AED {Number(scaleResult.scaled_labour || 0).toFixed(2)}</span>
                  <span>Scaled Overhead: AED {Number(scaleResult.scaled_overhead || 0).toFixed(2)}</span>
                </div>
              </div>
            )}
          </div>
        </div>
      )}



      {/* Complete Production Order Modal */}
      {completeOrder && (
        <div className="fixed inset-0 bg-slate-900/40 z-50 flex items-center justify-center p-4">
          <form onSubmit={submitCompletion} className="bg-white border border-slate-200 rounded-lg w-full max-w-3xl max-h-[90vh] overflow-y-auto p-6 space-y-4 text-xs">
            <h3 className="text-base font-semibold text-slate-900">Complete Production & Post Costing — {String(completeOrder.prod_number)}</h3>
            <div className="grid grid-cols-3 gap-3">
              <div>
                <label className="block font-medium text-slate-700 mb-1">Good Output Qty</label>
                <input type="number" step="0.01" required value={completeForm.completed_qty} onChange={(e) => setCompleteForm({ ...completeForm, completed_qty: e.target.value })} className="w-full px-3 py-1.5 border border-slate-300 rounded font-mono" />
              </div>
              <div>
                <label className="block font-medium text-slate-700 mb-1">Rejected / Scrap Qty</label>
                <input type="number" step="0.01" value={completeForm.rejected_qty} onChange={(e) => setCompleteForm({ ...completeForm, rejected_qty: e.target.value })} className="w-full px-3 py-1.5 border border-slate-300 rounded font-mono" />
              </div>
              <div>
                <label className="block font-medium text-slate-700 mb-1">Finished Batch Number</label>
                <input required value={completeForm.batch_number} onChange={(e) => setCompleteForm({ ...completeForm, batch_number: e.target.value })} className="w-full px-3 py-1.5 border border-slate-300 rounded font-mono" />
              </div>
            </div>

            <div className="border border-slate-200 rounded overflow-x-auto">
              <table className="w-full text-left">
                <thead className="bg-slate-50 border-b border-slate-200">
                  <tr>
                    <th className="px-3 py-2">Consumed Material</th>
                    <th className="px-3 py-2 text-right">Planned</th>
                    <th className="px-3 py-2 text-right">Actual Qty</th>
                    <th className="px-3 py-2 text-right">Wastage</th>
                    <th className="px-3 py-2">Source Tank</th>
                    <th className="px-3 py-2">Source Batch (Optional)</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {consumptionEdits.map((c, idx) => {
                    const eligibleTanks = tanks.filter(
                      (t) =>
                        t.is_active &&
                        (t.warehouse_id === Number(completeOrder.warehouse_id) || t.assigned_item_id === c.item_id)
                    );
                    return (
                      <tr key={c.id}>
                        <td className="px-3 py-2">{c.item_name}</td>
                        <td className="px-3 py-2 text-right font-mono">{c.planned_qty}</td>
                        <td className="px-3 py-2 text-right">
                          <input
                            type="number"
                            step="0.01"
                            value={c.actual_qty}
                            onChange={(e) => {
                              const copy = [...consumptionEdits];
                              copy[idx].actual_qty = e.target.value;
                              setConsumptionEdits(copy);
                            }}
                            className="w-20 px-2 py-1 border border-slate-300 rounded text-right font-mono"
                          />
                        </td>
                        <td className="px-3 py-2 text-right">
                          <input
                            type="number"
                            step="0.01"
                            value={c.wastage_qty}
                            onChange={(e) => {
                              const copy = [...consumptionEdits];
                              copy[idx].wastage_qty = e.target.value;
                              setConsumptionEdits(copy);
                            }}
                            className="w-16 px-2 py-1 border border-slate-300 rounded text-right font-mono"
                          />
                        </td>
                        <td className="px-3 py-2">
                          {c.component_type === 'Formula' ? (
                            <select
                              value={c.tank_id}
                              onChange={(e) => {
                                const copy = [...consumptionEdits];
                                copy[idx].tank_id = e.target.value ? Number(e.target.value) : '';
                                setConsumptionEdits(copy);
                              }}
                              className="w-40 px-2 py-1 border border-slate-300 rounded"
                            >
                              <option value="">Warehouse Stock (No Tank)</option>
                              {eligibleTanks.map((t) => (
                                <option key={t.id} value={t.id}>
                                  {t.tank_code} — {t.name} ({t.current_qty}/{t.capacity_qty} {t.uom})
                                </option>
                              ))}
                            </select>
                          ) : (
                            <span className="text-slate-400">Warehouse Bin</span>
                          )}
                        </td>
                        <td className="px-3 py-2">
                          <input
                            value={c.batch_number}
                            onChange={(e) => {
                              const copy = [...consumptionEdits];
                              copy[idx].batch_number = e.target.value;
                              setConsumptionEdits(copy);
                            }}
                            placeholder="FIFO auto"
                            className="w-28 px-2 py-1 border border-slate-300 rounded font-mono"
                          />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <label className="flex items-center gap-2 text-slate-700">
              <input type="checkbox" checked={completeForm.qc_release_immediately} onChange={(e) => setCompleteForm({ ...completeForm, qc_release_immediately: e.target.checked })} />
              <span>Release Finished Batch immediately (leave unchecked to place on QC Hold for Lab verification)</span>
            </label>

            <div className="flex justify-end gap-2 pt-2">
              <button type="button" onClick={() => setCompleteOrder(null)} className="px-3 py-1.5 border border-slate-300 rounded">Cancel</button>
              <button type="submit" className="px-4 py-1.5 bg-emerald-700 text-white rounded font-medium">Post Consumption, Receive FG & Journal</button>
            </div>
          </form>
        </div>
      )}

      <ExcelImportModal
        open={showImportModal}
        initialType="boms"
        onClose={() => setShowImportModal(false)}
        onImported={(m) => {
          setMsg(m);
          void loadAll();
        }}
      />

      {panelDoc && <DocumentPanel docType={panelDoc.docType} docId={panelDoc.docId} docNumber={panelDoc.docNumber} onClose={() => setPanelDoc(null)} />}
    </div>
  );
}
