# Print Wallah

Print Wallah is a multi-shop printing platform with a vanilla HTML/CSS/JavaScript frontend, a Node.js and Express API, Cloud Firestore records, and Cloudflare R2 for customer documents and generated print files. Local development and production use the same Firebase project and R2 bucket so orders, queues, shop settings, and files remain shared.

## Features

- Super Admin and shop-specific admin authentication, shop management, access periods, pricing, UPI identity, portal links, and QR codes.
- Customer PDF/JPG/PNG uploads, server-side pricing, order and payment review, and cash/UPI checkout.
- Shop dashboards, analytics, settings, payment review, and print-job controls.
- Atomic per-shop print-job leasing for the optional Python agent.
- Multi-file document bundling and photo print layout generation.
- Automatic deletion of uploaded and generated print files about 10 minutes after successful printing; order, payment, and audit metadata remains.

## Setup

Create a Firebase project with Firestore and use the existing Cloudflare R2 bucket, then configure `.env` using [`.env.example`](.env.example). Follow [Firebase and Cloudflare setup](docs/FIREBASE.md) for Console steps and private credential handling. Configure the same Firebase project, R2 bucket, and credentials for local and hosted servers. Never add secrets to frontend code or source control. For production data migration and the safe cutover sequence, use [the Firebase migration guide](docs/FIREBASE_MIGRATION.md).

Requirements: Node.js 22 or newer. Python 3.10 or newer is only needed for the optional local print agent.

```powershell
npm install
npm start
```

Open `http://localhost:3000/`. The server listens on network interfaces by default and prints its LAN address for phone testing. To use watch mode, run `npm run dev`. See [environment variables](docs/ENVIRONMENT.md) and [Render deployment](docs/DEPLOYMENT.md).

## Tests

Run `npm test` for unit tests. The Python print agent has its own unittest suite: `python -m unittest discover -s agent -p 'test_*.py'`.

## Payment and printing

UPI payments are manually verified by shop staff. A customer returning from a UPI app is not proof of payment. Automatic payment verification requires a supported provider adapter and authenticated webhook credentials; see [payment setup](docs/PAYMENTS.md). Shop computers can run the optional print agent; see [print agent setup](docs/PRINT_AGENT.md).

See [API reference](docs/API.md) and [architecture notes](memory.md) for more detail.
