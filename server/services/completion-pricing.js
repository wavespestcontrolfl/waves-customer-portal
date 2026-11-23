/**
 * Job-scoped estimate evidence for Complete Service. Composes the existing
 * schedule line mapper, discount engine and stored appointment financials.
 * A review is checked again under completion's locks; it never accepts money
 * from the browser or looks up the customer's newest estimate.
 */
const crypto = require('crypto');
const db = require('../models/db');
const { isEnabled } = require('../config/feature-gates');
const { estimateQuotesCustomerAddress, normalizedEstimatePropertyKey, normalizedStampedStreet, samePropertyKey } = require('./estimate-property-linkage');
const { getEffectiveDiscount, lineFlagsBlockPercentDiscount } = require('./pricing-engine/discount-engine');
const { isActivePlanCustomer } = require('./waveguard-existing-services');
const { completionInvoiceAmount } = require('./billing-lane');
const { applyDiscount } = require('./booking/visit-financial-stamps');
const { splitTerminalCompletionInvoice } = require('./completion-invoice-candidate');
const { recurringServiceKey } = require('./estimate-converter');
const { LAWN_ROUNDS_9 } = require('./lawn-rounds');

const MONEY_FIELDS = [
  'estimated_price', 'primary_line_price', 'line_discount_id', 'line_discount_name',
  'line_discount_type', 'line_discount_amount', 'line_discount_dollars',
  'discount_id', 'discount_name', 'discount_type', 'discount_amount', 'discount_dollars',
  'discount_service_key_filter', 'discount_service_category_filter', 'discount_max_dollars',
];
const JOB_FIELDS = [
  'id', 'status', 'customer_id', 'property_id', 'service_id', 'service_type', 'service_key_snapshot',
  'service_category_snapshot', 'source_estimate_id', 'recurring_parent_id', 'recurring_pattern',
  'is_recurring', 'is_callback', 'scheduled_date', 'technician_id', 'payer_id', 'self_pay_override',
  'service_address_line1', 'service_address_line2', 'service_address_city', 'service_address_zip',
  'prepaid_amount', 'prepaid_method', 'annual_prepay_term_id', 'recurring_template_overrides',
  ...MONEY_FIELDS,
];
const CUSTOMER_FIELDS = ['id', 'active', 'waveguard_tier', 'billing_mode', 'per_application_fee', 'monthly_rate', 'payer_id'];
const LIVE_STATUSES = new Set(['pending', 'confirmed', 'rescheduled', 'en_route', 'on_site']);

function money(value) {
  if (!['number', 'string'].includes(typeof value) || String(value).trim() === '') return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) / 100 : null;
}
function firstMoney(...values) { return values.map(money).find((n) => n !== null) ?? null; }
function sameMoney(a, b) { return money(a) !== null && money(b) !== null && money(a) === money(b); }
function object(value) {
  if (typeof value === 'string') { try { return JSON.parse(value) || {}; } catch { return {}; } }
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}
function pick(row, fields) { return Object.fromEntries(fields.map((key) => [key, row?.[key] ?? null])); }
function reviewError(message = 'The job price or discount eligibility changed. Review pricing again.') {
  return Object.assign(new Error(message), { statusCode: 409, code: 'completion_pricing_changed', isOperational: true });
}

function scheduledPropertyKey(service) {
  return {
    street: normalizedStampedStreet(service.service_address_line1, service.service_address_line2),
    city: String(service.service_address_city || '').toLowerCase().replace(/[^a-z0-9]+/g, ''),
    zip: String(service.service_address_zip || '').slice(0, 5),
  };
}

// A visit with no property and no stamped address is at the customer's primary address: dispatch routes it there, and
// an accept at that address leaves its series unstamped (estimate-property-linkage.js). A row read without those
// columns proves nothing.
function unstampedVisit(service) {
  return 'property_id' in service && 'service_address_line1' in service
    && !service.property_id && !scheduledPropertyKey(service).street;
}

// `customer` (address_line1/2, city, zip) places an unstamped visit; without it an unstamped visit matches nothing.
function propertyMatches(service, estimate, customer = null) {
  if (service.property_id && estimate.property_id) return String(service.property_id) === String(estimate.property_id);
  if (customer && unstampedVisit(service)) return estimateQuotesCustomerAddress(estimate.address, customer);
  return samePropertyKey(normalizedEstimatePropertyKey(estimate.address), scheduledPropertyKey(service));
}

// A lawn rounds job is the 9x lawn plan. Estimate lines carry that plan as the
// scheduler's 'custom' with intervalDays 42 (or, from other sources, every_6_weeks).
function jobCadenceIsLineCadence(cadence, line) {
  if (cadence === LAWN_ROUNDS_9) {
    return line.cadence === LAWN_ROUNDS_9 || line.cadence === 'every_6_weeks'
      || (line.cadence === 'custom' && Number(line.intervalDays) === 42);
  }
  return cadence === line.cadence;
}

function matchServiceLine(job, lines) {
  const matches = lines.filter((line) => {
    if (job.service_id && line.serviceId) return String(job.service_id) === String(line.serviceId);
    if (job.service_key_snapshot && line.serviceKey) return job.service_key_snapshot === line.serviceKey;
    return false; // A fuzzy label cannot authorize a job's price.
  });
  if (matches.length !== 1) return { status: matches.length ? 'ambiguous' : 'unmatched', line: null };
  const line = matches[0];
  const cadence = job.recurring_pattern;
  if (cadence && line.cadence && !jobCadenceIsLineCadence(cadence, line)) return { status: 'unmatched', line: null };
  if ((job.is_recurring === true) !== (line.source === 'recurring')) return { status: 'unmatched', line: null };
  return { status: 'matched', line };
}

// The engine discounts the annual, so a tier-only line's saving can sit a few cents off rate × list price.
const TIER_ROUNDING_CENTS = 5;

function waveGuardTierName(tier) {
  const word = String(tier || '').trim().toLowerCase();
  return word ? `WaveGuard ${word[0].toUpperCase()}${word.slice(1)}` : 'WaveGuard';
}

const DISCOUNTED_TIERS = ['silver', 'gold', 'platinum'];
const tierWord = (value) => String(value || '').trim().toLowerCase();

// The WaveGuard tier an accepted estimate saved for its recurring work, with the rate it saved for that tier. The
// recurring block is the one on the saved result the service lines come from (estimate-public.js
// acceptanceServiceLists). The tier is the accept's: the estimate's column, else that block's. The rate is
// tierDiscountForEstimate's send snapshot (its keys are title case), else the block's own rate when the block names
// the same tier; an estimate that saved neither has rate 0 here, never today's tier table. `tier` is null when the
// column and the block name different tiers (the records conflict, so neither names a saving), and when the legacy
// nested block (result.results.recurring) also supplies service rows: which block priced a line is then unknown.
function savedEstimateTier(estimate, data) {
  const recurring = object(object(data.result || data.engineResult || data).recurring);
  const nested = object(object(object(data.result || data).results).recurring);
  const savedTier = tierWord(recurring.waveGuardTier || recurring.tier);
  const tier = tierWord(estimate.waveguard_tier) || savedTier;
  const discounted = [tier, savedTier, tierWord(nested.waveGuardTier || nested.tier)].some((word) => DISCOUNTED_TIERS.includes(word));
  const oneBlock = !(Array.isArray(nested.services) && nested.services.length);
  if (!oneBlock || !DISCOUNTED_TIERS.includes(tier) || (savedTier && savedTier !== tier)) return { recurring, discounted, tier: null };
  const { tierDiscountForEstimate } = require('../routes/estimate-public');
  const savedRate = savedTier === tier ? Number(recurring.discount) || 0 : 0;
  const amount = tierDiscountForEstimate(data, `${tier[0].toUpperCase()}${tier.slice(1)}`, savedRate);
  return { recurring, discounted, tier: { tier, amount } };
}

// Whether a stored staff discount record can reach recurring work. A saved recurring share of exactly 0 proves it is
// one-time only. Any other record (a positive share, no share saved, a blank or unreadable share, a value-only older
// shape that replays onto recurring work) reaches it whenever it carries a positive figure.
function staffRecordReachesRecurring(manual) {
  if (!manual || typeof manual !== 'object' || money(manual.recurringAmount) === 0) return false;
  return [manual.recurringAmount, manual.amount, manual.value].some((figure) => Number(figure) > 0);
}

// A staff discount on recurring work in any place the estimate persisted one: every stored summary spot
// (estimate-manual-discount-replay.js storedManualDiscountCandidates, not only the first positive one), on the mapped
// result and again on the engine's own result beside it, plus the record each recurring block may carry (the legacy
// recurring-scoped shape the schedule mapper also reads).
function staffDiscountOnRecurring(data, tierBlock) {
  const { storedManualDiscountCandidates } = require('./estimate-manual-discount-replay');
  const blocks = [object(data.result).recurring, data.recurring, object(data.engineResult).recurring, tierBlock];
  return [
    ...storedManualDiscountCandidates(data), ...storedManualDiscountCandidates({ ...data, result: undefined }),
    ...blocks.map((block) => object(block).manualDiscount),
  ].some(staffRecordReachesRecurring);
}

// What names an accepted estimate's savings: its own staff discount (applied after the tier) when that reaches
// recurring work, whether the estimate carries a WaveGuard tier saving at all, and its saved tier with that tier's
// rate (savedEstimateTier). `estimateTier` is null when a staff discount reaches recurring work in any saved shape:
// that discount shares each line's saving, so the tier alone cannot name it.
function estimateDiscountContext(estimate) {
  if (!estimate) return {};
  const { normalizeManualDiscountSummary } = require('../routes/estimate-public');
  const data = object(estimate.estimate_data);
  const manual = normalizeManualDiscountSummary(data);
  const reachesRecurring = !!manual && Number(manual.recurringAmount ?? manual.amount) > 0;
  const saved = savedEstimateTier(estimate, data);
  return {
    manualName: reachesRecurring ? String(manual.label || '').trim() || null : null,
    tierDiscounted: saved.discounted,
    estimateTier: staffDiscountOnRecurring(data, saved.recurring) ? null : saved.tier,
  };
}

function tierSavingsOn(base, rate) {
  return rate > 0 && rate <= 1 ? money(base - applyDiscount(base, 'percentage', rate * 100)) : null;
}

// A row whose accepted annual after staff's own change (manualFinalAnnual) is not its tier-discounted annual: staff
// moved this line's price, whatever the estimate's discount summary says.
function staffAdjustedRow(raw) {
  const adjusted = money(raw.manualFinalAnnual);
  return adjusted !== null && adjusted !== money(raw.annualAfterDiscount);
}

// The cents a tier rate leaves on a list price in cents: the exact cents, or either neighbour when they land on a
// half cent (the engine and applyDiscount round a half cent in opposite directions).
function tierNetCents(listCents, rate) {
  const cents = listCents * (1 - rate);
  return [Math.round(cents - 1e-6), Math.round(cents + 1e-6)];
}

// Whether a list-price row's own saved figures prove the tier's rate priced it, to the cent. A row with its own
// per-application net must be billed at that net, and it must be the tier's net on the list price. Any other row is
// billed from its saved annual (public-quote.js perApplicationForLine, same visit count): that annual must be the
// tier's annual on the annual list price, and the billed net its per-visit share. The annual list price is list price
// x visits, or the row's own saved annual list when the list price is its rounded per-visit share (the engine prices
// lawn and tree programs from the annual). A row with neither proves nothing.
function tierPricedRow(raw, base, savings, rate) {
  if (!(rate > 0 && rate <= 1)) return false;
  const baseCents = Math.round(base * 100);
  const netCents = Math.round((base - savings) * 100);
  const ownNet = money(raw.priceAfterDiscount);
  if (ownNet !== null) return Math.round(ownNet * 100) === netCents && tierNetCents(baseCents, rate).includes(netCents);
  const visits = [raw.visitsPerYear, raw.visits, raw.appsPerYear, raw.frequency].map(Number).find((count) => count > 0);
  const annual = money(raw.annualAfterDiscount);
  if (!visits || !(annual > 0) || Math.round((annual / visits) * 100) !== netCents) return false;
  const savedLists = [raw.annualBeforeDiscount, raw.annual].map(money)
    .filter((list) => list !== null && Math.round((list / visits) * 100) === baseCents);
  return [baseCents * visits, ...savedLists.map((list) => Math.round(list * 100))]
    .some((listCents) => tierNetCents(listCents, rate).includes(Math.round(annual * 100)));
}

// A discount rate the row itself recorded (the legacy mapper writes one on lawn rows, with no tier record) that is not
// the estimate's tier rate: the row says it took another rate, or none.
function rowRateConflicts(raw, rate) {
  const discount = object(raw.discount);
  return [discount.appliedDiscountPercent, discount.effectiveDiscount]
    .some((recorded) => recorded != null && Number(recorded) !== Number(rate));
}

// Whether a tier share can hide in what is left of a row's saving on a tier estimate: the row carries no discount
// record at all, or it recorded a rate of its own above zero and that share is not already its own row (`tierRowed`).
function tierShareHidden(raw, tierRowed) {
  if (!raw.discount) return true;
  const discount = object(raw.discount);
  return !tierRowed && [discount.appliedDiscountPercent, discount.effectiveDiscount].some((recorded) => Number(recorded) > 0);
}

// The tier record that names a line's saving. The one on the line wins. Saved engine rows keep the tier on the
// estimate's recurring block instead, with the list price on the row: such a line takes the estimate's tier only when
// the row's saved figures prove that tier's rate priced it (tierPricedRow), no service credit shares the saving, the
// row's service takes the tier percentage (estimate-public.js recurringServiceReceivesTierDiscount: not palm
// injection's flat credit, not a legacy rodent row), the row is not flagged out of percentage discounts and staff did
// not move the row's own price, and a rate the row recorded for itself is the tier's rate. The service is the row's
// own key, else the key the schedule matched the line to (`serviceKey`), the order the schedule mapper uses.
function namingTier(raw, base, savings, { estimateTier, credited, serviceKey }) {
  const lineTier = (object(raw.discount).appliedDiscounts || []).find((item) => item.type === 'waveguard');
  const inferable = !credited && !!estimateTier && !lineFlagsBlockPercentDiscount(raw) && !staffAdjustedRow(raw)
    && !rowRateConflicts(raw, estimateTier.amount)
    // The eligibility the row saved at the estimate wins over today's configuration (a false one is refused above).
    && (raw.waveGuardDiscountEligible === true || require('../routes/estimate-public')
      .recurringServiceReceivesTierDiscount({ ...raw, service: raw.service || serviceKey || undefined }));
  if (lineTier || !inferable) return lineTier || null;
  return tierPricedRow(raw, base, savings, Number(estimateTier.amount)) ? estimateTier : null;
}

// One line's accepted saving split into the discounts that made it: the WaveGuard tier (namingTier), then the
// estimate's staff discount. `named` is false for a part the estimate does not name (a service credit, a list-price
// row's saving that is not the estimate's tier rate, anything else unexplained): the card shows it, an invoice never
// prints it.
function acceptedDiscountRows(raw, base, savings, { manualName = null, tierDiscounted = false, estimateTier = null, serviceKey = null } = {}) {
  if (!(savings > 0)) return [];
  const credited = (Array.isArray(raw.serviceSpecificDiscounts) ? raw.serviceSpecificDiscounts : [])
    .some((credit) => Number(credit?.amount) > 0);
  const tier = namingTier(raw, base, savings, { estimateTier, credited, serviceKey });
  const tierRate = Number(tier?.amount);
  const tierSavings = tierSavingsOn(base, tierRate);
  const rows = [];
  let rest = savings;
  if (tierSavings !== null) {
    const tierOnly = !manualName && !credited && Math.round((savings - tierSavings) * 100) <= TIER_ROUNDING_CENTS;
    const dollars = tierOnly ? savings : Math.min(tierSavings, savings);
    rows.push({ name: waveGuardTierName(tier.tier), percent: tierRate * 100, dollars, named: true });
    rest = money(savings - dollars);
  }
  if (rest > 0) {
    // The rest is the staff discount's only when no tier share can hide in it (tierShareHidden).
    const named = !!manualName && !credited && !(tierDiscounted && tierShareHidden(raw, rows.length > 0));
    rows.push({ name: named ? manualName : rows.length ? 'Other accepted discount' : 'Accepted estimate discount', dollars: rest, named });
  }
  return rows;
}

function acceptedPricing(line, discountContext = {}) {
  const raw = line.sourceLine || {};
  const recurring = line.source === 'recurring';
  const unit = line.monthlyPrice != null ? 'month' : recurring ? 'application' : 'one_time';
  const amounts = {
    application: firstMoney(line.perApplicationPrice), month: firstMoney(line.monthlyPrice),
    one_time: firstMoney(line.acceptedOneTimePrice, raw.manualFinalOneTime, raw.priceAfterDiscount, line.price),
  };
  const bases = { month: null, application: firstMoney(raw.perTreatment, raw.perApp, raw.perVisit),
    one_time: firstMoney(raw.priceBeforeDiscount, raw.price, raw.amount) };
  const amount = amounts[unit]; const base = bases[unit];
  const discount = object(raw.discount);
  const complete = amount !== null && base !== null && base >= amount;
  const savings = complete ? money(base - amount) : null;
  return {
    amount, unit, base, savings, breakdownAvailable: complete,
    // The staff discount is named only on recurring applications, the work it reaches.
    discounts: acceptedDiscountRows(raw, base, savings, unit === 'application' ? { ...discountContext, serviceKey: line.serviceKey } : {}),
    // A bare list figure cannot justify another percentage on a legacy net.
    provenUndiscounted: complete && savings === 0 && !line.parentRecurringDiscounted
      && money(raw.manualFinalAnnual) === null
      && (raw.priceAfterDiscount != null || discount.effectiveDiscount === 0)
      && !(Number(discount.effectiveDiscount) > 0),
  };
}

function storedDiscount(row, prefix = '') {
  const dollars = money(row?.[`${prefix}discount_dollars`]);
  if (!(dollars > 0)) return null;
  const type = row[`${prefix}discount_type`];
  return {
    name: row[`${prefix}discount_name`] || 'Recorded discount', dollars,
    ...(['percentage', 'variable_percentage'].includes(type) ? { percent: money(row[`${prefix}discount_amount`]) } : {}),
    id: row[`${prefix}discount_id`] || null,
  };
}

function scheduledLines(service, addons) {
  const base = money(service.primary_line_price);
  const primaryDiscount = storedDiscount(service, 'line_');
  const primaryAmount = base !== null ? money(Math.max(0, base - (primaryDiscount?.dollars || 0)))
    : addons.length === 0 ? money(service.estimated_price) : null;
  return [{ id: 'primary', job: service, base, amount: primaryAmount, discount: primaryDiscount,
    discountRecorded: [service.line_discount_id, service.line_discount_type, primaryDiscount].some(Boolean) }, ...addons.map((addon) => ({
    id: String(addon.id),
    job: { ...service, service_id: addon.service_id, service_type: addon.service_name,
      service_key_snapshot: addon.service_key_snapshot, recurring_pattern: addon.recurring_pattern || service.recurring_pattern },
    base: money(addon.base_price), amount: money(addon.estimated_price), discount: storedDiscount(addon),
    discountRecorded: [addon.discount_id, addon.discount_type, addon.discount_dollars].some(Boolean),
  }))];
}

function discountProposal({ entry, quote, line, service, estimate, tierRate, activeMember, blocked }) {
  if (blocked || quote.unit !== 'application') return null;
  // Do not overwrite a recorded price decision, combine an unknown stack,
  // or let a one-application add-on adjustment change the series template.
  if (entry.discountRecorded || (entry.id !== 'primary' && service.is_recurring && !service.recurring_parent_id)) return null;
  if (quote.savings > 0 && sameMoney(entry.amount, quote.base)) {
    return { kind: 'accepted', name: 'Accepted estimate discounts', base: quote.base, amount: quote.amount,
      dollars: quote.savings, discounts: quote.discounts };
  }
  if (lineFlagsBlockPercentDiscount(line.sourceLine) || !activeMember || !quote.provenUndiscounted || !sameMoney(entry.amount, quote.amount)) return null;
  const tier = String(estimate.waveguard_tier || '').toLowerCase();
  if (tier !== tierRate.tier) return null;
  const key = recurringServiceKey({ service: line.sourceLine.service || line.serviceKey });
  const benefit = getEffectiveDiscount(key, tierRate);
  if (!(benefit.effectiveDiscount > 0)) return null;
  const percent = benefit.effectiveDiscount * 100;
  const amount = applyDiscount(quote.base, 'percentage', percent);
  const dollars = money(quote.base - amount);
  return dollars > 0 ? { kind: 'tier', name: `WaveGuard ${estimate.waveguard_tier}`, base: quote.base,
    amount, dollars, percent, discounts: [{ name: `WaveGuard ${estimate.waveguard_tier}`, percent, dollars }] } : null;
}

async function readEstimate(service, database) {
  let estimateId = service.source_estimate_id;
  let parent = null;
  if (!estimateId && service.recurring_parent_id) {
    parent = await database('scheduled_services').where({ id: service.recurring_parent_id }).first();
    const sameService = parent?.service_id && service.service_id
      ? parent.service_id === service.service_id
      : Boolean(parent?.service_key_snapshot && parent.service_key_snapshot === service.service_key_snapshot);
    if (parent?.customer_id === service.customer_id && sameService) {
      const sameProperty = parent.property_id && service.property_id
        ? parent.property_id === service.property_id
        : samePropertyKey(scheduledPropertyKey(parent), scheduledPropertyKey(service));
      if (sameProperty) estimateId = parent.source_estimate_id;
    }
  }
  if (!estimateId) return { status: 'unlinked', estimate: null, parent };
  const estimate = await database('estimates').where({ id: estimateId }).first();
  if (!estimate || String(estimate.customer_id) !== String(service.customer_id)) return { status: 'unlinked', estimate: null, parent };
  if (estimate.status !== 'accepted') return { status: 'not_accepted', estimate: null, parent };
  const customer = unstampedVisit(service)
    ? await database('customers').where({ id: service.customer_id }).first('address_line1', 'address_line2', 'city', 'zip') : null;
  if (!propertyMatches(service, estimate, customer)) return { status: 'property_mismatch', estimate: null, parent };
  return { status: 'linked', estimate, parent };
}

// The estimate's lines in schedule terms, matched to the catalog the way the schedule maps them.
async function estimateScheduleLines(database, estimate) {
  const catalog = await database('services').select('id', 'service_key', 'name', 'short_name', 'category', 'billing_type', 'frequency', 'visits_per_year', 'default_duration_minutes');
  const { indexServicesForSchedule, scheduleLinesFromEstimate } = require('../routes/admin-customers')._private;
  return scheduleLinesFromEstimate(estimate, indexServicesForSchedule(catalog), { includeSourceLines: true });
}

async function discountedVisit(service, addons, proposals, database) {
  let patch = null;
  const addonPatches = [];
  if (proposals.length) {
    const changed = { ...service };
    const changedAddons = addons.map((row) => ({ ...row }));
    for (const proposal of proposals) {
      if (proposal.jobLineId === 'primary') {
        Object.assign(changed, { primary_line_price: proposal.base, line_discount_id: null,
          line_discount_name: proposal.name, line_discount_type: 'fixed_amount',
          line_discount_amount: proposal.dollars, line_discount_dollars: proposal.dollars });
      } else {
        const target = changedAddons.find((row) => String(row.id) === proposal.jobLineId);
        const fields = { base_price: proposal.base, estimated_price: proposal.amount, discount_id: null,
          discount_name: proposal.name, discount_type: 'fixed_amount', discount_amount: proposal.dollars, discount_dollars: proposal.dollars };
        Object.assign(target, fields);
        addonPatches.push({ id: target.id, fields });
      }
    }
    const { calculateStoredVisitFinancials, loadStoredDiscountScope } = require('../routes/admin-schedule')._test;
    const scope = await loadStoredDiscountScope(database, changed, changedAddons);
    const prior = calculateStoredVisitFinancials(service, addons, addons, scope);
    if (!sameMoney(prior.price ?? 0, service.estimated_price)) return { patch: null, addonPatches: [] };
    const financials = calculateStoredVisitFinancials(changed, changedAddons, addons, scope);
    if (!((financials.price ?? 0) < Number(service.estimated_price))) return { patch: null, addonPatches: [] };
    changed.discount_dollars = financials.appointmentDiscountDollars;
    changed.estimated_price = financials.price ?? 0;
    patch = { ...Object.fromEntries(MONEY_FIELDS.filter((key) => changed[key] !== service[key]).map((key) => [key, changed[key]])),
      estimated_price: changed.estimated_price, discount_dollars: changed.discount_dollars };
  }
  return { patch, addonPatches };
}

// Live eligibility and catalog stacking are read together, and held stable
// during completion's transaction. Display and persistence use this same read.
async function completionDiscountRules(database, customer, service, lockRules) {
  const rateQuery = database('pricing_config').where({ config_key: 'waveguard_tiers' });
  const rateRow = await (lockRules ? rateQuery.forShare() : rateQuery).first();
  const tier = String(customer.waveguard_tier || '').toLowerCase();
  const rate = object(rateRow?.data)[tier]?.discount;
  const tierRate = { tier, discount: typeof rate === 'number' && rate >= 0 && rate <= 1 ? rate : 0 };
  const activeMember = await isActivePlanCustomer(database, customer.id, { strict: true });
  const savedDiscountQuery = service.discount_id ? database('discounts').where({ id: service.discount_id }) : null;
  const savedDiscount = savedDiscountQuery ? await (lockRules ? savedDiscountQuery.forShare() : savedDiscountQuery).first() : null;
  // Only an explicitly stackable, fixed catalog adjustment is independent
  // of the tier calculation. Unknown/percentage stacks need office review.
  const canStack = savedDiscount?.is_stackable === true && !savedDiscount.is_waveguard_tier_discount
    && ['fixed_amount', 'variable_amount'].includes(service.discount_type);
  return { tierRate, rateRow, savedDiscount, activeMember, canStack,
    tierRulesAvailable: rateRow != null && typeof rate === 'number' && rate >= 0 && rate <= 1 };
}

function frozenPricingAmount(notes) {
  const cents = object(notes).completionPricing?.amountCents;
  return Number.isSafeInteger(cents) && cents >= 0 ? cents / 100 : null;
}

async function completedApplicationPrice(database, service) {
  if (service.status !== 'completed') return null;
  const record = await database('service_records').where({ scheduled_service_id: service.id })
    .orderBy('created_at', 'desc').first('structured_notes');
  return frozenPricingAmount(record?.structured_notes);
}

async function loadCompletionPricing(serviceId, { database = db, role = 'technician', lockRules = false } = {}) {
  const service = await database('scheduled_services').where({ id: serviceId }).first();
  if (!service) throw reviewError('Scheduled service not found.');
  const customer = await database('customers').where({ id: service.customer_id }).first();
  if (!customer) throw reviewError('The job customer could not be verified.');
  const addons = await database('scheduled_service_addons').where({ scheduled_service_id: service.id }).orderBy('id');
  const source = await readEstimate(service, database);
  const attachedInvoices = await database('invoices').where({ scheduled_service_id: service.id })
    .select('id', 'status', 'total').orderBy('id');
  const invoiceRows = attachedInvoices.filter((row) => {
    const { existing, terminal } = splitTerminalCompletionInvoice(row);
    return existing || terminal; // Refunded still blocks; canceled/void rows do not.
  });
  const { tierRate, rateRow, savedDiscount, activeMember, canStack, tierRulesAvailable } =
    await completionDiscountRules(database, customer, service, lockRules);
  const lines = source.estimate ? await estimateScheduleLines(database, source.estimate) : [];
  const discountContext = estimateDiscountContext(source.estimate);
  const appointmentDiscount = storedDiscount(service);
  const unavailable = [
    role !== 'admin',
    !LIVE_STATUSES.has(service.status), service.is_callback, invoiceRows.length > 0,
    Number(service.prepaid_amount) > 0, service.annual_prepay_term_id,
    !['per_application', 'per_visit'].includes(customer.billing_mode), money(service.estimated_price) === null,
    service.is_recurring && !service.recurring_parent_id
      && (!Object.hasOwn(service, 'recurring_template_overrides') || !isEnabled('editApptPriceServiceScope')),
  ];
  const blocked = unavailable.some(Boolean);
  const proposals = [];
  const matchedLines = scheduledLines(service, addons).map((entry) => {
    const match = matchServiceLine(entry.job, lines);
    const quote = match.line ? acceptedPricing(match.line, discountContext) : null;
    const proposal = quote ? discountProposal({ entry, quote, line: match.line, service, estimate: source.estimate,
      tierRate, activeMember, blocked: blocked || ((!!service.discount_id || !!service.discount_type) && !canStack) }) : null;
    if (proposal) proposals.push({ ...proposal, jobLineId: entry.id });
    return {
      jobLineId: entry.id, serviceName: entry.job.service_type, status: source.status === 'linked' ? match.status : source.status,
      sourceLineKey: match.line?.sourceLineKey || null,
      quote: quote && pick(quote, ['amount', 'unit', 'base', 'discounts', 'savings', 'breakdownAvailable']),
      scheduledAmount: entry.amount, scheduledBase: entry.base, scheduledDiscount: entry.discount,
      proposal,
    };
  });
  const { patch, addonPatches } = await discountedVisit(service, addons, proposals, database);
  const completedAmount = await completedApplicationPrice(database, service);
  const currentCharge = completionInvoiceAmount({ estimatedPrice: service.estimated_price, isCallback: service.is_callback,
    perApplicationBilling: customer.billing_mode === 'per_application', perApplicationFee: customer.per_application_fee,
    monthlyRate: customer.monthly_rate, billingMode: customer.billing_mode,
    // Codex round 4 P1 follow-through: `service` is the full scheduled_services
    // row, so primary_line_price is on it — pass it or a fully-discounted $0
    // review misreads its own frozen zero as unpriced and falls back to the fee.
    primaryLinePrice: service.primary_line_price,
    // A consultation (Waves Assessment) never takes the per-application fee.
    serviceType: service.service_type });
  const view = {
    serviceId: service.id, estimate: source.estimate ? { id: source.estimate.id, reference: source.estimate.estimate_slug,
      status: source.estimate.status, tier: source.estimate.waveguard_tier,
      pdfUrl: source.estimate.token ? `/api/estimates/${encodeURIComponent(source.estimate.token)}/pdf` : null } : null,
    lines: matchedLines, appointmentDiscount, proposedAppointmentDiscount: patch && appointmentDiscount
      ? { ...appointmentDiscount, dollars: money(patch.discount_dollars) || 0 } : null, currentAmount: firstMoney(completedAmount, currentCharge > 0 ? currentCharge : null, service.estimated_price),
    completedPrice: completedAmount !== null,
    proposedAmount: patch ? money(patch.estimated_price) : null,
    canApply: patch !== null, tier: customer.waveguard_tier,
    tierRulesAvailable,
    alreadyInvoiced: invoiceRows.length > 0,
  };
  const witness = crypto.createHash('sha256').update(JSON.stringify({
    service: pick(service, JOB_FIELDS), customer: pick(customer, CUSTOMER_FIELDS), addons,
    estimate: pick(source.estimate, ['id', 'customer_id', 'property_id', 'address', 'status', 'estimate_data', 'waveguard_tier']),
    parent: pick(source.parent, JOB_FIELDS), rates: rateRow?.data ?? null, savedDiscount, invoiceRows, view,
  })).digest('hex');
  return { view: { ...view, witness }, service, source, patch, addonPatches, proposals };
}

async function prepareCompletionPricingReview(serviceId, review, options = {}) {
  if (!review || typeof review.witness !== 'string' || !/^[a-f0-9]{64}$/.test(review.witness)
    || typeof review.applyDiscounts !== 'boolean') throw reviewError('Review the service price before completing.');
  const plan = await loadCompletionPricing(serviceId, options);
  if (plan.view.witness !== review.witness || (review.applyDiscounts && !plan.view.canApply)) throw reviewError();
  return { ...plan, review, apply: review.applyDiscounts };
}

async function committedCompletionPrice(database, serviceRecordId, review) {
  const row = await database('service_records').where({ id: serviceRecordId }).first('structured_notes');
  const frozen = object(row?.structured_notes).completionPricing;
  const amount = frozenPricingAmount(row?.structured_notes);
  if (!frozen || frozen.witness !== review.witness || amount === null) {
    throw Object.assign(reviewError('The committed completion price could not be verified. Reopen this job’s billing review.'),
      { code: 'completion_pricing_resume_unavailable' });
  }
  return amount;
}

async function lockCompletionPricingEstimate(database, plan) {
  if (plan.source.estimate) await database('estimates').where({ id: plan.source.estimate.id }).forShare().first('id');
}

async function lockCompletionPricingParent(database, plan) {
  if (plan.source.parent) await database('scheduled_services').where({ id: plan.source.parent.id }).forShare().first('id');
}

async function commitCompletionPricingReview(database, plan, { role, technicianId }) {
  const fresh = await prepareCompletionPricingReview(plan.service.id, plan.review, { database, role, lockRules: true });
  if (!fresh.apply) return;
  const { computePriceServiceGroupChanges, pickUnpinnedGroupFields, parseTemplateOverrides,
    readProvenanceOverrides, stampRecurringTemplateOverrides } = require('../routes/admin-schedule')._test;
  const before = fresh.service;
  if (before.is_recurring && !before.recurring_parent_id) {
    const groups = computePriceServiceGroupChanges(before, fresh.patch);
    const pinned = pickUnpinnedGroupFields(parseTemplateOverrides(before.recurring_template_overrides), groups,
      before, readProvenanceOverrides(before.recurring_template_overrides));
    if (Object.keys(pinned).length) await stampRecurringTemplateOverrides(database, before.id, pinned, { recurring_template_overrides: true });
  }
  await database('scheduled_services').where({ id: before.id }).update({ ...fresh.patch, updated_at: new Date() });
  for (const addon of fresh.addonPatches) {
    await database('scheduled_service_addons').where({ id: addon.id, scheduled_service_id: before.id }).update(addon.fields);
  }
  await database('activity_log').insert({ customer_id: before.customer_id, action: 'completion_discount_applied',
    description: `Service ${before.id}: completion discount changed this application's price from ${fresh.view.currentAmount} to ${fresh.view.proposedAmount}; actor ${technicianId}.`,
    metadata: JSON.stringify({ scheduledServiceId: before.id, estimateId: fresh.source.estimate?.id,
      witness: fresh.view.witness, discounts: fresh.proposals }) });
}

// Whether a visit row carries a price decision completion pricing honors over estimated_price (scheduledLines): a
// primary-line price, or a recorded line or appointment discount. A caller that prices a visit by estimated_price alone
// (the phone-yes tap) refuses such a row, since the bill would not be the price it set.
function visitPriceDecisionRecorded(service) {
  const [primary] = scheduledLines(service, []);
  return primary.base !== null || primary.discountRecorded
    || [service.discount_id, service.discount_type, storedDiscount(service)].some(Boolean);
}

// The accepted estimate's discounts for ONE visit's invoice (owner 2026-11-22: a visit booked from an accepted estimate
// prints its WaveGuard tier and the estimate's own discount as their own lines). { breakdown: { base, amount,
// discounts: [{ name, dollars }] } } only while the visit still bills exactly the accepted per-application price with
// nothing recorded of its own (no primary price, discount, add-on or prepayment) and the estimate names every dollar of
// the saving; otherwise { breakdown: null, reason }. Read-only. base − Σ dollars = amount = the visit's own price.
// `firstApplication`: the first bill at acceptance, which also bills the first visits a multi-program accept leaves
// unpriced (the bill covers them) at the accepted price, and a visit with no saving at its own price (discounts: []),
// so one undiscounted program does not keep a bundle's discounts off that bill; that caller reconciles its total.
// A breakdown, and reason discount_unnamed, also carry `estimate` (the accepted estimate row read here) and `line` (the
// schedule line the visit matched, by service id or key: its saved row is `line.sourceLine`, the key it matched
// `line.serviceKey`), so a check of the estimate's own records prices the same line (invoice-tier-line-check.js).
async function acceptedVisitBreakdown(service, { database = db, firstApplication = false } = {}) {
  const none = (reason) => ({ breakdown: null, reason });
  const unpricedFirst = firstApplication && service.estimated_price == null;
  if (!unpricedFirst && !(money(service.estimated_price) > 0)) return none('not_priced');
  if (visitPriceDecisionRecorded(service)) return none('own_price_or_discount');
  if (Number(service.prepaid_amount) > 0 || service.annual_prepay_term_id) return none('prepaid');
  if (await database('scheduled_service_addons').where({ scheduled_service_id: service.id }).first('id')) return none('add_ons');
  const source = await readEstimate(service, database);
  if (source.status !== 'linked') return none(`estimate_${source.status}`);
  const match = matchServiceLine(service, await estimateScheduleLines(database, source.estimate));
  if (match.status !== 'matched') return none(`line_${match.status}`);
  const quote = acceptedPricing(match.line, estimateDiscountContext(source.estimate));
  if (quote.unit !== 'application') return none('not_per_application');
  if (!quote.breakdownAvailable) return none('no_breakdown');
  if (!(quote.savings > 0) && !firstApplication) return none('no_discount');
  if (!unpricedFirst && !sameMoney(service.estimated_price, quote.amount)) return none('price_changed');
  const matched = { estimate: source.estimate, line: match.line };
  if (!quote.discounts.every((row) => row.named)) return { ...none('discount_unnamed'), ...matched };
  return { breakdown: { base: quote.base, amount: quote.amount, discounts: quote.discounts.map(({ name, dollars }) => ({ name, dollars })) }, ...matched };
}

module.exports = { MONEY_FIELDS, visitPriceDecisionRecorded, loadCompletionPricing, prepareCompletionPricingReview, lockCompletionPricingEstimate,
  commitCompletionPricingReview, lockCompletionPricingParent, committedCompletionPrice, acceptedPricing, acceptedVisitBreakdown,
  matchServiceLine, propertyMatches, money, estimateDiscountContext, staffDiscountOnRecurring };
