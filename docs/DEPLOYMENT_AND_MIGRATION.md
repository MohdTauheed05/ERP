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

## 3. Migrating from Local SQLite to Dedicated PostgreSQL Server
1. Provision PostgreSQL 16 (or run `docker compose up -d postgres`).
2. Initialize the schema on PostgreSQL using Alembic (`backend/migrations`) or export the full normalized JSON bundle from **Admin -> Backup & Migration -> Export PostgreSQL Bundle**.
3. Run the Python migration script preserving all tables, foreign keys, document numbering sequences, and attachment paths:
   ```bash
   pip install -r backend/requirements.txt
   python -m alembic -c backend/alembic.ini upgrade head
   python scripts/migrate_sqlite_to_postgres.py \
     --sqlite ./data/lubricants_erp.db \
     --postgres postgresql://erp_user:your_password@your-server:5432/lubricants_erp
   ```
4. Update `.env` with `DATABASE_URL=postgresql://...` and restart the server.

## 4. Backup & Disaster Recovery
- Always create a snapshot in **Admin -> Backup & Migration -> Create Backup Snapshot** before bulk imports or schema upgrades.
- Use **Integrity Check** to run `PRAGMA integrity_check`, `PRAGMA foreign_key_check`, and verify `SUM(total_debit) == SUM(total_credit)` across all Journal Entries.
- Restoring a snapshot automatically saves a `pre_restore_safety_*.db` snapshot first.
