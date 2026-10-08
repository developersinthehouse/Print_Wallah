# Payments

## What is real today

Print Wallah builds the standard NPCI `upi://pay` link from the shop's own configured UPI ID and the **server-calculated** amount:

`upi://pay?pa=<shop upi id>&pn=<shop name>&am=<amount>&cu=INR&tr=<order code>&tn=Print order <order code>`

- The browser sends the `upi://pay` link to the phone's operating system. The OS opens its default compatible UPI app or asks the customer to choose an installed app; the website cannot inspect installed apps or know which app was selected. If none opens, the customer can scan the QR with another phone, copy the payment details, or choose cash.
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

The app has a generic signed receiver at `POST /api/payments/webhook`; **setting its secret alone does not connect a payment provider or make payments automatic**. First obtain a provider account/product that supports payment webhooks, then deploy a provider-specific adapter that verifies the provider's own signature and maps only confirmed captures to this contract. The adapter signs the exact JSON request body with `PAYMENT_WEBHOOK_SECRET` and sends:

```
POST /api/payments/webhook
X-PW-Signature: sha256=<hex HMAC-SHA256 of the raw request body using PAYMENT_WEBHOOK_SECRET>
{"eventId":"unique-per-event","orderCode":"PR-...","status":"paid","amount":40.00,"currency":"INR","providerPaymentId":"..."}
```

Set `PAYMENT_WEBHOOK_SECRET` to a private random value of at least 24 characters in the server environment, then restart/redeploy. The server checks the HMAC signature with a timing-safe comparison, validates the event fields, refuses repeated `eventId`s, requires an unpaid UPI order and exact INR amount, and only then verifies payment and queues printing. Missing/invalid currency or amount precision is rejected; an amount mismatch returns 422. Every accepted signed event is recorded in `payment_events` with its outcome. Never expose this secret in the browser or send it to customers.

What you must supply for this to be automatic: the provider name/product, a merchant account with webhook support, provider credentials stored only on the server/adapter, and the adapter itself. The app does not ship a provider-specific adapter because none can be tested without your account. Until that integration is configured and tested end-to-end, keep using manual verification against the shop's actual bank/UPI statement.
