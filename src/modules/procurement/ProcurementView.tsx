import React, { useEffect, useState } from 'react';
import { Plus, FileText, CheckCircle2, AlertTriangle, Paperclip, FileSpreadsheet } from 'lucide-react';
import { apiRequest } from '../../services/api';
import { DataTable, type ColumnDef } from '../../components/DataTable';
import { DocumentPanel } from '../../components/DocumentPanel';
import { ErpDocumentForm, type ErpDocMetaState, type ErpFormItemMaster, type ErpFormLine, type ErpFormParty } from '../../components/ErpDocumentForm';
import { ErpDocumentViewer, type ErpViewerAction, type ErpViewerItemLine } from '../../components/ErpDocumentViewer';
import { ExcelImportModal } from '../../components/ExcelImportModal';
import { exportStandardErpPdf } from '../../utils/export';
import { useCompany } from '../../context/CompanyContext';

type ProcTab = 'mr' | 'pr' | 'rfq' | 'sq' | 'po' | 'grn' | 'pi' | 'prn' | 'subcontract';

export function ProcurementView() {
  const { company, logoUrl } = useCompany();
  const [tab, setTab] = useState<ProcTab>('po');
  const [mrs, setMrs] = useState<Record<string, unknown>[]>([]);
  const [prs, setPrs] = useState<Record<string, unknown>[]>([]);
  const [rfqs, setRfqs] = useState<Record<string, unknown>[]>([]);
  const [sqs, setSqs] = useState<Record<string, unknown>[]>([]);
  const [pos, setPos] = useState<Record<string, unknown>[]>([]);
  const [grns, setGrns] = useState<Record<string, unknown>[]>([]);
  const [pis, setPis] = useState<Record<string, unknown>[]>([]);
  const [prns, setPrns] = useState<Record<string, unknown>[]>([]);
  const [subOrders, setSubOrders] = useState<Record<string, unknown>[]>([]);
  const [subcontractors, setSubcontractors] = useState<Record<string, unknown>[]>([]);

  const [items, setItems] = useState<ErpFormItemMaster[]>([]);
  const [suppliers, setSuppliers] = useState<ErpFormParty[]>([]);
  const [warehouses, setWarehouses] = useState<{ id: number; code: string; name: string }[]>([]);
  const [tanks, setTanks] = useState<{ id: number; tank_code: string; name: string; warehouse_id: number; assigned_item_id: number | null; current_qty: number; capacity_qty: number; uom: string; is_active: number }[]>([]);
  const [paymentTerms, setPaymentTerms] = useState<{ id: number; name: string }[]>([]);

  const [comparison, setComparison] = useState<{ rfqNumber: string; quotations: Record<string, unknown>[] } | null>(null);
  const [docDrawer, setDocDrawer] = useState<{ docType: string; docId: number; docNumber: string } | null>(null);
  const [showImportModal, setShowImportModal] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');

  // Full-page ERP Document Entry & Viewer mode
  const [modal, setModal] = useState<null | 'mr' | 'pr' | 'rfq' | 'sq' | 'po' | 'grn' | 'pi' | 'prn' | 'sub'>(null);
  const [viewingDoc, setViewingDoc] = useState<{ type: ProcTab; id: number } | null>(null);
  const [editingPo, setEditingPo] = useState<{ id: number; po_number: string; status: string; amended_from?: string } | null>(null);

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
    reason: '',
    remarks: '',
  });
  const [targetWhId, setTargetWhId] = useState<number | ''>('');
  const [serviceRate, setServiceRate] = useState('1.5');
  const [plannedQty, setPlannedQty] = useState('500');
  const [lineItems, setLineItems] = useState<ErpFormLine[]>([
    { item_id: '', qty: 100, rate: 0, discount_pct: 0, vat_rate: 5, batch_number: '', tank_id: '' },
  ]);
  const [rfqSupplierIds, setRfqSupplierIds] = useState<number[]>([]);

  const loadAll = async () => {
    try {
      const [mrR, prR, rfqR, sqR, poR, grnR, piR, prnR, subR, itR, supR, whR, ptR, tankR] = await Promise.all([
        apiRequest<{ items: Record<string, unknown>[] }>('/api/procurement/material-requests'),
        apiRequest<{ items: Record<string, unknown>[] }>('/api/procurement/purchase-requisitions'),
        apiRequest<{ items: Record<string, unknown>[] }>('/api/procurement/rfqs'),
        apiRequest<{ items: Record<string, unknown>[] }>('/api/procurement/supplier-quotations'),
        apiRequest<{ items: Record<string, unknown>[] }>('/api/procurement/purchase-orders'),
        apiRequest<{ items: Record<string, unknown>[] }>('/api/procurement/purchase-receipts'),
        apiRequest<{ items: Record<string, unknown>[] }>('/api/procurement/purchase-invoices'),
        apiRequest<{ items: Record<string, unknown>[] }>('/api/procurement/purchase-returns'),
        apiRequest<{ subcontractors: Record<string, unknown>[]; orders: Record<string, unknown>[] }>('/api/procurement/subcontracting'),
        apiRequest<{ items: typeof items }>('/api/masters/items'),
        apiRequest<{ items: typeof suppliers }>('/api/masters/suppliers'),
        apiRequest<{ items: typeof warehouses }>('/api/masters/warehouses'),
        apiRequest<{ items: typeof paymentTerms }>('/api/masters/payment-terms'),
        apiRequest<{ items: typeof tanks }>('/api/masters/tanks'),
      ]);
      setMrs(mrR.items); setPrs(prR.items); setRfqs(rfqR.items); setSqs(sqR.items);
      setPos(poR.items); setGrns(grnR.items); setPis(piR.items); setPrns(prnR.items);
      setSubcontractors(subR.subcontractors); setSubOrders(subR.orders);
      setItems(itR.items); setSuppliers(supR.items); setWarehouses(whR.items); setPaymentTerms(ptR.items);
      setTanks(tankR.items);
      if (!docMeta.warehouse_id && whR.items[0]) {
        setDocMeta((m) => ({ ...m, warehouse_id: whR.items[0].id }));
      }
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : 'Failed to load procurement data');
    }
  };

  useEffect(() => {
    void loadAll();
  }, []);

  const findMatchingTankId = (itemId: number | '', warehouseId: number | ''): number | '' => {
    if (!itemId || !warehouseId) return '';
    const match = tanks.find((t) => t.is_active && t.warehouse_id === Number(warehouseId) && t.assigned_item_id === Number(itemId));
    return match ? match.id : '';
  };

  const resetForm = () => {
    const defaultWh = docMeta.warehouse_id || warehouses[0]?.id || '';
    setEditingPo(null);
    setLineItems([
      {
        item_id: '',
        qty: 1,
        rate: 0,
        discount_pct: 0,
        vat_rate: 5,
        batch_number: '',
        tank_id: '',
        required_by: todayStr,
      },
    ]);
    setDocMeta({
      doc_date: todayStr,
      delivery_date: todayStr,
      party_id: '',
      warehouse_id: defaultWh,
      target_warehouse_id: warehouses[0]?.id || '',
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
      reason: '',
      remarks: '',
    });
    setRfqSupplierIds([]);
  };

  const handleAction = async (fn: () => Promise<void>) => {
    setErr('');
    setMsg('');
    try {
      await fn();
      await loadAll();
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : 'Operation failed');
    }
  };

  const submitModal = async (e: React.FormEvent) => {
    e.preventDefault();
    const addDisc = Number(docMeta.additional_discount_pct || 0);
    const validLines = lineItems
      .filter((l) => l.item_id !== '' && Number(l.qty) > 0)
      .map((l) => {
        const lineDisc = Number(l.discount_pct || 0);
        const effDisc = addDisc > 0 ? Math.min(100, lineDisc + addDisc - (lineDisc * addDisc) / 100) : lineDisc;
        return {
          ...l,
          item_id: Number(l.item_id),
          qty: Number(l.qty),
          rate: Number(l.rate || 0),
          discount_pct: effDisc,
          vat_rate: docMeta.tax_template === 'UAE VAT 5%' ? Number(l.vat_rate ?? 5) : 0,
        };
      });
    if (validLines.length === 0) {
      setErr('At least one valid item line is required.');
      return;
    }

    setSubmitting(true);
    try {
      await handleAction(async () => {
        if (modal === 'mr') {
          await apiRequest('/api/procurement/material-requests', {
            method: 'POST',
            body: JSON.stringify({
              warehouse_id: Number(docMeta.warehouse_id),
              request_date: docMeta.doc_date,
              required_date: docMeta.delivery_date,
              remarks: docMeta.remarks,
              items: validLines,
            }),
          });
          setMsg('Material Request created and submitted.');
        } else if (modal === 'pr') {
          await apiRequest('/api/procurement/purchase-requisitions', {
            method: 'POST',
            body: JSON.stringify({
              warehouse_id: Number(docMeta.warehouse_id),
              request_date: docMeta.doc_date,
              required_date: docMeta.delivery_date,
              remarks: docMeta.remarks,
              items: validLines.map((l) => ({ ...l, estimated_rate: l.rate })),
            }),
          });
          setMsg('Purchase Requisition created.');
        } else if (modal === 'rfq') {
          await apiRequest('/api/procurement/rfqs', {
            method: 'POST',
            body: JSON.stringify({
              rfq_date: docMeta.doc_date,
              valid_until: docMeta.delivery_date,
              supplier_ids: rfqSupplierIds,
              remarks: docMeta.remarks,
              items: validLines,
            }),
          });
          setMsg('RFQ sent to selected suppliers.');
        } else if (modal === 'sq') {
          await apiRequest('/api/procurement/supplier-quotations', {
            method: 'POST',
            body: JSON.stringify({
              rfq_id: docMeta.linked_rfq_id ? Number(docMeta.linked_rfq_id) : undefined,
              supplier_id: Number(docMeta.party_id),
              quotation_date: docMeta.doc_date,
              valid_until: docMeta.delivery_date,
              payment_term_id: docMeta.payment_term_id ? Number(docMeta.payment_term_id) : undefined,
              currency: docMeta.currency,
              exchange_rate: Number(docMeta.exchange_rate || 1),
              freight_amount: Number(docMeta.freight_amount || 0),
              remarks: docMeta.remarks,
              items: validLines.map((l) => ({ item_id: l.item_id, qty: l.qty, unit_price: l.rate, vat_rate: l.vat_rate })),
            }),
          });
          setMsg('Supplier Quotation recorded.');
        } else if (modal === 'po') {
          if (!docMeta.party_id) {
            throw new Error('Please select a Supplier.');
          }
          const poPayload = {
            supplier_id: Number(docMeta.party_id),
            warehouse_id: Number(docMeta.warehouse_id),
            po_date: docMeta.doc_date,
            delivery_date: docMeta.delivery_date,
            payment_term_id: docMeta.payment_term_id ? Number(docMeta.payment_term_id) : undefined,
            currency: docMeta.currency,
            exchange_rate: Number(docMeta.exchange_rate || 1),
            freight_amount: Number(docMeta.freight_amount || 0),
            supplier_ref: docMeta.party_ref_no,
            delivery_terms: docMeta.delivery_terms,
            delivery_place: docMeta.delivery_place,
            revision_no: docMeta.revision_no || 'Original',
            remarks: docMeta.remarks,
            items: validLines,
          };
          if (editingPo) {
            await apiRequest(`/api/procurement/purchase-orders/${editingPo.id}`, {
              method: 'PUT',
              body: JSON.stringify(poPayload),
            });
            setMsg(`Purchase Order ${editingPo.po_number} updated.`);
            setViewingDoc({ type: 'po', id: editingPo.id });
            setEditingPo(null);
          } else {
            const created = await apiRequest<{ id: number; po_number: string }>('/api/procurement/purchase-orders', {
              method: 'POST',
              body: JSON.stringify(poPayload),
            });
            setMsg(`Purchase Order ${created.po_number} saved as Draft. Submit to trigger approval workflow.`);
            setViewingDoc({ type: 'po', id: created.id });
          }
        } else if (modal === 'grn') {
          await apiRequest('/api/procurement/purchase-receipts', {
            method: 'POST',
            body: JSON.stringify({
              po_id: docMeta.linked_po_id ? Number(docMeta.linked_po_id) : undefined,
              supplier_id: Number(docMeta.party_id),
              warehouse_id: Number(docMeta.warehouse_id),
              receipt_date: docMeta.doc_date,
              supplier_dn_number: docMeta.supplier_dn_no,
              remarks: docMeta.remarks,
              submit_now: true,
              items: validLines.map((l) => ({
                item_id: l.item_id,
                tank_id: l.tank_id ? Number(l.tank_id) : null,
                received_qty: l.qty,
                accepted_qty: l.qty,
                rate: l.rate,
                batch_number: l.batch_number,
                qc_required: true,
              })),
            }),
          });
          setMsg('GRN submitted: Stock updated & Quality Inspection triggered.');
        } else if (modal === 'pi') {
          const res = await apiRequest<{ pi_number: string; matching_status: string; matching_notes: string[] }>('/api/procurement/purchase-invoices', {
            method: 'POST',
            body: JSON.stringify({
              supplier_id: Number(docMeta.party_id),
              supplier_invoice_number: docMeta.supplier_inv_no,
              invoice_date: docMeta.doc_date,
              po_id: docMeta.linked_po_id ? Number(docMeta.linked_po_id) : undefined,
              grn_id: docMeta.linked_grn_id ? Number(docMeta.linked_grn_id) : undefined,
              is_direct: !docMeta.linked_po_id && !docMeta.linked_grn_id,
              payment_term_id: docMeta.payment_term_id ? Number(docMeta.payment_term_id) : undefined,
              currency: docMeta.currency,
              exchange_rate: Number(docMeta.exchange_rate || 1),
              freight_amount: Number(docMeta.freight_amount || 0),
              remarks: docMeta.remarks,
              items: validLines,
            }),
          });
          setMsg(`Invoice ${res.pi_number} created — 3-Way Match Status: ${res.matching_status}${res.matching_notes.length ? ` (${res.matching_notes[0]})` : ''}`);
        } else if (modal === 'prn') {
          await apiRequest('/api/procurement/purchase-returns', {
            method: 'POST',
            body: JSON.stringify({
              supplier_id: Number(docMeta.party_id),
              warehouse_id: Number(docMeta.warehouse_id),
              return_date: docMeta.doc_date,
              reason: docMeta.reason || docMeta.remarks || 'Supplier return',
              items: validLines,
            }),
          });
          setMsg('Purchase Return submitted with inventory & accounting reversal.');
        } else if (modal === 'sub') {
          await apiRequest('/api/procurement/subcontracting-orders', {
            method: 'POST',
            body: JSON.stringify({
              subcontractor_id: Number(docMeta.party_id),
              finished_item_id: Number(validLines[0]?.item_id),
              planned_qty: Number(plannedQty),
              service_rate: Number(serviceRate),
              freight_charge: Number(docMeta.freight_amount || 0),
              source_warehouse_id: Number(docMeta.warehouse_id),
              target_warehouse_id: Number(targetWhId || docMeta.warehouse_id),
              materials: validLines.slice(1).map((l) => ({ item_id: l.item_id, issued_qty: l.qty, batch_number: l.batch_number })),
            }),
          });
          setMsg('Subcontracting Order created and raw materials transferred.');
        }
        setModal(null);
      });
    } finally {
      setSubmitting(false);
    }
  };

  const prefillFromPo = (poIdVal: number) => {
    const po = pos.find((p) => Number(p.id) === poIdVal) as
      | {
          supplier_id: number;
          warehouse_id: number;
          payment_term_id: number | null;
          currency?: string;
          exchange_rate?: number;
          delivery_terms?: string;
          delivery_place?: string;
          supplier_ref?: string;
          freight_amount?: number;
          items: { id: number; item_id: number; qty: number; received_qty: number; rate: number; discount_pct?: number; vat_rate?: number }[];
        }
      | undefined;
    if (po) {
      setDocMeta((m) => ({
        ...m,
        linked_po_id: poIdVal,
        party_id: po.supplier_id,
        warehouse_id: po.warehouse_id,
        payment_term_id: po.payment_term_id || m.payment_term_id,
        currency: po.currency || m.currency,
        exchange_rate: String(po.exchange_rate || 1),
        delivery_terms: po.delivery_terms || m.delivery_terms,
        delivery_place: po.delivery_place || m.delivery_place,
        party_ref_no: po.supplier_ref || m.party_ref_no,
        freight_amount: String(po.freight_amount || 0),
      }));
      setLineItems(
        po.items.map((i) => ({
          item_id: i.item_id,
          qty: Math.max(0, i.qty - i.received_qty) || i.qty,
          rate: i.rate,
          discount_pct: Number(i.discount_pct || 0),
          vat_rate: Number(i.vat_rate ?? 5),
          batch_number: '',
          tank_id: findMatchingTankId(i.item_id, po.warehouse_id),
          required_by: docMeta.delivery_date,
        }))
      );
    }
  };

  const openEditPo = (po: Record<string, unknown>) => {
    const poItems = (po.items as Record<string, unknown>[]) || [];
    setEditingPo({
      id: Number(po.id),
      po_number: String(po.po_number || ''),
      status: String(po.status || 'Draft'),
      amended_from: po.amended_from ? String(po.amended_from) : undefined,
    });
    setDocMeta({
      doc_date: String(po.po_date || todayStr),
      delivery_date: String(po.delivery_date || todayStr),
      party_id: Number(po.supplier_id || ''),
      warehouse_id: Number(po.warehouse_id || warehouses[0]?.id || ''),
      target_warehouse_id: Number(po.warehouse_id || warehouses[0]?.id || ''),
      payment_term_id: po.payment_term_id ? Number(po.payment_term_id) : '',
      price_list_id: '',
      currency: String(po.currency || company.currency || 'AED'),
      exchange_rate: String(po.exchange_rate || 1),
      linked_po_id: '',
      linked_grn_id: '',
      linked_rfq_id: '',
      party_ref_no: String(po.supplier_ref || ''),
      supplier_inv_no: '',
      supplier_dn_no: '',
      delivery_terms: String(po.delivery_terms || ''),
      delivery_place: String(po.delivery_place || ''),
      revision_no: String(po.revision_no || 'Original'),
      freight_amount: String(po.freight_amount || 0),
      tax_template: Number(po.vat_amount || 0) > 0 ? 'UAE VAT 5%' : 'Zero Rated 0%',
      tax_category: 'Standard Rated',
      disable_rounded_total: true,
      additional_discount_pct: '0',
      reason: '',
      remarks: String(po.remarks || ''),
    });
    setLineItems(
      poItems.length > 0
        ? poItems.map((i) => ({
            item_id: Number(i.item_id),
            qty: Number(i.qty || 1),
            rate: Number(i.rate || 0),
            discount_pct: Number(i.discount_pct || 0),
            vat_rate: Number(i.vat_rate ?? 5),
            batch_number: '',
            tank_id: findMatchingTankId(Number(i.item_id), Number(po.warehouse_id || '')),
            required_by: String(po.delivery_date || todayStr),
          }))
        : [{ item_id: '', qty: 1, rate: 0, discount_pct: 0, vat_rate: 5, batch_number: '', tank_id: '', required_by: todayStr }]
    );
    setViewingDoc(null);
    setModal('po');
  };

  const openMakeGrnFromPo = (po: Record<string, unknown>) => {
    resetForm();
    prefillFromPo(Number(po.id));
    setViewingDoc(null);
    setModal('grn');
  };

  const openMakePiFromPo = (po: Record<string, unknown>, grn?: Record<string, unknown>) => {
    resetForm();
    const poItems = (po.items as Record<string, unknown>[]) || [];
    const matchingGrn =
      grn || grns.find((g) => Number(g.po_id) === Number(po.id) && String(g.status) === 'Submitted');
    const grnItems = (matchingGrn?.items as Record<string, unknown>[]) || [];
    setDocMeta((m) => ({
      ...m,
      linked_po_id: Number(po.id),
      linked_grn_id: matchingGrn ? Number(matchingGrn.id) : '',
      party_id: Number(po.supplier_id || ''),
      warehouse_id: Number(po.warehouse_id || warehouses[0]?.id || ''),
      payment_term_id: po.payment_term_id ? Number(po.payment_term_id) : '',
      currency: String(po.currency || company.currency || 'AED'),
      exchange_rate: String(po.exchange_rate || 1),
      freight_amount: String(po.freight_amount || 0),
      party_ref_no: String(po.supplier_ref || ''),
      remarks: `Invoice against ${String(po.po_number || '')}${matchingGrn ? ` / ${String(matchingGrn.grn_number)}` : ''}`,
    }));
    if (grnItems.length > 0) {
      setLineItems(
        grnItems.map((gi) => {
          const poLine = poItems.find((pi) => Number(pi.item_id) === Number(gi.item_id));
          return {
            item_id: Number(gi.item_id),
            qty: Number(gi.accepted_qty ?? gi.received_qty ?? 0),
            rate: Number(poLine?.rate ?? gi.rate ?? 0),
            discount_pct: Number(poLine?.discount_pct || 0),
            vat_rate: Number(poLine?.vat_rate ?? 5),
            batch_number: String(gi.batch_number || ''),
            tank_id: gi.tank_id ? Number(gi.tank_id) : '',
            required_by: todayStr,
          };
        })
      );
    } else {
      setLineItems(
        poItems.map((pi) => ({
          item_id: Number(pi.item_id),
          qty: Number(pi.qty || 0),
          rate: Number(pi.rate || 0),
          discount_pct: Number(pi.discount_pct || 0),
          vat_rate: Number(pi.vat_rate ?? 5),
          batch_number: '',
          tank_id: '',
          required_by: todayStr,
        }))
      );
    }
    setViewingDoc(null);
    setModal('pi');
  };

  const openMakeReturnFromDoc = (doc: Record<string, unknown>, sourceType: 'po' | 'grn' | 'pi') => {
    resetForm();
    const docItems = (doc.items as Record<string, unknown>[]) || [];
    setDocMeta((m) => ({
      ...m,
      party_id: Number(doc.supplier_id || ''),
      warehouse_id: Number(doc.warehouse_id || warehouses[0]?.id || ''),
      currency: String(doc.currency || company.currency || 'AED'),
      reason: `Return against ${String(doc.po_number || doc.grn_number || doc.pi_number || '')}`,
    }));
    setLineItems(
      docItems.length > 0
        ? docItems.map((i) => ({
            item_id: Number(i.item_id),
            qty: Number(i.accepted_qty ?? i.received_qty ?? i.qty ?? 1),
            rate: Number(i.rate ?? 0),
            discount_pct: 0,
            vat_rate: Number(i.vat_rate ?? 5),
            batch_number: String(i.batch_number || ''),
            tank_id: '',
            required_by: todayStr,
          }))
        : [{ item_id: '', qty: 1, rate: 0, discount_pct: 0, vat_rate: 5, batch_number: '', tank_id: '', required_by: todayStr }]
    );
    setViewingDoc(null);
    setModal('prn');
    void sourceType;
  };

  const printProcurementPdf = (docType: 'MR' | 'PR' | 'RFQ' | 'SQ' | 'PO' | 'GRN' | 'PI' | 'PRN' | 'SUB', r: Record<string, unknown>) => {
    const rawLines = (docType === 'SUB' ? (r.materials as Record<string, unknown>[]) : (r.items as Record<string, unknown>[])) || [];
    const mappedItems = rawLines.map((l) => {
      const qty = Number(l.accepted_qty ?? l.received_qty ?? l.issued_qty ?? l.qty ?? 0);
      const unitPrice = Number(l.rate ?? l.unit_price ?? l.estimated_rate ?? l.unit_cost ?? 0);
      const vatPct = Number(l.vat_rate ?? (docType === 'PO' || docType === 'SQ' || docType === 'PI' ? 5 : 0));
      const vatAmt = Number(l.vat_amount ?? 0);
      const total = Number(l.line_total ?? qty * unitPrice + vatAmt);
      return {
        item_code: String(l.item_code || ''),
        description: `${String(l.description || l.item_name || '')}${l.tank_code ? ` [Tank: ${String(l.tank_code)}]` : ''}`,
        qty,
        uom: String(l.uom || ''),
        unit_price: unitPrice,
        vat_pct: vatPct,
        vat_amount: vatAmt,
        total,
      };
    });

    const netSum = r.subtotal !== undefined ? Number(r.subtotal) : mappedItems.reduce((s, i) => s + i.qty * i.unit_price, 0);
    const vatSum = r.vat_amount !== undefined ? Number(r.vat_amount) : mappedItems.reduce((s, i) => s + i.vat_amount, 0);
    const grandSum =
      docType === 'SUB'
        ? netSum + Number(r.total_service_cost || 0)
        : r.total_amount !== undefined
        ? Number(r.total_amount)
        : netSum + vatSum;

    const cfgMap: Record<typeof docType, { title: string; label: string; number: string; date: string; delDate: string }> = {
      MR: { title: 'MATERIAL REQUEST', label: 'MR No.', number: String(r.mr_number || ''), date: String(r.request_date || ''), delDate: String(r.required_date || '') },
      PR: { title: 'PURCHASE REQUISITION', label: 'PR No.', number: String(r.pr_number || ''), date: String(r.request_date || ''), delDate: String(r.required_date || '') },
      RFQ: { title: 'REQUEST FOR QUOTATION', label: 'RFQ No.', number: String(r.rfq_number || ''), date: String(r.rfq_date || ''), delDate: String(r.valid_until || '') },
      SQ: { title: 'SUPPLIER QUOTATION', label: 'Quote No.', number: String(r.sq_number || ''), date: String(r.quotation_date || ''), delDate: String(r.valid_until || '') },
      PO: { title: 'PURCHASE ORDER', label: 'PO No.', number: String(r.po_number || ''), date: String(r.po_date || ''), delDate: String(r.delivery_date || '') },
      GRN: { title: 'GOODS RECEIPT NOTE', label: 'GRN No.', number: String(r.grn_number || ''), date: String(r.receipt_date || ''), delDate: '' },
      PI: { title: 'PURCHASE INVOICE', label: 'PI No.', number: String(r.pi_number || ''), date: String(r.invoice_date || ''), delDate: String(r.due_date || '') },
      PRN: { title: 'PURCHASE RETURN / DEBIT NOTE', label: 'Return No.', number: String(r.prn_number || ''), date: String(r.return_date || ''), delDate: '' },
      SUB: { title: 'SUBCONTRACTING ORDER', label: 'Subcontract No.', number: String(r.sub_number || ''), date: String(r.order_date || ''), delDate: String(r.expected_date || '') },
    };
    const cfg = cfgMap[docType];

    void exportStandardErpPdf({
      docTitle: cfg.title,
      docNumberLabel: cfg.label,
      docNumber: cfg.number,
      docDate: cfg.date,
      company,
      logoUrl,
      companyRole: 'Buyer',
      partyRole: 'Seller',
      partyName: String(r.supplier_name || r.subcontractor_name || r.department || company.name || ''),
      partyTrn: String(r.supplier_trn || ''),
      partyAddress: String(r.supplier_address || r.subcontractor_address || ''),
      partyCountry: String(r.supplier_country || ''),
      partyContactPerson: String(r.supplier_contact_person || r.subcontractor_contact_person || r.requested_by || ''),
      paymentTerms: String(r.payment_term_name || ''),
      deliveryTerms: String(r.delivery_terms || ''),
      deliveryDate: cfg.delDate,
      deliveryPlace: String(r.delivery_place || r.warehouse_location || r.warehouse_name || ''),
      partyRefLabel: 'Suppliers Ref. No.',
      partyRefNo: String(r.supplier_ref || r.supplier_invoice_number || r.supplier_dn_number || r.po_number || r.mr_number || '-'),
      exchangeRate: Number(r.exchange_rate || 1),
      revisionNo: String(r.revision_no || 'Original'),
      revisionDate: String(r.revision_date || ''),
      currency: String(r.currency || company.currency || 'AED'),
      items: mappedItems,
      netTotal: netSum,
      vatTotal: vatSum,
      grandTotal: grandSum,
      remarks: String(r.remarks || r.reason || ''),
      preparedBy: String(r.creator_name || r.requested_by || ''),
      authorizedBy: String(r.approver_name || ''),
      creatorName: String(r.creator_name || r.requested_by || ''),
    });
  };

  const tabs: { id: ProcTab; label: string }[] = [
    { id: 'mr', label: 'Material Requests' },
    { id: 'pr', label: 'Requisitions' },
    { id: 'rfq', label: 'RFQs & Compare' },
    { id: 'sq', label: 'Supplier Quotes' },
    { id: 'po', label: 'Purchase Orders' },
    { id: 'grn', label: 'GRN / Receipts' },
    { id: 'pi', label: 'Purchase Invoices' },
    { id: 'prn', label: 'Returns' },
    { id: 'subcontract', label: 'Subcontracting' },
  ];

  const poCols: ColumnDef<Record<string, unknown>>[] = [
    { key: 'po_number', header: 'PO #', render: (r) => <span className="font-mono font-medium text-slate-900">{String(r.po_number)}</span> },
    { key: 'po_date', header: 'Date' },
    { key: 'supplier_name', header: 'Supplier' },
    { key: 'currency', header: 'Curr' },
    { key: 'total_amount', header: 'Total', numeric: true, render: (r) => Number(r.total_amount || 0).toFixed(2) },
    { key: 'status', header: 'Status' },
    { key: 'approval_status', header: 'Approval' },
    {
      key: 'actions',
      header: 'Actions',
      render: (r) => (
        <div className="flex items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
          {r.status === 'Draft' && (
            <button
              type="button"
              onClick={() =>
                handleAction(async () => {
                  const res = await apiRequest<{ status: string; requiredRole?: string }>(`/api/procurement/purchase-orders/${r.id}/submit`, { method: 'POST' });
                  setMsg(res.status === 'Pending Approval' ? `Sent to ${res.requiredRole} for approval` : `PO ${r.po_number} submitted.`);
                })
              }
              className="px-2 py-1 text-[11px] font-medium bg-slate-900 text-white rounded hover:bg-slate-800"
            >
              Submit
            </button>
          )}
          <button
            type="button"
            onClick={() => printProcurementPdf('PO', r)}
            className="p-1 text-slate-600 hover:text-slate-900"
            title="Download Standard PO PDF"
          >
            <FileText className="w-3.5 h-3.5" />
          </button>
          <button
            type="button"
            onClick={() => setDocDrawer({ docType: 'PurchaseOrder', docId: Number(r.id), docNumber: String(r.po_number) })}
            className="p-1 text-slate-600 hover:text-slate-900"
            title="Links & Attachments"
          >
            <Paperclip className="w-3.5 h-3.5" />
          </button>
        </div>
      ),
    },
  ];

  const piCols: ColumnDef<Record<string, unknown>>[] = [
    { key: 'pi_number', header: 'PI #', render: (r) => <span className="font-mono font-medium text-slate-900">{String(r.pi_number)}</span> },
    { key: 'supplier_invoice_number', header: 'Supplier Inv #' },
    { key: 'supplier_name', header: 'Supplier' },
    { key: 'total_amount', header: 'Total', numeric: true, render: (r) => Number(r.total_amount || 0).toFixed(2) },
    { key: 'outstanding_amount', header: 'Outstanding', numeric: true, render: (r) => Number(r.outstanding_amount || 0).toFixed(2) },
    {
      key: 'matching_status',
      header: '3-Way Match',
      render: (r) => (
        <span className={`inline-flex items-center gap-1 text-xs font-medium ${r.matching_status === 'Mismatch' ? 'text-red-600' : 'text-emerald-700'}`}>
          {r.matching_status === 'Mismatch' ? <AlertTriangle className="w-3.5 h-3.5" /> : <CheckCircle2 className="w-3.5 h-3.5" />}
          {String(r.matching_status)}
        </span>
      ),
    },
    { key: 'status', header: 'Status' },
    {
      key: 'actions',
      header: 'Actions',
      render: (r) => (
        <div className="flex items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
          {r.status === 'Draft' && r.matching_status === 'Mismatch' && r.approval_status !== 'Approved' && (
            <button
              type="button"
              onClick={() =>
                handleAction(async () => {
                  await apiRequest(`/api/procurement/purchase-invoices/${r.id}/approve-mismatch`, { method: 'POST' });
                  setMsg(`3-Way Match variance approved for ${r.pi_number}`);
                })
              }
              className="px-2 py-1 text-[11px] font-medium bg-amber-600 text-white rounded hover:bg-amber-700"
            >
              Approve Variance
            </button>
          )}
          {r.status === 'Draft' && (
            <button
              type="button"
              onClick={() =>
                handleAction(async () => {
                  const res = await apiRequest<{ je_number: string }>(`/api/procurement/purchase-invoices/${r.id}/post`, { method: 'POST' });
                  setMsg(`Posted ${r.pi_number} to GL (${res.je_number}) with payment schedules.`);
                })
              }
              className="px-2 py-1 text-[11px] font-medium bg-slate-900 text-white rounded hover:bg-slate-800"
            >
              Post to GL
            </button>
          )}
          <button
            type="button"
            onClick={() => printProcurementPdf('PI', r)}
            className="p-1 text-slate-600 hover:text-slate-900"
            title="Download Purchase Invoice PDF"
          >
            <FileText className="w-3.5 h-3.5" />
          </button>
          <button
            type="button"
            onClick={() => setDocDrawer({ docType: 'PurchaseInvoice', docId: Number(r.id), docNumber: String(r.pi_number) })}
            className="p-1 text-slate-600 hover:text-slate-900"
          >
            <Paperclip className="w-3.5 h-3.5" />
          </button>
        </div>
      ),
    },
  ];

  const openModalForTab = () => {
    resetForm();
    setViewingDoc(null);
    if (tab === 'subcontract') {
      setModal('sub');
    } else {
      setModal(tab);
    }
  };

  const docFormCfg: Record<
    NonNullable<typeof modal>,
    { title: string; series: string; pdfTitle: string; numLabel: string; saveLabel: string }
  > = {
    mr: { title: 'New Material Request', series: 'MAT-REQ-.YYYY.-', pdfTitle: 'MATERIAL REQUEST', numLabel: 'MR No.', saveLabel: 'Save & Submit' },
    pr: { title: 'New Purchase Requisition', series: 'PUR-REQ-.YYYY.-', pdfTitle: 'PURCHASE REQUISITION', numLabel: 'PR No.', saveLabel: 'Save' },
    rfq: { title: 'New Request for Quotation', series: 'PUR-RFQ-.YYYY.-', pdfTitle: 'REQUEST FOR QUOTATION', numLabel: 'RFQ No.', saveLabel: 'Send RFQ' },
    sq: { title: 'New Supplier Quotation', series: 'PUR-SQ-.YYYY.-', pdfTitle: 'SUPPLIER QUOTATION', numLabel: 'Quote No.', saveLabel: 'Save Quote' },
    po: {
      title: editingPo ? 'Edit Purchase Order' : 'New Purchase Order',
      series: 'PUR-ORD-.YYYY.-',
      pdfTitle: 'PURCHASE ORDER',
      numLabel: 'PO No.',
      saveLabel: editingPo ? 'Save Changes' : 'Save',
    },
    grn: { title: 'New Goods Receipt Note (GRN)', series: 'MAT-GRN-.YYYY.-', pdfTitle: 'GOODS RECEIPT NOTE', numLabel: 'GRN No.', saveLabel: 'Submit GRN' },
    pi: { title: 'New Purchase Invoice (3-Way Match)', series: 'ACC-PINV-.YYYY.-', pdfTitle: 'PURCHASE INVOICE', numLabel: 'PI No.', saveLabel: 'Save Invoice' },
    prn: { title: 'New Purchase Return / Debit Note', series: 'ACC-PRN-.YYYY.-', pdfTitle: 'PURCHASE RETURN / DEBIT NOTE', numLabel: 'Return No.', saveLabel: 'Submit Return' },
    sub: { title: 'New Subcontracting Order', series: 'SUB-ORD-.YYYY.-', pdfTitle: 'SUBCONTRACTING ORDER', numLabel: 'Subcontract No.', saveLabel: 'Create Subcontract' },
  };

  if (modal) {
    const activeCfg = docFormCfg[modal];
    const formParties: ErpFormParty[] =
      modal === 'sub'
        ? subcontractors.map((s) => ({
            id: Number(s.id),
            code: String(s.code || `SUB-${s.id}`),
            name: String(s.name || ''),
            trn: String(s.trn || ''),
            address: String(s.address || ''),
            contact_person: String(s.contact_person || ''),
            telephone: String(s.telephone || ''),
            currency: 'AED',
          }))
        : suppliers;

    return (
      <div className="space-y-4">
        {err && <div className="p-3 bg-red-50 border border-red-200 rounded text-xs text-red-700">{err}</div>}
        <ErpDocumentForm
          title={activeCfg.title}
          seriesCode={activeCfg.series}
          docTitleForPdf={activeCfg.pdfTitle}
          docNumberLabel={activeCfg.numLabel}
          companyRole="Buyer"
          partyRole="Seller"
          partyLabel={modal === 'sub' ? 'Subcontractor' : 'Supplier'}
          partyRefLabel={modal === 'sub' ? 'Subcontract Ref.' : 'Suppliers Ref. No.'}
          warehouseLabel={modal === 'sub' ? 'Source RM Warehouse' : 'Set Target Warehouse'}
          showParty={!['mr', 'pr', 'rfq'].includes(modal)}
          showPaymentTerms={['sq', 'po', 'pi'].includes(modal)}
          showTankColumn={modal === 'grn'}
          showBatchColumn={['grn', 'sub'].includes(modal)}
          showFreight={['sq', 'po', 'pi', 'sub'].includes(modal)}
          showLinkedPo={['grn', 'pi'].includes(modal)}
          showLinkedGrn={modal === 'pi'}
          showLinkedRfq={modal === 'sq'}
          showSupplierInv={modal === 'pi'}
          showSupplierDn={modal === 'grn'}
          showReason={modal === 'prn'}
          linkedPoOptions={pos.map((p) => ({ id: Number(p.id), label: `${String(p.po_number)} - ${String(p.supplier_name)}` }))}
          linkedGrnOptions={grns.map((g) => ({ id: Number(g.id), label: String(g.grn_number) }))}
          linkedRfqOptions={rfqs.map((r) => ({ id: Number(r.id), label: String(r.rfq_number) }))}
          onSelectLinkedPo={prefillFromPo}
          parties={formParties}
          items={items}
          warehouses={warehouses}
          tanks={tanks}
          paymentTerms={paymentTerms}
          meta={docMeta}
          setMeta={setDocMeta}
          lines={lineItems}
          setLines={setLineItems}
          onSave={submitModal}
          onCancel={() => {
            setModal(null);
            setEditingPo(null);
          }}
          onOpenBulkImport={() => setShowImportModal(true)}
          submitting={submitting}
          saveLabel={activeCfg.saveLabel}
          editingDocNumber={modal === 'po' ? editingPo?.po_number : undefined}
          statusBadge={modal === 'po' && editingPo ? editingPo.status : undefined}
          amendedFrom={modal === 'po' ? editingPo?.amended_from : undefined}
          extraHeaderSlot={
            <>
              {modal === 'rfq' && (
                <div className="md:col-span-3">
                  <label className="block text-[11px] font-medium text-slate-600 mb-1">Select Suppliers to Solicit *</label>
                  <div className="flex flex-wrap gap-3 p-2.5 bg-slate-50 border border-slate-200 rounded">
                    {suppliers.map((s) => (
                      <label key={s.id} className="inline-flex items-center gap-1.5 text-xs">
                        <input
                          type="checkbox"
                          checked={rfqSupplierIds.includes(s.id)}
                          onChange={(e) =>
                            setRfqSupplierIds((prev) => (e.target.checked ? [...prev, s.id] : prev.filter((x) => x !== s.id)))
                          }
                        />
                        <span>{s.name}</span>
                      </label>
                    ))}
                  </div>
                </div>
              )}
              {modal === 'sub' && (
                <>
                  <div>
                    <label className="block text-[11px] font-medium text-slate-600 mb-1">Target FG Warehouse</label>
                    <select
                      value={targetWhId}
                      onChange={(e) => setTargetWhId(Number(e.target.value))}
                      className="w-full px-3 py-1.5 bg-slate-50 border border-slate-200 rounded"
                    >
                      {warehouses.map((w) => (
                        <option key={w.id} value={w.id}>{w.name}</option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="block text-[11px] font-medium text-slate-600 mb-1">Planned Output Qty (Line 1 FG)</label>
                    <input
                      type="number"
                      value={plannedQty}
                      onChange={(e) => setPlannedQty(e.target.value)}
                      className="w-full px-3 py-1.5 bg-slate-50 border border-slate-200 rounded font-mono"
                    />
                  </div>
                  <div>
                    <label className="block text-[11px] font-medium text-slate-600 mb-1">Service Rate / Unit</label>
                    <input
                      type="number"
                      step="0.01"
                      value={serviceRate}
                      onChange={(e) => setServiceRate(e.target.value)}
                      className="w-full px-3 py-1.5 bg-slate-50 border border-slate-200 rounded font-mono"
                    />
                  </div>
                </>
              )}
            </>
          }
        />

        <ExcelImportModal
          open={showImportModal}
          initialType="opening_stock"
          onClose={() => setShowImportModal(false)}
          onImported={(m) => {
            setMsg(m);
            void loadAll();
          }}
        />
      </div>
    );
  }

  // Full-page Document Viewer when user clicks any row
  if (viewingDoc) {
    const listMap: Record<ProcTab, Record<string, unknown>[]> = {
      mr: mrs,
      pr: prs,
      rfq: rfqs,
      sq: sqs,
      po: pos,
      grn: grns,
      pi: pis,
      prn: prns,
      subcontract: subOrders,
    };
    const activeList = listMap[viewingDoc.type] || [];
    const currentIndex = activeList.findIndex((x) => Number(x.id) === viewingDoc.id);
    const rec = currentIndex >= 0 ? activeList[currentIndex] : undefined;

    if (rec) {
      const apiDocTypeMap: Record<ProcTab, string> = {
        mr: 'MaterialRequest',
        pr: 'PurchaseRequisition',
        rfq: 'RFQ',
        sq: 'SupplierQuotation',
        po: 'PurchaseOrder',
        grn: 'PurchaseReceipt',
        pi: 'PurchaseInvoice',
        prn: 'PurchaseReturn',
        subcontract: 'SubcontractingOrder',
      };
      const pdfTypeMap: Record<ProcTab, 'MR' | 'PR' | 'RFQ' | 'SQ' | 'PO' | 'GRN' | 'PI' | 'PRN' | 'SUB'> = {
        mr: 'MR',
        pr: 'PR',
        rfq: 'RFQ',
        sq: 'SQ',
        po: 'PO',
        grn: 'GRN',
        pi: 'PI',
        prn: 'PRN',
        subcontract: 'SUB',
      };
      const rawLines =
        viewingDoc.type === 'subcontract'
          ? ((rec.materials as Record<string, unknown>[]) || [])
          : ((rec.items as Record<string, unknown>[]) || []);

      const viewerItems: ErpViewerItemLine[] = rawLines.map((l) => {
        const qty = Number(l.accepted_qty ?? l.received_qty ?? l.issued_qty ?? l.qty ?? 0);
        const rate = Number(l.rate ?? l.unit_price ?? l.estimated_rate ?? l.unit_cost ?? 0);
        const vatPct = Number(l.vat_rate ?? (['po', 'sq', 'pi', 'prn'].includes(viewingDoc.type) ? 5 : 0));
        const vatAmt = Number(l.vat_amount ?? 0);
        const lineTotal = Number(l.line_total ?? qty * rate + vatAmt);
        return {
          item_code: String(l.item_code || ''),
          description: String(l.description || l.item_name || ''),
          uom: String(l.uom || 'LTR'),
          qty,
          received_qty: l.received_qty !== undefined ? Number(l.received_qty) : undefined,
          rate,
          discount_pct: Number(l.discount_pct || 0),
          vat_rate: vatPct,
          vat_amount: vatAmt,
          line_total: lineTotal,
          tank_code: l.tank_code ? String(l.tank_code) : undefined,
          batch_number: l.batch_number ? String(l.batch_number) : undefined,
        };
      });

      const netSum = rec.subtotal !== undefined ? Number(rec.subtotal) : viewerItems.reduce((s, i) => s + i.qty * i.rate, 0);
      const vatSum = rec.vat_amount !== undefined ? Number(rec.vat_amount) : viewerItems.reduce((s, i) => s + Number(i.vat_amount || 0), 0);
      const grandSum =
        viewingDoc.type === 'subcontract'
          ? netSum + Number(rec.total_service_cost || 0)
          : rec.total_amount !== undefined
          ? Number(rec.total_amount)
          : netSum + vatSum;

      const docNumber = String(
        rec.po_number ||
          rec.grn_number ||
          rec.pi_number ||
          rec.prn_number ||
          rec.mr_number ||
          rec.pr_number ||
          rec.rfq_number ||
          rec.sq_number ||
          rec.sub_number ||
          `#${viewingDoc.id}`
      );
      const titleText = String(
        rec.supplier_name || rec.subcontractor_name || rec.finished_item_name || rec.department || docNumber
      );

      const createActions: ErpViewerAction[] = [];
      let onEditHandler: (() => void) | undefined;
      let onReviseHandler: (() => Promise<void>) | undefined;
      let onCancelHandler: (() => Promise<void>) | undefined;

      if (viewingDoc.type === 'po') {
        const st = String(rec.status || '');
        if (st === 'Draft') {
          createActions.push({
            label: 'Submit PO',
            variant: 'emerald',
            onClick: async () => {
              await handleAction(async () => {
                const res = await apiRequest<{ status: string; requiredRole?: string }>(
                  `/api/procurement/purchase-orders/${rec.id}/submit`,
                  { method: 'POST' }
                );
                setMsg(
                  res.status === 'Pending Approval'
                    ? `Sent to ${res.requiredRole} for approval`
                    : `PO ${docNumber} submitted.`
                );
              });
            },
          });
        }
        if (['Submitted', 'Partially Received'].includes(st)) {
          createActions.push({
            label: 'Make GRN / MRN',
            variant: 'primary',
            onClick: () => openMakeGrnFromPo(rec),
          });
        }
        if (['Submitted', 'Partially Received', 'Completed'].includes(st)) {
          createActions.push({
            label: 'Make Purchase Invoice',
            variant: 'secondary',
            onClick: () => openMakePiFromPo(rec),
          });
          createActions.push({
            label: 'Make Purchase Return',
            variant: 'secondary',
            onClick: () => openMakeReturnFromDoc(rec, 'po'),
          });
        }
        if (['Draft', 'Pending Approval'].includes(st)) {
          onEditHandler = () => openEditPo(rec);
        }
        if (st !== 'Cancelled') {
          onReviseHandler = async () => {
            setErr('');
            setMsg('');
            try {
              const rev = await apiRequest<{ id: number; po_number: string; amended_from: string; revision_no: string }>(
                `/api/procurement/purchase-orders/${rec.id}/revise`,
                { method: 'POST' }
              );
              await loadAll();
              const poItems = (rec.items as Record<string, unknown>[]) || [];
              setEditingPo({
                id: rev.id,
                po_number: rev.po_number,
                status: 'Draft',
                amended_from: rev.amended_from,
              });
              setDocMeta({
                doc_date: todayStr,
                delivery_date: String(rec.delivery_date || todayStr),
                party_id: Number(rec.supplier_id || ''),
                warehouse_id: Number(rec.warehouse_id || warehouses[0]?.id || ''),
                target_warehouse_id: Number(rec.warehouse_id || warehouses[0]?.id || ''),
                payment_term_id: rec.payment_term_id ? Number(rec.payment_term_id) : '',
                price_list_id: '',
                currency: String(rec.currency || company.currency || 'AED'),
                exchange_rate: String(rec.exchange_rate || 1),
                linked_po_id: '',
                linked_grn_id: '',
                linked_rfq_id: '',
                party_ref_no: String(rec.supplier_ref || ''),
                supplier_inv_no: '',
                supplier_dn_no: '',
                delivery_terms: String(rec.delivery_terms || ''),
                delivery_place: String(rec.delivery_place || ''),
                revision_no: rev.revision_no,
                freight_amount: String(rec.freight_amount || 0),
                tax_template: Number(rec.vat_amount || 0) > 0 ? 'UAE VAT 5%' : 'Zero Rated 0%',
                tax_category: 'Standard Rated',
                disable_rounded_total: true,
                additional_discount_pct: '0',
                reason: '',
                remarks: String(rec.remarks || ''),
              });
              setLineItems(
                poItems.map((i) => ({
                  item_id: Number(i.item_id),
                  qty: Number(i.qty || 1),
                  rate: Number(i.rate || 0),
                  discount_pct: Number(i.discount_pct || 0),
                  vat_rate: Number(i.vat_rate ?? 5),
                  batch_number: '',
                  tank_id: findMatchingTankId(Number(i.item_id), Number(rec.warehouse_id || '')),
                  required_by: String(rec.delivery_date || todayStr),
                }))
              );
              setViewingDoc(null);
              setModal('po');
              setMsg(`Created revised draft ${rev.po_number} (amended from ${rev.amended_from}). Edit lines and Save.`);
            } catch (e: unknown) {
              setErr(e instanceof Error ? e.message : 'Failed to revise Purchase Order');
            }
          };
          onCancelHandler = async () => {
            await handleAction(async () => {
              await apiRequest(`/api/procurement/purchase-orders/${rec.id}/cancel`, { method: 'POST' });
              setMsg(`Purchase Order ${docNumber} cancelled.`);
            });
          };
        }
      } else if (viewingDoc.type === 'grn') {
        const linkedPo = pos.find((p) => Number(p.id) === Number(rec.po_id));
        createActions.push({
          label: 'Make Purchase Invoice',
          variant: 'primary',
          onClick: () => {
            if (linkedPo) {
              openMakePiFromPo(linkedPo, rec);
            } else {
              resetForm();
              const grnItems = (rec.items as Record<string, unknown>[]) || [];
              setDocMeta((m) => ({
                ...m,
                linked_grn_id: Number(rec.id),
                party_id: Number(rec.supplier_id || ''),
                warehouse_id: Number(rec.warehouse_id || warehouses[0]?.id || ''),
              }));
              setLineItems(
                grnItems.map((i) => ({
                  item_id: Number(i.item_id),
                  qty: Number(i.accepted_qty ?? i.received_qty ?? 1),
                  rate: Number(i.rate || 0),
                  discount_pct: 0,
                  vat_rate: 5,
                  batch_number: String(i.batch_number || ''),
                  tank_id: i.tank_id ? Number(i.tank_id) : '',
                  required_by: todayStr,
                }))
              );
              setViewingDoc(null);
              setModal('pi');
            }
          },
        });
        createActions.push({
          label: 'Make Purchase Return',
          variant: 'secondary',
          onClick: () => openMakeReturnFromDoc(rec, 'grn'),
        });
      } else if (viewingDoc.type === 'mr') {
        createActions.push({
          label: 'Make Requisition (PR)',
          variant: 'primary',
          onClick: () => {
            resetForm();
            const mrItems = (rec.items as Record<string, unknown>[]) || [];
            setDocMeta((m) => ({
              ...m,
              warehouse_id: Number(rec.warehouse_id || warehouses[0]?.id || ''),
              remarks: `From MR ${docNumber}`,
            }));
            setLineItems(
              mrItems.map((i) => ({
                item_id: Number(i.item_id),
                qty: Number(i.qty || 1),
                rate: Number(items.find((x) => x.id === Number(i.item_id))?.standard_cost || 0),
                discount_pct: 0,
                vat_rate: 5,
                batch_number: '',
                tank_id: '',
                required_by: todayStr,
              }))
            );
            setViewingDoc(null);
            setModal('pr');
          },
        });
        createActions.push({
          label: 'Make Purchase Order',
          variant: 'secondary',
          onClick: () => {
            resetForm();
            const mrItems = (rec.items as Record<string, unknown>[]) || [];
            setDocMeta((m) => ({
              ...m,
              warehouse_id: Number(rec.warehouse_id || warehouses[0]?.id || ''),
              remarks: `From MR ${docNumber}`,
            }));
            setLineItems(
              mrItems.map((i) => ({
                item_id: Number(i.item_id),
                qty: Number(i.qty || 1),
                rate: Number(items.find((x) => x.id === Number(i.item_id))?.standard_cost || 0),
                discount_pct: 0,
                vat_rate: 5,
                batch_number: '',
                tank_id: '',
                required_by: todayStr,
              }))
            );
            setViewingDoc(null);
            setModal('po');
          },
        });
      } else if (viewingDoc.type === 'pr') {
        createActions.push({
          label: 'Make Purchase Order',
          variant: 'primary',
          onClick: () => {
            resetForm();
            const prItems = (rec.items as Record<string, unknown>[]) || [];
            setDocMeta((m) => ({
              ...m,
              warehouse_id: Number(rec.warehouse_id || warehouses[0]?.id || ''),
              remarks: `From PR ${docNumber}`,
            }));
            setLineItems(
              prItems.map((i) => ({
                item_id: Number(i.item_id),
                qty: Number(i.qty || 1),
                rate: Number(i.estimated_rate || 0),
                discount_pct: 0,
                vat_rate: 5,
                batch_number: '',
                tank_id: '',
                required_by: todayStr,
              }))
            );
            setViewingDoc(null);
            setModal('po');
          },
        });
      } else if (viewingDoc.type === 'rfq') {
        createActions.push({
          label: 'Record Supplier Quote',
          variant: 'primary',
          onClick: () => {
            resetForm();
            const rfqItems = (rec.items as Record<string, unknown>[]) || [];
            setDocMeta((m) => ({
              ...m,
              linked_rfq_id: Number(rec.id),
              remarks: `Quote for ${docNumber}`,
            }));
            setLineItems(
              rfqItems.map((i) => ({
                item_id: Number(i.item_id),
                qty: Number(i.qty || 1),
                rate: 0,
                discount_pct: 0,
                vat_rate: 5,
                batch_number: '',
                tank_id: '',
                required_by: todayStr,
              }))
            );
            setViewingDoc(null);
            setModal('sq');
          },
        });
        createActions.push({
          label: 'Compare Quotes',
          variant: 'secondary',
          onClick: async () => {
            const res = await apiRequest<{ quotations: Record<string, unknown>[] }>(`/api/procurement/rfqs/${rec.id}/comparison`);
            setComparison({ rfqNumber: docNumber, quotations: res.quotations });
            setViewingDoc(null);
            setTab('rfq');
          },
        });
      } else if (viewingDoc.type === 'sq') {
        createActions.push({
          label: 'Make Purchase Order',
          variant: 'primary',
          onClick: () => {
            resetForm();
            const sqItems = (rec.items as Record<string, unknown>[]) || [];
            setDocMeta((m) => ({
              ...m,
              party_id: Number(rec.supplier_id || ''),
              payment_term_id: rec.payment_term_id ? Number(rec.payment_term_id) : '',
              currency: String(rec.currency || 'AED'),
              exchange_rate: String(rec.exchange_rate || 1),
              freight_amount: String(rec.freight_amount || 0),
              remarks: `Awarded from Quote ${docNumber}`,
            }));
            setLineItems(
              sqItems.map((i) => ({
                item_id: Number(i.item_id),
                qty: Number(i.qty || 1),
                rate: Number(i.unit_price || 0),
                discount_pct: 0,
                vat_rate: Number(i.vat_rate ?? 5),
                batch_number: '',
                tank_id: '',
                required_by: todayStr,
              }))
            );
            setViewingDoc(null);
            setModal('po');
          },
        });
      } else if (viewingDoc.type === 'pi') {
        if (rec.status === 'Draft' && rec.matching_status === 'Mismatch' && rec.approval_status !== 'Approved') {
          createActions.push({
            label: 'Approve Variance',
            variant: 'amber',
            onClick: async () => {
              await handleAction(async () => {
                await apiRequest(`/api/procurement/purchase-invoices/${rec.id}/approve-mismatch`, { method: 'POST' });
                setMsg(`3-Way Match variance approved for ${docNumber}`);
              });
            },
          });
        }
        if (rec.status === 'Draft') {
          createActions.push({
            label: 'Post to GL',
            variant: 'emerald',
            onClick: async () => {
              await handleAction(async () => {
                const res = await apiRequest<{ je_number: string }>(`/api/procurement/purchase-invoices/${rec.id}/post`, { method: 'POST' });
                setMsg(`Posted ${docNumber} to GL (${res.je_number}) with payment schedules.`);
              });
            },
          });
        }
        createActions.push({
          label: 'Make Debit Note / Return',
          variant: 'secondary',
          onClick: () => openMakeReturnFromDoc(rec, 'pi'),
        });
      } else if (viewingDoc.type === 'subcontract' && rec.status !== 'Completed') {
        createActions.push({
          label: 'Receive Finished Goods',
          variant: 'emerald',
          onClick: async () => {
            await handleAction(async () => {
              await apiRequest(`/api/procurement/subcontracting-orders/${rec.id}/receive`, {
                method: 'POST',
                body: JSON.stringify({ received_qty: Number(rec.planned_qty) }),
              });
              setMsg(`Received finished goods from ${docNumber}`);
            });
          },
        });
      }

      const handleNavigateLink = (link: { docType: string; id: number }) => {
        const navMap: Record<string, ProcTab> = {
          MaterialRequest: 'mr',
          PurchaseRequisition: 'pr',
          RFQ: 'rfq',
          SupplierQuotation: 'sq',
          PurchaseOrder: 'po',
          PurchaseReceipt: 'grn',
          PurchaseInvoice: 'pi',
          PurchaseReturn: 'prn',
          SubcontractingOrder: 'subcontract',
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
            title={titleText}
            status={String(rec.status || '')}
            approvalStatus={rec.approval_status ? String(rec.approval_status) : undefined}
            docDate={String(rec.po_date || rec.receipt_date || rec.invoice_date || rec.return_date || rec.request_date || rec.rfq_date || rec.quotation_date || rec.order_date || '')}
            deliveryDate={String(rec.delivery_date || rec.due_date || rec.required_date || rec.valid_until || rec.expected_date || '')}
            companyRole="Buyer"
            partyLabel={viewingDoc.type === 'subcontract' ? 'Subcontractor' : 'Supplier'}
            partyName={String(rec.supplier_name || rec.subcontractor_name || '') || undefined}
            partyTrn={String(rec.supplier_trn || '')}
            partyAddress={String(rec.supplier_address || rec.subcontractor_address || '')}
            partyCountry={String(rec.supplier_country || '')}
            partyContactPerson={String(rec.supplier_contact_person || rec.subcontractor_contact_person || rec.requested_by || '')}
            partyTelephone={String(rec.supplier_telephone || '')}
            warehouseName={String(rec.warehouse_name || rec.source_warehouse_name || '')}
            refLabel="Suppliers Ref. / Link"
            refNo={String(rec.supplier_ref || rec.supplier_invoice_number || rec.supplier_dn_number || rec.po_number || rec.mr_number || '-')}
            amendedFrom={rec.amended_from ? String(rec.amended_from) : undefined}
            revisionNo={String(rec.revision_no || 'Original')}
            revisionDate={String(rec.revision_date || '')}
            currency={String(rec.currency || company.currency || 'AED')}
            exchangeRate={Number(rec.exchange_rate || 1)}
            paymentTerms={String(rec.payment_term_name || '')}
            deliveryTerms={String(rec.delivery_terms || '')}
            deliveryPlace={String(rec.delivery_place || rec.warehouse_location || rec.warehouse_name || '')}
            remarks={String(rec.remarks || rec.reason || '')}
            creatorName={String(rec.creator_name || rec.requested_by || '')}
            createdAt={String(rec.created_at || '')}
            approverName={String(rec.approver_name || '')}
            submittedAt={String(rec.submitted_at || '')}
            freightAmount={Number(rec.freight_amount || 0)}
            discountAmount={Number(rec.discount_amount || 0)}
            subtotal={netSum}
            vatAmount={vatSum}
            totalAmount={grandSum}
            items={viewerItems}
            showReceivedCol={viewingDoc.type === 'po'}
            showTankCol={viewingDoc.type === 'grn'}
            showBatchCol={['grn', 'prn', 'subcontract'].includes(viewingDoc.type)}
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
            onPrintPreview={() => printProcurementPdf(pdfTypeMap[viewingDoc.type], rec)}
            onEdit={onEditHandler}
            onRevise={onReviseHandler}
            onCancelDoc={onCancelHandler}
            onNavigateLink={handleNavigateLink}
          />
        </div>
      );
    }
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-slate-900">Procurement & Subcontracting</h1>
          <p className="text-xs text-slate-500">Material Request → Requisition → RFQ → Quote Comparison → PO → GRN → 3-Way Match Invoice → Payment</p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setShowImportModal(true)}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded-md hover:bg-slate-50 whitespace-nowrap shrink-0"
          >
            <FileSpreadsheet className="w-3.5 h-3.5 text-emerald-700" />
            Import Excel & Templates
          </button>
          <button
            type="button"
            onClick={openModalForTab}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-white bg-slate-900 rounded-md hover:bg-slate-800 whitespace-nowrap shrink-0"
          >
            <Plus className="w-3.5 h-3.5" />
            New {tabs.find((t) => t.id === tab)?.label.replace(/s$/, '')}
          </button>
        </div>
      </div>

      <div className="flex flex-wrap gap-1 p-1 bg-slate-100 rounded-lg w-fit">
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setTab(t.id)}
            className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 ${
              tab === t.id ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {msg && <div className="p-3 bg-emerald-50 border border-emerald-200 rounded text-xs text-emerald-800">{msg}</div>}
      {err && <div className="p-3 bg-red-50 border border-red-200 rounded text-xs text-red-700">{err}</div>}

      {tab === 'mr' && (
        <DataTable
          title="Material Requests"
          columns={[
            { key: 'mr_number', header: 'MR #', render: (r) => <span className="font-mono font-medium text-slate-900">{String(r.mr_number)}</span> },
            { key: 'request_date', header: 'Date' },
            { key: 'request_type', header: 'Type' },
            { key: 'department', header: 'Department' },
            { key: 'warehouse_name', header: 'Warehouse' },
            { key: 'status', header: 'Status' },
            {
              key: 'actions',
              header: 'Actions',
              render: (r) => (
                <button type="button" onClick={(e) => { e.stopPropagation(); printProcurementPdf('MR', r); }} className="inline-flex items-center gap-1 px-2 py-1 text-xs border border-slate-300 rounded hover:bg-slate-50">
                  <FileText className="w-3 h-3" /> PDF
                </button>
              ),
            },
          ]}
          data={mrs}
          onRowClick={(r) => setViewingDoc({ type: 'mr', id: Number(r.id) })}
          exportFilename="material_requests"
        />
      )}

      {tab === 'pr' && (
        <DataTable
          title="Purchase Requisitions"
          columns={[
            { key: 'pr_number', header: 'PR #', render: (r) => <span className="font-mono font-medium text-slate-900">{String(r.pr_number)}</span> },
            { key: 'mr_number', header: 'Source MR' },
            { key: 'request_date', header: 'Date' },
            { key: 'requested_by', header: 'Requested By' },
            { key: 'status', header: 'Status' },
            {
              key: 'actions',
              header: 'Actions',
              render: (r) => (
                <button type="button" onClick={(e) => { e.stopPropagation(); printProcurementPdf('PR', r); }} className="inline-flex items-center gap-1 px-2 py-1 text-xs border border-slate-300 rounded hover:bg-slate-50">
                  <FileText className="w-3 h-3" /> PDF
                </button>
              ),
            },
          ]}
          data={prs}
          onRowClick={(r) => setViewingDoc({ type: 'pr', id: Number(r.id) })}
          exportFilename="purchase_requisitions"
        />
      )}

      {tab === 'rfq' && (
        <div className="space-y-4">
          <DataTable
            title="Requests for Quotation"
            columns={[
              { key: 'rfq_number', header: 'RFQ #', render: (r) => <span className="font-mono font-medium text-slate-900">{String(r.rfq_number)}</span> },
              { key: 'rfq_date', header: 'Date' },
              { key: 'valid_until', header: 'Valid Until' },
              { key: 'status', header: 'Status' },
              {
                key: 'actions',
                header: 'Actions',
                render: (r) => (
                  <div className="flex items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
                    <button
                      type="button"
                      onClick={async () => {
                        const res = await apiRequest<{ quotations: Record<string, unknown>[] }>(`/api/procurement/rfqs/${r.id}/comparison`);
                        setComparison({ rfqNumber: String(r.rfq_number), quotations: res.quotations });
                      }}
                      className="px-2.5 py-1 text-xs font-medium bg-slate-900 text-white rounded hover:bg-slate-800"
                    >
                      Compare Quotes
                    </button>
                    <button type="button" onClick={() => printProcurementPdf('RFQ', r)} className="p-1 text-slate-600 hover:text-slate-900" title="Download RFQ PDF">
                      <FileText className="w-3.5 h-3.5" />
                    </button>
                  </div>
                ),
              },
            ]}
            data={rfqs}
            onRowClick={(r) => setViewingDoc({ type: 'rfq', id: Number(r.id) })}
            exportFilename="rfqs"
          />
          {comparison && (
            <div className="bg-white border border-slate-200 rounded-lg p-5">
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-sm font-semibold text-slate-900">Supplier Quotation Landed Cost Comparison — {comparison.rfqNumber}</h3>
                <button type="button" onClick={() => setComparison(null)} className="text-xs text-slate-500 hover:text-slate-900">Close</button>
              </div>
              {comparison.quotations.length === 0 ? (
                <p className="text-xs text-slate-500">No supplier quotations recorded for this RFQ yet.</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-xs text-left border-collapse">
                    <thead>
                      <tr className="bg-slate-50 border-b border-slate-200">
                        <th className="px-3 py-2">Quote #</th>
                        <th className="px-3 py-2">Supplier</th>
                        <th className="px-3 py-2">Terms</th>
                        <th className="px-3 py-2 text-right">Lead Days</th>
                        <th className="px-3 py-2 text-right">Freight</th>
                        <th className="px-3 py-2 text-right">Landed Base (AED)</th>
                        <th className="px-3 py-2">Action</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {comparison.quotations.map((q) => (
                        <tr key={String(q.id)}>
                          <td className="px-3 py-2 font-mono">{String(q.sq_number)}</td>
                          <td className="px-3 py-2 font-medium">{String(q.supplier_name)}</td>
                          <td className="px-3 py-2">{String(q.payment_term_name || 'Standard')}</td>
                          <td className="px-3 py-2 text-right tabular-nums">{String(q.delivery_days)} d</td>
                          <td className="px-3 py-2 text-right font-mono tabular-nums">{Number(q.freight_amount || 0).toFixed(2)}</td>
                          <td className="px-3 py-2 text-right font-mono font-semibold tabular-nums">{Number(q.landed_total_base || 0).toFixed(2)}</td>
                          <td className="px-3 py-2">
                            <button
                              type="button"
                              onClick={() =>
                                handleAction(async () => {
                                  const qItems = (q.items as { item_id: number; qty: number; unit_price: number }[]) || [];
                                  await apiRequest('/api/procurement/purchase-orders', {
                                    method: 'POST',
                                    body: JSON.stringify({
                                      supplier_id: Number(q.supplier_id),
                                      sq_id: Number(q.id),
                                      currency: q.currency,
                                      exchange_rate: Number(q.exchange_rate || 1),
                                      payment_term_id: q.payment_term_id,
                                      warehouse_id: warehouses[0]?.id || 1,
                                      freight_amount: Number(q.freight_amount || 0),
                                      items: qItems.map((it) => ({ item_id: it.item_id, qty: it.qty, rate: it.unit_price })),
                                    }),
                                  });
                                  setMsg(`Converted ${q.sq_number} into Purchase Order.`);
                                  setTab('po');
                                })
                              }
                              className="px-2.5 py-1 bg-slate-900 text-white rounded text-[11px]"
                            >
                              Award & Create PO
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {tab === 'sq' && (
        <DataTable
          title="Supplier Quotations"
          columns={[
            { key: 'sq_number', header: 'Quote #', render: (r) => <span className="font-mono font-medium text-slate-900">{String(r.sq_number)}</span> },
            { key: 'supplier_name', header: 'Supplier' },
            { key: 'rfq_number', header: 'RFQ #' },
            { key: 'currency', header: 'Curr' },
            { key: 'delivery_days', header: 'Delivery Days', numeric: true },
            { key: 'total_amount', header: 'Total', numeric: true, render: (r) => Number(r.total_amount || 0).toFixed(2) },
            { key: 'status', header: 'Status' },
            {
              key: 'actions',
              header: 'Actions',
              render: (r) => (
                <button type="button" onClick={(e) => { e.stopPropagation(); printProcurementPdf('SQ', r); }} className="inline-flex items-center gap-1 px-2 py-1 text-xs border border-slate-300 rounded hover:bg-slate-50">
                  <FileText className="w-3 h-3" /> PDF
                </button>
              ),
            },
          ]}
          data={sqs}
          onRowClick={(r) => setViewingDoc({ type: 'sq', id: Number(r.id) })}
          exportFilename="supplier_quotations"
        />
      )}

      {tab === 'po' && (
        <DataTable
          title="Purchase Orders"
          columns={poCols}
          data={pos}
          onRowClick={(r) => setViewingDoc({ type: 'po', id: Number(r.id) })}
          exportFilename="purchase_orders"
          statusFilterKey="status"
          statusOptions={['Draft', 'Pending Approval', 'Submitted', 'Partially Received', 'Completed', 'Cancelled']}
        />
      )}

      {tab === 'grn' && (
        <DataTable
          title="Goods Receipt Notes (GRN)"
          columns={[
            { key: 'grn_number', header: 'GRN #', render: (r) => <span className="font-mono font-medium text-slate-900">{String(r.grn_number)}</span> },
            { key: 'receipt_date', header: 'Date' },
            { key: 'po_number', header: 'PO #' },
            { key: 'supplier_name', header: 'Supplier' },
            { key: 'warehouse_name', header: 'Warehouse' },
            { key: 'supplier_dn_number', header: 'Supplier DN #' },
            { key: 'status', header: 'Status' },
            {
              key: 'actions',
              header: 'Actions',
              render: (r) => (
                <button type="button" onClick={(e) => { e.stopPropagation(); printProcurementPdf('GRN', r); }} className="inline-flex items-center gap-1 px-2 py-1 text-xs border border-slate-300 rounded hover:bg-slate-50">
                  <FileText className="w-3 h-3" /> PDF
                </button>
              ),
            },
          ]}
          data={grns}
          onRowClick={(r) => setViewingDoc({ type: 'grn', id: Number(r.id) })}
          exportFilename="purchase_receipts"
        />
      )}

      {tab === 'pi' && (
        <DataTable
          title="Purchase Invoices & 3-Way Matching"
          columns={piCols}
          data={pis}
          onRowClick={(r) => setViewingDoc({ type: 'pi', id: Number(r.id) })}
          exportFilename="purchase_invoices"
          statusFilterKey="matching_status"
          statusOptions={['Matched', 'Mismatch', 'Direct']}
        />
      )}

      {tab === 'prn' && (
        <DataTable
          title="Purchase Returns"
          columns={[
            { key: 'prn_number', header: 'Return #', render: (r) => <span className="font-mono font-medium text-slate-900">{String(r.prn_number)}</span> },
            { key: 'return_date', header: 'Date' },
            { key: 'supplier_name', header: 'Supplier' },
            { key: 'reason', header: 'Reason' },
            { key: 'total_amount', header: 'Debit Value', numeric: true, render: (r) => Number(r.total_amount || 0).toFixed(2) },
            { key: 'status', header: 'Status' },
            {
              key: 'actions',
              header: 'Actions',
              render: (r) => (
                <button type="button" onClick={(e) => { e.stopPropagation(); printProcurementPdf('PRN', r); }} className="inline-flex items-center gap-1 px-2 py-1 text-xs border border-slate-300 rounded hover:bg-slate-50">
                  <FileText className="w-3 h-3" /> PDF
                </button>
              ),
            },
          ]}
          data={prns}
          onRowClick={(r) => setViewingDoc({ type: 'prn', id: Number(r.id) })}
          exportFilename="purchase_returns"
        />
      )}

      {tab === 'subcontract' && (
        <DataTable
          title="Subcontracting Orders"
          columns={[
            { key: 'sub_number', header: 'Subcontract #', render: (r) => <span className="font-mono font-medium text-slate-900">{String(r.sub_number)}</span> },
            { key: 'subcontractor_name', header: 'Subcontractor' },
            { key: 'finished_item_name', header: 'Finished Product' },
            { key: 'planned_qty', header: 'Planned', numeric: true },
            { key: 'received_qty', header: 'Received', numeric: true },
            { key: 'total_service_cost', header: 'Service Cost', numeric: true, render: (r) => Number(r.total_service_cost || 0).toFixed(2) },
            { key: 'status', header: 'Status' },
            {
              key: 'actions',
              header: 'Actions',
              render: (r) => (
                <div className="flex items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
                  {r.status !== 'Completed' ? (
                    <button
                      type="button"
                      onClick={() =>
                        handleAction(async () => {
                          await apiRequest(`/api/procurement/subcontracting-orders/${r.id}/receive`, {
                            method: 'POST',
                            body: JSON.stringify({ received_qty: Number(r.planned_qty) }),
                          });
                          setMsg(`Received finished goods from ${r.sub_number}`);
                        })
                      }
                      className="px-2.5 py-1 text-[11px] font-medium bg-slate-900 text-white rounded"
                    >
                      Receive Finished Goods
                    </button>
                  ) : (
                    <span className="text-xs text-emerald-700">Completed</span>
                  )}
                  <button type="button" onClick={() => printProcurementPdf('SUB', r)} className="p-1 text-slate-600 hover:text-slate-900" title="Download Subcontract PDF">
                    <FileText className="w-3.5 h-3.5" />
                  </button>
                </div>
              ),
            },
          ]}
          data={subOrders}
          onRowClick={(r) => setViewingDoc({ type: 'subcontract', id: Number(r.id) })}
          exportFilename="subcontracting_orders"
        />
      )}

      <ExcelImportModal
        open={showImportModal}
        initialType="opening_stock"
        onClose={() => setShowImportModal(false)}
        onImported={(m) => {
          setMsg(m);
          void loadAll();
        }}
      />

      {docDrawer && (
        <DocumentPanel
          docType={docDrawer.docType}
          docId={docDrawer.docId}
          docNumber={docDrawer.docNumber}
          onClose={() => setDocDrawer(null)}
        />
      )}
    </div>
  );
}
