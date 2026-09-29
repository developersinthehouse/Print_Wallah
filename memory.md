# Print Wallah Project Handoff

Last updated: 2026-09-30

## Project Snapshot
- Workspace root: `D:\DEVELOPERS\Websites and Softwares\Print Wallah`.
- This is the unified active application: Node.js/Express + PostgreSQL backend, static HTML/vanilla-JS customer and admin pages, and a Python Windows print agent.
- `2nd developer code/` was compared, its compatible setup/settings/assets features were integrated, and the duplicate folder was deleted. Do not recreate it or copy its older files over the active code.
- The active customer-order and print-agent implementation is more complete than the duplicate. Preserve it when making changes.
- Do not read or print `backend/.env` secrets into chat, logs, or this handoff. The app currently uses a managed PostgreSQL URL with SSL enabled; credentials are local configuration only.

## Implemented Features

### Customer print flow
- `frontend/customer/index.html` is served at `/`, `/start`, `/customer`, and `/shop/:shopId`.
- `/` redirects to `/start`; without a shop QR/link, the customer page asks for a shop link.
- `backend/routes/customerRoutes.js` is mounted at `/api/customer`.
- `GET /api/customer/shops/:shopId` returns active shop name, UPI payee, and B&W/color rates.
- `POST /api/customer/orders` accepts PDF/PNG/JPG uploads, validates size/type/signature and page count, calculates price on the server, and creates a pending PostgreSQL print job.
- Customer checkout creates a UPI deep link for the saved shop VPA and displays the payee. Returning from a UPI app is not payment proof.
- Uploaded documents use local storage under `backend/uploads/customer` by default. Configure a private persistent `CUSTOMER_UPLOAD_DIR` for deployment; multi-instance hosting needs shared storage.

### Shop/admin and subscription flow
- `/shop-admin` serves `frontend/views/shop-admin.html`; `/super-admin` serves `frontend/views/super-admin.html`.
- Super-admin login/bootstrap uses scrypt password hashes and short-lived JWT sessions. Bootstrap command: `npm run admin:bootstrap` from `backend/`; it refuses to overwrite an existing admin.
- Super-admin can view metrics/shop directory, onboard shops, and lock/extend subscriptions with audit records.
- Onboarding issues a raw, one-time owner setup code expiring in seven days. Only the hash/expiry is stored in the active `shop_admin_users` model (migration `007_shop_admin_setup_tokens.sql`). The code is returned once and is not emailed.
- Shop owner activates at `/shop-admin` using shop ID, registered email, code, and a password of at least 12 characters; then signs in. Both setup and login issue 15-minute shop-admin JWTs.
- Shop admins can update B&W/color rates and UPI ID via `PUT /api/shops/:shopId/settings`. Customer shop details and generated UPI links use that same saved ID.
- Shop dashboard includes print history, manual payment confirmation, and creation/list/revocation of per-computer print-agent tokens. The raw token is only shown once.
- Only shop admins can change rates/settings or confirm customer payments. Print agents are scoped to a shop, can poll ready/paid jobs, download eligible customer files, and report print results.
- Subscription expiry enforcement, background expiry locking, signed payment-renewal callbacks, and audit logging are present.

### Desktop print agent
- `desktop-agent/agent.py` polls ready jobs, uses a bearer token, downloads through the shop API, sends copies to the Windows default printer, and reports success/failure.
- Required environment variables: `PRINT_WALLAH_API_URL`, `PRINT_WALLAH_SHOP_ID`, and `PRINT_WALLAH_AGENT_TOKEN`.
- Install dependencies with `py -m pip install -r desktop-agent/requirements.txt` before testing/running the agent.

## Important Files And Routes
- Server/wiring/startup: `backend/server.js`.
- DB config/pool/migrations: `backend/config.js`, `backend/db/pool.js`, `backend/db/migrations/`.
- Repositories: `backend/postgresRepositories.js`.
- Shop/admin API: `backend/shopRoutes.js`, `backend/adminRoutes.js`, `backend/shopSessionRoutes.js`, `backend/adminSessionRoutes.js`.
- Customer API/UI: `backend/routes/customerRoutes.js`, `frontend/customer/index.html`.
- Admin UIs: `frontend/views/shop-admin.html`, `frontend/views/super-admin.html`.
- Branding assets are at the workspace root and served from `/assets/pw_logo.jpeg` and `/assets/developers-logo_nobg.webp`.
- Useful browser URLs for local PORT 3000: `/`, `/start?shopId=<shop-id>`, `/shop-admin`, `/super-admin`, `/healthz`.

## Verified Status
- Backend test command is `npm test` from `backend/`. Latest full run passed all 46 tests (2026-09-30); tests use `pg-mem` for DB behavior.
- The edited backend modules and inline scripts in all three HTML pages passed syntax checks; editor diagnostics were clear at last validation.
- End-to-end smoke test against the configured external PostgreSQL succeeded: `/healthz` returned `{"status":"ok","database":"connected"}`; `/`, `/shop-admin`, and `/super-admin` returned HTTP 200 at port 3000.
- Python agent tests were not run successfully in the prior environment because `requests` was not installed. Install `desktop-agent/requirements.txt`, then run `py -m unittest discover -s desktop-agent -v`.

## Current Run State And Startup Issue
- User explicitly wants port 3000. `backend/.env` has `PORT=3000`; run from the `backend/` directory with `npm start`.
- Latest observed listener on port 3000 served `/healthz` with a connected DB and all three pages with HTTP 200. Check the port/health before launching another instance; do not terminate a process without confirming it is the Print Wallah process.
- A separate `npm start` attempt has reported `TypeError: Cannot read properties of null (reading 'port')` at `backend/server.js` in `main()`, on `runningServer.server.address().port`. This can appear even while another listener is healthy. Investigate the process/listen/close race before treating the site as down; do not merely hide the error by replacing it with the configured port.
- To check current state safely from PowerShell:

```powershell
Get-NetTCPConnection -State Listen -LocalPort 3000
Invoke-WebRequest http://localhost:3000/healthz
```

- If startup fails, capture the complete new error and check whether another process owns port 3000. Avoid printing `.env` or its full database URL.

## Run And Test Commands
From workspace root:

```powershell
Set-Location backend
npm ci
npm test
npm start
```

`npm start` runs the server and applies pending migrations. Keep its terminal open. To bootstrap the first admin, configure `SUPER_ADMIN_EMAIL` and a unique `SUPER_ADMIN_PASSWORD` (12+ chars) in `backend/.env`, run `npm run admin:bootstrap` once, then remove the plaintext password from `.env`. Do not rerun bootstrap if the admin account already exists.

Python agent tests, from workspace root:

```powershell
py -m pip install -r desktop-agent/requirements.txt
py -m unittest discover -s desktop-agent -v
```

## Known Product/Deployment Caveats
- Customer order payment is a UPI intent plus manual shop-admin verification; there is no automatic customer-payment settlement verification. Do not make an order print-ready solely because the customer returned from the UPI app.
- PostgreSQL order/job state is persisted, but uploaded document bytes are local files unless `CUSTOMER_UPLOAD_DIR` points at durable private storage.
- Real PostgreSQL connectivity was smoke-tested, but automated DB tests use `pg-mem`; keep migrations compatible with PostgreSQL and test production migrations carefully.
- Customer page loads Tailwind from its CDN, so that styling needs network access unless bundled locally.
- When changing code, preserve active customer routes/order storage and the active agent's safe-download and copies behavior. Avoid overwriting current user edits; this workspace has no Git repository metadata available for a normal diff/status workflow.
