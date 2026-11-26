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
- **Hosted Server & API**: Vercel Node.js function (`api/[...path].ts`) with the same Express routes; PostgreSQL storage through Firebase SQL Connect's Cloud SQL instance or a future company PostgreSQL URL
- **Python FastAPI / SQLAlchemy / Alembic prototype**: `backend/` + `scripts/migrate_sqlite_to_postgres.py`; this is a partial mirror, not a replacement for the Express API
- **Documentation**: `docs/DEPLOYMENT_AND_MIGRATION.md`

## Hosting and Database Notes
The Vercel API uses the PostgreSQL adapter selected by `DB_ADAPTER=cloudsql`; it requires Firebase SQL Connect Cloud SQL access, Vercel OIDC federation, a stable `JWT_SECRET`, and Vercel environment variables. Attachments and company logos are stored in PostgreSQL; database backups remain managed through Firebase/Cloud SQL. For the future company server, set `DB_ADAPTER=postgres` and a private `DATABASE_URL`. See [`docs/VERCEL_AND_DATABASE_OPTIONS.md`](docs/VERCEL_AND_DATABASE_OPTIONS.md) for the exact connection setup.
