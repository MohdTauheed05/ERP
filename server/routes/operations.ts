import { Router } from 'express';
import { getDb, withTransaction } from '../db.ts';
import { authenticate, recordAuditLog, requirePermission, type AuthRequest } from '../middleware/auth.ts';
import { nowISO, roundMoney, todayISO } from '../utils/helpers.ts';
import { getNextDocumentNumber } from '../services/numbering.ts';
import { postJournalEntry } from '../services/accounting.ts';

const router = Router();
router.use(authenticate);

// ---------------- HR & PAYROLL ----------------
router.get('/hr/overview', requirePermission('hr', 'can_view'), (_req, res) => {
  const db = getDb();
  const departments = db.prepare('SELECT * FROM departments ORDER BY name ASC').all();
  const designations = db.prepare('SELECT * FROM designations ORDER BY name ASC').all();
  const employees = db
    .prepare(
      `SELECT e.*, d.name as department_name, dg.name as designation_name
       FROM employees e
       LEFT JOIN departments d ON d.id = e.department_id
       LEFT JOIN designations dg ON dg.id = e.designation_id
       ORDER BY e.id DESC`
    )
    .all();
  const attendance = db
    .prepare('SELECT a.*, e.emp_code, e.full_name FROM attendance a JOIN employees e ON e.id = a.employee_id ORDER BY a.attendance_date DESC, a.id DESC LIMIT 100')
    .all();
  const leaves = db
    .prepare('SELECT l.*, e.emp_code, e.full_name FROM leave_requests l JOIN employees e ON e.id = l.employee_id ORDER BY l.id DESC')
    .all();
  const payrolls = db.prepare('SELECT * FROM payroll_runs ORDER BY id DESC').all();
  res.json({ departments, designations, employees, attendance, leaves, payrolls });
});

router.post('/hr/employees', requirePermission('hr', 'can_create'), (req: AuthRequest, res) => {
  const b = req.body as Record<string, unknown>;
  if (!b.full_name) {
    res.status(400).json({ error: 'Employee name is required' });
    return;
  }
  const db = getDb();
  const count = (db.prepare('SELECT COUNT(*) as c FROM employees').get() as { c: number }).c;
  const code = String(b.emp_code || `EMP-${String(count + 1).padStart(3, '0')}`);
  const r = db
    .prepare(
      `INSERT INTO employees (emp_code, full_name, email, phone, department_id, designation_id, join_date, basic_salary, allowances, user_id, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Active', ?)`
    )
    .run(
      code,
      b.full_name,
      b.email || '',
      b.phone || '',
      b.department_id || null,
      b.designation_id || null,
      b.join_date || todayISO(),
      roundMoney(Number(b.basic_salary || 0)),
      roundMoney(Number(b.allowances || 0)),
      b.user_id || null,
      nowISO()
    );
  recordAuditLog(db, req.user, 'Employee', Number(r.lastInsertRowid), code, 'Create Employee', { name: b.full_name });
  res.status(201).json({ id: r.lastInsertRowid, emp_code: code });
});

router.post('/hr/attendance', requirePermission('hr', 'can_create'), (req, res) => {
  const { employee_id, attendance_date, status, check_in, check_out, hours_worked } = req.body as Record<string, unknown>;
  if (!employee_id) {
    res.status(400).json({ error: 'Employee is required' });
    return;
  }
  getDb()
    .prepare(
      `INSERT INTO attendance (employee_id, attendance_date, status, check_in, check_out, hours_worked)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(employee_id, attendance_date) DO UPDATE SET status=excluded.status, check_in=excluded.check_in, check_out=excluded.check_out, hours_worked=excluded.hours_worked`
    )
    .run(employee_id, attendance_date || todayISO(), status || 'Present', check_in || '08:00', check_out || '17:00', Number(hours_worked || 8));
  res.status(201).json({ ok: true });
});

router.post('/hr/leaves', requirePermission('hr', 'can_create'), (req, res) => {
  const { employee_id, leave_type, start_date, end_date, days, reason } = req.body as Record<string, unknown>;
  if (!employee_id || !leave_type || !start_date || !end_date) {
    res.status(400).json({ error: 'Employee, leave type, and dates are required' });
    return;
  }
  const r = getDb()
    .prepare('INSERT INTO leave_requests (employee_id, leave_type, start_date, end_date, days, reason, status, created_at) VALUES (?, ?, ?, ?, ?, ?, \'Pending\', ?)')
    .run(employee_id, leave_type, start_date, end_date, Number(days || 1), reason || '', nowISO());
  res.status(201).json({ id: r.lastInsertRowid });
});

router.post('/hr/leaves/:id/decide', requirePermission('hr', 'can_approve'), (req: AuthRequest, res) => {
  const { status } = req.body as { status: 'Approved' | 'Rejected' };
  getDb().prepare('UPDATE leave_requests SET status = ?, approved_by = ? WHERE id = ?').run(status, req.user!.id, Number(req.params.id));
  res.json({ ok: true });
});

router.post('/hr/payroll', requirePermission('hr', 'can_submit'), (req: AuthRequest, res) => {
  const { month, year, bank_account_id } = req.body as { month: number; year: number; bank_account_id?: number };
  if (!month || !year) {
    res.status(400).json({ error: 'Month and year are required' });
    return;
  }
  try {
    const result = withTransaction((db) => {
      const emps = db.prepare("SELECT * FROM employees WHERE status = 'Active'").all() as {
        id: number;
        basic_salary: number;
        allowances: number;
      }[];
      if (emps.length === 0) throw new Error('No active employees found for payroll');

      const payrollNumber = getNextDocumentNumber(db, 'PAY');
      let totalGross = 0;
      for (const e of emps) totalGross = roundMoney(totalGross + e.basic_salary + e.allowances);

      const pr = db
        .prepare('INSERT INTO payroll_runs (payroll_number, month, year, total_gross, total_deductions, total_net, status, created_by, created_at) VALUES (?, ?, ?, ?, 0, ?, \'Posted\', ?, ?)')
        .run(payrollNumber, month, year, totalGross, totalGross, req.user!.id, nowISO());
      const payrollId = Number(pr.lastInsertRowid);
      const ins = db.prepare('INSERT INTO payroll_lines (payroll_id, employee_id, basic_salary, allowances, deductions, net_pay) VALUES (?, ?, ?, ?, 0, ?)');
      for (const e of emps) ins.run(payrollId, e.id, e.basic_salary, e.allowances, roundMoney(e.basic_salary + e.allowances));

      const creditCode = bank_account_id ? undefined : '2300';
      let creditAccountId: number | undefined;
      if (bank_account_id) {
        const bank = db.prepare('SELECT gl_account_id FROM bank_accounts WHERE id = ?').get(bank_account_id) as { gl_account_id: number };
        creditAccountId = bank.gl_account_id;
        db.prepare('UPDATE bank_accounts SET current_balance = ROUND(current_balance - ?, 2) WHERE id = ?').run(totalGross, bank_account_id);
      }

      const je = postJournalEntry(db, {
        postingDate: todayISO(),
        entryType: 'Payroll',
        refDocType: 'PayrollRun',
        refDocId: payrollId,
        refDocNumber: payrollNumber,
        narration: `Monthly Payroll ${month}/${year} (${payrollNumber})`,
        lines: [
          { accountCode: '5600', debit: totalGross, description: `Salaries & Wages ${month}/${year}` },
          { accountCode: creditCode, accountId: creditAccountId, credit: totalGross, description: `Payroll liability/payout (${payrollNumber})` },
        ],
        userId: req.user!.id,
      });

      db.prepare('UPDATE payroll_runs SET je_id = ? WHERE id = ?').run(je.jeId, payrollId);
      recordAuditLog(db, req.user, 'PayrollRun', payrollId, payrollNumber, 'Post Payroll', { totalGross, je_number: je.jeNumber });
      return { id: payrollId, payroll_number: payrollNumber, total_net: totalGross, je_number: je.jeNumber };
    });
    res.status(201).json(result);
  } catch (err: unknown) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Failed to run payroll' });
  }
});

// ---------------- CRM ----------------
router.get('/crm/overview', requirePermission('crm', 'can_view'), (_req, res) => {
  const db = getDb();
  const leads = db.prepare('SELECT * FROM crm_leads ORDER BY id DESC').all();
  const activities = db
    .prepare('SELECT a.*, l.company_name as lead_company, c.name as customer_name FROM crm_activities a LEFT JOIN crm_leads l ON l.id = a.lead_id LEFT JOIN customers c ON c.id = a.customer_id ORDER BY a.id DESC')
    .all();
  const complaints = db
    .prepare('SELECT cmp.*, c.name as customer_name, i.name as item_name FROM crm_complaints cmp JOIN customers c ON c.id = cmp.customer_id LEFT JOIN items i ON i.id = cmp.item_id ORDER BY cmp.id DESC')
    .all();
  res.json({ leads, activities, complaints });
});

router.post('/crm/leads', requirePermission('crm', 'can_create'), (req: AuthRequest, res) => {
  const b = req.body as Record<string, unknown>;
  if (!b.company_name) {
    res.status(400).json({ error: 'Company name is required' });
    return;
  }
  const leadNumber = getNextDocumentNumber(getDb(), 'LEAD');
  const r = getDb()
    .prepare(
      `INSERT INTO crm_leads (lead_number, company_name, contact_person, email, phone, source, stage, estimated_value, currency, assigned_to, notes, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      leadNumber,
      b.company_name,
      b.contact_person || '',
      b.email || '',
      b.phone || '',
      b.source || 'Direct',
      b.stage || 'New',
      roundMoney(Number(b.estimated_value || 0)),
      b.currency || 'AED',
      req.user!.id,
      b.notes || '',
      nowISO()
    );
  res.status(201).json({ id: r.lastInsertRowid, lead_number: leadNumber });
});

router.post('/crm/leads/:id/stage', requirePermission('crm', 'can_edit'), (req, res) => {
  const { stage } = req.body as { stage: string };
  getDb().prepare('UPDATE crm_leads SET stage = ? WHERE id = ?').run(stage, Number(req.params.id));
  res.json({ ok: true });
});

router.post('/crm/leads/:id/convert', requirePermission('crm', 'can_submit'), (req: AuthRequest, res) => {
  const leadId = Number(req.params.id);
  try {
    const result = withTransaction((db) => {
      const lead = db.prepare('SELECT * FROM crm_leads WHERE id = ?').get(leadId) as
        | { id: number; company_name: string; contact_person: string; email: string; phone: string; currency: string; converted_customer_id: number | null }
        | undefined;
      if (!lead) throw new Error('Lead not found');
      if (lead.converted_customer_id) throw new Error('Lead already converted to customer');

      const count = (db.prepare('SELECT COUNT(*) as c FROM customers').get() as { c: number }).c;
      const custCode = `CUST-${String(count + 1).padStart(3, '0')}`;
      const now = nowISO();
      const cust = db
        .prepare(
          `INSERT INTO customers (code, name, contact_person, telephone, email, country, currency, category, is_active, created_by, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 'United Arab Emirates', ?, 'Distributor', 1, ?, ?, ?)`
        )
        .run(custCode, lead.company_name, lead.contact_person, lead.phone, lead.email, lead.currency || 'AED', req.user!.id, now, now);
      const customerId = Number(cust.lastInsertRowid);
      db.prepare("UPDATE crm_leads SET stage = 'Won', converted_customer_id = ? WHERE id = ?").run(customerId, leadId);
      recordAuditLog(db, req.user, 'Customer', customerId, custCode, 'Convert CRM Lead to Customer', { leadId });
      return { customer_id: customerId, customer_code: custCode };
    });
    res.json(result);
  } catch (err: unknown) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Failed to convert lead' });
  }
});

router.post('/crm/activities', requirePermission('crm', 'can_create'), (req: AuthRequest, res) => {
  const { lead_id, customer_id, activity_type, subject, notes, follow_up_date } = req.body as Record<string, unknown>;
  const r = getDb()
    .prepare('INSERT INTO crm_activities (lead_id, customer_id, activity_type, subject, notes, follow_up_date, completed, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)')
    .run(lead_id || null, customer_id || null, activity_type || 'Call', subject, notes || '', follow_up_date || '', req.user!.id, nowISO());
  res.status(201).json({ id: r.lastInsertRowid });
});

router.post('/crm/complaints', requirePermission('crm', 'can_create'), (req, res) => {
  const b = req.body as Record<string, unknown>;
  if (!b.customer_id || !b.subject) {
    res.status(400).json({ error: 'Customer and subject are required' });
    return;
  }
  const cmpNumber = getNextDocumentNumber(getDb(), 'CMP');
  const r = getDb()
    .prepare('INSERT INTO crm_complaints (complaint_number, customer_id, item_id, batch_number, subject, description, severity, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, \'Open\', ?)')
    .run(cmpNumber, b.customer_id, b.item_id || null, b.batch_number || '', b.subject, b.description || '', b.severity || 'Medium', nowISO());
  res.status(201).json({ id: r.lastInsertRowid, complaint_number: cmpNumber });
});

// ---------------- PROJECTS ----------------
router.get('/projects', requirePermission('projects', 'can_view'), (_req, res) => {
  const db = getDb();
  const projects = db
    .prepare('SELECT p.*, c.name as customer_name, e.full_name as manager_name FROM projects p LEFT JOIN customers c ON c.id = p.customer_id LEFT JOIN employees e ON e.id = p.manager_id ORDER BY p.id DESC')
    .all() as Record<string, unknown>[];
  const tasks = db
    .prepare('SELECT t.*, e.full_name as assigned_name FROM project_tasks t LEFT JOIN employees e ON e.id = t.assigned_employee_id ORDER BY t.id ASC')
    .all() as { project_id: number }[];
  res.json({
    items: projects.map((p) => ({
      ...p,
      profitability: roundMoney(Number(p.revenue || 0) - Number(p.actual_cost || 0)),
      tasks: tasks.filter((t) => t.project_id === Number(p.id)),
    })),
  });
});

router.post('/projects', requirePermission('projects', 'can_create'), (req, res) => {
  const b = req.body as Record<string, unknown>;
  if (!b.name) {
    res.status(400).json({ error: 'Project name is required' });
    return;
  }
  const code = getNextDocumentNumber(getDb(), 'PRJ');
  const r = getDb()
    .prepare('INSERT INTO projects (project_code, name, customer_id, start_date, end_date, budget, revenue, progress_pct, status, manager_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 0, \'Active\', ?, ?)')
    .run(code, b.name, b.customer_id || null, b.start_date || todayISO(), b.end_date || todayISO(), roundMoney(Number(b.budget || 0)), roundMoney(Number(b.revenue || 0)), b.manager_id || null, nowISO());
  res.status(201).json({ id: r.lastInsertRowid, project_code: code });
});

router.post('/projects/:id/tasks', requirePermission('projects', 'can_create'), (req, res) => {
  const projectId = Number(req.params.id);
  const { title, assigned_employee_id, start_date, due_date } = req.body as Record<string, unknown>;
  const r = getDb()
    .prepare('INSERT INTO project_tasks (project_id, title, assigned_employee_id, start_date, due_date, progress_pct, status) VALUES (?, ?, ?, ?, ?, 0, \'Open\')')
    .run(projectId, title, assigned_employee_id || null, start_date || todayISO(), due_date || todayISO());
  res.status(201).json({ id: r.lastInsertRowid });
});

router.patch('/projects/tasks/:taskId', requirePermission('projects', 'can_edit'), (req, res) => {
  const taskId = Number(req.params.taskId);
  const { status, progress_pct } = req.body as { status?: string; progress_pct?: number };
  const db = getDb();
  const task = db.prepare('SELECT project_id FROM project_tasks WHERE id = ?').get(taskId) as { project_id: number } | undefined;
  if (!task) {
    res.status(404).json({ error: 'Task not found' });
    return;
  }
  db.prepare('UPDATE project_tasks SET status = COALESCE(?, status), progress_pct = COALESCE(?, progress_pct) WHERE id = ?').run(status ?? null, progress_pct ?? null, taskId);
  const avg = (db.prepare('SELECT COALESCE(AVG(progress_pct), 0) as avg_pct FROM project_tasks WHERE project_id = ?').get(task.project_id) as { avg_pct: number }).avg_pct;
  db.prepare('UPDATE projects SET progress_pct = ? WHERE id = ?').run(Math.round(avg), task.project_id);
  res.json({ ok: true });
});

export default router;
