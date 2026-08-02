# One-Time Appointment Deposits — Scoping Doc

> **Status 2026-08-01:** Owner approved the A + C route (§2). The Option C
> enforcement rails are BUILT (dark behind `GATE_APPT_CARD_NO_SHOW_FEE` and
> `GATE_APPT_CARD_COMPLETION_CHARGE`) — see the appointment-card enforcement
> rails entry in AGENTS.md. The deposit build (Option B) is shelved.
>
> **Owner ruling (Adam, 2026-08-01, this session):** fee = **$75 flat, one
> amount for BOTH no-show and late-cancel** (no 50%/100% split — single
> number, simple promise, rescheduling stays free). Deposit confirmed
> dead for one-time appointments — the $75 auto-charged fee replaces its
> economics without the prepay friction; revisit only on post-launch
> ghosting data or for the WDO/real-estate pay-at-scheduling lane.
> Implementation: retune `pricing_config.estimate_card_hold` from $49 →
> $75 in the admin pricing panel (DB-authoritative, shared with the
> estimate card-hold lane; frozen terms protect already-agreed $49 fees).

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
"add a card to finish booking"; card saved + Auto Pay enrolled.

- Pros: zero build; lowest customer friction; consistent with the 2026-07-12
  "charge at services rendered" philosophy; go-live runbook already written; this
  is verbatim the Orkin/Terminix online-booking model (§2b).
- Cons (verified 2026-08-01): for office/AI-booked one-time visits the lane is a
  commitment device **without an automatic enforcement rail** — the no-show/late-
  cancel fee auto-charge exists only for estimate-accept card-hold bookings
  (`chargeNoShowFee` requires an `estimate_card_holds` row), and the completion
  auto-charge fires only for `per_application` billing-mode customers
  (`admin-dispatch.js:7222`). A one-time customer's completion invoice goes out as
  a pay link; the disclosed $49 fee has no automated charge path on this lane.
  The saved card + v10 consent still permit a manual office charge per disclosed
  terms.

### Option B — deposit variant on the same lane (the build)
Appointments flagged "deposit required, $X" send the same `/secure` link, but the
page shows **"$X deposit due today to confirm your visit — applied to your bill"**
and runs a PaymentIntent (face value, `setup_future_usage:'off_session'`) instead of
a SetupIntent. One submit = deposit paid + card saved + consent + Auto Pay enrolled.
Visit stays `pending` until the deposit lands; payment flips it `confirmed`.
Self-enforcing (money in hand pre-trip), but the highest-friction option (§2b) and
a model no researched pest brand uses for residential one-time work.

### Option C — price the visit + close the enforcement gaps (small build)
Treat the speculative one-off as a **priced inspection/service-call fee** (e.g.
$75, credited toward treatment if the customer proceeds) rather than a deposit on
an otherwise-free visit, and make the existing card lane self-enforcing:

1. Book the fly-inspection-type visit with `estimated_price` = the inspection fee
   (the card-request funnel already requires a priced visit — no change).
2. Extend the no-show/late-cancel fee rail to visits secured via
   `appointment_card_requests` (sibling of `chargeNoShowFee`, charging the
   consented enrolled method; fee + window frozen at consent, same
   disclosure copy the lane already sends).
3. Extend the completion auto-charge to `one_time`/`per_visit` customers whose
   card came through this lane, hard-capped at the visit's stamped
   `estimated_price` (+ disclosed tax/surcharge) — same above-quote guardrail
   posture as the per-application rail.
4. "Credited toward treatment" runs as business process initially (discount the
   treatment estimate by the inspection fee); no new machinery.

### Recommendation (revised 2026-08-01 after industry analysis — §2b)
**Option A + Option C. Skip the deposit build** unless a specific lane proves it
out later (the FL WDO/real-estate report is the one documented pay-at-booking
precedent and would be its own narrow decision). Price the speculative one-off,
require the card to book, auto-charge fee/completion against the consented card.
This matches the national-brand playbook exactly, carries near-zero booking
friction, and per ServiceTitan's 1M-job dataset a priced fee up to ~$89 does not
hurt booking rates (a $0 visit actually books worse). Option B stays on the shelf
as the escalation if no-show data after launch says the card isn't commitment
enough.

## 2b. Industry analysis (researched 2026-08-01; citations in session log)

**What the big pest brands do.** Orkin's online checkout: *"Add payment to secure
your time slot. You will not be charged until after your first appointment."*
Terminix buy-online: card captured at booking, *"charged at the time of service."*
That is precisely the built `/secure` lane. **No researched national/regional pest
brand takes a booking deposit for residential one-time work or inspections**
(Massey and Truly Nolen — the direct FL competitors — book free inspections by
phone with no card at all). The industry exception pattern is the point: for
speculative, high-cost diagnostics (bed bugs), Orkin charges a ~$95–$150
**inspection fee credited toward treatment**, and Hawx ~$100 same-shape — i.e. the
majors solve "tire-kicker inspections" by pricing the inspection, not by taking
deposits. FL WDO/real-estate reports are paid inspections ($75–$300; some
operators collect at scheduling). Appointment-level no-show fees are absent from
the majors' public terms; smaller operators use $25–$50 with a 24–48h window.

**What the wider service trades do.** HVAC/plumbing/electrical run the
diagnostic/service-call fee model ($75–$150 typical, disclosed at booking,
collected on site, credited toward the repair). ServiceTitan's analysis of 1M+
residential jobs: booking rates with a fee of $0.01–$49.99 are **3–10 points
higher than at $0**, and hold steady up to ~$89.99. Deposits belong to
project/contract work (10–25% of large jobs), not small visits.

**Friction and effectiveness evidence.** Card-on-file and deposits land in the
same no-show-reduction band in the only comparable datasets (both ~65% in platform
cohort data; all vendor-reported). The behavioral literature says most of the
effect comes from *any* credible financial commitment; deposits are the stronger
loss-frame but carry real prepayment friction — hotels must discount 5–15% to get
prepay accepted, while card-guarantee is treated as near-zero friction and is the
default across hotels/restaurants/salons. Two cautions that shaped Option C:
small fees can backfire ("A Fine Is a Price" — a cheap fee becomes a purchasable
permission to flake), so the committed amount must feel substantial and be
reliably collected; and non-refundable prepay framing measurably hurts first-time
conversion. Reminder copy that states the concrete cost of a miss adds a further
~25% relative reduction (Hallsworth RCT) — the card-lane reminder policy line
already does this.

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

| # | Decision | Recommended default (revised 2026-08-01) |
|---|---|---|
| 1 | Route: deposit build (B) vs priced-visit + card-on-file with enforcement (A + C)? | **A + C**; B shelved pending post-launch no-show data |
| 2 | Inspection/service-call fee amount for speculative one-offs (pricing value — owner's call, pricing-config skill applies) | ~$75 (ServiceTitan safe band tops at ~$89); credited toward treatment if customer proceeds |
| 3 | No-show/late-cancel fee amount + window for card-lane visits (Option C rail) | Match card-hold config ($49 / 24h) — but consider whether $49 is "substantial" enough per the fine-is-a-price caution, vs full visit price on no-show (smaller-operator precedent exists for both) |
| 4 | Completion auto-charge for one-time visits with a lane-consented card, capped at stamped price? | Yes (Option C.3) |
| 5 | Confirmation gating: keep free confirm, or treat card-on-file completion as the confirm for these visits? | Card completion counts as confirmed; no money gate |
| 6 | AI call flow: auto-send card link for one-time bookings (already wired) — also auto-price inspections per service catalog? | Yes, catalog-priced |
| 7 | Keep first-time-customer-only + priced-visit-only guards? | Keep both |
| 8 | WDO/real-estate reports: adopt pay-at-scheduling (the one documented deposit-like precedent)? | Defer — separate narrow decision |

If Adam chooses the deposit anyway, the §3 design and the original decision set
(default amount, surcharge posture per the 2026-07-13 ruling, forfeit-replaces-fee,
pending-until-paid gating) stand as scoped.
