# System Architecture & Tech Stack: Stream 2
**Focus:** Background Automation, Subscription Lifecycle, and Admin Control

## Tech Stack
* **Desktop Agent:** Python 3.x (`requests` for HTTP polling, system print execution utilities).
* **Backend & Middleware:** Node.js, Express.js (Shop management APIs, cron jobs/expiry middleware, subscription state machine).
* **Database / Models:** PostgreSQL (`shop_profiles`, `print_jobs`, `subscription_logs`, `admin_audit`, `super_admin_users`) using `DATABASE_URL`; local development uses the `print_wallah_pg_data` Docker volume. Uploaded document bytes remain in the customer uploader's object storage and are referenced by `print_jobs.file_url`.
* **Admin Frontend:** HTML5, Tailwind CSS, Vanilla JavaScript or lightweight frontend views for Shop Admin & Super Admin panels.

## Folder Structure (Stream 2 Focus)
```text
print-on-go/
├── stream-2-agent-admin/
│   ├── desktop-agent/
│   │   ├── agent.py               # Python polling script for shop PC and auto-printing
│   │   └── requirements.txt       # Python dependencies (requests)
│   │
│   ├── backend/
│   │   ├── server.js              # Shop management, rate configuration, & subscription APIs
│   │   ├── postgresRepositories.js # PostgreSQL adapters for shop, jobs, and audit data
│   │   ├── db/
│   │   │   └── migrations/        # Versioned PostgreSQL schema migrations
│   │   ├── middleware/
│   │   │   └── subCheck.js        # Subscription validity & auto-locking middleware
│   │   └── package.json           # Node dependencies
│   │
│   └── frontend/
│       └── views/
│           ├── shop-admin.html    # Shopkeeper dashboard (rates & print history)
│           └── super-admin.html   # DEVELOPERS master control panel