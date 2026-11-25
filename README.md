# PetroBlend Enterprise ERP

Enterprise Lubricants Manufacturing, Blending, Packaging, Procurement, Inventory, Quality Control, Sales, UAE 5% VAT Accounting, HR/Payroll, CRM & Projects ERP System.

## Quick Start
```bash
cp .env.example .env
npm install
npm run dev
```
On Windows, double-click `start.bat`. Open `http://localhost:3000`.

## Running Automated End-to-End Business Tests
```bash
npm run test:erp
```

## Architecture
- **Frontend**: React 19 + TypeScript + Tailwind CSS + Recharts + SheetJS (`xlsx`) + `jsPDF`
- **Live Server & API**: Express + TypeScript (`server.ts`, `server/`) with `better-sqlite3` WAL persistence (`./data/lubricants_erp.db`)
- **Python FastAPI / SQLAlchemy / Alembic prototype**: `backend/` + `scripts/migrate_sqlite_to_postgres.py`; this is a partial mirror, not a replacement for the Express API
- **Documentation**: `docs/DEPLOYMENT_AND_MIGRATION.md`

## Hosting and Database Notes
The included `vercel.json` builds the Vite frontend only. The current Express API uses SQLite and local disk uploads, so it is not ready to run as a Vercel serverless API or as a multi-user live ERP. The current Python/PostgreSQL code is a partial prototype. Firebase SQL Connect/PostgreSQL is not a drop-in `DATABASE_URL` change. See [`docs/VERCEL_AND_DATABASE_OPTIONS.md`](docs/VERCEL_AND_DATABASE_OPTIONS.md) before deploying.
