import React, { useEffect, useState } from 'react';
import { ClipboardCheck, FileText, Plus, ShieldAlert } from 'lucide-react';
import { apiRequest } from '../../services/api';
import { DataTable, type ColumnDef } from '../../components/DataTable';
import { exportDocumentPdf } from '../../utils/export';
import { useCompany } from '../../context/CompanyContext';

interface QcParameter {
  id: number;
  name: string;
  unit: string;
  method: string;
  default_min: number | null;
  default_max: number | null;
  data_type: string;
}

export function QualityView() {
  const { company, logoUrl } = useCompany();
  const [tab, setTab] = useState<'inspections' | 'parameters'>('inspections');
  const [inspections, setInspections] = useState<Record<string, unknown>[]>([]);
  const [parameters, setParameters] = useState<QcParameter[]>([]);
  const [items, setItems] = useState<{ id: number; item_code: string; name: string }[]>([]);
  const [batches, setBatches] = useState<{ id: number; batch_number: string; item_id: number; item_name: string }[]>([]);
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');

  const [showNewQc, setShowNewQc] = useState(false);
  const [newQc, setNewQc] = useState({ inspection_type: 'Finished Lubricant', item_id: 0, batch_number: '', remarks: '' });
  const [showParamModal, setShowParamModal] = useState(false);
  const [paramForm, setParamForm] = useState({ name: '', unit: '', method: '', default_min: '', default_max: '', data_type: 'numeric' });

  const [evalQc, setEvalQc] = useState<Record<string, unknown> | null>(null);
  const [evalAction, setEvalAction] = useState<'Release' | 'Hold' | 'Reject'>('Release');
  const [evalRemarks, setEvalRemarks] = useState('');
  const [evalRows, setEvalRows] = useState<{ parameter_id: number; parameter_name: string; unit: string; min_val: number | null; max_val: number | null; actual_val: string; text_val: string }[]>([]);

  const loadAll = async () => {
    setLoading(true);
    try {
      const [iRes, pRes, itemRes, bRes] = await Promise.all([
        apiRequest<{ items: Record<string, unknown>[] }>('/api/quality/inspections'),
        apiRequest<{ items: QcParameter[] }>('/api/quality/parameters'),
        apiRequest<{ items: typeof items }>('/api/masters/items'),
        apiRequest<{ items: typeof batches }>('/api/inventory/batches'),
      ]);
      setInspections(iRes.items);
      setParameters(pRes.items);
      setItems(itemRes.items);
      setBatches(bRes.items);
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : 'Failed to load QC records');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadAll();
  }, []);

  const openEvaluate = (row: Record<string, unknown>) => {
    setEvalQc(row);
    setEvalAction('Release');
    setEvalRemarks(String(row.remarks || ''));
    const existing = (row.results as Record<string, unknown>[]) || [];
    if (existing.length > 0) {
      setEvalRows(
        existing.map((r) => ({
          parameter_id: Number(r.parameter_id || 0),
          parameter_name: String(r.parameter_name),
          unit: String(r.unit || ''),
          min_val: r.min_val !== null ? Number(r.min_val) : null,
          max_val: r.max_val !== null ? Number(r.max_val) : null,
          actual_val: r.actual_val !== null ? String(r.actual_val) : '',
          text_val: String(r.text_val || ''),
        }))
      );
    } else {
      setEvalRows(
        parameters.map((p) => ({
          parameter_id: p.id,
          parameter_name: p.name,
          unit: p.unit,
          min_val: p.default_min,
          max_val: p.default_max,
          actual_val: p.default_min !== null && p.default_max !== null ? String(((p.default_min + p.default_max) / 2).toFixed(2)) : '',
          text_val: p.data_type === 'text' ? 'Clear & Bright' : '',
        }))
      );
    }
  };

  const submitEvaluation = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!evalQc) return;
    setErr('');
    try {
      const res = await apiRequest<{ overall_status: string; batch_action: string }>(`/api/quality/inspections/${evalQc.id}/evaluate`, {
        method: 'POST',
        body: JSON.stringify({
          batch_action: evalAction,
          remarks: evalRemarks,
          results: evalRows.map((r) => ({
            parameter_id: r.parameter_id || undefined,
            parameter_name: r.parameter_name,
            unit: r.unit,
            min_val: r.min_val,
            max_val: r.max_val,
            actual_val: r.actual_val !== '' ? Number(r.actual_val) : null,
            text_val: r.text_val,
          })),
        }),
      });
      setEvalQc(null);
      setMsg(`QC ${String(evalQc.qc_number)} evaluated: ${res.overall_status} (Batch action: ${res.batch_action}).`);
      await loadAll();
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : 'Failed to evaluate QC');
    }
  };

  const downloadCoaPdf = async (qcId: number) => {
    try {
      const data = await apiRequest<{
        company: Record<string, string>;
        inspection: Record<string, unknown>;
        results: Record<string, unknown>[];
      }>(`/api/quality/inspections/${qcId}/coa`);
      exportDocumentPdf({
        title: 'Certificate of Analysis (COA)',
        docNumber: String(data.inspection.qc_number),
        companyName: data.company.name || company.name || 'Company Name',
        companyAddress: data.company.address || company.address,
        companyTrn: data.company.trn || company.trn,
        logoUrl: data.company.logo_url || logoUrl,
        meta: [
          { label: 'Product', value: `${String(data.inspection.item_code)} - ${String(data.inspection.item_name)}` },
          { label: 'Batch Number', value: String(data.inspection.batch_number || 'N/A') },
          { label: 'Inspection Type', value: String(data.inspection.inspection_type) },
          { label: 'Inspection Date', value: String(data.inspection.inspection_date) },
          { label: 'Inspector', value: String(data.inspection.inspector_name) },
          { label: 'Overall Verdict', value: `${String(data.inspection.overall_status)} (${String(data.inspection.batch_action)})` },
        ],
        columns: [
          { header: 'Lab Parameter', key: 'parameter_name' },
          { header: 'Unit', key: 'unit' },
          { header: 'Min Spec', key: 'min_val' },
          { header: 'Max Spec', key: 'max_val' },
          { header: 'Actual Result', key: 'actual_display' },
          { header: 'Status', key: 'result_status' },
        ],
        lines: data.results.map((r) => ({
          ...r,
          min_val: r.min_val ?? '-',
          max_val: r.max_val ?? '-',
          actual_display: r.actual_val !== null && r.actual_val !== undefined ? r.actual_val : r.text_val || '-',
        })),
        footerNote: `Approved Quality Control Laboratory Report · Batch Hold Status: ${String(data.inspection.batch_action)}`,
      });
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : 'Failed to generate COA');
    }
  };

  const qcCols: ColumnDef<Record<string, unknown>>[] = [
    { key: 'qc_number', header: 'QC #' },
    { key: 'inspection_type', header: 'Type' },
    { key: 'item_code', header: 'SKU' },
    { key: 'item_name', header: 'Item' },
    { key: 'batch_number', header: 'Batch #' },
    { key: 'inspection_date', header: 'Date' },
    {
      key: 'overall_status',
      header: 'QC Result',
      render: (r) => (
        <span className={r.overall_status === 'Passed' ? 'text-emerald-700 font-semibold' : r.overall_status === 'Failed' ? 'text-red-600 font-semibold' : 'text-amber-700 font-semibold'}>
          {String(r.overall_status)}
        </span>
      ),
    },
    {
      key: 'batch_action',
      header: 'Batch Control',
      render: (r) => (
        <span className="inline-flex items-center gap-1 text-xs">
          {r.is_on_hold ? <ShieldAlert className="w-3.5 h-3.5 text-amber-600" /> : null}
          {String(r.batch_action)}
        </span>
      ),
    },
    {
      key: 'actions',
      header: 'Actions',
      render: (r) => (
        <div className="flex items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
          <button
            type="button"
            onClick={() => openEvaluate(r)}
            className="inline-flex items-center gap-1 px-2 py-1 text-xs font-medium bg-slate-900 text-white rounded hover:bg-slate-800"
          >
            <ClipboardCheck className="w-3 h-3" /> Lab Test / Release
          </button>
          <button
            type="button"
            onClick={() => void downloadCoaPdf(Number(r.id))}
            className="inline-flex items-center gap-1 px-2 py-1 text-xs border border-slate-300 rounded hover:bg-slate-50"
          >
            <FileText className="w-3 h-3" /> COA PDF
          </button>
        </div>
      ),
    },
  ];

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-slate-900">Quality Control & Laboratory (ASTM / ISO)</h1>
          <p className="text-xs text-slate-500">Incoming base oil testing, finished lubricant viscosity/TBN/flash-point specs, batch hold/release & COA PDF</p>
        </div>
        <div className="flex items-center gap-2">
          <button type="button" onClick={() => setShowParamModal(true)} className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded-md hover:bg-slate-50">
            <Plus className="w-3.5 h-3.5" /> Add Lab Parameter
          </button>
          <button type="button" onClick={() => setShowNewQc(true)} className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-white bg-slate-900 rounded-md hover:bg-slate-800">
            <Plus className="w-3.5 h-3.5" /> New Inspection
          </button>
        </div>
      </div>

      <div className="flex gap-1 p-1 bg-slate-100 rounded-lg w-fit">
        {[
          { id: 'inspections', label: 'QC Inspections & Batch Holds' },
          { id: 'parameters', label: 'ASTM Lab Parameters' },
        ].map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setTab(t.id as 'inspections' | 'parameters')}
            className={`px-3 py-1.5 text-xs font-medium rounded-md ${tab === t.id ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600'}`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {msg && <div className="p-3 bg-emerald-50 border border-emerald-200 rounded text-xs text-emerald-800">{msg}</div>}
      {err && <div className="p-3 bg-red-50 border border-red-200 rounded text-xs text-red-700">{err}</div>}

      {tab === 'inspections' && (
        <DataTable
          title="Quality Inspections"
          columns={qcCols}
          data={inspections}
          loading={loading}
          statusFilterKey="overall_status"
          statusOptions={['Pending', 'Passed', 'Failed']}
          exportFilename="qc_inspections"
        />
      )}

      {tab === 'parameters' && (
        <DataTable
          title="ASTM Lubricant Test Parameters"
          columns={[
            { key: 'name', header: 'Test Parameter' },
            { key: 'method', header: 'Standard Method' },
            { key: 'unit', header: 'Unit' },
            { key: 'default_min', header: 'Min Spec', numeric: true },
            { key: 'default_max', header: 'Max Spec', numeric: true },
            { key: 'data_type', header: 'Type' },
          ]}
          data={parameters as unknown as Record<string, unknown>[]}
          loading={loading}
          exportFilename="qc_parameters"
        />
      )}

      {showNewQc && (
        <div className="fixed inset-0 bg-slate-900/40 z-50 flex items-center justify-center p-4">
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              await apiRequest('/api/quality/inspections', { method: 'POST', body: JSON.stringify(newQc) });
              setShowNewQc(false);
              setMsg('QC Inspection created.');
              await loadAll();
            }}
            className="bg-white border border-slate-200 rounded-lg w-full max-w-md p-6 space-y-3 text-xs"
          >
            <h3 className="text-base font-semibold text-slate-900">Create Quality Inspection</h3>
            <select value={newQc.inspection_type} onChange={(e) => setNewQc({ ...newQc, inspection_type: e.target.value })} className="w-full px-3 py-1.5 border border-slate-300 rounded">
              <option value="Incoming Raw Material">Incoming Raw Material</option>
              <option value="In-Process Blend">In-Process Blend</option>
              <option value="Finished Lubricant">Finished Lubricant</option>
            </select>
            <select required value={newQc.item_id} onChange={(e) => setNewQc({ ...newQc, item_id: Number(e.target.value) })} className="w-full px-3 py-1.5 border border-slate-300 rounded">
              <option value="">Select Item...</option>
              {items.map((i) => <option key={i.id} value={i.id}>{i.item_code} — {i.name}</option>)}
            </select>
            <select value={newQc.batch_number} onChange={(e) => setNewQc({ ...newQc, batch_number: e.target.value })} className="w-full px-3 py-1.5 border border-slate-300 rounded">
              <option value="">Select Batch (optional)...</option>
              {batches.map((b) => <option key={b.id} value={b.batch_number}>{b.batch_number} ({b.item_name})</option>)}
            </select>
            <input placeholder="Remarks" value={newQc.remarks} onChange={(e) => setNewQc({ ...newQc, remarks: e.target.value })} className="w-full px-3 py-1.5 border border-slate-300 rounded" />
            <div className="flex justify-end gap-2 pt-2">
              <button type="button" onClick={() => setShowNewQc(false)} className="px-3 py-1.5 border border-slate-300 rounded">Cancel</button>
              <button type="submit" className="px-4 py-1.5 bg-slate-900 text-white rounded font-medium">Create Inspection</button>
            </div>
          </form>
        </div>
      )}

      {showParamModal && (
        <div className="fixed inset-0 bg-slate-900/40 z-50 flex items-center justify-center p-4">
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              await apiRequest('/api/quality/parameters', {
                method: 'POST',
                body: JSON.stringify({
                  ...paramForm,
                  default_min: paramForm.default_min ? Number(paramForm.default_min) : null,
                  default_max: paramForm.default_max ? Number(paramForm.default_max) : null,
                }),
              });
              setShowParamModal(false);
              setMsg('Lab parameter added.');
              await loadAll();
            }}
            className="bg-white border border-slate-200 rounded-lg w-full max-w-md p-6 space-y-3 text-xs"
          >
            <h3 className="text-base font-semibold text-slate-900">Add ASTM Lab Parameter</h3>
            <input required placeholder="Parameter Name (e.g. Kinematic Viscosity @ 100°C)" value={paramForm.name} onChange={(e) => setParamForm({ ...paramForm, name: e.target.value })} className="w-full px-3 py-1.5 border border-slate-300 rounded" />
            <div className="grid grid-cols-2 gap-2">
              <input placeholder="Method (e.g. ASTM D445)" value={paramForm.method} onChange={(e) => setParamForm({ ...paramForm, method: e.target.value })} className="px-3 py-1.5 border border-slate-300 rounded" />
              <input placeholder="Unit (e.g. cSt)" value={paramForm.unit} onChange={(e) => setParamForm({ ...paramForm, unit: e.target.value })} className="px-3 py-1.5 border border-slate-300 rounded" />
              <input type="number" step="0.001" placeholder="Default Min" value={paramForm.default_min} onChange={(e) => setParamForm({ ...paramForm, default_min: e.target.value })} className="px-3 py-1.5 border border-slate-300 rounded" />
              <input type="number" step="0.001" placeholder="Default Max" value={paramForm.default_max} onChange={(e) => setParamForm({ ...paramForm, default_max: e.target.value })} className="px-3 py-1.5 border border-slate-300 rounded" />
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <button type="button" onClick={() => setShowParamModal(false)} className="px-3 py-1.5 border border-slate-300 rounded">Cancel</button>
              <button type="submit" className="px-4 py-1.5 bg-slate-900 text-white rounded font-medium">Save Parameter</button>
            </div>
          </form>
        </div>
      )}

      {evalQc && (
        <div className="fixed inset-0 bg-slate-900/40 z-50 flex items-center justify-center p-4">
          <form onSubmit={submitEvaluation} className="bg-white border border-slate-200 rounded-lg w-full max-w-3xl max-h-[90vh] overflow-y-auto p-6 space-y-4 text-xs">
            <h3 className="text-base font-semibold text-slate-900">
              Lab Evaluation & Batch Decision — {String(evalQc.qc_number)} ({String(evalQc.batch_number)})
            </h3>
            <table className="w-full text-left border border-slate-200">
              <thead className="bg-slate-50 border-b border-slate-200">
                <tr>
                  <th className="px-3 py-2">Parameter</th>
                  <th className="px-3 py-2">Spec Range</th>
                  <th className="px-3 py-2">Actual Numeric</th>
                  <th className="px-3 py-2">Visual / Text</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {evalRows.map((r, idx) => (
                  <tr key={idx}>
                    <td className="px-3 py-2 font-medium">{r.parameter_name} {r.unit ? `(${r.unit})` : ''}</td>
                    <td className="px-3 py-2 font-mono text-slate-500">
                      {r.min_val !== null || r.max_val !== null ? `${r.min_val ?? '-'} to ${r.max_val ?? '-'}` : 'Visual'}
                    </td>
                    <td className="px-3 py-2">
                      <input
                        type="number"
                        step="0.001"
                        value={r.actual_val}
                        onChange={(e) => {
                          const copy = [...evalRows];
                          copy[idx].actual_val = e.target.value;
                          setEvalRows(copy);
                        }}
                        className="w-28 px-2 py-1 border border-slate-300 rounded font-mono"
                      />
                    </td>
                    <td className="px-3 py-2">
                      <input
                        value={r.text_val}
                        onChange={(e) => {
                          const copy = [...evalRows];
                          copy[idx].text_val = e.target.value;
                          setEvalRows(copy);
                        }}
                        className="w-36 px-2 py-1 border border-slate-300 rounded"
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block font-medium text-slate-700 mb-1">Batch Disposition</label>
                <select value={evalAction} onChange={(e) => setEvalAction(e.target.value as 'Release' | 'Hold' | 'Reject')} className="w-full px-3 py-1.5 border border-slate-300 rounded">
                  <option value="Release">Release Batch for Sale / Blending</option>
                  <option value="Hold">Keep on QC Hold (Blocks Dispatch)</option>
                  <option value="Reject">Reject Batch</option>
                </select>
              </div>
              <div>
                <label className="block font-medium text-slate-700 mb-1">Lab Remarks</label>
                <input value={evalRemarks} onChange={(e) => setEvalRemarks(e.target.value)} className="w-full px-3 py-1.5 border border-slate-300 rounded" />
              </div>
            </div>

            <div className="flex justify-end gap-2 pt-2">
              <button type="button" onClick={() => setEvalQc(null)} className="px-3 py-1.5 border border-slate-300 rounded">Cancel</button>
              <button type="submit" className="px-4 py-1.5 bg-slate-900 text-white rounded font-medium">Save Lab Results & Apply Batch Status</button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
