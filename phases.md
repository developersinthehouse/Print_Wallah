# Development Roadmap: Stream 1
**Focus:** Customer Flow Step-by-Step Execution

* **Phase 1.1: Mobile Frontend UI & Responsive Layout**
  * Build mobile-first layout in `index.html` using Tailwind CSS.
  * Construct sticky headers, responsive file input zones, and structured settings forms.
* **Phase 1.2: Dynamic Price Calculator & Shop Settings Fetcher**
  * Implement frontend logic to fetch shop-specific rates (`shopId`).
  * Add event listeners for copy counters and color mode switches to compute live totals.
* **Phase 1.3: Backend File Upload & Temporary Storage Pipeline**
  * Set up Express server (`server.js`).
  * Configure `multer` storage engine to accept and save customer documents temporarily.
* **Phase 1.4: Dynamic UPI Intent & Payment Callback Handler**
  * Write utility function to generate standard `upi://pay` deep-links with exact calculated amounts.
  * Build callback validation routes to transition order states to `READY_TO_PRINT` for the desktop print agent.
