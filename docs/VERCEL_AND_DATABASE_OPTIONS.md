# Vercel and database deployment notes

## Current project architecture

- Vercel can host the Vite frontend as a static site (`vercel.json` builds `dist`).
- The Express API in `server.ts` is a separate long-running service. It currently uses `better-sqlite3` and stores uploaded files on the server filesystem.
- The Vite frontend reads `VITE_API_BASE_URL` at build time. Leave it empty for a same-origin deployment; for separate hosting, set it to the API origin with no trailing slash. Set the API's `CORS_ORIGINS` to the exact Vercel production URL and any preview URLs that should be allowed.
- Keep Firebase Admin credentials, database URLs, and JWT secrets in the API host's private environment settings. Never put them in a `VITE_` variable.

## Free tier versus production

There is no zero-cost, no-code deployment for this repository as it stands. The SQLite database and uploads cannot live safely on a serverless or ephemeral filesystem. A free web-service tier can be useful for a demo, but the storage and sleep limitations make it unsuitable for the live ERP database.

Firebase Cloud Firestore is a document database, while the current API expects relational SQL tables, constraints, joins, and transactions. Switching to Firestore would require rewriting the API data layer and validating the ERP workflows.

Firebase SQL Connect uses managed PostgreSQL, so its data model is closer to this project. Its Spark-plan database is a 90-day no-cost trial; afterwards the instance is archived unless the Firebase project is upgraded. The existing TypeScript API still uses SQLite, and the Python PostgreSQL backend is only a partial mirror, so SQL Connect is not a drop-in setting.

For a short free proof-of-concept, deploy the frontend to Vercel and keep the backend/database on a temporary test setup. Do not enter real company, employee, customer, inventory, or accounting data until the API and durable database are deployed and backup/restore is confirmed. For ongoing use, expect to use a paid always-on API host and durable relational database, or budget time for a database migration and its verification.

## GitHub and Vercel setup

1. Create a private GitHub repository and upload the contents of this project folder. The `.gitignore` excludes local databases, uploads, backups, and environment files.
2. In Vercel, import that GitHub repository. Keep the project root at the folder containing `package.json`; `vercel.json` selects Vite, runs `npm run build`, and publishes `dist`.
3. Deploy the API separately. Configure `PORT`, `NODE_ENV=production`, a long random `JWT_SECRET`, `ADMIN_INITIAL_PASSWORD` if desired, `CORS_ORIGINS`, and a durable database/storage solution on that host.
4. Add `VITE_API_BASE_URL` to the Vercel project's Production (and Preview if needed) environment variables, set it to the API's HTTPS origin, then redeploy. Vite environment variables are embedded during the build.
5. Open the deployed health endpoint `/api/health`, complete first-admin setup, and verify login, document creation, uploads, exports, and backup/restore before putting real data in the system.

Do not treat a successful Vercel frontend build as proof that the ERP is live: the API and durable storage must also be available.
