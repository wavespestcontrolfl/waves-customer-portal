/**
 * /secure plan-choice lane (owner workflow 2026-07-24) — the pricing and
 * plan-selection brain behind the appointment card-request page.
 *
 * Read side: buildSecurePlanContext derives the page's pricing context from
 * the BOOKED SERIES (never an estimate): per-visit price from
 * scheduled_services.estimated_price, application count from the recurring
 * cadence (shared prepay-cadence helpers — same numbers as the admin
 * prepay-on-book preflight), incentive class from the converter's service
 * key (solo pest/mosquito keep the $99 WaveGuard setup-fee waiver; the
 * discountable residential programs take ANNUAL_PREPAY_DISCOUNT_PCT).
 * Every unsound input returns null and the page falls back to today's
 * card-only experience — fail toward the safe surface, never toward a
 * wrong price. NULL estimated_price means "manual quote pending", never $0.
 *
 * Write side: selectSecurePlan records the customer's choice.
 *   per_application — stamps the selection (and, for fee-waiver mixes, the
 *     $99 pending_setup_fee on the series parent so the FIRST completion
 *     invoice carries it — owner decision 2026-07-24); the customer then
 *     continues through the existing SetupIntent capture unchanged.
 *   prepay_annual — mints the annual prepay draft invoice + payment_pending
 *     term inside one transaction, mirroring the Customer360 manual mint
 *     (admin-customers.js): per-customer advisory lock + overlap assert,
 *     InvoiceService.create single-line invoice, createTermForAnnualPrepay
 *     (no estimate — series-anchored coverage), request-row stamp as the
 *     idempotency anchor. Payment happens on the existing /pay/<token>
 *     page; the invoice-payment webhook activates the term and stamps
 *     coverage — zero new money machinery. An unpaid term never suppresses
 *     completion billing (payment_pending is not coverage), so the owner's
 *     "fall back to per-visit billing" ruling is the default physics.
 *
 * Whole lane is inert unless GATE_SECURE_PLAN_CHOICE is on.
 */

const db = require('../models/db');
const logger = require('./logger');
const { isEnabled } = require('../config/feature-gates');
const { visitsPerYearForCadence, prepayCoverageCadenceForPattern } = require('./prepay-cadence');
const { recurringServiceKey, WAVEGUARD_SETUP_FEE } = require('./estimate-converter');
const { ANNUAL_PREPAY_DISCOUNT_PCT, RODENT } = require('./pricing-engine/constants');
const { resolveBillingLane } = require('./billing-lane');
const { portalUrl } = require('../utils/portal-url');
const { etDateString } = require('../utils/datetime-et');
const { callBookingDateOnly } = require('./call-booking-catalog');

// Converter key → incentive class. Whitelist ONLY — anything unlisted
// (commercial_* keys, foam_recurring, unclassifiable service names) gets no
// plan context and the page stays card-only. Commercial stays excluded so
// the displayed prepay total always equals the minted invoice total to the
// cent (InvoiceService adds county tax to commercial invoices).
const PLAN_CLASS_BY_SERVICE_KEY = {
  pest_control: 'fee_waiver',
  mosquito: 'fee_waiver',
  lawn_care: 'discount',
  tree_shrub: 'discount',
  termite_bait: 'discount',
  rodent_bait: 'discount',
  palm_injection: 'discount',
};

const LIVE_VISIT_STATUSES = ['pending', 'confirmed'];

// A prepay invoice in ANY of these states can never be paid — the selection
// it anchored is dead and the plan choice must reopen (Codex #2980: office
// cancel/refund lanes use cancelled/refunded, not just void; treating only
// 'void' as terminal left the picker stuck on an unusable pay link).
const TERMINAL_INVOICE_STATUSES = ['void', 'cancelled', 'canceled', 'refunded'];

// Mirror of admin-customers.js annualPrepayOverlapStatusClause (kept
// inline: that route exports the LOCKING assert via _private, which the
// write path uses; this read-side probe must not take locks). A cancelled
// term with renewal_decision='cancel' still covers through term_end.
function overlapStatusClause() {
  return function overlapStatus() {
    this.whereIn('status', ['payment_pending', 'active', 'renewal_pending', 'renewed', 'switch_plan'])
      .orWhere(function lapsedRenewalStillInTerm() {
        this.where('status', 'cancelled').andWhere('renewal_decision', 'cancel');
      });
  };
}

function cents(n) {
  return Math.round(Number(n) * 100) / 100;
}

/**
 * The annual-prepay incentive arithmetic for a recurring series, as one pure
 * function so every lane that quotes a prepay year uses the SAME formula:
 * this page's plan context and the admin booking modal's prepay preview
 * (routes/admin-schedule.js). A second copy of this math is how a customer
 * ends up quoted one total on the secure link and invoiced another.
 *
 * planClass comes from PLAN_CLASS_BY_SERVICE_KEY: 'fee_waiver' (solo
 * pest/mosquito — the $99 WaveGuard setup waiver IS the incentive, no % off)
 * or 'discount' (ANNUAL_PREPAY_DISCOUNT_PCT off the recurring annual). The
 * two never stack — owner ruling baked into constants.js.
 */
// unwaivedSetupFee: a one-time setup the plan owes in BOTH modes — the
// rodent bait-station setup for a non-member (owner 2026-08-29: waived only
// by another WaveGuard service, never by prepay; the converter bills it on
// the prepay invoice too). It rides prepay.total (the page total must equal
// the minted invoice) while prepay.coverageTotal stays the per-visit
// coverage money the term is sliced from (codex #3591 r9 P1).
function computeSeriesPrepayPricing({ perVisit, visitsPerYear, planClass, unwaivedSetupFee = 0 }) {
  const annualBase = cents(Number(perVisit) * Number(visitsPerYear));
  const discountRate = planClass === 'discount' ? ANNUAL_PREPAY_DISCOUNT_PCT : 0;
  const coverageTotal = cents(annualBase * (1 - discountRate));
  const setup = cents(Math.max(0, Number(unwaivedSetupFee) || 0));
  return {
    annualBase,
    prepay: {
      total: cents(coverageTotal + setup),
      coverageTotal,
      setupAmount: setup,
      discount: cents(annualBase - coverageTotal),
      // Rendered label, server-derived so the client never holds a rate
      // constant. '' for the waiver class (the waiver line is the pitch).
      ratePctLabel: discountRate > 0 ? `${Math.round(discountRate * 1000) / 10}%` : '',
    },
    setupFee: planClass === 'fee_waiver'
      ? { amount: WAVEGUARD_SETUP_FEE, waivedWithPrepay: true }
      : (setup > 0 ? { amount: setup, waivedWithPrepay: false } : null),
  };
}

// The booked cadence, normalized the way the admin prepay-on-book path
// normalizes it: the modal encodes every-6-weeks as pattern 'custom' with a
// 42-day interval (admin-schedule.js). Any other custom interval has no
// supported coverage mapping and returns null (fail closed).
function normalizedPattern(visit) {
  const raw = String(visit.recurring_pattern || '').trim().toLowerCase();
  if (!raw) return null;
  if (raw === 'custom') {
    return Number(visit.recurring_interval_days) === 42 ? 'every_6_weeks' : null;
  }
  return raw;
}

async function loadPlanVisit(scheduledServiceId, conn = db) {
  return conn('scheduled_services')
    .where({ id: scheduledServiceId })
    .first('id', 'customer_id', 'status', 'scheduled_date', 'service_type', 'service_id', 'estimated_price',
      'is_recurring', 'recurring_pattern', 'recurring_interval_days', 'recurring_parent_id',
      'pending_setup_fee', 'source_estimate_id');
}

// The series anchor row: card links can be sent from a recurring CHILD's
// editor row, but the setup-fee stamp and the coverage window always live
// on the parent — stamping the child would strand a disclosed fee the
// completion claim (which always reads the parent) never finds.
function seriesAnchorId(visit) {
  return visit.recurring_parent_id || visit.id;
}

/**
 * Strict derivation core: null ONLY by policy (lane dark, or an input the
 * lane deliberately excludes — the caller renders today's card-only page);
 * a derivation FAILURE (db hiccup, dependency error) THROWS instead of
 * collapsing into that null. The distinction is load-bearing for the
 * /secure render stamp (appointment-card-request.js): a null context is
 * read there as "the page displayed no price" and pins the STICKY
 * accepted_amount=0 consent sentinel — permanent by design (monotonic-down
 * CASE + one request row per visit, ever) — so a transient exception must
 * surface as a retryable failure, never as a deliberate no-price display.
 * Callers that only need the safe fallback use buildSecurePlanContext
 * below, which keeps the historical never-throws contract.
 */
/**
 * The non-member bait-station setup a DIRECT (non-estimate) rodent bait
 * series owes (owner 2026-08-29; codex #3591 r9/r28): live
 * RODENT.baitSetupFee when the account has no OTHER qualifying recurring
 * family (rodent never self-waives), else 0. Estimate-origin series made
 * their billing choice at accept (0 here). ONE resolver for every
 * activation path — the /secure plan page (saved-card auto-secure DEFERS to
 * it when a setup is owed: nothing undisclosed is ever stamped), and
 * the admin prepay-on-book — so none can activate or prepay the series
 * without the obligation. Lookup failures propagate (callers fail closed).
 */
// Callers hand this resolver whatever fragment they happen to hold (the
// funnel loads no provenance columns; the secure-page saved-card branch
// passes id/customer only). Trusting the fragment mis-classifies: an
// estimate-origin visit reads as direct (second setup), a child gets
// stamped instead of its anchor, a direct rodent visit with no
// service_type reads as non-rodent (no setup). So a PERSISTED visit (id
// present) is always re-read by id (codex #3591 r29 P1); only an
// unpersisted preview row (no id — the prepay-on-book preview prices a
// booking that does not exist yet) is taken as given. A missing row throws
// (callers fail closed).
const SETUP_VISIT_COLUMNS = ['id', 'customer_id', 'service_type', 'service_id', 'source_estimate_id', 'recurring_parent_id', 'pending_setup_fee', 'created_at', 'status'];

// The visit's service identity, CATALOG first (codex #3591 r32 P1): a
// scheduled row's service_type label goes stale after a catalog
// reassignment while service_id stays authoritative everywhere else. A
// 'Pest Control'-labeled row linked to rodent_bait_quarterly IS the bait
// program (setup owed, rodent plan class); a bait-labeled row repointed to
// rodent_trapping is not. Unlinked legacy rows classify from the label. A
// failed catalog read throws — callers fail closed (skip / unavailable /
// refuse), never a label-only guess for a linked row.
async function authoritativeServiceKey(database, row = {}) {
  if (row.service_id) {
    const catalog = await database('services').where({ id: row.service_id }).first('service_key', 'name');
    if (catalog && (catalog.service_key || catalog.name)) {
      return recurringServiceKey({ service_key: catalog.service_key || undefined, name: catalog.name || undefined });
    }
  }
  return recurringServiceKey({ name: row.service_type });
}
async function loadAuthoritativeSetupVisit(database, visit) {
  if (!visit || !visit.id) return visit || {};
  const row = await database('scheduled_services').where({ id: visit.id }).first(...SETUP_VISIT_COLUMNS);
  if (!row) throw new Error(`resolveDirectRodentSetupObligation: scheduled_services ${visit.id} not found`);
  return row;
}

// The POSITIVE per-application claim already stamped on the series anchor —
// the exact figure the customer accepted through /secure, frozen at
// disclosure (codex #3591 r40 P1). A persisted child resolves to its parent's
// stamp; a draft fragment (no row) has none. A negative stamp is a completion
// mid-claim, not an accepted figure — callers that retire it refuse.
// Both bait-program identities owe the one-time setup (codex #3591 r47
// P1): the engine emits rodent_bait_setup for priced commercial programs
// too (commercial coverage is never a WaveGuard member). Commercial stays
// OUT of tier qualification — only the setup lifecycle is shared.
function isRodentBaitProgramKey(key) {
  return key === 'rodent_bait' || key === 'commercial_rodent_bait';
}

async function loadSeriesAnchor(database, row) {
  if (!row || !row.id) return null;
  if (!row.recurring_parent_id) return row;
  return database('scheduled_services').where({ id: row.recurring_parent_id }).first('id', 'pending_setup_fee', 'created_at', 'source_estimate_id');
}
function frozenAnchorSetupStamp(anchor) {
  const stamp = anchor && anchor.pending_setup_fee != null ? Number(anchor.pending_setup_fee) : NaN;
  return Number.isFinite(stamp) && stamp > 0 ? cents(stamp) : null;
}

async function directRodentSetupForRow(database, row) {
  if (!row || !row.customer_id) return 0;
  const programKey = await authoritativeServiceKey(database, row);
  if (!isRodentBaitProgramKey(programKey)) return 0;
  const anchor = await loadSeriesAnchor(database, row);
  // An accepted/RESTORED frozen claim outranks everything (codex #3591 r40
  // P1, r44 P1): the stamp is what the retirement path clears, so it is
  // also what the prepay bills — including on an ESTIMATE-origin series
  // whose refunded prepay just re-stamped it (estimate provenance is proof
  // the ORIGINAL decision was made at accept, not that a restored claim is
  // settled).
  const frozen = frozenAnchorSetupStamp(anchor);
  if (frozen != null) return frozen;
  // ALREADY COLLECTED / IN COLLECTION (codex #3591 r53 P1): the first
  // completion (or a prepay) billed this series' setup — the claims ledger
  // keeps the record while the stamp is cleared. A live (non-terminal)
  // claim invoice means the fee exists exactly once already; never derive
  // a second obligation for the same series.
  if (anchor?.id) {
    const anchorClaims = await database('setup_fee_claims')
      .where({ scheduled_service_id: anchor.id })
      .select('invoice_id');
    for (const cl of anchorClaims || []) {
      const claimInvoice = await database('invoices').where({ id: cl.invoice_id }).first('status');
      if (claimInvoice && !['void', 'cancelled', 'canceled', 'refunded'].includes(String(claimInvoice.status).toLowerCase())) return 0;
    }
  }
  // Estimate provenance lives on the ROOT (codex #3591 r47 local P0): a
  // series child carries no source_estimate_id of its own, so the anchor's
  // decides too — an estimate-origin series made its setup decision at
  // accept and never re-prices as a direct booking.
  if (row.source_estimate_id || anchor?.source_estimate_id) return 0;
  // Provenance (codex #3591 r42 P1): only a POST-rollout direct series can
  // owe the live fee — a grandfathered series booked before the realignment
  // (no estimate, no stamp: the old recurring signup waived setup) must not
  // acquire a $99 obligation years later from /secure, prepay-on-book or a
  // switch. Same rollout instant the membership extension reads
  // (knex_migrations.migration_time of 20260829000040); an unreadable
  // rollout or root date fails CLOSED to no fee. A draft fragment (no row
  // yet) is a new booking and prices live.
  if (row.id) {
    const { rodentRealignmentRolloutMs } = require('./rodent-bait-legacy-replay');
    const rolloutMs = await rodentRealignmentRolloutMs(database);
    const createdMs = new Date(anchor?.created_at ?? NaN).getTime();
    if (!(rolloutMs > 0) || !Number.isFinite(createdMs) || createdMs < rolloutMs) return 0;
  }
  // The qualifying-family waiver is RESIDENTIAL-only: commercial coverage
  // is never a WaveGuard member (owner ruling 2026-08-29), so its setup is
  // never waived by the account's other families.
  if (programKey === 'rodent_bait') {
    // STRICT (codex #3591 r69 P1): the default loader reads a failed
    // membership/catalog read as "no other family" and this resolver would
    // disclose or stamp a $99 the customer's other plan waives — a throw
    // reaches the callers' existing fail-closed handling instead.
    // planGate: false (codex #3591 r73 P1): the waiver is "any OTHER
    // qualifying family", not plan membership — a qualifying row whose
    // tier stamp has not landed yet (booking enrolls AFTER this resolver)
    // still waives.
    const { loadExistingQualifyingServiceKeys } = require('./waveguard-existing-services');
    const otherQualifiers = (await loadExistingQualifyingServiceKeys(database, row.customer_id, { strict: true, planGate: false }) || [])
      .filter((key) => key !== 'rodent_bait');
    if (otherQualifiers.length > 0) return 0;
  }
  return cents(Math.max(0, Number(RODENT.baitSetupFee) || 0));
}

async function resolveDirectRodentSetupObligation(database, visit = {}) {
  const row = await loadAuthoritativeSetupVisit(database, visit);
  return directRodentSetupForRow(database, row);
}

// Immutable ledger row for a setup fee that rode a PREPAY invoice as its own
// line (codex #3591 r34 P1). Same table the completion mint writes (server
// only, exact cents): it is the Auto Pay rail's crash-resume evidence for
// that invoice AND the key the term void/refund sync uses to put the
// per-application claim back on the series parent
// (InvoiceService.restoreRetiredSetupFeeClaimForPrepay). Idempotent on the
// invoice id.
// estimateId (codex #3591 r70 P1): the accepted estimate an accept-side mint
// billed the setup for — the key a later booking from that estimate uses to
// see the claim when it is still anchor-less (migration 20260831000030).
async function recordSetupFeeClaimForInvoice(trx, { invoiceId, anchorId, amount, estimateId = null }) {
  const fee = cents(Math.max(0, Number(amount) || 0));
  if (!invoiceId || !(fee > 0)) return false;
  await trx('setup_fee_claims')
    .insert({
      invoice_id: invoiceId,
      scheduled_service_id: anchorId || null,
      amount: fee,
      ...(estimateId ? { estimate_id: estimateId } : {}),
    })
    .onConflict('invoice_id')
    .ignore();
  return true;
}

// The ledger row an acceptance's invoice carries, or null — the immutable
// evidence that the acceptance SETTLED the rodent setup (codex #3591 r64
// P1: a standard verbal win skips the setup invoice entirely, so only a
// claim proves the fee was billed). Read-only.
async function settledSetupClaimForInvoice(database, invoiceId) {
  if (!invoiceId) return null;
  const claim = await database('setup_fee_claims').where({ invoice_id: invoiceId }).first('id', 'scheduled_service_id', 'amount');
  if (!claim) return null;
  // Only a LIVE/PAID invoice settles (codex #3591 r68/r69 P1): a prepay
  // voided or refunded — before its series existed, or between the accept
  // commit and the post-acceptance stamp cleanup — keeps its claim as an
  // OPEN obligation for recovery, never as a settlement that clears a stamp.
  const invoice = await database('invoices').where({ id: invoiceId }).first('status');
  if (!invoice || TERMINAL_INVOICE_STATUSES.includes(String(invoice.status || '').toLowerCase())) return null;
  return claim;
}

// Settlement evidence when the acceptance was WON BY ANOTHER SESSION (codex
// #3591 r65 P1): markEstimateManuallyAccepted short-circuits with
// alreadyAccepted and no conversion, so the booking must resolve the
// winner's prepay invoice through the estimate's term and read its claim.
async function settledSetupClaimForEstimate(database, estimateId) {
  if (!estimateId) return null;
  const term = await database('annual_prepay_terms').where({ source_estimate_id: estimateId }).first('prepay_invoice_id');
  const viaTerm = await settledSetupClaimForInvoice(database, term?.prepay_invoice_id || null);
  if (viaTerm) return viaTerm;
  // Claims the accept-side mints keyed to this estimate (codex #3591 r70
  // P1): a standard/invoice-mode acceptance bills the setup with no term —
  // and, for invoice-mode commercial accepts, before any series exists —
  // so the term lookup alone misses it and the booking would stamp the
  // same setup again. Live-invoice rule applies to each candidate.
  const byEstimate = await database('setup_fee_claims').where({ estimate_id: estimateId }).select('id', 'invoice_id', 'scheduled_service_id', 'amount');
  for (const candidate of byEstimate || []) {
    const live = await settledSetupClaimForInvoice(database, candidate.invoice_id);
    if (live) return live;
  }
  return null;
}

// A series can still CONSUME its setup stamp when the root is live, or when
// a terminal/completed/rescheduled root still has a child that can complete
// (codex #3591 r67/r68 P1). Shared by every carried-setup probe so the
// liveness rule cannot drift between them.
const ROOT_NEEDS_LIVE_CHILD_STATUSES = ['cancelled', 'canceled', 'skipped', 'no_show', 'completed', 'rescheduled'];
const CHILD_CAN_COMPLETE_STATUSES = ['pending', 'confirmed', 'rescheduled', 'en_route', 'on_site'];
async function seriesCanStillConsume(database, root) {
  if (!root?.id) return false;
  if (!ROOT_NEEDS_LIVE_CHILD_STATUSES.includes(String(root.status || '').toLowerCase())) return true;
  const liveChild = await database('scheduled_services')
    .where({ recurring_parent_id: root.id })
    .whereIn('status', CHILD_CAN_COMPLETE_STATUSES)
    .first('id');
  return !!liveChild;
}

// TRUE when another series booked from this estimate already carries the
// setup (a live positive stamp) or collected it (a claim on that root) —
// a second series booked later from the same accepted estimate must not
// stamp the disclosed setup again (codex #3591 r66 P1).
async function estimateSetupCarriedElsewhere(database, estimateId, excludeRootId = null) {
  if (!estimateId) return false;
  let query = database('scheduled_services')
    .where({ source_estimate_id: estimateId })
    .whereNull('recurring_parent_id');
  if (excludeRootId) query = query.whereNot('id', excludeRootId);
  const roots = await query.select('id', 'pending_setup_fee', 'status');
  const ids = [];
  for (const root of roots || []) {
    ids.push(root.id);
    if (!(Number(root.pending_setup_fee) > 0)) continue;
    // A stamp counts only on a series that can still CONSUME it (codex
    // #3591 r67 P1): a cancelled root (no live children) can never bill
    // its stamp, so a replacement series booked from the same estimate
    // must carry the disclosed setup itself.
    if (await seriesCanStillConsume(database, root)) return true;
  }
  if (!ids.length) return false;
  // An immutable collected claim on any root of the estimate counts
  // regardless of that root's status — the fee was billed once already.
  // LIVE-invoice rule (codex #3591 r74 P1): the reversal now KEEPS the
  // claim of a stamp-restored invoice as reinstatement provenance, so a
  // claim whose invoice is void/refunded is an open obligation (the
  // restored stamp is checked above), never proof of collection.
  const rootClaims = await database('setup_fee_claims').whereIn('scheduled_service_id', ids).select('id', 'invoice_id');
  for (const rc of rootClaims || []) {
    if (await settledSetupClaimForInvoice(database, rc.invoice_id)) return true;
  }
  return false;
}

// The positive booking-time stamp on the visit's series anchor, or null —
// the completion rail collects a stamped setup on its own, so a staff page
// about that setup must be disclosure-only (codex #3591 r65 P1).
async function stampedSetupForVisit(database, visit) {
  const row = await loadAuthoritativeSetupVisit(database, visit);
  if (!row) return null;
  return frozenAnchorSetupStamp(await loadSeriesAnchor(database, row));
}

// Anchor a claim the prepay mint ledgered before its series existed
// (anchor-less, keyed to the invoice) onto the series that was booked for
// it, so a later refund of that prepay restores the stamp there instead of
// paging. Only fills an EMPTY anchor — never re-points a settled one.
async function anchorSetupFeeClaim(database, { claimId, anchorId }) {
  if (!claimId || !anchorId) return false;
  const updated = await database('setup_fee_claims')
    .where({ id: claimId })
    .whereNull('scheduled_service_id')
    .update({ scheduled_service_id: anchorId });
  return Number(updated) === 1;
}

// A LIVE anchor-less claim a Customer 360 coverage-only prepay mint ledgered
// for this customer's rodent coverage before any series existed (codex #3591
// r73 P1): a direct admin booking of that coverage IS the covered series, so
// it must consume this claim (anchor it) instead of stamping a second
// collectible setup. Term-backed only — an estimate-keyed claim anchors via
// the linked-estimate branch — and the live-invoice rule applies (a voided/
// refunded prepay's claim is an open obligation, not a settlement). Returns
// the claim row or null; lookup failures throw (the booking transaction
// rolls back retryably).
async function liveAnchorlessCoverageSetupClaim(database, { customerId, rootId }) {
  if (!customerId || !rootId) return null;
  const root = await database('scheduled_services').where({ id: rootId }).first(...SETUP_VISIT_COLUMNS);
  if (!root) return null;
  const programKey = await authoritativeServiceKey(database, root);
  if (!isRodentBaitProgramKey(programKey)) return null;
  const terms = await database('annual_prepay_terms')
    .where({ customer_id: customerId })
    .whereNotNull('prepay_invoice_id')
    .select('prepay_invoice_id', 'coverage_service_type');
  for (const term of terms || []) {
    if (recurringServiceKey({ name: term.coverage_service_type }) !== programKey) continue;
    const claim = await database('setup_fee_claims')
      .where({ invoice_id: term.prepay_invoice_id })
      .whereNull('scheduled_service_id')
      .whereNull('estimate_id')
      .first('id', 'invoice_id', 'amount');
    if (!claim) continue;
    // Live-invoice rule (codex #3591 r68/r69 P1): a voided/refunded prepay's
    // claim is an open obligation for recovery, never a settlement.
    const invoice = await database('invoices').where({ id: claim.invoice_id }).first('status');
    if (!invoice || TERMINAL_INVOICE_STATUSES.includes(String(invoice.status || '').toLowerCase())) continue;
    return claim;
  }
  return null;
}

// Customer 360 Annual Prepay dialog (codex #3591 r37 P1): the general mint
// names only a coverage service type — no anchor, no setup. Omission must
// not read as a waiver: derive the obligation from the customer's LIVE direct
// rodent series matching that coverage (same shared resolver every other
// lane runs). Returns { anchorId, amount } for the first root that owes a
// setup, or null. Lookup failures throw (callers refuse retryably).
async function findDirectRodentSetupObligationForCoverage(database, { customerId, coverageServiceType }) {
  if (!customerId || !coverageServiceType) return null;
  const { serviceMatchesCoverage } = require('./annual-prepay-renewals');
  // Completed roots stay in the net (codex #3591 r42 P1): a series whose
  // first visit already ran is still the customer's live rodent plan while
  // it has live children — dropping it would read the coverage as brand
  // new and derive a second setup. Dead roots (no live child) are skipped.
  // 'rescheduled' roots stay too (codex #3591 r44 P1): the legacy customer
  // reschedule marks the ROOT rescheduled while its future children remain —
  // the series still exists, so it must not read as brand-new coverage.
  // No status filter here (codex #3591 r68 P1): a CANCELLED root whose later
  // child is still live is still the series that carries/collected the
  // setup — dropping it would make this coverage read as a brand-new
  // program and add a second setup. Liveness is decided per root below.
  const roots = await database('scheduled_services')
    .where({ customer_id: customerId })
    .whereNull('recurring_parent_id')
    .where(function recurringRoots() {
      this.where('is_recurring', true).orWhereNotNull('recurring_pattern');
    })
    .orderBy('scheduled_date', 'asc')
    .select(...SETUP_VISIT_COLUMNS);
  // Catalog identity decides the match for a LINKED root (codex #3591 r42
  // P1): a bait-program root wearing a stale "Pest Control" label still IS
  // the rodent coverage; only unlinked legacy rows match on the label.
  const coverageKey = recurringServiceKey({ name: coverageServiceType });
  const coverageIsBait = isRodentBaitProgramKey(coverageKey);
  let sawMatchingRoot = false;
  // Every matching root that still owes its per-series setup (codex #3591
  // r67 P1): a generic coverage request covering TWO owed series cannot
  // bill one setup as if it settled both — the caller must name the series.
  const owedRoots = [];
  for (const root of roots || []) {
    const matches = root.service_id
      ? (await authoritativeServiceKey(database, root)) === coverageKey
      : serviceMatchesCoverage(root, coverageServiceType);
    if (!matches) continue;
    if (!(await seriesCanStillConsume(database, root))) continue;
    sawMatchingRoot = true;
    // An ESTIMATE-origin series made its setup decision at accept — never
    // re-derive a LIVE fee here (it would bill the accept's setup a second
    // time). But a POSITIVE restored claim (its refunded prepay re-stamped
    // the root; codex #3591 r44 P1) IS the outstanding obligation.
    if (root.source_estimate_id) {
      const restored = frozenAnchorSetupStamp(root);
      if (restored != null) owedRoots.push({ anchorId: root.id, amount: restored });
      // Settled at accept — but a LATER matching root (a newer direct
      // series) may still owe its own setup (codex #3591 r52 P1): keep
      // scanning instead of concluding the coverage is settled.
      continue;
    }
    const owed = await directRodentSetupForRow(database, root);
    if (owed > 0) owedRoots.push({ anchorId: root.id, amount: owed });
  }
  if (owedRoots.length > 1) {
    const err = new Error(`${owedRoots.length} ${coverageServiceType} series each owe a bait-station setup — prepay one series at a time (send its scheduledServiceId) so every setup rides its own invoice`);
    err.switchConflict = true;
    err.ambiguousSetupSeries = owedRoots.map((o) => String(o.anchorId));
    throw err;
  }
  if (owedRoots.length === 1) return owedRoots[0];
  if (sawMatchingRoot) return null;
  if (coverageIsBait && coverageKey === 'commercial_rodent_bait') {
    // A NEW commercial bait prepay before any series exists: never waived
    // (commercial is never a member) — always owed, anchor-less.
    return { anchorId: null, amount: cents(Math.max(0, Number(RODENT.baitSetupFee) || 0)) };
  }
  // NO root yet (codex #3591 r41 P1): the Customer 360 dialog can sell a
  // NEW rodent prepay before any series exists — annual-prepay-renewals
  // seeds the covered series afterwards, without a stamp, so the setup
  // must ride THIS invoice or it is lost. Derive it from the requested
  // coverage family and the account's other qualifying families; the
  // claim is ledgered anchor-less and the restore resolves the seeded root
  // from the term's coverage later.
  if (recurringServiceKey({ name: coverageServiceType }) !== 'rodent_bait') return null;
  const { loadExistingQualifyingServiceKeys } = require('./waveguard-existing-services');
  // planGate: false (codex #3591 r73 P1) — waiver reads qualify on live
  // rows, never the membership stamp.
  const otherQualifiers = (await loadExistingQualifyingServiceKeys(database, customerId, { strict: true, planGate: false }) || [])
    .filter((key) => key !== 'rodent_bait');
  if (otherQualifiers.length > 0) return null;
  return { anchorId: null, amount: cents(Math.max(0, Number(RODENT.baitSetupFee) || 0)) };
}

// Customer 360 mint of a NEW rodent prepay with no series root yet (codex
// #3591 r41 P1): re-derive the coverage obligation under the mint's
// transaction, refuse on drift (an anchor appeared, the amount moved, or the
// account gained a waiving family), then ledger the claim anchor-less against
// the prepay. Errors carry `switchConflict` (→ 409) like the anchored path.
async function retireCoverageOnlySetupClaim(trx, { customerId, coverageServiceType, invoiceId, amount }) {
  const fee = cents(Math.max(0, Number(amount) || 0));
  if (!(fee > 0)) return { recorded: false, retired: false };
  const conflict = (message) => { const err = new Error(message); err.switchConflict = true; return err; };
  // Serialize with the recurring-booking creators (codex #3591 r73 P1):
  // admin-schedule locks the CUSTOMER ROW before inserting a series root, so
  // this probe must wait behind an in-flight booking or it records an
  // anchorless claim while an uncommitted root is being stamped — after both
  // commit the setup is collectible twice. Lock order matches the secure
  // funnel's (annual-prepay advisory first, customer row second); the
  // booking transaction never takes the annual-prepay advisory lock, so no
  // cycle. A booking that wins commits its root first and the probe below
  // then refuses with the series-now-exists conflict.
  await trx('customers').where({ id: customerId }).forUpdate().first('id');
  const owed = await module.exports.findDirectRodentSetupObligationForCoverage(trx, { customerId, coverageServiceType });
  if (!owed) throw conflict('The bait-station setup is no longer owed for this coverage — refresh and retry');
  if (owed.anchorId) throw conflict('A series now exists for this coverage — refresh so the setup is billed against it');
  if (Math.round(owed.amount * 100) !== Math.round(fee * 100)) {
    throw conflict(`The bait-station setup changed since the preview (previewed $${fee.toFixed(2)}, now $${Number(owed.amount).toFixed(2)}) — refresh and retry`);
  }
  await recordSetupFeeClaimForInvoice(trx, { invoiceId, anchorId: null, amount: fee });
  return { recorded: true, retired: false };
}

// Customer 360 / prepay-on-book mint (codex #3591 r36 P1): the modal relays
// the preview's mintPayload, whose setupFeeAmount is a CLIENT-carried number.
// Re-derive the obligation from the persisted series anchor (must belong to
// this customer), refuse a mismatch (the preview and the mint must agree to
// the cent), then run the same ledger + claim-retire step the on-site switch
// runs so a later void/refund of this prepay restores the claim. Errors carry
// `switchConflict` (→ 409) like the switch lane.
async function retirePrepayOnBookSetupClaim(trx, { customerId, scheduledServiceId, invoiceId, amount }) {
  const fee = cents(Math.max(0, Number(amount) || 0));
  if (!(fee > 0)) return { recorded: false, retired: false };
  const conflict = (message) => { const err = new Error(message); err.switchConflict = true; return err; };
  if (!scheduledServiceId) throw conflict('setupFeeAmount requires scheduledServiceId — the committed series the bait-station setup belongs to');
  const visit = await trx('scheduled_services')
    .where({ id: scheduledServiceId })
    .first('id', 'customer_id', 'recurring_parent_id', 'source_estimate_id');
  if (!visit || String(visit.customer_id) !== String(customerId)) throw conflict('The prepaid series does not belong to this customer — refresh and retry');
  const anchorId = visit.recurring_parent_id || visit.id;
  // Through module.exports so a caller's spy on the shared resolver sees
  // this leg exactly as it sees the preview's (same test seam).
  const owed = await module.exports.resolveDirectRodentSetupObligation(trx, { id: anchorId });
  if (Math.round(owed * 100) !== Math.round(fee * 100)) {
    throw conflict(`The bait-station setup changed since the preview (previewed $${fee.toFixed(2)}, now $${Number(owed).toFixed(2)}) — refresh and retry`);
  }
  return retireDirectSetupClaimForPrepay(trx, { anchorId, invoiceId, amount: fee });
}

// The on-site prepay switch bills a DIRECT rodent series' unwaived setup as
// its own prepay line (codex #3591 r33 P1). The series parent may ALSO hold
// the durable per-application claim (pending_setup_fee) an earlier
// secure-plan selection stamped — left in place, the first billable
// completion after the prepaid term would consume it and charge the setup a
// SECOND time (codex #3591 r34 P1). Under the mint's transaction: record the
// fee against the prepay (restore key), then retire the positive claim by
// exact-value CAS. A NEGATIVE stamp is a completion mint mid-claim — refuse
// the switch rather than race it (the operator retries once it settles).
// amount 0 (the waived WaveGuard class — no line billed, nothing to ledger)
// still runs the same guarded retire: a positive claim is cleared by CAS
// because prepay waives it, and a negative one still refuses (codex #3591
// r40 P1 — the /secure prepay selection used to clear ANY non-null stamp,
// racing the technician's completion claim on the parent into a double
// charge).
async function retireDirectSetupClaimForPrepay(trx, { anchorId, invoiceId, amount }) {
  const fee = cents(Math.max(0, Number(amount) || 0));
  if (!anchorId || !invoiceId) return { recorded: false, retired: false };
  const parent = await trx('scheduled_services').where({ id: anchorId }).forUpdate().first('id', 'pending_setup_fee');
  const stamp = parent?.pending_setup_fee != null ? Number(parent.pending_setup_fee) : null;
  if (stamp != null && stamp < 0) {
    const err = new Error('The bait-station setup is being billed by a completion in progress — retry in a moment');
    err.switchConflict = true;
    throw err;
  }
  // A completion can WIN between the caller's derivation and this lock
  // (codex #3591 r72 P1): it clears the stamp and writes its own live
  // claim, so a bare stamp read sees neither positive nor negative and
  // this would record a SECOND collectible setup on the prepay. Under the
  // lock, a live sibling claim on the anchor means the setup is already
  // consumed — conflict, the caller re-derives.
  if (fee > 0) {
    const siblingClaims = await trx('setup_fee_claims')
      .where({ scheduled_service_id: anchorId })
      .whereNot({ invoice_id: invoiceId })
      .select('id', 'invoice_id');
    for (const sibling of siblingClaims || []) {
      const siblingInvoice = await trx('invoices').where({ id: sibling.invoice_id }).first('status');
      if (siblingInvoice && !TERMINAL_INVOICE_STATUSES.includes(String(siblingInvoice.status || '').toLowerCase())) {
        const err = new Error('The bait-station setup was just billed by a completion on this series — refresh and retry');
        err.switchConflict = true;
        throw err;
      }
    }
    await recordSetupFeeClaimForInvoice(trx, { invoiceId, anchorId, amount: fee });
  }
  let retired = 0;
  if (stamp != null && stamp > 0) {
    retired = await trx('scheduled_services')
      .where({ id: anchorId, pending_setup_fee: parent.pending_setup_fee })
      .update({ pending_setup_fee: null, updated_at: new Date() });
  }
  return { recorded: fee > 0, retired: retired === 1 };
}

// consumeDisclosure: the SELECTION path (selectSecurePlan). There a NULL
// accepted_setup_fee means the setup was never shown on any render of this
// request — a page rendered before the column shipped (migration
// 20260829000041 backfills nothing) or a plan page that never displayed —
// so nothing may be billed (pre-push codex P0 on r30). The render path
// (default) still prices live: that is the render that discloses + stamps.
async function deriveSecurePlanContext({ request, visitId, consumeDisclosure = false }) {
  if (!isEnabled('securePlanChoice')) return null;
  const visit = await loadPlanVisit(visitId || request.scheduled_service_id);
  if (!visit || !visit.customer_id) return null;

  // NULL/zero price = manual quote pending — never $0, never a plan page.
  const perVisit = visit.estimated_price != null ? Number(visit.estimated_price) : null;
  if (!(perVisit > 0)) return null;

  // An estimate-origin series already made its billing choice at accept —
  // the accept flow minted the setup+first-application invoice (incl. the
  // $99) and stamped the per_application lane. Re-offering the plan page
  // there would double-disclose (and double-bill) the setup fee.
  if (visit.source_estimate_id) return null;

  const customer = await db('customers')
    .where({ id: visit.customer_id })
    .first('id', 'billing_mode', 'waveguard_tier', 'monthly_rate', 'property_type');
  if (!customer) return null;
  // Commercial/business properties are excluded from v1 (InvoiceService
  // taxes both — tax would split the page total from the invoice total);
  // monthly members pay dues, annual-prepay customers are already
  // covered, and an established per_application customer already paid
  // their setup fee at estimate accept — all would falsify the plan copy
  // or double-bill the fee.
  if (['commercial', 'business'].includes(String(customer.property_type || '').toLowerCase())) return null;
  // An established per_application lane hides the plan page — UNLESS this
  // visit is a residential bait program owing its setup (codex #3591 r49
  // P1): the lane may belong to an unrelated service (palm injection),
  // which never waives the rodent setup, and /secure is the disclosure
  // rail the funnel routed here for.
  const serviceKey = await authoritativeServiceKey(db, visit);
  if (customer.billing_mode === 'per_application' && serviceKey !== 'rodent_bait') return null;
  // A COVERED lane (membership dues, an annual-prepay lane, or an
  // overlapping term below) makes the prepay option unsellable — but a
  // residential bait program still owes its per-series setup and this page
  // is its disclosure rail (codex #3591 r66 P1: the lane may cover an
  // unrelated service such as palm injection). The rodent exception keeps
  // the page with the prepay option suppressed; everything else stays
  // card-only.
  let prepayUnavailable = false;
  const lane = resolveBillingLane(customer);
  if (lane.mode === 'monthly_membership' || lane.mode === 'annual_prepay') {
    if (serviceKey !== 'rodent_bait') return null;
    prepayUnavailable = true;
  }

  const isRecurring = !!visit.is_recurring || !!visit.recurring_pattern;
  if (!isRecurring) {
    return { mode: 'one_time', perVisit: cents(perVisit), selected: request?.selected_plan || null };
  }

  const pattern = normalizedPattern(visit);
  const visitsPerYear = visitsPerYearForCadence(pattern);
  const coverageCadence = prepayCoverageCadenceForPattern(pattern);
  if (!pattern || !visitsPerYear || !coverageCadence) return null;

  const planClass = PLAN_CLASS_BY_SERVICE_KEY[serviceKey] || null;
  if (!planClass) return null;

  // An existing overlapping term (any coverage-holding status) means
  // prepay is not sellable here — hide the whole choice rather than
  // render an option the mint would 409. The request's OWN pending term
  // (minted by an earlier prepay selection on this same link) is
  // excluded: it must not hide the plan context on the prepay_selected
  // page or block the customer switching back to per-application.
  const today = etDateString();
  let overlapQuery = db('annual_prepay_terms')
    .where({ customer_id: visit.customer_id })
    .where(overlapStatusClause());
  if (request?.annual_prepay_term_id) {
    overlapQuery = overlapQuery.whereNot('id', request.annual_prepay_term_id);
  }
  const overlapping = await overlapQuery
    .orderBy('term_end', 'desc')
    .first('id', 'term_end');
  const overlapEnd = overlapping ? callBookingDateOnly(overlapping.term_end) : null;
  if (overlapEnd && today <= overlapEnd) {
    if (serviceKey !== 'rodent_bait') return null;
    prepayUnavailable = true;
  }

  // Direct (non-estimate) rodent bait series: the non-member $99 setup is
  // assessed here too, not only at estimate conversion (codex #3591 r9 P1).
  // "Member" = any OTHER qualifying recurring service already on the
  // account (rodent never self-waives). Live constant (db-synced); zero =
  // fee disabled. Lookup failures propagate → card-only page (fail closed).
  let unwaivedSetupFee = 0;
  if (serviceKey === 'rodent_bait') {
    unwaivedSetupFee = await resolveDirectRodentSetupObligation(db, visit);
    // Consume the DISCLOSED setup (accepted_setup_fee, stamped at render —
    // codex #3591 r15 P1): never above what the customer saw. A row without
    // a stamp (first render, or pre-column rows) prices live.
    const frozenSetupFee = request?.accepted_setup_fee != null ? Number(request.accepted_setup_fee) : NaN;
    if (unwaivedSetupFee > 0) {
      if (Number.isFinite(frozenSetupFee) && frozenSetupFee >= 0) {
        unwaivedSetupFee = Math.min(unwaivedSetupFee, frozenSetupFee);
      } else if (consumeDisclosure) {
        // No stamp at selection = never disclosed → never billed. Only a
        // stamped accepted_setup_fee authorizes the fee.
        unwaivedSetupFee = 0;
      }
    }
  }
  const pricing = computeSeriesPrepayPricing({ perVisit, visitsPerYear, planClass, unwaivedSetupFee });

  return {
    mode: 'recurring',
    planClass,
    perVisit: cents(perVisit),
    visitsPerYear,
    annualBase: pricing.annualBase,
    // null = prepay not sellable here (covered lane / overlapping term);
    // the page renders per-application + the setup disclosure only.
    prepay: prepayUnavailable ? null : pricing.prepay,
    setupFee: pricing.setupFee,
    selected: request?.selected_plan || null,
  };
}

/**
 * Derive the plan context for a pending secure-card request. Returns null
 * whenever the lane is dark or ANY input is unsound — the caller renders
 * today's card-only page. Never throws (failures also collapse to null) —
 * callers that must tell a FAILURE apart from null-by-policy use
 * deriveSecurePlanContext directly.
 */
async function buildSecurePlanContext({ request, visitId, consumeDisclosure = false }) {
  try {
    return await deriveSecurePlanContext({ request, visitId, consumeDisclosure });
  } catch (err) {
    logger.warn(`[secure-plans] plan context failed for request ${request?.id || `(send-time probe, visit ${visitId})`}: ${err.message} — rendering card-only`);
    return null;
  }
}

// The prepaySelected page state: a returning visitor who already chose
// prepay. Live unpaid invoice → hand back the pay link; settled invoice →
// the visit is covered, render secured. Returns null when the request has
// no prepay selection (caller proceeds normally).
async function prepaySelectionState(request) {
  try {
    if (!isEnabled('securePlanChoice')) return null;
    if (request?.selected_plan !== 'prepay_annual' || !request.prepay_invoice_id) return null;
    const invoice = await db('invoices')
      .where({ id: request.prepay_invoice_id })
      .first('id', 'token', 'status');
    // Office voided/cancelled/refunded it — the plan choice reopens.
    if (!invoice || TERMINAL_INVOICE_STATUSES.includes(invoice.status)) return null;
    if (['paid', 'prepaid'].includes(invoice.status)) return { state: 'secured' };
    return { state: 'prepay_selected', payUrl: portalUrl(`/pay/${invoice.token}`) };
  } catch (err) {
    logger.warn(`[secure-plans] prepay selection state failed for request ${request?.id}: ${err.message}`);
    return null;
  }
}

function fail(code) {
  const err = new Error(code);
  err.code = code;
  return err;
}

// The setup a SELECTION may bill, read under the request-row lock (codex
// #3591 r31 P1): the context was derived from an unlocked snapshot, and a
// concurrent render in another tab can lower accepted_setup_fee (fee cut, or
// a waiver the customer just earned) between that read and the stamp/mint.
// Only an UNWAIVED setup (waivedWithPrepay === false — the one figure the
// render stamp tracks) is clamped; NULL under the lock = never disclosed = 0.
async function lockedDisclosedSetupAmount(trx, request, setupFee) {
  if (!setupFee || setupFee.waivedWithPrepay !== false || !(Number(setupFee.amount) > 0)) return null;
  const row = await trx('appointment_card_requests')
    .where({ id: request.id })
    .forUpdate()
    .first('accepted_setup_fee');
  const frozen = row && row.accepted_setup_fee != null ? Number(row.accepted_setup_fee) : NaN;
  if (!Number.isFinite(frozen) || frozen < 0) return 0;
  return cents(Math.min(Number(setupFee.amount), frozen));
}

/**
 * Record the customer's plan selection. Returns:
 *   { ok:true, plan:'per_application' }                — proceed to card capture
 *   { ok:true, plan:'prepay_annual', payUrl }          — redirect to /pay
 * Throws err.code ∈ { gate_off, not_found, invalid_plan, already_secured,
 * no_longer_needed, plan_unavailable, prepay_overlap, selection_conflict }.
 * All amounts are re-derived server-side — the client sends only the plan.
 */
async function selectSecurePlan({ token, plan }) {
  if (!isEnabled('securePlanChoice')) throw fail('gate_off');
  if (!['per_application', 'prepay_annual'].includes(plan)) throw fail('invalid_plan');

  const request = await db('appointment_card_requests').where({ token }).first();
  if (!request) throw fail('not_found');
  if (request.status === 'completed' || request.status === 'satisfied') throw fail('already_secured');
  if (request.status !== 'pending') throw fail('selection_conflict');

  // Same liveness + payer re-checks the capture completion runs — the
  // office can cancel/reschedule or attach a third-party payer between
  // page load and selection. Payer lookup failure refuses (fail toward
  // not billing the wrong party).
  const visit = await loadPlanVisit(request.scheduled_service_id);
  const dateOnly = visit ? callBookingDateOnly(visit.scheduled_date) : null;
  if (!visit
    || !LIVE_VISIT_STATUSES.includes(visit.status)
    || (dateOnly && dateOnly < etDateString(new Date()))) {
    throw fail('no_longer_needed');
  }
  const PayerService = require('./payer');
  const resolved = await PayerService.resolveForInvoice({
    customerId: String(request.customer_id),
    scheduledServiceId: String(request.scheduled_service_id),
    throwOnError: true,
  });
  if (resolved?.payerId) throw fail('no_longer_needed');

  const context = await buildSecurePlanContext({ request, visitId: visit.id, consumeDisclosure: true });
  if (!context) throw fail('plan_unavailable');
  if (plan === 'prepay_annual' && !context.prepay) throw fail('plan_unavailable');

  if (plan === 'per_application') {
    if (context.mode !== 'recurring') throw fail('plan_unavailable');
    // Switching FROM an earlier prepay selection: retire that selection's
    // artifacts first. A settled prepay invoice means the year is already
    // covered (nothing to switch); an unpaid one is OUR OWN never-sent
    // draft — void it through the canonical money-guarded path
    // (InvoiceService.voidInvoice cancels any live PI and its own
    // annual-prepay sync cancels the payment_pending term), then release
    // the request's anchors so a later prepay re-selection can mint fresh.
    if (request.selected_plan === 'prepay_annual' && request.prepay_invoice_id) {
      const prior = await db('invoices')
        .where({ id: request.prepay_invoice_id })
        .first('id', 'status');
      if (prior && ['paid', 'prepaid'].includes(prior.status)) throw fail('already_secured');
      if (prior && !TERMINAL_INVOICE_STATUSES.includes(prior.status)) {
        try {
          await require('./invoice').voidInvoice(prior.id);
        } catch (err) {
          // Money guard refused (payment in flight / recorded) — the
          // customer is mid-payment in another tab; don't switch under it.
          logger.warn(`[secure-plans] prepay→per_application switch blocked for request ${request.id}: ${err.message}`);
          throw fail('selection_conflict');
        }
      }
      await db('appointment_card_requests')
        .where({ id: request.id, prepay_invoice_id: request.prepay_invoice_id })
        .update({ prepay_invoice_id: null, annual_prepay_term_id: null, updated_at: new Date() });
    }
    // Selection + setup-fee obligation land in ONE transaction (Codex
    // #2980 r4): a durable per_application selection without its fee stamp
    // would let the first completion auto-charge WITHOUT the disclosed $99
    // — either both persist or neither does, and a failed fee stamp rolls
    // the selection back to retryable.
    const stamp = new Date();
    let casLost = false;
    await db.transaction(async (trx) => {
      // Lock + re-read the disclosure BEFORE the CAS (codex #3591 r31 P1).
      const lockedSetup = await lockedDisclosedSetupAmount(trx, request, context.setupFee);
      // …and re-derive the CURRENT obligation under the transaction (codex
      // #3591 r51 local P0): a qualifying family added between render and
      // selection waives the fee — never stamp above what is owed NOW,
      // capped by the disclosure. Failure refuses (retryable), never a
      // silent stamp.
      let owedNowCap = null;
      if (context.setupFee && context.setupFee.waivedWithPrepay === false) {
        try {
          owedNowCap = await module.exports.resolveDirectRodentSetupObligation(trx, { id: visit.id });
        } catch (owedErr) {
          logger.warn(`[secure-plans] in-trx setup re-derivation failed for visit ${visit.id}: ${owedErr.message}`);
          throw fail('plan_unavailable');
        }
      }
      const stamped = await trx('appointment_card_requests')
        .where({ id: request.id, status: 'pending' })
        .update({ selected_plan: 'per_application', plan_selected_at: stamp, updated_at: stamp });
      if (stamped !== 1) {
        // The CAS lost (Codex #2980 r2): /complete raced this selection and
        // the request is no longer pending — stamping the fee anyway would
        // bill a $99 no durable selection authorizes.
        casLost = true;
        return;
      }
      // Owner decision 2026-07-24: the per-application choice on a solo
      // pest/mosquito series owes the $99 setup fee on the FIRST completion
      // invoice. Snapshot the amount now (billed fee === disclosed fee) on
      // the SERIES PARENT — the completion mint's atomic claim always reads
      // the parent, so a child-attached link must not stamp the child.
      // Guarded so a re-selection never re-stamps a consumed fee.
      let setupToStamp = lockedSetup == null ? (context.setupFee ? context.setupFee.amount : 0) : lockedSetup;
      if (owedNowCap != null) setupToStamp = Math.min(setupToStamp, owedNowCap);
      if (context.setupFee && setupToStamp > 0) {
        await trx('scheduled_services')
          .where({ id: seriesAnchorId(visit) })
          .whereNull('pending_setup_fee')
          .update({ pending_setup_fee: setupToStamp, updated_at: stamp });
      }
    });
    if (casLost) {
      const fresh = await db('appointment_card_requests')
        .where({ id: request.id })
        .first('status');
      if (fresh?.status === 'completed' || fresh?.status === 'satisfied') throw fail('already_secured');
      throw fail('selection_conflict');
    }
    return { ok: true, plan: 'per_application' };
  }

  // prepay_annual — idempotency anchor first: a double-submit (or a
  // returning visitor re-posting) gets the SAME pay link, never a second
  // invoice. An anchor pointing at a VOID invoice (office voided it, or a
  // per-application switch retired it) is stale — release it (guarded CAS
  // on the exact stale id) so prepay can be re-selected; otherwise the
  // stamp's whereNull guard below would refuse forever.
  if (request.prepay_invoice_id) {
    const existing = await db('invoices')
      .where({ id: request.prepay_invoice_id })
      .first('id', 'token', 'status');
    if (existing && !TERMINAL_INVOICE_STATUSES.includes(existing.status)) {
      return { ok: true, plan: 'prepay_annual', payUrl: portalUrl(`/pay/${existing.token}`) };
    }
    await db('appointment_card_requests')
      .where({ id: request.id, prepay_invoice_id: request.prepay_invoice_id })
      .update({ prepay_invoice_id: null, annual_prepay_term_id: null, updated_at: new Date() });
    request.prepay_invoice_id = null;
    request.annual_prepay_term_id = null;
  }
  if (context.mode !== 'recurring') throw fail('plan_unavailable');

  const today = etDateString();
  const anchorId = seriesAnchorId(visit);
  const InvoiceService = require('./invoice');
  const AnnualPrepayRenewals = require('./annual-prepay-renewals');
  const { lockAndAssertNoAnnualPrepayOverlap } = require('../routes/admin-customers')._private;

  // Coverage identity is CATALOG-first (codex #3591 r48 local P0): a stale
  // "Pest Control" label on a row linked to the bait program must not seed
  // pest-labeled coverage — the renewals seeding and the coverage matchers
  // key on this string. Unlinked legacy rows keep their label; a failed
  // catalog read fails closed to the label (the mint's own re-derivation
  // still guards the money).
  let coverageServiceType = visit.service_type;
  if (visit.service_id) {
    // STRICT for linked visits (codex #3591 r52 local P1): a swallowed
    // catalog failure would mint the term for a stale label's family and
    // renewals would seed/match the wrong coverage. Fail closed —
    // plan_unavailable, the customer retries.
    let catalogRow;
    try {
      catalogRow = await db('services').where({ id: visit.service_id }).first('name');
    } catch (catalogErr) {
      logger.warn(`[secure-plans] catalog name read failed for linked visit ${visit.id} — refusing the mint: ${catalogErr.message}`);
      throw fail('plan_unavailable');
    }
    if (!catalogRow?.name) throw fail('plan_unavailable');
    coverageServiceType = catalogRow.name;
  }
  const visitCount = context.visitsPerYear;
  // Coverage money (sliced across the prepaid visits) vs. the unwaived
  // one-time setup that rides the same invoice as its own line — the
  // invoice total the customer saw is the sum (codex #3591 r9 P1).
  const coverageAmount = cents(context.prepay.coverageTotal ?? context.prepay.total);
  let setupAmount = context.setupFee && context.setupFee.waivedWithPrepay === false
    ? cents(context.setupFee.amount)
    : 0;
  let amount = cents(coverageAmount + setupAmount);

  let payToken = null;
  try {
    await db.transaction(async (trx) => {
      // The setup line bills what the LOCKED disclosure row authorizes
      // (codex #3591 r31 P1) — re-read here, not from the unlocked snapshot.
      const lockedSetup = await lockedDisclosedSetupAmount(trx, request, context.setupFee);
      if (lockedSetup != null) {
        setupAmount = lockedSetup;
      }
      // Re-derive under the transaction (codex #3591 r51 local P0): a
      // family added since render waives the fee — bill min(disclosed,
      // owed-now); failure refuses rather than minting a stale fee.
      if (setupAmount > 0) {
        let owedNow;
        try {
          owedNow = await module.exports.resolveDirectRodentSetupObligation(trx, { id: visit.id });
        } catch (owedErr) {
          logger.warn(`[secure-plans] in-trx setup re-derivation failed for visit ${visit.id}: ${owedErr.message}`);
          throw fail('plan_unavailable');
        }
        setupAmount = cents(Math.min(setupAmount, Math.max(0, Number(owedNow) || 0)));
      }
      amount = cents(coverageAmount + setupAmount);
      // Term starts at the first UPCOMING live visit of the series —
      // coverage must span the visits the customer is prepaying, not the
      // send date. Anchored on the series PARENT and derived INSIDE the
      // transaction (Codex #2980 r2): a snapshot taken outside could
      // mis-anchor the paid window when the office cancels/reschedules the
      // earliest child mid-selection.
      const seriesRows = await trx('scheduled_services')
        .where(function series() {
          this.where({ id: anchorId }).orWhere({ recurring_parent_id: anchorId });
        })
        .whereIn('status', LIVE_VISIT_STATUSES)
        .select('scheduled_date');
      const upcoming = seriesRows
        .map((r) => callBookingDateOnly(r.scheduled_date))
        .filter((d) => d && d >= today)
        .sort();
      const termStart = upcoming[0] || null;
      if (!termStart) throw fail('no_longer_needed');

      // Advisory lock + in-transaction overlap re-check — two tabs (or a
      // concurrent office mint) collapse to one term (mirrors the
      // Customer360 mint and the estimate accept).
      await lockAndAssertNoAnnualPrepayOverlap(
        trx, visit.customer_id, termStart, false,
        'Customer already has an annual prepay term through',
      );

      // Revalidate IMMEDIATELY before minting (Codex #2980): the liveness
      // and payer checks above ran outside this transaction — an office
      // cancel/reschedule or a payer attach in that window must abort the
      // mint, not produce a payable annual invoice for a dead or
      // third-party-billed visit. The visit row is read FOR UPDATE and the
      // payer resolve rides THIS transaction (database: trx — Codex #2980
      // r3: the global-db default would let a payer attach slip between
      // this refusal check and the mint), so a concurrent payer attach on
      // the locked row serializes behind the commit. Payer lookup failure
      // refuses (fail toward not billing the wrong party).
      const liveVisit = await trx('scheduled_services')
        .where({ id: visit.id })
        .forUpdate()
        .first('id', 'status', 'scheduled_date');
      // Also lock the CUSTOMER row (Codex #2980 r4): resolveForInvoice
      // falls back to customers.payer_id, which staff can change from
      // Customer360 — a default-payer attach must serialize behind this
      // mint, not slip between the refusal check and the invoice insert.
      await trx('customers')
        .where({ id: visit.customer_id })
        .forUpdate()
        .first('id');
      const liveDate = liveVisit ? callBookingDateOnly(liveVisit.scheduled_date) : null;
      if (!liveVisit
        || !LIVE_VISIT_STATUSES.includes(liveVisit.status)
        || (liveDate && liveDate < today)) {
        throw fail('no_longer_needed');
      }
      let payerNow = null;
      try {
        payerNow = await PayerService.resolveForInvoice({
          database: trx,
          customerId: String(request.customer_id),
          scheduledServiceId: String(request.scheduled_service_id),
          throwOnError: true,
        });
      } catch (payerErr) {
        logger.warn(`[secure-plans] in-transaction payer re-check failed — refusing mint for request ${request.id}: ${payerErr.message}`);
        throw fail('no_longer_needed');
      }
      if (payerNow?.payerId) throw fail('no_longer_needed');

      const invoice = await InvoiceService.create({
        database: trx,
        customerId: visit.customer_id,
        title: `${coverageServiceType} - Annual Prepay`,
        lineItems: [{
          description: `${coverageServiceType} - ${visitCount} prepaid application${visitCount === 1 ? '' : 's'}`,
          quantity: 1,
          unit_price: coverageAmount,
          category: 'Annual prepay',
        },
        ...(setupAmount > 0 ? [{
          description: 'Bait Station Setup — one-time setup fee',
          quantity: 1,
          unit_price: setupAmount,
          category: 'Setup fee',
        }] : [])],
        // Deliberately does NOT match the accept-minted marker regex — the
        // dispatch auto-charge allowance keys accept invoices on that text.
        notes: `Annual prepay selected by the customer from their secure appointment link (visit ${visit.id}).`,
        dueDate: today,
      });
      // The page showed a tax-free residential total; a total that came
      // back different (payer accrual, unexpected tax) must not reach the
      // customer as a surprise — abort, fail toward the card-only page.
      if (cents(invoice.total) !== cents(amount)) {
        throw fail('plan_unavailable');
      }

      const term = await AnnualPrepayRenewals.createTermForAnnualPrepay({
        customerId: visit.customer_id,
        prepayInvoiceId: invoice.id,
        planLabel: `${coverageServiceType} Annual Prepay`,
        monthlyRate: cents(coverageAmount / 12),
        // Coverage basis excludes the setup share (renewals slice this
        // across covered visits — setup is not per-visit coverage money).
        prepayAmount: cents(Number(invoice.total) - setupAmount),
        termStart,
        coverageServiceType,
        coverageVisitCount: visitCount,
        coverageCadence: prepayCoverageCadenceForPattern(normalizedPattern(visit)),
        conn: trx,
      });
      if (!term) throw new Error('annual prepay term could not be created');

      // The request row is the idempotency anchor: only the FIRST selection
      // lands; a concurrent winner makes this update match 0 rows and the
      // whole mint rolls back (the loser re-reads the winner's link below).
      const stamped = await trx('appointment_card_requests')
        .where({ id: request.id, status: 'pending' })
        .whereNull('prepay_invoice_id')
        .update({
          selected_plan: 'prepay_annual',
          plan_selected_at: new Date(),
          prepay_invoice_id: invoice.id,
          annual_prepay_term_id: term.id,
          updated_at: new Date(),
        });
      if (stamped !== 1) throw fail('selection_conflict');

      // Retire the per-application claim on the series parent through the
      // SAME guarded helper the on-site switch runs (codex #3591 r40 P1):
      // the parent is read FOR UPDATE, a NEGATIVE stamp (the technician's
      // completion mid-claim on a sibling child) refuses the selection
      // instead of erasing the claim under it, and only a positive stamp is
      // CAS-cleared — prepay waives the WaveGuard class (nothing ledgered)
      // and bills the rodent class as its own line (ledgered against this
      // prepay so a later void/refund re-stamps it; codex #3591 r34 P1).
      try {
        await retireDirectSetupClaimForPrepay(trx, { anchorId, invoiceId: invoice.id, amount: setupAmount });
      } catch (retireErr) {
        if (retireErr.switchConflict) throw fail('selection_conflict');
        throw retireErr;
      }

      await trx('activity_log').insert({
        customer_id: visit.customer_id,
        action: 'annual_prepay_invoice_created',
        description: `Annual prepay invoice ${invoice.invoice_number} created from the customer's secure appointment link for ${coverageServiceType}: $${amount.toFixed(2)} covering ${visitCount} visit(s)`,
        metadata: JSON.stringify({
          invoice_id: invoice.id,
          invoice_number: invoice.invoice_number,
          annual_prepay_term_id: term.id,
          appointment_card_request_id: request.id,
          scheduled_service_id: visit.id,
          coverage_service_type: coverageServiceType,
          coverage_visit_count: visitCount,
          per_visit_amount: context.perVisit,
          setup_fee_amount: setupAmount,
          term_start: termStart,
          source: 'secure_plan_choice',
        }),
        created_at: new Date(),
      });

      payToken = invoice.token;
    });
  } catch (err) {
    if (err.annualPrepayOverlap) throw fail('prepay_overlap');
    if (err.code === 'selection_conflict') {
      // Concurrent winner — return their link instead of an error.
      const fresh = await db('appointment_card_requests')
        .where({ id: request.id })
        .first('prepay_invoice_id');
      if (fresh?.prepay_invoice_id) {
        const winner = await db('invoices')
          .where({ id: fresh.prepay_invoice_id })
          .first('token', 'status');
        if (winner && winner.status !== 'void') {
          return { ok: true, plan: 'prepay_annual', payUrl: portalUrl(`/pay/${winner.token}`) };
        }
      }
    }
    throw err;
  }

  logger.info(`[secure-plans] prepay invoice minted for visit ${visit.id} (request ${request.id})`);
  return { ok: true, plan: 'prepay_annual', payUrl: portalUrl(`/pay/${payToken}`) };
}

/**
 * Post-enrollment lane stamp (called from finishVerifiedSecureCapture after
 * Auto Pay enrollment succeeds, only when the customer explicitly chose
 * per-application on the plan page): the dispatch per-application
 * auto-charge is gated on customers.billing_mode === 'per_application'
 * (estimate accepts stamp it; office bookings never did), so without this
 * the page's "charged automatically after each completed service" promise
 * would silently degrade to invoice-on-complete. Conservative by
 * construction: only NULL/per_visit/one_time lanes are moved (the context
 * builder already refuses membership/annual-prepay customers), and an
 * established per_application_fee is never overwritten.
 */
// Returns true when the lane is correct after the call (stamped now,
// already right, or deliberately untouched), false on a write failure —
// the caller decides whether that blocks (capture completion refuses and
// stays retryable rather than stranding the customer off the promised
// lane behind a completed row; Codex #2980 r3). Idempotent.
async function applyPerApplicationLaneStamp({ customerId, scheduledServiceId }) {
  try {
    if (!isEnabled('securePlanChoice')) return true;
    // The stamp is a value-guarded CAS on the billing_mode that was just
    // validated: if staff moves the customer onto a membership or
    // annual-prepay lane between the read and the write (a stale completion
    // retry is exactly that window), the guarded update loses, the loop
    // re-reads, and the lane check refuses instead of overwriting the newer
    // billing choice (Codex #2980 r5).
    for (let attempt = 0; attempt < 3; attempt++) {
      const customer = await db('customers')
        .where({ id: customerId })
        .first('id', 'billing_mode', 'waveguard_tier', 'monthly_rate', 'per_application_fee');
      if (!customer) return true;
      const lane = resolveBillingLane(customer);
      if (lane.mode === 'monthly_membership' || lane.mode === 'annual_prepay'
        || customer.billing_mode === 'per_application') return true;
      const visit = await db('scheduled_services')
        .where({ id: scheduledServiceId })
        .first('estimated_price');
      const perVisit = visit?.estimated_price != null ? Number(visit.estimated_price) : null;
      let stampQuery = db('customers').where({ id: customerId });
      stampQuery = customer.billing_mode == null
        ? stampQuery.whereNull('billing_mode')
        : stampQuery.where({ billing_mode: customer.billing_mode });
      const stamped = await stampQuery.update({
        billing_mode: 'per_application',
        ...(customer.per_application_fee == null && perVisit > 0
          ? { per_application_fee: perVisit }
          : {}),
        updated_at: new Date(),
      });
      if (stamped === 1) {
        logger.info(`[secure-plans] customer ${customerId} moved to per_application lane (secure plan choice)`);
        return true;
      }
      logger.info(`[secure-plans] per-application lane stamp lost the CAS for customer ${customerId} (billing_mode changed concurrently); re-reading`);
    }
    logger.warn(`[secure-plans] per-application lane stamp gave up after repeated CAS losses for customer ${customerId}`);
    return false;
  } catch (err) {
    logger.warn(`[secure-plans] per-application lane stamp failed for customer ${customerId}: ${err.message}`);
    return false;
  }
}

module.exports = {
  recordSetupFeeClaimForInvoice,
  settledSetupClaimForInvoice,
  settledSetupClaimForEstimate,
  estimateSetupCarriedElsewhere,
  seriesCanStillConsume,
  stampedSetupForVisit,
  anchorSetupFeeClaim,
  liveAnchorlessCoverageSetupClaim,
  retireDirectSetupClaimForPrepay,
  retirePrepayOnBookSetupClaim,
  findDirectRodentSetupObligationForCoverage,
  retireCoverageOnlySetupClaim,
  isRodentBaitProgramKey,
  buildSecurePlanContext,
  deriveSecurePlanContext,
  prepaySelectionState,
  selectSecurePlan,
  applyPerApplicationLaneStamp,
  // Shared with the admin booking modal's prepay preview — one incentive
  // formula and one service→incentive-class whitelist across both lanes.
  computeSeriesPrepayPricing,
  resolveDirectRodentSetupObligation,
  authoritativeServiceKey,
  PLAN_CLASS_BY_SERVICE_KEY,
  // Read-side (lock-free) overlap probe, shared rather than re-mirrored: a
  // third copy of the coverage-holding status list is a drift bug waiting
  // to happen. The LOCKING assert still lives in admin-customers._private.
  annualPrepayOverlapStatusClause: overlapStatusClause,
  _test: { normalizedPattern, PLAN_CLASS_BY_SERVICE_KEY, overlapStatusClause },
};
