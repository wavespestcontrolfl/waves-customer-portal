---
name: waves-billing
description: Use when touching anything that moves or records money — Stripe flows, invoices, payments, surcharges, deposits, prepay/annual plans, autopay, refunds, WavesPay/Terminal — or when verifying a billing outcome in prod. For changing pricing VALUES (brackets, fees, discounts) use the pricing-config skill instead.
---

# Waves Billing — money-movement invariants

## Purpose
Money code in this repo has a small set of load-bearing invariants that
reviewers keep re-flagging and that have caused real reconciliation breaks
when violated. This skill is the map; the enforcement detail lives in
`AGENTS.md` (read its Stripe/webhook/surcharge P0 block before editing any
payment path).

## When to Use
- Editing anything under `server/services/stripe*.js`, `server/routes/pay-*`,
  `stripe-webhook.js`, `stripe-terminal.js`, invoice/deposit/prepay services,
  autopay or billing crons, or iOS WavesPay payment code.
- Writing queries or reports over `payments`, `invoices`, `estimate_deposits`.
- Verifying "did the customer get charged/refunded correctly?" in prod.

## Invariants (violating any of these is a P0)

1. **One surcharge authority.** All card-surcharge math derives from
   `computeChargeAmount` / `isCardMethodType` / `CARD_SURCHARGE_RATE` in
   `server/services/stripe-pricing.js` (pure, unit-tested, imported by
   `stripe.js`). Never introduce local `* 1.0xx` math, never hardcode the
   rate (it's configured via basis points and has changed before). Displayed
   amount, PaymentIntent amount, and the recorded `payments.card_surcharge`
   must all come from the same call.
2. **Deposit surcharge follows the 2026-07-13 owner ruling** (which REVERSED
   the 2026-06-12 blanket exemption — do not cite the old "permanently
   exempt" rule; it's dead). Manual card entry on an estimate deposit DOES
   surcharge — credit funding only, priced via `computeChargeAmount` through
   the `/deposit-quote` → `/deposit-finalize` pair (see the AGENTS.md route
   entry). Wallets pay FACE value through Express Checkout. The PI mints at
   face value and the ledger credits FACE (`metadata.base_amount`); the fee
   rides `estimate_deposits.card_surcharge`, never the deposit credit.
   Commercial prepay keeps its separate exemption (owner ruling 2026-07-05,
   expressly not reversed). Do not restore the retired
   `estimate-deposit-intent-surcharge-exempt` test. Standing gate ruling
   (owner 2026-07-23): `ESTIMATE_DEPOSIT_REQUIRED` stays OFF — Auto Pay
   opt-in replaced required deposits; never re-propose flipping it.
3. **Deposit ledger mechanics.** A paid deposit lands in `estimate_deposits`
   and is applied as a NEGATIVE `deposit_credit` line on the FIRST invoice;
   any remainder rolls to subsequent invoices; voiding an invoice restores
   the credit. Never apply a deposit by mutating invoice totals directly.
4. **Webhook discipline.** Single Stripe webhook mount, raw-body before
   `express.json()`, idempotency via `stripe_webhook_events` — the full
   contract is in AGENTS.md; read it before touching `stripe-webhook.js`.
5. **Amount agreement to the cent.** PaymentIntent amount ↔ invoice total ↔
   webhook-recorded `payments.amount` must agree exactly; per-visit billing
   bills exact cents (no penny drift — see the annual-total anchor work).
6. **Invoice-on-complete is intended.** Completing a service invoices
   non-autopay/non-prepaid customers by design. Rate precedence:
   `estimated_price` → `monthly_rate` → $0, and the server recomputes —
   never trust client-sent amounts. Per-application plans have their own
   precedence: row price → `per_application_fee` → $0 with a loud warn —
   NEVER the whole-plan `monthly_rate` (multi-service per-app rows carry
   NULL fee/prices by design). A $0/NULL-priced row is NOT inert — it falls
   through to monthly_rate/WaveGuard-tier billing.
7. **Pay-at-visit and estimate pricing** read the estimate-level net, never
   per-line fields.
8. **Unpriced = NULL, never $0.** A blank price means "manual quote
   pending"; $0 means "charge nothing." (Shared rule with pricing-config.)
9. **WaveGuard:** Bronze 0 / Silver 10 / Gold 15 / Platinum 20% discounts;
   "no tier" is NOT Bronze. The $99 membership/setup fee applies to SOLO
   recurring pest control or SOLO recurring mosquito only
   (`MEMBERSHIP_FEE_SOLO_KEYS` in `server/services/estimate-converter.js` —
   a pest+mosquito bundle carries NO fee; never on lawn/T&S/termite). The
   fee is code-authoritative: the admin pricing-panel
   `PEST_INITIAL_FEE`/`waveguard_membership` knobs are INERT (db-bridge
   never reads them).
10. **Terminal/Tap-to-Pay:** the 60s handoff JWT, atomic jti burn, and
    DB-enforced mint rate limit are P0 contracts (AGENTS.md). The iOS SDK
    pin lives in `ios/WavesPay/project.yml` (xcodegen is the source of
    truth — `.pbxproj` and `Package.resolved` are generated but git-tracked;
    bump via `project.yml` → `xcodegen generate` →
    `xcodebuild -resolvePackageDependencies`).
11. **Autopay enrollment is consent-row-gated.** Enrollment requires a
    `payment_method_consents` row with v8+ copy
    (`consentVersionQualifiesForEnrollment`); webhook metadata alone never
    enrolls. Legacy members without consent get a "set up Auto Pay" nudge,
    NEVER a silent flip. Every save surface enrolls via
    `enrollConsentedMethod` (which refuses unhealthy-ACH targets).
12. **Payer (Bill-To) invariants.** `invoice.create()` auto-resolves the
    default payer — every path that returns/sends a homeowner pay token or
    applies homeowner credit/deposit/autopay must re-check `payer_id`
    first. Never expose payer tokens, last4, or balances to the homeowner.
    Customer-keyed `payments` readers exclude payer rows
    (`whereNull('payments.payer_id')`). Never detach a payer statement with
    a `processing`/live PI — the statement webhook is not feature-gated and
    a late success orphans funds.
13. **Card-hold / completion billing.** Completion invoices are status
    `draft` — collectibility checks use `isInvoiceCollectibleStatus()`,
    never ad-hoc status lists. The no-show fee settles at FACE value
    (taxRate 0) and must NOT go through `chargeInvoiceWithSavedCard` (it
    surcharges). Receipts go through the canonical
    `InvoiceService.sendReceipt` — never hand-rolled sends. Don't pass an
    explicit `taxRate` to `InvoiceService.create` (it auto-computes; both
    `commercial` AND `business` property types are taxable, county-aware).
    Cancelling a card-hold visit AFTER its scheduled time via app routes
    auto-charges the $49 fee and fires the customer receipt chain — a
    silent no-fee close is a direct DB cancel + hold release, never an
    app-route cancel.
14. **Surcharge display mirrors.** The rate has ~10 server+client mirrors
    (client cardSurcharge lib, estimate-engine output fields, PayPageV2
    fallback + display percents, consent text ×2 — which needs a
    CONSENT_VERSION bump — ReceiptPage stored-bps label). On any rate
    change, grep them all and DERIVE displayed percents from the rate or
    stored bps, never hardcode the string. Historic receipts render their
    stored `surcharge_rate_bps`. Owner ruling 2026-06-19: missed surcharges
    are forward-only — no clawback.
15. **Quiet/backdated completions.** `POST /complete` carries independent
    side-effect rails (auto-charge, credit consumption, referral credits,
    digital-card email) — any backfill or quiet-completion path must
    deliberately suppress ALL of them, not just the invoice.

## Procedure
1. Read the relevant AGENTS.md P0 block for the files you're touching.
2. Make the change following the invariants above; if a change requires
   relaxing one, that's an owner decision — stop and ask Adam.
3. Money queries/backfills follow the waves-db skill (read-only prod
   verification, ET window discipline).
4. Never claim a charge, refund, or payment state without evidence (webhook
   row, `payments` row, or Stripe object read via an authorized session).

## Verification
- Server tests for the touched module; the pricing regression harness
  (`npm run seed:pricing`, then the LOCAL=1 suites) when engine outputs
  could shift.
- For flows: trace one realistic amount end-to-end (display → PI →
  webhook → `payments` row) and confirm all three match to the cent,
  including the surcharge split.
- For prod verification: read the actual rows/Stripe objects; "the code
  looks right" is not a billing verification.

## Failure Modes
- Ad-hoc surcharge math or a hardcoded rate (or a hardcoded display percent).
- Deposit surcharge drift: surcharging wallet deposits, crediting the ledger
  with anything but face value, or re-asserting the dead pre-07-13 blanket
  exemption.
- Claiming payment outcomes from code inspection alone.
- Trusting client-submitted amounts.
- Editing webhook ordering/idempotency without reading AGENTS.md first.

## Escalation
Ask Adam before: changing any customer-visible amount, fee, or exemption;
issuing refunds; retrying/regenerating live invoices; anything that would
email/SMS a customer about billing (owner sends all customer comms).
