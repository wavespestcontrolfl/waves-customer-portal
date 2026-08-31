# Annual-prepay term states

`annual_prepay_terms.status` is a small state machine. The stage names are
enforced in the database (`annual_prepay_terms_status_check`, migration
`20260614000001_annual_prepay_terms_checks.js`); the **moves** were never
written down — they lived as scattered `.update({ status })` calls with
`WHERE` guards. This page is that list. It documents what the code does today
on `origin/main`; it is not a redesign.

The guard test `server/tests/annual-prepay-term-states.test.js` pins the
stage list to the migration, scans every non-test file under `server/` and
`ops/` for status writes to this table and resolves each one to a documented
stage, and pins the transition functions' guards. Change any side → update
this page in the same PR.

## Stages

| Status | Meaning | Written by code? |
|---|---|---|
| `payment_pending` | Term exists, prepay invoice not paid (default at birth; also the *dispute-suspended* stage — see `dispute_suspended_at`). Coverage is not applied. | yes |
| `active` | Prepay invoice paid, coverage window live. Renewal notices go out from here. | yes |
| `renewal_pending` | Active term whose customer has been contacted about renewal — by an operator (`renewal_contacted_at`) or by the automated 30/15/7-day notice (`notice_*_sent_at`). Still covered — behaves as `active` everywhere (`ACTIVE_STATUSES = ['active','renewal_pending']`). | yes |
| `renewed` | Decided: customer renews. Coverage for the paid window stays. Terminal. | yes |
| `switch_plan` | Decided: customer moves to another plan at term end. Coverage stays. Terminal. | yes |
| `cancelled` | Two shapes, told apart by `renewal_decision`: **(a)** `renewal_decision IS NULL` = the prepay invoice was voided / refunded / lost a dispute — coverage revoked, prepaid stamps cleared, billing mode reset; **(b)** `renewal_decision = 'cancel'` = a decided renewal lapse — the paid window keeps its coverage. Shape (b) is terminal; shape (a) can revive (move 11). | yes |
| `canceled` | US spelling. Allowed by the CHECK, tolerated by readers (`whereNotIn ['cancelled','canceled']`), **never written**. Legacy name. | no |
| `refunded` | Allowed by the CHECK, **never written**. A refunded invoice maps to term `cancelled` (`invoiceTermStatus`). Legacy name. | no |

"Decided" = `renewal_decision IS NOT NULL` (one of `renew` / `cancel` /
`switch_plan`, also CHECK-enforced). The decision column is the real terminal
latch: every status-mutating path below except move 13 guards on
`renewal_decision IS NULL` or on `status IN ACTIVE_STATUSES`, so a decided
term never moves again through the service layer.

## Allowed moves

`R` = `server/services/annual-prepay-renewals.js`, `AI` =
`server/routes/admin-invoices.js`. Guards are the literal `WHERE` clauses on
the `UPDATE`; an `UPDATE` whose guard misses is a no-op (race-safe,
replay-idempotent), never an error.

| # | From | To | Trigger | Where | Guard |
|---|---|---|---|---|---|
| 1 | *(birth)* | `payment_pending` / `active` / `cancelled` | `createTermForAnnualPrepay` — birth status is `invoiceTermStatus(linked invoice)`: unpaid → `payment_pending`, paid → `active` (born-paid), void/refunded → `cancelled`. Re-running for an existing **undecided** term re-derives the status the same way. | `R` `createTermForAnnualPrepay` (`statusForPrepayInvoice`) | existing row keeps its status when `renewal_decision` is set |
| 2 | `payment_pending` | `active` | Prepay invoice paid (webhook / manual record) or the daily `activatePaidPendingTerms` sweep finds a paid invoice. Seeds coverage visits, stamps `prepaid_amount`, sets `billing_mode = annual_prepay`. | `R` `syncTermForInvoicePayment`, `activatePaidPendingTerms` | `status = 'payment_pending'` |
| 3 | `active` / `renewal_pending` | `renewal_pending` | Operator records "contacted". Idempotent from `renewal_pending`. | `R` `recordDecision('contacted')` | `status IN ACTIVE_STATUSES AND renewal_decision IS NULL` |
| 4 | `active` | `renewal_pending` | Automated 30/15/7-day renewal notice **claims** the term before sending (`notice_N_claimed_at` stamped in the same UPDATE; from `renewal_pending` the status is carried through). | `R` `sendCustomerTermNotice` (claim) | `status IN ACTIVE_STATUSES AND renewal_decision IS NULL AND notice_N_sent_at IS NULL AND (notice_N_claimed_at IS NULL OR stale > 15 min)` |
| 5 | `renewal_pending` | `active` *(previous status)* | Notice delivery failed (no customer / SMS+email both failed) → the claim is released and the pre-claim status restored. Rollback of move 4 only. | `R` `sendCustomerTermNotice` (`releaseClaim`) | `renewal_decision IS NULL AND notice_N_sent_at IS NULL` |
| 6 | `active` / `renewal_pending` | `renewed` | Operator records decision `renew`. Sets `renewal_decision = 'renew'`. | `R` `recordDecision('renew')` | same as 3 |
| 7 | `active` / `renewal_pending` | `switch_plan` | Operator records decision `switch_plan`. Sets `renewal_decision = 'switch_plan'`. | `R` `recordDecision('switch_plan')` | same as 3 |
| 8 | `active` / `renewal_pending` | `cancelled` **(b)** | Operator records decision `cancel` — a renewal lapse. Sets `renewal_decision = 'cancel'`; coverage for the paid window is kept. | `R` `recordDecision('cancel')` | same as 3 |
| 9 | `payment_pending` / `active` / `renewal_pending` | `cancelled` **(a)** | Prepay invoice voided, refunded, or a `payments` refund lands (`syncTermForRefundedPayment`). Clears prepaid stamps, reverses WaveGuard extension credits, reopens covered visit invoices, resets billing mode. | `R` `syncTermForInvoicePayment` (`nextStatus === 'cancelled'`) | `renewal_decision IS NULL` |
| 10 | `active` / `renewal_pending` | `payment_pending` | Dispute opened on the prepay invoice. Stamps `dispute_suspended_at`; coverage suspended (visits bill per-visit) until the dispute resolves. Dispute won → invoice back to paid → move 2 fires; the marker survives until the dues claw-back finishes, then `finishDisputeRecoveryForTerm` clears it. | `R` `suspendActiveTermsForDisputedInvoice` | `status IN ACTIVE_STATUSES` |
| 11 | `cancelled` **(a)** | `active` | Lost-dispute revival: the dispute-cancelled term's invoice is re-paid in dunning. Restores extension credits. | `R` `syncTermForInvoicePayment` | `status = 'cancelled' AND renewal_decision IS NULL AND dispute_suspended_at IS NOT NULL` |
| 12 | `active` / `renewal_pending` / `payment_pending` | `payment_pending` | Admin reverses an applied credit on a prepaid invoice — the term is "un-paid"; stamps cleared. | `AI` `POST /:id/reverse-prepaid` (apply-credit reversal) | `renewal_decision IS NULL AND status NOT IN ('cancelled','canceled')` |
| 13 | *any* | `cancelled` | Admin removes the annual-prepay flag from an invoice (`DELETE /:id/annual-prepay`). Stamps cleared, attached visits detached; billing mode is NOT reset. **Unguarded** — the only path that can move a decided term. Re-marking the invoice later re-derives the status via move 1 **only for an undecided term**; a decided term stays `cancelled` (`renewal_decision` survives the DELETE and move 1 preserves the status when it is set). | `AI` `DELETE /:id/annual-prepay` | none |

Everything not in the table is not a move. In particular there is **no**
`renewed → *`, `switch_plan → *`, or `cancelled(b) → *` (other than move 13),
and nothing ever writes `canceled` or `refunded`.

## Read-side groupings

These constants in `R` decide what each stage *means* to the rest of billing:

- `ACTIVE_STATUSES = ['active', 'renewal_pending']` — covered, eligible for
  renewal notices, stamps `billing_mode = annual_prepay`.
- `DECIDED_COVERED_STATUSES = ['renewed', 'switch_plan']` — decided but the paid
  window still covers visits (via the "decided paid-invoice gate": coverage
  holds only while the prepay invoice reads paid).
- `cancelled` + `renewal_decision = 'cancel'` — treated like
  `DECIDED_COVERED_STATUSES` for coverage (decided lapse keeps its window).
- `PAYMENT_PENDING_STATUS = 'payment_pending'` — payment reminders (3d/1d),
  card-expiry exemptions, `getPaymentPendingCustomerIds`.

## Known residue (not fixed here)

- `canceled` and `refunded` sit in the CHECK but are dead names. Dropping them
  is a migration (`DROP CONSTRAINT` + re-add) and needs a prod row scan first
  (`SELECT status, count(*) … GROUP BY 1`) — separate PR, owner call.
- Move 13 is the one unguarded transition, and after it a decided term is
  stranded `cancelled` with its decision intact. Whether the DELETE should
  refuse decided terms (or clear the decision) is an owner ruling; documented,
  not changed.
- `cancelled` carries two meanings. A dedicated `lapsed` status would remove
  the `renewal_decision` disambiguation everywhere, but that is a CHECK change
  plus ~10 read sites — not a one-PR move.
