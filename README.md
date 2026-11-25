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
- **Python FastAPI / SQLAlchemy / Alembic Mirror**: `backend/` + `scripts/migrate_sqlite_to_postgres.py` for standalone Python & PostgreSQL server deployments
- **Documentation**: `docs/DEPLOYMENT_AND_MIGRATION.md`

## Hosting and Database Notes
The included `vercel.json` deploys the Vite frontend. The Express API and durable database still need a separate host; Vercel's filesystem is not suitable for the current SQLite database or uploads. See [`docs/VERCEL_AND_DATABASE_OPTIONS.md`](docs/VERCEL_AND_DATABASE_OPTIONS.md) before using this with real business data.
