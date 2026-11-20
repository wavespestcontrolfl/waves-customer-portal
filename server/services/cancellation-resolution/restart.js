'use strict';

/**
 * Plan restart (C4, GATE_CANCEL_FLOW_V2) — a CANCELLED customer taps
 * "Restart my plan" and lands on a normal, server-priced estimate for the
 * families they cancelled, which they accept through the existing public
 * estimate path (card-first on every accept, unchanged).
 *
 * Owner rulings honored here:
 *   - Restart ALWAYS reprices at the current price and asks for approval —
 *     nothing here restores an old rate or tier.
 *   - No parallel pricing path: the property context, engine inputs, and
 *     per-service option shapes are the customer-pricing-ai exports the
 *     one-tap and click-to-estimate lanes already reuse; the price is
 *     serverRecomputeFromEstimateData (the SAME server-authoritative
 *     recompute every builder save and click-mint runs); the row is
 *     published with the click-mint's publish-without-delivery pattern
 *     (status 'sent', follow-up flags pre-burned, engagement automation
 *     opted out) so nothing ever messages the customer about it.
 *   - Setup fee / existing-member terms: whatever the existing rule does.
 *     computeMembershipContext returns null for an inactive customer, so a
 *     restart estimate carries new-customer terms — no waiver is invented.
 *   - Customer-initiated only. No win-back send of any kind.
 *
 * Scope = the customer's most recent COMMITTED cancellation_cases row: a
 * non-empty `scope` names the families; `[]` means the whole prior plan,
 * recovered from the recurring rows the cancellation processor pulled, then
 * from the scoped churn note (the only note that names families).
 */

const crypto = require('crypto');
const db = require('../../models/db');
const logger = require('../logger');
const { FAMILY_LABELS } = require('./templates');
const { lockCustomerComms } = require('../../utils/customer-comms-lock');

const SOURCE = 'plan_restart';
const HAND_PRICED_RESTART = 'This restart needs to be set up by hand — please call or text us and we will take care of it.';
const RESTARTABLE_FAMILIES = ['pest_control', 'lawn_care', 'mosquito', 'tree_shrub', 'termite_bait'];
// Plan start (GATE_PORTAL_PLAN_START): the portal pricing card's first-plan estimate for an account with NO live
// recurring service. Same mint core as restart; its own estimates.source lineage.
const PLAN_START_SOURCE = 'plan_start';
// No mosquito: a mosquito-only plan adds the $99 WaveGuard setup fee with no
// fee declared on its line, so the offer check would refuse every mosquito
// start (the card cannot show that fee). Mosquito keeps the request flow.
const PLAN_START_SERVICE_KEYS = ['pest_control', 'lawn_care', 'tree_shrub', 'termite'];
const HAND_PRICED_PLAN_START = 'This plan needs to be priced by hand — please call or text us and we will take care of it.';
// Billing lanes that are a plan (a row in hand resolves through billing-lane's resolveBillingLane).
const PLAN_BILLING_LANES = ['monthly_membership', 'per_application', 'annual_prepay'];
// Every amount the portal card shows for an option (customer-pricing-ai quoteAmountFromLine). The
// plan-start offer check compares each one in cents, and the card's setup fee (`shown.setupFee`,
// the option's setupFee = the line's initialFee) beside them.
const PLAN_START_SHOWN_KEYS = ['monthly', 'perVisit', 'dueAtStart', 'oneTime'];
const toCents = (value) => Math.round(Number(value || 0) * 100);

// An option plan start can book. Pest is quarterly only: the estimate page
// opens a pest estimate on its section default, the first ladder entry
// (quarterly), whatever cadence was priced (EstimateViewPage
// defaultSelectedForServices), so a bi-monthly or monthly start would open on
// another price. The other services open on the priced tier. The mint's
// snapshot check (openingEntryForService) is the belt.
function planStartOptionBookable(serviceKey, option) {
  return PLAN_START_SERVICE_KEYS.includes(serviceKey) && Boolean(option)
    && (serviceKey !== 'pest_control' || option.frequency === 'quarterly');
}

// Why a stored plan-start quote does not sell exactly what the card showed,
// or null when it does (codex pre-push P0s). The mint checks a fresh quote
// before it publishes and a live quote before it hands it back.
//   - The entry the page opens on shows the card's monthly and the
//     per-application price the page's price card leads with.
//   - One-time money is the card's setup, one-time and WaveGuard setup-fee
//     amounts, on the row and in the stored result (the fee is
//     result.oneTime.membershipFee; the core freezes it as
//     setupFeeQuote.amount, the amount the accept bills, and reuses a quote
//     only when its freeze is today's), and itemized on the page (the fee on
//     its own waveguard_setup line).
//   - The page serves this snapshot as is (its own sentSnapshotServesAsIs).
function planStartQuoteMismatch({ bundle, row, data, family, shown, servesAsIs }) {
  if (!bundle) return 'no page snapshot';
  const { openingEntryForService, displayedPerApplication } = require('../estimate-pricing-bundle-utils');
  const entry = openingEntryForService(bundle, family);
  const perApplication = displayedPerApplication(entry);
  if (!perApplication || toCents(entry.monthly) !== toCents(shown.monthly)
    || toCents(perApplication.amount) !== toCents(shown.perVisit)) {
    return `opening entry ${entry?.key || 'none'} shows another price`;
  }
  const setupFee = toCents(shown.setupFee);
  const cardOneTime = toCents(shown.dueAtStart) + toCents(shown.oneTime);
  const stored = data?.result?.oneTime || {};
  const breakdown = bundle.oneTimeBreakdown || {};
  const items = Array.isArray(breakdown.items) ? breakdown.items : [];
  const itemized = (setup) => items
    .filter((item) => (item?.service === 'waveguard_setup') === setup)
    .reduce((sum, item) => sum + toCents(item?.amount), 0);
  // Each one-time amount in cents beside what the card showed.
  const amounts = [
    [toCents(row.onetime_total), cardOneTime + setupFee],
    [toCents(stored.total), cardOneTime + setupFee],
    [toCents(breakdown.total), cardOneTime + setupFee],
    [toCents(stored.membershipFee), setupFee],
    [toCents(bundle.setupFee?.amount), setupFee],
    [itemized(true), setupFee],
    [itemized(false), cardOneTime],
  ];
  if (amounts.some(([amount, card]) => amount !== card) || breakdown.quoteRequired === true
    || items.some((item) => item?.kind !== 'charge' || item?.quoteRequired === true)) {
    return 'one-time charges differ from the card';
  }
  return servesAsIs(bundle, row, data) ? null : 'the page would rebuild the snapshot';
}
// Pricing-ai speaks 'termite' for the termite_bait family (LINE_SERVICE_KEYS).
const pricingKeyFor = (family) => (family === 'termite_bait' ? 'termite' : family);

// The pricing keys whose price reads the turf profile (lawn area and grass track). A plan
// start refuses such a price when that read fails, and the card's hint offers no button for
// it (codex pre-push P0).
const TURF_PRICED_KEYS = ['lawn_care'];

// The seed guards a priced quote must pass (codex pre-push P0; cross-sell's
// own tree guard): an accepted estimate at this street that carried its own
// verification markers, or, for a Tree & Shrub price, a stored zero tree
// count of unknown provenance. The mint refuses such a price, and the card's
// plan-start hint offers no button for it (codex pre-push P1).
function seedRefusesPrice(seed, pricingKeys) {
  return seed?.requiresFieldVerification === true
    || (pricingKeys.includes('tree_shrub') && seed?.zeroTreeCountAmbiguous === true);
}

// A 'sending' claim this fresh is a send in flight, whatever expires_at says
// (codex pre-push P1): a staff resend claimed just before expiry refreshes
// expires_at only after the provider handoff. The claim stamps updated_at.
// Sends finish in seconds; an older claim with a lapsed expiry is a crashed one.
const SEND_CLAIM_LIVE_MS = 15 * 60 * 1000;
function sendInFlight(row, now) {
  const { priorMintStillLive } = require('../service-report/click-estimate-mint');
  if (!['sending', 'scheduled'].includes(row.status)) return false;
  if (priorMintStillLive(row, now)) return true;
  return row.status === 'sending' && now - new Date(row.updated_at || 0) < SEND_CLAIM_LIVE_MS;
}

// Two estimate street keys name the same home: the property-scope standard
// (codex pre-push P1), so a ZIP or city filled in after the mint keeps it.
function sameHome(a, b) {
  return require('../service-report/visit-property-scope').sameResolvedProperty(a, b);
}

class RestartUnavailableError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
    this.restartUnavailable = true;
  }
}

function parseJson(value, fallback) {
  if (value == null) return fallback;
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { return fallback; }
}

// Key-order-independent serialization for the reuse fingerprint (same shape
// as previsit-brief's stableStringify; local because that module drags the
// whole briefing stack in).
function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

// Families the customer cancelled, tied to the LATEST cancellation attempt.
// The processor stamps this attempt's rows before the case row exists, so
// "belongs to the latest attempt" tolerates an hour of skew.
const ATTEMPT_SLACK_MS = 60 * 60 * 1000;
function attemptBoundFor(caseCreatedAt) {
  const t = new Date(caseCreatedAt).getTime();
  return Number.isNaN(t) ? caseCreatedAt : new Date(t - ATTEMPT_SLACK_MS).toISOString();
}

async function cancelledFamiliesFor(customerId, dbh = db) {
  // Newest case regardless of status: when a cancellation partially
  // completes (case left 'open' while the customer is already stamped
  // churned), an OLDER committed case's scope must never answer for it —
  // recovery falls through to the rows of THIS attempt instead.
  const latest = await dbh('cancellation_cases')
    .where({ customer_id: customerId })
    .orderBy('created_at', 'desc')
    .first('id', 'scope', 'status', 'created_at', 'service_request_id');
  // The newest cancellation REQUEST outranks the newest case: the case
  // insert is best-effort (requests.js swallows the failure after the churn
  // already ran), so an older case can sit newest in cancellation_cases
  // while the request that just cancelled the account has no case at all
  // (codex GH r8 P1). A case that is not the latest request's record
  // contributes neither scope nor correlation — the request itself does.
  // Savepoint-isolated (codex GH r25 P2): dbh is usually the mint/accept
  // outer transaction, and a pg statement error here would abort IT — the
  // catch below would swallow the error yet every later query still fails
  // ("current transaction is aborted"), turning the intended case-only
  // fallback into a 500. Same shape as the seed, prepay, and turf reads.
  let latestRequest = null;
  try {
    latestRequest = await dbh.transaction((sp) => sp('service_requests')
      .where({ customer_id: customerId, category: 'cancellation' })
      .orderBy('created_at', 'desc')
      .first('id', 'created_at'));
  } catch { /* unreadable — fall back to case-only correlation */ }
  const current = latest && (!latestRequest
    || String(latest.service_request_id || '') === String(latestRequest.id))
    ? latest : null;
  // The attempt must belong to the CURRENT churn transition (codex GH r22
  // P1): staff can churn an account through the admin customer editor
  // (active=false + pipeline_stage), which creates no request or case — the
  // newest request/case is then a PRIOR cancellation whose families may
  // have nothing to do with what the account held when staff churned it,
  // and both mint and accept would compare against the same stale attempt.
  // The processor and the admin stage route both stamp customers.churned_at
  // on the transition (a pg DATE), so an attempt anchored more than a day
  // before that stamp is stale — FAIL CLOSED (nothing to restart; staff
  // quote the account through normal tooling). The one-day tolerance
  // absorbs a request filed just before a midnight churn stamp. No stamp
  // (legacy) or an unreadable customers row keeps the legacy correlation.
  // Savepoint-isolated (codex GH r26 P2): a pg statement error (a column
  // missing mid-deploy) must not abort the caller's transaction, or the
  // documented legacy fallback 500s on the next evidence query instead.
  const anchorTs = current ? current.created_at : (latestRequest ? latestRequest.created_at : null);
  if (anchorTs) {
    try {
      const row = await dbh.transaction((sp) => sp('customers').where({ id: customerId })
        .first('churned_at', 'pipeline_stage_changed_at', 'churn_reason'));
      const staleAttempt = () => ({ families: [], caseId: current ? current.id : null, requestId: latestRequest ? latestRequest.id : null, source: 'none' });
      const transitionMs = row && row.pipeline_stage_changed_at ? new Date(row.pipeline_stage_changed_at).getTime() : NaN;
      if (!Number.isNaN(transitionMs)) {
        // PRECISE binding (codex GH r23 P1 — the DATE-day tolerance still
        // admitted a same-day admin re-churn): every churn writer stamps
        // pipeline_stage_changed_at with the transition instant (the
        // processor at churn commit; stageLifecycleStamps on the admin
        // stage paths), and it re-stamps only on stage CHANGES, so on a
        // churned row it IS the current transition. The attempt must land
        // within the processor's stamping slack of that instant, or later.
        if (new Date(anchorTs).getTime() < transitionMs - ATTEMPT_SLACK_MS) return staleAttempt();
        // PROVENANCE binding (codex GH r24 P1 — the slack hour still
        // admitted a reactivate + admin re-churn inside it): the transition
        // must be the PROCESSOR'S OWN. The processor is the only writer of
        // the literal CHURN_REASON on customers.churn_reason, and it writes
        // it exactly when IT performs the churn transition (never on an
        // already-churned row); the admin stage paths and the IB bulk move
        // write the admin's text or NULL on a fresh churn, and every
        // reactivation (stageLifecycleStamps, promoteCustomerOnBooking, the
        // bulk mirror) clears it. So a churned row without the literal was
        // churned by staff, not by the latest portal attempt — FAIL CLOSED.
        // Deliberately also closed: a portal request filed against an
        // account staff had ALREADY churned (the processor leaves the
        // admin's reason in place), and a same-stage admin annotation that
        // overwrote the literal — both are staff-quoted through normal
        // tooling.
        const { CHURN_REASON: processorChurnReason } = require('../cancellation-processor');
        if (row.churn_reason !== processorChurnReason) return staleAttempt();
      } else {
        // Legacy rows without the stamp: churned_at (a pg DATE) allows
        // only day-level proximity — one-day tolerance for a request
        // filed just before a midnight churn stamp.
        const { etCalendarDayOf } = require('../../utils/datetime-et');
        const churnDay = row && row.churned_at ? etCalendarDayOf(row.churned_at) : null;
        if (churnDay) {
          const staleBefore = new Date(Date.parse(`${churnDay}T00:00:00Z`) - 24 * 3600 * 1000).toISOString().slice(0, 10);
          if (etCalendarDayOf(anchorTs) < staleBefore) return staleAttempt();
        }
      }
    } catch { /* unreadable — keep the legacy correlation */ }
  }
  const scope = current && current.status === 'committed' ? parseJson(current.scope, []) : [];
  const scoped = (Array.isArray(scope) ? scope : []).filter((f) => RESTARTABLE_FAMILIES.includes(f));
  if (scoped.length) return { families: scoped, caseId: current.id, requestId: latestRequest ? latestRequest.id : null, source: 'case_scope' };
  // This attempt's correlation key and time anchor — the current case's when
  // it exists, else the latest request's own.
  const attemptRequestId = (current && current.service_request_id)
    || (latestRequest && latestRequest.id) || null;
  const attemptAnchor = current ? current.created_at
    : (latestRequest ? latestRequest.created_at : null);

  // Whole account ([]), uncommitted latest case, or no case row: the
  // recurring rows the processor cancelled name the prior plan. Cancelled
  // rows carry no recurring_ongoing signal any more, so read the family off
  // the row/catalog text the same way the facts loader does for live rows.
  // When a case exists, only rows cancelled during THAT attempt count — a
  // historically cancelled family from an earlier cancellation must not
  // sneak into the quote.
  const {
    detectWaveGuardPlanKeys, isCommercialServiceRow, isRodentLedServiceRow, uniqueServiceFamilies,
  } = require('../self-booking-plan-sync');
  const { CHURN_REASON, PORTAL_CANCEL_REASON_PREFIX } = require('../cancellation-processor');
  let rowsQuery = dbh('scheduled_services as s')
    .leftJoin('services as sv', 's.service_id', 'sv.id')
    .where('s.customer_id', customerId)
    .where('s.is_recurring', true)
    .where(function notCallback() { this.whereNull('s.is_callback').orWhere('s.is_callback', false); })
    .orderBy('s.cancelled_at', 'desc')
    // No LIMIT: this is family EVIDENCE run through the JS classifier — a
    // big attempt's newest rows could all belong to one family and starve
    // the rest out of the quote (codex GH r7 P2). Narrowed by recurring +
    // reason + one customer_id.
    .select('s.*', 'sv.service_key', 'sv.name as service_name');
  if (attemptRequestId) {
    // Exact correlation: the processor stamps THIS request's verbatim
    // "Portal cancellation request <id>" reason on every row it pulls AND
    // on every anchor whose recurring_ongoing it clears — so the reason
    // alone ties a row to this attempt. No status filter: when the plan's
    // only footprint was a COMPLETED series anchor, the stop leaves it
    // completed with no cancelled_at, and requiring status/window here
    // erased the whole plan from recovery (codex GH r8 P1). A prefix or
    // time-window match would also accept a prior cancellation inside the
    // slack hour after a reactivation (codex GH r7 P1).
    rowsQuery = rowsQuery.where('s.cancellation_reason', `${PORTAL_CANCEL_REASON_PREFIX} ${attemptRequestId}`);
  } else {
    // Legacy attempts without a request linkage: cancelled rows whose
    // reason is the bare default or the request-scoped prefix (codex GH r5
    // P1: matching only the default made every ordinary whole-account
    // restart find zero rows), bounded to the attempt's hour-slack window
    // (the H0 path stamps rows BEFORE the case row lands).
    rowsQuery = rowsQuery
      .where('s.status', 'cancelled')
      .where(function customerCancelReason() {
        this.where('s.cancellation_reason', CHURN_REASON)
          .orWhere('s.cancellation_reason', 'like', `${PORTAL_CANCEL_REASON_PREFIX}%`);
      });
    if (attemptAnchor) {
      rowsQuery = rowsQuery.where('s.cancelled_at', '>=', attemptBoundFor(attemptAnchor));
    }
  }
  const rows = await rowsQuery;
  const keys = [];
  for (const row of rows) {
    if (isCommercialServiceRow(row) || isRodentLedServiceRow(row)) continue;
    for (const key of detectWaveGuardPlanKeys(row)) if (!keys.includes(key)) keys.push(key);
  }
  // Annual-prepay evidence (codex GH r10 P1): a live prepay term is a plan
  // even with ZERO schedule evidence — the last coverage visit can be
  // completed with recurring_ongoing=false, so neither the sweep nor the
  // recurrence stop leaves a stamped row, and the processor never touches
  // annual_prepay_terms. Anchored to the term that covered the ATTEMPT
  // date — not today — so an old expired term never resurrects a family.
  // A failed read only narrows the evidence (fewer families), never widens
  // it. (Ownership reads the same terms as of TODAY, fail-closed —
  // ownedResidualFamilies — so a still-covered term is owned, not quoted.)
  try {
    const { etDateString } = require('../../utils/datetime-et');
    const attemptDate = etDateString(attemptAnchor ? new Date(attemptAnchor) : new Date());
    // Savepoint-isolated (codex GH r18 P2): dbh is usually the mint's
    // outer transaction, and a pg statement error here (schema skew, a
    // partial deploy) would abort IT — the catch would swallow the error
    // yet every later ownership/pricing query still fails, making Restart
    // unavailable instead of merely narrowing the evidence. A nested
    // transaction scopes the abort to this optional lookup, same shape as
    // the mint's seed lookup.
    const prepayKeys = await dbh.transaction((sp) => prepayTermFamilyKeys(sp, customerId, attemptDate, {
      historical: true,
      // Terminal-transition lower bound: the same attempt anchor (minus
      // the processor's stamping slack) the row correlation uses.
      attemptBound: attemptAnchor ? attemptBoundFor(attemptAnchor) : null,
    }));
    for (const key of prepayKeys) {
      if (!keys.includes(key)) keys.push(key);
    }
  } catch (err) {
    logger.warn(`[plan-restart] prepay family evidence failed for ${customerId}: ${err.message}`);
  }
  const fromRows = uniqueServiceFamilies(keys).filter((f) => RESTARTABLE_FAMILIES.includes(f));
  if (fromRows.length) return { families: fromRows, caseId: current ? current.id : null, requestId: latestRequest ? latestRequest.id : null, source: 'cancelled_rows' };

  // Last resort — LEGACY attempts only: the scoped-cancel audit note
  // ("Cancelled Pest Control, Lawn Care — plan continues with …") names
  // families by label, but it carries no request correlation, so a
  // request-linked attempt whose rows produced nothing must FAIL CLOSED
  // rather than let an earlier scoped cancellation's note inside the slack
  // window supply unrelated families (codex GH r9 P1).
  if (!attemptRequestId) {
    let noteQuery = dbh('customer_interactions')
      .where({ customer_id: customerId, interaction_type: 'note' })
      .where('subject', 'like', 'Cancelled %')
      .orderBy('created_at', 'desc');
    if (attemptAnchor) noteQuery = noteQuery.where('created_at', '>=', attemptBoundFor(attemptAnchor));
    const note = await noteQuery.first('subject');
    if (note && note.subject) {
      const named = String(note.subject).split(' — ')[0].replace(/^Cancelled\s+/, '');
      const fromNote = Object.entries(FAMILY_LABELS)
        .filter(([, label]) => named.includes(label))
        .map(([key]) => key)
        .filter((f) => RESTARTABLE_FAMILIES.includes(f));
      if (fromNote.length) return { families: fromNote, caseId: current ? current.id : null, requestId: latestRequest ? latestRequest.id : null, source: 'churn_note' };
    }
  }
  return { families: [], caseId: current ? current.id : null, requestId: latestRequest ? latestRequest.id : null, source: 'none' };
}

// Families named by the annual-prepay terms covering `dateStr`, family off
// the term's anchor visit, falling back to the plan label (facts.js's own
// derivation). Two modes:
//   - live (default): coveredTermsAsOf's strict paid/refund classifier —
//     residual OWNERSHIP as of today, fail-closed at the callers.
//   - historical: terms that covered the date and were really bought — the
//     cancel-then-refund flow CANCELS the term and refunds its invoice, so
//     the live classifier erases exactly the plan this customer just
//     cancelled (codex GH r11 P1); status/refund churn AFTER the attempt
//     must not erase what they had. Only a NEVER-PAID term is excluded —
//     and "never paid" can't key on t.status alone: invoiceTermStatus maps
//     a VOIDED pending invoice to term 'cancelled' (offboarding voids the
//     unpaid prepay invoice), so a bare whereNot(payment_pending) admits a
//     term nobody ever paid for (codex pre-push r18 P1). Purchase evidence
//     is invoice-side: still-paid, ever-paid (paid_at), a recorded manual
//     payment, or invoice status 'refunded' itself — refunds only exist
//     for collected money (the full-refund webhook nulls paid_at as it
//     flips status, so 'refunded' is the surviving marker for the r11
//     shape); never-paid invoices get VOIDED, not refunded. Legacy terms
//     with no invoice linkage keep their historical semantics, same as
//     coveredTermsAsOf's live and decided arms.
async function prepayTermFamilyKeys(dbh, customerId, dateStr, { historical = false, attemptBound = null } = {}) {
  const {
    detectWaveGuardPlanKeys, isCommercialServiceRow, isRodentLedServiceRow,
  } = require('../self-booking-plan-sync');
  const { coveredTermsAsOf } = require('../annual-prepay-renewals');
  const base = historical
    ? dbh('annual_prepay_terms as t')
      .leftJoin('invoices as i', 'i.id', 't.prepay_invoice_id')
      .where('t.term_start', '<=', dateStr)
      .where('t.term_end', '>=', dateStr)
      .where(function reallyBought() {
        this.where(function liveOrDecided() {
          // Non-pending, non-terminal statuses (active / renewal_pending /
          // renewed / switch_plan) carry no invoice condition — legacy
          // born-active terms may predate invoice linkage entirely.
          this.whereNot('t.status', 'payment_pending')
            .whereNot('t.status', 'cancelled')
            .whereNot('t.status', 'canceled')
            .whereNot('t.status', 'refunded');
        })
          .orWhere(function pendingPaid() {
            this.where('t.status', 'payment_pending')
              .andWhere(function paidEvidence() {
                this.where('i.status', 'paid').orWhereNotNull('i.paid_at').orWhereNotNull('i.payment_recorded_at');
              });
          })
          .orWhere(function terminalBoughtThisAttempt() {
            this.where(function terminalShape() {
              this.whereIn('t.status', ['cancelled', 'canceled', 'refunded']);
            })
              .andWhere(function boughtEvidence() {
                this.where('i.status', 'paid').orWhereNotNull('i.paid_at')
                  .orWhereNotNull('i.payment_recorded_at').orWhere('i.status', 'refunded')
                  .orWhereNull('t.prepay_invoice_id');
              });
            // The terminal transition must belong to THIS attempt (codex
            // GH r19 P1): an earlier cancel-and-refund cycle's term can
            // still have a date range covering today's attempt, and its
            // refunded invoice would otherwise resurrect a family that
            // ended before the current plan existed. updated_at records
            // the terminal flip (the r11 cancel-then-refund shape lands
            // at/after its attempt); NULL-tolerant for legacy rows with
            // no timestamp to compare.
            if (attemptBound) {
              this.andWhere(function transitionedThisAttempt() {
                this.where('t.updated_at', '>=', attemptBound).orWhereNull('t.updated_at');
              });
            }
          });
      })
    : coveredTermsAsOf(dbh, dateStr);
  const terms = await base
    .where('t.customer_id', customerId)
    .select('t.plan_label', 't.last_scheduled_service_id');
  const keys = [];
  for (const term of terms || []) {
    let anchorKeys = [];
    if (term.last_scheduled_service_id) {
      const anchor = await dbh('scheduled_services as s')
        .leftJoin('services as sv', 's.service_id', 'sv.id')
        .where('s.id', term.last_scheduled_service_id)
        .first('s.*', 'sv.service_key', 'sv.name as service_name');
      if (anchor && !isCommercialServiceRow(anchor) && !isRodentLedServiceRow(anchor)) {
        anchorKeys = detectWaveGuardPlanKeys(anchor);
      }
    }
    if (!anchorKeys.length && term.plan_label) anchorKeys = detectWaveGuardPlanKeys({ service_type: term.plan_label });
    for (const key of anchorKeys) if (!keys.includes(key)) keys.push(key);
  }
  return keys;
}

// The LIVE recurring rows on this account, any family — two kinds of
// evidence, matching cancellation-eligibility's own view of a live
// obligation: (a) non-terminal recurring rows, and (b) a series anchor
// re-armed with recurring_ongoing=true (staff can restore a family on a
// completed anchor before its next occurrence exists, and that family is
// owned, not restartable). The pricing-ai ownership loaders deliberately
// answer [] for an inactive customer (loadActiveRecurringServiceRows), so
// the churned lanes read the residual rows directly. Throws when the rows
// cannot be read; every caller FAILS CLOSED on that.
async function liveRecurringRows(dbh, customerId) {
  const { TERMINAL_STATUSES } = require('../waveguard-existing-services');
  // TERMINAL_STATUSES is a COVERAGE view: it lists 'rescheduled' because a
  // phantom reschedule row must not count toward tier/coverage. For
  // OWNERSHIP it's the opposite — 'rescheduled' is an open rebook
  // obligation (cancellation-eligibility's CANCELLABLE_STATUSES includes
  // it; the processor sweeps it regardless of date), so a family whose
  // only live row is awaiting SmartRebooker is still owned, not
  // restartable (codex GH r13 P1). Exclude only never-rewritten history.
  const TERMINAL_HISTORY_STATUSES = TERMINAL_STATUSES.filter((s) => s !== 'rescheduled');
  const residualBase = () => dbh('scheduled_services as s')
    .leftJoin('services as sv', 's.service_id', 'sv.id')
    .where('s.customer_id', customerId)
    .where(function notCallback() { this.whereNull('s.is_callback').orWhere('s.is_callback', false); })
    // No LIMIT: this is ownership EVIDENCE, and an arbitrary truncation
    // could drop an entire residual family (recurring_ongoing rides on
    // every historical row of a series) and let restart re-sell an owned
    // service (codex GH r6 P1). Both reads are already narrowed by their
    // status/flag predicates below and scoped to one customer.
    .select('s.*', 'sv.service_key', 'sv.name as service_name');
  const { etDateString } = require('../../utils/datetime-et');
  const [nonTerminalRows, ongoingAnchorRows] = await Promise.all([
    // Upcoming-or-rescheduled, mirroring the processor's own sweep bound
    // (codex GH r14 P1): the processor deliberately leaves stale PAST
    // pending/confirmed rows untouched (scheduled_date >= today), so a
    // historical stray must not read as residual ownership forever and
    // empty eligibleFamilies. 'rescheduled' phantom rows keep their
    // original — often past — date until SmartRebooker acts, so an open
    // rebook intent counts regardless of date, exactly as the sweep pulls
    // it.
    residualBase().whereNotIn('s.status', TERMINAL_HISTORY_STATUSES).where('s.is_recurring', true)
      .where(function upcomingOrRebook() {
        this.where('s.scheduled_date', '>=', etDateString()).orWhere('s.status', 'rescheduled');
      })
      // The tracker can LEAD the legacy status (track-transitions flips
      // track_state first, the status sync is best-effort) — a row a tech
      // already completed is done work, not an upcoming obligation, and
      // the sweep excludes it for the same reason (codex GH r17 P1).
      // NULL-safe for legacy rows; en_route/on_property stay owned (live
      // work). Same guard as the processor's sweep.
      .where(function notTrackerComplete() {
        this.whereNull('s.track_state').orWhere(function notComplete() { this.whereNot('s.track_state', 'complete'); });
      }),
    residualBase().where('s.recurring_ongoing', true),
  ]);
  return [...nonTerminalRows, ...ongoingAnchorRows];
}

// The families with residual live recurring obligations: liveRecurringRows
// minus commercial and rodent-led rows (not restartable families), plus
// prepay terms still covering today — same family detection as the
// cancelled-family recovery.
async function ownedResidualFamilies(dbh, customerId) {
  const {
    detectWaveGuardPlanKeys, isCommercialServiceRow, isRodentLedServiceRow, uniqueServiceFamilies,
  } = require('../self-booking-plan-sync');
  const { etDateString } = require('../../utils/datetime-et');
  const residualKeys = [];
  for (const row of await liveRecurringRows(dbh, customerId)) {
    if (isCommercialServiceRow(row) || isRodentLedServiceRow(row)) continue;
    for (const key of detectWaveGuardPlanKeys(row)) if (!residualKeys.includes(key)) residualKeys.push(key);
  }
  // (c) A prepay term still covering TODAY is paid, live coverage — owned,
  // never re-sold (codex pre-push P0: a cancelled prepay customer's family
  // was quotable again while their paid term still ran, double-billing the
  // coverage). Deliberately NOT try/caught: ownership fails closed, same
  // as the row reads above.
  for (const key of await prepayTermFamilyKeys(dbh, customerId, etDateString())) {
    if (!residualKeys.includes(key)) residualKeys.push(key);
  }
  return uniqueServiceFamilies(residualKeys);
}

// Plan start's ownership bar (codex pre-push P0): ANY live recurring row owns
// a plan, rodent-led and commercial rows included (the restart residual skips
// both because they are not restartable families), and so does an annual
// prepay term still covering today. Two row reads: the canonical "does this
// customer have a live recurring plan?" set (waveguard-existing-services,
// which keeps a visit still en_route / on_site across ET midnight), and the
// restart read, which adds open rebook rows and re-armed series anchors.
// Throws when a read fails; every caller FAILS CLOSED.
async function ownsAnyRecurringService(dbh, customerId) {
  const { loadLiveRecurringObligationRows } = require('../waveguard-existing-services');
  if ((await loadLiveRecurringObligationRows(dbh, customerId)).length) return true;
  // A one-time booking source is not a plan here either, as in the shared
  // reader (codex pre-push P1), unless staff re-armed its series.
  const { isOneTimeBookingSource } = require('../self-booking-plan-sync');
  const supplemental = await liveRecurringRows(dbh, customerId);
  if (supplemental.some((row) => row.recurring_ongoing === true || !isOneTimeBookingSource(row.source))) return true;
  const { coveredTermsAsOf } = require('../annual-prepay-renewals');
  const { etDateString } = require('../../utils/datetime-et');
  const terms = await coveredTermsAsOf(dbh, etDateString()).where('t.customer_id', customerId).select('t.id');
  return terms.length > 0;
}

// A plan start is for an account with no plan (codex pre-push P0): active
// (exactly true: customer auth reads a NULL flag as inactive), not cancelled,
// and no plan membership on the row: a real WaveGuard tier, a plan billing
// lane, or a legacy monthly rate. The card hint, the mint and the accept
// re-check all read this one predicate.
function planStartAccountOpen(row) {
  if (!row || row.active !== true || row.pipeline_stage === 'churned') return false;
  const { isMembershipTier, resolveBillingLane } = require('../billing-lane');
  if (isMembershipTier(row.waveguard_tier)) return false;
  return !PLAN_BILLING_LANES.includes(resolveBillingLane(row).mode) && !(Number(row.monthly_rate || 0) > 0);
}

// A prior restart estimate the customer can still open (same liveness the
// click-mint applies to its own lineage).
function liveRestartEstimate(rows, now) {
  return (rows || []).find((row) => {
    if (!row || row.archived_at || row.status === 'accepted') return false;
    if (!['sent', 'viewed'].includes(String(row.status || ''))) return false;
    const expiresAt = row.expires_at ? new Date(row.expires_at) : null;
    return !(expiresAt && !Number.isNaN(expiresAt.getTime()) && expiresAt <= now);
  });
}

// Commercial properties never get an online price (codex pre-push P0 — same
// doctrine as BOTH offer surfaces, cross-sell report + portal offer: the engine
// refuses real prices there and commercial expansion is a proposal
// conversation; variantsForService only knows residential defaults). The
// entries check the STORED type under their lock, BEFORE any reuse or mint,
// and the shared core re-checks the RESOLVED type after the property context
// is built — a cached lookup classifying the property commercial must refuse
// too. FAIL CLOSED: a check that cannot be evaluated refuses.
function makeCommercialGuard(fresh, deps, { logTag, handMessage }) {
  const isCommercial = deps.isCommercialProperty
    || require('../pricing-engine/commercial-helpers').isCommercialProperty;
  return (property, label) => {
    let commercial = true;
    try {
      commercial = isCommercial(property);
    } catch (err) {
      logger.warn(`[${logTag}] commercial check (${label}) failed for ${fresh.id} — refusing: ${err.message}`);
      throw new RestartUnavailableError('pricing_unavailable', handMessage);
    }
    if (commercial) throw new RestartUnavailableError('pricing_unavailable', handMessage);
  };
}

// The collaborators every mint resolves BEFORE it opens its transaction.
function resolveMintDeps(deps) {
  return {
    persistence: deps.persistence || require('../admin-estimate-persistence'),
    pricingAi: deps.pricingAi || require('../customer-pricing-ai'),
    pricingBundleMatchesEstimateTotals: (deps.bundleUtils || require('../estimate-pricing-bundle-utils')).pricingBundleMatchesEstimateTotals,
    // Route adapter, lazy for the same service→route load-order reason the
    // click-mint cites.
    buildEstimateSendSnapshot: deps.buildEstimateSendSnapshot
      || require('../../routes/admin-estimates').buildEstimateSendSnapshot,
    // The public page's own snapshot predicate (plan start only), loaded on
    // first call so a restart mint never pulls in the page route.
    sentSnapshotServesAsIs: deps.sentSnapshotServesAsIs
      || ((...args) => require('../../routes/estimate-public').sentSnapshotServesAsIs(...args)),
    // The scheduler's hold release, for the quotes a replacement archives.
    releaseEstimateHolds: deps.releaseEstimateHolds
      || ((args) => require('../slot-reservation').releaseEstimateHolds(args)),
  };
}

// True when another non-deleted profile (customers row) shares this
// customer's account. The key is account_id, or the row's own id for a row
// never attached to an account, matched as accountPropertyIds matches it
// (account_id = key OR id = key). The key is re-read from the row, so a
// caller holding a narrow select cannot skip the check. A failed read throws;
// every strict caller fails closed.
async function accountHasOtherProfile(dbh, customer) {
  const own = await dbh('customers').where({ id: customer.id }).first('account_id');
  const accountKey = own?.account_id || customer.id;
  const other = await dbh('customers')
    .whereNull('deleted_at')
    .whereNot('id', customer.id)
    .where(function sameAccount() { this.where('account_id', accountKey).orWhere('id', accountKey); })
    .first('id');
  return Boolean(other);
}

// The account's primary street when it provably has one premises, else null
// (codex GH r4 P1): the mint prices and addresses its estimate at that
// street, so a multi-premises profile, a missing primary street or a street
// without provable locality is priced by hand. Same proof as the portal
// offer (customerHasOnlyPrimaryPremises, cross-sell); an unreadable proof
// throws and each caller refuses. The plan-start hint runs it too, so a
// multi-home account keeps the request (codex pre-push P1). strict (plan
// start's hint, mint and accept; codex pre-push P1): a visit whose property
// row or creating estimate cannot be resolved fails the proof
// (unresolvedFails, as the other fail-closed callers pass it), because it may
// be a second premises. Strict also fails an account with another profile
// (codex pre-push r16 P0): the portal keeps each property of a multi-property
// account as its own customers row under one account (docs/
// multi-property-model.md), and the proof above reads this row only, so a
// plan-free profile beside a member profile would sell a first plan. Any
// other non-deleted profile counts, active or not, as the proof counts every
// property row. Plan restart keeps the portal offer's default, as on main.
async function singlePremisesStreet(dbh, customer, { proof, strict = false } = {}) {
  const linkage = require('../estimate-property-linkage');
  const street = linkage.normalizedStampedStreet(customer.address_line1, customer.address_line2, customer.city, customer.zip);
  if (!street || linkage.scopeKeyLacksLocality(street)) return null;
  // Through the exports, so a suite can stand in for the account read.
  if (strict && await module.exports.accountHasOtherProfile(dbh, customer)) return null;
  const premisesProof = proof || require('../service-report/cross-sell').customerHasOnlyPrimaryPremises;
  return (await premisesProof(dbh, customer.id, customer, street, { unresolvedFails: strict })) ? street : null;
}

// True when an engine result must be priced by hand, never shown as an
// online price: a line the CANONICAL review predicates flag (draft-builder,
// the trio proposal generation gates on, codex GH r12 P1: a hand-rolled
// subset missed heuristic turf BASES, such as plausibleMaxTurfCap at MEDIUM
// confidence, and the other markers lineRequiresReview covers:
// requiresMeasurement, manualReviewReasons, the zero-tree underquote, ...),
// a line graded low confidence, a footprint the engine guessed, or a result
// asking for field verification. The mint refuses on it, and the plan-start
// hint runs it on its own engine result, so the card never offers what the
// mint refuses (codex pre-push P1).
//
// A guessed footprint is AGENTS.md's "fpSource fallback" marker: the pricers
// write it as footprintWasDefaulted and a *fallback footprintSource. They set
// requiresManualReview with it today; the check reads the marker itself, so a
// line that carries only the marker still routes to review (codex pre-push
// r30 P1).
function engineResultNeedsReview(raw) {
  const { lineRequiresReview, lineHasHeuristicTurf } = require('../estimator-engine/draft-builder');
  return (raw?.lineItems || []).some((l) => l && (
    lineRequiresReview(l)
    || lineHasHeuristicTurf(l)
    || String(l.pricingConfidence || '').toLowerCase() === 'low'
    || l.footprintWasDefaulted === true
    || [l.footprintSource, l.fpSource].some((source) => /fallback/i.test(String(source || '')))
  )) || (Array.isArray(raw?.fieldVerify) && raw.fieldVerify.length > 0);
}

// The WaveGuard setup fee a quote discloses, frozen where every charging path
// reads it (estimate_data.setupFeeQuote, the website quote's shape; codex
// pre-push P0s). Without a freeze the public accept bills
// EstimateConverter.frozenSetupFeeAmount's code constant and the page falls
// back to a positive fee, so a fee live config prices otherwise, zero
// included, would show or bill another amount. Frozen only where the fee
// applies (the converter's solo pest or mosquito mix, the rule the engine's
// mapper prices the fee by and the mixes the website quote freezes,
// setupFeeQuoteBasisForEstimate), at the stored result's amount. A zero
// freeze is the "no fee" the page and the accept both read.
function disclosedSetupFeeQuote(estimateData) {
  const fee = estimateData.result?.oneTime?.membershipFee;
  if (fee == null || !(Number(fee) >= 0)) return null;
  const converter = require('../estimate-converter');
  if (!converter.recurringMixHasMembershipFeeService(converter.recurringServicesFromEstimateData(estimateData))) return null;
  return { amount: toCents(fee) / 100, kind: 'waveguard_membership' };
}

const HAND_CHECK_MESSAGE = 'This one needs a quick hand-check before we can price it online.';

// THE shared mint core (plan restart + plan start — one mechanism, two
// entries). Runs inside the caller's transaction, under the locks the entry
// already took (comms advisory lock, then the customers row FOR UPDATE), with
// the entry's own eligibility checks already passed:
//   trx               the caller's transaction
//   fresh             the locked customers row
//   source            estimates.source ('plan_restart' | 'plan_start'); also
//                     the lineage this mint reuses or archives
//   families          the families this mint quotes (already minus owned ones)
//   ownedFamilies     the account's residual-owned families (combined-tier
//                     qualifiers; fed to the recompute)
//   optionFor         (pricingKey, pricingAi) => the option to price per family
//   estimateBlock     { key, value } stored beside the engine inputs in
//                     estimate_data (planRestart / planStart)
//   matchesLive       (liveEstimateData) => the entry's own scope/identity
//                     test for reusing a live quote (the core adds the
//                     cent-exact totals + full-offer fingerprint checks)
//   strictEvidence    the entry's evidence policy, read once into `strict`.
//                     True (plan start): the estimate block also stores the
//                     proven premises key (premisesKey), which reuse and the
//                     accept compare; evidence the price depends on must
//                     be readable, else pricing_unavailable: the single-premises
//                     proof fails on an unresolvable visit link
//                     (singlePremisesStreet strict) and an unreadable estimate
//                     seed or turf profile refuses. Omitted (plan restart):
//                     main's lenient proof and best-effort seed and profile.
//   assertOffer       optional ({ monthlyTotal, annualTotal, onetimeTotal,
//                     rawEngineResult }) => throws when the server's price is
//                     not the offer the entry expects
//   snapshotSells     optional (pricingBundle, row, estimateData) => true when
//                     the frozen page bundle sells exactly this offer. A fresh
//                     mint that fails it refuses (priced by hand); a live
//                     quote that fails it is re-minted, never handed back.
//                     Default: the bundle carries the row's totals
//                     (pricingBundleMatchesEstimateTotals); a fresh mint that
//                     fails the default is a publication failure
//   note              (estimateId) => { subject, body } for the timeline
//   logTag / logDetail / handMessage   wording that stays per-source
// Returns { estimateId, token, url, reused }.
async function mintPricedEstimate(args) {
  const {
    trx, fresh, source, families, strictEvidence, assertOffer, snapshotSells, handMessage, logTag, nowDate, deps, mintDeps,
  } = args;
  // The evidence policy, selected once by the entry (plan start strict, plan
  // restart best-effort): readEvidence and the premises proof read `strict`,
  // and `premisesStamp` is the one place the proven home is stored and compared.
  const strict = strictEvidence === true;
  const mint = {
    ...args,
    strict,
    toPrice: families.map(pricingKeyFor),
    sells: snapshotSells
      || ((bundle, row) => Boolean(bundle) && mintDeps.pricingBundleMatchesEstimateTotals(bundle, row)),
  };

  // Single-premises proof BEFORE any URL is handed out (codex GH r4 P1):
  // the cancelled-family and residual queries above are scoped by
  // customer_id alone, but the estimate is priced and addressed at the
  // single primary street — a family cancelled at a SECONDARY premises
  // would otherwise be quoted at the primary property's measurements.
  // Same proof the portal offer runs (customerHasOnlyPrimaryPremises,
  // cross-sell): a multi-premises profile — or a proof that cannot be
  // evaluated, a missing primary street, or a street without provable
  // locality — is the priced-by-hand 409, never an online price.
  let primaryStreet = null;
  try {
    primaryStreet = await singlePremisesStreet(trx, fresh, { proof: deps.customerHasOnlyPrimaryPremises, strict });
  } catch (err) {
    logger.warn(`[${logTag}] single-premises proof failed for ${fresh.id} — refusing: ${err.message}`);
  }
  if (!primaryStreet) {
    throw new RestartUnavailableError('pricing_unavailable', handMessage);
  }
  // Plan start also stores the home its price was proven for (codex pre-push P0): a staff address
  // change rewrites an open quote's address column (customer-address-fanout.js), so the accept and
  // a reuse compare the account's home with this key as well as with that column.
  const premisesStamp = strict ? { premisesKey: primaryStreet } : {};

  // Any prior lineage rows — the reuse decision itself is deferred until
  // TODAY's inputs have been resolved and priced (below): reusing here
  // would hand back a quote the current property context no longer
  // supports (codex pre-push P0 — a corrected measurement, a cache/
  // override update, or a commercial reclassification since mint).
  const priorRows = await trx('estimates')
    .where({ customer_id: fresh.id, source })
    .whereNull('archived_at')
    .orderBy('created_at', 'desc')
    .limit(10);

  const { propertyContext, propertySeed } = await resolvePropertyEvidence(mint, primaryStreet);
  const estimateData = buildEstimateData(mint, propertyContext, premisesStamp);
  const offer = await recomputeOffer(mint, estimateData, propertySeed);
  // Source-specific offer check on the SERVER's own totals and engine result
  // (plan_start: every price the customer was shown must still be today's).
  if (assertOffer) assertOffer({ ...offer.totals, rawEngineResult: offer.raw });

  const reused = await reuseLiveQuote(mint, { priorRows, offer, estimateData, primaryStreet, premisesStamp });
  if (reused) return reused;

  await retireLineage({ trx, fresh, source, nowDate, releaseEstimateHolds: mintDeps.releaseEstimateHolds });
  return publishMintedEstimate(mint, { offer, estimateData });
}

// Evidence the price depends on is read once, under the entry's policy
// (codex pre-push P0): strict (plan start) fails closed on an unreadable read,
// because the guards below cannot run without it and cached facts alone could
// still reproduce the card's price; best-effort (plan restart) logs it and
// prices on what remains. A read that finds nothing is not a failure.
async function readEvidence({ logTag, fresh, handMessage }, { what, strict, read }) {
  try {
    return await read();
  } catch (err) {
    if (!strict) {
      logger.warn(`[${logTag}] ${what} skipped for ${fresh.id}: ${err.message}`);
      return null;
    }
    logger.warn(`[${logTag}] ${what} unreadable for ${fresh.id} — refusing: ${err.message}`);
    throw new RestartUnavailableError('pricing_unavailable', handMessage);
  }
}

// Property context: profile first, then the SAME cache-only lookup +
// accepted-estimate seed discipline the portal offer surfaces price
// under (cross-sell/one-tap). No LIVE lookup spend from a restart tap —
// a cached lookup row or a prior accepted estimate for THIS street
// supplies the footprint the stored profile lacks. Refuses the mint
// (pricing_unavailable) on a commercial or unmeasured property and on a
// verified correction the price did not apply.
async function resolvePropertyEvidence(mint, primaryStreet) {
  const {
    trx, fresh, toPrice, strict, logTag, deps, assertNotCommercial, mintDeps: { pricingAi },
  } = mint;
  const crossSell = deps.crossSell || require('../service-report/cross-sell');
  // Savepoint (codex GH r10 P2): the seed is best-effort, but a
  // statement error raised on the OUTER trx aborts the whole mint
  // ("current transaction is aborted" on the very next query) — the
  // nested transaction scopes the rollback to the lookup so the mint
  // continues on profile/cache evidence as intended.
  const propertySeed = await readEvidence(mint, {
    what: 'estimate property seed',
    strict,
    read: () => trx.transaction((sp) => crossSell.loadEstimateSeed(sp, fresh.id, primaryStreet)),
  });
  // Savepoint-isolated like the seed and prepay lookups (codex GH r23
  // P2): loadTurfProfile's own safeSelect catch returns null on a pg
  // statement error, but the OUTER trx would already be aborted — the
  // mint could not continue on the property/cache/seed fallbacks it
  // documents and would 500 on the next transactional query. A null
  // profile from a rolled-back savepoint degrades exactly as intended.
  // A plan start reads the profile strictly for a price that reads it (codex pre-push P0): a
  // failed read would price on older fallback measurements that a stored zero-lawn profile
  // rules out. A missing row is not a failure. Restart keeps main's forgiving read.
  const turfStrict = strict && toPrice.some((key) => TURF_PRICED_KEYS.includes(key));
  const turfProfile = await readEvidence(mint, {
    what: 'turf profile',
    strict: turfStrict,
    read: () => trx.transaction((sp) => pricingAi.loadTurfProfile(sp, fresh.id, { strict: turfStrict })),
  });
  // Verified-correction probe discipline (codex GH r4 P1), mirrored from
  // BOTH offer paths (cross-sell report + portal offer): only a USABLE
  // lookup result carries staff's verified overrides folded in, so record
  // whether one came back. When none does — a miss, a payload the resolver
  // rejects (global verify flag), or no lookup at all — the price falls
  // back to stored fields + the accepted-estimate seed, both OLDER than a
  // technician's verified correction. Probed below, after the resolve.
  const providedLookup = 'propertyLookup' in deps ? deps.propertyLookup : crossSell.cacheOnlyPropertyLookup;
  const { hasGlobalVerifyFlag } = require('../lookup-confidence');
  let lookupProducedResult = false;
  const trackedLookup = typeof providedLookup === 'function'
    ? async (address) => {
      const found = await providedLookup(address);
      if (found && !hasGlobalVerifyFlag(found.enriched || {})) lookupProducedResult = true;
      return found;
    }
    : providedLookup;
  const propertyContext = await pricingAi.resolvePropertyContext({
    customer: fresh,
    turfProfile,
    propertyLookup: trackedLookup,
    propertySeed,
  });
  // Commercial re-check on the RESOLVED type (codex pre-push P0, same as
  // the offer paths' post-resolve re-check): the stored column can be
  // blank/stale while the cached lookup or the accepted-estimate seed
  // classified the property commercial — that resolution must refuse,
  // not price through residential defaults.
  assertNotCommercial({ propertyType: propertyContext?.propertyInput?.propertyType }, 'resolved');
  if (pricingAi.missingPropertyFor(toPrice, propertyContext)) {
    throw new RestartUnavailableError('pricing_unavailable', 'We need a property measurement on file before we can price this online.');
  }
  // No lookup result means any verified correction on this address was NOT
  // applied to the price. FAIL CLOSED, same as the offer paths' demote: an
  // unreadable probe is not evidence that no corrections exist, and a
  // correction on file makes this the priced-by-hand 409 instead of an
  // exact price on a fact staff already fixed.
  if (!lookupProducedResult) {
    let correctionsUnapplied;
    try {
      const probe = deps.hasVerifiedOverrides
        || require('../property-lookup/lookup-cache').hasVerifiedOverrides;
      correctionsUnapplied = await probe(pricingAi.addressForCustomer(fresh));
    } catch (err) {
      correctionsUnapplied = true;
      logger.warn(`[${logTag}] verified-override probe failed for ${fresh.id} — refusing: ${err.message}`);
    }
    if (correctionsUnapplied) {
      throw new RestartUnavailableError('pricing_unavailable', HAND_CHECK_MESSAGE);
    }
  }
  return { propertyContext, propertySeed };
}

// The estimate_data the server prices: the engine inputs for every family this
// mint quotes, the entry's own block (with the proven home when strict), and
// the residual qualifiers.
function buildEstimateData(mint, propertyContext, premisesStamp) {
  const {
    toPrice, ownedFamilies, optionFor, estimateBlock, mintDeps: { pricingAi },
  } = mint;
  const context = { grassType: propertyContext.grassType, palmCount: propertyContext.palmCount };
  const services = Object.assign({}, ...toPrice.flatMap((key) => {
    const option = optionFor(key, pricingAi);
    return option ? [pricingAi.optionServices(option, context)] : [];
  }));
  if (!Object.keys(services).length) {
    throw new RestartUnavailableError('pricing_unavailable', 'We could not price this plan online.');
  }
  const estimateData = {
    engineInputs: { ...propertyContext.propertyInput, services },
    // No follow-up / engagement automation may ever message the customer
    // about an estimate they asked for and are looking at (click-mint
    // doctrine; enforced centrally in estimate-engagement-engine).
    noEngagementAutomation: true,
    [estimateBlock.key]: { ...estimateBlock.value, ...premisesStamp },
  };
  // Persist the qualifiers WITH the inputs (click-mint pattern, codex GH
  // r8 P1): buildEstimateSendSnapshot replays engineInputs through
  // extractEngineInputs, which restores combined-tier context only from
  // estimate_data.priorQualifyingServices — omitting them recomputes the
  // partial-residual case standalone and fails the totals-match check.
  if (ownedFamilies.length) estimateData.priorQualifyingServices = [...ownedFamilies];
  return estimateData;
}

// The server-authoritative price for estimateData, written back onto it (result,
// setup fee, pest version). priorQualifyingServices come from the SERVER-derived
// residual set — normally empty for a cancelled customer, so the engine prices at
// today's list; a family they somehow still hold prices the restart at
// the combined tier instead of standalone. Already family-canonical.
async function recomputeOffer(mint, estimateData, propertySeed) {
  const {
    toPrice, ownedFamilies, logTag, mintDeps: { persistence },
  } = mint;
  const priorQualifyingServices = [...ownedFamilies];
  const recomputed = await persistence.serverRecomputeFromEstimateData(estimateData, {
    priorQualifyingServices,
    recurringCustomer: priorQualifyingServices.length > 0,
  });
  if (!recomputed?.recomputed) {
    throw new Error(`${logTag} recompute failed (${recomputed?.reason || 'unknown'})`);
  }

  // FAIL CLOSED on review markers, the same demotion the offer path's
  // optionIsPriceable applies: an engine result flagged for on-site
  // verification, manual review, or low confidence — or a seed whose
  // source estimate carried its own verification markers, or (for a Tree &
  // Shrub price) a stored zero tree count of unknown provenance, cross-sell's
  // own tree guard (codex pre-push P0) — never becomes a customer-visible
  // price. The customer gets the priced-by-hand 409.
  const raw = recomputed.rawEngineResult || {};
  if (engineResultNeedsReview(raw) || seedRefusesPrice(propertySeed, toPrice)) {
    throw new RestartUnavailableError('pricing_unavailable', HAND_CHECK_MESSAGE);
  }

  estimateData.result = recomputed.serverResult;
  const setupFeeQuote = disclosedSetupFeeQuote(estimateData);
  if (setupFeeQuote) estimateData.setupFeeQuote = setupFeeQuote;
  const pest = estimateData.engineInputs.services.pest;
  if (recomputed.pestPricingVersion && pest && typeof pest === 'object') pest.version = recomputed.pestPricingVersion;

  const amount = (value) => Number(value || 0);
  const totals = recomputed.serverTotals || {};
  const monthlyTotal = amount(totals.monthlyTotal);
  return {
    raw,
    totals: {
      monthlyTotal,
      annualTotal: amount(totals.annualTotal) || monthlyTotal * 12,
      onetimeTotal: amount(totals.onetimeTotal),
    },
    serverTier: raw.waveGuard?.tier || raw.waveGuard?.label || null,
  };
}

// Reuse decision — only NOW, with today's property context resolved,
// the commercial / verified-override / review-marker gates passed, and
// TODAY's recompute in hand (codex pre-push P0): a live quote is handed
// back only when it names exactly today's eligible families AND today's
// totals land on its frozen dollars. Anything else — price-config
// drift, corrected measurements, a changed scope — retires the lineage
// and mints fresh (owner ruling: restart ALWAYS reprices at the
// current price; idempotent button, one honorable price at a time).
// The checks read the lineage again, under its row locks (codex pre-push
// P1): the read above took no lock, and a tier the customer picks in
// another tab while today's price is computed can drop the frozen
// snapshot they check. Locked, the rows hold still until this transaction
// commits, so the checks read the row the link opens.
// Returns the live quote's { estimateId, token, url, reused: true }, or null.
async function reuseLiveQuote(mint, {
  priorRows, offer, estimateData, primaryStreet, premisesStamp,
}) {
  const {
    trx, matchesLive, estimateBlock, sells, now,
  } = mint;
  const lockedPriorRows = await trx('estimates')
    .whereIn('id', priorRows.map((row) => row.id))
    .orderBy('created_at', 'desc')
    .forUpdate();
  // Liveness on the clock after the locks (codex pre-push P1): nowDate was read before this
  // transaction waited on its locks and repriced, so a quote that expired meanwhile would be
  // handed back as live.
  const live = liveRestartEstimate(lockedPriorRows, now());
  if (!live) return null;
  const liveData = parseJson(live.estimate_data, {}) || {};
  // Same premises (codex pre-push P1): the offer fingerprint carries the
  // property facts, not the street, so a quote minted before the account's
  // address changed would hand back a link addressed to the old house. Its
  // stored address must key to today's primary premises; else the lineage
  // archives and a fresh quote is minted at the current address.
  const sameStamp = Object.entries(premisesStamp)
    .every(([key, home]) => sameHome(liveData[estimateBlock.key]?.[key], home));
  const { monthlyTotal, annualTotal, onetimeTotal } = offer.totals;
  const sameTotals = [['monthly_total', monthlyTotal], ['annual_total', annualTotal], ['onetime_total', onetimeTotal]]
    .every(([column, total]) => toCents(total) === toCents(live[column]));
  if (matchesLive(liveData)
    && sameHome(require('../estimate-property-linkage').normalizedEstimateStreet(live.address), primaryStreet)
    && sameStamp
    && sameTotals
    && offerFingerprint(liveData) === offerFingerprint(estimateData)
    // The page still sells its frozen snapshot (codex pre-push P0): the
    // fingerprint omits sendSnapshot, and the page's tier selection can
    // clear the bundle while inputs, result and totals stay the same. Such
    // a quote would reprice on live rules, so it is re-minted instead.
    && sells(liveData.sendSnapshot?.pricingBundle, live, liveData)) {
    return { estimateId: live.id, token: live.token, url: `/estimate/${live.token}`, reused: true };
  }
  return null;
}

// Full-offer fingerprint, not just the three aggregates (codex GH r9
// P1): offsetting price changes across families can keep the totals
// identical while per-service application prices or the default
// option drifted — and acceptance converts the STORED estimate_data,
// so reuse requires the stored offer to EQUAL today's recompute:
// engine inputs, qualifiers, and the full server result.
// The frozen setup fee is part of the offer (codex pre-push P0): a quote
// minted before the freeze carries none, so its accept would bill the
// code constant instead of the fee its page shows.
// Both sides in their stored JSON form (codex pre-push P1): the live row
// went through JSON.stringify, which drops a key whose value is undefined
// (the property resolver leaves bedArea or palmCount unset), so today's
// offer drops it too. Else an identical second tap re-mints and releases
// the first quote's slot hold.
function offerFingerprint(data) {
  return stableStringify(JSON.parse(JSON.stringify({
    engineInputs: data.engineInputs ?? null,
    priorQualifyingServices: Array.isArray(data.priorQualifyingServices) ? [...data.priorQualifyingServices].sort() : [],
    result: data.result ?? null,
    setupFeeQuote: data.setupFeeQuote ?? null,
  })));
}

// Retire the replaced lineage. The WHOLE unaccepted lineage, read FOR UPDATE (codex pre-push r16 P1):
// the delivery check and the archive below act on exactly these rows. An
// operator send claims a row with one UPDATE that refuses an archived row,
// so a claim either committed before this read (its status refuses the
// mint here) or waits on the lock and then finds the row archived.
// Query-shaped (not the limit-10 reuse read) so no straggler survives.
async function retireLineage({
  trx, fresh, source, nowDate, releaseEstimateHolds,
}) {
  const lineage = await trx('estimates')
    .where({ customer_id: fresh.id, source })
    .whereNull('archived_at')
    .whereNot('status', 'accepted')
    .forUpdate()
    .select('id', 'status', 'archived_at', 'expires_at', 'updated_at');
  // Mid-delivery lineage refuses the mint FIRST (codex GH r19 P0 — the
  // same guard click-estimate-mint applies): an operator send claims the
  // row 'sending' and its finalization does not reject an archived row,
  // so archiving here would let the provider deliver a token we just
  // killed; a 'scheduled' send would be silently retired before its
  // worker runs. A crashed 'sending' claim (expiry window lapsed, and the
  // claim itself no longer fresh) is dead and archives normally
  // (sendInFlight). Sends finish in seconds; the customer's next tap
  // proceeds.
  if (lineage.some((row) => sendInFlight(row, nowDate))) {
    throw new RestartUnavailableError('delivery_in_flight', 'This quote is on its way to you right now — give it a moment, then try again.');
  }
  // Minting a replacement: archive that lineage first — an EXPIRED restart
  // quote left unarchived stays revivable for seven days through
  // /extension-request (restart mints stamp sent_at), which would put an
  // older price or cancellation scope back in the wild beside the new quote
  // (codex GH r6 P1); accepted rows are history and stay. Each archived
  // quote's uncommitted slot holds go in this same transaction (codex
  // pre-push, GATE_PORTAL_PLAN_START r15): an archived quote can no longer be
  // booked, so its hold kept a real appointment slot from other customers
  // until it expired. The scheduler's own predicate picks the holds; a
  // committed visit is never touched.
  const archivedIds = lineage.map((row) => row.id);
  await trx('estimates').whereIn('id', archivedIds).update({ archived_at: nowDate, updated_at: nowDate });
  for (const id of archivedIds) {
    await releaseEstimateHolds({ estimateId: id, database: trx });
  }
}

// Publish the priced quote: insert the row, freeze its send snapshot, write the
// timeline note. Returns { estimateId, token, url, reused: false }.
async function publishMintedEstimate(mint, { offer, estimateData }) {
  const {
    trx, fresh, source, families, snapshotSells, sells, note, logTag, logDetail, handMessage,
    nowDate, now, randomBytes, mintDeps: { persistence, pricingAi, buildEstimateSendSnapshot },
  } = mint;
  const { monthlyTotal, annualTotal, onetimeTotal } = offer.totals;
  const orNull = (value) => value || null;
  const token = randomBytes(16).toString('hex');
  const [created] = await trx('estimates').insert({
    estimate_data: JSON.stringify(estimateData),
    address: orNull(pricingAi.addressForCustomer(fresh)),
    customer_id: fresh.id,
    customer_name: orNull([fresh.first_name, fresh.last_name].filter(Boolean).join(' ').trim()),
    customer_phone: orNull(fresh.phone),
    customer_email: orNull(fresh.email),
    monthly_total: monthlyTotal,
    annual_total: annualTotal,
    onetime_total: onetimeTotal,
    waveguard_tier: offer.serverTier,
    token,
    expires_at: persistence.estimateExpiresAt(now),
    notes: null,
    // Publish without delivery (click-mint pattern): viewable + acceptable
    // now, every follow-up flag pre-burned.
    status: 'sent',
    sent_at: nowDate,
    followup_unviewed_sent: true,
    followup_viewed_sent: true,
    followup_final_sent: true,
    followup_expiring_sent: true,
    source,
    service_interest: families.map((f) => FAMILY_LABELS[f] || f).join(' + '),
    category: fresh.property_type === 'commercial' ? 'COMMERCIAL' : 'RESIDENTIAL',
    pricing_authority: 'SERVER',
    server_computed_price: annualTotal > 0 ? annualTotal : null,
    ...(typeof estimateData.result?.engineVersion === 'string'
      ? { pricing_version: estimateData.result.engineVersion.slice(0, 80) }
      : {}),
  }).returning('*');

  // Freeze the send snapshot so the public page replays the shown price
  // instead of live config — a snapshot that failed to freeze is a
  // publication failure (sibling-publication rule), never a warning. No
  // delivery stamp (codex pre-push P1; website-quote-publication's
  // posture): nothing was delivered, and the stamp is what a real handoff
  // delivered (the triage sweep's quote_promised witness, the
  // updated-wording check).
  const withSnapshot = await buildEstimateSendSnapshot(created, now, { delivered: false });
  const snapshot = withSnapshot?.sendSnapshot;
  if (!snapshot || snapshot.pricingBundleError) {
    throw new Error(`${logTag} send snapshot did not freeze pricing${snapshot?.pricingBundleError ? `: ${snapshot.pricingBundleError}` : ''}`);
  }
  if (!sells(snapshot.pricingBundle, created, withSnapshot)) {
    if (!snapshotSells) throw new Error(`${logTag} send snapshot does not match the minted totals`);
    throw new RestartUnavailableError('pricing_unavailable', handMessage);
  }
  await trx('estimates').where({ id: created.id }).update({
    estimate_data: JSON.stringify(withSnapshot),
    updated_at: nowDate,
  });

  // Audit trail on the customer's timeline — no bell, no customer send.
  // NOT swallowed: a failed statement aborts the whole Postgres
  // transaction, so "tolerating" it would turn the COMMIT into a silent
  // ROLLBACK while we still hand back a URL for an estimate that no
  // longer exists. The mint fails atomically instead.
  await trx('customer_interactions').insert({
    customer_id: fresh.id,
    interaction_type: 'note',
    ...note(created.id),
  });

  logger.info(`[${logTag}] minted estimate ${created.id} for customer ${fresh.id} (${families.join(',')} ${logDetail})`);
  return { estimateId: created.id, token, url: `/estimate/${token}`, reused: false };
}

async function mintRestartEstimate({ customer, now = () => new Date(), randomBytes = crypto.randomBytes, deps = {} }) {
  if (!customer || !customer.id) throw new Error('mintRestartEstimate requires a customer row');
  const mintDeps = resolveMintDeps(deps);
  const dbh = deps.db || db;
  const nowDate = now();

  return dbh.transaction(async (trx) => {
    // Customer-comms advisory lock FIRST (lock-order contract §1,
    // utils/customer-comms-lock.js — before this txn's own customers row
    // lock). It is also the FIRST lock the public accept transaction takes
    // for a customer-linked estimate, so a mint racing an accept serializes
    // at the advisory level before either takes a row lock — closing the
    // customers-row vs estimates-row AB-BA between the two C4 paths (mint
    // locks customer → archives estimates; accept locks estimate →
    // revalidates customer).
    await lockCustomerComms(trx, customer.id);
    // Lock the customer row: a double-tap must not mint two restart estimates.
    const fresh = await trx('customers').where({ id: customer.id }).whereNull('deleted_at').forUpdate().first();
    if (!fresh) throw new RestartUnavailableError('not_cancelled', 'This account is not cancelled.');
    // Exactly the processor's stamp, re-verified under the lock: active
    // EXPLICITLY false. A row drifting to active=NULL is not a processed
    // cancellation and must not mint (same rule as the middleware).
    if (fresh.active !== false || fresh.pipeline_stage !== 'churned') {
      throw new RestartUnavailableError('not_cancelled', 'This account is not cancelled.');
    }

    const logTag = 'plan-restart';
    const assertNotCommercial = makeCommercialGuard(fresh, deps, { logTag, handMessage: HAND_PRICED_RESTART });
    assertNotCommercial({ propertyType: fresh.property_type }, 'stored');

    const { families, caseId, requestId, source } = await cancelledFamiliesFor(fresh.id, trx);
    if (!families.length) {
      throw new RestartUnavailableError('nothing_to_restart', 'We could not find the plan to restart from this account.');
    }

    // Ownership — FAIL CLOSED: a family with LIVE recurring rows on this
    // account is never re-priced beside its live rate. Same residual read
    // the accept-time revalidation runs (assertRestartAcceptEligible).
    let ownedFamilies;
    try {
      ownedFamilies = await ownedResidualFamilies(trx, fresh.id);
    } catch (err) {
      logger.warn(`[plan-restart] residual ownership lookup failed for ${fresh.id} — refusing: ${err.message}`);
      throw new RestartUnavailableError('pricing_unavailable', 'We could not verify your services just now. Please try again in a moment.');
    }
    const owned = new Set(ownedFamilies.map(pricingKeyFor));
    // The families this mint may actually quote: cancelled minus residual.
    const eligibleFamilies = families.filter((f) => !owned.has(pricingKeyFor(f)));
    if (!eligibleFamilies.length) {
      throw new RestartUnavailableError('nothing_to_restart', 'Those services are already active on this account.');
    }

    return mintPricedEstimate({
      trx,
      fresh,
      source: SOURCE,
      families: eligibleFamilies,
      ownedFamilies,
      optionFor: (key, pricingAi) => pricingAi.variantsForService(key, '', true)[0],
      estimateBlock: {
        key: 'planRestart',
        value: {
          // The QUOTED families (reuse compares against these); the raw
          // cancellation scope rides alongside for the audit trail.
          families: eligibleFamilies,
          cancelledFamilies: families,
          familiesSource: source,
          cancellationCaseId: caseId,
          // Attempt identity for the accept path (codex GH r14 P1): a
          // reactivate-then-recancel of the SAME families passes every
          // set/churn/residual check, so the accept must also prove the
          // quote belongs to the CURRENT attempt, not a prior one whose
          // frozen price skipped the required recompute.
          cancellationRequestId: requestId,
          mintedAt: nowDate.toISOString(),
        },
      },
      matchesLive: (liveData) => {
        const liveFamilies = liveData?.planRestart?.families;
        const sameScope = Array.isArray(liveFamilies)
          && liveFamilies.length === eligibleFamilies.length
          && [...liveFamilies].sort().join(',') === [...eligibleFamilies].sort().join(',');
        // Same ATTEMPT, not just same scope (codex GH r16 P1): after a
        // reactivate-then-recancel of the same families, the accept-time
        // identity check refuses a prior attempt's token — reusing it here
        // would hand back the same unusable token on every tap. A live quote
        // from another attempt falls through to the archive + fresh mint.
        const sameAttempt = String(liveData?.planRestart?.cancellationCaseId ?? '') === String(caseId ?? '')
          && String(liveData?.planRestart?.cancellationRequestId ?? '') === String(requestId ?? '');
        return sameScope && sameAttempt;
      },
      note: (estimateId) => ({
        subject: `Restart estimate requested from portal — ${eligibleFamilies.map((f) => FAMILY_LABELS[f] || f).join(', ')}`,
        body: `Customer opened a restart estimate (${estimateId}) priced at today's rates. Accepting it restarts the plan.`,
      }),
      logTag,
      logDetail: `via ${source}`,
      handMessage: HAND_PRICED_RESTART,
      assertNotCommercial,
      nowDate,
      now,
      randomBytes,
      deps,
      mintDeps,
    });
  });
}


// Plan start (GATE_PORTAL_PLAN_START, owner 2026-11-19) — a signed-in customer
// with NO live recurring service prices ONE option on the portal pricing card
// and opens a normal, server-priced estimate for it, which they book through
// the existing public accept flow (pick a time, save a card, confirm). Same
// mint core as restart (publish without delivery, frozen send snapshot, no
// customer message). Members, churned accounts and anything that cannot be
// priced online keep the request flow: every refusal is a RestartUnavailableError
// (the route maps it to 409 { error, code }). `shownMonthly` is only COMPARED
// with the server's own recompute (offer_changed on drift) — never persisted.
async function mintPlanStartEstimate({
  customer, serviceKey, optionId, shown, now = () => new Date(), randomBytes = crypto.randomBytes, deps = {},
}) {
  if (!customer || !customer.id) throw new Error('mintPlanStartEstimate requires a customer row');
  const notEligible = () => new RestartUnavailableError('not_eligible', 'This plan cannot be priced online right now.');
  // `shown` = the amounts the card displayed (PLAN_START_SHOWN_KEYS); a plan has a monthly price.
  const shownMonthly = Number(shown?.monthly);
  if (!PLAN_START_SERVICE_KEYS.includes(serviceKey) || !Number.isFinite(shownMonthly) || !(shownMonthly > 0)) throw notEligible();
  const mintDeps = resolveMintDeps(deps);
  // The exact option the card showed: only a member of today's offered ladder
  // is priced (never the generic first one, never a client-shaped option).
  const option = mintDeps.pricingAi.variantsForService(serviceKey, '', false)
    .find((candidate) => candidate && candidate.id === optionId);
  if (!planStartOptionBookable(serviceKey, option)) throw notEligible();
  const family = serviceKey === 'termite' ? 'termite_bait' : serviceKey;
  const dbh = deps.db || db;
  const nowDate = now();

  return dbh.transaction(async (trx) => {
    // Same lock order as the restart mint and the public accept (contract §1).
    await lockCustomerComms(trx, customer.id);
    const fresh = await trx('customers').where({ id: customer.id }).whereNull('deleted_at').forUpdate().first();
    // A churned account restarts; an inactive, unreadable or member account goes by hand.
    if (!planStartAccountOpen(fresh)) throw notEligible();

    const logTag = 'plan-start';
    const assertNotCommercial = makeCommercialGuard(fresh, deps, { logTag, handMessage: HAND_PRICED_PLAN_START });
    assertNotCommercial({ propertyType: fresh.property_type }, 'stored');

    // Ownership — FAIL CLOSED, and ANY live recurring service refuses (members
    // keep the request flow): the same read the accept re-runs.
    let ownsPlan;
    try {
      ownsPlan = await ownsAnyRecurringService(trx, fresh.id);
    } catch (err) {
      logger.warn(`[${logTag}] recurring ownership lookup failed for ${fresh.id} — refusing: ${err.message}`);
      throw new RestartUnavailableError('pricing_unavailable', 'We could not verify your services just now. Please try again in a moment.');
    }
    if (ownsPlan) throw notEligible();

    return mintPricedEstimate({
      trx,
      fresh,
      source: PLAN_START_SOURCE,
      families: [family],
      // No live recurring service (checked above), so the option prices standalone.
      ownedFamilies: [],
      optionFor: () => option,
      estimateBlock: {
        key: 'planStart',
        value: {
          families: [family],
          serviceKey,
          optionId: option.id,
          mintedAt: nowDate.toISOString(),
        },
      },
      // Reuse only the quote for THIS option (the core adds today's-offer equality).
      matchesLive: (liveData) => liveData?.planStart?.serviceKey === serviceKey
        && liveData?.planStart?.optionId === option.id,
      // Every amount the card showed, to the cent (codex pre-push P0; AGENTS.md:
      // the recompute matches the shown price or the mint refuses): the
      // estimate's monthly total, and the card's own derivation
      // (quoteAmountFromLine) on TODAY's engine line for this service. Runs
      // before both a fresh mint and a reuse.
      assertOffer: ({ monthlyTotal, onetimeTotal, rawEngineResult }) => {
        const { quoteAmountFromLine, findLineItem } = mintDeps.pricingAi;
        const line = findLineItem(rawEngineResult, serviceKey);
        const today = quoteAmountFromLine(line);
        // The setup fee the card showed is the one today's line declares
        // (initialFee, the option's setupFee) — codex pre-push P1.
        const drifted = toCents(monthlyTotal) !== toCents(shownMonthly)
          || PLAN_START_SHOWN_KEYS.some((key) => toCents(today[key]) !== toCents(shown[key]))
          || toCents(Number(line?.initialFee) > 0 ? line.initialFee : 0) !== toCents(shown.setupFee);
        if (drifted) {
          throw new RestartUnavailableError('offer_changed', 'The price changed since you last looked. Please check the new price.');
        }
        // One-time money (codex pre-push P0): only what the card showed (its
        // setup, one-time and setup-fee amounts). Any other one-time charge,
        // such as a fee no line declares, is priced by hand.
        if (toCents(onetimeTotal) !== toCents(shown.dueAtStart) + toCents(shown.oneTime) + toCents(shown.setupFee)) {
          logger.warn(`[plan-start] option ${option.id} carries one-time money the card does not show (${onetimeTotal}) — refusing`);
          throw new RestartUnavailableError('pricing_unavailable', HAND_PRICED_PLAN_START);
        }
      },
      // The page must sell exactly the card's offer, on a fresh quote and on
      // a live one before reuse (planStartQuoteMismatch).
      snapshotSells: (bundle, row, data) => {
        const mismatch = planStartQuoteMismatch({
          bundle, row, data, family, shown, servesAsIs: mintDeps.sentSnapshotServesAsIs,
        });
        if (mismatch) logger.warn(`[plan-start] estimate ${row?.id || 'new'} does not sell option ${option.id} as shown: ${mismatch}`);
        return !mismatch;
      },
      note: (estimateId) => ({
        subject: `Plan estimate opened from portal — ${FAMILY_LABELS[family] || family}`,
        body: `Customer opened a plan estimate (${estimateId}) priced at today's rates. Accepting it books the first visit.`,
      }),
      logTag,
      logDetail: `option ${option.id}`,
      handMessage: HAND_PRICED_PLAN_START,
      strictEvidence: true,
      assertNotCommercial,
      nowDate,
      now,
      randomBytes,
      deps,
      mintDeps,
    });
  });
}

// Accept-time revalidation (codex GH r4 P1) — called from the public
// estimate accept transaction AFTER it takes the estimate row lock. The
// residual-ownership exclusion in the mint runs at MINT time only, but the
// published estimate stays acceptable until expiry: staff restoring a
// family (or reactivating the whole account) between mint and accept would
// let the old token accept a quote containing a now-live family — and the
// AGENTS.md bound on this exception is that a live recurring rate is never
// re-priced. Re-check the exact churn stamp and re-run the SAME residual
// read against the QUOTED families, under the lock. FAIL CLOSED: drifted or
// unreadable state refuses the accept with a 409 the portal can render.
async function assertRestartAcceptEligible(trx, estimate) {
  const refuse = (message) => {
    const err = new Error(message);
    err.status = 409;
    err.code = 'RESTART_STATE_CHANGED';
    return err;
  };
  const changed = () => refuse('This account changed since this restart quote was created — please reopen "Restart my plan" for a current quote.');
  let quoted;
  let quotedAttempt;
  let fresh;
  let ownedFamilies;
  let latestAttempt;
  try {
    // Fresh in-transaction read: the accept path locked this row FOR UPDATE
    // just above, so this sees the committed truth, not the handler's
    // pre-transaction snapshot.
    const row = await trx('estimates').where({ id: estimate.id }).first('customer_id', 'estimate_data');
    const planRestart = parseJson(row?.estimate_data, {})?.planRestart;
    quoted = Array.isArray(planRestart?.families) ? planRestart.families : null;
    quotedAttempt = {
      caseId: planRestart?.cancellationCaseId ?? null,
      requestId: planRestart?.cancellationRequestId ?? null,
    };
    // Serialize against reactivation/restoration BEFORE the eligibility
    // reads (codex pre-push P1): the estimate row lock fences neither the
    // customers row nor scheduled_services, so a concurrent staff
    // reactivation or row restoration could commit between plain reads
    // here and this accept's commit. Locks, in the repo's established
    // order (customer-comms-lock.js contract §1):
    //   1. the per-customer comms advisory key — the accept txn already
    //      holds it as its FIRST lock (reentrant, contract §3), and it is
    //      the key every scheduled_services-inserting restoration writer
    //      takes, so those serialize here;
    //   2. the customers row FOR UPDATE — a reactivation is an UPDATE on
    //      this row, so it now commits strictly before or after this
    //      check, never inside it.
    // The eligibility reads below run AFTER both locks.
    await lockCustomerComms(trx, row?.customer_id);
    fresh = row?.customer_id
      ? await trx('customers').where({ id: row.customer_id }).whereNull('deleted_at').forUpdate().first('id', 'active', 'pipeline_stage')
      : null;
    ownedFamilies = fresh ? await ownedResidualFamilies(trx, fresh.id) : [];
    // The LATEST attempt's families, under the same locks: a
    // reactivate-then-recancel with a different scope leaves an unexpired
    // older token whose families still pass the churn + residual checks
    // (codex GH r8 P1) — the quote must describe the cancellation the
    // account is actually in.
    latestAttempt = fresh ? await cancelledFamiliesFor(fresh.id, trx) : { families: [], caseId: null, requestId: null };
  } catch (err) {
    logger.warn(`[plan-restart] accept revalidation could not read state for estimate ${estimate.id} — refusing: ${err.message}`);
    throw refuse('We could not re-verify this restart just now — please try again in a moment.');
  }
  // A plan_restart estimate without its quoted families (or its customer)
  // is malformed — never accept it.
  if (!quoted || !quoted.length || !fresh) throw changed();
  // Exactly the processor's churn stamp, same rule as the mint's locked
  // re-check: anything else means staff reactivated the account.
  if (fresh.active !== false || fresh.pipeline_stage !== 'churned') throw changed();
  // A quoted family that went live again since the mint is a live rate this
  // accept would re-price — refuse; the customer re-taps for a fresh quote.
  const owned = new Set(ownedFamilies.map(pricingKeyFor));
  if (quoted.some((f) => owned.has(pricingKeyFor(f)))) throw changed();
  // The quote must EQUAL the latest attempt's eligible set (families minus
  // residual-owned) — not merely fit inside it: after a broader
  // re-cancellation, an older narrower quote would restart a subset at a
  // composition the current attempt never priced (codex pre-push P1 on GH
  // r8; same equality the mint's reuse check applies).
  const latestEligible = (latestAttempt.families || []).filter((f) => !owned.has(pricingKeyFor(f)));
  const latestSet = new Set(latestEligible.map(pricingKeyFor));
  const quotedSet = new Set(quoted.map(pricingKeyFor));
  if (quotedSet.size !== latestSet.size || [...quotedSet].some((k) => !latestSet.has(k))) throw changed();
  // Attempt IDENTITY, beyond set equality (codex GH r14 P1): a
  // reactivate-then-recancel of the SAME families produces an equal set,
  // letting a prior attempt's unexpired token accept its frozen price
  // without the recompute the new attempt requires. The quote must carry
  // the ids of the attempt the account is actually in — both the case id
  // and the request id (the case insert is best-effort, so the request is
  // the identity that always exists for a portal cancellation). Older
  // tokens minted before these stamps fail closed here; the customer
  // re-taps for a fresh, correctly-priced quote.
  const sameId = (a, b) => String(a ?? '') === String(b ?? '');
  if (!sameId(quotedAttempt?.caseId, latestAttempt.caseId)
    || !sameId(quotedAttempt?.requestId, latestAttempt.requestId)) throw changed();
}

// Plan-start accept revalidation (GATE_PORTAL_PLAN_START) — same call point and
// locks as assertRestartAcceptEligible. The published estimate stays
// acceptable until expiry, so under the estimate row lock re-run the mint's
// own eligibility: the account is still a plain active customer (not churned,
// not deleted) and owns NO live recurring family. ANY family refuses, not only
// a quoted one: the mint priced the option standalone (no WaveGuard
// qualifiers), so a plan added since, of any family, changes the price this
// estimate froze (members keep the request flow). The account must still have
// one provable premises, the one this estimate is addressed to: a move or a
// second property since the mint is a different home (codex pre-push P1). A
// stored property type staff since corrected to commercial refuses too, the
// mint's own stored-type guard (codex pre-push P0). FAIL CLOSED: drift or an
// unreadable state is the 409 the estimate page renders.
async function assertPlanStartAcceptEligible(trx, estimate) {
  const refuse = (message) => {
    const err = new Error(message);
    err.status = 409;
    err.code = 'PLAN_START_STATE_CHANGED';
    return err;
  };
  let quoted;
  let quotedStreet;
  let pricedHome;
  let fresh;
  let commercial;
  let ownsPlan;
  let premisesStreet;
  try {
    const row = await trx('estimates').where({ id: estimate.id }).first('customer_id', 'estimate_data', 'address');
    const customerId = row?.customer_id;
    const planStart = parseJson(row?.estimate_data, {})?.planStart;
    quoted = Array.isArray(planStart?.families) ? planStart.families : [];
    quotedStreet = require('../estimate-property-linkage').normalizedEstimateStreet(row?.address);
    // The home the mint priced (codex pre-push P0): a staff address change rewrites the address
    // column above on an open quote, but never this key.
    pricedHome = planStart?.premisesKey;
    // Comms advisory key, then the property-preferences key, then the
    // customers row FOR UPDATE, then the reads: the order every recurring
    // accept already takes, because the converter that runs after this check
    // takes the property-preferences key before its own customers row lock
    // (codex pre-push P1). Taking the row here first would deadlock against a
    // turf-profile save that holds that key and waits for the row; the
    // converter's second acquire is a re-entrant no-op. Staff tier, rate and
    // billing edits take these two keys the other way (admin-customers.js),
    // and a plan-start-only order would trade that for a deadlock against an
    // ordinary accept (codex pre-push r33/r34). So the check never waits on
    // the property-preferences key while it holds the comms key: it tries the
    // key once, and a key another change holds is a failed read, answered as
    // PLAN_START_RECHECK_RETRY below (codex pre-push r35). The whole row, as
    // the mint reads it: the premises proof needs the address and the
    // multi-home flag.
    await lockCustomerComms(trx, customerId);
    if (customerId) {
      const prefs = await trx.raw('SELECT pg_try_advisory_xact_lock(hashtext(?), hashtext(?::text)) AS acquired', ['property-preferences', String(customerId)]);
      // One row, always: a SELECT of one function.
      if (prefs.rows[0].acquired !== true) throw new Error('the property-preferences key is held by another change');
      fresh = await trx('customers').where({ id: customerId }).whereNull('deleted_at').forUpdate().first();
    }
    if (fresh) {
      commercial = require('../pricing-engine/commercial-helpers').isCommercialProperty({ propertyType: fresh.property_type });
      ownsPlan = await ownsAnyRecurringService(trx, fresh.id);
      premisesStreet = await singlePremisesStreet(trx, fresh, { strict: true });
    }
  } catch (err) {
    logger.warn(`[plan-start] accept revalidation could not read state for estimate ${estimate.id} — refusing: ${err.message}`);
    // A failed read is not a changed account (codex pre-push P1): its own code tells the estimate
    // page to keep the held time and the payment choice for the retry this message asks for.
    throw Object.assign(refuse('We could not re-verify this estimate just now — please try again in a moment.'), { code: 'PLAN_START_RECHECK_RETRY' });
  }
  const changed = () => refuse('This account changed since this estimate was created — please go back to your portal for a current price.');
  // A plan_start estimate without its quoted families (or its customer) is malformed — never accept it.
  if (!quoted.length || !fresh) throw changed();
  // The mint's bar again (the price was standalone and residential): no plan
  // membership on the row, no commercial type, no live recurring service of
  // any kind, and the one premises the estimate is addressed to and was priced for.
  if (!planStartAccountOpen(fresh) || commercial || ownsPlan || !premisesStreet) throw changed();
  if (!sameHome(quotedStreet, premisesStreet) || !sameHome(pricedHome, premisesStreet)) throw changed();
}

module.exports = {
  SOURCE,
  RESTARTABLE_FAMILIES,
  RestartUnavailableError,
  cancelledFamiliesFor,
  mintRestartEstimate,
  assertRestartAcceptEligible,
  PLAN_START_SOURCE,
  PLAN_START_SERVICE_KEYS,
  PLAN_START_SHOWN_KEYS,
  planStartAccountOpen,
  planStartOptionBookable,
  ownsAnyRecurringService,
  accountHasOtherProfile,
  singlePremisesStreet,
  engineResultNeedsReview,
  seedRefusesPrice,
  pricingKeyFor,
  TURF_PRICED_KEYS,
  mintPlanStartEstimate,
  assertPlanStartAcceptEligible,
  _test: { liveRestartEstimate, ownedResidualFamilies, planStartQuoteMismatch },
};
