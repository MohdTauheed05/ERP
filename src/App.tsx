import React, { useEffect, useState } from 'react';
import {
  Bell,
  Boxes,
  CheckSquare,
  ChevronLeft,
  ChevronRight,
  Database,
  Droplets,
  Factory,
  FlaskConical,
  LayoutDashboard,
  LogOut,
  Search,
  Settings,
  ShoppingCart,
  TrendingUp,
  Users,
  Wallet,
} from 'lucide-react';
import { apiRequest, setAuthToken } from './services/api';
import { useCompany } from './context/CompanyContext';
import type { ModuleKey, NotificationItem, RolePermission, SearchResult, User } from './types/erp';
import { AuthView } from './modules/auth/AuthView';
import { DashboardView } from './modules/dashboard/DashboardView';
import { MastersView } from './modules/masters/MastersView';
import { ProcurementView } from './modules/procurement/ProcurementView';
import { InventoryView } from './modules/inventory/InventoryView';
import { ManufacturingView } from './modules/manufacturing/ManufacturingView';
import { QualityView } from './modules/quality/QualityView';
import { SalesView } from './modules/sales/SalesView';
import { AccountingView } from './modules/accounting/AccountingView';
import { OperationsView } from './modules/operations/OperationsView';
import { ApprovalsAndAdminView } from './modules/settings/ApprovalsAndAdminView';
import { PdfPreviewHost } from './components/PdfPreviewHost';

const NAV_ITEMS: { id: ModuleKey; permModule: string; label: string; icon: React.ComponentType<{ className?: string }> }[] = [
  { id: 'dashboard', permModule: 'dashboard', label: 'Executive Dashboard', icon: LayoutDashboard },
  { id: 'masters', permModule: 'masters', label: 'Master Data', icon: Database },
  { id: 'procurement', permModule: 'procurement', label: 'Procurement & Subcontract', icon: ShoppingCart },
  { id: 'inventory', permModule: 'inventory', label: 'Inventory & MRP', icon: Boxes },
  { id: 'manufacturing', permModule: 'manufacturing', label: 'Blending & Manufacturing', icon: Factory },
  { id: 'quality', permModule: 'quality', label: 'Quality Lab & COA', icon: FlaskConical },
  { id: 'sales', permModule: 'sales', label: 'Sales & Distribution', icon: TrendingUp },
  { id: 'accounting', permModule: 'accounting', label: 'Accounting & UAE VAT', icon: Wallet },
  { id: 'operations', permModule: 'hr', label: 'HR, CRM & Projects', icon: Users },
  { id: 'approvals', permModule: 'dashboard', label: 'Approvals Center', icon: CheckSquare },
  { id: 'settings', permModule: 'settings', label: 'Admin, RBAC & Backups', icon: Settings },
];

export function App() {
  const { company, logoUrl, needsSetup, bootLoaded, setNeedsSetup } = useCompany();
  const [user, setUser] = useState<User | null>(null);
  const [permissions, setPermissions] = useState<RolePermission[]>([]);
  const [activeModule, setActiveModule] = useState<ModuleKey>('dashboard');
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);

  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [showSearch, setShowSearch] = useState(false);

  const [notifications, setNotifications] = useState<NotificationItem[]>([]);
  const [showNotifications, setShowNotifications] = useState(false);

  const loadNotifications = async () => {
    if (!user) return;
    try {
      const res = await apiRequest<{ items: NotificationItem[] }>('/api/system/notifications');
      setNotifications(res.items);
    } catch {
      // ignore transient notification errors
    }
  };

  useEffect(() => {
    if (user) {
      void loadNotifications();
    }
  }, [user, activeModule]);

  useEffect(() => {
    const q = searchQuery.trim();
    if (!q || !user) {
      setSearchResults([]);
      return;
    }
    const timer = setTimeout(() => {
      void apiRequest<{ results: SearchResult[] }>(`/api/system/search?q=${encodeURIComponent(q)}`)
        .then((r) => {
          setSearchResults(r.results);
          setShowSearch(true);
        })
        .catch(() => {});
    }, 200);
    return () => clearTimeout(timer);
  }, [searchQuery, user]);

  const canViewModule = (permModule: string) => {
    if (!user) return false;
    if (user.role_name === 'Super Admin') return true;
    const perm = permissions.find((p) => p.module === permModule);
    return perm ? perm.can_view === 1 : true;
  };

  const handleLogout = async () => {
    try {
      await apiRequest('/api/auth/logout', { method: 'POST' });
    } catch {
      // ignore
    }
    setAuthToken(null);
    setUser(null);
    setPermissions([]);
  };

  if (!bootLoaded) {
    return (
      <div className="min-h-screen bg-slate-900 text-slate-200 flex items-center justify-center text-sm font-medium">
        Initializing Enterprise ERP...
      </div>
    );
  }

  if (!user) {
    return (
      <AuthView
        needsSetup={needsSetup}
        onAuthenticated={(u, perms) => {
          setNeedsSetup(false);
          setUser(u);
          setPermissions(perms);
        }}
      />
    );
  }

  const unreadCount = notifications.filter((n) => !n.is_read).length;
  const visibleNav = NAV_ITEMS.filter((n) => canViewModule(n.permModule));
  const currentNav = NAV_ITEMS.find((n) => n.id === activeModule);
  const displayShortName = company.short_name || company.name || 'Enterprise ERP';

  return (
    <div className="min-h-screen flex bg-slate-50 text-slate-900">
      {/* Dark Navy Enterprise Sidebar */}
      <aside
        className={`${
          sidebarCollapsed ? 'w-16' : 'w-64'
        } bg-slate-900 text-slate-200 flex flex-col shrink-0 transition-all duration-150 no-print`}
      >
        <div className="h-14 px-3 border-b border-slate-800 flex items-center justify-between gap-2">
          <div className="flex items-center gap-2.5 min-w-0">
            {logoUrl ? (
              <div className="w-8 h-8 rounded-md bg-white p-0.5 flex items-center justify-center shrink-0 overflow-hidden">
                <img src={logoUrl} alt={displayShortName} className="max-w-full max-h-full object-contain" />
              </div>
            ) : (
              <div className="w-8 h-8 rounded-md bg-blue-600 text-white flex items-center justify-center shrink-0">
                <Droplets className="w-4 h-4" />
              </div>
            )}
            {!sidebarCollapsed && (
              <div className="min-w-0">
                <p className="text-sm font-semibold text-white truncate">{displayShortName}</p>
                <p className="text-[11px] text-slate-400 truncate">{company.currency || 'AED'} Enterprise</p>
              </div>
            )}
          </div>
          <button
            type="button"
            onClick={() => setSidebarCollapsed((c) => !c)}
            className="p-1 text-slate-400 hover:text-white rounded hover:bg-slate-800"
            title={sidebarCollapsed ? 'Expand navigation' : 'Collapse navigation'}
          >
            {sidebarCollapsed ? <ChevronRight className="w-4 h-4" /> : <ChevronLeft className="w-4 h-4" />}
          </button>
        </div>

        <nav className="flex-1 py-3 px-2 space-y-0.5 overflow-y-auto">
          {visibleNav.map((item) => {
            const Icon = item.icon;
            const active = activeModule === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => setActiveModule(item.id)}
                title={item.label}
                className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-md text-xs font-medium transition-colors ${
                  active ? 'bg-blue-600 text-white' : 'text-slate-300 hover:bg-slate-800 hover:text-white'
                }`}
              >
                <Icon className="w-4 h-4 shrink-0" />
                {!sidebarCollapsed && <span className="truncate">{item.label}</span>}
              </button>
            );
          })}
        </nav>

        <div className="p-3 border-t border-slate-800 text-xs">
          {!sidebarCollapsed && (
            <div className="mb-2">
              <p className="font-medium text-white truncate">{user.full_name}</p>
              <p className="text-[11px] text-slate-400 truncate">{user.role_name}</p>
            </div>
          )}
          <button
            type="button"
            onClick={() => void handleLogout()}
            className="w-full flex items-center justify-center gap-2 px-2.5 py-1.5 rounded bg-slate-800 hover:bg-slate-700 text-slate-200"
          >
            <LogOut className="w-3.5 h-3.5" />
            {!sidebarCollapsed && <span>Sign Out</span>}
          </button>
        </div>
      </aside>

      {/* Main Workspace */}
      <div className="flex-1 flex flex-col min-w-0">
        <header className="h-14 bg-white border-b border-slate-200 px-6 flex items-center justify-between gap-4 no-print">
          <div className="flex items-center gap-2.5 text-xs text-slate-500 min-w-0">
            {logoUrl && (
              <img src={logoUrl} alt={company.name} className="h-6 w-auto max-w-[96px] object-contain shrink-0" />
            )}
            <span className="font-semibold text-slate-900 truncate">{company.name}</span>
            <span>/</span>
            <span className="truncate text-slate-700">{currentNav?.label || 'Workspace'}</span>
          </div>

          <div className="flex items-center gap-3">
            {/* Global Search */}
            <div className="relative">
              <Search className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                onFocus={() => searchResults.length > 0 && setShowSearch(true)}
                placeholder="Global search (PO, SO, SKU, Batch, Customer)..."
                className="pl-8 pr-3 py-1.5 text-xs border border-slate-300 rounded-md w-72 focus:outline-none focus:ring-2 focus:ring-slate-900"
              />
              {showSearch && searchResults.length > 0 && (
                <div className="absolute right-0 mt-1 w-96 bg-white border border-slate-200 rounded-lg shadow-lg z-50 max-h-80 overflow-y-auto divide-y divide-slate-100">
                  <div className="px-3 py-2 bg-slate-50 flex items-center justify-between text-[11px] text-slate-500">
                    <span>Search Results ({searchResults.length})</span>
                    <button type="button" onClick={() => setShowSearch(false)} className="text-slate-600 hover:text-slate-900">Close</button>
                  </div>
                  {searchResults.map((res, i) => (
                    <button
                      key={`${res.type}-${res.id}-${i}`}
                      type="button"
                      onClick={() => {
                        setActiveModule(res.module);
                        setShowSearch(false);
                      }}
                      className="w-full px-3 py-2 text-left hover:bg-slate-50 flex items-center justify-between text-xs"
                    >
                      <div className="min-w-0 pr-2">
                        <p className="font-medium text-slate-900 truncate">{res.title}</p>
                        <p className="text-[11px] text-slate-500 truncate">{res.type} · {res.subtitle}</p>
                      </div>
                      <span className="font-mono text-[11px] text-slate-600 shrink-0">{res.number}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* Notifications */}
            <div className="relative">
              <button
                type="button"
                onClick={() => setShowNotifications((s) => !s)}
                className="relative p-2 text-slate-600 hover:text-slate-900 rounded-md hover:bg-slate-100"
                title="Notifications"
              >
                <Bell className="w-4 h-4" />
                {unreadCount > 0 && (
                  <span className="absolute -top-0.5 -right-0.5 px-1 min-w-[16px] h-4 bg-red-600 text-white text-[10px] font-mono rounded flex items-center justify-center">
                    {unreadCount}
                  </span>
                )}
              </button>
              {showNotifications && (
                <div className="absolute right-0 mt-1 w-96 bg-white border border-slate-200 rounded-lg shadow-lg z-50 max-h-96 overflow-y-auto">
                  <div className="px-3 py-2 border-b border-slate-200 flex items-center justify-between text-xs">
                    <span className="font-semibold text-slate-900">Alerts & Notifications</span>
                    <button
                      type="button"
                      onClick={async () => {
                        await apiRequest('/api/system/notifications/mark-read', { method: 'POST', body: '{}' });
                        await loadNotifications();
                      }}
                      className="text-slate-600 hover:text-slate-900"
                    >
                      Mark All Read
                    </button>
                  </div>
                  <div className="divide-y divide-slate-100">
                    {notifications.length === 0 ? (
                      <p className="p-4 text-xs text-slate-500">No active notifications.</p>
                    ) : (
                      notifications.map((n) => (
                        <div key={n.id} className={`p-3 text-xs ${n.is_read ? 'bg-white' : 'bg-blue-50/40'}`}>
                          <p className="font-semibold text-slate-900">{n.title}</p>
                          <p className="text-slate-600 mt-0.5">{n.message}</p>
                          <p className="text-[10px] text-slate-400 font-mono mt-1">{n.created_at.slice(0, 16).replace('T', ' ')}</p>
                        </div>
                      ))
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>
        </header>

        <main className="flex-1 p-6 overflow-x-hidden">
          {activeModule === 'dashboard' && <DashboardView onNavigate={(m) => setActiveModule(m)} />}
          {activeModule === 'masters' && <MastersView />}
          {activeModule === 'procurement' && <ProcurementView />}
          {activeModule === 'inventory' && <InventoryView />}
          {activeModule === 'manufacturing' && <ManufacturingView />}
          {activeModule === 'quality' && <QualityView />}
          {activeModule === 'sales' && <SalesView />}
          {activeModule === 'accounting' && <AccountingView />}
          {activeModule === 'operations' && <OperationsView />}
          {activeModule === 'approvals' && <ApprovalsAndAdminView initialTab="approvals" />}
          {activeModule === 'settings' && <ApprovalsAndAdminView initialTab="users" />}
        </main>
      </div>
      <PdfPreviewHost />
    </div>
  );
}

export default App;
