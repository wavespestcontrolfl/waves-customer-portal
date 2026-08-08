# Overdue balance consolidation — "Pay my balance"

Design doc (2026-08-08). **Design only — no code yet.**

Owner question that started this: *"If Daniel Donovan has an overdue rodent
trapping bill and then gets his quarterly pest control service, could the
quarterly invoice pull in the overdue balance, and we void the old invoice?"*

Owner's stated goal, verbatim: **"the easiest pathway for the client to pay his
overdue bill plus the current bill that he owes."**

## Summary

The goal is right. The proposed mechanism — fold the old balance into the new
invoice, then void the old invoice — should **not** be built. It breaks the
books, resets collections, and has a double-bill failure window.

Instead: leave both invoices alone and add **one payment that settles both**.
The customer sees one number and one button; the ledger keeps two honest
invoices underneath.

This is not a new idea in this repo — it is exactly what payer statements
already do for builder/property-manager accounts
(`server/services/payer-statement-settle.js`: *"one statement → one `payments`
row → many invoices marked paid … not N card charges"*). We reuse that pattern
for homeowners.

---

## Part 1 — Why not fold-and-void

Recorded so this doesn't get re-proposed.

### 1. The void frequently cannot happen, and that's a double-bill window

`InvoiceService.voidInvoice` (`server/services/invoice.js:3518`) refuses when:

- status is `paid` or `processing` (`assertInvoiceVoidable`,
  `server/services/invoice-helpers.js:73`)
- any `payments` row for the invoice is `paid`/`processing` — checked twice,
  once pre-lock and again under the row lock
- a live PaymentIntent exists — it is cancelled first, and the void throws if
  cancellation fails or the PI is money-in-flight
- the invoice sits on a finalized payer statement

Fold-and-void is **two writes**: add the amount to invoice B, void invoice A.
Any time the second write loses — partial payment, ACH in flight, customer
sitting on `/pay` with a live intent — the customer owes the same money twice,
on two live pay links. There is no transaction that can span them safely,
because the void's own guards are the thing that fails.

**Partial payment is the common case that kills it outright**: $50 paid against
a $200 rodent invoice means the invoice can never be voided at all (refund
path only), so the amount that must roll forward is the *amount due*, not the
total, and invoice A must stay open regardless.

### 2. Void means "this was never owed"

`void` is terminal and pulls the row out of revenue and AR. Folding moves
rodent-trapping revenue onto a pest-control invoice dated a quarter later,
carrying a pest-control service type. `getStats`,
`server/services/banking-export.js`, and every revenue-by-service-type report
read invoice rows and would all be wrong.

### 3. It resets the collections clock every quarter

Both dunning rails age off the invoice:

- `server/services/invoice-followups.js` — per-invoice ladder (d3 / d7 / d14 / d30)
- `server/services/late-payment-checker.js` — tiers at 7 / 14 / 30 / 60 / 90 days

A 70-day-old debt folded into a fresh invoice becomes 0 days old with a new due
date. The worst payer gets his clock reset four times a year and never reaches
final notice. Backwards from the intent.

### 4. The new invoice's math would chew on the carried balance

`InvoiceService.create` (`server/services/invoice.js:808`) computes
discount → tax → credit against the whole subtotal:

- **Discount**: WaveGuard tier discounts scale across line items — a Platinum
  member would get 20% off his own collections balance.
- **Tax**: computed on the after-discount subtotal
  (`server/services/invoice.js:1273`). Residential is forced to 0% so Daniel is
  unaffected, but a commercial customer's carried balance already includes tax
  and would be taxed a second time. There is no per-line "exclude from tax"
  flag today.
- **Credit / deposits**: `depositCredit` and account credit apply against the
  invoice total, so a deposit taken for the *new* job would silently pay the
  *old* debt.

### 5. It fights the audit trail the repo deliberately keeps

Every money mutation here is designed to stay reconstructable — settlement
markers, `superseded_by_payment_id`, restore-on-void for credits and deposits.
Rewriting a debt onto a different document with a different date and service
type is the one thing none of that machinery can express.

---

## Part 2 — What already exists

The delta is smaller than it looks.

| Piece | Where | State |
|---|---|---|
| Consolidated balance across open invoices | `GET /api/billing/balance`, `server/routes/billing-v2.js:705` | Built. Returns `currentBalance` + `openInvoices[]` with pay links |
| Portal "Pay now" CTA | same, behind `portalPayNow` | Built, **dark in prod** (`server/config/feature-gates.js:446`) |
| One payment settling many invoices | `settleStatementPaid`, `server/services/payer-statement-settle.js:74` | Built for payers |
| Consolidated pay page | `client/src/pages/StatementPayPage.jsx`, `server/routes/pay-statement.js` | Built for payers |
| Rollup of N invoices into one total | `rollupStatement`, `server/services/payer-statements.js:107` | Built for payers |
| Per-invoice pay page + PI mint | `client/src/pages/PayPageV2.jsx`, `server/routes/pay-v2.js`, `StripeService.createInvoicePaymentIntent` (`server/services/stripe.js:3424`) | Built |
| Single surcharge authority | `computeChargeAmount`, `server/services/stripe-pricing.js` | Built — reuse, never re-derive |
| Failed-autopay retry + card-update SMS | `server/services/billing-cron.js` (`processPaymentRetries`, 3 attempts) | Built |

The genuinely new piece is **allocating one customer payment across several
invoices**. Today a `payments` row carries a single `metadata.invoice_id`. The
statement cascade proves the pattern; it just has never been pointed at a
homeowner.

---

## Part 3 — The design

### 3.1 Account balance (derived, not stored)

No new balance column. "Balance" stays a derived sum over the customer's own
open invoices — the same filter `GET /api/billing/balance` already applies:

```
status IN ('sent','viewed','overdue')
AND payer_id IS NULL
AND payer_statement_id IS NULL
AND GREATEST(total - COALESCE(credit_applied,0), 0) > 0
```

Storing a balance would create a second source of truth that drifts. Extract
this filter into one shared helper (proposed
`server/services/customer-balance.js`) so the pay page, the invoice email, the
dunning rail, and the portal all read the same definition. Divergent copies of
this predicate are exactly how the payer work generated bugs.

### 3.2 "Pay my balance" on the pay page

`GET /api/pay/:token` (`server/routes/pay-v2.js:264`) gains an optional block
when the customer has more than one open invoice:

```jsonc
"accountBalance": {
  "amountDue": 600.00,        // this invoice + everything else open
  "thisInvoice": 150.00,
  "otherInvoices": [
    { "invoiceNumber": "1187", "serviceDate": "2026-06-12",
      "description": "Rodent trapping", "amountDue": 450.00, "daysOverdue": 57 }
  ]
}
```

`PayPageV2.jsx` renders a two-option choice, defaulting to **pay the full
balance**:

> ● Pay my balance — **$600.00**
>   Includes $450.00 past due from June 12
> ○ Pay just this invoice — $150.00

`POST /:token/setup` accepts `scope: 'invoice' | 'balance'`. Under
`scope: 'balance'` the PI mints for the summed amount, with surcharge computed
once by `computeChargeAmount` on the combined base (invariant 1 — no local
math), and metadata carrying the full allocation:

```jsonc
"metadata": { "invoice_ids": ["<B>","<A>"], "primary_invoice_id": "<B>", "scope": "balance" }
```

**Locking.** The mint must lock every invoice in the allocation `FOR UPDATE` in
a **deterministic order** (by `created_at`, then `id`) and re-assert
collectibility on each under the lock, matching what
`createInvoicePaymentIntent` already does for the single-invoice case. Fixed
ordering is what prevents deadlock against a concurrent single-invoice mint on
one of the same rows.

**Refuse rather than guess.** If any invoice in the set has its own live PI, is
`processing`, or fails the stale-render version fence, the balance option is
withheld and the page falls back to single-invoice pay. Never mint a balance PI
that overlaps money already in flight.

### 3.3 Settlement allocation

On `payment_intent.succeeded` (and the ACH `processing` → settle path), the
webhook allocates **oldest invoice first**:

- one `payments` row for the customer, carrying the full amount and the
  allocation map in metadata — mirroring the single payer row the statement
  cascade writes
- each covered invoice → `paid`, with `paid_at` set to **one shared settlement
  timestamp**, as `settleStatementPaid` does deliberately so a child's `paid_at`
  is a settlement marker rather than a per-row clock
- partial coverage (shouldn't occur, but must be defined): fill oldest-first;
  a partially covered invoice stays open with its remainder

Each invoice keeps its own service date, service type, and revenue attribution.
Reports stay correct with no changes.

**Idempotency** rides the existing `stripe_webhook_events` contract. A replayed
event must not double-settle — the per-invoice status guard (`whereNotIn
['void','paid']`) makes the cascade naturally idempotent, same as the statement
path.

**Refunds and disputes** need the allocation map to reverse correctly: a refund
against a balance payment must unwind the invoices it covered, newest-first.
This is the sharpest edge in the whole design and needs its own test coverage.

### 3.4 "Previous balance" on the new invoice

Informational only — **no new line item**, so discount, tax, and credit math are
untouched (this is what sidesteps every problem in Part 1 §4).

The invoice email (`server/services/invoice-email.js`), the completion SMS, and
the invoice PDF (`server/services/pdf/invoice-pdf.js`) gain a block below the
total:

```
This invoice:        $150.00
Past due:            $450.00   (Invoice #1187, June 12)
─────────────────────────────
Account balance:     $600.00   → [Pay my balance]
```

The stored invoice row is byte-identical to today. Only presentation changes.

### 3.5 One dunning ladder per customer

Today `invoice_followup_sequences` is `unique('invoice_id')`
(`server/models/migrations/20260414000032_invoice_followup_sequences.js`) — one
ladder per invoice. Daniel with two overdue invoices is on **two ladders at
once**: two schedules, two links, doubled-up texts.

Change: dunning targets the **customer**, anchored to their **oldest** unpaid
invoice.

- `runPending` selects one row per customer (oldest open invoice as the anchor)
  instead of one per invoice
- escalation tier is computed from the oldest invoice's age — so consolidation
  can never reset the clock
- copy references the account balance and the balance pay link, not a single
  invoice number
- the same anchoring applies to `late-payment-checker.js` tiers, and its
  dedupe key moves from invoice to customer

Existing controls survive unchanged: pause/stop/`autopay_hold`,
`stopOnPayment`, the microdeposit diversion, and the payment-plan pause
(`paymentPlanFollowupStopReason`).

**Migration note.** Rather than drop the unique constraint, keep per-invoice
rows and elect an anchor at query time. Cheaper, reversible, and it preserves
the audit history on rows that already dunned.

### 3.6 Feature gate

Ships dark: `GATE_BALANCE_PAY`, `=== 'true'` to enable, matching the
`payerStatements` / `portalPayNow` convention. Gate off → payload byte-identical
to today, `scope` ignored, dunning unchanged. `GATE_BALANCE_PAY=false` is the
revoke.

---

## Part 4 — Autopay: recommend NOT bundling (owner decision required)

The owner's instinct was *"if he's on autopay, just take all $600 at once."*
Two findings argue against it, and this is the one place the plan deviates from
what was asked.

### Finding 1 — an autopay customer goes overdue because a charge *failed*

They don't ignore bills; their card died or their ACH bounced.
`server/services/billing-cron.js` already retries 3 times and sends an "update
your card" SMS. Running $600 through the same dead card next quarter produces a
bigger decline, not a collection. **The fix for autopay-overdue is the card
update, which already exists.**

Bundling's real payoff is the **non-autopay** customer who gets a pay link and
sits on it. That is Daniel's situation and that is who §3.2 serves.

### Finding 2 — bundling collides with an existing hard cap

`server/routes/admin-dispatch.js:~9305` enforces an above-quote guardrail on
completion auto-charges, documented as **"card-on-file spec §3.6, owner default
= HARD CAP"**: *"an auto-charge may only collect what the customer accepted."*
The comparator is the accepted per-visit amount; anything over routes to office
review rather than charging off-session. The appointment-card lane caps strictly
at the `accepted_amount` frozen at consent.

A $600 off-session pull against a $150 accepted visit is precisely what that cap
exists to prevent. Overriding it needs, at minimum: an owner ruling, new consent
copy, and a `CONSENT_VERSION` bump — the same bar every other consent change in
this repo has cleared.

### Recommendation

**Leave the hard cap alone.** Collect the overdue portion through the
customer-initiated balance link (§3.2), where the customer sees $600 and
approves $600. That satisfies "easiest pathway for the client to pay" without
touching off-session consent at all.

If the owner still wants off-session bundling after reading this, it becomes its
own phase with its own consent work — not part of this build.

**Interim, no code required:** an autopay customer carrying a balance gets the
balance shown in the portal and a balance pay link in their completion receipt.
They can clear it in one tap, on purpose.

---

## Part 5 — Phasing

**Phase 1 — visibility (small, no money mechanics).**
Shared balance helper (§3.1); "previous balance" block on invoice email / SMS /
PDF (§3.4); evaluate flipping `GATE_PORTAL_PAY_NOW` in prod so the portal
Billing tab shows the consolidated balance it already computes. Ships value on
its own.

**Phase 2 — one payment, many invoices (the core).**
`scope: 'balance'` on setup/quote/finalize (§3.2); allocation + cascade
settlement (§3.3); refund/dispute unwind; `PayPageV2` choice UI.

**Phase 3 — one dunning ladder (§3.5).**
Independent of Phase 2 and separately valuable — it stops the doubled-up texts
today.

**Phase 4 — off-session bundling.** Only if the owner rules on Part 4. Consent
copy + `CONSENT_VERSION` bump + cap revision.

**Not planned:** generalizing payer statements into homeowner statement
*documents*. If a single consolidated bill is wanted later, that machinery is
the base — but the link (Phase 2) gets the stated goal for a fraction of the
cost.

---

## Part 6 — Invariants this must respect

From the `waves-billing` skill; violating any is a P0:

1. **Surcharge** — combined amount priced by `computeChargeAmount` only. One
   call feeds the displayed amount, the PI amount, and `payments.card_surcharge`.
2. **Amount agreement to the cent** — PI amount ↔ sum of allocated invoice
   amounts due ↔ recorded `payments.amount`, exactly.
3. **Payer isolation** — payer-billed and statement-accrued invoices are
   excluded from the balance everywhere. A homeowner must never see or pay a
   payer's amount, and payer tokens/last4/balances stay invisible to them.
4. **Credit ordering** — account credit and deposit credit apply per invoice
   before the balance sums, never against the aggregate.
5. **No customer comms without owner action** (CLAUDE.md rule 12) — copy changes
   ship as template edits; nothing new sends on its own.
6. **Never void to solve this.** Recorded here as the standing conclusion.

## Part 7 — Open questions for the owner

1. **Default selection** on the pay page — pre-select "pay my balance" (assumed
   yes) or "pay this invoice"?
2. **Off-session bundling** — accept the Part 4 recommendation, or rule to
   revise the hard cap?
3. **Payment plans** — a customer on an active plan
   (`payment_plans`, one active per invoice) currently has dunning paused. Should
   plan invoices be excluded from the balance total, or shown separately?
4. **How far back** — include *every* open invoice in the balance, or cap the
   window (e.g. 12 months) so a very old written-off item doesn't resurface in a
   pay prompt?

## Verification plan

- Unit: allocation math (exact, over-, under-coverage), oldest-first ordering,
  refund unwind newest-first.
- Contract: PI amount ↔ allocation sum ↔ `payments.amount` to the cent, with
  surcharge split, per invariant 2.
- Idempotency: replayed `payment_intent.succeeded` settles once.
- Concurrency: balance mint racing a single-invoice mint on a shared invoice —
  one wins, no double collection.
- Payer isolation: a homeowner with both self-pay and payer-billed invoices sees
  only their own in the balance.
- End-to-end trace of one realistic amount (display → PI → webhook →
  `payments` row → both invoices `paid`) before any prod verification claim.
