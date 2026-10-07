const { savepointRead } = require('../utils/savepoint-read');
const { isPreEmergent } = require('./service-report/lawn-watering-rule');

function normalizeText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function rateUnitsMatch(a, b) {
  const left = normalizeText(a).replace(/\s+/g, '_');
  const right = normalizeText(b).replace(/\s+/g, '_');
  if (!left || !right) return false;
  const aliases = {
    floz: 'fl_oz',
    'fl oz': 'fl_oz',
    fluid_ounce: 'fl_oz',
    fluid_ounces: 'fl_oz',
    lbs: 'lb',
    pounds: 'lb',
    ounces: 'oz',
  };
  return (aliases[left] || left) === (aliases[right] || right);
}

function collectProductIds(sections) {
  const ids = new Set();
  for (const section of sections) {
    for (const item of section || []) {
      if (item?.product?.id) ids.add(String(item.product.id));
      if (item?.productId) ids.add(String(item.productId));
    }
  }
  return ids;
}

function productGroups(product) {
  const groups = [
    ['moa', product?.moa_group],
    ['frac', product?.frac_group],
    ['irac', product?.irac_group],
    ['hrac', product?.hrac_group],
    ['hrac', product?.hrac_group_secondary],
  ].filter(([, value]) => value);
  const seen = new Set();
  return groups.filter(([type, value]) => {
    const key = `${type}:${value}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// strict: a failed read throws instead of reading as "no prior application"
// (the job card's mix helper withholds a dose on missing safety data; the
// closeout and plan engine keep their lenient default).
async function latestComparableGroupApplication(knex, customerId, product, groupType, groupValue, serviceDate, { strict = false } = {}) {
  const groupColumn = `${groupType}_group`;
  const rows = await savepointRead(knex, (k) => k('service_products as sp')
    .join('service_records as sr', 'sp.service_record_id', 'sr.id')
    .leftJoin('products_catalog as pc', function () {
      this.on('sp.product_name', '=', 'pc.name');
    })
    .where('sr.customer_id', customerId)
    .where('sr.status', 'completed')
    .where('sr.service_date', '<', serviceDate)
    .where(function () {
      this.where(`pc.${groupColumn}`, groupValue);
      if (groupType === 'hrac') this.orWhere('pc.hrac_group_secondary', groupValue);
      if (groupType === 'moa') this.orWhere('sp.moa_group', groupValue);
    })
    .modify((query) => {
      if (product?.category) query.where('sp.product_category', product.category);
    })
    .orderBy('sr.service_date', 'desc')
    .select('sr.service_date', 'sp.product_name', `pc.${groupColumn} as catalog_group`, 'pc.hrac_group_secondary as catalog_group_secondary', 'sp.moa_group', 'sp.targets')
    .limit(1))
    .catch((err) => { if (strict) throw err; return []; });
  return rows[0] || null;
}

// The repeat-group rule (never the same chemical group twice in a row) has two named exemptions
// (owner 2026-10-06); every other same-group repeat behaves as before:
//   pre_emergent_group_3: pre-emergents are all HRAC Group 3 this season, so a repeat is no signal;
//   take_all_artavia_pair: the labeled take-all pair is Artavia twice, 28 days apart (label spacing:
//     TAKE_ALL_PAIR_MIN_DAYS to TAKE_ALL_PAIR_MAX_DAYS between visits; an earlier repeat is a normal
//     repeat), ONLY when both applications recorded a take-all target (no target evidence, no
//     exemption), and ONLY for the SECOND application of the seasonal pair: exactly one take-all
//     Artavia in the season window before this one, and it is the 28 to 45 day one. A third is a
//     normal review.
const TAKE_ALL_PAIR_MIN_DAYS = 28;
const TAKE_ALL_PAIR_MAX_DAYS = 45;
// Two spacings of 45 days at most, so a third application still sees the first.
const TAKE_ALL_SEASON_DAYS = 90;
const TAKE_ALL_TARGET = /\btake all\b/;

function dayNumber(value) {
  const time = Date.parse(`${String(value instanceof Date ? value.toISOString() : value || '').slice(0, 10)}T00:00:00Z`);
  return Number.isFinite(time) ? Math.round(time / 86400000) : null;
}

function targetList(value) {
  return (Array.isArray(value) ? value : []).map(normalizeText).filter(Boolean);
}

const hasTakeAllTarget = (value) => targetList(value).some((target) => TAKE_ALL_TARGET.test(target));

function productIsPreEmergent(product, plan) {
  const rows = plan?.protocol?.structured?.products || [];
  return rows.some((row) => String(row?.productId) === String(product?.id) && /pre_emergent/.test(String(row?.role || '')))
    || isPreEmergent(product || {});
}

// The customer's take-all Artavia applications in the season window before this one (completed
// visits only, the same product, a take-all target recorded). A failed read throws when strict, else
// reads as none, so no exemption.
// Scoped to the visit's property: a spray at another of the customer's properties is not this
// property's pair. A visit with no property counts only history that also names none.
async function takeAllArtaviaHistory(knex, customerId, product, serviceDate, { strict = false, propertyId = null } = {}) {
  const rows = await savepointRead(knex, (k) => k('service_products as sp')
    .join('service_records as sr', 'sp.service_record_id', 'sr.id')
    .leftJoin('scheduled_services as ss', 'sr.scheduled_service_id', 'ss.id')
    .modify((query) => (propertyId ? query.where('ss.property_id', propertyId) : query.whereNull('ss.property_id')))
    .where('sr.customer_id', customerId)
    .where('sr.status', 'completed')
    .where('sr.service_date', '<', serviceDate)
    .where('sp.product_name', product.name)
    .orderBy('sr.service_date', 'desc')
    .select('sr.service_date', 'sp.product_name', 'sp.targets'))
    .catch((err) => { if (strict) throw err; return []; });
  const today = dayNumber(serviceDate);
  return rows.filter((row) => today - dayNumber(row.service_date) <= TAKE_ALL_SEASON_DAYS && hasTakeAllTarget(row.targets));
}

async function isTakeAllPair(knex, { customerId, propertyId, product, last, input, serviceDate, strict }) {
  if (!/\bartavia\b/.test(normalizeText(product.name)) || normalizeText(last.product_name) !== normalizeText(product.name)) return false;
  if (!hasTakeAllTarget(input.targets) || !hasTakeAllTarget(last.targets)) return false;
  const history = await takeAllArtaviaHistory(knex, customerId, product, serviceDate, { strict, propertyId });
  if (history.length !== 1) return false;
  const apart = dayNumber(serviceDate) - dayNumber(history[0].service_date);
  return apart >= TAKE_ALL_PAIR_MIN_DAYS && apart <= TAKE_ALL_PAIR_MAX_DAYS
    && dayNumber(history[0].service_date) === dayNumber(last.service_date);
}

async function rotationExemption(knex, { customerId, propertyId, product, plan, groupType, groupValue, last, input, serviceDate, strict }) {
  if (groupType === 'hrac' && String(groupValue) === '3' && productIsPreEmergent(product, plan)) return 'pre_emergent_group_3';
  return await isTakeAllPair(knex, { customerId, propertyId, product, last, input, serviceDate, strict }) ? 'take_all_artavia_pair' : null;
}

function latestAssessmentStressed(plan) {
  const flags = plan?.propertyGate?.latestAssessment?.stressFlags || {};
  return !!(flags.drought_stress || flags.heat_stress || flags.recent_scalp);
}

function productIsPgr(product, input) {
  const category = normalizeText(product?.category);
  const name = normalizeText(product?.name || input?.name);
  return category.includes('plant growth regulator')
    || category === 'pgr'
    || name.includes('primo')
    || name.includes('pgr');
}

function serviceSuggestsDethatching(service, submittedProducts) {
  const text = [
    service?.service_type,
    service?.serviceType,
    service?.notes,
    ...(submittedProducts || []).map((p) => p.name),
  ].map(normalizeText).join(' ');
  return /\bdethatch|\bdethatching|\bthatch removal\b/.test(text);
}

// The groups the last application carried, for the group type compared.
function lastApplicationGroups(last, groupType) {
  if (groupType === 'moa') return [last?.catalog_group, last?.moa_group];
  if (groupType === 'hrac') return [last?.catalog_group, last?.catalog_group_secondary];
  return [last?.catalog_group];
}

// One repeat-group finding: the code, the message, and what the rotation check read (the group, the
// last application and the targets; empty = none recorded).
function repeatGroupFinding({ product, input, groupType, groupValue, last }) {
  const lastDate = String(last.service_date).slice(0, 10);
  const fungicide = groupType === 'frac' && normalizeText(product.category).includes('fungicide');
  return {
    code: fungicide ? 'fungicide_frac_rotation_approval' : `repeat_${groupType}_group`,
    severity: 'block',
    productId: product.id,
    productName: product.name,
    message: `${product.name} repeats ${groupType.toUpperCase()} ${groupValue}; last matching application was ${last.product_name || 'unknown product'} on ${lastDate}.`,
    evidence: {
      groupType,
      groupValue: String(groupValue),
      lastProduct: last.product_name || null,
      lastDate,
      targets: targetList(input.targets),
      lastTargets: targetList(last.targets),
    },
  };
}

// The repeat-group (rotation) review of one applied product: for each of its groups, the latest
// comparable application, the named exemptions, and the finding.
async function repeatGroupFindings(knex, { customerId, propertyId, product, input, plan, serviceDate, strict }) {
  const findings = [];
  for (const [groupType, groupValue] of productGroups(product)) {
    const last = await latestComparableGroupApplication(knex, customerId, product, groupType, groupValue, serviceDate, { strict });
    if (!last || !lastApplicationGroups(last, groupType).some((lastGroup) => String(lastGroup || '') === String(groupValue))) continue;
    if (await rotationExemption(knex, { customerId, propertyId, product, plan, groupType, groupValue, last, input, serviceDate, strict })) continue;
    findings.push(repeatGroupFinding({ product, input, groupType, groupValue, last }));
  }
  return findings;
}

async function evaluateWaveGuardManagerApprovals(knex, {
  customerId,
  service,
  plan,
  products = [],
  serviceDate,
  strict = false,
}) {
  const blocks = [];
  const warnings = [];
  const submittedProductIds = [...new Set((products || []).map((p) => p.productId).filter(Boolean).map(String))];
  const plannedIds = collectProductIds([plan?.protocol?.base, plan?.mixCalculator?.items]);
  const conditionalIds = collectProductIds([plan?.protocol?.conditional]);
  const catalogRows = submittedProductIds.length
    ? await savepointRead(knex, (k) => k('products_catalog').whereIn('id', submittedProductIds))
      .catch((err) => { if (strict) throw err; return []; })
    : [];
  const catalogById = new Map(catalogRows.map((row) => [String(row.id), row]));

  for (const input of products || []) {
    if (!input.productId) continue;
    const productId = String(input.productId);
    const product = catalogById.get(productId);
    if (!product) continue;

    if (conditionalIds.has(productId) && !plannedIds.has(productId)) {
      blocks.push({
        code: 'conditional_protocol_product_review',
        severity: 'block',
        productId: product.id,
        productName: product.name,
        message: `${product.name} is conditional on the WaveGuard protocol card and was not in the generated mix; manager review is required before applying it.`,
      });
    } else if ((plannedIds.size || conditionalIds.size) && !plannedIds.has(productId) && !conditionalIds.has(productId)) {
      blocks.push({
        code: 'off_protocol_product',
        severity: 'block',
        productId: product.id,
        productName: product.name,
        message: `${product.name} is not part of the current WaveGuard protocol card.`,
      });
    }

    const enteredRate = Number(input.rate);
    const maxRate = Number(product.max_label_rate_per_1000);
    const hasEnteredRate = Number.isFinite(enteredRate) && enteredRate > 0;
    const hasLabelMax = Number.isFinite(maxRate) && maxRate > 0;
    if (
      hasEnteredRate
      && hasLabelMax
      && enteredRate > maxRate
      && rateUnitsMatch(input.rateUnit, product.rate_unit)
    ) {
      blocks.push({
        code: 'high_rate_application',
        severity: 'block',
        productId: product.id,
        productName: product.name,
        message: `${product.name} rate ${enteredRate} ${input.rateUnit || ''}/1k exceeds label max ${maxRate} ${product.rate_unit || ''}/1k.`,
      });
    } else if (hasEnteredRate && hasLabelMax && !rateUnitsMatch(input.rateUnit, product.rate_unit)) {
      blocks.push({
        code: 'label_rate_unit_review',
        severity: 'block',
        productId: product.id,
        productName: product.name,
        message: `${product.name} rate unit ${input.rateUnit || 'unknown'} does not match label unit ${product.rate_unit || 'unknown'}; manager review is required before applying it.`,
      });
    }

    if (productIsPgr(product, input) && latestAssessmentStressed(plan)) {
      blocks.push({
        code: 'pgr_on_stressed_turf',
        severity: 'block',
        productId: product.id,
        productName: product.name,
        message: `${product.name} is a PGR and the latest assessment flags stressed turf.`,
      });
    }

    blocks.push(...await repeatGroupFindings(knex, { customerId, propertyId: service?.property_id || null, product, input, plan, serviceDate, strict }));
  }

  const turfProfile = await savepointRead(knex, (k) => k('customer_turf_profiles')
    .where({ customer_id: customerId, active: true })
    .first())
    .catch((err) => { if (strict) throw err; return null; });
  const grassType = normalizeText(turfProfile?.grass_type || plan?.propertyGate?.trackName || plan?.propertyGate?.trackKey);
  const cultivar = normalizeText(turfProfile?.cultivar);
  if ((grassType.includes('st augustine') || grassType.includes('st_augustine') || cultivar.includes('floratam')) && serviceSuggestsDethatching(service, products)) {
    blocks.push({
      code: 'st_augustine_dethatching',
      severity: 'block',
      message: 'St. Augustine dethatching requires manager approval because stolon damage risk is high.',
    });
  }

  const deduped = [];
  const seen = new Set();
  for (const block of blocks) {
    const key = `${block.code}:${block.productId || ''}:${block.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(block);
  }

  return {
    approvalRequired: deduped.length > 0,
    blocks: deduped,
    warnings,
  };
}

function managerApprovalSummary(approval, blocks, actor) {
  return {
    reasonCode: approval.reasonCode,
    note: approval.note || null,
    approvedByTechnicianId: actor?.technicianId || null,
    approvedByRole: actor?.role || null,
    approvedAt: new Date().toISOString(),
    blocks: (blocks || []).map((block) => ({
      code: block.code,
      message: block.message,
      productId: block.productId || null,
      productName: block.productName || null,
      ...(block.evidence ? { evidence: block.evidence } : {}),
    })),
  };
}

module.exports = {
  evaluateWaveGuardManagerApprovals,
  managerApprovalSummary,
  latestComparableGroupApplication,
};
