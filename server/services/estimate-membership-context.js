// ============================================================
// estimate-membership-context.js
//
// Builds the customer-facing "WaveGuard membership" context for an estimate
// that is linked to an existing, active customer (estimates.customer_id set).
//
// computeMembershipContext() is run ONCE at estimate save/reprice time
// (admin-estimate-persistence.js) and the result is frozen onto the estimate as
// estimate_data.membershipSnapshot. buildEstimateMembershipContext() then just
// reads that snapshot at view time. This keeps the card tied to the saved
// pricing — it can never diverge from the charged total because of mutable
// scheduled_services changing between save and view, and legacy estimates with
// no snapshot render no card.
//
// The NEW-service member discount it shows is honored at the charged total
// because the same combined tier (from the same shared waveguard-existing-
// services loader) reprices the estimate at save. Existing service prices are
// context only and stay untouched; adding a service never reprices a customer's
// current plan lines.
//
// The snapshot captures:
//   1. The combined WaveGuard tier — existing qualifying services PLUS the
//      new service(s) in this estimate.
//   2. The tier-upgrade callout (e.g. Silver -> Gold).
//   3. The customer's current service/spend snapshot for staff transparency.
//   4. The member discount on the NEW service in this estimate only.
//
// Returns null for leads (no customer_id), inactive customers, or on ANY error
// so neither save nor the public estimate endpoints ever break (CLAUDE.md r6).
// ============================================================

const logger = require('./logger');
const { sameStreetAddress } = require('./estimator-engine/address-compare');
const { determineWaveGuardTier } = require('./pricing-engine/discount-engine');
const {
  toQualifyingKey,
  toQualifyingKeys,
  loadActiveRecurringServiceRows,
  loadExistingRecurringQualifyingRows,
} = require('./waveguard-existing-services');

const TIER_LABEL = { bronze: 'Bronze', silver: 'Silver', gold: 'Gold', platinum: 'Platinum' };
const SERVICE_LABEL = {
  pest_control: 'Pest Control',
  lawn_care: 'Lawn Care',
  tree_shrub: 'Tree & Shrub',
  mosquito: 'Mosquito',
  termite_bait: 'Termite Bait',
};

function round2(n) { return Math.round((Number(n) || 0) * 100) / 100; }

function accountServiceKey(raw) {
  const qualifying = toQualifyingKey(raw);
  if (qualifying) return qualifying;
  // Canonical keys for the non-tier recurring programs. The estimate
  // converter stores DISPLAY names on scheduled_services ("Rodent Bait
  // Stations", "Commercial Turf Treatment Program"); a generic snake-case of
  // those labels never matches the requested-service template keys, so
  // duplicate checks would miss the active service. Commercial programs
  // canonicalize to commercial_ + the residential TEMPLATE key, so stripping
  // the prefix in the duplicate check yields exactly the requested key
  // (turf → lawn_care, monitoring → termite_bait, stations → rodent_bait).
  const s = String(raw || '').toLowerCase();
  if (s.includes('commercial')) {
    if (s.includes('pest')) return 'commercial_pest_control';
    if (s.includes('lawn') || s.includes('turf')) return 'commercial_lawn_care';
    if (s.includes('tree') || s.includes('shrub')) return 'commercial_tree_shrub';
    if (s.includes('mosquito')) return 'commercial_mosquito';
    if (s.includes('termite')) return 'commercial_termite_bait';
    if (s.includes('rodent')) return 'commercial_rodent_bait';
  } else {
    if (s.includes('rodent') && s.includes('bait')) return 'rodent_bait';
    if (s.includes('palm')) return 'palm_injection';
  }
  return String(raw || '')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase();
}

function accountServiceKeys(raw) {
  const text = String(raw || '').toLowerCase();
  const commercial = text.includes('commercial');
  const keys = new Set();
  const add = (key) => keys.add(commercial ? `commercial_${key}` : key);
  if (text.includes('pest')) add('pest_control');
  if (text.includes('lawn') || text.includes('turf')) add('lawn_care');
  if (text.includes('tree') || text.includes('shrub')) add('tree_shrub');
  if (text.includes('mosquito')) add('mosquito');
  if (text.includes('termite')) add('termite_bait');
  if (text.includes('rodent') && text.includes('bait')) add('rodent_bait');
  if (text.includes('palm')) add('palm_injection');
  if (!keys.size) keys.add(accountServiceKey(raw));
  return [...keys].filter(Boolean);
}

function accountServiceLabel(key, raw) {
  if (SERVICE_LABEL[key]) return SERVICE_LABEL[key];
  return String(raw || key || 'Service')
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function parseEstimateData(estimate) {
  try {
    return typeof estimate.estimate_data === 'string'
      ? JSON.parse(estimate.estimate_data)
      : (estimate.estimate_data || {});
  } catch { return {}; }
}

// A row from estimate_data.lineItems / .services counts as a recurring service
// only if it carries recurring pricing (annual/monthly). One-time and specialty
// lines carry .price / .total and must NOT count toward the WaveGuard tier —
// one-time services never receive the tier discount and the charged price is
// unchanged, so advertising a tier upgrade off them would be wrong.
function isRecurringLineRow(c) {
  if (!c || typeof c !== 'object') return false;
  if (c.isOneTime === true || c.oneTime === true || c.one_time === true) return false;
  const hasAnnual = Number(c.annual ?? c.ann ?? c.annualBeforeDiscount) > 0;
  const hasMonthly = Number(c.monthly ?? c.mo ?? c.monthlyBeforeDiscount) > 0;
  if (hasAnnual || hasMonthly) return true;
  // price/total only (no recurring figure) → one-time / specialty.
  if (Number(c.price) > 0 || Number(c.total) > 0) return false;
  return c.recurring === true || c.isRecurring === true || !!c.frequency;
}

// Collect the candidate recurring-service rows across the several estimate_data
// shapes (v1 admin shape, engineResult, lineItems, services). The explicit
// recurring sections are trusted; the mixed lineItems / services arrays are
// filtered to recurring rows so one-time treatments don't inflate the tier.
function recurringCandidates(estData) {
  const out = [];
  const pushAll = (arr) => { if (Array.isArray(arr)) out.push(...arr); };
  pushAll(estData?.result?.recurring?.services);
  pushAll(estData?.engineResult?.recurring?.services);
  pushAll(estData?.recurring?.services);
  const mixed = [];
  if (Array.isArray(estData?.lineItems)) mixed.push(...estData.lineItems);
  if (Array.isArray(estData?.services)) mixed.push(...estData.services);
  for (const row of mixed) { if (isRecurringLineRow(row)) out.push(row); }
  return out;
}

function candidateName(c) {
  return c?.service || c?.key || c?.name || c?.label || c?.displayName || c?.service_type;
}

// Qualifying recurring service keys present in this estimate.
function estimateQualifyingKeys(estData) {
  const keys = new Set();
  for (const c of recurringCandidates(estData)) {
    const key = toQualifyingKey(candidateName(c));
    if (key) keys.add(key);
  }
  return [...keys];
}

// Best-effort monthly (pre-discount) price for a qualifying key from the
// estimate, if one is present. Used only to express the new-service member
// savings as a dollar figure — omitted when no price is found.
function estimateMonthlyFor(estData, key) {
  for (const c of recurringCandidates(estData)) {
    if (toQualifyingKey(candidateName(c)) !== key) continue;
    const monthly = c?.monthlyBeforeDiscount
      ?? c?.monthly
      ?? c?.mo
      ?? (Number(c?.annualBeforeDiscount) > 0 ? c.annualBeforeDiscount / 12 : null)
      ?? (Number(c?.annual) > 0 ? c.annual / 12 : null);
    if (Number(monthly) > 0) return round2(monthly);
  }
  return null;
}

// Visits/year for a qualifying key — explicit row fields first, then the
// engine's result-stats block (same precedence the public page uses for its
// per-application price cards).
function resultStatsRows(estData) {
  return estData?.result?.results || estData?.results || {};
}

function selectedStatsRow(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return null;
  return rows.find((t) => t?.selected || t?.isSelected)
    || rows.find((t) => t?.recommended || t?.isRecommended)
    || rows[0];
}

function estimateVisitsFor(estData, key) {
  for (const c of recurringCandidates(estData)) {
    if (toQualifyingKey(candidateName(c)) !== key) continue;
    const explicit = Number(c?.visitsPerYear ?? c?.visits ?? c?.apps ?? c?.frequency);
    if (Number.isFinite(explicit) && explicit > 0) return explicit;
  }
  const stats = resultStatsRows(estData);
  if (key === 'pest_control') return Number(stats.pest?.apps) > 0 ? Number(stats.pest.apps) : null;
  if (key === 'lawn_care') {
    const sel = (Array.isArray(stats.lawn) && (stats.lawn.find((t) => t.recommended) || stats.lawn[0])) || null;
    return Number(sel?.v) > 0 ? Number(sel.v) : null;
  }
  if (key === 'mosquito') {
    const sel = selectedStatsRow(stats.mq);
    return Number(sel?.v) > 0 ? Number(sel.v) : null;
  }
  if (key === 'tree_shrub') {
    const sel = selectedStatsRow(stats.ts);
    return Number(sel?.v) > 0 ? Number(sel.v) : null;
  }
  if (key === 'termite_bait') return 4;
  return null;
}

// Pre-discount per-application price for a qualifying key — explicit per-app
// row fields first, else monthly*12/visits. Used to express the new-service
// member savings as a per-application dollar figure.
function estimatePerApplicationFor(estData, key) {
  for (const c of recurringCandidates(estData)) {
    if (toQualifyingKey(candidateName(c)) !== key) continue;
    const explicit = Number(c?.perTreatment ?? c?.perApp ?? c?.perVisit ?? c?.pa);
    if (Number.isFinite(explicit) && explicit > 0) return round2(explicit);
  }
  const monthly = estimateMonthlyFor(estData, key);
  const visits = estimateVisitsFor(estData, key);
  if (monthly > 0 && visits > 0) return round2((monthly * 12) / visits);
  return null;
}

// One-time membership/setup line items must not count toward the per-visit
// basis — the FIRST standard accept invoice can carry the $99 WaveGuard setup
// AND the first application on the same service-linked invoice, and reading
// its raw total would inflate the advertised per-visit savings.
// Match the membership/setup wording specifically — a bare /waveguard/ would
// also swallow tier-discount rows like "WaveGuard Silver — 10% off", which
// must stay in the net (they're part of what the customer actually paid).
function isSetupLineItem(line = {}) {
  return /membership|setup fee|waveguard setup/i.test(String(line.description || ''));
}

function invoiceLineItems(row = {}) {
  const raw = row.line_items;
  if (Array.isArray(raw)) return raw;
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch { return []; }
  }
  return [];
}

// Signed — discount/adjustment rows carry negative amounts and must reduce
// what counts as "last paid", not be dropped.
function lineItemAmount(line = {}) {
  const explicit = Number(line.amount);
  if (Number.isFinite(explicit) && explicit !== 0) return explicit;
  const qty = Number(line.quantity) || 1;
  const unit = Number(line.unit_price);
  return Number.isFinite(unit) ? unit * qty : 0;
}

// What the invoice charged for the SERVICE itself: the sum of its
// non-setup lines, falling back to the invoice total when there are no
// parseable line items.
function invoiceServiceAmount(row = {}) {
  const lines = invoiceLineItems(row);
  if (lines.length) {
    const serviceTotal = lines
      .filter((line) => !isSetupLineItem(line))
      .reduce((sum, line) => sum + lineItemAmount(line), 0);
    if (serviceTotal > 0) return round2(serviceTotal);
    // All lines were setup/membership (or discounts netted to zero) — not a
    // usable per-visit price.
    return null;
  }
  const total = Number(row.total);
  return Number.isFinite(total) && total > 0 ? round2(total) : null;
}

// What the customer actually LAST PAID per visit, by qualifying key — most
// recent paid invoice whose service_type maps to the key. Visit invoices
// minted from the schedule carry service_type; standalone setup/prepay
// invoices don't, so they never pollute this. Falls back to {} on any error
// so the snapshot still renders from scheduled_services.estimated_price.
// Keyed ACCOUNT-WIDE: invoices carry no property linkage here, so this newest
// amount reflects only ONE contract. When a key spans multiple per-property
// contracts, loadCurrentServiceSpendContext must not stamp it across all of
// them — it aggregates the per-contract scheduled prices instead.
async function loadLastPaidSpendByKey(database, customerId) {
  const spend = {};
  try {
    const rows = await database('invoices')
      .where({ customer_id: customerId })
      .whereIn('status', ['paid', 'prepaid'])
      .whereNotNull('service_type')
      .orderBy('paid_at', 'desc')
      .limit(100)
      .select('service_type', 'total', 'line_items', 'paid_at');
    for (const row of rows) {
      const key = accountServiceKey(row.service_type);
      if (!key || spend[key] != null) continue;
      const amount = invoiceServiceAmount(row);
      if (amount != null) {
        spend[key] = {
          amount,
          paidAt: row.paid_at || null,
        };
      }
    }
  } catch (err) {
    logger.warn(`[membership-context] last-paid lookup skipped for customer ${customerId}: ${err.message}`);
  }
  return spend;
}

// Staff-facing account snapshot used before pricing an expansion estimate.
// It says what the customer actively buys and what they currently spend per
// application. Paid invoice history is authoritative; the scheduled-service
// estimate is an explicit fallback, never presented as an actual payment.
async function loadCurrentServiceSpendContext(database, customerId, { existingRows = null } = {}) {
  if (!customerId) return {
    existingServiceKeys: [],
    currentServices: [],
    currentSpendPerVisitTotal: 0,
    currentTier: null,
    currentTierLabel: null,
    currentDiscountPct: 0,
  };

  const rows = Array.isArray(existingRows)
    ? existingRows
    : await loadActiveRecurringServiceRows(database, customerId);
  const qualifyingRows = Array.isArray(existingRows)
    ? existingRows
    : await loadExistingRecurringQualifyingRows(database, customerId);
  const existingServiceKeys = [...new Set(qualifyingRows
    .flatMap((row) => accountServiceKeys(row.service_type))
    .map((key) => toQualifyingKey(key))
    .filter(Boolean))];
  const currentTier = existingServiceKeys.length ? determineWaveGuardTier(existingServiceKeys) : null;
  const lastPaidByKey = await loadLastPaidSpendByKey(database, customerId);
  const byKey = new Map();
  const componentKeysByKey = new Map();
  const componentRowsByKey = new Map();
  for (const row of rows) {
    const key = accountServiceKey(row.service_type);
    if (!key) continue;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(row);
    const components = componentKeysByKey.get(key) || new Set();
    const componentRows = componentRowsByKey.get(key) || new Map();
    accountServiceKeys(row.service_type).forEach((component) => {
      components.add(component);
      if (!componentRows.has(component)) componentRows.set(component, []);
      componentRows.get(component).push(row);
    });
    componentKeysByKey.set(key, components);
    componentRowsByKey.set(key, componentRows);
  }

  const currentServices = [...byKey.entries()].map(([key, serviceRows]) => {
    const lastPaid = lastPaidByKey[key] || null;
    // Rows that share a stamped property address are successive visits of ONE
    // contract (a single per-visit price); distinct addresses are SEPARATE
    // per-property contracts that must EACH count toward spend — a
    // multi-property customer's second pest contract is real recurring spend,
    // not a duplicate visit row. Address grouping is only trusted when every
    // row is stamped: a mixed known/unknown set could split one contract into
    // two buckets and double-count it, so it collapses to the single-contract
    // treatment.
    const propertySplit = serviceRows.length > 0
      && serviceRows.every((row) => !!row.effective_service_address);
    // Clustered with the canonical street/unit comparator, never raw string
    // equality — '123 Main Street' vs '123 Main St' (or a stamp corrected
    // between generated visits) is formatting drift on ONE contract and must
    // not add its price once per spelling, while two explicit different units
    // at the same street are separate contracts. Each group keeps its first
    // row's raw stamp for display.
    const contractGroups = [];
    for (const row of serviceRows) {
      const group = propertySplit
        ? contractGroups.find((candidate) => sameStreetAddress(candidate.address, row.effective_service_address))
        : contractGroups[0];
      if (group) {
        group.rows.push(row);
      } else {
        contractGroups.push({
          address: propertySplit ? row.effective_service_address : null,
          rows: [row],
        });
      }
    }
    const contracts = contractGroups.map(({ address, rows: contractRows }) => {
      const scheduled = contractRows.find((row) => Number(row.estimated_price) > 0);
      return {
        serviceAddress: address,
        scheduledPerVisit: scheduled ? round2(scheduled.estimated_price) : null,
        activeScheduledVisits: contractRows.length,
      };
    });
    // The account-wide last-paid amount reflects ONE contract (no property
    // linkage on invoices), so the invoice basis only applies to a
    // single-contract key; per-property contracts each use their own
    // scheduled price rather than one contract's invoice standing in for all.
    const usableLastPaid = contracts.length === 1 ? lastPaid : null;
    const scheduledPerVisit = contracts.some((contract) => contract.scheduledPerVisit != null)
      ? round2(contracts.reduce((sum, contract) => sum + (Number(contract.scheduledPerVisit) || 0), 0))
      : null;
    const currentPerVisit = usableLastPaid?.amount ?? scheduledPerVisit;
    const scheduledDates = serviceRows.map((row) => row.scheduled_date).filter(Boolean).sort();
    const componentServiceAddresses = {};
    const componentServiceAddressesComplete = {};
    for (const [componentKey, componentRows] of componentRowsByKey.get(key) || []) {
      componentServiceAddresses[componentKey] = [...new Set(
        componentRows.map((row) => row.effective_service_address).filter(Boolean),
      )];
      componentServiceAddressesComplete[componentKey] = componentRows.length > 0
        && componentRows.every((row) => !!row.effective_service_address);
    }
    return {
      key,
      keys: [...(componentKeysByKey.get(key) || new Set([key]))],
      label: accountServiceLabel(key, serviceRows[0]?.service_type),
      qualifiesForWaveGuard: existingServiceKeys.includes(key),
      // Every property this service is active at — lets duplicate checks
      // scope to the quoted property instead of blocking account-wide.
      serviceAddresses: [...new Set(serviceRows.map((row) => row.effective_service_address).filter(Boolean))],
      // False when ANY active row's property is unknown: the unknown row
      // could cover the quoted street, so the duplicate check must fall back
      // to the account-wide block rather than trust the known-address subset.
      serviceAddressesComplete: serviceRows.length > 0
        && serviceRows.every((row) => !!row.effective_service_address),
      // A combined row contributes its address only to the components it
      // actually contains. Keeping this map separate prevents a pest-only
      // row at property B from making the lawn component of a Pest + Lawn
      // row at property A appear active at both properties.
      componentServiceAddresses,
      componentServiceAddressesComplete,
      currentPerVisit: currentPerVisit ?? null,
      spendSource: usableLastPaid ? 'last_paid_invoice' : (scheduledPerVisit != null ? 'scheduled_estimate' : 'unavailable'),
      lastPaidAt: usableLastPaid?.paidAt || null,
      scheduledPerVisit,
      // One entry per active per-property contract (a single entry when the
      // rows aren't property-split) so multi-property spend stays itemized.
      contracts,
      activeScheduledVisits: serviceRows.length,
      nextScheduledDate: scheduledDates[0] || null,
    };
  });

  return {
    existingServiceKeys,
    currentServices,
    currentSpendPerVisitTotal: round2(currentServices.reduce(
      (sum, service) => sum + (Number(service.currentPerVisit) || 0),
      0,
    )),
    currentTier: currentTier?.tier || null,
    currentTierLabel: currentTier ? (TIER_LABEL[currentTier.tier] || currentTier.tier) : null,
    currentDiscountPct: currentTier ? Math.round(currentTier.discount * 100) : 0,
  };
}

// The discount rate ACTUALLY applied to the estimate's recurring services,
// derived from the repriced aggregate (annualBeforeDiscount/After). For
// pest_control / tree_shrub the pricing engine's margin guard can cap the tier
// rate, so this can be lower than combinedTier.discount — using it keeps the
// card from advertising a larger member discount than the total includes.
// Falls back to the requested rate when the aggregate isn't available.
function appliedRecurringRate(estData, fallbackRate) {
  const rec = estData?.result?.recurring
    || estData?.engineResult?.recurring
    || estData?.recurring
    || {};
  const before = Number(rec.annualBeforeDiscount);
  const after = Number(rec.annualAfterDiscount);
  if (before > 0 && after >= 0 && after <= before) {
    return Math.max(0, Math.min(1, 1 - after / before));
  }
  const explicit = Number(rec.discount);
  if (explicit >= 0 && explicit <= 1) return explicit;
  return fallbackRate;
}

async function computeMembershipContext(database, { customerId, estData } = {}) {
  try {
    if (!customerId) return null;

    const customer = await database('customers').where({ id: customerId }).first();
    if (!customer || customer.active === false) return null;

    // ── Existing active recurring services on the account ──────
    // Shared loader — same source admin-estimate-persistence.js uses to reprice
    // the estimate, so the displayed tier matches the charged tier.
    const existingRows = await loadExistingRecurringQualifyingRows(database, customerId);

    const existingByKey = new Map();
    for (const row of existingRows) {
      // Combined scheduled-service labels represent every component for
      // membership and cross-sell purposes. A scalar toQualifyingKey call
      // keeps only the first match (for example pest from "Pest + Lawn"),
      // which makes the frozen snapshot disagree with Agent pricing.
      const componentKeys = toQualifyingKeys(row.service_type);
      for (const key of componentKeys) {
        if (!existingByKey.has(key)) existingByKey.set(key, []);
        existingByKey.get(key).push(row);
      }
    }
    const existingKeys = [...existingByKey.keys()];

    // ── New qualifying services in this estimate ───────────────
    const newKeys = estimateQualifyingKeys(estData || {});
    const addedKeys = newKeys.filter((k) => !existingKeys.includes(k));

    // No membership story to tell if there are no qualifying services on
    // either side (e.g. a one-off rodent job for an existing customer).
    if (existingKeys.length === 0 && addedKeys.length === 0) return null;

    // ── Combine & recompute tier ───────────────────────────────
    const oldTier = determineWaveGuardTier(existingKeys);
    const combinedTier = determineWaveGuardTier([...existingKeys, ...addedKeys]);
    const upgraded = combinedTier.discount > oldTier.discount;
    const delta = combinedTier.discount - oldTier.discount;
    const deltaPct = Math.round(delta * 100);

    // Existing service prices remain exactly as contracted. Their current
    // spend is retained for staff context, but the new combined tier applies
    // only to services priced in this estimate. Do NOT pass existingRows here:
    // those are the QUALIFYING rows only, and reusing them would drop non-tier
    // recurring work (rodent bait, palm injection) from the frozen snapshot
    // and underreport currentSpendPerVisitTotal.
    const currentSpend = await loadCurrentServiceSpendContext(database, customerId);
    const existingServices = [];

    // ── New-service member discount ────────────────────────────
    // Use the rate actually applied to the recurring total (margin-guard caps
    // included), never more than the combined tier rate, so the advertised
    // discount can't exceed what the charged total includes.
    const appliedRate = Math.min(combinedTier.discount, appliedRecurringRate(estData, combinedTier.discount));
    const newServices = addedKeys.map((key) => {
      const monthly = estimateMonthlyFor(estData, key);
      const perApplication = estimatePerApplicationFor(estData, key);
      return {
        key,
        label: SERVICE_LABEL[key] || key,
        discountPct: Math.round(appliedRate * 100),
        monthlySavings: monthly ? round2(monthly * appliedRate) : null,
        perApplicationSavings: perApplication ? round2(perApplication * appliedRate) : null,
      };
    });

    return {
      // "Existing customer" means the account already carries qualifying
      // recurring plan services — NOT merely that a customers row exists. A
      // brand-new lead can have a customers row (from intake/onsite) with zero
      // services; flagging it existing wrongly suppressed the annual-prepay
      // option and the WaveGuard setup fee on a fresh signup estimate. Mirror
      // the live plan-customer check in estimate-deposits.js, which keys off
      // the same loadExistingRecurringQualifyingRows rows.
      isExistingCustomer: existingKeys.length > 0,
      firstName: customer.first_name || null,
      tier: combinedTier.tier,
      tierLabel: TIER_LABEL[combinedTier.tier] || 'Bronze',
      tierDiscountPct: Math.round(combinedTier.discount * 100),
      upgrade: upgraded
        ? {
            fromLabel: TIER_LABEL[oldTier.tier] || 'Bronze',
            toLabel: TIER_LABEL[combinedTier.tier] || 'Bronze',
            deltaPct,
            addedServiceLabels: addedKeys.map((k) => SERVICE_LABEL[k] || k),
          }
        : null,
      // Raw qualifying keys already on the account — lets the public page
      // pick a cross-sell the customer doesn't already have (existingServices
      // above is only populated on a tier upgrade).
      existingServiceKeys: existingKeys,
      discountAppliesTo: 'new_services_only',
      currentServices: currentSpend.currentServices,
      currentSpendPerVisitTotal: currentSpend.currentSpendPerVisitTotal,
      existingServices,
      newServices,
    };
  } catch (err) {
    logger.warn(`[membership-context] compute skipped for customer ${customerId}: ${err.message}`);
    return null;
  }
}

// View-time accessor. Returns the membership snapshot that was frozen onto the
// estimate at save time (estimate_data.membershipSnapshot), so the card can
// NEVER diverge from the price saved/charged with the estimate. Estimates
// created before this snapshot existed (or that aren't customer-linked) simply
// have no snapshot and render no card — no risk of advertising an unapplied
// discount.
function buildEstimateMembershipContext(estimate) {
  try {
    const estData = parseEstimateData(estimate);
    const snapshot = estData && estData.membershipSnapshot;
    return snapshot && snapshot.isExistingCustomer ? snapshot : null;
  } catch {
    return null;
  }
}

module.exports = {
  buildEstimateMembershipContext,
  computeMembershipContext,
  loadCurrentServiceSpendContext,
};
