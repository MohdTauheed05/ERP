import React, { useEffect, useMemo, useState } from 'react';
import {
  ArrowLeft,
  Ban,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Download,
  Edit3,
  History,
  Link2,
  Paperclip,
  Plus,
  Printer,
  RotateCcw,
  Upload,
} from 'lucide-react';
import { apiRequest, apiUrl, downloadProtectedFile, getAuthToken } from '../services/api';
import { useCompany } from '../context/CompanyContext';
import { downloadLineItemsExcelTemplate, numberToWords } from '../utils/export';

export interface ErpViewerItemLine {
  item_code: string;
  description: string;
  uom?: string;
  qty: number;
  received_qty?: number;
  delivered_qty?: number;
  billed_qty?: number;
  rate: number;
  discount_pct?: number;
  vat_rate?: number;
  vat_amount?: number;
  line_total: number;
  tank_code?: string;
  batch_number?: string;
  extra_badge?: string;
}

export interface ErpViewerAction {
  label: string;
  onClick: () => void | Promise<void>;
  variant?: 'primary' | 'secondary' | 'emerald' | 'amber';
  disabled?: boolean;
}

export interface ErpDocumentViewerProps {
  docType: string;
  docId: number;
  docNumber: string;
  title: string;
  status: string;
  approvalStatus?: string;
  docDate: string;
  deliveryDate?: string;
  dateLabel?: string;
  deliveryDateLabel?: string;
  companyRole: 'Buyer' | 'Seller';
  partyLabel?: string;
  partyName?: string;
  partyTrn?: string;
  partyAddress?: string;
  partyCountry?: string;
  partyContactPerson?: string;
  partyTelephone?: string;
  warehouseName?: string;
  warehouseLabel?: string;
  refLabel?: string;
  refNo?: string;
  amendedFrom?: string;
  revisionNo?: string;
  revisionDate?: string;
  currency?: string;
  exchangeRate?: number;
  paymentTerms?: string;
  deliveryTerms?: string;
  deliveryPlace?: string;
  remarks?: string;
  creatorName?: string;
  createdAt?: string;
  approverName?: string;
  submittedAt?: string;
  freightAmount?: number;
  discountAmount?: number;
  subtotal: number;
  vatAmount: number;
  totalAmount: number;
  items: ErpViewerItemLine[];
  showReceivedCol?: boolean;
  showDeliveredCol?: boolean;
  showBilledCol?: boolean;
  showTankCol?: boolean;
  showBatchCol?: boolean;
  createActions?: ErpViewerAction[];
  onBack: () => void;
  onPrev?: () => void;
  onNext?: () => void;
  hasPrev?: boolean;
  hasNext?: boolean;
  onPrintPreview: () => void;
  onEdit?: () => void;
  onRevise?: () => void | Promise<void>;
  onCancelDoc?: () => void | Promise<void>;
  onNavigateLink?: (link: { docType: string; id: number; docNumber: string }) => void;
  extraBanner?: React.ReactNode;
}

type ViewerTab = 'details' | 'address' | 'terms' | 'more' | 'connections';

export function ErpDocumentViewer({
  docType,
  docId,
  docNumber,
  title,
  status,
  approvalStatus,
  docDate,
  deliveryDate,
  dateLabel = 'Date',
  deliveryDateLabel = 'Required By / Delivery Date',
  companyRole,
  partyLabel = 'Supplier',
  partyName,
  partyTrn,
  partyAddress,
  partyCountry,
  partyContactPerson,
  partyTelephone,
  warehouseName,
  warehouseLabel = 'Set Target Warehouse',
  refLabel = 'Ref. No.',
  refNo,
  amendedFrom,
  revisionNo = 'Original',
  revisionDate,
  currency = 'AED',
  exchangeRate = 1,
  paymentTerms,
  deliveryTerms,
  deliveryPlace,
  remarks,
  creatorName,
  createdAt,
  approverName,
  submittedAt,
  freightAmount = 0,
  discountAmount = 0,
  subtotal,
  vatAmount,
  totalAmount,
  items,
  showReceivedCol = false,
  showDeliveredCol = false,
  showBilledCol = false,
  showTankCol = false,
  showBatchCol = false,
  createActions = [],
  onBack,
  onPrev,
  onNext,
  hasPrev = false,
  hasNext = false,
  onPrintPreview,
  onEdit,
  onRevise,
  onCancelDoc,
  onNavigateLink,
  extraBanner,
}: ErpDocumentViewerProps) {
  const { company } = useCompany();
  const [activeTab, setActiveTab] = useState<ViewerTab>('details');
  const [showCurrencySec, setShowCurrencySec] = useState(false);
  const [showTaxBreakup, setShowTaxBreakup] = useState(false);
  const [showCreateMenu, setShowCreateMenu] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [busyAction, setBusyAction] = useState(false);

  const [links, setLinks] = useState<{ docType: string; id: number; docNumber: string; status: string; relation: string }[]>([]);
  const [audit, setAudit] = useState<{ id: number; username: string; action: string; created_at: string }[]>([]);
  const [attachments, setAttachments] = useState<{ id: number; file_name: string; size_bytes: number; uploaded_by_name: string; created_at: string }[]>([]);
  const [uploading, setUploading] = useState(false);
  const [connErr, setConnErr] = useState('');

  const loadRelations = async () => {
    try {
      setConnErr('');
      const [linkRes, attRes] = await Promise.all([
        apiRequest<{ links: typeof links; audit: typeof audit }>(`/api/system/links/${encodeURIComponent(docType)}/${docId}`),
        apiRequest<{ items: typeof attachments }>(`/api/system/attachments?doc_type=${encodeURIComponent(docType)}&doc_id=${docId}`),
      ]);
      setLinks(linkRes.links);
      setAudit(linkRes.audit);
      setAttachments(attRes.items);
    } catch (e: unknown) {
      setConnErr(e instanceof Error ? e.message : 'Failed to load links & activity');
    }
  };

  useEffect(() => {
    setConfirmCancel(false);
    setShowCreateMenu(false);
    void loadRelations();
  }, [docType, docId]);

  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setUploading(true);
    setConnErr('');
    try {
      const fd = new FormData();
      fd.append('file', file);
      fd.append('doc_type', docType);
      fd.append('doc_id', String(docId));
      const token = getAuthToken();
      const res = await fetch(apiUrl('/api/system/attachments/upload'), {
        method: 'POST',
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        body: fd,
      });
      if (!res.ok) {
        const d = (await res.json()) as { error?: string };
        throw new Error(d.error || 'Upload failed');
      }
      await loadRelations();
    } catch (err: unknown) {
      setConnErr(err instanceof Error ? err.message : 'Upload failed');
    } finally {
      setUploading(false);
    }
  };

  const totalQty = useMemo(() => items.reduce((s, l) => s + Number(l.qty || 0), 0), [items]);
  const vatRateDisplay = subtotal > 0 && vatAmount > 0 ? Math.round((vatAmount / subtotal) * 100) : vatAmount > 0 ? 5 : 0;
  const vatAccountHead =
    companyRole === 'Buyer' ? '1400 - VAT INPUT ACCOUNT (PURCHASES)' : '2200 - VAT OUTPUT PAYABLE (SALES)';

  const statusTone =
    status === 'Cancelled'
      ? 'bg-red-50 text-red-700 border-red-200'
      : status === 'Completed' || status === 'Posted' || status === 'Delivered' || status === 'Converted'
      ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
      : status === 'Draft'
      ? 'bg-amber-50 text-amber-700 border-amber-200'
      : 'bg-sky-50 text-sky-700 border-sky-200';

  const runAction = async (fn: () => void | Promise<void>) => {
    setBusyAction(true);
    setShowCreateMenu(false);
    try {
      await fn();
    } finally {
      setBusyAction(false);
    }
  };

  const handleDownloadLines = () => {
    downloadLineItemsExcelTemplate(
      `${docNumber}_items`,
      items.map((l) => ({
        item_code: l.item_code,
        item_name: l.description,
        qty: l.qty,
        uom: l.uom || 'LTR',
        rate: l.rate,
        vat_rate: l.vat_rate ?? vatRateDisplay,
        batch_number: l.batch_number || '',
        tank_code: l.tank_code || '',
      }))
    );
  };

  return (
    <div className="space-y-4">
      <div className="bg-white border border-slate-200 rounded-lg overflow-hidden shadow-xs">
        {/* Top ERPNext-Style Header Bar */}
        <div className="px-5 py-3 border-b border-slate-200 bg-white flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-2.5 min-w-0">
            <button
              type="button"
              onClick={onBack}
              className="p-1.5 text-slate-500 hover:text-slate-900 rounded hover:bg-slate-100 shrink-0"
              title="Back to list"
            >
              <ArrowLeft className="w-4 h-4" />
            </button>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-base font-semibold text-slate-900 truncate">{title}</h2>
                <span className="font-mono text-xs font-medium text-slate-600 bg-slate-100 border border-slate-200 px-2 py-0.5 rounded">
                  {docNumber}
                </span>
                <span className={`text-[11px] font-medium border px-2 py-0.5 rounded whitespace-nowrap ${statusTone}`}>
                  {status}
                </span>
                {approvalStatus && approvalStatus !== 'Not Submitted' && approvalStatus !== status && (
                  <span className="text-[11px] font-medium text-slate-600 bg-slate-50 border border-slate-200 px-2 py-0.5 rounded whitespace-nowrap">
                    Approval: {approvalStatus}
                  </span>
                )}
              </div>
              {amendedFrom && (
                <p className="text-[11px] text-slate-500 mt-0.5">
                  Amended From: <span className="font-mono font-medium text-slate-700">{amendedFrom}</span>
                </p>
              )}
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {createActions.length > 0 && (
              <div className="relative">
                <div className="flex items-center gap-1.5">
                  {createActions.length <= 2 ? (
                    createActions.map((act, idx) => (
                      <button
                        key={idx}
                        type="button"
                        disabled={busyAction || act.disabled}
                        onClick={() => void runAction(act.onClick)}
                        className={`inline-flex items-center gap-1 px-3 py-1.5 text-xs font-medium rounded-md whitespace-nowrap shrink-0 disabled:opacity-50 ${
                          act.variant === 'emerald'
                            ? 'bg-emerald-700 text-white hover:bg-emerald-800'
                            : act.variant === 'amber'
                            ? 'bg-amber-600 text-white hover:bg-amber-700'
                            : act.variant === 'secondary'
                            ? 'bg-white text-slate-700 border border-slate-300 hover:bg-slate-50'
                            : 'bg-slate-900 text-white hover:bg-slate-800'
                        }`}
                      >
                        <Plus className="w-3.5 h-3.5" />
                        {act.label}
                      </button>
                    ))
                  ) : (
                    <>
                      <button
                        type="button"
                        disabled={busyAction || createActions[0].disabled}
                        onClick={() => void runAction(createActions[0].onClick)}
                        className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-medium bg-slate-900 text-white rounded-md hover:bg-slate-800 whitespace-nowrap shrink-0 disabled:opacity-50"
                      >
                        <Plus className="w-3.5 h-3.5" />
                        {createActions[0].label}
                      </button>
                      <button
                        type="button"
                        onClick={() => setShowCreateMenu((m) => !m)}
                        className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium bg-slate-100 text-slate-800 border border-slate-300 rounded-md hover:bg-slate-200 whitespace-nowrap shrink-0"
                      >
                        Create <ChevronDown className="w-3.5 h-3.5" />
                      </button>
                      {showCreateMenu && (
                        <div className="absolute right-0 top-full mt-1 w-52 bg-white border border-slate-200 rounded-md shadow-lg z-40 py-1">
                          {createActions.map((act, idx) => (
                            <button
                              key={idx}
                              type="button"
                              disabled={busyAction || act.disabled}
                              onClick={() => void runAction(act.onClick)}
                              className="w-full text-left px-3 py-2 text-xs text-slate-700 hover:bg-slate-50 flex items-center gap-2 disabled:opacity-50"
                            >
                              <Plus className="w-3.5 h-3.5 text-slate-400" />
                              {act.label}
                            </button>
                          ))}
                        </div>
                      )}
                    </>
                  )}
                </div>
              </div>
            )}

            {(onPrev || onNext) && (
              <div className="inline-flex items-center border border-slate-300 rounded-md overflow-hidden bg-white">
                <button
                  type="button"
                  disabled={!hasPrev}
                  onClick={onPrev}
                  className="p-1.5 text-slate-600 hover:bg-slate-50 disabled:opacity-35 border-r border-slate-200"
                  title="Previous record"
                >
                  <ChevronLeft className="w-3.5 h-3.5" />
                </button>
                <button
                  type="button"
                  disabled={!hasNext}
                  onClick={onNext}
                  className="p-1.5 text-slate-600 hover:bg-slate-50 disabled:opacity-35"
                  title="Next record"
                >
                  <ChevronRight className="w-3.5 h-3.5" />
                </button>
              </div>
            )}

            <button
              type="button"
              onClick={onPrintPreview}
              className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded-md hover:bg-slate-50 whitespace-nowrap shrink-0"
              title="Print Preview & Download PDF"
            >
              <Printer className="w-3.5 h-3.5" /> Print Preview
            </button>

            {onEdit && (
              <button
                type="button"
                disabled={busyAction}
                onClick={onEdit}
                className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded-md hover:bg-slate-50 whitespace-nowrap shrink-0"
              >
                <Edit3 className="w-3.5 h-3.5" /> Edit
              </button>
            )}

            {onRevise && status !== 'Cancelled' && (
              <button
                type="button"
                disabled={busyAction}
                onClick={() => void runAction(onRevise)}
                className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium text-slate-700 bg-slate-50 border border-slate-300 rounded-md hover:bg-slate-100 whitespace-nowrap shrink-0"
                title="Amend / Create Revised Document (-1)"
              >
                <RotateCcw className="w-3.5 h-3.5" /> Revise / Amend
              </button>
            )}

            {onCancelDoc && status !== 'Cancelled' && (
              confirmCancel ? (
                <div className="inline-flex items-center gap-1 bg-red-50 border border-red-200 rounded-md px-2 py-1">
                  <span className="text-[11px] font-medium text-red-700">Confirm cancel?</span>
                  <button
                    type="button"
                    disabled={busyAction}
                    onClick={() => {
                      setConfirmCancel(false);
                      void runAction(onCancelDoc);
                    }}
                    className="px-2 py-0.5 text-[11px] font-medium bg-red-600 text-white rounded hover:bg-red-700"
                  >
                    Yes
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirmCancel(false)}
                    className="px-1.5 py-0.5 text-[11px] text-slate-600 hover:text-slate-900"
                  >
                    No
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  disabled={busyAction}
                  onClick={() => setConfirmCancel(true)}
                  className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium text-red-700 bg-white border border-red-200 rounded-md hover:bg-red-50 whitespace-nowrap shrink-0"
                >
                  <Ban className="w-3.5 h-3.5" /> Cancel
                </button>
              )
            )}
          </div>
        </div>

        {extraBanner}

        {/* Underline Tab Strip */}
        <div className="px-5 border-b border-slate-200 flex items-center gap-6 text-xs bg-white overflow-x-auto">
          {[
            { id: 'details', label: 'Details' },
            { id: 'address', label: 'Address & Contact' },
            { id: 'terms', label: 'Terms' },
            { id: 'more', label: 'More Info' },
            { id: 'connections', label: `Connections (${links.length + attachments.length})` },
          ].map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setActiveTab(t.id as ViewerTab)}
              className={`py-2.5 border-b-2 transition-colors whitespace-nowrap shrink-0 ${
                activeTab === t.id
                  ? 'border-slate-900 text-slate-900 font-semibold'
                  : 'border-transparent text-slate-500 hover:text-slate-800'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>

        {/* Tab Body */}
        <div className="p-5 space-y-5 text-xs">
          {activeTab === 'details' && (
            <>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                {partyName ? (
                  <div>
                    <label className="block text-[11px] font-medium text-slate-500 mb-1">{partyLabel}</label>
                    <div className="px-3 py-1.5 bg-slate-50 border border-slate-200 rounded font-medium text-slate-900">
                      {partyName}
                    </div>
                  </div>
                ) : (
                  <div>
                    <label className="block text-[11px] font-medium text-slate-500 mb-1">Document No.</label>
                    <div className="px-3 py-1.5 bg-slate-50 border border-slate-200 rounded font-mono text-slate-900">
                      {docNumber}
                    </div>
                  </div>
                )}

                <div>
                  <label className="block text-[11px] font-medium text-slate-500 mb-1">{dateLabel}</label>
                  <div className="px-3 py-1.5 bg-slate-50 border border-slate-200 rounded font-mono text-slate-800">
                    {docDate || '-'}
                  </div>
                </div>

                <div>
                  <label className="block text-[11px] font-medium text-slate-500 mb-1">Company</label>
                  <div className="px-3 py-1.5 bg-slate-50 border border-slate-200 rounded font-medium text-slate-800">
                    {company.name || 'PetroBlend ERP'}
                  </div>
                </div>

                <div>
                  <label className="block text-[11px] font-medium text-slate-500 mb-1">{refLabel}</label>
                  <div className="px-3 py-1.5 bg-slate-50 border border-slate-200 rounded font-mono text-slate-800">
                    {refNo || '-'}
                  </div>
                </div>

                <div>
                  <label className="block text-[11px] font-medium text-slate-500 mb-1">{deliveryDateLabel}</label>
                  <div className="px-3 py-1.5 bg-slate-50 border border-slate-200 rounded font-mono text-slate-800">
                    {deliveryDate || '-'}
                  </div>
                </div>

                <div>
                  <label className="block text-[11px] font-medium text-slate-500 mb-1">
                    {amendedFrom ? 'Amended From' : 'Revision No.'}
                  </label>
                  <div className="px-3 py-1.5 bg-slate-50 border border-slate-200 rounded font-mono text-slate-800">
                    {amendedFrom ? `${amendedFrom} (${revisionNo})` : revisionNo}
                  </div>
                </div>
              </div>

              {/* Collapsible Currency & Warehouse */}
              <div className="border-t border-slate-200 pt-3">
                <button
                  type="button"
                  onClick={() => setShowCurrencySec((s) => !s)}
                  className="flex items-center gap-1.5 text-xs font-semibold text-slate-800 hover:text-slate-900"
                >
                  Currency and Price List
                  {showCurrencySec ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
                </button>
                {showCurrencySec && (
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mt-3">
                    <div>
                      <label className="block text-[11px] font-medium text-slate-500 mb-1">Currency</label>
                      <div className="px-3 py-1.5 bg-slate-50 border border-slate-200 rounded font-mono text-slate-800">{currency}</div>
                    </div>
                    <div>
                      <label className="block text-[11px] font-medium text-slate-500 mb-1">Exchange Rate (to AED)</label>
                      <div className="px-3 py-1.5 bg-slate-50 border border-slate-200 rounded font-mono tabular-nums text-slate-800">{exchangeRate}</div>
                    </div>
                    <div>
                      <label className="block text-[11px] font-medium text-slate-500 mb-1">Payment Terms</label>
                      <div className="px-3 py-1.5 bg-slate-50 border border-slate-200 rounded text-slate-800">{paymentTerms || '-'}</div>
                    </div>
                  </div>
                )}
              </div>

              {warehouseName && (
                <div className="border-t border-slate-200 pt-3 grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-[11px] font-medium text-slate-500 mb-1">{warehouseLabel}</label>
                    <div className="px-3 py-1.5 bg-slate-50 border border-slate-200 rounded font-medium text-slate-800">{warehouseName}</div>
                  </div>
                  {deliveryPlace && (
                    <div>
                      <label className="block text-[11px] font-medium text-slate-500 mb-1">Delivery / Target Place</label>
                      <div className="px-3 py-1.5 bg-slate-50 border border-slate-200 rounded text-slate-800">{deliveryPlace}</div>
                    </div>
                  )}
                </div>
              )}

              {/* Items Table */}
              <div className="space-y-2 border-t border-slate-200 pt-4">
                <div className="flex items-center justify-between">
                  <span className="text-[11px] font-semibold text-slate-700 uppercase tracking-wide">Items ({items.length})</span>
                  <button
                    type="button"
                    onClick={handleDownloadLines}
                    className="inline-flex items-center gap-1 px-2.5 py-1 text-[11px] font-medium bg-slate-100 hover:bg-slate-200 text-slate-800 rounded border border-slate-200"
                  >
                    <Download className="w-3 h-3" /> Download Excel
                  </button>
                </div>
                <div className="border border-slate-200 rounded-md overflow-x-auto">
                  <table className="w-full text-left border-collapse text-xs">
                    <thead>
                      <tr className="bg-slate-50 border-b border-slate-200 text-[11px] font-medium text-slate-600">
                        <th className="w-10 px-2 py-2 text-center border-r border-slate-200">No.</th>
                        <th className="min-w-[240px] px-2.5 py-2 border-r border-slate-200">Item Code & Description</th>
                        <th className="w-20 px-2 py-2 text-center border-r border-slate-200">UOM</th>
                        {showTankCol && <th className="w-28 px-2 py-2 border-r border-slate-200">Tank</th>}
                        {showBatchCol && <th className="w-28 px-2 py-2 border-r border-slate-200">Batch #</th>}
                        <th className="w-24 px-2.5 py-2 text-right border-r border-slate-200">Qty</th>
                        {showReceivedCol && <th className="w-24 px-2.5 py-2 text-right border-r border-slate-200">Received</th>}
                        {showDeliveredCol && <th className="w-24 px-2.5 py-2 text-right border-r border-slate-200">Delivered</th>}
                        {showBilledCol && <th className="w-24 px-2.5 py-2 text-right border-r border-slate-200">Billed</th>}
                        <th className="w-28 px-2.5 py-2 text-right border-r border-slate-200">Rate ({currency})</th>
                        <th className="w-20 px-2 py-2 text-right border-r border-slate-200">Disc %</th>
                        <th className="w-20 px-2 py-2 text-right border-r border-slate-200">VAT %</th>
                        <th className="w-32 px-2.5 py-2 text-right">Amount ({currency})</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-200">
                      {items.length === 0 ? (
                        <tr>
                          <td colSpan={12} className="px-4 py-6 text-center text-slate-500">
                            No line items recorded on this document.
                          </td>
                        </tr>
                      ) : (
                        items.map((l, idx) => (
                          <tr key={idx} className="hover:bg-slate-50/70">
                            <td className="px-2 py-2 text-center font-mono text-slate-500 border-r border-slate-200">{idx + 1}</td>
                            <td className="px-2.5 py-2 border-r border-slate-200">
                              <span className="font-mono font-semibold text-slate-900">{l.item_code}</span>
                              {l.description && l.description !== l.item_code && (
                                <span className="text-slate-700">: {l.description}</span>
                              )}
                              {l.extra_badge && <span className="ml-2 text-[11px] text-slate-500">[{l.extra_badge}]</span>}
                            </td>
                            <td className="px-2 py-2 text-center text-slate-700 border-r border-slate-200">{l.uom || 'LTR'}</td>
                            {showTankCol && <td className="px-2 py-2 font-mono text-slate-700 border-r border-slate-200">{l.tank_code || '-'}</td>}
                            {showBatchCol && <td className="px-2 py-2 font-mono text-slate-700 border-r border-slate-200">{l.batch_number || '-'}</td>}
                            <td className="px-2.5 py-2 text-right font-mono tabular-nums text-slate-900 border-r border-slate-200">
                              {Number(l.qty || 0).toLocaleString(undefined, { maximumFractionDigits: 4 })}
                            </td>
                            {showReceivedCol && (
                              <td className="px-2.5 py-2 text-right font-mono tabular-nums text-slate-700 border-r border-slate-200">
                                {Number(l.received_qty || 0).toLocaleString(undefined, { maximumFractionDigits: 4 })}
                              </td>
                            )}
                            {showDeliveredCol && (
                              <td className="px-2.5 py-2 text-right font-mono tabular-nums text-slate-700 border-r border-slate-200">
                                {Number(l.delivered_qty || 0).toLocaleString(undefined, { maximumFractionDigits: 4 })}
                              </td>
                            )}
                            {showBilledCol && (
                              <td className="px-2.5 py-2 text-right font-mono tabular-nums text-slate-700 border-r border-slate-200">
                                {Number(l.billed_qty || 0).toLocaleString(undefined, { maximumFractionDigits: 4 })}
                              </td>
                            )}
                            <td className="px-2.5 py-2 text-right font-mono tabular-nums text-slate-800 border-r border-slate-200">
                              {Number(l.rate || 0).toFixed(2)}
                            </td>
                            <td className="px-2 py-2 text-right font-mono tabular-nums text-slate-600 border-r border-slate-200">
                              {Number(l.discount_pct || 0).toFixed(1)}%
                            </td>
                            <td className="px-2 py-2 text-right font-mono tabular-nums text-slate-600 border-r border-slate-200">
                              {Number(l.vat_rate ?? vatRateDisplay).toFixed(1)}%
                            </td>
                            <td className="px-2.5 py-2 text-right font-mono font-medium tabular-nums text-slate-900">
                              {Number(l.line_total || 0).toFixed(2)}
                            </td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4 pt-2">
                  <div>
                    <label className="block text-[11px] font-medium text-slate-500 mb-1">Total Quantity</label>
                    <div className="px-3 py-1.5 bg-slate-50 border border-slate-200 rounded font-mono tabular-nums text-slate-800">
                      {totalQty.toLocaleString(undefined, { maximumFractionDigits: 4 })}
                    </div>
                  </div>
                  <div>
                    <label className="block text-[11px] font-medium text-slate-500 mb-1">Net Total ({currency})</label>
                    <div className="px-3 py-1.5 bg-slate-50 border border-slate-200 rounded font-mono tabular-nums text-slate-900 font-medium text-right">
                      {subtotal.toFixed(2)}
                    </div>
                  </div>
                </div>
              </div>

              {/* Taxes & Charges */}
              <div className="border-t border-slate-200 pt-4 space-y-3">
                <h4 className="text-xs font-semibold text-slate-800">Taxes and Charges</h4>
                <div className="border border-slate-200 rounded-md overflow-hidden">
                  <table className="w-full text-left border-collapse text-xs">
                    <thead>
                      <tr className="bg-slate-50 border-b border-slate-200 text-[11px] font-medium text-slate-600">
                        <th className="w-10 px-2 py-2 text-center border-r border-slate-200">No.</th>
                        <th className="px-2.5 py-2 border-r border-slate-200">Type</th>
                        <th className="px-2.5 py-2 border-r border-slate-200">Account Head</th>
                        <th className="w-24 px-2.5 py-2 text-right border-r border-slate-200">Tax Rate</th>
                        <th className="w-32 px-2.5 py-2 text-right border-r border-slate-200">Amount ({currency})</th>
                        <th className="w-32 px-2.5 py-2 text-right">Total ({currency})</th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr>
                        <td className="px-2 py-2 text-center font-mono text-slate-500 border-r border-slate-200">1</td>
                        <td className="px-2.5 py-2 border-r border-slate-200">On Net Total</td>
                        <td className="px-2.5 py-2 font-mono text-slate-700 border-r border-slate-200">{vatAccountHead}</td>
                        <td className="px-2.5 py-2 text-right font-mono tabular-nums border-r border-slate-200">{vatRateDisplay}%</td>
                        <td className="px-2.5 py-2 text-right font-mono tabular-nums border-r border-slate-200">{vatAmount.toFixed(2)}</td>
                        <td className="px-2.5 py-2 text-right font-mono tabular-nums font-medium">{totalAmount.toFixed(2)}</td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              </div>

              {/* Totals & In Words */}
              <div className="border-t border-slate-200 pt-4 grid grid-cols-1 md:grid-cols-2 gap-6 items-start">
                <div className="space-y-3">
                  {(freightAmount > 0 || discountAmount > 0) && (
                    <div className="grid grid-cols-2 gap-3">
                      {discountAmount > 0 && (
                        <div>
                          <label className="block text-[11px] font-medium text-slate-500 mb-1">Total Discount ({currency})</label>
                          <div className="px-3 py-1.5 bg-slate-50 border border-slate-200 rounded font-mono tabular-nums text-slate-800">
                            {discountAmount.toFixed(2)}
                          </div>
                        </div>
                      )}
                      {freightAmount > 0 && (
                        <div>
                          <label className="block text-[11px] font-medium text-slate-500 mb-1">Freight / Charges ({currency})</label>
                          <div className="px-3 py-1.5 bg-slate-50 border border-slate-200 rounded font-mono tabular-nums text-slate-800">
                            {freightAmount.toFixed(2)}
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                  <div>
                    <button
                      type="button"
                      onClick={() => setShowTaxBreakup((s) => !s)}
                      className="flex items-center gap-1.5 text-xs font-semibold text-slate-800 hover:text-slate-900"
                    >
                      Tax Breakup
                      {showTaxBreakup ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
                    </button>
                    {showTaxBreakup && (
                      <div className="mt-2 p-3 bg-slate-50 border border-slate-200 rounded text-[11px] space-y-1 font-mono tabular-nums">
                        <div className="flex justify-between">
                          <span className="text-slate-600">Taxable Net Value:</span>
                          <span>{currency} {subtotal.toFixed(2)}</span>
                        </div>
                        <div className="flex justify-between">
                          <span className="text-slate-600">VAT ({vatRateDisplay}%):</span>
                          <span>{currency} {vatAmount.toFixed(2)}</span>
                        </div>
                        <div className="flex justify-between font-semibold border-t border-slate-200 pt-1">
                          <span>Grand Total:</span>
                          <span>{currency} {totalAmount.toFixed(2)}</span>
                        </div>
                      </div>
                    )}
                  </div>
                </div>

                <div className="space-y-2.5">
                  <div>
                    <label className="block text-[11px] font-medium text-slate-500 mb-1">Grand Total ({currency})</label>
                    <div className="px-3 py-2 bg-slate-100 border border-slate-200 rounded font-mono font-semibold text-slate-900 text-right tabular-nums">
                      {totalAmount.toFixed(2)}
                    </div>
                  </div>
                  <div>
                    <label className="block text-[11px] font-medium text-slate-500 mb-1">In Words ({currency})</label>
                    <div className="px-3 py-1.5 bg-slate-50 border border-slate-200 rounded text-slate-700 font-medium">
                      {numberToWords(totalAmount, currency)}
                    </div>
                  </div>
                </div>
              </div>
            </>
          )}

          {activeTab === 'address' && (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="block text-[11px] font-medium text-slate-500 mb-1">{partyLabel} Name</label>
                <div className="px-3 py-1.5 bg-slate-50 border border-slate-200 rounded text-slate-900 font-medium">{partyName || '-'}</div>
              </div>
              <div>
                <label className="block text-[11px] font-medium text-slate-500 mb-1">TRN / Tax Registration</label>
                <div className="px-3 py-1.5 bg-slate-50 border border-slate-200 rounded font-mono text-slate-800">{partyTrn || '-'}</div>
              </div>
              <div className="md:col-span-2">
                <label className="block text-[11px] font-medium text-slate-500 mb-1">Address</label>
                <div className="px-3 py-2 bg-slate-50 border border-slate-200 rounded text-slate-800">
                  {partyAddress || '-'} {partyCountry ? `(${partyCountry})` : ''}
                </div>
              </div>
              <div>
                <label className="block text-[11px] font-medium text-slate-500 mb-1">Contact Person</label>
                <div className="px-3 py-1.5 bg-slate-50 border border-slate-200 rounded text-slate-800">{partyContactPerson || '-'}</div>
              </div>
              <div>
                <label className="block text-[11px] font-medium text-slate-500 mb-1">Telephone</label>
                <div className="px-3 py-1.5 bg-slate-50 border border-slate-200 rounded font-mono text-slate-800">{partyTelephone || '-'}</div>
              </div>
            </div>
          )}

          {activeTab === 'terms' && (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="block text-[11px] font-medium text-slate-500 mb-1">Payment Terms</label>
                <div className="px-3 py-1.5 bg-slate-50 border border-slate-200 rounded text-slate-800">{paymentTerms || 'Standard'}</div>
              </div>
              <div>
                <label className="block text-[11px] font-medium text-slate-500 mb-1">Delivery Terms / Incoterms</label>
                <div className="px-3 py-1.5 bg-slate-50 border border-slate-200 rounded text-slate-800">{deliveryTerms || '-'}</div>
              </div>
              <div className="md:col-span-2">
                <label className="block text-[11px] font-medium text-slate-500 mb-1">Delivery Location / Dispatch Address</label>
                <div className="px-3 py-1.5 bg-slate-50 border border-slate-200 rounded text-slate-800">{deliveryPlace || warehouseName || '-'}</div>
              </div>
              <div className="md:col-span-2">
                <label className="block text-[11px] font-medium text-slate-500 mb-1">Remarks & Special Instructions</label>
                <div className="px-3 py-2 bg-slate-50 border border-slate-200 rounded text-slate-800 whitespace-pre-wrap min-h-[56px]">
                  {remarks || '-'}
                </div>
              </div>
            </div>
          )}

          {activeTab === 'more' && (
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div>
                <label className="block text-[11px] font-medium text-slate-500 mb-1">Created By</label>
                <div className="px-3 py-1.5 bg-slate-50 border border-slate-200 rounded text-slate-800">{creatorName || '-'}</div>
              </div>
              <div>
                <label className="block text-[11px] font-medium text-slate-500 mb-1">Created At</label>
                <div className="px-3 py-1.5 bg-slate-50 border border-slate-200 rounded font-mono text-slate-800">
                  {createdAt ? createdAt.slice(0, 16).replace('T', ' ') : '-'}
                </div>
              </div>
              <div>
                <label className="block text-[11px] font-medium text-slate-500 mb-1">Approved / Submitted By</label>
                <div className="px-3 py-1.5 bg-slate-50 border border-slate-200 rounded text-slate-800">
                  {approverName || '-'} {submittedAt ? `(${submittedAt.slice(0, 10)})` : ''}
                </div>
              </div>
              <div>
                <label className="block text-[11px] font-medium text-slate-500 mb-1">Revision No.</label>
                <div className="px-3 py-1.5 bg-slate-50 border border-slate-200 rounded font-mono text-slate-800">{revisionNo}</div>
              </div>
              <div>
                <label className="block text-[11px] font-medium text-slate-500 mb-1">Revision Date</label>
                <div className="px-3 py-1.5 bg-slate-50 border border-slate-200 rounded font-mono text-slate-800">{revisionDate || '-'}</div>
              </div>
              <div>
                <label className="block text-[11px] font-medium text-slate-500 mb-1">Amended From</label>
                <div className="px-3 py-1.5 bg-slate-50 border border-slate-200 rounded font-mono text-slate-800">{amendedFrom || '-'}</div>
              </div>
            </div>
          )}

          {activeTab === 'connections' && (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <div>
                <h4 className="text-xs font-semibold text-slate-900 flex items-center gap-1.5 mb-2.5">
                  <Link2 className="w-3.5 h-3.5 text-slate-500" />
                  Connected Transactions ({links.length})
                </h4>
                {connErr && <p className="text-xs text-red-600 mb-2">{connErr}</p>}
                {links.length === 0 ? (
                  <p className="text-xs text-slate-500 p-3 bg-slate-50 border border-slate-200 rounded">
                    No upstream or downstream linked documents yet.
                  </p>
                ) : (
                  <div className="divide-y divide-slate-200 border border-slate-200 rounded-md">
                    {links.map((l, idx) => (
                      <div key={idx} className="px-3 py-2 flex items-center justify-between gap-2 text-xs bg-white">
                        <div>
                          {onNavigateLink ? (
                            <button
                              type="button"
                              onClick={() => onNavigateLink({ docType: l.docType, id: l.id, docNumber: l.docNumber })}
                              className="font-mono font-semibold text-slate-900 hover:underline"
                            >
                              {l.docNumber}
                            </button>
                          ) : (
                            <span className="font-mono font-semibold text-slate-900">{l.docNumber}</span>
                          )}
                          <span className="text-slate-400 mx-1.5">·</span>
                          <span className="text-slate-600">{l.relation}</span>
                        </div>
                        <span className="text-[11px] text-slate-600 bg-slate-100 border border-slate-200 px-2 py-0.5 rounded">
                          {l.status}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <div>
                <div className="flex items-center justify-between mb-2.5">
                  <h4 className="text-xs font-semibold text-slate-900 flex items-center gap-1.5">
                    <Paperclip className="w-3.5 h-3.5 text-slate-500" />
                    Attachments ({attachments.length})
                  </h4>
                  <label className="inline-flex items-center gap-1 px-2.5 py-1 text-[11px] font-medium text-white bg-slate-900 rounded cursor-pointer hover:bg-slate-800">
                    <Upload className="w-3 h-3" />
                    {uploading ? 'Uploading...' : 'Attach File'}
                    <input type="file" className="hidden" onChange={handleUpload} disabled={uploading} />
                  </label>
                </div>
                {attachments.length === 0 ? (
                  <p className="text-xs text-slate-500 p-3 bg-slate-50 border border-slate-200 rounded">
                    No files attached. Supports PDF, Excel, Word, and images.
                  </p>
                ) : (
                  <div className="divide-y divide-slate-200 border border-slate-200 rounded-md">
                    {attachments.map((a) => (
                      <div key={a.id} className="px-3 py-2 flex items-center justify-between text-xs bg-white">
                        <div className="min-w-0 pr-2">
                          <p className="font-medium text-slate-800 truncate">{a.file_name}</p>
                          <p className="text-[11px] text-slate-500 tabular-nums">
                            {(a.size_bytes / 1024).toFixed(1)} KB · {a.uploaded_by_name || 'User'}
                          </p>
                        </div>
                        <button
                          type="button"
                          onClick={() => downloadProtectedFile(`/api/system/attachments/${a.id}/download`, a.file_name)}
                          className="p-1.5 text-slate-600 hover:text-slate-900 rounded hover:bg-slate-100"
                          title="Download Attachment"
                        >
                          <Download className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Bottom ERPNext-Style Activity Timeline */}
      <div className="bg-white border border-slate-200 rounded-lg p-5">
        <h4 className="text-xs font-semibold text-slate-900 flex items-center gap-1.5 mb-3">
          <History className="w-3.5 h-3.5 text-slate-500" />
          Activity & Document History
        </h4>
        {audit.length === 0 ? (
          <p className="text-xs text-slate-500">No activity recorded yet.</p>
        ) : (
          <div className="space-y-2.5 border-l border-slate-200 ml-1.5 pl-4">
            {audit.map((a) => (
              <div key={a.id} className="relative text-xs flex flex-wrap items-center justify-between gap-2 pb-1">
                <span className="absolute -left-[21px] top-1.5 w-2 h-2 rounded-full bg-slate-400" />
                <div>
                  <span className="font-medium text-slate-900">{a.username}</span>{' '}
                  <span className="text-slate-600">— {a.action}</span>
                </div>
                <span className="text-[11px] text-slate-500 font-mono tabular-nums">
                  {a.created_at.slice(0, 16).replace('T', ' ')}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
