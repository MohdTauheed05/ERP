import { Router } from 'express';
import { getDb, withTransaction } from '../db.ts';
import { authenticate, recordAuditLog, requirePermission, type AuthRequest } from '../middleware/auth.ts';
import { nowISO, roundMoney, todayISO } from '../utils/helpers.ts';
import { getNextDocumentNumber } from '../services/numbering.ts';
import { postJournalEntry, reverseJournalEntry } from '../services/accounting.ts';
import { requestDocumentApproval } from '../services/approvals.ts';
import { allocatePaymentToSchedules, getOverdueDays } from '../services/paymentTerms.ts';

const router = Router();
router.use(authenticate);

// ---------------- CHART OF ACCOUNTS & BANK ACCOUNTS ----------------
router.get('/accounts', requirePermission('accounting', 'can_view'), (_req, res) => {
  const db = getDb();
  const accounts = db.prepare('SELECT * FROM chart_of_accounts ORDER BY account_code ASC').all();
  const banks = db
    .prepare('SELECT ba.*, coa.account_code FROM bank_accounts ba JOIN chart_of_accounts coa ON coa.id = ba.gl_account_id')
    .all();
  res.json({ accounts, banks });
});

router.post('/accounts', requirePermission('accounting', 'can_create'), (req, res) => {
  const { account_code, account_name, account_type, currency, is_bank, is_cash } = req.body as Record<string, unknown>;
  if (!account_code || !account_name || !account_type) {
    res.status(400).json({ error: 'Account code, name, and type are required' });
    return;
  }
  try {
    const r = getDb()
      .prepare('INSERT INTO chart_of_accounts (account_code, account_name, account_type, currency, is_bank, is_cash, balance, is_active) VALUES (?, ?, ?, ?, ?, ?, 0, 1)')
      .run(account_code, account_name, account_type, currency || 'AED', is_bank ? 1 : 0, is_cash ? 1 : 0);
    res.status(201).json({ id: r.lastInsertRowid });
  } catch (err: unknown) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Failed to create account' });
  }
});

// ---------------- JOURNAL ENTRIES ----------------
router.get('/journal-entries', requirePermission('accounting', 'can_view'), (_req, res) => {
  const db = getDb();
  const entries = db
    .prepare(
      `SELECT je.*, cr.full_name as creator_name
       FROM journal_entries je
       LEFT JOIN users cr ON cr.id = je.created_by
       ORDER BY je.id DESC LIMIT 200`
    )
    .all() as Record<string, unknown>[];
  const lines = db
    .prepare(
      `SELECT jel.*, coa.account_code, coa.account_name
       FROM journal_entry_lines jel
       JOIN chart_of_accounts coa ON coa.id = jel.account_id
       ORDER BY jel.id ASC`
    )
    .all() as { je_id: number }[];
  res.json({ items: entries.map((e) => ({ ...e, lines: lines.filter((l) => l.je_id === Number(e.id)) })) });
});

router.post('/journal-entries', requirePermission('accounting', 'can_create'), (req: AuthRequest, res) => {
  const b = req.body as {
    posting_date?: string;
    entry_type?: string;
    narration: string;
    lines: { account_id: number; debit: number; credit: number; description?: string }[];
  };
  if (!b.narration || !Array.isArray(b.lines) || b.lines.length < 2) {
    res.status(400).json({ error: 'Narration and at least 2 balanced lines are required' });
    return;
  }
  try {
    const je = withTransaction((db) =>
      postJournalEntry(db, {
        postingDate: b.posting_date || todayISO(),
        entryType: b.entry_type || 'Manual Journal',
        narration: b.narration,
        lines: b.lines.map((l) => ({ accountId: l.account_id, debit: l.debit, credit: l.credit, description: l.description })),
        userId: req.user!.id,
      })
    );
    res.status(201).json(je);
  } catch (err: unknown) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Failed to post journal entry' });
  }
});

router.post('/journal-entries/:id/reverse', requirePermission('accounting', 'can_cancel'), (req: AuthRequest, res) => {
  try {
    const rev = withTransaction((db) => reverseJournalEntry(db, Number(req.params.id), req.user!.id, req.body?.reason || 'Manual Reversal'));
    res.json(rev);
  } catch (err: unknown) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Failed to reverse journal entry' });
  }
});

// ---------------- PAYMENT & RECEIPT VOUCHERS ----------------
router.get('/vouchers', requirePermission('accounting', 'can_view'), (_req, res) => {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT pv.*, ba.account_name as bank_account_name, cr.full_name as creator_name,
              CASE WHEN pv.party_type = 'Supplier' THEN (SELECT name FROM suppliers WHERE id = pv.party_id)
                   WHEN pv.party_type = 'Customer' THEN (SELECT name FROM customers WHERE id = pv.party_id)
                   ELSE '' END as party_name,
              CASE WHEN pv.party_type = 'Supplier' THEN (SELECT trn FROM suppliers WHERE id = pv.party_id)
                   WHEN pv.party_type = 'Customer' THEN (SELECT trn FROM customers WHERE id = pv.party_id)
                   ELSE '' END as party_trn,
              CASE WHEN pv.party_type = 'Supplier' THEN (SELECT address FROM suppliers WHERE id = pv.party_id)
                   WHEN pv.party_type = 'Customer' THEN (SELECT address FROM customers WHERE id = pv.party_id)
                   ELSE '' END as party_address,
              CASE WHEN pv.party_type = 'Supplier' THEN (SELECT country FROM suppliers WHERE id = pv.party_id)
                   WHEN pv.party_type = 'Customer' THEN (SELECT country FROM customers WHERE id = pv.party_id)
                   ELSE '' END as party_country,
              CASE WHEN pv.party_type = 'Supplier' THEN (SELECT contact_person FROM suppliers WHERE id = pv.party_id)
                   WHEN pv.party_type = 'Customer' THEN (SELECT contact_person FROM customers WHERE id = pv.party_id)
                   ELSE '' END as party_contact_person
       FROM payment_vouchers pv
       LEFT JOIN bank_accounts ba ON ba.id = pv.bank_account_id
       LEFT JOIN users cr ON cr.id = pv.created_by
       ORDER BY pv.id DESC`
    )
    .all();
  res.json({ items: rows });
});

router.post('/vouchers', requirePermission('accounting', 'can_create'), (req: AuthRequest, res) => {
  const b = req.body as {
    voucher_type: 'Payment' | 'Receipt';
    payment_date?: string;
    party_type: 'Supplier' | 'Customer';
    party_id: number;
    payment_mode?: string;
    bank_account_id: number;
    cheque_number?: string;
    cheque_date?: string;
    currency?: string;
    exchange_rate?: number;
    amount: number;
    allocated_doc_type?: string;
    allocated_doc_id?: number;
    remarks?: string;
  };
  if (!b.voucher_type || !b.party_type || !b.party_id || !b.bank_account_id || !b.amount || b.amount <= 0) {
    res.status(400).json({ error: 'Voucher type, party, bank account, and positive amount are required' });
    return;
  }

  try {
    const result = withTransaction((db) => {
      const seqType = b.voucher_type === 'Payment' ? 'PV' : 'RV';
      const pvNumber = getNextDocumentNumber(db, seqType);
      const fx = b.exchange_rate || 1;
      const baseAmount = roundMoney(b.amount * fx);

      const r = db
        .prepare(
          `INSERT INTO payment_vouchers (pv_number, voucher_type, payment_date, party_type, party_id, payment_mode, bank_account_id, cheque_number, cheque_date, currency, exchange_rate, amount, base_amount, allocated_doc_type, allocated_doc_id, status, approval_status, remarks, created_by, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Draft', 'Not Submitted', ?, ?, ?)`
        )
        .run(
          pvNumber,
          b.voucher_type,
          b.payment_date || todayISO(),
          b.party_type,
          b.party_id,
          b.payment_mode || 'Bank Transfer',
          b.bank_account_id,
          b.cheque_number || '',
          b.cheque_date || '',
          b.currency || 'AED',
          fx,
          roundMoney(b.amount),
          baseAmount,
          b.allocated_doc_type || '',
          b.allocated_doc_id || null,
          b.remarks || '',
          req.user!.id,
          nowISO()
        );
      const pvId = Number(r.lastInsertRowid);

      // Post immediately or run approval check for supplier Payment Voucher
      if (b.voucher_type === 'Payment') {
        const app = requestDocumentApproval(db, {
          docType: 'PaymentVoucher',
          docId: pvId,
          docNumber: pvNumber,
          amount: baseAmount,
          currency: 'AED',
          user: req.user!,
        });
        if (app.status === 'Pending') {
          db.prepare("UPDATE payment_vouchers SET status = 'Pending Approval', approval_status = 'Pending' WHERE id = ?").run(pvId);
          return { id: pvId, pv_number: pvNumber, status: 'Pending Approval', requiredRole: app.requiredRoleName };
        }
      }

      postVoucherInternal(db, pvId, req.user!);
      return { id: pvId, pv_number: pvNumber, status: 'Posted' };
    });
    res.status(201).json(result);
  } catch (err: unknown) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Failed to create voucher' });
  }
});

export function postVoucherInternal(db: ReturnType<typeof getDb>, pvId: number, user: NonNullable<AuthRequest['user']>) {
  const pv = db.prepare('SELECT * FROM payment_vouchers WHERE id = ?').get(pvId) as
    | {
        id: number;
        pv_number: string;
        voucher_type: string;
        payment_date: string;
        party_type: string;
        party_id: number;
        bank_account_id: number;
        currency: string;
        exchange_rate: number;
        amount: number;
        base_amount: number;
        allocated_doc_type: string;
        allocated_doc_id: number | null;
        status: string;
      }
    | undefined;
  if (!pv) throw new Error('Voucher not found');
  if (pv.status === 'Posted') throw new Error('Voucher already posted');

  const bank = db.prepare('SELECT gl_account_id FROM bank_accounts WHERE id = ?').get(pv.bank_account_id) as { gl_account_id: number };
  const fx = pv.exchange_rate || 1;

  if (pv.voucher_type === 'Payment') {
    postJournalEntry(db, {
      postingDate: pv.payment_date,
      entryType: 'Payment Voucher',
      refDocType: 'PaymentVoucher',
      refDocId: pv.id,
      refDocNumber: pv.pv_number,
      narration: `Supplier Payment ${pv.pv_number}`,
      lines: [
        { accountCode: '2100', partyType: 'Supplier', partyId: pv.party_id, debit: pv.amount, currency: pv.currency, exchangeRate: fx, description: `AP Settlement (${pv.pv_number})` },
        { accountId: bank.gl_account_id, credit: pv.amount, currency: pv.currency, exchangeRate: fx, description: `Bank Payout (${pv.pv_number})` },
      ],
      userId: user.id,
    });
    db.prepare('UPDATE bank_accounts SET current_balance = ROUND(current_balance - ?, 2) WHERE id = ?').run(pv.amount, pv.bank_account_id);

    if (pv.allocated_doc_type === 'PurchaseInvoice' && pv.allocated_doc_id) {
      const pi = db.prepare('SELECT paid_amount, total_amount FROM purchase_invoices WHERE id = ?').get(pv.allocated_doc_id) as { paid_amount: number; total_amount: number };
      const newPaid = roundMoney(pi.paid_amount + pv.amount);
      const newOut = roundMoney(Math.max(0, pi.total_amount - newPaid));
      db.prepare('UPDATE purchase_invoices SET paid_amount = ?, outstanding_amount = ? WHERE id = ?').run(newPaid, newOut, pv.allocated_doc_id);
      allocatePaymentToSchedules(db, 'PurchaseInvoice', pv.allocated_doc_id, pv.amount);
    }
  } else {
    postJournalEntry(db, {
      postingDate: pv.payment_date,
      entryType: 'Receipt Voucher',
      refDocType: 'PaymentVoucher',
      refDocId: pv.id,
      refDocNumber: pv.pv_number,
      narration: `Customer Receipt ${pv.pv_number}`,
      lines: [
        { accountId: bank.gl_account_id, debit: pv.amount, currency: pv.currency, exchangeRate: fx, description: `Bank Deposit (${pv.pv_number})` },
        { accountCode: '1200', partyType: 'Customer', partyId: pv.party_id, credit: pv.amount, currency: pv.currency, exchangeRate: fx, description: `AR Settlement (${pv.pv_number})` },
      ],
      userId: user.id,
    });
    db.prepare('UPDATE bank_accounts SET current_balance = ROUND(current_balance + ?, 2) WHERE id = ?').run(pv.amount, pv.bank_account_id);

    if (pv.allocated_doc_type === 'SalesInvoice' && pv.allocated_doc_id) {
      const si = db.prepare('SELECT paid_amount, total_amount FROM sales_invoices WHERE id = ?').get(pv.allocated_doc_id) as { paid_amount: number; total_amount: number };
      const newPaid = roundMoney(si.paid_amount + pv.amount);
      const newOut = roundMoney(Math.max(0, si.total_amount - newPaid));
      db.prepare('UPDATE sales_invoices SET paid_amount = ?, outstanding_amount = ? WHERE id = ?').run(newPaid, newOut, pv.allocated_doc_id);
      allocatePaymentToSchedules(db, 'SalesInvoice', pv.allocated_doc_id, pv.amount);
    }
  }

  db.prepare("UPDATE payment_vouchers SET status = 'Posted', approval_status = 'Approved', posted_at = ? WHERE id = ?").run(nowISO(), pvId);
  recordAuditLog(db, user, 'PaymentVoucher', pvId, pv.pv_number, `Post ${pv.voucher_type} Voucher`, { amount: pv.amount });
}

// ---------------- PAYMENT SCHEDULES & OVERDUE TRACKING ----------------
router.get('/payment-schedules', requirePermission('accounting', 'can_view'), (_req, res) => {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT ps.*,
              CASE WHEN ps.party_type = 'Supplier' THEN (SELECT name FROM suppliers WHERE id = ps.party_id)
                   ELSE (SELECT name FROM customers WHERE id = ps.party_id) END as party_name
       FROM payment_schedules ps
       ORDER BY ps.due_date ASC`
    )
    .all() as Record<string, unknown>[];
  res.json({
    items: rows.map((r) => ({
      ...r,
      overdue_days: Number(r.outstanding_amount) > 0 ? getOverdueDays(String(r.due_date)) : 0,
    })),
  });
});

// ---------------- EXPENSES, FIXED ASSETS & BANK RECONCILIATION ----------------
router.get('/expenses', requirePermission('accounting', 'can_view'), (_req, res) => {
  const rows = getDb()
    .prepare('SELECT e.*, coa.account_name, ba.account_name as bank_name FROM expenses e JOIN chart_of_accounts coa ON coa.id = e.account_id LEFT JOIN bank_accounts ba ON ba.id = e.bank_account_id ORDER BY e.id DESC')
    .all();
  res.json({ items: rows });
});

router.post('/expenses', requirePermission('accounting', 'can_create'), (req: AuthRequest, res) => {
  const b = req.body as {
    expense_date?: string;
    category: string;
    account_id: number;
    bank_account_id: number;
    project_id?: number;
    amount: number;
    vat_amount?: number;
    description?: string;
  };
  if (!b.category || !b.account_id || !b.bank_account_id || !b.amount) {
    res.status(400).json({ error: 'Category, expense account, bank account, and amount are required' });
    return;
  }
  try {
    const result = withTransaction((db) => {
      const expNumber = getNextDocumentNumber(db, 'EXP');
      const vatAmt = roundMoney(b.vat_amount ?? b.amount * 0.05);
      const total = roundMoney(b.amount + vatAmt);
      const r = db
        .prepare('INSERT INTO expenses (exp_number, expense_date, category, account_id, bank_account_id, project_id, amount, vat_amount, total_amount, description, status, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, \'Posted\', ?, ?)')
        .run(expNumber, b.expense_date || todayISO(), b.category, b.account_id, b.bank_account_id, b.project_id || null, roundMoney(b.amount), vatAmt, total, b.description || '', req.user!.id, nowISO());
      const bank = db.prepare('SELECT gl_account_id FROM bank_accounts WHERE id = ?').get(b.bank_account_id) as { gl_account_id: number };
      const lines = [
        { accountId: b.account_id, debit: roundMoney(b.amount), description: `${b.category}: ${b.description || expNumber}` },
        { accountId: bank.gl_account_id, credit: total, description: `Paid via bank (${expNumber})` },
      ];
      if (vatAmt > 0) lines.splice(1, 0, { accountId: db.prepare("SELECT id FROM chart_of_accounts WHERE account_code = '1400'").get() as never as number, debit: vatAmt, description: `Input VAT (${expNumber})` } as never);
      const jeLines = [
        { accountId: b.account_id, debit: roundMoney(b.amount), description: `${b.category} (${expNumber})` },
        ...(vatAmt > 0 ? [{ accountCode: '1400', debit: vatAmt, description: `Input VAT (${expNumber})` }] : []),
        { accountId: bank.gl_account_id, credit: total, description: `Bank payout (${expNumber})` },
      ];
      postJournalEntry(db, {
        postingDate: b.expense_date || todayISO(),
        entryType: 'Expense',
        refDocType: 'Expense',
        refDocId: Number(r.lastInsertRowid),
        refDocNumber: expNumber,
        narration: `Expense ${expNumber}: ${b.category}`,
        lines: jeLines,
        userId: req.user!.id,
      });
      db.prepare('UPDATE bank_accounts SET current_balance = ROUND(current_balance - ?, 2) WHERE id = ?').run(total, b.bank_account_id);
      if (b.project_id) {
        db.prepare('UPDATE projects SET actual_cost = ROUND(actual_cost + ?, 2) WHERE id = ?').run(b.amount, b.project_id);
      }
      return { id: Number(r.lastInsertRowid), exp_number: expNumber };
    });
    res.status(201).json(result);
  } catch (err: unknown) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Failed to record expense' });
  }
});

router.get('/fixed-assets', requirePermission('assets', 'can_view'), (_req, res) => {
  const db = getDb();
  const assets = db.prepare('SELECT * FROM fixed_assets ORDER BY id DESC').all() as Record<string, unknown>[];
  const schedules = db.prepare('SELECT * FROM depreciation_schedules ORDER BY period_date ASC').all() as { asset_id: number }[];
  res.json({ items: assets.map((a) => ({ ...a, schedules: schedules.filter((s) => s.asset_id === Number(a.id)) })) });
});

router.post('/fixed-assets', requirePermission('assets', 'can_create'), (req: AuthRequest, res) => {
  const b = req.body as {
    asset_name: string;
    category: string;
    purchase_date?: string;
    purchase_cost: number;
    salvage_value?: number;
    useful_life_months?: number;
    location?: string;
    bank_account_id?: number;
  };
  if (!b.asset_name || !b.purchase_cost) {
    res.status(400).json({ error: 'Asset name and purchase cost are required' });
    return;
  }
  try {
    const result = withTransaction((db) => {
      const assetCode = getNextDocumentNumber(db, 'AST');
      const life = b.useful_life_months || 60;
      const salvage = roundMoney(b.salvage_value || 0);
      const pDate = b.purchase_date || todayISO();
      const assetGl = (db.prepare("SELECT id FROM chart_of_accounts WHERE account_code = '1500'").get() as { id: number }).id;
      const depExpGl = (db.prepare("SELECT id FROM chart_of_accounts WHERE account_code = '5700'").get() as { id: number }).id;
      const accumGl = (db.prepare("SELECT id FROM chart_of_accounts WHERE account_code = '1590'").get() as { id: number }).id;

      const r = db
        .prepare(
          `INSERT INTO fixed_assets (asset_code, asset_name, category, purchase_date, purchase_cost, salvage_value, useful_life_months, depreciation_method, accumulated_depreciation, net_book_value, location, asset_account_id, dep_expense_account_id, accum_dep_account_id, status, created_by, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'Straight Line', 0, ?, ?, ?, ?, ?, 'Active', ?, ?)`
        )
        .run(assetCode, b.asset_name, b.category || 'Plant & Machinery', pDate, roundMoney(b.purchase_cost), salvage, life, roundMoney(b.purchase_cost), b.location || 'ICAD II Plant', assetGl, depExpGl, accumGl, req.user!.id, nowISO());
      const assetId = Number(r.lastInsertRowid);

      const monthlyDep = roundMoney((b.purchase_cost - salvage) / life);
      const insSch = db.prepare('INSERT INTO depreciation_schedules (asset_id, period_date, depreciation_amount, accumulated_amount, book_value, is_posted) VALUES (?, ?, ?, ?, ?, 0)');
      for (let m = 1; m <= Math.min(12, life); m++) {
        const dt = new Date(pDate);
        dt.setUTCMonth(dt.getUTCMonth() + m);
        const accum = roundMoney(monthlyDep * m);
        insSch.run(assetId, dt.toISOString().slice(0, 10), monthlyDep, accum, roundMoney(b.purchase_cost - accum));
      }

      if (b.bank_account_id) {
        const bank = db.prepare('SELECT gl_account_id FROM bank_accounts WHERE id = ?').get(b.bank_account_id) as { gl_account_id: number };
        postJournalEntry(db, {
          postingDate: pDate,
          entryType: 'Asset Capitalization',
          refDocType: 'FixedAsset',
          refDocId: assetId,
          refDocNumber: assetCode,
          narration: `Capitalize Fixed Asset ${assetCode}: ${b.asset_name}`,
          lines: [
            { accountId: assetGl, debit: b.purchase_cost, description: `Asset ${b.asset_name}` },
            { accountId: bank.gl_account_id, credit: b.purchase_cost, description: `Bank payment for ${assetCode}` },
          ],
          userId: req.user!.id,
        });
        db.prepare('UPDATE bank_accounts SET current_balance = ROUND(current_balance - ?, 2) WHERE id = ?').run(b.purchase_cost, b.bank_account_id);
      }
      return { id: assetId, asset_code: assetCode };
    });
    res.status(201).json(result);
  } catch (err: unknown) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Failed to create fixed asset' });
  }
});

router.post('/fixed-assets/:id/depreciate', requirePermission('accounting', 'can_submit'), (req: AuthRequest, res) => {
  const assetId = Number(req.params.id);
  try {
    const result = withTransaction((db) => {
      const asset = db.prepare('SELECT * FROM fixed_assets WHERE id = ?').get(assetId) as
        | { id: number; asset_code: string; asset_name: string; accumulated_depreciation: number; net_book_value: number; asset_account_id: number; dep_expense_account_id: number; accum_dep_account_id: number }
        | undefined;
      if (!asset) throw new Error('Asset not found');
      const nextSch = db.prepare('SELECT * FROM depreciation_schedules WHERE asset_id = ? AND is_posted = 0 ORDER BY id ASC LIMIT 1').get(assetId) as
        | { id: number; period_date: string; depreciation_amount: number }
        | undefined;
      if (!nextSch) throw new Error('No unposted depreciation periods remaining');

      const je = postJournalEntry(db, {
        postingDate: todayISO(),
        entryType: 'Depreciation',
        refDocType: 'FixedAsset',
        refDocId: asset.id,
        refDocNumber: asset.asset_code,
        narration: `Depreciation for ${asset.asset_name} (${nextSch.period_date})`,
        lines: [
          { accountId: asset.dep_expense_account_id, debit: nextSch.depreciation_amount, description: `Depreciation expense (${asset.asset_code})` },
          { accountId: asset.accum_dep_account_id, credit: nextSch.depreciation_amount, description: `Accumulated depreciation (${asset.asset_code})` },
        ],
        userId: req.user!.id,
      });

      db.prepare('UPDATE depreciation_schedules SET is_posted = 1, je_id = ? WHERE id = ?').run(je.jeId, nextSch.id);
      db.prepare('UPDATE fixed_assets SET accumulated_depreciation = ROUND(accumulated_depreciation + ?, 2), net_book_value = ROUND(net_book_value - ?, 2) WHERE id = ?').run(
        nextSch.depreciation_amount,
        nextSch.depreciation_amount,
        assetId
      );
      return { ok: true, je_number: je.jeNumber, amount: nextSch.depreciation_amount };
    });
    res.json(result);
  } catch (err: unknown) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Failed to post depreciation' });
  }
});

// Bank Reconciliation
router.get('/bank-reconciliation/:bankId', requirePermission('accounting', 'can_view'), (req, res) => {
  const db = getDb();
  const bankId = Number(req.params.bankId);
  const bank = db.prepare('SELECT * FROM bank_accounts WHERE id = ?').get(bankId) as { gl_account_id: number } | undefined;
  if (!bank) {
    res.status(404).json({ error: 'Bank account not found' });
    return;
  }
  const lines = db
    .prepare(
      `SELECT jel.*, je.je_number, je.posting_date, je.narration, je.ref_doc_number
       FROM journal_entry_lines jel
       JOIN journal_entries je ON je.id = jel.je_id
       WHERE jel.account_id = ?
       ORDER BY je.posting_date DESC, jel.id DESC`
    )
    .all(bank.gl_account_id);
  res.json({ bank, lines });
});

router.post('/bank-reconciliation/toggle', requirePermission('accounting', 'can_edit'), (req, res) => {
  const { line_id, reconciled } = req.body as { line_id: number; reconciled: boolean };
  getDb().prepare('UPDATE journal_entry_lines SET reconciled = ?, reconciled_date = ? WHERE id = ?').run(reconciled ? 1 : 0, reconciled ? todayISO() : null, line_id);
  res.json({ ok: true });
});

// ---------------- FINANCIAL REPORTS ----------------
router.get('/reports/financial', requirePermission('reports', 'can_view'), (req, res) => {
  const db = getDb();
  const fromDate = String(req.query.from_date || '2026-01-01');
  const toDate = String(req.query.to_date || '2026-12-31');

  const tb = db
    .prepare(
      `SELECT coa.id, coa.account_code, coa.account_name, coa.account_type, coa.is_group,
              COALESCE(SUM(jel.debit_base), 0) as total_debit,
              COALESCE(SUM(jel.credit_base), 0) as total_credit
       FROM chart_of_accounts coa
       LEFT JOIN journal_entry_lines jel ON jel.account_id = coa.id
       LEFT JOIN journal_entries je ON je.id = jel.je_id AND je.posting_date BETWEEN ? AND ?
       WHERE coa.is_group = 0
       GROUP BY coa.id
       ORDER BY coa.account_code ASC`
    )
    .all(fromDate, toDate) as {
    id: number;
    account_code: string;
    account_name: string;
    account_type: string;
    total_debit: number;
    total_credit: number;
  }[];

  const trialBalance = tb.map((r) => ({
    ...r,
    total_debit: roundMoney(r.total_debit),
    total_credit: roundMoney(r.total_credit),
    net_balance: roundMoney(['Asset', 'Expense'].includes(r.account_type) ? r.total_debit - r.total_credit : r.total_credit - r.total_debit),
  }));

  const totalDebits = roundMoney(trialBalance.reduce((s, r) => s + r.total_debit, 0));
  const totalCredits = roundMoney(trialBalance.reduce((s, r) => s + r.total_credit, 0));

  const incomeRows = trialBalance.filter((r) => r.account_type === 'Income');
  const expenseRows = trialBalance.filter((r) => r.account_type === 'Expense');
  const totalIncome = roundMoney(incomeRows.reduce((s, r) => s + r.net_balance, 0));
  const totalExpense = roundMoney(expenseRows.reduce((s, r) => s + r.net_balance, 0));
  const netProfit = roundMoney(totalIncome - totalExpense);

  const assetRows = trialBalance.filter((r) => r.account_type === 'Asset');
  const liabilityRows = trialBalance.filter((r) => r.account_type === 'Liability');
  const equityRows = trialBalance.filter((r) => r.account_type === 'Equity');
  const totalAssets = roundMoney(assetRows.reduce((s, r) => s + r.net_balance, 0));
  const totalLiabilities = roundMoney(liabilityRows.reduce((s, r) => s + r.net_balance, 0));
  const totalEquity = roundMoney(equityRows.reduce((s, r) => s + r.net_balance, 0) + netProfit);

  // UAE 5% VAT Return Summary
  const vatOutput = roundMoney(trialBalance.find((r) => r.account_code === '2200')?.net_balance || 0);
  const vatInput = roundMoney(trialBalance.find((r) => r.account_code === '1400')?.net_balance || 0);
  const netVatPayable = roundMoney(vatOutput - vatInput);

  // Receivables & Payables Ageing
  const arInvoices = db
    .prepare(
      `SELECT si.si_number as doc_number, si.invoice_date, si.due_date, si.outstanding_amount, c.name as party_name
       FROM sales_invoices si JOIN customers c ON c.id = si.customer_id
       WHERE si.status = 'Posted' AND si.outstanding_amount > 0`
    )
    .all() as { doc_number: string; invoice_date: string; due_date: string; outstanding_amount: number; party_name: string }[];

  const apInvoices = db
    .prepare(
      `SELECT pi.pi_number as doc_number, pi.invoice_date, pi.due_date, pi.outstanding_amount, s.name as party_name
       FROM purchase_invoices pi JOIN suppliers s ON s.id = pi.supplier_id
       WHERE pi.status = 'Posted' AND pi.outstanding_amount > 0`
    )
    .all() as { doc_number: string; invoice_date: string; due_date: string; outstanding_amount: number; party_name: string }[];

  const mapAgeing = (rows: typeof arInvoices) =>
    rows.map((inv) => {
      const days = getOverdueDays(inv.due_date);
      return {
        ...inv,
        overdue_days: days,
        bucket: days === 0 ? 'Current' : days <= 30 ? '1-30 Days' : days <= 60 ? '31-60 Days' : days <= 90 ? '61-90 Days' : '90+ Days',
      };
    });

  // Cash Flow Summary (Operating, Investing, Financing from GL cash/bank lines)
  const cashFlowLines = db
    .prepare(
      `SELECT je.entry_type, SUM(jel.debit_base) as cash_in, SUM(jel.credit_base) as cash_out
       FROM journal_entry_lines jel
       JOIN journal_entries je ON je.id = jel.je_id
       JOIN chart_of_accounts coa ON coa.id = jel.account_id
       WHERE (coa.is_bank = 1 OR coa.is_cash = 1) AND je.posting_date BETWEEN ? AND ?
       GROUP BY je.entry_type`
    )
    .all(fromDate, toDate);

  res.json({
    period: { fromDate, toDate },
    trial_balance: { rows: trialBalance, total_debits: totalDebits, total_credits: totalCredits, is_balanced: Math.abs(totalDebits - totalCredits) < 0.05 },
    profit_and_loss: { income: incomeRows, expenses: expenseRows, total_income: totalIncome, total_expense: totalExpense, net_profit: netProfit },
    balance_sheet: { assets: assetRows, liabilities: liabilityRows, equity: equityRows, net_profit: netProfit, total_assets: totalAssets, total_liabilities_and_equity: roundMoney(totalLiabilities + totalEquity) },
    vat_report: { vat_output: vatOutput, vat_input: vatInput, net_vat_payable: netVatPayable },
    receivables_ageing: mapAgeing(arInvoices),
    payables_ageing: mapAgeing(apInvoices),
    cash_flow: cashFlowLines,
  });
});

router.get('/reports/party-ledger', requirePermission('reports', 'can_view'), (req, res) => {
  const db = getDb();
  const partyType = String(req.query.party_type || 'Customer');
  const partyId = Number(req.query.party_id);
  const rows = db
    .prepare(
      `SELECT je.posting_date, je.je_number, je.ref_doc_type, je.ref_doc_number, jel.debit_base, jel.credit_base, jel.description
       FROM journal_entry_lines jel
       JOIN journal_entries je ON je.id = jel.je_id
       WHERE jel.party_type = ? AND jel.party_id = ?
       ORDER BY je.posting_date ASC, jel.id ASC`
    )
    .all(partyType, partyId);
  res.json({ items: rows });
});

export default router;
