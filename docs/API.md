# REST API reference

All routes are under `/api`. Admin sessions use an HTTP-only, same-site cookie. JSON request bodies use `Content-Type: application/json`, except upload which is multipart form data with a `document` field.

## Authentication and platform owner

- `POST /auth/super/login` — `{email,password}`
- `POST /auth/shop/login` — `{email,password}`
- `POST /auth/logout`
- `GET /session`
- `GET /super/overview`
- `GET /super/analytics?from=YYYY-MM-DD&to=YYYY-MM-DD&groupBy=day|month` — per-shop comparison in Asia/Kolkata time with orders, pages, verified cash/UPI revenue, pending payments and print failures.
- `GET /admin/analytics?from=YYYY-MM-DD&to=YYYY-MM-DD&groupBy=day|month` — same metrics for the authenticated shop, grouped in Asia/Kolkata time.
- `GET /super/analytics?from=YYYY-MM-DD&to=YYYY-MM-DD&groupBy=day|month` — per-shop comparison using Asia/Kolkata dates; includes orders, pages, verified revenue by cash/UPI, pending payments and print failures.
- `GET /super/shops?q=...`
- `POST /super/shops` — shop details, `adminEmail`, `adminPassword`, optional `pricing`, `upiId`, `upiName`, `accessDays`
- `GET /super/shops/:shopId`
- `PATCH /super/shops/:shopId`
- `POST /super/shops/:shopId/lock` — `{locked:boolean}`
- `POST /super/shops/:shopId/extend` — `{days?:number}`

Shop creation returns the public shop ID, customer URL, QR data URL, and a one-time print-agent token. Store that token securely; it is not retrievable later.

## Customer portal

Shop IDs are matched case-insensitively. Every endpoint is bound to the shop in the URL; an upload token from one shop is rejected by another.

- `GET /shops/:shopId/public`: shop settings, rates, `upiConfigured`, `printerOnline`, photo sizes, `maxUploadMb`. 404 unknown shop, 423 locked or expired.
- `POST /shops/:shopId/uploads`: multipart `document` (PDF, JPG, PNG). Returns `uploadToken`, `pages`, and for images `width`/`height`. Rejects corrupt PDFs, mismatched content types and images over 12000 px. In production returns 503 until `UPLOAD_DIR` is an absolute mounted persistent path.
- `POST /shops/:shopId/price`: `{uploadToken, documentTokens?, config}` returns the exact quote the order will use. `documentTokens` bundles 1–10 distinct, unexpired uploads from this shop; all PDF pages and each JPG/PNG image count as pages. Bundles use shared settings, print every page, and do not accept per-file page ranges. Omitting `documentTokens` keeps single-document and photo-sheet behavior.
- `POST /shops/:shopId/orders`: `{uploadToken, documentTokens?, paymentMethod: "cash"|"upi", config, expectedAmount?, customerName?, customerPhone?}`.
  - The amount is always recomputed on the server. If `expectedAmount` differs, the response is `409 {code:"PRICE_CHANGED", currentAmount}`.
  - One upload token is one order. Repeating the request returns the existing order with `resumed:true` (200).
  - UPI orders start as `pending_payment` and include `order.upi = {id, payee, uri, qr}`. The server refuses UPI when the shop UPI ID is missing or invalid.
  - Photo orders: `config.photoItems = [{uploadToken, quantity, edit?}]` (up to 12 photos, packed onto shared sheets). The browser uploads *edited* photos as new JPEG uploads and passes those tokens; `edit` is only a record of the adjustments (sanitized and stored in `config.photoLayout[].edit`, never used for pricing or printing). Single pictures on glossy paper may send `config.imageEdit` the same way.
  - Document bundles require the first `documentTokens` entry to equal `uploadToken`. The server calculates total pages and price, creates one combined print-ready PDF, stores all source uploads for cleanup, and records source filenames in the order config. Copies apply to the whole bundle.
- `GET /orders/:orderCode`: full order view (now includes `shopId`, `createdAt`, `updatedAt`, `completedAt`, which the portal uses to decide whether an order is still active) (used to resume checkout after a refresh). Includes the UPI link while a UPI payment is still unpaid.
- `GET /orders/:orderCode/status`: `{order_status, payment_status, print_status, printer_online, ahead, ...}` for polling.
- `POST /orders/:orderCode/payment-claim`: `{reference?}`. Customer says they paid. Moves `pending_payment` to `payment_review`. This does NOT verify anything.
- `POST /orders/:orderCode/switch-cash`: UPI not yet claimed, becomes a cash order.
- `POST /orders/:orderCode/cancel`: allowed for unpaid cash orders and UPI orders not yet claimed.
- `POST /payments/webhook`: optional signed confirmation, see `docs/PAYMENTS.md`. Returns 404 unless `PAYMENT_WEBHOOK_SECRET` is set.
- `POST /orders/:orderCode/payment-reference`: older alias of `payment-claim` that requires a reference.

## Shop admin

- `GET /admin/me`
- `GET /admin/overview`
- `GET /admin/orders?status=&from=&to=&q=`
- `POST /admin/orders/:orderId/cash-confirm`
- `POST /admin/orders/:orderId/payment-verify` — `{verified:boolean}`
- `POST /admin/orders/:orderId/cancel`
- `POST /admin/orders/:orderId/retry-print`
- `POST /admin/orders/:orderId/print-failed`
- `POST /admin/orders/:orderId/complete`
- `GET /admin/analytics?from=YYYY-MM-DD&to=YYYY-MM-DD&groupBy=day|month` — same totals for the signed-in shop, grouped in Asia/Kolkata time.
- `PATCH /admin/settings` — operational shop fields: `name`, `ownerName`, `phone`, `email`, `address`, `city`, `upiId`, `upiName`, `pricing`, `printConfig`, and `agentName`. Shop Admin cannot change admin email or password.
- `POST /admin/agent/rotate`
- `GET /admin/uploads/:orderId` — private document download

Every shop admin endpoint checks the authenticated shop against database ownership and current access state.

## Print agent

Every agent request sends `Authorization: Bearer <shop-agent-token>`.

- `POST /agent/:shopId/heartbeat` — `{agentName}`
- `GET /agent/:shopId/jobs` — atomically claims one job or returns `{job:null}`
- `POST /agent/:shopId/jobs/:jobId/heartbeat` — renews the active claimed job lease; returns 409 if the lease is no longer active
- `GET /agent/:shopId/jobs/:jobId/document` — private download for the currently claimed job
- `POST /agent/:shopId/jobs/:jobId/result` — `{status:"completed"|"failed",error?}`

The queue lease expires after 15 minutes. The agent keeps a local SQLite print journal and refuses to automatically reprint a job whose previous attempt has an uncertain outcome.
