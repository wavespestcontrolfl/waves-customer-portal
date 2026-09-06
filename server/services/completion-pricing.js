/**
 * Job-scoped estimate evidence for Complete Service. Composes the existing
 * schedule line mapper, discount engine and stored appointment financials.
 * A review is checked again under completion's locks; it never accepts money
 * from the browser or looks up the customer's newest estimate.
 */
const crypto = require('crypto');
const db = require('../models/db');
const { isEnabled } = require('../config/feature-gates');
const { normalizedEstimatePropertyKey, normalizedStampedStreet, samePropertyKey } = require('./estimate-property-linkage');
const { getEffectiveDiscount, lineFlagsBlockPercentDiscount } = require('./pricing-engine/discount-engine');
const { isActivePlanCustomer } = require('./waveguard-existing-services');
const { completionInvoiceAmount } = require('./billing-lane');
const { applyDiscount } = require('./booking/visit-financial-stamps');

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
  if (value == null || typeof value === 'boolean' || String(value).trim() === '') return null;
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

function propertyMatches(service, estimate) {
  if (service.property_id && estimate.property_id) return String(service.property_id) === String(estimate.property_id);
  return samePropertyKey(normalizedEstimatePropertyKey(estimate.address), scheduledPropertyKey(service));
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
  if (cadence && line.cadence && cadence !== line.cadence) return { status: 'unmatched', line: null };
  if ((job.is_recurring === true) !== (line.source === 'recurring')) return { status: 'unmatched', line: null };
  return { status: 'matched', line };
}

function acceptedDiscountRows(discount, base, savings) {
  if (!(savings > 0)) return [];
  const tier = (discount.appliedDiscounts || []).find((item) => item.type === 'waveguard');
  const tierRate = Number(tier?.amount);
  const tierSavings = tierRate > 0 && tierRate <= 1
    ? money(base - applyDiscount(base, 'percentage', tierRate * 100)) : null;
  const rows = [];
  if (tierSavings !== null && tierSavings <= savings) {
    rows.push({ name: `WaveGuard ${tier.tier || ''}`.trim(), percent: tierRate * 100, dollars: tierSavings });
  }
  const remaining = money(savings - (rows[0]?.dollars || 0));
  if (remaining > 0) rows.push({ name: rows.length ? 'Other accepted discount' : 'Accepted estimate discount', dollars: remaining });
  return rows;
}

function acceptedPricing(line) {
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
    discounts: acceptedDiscountRows(discount, base, savings),
    // A bare list figure cannot justify another percentage on a legacy net.
    provenUndiscounted: complete && savings === 0 && !line.parentRecurringDiscounted
      && raw.manualFinalAnnual == null
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
  const appointmentAdjusted = Boolean(service.discount_type || service.discount_id);
  if (!appointmentAdjusted && quote.savings > 0 && sameMoney(entry.amount, quote.base)) {
    return { kind: 'accepted', name: 'Accepted estimate discounts', base: quote.base, amount: quote.amount,
      dollars: quote.savings, discounts: quote.discounts };
  }
  if (lineFlagsBlockPercentDiscount(line.sourceLine) || !activeMember || !quote.provenUndiscounted || !sameMoney(entry.amount, quote.amount)) return null;
  const tier = String(estimate.waveguard_tier || '').toLowerCase();
  if (tier !== tierRate.tier) return null;
  const key = line.sourceLine.service || line.serviceKey;
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
    if (parent?.customer_id === service.customer_id && parent.service_id === service.service_id) {
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
  if (!propertyMatches(service, estimate)) return { status: 'property_mismatch', estimate: null, parent };
  return { status: 'linked', estimate, parent };
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
  const invoiceRows = await database('invoices').where({ scheduled_service_id: service.id }).whereNotIn('status', ['void', 'cancelled']).select('id', 'status', 'total').orderBy('id');
  const { tierRate, rateRow, savedDiscount, activeMember, canStack, tierRulesAvailable } =
    await completionDiscountRules(database, customer, service, lockRules);
  const catalog = await database('services').select('id', 'service_key', 'name', 'short_name', 'category', 'billing_type', 'frequency', 'visits_per_year', 'default_duration_minutes');
  const { indexServicesForSchedule, scheduleLinesFromEstimate } = require('../routes/admin-customers')._private;
  const lines = source.estimate ? scheduleLinesFromEstimate(source.estimate, indexServicesForSchedule(catalog), { includeSourceLines: true }) : [];
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
    const quote = match.line ? acceptedPricing(match.line) : null;
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
    monthlyRate: customer.monthly_rate, billingMode: customer.billing_mode });
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

module.exports = { loadCompletionPricing, prepareCompletionPricingReview, lockCompletionPricingEstimate,
  commitCompletionPricingReview, lockCompletionPricingParent, committedCompletionPrice, acceptedPricing, matchServiceLine, propertyMatches, money };
