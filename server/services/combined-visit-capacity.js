/** Combined-stop booking allowance, approved by the owner: 60 minutes per service. */
const { parseHHMM, minutesToHHMM } = require('./scheduling/window-rules');
const { serviceKeyFor } = require('./recurring-appointment-seeder');

const SERVICE_MINUTES = 60;

function capacityUnavailable() {
  return Object.assign(new Error('The selected services cannot be booked together in this time. Please choose another time or contact the office.'), {
    code: 'COMBINED_VISIT_UNAVAILABLE', status: 409, statusCode: 409, isOperational: true,
  });
}

function capacityForServices(services) {
  const keys = services.map((service) => service.service);
  if (!keys.length || keys.some((key) => typeof key !== 'string' || !key)
    || new Set(keys).size !== keys.length) throw capacityUnavailable();
  return { version: 1, services: keys, durationMinutes: keys.length * SERVICE_MINUTES };
}

function capacityFromReservation(row) {
  if (!row?.reservation_service_mix) return null;
  const capacity = row.reservation_service_mix;
  if (capacity.version !== 1 || !Array.isArray(capacity.services)) throw capacityUnavailable();
  const expected = capacityForServices(capacity.services.map((service) => ({ service })));
  if (capacity.durationMinutes !== expected.durationMinutes) throw capacityUnavailable();
  return capacity;
}

function windowForCapacityService(anchor, index) {
  const capacity = capacityFromReservation(anchor);
  const start = parseHHMM(anchor.window_start);
  if (!capacity || !Number.isInteger(index) || index < 0 || index >= capacity.services.length
    || start == null || start % 60 !== 0 || start + capacity.durationMinutes > 24 * 60 - 1) {
    throw capacityUnavailable();
  }
  return {
    window_start: minutesToHHMM(start + index * SERVICE_MINUTES),
    window_end: minutesToHHMM(start + (index + 1) * SERVICE_MINUTES),
    estimated_duration_minutes: SERVICE_MINUTES,
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
