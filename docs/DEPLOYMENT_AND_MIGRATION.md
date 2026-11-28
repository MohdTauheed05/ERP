Attempting to perform the InitializeDefaultDrives operation on the 'FileSystem' provider failed.
# PetroBlend ERP deployment and database guide

## Local Windows setup

1. Install Node.js 20+.
2. Double-click `start.bat`, or run:

   ```cmd
   copy .env.example .env
   pnpm install
   pnpm dev
   ```

3. Open `http://localhost:3000` and create the first Super Admin.

The default local database is SQLite at `./data/lubricants_erp.db`, with local uploads in `./uploads` and snapshots in `./backups`.

## Hosted test setup with Neon

Use the account owner’s Neon account to create a PostgreSQL project. Neon’s free plan currently includes 1 GB per project and has limited compute, so use it for tests and demos with disposable data. Check the live [Neon pricing page](https://neon.com/pricing) before relying on its current limits.

In Vercel, add these private variables to Preview first:

```text
DB_ADAPTER=postgres
DATABASE_URL=<Neon's pooled PostgreSQL connection string>
JWT_SECRET=<long random secret>
```

Use the connection string Neon provides, with TLS enabled (`sslmode=require`). Do not expose it through a `VITE_` variable or commit it. The PostgreSQL schema and seed data initialize when the API connects for the first time.

After redeploying Preview, verify `/api/health` reports `database: connected` and `/api/auth/status` reports first-run setup. Create the test Super Admin, then check login, master data, procurement, inventory, manufacturing, quality, sales, accounting, imports, attachments, and audit logs. Only configure Production for testing when you intend to use the public production deployment.

## Uploads, backups, and database switching

On hosted PostgreSQL, attachments and logos are stored in the database. SQLite file snapshot and restore actions apply only to local SQLite. Manage hosted database backups through Neon, and treat the free test database as disposable.

For another compatible PostgreSQL server later, keep `DB_ADAPTER=postgres` and replace only the private server-side `DATABASE_URL`. Take a provider backup before moving any data. The Python FastAPI/Alembic project in `backend/` remains a partial prototype; the hosted Vercel API uses the Express routes.

