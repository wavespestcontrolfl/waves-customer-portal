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

// GATE_LAWN_V13, read at call time (a suite that mocks feature-gates without the reader reads as off). The composite
// rotation handling below, the Artavia-then-Headway pair, the protocol-row evidence and the property-scoped pair
// lookup belong to the v13 lawn program: with the gate off the engine and the job card note behave as they did
// before it (one group string compared as a whole, the Artavia-twice pair on recorded targets only).
const v13Rotation = () => require('../config/feature-gates').lawnV13Live?.() === true;

// A group field can name several groups: "3 + 11", "3/11", "11, 3", "28+3A" (a mixed product such as
// Headway: FRAC 3 and 11). With the gate on every comparison is by set intersection, so a group is in the set or not;
// off, the field is one string.
const GROUP_SPLIT = /\s*(?:[+/,;&]|\band\b)\s*/i;
function groupSet(value) {
  if (!v13Rotation()) return [String(value ?? '')].filter(Boolean);
  return String(value ?? '').split(GROUP_SPLIT).map((part) => part.trim()).filter(Boolean);
}
// Gate off: the exact string comparison the engine always made.
const groupInValue = (value, group) => (v13Rotation()
  ? groupSet(value).some((member) => member.toLowerCase() === String(group).toLowerCase())
  : String(value || '') === String(group));
const escapeRegex = (text) => String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function productGroups(product) {
  const groups = [
    ['moa', product?.moa_group],
    ['frac', product?.frac_group],
    ['irac', product?.irac_group],
    ['hrac', product?.hrac_group],
    ['hrac', product?.hrac_group_secondary],
  ].filter(([, value]) => value).flatMap(([type, value]) => groupSet(value).map((member) => [type, member]));
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
// scopeToProperty: judge only the applications at `propertyId` (null = visits with no property); the default reads
// the customer's whole history, which is what the repeat rule itself uses.
// Scoped by the property FROZEN on the application's ledger row (property_application_history.property_id, written at
// completion: a later address correction on the visit must not move it); a legacy row with no frozen property falls
// back to its visit's property (the same rule application-limits.js scopeHistoryToTreatment applies). The query
// needs `sp` and `sr`; `joinVisit` adds the visit when the query has not joined it.
// includeUnplaced: an application with no property at all (no frozen property, no visit property) also counts at
// `propertyId`. It may have been made there, so a count that withholds an exemption takes it (the safe side).
function scopeToTreatedProperty(query, propertyId, { joinVisit = false, includeUnplaced = false } = {}) {
  if (joinVisit) query.leftJoin('scheduled_services as ss', 'sr.scheduled_service_id', 'ss.id');
  query.leftJoin('property_application_history as pah_scope', 'pah_scope.service_product_id', 'sp.id');
  if (propertyId && includeUnplaced) query.whereRaw('(COALESCE(pah_scope.property_id, ss.property_id) = ? OR COALESCE(pah_scope.property_id, ss.property_id) IS NULL)', [propertyId]);
  else if (propertyId) query.whereRaw('COALESCE(pah_scope.property_id, ss.property_id) = ?', [propertyId]);
  else query.whereRaw('COALESCE(pah_scope.property_id, ss.property_id) IS NULL');
  return query;
}

async function latestComparableGroupApplication(knex, customerId, product, groupType, groupValue, serviceDate, { strict = false, scopeToProperty = false, propertyId = null } = {}) {
  const groupColumn = `${groupType}_group`;
  const tokens = groupSet(groupValue);
  if (!tokens.length) return null;
  const rows = await savepointRead(knex, (k) => k('service_products as sp')
    .join('service_records as sr', 'sp.service_record_id', 'sr.id')
    .leftJoin('products_catalog as pc', function () {
      this.on('sp.product_name', '=', 'pc.name');
    })
    .modify((query) => { if (scopeToProperty) scopeToTreatedProperty(query, propertyId, { joinVisit: true }); })
    .where('sr.customer_id', customerId)
    .where('sr.status', 'completed')
    .where('sr.service_date', '<', serviceDate)
    .where(function () {
      // The caller may hand a composite value ("3 + 11", the job card passes the product's whole field): every
      // caller gets the tokens, and a prior application matches on any one of them.
      for (const token of tokens) {
        this.orWhere(`pc.${groupColumn}`, token);
        // A mixed product's field holds several groups ("3 + 11"): the group is one token of the value.
        if (v13Rotation()) this.orWhereRaw('?? ~* ?', [`pc.${groupColumn}`, `(^|[^0-9a-z])${escapeRegex(token)}($|[^0-9a-z])`]);
        if (groupType === 'hrac') this.orWhere('pc.hrac_group_secondary', token);
        if (groupType === 'moa') this.orWhere('sp.moa_group', token);
      }
    })
    .modify((query) => {
      if (product?.category) query.where('sp.product_category', product.category);
    })
    .orderBy('sr.service_date', 'desc')
    .select('sp.id as service_product_id', 'sr.service_date', 'sp.product_name', `pc.${groupColumn} as catalog_group`, 'pc.hrac_group_secondary as catalog_group_secondary', 'sp.moa_group', 'sp.targets')
    .limit(1))
    .catch((err) => { if (strict) throw err; return []; });
  return rows[0] || null;
}

// The repeat-group rule (never the same chemical group twice in a row) has two named exemptions
// (owner 2026-10-06); every other same-group repeat behaves as before:
//   pre_emergent_group_3: pre-emergents are all HRAC Group 3 this season, so a repeat is no signal;
//   take_all_artavia_pair: the planned take-all pair is Artavia, then Headway 28 days later (Headway adds
//     propiconazole, group 3, to the same group 11 azoxystrobin, so group 11 repeats once: this is the
//     named exception for it, 30 to 45 days apart); Artavia twice, 28 days apart, stays allowed (label spacing:
//     TAKE_ALL_PAIR_MIN_DAYS to TAKE_ALL_PAIR_MAX_DAYS between visits; an earlier repeat is a normal
//     repeat), ONLY when both applications recorded a take-all target (no target evidence, no
//     exemption), and ONLY for the SECOND application of the seasonal pair: exactly one take-all
//     Artavia in the season window before this one, and it is the 28 to 45 day one. A third is a
//     normal review.
const TAKE_ALL_PAIR_MIN_DAYS = 28;
// Artavia then HEADWAY: 30 days on every grass. The Headway label limits bermudagrass to 3 fl oz per 1,000 sq ft
// every 30 days, so the pair is label-safe everywhere at 30 (Artavia twice keeps the 28 of its own label).
const TAKE_ALL_HEADWAY_MIN_DAYS = 30;
const TAKE_ALL_PAIR_MAX_DAYS = 45;
// Two spacings of 45 days at most, so a third application still sees the first.
const TAKE_ALL_SEASON_DAYS = 90;
const TAKE_ALL_TARGET = /\btake all\b/;
// The pair is Artavia then Headway (or Artavia twice): the second product, and the first one, by name.
const TAKE_ALL_SECOND = /\b(artavia|headway)\b/;
const TAKE_ALL_FIRST = /\bartavia\b/;

function dayNumber(value) {
  const time = Date.parse(`${String(value instanceof Date ? value.toISOString() : value || '').slice(0, 10)}T00:00:00Z`);
  return Number.isFinite(time) ? Math.round(time / 86400000) : null;
}

function targetList(value) {
  return (Array.isArray(value) ? value : []).map(normalizeText).filter(Boolean);
}

const hasTakeAllTarget = (value) => targetList(value).some((target) => TAKE_ALL_TARGET.test(target));

// Words a take-all trigger may carry besides "take all" itself ("mapped_take_all_spring_2", "active_take_all").
const TAKE_ALL_TRIGGER_FILLER = new Set(['mapped', 'active', 'take', 'all', 'spring', 'fall', 'first', 'second', 'application']);

// Is this trigger or role text EXCLUSIVELY take-all? A row that serves other uses too (a compound trigger such as
// "mapped_take_all_fall_1_pythium_root_rot", "..._large_patch_...") cannot prove that an application under it
// was for take-all, so it is no evidence. Only the take-all phrase plus filler words and numbers qualify.
function textIsExclusivelyTakeAll(text) {
  const normalized = normalizeText(text);
  if (!TAKE_ALL_TARGET.test(normalized)) return false;
  return normalized.split(' ').every((word) => !word || TAKE_ALL_TRIGGER_FILLER.has(word) || /^\d+$/.test(word));
}

// Does an applied protocol row (its trigger or its role) name take-all, and only take-all?
function rowNamesTakeAll(row) {
  const gates = typeof row?.gates === 'string' ? (() => { try { return JSON.parse(row.gates) || {}; } catch { return {}; } })() : (row?.gates || {});
  return [gates.trigger, row?.role].some(textIsExclusivelyTakeAll);
}

// The staged protocol row a PRIOR application was applied under: the ledger actual of its service_products row
// (protocol_product_id -> lawn_protocol_products). null when it has none or the ledger is not there. A failed
// read throws when strict, else reads as no row.
async function priorProtocolRow(knex, serviceProductId, { strict = false } = {}) {
  if (!serviceProductId) return null;
  try {
    const rows = await savepointRead(knex, (k) => k('lawn_protocol_product_actuals as a')
      .join('lawn_protocol_products as p', 'a.protocol_product_id', 'p.id')
      .where('a.service_product_id', serviceProductId)
      .select('p.gates', 'p.role'));
    return (rows || []).length ? rows : null;
  } catch (err) {
    if (strict) throw err;
    return null;
  }
}

// Target evidence for a PRIOR application. Recorded targets decide when there are any (a non-take-all target
// is not take-all evidence). Fast Complete records none, so then the protocol row it was applied under decides;
// with neither there is no evidence.
async function takeAllEvidence(knex, { targets, serviceProductId, strict }) {
  if (targetList(targets).length) return hasTakeAllTarget(targets);
  const rows = await priorProtocolRow(knex, serviceProductId, { strict });
  return Boolean(rows && rows.some(rowNamesTakeAll));
}

// The same for the application being judged: its recorded targets, else the plan's staged row for the product
// (plan.protocol.structured.products, the rows the visit is applied under).
function currentTakeAllEvidence({ input, product, plan }) {
  if (targetList(input.targets).length) return hasTakeAllTarget(input.targets);
  const rows = (plan?.protocol?.structured?.products || []).filter((row) => String(row?.productId) === String(product?.id));
  return rows.some(rowNamesTakeAll);
}

function productIsPreEmergent(product, plan) {
  const rows = plan?.protocol?.structured?.products || [];
  return rows.some((row) => String(row?.productId) === String(product?.id) && /pre_emergent/.test(String(row?.role || '')))
    || isPreEmergent(product || {});
}

// The customer's take-all pair applications in the season window before this one (completed
// visits only, this product or the last one's, a take-all target recorded). A failed read throws when strict, else
// reads as none, so no exemption.
// Scoped to the visit's property: a spray at another of the customer's properties is not this
// property's pair. A visit with no property counts only history that also names none.
async function takeAllArtaviaHistory(knex, customerId, productNames, serviceDate, { strict = false, propertyId = null, v13 = true } = {}) {
  const rows = await savepointRead(knex, (k) => k('service_products as sp')
    .join('service_records as sr', 'sp.service_record_id', 'sr.id')
    .leftJoin('scheduled_services as ss', 'sr.scheduled_service_id', 'ss.id')
    // v13: unplaced history counts at every property (it can only withhold the exemption). Gate off: as before.
    .modify((query) => scopeToTreatedProperty(query, propertyId, { includeUnplaced: v13 }))
    .where('sr.customer_id', customerId)
    .where('sr.status', 'completed')
    .where('sr.service_date', '<', serviceDate)
    .whereIn('sp.product_name', productNames)
    .orderBy('sr.service_date', 'desc')
    .select('sp.id as service_product_id', 'sr.service_date', 'sp.product_name', 'sp.targets'))
    .catch((err) => { if (strict) throw err; return []; });
  const today = dayNumber(serviceDate);
  const inSeason = rows.filter((row) => today - dayNumber(row.service_date) <= TAKE_ALL_SEASON_DAYS);
  const found = [];
  for (const row of inSeason) {
    // Gate off: recorded targets only (the evidence fallback to the applied protocol row is the v13 program's).
    const evidence = v13 ? await takeAllEvidence(knex, { targets: row.targets, serviceProductId: row.service_product_id, strict }) : hasTakeAllTarget(row.targets);
    if (evidence) found.push(row);
  }
  return found;
}

// The pair exemption as it was before the v13 program: Artavia after the same Artavia, both applications with a
// recorded take-all target, 28 to 45 days apart, the second application of the pair only.
async function isLegacyTakeAllPair(knex, { customerId, propertyId, product, last, input, serviceDate, strict }) {
  if (!/\bartavia\b/.test(normalizeText(product.name)) || normalizeText(last.product_name) !== normalizeText(product.name)) return false;
  if (!hasTakeAllTarget(input.targets) || !hasTakeAllTarget(last.targets)) return false;
  const history = await takeAllArtaviaHistory(knex, customerId, [product.name], serviceDate, { strict, propertyId, v13: false });
  if (history.length !== 1) return false;
  const apart = dayNumber(serviceDate) - dayNumber(history[0].service_date);
  return apart >= TAKE_ALL_PAIR_MIN_DAYS && apart <= TAKE_ALL_PAIR_MAX_DAYS
    && dayNumber(history[0].service_date) === dayNumber(last.service_date);
}

async function isTakeAllPair(knex, ctx) {
  return v13Rotation() ? isV13TakeAllPair(knex, ctx) : isLegacyTakeAllPair(knex, ctx);
}

async function isV13TakeAllPair(knex, { customerId, propertyId, product, plan, groupType, groupValue, input, serviceDate, strict }) {
  // The pair is judged at this property: the customer-wide latest application of the group may be another
  // property's, which must not break a valid pair here (the repeat finding itself stays customer-wide).
  const last = await latestComparableGroupApplication(knex, customerId, product, groupType, groupValue, serviceDate, { strict, scopeToProperty: true, propertyId });
  if (!last) return false;
  // Artavia after Artavia, or Headway after Artavia; the first of the pair is always Artavia.
  if (!TAKE_ALL_SECOND.test(normalizeText(product.name)) || !TAKE_ALL_FIRST.test(normalizeText(last.product_name))) return false;
  if (TAKE_ALL_FIRST.test(normalizeText(product.name)) && normalizeText(last.product_name) !== normalizeText(product.name)) return false;
  if (!currentTakeAllEvidence({ input, product, plan })) return false;
  if (!(await takeAllEvidence(knex, { targets: last.targets, serviceProductId: last.service_product_id, strict }))) return false;
  const history = await takeAllArtaviaHistory(knex, customerId, [...new Set([product.name, last.product_name])], serviceDate, { strict, propertyId });
  if (history.length !== 1 || !TAKE_ALL_FIRST.test(normalizeText(history[0].product_name))) return false;
  const apart = dayNumber(serviceDate) - dayNumber(history[0].service_date);
  const minDays = /\bheadway\b/.test(normalizeText(product.name)) ? TAKE_ALL_HEADWAY_MIN_DAYS : TAKE_ALL_PAIR_MIN_DAYS;
  return apart >= minDays && apart <= TAKE_ALL_PAIR_MAX_DAYS
    && dayNumber(history[0].service_date) === dayNumber(last.service_date);
}

async function rotationExemption(knex, { customerId, propertyId, product, plan, groupType, groupValue, last, input, serviceDate, strict }) {
  if (groupType === 'hrac' && String(groupValue) === '3' && productIsPreEmergent(product, plan)) return 'pre_emergent_group_3';
  return await isTakeAllPair(knex, { customerId, propertyId, product, plan, groupType, groupValue, last, input, serviceDate, strict }) ? 'take_all_artavia_pair' : null;
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
    if (!last || !lastApplicationGroups(last, groupType).some((lastGroup) => groupInValue(lastGroup, groupValue))) continue;
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
  productGroups,
  priorProtocolRow,
};
