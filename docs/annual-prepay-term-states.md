# Annual-prepay term states

`annual_prepay_terms.status` is a small state machine. The stage names are
enforced in the database (`annual_prepay_terms_status_check`, migration
`20260614000001_annual_prepay_terms_checks.js`); the **moves** were never
written down — they lived as scattered `.update({ status })` calls with
`WHERE` guards. This page is that list. It documents what the code does today
on `origin/main`; it is not a redesign.

The guard test `server/tests/annual-prepay-term-states.test.js` pins the
stage list to the migration, scans every non-test, non-migration file under
`server/` and `ops/` for status writes to this table (migrations are the CHECK
side and are reviewed as one-off DML under the waves-db rules, not as
recurring writers) and resolves each one to a documented
stage, and pins the transition functions' guards. Change any side → update
this page in the same PR.

## Stages

| Status | Meaning | Written by code? |
|---|---|---|
| `payment_pending` | Term exists, prepay invoice not paid (default at birth; also the *dispute-suspended* stage — see `dispute_suspended_at`). Coverage is not applied. May carry `renewal_decision = 'cancel'` — the customer declined online before paying (the only decided `payment_pending` shape); it settles through move 15, never move 2. | yes |
| `active` | Prepay invoice paid, coverage window live. Renewal notices go out from here. | yes |
| `renewal_pending` | Active term whose customer has been contacted about renewal — by an operator (`renewal_contacted_at`) or by the automated 30/15/7-day notice (`notice_*_sent_at`). Still covered — behaves as `active` everywhere (`ACTIVE_STATUSES = ['active','renewal_pending']`). | yes |
| `renewed` | Decided: customer renews. Coverage for the paid window stays. Terminal once processed (a successor term minted from it); until then the customer's online decline can supersede it (move 14). | yes |
| `switch_plan` | Decided: customer moves to another plan at term end. Coverage stays. Terminal. | yes |
| `cancelled` | Two shapes, told apart by `renewal_decision`: **(a)** `renewal_decision IS NULL` = the prepay invoice was voided / refunded / lost a dispute — coverage revoked, prepaid stamps cleared, billing mode reset; **(b)** `renewal_decision = 'cancel'` = a decided renewal lapse — the paid window keeps its coverage. Shape (b) is terminal; shape (a) can revive (move 11). | yes |
| `canceled` | US spelling. Allowed by the CHECK, tolerated by readers (`whereNotIn ['cancelled','canceled']`), **never written**. Legacy name. | no |
| `refunded` | Allowed by the CHECK, **never written**. A refunded invoice maps to term `cancelled` (`invoiceTermStatus`). Legacy name. | no |

"Decided" = `renewal_decision IS NOT NULL` (one of `renew` / `cancel` /
`switch_plan`, also CHECK-enforced). The decision column is the **intended**
terminal latch: every status-mutating path below guards on
`renewal_decision IS NULL` or on `status IN ACTIVE_STATUSES`, with two known
exceptions — move 14 (a guarded `renewed` → `cancelled` supersession by the
customer's own online decline, only while no successor term exists), and
move 1's existing-row re-run, whose decided-status preservation is a
snapshot read, not a DB guard (the TOCTOU residue below; a decided row
overwritten in that window could then re-activate through move 2's
`payment_pending`-only guard). Move 13 used to be another exception
(deliberately unguarded) until ADMIN-BUG-R16 routed it through the same
`renewal_decision IS NULL` guard as move 9.

## Allowed moves

`R` = `server/services/annual-prepay-renewals.js`, `AI` =
`server/routes/admin-invoices.js`, `TR` =
`server/services/termite-annual-renewal-charge.js`. Guards are the literal
`WHERE` clauses on the `UPDATE`; an `UPDATE` whose guard misses is a no-op
(race-safe, replay-idempotent), never an error.

| # | From | To | Trigger | Where | Guard |
|---|---|---|---|---|---|
| 1 | *(birth)* | `payment_pending` / `active` / `cancelled` | `createTermForAnnualPrepay` — birth status is `statusForPrepayInvoice(prepayInvoiceId)`: **no linked invoice → `active`** (a manual term without a prepay invoice is treated as already-covered), invoice unpaid → `payment_pending`, paid → `active` (born-paid), void/refunded → `cancelled`, invoice lookup error → `payment_pending` (degrade, never guess active). Re-running for an existing **undecided** term re-derives the status the same way. | `R` `createTermForAnnualPrepay` (`statusForPrepayInvoice`) | existing row keeps its status when `renewal_decision` is set |
| 2 | `payment_pending` | `active` | Prepay invoice paid (webhook / manual record) or the daily `activatePaidPendingTerms` sweep finds a paid invoice. Seeds coverage visits, stamps `prepaid_amount`, sets `billing_mode = annual_prepay`. Undecided terms only — a declined pending term settles through move 15. | `R` `syncTermForInvoicePayment`, `activatePaidPendingTerms` | `status = 'payment_pending' AND renewal_decision IS NULL` |
| 3 | `active` / `renewal_pending` | `renewal_pending` | Operator records "contacted". Idempotent from `renewal_pending`. | `R` `recordDecision('contacted')` | `status IN ACTIVE_STATUSES AND renewal_decision IS NULL` |
| 4 | `active` | `renewal_pending` | Automated 30/15/7-day renewal notice **claims** the term before sending (`notice_N_claimed_at` stamped in the same UPDATE; from `renewal_pending` the status is carried through). | `R` `sendCustomerTermNotice` (claim; a termite combined 30+45 send claims **both** rungs in one UPDATE via `claimCombinedTermNotice`, which additionally requires both rungs' on-time and late columns NULL and both claims available) | `status IN ACTIVE_STATUSES AND renewal_decision IS NULL AND notice_N_sent_at IS NULL AND (notice_N_claimed_at IS NULL OR stale > 15 min)` |
| 5 | `renewal_pending` | `active` *(previous status)* | Notice delivery failed (no customer / SMS+email both failed) → the claim is released and the pre-claim status restored. Rollback of move 4 only. | `R` `sendCustomerTermNotice` (`releaseClaim`; the combined send's `releaseCombinedTermNoticeClaim` clears both claims, guarded on `notice_30_sent_at IS NULL`) | `renewal_decision IS NULL AND notice_N_sent_at IS NULL AND status = 'renewal_pending' AND notice_N_claimed_at = <this attempt's claim timestamp>` — otherwise only this attempt's own claim is cleared and the status is left alone (a refund/dispute that moved it meanwhile is never undone) |
| 6 | `active` / `renewal_pending` | `renewed` | Operator records decision `renew`. Sets `renewal_decision = 'renew'`. | `R` `recordDecision('renew')` | same as 3 |
| 7 | `active` / `renewal_pending` | `switch_plan` | Operator records decision `switch_plan`. Sets `renewal_decision = 'switch_plan'`. | `R` `recordDecision('switch_plan')` | same as 3 |
| 8 | `active` / `renewal_pending` | `cancelled` **(b)** | Operator records decision `cancel` — a renewal lapse. Sets `renewal_decision = 'cancel'`; coverage for the paid window is kept. | `R` `recordDecision('cancel')` | same as 3 |
| 9 | `payment_pending` / `active` / `renewal_pending` | `cancelled` **(a)** | Prepay invoice voided, refunded, or a `payments` refund lands (`syncTermForRefundedPayment`). Clears prepaid stamps, reverses WaveGuard extension credits, reopens covered visit invoices, resets billing mode, restores any switch-superseded invoice / retired setup-fee claim — all inside `cancelTermWithRestorations` (ADMIN-BUG-R16: lifted out to a shared, exported function so move 13 below runs the identical pipeline). | `R` `syncTermForInvoicePayment` → `cancelTermWithRestorations` (`nextStatus === 'cancelled'`) | `renewal_decision IS NULL` |
| 10 | `active` / `renewal_pending` | `payment_pending` | Dispute opened on the prepay invoice. Stamps `dispute_suspended_at`; coverage suspended (visits bill per-visit) until the dispute resolves. Dispute won → invoice back to paid → move 2 fires; the marker survives until the dues claw-back finishes, then `finishDisputeRecoveryForTerm` clears it. | `R` `suspendActiveTermsForDisputedInvoice` | `status IN ACTIVE_STATUSES` |
| 11 | `cancelled` **(a)** | `active` | Lost-dispute revival: the dispute-cancelled term's invoice is re-paid in dunning. Restores extension credits. | `R` `syncTermForInvoicePayment` | `status = 'cancelled' AND renewal_decision IS NULL AND dispute_suspended_at IS NOT NULL` |
| 12 | `active` / `renewal_pending` / `payment_pending` | `payment_pending` | Admin reverses an applied credit on a prepaid invoice — the term is "un-paid"; stamps cleared, and (ADMIN-BUG-R17) `customers.billing_mode` is reset to the recorded prior mode via `resetBillingModeAfterTermCancel`, pairing the demotion exactly like move 10's dispute-suspend does — the customer no longer stays stranded in `annual_prepay` (serviced free / no monthly dues) until the reopened invoice is actually repaid. (The guard's `NOT IN` shape would also admit an undecided legacy `refunded` row — the only move that can touch a legacy row: move 9's upstream select is limited to `payment_pending`/`active`/`renewal_pending`. Code never writes the legacy names, but the 20260614 migration kept them in the CHECK and only normalized values *outside* it, so pre-existing rows may survive; see residue.) | `AI` `POST /:id/reverse-prepaid` (apply-credit reversal) | `renewal_decision IS NULL AND status NOT IN ('cancelled','canceled')` |
| 13 | `payment_pending` / `cancelled` (undecided) | `cancelled` **(a)** | Admin removes the annual-prepay flag from an invoice marked by mistake (`DELETE /:id/annual-prepay`). The invoice survives as an ordinary invoice, so the route refuses (409) whenever the cancel could double-bill: a decided term, a PAID prepay (`status IN ACTIVE_STATUSES` — refund it instead, owner ruling 2026-09-26), and a prepay a flow owns — born from an accepted estimate (`source_estimate_id`, whose card auto-charge job could still collect it), a switch-superseded marker or a setup-fee claim — void it instead. Otherwise it runs the SAME `cancelTermWithRestorations` pipeline as move 9 (ADMIN-BUG-R16): stamps cleared (`throwOnError`), covered visit invoices reopened with their reminders re-armed after commit, credits reversed, `customers.billing_mode` reset to the recorded prior mode; only non-terminal attached visits are detached. Re-marking the invoice later re-derives the status via move 1. | `R` `cancelTermWithRestorations`, called from `AI` `DELETE /:id/annual-prepay` | `renewal_decision IS NULL`; the route refuses `ACTIVE_STATUSES` first |
| 14 | `renewed` | `cancelled` **(b)** | The customer declines renewal online (termite annual plan, agreement v3: "at any time before the renewal date") while a staff-recorded `renew` is still UNPROCESSED — no successor term has been minted from it. Sets `renewal_decision = 'cancel'` and `cancel_disposition = 'end_at_term'` (the decline supersedes the renew); coverage for the paid window is kept. The caller also requires today before `term_end` (or a term still awaiting its installation) and a still-paid year. `switch_plan`, and a `renew` whose successor exists, never move. | `R` `supersedeRenewWithCustomerCancel` (from `declineTermiteAnnualRenewal`) | `status = 'renewed' AND renewal_decision = 'renew' AND NOT EXISTS (successor: renewed_from_term_id = id)` |
| 15 | `payment_pending` | `cancelled` **(b)** | A signed termite annual plan the customer declined online while still `payment_pending` (an unpaid original invoice, or a dispute-suspended one) keeps status `payment_pending` with `renewal_decision = 'cancel'` + `cancel_disposition = 'end_at_term'` (the decision-only write `declinePaymentPendingWithCustomerCancel`, guarded `status = 'payment_pending' AND renewal_decision IS NULL` — no status change, so the pending rails keep it: the billing cron's payment-pending exclusion). When its prepay invoice RESOLVES it settles here instead of activating: paid → covered through `term_end` by the decided-lapse branch of `coveredTermsAsOf`, with the paid follow-through (attach + stamp, pending-window reconcile, dispute recovery) and never renewing — `billing_mode = annual_prepay` only while the term covers TODAY (paid after `term_end`, the mode is left as it was, never the nothing-bills limbo); the historical reconcile runs whenever the term is paid, expired or not, stamps any still-open in-window visit prepaid (the end-at-term upkeep, evaluated as of `term_end` once it has passed), and is retried by the covered-terms sweep (least-recently-attempted first) until an `annual_prepay_paid_lapse_reconciled` activity marker records a clean run; voided / refunded → nothing covered. If it never resolves, once its installation-derived end has passed the portal-decline retrieval sweep rings ONE staff bell (collection + station retrieval are a staff decision; no automatic task, no status change). Move 2 never takes a decided term. | `R` `settleDecidedPendingTerms` (from `syncTermForInvoicePayment`) | `status = 'payment_pending' AND renewal_decision = 'cancel'` |
| 16 | `active` / `renewal_pending` | `renewed` | Termite annual plan only (`annual_plan_version IS NOT NULL`), dark behind `GATE_TERMITE_ANNUAL_PLAN`: the renewal successor's OWN renewal invoice is genuinely paid — `syncTermForInvoicePayment`'s pending→active transition for a row carrying `renewed_from_term_id` calls `recordDecision('renew')` on the PARENT (`stampParentRenewedForSuccessor`). The same stamp runs when a successor the customer already declined (move 15's decided-pending shape) is paid: that payment still proves THIS renewal happened. Under the renewal gate the stamp re-reads the successor (live, or the paid decided-lapse `cancelled` + `cancel` shape, its own invoice settled and not revoked) and the parent before writing. Deliberately NOT at mint (P2-1 fix, superseding the original slice-6b design below the table) — a minted-but-unpaid successor can still lapse (move 17), and deciding `renew` before that is known would leave a lapsed-and-cancelled successor sitting behind a parent already marked `renewed`. This reuses the SAME writer an operator's manual "renew" click uses (move 6) — it is not a new status-write site in `TR`. | `R` `syncTermForInvoicePayment` (calls `recordDecision('renew')`) | `where({ id: termId }) AND status IN ACTIVE_STATUSES AND renewal_decision IS NULL` |
| 17 | `active` / `renewal_pending` | `cancelled` **(b)** | Termite annual plan only: the renewal successor's own payment grace deadline passes unpaid (its invoice was actually presented to the customer — see `TR`'s grace-lapse pass) — the successor's invoice voids (cascading the successor itself to `cancelled` **(a)** through move 9) and, in the SAME tick, `TR`'s `processGraceLapseForTerm` calls `recordDecision('cancel')` on the PARENT, recording the decided lapse. Reuses the SAME writer an operator's manual "cancel" click uses (move 8). | `TR` `processGraceLapseForTerm` (calls `recordDecision('cancel')`) | `where({ id: termId }) AND status IN ACTIVE_STATUSES AND renewal_decision IS NULL` |

Everything not in the table is not a move. In particular there is **no**
`switch_plan → *` or `cancelled(b) → *` (move 13 now refuses a decided
term), `renewed → *` only through the customer's unprocessed-renew
supersession (move 14), and nothing ever writes `canceled` or `refunded`. Moves 16 and 17 are both
automated *triggers* of the SAME `recordDecision` writer moves 6 and 8 use —
neither is a new status-write site in `annual-prepay-renewals.js`, and
neither reads or writes a row already carrying a `renewal_decision`
(`recordDecision`'s own guard).

`TR` = `server/services/termite-annual-renewal-charge.js`. Minting the
renewal successor itself (`mintRenewalSuccessor`) writes NO status to the
PARENT — see the module's own header for why (P2-1: mint only proposes a
renewal; moves 16/17 above decide it once the outcome is actually known).

## Read-side groupings

These constants in `R` decide what each stage *means* to the rest of billing:

- `ACTIVE_STATUSES = ['active', 'renewal_pending']` — covered, eligible for
  renewal notices, stamps `billing_mode = annual_prepay`.
- `DECIDED_COVERED_STATUSES = ['renewed', 'switch_plan']` — decided but the paid
  window still covers visits (via the "decided paid-invoice gate": coverage
  holds only while the prepay invoice reads paid).
- `cancelled` + `renewal_decision = 'cancel'` — treated like
  `DECIDED_COVERED_STATUSES` for coverage (decided lapse keeps its window).
  The decision carries `cancel_disposition` (ADMIN-BUG-R18), written by
  `recordDecision` (and by move 14's `supersedeRenewWithCustomerCancel` and
  the payment_pending decision write `declinePaymentPendingWithCustomerCancel`
  — see move 15 — always `end_at_term`) in the same statement: `end_now_refund` for Cancel plan's
  "end now + refund" (it pulled every visit and owes the unused value back),
  `end_at_term` for "End of paid coverage" and a renewal-time lapse. An
  end-at-term lapse later ended now is upgraded in place by
  `recordCancelDisposition` (never back — Cancel plan refuses end-now →
  end-at-term). The WRITE side keeps an `end_at_term` lapse's paid visits
  owed through `term_end` (`isEndAtTermLapseInWindow`,
  `keepEndAtTermLapseCoverage`), only while `coveredTermsAsOf` still reports
  it as paid coverage (re-checked with the prepay invoice locked, so a
  dispute's cleared stamps are not handed back): a per-edit refresh
  attaches and stamps visits that exist, and the nightly
  `reconcileCoveredTermsSweep` also replaces a skipped one, under Cancel
  plan's commit key (`tryHoldCancelCommitLockForTransaction`; a busy key
  waits for the next night). An `end_now_refund` lapse is never reseeded or
  stamped.
- `PAYMENT_PENDING_STATUS = 'payment_pending'` — card-expiry exemptions, `getPaymentPendingCustomerIds`.
- Termite-renewal grace coverage (owner ruling 2026-09-26, P2-4): a
  `payment_pending` termite renewal SUCCESSOR (`renewed_from_term_id NOT
  NULL AND annual_plan_version NOT NULL`) is ALSO covered — no status
  change, no seeding — through `TERMITE_RENEWAL_GRACE_DAYS` from whichever
  is later of its own `term_start` or `created_at` (ET date):
  `termiteRenewalGraceDeadlineFor` / `termiteRenewalGraceDeadlineSql`, the
  SAME cutoff `TR`'s grace-lapse pass voids on, so coverage and the lapse
  can never disagree about the exact day. `coveredTermsAsOf`'s own
  `reconcileCoveredTermsSweep` caller skips this shape (confirms the
  invoice is ACTUALLY paid before running any settle/credit leg) — grace
  coverage never seeds a coverage stamp or settles a completion as paid;
  it only keeps `getActivelyCoveredCustomerIds` (and every other reader of
  `coveredTermsAsOf`) from treating the customer as uncovered while the
  grace period runs. Coverage ends the moment the lapse pass actually
  voids the invoice (the existing cancelled-invoice exclusion takes over).

## Known residue (not fixed here)

- `canceled` and `refunded` sit in the CHECK but are dead names for the CODE.
  The 20260614 migration preserved any rows already carrying them (it only
  normalized values outside its list), so legacy rows may still exist in prod;
  an undecided legacy `refunded` row would be admitted by move 12 (move 9's select excludes legacy names). Step 1 is a
  prod row scan (`SELECT status, count(*) FROM annual_prepay_terms GROUP BY 1`);
  if zero, drop the two names from the CHECK (`DROP CONSTRAINT` + re-add); if
  non-zero, normalize them (`canceled`→`cancelled`, `refunded`→`cancelled` with
  `renewal_decision IS NULL` semantics) in the same migration — separate PR,
  owner call.
- ~~Move 13 is the one unguarded transition...~~ FIXED (ADMIN-BUG-R16):
  `DELETE /:id/annual-prepay` now runs the same `renewal_decision IS NULL`
  guard as move 9 (via the shared `cancelTermWithRestorations`) and refuses
  a decided term, a paid prepay and a charge-replacing prepay with 409.
- Move 5's release IS ownership-checked (Codex #4921 r8): it restores the
  status only while the row is still `renewal_pending` with this attempt's
  exact claim timestamp, else clears only its own claim (matched by
  timestamp). A worker that stalls past the 15-minute TTL therefore no longer
  clears a successor's fresh claim or overwrites its status, and a
  refund/void/dispute that moved the status mid-attempt is never undone.
- Move 1's existing-row re-run preserves a decided status via a snapshot read
  (`existing.renewal_decision ? existing.status : nextStatus`) with an
  id-only UPDATE — a `recordDecision` committing between the read and the
  write can be overwritten by `nextStatus` (TOCTOU). Pre-existing; the fix is
  a DB-side CASE or a `renewal_decision IS NULL` guard on that UPDATE —
  a code change to the module, separate follow-up.
- `cancelled` carries two meanings. A dedicated `lapsed` status would remove
  the `renewal_decision` disambiguation everywhere, but that is a CHECK change
  plus ~10 read sites — not a one-PR move.
