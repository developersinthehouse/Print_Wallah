# Deploy to Render

1. Push this project to a Git repository you control.
2. Create the Firebase project and Firestore database, and configure the existing Cloudflare R2 bucket as described in [Firebase and Cloudflare setup](FIREBASE.md). Publish the deny-all Firestore client rules and wait until every required composite index is **Enabled**.
3. For an existing production installation, migrate and compare its data by following [the Firebase migration and cutover guide](FIREBASE_MIGRATION.md) before sending customer traffic to this deployment. Do not create a duplicate first shop after importing production data.
4. Create a **Web Service** from the repository. Choose Node 22 or newer, `npm install` as the build command, and `npm start` as the start command.
5. Add the Firebase project ID, service-account JSON, R2 account ID/access key/secret/bucket name, `APP_URL`, `JWT_SECRET`, `SUPER_ADMIN_EMAIL`, and `SUPER_ADMIN_PASSWORD` in the web service's private environment settings. Use the same Firebase project and R2 bucket locally.
6. Deploy and verify HTTPS. For a new installation, sign in as Super Admin and create the first shop. For an existing installation, verify the imported shops and orders against the migration checklist. Test the customer portal and print agent in staging before switching production traffic.

Customer file bytes are deleted from the R2 bucket immediately after the print agent reports a successful print. If R2 is temporarily unavailable, the server retries cleanup in its background sweep. Order, payment, and audit records remain in Firestore. Keep the existing bucket and its access restricted. Restrict service-account access and admin passwords. UPI remains manually verified; do not automate approvals until a provider adapter is configured.

## Render environment settings

- `NODE_ENV=production`
- `APP_URL=https://your-service.onrender.com` (replace with the actual deployed URL)
- `FIREBASE_PROJECT_ID` and `FIREBASE_SERVICE_ACCOUNT_JSON` = the same private Firebase project configuration used by local development
- `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, and `R2_BUCKET_NAME` = credentials and bucket for the existing private Cloudflare R2 storage
- `JWT_SECRET`, `SUPER_ADMIN_EMAIL`, `SUPER_ADMIN_PASSWORD` = private values set in Render, never in source control

Render plan availability, persistent disk pricing, and dashboard labels can change. Review the current Render dashboard before selecting a plan. The code does not hardcode Render hostnames.
