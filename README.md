# PetroBlend Enterprise ERP

Enterprise Lubricants Manufacturing, Blending, Packaging, Procurement, Inventory, Quality Control, Sales, UAE 5% VAT Accounting, HR/Payroll, CRM & Projects ERP System.

## Quick Start
```bash
cp .env.example .env
pnpm install
pnpm dev
```
On Windows, double-click `start.bat`. Open `http://localhost:3000` and create the first Super Admin account.

## Running Automated End-to-End Business Tests
```bash
pnpm test:erp
```

## Architecture
- **Frontend**: React 19 + TypeScript + Tailwind CSS + Recharts + SheetJS (`xlsx`) + `jsPDF`
- **Local Server & API**: Express + TypeScript (`server.ts`, `server/`) with `better-sqlite3` WAL persistence (`./data/lubricants_erp.db`)
- **Hosted Server & API**: Vercel Node.js functions with the same Express routes; PostgreSQL storage through Neon for testing or another compatible PostgreSQL server
- **Python FastAPI / SQLAlchemy / Alembic prototype**: `backend/` + `scripts/migrate_sqlite_to_postgres.py`; this is a partial mirror, not a replacement for the Express API
- **Documentation**: `docs/DEPLOYMENT_AND_MIGRATION.md`

## Hosting and Database Notes
For a hosted test environment, use Neon PostgreSQL with `DB_ADAPTER=postgres`, a private pooled `DATABASE_URL`, and a stable `JWT_SECRET` in Vercel. The same adapter can later use a compatible company PostgreSQL server by replacing the private URL. Attachments and company logos are stored in PostgreSQL; hosted database backups are managed by the provider. See [`docs/VERCEL_AND_DATABASE_OPTIONS.md`](docs/VERCEL_AND_DATABASE_OPTIONS.md) for setup and verification steps.

