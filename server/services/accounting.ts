import type Database from 'better-sqlite3';
import { nowISO, roundMoney, todayISO } from '../utils/helpers.ts';
import { getNextDocumentNumber } from './numbering.ts';

export interface JournalLineInput {
  accountCode?: string;
  accountId?: number;
  partyType?: string;
  partyId?: number | null;
  debit?: number;
  credit?: number;
  currency?: string;
  exchangeRate?: number;
  description?: string;
}

export function getAccountIdByCode(db: Database.Database, code: string): number {
  const row = db.prepare('SELECT id FROM chart_of_accounts WHERE account_code = ?').get(code) as { id: number } | undefined;
  if (!row) throw new Error(`Chart of Accounts missing code ${code}`);
  return row.id;
}

export function postJournalEntry(
  db: Database.Database,
  params: {
    postingDate?: string;
    entryType?: string;
    refDocType?: string;
    refDocId?: number | null;
    refDocNumber?: string;
    narration: string;
    lines: JournalLineInput[];
    userId?: number | null;
  }
): { jeId: number; jeNumber: string } {
  const postingDate = params.postingDate || todayISO();

  // Check financial period lock
  const closedPeriod = db
    .prepare('SELECT name FROM financial_periods WHERE ? BETWEEN start_date AND end_date AND is_closed = 1')
    .get(postingDate) as { name: string } | undefined;
  if (closedPeriod) {
    throw new Error(`Financial period ${closedPeriod.name} is closed. Cannot post entries for ${postingDate}.`);
  }

  let totalDebitBase = 0;
  let totalCreditBase = 0;

  const normalizedLines = params.lines
    .map((line) => {
      const accountId = line.accountId ?? getAccountIdByCode(db, line.accountCode || '');
      const fx = line.exchangeRate && line.exchangeRate > 0 ? line.exchangeRate : 1;
      const debit = roundMoney(line.debit ?? 0);
      const credit = roundMoney(line.credit ?? 0);
      const debitBase = roundMoney(debit * fx);
      const creditBase = roundMoney(credit * fx);
      totalDebitBase = roundMoney(totalDebitBase + debitBase);
      totalCreditBase = roundMoney(totalCreditBase + creditBase);
      return {
        accountId,
        partyType: line.partyType ?? '',
        partyId: line.partyId ?? null,
        debit,
        credit,
        currency: line.currency ?? 'AED',
        exchangeRate: fx,
        debitBase,
        creditBase,
        description: line.description ?? '',
      };
    })
    .filter((l) => l.debitBase > 0 || l.creditBase > 0);

  if (normalizedLines.length < 2) {
    throw new Error('Journal entry requires at least two non-zero lines');
  }

  // Handle minor FX rounding penny difference cleanly if <= 0.02
  const diff = roundMoney(totalDebitBase - totalCreditBase);
  if (Math.abs(diff) > 0.05) {
    throw new Error(`Unbalanced Journal Entry: Total Debits (${totalDebitBase}) != Total Credits (${totalCreditBase})`);
  }
  if (diff !== 0) {
    // Adjust last line by rounding penny
    const last = normalizedLines[normalizedLines.length - 1];
    if (last.creditBase > 0) {
      last.creditBase = roundMoney(last.creditBase + diff);
      totalCreditBase = totalDebitBase;
    } else {
      last.debitBase = roundMoney(last.debitBase - diff);
      totalDebitBase = totalCreditBase;
    }
  }

  const jeNumber = getNextDocumentNumber(db, 'JE');
  const jeRes = db
    .prepare(
      `INSERT INTO journal_entries (je_number, posting_date, entry_type, ref_doc_type, ref_doc_id, ref_doc_number, narration, total_debit, total_credit, status, created_by, posted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'Posted', ?, ?)`
    )
    .run(
      jeNumber,
      postingDate,
      params.entryType ?? 'Journal Entry',
      params.refDocType ?? '',
      params.refDocId ?? null,
      params.refDocNumber ?? '',
      params.narration,
      totalDebitBase,
      totalCreditBase,
      params.userId ?? null,
      nowISO()
    );

  const jeId = Number(jeRes.lastInsertRowid);
  const insLine = db.prepare(
    `INSERT INTO journal_entry_lines (je_id, account_id, party_type, party_id, debit, credit, currency, exchange_rate, debit_base, credit_base, description)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const updBalance = db.prepare('UPDATE chart_of_accounts SET balance = ROUND(balance + ?, 2) WHERE id = ?');

  for (const l of normalizedLines) {
    insLine.run(
      jeId,
      l.accountId,
      l.partyType,
      l.partyId,
      l.debit,
      l.credit,
      l.currency,
      l.exchangeRate,
      l.debitBase,
      l.creditBase,
      l.description
    );
    const acc = db.prepare('SELECT account_type FROM chart_of_accounts WHERE id = ?').get(l.accountId) as { account_type: string };
    const delta = ['Asset', 'Expense'].includes(acc.account_type)
      ? l.debitBase - l.creditBase
      : l.creditBase - l.debitBase;
    updBalance.run(delta, l.accountId);
  }

  return { jeId, jeNumber };
}

export function reverseJournalEntry(db: Database.Database, jeId: number, userId?: number | null, reason = 'Reversal'): { jeId: number; jeNumber: string } {
  const original = db.prepare('SELECT * FROM journal_entries WHERE id = ?').get(jeId) as
    | { id: number; je_number: string; ref_doc_type: string; ref_doc_id: number | null; ref_doc_number: string; narration: string; status: string }
    | undefined;
  if (!original) throw new Error('Original journal entry not found');
  if (original.status === 'Reversed') throw new Error('Journal entry is already reversed');

  const lines = db.prepare('SELECT * FROM journal_entry_lines WHERE je_id = ?').all(jeId) as {
    account_id: number;
    party_type: string;
    party_id: number | null;
    debit: number;
    credit: number;
    currency: string;
    exchange_rate: number;
    description: string;
  }[];

  const rev = postJournalEntry(db, {
    postingDate: todayISO(),
    entryType: 'Reversal',
    refDocType: original.ref_doc_type,
    refDocId: original.ref_doc_id,
    refDocNumber: original.ref_doc_number,
    narration: `${reason} of ${original.je_number}: ${original.narration}`,
    lines: lines.map((l) => ({
      accountId: l.account_id,
      partyType: l.party_type,
      partyId: l.party_id,
      debit: l.credit,
      credit: l.debit,
      currency: l.currency,
      exchangeRate: l.exchange_rate,
      description: `Reversal: ${l.description}`,
    })),
    userId,
  });

  db.prepare("UPDATE journal_entries SET status = 'Reversed', reversed_je_id = ? WHERE id = ?").run(rev.jeId, jeId);
  return rev;
}
