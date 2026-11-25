import React, { useEffect, useState } from 'react';
import { BookOpen, Building2, CheckSquare, FileText, Plus, RotateCcw } from 'lucide-react';
import { apiRequest } from '../../services/api';
import { DataTable, type ColumnDef } from '../../components/DataTable';
import { exportStandardErpPdf, exportTableToPdf, exportToExcel } from '../../utils/export';
import { useCompany } from '../../context/CompanyContext';

type AccTab = 'reports' | 'journals' | 'vouchers' | 'schedules' | 'coa' | 'expenses' | 'assets' | 'reconcile';

export function AccountingView() {
  const { company, logoUrl } = useCompany();
  const [tab, setTab] = useState<AccTab>('reports');
  const [accounts, setAccounts] = useState<{ id: number; account_code: string; account_name: string; account_type: string; balance: number; is_group: number }[]>([]);
  const [banks, setBanks] = useState<{ id: number; account_name: string; bank_name: string; current_balance: number }[]>([]);
  const [journals, setJournals] = useState<Record<string, unknown>[]>([]);
  const [vouchers, setVouchers] = useState<Record<string, unknown>[]>([]);
  const [schedules, setSchedules] = useState<Record<string, unknown>[]>([]);
  const [expenses, setExpenses] = useState<Record<string, unknown>[]>([]);
  const [assets, setAssets] = useState<Record<string, unknown>[]>([]);
  const [reports, setReports] = useState<Record<string, unknown> | null>(null);
  const [suppliers, setSuppliers] = useState<{ id: number; name: string }[]>([]);
  const [customers, setCustomers] = useState<{ id: number; name: string }[]>([]);
  const [purchaseInvoices, setPurchaseInvoices] = useState<{ id: number; pi_number: string; supplier_id: number; outstanding_amount: number }[]>([]);
  const [salesInvoices, setSalesInvoices] = useState<{ id: number; si_number: string; customer_id: number; outstanding_amount: number }[]>([]);

  const [fromDate, setFromDate] = useState('2026-01-01');
  const [toDate, setToDate] = useState('2026-12-31');
  const [selectedBankId, setSelectedBankId] = useState<number>(1);
  const [reconLines, setReconLines] = useState<Record<string, unknown>[]>([]);

  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');

  const [showVoucherModal, setShowVoucherModal] = useState(false);
  const [vForm, setVForm] = useState({
    voucher_type: 'Receipt' as 'Payment' | 'Receipt',
    party_type: 'Customer' as 'Supplier' | 'Customer',
    party_id: 0,
    bank_account_id: 0,
    payment_mode: 'Bank Transfer',
    cheque_number: '',
    amount: '',
    allocated_doc_type: '',
    allocated_doc_id: 0,
    remarks: '',
  });

  const [showJeModal, setShowJeModal] = useState(false);
  const [jeForm, setJeForm] = useState({
    narration: '',
    posting_date: new Date().toISOString().slice(0, 10),
    lines: [
      { account_id: 0, debit: '0', credit: '0', description: '' },
      { account_id: 0, debit: '0', credit: '0', description: '' },
    ],
  });

  const [showExpModal, setShowExpModal] = useState(false);
  const [expForm, setExpForm] = useState({ category: 'Utilities & Power', account_id: 0, bank_account_id: 0, amount: '', vat_amount: '', description: '' });

  const [showAssetModal, setShowAssetModal] = useState(false);
  const [assetForm, setAssetForm] = useState({ asset_name: '', category: 'Plant & Machinery', purchase_cost: '', useful_life_months: '60', location: 'ICAD II Blending Plant', bank_account_id: 0 });

  const loadAll = async () => {
    setLoading(true);
    try {
      const [acc, je, pv, sch, exp, ast, rep, sup, cust, pi, si] = await Promise.all([
        apiRequest<{ accounts: typeof accounts; banks: typeof banks }>('/api/accounting/accounts'),
        apiRequest<{ items: Record<string, unknown>[] }>('/api/accounting/journal-entries'),
        apiRequest<{ items: Record<string, unknown>[] }>('/api/accounting/vouchers'),
        apiRequest<{ items: Record<string, unknown>[] }>('/api/accounting/payment-schedules'),
        apiRequest<{ items: Record<string, unknown>[] }>('/api/accounting/expenses'),
        apiRequest<{ items: Record<string, unknown>[] }>('/api/accounting/fixed-assets'),
        apiRequest<Record<string, unknown>>(`/api/accounting/reports/financial?from_date=${fromDate}&to_date=${toDate}`),
        apiRequest<{ items: typeof suppliers }>('/api/masters/suppliers'),
        apiRequest<{ items: typeof customers }>('/api/masters/customers'),
        apiRequest<{ items: typeof purchaseInvoices }>('/api/procurement/purchase-invoices'),
        apiRequest<{ items: typeof salesInvoices }>('/api/sales/invoices'),
      ]);
      setAccounts(acc.accounts);
      setBanks(acc.banks);
      setJournals(je.items);
      setVouchers(pv.items);
      setSchedules(sch.items);
      setExpenses(exp.items);
      setAssets(ast.items);
      setReports(rep);
      setSuppliers(sup.items);
      setCustomers(cust.items);
      setPurchaseInvoices(pi.items.filter((x) => Number(x.outstanding_amount) > 0));
      setSalesInvoices(si.items.filter((x) => Number(x.outstanding_amount) > 0));

      const firstBankId = acc.banks[0]?.id || 1;
      setSelectedBankId(firstBankId);
      setVForm((f) => ({ ...f, bank_account_id: f.bank_account_id || firstBankId, party_id: f.party_id || cust.items[0]?.id || 0 }));
      setExpForm((f) => ({ ...f, bank_account_id: f.bank_account_id || firstBankId, account_id: f.account_id || acc.accounts.find((a) => a.account_type === 'Expense' && !a.is_group)?.id || 0 }));
      setAssetForm((f) => ({ ...f, bank_account_id: f.bank_account_id || firstBankId }));
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : 'Failed to load accounting data');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadAll();
  }, [fromDate, toDate]);

  useEffect(() => {
    if (tab === 'reconcile' && selectedBankId) {
      void apiRequest<{ lines: Record<string, unknown>[] }>(`/api/accounting/bank-reconciliation/${selectedBankId}`)
        .then((r) => setReconLines(r.lines))
        .catch(() => {});
    }
  }, [tab, selectedBankId]);

  const submitVoucher = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr('');
    try {
      const res = await apiRequest<{ pv_number: string; status: string; requiredRole?: string }>('/api/accounting/vouchers', {
        method: 'POST',
        body: JSON.stringify({
          ...vForm,
          amount: Number(vForm.amount),
          allocated_doc_id: vForm.allocated_doc_id || undefined,
          allocated_doc_type: vForm.allocated_doc_id ? (vForm.voucher_type === 'Payment' ? 'PurchaseInvoice' : 'SalesInvoice') : undefined,
        }),
      });
      setShowVoucherModal(false);
      setMsg(
        res.status === 'Pending Approval'
          ? `Voucher ${res.pv_number} queued for ${res.requiredRole} approval.`
          : `Voucher ${res.pv_number} posted to General Ledger.`
      );
      await loadAll();
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : 'Voucher creation failed');
    }
  };

  const submitManualJe = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr('');
    try {
      const res = await apiRequest<{ jeNumber: string }>('/api/accounting/journal-entries', {
        method: 'POST',
        body: JSON.stringify({
          narration: jeForm.narration,
          posting_date: jeForm.posting_date,
          lines: jeForm.lines.map((l) => ({ account_id: Number(l.account_id), debit: Number(l.debit || 0), credit: Number(l.credit || 0), description: l.description })),
        }),
      });
      setShowJeModal(false);
      setMsg(`Journal Entry ${res.jeNumber} posted.`);
      await loadAll();
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : 'Journal posting failed');
    }
  };

  const tb = (reports?.trial_balance as { rows: Record<string, unknown>[]; total_debits: number; total_credits: number; is_balanced: boolean }) || null;
  const pnl = (reports?.profit_and_loss as { total_income: number; total_expense: number; net_profit: number; income: Record<string, unknown>[]; expenses: Record<string, unknown>[] }) || null;
  const bs = (reports?.balance_sheet as { total_assets: number; total_liabilities_and_equity: number; assets: Record<string, unknown>[]; liabilities: Record<string, unknown>[]; equity: Record<string, unknown>[] }) || null;
  const vat = (reports?.vat_report as { vat_output: number; vat_input: number; net_vat_payable: number }) || null;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-slate-900">Accounting, Finance & UAE 5% VAT</h1>
          <p className="text-xs text-slate-500">Double-entry General Ledger, automated sub-ledger postings, payment schedules, fixed assets & statutory reports</p>
        </div>
        <div className="flex items-center gap-2">
          <button type="button" onClick={() => setShowJeModal(true)} className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded-md hover:bg-slate-50">
            <BookOpen className="w-3.5 h-3.5" /> Manual Journal
          </button>
          <button type="button" onClick={() => setShowVoucherModal(true)} className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-white bg-slate-900 rounded-md hover:bg-slate-800">
            <Plus className="w-3.5 h-3.5" /> Payment / Receipt Voucher
          </button>
        </div>
      </div>

      <div className="flex flex-wrap gap-1 p-1 bg-slate-100 rounded-lg w-fit">
        {[
          { id: 'reports', label: 'Financial Statements & VAT' },
          { id: 'journals', label: 'Journal Entries' },
          { id: 'vouchers', label: 'Payment & Receipt Vouchers' },
          { id: 'schedules', label: 'Installments & Overdue' },
          { id: 'coa', label: 'Chart of Accounts' },
          { id: 'expenses', label: 'Expenses' },
          { id: 'assets', label: 'Fixed Assets' },
          { id: 'reconcile', label: 'Bank Reconciliation' },
        ].map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setTab(t.id as AccTab)}
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

      {tab === 'reports' && reports && (
        <div className="space-y-5">
          <div className="bg-white border border-slate-200 rounded-lg p-4 flex flex-wrap items-center justify-between gap-3 text-xs">
            <div className="flex items-center gap-3">
              <label className="font-medium text-slate-700">Period:</label>
              <input type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} className="px-2.5 py-1 border border-slate-300 rounded font-mono" />
              <span>to</span>
              <input type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} className="px-2.5 py-1 border border-slate-300 rounded font-mono" />
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => exportToExcel('trial_balance', 'Trial Balance', tb?.rows || [])}
                className="px-3 py-1.5 border border-slate-300 rounded hover:bg-slate-50 font-medium"
              >
                Export TB Excel
              </button>
              <button
                type="button"
                onClick={() =>
                  exportTableToPdf(
                    'trial_balance',
                    `Trial Balance (${fromDate} to ${toDate})`,
                    [
                      { header: 'Code', key: 'account_code' },
                      { header: 'Account', key: 'account_name' },
                      { header: 'Type', key: 'account_type' },
                      { header: 'Debit', key: 'total_debit' },
                      { header: 'Credit', key: 'total_credit' },
                    ],
                    tb?.rows || [],
                    company.name || 'Company Name',
                    logoUrl
                  )
                }
                className="px-3 py-1.5 border border-slate-300 rounded hover:bg-slate-50 font-medium"
              >
                Export TB PDF
              </button>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
            <div className="bg-white border border-slate-200 rounded-lg p-4">
              <p className="text-xs text-slate-500">Trial Balance Status</p>
              <p className="text-lg font-semibold font-mono tabular-nums text-slate-900 mt-1">
                {tb?.is_balanced ? 'BALANCED' : 'UNBALANCED'}
              </p>
              <p className="text-[11px] text-slate-500 font-mono tabular-nums mt-1">
                DR {tb?.total_debits.toFixed(2)} = CR {tb?.total_credits.toFixed(2)}
              </p>
            </div>
            <div className="bg-white border border-slate-200 rounded-lg p-4">
              <p className="text-xs text-slate-500">Net Profit (P&L)</p>
              <p className={`text-lg font-semibold font-mono tabular-nums mt-1 ${(pnl?.net_profit || 0) >= 0 ? 'text-emerald-700' : 'text-red-600'}`}>
                AED {pnl?.net_profit.toFixed(2)}
              </p>
              <p className="text-[11px] text-slate-500 font-mono tabular-nums mt-1">
                Inc {pnl?.total_income.toFixed(2)} · Exp {pnl?.total_expense.toFixed(2)}
              </p>
            </div>
            <div className="bg-white border border-slate-200 rounded-lg p-4">
              <p className="text-xs text-slate-500">Balance Sheet Check</p>
              <p className="text-lg font-semibold font-mono tabular-nums text-slate-900 mt-1">
                AED {bs?.total_assets.toFixed(2)}
              </p>
              <p className="text-[11px] text-slate-500 font-mono tabular-nums mt-1">
                L+E: AED {bs?.total_liabilities_and_equity.toFixed(2)}
              </p>
            </div>
            <div className="bg-white border border-slate-200 rounded-lg p-4">
              <p className="text-xs text-slate-500">UAE 5% VAT Return (Net Payable)</p>
              <p className="text-lg font-semibold font-mono tabular-nums text-slate-900 mt-1">
                AED {vat?.net_vat_payable.toFixed(2)}
              </p>
              <p className="text-[11px] text-slate-500 font-mono tabular-nums mt-1">
                Output {vat?.vat_output.toFixed(2)} − Input {vat?.vat_input.toFixed(2)}
              </p>
            </div>
          </div>

          <DataTable
            title="Trial Balance"
            columns={[
              { key: 'account_code', header: 'Code' },
              { key: 'account_name', header: 'Account Name' },
              { key: 'account_type', header: 'Type' },
              { key: 'total_debit', header: 'Debit (AED)', numeric: true, render: (r) => Number(r.total_debit || 0).toFixed(2) },
              { key: 'total_credit', header: 'Credit (AED)', numeric: true, render: (r) => Number(r.total_credit || 0).toFixed(2) },
              { key: 'net_balance', header: 'Net Balance (AED)', numeric: true, render: (r) => Number(r.net_balance || 0).toFixed(2) },
            ]}
            data={tb?.rows || []}
            loading={loading}
            exportFilename="trial_balance"
          />

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <DataTable
              title="Receivables Ageing (AR)"
              columns={[
                { key: 'doc_number', header: 'Invoice #' },
                { key: 'party_name', header: 'Customer' },
                { key: 'due_date', header: 'Due Date' },
                { key: 'overdue_days', header: 'Days Overdue', numeric: true },
                { key: 'bucket', header: 'Bucket' },
                { key: 'outstanding_amount', header: 'Outstanding', numeric: true, render: (r) => Number(r.outstanding_amount || 0).toFixed(2) },
              ]}
              data={(reports.receivables_ageing as Record<string, unknown>[]) || []}
              exportFilename="ar_ageing"
            />
            <DataTable
              title="Payables Ageing (AP)"
              columns={[
                { key: 'doc_number', header: 'Invoice #' },
                { key: 'party_name', header: 'Supplier' },
                { key: 'due_date', header: 'Due Date' },
                { key: 'overdue_days', header: 'Days Overdue', numeric: true },
                { key: 'bucket', header: 'Bucket' },
                { key: 'outstanding_amount', header: 'Outstanding', numeric: true, render: (r) => Number(r.outstanding_amount || 0).toFixed(2) },
              ]}
              data={(reports.payables_ageing as Record<string, unknown>[]) || []}
              exportFilename="ap_ageing"
            />
          </div>
        </div>
      )}

      {tab === 'journals' && (
        <DataTable
          title="General Ledger Journal Entries"
          columns={[
            { key: 'je_number', header: 'JE #' },
            { key: 'posting_date', header: 'Date' },
            { key: 'entry_type', header: 'Type' },
            { key: 'ref_doc_number', header: 'Ref Doc' },
            { key: 'narration', header: 'Narration' },
            { key: 'total_debit', header: 'Debit (AED)', numeric: true, render: (r) => Number(r.total_debit || 0).toFixed(2) },
            { key: 'total_credit', header: 'Credit (AED)', numeric: true, render: (r) => Number(r.total_credit || 0).toFixed(2) },
            { key: 'status', header: 'Status' },
            {
              key: 'actions',
              header: 'Actions',
              render: (r) => (
                <div className="flex items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
                  <button
                    type="button"
                    onClick={() => {
                      const jeLines = (r.lines as Record<string, unknown>[]) || [];
                      void exportStandardErpPdf({
                        docTitle: 'JOURNAL ENTRY',
                        docNumberLabel: 'JE No.',
                        docNumber: String(r.je_number),
                        docDate: String(r.posting_date || ''),
                        company,
                        logoUrl,
                        companyRole: 'Seller',
                        partyRole: 'Buyer',
                        partyName: String(r.entry_type || 'General Ledger Posting'),
                        partyRefLabel: 'Ref. Doc.',
                        partyRefNo: String(r.ref_doc_number || '-'),
                        currency: company.currency || 'AED',
                        items: jeLines.map((l) => {
                          const dr = Number(l.debit || 0);
                          const cr = Number(l.credit || 0);
                          const amt = dr > 0 ? dr : cr;
                          return {
                            item_code: String(l.account_code || ''),
                            description: `${String(l.account_name || '')}${l.description ? ` — ${String(l.description)}` : ''}`,
                            qty: 1,
                            uom: dr > 0 ? 'DR' : 'CR',
                            unit_price: amt,
                            vat_pct: 0,
                            vat_amount: 0,
                            total: amt,
                          };
                        }),
                        netTotal: Number(r.total_debit || 0),
                        vatTotal: 0,
                        grandTotal: Number(r.total_debit || 0),
                        remarks: String(r.narration || ''),
                        creatorName: String(r.creator_name || ''),
                      });
                    }}
                    className="p-1 text-slate-600 hover:text-slate-900"
                    title="Download Standard PDF"
                  >
                    <FileText className="w-3.5 h-3.5" />
                  </button>
                  {r.status === 'Posted' ? (
                    <button
                      type="button"
                      onClick={async () => {
                        await apiRequest(`/api/accounting/journal-entries/${r.id}/reverse`, { method: 'POST', body: JSON.stringify({ reason: 'User Reversal' }) });
                        setMsg(`Reversed ${String(r.je_number)}.`);
                        await loadAll();
                      }}
                      className="inline-flex items-center gap-1 px-2 py-1 text-xs border border-slate-300 rounded hover:bg-slate-50"
                    >
                      <RotateCcw className="w-3 h-3" /> Reverse
                    </button>
                  ) : null}
                </div>
              ),
            },
          ]}
          data={journals}
          loading={loading}
          exportFilename="journal_entries"
        />
      )}

      {tab === 'vouchers' && (
        <DataTable
          title="Payment & Receipt Vouchers"
          columns={[
            { key: 'pv_number', header: 'Voucher #' },
            { key: 'voucher_type', header: 'Type' },
            { key: 'payment_date', header: 'Date' },
            { key: 'party_name', header: 'Party' },
            { key: 'bank_account_name', header: 'Bank / Cash' },
            { key: 'payment_mode', header: 'Mode' },
            { key: 'amount', header: 'Amount', numeric: true, render: (r) => `${String(r.currency)} ${Number(r.amount || 0).toFixed(2)}` },
            { key: 'status', header: 'Status' },
            {
              key: 'actions',
              header: 'Actions',
              render: (r) => (
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    const isPayment = r.voucher_type === 'Payment';
                    void exportStandardErpPdf({
                      docTitle: isPayment ? 'PAYMENT VOUCHER' : 'RECEIPT VOUCHER',
                      docNumberLabel: 'Voucher No.',
                      docNumber: String(r.pv_number),
                      docDate: String(r.payment_date || ''),
                      company,
                      logoUrl,
                      companyRole: isPayment ? 'Buyer' : 'Seller',
                      partyRole: isPayment ? 'Seller' : 'Buyer',
                      partyName: String(r.party_name || ''),
                      partyTrn: String(r.party_trn || ''),
                      partyAddress: String(r.party_address || ''),
                      partyCountry: String(r.party_country || ''),
                      partyContactPerson: String(r.party_contact_person || ''),
                      paymentTerms: String(r.payment_mode || ''),
                      partyRefLabel: 'Cheque / Ref. No.',
                      partyRefNo: String(r.cheque_number || r.allocated_doc_type || '-'),
                      exchangeRate: Number(r.exchange_rate || 1),
                      currency: String(r.currency || company.currency || 'AED'),
                      items: [
                        {
                          item_code: String(r.payment_mode || ''),
                          description: `${String(r.voucher_type)} via ${String(r.bank_account_name || '')}${r.allocated_doc_type ? ` (${String(r.allocated_doc_type)} #${String(r.allocated_doc_id || '')})` : ''}`,
                          qty: 1,
                          uom: String(r.currency || 'AED'),
                          unit_price: Number(r.amount || 0),
                          vat_pct: 0,
                          vat_amount: 0,
                          total: Number(r.amount || 0),
                        },
                      ],
                      netTotal: Number(r.amount || 0),
                      vatTotal: 0,
                      grandTotal: Number(r.amount || 0),
                      remarks: String(r.remarks || ''),
                      creatorName: String(r.creator_name || ''),
                    });
                  }}
                  className="inline-flex items-center gap-1 px-2 py-1 text-xs border border-slate-300 rounded hover:bg-slate-50"
                  title="Download Voucher PDF"
                >
                  <FileText className="w-3 h-3" /> PDF
                </button>
              ),
            },
          ]}
          data={vouchers}
          loading={loading}
          statusFilterKey="voucher_type"
          statusOptions={['Payment', 'Receipt']}
          exportFilename="payment_vouchers"
        />
      )}

      {tab === 'schedules' && (
        <DataTable
          title="Multi-Installment Payment Schedules"
          columns={[
            { key: 'doc_number', header: 'Invoice #' },
            { key: 'party_type', header: 'Party Type' },
            { key: 'party_name', header: 'Party' },
            { key: 'installment_no', header: 'Inst #', numeric: true },
            { key: 'due_date', header: 'Due Date' },
            { key: 'payment_mode', header: 'Mode' },
            { key: 'due_amount', header: 'Due', numeric: true, render: (r) => Number(r.amount || 0).toFixed(2) },
            { key: 'paid_amount', header: 'Paid', numeric: true, render: (r) => Number(r.paid_amount || 0).toFixed(2) },
            { key: 'outstanding_amount', header: 'Outstanding', numeric: true, render: (r) => Number(r.outstanding_amount || 0).toFixed(2) },
            {
              key: 'overdue_days',
              header: 'Overdue',
              numeric: true,
              render: (r) =>
                Number(r.overdue_days || 0) > 0 ? <span className="text-red-600 font-semibold">{String(r.overdue_days)}d</span> : 'On Time',
            },
            { key: 'status', header: 'Status' },
          ]}
          data={schedules}
          loading={loading}
          statusFilterKey="status"
          statusOptions={['Pending', 'Partially Paid', 'Paid']}
          exportFilename="payment_schedules"
        />
      )}

      {tab === 'coa' && (
        <DataTable
          title="Chart of Accounts"
          columns={[
            { key: 'account_code', header: 'Code' },
            { key: 'account_name', header: 'Account Name' },
            { key: 'account_type', header: 'Type' },
            { key: 'currency', header: 'Curr' },
            { key: 'balance', header: 'Balance (AED)', numeric: true, render: (r) => Number(r.balance || 0).toFixed(2) },
          ]}
          data={accounts as unknown as Record<string, unknown>[]}
          loading={loading}
          exportFilename="chart_of_accounts"
        />
      )}

      {tab === 'expenses' && (
        <div className="space-y-3">
          <div className="flex justify-end">
            <button type="button" onClick={() => setShowExpModal(true)} className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-slate-900 text-white rounded-md">
              <Plus className="w-3.5 h-3.5" /> Record Expense
            </button>
          </div>
          <DataTable
            title="Operating Expenses"
            columns={[
              { key: 'exp_number', header: 'Expense #' },
              { key: 'expense_date', header: 'Date' },
              { key: 'category', header: 'Category' },
              { key: 'account_name', header: 'Expense Account' },
              { key: 'bank_name', header: 'Paid From' },
              { key: 'amount', header: 'Net', numeric: true, render: (r) => Number(r.amount || 0).toFixed(2) },
              { key: 'vat_amount', header: 'VAT', numeric: true, render: (r) => Number(r.vat_amount || 0).toFixed(2) },
              { key: 'total_amount', header: 'Total', numeric: true, render: (r) => Number(r.total_amount || 0).toFixed(2) },
            ]}
            data={expenses}
            loading={loading}
            exportFilename="expenses"
          />
        </div>
      )}

      {tab === 'assets' && (
        <div className="space-y-3">
          <div className="flex justify-end">
            <button type="button" onClick={() => setShowAssetModal(true)} className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-slate-900 text-white rounded-md">
              <Building2 className="w-3.5 h-3.5" /> Register Fixed Asset
            </button>
          </div>
          <DataTable
            title="Fixed Assets & Straight-Line Depreciation"
            columns={[
              { key: 'asset_code', header: 'Asset Code' },
              { key: 'asset_name', header: 'Asset Name' },
              { key: 'category', header: 'Category' },
              { key: 'purchase_date', header: 'Acquired' },
              { key: 'purchase_cost', header: 'Cost (AED)', numeric: true, render: (r) => Number(r.purchase_cost || 0).toFixed(2) },
              { key: 'accumulated_depreciation', header: 'Accum. Dep.', numeric: true, render: (r) => Number(r.accumulated_depreciation || 0).toFixed(2) },
              { key: 'net_book_value', header: 'Net Book Value', numeric: true, render: (r) => Number(r.net_book_value || 0).toFixed(2) },
              {
                key: 'actions',
                header: 'Actions',
                render: (r) => (
                  <button
                    type="button"
                    onClick={async () => {
                      try {
                        const res = await apiRequest<{ je_number: string; amount: number }>(`/api/accounting/fixed-assets/${r.id}/depreciate`, { method: 'POST' });
                        setMsg(`Posted depreciation ${res.je_number} (AED ${res.amount.toFixed(2)}).`);
                        await loadAll();
                      } catch (e: unknown) {
                        setErr(e instanceof Error ? e.message : 'Depreciation failed');
                      }
                    }}
                    className="px-2 py-1 text-xs font-medium bg-slate-900 text-white rounded hover:bg-slate-800"
                  >
                    Post Next Month Dep.
                  </button>
                ),
              },
            ]}
            data={assets}
            loading={loading}
            exportFilename="fixed_assets"
          />
        </div>
      )}

      {tab === 'reconcile' && (
        <div className="space-y-4">
          <div className="bg-white border border-slate-200 rounded-lg p-4 flex items-center justify-between text-xs">
            <div className="flex items-center gap-3">
              <span className="font-semibold text-slate-900">Select Bank / Cash Account:</span>
              <select value={selectedBankId} onChange={(e) => setSelectedBankId(Number(e.target.value))} className="px-3 py-1.5 border border-slate-300 rounded">
                {banks.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.account_name} ({b.bank_name}) — Book Bal: AED {Number(b.current_balance).toFixed(2)}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <DataTable
            title="Bank Statement Reconciliation Lines"
            columns={[
              { key: 'posting_date', header: 'Date' },
              { key: 'je_number', header: 'JE #' },
              { key: 'ref_doc_number', header: 'Reference' },
              { key: 'narration', header: 'Narration' },
              { key: 'debit_base', header: 'Deposit (DR)', numeric: true, render: (r) => Number(r.debit_base || 0).toFixed(2) },
              { key: 'credit_base', header: 'Withdrawal (CR)', numeric: true, render: (r) => Number(r.credit_base || 0).toFixed(2) },
              {
                key: 'reconciled',
                header: 'Cleared',
                render: (r) => (
                  <button
                    type="button"
                    onClick={async () => {
                      await apiRequest('/api/accounting/bank-reconciliation/toggle', {
                        method: 'POST',
                        body: JSON.stringify({ line_id: r.id, reconciled: !r.reconciled }),
                      });
                      const res = await apiRequest<{ lines: Record<string, unknown>[] }>(`/api/accounting/bank-reconciliation/${selectedBankId}`);
                      setReconLines(res.lines);
                    }}
                    className={`inline-flex items-center gap-1 px-2 py-1 text-xs rounded ${r.reconciled ? 'bg-emerald-50 text-emerald-700 border border-emerald-200' : 'border border-slate-300 text-slate-600'}`}
                  >
                    <CheckSquare className="w-3 h-3" /> {r.reconciled ? 'Reconciled' : 'Mark Cleared'}
                  </button>
                ),
              },
            ]}
            data={reconLines}
            exportFilename="bank_reconciliation"
          />
        </div>
      )}

      {/* Payment/Receipt Voucher Modal */}
      {showVoucherModal && (
        <div className="fixed inset-0 bg-slate-900/40 z-50 flex items-center justify-center p-4">
          <form onSubmit={submitVoucher} className="bg-white border border-slate-200 rounded-lg w-full max-w-lg p-6 space-y-3 text-xs">
            <h3 className="text-base font-semibold text-slate-900">Create Payment / Receipt Voucher</h3>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block font-medium text-slate-700 mb-1">Voucher Type</label>
                <select
                  value={vForm.voucher_type}
                  onChange={(e) => {
                    const vt = e.target.value as 'Payment' | 'Receipt';
                    setVForm({
                      ...vForm,
                      voucher_type: vt,
                      party_type: vt === 'Payment' ? 'Supplier' : 'Customer',
                      party_id: vt === 'Payment' ? suppliers[0]?.id || 0 : customers[0]?.id || 0,
                      allocated_doc_id: 0,
                    });
                  }}
                  className="w-full px-3 py-1.5 border border-slate-300 rounded"
                >
                  <option value="Receipt">Customer Receipt</option>
                  <option value="Payment">Supplier Payment</option>
                </select>
              </div>
              <div>
                <label className="block font-medium text-slate-700 mb-1">{vForm.party_type}</label>
                <select value={vForm.party_id} onChange={(e) => setVForm({ ...vForm, party_id: Number(e.target.value), allocated_doc_id: 0 })} className="w-full px-3 py-1.5 border border-slate-300 rounded">
                  {(vForm.party_type === 'Supplier' ? suppliers : customers).map((p) => (
                    <option key={p.id} value={p.id}>{p.name}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block font-medium text-slate-700 mb-1">Bank / Cash Account</label>
                <select value={vForm.bank_account_id} onChange={(e) => setVForm({ ...vForm, bank_account_id: Number(e.target.value) })} className="w-full px-3 py-1.5 border border-slate-300 rounded">
                  {banks.map((b) => <option key={b.id} value={b.id}>{b.account_name}</option>)}
                </select>
              </div>
              <div>
                <label className="block font-medium text-slate-700 mb-1">Payment Mode</label>
                <select value={vForm.payment_mode} onChange={(e) => setVForm({ ...vForm, payment_mode: e.target.value })} className="w-full px-3 py-1.5 border border-slate-300 rounded">
                  <option value="Bank Transfer">Bank Transfer</option>
                  <option value="PDC">Post-Dated Cheque (PDC)</option>
                  <option value="Cash">Cash</option>
                </select>
              </div>
              <div>
                <label className="block font-medium text-slate-700 mb-1">Allocate to Open Invoice</label>
                <select
                  value={vForm.allocated_doc_id}
                  onChange={(e) => {
                    const id = Number(e.target.value);
                    const inv = vForm.voucher_type === 'Payment' ? purchaseInvoices.find((x) => x.id === id) : salesInvoices.find((x) => x.id === id);
                    setVForm({ ...vForm, allocated_doc_id: id, amount: inv ? String(inv.outstanding_amount) : vForm.amount });
                  }}
                  className="w-full px-3 py-1.5 border border-slate-300 rounded"
                >
                  <option value={0}>On-Account (Unallocated)</option>
                  {vForm.voucher_type === 'Payment'
                    ? purchaseInvoices.filter((p) => p.supplier_id === vForm.party_id).map((p) => <option key={p.id} value={p.id}>{p.pi_number} (Due {p.outstanding_amount})</option>)
                    : salesInvoices.filter((s) => s.customer_id === vForm.party_id).map((s) => <option key={s.id} value={s.id}>{s.si_number} (Due {s.outstanding_amount})</option>)}
                </select>
              </div>
              <div>
                <label className="block font-medium text-slate-700 mb-1">Amount (AED)</label>
                <input type="number" step="0.01" required value={vForm.amount} onChange={(e) => setVForm({ ...vForm, amount: e.target.value })} className="w-full px-3 py-1.5 border border-slate-300 rounded font-mono" />
              </div>
            </div>
            <input placeholder="Cheque / Transfer Reference & Remarks" value={vForm.remarks} onChange={(e) => setVForm({ ...vForm, remarks: e.target.value })} className="w-full px-3 py-1.5 border border-slate-300 rounded" />
            <div className="flex justify-end gap-2 pt-2">
              <button type="button" onClick={() => setShowVoucherModal(false)} className="px-3 py-1.5 border border-slate-300 rounded">Cancel</button>
              <button type="submit" className="px-4 py-1.5 bg-slate-900 text-white rounded font-medium">Post Voucher</button>
            </div>
          </form>
        </div>
      )}

      {/* Manual Journal Modal */}
      {showJeModal && (
        <div className="fixed inset-0 bg-slate-900/40 z-50 flex items-center justify-center p-4">
          <form onSubmit={submitManualJe} className="bg-white border border-slate-200 rounded-lg w-full max-w-2xl p-6 space-y-3 text-xs">
            <h3 className="text-base font-semibold text-slate-900">Post Balanced Manual Journal Entry</h3>
            <div className="grid grid-cols-3 gap-3">
              <input required placeholder="Narration" value={jeForm.narration} onChange={(e) => setJeForm({ ...jeForm, narration: e.target.value })} className="col-span-2 px-3 py-1.5 border border-slate-300 rounded" />
              <input type="date" value={jeForm.posting_date} onChange={(e) => setJeForm({ ...jeForm, posting_date: e.target.value })} className="px-3 py-1.5 border border-slate-300 rounded font-mono" />
            </div>
            {jeForm.lines.map((l, idx) => (
              <div key={idx} className="grid grid-cols-12 gap-2">
                <select
                  value={l.account_id}
                  onChange={(e) => {
                    const copy = [...jeForm.lines];
                    copy[idx].account_id = Number(e.target.value);
                    setJeForm({ ...jeForm, lines: copy });
                  }}
                  className="col-span-6 px-2 py-1.5 border border-slate-300 rounded"
                >
                  <option value={0}>Select GL Account...</option>
                  {accounts.filter((a) => !a.is_group).map((a) => <option key={a.id} value={a.id}>{a.account_code} — {a.account_name}</option>)}
                </select>
                <input type="number" step="0.01" placeholder="Debit" value={l.debit} onChange={(e) => { const copy = [...jeForm.lines]; copy[idx].debit = e.target.value; setJeForm({ ...jeForm, lines: copy }); }} className="col-span-3 px-2 py-1.5 border border-slate-300 rounded font-mono" />
                <input type="number" step="0.01" placeholder="Credit" value={l.credit} onChange={(e) => { const copy = [...jeForm.lines]; copy[idx].credit = e.target.value; setJeForm({ ...jeForm, lines: copy }); }} className="col-span-3 px-2 py-1.5 border border-slate-300 rounded font-mono" />
              </div>
            ))}
            <button type="button" onClick={() => setJeForm({ ...jeForm, lines: [...jeForm.lines, { account_id: 0, debit: '0', credit: '0', description: '' }] })} className="text-xs font-medium text-slate-700">+ Add Line</button>
            <div className="flex justify-end gap-2 pt-2">
              <button type="button" onClick={() => setShowJeModal(false)} className="px-3 py-1.5 border border-slate-300 rounded">Cancel</button>
              <button type="submit" className="px-4 py-1.5 bg-slate-900 text-white rounded font-medium">Post Journal</button>
            </div>
          </form>
        </div>
      )}

      {/* Expense Modal */}
      {showExpModal && (
        <div className="fixed inset-0 bg-slate-900/40 z-50 flex items-center justify-center p-4">
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              await apiRequest('/api/accounting/expenses', {
                method: 'POST',
                body: JSON.stringify({ ...expForm, amount: Number(expForm.amount), vat_amount: expForm.vat_amount ? Number(expForm.vat_amount) : undefined }),
              });
              setShowExpModal(false);
              setMsg('Expense recorded & posted to GL.');
              await loadAll();
            }}
            className="bg-white border border-slate-200 rounded-lg w-full max-w-md p-6 space-y-3 text-xs"
          >
            <h3 className="text-base font-semibold text-slate-900">Record Operating Expense</h3>
            <input required placeholder="Category" value={expForm.category} onChange={(e) => setExpForm({ ...expForm, category: e.target.value })} className="w-full px-3 py-1.5 border border-slate-300 rounded" />
            <select value={expForm.account_id} onChange={(e) => setExpForm({ ...expForm, account_id: Number(e.target.value) })} className="w-full px-3 py-1.5 border border-slate-300 rounded">
              {accounts.filter((a) => a.account_type === 'Expense' && !a.is_group).map((a) => <option key={a.id} value={a.id}>{a.account_code} — {a.account_name}</option>)}
            </select>
            <select value={expForm.bank_account_id} onChange={(e) => setExpForm({ ...expForm, bank_account_id: Number(e.target.value) })} className="w-full px-3 py-1.5 border border-slate-300 rounded">
              {banks.map((b) => <option key={b.id} value={b.id}>{b.account_name}</option>)}
            </select>
            <div className="grid grid-cols-2 gap-2">
              <input type="number" step="0.01" required placeholder="Net Amount" value={expForm.amount} onChange={(e) => setExpForm({ ...expForm, amount: e.target.value })} className="px-3 py-1.5 border border-slate-300 rounded font-mono" />
              <input type="number" step="0.01" placeholder="VAT (auto 5%)" value={expForm.vat_amount} onChange={(e) => setExpForm({ ...expForm, vat_amount: e.target.value })} className="px-3 py-1.5 border border-slate-300 rounded font-mono" />
            </div>
            <input placeholder="Description" value={expForm.description} onChange={(e) => setExpForm({ ...expForm, description: e.target.value })} className="w-full px-3 py-1.5 border border-slate-300 rounded" />
            <div className="flex justify-end gap-2 pt-2">
              <button type="button" onClick={() => setShowExpModal(false)} className="px-3 py-1.5 border border-slate-300 rounded">Cancel</button>
              <button type="submit" className="px-4 py-1.5 bg-slate-900 text-white rounded font-medium">Post Expense</button>
            </div>
          </form>
        </div>
      )}

      {/* Fixed Asset Modal */}
      {showAssetModal && (
        <div className="fixed inset-0 bg-slate-900/40 z-50 flex items-center justify-center p-4">
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              await apiRequest('/api/accounting/fixed-assets', {
                method: 'POST',
                body: JSON.stringify({ ...assetForm, purchase_cost: Number(assetForm.purchase_cost), useful_life_months: Number(assetForm.useful_life_months) }),
              });
              setShowAssetModal(false);
              setMsg('Fixed Asset capitalized with depreciation schedule.');
              await loadAll();
            }}
            className="bg-white border border-slate-200 rounded-lg w-full max-w-md p-6 space-y-3 text-xs"
          >
            <h3 className="text-base font-semibold text-slate-900">Register & Capitalize Fixed Asset</h3>
            <input required placeholder="Asset Name (e.g. High-Speed Drum Filling Line)" value={assetForm.asset_name} onChange={(e) => setAssetForm({ ...assetForm, asset_name: e.target.value })} className="w-full px-3 py-1.5 border border-slate-300 rounded" />
            <div className="grid grid-cols-2 gap-2">
              <input placeholder="Category" value={assetForm.category} onChange={(e) => setAssetForm({ ...assetForm, category: e.target.value })} className="px-3 py-1.5 border border-slate-300 rounded" />
              <input type="number" step="0.01" required placeholder="Purchase Cost (AED)" value={assetForm.purchase_cost} onChange={(e) => setAssetForm({ ...assetForm, purchase_cost: e.target.value })} className="px-3 py-1.5 border border-slate-300 rounded font-mono" />
              <input type="number" placeholder="Life (Months)" value={assetForm.useful_life_months} onChange={(e) => setAssetForm({ ...assetForm, useful_life_months: e.target.value })} className="px-3 py-1.5 border border-slate-300 rounded font-mono" />
              <select value={assetForm.bank_account_id} onChange={(e) => setAssetForm({ ...assetForm, bank_account_id: Number(e.target.value) })} className="px-3 py-1.5 border border-slate-300 rounded">
                {banks.map((b) => <option key={b.id} value={b.id}>{b.account_name}</option>)}
              </select>
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <button type="button" onClick={() => setShowAssetModal(false)} className="px-3 py-1.5 border border-slate-300 rounded">Cancel</button>
              <button type="submit" className="px-4 py-1.5 bg-slate-900 text-white rounded font-medium">Capitalize Asset</button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
