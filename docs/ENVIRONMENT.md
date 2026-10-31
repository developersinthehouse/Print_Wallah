# Environment variables

Copy `.env.example` to `.env` locally. On Render, add the same values under the web service's Environment settings. Keep `.env` private and never paste secrets into `memory.md` or commit them.

| Variable | Required | Meaning and where to get it | Example |
|---|---|---|---|
| `PORT` | No | Port for the web server. Render supplies this automatically. | `3000` |
| `NODE_ENV` | No | Set production cookie/security behavior on deployment. | `production` |
| `APP_URL` | Yes in production | Public root address used to create shop links and QR codes. No trailing slash. | `https://printing.example.com` |
| `JWT_SECRET` | Yes | Private signing key. Generate a random value of at least 32 characters. | `use-a-long-random-value` |
| `FIREBASE_PROJECT_ID` | Yes | ID of the Firebase project shared by local and hosted servers. | `your-project-id` |
| `R2_ACCOUNT_ID` | Yes | Cloudflare account ID for the existing R2 bucket. | — |
| `R2_ACCESS_KEY_ID` | Yes | Access key for a bucket-scoped R2 Object Read & Write token. | — |
| `R2_SECRET_ACCESS_KEY` | Yes | Secret key for that R2 token. | — |
| `R2_BUCKET_NAME` | Yes | Exact existing R2 bucket name. | — |
| `FIREBASE_SERVICE_ACCOUNT_JSON` | Yes | Service account JSON for the trusted Node server. Store as a private environment secret. | Never commit or share this value. |
| `SUPER_ADMIN_EMAIL` | Yes | Email used to sign in to the platform owner account. | `owner@example.com` |
| `SUPER_ADMIN_PASSWORD` | Yes | Long unique password for the platform owner. | `use-a-password-manager` |
| `DEFAULT_ACCESS_DAYS` | No | Initial shop access duration. Defaults to 30 days. | `30` |
| `MAX_UPLOAD_MB` | No | Upload size limit. Defaults to 30 MB. | `30` |
| `PAYMENT_WEBHOOK_SECRET` | No | Private HMAC secret (24+ random characters) for the generic payment webhook receiver. It does not connect a provider by itself; a provider-specific adapter is still required. | Set privately; see [payment setup](PAYMENTS.md) |

The shop UPI ID and payee name are set per shop in Super Admin or Shop Admin settings. Keep `PAYMENT_WEBHOOK_SECRET` unset until a trusted, provider-specific adapter is ready. Never put provider secrets in frontend code or share them in chat.

For project creation and deployment, see [Firebase setup](FIREBASE.md) and [Render deployment](DEPLOYMENT.md). Keep service-account credentials inside private environment settings; do not commit them.
