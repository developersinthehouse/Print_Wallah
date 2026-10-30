# Environment variables

Copy `.env.example` to `.env` locally. On Render, add the same values under the web service's Environment settings. Keep `.env` private and never paste secrets into `memory.md` or commit them.

| Variable | Required | Meaning and where to get it | Example |
|---|---|---|---|
| `PORT` | No | Port for the web server. Render supplies this automatically. | `3000` |
| `NODE_ENV` | No | Set production cookie/security behavior on deployment. | `production` |
| `APP_URL` | Yes in production | Public root address used to create shop links and QR codes. No trailing slash. | `https://printing.example.com` |
| `JWT_SECRET` | Yes | Private signing key. Generate a random value of at least 32 characters. | `use-a-long-random-value` |
| `DATABASE_URL` | Yes | PostgreSQL connection string. For this project, use the Supabase project's connection string (Dashboard → Connect). | `postgresql://user:password@host:5432/postgres` |
| `DATABASE_SSL` | Yes for Supabase | Set `true` for Supabase so the Node PostgreSQL client uses TLS. | `true` |
| `SUPER_ADMIN_EMAIL` | Yes | Email used to sign in to the platform owner account. | `owner@example.com` |
| `SUPER_ADMIN_PASSWORD` | Yes | Long unique password for the platform owner. | `use-a-password-manager` |
| `DEFAULT_ACCESS_DAYS` | No | Initial shop access duration. Defaults to 30 days. | `30` |
| `UPLOAD_DIR` | No locally; required persistent path in production | Private folder for uploaded print files. On Render, set this to a mounted persistent disk path. | `./storage` |
| `MAX_UPLOAD_MB` | No | Upload size limit. Defaults to 30 MB. | `30` |
| `PAYMENT_WEBHOOK_SECRET` | No | Private HMAC secret (24+ random characters) for the generic payment webhook receiver. It does not connect a provider by itself; a provider-specific adapter is still required. | Set privately; see [payment setup](PAYMENTS.md) |

The shop UPI ID and payee name are set per shop in Super Admin or Shop Admin settings. Keep `PAYMENT_WEBHOOK_SECRET` unset until a trusted, provider-specific adapter is ready. Never put provider secrets in frontend code or share them in chat.

For Supabase setup and deployment, see [Supabase setup](SUPABASE.md). Keep the database password inside your private `.env` or hosting provider's secret settings; do not commit it.
