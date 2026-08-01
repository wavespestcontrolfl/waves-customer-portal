# One-Time Appointment Deposits — Scoping Doc (DRAFT — pending owner decisions)

**Ask (Adam, 2026-08-01):** for speculative one-time appointments (example: a fly
inspection that may or may not turn into paid work), require a deposit — ~$75 or a
variable per-appointment amount — collected through the Auto Pay setup link, with the
appointment not treated as confirmed until the customer has paid the deposit and set
up Auto Pay. Available where the office books appointments (New Appointment sheet)
and baked into the AI call-booking flow. "Protects us from driving out and not
getting paid."

This document scopes the ask against what already exists. It proposes; it decides
nothing — §6 lists the owner decisions.

**Relationship to settled rulings:** `ESTIMATE_DEPOSIT_REQUIRED` stays off — this
scope does NOT touch the estimate-accept deposit and does not re-propose that flip.
The card-on-file build spec (§5 decision 5) recorded "no deposit anywhere, card hold
only" as the *default* for one-time jobs, explicitly reserved as an owner decision.
This ask is the owner revisiting that decision for a defined slice of one-time
appointments; nothing here proceeds until Adam confirms §6.

---

## 1. What already exists (all built, all dark)

The link Adam is describing already exists end-to-end — minus the dollar amount:

| Piece | State | Where |
|---|---|---|
| Per-appointment "secure your appointment" link (`/secure/:token`): saves card, records v10 consent, enrolls Auto Pay | Built, dark (`APPOINTMENT_CARD_REQUEST` + inactive `secure_appointment_card` SMS template) | `server/services/appointment-card-request.js`, `server/routes/secure-card-public.js`, `client/src/pages/SecureAppointmentPage.jsx` |
| New Appointment sheet checkbox "Text card-on-file link (Auto Pay setup)" (the screenshot) | Built, hidden while lane dark | `CreateAppointmentModal.jsx:2566`, `admin-schedule.js:3731` |
| Per-visit admin "Text card / Auto Pay link" button + status card | Built | `SchedulePage.jsx:1201`, `MobileAppointmentDetailSheet.jsx:501`, `admin-schedule.js:7777` |
| AI call pipeline auto-sends the same link post-booking | Built, wired | `call-recording-processor.js:9049` |
| /book wizard inline card step | Built | `booking.js:2586` |
| One-text-ever + one-request-per-visit idempotency, auto-secure from saved card, payer/first-time/priced-visit guards | Built | `appointment-card-request.js` |
| $49 late-cancel/no-show fee disclosure on the invite + page | Built (fee sourced from `pricing_config.estimate_card_hold`) | `appointment-card-request.js:122` |
| Customer appointment page with one-tap pending→confirmed | Built, dark (`GATE_APPOINTMENT_PAGE`) | `appointment-public.js`, `AppointmentPage.jsx` |
| Pay-and-save-in-one Stripe primitive (PaymentIntent + `setup_future_usage:'off_session'` → consent → enroll) | **Live** on the invoice pay page | `stripe.js:3312`, `pay-v2.js:896–994`, webhook mirror |
| Deposit ledger machinery (face-value credit, negative `deposit_credit` invoice line, refund sweeps, dispute handling, card-surcharge quote/finalize) | Built for **estimates only**, retired dark | `estimate-deposits.js`, `estimate_deposits` table |

What does **not** exist:

- The `/secure` page collects **no money** — SetupIntent only, copy hardcoded
  "nothing charged today."
- No deposit concept keyed to an appointment (`estimate_deposits.estimate_id` is
  NOT NULL; no `scheduled_services` deposit column).
- No per-record deposit amount anywhere (estimate deposits are flat class amounts
  from `pricing_config`).
- No confirmation gating: booking-confirmation SMS and the appointment page's
  confirm run independently of whether the card link was ever acted on.

So the direct answer to "can we add a dollar amount to the autopay setup?" is: not
today — but every ingredient exists, and the deposit becomes a **parameter on the
existing lane**, not a new system.

## 2. Options

### Option A — flip what's built, no code (card-hold posture)
Light `APPOINTMENT_CARD_REQUEST` + activate the SMS template (and optionally
`GATE_APPOINTMENT_PAGE`). First-time customers with priced one-time visits get
"add a card to finish booking"; card saved + Auto Pay enrolled; completion charges
the card; $49 covers a late cancel/no-show.

- Pros: zero build; lower customer friction; consistent with the 2026-07-12
  "charge at services rendered" philosophy; go-live runbook already written.
- Cons: no money in hand before the trip; a ghosting customer yields $49, not $75;
  weaker commitment signal than cash down.

### Option B — deposit variant on the same lane (the build)
Appointments flagged "deposit required, $X" send the same `/secure` link, but the
page shows **"$X deposit due today to confirm your visit — applied to your bill"**
and runs a PaymentIntent (face value, `setup_future_usage:'off_session'`) instead of
a SetupIntent. One submit = deposit paid + card saved + consent + Auto Pay enrolled.
Visit stays `pending` until the deposit lands; payment flips it `confirmed`.

### Recommendation: hybrid, phased
Flip Option A now — it is finished, protects every one-time booking immediately, and
its funnel telemetry was the launch-metrics bet. Build Option B as an increment on
the same lane for the slice Adam wants cash down on (speculative one-offs like the
fly inspection). One funnel, one link, one page; deposit is a per-appointment
parameter the office (or later the AI rules) sets.

## 3. Proposed design for the deposit variant (Option B)

**Data.** New table `appointment_deposits` mirroring `estimate_deposits` mechanics
(face `amount`, `credited_amount`, `refunded_amount`, unique
`stripe_payment_intent_id`, `card_surcharge`, status `pending → received →
credited / refunding / refunded / failed`), keyed `scheduled_service_id` NOT NULL.
Do not overload `estimate_deposits` — its FK and every write path are
estimate-shaped. Add `deposit_amount` (frozen at send, card-hold "frozen terms"
pattern) to `appointment_card_requests`.

**Amount.** Default from a new `pricing_config` key `appointment_deposit`
(e.g. `{ defaultAmount: 75 }`) following the pricing-config DB-authoritative
checklist (seed migration + db-bridge sync). Office can override per appointment at
send time: an amount field appears under the existing checkbox in
`CreateAppointmentModal` and on the per-visit "Text card / Auto Pay link" action.

**Stripe.** `createAppointmentDepositIntent` modeled on
`createEstimateDepositIntent` (metadata `purpose: 'appointment_deposit'`,
`base_amount` = face = the credit authority, idempotency keyed on request +
amount). Surcharge follows the 2026-07-13 estimate-deposit ruling verbatim: manual
card entry prices credit-funding-only via `computeChargeAmount` through a
quote/finalize pair (reuse the HMAC quote-token pattern); wallets pay face through
Express Checkout; the ledger credits FACE and the fee rides
`appointment_deposits.card_surcharge`. Webhook leg: `payment_intent.succeeded`
with `purpose === 'appointment_deposit'` runs the same completion tail as the page
POST (idempotent, claim-based), including the save→consent→enroll sequence via the
PI's attached payment method.

**Credit at completion.** The deposit applies as the standard negative
`deposit_credit` line on the visit's completion invoice (extend
`invoice.createFromService` / the dispatch completion path to look up
`appointment_deposits` by `scheduled_service_id`, exactly parallel to the
`source_estimate_id` roll-forward). Never mutate invoice totals directly. If the
inspection converts to a bigger job, the unconsumed remainder rolls forward using
the same FIFO/restore-on-void discipline.

**Confirmation gating.** Deposit-flagged visits: booking-confirmation SMS copy
switches to a "your slot is held — confirm with your $X deposit" variant (new
template rows, seeded inactive, same two-lever dark pattern); the appointment page's
free one-tap confirm defers to the `/secure` link while a deposit is owed; deposit
receipt flips `pending → confirmed` + `customer_confirmed` with a
`job_status_history` row (same guards as the public confirm: live status, slot
shown, dispatch-owned exclusion).

**Cancellation/no-show.** If we cancel or can't serve: refund face (+ surcharge
share per the estimate-deposit refund rules) — sweep pattern exists. Customer
no-show/late-cancel: owner decision §6; recommended default = deposit forfeited in
place of (not in addition to) the $49 fee, window mirroring the card-hold rules,
disclosed on the page and in the invite copy.

**Scope guards.** Keep the lane's existing owner rules unless Adam says otherwise:
first-time customers only, priced visits only, one-time (`is_recurring = false`)
only, payer-billed exempt. AI call flow: Phase 2 — start with office-set deposits
only; extend to AI-booked appointments once copy, refund flow, and forfeit handling
are proven (rule shape: one-time + inspection-ish `appointment_type` + new
customer ⇒ deposit at default amount).

**Copy.** New SMS/email template variants carrying `{deposit_amount}`; page
headline and consent framing reviewed (v10 consent text already authorizes charges
for "service visits and invoices as agreed" — verify with the consent copy owner
whether a deposit charge at setup needs a copy addendum/version bump); the
checkbox helper text "nothing charged today" becomes conditional.

**Not in scope.** Estimate-accept deposit (stays retired); recurring appointments;
any change to the card-hold or recurring card-on-file lanes; automated chasing
beyond the existing single-nudge abandonment pattern.

## 4. Rough build shape (Option B)

1. Migration: `appointment_deposits` + `appointment_card_requests.deposit_amount`
   + `pricing_config.appointment_deposit` seed + inactive template rows.
2. Server: deposit intent/quote/finalize on `secure-card-public.js`; webhook
   purpose routing; completion tail extension in `appointment-card-request.js`;
   invoice credit lookup; refund sweep; confirmation flip.
3. Client: amount field in `CreateAppointmentModal` + per-visit send modal;
   `/secure` page payment mode (Payment Element + Express Checkout, amount + fee
   display); admin visibility of deposit state on the appointment card.
4. Tests: mirror the estimate-deposit suites (intent gating, webhook race,
   surcharge quote/finalize, credit application, refund/void restore) +
   `ui-verify` on the page.

Order of magnitude: a multi-PR build comparable to the original estimate-deposit
work, substantially de-risked by pattern reuse. Phase A (flip existing lane) is an
env flip + runbook smoke test, no code.

## 5. Verification needed before any flip

- Confirm current Railway state of `APPOINTMENT_CARD_REQUEST`,
  `ONE_TIME_CARD_HOLD`, `RECURRING_CARD_ON_FILE`, `GATE_APPOINTMENT_PAGE`, and the
  `secure_appointment_card` template — repo docs (task graph 2026-07-16) record the
  flips as outstanding owner actions; this container cannot read prod env.

## 6. Owner decisions (nothing proceeds without these)

| # | Decision | Recommended default |
|---|---|---|
| 1 | Deposit for one-time appointments at all (revises card-on-file spec §5 D5 for this slice) — or card-hold-only (Option A alone)? | Hybrid: A now, B for office-flagged speculative one-offs |
| 2 | Default amount + who may override per appointment | $75 default in `pricing_config`, office-editable at send |
| 3 | Surcharge posture on the deposit | Same as estimate-deposit ruling 2026-07-13 (card surcharges, wallets face) |
| 4 | No-show/late-cancel: forfeit deposit vs $49 fee vs both | Forfeit replaces the fee; card-hold window rules |
| 5 | Confirmation gating: visit stays `pending` + SMS copy variant until deposit paid? | Yes, as designed in §3 |
| 6 | AI call flow auto-deposit rule (Phase 2) vs office-manual only | Office-manual first |
| 7 | Keep first-time-customer-only + priced-visit-only guards for deposit asks? | Keep both |
