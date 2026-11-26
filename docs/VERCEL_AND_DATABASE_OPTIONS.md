# Vercel, Firebase SQL Connect, and database switching

## Current state

- GitHub repository: [`MohdTauheed05/ERP`](https://github.com/MohdTauheed05/ERP), branch `main`.
- Firebase test project: `petroblend-erp` (project number `408034291620`), created under `alnisrpurchase@gmail.com`.
- Firebase SQL Connect service: `petroblend-erp-service`, connected to `petroblend-erp-instance` in `me-west1`; the console currently shows its no-cost trial instance.
- Vercel can build the Vite frontend from the repository root using `vercel.json`.
- The Express API in `server.ts` uses synchronous `better-sqlite3`, initializes a local SQLite file, and writes uploads to the local filesystem. It cannot currently use PostgreSQL or Firebase SQL Connect. The Python FastAPI/PostgreSQL code is only a partial mirror, not the complete ERP API.
- `DATABASE_URL` currently accepts `sqlite:///...` only. A PostgreSQL URL now fails at startup instead of silently creating/using a different local SQLite database.

## Firebase SQL Connect Spark limitation

The Firebase project is on Spark. The SQL Connect console currently shows the service and instance on its no-cost trial. The database/schema still needs the app's complete SQL Connect schema and operations before the ERP can use it. Keep the test within the no-cost trial; do not upgrade to Blaze without an explicit billing plan. Confirm current trial limits and expiry in Firebase Console before relying on it, since trial terms can change. See [Firebase SQL Connect pricing](https://firebase.google.com/docs/sql-connect/pricing).

Firestore is a separate NoSQL product and does not make the existing relational Express API compatible without a significant rewrite.

## Vercel deployment

Vercel's Git import screen recognizes this repository as Vite and defaults to the repository root (`./`). The Vercel account/team currently has no project linked to `MohdTauheed05/ERP`, and automated project creation returned a permission error. A frontend build/deployment alone is not a live ERP: API login, business operations, persistence, and uploads require a working backend. Do not add the API URL as `VITE_API_BASE_URL` until the API is deployed to a durable host and its exact HTTPS origin is known. Never put database URLs, Firebase Admin credentials, or JWT secrets in a `VITE_` variable.

For a production deployment, the frontend and API may be hosted separately:

1. Deploy the frontend from this repository root on Vercel.
2. Deploy the complete Express API to a persistent Node.js host, with durable PostgreSQL and object storage for uploads.
3. Configure the API host's `JWT_SECRET`, `DATABASE_URL`, `UPLOAD_DIR` or storage provider, `BACKUP_DIR`, `PORT`, and exact `CORS_ORIGINS` as private environment settings.
4. Set `VITE_API_BASE_URL` in Vercel to the API's HTTPS origin, then redeploy the frontend.
5. Verify health, first-admin setup, login, CRUD workflows, uploads/downloads, accounting totals, and backup/restore before using real company data.

## Keep future database changes simple

The intended application-facing interface should be a small database adapter selected from server-side configuration, with one migration set and a common test suite. A future PostgreSQL move should use a standard `DATABASE_URL=postgresql://...` and a PostgreSQL adapter so a company-hosted PostgreSQL server can be selected by changing private server configuration and running migrations.

That adapter is not implemented yet. The current API has hundreds of synchronous SQLite queries and SQLite-specific schema/backup code; a safe PostgreSQL or Firebase SQL Connect migration requires converting those calls and verifying all ERP workflows. Firebase SQL Connect also uses its generated SQL Connect operation model rather than acting as a transparent replacement for `better-sqlite3`. Do not point the current API at a PostgreSQL URL and assume it has migrated.

Uploads and database backups must move to storage with durable retention when the API leaves the local machine. Vercel function filesystems are ephemeral and cannot serve as the ERP's durable database or upload store.

