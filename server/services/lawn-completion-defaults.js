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
  const propertyMatchesProfile = !!(scope.propertyId && service.address_line1
    && scope.propertyAddressKey === addressKey(service));
  const attempts = await history.assessmentQuery(service.customer_id, knex, { confirmed: false })
    .where('ss.id', service.id).orderBy('la.created_at', 'desc').orderBy('la.id', 'desc');
  const latestAssessment = scope.propertyId ? attempts.find((row) => history.isEligible(row, scope)) || resolvedHistory.previous : null;
  return {
    propertyId: scope.propertyId, propertyMatchesProfile, latestAssessment,
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
  if (item.scope?.includes('SPOT') || protocolProduct?.applicationMode === 'spot') return 'spot_treatment';
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

function completionItem(item, protocolProduct, amountsAllowed) {
  const amountAvailable = amountsAllowed && item.product?.labelVerifiedAt
    && Number(item.mix?.amount) > 0 && !String(item.mix?.amountUnit || '').includes('/');
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
    amountReason: amountAvailable ? null : 'Enter the actual amount; a verified suggestion is unavailable.',
  };
}

function buildLawnCompletionDefaults(plan, context) {
  const protocol = plan.protocol.structured;
  const assigned = plan.appointmentAssignment;
  const programApplies = ['Bronze', 'Silver', 'Gold', 'Platinum'].includes(plan.propertyGate.serviceTier)
    || !!assigned.windowKey;
  const protocolMatches = matchesLawnCompletionProtocol(protocol, assigned, plan.propertyGate.trackKey);
  const eligible = context.isLawn && context.propertyMatchesProfile && programApplies && protocolMatches;
  const amountsAllowed = eligible && plan.propertyGate.blocks.length === 0;
  const products = protocol?.products || [];
  const items = eligible ? plan.mixCalculator.items.filter((item) => {
    const product = products.find((row) => row.productId === (item.substitution?.originalProductId || item.product?.id));
    // defaultInPlan distinguishes defaults from opt-in rows. Gates can also
    // carry annual counters or safety metadata on a selected base product;
    // the planner's blocks still withhold any unavailable suggested quantity.
    return item.selected === true && item.product?.active !== false && product?.defaultInPlan;
  }).map((item) => completionItem(item, products.find((row) => row.productId === (item.substitution?.originalProductId || item.product?.id)), amountsAllowed)) : [];
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
    options: eligible ? [...plan.mixCalculator.items, ...plan.mixCalculator.conditionalOptions]
      .filter(item => products.some(row => row.productId === (item.substitution?.originalProductId || item.product?.id)))
      .map(item => ({ product: { id: item.product.id, name: item.product.name } })) : [],
    message: !context.propertyMatchesProfile ? 'The saved turf profile could not be matched to this property. Enter the actual work.'
      : !programApplies ? 'No assigned lawn plan for this visit. Add the products actually applied.'
        : !protocolMatches ? 'The appointment protocol could not be resolved. Enter the actual work.'
          : plan.propertyGate.blocks.find(block => block.code === 'lawn_archived_recipe_unavailable')?.message
            || (recipeUnregistered ? 'The assigned protocol window lists none of this recipe\'s products as defaults. Enter the actual work.' : null),
  };
}

module.exports = { lawnCompletionDefaultsEnabled, loadLawnCompletionContext, buildLawnCompletionDefaults, matchesLawnCompletionProtocol, archivedLawnRecipeMatches };
