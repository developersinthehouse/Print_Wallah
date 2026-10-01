# Print Wallah

Print Wallah is a lightweight multi-shop printing platform made by DEVELOPERS. It uses a vanilla HTML/CSS/JavaScript application, a Node.js and Express REST API, and PostgreSQL. The same deployment serves the Super Admin, shop admin, and shop-specific customer portal.

## What is implemented

- Environment-configured Super Admin authentication and shop-specific admin login.
- Shop creation, editing, lock/unlock, access extension, per-shop rates, UPI identity, unique portal URL, and downloadable QR code.
- PostgreSQL records for shops, orders, uploads, payment reviews, print jobs, access extensions, and administrative audit history.
- Private PDF/JPG/PNG uploads with size/type checks, PDF page counting, upload expiry, and shop ownership checks.
- Customer pricing is calculated again on the server using that shop's saved price card. Cash orders wait for shop confirmation.
- UPI intent links with the shop UPI ID, server-calculated amount and order code prefilled. Customers tap "I have paid" and shop staff verify receipt in their UPI app before an order is queued (a customer tap never verifies anything).
- Shop dashboard, order filtering, document access, cash/payment review, date-range analytics, settings, and print-job controls.
- Atomic shop-specific print-job leasing and a Python agent that runs a configured OS print command and reports the result.
- Photo quantity/sheet calculation and printable PDF output with selected photo size, page orientation, margins, crop, and cut guides.
- Dark, mobile-first customer portal with a real print preview (paper size, orientation, scaling, margins, colour, copies, PDF pages, photo layouts), multi-photo sheets and a full UPI/cash checkout with order tracking.
- Optional signed payment webhook for automatic UPI confirmation (`docs/PAYMENTS.md`).

## Testing on your phone

`npm run dev` (or `npm start`) listens on all network interfaces and prints, for example:

```
Local:   http://localhost:3000
Network: http://192.168.1.20:3000   <- open this on your phone (same Wi-Fi)
```

Open the Network URL on the phone, sign in to Super Admin there, and shop links and QR codes will use that address. Allow Node.js through the firewall for private networks if the phone cannot connect. Set `HOST=127.0.0.1` to keep the server local. UPI links open an installed UPI app on the phone; on a desktop the portal shows a QR code instead.

## Tests

`npm test` (unit), `npm run smoke` and `npm run test:payments` (need the server running with the same `.env`; set `PAYMENT_WEBHOOK_SECRET` for payments), `npm run test:all`.

## Requirements

- Node.js 20 or newer
- PostgreSQL 14 or newer
- Python 3.10 or newer for the optional local print agent (no third-party Python packages)

## Local setup

1. Create a PostgreSQL database and a database user with permission to create tables and the `pgcrypto` extension. For example, from `psql` as a database administrator:

   ```sql
   CREATE USER printing_user WITH PASSWORD 'choose-a-local-password';
   CREATE DATABASE printing_platform OWNER printing_user;
   ```

2. Copy `.env.example` to `.env`, set `DATABASE_URL`, choose a long random `JWT_SECRET`, and set `SUPER_ADMIN_EMAIL` and `SUPER_ADMIN_PASSWORD`. See [environment variables](docs/ENVIRONMENT.md).

3. Install packages and initialize the schema:

   ```powershell
   npm install
   npm run db:init
   npm start
   ```

4. Open `http://localhost:3000/` and sign in as the Super Admin. Create the first shop; its portal URL, QR, and shop admin are generated automatically.

Shop Admin access uses the same site at `http://localhost:3000/admin`. Choose **Shop admin sign in** on the login screen, then use the shop-admin email and password assigned when the Super Admin created the shop. The Super Admin can update the shop-admin email or reset its password from the shop's **Details → Edit shop** screen.

The server also initializes the schema on startup, so `npm run db:init` is safe to repeat. There is no seeded shop or default password.

## Deployment

See [Render deployment](docs/DEPLOYMENT.md). Create a PostgreSQL database and a Node web service. Configure `DATABASE_URL`, `DATABASE_SSL`, `APP_URL`, `JWT_SECRET`, `SUPER_ADMIN_EMAIL`, and `SUPER_ADMIN_PASSWORD` as Render environment variables. Set build command to `npm install` and start command to `npm start`.

Uploaded documents are kept in `UPLOAD_DIR`. The app does not expose that directory as static content. The default local directory is `./storage`; production must mount persistent storage at the chosen path and set `UPLOAD_DIR` to it. Render's ephemeral filesystem is not suitable for customer files across deploys/restarts.

## Payment and printing setup

**Pay Online** creates the order using the server-calculated amount and the selected shop's configured UPI ID, then opens a standard `upi://pay` intent with the amount, payee and order code prefilled. The customer only needs to complete payment in their UPI app; they do not need to return and type a UTR. Shop staff must still confirm the exact amount reached their account before the job is queued. Returning from a UPI app is not proof of payment. Automatic payment verification needs a merchant provider account and authenticated webhook credentials, which are not included. `/admin` opens Shop Admin sign-in directly unless a shop-admin session is already active.

Shop computers run the optional Python print agent. It polls only its own shop queue and requires an OS print command configured in `agent/config.json`. See [print agent setup](docs/PRINT_AGENT.md). The agent reports that the configured print command accepted the job; it cannot confirm paper physically emerged from the printer.

## Useful commands

```powershell
npm run dev       # restart-on-change local server
npm test          # unit tests for price and access rules
python -m unittest discover -s agent -p 'test_*.py'  # print-agent unit tests
npm run smoke     # API end-to-end check against a running test instance
npm run db:init   # initialize or upgrade the current schema
```

## API and current limitations

See [API reference](docs/API.md) and [architecture and implementation status](MEMORY.md). The image preview approximates the selected paper and scaling; PDF preview is the browser's first-page viewer. Printer drivers still determine final color, margins, scaling, and output quality; the preview is not hardware-calibrated proofing.

Online payments are manually reconciled. There is no gateway or automatic webhook verification until a supported provider account and credentials are configured. For production, use persistent private storage, HTTPS, a restricted PostgreSQL user, backups, and a payment-provider integration before accepting remote payments at scale.
