import React, { useEffect, useState } from 'react';
import { AlertCircle, CheckCircle2, Download, FileSpreadsheet, Upload, X } from 'lucide-react';
import { apiRequest, downloadProtectedFile } from '../services/api';

export type ImportType =
  | 'opening_stock'
  | 'stock_adjustment'
  | 'boms'
  | 'items'
  | 'item_groups'
  | 'tanks'
  | 'suppliers'
  | 'customers';

interface ImportColumnSpec {
  key: string;
  header: string;
  required?: boolean;
  note: string;
}

interface ImportTypeMeta {
  type: ImportType;
  label: string;
  description: string;
  columns: ImportColumnSpec[];
}

interface PreviewRow {
  rowNumber: number;
  valid: boolean;
  errors: string[];
  normalized: Record<string, string>;
}

interface PreviewResult {
  type: ImportType;
  totalRows: number;
  validCount: number;
  errorCount: number;
  rows: PreviewRow[];
}

interface ExcelImportModalProps {
  open: boolean;
  initialType?: ImportType;
  onClose: () => void;
  onImported: (message: string) => void;
}

export function ExcelImportModal({ open, initialType = 'opening_stock', onClose, onImported }: ExcelImportModalProps) {
  const [types, setTypes] = useState<ImportTypeMeta[]>([]);
  const [selectedType, setSelectedType] = useState<ImportType>(initialType);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [postGl, setPostGl] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  useEffect(() => {
    if (!open) return;
    setSelectedType(initialType);
    setFile(null);
    setPreview(null);
    setErr('');
    void apiRequest<{ types: ImportTypeMeta[] }>('/api/import/types')
      .then((res) => setTypes(res.types))
      .catch(() => {});
  }, [open, initialType]);

  if (!open) return null;

  const activeSpec = types.find((t) => t.type === selectedType);

  const handleDownloadTemplate = async () => {
    setErr('');
    try {
      await downloadProtectedFile(`/api/import/template/${selectedType}`, `${selectedType}_import_template.xlsx`);
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : 'Failed to download template');
    }
  };

  const handleFileSelect = async (chosen: File | null) => {
    if (!chosen) return;
    setFile(chosen);
    setPreview(null);
    setErr('');
    setBusy(true);
    try {
      const form = new FormData();
      form.append('file', chosen);
      const res = await apiRequest<PreviewResult>(`/api/import/preview/${selectedType}`, {
        method: 'POST',
        body: form,
      });
      setPreview(res);
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : 'Failed to validate Excel file');
    } finally {
      setBusy(false);
    }
  };

  const handleCommit = async () => {
    if (!preview || preview.errorCount > 0 || preview.validCount === 0) return;
    setBusy(true);
    setErr('');
    try {
      const res = await apiRequest<{ ok: boolean; summary: Record<string, unknown> }>(`/api/import/commit/${selectedType}`, {
        method: 'POST',
        body: JSON.stringify({
          rows: preview.rows.map((r) => r.normalized),
          post_gl: postGl,
        }),
      });
      const count = Number(res.summary.imported || preview.validCount);
      const docRef = res.summary.doc_number ? ` (${String(res.summary.doc_number)})` : res.summary.boms_created ? ` (${String(res.summary.boms_created)} BOMs)` : '';
      onImported(`Successfully imported ${count} rows into ${activeSpec?.label || selectedType}${docRef}.`);
      onClose();
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : 'Import failed');
    } finally {
      setBusy(false);
    }
  };

  const displayCols = activeSpec?.columns.slice(0, 6) || [];

  return (
    <div className="fixed inset-0 bg-slate-900/50 z-[65] flex items-center justify-center p-4 overflow-y-auto">
      <div className="bg-white border border-slate-200 rounded-lg w-full max-w-5xl max-h-[90vh] flex flex-col overflow-hidden shadow-xl text-xs">
        <div className="px-5 py-3.5 border-b border-slate-200 bg-slate-50 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <FileSpreadsheet className="w-4 h-4 text-emerald-700" />
            <div>
              <h3 className="text-sm font-semibold text-slate-900">Bulk Excel Import & First-Time Templates</h3>
              <p className="text-[11px] text-slate-500">Download a structured Excel template with your live codes, fill in rows, validate, and import in one click</p>
            </div>
          </div>
          <button type="button" onClick={onClose} className="p-1 text-slate-500 hover:text-slate-900 rounded hover:bg-slate-200">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-5 space-y-4 overflow-y-auto flex-1">
          {/* Step 1: Select Import Type + Download Template */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 items-end">
            <div className="md:col-span-2">
              <label className="block font-medium text-slate-700 mb-1">1. Select Data / Module to Import</label>
              <select
                value={selectedType}
                onChange={(e) => {
                  setSelectedType(e.target.value as ImportType);
                  setFile(null);
                  setPreview(null);
                  setErr('');
                }}
                className="w-full px-3 py-2 border border-slate-300 rounded-md bg-white text-xs font-medium text-slate-900"
              >
                {(types.length > 0
                  ? types
                  : [
                      { type: 'opening_stock', label: 'Opening Stock & Warehouse / Tank Balances' },
                      { type: 'stock_adjustment', label: 'Stock Movements (Receipts, Issues & Tank Transfers)' },
                      { type: 'boms', label: 'Bills of Materials (BOM & Formulas)' },
                      { type: 'items', label: 'Items & Group-Wise SKUs' },
                      { type: 'item_groups', label: 'Hierarchical Item Groups' },
                      { type: 'tanks', label: 'Warehouse Storage Tanks' },
                      { type: 'suppliers', label: 'Suppliers Master' },
                      { type: 'customers', label: 'Customers Master' },
                    ]
                ).map((t) => (
                  <option key={t.type} value={t.type}>
                    {t.label}
                  </option>
                ))}
              </select>
              {activeSpec && <p className="mt-1 text-[11px] text-slate-500">{activeSpec.description}</p>}
            </div>

            <div>
              <button
                type="button"
                onClick={() => void handleDownloadTemplate()}
                className="w-full inline-flex items-center justify-center gap-2 px-4 py-2 text-xs font-medium text-slate-900 bg-emerald-50 border border-emerald-300 rounded-md hover:bg-emerald-100"
              >
                <Download className="w-4 h-4 text-emerald-700" />
                Download First-Time Excel Template
              </button>
              <p className="mt-1 text-[10px] text-slate-500 text-center">Includes sample rows + live Warehouse/Tank/Item codes</p>
            </div>
          </div>

          {/* Expected Columns Guide */}
          {activeSpec && (
            <div className="border border-slate-200 rounded-md p-3 bg-slate-50/70">
              <p className="text-[11px] font-semibold text-slate-700 mb-2">Template Columns (* = Required)</p>
              <div className="flex flex-wrap gap-1.5">
                {activeSpec.columns.map((c) => (
                  <span
                    key={c.key}
                    title={c.note}
                    className={`px-2 py-0.5 rounded border text-[11px] font-mono ${
                      c.required ? 'bg-white border-slate-300 text-slate-900 font-semibold' : 'bg-slate-100 border-slate-200 text-slate-600'
                    }`}
                  >
                    {c.header}
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* Step 2: Upload Excel / CSV */}
          <div className="border border-dashed border-slate-300 rounded-md p-5 text-center bg-white hover:bg-slate-50 transition-colors">
            <label className="cursor-pointer inline-flex flex-col items-center gap-2">
              <Upload className="w-6 h-6 text-slate-500" />
              <span className="text-xs font-medium text-slate-800">
                {file ? `Selected: ${file.name}` : '2. Choose filled Excel (.xlsx / .xls) or CSV file to validate & preview'}
              </span>
              <span className="text-[11px] text-slate-500">All rows are validated against existing items, warehouses, and tank capacities before saving</span>
              <input
                type="file"
                accept=".xlsx,.xls,.csv"
                onChange={(e) => void handleFileSelect(e.target.files?.[0] || null)}
                className="hidden"
              />
              <span className="mt-1 px-3 py-1.5 bg-slate-900 text-white rounded text-xs font-medium">
                {busy ? 'Validating Spreadsheet...' : 'Select Excel File'}
              </span>
            </label>
          </div>

          {selectedType === 'opening_stock' && (
            <label className="inline-flex items-center gap-2 text-xs text-slate-700">
              <input type="checkbox" checked={postGl} onChange={(e) => setPostGl(e.target.checked)} />
              <span>Automatically post balanced Opening Inventory Journal Entry (Inventory Asset vs Share Capital Equity)</span>
            </label>
          )}

          {err && (
            <div className="p-3 bg-red-50 border border-red-200 rounded text-xs text-red-700 flex items-center gap-2">
              <AlertCircle className="w-4 h-4 shrink-0" />
              <span>{err}</span>
            </div>
          )}

          {/* Step 3: Validation Preview Table */}
          {preview && (
            <div className="space-y-2">
              <div className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 bg-slate-50 border border-slate-200 rounded-md">
                <div className="flex items-center gap-4 text-xs">
                  <span className="font-semibold text-slate-900">Total Rows: {preview.totalRows}</span>
                  <span className="inline-flex items-center gap-1 text-emerald-700 font-medium">
                    <CheckCircle2 className="w-3.5 h-3.5" /> Valid: {preview.validCount}
                  </span>
                  {preview.errorCount > 0 && (
                    <span className="inline-flex items-center gap-1 text-red-700 font-medium">
                      <AlertCircle className="w-3.5 h-3.5" /> Errors: {preview.errorCount}
                    </span>
                  )}
                </div>
                <span className="text-[11px] text-slate-500">
                  {preview.errorCount === 0 ? 'Ready to import into ERP database.' : 'Fix highlighted errors in your spreadsheet and re-upload.'}
                </span>
              </div>

              <div className="border border-slate-200 rounded-md overflow-x-auto max-h-64">
                <table className="w-full text-left border-collapse text-[11px]">
                  <thead className="bg-slate-100 border-b border-slate-200 sticky top-0">
                    <tr>
                      <th className="px-2.5 py-2 font-semibold">Row</th>
                      <th className="px-2.5 py-2 font-semibold">Status</th>
                      {displayCols.map((c) => (
                        <th key={c.key} className="px-2.5 py-2 font-semibold">{c.header.replace('*', '')}</th>
                      ))}
                      <th className="px-2.5 py-2 font-semibold">Validation Notes</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {preview.rows.slice(0, 100).map((r) => (
                      <tr key={r.rowNumber} className={r.valid ? 'bg-white' : 'bg-red-50/70'}>
                        <td className="px-2.5 py-1.5 font-mono text-slate-500">{r.rowNumber}</td>
                        <td className="px-2.5 py-1.5">
                          {r.valid ? (
                            <span className="text-emerald-700 font-semibold">OK</span>
                          ) : (
                            <span className="text-red-700 font-semibold">Error</span>
                          )}
                        </td>
                        {displayCols.map((c) => (
                          <td key={c.key} className="px-2.5 py-1.5 font-mono text-slate-800">
                            {r.normalized[c.key] || '-'}
                          </td>
                        ))}
                        <td className="px-2.5 py-1.5 text-red-700">{r.errors.join('; ') || 'Valid'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>

        <div className="px-5 py-3 border-t border-slate-200 bg-slate-50 flex items-center justify-end gap-2">
          <button type="button" onClick={onClose} className="px-3 py-1.5 text-xs border border-slate-300 rounded-md bg-white hover:bg-slate-100">
            Cancel
          </button>
          <button
            type="button"
            disabled={busy || !preview || preview.errorCount > 0 || preview.validCount === 0}
            onClick={() => void handleCommit()}
            className="px-4 py-1.5 text-xs font-medium bg-slate-900 text-white rounded-md hover:bg-slate-800 disabled:opacity-40"
          >
            {busy ? 'Importing...' : `Confirm & Import (${preview?.validCount || 0} Rows)`}
          </button>
        </div>
      </div>
    </div>
  );
}
