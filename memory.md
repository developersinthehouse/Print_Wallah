# Print Wallah project memory

Read this first. It describes the verified current state (last updated 2026-10-01, v2 payment/UI release). When code and this file disagree, the code is right: fix this file.

## Current State

Print Wallah is a multi-tenant printing-shop platform by **DEVELOPERS** with three surfaces: Super Admin (`/`), Shop Admin (`/admin`), Customer portal (`/shop/:shopId`, reached by each shop's QR). One Express service serves API and static frontend, so there is no separate frontend port, API URL or CORS setup.

Working end to end and tested (see Testing): customer upload, settings, real preview, server pricing, **Pay with UPI** and cash, shop verification, print queue, Python agent, status tracking, Super Admin/Shop Admin screens, dark UI.

## Architecture

- Backend: Node 20+, Express, PostgreSQL (`pg`). `src/server.js` (boot, helmet, rate limits, LAN banner), `src/routes/api.js` (all routes, order/payment state machine, photo-sheet PDF), `src/services/{core,upi,webhook,network,audit}.js`, `src/middleware/auth.js`.
- Frontend (no framework): `public/index.html`, `styles.css` (dark design system), `app.js` (shared helpers, router, login, Super Admin, Shop Admin), `customer.js` (customer portal, preview, UPI/cash checkout, tracking). `public/vendor/pdfjs/` is pdf.js 3.11.174 (Apache-2.0) used for the real PDF preview, served locally because the CSP allows only `'self'`.
- Print agent: `agent/print_agent.py` (stdlib Python) polls the API, runs a configured OS print command without a shell, keeps a local journal so a job id never prints twice, sends a heartbeat every 20 s even during a long print.
- Auth: JWT (issuer `print-wallah`) in an HTTP-only SameSite=Lax cookie. Shop sessions carry a stamp (`pv`) of the admin email+password hash, so changing either logs old sessions out.
- Logo: `<img id="brand-logo" src="/assets/logo.png">`. If `public/assets/logo.png` does not exist the server answers that URL with `assets/logo-placeholder.svg`. **Drop the real logo in as `public/assets/logo.png`** (see `public/assets/README.md`). No CSS or text logo exists anywhere. Favicon currently points at the placeholder.
- Design: dark surfaces (`#0c110f`/`#131a17`), brand `#125948` (buttons, selected state), `#0E4A38` (hover), `#5fd0ac` for focus/links. No fake data, glow, live dots or decorative effects. Empty states are real.

## Database schema overview

`db/schema.sql` creates:

- `shops`: tenant identity, admin hash, JSONB pricing/print settings, UPI identity, start/end access, lock state, hashed print-agent token, heartbeat.
- `uploads`: shop-bound upload token, private stored filename, MIME, size, detected page count, two-hour expiry.
- `orders`: shop/upload references, optional generated print-ready photo-sheet PDF filename, immutable print config and price breakdown snapshot, payment/order/print state, customer contact optional, timestamps. One upload token can create only one order.
- `payments`: one UPI payment record per order, reference, verification status and actor (`shop admin` or `webhook`).
- `order_uploads`: the photos of a multi-photo sheet order (quantity, position); `payment_events`: log of signed webhook events (unique per provider+event id).
- `print_jobs`: unique order job with queue/lease/retry/error information. `FOR UPDATE SKIP LOCKED` ensures one worker claims an item.
- `access_extensions`: extension history.
- `audit_log`: shop creation/update/lock/extend and shop/order actions.

Indexes support shop access checks, order histories, payment history and print queues. `touch_updated_at()` maintains update timestamps. Server startup initializes the idempotent schema. Database user needs schema/table creation and `pgcrypto` extension privileges.

## Authentication and tenant isolation

- Platform root (`/`) is the Super Admin login/entry. Shop admin login is available by switching login mode.
- Customer ordering uses `/shop/:publicId`; there is no default shop.
- Shop public IDs are random (format below).
- API queries for admin operations scope by the authenticated shop UUID; admin middleware also checks the shop's active/unlocked state on each request.
- Upload tokens are shop scoped and expire. Documents are not served statically.
- Print-agent tokens are 256-bit random values; only SHA-256 hashes are stored. The token is revealed once at shop creation or rotation.
- Public order endpoints are keyed by the unguessable order code; `GET /orders/:code` also returns the shop's UPI link while a UPI payment is unpaid (the UPI ID is shown to customers anyway).

Shop public IDs (new shops): 10 characters from `ABCDEFGHJKLMNPQRSTUVWXYZ23456789`. Older shops keep their original 8 character IDs. Lookups are case-insensitive (`/shop/abc...` works). Order codes: `PR-<time36>-<10 hex>`.

## Order and payment state machine

`orders.order_status`: `pending_payment` (UPI link issued, customer has not claimed) -> `payment_review` (customer tapped "I have paid") -> `print_queued` (shop verified or webhook) -> `printing` (agent claimed) -> `completed` | `failed`. Cash: `cash_confirmation_pending` -> `print_queued`. Any unprinted state -> `cancelled`.

- A print job is created only when payment is verified (`queueForPrint`), never earlier. The agent's claim query additionally requires `order_status='print_queued' AND payment_status='verified'`.
- Order creation is idempotent per upload token (double tap, refresh, retry return the existing order, `resumed:true`). Amount is recomputed server-side; the browser may send `expectedAmount` and gets `409 PRICE_CHANGED` if the shop changed rates.
- Customer actions (`/orders/:code/payment-claim|switch-cash|cancel`) use row locks and only work while the UPI payment is unclaimed (cash orders: until confirmed). After a claim only the shop can resolve it.
- Cancelling a queued order deletes its queued job. "Retry print" re-queues with a **new job id**, which is what lets the agent's local journal print it again (the old id stays remembered as printed/uncertain).
- Expired agent leases (15 min): job returns to the queue; after 5 attempts it becomes `failed` and the order shows the error.
- Cancelled or failed UPI payments never create jobs. Refunds are manual.

## UPI payments

- Link: `upi://pay?pa=<shop upi>&pn=<payee>&am=<server amount>&cu=INR&tr=<order code>&tn=Print order <code>` (`src/services/upi.js`). Shop UPI IDs are validated and lower-cased on create/edit (`name@psp`); a shop with a missing or invalid ID cannot take UPI orders (cash still works).
- Phones: button opens the UPI app (also auto-launched right after order creation). Desktop: QR of the same link. Copy buttons for ID/amount/note. Returning to the tab scrolls to the "I have paid" box.
- **Not automatic**: a UPI link cannot report success. The shop verifies in its own UPI app (order code is in the note) and presses "Payment received". See `docs/PAYMENTS.md`.
- Optional automatic confirmation: `POST /api/payments/webhook` (HMAC-SHA256 header `X-PW-Signature`, secret `PAYMENT_WEBHOOK_SECRET`, off by default). Idempotent by `eventId` (`payment_events` table), exact amount match required. No provider-specific adapter exists; a provider account and adapter are needed to use it.
- Some UPI apps flag pre-filled amounts to personal UPI IDs; a merchant UPI ID is more reliable.

## Customer portal

Upload (PDF/JPG/PNG, XHR progress, size/type/corruption checks; images over 12000 px rejected) -> settings (copies, page range with live validation, colour, sides, paper size/type, orientation, scaling fit/fill/actual) -> preview -> server quote (`/price` with the upload token, identical code path to the order) -> UPI or cash -> tracking screen with polling, queue position, printer-offline notice. Order code is kept in `localStorage` and `?order=` so a refresh or return from a UPI app resumes the same order.

- Preview: real PDF page rendered with pdf.js onto a sheet with the chosen paper size, orientation, printable-area margin (4 mm dashed), scaling mode, B&W filter, copies stack, duplex front/back caption, page navigation over the selected range, honest warnings (actual size cut off, fill crops, landscape on a portrait page). Labelled approximate.
- Photo mode (images, glossy): up to 12 different photos with quantity each, packed in sequence onto shared sheets. Sizes: passport 3.5x4.5, stamp 2x2.5, 2x2 in, wallet 5x7.5, 4x6, 5x7. Grid is rotated 90 degrees when that fits more (passport on A4 = 28 per sheet). Crop-to-fill or whole-photo. Preview grid uses the same maths as the server (`photoGeometry`). The generated sheet PDF has hairline cut guides.
- Documents are one file per order. There is no multi-document cart.

## Pricing

`pricing` JSONB per shop: `bw_a4,color_a4,bw_a3,color_a3,glossy_a4,photo_sheet` plus optional `glossy_a3` and `photo_sheet_a3`. When an optional key is unset, glossy A3 uses the A3 colour/B&W rate and A3 photo sheets use `photo_sheet` (legacy behaviour). Duplex halves sheets per copy. All money is computed on the server; zero totals are refused. Page ranges are parsed strictly (`all`, `3`, `1-3,5`).

## Shop Admin

Overview (needs-attention counts include UPI awaiting customer), order desk (search/filter, 15 s auto refresh that keeps filters and does not run while typing or when a dialog is open), actions: Confirm cash, Payment received / Not received, Cancel, Mark complete / failed, Retry print, download file (photo orders download the generated sheet). Print errors from the agent are shown on the order. 401 anywhere returns to the login screen.

## Super Admin

Create/edit shops (UPI validated, optional A3 prices), QR (uses the browser's address in development), lock/unlock, extend, details. Duplicate shop admin email returns 409. Super login failures are logged server side with the reason (not configured / wrong email / wrong password).

## Environment / Setup

`.env.example` is the reference. Required: `DATABASE_URL`, `JWT_SECRET` (32+), `SUPER_ADMIN_EMAIL`, `SUPER_ADMIN_PASSWORD`. `HOST` defaults to `0.0.0.0` (LAN). Production needs `APP_URL` (https), persistent private `UPLOAD_DIR`, `NODE_ENV=production`. Optional `PAYMENT_WEBHOOK_SECRET`. The server reads `.env` only at start: **restart after editing it** (a stale password is the usual cause of a Super Admin 401). Schema is applied idempotently at startup (`db/schema.sql`, requires the `pgcrypto` extension).

Development on a phone: `npm run dev` (or `npm start`) prints `Local:` and `Network:` URLs. Open the Network URL on the phone (same Wi-Fi), sign in to Super Admin there, and shop links/QR codes will contain that address. If it does not connect, allow Node through the OS firewall for private networks. CSP `upgrade-insecure-requests`, HSTS and COOP are production-only so plain-HTTP LAN testing works.

## Integration Contracts

API reference: `docs/API.md`. Payments: `docs/PAYMENTS.md`. Agent: `docs/PRINT_AGENT.md`, endpoints `POST /api/agent/:shop/heartbeat`, `GET .../jobs` (claims one job, returns `{job:null}` when none or when the shop is locked), `GET .../jobs/:id/document`, `POST .../jobs/:id/result {status,error?}`; Bearer agent token, scoped to its shop.

## Testing

`npm test` (11 unit tests), `npm run smoke`, `npm run test:payments` (need a running server and the same `.env`; payments test needs `PAYMENT_WEBHOOK_SECRET` set for both), Python `agent/test_agent.py` (3 tests). `npm run test:all` runs the JS suites. On 2026-10-01 all passed against PostgreSQL 16. A real headless Chromium run (phone 360/390 px over the LAN address, tablet, desktop) covered: Super Admin login (bad then good), shop creation via the modal, customer PDF upload with painted preview, range validation, UPI link contents, refresh/resume, shop admin login, claim, verify, customer auto-update, two-photo sheet, cash path, bad shop URL, no horizontal overflow, zero console/page/network errors. The real Python agent was run against the server with a stand-in print command (claim, print command arguments, completed). Not tested: a physical printer, a real UPI app or phone, a payment provider, iOS Safari, Render deployment.

## Completed

All of the above, plus the fixes listed in the Change Log.

## Pending

1. Real logo file (`public/assets/logo.png`).
2. Per-shop onboarding: real UPI ID (merchant preferred), prices, printer test with the agent's `print_command`.
3. Automatic UPI verification needs a provider account plus an adapter to the webhook contract.
4. Production deployment (Render, persistent disk, https `APP_URL`), document retention policy, object storage.
5. Multi-document orders, staff accounts per shop, refunds workflow.

## Known Issues / Limitations

- UPI success cannot be detected automatically (see UPI payments).
- A UPI order the customer never pays stays `pending_payment` until cancelled by the customer or shop (no auto-expiry, deliberately, to avoid cancelling an order whose money arrived late).
- Preview is approximate: it cannot know a printer driver's real margins or colour handling.
- `storage/` and `.test-postgres/` in the project folder contain leftovers from earlier testing; they are not used by the code and can be deleted. `storage/` must not be committed or deployed with test files.
- `pdf-parse` prints "Warning: Indexing all PDF objects" for some PDFs; harmless.
- Agent `print_command` placeholders must cover every option a shop enables (the agent refuses a job rather than silently ignoring an option).

## Important Decisions

- Keep dependencies modest, no frontend framework. pdf.js is vendored for the preview.
- Backend is authoritative for shop data, prices, UPI ID, amounts and state; the browser only displays.
- A UPI link is a payment request, never proof of payment.
- Jobs are created at verification time; agent journal + new job id on retry prevents double printing while still allowing deliberate reprints.
- One admin account per shop (on the shop row).

## Change Log

- 2026-10-01 v2:
  - Root causes of earlier reports: `GET /api/super/shops/:id` 500 was SQL (reserved-word aliases in the stats query, already fixed in the previous session and covered by smoke); Super Admin 401 comes from credentials not matching `.env` as loaded at server start (now logged with the reason). Both flows pass tests.
  - Added full UPI flow, order states, idempotency, price-changed guard, resume, switch-to-cash, cancel, webhook integration point, `payment_events`, `order_uploads`, `orders.payment_claimed_at`.
  - Print safety: cancel deletes queued job, agent claim guard, retry issues new job id, lease expiry fails after 5 attempts, complete only from printing, agent heartbeat during printing.
  - Server: binds `0.0.0.0`, LAN banner, dynamic QR base URL, dev-safe helmet, rate limits sized for polling, startup config validation.
  - Admin: session stamp, 409 on duplicate admin email, UPI validation, optional A3 prices, auto-refresh, UPI-aware order actions.
  - UI: dark redesign, logo image slot (no PW mark), customer portal rewrite (real preview, multi-photo sheets, rotation-aware layouts), mobile-first layout.
  - Corrected this file: public shop ID length, branding assets, storage leftovers.
