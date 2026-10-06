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
// profilePropertyScope). Then the staff switch, then an accepted estimate that carries
// the add-on: the add-on is St. Augustine only, and the estimate must be for THIS
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
  const { estimateDataCarriesBermudaSuppression } = require('./pricing-engine/v1-legacy-mapper');
  const { savepointRead } = require('../utils/savepoint-read');
  let rows;
  try {
    rows = await savepointRead(knex, (k) => k('estimates')
      .where({ customer_id: customerId, status: 'accepted' })
      .whereNull('archived_at')
      .select('estimate_data', 'property_id'));
  } catch (err) {
    if (strict) throw err;
    return none;
  }
  const forThisProperty = (row) => (row.property_id ? String(row.property_id) === scope.effective : scope.sole === scope.effective);
  return rows.some((row) => forThisProperty(row) && estimateDataCarriesBermudaSuppression(row.estimate_data))
    ? { requested: true, source: 'estimate' }
    : none;
}

// The step for a booked visit, for readers that have the visit but not the plan (the
// tank sheet, the completion actions). `visit` is the row the caller already loaded
// (admin-protocols' loadVisitForPlan, technician-scoped): the same account reader
// the plan uses (staff switch or accepted estimate), then the cultivar policy.
// Returns { active, excluded, source, cultivar, addOn }. Gate off, another track or
// month, or no visit reads as inactive with no read at all.
async function stepForVisit(knex, visit, { trackKey, month }) {
  const off = { active: false, excluded: false, source: null, cultivar: null, addOn: null };
  if (!bermudaRemovalVisit({ trackKey, month }) || !visit?.customer_id) return off;
  const profile = await knex('customer_turf_profiles').where({ customer_id: visit.customer_id, active: true }).first();
  const wants = await accountWantsBermudaRemoval(knex, { customerId: visit.customer_id, profile, trackKey, propertyId: visit.property_id });
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
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
// The visit when it carries the step (the checks above), else null.
async function stepVisitOf(knex, serviceId) {
  if (featureGates.lawnV13Live?.() !== true || !UUID_RE.test(String(serviceId || ''))) return null;
  const visit = await knex('scheduled_services').where({ id: serviceId }).first('id', 'customer_id', 'property_id', 'scheduled_date');
  if (!visit?.customer_id || !visit.scheduled_date) return null;
  const profile = await knex('customer_turf_profiles').where({ customer_id: visit.customer_id, active: true }).first('grass_type');
  const month = MONTH_ABBR[Number(require('../utils/datetime-et').etCalendarDayOf(visit.scheduled_date).slice(5, 7)) - 1];
  const step = await stepForVisit(knex, visit, { trackKey: profileTrack(profile), month });
  return step.active ? visit : null;
}

// The catalog rows a completion submitted, by step product: { recognition, fusilade }
// (each a { id, name } or null).
async function submittedStepProducts(knex, products) {
  if (!Array.isArray(products)) return { recognition: null, fusilade: null };
  const ids = [...new Set(products.map((p) => p?.productId).filter(Boolean).map(String))];
  if (!ids.length) return { recognition: null, fusilade: null };
  const rows = await knex('products_catalog').whereIn('id', ids).select('id', 'name');
  const find = (key) => rows.find((row) => normalize(row.name) === key) || null;
  return { recognition: find(RECOGNITION_KEY), fusilade: find(FUSILADE_KEY) };
}

async function bermudaPairViolation(knex, products, { serviceId } = {}) {
  if (!bermudaRemovalLive()) return null;
  const { recognition, fusilade } = await submittedStepProducts(knex, products);
  if (Boolean(recognition) === Boolean(fusilade)) return null;
  // One of the two alone: judged only when this visit carries the step.
  if (!(await stepVisitOf(knex, serviceId))) return null;
  return recognition
    ? 'Recognition goes on with Fusilade II in the bermuda removal mix. Add Fusilade II too, or take Recognition off this visit.'
    : 'Fusilade II is never applied without Recognition. Add Recognition too, or take Fusilade II off this visit.';
}

// Completion check, beside the pair check (fresh attempts only): a step spray on a
// step visit that would be the 3rd this calendar year or fewer than 42 days after the
// last one at that property is refused with the limit's own message. Judged through
// the same checkLimits path and program as the plan, bounded at the visit's date and
// leaving this visit's own rows out. Returns the message, or null. Gate off, another
// visit or no step product submitted: always null.
async function bermudaLimitViolation(knex, products, { serviceId } = {}) {
  if (!bermudaRemovalLive()) return null;
  const { recognition, fusilade } = await submittedStepProducts(knex, products);
  const sprayed = [recognition, fusilade].filter(Boolean);
  if (!sprayed.length) return null;
  const visit = await stepVisitOf(knex, serviceId);
  if (!visit) return null;
  const limits = require('./application-limits');
  for (const product of sprayed) {
    const result = await limits.checkLimits(visit.customer_id, product.id, visit.scheduled_date, knex, {
      program: BERMUDA_GROUP, propertyId: visit.property_id || null, excludeScheduledServiceId: visit.id,
    });
    if (result.blocks.length) return `${result.blocks[0].message} Bermuda removal cannot be recorded on this visit.`;
  }
  return null;
}

// The step's lines are marked when the recipe lines are parsed, so every later
// decision reads the mark, never a product name.
const markStepLines = (lines) => lines.map((line) => ({ ...line, bermudaStep: true }));
const isStepLine = (item) => item?.bermudaStep === true;
const isRecognitionLine = (item) => normalize(item?.product?.name || item?.raw).includes(RECOGNITION_KEY);
const isFusiladeLine = (item) => normalize(item?.product?.name || item?.raw).includes(FUSILADE_KEY);

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

module.exports = {
  RECOGNITION, FUSILADE, SURFACTANT, TEST_PATCH_NOTE,
  BERMUDA_REMOVAL_TRACKS, BERMUDA_REMOVAL_MONTHS,
  bermudaRemovalLive, bermudaRemovalVisit, accountWantsBermudaRemoval, profileTrack, stepAddOn, cultivarState,
  markStepLines, isStepLine, isRecognitionLine, isFusiladeLine,
  selectStepAtomically, settleStep,
  stepForVisit, BERMUDA_GROUP, bermudaPairViolation, bermudaLimitViolation,
};
