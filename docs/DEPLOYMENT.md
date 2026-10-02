# Deploy to Render

1. Push this project to a Git repository you control.
2. In Render, create a PostgreSQL database. Copy its internal connection string for the web service.
3. Create a **Web Service** from the repository. Choose Node as the runtime, `npm install` as the build command, and `npm start` as the start command.
4. Add `DATABASE_URL`, `DATABASE_SSL`, `APP_URL`, `JWT_SECRET`, `SUPER_ADMIN_EMAIL`, and `SUPER_ADMIN_PASSWORD` in the web service environment settings. Use the exact public service URL for `APP_URL`.
5. Add a persistent disk and mount it, for example at `/var/data/print-wallah`. Set `UPLOAD_DIR=/var/data/print-wallah`. Production uploads fail closed with HTTP 503 until `UPLOAD_DIR` is an absolute path, so the service will not silently accept files on ephemeral storage.
6. Deploy. The application creates tables at startup. Visit the service root, sign in as the Super Admin, and create the first shop.
7. Verify HTTPS is enabled, create a test shop, scan/download its QR, check the customer portal, and install its print agent on the shop computer.

Owner decision: do not back up customer file bytes; they are deleted from live storage about 10 minutes after successful printing. Back up PostgreSQL order/payment/audit metadata, but configure disk snapshots so they cannot retain customer files past the stated deletion promise. Restrict database credentials and admin passwords. UPI remains manually verified; do not automate approvals until a provider adapter is configured.

## Render environment settings

- `NODE_ENV=production`
- `APP_URL=https://your-service.onrender.com` (replace with the actual deployed URL)
- `DATABASE_URL` = the Render database's internal URL
- `DATABASE_SSL=false` for the Render internal network unless Render currently instructs otherwise; use `true` for TLS-required external connections
- `UPLOAD_DIR=/var/data/print-wallah` (must match the persistent disk mount path)
- `JWT_SECRET`, `SUPER_ADMIN_EMAIL`, `SUPER_ADMIN_PASSWORD` = private values set in Render, never in source control

Render plan availability, persistent disk pricing, and dashboard labels can change. Review the current Render dashboard before selecting a plan. The code does not hardcode Render hostnames.
