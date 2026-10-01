# Environment variables

Copy `.env.example` to `.env` locally. On Render, add the same values under the web service's Environment settings. Keep `.env` private and never paste secrets into `MEMORY.md` or commit them.

| Variable | Required | Meaning and where to get it | Example |
|---|---|---|---|
| `PORT` | No | Port for the web server. Render supplies this automatically. | `3000` |
| `NODE_ENV` | No | Set production cookie/security behavior on deployment. | `production` |
| `APP_URL` | Yes in production | Public root address used to create shop links and QR codes. No trailing slash. | `https://printing.example.com` |
| `JWT_SECRET` | Yes | Private signing key. Generate a random value of at least 32 characters. | `use-a-long-random-value` |
| `DATABASE_URL` | Yes | PostgreSQL connection string from your local database or Render database. | `postgresql://user:pass@host:5432/db` |
| `DATABASE_SSL` | Sometimes | Set `true` when the database provider requires TLS. Render external DB connections generally require TLS; use the provider's instructions. | `true` |
| `SUPER_ADMIN_EMAIL` | Yes | Email used to sign in to the platform owner account. | `owner@example.com` |
| `SUPER_ADMIN_PASSWORD` | Yes | Long unique password for the platform owner. | `use-a-password-manager` |
| `DEFAULT_ACCESS_DAYS` | No | Initial shop access duration. Defaults to 30 days. | `30` |
| `UPLOAD_DIR` | No locally; required persistent path in production | Private folder for uploaded print files. On Render, set this to a mounted persistent disk path. | `./storage` |
| `MAX_UPLOAD_MB` | No | Upload size limit. Defaults to 30 MB. | `30` |

The shop UPI ID and payee name are set per shop in the Super Admin form. There are no gateway secrets because automatic payment verification is not enabled.
