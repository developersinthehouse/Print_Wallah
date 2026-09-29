# Project Requirements Document: Stream 2 (Shop Agent, Subscription Engine & Super Admin)
**Project:** Print Wallah (Powered by DEVELOPERS)  
**Scope:** Python background desktop print agent, shopkeeper pricing/management dashboard, automated subscription expiration & locking middleware, and DEVELOPERS master super admin panel.

## Core Features & Requirements
1. **Python Desktop Print Agent (`agent.py`):**
   - Background polling service running on the shopkeeper's Windows PC.
   - Secure fetching of `READY_TO_PRINT` jobs via `shopId`.
   - Automatic execution of Windows local printer commands without manual user intervention.
2. **Shopkeeper Management Dashboard:**
   - Interface for individual shop admins to configure custom local rates (B&W vs. Full Color price per page).
   - Live analytics viewing (daily print counts and transaction history).
3. **Automated Subscription & Locking Engine:**
   - Backend middleware/cron monitoring `subscription_expiry_date` for each registered shop.
   - Automatic locking mechanism: Blocks shop dashboard and pauses desktop print agent upon validity expiration.
   - Self-service online renewal workflow that instantly reactivates shop access upon payment verification.
4. **DEVELOPERS Super Admin Panel:**
   - Master dashboard for onboarding new shops and generating unique dynamic QR codes.
   - Global system overview tracking total active subscriptions, expired accounts, and aggregate platform volume.