import React, { useEffect, useState } from 'react';
import { Building2, CheckCircle2, Database, Download, FileText, HardDrive, ImageUp, Plus, RotateCcw, Shield, ShieldCheck, Trash2, XCircle } from 'lucide-react';
import { apiRequest, downloadProtectedFile } from '../../services/api';
import { DataTable, type ColumnDef } from '../../components/DataTable';
import { useCompany } from '../../context/CompanyContext';
import { exportStandardErpPdf } from '../../utils/export';
import type { CompanyProfile, RolePermission } from '../../types/erp';

type AdminTab = 'company' | 'approvals' | 'rules' | 'users' | 'roles' | 'sequences' | 'settings' | 'backups' | 'audit';

export function ApprovalsAndAdminView({ initialTab = 'approvals' }: { initialTab?: AdminTab }) {
  const { logoUrl, refreshCompany } = useCompany();
  const [tab, setTab] = useState<AdminTab>(initialTab);
  const [approvals, setApprovals] = useState<{ rules: Record<string, unknown>[]; requests: Record<string, unknown>[]; history: Record<string, unknown>[] }>({
    rules: [],
    requests: [],
    history: [],
  });
  const [users, setUsers] = useState<Record<string, unknown>[]>([]);
  const [roles, setRoles] = useState<{ id: number; name: string; description: string; is_system: number }[]>([]);
  const [permissions, setPermissions] = useState<RolePermission[]>([]);
  const [selectedRoleId, setSelectedRoleId] = useState<number>(1);
  const [settingsData, setSettingsData] = useState<{
    settings: { id: number; key: string; value: string; description: string; category: string }[];
    sequences: { id: number; doc_type: string; prefix: string; next_number: number; digits: number; financial_year: string; include_fy: number }[];
    dbEngine: string;
  }>({ settings: [], sequences: [], dbEngine: 'SQLite (Local)' });
  const [backups, setBackups] = useState<Record<string, unknown>[]>([]);
  const [auditLogs, setAuditLogs] = useState<Record<string, unknown>[]>([]);
  const [integrityResult, setIntegrityResult] = useState<Record<string, unknown> | null>(null);
  const [companyForm, setCompanyForm] = useState<Partial<CompanyProfile>>({
    name: '',
    short_name: '',
    address: '',
    po_box: '',
    country: 'UNITED ARAB EMIRATES',
    trn: '',
    telephone: '',
    email: '',
    website: '',
    currency: 'AED',
    vat_rate: 5,
  });
  const [uploadingLogo, setUploadingLogo] = useState(false);

  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');

  const [showUserModal, setShowUserModal] = useState(false);
  const [userForm, setUserForm] = useState({ username: '', email: '', full_name: '', password: '', role_id: 2, department: 'Operations' });
  const [showRuleModal, setShowRuleModal] = useState(false);
  const [ruleForm, setRuleForm] = useState({ doc_type: 'PurchaseOrder', department: '', role_id: 1, min_amount: '0', max_amount: '', currency: 'AED', priority: '1' });
  const [newRoleName, setNewRoleName] = useState('');

  const loadAll = async () => {
    setLoading(true);
    try {
      const [appRes, uRes, rRes, sRes, bRes, aRes, cRes] = await Promise.all([
        apiRequest<typeof approvals>('/api/system/approvals'),
        apiRequest<{ items: Record<string, unknown>[] }>('/api/admin/users').catch(() => ({ items: [] })),
        apiRequest<{ roles: typeof roles; permissions: RolePermission[] }>('/api/admin/roles'),
        apiRequest<typeof settingsData>('/api/system/settings').catch(() => ({ settings: [], sequences: [], dbEngine: 'SQLite (Local)' })),
        apiRequest<{ items: Record<string, unknown>[] }>('/api/system/backups').catch(() => ({ items: [] })),
        apiRequest<{ items: Record<string, unknown>[] }>('/api/system/audit-logs').catch(() => ({ items: [] })),
        apiRequest<{ company: CompanyProfile | null }>('/api/masters/company').catch(() => ({ company: null })),
      ]);
      setApprovals(appRes);
      setUsers(uRes.items);
      setRoles(rRes.roles);
      setPermissions(rRes.permissions);
      setSettingsData(sRes);
      setBackups(bRes.items);
      setAuditLogs(aRes.items);
      if (cRes.company) setCompanyForm(cRes.company);
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : 'Failed to load administration data');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    setTab(initialTab);
  }, [initialTab]);

  useEffect(() => {
    void loadAll();
  }, []);

  const saveCompanyProfile = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr('');
    setMsg('');
    try {
      await apiRequest('/api/masters/company', {
        method: 'PUT',
        body: JSON.stringify({
          ...companyForm,
          vat_rate: Number(companyForm.vat_rate ?? 5),
        }),
      });
      await refreshCompany();
      await loadAll();
      setMsg('Company Name, Address, TRN and branding updated across the ERP and all PDF documents.');
    } catch (ex: unknown) {
      setErr(ex instanceof Error ? ex.message : 'Failed to update company profile');
    }
  };

  const handleLogoUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setErr('');
    setMsg('');
    setUploadingLogo(true);
    try {
      const fd = new FormData();
      fd.append('logo', file);
      await apiRequest('/api/masters/company/logo', {
        method: 'POST',
        body: fd,
      });
      await refreshCompany();
      await loadAll();
      setMsg('Company logo uploaded and applied to UI header and all ERP PDFs.');
    } catch (ex: unknown) {
      setErr(ex instanceof Error ? ex.message : 'Failed to upload company logo');
    } finally {
      setUploadingLogo(false);
      e.target.value = '';
    }
  };

  const handleRemoveLogo = async () => {
    setErr('');
    setMsg('');
    try {
      await apiRequest('/api/masters/company/logo', { method: 'DELETE' });
      await refreshCompany();
      await loadAll();
      setMsg('Company logo removed.');
    } catch (ex: unknown) {
      setErr(ex instanceof Error ? ex.message : 'Failed to remove logo');
    }
  };

  const previewSamplePdf = () => {
    void exportStandardErpPdf({
      docTitle: 'PURCHASE ORDER',
      docNumberLabel: 'PO No.',
      docNumber: 'PO-2026-SAMPLE',
      docDate: new Date().toISOString().slice(0, 10),
      company: companyForm,
      logoUrl,
      companyRole: 'Buyer',
      partyRole: 'Seller',
      partyName: 'Sample Raw Materials & Packaging LLC',
      partyTrn: '100234567800003',
      partyAddress: 'Industrial Area, Jebel Ali, Dubai',
      partyCountry: 'UNITED ARAB EMIRATES',
      partyContactPerson: 'Procurement Desk',
      paymentTerms: '60 DAYS PDC',
      deliveryTerms: 'DDP Plant Warehouse',
      deliveryDate: new Date().toISOString().slice(0, 10),
      deliveryPlace: companyForm.address || 'Plant Warehouse',
      partyRefLabel: 'Suppliers Ref. No.',
      partyRefNo: 'QTN-SAMPLE-01',
      exchangeRate: '1.0',
      revisionNo: 'Original',
      revisionDate: '',
      currency: companyForm.currency || 'AED',
      items: [
        {
          item_code: 'RM-CAN-GLD-1L',
          description: 'EMPTY CAN (1L) GOLD C.M',
          qty: 5000,
          uom: 'PCS',
          unit_price: 2.4,
          vat_pct: Number(companyForm.vat_rate ?? 5),
          vat_amount: 600,
          total: 12600,
        },
        {
          item_code: 'RM-SN150',
          description: 'Virgin Base Oil SN150 (Tanker Bulk)',
          qty: 10000,
          uom: 'LTR',
          unit_price: 4.5,
          vat_pct: Number(companyForm.vat_rate ?? 5),
          vat_amount: 2250,
          total: 47250,
        },
      ],
      netTotal: 57000,
      vatTotal: 2850,
      grandTotal: 59850,
      remarks: 'Sample official ERP document preview with Admin-configured Company Name and Logo.',
      preparedBy: 'Admin Preview',
      reviewedBy: 'Finance Control',
      authorizedBy: 'Managing Director',
      creatorName: 'System Administrator',
      filename: 'Sample_ERP_Document_Preview',
    });
  };

  const decideApproval = async (id: number, decision: 'Approved' | 'Rejected' | 'Changes Requested') => {
    setErr('');
    try {
      await apiRequest(`/api/system/approvals/requests/${id}/decide`, {
        method: 'POST',
        body: JSON.stringify({ decision, comments: `${decision} from Approval Center` }),
      });
      setMsg(`Approval request marked ${decision}.`);
      await loadAll();
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : 'Approval action failed');
    }
  };

  const rolePerms = permissions.filter((p) => p.role_id === selectedRoleId);

  const togglePerm = (module: string, field: keyof RolePermission) => {
    setPermissions((prev) =>
      prev.map((p) => (p.role_id === selectedRoleId && p.module === module ? { ...p, [field]: p[field] ? 0 : 1 } : p))
    );
  };

  const savePermissions = async () => {
    setErr('');
    try {
      await apiRequest(`/api/admin/roles/${selectedRoleId}/permissions`, {
        method: 'PUT',
        body: JSON.stringify({ permissions: rolePerms }),
      });
      setMsg('Role permissions matrix saved.');
      await loadAll();
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : 'Failed to save permissions');
    }
  };

  const reqCols: ColumnDef<Record<string, unknown>>[] = [
    { key: 'doc_type', header: 'Document Type' },
    { key: 'doc_number', header: 'Doc #' },
    { key: 'amount', header: 'Amount', numeric: true, render: (r) => `${String(r.currency)} ${Number(r.amount || 0).toFixed(2)}` },
    { key: 'required_role_name', header: 'Required Approver' },
    { key: 'requested_by_name', header: 'Requested By' },
    { key: 'status', header: 'Status' },
    {
      key: 'actions',
      header: 'Decision',
      render: (r) =>
        r.status === 'Pending' ? (
          <div className="flex items-center gap-1.5">
            <button type="button" onClick={() => void decideApproval(Number(r.id), 'Approved')} className="inline-flex items-center gap-1 px-2 py-1 text-xs font-medium bg-emerald-700 text-white rounded hover:bg-emerald-800">
              <CheckCircle2 className="w-3 h-3" /> Approve
            </button>
            <button type="button" onClick={() => void decideApproval(Number(r.id), 'Rejected')} className="inline-flex items-center gap-1 px-2 py-1 text-xs font-medium bg-red-600 text-white rounded hover:bg-red-700">
              <XCircle className="w-3 h-3" /> Reject
            </button>
            <button type="button" onClick={() => void decideApproval(Number(r.id), 'Changes Requested')} className="px-2 py-1 text-xs border border-slate-300 rounded hover:bg-slate-50">
              Changes
            </button>
          </div>
        ) : (
          <span className="text-xs text-slate-500">{String(r.decided_at || '').slice(0, 10)}</span>
        ),
    },
  ];

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-slate-900">Approval Matrix, Company Branding & System Administration</h1>
          <p className="text-xs text-slate-500">Company name & replaceable logo for UI/PDFs, approval thresholds, RBAC roles, document numbering & database backups</p>
        </div>
        <div className="text-xs font-mono px-3 py-1.5 bg-slate-100 border border-slate-200 rounded">
          Active Engine: {settingsData.dbEngine}
        </div>
      </div>

      <div className="flex flex-wrap gap-1 p-1 bg-slate-100 rounded-lg w-fit">
        {[
          { id: 'company', label: 'Company & Branding' },
          { id: 'approvals', label: 'Approval Queue' },
          { id: 'rules', label: 'Approval Rules' },
          { id: 'users', label: 'Users' },
          { id: 'roles', label: 'Roles & Permissions' },
          { id: 'sequences', label: 'Document Numbering' },
          { id: 'settings', label: 'System Settings' },
          { id: 'backups', label: 'Backup & Migration' },
          { id: 'audit', label: 'Audit Trail' },
        ].map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setTab(t.id as AdminTab)}
            className={`px-3 py-1.5 text-xs font-medium rounded-md whitespace-nowrap shrink-0 ${
              tab === t.id ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {msg && <div className="p-3 bg-emerald-50 border border-emerald-200 rounded text-xs text-emerald-800">{msg}</div>}
      {err && <div className="p-3 bg-red-50 border border-red-200 rounded text-xs text-red-700">{err}</div>}

      {tab === 'company' && (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <form onSubmit={saveCompanyProfile} className="lg:col-span-2 bg-white border border-slate-200 rounded-lg p-6 space-y-4">
            <div className="flex items-center justify-between border-b border-slate-100 pb-3">
              <div className="flex items-center gap-2">
                <Building2 className="w-4 h-4 text-slate-700" />
                <h3 className="text-sm font-semibold text-slate-900">Company Identity & Official PDF Header Details</h3>
              </div>
              <button
                type="button"
                onClick={previewSamplePdf}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium border border-slate-300 rounded hover:bg-slate-50 text-slate-700"
              >
                <FileText className="w-3.5 h-3.5" /> Preview Sample PDF (PO Format)
              </button>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs">
              <div>
                <label className="block font-medium text-slate-700 mb-1">Company Legal Name (Appears on ERP & PDFs)</label>
                <input
                  required
                  value={String(companyForm.name ?? '')}
                  onChange={(e) => setCompanyForm({ ...companyForm, name: e.target.value })}
                  placeholder="Enter Company Name"
                  className="w-full px-3 py-1.5 border border-slate-300 rounded"
                />
              </div>
              <div>
                <label className="block font-medium text-slate-700 mb-1">Short Name / App Header Label</label>
                <input
                  value={String(companyForm.short_name ?? '')}
                  onChange={(e) => setCompanyForm({ ...companyForm, short_name: e.target.value })}
                  placeholder="e.g. AL-NISR ERP"
                  className="w-full px-3 py-1.5 border border-slate-300 rounded"
                />
              </div>
              <div>
                <label className="block font-medium text-slate-700 mb-1">TRN / Tax Registration Number</label>
                <input
                  value={String(companyForm.trn ?? '')}
                  onChange={(e) => setCompanyForm({ ...companyForm, trn: e.target.value })}
                  className="w-full px-3 py-1.5 border border-slate-300 rounded font-mono"
                />
              </div>
              <div>
                <label className="block font-medium text-slate-700 mb-1">P.O. Box</label>
                <input
                  value={String(companyForm.po_box ?? '')}
                  onChange={(e) => setCompanyForm({ ...companyForm, po_box: e.target.value })}
                  placeholder="e.g. P.O. Box 12345"
                  className="w-full px-3 py-1.5 border border-slate-300 rounded"
                />
              </div>
              <div>
                <label className="block font-medium text-slate-700 mb-1">Country</label>
                <input
                  value={String(companyForm.country ?? '')}
                  onChange={(e) => setCompanyForm({ ...companyForm, country: e.target.value })}
                  className="w-full px-3 py-1.5 border border-slate-300 rounded"
                />
              </div>
              <div>
                <label className="block font-medium text-slate-700 mb-1">Telephone</label>
                <input
                  value={String(companyForm.telephone ?? '')}
                  onChange={(e) => setCompanyForm({ ...companyForm, telephone: e.target.value })}
                  className="w-full px-3 py-1.5 border border-slate-300 rounded"
                />
              </div>
              <div>
                <label className="block font-medium text-slate-700 mb-1">Email</label>
                <input
                  value={String(companyForm.email ?? '')}
                  onChange={(e) => setCompanyForm({ ...companyForm, email: e.target.value })}
                  className="w-full px-3 py-1.5 border border-slate-300 rounded"
                />
              </div>
              <div>
                <label className="block font-medium text-slate-700 mb-1">Website</label>
                <input
                  value={String(companyForm.website ?? '')}
                  onChange={(e) => setCompanyForm({ ...companyForm, website: e.target.value })}
                  className="w-full px-3 py-1.5 border border-slate-300 rounded"
                />
              </div>
              <div>
                <label className="block font-medium text-slate-700 mb-1">Base Currency</label>
                <input
                  value={String(companyForm.currency ?? 'AED')}
                  onChange={(e) => setCompanyForm({ ...companyForm, currency: e.target.value.toUpperCase() })}
                  className="w-full px-3 py-1.5 border border-slate-300 rounded font-mono"
                />
              </div>
              <div>
                <label className="block font-medium text-slate-700 mb-1">Default VAT Rate (%)</label>
                <input
                  type="number"
                  step="0.1"
                  value={String(companyForm.vat_rate ?? 5)}
                  onChange={(e) => setCompanyForm({ ...companyForm, vat_rate: Number(e.target.value) })}
                  className="w-full px-3 py-1.5 border border-slate-300 rounded font-mono"
                />
              </div>
              <div className="md:col-span-2">
                <label className="block font-medium text-slate-700 mb-1">Address (Appears in Buyer/Seller block on all PDFs)</label>
                <textarea
                  rows={2}
                  value={String(companyForm.address ?? '')}
                  onChange={(e) => setCompanyForm({ ...companyForm, address: e.target.value })}
                  className="w-full px-3 py-1.5 border border-slate-300 rounded"
                />
              </div>
            </div>
            <div className="pt-2">
              <button type="submit" className="px-4 py-2 text-xs font-medium bg-slate-900 text-white rounded hover:bg-slate-800">
                Save Company Details
              </button>
            </div>
          </form>

          <div className="bg-white border border-slate-200 rounded-lg p-6 space-y-4">
            <h3 className="text-sm font-semibold text-slate-900 border-b border-slate-100 pb-3">Company Logo (UI & PDF Letterhead)</h3>
            <div className="border border-dashed border-slate-300 rounded-lg p-5 flex flex-col items-center justify-center bg-slate-50 min-h-[150px]">
              {logoUrl ? (
                <img src={logoUrl} alt={companyForm.name || 'Company Logo'} className="max-h-24 max-w-full object-contain" />
              ) : (
                <div className="text-center text-xs text-slate-400 space-y-1">
                  <Building2 className="w-8 h-8 mx-auto text-slate-300" />
                  <p>No custom logo uploaded</p>
                  <p className="text-[11px]">Upload PNG, JPEG, or WebP (max 5MB)</p>
                </div>
              )}
            </div>
            <p className="text-[11px] text-slate-500">
              Your uploaded logo appears automatically in the navigation sidebar, login page, and top/bottom of every Purchase Order, Sales Order, Tax Invoice, GRN, and COA PDF.
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <label className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium bg-slate-900 text-white rounded hover:bg-slate-800 cursor-pointer">
                <ImageUp className="w-3.5 h-3.5" />
                {uploadingLogo ? 'Uploading...' : logoUrl ? 'Replace Logo' : 'Upload Logo'}
                <input
                  type="file"
                  accept="image/png,image/jpeg,image/webp"
                  disabled={uploadingLogo}
                  onChange={handleLogoUpload}
                  className="hidden"
                />
              </label>
              {logoUrl && (
                <button
                  type="button"
                  onClick={() => void handleRemoveLogo()}
                  className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium border border-red-200 text-red-700 rounded hover:bg-red-50"
                >
                  <Trash2 className="w-3.5 h-3.5" /> Remove Logo
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {tab === 'approvals' && (
        <DataTable title="Pending & Historical Approval Requests" columns={reqCols} data={approvals.requests} loading={loading} statusFilterKey="status" statusOptions={['Pending', 'Approved', 'Rejected']} exportFilename="approval_requests" />
      )}

      {tab === 'rules' && (
        <div className="space-y-3">
          <div className="flex justify-end">
            <button type="button" onClick={() => setShowRuleModal(true)} className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-slate-900 text-white rounded-md">
              <Plus className="w-3.5 h-3.5" /> Add Approval Threshold Rule
            </button>
          </div>
          <DataTable
            title="Configurable Approval Matrix"
            columns={[
              { key: 'doc_type', header: 'Document Type' },
              { key: 'role_name', header: 'Required Role' },
              { key: 'min_amount', header: 'Min Amount', numeric: true, render: (r) => Number(r.min_amount || 0).toFixed(2) },
              { key: 'max_amount', header: 'Max Amount', numeric: true, render: (r) => (r.max_amount !== null ? Number(r.max_amount).toFixed(2) : 'Unlimited') },
              { key: 'currency', header: 'Currency' },
              { key: 'priority', header: 'Priority', numeric: true },
            ]}
            data={approvals.rules}
            exportFilename="approval_rules"
          />
        </div>
      )}

      {tab === 'users' && (
        <div className="space-y-3">
          <div className="flex justify-end">
            <button type="button" onClick={() => setShowUserModal(true)} className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-slate-900 text-white rounded-md">
              <Plus className="w-3.5 h-3.5" /> Create User
            </button>
          </div>
          <DataTable
            title="System Users"
            columns={[
              { key: 'username', header: 'Username' },
              { key: 'full_name', header: 'Full Name' },
              { key: 'email', header: 'Email' },
              { key: 'role_name', header: 'Role' },
              { key: 'department', header: 'Department' },
              { key: 'is_active', header: 'Active', render: (r) => (r.is_active ? 'Active' : 'Disabled') },
              { key: 'last_login_at', header: 'Last Login' },
            ]}
            data={users}
            exportFilename="erp_users"
          />
        </div>
      )}

      {tab === 'roles' && (
        <div className="bg-white border border-slate-200 rounded-lg p-5 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-3 text-xs">
              <Shield className="w-4 h-4 text-slate-600" />
              <span className="font-semibold text-slate-900">Select Role:</span>
              <select value={selectedRoleId} onChange={(e) => setSelectedRoleId(Number(e.target.value))} className="px-3 py-1.5 border border-slate-300 rounded">
                {roles.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
              </select>
            </div>
            <div className="flex items-center gap-2 text-xs">
              <input placeholder="New Custom Role Name" value={newRoleName} onChange={(e) => setNewRoleName(e.target.value)} className="px-2.5 py-1.5 border border-slate-300 rounded" />
              <button
                type="button"
                onClick={async () => {
                  if (!newRoleName.trim()) return;
                  await apiRequest('/api/admin/roles', { method: 'POST', body: JSON.stringify({ name: newRoleName }) });
                  setNewRoleName('');
                  setMsg('Custom role created.');
                  await loadAll();
                }}
                className="px-3 py-1.5 border border-slate-300 rounded hover:bg-slate-50 font-medium"
              >
                Add Role
              </button>
              <button type="button" onClick={() => void savePermissions()} className="px-4 py-1.5 bg-slate-900 text-white rounded font-medium hover:bg-slate-800">
                Save Matrix
              </button>
            </div>
          </div>

          <div className="overflow-x-auto border border-slate-200 rounded">
            <table className="w-full text-left text-xs">
              <thead className="bg-slate-50 border-b border-slate-200">
                <tr>
                  <th className="px-3 py-2">Module</th>
                  {(['can_view', 'can_create', 'can_edit', 'can_delete', 'can_submit', 'can_cancel', 'can_approve', 'can_export', 'can_print'] as const).map((k) => (
                    <th key={k} className="px-2 py-2 text-center capitalize">{k.replace('can_', '')}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {rolePerms.map((p) => (
                  <tr key={p.module}>
                    <td className="px-3 py-2 font-medium capitalize text-slate-900">{p.module}</td>
                    {(['can_view', 'can_create', 'can_edit', 'can_delete', 'can_submit', 'can_cancel', 'can_approve', 'can_export', 'can_print'] as const).map((k) => (
                      <td key={k} className="px-2 py-2 text-center">
                        <input type="checkbox" checked={Boolean(p[k])} onChange={() => togglePerm(p.module, k)} />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {tab === 'sequences' && (
        <div className="bg-white border border-slate-200 rounded-lg p-5">
          <h3 className="text-sm font-semibold text-slate-900 mb-3">Automatic Document Numbering Series</h3>
          <table className="w-full text-left text-xs border border-slate-200">
            <thead className="bg-slate-50 border-b border-slate-200">
              <tr>
                <th className="px-3 py-2">Doc Type</th>
                <th className="px-3 py-2">Prefix</th>
                <th className="px-3 py-2">FY</th>
                <th className="px-3 py-2">Next #</th>
                <th className="px-3 py-2">Digits</th>
                <th className="px-3 py-2">Sample</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 font-mono">
              {settingsData.sequences.map((s) => (
                <tr key={s.id}>
                  <td className="px-3 py-2 font-sans font-medium">{s.doc_type}</td>
                  <td className="px-3 py-2">{s.prefix}</td>
                  <td className="px-3 py-2">{s.include_fy ? s.financial_year : '-'}</td>
                  <td className="px-3 py-2">{s.next_number}</td>
                  <td className="px-3 py-2">{s.digits}</td>
                  <td className="px-3 py-2 text-slate-700">
                    {s.prefix}-{s.include_fy ? `${s.financial_year}-` : ''}{String(s.next_number).padStart(s.digits, '0')}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {tab === 'settings' && (
        <div className="bg-white border border-slate-200 rounded-lg p-5 space-y-3">
          <h3 className="text-sm font-semibold text-slate-900">ERP System Controls</h3>
          <div className="divide-y divide-slate-100">
            {settingsData.settings.map((st) => (
              <div key={st.key} className="py-3 flex flex-wrap items-center justify-between gap-3 text-xs">
                <div>
                  <p className="font-medium text-slate-900">{st.key}</p>
                  <p className="text-slate-500">{st.description}</p>
                </div>
                <div className="flex items-center gap-2">
                  <input
                    value={st.value}
                    onChange={(e) => {
                      const val = e.target.value;
                      setSettingsData((prev) => ({
                        ...prev,
                        settings: prev.settings.map((x) => (x.key === st.key ? { ...x, value: val } : x)),
                      }));
                    }}
                    className="px-2.5 py-1 border border-slate-300 rounded font-mono w-40"
                  />
                  <button
                    type="button"
                    onClick={async () => {
                      await apiRequest('/api/system/settings', { method: 'PUT', body: JSON.stringify({ key: st.key, value: st.value }) });
                      setMsg(`Setting ${st.key} saved.`);
                    }}
                    className="px-3 py-1 bg-slate-900 text-white rounded"
                  >
                    Save
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {tab === 'backups' && (
        <div className="space-y-4">
          <div className="bg-white border border-slate-200 rounded-lg p-5 flex flex-wrap items-center justify-between gap-3">
            <div className="text-xs">
              <h3 className="text-sm font-semibold text-slate-900">Database Backup, Integrity Verification & PostgreSQL Migration</h3>
              <p className="text-slate-500">Create atomic SQLite snapshots, validate double-entry & foreign-key integrity, or export normalized JSON for PostgreSQL server migration.</p>
            </div>
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <button
                type="button"
                onClick={async () => {
                  const res = await apiRequest<Record<string, unknown>>('/api/system/backups/integrity-check', { method: 'POST' });
                  setIntegrityResult(res);
                }}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 border border-slate-300 rounded hover:bg-slate-50 font-medium"
              >
                <ShieldCheck className="w-3.5 h-3.5 text-emerald-700" /> Integrity Check
              </button>
              <button
                type="button"
                onClick={() => downloadProtectedFile('/api/system/backups/postgres-export', 'lubricants_erp_pg_migration_bundle.json')}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 border border-slate-300 rounded hover:bg-slate-50 font-medium"
              >
                <Database className="w-3.5 h-3.5" /> Export PostgreSQL Bundle
              </button>
              <button
                type="button"
                onClick={async () => {
                  const res = await apiRequest<{ file_name: string }>('/api/system/backups/create', { method: 'POST' });
                  setMsg(`Backup ${res.file_name} created.`);
                  await loadAll();
                }}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-slate-900 text-white rounded font-medium hover:bg-slate-800"
              >
                <HardDrive className="w-3.5 h-3.5" /> Create Backup Snapshot
              </button>
            </div>
          </div>

          {integrityResult && (
            <div className="bg-white border border-slate-200 rounded-lg p-4 text-xs font-mono grid grid-cols-2 md:grid-cols-4 gap-3">
              <div>SQLite PRAGMA: <span className="font-semibold text-emerald-700">{String(integrityResult.sqlite_integrity)}</span></div>
              <div>FK Violations: <span className="font-semibold">{String(integrityResult.foreign_key_violations)}</span></div>
              <div>Trial Balance Diff: <span className="font-semibold">AED {String(integrityResult.accounting_trial_balance_diff)}</span></div>
              <div>Status: <span className="font-semibold text-emerald-700">{integrityResult.healthy ? 'HEALTHY' : 'ATTENTION'}</span></div>
            </div>
          )}

          <DataTable
            title="Backup Snapshots"
            columns={[
              { key: 'file_name', header: 'Backup File' },
              { key: 'backup_type', header: 'Type' },
              { key: 'size_bytes', header: 'Size (KB)', numeric: true, render: (r) => (Number(r.size_bytes || 0) / 1024).toFixed(1) },
              { key: 'created_at', header: 'Created At' },
              {
                key: 'actions',
                header: 'Actions',
                render: (r) => (
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => downloadProtectedFile(`/api/system/backups/${r.id}/download`, String(r.file_name))}
                      className="inline-flex items-center gap-1 px-2 py-1 text-xs border border-slate-300 rounded hover:bg-slate-50"
                    >
                      <Download className="w-3 h-3" /> Download
                    </button>
                    <button
                      type="button"
                      onClick={async () => {
                        const res = await apiRequest<{ message: string }>(`/api/system/backups/${r.id}/restore`, { method: 'POST' });
                        setMsg(res.message);
                      }}
                      className="inline-flex items-center gap-1 px-2 py-1 text-xs border border-amber-300 text-amber-800 rounded hover:bg-amber-50"
                    >
                      <RotateCcw className="w-3 h-3" /> Restore
                    </button>
                  </div>
                ),
              },
            ]}
            data={backups}
            exportFilename="backup_history"
          />
        </div>
      )}

      {tab === 'audit' && (
        <DataTable
          title="System Audit Trail"
          columns={[
            { key: 'created_at', header: 'Timestamp' },
            { key: 'username', header: 'User' },
            { key: 'role_name', header: 'Role' },
            { key: 'doc_type', header: 'Document Type' },
            { key: 'doc_number', header: 'Doc #' },
            { key: 'action', header: 'Action' },
          ]}
          data={auditLogs}
          exportFilename="audit_logs"
        />
      )}

      {showUserModal && (
        <div className="fixed inset-0 bg-slate-900/40 z-50 flex items-center justify-center p-4">
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              await apiRequest('/api/admin/users', { method: 'POST', body: JSON.stringify(userForm) });
              setShowUserModal(false);
              setMsg('User created.');
              await loadAll();
            }}
            className="bg-white border border-slate-200 rounded-lg w-full max-w-md p-6 space-y-3 text-xs"
          >
            <h3 className="text-base font-semibold text-slate-900">Create ERP User</h3>
            <input required placeholder="Username" value={userForm.username} onChange={(e) => setUserForm({ ...userForm, username: e.target.value })} className="w-full px-3 py-1.5 border border-slate-300 rounded" />
            <input required placeholder="Full Name" value={userForm.full_name} onChange={(e) => setUserForm({ ...userForm, full_name: e.target.value })} className="w-full px-3 py-1.5 border border-slate-300 rounded" />
            <input required type="email" placeholder="Email" value={userForm.email} onChange={(e) => setUserForm({ ...userForm, email: e.target.value })} className="w-full px-3 py-1.5 border border-slate-300 rounded" />
            <input required type="password" minLength={6} placeholder="Password (min 6 chars)" value={userForm.password} onChange={(e) => setUserForm({ ...userForm, password: e.target.value })} className="w-full px-3 py-1.5 border border-slate-300 rounded" />
            <div className="grid grid-cols-2 gap-2">
              <select value={userForm.role_id} onChange={(e) => setUserForm({ ...userForm, role_id: Number(e.target.value) })} className="px-3 py-1.5 border border-slate-300 rounded">
                {roles.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
              </select>
              <input placeholder="Department" value={userForm.department} onChange={(e) => setUserForm({ ...userForm, department: e.target.value })} className="px-3 py-1.5 border border-slate-300 rounded" />
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <button type="button" onClick={() => setShowUserModal(false)} className="px-3 py-1.5 border border-slate-300 rounded">Cancel</button>
              <button type="submit" className="px-4 py-1.5 bg-slate-900 text-white rounded font-medium">Create User</button>
            </div>
          </form>
        </div>
      )}

      {showRuleModal && (
        <div className="fixed inset-0 bg-slate-900/40 z-50 flex items-center justify-center p-4">
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              await apiRequest('/api/system/approvals/rules', { method: 'POST', body: JSON.stringify(ruleForm) });
              setShowRuleModal(false);
              setMsg('Approval rule added.');
              await loadAll();
            }}
            className="bg-white border border-slate-200 rounded-lg w-full max-w-md p-6 space-y-3 text-xs"
          >
            <h3 className="text-base font-semibold text-slate-900">Add Approval Threshold Rule</h3>
            <select value={ruleForm.doc_type} onChange={(e) => setRuleForm({ ...ruleForm, doc_type: e.target.value })} className="w-full px-3 py-1.5 border border-slate-300 rounded">
              <option value="PurchaseOrder">PurchaseOrder</option>
              <option value="PaymentVoucher">PaymentVoucher</option>
              <option value="PurchaseInvoice">PurchaseInvoice</option>
              <option value="StockAdjustment">StockAdjustment</option>
            </select>
            <select value={ruleForm.role_id} onChange={(e) => setRuleForm({ ...ruleForm, role_id: Number(e.target.value) })} className="w-full px-3 py-1.5 border border-slate-300 rounded">
              {roles.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
            </select>
            <div className="grid grid-cols-2 gap-2">
              <input type="number" placeholder="Min Amount" value={ruleForm.min_amount} onChange={(e) => setRuleForm({ ...ruleForm, min_amount: e.target.value })} className="px-3 py-1.5 border border-slate-300 rounded font-mono" />
              <input type="number" placeholder="Max Amount (empty=unlimited)" value={ruleForm.max_amount} onChange={(e) => setRuleForm({ ...ruleForm, max_amount: e.target.value })} className="px-3 py-1.5 border border-slate-300 rounded font-mono" />
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <button type="button" onClick={() => setShowRuleModal(false)} className="px-3 py-1.5 border border-slate-300 rounded">Cancel</button>
              <button type="submit" className="px-4 py-1.5 bg-slate-900 text-white rounded font-medium">Save Rule</button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
