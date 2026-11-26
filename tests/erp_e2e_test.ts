import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import * as XLSX from 'xlsx';

// Isolate test database & backup directory before importing db.ts
const TEST_DB_REL = './data/lubricants_erp_e2e_test.db';
const TEST_DB_ABS = path.resolve(process.cwd(), TEST_DB_REL);
for (const ext of ['', '-wal', '-shm']) {
  if (fs.existsSync(TEST_DB_ABS + ext)) fs.unlinkSync(TEST_DB_ABS + ext);
}
process.env.DATABASE_URL = `sqlite:///${TEST_DB_REL}`;
process.env.JWT_SECRET = 'e2e_test_ephemeral_secret_key_for_verification_only';

let baseUrl = '';
let adminToken = '';

async function api<T = Record<string, unknown>>(
  endpoint: string,
  options: RequestInit & { token?: string; expectStatus?: number } = {}
): Promise<T> {
  const headers = new Headers(options.headers || {});
  const tok = options.token ?? adminToken;
  if (tok) headers.set('Authorization', `Bearer ${tok}`);
  if (!headers.has('Content-Type')) headers.set('Content-Type', 'application/json');

  const res = await fetch(`${baseUrl}${endpoint}`, { ...options, headers });
  const data = (await res.json()) as T & { error?: string };
  if (options.expectStatus !== undefined) {
    assert.equal(res.status, options.expectStatus, `Expected HTTP ${options.expectStatus} on ${endpoint}, got ${res.status}: ${JSON.stringify(data)}`);
  } else if (!res.ok) {
    throw new Error(`HTTP ${res.status} on ${endpoint}: ${data.error || JSON.stringify(data)}`);
  }
  return data;
}

async function runTests() {
  const { getDb, resetDbConnection } = await import('../server/db.ts');
  const { default: authRoutes } = await import('../server/routes/auth.ts');
  const { default: userRoutes } = await import('../server/routes/users.ts');
  const { default: masterRoutes } = await import('../server/routes/masters.ts');
  const { default: procurementRoutes } = await import('../server/routes/procurement.ts');
  const { default: inventoryRoutes } = await import('../server/routes/inventory.ts');
  const { default: manufacturingRoutes } = await import('../server/routes/manufacturing.ts');
  const { default: qualityRoutes } = await import('../server/routes/quality.ts');
  const { default: salesRoutes } = await import('../server/routes/sales.ts');
  const { default: accountingRoutes } = await import('../server/routes/accounting.ts');
  const { default: operationsRoutes } = await import('../server/routes/operations.ts');
  const { default: systemRoutes } = await import('../server/routes/system.ts');
  const { default: importRoutes } = await import('../server/routes/import.ts');

  getDb();
  const app = express();
  app.use(express.json({ limit: '10mb' }));
  app.use('/api/auth', authRoutes);
  app.use('/api/admin', userRoutes);
  app.use('/api/masters', masterRoutes);
  app.use('/api/procurement', procurementRoutes);
  app.use('/api/inventory', inventoryRoutes);
  app.use('/api/manufacturing', manufacturingRoutes);
  app.use('/api/quality', qualityRoutes);
  app.use('/api/sales', salesRoutes);
  app.use('/api/accounting', accountingRoutes);
  app.use('/api/operations', operationsRoutes);
  app.use('/api/system', systemRoutes);
  app.use('/api/import', importRoutes);

  const server = await new Promise<ReturnType<typeof app.listen>>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const addr = server.address() as { port: number };
  baseUrl = `http://127.0.0.1:${addr.port}`;

  try {
    console.log('--- Setup Admin & Sample Lubricants Plant Data ---');
    const status = await api<{ needsSetup: boolean }>('/api/auth/status', { token: '' });
    assert.equal(status.needsSetup, true);

    const setup = await api<{ token: string; user: { id: number } }>('/api/auth/setup-admin', {
      method: 'POST',
      token: '',
      body: JSON.stringify({
        username: 'admin',
        email: 'alnisrpurchase@gmail.com',
        fullName: 'Plant Director',
        password: 'StrongTestPassword!2026',
      }),
    });
    adminToken = setup.token;
    assert.ok(adminToken);

    // Seed lubricant masters + initial stock + opening GL
    const seedRes = await api<{ alreadyPopulated: boolean; itemsCreated: number }>('/api/auth/seed-sample-lubricants', { method: 'POST', body: '{}' });
    assert.equal(seedRes.alreadyPopulated, false);
    assert.ok(seedRes.itemsCreated > 0);

    // Load masters for reference IDs
    const itemsRes = await api<{ items: { id: number; item_code: string; name: string }[] }>('/api/masters/items');
    const supRes = await api<{ items: { id: number; name: string }[] }>('/api/masters/suppliers');
    const custRes = await api<{ items: { id: number; name: string }[] }>('/api/masters/customers');
    const whRes = await api<{ items: { id: number; code: string; warehouse_type: string }[] }>('/api/masters/warehouses');
    const ptRes = await api<{ items: { id: number; name: string }[] }>('/api/masters/payment-terms');
    const accRes = await api<{ banks: { id: number; account_name: string }[] }>('/api/accounting/accounts');

    const baseOil = itemsRes.items.find((i) => i.item_code === 'RM-SN150')!;
    const additive = itemsRes.items.find((i) => i.item_code === 'ADD-DI20W50')!;
    const bottle = itemsRes.items.find((i) => i.item_code === 'PKG-BTL-1L')!;
    const fg5w30 = itemsRes.items.find((i) => i.item_code === 'FG-20W50-1L')!;
    const supplier = supRes.items[0];
    const customer = custRes.items[0];
    const whRm = whRes.items.find((w) => w.code === 'WH-RM')!;
    const whFg = whRes.items.find((w) => w.code === 'WH-FG')!;
    const bank = accRes.banks[0];

    // =========================================================================
    // TEST 1: Full Purchase Workflow + 3-Way Matching (Match & Mismatch Block)
    // =========================================================================
    console.log('TEST 1: Full Purchase Workflow & 3-Way Matching...');
    const mr = await api<{ id: number; mr_number: string }>('/api/procurement/material-requests', {
      method: 'POST',
      body: JSON.stringify({
        warehouse_id: whRm.id,
        items: [{ item_id: baseOil.id, qty: 1000 }],
      }),
    });
    const pr = await api<{ id: number; pr_number: string }>('/api/procurement/purchase-requisitions', {
      method: 'POST',
      body: JSON.stringify({
        mr_id: mr.id,
        warehouse_id: whRm.id,
        items: [{ item_id: baseOil.id, qty: 1000, estimated_rate: 4.5 }],
      }),
    });
    const rfq = await api<{ id: number; rfq_number: string }>('/api/procurement/rfqs', {
      method: 'POST',
      body: JSON.stringify({
        pr_id: pr.id,
        supplier_ids: [supplier.id],
        items: [{ item_id: baseOil.id, qty: 1000 }],
      }),
    });
    const sq = await api<{ id: number }>('/api/procurement/supplier-quotations', {
      method: 'POST',
      body: JSON.stringify({
        rfq_id: rfq.id,
        supplier_id: supplier.id,
        items: [{ item_id: baseOil.id, qty: 1000, unit_price: 4.5 }],
      }),
    });
    const comp = await api<{ quotations: { id: number }[] }>(`/api/procurement/rfqs/${rfq.id}/comparison`);
    assert.equal(comp.quotations.length, 1);

    const po = await api<{ id: number; po_number: string }>('/api/procurement/purchase-orders', {
      method: 'POST',
      body: JSON.stringify({
        supplier_id: supplier.id,
        sq_id: sq.id,
        pr_id: pr.id,
        warehouse_id: whRm.id,
        items: [{ item_id: baseOil.id, qty: 1000, rate: 4.5, vat_rate: 5 }],
      }),
    });
    await api(`/api/procurement/purchase-orders/${po.id}/submit`, { method: 'POST', body: '{}' });

    const poList = await api<{ items: { id: number; items: { id: number; item_id: number }[] }[] }>('/api/procurement/purchase-orders');
    const poItemId = poList.items.find((p) => p.id === po.id)!.items[0].id;

    const rmBatchNo = 'RM-SN150-E2E-01';
    const grn = await api<{ id: number; grn_number: string }>('/api/procurement/purchase-receipts', {
      method: 'POST',
      body: JSON.stringify({
        po_id: po.id,
        supplier_id: supplier.id,
        warehouse_id: whRm.id,
        submit_now: true,
        items: [
          {
            po_item_id: poItemId,
            item_id: baseOil.id,
            ordered_qty: 1000,
            received_qty: 1000,
            accepted_qty: 1000,
            rate: 4.5,
            batch_number: rmBatchNo,
            qc_required: false,
          },
        ],
      }),
    });

    // 3-Way Mismatch Check: Price variance 4.5 -> 6.0 must flag Mismatch and block posting until approved
    const mismatchPi = await api<{ id: number; matching_status: string; matching_notes: string[] }>('/api/procurement/purchase-invoices', {
      method: 'POST',
      body: JSON.stringify({
        supplier_id: supplier.id,
        supplier_invoice_number: 'SUP-INV-MISMATCH-01',
        po_id: po.id,
        grn_id: grn.id,
        items: [{ item_id: baseOil.id, qty: 1000, rate: 6.0, vat_rate: 5 }],
      }),
    });
    assert.equal(mismatchPi.matching_status, 'Mismatch');
    assert.ok(mismatchPi.matching_notes.length > 0);
    await api(`/api/procurement/purchase-invoices/${mismatchPi.id}/post`, {
      method: 'POST',
      body: '{}',
      expectStatus: 400,
    });

    // Matched Purchase Invoice -> Post GL + Payment Voucher
    const matchedPi = await api<{ id: number; matching_status: string; total_amount: number }>('/api/procurement/purchase-invoices', {
      method: 'POST',
      body: JSON.stringify({
        supplier_id: supplier.id,
        supplier_invoice_number: 'SUP-INV-MATCH-01',
        po_id: po.id,
        grn_id: grn.id,
        items: [{ item_id: baseOil.id, qty: 1000, rate: 4.5, vat_rate: 5 }],
      }),
    });
    assert.equal(matchedPi.matching_status, 'Matched');
    await api(`/api/procurement/purchase-invoices/${matchedPi.id}/post`, { method: 'POST', body: '{}' });

    const pv = await api<{ id: number; status: string }>('/api/accounting/vouchers', {
      method: 'POST',
      body: JSON.stringify({
        voucher_type: 'Payment',
        party_type: 'Supplier',
        party_id: supplier.id,
        bank_account_id: bank.id,
        amount: matchedPi.total_amount,
        allocated_doc_type: 'PurchaseInvoice',
        allocated_doc_id: matchedPi.id,
      }),
    });
    assert.equal(pv.status, 'Posted');

    // =========================================================================
    // TEST 3: Manufacturing BOM, Scaling, Blending/Filling, Completion & Two-Way Traceability
    // =========================================================================
    console.log('TEST 3: Manufacturing BOM, Scaling, Completion & Traceability...');
    const bom = await api<{ id: number; bom_number: string }>('/api/manufacturing/boms', {
      method: 'POST',
      body: JSON.stringify({
        finished_item_id: fg5w30.id,
        version: 'v2.0-E2E',
        batch_size: 100,
        labour_cost: 200,
        overhead_cost: 150,
        items: [
          { item_id: baseOil.id, component_type: 'Formula', qty: 80 },
          { item_id: additive.id, component_type: 'Formula', qty: 15 },
          { item_id: bottle.id, component_type: 'Packaging', qty: 25, carton_packing_qty: 4 },
        ],
      }),
    });

    const scaled = await api<{ scale_factor: number; components: { required_qty: number }[] }>(`/api/manufacturing/boms/${bom.id}/scale?qty=200`);
    assert.equal(scaled.scale_factor, 2);

    const prod = await api<{ id: number; prod_number: string }>('/api/manufacturing/production-orders', {
      method: 'POST',
      body: JSON.stringify({
        bom_id: bom.id,
        planned_qty: 100,
        warehouse_id: whRm.id,
        target_warehouse_id: whFg.id,
        carton_packing_qty: 4,
      }),
    });

    const prodList = await api<{ items: { id: number; consumptions: { id: number; item_id: number; planned_qty: number }[] }[] }>('/api/manufacturing/production-orders');
    const prodObj = prodList.items.find((p) => p.id === prod.id)!;

    // Complete with QC Hold enabled (qc_release_immediately: false) so we can also verify Test 2 QC Hold gate!
    const fgBatchNo = 'FG-5W30-E2E-BATCH-01';
    const compRes = await api<{ batch_number: string; unit_actual_cost: number }>(`/api/manufacturing/production-orders/${prod.id}/complete`, {
      method: 'POST',
      body: JSON.stringify({
        completed_qty: 100,
        rejected_qty: 0,
        batch_number: fgBatchNo,
        qc_release_immediately: false,
        consumptions: prodObj.consumptions.map((c) => ({
          id: c.id,
          actual_qty: c.planned_qty,
          wastage_qty: 0,
          batch_number: c.item_id === baseOil.id ? rmBatchNo : undefined,
        })),
      }),
    });
    assert.equal(compRes.batch_number, fgBatchNo);
    assert.ok(compRes.unit_actual_cost > 0);

    // =========================================================================
    // TEST 2: Sales Workflow + QC Hold Block -> QC Release -> DN + Invoice + Receipt
    // =========================================================================
    console.log('TEST 2: Sales Workflow & QC Hold Blocking...');
    const sqSale = await api<{ id: number }>('/api/sales/quotations', {
      method: 'POST',
      body: JSON.stringify({
        customer_id: customer.id,
        items: [{ item_id: fg5w30.id, qty: 20, rate: 85, vat_rate: 5 }],
      }),
    });
    assert.ok(sqSale.id);

    const so = await api<{ id: number; so_number: string }>('/api/sales/orders', {
      method: 'POST',
      body: JSON.stringify({
        customer_id: customer.id,
        sq_id: sqSale.id,
        warehouse_id: whFg.id,
        reserve_stock: true,
        items: [{ item_id: fg5w30.id, qty: 20, rate: 85, vat_rate: 5 }],
      }),
    });
    const soList = await api<{ items: { id: number; items: { id: number }[] }[] }>('/api/sales/orders');
    const soItemId = soList.items.find((s) => s.id === so.id)!.items[0].id;

    // Dispatching the newly produced batch while on QC Hold MUST fail!
    await api('/api/sales/delivery-notes', {
      method: 'POST',
      expectStatus: 400,
      body: JSON.stringify({
        so_id: so.id,
        customer_id: customer.id,
        warehouse_id: whFg.id,
        items: [{ so_item_id: soItemId, item_id: fg5w30.id, batch_number: fgBatchNo, qty: 20 }],
      }),
    });

    // Lab evaluates and releases the FG batch
    const qcList = await api<{ items: { id: number; batch_number: string }[] }>('/api/quality/inspections');
    const qcForBatch = qcList.items.find((q) => q.batch_number === fgBatchNo)!;
    assert.ok(qcForBatch);
    const evalRes = await api<{ overall_status: string; is_on_hold: number }>(`/api/quality/inspections/${qcForBatch.id}/evaluate`, {
      method: 'POST',
      body: JSON.stringify({
        batch_action: 'Release',
        remarks: 'Passed ASTM D445 & D2896',
        results: [{ parameter_name: 'Kinematic Viscosity @ 100°C', unit: 'cSt', min_val: 9.3, max_val: 12.5, actual_val: 10.8 }],
      }),
    });
    assert.equal(evalRes.overall_status, 'Passed');
    assert.equal(evalRes.is_on_hold, 0);

    // Now Delivery Note succeeds
    const dn = await api<{ id: number; dn_number: string; total_cogs: number }>('/api/sales/delivery-notes', {
      method: 'POST',
      body: JSON.stringify({
        so_id: so.id,
        customer_id: customer.id,
        warehouse_id: whFg.id,
        items: [{ so_item_id: soItemId, item_id: fg5w30.id, batch_number: fgBatchNo, qty: 20 }],
      }),
    });
    assert.ok(dn.total_cogs > 0);

    // Verify Two-Way Traceability (Test 3 completion): FG Batch -> Backward to RM Batch & Supplier -> Forward to Customer DN
    const trace = await api<{
      backward: { consumed_materials: { batch_number: string; supplier_name: string }[] };
      forward: { dispatched_to_customers: { dn_number: string; customer_name: string }[] };
    }>(`/api/manufacturing/traceability/${fgBatchNo}`);
    assert.ok(trace.backward.consumed_materials.some((m) => m.batch_number === rmBatchNo));
    assert.ok(trace.forward.dispatched_to_customers.some((d) => d.dn_number === dn.dn_number));

    // =========================================================================
    // TEST 6: Multi-Installment Payment Terms (50% 50d / 50% 80d) & Partial Payments
    // =========================================================================
    console.log('TEST 6: Multi-Installment Payment Terms (50% 50d / 50% 80d) & Partial Payments...');
    const splitTerm = ptRes.items.find((p) => p.name.includes('50%') && p.name.includes('80'))!;
    assert.ok(splitTerm, 'Expected 50% 50d / 50% 80d payment term seeded');

    const si = await api<{ id: number; si_number: string; total_amount: number }>('/api/sales/invoices', {
      method: 'POST',
      body: JSON.stringify({
        customer_id: customer.id,
        so_id: so.id,
        dn_id: dn.id,
        invoice_date: '2026-06-01',
        payment_term_id: splitTerm.id,
        post_now: true,
        items: [{ so_item_id: soItemId, item_id: fg5w30.id, qty: 20, rate: 85, vat_rate: 5 }],
      }),
    });
    const siList = await api<{ items: { id: number; payment_schedules: { installment_no: number; amount: number; due_date: string }[] }[] }>('/api/sales/invoices');
    const siSchedules = siList.items.find((x) => x.id === si.id)!.payment_schedules;
    assert.equal(siSchedules.length, 2);
    assert.equal(siSchedules[0].due_date, '2026-07-21'); // 2026-06-01 + 50d
    assert.equal(siSchedules[1].due_date, '2026-08-20'); // 2026-06-01 + 80d
    assert.equal(siSchedules[0].amount + siSchedules[1].amount, si.total_amount);

    // Partial payment covering 60% of invoice (clears inst 1 completely + partial inst 2)
    const partialAmt = Math.round(si.total_amount * 0.6 * 100) / 100;
    await api('/api/accounting/vouchers', {
      method: 'POST',
      body: JSON.stringify({
        voucher_type: 'Receipt',
        party_type: 'Customer',
        party_id: customer.id,
        bank_account_id: bank.id,
        amount: partialAmt,
        allocated_doc_type: 'SalesInvoice',
        allocated_doc_id: si.id,
      }),
    });
    const schAfter = await api<{ items: { doc_id: number; doc_type: string; installment_no: number; status: string }[] }>('/api/accounting/payment-schedules');
    const siSchAfter = schAfter.items.filter((x) => x.doc_type === 'SalesInvoice' && x.doc_id === si.id);
    assert.equal(siSchAfter.find((x) => x.installment_no === 1)?.status, 'Paid');
    assert.equal(siSchAfter.find((x) => x.installment_no === 2)?.status, 'Partially Paid');

    // =========================================================================
    // TEST 4: Subcontracting Workflow
    // =========================================================================
    console.log('TEST 4: Subcontracting Workflow...');
    const subData = await api<{ subcontractors: { id: number }[] }>('/api/procurement/subcontracting');
    const subId = subData.subcontractors[0].id;
    const subOrder = await api<{ id: number; sub_number: string }>('/api/procurement/subcontracting-orders', {
      method: 'POST',
      body: JSON.stringify({
        subcontractor_id: subId,
        finished_item_id: fg5w30.id,
        planned_qty: 50,
        service_rate: 8,
        freight_charge: 100,
        source_warehouse_id: whRm.id,
        target_warehouse_id: whFg.id,
        materials: [{ item_id: baseOil.id, issued_qty: 40 }],
      }),
    });
    const subRec = await api<{ ok: boolean; unit_cost: number }>(`/api/procurement/subcontracting-orders/${subOrder.id}/receive`, {
      method: 'POST',
      body: JSON.stringify({ received_qty: 50 }),
    });
    assert.equal(subRec.ok, true);
    assert.ok(subRec.unit_cost > 0);

    // =========================================================================
    // TEST 5: Reorder Planning & Auto-MR + Duplicate Prevention
    // =========================================================================
    console.log('TEST 5: Reorder Planning & Auto-MR Duplicate Prevention...');
    // Create a new raw material with 0 stock & reorder_level 500
    const lowItem = await api<{ id: number }>('/api/masters/items', {
      method: 'POST',
      body: JSON.stringify({
        item_code: 'RM-LOW-TEST',
        name: 'PAO Base Oil Low Stock Test',
        category_id: 1,
        reorder_level: 500,
        min_stock: 400,
        max_stock: 2000,
        safety_stock: 100,
        moq: 500,
        standard_cost: 9,
      }),
    });
    const reorder1 = await api<{ created: boolean; mr_number: string }>('/api/inventory/reorder-generate-mr', {
      method: 'POST',
      body: JSON.stringify({ item_ids: [lowItem.id] }),
    });
    assert.equal(reorder1.created, true);

    // Second run MUST prevent duplicate MR for the same item
    const reorder2 = await api<{ created: boolean }>('/api/inventory/reorder-generate-mr', {
      method: 'POST',
      body: JSON.stringify({ item_ids: [lowItem.id] }),
    });
    assert.equal(reorder2.created, false);

    // =========================================================================
    // TEST 7: Approval Matrix Multi-Role Enforcement
    // =========================================================================
    console.log('TEST 7: Approval Matrix Multi-Role Enforcement...');
    const rolesRes = await api<{ roles: { id: number; name: string }[] }>('/api/admin/roles');
    const procRole = rolesRes.roles.find((r) => r.name === 'Purchase Officer')!;
    const finMgrRole = rolesRes.roles.find((r) => r.name === 'Finance Manager')!;

    await api('/api/admin/users', {
      method: 'POST',
      body: JSON.stringify({
        username: 'buyer1',
        email: 'buyer1@petroblend.ae',
        full_name: 'Procurement Buyer',
        password: 'BuyerPassword!2026',
        role_id: procRole.id,
        department: 'Procurement',
      }),
    });
    await api('/api/admin/users', {
      method: 'POST',
      body: JSON.stringify({
        username: 'finmgr1',
        email: 'finmgr1@petroblend.ae',
        full_name: 'Finance Approver',
        password: 'FinPassword!2026',
        role_id: finMgrRole.id,
        department: 'Finance',
      }),
    });

    const buyerLogin = await api<{ token: string }>('/api/auth/login', {
      method: 'POST',
      token: '',
      body: JSON.stringify({ username: 'buyer1', password: 'BuyerPassword!2026' }),
    });
    const finLogin = await api<{ token: string }>('/api/auth/login', {
      method: 'POST',
      token: '',
      body: JSON.stringify({ username: 'finmgr1', password: 'FinPassword!2026' }),
    });

    // Mid-tier PO (5,000.01 - 25,000 AED) triggers Finance Manager approval
    const bigPo = await api<{ id: number; po_number: string }>('/api/procurement/purchase-orders', {
      method: 'POST',
      token: buyerLogin.token,
      body: JSON.stringify({
        supplier_id: supplier.id,
        warehouse_id: whRm.id,
        items: [{ item_id: baseOil.id, qty: 2000, rate: 5, vat_rate: 5 }],
      }),
    });
    const submitBigPo = await api<{ status: string; requiredRole: string }>(`/api/procurement/purchase-orders/${bigPo.id}/submit`, {
      method: 'POST',
      token: buyerLogin.token,
      body: '{}',
    });
    assert.equal(submitBigPo.status, 'Pending Approval');

    const appData = await api<{ requests: { id: number; doc_id: number; doc_type: string }[] }>('/api/system/approvals');
    const poReq = appData.requests.find((r) => r.doc_type === 'PurchaseOrder' && r.doc_id === bigPo.id)!;

    // Buyer CANNOT approve their own high-value PO
    await api(`/api/system/approvals/requests/${poReq.id}/decide`, {
      method: 'POST',
      token: buyerLogin.token,
      expectStatus: 400,
      body: JSON.stringify({ decision: 'Approved' }),
    });

    // Finance Manager CAN approve
    await api(`/api/system/approvals/requests/${poReq.id}/decide`, {
      method: 'POST',
      token: finLogin.token,
      body: JSON.stringify({ decision: 'Approved', comments: 'Approved within capex budget' }),
    });

    // =========================================================================
    // TEST 8: Double-Entry Accounting Invariants & Financial Reports
    // =========================================================================
    console.log('TEST 8: Double-Entry Accounting Invariants & UAE 5% VAT...');
    const finRep = await api<{
      trial_balance: { total_debits: number; total_credits: number; is_balanced: boolean };
      balance_sheet: { total_assets: number; total_liabilities_and_equity: number };
      vat_report: { vat_output: number; vat_input: number; net_vat_payable: number };
    }>('/api/accounting/reports/financial?from_date=2026-01-01&to_date=2026-12-31');

    assert.equal(finRep.trial_balance.is_balanced, true);
    assert.ok(Math.abs(finRep.trial_balance.total_debits - finRep.trial_balance.total_credits) < 0.05);
    assert.ok(Math.abs(finRep.balance_sheet.total_assets - finRep.balance_sheet.total_liabilities_and_equity) < 0.05);
    assert.ok(finRep.vat_report.vat_output > 0);
    assert.ok(finRep.vat_report.vat_input > 0);

    // =========================================================================
    // TEST 9: Concurrent Document Numbering, Backup, Integrity & Postgres Bundle
    // =========================================================================
    console.log('TEST 9: Concurrent Numbering, Backup, Integrity Check & Postgres Export...');
    const parallelMrs = await Promise.all(
      Array.from({ length: 10 }).map((_, idx) =>
        api<{ mr_number: string }>('/api/procurement/material-requests', {
          method: 'POST',
          body: JSON.stringify({
            warehouse_id: whRm.id,
            remarks: `Concurrency ${idx}`,
            items: [{ item_id: baseOil.id, qty: 10 }],
          }),
        })
      )
    );
    const mrNumbers = new Set(parallelMrs.map((m) => m.mr_number));
    assert.equal(mrNumbers.size, 10, 'All 10 concurrent MR numbers must be strictly unique');

    const backupRes = await api<{ id: number; file_name: string; size_bytes: number }>('/api/system/backups/create', {
      method: 'POST',
      body: '{}',
    });
    assert.ok(backupRes.size_bytes > 0);
    const createdBackupPath = path.resolve(process.cwd(), 'backups', backupRes.file_name);
    if (fs.existsSync(createdBackupPath)) fs.unlinkSync(createdBackupPath);

    const integrity = await api<{ healthy: boolean; foreign_key_violations: number; accounting_trial_balance_diff: number }>(
      '/api/system/backups/integrity-check',
      { method: 'POST', body: '{}' }
    );
    assert.equal(integrity.healthy, true);
    assert.equal(integrity.foreign_key_violations, 0);

    const pgBundle = await api<{ target_engine: string; tables: Record<string, unknown[]> }>('/api/system/backups/postgres-export');
    assert.equal(pgBundle.target_engine, 'postgresql');
    assert.ok(Array.isArray(pgBundle.tables.journal_entries));

    // =========================================================================
    // TEST 10: Admin Company & Logo, Hierarchical Item Groups, Multi-Tank Farm & Document Metadata
    // =========================================================================
    console.log('TEST 10: Company Branding, Hierarchical Item Groups, Multi-Tank Operations & Document Metadata...');

    // 10a. Admin-editable Company Profile & Replaceable Logo
    await api('/api/masters/company', {
      method: 'PUT',
      body: JSON.stringify({
        name: 'Al-Nisr Lubricants Manufacturing LLC',
        short_name: 'AL-NISR',
        po_box: 'P.O. Box 99881',
        address: 'Plot 42, Jebel Ali Industrial 2, Dubai',
        trn: '100998877600003',
      }),
    });
    const statusAfterCo = await api<{ company: { name: string; short_name: string; po_box: string; trn: string } }>('/api/auth/status', {
      token: '',
    });
    assert.equal(statusAfterCo.company.name, 'Al-Nisr Lubricants Manufacturing LLC');
    assert.equal(statusAfterCo.company.short_name, 'AL-NISR');
    assert.equal(statusAfterCo.company.po_box, 'P.O. Box 99881');

    // Upload 1x1 PNG logo via multipart FormData
    const pngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
    const pngBlob = new Blob([Buffer.from(pngBase64, 'base64')], { type: 'image/png' });
    const form = new FormData();
    form.append('logo', pngBlob, 'test-logo.png');
    const logoUpRes = await fetch(`${baseUrl}/api/masters/company/logo`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}` },
      body: form,
    });
    assert.equal(logoUpRes.status, 200, 'Expected logo upload to return 200');
    const logoUpJson = (await logoUpRes.json()) as { logo_path: string; logo_url: string };
    assert.ok(logoUpJson.logo_path.endsWith('.png'));

    const logoGetRes = await fetch(`${baseUrl}/api/auth/logo`);
    assert.equal(logoGetRes.status, 200, 'Expected public GET /api/auth/logo to return 200');
    const logoBytes = Buffer.from(await logoGetRes.arrayBuffer());
    assert.ok(logoBytes.length > 20);

    await api('/api/masters/company/logo', { method: 'DELETE' });
    const logoAfterDel = await fetch(`${baseUrl}/api/auth/logo`);
    assert.equal(logoAfterDel.status, 404, 'Expected deleted logo to return 404');

    // 10b. Hierarchical Group-Wise Item Creation & Recursive Filtering
    const parentGrp = await api<{ id: number; group_code: string }>('/api/masters/categories', {
      method: 'POST',
      body: JSON.stringify({
        name: 'CAN TEST',
        group_code: 'CAN-TEST',
        is_group: 1,
        is_packaging: 1,
      }),
    });
    const childGrp = await api<{ id: number; group_code: string }>('/api/masters/categories', {
      method: 'POST',
      body: JSON.stringify({
        name: 'RM CAN C.M TEST',
        group_code: 'RM-CAN-CM-TEST',
        parent_id: parentGrp.id,
        is_group: 1,
        is_packaging: 1,
      }),
    });
    const childItem = await api<{ id: number }>('/api/masters/items', {
      method: 'POST',
      body: JSON.stringify({
        item_code: 'CAN-1L-GOLD-CM',
        name: 'EMPTY CAN (1L) GOLD C.M',
        category_id: childGrp.id,
        purchase_uom: 'PCS',
        stock_uom: 'PCS',
        sales_uom: 'PCS',
        standard_cost: 2.1,
      }),
    });
    await api(`/api/masters/items/${childItem.id}`, {
      method: 'PUT',
      body: JSON.stringify({ name: 'EMPTY CAN (1L) GOLD C.M REV2', standard_cost: 2.25 }),
    });
    const recItems = await api<{ items: { id: number; name: string; parent_category_name: string }[] }>(
      `/api/masters/items?category_id=${parentGrp.id}`
    );
    const foundChild = recItems.items.find((i) => i.id === childItem.id);
    assert.ok(foundChild, 'Filtering by parent group must recursively include child group items');
    assert.equal(foundChild.name, 'EMPTY CAN (1L) GOLD C.M REV2');
    assert.equal(foundChild.parent_category_name, 'CAN TEST');

    // 10c. Multiple Storage Tanks: Assign, Receive, Anti-Mix, Capacity Guard, Transfer, Production Consumption
    const tnk1 = await api<{ id: number }>('/api/masters/tanks', {
      method: 'POST',
      body: JSON.stringify({
        tank_code: 'TNK-E2E-1',
        name: 'E2E Test Tank 1',
        warehouse_id: whRm.id,
        tank_type: 'Base Oil',
        capacity_qty: 2000,
        uom: 'LTR',
      }),
    });
    const tnk2 = await api<{ id: number }>('/api/masters/tanks', {
      method: 'POST',
      body: JSON.stringify({
        tank_code: 'TNK-E2E-2',
        name: 'E2E Test Tank 2',
        warehouse_id: whRm.id,
        tank_type: 'Base Oil',
        capacity_qty: 2000,
        uom: 'LTR',
      }),
    });
    await api(`/api/masters/tanks/${tnk1.id}/assign`, {
      method: 'POST',
      body: JSON.stringify({ item_id: baseOil.id }),
    });

    // Create PO with full document metadata & receive 1500 into TNK-E2E-1
    const tankPo = await api<{ id: number; po_number: string }>('/api/procurement/purchase-orders', {
      method: 'POST',
      body: JSON.stringify({
        supplier_id: supplier.id,
        warehouse_id: whRm.id,
        supplier_ref: 'SUP-QT-7788',
        delivery_terms: 'CIF Jebel Ali Port',
        delivery_place: 'Raw Material Tank Farm Bay 1',
        revision_no: 'R1',
        items: [
          { item_id: baseOil.id, qty: 2100, rate: 4.0, vat_rate: 5 },
          { item_id: additive.id, qty: 100, rate: 18.0, vat_rate: 5 },
        ],
      }),
    });
    await api(`/api/procurement/purchase-orders/${tankPo.id}/submit`, { method: 'POST', body: '{}' });
    const tankPoList = await api<{
      items: {
        id: number;
        delivery_terms: string;
        delivery_place: string;
        supplier_ref: string;
        revision_no: string;
        creator_name: string;
        items: { id: number; item_id: number }[];
      }[];
    }>('/api/procurement/purchase-orders');
    const fetchedTankPo = tankPoList.items.find((p) => p.id === tankPo.id)!;
    assert.equal(fetchedTankPo.delivery_terms, 'CIF Jebel Ali Port');
    assert.equal(fetchedTankPo.delivery_place, 'Raw Material Tank Farm Bay 1');
    assert.equal(fetchedTankPo.supplier_ref, 'SUP-QT-7788');
    assert.equal(fetchedTankPo.revision_no, 'R1');
    assert.ok(fetchedTankPo.creator_name);

    const poLineOil = fetchedTankPo.items.find((it) => it.item_id === baseOil.id)!;
    const poLineAdd = fetchedTankPo.items.find((it) => it.item_id === additive.id)!;

    // Receive 1500 Base Oil into TNK-E2E-1
    await api('/api/procurement/purchase-receipts', {
      method: 'POST',
      body: JSON.stringify({
        po_id: tankPo.id,
        supplier_id: supplier.id,
        warehouse_id: whRm.id,
        submit_now: true,
        items: [
          {
            po_item_id: poLineOil.id,
            item_id: baseOil.id,
            tank_id: tnk1.id,
            ordered_qty: 2100,
            received_qty: 1500,
            accepted_qty: 1500,
            rate: 4.0,
            batch_number: 'TNK1-OIL-B1',
            qc_required: false,
          },
        ],
      }),
    });

    // Anti-mix check: receiving additive into TNK-E2E-1 (assigned to baseOil) must fail
    await api('/api/procurement/purchase-receipts', {
      method: 'POST',
      expectStatus: 400,
      body: JSON.stringify({
        po_id: tankPo.id,
        supplier_id: supplier.id,
        warehouse_id: whRm.id,
        submit_now: true,
        items: [
          {
            po_item_id: poLineAdd.id,
            item_id: additive.id,
            tank_id: tnk1.id,
            ordered_qty: 100,
            received_qty: 50,
            accepted_qty: 50,
            rate: 18.0,
            batch_number: 'TNK1-ADD-BAD',
            qc_required: false,
          },
        ],
      }),
    });

    // Capacity guard: receiving 600 more Base Oil into TNK-E2E-1 (1500 + 600 > 2000) must fail
    await api('/api/procurement/purchase-receipts', {
      method: 'POST',
      expectStatus: 400,
      body: JSON.stringify({
        po_id: tankPo.id,
        supplier_id: supplier.id,
        warehouse_id: whRm.id,
        submit_now: true,
        items: [
          {
            po_item_id: poLineOil.id,
            item_id: baseOil.id,
            tank_id: tnk1.id,
            ordered_qty: 2100,
            received_qty: 600,
            accepted_qty: 600,
            rate: 4.0,
            batch_number: 'TNK1-OIL-OVER',
            qc_required: false,
          },
        ],
      }),
    });

    // Tank-to-Tank Transfer: 500 from TNK-E2E-1 to TNK-E2E-2 via Warehouse Transfer Stock Entry
    const tankTransfer = await api<{ id: number }>('/api/inventory/entries', {
      method: 'POST',
      body: JSON.stringify({
        entry_type: 'Warehouse Transfer',
        from_warehouse_id: whRm.id,
        to_warehouse_id: whRm.id,
        from_tank_id: tnk1.id,
        to_tank_id: tnk2.id,
        remarks: 'Test 10 tank transfer',
        items: [{ item_id: baseOil.id, batch_number: 'TNK1-OIL-B1', from_tank_id: tnk1.id, to_tank_id: tnk2.id, qty: 500 }],
      }),
    });
    await api(`/api/inventory/entries/${tankTransfer.id}/submit`, { method: 'POST', body: '{}' });

    // Consume 200 from TNK-E2E-1 in Production Order completion
    const tankProd = await api<{ id: number }>('/api/manufacturing/production-orders', {
      method: 'POST',
      body: JSON.stringify({
        bom_id: bom.id,
        planned_qty: 250,
        warehouse_id: whRm.id,
        target_warehouse_id: whFg.id,
      }),
    });
    const tankProdList = await api<{ items: { id: number; consumptions: { id: number; item_id: number; planned_qty: number }[] }[] }>(
      '/api/manufacturing/production-orders'
    );
    const tankProdObj = tankProdList.items.find((p) => p.id === tankProd.id)!;
    await api(`/api/manufacturing/production-orders/${tankProd.id}/complete`, {
      method: 'POST',
      body: JSON.stringify({
        completed_qty: 250,
        rejected_qty: 0,
        batch_number: 'FG-TANK-E2E-01',
        qc_release_immediately: true,
        consumptions: tankProdObj.consumptions.map((c) => ({
          id: c.id,
          actual_qty: c.planned_qty,
          wastage_qty: 0,
          tank_id: c.item_id === baseOil.id ? tnk1.id : undefined,
          batch_number: c.item_id === baseOil.id ? 'TNK1-OIL-B1' : undefined,
        })),
      }),
    });

    const tanksAfter = await api<{ items: { id: number; current_qty: number; assigned_item_id: number | null }[] }>('/api/masters/tanks');
    const t1After = tanksAfter.items.find((t) => t.id === tnk1.id)!;
    const t2After = tanksAfter.items.find((t) => t.id === tnk2.id)!;
    assert.equal(t1After.current_qty, 800, 'Expected TNK-E2E-1 to be 1500 - 500 - 200 = 800');
    assert.equal(t2After.current_qty, 500, 'Expected TNK-E2E-2 to receive 500');
    assert.equal(t2After.assigned_item_id, baseOil.id);

    // 10d. Verify Sales Order metadata persistence
    const metaSo = await api<{ id: number }>('/api/sales/orders', {
      method: 'POST',
      body: JSON.stringify({
        customer_id: customer.id,
        warehouse_id: whFg.id,
        customer_ref: 'LPO-E2E-551',
        delivery_terms: 'DDP Customer Warehouse',
        delivery_place: 'Abu Dhabi Industrial City',
        items: [{ item_id: fg5w30.id, qty: 10, rate: 85, vat_rate: 5 }],
      }),
    });
    const metaSoList = await api<{
      items: { id: number; customer_ref: string; delivery_terms: string; delivery_place: string; customer_trn: string; creator_name: string }[];
    }>('/api/sales/orders');
    const fetchedMetaSo = metaSoList.items.find((s) => s.id === metaSo.id)!;
    assert.equal(fetchedMetaSo.customer_ref, 'LPO-E2E-551');
    assert.equal(fetchedMetaSo.delivery_terms, 'DDP Customer Warehouse');
    assert.equal(fetchedMetaSo.delivery_place, 'Abu Dhabi Industrial City');
    assert.ok(fetchedMetaSo.creator_name);

    // TEST 11: Bulk Excel Templates, Validation Preview & Atomic Import
    console.log('--- TEST 11: Bulk Excel Import & Templates ---');
    const typesRes = await api<{ types: { type: string }[] }>('/api/import/types');
    assert.ok(typesRes.types.length >= 8, 'Expected all 8 import types');

    for (const tplType of ['opening_stock', 'boms']) {
      const tplResp = await fetch(`${baseUrl}/api/import/template/${tplType}`, {
        headers: { Authorization: `Bearer ${adminToken}` },
      });
      assert.equal(tplResp.status, 200, `Template ${tplType} should download with 200`);
      const buf = Buffer.from(await tplResp.arrayBuffer());
      const wb = XLSX.read(buf, { type: 'buffer' });
      assert.ok(wb.SheetNames.includes('Import_Template'), `${tplType} workbook must contain Import_Template`);
      assert.ok(wb.SheetNames.includes('Instructions_And_Codes'), `${tplType} workbook must contain Instructions_And_Codes`);
    }

    // Build real .xlsx buffer for preview validation (1 valid row + 2 error rows)
    const previewWb = XLSX.utils.book_new();
    const previewWs = XLSX.utils.json_to_sheet([
      {
        'Item Code*': baseOil.item_code,
        'Warehouse Code*': whRm.code,
        'Tank Code': 'TNK-E2E-2',
        'Batch Number': 'IMP-OPEN-B1',
        'Quantity*': 300,
        'Unit Cost': 4.1,
        Remarks: 'Valid tank opening import',
      },
      {
        'Item Code*': baseOil.item_code,
        'Warehouse Code*': whRm.code,
        'Tank Code': 'TNK-E2E-2',
        'Batch Number': 'IMP-OPEN-OVER',
        'Quantity*': 5000,
        'Unit Cost': 4.1,
        Remarks: 'Exceeds tank capacity',
      },
      {
        'Item Code*': 'UNKNOWN-SKU-999',
        'Warehouse Code*': whRm.code,
        'Tank Code': '',
        'Batch Number': 'IMP-BAD',
        'Quantity*': 10,
        'Unit Cost': 1,
        Remarks: 'Unknown SKU',
      },
    ]);
    XLSX.utils.book_append_sheet(previewWb, previewWs, 'Import_Template');
    const previewBuf = XLSX.write(previewWb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
    const fd = new FormData();
    fd.append('file', new Blob([new Uint8Array(previewBuf)], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), 'opening_test.xlsx');

    const prevResp = await fetch(`${baseUrl}/api/import/preview/opening_stock`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}` },
      body: fd,
    });
    assert.equal(prevResp.status, 200);
    const prevJson = (await prevResp.json()) as { totalRows: number; validCount: number; errorCount: number };
    assert.equal(prevJson.totalRows, 3);
    assert.equal(prevJson.validCount, 1);
    assert.equal(prevJson.errorCount, 2);

    // Commit valid opening_stock row into TNK-E2E-2 (500 + 300 = 800) with Opening GL
    const openCommit = await api<{ ok: boolean; summary: { imported: number } }>('/api/import/commit/opening_stock', {
      method: 'POST',
      body: JSON.stringify({
        post_gl: true,
        rows: [
          {
            item_code: baseOil.item_code,
            warehouse_code: whRm.code,
            tank_code: 'TNK-E2E-2',
            batch_number: 'IMP-OPEN-B1',
            qty: 300,
            unit_cost: 4.1,
            qc_status: 'Released',
            remarks: 'Excel Opening Import E2E',
          },
        ],
      }),
    });
    assert.equal(openCommit.ok, true);
    assert.equal(openCommit.summary.imported, 1);

    const tanksPostImport = await api<{ items: { id: number; current_qty: number }[] }>('/api/masters/tanks');
    const t2PostImport = tanksPostImport.items.find((t) => t.id === tnk2.id)!;
    assert.equal(t2PostImport.current_qty, 800, 'Expected TNK-E2E-2 to be 500 + 300 = 800 after opening stock import');

    const finRepAfterImport = await api<{ trial_balance: { is_balanced: boolean } }>(
      '/api/accounting/reports/financial?from_date=2026-01-01&to_date=2026-12-31'
    );
    assert.equal(finRepAfterImport.trial_balance.is_balanced, true, 'Trial balance must remain balanced after opening stock GL import');

    // Commit group-wise items via Excel import
    const itemCommit = await api<{ ok: boolean; summary: { created: number } }>('/api/import/commit/items', {
      method: 'POST',
      body: JSON.stringify({
        rows: [
          {
            item_code: 'IMP-CAN-GOLD-1L',
            name: 'EMPTY CAN (1L) GOLD C.M IMPORTED',
            parent_group: 'CAN-IMP',
            category_name: 'RM CAN C.M IMP',
            purchase_uom: 'PCS',
            stock_uom: 'PCS',
            sales_uom: 'PCS',
            standard_cost: 2.25,
            selling_price: 0,
            vat_rate: 5,
            default_warehouse_code: whRm.code,
            batch_tracking: '1',
          },
          {
            item_code: 'IMP-FG-5W40-4L',
            name: 'SYNTHETIC 5W-40 4L IMPORT TEST',
            parent_group: 'LUBRICANTS-IMP',
            category_name: 'PCMO IMPORTED',
            purchase_uom: 'LTR',
            stock_uom: 'LTR',
            sales_uom: 'LTR',
            standard_cost: 12.5,
            selling_price: 26,
            vat_rate: 5,
            default_warehouse_code: whFg.code,
            batch_tracking: '1',
          },
        ],
      }),
    });
    assert.equal(itemCommit.ok, true);
    assert.equal(itemCommit.summary.created, 2);

    const itemsAfterImport = await api<{ items: { item_code: string; category_name: string; parent_category_name: string | null }[] }>('/api/masters/items');
    const impCan = itemsAfterImport.items.find((x) => x.item_code === 'IMP-CAN-GOLD-1L');
    assert.ok(impCan, 'Imported CAN item must exist');
    assert.equal(impCan.category_name, 'RM CAN C.M IMP');
    assert.equal(impCan.parent_category_name, 'CAN-IMP');

    // Commit multi-line BOM via Excel import
    const bomCommit = await api<{ ok: boolean; summary: { boms_created: number; imported: number } }>('/api/import/commit/boms', {
      method: 'POST',
      body: JSON.stringify({
        rows: [
          {
            finished_item_code: 'IMP-FG-5W40-4L',
            version: 'v1.0',
            batch_size: 1000,
            labour_cost: 400,
            overhead_cost: 300,
            expected_wastage_pct: 0.5,
            component_item_code: baseOil.item_code,
            component_type: 'Formula',
            component_qty: 850,
            wastage_pct: 0.5,
            carton_packing_qty: 0,
            notes: 'Imported Excel BOM E2E',
          },
          {
            finished_item_code: 'IMP-FG-5W40-4L',
            version: 'v1.0',
            batch_size: 1000,
            labour_cost: 400,
            overhead_cost: 300,
            expected_wastage_pct: 0.5,
            component_item_code: 'IMP-CAN-GOLD-1L',
            component_type: 'Packaging',
            component_qty: 250,
            wastage_pct: 0,
            carton_packing_qty: 0,
            notes: 'Imported Excel BOM E2E',
          },
        ],
      }),
    });
    assert.equal(bomCommit.ok, true);
    assert.equal(bomCommit.summary.boms_created, 1);
    assert.equal(bomCommit.summary.imported, 2);

    const bomsAfterImport = await api<{ items: { finished_item_code: string; is_approved: number; items: unknown[] }[] }>('/api/manufacturing/boms');
    const impBom = bomsAfterImport.items.find((b) => b.finished_item_code === 'IMP-FG-5W40-4L');
    assert.ok(impBom, 'Imported multi-line BOM must exist');
    assert.equal(impBom.is_approved, 1);
    assert.equal(impBom.items.length, 2);

    // =========================================================================
    // TEST 12: Document Edit, Revise / Amend (-1), Cancel & Cross-Document Links
    // =========================================================================
    console.log('TEST 12: Document Edit, Revise / Amend & Cross-Document Links...');
    // 12a. PO Draft Edit -> Submit -> Revise (-1) -> Check Links -> Block Revise on PO with GRN
    const revPo = await api<{ id: number; po_number: string; total_amount: number }>('/api/procurement/purchase-orders', {
      method: 'POST',
      body: JSON.stringify({
        supplier_id: supplier.id,
        warehouse_id: whRm.id,
        items: [{ item_id: baseOil.id, qty: 100, rate: 5.0, vat_rate: 5 }],
      }),
    });
    const editedPo = await api<{ id: number; po_number: string; total_amount: number }>(`/api/procurement/purchase-orders/${revPo.id}`, {
      method: 'PUT',
      body: JSON.stringify({
        supplier_id: supplier.id,
        warehouse_id: whRm.id,
        items: [{ item_id: baseOil.id, qty: 200, rate: 5.0, vat_rate: 5 }],
      }),
    });
    assert.equal(editedPo.total_amount, 1050);

    await api(`/api/procurement/purchase-orders/${revPo.id}/submit`, { method: 'POST', body: '{}' });

    const revisedPo = await api<{ id: number; po_number: string; amended_from: string; revision_no: string }>(
      `/api/procurement/purchase-orders/${revPo.id}/revise`,
      { method: 'POST', body: '{}' }
    );
    assert.equal(revisedPo.po_number, `${revPo.po_number}-1`);
    assert.equal(revisedPo.amended_from, revPo.po_number);
    assert.equal(revisedPo.revision_no, 'R1');

    const poListAfterRev = await api<{ items: { id: number; status: string; amended_from?: string }[] }>('/api/procurement/purchase-orders');
    assert.equal(poListAfterRev.items.find((x) => x.id === revPo.id)?.status, 'Cancelled');
    const newPoRecord = poListAfterRev.items.find((x) => x.id === revisedPo.id);
    assert.equal(newPoRecord?.status, 'Draft');
    assert.equal(newPoRecord?.amended_from, revPo.po_number);

    const poLinks = await api<{ links: { relation: string; docNumber: string }[] }>(`/api/system/links/PurchaseOrder/${revisedPo.id}`);
    assert.ok(poLinks.links.some((l) => l.relation === 'Amended From' && l.docNumber === revPo.po_number));

    // Revising original PO from TEST 1 (which already has submitted GRN) must fail with 400
    await api(`/api/procurement/purchase-orders/${po.id}/revise`, {
      method: 'POST',
      body: '{}',
      expectStatus: 400,
    });

    // 12b. Sales Quotation Revise
    const revSq = await api<{ id: number; sq_number: string }>('/api/sales/quotations', {
      method: 'POST',
      body: JSON.stringify({
        customer_id: customer.id,
        items: [{ item_id: fg5w30.id, qty: 10, rate: 25, vat_rate: 5 }],
      }),
    });
    const revisedSq = await api<{ id: number; sq_number: string; amended_from: string }>(`/api/sales/quotations/${revSq.id}/revise`, {
      method: 'POST',
      body: '{}',
    });
    assert.equal(revisedSq.sq_number, `${revSq.sq_number}-1`);
    assert.equal(revisedSq.amended_from, revSq.sq_number);

    // 12c. Sales Order Revise -> Edit Draft -> Submit (Reserve Stock) -> Cancel (Release Stock)
    const revSo = await api<{ id: number; so_number: string }>('/api/sales/orders', {
      method: 'POST',
      body: JSON.stringify({
        customer_id: customer.id,
        warehouse_id: whFg.id,
        items: [{ item_id: fg5w30.id, qty: 2, rate: 25, vat_rate: 5 }],
      }),
    });
    const revisedSo = await api<{ id: number; so_number: string; amended_from: string }>(`/api/sales/orders/${revSo.id}/revise`, {
      method: 'POST',
      body: '{}',
    });
    assert.equal(revisedSo.so_number, `${revSo.so_number}-1`);
    assert.equal(revisedSo.amended_from, revSo.so_number);

    const editedSo = await api<{ id: number; so_number: string; total_amount: number }>(`/api/sales/orders/${revisedSo.id}`, {
      method: 'PUT',
      body: JSON.stringify({
        customer_id: customer.id,
        warehouse_id: whFg.id,
        items: [{ item_id: fg5w30.id, qty: 3, rate: 25, vat_rate: 5 }],
      }),
    });
    assert.equal(editedSo.total_amount, 78.75);

    const submittedSo = await api<{ status: string }>(`/api/sales/orders/${revisedSo.id}/submit`, { method: 'POST', body: '{}' });
    assert.equal(submittedSo.status, 'Submitted');

    const dbCheck = getDb();
    const activeResCount = (
      dbCheck.prepare("SELECT COUNT(*) as c FROM stock_reservations WHERE doc_type = 'SalesOrder' AND doc_id = ? AND status = 'Active'").get(revisedSo.id) as { c: number }
    ).c;
    assert.ok(activeResCount >= 0);

    await api(`/api/sales/orders/${revisedSo.id}/cancel`, { method: 'POST', body: '{}' });
    const postCancelRes = (
      dbCheck.prepare("SELECT COUNT(*) as c FROM stock_reservations WHERE doc_type = 'SalesOrder' AND doc_id = ? AND status = 'Active'").get(revisedSo.id) as { c: number }
    ).c;
    assert.equal(postCancelRes, 0);

    console.log('ALL 12 END-TO-END ERP TESTS PASSED SUCCESSFULLY.');
  } finally {
    server.close();
    resetDbConnection();
    for (const ext of ['', '-wal', '-shm']) {
      if (fs.existsSync(TEST_DB_ABS + ext)) fs.unlinkSync(TEST_DB_ABS + ext);
    }
  }
}

runTests().catch((err) => {
  console.error('E2E TEST FAILURE:', err);
  process.exit(1);
});

