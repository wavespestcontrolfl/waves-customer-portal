/**
 * The customer's treatable lawn size, written from the ESTIMATE.
 *
 * Owner ruling 2026-10-04: the size the office confirms on the estimate
 * ("Treatable Lawn Area: Confirmed Sq Ft") is the ONE number that drives
 * price, product amounts and the report. This module is the single writer
 * that moves an accepted estimate's confirmed size into the three places the
 * rest of the portal reads:
 *
 *   customer_turf_profiles.lawn_sqft        (visit amounts, plan engine, report)
 *   customer_properties.property_sqft       (the PRIMARY property's mirror)
 *   customers.property_sqft                 (legacy mirror)
 *
 * The mirror rule is the turf-profile editor's, extracted here so the editor,
 * the acceptance hook and the backfill script share ONE implementation
 * (syncLawnSqftMirrors). Nothing in this module reprices anyone: it writes the
 * size and an audit row, nothing else (see docs/qa/property-service-areas.md, "Estimate is the lawn-size source").
 */
const { addressKey } = require('./customer-property-address-keys');

// Same ceiling the turf-profile editor (admin-customer-turf-profile.js) and
// the property-area review (property-service-areas.js areaNumber) already
// enforce. The floor is 1, not 0: the editor accepts an explicit 0 as "no
// lawn", but a zero is not a confirmed size for a customer who buys lawn
// care, so the estimate path never writes it.
const LAWN_SQFT_MIN = 1;
const LAWN_SQFT_MAX = 1000000;

// computeTurfArea() (pricing-engine/property-calculator.js) stamps these two
// bases only for a figure somebody entered: `measuredTurfSf` (the admin tool's
// Confirmed Sq Ft, the agent/draft on-file figure) and `lawnSqFt` (an explicit
// lawn area). Every other basis (estimatedTurfSf, countyPrior,
// plausibleMaxTurfCap, legacyHardscapeEstimate, lotFallback, ...) is an AI or
// lot-derived estimate that nobody confirmed.
const CONFIRMED_TURF_BASES = new Set(['measuredTurfSf', 'lawnSqFt']);

const isObject = (v) => v && typeof v === 'object' && !Array.isArray(v);

function parseData(raw) {
  if (isObject(raw)) return raw;
  if (typeof raw !== 'string') return {};
  try {
    const parsed = JSON.parse(raw);
    return isObject(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** A sane lawn size: a whole number (or whole-number string) 1..1,000,000, else null. */
function saneLawnSqft(value) {
  if (value === null || value === undefined || value === '' || typeof value === 'boolean') return null;
  const n = typeof value === 'string' ? (/^\s*\d+\s*$/.test(value) ? Number(value) : NaN) : value;
  if (typeof n !== 'number' || !Number.isInteger(n)) return null;
  return n >= LAWN_SQFT_MIN && n <= LAWN_SQFT_MAX ? n : null;
}

/** Priced lawn lines, wherever the saved estimate keeps them. */
function lawnLines(data) {
  const containers = [
    data.result?.lineItems, data.engineResult?.lineItems, data.lineItems,
    data.result?.engineResult?.lineItems,
  ];
  const out = [];
  for (const list of containers) {
    if (!Array.isArray(list)) continue;
    for (const li of list) if (isObject(li) && li.service === 'lawn_care') out.push(li);
  }
  return out;
}

/** The v1-mapped selected-lawn provenance (lsf = priced area). */
function lawnMetas(data) {
  const out = [];
  for (const meta of [data.result?.results?.lawnMeta, data.result?.lawnMeta, data.results?.lawnMeta, data.lawnMeta]) {
    if (isObject(meta)) out.push(meta);
  }
  return out;
}

/**
 * The estimate's request-level figure, used only when no priced lawn line
 * carries a turf basis (older saves). Admin V2 keeps the operator's Confirmed
 * Sq Ft at engineRequest.profile.measuredTurfSf.
 */
function requestLevelCandidates(data) {
  const carriers = [
    ['engineRequest.profile', data.engineRequest?.profile],
    ['engineInputs', data.engineInputs],
    ['engineInput', data.engineInput],
    ['inputs', data.inputs],
  ];
  const out = [];
  for (const [where, carrier] of carriers) {
    if (!isObject(carrier)) continue;
    for (const key of ['measuredTurfSf', 'lawnSqFt']) {
      if (carrier[key] !== undefined && carrier[key] !== null && carrier[key] !== '') out.push({ field: `${where}.${key}`, value: carrier[key] });
    }
  }
  return out;
}

/**
 * Paths that echo the customer's OWN saved size back into the estimate (the
 * agent estimate tool and automated lead drafts bind measuredTurfSf to the
 * customer's saved size so the engine prices off it). That figure was never
 * confirmed on this estimate, so it can neither correct nor set the size.
 */
function echoesSavedSize(data) {
  if (isObject(data.propertyFacts?.treatable_lawn_sqft)) return true;
  const draftInput = data.automation?.draftEstimateAutomation?.engineInput;
  return [data.engineInput, data.engineInputs, draftInput].some((c) => isObject(c) && Object.hasOwn(c, 'measuredTurfUnitVerified'));
}

/**
 * The size the office confirmed on an estimate, or why there is none.
 *
 * Returns { sqft, field, basis, source } when confirmed, else
 * { sqft: null, reason }. Reasons: no_lawn_size (no lawn line / figure at all),
 * unconfirmed_estimate (priced from AI or lot data), saved_size_echo,
 * no_positive_size (confirmed 0), implausible_size (out of 1..1,000,000 or not a
 * whole number), conflicting_sizes (two lawn lines disagree).
 */
function confirmedLawnSqftFromEstimate(estimateData) {
  const data = parseData(estimateData);
  const lines = lawnLines(data);
  const metas = lawnMetas(data);
  const priced = [
    ...lines.map((li) => ({ field: 'lineItems[lawn_care].lawnSqFt', raw: li.lawnSqFt ?? li.turfSf, basis: li.turfBasis, estimated: li.turfEstimated })),
    ...metas.map((m) => ({ field: 'results.lawnMeta.lsf', raw: m.lsf, basis: m.turfBasis, estimated: m.turfEstimated })),
  ].filter((p) => p.basis);

  if (priced.length) {
    const unconfirmed = priced.filter((p) => !CONFIRMED_TURF_BASES.has(String(p.basis)) || p.estimated === true);
    if (unconfirmed.length) return { sqft: null, reason: 'unconfirmed_estimate', basis: String(unconfirmed[0].basis) };
    if (echoesSavedSize(data)) return { sqft: null, reason: 'saved_size_echo' };
    const values = new Set(priced.map((p) => Number(p.raw)));
    if (values.size > 1) return { sqft: null, reason: 'conflicting_sizes' };
    const first = priced[0];
    const n = Number(first.raw);
    if (Number.isFinite(n) && n === 0) return { sqft: null, reason: 'no_positive_size', basis: String(first.basis) };
    const sqft = saneLawnSqft(first.raw);
    if (sqft === null) return { sqft: null, reason: 'implausible_size', basis: String(first.basis) };
    return { sqft, field: first.field, basis: String(first.basis), source: 'priced_line' };
  }

  // Legacy save: no priced line carries a basis, fall back to the operator's
  // typed request figure.
  const candidates = requestLevelCandidates(data);
  if (!candidates.length) return { sqft: null, reason: 'no_lawn_size' };
  if (echoesSavedSize(data)) return { sqft: null, reason: 'saved_size_echo' };
  const values = new Set(candidates.map((c) => Number(c.value)));
  if (values.size > 1) return { sqft: null, reason: 'conflicting_sizes' };
  if (Number(candidates[0].value) === 0) return { sqft: null, reason: 'no_positive_size' };
  const sqft = saneLawnSqft(candidates[0].value);
  if (sqft === null) return { sqft: null, reason: 'implausible_size' };
  return { sqft, field: candidates[0].field, basis: null, source: 'request_input' };
}

/**
 * Does this estimate quote the customer's PRIMARY property? Reuses the
 * estimate-to-property rules the rest of the portal uses: a linked
 * estimates.property_id must BE the primary property; an unlinked estimate
 * (acceptance links property_id only AFTER commit, and a new customer may not
 * have a primary customer_properties row yet) must quote the customer's own
 * address (estimateQuotesCustomerAddress), which is the primary property by
 * definition (customers.address_* mirrors the primary). An estimate with
 * neither a property nor a parseable street is `unmatched` (no evidence,
 * nothing is written).
 *
 * Returns { match: true } or { match: false, reason: 'other_property' |
 * 'unmatched', targetPropertyId }.
 */
function estimateTargetsPrimary(estimate, customer, primary, { properties = [] } = {}) {
  const linkage = require('./estimate-property-linkage');
  if (!customer) return { match: false, reason: 'unmatched', targetPropertyId: null };
  if (estimate?.property_id) {
    if (!primary) return { match: false, reason: 'unmatched', targetPropertyId: String(estimate.property_id) };
    if (String(estimate.property_id) === String(primary.id)) return { match: true };
    const target = properties.find((p) => String(p.id) === String(estimate.property_id));
    return { match: false, reason: 'other_property', targetPropertyId: target ? target.id : String(estimate.property_id) };
  }
  const parts = linkage.parseEstimateAddress(estimate?.address);
  if (!parts || !String(parts.address_line1 || '').trim()) return { match: false, reason: 'unmatched', targetPropertyId: null };
  if (linkage.estimateQuotesCustomerAddress(estimate.address, customer)) return { match: true };
  return { match: false, reason: 'other_property', targetPropertyId: null };
}

/**
 * Move the lawn mirrors (primary property_sqft + customers.property_sqft) to
 * `lawnSqft` and withdraw any tech lawn review stamp that sat on the old
 * number. EXTRACTED from the turf-profile editor
 * (admin-customer-turf-profile.js): only the primary property at the
 * customer's own address carries the mirrors, and nothing happens before the
 * service-areas migration. Call inside the customer fence (withTurfProfileFence).
 *
 * `customerOnlyWithoutPrimary` is for the estimate path alone: a customer with
 * NO primary property row yet (a new customer; the row is created lazily and
 * copies customers.property_sqft when it is) gets customers.property_sqft
 * moved so the lazily created primary does not inherit a stale size. The
 * editor does not pass it and keeps its original behavior.
 * Returns { synced, primaryPropertyId }.
 */
async function syncLawnSqftMirrors(trx, customerId, lawnSqft, { customer = null, primary = null, customerOnlyWithoutPrimary = false } = {}) {
  if (!(await require('./property-service-areas').hasAreaMeasurementsColumn(trx))) return { synced: false, primaryPropertyId: null };
  const cust = customer || await trx('customers').where({ id: customerId }).first();
  const prim = primary || await trx('customer_properties').where({ customer_id: customerId, is_primary: true, active: true }).first();
  if (!prim && cust && customerOnlyWithoutPrimary) {
    await trx('customers').where({ id: customerId }).update({ property_sqft: lawnSqft, updated_at: trx.fn.now() });
    return { synced: true, primaryPropertyId: null };
  }
  if (!(prim && cust && addressKey(cust) === addressKey(prim))) return { synced: false, primaryPropertyId: null };
  await trx('customer_properties').where({ id: prim.id }).update({
    service_area_measurements: trx.raw("service_area_measurements #- '{areas,lawn}'"),
    property_sqft: lawnSqft, updated_at: trx.fn.now(),
  });
  await trx('customers').where({ id: customerId }).update({ property_sqft: lawnSqft, updated_at: trx.fn.now() });
  return { synced: true, primaryPropertyId: prim.id };
}

/**
 * Write one lawn size to turf profile + mirrors. MUST run inside
 * withTurfProfileFence. Idempotent: writes nothing and returns changed:false
 * when all three places already hold the size. Returns the before/after values
 * for the audit row.
 */
async function writeLawnSqft(trx, customerId, sqft) {
  const customer = await trx('customers').where({ id: customerId }).first();
  const turf = await trx('customer_turf_profiles').where({ customer_id: customerId }).first('lawn_sqft');
  const primary = await trx('customer_properties').where({ customer_id: customerId, is_primary: true, active: true }).first();
  const mirrorTarget = primary && customer && addressKey(customer) === addressKey(primary) ? primary : null;
  // No primary row at all: the customer row is the only mirror (see syncLawnSqftMirrors).
  const customerOnly = !primary && !!customer;
  const before = {
    turf_lawn_sqft: turf?.lawn_sqft ?? null,
    primary_property_id: primary?.id ?? null,
    primary_property_sqft: mirrorTarget ? (mirrorTarget.property_sqft ?? null) : null,
    customer_property_sqft: customer?.property_sqft ?? null,
  };
  const turfChanged = before.turf_lawn_sqft !== sqft;
  const mirrorDiffers = (!!mirrorTarget && (before.primary_property_sqft !== sqft || before.customer_property_sqft !== sqft))
    || (customerOnly && before.customer_property_sqft !== sqft);
  if (!turfChanged && !mirrorDiffers) return { changed: false, before, after: before, mirrorsSynced: !!mirrorTarget };
  if (turfChanged) {
    await trx('customer_turf_profiles').insert({ customer_id: customerId, lawn_sqft: sqft })
      .onConflict('customer_id').merge({ lawn_sqft: sqft, updated_at: trx.fn.now() });
  }
  const mirrors = await syncLawnSqftMirrors(trx, customerId, sqft, { customer, primary: mirrorTarget || primary, customerOnlyWithoutPrimary: true });
  return {
    changed: true,
    before,
    after: {
      ...before,
      turf_lawn_sqft: sqft,
      primary_property_sqft: mirrors.synced ? sqft : before.primary_property_sqft,
      customer_property_sqft: mirrors.synced ? sqft : before.customer_property_sqft,
    },
    mirrorsSynced: mirrors.synced,
  };
}

/**
 * Apply an accepted estimate's confirmed lawn size to the customer. Used by
 * estimate acceptance and by the backfill script. The estimate WINS over an
 * existing value. Runs inside the same customer fence as the grass-type write
 * (a savepoint when `database` is already the acceptance transaction), and the
 * audit row is written inside it, so the size and its audit row commit or roll
 * back together. Throws on a database error: the acceptance caller catches and
 * logs (fail-soft); the backfill reports the error for that customer.
 *
 * Returns { status: 'written' | 'unchanged' | 'skipped', reason?, sqft?, before?, after?, ... }.
 */
async function applyEstimateLawnSqft(database, { customerId, estimate, estimateData, trigger = 'acceptance', actorId = null }) {
  const confirmed = confirmedLawnSqftFromEstimate(estimateData ?? estimate?.estimate_data);
  if (confirmed.sqft === null) return { status: 'skipped', reason: confirmed.reason, basis: confirmed.basis || null };
  const { withTurfProfileFence } = require('./customer-pricing-ai');
  return withTurfProfileFence(database, customerId, async (trx) => {
    const customer = await trx('customers').where({ id: customerId }).first();
    const primary = await trx('customer_properties').where({ customer_id: customerId, is_primary: true, active: true }).first();
    const targets = estimateTargetsPrimary(estimate, customer, primary);
    if (!targets.match) {
      // Say what the right target would be, but do not build multi-property
      // support: the other property's own property_sqft is where this size
      // belongs, and nothing writes it here.
      let targetPropertySqft = null;
      if (targets.targetPropertyId) {
        const target = await trx('customer_properties').where({ id: targets.targetPropertyId, customer_id: customerId }).first('property_sqft');
        targetPropertySqft = target?.property_sqft ?? null;
      }
      return { status: 'skipped', reason: targets.reason, sqft: confirmed.sqft, targetPropertyId: targets.targetPropertyId, targetPropertySqft };
    }
    const written = await writeLawnSqft(trx, customerId, confirmed.sqft);
    if (!written.changed) return { status: 'unchanged', sqft: confirmed.sqft, ...written };
    await require('./audit-log').auditLawnSqftFromEstimate({
      customer_id: customerId, estimate_id: estimate?.id ?? null, sqft: confirmed.sqft,
      before: written.before, after: written.after, trigger,
      field: confirmed.field, basis: confirmed.basis, source: confirmed.source, actor_id: actorId, trx,
    });
    return { status: 'written', sqft: confirmed.sqft, ...written };
  });
}

module.exports = {
  LAWN_SQFT_MIN, LAWN_SQFT_MAX, CONFIRMED_TURF_BASES,
  parseEstimateData: parseData, saneLawnSqft, confirmedLawnSqftFromEstimate, estimateTargetsPrimary,
  syncLawnSqftMirrors, writeLawnSqft, applyEstimateLawnSqft,
};
