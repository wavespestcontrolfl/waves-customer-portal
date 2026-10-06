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

// The reserved anchor is the pest control service when the mix has one,
// otherwise the first service; its group keeps the picked hour.
function defaultAnchorGroup(services) {
  return services.includes('pest_control') ? 'pest' : stopGroupOf(services[0]);
}

// Minutes from the picked hour to the end of the second group's work: the
// second group's whole-hour start adds idle time the route must hold (a
// 30-minute pest stop, then lawn at +60).
function stopGroupSpanMinutes(services, durations) {
  const first = defaultAnchorGroup(services);
  const firstMinutes = groupMinutes(services, durations, first);
  const otherMinutes = groupMinutes(services, durations, first === 'pest' ? 'lawn' : 'pest');
  return otherMinutes ? Math.ceil(firstMinutes / 60) * 60 + otherMinutes : firstMinutes;
}

// Allocated members in route order: the anchor's group first, then the other
// group, each contiguous (the route evaluator refuses an A-B-A stop order).
function orderMembersByStopGroup(anchor, members, capacity) {
  if (capacity?.stopGroups !== true) return members;
  const groupOfRow = (row) => stopGroupOf(serviceKeyFor({ service_key: row.service_key_snapshot }));
  const first = groupOfRow(anchor);
  const rest = members.filter((row) => String(row.id) !== String(anchor.id));
  return [...members.filter((row) => String(row.id) === String(anchor.id)),
    ...rest.filter((row) => groupOfRow(row) === first), ...rest.filter((row) => groupOfRow(row) !== first)];
}

// The member's group comes from its own catalog key (a version-1 index is the
// converter's member order, not the selection order), the first group from
// the reserved anchor's service.
function stopGroupOffsetMinutes(capacity, anchor, allowanceIndex, catalogServiceKey) {
  const known = (key) => (capacity.services.includes(key) ? key : null);
  const memberKey = known(serviceKeyFor({ service_key: catalogServiceKey })) || capacity.services[allowanceIndex];
  const anchorKey = known(serviceKeyFor({ service_key: anchor.service_key_snapshot }));
  const firstGroup = anchorKey ? stopGroupOf(anchorKey) : defaultAnchorGroup(capacity.services);
  if (capacity.version !== 2) {
    // Version 1 is one hour per service, back to back: the anchor's group
    // first, then the other group, so no two members share an hour.
    // The anchor's own service keeps the picked hour (slot reservation made
    // it the anchor), then the rest of its group, then the other group.
    const lead = anchorKey || capacity.services.find((key) => stopGroupOf(key) === firstGroup);
    const ordered = [lead, ...capacity.services.filter((key) => key !== lead && stopGroupOf(key) === firstGroup),
      ...capacity.services.filter((key) => stopGroupOf(key) !== firstGroup)];
    return ordered.indexOf(memberKey) * SERVICE_MINUTES;
  }
  if (stopGroupOf(memberKey) === firstGroup) return 0;
  return Math.ceil(groupMinutes(capacity.services, capacity.durations, firstGroup) / 60) * 60;
}

function capacityForServices(services, durations) {
  const keys = services.map((service) => service.service);
  if (!keys.length || keys.some((key) => !ALLOCATABLE_FAMILIES.has(key))
    || services.some((service) => service.commercial)
    || new Set(keys).size !== keys.length) throw capacityUnavailable();
  if (durations) {
    if (durations.length !== keys.length || durations.some(value => !Number.isInteger(value) || value < 15 || value > 480)) throw capacityUnavailable();
    return { version: 2, services: keys, durations, durationMinutes: stopGroupSpanMinutes(keys, durations), stopGroups: true };
  }
  return { version: 1, services: keys, durationMinutes: keys.length * SERVICE_MINUTES, stopGroups: true };
}

// A hold stamped before the stop groups (no `stopGroups` marker) keeps its
// original promise: version 1 one hour per member in member order, version 2
// every member at the shared arrival, and the plain sum of minutes held.
function legacyDurationMinutes(capacity) {
  return capacity.version === 2 ? capacity.durations.reduce((sum, value) => sum + value, 0)
    : capacity.services.length * SERVICE_MINUTES;
}

function capacityFromReservation(row) {
  if (!row?.reservation_service_mix) return null;
  const capacity = row.reservation_service_mix;
  if (![1, 2].includes(capacity.version) || !Array.isArray(capacity.services)
    || (capacity.version === 2 && !Array.isArray(capacity.durations))) throw capacityUnavailable();
  const expected = capacityForServices(capacity.services.map((service) => ({ service })), capacity.version === 2 ? capacity.durations : undefined);
  const held = capacity.stopGroups === true ? expected.durationMinutes : legacyDurationMinutes(capacity);
  if (capacity.durationMinutes !== held) throw capacityUnavailable();
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
  let offset = stopGroupOffsetMinutes(capacity, anchor, allowanceIndex, catalogServiceKey);
  if (capacity.stopGroups !== true) offset = capacity.version === 2 ? 0 : index * SERVICE_MINUTES;
  const arrival = start + offset;
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
  assertCapacityServices, capacityUnavailable, orderMembersByStopGroup,
};
