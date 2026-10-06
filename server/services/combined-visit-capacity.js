/** Versioned combined work: legacy hour per member; current catalog allowances. */
const { parseHHMM, minutesToHHMM } = require('./scheduling/window-rules');
const { serviceKeyFor } = require('./recurring-appointment-seeder');

const SERVICE_MINUTES = 60;
// Families the reserved-estimate converter can allocate as separate programs.
// Other recurring work (including foam) remains office-scheduled.
const ALLOCATABLE_FAMILIES = new Set([
  'pest_control', 'lawn_care', 'tree_shrub', 'mosquito',
  'termite_bait', 'rodent_bait', 'palm_injection',
]);

function capacityUnavailable() {
  return Object.assign(new Error('The selected services cannot be booked together in this time. Please choose another time or contact the office.'), {
    code: 'COMBINED_VISIT_UNAVAILABLE', status: 409, statusCode: 409, isOperational: true,
  });
}

// Two stop groups (owner ruling 2026-10-05): pest-group services share one
// arrival hour and lawn-group services share another; pest and lawn never
// share a stop. The group of the reserved anchor's service keeps the picked
// hour; the other group starts on the first whole hour after its work.
const PEST_STOP_FAMILIES = new Set(['pest_control', 'mosquito', 'termite_bait', 'rodent_bait']);
const stopGroupOf = (key) => (PEST_STOP_FAMILIES.has(key) ? 'pest' : 'lawn');

function groupMinutes(services, durations, group) {
  return services.reduce((sum, key, i) => (stopGroupOf(key) === group
    ? sum + (durations ? durations[i] : SERVICE_MINUTES) : sum), 0);
}

// Minutes from the picked hour to the end of the second group's work, in
// whichever order the groups land: the second group's whole-hour start adds
// idle time the route must hold (a 30-minute pest stop, then lawn at +60).
function stopGroupSpanMinutes(services, durations) {
  const pest = groupMinutes(services, durations, 'pest');
  const lawn = groupMinutes(services, durations, 'lawn');
  if (!pest || !lawn) return pest + lawn;
  return Math.max(Math.ceil(pest / 60) * 60 + lawn, Math.ceil(lawn / 60) * 60 + pest);
}

// The member's group comes from its own catalog key (a version-1 index is the
// converter's member order, not the selection order), the first group from
// the reserved anchor's service.
function stopGroupOffsetMinutes(capacity, anchor, allowanceIndex, catalogServiceKey) {
  const known = (key) => (capacity.services.includes(key) ? key : null);
  const memberKey = known(serviceKeyFor({ service_key: catalogServiceKey })) || capacity.services[allowanceIndex];
  const anchorKey = known(serviceKeyFor({ service_key: anchor.service_key_snapshot })) || capacity.services[0];
  const firstGroup = stopGroupOf(anchorKey);
  if (stopGroupOf(memberKey) === firstGroup) return 0;
  const durations = capacity.version === 2 ? capacity.durations : null;
  return Math.ceil(groupMinutes(capacity.services, durations, firstGroup) / 60) * 60;
}

function capacityForServices(services, durations) {
  const keys = services.map((service) => service.service);
  if (!keys.length || keys.some((key) => !ALLOCATABLE_FAMILIES.has(key))
    || services.some((service) => service.commercial)
    || new Set(keys).size !== keys.length) throw capacityUnavailable();
  if (durations) {
    if (durations.length !== keys.length || durations.some(value => !Number.isInteger(value) || value < 15 || value > 480)) throw capacityUnavailable();
    return { version: 2, services: keys, durations, durationMinutes: stopGroupSpanMinutes(keys, durations) };
  }
  return { version: 1, services: keys, durationMinutes: keys.length * SERVICE_MINUTES };
}

function capacityFromReservation(row) {
  if (!row?.reservation_service_mix) return null;
  const capacity = row.reservation_service_mix;
  if (![1, 2].includes(capacity.version) || !Array.isArray(capacity.services)
    || (capacity.version === 2 && !Array.isArray(capacity.durations))) throw capacityUnavailable();
  const expected = capacityForServices(capacity.services.map((service) => ({ service })), capacity.version === 2 ? capacity.durations : undefined);
  // A hold stamped before the stop groups summed the durations with no gap.
  const legacySum = capacity.version === 2 ? capacity.durations.reduce((sum, value) => sum + value, 0) : null;
  if (capacity.durationMinutes !== expected.durationMinutes && capacity.durationMinutes !== legacySum) throw capacityUnavailable();
  return capacity;
}

function windowForCapacityService(anchor, index, catalogServiceKey) {
  const capacity = capacityFromReservation(anchor);
  const start = parseHHMM(anchor.window_start);
  if (!capacity || !Number.isInteger(index) || index < 0 || index >= capacity.services.length
    || start == null || start % 60 !== 0 || start + capacity.durationMinutes > 24 * 60 - 1) {
    throw capacityUnavailable();
  }
  const allowanceIndex = capacity.version === 2
    ? capacity.services.indexOf(serviceKeyFor({ service_key: catalogServiceKey })) : index;
  if (allowanceIndex < 0) throw capacityUnavailable();
  const minutes = capacity.version === 2 ? capacity.durations[allowanceIndex] : SERVICE_MINUTES;
  const arrival = start + stopGroupOffsetMinutes(capacity, anchor, allowanceIndex, catalogServiceKey);
  if (arrival + minutes > 24 * 60 - 1) throw capacityUnavailable();
  return {
    window_start: minutesToHHMM(arrival),
    window_end: minutesToHHMM(arrival + minutes),
    estimated_duration_minutes: minutes,
  };
}

function assertCapacityServices(anchor, members) {
  const capacity = capacityFromReservation(anchor);
  const keys = members.map((row) => serviceKeyFor({ service_key: row.service_key_snapshot }));
  if (!capacity || members.length !== capacity.services.length
    || new Set(keys).size !== keys.length
    || keys.some((key) => !capacity.services.includes(key))
    || members.some((row) => !row.service_id || !row.technician_id
      || String(row.technician_id) !== String(anchor.technician_id)
      || String(row.customer_id) !== String(anchor.customer_id))) throw capacityUnavailable();
}

module.exports = {
  capacityForServices, capacityFromReservation, windowForCapacityService,
  assertCapacityServices, capacityUnavailable,
};
