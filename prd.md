# Project Requirements Document: Stream 1 (Customer Portal & Payment Flow)
**Project:** Print-on-Go (Powered by DEVELOPERS)
**Scope:** Mobile-first customer web portal, multi-format file upload pipeline, dynamic pricing calculator, direct merchant UPI intent integration, and automatic print queue triggering.

## Core Features & Requirements
1. **Dynamic QR Landing Page:** When a customer scans a shop QR code (`/shop/{shopId}`), they access a mobile-optimized upload portal tied specifically to that shop's configuration and VPA.
2. **Secure Document Uploader:** Support for uploading PDF documents and standard image formats (`.png`, `.jpg`, `.jpeg`) with automatic file size and format validation.
3. **Interactive Print Configuration UI:**
   - Dropdown for Print Type (Black & White vs. Full Color) using the specific shop's pre-configured rates.
   - Number of copies counter.
   - Real-time total cost calculation.
4. **Direct Merchant UPI Intent Integration:**
   - Dynamic generation of `upi://pay` deep-links containing the shop's VPA, exact calculated amount, and unique order note.
   - One-tap redirection to the customer's default UPI application (Google Pay, PhonePe, Paytm).
5. **Payment Callback & Print State Trigger:**
   - Post-payment redirection handling with a verification state.
   - Backend endpoint to update order status to `READY_TO_PRINT` upon successful intent callback execution.
6. **Strict Data Privacy & Auto-Purge:** Automatic deletion of uploaded customer files from server storage (`/uploads`) immediately following successful print fulfillment or session expiry.
