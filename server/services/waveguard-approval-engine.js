const { savepointRead } = require('../utils/savepoint-read');
const { isPreEmergent } = require('./service-report/lawn-watering-rule');
const { dateOnlyString } = require('../utils/date-only');

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
//   pre_emergent_group_3: pre-emergents are all HRAC Group 3 this season, so a repeat is no signal. The group is read from
//     the typed column (hrac_group "3") or the older free-text one (moa_group "Group 3"): the liquid pre-emergents and the
//     Stonewall 0.37% 18-0-10 bag hold it in the free-text column;
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

// A group's bare code: the typed columns hold "3", the older free-text column holds "Group 3".
const bareGroup = (value) => String(value ?? '').trim().replace(/^group\s+/i, '').toLowerCase();

async function rotationExemption(knex, { customerId, propertyId, product, plan, groupType, groupValue, last, input, serviceDate, strict }) {
  if ((groupType === 'hrac' || groupType === 'moa') && bareGroup(groupValue) === '3' && productIsPreEmergent(product, plan)) return 'pre_emergent_group_3';
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

// ── A label's limit on applications in a row ────────────────────────────────
// The repeat-group finding above says a group was used before. It does not say when a label's own limit on applications
// in a row is reached. Protocols audit 2026-11-26, item 5: the fall large patch calendar could direct Velista in
// October, November and December on one lawn, and the third one read like any other repeat.
//
// Velista (EPA 100-1534), Resistance Management: "Do not make more than two successive applications of Velista; these
// two applications should be followed by applications of fungicides from a different FRAC mode of action group."
//
// How the lawn's history is read, one way for every product on this list (successiveRun):
//   - the lawn's completed fungicide applications up to the visit's date, newest first, with no lower date bound (the
//     label names no time after which a run ends). One service record is one application: its tank-mix rows are one,
//     two visits on one date are two. The visit judged is left out by its own id;
//   - property-scoped as the take-all pair is. An application that names no property may have been made here, so it
//     is read;
//   - an application that carries the product counts, alone or in a tank mix (the label limits the product's
//     applications; a mix partner does not un-count one), wherever it is placed;
//   - an application without the product ends the run only when it carries a fungicide of another group AND is placed
//     at this property (a rotation that names no property may have been made elsewhere). One whose fungicides are all
//     of the product's own group, or of no group on file, neither counts nor ends the run;
//   - `max` such applications in a row before this visit = this application would be one too many.
// Who reads it:
//   - the approval engine raises successive_application_limit with the dates. On the job card's tank search it is a
//     warning beside the amount, like a group repeat (job-card.js ROTATION_CODES; owner 2026-10-09, "show the mix
//     amount"). `approvable: false` rides to the close-out's record: an approval there does not permit it;
//   - the treatment guide does not suggest the product and suggests the next fungicide (lawn-fast-complete.js
//     fungicideHolds). The row stays on the list and in the search, and the close-out never stops on it (owner
//     2026-11-26: "alerts like this should just be alerts, they should not stop the job from being completed").
const SUCCESSIVE_USE_LIMITS = Object.freeze([
  Object.freeze({ epa: '100-1534', name: /^velista\b/, category: 'fungicide', group: '7', max: 2, source: 'Velista label, EPA 100-1534, Resistance Management' }),
]);
const SUCCESSIVE_USE_CODE = 'successive_application_limit';

const epaOf = (value) => String(value ?? '').toLowerCase().replace(/\s+/g, '');
// Is this catalog or history row the limited product? By registration number when the row has one, else by name.
function isLimitedProduct(limit, { epa, name }) {
  const registration = epaOf(epa);
  return registration ? registration === limit.epa : limit.name.test(normalizeText(name));
}
const successiveLimitFor = (product) => SUCCESSIVE_USE_LIMITS.find((limit) => isLimitedProduct(limit, { epa: product?.epa_reg_number ?? product?.epaRegNumber, name: product?.name })) || null;
// Every group a history row carries, bare ("Group 11 + 3" and "3 + 11" both read 11 and 3). Not behind the v13 gate.
const rowGroups = (row) => [row.catalog_group, row.catalog_moa_group, row.moa_group]
  .flatMap((value) => String(value ?? '').split(GROUP_SPLIT)).map(bareGroup).filter(Boolean);

const APPLIED_RECORD_STATUSES = Object.freeze(['completed', 'incomplete']);

// The lawn's recorded applications of one product category up to the visit's date, as product rows (newest first).
// A failed read throws when strict, else reads as no history.
async function categoryHistory(knex, { customerId, propertyId, category, serviceDate, serviceId = null, strict = false }) {
  return savepointRead(knex, (k) => k('service_products as sp')
    .join('service_records as sr', 'sp.service_record_id', 'sr.id')
    .leftJoin('products_catalog as pc', function () {
      this.on('sp.product_name', '=', 'pc.name');
    })
    // A visit whose property cannot be established is judged on the customer's whole history (the repeat-group finding's
    // own scope): reading only the unplaced records would drop every application recorded at the property itself.
    .modify((query) => {
      if (propertyId) return scopeToTreatedProperty(query, propertyId, { joinVisit: true, includeUnplaced: true });
      return query.leftJoin('scheduled_services as ss', 'sr.scheduled_service_id', 'ss.id')
        .leftJoin('property_application_history as pah_scope', 'pah_scope.service_product_id', 'sp.id');
    })
    .where('sr.customer_id', customerId)
    // A visit closed as incomplete keeps the products that did go down: they are applications too.
    .whereIn('sr.status', APPLIED_RECORD_STATUSES)
    .where('sr.service_date', '<=', serviceDate)
    // The visit being judged is not its own history (a close-out can be read again after its record exists).
    .modify((query) => { if (serviceId) query.whereRaw('(sr.scheduled_service_id IS NULL OR sr.scheduled_service_id <> ?)', [serviceId]); })
    .where(function () { this.where('sp.product_category', category).orWhere('pc.category', category); })
    .orderBy([{ column: 'sr.service_date', order: 'desc' }, { column: 'sr.created_at', order: 'desc' }])
    .select(
      'sr.id as service_record_id', 'sr.service_date', 'sr.created_at as recorded_at', 'sr.service_line', 'sr.service_type', 'sp.product_name', 'sp.moa_group',
      // The registration the close-out stored with the application: the catalog row of that name may since be renamed or replaced.
      'sp.epa_reg_number as recorded_epa', 'pc.epa_reg_number as catalog_epa', 'pc.frac_group as catalog_group', 'pc.moa_group as catalog_moa_group',
      k.raw('COALESCE(pah_scope.property_id, ss.property_id) as treated_property_id'),
    ))
    .catch((err) => { if (strict) throw err; return []; });
}

// The product rows as applications, newest first: one per service record (rows with no record id: one per date).
function applicationsOf(rows) {
  const byRecord = new Map();
  for (const row of rows || []) {
    const day = dateOnlyString(row.service_date);
    if (!day) continue;
    const key = row.service_record_id != null ? `record:${row.service_record_id}` : `day:${day}`;
    if (!byRecord.has(key)) byRecord.set(key, { day, recordedAt: row.recorded_at instanceof Date ? row.recorded_at.toISOString() : String(row.recorded_at || ''), rows: [] });
    byRecord.get(key).rows.push(row);
  }
  return [...byRecord.values()].sort((a, b) => b.day.localeCompare(a.day) || b.recordedAt.localeCompare(a.recordedAt));
}

// The dates, newest first, of the product's unbroken run of applications that ends at the lawn's latest fungicide
// application. `propertyId`: the visit's property. Null = none could be established: the rows are the customer's
// whole history (categoryHistory), every listed application in it counts, and no rotation ends the run, because none
// can be tied to the lawn this visit treats.
// A rotation ends the run only when it is a lawn treatment at this property: a fungicide of another group on the
// shrubs, or at another home, is not this lawn's rotation.
function successiveRun(limit, rows, { propertyId = null } = {}) {
  const here = (row) => Boolean(propertyId) && String(row.treated_property_id ?? '') === String(propertyId) && isLawnRecord(row);
  const run = [];
  for (const application of applicationsOf(rows)) {
    if (application.rows.some((row) => isLimitedProduct(limit, { epa: row.recorded_epa || row.catalog_epa, name: row.product_name }))) run.push(application.day);
    else if (application.rows.some((row) => here(row) && rowGroups(row).some((group) => group !== limit.group))) break;
  }
  return run;
}

// A history row of a lawn service record: by the record's own service line, else by its name.
function isLawnRecord(row) {
  const line = String(row?.service_line || '').trim().toLowerCase();
  if (line) return line === 'lawn' || line === 'lawn_care';
  return require('./service-report/service-line-configs').detectServiceLine(row?.service_type) === 'lawn';
}

// Did a record at this property end the group's run? (Fast Complete: whether the Group 11 run is closed after a
// Velista run, so the Group 11 row may be offered.) True only when the lawn's latest application of the category is
// placed at `propertyId`, every product of it has a group on file, and none carries `group`. An application that names
// no property, a product with no group on file, no history and a visit with no property all read as not ended.
function latestApplicationEndsGroup(rows, group, { propertyId = null } = {}) {
  const [latest] = applicationsOf(rows);
  if (!latest || !propertyId) return false;
  return latest.rows.every((row) => String(row.treated_property_id ?? '') === String(propertyId) && isLawnRecord(row)
    && rowGroups(row).length > 0 && !rowGroups(row).includes(String(group)));
}

// The property a visit's history is judged at: the visit's own, else the one its address resolves to (the resolver
// the lawn areas use: 17 of 423 upcoming lawn visits carried no property on 2026-11-26). Null when none resolves.
// A failed read throws when strict, else reads as none.
async function visitPropertyFor(knex, visit, { strict = false } = {}) {
  if (visit?.property_id) return visit.property_id;
  if (!visit?.customer_id) return null;
  try {
    return await savepointRead(knex, (k) => require('./property-service-areas').resolveVisitPropertyId(visit, k)) || null;
  } catch (err) {
    if (strict) throw err;
    return null;
  }
}

// Every listed product whose run is full before this visit, as `[{ limit, dates }]`, with the history rows read
// (`rowsByCategory`, for a caller that asks more of them) and the property they were judged at. `visit`: the booked
// visit, to resolve a property it does not carry. A visit with no readable date reads as none.
async function successiveLimitsReached(knex, { customerId, propertyId: given = null, visit = null, serviceDate, serviceId = null, strict = false, limits = SUCCESSIVE_USE_LIMITS }) {
  const day = dateOnlyString(serviceDate);
  const reached = [];
  const rowsByCategory = new Map();
  if (!day) return { reached, rowsByCategory, propertyId: given };
  const propertyId = given || await visitPropertyFor(knex, visit ? { ...visit, customer_id: visit.customer_id || customerId } : null, { strict });
  for (const limit of limits) {
    if (!rowsByCategory.has(limit.category)) rowsByCategory.set(limit.category, await categoryHistory(knex, { customerId, propertyId, category: limit.category, serviceDate: day, serviceId, strict }));
    const run = successiveRun(limit, rowsByCategory.get(limit.category), { propertyId });
    if (run.length >= limit.max) reached.push({ limit, dates: run.slice(0, limit.max) });
  }
  return { reached, rowsByCategory, propertyId };
}

async function successiveUseFindings(knex, { customerId, propertyId, visit, product, serviceDate, serviceId, strict }) {
  const limit = successiveLimitFor(product);
  if (!limit) return [];
  const { reached } = await successiveLimitsReached(knex, { customerId, propertyId, visit, serviceDate, serviceId, strict, limits: [limit] });
  return reached.map(({ dates }) => ({
    code: SUCCESSIVE_USE_CODE,
    severity: 'block',
    approvable: false,
    productId: product.id,
    productName: product.name,
    message: `${product.name} was the lawn's last ${limit.max} fungicide applications (${[...dates].reverse().join(', ')}). Its label allows no more than ${limit.max} in a row: use a fungicide of another group.`,
    evidence: { limit: limit.max, dates, source: limit.source },
  }));
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
  return oneFindingPerGroup(product, findings);
}

// A catalog row can hold one group twice: in the older free-text column (moa_group "Group 11") and in the typed column
// of the label's system (frac_group "11"). Each column has its own history lookup (an earlier product may hold the
// group in only one of them), so one resistance group could raise two findings, naming one earlier application or two
// different ones. The technician gets ONE finding for the group: the one whose earlier application is the latest;
// on the same day the typed finding stays (it carries the fungicide code). A free-text group with no typed twin on
// this product is its own group. Not behind the v13 gate: the catalog rows keep both columns when the gate is off.
function oneFindingPerGroup(product, findings) {
  const typedGroups = productGroups(product).filter(([type]) => type !== 'moa');
  const keyOf = ({ evidence }) => {
    const bare = bareGroup(evidence.groupValue);
    if (evidence.groupType !== 'moa') return `${evidence.groupType}:${bare}`;
    const twin = typedGroups.find(([, value]) => bareGroup(value) === bare);
    return twin ? `${twin[0]}:${bare}` : `moa:${bare}`;
  };
  const best = new Map();
  for (const finding of findings) {
    const key = keyOf(finding);
    const held = best.get(key);
    const newer = held && (finding.evidence.lastDate > held.evidence.lastDate
      || (finding.evidence.lastDate === held.evidence.lastDate && held.evidence.groupType === 'moa'));
    if (!held || newer) best.set(key, finding);
  }
  return findings.filter((finding) => best.get(keyOf(finding)) === finding);
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
    blocks.push(...await successiveUseFindings(knex, { customerId, propertyId: service?.property_id || null, visit: service || null, product, serviceDate, serviceId: service?.id || null, strict }));
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
      // A label limit no approval lifts (successive_application_limit): the record says so beside the approval.
      ...(block.approvable === false ? { approvable: false } : {}),
    })),
  };
}

module.exports = {
  evaluateWaveGuardManagerApprovals,
  rateUnitsMatch,
  managerApprovalSummary,
  latestComparableGroupApplication,
  productGroups,
  priorProtocolRow,
  rowNamesTakeAll,
  successiveRun,
  successiveLimitsReached,
  latestApplicationEndsGroup,
  visitPropertyFor,
  isLimitedProduct,
  SUCCESSIVE_USE_LIMITS,
  SUCCESSIVE_USE_CODE,
};
