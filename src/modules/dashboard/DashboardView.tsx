import React, { useEffect, useState } from 'react';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from 'recharts';
import { Database, RefreshCw } from 'lucide-react';
import { apiRequest } from '../../services/api';
import type { ModuleKey } from '../../types/erp';

interface DashboardData {
  kpis: {
    totalPurchase: number;
    totalSales: number;
    inventoryValuation: number;
    rawMaterialStock: number;
    finishedGoodsStock: number;
    pendingPOs: number;
    pendingSOs: number;
    prodInProgress: number;
    supplierOutstanding: number;
    customerOutstanding: number;
    lowStockAlerts: number;
    overdueInvoices: number;
    pendingApprovals: number;
  };
  charts: {
    salesVsPurchase: { month: string; sales: number; purchases: number }[];
    monthlyProduction: { month: string; qty: number }[];
    stockByCategory: { category: string; value: number }[];
    topCustomers: { name: string; total: number }[];
    topSuppliers: { name: string; total: number }[];
  };
  recentAudit: { id: number; username: string; doc_type: string; doc_number: string; action: string; created_at: string }[];
}

export function DashboardView({ onNavigate }: { onNavigate: (mod: ModuleKey) => void }) {
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [seeding, setSeeding] = useState(false);
  const [notice, setNotice] = useState('');

  const load = async () => {
    setLoading(true);
    try {
      const res = await apiRequest<DashboardData>('/api/system/dashboard');
      setData(res);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const handleSeedSample = async () => {
    setSeeding(true);
    setNotice('');
    try {
      const res = await apiRequest<{ alreadyPopulated?: boolean; message?: string; itemsCreated?: number }>('/api/auth/seed-sample-lubricants', {
        method: 'POST',
      });
      setNotice(
        res.alreadyPopulated
          ? res.message || 'Master data already populated.'
          : `Loaded ${res.itemsCreated} lubricant & packaging items, BOM-0001, opening stock, and balanced opening GL entry.`
      );
      await load();
    } catch (e: unknown) {
      setNotice(e instanceof Error ? e.message : 'Failed to load sample dataset');
    } finally {
      setSeeding(false);
    }
  };

  const fmt = (n: number) => `AED ${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  if (loading || !data) {
    return (
      <div className="space-y-4">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="h-24 bg-white border border-slate-200 rounded-lg animate-pulse" />
          ))}
        </div>
      </div>
    );
  }

  const { kpis, charts, recentAudit } = data;
  const isCleanDb = kpis.inventoryValuation === 0 && kpis.totalSales === 0 && kpis.totalPurchase === 0;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-slate-900">Executive & Plant Operations Overview</h1>
          <p className="text-xs text-slate-500">Live figures computed from SQLite stock ledger, production orders, and general ledger</p>
        </div>
        <div className="flex items-center gap-2">
          {isCleanDb && (
            <button
              type="button"
              onClick={handleSeedSample}
              disabled={seeding}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-white bg-slate-900 rounded-md hover:bg-slate-800 whitespace-nowrap shrink-0"
            >
              <Database className="w-3.5 h-3.5" />
              {seeding ? 'Loading Lubricant Data...' : 'Load Sample Lubricant Plant Data'}
            </button>
          )}
          <button
            type="button"
            onClick={() => void load()}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded-md hover:bg-slate-50 whitespace-nowrap shrink-0"
          >
            <RefreshCw className="w-3.5 h-3.5" />
            Refresh
          </button>
        </div>
      </div>

      {notice && <div className="p-3 bg-sky-50 border border-sky-200 rounded-md text-xs text-sky-900">{notice}</div>}

      {/* Financial & Inventory KPIs */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="bg-white border border-slate-200 rounded-lg p-4">
          <p className="text-xs text-slate-500">Total Sales (Posted)</p>
          <p className="mt-1 text-lg font-semibold text-slate-900 font-mono tabular-nums">{fmt(kpis.totalSales)}</p>
          <p className="mt-1 text-[11px] text-slate-500 tabular-nums">AR Outstanding: {fmt(kpis.customerOutstanding)}</p>
        </div>
        <div className="bg-white border border-slate-200 rounded-lg p-4">
          <p className="text-xs text-slate-500">Total Purchases (Posted)</p>
          <p className="mt-1 text-lg font-semibold text-slate-900 font-mono tabular-nums">{fmt(kpis.totalPurchase)}</p>
          <p className="mt-1 text-[11px] text-slate-500 tabular-nums">AP Outstanding: {fmt(kpis.supplierOutstanding)}</p>
        </div>
        <div className="bg-white border border-slate-200 rounded-lg p-4">
          <p className="text-xs text-slate-500">Total Inventory Valuation</p>
          <p className="mt-1 text-lg font-semibold text-slate-900 font-mono tabular-nums">{fmt(kpis.inventoryValuation)}</p>
          <p className="mt-1 text-[11px] text-slate-500 tabular-nums">
            RM: {fmt(kpis.rawMaterialStock)} · FG: {fmt(kpis.finishedGoodsStock)}
          </p>
        </div>
        <div className="bg-white border border-slate-200 rounded-lg p-4">
          <p className="text-xs text-slate-500">Operational Queue</p>
          <div className="mt-1.5 grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
            <button type="button" onClick={() => onNavigate('procurement')} className="text-left text-slate-700 hover:text-slate-900 tabular-nums">
              Pending POs: <strong>{kpis.pendingPOs}</strong>
            </button>
            <button type="button" onClick={() => onNavigate('sales')} className="text-left text-slate-700 hover:text-slate-900 tabular-nums">
              Pending SOs: <strong>{kpis.pendingSOs}</strong>
            </button>
            <button type="button" onClick={() => onNavigate('manufacturing')} className="text-left text-slate-700 hover:text-slate-900 tabular-nums">
              Blending/Prod: <strong>{kpis.prodInProgress}</strong>
            </button>
            <button type="button" onClick={() => onNavigate('approvals')} className="text-left text-amber-700 hover:text-amber-900 tabular-nums">
              Approvals: <strong>{kpis.pendingApprovals}</strong>
            </button>
          </div>
        </div>
      </div>

      {/* Alert Strip */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <button
          type="button"
          onClick={() => onNavigate('inventory')}
          className="bg-white border border-slate-200 rounded-lg px-4 py-3 text-left hover:border-slate-300 flex items-center justify-between"
        >
          <span className="text-xs font-medium text-slate-700">Low Stock / Reorder Alerts</span>
          <span className={`text-sm font-mono font-semibold tabular-nums ${kpis.lowStockAlerts > 0 ? 'text-amber-600' : 'text-emerald-600'}`}>
            {kpis.lowStockAlerts} items
          </span>
        </button>
        <button
          type="button"
          onClick={() => onNavigate('accounting')}
          className="bg-white border border-slate-200 rounded-lg px-4 py-3 text-left hover:border-slate-300 flex items-center justify-between"
        >
          <span className="text-xs font-medium text-slate-700">Overdue Installments</span>
          <span className={`text-sm font-mono font-semibold tabular-nums ${kpis.overdueInvoices > 0 ? 'text-red-600' : 'text-emerald-600'}`}>
            {kpis.overdueInvoices} due
          </span>
        </button>
        <button
          type="button"
          onClick={() => onNavigate('approvals')}
          className="bg-white border border-slate-200 rounded-lg px-4 py-3 text-left hover:border-slate-300 flex items-center justify-between"
        >
          <span className="text-xs font-medium text-slate-700">Pending Approval Matrix Queue</span>
          <span className="text-sm font-mono font-semibold tabular-nums text-slate-900">{kpis.pendingApprovals} requests</span>
        </button>
      </div>

      {/* Charts */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="bg-white border border-slate-200 rounded-lg p-5">
          <h3 className="text-sm font-semibold text-slate-900 mb-4">Monthly Sales vs Purchases (AED)</h3>
          <div className="h-64">
            {charts.salesVsPurchase.length === 0 ? (
              <div className="h-full flex items-center justify-center text-xs text-slate-500">
                Post Purchase or Sales Invoices to populate monthly comparison.
              </div>
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={charts.salesVsPurchase}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                  <XAxis dataKey="month" tick={{ fontSize: 11 }} />
                  <YAxis tick={{ fontSize: 11 }} />
                  <Tooltip />
                  <Legend wrapperStyle={{ fontSize: 12 }} />
                  <Bar dataKey="sales" name="Sales" fill="#0f172a" radius={[3, 3, 0, 0]} />
                  <Bar dataKey="purchases" name="Purchases" fill="#64748b" radius={[3, 3, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            )}
          </div>
        </div>

        <div className="bg-white border border-slate-200 rounded-lg p-5">
          <h3 className="text-sm font-semibold text-slate-900 mb-4">Inventory Valuation by Category (AED)</h3>
          <div className="h-64">
            {charts.stockByCategory.length === 0 ? (
              <div className="h-full flex items-center justify-center text-xs text-slate-500">
                Receive goods or load sample plant stock to view category breakdown.
              </div>
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={charts.stockByCategory} layout="vertical">
                  <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                  <XAxis type="number" tick={{ fontSize: 11 }} />
                  <YAxis dataKey="category" type="category" width={130} tick={{ fontSize: 11 }} />
                  <Tooltip />
                  <Bar dataKey="value" name="Stock Value (AED)" fill="#1d4ed8" radius={[0, 3, 3, 0]} />
                </BarChart>
              </ResponsiveContainer>
            )}
          </div>
        </div>
      </div>

      {/* Audit Activity */}
      <div className="bg-white border border-slate-200 rounded-lg p-5">
        <h3 className="text-sm font-semibold text-slate-900 mb-3">Recent System & Transaction Activity</h3>
        {recentAudit.length === 0 ? (
          <p className="text-xs text-slate-500">No transactions recorded yet.</p>
        ) : (
          <div className="divide-y divide-slate-100 text-xs">
            {recentAudit.map((a) => (
              <div key={a.id} className="py-2 flex items-center justify-between gap-4">
                <div className="flex items-center gap-2 min-w-0">
                  <span className="font-mono font-medium text-slate-900">{a.doc_number || a.doc_type}</span>
                  <span className="text-slate-400">·</span>
                  <span className="text-slate-700 truncate">{a.action}</span>
                </div>
                <div className="text-slate-500 shrink-0 tabular-nums">
                  <span>{a.username}</span>
                  <span className="mx-1.5">·</span>
                  <span className="font-mono">{a.created_at.slice(0, 16).replace('T', ' ')}</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
