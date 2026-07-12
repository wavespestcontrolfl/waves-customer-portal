# Card-on-File Booking — Build Spec

**Owner decision (Adam, 2026-07-12, working session):** completing a booking in the
estimate flow requires a **card on file** — for both one-time and recurring services.
**No deposit.** Nothing is charged at booking; the saved card is charged **when
services are rendered** (final total on completion for one-time; each visit's invoice
on completion for recurring). No separate autopay-authorization form — the versioned
consent checkbox at card entry is the authorization artifact.

> **Supersedes:** the earlier 2026-07-12 owner call recorded in PR #2671 ("the
> recurring downside-protection ask was about restructuring the deposit amount, not
> Auto Pay at accept; the card-on-file build is not wanted"). The owner has reversed
> that direction in this session: card-on-file **is** wanted, the deposit is **not**.
> The `estimate_deposit` pricing_config re-tune queued as #2671's follow-up is moot.
> This spec authorizes restoring #2668.

---

## 1. Current-state inventory (verified 2026-07-12)

| Piece | State | Where |
|---|---|---|
| Required acceptance deposit ($49 recurring / $99 one-time) | Built, **dark** (`ESTIMATE_DEPOSIT_REQUIRED`, never flipped per repo/docs) | `server/services/estimate-deposits.js`, accept gate in `server/routes/estimate-public.js` |
| One-time card hold (card to book, $0 today, charge on completion, $49 no-show/late-cancel fee, 24h window) | Built, **dark** (`ONE_TIME_CARD_HOLD`), full go-live runbook | `server/services/estimate-card-holds.js`, `docs/one-time-card-hold-go-live-runbook.md`, PRs #2058/#2070/#2071 |
| Card hold supersedes one-time deposit when both flags on | Built | `estimate-public.js` accept gate (`card_hold_supersedes`) |
| Recurring required-save at first-invoice payment + `billing_mode` stamping (`per_application` / `annual_prepay`) | **Live** (owner ruling 2026-07-09, no flag; column-guarded) | `server/routes/pay-v2.js` (`invoiceRequiresSavedMethod`), `server/services/estimate-converter.js` |
| Consent ledger (verbatim snapshot, version, IP/UA; v8+ authorizes future charges; ACH variant carries NACHA/Reg E language) | Live | `server/services/payment-method-consents.js`, `payment-method-consent-text.js` (`v8_2026-06-17`) |
| Autopay enrollment on consent (idempotent, ACH-health guarded, deferred while ACH processing) | Live | `server/services/autopay-enrollment.js`, pay-v2 `/consent` + `/setup-complete`, stripe-webhook mirror |
| Per-application completion auto-charge (invoice minted at completion → saved method charged inline; decline falls back to pay-link SMS, non-blocking; STRIPE_CHARGED_DB_FAILED parks `processing`) | Live | `server/routes/admin-dispatch.js` (~4911–5025) |
| Card-hold completion charge + no-show fee + recap path + fee settlement as paid refundable invoice | Built (behind `ONE_TIME_CARD_HOLD`) | `estimate-card-holds.js`, `admin-dispatch.js` (~5027–5049) |
| Recurring card-on-file at accept, Auto Pay by default (dark: `RECURRING_CARD_ON_FILE`) | **Built and reverted** — never lit, no prod artifacts; clean restore available | PR #2668 (squash `ae2f2c5127`), reverted by PR #2671 (`068f64e`) |
| Card-expiry warning cron (60-day lookahead) + pre-charge reminders (monthly mode only) | Live, SMS legs gated | `server/services/autopay-notifications.js`, `GATE_AUTOPAY_CUSTOMER_SMS` |
| Deposit-abandonment recovery SMS (2–72h window, fail-closed) | Built, dark (`GATE_ESTIMATE_DEPOSIT_ABANDONMENT_SMS`) — **pattern to copy**; no card-hold equivalent exists | `estimate-deposits.js` (`assessDepositFollowUpEligibility`), `estimate-follow-up.js` |
| AI call-pipeline booking dedup (Call SID marker, appointment idempotency key, advisory lock, confirmation-SMS content dedup, known-caller re-confirmation guard) | Live | `server/services/call-recording-processor.js` (`findExistingCallAppointment` ~1732, booking ~5883+) |
| Standalone Autopay Authorization contract doc (signing enables autopay + records consent) | Live — **exception tool, not a flow step** | `server/routes/contracts-public.js` |

## 2. Invariants (bind every phase)

1. **No card data ever touches Waves servers, recordings, or transcripts.** Cards are
   entered by the customer into Stripe-hosted fields (or, if ever built, Twilio `<Pay>`
   DTMF). Never accept a card read aloud on a recorded line; never extract card data
   from transcription. CVV may not be stored in any medium, including audio.
2. **All waves-billing skill invariants apply** (single surcharge authority; no-show
   fee charged face value, surcharge-exempt; amount agreement to the cent; webhook
   discipline; server recomputes amounts — never trust the client).
3. **Enrollment requires a v8+ consent row** (`payment_method_consents`) — the consent
   snapshot is the authorization of record. No separate form required; the contract
   doc remains available for commercial/edge cases.
4. **`ESTIMATE_DEPOSIT_REQUIRED` stays unset permanently.** Deposit machinery is
   retained dark as a fallback lever and for the historical ledger. Do not delete.
5. **Idempotency keyed on the durable entity** (appointment, hold, PaymentIntent) —
   never on the triggering path. Multiple triggers must collapse to one booking, one
   card-link SMS, one charge.
6. **Frozen terms:** fee amounts / windows shown at consent are frozen onto the hold
   row (existing behavior) — config changes never move an already-consented fee.

## 3. Phases

### Phase 0 — PAN redaction guard (ship first, independent)

Transcript ingestion currently has **no card-number scrubbing** (verified:
`call-recording-processor.js`). Add a Luhn-validated 13–19-digit-run scrub applied
**before** transcript persistence (`call_log`) and before any transcript text reaches
an LLM prompt (extraction, corpus miner, KB). Mask to last4. A blurted card number
must become a non-event.

*Acceptance:* seeded transcript fixtures containing spaced/dashed/spoken-digit PANs
persist masked; extraction output contains no PAN; existing call tests green.

### Phase 1 — Flip `ONE_TIME_CARD_HOLD` (env flip + two small pre-flip changes)

Runbook: `docs/one-time-card-hold-go-live-runbook.md` (pre-flight checklist, smoke
test, week-one monitoring queries, rollback).

Pre-flip code changes:
1. **Inside-window booking grace.** As built, a booking made <24h before the slot is
   instantly inside the late-cancel window. Change `isWithinCancelWindow` so the fee
   window is `min(cancel_window_hours before start, time since booking)` — or an
   explicit free-cancel grace (~1h) after booking. Exact rule: owner decision (§5).
2. **Reminder copy states the policy.** Appointment reminders for card-hold bookings
   append one line — free-reschedule cutoff + fee amount + reschedule link (link
   machinery exists in `appointment-reminders.js` / `reschedule-link.js`). This is
   dispute evidence as much as UX.

At flip: confirm `GATE_AUTOPAY_CUSTOMER_SMS` posture (decline/expiry texts), office
heads-up per runbook §3.

*Acceptance:* runbook §4 smoke test (all six steps) on owner-controlled estimates.

### Phase 2 — Restore #2668: recurring card-on-file at accept

`git revert 4e92ea07d` (the #2671 revert commit) on a feature branch, then apply
spec deltas before lighting `RECURRING_CARD_ON_FILE`:

1. **Nothing charged at accept — first money moves at first completion.** Decide the
   mechanism during restore: keep minting the setup + first-application invoice at
   accept but suppress in-flow payment and auto-charge the saved card at first visit
   completion (preferred — consistent "$0 today" story), or defer minting to
   completion. The pay-page required-save (`invoiceRequiresSavedMethod`) becomes the
   **backstop** for customers who somehow reach an invoice without a saved method —
   it must not double-demand a card already captured at accept.
2. **Auto-satisfy with an existing saved card.** A customer with a chargeable saved
   method skips capture — one-tap "we'll use your Visa ••4242" confirm. Apply the same
   to the one-time hold (runbook §7 notes members are currently re-asked).
3. **Exemptions preserved:** payer-billed, invoice-mode, commercial
   site-confirmation-hold, prepay-annual choice (prepay still pays its 12-month
   invoice; renewals already auto-charge).
4. **Card-only at booking.** Bank/ACH switch remains a portal action afterward.
5. **Wallets:** verify Apple Pay / Google Pay are enabled on every capture surface
   (hold modal + restored recurring capture) — most estimate opens are mobile.
6. **Above-quote charge guardrail.** Auto-charge fires only up to the accepted
   estimate amount (plus disclosed tax/surcharge); a completion invoice exceeding the
   accepted amount by more than the variance threshold (§5) routes to office review
   instead of auto-charging.
7. **Per-visit price completeness.** Every recurring accept stamps a per-visit amount
   for each service line (the completion path already warns
   `no billable amount on file — invoice manually` for multi-service plans); add an
   accept-time check so auto-charge never silently degrades to manual invoicing.

*Acceptance:* restored test suite green (#2668 shipped 329 test lines); end-to-end on
a real recurring estimate: accept captures card + consent + enrollment, $0 charged at
accept, first completion auto-charges, receipt lands; exemption matrix covered by
tests; wallet capture verified on a phone.

### Phase 3 — Decline handling hardening

1. **Auto-retry ladder for per-visit declines** (card-hold completion + per-application
   completion): e.g. retry next morning, then +3 days, then stop and surface on the
   billing-recovery workbench. Claim-based transitions (reuse the hold state machine /
   invoice status guards) so a retry can never double-charge; honor Stripe idempotency
   caveats already documented in `estimate-card-holds.js`.
2. **Decline SMS with card-update link** for per-visit charges (the monthly autopay
   lane already has one — extend the pattern; respects `GATE_AUTOPAY_CUSTOMER_SMS` +
   consent policy).
3. Timing/cadence: owner decision (§5).

### Phase 4 — Card-step abandonment recovery

Mirror the deposit-abandonment stage for card capture: pending SetupIntent
(`estimate_card_holds` status `pending`, and the restored recurring equivalent)
last touched 2–72h ago, estimate still acceptable, policy still requires a card, no
capture completed → **one** SMS ("your appointment isn't held yet"). Fail-closed
eligibility (copy `assessDepositFollowUpEligibility`'s inversion discipline), its own
feature gate, one nudge per booking ever — then an office follow-up list, not more
texts.

### Phase 5 — Channel uniformity (/book + phone) & duplicate blockers

1. **Single idempotent "request card for appointment" service.** Every trigger
   (estimate flow, /book, AI call pipeline, admin button) funnels through one service
   that checks, in order: policy exemption → chargeable saved method on file (skip +
   auto-secure) → existing pending/complete capture for this appointment (skip) →
   `card_link_sent_at` stamp on the visit (skip). Unique per appointment; one text,
   ever, from this path. Follow-up is Phase 4's nudge only.
2. **"Secure your appointment" tokenized card page** for bookings that don't ride the
   estimate accept (office-created, AI-booked, /book): SetupIntent capture keyed to
   the `scheduled_service`, same consent + enrollment + auto-satisfy rules. Sibling of
   the existing decline card-update link.
3. **Phone bookings: text the link, stay on the line.** Office script: never accept a
   card read aloud (recorded line) — send the link mid-call, watch it land. AI-booked
   calls auto-send the same link post-booking through the idempotent service (1).
   Optional later, only if link-resistance shows in the data: Twilio `<Pay>` DTMF
   capture (Twilio PCI mode; masked tones; recording auto-paused; tokenizes straight
   to Stripe).
4. **/book wizard card step:** reuse the capture machinery; `booking_intents`
   abandonment recovery already exists for this funnel.
5. **Widen the AI pre-book duplicate guard.** `findExistingCallAppointment` currently
   matches only the call's own bookings (Call SID marker) or `booking_source:
   'phone_call'` rows — a manual portal booking made during the call is invisible to
   it. Add: any live (pending/confirmed, future) appointment for the customer that
   plausibly matches (same service line within a date window) → **attach** (stamp
   `source_call_log_id` on the existing row) instead of insert; ambiguous → review
   card. The AI never books over a human.

## 4. Launch metrics (define before Phase 1 flip)

- Booking funnel: estimate viewed → slot picked → card step started → booked
  (card-step abandonment rate is the number the whole bet rides on).
- Completion-charge decline rate + recovery rate (retry ladder vs manual).
- AR aging for estimate-flow cohort vs pre-launch baseline.
- No-show / late-cancel rate; fee volume, waives, refunds (runbook §5 query).
- Accepted-but-uncaptured bookings (Phase 4 queue depth).

## 5. Open decisions (owner)

| # | Decision | Default if unstated |
|---|---|---|
| 1 | Inside-window booking grace rule (Phase 1): free-cancel window after booking (~1h) vs `min(24h, time-since-booking)` | `min(24h, time-since-booking)` |
| 2 | Above-quote variance threshold before office review (Phase 2): hard cap at accepted amount vs small % allowance | Hard cap at accepted amount + disclosed tax/surcharge |
| 3 | Retry-ladder cadence (Phase 3) | Next morning, +3 days, then office list |
| 4 | No-show fee → account credit when rebooked within 14 days (goodwill) | Not automated; office discretion via existing account-credit tools |
| 5 | Deposit exception for big-ticket one-time jobs (termite/WDO/exclusion) | No deposit anywhere (card hold only) |
| 6 | Phase order 4 vs 5 | 4 before 5 (protect the funnel being bought first) |

## 6. Decisions already made (this session — do not re-litigate)

- Card on file required to complete booking, one-time **and** recurring; deposit dead
  (flag never flips); prepay-annual stays an optional upsell, never the gate.
- Charge event = **services rendered** (completion), both classes. Never a charge at
  booking.
- No standalone authorization form in the flow — inline v8 consent is the artifact;
  contract doc stays for commercial/edge cases.
- Card-only at booking; ACH later via portal.
- Existing customers with a saved card are never re-asked.
- Phone capture = text-the-link (never transcription; `<Pay>` only as a data-driven
  later option).
- One booking per agreed visit and one card-link per appointment, enforced by
  entity-keyed idempotency (Phase 5.1/5.5).

## 7. References

- Runbook: `docs/one-time-card-hold-go-live-runbook.md`
- PRs: #2058 (card hold), #2070 (fee settlement), #2071 (revert), #2668 (recurring
  card-on-file, squash `ae2f2c5127`), revert commit `068f64e` (head `4e92ea07d`)
- Owner rulings referenced: 2026-06-12 / 2026-06-24 / 2026-07-05 (deposit + hold
  history), 2026-07-09 (required-save + per_application), 2026-07-12 (this spec)
- Key modules: `estimate-card-holds.js`, `estimate-deposits.js`, `estimate-public.js`,
  `pay-v2.js`, `autopay-enrollment.js`, `payment-method-consents.js`,
  `admin-dispatch.js` (completion charges), `autopay-notifications.js`,
  `call-recording-processor.js`, `contracts-public.js`
