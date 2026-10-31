# Firebase and Cloudflare setup

Print Wallah uses **Cloud Firestore** for application records and your existing **Cloudflare R2 bucket** for uploaded and generated print files. Firebase Storage is not used, so you do not need to enable Firebase Storage or attach Blaze billing just for file storage. Firestore has a no-cost quota; usage beyond its limits may require billing. Check the current [Firestore pricing and quotas](https://firebase.google.com/docs/firestore/pricing).

## Firebase Console

1. Create a Firebase project and choose the Firestore location carefully; it cannot be changed later.
2. Create Cloud Firestore in production mode.
3. Keep client access denied using [`firestore.rules`](../firestore.rules). The Express server uses Firebase Admin SDK credentials and accesses Firestore server-side.
4. Create the composite indexes in [`firestore.indexes.json`](../firestore.indexes.json) and wait until required indexes are enabled.
5. In **Project settings → Service accounts**, create a private server service-account key. Never commit it or expose it to frontend code.

## Cloudflare R2

Use the existing bucket that already contains production print files. In Cloudflare, create an R2 API token scoped to that bucket with **Object Read & Write** permissions. Keep the token credentials private. Preserve the bucket and existing object keys; the app uses those object names to retrieve and delete files.

R2 includes a free tier (currently 10 GB-month storage, 1 million Class A operations and 10 million Class B operations per month, with free egress); usage above the free tier is charged. Check [current R2 pricing](https://developers.cloudflare.com/r2/pricing/) for account-specific details. Keep a billing alert/usage review in place if appropriate.

## Server configuration

Set these values in the ignored local `.env` file and in the hosted service's private environment. Local and production must use the same Firebase project and the same R2 account/bucket to see the same orders and files.

- `FIREBASE_PROJECT_ID`: Firebase project ID.
- `FIREBASE_SERVICE_ACCOUNT_JSON`: full private service-account JSON.
- `R2_ACCOUNT_ID`: Cloudflare account ID.
- `R2_ACCESS_KEY_ID` and `R2_SECRET_ACCESS_KEY`: credentials for the scoped R2 API token.
- `R2_BUCKET_NAME`: exact existing bucket name.
- `JWT_SECRET`, `SUPER_ADMIN_EMAIL`, `SUPER_ADMIN_PASSWORD`: app authentication settings.

Do not send Firebase or R2 secrets in chat, put them in frontend settings, or commit them. The Admin SDK accesses Firestore only; the AWS S3-compatible SDK accesses R2 using its private endpoint and credentials.

## Data and cutover

Firestore stores shop, upload metadata, order, payment, print-job, audit and related records. File bytes remain in R2. There is no PostgreSQL runtime or SQL Editor schema in this setup. Follow [the production migration guide](FIREBASE_MIGRATION.md) before routing production traffic to the new Firestore-backed app. Keep the old production database available for rollback until the new app and print agent are verified; do not delete it as part of this code change.
