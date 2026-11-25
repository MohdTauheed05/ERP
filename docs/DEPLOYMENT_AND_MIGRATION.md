# PetroBlend Enterprise ERP — Deployment & SQLite-to-PostgreSQL Migration Guide

## 1. Local Windows Setup (SQLite WAL Mode)
1. Install **Node.js 20+** (and optionally **Python 3.11+** if using the FastAPI backend).
2. Double-click `start.bat` or run:
   ```cmd
   copy .env.example .env
   npm install
   npm run dev
   ```
3. Open `http://localhost:3000`.
4. On first launch, complete the **First-Run Super Admin Setup** screen (no hardcoded credentials).
5. Optionally click **Load Sample Lubricants Plant Data** on the Executive Dashboard to populate realistic UAE lubricant SKUs, BOMs, suppliers, customers, and opening General Ledger balances.

## 2. Database Engine & Persistence
- Default local database: `./data/lubricants_erp.db` (`WAL` mode + `PRAGMA foreign_keys = ON`).
- Uploaded attachments: `./uploads/` (path-confined, MIME-allowlisted).
- Atomic backups: `./backups/` (created via SQLite online `.backup()` API from **Admin, RBAC & Backups -> Backup & Migration**).

## 3. PostgreSQL migration status and path
The current Express API still supports SQLite only. It contains synchronous `better-sqlite3` calls and SQLite-specific schema, backup, and integrity-check code. The `backend/` FastAPI/Alembic project and migration script are a partial prototype; they do not provide a drop-in PostgreSQL runtime for all Express routes. Setting `DATABASE_URL` to PostgreSQL currently fails at startup intentionally.

A complete PostgreSQL rollout requires a migration of the full Express data layer, schema and data migrations, durable upload storage, and verification of all ERP workflows. After that work is implemented, the planned operator switch should be a private server-side `DATABASE_URL=postgresql://...` setting plus migrations. Do not use the following prototype steps as proof of a production-ready migration:

1. Provision PostgreSQL 16 (or run `docker compose up -d postgres`) for development.
2. Review and complete the schema in `backend/migrations` and the Python API before relying on it.
3. The current migration script can be used as a starting point only:
   ```bash
   pip install -r backend/requirements.txt
   python -m alembic -c backend/alembic.ini upgrade head
   python scripts/migrate_sqlite_to_postgres.py \
     --sqlite ./data/lubricants_erp.db \
     --postgres postgresql://erp_user:your_password@your-server:5432/lubricants_erp
   ```
4. Do not point the Express API at PostgreSQL until its PostgreSQL adapter has been implemented and validated.

## 4. Backup & Disaster Recovery
- Always create a snapshot in **Admin -> Backup & Migration -> Create Backup Snapshot** before bulk imports or schema upgrades.
- Use **Integrity Check** to run `PRAGMA integrity_check`, `PRAGMA foreign_key_check`, and verify `SUM(total_debit) == SUM(total_credit)` across all Journal Entries.
- Restoring a snapshot automatically saves a `pre_restore_safety_*.db` snapshot first.
