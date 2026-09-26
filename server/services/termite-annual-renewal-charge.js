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
// in workflows/renewal-reminder.js) over SEVEN independent passes, each
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
//      alert. Each scan now excludes on renewal_exception_belled_at
//      directly in SQL (stampRenewalExceptionBelled, stamped once the bell
//      has actually been asked for — fresh or deduped, either way staff
//      has been told) instead of relying on dedupe alone.
//   4. processRenewalCandidates — for every due, witnessed, anchor-eligible,
//      NOT-stale, undecided termite term with no successor yet: mints the
//      successor term + its renewal invoice (§2), then decides whether to
//      charge it (§3).
//   5. processGraceLapses — for a FRESH (never-started) unpaid successor
//      past its own payment grace deadline (GRACE_DAYS from whichever is
//      LATER of its term_start or its own created_at — see
//      annual-prepay-renewals.js's termiteRenewalGraceDeadlineFor, the SAME
//      formula coveredTermsAsOf's grace-coverage branch reads, P2-4) whose
//      renewal invoice was actually presented to the customer (a charge
//      was attempted, or the invoice was sent / is not still a draft):
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
//
// P2-4 coverage note (owner ruling 2026-09-26): an unpaid successor stays
// COVERED (no per-visit billing) through its own GRACE_DAYS payment window —
// see annual-prepay-renewals.js's coveredTermsAsOf, the
// termiteRenewalGraceCovered branch, sharing the exact same cutoff formula
// this file's grace-lapse pass voids on.
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
//     the parent (docs/annual-prepay-term-states.md move 14) — or
//     recordDecision('cancel') on a grace lapse (move 15). Both reuse the
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

// Codex round-5 P1: persisted exclusion for the three exception-bell scans
// below (bellNoWitnessTerms / bellUnanchoredOriginalTerms /
// bellStaleOverdueTerms) — stamped once a term's exception bell has
// actually been asked for, whether it fired fresh or deduped from a prior
// tick (either way staff has already been told). Each scan excludes on
// this column directly in SQL, so once more than one scan's LIMIT worth
// of terms sit in the SAME exception bucket, the oldest ones stop
// consuming every tick's LIMIT slot and a newer term past that backlog
// still gets scanned and belled. Never affects a term's eligibility for
// minting/charging once its underlying condition is actually fixed — only
// these three scans read it.
async function stampRenewalExceptionBelled(term, kind, conn = db) {
  try {
    await conn('annual_prepay_terms')
      .where({ id: term.id })
      .whereNull('renewal_exception_belled_at')
      .update({ renewal_exception_belled_at: new Date(), renewal_exception_kind: kind });
  } catch (err) {
    logger.error(`[termite-annual-renewal] failed to stamp renewal_exception_belled_at for term ${term.id} (${kind}): ${err.message}`);
  }
}

// Codex round-4 P0: an ALLOW-list, never a deny-list, for whether a PARENT
// term is still in a state that authorizes minting a successor against it,
// or charging one already minted. "Eligible" is exactly:
//   - still undecided and live (RENEWABLE_STATUSES — active/
//     renewal_pending) — no invoice condition, matching coveredTermsAsOf's
//     OWN asymmetry (its ACTIVE_STATUSES branch carries none either): this
//     status is reachable ONLY through a paid invoice (move 2) or a
//     legacy no-invoice term born active, so it needs no separate check;
//   - OR already decided 'renewed' with renewal_decision === 'renew' (the
//     theoretical race where the successor's OWN payment already flipped
//     its parent by the time this re-checks) — but ONLY while its OWN
//     prepay invoice still reads paid (no linked invoice at all — a
//     legacy manual term — is treated as historically covered). This is
//     the SAME paid test annual-prepay-renewals.js's coveredTermsAsOf
//     reads for its DECIDED_COVERED_STATUSES branch (decidedInvoicePaid,
//     ~2706): a lost dispute or chargeback on the PARENT's own invoice can
//     reopen it to 'overdue' with its PI linkage cleared WITHOUT touching
//     the parent's status or renewal_decision, so the status check alone
//     cannot see it.
//
// Everything else is refused: 'cancelled' in EITHER shape (a staff
// void/refund via move 9, or the unguarded DELETE /:id/annual-prepay flag
// removal via move 13 — both leave renewal_decision NULL), 'canceled'/
// 'refunded' (legacy names), 'payment_pending' (a dispute on the parent's
// OWN invoice reopened it, move 10), 'switch_plan', or no parent row at
// all. The pre-fix shape checked ONLY renewal_decision — a cancelled
// parent with renewal_decision IS NULL (exactly moves 9 and 13's shape)
// slipped straight through undetected.
function parentEligibleForRenewalAction(parent, parentInvoice) {
  if (!parent) return false;
  if (RENEWABLE_STATUSES.includes(parent.status)) return true;
  if (parent.status === 'renewed' && parent.renewal_decision === 'renew') {
    if (!parent.prepay_invoice_id) return true;
    const invStatus = String(parentInvoice?.status || '').toLowerCase();
    return invStatus === 'paid' || Boolean(parentInvoice?.paid_at);
  }
  return false;
}

// Reason string for an ineligible parent — a sibling of
// parentEligibleForRenewalAction so resolveChargeEligibility's own trx
// callback doesn't have to re-derive it inline. Only ever called once that
// function has already returned false.
function reasonForIneligibleParent(parent) {
  if (!parent) return 'parent_missing';
  if (parent.status === 'renewed' && parent.renewal_decision === 'renew') return 'parent_invoice_unpaid';
  if (parent.renewal_decision) return `parent_decided_${parent.renewal_decision}`;
  return `parent_status_${parent.status}`;
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

// P1-4: the renewal-notice witness is ONLY the termite-specific, on-time
// 45-day rung (slice A2) — the v3 agreement's auto-charge authorization
// presumes the customer got THAT notice. The generic notice_30_sent_at rung
// every annual-prepay term (termite or not) already carries is deliberately
// NOT an accepted alternative: a notice sent LATE (PR #4921's
// notice_45_late_sent_at column — not live on main yet, so it is never
// referenced here) leaves notice_45_sent_at NULL and must fall into
// bellNoWitnessTerms below, not slip through on the 30-day rung.
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

// ---- pass 1: no-witness exception bell ---------------------------------

async function bellNoWitnessTerms({ conn = db, limit = 200, today = etDateString(), counts }) {
  try {
    const rows = await whereDueForRenewal(
      conn('annual_prepay_terms as t'),
      today,
    )
      .whereNull('t.notice_45_sent_at')
      // Codex round-5 P1: excluded here, not just deduped at bell time —
      // see stampRenewalExceptionBelled's own doc.
      .whereNull('t.renewal_exception_belled_at')
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
        await stampRenewalExceptionBelled(term, 'no_witness', conn);
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
      .whereNull('t.renewal_exception_belled_at')
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
        await stampRenewalExceptionBelled(term, 'unanchored', conn);
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
      .whereNull('t.renewal_exception_belled_at')
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
        await stampRenewalExceptionBelled(term, 'stale_overdue', conn);
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
async function mintRenewalSuccessor(parentTermId, conn = db) {
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
    if (!parent.annual_plan_version) return null;
    // Mint only ever fires for a still-undecided parent (P2-1) — checked
    // FIRST, so parentEligibleForRenewalAction's 'renewed'+'renew' branch
    // (which needs a paid-invoice re-check) can never apply here; only its
    // plain RENEWABLE_STATUSES branch matters. Codex round-4 P0: reuses the
    // SAME allow-list resolveChargeEligibility's parent re-check uses below
    // — a cancelled/canceled/refunded/payment_pending/switch_plan parent
    // (moves 9, 10, 13) can never mint a successor either way.
    if (parent.renewal_decision) return null;
    if (!parentEligibleForRenewalAction(parent, null)) return null;

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
    const prepayAmount = Number(parent.prepay_amount);
    if (!Number.isFinite(prepayAmount) || prepayAmount <= 0) {
      throw new Error(`parent term ${parent.id} has no valid prepay_amount to renew (${parent.prepay_amount})`);
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

    // Frozen-price enforcement, mirroring the original activation's own
    // guard (estimate-converter.js): the minted invoice must equal the
    // quoted renewal fee to the cent, with no tax picked up.
    const mintedTotalCents = Math.round(Number(invoice.total) * 100);
    const expectedCents = Math.round(prepayAmount * 100);
    if (mintedTotalCents !== expectedCents || Math.round(Number(invoice.tax_amount || 0) * 100) !== 0) {
      throw new Error(`renewal invoice for term ${parent.id} does not match the quoted renewal fee (total ${invoice.total} vs ${prepayAmount}, tax ${invoice.tax_amount})`);
    }

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
//   - its PARENT passes parentEligibleForRenewalAction's ALLOW-list (still
//     undecided/live, or decided 'renew' with its own invoice still paid)
//     — a customer decline (recordDecision('cancel')), a refund/void sync
//     that left it cancelled with NO decision recorded (Codex round-4 P0),
//     or a missing parent row all wins over an in-flight charge, even one
//     racing in right after the mint
//   - its own renewal invoice is not void/cancelled/refunded/already paid
//   - today is still within the successor's OWN grace deadline (the SAME
//     GRACE_DAYS window minting itself is bounded to, P1-2) — a long
//     outage that leaves the recovery leg running weeks late must bell
//     staff, never fire a months-overdue charge.
// Returns { eligible: true } with the fence ALREADY claimed, or
// { eligible: false, reason } with nothing claimed and nothing charged.
async function resolveChargeEligibility(successorId, conn = db) {
  return conn.transaction(async (trx) => {
    const freshSuccessor = await trx('annual_prepay_terms').where({ id: successorId }).forUpdate().first();
    if (!freshSuccessor) return { eligible: false, reason: 'successor_not_found' };
    if (freshSuccessor.status !== PAYMENT_PENDING_STATUS) {
      return { eligible: false, reason: `successor_status_${freshSuccessor.status}` };
    }
    if (freshSuccessor.renewal_charge_attempted_at) return { eligible: false, reason: 'already_attempted' };

    if (freshSuccessor.renewed_from_term_id) {
      const parent = await trx('annual_prepay_terms').where({ id: freshSuccessor.renewed_from_term_id }).forUpdate().first();
      // Codex round-4 P0: an ALLOW-list (parentEligibleForRenewalAction),
      // not a deny-list on renewal_decision alone. The pre-fix check only
      // rejected an explicit non-'renew' decision, so a parent moved to
      // 'cancelled' with renewal_decision IS NULL by an UNRELATED path —
      // the existing refund/void sync (move 9) or the unguarded annual-
      // prepay-flag removal (move 13) — passed straight through and could
      // still get auto-charged after the fact. A missing parent row is
      // also refused (`parentEligibleForRenewalAction(null, ...)` is
      // false) rather than silently treated as fine.
      let parentInvoice = null;
      if (parent?.status === 'renewed' && parent.prepay_invoice_id) {
        parentInvoice = await trx('invoices').where({ id: parent.prepay_invoice_id }).first('status', 'paid_at');
      }
      if (!parentEligibleForRenewalAction(parent, parentInvoice)) {
        return { eligible: false, reason: reasonForIneligibleParent(parent) };
      }
    }

    const deadline = graceDeadlineFor(freshSuccessor);
    if (deadline && etDateString() > deadline) {
      return { eligible: false, reason: 'past_grace_deadline' };
    }

    if (freshSuccessor.prepay_invoice_id) {
      const invoice = await trx('invoices').where({ id: freshSuccessor.prepay_invoice_id }).first('status');
      const invStatus = String(invoice?.status || '').toLowerCase();
      if (invoice && (INVOICE_CANCELLED_STATUSES.has(invStatus) || invStatus === 'paid')) {
        return { eligible: false, reason: `invoice_${invStatus}` };
      }
    }

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

// Everything after the mint transaction commits: resolve consent + a
// chargeable saved method, and either attempt the ONE Stripe charge or
// hand the renewal off to the pay-link + bell fallback. Never throws.
async function decideAndCharge(successor, parentTerm, conn = db) {
  if (!parentTerm.renewal_charge_consent_at) {
    await deliverRenewalInvoice(successor);
    await ringRenewalBell(successor, 'no_consent', 'the prior term never recorded renewal-charge (Auto Pay) consent');
    await stampRenewalChargeSkip(successor, 'no_consent', conn);
    return { status: 'no_consent' };
  }

  const RecurringCards = require('./recurring-card-on-file');
  let method = null;
  try {
    method = await RecurringCards.resolvePrepayChargeMethod({
      policy: { exemptReason: 'autopay_already_active' },
      customerId: successor.customer_id,
    });
  } catch (err) {
    logger.warn(`[termite-annual-renewal] saved-method resolution failed for term ${successor.id}: ${err.message}`);
    method = null;
  }
  if (!method?.paymentMethodRowId) {
    await deliverRenewalInvoice(successor);
    await ringRenewalBell(successor, 'no_method', 'no consented, chargeable saved payment method was found on file');
    await stampRenewalChargeSkip(successor, 'no_method', conn);
    return { status: 'no_method' };
  }

  const prepayAmountCents = Math.round(Number(successor.prepay_amount) * 100);

  // P1-5: pre-quote surcharge check, mirroring termite-annual-signature-
  // charge.js's own (lines ~308-323): a credit-card surcharge that would
  // push the collected total above the flat renewal fee the v3 agreement
  // quoted is not authorized by that signature — that customer gets the
  // pay link (showing the exact surcharge) instead of a silent over-
  // collection. Checked BEFORE the attempt fence is even stamped; a quote
  // failure here is not fatal — the charge's own maxAuthorizedTotalCents
  // ceiling below still holds as the fail-closed backstop.
  try {
    const StripeService = require('./stripe');
    const quote = await StripeService.quoteInvoiceSavedCardCharge(successor.prepay_invoice_id, method.paymentMethodRowId);
    if (Math.round(Number(quote?.total) * 100) > prepayAmountCents) {
      await deliverRenewalInvoice(successor);
      await ringRenewalBell(successor, 'surcharge_not_authorized', 'a credit-card surcharge would exceed the flat renewal fee the v3 agreement quoted');
      await stampRenewalChargeSkip(successor, 'surcharge_not_authorized', conn);
      return { status: 'surcharge_not_authorized' };
    }
  } catch (err) {
    logger.warn(`[termite-annual-renewal] pre-charge quote failed for term ${successor.id} — relying on the charge ceiling: ${err.message}`);
  }

  // P0: re-validate eligibility (parent still undecided/'renew', successor
  // still payment_pending, its invoice still open, still inside its own
  // grace deadline) and claim the Stripe-attempt fence ATOMICALLY, under
  // lock — the SAME function the recovery leg (reconcileStuckSuccessors)
  // uses, so a customer decline (or a lapse, or a stale recovery run)
  // racing in between the mint and this exact instant can never reach
  // Stripe from either caller.
  const eligibility = await resolveChargeEligibility(successor.id, conn);
  if (!eligibility.eligible) {
    if (eligibility.reason === 'already_attempted') return { status: 'already_attempted' };
    await ringRenewalBell(successor, 'ineligible', eligibility.reason);
    await stampRenewalChargeSkip(successor, `ineligible:${eligibility.reason}`, conn);
    return { status: 'ineligible', reason: eligibility.reason };
  }

  const StripeService = require('./stripe');
  let chargeResult;
  try {
    chargeResult = await StripeService.chargeInvoiceWithSavedCard(successor.prepay_invoice_id, method.paymentMethodRowId, {
      customerInitiated: false,
      maxAuthorizedChargeCents: prepayAmountCents,
      maxAuthorizedTotalCents: prepayAmountCents,
      requireAutopayForCustomerId: successor.customer_id,
      requireSelfPayCustomerId: successor.customer_id,
    });
  } catch (err) {
    await handleChargeFailure(successor, err);
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
    await ringRenewalBell(successor, 'ambiguous', verified.reason || 'post-charge status unverified');
    return { status: 'ambiguous', reason: verified.reason || 'post_charge_status_unverified' };
  } catch (err) {
    logger.error(`[termite-annual-renewal] post-charge invoice read failed for term ${successor.id}: ${err.message}`);
    await ringRenewalBell(successor, 'ambiguous', 'post_charge_status_unverified');
    return { status: 'ambiguous', reason: 'post_charge_status_unverified' };
  }
}

async function handleChargeFailure(successor, err) {
  const { classifyChargeError } = require('./termite-annual-signature-charge')._private;
  const classification = classifyChargeError(err);
  // P1-5: the customer "payment didn't go through" notice is queued ONLY
  // for a GENUINE Stripe decline — err.wavesCardDecline is the one marker
  // every other billing path in this repo (visit-completion-payment.js,
  // complete-scheduled-service.js, estimate-public.js) uses to tell a real
  // processor decline apart from an internal/guard refusal.
  const isGenuineDecline = !!err?.wavesCardDecline;
  logger.error(`[termite-annual-renewal] renewal charge failed for term ${successor.id}: ${classification.status} (${classification.reason})`);

  if (classification.status === 'ambiguous') {
    // Money may be moving — no pay link beside a possibly-successful
    // charge (mirrors the sibling's own ambiguous handling: bell only,
    // never a second collection rail).
    await ringRenewalBell(successor, 'ambiguous', classification.reason);
    return;
  }
  if (classification.status === 'deferred') {
    // Payer-billed guard (a payer was assigned after the mint): neither
    // the homeowner's card NOR the homeowner's pay link may collect a
    // payer's AR — staff route it by hand, exactly like the sibling.
    await ringRenewalBell(successor, 'refused', classification.reason);
    return;
  }
  // Every other refusal — a genuine Stripe decline, or a guard error (Auto
  // Pay inactive, the default method changed, a different active payment
  // in flight) — gets the pay link so the customer can still pay.
  await deliverRenewalInvoice(successor);
  await ringRenewalBell(successor, isGenuineDecline ? 'declined' : 'refused', classification.reason);
  if (isGenuineDecline) {
    // Best-effort customer notice — never blocks the bell/pay-link
    // fallback above, which are the load-bearing parts of this path.
    await sendRenewalChargeFailedNotice(successor).catch((noticeErr) => {
      logger.warn(`[termite-annual-renewal] charge-failed customer notice failed for term ${successor.id}: ${noticeErr.message}`);
    });
  }
}

const RENEWAL_BELL_COPY = {
  no_consent: (successor) => ({
    title: 'Termite annual renewal — no auto-charge consent on file',
    body: `A renewal term for customer ${successor.customer_id} was minted (invoice for $${Number(successor.prepay_amount).toFixed(2)}), but the prior term never recorded renewal-charge consent — the card on file was NOT charged. The renewal invoice was sent with its pay link.`,
  }),
  no_method: (successor) => ({
    title: 'Termite annual renewal — no saved card to charge',
    body: `A renewal term for customer ${successor.customer_id} was minted (invoice for $${Number(successor.prepay_amount).toFixed(2)}), but no consented, chargeable saved payment method was found — the card on file was NOT charged. The renewal invoice was sent with its pay link.`,
  }),
  surcharge_not_authorized: (successor) => ({
    title: 'Termite annual renewal — card on file not charged (surcharge)',
    body: `The payment method on file for customer ${successor.customer_id}'s termite annual renewal (invoice for $${Number(successor.prepay_amount).toFixed(2)}) is a credit card whose surcharge would exceed the flat renewal fee the v3 agreement quoted, so it was not charged. The renewal invoice was sent with its pay link instead; the customer sees the exact total before paying.`,
  }),
  declined: (successor, reason) => ({
    title: 'Termite annual renewal — card on file declined',
    body: `The renewal charge of $${Number(successor.prepay_amount).toFixed(2)} for customer ${successor.customer_id}'s termite annual renewal was declined by the card on file: ${reason}. The renewal invoice was sent with its pay link instead. The card will NOT be retried automatically.`,
  }),
  refused: (successor, reason) => ({
    title: 'Termite annual renewal — card on file not charged',
    body: `The renewal charge of $${Number(successor.prepay_amount).toFixed(2)} for customer ${successor.customer_id}'s termite annual renewal was not attempted, or could not complete, for a reason other than a card decline: ${reason}. The renewal invoice was sent with its pay link instead. The card will NOT be retried automatically.`,
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

// Delivers the renewal invoice (with its pay link) exactly once per call —
// best-effort; a delivery failure never blocks the bell above, which is
// what actually gets a human looking at the account.
async function deliverRenewalInvoice(successor) {
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
    const candidates = await whereWithinRenewalWindow(
      whereAnchoredOrSuccessor(whereNoticeWitnessed(whereDueForRenewal(conn('annual_prepay_terms as t'), today))),
      today,
    )
      .orderBy('t.term_end', 'asc')
      .select('t.*')
      .limit(limit);
    counts.candidatesScanned = candidates.length;
    for (const parent of candidates) {
      try {
        const mint = await mintRenewalSuccessor(parent.id, conn);
        if (!mint) { counts.skipped += 1; continue; }
        if (!mint.minted) { counts.skipped += 1; continue; } // another run already minted + decided this one
        counts.minted += 1;
        const outcome = await decideAndCharge(mint.successor, parent, conn);
        if (outcome.status === 'charged') counts.charged += 1;
        else if (outcome.status === 'failed') counts.failed += 1;
        else counts.skipped += 1;
      } catch (err) {
        counts.failed += 1;
        logger.error(`[termite-annual-renewal] renewal processing failed for parent term ${parent.id}: ${err.message}`);
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
// "Presented to the customer" = a charge was actually attempted against it
// (renewal_charge_attempted_at IS NOT NULL) OR its invoice is not still a
// draft that was never sent (some delivery evidence: not 'draft' status, or
// a sent_at/sms_sent_at/email_sent_at stamp). Without this, a successor
// that fell through every notification path (a crash before
// decideAndCharge ever ran — see pass 7a) would lapse and trigger station
// retrieval against a customer who was never told anything was due.
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
    const candidates = await conn('annual_prepay_terms as t')
      .leftJoin('invoices as i', 'i.id', 't.prepay_invoice_id')
      .whereNotNull('t.annual_plan_version')
      .whereNotNull('t.renewed_from_term_id')
      .where('t.status', PAYMENT_PENDING_STATUS)
      .whereNull('t.renewal_lapse_started_at')
      .where(function presented() {
        this.whereNotNull('t.renewal_charge_attempted_at')
          .orWhere(function invoiceDelivered() {
            this.whereNot('i.status', 'draft')
              .orWhereNotNull('i.sent_at')
              .orWhereNotNull('i.sms_sent_at')
              .orWhereNotNull('i.email_sent_at');
          });
      })
      .orderBy('t.term_start', 'asc')
      .select('t.*')
      .limit(limit * 2); // over-fetch: the per-row grace-deadline check below trims further
    counts.graceScanned = 0;
    let lapsed = 0;
    for (const term of candidates) {
      if (lapsed >= limit) break;
      const deadline = graceDeadlineFor(term);
      if (!deadline || etDateString() <= deadline) continue;
      counts.graceScanned += 1;
      try {
        const outcome = await processGraceLapseForTerm(term, conn);
        lapsed += 1;
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
// payment_pending, AND (if it has an invoice) that invoice is still
// collectible (isInvoiceCollectibleStatus, the SAME test every other money
// seam in this codebase shares, invoice-helpers.js) with no paid_at, AND
// (Codex round-2 P0, folded in here rather than left as a separate
// unlocked step) no Stripe charge reconciliation is pending on it
// (assertNoInvoiceChargeReconciliationPending, run against the SAME trx).
// A deny-list on "is it exactly 'prepaid'" would miss a SIMILARLY-settled
// status this file doesn't even know about yet. Returns { outcome:
// 'proceed' } (void is authorized), { outcome: 'retired', reason } (the
// caller must RETIRE the lapse instead of voiding), or { outcome:
// 'deferred', reason } (a pending reconciliation — retry next tick).
async function resolveLapseVoidEligibility(term, conn = db) {
  return conn.transaction(async (trx) => {
    const fresh = await trx('annual_prepay_terms').where({ id: term.id }).forUpdate().first();
    if (!fresh) return { outcome: 'retired', reason: 'the term no longer exists' };
    if (fresh.status !== PAYMENT_PENDING_STATUS) {
      return { outcome: 'retired', reason: `the successor is already ${fresh.status}, not payment_pending` };
    }
    if (fresh.prepay_invoice_id) {
      const { isInvoiceCollectibleStatus } = require('./invoice-helpers');
      const invoice = await trx('invoices').where({ id: fresh.prepay_invoice_id }).first('status', 'paid_at');
      if (invoice && (!isInvoiceCollectibleStatus(invoice.status) || invoice.paid_at)) {
        const paidNote = invoice.paid_at ? ' (paid_at set)' : '';
        return { outcome: 'retired', reason: `the invoice already reads ${invoice.status}${paidNote}` };
      }
      try {
        await require('./stripe').assertNoInvoiceChargeReconciliationPending(fresh.prepay_invoice_id, trx);
      } catch (reconErr) {
        return { outcome: 'deferred', reason: reconErr.message };
      }
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
  if (!term.renewal_lapse_started_at) {
    await conn('annual_prepay_terms').where({ id: term.id }).whereNull('renewal_lapse_started_at')
      .update({ renewal_lapse_started_at: new Date() });
  }

  const eligibility = await resolveLapseVoidEligibility(term, conn);
  if (eligibility.outcome === 'deferred') {
    logger.warn(`[termite-annual-renewal] grace lapse for term ${term.id} deferred — a charge reconciliation is pending on invoice ${term.prepay_invoice_id}: ${eligibility.reason}`);
    await ringRenewalBell(term, 'lapse_reconciliation_pending', eligibility.reason);
    return 'deferred';
  }
  if (eligibility.outcome === 'retired') {
    await conn('annual_prepay_terms').where({ id: term.id })
      .update({ renewal_lapse_completed_at: new Date(), renewal_lapse_outcome: 'retired_settled' });
    await ringRenewalBell(term, 'lapse_retired_settled', eligibility.reason);
    return 'retired';
  }

  if (term.prepay_invoice_id) {
    const InvoiceService = require('./invoice');
    await InvoiceService.voidInvoice(term.prepay_invoice_id);
  }
  const { raiseTermiteRetrievalTask } = require('./cancellation-processor');
  await raiseTermiteRetrievalTask(term.customer_id, null, {
    retrieveAfter: null,
    termId: term.id,
    // No real churn episode backs a non-payment lapse — a stable literal
    // keeps this raise's dedupe key scoped to THIS term (see the function's
    // own termKeyed contract), distinct from any cancellation-request-driven
    // retrieval task for the same customer.
    episodeKey: 'renewal_grace_lapse',
  });
  let parentDecided = true;
  if (term.renewed_from_term_id) {
    try {
      await require('./annual-prepay-renewals').recordDecision({ termId: term.renewed_from_term_id, action: 'cancel', conn });
    } catch (err) {
      logger.warn(`[termite-annual-renewal] parent lapse-stamp skipped for successor ${term.id}: ${err.message}`);
      parentDecided = false;
    }
  }
  if (parentDecided) {
    await conn('annual_prepay_terms').where({ id: term.id }).update({ renewal_lapse_completed_at: new Date(), renewal_lapse_outcome: 'lapsed' });
  }
  return 'lapsed';
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
      .where('t.created_at', '<', staleCutoff)
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
  // (permanent dedupe) as ambiguous. NEVER re-charged automatically.
  try {
    const candidates = await conn('annual_prepay_terms as t')
      .whereNotNull('t.renewed_from_term_id')
      .whereNotNull('t.annual_plan_version')
      .where('t.status', PAYMENT_PENDING_STATUS)
      .whereNotNull('t.renewal_charge_attempted_at')
      .whereNotExists(function noAttemptRow() {
        this.select(1).from('stripe_invoice_charge_attempts as a').whereRaw('a.invoice_id = t.prepay_invoice_id');
      })
      .orderBy('t.renewal_charge_attempted_at', 'asc')
      .select('t.*')
      .limit(limit);
    counts.reconcileNeverReachedStripeScanned = candidates.length;
    for (const successor of candidates) {
      try {
        const result = await ringRenewalBell(
          successor,
          'ambiguous',
          'the renewal charge was claimed but never reached Stripe (a crash between the attempt fence and the Stripe call) — check Stripe and the invoice before collecting any other way',
        );
        if (result && !result.deduped && !result.suppressed) {
          await deliverRenewalInvoice(successor);
          counts.reconcileNeverReachedStripeBelled += 1;
        }
      } catch (err) {
        logger.error(`[termite-annual-renewal] reconcile (never-reached-stripe) failed for successor ${successor.id}: ${err.message}`);
      }
    }
  } catch (err) {
    logger.error(`[termite-annual-renewal] reconcile (never-reached-stripe) scan failed: ${err.message}`);
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
    parentRenewedScanned: 0, parentRenewedStamped: 0,
  };
  if (!termiteAnnualRenewalChargeLive()) return { ...counts, gate: 'off' };
  if (!(await db.schema.hasTable('annual_prepay_terms'))) return { ...counts, gate: 'on', tableMissing: true };

  await bellNoWitnessTerms({ conn, limit, today, counts });
  await bellUnanchoredOriginalTerms({ conn, limit, today, counts });
  await bellStaleOverdueTerms({ conn, limit, today, counts });
  await processRenewalCandidates({ conn, limit, today, counts });
  await processGraceLapses({ conn, limit, counts });
  await reconcileMissedLapseEffects({ conn, limit, counts });
  await reconcileStuckSuccessors({ conn, limit, counts });
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
    processGraceLapseForTerm,
    reconcileMissedLapseEffects,
    bellNoWitnessTerms,
    bellUnanchoredOriginalTerms,
    bellStaleOverdueTerms,
    whereDueForRenewal,
    whereNoticeWitnessed,
    whereAnchoredOrSuccessor,
    whereWithinRenewalWindow,
    addDaysYmd,
    graceDays,
    graceDeadlineFor,
  },
};
