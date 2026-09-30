'use strict';

// ============================================================
// termite-annual-renewal-charge.js — slice 6b: the automatic renewal charge
// for the Waves Subterranean Termite Protection annual plan (dark behind
// GATE_TERMITE_ANNUAL_PLAN). Owner ruling A-13: auto-charge the saved
// method at renewal under the consent captured in the v3 agreement;
// failure -> owner bell, at-most-once. This moves real money, so every
// path here is fail-closed: never charge twice, never guess a price.
//
// Runs as a daily sweep (registered alongside the other annual-prepay jobs
// in workflows/renewal-reminder.js) over independent passes, each
// bounded and each tolerant of the others' failures:
//
//   1. bellNoWitnessTerms — a termite term due for renewal that never got
//      its ON-TIME 45-day customer notice (notice_45_sent_at) is NEVER
//      auto-charged — the v3 agreement's authorization presumes the
//      customer was actually warned. The older, generic notice_30_sent_at
//      rung every annual-prepay term carries is deliberately NOT an
//      alternative witness here (P1-4): a LATE 45-day send leaves
//      notice_45_sent_at NULL and must fall into this bell, not slip
//      through on the 30-day rung. Bells staff once per term (permanent
//      dedupe) instead.
//   2. bellUnanchoredOriginalTerms — a witnessed ORIGINAL term (never
//      renewed before — renewed_from_term_id IS NULL) whose real-world
//      installation was never anchored (installation_anchored_at IS NULL,
//      see termite-annual-activation.js's anchorTermToInstallation) has no
//      station program to keep running. Bells staff instead of minting a
//      renewal for a plan that was never actually installed. A SUCCESSOR
//      term is anchored by construction (its dates derive from the
//      parent's already-anchored window) and never needs this check.
//   3. bellStaleOverdueTerms — a witnessed, anchor-eligible term more than
//      GRACE_DAYS past its own term_end is too late to auto-charge without
//      risking a surprise months-late bill (P1-2). Bells staff instead of
//      minting/charging.
//      Codex round-5 P1 (all three of 1-3): a bell's own dedupeKey
//      suppresses a REPEAT notification, but does nothing to shrink the
//      SCAN's own candidate set — each scan orders by term_end and takes
//      the oldest LIMIT rows, so once more than LIMIT terms sit in one
//      exception bucket, the oldest ones keep consuming every tick's LIMIT
//      slot (dedupe-skipped every time) while a newer term past that
//      backlog never gets scanned, hence never gets its required staff
//      alert. Each scan now excludes on its OWN kind-specific column
//      (Codex round-6 P1: renewal_no_witness_belled_at /
//      renewal_unanchored_belled_at / renewal_stale_overdue_belled_at,
//      20260926050001 — round-5's single shared renewal_exception_belled_at
//      column excluded a term from ALL three scans the instant any ONE
//      kind belled it, so a term fixed for kind A that later legitimately
//      matches kind B would never be scanned for B either) directly in SQL
//      (stampRenewalExceptionBelled, stamped once the bell has actually
//      been asked for — fresh or deduped, either way staff has been told)
//      instead of relying on dedupe alone.
//   4. processRenewalCandidates — for every due, witnessed, anchor-eligible,
//      NOT-stale, undecided termite term with no successor yet: mints the
//      successor term + its renewal invoice (§2), then decides whether to
//      charge it (§3).
//   4b. withdrawSuccessorsOfIneligibleParents (owner ruling, #4971
//      pre-push item 6) — every open successor whose parent became DURABLY
//      ineligible (staff cancel, refund/void of the parent, flag removal,
//      switch) is withdrawn right away, sent invoice or not: voided +
//      cancelled under the parent's gate, one staff bell, no retrieval, no
//      parent decision, no customer message; money in motion wins.
//   5. processGraceLapses — for a FRESH (never-started) unpaid successor
//      past its own payment grace deadline (GRACE_DAYS from whichever is
//      LATER of its term_start or its own created_at — see
//      annual-prepay-renewals.js's termiteRenewalGraceDeadlineFor, the SAME
//      formula coveredTermsAsOf's grace-coverage branch reads, P2-4) whose
//      renewal invoice was actually presented to the customer (a charge
//      reached Stripe, or the invoice carries a delivery stamp):
//      runs processGraceLapseForTerm's full state machine (below) —
//      stamp renewal_lapse_started_at, Codex round-5 P0 settlement
//      re-check (resolveLapseVoidEligibility — retire instead of void if
//      already settled), fail-closed reconciliation check, void,
//      retrieval task, parent decision, renewal_lapse_completed_at. A row
//      this pass already started (or a prior tick did) is excluded here —
//      pass 6 owns resuming it exclusively.
//   6. reconcileMissedLapseEffects (Codex round-1/2 P1) — pass 5's state
//      machine can stop partway through (a crash, or a fail-closed
//      reconciliation deferral) leaving a row with renewal_lapse_started_at
//      set and renewal_lapse_completed_at still null. Re-runs
//      processGraceLapseForTerm for every such row — PERSISTED PROVENANCE,
//      never inferred from status='cancelled' (which a staff void, a
//      removed annual-prepay flag, or a lost dispute can ALSO produce, and
//      which this pass must never touch). Every step in the state machine
//      is independently idempotent/re-entrant, so re-running it for a row
//      whose effects already finished, or one still genuinely blocked, is
//      always safe.
//   7. reconcileStuckSuccessors — two narrow, self-healing legs for the
//      accepted crash gaps between minting a successor and finishing its
//      charge decision (§3):
//        a. renewal_charge_attempted_at IS NULL and the successor is more
//           than an hour old: decideAndCharge() never ran (or ran but hit
//           a skip that never stamps the fence — no_consent / no_method /
//           surcharge_not_authorized / ineligible, which already belled+
//           delivered a pay link on their one real run). Codex round-4 P1:
//           excluded on the PERSISTED renewal_charge_skipped_at column
//           (stampRenewalChargeSkip, stamped by decideAndCharge itself the
//           instant any of those skips fires) directly in the SQL — never
//           inferred from a notifications-table LIKE scan checked after
//           the row is already selected under LIMIT, which let a backlog
//           of old, already-belled skips starve newer crash-gap rows out
//           of ever being reached. No skip stamp at all means
//           decideAndCharge() genuinely never ran (a crash between the
//           mint committing and the decide call) — run it now; the
//           Stripe-attempt fence still keeps it to at most one charge.
//        b. renewal_charge_attempted_at IS NOT NULL but no
//           stripe_invoice_charge_attempts row exists for the successor's
//           invoice: the claimed attempt provably never reached Stripe (a
//           crash between the atomic fence stamp and the actual Stripe
//           call). Safe to deliver the pay link (no money is or ever was
//           in flight) — bell staff once as ambiguous. NEVER re-charged
//           automatically.
//   7c. reconcileChargeFollowThrough (#4971 pre-push P1) — a charge that
//      reached Stripe and did not pay (decline / refusal / ambiguous) whose
//      follow-through (staff bell, and the pay link where owed) did not
//      complete: re-run from its persisted kind — never the charge, never a
//      pay link for an ambiguous outcome, never a second customer text.
//
// P2-4 coverage note (owner ruling 2026-09-26): an unpaid successor stays
// COVERED (no per-visit billing) through its own GRACE_DAYS payment window —
// see annual-prepay-renewals.js's coveredTermsAsOf, the
// termiteRenewalGraceCovered branch, sharing the exact same cutoff formula
// this file's grace-lapse pass voids on.
//
// Codex #4971 round-3 — five invariants, each enforced at ONE chokepoint
// rather than per call site (earlier rounds kept finding the next site):
//   A. payment evidence — classifyRenewalInvoice / invoiceSettledNotRevoked
//      and their SQL twins (whereInvoiceSettledNotRevoked,
//      whereInvoiceDelivered, whereAttemptSubmitted): every scan and
//      eligibility check here, and the parent-renewed backstop, read money
//      through these.
//   B. parent-state serialization — every writer that can move a termite
//      term out of charge-eligible state takes the parent-decision lock
//      (annual-prepay-renewals.js acquireTermiteGateAtEntry, as its transaction's first lock), which the
//      charge holds across its last re-check and the Stripe submission.
//   C. successor lifecycle — a successor that must never be charged, billed
//      or lapsed leaves payment_pending only through
//      withdrawRenewalSuccessor (void + cancel, staff bell), never by
//      being stamped "handled".
//   D. scan fairness — every bounded recovery scan orders by
//      renewal_sweep_deferred_at NULLS FIRST (stampSweepDeferred), and a
//      lapse that needs a human is held as renewal_lapse_outcome=
//      'manual_review', which the recovery scan excludes.
//   E. the successor's window is fixed at mint — a late payment never
//      slides it (annual-prepay-renewals.js windowFixedAtCreation).
//
// Design choices (see the lane's own commit message / PR description for
// the full rationale):
//   - The successor's renewal invoice charges EXACTLY parent.prepay_amount
//     — the same number slice 5's notice quoted. Never recomputed. taxRate
//     is pinned to an explicit 0, mirroring the ORIGINAL activation
//     invoice's frozen-zero convention (145a88c99d) — the renewal must not
//     silently pick up tax from a reclassification either.
//   - The PARENT is NOT marked 'renewed' at mint (P2-1 fix): minting a
//     successor only PROPOSES a renewal, and an unpaid successor can still
//     lapse (pass 5). The parent is instead marked 'renewed'
//     (renewal_decision='renew') the moment the successor's OWN renewal
//     invoice is genuinely paid — annual-prepay-renewals.js's
//     syncTermForInvoicePayment (pending→active path for a row with
//     renewed_from_term_id) calls the canonical recordDecision('renew') on
//     the parent (docs/annual-prepay-term-states.md move 16) — or
//     recordDecision('cancel') on a grace lapse (move 17). Both reuse the
//     SAME writer an operator's manual decision uses, so neither is a new
//     status-write site in THIS file. Codex round-2 P1: the parent stamp
//     itself runs as a SAVEPOINT on the successor's OWN activation
//     transaction (annual-prepay-renewals.js's stampParentRenewedForSuccessor),
//     never a separate global-db write that could commit out of order
//     with, or survive a rollback of, the successor's own flip; a reconcile
//     leg (AnnualPrepayRenewals.reconcileParentRenewedStamps) backstops an
//     active, paid successor whose parent still never got stamped.
//   - Codex round-2 P0: the grace-lapse pass never voids an invoice without
//     first asserting no Stripe charge reconciliation is pending on it (the
//     SAME guard the abandoned-prepay sweep uses) — a crash after Stripe
//     ACCEPTS a charge but before the local write completes must never be
//     misread as "safe to void, nothing collected". Codex round-2 P1: the
//     lapse itself is tracked with persisted PROVENANCE
//     (renewal_lapse_started_at / renewal_lapse_completed_at, stamped
//     BEFORE any void and only once every effect actually succeeds) —
//     recovery reconciles ONLY a confirmed, started-but-incomplete lapse,
//     never inferring one from status='cancelled' (a shape a staff void, a
//     removed annual-prepay flag, or a lost dispute can also produce).
//   - Codex round-1 P0: the fence claim is not a bare UPDATE — it is
//     resolveChargeEligibility, a single transaction that re-reads the
//     successor and its parent UNDER LOCK and refuses the claim if the
//     parent has been decided anything but undecided/'renew' (a customer
//     decline racing in after the mint), the successor is no longer
//     payment_pending, its invoice is no longer open, or today is past
//     the successor's own grace deadline — THEN claims the fence in the
//     SAME transaction. Both callers (the normal mint-then-charge tick and
//     reconcileStuckSuccessors' recovery leg, which can run hours or days
//     later) share this one function, so neither can drift from what
//     "still eligible to charge" means. An ineligible successor bells
//     staff and is never charged.
//   - Codex round-1 P1: a renewal successor carries its PARENT's
//     renewal_charge_consent_at forward at mint (a successor never signs
//     a fresh agreement — the original v3 signature's consent covers
//     every renewal under it). createTermForAnnualPrepay stamps the SAME
//     value onto the successor's own row, so a year-2 successor's later
//     year-3 mint carries it forward again — the chain, not just one hop.
//   - The Stripe-attempt fence is a single stamped column
//     (annual_prepay_terms.renewal_charge_attempted_at), set with an atomic
//     `UPDATE ... WHERE renewal_charge_attempted_at IS NULL` BEFORE the
//     Stripe call, and NEVER re-checked afterward — "never re-attempt once
//     stamped" per the assignment, deliberately simpler than the
//     claim/outcome JSONB the signature-charge lane needed (that lane has
//     to coordinate the sign webhook AND a daily sweep hitting the SAME
//     target; this job is the only writer that ever touches a given
//     successor's charge decision, and it only ever runs once per
//     successor). The actual Stripe call goes through
//     StripeService.chargeInvoiceWithSavedCard — the SAME canonical
//     invoice-charge path termite-annual-signature-charge.js uses for the
//     initial charge — which owns its OWN durable claim/idempotency-key
//     fence for the Stripe attempt itself, records the payments-table row,
//     flips the invoice paid, and calls
//     AnnualPrepayRenewals.syncTermForInvoicePayment so the successor
//     becomes 'active' through the existing payment path. Reusing it
//     instead of the raw chargeSavedPaymentMethodOffSession primitive is a
//     deliberate trade: it costs the exact `termite-renewal-<id>`
//     idempotency-key string, but buys the whole existing invoice/payment
//     ledger instead of a second, parallel one (CLAUDE.md rule 15/16).
//   - Before the fence is even stamped, a pre-quote surcharge check mirrors
//     termite-annual-signature-charge.js's own (lines ~308-323): a
//     credit-card surcharge that would push the collected total above the
//     flat renewal fee the v3 agreement quoted is not authorized by that
//     signature, so that customer gets the pay link (showing the exact
//     surcharge) instead of a silent over-collection — no failure SMS,
//     since nothing failed against Stripe. maxAuthorizedChargeCents /
//     maxAuthorizedTotalCents are both still pinned to the renewal
//     invoice's own total as the fail-closed backstop if the quote itself
//     errors.
//   - After a non-throwing Stripe call, the invoice is re-read and
//     classified exactly like the sibling's classifyVerifiedCharge (P2-3):
//     paid → done; bank ACH 'processing' → pending (the webhook activates
//     it later); a CARD 'processing' or anything else unexpected → bell as
//     ambiguous, never assumed successful.
//   - A genuine Stripe decline (err.wavesCardDecline present — the SAME
//     marker every other billing path in this repo uses to tell a real
//     processor decline apart from an internal/guard refusal) is the ONLY
//     case that queues the customer "payment didn't go through" SMS. Every
//     other refusal (Auto Pay inactive, the default method changed, a
//     different active payment in flight, an ambiguous outcome, a
//     payer-billed guard) bells staff with the reason; a payer-billed
//     guard gets no pay link either (mirrors the sibling — the homeowner's
//     card, and the homeowner's pay link, must not collect a payer's AR),
//     every other refusal still delivers the pay link so the customer can
//     still pay by hand.
//   - A crash between the attempt stamp committing and the Stripe call
//     actually firing (renewal_charge_attempted_at set, but no
//     stripe_invoice_charge_attempts row for the invoice) is caught by
//     pass 7b above rather than left as a silent, permanent gap.
// ============================================================

const db = require('../models/db');
const logger = require('./logger');
const { isCollectionHoldRefusal } = require('./collections/collection-hold');
const { etDateString, addETDays, parseETDateTime } = require('../utils/datetime-et');
const { addMonthsSameDay, dateOnlyString } = require('../utils/date-only');
const { gateEnvValue } = require('../config/feature-gates');
const { INVOICE_CANCELLED_STATUSES } = require('./annual-prepay-invoice-statuses');
const { commitPromiseOf } = require('../utils/trx-commit-promise');

const RENEWABLE_STATUSES = ['active', 'renewal_pending'];
const PAYMENT_PENDING_STATUS = 'payment_pending';
const RENEWAL_CHARGE_FAILED_SMS_KEY = 'termite_annual_renewal_charge_failed';
// One-hour crash-gap tolerance for reconcile pass 7a (below) — long enough
// that an ordinary in-flight sweep tick is never mistaken for a crash.
const RECONCILE_NEVER_ATTEMPTED_AFTER_MS = 60 * 60 * 1000;
// renewal_charge_failure_kind while a claimed charge's outcome is not yet
// known (Codex #4971 r4 P1, write-ahead) — see resolveChargeEligibility.
const CHARGE_OUTCOME_PENDING = 'outcome_pending';

function termiteAnnualRenewalChargeLive() {
  return gateEnvValue('GATE_TERMITE_ANNUAL_PLAN');
}

function addDaysYmd(value, days) {
  const parsed = parseETDateTime(`${value}T12:00`);
  return etDateString(addETDays(parsed, Number(days) || 0));
}

// The GRACE_DAYS figure and its exact date formula are owned by
// annual-prepay-renewals.js (TERMITE_RENEWAL_GRACE_DAYS /
// termiteRenewalGraceDeadlineFor) — the SAME constant coveredTermsAsOf's
// grace-coverage branch (P2-4) reads, so this file's window bound (P1-2)
// and grace-lapse cutoff can never drift from what "still covered" means.
// Required lazily (never at module-eval top level) — this file has no
// static dependency on annual-prepay-renewals.js elsewhere either, and
// every OTHER cross-module require in this file follows the same
// lazy-at-call-time convention.
function graceDays() {
  return require('./annual-prepay-renewals').TERMITE_RENEWAL_GRACE_DAYS;
}
function graceDeadlineFor(term) {
  return require('./annual-prepay-renewals').termiteRenewalGraceDeadlineFor(term);
}

// Collections DISPUTE hold (collection-hold.js, B10): while the customer's
// dispute is open the renewal is neither charged, nor sent a pay link, nor
// WITHDRAWN/lapsed for running past its grace window — the hold is the
// office's to resolve, so every hold-blocked action DEFERS (bell + rotate)
// and resumes after release. A lookup failure reads as held (fail closed).
async function collectionsDisputeHoldBlocks(conn, customerId) {
  try {
    return await require('./collections/collection-hold').customerHasActiveCollectionHold(customerId, conn);
  } catch (err) {
    logger.warn(`[termite-annual-renewal] collection-hold lookup failed for customer ${customerId} — treating as held: ${err.message}`);
    return true;
  }
}
const HOLD_DEFER_REASON = 'the customer has an active collections dispute hold (or it could not be checked)';

// The ONE "is this successor still inside its own grace window?" refusal
// (the SAME GRACE_DAYS window minting itself is bounded to, P1-2): past it,
// the renewal is the grace lapse's — never a charge, never a pay link.
// Durable: the window never reopens. Read by the charge's pre-check and
// fence claim (successorActionBlocker), its last check under the gate right
// before Stripe (chargeRefusalUnderGate — Codex #4971 r11 P1: a worker that
// claimed on the final grace day and reached the gate the next ET day), and
// every recovery leg (successorRecoveryRefusal). null = still inside.
function graceWindowRefusal(term) {
  const deadline = graceDeadlineFor(term);
  if (deadline && etDateString() > deadline) return { reason: 'past_grace_deadline', retire: true, lapseOwnsPresented: true };
  return null;
}

// Codex round-6 P1: ONE column PER KIND (20260926050001 — 050000's shared
// renewal_exception_belled_at/renewal_exception_kind pair is left in place,
// unused, since 050000 is already pushed/frozen). The three exception-bell
// scans' WHERE clauses partition the SAME term into at most one kind at any
// given moment — but a term's underlying facts can change OVER TIME (staff
// sends the missing notice, then it later goes stale-overdue; staff anchors
// the installation, then it later goes stale-overdue) and move it into a
// DIFFERENT kind's bucket. A single shared exclusion column can't tell "already
// belled for kind A, never checked for kind B" apart from "already belled for
// THIS kind" — it would silently and permanently exclude the term from every
// OTHER kind's scan too, the instant any one kind belled it once. Scoping
// exclusion per kind means a term already belled for A remains fully
// eligible to be scanned and belled for B once it comes to match B.
// Stamped once a term's exception bell has actually been asked for, whether
// it fired fresh or deduped from a prior tick (either way staff has already
// been told). Each scan excludes on its OWN column directly in SQL, so once
// more than one scan's LIMIT worth of terms sit in the SAME exception
// bucket, the oldest ones stop consuming every tick's LIMIT slot and a
// newer term past that backlog still gets scanned and belled. Never affects
// a term's eligibility for minting/charging once its underlying condition
// is actually fixed — only these three scans read these columns. Written
// with three literal-key branches (never a computed `[column]:` key) —
// annual-prepay-term-states.test.js's write-site scanner fails closed on
// any computed identifier key on this table in case it disguises a dynamic
// status write, and none of these three kinds needs one to stay a single
// shared function.
async function stampRenewalExceptionBelled(term, kind, conn = db) {
  try {
    if (kind === 'no_witness') {
      await conn('annual_prepay_terms').where({ id: term.id })
        .whereNull('renewal_no_witness_belled_at').update({ renewal_no_witness_belled_at: new Date() });
    } else if (kind === 'unanchored') {
      await conn('annual_prepay_terms').where({ id: term.id })
        .whereNull('renewal_unanchored_belled_at').update({ renewal_unanchored_belled_at: new Date() });
    } else if (kind === 'stale_overdue') {
      await conn('annual_prepay_terms').where({ id: term.id })
        .whereNull('renewal_stale_overdue_belled_at').update({ renewal_stale_overdue_belled_at: new Date() });
    } else {
      throw new Error(`unknown exception-bell kind: ${kind}`);
    }
  } catch (err) {
    logger.error(`[termite-annual-renewal] failed to stamp the exception-bell column for term ${term.id} (${kind}): ${err.message}`);
  }
}

// ---- chokepoint A: renewal payment evidence ----------------------------
//
// Codex #4971 round-3 (items 3, 6, 7): every question this sweep asks about
// an invoice's money — "is the parent's year still paid?", "is the
// successor's invoice still open to charge?", "did the renewal ever reach
// the customer?", "did a charge attempt ever reach Stripe?", "is the
// renewal settled, or still clearing?" — is answered HERE, once, in two
// agreeing forms: a pure/JS read for the per-row decisions, and a SQL twin
// for the bounded scans (so a scan can never select a row the per-row check
// then classifies differently). Earlier rounds re-derived these per call
// site, and each round found another site that had drifted.
//
//   paid evidence   status paid/prepaid, or paid_at set
//   settled         paid evidence, NOT a cancelled/void/refunded status, and
//                   NO revoked payment on the payments ledger against the
//                   invoice's Stripe identity — a full refund, or (Codex
//                   #4971 r11 P1) a payment in DISPUTE, lands there before,
//                   or without, any status sync: the dispute webhook stamps
//                   payments.status 'disputed' in one transaction and
//                   reopens the invoice in a later one, so a paid-looking
//                   invoice behind a disputed payment is not settled. A
//                   refund is durable; a dispute can still be won (the won
//                   closure restores the row to 'paid').
//   processing      an ACH debit still clearing — neither paid nor unpaid
//   delivered       PERSISTED delivery evidence only: a sent_at /
//                   sms_sent_at / email_sent_at stamp, which the send path
//                   writes the moment a provider ACCEPTS the message
//                   (invoice.js alreadyDeliveredForFirstSend reads the same
//                   stamps). Never the status alone (Codex #4971 pre-push
//                   P1): 'scheduled' has not been sent yet, 'sending' is a
//                   claim that may have crashed before any provider call,
//                   and processScheduledSends parks a stale 'sending' claim
//                   back as 'scheduled' either way — reading those as
//                   delivered stopped the delivery retry and let the grace
//                   lapse void the renewal and pull stations against a
//                   customer who was never told.
//   reached Stripe  a stripe_invoice_charge_attempts row WITH durable
//                   submission evidence (submitted_at, or a PaymentIntent
//                   id). The attempt row itself is committed BEFORE the
//                   provider call (stripe.js's claim), so bare row existence
//                   proves nothing — a crash, or a guard refusal, between
//                   the claim and the submission leaves an unsubmitted row
//                   (stripe.js's own savedCardClaimWasSubmitted test).

const PAID_INVOICE_STATUSES = ['paid', 'prepaid'];
const INVOICE_EVIDENCE_COLUMNS = [
  'status', 'paid_at', 'sent_at', 'sms_sent_at', 'email_sent_at', 'stripe_payment_intent_id', 'stripe_charge_id',
  // Codex #4971 r15 P1: a NET-terms statement child carries no Stripe ids of
  // its own (the statement is charged, never the invoice) — durability of a
  // reopened one is read off the STATEMENT's own payments row instead (see
  // statementRevocationForInvoice), keyed by this column.
  'payer_statement_id',
];

function classifyRenewalInvoice(invoice) {
  if (!invoice) return { exists: false };
  const status = invoice.status == null ? null : String(invoice.status).toLowerCase();
  return {
    exists: true,
    status,
    cancelled: INVOICE_CANCELLED_STATUSES.has(status),
    paidEvidence: PAID_INVOICE_STATUSES.includes(status) || Boolean(invoice.paid_at),
    processing: status === 'processing',
    delivered: Boolean(invoice.sent_at || invoice.sms_sent_at || invoice.email_sent_at),
  };
}

// The payments-ledger revocation of an invoice's payment: 'refunded' (a full
// refund — durable), 'disputed' (a payment in dispute — transient, a won
// dispute restores it), or null. The SQL twin is REVOKED_PAYMENT_SQL.
async function invoiceLedgerRevocation(conn, invoice) {
  const revoked = await conn('payments')
    .whereRaw(
      `(status in ('refunded', 'disputed') or refund_status = 'full')
       and (
         (stripe_payment_intent_id is not null and stripe_payment_intent_id = ?)
         or (stripe_charge_id is not null and stripe_charge_id = ?)
       )`,
      [invoice.stripe_payment_intent_id || null, invoice.stripe_charge_id || null],
    )
    .first('id', 'status', 'refund_status');
  if (!revoked) return null;
  return revoked.status === 'disputed' && revoked.refund_status !== 'full' ? 'disputed' : 'refunded';
}

// Codex #4971 r15 P1: a NET-terms statement child invoice is never itself
// charged — the STATEMENT is (invoice.stripe_payment_intent_id/
// stripe_charge_id are null on it) — so a chargeback/refund cascade
// (routes/stripe-webhook.js reverseStatementCascadeForDispute) reopens the
// child as draft with paid_at cleared and leaves no row invoiceLedgerRevocation
// can find keyed to the INVOICE's own (absent) Stripe ids. The durable
// signal instead lives on the STATEMENT's own payments row (statement_id,
// the same row the cascade itself updates/inserts). Same vocabulary as
// invoiceLedgerRevocation: 'refunded' = durable, 'disputed' = transient
// (an OPEN dispute can still be won), null = no statement-level revocation
// found (the invoice may simply be legitimately unpaid/not yet billed).
// A dispute the webhook has already CLOSED lost (payments.status stays
// 'disputed' forever per its own comment — 'failed' would risk a late
// succeeded resurrecting it — with metadata.dispute_final:'lost' the one
// durable marker) is money gone for good — durable, same as a refund.
async function statementRevocationForInvoice(conn, invoice) {
  if (!invoice?.payer_statement_id) return null;
  // The statement's LATEST payment row, whatever its status (Codex #4971
  // r29 P1): a restored or replacement-paid statement writes a newer paid
  // row, which reads as "no revocation" — only a latest row that is itself
  // revoked counts.
  const latest = await conn('payments')
    .where('statement_id', invoice.payer_statement_id)
    .orderBy('updated_at', 'desc')
    .first('id', 'status', 'refund_status', 'metadata');
  if (!latest) return null;
  const revoked = ['refunded', 'disputed'].includes(String(latest.status || '').toLowerCase()) || latest.refund_status === 'full'
    ? latest
    : null;
  if (!revoked) return null;
  if (revoked.status !== 'disputed' || revoked.refund_status === 'full') return 'refunded';
  let meta = {};
  try {
    meta = revoked.metadata ? (typeof revoked.metadata === 'string' ? JSON.parse(revoked.metadata) : revoked.metadata) : {};
  } catch { meta = {}; }
  return meta.dispute_final === 'lost' ? 'refunded' : 'disputed';
}

// A payments row (aliased) that revokes its invoice's payment — the SQL twin
// of invoiceLedgerRevocation, read by whereInvoiceSettledNotRevoked and
// parentChangedAtSql.
const revokedPaymentSql = (rp) => `(${rp}.status in ('refunded', 'disputed') or ${rp}.refund_status = 'full')`;

// JS form of "settled" (see the table above). SQL twin:
// whereInvoiceSettledNotRevoked, below.
async function invoiceSettledNotRevoked(conn, invoice) {
  const evidence = classifyRenewalInvoice(invoice);
  if (!evidence.paidEvidence || evidence.cancelled) return false;
  return !(await invoiceLedgerRevocation(conn, invoice));
}

function whereInvoiceSettledNotRevoked(builder, alias) {
  const cancelled = [...INVOICE_CANCELLED_STATUSES];
  const col = (name) => `${alias}.${name}`;
  return builder
    .where(function paidEvidence() {
      this.whereRaw(`lower(??) in (${PAID_INVOICE_STATUSES.map(() => '?').join(', ')})`, [col('status'), ...PAID_INVOICE_STATUSES])
        .orWhereNotNull(col('paid_at'));
    })
    .whereRaw(`lower(coalesce(??, '')) not in (${cancelled.map(() => '?').join(', ')})`, [col('status'), ...cancelled])
    .whereNotExists(function noFullRefund() {
      this.select(1).from('payments as rp')
        .whereRaw(revokedPaymentSql('rp'))
        .whereRaw(
          '((rp.stripe_payment_intent_id is not null and rp.stripe_payment_intent_id = ??) or (rp.stripe_charge_id is not null and rp.stripe_charge_id = ??))',
          [col('stripe_payment_intent_id'), col('stripe_charge_id')],
        );
    });
}

// SQL form of "delivered". JS twin: classifyRenewalInvoice(...).delivered.
function whereInvoiceDelivered(builder, alias) {
  return builder.where(function delivered() {
    this.whereNotNull(`${alias}.sent_at`)
      .orWhereNotNull(`${alias}.sms_sent_at`)
      .orWhereNotNull(`${alias}.email_sent_at`);
  });
}

// SQL form of "reached Stripe": narrows a stripe_invoice_charge_attempts
// query (aliased `a`) to attempts with durable submission evidence. The
// grace-lapse "presented" scan (EXISTS), leg 7b (NOT EXISTS) and the JS
// renewalWasPresented read all go through this ONE definition, so the two
// scans can never be each other's imperfect inverse again (items 6/7).
function whereAttemptSubmitted(attempts) {
  return attempts.where(function submissionEvidence() {
    this.whereNotNull('a.submitted_at').orWhereNotNull('a.stripe_payment_intent_id');
  });
}

// SQL form of "the customer was PRESENTED with the charge" — the stricter
// twin of whereAttemptSubmitted, read by the grace-lapse scan
// (processGraceLapses) and renewalWasPresented. Codex #4971 r21 P1: the
// submission marker (submitted_at) is committed immediately BEFORE the
// Stripe call (stripe.js commitInvoiceSavedCardChargeSubmission — the
// fail-closed boundary that makes "money may be in motion" conservative),
// so a process death between that commit and the SDK call leaves
// submitted_at set although no request ever reached Stripe: recovery
// (leg 7d) rightly records that shape as ambiguous and bells staff only —
// no pay link, no notice — so the customer has seen NOTHING, and lapsing
// coverage / requesting station retrieval on it is wrong. Presentation
// therefore needs PROVIDER-derived evidence: a PaymentIntent id on the
// attempt (stripe.js stamps it from the create call's result or its error,
// and the webhook path keys it by idempotency_key), which only exists once
// Stripe actually processed the request. submitted_at alone keeps its
// "may have reached Stripe" meaning everywhere else (7b/7d ownership,
// the withdrawal / void guards) — that direction must stay conservative.
// A submitted-only ambiguous attempt is thus held out of the lapse scan
// until staff reconcile it in Stripe (the ambiguous bell already asks for
// exactly that): a PI turns up → presented; none → the attempt resolves
// as never reached and the pay-link fallback delivers.
function whereAttemptPresented(attempts) {
  // Same chain shape as whereAttemptSubmitted (where → callback), so every
  // query-builder stub built for that predicate answers this one too.
  return attempts.where(function providerEvidence() {
    this.whereNotNull('a.stripe_payment_intent_id');
  });
}

// Kept for its callers and tests: the parent's year is still paid (settled,
// above). Vacuously true with no linked invoice at all (a legacy manual
// term — historically covered, matching coveredTermsAsOf's carve-out).
async function parentInvoicePaidAndNotFullyRefunded(trx, invoiceId) {
  if (!invoiceId) return true;
  const invoice = await trx('invoices').where({ id: invoiceId }).first(...INVOICE_EVIDENCE_COLUMNS);
  if (!invoice) return true;
  return invoiceSettledNotRevoked(trx, invoice);
}

// "The successor's own payment backs this renewal" — the ONE definition
// (Codex #4971 r8 / pre-push P1), read by the parent 'renewed' stamp
// (annual-prepay-renewals.js recordParentRenewedIfEligible and its
// reconcileParentRenewedStamps backstop) and by the late-paid alert (the
// paid hook onRenewalSuccessorPaid, bellLatePaidRenewalUnderGate, leg 7e's
// scan). Two halves:
//   - the shape: live (active / renewal_pending), or the PAID decided-lapse
//     shape — move 15: a pending successor whose NEXT renewal the customer
//     declined, then paid, settles to 'cancelled' + renewal_decision
//     'cancel'. That payment still proves THIS renewal was bought;
//   - its own renewal invoice settled and not revoked (chokepoint A). A
//     voided / refunded decided cancel has the same status and decision, so
//     the invoice is what tells them apart — never the shape alone. Strict,
//     unlike the parent's vacuous "no invoice = covered": no linked invoice,
//     or a missing invoice row, is no evidence at all.
// A dispute suspension demotes the successor to payment_pending and reopens
// its invoice, so both halves refuse it. The dispute marker ALONE is not a
// refusal: on a live row it is the won / re-paid recovery shape, cleared by
// finishDisputeRecoveryForTerm after the paid sync's stamp, by design.
function successorShapeBacksRenewal(term) {
  return RENEWABLE_STATUSES.includes(term.status) || (term.status === 'cancelled' && term.renewal_decision === 'cancel');
}

async function successorPaymentBacksRenewal(conn, successor) {
  if (!successor || !successorShapeBacksRenewal(successor) || !successor.prepay_invoice_id) return false;
  const invoice = await conn('invoices').where({ id: successor.prepay_invoice_id }).first(...INVOICE_EVIDENCE_COLUMNS);
  return Boolean(invoice) && invoiceSettledNotRevoked(conn, invoice);
}

// SQL twin: `term` is the successor's alias, `invoice` its prepay invoice
// (an inner join on prepay_invoice_id — no invoice, no row).
function whereSuccessorPaymentBacksRenewal(builder, term, invoice) {
  builder.where(function successorShape() {
    this.whereIn(`${term}.status`, RENEWABLE_STATUSES).orWhere(function paidDecidedLapse() {
      this.where(`${term}.status`, 'cancelled').where(`${term}.renewal_decision`, 'cancel');
    });
  });
  return whereInvoiceSettledNotRevoked(builder, invoice);
}

// Codex round-4 P0 (round-7 P1: extended to the active/renewal_pending
// branch too): an ALLOW-list, never a deny-list, for whether a PARENT term
// is still in a state that authorizes minting a successor against it, or
// charging one already minted. "Eligible" is exactly: still undecided and
// live (RENEWABLE_STATUSES), or already decided 'renewed' with
// renewal_decision === 'renew' — EITHER WAY, a linked invoice must still be
// settled (chokepoint A). Everything else is refused: 'cancelled' in either
// shape (moves 9 and 13 leave renewal_decision NULL), legacy
// 'canceled'/'refunded', 'payment_pending' (move 10), 'switch_plan', or no
// parent row at all.
//
// Codex #4971 round-3 P1 (item 1): a refusal also says whether it is
// DURABLE. Only one shape can still come back on its own: a dispute on the
// parent's OWN invoice (move 10 demotes it to payment_pending with no
// decision, and reopens the invoice unpaid) — a won dispute restores it.
// Every other refusal (a decision, a cancel/void/refund, a switch, a
// missing row, a revoked invoice) never un-happens, and the caller must
// then terminalize the successor rather than leave it pending.
async function resolveParentEligibility(trx, parent) {
  if (!parent) return { eligible: false, reason: 'parent_missing', durable: true };
  const statusOk = RENEWABLE_STATUSES.includes(parent.status)
    || (parent.status === 'renewed' && parent.renewal_decision === 'renew');
  if (!statusOk) {
    const reason = parent.renewal_decision ? `parent_decided_${parent.renewal_decision}` : `parent_status_${parent.status}`;
    return { eligible: false, reason, durable: Boolean(parent.renewal_decision) || parent.status !== PAYMENT_PENDING_STATUS };
  }
  if (!parent.prepay_invoice_id) return { eligible: true };
  const invoice = await trx('invoices').where({ id: parent.prepay_invoice_id }).first(...INVOICE_EVIDENCE_COLUMNS);
  if (!invoice) return { eligible: true };
  // The settled test (invoiceSettledNotRevoked), unrolled to keep WHICH
  // ledger revocation it found. Paid evidence that is nonetheless not
  // settled = revoked (a cancelled/refunded status or a full ledger refund) —
  // durable. No paid evidence at all = unpaid, which on a live parent means a
  // reopened (disputed) invoice — not durable; and (Codex #4971 r11 P1) a
  // paid-looking invoice whose payment is in DISPUTE on the ledger (the
  // webhook's first phase, before the invoice reopens) is not durable either
  // — the dispute can still be won.
  const evidence = classifyRenewalInvoice(invoice);
  const payable = evidence.paidEvidence && !evidence.cancelled;
  const revocation = payable ? await invoiceLedgerRevocation(trx, invoice) : null;
  if (payable && !revocation) {
    // Codex #4971 r29 P1: a NET-terms statement child carries no Stripe ids
    // of its own, so the ledger arm above finds nothing for it — and
    // dispute.closed(lost) commits the statement payment's 'disputed' row
    // BEFORE it reopens the children, so a crash between the two leaves
    // this invoice paid-looking over permanently lost statement money.
    // The statement's own latest payment row is the authority; a later
    // genuinely restored / replacement-paid row reads as no revocation.
    if (invoice.payer_statement_id) {
      const statementRevocation = await statementRevocationForInvoice(trx, invoice);
      if (statementRevocation === 'disputed') return { eligible: false, reason: 'parent_payment_disputed', durable: false };
      if (statementRevocation === 'refunded') return { eligible: false, reason: 'parent_invoice_unpaid_or_refunded', durable: true };
    }
    return { eligible: true };
  }
  if (revocation === 'disputed') return { eligible: false, reason: 'parent_payment_disputed', durable: false };
  // Codex #4971 r15 P1: a statement-cascade reversal (reverseStatementCascadeForDispute)
  // reopens this invoice DIRECTLY as draft/paid_at-null — no ledger row keyed
  // to the invoice's own (absent, for a statement child) Stripe ids exists,
  // so `payable` above is already false and invoiceLedgerRevocation was
  // never even asked. Check the STATEMENT's own durable signal before
  // falling back to inferring durability from draft alone.
  if (!payable && invoice.payer_statement_id) {
    const statementRevocation = await statementRevocationForInvoice(trx, invoice);
    if (statementRevocation === 'disputed') return { eligible: false, reason: 'parent_payment_disputed', durable: false };
    if (statementRevocation === 'refunded') return { eligible: false, reason: 'parent_invoice_unpaid_or_refunded', durable: true };
  }
  return { eligible: false, reason: 'parent_invoice_unpaid_or_refunded', durable: evidence.cancelled || evidence.paidEvidence };
}

// Does this PARENT still authorize THIS successor — the one question every
// successor action asks (the pre-check and fence claim through
// successorActionBlocker, the re-check under withParentDecisionLock right
// before Stripe, leg 7b's recovery). resolveParentEligibility's allow-list,
// plus (Codex #4971 pre-push P0, same shape as the mint's locked re-check)
// the renewal must still be the one this successor was minted for: its
// window starts the day after the parent's term_end. A parent term_end
// moved since the mint means the renewal is no longer due as minted —
// durable, so the unpresented successor is withdrawn, never charged.
async function parentRefusalForSuccessor(conn, successor, parent) {
  const eligibility = await resolveParentEligibility(conn, parent);
  if (!eligibility.eligible) return eligibility;
  if (successor.term_start && parent.term_end
    && dateOnlyString(successor.term_start) !== addDaysYmd(dateOnlyString(parent.term_end), 1)) {
    return { eligible: false, reason: 'parent_term_moved', durable: true };
  }
  return { eligible: true };
}

// ---- shared queries ---------------------------------------------------

// A termite annual term due for its renewal transition: stamped with the
// annual-plan version (the marker every termite-annual codepath gates on —
// a non-termite annual-prepay term never carries it), still in a live
// (undecided) status, term_end already reached, and — the DB-level
// idempotency anchor — no successor minted for it yet.
function whereDueForRenewal(query, today) {
  return query
    .whereNotNull('t.annual_plan_version')
    .whereIn('t.status', RENEWABLE_STATUSES)
    .whereNull('t.renewal_decision')
    .where('t.term_end', '<=', today)
    .whereNotExists(function successorExists() {
      this.select(1).from('annual_prepay_terms as s').whereRaw('s.renewed_from_term_id = t.id');
    })
    .whereExists(function customerLive() {
      this.select(1).from('customers as c').whereRaw('c.id = t.customer_id').whereNull('c.deleted_at');
    });
}

// P1-4: the renewal-notice witness is ONLY the termite-specific, ON-TIME
// 45-day rung (slice A2) — the v3 agreement's auto-charge authorization
// presumes the customer got THAT notice. The generic notice_30_sent_at rung
// every annual-prepay term (termite or not) already carries is deliberately
// NOT an accepted alternative, and neither is a LATE 45-day send: PR #4921
// (slice 5, sendCustomerTermNotice / noticeWitnessColumn in
// annual-prepay-renewals.js) writes EXACTLY ONE of notice_45_sent_at
// (daysLeft >= 45, on-time) or notice_45_late_sent_at (daysLeft < 45,
// late) per send — never both. A late send therefore leaves
// notice_45_sent_at NULL by construction and must fall into
// bellNoWitnessTerms below for staff to handle by hand, not slip through
// as if the on-time authorization had been given.
function whereNoticeWitnessed(query) {
  return query.whereNotNull('t.notice_45_sent_at');
}

// P2-5: an ORIGINAL term (renewed_from_term_id IS NULL — never renewed
// before) must have had its real-world installation anchored
// (installation_anchored_at IS NOT NULL, termite-annual-activation.js's
// anchorTermToInstallation) before it can auto-renew — an uninstalled plan
// has no station program to keep running. A SUCCESSOR term is anchored by
// construction: its own dates are derived from the parent's already-
// anchored window, so it never needs installation_anchored_at set on
// itself.
function whereAnchoredOrSuccessor(query) {
  return query.where(function anchoredOrSuccessor() {
    this.whereNotNull('t.renewed_from_term_id').orWhereNotNull('t.installation_anchored_at');
  });
}

// P1-2: only auto-mint/charge a term whose renewal date is still within the
// grace window — a term overdue by more than GRACE_DAYS goes to
// bellStaleOverdueTerms instead, never a silent, months-late charge.
function whereWithinRenewalWindow(query, today) {
  return query.where('t.term_end', '>=', addDaysYmd(today, -graceDays()));
}

// Codex #4971 pre-push P0: THE "this term is due for its automatic renewal"
// predicate — due (term_end reached, live, undecided, no successor, customer
// not deleted), on-time 45-day notice witnessed, installation-anchored (or
// itself a successor), and still inside the renewal window. The candidate
// scan selects on it AND the mint re-checks it against the LOCKED parent
// row (parentStillDueForRenewal): staff extending the parent's term_end, or
// anything else changing these facts between the scan and the lock, must
// stop the mint — a renewal minted with the new, future dates would
// otherwise be charged immediately.
function whereRenewalCandidate(query, today) {
  return whereWithinRenewalWindow(whereAnchoredOrSuccessor(whereNoticeWitnessed(whereDueForRenewal(query, today))), today);
}

async function parentStillDueForRenewal(trx, parentId, today) {
  return Boolean(await whereRenewalCandidate(trx('annual_prepay_terms as t'), today).where('t.id', parentId).first('t.id'));
}

// ---- pass 1: no-witness exception bell ---------------------------------

async function bellNoWitnessTerms({ conn = db, limit = 200, today = etDateString(), counts }) {
  try {
    const rows = await whereDueForRenewal(
      conn('annual_prepay_terms as t'),
      today,
    )
      .whereNull('t.notice_45_sent_at')
      // Codex round-5/6 P1: excluded here, not just deduped at bell time —
      // see stampRenewalExceptionBelled's own doc. This kind's OWN column.
      .whereNull('t.renewal_no_witness_belled_at')
      .orderBy('t.term_end', 'asc')
      .select('t.*')
      .limit(limit);
    counts.noWitnessScanned = rows.length;
    const NotificationService = require('./notification-service');
    for (const term of rows) {
      try {
        const result = await NotificationService.notifyAdmin(
          'billing',
          'Termite annual renewal due — no on-time renewal notice on file',
          `The termite annual plan for customer ${term.customer_id} (term ${term.id}) reached its renewal date (${dateOnlyString(term.term_end)}) but was never sent its on-time 45-day renewal notice. The v3 agreement's auto-charge authorization presumes the customer was warned, so this renewal will NOT be auto-charged — staff must handle it by hand from the customer's Annual Prepay panel (send the notice, then renew/cancel).`,
          {
            icon: '⚠️',
            bell: true,
            link: `/admin/customers?customerId=${encodeURIComponent(term.customer_id)}`,
            // No dedupeWindowMs: this rings exactly once ever per term — a
            // fixed exception, not a recurring nag (the task's own words:
            // "bell staff once").
            dedupeKey: `termite-renewal-no-witness:${term.id}`,
            metadata: { termId: term.id, customerId: term.customer_id },
          },
        );
        if (result && !result.deduped && !result.suppressed) counts.noWitnessBelled += 1;
        // Codex #4971 post-push audit round-2 P1: notifyAdmin returns null
        // on a persistence failure (its own dedupe transaction threw and
        // was swallowed) — stamping unconditionally would then read a
        // never-delivered bell as "handled" and permanently drop this term
        // from every future scan. Stamp only on a truthy result: either a
        // fresh row actually persisted, or a genuine dedupe hit (staff was
        // already told on an earlier tick) — never on a bare failure.
        if (result) await stampRenewalExceptionBelled(term, 'no_witness', conn);
      } catch (err) {
        logger.error(`[termite-annual-renewal] no-witness bell failed for term ${term.id}: ${err.message}`);
      }
    }
  } catch (err) {
    logger.error(`[termite-annual-renewal] no-witness scan failed: ${err.message}`);
  }
}

// ---- pass 2: unanchored-original exception bell (P2-5) -----------------

async function bellUnanchoredOriginalTerms({ conn = db, limit = 200, today = etDateString(), counts }) {
  try {
    const rows = await whereNoticeWitnessed(whereDueForRenewal(conn('annual_prepay_terms as t'), today))
      .whereNull('t.renewed_from_term_id')
      .whereNull('t.installation_anchored_at')
      .whereNull('t.renewal_unanchored_belled_at')
      .orderBy('t.term_end', 'asc')
      .select('t.*')
      .limit(limit);
    counts.unanchoredScanned = rows.length;
    const NotificationService = require('./notification-service');
    for (const term of rows) {
      try {
        const result = await NotificationService.notifyAdmin(
          'billing',
          'Termite annual renewal due — plan never anchored to an installation',
          `The termite annual plan for customer ${term.customer_id} (term ${term.id}) reached its renewal date (${dateOnlyString(term.term_end)}) but was never anchored to a completed installation visit. This renewal will NOT be auto-charged — confirm the installation and anchor the plan, or renew/cancel it by hand from the customer's Annual Prepay panel.`,
          {
            icon: '⚠️',
            bell: true,
            link: `/admin/customers?customerId=${encodeURIComponent(term.customer_id)}`,
            dedupeKey: `termite-renewal-unanchored:${term.id}`,
            metadata: { termId: term.id, customerId: term.customer_id },
          },
        );
        if (result && !result.deduped && !result.suppressed) counts.unanchoredBelled += 1;
        // Codex #4971 post-push audit round-2 P1: see the SAME fix's own
        // comment in bellNoWitnessTerms above — stamp only on a truthy
        // result, never on notifyAdmin's null (a persistence failure).
        if (result) await stampRenewalExceptionBelled(term, 'unanchored', conn);
      } catch (err) {
        logger.error(`[termite-annual-renewal] unanchored bell failed for term ${term.id}: ${err.message}`);
      }
    }
  } catch (err) {
    logger.error(`[termite-annual-renewal] unanchored scan failed: ${err.message}`);
  }
}

// ---- pass 3: stale-overdue exception bell (P1-2) ------------------------

async function bellStaleOverdueTerms({ conn = db, limit = 200, today = etDateString(), counts }) {
  try {
    const cutoff = addDaysYmd(today, -graceDays());
    const rows = await whereAnchoredOrSuccessor(whereNoticeWitnessed(whereDueForRenewal(conn('annual_prepay_terms as t'), today)))
      .where('t.term_end', '<', cutoff)
      .whereNull('t.renewal_stale_overdue_belled_at')
      .orderBy('t.term_end', 'asc')
      .select('t.*')
      .limit(limit);
    counts.staleOverdueScanned = rows.length;
    const NotificationService = require('./notification-service');
    for (const term of rows) {
      try {
        const result = await NotificationService.notifyAdmin(
          'billing',
          'Termite annual renewal — too overdue to auto-charge',
          `The termite annual plan for customer ${term.customer_id} (term ${term.id}) reached its renewal date (${dateOnlyString(term.term_end)}) more than ${graceDays()} days ago. Auto-charging a renewal this late risks a surprise, months-late bill, so it will NOT be minted or charged automatically — renew or cancel it by hand from the customer's Annual Prepay panel.`,
          {
            icon: '⚠️',
            bell: true,
            link: `/admin/customers?customerId=${encodeURIComponent(term.customer_id)}`,
            dedupeKey: `termite-renewal-stale-overdue:${term.id}`,
            metadata: { termId: term.id, customerId: term.customer_id },
          },
        );
        if (result && !result.deduped && !result.suppressed) counts.staleOverdueBelled += 1;
        // Codex #4971 post-push audit round-2 P1: see the SAME fix's own
        // comment in bellNoWitnessTerms above — stamp only on a truthy
        // result, never on notifyAdmin's null (a persistence failure).
        if (result) await stampRenewalExceptionBelled(term, 'stale_overdue', conn);
      } catch (err) {
        logger.error(`[termite-annual-renewal] stale-overdue bell failed for term ${term.id}: ${err.message}`);
      }
    }
  } catch (err) {
    logger.error(`[termite-annual-renewal] stale-overdue scan failed: ${err.message}`);
  }
}

// ---- pass 4: mint + charge ----------------------------------------------

// Mints the renewal successor (term + its renewal invoice) under a lock on
// the PARENT row, so two concurrent sweep ticks (or a retried tick) can
// only ever mint ONE successor per parent — the loser blocks on the lock,
// then finds the successor the winner already committed and no-ops.
// Returns { successor, minted: true } on a fresh mint, { successor,
// minted: false } when a successor already existed (this call did
// nothing), or null when the parent no longer qualifies under lock (a
// concurrent decision/cancel landed first).
// Self-contained sub-decisions extracted from mintRenewalSuccessor below
// (Codex round-7 P2 self-review, AGENTS.md L412-418) — each is a
// genuinely independent question, not a one-use wrapper relocating a
// single branch.
//
// Mint only ever fires for a still-undecided parent (P2-1) — checked
// FIRST, so resolveParentEligibility's 'renewed'+'renew' branch can never
// apply here; only its plain RENEWABLE_STATUSES branch matters. Codex
// round-4 P0: reuses the SAME allow-list resolveChargeEligibility's parent
// re-check uses below — a cancelled/canceled/refunded/payment_pending/
// switch_plan parent (moves 9, 10, 13) can never mint a successor either
// way. Codex round-7 P1: the paid-and-not-fully-refunded ledger check now
// runs here too (not just at charge time) — a full refund that outraced
// the parent's own status sync must never mint a renewal against it.
async function parentEligibleToMintSuccessor(trx, parent, today) {
  if (!(await parentStillDueForRenewal(trx, parent.id, today))) return false;
  return (await resolveParentEligibility(trx, parent)).eligible;
}

function assertValidPrepayAmount(parent) {
  const prepayAmount = Number(parent.prepay_amount);
  if (!Number.isFinite(prepayAmount) || prepayAmount <= 0) {
    throw new Error(`parent term ${parent.id} has no valid prepay_amount to renew (${parent.prepay_amount})`);
  }
  return prepayAmount;
}

// Frozen-price enforcement, mirroring the original activation's own guard
// (estimate-converter.js): the minted invoice must equal the quoted
// renewal fee to the cent, with no tax picked up.
function assertInvoiceMatchesQuotedRenewalFee(invoice, prepayAmount, parentId) {
  const mintedTotalCents = Math.round(Number(invoice.total) * 100);
  const expectedCents = Math.round(prepayAmount * 100);
  if (mintedTotalCents !== expectedCents || Math.round(Number(invoice.tax_amount || 0) * 100) !== 0) {
    throw new Error(`renewal invoice for term ${parentId} does not match the quoted renewal fee (total ${invoice.total} vs ${prepayAmount}, tax ${invoice.tax_amount})`);
  }
}

async function mintRenewalSuccessor(parentTermId, conn = db, today = etDateString()) {
  const InvoiceService = require('./invoice');
  const AnnualPrepayRenewals = require('./annual-prepay-renewals');
  // P1-1 fix: this lives on admin-customers.js's `_private` export, not on
  // the router's root export (see termite-annual-activation.js:884's
  // anchorTermToInstallation for the same import).
  const { lockAndAssertNoAnnualPrepayOverlap } = require('../routes/admin-customers')._private;

  // Codex #4971 r16 P1 (finding 4): the SAME parent-decision gate every
  // other renewal action holds (withRenewalGate) — taken here, BEFORE this
  // mint ever reads the customer's liveness (parentEligibleToMintSuccessor
  // -> parentStillDueForRenewal -> whereDueForRenewal's own unlocked
  // customerLive check), so it serializes against withCustomerDeletionGate,
  // which takes this exact key for every one of the customer's renewable
  // termite parent terms. Without this, a mint reading "customer live" and
  // a concurrent account deletion had no lock in common at all — the mint
  // could read live, then the deletion could commit deleted_at, and the
  // mint would still finish and go on to charge or pay-link a deleted
  // account's successor. Now either the deletion wins the gate first (this
  // mint's own re-check then sees deleted_at set and refuses), or this mint
  // wins it first and the deletion waits behind the whole mint.
  return AnnualPrepayRenewals.withParentDecisionLock(parentTermId, () => mintRenewalSuccessorUnderGate(
    parentTermId, conn, today, InvoiceService, AnnualPrepayRenewals, lockAndAssertNoAnnualPrepayOverlap,
  ));
}

async function mintRenewalSuccessorUnderGate(
  parentTermId, conn, today, InvoiceService, AnnualPrepayRenewals, lockAndAssertNoAnnualPrepayOverlap,
) {
  return conn.transaction(async (trx) => {
    // P2-2: lock order now matches anchorTermToInstallation and every
    // Customer-360 term writer (admin-customers.js) — an UNLOCKED peek of
    // the parent's customer_id first, THEN the per-customer advisory lock,
    // THEN the parent row FOR UPDATE, THEN the rechecks and the overlap
    // assert. Taking the parent row lock before the customer-level
    // advisory lock (the old order) inverted lock order against every
    // other annual-prepay writer and could deadlock a concurrent admin
    // action against this sweep.
    const peek = await trx('annual_prepay_terms').where({ id: parentTermId }).first('customer_id');
    if (!peek) return null;
    // Lock only (allowOverlap=true) — termStart isn't known yet (it is
    // derived from the parent's own term_end, read under the row lock
    // next); the real overlap assert runs below once it is.
    await lockAndAssertNoAnnualPrepayOverlap(trx, peek.customer_id, null, true, '');

    const parent = await trx('annual_prepay_terms').where({ id: parentTermId }).forUpdate().first();
    if (!parent) return null;
    const existingSuccessor = await trx('annual_prepay_terms').where({ renewed_from_term_id: parent.id }).first();
    if (existingSuccessor) return { successor: existingSuccessor, minted: false };
    if (!(await parentEligibleToMintSuccessor(trx, parent, today))) return null;

    // term_end is INCLUSIVE (annual-prepay-renewals.js ~2640) — the
    // successor's coverage starts the very next day, or admin-customers.js's
    // overlap guard (start > previous end) would refuse it as overlapping
    // its own parent.
    const termStart = addDaysYmd(dateOnlyString(parent.term_end), 1);
    const termEnd = addMonthsSameDay(termStart, 12);

    // The overlap assert proper, now that termStart is known — reuses the
    // SAME per-customer lock already held above (pg_advisory_xact_lock is
    // reentrant within one transaction). This only guards against a THIRD
    // party's term: the successor's dates are fully determined by the
    // immutable parent, so it can never itself conflict with the parent
    // (termStart is strictly after parent's own end).
    await lockAndAssertNoAnnualPrepayOverlap(
      trx, parent.customer_id, termStart, false,
      'Customer already has an annual prepay term through',
    );

    const planLabel = parent.plan_label || 'Waves Subterranean Termite Protection';
    const prepayAmount = assertValidPrepayAmount(parent);
    // Codex #4971 r23 P1: the fee the 45-day notice quoted is frozen with
    // that witness (renewal_noticed_fee, 20260928030000). A parent whose
    // current prepay_amount no longer matches it is never minted or charged
    // automatically — bell staff (dedupe on the parent) and return null so
    // the sweep defers this parent (stampSweepDeferred) rather than
    // re-trying it ahead of newer ones. Column-tolerant: NULL (no notice
    // witnessed yet, or a pre-migration row) freezes nothing.
    const noticedFee = parent.renewal_noticed_fee == null || parent.renewal_noticed_fee === '' ? null : Number(parent.renewal_noticed_fee);
    // Codex #4971 r24 P1: FAIL CLOSED on a witnessed notice with no frozen
    // fee (a row noticed before 20260928030000 landed — the notice is never
    // re-sent, so nothing would ever freeze it): the customer was told SOME
    // fee we cannot verify, so the automatic renewal holds (its own bell)
    // until staff record the noticed fee. Schema-tolerant by row shape: a
    // row without the column at all (pre-migration deploy) is not judged.
    const feeColumnPresent = Object.prototype.hasOwnProperty.call(parent, 'renewal_noticed_fee');
    if (feeColumnPresent && parent.notice_45_sent_at && noticedFee == null) {
      await ringRenewalBell(parent, 'notice_fee_unfrozen', `the renewal notice went out ${dateOnlyString(parent.notice_45_sent_at)} but the fee it quoted was never recorded on the term (renewal_noticed_fee is empty)`);
      return null;
    }
    if (noticedFee != null && Number.isFinite(noticedFee) && Math.round(noticedFee * 100) !== Math.round(prepayAmount * 100)) {
      await ringRenewalBell(parent, 'fee_changed_after_notice', `the term's fee is now $${prepayAmount.toFixed(2)} but the renewal notice quoted $${noticedFee.toFixed(2)}`);
      return null;
    }

    const invoice = await InvoiceService.create({
      database: trx,
      customerId: parent.customer_id,
      title: `${planLabel} — Annual Renewal`,
      lineItems: [{
        description: `${planLabel} — annual renewal (${termStart} through ${termEnd})`,
        quantity: 1,
        unit_price: prepayAmount,
      }],
      notes: `Automatic annual renewal for the ${planLabel} plan. Covers ${termStart} through ${termEnd}. This is the exact renewal fee quoted in your renewal notice — no setup fee, no price change.`,
      dueDate: etDateString(),
      // Frozen zero, same convention as the original activation invoice
      // (145a88c99d) — a renewal must never pick up tax from a
      // reclassification that happened during the covered year.
      taxRate: 0,
      // Annual-prepay invoices settle inside this same flow (or the
      // customer's saved card, right after) — never accrued to a
      // third-party payer statement.
      skipAccrual: true,
    });
    if (!invoice?.id) throw new Error(`renewal invoice mint failed for parent term ${parent.id}`);
    assertInvoiceMatchesQuotedRenewalFee(invoice, prepayAmount, parent.id);

    const successor = await AnnualPrepayRenewals.createTermForAnnualPrepay({
      customerId: parent.customer_id,
      prepayInvoiceId: invoice.id,
      planLabel,
      monthlyRate: parent.monthly_rate != null ? Number(parent.monthly_rate) : Math.round((prepayAmount / 12) * 100) / 100,
      prepayAmount,
      termStart,
      termEnd,
      coverageServiceType: parent.coverage_service_type || undefined,
      coverageVisitCount: parent.coverage_visit_count || undefined,
      coverageCadence: parent.coverage_cadence || undefined,
      annualPlanVersion: parent.annual_plan_version,
      renewedFromTermId: parent.id,
      // Codex round-1 P1: carry the ORIGINAL Auto Pay consent forward — a
      // renewal successor never signs a fresh agreement, so without this
      // every second-and-later renewal would fall into decideAndCharge's
      // no_consent skip forever. createTermForAnnualPrepay stamps it onto
      // the successor too, so ITS eventual renewal carries it forward
      // again (the chain, not just one hop).
      renewalChargeConsentAt: parent.renewal_charge_consent_at || undefined,
      conn: trx,
    });
    if (!successor?.id) throw new Error(`renewal successor mint returned no term for parent ${parent.id}`);
    // Codex #4971 r5 P1: the renewal invoice's link to its term is what the
    // invoice send's Bill-To fence keys on (invoice.js claimBillToFencedSend
    // re-resolves the customer default payer for a renewal invoice). The
    // term sync that writes it is best-effort, so the mint writes it itself,
    // strictly — a renewal bill never exists without the link.
    await trx('invoices').where({ id: invoice.id }).update({ annual_prepay_term_id: successor.id });

    // P2-1: the PARENT's renewal decision is deliberately NOT recorded
    // here. Minting only PROPOSES a renewal — the successor is unpaid, and
    // can still lapse (pass 5) — so deciding 'renew' before that is known
    // would leave a lapsed-and-cancelled successor sitting behind a parent
    // already marked 'renewed'. See annual-prepay-renewals.js's
    // stampParentRenewedForSuccessor (called from syncTermForInvoicePayment
    // once the successor's own invoice actually pays) and this file's
    // processGraceLapseForTerm (which records the decided lapse instead).
    return { successor, minted: true, parentId: parent.id };
  });
}

// Codex round-1 P0: re-validates every fact that could have changed since
// the successor was minted, and claims the Stripe-attempt fence in the
// SAME transaction/lock as the last check — so nothing can slip through
// between "still eligible" and "charged". Shared by BOTH decideAndCharge
// callers (the normal mint-then-charge tick, immediately after minting,
// and reconcileStuckSuccessors' recovery leg, which can run hours or days
// later) so the two can never drift apart on what "eligible" means:
//   - the successor itself is still payment_pending (a concurrent grace-
//     lapse tick — or this very fence, raced — hasn't already resolved it)
//   - its PARENT passes resolveParentEligibility's ALLOW-list (still
//     undecided/live, or decided 'renew' with its own invoice still paid)
//     — a customer decline (recordDecision('cancel')), a refund/void sync
//     that left it cancelled with NO decision recorded (Codex round-4 P0),
//     or a missing parent row all wins over an in-flight charge, even one
//     racing in right after the mint
//   - its own renewal invoice is still open (chokepoint A: not void/
//     cancelled/refunded, no paid/prepaid/paid_at evidence, not clearing)
//   - today is still within the successor's OWN grace deadline (the SAME
//     GRACE_DAYS window minting itself is bounded to, P1-2) — a long
//     outage that leaves the recovery leg running weeks late must bell
//     staff, never fire a months-overdue charge.
// Returns { eligible: true } with the fence ALREADY claimed, or
// { eligible: false, reason, retire?, defer? } (see successorActionBlocker)
// with nothing claimed and nothing charged.
async function resolveChargeEligibility(successorId, conn = db) {
  return conn.transaction(async (trx) => {
    const blocker = await successorActionBlocker(trx, successorId, { lock: true, chargeWindow: true });
    if (blocker) return { eligible: false, ...blocker };

    // The ONE Stripe-attempt fence: claimed in the SAME transaction as
    // every check above, atomically, and never re-checked afterward. A
    // concurrent/retried tick that loses this race sees 0 rows updated and
    // does nothing further — no bell, no second charge, no second
    // delivery (whichever tick won already handles those).
    // Codex #4971 r4 P1 (write-ahead outcome): the follow-through
    // obligation is persisted WITH the fence, before anything reaches
    // Stripe — 'outcome_pending' until the outcome is known. The in-line
    // result (or the paid sync) replaces or clears it; if the process dies,
    // or the outcome write fails, after the submission, leg 7d resolves it
    // from durable evidence (never by charging again).
    const claimed = await trx('annual_prepay_terms')
      .where({ id: successorId })
      .whereNull('renewal_charge_attempted_at')
      .update({
        renewal_charge_attempted_at: new Date(),
        renewal_charge_failure_kind: CHARGE_OUTCOME_PENDING,
        renewal_charge_failure_reason: null,
        renewal_charge_failure_handled_at: null,
      });
    if (!claimed) return { eligible: false, reason: 'already_attempted' };
    return { eligible: true };
  });
}

// Codex #4971 pre-push P1 — the ONE "dispute-suspended successor" rule. A
// renewal successor that was PAID and then disputed is demoted back to
// payment_pending with the dispute marker (suspendActiveTermsForDisputedInvoice)
// and its invoice reopened unpaid — so it reads exactly like an unpaid,
// overdue renewal. The dispute owns it until it resolves (won: re-paid ->
// active, the marker cleared by the recovery; lost: cancelled). No renewal
// action — the charge, a pay link, a withdrawal's void, a grace lapse's void
// and station retrieval — may act on it: every under-gate successor re-read
// defers (rotates, no bell) on this, and the scans exclude it through the
// SQL twin. The marker on a row in any OTHER status is not a suspension (on
// a live row it is the won / re-paid recovery, see
// successorPaymentBacksRenewal), so the rule is the pair, never the marker
// alone. Column-tolerant in SQL (to_jsonb): narrow schemas read "not
// suspended", as coveredTermsAsOf's grace predicate does.
function successorDisputeSuspended(term) {
  return term?.status === PAYMENT_PENDING_STATUS && Boolean(term.dispute_suspended_at);
}

function whereSuccessorNotDisputeSuspended(builder, alias) {
  return builder.whereRaw(
    `NOT (${alias}.status = ? AND (to_jsonb(${alias}) ->> 'dispute_suspended_at') IS NOT NULL)`,
    [PAYMENT_PENDING_STATUS],
  );
}

// The ONE definition of "may this successor still be acted on" — shared by
// resolveChargeEligibility (locked, right before the fence) and
// checkStillEligibleForRenewalAction (unlocked, before any customer-facing
// fallback), which used to be two hand-kept copies. Returns null when
// eligible, else { reason } plus at most one of:
//   retire — a DURABLE refusal (resolveParentEligibility's `durable`, or the
//            successor's own grace window closed): the caller terminalizes
//            the successor (withdrawRenewalSuccessor), never merely marks
//            it handled (Codex #4971 round-3 P1, item 1)
//   defer  — a refusal that can clear on its own (a parent in dispute): the
//            caller leaves the successor for the next tick, rotated to the
//            back of its scan (stampSweepDeferred)
// A refusal with neither is already resolved elsewhere (paid, voided, no
// longer payment_pending, already attempted).
// `chargeWindow` (Codex #4971 r27 P1): the AUTOMATIC charge is additionally
// capped at the parent's own renewal window — parent.term_end + the grace
// days, the same bound whereWithinRenewalWindow applies to the mint. The
// successor's coverage grace is anchored on the later of its term_start /
// created_at (a successor minted on the last allowed day still gets its
// full payment grace), but a charge recovered by leg 7a under that extended
// deadline could land almost 60 days after the renewal date, which the
// window promises becomes a manual renewal. Read from the parent row this
// function already holds — no extra query. Pay-link sends and the fallback
// checks do not pass it: only the charge is capped.
async function successorActionBlocker(conn, successorId, { lock = false, chargeWindow = false } = {}) {
  const read = (query) => (lock ? query.forUpdate() : query);
  const fresh = await read(conn('annual_prepay_terms').where({ id: successorId })).first();
  if (!fresh) return { reason: 'successor_not_found' };
  if (fresh.status !== PAYMENT_PENDING_STATUS) return { reason: `successor_status_${fresh.status}` };
  if (fresh.renewal_charge_attempted_at) return { reason: 'already_attempted' };
  // Paid, then disputed back to payment_pending: the dispute owns it.
  if (successorDisputeSuspended(fresh)) return { reason: 'successor_dispute_suspended' };

  if (fresh.renewed_from_term_id) {
    const parent = await read(conn('annual_prepay_terms').where({ id: fresh.renewed_from_term_id })).first();
    const parentEligibility = await parentRefusalForSuccessor(conn, fresh, parent);
    if (!parentEligibility.eligible) {
      return parentEligibility.durable
        ? { reason: parentEligibility.reason, retire: true }
        : { reason: parentEligibility.reason, defer: true };
    }
    if (chargeWindow && parent?.term_end
      && etDateString() > addDaysYmd(dateOnlyString(parent.term_end), graceDays())) {
      return { reason: 'past_renewal_charge_window' };
    }
  }

  // Still within the successor's OWN grace deadline (the SAME GRACE_DAYS
  // window minting itself is bounded to, P1-2) — a long outage that leaves
  // the recovery leg running weeks late must never fire a months-overdue
  // charge or bill. Durable: that window never reopens.
  // A collections dispute hold defers BEFORE the grace check: a hold that
  // outlives the grace window must not withdraw the renewal (B10).
  if (await collectionsDisputeHoldBlocks(conn, fresh.customer_id)) return { reason: HOLD_DEFER_REASON, defer: true };
  const graceRefusal = graceWindowRefusal(fresh);
  if (graceRefusal) return graceRefusal;

  // Chokepoint A: the invoice must still be OPEN — not cancelled/void/
  // refunded, no paid evidence (paid/prepaid/paid_at: settled by card, ACH
  // or account credit), and not an ACH debit still clearing.
  if (fresh.prepay_invoice_id) {
    const invoice = classifyRenewalInvoice(await conn('invoices').where({ id: fresh.prepay_invoice_id }).first(...INVOICE_EVIDENCE_COLUMNS));
    if (invoice.exists && (invoice.cancelled || invoice.paidEvidence || invoice.processing)) {
      return { reason: `invoice_${invoice.status}` };
    }
  }
  return null;
}

// ---- chokepoints C + D: successor lifecycle, scan fairness --------------

// Chokepoint D (Codex #4971 round-3 P2, item 4): every bounded recovery
// scan here orders by renewal_sweep_deferred_at NULLS FIRST ahead of its own
// order (migration 20260927020000). A row a pass must leave for a later
// tick — a condition that clears on its own — is stamped here, so it
// rotates to the back instead of re-occupying the same oldest page forever
// and starving rows behind it. Ordering only; best-effort (a failed stamp
// just leaves the row where it was).
async function stampSweepDeferred(term, conn = db) {
  try {
    await conn('annual_prepay_terms').where({ id: term.id }).update({ renewal_sweep_deferred_at: new Date() });
  } catch (err) {
    logger.error(`[termite-annual-renewal] failed to stamp renewal_sweep_deferred_at for term ${term.id}: ${err.message}`);
  }
}

// How a void refusal from voidInvoice's requireUnsettled chokepoint must be
// handled — shared by the grace lapse and withdrawRenewalSuccessor, so the
// two can never disagree about what a refusal means:
//   settled       durable settlement (cash, or account credit covering the
//                 total) — never void it
//   manual_review a partial account credit: money is committed against the
//                 invoice but it is not settled — a human decides
//   transient     still clearing / in flight / mid-send / an ambiguous or
//                 in-progress Stripe charge — retry on a later tick
// Anything else (null) is an unexpected failure the caller rethrows.
const VOID_REFUSALS = {
  INVOICE_ALREADY_PAID: 'settled',
  INVOICE_SETTLED_REFUSE_VOID: 'settled',
  INVOICE_PARTIAL_CREDIT_REFUSE_VOID: 'manual_review',
  INVOICE_PAYMENT_IN_FLIGHT: 'transient',
  INVOICE_PROCESSING_REFUSE_VOID: 'transient',
  INVOICE_SEND_IN_PROGRESS: 'transient',
  STRIPE_AMBIGUOUS_OUTCOME: 'transient',
  STRIPE_CHARGE_IN_PROGRESS: 'transient',
};
function classifyVoidRefusal(err) {
  return Object.prototype.hasOwnProperty.call(VOID_REFUSALS, err?.code) ? VOID_REFUSALS[err.code] : null;
}

// Chokepoint A, JS form of "presented": the renewal reached the customer —
// its invoice was delivered, or a charge attempt against it reached Stripe
// (the same two facts the grace-lapse scan's SQL selects on).
async function renewalWasPresented(conn, successor) {
  if (!successor.prepay_invoice_id) return false;
  const invoice = classifyRenewalInvoice(await conn('invoices').where({ id: successor.prepay_invoice_id }).first(...INVOICE_EVIDENCE_COLUMNS));
  if (invoice.delivered) return true;
  if (await chargeFollowThroughOwed(conn, successor)) return false;
  const reached = await whereAttemptPresented(
    conn('stripe_invoice_charge_attempts as a').where('a.invoice_id', successor.prepay_invoice_id),
  ).first('a.id');
  return Boolean(reached);
}

// JS twin of the grace-lapse scan's followThroughNotOwed: a charge outcome
// recorded (or still pending, write-ahead) whose follow-through has not
// verifiably completed. Read fresh — the caller's row can predate the claim.
async function chargeFollowThroughOwed(conn, successor) {
  const row = await conn('annual_prepay_terms').where({ id: successor.id })
    .first('renewal_charge_failure_kind', 'renewal_charge_failure_handled_at');
  return Boolean(row?.renewal_charge_failure_kind) && !row.renewal_charge_failure_handled_at;
}

// Codex #4971 round-3 P1 (item 1) + OWNER RULING (pre-push, item 6) —
// chokepoint C: THE one way a successor that must never be charged, billed
// or lapsed leaves payment_pending. Two causes:
//   - its parent became DURABLY ineligible (declined, cancelled, refunded,
//     voided, switched, flag removed, gone — resolveParentEligibility's
//     `durable`, or its term_end moved since the mint). Owner ruling: the
//     renewal is withdrawn RIGHT AWAY whether or not its invoice was already
//     sent — a renewal bill for a plan the prior year no longer backs must
//     not stay payable until the grace deadline.
//   - its own grace window closed before it was ever presented. A PRESENTED
//     renewal past its deadline is the grace-lapse pass's (void + retrieval
//     + the parent's decided lapse) — `lapseOwnsPresented` leaves it there.
// Runs under the PARENT's decision gate, taken first (the lock-order rule;
// re-entrant when a caller already holds it). Order inside:
//   1. money already in motion wins (renewalMoneyInMotion: paid/prepaid, an
//      ACH still clearing, a submitted charge not yet resolved, a charge
//      reconciliation pending) — nothing voided, rotated for a later tick;
//   2. the staff bell must persist BEFORE the withdrawal (bellOrRotate) — a
//      withdrawn successor leaves every scan, so a lost bell could never be
//      retried;
//   3. void through voidInvoice's requireUnsettled chokepoint (it re-checks
//      settled / in flight / partial credit under the invoice's own row
//      lock), whose own sync cancels the successor (move 9) and so ends its
//      grace coverage; a sync that failed after the void is completed here.
// NEVER raises station retrieval, NEVER decides the parent (the parent's
// own cancel/decline flow owns retrieval), and sends the customer nothing.
// Returns 'retired', 'presented' (left to the grace lapse) or
// 'manual_review' (a partial credit — belled), each only once its bell
// persisted, or 'deferred' (rotated: money in motion, a transient or
// settled void refusal, a lost bell, or the reason no longer holding — the
// caller writes no exclusion).
//
// Codex #4971 r6 P1 (structural): a decision computed BEFORE the gate is
// never the authority for an action taken UNDER it. The caller's refusal
// only labels the bell; under the held gate this re-reads the successor and
// its parent and recomputes the refusal itself (withdrawalRefusalUnderGate
// — successorRecoveryRefusal: the parent durably ineligible, or the
// successor's own grace window closed). A refusal that no longer holds, or
// is no longer durable (the parent's payment or coverage restored in
// between), withdraws nothing: no bell, no void — rotated for a later tick.
async function withdrawRenewalSuccessor(successor, label, conn = db) {
  if (!successor.renewed_from_term_id) return withdrawSuccessorUnderGate(successor, label, conn);
  return withRenewalGate(successor, () => withdrawSuccessorUnderGate(successor, label, conn));
}

// The withdrawal's own verdict, read under the gate: null when the renewal
// must NOT be withdrawn now, else the recomputed durable refusal (with the
// fresh successor row).
async function withdrawalRefusalUnderGate(successor, conn) {
  const fresh = await conn('annual_prepay_terms').where({ id: successor.id }).first();
  // Codex #4971 pre-push P1: a dispute-suspended successor is the dispute's
  // — never voided or cancelled here (deferred, rotated, no bell).
  if (fresh?.status !== PAYMENT_PENDING_STATUS || successorDisputeSuspended(fresh)) return null;
  const refusal = await successorRecoveryRefusal(fresh, conn);
  return refusal?.retire ? { ...refusal, successor: fresh } : null;
}

// Codex #4971 r5 P2 (lock order): every renewal action on a successor holds
// the PARENT's decision gate AND the successor's own key — taken together,
// sorted, on one session (withParentDecisionLock's alsoTermIds) — because
// its nested writers (voidInvoice, cancelTermWithRestorations) gate on the
// successor while any customer-keyed writer takes both keys in sorted
// order. Re-entrant on either key.
function withRenewalGate(successor, fn) {
  return require('./annual-prepay-renewals').withParentDecisionLock(successor.renewed_from_term_id, fn, { alsoTermIds: [successor.id] });
}

// Codex #4971 r15 P1: call immediately before every provider boundary a
// held renewal gate is meant to serialize against (a Stripe charge
// submission, an SMS/email pay-link send) — see
// assertParentDecisionLockAlive's own doc in annual-prepay-renewals.js. A
// typeof guard, not a require-shape assumption: production always exports
// this; a test's own narrow mock of annual-prepay-renewals that predates
// this assertion simply has nothing to assert against, so it stays a no-op
// there rather than failing that test on an unrelated shape mismatch.
function assertRenewalLockAlive() {
  const mod = require('./annual-prepay-renewals');
  if (typeof mod.assertParentDecisionLockAlive === 'function') mod.assertParentDecisionLockAlive();
}

// Account deletion's fence against a live renewal action (Codex #4971 r15
// P1; restructured r21). Both deleted_at writers (auth.js DELETE /account,
// admin-customers.js archive) run their deletion INSIDE this helper's
// transaction: every termite term of the customer(s) — parents, successors,
// whatever status (termiteGateKeys' customer arm) — is locked with
// pg_advisory_xact_lock on that same transaction first
// (acquireTermiteGateAtEntry: the SAME key space, sorted the same way, as the
// session lock every renewal action — send, charge, withdrawal, mint — holds
// through its provider handoff via withRenewalGate / withParentDecisionLock),
// and fn(trx) then writes deleted_at on that same connection. So the
// deletion cannot commit while any renewal action for these terms holds the
// gate, and no such action can start until the deletion commits — the r15
// property — with none of the raw-session machinery the old shape needed:
//   - r21 P1 / r19: a transaction-level lock cannot be "lost" while its
//     write proceeds. If the connection drops, the transaction — and the
//     deletion write with it — is gone too; there is no separate lock
//     session to keep alive and no liveness check to forget at the write
//     boundary.
//   - r17 P2 / r20 P2: no per-parent or per-profile raw session counted
//     against PARENT_DECISION_LOCK_SESSIONS' cap — the keys are taken on the
//     deletion's own pooled connection, however many there are.
//   - r16 P1 / r20 P1 (finding 3): keyed on EVERY termite term of the
//     customer, not on a status-filtered subset (a not-yet-minted successor's
//     parent, a staff-renewed parent with an unpaid successor — all of them),
//     so no status transition can slip a pair out of the fence.
// A gate held by a renewal action makes this wait up to lock_timeout
// (PARENT_DECISION_LOCK_TIMEOUT_MS) and then throw with code
// PARENT_DECISION_LOCK_TIMEOUT, which both routes answer with 409. Ids
// already held by this async tree's own withParentDecisionLock are skipped
// (re-entrant). No customer ids at all → fn(trx) still runs in the
// transaction, nothing locked.
async function withCustomerDeletionGate(customerIds, fn) {
  const ids = [...new Set((Array.isArray(customerIds) ? customerIds : [customerIds]).filter(Boolean).map(String))];
  const result = await db.transaction(async (trx) => {
    if (ids.length) await require('./annual-prepay-renewals').acquireTermiteGateAtEntry(trx, { customerIds: ids });
    return fn(trx);
  });
  // Synchronous withdrawal (owner ruling 2026-09-28): the deleted account's
  // unpaid renewal pay links die now, not at the next sweep — after the
  // deletion committed and its transaction-level gate released, on the
  // renewal gate the withdrawal itself takes.
  // Never lets a withdrawal problem change the committed deletion's outcome.
  if (ids.length) {
    await withdrawUnpaidSuccessorsOfCustomers(ids, 'the customer deleted their account').catch((err) => {
      logger.error(`[termite-annual-renewal] synchronous withdrawal after account deletion failed: ${err.message}`);
    });
  }
  return result;
}

// ---- synchronous withdrawal (owner ruling 2026-09-28) --------------------
//
// A delivered renewal pay link stays in the customer's hands, and the bank
// and Express Checkout rails confirm at Stripe directly — once the
// PaymentIntent exists no server check can stop them (Codex #4971 r26/r28).
// So the pay link is killed the moment the prior plan stops backing the
// renewal: every writer that moves a termite PARENT out of authorizing its
// renewal (a cancel / switch decision — recordDecision; a refund or void of
// its invoice — cancelTermWithRestorations; a window move —
// createTermForAnnualPrepay; the account's deletion —
// withCustomerDeletionGate) calls afterParentChange, which withdraws the
// unpaid successor RIGHT AFTER that writer's own transaction commits:
// withdrawIfParentDurablyIneligible re-judges the parent UNDER the renewal
// gate (a transient refusal — a dispute — defers, never withdraws), voids
// the successor's invoice (voidInvoice cancels any open PaymentIntent,
// fail-closed on money in flight) and cancels the successor. The daily
// sweep (withdrawSuccessorsOfIneligibleParents) stays as the backstop for
// anything this path could not finish. Gated like the sweep.
async function withdrawUnpaidSuccessorOfParent(parentTermId, reason, conn = db) {
  if (!parentTermId || !termiteAnnualRenewalChargeLive()) return null;
  const successor = await whereWithdrawableByHook(
    conn('annual_prepay_terms').where({ renewed_from_term_id: parentTermId, status: PAYMENT_PENDING_STATUS }),
  ).first();
  if (!successor) return null;
  logger.info(`[termite-annual-renewal] withdrawing successor ${successor.id} now — ${reason}`);
  return withdrawIfParentDurablyIneligible(successor, conn);
}

// The rows the synchronous hooks may touch — the SAME ownership rules the
// sweep's own scan applies (withdrawSuccessorsOfIneligibleParents): a
// dispute-suspended successor belongs to its dispute, a started lapse to
// the lapse state machine, a manual_review row to staff.
function whereWithdrawableByHook(query) {
  return query
    .whereNotNull('annual_plan_version')
    .whereNull('dispute_suspended_at')
    .whereNull('renewal_lapse_started_at')
    .whereRaw("coalesce(renewal_lapse_outcome, '') <> 'manual_review'");
}

async function withdrawUnpaidSuccessorsOfCustomers(customerIds, reason, conn = db) {
  const ids = (customerIds || []).filter(Boolean).map(String);
  if (!ids.length || !termiteAnnualRenewalChargeLive()) return [];
  // Codex #5197 r1 P2: the writer that calls this has ALREADY committed
  // (the deletion / archive) — nothing here may change its outcome, so the
  // lookup is as best-effort as the per-successor work below; the sweep is
  // the backstop.
  let successors;
  try {
    successors = await whereWithdrawableByHook(
      conn('annual_prepay_terms')
        .whereIn('customer_id', ids)
        .where({ status: PAYMENT_PENDING_STATUS })
        .whereNotNull('renewed_from_term_id'),
    ).select('*');
  } catch (err) {
    logger.error(`[termite-annual-renewal] synchronous withdrawal lookup failed for customers ${ids.join(', ')}: ${err.message}`);
    return [];
  }
  const outcomes = [];
  for (const successor of successors) {
    try {
      logger.info(`[termite-annual-renewal] withdrawing successor ${successor.id} now — ${reason}`);
      outcomes.push(await withdrawIfParentDurablyIneligible(successor, conn));
    } catch (err) {
      logger.error(`[termite-annual-renewal] synchronous withdrawal failed for successor ${successor.id}: ${err.message}`);
      outcomes.push(null);
    }
  }
  return outcomes;
}

// Codex #5197 r1 P1: the edited term may itself be the SUCCESSOR (the
// admin invoice flow edits an existing unpaid renewal's dates through its
// prepay invoice) — a moved successor no longer abuts its own parent, which
// is the same durable parent_term_moved refusal read from the other side.
// Withdraw the successor itself; nothing to look up.
async function withdrawSuccessorIfNoLongerBacked(successorId, reason, conn = db) {
  if (!successorId || !termiteAnnualRenewalChargeLive()) return null;
  const successor = await whereWithdrawableByHook(
    conn('annual_prepay_terms')
      .where({ id: successorId, status: PAYMENT_PENDING_STATUS })
      .whereNotNull('renewed_from_term_id'),
  ).first();
  if (!successor) return null;
  logger.info(`[termite-annual-renewal] withdrawing successor ${successor.id} now — ${reason}`);
  return withdrawIfParentDurablyIneligible(successor, conn);
}

// The one entry every parent-change writer calls. `conn` is the writer's
// own handle: a transaction (or a savepoint inside one) defers the
// withdrawal to the OUTERMOST commit (commitPromiseOf — a rollback runs
// nothing); the root handle means the write already committed, so the
// withdrawal runs now and the caller awaits it. Never throws: the sweep is
// the backstop, and a writer's own success must not depend on this.
function afterParentChange(conn, parentTermId, reason, { successorItself = false } = {}) {
  const withdraw = successorItself ? withdrawSuccessorIfNoLongerBacked : withdrawUnpaidSuccessorOfParent;
  const run = () => withdraw(parentTermId, reason).catch((err) => {
    logger.error(`[termite-annual-renewal] synchronous withdrawal after term change failed for term ${parentTermId}: ${err.message}`);
    return null;
  });
  const commit = commitPromiseOf(conn);
  if (commit) {
    // The deferred run executes OUTSIDE the writer's captured lock context
    // (review of #5197): a writer that itself ran under
    // withParentDecisionLock would otherwise hand this hook a store that
    // still lists its keys as held after the session released them, and
    // withRenewalGate would skip the very gate this must take fresh.
    // (knex resolves executionPromise on an explicit no-argument
    // trx.rollback() too; the under-gate re-judge then finds the parent
    // still authorizing and withdraws nothing.)
    const { runOutsideParentDecisionLocks } = require('./annual-prepay-renewals');
    const outside = typeof runOutsideParentDecisionLocks === 'function' ? () => runOutsideParentDecisionLocks(run) : run;
    commit.then(outside, () => null);
    return Promise.resolve(null);
  }
  return run();
}

async function withdrawSuccessorUnderGate(original, label, conn) {
  const refusal = await withdrawalRefusalUnderGate(original, conn);
  if (!refusal) {
    logger.info(`[termite-annual-renewal] withdrawal of successor ${original.id} skipped — ${label} no longer holds under the gate`);
    await stampSweepDeferred(original, conn);
    return 'deferred';
  }
  const { successor, lapseOwnsPresented } = refusal;
  const reason = label;
  if (lapseOwnsPresented && (await renewalWasPresented(conn, successor))) {
    const told = await bellOrRotate(successor, 'ineligible', `${reason} — the renewal was already presented to the customer, so the grace-lapse pass will resolve it`, conn);
    return told ? 'presented' : 'deferred';
  }
  const inMotion = await renewalMoneyInMotion(conn, successor);
  if (inMotion) {
    logger.warn(`[termite-annual-renewal] withdrawal of successor ${successor.id} deferred — ${inMotion}`);
    await stampSweepDeferred(successor, conn);
    return 'deferred';
  }
  if (!(await bellOrRotate(successor, 'renewal_withdrawn', reason, conn))) return 'deferred';
  const voidRefusal = await voidWithdrawnRenewalInvoice(successor, reason, conn);
  if (voidRefusal) return voidRefusal;
  const fresh = await conn('annual_prepay_terms').where({ id: successor.id }).first('status');
  if (fresh?.status === PAYMENT_PENDING_STATUS) {
    await require('./annual-prepay-renewals').cancelTermWithRestorations(successor.id, conn);
  }
  return 'retired';
}

// The void step of a withdrawal. Returns null once voided (or nothing to
// void); otherwise the outcome: money that landed after all (settled) or is
// still moving (transient) wins — 'deferred', rotated; a partial account
// credit is a human's call — 'manual_review' once its bell persisted.
async function voidWithdrawnRenewalInvoice(successor, reason, conn) {
  if (!successor.prepay_invoice_id) return null;
  try {
    await require('./invoice').voidInvoice(successor.prepay_invoice_id, { requireUnsettled: true });
    return null;
  } catch (err) {
    const refusal = classifyVoidRefusal(err);
    if (!refusal) throw err;
    if (refusal !== 'manual_review') {
      await stampSweepDeferred(successor, conn);
      return 'deferred';
    }
    const told = await bellOrRotate(successor, 'retire_refused', `${reason}; its renewal invoice could not be voided (${err.message})`, conn);
    return told ? 'manual_review' : 'deferred';
  }
}

// Owner ruling (item 6): money already in motion wins over a withdrawal —
// the renewal invoice already reads paid/prepaid, an ACH debit is still
// clearing, a charge that reached Stripe has not resolved yet, or a charge
// reconciliation is pending on the invoice. Returns the reason, or null.
// (voidInvoice's requireUnsettled re-checks all of this under the invoice's
// row lock; this earlier read keeps a withdrawal from even ringing its bell
// while money is moving.)
async function renewalMoneyInMotion(conn, successor) {
  if (!successor.prepay_invoice_id) return null;
  const invoice = classifyRenewalInvoice(await conn('invoices').where({ id: successor.prepay_invoice_id }).first(...INVOICE_EVIDENCE_COLUMNS));
  if (invoice.paidEvidence) return `the renewal invoice already reads ${invoice.status}`;
  if (invoice.processing) return 'an ACH payment on the renewal invoice is still clearing';
  const unresolved = await whereAttemptSubmitted(
    conn('stripe_invoice_charge_attempts as a').where({ 'a.invoice_id': successor.prepay_invoice_id, 'a.resolved_at': null }),
  ).first('a.id');
  if (unresolved) return 'a charge submitted to Stripe has not resolved yet';
  const reconciliation = await reconciliationStatusForVoid(conn, successor.prepay_invoice_id);
  return reconciliation.ok ? null : reconciliation.reason;
}

// Codex #4971 r4 P1 (item 4a) — the parent-decision writers' question
// (annual-prepay-renewals.js refuseWhileRenewalClearing): does any open
// renewal successor of this parent have money in motion? The SAME test the
// withdrawal defers on (renewalMoneyInMotion), so a cancel can never land
// on a renewal the withdrawal could not void. Returns the reason, or null.
async function renewalMoneyInMotionForParent(conn, parentTermId) {
  const successors = await conn('annual_prepay_terms')
    .where({ renewed_from_term_id: parentTermId })
    .whereNotNull('annual_plan_version')
    .select('*');
  for (const successor of successors || []) {
    const reason = await successorRenewalUnsettled(conn, successor);
    if (reason) return reason;
  }
  return null;
}

// One successor's answer: a payment_pending renewal with money in motion
// (renewalMoneyInMotion), or — Codex #4971 r13 P1 — a renewal already PAID
// (active, or the paid decided-lapse shape: successorPaymentBacksRenewal)
// whose parent the caller is about to decide. The paid sync's parent
// 'renewed' stamp is best-effort (a failed savepoint leaves it to
// reconcileParentRenewedStamps), so a cancel / switch in that gap would
// leave paid coverage behind a contradictory parent that neither the
// backstop (it skips a cancelled parent) nor the late-paid alert (the
// payment predates the decision) ever surfaces — refused like money still
// clearing. recordDecision only moves an UNDECIDED parent, and the backstop
// records 'renew', which the guard never refuses.
const PAID_RENEWAL_AWAITING_PARENT_STAMP = 'a renewal payment was received and is still being recorded against this plan';
async function successorRenewalUnsettled(conn, successor) {
  if (successor.status === PAYMENT_PENDING_STATUS) return renewalMoneyInMotion(conn, successor);
  return (await successorPaymentBacksRenewal(conn, successor)) ? PAID_RENEWAL_AWAITING_PARENT_STAMP : null;
}

async function renewalMoneyInMotionForTerm(conn, term) {
  if (term.renewed_from_term_id && term.status === PAYMENT_PENDING_STATUS) {
    const own = await renewalMoneyInMotion(conn, term);
    if (own) return own;
  }
  return renewalMoneyInMotionForParent(conn, term.id);
}

// Codex #4971 r4 P1 — the paid sync's hook for a termite renewal successor
// that just activated (annual-prepay-renewals.js syncTermForInvoicePayment,
// pending -> active, after its own transaction). Best-effort: the
// activation already committed and stands either way.
//   1. A known success ends the write-ahead charge outcome (item 3).
//   2. Late success on an EXTERNAL change (item 4b): the parent-decision
//      writers refuse while renewal money is in motion, but a refund, void,
//      dispute or flag removal on the PARENT can still land while an ACH
//      debit clears. A renewal that activates behind a parent that no
//      longer authorizes it stays ACTIVE — money received is honored until
//      a human decides — and staff get ONE alert to refund or honor it
//      (bellLatePaidRenewal; leg 7e re-rings a lost one). The customer is
//      not messaged.
async function onRenewalSuccessorPaid(successor, conn = db) {
  if (!successor?.renewed_from_term_id || !successor.annual_plan_version || conn.isTransaction) return;
  // Only a payment that really backs the renewal (live or paid decided
  // lapse, invoice settled and not revoked) — re-checked under the gate
  // before any alert.
  if (!(await successorPaymentBacksRenewal(conn, successor))) return;
  if (successor.renewal_charge_failure_kind === CHARGE_OUTCOME_PENDING) await clearChargeOutcomePending(successor, conn);
  try {
    await bellLatePaidRenewal(successor, conn);
  } catch (err) {
    logger.error(`[termite-annual-renewal] late-paid renewal check failed for term ${successor.id}: ${err.message} — leg 7e retries it`);
  }
}

// Returns the bell result when one rang (fresh or deduped), 'not_owed' when
// there is nothing to say, or null when the bell did not persist (retried
// by leg 7e). Owed only when (Codex #4971 r5 P2) the parent's refusal is
// DURABLE (a decision, a cancel, a revoked invoice — never a dispute
// demotion that can still come back) AND the renewal was paid AFTER that
// change: a renewal paid in October whose prior year is refunded or
// disputed the next March was a legitimate payment, not a late one.
//
// Codex #4971 r6 P1 (audit): decided and rung UNDER the renewal gate, on
// terms re-read there — a parent whose payment or coverage was restored, or
// a successor already alerted or no longer active, is never belled on a
// verdict read before the gate.
async function bellLatePaidRenewal(original, conn) {
  return withRenewalGate(original, () => bellLatePaidRenewalUnderGate(original, conn));
}

async function bellLatePaidRenewalUnderGate(original, conn) {
  const successor = await conn('annual_prepay_terms').where({ id: original.id }).first();
  if (!successor || successor.renewal_late_paid_belled_at) return 'not_owed';
  if (!(await successorPaymentBacksRenewal(conn, successor))) return 'not_owed';
  const parent = await conn('annual_prepay_terms').where({ id: successor.renewed_from_term_id }).first();
  const refusal = await parentRefusalForSuccessor(conn, successor, parent);
  if (refusal.eligible || !refusal.durable) return 'not_owed';
  if (!(await paidAfterParentChanged(conn, successor, parent))) return 'not_owed';
  const bell = await ringRenewalBell(successor, 'paid_after_parent_ended', refusal.reason);
  // The marker is written only where the row shows the column exists
  // (20260927040000) — a missing column must never fail the activation.
  if (bell && Object.prototype.hasOwnProperty.call(successor, 'renewal_late_paid_belled_at')) {
    await conn('annual_prepay_terms').where({ id: successor.id })
      .whereNull('renewal_late_paid_belled_at')
      .update({ renewal_late_paid_belled_at: new Date() });
  }
  return bell;
}

// When did the parent stop authorizing its renewal? Codex #4971 r6 P1: the
// EARLIEST durable evidence of the change, never only the term row — a refund
// commits its ledger stamp (and, on the webhook path, the invoice's flip to
// 'refunded') before the separate term-cancel sync moves the term, so a
// successor that settled in that gap was dated "paid before the change" and
// its refund-or-honor alert suppressed. The earliest of:
//   - the parent's decision time (renewal_decision_at), ONLY for a decision
//     other than 'renew': Codex #4971 r8 P1 — a renew decision (a staff
//     renew, or the automatic stamp) authorizes the renewal, so it dates
//     no change; a renewed parent whose invoice is later revoked is dated
//     by that revocation, below;
//   - its dispute suspension (dispute_suspended_at);
//   - its last row update (updated_at — an upper bound on a status change),
//     ONLY while the term row itself no longer authorizes the renewal (a
//     non-renewable status, or a decision other than renew): Codex #4971 r6
//     P2 — a still-active parent's updated_at dates unrelated edits, and
//     would make a payment that preceded a later refund look late;
//   - its prepay invoice's revocation (updated_at once it reads refunded /
//     void / cancelled);
//   - a full refund of that invoice on the payments ledger (the refund
//     writers stamp payments.updated_at with the refund), or (Codex #4971
//     r11 P1) its payment put in dispute there (the dispute webhook stamps
//     payments.updated_at with the 'disputed' flip, before the invoice
//     itself reopens).
// One SQL definition, read by leg 7e's scan and by paidAfterParentChanged.
// Columns a narrow schema may lack are read through to_jsonb (NULL when
// absent; LEAST ignores NULLs). `p` is the parent term, `pi` its prepay
// invoice (a LEFT JOIN — a parent with no invoice has no invoice evidence).
function parentChangedAtSql(p = 'p', pi = 'pi', s = 't') {
  const ts = (alias, column) => `(to_jsonb(${alias}) ->> '${column}')::timestamptz`;
  return `LEAST(
    CASE WHEN ${p}.renewal_decision IS DISTINCT FROM 'renew' THEN ${p}.renewal_decision_at END,
    ${ts(p, 'dispute_suspended_at')},
    CASE WHEN NOT (${p}.status IN ('active', 'renewal_pending') OR (${p}.status = 'renewed' AND ${p}.renewal_decision = 'renew')) THEN ${p}.updated_at END,
    -- Codex #4971 r20 P1 (finding 2): a term-window move (parent_term_moved
    -- — annual-prepay-renewals.js's createTermForAnnualPrepay editing an
    -- EXISTING term's term_start/term_end) on a parent that otherwise still
    -- authorizes its renewal (active/renewal_pending, or renewed+'renew')
    -- trips no other arm above — none of them fire while the status still
    -- reads as authorizing. ONLY a move made AFTER this successor was
    -- minted counts: the mint validated the successor's own window
    -- against the parent's window as it stood, so an earlier move (the
    -- installation anchor's own year-1 move, a staff correction before
    -- the renewal ever existed) changed nothing this renewal relies on —
    -- unscoped, that year-old stamp would date EVERY later renewal of an
    -- anchored plan as "paid after a change" (the r6 P2 class of bug).
    -- s is the successor row. Column-tolerant: a schema without the
    -- column (pre-migration) reads NULL, same as never having moved.
    CASE WHEN ${ts(p, 'term_window_changed_at')} > ${s}.created_at THEN ${ts(p, 'term_window_changed_at')} END,
    CASE WHEN lower(coalesce(${pi}.status, '')) IN ('void', 'cancelled', 'canceled', 'refunded') THEN ${ts(pi, 'updated_at')} END,
    (SELECT MIN(${ts('rp', 'updated_at')}) FROM payments rp
      WHERE ${revokedPaymentSql('rp')}
        AND ((rp.stripe_payment_intent_id IS NOT NULL AND rp.stripe_payment_intent_id = ${pi}.stripe_payment_intent_id)
          OR (rp.stripe_charge_id IS NOT NULL AND rp.stripe_charge_id = ${pi}.stripe_charge_id))),
    -- Codex #4971 r16 P1 (finding 6): a NET-terms statement child (draft,
    -- paid_at cleared, NO invoice-level Stripe ids — see
    -- statementRevocationForInvoice's own doc, r15's fix #3) is revoked on
    -- the STATEMENT's own payments row instead, keyed by payer_statement_id,
    -- never on a row the PI/charge-id arm above can ever match. Without this
    -- arm, a statement refund or a closed-lost dispute never dated the
    -- parent's change at all — LEAST simply ignored the missing NULL — so an
    -- ACH successor settling after it read as paid strictly BEFORE any
    -- change and lost its refund-or-honor alert (bellLatePaidRenewal).
    (SELECT MIN(${ts('sp', 'updated_at')}) FROM payments sp
      WHERE ${pi}.payer_statement_id IS NOT NULL
        AND sp.statement_id = ${pi}.payer_statement_id
        AND ${revokedPaymentSql('sp')})
  )`;
}

// SQL: when the successor's renewal payment actually SETTLED at the provider.
// Codex #4971 r24 P2: invoices.paid_at is stamped when the webhook handler
// RUNS — for a delayed ACH-success delivery that is later than the real
// settlement, so a parent refunded or changed AFTER the debit settled but
// BEFORE the delayed webhook arrived read as "paid after the change" and
// rang a false refund-or-honor conflict. The payments ledger keeps the
// event-derived settlement moment (metadata.settled_event_at — stripe.js
// writes it from the PaymentIntent / charge itself, never from local clock
// time); the earliest one on this invoice's own PaymentIntent / charge is
// the settlement. Fallback: paid_at, for a payment with no ledger stamp (a
// manual or credit-settled invoice, a legacy row). Column-tolerant
// (to_jsonb): a payments table without metadata reads NULL → paid_at.
// `i` is the successor's renewal invoice.
function successorSettledAtSql(i = 'i') {
  return `COALESCE(
    (SELECT MIN((to_jsonb(sp) -> 'metadata' ->> 'settled_event_at')::timestamptz) FROM payments sp
      WHERE (sp.stripe_payment_intent_id IS NOT NULL AND sp.stripe_payment_intent_id = ${i}.stripe_payment_intent_id)
         OR (sp.stripe_charge_id IS NOT NULL AND sp.stripe_charge_id = ${i}.stripe_charge_id)),
    ${i}.paid_at)`;
}

// JS entry for the same test: was the renewal paid after the parent changed?
async function paidAfterParentChanged(conn, successor, parent) {
  if (!parent?.id) return false;
  // The successor row rides the query as `t` (parentChangedAtSql's
  // term-window arm dates a parent move only against ITS mint time).
  const row = await conn('annual_prepay_terms as p')
    .leftJoin('invoices as pi', 'pi.id', 'p.prepay_invoice_id')
    .joinRaw('JOIN annual_prepay_terms AS t ON t.id = ?', [successor.id])
    .where('p.id', parent.id)
    .first(conn.raw(`(SELECT ${successorSettledAtSql('i')} FROM invoices i WHERE i.id = ?) > ${parentChangedAtSql()} AS paid_after`, [successor.prepay_invoice_id]));
  return row?.paid_after === true;
}

// Leg 7e (Codex #4971 r4 P1, item 4b backstop): a renewal whose own payment
// backs it (successorPaymentBacksRenewal — live, or the paid decided-lapse
// shape since the Codex #4971 pre-push P1; settled, not revoked) paid after
// its parent changed, whose parent never took its 'renewed'
// stamp and whose late-paid alert has not persisted — the paid sync's own
// alert was lost, or never ran. Rings it (bellLatePaidRenewal); a parent
// that still authorizes the renewal is left to reconcileParentRenewedStamps.
// Excluded once the alert persisted.
async function bellLatePaidRenewals({ conn = db, limit = 200, counts }) {
  try {
    const candidates = await whereSuccessorPaymentBacksRenewal(
      conn('annual_prepay_terms as t')
        .join('annual_prepay_terms as p', 'p.id', 't.renewed_from_term_id')
        .join('invoices as i', 'i.id', 't.prepay_invoice_id')
        .leftJoin('invoices as pi', 'pi.id', 'p.prepay_invoice_id')
        .whereNotNull('t.annual_plan_version')
        .whereNull('t.renewal_late_paid_belled_at')
        // The parent no longer authorizes the renewal. Codex #4971 r8 P1: a
        // parent's 'renewed' / 'renew' stamp alone is not that authority —
        // resolveParentEligibility (the per-row rule) also needs its own
        // invoice settled and not revoked, so a renewed parent whose invoice
        // was later voided or fully refunded is a candidate too. Its
        // revocation dates the change (parentChangedAtSql, below), so a
        // renewal paid BEFORE that revocation is still never selected.
        .where(function parentNoLongerAuthorizes() {
          this.whereNot('p.status', 'renewed')
            .orWhereRaw("p.renewal_decision is distinct from 'renew'")
            .orWhere(function renewedButRevoked() {
              this.whereNotNull('pi.id').whereNot(function settled() { whereInvoiceSettledNotRevoked(this, 'pi'); });
            });
        })
        // Paid AFTER the parent changed (twin of paidAfterParentChanged) —
        // an old legitimate renewal behind a later refund or dispute is
        // never selected, so it can never pin this page either.
        .whereRaw(`${successorSettledAtSql('i')} > ${parentChangedAtSql()}`),
      't',
      'i',
    )
      .orderByRaw('t.renewal_sweep_deferred_at asc nulls first')
      .orderBy('t.term_start', 'asc')
      .select('t.*')
      .limit(limit);
    counts.latePaidScanned = candidates.length;
    for (const successor of candidates) {
      try {
        const outcome = await bellLatePaidRenewal(successor, conn);
        if (outcome && outcome !== 'not_owed') counts.latePaidBelled += 1;
        else await stampSweepDeferred(successor, conn);
      } catch (err) {
        logger.error(`[termite-annual-renewal] late-paid renewal bell failed for term ${successor.id}: ${err.message}`);
      }
    }
  } catch (err) {
    logger.error(`[termite-annual-renewal] late-paid renewal scan failed: ${err.message}`);
  }
}

// Codex #4971 pre-push P1 — the module's one rule for an exclusion that
// follows a staff bell: exclude only after a TRUTHY bell (a fresh or
// deduplicated notification — either way staff have been told; the same
// rule the exception-bell scans already follow). ringRenewalBell returns
// null when the notification did not persist; the row is then rotated for
// a later tick (stampSweepDeferred) instead of being marked handled, so
// nothing is silently dropped. Returns the bell result, or null.
async function bellOrRotate(term, kind, reason, conn) {
  const bell = await ringRenewalBell(term, kind, reason);
  if (bell) return bell;
  await stampSweepDeferred(term, conn);
  return null;
}

// decideAndCharge's single answer to a refusal from successorActionBlocker
// (either the unlocked pre-check or the locked fence claim).
async function handleChargeRefusal(successor, refusal, conn) {
  if (refusal.reason === 'already_attempted') return { status: 'already_attempted' };
  if (refusal.retire) {
    const retired = await withdrawRenewalSuccessor(successor, refusal.reason, conn);
    // Anything but a retry leaves the row decided — keep leg 7a off it.
    if (retired !== 'deferred' && retired !== 'retired') await stampRenewalChargeSkip(successor, `ineligible:${refusal.reason}`, conn);
    return { status: 'ineligible', reason: refusal.reason, retired };
  }
  if (refusal.defer) {
    // Not stamped skipped: leg 7a re-runs decideAndCharge on a later tick
    // (rotated to the back of its page) until the parent's dispute
    // resolves either way, or the grace window closes and it retires.
    await ringRenewalBell(successor, 'ineligible', refusal.reason);
    await stampSweepDeferred(successor, conn);
    return { status: 'deferred', reason: refusal.reason };
  }
  // The skip stamp excludes the row from leg 7a — only once staff were told.
  if (await bellOrRotate(successor, 'ineligible', refusal.reason, conn)) {
    await stampRenewalChargeSkip(successor, `ineligible:${refusal.reason}`, conn);
  }
  return { status: 'ineligible', reason: refusal.reason };
}

// Codex round-4 P1: persisted provenance for decideAndCharge's own
// PRE-FENCE skips (no_consent / no_method / surcharge_not_authorized /
// ineligible) — every one of these leaves renewal_charge_attempted_at NULL
// (the Stripe-attempt fence is never claimed), which is exactly what
// reconcileStuckSuccessors' leg 7a scans for as "never attempted". Without
// this stamp, that scan can only tell "already handled" apart from
// "genuinely never ran" by inferring it from the notifications table (a
// LIKE on the bell's own dedupeKey) AFTER the row is already selected
// under LIMIT — a backlog of old, already-belled skips then starves
// newer crash-gap rows from ever being reached. Best-effort: a stamp
// failure here never blocks the skip's own bell/pay-link (already sent by
// the caller) — the row simply stays unstamped and leg 7a re-selects it
// next tick, re-running decideAndCharge, which safely re-hits the SAME
// skip (its own bell is separately deduped by notifyAdmin's dedupeKey)
// and tries the stamp again.
async function stampRenewalChargeSkip(successor, reason, conn = db) {
  try {
    await conn('annual_prepay_terms')
      .where({ id: successor.id })
      .whereNull('renewal_charge_skipped_at')
      .update({ renewal_charge_skipped_at: new Date(), renewal_charge_skip_reason: reason });
  } catch (err) {
    logger.error(`[termite-annual-renewal] failed to stamp renewal_charge_skipped_at for term ${successor.id}: ${err.message}`);
  }
}

// Codex round-7 P1: the three pre-fence fallback skips (no_consent /
// no_method / surcharge_not_authorized) must NEVER stamp
// renewal_charge_skipped_at unless deliverRenewalInvoice's OWN VERIFIED
// return value ({ ok: true }) proves the pay link actually went out —
// the old code called it and stamped the skip regardless, so a delivery
// failure (deliverRenewalInvoice never throws; it swallows and returns
// { ok:false } instead) left the customer with NO invoice AND a
// permanently-excluded row (leg 7a's own scan would never re-select it
// again), never redelivered and never lapsed either. On a verified
// failure, the row is left UNSTAMPED on purpose: leg 7a's scan
// (whereNull('renewal_charge_skipped_at')) naturally re-selects it on a
// later tick and retries decideAndCharge from scratch, which retries
// delivery too. The bell's own wording reflects whichever actually
// happened, never a blanket "it was sent".
// Codex #4971 pre-push P1: the skip stamp (leg 7a's exclusion) also needs a
// CONFIRMED staff bell. A retry after a lost bell must not text the customer
// a second time, so an invoice that already carries delivery evidence
// (chokepoint A) is not re-sent — only the bell is retried.
async function deliverInvoiceAndStampSkip(successor, kind, explanation, conn) {
  // Codex #4971 r4 P1: the pay-link chokepoint re-checks eligibility under
  // the parent's gate right before sending — a cancel that landed during
  // the saved-method lookup or the surcharge quote withdraws the successor
  // there (its own bell) instead of mailing the bill.
  const delivered = await deliverRenewalInvoice(successor, conn, `the renewal charge was skipped (${kind})`);
  if (delivered?.code === 'delivery_refused') {
    if (delivered.outcome === 'handled') await stampRenewalChargeSkip(successor, `${kind}:withheld`, conn);
    return delivered;
  }
  const deliveryNote = delivered?.ok
    ? 'The renewal invoice was sent with its pay link.'
    : delivered?.code === 'COLLECTION_HOLD_DEFER'
      ? 'The renewal invoice is held while the customer has a collections dispute hold — it will be sent automatically once the hold is released.'
      : `The renewal invoice could NOT be delivered (${delivered?.error || 'unknown error'}) — it will be retried automatically.`;
  if (delivered?.code === 'payer_billed') {
    // Not a failed delivery: the homeowner pay link is not owed at all.
    // Handled (off leg 7a) only once the payer bell persisted — bellOrRotate.
    if (await bellOrRotate(successor, 'payer_billed', explanation, conn)) await stampRenewalChargeSkip(successor, `${kind}:payer_billed`, conn);
    return delivered;
  }
  const told = await ringRenewalBell(successor, kind, `${explanation} ${deliveryNote}`);
  if (delivered?.ok && told) {
    await stampRenewalChargeSkip(successor, kind, conn);
  } else {
    // Retried by leg 7a — rotated behind rows it has not tried yet (D).
    await stampSweepDeferred(successor, conn);
  }
  return delivered;
}

async function renewalInvoiceAlreadyDelivered(successor, conn) {
  if (!successor.prepay_invoice_id) return false;
  const invoice = await conn('invoices').where({ id: successor.prepay_invoice_id }).first(...INVOICE_EVIDENCE_COLUMNS);
  return classifyRenewalInvoice(invoice).delivered === true;
}

// Codex round-7 P1: a READ-ONLY twin of resolveChargeEligibility's own
// checks (successor still payment_pending, parent still eligible per the
// SAME allow-list, invoice still open, still inside the grace deadline) —
// but it never claims the Stripe-attempt fence. Called BEFORE ANY
// customer-facing action in decideAndCharge, including the three fallback
// skips (no_consent/no_method/surcharge_not_authorized) that only deliver
// the renewal invoice and never touch Stripe: those branches used to
// deliver that invoice with NO fresh re-validation at all, so a cancel (or
// any other resolution) landing between the mint and this call could still
// get a renewal BILL mailed to a customer who no longer has the plan.
// resolveChargeEligibility itself still runs its OWN locked re-check right
// before the real Stripe attempt — this earlier, unlocked check protects
// the fallback paths specifically and is deliberately NOT a substitute for
// that later, authoritative one.
async function checkStillEligibleForRenewalAction(successorId, conn = db) {
  const blocker = await successorActionBlocker(conn, successorId);
  return blocker ? { eligible: false, ...blocker } : { eligible: true };
}

// Everything after the mint transaction commits: resolve consent + a
// chargeable saved method, and either attempt the ONE Stripe charge or
// hand the renewal off to the pay-link + bell fallback. Never throws.
// Self-contained sub-decision, extracted from decideAndCharge (Codex
// round-7 P2 self-review, AGENTS.md L412-418: a genuinely independent
// decision pulled out whole, not a one-use wrapper relocating a single
// branch) — resolves the customer's consented, chargeable saved payment
// method, or null on any resolution failure (never throws).
async function resolveChargeableSavedMethod(customerId, termId) {
  const RecurringCards = require('./recurring-card-on-file');
  try {
    const method = await RecurringCards.resolvePrepayChargeMethod({
      policy: { exemptReason: 'autopay_already_active' },
      customerId,
    });
    return method?.paymentMethodRowId ? method : null;
  } catch (err) {
    // Codex #4971 r29 P2: a lookup FAILURE is not "no saved method" — a
    // momentary database / payment-method outage must never record the
    // terminal no_method skip (which excludes the renewal from leg 7a for
    // good). Distinct result; decideAndCharge defers and retries.
    logger.warn(`[termite-annual-renewal] saved-method resolution failed for term ${termId}: ${err.message}`);
    return { unavailable: true, reason: err.message || 'saved-method lookup failed' };
  }
}

// THE ceiling rule for the automatic renewal charge (P1-5; Codex #4971 r12
// P1). The v3 agreement authorized the FLAT renewal fee — no card surcharge
// on top of it (termite-annual-signature-charge.js's own rule). What the
// charge collects is its cash total (surcharge included) PLUS the account
// credit it applies to the invoice: with auto-apply on, a $249 renewal and
// $100 of credit quotes about $153.32 of cash — under the fee on its own,
// but $253.32 of value in total. So, from the saved-card quote itself
// (quoteInvoiceSavedCardCharge — its cash total and its projected credit;
// the surcharge math is never redone here):
//   cash total + projected credit  <=  fee
// or the charge is not authorized (the pay link instead). When it is, the
// provider boundary gets the SAME numbers: maxAuthorizedTotalCents — which
// stays a CASH ceiling at chargeInvoiceWithSavedCard — is fee − projected
// credit (the consented surcharge on the cash portion is zero), and
// expectedTotal pins the cash total to the quote, so a different credit
// application under the charge's own lock (which changes the cash) refuses
// instead of letting a surcharge ride on the difference. A quote that
// cannot be taken leaves nothing to verify the total against: the charge
// is deferred (never attempted, the fence unclaimed) and leg 7a retries it.
// Returns { unavailable } | { exceeds: true } | { options }.
async function renewalChargeCeiling(successor, method, feeCents) {
  let quote;
  try {
    const StripeService = require('./stripe');
    quote = await StripeService.quoteInvoiceSavedCardCharge(successor.prepay_invoice_id, method.paymentMethodRowId);
  } catch (err) {
    // Codex #4971 r16 P1 (finding 3): a payer assigned to this invoice since
    // the mint (or since the last tick) is a ROUTING fact, not a quote
    // failure — the quote now throws the SAME typed PAYER_BILLED_GUARD
    // chargeInvoiceWithSavedCard itself throws (stripe.js) instead of a
    // plain Error, so it never gets reduced to an undifferentiated
    // 'charge_quote_unavailable' deferral (which the payer can never
    // resolve either, so it retried forever). decideAndCharge routes this
    // into the SAME payer_billed follow-through as its other pre-Stripe
    // skips (deliverInvoiceAndStampSkip).
    if (err?.code === 'PAYER_BILLED_GUARD') return { payerBilled: true };
    logger.warn(`[termite-annual-renewal] pre-charge quote failed for term ${successor.id} — the charge is deferred: ${err.message}`);
    return { unavailable: err.message };
  }
  const cashCents = Math.round(Number(quote?.total) * 100);
  const creditCents = Math.round(Number(quote?.projectedCreditApplied || 0) * 100);
  if (!Number.isFinite(cashCents) || cashCents + creditCents > feeCents) return { exceeds: true };
  return { options: { expectedTotal: cashCents / 100, maxAuthorizedTotalCents: feeCents - creditCents } };
}

// A collections dispute hold (B10) defers the renewal charge. Nothing reached
// Stripe (the saved-card flow releases its attempt row on a pre-charge
// refusal), so this is RETRYABLE and must stay eligible for recovery: it is
// neither a decline, nor a payer refusal, nor a handled outcome. When the
// refusal came from the binding check the Stripe-attempt fence was already
// claimed — hand it back (attempted_at and the write-ahead outcome cleared)
// so leg 7a re-decides the term after the office releases the hold; leg 7b
// would otherwise treat the claimed-never-submitted attempt as a crash and
// send a pay link to the disputing customer.
async function deferRenewalForCollectionHold(successor, conn, { releaseFence }) {
  if (releaseFence) {
    try {
      await conn('annual_prepay_terms')
        .where({ id: successor.id, status: PAYMENT_PENDING_STATUS, renewal_charge_failure_kind: CHARGE_OUTCOME_PENDING })
        .whereNotNull('renewal_charge_attempted_at')
        .whereNull('renewal_charge_claim_retired_at')
        .update({
          renewal_charge_attempted_at: null,
          renewal_charge_failure_kind: null,
          renewal_charge_failure_reason: null,
          renewal_charge_failure_handled_at: null,
        });
    } catch (err) {
      logger.error(`[termite-annual-renewal] failed to release the charge fence for term ${successor.id} after a collection-hold refusal: ${err.message}`);
    }
  }
  await ringRenewalBell(successor, 'ineligible', 'the customer has an active collections billing hold (or it could not be checked); the charge will be retried after the office releases it');
  await stampSweepDeferred(successor, conn);
  return { status: 'deferred', reason: 'collection_hold' };
}

async function decideAndCharge(successor, parentTerm, conn = db) {
  const upfront = await checkStillEligibleForRenewalAction(successor.id, conn);
  if (!upfront.eligible) return handleChargeRefusal(successor, upfront, conn);

  if (!parentTerm.renewal_charge_consent_at) {
    await deliverInvoiceAndStampSkip(successor, 'no_consent', 'The prior term never recorded renewal-charge (Auto Pay) consent.', conn);
    return { status: 'no_consent' };
  }

  const method = await resolveChargeableSavedMethod(successor.customer_id, successor.id);
  if (method?.unavailable) {
    await ringRenewalBell(successor, 'ineligible', `the saved payment method could not be looked up (${method.reason}); the charge will be retried`);
    await stampSweepDeferred(successor, conn);
    return { status: 'deferred', reason: 'saved_method_unavailable' };
  }
  // An active collections DISPUTE hold stops this automatic charge. Nothing
  // has been attempted, so it defers exactly like an unavailable saved
  // method (bell + sweep-deferred stamp) and the sweep retries after the
  // office releases the hold. A lookup failure reads as held (fail closed).
  // The binding recheck under the charge's own connection is the primitive's
  // default hold guard in submitCharge.
  if (await collectionsDisputeHoldBlocks(conn, successor.customer_id)) return deferRenewalForCollectionHold(successor, conn, { releaseFence: false });
  if (!method) {
    await deliverInvoiceAndStampSkip(successor, 'no_method', 'No consented, chargeable saved payment method was found on file.', conn);
    return { status: 'no_method' };
  }

  const prepayAmountCents = Math.round(Number(successor.prepay_amount) * 100);

  // P1-5 / Codex #4971 r12 P1: the ceiling rule (renewalChargeCeiling) — a
  // collected total (cash, surcharge included, plus applied credit) above
  // the flat renewal fee is not authorized by the v3 signature: that
  // customer gets the pay link (showing the exact surcharge) instead of a
  // silent over-collection. Checked BEFORE the attempt fence is stamped.
  const ceiling = await renewalChargeCeiling(successor, method, prepayAmountCents);
  if (ceiling.payerBilled) {
    await deliverInvoiceAndStampSkip(successor, 'payer_assigned', 'A third-party payer is now assigned to this renewal invoice.', conn);
    return { status: 'payer_billed' };
  }
  if (ceiling.unavailable) {
    await stampSweepDeferred(successor, conn);
    return { status: 'deferred', reason: 'charge_quote_unavailable' };
  }
  if (ceiling.exceeds) {
    await deliverInvoiceAndStampSkip(successor, 'surcharge_not_authorized', 'A credit-card surcharge would take the amount collected (with any account credit applied) above the flat renewal fee the v3 agreement quoted, so it was not charged.', conn);
    return { status: 'surcharge_not_authorized' };
  }

  // P0: re-validate eligibility (parent still undecided/'renew', successor
  // still payment_pending, its invoice still open, still inside its own
  // grace deadline) and claim the Stripe-attempt fence ATOMICALLY, under
  // lock — the SAME function the recovery leg (reconcileStuckSuccessors)
  // uses, so a customer decline (or a lapse, or a stale recovery run)
  // racing in between the mint and this exact instant can never reach
  // Stripe from either caller.
  const eligibility = await resolveChargeEligibility(successor.id, conn);
  if (!eligibility.eligible) return handleChargeRefusal(successor, eligibility, conn);

  const StripeService = require('./stripe');
  const submitCharge = () => StripeService.chargeInvoiceWithSavedCard(successor.prepay_invoice_id, method.paymentMethodRowId, {
    customerInitiated: false,
    maxAuthorizedChargeCents: prepayAmountCents,
    ...ceiling.options,
    requireAutopayForCustomerId: successor.customer_id,
    requireSelfPayCustomerId: successor.customer_id,
    // The charge primitive refuses an active collections dispute hold BY
    // DEFAULT (B10) — decideAndCharge also defers ahead of the fence claim,
    // so this is the binding race backstop.
    // Codex #4971 r29 P1: the gate's liveness is re-asserted INSIDE the
    // saved-card flow too — before its credit apply and before its Stripe
    // submission — not only at this closure's entry.
    assertBeforeMoneyMoves: assertRenewalLockAlive,
  });

  let chargeResult;
  try {
    // Codex round-7 P1: resolveChargeEligibility's own row lock, above,
    // already released by the time we get here (chargeInvoiceWithSavedCard
    // opens its OWN internal transaction and cannot accept one of ours, so
    // holding that row lock across a live Stripe network call was never an
    // option). Without something serializing this exact gap, a cancel (or
    // any other parent decision) committed between that lock releasing and
    // this call starting would still get charged. withParentDecisionLock —
    // the SAME advisory lock recordDecision itself takes — closes it: held
    // from immediately before this LAST parent re-check through the actual
    // Stripe submission, so a concurrent recordDecision either finishes
    // first (and this re-check sees it) or waits behind this whole
    // submission (and only then gets to decide).
    if (successor.renewed_from_term_id) {
      const outcome = await withRenewalGate(successor, async () => {
        const refusal = await chargeRefusalUnderGate(successor, conn);
        if (refusal) return { blocked: true, ...refusal };
        // Codex #4971 r15 P1: the gate's own session can die at any point
        // while this async tree runs (a dropped raw connection releases its
        // advisory locks at Postgres's end immediately) — assert it is
        // still alive immediately before the actual Stripe call, not just
        // at the top of this closure.
        assertRenewalLockAlive();
        return { blocked: false, result: await submitCharge() };
      });
      if (outcome.blocked) return handleRefusalAtSubmission(successor, outcome, conn);
      chargeResult = outcome.result;
    } else {
      chargeResult = await submitCharge();
    }
  } catch (err) {
    // Codex #4971 round-3 (item 7 follow-through): leg 7b now treats an
    // attempt row WITHOUT submission evidence as "never reached Stripe" —
    // which a guard refusal inside chargeInvoiceWithSavedCard (Auto Pay off,
    // method changed, payer-billed) also leaves behind. This failure path
    // has already belled staff and, where allowed, sent the pay link, so
    // once it did, mark the leg handled; otherwise 7b retries it.
    // A collections dispute hold (B10) caught by the binding check under the
    // charge locks is a pre-Stripe, RETRYABLE refusal — never a decline, a
    // payer refusal or a handled outcome (see deferRenewalForCollectionHold).
    if (isCollectionHoldRefusal(err)) return deferRenewalForCollectionHold(successor, conn, { releaseFence: true });
    if (await handleChargeFailure(successor, err, conn)) await stampNeverReachedStripeHandled(successor, conn);
    return { status: 'failed', reason: err.message };
  }

  // P2-3: the charge committed once the call returned — re-read the
  // invoice and classify it exactly like the sibling's
  // classifyVerifiedCharge, never assumed successful just because Stripe
  // didn't throw.
  try {
    const fresh = await conn('invoices').where({ id: successor.prepay_invoice_id }).first('status', 'payment_method');
    const { classifyVerifiedCharge } = require('./termite-annual-signature-charge')._private;
    const verified = classifyVerifiedCharge(fresh, chargeResult);
    if (verified.status === 'paid') {
      logger.info(`[termite-annual-renewal] renewal charge succeeded for term ${successor.id} (invoice ${successor.prepay_invoice_id})`);
      await clearChargeOutcomePending(successor, conn);
      return { status: 'charged' };
    }
    if (verified.status === 'processing') {
      // Bank ACH debit initiated — the payment webhook activates the
      // successor when it clears. Not a failure; nothing to bell or send.
      // The write-ahead 'outcome_pending' stays: the paid sync clears it,
      // and a debit that fails instead is followed through by leg 7d.
      logger.info(`[termite-annual-renewal] renewal charge pending (bank ACH) for term ${successor.id} (invoice ${successor.prepay_invoice_id})`);
      return { status: 'pending' };
    }
    // 'card_incomplete' (an unfinished card intent) or 'unexpected' — the
    // charge call didn't throw, but the invoice doesn't read paid either.
    // Never assume success or failure; bell staff to reconcile against
    // Stripe directly. No pay link — money may still be moving.
    // Persisted + retried by leg 7c if the bell does not land (chokepoint).
    await followThroughChargeOutcome(successor, 'ambiguous', verified.reason || 'post-charge status unverified', conn, { first: true });
    return { status: 'ambiguous', reason: verified.reason || 'post_charge_status_unverified' };
  } catch (err) {
    logger.error(`[termite-annual-renewal] post-charge invoice read failed for term ${successor.id}: ${err.message}`);
    await followThroughChargeOutcome(successor, 'ambiguous', 'post_charge_status_unverified', conn, { first: true });
    return { status: 'ambiguous', reason: 'post_charge_status_unverified' };
  }
}

// Codex #4971 r6 P1 (audit, structural rule: a decision computed before the
// gate is never the authority for an action under it): the charge's last
// check runs UNDER the held gate and re-reads BOTH terms — the successor
// itself (still payment_pending and not dispute-suspended: a withdrawal or
// a lapse that won the gate first leaves nothing to charge) and its parent
// (parentRefusalForSuccessor). The invoice's own collectibility is
// re-judged by the charge's claim under the invoice row lock. null = charge.
async function chargeRefusalUnderGate(successor, conn) {
  const fresh = await conn('annual_prepay_terms').where({ id: successor.id }).first();
  if (fresh?.status !== PAYMENT_PENDING_STATUS) {
    return { eligible: false, reason: `successor_status_${fresh?.status || 'missing'}`, durable: true };
  }
  // Codex #4971 pre-push P1: disputed after the pre-check — the dispute owns
  // it. Not a durable refusal (that would route to the withdrawal): nothing
  // is charged, withdrawn or belled.
  if (successorDisputeSuspended(fresh)) return { eligible: false, reason: 'successor_dispute_suspended', disputeOwned: true };
  // Codex #4971 r7 P1: this claim was retired by leg 7b's recovery (or its
  // outcome was already recorded) — the fallback owns it; never submit.
  if (fresh.renewal_charge_claim_retired_at
    || (fresh.renewal_charge_failure_kind && fresh.renewal_charge_failure_kind !== CHARGE_OUTCOME_PENDING)) {
    return { eligible: false, reason: 'charge_claim_retired', superseded: true };
  }
  const freshParent = await conn('annual_prepay_terms').where({ id: fresh.renewed_from_term_id }).first();
  const parentEligibility = await parentRefusalForSuccessor(conn, fresh, freshParent);
  if (!parentEligibility.eligible) return parentEligibility;
  // Codex #4971 r11 P1: the fence was claimed inside the grace window, but a
  // worker delayed past midnight ET before this gate (pool contention, a
  // paused process) must not charge a window that has since closed — the
  // grace lapse owns it. Durable: handleRefusalAtSubmission withdraws, and
  // the withdrawal leaves a presented renewal to the lapse.
  const graceRefusal = graceWindowRefusal(fresh);
  return graceRefusal ? { eligible: false, reason: graceRefusal.reason, durable: true } : null;
}

// The parent re-check under withParentDecisionLock refused AFTER the
// Stripe-attempt fence was claimed — the card is never tried for this
// successor again (at-most-once). A DURABLE refusal terminalizes the
// successor right here (chokepoint C, item 1). A transient one (the
// parent's own invoice in dispute) is left exactly as leg 7b selects it
// (attempted, never submitted): 7b re-checks the parent each tick, sends
// the pay link once the dispute resolves in the parent's favour, and
// retires the successor if it resolves the other way or its grace window
// closes first.
async function handleRefusalAtSubmission(successor, refusal, conn) {
  // Recovery (leg 7b) retired this claim while it waited for the gate: the
  // fallback owns the renewal — nothing to bell, withdraw or send here.
  if (refusal.superseded) return { status: 'claim_retired', reason: refusal.reason };
  if (refusal.disputeOwned) return { status: 'deferred', reason: refusal.reason };
  const reason = `the parent was decided elsewhere immediately before the charge attempt (${refusal.reason})`;
  if (refusal.durable) {
    const retired = await withdrawRenewalSuccessor(successor, reason, conn);
    return { status: 'ineligible', reason: refusal.reason, retired };
  }
  await ringRenewalBell(successor, 'ineligible', reason);
  return { status: 'ineligible', reason: refusal.reason };
}

async function handleChargeFailure(successor, err, conn = db) {
  // Codex #4971 r10 P1: refused at the provider boundary because the account
  // was deleted — not a decline (no pay link, no charge-failed notice): the
  // renewal is withdrawn (its under-gate re-check, successorRecoveryRefusal,
  // reads the same deletion). Handled once the withdrawal is not deferred.
  if (err?.code === 'CUSTOMER_DELETED') {
    return (await withdrawRenewalSuccessor(successor, 'the customer deleted their account before the renewal charge', conn)) !== 'deferred';
  }
  // Codex #4971 r15 P1: the parent-decision lock session died before Stripe
  // was ever reached (assertParentDecisionLockAlive, right before
  // submitCharge()) — never attempted, not a decline. Leave the claim fence
  // exactly as a mid-submission crash would (claimed_at set, no submission
  // evidence, not stamped handled) so leg 7b's own recovery lease picks it
  // up and re-judges it fresh, the same as it already does for a crash.
  if (err?.code === 'PARENT_DECISION_LOCK_LOST') {
    logger.warn(`[termite-annual-renewal] renewal charge for term ${successor.id} deferred — the parent-decision lock session was lost before Stripe was reached; leg 7b will recover the claimed attempt`);
    return false;
  }
  const { classifyChargeError } = require('./termite-annual-signature-charge')._private;
  const classification = classifyChargeError(err);
  logger.error(`[termite-annual-renewal] renewal charge failed for term ${successor.id}: ${classification.status} (${classification.reason})`);
  return followThroughChargeOutcome(successor, chargeFailureFollowThroughKind(classification, err), classification.reason, conn, { first: true });
}

// What a failed charge owes the customer and staff:
//   ambiguous     money may be moving — a bell only, NEVER a pay link beside
//                 a possibly-successful charge (the sibling's own rule)
//   payer_refused the payer-billed guard (a payer was assigned after the
//                 mint): neither the homeowner's card nor the homeowner's
//                 pay link may collect a payer's AR — a bell only
//   declined      a GENUINE Stripe decline (err.wavesCardDecline — the one
//                 marker every billing path uses to tell a real processor
//                 decline from a guard refusal): pay link + bell + the
//                 customer "payment didn't go through" notice (P1-5)
//   refused       any other refusal (Auto Pay inactive, the default method
//                 changed, another payment in flight): pay link + bell
function chargeFailureFollowThroughKind(classification, err) {
  if (classification.status === 'ambiguous') return 'ambiguous';
  if (classification.status === 'deferred') return 'payer_refused';
  return err?.wavesCardDecline ? 'declined' : 'refused';
}

const FOLLOW_THROUGH_BELL_KIND = { ambiguous: 'ambiguous', payer_refused: 'payer_billed', declined: 'declined', refused: 'refused' };
const FOLLOW_THROUGH_SENDS_PAY_LINK = new Set(['declined', 'refused']);

// Codex #4971 pre-push P1 — THE follow-through chokepoint for a charge
// outcome that reached Stripe but did not pay (a decline, a refusal, an
// ambiguous or unverifiable result). Its obligations are persisted FIRST
// (renewal_charge_failure_kind/_reason, 20260927020000), then carried out,
// and marked done (renewal_charge_failure_handled_at) only once the staff
// bell persisted and — where one is owed — the pay link verifiably went
// out. A submitted attempt is outside every other recovery leg (7a: the
// fence is claimed; 7b: it reached Stripe), so a lost bell or a failed
// delivery used to be dropped for good; leg 7c now re-runs this for any
// outcome still not done. NEVER retries the charge. The pay link is re-sent
// only while the invoice carries no delivery stamp (chokepoint A — the
// customer is never texted the invoice twice), and the customer's
// charge-failed notice goes out on the first run only.
async function followThroughChargeOutcome(successor, kind, reason, conn, { first = false } = {}) {
  if (first) await recordChargeFollowThroughOwed(successor, kind, reason, conn);
  let delivered = true;
  let bellKind = FOLLOW_THROUGH_BELL_KIND[kind] || 'ambiguous';
  if (FOLLOW_THROUGH_SENDS_PAY_LINK.has(kind)) {
    // The pay-link chokepoint asks leg 7b's "may a recovery leg still
    // deliver?" question under the parent's gate — on leg 7c's retries AND
    // on the first run, which runs right after the charge released that
    // gate: exactly when a cancel or refund that queued behind it lands.
    const delivery = await deliverRenewalInvoice(successor, conn, 'the renewal charge did not go through');
    if (delivery?.code === 'delivery_refused') return settleWithheldFollowThrough(successor, delivery.outcome, conn);
    // A payer assigned since the charge: the homeowner pay link is not owed
    // (nothing was sent) — staff are told to route it to the payer instead.
    if (delivery?.code === 'payer_billed') bellKind = 'payer_billed';
    delivered = Boolean(delivery?.ok) || delivery?.code === 'payer_billed';
  }
  const belled = await ringRenewalBell(successor, bellKind, reason, { delivered });
  // Codex #4971 r15 P2: the customer decline notice is its OWN persisted
  // follow-through obligation, not a fire-once side effect of `first`.
  // sendCustomerMessage can return a non-throwing { blocked: true,
  // deferred: true } during quiet hours (and withPayLinkClearance can
  // itself withhold with a 'deferred' reason on a dispute-suspended pay
  // link) — this used to be swallowed, `done` was computed from the bell
  // and pay-link delivery alone, and recovery re-runs with first=false, so
  // the notice was NEVER retried once the first attempt landed inside a
  // quiet window. Retry on every tick until it is durably stamped sent, and
  // fold that into `done` so a deferred notice keeps the row eligible for
  // leg 7c instead of being marked handled with the customer never told.
  const noticeOwed = kind === 'declined' && bellKind === 'declined';
  let noticeSettled = true;
  if (noticeOwed && !successor.renewal_charge_failed_notice_sent_at) {
    const noticeOutcome = await sendRenewalChargeFailedNotice(successor, conn).catch((noticeErr) => {
      logger.warn(`[termite-annual-renewal] charge-failed customer notice failed for term ${successor.id}: ${noticeErr.message}`);
      return null;
    });
    noticeSettled = await recordChargeFailedNoticeOutcome(successor, noticeOutcome, conn);
  }
  const done = Boolean(belled) && delivered && noticeSettled;
  if (done) {
    await markChargeFollowThroughHandled(successor, conn);
  } else {
    await stampSweepDeferred(successor, conn);
  }
  return done;
}

// Codex #4971 r16 P2 (finding 8): an ALLOWLIST of TERMINAL reasons — retrying
// changes nothing for exactly these (no phone on file, no pay url, a missing
// template, a third-party payer now owns the bill, or withPayLinkClearance's
// 'handled' — the renewal no longer owes a notice at all).
const CHARGE_FAILED_NOTICE_TERMINAL_REASONS = new Set(['no_phone', 'no_pay_url', 'missing_template', 'payer_billed', 'handled']);

// Whether the notice attempt just run means nothing more should be
// retried: true once ACCEPTED (sendCustomerMessage's own "definitely sent"
// shape) and durably stamped, or once withheld/failed for one of the
// TERMINAL reasons above. False — must retry later — for a genuine defer
// (quiet hours, or withPayLinkClearance's 'deferred' on a dispute-suspended
// pay link), an explicit `retryable` flag, no outcome at all (the attempt
// threw before producing one), OR (Codex #4971 r16 P2) any reason NOT on
// the terminal allowlist — this used to default to "settled" for anything
// unrecognized, which silently dropped the notice for good the first time
// renewalPayerRouting's own lookup failed (withPayLinkClearance's
// 'payer_unverifiable' — its own doc says "fail closed, retry later") or
// any other outcome shape this file hasn't seen yet. Never silently
// counted as settled.
function chargeFailedNoticeMustRetry(outcome) {
  if (!outcome) return true;
  const deliveryOutcome = outcome.deliveryOutcome || (outcome.sent === true ? 'accepted' : undefined);
  if (deliveryOutcome === 'accepted') return false;
  if (outcome.retryable === true) return true;
  if (outcome.deferred === true) return true;
  if (outcome.reason === 'deferred') return true;
  return !CHARGE_FAILED_NOTICE_TERMINAL_REASONS.has(outcome.reason);
}

async function recordChargeFailedNoticeOutcome(successor, outcome, conn) {
  // sendCustomerMessage always names its outcome (#4338 — same normalization
  // scheduled-sms-delivery.js's own dispatch() applies); a legacy/simplified
  // `sent: true` with no deliveryOutcome at all is still an accepted
  // handoff. An EXPLICIT deliveryOutcome of 'not_sent' (the owner-phone kill
  // switch's `sent: true` suppression) is deliberately NOT accepted.
  const deliveryOutcome = outcome?.deliveryOutcome || (outcome?.sent === true ? 'accepted' : undefined);
  const accepted = deliveryOutcome === 'accepted';
  if (accepted) {
    await conn('annual_prepay_terms').where({ id: successor.id })
      .whereNull('renewal_charge_failed_notice_sent_at')
      .update({ renewal_charge_failed_notice_sent_at: new Date() });
    return true;
  }
  return !chargeFailedNoticeMustRetry(outcome);
}

// The pay-link chokepoint withheld the link: true once this leg is done
// (the successor withdrawn, left to the lapse, or no longer pending —
// marked handled so leg 7c stops), false when it must be retried (the
// chokepoint already rotated the row).
async function settleWithheldFollowThrough(successor, outcome, conn) {
  if (outcome !== 'handled') return false;
  await markChargeFollowThroughHandled(successor, conn);
  return true;
}

async function markChargeFollowThroughHandled(successor, conn) {
  await conn('annual_prepay_terms').where({ id: successor.id }).update({ renewal_charge_failure_handled_at: new Date() });
}

// A known success ends the write-ahead obligation (in-line, the paid sync's
// activation hook, or leg 7d on a settled invoice). Only ever clears
// 'outcome_pending' — a recorded failure kind is left to leg 7c.
async function clearChargeOutcomePending(successor, conn = db) {
  try {
    await conn('annual_prepay_terms')
      .where({ id: successor.id, renewal_charge_failure_kind: CHARGE_OUTCOME_PENDING })
      .update({ renewal_charge_failure_kind: null, renewal_charge_failure_reason: null });
  } catch (err) {
    // Leg 7d clears it from the settled invoice on a later tick.
    logger.warn(`[termite-annual-renewal] could not clear the pending charge outcome for term ${successor.id}: ${err.message}`);
  }
}

async function recordChargeFollowThroughOwed(successor, kind, reason, conn) {
  await conn('annual_prepay_terms').where({ id: successor.id }).update({
    renewal_charge_failure_kind: kind,
    renewal_charge_failure_reason: reason ? String(reason).slice(0, 500) : null,
    renewal_charge_failure_handled_at: null,
  });
}

// Codex #4971 r18 P2: the declined/refused copy states what actually
// happened to the pay link — a failed delivery rings under its own dedupe
// key (ringRenewalBell), so the later successful delivery still rings the
// "sent" copy instead of being deduped behind a stale claim.
function payLinkDeliveryClause(delivered) {
  return delivered
    ? 'The renewal invoice was sent with its pay link instead.'
    : 'The renewal invoice and its pay link could NOT be sent yet — delivery will be retried automatically; check the account if a follow-up alert saying it was sent does not arrive.';
}

const RENEWAL_BELL_COPY = {
  // Codex round-7 P1: the delivery clause is now the dynamic `reason` —
  // built by deliverInvoiceAndStampSkip from deliverRenewalInvoice's OWN
  // verified return value — never a hardcoded "it was sent" regardless of
  // what actually happened.
  // Codex #4971 r22 P2: these bells are payment-method NEUTRAL — the saved
  // method can be a card or a bank account (us_bank_account debit), and a
  // bell that says "card" sends staff troubleshooting the wrong tender.
  no_consent: (successor, reason) => ({
    title: 'Termite annual renewal — no auto-charge consent on file',
    body: `A renewal term for customer ${successor.customer_id} was minted (invoice for $${Number(successor.prepay_amount).toFixed(2)}), but the prior term never recorded renewal-charge consent — the saved payment method was NOT charged. ${reason}`,
  }),
  no_method: (successor, reason) => ({
    title: 'Termite annual renewal — no saved payment method to charge',
    body: `A renewal term for customer ${successor.customer_id} was minted (invoice for $${Number(successor.prepay_amount).toFixed(2)}), but no consented, chargeable saved payment method (card or bank account) was found — nothing was charged. ${reason}`,
  }),
  surcharge_not_authorized: (successor, reason) => ({
    title: 'Termite annual renewal — card on file not charged (surcharge)',
    body: `The payment method on file for customer ${successor.customer_id}'s termite annual renewal (invoice for $${Number(successor.prepay_amount).toFixed(2)}) is a credit card whose surcharge would exceed the flat renewal fee the v3 agreement quoted, so it was not charged. ${reason}`,
  }),
  // Codex #4971 r17 P2: `amount` is the ACTUAL attempted amount (the same
  // attemptedChargeAmount() the customer's own decline SMS uses, read from
  // the durable stripe_invoice_charge_attempts row) — never the full
  // prepay_amount, which overstates what Stripe was asked for whenever
  // account credit reduced the cash amount actually tried.
  declined: (successor, reason, amount, delivered = true) => ({
    title: 'Termite annual renewal — saved payment method declined',
    body: `The renewal charge of $${Number(amount).toFixed(2)} for customer ${successor.customer_id}'s termite annual renewal was declined by the saved payment method on file (card or bank account): ${reason}. ${payLinkDeliveryClause(delivered)} The saved method will NOT be retried automatically.`,
  }),
  refused: (successor, reason, _amount, delivered = true) => ({
    title: 'Termite annual renewal — saved payment method not charged',
    body: `The renewal charge of $${Number(successor.prepay_amount).toFixed(2)} for customer ${successor.customer_id}'s termite annual renewal was not attempted, or could not complete, for a reason other than a decline: ${reason}. ${payLinkDeliveryClause(delivered)} The saved method will NOT be retried automatically.`,
  }),
  // Codex #4971 pre-push P0: the renewal now routes to a third-party payer
  // (assigned after the mint, or recorded by the charge's own payer guard).
  // Neither the homeowner's card nor a homeowner pay link may collect it.
  payer_billed: (successor, reason) => ({
    title: 'Termite annual renewal — now billed to a third-party payer',
    body: `The renewal for customer ${successor.customer_id} (invoice for $${Number(successor.prepay_amount).toFixed(2)}) now routes to a third-party payer (${reason}). The card on file was NOT charged and NO pay link was sent to the homeowner — route this renewal to the payer by hand.`,
  }),
  // Codex #4971 r23 P1: the 45-day notice told the customer a specific fee
  // (persisted as renewal_noticed_fee with that witness); staff then changed
  // the term's prepay_amount before the renewal date. Neither the invoice
  // nor the automatic charge may use a fee the customer was never told —
  // the mint is held (this bell, sweep-deferred) until the term's fee again
  // matches the noticed one.
  fee_changed_after_notice: (parent, reason) => ({
    title: 'Termite annual renewal — fee changed after the renewal notice, auto-renewal on hold',
    body: `Customer ${parent.customer_id}'s termite annual renewal was NOT minted or charged: ${reason}. The customer was notified of the earlier fee. Restore that fee on the term (or agree the new fee with the customer and record it) — the automatic renewal stays on hold until the term's fee matches the noticed fee.`,
  }),
  // Codex #4971 r24 P1: a witnessed 45-day notice with NO frozen fee (a row
  // noticed before renewal_noticed_fee existed) — the fee the customer was
  // told cannot be verified, so nothing is minted or charged until staff
  // record it.
  notice_fee_unfrozen: (parent, reason) => ({
    title: 'Termite annual renewal — noticed fee not on record, auto-renewal on hold',
    body: `Customer ${parent.customer_id}'s termite annual renewal was NOT minted or charged: ${reason}. Confirm the fee the customer was notified of and record it as the term's noticed fee — the automatic renewal stays on hold until then.`,
  }),
  ambiguous: (successor, reason) => ({
    title: 'Termite annual renewal — charge outcome unclear, needs reconciliation',
    body: `The renewal charge of $${Number(successor.prepay_amount).toFixed(2)} for customer ${successor.customer_id}'s termite annual renewal may or may not have gone through (${reason}). Check Stripe and the invoice before collecting any other way — the saved method will NOT be retried automatically.`,
  }),
  // Codex round-1 P0: the eligibility re-check (resolveChargeEligibility)
  // refused to claim the fence — most commonly a customer decline landed
  // between the mint and this attempt, but also a lapse or a stale
  // recovery run. No pay link: a declined customer doesn't want one, and
  // a lapsed successor's own bell (processGraceLapseForTerm) already
  // covers that case.
  ineligible: (successor, reason) => ({
    title: 'Termite annual renewal — charge skipped, no longer eligible',
    body: `The renewal charge for customer ${successor.customer_id}'s termite annual renewal (invoice for $${Number(successor.prepay_amount).toFixed(2)}) was skipped without attempting the card: ${reason}. Check the account — this usually means the renewal was declined or has lapsed since it was minted. The card was NOT charged.`,
  }),
  // Codex #4971 round-3 P1 (item 1, chokepoint C): the successor was
  // withdrawn — never charged, never presented — because its parent became
  // durably ineligible (declined, cancelled, refunded, switched) or its
  // grace window closed first. Its invoice was voided and the renewal term
  // cancelled; no station retrieval and no decision on the prior term.
  // Codex #4971 r4 P1 (item 4b): the renewal payment landed AFTER the
  // prior year stopped authorizing it (a refund, void or other change to
  // the parent while the payment cleared). The renewal is left active.
  paid_after_parent_ended: (successor, reason) => ({
    title: 'Termite annual renewal — paid after the prior plan was cancelled or refunded',
    body: `The renewal payment of $${Number(successor.prepay_amount).toFixed(2)} for customer ${successor.customer_id}'s termite annual plan cleared after the prior plan stopped authorizing it (${reason}). ${successor.status === 'cancelled' ? 'The customer had already declined the NEXT renewal, so the renewal year stands as paid coverage through its end' : 'The renewal was left ACTIVE'}, and the customer was not messaged — refund it or honor it by hand.`,
  }),
  renewal_withdrawn: (successor, reason) => ({
    title: 'Termite annual renewal — withdrawn, renewal invoice voided',
    body: `The renewal for customer ${successor.customer_id} (invoice for $${Number(successor.prepay_amount).toFixed(2)}) is being withdrawn without charging the card: ${reason}. Its renewal invoice is voided — even if it was already sent, it can no longer be paid — and the renewal term cancelled (a separate alert follows if the invoice cannot be voided). No station retrieval was requested, the prior term was left as it is, and the customer was not messaged — review the account and follow up by hand.`,
  }),
  // The same withdrawal, refused at the void: money is already committed
  // against the renewal invoice (settled, or partially covered by account
  // credit). Nothing was voided.
  retire_refused: (successor, reason) => ({
    title: 'Termite annual renewal — could not be withdrawn, needs review',
    body: `The renewal for customer ${successor.customer_id} (invoice for $${Number(successor.prepay_amount).toFixed(2)}) should be withdrawn (${reason}). It was NOT voided — check the payment and the prior term, then resolve the renewal by hand.`,
  }),
  // Codex round-2 P0: the grace-lapse pass refused to void this successor's
  // invoice because a Stripe charge reconciliation is still pending on it —
  // voiding now could void collected revenue and wrongly trigger station
  // retrieval. No void happened; the next sweep tick re-checks and retries.
  lapse_reconciliation_pending: (successor, reason) => ({
    title: 'Termite annual renewal — grace lapse deferred, charge reconciliation pending',
    body: `The termite annual renewal for customer ${successor.customer_id} (invoice for $${Number(successor.prepay_amount).toFixed(2)}) reached its grace deadline, but a Stripe charge reconciliation is still pending on its invoice (${reason}) — voiding it now could void money that was actually collected. It was NOT voided; check Stripe and the invoice before collecting or cancelling any other way. The next sweep will retry automatically once the reconciliation clears.`,
  }),
  // Codex round-5 P0: the grace-lapse pass re-checked settlement right
  // before voiding and found the renewal already settled — by account
  // credit (voidInvoice deliberately allows voiding a credit-covered
  // 'prepaid' invoice) or by a card payment landing in the gap between the
  // lapse starting and the void actually running. NOT voided, no station
  // retrieval requested — informational only; the settlement's own sync
  // already decided coverage correctly.
  lapse_retired_settled: (successor, reason) => ({
    title: 'Termite annual renewal — grace lapse retired, already settled',
    body: `The termite annual renewal for customer ${successor.customer_id} (invoice for $${Number(successor.prepay_amount).toFixed(2)}) reached its grace deadline and started the lapse process, but it turned out to already be settled (${reason}) before the void ran. It was NOT voided and no station retrieval was requested — no action needed.`,
  }),
  // Codex round-7 P1: the grace-lapse pass refused to void or decide the
  // parent because the PARENT was already decided something other than
  // 'cancel' (most commonly an operator recorded 'renew' or
  // 'switch_plan') in the window since this lapse started. No void
  // happened; check the account by hand — this needs a human decision,
  // not another automatic retry.
  // B10: past its grace deadline but held back by a collections DISPUTE hold.
  // Its own kind/key (never 'ineligible'): deferRenewalForCollectionHold rings
  // 'ineligible' for the same term BEFORE the deadline, and that earlier bell
  // must not swallow this later, different warning.
  held_overdue: (successor, reason) => ({
    title: 'Termite annual renewal — past its grace window, held by a collections dispute',
    body: `The termite annual renewal for customer ${successor.customer_id} (invoice for $${Number(successor.prepay_amount).toFixed(2)}) is past its grace window: ${reason}. Nothing was charged and the customer was not messaged.`,
  }),
  lapse_parent_decided_elsewhere: (successor, reason) => ({
    title: 'Termite annual renewal — grace lapse deferred, parent already decided',
    body: `The termite annual renewal for customer ${successor.customer_id} (invoice for $${Number(successor.prepay_amount).toFixed(2)}) reached its grace deadline, but ${reason} — voiding it now could contradict a decision an operator already made. It was NOT voided; check the account and resolve it by hand.`,
  }),
  // Codex #4971 post-push audit round-5 (item 2, #4940's eventAt/
  // supersededByNewer): this lapse's own retrieval raise found a NEWER
  // retrieval instruction already standing on the account — nothing was
  // raised or reopened for THIS lapse's stations. Never silently treated
  // as handled: staff must confirm the newer instruction actually covers
  // this term's stations before the lapse itself is allowed to complete.
  lapse_retrieval_superseded: (successor, reason) => ({
    title: 'Termite annual renewal — grace lapse retrieval superseded, confirm coverage',
    body: `The termite annual renewal for customer ${successor.customer_id} (invoice for $${Number(successor.prepay_amount).toFixed(2)}) reached its grace deadline, but its station-retrieval task was not raised: ${reason}. Confirm the newer instruction actually covers this term's stations before treating this lapse as fully handled.`,
  }),
  // Codex #4971 post-push audit round-6 P1 (item 2): an account-wide
  // retrieval task would count every Waves-owned termite station on the
  // account, but this customer has other live termite coverage — pulling
  // stations automatically here could pull ones that belong to that OTHER
  // coverage. Staff must confirm which stations are actually this lapsed
  // plan's before any are pulled.
  lapse_retrieval_other_coverage: (successor, reason) => ({
    title: 'Termite annual renewal — grace lapse retrieval needs staff review (other coverage on file)',
    body: `The termite annual renewal for customer ${successor.customer_id} (invoice for $${Number(successor.prepay_amount).toFixed(2)}) reached its grace deadline, but no automatic station-retrieval task was raised: ${reason}. Confirm which stations belong to THIS lapsed plan before pulling any — an account-wide task could pull stations that belong to the other coverage.`,
  }),
};

// Returns the underlying notifyAdmin result (or null on failure) so
// callers that must not repeat a side effect (e.g. reconcileStuckSuccessors'
// pay-link delivery) can check `result.deduped` first.
async function ringRenewalBell(successor, kind, reason, { delivered = true } = {}) {
  try {
    const NotificationService = require('./notification-service');
    // Codex #4971 r17 P2: the 'declined' copy needs the ACTUAL attempted
    // amount, not the full prepay_amount — computed only for that kind (the
    // other copy functions ignore the extra argument).
    const amount = kind === 'declined' ? await attemptedChargeAmount(successor) : Number(successor.prepay_amount);
    const copy = (RENEWAL_BELL_COPY[kind] || RENEWAL_BELL_COPY.declined)(successor, reason, amount, delivered);
    return await NotificationService.notifyAdmin('billing', copy.title, copy.body, {
      icon: '⚠️',
      bell: true,
      link: `/admin/customers?customerId=${encodeURIComponent(successor.customer_id)}`,
      dedupeKey: `termite-renewal-charge:${successor.id}:${kind}${delivered ? '' : ':undelivered'}`,
      metadata: { termId: successor.id, customerId: successor.customer_id, reason: reason || null },
    });
  } catch (err) {
    logger.error(`[termite-annual-renewal] bell failed for term ${successor.id}: ${err.message}`);
    return null;
  }
}

// Codex #4971 r5 P1: this is now the EARLY EXIT only — the authoritative
// payer check runs at the invoice claim (invoice.js claimBillToFencedSend,
// under held customer / payer rows). Kept because it routes a payer-billed
// renewal to the staff "route it to the payer" bell before anything is
// claimed, and fails closed (payer_unverifiable) when the lookup errors.
// Codex #4971 pre-push P0 ("preserve payer refusals") — the one homeowner
// pay-link payer check. A payer can be assigned AFTER the mint, and these
// renewal invoices carry no completion-packet marker, so InvoiceService's
// own send path never re-checks the payer for them. Re-resolved right
// before anything reaches the homeowner, with the SAME resolver and shape
// as stripe.js's customer-default PAYER_BILLED_GUARD branch. Returns null
// (self-pay: the homeowner may be billed), 'payer_billed' (a third-party
// payer owns this bill — no homeowner pay link is owed), or
// 'payer_unverifiable' (the lookup failed — fail closed, retry later).
async function renewalPayerRouting(successor, conn = db) {
  try {
    // Codex #4971 r10 P1: the invoice's OWN Bill-To first — a payer stamped
    // at mint stays the payer's bill even after the customer's default payer
    // is cleared (stripe.js refuses its charge under the invoice lock with
    // PAYER_BILLED_GUARD; InvoiceService's send path suppresses it too).
    const invoice = successor.prepay_invoice_id
      ? await conn('invoices').where({ id: successor.prepay_invoice_id }).first('payer_id')
      : null;
    if (invoice?.payer_id) return 'payer_billed';
    const resolved = await require('./payer').resolveForInvoice({
      database: conn, customerId: successor.customer_id, throwOnError: true,
    });
    return resolved?.payerId ? 'payer_billed' : null;
  } catch (err) {
    logger.warn(`[termite-annual-renewal] payer re-check failed for term ${successor.id}: ${err.message}`);
    return 'payer_unverifiable';
  }
}

// Codex #4971 r4 P1 — THE homeowner pay-link chokepoint. Everything that
// puts the renewal pay link in front of the customer goes through
// withPayLinkClearance: the renewal invoice (deliverRenewalInvoice — the
// no-consent / no-method / surcharge skips, a charge follow-through's first
// run and leg 7c, leg 7b's recovery) and the "your payment didn't go
// through" notice (sendRenewalChargeFailedNotice). Every caller used to
// check eligibility on its own and then send — a cancel or refund landing
// in between (during the saved-method lookup, the surcharge quote, the
// Stripe round trip) still got the bill sent. Now, IMMEDIATELY before
// sending and under the PARENT's decision gate (withParentDecisionLock,
// re-entrant), this:
//   1. re-reads the successor — no longer payment_pending (paid, withdrawn,
//      lapsed): nothing is owed, the leg is done ('handled');
//   2. asks refuseRecoveryDelivery's question — a DURABLE refusal (parent
//      durably ineligible, grace window closed) withdraws the successor
//      (chokepoint C); a transient one (the parent's own invoice in
//      dispute) bells and rotates the row;
//   3. routes the payer — a third-party payer owns the bill ('payer_billed':
//      the homeowner link is simply not owed) or the lookup failed
//      ('payer_unverifiable': fail closed, retry later);
// and only then sends. A refusal returns { ok: false, code:
// 'delivery_refused', outcome: 'handled' | 'deferred', withheld: true } — the refusal
// already belled / rotated, so the caller writes nothing beyond its own
// done/retry marker. Sends the customer nothing on any refusal.
async function withPayLinkClearance(successor, conn, context, send) {
  const cleared = async () => {
    const refused = await payLinkRefusal(successor, conn, context);
    if (refused) {
      logger.warn(`[termite-annual-renewal] renewal pay link withheld for term ${successor.id}: ${refused}`);
      return { ok: false, withheld: true, code: 'delivery_refused', outcome: refused, error: `delivery refused (${refused})` };
    }
    const payerRouting = await renewalPayerRouting(successor, conn);
    if (payerRouting) {
      logger.warn(`[termite-annual-renewal] renewal pay link withheld for term ${successor.id}: ${payerRouting}`);
      return { ok: false, withheld: true, code: payerRouting, error: payerRouting };
    }
    return send();
  };
  if (!successor.renewed_from_term_id) return cleared();
  return withRenewalGate(successor, cleared);
}

// null when the pay link may go out; otherwise 'handled' / 'deferred' (see
// withPayLinkClearance).
async function payLinkRefusal(successor, conn, context) {
  const verdict = await payLinkVerdict(successor, conn);
  return verdict ? actOnPayLinkVerdict(successor, verdict, conn, context) : null;
}

// payLinkRefusal's question with NO side effects (the renewal send claim
// asks it before releasing its own queue claim, then acts): null = the pay
// link may go out; else { kind, durable, reason }:
//   handled  the successor left payment_pending — nothing is owed
//   dispute  paid, then disputed back to payment_pending (Codex #4971
//            pre-push P1): the dispute owns it — never a pay link; rotated
//            (no bell) until it resolves either way
//   refused  successorRecoveryRefusal (a deleted account, the parent no
//            longer authorizing it, the grace window closed) — durable
//            withdraws, transient bells and rotates
// `ignoreCollectionHold` is for the CUSTOMER's own payment eligibility
// (renewalPaymentRefusal): a collections dispute hold defers only the
// AUTOMATED pay-link delivery / charge legs, it never blocks the customer
// paying a renewal voluntarily (B10, customer-initiated is exempt).
async function payLinkVerdict(successor, conn, { ignoreCollectionHold = false } = {}) {
  const stillPending = await conn('annual_prepay_terms').where({ id: successor.id, status: PAYMENT_PENDING_STATUS }).first();
  if (!stillPending) return { kind: 'handled', durable: true, reason: 'the renewal is no longer payment_pending' };
  if (successorDisputeSuspended(stillPending)) return { kind: 'dispute', durable: false, reason: 'the renewal payment is under dispute' };
  // Codex #4971 r24 P1: the refusal check reads the row AS RE-READ UNDER THE
  // GATE (stillPending), never the caller's pre-gate object — an
  // annual-prepay edit that won the gate first (a moved successor
  // term_start, say) is visible only in the fresh row, and the stale one
  // would still read as aligned with the parent.
  const refusal = await successorRecoveryRefusal(stillPending, conn, { ignoreCollectionHold });
  return refusal ? { kind: 'refused', durable: Boolean(refusal.retire), reason: refusal.reason, refusal, fresh: stillPending } : null;
}

// Codex #4971 r26 P1 — the pay link's USE, not only its sending. A delivered
// renewal pay link stays in the customer's hands; if the parent is
// cancelled, refunded or moved afterwards, the successor invoice stays
// collectible until the next sweep withdraws it, and the public pay page
// (routes/pay-v2.js) would mint or finalize a payment for a renewal the
// parent no longer backs. Both helpers key on the invoice's own term link
// (invoices.annual_prepay_term_id) so an ordinary invoice costs no query.
async function renewalSuccessorForPayment(invoice, conn = db) {
  if (!invoice?.id || !invoice.annual_prepay_term_id) return null;
  return conn('annual_prepay_terms')
    .where({ id: invoice.annual_prepay_term_id, prepay_invoice_id: invoice.id })
    .whereNotNull('renewed_from_term_id')
    .whereNotNull('annual_plan_version')
    .first();
}

const RENEWAL_NOT_PAYABLE_MESSAGE = 'This renewal can no longer be paid online. Please call or text us and we will sort it out.';

// Read-only: null = payable (or not a renewal at all); else { reason, message }.
// 'handled' (the successor already left payment_pending) is left to the
// invoice's own collectible checks.
async function renewalPaymentRefusal(invoice, conn = db) {
  const successor = await renewalSuccessorForPayment(invoice, conn);
  if (!successor) return null;
  const verdict = await payLinkVerdict(successor, conn, { ignoreCollectionHold: true });
  if (!verdict || verdict.kind === 'handled') return null;
  return { reason: verdict.reason, message: RENEWAL_NOT_PAYABLE_MESSAGE };
}

// The money-moving step (the pay page's finalize): re-checked UNDER the
// renewal gate and held through pay(), exactly like the automatic charge —
// a parent change waits for it, or is seen by it. Throws code
// RENEWAL_NOT_PAYABLE when refused.
async function withRenewalPaymentClearance(invoice, pay, conn = db) {
  const successor = await renewalSuccessorForPayment(invoice, conn);
  if (!successor) return pay();
  return withRenewalGate(successor, async () => {
    const refusal = await renewalPaymentRefusal(invoice, conn);
    if (refusal) throw Object.assign(new Error(refusal.message), { code: 'RENEWAL_NOT_PAYABLE', reason: refusal.reason });
    assertRenewalLockAlive();
    return pay();
  });
}

async function actOnPayLinkVerdict(successor, verdict, conn, context) {
  if (verdict.kind === 'handled') return 'handled';
  if (verdict.kind === 'dispute') {
    await stampSweepDeferred(successor, conn);
    return 'deferred';
  }
  return actOnRecoveryRefusal(verdict.fresh || successor, verdict.refusal, conn, context);
}

// Codex #4971 r11 P1 — the renewal send's AUTHORITATIVE clearance, run by
// invoice.js claimRenewalInvoiceForSend: the claim EVERY send of a renewal
// invoice goes through, the immediate paths AND the scheduled-send worker
// (a send deferred by quiet hours or a retry is claimed hours later; the
// clearance withPayLinkClearance ran when it was queued is only an early
// exit). Under the renewal gate (first; re-entrant from inside
// withPayLinkClearance) the successor is re-judged by payLinkVerdict — a
// parent cancelled / refunded, an account deleted, a dispute, the grace
// window closed. Clear: `claim()` runs (the Bill-To fence and the claim,
// under the held gate — lock order gate, then the customer / payer rows).
// Refused: `release(verdict)` first gives back a worker's queue claim (so
// a durable withdrawal can void the invoice; a transient hold re-queues it),
// then the refusal is acted on exactly as the clearance would (withdraw, or
// bell + rotate), and the send is refused before any provider is contacted
// (renewalSendWithheldError). A successor no longer payment_pending owes no
// pay link, but its invoice's own claim checks (paid / void) already answer
// that — the claim runs as before.
async function withRenewalSendClearance(successorId, { claim, release }) {
  const successor = await db('annual_prepay_terms').where({ id: successorId }).first();
  if (!successor?.renewed_from_term_id) return claim();
  return withRenewalGate(successor, async () => {
    const verdict = await payLinkVerdict(successor, db);
    if (!verdict || verdict.kind === 'handled') return claim();
    await release(verdict);
    const outcome = await actOnPayLinkVerdict(successor, verdict, db, 'the scheduled renewal invoice was due to be sent');
    throw renewalSendWithheldError(successor, verdict, outcome);
  });
}

// A pre-provider refusal (deliveryNeverAttempted — invoice.js's convention
// for "definitely not sent"), so no caller reads it as an ambiguous
// delivery.
function renewalSendWithheldError(successor, verdict, outcome) {
  return Object.assign(new Error(`Renewal invoice for term ${successor.id} withheld — ${verdict.reason} (${outcome})`), {
    code: 'renewal_send_withheld', deliveryNeverAttempted: true, withheldOutcome: outcome,
  });
}

// Delivers the renewal invoice (with its pay link) at most once — through
// the clearance above, and only while the invoice carries no delivery stamp
// (chokepoint A: the customer is never texted the invoice twice; a stamped
// invoice returns { ok: true, alreadyDelivered: true }). Best-effort: never
// throws, and a delivery failure never blocks the caller's bell.
async function deliverRenewalInvoice(successor, conn = db, context = 'the renewal invoice was due to be sent') {
  return withPayLinkClearance(successor, conn, context, async () => {
    if (await renewalInvoiceAlreadyDelivered(successor, conn)) return { ok: true, alreadyDelivered: true };
    return sendRenewalInvoice(successor);
  });
}

async function sendRenewalInvoice(successor) {
  try {
    const InvoiceService = require('./invoice');
    // Codex #4971 r15 P1: this send runs under withRenewalGate — assert the
    // lock session is still alive immediately before the provider handoff,
    // not just when the gate was first taken (a dropped connection releases
    // its advisory locks the instant it happens, wherever fn() is by then).
    assertRenewalLockAlive();
    // Codex #4971 pre-push P1: firstDeliveryOnly — invoice.js's ATOMIC
    // first-delivery guard. The stamps were read just above, but a staff or
    // scheduled send can complete in between; the claim flip itself
    // (whereNull sent_at/sms_sent_at/email_sent_at) then refuses instead of
    // texting the customer twice.
    const result = await InvoiceService.sendViaSMSAndEmail(successor.prepay_invoice_id, {
      firstDeliveryOnly: true,
      payUrlParams: {
        source: 'termite_annual_renewal', saveCard: '1', saveRequired: '1', billingTerm: 'prepay_annual',
      },
    });
    if (result?.code === 'COLLECTION_HOLD_DEFER') {
      // The direct sender refuses a pay link while the customer has a dispute
      // hold (retryable, never terminal): the invoice stays unsent and the
      // renewal legs' own retry (leg 7a / the sweep) delivers it after release.
      logger.info(`[termite-annual-renewal] renewal invoice for term ${successor.id} held: collections dispute hold - delivered after release`);
    } else if (!result?.ok) {
      logger.warn(`[termite-annual-renewal] renewal invoice delivery not ok for term ${successor.id}: ${result?.error || 'unknown'}`);
    }
    return result;
  } catch (err) {
    if (err?.code === 'already_delivered') return alreadyDeliveredOutcome(successor, err);
    logger.error(`[termite-annual-renewal] renewal invoice delivery failed for term ${successor.id}: ${err.message}`);
    return { ok: false, code: err?.code || null, error: err.message };
  }
}

// invoice.js refused a first delivery because the row already looks
// delivered (invoiceAlreadyDeliveredError, code 'already_delivered' — its
// alreadyDeliveredForFirstSend also counts a sent/viewed/overdue STATUS).
// Counted as delivered ONLY on persisted delivery evidence (chokepoint A's
// stamps); a status alone is not proof it reached the customer, so that
// case stays a transient failure the caller rotates and retries.
async function alreadyDeliveredOutcome(successor, err) {
  const invoice = await db('invoices').where({ id: successor.prepay_invoice_id }).first(...INVOICE_EVIDENCE_COLUMNS);
  if (classifyRenewalInvoice(invoice).delivered) {
    logger.info(`[termite-annual-renewal] renewal invoice for term ${successor.id} was already delivered by another send — not sent again`);
    return { ok: true, alreadyDelivered: true };
  }
  return { ok: false, code: 'already_delivered_unverified', error: err.message };
}

// The templated "your renewal payment didn't go through" notice — only
// ever queued from handleChargeFailure on a GENUINE Stripe decline, never
// from a no-consent/no-method/surcharge skip or a guard refusal (nothing
// was attempted against Stripe, or the refusal wasn't the card's fault).
// Best-effort, never throws to the caller (its own caller already wraps it
// in .catch as a second layer). Sends only through the ordinary gated
// customer-messaging pipeline — nothing here bypasses quiet hours,
// opt-outs, or template enable state.
async function sendRenewalChargeFailedNotice(successor, conn = db) {
  // It carries the homeowner pay URL — the same clearance as the pay link
  // (eligibility under the parent's gate, then the payer guard).
  const outcome = await withPayLinkClearance(successor, conn, 'the renewal charge was declined', () => composeAndSendChargeFailedNotice(successor));
  if (outcome?.withheld) return { sent: false, reason: outcome.code };
  return outcome;
}

// Codex #4971 r5 P1 (c): the text carries the homeowner pay URL, so it
// hands off under the invoice's own Bill-To send claim
// (invoice.js withPayLinkSendClaim — the same fence the renewal invoice
// send takes): the customer default payer is re-resolved under the held
// customer / payer rows, and while the provider has the text the invoice
// reads as in flight to every payer writer. Not a second mechanism: the
// claim, the lock set and the in-flight test are the invoice send's own.
async function composeAndSendChargeFailedNotice(successor) {
  const customer = await db('customers').where({ id: successor.customer_id }).first();
  if (!customer?.phone) return { sent: false, reason: 'no_phone' };
  const handed = await require('./invoice').withPayLinkSendClaim(
    successor.prepay_invoice_id,
    (invoice) => sendChargeFailedText(successor, customer, invoice),
  );
  if (handed?.code === 'payer_billed') return { sent: false, reason: 'payer_billed' };
  return handed;
}

// The amount the failed charge actually asked Stripe for (Codex #4971 r13
// P1, AGENTS.md: a customer-visible amount matches what was sent) — with
// account credit applied, the card was tried for the reduced cash balance
// (a $249 renewal with $100 of credit tries $149), not the plan fee. Read
// from the durable attempt row, whose amount stripe.js writes at submission
// (commitInvoiceSavedCardChargeSubmission: the cash total after credit,
// surcharge included). Falls back to the invoice's balance due, then the
// fee, when no submitted attempt can be read.
async function attemptedChargeAmount(successor, invoice) {
  try {
    const attempt = await whereAttemptSubmitted(
      db('stripe_invoice_charge_attempts as a').where('a.invoice_id', successor.prepay_invoice_id),
    ).orderBy('a.created_at', 'desc').first('a.amount');
    if (attempt?.amount != null && Number.isFinite(Number(attempt.amount))) return Number(attempt.amount);
  } catch (err) {
    logger.warn(`[termite-annual-renewal] attempted-amount read failed for term ${successor.id}: ${err.message}`);
  }
  if (invoice?.total != null) return require('./invoice-helpers').invoiceAmountDue(invoice);
  return Number(successor.prepay_amount);
}

async function sendChargeFailedText(successor, customer, invoice) {
  const { publicPortalUrl } = require('../utils/portal-url');
  const payUrl = invoice?.token ? `${publicPortalUrl()}/pay/${invoice.token}` : null;
  if (!payUrl) return { sent: false, reason: 'no_pay_url' };
  const { renderSmsTemplate } = require('./sms-template-renderer');
  const attempted = await attemptedChargeAmount(successor, invoice);
  const body = await renderSmsTemplate(RENEWAL_CHARGE_FAILED_SMS_KEY, {
    first_name: customer.first_name || 'there',
    amount: attempted.toFixed(2),
    pay_url: payUrl,
  }, { workflow: 'termite_annual_renewal_charge_failed', entity_type: 'annual_prepay_term', entity_id: successor.id });
  if (!body) return { sent: false, reason: 'missing_template' };
  // Codex #4971 r15 P1: same assertion as the pay-link send — this notice
  // runs under withRenewalGate (withPayLinkClearance -> withRenewalGate)
  // too, and must never reach the provider once the lock session is lost.
  assertRenewalLockAlive();
  const { sendCustomerMessage } = require('./messaging/send-customer-message');
  return sendCustomerMessage({
    to: customer.phone,
    body,
    channel: 'sms',
    audience: 'customer',
    purpose: 'payment_failure',
    customerId: customer.id,
    identityTrustLevel: 'phone_matches_customer',
    entryPoint: 'termite_annual_renewal_charge_failed',
    consentBasis: {
      status: 'opted_in',
      source: 'customer_service_notifications',
      capturedAt: customer.updated_at || customer.created_at || new Date().toISOString(),
    },
    metadata: { original_message_type: RENEWAL_CHARGE_FAILED_SMS_KEY, annual_prepay_term_id: successor.id },
  });
}

async function processRenewalCandidates({ conn = db, limit = 200, today = etDateString(), counts }) {
  try {
    const candidates = await whereRenewalCandidate(conn('annual_prepay_terms as t'), today)
      // Chokepoint D: a parent the mint keeps refusing (ineligible under
      // lock, an overlapping third-party term, an invalid fee) rotates to
      // the back instead of re-occupying this page ahead of newer parents.
      .orderByRaw('t.renewal_sweep_deferred_at asc nulls first')
      .orderBy('t.term_end', 'asc')
      .select('t.*')
      .limit(limit);
    counts.candidatesScanned = candidates.length;
    for (const parent of candidates) {
      try {
        const mint = await mintRenewalSuccessor(parent.id, conn, today);
        if (!mint) { counts.skipped += 1; await stampSweepDeferred(parent, conn); continue; }
        if (!mint.minted) { counts.skipped += 1; continue; } // another run already minted + decided this one
        counts.minted += 1;
        const outcome = await decideAndCharge(mint.successor, parent, conn);
        if (outcome.status === 'charged') counts.charged += 1;
        else if (outcome.status === 'failed') counts.failed += 1;
        else counts.skipped += 1;
      } catch (err) {
        counts.failed += 1;
        logger.error(`[termite-annual-renewal] renewal processing failed for parent term ${parent.id}: ${err.message}`);
        await stampSweepDeferred(parent, conn);
      }
    }
  } catch (err) {
    logger.error(`[termite-annual-renewal] candidate scan failed: ${err.message}`);
  }
}

// ---- pass 5: grace lapse ------------------------------------------------

// An unpaid renewal successor past its own payment grace deadline (per the
// v3 agreement's own text: "if it is not paid within 30 days coverage
// lapses and stations are retrieved") whose renewal invoice was actually
// presented to the customer voids the invoice — cascading the term to
// 'cancelled' through the EXISTING invoice-void -> AnnualPrepayRenewals.
// syncTermForInvoicePayment path (invoice.js voidInvoice already calls
// it) — no parallel status-flip is written here for the successor. The
// SAME tick records the decided lapse on the PARENT (P2-1):
// recordDecision('cancel') — the exact 'cancelled' + renewal_decision=
// 'cancel' shape coveredTermsAsOf's decidedCoveredAndPaid branch already
// models for every other annual-prepay lapse.
//
// P1-2: the deadline is graceDeadlineFor(term) — GRACE_DAYS from whichever
// is LATER of the successor's own term_start or its created_at (ET date) —
// the SAME formula coveredTermsAsOf's grace-coverage branch (P2-4) reads,
// so coverage and the lapse can never disagree about the exact cutoff day.
// Anchoring on the LATER of the two means a successor minted well after its
// nominal term_start (a backlog processed in one sweep run) still gets a
// full grace window from when it actually came into existence — which also
// means a successor minted THIS tick can never lapse in the SAME run (its
// created_at is today, so its deadline is at least GRACE_DAYS out).
//
// "Presented to the customer" = a charge attempt that actually REACHED
// Stripe (renewal_charge_attempted_at IS NOT NULL AND a
// stripe_invoice_charge_attempts row exists for the invoice — Codex
// round-7 P1: attempted_at alone is claimed BEFORE the Stripe call, so it
// is not by itself evidence of anything reaching the customer; see leg 7b)
// OR its invoice carries persisted delivery evidence (a sent_at /
// sms_sent_at / email_sent_at stamp — chokepoint A's "delivered"; a
// 'scheduled' or 'sending' status alone is not). Without this, a successor that fell through every notification
// path (a crash before decideAndCharge ever ran — pass 7a — or one whose
// claimed attempt never reached Stripe — pass 7b) would lapse and trigger
// station retrieval against a customer who was never told anything was
// due.
//
// At-most-once by construction: a cancelled term no longer matches this
// scan's `status = 'payment_pending'` filter, voidInvoice's own re-entry on
// an already-void invoice is an idempotent repair (no-op past the first
// success), the station-retrieval task's own dedupeKey is a third,
// independent safety net, and recordDecision('cancel') on the parent is
// itself idempotent (whereIn(ACTIVE_STATUSES) AND renewal_decision IS
// NULL). Codex round-2 P1: `whereNull('t.renewal_lapse_started_at')`
// excludes a lapse THIS pass, or a prior tick, already started — a
// started-but-not-completed row is the recovery pass's job exclusively
// (reconcileMissedLapseEffects below), never re-attempted from scratch
// here.
// Renewals past their grace deadline whose lapse is held back by a collections
// DISPUTE hold (B10): tell staff once (ringRenewalBell dedupes per term/kind)
// that the lapse is waiting on the hold, so a long-running dispute is visible
// instead of silent. Best-effort, bounded.
const HELD_RENEWAL_BELL_SCAN_LIMIT = 50;
async function bellHeldOverdueRenewals({ conn, counts }) {
  try {
    // Own alias ('tt', not the scans' 't') so this stays a separate query.
    const { termiteRenewalGraceDeadlineSql } = require('./annual-prepay-renewals');
    const deadlineSql = termiteRenewalGraceDeadlineSql('tt');
    const held = await conn('annual_prepay_terms as tt')
      .whereNotNull('tt.annual_plan_version')
      .whereNotNull('tt.renewed_from_term_id')
      .where('tt.status', PAYMENT_PENDING_STATUS)
      .whereNull('tt.dispute_suspended_at')
      .whereNull('tt.renewal_lapse_started_at')
      .whereExists(function collectionsDisputeHold() {
        require('./collections/collection-hold').disputeHoldExistsSql(this, 'tt.customer_id');
      })
      .whereRaw(`${deadlineSql} < ?`, [etDateString()])
      // Skip terms staff was already told about THIS warning (only the
      // ':held_overdue' key — the pre-grace ':ineligible' bell from
      // deferRenewalForCollectionHold is a different alert): ringRenewalBell dedupes on
      // this exact key, so a term that already has its bell would only burn
      // a slot in the bounded page. Without this the same first 50 rows come
      // back every day and a backlog past 50 never gets its alerts; with it
      // each daily pass moves on to the next unbelled 50 until all are told.
      .whereNotExists(function alreadyBelled() {
        this.select(1).from('notifications as n')
          .where('n.recipient_type', 'admin')
          .whereRaw("n.metadata->>'dedupeKey' = 'termite-renewal-charge:' || tt.id::text || ':held_overdue'");
      })
      .orderByRaw(`${deadlineSql} asc, tt.id asc`) // most overdue first, stable
      .select('tt.*')
      .limit(HELD_RENEWAL_BELL_SCAN_LIMIT);
    counts.graceHeldByCollectionsHold = held.length;
    for (const term of held) {
      await ringRenewalBell(term, 'held_overdue', 'the renewal is past its grace window but the customer has an active collections dispute hold, so it will not be lapsed or withdrawn until the office releases the hold');
    }
  } catch (err) {
    logger.warn(`[termite-annual-renewal] held-overdue renewal bell scan failed: ${err.message}`);
  }
}

async function processGraceLapses({ conn = db, limit = 200, counts }) {
  try {
    // Codex round-7 P1 (2nd audit round): the deadline test used to run
    // ONLY in JS, after an over-fetched page (limit*2) ordered by
    // term_start — a backlog of NOT-YET-DUE rows (early term_start, but
    // still within their own grace window) fills that page and the
    // per-row skip trims them back out, but the LIMIT itself never grows:
    // a genuinely overdue row past the over-fetch cutoff could be starved
    // indefinitely. The shared deadline SQL predicate
    // (termiteRenewalGraceDeadlineSql — the SAME formula
    // termiteRenewalGraceDeadlineFor/graceDeadlineFor computes in JS,
    // proven to agree exactly) now runs IN the WHERE clause, and the page
    // orders by the DEADLINE itself (most overdue first) — every row this
    // query returns is already genuinely due, so LIMIT bounds real work,
    // never dead weight.
    const { termiteRenewalGraceDeadlineSql } = require('./annual-prepay-renewals');
    const deadlineSql = termiteRenewalGraceDeadlineSql('t');
    const candidates = await conn('annual_prepay_terms as t')
      .leftJoin('invoices as i', 'i.id', 't.prepay_invoice_id')
      .whereNotNull('t.annual_plan_version')
      .whereNotNull('t.renewed_from_term_id')
      .where('t.status', PAYMENT_PENDING_STATUS)
      // Codex #4971 pre-push P0: a dispute-suspended successor (paid, then
      // disputed back to payment_pending) is owned by the dispute's outcome
      // — never lapsed, voided or retrieved from here.
      .whereNull('t.dispute_suspended_at')
      .whereNull('t.renewal_lapse_started_at')
      // A customer with an active collections DISPUTE hold is never lapsed,
      // voided or retrieved from here (B10): the hold is the office's to
      // resolve, and the lapse resumes after release. Excluded in SQL so
      // held rows never occupy the bounded page; bellHeldOverdueRenewals
      // tells staff once.
      .whereNotExists(function collectionsDisputeHold() {
        require('./collections/collection-hold').disputeHoldExistsSql(this, 't.customer_id');
      })
      .whereRaw(`${deadlineSql} < ?`, [etDateString()])
      .where(function presented() {
        // Chokepoint A: "presented" = a charge attempt that genuinely
        // REACHED Stripe (whereAttemptSubmitted — Codex #4971 round-3 P1,
        // item 6: the attempt row is committed BEFORE the provider call, so
        // a bare row proves nothing; a crash or guard refusal before
        // submission leaves one behind), OR the invoice's own persisted
        // delivery proof (whereInvoiceDelivered). Without verified
        // evidence, a successor that fell through every notification path
        // would lapse — and trigger station retrieval — against a customer
        // who was never actually warned.
        this.where(function attemptReachedStripe() {
          this.whereNotNull('t.renewal_charge_attempted_at')
            // Codex #4971 r4 P1: a submitted charge presents the renewal
            // only once its follow-through is not owed — an outcome still
            // pending (write-ahead) or a decline whose pay link / bell has
            // not verifiably gone out never told the customer anything.
            // Twin of chargeFollowThroughOwed.
            .where(function followThroughNotOwed() {
              this.whereNull('t.renewal_charge_failure_kind').orWhereNotNull('t.renewal_charge_failure_handled_at');
            })
            // Codex #4971 r21 P1: provider evidence (a PaymentIntent id),
            // not the pre-call submission marker — see whereAttemptPresented.
            .whereExists(function presentedByStripe() {
              whereAttemptPresented(this.select(1).from('stripe_invoice_charge_attempts as a').whereRaw('a.invoice_id = t.prepay_invoice_id'));
            });
        })
          .orWhere(function invoiceDelivered() { whereInvoiceDelivered(this, 'i'); });
      })
      .orderByRaw(`${deadlineSql} asc`) // most overdue first
      .select('t.*')
      .limit(limit);
    counts.graceScanned = candidates.length;
    await bellHeldOverdueRenewals({ conn, counts });
    for (const term of candidates) {
      try {
        const outcome = await processGraceLapseForTerm(term, conn);
        if (outcome === 'deferred') counts.graceReconciliationDeferred += 1;
        else if (outcome === 'retired') counts.graceRetiredSettled += 1;
        else counts.graceLapsed += 1;
      } catch (err) {
        logger.error(`[termite-annual-renewal] grace lapse failed for term ${term.id}: ${err.message}`);
      }
    }
  } catch (err) {
    logger.error(`[termite-annual-renewal] grace-lapse scan failed: ${err.message}`);
  }
}

// Codex round-5 P0: before EVERY void — a fresh lapse just past its grace
// deadline, OR the recovery pass resuming one that started but never
// finished — atomically re-read the successor UNDER LOCK and refuse to
// void unless it is STILL genuinely unpaid AND has no ambiguous Stripe
// attempt pending. voidInvoice's own assertInvoiceVoidable
// (invoice-helpers.js) deliberately ALLOWS voiding a credit-settled
// 'prepaid' invoice — the void path returns the applied account credit to
// the customer's balance, so a genuinely CANCELLED plan's stranded credit
// comes back — which means a renewal SETTLED by account credit reads to
// voidInvoice exactly like a still-open invoice: nothing in its own guard
// distinguishes "never paid" from "paid by credit, not cash". A card
// payment landing in the gap between the lapse starting and the void
// actually running (decideAndCharge succeeding concurrently) is the same
// class of race, caught here on the successor's own status instead. ONE
// ALLOW-list, all under the SAME row lock: the successor is still
// payment_pending, AND (if it has an invoice) that invoice reads no
// DURABLE paid/prepaid evidence (paid_at set, or status paid/prepaid) —
// Codex round-7 P1 (2nd audit round): NOT the blanket
// `!isInvoiceCollectibleStatus(...)` this used to read, which wrongly
// retired a still-clearing ACH ('processing' is itself uncollectible, but
// is not settled — checked and DEFERRED first, its own comment below) —
// with no paid_at, AND (Codex round-2 P0, folded in here rather than left
// as a separate unlocked step) no Stripe charge reconciliation is pending
// on it (assertNoInvoiceChargeReconciliationPending, run against the SAME
// trx). ALSO re-checks the PARENT
// under this SAME lock (Codex round-7 P1) — the parent must be either
// still undecided or already decided 'cancel' by THIS lapse's own prior
// partial run, or the lapse defers instead of voiding against a plan an
// operator just decided some other way. Returns { outcome: 'proceed' }
// (void is authorized, or the void already ran and the sequence should
// continue), { outcome: 'retired', reason } (the caller must RETIRE the
// lapse instead of voiding), or { outcome: 'deferred', kind, reason } (a
// pending Stripe reconciliation, or the parent decided elsewhere — retry
// next tick either way).
// Self-contained sub-decisions extracted from resolveLapseVoidEligibility
// below (Codex round-7 P2 self-review, AGENTS.md L412-418) — each is a
// genuinely independent question the transaction asks in sequence, not a
// one-use wrapper relocating a single branch.
function lapseVoidAlreadyRanFor(fresh, invoice) {
  const invoiceStatusKey = String(invoice?.status || '').toLowerCase();
  if (fresh.status !== 'cancelled' || !invoice || !INVOICE_CANCELLED_STATUSES.has(invoiceStatusKey)) return false;
  // Codex #4971 r23 P1: the move-15 shape — the customer declined the NEXT
  // renewal while this successor was still unpaid (payment_pending +
  // renewal_decision 'cancel'). Its lapse void settles it to 'cancelled'
  // and KEEPS that decision (settleDecidedPendingTerm), so "undecided" is
  // not the provenance here — the persisted lapse start is. A decided
  // cancel with no lapse ever started is an external cancel, not ours.
  if (!fresh.renewal_decision) return true;
  return fresh.renewal_decision === 'cancel' && !!fresh.renewal_lapse_started_at;
}

async function parentStillDecidableForLapse(trx, fresh) {
  if (!fresh.renewed_from_term_id) return { ok: true };
  const parent = await trx('annual_prepay_terms').where({ id: fresh.renewed_from_term_id }).forUpdate().first();
  const parentCancelled = parent?.status === 'cancelled' && parent.renewal_decision === 'cancel';
  const parentUndecided = parent && RENEWABLE_STATUSES.includes(parent.status) && !parent.renewal_decision;
  // Codex #4971 r13 P1: a cancelled parent is THIS lapse's own earlier
  // write (an idempotent resume after a crash) only with its provenance —
  // renewal_lapse_parent_cancelled_at, stamped on this successor in the
  // same transaction as that cancel (recordParentLapseCancel). Any other
  // cancel (an admin, a customer decline) happened outside this lapse: the
  // renewal is withdrawn, never lapsed — no retrieval, no parent decision.
  if (parentUndecided || (parentCancelled && fresh.renewal_lapse_parent_cancelled_at)) return { ok: true };
  if (parentCancelled) return { ok: false, reason: 'the parent was cancelled outside this lapse', externalCancel: true };
  // Codex #4971 pre-push P1: resolveParentEligibility's own durable /
  // transient split decides what the lapse does next. A parent demoted to
  // payment_pending by a dispute on its own invoice (move 10, no decision)
  // can come back when the dispute is won — the lapse waits and retries;
  // only a durable change elsewhere (a decision, a cancel, a missing row)
  // is a human's call.
  const { durable } = await resolveParentEligibility(trx, parent);
  const reason = parent
    ? `the parent was already decided '${parent.renewal_decision || parent.status}'`
    : 'the parent no longer exists';
  return { ok: false, reason, transient: durable === false };
}

async function reconciliationStatusForVoid(trx, invoiceId) {
  if (!invoiceId) return { ok: true };
  try {
    await require('./stripe').assertNoInvoiceChargeReconciliationPending(invoiceId, trx);
    return { ok: true };
  } catch (reconErr) {
    return { ok: false, reason: reconErr.message };
  }
}

async function resolveLapseVoidEligibility(term, conn = db) {
  return conn.transaction(async (trx) => {
    const fresh = await trx('annual_prepay_terms').where({ id: term.id }).forUpdate().first();
    if (!fresh) return { outcome: 'retired', reason: 'the term no longer exists' };

    // Collections DISPUTE hold (B10), binding: read under this term's row lock
    // on EVERY path through here - a fresh lapse the scan selected before the
    // hold landed, AND a started lapse the recovery pass resumes. A hold (or a
    // lookup failure) defers: nothing is voided, retrieved or cancelled, and
    // the lapse is not retired - it resumes after the office releases it.
    if (await collectionsDisputeHoldBlocks(trx, fresh.customer_id)) {
      return { outcome: 'deferred', kind: 'collections_hold', reason: HOLD_DEFER_REASON };
    }

    let invoice = null;
    if (fresh.prepay_invoice_id) {
      invoice = await trx('invoices').where({ id: fresh.prepay_invoice_id }).first(...INVOICE_EVIDENCE_COLUMNS);
    }

    // Codex round-7 P1: a crash right after voidInvoice's OWN sync flips
    // this successor to 'cancelled' (move 9, renewal_decision IS NULL) —
    // but before retrieval/the parent decision ran — must NOT be misread
    // as "settled by something unrelated" (a card payment or an
    // account-credit settlement, which the checks below still catch).
    // It's THIS lapse's OWN void, already committed; the sequence must
    // CONTINUE (voidInvoice's own re-entry self-heals as a no-op, then
    // retrieval -> parent decision -> complete), never retired as if
    // nothing more were owed. Distinguished by the successor's own
    // invoice reading a cancelled/void shape — a genuinely different
    // resolution reads 'active'/'paid'/'prepaid' instead, which the
    // status and invoice checks below still catch and retire correctly.
    const voidAlreadyRan = lapseVoidAlreadyRanFor(fresh, invoice);

    if (!voidAlreadyRan) {
      if (fresh.status !== PAYMENT_PENDING_STATUS) {
        return { outcome: 'retired', reason: `the successor is already ${fresh.status}, not payment_pending` };
      }
      // Codex #4971 pre-push P1: paid, then disputed back to payment_pending
      // after this lapse was selected (or while a started lapse waited) — its
      // reopened invoice reads overdue, but the dispute owns it. Deferred:
      // no void, no retrieval, no parent decision, no manual review, no
      // bell; rotated until the dispute resolves (won: active, retired here;
      // lost: cancelled, retired here) or the marker clears.
      if (successorDisputeSuspended(fresh)) {
        return { outcome: 'deferred', kind: 'successor_dispute_suspended', reason: `the successor's renewal payment is under dispute (since ${new Date(fresh.dispute_suspended_at).toISOString()}) — the dispute owns it` };
      }
      // Codex round-7 P1 (2nd audit round): 'processing' is in
      // isInvoiceCollectibleStatus's OWN uncollectible list (you can't
      // ATTEMPT to collect an ACH debit that's already mid-clearing) —
      // but that is NOT the same thing as durably settled. The old
      // `!isInvoiceCollectibleStatus(...)` check lumped a still-clearing
      // ACH payment in with paid/prepaid/void/refunded and RETIRED the
      // term (no void, coverage kept) before the bank had actually
      // confirmed anything — an ACH debit that later BOUNCES leaves the
      // successor permanently retired with no coverage paid for and no
      // lapse ever recorded. Checked FIRST, ahead of any retire decision:
      // still processing means DEFER (retry next tick, same bucket as a
      // pending Stripe charge reconciliation below), never retire.
      const evidence = classifyRenewalInvoice(invoice);
      if (evidence.processing) {
        return {
          outcome: 'deferred',
          kind: 'reconciliation_pending',
          reason: `the invoice reads processing — the ACH payment has not durably cleared yet on invoice ${fresh.prepay_invoice_id}`,
        };
      }
      // Retire only on DURABLE paid evidence (chokepoint A: paid/prepaid
      // status or paid_at). A genuinely void/refunded/canceled invoice (not
      // this lapse's OWN void — that shape is voidAlreadyRan, handled
      // above) falls through instead of retiring here: voidInvoice's own
      // re-entry self-heals as a no-op on an already-settled invoice, so
      // proceeding is safe either way and never wrongly skips a genuinely
      // owed void.
      if (evidence.paidEvidence) {
        const paidNote = invoice.paid_at ? ' (paid_at set)' : '';
        return { outcome: 'retired', reason: `the invoice already reads ${invoice.status}${paidNote}` };
      }
    }

    // Codex round-7 P1: re-check the PARENT under the SAME lock, on
    // EVERY path through here (a fresh lapse about to void, AND the
    // lapse-owned-void-already-ran resume above) — before voiding, and
    // before ever reaching the retrieval/parent-decision steps.
    // recordDecision('cancel') later returns null (it never throws) on a
    // guard-miss — most commonly an operator already recorded
    // 'renew'/'switch_plan' on the parent — and the caller's own
    // try/catch only watches for a THROWN error, not a silent
    // guard-miss, so a void could otherwise complete (and the lapse
    // report itself "done") against a plan the operator just renewed.
    // Fail closed here instead: proceed only when the parent is either
    // still undecided (the normal case) or ALREADY decided 'cancel' by a
    // prior partial run of THIS SAME lapse (idempotent resume — a crash
    // between recordDecision succeeding and the completed_at stamp).
    const parentCheck = await parentStillDecidableForLapse(trx, fresh);
    if (!parentCheck.ok) {
      return { outcome: 'deferred', kind: lapseParentHoldKind(parentCheck), reason: parentCheck.reason };
    }

    if (voidAlreadyRan) return { outcome: 'proceed' };

    const reconciliation = await reconciliationStatusForVoid(trx, fresh.prepay_invoice_id);
    if (!reconciliation.ok) {
      return { outcome: 'deferred', kind: 'reconciliation_pending', reason: reconciliation.reason };
    }
    return { outcome: 'proceed' };
  });
}

// A re-entrant state machine — safe to call again from wherever it last got
// to, for BOTH callers (processGraceLapses on a fresh candidate, and
// reconcileMissedLapseEffects resuming a started-but-not-completed one):
//   1. Stamp renewal_lapse_started_at (Codex round-2 P1) — persisted
//      PROVENANCE that this successor is undergoing a CONFIRMED grace
//      lapse, committed in its own write BEFORE any void is even
//      attempted. This is the ONLY thing that ever sets this column, so
//      its mere presence (with completed_at still null) is what the
//      recovery pass keys on — never an inference from status='cancelled',
//      which a staff void, a removed annual-prepay flag, or a lost dispute
//      can ALSO produce. Guarded (`whereNull`) so a resumed row no-ops here.
//   2. resolveLapseVoidEligibility, above — ONE atomic re-check, under a
//      lock on the successor row, that folds together:
//        - Codex round-5 P0: if the successor/invoice turns out to already
//          be SETTLED (a card payment or an account-credit settlement
//          landed in the gap since this lapse started), retire it right
//          here (renewal_lapse_completed_at + renewal_lapse_outcome=
//          'retired_settled') with NO void and NO retrieval, and an
//          informational bell. The settlement's own sync already decided
//          the parent correctly; this pass must never re-decide it.
//        - Codex round-2 P0: no Stripe charge reconciliation pending on
//          the invoice — the SAME guard the abandoned-prepay sweep uses
//          (invoice.js's switch-restore leg) before its own auto-void. A
//          crash after Stripe ACCEPTS a charge (from decideAndCharge, on
//          this same successor) but before the local payments/invoice
//          write completes leaves a durable CLAIMED
//          stripe_invoice_charge_attempts row (or an orphan-charge marker)
//          while the invoice still reads unpaid/draft — voidInvoice has no
//          way to know money already moved. FAIL CLOSED: no void, bell
//          staff, and leave the lapse started-but-not-completed for the
//          next tick to retry (never inferred safe just because the
//          deadline passed).
//   4. voidInvoice — self-heals: re-entry on an already-void invoice
//      re-runs its idempotent annual-prepay sync rather than erroring, so
//      a prior partial run (invoice voided, sync lost) repairs here
//      instead of being skipped forever.
//   5. Raise the station-retrieval task — idempotent on its own dedupeKey.
//   6. Record the decided lapse ('cancel') on the PARENT — the exact
//      'cancelled' + renewal_decision='cancel' shape coveredTermsAsOf's
//      decidedCoveredAndPaid branch already models for every other
//      annual-prepay renewal lapse. Reuses the canonical
//      recordDecision('cancel') writer (an operator's manual "cancel"
//      click uses the SAME path) rather than a new status write in this
//      file; its own guard makes this idempotent.
//   7. Stamp renewal_lapse_completed_at (+ outcome='lapsed') — ONLY once
//      the parent decision step above actually succeeded (best-effort/
//      swallowed on failure, so a DB hiccup there never blocks the
//      retrieval task that already ran — but also never marks this lapse
//      "done" while it's still owed). A row left started-but-not-completed
//      here is exactly what the recovery pass resumes on its next tick.
// Returns 'lapsed' (genuinely voided + retired coverage), 'retired'
// (settled before the void ran — no void, no retrieval), or 'deferred' (a
// pending Stripe reconciliation — retry next tick).
// Codex round-7 P1 (2nd audit round): the eligibility re-check inside
// processGraceLapseSequence used to commit on its OWN, short-lived
// transaction, releasing its row lock BEFORE the void and retrieval task
// ran — a renew/switch_plan decision landing in that gap was ignored (the
// void and retrieval task still fired against a plan an operator had just
// decided otherwise). A dedicated-connection SESSION lock, held across the
// WHOLE sequence (the lapse-start stamp below through the final
// recordDecision('cancel')) — the SAME mechanism and SAME key
// decideAndCharge's charge submission uses — closes it: a decision (xact
// lock) racing in from elsewhere on this SAME parent genuinely waits behind
// this whole sequence, or this sequence's own eligibility re-check already
// sees it and defers with NO void. The nested recordDecision('cancel') call
// below (SAME parent, SAME async tree) never re-takes the lock — see
// heldParentDecisionLockStore's doc in annual-prepay-renewals.js. A term
// with no parent (should not occur for a real grace-lapse candidate, but
// defensive) skips the lock entirely — nothing to serialize against.
async function processGraceLapseForTerm(term, conn = db) {
  if (!term.renewed_from_term_id) return stampLapseStartAndRunSequence(term, conn);
  return withRenewalGate(term, () => stampLapseStartAndRunSequence(term, conn));
}

// Codex #4971 r16 P1 (finding 7): renewal_lapse_started_at is the ONLY thing
// that ever sets this column (see processGraceLapseSequence's own doc
// above) — its mere presence with completed_at still null is what the
// recovery pass (reconcileMissedLapseEffects) trusts as "this successor's
// cancellation IS this lapse's own void", never re-derived from status
// alone. Stamping it used to run BEFORE the renewal gate — a plain UPDATE
// with no status check at all — so an operator void racing in around the
// same moment (voidInvoice -> cancelTermWithRestorations, which DOES take
// this SAME gate as its transaction's first lock) could commit its own
// unrelated cancellation just before or after this write landed, and the
// stamp then sat on an already-(externally-)cancelled row with no lapse of
// its own behind it. The next pass (lapseVoidAlreadyRanFor) read that shape
// as "the lapse's own void already ran" and finished the sequence —
// deciding 'cancel' on the PARENT on the lapse's authority for a
// cancellation an operator caused for an unrelated reason. Now the stamp
// itself runs INSIDE the gate, and only once the successor re-reads
// payment_pending under it — an operator void either wins the gate first
// (successor no longer payment_pending here — deferred, nothing stamped —
// the ordinary candidate scan simply stops selecting this row once its
// status change is visible) or waits behind this whole sequence, exactly
// like every other renewal action.
async function stampLapseStartAndRunSequence(term, conn) {
  let lapseStartedAt = term.renewal_lapse_started_at;
  if (!lapseStartedAt) {
    const fresh = await conn('annual_prepay_terms').where({ id: term.id }).first('status', 'renewal_lapse_started_at');
    if (fresh?.renewal_lapse_started_at) {
      lapseStartedAt = fresh.renewal_lapse_started_at;
    } else if (fresh?.status !== PAYMENT_PENDING_STATUS) {
      logger.warn(`[termite-annual-renewal] grace lapse for term ${term.id} deferred — no longer payment_pending under the gate (an external write resolved it first)`);
      await stampSweepDeferred(term, conn);
      return 'deferred';
    } else {
      // Codex #4971 post-push audit round-6 P1: a fresh lapse only stamped
      // renewal_lapse_started_at in the DB — the in-memory `term` object
      // passed down to raiseGraceLapseRetrievalTask still read null, so its
      // eventAt was null and the raise ranked as the OLDEST event in the
      // account's retrieval chronology, yielding to any earlier request-
      // backed row even one staff already acted on. RETURNING the persisted
      // value (or, when a concurrent tick's own whereNull() guard already
      // won the race, re-reading it) means eventAt always reflects the REAL
      // first-detected time, never a fabricated new one and never null.
      const [stamped] = await conn('annual_prepay_terms').where({ id: term.id }).whereNull('renewal_lapse_started_at')
        .update({ renewal_lapse_started_at: new Date() })
        .returning('renewal_lapse_started_at');
      if (stamped) {
        lapseStartedAt = stamped.renewal_lapse_started_at;
      } else {
        const refetched = await conn('annual_prepay_terms').where({ id: term.id }).first('renewal_lapse_started_at');
        lapseStartedAt = refetched?.renewal_lapse_started_at || null;
      }
    }
    term = { ...term, renewal_lapse_started_at: lapseStartedAt };
  }
  return processGraceLapseSequence(term, conn);
}

// Extracted from processGraceLapseSequence (Codex #4971 post-push audit
// round-5 self-review, AGENTS.md L412-418: a genuinely self-contained
// sub-decision, same shape as writeDecisionUnderTermiteLock's own
// extraction above) — item 2: this lapse's own station-retrieval raise,
// and whether its outcome lets the lapse proceed to complete. Returns
// true when the caller may continue (raise the retrieval, decide the
// parent, stamp completed_at); false when it must return 'deferred'
// immediately, leaving this lapse exactly as started-but-not-completed.
async function raiseGraceLapseRetrievalTask(term, conn, today = etDateString()) {
  // Codex #4971 post-push audit round-6 P1 (item 2): raiseTermiteRetrievalTask
  // counts EVERY Waves-owned termite station on the ACCOUNT (no property or
  // term key), so an automatic "pull the stations" task is only safe when
  // this lapsed plan is the account's ONLY live termite coverage — the SAME
  // guard #4940's own portal-decline retrieval already applies
  // (otherLiveTermiteCoverage, annual-prepay-renewals.js), reused rather
  // than re-derived. Other coverage found: bell staff to confirm which
  // stations belong to THIS lapsed plan instead of an account-wide task,
  // and this lapse proceeds to complete only once that bell itself persists.
  const { otherLiveTermiteCoverage } = require('./annual-prepay-renewals');
  const otherCoverage = await otherLiveTermiteCoverage(term, today);
  if (otherCoverage) {
    return !!(await ringRenewalBell(
      term,
      'lapse_retrieval_other_coverage',
      `other live termite coverage on this account (${otherCoverage}) — confirm which stations belong to this lapsed plan before any are pulled`,
    ));
  }
  const { raiseTermiteRetrievalTask, termRetrievalDedupeKey } = require('./cancellation-processor');
  // This raise has no service request behind it, so without eventAt
  // #4940's helper ranks it as the OLDEST event in the account's
  // retrieval chronology and yields to ANY earlier request-keyed row —
  // even one staff already acted on — completing this lapse as if the
  // stations were covered when they were never actually raised for THIS
  // lapse. eventAt = this lapse's own event time (renewal_lapse_started_at,
  // stamped at the top of processGraceLapseForTerm) places it correctly
  // in that chronology.
  const raised = await raiseTermiteRetrievalTask(term.customer_id, null, {
    retrieveAfter: null,
    termId: term.id,
    // No real churn episode backs a non-payment lapse — a stable literal
    // keeps this raise's dedupe key scoped to THIS term (see the
    // function's own termKeyed contract), distinct from any
    // cancellation-request-driven retrieval task for the same customer.
    episodeKey: 'renewal_grace_lapse',
    eventAt: term.renewal_lapse_started_at,
  });
  // A newer retrieval instruction already stands on the account — nothing
  // was raised or reopened for THIS lapse. Never silently treat that as
  // "handled": bell staff to confirm the newer instruction actually covers
  // these stations, and only once THAT confirmation itself is durably
  // persisted may this lapse proceed to complete — a bell that fails to
  // persist leaves it exactly as started-but-not-completed, retried next
  // tick (mirrors #4940's own settleDeclineRetrieval: never settle on an
  // unconfirmed outcome).
  if (raised?.supersededByNewer) {
    return !!(await ringRenewalBell(
      term,
      'lapse_retrieval_superseded',
      `a newer retrieval instruction (${raised.supersededByNewer}) already stands on this account`,
    ));
  }
  if (!raised?.raised) return true; // e.g. no_rented_stations — nothing to verify
  // Mirror #4940's own actOnDueDeclineRetrieval verification: "raised"
  // alone is not proof — confirm THIS lapse's own task row actually
  // landed before letting the retrieval count as handled.
  const taskRow = await conn('notifications')
    .where({ recipient_type: 'admin' })
    .whereRaw("metadata->>'dedupeKey' = ?", [termRetrievalDedupeKey(term.id, 'renewal_grace_lapse', null)])
    .first('id');
  return !!taskRow;
}

// Chokepoint D (Codex #4971 round-3 P2, item 4): how a lapse that cannot
// finish this tick is left. A condition that needs a HUMAN — the parent
// decided some other way (renew/switch_plan, or cancelled by a refund/void
// with no decision), or a partial account credit on the invoice — is
// persisted as renewal_lapse_outcome='manual_review' (completed_at stays
// null: the lapse did not complete), which reconcileMissedLapseEffects
// excludes, so it can never pin that bounded page; staff get the bell once.
// Anything that clears on its own (a charge reconciliation, an ACH still
// clearing, a retrieval task not yet confirmed, a parent write that failed)
// stays in the recovery scan, rotated to the back (stampSweepDeferred).
// Codex #4971 pre-push P1: manual_review is persisted ONLY after its staff
// bell is confirmed (bellOrRotate) — the recovery scan excludes it, so a
// hold whose bell was lost would leave the renewal unprocessed with nobody
// told. A lost bell leaves the row in rotation to ring again next tick.
async function holdLapse(term, conn, { manualReview, kind, reason }) {
  logger.warn(`[termite-annual-renewal] grace lapse for term ${term.id} deferred (${kind}) — ${reason}`);
  if (manualReview && (await bellOrRotate(term, kind, reason, conn))) {
    await conn('annual_prepay_terms').where({ id: term.id }).whereNull('renewal_lapse_completed_at')
      .update({ renewal_lapse_outcome: 'manual_review' });
    return 'deferred';
  }
  if (!manualReview) {
    if (kind) await ringRenewalBell(term, kind, reason);
    await stampSweepDeferred(term, conn);
  }
  return 'deferred';
}

// The completion stamp excludes the lapse from every scan — written only
// after its (informational) bell is confirmed; otherwise it stays in
// rotation and the retire is re-derived next tick.
async function retireSettledLapse(term, conn, reason) {
  if (!(await bellOrRotate(term, 'lapse_retired_settled', reason, conn))) return 'deferred';
  await conn('annual_prepay_terms').where({ id: term.id })
    .update({ renewal_lapse_completed_at: new Date(), renewal_lapse_outcome: 'retired_settled' });
  return 'retired';
}

// The void step. Codex round-3 audit P0: resolveLapseVoidEligibility's own
// re-check already committed and released its row lock by the time this
// runs — apply-credit (or any other settlement) takes NO parent advisory
// lock before committing, so it can settle the invoice in that exact gap.
// voidInvoice's own `requireUnsettled` precondition re-verifies "genuinely
// still unpaid, no reconciliation pending" a SECOND time under the
// INVOICE'S OWN row lock, right where the void commits. A refusal is read
// through classifyVoidRefusal (shared with withdrawRenewalSuccessor):
// settled retires the lapse; a partial credit is a manual-review hold;
// anything still clearing defers. Returns null when the void went through.
async function voidLapsedInvoice(term, conn) {
  if (!term.prepay_invoice_id) return null;
  try {
    await require('./invoice').voidInvoice(term.prepay_invoice_id, { requireUnsettled: true });
    return null;
  } catch (err) {
    const refusal = classifyVoidRefusal(err);
    if (refusal === 'settled') {
      logger.warn(`[termite-annual-renewal] grace lapse for term ${term.id} retired at the void chokepoint — invoice ${term.prepay_invoice_id} settled between the eligibility re-check and the void: ${err.message}`);
      return retireSettledLapse(term, conn, err.message);
    }
    if (refusal) {
      return holdLapse(term, conn, { manualReview: refusal === 'manual_review', kind: 'lapse_reconciliation_pending', reason: err.message });
    }
    throw err;
  }
}

const LAPSE_HOLD_BELL_KIND = { parent_decided_elsewhere: 'lapse_parent_decided_elsewhere', collections_hold: 'ineligible', parent_suspended: null, successor_dispute_suspended: null, parent_cancelled_elsewhere: null };

function lapseParentHoldKind(parentCheck) {
  if (parentCheck.externalCancel) return 'parent_cancelled_elsewhere';
  return parentCheck.transient ? 'parent_suspended' : 'parent_decided_elsewhere';
}

// Codex #4971 r13 P1: the parent was cancelled outside this lapse — the
// external cancellation's own path, never the lapse's: the renewal is
// withdrawn (void + cancel + one staff bell; withdrawRenewalSuccessor
// re-judges it under the gate this sequence already holds), with no station
// retrieval and no parent decision. A renewal already voided (this lapse's
// own void ran before the cancel landed) has nothing left to withdraw. The
// lapse is then closed as 'withdrawn' so the recovery leg drops it.
async function closeLapseForExternalParentCancel(term, reason, conn) {
  const fresh = await conn('annual_prepay_terms').where({ id: term.id }).first('status');
  if (fresh?.status === PAYMENT_PENDING_STATUS) {
    const withdrawn = await withdrawRenewalSuccessor(term, reason, conn);
    if (withdrawn !== 'retired') return 'deferred';
  }
  await conn('annual_prepay_terms').where({ id: term.id }).whereNull('renewal_lapse_completed_at')
    .update({ renewal_lapse_completed_at: new Date(), renewal_lapse_outcome: 'withdrawn' });
  return 'retired';
}

// A collections dispute hold defers a lapse: bell the office once
// ('ineligible' dedupes per term) and rotate the row - never retire or
// manual-review it, so it resumes after release.
async function holdLapseForCollectionsHold(term, conn) {
  return holdLapse(term, conn, {
    manualReview: false,
    kind: 'ineligible',
    reason: `the renewal lapse is waiting: ${HOLD_DEFER_REASON}; it resumes after the office releases the hold`,
  });
}

async function processGraceLapseSequence(term, conn) {
  const eligibility = await resolveLapseVoidEligibility(term, conn);
  if (eligibility.kind === 'parent_cancelled_elsewhere') return closeLapseForExternalParentCancel(term, eligibility.reason, conn);
  if (eligibility.outcome === 'deferred') {
    const manualReview = eligibility.kind === 'parent_decided_elsewhere';
    // A parent suspended by a dispute on its own invoice is transient: the
    // lapse rotates (no manual review, no bell) and is retried every sweep
    // until the dispute resolves either way.
    return holdLapse(term, conn, {
      manualReview,
      kind: Object.hasOwn(LAPSE_HOLD_BELL_KIND, eligibility.kind) ? LAPSE_HOLD_BELL_KIND[eligibility.kind] : 'lapse_reconciliation_pending',
      reason: eligibility.reason,
    });
  }
  if (eligibility.outcome === 'retired') return retireSettledLapse(term, conn, eligibility.reason);

  // Codex #4971 r26 P1: the void is the FIRST irreversible step (invoice +
  // coverage), so the gate session is re-asserted before it too — a gate
  // lost after the eligibility read would let a concurrent manual renew /
  // switch commit while this still voided the successor.
  assertRenewalLockAlive();
  // Re-check the hold right before the first irreversible step (a hold that
  // landed after the eligibility transaction committed); same deferral.
  if (await collectionsDisputeHoldBlocks(conn, term.customer_id)) return holdLapseForCollectionsHold(term, conn);
  const voidOutcome = await voidLapsedInvoice(term, conn);
  if (voidOutcome) return voidOutcome;
  // Codex #4971 r24 P1: the station-retrieval task is a durable side effect
  // the parent gate is meant to serialize (a concurrent manual renew/switch
  // must not commit while it is raised) — a gate session lost since the
  // void above means the lock is already released, so re-assert it here
  // exactly as every provider boundary does. A lost gate throws; the sweep
  // logs it and this lapse resumes next tick (lapseVoidAlreadyRanFor).
  assertRenewalLockAlive();
  if (await collectionsDisputeHoldBlocks(conn, term.customer_id)) return holdLapseForCollectionsHold(term, conn);
  if (!(await raiseGraceLapseRetrievalTask(term, conn))) {
    return holdLapse(term, conn, { manualReview: false, reason: 'the station-retrieval step is not confirmed yet' });
  }
  // ...and before the parent decision, the last gated write of the lapse.
  assertRenewalLockAlive();
  if (await collectionsDisputeHoldBlocks(conn, term.customer_id)) return holdLapseForCollectionsHold(term, conn);
  if (!(await decideParentLapse(term, conn))) {
    return holdLapse(term, conn, { manualReview: false, reason: 'the parent lapse decision did not record' });
  }
  await conn('annual_prepay_terms').where({ id: term.id }).update({ renewal_lapse_completed_at: new Date(), renewal_lapse_outcome: 'lapsed' });
  return 'lapsed';
}

// Record the decided lapse ('cancel') on the PARENT. Returns true when the
// parent reads decided 'cancel' afterwards.
// The lapse's parent cancel and its provenance commit TOGETHER (Codex #4971
// r13 P1): renewal_lapse_parent_cancelled_at on this successor is what lets
// a resumed lapse tell its own earlier cancel from an outside one
// (parentStillDecidableForLapse). Written only where the row shows the
// column (20260927160000) — before it exists, a resume reads the cancel as
// outside and withdraws instead (no retrieval: the safe side).
async function recordParentLapseCancel(term, conn) {
  const write = async (t) => {
    const decided = await require('./annual-prepay-renewals').recordDecision({ termId: term.renewed_from_term_id, action: 'cancel', conn: t });
    if (decided && Object.hasOwn(term, 'renewal_lapse_parent_cancelled_at')) {
      await t('annual_prepay_terms').where({ id: term.id }).update({ renewal_lapse_parent_cancelled_at: new Date() });
    }
    return decided;
  };
  return typeof conn.transaction === 'function' && !conn.isTransaction ? conn.transaction(write) : write(conn);
}

async function decideParentLapse(term, conn) {
  if (!term.renewed_from_term_id) return true;
  try {
    const decided = await recordParentLapseCancel(term, conn);
    if (decided) return true;
    // Codex round-7 P1 / round-3 audit P1: recordDecision returns null
    // (never throws) on a guard-miss — but that guard-miss has TWO very
    // different causes. (a) The parent was decided something ELSE — a
    // genuine conflict; never mark the lapse "done". (b) A prior partial run
    // of THIS SAME lapse already recorded 'cancel' on the parent and crashed
    // before stamping completed_at — recordDecision's own guard
    // (`renewal_decision IS NULL`) correctly returns null on RETRY, but that
    // is SUCCESS, not a conflict. Verified with a fresh read.
    const parent = await conn('annual_prepay_terms').where({ id: term.renewed_from_term_id }).first('renewal_decision');
    if (parent?.renewal_decision === 'cancel') {
      logger.info(`[termite-annual-renewal] parent ${term.renewed_from_term_id} already reads decided 'cancel' for successor ${term.id} — a prior partial run of this SAME lapse; completing it now`);
      return true;
    }
    logger.warn(`[termite-annual-renewal] parent lapse-stamp guard-missed for successor ${term.id} — the parent was decided elsewhere between the re-check and this write`);
    return false;
  } catch (err) {
    logger.warn(`[termite-annual-renewal] parent lapse-stamp skipped for successor ${term.id}: ${err.message}`);
    return false;
  }
}

// ---- pass 5b: reconcile missed lapse effects (Codex round-1 P1 / round-2 P1) --------

// Codex round-2 P1: reconciles ONLY rows whose lapse PROVENANCE proves they
// are a confirmed grace lapse in progress — renewal_lapse_started_at set,
// renewal_lapse_completed_at still null — never inferred from
// status='cancelled' alone (which a staff void, a removed annual-prepay
// flag, or a lost dispute can ALSO produce, and which this pass must NEVER
// touch). Re-runs processGraceLapseForTerm itself (never a parallel
// implementation of its state machine) for each: every step in it is
// independently idempotent/re-entrant (the recon-check + void self-heal,
// the retrieval task is dedupe-keyed, recordDecision('cancel') is guard-
// idempotent), so re-running it for a row whose effects already finished
// is always a safe no-op — and a row still genuinely blocked (a pending
// Stripe reconciliation) is re-checked and, if still blocked, left exactly
// as started-but-not-completed for the next tick.
async function reconcileMissedLapseEffects({ conn = db, limit = 200, counts }) {
  try {
    const scan = conn('annual_prepay_terms as t')
      .whereNotNull('t.renewal_lapse_started_at')
      .whereNull('t.renewal_lapse_completed_at')
      // Chokepoint D (item 4): a manual-review hold is staff's now, never
      // re-run here; a self-clearing deferral rotates behind rows this
      // pass has not retried yet — see holdLapse.
      .whereRaw("coalesce(t.renewal_lapse_outcome, '') <> 'manual_review'");
    // Codex #4971 pre-push P1: a started lapse whose successor was since
    // disputed back to payment_pending waits for the dispute (the locked
    // re-check defers it too); it resumes once the dispute resolves.
    const candidates = await whereSuccessorNotDisputeSuspended(scan, 't')
      .orderByRaw('t.renewal_sweep_deferred_at asc nulls first')
      .orderBy('t.renewal_lapse_started_at', 'asc')
      .select('t.*')
      .limit(limit);
    counts.lapseEffectsScanned = candidates.length;
    for (const term of candidates) {
      try {
        const outcome = await processGraceLapseForTerm(term, conn);
        if (outcome === 'deferred') counts.graceReconciliationDeferred += 1;
        else if (outcome === 'retired') counts.graceRetiredSettled += 1;
        else counts.lapseEffectsReconciled += 1;
      } catch (err) {
        logger.error(`[termite-annual-renewal] reconcile (missed lapse effects) failed for successor ${term.id}: ${err.message}`);
      }
    }
  } catch (err) {
    logger.error(`[termite-annual-renewal] reconcile (missed lapse effects) scan failed: ${err.message}`);
  }
}

// ---- pass 7: reconcile stuck successors (P1-3) --------------------------

// Two narrow, self-healing legs for the accepted crash gaps between minting
// a successor and finishing its charge decision. Never blocks the other
// passes; a failure on one successor never blocks the rest.
// Extracted from reconcileStuckSuccessors' leg 7b (Codex round-7 P1, 2nd
// audit round self-review — AGENTS.md L412-418, keeps the loop body under
// the max-depth ceiling). Returns 'delivered' (fresh bell + verified
// delivery), true (deduped/suppressed bell — staff already know, or this
// term is exempt — no delivery needed), or false (the bell itself failed,
// or a fresh bell's delivery failed) — only a truthy return may stamp the
// leg's own exclusion column; false must stay retryable.
// Leg 7b's version of successorActionBlocker (the fence is already claimed
// here, so that one would stop at 'already_attempted'): the parent's
// eligibility and the successor's own grace window — past it, delivering a
// pay link now would only hand the next grace-lapse tick a "presented"
// renewal to lapse and retrieve on the spot.
// A deleted account (routes/auth.js DELETE /account stamps
// customers.deleted_at and leaves Auto Pay armed) is never renewed —
// durable: the renewal is withdrawn. null = a live account.
async function customerDeletedRefusal(conn, successor) {
  const customer = await conn('customers').where({ id: successor.customer_id }).first('deleted_at');
  return customer?.deleted_at ? { reason: 'the customer deleted their account', retire: true } : null;
}

async function successorRecoveryRefusal(successor, conn, { ignoreCollectionHold = false } = {}) {
  // Codex #4971 r10 P1: an account deleted after the mint (routes/auth.js
  // DELETE /account stamps customers.deleted_at and leaves Auto Pay armed)
  // is never renewed — no charge (stripe.js refuses it under the customer
  // lock: CUSTOMER_DELETED), no pay link to an archived account, and the
  // renewal is withdrawn (void + cancel, one staff bell). Durable.
  const deleted = await customerDeletedRefusal(conn, successor);
  if (deleted) return deleted;
  if (successor.renewed_from_term_id) {
    const parent = await conn('annual_prepay_terms').where({ id: successor.renewed_from_term_id }).first();
    const parentEligibility = await parentRefusalForSuccessor(conn, successor, parent);
    if (!parentEligibility.eligible) {
      return { reason: `the parent is no longer eligible (${parentEligibility.reason})`, retire: parentEligibility.durable };
    }
  }
  // A collections dispute hold defers (no pay link, no withdrawal, even past
  // grace) — covers crash / failed-fence-release cases in leg 7b (B10).
  if (!ignoreCollectionHold && await collectionsDisputeHoldBlocks(conn, successor.customer_id)) return { reason: HOLD_DEFER_REASON, retire: false };
  return graceWindowRefusal(successor);
}

// "May this recovery leg still deliver a pay link for this successor?" —
// the ONE answer leg 7b (a claim that never reached Stripe) and every
// charge follow-through that owes a pay link (its first run and leg 7c)
// read before any delivery, so the legs can never drift (Codex #4971
// pre-push P1: 7c used to retry delivery with no eligibility or deadline
// check, so a renewal whose delivery kept failing past its grace window —
// unpresented, hence excluded by the lapse scan — could be sent and then
// voided with a station-retrieval request on the next sweep). Uses
// successorRecoveryRefusal:
//   - a DURABLE refusal (the parent durably ineligible, or the grace window
//     closed) withdraws the successor (withdrawRenewalSuccessor — a
//     presented renewal past its deadline is left to the grace lapse);
//   - a TRANSIENT one (the parent's own invoice in dispute) bells
//     'ineligible' and rotates the row for a later tick.
// Returns null when delivery may proceed; 'handled' when this leg is done
// (withdrawn, left to the lapse, or held for manual review — each only
// once its bell persisted); 'deferred' when the row must be retried later.
async function refuseRecoveryDelivery(successor, conn, context) {
  const refusal = await successorRecoveryRefusal(successor, conn);
  return refusal ? actOnRecoveryRefusal(successor, refusal, conn, context) : null;
}

// What a recovery refusal does: a DURABLE one withdraws the successor, a
// transient one bells and rotates it. Returns 'handled' or 'deferred'.
async function actOnRecoveryRefusal(successor, refusal, conn, context) {
  if (refusal.retire) {
    const outcome = await withdrawRenewalSuccessor(successor, refusal.reason, conn);
    return outcome === 'deferred' ? 'deferred' : 'handled';
  }
  await ringRenewalBell(successor, 'ineligible', `${context}, and ${refusal.reason} — no invoice sent; it will be re-checked automatically`);
  await stampSweepDeferred(successor, conn);
  return 'deferred';
}

async function stampNeverReachedStripeHandled(successor, conn) {
  await conn('annual_prepay_terms').where({ id: successor.id })
    .whereNull('renewal_charge_never_reached_stripe_belled_at')
    .update({ renewal_charge_never_reached_stripe_belled_at: new Date() });
  // Codex #4971 r5 P2: a claim that never reached Stripe has no outcome —
  // once leg 7b handled it, the write-ahead marker goes too, so
  // renewal_charge_failure_kind keeps meaning "a known outcome, or nothing".
  if (successor.renewal_charge_failure_kind === CHARGE_OUTCOME_PENDING) await clearChargeOutcomePending(successor, conn);
}

// Codex #4971 r7 P1 — live claim vs abandoned claim. The fence claim
// (attempted_at + 'outcome_pending') commits BEFORE the charging worker takes
// the renewal gate, so leg 7b could recover a claim whose worker was about
// to submit: the fallback pay link went out, outcome_pending was cleared,
// and the worker then charged anyway. Now 7b selects only claims older than
// the recovery lease (the scan), and — under the renewal gate, before any
// bell or delivery — re-reads the claim and RETIRES it with a
// compare-and-set (renewal_charge_claim_retired_at, 20260927050000), only
// while it is still the same unsubmitted claim: payment_pending, the fence
// set, no recorded outcome other than 'outcome_pending', and no attempt
// with submission evidence (whereAttemptSubmitted). The worker's own
// in-gate re-check (chargeRefusalUnderGate) refuses a retired claim — one
// fence, read on both sides under the same gate — so once recovery took
// over, the original worker can never submit. A claim this leg already
// retired stays its to recover (a retried delivery).
async function bellAndVerifyDeliveryForNeverReachedStripe(successor, conn) {
  const recover = async () => ((await retireAbandonedChargeClaim(successor, conn))
    ? recoverNeverReachedStripe(successor, conn)
    : false);
  return successor.renewed_from_term_id ? withRenewalGate(successor, recover) : recover();
}

async function retireAbandonedChargeClaim(successor, conn) {
  const claim = await conn('annual_prepay_terms').where({ id: successor.id }).first();
  if (claim?.status !== PAYMENT_PENDING_STATUS || !claim.renewal_charge_attempted_at) return false;
  // Codex #4971 pre-push P1: a disputed renewal is never recovered (no bell,
  // no pay link); the 7b scan excludes it, this closes the gap after it.
  if (successorDisputeSuspended(claim)) return false;
  if (claim.renewal_charge_claim_retired_at) return true;
  if (claim.renewal_charge_failure_kind && claim.renewal_charge_failure_kind !== CHARGE_OUTCOME_PENDING) return false;
  const submitted = await whereAttemptSubmitted(
    conn('stripe_invoice_charge_attempts as a').where('a.invoice_id', claim.prepay_invoice_id),
  ).first('a.id');
  if (submitted) return false;
  const retired = await conn('annual_prepay_terms').where({ id: successor.id })
    .whereNull('renewal_charge_claim_retired_at')
    .update({ renewal_charge_claim_retired_at: new Date() });
  return Boolean(retired);
}

async function recoverNeverReachedStripe(successor, conn) {
  // Codex #4971 round-4 (post-merge audit) P1: the FINAL parent check
  // right before the Stripe call (decideAndCharge's withParentDecisionLock
  // re-check) blocks Stripe when a cancellation wins the race against an
  // already-claimed fence — which leaves the successor in EXACTLY the shape
  // this leg selects on. Revalidate with the SAME rules as every other
  // successor action (successorRecoveryRefusal) before ANY delivery.
  // Codex #4971 round-3 P1 (item 1): a DURABLE refusal terminalizes the
  // successor (chokepoint C) instead of stamping it handled and leaving it
  // payment_pending forever; a transient one (the parent's own invoice in
  // dispute) is left for a later tick, rotated behind newer rows.
  const blocked = await refuseRecoveryDelivery(successor, conn, 'the renewal charge was claimed but never reached Stripe');
  if (blocked) return blocked === 'handled';
  const result = await ringRenewalBell(
    successor,
    'ambiguous',
    'the renewal charge was claimed but never reached Stripe (a crash between the attempt fence and the Stripe call) — check Stripe and the invoice before collecting any other way',
  );
  // A null result (ringRenewalBell swallows its own failures and returns
  // null) means staff were NEVER actually told — stamping "handled" would
  // permanently exclude a row nobody has seen.
  if (!result) return false;
  // Codex round-3 audit P1: `result.deduped` means ONLY "staff were
  // already told" — it says NOTHING about whether the invoice was ever
  // actually delivered. The old code treated a deduped bell as "handled",
  // which meant a FRESH tick whose delivery genuinely failed permanently
  // stopped retrying the instant the NEXT tick deduped the same bell
  // (the dedupe key is unconditional on the kind, not on delivery
  // success). Decoupled: delivery is checked and retried on PERSISTED
  // evidence alone, independent of bell dedup — chokepoint A's "delivered"
  // (a sent_at/sms_sent_at/email_sent_at stamp), the SAME proof
  // processGraceLapses' own presented-evidence check uses.
  // (The pay-link chokepoint returns { ok, alreadyDelivered } for a stamped
  // invoice without sending, and re-runs the refusal above under the
  // parent's gate — a cancel landing after this leg's bell is caught there.)
  const delivery = await deliverRenewalInvoice(successor, conn, 'the renewal charge was claimed but never reached Stripe');
  if (delivery?.ok) return delivery.alreadyDelivered ? true : 'delivered';
  if (delivery?.code === 'delivery_refused') return delivery.outcome === 'handled';
  if (delivery?.code === 'payer_billed') {
    // A payer assigned since the mint owns this bill: nothing was sent to
    // the homeowner. Handled once staff are told to route it to the payer.
    return Boolean(await bellOrRotate(successor, 'payer_billed', 'the renewal charge never reached Stripe, and a third-party payer is now assigned', conn));
  }
  await stampSweepDeferred(successor, conn);
  return false;
}

async function reconcileStuckSuccessors({ conn = db, limit = 200, counts }) {
  // 7a. renewal_charge_attempted_at IS NULL and old enough that a normal
  // same-tick decideAndCharge() call would already have run (or already
  // hit a skip that legitimately never stamps the fence — no_consent /
  // no_method / surcharge_not_authorized / ineligible, each of which
  // already belled and delivered a pay link on decideAndCharge's one real
  // run). Codex round-4 P1: distinguish the two on the PERSISTED
  // renewal_charge_skipped_at column (stamped by decideAndCharge itself —
  // stampRenewalChargeSkip — the instant any of those skips fires), never
  // by inferring "already handled" from a LIKE scan over the notifications
  // table. The old inference ran AFTER the row was already selected under
  // LIMIT: once a backlog of old, already-belled skips fills the page, the
  // per-row check discards every one of them but the LIMIT itself never
  // grows — so a genuine crash-gap row minted after that backlog can be
  // starved indefinitely, never reached by any tick. Excluding on the
  // column directly in SQL means only rows genuinely never decided reach
  // the LIMIT at all. No bell/skip stamp at all means decideAndCharge()
  // genuinely never ran (a crash between the mint committing and the
  // decide call in the SAME tick) — run it now.
  try {
    const staleCutoff = new Date(Date.now() - RECONCILE_NEVER_ATTEMPTED_AFTER_MS);
    const candidates = await conn('annual_prepay_terms as t')
      .whereNotNull('t.renewed_from_term_id')
      .whereNotNull('t.annual_plan_version')
      .where('t.status', PAYMENT_PENDING_STATUS)
      .whereNull('t.renewal_charge_attempted_at')
      .whereNull('t.renewal_charge_skipped_at')
      .whereNull('t.dispute_suspended_at')
      // A started grace lapse owns this row (passes 5/6) — never re-decide
      // or retire it from here underneath that state machine.
      .whereNull('t.renewal_lapse_started_at')
      .where('t.created_at', '<', staleCutoff)
      // Chokepoint D: rows decideAndCharge deferred (a parent in dispute,
      // a failed delivery) rotate behind rows it has not tried yet.
      .orderByRaw('t.renewal_sweep_deferred_at asc nulls first')
      .orderBy('t.created_at', 'asc')
      .select('t.*')
      .limit(limit);
    counts.reconcileNeverAttemptedScanned = candidates.length;
    for (const successor of candidates) {
      try {
        const parent = await conn('annual_prepay_terms').where({ id: successor.renewed_from_term_id }).first();
        if (!parent) { counts.reconcileSkipped += 1; continue; }
        const outcome = await decideAndCharge(successor, parent, conn);
        if (outcome.status === 'charged') counts.charged += 1;
        else if (outcome.status === 'failed') counts.failed += 1;
        else counts.reconcileSkipped += 1;
      } catch (err) {
        counts.reconcileSkipped += 1;
        logger.error(`[termite-annual-renewal] reconcile (never-attempted) failed for successor ${successor.id}: ${err.message}`);
      }
    }
  } catch (err) {
    logger.error(`[termite-annual-renewal] reconcile (never-attempted) scan failed: ${err.message}`);
  }

  // 7b. renewal_charge_attempted_at IS NOT NULL, but no
  // stripe_invoice_charge_attempts row exists for the successor's invoice:
  // the claimed attempt provably never reached Stripe (a crash between the
  // atomic fence stamp and the actual Stripe call). Safe to deliver the
  // pay link — no money is or ever was in flight — and bell staff once
  // (permanent dedupe) as ambiguous. NEVER re-charged automatically. Codex
  // round-7 P1: excluded on the PERSISTED
  // renewal_charge_never_reached_stripe_belled_at column (20260926050002)
  // once the bell has actually been asked for — the SAME class of fix
  // round-4 P1 already gave leg 7a (renewal_charge_skipped_at) and
  // round-5/6 P1 gave the three exception-bell scans: without it, none of
  // this leg's own WHERE clauses ever change once handled (the successor
  // stays payment_pending, attempted_at stays set, no
  // stripe_invoice_charge_attempts row ever appears), so the SAME oldest
  // page re-selects forever and a newer crash-gap row past LIMIT can be
  // starved out of ever being reached.
  try {
    const candidates = await conn('annual_prepay_terms as t')
      .whereNotNull('t.renewed_from_term_id')
      .whereNotNull('t.annual_plan_version')
      .where('t.status', PAYMENT_PENDING_STATUS)
      .whereNotNull('t.renewal_charge_attempted_at')
      // Codex #4971 r7 P1: only a claim older than the recovery lease (the
      // same lease leg 7d applies to a pending outcome) — a fresh claim's
      // worker is still on its way to the gate. The retire under the gate
      // (bellAndVerifyDeliveryForNeverReachedStripe) is the authority.
      .where('t.renewal_charge_attempted_at', '<', new Date(Date.now() - RECONCILE_NEVER_ATTEMPTED_AFTER_MS))
      .whereNull('t.renewal_charge_never_reached_stripe_belled_at')
      // A recorded charge outcome (renewal_charge_failure_kind) means the
      // result is KNOWN — not a crash gap. Leg 7c owns it, with that kind's
      // delivery rules (payer_refused / ambiguous never get a pay link).
      // The write-ahead 'outcome_pending' is not a known outcome: with no
      // submitted attempt (this scan's own NOT EXISTS below) it IS the
      // crash gap this leg recovers.
      .where(function outcomeNotRecorded() {
        this.whereNull('t.renewal_charge_failure_kind').orWhere('t.renewal_charge_failure_kind', CHARGE_OUTCOME_PENDING);
      })
      .whereNull('t.dispute_suspended_at')
      .whereNull('t.renewal_lapse_started_at')
      // Chokepoint A (Codex #4971 round-3 P1, item 7): only an attempt with
      // durable SUBMISSION evidence proves Stripe was reached. The attempt
      // row is committed before the provider call, so an abandoned
      // pre-submit claim (a crash, or stripe.js's own stale-claim release
      // marking it failed) still has a row — the old bare NOT EXISTS hid it
      // from this recovery forever.
      .whereNotExists(function noSubmittedAttempt() {
        whereAttemptSubmitted(this.select(1).from('stripe_invoice_charge_attempts as a').whereRaw('a.invoice_id = t.prepay_invoice_id'));
      })
      .orderByRaw('t.renewal_sweep_deferred_at asc nulls first')
      .orderBy('t.renewal_charge_attempted_at', 'asc')
      .select('t.*')
      .limit(limit);
    counts.reconcileNeverReachedStripeScanned = candidates.length;
    for (const successor of candidates) {
      try {
        const handled = await bellAndVerifyDeliveryForNeverReachedStripe(successor, conn);
        if (handled === 'delivered') counts.reconcileNeverReachedStripeBelled += 1;
        if (handled) await stampNeverReachedStripeHandled(successor, conn);
      } catch (err) {
        logger.error(`[termite-annual-renewal] reconcile (never-reached-stripe) failed for successor ${successor.id}: ${err.message}`);
      }
    }
  } catch (err) {
    logger.error(`[termite-annual-renewal] reconcile (never-reached-stripe) scan failed: ${err.message}`);
  }
}

// Pass 4b (OWNER RULING, pre-push item 6): withdraw every open renewal
// successor whose parent has become DURABLY ineligible — staff cancel, a
// refund/void of the parent, flag removal, a switch — whether or not its
// renewal invoice was already sent. Before this, a sent renewal stayed
// payable until its grace deadline. The SQL pre-filter selects successors
// whose parent no longer authorizes them on its face (status/decision
// outside the allow-list, a revoked parent invoice, or a term_end that no
// longer lines up with the successor's start); parentRefusalForSuccessor
// then decides per row, and only a DURABLE refusal withdraws
// (withdrawRenewalSuccessor — the gate first, money in motion wins, bell
// before the void, no retrieval, no parent decision, no customer message).
// A transient one (the parent's own invoice in dispute) and every deferral
// rotate. Started lapses, dispute-suspended successors and staff-held
// manual reviews are excluded.
async function withdrawSuccessorsOfIneligibleParents({ conn = db, limit = 200, counts }) {
  try {
    const candidates = await conn('annual_prepay_terms as t')
      .join('annual_prepay_terms as p', 'p.id', 't.renewed_from_term_id')
      .leftJoin('invoices as pi', 'pi.id', 'p.prepay_invoice_id')
      .whereNotNull('t.annual_plan_version')
      .where('t.status', PAYMENT_PENDING_STATUS)
      .whereNull('t.dispute_suspended_at')
      .whereNull('t.renewal_lapse_started_at')
      .whereRaw("coalesce(t.renewal_lapse_outcome, '') <> 'manual_review'")
      // Codex #4971 r13 P1: a deleted account is a durable reason too — a
      // renewal whose fallback pay link already went out (its skip /
      // follow-through marker handled, so legs 7a-7c are done with it)
      // would otherwise stay payable, grace-covered and bound for a lapse's
      // station retrieval behind a still-eligible parent.
      .where(function withdrawalOwed() {
        whereParentNoLongerAuthorizes(this).orWhereExists(function customerDeleted() {
          this.select(1).from('customers as c').whereRaw('c.id = t.customer_id').whereNotNull('c.deleted_at');
        });
      })
      .orderByRaw('t.renewal_sweep_deferred_at asc nulls first')
      .orderBy('t.created_at', 'asc')
      .select('t.*')
      .limit(limit);
    counts.withdrawScanned = candidates.length;
    for (const successor of candidates) {
      try {
        const outcome = await withdrawIfParentDurablyIneligible(successor, conn);
        if (outcome === 'retired') counts.withdrawn += 1;
      } catch (err) {
        logger.error(`[termite-annual-renewal] withdrawal failed for successor ${successor.id}: ${err.message}`);
      }
    }
  } catch (err) {
    logger.error(`[termite-annual-renewal] withdrawal scan failed: ${err.message}`);
  }
}

// The SQL face of parentRefusalForSuccessor: the parent is outside
// resolveParentEligibility's allow-list (status/decision), its linked
// invoice is no longer settled-and-not-revoked (chokepoint A), or its
// term_end no longer lines up with the successor's start.
function whereParentNoLongerAuthorizes(query) {
  return query.where(function parentNoLongerAuthorizes() {
    this.whereNot(function allowListed() {
      this.whereIn('p.status', RENEWABLE_STATUSES)
        .orWhere(function renewedRenew() { this.where('p.status', 'renewed').where('p.renewal_decision', 'renew'); });
    })
      .orWhere(function parentInvoiceRevoked() {
        this.whereNotNull('p.prepay_invoice_id').whereNot(function settled() { whereInvoiceSettledNotRevoked(this, 'pi'); });
      })
      .orWhereRaw('t.term_start <> (p.term_end + 1)');
  });
}

// Pass 4b's per-row check: the customer's account deleted (Codex #4971 r13
// P1), else the parent's refusal. The withdrawal itself re-judges both under
// the gate (successorRecoveryRefusal).
async function withdrawalScanRefusal(successor, conn) {
  const deleted = await customerDeletedRefusal(conn, successor);
  if (deleted) return { eligible: false, durable: true, label: deleted.reason };
  const parent = await conn('annual_prepay_terms').where({ id: successor.renewed_from_term_id }).first();
  const refusal = await parentRefusalForSuccessor(conn, successor, parent);
  return { ...refusal, label: `the prior year no longer backs this renewal (${refusal.reason})` };
}

async function withdrawIfParentDurablyIneligible(successor, conn) {
  const refusal = await withdrawalScanRefusal(successor, conn);
  if (refusal.eligible || !refusal.durable) {
    await stampSweepDeferred(successor, conn);
    return 'deferred';
  }
  const outcome = await withdrawRenewalSuccessor(successor, refusal.label, conn);
  if (outcome === 'manual_review') {
    // A partial account credit: staff own it now — out of this scan.
    await conn('annual_prepay_terms').where({ id: successor.id }).update({ renewal_lapse_outcome: 'manual_review' });
  }
  return outcome;
}

// Leg 7c (Codex #4971 pre-push P1): a charge outcome whose follow-through
// (staff bell, and the pay link where one is owed) did not complete — see
// followThroughChargeOutcome. Re-runs ONLY the follow-through, never the
// charge; rotated so a persistently failing row never pins the page.
async function reconcileChargeFollowThrough({ conn = db, limit = 200, counts }) {
  try {
    const candidates = await conn('annual_prepay_terms as t')
      .whereNotNull('t.renewed_from_term_id')
      .whereNotNull('t.annual_plan_version')
      .where('t.status', PAYMENT_PENDING_STATUS)
      .whereNotNull('t.renewal_charge_failure_kind')
      // Not yet a known outcome — leg 7d resolves it first.
      .whereNot('t.renewal_charge_failure_kind', CHARGE_OUTCOME_PENDING)
      .whereNull('t.renewal_charge_failure_handled_at')
      .whereNull('t.dispute_suspended_at')
      .whereNull('t.renewal_lapse_started_at')
      .orderByRaw('t.renewal_sweep_deferred_at asc nulls first')
      .orderBy('t.renewal_charge_attempted_at', 'asc')
      .select('t.*')
      .limit(limit);
    counts.reconcileFollowThroughScanned = candidates.length;
    for (const successor of candidates) {
      try {
        await followThroughChargeOutcome(successor, successor.renewal_charge_failure_kind, successor.renewal_charge_failure_reason, conn);
      } catch (err) {
        logger.error(`[termite-annual-renewal] reconcile (charge follow-through) failed for successor ${successor.id}: ${err.message}`);
      }
    }
  } catch (err) {
    logger.error(`[termite-annual-renewal] reconcile (charge follow-through) scan failed: ${err.message}`);
  }
}

// Leg 7d (Codex #4971 r4 P1, write-ahead outcome): a claimed charge whose
// outcome was never recorded — the process died, or the outcome write
// failed, after the Stripe submission — still reads 'outcome_pending'. Once
// it is older than any charge still in flight could be, it is resolved from
// DURABLE evidence only, and NEVER by charging again:
//   - the successor left payment_pending, or its invoice is settled —
//     nothing is owed: cleared;
//   - an ACH debit still clearing — rotated (the paid sync clears it; a
//     failed debit reads as a failed attempt on a later tick);
//   - the submitted attempt failed at Stripe — recorded 'declined': leg 7c
//     sends the pay link and bells (no customer notice from a recovery);
//   - anything else (an attempt still claimed / ambiguous, or succeeded
//     without a settled invoice) — recorded 'ambiguous': leg 7c bells staff
//     to reconcile against Stripe, and never sends a pay link.
// A pending outcome with NO submitted attempt on a pending successor is leg
// 7b's crash gap (never reached Stripe), not this leg's. Runs before 7c, so
// a resolved row is followed through in the same sweep.
async function resolvePendingChargeOutcomes({ conn = db, limit = 200, counts }) {
  try {
    const cutoff = new Date(Date.now() - RECONCILE_NEVER_ATTEMPTED_AFTER_MS);
    const candidates = await conn('annual_prepay_terms as t')
      .whereNotNull('t.renewed_from_term_id')
      .whereNotNull('t.annual_plan_version')
      .where('t.renewal_charge_failure_kind', CHARGE_OUTCOME_PENDING)
      .where('t.renewal_charge_attempted_at', '<', cutoff)
      .where(function ownedByThisLeg() {
        this.whereNot('t.status', PAYMENT_PENDING_STATUS)
          .orWhereExists(function reachedStripe() {
            whereAttemptSubmitted(this.select(1).from('stripe_invoice_charge_attempts as a').whereRaw('a.invoice_id = t.prepay_invoice_id'));
          });
      })
      .orderByRaw('t.renewal_sweep_deferred_at asc nulls first')
      .orderBy('t.renewal_charge_attempted_at', 'asc')
      .select('t.*')
      .limit(limit);
    counts.reconcilePendingOutcomeScanned = candidates.length;
    for (const successor of candidates) {
      try {
        if (await resolvePendingChargeOutcome(successor, conn)) counts.reconcilePendingOutcomeResolved += 1;
      } catch (err) {
        logger.error(`[termite-annual-renewal] reconcile (pending charge outcome) failed for successor ${successor.id}: ${err.message}`);
      }
    }
  } catch (err) {
    logger.error(`[termite-annual-renewal] reconcile (pending charge outcome) scan failed: ${err.message}`);
  }
}

async function resolvePendingChargeOutcome(successor, conn) {
  const verdict = await pendingChargeOutcomeVerdict(successor, conn);
  if (verdict.kind === null) {
    await clearChargeOutcomePending(successor, conn);
    return true;
  }
  if (verdict.kind === 'in_motion') {
    await stampSweepDeferred(successor, conn);
    return false;
  }
  // Conditional on the pending marker: an in-line outcome that landed late
  // is never overwritten.
  const recorded = await conn('annual_prepay_terms')
    .where({ id: successor.id, renewal_charge_failure_kind: CHARGE_OUTCOME_PENDING })
    .update({
      renewal_charge_failure_kind: verdict.kind,
      renewal_charge_failure_reason: String(verdict.reason).slice(0, 500),
      renewal_charge_failure_handled_at: null,
    });
  return Boolean(recorded);
}

async function pendingChargeOutcomeVerdict(successor, conn) {
  if (successor.status !== PAYMENT_PENDING_STATUS) return { kind: null };
  // Codex #4971 pre-push P1: a disputed renewal's reopened invoice is not a
  // declined or ambiguous charge — the dispute owns it; rotated until it
  // resolves (then not payment_pending: the marker clears above).
  if (successorDisputeSuspended(successor)) return { kind: 'in_motion' };
  const invoice = await conn('invoices').where({ id: successor.prepay_invoice_id }).first(...INVOICE_EVIDENCE_COLUMNS);
  if (invoice && (await invoiceSettledNotRevoked(conn, invoice))) return { kind: null };
  if (classifyRenewalInvoice(invoice).processing) return { kind: 'in_motion' };
  const attempt = await whereAttemptSubmitted(
    conn('stripe_invoice_charge_attempts as a').where('a.invoice_id', successor.prepay_invoice_id),
  ).orderBy('a.created_at', 'desc').first('a.status', 'a.error_message', 'a.decline_code');
  if (attempt?.status === 'failed') {
    // Codex #4971 r16 P1 (finding 2): a crash before decideAndCharge's own
    // in-memory classifyChargeError ever ran leaves ONLY this persisted
    // 'failed' status behind — treating every one of those as a genuine
    // decline is wrong for authentication_required (classifyChargeError
    // itself reads that exact decline_code as 'ambiguous': the off-session
    // PaymentIntent can still be completed and succeed later), which used
    // to send a second pay link and a false decline notice beside a charge
    // that might still go through. decline_code is the SAME field stripe.js
    // persists on the attempt (resolveNoFundsSavedCardChargeAttempt);
    // absent on an attempt row from before this column existed, which
    // stays a genuine decline (the conservative default for a KNOWN decline
    // shape — never for an unclassified one, see the ambiguous fallback
    // below).
    if (attempt.decline_code === 'authentication_required') {
      return {
        kind: 'ambiguous',
        reason: `the charge failed at Stripe pending additional authentication (authentication_required) — its live PaymentIntent may still be completed and succeed: ${attempt.error_message || 'no reason recorded'}`,
      };
    }
    // Codex #4971 r23 P1: stripe.js persists decline_code ONLY for a
    // customer decline (the live path's own wavesCardDecline rule); a failed
    // attempt with no decline_code is a deterministic NON-decline error
    // (its raw code rides the message) — recovered as 'refused', the live
    // path's own outcome for that shape (pay link, neutral notice), never
    // as a false "your payment method was declined".
    if (!attempt.decline_code) {
      return { kind: 'refused', reason: `the charge failed at Stripe for a reason other than a decline: ${attempt.error_message || 'no reason recorded'}` };
    }
    return { kind: 'declined', reason: `the charge failed at Stripe: ${attempt.error_message || 'no reason recorded'}` };
  }
  return {
    kind: 'ambiguous',
    reason: `the charge reached Stripe but its outcome was never recorded (attempt ${attempt?.status || 'unknown'})`,
  };
}

// ---- entry point ----------------------------------------------------------

/**
 * Daily sweep entry point — registered alongside the other annual-prepay
 * jobs (server/services/workflows/renewal-reminder.js). No-op end to end
 * while GATE_TERMITE_ANNUAL_PLAN is off (read fresh on every call; no
 * restart needed to flip it).
 */
async function runTermiteAnnualRenewalSweep({ conn = db, limit = 200, today = etDateString() } = {}) {
  const counts = {
    noWitnessScanned: 0, noWitnessBelled: 0,
    unanchoredScanned: 0, unanchoredBelled: 0,
    staleOverdueScanned: 0, staleOverdueBelled: 0,
    candidatesScanned: 0, minted: 0, charged: 0, failed: 0, skipped: 0,
    graceScanned: 0, graceLapsed: 0, graceReconciliationDeferred: 0, graceRetiredSettled: 0,
    lapseEffectsScanned: 0, lapseEffectsReconciled: 0,
    reconcileNeverAttemptedScanned: 0, reconcileSkipped: 0,
    reconcileNeverReachedStripeScanned: 0, reconcileNeverReachedStripeBelled: 0,
    reconcileFollowThroughScanned: 0,
    reconcilePendingOutcomeScanned: 0, reconcilePendingOutcomeResolved: 0,
    latePaidScanned: 0, latePaidBelled: 0,
    withdrawScanned: 0, withdrawn: 0,
    parentRenewedScanned: 0, parentRenewedStamped: 0,
  };
  if (!termiteAnnualRenewalChargeLive()) return { ...counts, gate: 'off' };
  if (!(await db.schema.hasTable('annual_prepay_terms'))) return { ...counts, gate: 'on', tableMissing: true };

  await bellNoWitnessTerms({ conn, limit, today, counts });
  await bellUnanchoredOriginalTerms({ conn, limit, today, counts });
  await bellStaleOverdueTerms({ conn, limit, today, counts });
  await processRenewalCandidates({ conn, limit, today, counts });
  await withdrawSuccessorsOfIneligibleParents({ conn, limit, counts });
  await processGraceLapses({ conn, limit, counts });
  await reconcileMissedLapseEffects({ conn, limit, counts });
  await reconcileStuckSuccessors({ conn, limit, counts });
  await resolvePendingChargeOutcomes({ conn, limit, counts });
  await reconcileChargeFollowThrough({ conn, limit, counts });
  await bellLatePaidRenewals({ conn, limit, counts });
  // Codex round-2 P1 backstop: an active, paid successor whose parent
  // never got its 'renewed' stamp (stampParentRenewedForSuccessor's own
  // savepoint failed and was swallowed to protect the successor's own
  // activation) gets it here, idempotently.
  try {
    const parentRenewed = await require('./annual-prepay-renewals').reconcileParentRenewedStamps({ conn, limit });
    counts.parentRenewedScanned = parentRenewed.scanned;
    counts.parentRenewedStamped = parentRenewed.stamped;
  } catch (err) {
    logger.error(`[termite-annual-renewal] parent-renewed reconcile failed: ${err.message}`);
  }
  return { ...counts, gate: 'on' };
}

module.exports = {
  runTermiteAnnualRenewalSweep,
  withRenewalSendClearance,
  withRenewalGate,
  withCustomerDeletionGate,
  afterParentChange,
  withdrawUnpaidSuccessorOfParent,
  withdrawSuccessorIfNoLongerBacked,
  withdrawUnpaidSuccessorsOfCustomers,
  renewalPaymentRefusal,
  withRenewalPaymentClearance,
  termiteAnnualRenewalChargeLive,
  renewalMoneyInMotionForParent,
  renewalMoneyInMotionForTerm,
  onRenewalSuccessorPaid,
  _private: {
    mintRenewalSuccessor,
    lapseVoidAlreadyRanFor,
    decideAndCharge,
    resolveChargeEligibility,
    chargeRefusalUnderGate,
    paidAfterParentChanged,
    successorSettledAtSql,
    retireAbandonedChargeClaim,
    resolvePendingChargeOutcomes,
    bellLatePaidRenewals,
    bellLatePaidRenewal,
    clearChargeOutcomePending,
    CHARGE_OUTCOME_PENDING,
    resolveLapseVoidEligibility,
    resolveParentEligibility,
    parentInvoicePaidAndNotFullyRefunded,
    classifyRenewalInvoice,
    invoiceSettledNotRevoked,
    invoiceLedgerRevocation,
    statementRevocationForInvoice,
    INVOICE_EVIDENCE_COLUMNS,
    resolvePendingChargeOutcome,
    handleRefusalAtSubmission,
    handleChargeFailure,
    successorDisputeSuspended,
    whereSuccessorNotDisputeSuspended,
    successorShapeBacksRenewal,
    PAID_RENEWAL_AWAITING_PARENT_STAMP,
    successorPaymentBacksRenewal,
    whereSuccessorPaymentBacksRenewal,
    whereInvoiceSettledNotRevoked,
    whereInvoiceDelivered,
    whereAttemptSubmitted,
    whereAttemptPresented,
    renewalWasPresented,
    payLinkVerdict,
    withdrawRenewalSuccessor,
    classifyVoidRefusal,
    checkStillEligibleForRenewalAction,
    processGraceLapseForTerm,
    processGraceLapses,
    bellHeldOverdueRenewals,
    HELD_RENEWAL_BELL_SCAN_LIMIT,
    successorRecoveryRefusal,
    actOnRecoveryRefusal,
    successorActionBlocker,
    collectionsDisputeHoldBlocks,
    reconcileMissedLapseEffects,
    reconcileStuckSuccessors,
    reconcileChargeFollowThrough,
    followThroughChargeOutcome,
    withdrawSuccessorsOfIneligibleParents,
    renewalMoneyInMotion,
    deliverRenewalInvoice,
    sendRenewalChargeFailedNotice,
    recordChargeFailedNoticeOutcome,
    chargeFailedNoticeMustRetry,
    bellNoWitnessTerms,
    bellUnanchoredOriginalTerms,
    bellStaleOverdueTerms,
    whereDueForRenewal,
    whereNoticeWitnessed,
    whereAnchoredOrSuccessor,
    whereWithinRenewalWindow,
    whereRenewalCandidate,
    parentRefusalForSuccessor,
    addDaysYmd,
    graceDays,
    graceDeadlineFor,
    customerDeletedRefusal,
    ringRenewalBell,
  },
};
