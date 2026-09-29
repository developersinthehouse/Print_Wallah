# System Architecture & Tech Stack: Stream 1
**Focus:** Customer Mobile Portal, File Handling, and Direct UPI Payment Pipeline

## Tech Stack
* **Frontend:** HTML5, Tailwind CSS (via CDN), Vanilla JavaScript (ES6+ for state management and intent generation).
* **Backend Framework:** Node.js with Express.js.
* **File Upload Middleware:** `multer` for secure, multi-part form data handling.
* **Database / State Model:** In-memory order queue / MongoDB document storing order metadata (`orderId`, `shopId`, `filePath`, `amount`, `status`).

## Folder Structure (Stream 1 Focus)
```text
print-wallah/
├── .venv/                      # (Developer 2 - Python Environment)
├── desktop-agent/              # (Developer 2 - Python Print Agent)
│   ├── __pycache__/
│   ├── agent.py                # Background polling & local printer trigger
│   └── requirements.txt
│
├── backend/                    # UNIFIED BACKEND (Node.js & Express)
│   ├── node_modules/
│   ├── uploads/                # 🆕 [Developer 1] Temporary folder for customer uploaded files
│   ├── routes/
│   │   ├── shopRoutes.js       # (Developer 2 - Shop Admin & Management routes)
│   │   └── customerRoutes.js   # 🆕 [Developer 1] File upload, UPI intent generator & payment callback
│   ├── middleware/
│   │   └── subCheck.js         # (Developer 2 - Subscription Expiry & Auto-locking)
│   ├── package-lock.json
│   ├── package.json
│   └── server.js               # ⚠️ Main entry point merging both shop and customer routes
│
├── frontend/                   # UNIFIED FRONTEND
│   ├── views/                  # (Developer 2 - Admin Dashboards)
│   │   └── shop-admin.html
│   └── customer/               # 🆕 [Developer 1] Customer Mobile Web App
│       └── index.html          # Mobile UI, file picker, live price calculator & UPI intent
│
├── architecture.md             # (Shared Documentation)
├── design.md                   # (Shared Documentation)
├── memory.md                   # (Shared Memory / State Tracker)
├── phases.md                   # (Shared Roadmap)
├── prd.md                      # (Shared PRD)
└── rules.md                    # (Shared Rules)

# You have to create only those files which are regarded to developer 1 not for the developer 2. Those files are just for the reference.
