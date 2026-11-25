import type Database from 'better-sqlite3';

export function getNextDocumentNumber(db: Database.Database, docType: string): string {
  const seq = db
    .prepare('SELECT id, prefix, next_number, digits, financial_year, include_fy FROM document_sequences WHERE doc_type = ?')
    .get(docType) as
    | {
        id: number;
        prefix: string;
        next_number: number;
        digits: number;
        financial_year: string;
        include_fy: number;
      }
    | undefined;

  if (!seq) {
    db.prepare(
      'INSERT INTO document_sequences (doc_type, prefix, next_number, digits, financial_year, include_fy) VALUES (?, ?, 2, 4, ?, 0)'
    ).run(docType, `${docType.toUpperCase()}-`, '2026');
    return `${docType.toUpperCase()}-0001`;
  }

  const padded = String(seq.next_number).padStart(seq.digits, '0');
  const fyPart = seq.include_fy && seq.financial_year ? `${seq.financial_year}/` : '';
  const generated = `${seq.prefix}${fyPart}${padded}`;

  db.prepare('UPDATE document_sequences SET next_number = next_number + 1 WHERE id = ?').run(seq.id);
  return generated;
}
