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
const RESTARTABLE_FAMILIES = ['pest_control', 'lawn_care', 'mosquito', 'tree_shrub', 'termite_bait'];
// Pricing-ai speaks 'termite' for the termite_bait family (LINE_SERVICE_KEYS).
const pricingKeyFor = (family) => (family === 'termite_bait' ? 'termite' : family);

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
  let latestRequest = null;
  try {
    latestRequest = await dbh('service_requests')
      .where({ customer_id: customerId, category: 'cancellation' })
      .orderBy('created_at', 'desc')
      .first('id', 'created_at');
  } catch { /* unreadable — fall back to case-only correlation */ }
  const current = latest && (!latestRequest
    || String(latest.service_request_id || '') === String(latestRequest.id))
    ? latest : null;
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
    for (const key of await prepayTermFamilyKeys(dbh, customerId, attemptDate, { historical: true })) {
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
async function prepayTermFamilyKeys(dbh, customerId, dateStr, { historical = false } = {}) {
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
          .orWhere('i.status', 'paid')
          .orWhereNotNull('i.paid_at')
          .orWhereNotNull('i.payment_recorded_at')
          .orWhere('i.status', 'refunded')
          .orWhere(function legacyTerminalNoInvoice() {
            this.whereNot('t.status', 'payment_pending')
              .whereNull('t.prepay_invoice_id');
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

// The families with residual LIVE recurring obligations on this account —
// two kinds of evidence, matching cancellation-eligibility's own view of a
// live obligation: (a) non-terminal recurring rows, and (b) a series anchor
// re-armed with recurring_ongoing=true (staff can restore a family on a
// completed anchor before its next occurrence exists, and that family is
// owned, not restartable). The pricing-ai ownership loaders deliberately
// answer [] for an inactive customer (loadActiveRecurringServiceRows), so
// the churned lanes read the residual rows directly — same family detection
// as the cancelled-family recovery. Throws when the rows cannot be read;
// every caller FAILS CLOSED on that.
async function ownedResidualFamilies(dbh, customerId) {
  const {
    detectWaveGuardPlanKeys, isCommercialServiceRow, isRodentLedServiceRow, uniqueServiceFamilies,
  } = require('../self-booking-plan-sync');
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
  const residualKeys = [];
  for (const row of [...nonTerminalRows, ...ongoingAnchorRows]) {
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

async function mintRestartEstimate({ customer, now = () => new Date(), randomBytes = crypto.randomBytes, deps = {} }) {
  if (!customer || !customer.id) throw new Error('mintRestartEstimate requires a customer row');
  const persistence = deps.persistence || require('../admin-estimate-persistence');
  const pricingAi = deps.pricingAi || require('../customer-pricing-ai');
  const { pricingBundleMatchesEstimateTotals } = deps.bundleUtils || require('../estimate-pricing-bundle-utils');
  // Route adapter, lazy for the same service→route load-order reason the
  // click-mint cites.
  const buildEstimateSendSnapshot = deps.buildEstimateSendSnapshot
    || require('../../routes/admin-estimates').buildEstimateSendSnapshot;
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

    // Commercial properties never get an online restart price (codex
    // pre-push P0 — same doctrine as BOTH offer surfaces, cross-sell
    // report + portal offer: the engine refuses real prices there and
    // commercial expansion is a proposal conversation; variantsForService
    // below only knows residential defaults). Checked on the STORED type
    // here, BEFORE any reuse or mint, and re-checked on the RESOLVED type
    // after the property context is built — a cached lookup classifying
    // the property commercial must refuse too. FAIL CLOSED: a check that
    // cannot be evaluated refuses.
    const isCommercial = deps.isCommercialProperty
      || require('../pricing-engine/commercial-helpers').isCommercialProperty;
    const refuseCommercial = () => new RestartUnavailableError('pricing_unavailable', 'This restart needs to be set up by hand — please call or text us and we will take care of it.');
    const assertNotCommercial = (property, label) => {
      let commercial = true;
      try {
        commercial = isCommercial(property);
      } catch (err) {
        logger.warn(`[plan-restart] commercial check (${label}) failed for ${fresh.id} — refusing: ${err.message}`);
        throw refuseCommercial();
      }
      if (commercial) throw refuseCommercial();
    };
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
    const toPrice = eligibleFamilies.map(pricingKeyFor);
    if (!toPrice.length) {
      throw new RestartUnavailableError('nothing_to_restart', 'Those services are already active on this account.');
    }

    // Single-premises proof BEFORE any URL is handed out (codex GH r4 P1):
    // the cancelled-family and residual queries above are scoped by
    // customer_id alone, but the estimate is priced and addressed at the
    // single primary street — a family cancelled at a SECONDARY premises
    // would otherwise be quoted at the primary property's measurements.
    // Same proof the portal offer runs (customerHasOnlyPrimaryPremises,
    // cross-sell): a multi-premises profile — or a proof that cannot be
    // evaluated, a missing primary street, or a street without provable
    // locality — is the priced-by-hand 409, never an online price.
    const crossSell = deps.crossSell || require('../service-report/cross-sell');
    const linkage = require('../estimate-property-linkage');
    const primaryStreet = linkage.normalizedStampedStreet(fresh.address_line1, fresh.address_line2, fresh.city, fresh.zip);
    let singlePremises = false;
    try {
      const premisesProof = deps.customerHasOnlyPrimaryPremises
        || require('../service-report/cross-sell').customerHasOnlyPrimaryPremises;
      singlePremises = Boolean(primaryStreet)
        && !linkage.scopeKeyLacksLocality(primaryStreet)
        && await premisesProof(trx, fresh.id, fresh, primaryStreet);
    } catch (err) {
      logger.warn(`[plan-restart] single-premises proof failed for ${fresh.id} — refusing: ${err.message}`);
      singlePremises = false;
    }
    if (!singlePremises) {
      throw new RestartUnavailableError('pricing_unavailable', 'This restart needs to be set up by hand — please call or text us and we will take care of it.');
    }

    // Any prior lineage rows — the reuse decision itself is deferred until
    // TODAY's inputs have been resolved and priced (below): reusing here
    // would hand back a quote the current property context no longer
    // supports (codex pre-push P0 — a corrected measurement, a cache/
    // override update, or a commercial reclassification since mint).
    const priorRows = await trx('estimates')
      .where({ customer_id: fresh.id, source: SOURCE })
      .whereNull('archived_at')
      .orderBy('created_at', 'desc')
      .limit(10);

    // Property context: profile first, then the SAME cache-only lookup +
    // accepted-estimate seed discipline the portal offer surfaces price
    // under (cross-sell/one-tap). No LIVE lookup spend from a restart tap —
    // a cached lookup row or a prior accepted estimate for THIS street
    // supplies the footprint the stored profile lacks.
    let propertySeed = null;
    try {
      // Savepoint (codex GH r10 P2): the seed is best-effort, but a
      // statement error raised on the OUTER trx aborts the whole mint
      // ("current transaction is aborted" on the very next query) — the
      // nested transaction scopes the rollback to the lookup so the mint
      // continues on profile/cache evidence as intended.
      propertySeed = await trx.transaction((sp) => crossSell.loadEstimateSeed(sp, fresh.id, primaryStreet));
    } catch (err) {
      logger.warn(`[plan-restart] estimate property seed skipped for ${fresh.id}: ${err.message}`);
    }
    const turfProfile = await pricingAi.loadTurfProfile(trx, fresh.id);
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
    const missing = pricingAi.missingPropertyFor(toPrice, propertyContext);
    if (missing) {
      throw new RestartUnavailableError('pricing_unavailable', 'We need a property measurement on file before we can price this online.');
    }
    // No lookup result means any verified correction on this address was NOT
    // applied to the price. FAIL CLOSED, same as the offer paths' demote: an
    // unreadable probe is not evidence that no corrections exist, and a
    // correction on file makes this the priced-by-hand 409 instead of an
    // exact price on a fact staff already fixed.
    if (!lookupProducedResult) {
      let correctionsUnapplied = false;
      try {
        const probe = deps.hasVerifiedOverrides
          || require('../property-lookup/lookup-cache').hasVerifiedOverrides;
        correctionsUnapplied = await probe(pricingAi.addressForCustomer(fresh));
      } catch (err) {
        correctionsUnapplied = true;
        logger.warn(`[plan-restart] verified-override probe failed for ${fresh.id} — refusing: ${err.message}`);
      }
      if (correctionsUnapplied) {
        throw new RestartUnavailableError('pricing_unavailable', 'This one needs a quick hand-check before we can price it online.');
      }
    }

    const context = { grassType: propertyContext.grassType, palmCount: propertyContext.palmCount };
    const services = {};
    for (const key of toPrice) {
      const [option] = pricingAi.variantsForService(key, '', true);
      if (!option) continue;
      Object.assign(services, pricingAi.optionServices(option, context));
    }
    if (!Object.keys(services).length) {
      throw new RestartUnavailableError('pricing_unavailable', 'We could not price this plan online.');
    }

    const estimateData = {
      engineInputs: { ...propertyContext.propertyInput, services },
      // No follow-up / engagement automation may ever message the customer
      // about an estimate they asked for and are looking at (click-mint
      // doctrine; enforced centrally in estimate-engagement-engine).
      noEngagementAutomation: true,
      planRestart: {
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
    };
    // priorQualifyingServices from the SERVER-derived residual set —
    // normally empty for a cancelled customer, so the engine prices at
    // today's list; a family they somehow still hold prices the restart at
    // the combined tier instead of standalone. Already family-canonical.
    const priorQualifyingServices = [...ownedFamilies];
    // Persist the qualifiers WITH the inputs (click-mint pattern, codex GH
    // r8 P1): buildEstimateSendSnapshot replays engineInputs through
    // extractEngineInputs, which restores combined-tier context only from
    // estimate_data.priorQualifyingServices — omitting them recomputes the
    // partial-residual case standalone and fails the totals-match check.
    if (priorQualifyingServices.length) estimateData.priorQualifyingServices = priorQualifyingServices;
    const recomputed = await persistence.serverRecomputeFromEstimateData(estimateData, {
      priorQualifyingServices,
      recurringCustomer: priorQualifyingServices.length > 0,
    });
    if (!recomputed?.recomputed) {
      throw new Error(`plan-restart recompute failed (${recomputed?.reason || 'unknown'})`);
    }

    // FAIL CLOSED on review markers, the same demotion the offer path's
    // optionIsPriceable applies: an engine result flagged for on-site
    // verification, manual review, or low confidence — or a seed whose
    // source estimate carried its own verification markers — never becomes
    // a customer-visible price. The customer gets the priced-by-hand 409.
    const raw = recomputed.rawEngineResult || {};
    // The CANONICAL review predicates (draft-builder, same trio proposal
    // generation gates on — codex GH r12 P1): a hand-rolled subset missed
    // heuristic turf BASES (plausibleMaxTurfCap reports MEDIUM confidence
    // yet means "capped at the parcel's plausible maximum") and the other
    // review markers lineRequiresReview covers (requiresMeasurement,
    // manualReviewReasons, the zero-tree underquote, …).
    const { lineRequiresReview, lineHasHeuristicTurf } = require('../estimator-engine/draft-builder');
    const flaggedLine = (raw.lineItems || []).some((l) => l && (
      lineRequiresReview(l)
      || lineHasHeuristicTurf(l)
      || String(l.pricingConfidence || '').toLowerCase() === 'low'
    ));
    if (flaggedLine
      || (Array.isArray(raw.fieldVerify) && raw.fieldVerify.length > 0)
      || propertySeed?.requiresFieldVerification === true) {
      throw new RestartUnavailableError('pricing_unavailable', 'This one needs a quick hand-check before we can price it online.');
    }

    estimateData.result = recomputed.serverResult;
    if (recomputed.pestPricingVersion && estimateData.engineInputs.services.pest
      && typeof estimateData.engineInputs.services.pest === 'object') {
      estimateData.engineInputs.services.pest.version = recomputed.pestPricingVersion;
    }

    const totals = recomputed.serverTotals || {};
    const monthlyTotal = Number(totals.monthlyTotal || 0);
    const annualTotal = Number(totals.annualTotal || 0) || monthlyTotal * 12;
    const onetimeTotal = Number(totals.onetimeTotal || 0);
    const serverTier = recomputed.rawEngineResult?.waveGuard?.tier
      || recomputed.rawEngineResult?.waveGuard?.label || null;

    // Reuse decision — only NOW, with today's property context resolved,
    // the commercial / verified-override / review-marker gates passed, and
    // TODAY's recompute in hand (codex pre-push P0): a live quote is handed
    // back only when it names exactly today's eligible families AND today's
    // totals land on its frozen dollars. Anything else — price-config
    // drift, corrected measurements, a changed scope — retires the lineage
    // and mints fresh (owner ruling: restart ALWAYS reprices at the
    // current price; idempotent button, one honorable price at a time).
    const live = liveRestartEstimate(priorRows, nowDate);
    if (live) {
      const liveData = parseJson(live.estimate_data, {});
      const liveFamilies = liveData?.planRestart?.families;
      const sameScope = Array.isArray(liveFamilies)
        && liveFamilies.length === eligibleFamilies.length
        && [...liveFamilies].sort().join(',') === [...eligibleFamilies].sort().join(',');
      const cents = (v) => Math.round(Number(v || 0) * 100);
      // Same ATTEMPT, not just same scope (codex GH r16 P1): after a
      // reactivate-then-recancel of the same families, the accept-time
      // identity check refuses a prior attempt's token — reusing it here
      // would hand back the same unusable token on every tap. A live quote
      // from another attempt falls through to the archive + fresh mint.
      const sameAttempt = String(liveData?.planRestart?.cancellationCaseId ?? '') === String(caseId ?? '')
        && String(liveData?.planRestart?.cancellationRequestId ?? '') === String(requestId ?? '');
      // Full-offer fingerprint, not just the three aggregates (codex GH r9
      // P1): offsetting price changes across families can keep the totals
      // identical while per-service application prices or the default
      // option drifted — and acceptance converts the STORED estimate_data,
      // so reuse requires the stored offer to EQUAL today's recompute:
      // engine inputs, qualifiers, and the full server result.
      const offerFingerprint = (data) => stableStringify({
        engineInputs: data?.engineInputs ?? null,
        priorQualifyingServices: Array.isArray(data?.priorQualifyingServices) ? [...data.priorQualifyingServices].sort() : [],
        result: data?.result ?? null,
      });
      if (sameScope
        && sameAttempt
        && cents(monthlyTotal) === cents(live.monthly_total)
        && cents(annualTotal) === cents(live.annual_total)
        && cents(onetimeTotal) === cents(live.onetime_total)
        && offerFingerprint(liveData) === offerFingerprint(estimateData)) {
        return { estimateId: live.id, token: live.token, url: `/estimate/${live.token}`, reused: true };
      }
    }
    // Minting a replacement: archive the WHOLE unaccepted restart lineage
    // first — an EXPIRED restart quote left unarchived stays revivable for
    // seven days through /extension-request (restart mints stamp sent_at),
    // which would put an older price or cancellation scope back in the wild
    // beside the new quote (codex GH r6 P1). Query-shaped (not the limit-10
    // id list) so no straggler row survives; accepted rows are history and
    // stay.
    await trx('estimates')
      .where({ customer_id: fresh.id, source: SOURCE })
      .whereNull('archived_at')
      .whereNot('status', 'accepted')
      .update({ archived_at: nowDate, updated_at: nowDate });

    const token = randomBytes(16).toString('hex');
    const [created] = await trx('estimates').insert({
      estimate_data: JSON.stringify(estimateData),
      address: pricingAi.addressForCustomer(fresh) || null,
      customer_id: fresh.id,
      customer_name: `${fresh.first_name || ''} ${fresh.last_name || ''}`.trim() || null,
      customer_phone: fresh.phone || null,
      customer_email: fresh.email || null,
      monthly_total: monthlyTotal,
      annual_total: annualTotal,
      onetime_total: onetimeTotal,
      waveguard_tier: serverTier,
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
      source: SOURCE,
      service_interest: eligibleFamilies.map((f) => FAMILY_LABELS[f] || f).join(' + '),
      category: fresh.property_type === 'commercial' ? 'COMMERCIAL' : 'RESIDENTIAL',
      pricing_authority: 'SERVER',
      server_computed_price: annualTotal > 0 ? annualTotal : null,
      ...(typeof recomputed.serverResult?.engineVersion === 'string'
        ? { pricing_version: recomputed.serverResult.engineVersion.slice(0, 80) }
        : {}),
    }).returning('*');

    // Freeze the send snapshot so the public page replays the shown price
    // instead of live config — a snapshot that failed to freeze is a
    // publication failure (sibling-publication rule), never a warning.
    const withSnapshot = await buildEstimateSendSnapshot(created, now);
    if (!withSnapshot?.sendSnapshot || withSnapshot.sendSnapshot.pricingBundleError) {
      throw new Error(`plan-restart send snapshot did not freeze pricing${withSnapshot?.sendSnapshot?.pricingBundleError ? `: ${withSnapshot.sendSnapshot.pricingBundleError}` : ''}`);
    }
    if (!pricingBundleMatchesEstimateTotals(withSnapshot.sendSnapshot.pricingBundle, created)) {
      throw new Error('plan-restart send snapshot does not match the minted totals');
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
      subject: `Restart estimate requested from portal — ${eligibleFamilies.map((f) => FAMILY_LABELS[f] || f).join(', ')}`,
      body: `Customer opened a restart estimate (${created.id}) priced at today's rates. Accepting it restarts the plan.`,
    });

    logger.info(`[plan-restart] minted estimate ${created.id} for customer ${fresh.id} (${eligibleFamilies.join(',')} via ${source})`);
    return { estimateId: created.id, token, url: `/estimate/${token}`, reused: false };
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

module.exports = {
  SOURCE,
  RESTARTABLE_FAMILIES,
  RestartUnavailableError,
  cancelledFamiliesFor,
  mintRestartEstimate,
  assertRestartAcceptEligible,
  _test: { liveRestartEstimate, ownedResidualFamilies },
};
