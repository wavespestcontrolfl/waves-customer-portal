/** Editable completion defaults projected from the existing appointment planner.
 * No application record, profile update, inventory write or delivery occurs here.
 */
const { gateEnvValue } = require('../config/feature-gates');
const { addressKey } = require('./customer-properties');
const history = require('./lawn-assessment-history');
const { etCalendarDayOf } = require('../utils/datetime-et');
const { calculateLawnOverallScore, resolveStressDamage } = require('../../shared/lawn-scores.cjs');
const { detectServiceLine } = require('./service-report/service-line-configs');
const { normalizeInventoryUnit } = require('./inventory-units');

function lawnCompletionDefaultsEnabled() {
  return gateEnvValue('GATE_LAWN_COMPLETION_DEFAULTS') && gateEnvValue('GATE_LAWN_PROPERTY_HISTORY');
}

function scoreRow(row) {
  if (!row) return null;
  return {
    id: row.id, visitId: history.resolveVisit(row).visitId, date: row.visit_date,
    turf_density: row.turf_density, weed_suppression: row.weed_suppression,
    color_health: row.color_health, stress_damage: resolveStressDamage(row),
    fungus_control: row.fungus_control, thatch_level: row.thatch_level,
    overall_score: calculateLawnOverallScore(row),
  };
}

async function loadLawnCompletionContext(service, knex) {
  const prior = await history.historyBeforeVisit({
    customerId: service.customer_id, scheduledService: service,
    throughVisitDate: etCalendarDayOf(service.scheduled_date),
  }, knex);
  const installed = await history.installedForVisit({ customerId: service.customer_id, serviceId: service.id }, knex);
  const currentHistory = installed ? await history.historyForAssessment(installed, { knex }) : null;
  const resolvedHistory = currentHistory || prior;
  const scope = resolvedHistory.scope;
  const rows = resolvedHistory.rows;
  const current = currentHistory?.current || null;
  // The turf profile is still customer-owned. Until property templates land,
  // its area/grass can seed only the proven current home, never a second lawn.
  // The proof compares the VISIT's address: the plan query joins the
  // customers row onto the unprefixed address fields, so an appointment
  // stamped to a second address (service_address_*) must be keyed by that
  // stamp, not by the account address the sole saved property matches. The
  // scope resolver already withholds a property under conflicting stamped
  // evidence; this keeps the direct check honest on its own (Codex #4113 P1).
  const visitAddress = service.service_address_line1 ? {
    address_line1: service.service_address_line1, address_line2: service.service_address_line2,
    city: service.service_address_city, zip: service.service_address_zip,
  } : service;
  const propertyMatchesProfile = !!(scope.propertyId && visitAddress.address_line1
    && scope.propertyAddressKey === addressKey(visitAddress));
  const attempts = await history.assessmentQuery(service.customer_id, knex, { confirmed: false })
    .where('ss.id', service.id).orderBy('la.created_at', 'desc').orderBy('la.id', 'desc');
  const latestAssessment = scope.propertyId ? attempts.find((row) => history.isEligible(row, scope)) || resolvedHistory.previous : null;
  return {
    propertyId: scope.propertyId, propertyMatchesProfile, latestAssessment,
    // The two keys the proof compared, so the completion transaction can
    // rebuild them from the LOCKED customer/visit/property rows and abort
    // when an address edit committed after the plan was built (Codex #4113 P2).
    addressProof: {
      // The scope keeps the candidate key after withholding its id; the proof carries a key only for a proven id.
      propertyId: scope.propertyId, propertyAddressKey: scope.propertyId ? scope.propertyAddressKey : null,
      visitAddressKey: visitAddress.address_line1 ? addressKey(visitAddress) : null,
      stamped: !!service.service_address_line1,
    },
    isLawn: detectServiceLine(service.service_type) === 'lawn',
    history: {
      available: !!scope.propertyId,
      rows: rows.map(scoreRow), current: scoreRow(current),
      previous: scoreRow(resolvedHistory.previous),
      baseline: scoreRow(resolvedHistory.baseline),
      progress: history.progress(rows, current || resolvedHistory.previous),
    },
  };
}

function completionMethod(item, protocolProduct) {
  // The operating layer's explicit mode wins over the field-reference line
  // parse: classifyProtocolLine tags every SpeedZone line SPOT_ALLOWANCE, yet
  // the seeded Bahia March row is application_mode 'broadcast'. Only a row
  // without an explicit mode lets the parsed scope decide (Codex r13 P1).
  const mode = protocolProduct?.applicationMode;
  if (mode === 'spot' || (!mode && item.scope?.includes('SPOT'))) return 'spot_treatment';
  if (item.product?.applicationMethod) return item.product.applicationMethod;
  // Weighed WDG/WG/WSG/WP concentrates are still sprayed. The catalog
  // formulation, never the quantity unit, distinguishes spreader granules
  // ('Granule (G)', 'Granular pre-emergent on fertilizer', 'Granular bait')
  // from tank mixes ('Water-dispersible granule (WDG)').
  const formulation = String(item.product?.formulation || '').trim();
  const dispersible = /water[- ]?(dispersible|soluble)|\b(WDG|WG|WSG|WP|SP|DF)\b/i.test(formulation);
  const granular = /granul|\(G\)|^G$/i.test(formulation);
  return granular && !dispersible ? 'granular_broadcast' : 'broadcast_spray';
}

function matchesLawnCompletionProtocol(protocol, assigned, trackKey) {
  const exactAssignment = !!(assigned.protocolKey && assigned.protocolVersion && assigned.windowKey);
  return !!(protocol?.window && protocol.grassTrack === trackKey
    && (protocol.status === 'active' || (protocol.status === 'archived' && exactAssignment))
    && [[protocol.protocolKey, assigned.protocolKey], [protocol.version, assigned.protocolVersion], [protocol.window.key, assigned.windowKey]]
      .every(([resolved, expected]) => !expected || expected === resolved));
}

// A stored protocol rate must reproduce exactly. A null rate on a nutrient
// row (`lb_n` / `lb_k*`) is a derived-rate default — the operating layer
// seeds nutrition rows that way and the planner derives the rate from the
// visit's nutrient target — so that recipe is matched on the derivation: the
// visit's target must sit inside the archived gate's target range (or the
// quantity stays withheld when no target was given). A null rate anywhere
// else, or a target the archived gate cannot verify, is drift.
function targetRange(text) {
  // Only the value or range that precedes the 'lb' unit is the target
  // ('0.35-0.50 lb N/1000'); analysis digits (K2O) and the per-area
  // denominator are not.
  const match = String(text ?? '').match(/(\d+(?:\.\d+)?)(?:\s*[-–]\s*(\d+(?:\.\d+)?))?\s*lbs?\b/i);
  if (!match) return null;
  const low = Number(match[1]); const high = match[2] != null ? Number(match[2]) : low;
  return [Math.min(low, high), Math.max(low, high)];
}

function archivedRateMatches(product, mix) {
  if (product.ratePer1000 != null) {
    // Protocol rows and the catalog spell the same unit differently ('fl oz'
    // vs 'fl_oz'); only a different physical unit is recipe drift.
    return Number(product.ratePer1000) > 0 && Number(product.ratePer1000) === mix?.ratePer1000
      && normalizeInventoryUnit(product.rateUnit) === normalizeInventoryUnit(mix?.rateUnit);
  }
  const unit = String(product.rateUnit || '').toLowerCase();
  const nutrient = unit === 'lb_n' ? ['target_n_analysis', 'targetN', 'targetNPer1000']
    : unit.startsWith('lb_k') ? ['target_k_analysis', 'targetK', 'targetKPer1000'] : null;
  if (!nutrient) return false;
  if (mix?.rateSource === 'missing_rate') return true;
  const [source, gateKey, mixKey] = nutrient;
  const range = targetRange(product.gates?.[gateKey]);
  const target = Number(mix?.[mixKey]);
  return mix?.rateSource === source && Number(mix.ratePer1000) > 0 && !!range
    && Number.isFinite(target) && target >= range[0] - 1e-6 && target <= range[1] + 1e-6;
}

function archivedLawnRecipeMatches(protocol, items) {
  if (protocol?.status !== 'archived') return true;
  const selected = items.filter(item => item.selected && item.product);
  const products = protocol.products || [];
  return products.filter(product => product.defaultInPlan).every(product => selected.some(item => item.product.id === product.productId))
    && selected.every(item => {
      const product = products.find(row => row.productId === item.product.id);
      return !!product && !item.substitution && archivedRateMatches(product, item.mix)
        && product.applicationMode === (item.scope?.includes('SPOT') ? 'spot' : 'broadcast');
    });
}

// The planned quantity is the tech's starting point whenever the planner
// produced one (owner ruling 2026-09-11): an unverified label stamp or a plan
// block (inventory, blackout, budget, approval) no longer withholds it —
// those still show in the plan banner, and the amount stays the tech's
// actual to confirm or edit. Only a missing quantity or a per-basis unit
// ("fl oz/acre" is a concentration, not an applied amount) leaves it blank.
function completionItem(item, protocolProduct) {
  const amountAvailable = Number(item.mix?.amount) > 0 && !String(item.mix?.amountUnit || '').includes('/');
  return {
    ...item,
    applicationMethod: completionMethod(item, protocolProduct),
    // Keep the planned area when the quantity is unavailable. It is not an
    // applied amount; the technician still records the actual quantity.
    mix: amountAvailable ? item.mix : {
      treatedSqft: item.mix?.treatedSqft ?? null, areaFactor: item.mix?.areaFactor ?? null,
      amount: null, amountUnit: String(item.mix?.amountUnit || '').split('/')[0] || null,
      ratePer1000: null, rateUnit: item.mix?.rateUnit || null,
    },
    amountReason: amountAvailable ? null : 'Enter the actual amount; a suggested quantity is unavailable.',
  };
}

// A lawn plan attributes the visit only when a program actually applies: a
// WaveGuard tier or a COMPLETE explicit appointment assignment (key, version
// and window). The planner can still resolve an active protocol by grass
// track for anyone; that resolution must not become a one-time or commercial
// visit's protocol — and a partial assignment (window only) must not let the
// matcher's wildcards adopt the calendar-resolved protocol either.
// An EXPLICIT non-membership billing lane defeats the tier fallback: a
// customer reclassified to per_visit / one_time can legitimately keep a
// legacy Bronze–Platinum tier on the row, and billing-lane already rules
// that such a lane is authoritative over lingering tier fields (a per_visit
// / one_time customer is never dues-covered). Attribution follows the same
// classifier so a nonmember visit's applied products are not recorded as
// seasonal protocol actuals. per_application and annual_prepay are
// membership lanes; null / inferred keeps the tier rule.
const NON_PROGRAM_BILLING_MODES = new Set(['per_visit', 'one_time']);

function lawnPlanProgramApplies(plan) {
  const assigned = plan?.appointmentAssignment || {};
  const tierApplies = ['Bronze', 'Silver', 'Gold', 'Platinum'].includes(plan?.propertyGate?.serviceTier)
    && !NON_PROGRAM_BILLING_MODES.has(plan?.propertyGate?.billingMode);
  return tierApplies || !!(assigned.protocolKey && assigned.protocolVersion && assigned.windowKey);
}

// The ledger stamps a visit's protocol only when a program applies, the
// saved turf profile PROVES this service property (the plan's protocol,
// grass and products come from that profile — another property's profile
// must not be stamped onto this one), AND the plan the completion built
// actually resolved that visit's assignment (key / version / window, exact
// archived version included). With the completion-defaults gates off the
// planner neither proves the property nor resolves the assignment, so
// attribution is withheld — the honest record.
function lawnPlanAttributesVisit(plan) {
  return lawnPlanProgramApplies(plan)
    && plan?.propertyGate?.propertyMatchesProfile === true
    && matchesLawnCompletionProtocol(plan?.protocol?.structured, plan?.appointmentAssignment || {}, plan?.propertyGate?.trackKey);
}

function buildLawnCompletionDefaults(plan, context) {
  const protocol = plan.protocol.structured;
  const assigned = plan.appointmentAssignment;
  const programApplies = lawnPlanProgramApplies(plan);
  const protocolMatches = matchesLawnCompletionProtocol(protocol, assigned, plan.propertyGate.trackKey);
  const eligible = context.isLawn && context.propertyMatchesProfile && programApplies && protocolMatches;
  const products = protocol?.products || [];
  const protocolProductFor = (item) => products.find((row) => row.productId === (item.substitution?.originalProductId || item.product?.id));
  const items = eligible ? plan.mixCalculator.items.filter((item) => {
    const product = protocolProductFor(item);
    // defaultInPlan distinguishes defaults from opt-in rows. Gates can also
    // carry annual counters or safety metadata on a selected base product.
    return item.selected === true && item.product?.active !== false && product?.defaultInPlan;
  }).map((item) => completionItem(item, protocolProductFor(item))) : [];
  // The planner's recipe comes from the field reference (protocols.json);
  // the defaults list is the owner-edited operating layer. When a live
  // window registers none of the recipe's selected products as defaults,
  // an unexplained empty prefill would read as "nothing to apply" — say
  // why instead (Codex P1 #4126 r4). The data alignment is the owner's.
  const recipeUnregistered = eligible && items.length === 0
    && plan.mixCalculator.items.some(item => item.selected === true && item.product?.active !== false);
  return {
    enabled: true, serviceId: plan.serviceId, propertyId: context.propertyId,
    lawnSqft: context.propertyMatchesProfile ? plan.mixCalculator.lawnSqft : null,
    propertyMatchesProfile: context.propertyMatchesProfile,
    items, history: context.history,
    // An option carries the protocol row's application mode: the catalog
    // category alone reads a broadcast herbicide (SpeedZone in its window) as
    // spot work, and the closeout must record the mode the protocol prescribes.
    // A protocol row whose catalog product was deactivated is not offered:
    // the completion writer rejects an inactive product row, so the option
    // would be an action that cannot be completed (Codex r12 P2).
    options: eligible ? [...plan.mixCalculator.items, ...plan.mixCalculator.conditionalOptions]
      .filter(item => protocolProductFor(item) && item.product?.active !== false)
      .map(item => ({ product: { id: item.product.id, name: item.product.name }, applicationMethod: completionMethod(item, protocolProductFor(item)) })) : [],
    message: !context.propertyMatchesProfile ? 'The saved turf profile could not be matched to this property. Enter the actual work.'
      : !programApplies ? 'No assigned lawn plan for this visit. Add the products actually applied.'
        : !protocolMatches ? 'The appointment protocol could not be resolved. Enter the actual work.'
          : plan.propertyGate.blocks.find(block => block.code === 'lawn_archived_recipe_unavailable')?.message
            || (recipeUnregistered ? 'The assigned protocol window lists none of this recipe\'s products as defaults. Enter the actual work.' : null),
  };
}

module.exports = { lawnCompletionDefaultsEnabled, lawnPlanProgramApplies, lawnPlanAttributesVisit, loadLawnCompletionContext, buildLawnCompletionDefaults, matchesLawnCompletionProtocol, archivedLawnRecipeMatches };
