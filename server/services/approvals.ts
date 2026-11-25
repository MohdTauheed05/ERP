import type Database from 'better-sqlite3';
import { nowISO } from '../utils/helpers.ts';
import { createNotification, type AuthUser } from '../middleware/auth.ts';

export function evaluateApprovalRequirement(
  db: Database.Database,
  params: { docType: string; amount: number; currency?: string; department?: string; warehouseId?: number | null }
): { required: boolean; ruleId: number | null; requiredRoleId: number | null; requiredRoleName: string | null } {
  const currency = params.currency || 'AED';
  const rules = db
    .prepare(
      `SELECT ar.*, r.name as role_name
       FROM approval_rules ar
       JOIN roles r ON r.id = ar.role_id
       WHERE ar.doc_type = ? AND ar.is_active = 1
       ORDER BY ar.priority ASC, ar.min_amount ASC`
    )
    .all(params.docType) as {
    id: number;
    department: string;
    role_id: number;
    role_name: string;
    min_amount: number;
    max_amount: number | null;
    currency: string;
    warehouse_id: number | null;
  }[];

  for (const rule of rules) {
    if (rule.currency && rule.currency !== currency) continue;
    if (rule.department && params.department && rule.department !== params.department) continue;
    if (rule.warehouse_id && params.warehouseId && rule.warehouse_id !== params.warehouseId) continue;
    const minOk = params.amount >= rule.min_amount;
    const maxOk = rule.max_amount === null || params.amount <= rule.max_amount;
    if (minOk && maxOk) {
      return {
        required: true,
        ruleId: rule.id,
        requiredRoleId: rule.role_id,
        requiredRoleName: rule.role_name,
      };
    }
  }

  return { required: false, ruleId: null, requiredRoleId: null, requiredRoleName: null };
}

export function requestDocumentApproval(
  db: Database.Database,
  params: {
    docType: string;
    docId: number;
    docNumber: string;
    amount: number;
    currency: string;
    department?: string;
    warehouseId?: number | null;
    user: AuthUser;
  }
): { status: 'Approved' | 'Pending'; requestId?: number; requiredRoleName?: string | null } {
  const evalResult = evaluateApprovalRequirement(db, {
    docType: params.docType,
    amount: params.amount,
    currency: params.currency,
    department: params.department,
    warehouseId: params.warehouseId,
  });

  if (!evalResult.required) {
    return { status: 'Approved' };
  }

  // If current user already holds the required role or is Super Admin, auto-approve if explicitly submitting?
  // Wait: to enforce multi-tier governance (Test 7), if user role matches requiredRoleId or Super Admin, they can approve; otherwise create pending request!
  if (params.user.role_id === evalResult.requiredRoleId || params.user.role_name === 'Super Admin') {
    const reqRes = db
      .prepare(
        `INSERT INTO approval_requests (doc_type, doc_id, doc_number, rule_id, required_role_id, requested_by, amount, currency, status, comments, decided_by, decided_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'Approved', 'Auto-approved by authorized role', ?, ?, ?)`
      )
      .run(
        params.docType,
        params.docId,
        params.docNumber,
        evalResult.ruleId,
        evalResult.requiredRoleId,
        params.user.id,
        params.amount,
        params.currency,
        params.user.id,
        nowISO(),
        nowISO()
      );
    db.prepare(
      `INSERT INTO approval_history (request_id, doc_type, doc_id, action, actor_id, comments, created_at)
       VALUES (?, ?, ?, 'Approved', ?, 'Authorized role immediate approval', ?)`
    ).run(reqRes.lastInsertRowid, params.docType, params.docId, params.user.id, nowISO());
    return { status: 'Approved', requestId: Number(reqRes.lastInsertRowid) };
  }

  const reqRes = db
    .prepare(
      `INSERT INTO approval_requests (doc_type, doc_id, doc_number, rule_id, required_role_id, requested_by, amount, currency, status, comments, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'Pending', 'Awaiting approval per approval matrix', ?)`
    )
    .run(
      params.docType,
      params.docId,
      params.docNumber,
      evalResult.ruleId,
      evalResult.requiredRoleId,
      params.user.id,
      params.amount,
      params.currency,
      nowISO()
    );

  db.prepare(
    `INSERT INTO approval_history (request_id, doc_type, doc_id, action, actor_id, comments, created_at)
     VALUES (?, ?, ?, 'Requested', ?, 'Submitted for approval', ?)`
  ).run(reqRes.lastInsertRowid, params.docType, params.docId, params.user.id, nowISO());

  createNotification(db, {
    roleId: evalResult.requiredRoleId,
    type: 'approval_pending',
    title: `Approval Required: ${params.docNumber}`,
    message: `${params.docType} ${params.docNumber} (${params.currency} ${params.amount.toFixed(2)}) requires ${evalResult.requiredRoleName} approval.`,
    docType: params.docType,
    docId: params.docId,
  });

  return {
    status: 'Pending',
    requestId: Number(reqRes.lastInsertRowid),
    requiredRoleName: evalResult.requiredRoleName,
  };
}
