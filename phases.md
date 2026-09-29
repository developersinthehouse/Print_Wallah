# Development Roadmap: Stream 2
**Focus:** Automation, Expiry Logic, and Management Dashboards

* **Phase 2.1: Python Desktop Print Agent (`agent.py`) — Implemented**
  - Build continuous polling loop querying backend for `READY_TO_PRINT` jobs.
  - Implement local Windows system command hooks to fire documents directly to the connected physical printer.
* **Phase 2.2: Shopkeeper Management Dashboard & Rate Config — Implemented**
  - Develop backend endpoints for updating custom shop print rates.
  - Create the shop admin UI view for monitoring daily print history.
* **Phase 2.3: Automated Subscription Expiry & Locking Engine — Implemented**
  - Implement date-tracking fields (`subscription_expiry_date`) in shop database profiles.
  - Build middleware to lock dashboard access and suspend agent print polling when validity lapses.
  - Add instant renewal payment callback handler to auto-extend expiry timelines.
* **Phase 2.4: DEVELOPERS Super Admin Panel — Implemented**
  - Build master control interface for registering new shops and generating shop IDs/QR mappings.
  - Implement platform-wide analytics and manual override controls.