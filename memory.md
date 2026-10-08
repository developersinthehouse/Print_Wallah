# Print Wallah project memory

Read this first. It describes the verified current state (last updated 2026-10-02, v3 customer portal UX / redesign release). When code and this file disagree, the code is right: fix this file.

## Current State

Print Wallah is a multi-tenant printing-shop platform by **DEVELOPERS** with three surfaces: Super Admin (`/`), Shop Admin (`/admin`), Customer portal (`/shop/:shopId`, reached by each shop's QR). One Express service serves API and static frontend, so there is no separate frontend port, API URL or CORS setup.

Working end to end and tested (see Testing): customer upload, settings, real preview, **photo editing that is baked into the print file**, server pricing, **Pay with UPI** and cash, shop verification, print queue, Python agent, status tracking, Super Admin/Shop Admin screens, redesigned dark UI.

## Architecture

- Backend: Node 20+, Express, PostgreSQL (`pg`). `src/server.js` (boot, helmet, rate limits, LAN banner), `src/routes/api.js` (all routes, order/payment state machine, photo-sheet PDF), `src/services/{core,upi,webhook,network,audit}.js`, `src/middleware/auth.js`.
- Frontend (no framework), script order matters (`defer`, in this order): `vendor/pdfjs/pdf.min.js`, `icons.js` (doodle SVG icons, global `icon(name,size)`), `photoedit.js` (global `PhotoEdit`, pure pixel pipeline, also unit tested under Node), `customer.js` (portal; defines `renderCustomer`), `app.js` (shared helpers `api/esc/money/toast/jsonBody/setHeading/setBrandHome`, router `start()`, login, Super Admin, Shop Admin). `styles.css` is the design system. `vendor/fonts/` has Plus Jakarta Sans (OFL), served locally because CSP is `'self'` only. `public/vendor/pdfjs/` is pdf.js 3.11.174 (Apache-2.0) used for the real PDF preview, served locally because the CSP allows only `'self'`.
- Print agent: `agent/print_agent.py` (stdlib Python) polls the API, runs a configured OS print command without a shell, keeps a local journal so a job id never prints twice, reports shop heartbeat, and renews the claimed job lease every 20 s during long prints. Startup validates the HTTP(S) server URL and configured print executable; non-default paper types require `{paper_type}` in the command.
- Auth: JWT (issuer `print-wallah`) in an HTTP-only SameSite=Lax cookie. Shop sessions carry a stamp (`pv`) of the admin email+password hash, so changing either logs old sessions out.
- Logo: `<img id="brand-logo" src="/assets/logo.png">`. The route prefers an optional `public/assets/logo.png` override, falls back to the checked-in transparent `public/assets/print-wallah_logo.png`, then to `logo-placeholder.svg`. The favicon uses the same route.
- Design system (v3): neutral ink-dark (`#0e0f13` page, `#171920` cards, no green tint). Brand `#125948` (primary buttons, selected segments), `#0E4A38` (hover) and mint `#58d6aa` only for focus/links/eyebrows. **Cards have no outlines**: they separate by surface contrast, spacing and a soft shadow; inputs keep a visible 1.5px edge on purpose. Spacing tokens `--s-1..--s-8` and layout primitives `.stack/.stack-sm/.stack-lg/.cluster/.mt-*` replace one-off margins. Doodle icons (`icons.js`) are hand-drawn style SVG using `--doodle-a` (indigo blob) and `--doodle-b` (amber detail). No fake data, glow, live dots or decorative effects. Empty states are real and use a doodle.
- Navigation: floating bar (`.nav`), logo left, contextual chips right (`#nav-context`, set with `setHeading(label, chipsHtml)`), Sign out. `setBrandHome(href)`: customer `/shop/<id>`, Shop Admin `/admin`, Super Admin `/`. The global footer is hidden on customer pages (they have their own `.pw-footer`).

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

Routes: `/shop/<id>` is always the **homepage** (upload workflow). `/shop/<id>?order=<code>` is the order status screen. The logo is a plain link to `/shop/<id>`, so it always lands on the correct shop's homepage.

Homepage shows the whole workflow before any upload: file card, settings (pages, copies, colour, paper size/type, sides, orientation, scaling, photo options), preview (blank sheet with a doodle) and the pay card with an explanatory empty price. Until a file exists, the settings and pay areas are covered by a `.lock-cover`; tapping or focusing a control shows the in-product **nudge** (`#nudge`, "Upload a document first to use this option." with a "Choose file" action and a pulse on the upload card). It never uses `alert()`. Only the "Document or picture / Photo sheet" toggle works pre-upload because it decides what the upload step asks for.

Upload (PDF/JPG/PNG, XHR progress, size/type/corruption checks; images over 12000 px rejected) -> settings -> preview -> server quote (`/price` with the upload token, same code path as the order) -> UPI or cash -> status screen with polling, queue position, printer-offline notice.

**Order state rules** (fixes the "completed screen stuck after refresh" bug):
- The order code lives in `localStorage` (`pw-order-<shopId>`) and, while viewing, in `?order=`.
- *Active* order = not terminal and created in the last 24 h (`isActiveOrder`; the API now returns `createdAt/updatedAt/completedAt`). Terminal = completed, cancelled, payment rejected/failed/cancelled.
- Loading `/shop/<id>` without `?order=`: an active stored order shows as a **"You have an order in progress" banner** on the homepage (with View order); a terminal or stale one is removed from storage and nothing is shown.
- Loading with `?order=`: active -> status screen; terminal/stale -> homepage with a one time note, storage and URL cleaned.
- Reaching `completed` while on the status screen shows "Printed and ready", clears storage immediately, and returns to the homepage after 12 s (visible countdown, "Stay on this page", and a **Back to home** button). All other status screens also have Back to home. Back to home / logo / auto return go through `goHome()` which clears the URL and re-runs `renderCustomer(shopId)`, so the shop context is always the same shop.
- Customer cancel / switch-to-cash / claim paid are unchanged (see UPI section).

Footer (`footerHtml()`): Print Wallah logo and one line, shop name/address/phone (tel link) and an Open in Maps link built from the real address, quick links (Start a print, Print settings, Track my order only when an active order exists, Shop staff sign in -> `/admin`), "Made by DEVELOPERS". Nothing is invented: rows are omitted when the shop has no phone/address.

Preview: real PDF page rendered with pdf.js onto a sheet with the chosen paper size, orientation, 4 mm printable-area margin, scaling, B&W filter, copies stack, duplex caption, page navigation, honest warnings. Labelled approximate.

**Photo mode and editing** (images only; glossy). Up to 12 photos with quantity each packed onto shared sheets (sizes passport, stamp, 2x2 in, wallet, 4x6, 5x7; grid rotates 90 degrees when that fits more; photo cells use the same maths as the server `photoGeometry`). The **Photo editing** card appears only when an image is uploaded and (mode is Photo sheet **or** paper type is glossy). Controls: rotate left/right, black and white, brightness, contrast, saturation, exposure, highlights, shadows, sharpness, reset, apply to all photos, per-photo selection; in photo mode also fit (fill/crop vs whole photo), zoom 1-4x and drag-to-pan in the edit frame. Crop/zoom/pan apply only to photo sheets; in single-picture glossy mode edits are tone + rotation (scaling still comes from Fit/Fill/Actual).

**Edited-image print pipeline.** `photoedit.js` is the single source of truth. `PhotoEdit.render(img, edit, {aspect, fit, maxSide})` computes the crop, draws it and applies the tone/sharpen maths on pixels (no `ctx.filter`, which iOS Safari lacks). The preview (sheet cells, single picture preview, editor frame) uses it at small sizes. On "Pay", `bakeEdited()` renders each *edited* photo at print resolution (photo size at 300 dpi, max 4000 px), encodes JPEG q0.93, uploads it through the normal `/uploads` endpoint, and the order is created with the **baked upload tokens** (`photoItems[].uploadToken`, or `uploadToken` for a single picture). So the server's photo-sheet PDF / stored document is built from the edited pixels; there is no separate "edited preview vs original print". Baked uploads are cached by edit key so a retry reuses the same token (order creation stays idempotent). Unedited photos are sent as the original upload. The server only records a sanitized summary of the edits (`config.photoLayout[].edit`, `config.imageEdit`, via `summarizeEdit`) so the shop can see a file was edited; it never uses those numbers for pricing or printing. Original uploads that were replaced by baked ones expire and are cleaned like any unclaimed upload.

## Pricing

Latest safe verification on 2026-10-02: `npm test` passed 27/27, Python agent tests passed 7/7, `npm audit --omit=dev` last reported zero vulnerabilities, and syntax/editor checks passed. The gitignored local `agent/config.json` exists, but its configured print executable does not resolve on this Windows PC, so the agent will refuse to start; the SQLite journal has not been initialized. Database-backed smoke/payment and bundle integration scripts were not run because `.env` points to a hosted database; run them only against a disposable test database. Browser/physical-printer/real-UPI/Render deployment checks last recorded on 2026-10-01 remain distinct from these unit tests.

## Shop Admin

1. Render has a service and PostgreSQL but no persistent upload disk yet. Configure/mount private persistent storage, HTTPS `APP_URL`, DB backups and a restore rehearsal before real orders.
2. A live Windows print executable/model is not configured on this PC. Install and test SumatraPDF plus each shop's actual driver; supported devices/options vary. The agent renews leases and rejects glossy auto-print by default.
3. Manual UPI review is the selected launch mode; automatic gateway verification remains optional future work.
4. Print files are removed from live storage about 10 minutes after successful print; order/payment/audit records remain. The owner selected no customer-file backups, so ensure disk snapshots/backups do not retain customer bytes beyond this promise.
5. Multi-document PDF/JPG/PNG bundles, Asia/Kolkata daily/monthly reports, CSV export and platform shop comparison are implemented, but DB-backed bundle/report smoke tests have not yet run on a disposable database. Separate staff accounts are not required for launch; refunds remain manual/not in scope.

**Shop list actions are separate by construction**: "Open portal" is a real `<a href="/shop/<id>" target="_blank">` (`data-portal-link`); Details/Extend/Lock are `<button data-action=...>`. The earlier bug was that the portal cell was a button with `data-action="view"` and `wireShopRows` mapped `view` and `details` to the same `showShopDetails()`; the row wiring now only binds `button[data-action]` and `view` no longer exists. Login screens link to each other with real URLs (`/` Super Admin, `/admin` Shop Admin).

## Environment / Setup

`.env.example` is the reference. Required: `DATABASE_URL`, `JWT_SECRET` (32+), `SUPER_ADMIN_EMAIL`, `SUPER_ADMIN_PASSWORD`. `HOST` defaults to `0.0.0.0` (LAN). Production needs `APP_URL` (https), persistent private `UPLOAD_DIR`, `NODE_ENV=production`. Optional `PAYMENT_WEBHOOK_SECRET`. The server reads `.env` only at start: **restart after editing it** (a stale password is the usual cause of a Super Admin 401). Schema is applied idempotently at startup (`db/schema.sql`, requires the `pgcrypto` extension).

Development on a phone: `npm run dev` (or `npm start`) prints `Local:` and `Network:` URLs. Open the Network URL on the phone (same Wi-Fi), sign in to Super Admin there, and shop links/QR codes will contain that address. If it does not connect, allow Node through the OS firewall for private networks. CSP `upgrade-insecure-requests`, HSTS and COOP are production-only so plain-HTTP LAN testing works.

## Integration Contracts

API reference: `docs/API.md`. Payments: `docs/PAYMENTS.md`. Agent: `docs/PRINT_AGENT.md`, endpoints `POST /api/agent/:shop/heartbeat`, `GET .../jobs` (claims one job, returns `{job:null}` when none or when the shop is locked), `POST .../jobs/:id/heartbeat` (renews an active lease), `GET .../jobs/:id/document`, `POST .../jobs/:id/result {status,error?}`; Bearer agent token, scoped to its shop.

## Testing

Latest safe verification on 2026-10-02: `npm test` passed 22/22, Python agent tests passed 6/6, `npm audit --omit=dev` reported zero vulnerabilities, and syntax/editor checks passed. The gitignored local `agent/config.json` exists, but its configured print executable does not resolve on this Windows PC, so the agent will refuse to start; its SQLite journal has not been initialized. Database-backed smoke/payment scripts were not run because `.env` points to a hosted database; only run those against a disposable test database. Browser/physical-printer/real-UPI/Render deployment checks last recorded on 2026-10-01 remain distinct from this safe test run.

Browser tests (headless Chromium via `@sparticuz/chromium` + `puppeteer-core`, run from a scratch folder, **not shipped in the repo**) covered, on 2026-10-01 over the LAN address with phone (360/390), tablet, laptop (1280) and wide (1920) viewports: shop-list Customer Portal link opens `/shop/<id>` while Details opens the modal; homepage shows the whole workflow before upload; locked controls show the nudge; logo goes to the shop homepage and an active order appears as a banner; cash order -> shop confirm -> real agent API claim/complete -> "Printed and ready" -> auto return -> refresh, stale storage and old `?order=` link never bring the screen back; photo edit changes the preview and the **JPEG embedded in the real print sheet PDF matches the pipeline output** (mean 229.4 vs expected 229.5, cropped to the photo aspect); glossy single picture rotation reaches the stored file (400x600); layout sweep (no overflow, overlaps, touching or sub-36px targets); footer and nav link targets; zero console, page or network errors. Earlier UPI browser flow (link contents, refresh resume, claim, admin verify, auto update) also re-passed on the new UI. Not tested: a physical printer, a real UPI app or phone, iOS Safari, a payment provider, Render deployment.

## Completed

All of the above, plus the fixes listed in the Change Log.

## Pending

1. Production deployment (HTTPS `APP_URL`, persistent private upload disk, backups and restore rehearsal) has not been verified.
2. Per-shop onboarding still needs owner-approved UPI/payee details, prices/options, admin account and physical printer validation. The local agent config exists but its executable is unavailable on this PC.
3. UPI is manually verified today. Automatic verification needs a chosen provider, merchant account and provider-specific adapter.
4. Owner requested print files be automatically removed about 10 minutes after completed printing. The minute-scheduled cleanup removes source and generated photo PDFs, retains order/payment/audit metadata, and prevents retry after deletion. Backup snapshot retention still needs alignment with the deletion promise.
5. Multi-document orders, staff accounts per shop and refunds workflow are optional business decisions, not selected requirements.

## Known Issues / Limitations

- UPI success cannot be detected automatically (see UPI payments).
- A UPI order the customer never pays stays `pending_payment` until cancelled by the customer or shop (no auto-expiry, deliberately, to avoid cancelling an order whose money arrived late).
- Preview is approximate: it cannot know a printer driver's real margins or colour handling.
- `storage/` and `.test-postgres/` in the project folder contain leftovers from earlier testing; they are not used by the code and can be deleted. `storage/` must not be committed or deployed with test files.
- `pdf-parse` prints "Warning: Indexing all PDF objects" for some PDFs; harmless.
- Photo edits run in the customer's browser; very large photos on low-memory phones are downscaled to at most 4000 px on the long side (about 340 dpi for a 4x6) and the JPEG is re-encoded once at quality 0.93. Sharpness uses a box-blur unsharp mask scaled to image size, so it is consistent between preview and print but is not a professional sharpening algorithm.
- Edits (zoom, pan) are per photo and are lost on reload; they are applied only when the order is placed.
- Agent `print_command` placeholders must cover every option a shop enables (the agent refuses a job rather than silently ignoring an option).

## Important Decisions

- Keep dependencies modest, no frontend framework. pdf.js is vendored for the preview.
- Backend is authoritative for shop data, prices, UPI ID, amounts and state; the browser only displays.
- A UPI link is a payment request, never proof of payment.
- Jobs are created at verification time; agent journal + new job id on retry prevents double printing while still allowing deliberate reprints.
- One admin account per shop (on the shop row).

## Change Log

- 2026-10-06 v4.1 (polish round):
  - Shop Admin phone order rows show only file name, time, amount, status and the main action (full details stay in the drawer); desktop rows unchanged.
  - Super Admin Reports: range presets, live search, sort, per-shop revenue bar, tap-to-expand details (UPI/cash split, pending, failed, copy shop ID); compact header on phones.
  - Customer portal: offline-printer notice is one tappable line on phones, phone number hidden in the hero on phones, calmer footer, compact payment/status screens, smaller logo on phone/tablet, navbar turns to glass with a hairline once the page scrolls.
  - All-caps labels removed (login kicker, modal eyebrows, stat/table/footer headings); no `text-transform: uppercase` remains.
- 2026-10-05 v4 (control-panel redesign, mobile-first customer portal):
  - Frontend split by audience: `app.js` (shared bootstrap, API, dialogs, footer), `admin.js` + `admin.css` (Shop Admin and Super Admin, loaded only on admin routes), `customer.js` + pdf.js + `photoedit.js` (loaded only on `/shop/<id>`), `styles.css` (tokens, base, customer portal, shared overlays). No API, schema, auth, payment or print-agent code changed.
  - Admin shell: sidebar on desktop, glass tab bar on phones; Overview (needs-action queue, stats, printer status, latest activity), Orders (search, filter chips with counts, status-first rows, detail drawer / bottom sheet with full metadata and every action), Reports, Settings (two columns, sticky unsaved-changes bar, discard guard). Super Admin: Shops (search, access meter) and Reports.
  - `confirm()` / `prompt()` replaced by an in-app dialog (`confirmDialog`) in admin and customer flows. Action buttons lock while a request is in flight.
  - Customer portal: collapsible privacy note, optional name/phone collapsed, shorter microcopy, compact UPI screen (manual-pay details collapsed), empty preview hidden on phones, footer rebuilt with SVG social icons. UPI flow unchanged (`upi://pay` link built server-side).
  - CSS: ~110 unused rules removed outright; the customer-portal rules were replaced by one mobile-first layer at the end of `styles.css` (previously several stacked override layers). Superseded admin functions removed from `app.js` (moved/rewritten in `admin.js`).
  - Tests: fixed stale assertions in `test/smoke.js` (analytics returns `{rows}`, order view exposes `fileName`) and `test/payments.js` (webhook replays need `currency`, error wording). Product code was not at fault.
  - Open items for the owner: replace the placeholder social URLs in `SOCIAL` (`public/app.js`); set real URLs before launch. Real-device UPI app hand-off and iOS Safari were not testable in the build sandbox (UPI link format is covered by tests).

- 2026-10-01 v3 (customer portal UX, redesign, navigation, state):
  - Redesign: neutral ink-dark system, borderless cards, Plus Jakarta Sans, spacing tokens, doodle icon set, floating navbar, premium customer footer.
  - Routing: fixed shop-list Customer Portal link (was a button sharing the Details handler); logo, Back to home and login switches use real URLs.
  - Customer homepage shows the full workflow pre-upload with in-product "upload first" nudges.
  - Photo editing with an edited-image print pipeline (`photoedit.js`, bake on submit, server stores a sanitized edit summary).
  - Order state fix: active vs terminal vs stale orders, homepage banner for an active order, completion auto return + Back to home, no resurrection after refresh. API order view gained `createdAt/updatedAt/completedAt`.
  - Found while testing and fixed: photo mode did not switch paper to glossy when several photos were chosen; stepper buttons shrank on tablets; nav chip overflowed 390px; duplicate order code on status screens.
- 2026-10-01 v2: UPI flow, order states, idempotency, webhook integration point, LAN server, print-safety fixes, first dark UI (look superseded by v3).
- Earlier history: see v2 notes in `docs/` and git history; corrected facts (shop ID length, branding assets, storage leftovers) were fixed in v2.
