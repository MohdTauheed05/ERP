import path from 'path';

export function roundMoney(value: number): number {
  return Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;
}

export function roundQty(value: number): number {
  return Math.round((Number(value || 0) + Number.EPSILON) * 10000) / 10000;
}

export function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

export function nowISO(): string {
  return new Date().toISOString();
}

export function addDaysISO(dateStr: string, days: number): string {
  const d = new Date(dateStr || todayISO());
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function safeResolveWithin(baseDir: string, targetName: string): string {
  const resolvedBase = path.resolve(baseDir);
  const resolvedTarget = path.resolve(resolvedBase, path.basename(targetName));
  if (!resolvedTarget.startsWith(resolvedBase + path.sep) && resolvedTarget !== resolvedBase) {
    throw new Error('Invalid file path outside allowed directory');
  }
  return resolvedTarget;
}

export function parsePagination(query: Record<string, unknown>) {
  const page = Math.max(1, Number(query.page) || 1);
  const pageSize = Math.min(200, Math.max(1, Number(query.pageSize) || 25));
  const offset = (page - 1) * pageSize;
  const search = typeof query.search === 'string' ? query.search.trim() : '';
  return { page, pageSize, offset, search };
}
