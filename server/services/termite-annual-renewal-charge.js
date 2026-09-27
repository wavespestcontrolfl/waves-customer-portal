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
const { etDateString, addETDays, parseETDateTime } = require('../utils/datetime-et');
const { addMonthsSameDay, dateOnlyString } = require('../utils/date-only');
const { gateEnvValue } = require('../config/feature-gates');
const { INVOICE_CANCELLED_STATUSES } = require('./annual-prepay-invoice-statuses');

const RENEWABLE_STATUSES = ['active', 'renewal_pending'];
const PAYMENT_PENDING_STATUS = 'payment_pending';
const RENEWAL_CHARGE_FAILED_SMS_KEY = 'termite_annual_renewal_charge_failed';
// One-hour crash-gap tolerance for reconcile pass 7a (below) — long enough
// that an ordinary in-flight sweep tick is never mistaken for a crash.
const RECONCILE_NEVER_ATTEMPTED_AFTER_MS = 60 * 60 * 1000;

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
//                   NO full refund on the payments ledger against the
//                   invoice's Stripe identity — a full refund (or a lost
//                   dispute) lands there before, or without, any status sync
//                   (the SAME ledger shape coveredTermsAsOf reads)
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

async function invoiceFullyRefundedOnLedger(conn, invoice) {
  const refunded = await conn('payments')
    .whereRaw(
      `(status = 'refunded' or refund_status = 'full')
       and (
         (stripe_payment_intent_id is not null and stripe_payment_intent_id = ?)
         or (stripe_charge_id is not null and stripe_charge_id = ?)
       )`,
      [invoice.stripe_payment_intent_id || null, invoice.stripe_charge_id || null],
    )
    .first('id');
  return Boolean(refunded);
}

// JS form of "settled" (see the table above). SQL twin:
// whereInvoiceSettledNotRevoked, below.
async function invoiceSettledNotRevoked(conn, invoice) {
  const evidence = classifyRenewalInvoice(invoice);
  if (!evidence.paidEvidence || evidence.cancelled) return false;
  return !(await invoiceFullyRefundedOnLedger(conn, invoice));
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
        .whereRaw("(rp.status = 'refunded' or rp.refund_status = 'full')")
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

// Kept for its callers and tests: the parent's year is still paid (settled,
// above). Vacuously true with no linked invoice at all (a legacy manual
// term — historically covered, matching coveredTermsAsOf's carve-out).
async function parentInvoicePaidAndNotFullyRefunded(trx, invoiceId) {
  if (!invoiceId) return true;
  const invoice = await trx('invoices').where({ id: invoiceId }).first(...INVOICE_EVIDENCE_COLUMNS);
  if (!invoice) return true;
  return invoiceSettledNotRevoked(trx, invoice);
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
  if (!invoice || (await invoiceSettledNotRevoked(trx, invoice))) return { eligible: true };
  // Paid evidence that is nonetheless not settled = revoked (a cancelled/
  // refunded status or a full ledger refund) — durable. No paid evidence at
  // all = unpaid, which on a live parent means a reopened (disputed)
  // invoice — not durable.
  const evidence = classifyRenewalInvoice(invoice);
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
    const blocker = await successorActionBlocker(trx, successorId, { lock: true });
    if (blocker) return { eligible: false, ...blocker };

    // The ONE Stripe-attempt fence: claimed in the SAME transaction as
    // every check above, atomically, and never re-checked afterward. A
    // concurrent/retried tick that loses this race sees 0 rows updated and
    // does nothing further — no bell, no second charge, no second
    // delivery (whichever tick won already handles those).
    const claimed = await trx('annual_prepay_terms')
      .where({ id: successorId })
      .whereNull('renewal_charge_attempted_at')
      .update({ renewal_charge_attempted_at: new Date() });
    if (!claimed) return { eligible: false, reason: 'already_attempted' };
    return { eligible: true };
  });
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
async function successorActionBlocker(conn, successorId, { lock = false } = {}) {
  const read = (query) => (lock ? query.forUpdate() : query);
  const fresh = await read(conn('annual_prepay_terms').where({ id: successorId })).first();
  if (!fresh) return { reason: 'successor_not_found' };
  if (fresh.status !== PAYMENT_PENDING_STATUS) return { reason: `successor_status_${fresh.status}` };
  if (fresh.renewal_charge_attempted_at) return { reason: 'already_attempted' };
  // Paid, then disputed back to payment_pending: the dispute owns it.
  if (fresh.dispute_suspended_at) return { reason: 'successor_dispute_suspended' };

  if (fresh.renewed_from_term_id) {
    const parent = await read(conn('annual_prepay_terms').where({ id: fresh.renewed_from_term_id })).first();
    const parentEligibility = await parentRefusalForSuccessor(conn, fresh, parent);
    if (!parentEligibility.eligible) {
      return parentEligibility.durable
        ? { reason: parentEligibility.reason, retire: true }
        : { reason: parentEligibility.reason, defer: true };
    }
  }

  // Still within the successor's OWN grace deadline (the SAME GRACE_DAYS
  // window minting itself is bounded to, P1-2) — a long outage that leaves
  // the recovery leg running weeks late must never fire a months-overdue
  // charge or bill. Durable: that window never reopens.
  const deadline = graceDeadlineFor(fresh);
  if (deadline && etDateString() > deadline) return { reason: 'past_grace_deadline', retire: true, lapseOwnsPresented: true };

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
  const reached = await whereAttemptSubmitted(
    conn('stripe_invoice_charge_attempts as a').where('a.invoice_id', successor.prepay_invoice_id),
  ).first('a.id');
  return Boolean(reached);
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
// settled void refusal, or a lost bell — the caller writes no exclusion).
async function withdrawRenewalSuccessor(successor, reason, conn = db, { lapseOwnsPresented = false } = {}) {
  if (!successor.renewed_from_term_id) return withdrawSuccessorUnderGate(successor, reason, conn, lapseOwnsPresented);
  return require('./annual-prepay-renewals').withParentDecisionLock(
    successor.renewed_from_term_id,
    () => withdrawSuccessorUnderGate(successor, reason, conn, lapseOwnsPresented),
  );
}

async function withdrawSuccessorUnderGate(successor, reason, conn, lapseOwnsPresented) {
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
    const retired = await withdrawRenewalSuccessor(successor, refusal.reason, conn, { lapseOwnsPresented: refusal.lapseOwnsPresented });
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
  const delivered = await renewalInvoiceAlreadyDelivered(successor, conn)
    ? { ok: true }
    : await deliverRenewalInvoice(successor);
  const deliveryNote = delivered?.ok
    ? 'The renewal invoice was sent with its pay link.'
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
    logger.warn(`[termite-annual-renewal] saved-method resolution failed for term ${termId}: ${err.message}`);
    return null;
  }
}

// Self-contained sub-decision, extracted from decideAndCharge for the same
// reason as resolveChargeableSavedMethod above (P1-5): would a card
// surcharge push the collected total above the flat renewal fee the v3
// agreement quoted? A quote failure is non-fatal — the caller's own
// maxAuthorizedTotalCents ceiling on the actual charge still holds as the
// fail-closed backstop, so this defaults to "no" rather than blocking.
async function wouldSurchargeExceedFlatFee(successor, method, prepayAmountCents) {
  try {
    const StripeService = require('./stripe');
    const quote = await StripeService.quoteInvoiceSavedCardCharge(successor.prepay_invoice_id, method.paymentMethodRowId);
    return Math.round(Number(quote?.total) * 100) > prepayAmountCents;
  } catch (err) {
    logger.warn(`[termite-annual-renewal] pre-charge quote failed for term ${successor.id} — relying on the charge ceiling: ${err.message}`);
    return false;
  }
}

async function decideAndCharge(successor, parentTerm, conn = db) {
  const upfront = await checkStillEligibleForRenewalAction(successor.id, conn);
  if (!upfront.eligible) return handleChargeRefusal(successor, upfront, conn);

  if (!parentTerm.renewal_charge_consent_at) {
    await deliverInvoiceAndStampSkip(successor, 'no_consent', 'The prior term never recorded renewal-charge (Auto Pay) consent.', conn);
    return { status: 'no_consent' };
  }

  const method = await resolveChargeableSavedMethod(successor.customer_id, successor.id);
  if (!method) {
    await deliverInvoiceAndStampSkip(successor, 'no_method', 'No consented, chargeable saved payment method was found on file.', conn);
    return { status: 'no_method' };
  }

  const prepayAmountCents = Math.round(Number(successor.prepay_amount) * 100);

  // P1-5: pre-quote surcharge check, mirroring termite-annual-signature-
  // charge.js's own (lines ~308-323): a credit-card surcharge that would
  // push the collected total above the flat renewal fee the v3 agreement
  // quoted is not authorized by that signature — that customer gets the
  // pay link (showing the exact surcharge) instead of a silent over-
  // collection. Checked BEFORE the attempt fence is even stamped.
  if (await wouldSurchargeExceedFlatFee(successor, method, prepayAmountCents)) {
    await deliverInvoiceAndStampSkip(successor, 'surcharge_not_authorized', 'A credit-card surcharge would exceed the flat renewal fee the v3 agreement quoted, so it was not charged.', conn);
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
    maxAuthorizedTotalCents: prepayAmountCents,
    requireAutopayForCustomerId: successor.customer_id,
    requireSelfPayCustomerId: successor.customer_id,
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
      const AnnualPrepayRenewals = require('./annual-prepay-renewals');
      const outcome = await AnnualPrepayRenewals.withParentDecisionLock(successor.renewed_from_term_id, async () => {
        const freshParent = await conn('annual_prepay_terms').where({ id: successor.renewed_from_term_id }).first();
        const parentEligibility = await parentRefusalForSuccessor(conn, successor, freshParent);
        if (!parentEligibility.eligible) return { blocked: true, ...parentEligibility };
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
      return { status: 'charged' };
    }
    if (verified.status === 'processing') {
      // Bank ACH debit initiated — the payment webhook activates the
      // successor when it clears. Not a failure; nothing to bell or send.
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
  const reason = `the parent was decided elsewhere immediately before the charge attempt (${refusal.reason})`;
  if (refusal.durable) {
    const retired = await withdrawRenewalSuccessor(successor, reason, conn);
    return { status: 'ineligible', reason: refusal.reason, retired };
  }
  await ringRenewalBell(successor, 'ineligible', reason);
  return { status: 'ineligible', reason: refusal.reason };
}

async function handleChargeFailure(successor, err, conn = db) {
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
  // Codex #4971 pre-push P1: a follow-through that owes a pay link asks the
  // same "may a recovery leg still deliver?" question as leg 7b first — on
  // leg 7c's retries AND on the first run: that runs right after the charge
  // released the parent's gate (decideAndCharge), which is exactly when a
  // cancel or refund that queued behind the charge lands.
  if (FOLLOW_THROUGH_SENDS_PAY_LINK.has(kind)) {
    const settled = await followThroughRefusedDelivery(successor, conn);
    if (settled !== null) return settled;
  }
  let delivered = true;
  let bellKind = FOLLOW_THROUGH_BELL_KIND[kind] || 'ambiguous';
  if (FOLLOW_THROUGH_SENDS_PAY_LINK.has(kind) && !(await renewalInvoiceAlreadyDelivered(successor, conn))) {
    const delivery = await deliverRenewalInvoice(successor);
    // A payer assigned since the charge: the homeowner pay link is not owed
    // (nothing was sent) — staff are told to route it to the payer instead.
    if (delivery?.code === 'payer_billed') bellKind = 'payer_billed';
    delivered = Boolean(delivery?.ok) || delivery?.code === 'payer_billed';
  }
  const belled = await ringRenewalBell(successor, bellKind, reason);
  if (first && kind === 'declined' && bellKind === 'declined') {
    // Best-effort customer notice — never blocks the bell/pay-link
    // fallback above, which are the load-bearing parts of this path.
    await sendRenewalChargeFailedNotice(successor).catch((noticeErr) => {
      logger.warn(`[termite-annual-renewal] charge-failed customer notice failed for term ${successor.id}: ${noticeErr.message}`);
    });
  }
  const done = Boolean(belled) && delivered;
  if (done) {
    await markChargeFollowThroughHandled(successor, conn);
  } else {
    await stampSweepDeferred(successor, conn);
  }
  return done;
}

// null: the pay link may go out. Otherwise the follow-through's result —
// true once this leg is done (the successor withdrawn / left to the lapse,
// marked handled so leg 7c stops), false when it must be retried.
async function followThroughRefusedDelivery(successor, conn) {
  const blocked = await refuseRecoveryDelivery(successor, conn, 'the renewal charge did not go through');
  if (!blocked) return null;
  if (blocked === 'handled') await markChargeFollowThroughHandled(successor, conn);
  return blocked === 'handled';
}

async function markChargeFollowThroughHandled(successor, conn) {
  await conn('annual_prepay_terms').where({ id: successor.id }).update({ renewal_charge_failure_handled_at: new Date() });
}

async function recordChargeFollowThroughOwed(successor, kind, reason, conn) {
  await conn('annual_prepay_terms').where({ id: successor.id }).update({
    renewal_charge_failure_kind: kind,
    renewal_charge_failure_reason: reason ? String(reason).slice(0, 500) : null,
    renewal_charge_failure_handled_at: null,
  });
}

const RENEWAL_BELL_COPY = {
  // Codex round-7 P1: the delivery clause is now the dynamic `reason` —
  // built by deliverInvoiceAndStampSkip from deliverRenewalInvoice's OWN
  // verified return value — never a hardcoded "it was sent" regardless of
  // what actually happened.
  no_consent: (successor, reason) => ({
    title: 'Termite annual renewal — no auto-charge consent on file',
    body: `A renewal term for customer ${successor.customer_id} was minted (invoice for $${Number(successor.prepay_amount).toFixed(2)}), but the prior term never recorded renewal-charge consent — the card on file was NOT charged. ${reason}`,
  }),
  no_method: (successor, reason) => ({
    title: 'Termite annual renewal — no saved card to charge',
    body: `A renewal term for customer ${successor.customer_id} was minted (invoice for $${Number(successor.prepay_amount).toFixed(2)}), but no consented, chargeable saved payment method was found — the card on file was NOT charged. ${reason}`,
  }),
  surcharge_not_authorized: (successor, reason) => ({
    title: 'Termite annual renewal — card on file not charged (surcharge)',
    body: `The payment method on file for customer ${successor.customer_id}'s termite annual renewal (invoice for $${Number(successor.prepay_amount).toFixed(2)}) is a credit card whose surcharge would exceed the flat renewal fee the v3 agreement quoted, so it was not charged. ${reason}`,
  }),
  declined: (successor, reason) => ({
    title: 'Termite annual renewal — card on file declined',
    body: `The renewal charge of $${Number(successor.prepay_amount).toFixed(2)} for customer ${successor.customer_id}'s termite annual renewal was declined by the card on file: ${reason}. The renewal invoice was sent with its pay link instead. The card will NOT be retried automatically.`,
  }),
  refused: (successor, reason) => ({
    title: 'Termite annual renewal — card on file not charged',
    body: `The renewal charge of $${Number(successor.prepay_amount).toFixed(2)} for customer ${successor.customer_id}'s termite annual renewal was not attempted, or could not complete, for a reason other than a card decline: ${reason}. The renewal invoice was sent with its pay link instead. The card will NOT be retried automatically.`,
  }),
  // Codex #4971 pre-push P0: the renewal now routes to a third-party payer
  // (assigned after the mint, or recorded by the charge's own payer guard).
  // Neither the homeowner's card nor a homeowner pay link may collect it.
  payer_billed: (successor, reason) => ({
    title: 'Termite annual renewal — now billed to a third-party payer',
    body: `The renewal for customer ${successor.customer_id} (invoice for $${Number(successor.prepay_amount).toFixed(2)}) now routes to a third-party payer (${reason}). The card on file was NOT charged and NO pay link was sent to the homeowner — route this renewal to the payer by hand.`,
  }),
  ambiguous: (successor, reason) => ({
    title: 'Termite annual renewal — charge outcome unclear, needs reconciliation',
    body: `The renewal charge of $${Number(successor.prepay_amount).toFixed(2)} for customer ${successor.customer_id}'s termite annual renewal may or may not have gone through (${reason}). Check Stripe and the invoice before collecting any other way — the card will NOT be retried automatically.`,
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
async function ringRenewalBell(successor, kind, reason) {
  try {
    const NotificationService = require('./notification-service');
    const copy = (RENEWAL_BELL_COPY[kind] || RENEWAL_BELL_COPY.declined)(successor, reason);
    return await NotificationService.notifyAdmin('billing', copy.title, copy.body, {
      icon: '⚠️',
      bell: true,
      link: `/admin/customers?customerId=${encodeURIComponent(successor.customer_id)}`,
      dedupeKey: `termite-renewal-charge:${successor.id}:${kind}`,
      metadata: { termId: successor.id, customerId: successor.customer_id, reason: reason || null },
    });
  } catch (err) {
    logger.error(`[termite-annual-renewal] bell failed for term ${successor.id}: ${err.message}`);
    return null;
  }
}

// Codex #4971 pre-push P0 ("preserve payer refusals") — the one homeowner
// pay-link payer check. A payer can be assigned AFTER the mint, and these
// renewal invoices carry no completion-packet marker, so InvoiceService's
// own send path never re-checks the payer for them. Re-resolved right
// before anything reaches the homeowner, with the SAME resolver and shape
// as stripe.js's customer-default PAYER_BILLED_GUARD branch. Returns null
// (self-pay: the homeowner may be billed), 'payer_billed' (a third-party
// payer owns this bill — no homeowner pay link is owed), or
// 'payer_unverifiable' (the lookup failed — fail closed, retry later).
async function renewalPayerRouting(successor) {
  try {
    const resolved = await require('./payer').resolveForInvoice({
      database: db, customerId: successor.customer_id, throwOnError: true,
    });
    return resolved?.payerId ? 'payer_billed' : null;
  } catch (err) {
    logger.warn(`[termite-annual-renewal] payer re-check failed for term ${successor.id}: ${err.message}`);
    return 'payer_unverifiable';
  }
}

// Delivers the renewal invoice (with its pay link) exactly once per call —
// best-effort; a delivery failure never blocks the bell above, which is
// what actually gets a human looking at the account. THE homeowner
// pay-link sender: every caller goes through here (the no-consent /
// no-method / surcharge skip delivery, the charge follow-through for a
// decline or refusal, leg 7b's recovery), and it sends NOTHING when the
// bill now routes to a third-party payer ({ ok: false, code:
// 'payer_billed' } — not a retryable delivery failure: the homeowner pay
// link is simply not owed) or the payer cannot be verified ({ ok: false,
// code: 'payer_unverifiable' } — transient, fail closed).
async function deliverRenewalInvoice(successor) {
  const payerRouting = await renewalPayerRouting(successor);
  if (payerRouting) {
    logger.warn(`[termite-annual-renewal] renewal pay link withheld for term ${successor.id}: ${payerRouting}`);
    return { ok: false, code: payerRouting, error: payerRouting };
  }
  try {
    const InvoiceService = require('./invoice');
    const result = await InvoiceService.sendViaSMSAndEmail(successor.prepay_invoice_id, {
      payUrlParams: {
        source: 'termite_annual_renewal', saveCard: '1', saveRequired: '1', billingTerm: 'prepay_annual',
      },
    });
    if (!result?.ok) {
      logger.warn(`[termite-annual-renewal] renewal invoice delivery not ok for term ${successor.id}: ${result?.error || 'unknown'}`);
    }
    return result;
  } catch (err) {
    logger.error(`[termite-annual-renewal] renewal invoice delivery failed for term ${successor.id}: ${err.message}`);
    return { ok: false, error: err.message };
  }
}

// The templated "your renewal payment didn't go through" notice — only
// ever queued from handleChargeFailure on a GENUINE Stripe decline, never
// from a no-consent/no-method/surcharge skip or a guard refusal (nothing
// was attempted against Stripe, or the refusal wasn't the card's fault).
// Best-effort, never throws to the caller (its own caller already wraps it
// in .catch as a second layer). Sends only through the ordinary gated
// customer-messaging pipeline — nothing here bypasses quiet hours,
// opt-outs, or template enable state.
async function sendRenewalChargeFailedNotice(successor) {
  // It carries the homeowner pay URL — the same payer guard as the pay link.
  const payerRouting = await renewalPayerRouting(successor);
  if (payerRouting) return { sent: false, reason: payerRouting };
  const customer = await db('customers').where({ id: successor.customer_id }).first();
  if (!customer?.phone) return { sent: false, reason: 'no_phone' };
  const invoice = await db('invoices').where({ id: successor.prepay_invoice_id }).first('token');
  const { publicPortalUrl } = require('../utils/portal-url');
  const payUrl = invoice?.token ? `${publicPortalUrl()}/pay/${invoice.token}` : null;
  if (!payUrl) return { sent: false, reason: 'no_pay_url' };
  const { renderSmsTemplate } = require('./sms-template-renderer');
  const body = await renderSmsTemplate(RENEWAL_CHARGE_FAILED_SMS_KEY, {
    first_name: customer.first_name || 'there',
    amount: Number(successor.prepay_amount).toFixed(2),
    pay_url: payUrl,
  }, { workflow: 'termite_annual_renewal_charge_failed', entity_type: 'annual_prepay_term', entity_id: successor.id });
  if (!body) return { sent: false, reason: 'missing_template' };
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
            .whereExists(function reachedStripe() {
              whereAttemptSubmitted(this.select(1).from('stripe_invoice_charge_attempts as a').whereRaw('a.invoice_id = t.prepay_invoice_id'));
            });
        })
          .orWhere(function invoiceDelivered() { whereInvoiceDelivered(this, 'i'); });
      })
      .orderByRaw(`${deadlineSql} asc`) // most overdue first
      .select('t.*')
      .limit(limit);
    counts.graceScanned = candidates.length;
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
  return fresh.status === 'cancelled' && !fresh.renewal_decision
    && !!invoice && INVOICE_CANCELLED_STATUSES.has(invoiceStatusKey);
}

async function parentStillDecidableForLapse(trx, fresh) {
  if (!fresh.renewed_from_term_id) return { ok: true };
  const parent = await trx('annual_prepay_terms').where({ id: fresh.renewed_from_term_id }).forUpdate().first();
  const parentUndecidedOrOwnCancel = parent
    && ((RENEWABLE_STATUSES.includes(parent.status) && !parent.renewal_decision)
      || (parent.status === 'cancelled' && parent.renewal_decision === 'cancel'));
  if (parentUndecidedOrOwnCancel) return { ok: true };
  const reason = parent
    ? `the parent was already decided '${parent.renewal_decision || parent.status}'`
    : 'the parent no longer exists';
  return { ok: false, reason };
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
      return { outcome: 'deferred', kind: 'parent_decided_elsewhere', reason: parentCheck.reason };
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
async function processGraceLapseForTerm(term, conn = db) {
  let lapseStartedAt = term.renewal_lapse_started_at;
  if (!lapseStartedAt) {
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
      const fresh = await conn('annual_prepay_terms').where({ id: term.id }).first('renewal_lapse_started_at');
      lapseStartedAt = fresh?.renewal_lapse_started_at || null;
    }
    term = { ...term, renewal_lapse_started_at: lapseStartedAt };
  }

  // Codex round-7 P1 (2nd audit round): the eligibility re-check above
  // used to commit on its OWN, short-lived transaction, releasing its row
  // lock BEFORE the void and retrieval task ran — a renew/switch_plan
  // decision landing in that gap was ignored (the void and retrieval task
  // still fired against a plan an operator had just decided otherwise). A
  // dedicated-connection SESSION lock, held across the WHOLE sequence
  // (eligibility re-check through the final recordDecision('cancel')) —
  // the SAME mechanism and SAME key decideAndCharge's charge submission
  // uses — closes it: a decision (xact lock) racing in from elsewhere on
  // this SAME parent genuinely waits behind this whole sequence, or this
  // sequence's own eligibility re-check already sees it and defers with NO
  // void. The nested recordDecision('cancel') call below (SAME parent, SAME
  // async tree) never re-takes the lock — see heldParentDecisionLockStore's
  // doc in annual-prepay-renewals.js. A term with no parent (should not
  // occur for a real grace-lapse candidate, but defensive) skips the lock
  // entirely — nothing to serialize against.
  if (!term.renewed_from_term_id) {
    return processGraceLapseSequence(term, conn);
  }
  const AnnualPrepayRenewals = require('./annual-prepay-renewals');
  return AnnualPrepayRenewals.withParentDecisionLock(
    term.renewed_from_term_id,
    () => processGraceLapseSequence(term, conn),
  );
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

async function processGraceLapseSequence(term, conn) {
  const eligibility = await resolveLapseVoidEligibility(term, conn);
  if (eligibility.outcome === 'deferred') {
    const manualReview = eligibility.kind === 'parent_decided_elsewhere';
    return holdLapse(term, conn, {
      manualReview,
      kind: manualReview ? 'lapse_parent_decided_elsewhere' : 'lapse_reconciliation_pending',
      reason: eligibility.reason,
    });
  }
  if (eligibility.outcome === 'retired') return retireSettledLapse(term, conn, eligibility.reason);

  const voidOutcome = await voidLapsedInvoice(term, conn);
  if (voidOutcome) return voidOutcome;
  if (!(await raiseGraceLapseRetrievalTask(term, conn))) {
    return holdLapse(term, conn, { manualReview: false, reason: 'the station-retrieval step is not confirmed yet' });
  }
  if (!(await decideParentLapse(term, conn))) {
    return holdLapse(term, conn, { manualReview: false, reason: 'the parent lapse decision did not record' });
  }
  await conn('annual_prepay_terms').where({ id: term.id }).update({ renewal_lapse_completed_at: new Date(), renewal_lapse_outcome: 'lapsed' });
  return 'lapsed';
}

// Record the decided lapse ('cancel') on the PARENT. Returns true when the
// parent reads decided 'cancel' afterwards.
async function decideParentLapse(term, conn) {
  if (!term.renewed_from_term_id) return true;
  try {
    const decided = await require('./annual-prepay-renewals').recordDecision({ termId: term.renewed_from_term_id, action: 'cancel', conn });
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
    const candidates = await conn('annual_prepay_terms as t')
      .whereNotNull('t.renewal_lapse_started_at')
      .whereNull('t.renewal_lapse_completed_at')
      // Chokepoint D (item 4): a manual-review hold is staff's now, never
      // re-run here; a self-clearing deferral rotates behind rows this
      // pass has not retried yet — see holdLapse.
      .whereRaw("coalesce(t.renewal_lapse_outcome, '') <> 'manual_review'")
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
async function successorRecoveryRefusal(successor, conn) {
  if (successor.renewed_from_term_id) {
    const parent = await conn('annual_prepay_terms').where({ id: successor.renewed_from_term_id }).first();
    const parentEligibility = await parentRefusalForSuccessor(conn, successor, parent);
    if (!parentEligibility.eligible) {
      return { reason: `the parent is no longer eligible (${parentEligibility.reason})`, retire: parentEligibility.durable };
    }
  }
  const deadline = graceDeadlineFor(successor);
  if (deadline && etDateString() > deadline) return { reason: 'past_grace_deadline', retire: true, lapseOwnsPresented: true };
  return null;
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
  if (!refusal) return null;
  if (refusal.retire) {
    const outcome = await withdrawRenewalSuccessor(successor, refusal.reason, conn, { lapseOwnsPresented: refusal.lapseOwnsPresented });
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
}

async function bellAndVerifyDeliveryForNeverReachedStripe(successor, conn) {
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
  const invoice = classifyRenewalInvoice(await conn('invoices').where({ id: successor.prepay_invoice_id }).first(...INVOICE_EVIDENCE_COLUMNS));
  if (invoice.delivered) return true;
  const delivery = await deliverRenewalInvoice(successor);
  if (delivery?.ok) return 'delivered';
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
      .whereNull('t.renewal_charge_never_reached_stripe_belled_at')
      // A recorded charge outcome (renewal_charge_failure_kind) means the
      // result is KNOWN — not a crash gap. Leg 7c owns it, with that kind's
      // delivery rules (payer_refused / ambiguous never get a pay link).
      .whereNull('t.renewal_charge_failure_kind')
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
    const candidates = await whereParentNoLongerAuthorizes(
      conn('annual_prepay_terms as t')
        .join('annual_prepay_terms as p', 'p.id', 't.renewed_from_term_id')
        .leftJoin('invoices as pi', 'pi.id', 'p.prepay_invoice_id')
        .whereNotNull('t.annual_plan_version')
        .where('t.status', PAYMENT_PENDING_STATUS)
        .whereNull('t.dispute_suspended_at')
        .whereNull('t.renewal_lapse_started_at')
        .whereRaw("coalesce(t.renewal_lapse_outcome, '') <> 'manual_review'"),
    )
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

async function withdrawIfParentDurablyIneligible(successor, conn) {
  const parent = await conn('annual_prepay_terms').where({ id: successor.renewed_from_term_id }).first();
  const refusal = await parentRefusalForSuccessor(conn, successor, parent);
  if (refusal.eligible || !refusal.durable) {
    await stampSweepDeferred(successor, conn);
    return 'deferred';
  }
  const outcome = await withdrawRenewalSuccessor(successor, `the prior year no longer backs this renewal (${refusal.reason})`, conn);
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
  await reconcileChargeFollowThrough({ conn, limit, counts });
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
  termiteAnnualRenewalChargeLive,
  _private: {
    mintRenewalSuccessor,
    decideAndCharge,
    resolveChargeEligibility,
    resolveLapseVoidEligibility,
    resolveParentEligibility,
    parentInvoicePaidAndNotFullyRefunded,
    classifyRenewalInvoice,
    invoiceSettledNotRevoked,
    whereInvoiceSettledNotRevoked,
    whereInvoiceDelivered,
    whereAttemptSubmitted,
    renewalWasPresented,
    withdrawRenewalSuccessor,
    classifyVoidRefusal,
    checkStillEligibleForRenewalAction,
    processGraceLapseForTerm,
    processGraceLapses,
    reconcileMissedLapseEffects,
    reconcileStuckSuccessors,
    reconcileChargeFollowThrough,
    followThroughChargeOutcome,
    withdrawSuccessorsOfIneligibleParents,
    renewalMoneyInMotion,
    deliverRenewalInvoice,
    sendRenewalChargeFailedNotice,
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
  },
};
