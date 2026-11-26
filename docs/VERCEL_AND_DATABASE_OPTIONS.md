# Vercel, Firebase SQL Connect, and database switching

## Current resources

- GitHub source: [`MohdTauheed05/ERP`](https://github.com/MohdTauheed05/ERP).
- Firebase project: `petroblend-erp` (`408034291620`), signed in under `alnisrpurchase@gmail.com`.
- SQL Connect service: `petroblend-erp-service`, region `me-west1`, using Cloud SQL instance `petroblend-erp-instance` on the Spark no-cost trial.
- Vercel project: `erp` under team `tauheed1`; current production alias: <https://erp-flax-two.vercel.app/>.

## Deployment architecture

The React/Vite UI is static on Vercel. Vercel Node function entrypoints under `/api` route one through four path segments into the existing Express API. Locally, the same Express routes continue to use SQLite. For hosted use, choose PostgreSQL using `DB_ADAPTER=cloudsql`; the adapter keeps current synchronous database call sites while connecting to the Cloud SQL PostgreSQL instance behind SQL Connect.

This is direct PostgreSQL access to SQL Connect's Cloud SQL database; it does not use SQL Connect generated GraphQL operations or SDKs. The ERP schema is created by the existing server schema initializer. The direct connection needs a service account with Cloud SQL client access and the SQL Connect PostgreSQL `owner` role so first-run schema creation and app seeding can run. The app's first-admin setup is available only after `/api/auth/status` can connect and initialize the database. There is no default username or password.

For safer future operations, keep schema changes in code and review them before deployment. Do not give the hosted app a service-account key. Use Vercel OIDC and Google Workload Identity Federation to exchange short-lived tokens.

## Required one-time cloud setup

In Google Cloud IAM for `petroblend-erp`:

1. Create a Workload Identity Pool and OIDC provider for the Vercel team issuer `https://oidc.vercel.com/tauheed1`. Map `google.subject` to `assertion.sub`; allow the provider's default audience `https://vercel.com/tauheed1`.
2. Create service account `vercel-erp@petroblend-erp.iam.gserviceaccount.com`.
3. Allow only the Vercel `erp` production and preview identities to impersonate this service account using `roles/iam.workloadIdentityUser`, using the exact subjects `owner:tauheed1:project:erp:environment:production` and `owner:tauheed1:project:erp:environment:preview`.
4. Grant the service account `roles/cloudsql.client` on the Firebase project.
5. In the Firebase CLI, grant the account the SQL Connect `owner` role on the service/database with `firebase dataconnect:sql:grant --role owner --email vercel-erp@petroblend-erp.iam.gserviceaccount.com --service petroblend-erp-service --location me-west1`.

In Vercel project settings, enable Secure Backend Access (OIDC) with team issuer mode. Keep the Cloud SQL connection private; do not enable broad public database access.

## Vercel environment variables

Set these as server-side environment values in Vercel (Production and Preview while testing):

```text
DB_ADAPTER=cloudsql
CLOUD_SQL_CONNECTION_NAME=petroblend-erp:me-west1:petroblend-erp-instance
PGDATABASE=postgres
GCP_PROJECT_NUMBER=408034291620
GCP_WORKLOAD_IDENTITY_POOL_ID=vercel-erp
GCP_WORKLOAD_IDENTITY_POOL_PROVIDER_ID=vercel-erp
GCP_SERVICE_ACCOUNT_EMAIL=vercel-erp@petroblend-erp.iam.gserviceaccount.com
JWT_SECRET=<generate a long random secret; do not commit it>
```

No `VITE_` database or credential variable is needed. The frontend calls the API on the same origin. The API function is pinned to Vercel's Dubai region (`dxb1`) to stay close to the database and users.

Once the backend is deployed, open `/api/health` and confirm it reports `database: connected`; then open the main page and create the first Super Admin using a new password. Exercise login, procurement, inventory, manufacturing, quality, sales, accounting, imports, uploads/downloads, and audit logs before storing company data.

## Future company PostgreSQL server

Switch the server configuration to:

```text
DB_ADAPTER=postgres
DATABASE_URL=postgresql://<user>:<password>@<company-host>:5432/<database>
```

Keep `DATABASE_URL` server-side, use TLS when supported by the company server, and run the same schema initializer/migrations against a compatible PostgreSQL database. No UI or business-route rewrite is intended for this change.

## Storage and backups

Attachments and company logos are stored as PostgreSQL byte data so they survive Vercel function restarts. Vercel's local filesystem is only temporary. Hosted database backups and restore operations must be managed from Firebase/Cloud SQL; SQLite file backup and restore endpoints are local-only.

## Trial limits

Firebase documents the Spark SQL Connect Cloud SQL instance as a 90-day no-cost trial. It is archived after the trial unless the project is upgraded, and eventually deleted. Keep the test within that period and do not change the Firebase billing plan without the account owner's decision. See [Firebase SQL Connect pricing](https://firebase.google.com/docs/sql-connect/pricing).

## Verification status

- Local SQLite end-to-end workflow suite: 12 workflows passed after the hosted API and binary-storage changes.
- TypeScript check and Vite production build: passed.
- Vercel API bundle and live Firebase PostgreSQL access: not yet verified. Those checks require the one-time Workload Identity and SQL role setup above.

