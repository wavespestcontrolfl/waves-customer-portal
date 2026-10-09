/**
 * Lawn bermuda removal (GATE_LAWN_BERMUDA_REMOVAL, owner 2026-10-06).
 *
 * A lawn is a "bermuda removal" lawn when (a) the customer's accepted estimate
 * carries the bermuda-suppression add-on, or (b) staff switched it on for the
 * account (customer_turf_profiles.bermuda_removal). Grass: St. Augustine and
 * Zoysia only; every other grass never gets it. The estimate add-on itself is
 * St. Augustine only; Zoysia reaches the step through the staff switch alone.
 *
 * For such a lawn under lawn v13 the April and June visits carry a backpack
 * SPOT step: Recognition + Fusilade II + nonionic surfactant on the mapped
 * bermuda areas plus a 3 ft border. The step's text lives in
 * server/config/lawn-protocol-v13.json (visit.addOns.bermudaRemoval, read here);
 * the staged protocol rows are migration 20261006190100's, tagged
 * gates.bermudaRemoval = true, and the protocol reader leaves them out of every
 * other lawn (lawn-protocol-operating-layer.js getProtocolWindowContext). The
 * rows are spot rows: the plan never computes an amount, the label rate is shown
 * and the technician enters the area and the amount used.
 *
 * The three products are ONE selection: selecting any selects all three, and when
 * any of them cannot be applied (limited, no staged row, inactive catalog row)
 * all three leave the plan and the tank sheet, so Fusilade II is never planned
 * without Recognition and Recognition never goes out alone.
 *
 * St. Augustine cultivar (customer_turf_profiles.cultivar), the estimate copy's
 * own policy: ProVista, Captiva and Seville never get the step; Floratam,
 * Palmetto, Raleigh and SunClipse do; CitraBlue or an unknown cultivar gets the
 * step with a test-patch-first note. Zoysia has no cultivar rule.
 *
 * Limits (2 sprays a calendar year, 42 days apart, Recognition label annual
 * maximum) are product_limits rows read by application-limits.checkLimits, the
 * same path every other v13 line takes.
 */
const featureGates = require('../config/feature-gates');
const { detectServiceLine } = require('./service-report/service-line-configs');
const { LAWN_V13_VERSION } = require('./lawn-program');

const RECOGNITION = 'Recognition Post Emergent Herbicide';
const FUSILADE = 'Fusilade II Post Emergent Liquid Herbicide';
const SURFACTANT = 'LESCO 90/10 Nonionic Surfactant';

// Grass tracks the step can run on.
const BERMUDA_REMOVAL_TRACKS = ['st_augustine', 'zoysia'];
// Visit months that carry the step (the April spreader visit and the June hose visit).
const BERMUDA_REMOVAL_MONTHS = ['Apr', 'Jun'];

const v13Recipe = require('../config/lawn-protocol-v13.json');
// The step's recipe block for a track and month, or null.
function stepAddOn(trackKey, month) {
  return v13Recipe[trackKey]?.visits?.find((visit) => visit.month === month)?.addOns?.bermudaRemoval || null;
}

// St. Augustine cultivar policy (estimate-service-details.js: "our policy, stricter
// than the label").
const EXCLUDED_CULTIVARS = ['provista', 'captiva', 'seville'];
// The SQL twin of the excluded-cultivar test (same normalization: lower-case, letters and
// digits only), for the staff switch's atomic UPDATE.
const excludedCultivarSql = () => ({
  sql: `(grass_type <> 'st_augustine' OR cultivar IS NULL OR (${EXCLUDED_CULTIVARS.map(() => "regexp_replace(lower(cultivar), '[^a-z0-9]+', '', 'g') NOT LIKE ?").join(' AND ')}))`,
  bindings: EXCLUDED_CULTIVARS.map((name) => `%${name}%`),
});
const ELIGIBLE_CULTIVARS = ['floratam', 'palmetto', 'raleigh', 'sunclipse'];
const TEST_PATCH_NOTE = 'Test patch first: spray a 3 x 3 ft patch and watch it for 3 to 4 weeks before the full spot. The cultivar is CitraBlue or not confirmed.';

// 'excluded' = never the step; 'test_patch' = the step with the test-patch note;
// 'ok'. Fails closed on the excluded list and treats anything it does not
// recognize as unknown.
function cultivarState(trackKey, cultivar) {
  if (trackKey !== 'st_augustine') return 'ok';
  const text = normalize(cultivar).replace(/ /g, '');
  if (EXCLUDED_CULTIVARS.some((name) => text.includes(name))) return 'excluded';
  if (ELIGIBLE_CULTIVARS.some((name) => text.includes(name))) return 'ok';
  return 'test_patch';
}

const normalize = (value) => String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const FUSILADE_KEY = normalize(FUSILADE);
const RECOGNITION_KEY = normalize(RECOGNITION);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// The visit's own month, from its scheduled date as an Eastern calendar day (the
// canonical datetime-et helper), or null.
function visitMonthOf(visit) {
  if (!visit?.scheduled_date) return null;
  const day = require('../utils/datetime-et').etCalendarDayOf(visit.scheduled_date);
  return MONTH_ABBR[Number(String(day).slice(5, 7)) - 1] || null;
}

function bermudaRemovalLive() {
  return featureGates.lawnBermudaRemovalLive?.() === true;
}

// Does this visit (gate on, v13 resolved, an eligible grass, an April or June
// month) call for the step before the account is looked at?
function bermudaRemovalVisit({ trackKey, month }) {
  return bermudaRemovalLive()
    && BERMUDA_REMOVAL_TRACKS.includes(trackKey)
    && BERMUDA_REMOVAL_MONTHS.includes(month);
}

// The track the ACTIVE turf profile's grass says (St. Augustine or Zoysia), or null. The
// request's own track never decides eligibility: a caller's track that differs from the
// profile's opens nothing.
const profileTrack = (profile) => {
  const grass = String(profile?.grass_type || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  return BERMUDA_REMOVAL_TRACKS.includes(grass) ? grass : null;
};

// Which of the customer's properties the turf profile speaks for. The profile is
// customer-level (no property column), and the repo already treats it as the PRIMARY
// property's (lawn-size-sync mirrors lawn size there only; lawn-completion-defaults
// seeds the profile "only the proven current home, never a second lawn"). So: the
// customer's only active property, else the primary one. The visit's property must be
// that property; a visit with no property counts only for a one-property customer.
async function profilePropertyScope(knex, customerId, visitPropertyId, strict) {
  const { savepointRead } = require('../utils/savepoint-read');
  let props;
  try {
    props = await savepointRead(knex, (k) => k('customer_properties').where({ customer_id: customerId, active: true }).select('id', 'is_primary'));
  } catch (err) {
    if (strict) throw err;
    return { ok: false, effective: null, sole: null };
  }
  const sole = props.length === 1 ? String(props[0].id) : null;
  const primary = props.find((row) => row.is_primary === true);
  const profileProperty = sole || (primary ? String(primary.id) : null);
  const effective = visitPropertyId ? String(visitPropertyId) : sole;
  return { ok: !!effective && effective === profileProperty, effective, sole };
}

// Is the visit's lawn a bermuda removal lawn? The ACTIVE turf profile's grass is the
// track (St. Augustine or Zoysia, and the caller's `trackKey` must agree), and the
// visit's property must be the property the profile speaks for (see
// profilePropertyScope). Then the staff switch, then an accepted estimate whose CURRENT priced result
// still carries the add-on on its lawn line (not just a request option an opt-out left behind): the add-on is St. Augustine only, and the estimate must be for THIS
// property (its property_id equals the visit's, or it names none and the customer has
// one property). A failed read throws under `strict` (the job card fails closed) and
// otherwise reads as "not requested".
async function accountWantsBermudaRemoval(knex, { customerId, profile, trackKey, propertyId = null, strict = false }) {
  const none = { requested: false, source: null };
  const track = profileTrack(profile);
  if (!customerId || !track || track !== trackKey) return none;
  const staff = profile.bermuda_removal === true;
  if (!staff && track !== 'st_augustine') return none;
  const scope = await profilePropertyScope(knex, customerId, propertyId, strict);
  if (!scope.ok) return none;
  if (staff) return { requested: true, source: 'staff' };
  const { estimateResultCarriesBermudaSuppression } = require('./pricing-engine/v1-legacy-mapper');
  const { savepointRead } = require('../utils/savepoint-read');
  let rows;
  try {
    rows = await savepointRead(knex, (k) => k('estimates')
      .where({ customer_id: customerId, status: 'accepted' })
      .whereNull('archived_at')
      .select('estimate_data', 'property_id', 'pricing_authority'));
  } catch (err) {
    if (strict) throw err;
    return none;
  }
  const forThisProperty = (row) => (row.property_id ? String(row.property_id) === scope.effective : scope.sole === scope.effective);
  return rows.some((row) => forThisProperty(row) && estimateResultCarriesBermudaSuppression(row.estimate_data, { pricingAuthority: row.pricing_authority }))
    ? { requested: true, source: 'estimate' }
    : none;
}

// A step visit is a LAWN visit on the v13 program: the service line is the repo's own lawn
// classifier (the one lawn-completion-defaults uses), and a visit pinned to another protocol
// version (the recorded version the plan honors, scheduled_services.lawn_protocol_version)
// is not on v13. Unpinned = the current serving version. A pest or tree and shrub visit on a
// flagged account, or a lawn visit pinned to 2026.05, is never a step visit.
const isLawnV13Visit = (visit) => detectServiceLine(visit?.service_type) === 'lawn'
  && (!visit.lawn_protocol_version || visit.lawn_protocol_version === LAWN_V13_VERSION);

// The step for a booked visit, for readers that have the visit but not the plan (the
// tank sheet, the completion actions). `visit` is the row the caller already loaded
// (admin-protocols' loadVisitForPlan, technician-scoped): the same account reader
// the plan uses (staff switch or accepted estimate), then the cultivar policy.
// Returns { active, excluded, source, cultivar, addOn }. Gate off, another track or
// month, or no visit reads as inactive with no read at all.
async function stepForVisit(knex, visit, { trackKey, month, strict = false, profile: loadedProfile }) {
  const off = { active: false, excluded: false, source: null, cultivar: null, addOn: null };
  if (!bermudaRemovalVisit({ trackKey, month }) || !visit?.customer_id) return off;
  // A step visit is a LAWN visit on the v13 program (isLawnV13Visit), whoever asks: the
  // completion checks, the tank sheet and the completion actions.
  if (!isLawnV13Visit(visit)) return off;
  // The month is the VISIT's, never the request's: a request month that is not the
  // visit's own month opens nothing.
  if (visitMonthOf(visit) !== month) return off;
  // A caller that already read the active profile passes it (null when there is none): one read.
  const profile = loadedProfile !== undefined ? loadedProfile : await knex('customer_turf_profiles').where({ customer_id: visit.customer_id, active: true }).first();
  const wants = await accountWantsBermudaRemoval(knex, { customerId: visit.customer_id, profile, trackKey, propertyId: visit.property_id, strict });
  if (!wants.requested) return off;
  const cultivar = cultivarState(trackKey, profile?.cultivar);
  if (cultivar === 'excluded') return { ...off, excluded: true, source: wants.source, cultivar };
  return { active: true, excluded: false, source: wants.source, cultivar, addOn: stepAddOn(trackKey, month) };
}

// The three step lines carry one group id in every completion projection (the plan's
// completion options and /completion-actions), so a client adds and removes them
// together.
const BERMUDA_GROUP = 'bermuda_removal';

// Completion check: on a visit that carries the bermuda removal step (the account's
// staff switch or accepted estimate, an eligible grass, an April or June visit, v13
// live, not an excluded cultivar), Recognition or Fusilade II recorded without the
// other is refused (the surfactant is optional). Any other visit is never judged:
// Fusilade II alone on bed or border work, tree and shrub, or an unflagged lawn
// completes normally. `products` is the submitted completion product list; `serviceId`
// the visit. Returns the refusal message, or null. Gate off: always null.
// The visit when it carries the step (the checks above), else null.
async function stepVisitOf(knex, serviceId, { strict = false } = {}) {
  if (featureGates.lawnV13Live?.() !== true) return null;
  // The visit with the property the step is judged for (see resolvedVisitOf): the limits
  // count it and the completion lock keys on it, so a propertyless visit and an
  // explicit-property visit of the same lawn are one lock and one history.
  const visit = await resolvedVisitOf(knex, serviceId, { strict });
  if (!visit) return null;
  // The ACTIVE profile, whole (the staff switch and the cultivar ride on it), read once and
  // handed to stepForVisit.
  const profile = (await knex('customer_turf_profiles').where({ customer_id: visit.customer_id, active: true }).first()) || null;
  const step = await stepForVisit(knex, visit, { trackKey: profileTrack(profile), month: visitMonthOf(visit), strict, profile });
  return step.active ? visit : null;
}

// The serving window's staged bermuda rows for a step visit, and the catalog product each step line is
// bound to by them (see stepRowBindings). A missing staged v13 protocol reads as no rows.
async function servingStepRows(knex, visit) {
  const profile = await knex('customer_turf_profiles').where({ customer_id: visit.customer_id, active: true }).first();
  const { loadV13RowsForMonth } = require('./waveguard-plan-engine');
  const rows = await loadV13RowsForMonth(knex, profileTrack(profile), visitMonthOf(visit), { includeBermudaRemoval: true })
    .catch((err) => { if (err.code === 'lawn_v13_protocol_missing') return new Map(); throw err; });
  return { rows, bound: stepRowBindings(rows) };
}

// Is the program consistent for this step visit: the tagged limit rows exist and their Recognition and
// Fusilade II ids equal the herbicides the serving window links. A completion refuses otherwise.
async function stepConfigured(knex, visit) {
  const ids = await stepProductIds(knex);
  return stepProgramConsistent(ids, (await servingStepRows(knex, visit)).bound);
}

// Is the bermuda removal mix OFFERED on this visit: the visit carries the step (the shared
// step-visit check: gate, v13, a lawn visit, the step month, the account's switch or estimate, the
// cultivar), the program's limit rows are all configured, and neither limited product is capped
// or too soon. Decided from the visit alone, never from the completion-default prefill, so no
// early return of a reader (defaults gates off, a one-time or per-application visit) hides it.
// Read strictly: a failed read throws, never "not offered".
async function stepOffered(knex, serviceId) {
  if (!bermudaRemovalLive() || featureGates.lawnV13Live?.() !== true) return false; // gate off: no read at all
  const visit = await stepVisitOf(knex, serviceId, { strict: true });
  if (!visit) return false;
  const ids = await stepProductIds(knex);
  if (!ids.tagged) return false;
  if (await capViolation(knex, visit, [{ id: ids.recognition }, { id: ids.fusilade }])) return false;
  // The serving window's staged step rows must be linked to active catalog products, as the projection requires.
  const { rows, bound } = await servingStepRows(knex, visit);
  if (!stepProgramConsistent(ids, bound)) return false;
  const catalog = await knex('products_catalog').whereIn('id', Object.values(bound)).select('id', 'active');
  const productOf = (id) => catalog.find((c) => String(c.id) === String(id)) || null;
  return stepLinesAvailable([RECOGNITION_KEY, FUSILADE_KEY, normalize(SURFACTANT)].map((key) => ({ product: productOf(bound[key]) })), rows);
}

// A visit with the property its step is judged for, whether or not the visit carries the
// step: the visit's own property, else a one-property customer's sole active property
// (effective_property_id; null when none resolves).
async function resolvedVisitOf(knex, serviceId, { strict = false } = {}) {
  if (!UUID_RE.test(String(serviceId || ''))) return null;
  const { savepointRead } = require('../utils/savepoint-read');
  const visit = await savepointRead(knex, (k) => k('scheduled_services').where({ id: serviceId }).first('id', 'customer_id', 'property_id', 'scheduled_date', 'service_type', 'lawn_protocol_version'));
  if (!visit?.customer_id || !visit.scheduled_date) return null;
  const scope = await profilePropertyScope(knex, visit.customer_id, visit.property_id, strict);
  return { ...visit, effective_property_id: scope.effective || null };
}

// The property a visit's step is judged for (see stepVisitOf), for the plan's and the tank
// sheet's limit probe: the visit's own property, else a one-property customer's sole one.
async function effectivePropertyId(knex, visit) {
  return (await profilePropertyScope(knex, visit.customer_id, visit.property_id, false)).effective || null;
}

// The step products' catalog ids, from the program's own tagged product_limits rows (never a
// display name): Recognition is the product on the tagged annual_max_rate row (the label
// rate is its alone), Fusilade II the other tagged product. `tagged` is false unless all five
// expected rows exist (then readers fall back to names; a completion check refuses).
async function stepProductIds(knex) {
  const rows = await knex('product_limits').where({ match_value: BERMUDA_GROUP }).select('product_id', 'limit_type');
  const recognition = rows.find((row) => row.limit_type === 'annual_max_rate')?.product_id || null;
  const fusilade = rows.map((row) => row.product_id).find((id) => id && id !== recognition) || null;
  // Configured only when ALL five expected rows exist: Recognition's annual count, interval and label
  // rate, and Fusilade II's annual count and interval. Anything less is unconfigured, so the plan and
  // sheet withhold the step and a completion refuses, never a half-limited step.
  const has = (product, type) => rows.some((row) => String(row.product_id) === String(product) && row.limit_type === type);
  const complete = !!recognition && !!fusilade
    && ['annual_max_apps', 'min_interval_days', 'annual_max_rate'].every((type) => has(recognition, type))
    && ['annual_max_apps', 'min_interval_days'].every((type) => has(fusilade, type));
  return { recognition: recognition ? String(recognition) : null, fusilade: fusilade ? String(fusilade) : null, tagged: complete };
}

const NOT_CONFIGURED_MESSAGE = 'Bermuda removal cannot be recorded: its application limits are not loaded for Recognition and Fusilade II. Ask the office to load them before recording this mix.';

// The rate a completion states for a product ({ ratePer1000, unit }), or null: the cap
// warning projects the year with what was actually sprayed.
// The submitted entries with each productId in its canonical spelling (a UUID in upper case is
// the same product to Postgres and to the completion writer): every comparison below reads this.
function canonicalEntries(products) {
  if (!Array.isArray(products)) return products;
  const { canonicalProductId } = require('./service-report/report-identity-snapshot');
  return products.map((p) => (p && p.productId != null ? { ...p, productId: canonicalProductId(p.productId) } : p));
}

function submittedRate(products, id) {
  const entry = products.find((p) => String(p?.productId) === id);
  return Number(entry?.rate) > 0 && entry?.rateUnit ? { ratePer1000: Number(entry.rate), unit: entry.rateUnit } : null;
}

// Catalog ids of the two step herbicides when the program's tagged limit rows are missing: the
// product each staged bermuda removal row is linked to (lawn_protocol_products.product_id, by the
// row's own recipe name) and each product alias that spells the name. Sets of id strings by
// normalized name.
async function stepProductIdsByLink(knex) {
  const known = { [RECOGNITION_KEY]: new Set(), [FUSILADE_KEY]: new Set() };
  const staged = await knex('lawn_protocol_products').whereRaw("gates->>'bermudaRemoval' = 'true'").whereNotNull('product_id').select('product_id', 'product_name');
  for (const row of staged) known[normalize(row.product_name)]?.add(String(row.product_id));
  if (await knex.schema.hasTable('product_aliases')) {
    for (const row of await knex('product_aliases').select('product_id', 'alias_name')) known[normalize(row.alias_name)]?.add(String(row.product_id));
  }
  return known;
}

// The step products a completion submitted: { recognition, fusilade } (each a { id, name }
// or null), matched by catalog ID; `unconfigured` is true when the program's tagged rows
// are missing yet a step product is present by name (a completion check then refuses).
async function submittedStepProducts(knex, submittedEntries) {
  const products = canonicalEntries(submittedEntries);
  const none = { recognition: null, fusilade: null, unconfigured: false };
  if (!Array.isArray(products)) return none;
  const submitted = [...new Set(products.map((p) => p?.productId).filter(Boolean).map(String))];
  if (!submitted.length) return none;
  const rows = await knex('products_catalog').whereIn('id', submitted).select('id', 'name');
  const ids = await stepProductIds(knex);
  if (ids.tagged) {
    const byId = (id) => {
      const row = rows.find((candidate) => String(candidate.id) === id);
      return row ? { ...row, proposed: submittedRate(products, id) } : null;
    };
    return { recognition: byId(ids.recognition), fusilade: byId(ids.fusilade), unconfigured: false };
  }
  // The tagged limit rows are missing: the step products are known by the staged protocol links
  // (the bermuda rows' product_id) and the product aliases first, then by name.
  const known = await stepProductIdsByLink(knex);
  const find = (key) => rows.find((row) => known[key].has(String(row.id))) || rows.find((row) => normalize(row.name) === key) || null;
  const recognition = find(RECOGNITION_KEY);
  const fusilade = find(FUSILADE_KEY);
  return { recognition, fusilade, unconfigured: !!(recognition || fusilade) };
}

// The pair rule's message for the submitted step products, or null when they are a
// complete pair (or none): shared by the preflight and the in-transaction recheck.
function pairMessage({ recognition, fusilade, unconfigured }) {
  if (unconfigured) return NOT_CONFIGURED_MESSAGE;
  if (Boolean(recognition) === Boolean(fusilade)) return null;
  return recognition
    ? 'Recognition goes on with Fusilade II in the bermuda removal mix. Add Fusilade II too, or take Recognition off this visit.'
    : 'Fusilade II is never applied without Recognition. Add Recognition too, or take Fusilade II off this visit.';
}

async function bermudaPairViolation(knex, products, { serviceId } = {}) {
  if (!bermudaRemovalLive()) return null;
  const submitted = await submittedStepProducts(knex, products);
  if (!submitted.recognition && !submitted.fusilade) return null;
  // Judged only when this visit carries the step. A completion reads the account STRICTLY: a read
  // error fails the completion, never "not requested".
  const stepVisit = await stepVisitOf(knex, serviceId, { strict: true });
  if (!stepVisit) return null;
  // The limits and the serving window must agree on the step's products, else it is unconfigured.
  if (!submitted.unconfigured && !(await stepConfigured(knex, stepVisit))) return NOT_CONFIGURED_MESSAGE;
  return pairMessage(submitted);
}

// A recorded step spray needs a sizable amount: its treated area TOGETHER with the amount used, or a
// stated rate with a valid unit. A spot mix has no catalog-derived amount, so an area alone (or an
// amount alone) cannot be sized per 1,000 sq ft, and the application history and the label-rate cap
// would count nothing. Both herbicides on a step visit, Recognition alone on any other visit; on a fresh attempt only (the caller). Returns
// the message, or null.
const AREA_REQUIRED_MESSAGE = 'Enter the area treated and the amount used for the bermuda mix.';
async function bermudaAreaViolation(knex, submittedEntries, { serviceId } = {}) {
  if (!bermudaRemovalLive()) return null;
  const products = canonicalEntries(submittedEntries);
  const { recognition, fusilade } = await submittedStepProducts(knex, products);
  // On a step visit both herbicides are judged. On any other visit only Recognition is: every
  // Recognition spray enters the history the caps count (enforceStepLimitsInTransaction), so it
  // must be sizable wherever it is recorded; Fusilade II alone there is bed or border work.
  const onStepVisit = !!(recognition || fusilade) && !!(await stepVisitOf(knex, serviceId, { strict: true }));
  const stepIds = (onStepVisit ? [recognition, fusilade] : [recognition]).filter(Boolean).map((row) => String(row.id).toLowerCase());
  if (!stepIds.length) return null;
  const positive = (value) => Number(value) > 0;
  const { isValidRateUnit } = require('./inventory-units');
  const sized = (p) => (positive(p.areaValue) && positive(p.totalAmount)) || (positive(p.rate) && isValidRateUnit(p.rateUnit));
  // The product the label-rate cap counts (Recognition, by the tagged row's product) must also be
  // COUNTABLE: its history row, built here as the completion will write it, has to read as more
  // than zero in the cap's own unit. A weight product entered as 0.03 fl oz, or an amount with no
  // unit, is valid input but would count for nothing, so it is refused like a missing amount.
  const capRow = await knex('product_limits').where({ match_value: BERMUDA_GROUP, limit_type: 'annual_max_rate' }).first('product_id', 'limit_unit');
  const { baseQuantityUnit } = require('./inventory-units');
  const countable = (p) => {
    if (!capRow || String(p.productId) !== String(capRow.product_id).toLowerCase()) return true;
    return require('./application-limits').bermudaRowRate({
      application_rate: p.rate,
      rate_unit: p.rateUnit || null,
      quantity_applied: positive(p.totalAmount) ? p.totalAmount : null,
      quantity_unit: positive(p.totalAmount) ? baseQuantityUnit(p.amountUnit || p.rateUnit || null) : null,
      area_treated_sqft: String(p.areaUnit || '').toLowerCase() === 'sqft' ? p.areaValue : null,
    }, capRow) > 0;
  };
  const missing = products.some((p) => stepIds.includes(String(p?.productId)) && (!sized(p) || !countable(p)));
  return missing ? AREA_REQUIRED_MESSAGE : null;
}

// Completion check, beside the pair check (fresh attempts only): a step spray on a
// step visit that would be the 3rd this calendar year or fewer than 42 days after the
// last one at that property is refused with the limit's own message. Judged through
// the same checkLimits path and program as the plan, bounded at the visit's date and
// leaving this visit's own rows out. Returns the message, or null. Gate off, another
// visit or no step product submitted: always null.
async function bermudaLimitViolation(knex, products, { serviceId } = {}) {
  if (!bermudaRemovalLive()) return null;
  const { recognition, fusilade, unconfigured } = await submittedStepProducts(knex, products);
  const sprayed = [recognition, fusilade].filter(Boolean);
  if (!sprayed.length) return null;
  const visit = await stepVisitOf(knex, serviceId, { strict: true });
  if (!visit) return null;
  if (unconfigured || !(await stepConfigured(knex, visit))) return NOT_CONFIGURED_MESSAGE;
  return capViolation(knex, visit, sprayed);
}

// The step's caps for the products being recorded, judged for the visit's effective
// property through the same checkLimits path and program as the plan, bounded at the
// visit's date and leaving this visit's own rows out. The refusal message, or null.
async function capViolation(knex, visit, sprayed) {
  const limits = require('./application-limits');
  for (const product of sprayed) {
    const result = await limits.checkLimits(visit.customer_id, product.id, visit.scheduled_date, knex, {
      program: BERMUDA_GROUP, propertyId: visit.effective_property_id || null, excludeScheduledServiceId: visit.id,
      // A write: the whole calendar year counts and the nearest spray on EITHER side sets the
      // interval, so a backdated completion is held by a later recorded spray too.
      wholeYear: true,
      ...(product.proposed ? { proposed: product.proposed } : {}),
    });
    if (result.blocks.length) return `${result.blocks[0].message} Bermuda removal cannot be recorded on this visit.`;
  }
  return null;
}

// Inside the completion transaction, right before the visit's application rows are
// written: when the visit carries the step and a step product is being recorded, take a
// transaction-scoped advisory lock keyed by the CUSTOMER, always (the repo's
// pg_advisory_xact_lock(hashtext, hashtext) idiom, as triage-locks). The history a cap
// counts is still scoped per property, but a propertyless completion (judged against a
// customer's sole or primary property) and a property-scoped one for the same customer
// can read overlapping history, so every bermuda spray of one customer serializes on one key.
// Then re-run the limit check on the SAME transaction. Two completions for one customer
// serialize here, so the second sees the first's committed spray; a violation throws
// code lawn_bermuda_limit_reached and the transaction rolls back. The preflight
// (bermudaLimitViolation, before any write) stays; this closes the race after it.
// A fresh attempt only (the caller skips a resume). Gate off or no step: nothing.
const LOCK_NAMESPACE = 'bermuda-removal-step';
async function enforceStepLimitsInTransaction(trx, products, { serviceId } = {}) {
  if (!bermudaRemovalLive()) return;
  const { recognition, fusilade, unconfigured } = await submittedStepProducts(trx, products);
  if (!recognition && !fusilade) return;
  // Eligibility decides only whether the PAIR rule and the Fusilade II cap apply. A recorded
  // Recognition is capped on any visit of any month, whatever the account says NOW (a switch
  // turned off, an estimate archived, a cultivar changed mid-completion): every Recognition
  // spray is in the history the cap counts. Fusilade II alone on a visit that does not carry
  // the step is bed or border work and consumes nothing.
  const stepVisit = await stepVisitOf(trx, serviceId, { strict: true });
  // The visit carries the step as of NOW (a switch turned on after the preflight): the pair
  // rule holds here too, on the same strict reads and transaction, before any cap.
  const inconsistent = !!stepVisit && !unconfigured && !(await stepConfigured(trx, stepVisit));
  const pairProblem = stepVisit ? (inconsistent ? NOT_CONFIGURED_MESSAGE : pairMessage({ recognition, fusilade, unconfigured })) : null;
  if (pairProblem) throw Object.assign(new Error(pairProblem), { code: inconsistent ? 'lawn_bermuda_limit_reached' : 'lawn_bermuda_pair_required' });
  const sprayed = recognition ? [recognition, fusilade].filter(Boolean) : (stepVisit ? [fusilade] : []);
  if (!sprayed.length) return;
  const visit = stepVisit || await resolvedVisitOf(trx, serviceId, { strict: true });
  if (!visit) return;
  await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?), hashtext(?::text))',
    [LOCK_NAMESPACE, `customer:${visit.customer_id}`]);
  const message = (unconfigured && stepVisit) ? NOT_CONFIGURED_MESSAGE : await capViolation(trx, visit, sprayed);
  if (message) throw Object.assign(new Error(message), { code: 'lawn_bermuda_limit_reached' });
}

// The pest recap is not a place to record the bermuda removal spray: it takes no treated area
// or amount, so a Recognition row written there cannot be sized for the label-rate cap, and it
// has no step visit to judge the pair, the 2 a year or the 42 days against. Called inside the
// recap's transaction AFTER its ledger write, so it reads what was really written (a product
// resolved from an id or from a legacy name alike). A live Recognition ledger row for this
// record throws a 400 and the transaction rolls back. Gate off, or no tagged label-rate row to
// name Recognition by: nothing.
const RECAP_REFUSAL_MESSAGE = 'Recognition is recorded on the lawn visit that carries the bermuda removal step. Take it off this recap.';
async function refuseStepSprayOnRecap(trx, recordId) {
  if (!bermudaRemovalLive() || !recordId) return;
  const ids = await stepProductIds(trx);
  if (!ids.recognition) return;
  const written = await trx('property_application_history')
    .where({ service_record_id: recordId, product_id: ids.recognition }).whereNull('retracted_at').first('id');
  if (!written) return;
  throw Object.assign(new Error(RECAP_REFUSAL_MESSAGE), { code: 'lawn_bermuda_recap_not_allowed', isOperational: true, statusCode: 400 });
}

// After a completion ledgered its sprays: the label-rate WARNING for Recognition (its yearly
// maximum, judged on the history as it now stands, this spray included), as advisory messages
// for the completion response. Never a block, never a refusal: gate off, no Recognition
// recorded, an unreadable account or no warning all give none.
async function rateAdvisories(knex, serviceId, productIds = []) {
  if (!bermudaRemovalLive()) return [];
  const { savepointRead } = require('../utils/savepoint-read');
  try {
    // Each read that does not isolate itself runs in its own savepoint, one after another (a
    // savepoint nested inside another on one transaction would wait on itself), so a failed
    // statement rolls back to its savepoint before the error is swallowed below and the
    // caller's transaction stays usable. resolvedVisitOf isolates its own reads.
    const ids = await savepointRead(knex, (k) => stepProductIds(k));
    if (!ids.tagged || !productIds.map((id) => String(id).toLowerCase()).includes(String(ids.recognition).toLowerCase())) return [];
    const visit = await resolvedVisitOf(knex, serviceId, { strict: true });
    if (!visit) return [];
    const result = await savepointRead(knex, (k) => require('./application-limits').checkLimits(visit.customer_id, ids.recognition, visit.scheduled_date, k, {
      program: BERMUDA_GROUP, propertyId: visit.effective_property_id || null,
    }));
    return result.warnings.filter((warning) => warning.type === 'annual_max_rate').map((warning) => warning.message);
  } catch (err) {
    return [];
  }
}

// The step's lines are marked when the recipe lines are parsed, so every later
// decision reads the mark, never a product name.
const markStepLines = (lines) => lines.map((line) => ({ ...line, bermudaStep: true }));
const isStepLine = (item) => item?.bermudaStep === true;

// One selection: when any step line is selected, all of them are. Applied to the
// resolved candidate lines before limits are read.
function selectStepAtomically(items) {
  if (!items.some((item) => isStepLine(item) && item.selected)) return items;
  return items.map((item) => (isStepLine(item) && !item.selected
    ? { ...item, selected: true, selectionReason: 'bermuda_step_selected_together' } : item));
}

// The step is whole or absent. `usable` says whether all three lines can be applied
// (the caller knows the plan's or the sheet's own line states).
//   - Not usable and nothing of it is selected: the three lines leave and the visit gets
//     a WARNING, never a block, so the visit's base products, quantities and mixing
//     order are untouched.
//   - Not usable and some line is selected: the three lines stay, each marked
//     unavailable with the reason and no amount, and each carries a product-scoped
//     block. Only the step's own lines are blocked.
function settleStep(items, usable) {
  const none = { items, blocks: [], warnings: [] };
  const stepItems = items.filter(isStepLine);
  if (usable || !stepItems.length) return none;
  if (!stepItems.some((item) => item.selected)) {
    return {
      items: items.filter((item) => !isStepLine(item)),
      blocks: [],
      warnings: [{
        code: 'lawn_bermuda_step_unavailable', severity: 'warning',
        message: 'Bermuda removal is not offered on this visit: Recognition, Fusilade II and the surfactant go together, and one of them is blocked or has no planned row.',
      }],
    };
  }
  const reason = 'Bermuda removal is blocked: Recognition, Fusilade II and the surfactant go together, and one of them is blocked or has no planned row. Enter the actual work.';
  return {
    items: items.map((item) => (isStepLine(item) ? { ...item, spot: null, unavailable: { reason } } : item)),
    blocks: stepItems.map((item) => ({
      code: 'lawn_bermuda_step_unavailable', severity: 'block',
      productId: item.product?.id || null, productName: item.product?.name || null, message: reason,
    })),
    warnings: [],
  };
}

// The three step lines are a backpack spot mix of their own, never part of the visit's
// base tank mix: the base mixing order leaves every step line out, selected or not.
const inMixingOrder = (item) => !isStepLine(item);

const WATER_STEP = {
  productId: null, productName: 'Water', category: 'water',
  instruction: 'Fill the backpack sprayer about half full with clean water.',
};

// The backpack mix order for the step, apart from the base order: water, Recognition,
// Fusilade II, then the surfactant last. The recipe lists the lines in that order, so
// the lines keep it. Only when the step is available: the lines given are the step lines the
// reader offers (the plan passes the selected ones, the visit's tank sheet all of them); an
// unavailable line, or `held` for a blocked mix, gives no order.
// Returns { bermudaMixingOrder } or {} (a visit with no step has no such field).
function mixOrderField(items, held = false) {
  const lines = items.filter((item) => isStepLine(item) && item.product && !item.unavailable);
  if (held || !lines.length) return {};
  return {
    bermudaMixingOrder: [WATER_STEP, ...lines.map((item) => ({
      productId: item.product.id,
      productName: item.product.name,
      category: item.product.mixing_order_category || 'unclassified',
      instruction: item.product.mixing_instructions || item.raw,
    }))].map((step, index) => ({ step: index + 1, ...step })),
  };
}

const ELIGIBILITY_UNAVAILABLE_WARNING = {
  code: 'lawn_bermuda_eligibility_unavailable', severity: 'warning',
  message: 'Bermuda removal could not be checked for this visit; use the full form and check the account.',
};

const EXCLUDED_CULTIVAR_WARNING = {
  code: 'lawn_bermuda_cultivar_excluded', severity: 'warning',
  message: 'Bermuda removal is off for this lawn: the St. Augustine cultivar on file (ProVista, Captiva or Seville) is not eligible.',
};

// A CitraBlue or unconfirmed St. Augustine cultivar: a hard test-patch note on each step
// line (required, so it also reaches the selected items' plan warnings).
const addTestPatchNote = (items) => items.map((item) => (isStepLine(item)
  ? { ...item, gateNotes: [...(item.gateNotes || []), { key: 'testPatchFirst', severity: 'required', text: TEST_PATCH_NOTE }] } : item));

// The catalog product each step line is bound to, from the serving window's STAGED rows (never the
// exact-name matcher): { [normalized recipe name]: catalog id } over the bermuda removal rows that carry
// a product link. An alias-named catalog product linked from its staged row is a valid member.
function stepRowBindings(rows) {
  const bound = {};
  for (const row of rows.values()) {
    if (row?.gates?.bermudaRemoval === true && row.productId) bound[normalize(row.protocolProductName || row.productName)] = String(row.productId);
  }
  return bound;
}

// The program is consistent only when the Recognition and Fusilade II ids on the tagged limit rows
// EQUAL the two herbicides the serving window's rows link, and the surfactant row is linked: a
// relinked window (other ids than the limits judge) is unconfigured, so the plan and sheet withhold the
// step and a completion refuses.
const stepProgramConsistent = (ids, bound) => ids.tagged
  && bound[RECOGNITION_KEY] === ids.recognition && bound[FUSILADE_KEY] === ids.fusilade && !!bound[normalize(SURFACTANT)];

// The three step lines can be applied only when each has an active catalog product LINKED to a
// staged row of the serving window. One rule, for the projection and for stepOffered.
const stepLinesAvailable = (members, rows) => members.every((m) => m.product && m.product.active !== false && rows.get(String(m.product.id)));

// The ONE decision about whether the step stands, for the plan, the tank sheet and the
// completion actions alike. `items` carry the three marked step lines among the visit's
// own; `rows` is the serving v13 window's staged rows by product id; `probeLimits(items)`
// is the caller's own limit read (the plan's v13Limits, the sheet's v13VisitLimits) over
// Recognition and Fusilade II as the step program, even when nobody selected them.
// The step is usable only when all three lines have an active catalog product LINKED to a
// staged row and neither limited product is capped or too soon. Then it settles (a
// warning and no lines when nothing of it was selected, product-scoped blocks and
// unavailable lines when some was). Returns { items, blocks, warnings }.
async function projectBermudaStep(items, { knex, rows, probeLimits, productOf = () => null, testPatch = false }) {
  if (!items.some(isStepLine)) return { items, blocks: [], warnings: [], limitWarnings: [] };
  // The limited products are Recognition and Fusilade II by catalog id (the surfactant has
  // no limits; it is held to the step by the staged row, below). Program rows missing: the
  // step is unavailable, never judged on names.
  const ids = await stepProductIds(knex);
  // Each step line is a member by the staged row's product link, not by the exact-name matcher: its
  // product is the catalog product the serving window's row links (the caller's own product shape).
  const bound = stepRowBindings(rows);
  const bind = (item) => {
    const id = bound[normalize(String(item.raw || '').split(' \u2014 ')[0])];
    if (!isStepLine(item) || !id || String(item.product?.id) === id) return item;
    return { ...item, product: productOf(id) };
  };
  const bindable = items.map(bind);
  const members = bindable.filter(isStepLine);
  const limited = new Set([ids.recognition, ids.fusilade].filter(Boolean));
  const probe = members.filter((m) => m.product?.id && limited.has(String(m.product.id)))
    .map((m) => ({ selected: true, bermudaStep: true, product: { id: m.product.id, name: m.product.name } }));
  // The probe gets the staged rows, so a step line's planned rate counts in the year's total.
  const found = probe.length ? await probeLimits(probe, rows) : null;
  const capped = found ? found.capped.size > 0 : false;
  const usable = stepProgramConsistent(ids, bound) && !capped && stepLinesAvailable(members, rows);
  const settled = settleStep(bindable, usable);
  const noted = withRowGateNotes(settled.items, rows);
  return { ...settled, items: testPatch ? addTestPatchNote(noted) : noted, limitWarnings: found?.warnings || [] };
}

// A step line that carries no gate notes of its own (the completion actions are built
// from the recipe text, not from the staged rows) gets the notes its staged row states,
// through the plan's own reader of a row's gates (only the spray conditions), so every
// projection says the same.
function withRowGateNotes(items, rows) {
  const { v13GateNotes } = require('./waveguard-plan-engine');
  // An EMPTY list is missing too: a line the exact-name matcher did not resolve was built with
  // `gateNotes: []`, and binding it to the staged row's linked (alias-named) product must bring
  // that row's conditions with it.
  return items.map((item) => (isStepLine(item) && !item.gateNotes?.length && item.product
    ? { ...item, ...optionNotes({ gateNotes: v13GateNotes(rows.get(String(item.product.id))?.gates) }) } : item));
}

// The spray conditions the tech must see before choosing the step, in the order they are
// read out. Every projection that offers the step carries these from the staged rows.
const OPTION_NOTE_KEYS = ['activelyGrowingOnly', 'morningUnderF', 'noRainOrIrrigationHours', 'noMowDaysBeforeAfter', 'skipCelsiusInBermudaArea', 'zoysia2eeOnHand', 'testPatchFirst'];

// The spray conditions an option or action carries through a completion projection (the
// plan's completion options, /completion-actions): the step line's own gate notes for
// active growth, the June morning limit, rain and irrigation, mowing, the Celsius skip and the test patch,
// as the same { key, severity, text } shape, nothing when there is none.
const optionNotes = (item) => {
  const notes = (item?.gateNotes || []).filter((note) => OPTION_NOTE_KEYS.includes(note.key))
    .sort((a, b) => OPTION_NOTE_KEYS.indexOf(a.key) - OPTION_NOTE_KEYS.indexOf(b.key));
  return notes.length ? { gateNotes: notes } : {};
};

// What every completion option or action of the step carries: its group (added and removed
// together), the spot mode, and a no-prefill marker (a spot line has no catalog-derived
// amount; the tech enters the area and the amount). Options add the spray conditions.
const STEP_FIELDS = { group: BERMUDA_GROUP, applicationMode: 'spot', prefillAmount: false };
const stepOptionFields = (item) => ({ ...STEP_FIELDS, ...optionNotes(item) });

// The track a visit-scoped reader (the completion actions) uses: the ACTIVE turf profile's own
// grass (St. Augustine or Zoysia) when the visit is known, the request's track otherwise (a client
// that sends a blank or stale lawn type still gets the step for a Zoysia profile). Only while the
// removal gate and v13 are live; gate off, the request's track is the answer, as before.
async function trackForVisit(knex, loadVisit, requestedTrack) {
  if (!bermudaRemovalLive() || featureGates.lawnV13Live?.() !== true) return requestedTrack;
  const visit = await loadVisit();
  if (!visit?.customer_id) return requestedTrack;
  const profile = await knex('customer_turf_profiles').where({ customer_id: visit.customer_id, active: true }).first();
  return profileTrack(profile) || requestedTrack;
}

// A loader that runs once and hands every later caller its answer.
const once = (load) => {
  let pending = null;
  return () => { pending = pending || load(); return pending; };
};

// The step as the visit PLAN sees it, in the order the planner needs it, so the planner holds no
// bermuda decision of its own: every eligibility, cultivar, month, projection and output-shaping
// rule lives here, and every method is a no-op while the step is off.
//   openPlanStep(...)        before the protocol window is read: is the step wanted (gate, v13, an
//                            eligible grass, the account's switch or estimate); `protocolOptions`
//                            is what the window read must add to load the staged rows.
//   .resolve(...)            once the serving window and month are known: is the step active for
//                            THIS appointment (v13 resolved, the step month, the cultivar policy);
//                            returns the stage below.
//   stage.lines              the three marked recipe lines to add to the visit's conditional lines.
//   stage.select(items)      the one atomic selection of the three lines.
//   stage.project(items,..)  the shared projection: usable or not, the limits, the warnings and blocks
//                            (the excluded-cultivar warning included).
//   stage.field              the plan's `bermudaRemoval` output field (or nothing).
//   stage.mixOrderField(..)  the backpack step's own mixing order (or nothing).
async function openPlanStep(knex, { enabled, service, profile, calendarTrackKey, strict = false }) {
  const live = enabled && bermudaRemovalLive() && BERMUDA_REMOVAL_TRACKS.includes(calendarTrackKey);
  // The account is always read STRICTLY. A caller that asked for strict gets the read error; the
  // plan panel (not strict) gets an explicit unavailable state: no step lines and a warning on a
  // step-month visit, never a silently ineligible one.
  let wanted = { requested: false, source: null };
  let unavailable = false;
  if (live) {
    try {
      wanted = await accountWantsBermudaRemoval(knex, { customerId: service.customer_id, profile, trackKey: calendarTrackKey, propertyId: service.property_id || null, strict: true });
    } catch (err) {
      if (strict) throw err;
      unavailable = true;
    }
  }
  const readsRows = wanted.requested && cultivarState(calendarTrackKey, profile?.cultivar) !== 'excluded';
  return {
    protocolOptions: readsRows ? { includeBermudaRemoval: true } : {},
    resolve({ structuredProtocol, trackKey, month, parseLines }) {
      // The step month is the APPOINTMENT's own (ET calendar month of its date), never the assigned
      // protocol window's: an April-window visit rescheduled into May has no step.
      const visit = wanted.requested && structuredProtocol?.version === LAWN_V13_VERSION
        && bermudaRemovalVisit({ trackKey, month }) && visitMonthOf({ scheduled_date: service.scheduled_date }) === month;
      const cultivar = cultivarState(trackKey, profile?.cultivar);
      const addOn = visit ? stepAddOn(trackKey, month) : null;
      const active = !!addOn && cultivar !== 'excluded';
      const unreadVisit = unavailable && structuredProtocol?.version === LAWN_V13_VERSION
        && bermudaRemovalVisit({ trackKey, month }) && visitMonthOf({ scheduled_date: service.scheduled_date }) === month;
      const excludedWarnings = [
        ...(visit && cultivar === 'excluded' ? [EXCLUDED_CULTIVAR_WARNING] : []),
        ...(unreadVisit ? [ELIGIBILITY_UNAVAILABLE_WARNING] : []),
      ];
      return {
        lines: active ? markStepLines(parseLines(addOn.secondary)) : [],
        select: (items) => (active ? selectStepAtomically(items) : items),
        async project(items, { enabled: v13Active, rows, probeLimits, productOf }) {
          const projected = active && v13Active
            ? await projectBermudaStep(items, { knex, rows, probeLimits, productOf, testPatch: cultivar === 'test_patch' })
            : { items, blocks: [], warnings: [] };
          // The probe's warning-level results (the label-rate warning) join the plan's warnings under a
          // bermuda code the completion drawer forwards. A selected step is already covered by the
          // planner's own limit warnings for its selected lines, so they are not repeated.
          const probeWarnings = items.some((item) => isStepLine(item) && item.selected) ? [] : (projected.limitWarnings || []).map((warning) => ({ ...warning, code: 'lawn_bermuda_limit_warning' }));
          return { ...projected, warnings: [...excludedWarnings, ...projected.warnings, ...probeWarnings] };
        },
        field: active ? { bermudaRemoval: { active: true, source: wanted.source, mix: addOn.summary } } : {},
        mixOrderField,
      };
    },
  };
}

// The step as one reader sees it (the tank sheet, the completion actions): opened once
// from the booked visit, then asked for its lines, its staged-row options, its one
// selection, its settlement and its decoration of the response. Every method is a no-op
// while the step is off (gate, track, month, account, cultivar), so a route carries no
// branch of its own for it. `loadRows(options)` loads the window's staged rows;
// `probeLimits` is the route's own limit read.
async function openStep(knex, { loadVisit, trackKey, month, parseLines, loadRows, probeLimits, productOf, reportLimitWarnings = false }) {
  // `loadVisit` is called only when the step could apply at all (gate, track, month).
  const eligible = bermudaRemovalVisit({ trackKey, month }) && featureGates.lawnV13Live?.() === true;
  // The account is read STRICTLY: a read error is an explicit unavailable state (no step lines and a
  // warning), never a silently ineligible visit.
  let unavailable = false;
  let step = { active: false };
  if (eligible) {
    try { step = await stepForVisit(knex, await loadVisit(), { trackKey, month, strict: true }); } catch (err) { unavailable = true; }
  }
  const active = step.active === true;
  const state = { blocks: [], mark: false };
  // The cultivar policy's own warning for an excluded cultivar (the step is then off).
  const stepWarnings = [...(step.excluded ? [EXCLUDED_CULTIVAR_WARNING] : []), ...(unavailable ? [ELIGIBILITY_UNAVAILABLE_WARNING] : [])];
  const rowOptions = active ? { includeBermudaRemoval: true } : undefined;
  return {
    lines: active ? markStepLines(parseLines(step.addOn.secondary, 'conditional')) : [],
    rowOptions,
    select: (items) => (active ? selectStepAtomically(items) : items),
    // Settle against `rows`, or (the completion actions, which load none) the window's
    // staged rows loaded here; a missing v13 protocol reads as no rows.
    async settle(items, rows = null) {
      if (!active) return { items, blocks: [], warnings: stepWarnings, warningFields: stepWarnings.length ? { warnings: stepWarnings } : {} };
      let staged = rows;
      if (!staged) staged = await loadRows(rowOptions).catch((err) => { if (err.code === 'lawn_v13_protocol_missing') return new Map(); throw err; });
      const settled = await projectBermudaStep(items, { knex, rows: staged, probeLimits, productOf });
      state.blocks = settled.blocks;
      state.mark = step.cultivar === 'test_patch';
      // `warningFields`: a response that carries warnings only when there are some.
      // A reader that runs no limit check of its own (the completion actions) reports the probe's
      // warning-level results (the label-rate warning) beside the step's own.
      const warnings = [...stepWarnings, ...settled.warnings, ...(reportLimitWarnings ? settled.limitWarnings : [])];
      return { ...settled, warnings, warningFields: warnings.length ? { warnings } : {} };
    },
    // The response items: the test-patch note, and the unavailable mark a blocked step keeps.
    decorate(items) {
      if (!active) return items;
      const noted = state.mark ? addTestPatchNote(items) : items;
      if (!state.blocks.length) return noted;
      const reason = state.blocks[0].message;
      return noted.map((item) => (isStepLine(item) ? { ...item, spot: null, unavailable: { reason } } : item));
    },
    // The three actions carry the group id and the mark the settlement reads.
    tagActions: (actions, lines) => (active ? actions.map((action, index) => (lines[index].bermudaStep ? { ...action, bermudaStep: true, ...STEP_FIELDS } : action)) : actions),
    mixable: inMixingOrder,
    mixOrderField,
    info: { active, source: step.source },
  };
}

module.exports = {
  bermudaAreaViolation, stepOffered, trackForVisit, once,
  openPlanStep,
  refuseStepSprayOnRecap,
  visitMonthOf,
  RECOGNITION, FUSILADE, SURFACTANT, TEST_PATCH_NOTE,
  BERMUDA_REMOVAL_TRACKS, BERMUDA_REMOVAL_MONTHS,
  bermudaRemovalLive, bermudaRemovalVisit, accountWantsBermudaRemoval, profileTrack, stepAddOn, cultivarState,
  markStepLines, isStepLine,
  selectStepAtomically, settleStep, projectBermudaStep, openStep, addTestPatchNote, effectivePropertyId, stepProductIds, inMixingOrder, mixOrderField, optionNotes, stepOptionFields, EXCLUDED_CULTIVAR_WARNING,
  excludedCultivarSql, stepForVisit, BERMUDA_GROUP, bermudaPairViolation, bermudaLimitViolation, enforceStepLimitsInTransaction, rateAdvisories,
};
