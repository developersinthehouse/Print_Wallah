# Deploy the app

1. Push this project to a Git repository you control.
2. In Render, create a PostgreSQL database. Copy its internal connection string for the web service.
3. Create a **Web Service** from the repository. Choose Node as the runtime, `npm ci` as the build command, and `npm start` as the start command.
4. Add `DATABASE_URL`, `DATABASE_SSL`, `APP_URL`, `JWT_SECRET`, `SUPER_ADMIN_EMAIL`, and `SUPER_ADMIN_PASSWORD` in the web service environment settings. Use the exact public service URL for `APP_URL`.
5. Configure persistent file storage using either [Cloudflare R2](#cloudflare-r2-setup) or a persistent disk mounted at an absolute `UPLOAD_DIR`. Production startup refuses to run without one.
6. Deploy. The application creates tables at startup. Visit the service root, sign in as the Super Admin, and create the first shop.
7. Verify HTTPS is enabled, create a test shop, scan/download its QR, check the customer portal, and install its print agent on the shop computer.

Successful print-agent confirmation triggers immediate deletion of the order's source uploads and generated print PDF from live storage. If storage is temporarily unavailable, deletion is retried by background cleanup and the API reports `filesCleanupPending`; failed print jobs keep their files so the shop can retry. The agent confirms that the OS print command accepted/finished, not that paper physically emerged. Back up PostgreSQL order/payment/audit metadata, not customer file bytes. Restrict database credentials and admin passwords. UPI remains manually verified; do not automate approvals until a provider adapter is configured.

## Cloudflare R2 setup

1. In Cloudflare, open **R2 Object Storage** and create a bucket, for example `print-wallah-files`. Keep it private; do not enable public access or publish an `r2.dev` URL.
2. Open **Manage R2 API Tokens** and create a token with **Object Read & Write** permission scoped only to this bucket. Copy the **Access Key ID** and **Secret Access Key** when shown; the secret may only be displayed once.
3. Find the Cloudflare **Account ID** in the account dashboard. The app derives the private S3 endpoint as `https://<ACCOUNT_ID>.r2.cloudflarestorage.com`; do not use a public website or bucket URL here.
4. In the Node web service's environment settings, add:

   ```text
   STORAGE_PROVIDER=r2
   R2_ACCOUNT_ID=<Cloudflare account ID>
   R2_ACCESS_KEY_ID=<R2 token access key ID>
   R2_SECRET_ACCESS_KEY=<R2 token secret access key>
   R2_BUCKET_NAME=print-wallah-files
   ```

   Keep `UPLOAD_DIR` unset for this configuration. Set these only in the server's secret environment settings—never in browser code, print-agent config, Git, or chat.
5. Save and redeploy. The app accesses R2 server-to-server; no public bucket domain or bucket CORS configuration is needed. PostgreSQL, admin credentials, and `APP_URL` must still be configured normally.
6. Check service startup logs and `/api/health`. Create a test shop, upload a PDF, confirm an order, and test printing. Once the agent reports success, the order's uploaded source file and generated print PDF should be deleted from R2; order/payment/audit metadata remains in PostgreSQL.
7. Review Cloudflare's current R2 pricing, free-usage allowance, and billing settings before accepting real customer files. Plans and allowances can change. Scope the token to this bucket and rotate it if exposed.

## R2 request usage in this app

The app uses `PutObject` for each uploaded file and each generated print PDF, and `GetObject` when it reads source images/PDFs or serves a file to the shop admin/print agent. It does not issue `HEAD` before downloads. `DeleteObject` removes expired uploads and completed print files; Cloudflare currently lists delete operations as free. As a rough Standard-storage estimate, one plain single-file order uses one Class A write and one Class B read for the agent download. Each extra agent download/retry or admin file download adds one Class B read. A photo order with one source image uses two Class A writes and two Class B reads (source processing and agent download). A bundle of N source files uses N+1 Class A writes and N+1 Class B reads for source processing plus one agent download. This is an estimate: user re-downloads, retries, order type, and application/provider behavior change counts. Monitor actual R2 usage and current pricing; free allowances are monthly quotas, not a guarantee that all usage is free.

## Render environment settings

- `NODE_ENV=production`
- `APP_URL=https://your-service.onrender.com` (replace with the actual deployed URL)
- `DATABASE_URL` = the Render database's internal URL
- For Render internal connections, follow the database's current SSL instructions. For external TLS connections, prefer `DATABASE_SSL=strict` when the provider certificate is publicly verifiable; use `true` only when the provider requires TLS but its certificate cannot be verified by Node.js.
- Either Cloudflare R2 variables above, or `UPLOAD_DIR=/var/data/print-wallah` (must match an attached persistent disk mount path)
- `JWT_SECRET`, `SUPER_ADMIN_EMAIL`, `SUPER_ADMIN_PASSWORD` = private values set in Render, never in source control

Render plan availability, persistent disk pricing, and dashboard labels can change. Review the current Render dashboard before selecting a plan. The code does not hardcode Render hostnames.
