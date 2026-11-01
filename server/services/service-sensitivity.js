/**
 * The ONE classifier from a service's name (and catalog key) to a
 * reschedule-rules.js serviceSensitivity key. Pure. The weather rebooker
 * (forecast-analyzer.js), the job card's Waves rain rule (job-card.js) and
 * auto-dispatch's dry time (auto-dispatch/dry-time.js) all read it, so a visit
 * has one answer to "how many rain-free hours does this service need".
 *
 * The catalog key joins the name ("lawn_granular" reads as "lawn granular").
 * With no key the result is exactly what forecast-analyzer returned before this
 * module existed.
 */
const RESCHEDULE_RULES = require('../config/reschedule-rules');

function classifyServiceSensitivity(serviceType, serviceKey = null) {
  const s = `${serviceKey || ''} ${serviceType || ''}`.toLowerCase().replace(/_/g, ' ');
  const has = (...words) => words.some((word) => s.includes(word));
  if (has('mosquito')) return 'mosquito';
  if (has('termite') && has('bait', 'monitor')) return 'termite_bait';
  if (has('rodent', 'rat')) return 'rodent';
  if (has('tree') && has('inject')) return 'tree_injection';
  if (has('tree', 'shrub')) return 'tree_shrub_spray';
  if (has('lawn', 'turf')) return has('granular') ? 'lawn_granular' : 'lawn_spray';
  if (has('pest') && has('interior')) return 'pest_interior';
  return 'pest_exterior';
}

// Rain-free hours the service rule asks for (0 when it needs none).
function rainFreeHoursFor(serviceType, serviceKey = null) {
  const rule = RESCHEDULE_RULES.serviceSensitivity[classifyServiceSensitivity(serviceType, serviceKey)];
  return rule && rule.needs_rain_free ? Number(rule.rain_free_hours) || 0 : 0;
}

module.exports = { classifyServiceSensitivity, rainFreeHoursFor };
