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
2. **Deposits are surcharge-exempt. Permanently.** Estimate deposit
   PaymentIntents ($49/$99) must NOT route through `computeChargeAmount` —
   this is an owner product decision, not an oversight. Reviewers re-flag it;
   the rebuttal is this rule. Commercial prepay is also deposit-exempt
   (owner ruling 2026-07-05).
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
   never trust client-sent amounts.
7. **Pay-at-visit and estimate pricing** read the estimate-level net, never
   per-line fields.
8. **Unpriced = NULL, never $0.** A blank price means "manual quote
   pending"; $0 means "charge nothing." (Shared rule with pricing-config.)
9. **WaveGuard:** Bronze 0 / Silver 10 / Gold 15 / Platinum 20% discounts;
   "no tier" is NOT Bronze. The $99 setup fee applies to recurring pest
   control only.
10. **Terminal/Tap-to-Pay:** the 60s handoff JWT, atomic jti burn, and
    DB-enforced mint rate limit are P0 contracts (AGENTS.md). The iOS SDK
    pin lives in `ios/WavesPay/project.yml` (xcodegen is the source of
    truth).

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
- Ad-hoc surcharge math or a hardcoded rate.
- Routing a deposit through the surcharge path (or "fixing" the exemption).
- Claiming payment outcomes from code inspection alone.
- Trusting client-submitted amounts.
- Editing webhook ordering/idempotency without reading AGENTS.md first.

## Escalation
Ask Adam before: changing any customer-visible amount, fee, or exemption;
issuing refunds; retrying/regenerating live invoices; anything that would
email/SMS a customer about billing (owner sends all customer comms).
