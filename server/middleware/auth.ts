Attempting to perform the InitializeDefaultDrives operation on the 'FileSystem' provider failed.
import crypto from 'crypto';
import type { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import type Database from 'better-sqlite3';
import { getDb } from '../db.ts';
import { nowISO } from '../utils/helpers.ts';

const EPHEMERAL_SECRET = crypto.randomBytes(32).toString('hex');

export function getJwtSecret(): string {
  return process.env.JWT_SECRET && process.env.JWT_SECRET.trim().length > 0
    ? process.env.JWT_SECRET
    : process.env.NODE_ENV === 'production'
      ? (() => { throw new Error('JWT_SECRET must be set in the production environment.'); })()
      : EPHEMERAL_SECRET;
}

export interface AuthUser {
  id: number;
  username: string;
  email: string;
  full_name: string;
  role_id: number;
  role_name: string;
  department: string;
}

export interface AuthRequest extends Request {
  user?: AuthUser;
}

export function signToken(user: AuthUser): string {
  return jwt.sign(
    {
      sub: user.id,
      username: user.username,
      role_id: user.role_id,
      role_name: user.role_name,
    },
    getJwtSecret(),
    { expiresIn: '12h' }
  );
}

export function authenticate(req: AuthRequest, res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }
  const token = header.slice(7).trim();
  try {
    const payload = jwt.verify(token, getJwtSecret()) as unknown as { sub: number };
    const db = getDb();
    const row = db
      .prepare(
        `SELECT u.id, u.username, u.email, u.full_name, u.role_id, r.name as role_name, u.department, u.is_active
         FROM users u
         JOIN roles r ON r.id = u.role_id
         WHERE u.id = ?`
      )
      .get(payload.sub) as (AuthUser & { is_active: number }) | undefined;

    if (!row || !row.is_active) {
      res.status(401).json({ error: 'Account inactive or invalid session' });
      return;
    }
    req.user = {
      id: row.id,
      username: row.username,
      email: row.email,
      full_name: row.full_name,
      role_id: row.role_id,
      role_name: row.role_name,
      department: row.department,
    };
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired session token' });
  }
}

export type PermissionAction =
  | 'can_view'
  | 'can_create'
  | 'can_edit'
  | 'can_delete'
  | 'can_submit'
  | 'can_cancel'
  | 'can_amend'
  | 'can_approve'
  | 'can_export'
  | 'can_print';

export function hasPermission(roleId: number, roleName: string, moduleName: string, action: PermissionAction): boolean {
  if (roleName === 'Super Admin') return true;
  const db = getDb();
  const perm = db
    .prepare(`SELECT ${action} as allowed FROM role_permissions WHERE role_id = ? AND module = ?`)
    .get(roleId, moduleName) as { allowed: number } | undefined;
  return Boolean(perm && perm.allowed === 1);
}

export function requirePermission(moduleName: string, action: PermissionAction) {
  return (req: AuthRequest, res: Response, next: NextFunction): void => {
    if (!req.user) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }
    if (!hasPermission(req.user.role_id, req.user.role_name, moduleName, action)) {
      res.status(403).json({
        error: `Access denied: ${req.user.role_name} lacks ${action.replace('can_', '')} permission on ${moduleName}`,
      });
      return;
    }
    next();
  };
}

export function recordAuditLog(
  db: Database.Database,
  user: AuthUser | undefined,
  docType: string,
  docId: number | null,
  docNumber: string,
  action: string,
  changes: unknown = {}
): void {
  db.prepare(
    `INSERT INTO audit_logs (user_id, username, doc_type, doc_id, doc_number, action, changes_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    user?.id ?? null,
    user?.username ?? 'system',
    docType,
    docId,
    docNumber,
    action,
    JSON.stringify(changes ?? {}),
    nowISO()
  );
}

export function createNotification(
  db: Database.Database,
  params: {
    userId?: number | null;
    roleId?: number | null;
    type: string;
    title: string;
    message: string;
    docType?: string;
    docId?: number | null;
  }
): void {
  db.prepare(
    `INSERT INTO notifications (user_id, role_id, type, title, message, doc_type, doc_id, is_read, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)`
  ).run(
    params.userId ?? null,
    params.roleId ?? null,
    params.type,
    params.title,
    params.message,
    params.docType ?? '',
    params.docId ?? null,
    nowISO()
  );
}
