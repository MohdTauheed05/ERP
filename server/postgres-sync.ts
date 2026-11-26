Attempting to perform the InitializeDefaultDrives operation on the 'FileSystem' provider failed.
import { Worker } from 'node:worker_threads';
// Keep worker dependencies visible to the Vercel function bundler and its file tracer.
import 'pg';
import '@google-cloud/cloud-sql-connector';
import 'google-auth-library';

const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const TOKEN_BYTES = 16 * 1024;
const tokenBuffer = new SharedArrayBuffer(8 + TOKEN_BYTES);
const tokenHeader = new Int32Array(tokenBuffer, 0, 2);
const tokenPayload = new Uint8Array(tokenBuffer, 8);

let worker: Worker | null = null;
let sequenceTables = new Set<string>();

export function setPostgresOidcToken(token: string | undefined): void {
  if (!token) return;
  const bytes = new TextEncoder().encode(token);
  if (bytes.length > TOKEN_BYTES) throw new Error('Vercel OIDC token exceeds the supported size.');
  Atomics.add(tokenHeader, 0, 1); // odd means a write is in progress
  tokenPayload.fill(0);
  tokenPayload.set(bytes);
  Atomics.store(tokenHeader, 1, bytes.length);
  Atomics.add(tokenHeader, 0, 1);
  Atomics.notify(tokenHeader, 0);
}

const workerSource = String.raw`
const { parentPort, workerData } = require('node:worker_threads');
const { createRequire } = require('node:module');
const req = createRequire(workerData.moduleUrl);
const tokenHeader = new Int32Array(workerData.tokenBuffer, 0, 2);
const tokenPayload = new Uint8Array(workerData.tokenBuffer, 8);
const textDecoder = new TextDecoder();

function readOidcToken() {
  for (;;) {
    const version = Atomics.load(tokenHeader, 0);
    if (version & 1) continue;
    const length = Atomics.load(tokenHeader, 1);
    if (!length) throw new Error('Vercel OIDC token is missing. Enable Vercel Secure Backend Access and send its x-vercel-oidc-token header.');
    const bytes = tokenPayload.slice(0, length);
    if (version === Atomics.load(tokenHeader, 0)) return textDecoder.decode(bytes);
  }
}

function translate(sql) {
  let out = '', index = 0, quote = '', lineComment = false, blockComment = false;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i], next = sql[i + 1];
    if (lineComment) { out += ch; if (ch === '\n') lineComment = false; continue; }
    if (blockComment) { out += ch; if (ch === '*' && next === '/') { out += next; i++; blockComment = false; } continue; }
    if (quote) { out += ch; if (ch === quote) { if (next === quote) { out += next; i++; } else quote = ''; } else if (ch === '\\' && quote === "'") { out += next || ''; i++; } continue; }
    if (ch === '-' && next === '-') { out += ch + next; i++; lineComment = true; continue; }
    if (ch === '/' && next === '*') { out += ch + next; i++; blockComment = true; continue; }
    if (ch === "'" || ch === '"' || ch === String.fromCharCode(96)) { quote = ch === String.fromCharCode(96) ? '"' : ch; out += quote; continue; }
    if (ch === '?') { out += '$' + (++index); continue; }
    out += ch;
  }
  return out;
}

function readToken() {
  return { getSubjectToken: async () => readOidcToken() };
}

async function connect() {
  const pg = req('pg');
  const { types } = pg;
  types.setTypeParser(20, (value) => Number(value));
  types.setTypeParser(1700, (value) => Number(value));
  let client;
  let connector;

  if (process.env.DB_ADAPTER === 'cloudsql') {
    const { Connector, AuthTypes } = req('@google-cloud/cloud-sql-connector');
    const { ExternalAccountClient } = req('google-auth-library');
    const projectNumber = process.env.GCP_PROJECT_NUMBER;
    const pool = process.env.GCP_WORKLOAD_IDENTITY_POOL_ID;
    const provider = process.env.GCP_WORKLOAD_IDENTITY_POOL_PROVIDER_ID;
    const serviceAccount = process.env.GCP_SERVICE_ACCOUNT_EMAIL;
    const connectionName = process.env.CLOUD_SQL_CONNECTION_NAME;
    if (!projectNumber || !pool || !provider || !serviceAccount || !connectionName) {
      throw new Error('Cloud SQL is not configured. Set the GCP Workload Identity and CLOUD_SQL_CONNECTION_NAME environment variables.');
    }
    const auth = ExternalAccountClient.fromJSON({
      type: 'external_account',
      audience: '//iam.googleapis.com/projects/' + projectNumber + '/locations/global/workloadIdentityPools/' + pool + '/providers/' + provider,
      subject_token_type: 'urn:ietf:params:oauth:token-type:jwt',
      token_url: 'https://sts.googleapis.com/v1/token',
      service_account_impersonation_url: 'https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/' + serviceAccount + ':generateAccessToken',
      subject_token_supplier: readToken(),
    });
    if (!auth) throw new Error('Could not initialize Google Workload Identity credentials.');
    auth.scopes = ['https://www.googleapis.com/auth/cloud-platform'];
    connector = new Connector({ auth });
    const options = await connector.getOptions({
      instanceConnectionName: connectionName,
      authType: AuthTypes.IAM,
    });
    const user = serviceAccount.endsWith('.gserviceaccount.com') ? serviceAccount.slice(0, -'.gserviceaccount.com'.length) : serviceAccount;
    client = new pg.Client({ ...options, user, database: process.env.PGDATABASE || 'postgres', application_name: 'petroblend-erp' });
  } else {
    const url = process.env.DATABASE_URL;
    if (!url || !/^postgres(ql)?:\/\//i.test(url)) throw new Error('DATABASE_URL must be a PostgreSQL URL when DB_ADAPTER=postgres.');
    client = new pg.Client({ connectionString: url, application_name: 'petroblend-erp' });
  }

  await client.connect();
  return { client, connector };
}

function readToken() {
  return { getSubjectToken: async () => {
    const auth = new Int32Array(workerData.tokenBuffer, 0, 2);
    const payload = new Uint8Array(workerData.tokenBuffer, 8);
    const decoder = new TextDecoder();
    for (;;) {
      const version = Atomics.load(auth, 0);
      if (version & 1) continue;
      const length = Atomics.load(auth, 1);
      if (!length) throw new Error('Vercel OIDC token is missing.');
      const bytes = payload.slice(0, length);
      if (version === Atomics.load(auth, 0)) return decoder.decode(bytes);
    }
  } };
}

let connection;
parentPort.on('message', async ({ sab, sql, params }) => {
  const ints = new Int32Array(sab, 0, 2);
  const bytes = new Uint8Array(sab, 8);
  try {
    connection ||= await connect();
    const values = params?.map((v) => v === undefined ? null : typeof v === 'boolean' ? Number(v) : v instanceof Uint8Array ? Buffer.from(v) : v);
    const result = await connection.client.query(values?.length ? translate(sql) : sql, values);
    const value = JSON.stringify({ ok: true, rows: result.rows || [], rowCount: result.rowCount || 0, fields: result.fields?.map((f) => f.name) || [] }, (_key, value) => value?.type === 'Buffer' && Array.isArray(value.data) ? { __pgBuffer: Buffer.from(value.data).toString('base64') } : value);
    const encoded = new TextEncoder().encode(value);
    if (encoded.length > bytes.length) throw new Error('Database response is too large for a single ERP request. Narrow the requested report or page size.');
    bytes.set(encoded);
    Atomics.store(ints, 1, encoded.length);
    Atomics.store(ints, 0, 1);
  } catch (err) {
    const value = JSON.stringify({ ok: false, error: err instanceof Error ? err.message : 'PostgreSQL request failed' });
    const encoded = new TextEncoder().encode(value);
    bytes.set(encoded.subarray(0, bytes.length));
    Atomics.store(ints, 1, Math.min(encoded.length, bytes.length));
    Atomics.store(ints, 0, 1);
  }
  Atomics.notify(ints, 0);
});

function createRequireShim() { return req; }
`;

function getWorker(): Worker {
  if (!worker) {
    worker = new Worker(workerSource, {
      eval: true,
      workerData: { moduleUrl: import.meta.url, tokenBuffer },
    });
    worker.on('error', (error) => {
      worker = null;
      console.error('PostgreSQL worker failed:', error);
    });
    worker.on('exit', (code) => {
      if (code !== 0) worker = null;
    });
  }
  return worker;
}

function query(sql: string, params: unknown[] = []): { rows: Record<string, unknown>[]; rowCount: number; fields: string[] } {
  const sab = new SharedArrayBuffer(8 + MAX_RESPONSE_BYTES);
  const ints = new Int32Array(sab, 0, 2);
  getWorker().postMessage({ sab, sql, params });
  const state = Atomics.wait(ints, 0, 0, 45_000);
  if (state === 'timed-out') throw new Error('PostgreSQL query timed out after 45 seconds.');
  const length = Atomics.load(ints, 1);
  const bytes = new Uint8Array(sab, 8, length);
  const response = JSON.parse(new TextDecoder().decode(bytes), (_key, value) => value && typeof value === 'object' && typeof value.__pgBuffer === 'string' ? Buffer.from(value.__pgBuffer, 'base64') : value) as { ok: boolean; rows?: Record<string, unknown>[]; rowCount?: number; fields?: string[]; error?: string };
  if (!response.ok) throw new Error(response.error || 'PostgreSQL request failed');
  return { rows: response.rows || [], rowCount: response.rowCount || 0, fields: response.fields || [] };
}

function normalizeSql(sql: string): string {
  const pragma = sql.match(/^\s*PRAGMA\s+table_info\s*\(\s*["'`]?([\w]+)["'`]?\s*\)\s*;?\s*$/i);
  if (pragma) return `SELECT column_name AS name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = '${pragma[1].replace(/'/g, "''")}' ORDER BY ordinal_position`;
  if (/sqlite_master/i.test(sql)) return "SELECT table_name AS name FROM information_schema.tables WHERE table_schema = current_schema() AND table_type = 'BASE TABLE' ORDER BY table_name";
  return sql.replace(/\bMAX\s*\(\s*0\s*,\s*ROUND\(([^()]*)\)\s*\)/gi, 'GREATEST(0, ROUND($1))');
}

function translateDdl(sql: string): string {
  const ddl = sql.replace(/\bINTEGER\s+PRIMARY\s+KEY\s+AUTOINCREMENT\b/gi, 'BIGSERIAL PRIMARY KEY')
    .replace(/\bINTEGER\b/gi, 'BIGINT')
    .replace(/\bREAL\b/gi, 'NUMERIC')
    .replace(/\bBLOB\b/gi, 'BYTEA');
  for (const match of sql.matchAll(/CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+["`]?([a-zA-Z0-9_]+)["`]?\s*\(([\s\S]*?)\)\s*;/gi)) {
    if (/\bid\s+INTEGER\s+PRIMARY\s+KEY\s+AUTOINCREMENT\b/i.test(match[2])) sequenceTables.add(match[1].toLowerCase());
  }
  return ddl;
}

function insertReturningId(sql: string): string {
  const match = sql.match(/^\s*INSERT\s+INTO\s+["`]?([a-zA-Z0-9_]+)["`]?/i);
  if (!match || !sequenceTables.has(match[1].toLowerCase()) || /\bRETURNING\b/i.test(sql)) return sql;
  return `${sql.trim().replace(/;$/, '')} RETURNING id`;
}

export function createPostgresSyncDatabase(): any {
  const db = {
    prepare(sql: string) {
      const source = normalizeSql(sql);
      return {
        all(...params: unknown[]) { return query(source, params).rows; },
        get(...params: unknown[]) { return query(source, params).rows[0]; },
        run(...params: unknown[]) {
          const result = query(insertReturningId(source), params);
          return { changes: result.rowCount, lastInsertRowid: Number(result.rows[0]?.id || 0) };
        },
      };
    },
    exec(sql: string) {
      query(translateDdl(sql));
      return db;
    },
    pragma(value: string) {
      if (/^\s*integrity_check\s*$/i.test(value)) return [{ integrity_check: 'ok' }];
      if (/^\s*foreign_key_check\s*$/i.test(value)) return [];
      return [];
    },
    transaction<T extends (...args: any[]) => any>(fn: T) {
      return (...args: Parameters<T>) => {
        query('BEGIN');
        try {
          const result = fn(...args);
          query('COMMIT');
          return result;
        } catch (err) {
          try { query('ROLLBACK'); } catch { /* preserve original error */ }
          throw err;
        }
      };
    },
    close() { worker?.terminate(); worker = null; },
    backup() { throw new Error('File-based backup is not supported for PostgreSQL. Use the database provider backup workflow.'); },
  };
  return db;
}
