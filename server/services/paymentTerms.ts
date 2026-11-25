import type Database from 'better-sqlite3';
import { addDaysISO, roundMoney, todayISO } from '../utils/helpers.ts';

export function generatePaymentSchedules(
  db: Database.Database,
  params: {
    partyType: 'Supplier' | 'Customer';
    partyId: number;
    docType: string;
    docId: number;
    docNumber: string;
    baseDate: string;
    totalAmount: number;
    paymentTermId?: number | null;
  }
): void {
  db.prepare('DELETE FROM payment_schedules WHERE doc_type = ? AND doc_id = ?').run(params.docType, params.docId);

  let lines: { installment_no: number; percentage: number; days_due: number; payment_mode: string }[] = [];
  if (params.paymentTermId) {
    lines = db
      .prepare('SELECT installment_no, percentage, days_due, payment_mode FROM payment_term_lines WHERE payment_term_id = ? ORDER BY installment_no ASC')
      .all(params.paymentTermId) as typeof lines;
  }

  if (lines.length === 0) {
    lines = [{ installment_no: 1, percentage: 100, days_due: 30, payment_mode: 'Bank Transfer' }];
  }

  let allocated = 0;
  const ins = db.prepare(
    `INSERT INTO payment_schedules (party_type, party_id, doc_type, doc_id, doc_number, installment_no, due_date, amount, paid_amount, outstanding_amount, payment_mode, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, 'Pending')`
  );

  lines.forEach((line, idx) => {
    const isLast = idx === lines.length - 1;
    const instAmount = isLast
      ? roundMoney(params.totalAmount - allocated)
      : roundMoney((params.totalAmount * line.percentage) / 100);
    allocated = roundMoney(allocated + instAmount);
    const dueDate = addDaysISO(params.baseDate, line.days_due);
    ins.run(
      params.partyType,
      params.partyId,
      params.docType,
      params.docId,
      params.docNumber,
      line.installment_no,
      dueDate,
      instAmount,
      instAmount,
      line.payment_mode
    );
  });
}

export function allocatePaymentToSchedules(
  db: Database.Database,
  docType: string,
  docId: number,
  paymentAmount: number
): void {
  let remaining = roundMoney(paymentAmount);
  const rows = db
    .prepare(
      `SELECT id, amount, paid_amount, outstanding_amount FROM payment_schedules
       WHERE doc_type = ? AND doc_id = ? AND outstanding_amount > 0
       ORDER BY installment_no ASC`
    )
    .all(docType, docId) as { id: number; amount: number; paid_amount: number; outstanding_amount: number }[];

  for (const row of rows) {
    if (remaining <= 0) break;
    const pay = Math.min(remaining, row.outstanding_amount);
    const newPaid = roundMoney(row.paid_amount + pay);
    const newOut = roundMoney(row.amount - newPaid);
    const status = newOut <= 0.01 ? 'Paid' : 'Partially Paid';
    db.prepare('UPDATE payment_schedules SET paid_amount = ?, outstanding_amount = ?, status = ? WHERE id = ?').run(
      newPaid,
      Math.max(0, newOut),
      status,
      row.id
    );
    remaining = roundMoney(remaining - pay);
  }
}

export function getOverdueDays(dueDate: string): number {
  const today = new Date(todayISO()).getTime();
  const due = new Date(dueDate).getTime();
  if (today <= due) return 0;
  return Math.floor((today - due) / (1000 * 60 * 60 * 24));
}
