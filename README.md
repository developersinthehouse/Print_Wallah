# Print Wallah

The top-level folders are the single active application. They contain the unified backend, frontend, and print agent.

## Project Layout

- `backend/`: Express API, PostgreSQL migrations, customer uploads, admin dashboards' API, and tests.
- `frontend/customer/`: QR-linked customer order page.
- `frontend/views/`: shop and super-admin dashboards.
- `desktop-agent/`: Windows print agent.

## Backend Setup

Use Node.js 18 or later. From PowerShell at the project root:

```powershell
Copy-Item backend/.env.example backend/.env
```

Set distinct random JWT and webhook secrets in `backend/.env`. Configure `DATABASE_URL`, `DATABASE_SSL`, `PRINT_WALLAH_ONBOARDING_URL` (ending in `/start`), and subscription plans. For local PostgreSQL, start the Compose database from the backend directory, then install and run the API:

```powershell
Set-Location backend
docker compose up -d postgres
npm ci
npm run migrate
npm run admin:bootstrap
npm start
```

Remove `SUPER_ADMIN_PASSWORD` from `.env` after bootstrapping. The customer page is served at `/start`, shop operations at `/shop-admin`, the super-admin panel at `/super-admin`, and database health at `/healthz`.

For a single-instance deployment, set `CUSTOMER_UPLOAD_DIR` to a private persistent mounted directory. The default is `backend/uploads/customer`; container-local storage is not durable across replacement and must not be used for production.

Shop onboarding returns a one-time owner setup code that expires after seven days. Share it securely with the owner; they activate the account at `/shop-admin` with the shop ID, registered email, setup code, and a new password of at least 12 characters. The code is stored as a hash, is accepted once, and is not sent by email. Shop admins can set page rates and the UPI ID used by the customer checkout from the dashboard. Create one labeled print-agent token for each shop computer; its raw value is shown once. Revoke a token if the computer is replaced or its credential is exposed.

## Print Agent

From the project root:

```powershell
py -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r desktop-agent/requirements.txt
$env:PRINT_WALLAH_API_URL = 'http://localhost:3000'
$env:PRINT_WALLAH_SHOP_ID = 'your-shop-id'
$env:PRINT_WALLAH_AGENT_TOKEN = 'paste-the-one-time-token-from-the-shop-dashboard'
.\.venv\Scripts\python.exe desktop-agent/agent.py
```

The agent polls only paid, ready jobs and downloads each file through the shop-scoped API using its bearer token.

## Tests

```powershell
Set-Location backend
npm test
Set-Location ..
.\.venv\Scripts\python.exe -m unittest discover -s desktop-agent -v
```

## Payment And Storage

Customer orders are stored as pending PostgreSQL print jobs. A shop admin must verify the UPI transaction in the shop's account and enter its reference in the dashboard before the agent can fetch the document. This is manual reconciliation, not automated customer-payment verification. Document bytes use local disk under `backend/uploads/customer`; deployments must provide persistent private storage, and multi-instance deployments need a shared storage provider. Printer color handling depends on the shop's printer defaults.
