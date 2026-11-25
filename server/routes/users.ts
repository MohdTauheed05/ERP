import bcrypt from 'bcryptjs';
import { Router } from 'express';
import { getDb, withTransaction } from '../db.ts';
import { authenticate, recordAuditLog, requirePermission, type AuthRequest } from '../middleware/auth.ts';
import { nowISO } from '../utils/helpers.ts';

const router = Router();
router.use(authenticate);

router.get('/users', requirePermission('settings', 'can_view'), (_req, res) => {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT u.id, u.username, u.email, u.full_name, u.role_id, r.name as role_name, u.department, u.is_active, u.last_login_at, u.created_at
       FROM users u
       JOIN roles r ON r.id = u.role_id
       ORDER BY u.id ASC`
    )
    .all();
  res.json({ items: rows });
});

router.post('/users', requirePermission('settings', 'can_create'), (req: AuthRequest, res) => {
  const { username, email, full_name, password, role_id, department } = req.body as {
    username?: string;
    email?: string;
    full_name?: string;
    password?: string;
    role_id?: number;
    department?: string;
  };
  if (!username || !email || !full_name || !password || !role_id) {
    res.status(400).json({ error: 'All user fields including password and role are required' });
    return;
  }
  if (password.length < 6) {
    res.status(400).json({ error: 'Password must be at least 6 characters' });
    return;
  }

  try {
    const id = withTransaction((db) => {
      const hash = bcrypt.hashSync(password, 10);
      const now = nowISO();
      const ins = db
        .prepare(
          `INSERT INTO users (username, email, full_name, password_hash, role_id, department, is_active, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`
        )
        .run(username.trim(), email.trim().toLowerCase(), full_name.trim(), hash, role_id, department || 'Operations', now, now);
      const newId = Number(ins.lastInsertRowid);
      recordAuditLog(db, req.user, 'User', newId, username.trim(), 'Create User', { role_id, department });
      return newId;
    });
    res.status(201).json({ id });
  } catch (err: unknown) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Failed to create user' });
  }
});

router.put('/users/:id', requirePermission('settings', 'can_edit'), (req: AuthRequest, res) => {
  const userId = Number(req.params.id);
  const { full_name, email, role_id, department, is_active, password } = req.body as {
    full_name?: string;
    email?: string;
    role_id?: number;
    department?: string;
    is_active?: number;
    password?: string;
  };
  try {
    withTransaction((db) => {
      const existing = db.prepare('SELECT id, username FROM users WHERE id = ?').get(userId) as { id: number; username: string } | undefined;
      if (!existing) throw new Error('User not found');

      if (password && password.trim().length > 0) {
        if (password.length < 6) throw new Error('Password must be at least 6 characters');
        const hash = bcrypt.hashSync(password, 10);
        db.prepare('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?').run(hash, nowISO(), userId);
      }
      db.prepare(
        `UPDATE users SET
          full_name = COALESCE(?, full_name),
          email = COALESCE(?, email),
          role_id = COALESCE(?, role_id),
          department = COALESCE(?, department),
          is_active = COALESCE(?, is_active),
          updated_at = ?
         WHERE id = ?`
      ).run(full_name ?? null, email?.toLowerCase() ?? null, role_id ?? null, department ?? null, is_active ?? null, nowISO(), userId);

      recordAuditLog(db, req.user, 'User', userId, existing.username, 'Update User', { role_id, is_active });
    });
    res.json({ ok: true });
  } catch (err: unknown) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Failed to update user' });
  }
});

router.get('/roles', (_req, res) => {
  const db = getDb();
  const roles = db.prepare('SELECT * FROM roles ORDER BY id ASC').all();
  const permissions = db.prepare('SELECT * FROM role_permissions').all();
  res.json({ roles, permissions });
});

router.post('/roles', requirePermission('settings', 'can_create'), (req: AuthRequest, res) => {
  const { name, description } = req.body as { name?: string; description?: string };
  if (!name) {
    res.status(400).json({ error: 'Role name is required' });
    return;
  }
  try {
    const id = withTransaction((db) => {
      const ins = db.prepare('INSERT INTO roles (name, description, is_system, is_active, created_at) VALUES (?, ?, 0, 1, ?)').run(
        name.trim(),
        description || '',
        nowISO()
      );
      const roleId = Number(ins.lastInsertRowid);
      const modules = [
        ['dashboard', 'Dashboard'],
        ['masters', 'MasterData'],
        ['procurement', 'Procurement'],
        ['inventory', 'Inventory'],
        ['manufacturing', 'Manufacturing'],
        ['quality', 'QualityControl'],
        ['subcontracting', 'Subcontracting'],
        ['sales', 'Sales'],
        ['accounting', 'Accounting'],
        ['hr', 'HR'],
        ['crm', 'CRM'],
        ['projects', 'Projects'],
        ['assets', 'FixedAssets'],
        ['reports', 'Reports'],
        ['settings', 'Settings'],
      ];
      const insPerm = db.prepare(
        `INSERT INTO role_permissions (role_id, module, doc_type, can_view, can_create, can_edit, can_delete, can_submit, can_cancel, can_amend, can_approve, can_export, can_print)
         VALUES (?, ?, ?, 1, 0, 0, 0, 0, 0, 0, 0, 1, 1)`
      );
      for (const [m, dt] of modules) insPerm.run(roleId, m, dt);
      recordAuditLog(db, req.user, 'Role', roleId, name.trim(), 'Create Custom Role', {});
      return roleId;
    });
    res.status(201).json({ id });
  } catch (err: unknown) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Failed to create role' });
  }
});

router.put('/roles/:id/permissions', requirePermission('settings', 'can_edit'), (req: AuthRequest, res) => {
  const roleId = Number(req.params.id);
  const { permissions } = req.body as {
    permissions: {
      module: string;
      can_view: number;
      can_create: number;
      can_edit: number;
      can_delete: number;
      can_submit: number;
      can_cancel: number;
      can_amend: number;
      can_approve: number;
      can_export: number;
      can_print: number;
    }[];
  };

  if (!Array.isArray(permissions)) {
    res.status(400).json({ error: 'permissions array required' });
    return;
  }

  try {
    withTransaction((db) => {
      const upd = db.prepare(
        `UPDATE role_permissions SET
          can_view = ?, can_create = ?, can_edit = ?, can_delete = ?,
          can_submit = ?, can_cancel = ?, can_amend = ?, can_approve = ?,
          can_export = ?, can_print = ?
         WHERE role_id = ? AND module = ?`
      );
      for (const p of permissions) {
        upd.run(
          p.can_view ? 1 : 0,
          p.can_create ? 1 : 0,
          p.can_edit ? 1 : 0,
          p.can_delete ? 1 : 0,
          p.can_submit ? 1 : 0,
          p.can_cancel ? 1 : 0,
          p.can_amend ? 1 : 0,
          p.can_approve ? 1 : 0,
          p.can_export ? 1 : 0,
          p.can_print ? 1 : 0,
          roleId,
          p.module
        );
      }
      recordAuditLog(db, req.user, 'Role', roleId, `Role-${roleId}`, 'Update Permissions', { count: permissions.length });
    });
    res.json({ ok: true });
  } catch (err: unknown) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Failed to update permissions' });
  }
});

export default router;
