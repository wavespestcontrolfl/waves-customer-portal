// ============================================================
// setup-fee-obligation.js
//
// Detects an accepted pay-per-application estimate whose WaveGuard setup
// fee (and with it the whole acceptance invoice — setup + first
// application) was NEVER minted. The standard verbal "Mark Won" accept
// skips the acceptance invoice by design (estimate-manual-acceptance:
// scheduling and invoicing stay under operator control), and a public
// accept whose invoice mint failed inside the converter's non-blocking
// try lands in the same state — so the first visit would auto-bill only
// the per-application price and the one-time setup fee silently
// evaporates. Completion billing consults this detector to PARK that
// first visit for manual billing instead (owner ruling 2026-08-24, same
// shape as the canceled-setup-fee parking from #3474), and the
// scheduling surfaces consult it to warn before completion.
//
// "Owed" here means ALL of:
//   - the estimate exists, is accepted, and the customer actually agreed
//     to the fee: the persisted send-snapshot shows it, or — absent
//     affirmative snapshot evidence (fee-less bundles are stale shapes
//     repaired at view time, never proof) — the accept postdates the end
//     of the rule's go-live day (older accepts never promised the fee);
//   - the accepted recurring mix actually carries the fee per the ONE
//     authority (estimate-converter.shouldIncludeWaveGuardSetupFeeForRecurring
//     — existing-customer waiver, operator waiver, bundle rule, solo
//     pest/mosquito rule all live there);
//   - it is not invoice-mode (bill_by_invoice bills through its own
//     proposal invoice) and holds no LIVE annual-prepay term (prepay
//     waives the fee; a cancelled term returned the customer to
//     per-application billing and does not suppress);
//   - the converter actually ran for it (activity_log
//     'estimate_converted' row) — the provenance that the acceptance
//     reached the invoicing decision at all;
//   - NO LIVE invoice stamped "accepted estimate #<id>" exists, and no
//     dead (void/refunded/canceled) stamped invoice that resolves it
//     exists. Resolving = refunded in ANY attachment state (the fee was
//     collected then deliberately refunded — an operator money action,
//     and a bounced refund restores the row to paid; never instruct a
//     re-bill), or canceled/cancelled + a positive setup-fee line +
//     PROVABLY discoverable by #3474's canceledSetupFee lane (attached
//     to a same-estimate visit on the completing visit's scheduled
//     date). Attachment alone proves nothing:
//     findFirstApplicationInvoiceForEstimateService excludes 'void'
//     outright and only joins same-date siblings, so a void attached
//     invoice, or a canceled one on a replaced-and-moved visit, leaves
//     the fee genuinely unbilled and the obligation survives it.
// ============================================================

const db = require('../models/db');

// The solo-plan setup-fee rule went live the EVENING of 2026-07-10 (see
// pricingBundleMissingRequiredSetupFee in estimate-public). Persisted
// acceptance-time display evidence outranks any date: the send snapshot's
// pricing bundle records exactly what the customer was shown. Only when
// no snapshot exists does the date decide, and then the cutoff is the END
// of 2026-07-10 ET — a midnight-UTC calendar proxy would sweep in
// same-day accepts whose estimate predated the evening deploy and demand
// an unagreed $99 (Codex P0, pre-push round 3). Fail-safe direction:
// without display evidence, an ambiguous same-day accept is OUT of scope.
const SETUP_FEE_RULE_SAFE_CUTOFF = '2026-07-11T04:00:00Z'; // 2026-07-11 00:00 ET

// Did the estimate the customer accepted actually SHOW the setup fee?
// Reads the persisted send-snapshot pricing bundle using the same
// service-key recognizers as pricingBundleMissingRequiredSetupFee.
// Returns 'shown' on affirmative evidence, 'feeless' when a bundle
// exists with no fee, null when there is no bundle at all. 'feeless' is
// deliberately NOT no-fee proof for a PUBLIC accept — a fee-less bundle
// on a fee-due mix is exactly the STALE shape estimate-public
// invalidates and recomputes WITH the fee at view time (Codex P0,
// pre-push round 4) — but a MANUAL Mark Won accept involves no page
// view, so there the fee-less snapshot IS the last pricing the customer
// saw (Codex P0, pre-push round 15).
// Returns { evidence: 'shown'|'feeless'|null, amount: number|null } —
// the amount is the FROZEN fee the customer actually accepted (a legacy
// or discounted snapshot may show something other than the current
// constant; the obligation must demand the accepted price, and changing
// WAVEGUARD_SETUP_FEE must never retro-edit outstanding obligations —
// Codex PR r4 P1).
function snapshotShowsSetupFee(estimateData) {
  const bundle = estimateData?.sendSnapshot?.pricingBundle;
  if (!bundle || typeof bundle !== 'object') return { evidence: null, amount: null };
  // Legacy frozen rows carry no normalized service key ("WaveGuard
  // Membership Setup", price 99) — the SAME textual recognizer the public
  // pricing path uses (isWaveGuardSetupOneTimeItem) must count them as
  // fee-shown, or a post-cutoff manual accept of a legacy snapshot would
  // read 'feeless' and disable the guard (Codex PR r3 P1).
  let isLegacySetupItem = () => false;
  let legacyAmount = null;
  try {
    ({
      isWaveGuardSetupOneTimeItem: isLegacySetupItem,
      oneTimeItemAmount: legacyAmount,
    } = require('../routes/estimate-public'));
  } catch { /* route unavailable in some harnesses — service-key check stands */ }
  const isSetupRow = (row) => row?.service === 'waveguard_setup' || isLegacySetupItem(row || {});
  // Amount precedence mirrors the authoritative row parser
  // (oneTimeItemAmount): DISCOUNTED fields outrank the original price —
  // the obligation must demand what the customer actually saw, never the
  // pre-discount figure (Codex PR r5 P1).
  // Zero is AUTHORITATIVE (Codex P0): a fully discounted/legacy $0 fee
  // row means the customer agreed to zero — never fall back to the
  // current constant for a row that exists. null = amount unreadable.
  const rowAmount = (row) => {
    const n = typeof legacyAmount === 'function'
      ? legacyAmount(row || {})
      : Number(row?.priceAfterDiscount ?? row?.totalAfterDiscount ?? row?.amount ?? row?.price ?? row?.total ?? row?.unit_price);
    return Number.isFinite(n) ? Math.max(0, Math.round(n * 100) / 100) : null;
  };
  const hit = (Array.isArray(bundle.firstVisitFees) ? bundle.firstVisitFees : []).find(isSetupRow)
    || (Array.isArray(bundle.oneTimeBreakdown?.items) ? bundle.oneTimeBreakdown.items : []).find(isSetupRow)
    || (bundle.setupFee && isSetupRow(bundle.setupFee) ? bundle.setupFee : null);
  if (hit) return { evidence: 'shown', amount: rowAmount(hit) };
  return { evidence: 'feeless', amount: null };
}

function parseEstimateData(raw) {
  if (typeof raw === 'string') {
    try { return JSON.parse(raw) || {}; } catch { return {}; }
  }
  return raw || {};
}

// Plan membership by DURABLE recurring identity, never by service-type
// text: detectServiceLine only names a report category and defaults
// unknown types to 'pest', so a same-category one-time add-on (a pest
// corrective beside recurring pest service) would pass a text check
// (Codex P0, pre-push round 2). The converter/seeder stamp every billed
// plan row — parent AND children — is_recurring=true; that flag alone is
// the discriminator (Codex PR r3 P1): a non-recurring BOOSTER carries
// recurring_parent_id while explicitly billing its own one-off price
// (admin-schedule booster lane), so a parent link must never classify a
// row as a plan application. The obligation belongs to plan-application
// visits only: a one-time add-on/booster sourced from the same estimate
// must neither trigger the completion hold (suppressing its mint would
// drop its own charge) nor satisfy the first-visit check.
function isPlanApplicationRow(row) {
  return !!(row && row.is_recurring);
}

// Lanes whose first visit is covered without a per-visit completion invoice
// (the 8AM dues cron / the prepaid term pay for it). The completion mint never
// runs there, so a setup-fee stamp on such a customer's series can never be
// consumed — it is not a deferral, it is a stranded claim.
const DUES_COVERED_LANES = new Set(['monthly_membership', 'annual_prepay']);

// The dispatch alert that is the durable owed-fee record of a setup fee parked
// for the office to bill by hand.
const SETUP_FEE_OFFICE_BILLING_ALERT = 'setup_fee_office_billing';

// True when this estimate's own series carries the setup fee as a durable
// per-series claim: ANY live stamp on a series root of this estimate (the
// stamp IS the fee — a stamp at another amount is still the figure the
// completion mint bills, so calling the obligation "owed" on a cents mismatch
// would park the visit for a manual bill AND let the stamp auto-bill on top of
// it later). A NEGATIVE stamp is a completion's in-progress marker and always
// counts (resume mints or heals it); a positive stamp counts when its series
// can still consume it AND the customer's lane runs completion mints. The
// immutable setup_fee_claims record of a non-dead invoice on such a series
// (the claim consumed by the first performed completion; a stamp never
// outlives the mint, the record does) counts at whatever amount it billed. Query
// failures propagate: the caller fails CLOSED exactly as it does for the
// invoice reads below.
//
// A setup_fee_office_billing alert (open OR resolved) naming one of this
// estimate's series also counts: the fee was PARKED for the office to bill by
// hand (parkSetupFeeStampForOffice) and the stamp is cleared, so the office
// owns the fee and nothing may park a second manual bill or auto-bill it.
//
// Returns { covers, unconsumableStamps }: live positive stamps this estimate's
// series carries that NO completion can ever consume (dues-covered lane / a
// series with no live consumer). When the obligation is then owed the
// completion parks these for the office (never clears them to nothing), so the
// fee is billed once, by hand.
const rows = (value) => (Array.isArray(value) ? value : []);
// An invoice in these states collected nothing, so its claim proves nothing.
const UNCOLLECTED_INVOICE_STATUSES = new Set(['void', 'canceled', 'cancelled']);

// TRUE when the office already owns the setup fee of any of these series: a
// setup_fee_office_billing alert (open OR resolved: a resolved alert means the
// office billed or dismissed it) names one of them. The stamp is cleared when
// a fee is parked, so every reader that would otherwise re-derive the fee (the
// first-visit detector, the direct rodent obligation, a second series booked
// from the same estimate) must ask this first.
async function officeParkedSetupFeeSeries(conn, seriesIds) {
  const ids = rows(seriesIds).filter((id) => id != null).map(String);
  if (!ids.length) return false;
  const parked = await conn('dispatch_alerts')
    .where({ type: SETUP_FEE_OFFICE_BILLING_ALERT })
    .whereRaw(`payload->>'seriesId' IN (${ids.map(() => '?').join(', ')})`, ids)
    .first('id');
  return !!parked;
}

// The series an estimate's setup fee can live on: its own roots, plus the
// series PARENT of any appointment the accept adopted (source_estimate_id
// stays on that CHILD while the fee is stamped on its parent, which may belong
// to an older or unlinked series). Shared by the first-visit detector and the
// annual-prepay switch's waiver so both see the same stamps.
async function estimateSetupSeries(conn, estimate) {
  const scope = { source_estimate_id: estimate.id, customer_id: estimate.customer_id };
  const roots = rows(await conn('scheduled_services').where(scope).whereNull('recurring_parent_id')
    .select('id', 'status', 'pending_setup_fee'));
  const knownRootIds = new Set(roots.map((r) => String(r.id)));
  const adoptedParentIds = [...new Set(rows(await conn('scheduled_services').where(scope)
    .whereNotNull('recurring_parent_id').select('recurring_parent_id'))
    .map((c) => c.recurring_parent_id).filter((id) => id != null && !knownRootIds.has(String(id))))];
  const adoptedParents = adoptedParentIds.length
    ? rows(await conn('scheduled_services').whereIn('id', adoptedParentIds)
      .where({ customer_id: estimate.customer_id }).select('id', 'status', 'pending_setup_fee'))
    : [];
  return [...roots, ...adoptedParents].filter((r) => r && r.id != null);
}

const prepayWaivedMarker = (parentId, amount) => `[paf-setup-waived:${parentId}:${Number(amount).toFixed(2)}]`;
const prepayRestoredMarker = (parentId) => `[paf-setup-restored:${parentId}]`;

// Annual prepay waives the WaveGuard setup fee. When the on-site / plan switch
// replaces a pay-after-first-visit accept with a prepay, the setup fee that
// accept DEFERRED to the first visit (a stamp, no invoice) must be retired too,
// or the first prepaid completion parks it for a manual bill. Runs in the
// switch's transaction: locks each stamped series row, refuses (switchConflict)
// on a completion mid-mint (negative stamp), clears the stamp by exact value,
// and records what it waived on the prepay invoice so a later void/refund of
// that prepay can put it back (restoreWaivedDeferredSetupFeeForPrepay).
async function waiveDeferredSetupFeeForPrepay(trx, { estimateId, prepayInvoiceId }) {
  if (!estimateId || !prepayInvoiceId) return [];
  const estimate = await trx('estimates').where({ id: estimateId }).first('id', 'customer_id', 'estimate_data');
  if (!estimate || parseEstimateData(estimate.estimate_data).setupFeeDeferredToFirstVisit !== true) return [];
  const waived = [];
  for (const series of await estimateSetupSeries(trx, estimate)) {
    const row = await trx('scheduled_services').where({ id: series.id }).forUpdate().first('id', 'pending_setup_fee');
    const stamp = Number(row?.pending_setup_fee);
    if (!stamp) continue;
    if (stamp < 0) {
      const err = new Error('The setup fee is being billed by a completion in progress — retry in a moment');
      err.switchConflict = true;
      throw err;
    }
    const cleared = await trx('scheduled_services')
      .where({ id: row.id, pending_setup_fee: row.pending_setup_fee })
      .update({ pending_setup_fee: null, updated_at: new Date() });
    if (cleared === 1) waived.push({ parentId: row.id, amount: Math.round(stamp * 100) / 100 });
  }
  await appendPrepayMarkers(trx, prepayInvoiceId, waived.map((w) => prepayWaivedMarker(w.parentId, w.amount)));
  return waived;
}

// The waiver's history lives on the prepay invoice as an ordered marker list
// per series: [paf-setup-waived:<series>:<amount>] then, on a reversal,
// [paf-setup-restored:<series>] — the LAST marker for a series is its state.
// Returns { parentId -> { amount, state: 'waived' | 'restored' } }.
function prepayDeferredSetupState(notes) {
  const state = new Map();
  for (const m of String(notes || '').matchAll(/\[paf-setup-(waived|restored):([^:\]]+)(?::([0-9.]+))?\]/g)) {
    const [, kind, parentId, amount] = m;
    const prior = state.get(parentId);
    state.set(parentId, { state: kind, amount: amount != null ? Number(amount) : prior?.amount });
  }
  return state;
}

async function appendPrepayMarkers(conn, prepayInvoiceId, markers) {
  if (!markers.length) return;
  await conn('invoices').where({ id: prepayInvoiceId }).update({
    notes: conn.raw('concat(coalesce(notes, ?::text), ?::text)', ['', markers.map((m) => `\n${m}`).join('')]),
    updated_at: new Date(),
  });
}

// The reversal: the prepay that waived a deferred setup fee was voided or
// refunded (or lost a dispute), so the customer is back on pay-per-application
// and owes the fee with the first visit again. Re-stamps each series whose
// last state is 'waived' (CAS onto a NULL stamp) and records 'restored', so a
// second sync is a no-op and a fee a later completion billed is never re-armed.
async function restoreWaivedDeferredSetupFeeForPrepay(conn, prepayInvoiceId) {
  if (!prepayInvoiceId) return [];
  const prepay = await conn('invoices').where({ id: prepayInvoiceId }).first('id', 'notes');
  const restored = [];
  const markers = [];
  for (const [parentId, { state, amount }] of prepayDeferredSetupState(prepay?.notes)) {
    if (state !== 'waived' || !(amount > 0)) continue;
    const stamped = await conn('scheduled_services').where({ id: parentId }).whereNull('pending_setup_fee')
      .update({ pending_setup_fee: amount, updated_at: new Date() });
    markers.push(prepayRestoredMarker(parentId));
    if (stamped === 1) restored.push({ scheduledServiceId: parentId, amount });
  }
  await appendPrepayMarkers(conn, prepayInvoiceId, markers);
  return restored;
}

// The prepay REVIVED (re-paid, or a dispute won back) after its reversal put
// the deferred fee back: annual prepay waives it again. Clears each series
// whose last state is 'restored' (CAS on the exact restored amount; a stamp a
// completion is billing or already billed is left alone) and records 'waived'.
async function rewaiveDeferredSetupFeeForRevivedPrepay(conn, prepayInvoiceId) {
  if (!prepayInvoiceId) return [];
  const prepay = await conn('invoices').where({ id: prepayInvoiceId }).first('id', 'notes');
  const rewaived = [];
  const markers = [];
  for (const [parentId, { state, amount }] of prepayDeferredSetupState(prepay?.notes)) {
    if (state !== 'restored' || !(amount > 0)) continue;
    const cleared = await conn('scheduled_services').where({ id: parentId, pending_setup_fee: amount })
      .update({ pending_setup_fee: null, updated_at: new Date() });
    markers.push(prepayWaivedMarker(parentId, amount));
    if (cleared === 1) rewaived.push({ scheduledServiceId: parentId, amount });
  }
  await appendPrepayMarkers(conn, prepayInvoiceId, markers);
  return rewaived;
}

async function deferredSetupFeeCovers(conn, estimate, { completingVisitId = null, completingParentId = null } = {}) {
  const none = { covers: false, unconsumableStamps: [] };
  const covered = { covers: true, unconsumableStamps: [] };
  const rootRows = await estimateSetupSeries(conn, estimate);
  if (!rootRows.length) return none;
  const { seriesCanStillConsume } = require('./secure-appointment-plans');
  const { resolveBillingLane } = require('./billing-lane');
  const customerRow = await conn('customers').where({ id: estimate.customer_id })
    .first('billing_mode', 'waveguard_tier', 'monthly_rate');
  const lanePaysAtCompletion = !DUES_COVERED_LANES.has(resolveBillingLane(customerRow || {}).mode);
  // The completing visit is itself a live consumer of its own series: a
  // parent already completed (a declined first visit) with the claim still
  // queued is consumed by THIS child, whatever status the row reads mid-
  // completion.
  const completingIds = new Set([completingVisitId, completingParentId].filter(Boolean).map(String));
  const unconsumableStamps = [];
  for (const root of rootRows) {
    // No stamp, an unreadable one or a zero carries no fee (Number(null) is 0).
    const stamp = Number(root.pending_setup_fee);
    if (!stamp) continue;
    // A negative stamp is a completion mid-mint: deferred by definition.
    if (stamp < 0) return covered;
    if (lanePaysAtCompletion && (completingIds.has(String(root.id)) || await seriesCanStillConsume(conn, root))) return covered;
    unconsumableStamps.push({ parentId: root.id, rawAmount: root.pending_setup_fee, amount: Math.round(stamp * 100) / 100 });
  }
  const rootIds = rootRows.map((r) => r.id);
  // ANY positive claim amount counts, symmetric with the queued stamp above
  // (the claim IS the fee the completion mint billed, so a stamp at another
  // amount reads as billed after collection exactly as it read as deferred
  // before it). A REFUNDED claim-backed invoice still resolves the obligation
  // (no re-bill of a deliberately refunded fee); only a voided / canceled
  // invoice collected nothing.
  for (const claim of rows(await conn('setup_fee_claims').whereIn('scheduled_service_id', rootIds).select('invoice_id', 'amount'))) {
    if (!(Math.round(Number(claim.amount) * 100) > 0)) continue;
    const invoice = await conn('invoices').where({ id: claim.invoice_id }).first('status');
    if (invoice && !UNCOLLECTED_INVOICE_STATUSES.has(String(invoice.status || '').toLowerCase())) return covered;
  }
  if (await officeParkedSetupFeeSeries(conn, rootIds)) return covered;
  return { covers: false, unconsumableStamps };
}

// PARKS a live POSITIVE setup-fee stamp for the office, in the caller's
// transaction (owner ruling 2026-10-01). A setup fee that cannot ride the first
// visit's own completion invoice (a dues-covered lane, a closeout the packet
// hands to the office, a first visit that billed nothing) is never turned into
// a free-standing invoice - that skips the invoice rules (payer lock, NET-terms
// statements, ...). The stamp is cleared and ONE durable owed-fee record is
// written: a setup_fee_office_billing dispatch alert (the office bills the fee
// by hand). No invoice, no setup_fee_claims row. The detector reads that alert
// as covered (deferredSetupFeeCovers), so no later completion parks a second
// manual bill or bills the fee again.
//
// Compare-and-swap on the exact stamp value (a stamp that moved since the read
// is left alone and null is returned); a negative stamp is a completion
// mid-mint that bills the fee itself and is never touched here. Failures
// propagate so the stamp clear and the alert commit or roll back together.
async function parkSetupFeeStampForOffice(trx, { parentId, rawAmount, customerId, estimateId = null, origin = '', alertContext = null, billToScheduledServiceId = null } = {}) {
  if (!parentId || !customerId || !(Number(rawAmount) > 0)) return null;
  const amount = Math.round(Number(rawAmount) * 100) / 100;
  const updated = await trx('scheduled_services')
    .where({ id: parentId, pending_setup_fee: rawAmount })
    .update({ pending_setup_fee: null, updated_at: new Date() });
  if (updated !== 1) return null;
  const alert = await require('./dispatch-alerts').createAlert({
    type: SETUP_FEE_OFFICE_BILLING_ALERT, severity: 'warn', jobId: parentId, trx,
    payload: {
      amount, seriesId: parentId, estimateId, customerId, billToScheduledServiceId, origin, ...(alertContext || {}),
    },
  });
  return { parentId, amount, alertId: alert?.id || null };
}

/**
 * @param {object} params
 * @param {string} params.sourceEstimateId  the visit's source_estimate_id
 * @param {string|null} params.customerId   when given, must match the
 *   estimate's customer (a re-linked visit must not park another
 *   customer's obligation)
 * @param {string|null} params.excludeScheduledServiceId  the visit being
 *   completed — excluded from the prior-completed-visit check
 * @param {{is_recurring?: boolean, recurring_parent_id?: string|null}|null}
 *   params.visitPlanRow  the completing visit's recurrence identity; when
 *   given, a NON-plan row (a one-time add-on from the same estimate:
 *   is_recurring falsy, including a linked booster) reports not-owed so
 *   its own mint is never suppressed
 * @param {object} conn  knex connection/transaction
 * @returns {Promise<{owed: boolean, setupFee?: number, estimateId?: string,
 *   estimateSlug?: string|null, firstVisitAlreadyCompleted?: boolean,
 *   deadInvoice?: {id: string, invoiceNumber: string|null, status: string}|null}>}
 *   Throws on query failure — the completion caller fails CLOSED on it,
 *   the display caller catches and degrades to "no warning".
 */
async function findUnmintedSetupFeeObligation({
  sourceEstimateId,
  customerId = null,
  excludeScheduledServiceId = null,
  visitPlanRow = null,
} = {}, conn = db) {
  if (!sourceEstimateId) return { owed: false };
  const estimate = await conn('estimates').where({ id: sourceEstimateId }).first();
  if (!estimate) return { owed: false };
  if (String(estimate.status || '').toLowerCase() !== 'accepted') return { owed: false };
  if (customerId && String(estimate.customer_id) !== String(customerId)) return { owed: false };
  if (estimate.bill_by_invoice) return { owed: false };
  const acceptedAt = estimate.accepted_at ? new Date(estimate.accepted_at) : null;
  if (!acceptedAt || Number.isNaN(acceptedAt.getTime())) return { owed: false };

  const EstimateConverter = require('./estimate-converter');
  const estimateData = parseEstimateData(estimate.estimate_data);
  // Display evidence first, date proxy second: a snapshot that shows the
  // fee puts the accept in scope regardless of date. Otherwise only
  // accepts after the rule day fully ended qualify, and even then a
  // FEE-LESS snapshot accepted via manual Mark Won stays OUT of scope
  // (Codex P0, pre-push round 15): a public accept necessarily rendered
  // the repaired page with the fee, but a Mark Won accept involves no
  // page view — the fee-less snapshot is the last pricing the customer
  // saw, and billing an unagreed $99 is never fail-safe.
  const { evidence: feeEvidence, amount: snapshotFeeAmount } = snapshotShowsSetupFee(estimateData);
  // A shown fee row whose accepted amount is zero (fully discounted) or
  // unreadable proves no POSITIVE agreed fee — nothing to park (Codex
  // P0): the current constant substitutes only when NO fee row exists
  // (date-rule path below).
  if (feeEvidence === 'shown' && !(snapshotFeeAmount > 0)) return { owed: false };
  if (feeEvidence !== 'shown') {
    if (acceptedAt < new Date(SETUP_FEE_RULE_SAFE_CUTOFF)) return { owed: false };
    if (feeEvidence === 'feeless'
      && String(estimate.price_locked_by || '') !== 'customer_accept') {
      // Consent needs POSITIVE proof (Codex P0, pre-push round 16): the
      // activity-log row a manual accept writes is best-effort (its
      // insert failure is swallowed), so its absence proves nothing. The
      // DURABLE atomic marker is estimates.price_locked_by — only
      // 'customer_accept' proves the customer rendered the repaired page
      // with the fee; 'manual_accept', 'backfill', or null leave the
      // fee-less snapshot as the last pricing the customer saw.
      return { owed: false };
    }
  }
  const recurringServices = EstimateConverter.recurringServicesFromEstimateData(estimateData);
  if (!EstimateConverter.shouldIncludeWaveGuardSetupFeeForRecurring({ recurringServices, estimateData })) {
    return { owed: false };
  }

  // A completing visit that is not a plan-application row (a one-time
  // add-on sourced from the same estimate) never owns the obligation —
  // holding ITS mint would silently drop the add-on charge.
  if (visitPlanRow != null && !isPlanApplicationRow(visitPlanRow)) {
    return { owed: false };
  }

  // A COVERED annual-prepay term means the accept took (or switched to)
  // the prepay path and its money actually stands — the fee is waived by
  // that policy and the prepay invoice is its own billing record.
  // Coverage comes from the ONE canonical predicate
  // (annual-prepay-renewals.coveredTermsAsOf — Codex P0, pre-push rounds
  // 13 and 18): a cancelled/refunded term, a payment_pending term whose
  // invoice never settled, or a decided term whose backing payment was
  // clawed back all read NOT covered, and none of them may erase the
  // setup-fee obligation.
  const AnnualPrepayRenewals = require('./annual-prepay-renewals');
  const coveredPrepayTerm = await AnnualPrepayRenewals.coveredTermsAsOf(conn, null)
    .where('t.source_estimate_id', estimate.id)
    .first('t.id');
  if (coveredPrepayTerm) return { owed: false };

  // Every accept-time mint (converter setup/prepay draft, public inline
  // pay-per-application mint, invoice-mode mint) stamps
  // "accepted estimate #<id>" into the invoice notes — invoices carry no
  // estimate_id column, so the stamp is the deterministic linkage (same
  // convention as estimate-payment-context / buildAlreadyAcceptedSuccessPayload).
  // A stamped invoice satisfies the obligation only when it actually
  // BILLED the fee (invoiceHasPositiveSetupFeeLine, strict — no notes
  // fallback, round-17 P0; round-5 P0: stamped
  // "first application only" invoices are legitimate converter output):
  //   - LIVE + fee line → minted, done;
  //   - refunded + fee line, ANY attachment → the fee was collected then
  //     deliberately refunded; never instruct a re-bill (see below);
  //   - canceled/cancelled + attached + fee line → #3474's
  //     canceledSetupFee parking lane surfaces it.
  // Everything else — application-only rows in any status, void rows
  // (attachment proves nothing, findFirstApplicationInvoiceForEstimate
  // Service excludes 'void' outright), canceled fee rows unattached —
  // leaves the fee genuinely unbilled, so the obligation survives it
  // (Codex P0, round 1) and the alert names a dead fee-carrying invoice
  // so the office can distinguish "voided without replacement" from
  // "never minted".
  const DEAD_STATUSES = new Set([...require('./invoice').CANCELLED_SERVICE_RESOLVED_STATUSES, 'void']);
  const {
    invoiceHasPositiveSetupFeeLine, invoiceBillsBaseApplication, sumPositiveSetupFeeCents,
  } = require('./estimate-first-application-invoice');
  // CENTS-EXACT clearing (Codex P0): a $9.90 partial line must not clear
  // a frozen $99 obligation — live/canceled resolution requires SUMMED
  // fee cents >= the accepted amount. (Refunded keeps the any-positive
  // doctrine: refunded money is never re-instructed, rounds 5/13/19.)
  // Amount authority ladder (Codex PR r10 P1): display-frozen snapshot
  // amount → accept-frozen stamp (public accepts of fee-less snapshots
  // persist the rendered fee as acceptedSetupFeeAmount) → the current
  // constant only when neither frozen figure exists.
  const acceptedFrozenFee = Number(estimateData?.acceptedSetupFeeAmount);
  const authoritativeFee = snapshotFeeAmount != null
    ? snapshotFeeAmount
    : (Number.isFinite(acceptedFrozenFee) && acceptedFrozenFee > 0
      ? Math.round(acceptedFrozenFee * 100) / 100
      : EstimateConverter.WAVEGUARD_SETUP_FEE);
  const expectedFeeCents = Math.round(Number(authoritativeFee) * 100);
  const stampedRows = await conn('invoices')
    .where({ customer_id: estimate.customer_id })
    .where('notes', 'ilike', `%accepted estimate #${estimate.id}%`)
    .select('id', 'invoice_number', 'status', 'scheduled_service_id', 'service_record_id', 'line_items', 'notes');
  // Every clearing path requires the invoice to have ACTUALLY BILLED the
  // fee (Codex P0, pre-push round 5): the converter legitimately mints
  // stamped "first application only" invoices (waived-then-changed data,
  // office edits, fee-less prior mints), and clearing on the stamp alone
  // would let completion proceed unparked while the $99 was never billed.
  // An application-only live stamped invoice leaves the obligation OWED —
  // the completion hold then suppresses the duplicate application mint
  // and the alert's revalidation directs staff to bill only the fee.
  const liveStampedFeeCents = stampedRows
    .filter((r) => !DEAD_STATUSES.has(String(r.status || '').toLowerCase()))
    .reduce((sum, r) => sum + sumPositiveSetupFeeCents(r), 0);
  // REFUNDED fee cents CREDIT the obligation regardless of attachment
  // (Codex PR r2 P1 → final-round P0): the refunded amount was collected
  // and deliberately refunded — the no-rebill doctrine holds for THAT
  // amount (no refund-event clock; refund.failed restores it to paid) —
  // but a $9.90 partial refund never clears a $99 obligation: only full
  // cents coverage resolves, and the REMAINDER stays owed.
  const refundedFeeCents = stampedRows
    .filter((r) => String(r.status || '').toLowerCase() === 'refunded')
    .reduce((sum, r) => sum + sumPositiveSetupFeeCents(r), 0);
  const coveredFeeCents = liveStampedFeeCents + refundedFeeCents;
  if (coveredFeeCents >= expectedFeeCents) return { owed: false };
  const remainingFeeCents = expectedFeeCents - coveredFeeCents;
  // A CANCELED fee-carrying invoice satisfies only when #3474's
  // canceledSetupFee lane can PROVABLY discover it (Codex P0, pre-push
  // round 14): findFirstApplicationInvoiceForEstimateService joins
  // invoices by scheduled_service_id to a same-estimate visit ON THE
  // COMPLETING VISIT'S scheduled date. A canceled invoice attached to a
  // visit that was itself canceled and replaced on another date is
  // invisible to that lane — the obligation must survive it or the
  // replacement visit mints bare. Without a completing-visit context
  // (display callers) the attachment is unprovable → owed.
  const canceledAttachedFee = stampedRows.find((r) => {
    const status = String(r.status || '').toLowerCase();
    return (status === 'canceled' || status === 'cancelled')
      && r.scheduled_service_id && sumPositiveSetupFeeCents(r) >= expectedFeeCents;
  });
  if (canceledAttachedFee && excludeScheduledServiceId) {
    const attachedRow = await conn('scheduled_services')
      .where({ id: canceledAttachedFee.scheduled_service_id })
      .first('scheduled_date', 'source_estimate_id');
    const completingRow = await conn('scheduled_services')
      .where({ id: excludeScheduledServiceId })
      .first('scheduled_date');
    const { dateOnly } = require('./estimate-first-application-invoice');
    const discoverable = !!(attachedRow && completingRow
      && String(attachedRow.source_estimate_id) === String(estimate.id)
      && dateOnly(attachedRow.scheduled_date)
      && dateOnly(attachedRow.scheduled_date) === dateOnly(completingRow.scheduled_date));
    if (discoverable) return { owed: false };
  }
  // Name only a dead FEE-CARRYING invoice — a dead application-only row
  // never billed the fee, so "never invoiced" is the accurate story.
  const deadInvoice = stampedRows.find((r) => DEAD_STATUSES.has(String(r.status || '').toLowerCase())
    && invoiceHasPositiveSetupFeeLine(r)) || null;

  // Fee DEFERRED to the first performed visit (pay after first visit,
  // GATE_PAF_SETUP_FEE): the accept stamped the fee on the series parent
  // (scheduled_services.pending_setup_fee) instead of minting an invoice
  // whose notes say "accepted estimate #<id>", so the note-based checks above
  // would call it "never minted" and park the first visit for manual billing
  // while completion is about to bill it on the visit's own invoice. ANY live
  // claim (positive = queued, negative = a completion mid-mint) that a
  // completion can still consume, or the immutable setup_fee_claims record of a live
  // series invoice that already carries it, is "deferred / billed", not
  // "missing". Deliberately NOT behind the sub-gate: it only ever matches a
  // stamp this estimate's own series carries, and a stamp written while the
  // gate was on must stay recognised after a flip back off.
  const deferral = await deferredSetupFeeCovers(conn, estimate, {
    completingVisitId: excludeScheduledServiceId,
    completingParentId: visitPlanRow?.recurring_parent_id || null,
  });
  if (deferral.covers) {
    return { owed: false, deferredToFirstVisit: true };
  }
  // Converter provenance: the accept actually ran the conversion (tier
  // flip, activity row) and still minted nothing. Accepts that never
  // converted (legacy paths, pre-converter rows) are out of scope.
  const converted = await conn('activity_log')
    .where({ customer_id: estimate.customer_id, action: 'estimate_converted' })
    .where('description', 'like', `Estimate #${estimate.id} converted:%`)
    .first('id');
  if (!converted) return { owed: false };

  // The obligation resolves to sweep territory only on DURABLE BILLING
  // EVIDENCE: an earlier PLAN visit of this estimate that completed AND
  // carries a live invoice (billed bare, pre-fix — parking a LATER
  // routine visit would misdirect the office). Completion status alone
  // proves nothing (Codex P0, pre-push round 3): an inspection_only /
  // customer_declined outcome or a coverage-suppressed billing still
  // marks the row completed while minting nothing — clearing the
  // obligation on it would let every later performed application bypass
  // parking and lose the fee permanently. Only plan rows (is_recurring)
  // count either way: a completed one-time add-on /
  // inspection from the same estimate must not release the hold on the
  // actual first application (Codex P0, round 1).
  let priorQuery = conn('scheduled_services')
    .where({ source_estimate_id: estimate.id })
    .where('status', 'completed');
  if (excludeScheduledServiceId) priorQuery = priorQuery.whereNot('id', excludeScheduledServiceId);
  const priorCompletedRows = await priorQuery.select('id', 'is_recurring', 'recurring_parent_id', 'estimated_price');
  const priorPlanRows = (priorCompletedRows || []).filter(isPlanApplicationRow);
  let priorCompleted = null;
  let billedPriorPlanVisitIds = [];
  if (priorPlanRows.length) {
    const planIds = priorPlanRows.map((r) => r.id);
    const priorRecords = await conn('service_records')
      .whereIn('scheduled_service_id', planIds)
      .select('id', 'scheduled_service_id');
    const priorRecordToVisit = new Map(priorRecords.map((r) => [String(r.id), String(r.scheduled_service_id)]));
    const priorRecordIds = priorRecords.map((r) => r.id);
    const priorBilledRows = await conn('invoices')
      .where((qb) => {
        qb.whereIn('scheduled_service_id', planIds);
        if (priorRecordIds.length) qb.orWhereIn('service_record_id', priorRecordIds);
      })
      .whereNotIn('status', Array.from(DEAD_STATUSES))
      .select('id', 'line_items', 'notes', 'scheduled_service_id', 'service_record_id');
    // The evidence must be the plan APPLICATION being billed, not any
    // invoice that happens to hang off the visit (Codex P0, pre-push
    // round 6) — a setup-only or otherwise fee-marked attached invoice
    // proves nothing about the application and must not clear the guard.
    // Only the durable base-application identity counts (round 18 —
    // linkage alone is insufficient money evidence). The EXACT billed
    // visit ids ride the result (final-round P0): the historic fee-only
    // alert persists them, and its reconciliation revalidates ONLY those
    // — a completed inspection_only/declined visit that never billed is
    // never re-listed as owed.
    // FULL cents coverage per visit (Codex PR r19 P1): a $10 partial line
    // on a $100 visit is not a billed application — boolean only when the
    // row carries no price to compare against.
    const { sumBaseApplicationCents } = require('./estimate-first-application-invoice');
    const priorPriceCents = new Map(priorPlanRows.map((r) => {
      const n = Number(r.estimated_price);
      return [String(r.id), Number.isFinite(n) && n > 0 ? Math.round(n * 100) : null];
    }));
    billedPriorPlanVisitIds = planIds.map(String).filter((visitId) => {
      const rowsFor = (priorBilledRows || []).filter((r) => (
        String(r.scheduled_service_id || '') === visitId
        || priorRecordToVisit.get(String(r.service_record_id || '')) === visitId));
      const expect = priorPriceCents.get(visitId);
      if (expect === null || expect === undefined) return rowsFor.some(invoiceBillsBaseApplication);
      return rowsFor.reduce((sum, r) => sum + sumBaseApplicationCents(r), 0) >= expect;
    });
    priorCompleted = billedPriorPlanVisitIds.length ? { id: billedPriorPlanVisitIds[0] } : null;
  }

  return {
    owed: true,
    // setupFee = the FULL frozen obligation (Codex P0: consumers like the
    // completion alert subtract live coverage themselves — returning the
    // remainder here deducted partial coverage twice). The remainder is
    // exposed separately for display consumers.
    setupFee: authoritativeFee,
    setupFeeRemainingCents: Math.round(remainingFeeCents),
    estimateId: estimate.id,
    estimateSlug: estimate.estimate_slug || null,
    firstVisitAlreadyCompleted: !!priorCompleted,
    billedPriorPlanVisitIds,
    // Live positive stamps no completion can ever consume (dues-covered lane /
    // no live consumer): the completion parks them for the office (never clears
    // them to nothing), so the fee can never bill twice.
    unconsumableStamps: deferral.unconsumableStamps,
    deadInvoice: deadInvoice
      ? { id: deadInvoice.id, invoiceNumber: deadInvoice.invoice_number || null, status: String(deadInvoice.status || '') }
      : null,
  };
}

module.exports = {
  estimateSetupSeries,
  waiveDeferredSetupFeeForPrepay,
  restoreWaivedDeferredSetupFeeForPrepay,
  rewaiveDeferredSetupFeeForRevivedPrepay,
  officeParkedSetupFeeSeries,
  findUnmintedSetupFeeObligation,
  parkSetupFeeStampForOffice,
  isPlanApplicationRow,
  SETUP_FEE_OFFICE_BILLING_ALERT,
  _private: {
    SETUP_FEE_RULE_SAFE_CUTOFF, parseEstimateData, isPlanApplicationRow, snapshotShowsSetupFee,
  },
};
