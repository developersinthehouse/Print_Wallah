# Payments

## What is real today

Print Wallah builds the standard NPCI `upi://pay` link from the shop's own configured UPI ID and the **server-calculated** amount:

`upi://pay?pa=<shop upi id>&pn=<shop name>&am=<amount>&cu=INR&tr=<order code>&tn=Print order <order code>`

- Android and iOS phones open the customer's installed UPI app from the "Open UPI app" button (and automatically right after the order is created).
- Desktop browsers show a QR code of the same link to scan with a phone.
- The UPI ID and amount can also be copied, for apps that do not accept the link.

## What cannot be automatic

A UPI link only opens the customer's app. Neither the browser nor this server is told whether the payment succeeded, and the app does not report back. Verifying a payment needs a payment provider or bank API. Without one, the flow is:

1. Order is created as `pending_payment`. Nothing can print yet.
2. Customer pays in their UPI app, returns and taps **I have paid** (optionally entering the transaction ID). Order becomes `payment_review`.
3. The shop checks the credit in its own UPI app (the order code is in the payment note) and presses **Payment received**. Only then is the print job created.
4. If money was not received, the shop presses **Not received** (order cancelled, no job).

A timer or the customer's own tap never marks a payment verified. Customers can switch to cash or cancel while payment is unclaimed.

Practical note: some UPI apps limit or flag payments to **personal** UPI IDs when the amount is pre-filled through a link ("payment declined for security reasons"). A merchant (business) UPI ID from the shop's bank or a PSP avoids this.

## Optional automatic confirmation (integration point)

Set `PAYMENT_WEBHOOK_SECRET` (24+ random characters) to enable `POST /api/payments/webhook`. Any payment provider, bank notification bridge or small adapter you build can call it:

```
POST /api/payments/webhook
X-PW-Signature: sha256=<hex HMAC-SHA256 of the raw request body using PAYMENT_WEBHOOK_SECRET>
{"eventId":"unique-per-event","orderCode":"PR-...","status":"paid","amount":40.00,"currency":"INR","providerPaymentId":"..."}
```

The server checks the signature (timing-safe), refuses repeated `eventId`s (idempotent), requires the order to be an unpaid UPI order, requires the amount to match the order exactly, and only then verifies it and queues the print job. A wrong amount returns 422 and verifies nothing. Every event is stored in `payment_events` with its outcome.

What you must supply for this to be automatic: a provider account (for example a UPI collect/QR product with webhooks) and a small adapter that translates its webhook into the JSON above. The app does not ship a provider-specific adapter because none can be tested without your credentials.
