# Print Wallah Handoff Memory

## Current Status
- Reviewed `prd.md`, `architecture.md`, `rules.md`, `phases.md`, and `design.md` before starting Phase 2.1.
- Implemented `desktop-agent/agent.py`: authenticated shop-scoped polling, download and Windows default-printer dispatch, result reporting, structured local logging, exponential retry, and a 60-second subscription recheck pause on 403 so renewal can resume polling without a process restart.
- Added `desktop-agent/requirements.txt` with the `requests` runtime dependency.
- Validation: Python syntax compilation passed with Python 3.14.2; `desktop-agent/test_agent.py` confirms the agent rechecks after expiry.
- Implemented Phase 2.2 with `backend/shopRoutes.js`, `backend/package.json`, route tests, and `frontend/views/shop-admin.html`.
- Implemented Phase 2.3 with subscription middleware, an expiry sweep scheduler, a signed renewal callback, and a locked dashboard state.
- Implemented Phase 2.4 with a JWT-protected super-admin API, QR-backed shop onboarding, platform metrics, audited manual subscription controls, and `frontend/views/super-admin.html`.
- Added super-admin bootstrap and login with scrypt password hashes, 15-minute JWT sessions, generic credential failures, and per-address login throttling. The panel now includes sign-in, sign-out, and expired-session recovery.
- Selected PostgreSQL and added migrations, transactional repositories, JWT shop authentication, configuration, and the integrated `backend/server.js`.
- Validation: `npm test` in `backend/` passes all 42 tests, including PostgreSQL adapter, integrated login-to-onboarding, and bootstrap safety coverage. Python agent test and compile passed; VS Code diagnostics reported no errors. Admin login and five-metric panel rendered at 1440px and 390px without horizontal overflow. npm reported 0 vulnerabilities.
- Server startup now binds the HTTP listener before creating the periodic expiry timer, avoiding a background task if the port cannot be bound.
- No real PostgreSQL URL, hosted provider credentials, or object-storage provider is configured in this workspace. Docker Desktop is installed per-user, but its engine cannot start because WSL is not installed; Docker requests `wsl --install` from an administrative PowerShell followed by a Windows restart. PostgreSQL service is absent.
- User-provided initial super-admin credentials are stored only in ignored `backend/.env`; the tracked `.env.example` stays blank. `git check-ignore backend/.env` confirms exclusion. Account bootstrap is still pending a PostgreSQL runtime and the other required backend secrets/configuration.
- The user rotated the local bootstrap password; its value is intentionally not recorded here. `backend/.env` remains ignored by Git.
- Downloaded the official Docker Desktop Windows installer to the user's Downloads folder; file size is 627,791,792 bytes and Authenticode status is Valid with Docker Inc as signer. It was installed per-user, but Docker's own startup log confirms WSL is missing; database startup/admin bootstrap remain blocked on WSL installation and reboot.
- Removed user-provided admin credentials from the tracked `backend/.env.example`; it now contains blank bootstrap fields. The provided password did not meet the 12-character bootstrap policy, and no local `.env` or PostgreSQL runtime exists to create the account.

## Agent Configuration
Required environment variables:
- `PRINT_WALLAH_API_URL`: backend origin, for example `https://api.example.com`.
- `PRINT_WALLAH_SHOP_ID`: shop identifier used to scope every job request.
- `PRINT_WALLAH_AGENT_TOKEN`: bearer token sent to backend endpoints.

Logs are written to `%LOCALAPPDATA%\\PrintWallah\\agent.log` (or `~/.printwallah/agent.log` when `LOCALAPPDATA` is unavailable); downloaded files are retained under the adjacent `spool` directory so the Windows print handler can read them after dispatch.

## Assumed Backend Contract
The source docs do not define concrete API routes or response schemas. The agent currently assumes:
- `GET /api/shops/{shopId}/print-jobs?status=READY_TO_PRINT` returns either a JSON array or `{ "jobs": [...] }`.
- Each job has `id` and an absolute HTTP(S) `fileUrl` (preferably a short-lived signed URL).
- After dispatch, `POST /api/shops/{shopId}/print-jobs/{jobId}/status` accepts `{ "status": "PRINTED" }` or `{ "status": "PRINT_FAILED", "error": "..." }`.
- A `403` from polling means the shop is expired/locked; polling pauses for 60 seconds before retrying so it resumes automatically after renewal.
- File printing uses the Windows shell `print` verb, which targets the machine's default printer and only confirms dispatch, not physical completion.

The in-memory handled-job set prevents repeat dispatch while this process is running if status reporting fails. The backend should make job claiming/result transitions idempotent; cross-restart deduplication is not implemented yet.

## Next Steps
1. Install Docker Desktop, copy `backend/.env.example` to `backend/.env`, set temporary bootstrap credentials, start `docker compose up -d postgres` from `backend/`, run migrations/admin bootstrap, remove the plaintext password, then start and verify the server; alternatively use the team's managed PostgreSQL URL.
2. Align the print-job schema and `fileUrl` values with the customer uploader/backend; document and configure that team's object-storage provider separately.
3. Configure the actual payment-provider signature/payload and align dashboard session keys with the shared login flow.
4. Verify authenticated end-to-end flows and physical printing with the target Windows printer.

## Known Data Model Context
The architecture doc names `ShopProfile`, `SubscriptionLogs`, and `AdminAudit`; these are PostgreSQL tables `shop_profiles`, `subscription_logs`, and `admin_audit`. Subscription handling uses `subscription_expiry_date` and `subscription_status` (`ACTIVE`, `EXPIRED`, or `LOCKED`) on shop profiles. PostgreSQL is selected, but no live database URL is configured.

## Phase 2.2 API and Integration Contract
- Mount `createShopRouter(...)` from `backend/shopRoutes.js` at `/api/shops` in the shared Express server.
- Supply `shopRepository.getRates(shopId)` and `shopRepository.updateRates(shopId, rates)` adapters.
- Supply `printJobRepository.getSummary(shopId, { from, to })`, `listForShop(shopId, { from, to, limit, offset, status })`, and `updateResult(shopId, jobId, { status, error })` adapters. `listForShop` returns `{ jobs, total }`.
- Provide `authenticateShop` middleware that sets `req.auth.shopId`, plus active-subscription middleware. The router checks that the authenticated shop matches `:shopId` on every route.
- Dashboard uses `GET /api/shops/:shopId/dashboard?from=<ISO>&to=<ISO>` and `PUT /api/shops/:shopId/rates` with numeric `blackAndWhitePerPage` and `colorPerPage` fields. It expects summary `{ totalPrints, revenue }` and job fields `id`, `documentName` or `fileName`, `createdAt`, `pageCount`, `totalAmount`, and `status`.
- Print agent endpoints align with `GET /api/shops/:shopId/print-jobs?status=READY_TO_PRINT` and `POST /api/shops/:shopId/print-jobs/:jobId/status`.
- The dashboard reads `printWallahShopId`, `printWallahAccessToken`, and optional `printWallahApiBase` from `sessionStorage`; align these names with the customer app.
- PostgreSQL persistence is implemented through `backend/postgresRepositories.js`; `DATABASE_URL` selects local or hosted PostgreSQL. The customer uploader remains responsible for file bytes; jobs store the existing `file_url` only.

## Phase 2.4 Super-Admin Contract
- Mount `createSuperAdminRouter(...)` from `backend/adminRoutes.js` at `/api/admin`. It exposes `GET /plans`, `GET /metrics`, `GET /shops`, `POST /shops`, and `PATCH /shops/:shopId/subscription`.
- Protect the router with `createSuperAdminAuth({ jwtSecret, issuer, audience })`. Tokens must be HS256, valid for the configured issuer/audience, carry `role: "SUPER_ADMIN"`, and include an admin subject in `sub`. `createSuperAdminSessionRouter` issues these after scrypt password verification.
- Run `npm run admin:bootstrap` once with temporary `SUPER_ADMIN_EMAIL` and `SUPER_ADMIN_PASSWORD` values in `backend/.env`; remove the plaintext password immediately after bootstrap. Login is throttled and issues a 15-minute token.
- `planDurationsDays` is trusted server configuration shared with subscription callbacks. The onboarding URL is configured server-side; returned QR content appends the unique `shopId` query parameter.
- Repository methods: `shopRepository.findById`, `listShops({ limit, offset, status, search })`, `getSubscriptionCounts(now)`; `printJobRepository.getPlatformVolume()`; `adminRepository.createShopWithAudit({ shop, audit })`; `adminRepository.updateSubscriptionWithAudit({ shopId, expectedExpiry, update, audit })`.
- Create/update-with-audit operations must be transactional. Manual lock and plan-based extension require a reason, and extension uses compare-and-set `expectedExpiry` to avoid overwriting concurrent renewals.
- The UI signs in through `/api/admin-auth/login`, reads/writes `printWallahAdminToken` in `sessionStorage`, and accepts optional `printWallahAdminApiBase`. Login-to-protected-route behavior is covered by the server integration test.

## PostgreSQL Storage
- `backend/.env.example` documents the connection and secret settings. There is no provider account or live URL in the repository; local PostgreSQL or a team-selected managed PostgreSQL provider supplies `DATABASE_URL`.
- Local Compose storage uses the persistent Docker volume `print_wallah_pg_data`, with PostgreSQL bound to loopback only. Docker was not installed in the current environment, so this bootstrap is written but unverified.
- `backend/db/migrations/001_initial_schema.sql` creates shop profiles, print jobs, subscription logs, admin audits, and indexes. `npm run migrate` applies migrations; `npm start` also applies pending migrations before listening.
- `backend/db/migrations/002_super_admin_users.sql` adds admin login storage; passwords are scrypt hashes, not plaintext.
- `backend/adminSessionRoutes.js` accepts admin credentials at `/api/admin-auth/login`, uses scrypt and in-process per-IP rate limiting, and returns a 15-minute admin JWT. `backend/scripts/bootstrapAdmin.js` creates the initial account once without overwriting an existing email.
- `backend/server.js` mounts the payment callback before shop/admin APIs, uses PostgreSQL repositories, exposes `/healthz`, `/shop-admin`, and `/super-admin`, and starts the expiry sweep.
- Repository transaction tests use `pg-mem`, not a live PostgreSQL server. Verify actual Postgres behavior and hosted SSL configuration after setting a real URL.
- This DB stores metadata and accounting values, not uploaded document files. `print_jobs.file_url` points to storage owned/configured by the separate customer upload stream; this project does not yet know which bucket/provider that is.

## Phase 2.3 Subscription Contract
- `createSubscriptionCheck({ shopRepository })` is the `requireActiveSubscription` middleware expected by `createShopRouter`. It reads `req.auth.shopId`, calls `findById(shopId)`, fails closed for missing/invalid/expired dates, and uses `lockIfExpired(shopId, now)` before returning `403 { error: "SUBSCRIPTION_EXPIRED", message: "Subscription Expired" }`.
- Start `startExpiryMonitor({ shopRepository })` once during server startup. It runs immediately and every 60 seconds; `findExpiredShops(now)` should query expiry at/before now and exclude already expired records. `lockIfExpired` must update conditionally so the sweep is safe across multiple app instances.
- Mount `createSubscriptionRouter(...)` at `/api/subscriptions`. Its callback endpoint is `POST /payment-callback` and expects raw JSON signed in `x-payment-signature` as `sha256=<hex HMAC-SHA256>` using a secret of at least 32 bytes. Mount this router before any global `express.json()` middleware so the raw body remains available for signature verification.
- A successful callback shape is `{ event: "payment.captured", status: "PAID", paymentId, shopId, planId }`. Plan IDs and whole-day durations come from server configuration, never from the callback. Non-paid events are acknowledged and ignored; invalid signatures are rejected.
- `shopRepository.applyVerifiedRenewal({ shopId, paymentId, planId, expectedExpiry, newExpiry, renewedAt })` must atomically deduplicate payment IDs, compare the expected expiry (return `{ conflict: true }` on race), update `subscription_expiry_date` and `subscription_status: "ACTIVE"`, and record `SubscriptionLogs` in the same transaction. Return `{ duplicate, subscriptionExpiryDate }` or `null` for a missing shop.
- Add database indexes/constraints for shop IDs and unique payment IDs in subscription logs. Provider signature verification is implemented, but live-provider payload/signature compatibility is unverified until the provider is selected.