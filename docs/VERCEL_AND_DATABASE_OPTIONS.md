Attempting to perform the InitializeDefaultDrives operation on the 'FileSystem' provider failed.
# Vercel and Neon test database setup

## Current setup

- GitHub repository: [`MohdTauheed05/ERP`](https://github.com/MohdTauheed05/ERP).
- Vercel project: `erp` under team `tauheed1`.
- Frontend: React/Vite static build on Vercel.
- API: Express routes exposed through Vercel Node functions.
- Database adapter: local SQLite for development; PostgreSQL for hosted use. The PostgreSQL adapter translates the existing synchronous SQLite-style calls and initializes the ERP schema on first connection.
- Uploads: hosted attachments and logos are stored in PostgreSQL so Vercel's temporary filesystem is not used for durable files.

## Neon test database

Use the account owner's Neon login (planned: `touheedshaikh8@gmail.com`) to create a free PostgreSQL project for testing. Choose Frankfurt (`eu-central-1`) when it is offered. The Vercel API is configured for Frankfurt (`fra1`) so database requests run beside Neon and avoid extra database round trips. The Neon free plan currently includes up to 1 GB of database storage per project; compute is limited, and inactive compute can scale to zero. This is suitable for a test environment, not a promise of always-on production service. Review Neon’s current [free plan limits](https://neon.com/pricing) before using the project.

In the Neon dashboard, create a database and copy its **pooled** connection string. Add these Vercel environment variables to **Preview** first (and Production only if intentionally testing on the public production URL):

```text
DB_ADAPTER=postgres
DATABASE_URL=<Neon's pooled PostgreSQL connection string>
JWT_SECRET=<long random secret>
```

Keep these as server-side variables. Do not use a `VITE_` prefix, commit the URL, or paste it into chat. Enable `sslmode=require` if it is not already part of Neon’s generated URL. `DATABASE_URL` must use the `postgresql://` scheme. The schema and seed/reference rows are created automatically the first time the API connects. Then check `/api/health`; it must return `database: connected` before creating the first Super Admin.

### Testing sequence

1. Confirm the deployment has `DB_ADAPTER=postgres`, `DATABASE_URL`, and `JWT_SECRET` in the selected Vercel environment.
2. Redeploy that environment so the function reads the new settings.
3. Open `/api/health`; confirm the response reports `database: connected`.
4. Open `/api/auth/status`; for a new empty database it should report that first-run setup is needed.
5. Create the test Super Admin and check login, masters, procurement, inventory, manufacturing, quality, sales, accounting, imports, attachments, and audit logs.
6. Test on Preview first. Keep production on its existing state until the Preview checks pass.

The database is separate from the existing Firebase project. No Firebase or Cloud SQL IAM grants are needed for Neon.

## Local Windows development

Leave the default local setting in `.env` as `DATABASE_URL=sqlite:///./data/lubricants_erp.db` for a quick offline start. To point a local run at Neon, set `DB_ADAPTER=postgres` and Neon’s pooled `DATABASE_URL` in the private `.env` file. Never commit `.env`.

## Deploy and verify

The Vercel project builds the frontend and routes `/api/*` requests into the Express API. Set the API variables in Vercel project settings, redeploy, then verify the health and first-admin endpoints above. Do not mark the live ERP as database-ready until those endpoints and the business workflow checks have passed against Neon.

For hosted PostgreSQL, SQLite file backup and restore endpoints are unavailable. Use Neon’s dashboard backup/restore tools and keep test data disposable. Attachments stored in PostgreSQL count toward the same database storage limit.

## Future company database

For a compatible PostgreSQL server later, keep `DB_ADAPTER=postgres` and replace only the private server-side `DATABASE_URL` with that server's TLS-enabled connection string. Never point the API at a company database before confirming PostgreSQL compatibility and taking a backup.

## Previous Firebase SQL Connect route

Firebase SQL Connect and its Cloud SQL trial are not required for this Neon test setup. The older Firebase integration branch and its setup instructions should not be used for this path. Firebase trial limits and end dates are independent of the Neon database.

