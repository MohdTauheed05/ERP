import React, { useMemo, useState } from 'react';
import { Download, FileSpreadsheet, FileText, Printer, Search, ChevronLeft, ChevronRight, ArrowUpDown } from 'lucide-react';
import { exportTableToPdf, exportToCsv, exportToExcel } from '../utils/export';
import { useCompany } from '../context/CompanyContext';

export interface ColumnDef<T> {
  key: string;
  header: string;
  align?: 'left' | 'right';
  numeric?: boolean;
  render?: (row: T) => React.ReactNode;
  exportValue?: (row: T) => unknown;
}

interface DataTableProps<T extends Record<string, unknown>> {
  title: string;
  columns: ColumnDef<T>[];
  data: T[];
  loading?: boolean;
  emptyMessage?: string;
  emptyActionLabel?: string;
  onEmptyAction?: () => void;
  onRowClick?: (row: T) => void;
  exportFilename?: string;
  statusFilterKey?: string;
  statusOptions?: string[];
  toolbarExtra?: React.ReactNode;
}

export function DataTable<T extends Record<string, unknown>>({
  title,
  columns,
  data,
  loading = false,
  emptyMessage = 'No records found in database.',
  emptyActionLabel,
  onEmptyAction,
  onRowClick,
  exportFilename = 'erp_export',
  statusFilterKey,
  statusOptions,
  toolbarExtra,
}: DataTableProps<T>) {
  const { company, logoUrl } = useCompany();
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('All');
  const [sortKey, setSortKey] = useState<string | null>(null);
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');
  const [page, setPage] = useState(1);
  const pageSize = 15;

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return data.filter((row) => {
      if (statusFilterKey && statusFilter !== 'All' && String(row[statusFilterKey] ?? '') !== statusFilter) {
        return false;
      }
      if (!q) return true;
      return Object.values(row).some((v) => String(v ?? '').toLowerCase().includes(q));
    });
  }, [data, search, statusFilter, statusFilterKey]);

  const sorted = useMemo(() => {
    if (!sortKey) return filtered;
    return [...filtered].sort((a, b) => {
      const av = a[sortKey];
      const bv = b[sortKey];
      if (typeof av === 'number' && typeof bv === 'number') {
        return sortDir === 'asc' ? av - bv : bv - av;
      }
      return sortDir === 'asc'
        ? String(av ?? '').localeCompare(String(bv ?? ''))
        : String(bv ?? '').localeCompare(String(av ?? ''));
    });
  }, [filtered, sortKey, sortDir]);

  const totalPages = Math.max(1, Math.ceil(sorted.length / pageSize));
  const safePage = Math.min(page, totalPages);
  const pageData = sorted.slice((safePage - 1) * pageSize, safePage * pageSize);

  const buildExportRows = () =>
    sorted.map((row) => {
      const out: Record<string, unknown> = {};
      columns.forEach((col) => {
        out[col.header] = col.exportValue ? col.exportValue(row) : row[col.key];
      });
      return out;
    });

  const handleSort = (key: string) => {
    if (sortKey === key) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else {
      setSortKey(key);
      setSortDir('asc');
    }
  };

  return (
    <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
      <div className="p-4 border-b border-slate-200 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <div className="relative">
            <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setPage(1);
              }}
              placeholder={`Search ${title.toLowerCase()}...`}
              className="pl-9 pr-3 py-1.5 text-sm border border-slate-300 rounded-md w-64 focus:outline-none focus:ring-2 focus:ring-slate-900"
            />
          </div>
          {statusFilterKey && statusOptions && (
            <div className="flex items-center gap-1 p-1 bg-slate-100 rounded-md">
              {['All', ...statusOptions].map((opt) => (
                <button
                  key={opt}
                  type="button"
                  onClick={() => {
                    setStatusFilter(opt);
                    setPage(1);
                  }}
                  className={`px-2.5 py-1 text-xs font-medium rounded transition-colors whitespace-nowrap shrink-0 ${
                    statusFilter === opt ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  {opt}
                </button>
              ))}
            </div>
          )}
          {toolbarExtra}
        </div>

        <div className="flex items-center gap-2 no-print">
          <button
            type="button"
            onClick={() => exportToExcel(exportFilename, title, buildExportRows())}
            className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded-md hover:bg-slate-50 whitespace-nowrap shrink-0"
          >
            <FileSpreadsheet className="w-3.5 h-3.5" />
            Excel
          </button>
          <button
            type="button"
            onClick={() => exportToCsv(exportFilename, buildExportRows())}
            className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded-md hover:bg-slate-50 whitespace-nowrap shrink-0"
          >
            <Download className="w-3.5 h-3.5" />
            CSV
          </button>
          <button
            type="button"
            onClick={() =>
              void exportTableToPdf(
                exportFilename,
                title,
                columns.map((c) => ({ header: c.header, key: c.key })),
                sorted,
                company.name,
                logoUrl
              )
            }
            title="Open Print Preview before downloading PDF"
            className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded-md hover:bg-slate-50 whitespace-nowrap shrink-0"
          >
            <FileText className="w-3.5 h-3.5" />
            Preview PDF
          </button>
          <button
            type="button"
            onClick={() => window.print()}
            className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded-md hover:bg-slate-50 whitespace-nowrap shrink-0"
          >
            <Printer className="w-3.5 h-3.5" />
            Print
          </button>
        </div>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-left border-collapse">
          <thead>
            <tr className="bg-slate-50 border-b border-slate-200 text-xs font-semibold text-slate-600">
              {columns.map((col) => (
                <th
                  key={col.key}
                  onClick={() => handleSort(col.key)}
                  className={`px-4 py-2.5 cursor-pointer select-none hover:text-slate-900 whitespace-nowrap ${
                    col.align === 'right' || col.numeric ? 'text-right' : 'text-left'
                  }`}
                >
                  <span className="inline-flex items-center gap-1">
                    {col.header}
                    <ArrowUpDown className="w-3 h-3 text-slate-400" />
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 text-sm">
            {loading ? (
              Array.from({ length: 5 }).map((_, i) => (
                <tr key={i} className="h-10">
                  {columns.map((col) => (
                    <td key={col.key} className="px-4 py-2.5">
                      <div className="h-4 bg-slate-100 rounded animate-pulse" />
                    </td>
                  ))}
                </tr>
              ))
            ) : pageData.length === 0 ? (
              <tr>
                <td colSpan={columns.length} className="px-4 py-10 text-center text-slate-500">
                  <p className="text-sm">{emptyMessage}</p>
                  {emptyActionLabel && onEmptyAction && (
                    <button
                      type="button"
                      onClick={onEmptyAction}
                      className="mt-3 px-4 py-2 text-xs font-medium text-white bg-slate-900 rounded-md hover:bg-slate-800"
                    >
                      {emptyActionLabel}
                    </button>
                  )}
                </td>
              </tr>
            ) : (
              pageData.map((row, idx) => (
                <tr
                  key={String(row.id ?? idx)}
                  onClick={() => onRowClick?.(row)}
                  className={`h-10 transition-colors ${onRowClick ? 'cursor-pointer hover:bg-slate-50' : 'hover:bg-slate-50/70'}`}
                >
                  {columns.map((col) => (
                    <td
                      key={col.key}
                      className={`px-4 py-2 text-slate-700 ${
                        col.align === 'right' || col.numeric ? 'text-right font-mono tabular-nums text-xs' : 'text-left'
                      }`}
                    >
                      {col.render ? col.render(row) : String(row[col.key] ?? '')}
                    </td>
                  ))}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <div className="px-4 py-2.5 border-t border-slate-200 bg-slate-50 flex items-center justify-between text-xs text-slate-600 no-print">
        <span className="tabular-nums">
          Showing {sorted.length === 0 ? 0 : (safePage - 1) * pageSize + 1}–{Math.min(safePage * pageSize, sorted.length)} of {sorted.length} records
        </span>
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            disabled={safePage <= 1}
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            className="p-1 border border-slate-300 rounded bg-white disabled:opacity-40 hover:bg-slate-100"
          >
            <ChevronLeft className="w-4 h-4" />
          </button>
          <span className="px-2 tabular-nums">
            Page {safePage} / {totalPages}
          </span>
          <button
            type="button"
            disabled={safePage >= totalPages}
            onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
            className="p-1 border border-slate-300 rounded bg-white disabled:opacity-40 hover:bg-slate-100"
          >
            <ChevronRight className="w-4 h-4" />
          </button>
        </div>
      </div>
    </div>
  );
}
