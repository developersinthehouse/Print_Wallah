# Print Wallah Backend

## Storage

The backend uses PostgreSQL. It connects to the database named by `DATABASE_URL`; this repository does not provision a hosted database or contain connection credentials. For local development, run PostgreSQL locally and point the URL in `.env` to it. For deployment, use a managed PostgreSQL connection URL from the team's chosen provider and set `DATABASE_SSL=require` when required by that provider.

PostgreSQL stores shop profiles and rates, print-job metadata, subscription/payment logs, and admin audit events. Print document bytes are not stored in PostgreSQL: the customer uploader's object/file-storage service owns those bytes, while `print_jobs.file_url` stores the URL used by the desktop agent. No object-storage provider is configured by this backend.

## Setup

1. Install Node.js 18 or later and Docker Desktop.
2. Copy `.env.example` to `.env` only if `.env` does not already exist. If it exists, merge in missing settings without overwriting your local admin credentials. Set a local PostgreSQL password, distinct JWT secrets, payment webhook secret, onboarding URL, plan durations, and a unique `SUPER_ADMIN_PASSWORD` of at least 12 characters.
3. Start the local database and apply migrations:

```powershell
docker compose up -d postgres
npm install
npm run migrate
```

4. Create the first super-admin account, then remove `SUPER_ADMIN_PASSWORD` from `.env`:

```powershell
npm run admin:bootstrap
```

5. Start the API and sign in at `/super-admin`:

```powershell
npm start
```

The API serves the shop dashboard at `/shop-admin`, the DEVELOPERS panel at `/super-admin`, and reports database connectivity at `/healthz`. Admin login is handled by `/api/admin-auth/login`; passwords are stored as scrypt hashes and sessions use 15-minute JWTs. Server startup also applies pending migrations and starts the subscription expiry monitor.

Compose stores local PostgreSQL data in the persistent Docker volume `print_wallah_pg_data` and binds its port only to `127.0.0.1`. Never commit `.env`; the example values are for local development only, not production credentials. Database behavior is covered with `pg-mem`; Docker/PostgreSQL was unavailable in the implementation environment, so the Compose service and real connection still need verification there.