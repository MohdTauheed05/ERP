import { Router } from 'express';
import { getDb, withTransaction } from '../db.ts';
import { authenticate, createNotification, recordAuditLog, requirePermission, type AuthRequest } from '../middleware/auth.ts';
import { nowISO, todayISO } from '../utils/helpers.ts';
import { getNextDocumentNumber } from '../services/numbering.ts';

const router = Router();
router.use(authenticate);

router.get('/parameters', requirePermission('quality', 'can_view'), (_req, res) => {
  res.json({ items: getDb().prepare('SELECT * FROM qc_parameters WHERE is_active = 1 ORDER BY id ASC').all() });
});

router.post('/parameters', requirePermission('quality', 'can_create'), (req, res) => {
  const { name, unit, method, default_min, default_max, data_type } = req.body as Record<string, unknown>;
  if (!name) {
    res.status(400).json({ error: 'Parameter name is required' });
    return;
  }
  const r = getDb()
    .prepare('INSERT INTO qc_parameters (name, unit, method, default_min, default_max, data_type, is_active) VALUES (?, ?, ?, ?, ?, ?, 1)')
    .run(name, unit || '', method || '', default_min ?? null, default_max ?? null, data_type || 'numeric');
  res.status(201).json({ id: r.lastInsertRowid });
});

router.get('/inspections', requirePermission('quality', 'can_view'), (_req, res) => {
  const db = getDb();
  const list = db
    .prepare(
      `SELECT qi.*, i.item_code, i.name as item_name, sb.is_on_hold, sb.qc_status as batch_qc_status,
              cr.full_name as creator_name, ap.full_name as approver_name
       FROM quality_inspections qi
       JOIN items i ON i.id = qi.item_id
       LEFT JOIN stock_batches sb ON sb.id = qi.batch_id
       LEFT JOIN users cr ON cr.id = qi.created_by
       LEFT JOIN users ap ON ap.id = qi.approved_by
       ORDER BY qi.id DESC`
    )
    .all() as Record<string, unknown>[];
  const results = db.prepare('SELECT * FROM quality_results ORDER BY id ASC').all() as { qc_id: number }[];
  res.json({ items: list.map((q) => ({ ...q, results: results.filter((r) => r.qc_id === Number(q.id)) })) });
});

router.post('/inspections', requirePermission('quality', 'can_create'), (req: AuthRequest, res) => {
  const b = req.body as {
    inspection_type: string;
    item_id: number;
    batch_id?: number;
    batch_number?: string;
    doc_type?: string;
    doc_id?: number;
    doc_number?: string;
    remarks?: string;
  };
  if (!b.item_id || !b.inspection_type) {
    res.status(400).json({ error: 'Inspection type and item are required' });
    return;
  }
  try {
    const result = withTransaction((db) => {
      const qcNumber = getNextDocumentNumber(db, 'QC');
      let batchId = b.batch_id || null;
      if (!batchId && b.batch_number) {
        const batch = db.prepare('SELECT id FROM stock_batches WHERE batch_number = ?').get(b.batch_number) as { id: number } | undefined;
        batchId = batch?.id ?? null;
      }
      const r = db
        .prepare(
          `INSERT INTO quality_inspections (qc_number, inspection_type, doc_type, doc_id, doc_number, item_id, batch_id, batch_number, inspection_date, inspector_name, overall_status, batch_action, remarks, created_by, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Pending', 'Hold', ?, ?, ?)`
        )
        .run(
          qcNumber,
          b.inspection_type,
          b.doc_type || '',
          b.doc_id || null,
          b.doc_number || '',
          b.item_id,
          batchId,
          b.batch_number || '',
          todayISO(),
          req.user!.full_name,
          b.remarks || '',
          req.user!.id,
          nowISO()
        );
      recordAuditLog(db, req.user, 'QualityInspection', Number(r.lastInsertRowid), qcNumber, 'Create QC Inspection', {});
      return { id: Number(r.lastInsertRowid), qc_number: qcNumber };
    });
    res.status(201).json(result);
  } catch (err: unknown) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Failed to create QC inspection' });
  }
});

router.post('/inspections/:id/evaluate', requirePermission('quality', 'can_approve'), (req: AuthRequest, res) => {
  const qcId = Number(req.params.id);
  const b = req.body as {
    batch_action: 'Release' | 'Hold' | 'Reject';
    remarks?: string;
    results: {
      parameter_id?: number;
      parameter_name: string;
      unit?: string;
      min_val?: number | null;
      max_val?: number | null;
      actual_val?: number | null;
      text_val?: string;
    }[];
  };
  if (!Array.isArray(b.results) || b.results.length === 0) {
    res.status(400).json({ error: 'At least one lab test result is required' });
    return;
  }

  try {
    const result = withTransaction((db) => {
      const qi = db.prepare('SELECT * FROM quality_inspections WHERE id = ?').get(qcId) as
        | { id: number; qc_number: string; batch_id: number | null; batch_number: string; item_id: number }
        | undefined;
      if (!qi) throw new Error('Quality Inspection not found');

      db.prepare('DELETE FROM quality_results WHERE qc_id = ?').run(qcId);
      const ins = db.prepare(
        `INSERT INTO quality_results (qc_id, parameter_id, parameter_name, unit, min_val, max_val, actual_val, text_val, result_status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );

      let anyFail = false;
      for (const r of b.results) {
        let status = 'Pass';
        if (r.actual_val !== null && r.actual_val !== undefined) {
          if (r.min_val !== null && r.min_val !== undefined && r.actual_val < r.min_val) status = 'Fail';
          if (r.max_val !== null && r.max_val !== undefined && r.actual_val > r.max_val) status = 'Fail';
        }
        if (status === 'Fail') anyFail = true;
        ins.run(qcId, r.parameter_id || null, r.parameter_name, r.unit || '', r.min_val ?? null, r.max_val ?? null, r.actual_val ?? null, r.text_val || '', status);
      }

      const overallStatus = anyFail || b.batch_action === 'Reject' ? 'Failed' : 'Passed';
      const action = b.batch_action || (overallStatus === 'Passed' ? 'Release' : 'Hold');
      const isOnHold = action === 'Release' ? 0 : 1;
      const batchQcStatus = action === 'Release' ? 'Released' : action === 'Reject' ? 'Rejected' : 'Hold';

      db.prepare('UPDATE quality_inspections SET overall_status = ?, batch_action = ?, remarks = ?, approved_by = ? WHERE id = ?').run(
        overallStatus,
        action,
        b.remarks || '',
        req.user!.id,
        qcId
      );

      if (qi.batch_id) {
        db.prepare('UPDATE stock_batches SET is_on_hold = ?, qc_status = ? WHERE id = ?').run(isOnHold, batchQcStatus, qi.batch_id);
      }

      if (overallStatus === 'Failed') {
        createNotification(db, {
          type: 'quality_rejection',
          title: `QC Failed / Hold: ${qi.qc_number}`,
          message: `Batch ${qi.batch_number} failed specification and is placed on ${batchQcStatus}.`,
          docType: 'QualityInspection',
          docId: qcId,
        });
      }

      recordAuditLog(db, req.user, 'QualityInspection', qcId, qi.qc_number, `Evaluate QC (${overallStatus} / ${action})`, {
        batch_number: qi.batch_number,
      });

      return { overall_status: overallStatus, batch_action: action, is_on_hold: isOnHold };
    });
    res.json(result);
  } catch (err: unknown) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Failed to evaluate QC' });
  }
});

router.get('/inspections/:id/coa', requirePermission('quality', 'can_view'), (req, res) => {
  const db = getDb();
  const qcId = Number(req.params.id);
  const rawCompany = db.prepare('SELECT * FROM companies LIMIT 1').get() as Record<string, unknown> | undefined;
  const company = rawCompany
    ? {
        ...rawCompany,
        logo_url: rawCompany.logo_path ? `/api/auth/logo?v=${encodeURIComponent(String(rawCompany.logo_path))}` : '',
      }
    : null;
  const inspection = db
    .prepare(
      `SELECT qi.*, i.item_code, i.name as item_name, i.brand, sb.mfg_date, sb.expiry_date,
              cr.full_name as creator_name, ap.full_name as approver_name
       FROM quality_inspections qi
       JOIN items i ON i.id = qi.item_id
       LEFT JOIN stock_batches sb ON sb.id = qi.batch_id
       LEFT JOIN users cr ON cr.id = qi.created_by
       LEFT JOIN users ap ON ap.id = qi.approved_by
       WHERE qi.id = ?`
    )
    .get(qcId);
  if (!inspection) {
    res.status(404).json({ error: 'COA record not found' });
    return;
  }
  const results = db.prepare('SELECT * FROM quality_results WHERE qc_id = ?').all(qcId);
  res.json({ company, inspection, results });
});

export default router;
