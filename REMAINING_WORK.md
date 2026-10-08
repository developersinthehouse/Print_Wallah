# Print Wallah — Remaining Work Checklist

This document lists the work still needed to take Print Wallah from the current working build to a configured, production-ready printing service. It distinguishes decisions and setup that require shop-owner input from engineering and verification work.

## Current state

The core multi-shop application is implemented: shop setup, customer ordering, private uploads, per-shop pricing, manual cash/UPI review, order administration, print queue, document bundles, daily/monthly reports, and the optional local print agent. Unit suites pass; the new bundle/report/retention paths still need database-backed smoke verification on a disposable database.

The project is **not yet production-ready for real payments or unattended printing**. No live payment provider is connected, no physical printer has been validated, and production database/storage/backup settings have not been configured. No deployed production instance has been verified.

## Launch blockers

Finish these before accepting real customer orders:

- [ ] Configure a production PostgreSQL database, HTTPS service, private persistent upload storage, and backups.
- [ ] Configure a real shop with verified rates, UPI details, enabled print options, admin credentials, and a tested printer/agent.
- [x] Launch payment mode selected: manual UPI review. Do not describe a customer UPI-app return as automatic payment verification.
- [ ] Run the release checks in section 8 against the actual deployment and shop printer.
- [x] Live print-file retention selected and implemented: delete source/generated files about 10 minutes after a successful print; retain order/payment/audit records.

## 1. Local owner setup

**Status:** Required for local development; production setup is covered in section 2.

1. Install Node.js 20 or newer and PostgreSQL 14 or newer. Install Python 3.10 or newer only if using the print agent.
2. Create a PostgreSQL database and user with permission to create the schema and `pgcrypto` extension. The example commands are in [README.md](README.md).
3. Copy `.env.example` to `.env` and set:
   - `DATABASE_URL` to the local database connection string.
   - `JWT_SECRET` to a private random value of at least 32 characters.
   - `SUPER_ADMIN_EMAIL` and `SUPER_ADMIN_PASSWORD` to the platform owner's login values.
   - `APP_URL` to the public root URL when deployed; for local use, `http://localhost:3000` is suitable.
   - `UPLOAD_DIR` to a private writable directory. The default `./storage` is for local development only.
4. Run `npm install`, then `npm run db:init`, then `npm start` from the project directory.
5. Open the local site, sign in as Super Admin, and create a test shop. Confirm the generated portal URL and QR open that shop.

**Complete when:** the service starts, Super Admin can sign in, a shop can be created, and a test upload/order can be completed without using production data.

## 2. Production hosting and operations

**Status:** Instructions exist for Render; no production instance is configured or verified.

1. Put the project in a private Git repository and push the source. If this directory is not already a Git repository, initialize one, review ignored files, and ensure `.env`, uploaded customer files, test database files, and credentials are not committed.
2. Create a managed PostgreSQL database with the hosting provider. Use its private/internal connection string when the app and database share a provider network.
3. Create a Node web service using:
   - Build command: `npm install`
   - Start command: `npm start`
4. Configure production environment variables in the hosting dashboard:
   - `NODE_ENV=production`
   - `DATABASE_URL` with the production database URL.
   - `DATABASE_SSL` according to the database provider's current requirement.
   - `APP_URL` with the exact public HTTPS root URL.
   - `JWT_SECRET` with a new production-only random secret; do not reuse a local value.
   - `SUPER_ADMIN_EMAIL` and `SUPER_ADMIN_PASSWORD` with private production credentials.
   - `UPLOAD_DIR` with the mounted persistent disk path, for example `/var/data/print-wallah`.
5. Mount private persistent storage at the same path used by `UPLOAD_DIR`. Do not use an ephemeral deploy filesystem for uploads.
6. Deploy and confirm the schema initializes. Sign in, create a test shop, download its QR, and test the customer portal over HTTPS.
7. Configure scheduled backups for both PostgreSQL and the upload volume. Document who can restore them and perform one restore rehearsal before launch. Database rows and stored files are linked, so back them up as a coordinated set.
8. Record the service URL, database backup schedule, storage mount path, deployment owner, and recovery instructions in the operator's private runbook. Do not put secrets in this repository.

**Complete when:** the hosted service survives a restart/deploy with uploaded files intact, HTTPS works, backups complete, and a restore rehearsal recovers a test order and its file.

## 3. Shop onboarding and print configuration

**Status:** Shop creation/settings exist; each real shop still needs accurate values and operational setup.

For every shop:

1. Confirm the shop's public name, address, contact phone, and shop-admin login with its owner.
2. Enter and verify the complete price card. Test every enabled combination of paper size, paper type, color mode, copies, page count, duplex, and photo sheet. The server recalculates the order amount, but the business rules and rates must match the shop's actual prices.
3. Confirm the duplex billing rule with the owner. Current pricing charges per printable sheet, using `ceil(pages / 2)` for duplex. Change the rule and tests if the shop expects another convention.
4. Confirm which options the physical printer supports. Disable options the shop cannot fulfill. The UI's selected print settings do not discover printer capabilities automatically.
5. Enter the shop's UPI payee identity and any requested display details. Make a small real-world test only after the owner has confirmed the receiving account. Until a gateway is integrated, staff must verify each payment in their account before accepting it.
6. On the shop computer, install the OS printer driver, connect/configure the printer, install Python 3.10+, configure the agent, and start it as described in [docs/PRINT_AGENT.md](docs/PRINT_AGENT.md). Store the agent token privately; rotate it if exposed.
7. Print test PDFs and photos covering color/B&W, A4/A3 as applicable, glossy/photo paper, portrait/landscape, scaling, page ranges, copies, and duplex. Check physical margins, cropping, orientation, color, and cut guides.
8. Agree on the operator procedure for jobs that the agent reports as failed or uncertain. The OS command's successful exit does not prove that paper printed.

**Complete when:** shop owner signs off on prices/options, the agent is connected to the correct shop, and the printer produces and staff inspect representative test output.

## 4. Payment verification decision and implementation

**Status:** The shop-configured UPI intent and manual shop-account verification are implemented. Customers do not have to enter a transaction reference; the shop must verify the payment before queueing. Gateway callbacks are not implemented.

### Decision required

The platform owner must choose one operating mode for launch:

- **Manual reconciliation:** keep the current flow. Staff compare the order code and exact amount with their bank/UPI account, then verify or reject the payment in the admin screen. A customer-entered transaction reference is optional. Set a staffing and response-time procedure.
- **Automatic verification:** choose a merchant payment provider supported in the launch country and open/verify a merchant account. Obtain its API credentials, webhook signing secret, supported currencies/payment methods, test environment, and production callback requirements.

Do not treat returning from a UPI app, a customer-entered reference, or a browser success page as proof of payment.

### Work if automatic verification is selected

1. Write down the provider, currency, settlement account, refund policy, and how staff handle disputed or duplicated payments.
2. Add server-side payment creation using the provider's API. Bind each provider payment/session to one Print Wallah order and the server-calculated amount and currency.
3. Add an HTTPS webhook endpoint that verifies the provider's signature against the raw request body and a secret stored only in production environment settings.
4. Make webhook handling idempotent. Persist provider event/payment IDs with unique constraints; repeated events must not create duplicate payments or print jobs.
5. Check amount, currency, merchant account, order association, and allowed order/payment state before marking an order paid. Reject and log mismatches for staff review.
6. Handle delayed, duplicated, out-of-order, failed, cancelled, and timed-out events. Define how a payment arriving after order cancellation is reconciled and whether refunds are manual or automated.
7. Add a shop-facing reconciliation view with provider reference, state, and failure reason while keeping provider secrets private.
8. Add automated tests for valid signatures, invalid signatures, duplicate callbacks, amount/currency mismatch, wrong order, event ordering, timeout, cancellation, and retry.
9. Complete the provider's test-mode and production verification steps. Keep automatic verification disabled until production callbacks are observed and reconciled successfully.

**Complete when:** either a documented manual-review procedure is staffed and tested, or provider callbacks pass the full test matrix and a small production payment is reconciled end to end.

## 5. Printer support and diagnostics

**Status:** The agent validates its server URL and print executable, renews claimed-job leases during long prints, maps paper type, and keeps a local duplicate journal. Glossy auto-print is disabled by default. Physical printer status/capabilities are not detected; this PC has no resolvable SumatraPDF/print executable and no physical printer has been tested.

1. Test the current agent with each intended printer model and operating system using the shop's actual print command and driver.
2. Verify the command maps the order's copies, color mode, paper size/type, orientation, page range, scaling, and duplex settings. If the configured OS command cannot honor an option, either add an appropriate adapter or disable that option for the shop.
3. Test agent restart, network loss during download/submit, lease expiry, printer offline, spooler error, retry, and uncertain submission. Staff must inspect uncertain jobs before retrying to avoid duplicate physical prints.
4. Decide whether each shop needs automatic online/offline status and test-print controls. If yes, implement a printer-status adapter per supported OS/vendor, persist last-seen/status, show stale/offline state to staff, and add an explicit test-print action with a confirmation and audit entry.
5. Document supported printer/OS combinations and agent installation/update steps for shop operators.

**Complete when:** every supported combination has a tested command/configuration, the staff recovery procedure avoids accidental duplicate prints, and any promised diagnostics are implemented and verified.

## 6. Customer-file retention and storage growth

**Status:** Unclaimed uploads expire and are cleaned hourly. Source uploads and generated print PDFs for completed orders are removed by a one-minute cleanup worker once they are at least 10 minutes past completion; order/payment/audit metadata remains. Failed orders retain files for retry. The owner selected no customer-file backups. Backup plans must exclude customer bytes; a hosted object-storage adapter and configurable retention duration are not implemented.

1. Policy selected: delete source and generated print files about 10 minutes after the order completes. Order/payment/audit metadata remains. Failed jobs retain files for retry.
2. Customers see this deletion window before upload. Confirm the operator knows that a completed order can no longer be reprinted after file cleanup.
3. Current live-storage policy is fixed at 10 minutes after successful completion. The cleanup marks `files_deleted_at`, removes source and generated print files, and keeps order metadata. Make the duration configurable only if the owner later changes this policy.
4. Make cleanup idempotent and safe if a file is already missing. Log cleanup counts/errors without logging file contents, credentials, or unnecessary personal data.
5. Add tests for retention boundaries, missing files, failed deletion/retry, orders with generated photo PDFs, and ensuring active/recent orders are not removed early.
6. Decide whether a single persistent disk is sufficient for expected traffic. If scaling to multiple instances or needing object storage, implement a storage interface and a private object-storage adapter with access controls, lifecycle rules, and migration of existing files.
7. Owner selected no customer-file backups. Configure database backups without uploaded/generated document bytes; verify any Render disk snapshots are disabled or do not retain customer files beyond the stated deletion policy. Test restoring database metadata without files.

**Complete when:** the deployed 10-minute cleanup runs reliably, retention tests pass, backup snapshots cannot restore deleted customer files, and storage capacity is documented.

## 7. Product work still to decide or build

These are not prerequisites for every launch, but the owner must decide whether they are required for the intended operation.

### Customer order recovery and status

1. The app exposes a limited public order-status lookup by random order code and the ordering page polls while open. Decide whether customers need to reopen tracking after closing the page or on another device.
2. If needed, create a durable confirmation/receipt URL or order lookup flow. Keep it based on a high-entropy unguessable token or an appropriate verification step; do not reveal documents, payment references, or another customer's order.
3. Define order states and user-facing messages for payment pending/rejected, cash awaiting confirmation, queued, printing, failed, completed, and cancelled.
4. Test the link/lookup after browser close, on mobile, and after order state changes.

### Multiple shop staff

The owner chose to keep one shared shop-admin account for launch. Separate cashier/print-operator accounts are deferred and are not a launch blocker.

### Multi-document orders

Implemented: up to 10 PDFs/JPG/PNGs can be combined into one order with shared settings, full pages, one combined server-calculated price/payment, and a generated print-ready PDF. The database-backed smoke test covers mixed files, pages, copies and agent download; run it against a disposable database before release.

### Photo order behavior

1. Current photo orders repeat one uploaded image to fill the selected sheet quantity. Decide whether shops/customers need multiple distinct photos on one sheet or other sizes/layouts.
2. If required, define the UI, pricing, crop behavior, and sheet packing rules before implementation. Add representative print-ready PDF fixtures and inspect physical output.

### Reporting

Implemented: daily/monthly Asia/Kolkata shop reports and date-range per-shop Super Admin comparison include orders, pages, verified cash/UPI revenue, pending payments and print failures, with CSV export. Unit tests cover date ranges and report query shape; database-backed permission/aggregation smoke verification remains.

Refund workflow and separate staff accounts are not selected for launch. Customer order recovery, additional photo-sheet layouts and reports beyond the selected daily/monthly comparison remain optional decisions.

## 8. Release verification

**Status:** Core checks have been run and are recorded in [memory.md](memory.md). Repeat relevant checks against the final release and deployed configuration. Full browser/device and physical printer testing remains.

### Automated checks

1. Run `npm test`.
2. Run `python -m unittest discover -s agent -p 'test_*.py'` when shipping the print agent.
3. Run `npm run smoke` against a disposable test database/service, not production customer data.
4. Add and run integration coverage for the transitions/edge cases below that are not already covered:
   - Expired upload and expired/locked shop access.
   - Wrong shop ID/token and cross-tenant access for customer, admin, upload, order, document, and agent routes.
   - Spoofed file MIME/signature, unsupported file, oversized file, malformed PDF, page/copy/range limits, and upload cleanup.
   - Cash order not queued before confirmation; rejection and cancellation behavior.
   - Manual UPI pending/verify/reject behavior with and without an optional customer reference, including repeated actions.
   - Duplicate/concurrent agent claims, expired lease, retry limit, job failure, uncertain job handling, and no duplicate job per order.
   - Price snapshots stay stable when shop prices later change.
   - Photo PDF page count, selected dimensions, margins, cut guides, and large quantities.
5. Review dependency alerts with `npm audit` and address any production-relevant issue before release.

### Browser and operator checks

1. Test customer, shop admin, and Super Admin flows at mobile, tablet, and desktop sizes in the supported browsers.
2. Check keyboard navigation, form validation, upload progress/errors, readable status messages, and empty/error states.
3. Verify shop links and QR codes point to the correct HTTPS host and cannot expose another shop's orders/files.
4. Run one complete cash order, one manually reviewed UPI order (if enabled), one failed print/retry, one completed print, and one cancellation through the real deployed app.
5. Confirm logs and error messages do not disclose passwords, JWTs, agent tokens, payment secrets, or uploaded document contents.

### Security and recovery review

1. Confirm all production secrets are configured outside source control and `.env` is ignored.
2. Confirm HTTPS, secure cookie behavior, least-privilege database access, private upload storage, and admin/agent token rotation procedures.
3. Review login/upload/order/agent endpoints for appropriate abuse controls and request limits. Add rate limiting or other controls where the review finds risk.
4. Confirm error monitoring and database/storage capacity alerts reach the responsible operator.
5. Perform a backup restore rehearsal and verify restored document access and tenant boundaries.

**Complete when:** every release check passes or has a documented owner-approved exception, and the deployed version has been tested end to end with the actual shop configuration.

## 9. Workspace housekeeping

**Status:** Local `.env` configuration exists and is ignored/private. The isolated smoke-test schema was removed after testing. Inspect local storage/test artifacts before copying this folder or cleaning anything.

1. Before using this folder as a production checkout, inspect `.test-postgres/` and `storage/` and remove only files you have positively identified as disposable test artifacts. Keep any data you recognize and want to preserve; never delete the existing `.env` as a cleanup step.
2. Keep `.env` private and populate it from `.env.example` only for the environment being run. Never copy test credentials into production.
3. If committing the repository, inspect `git status` and `.gitignore` first. Commit source/docs/fixtures intended for the project; exclude `.env`, customer documents, runtime storage, database files, and local logs.

## Completion record

Use this list when the launch owner reviews remaining work:

- [ ] Production host, database, persistent storage, HTTPS, and backups are operational.
- [ ] Each live shop's rates, payment details, admin access, and print options are approved.
- [ ] Payment mode and staff reconciliation process are approved and tested.
- [ ] Physical printer and agent workflow are tested for every supported shop setup.
- [ ] Document retention policy is approved and implemented.
- [ ] Required customer recovery, staff roles, photo options, and reports are decided and completed.
- [ ] Automated, browser, security, and restore checks are complete for the release.
- [ ] Operator runbook, responsible contacts, and incident/reprint procedures are recorded.
