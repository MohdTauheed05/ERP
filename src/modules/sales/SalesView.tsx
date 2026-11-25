import React, { useEffect, useState } from 'react';
import { FileSpreadsheet, FileText, Plus, Send, Truck } from 'lucide-react';
import { apiRequest } from '../../services/api';
import { DataTable, type ColumnDef } from '../../components/DataTable';
import { DocumentPanel } from '../../components/DocumentPanel';
import { ErpDocumentForm, type ErpDocMetaState, type ErpFormItemMaster, type ErpFormLine, type ErpFormParty } from '../../components/ErpDocumentForm';
import { ErpDocumentViewer, type ErpViewerAction, type ErpViewerItemLine } from '../../components/ErpDocumentViewer';
import { ExcelImportModal } from '../../components/ExcelImportModal';
import { exportStandardErpPdf } from '../../utils/export';
import { useCompany } from '../../context/CompanyContext';

type SalesTab = 'quotations' | 'orders' | 'deliveries' | 'invoices' | 'returns';

export function SalesView() {
  const [tab, setTab] = useState<SalesTab>('orders');
  const [quotations, setQuotations] = useState<Record<string, unknown>[]>([]);
  const [orders, setOrders] = useState<Record<string, unknown>[]>([]);
  const [deliveries, setDeliveries] = useState<Record<string, unknown>[]>([]);
  const [invoices, setInvoices] = useState<Record<string, unknown>[]>([]);
  const [returns, setReturns] = useState<Record<string, unknown>[]>([]);

  const [customers, setCustomers] = useState<ErpFormParty[]>([]);
  const [items, setItems] = useState<ErpFormItemMaster[]>([]);
  const [warehouses, setWarehouses] = useState<{ id: number; code?: string; name: string; warehouse_type: string }[]>([]);
  const [priceLists, setPriceLists] = useState<{ id: number; name: string; list_type: string }[]>([]);
  const { company, logoUrl } = useCompany();
  const [paymentTerms, setPaymentTerms] = useState<{ id: number; name: string }[]>([]);

  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [showImportModal, setShowImportModal] = useState(false);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const [panelDoc, setPanelDoc] = useState<{ docType: string; docId: number; docNumber: string } | null>(null);

  const [showOrderModal, setShowOrderModal] = useState<'quotation' | 'order' | 'return' | null>(null);
  const [viewingDoc, setViewingDoc] = useState<{ type: SalesTab; id: number } | null>(null);
  const [editingSo, setEditingSo] = useState<{ id: number; so_number: string; status: string; amended_from?: string } | null>(null);
  const todayStr = new Date().toISOString().slice(0, 10);
  const [docMeta, setDocMeta] = useState<ErpDocMetaState>({
    doc_date: todayStr,
    delivery_date: todayStr,
    party_id: '',
    warehouse_id: '',
    target_warehouse_id: '',
    payment_term_id: '',
    price_list_id: '',
    currency: 'AED',
    exchange_rate: '1',
    linked_po_id: '',
    linked_grn_id: '',
    linked_rfq_id: '',
    party_ref_no: '',
    supplier_inv_no: '',
    supplier_dn_no: '',
    delivery_terms: '',
    delivery_place: '',
    revision_no: 'Original',
    freight_amount: '0',
    tax_template: 'UAE VAT 5%',
    tax_category: 'Standard Rated',
    disable_rounded_total: true,
    additional_discount_pct: '0',
    reason: 'Customer complaint / damaged drum',
    remarks: '',
  });
  const [lines, setLines] = useState<ErpFormLine[]>([{ item_id: '', qty: 100, rate: 0, discount_pct: 0, vat_rate: 5 }]);

  // Delivery Note modal
  const [dnModalSo, setDnModalSo] = useState<Record<string, unknown> | null>(null);
  const [dnForm, setDnForm] = useState({ vehicle_number: 'DXB-84210', driver_name: 'Rashid Ali', batch_number: '' });
  const [dnItems, setDnItems] = useState<{ so_item_id: number; item_id: number; item_name: string; remaining_qty: number; qty: string; batch_number: string }[]>([]);

  const loadAll = async () => {
    setLoading(true);
    try {
      const [sq, so, dn, si, sr, cust, it, wh, pl, pt] = await Promise.all([
        apiRequest<{ items: Record<string, unknown>[] }>('/api/sales/quotations'),
        apiRequest<{ items: Record<string, unknown>[] }>('/api/sales/orders'),
        apiRequest<{ items: Record<string, unknown>[] }>('/api/sales/delivery-notes'),
        apiRequest<{ items: Record<string, unknown>[] }>('/api/sales/invoices'),
        apiRequest<{ items: Record<string, unknown>[] }>('/api/sales/returns'),
        apiRequest<{ items: typeof customers }>('/api/masters/customers'),
        apiRequest<{ items: typeof items }>('/api/masters/items'),
        apiRequest<{ items: typeof warehouses }>('/api/masters/warehouses'),
        apiRequest<{ items: typeof priceLists }>('/api/masters/price-lists'),
        apiRequest<{ items: typeof paymentTerms }>('/api/masters/payment-terms'),
      ]);
      setQuotations(sq.items);
      setOrders(so.items);
      setDeliveries(dn.items);
      setInvoices(si.items);
      setReturns(sr.items);
      setCustomers(cust.items);
      setItems(it.items);
      setWarehouses(wh.items);
      setPriceLists(pl.items.filter((p) => p.list_type === 'Sales'));
      setPaymentTerms(pt.items);

      const fgWh = wh.items.find((w) => w.warehouse_type === 'Finished Goods')?.id || wh.items[0]?.id || '';
      setDocMeta((h) => ({
        ...h,
        warehouse_id: h.warehouse_id || fgWh,
      }));
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : 'Failed to load sales data');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadAll();
  }, []);

  const openSalesDocForm = (mode: 'quotation' | 'order' | 'return') => {
    const fgWh = warehouses.find((w) => w.warehouse_type === 'Finished Goods')?.id || warehouses[0]?.id || '';
    setEditingSo(null);
    setViewingDoc(null);
    setDocMeta({
      doc_date: todayStr,
      delivery_date: todayStr,
      party_id: '',
      warehouse_id: fgWh,
      target_warehouse_id: '',
      payment_term_id: '',
      price_list_id: '',
      currency: company.currency || 'AED',
      exchange_rate: '1',
      linked_po_id: '',
      linked_grn_id: '',
      linked_rfq_id: '',
      party_ref_no: '',
      supplier_inv_no: '',
      supplier_dn_no: '',
      delivery_terms: '',
      delivery_place: '',
      revision_no: 'Original',
      freight_amount: '0',
      tax_template: 'UAE VAT 5%',
      tax_category: 'Standard Rated',
      disable_rounded_total: true,
      additional_discount_pct: '0',
      reason: 'Customer complaint / damaged drum',
      remarks: '',
    });
    setLines([{ item_id: '', qty: 1, rate: 0, discount_pct: 0, vat_rate: 5, required_by: todayStr }]);
    setErr('');
    setShowOrderModal(mode);
  };

  const openEditSo = (so: Record<string, unknown>) => {
    const soItems = (so.items as Record<string, unknown>[]) || [];
    setEditingSo({
      id: Number(so.id),
      so_number: String(so.so_number || ''),
      status: String(so.status || 'Draft'),
      amended_from: so.amended_from ? String(so.amended_from) : undefined,
    });
    setDocMeta({
      doc_date: String(so.order_date || todayStr),
      delivery_date: String(so.delivery_date || todayStr),
      party_id: Number(so.customer_id || ''),
      warehouse_id: Number(so.warehouse_id || warehouses[0]?.id || ''),
      target_warehouse_id: '',
      payment_term_id: so.payment_term_id ? Number(so.payment_term_id) : '',
      price_list_id: so.price_list_id ? Number(so.price_list_id) : '',
      currency: String(so.currency || company.currency || 'AED'),
      exchange_rate: String(so.exchange_rate || 1),
      linked_po_id: '',
      linked_grn_id: '',
      linked_rfq_id: '',
      party_ref_no: String(so.customer_ref || ''),
      supplier_inv_no: '',
      supplier_dn_no: '',
      delivery_terms: String(so.delivery_terms || ''),
      delivery_place: String(so.delivery_place || ''),
      revision_no: String(so.revision_no || 'Original'),
      freight_amount: '0',
      tax_template: Number(so.vat_amount || 0) > 0 ? 'UAE VAT 5%' : 'Zero Rated 0%',
      tax_category: 'Standard Rated',
      disable_rounded_total: true,
      additional_discount_pct: '0',
      reason: '',
      remarks: String(so.remarks || ''),
    });
    setLines(
      soItems.length > 0
        ? soItems.map((i) => ({
            item_id: Number(i.item_id),
            qty: Number(i.qty || 1),
            rate: Number(i.rate || 0),
            discount_pct: Number(i.discount_pct || 0),
            vat_rate: Number(i.vat_rate ?? 5),
            required_by: String(so.delivery_date || todayStr),
          }))
        : [{ item_id: '', qty: 1, rate: 0, discount_pct: 0, vat_rate: 5, required_by: todayStr }]
    );
    setViewingDoc(null);
    setErr('');
    setShowOrderModal('order');
  };

  const openMakeSalesReturnFromDoc = (doc: Record<string, unknown>) => {
    const docItems = (doc.items as Record<string, unknown>[]) || [];
    const fgWh = Number(doc.warehouse_id || warehouses.find((w) => w.warehouse_type === 'Finished Goods')?.id || warehouses[0]?.id || '');
    openSalesDocForm('return');
    setDocMeta((m) => ({
      ...m,
      party_id: Number(doc.customer_id || ''),
      warehouse_id: fgWh,
      currency: String(doc.currency || company.currency || 'AED'),
      reason: `Return against ${String(doc.so_number || doc.dn_number || doc.si_number || '')}`,
    }));
    if (docItems.length > 0) {
      setLines(
        docItems.map((i) => ({
          item_id: Number(i.item_id),
          qty: Number(i.qty || 1),
          rate: Number(i.rate ?? i.unit_cost ?? 0),
          discount_pct: 0,
          vat_rate: Number(i.vat_rate ?? 5),
          required_by: todayStr,
        }))
      );
    }
  };

  const lookupPrice = async (idx: number, itemId: number, qty: number) => {
    try {
      const qs = new URLSearchParams({
        item_id: String(itemId),
        qty: String(qty || 1),
        list_type: 'Sales',
        ...(docMeta.price_list_id ? { price_list_id: String(docMeta.price_list_id) } : {}),
        ...(docMeta.party_id ? { party_id: String(docMeta.party_id) } : {}),
      });
      const res = await apiRequest<{ rate: number; discount_pct: number; vat_rate: number }>(`/api/masters/price-lookup?${qs.toString()}`);
      setLines((prev) => {
        const copy = [...prev];
        if (copy[idx]) {
          copy[idx] = {
            ...copy[idx],
            item_id: itemId,
            rate: res.rate,
            discount_pct: res.discount_pct,
            vat_rate: docMeta.tax_template === 'UAE VAT 5%' ? res.vat_rate : 0,
          };
        }
        return copy;
      });
    } catch {
      const item = items.find((i) => i.id === itemId);
      setLines((prev) => {
        const copy = [...prev];
        if (copy[idx] && item) {
          copy[idx] = {
            ...copy[idx],
            item_id: itemId,
            rate: item.selling_price || 0,
            vat_rate: docMeta.tax_template === 'UAE VAT 5%' ? (item.vat_rate ?? 5) : 0,
          };
        }
        return copy;
      });
    }
  };

  const submitSalesDoc = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr('');
    const addDisc = Number(docMeta.additional_discount_pct || 0);
    const validLines = lines
      .filter((l) => Number(l.item_id) > 0 && Number(l.qty) > 0)
      .map((l) => {
        const lineDisc = Number(l.discount_pct || 0);
        const effDisc = addDisc > 0 ? Math.min(100, lineDisc + addDisc - (lineDisc * addDisc) / 100) : lineDisc;
        return {
          item_id: Number(l.item_id),
          qty: Number(l.qty),
          rate: Number(l.rate || 0),
          discount_pct: effDisc,
          vat_rate: docMeta.tax_template === 'UAE VAT 5%' ? Number(l.vat_rate ?? 5) : 0,
        };
      });
    if (!docMeta.party_id || validLines.length === 0) {
      setErr('Customer and at least one item line are required.');
      return;
    }
    setSubmitting(true);
    try {
      const payloadCommon = {
        customer_id: Number(docMeta.party_id),
        warehouse_id: Number(docMeta.warehouse_id),
        price_list_id: docMeta.price_list_id ? Number(docMeta.price_list_id) : undefined,
        payment_term_id: docMeta.payment_term_id ? Number(docMeta.payment_term_id) : undefined,
        currency: docMeta.currency,
        exchange_rate: Number(docMeta.exchange_rate || 1),
        customer_ref: docMeta.party_ref_no,
        delivery_terms: docMeta.delivery_terms,
        delivery_place: docMeta.delivery_place,
        delivery_date: docMeta.delivery_date,
        revision_no: docMeta.revision_no || 'Original',
        freight_amount: Number(docMeta.freight_amount || 0),
        remarks: docMeta.remarks,
      };
      if (showOrderModal === 'quotation') {
        const res = await apiRequest<{ id: number; sq_number: string }>('/api/sales/quotations', {
          method: 'POST',
          body: JSON.stringify({
            ...payloadCommon,
            quotation_date: docMeta.doc_date,
            valid_until: docMeta.delivery_date,
            items: validLines,
          }),
        });
        setMsg(`Sales Quotation ${res.sq_number} created.`);
        setViewingDoc({ type: 'quotations', id: res.id });
      } else if (showOrderModal === 'order') {
        if (editingSo) {
          await apiRequest(`/api/sales/orders/${editingSo.id}`, {
            method: 'PUT',
            body: JSON.stringify({
              ...payloadCommon,
              order_date: docMeta.doc_date,
              items: validLines,
            }),
          });
          setMsg(`Sales Order ${editingSo.so_number} updated.`);
          setViewingDoc({ type: 'orders', id: editingSo.id });
          setEditingSo(null);
        } else {
          const res = await apiRequest<{ id: number; so_number: string }>('/api/sales/orders', {
            method: 'POST',
            body: JSON.stringify({
              ...payloadCommon,
              order_date: docMeta.doc_date,
              reserve_stock: true,
              items: validLines,
            }),
          });
          setMsg(`Sales Order ${res.so_number} submitted with stock reservation.`);
          setViewingDoc({ type: 'orders', id: res.id });
        }
      } else if (showOrderModal === 'return') {
        const res = await apiRequest<{ id: number; sr_number: string }>('/api/sales/returns', {
          method: 'POST',
          body: JSON.stringify({
            customer_id: Number(docMeta.party_id),
            warehouse_id: Number(docMeta.warehouse_id),
            return_date: docMeta.doc_date,
            reason: docMeta.reason || docMeta.remarks || 'Sales return',
            items: validLines,
          }),
        });
        setMsg(`Sales Return & Credit Note ${res.sr_number} posted.`);
        setViewingDoc({ type: 'returns', id: res.id });
      }
      setShowOrderModal(null);
      await loadAll();
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : 'Failed to save sales document');
    } finally {
      setSubmitting(false);
    }
  };

  const convertQuotationToOrder = async (sq: Record<string, unknown>) => {
    setErr('');
    try {
      const fgWh = warehouses.find((w) => w.warehouse_type === 'Finished Goods')?.id || warehouses[0]?.id || 1;
      const sqItems = (sq.items as Record<string, unknown>[]) || [];
      const res = await apiRequest<{ so_number: string }>('/api/sales/orders', {
        method: 'POST',
        body: JSON.stringify({
          customer_id: Number(sq.customer_id),
          sq_id: Number(sq.id),
          warehouse_id: fgWh,
          currency: String(sq.currency || 'AED'),
          exchange_rate: Number(sq.exchange_rate || 1),
          items: sqItems.map((i) => ({ item_id: Number(i.item_id), qty: Number(i.qty), rate: Number(i.rate), discount_pct: Number(i.discount_pct || 0), vat_rate: Number(i.vat_rate ?? 5) })),
        }),
      });
      setMsg(`Quotation converted to Sales Order ${res.so_number}.`);
      await loadAll();
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : 'Conversion failed');
    }
  };

  const openDeliveryModal = (so: Record<string, unknown>) => {
    setDnModalSo(so);
    const soItems = (so.items as Record<string, unknown>[]) || [];
    setDnItems(
      soItems
        .map((i) => ({
          so_item_id: Number(i.id),
          item_id: Number(i.item_id),
          item_name: `${String(i.item_code)} — ${String(i.item_name)}`,
          remaining_qty: Math.max(0, Number(i.qty) - Number(i.delivered_qty || 0)),
          qty: String(Math.max(0, Number(i.qty) - Number(i.delivered_qty || 0))),
          batch_number: '',
        }))
        .filter((x) => x.remaining_qty > 0)
    );
  };

  const submitDeliveryNote = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!dnModalSo) return;
    setErr('');
    try {
      const payloadItems = dnItems
        .filter((i) => Number(i.qty) > 0)
        .map((i) => ({
          so_item_id: i.so_item_id,
          item_id: i.item_id,
          qty: Number(i.qty),
          batch_number: i.batch_number || undefined,
        }));
      const res = await apiRequest<{ dn_number: string }>('/api/sales/delivery-notes', {
        method: 'POST',
        body: JSON.stringify({
          so_id: Number(dnModalSo.id),
          customer_id: Number(dnModalSo.customer_id),
          warehouse_id: Number(dnModalSo.warehouse_id),
          vehicle_number: dnForm.vehicle_number,
          driver_name: dnForm.driver_name,
          items: payloadItems,
        }),
      });
      setDnModalSo(null);
      setMsg(`Delivery Note ${res.dn_number} dispatched and COGS posted.`);
      await loadAll();
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : 'Failed to create delivery note');
    }
  };

  const invoiceFromOrder = async (so: Record<string, unknown>) => {
    setErr('');
    try {
      const soItems = (so.items as Record<string, unknown>[]) || [];
      const res = await apiRequest<{ si_number: string }>('/api/sales/invoices', {
        method: 'POST',
        body: JSON.stringify({
          customer_id: Number(so.customer_id),
          so_id: Number(so.id),
          customer_invoice_ref: String(so.customer_ref || ''),
          delivery_terms: String(so.delivery_terms || ''),
          delivery_place: String(so.delivery_place || ''),
          currency: String(so.currency || 'AED'),
          exchange_rate: Number(so.exchange_rate || 1),
          payment_term_id: so.payment_term_id ? Number(so.payment_term_id) : undefined,
          post_now: true,
          items: soItems.map((i) => ({
            so_item_id: Number(i.id),
            item_id: Number(i.item_id),
            qty: Number(i.qty),
            rate: Number(i.rate),
            discount_pct: Number(i.discount_pct || 0),
            vat_rate: Number(i.vat_rate ?? 5),
          })),
        }),
      });
      setMsg(`Tax Invoice ${res.si_number} posted to AR, VAT Output & Revenue GL.`);
      await loadAll();
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : 'Failed to generate sales invoice');
    }
  };

  const printSalesStandardPdf = (docType: 'SQ' | 'SO' | 'DN' | 'SI' | 'SR', doc: Record<string, unknown>) => {
    const rawLines = (doc.items as Record<string, unknown>[]) || [];
    const mappedItems = rawLines.map((l) => {
      const qty = Number(l.qty || 0);
      const unitPrice = Number(l.rate ?? l.unit_cost ?? 0);
      const vatPct = Number(l.vat_rate ?? (docType === 'DN' ? 0 : 5));
      const vatAmt = Number(l.vat_amount ?? 0);
      const total = Number(l.line_total ?? qty * unitPrice + vatAmt);
      return {
        item_code: String(l.item_code || ''),
        description: String(l.description || l.item_name || ''),
        qty,
        uom: String(l.uom || ''),
        unit_price: unitPrice,
        vat_pct: vatPct,
        vat_amount: vatAmt,
        total,
      };
    });

    const netSum = doc.subtotal !== undefined ? Number(doc.subtotal) : mappedItems.reduce((s, i) => s + i.qty * i.unit_price, 0);
    const vatSum = doc.vat_amount !== undefined ? Number(doc.vat_amount) : mappedItems.reduce((s, i) => s + i.vat_amount, 0);
    const grandSum = doc.total_amount !== undefined ? Number(doc.total_amount) : netSum + vatSum;

    const metaByType: Record<typeof docType, { title: string; label: string; number: string; date: string; delDate: string }> = {
      SQ: {
        title: 'SALES QUOTATION',
        label: 'Quotation No.',
        number: String(doc.sq_number || ''),
        date: String(doc.quotation_date || ''),
        delDate: String(doc.valid_until || ''),
      },
      SO: {
        title: 'SALES ORDER',
        label: 'SO No.',
        number: String(doc.so_number || ''),
        date: String(doc.order_date || ''),
        delDate: String(doc.delivery_date || ''),
      },
      DN: {
        title: 'DELIVERY NOTE',
        label: 'DN No.',
        number: String(doc.dn_number || ''),
        date: String(doc.delivery_date || ''),
        delDate: String(doc.delivery_date || ''),
      },
      SI: {
        title: 'TAX INVOICE',
        label: 'Invoice No.',
        number: String(doc.si_number || ''),
        date: String(doc.invoice_date || ''),
        delDate: String(doc.due_date || ''),
      },
      SR: {
        title: 'SALES RETURN / CREDIT NOTE',
        label: 'Return No.',
        number: String(doc.sr_number || ''),
        date: String(doc.return_date || ''),
        delDate: '',
      },
    };
    const cfg = metaByType[docType];

    void exportStandardErpPdf({
      docTitle: cfg.title,
      docNumberLabel: cfg.label,
      docNumber: cfg.number,
      docDate: cfg.date,
      company,
      logoUrl,
      companyRole: 'Seller',
      partyRole: 'Buyer',
      partyName: String(doc.customer_name || ''),
      partyTrn: String(doc.customer_trn || ''),
      partyAddress: String(doc.customer_address || ''),
      partyCountry: String(doc.customer_country || ''),
      partyContactPerson: String(doc.customer_contact_person || ''),
      paymentTerms: String(doc.payment_term_name || ''),
      deliveryTerms: String(doc.delivery_terms || (docType === 'DN' && doc.vehicle_number ? `Vehicle: ${String(doc.vehicle_number)}` : '')),
      deliveryDate: cfg.delDate,
      deliveryPlace: String(doc.delivery_place || doc.warehouse_name || doc.customer_address || ''),
      partyRefLabel: 'Customer Ref. No.',
      partyRefNo: String(doc.customer_ref || doc.customer_invoice_ref || doc.so_number || '-'),
      exchangeRate: Number(doc.exchange_rate || 1),
      revisionNo: String(doc.revision_no || 'Original'),
      revisionDate: String(doc.revision_date || ''),
      currency: String(doc.currency || company.currency || 'AED'),
      items: mappedItems,
      netTotal: netSum,
      vatTotal: vatSum,
      grandTotal: grandSum,
      remarks: String(doc.remarks || doc.reason || doc.terms || ''),
      preparedBy: String(doc.creator_name || ''),
      authorizedBy: String(doc.approver_name || ''),
      creatorName: String(doc.creator_name || ''),
    });
  };

  const orderCols: ColumnDef<Record<string, unknown>>[] = [
    { key: 'so_number', header: 'SO #' },
    { key: 'customer_name', header: 'Customer' },
    { key: 'order_date', header: 'Order Date' },
    { key: 'warehouse_name', header: 'Warehouse' },
    { key: 'total_amount', header: 'Total', numeric: true, render: (r) => `${String(r.currency)} ${Number(r.total_amount || 0).toFixed(2)}` },
    { key: 'delivered_status', header: 'Delivery' },
    { key: 'billed_status', header: 'Billing' },
    {
      key: 'actions',
      header: 'Actions',
      render: (r) => (
        <div className="flex items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
          {r.delivered_status !== 'Delivered' && (
            <button type="button" onClick={() => openDeliveryModal(r)} className="inline-flex items-center gap-1 px-2 py-1 text-xs font-medium bg-slate-900 text-white rounded hover:bg-slate-800">
              <Truck className="w-3 h-3" /> Deliver
            </button>
          )}
          {r.billed_status !== 'Billed' && (
            <button type="button" onClick={() => void invoiceFromOrder(r)} className="inline-flex items-center gap-1 px-2 py-1 text-xs font-medium bg-emerald-700 text-white rounded hover:bg-emerald-800">
              <Send className="w-3 h-3" /> Post Invoice
            </button>
          )}
          <button type="button" onClick={() => printSalesStandardPdf('SO', r)} className="p-1 text-slate-600 hover:text-slate-900" title="Download SO PDF">
            <FileText className="w-3.5 h-3.5" />
          </button>
          <button type="button" onClick={() => setPanelDoc({ docType: 'SalesOrder', docId: Number(r.id), docNumber: String(r.so_number) })} className="px-2 py-1 text-xs border border-slate-300 rounded hover:bg-slate-50">
            Links
          </button>
        </div>
      ),
    },
  ];

  if (showOrderModal) {
    const salesCfg =
      showOrderModal === 'quotation'
        ? { title: 'New Sales Quotation', series: 'SAL-QTN-.YYYY.-', pdfTitle: 'SALES QUOTATION', numLabel: 'Quotation No.', saveLabel: 'Save Quotation' }
        : showOrderModal === 'order'
        ? {
            title: editingSo ? 'Edit Sales Order' : 'New Sales Order',
            series: 'SAL-ORD-.YYYY.-',
            pdfTitle: 'SALES ORDER',
            numLabel: 'SO No.',
            saveLabel: editingSo ? 'Save Changes' : 'Save & Reserve',
          }
        : { title: 'New Sales Return & Credit Note', series: 'SAL-RET-.YYYY.-', pdfTitle: 'SALES RETURN / CREDIT NOTE', numLabel: 'Return No.', saveLabel: 'Post Return' };

    return (
      <div className="space-y-4">
        {err && <div className="p-3 bg-red-50 border border-red-200 rounded text-xs text-red-700">{err}</div>}
        <ErpDocumentForm
          title={salesCfg.title}
          seriesCode={salesCfg.series}
          docTitleForPdf={salesCfg.pdfTitle}
          docNumberLabel={salesCfg.numLabel}
          companyRole="Seller"
          partyRole="Buyer"
          partyLabel="Customer"
          partyRefLabel="Customer Ref / LPO #"
          warehouseLabel="Set Source Warehouse"
          showParty={true}
          showPaymentTerms={showOrderModal !== 'return'}
          showPriceList={showOrderModal !== 'return'}
          showFreight={showOrderModal !== 'return'}
          showReason={showOrderModal === 'return'}
          parties={customers}
          items={items}
          warehouses={warehouses}
          paymentTerms={paymentTerms}
          priceLists={priceLists}
          meta={docMeta}
          setMeta={setDocMeta}
          lines={lines}
          setLines={setLines}
          onItemLookupRate={lookupPrice}
          onSave={submitSalesDoc}
          onCancel={() => {
            setShowOrderModal(null);
            setEditingSo(null);
          }}
          onOpenBulkImport={() => setShowImportModal(true)}
          submitting={submitting}
          saveLabel={salesCfg.saveLabel}
          editingDocNumber={showOrderModal === 'order' ? editingSo?.so_number : undefined}
          statusBadge={showOrderModal === 'order' && editingSo ? editingSo.status : undefined}
          amendedFrom={showOrderModal === 'order' ? editingSo?.amended_from : undefined}
        />
        <ExcelImportModal
          open={showImportModal}
          initialType="customers"
          onClose={() => setShowImportModal(false)}
          onImported={(m) => {
            setMsg(m);
            void loadAll();
          }}
        />
      </div>
    );
  }

  const renderDeliveryModal = () =>
    dnModalSo ? (
      <div className="fixed inset-0 bg-slate-900/40 z-50 flex items-center justify-center p-4">
        <form onSubmit={submitDeliveryNote} className="bg-white border border-slate-200 rounded-lg w-full max-w-2xl p-6 space-y-4 text-xs">
          <h3 className="text-base font-semibold text-slate-900">Dispatch Delivery Note — {String(dnModalSo.so_number)}</h3>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block font-medium text-slate-700 mb-1">Vehicle Number</label>
              <input required value={dnForm.vehicle_number} onChange={(e) => setDnForm({ ...dnForm, vehicle_number: e.target.value })} className="w-full px-3 py-1.5 border border-slate-300 rounded font-mono" />
            </div>
            <div>
              <label className="block font-medium text-slate-700 mb-1">Driver Name</label>
              <input required value={dnForm.driver_name} onChange={(e) => setDnForm({ ...dnForm, driver_name: e.target.value })} className="w-full px-3 py-1.5 border border-slate-300 rounded" />
            </div>
          </div>
          <div className="border border-slate-200 rounded overflow-hidden">
            <table className="w-full text-left">
              <thead className="bg-slate-50 border-b border-slate-200">
                <tr>
                  <th className="px-3 py-2">Item</th>
                  <th className="px-3 py-2 text-right">Remaining</th>
                  <th className="px-3 py-2 text-right">Dispatch Qty</th>
                  <th className="px-3 py-2">Batch # (Optional)</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {dnItems.map((it, idx) => (
                  <tr key={it.so_item_id}>
                    <td className="px-3 py-2">{it.item_name}</td>
                    <td className="px-3 py-2 text-right font-mono tabular-nums">{it.remaining_qty}</td>
                    <td className="px-3 py-2 text-right">
                      <input
                        type="number"
                        step="0.01"
                        max={it.remaining_qty}
                        value={it.qty}
                        onChange={(e) => {
                          const copy = [...dnItems];
                          copy[idx].qty = e.target.value;
                          setDnItems(copy);
                        }}
                        className="w-24 px-2 py-1 border border-slate-300 rounded text-right font-mono tabular-nums"
                      />
                    </td>
                    <td className="px-3 py-2">
                      <input
                        value={it.batch_number}
                        onChange={(e) => {
                          const copy = [...dnItems];
                          copy[idx].batch_number = e.target.value;
                          setDnItems(copy);
                        }}
                        placeholder="FIFO auto"
                        className="w-32 px-2 py-1 border border-slate-300 rounded font-mono"
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <button type="button" onClick={() => setDnModalSo(null)} className="px-3 py-1.5 border border-slate-300 rounded">Cancel</button>
            <button type="submit" className="px-4 py-1.5 bg-slate-900 text-white rounded font-medium">Dispatch & Post COGS</button>
          </div>
        </form>
      </div>
    ) : null;

  if (viewingDoc) {
    const listMap: Record<SalesTab, Record<string, unknown>[]> = {
      quotations,
      orders,
      deliveries,
      invoices,
      returns,
    };
    const activeList = listMap[viewingDoc.type] || [];
    const currentIndex = activeList.findIndex((x) => Number(x.id) === viewingDoc.id);
    const rec = currentIndex >= 0 ? activeList[currentIndex] : undefined;

    if (rec) {
      const apiDocTypeMap: Record<SalesTab, string> = {
        quotations: 'SalesQuotation',
        orders: 'SalesOrder',
        deliveries: 'DeliveryNote',
        invoices: 'SalesInvoice',
        returns: 'SalesReturn',
      };
      const pdfTypeMap: Record<SalesTab, 'SQ' | 'SO' | 'DN' | 'SI' | 'SR'> = {
        quotations: 'SQ',
        orders: 'SO',
        deliveries: 'DN',
        invoices: 'SI',
        returns: 'SR',
      };

      const rawLines = (rec.items as Record<string, unknown>[]) || [];
      const viewerItems: ErpViewerItemLine[] = rawLines.map((l) => {
        const qty = Number(l.qty || 0);
        const rate = Number(l.rate ?? l.unit_cost ?? 0);
        const vatPct = Number(l.vat_rate ?? (viewingDoc.type === 'deliveries' ? 0 : 5));
        const vatAmt = Number(l.vat_amount ?? 0);
        const lineTotal = Number(l.line_total ?? qty * rate + vatAmt);
        return {
          item_code: String(l.item_code || ''),
          description: String(l.description || l.item_name || ''),
          uom: String(l.uom || 'LTR'),
          qty,
          delivered_qty: l.delivered_qty !== undefined ? Number(l.delivered_qty) : undefined,
          billed_qty: l.billed_qty !== undefined ? Number(l.billed_qty) : undefined,
          rate,
          discount_pct: Number(l.discount_pct || 0),
          vat_rate: vatPct,
          vat_amount: vatAmt,
          line_total: lineTotal,
          batch_number: l.batch_number ? String(l.batch_number) : undefined,
        };
      });

      const netSum = rec.subtotal !== undefined ? Number(rec.subtotal) : viewerItems.reduce((s, i) => s + i.qty * i.rate, 0);
      const vatSum = rec.vat_amount !== undefined ? Number(rec.vat_amount) : viewerItems.reduce((s, i) => s + Number(i.vat_amount || 0), 0);
      const grandSum = rec.total_amount !== undefined ? Number(rec.total_amount) : netSum + vatSum;
      const docNumber = String(rec.so_number || rec.sq_number || rec.dn_number || rec.si_number || rec.sr_number || `#${viewingDoc.id}`);

      const createActions: ErpViewerAction[] = [];
      let onEditHandler: (() => void) | undefined;
      let onReviseHandler: (() => Promise<void>) | undefined;
      let onCancelHandler: (() => Promise<void>) | undefined;

      if (viewingDoc.type === 'quotations') {
        const st = String(rec.status || '');
        if (!['Converted', 'Cancelled'].includes(st)) {
          createActions.push({
            label: 'Convert to Sales Order',
            variant: 'primary',
            onClick: () => convertQuotationToOrder(rec),
          });
          onReviseHandler = async () => {
            setErr('');
            setMsg('');
            try {
              const rev = await apiRequest<{ id: number; sq_number: string }>(`/api/sales/quotations/${rec.id}/revise`, {
                method: 'POST',
              });
              await loadAll();
              setViewingDoc({ type: 'quotations', id: rev.id });
              setMsg(`Created revised quotation ${rev.sq_number}.`);
            } catch (e: unknown) {
              setErr(e instanceof Error ? e.message : 'Failed to revise quotation');
            }
          };
        }
      } else if (viewingDoc.type === 'orders') {
        const st = String(rec.status || '');
        if (st === 'Draft') {
          createActions.push({
            label: 'Submit & Reserve',
            variant: 'emerald',
            onClick: async () => {
              setErr('');
              try {
                await apiRequest(`/api/sales/orders/${rec.id}/submit`, { method: 'POST' });
                setMsg(`Sales Order ${docNumber} submitted and stock reserved.`);
                await loadAll();
              } catch (e: unknown) {
                setErr(e instanceof Error ? e.message : 'Submit failed');
              }
            },
          });
          onEditHandler = () => openEditSo(rec);
        }
        if (st !== 'Cancelled' && st !== 'Draft') {
          if (rec.delivered_status !== 'Delivered') {
            createActions.push({
              label: 'Make Delivery Note',
              variant: 'primary',
              onClick: () => openDeliveryModal(rec),
            });
          }
          if (rec.billed_status !== 'Billed') {
            createActions.push({
              label: 'Make Sales Invoice',
              variant: 'emerald',
              onClick: () => invoiceFromOrder(rec),
            });
          }
          createActions.push({
            label: 'Make Sales Return',
            variant: 'secondary',
            onClick: () => openMakeSalesReturnFromDoc(rec),
          });
        }
        if (st !== 'Cancelled') {
          onReviseHandler = async () => {
            setErr('');
            setMsg('');
            try {
              const rev = await apiRequest<{ id: number; so_number: string; amended_from: string; revision_no: string }>(
                `/api/sales/orders/${rec.id}/revise`,
                { method: 'POST' }
              );
              await loadAll();
              const soItems = (rec.items as Record<string, unknown>[]) || [];
              setEditingSo({
                id: rev.id,
                so_number: rev.so_number,
                status: 'Draft',
                amended_from: rev.amended_from,
              });
              setDocMeta({
                doc_date: todayStr,
                delivery_date: String(rec.delivery_date || todayStr),
                party_id: Number(rec.customer_id || ''),
                warehouse_id: Number(rec.warehouse_id || warehouses[0]?.id || ''),
                target_warehouse_id: '',
                payment_term_id: rec.payment_term_id ? Number(rec.payment_term_id) : '',
                price_list_id: rec.price_list_id ? Number(rec.price_list_id) : '',
                currency: String(rec.currency || company.currency || 'AED'),
                exchange_rate: String(rec.exchange_rate || 1),
                linked_po_id: '',
                linked_grn_id: '',
                linked_rfq_id: '',
                party_ref_no: String(rec.customer_ref || ''),
                supplier_inv_no: '',
                supplier_dn_no: '',
                delivery_terms: String(rec.delivery_terms || ''),
                delivery_place: String(rec.delivery_place || ''),
                revision_no: rev.revision_no,
                freight_amount: '0',
                tax_template: Number(rec.vat_amount || 0) > 0 ? 'UAE VAT 5%' : 'Zero Rated 0%',
                tax_category: 'Standard Rated',
                disable_rounded_total: true,
                additional_discount_pct: '0',
                reason: '',
                remarks: String(rec.remarks || ''),
              });
              setLines(
                soItems.map((i) => ({
                  item_id: Number(i.item_id),
                  qty: Number(i.qty || 1),
                  rate: Number(i.rate || 0),
                  discount_pct: Number(i.discount_pct || 0),
                  vat_rate: Number(i.vat_rate ?? 5),
                  required_by: String(rec.delivery_date || todayStr),
                }))
              );
              setViewingDoc(null);
              setShowOrderModal('order');
              setMsg(`Created revised draft ${rev.so_number} (amended from ${rev.amended_from}). Edit lines and Save.`);
            } catch (e: unknown) {
              setErr(e instanceof Error ? e.message : 'Failed to revise Sales Order');
            }
          };
          onCancelHandler = async () => {
            setErr('');
            try {
              await apiRequest(`/api/sales/orders/${rec.id}/cancel`, { method: 'POST' });
              setMsg(`Sales Order ${docNumber} cancelled and reservations released.`);
              await loadAll();
            } catch (e: unknown) {
              setErr(e instanceof Error ? e.message : 'Cancel failed');
            }
          };
        }
      } else if (viewingDoc.type === 'deliveries') {
        const linkedSo = orders.find((o) => Number(o.id) === Number(rec.so_id));
        if (linkedSo && linkedSo.billed_status !== 'Billed') {
          createActions.push({
            label: 'Make Sales Invoice',
            variant: 'emerald',
            onClick: () => invoiceFromOrder(linkedSo),
          });
        }
        createActions.push({
          label: 'Make Sales Return',
          variant: 'secondary',
          onClick: () => openMakeSalesReturnFromDoc(rec),
        });
      } else if (viewingDoc.type === 'invoices') {
        if (rec.status === 'Draft') {
          createActions.push({
            label: 'Post to GL',
            variant: 'emerald',
            onClick: async () => {
              await apiRequest(`/api/sales/invoices/${rec.id}/post`, { method: 'POST' });
              setMsg(`Invoice ${docNumber} posted to GL.`);
              await loadAll();
            },
          });
        }
        createActions.push({
          label: 'Make Sales Return / Credit Note',
          variant: 'secondary',
          onClick: () => openMakeSalesReturnFromDoc(rec),
        });
      }

      const handleNavigateLink = (link: { docType: string; id: number }) => {
        const navMap: Record<string, SalesTab> = {
          SalesQuotation: 'quotations',
          SalesOrder: 'orders',
          DeliveryNote: 'deliveries',
          SalesInvoice: 'invoices',
          SalesReturn: 'returns',
        };
        const targetTab = navMap[link.docType];
        if (targetTab) {
          setTab(targetTab);
          setViewingDoc({ type: targetTab, id: link.id });
        }
      };

      return (
        <div className="space-y-4">
          {msg && <div className="p-3 bg-emerald-50 border border-emerald-200 rounded text-xs text-emerald-800">{msg}</div>}
          {err && <div className="p-3 bg-red-50 border border-red-200 rounded text-xs text-red-700">{err}</div>}
          <ErpDocumentViewer
            docType={apiDocTypeMap[viewingDoc.type]}
            docId={Number(rec.id)}
            docNumber={docNumber}
            title={String(rec.customer_name || docNumber)}
            status={String(rec.status || '')}
            approvalStatus={rec.approval_status ? String(rec.approval_status) : undefined}
            docDate={String(rec.order_date || rec.quotation_date || rec.delivery_date || rec.invoice_date || rec.return_date || '')}
            deliveryDate={String(rec.delivery_date || rec.valid_until || rec.due_date || '')}
            companyRole="Seller"
            partyLabel="Customer"
            partyName={String(rec.customer_name || '')}
            partyTrn={String(rec.customer_trn || '')}
            partyAddress={String(rec.customer_address || '')}
            partyCountry={String(rec.customer_country || '')}
            partyContactPerson={String(rec.customer_contact_person || '')}
            partyTelephone={String(rec.customer_telephone || '')}
            warehouseName={String(rec.warehouse_name || '')}
            warehouseLabel="Set Source Warehouse"
            refLabel="Customer Ref. / Link"
            refNo={String(rec.customer_ref || rec.customer_invoice_ref || rec.so_number || '-')}
            amendedFrom={rec.amended_from ? String(rec.amended_from) : undefined}
            revisionNo={String(rec.revision_no || 'Original')}
            revisionDate={String(rec.revision_date || '')}
            currency={String(rec.currency || company.currency || 'AED')}
            exchangeRate={Number(rec.exchange_rate || 1)}
            paymentTerms={String(rec.payment_term_name || '')}
            deliveryTerms={String(rec.delivery_terms || (viewingDoc.type === 'deliveries' && rec.vehicle_number ? `Vehicle: ${String(rec.vehicle_number)}` : ''))}
            deliveryPlace={String(rec.delivery_place || rec.warehouse_name || rec.customer_address || '')}
            remarks={String(rec.remarks || rec.reason || rec.terms || '')}
            creatorName={String(rec.creator_name || '')}
            createdAt={String(rec.created_at || '')}
            approverName={String(rec.approver_name || '')}
            submittedAt={String(rec.submitted_at || rec.posted_at || '')}
            freightAmount={Number(rec.freight_amount || 0)}
            discountAmount={Number(rec.discount_amount || 0)}
            subtotal={netSum}
            vatAmount={vatSum}
            totalAmount={grandSum}
            items={viewerItems}
            showDeliveredCol={viewingDoc.type === 'orders'}
            showBilledCol={viewingDoc.type === 'orders'}
            showBatchCol={['deliveries', 'returns'].includes(viewingDoc.type)}
            createActions={createActions}
            onBack={() => setViewingDoc(null)}
            hasPrev={currentIndex > 0}
            hasNext={currentIndex >= 0 && currentIndex < activeList.length - 1}
            onPrev={() => {
              if (currentIndex > 0) setViewingDoc({ type: viewingDoc.type, id: Number(activeList[currentIndex - 1].id) });
            }}
            onNext={() => {
              if (currentIndex < activeList.length - 1) setViewingDoc({ type: viewingDoc.type, id: Number(activeList[currentIndex + 1].id) });
            }}
            onPrintPreview={() => printSalesStandardPdf(pdfTypeMap[viewingDoc.type], rec)}
            onEdit={onEditHandler}
            onRevise={onReviseHandler}
            onCancelDoc={onCancelHandler}
            onNavigateLink={handleNavigateLink}
          />
          {renderDeliveryModal()}
        </div>
      );
    }
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-slate-900">Sales & Distribution</h1>
          <p className="text-xs text-slate-500">Customer quotations, price-list lookups, stock reservations, QC-gated delivery notes, tax invoices & credit notes</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => setShowImportModal(true)}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded-md hover:bg-slate-50"
          >
            <FileSpreadsheet className="w-3.5 h-3.5 text-emerald-700" /> Import Excel
          </button>
          <button type="button" onClick={() => openSalesDocForm('quotation')} className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded-md hover:bg-slate-50">
            <Plus className="w-3.5 h-3.5" /> New Quotation
          </button>
          <button type="button" onClick={() => openSalesDocForm('return')} className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded-md hover:bg-slate-50">
            Sales Return
          </button>
          <button type="button" onClick={() => openSalesDocForm('order')} className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-white bg-slate-900 rounded-md hover:bg-slate-800">
            <Plus className="w-3.5 h-3.5" /> New Sales Order
          </button>
        </div>
      </div>

      <div className="flex flex-wrap gap-1 p-1 bg-slate-100 rounded-lg w-fit">
        {[
          { id: 'quotations', label: 'Quotations' },
          { id: 'orders', label: 'Sales Orders' },
          { id: 'deliveries', label: 'Delivery Notes' },
          { id: 'invoices', label: 'Sales Invoices' },
          { id: 'returns', label: 'Sales Returns' },
        ].map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setTab(t.id as SalesTab)}
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

      {tab === 'quotations' && (
        <DataTable
          title="Sales Quotations"
          columns={[
            { key: 'sq_number', header: 'Quotation #' },
            { key: 'customer_name', header: 'Customer' },
            { key: 'quotation_date', header: 'Date' },
            { key: 'valid_until', header: 'Valid Until' },
            { key: 'total_amount', header: 'Total', numeric: true, render: (r) => `${String(r.currency)} ${Number(r.total_amount || 0).toFixed(2)}` },
            { key: 'status', header: 'Status' },
            {
              key: 'actions',
              header: 'Actions',
              render: (r) => (
                <div className="flex items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
                  {r.status !== 'Converted' ? (
                    <button type="button" onClick={() => void convertQuotationToOrder(r)} className="px-2 py-1 text-xs font-medium bg-slate-900 text-white rounded hover:bg-slate-800">
                      Convert to Sales Order
                    </button>
                  ) : (
                    <span className="text-xs text-slate-500">Converted</span>
                  )}
                  <button type="button" onClick={() => printSalesStandardPdf('SQ', r)} className="p-1 text-slate-600 hover:text-slate-900" title="Download Quotation PDF">
                    <FileText className="w-3.5 h-3.5" />
                  </button>
                </div>
              ),
            },
          ]}
          data={quotations}
          loading={loading}
          onRowClick={(r) => setViewingDoc({ type: 'quotations', id: Number(r.id) })}
          exportFilename="sales_quotations"
        />
      )}

      {tab === 'orders' && (
        <DataTable
          title="Sales Orders"
          columns={orderCols}
          data={orders}
          loading={loading}
          onRowClick={(r) => setViewingDoc({ type: 'orders', id: Number(r.id) })}
          statusFilterKey="status"
          statusOptions={['Draft', 'Submitted', 'Partially Delivered', 'Delivered', 'Completed', 'Cancelled']}
          exportFilename="sales_orders"
        />
      )}

      {tab === 'deliveries' && (
        <DataTable
          title="Delivery Notes"
          columns={[
            { key: 'dn_number', header: 'DN #' },
            { key: 'so_number', header: 'Sales Order' },
            { key: 'customer_name', header: 'Customer' },
            { key: 'delivery_date', header: 'Delivery Date' },
            { key: 'warehouse_name', header: 'Warehouse' },
            { key: 'vehicle_number', header: 'Vehicle' },
            { key: 'driver_name', header: 'Driver' },
            { key: 'status', header: 'Status' },
            {
              key: 'actions',
              header: 'Actions',
              render: (r) => (
                <button type="button" onClick={(e) => { e.stopPropagation(); printSalesStandardPdf('DN', r); }} className="inline-flex items-center gap-1 px-2 py-1 text-xs border border-slate-300 rounded hover:bg-slate-50" title="Download Delivery Note PDF">
                  <FileText className="w-3 h-3" /> PDF
                </button>
              ),
            },
          ]}
          data={deliveries}
          loading={loading}
          onRowClick={(r) => setViewingDoc({ type: 'deliveries', id: Number(r.id) })}
          exportFilename="delivery_notes"
        />
      )}

      {tab === 'invoices' && (
        <DataTable
          title="Sales Tax Invoices (UAE 5% VAT)"
          columns={[
            { key: 'si_number', header: 'Invoice #' },
            { key: 'customer_name', header: 'Customer' },
            { key: 'invoice_date', header: 'Date' },
            { key: 'due_date', header: 'Due Date' },
            { key: 'vat_amount', header: 'VAT (5%)', numeric: true, render: (r) => Number(r.vat_amount || 0).toFixed(2) },
            { key: 'total_amount', header: 'Total', numeric: true, render: (r) => `${String(r.currency)} ${Number(r.total_amount || 0).toFixed(2)}` },
            { key: 'outstanding_amount', header: 'Outstanding', numeric: true, render: (r) => Number(r.outstanding_amount || 0).toFixed(2) },
            { key: 'status', header: 'Status' },
            {
              key: 'actions',
              header: 'Actions',
              render: (r) => (
                <div className="flex items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
                  {r.status === 'Draft' && (
                    <button
                      type="button"
                      onClick={async () => {
                        await apiRequest(`/api/sales/invoices/${r.id}/post`, { method: 'POST' });
                        setMsg(`Invoice ${String(r.si_number)} posted to GL.`);
                        await loadAll();
                      }}
                      className="px-2 py-1 text-xs font-medium bg-emerald-700 text-white rounded"
                    >
                      Post GL
                    </button>
                  )}
                  <button type="button" onClick={() => printSalesStandardPdf('SI', r)} className="inline-flex items-center gap-1 px-2 py-1 text-xs border border-slate-300 rounded hover:bg-slate-50">
                    <FileText className="w-3 h-3" /> Tax Invoice PDF
                  </button>
                </div>
              ),
            },
          ]}
          data={invoices}
          loading={loading}
          onRowClick={(r) => setViewingDoc({ type: 'invoices', id: Number(r.id) })}
          statusFilterKey="status"
          statusOptions={['Draft', 'Posted']}
          exportFilename="sales_invoices"
        />
      )}

      {tab === 'returns' && (
        <DataTable
          title="Sales Returns & Credit Notes"
          columns={[
            { key: 'sr_number', header: 'Return #' },
            { key: 'customer_name', header: 'Customer' },
            { key: 'warehouse_name', header: 'Warehouse' },
            { key: 'return_date', header: 'Date' },
            { key: 'reason', header: 'Reason' },
            { key: 'total_amount', header: 'Credit Amount', numeric: true, render: (r) => Number(r.total_amount || 0).toFixed(2) },
            { key: 'status', header: 'Status' },
            {
              key: 'actions',
              header: 'Actions',
              render: (r) => (
                <button type="button" onClick={(e) => { e.stopPropagation(); printSalesStandardPdf('SR', r); }} className="inline-flex items-center gap-1 px-2 py-1 text-xs border border-slate-300 rounded hover:bg-slate-50">
                  <FileText className="w-3 h-3" /> PDF
                </button>
              ),
            },
          ]}
          data={returns}
          loading={loading}
          onRowClick={(r) => setViewingDoc({ type: 'returns', id: Number(r.id) })}
          exportFilename="sales_returns"
        />
      )}

      {renderDeliveryModal()}

      <ExcelImportModal
        open={showImportModal}
        initialType="customers"
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
