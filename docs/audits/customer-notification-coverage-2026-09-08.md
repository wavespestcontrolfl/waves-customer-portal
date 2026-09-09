# Customer notification coverage

Owner request, September 8: offer App for the 72-hour and 24-hour reminders,
label the delivery choice **App**, and map the other customer notifications.

The reminder implementation in [PR #4178](https://github.com/wavespestcontrolfl/waves-customer-portal/pull/4178) extends the existing account preferences and delivery
pipeline. Selecting App requests a push; provider acceptance suppresses the
replacement text. Unavailable delivery uses the existing allowed fallback.
Neither the individual choices nor the shortcut enable muted categories or
clear text/email opt-outs. A provider accepting a push does not establish that
the phone displayed it or that the customer read it.

## Coverage and next priorities

“App choice” below means the customer can select App as the delivery method.
An existing companion push is different: it accompanies a text and does not
give the customer that replacement choice.

| Customer event | Current coverage, including the implementation in PR #4178 | Customer control and destination | Recommended next action |
| --- | --- | --- | --- |
| Appointment booked, changed, cancelled or marked no-show | Existing App choice for supported appointment notices | Appointment Confirmations; Visits | Keep one notice per appointment event. |
| 72-hour reminder | App choice implemented in PR #4178; existing timing, one-time email default and explicit-choice rules remain | 72-Hour Appointment Reminder; Visits | Included now. |
| 24-hour reminder | App choice implemented in PR #4178; existing day-before and quiet-hour rules remain | 24-Hour Service Reminder; Visits | Included now. |
| Technician en route | Existing App choice; live tracker is on Home | Tech En Route Alert; Home | Keep the arrival estimate and tracker together. |
| Technician arrived | Existing App choice | Tech Arrived Alert; Home | Keep separate from en route so customers can mute either. |
| Service completed / report ready | App choice for supported automatic completion/report notices; attachments and bundled review asks retain their existing channel | Service Reports; Visits | Treat completion and report availability as one customer event where the report is ready at completion. A future direct-report destination should use the authorized report record. |
| Standalone invoice issued / payment link ready | Existing text/email invoice delivery; standalone `invoice` and `payment_link` are outside App replacement routing | Existing invoice and billing recipient rules | **Next priority:** add an invoice App choice and open the specific payable invoice. A homeowner must not receive a payer's invoice or payment details. |
| Payment received / receipt ready, including deposit receipts | Existing App choice; allowed emailed receipt copies continue | Payment confirmations in Billing; Billing | Already covered. Keep the durable receipt copy and per-invoice deduplication. |
| Payment failed, retry outcome or bank verification needs action | Supported billing types have companion push + text; no customer App replacement choice | Existing billing preferences; Billing | **Next priority:** an explicit “Payment problems” App choice, with allowed fallback and a specific action destination. |
| Upcoming automatic charge / expiring payment method | Supported types have companion push + text; no customer App replacement choice | Existing billing preferences; Billing | Include in the billing-preference work; keep advance notice distinct from payment success/failure. |
| Invoice due / overdue follow-up | Existing invoice follow-up text/email; the concrete `invoice_followup` type is outside App routing | Existing collection and billing contact rules | **Next priority:** cover this concrete sender as part of invoice notifications. Stop reminders when paid, voided or otherwise ineligible. |
| Weekly watering plan ready | Existing Monday App/bell notice and saved My Property plan; currently requires an eligible sent email snapshot | Weather & Property Alerts and account App switch; My Property | Keep the current plan notice. App-only plan generation is a separate gap; do not promise it to email opt-outs. |
| Weather / property advisory | Existing App/bell notices with preference, quiet-hour and frequency checks | Weather & Property Alerts and account App switch | Keep useful property-specific advisories. Do not duplicate a current weekly watering plan with a competing irrigation alert. |
| Estimate, contract or card request needs action | Existing document/request text and email paths; outside App replacement routing | Existing recipient/token rules | Later: notify signed-in customers in App and open the exact authorized request. Prospects still need the existing external delivery. |
| Service request received or updated / resolution accepted | Existing account lifecycle emails | Existing request/email rules | Later: add App status notices tied to the customer's request, without creating a second support conversation. |
| Membership started, changed, paused, resumed, cancelled or approaching renewal | Existing account lifecycle email paths | Existing account/membership rules | Later: add useful App notices for actual state changes and required actions. Avoid repeating changes the customer just completed unless confirmation is needed. |
| Referral reward earned | Existing referral text/email flows; outside App replacement routing | Referral preferences and reward ownership | Optional App notice for an earned reward. Keep invitations and promotional nudges separate. |
| Staff conversations, sign-in/security codes, review requests and marketing | Existing channels; intentionally outside the App shortcut | Existing conversation/security/consent controls | Keep these separate. A staff-selected Text action must remain a text; login must not depend on already opening the app. |

## Delivery rules for follow-up work

- Reuse the existing sender and event identity for each family. Do not create
  another scheduler, subscriber list or generic broadcast path.
- Respect category opt-outs, account App settings, authorized properties,
  third-party payer ownership, quiet hours and current event eligibility.
- Show **App** in customer controls. Explain allowed fallback in nearby help
  text; the label does not promise that text/email consent has changed.
- A pending push attempt must remain pending. It must not trigger a racing
  backup or close a reminder as sent. Failed or stale devices use only an
  already-allowed fallback.
- Make each tap useful: the relevant appointment, report, invoice, request or
  current watering plan, with the correct account/property authorization.
- Keep informational notices, required actions and promotional messages
  distinguishable in preferences. Do not turn on new categories silently.

## Evidence and release state

The baseline inspected was `c661eec55039cb39b47f624ab5595df713b9e4e5`.
The customer App preference gate, legacy push-routing gate, property-alert
gate and both irrigation plan gates were enabled in the production service
when checked on September 8. This is configuration/code evidence, not a claim
that every notification family has been delivered to a physical phone.

The 72-hour/24-hour preference extension is implemented in PR #4178 and was
awaiting production merge when this map was written.
The other recommended additions above are a coverage plan, not new sends or
new automatic triggers. App Store version 1.5 (build 6) was submitted to Apple
and is waiting for review with automatic release after approval selected.

Source paths:

- [Preference API](../../server/routes/notifications.js) and
  [customer controls](../../client/src/pages/PortalPage.jsx).
- [Push routing policies and family mapping](../../server/services/messaging/push-channel-routing.js),
  [guarded delivery](../../server/services/messaging/send-customer-message.js),
  and [reminder scheduler](../../server/services/appointment-reminders.js).
- [Report delivery](../../server/services/service-report/delivery.js) and
  [report emails](../../server/services/service-report/email-delivery.js).
- [Invoice and receipt sends](../../server/services/invoice.js),
  [invoice/receipt email recipients](../../server/services/invoice-email.js),
  [receipt delivery queue](../../server/services/receipt-delivery-queue.js),
  [invoice follow-ups](../../server/services/invoice-followups.js), and
  [automatic-payment notices](../../server/services/autopay-notifications.js).
- [Property alerts](../../server/services/property-alerts.js) and
  [weekly irrigation scope](../irrigation-email-and-app-notifications-scope.md).
- [Account/request/membership emails](../../server/services/account-membership-email.js),
  [referrals](../../server/services/referral-engine.js), and
  [review requests](../../server/services/review-request.js).
