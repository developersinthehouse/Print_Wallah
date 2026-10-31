# Production data migration to Firebase

The importer moves a read-only export of the existing production database into a **new, empty Firestore project** and verifies/adopts the files in your existing Cloudflare R2 bucket. It has no PostgreSQL client dependency and cannot erase the source database. Existing R2 objects are never overwritten: matching bytes are kept, missing objects are uploaded, and a same-name object with different bytes stops the import. Do not use it on the production Firestore project after the new app has begun accepting orders.

## Before exporting

1. Create and configure the Firebase project and existing R2 bucket as described in [Firebase and Cloudflare setup](FIREBASE.md), including Firestore indexes and a bucket-scoped R2 token.
2. Create a private archive folder named `.private-firebase-migration` in a controlled migration environment. This folder is ignored by Git because the archive contains shop credentials, customer information, payment history, and uploaded files.
3. Schedule a short cutover window. Stop new orders and payment updates in the old app, then let active print jobs finish. Stop the print agent before exporting. The importer rejects `printing`, `claimed`, or agent-printing states so a job cannot be printed twice during cutover.
4. With a read-only account, run the query below once in the production database's SQL console while writes remain paused. It produces one JSON snapshot and its source row counts. Save the single `archive` result cell as `archive.json` in the private archive folder. Download the referenced upload and generated print objects from the existing R2 bucket into the archive's `files` subfolder, preserving every upload `stored_name` and generated order `print_file_name` exactly. This local copy lets the importer verify each object's size and content before it adopts the same key already in R2. Never include `.env`, database credentials, or service-account JSON.

```sql
SELECT jsonb_build_object(
  'version', 1,
  'archive_id', 'cutover-' || replace(gen_random_uuid()::text, '-', ''),
  'exported_at', now(),
  'counts', jsonb_build_object(
    'shops', (SELECT count(*) FROM shops),
    'uploads', (SELECT count(*) FROM uploads),
    'orders', (SELECT count(*) FROM orders),
    'payments', (SELECT count(*) FROM payments),
    'print_jobs', (SELECT count(*) FROM print_jobs),
    'order_uploads', (SELECT count(*) FROM order_uploads),
    'access_extensions', (SELECT count(*) FROM access_extensions),
    'audit_log', (SELECT count(*) FROM audit_log),
    'payment_events', (SELECT count(*) FROM payment_events)
  ),
  'data', jsonb_build_object(
    'shops', COALESCE((SELECT jsonb_agg(to_jsonb(t) ORDER BY t.id) FROM shops t), '[]'::jsonb),
    'uploads', COALESCE((SELECT jsonb_agg(to_jsonb(t) ORDER BY t.id) FROM uploads t), '[]'::jsonb),
    'orders', COALESCE((SELECT jsonb_agg(to_jsonb(t) ORDER BY t.id) FROM orders t), '[]'::jsonb),
    'payments', COALESCE((SELECT jsonb_agg(to_jsonb(t) ORDER BY t.id) FROM payments t), '[]'::jsonb),
    'print_jobs', COALESCE((SELECT jsonb_agg(to_jsonb(t) ORDER BY t.id) FROM print_jobs t), '[]'::jsonb),
    'order_uploads', COALESCE((SELECT jsonb_agg(to_jsonb(t) ORDER BY t.order_id, t.position, t.upload_id) FROM order_uploads t), '[]'::jsonb),
    'access_extensions', COALESCE((SELECT jsonb_agg(to_jsonb(t) ORDER BY t.id) FROM access_extensions t), '[]'::jsonb),
    'audit_log', COALESCE((SELECT jsonb_agg(to_jsonb(t) ORDER BY t.id) FROM audit_log t), '[]'::jsonb),
    'payment_events', COALESCE((SELECT jsonb_agg(to_jsonb(t) ORDER BY t.id) FROM payment_events t), '[]'::jsonb)
  )
)::text AS archive;
```

## Archive shape

The archive folder must contain:

```text
.private-firebase-migration/
  archive.json
  files/
    <each stored_name referenced by uploads/orders>
```

`archive.json` is the single JSON value returned by the query above. Its top-level `version`, `archive_id`, `exported_at`, and `counts` fields record the snapshot; `data` contains the table arrays. The importer also accepts split `manifest.json` and `data.json` files when another trusted export process produces those.

```json
{
  "version": 1,
  "archive_id": "production-cutover-2026-10-30-a1b2c3",
  "exported_at": "2026-10-30T12:00:00.000Z",
  "counts": {
    "shops": 1,
    "uploads": 1,
    "orders": 1,
    "payments": 1,
    "print_jobs": 1,
    "order_uploads": 0,
    "access_extensions": 0,
    "audit_log": 1,
    "payment_events": 0
  }
}
```

The `data` object has those nine table names as arrays of row objects, using the original column names. JSON/JSONB values are objects/arrays, and timestamps include a time zone. `order_uploads` rows preserve `order_id`, `upload_id`, `quantity`, and `position`. Each required file is stored as `files/<stored_name>` with its original bytes. The manifest row counts must match the arrays exactly. Keep this archive private and delete it only under the shop's data-retention policy after cutover and rollback windows are closed.

## Dry run and import

Set `FIREBASE_PROJECT_ID`, `FIREBASE_SERVICE_ACCOUNT_JSON`, and the four R2 variables (`R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET_NAME`) in the controlled migration environment. Firestore collections must be empty. The existing R2 bucket can contain production files; do not empty it. Run a dry run first; it validates source counts, relationships, and lease states, and checks required active/retryable-order files and their sizes. Missing required files or active leases stop the run with an error. The summary prints target document counts and file/byte totals; compare these with the production table counts and R2 inventory before applying it.

```powershell
npm run migrate:firebase -- .private-firebase-migration --dry-run
npm run migrate:firebase -- .private-firebase-migration --apply
```

The importer checks each R2 key first and keeps it in place when its bytes match the private archive; it only uploads a missing key and never replaces different existing bytes. It then writes Firestore documents in bounded batches. It preserves shop, upload, and order IDs; rebuilds order items, upload claims, order-code lookup documents, and per-shop queue counters; and keys print jobs by order ID, which is the ID expected by the new API. An incomplete import can be safely resumed with the **same archive ID and exact same archive**. A completed import is idempotent. A different archive ID or any pre-existing destination collection is rejected.

## Compare and cut over

Before switching traffic, compare the import summary against the archive manifest and verify representative records in Firestore. Then use a staging deployment pointed at the Firebase project to verify Super Admin and shop logins, shop settings, customer upload/quote/order/payment verification, webhook idempotency, print-agent heartbeat/claim/download/result, report totals, queue order, and file retention. Only then switch the production service and print agent to the Firebase-backed release.

Keep the old production database and file copy read-only for rollback until production behavior and migrated counts are confirmed. Do not delete them until the owner separately approves that final irreversible deletion.
