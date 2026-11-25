import React, { useEffect, useState } from 'react';
import { Briefcase, Plus, UserCheck, Users } from 'lucide-react';
import { apiRequest } from '../../services/api';
import { DataTable, type ColumnDef } from '../../components/DataTable';

type OpsTab = 'hr' | 'crm' | 'projects';

export function OperationsView() {
  const [tab, setTab] = useState<OpsTab>('hr');
  const [hr, setHr] = useState<{
    departments: { id: number; name: string }[];
    designations: { id: number; name: string }[];
    employees: Record<string, unknown>[];
    attendance: Record<string, unknown>[];
    leaves: Record<string, unknown>[];
    payrolls: Record<string, unknown>[];
  }>({ departments: [], designations: [], employees: [], attendance: [], leaves: [], payrolls: [] });
  const [crm, setCrm] = useState<{ leads: Record<string, unknown>[]; activities: Record<string, unknown>[]; complaints: Record<string, unknown>[] }>({
    leads: [],
    activities: [],
    complaints: [],
  });
  const [projects, setProjects] = useState<Record<string, unknown>[]>([]);
  const [customers, setCustomers] = useState<{ id: number; name: string }[]>([]);
  const [banks, setBanks] = useState<{ id: number; account_name: string }[]>([]);
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');

  const [showEmpModal, setShowEmpModal] = useState(false);
  const [empForm, setEmpForm] = useState({ full_name: '', email: '', phone: '', department_id: 0, designation_id: 0, basic_salary: '8000', allowances: '2500' });
  const [showLeadModal, setShowLeadModal] = useState(false);
  const [leadForm, setLeadForm] = useState({ company_name: '', contact_person: '', email: '', phone: '', source: 'Trade Expo', estimated_value: '120000' });
  const [showPrjModal, setShowPrjModal] = useState(false);
  const [prjForm, setPrjForm] = useState({ name: '', customer_id: 0, budget: '50000', revenue: '85000', manager_id: 0 });
  const [payrollMonth, setPayrollMonth] = useState(String(new Date().getMonth() + 1));
  const [payrollYear, setPayrollYear] = useState(String(new Date().getFullYear()));
  const [payrollBank, setPayrollBank] = useState<number>(0);

  const loadAll = async () => {
    setLoading(true);
    try {
      const [h, c, p, cust, acc] = await Promise.all([
        apiRequest<typeof hr>('/api/operations/hr/overview'),
        apiRequest<typeof crm>('/api/operations/crm/overview'),
        apiRequest<{ items: Record<string, unknown>[] }>('/api/operations/projects'),
        apiRequest<{ items: typeof customers }>('/api/masters/customers'),
        apiRequest<{ banks: typeof banks }>('/api/accounting/accounts'),
      ]);
      setHr(h);
      setCrm(c);
      setProjects(p.items);
      setCustomers(cust.items);
      setBanks(acc.banks);
      setEmpForm((f) => ({
        ...f,
        department_id: f.department_id || h.departments[0]?.id || 0,
        designation_id: f.designation_id || h.designations[0]?.id || 0,
      }));
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : 'Failed to load operations data');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadAll();
  }, []);

  const empCols: ColumnDef<Record<string, unknown>>[] = [
    { key: 'emp_code', header: 'Code' },
    { key: 'full_name', header: 'Employee Name' },
    { key: 'department_name', header: 'Department' },
    { key: 'designation_name', header: 'Designation' },
    { key: 'basic_salary', header: 'Basic (AED)', numeric: true, render: (r) => Number(r.basic_salary || 0).toFixed(2) },
    { key: 'allowances', header: 'Allowances', numeric: true, render: (r) => Number(r.allowances || 0).toFixed(2) },
    { key: 'status', header: 'Status' },
    {
      key: 'actions',
      header: 'Attendance',
      render: (r) => (
        <button
          type="button"
          onClick={async () => {
            await apiRequest('/api/operations/hr/attendance', { method: 'POST', body: JSON.stringify({ employee_id: r.id, status: 'Present' }) });
            setMsg(`Marked Present today for ${String(r.full_name)}.`);
            await loadAll();
          }}
          className="px-2 py-1 text-xs border border-slate-300 rounded hover:bg-slate-50"
        >
          Mark Present
        </button>
      ),
    },
  ];

  const leadCols: ColumnDef<Record<string, unknown>>[] = [
    { key: 'lead_number', header: 'Lead #' },
    { key: 'company_name', header: 'Company' },
    { key: 'contact_person', header: 'Contact' },
    { key: 'source', header: 'Source' },
    { key: 'estimated_value', header: 'Est. Value', numeric: true, render: (r) => `${String(r.currency)} ${Number(r.estimated_value || 0).toFixed(2)}` },
    {
      key: 'stage',
      header: 'Stage',
      render: (r) => (
        <select
          value={String(r.stage)}
          onChange={async (e) => {
            await apiRequest(`/api/operations/crm/leads/${r.id}/stage`, { method: 'POST', body: JSON.stringify({ stage: e.target.value }) });
            await loadAll();
          }}
          className="px-2 py-1 text-xs border border-slate-300 rounded bg-white"
        >
          {['New', 'Qualified', 'Proposal Sent', 'Negotiation', 'Won', 'Lost'].map((s) => (
            <option key={s} value={s}>{s}</option>
          ))}
        </select>
      ),
    },
    {
      key: 'actions',
      header: 'Actions',
      render: (r) =>
        !r.converted_customer_id ? (
          <button
            type="button"
            onClick={async () => {
              try {
                const res = await apiRequest<{ customer_code: string }>(`/api/operations/crm/leads/${r.id}/convert`, { method: 'POST' });
                setMsg(`Lead converted to Customer ${res.customer_code}.`);
                await loadAll();
              } catch (e: unknown) {
                setErr(e instanceof Error ? e.message : 'Conversion failed');
              }
            }}
            className="inline-flex items-center gap-1 px-2 py-1 text-xs font-medium bg-emerald-700 text-white rounded hover:bg-emerald-800"
          >
            <UserCheck className="w-3 h-3" /> Convert to Customer
          </button>
        ) : (
          <span className="text-xs text-emerald-700 font-medium">Converted</span>
        ),
    },
  ];

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-slate-900">HR, CRM & Projects</h1>
          <p className="text-xs text-slate-500">Workforce payroll posting to GL, B2B distributor pipeline & customer conversion, and plant engineering projects</p>
        </div>
        <div className="flex items-center gap-2">
          {tab === 'hr' && (
            <button type="button" onClick={() => setShowEmpModal(true)} className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-slate-900 text-white rounded-md">
              <Users className="w-3.5 h-3.5" /> Add Employee
            </button>
          )}
          {tab === 'crm' && (
            <button type="button" onClick={() => setShowLeadModal(true)} className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-slate-900 text-white rounded-md">
              <Plus className="w-3.5 h-3.5" /> New Lead
            </button>
          )}
          {tab === 'projects' && (
            <button type="button" onClick={() => setShowPrjModal(true)} className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-slate-900 text-white rounded-md">
              <Briefcase className="w-3.5 h-3.5" /> New Project
            </button>
          )}
        </div>
      </div>

      <div className="flex gap-1 p-1 bg-slate-100 rounded-lg w-fit">
        {[
          { id: 'hr', label: 'HR & Payroll' },
          { id: 'crm', label: 'CRM Pipeline & Complaints' },
          { id: 'projects', label: 'Projects & Profitability' },
        ].map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setTab(t.id as OpsTab)}
            className={`px-3 py-1.5 text-xs font-medium rounded-md ${tab === t.id ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600'}`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {msg && <div className="p-3 bg-emerald-50 border border-emerald-200 rounded text-xs text-emerald-800">{msg}</div>}
      {err && <div className="p-3 bg-red-50 border border-red-200 rounded text-xs text-red-700">{err}</div>}

      {tab === 'hr' && (
        <div className="space-y-6">
          <div className="bg-white border border-slate-200 rounded-lg p-4 flex flex-wrap items-center justify-between gap-3 text-xs">
            <div className="flex flex-wrap items-center gap-3">
              <span className="font-semibold text-slate-900">Run Monthly Payroll & Post to GL:</span>
              <input type="number" min={1} max={12} value={payrollMonth} onChange={(e) => setPayrollMonth(e.target.value)} className="w-16 px-2 py-1 border border-slate-300 rounded font-mono" />
              <input type="number" value={payrollYear} onChange={(e) => setPayrollYear(e.target.value)} className="w-20 px-2 py-1 border border-slate-300 rounded font-mono" />
              <select value={payrollBank} onChange={(e) => setPayrollBank(Number(e.target.value))} className="px-2 py-1 border border-slate-300 rounded">
                <option value={0}>Accrue to Payroll Payable (2300)</option>
                {banks.map((b) => <option key={b.id} value={b.id}>Pay via {b.account_name}</option>)}
              </select>
            </div>
            <button
              type="button"
              onClick={async () => {
                setErr('');
                try {
                  const res = await apiRequest<{ payroll_number: string; total_net: number; je_number: string }>('/api/operations/hr/payroll', {
                    method: 'POST',
                    body: JSON.stringify({ month: Number(payrollMonth), year: Number(payrollYear), bank_account_id: payrollBank || undefined }),
                  });
                  setMsg(`Payroll ${res.payroll_number} posted (Net AED ${res.total_net.toFixed(2)}, GL ${res.je_number}).`);
                  await loadAll();
                } catch (e: unknown) {
                  setErr(e instanceof Error ? e.message : 'Payroll failed');
                }
              }}
              className="px-4 py-1.5 bg-slate-900 text-white rounded font-medium hover:bg-slate-800"
            >
              Execute Payroll Run
            </button>
          </div>

          <DataTable title="Employee Directory" columns={empCols} data={hr.employees} loading={loading} exportFilename="employees" />

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <DataTable
              title="Payroll History"
              columns={[
                { key: 'payroll_number', header: 'Payroll #' },
                { key: 'month', header: 'Month', numeric: true },
                { key: 'year', header: 'Year', numeric: true },
                { key: 'total_net', header: 'Total Net (AED)', numeric: true, render: (r) => Number(r.total_net || 0).toFixed(2) },
                { key: 'status', header: 'Status' },
              ]}
              data={hr.payrolls}
              exportFilename="payroll_runs"
            />
            <DataTable
              title="Leave Requests"
              columns={[
                { key: 'emp_code', header: 'Emp Code' },
                { key: 'full_name', header: 'Employee' },
                { key: 'leave_type', header: 'Type' },
                { key: 'days', header: 'Days', numeric: true },
                { key: 'status', header: 'Status' },
                {
                  key: 'actions',
                  header: 'Actions',
                  render: (r) =>
                    r.status === 'Pending' ? (
                      <button
                        type="button"
                        onClick={async () => {
                          await apiRequest(`/api/operations/hr/leaves/${r.id}/decide`, { method: 'POST', body: JSON.stringify({ status: 'Approved' }) });
                          await loadAll();
                        }}
                        className="px-2 py-1 text-xs bg-emerald-700 text-white rounded"
                      >
                        Approve
                      </button>
                    ) : null,
                },
              ]}
              data={hr.leaves}
              exportFilename="leave_requests"
            />
          </div>
        </div>
      )}

      {tab === 'crm' && (
        <div className="space-y-6">
          <DataTable title="CRM Sales Leads" columns={leadCols} data={crm.leads} loading={loading} exportFilename="crm_leads" />
          <DataTable
            title="Customer Technical & Quality Complaints"
            columns={[
              { key: 'complaint_number', header: 'Complaint #' },
              { key: 'customer_name', header: 'Customer' },
              { key: 'subject', header: 'Subject' },
              { key: 'batch_number', header: 'Batch #' },
              { key: 'severity', header: 'Severity' },
              { key: 'status', header: 'Status' },
            ]}
            data={crm.complaints}
            exportFilename="crm_complaints"
          />
        </div>
      )}

      {tab === 'projects' && (
        <DataTable
          title="Projects & Profitability"
          columns={[
            { key: 'project_code', header: 'Code' },
            { key: 'name', header: 'Project Name' },
            { key: 'customer_name', header: 'Customer' },
            { key: 'budget', header: 'Budget (AED)', numeric: true, render: (r) => Number(r.budget || 0).toFixed(2) },
            { key: 'actual_cost', header: 'Actual Cost', numeric: true, render: (r) => Number(r.actual_cost || 0).toFixed(2) },
            { key: 'revenue', header: 'Revenue', numeric: true, render: (r) => Number(r.revenue || 0).toFixed(2) },
            { key: 'profitability', header: 'Profitability', numeric: true, render: (r) => Number(r.profitability || 0).toFixed(2) },
            { key: 'progress_pct', header: 'Progress', numeric: true, render: (r) => `${String(r.progress_pct || 0)}%` },
            { key: 'status', header: 'Status' },
          ]}
          data={projects}
          loading={loading}
          exportFilename="projects"
        />
      )}

      {showEmpModal && (
        <div className="fixed inset-0 bg-slate-900/40 z-50 flex items-center justify-center p-4">
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              await apiRequest('/api/operations/hr/employees', {
                method: 'POST',
                body: JSON.stringify({ ...empForm, basic_salary: Number(empForm.basic_salary), allowances: Number(empForm.allowances) }),
              });
              setShowEmpModal(false);
              setMsg('Employee added.');
              await loadAll();
            }}
            className="bg-white border border-slate-200 rounded-lg w-full max-w-md p-6 space-y-3 text-xs"
          >
            <h3 className="text-base font-semibold text-slate-900">Add Employee</h3>
            <input required placeholder="Full Name" value={empForm.full_name} onChange={(e) => setEmpForm({ ...empForm, full_name: e.target.value })} className="w-full px-3 py-1.5 border border-slate-300 rounded" />
            <div className="grid grid-cols-2 gap-2">
              <input placeholder="Email" value={empForm.email} onChange={(e) => setEmpForm({ ...empForm, email: e.target.value })} className="px-3 py-1.5 border border-slate-300 rounded" />
              <input placeholder="Phone" value={empForm.phone} onChange={(e) => setEmpForm({ ...empForm, phone: e.target.value })} className="px-3 py-1.5 border border-slate-300 rounded" />
              <select value={empForm.department_id} onChange={(e) => setEmpForm({ ...empForm, department_id: Number(e.target.value) })} className="px-3 py-1.5 border border-slate-300 rounded">
                {hr.departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
              </select>
              <select value={empForm.designation_id} onChange={(e) => setEmpForm({ ...empForm, designation_id: Number(e.target.value) })} className="px-3 py-1.5 border border-slate-300 rounded">
                {hr.designations.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
              </select>
              <input type="number" placeholder="Basic Salary" value={empForm.basic_salary} onChange={(e) => setEmpForm({ ...empForm, basic_salary: e.target.value })} className="px-3 py-1.5 border border-slate-300 rounded font-mono" />
              <input type="number" placeholder="Allowances" value={empForm.allowances} onChange={(e) => setEmpForm({ ...empForm, allowances: e.target.value })} className="px-3 py-1.5 border border-slate-300 rounded font-mono" />
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <button type="button" onClick={() => setShowEmpModal(false)} className="px-3 py-1.5 border border-slate-300 rounded">Cancel</button>
              <button type="submit" className="px-4 py-1.5 bg-slate-900 text-white rounded font-medium">Save Employee</button>
            </div>
          </form>
        </div>
      )}

      {showLeadModal && (
        <div className="fixed inset-0 bg-slate-900/40 z-50 flex items-center justify-center p-4">
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              await apiRequest('/api/operations/crm/leads', {
                method: 'POST',
                body: JSON.stringify({ ...leadForm, estimated_value: Number(leadForm.estimated_value) }),
              });
              setShowLeadModal(false);
              setMsg('CRM Lead created.');
              await loadAll();
            }}
            className="bg-white border border-slate-200 rounded-lg w-full max-w-md p-6 space-y-3 text-xs"
          >
            <h3 className="text-base font-semibold text-slate-900">Create Sales Lead</h3>
            <input required placeholder="Company Name" value={leadForm.company_name} onChange={(e) => setLeadForm({ ...leadForm, company_name: e.target.value })} className="w-full px-3 py-1.5 border border-slate-300 rounded" />
            <div className="grid grid-cols-2 gap-2">
              <input placeholder="Contact Person" value={leadForm.contact_person} onChange={(e) => setLeadForm({ ...leadForm, contact_person: e.target.value })} className="px-3 py-1.5 border border-slate-300 rounded" />
              <input placeholder="Email" value={leadForm.email} onChange={(e) => setLeadForm({ ...leadForm, email: e.target.value })} className="px-3 py-1.5 border border-slate-300 rounded" />
              <input placeholder="Source" value={leadForm.source} onChange={(e) => setLeadForm({ ...leadForm, source: e.target.value })} className="px-3 py-1.5 border border-slate-300 rounded" />
              <input type="number" placeholder="Est. Value (AED)" value={leadForm.estimated_value} onChange={(e) => setLeadForm({ ...leadForm, estimated_value: e.target.value })} className="px-3 py-1.5 border border-slate-300 rounded font-mono" />
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <button type="button" onClick={() => setShowLeadModal(false)} className="px-3 py-1.5 border border-slate-300 rounded">Cancel</button>
              <button type="submit" className="px-4 py-1.5 bg-slate-900 text-white rounded font-medium">Create Lead</button>
            </div>
          </form>
        </div>
      )}

      {showPrjModal && (
        <div className="fixed inset-0 bg-slate-900/40 z-50 flex items-center justify-center p-4">
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              await apiRequest('/api/operations/projects', {
                method: 'POST',
                body: JSON.stringify({ ...prjForm, customer_id: prjForm.customer_id || undefined, manager_id: prjForm.manager_id || undefined, budget: Number(prjForm.budget), revenue: Number(prjForm.revenue) }),
              });
              setShowPrjModal(false);
              setMsg('Project created.');
              await loadAll();
            }}
            className="bg-white border border-slate-200 rounded-lg w-full max-w-md p-6 space-y-3 text-xs"
          >
            <h3 className="text-base font-semibold text-slate-900">Create Project</h3>
            <input required placeholder="Project Name" value={prjForm.name} onChange={(e) => setPrjForm({ ...prjForm, name: e.target.value })} className="w-full px-3 py-1.5 border border-slate-300 rounded" />
            <select value={prjForm.customer_id} onChange={(e) => setPrjForm({ ...prjForm, customer_id: Number(e.target.value) })} className="w-full px-3 py-1.5 border border-slate-300 rounded">
              <option value={0}>Internal Plant Project</option>
              {customers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
            <div className="grid grid-cols-2 gap-2">
              <input type="number" placeholder="Budget (AED)" value={prjForm.budget} onChange={(e) => setPrjForm({ ...prjForm, budget: e.target.value })} className="px-3 py-1.5 border border-slate-300 rounded font-mono" />
              <input type="number" placeholder="Expected Revenue (AED)" value={prjForm.revenue} onChange={(e) => setPrjForm({ ...prjForm, revenue: e.target.value })} className="px-3 py-1.5 border border-slate-300 rounded font-mono" />
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <button type="button" onClick={() => setShowPrjModal(false)} className="px-3 py-1.5 border border-slate-300 rounded">Cancel</button>
              <button type="submit" className="px-4 py-1.5 bg-slate-900 text-white rounded font-medium">Save Project</button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
