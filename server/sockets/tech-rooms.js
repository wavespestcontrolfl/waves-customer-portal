/**
 * Technician socket rooms (GATE_TECH_LOGIN_PRIVACY, technician visibility fix B1).
 *
 * `dispatch:admins` is the company-wide staff channel: every visit status
 * change (customer first name, notes), every truck's GPS, alerts and absences.
 * With the gate on it is office-only. A technician socket joins `tech:<id>`
 * instead, a room of its own, and gets only content-free "refetch" pings about
 * its own visits (the technician home screen refetches its route on any
 * `dispatch:job_update`, it never reads the payload).
 *
 * Pure helpers. They take the io instance as an argument and never require
 * ./index, so a service can import them with `../sockets` mocked.
 */
const TECH_ROOM_PREFIX = 'tech:';

function techRoom(technicianId) {
  return `${TECH_ROOM_PREFIX}${technicianId}`;
}

// Read at call time. Lazy require: a test that mocks feature-gates without
// this reader keeps today's behavior.
function technicianRoomsLive() {
  try {
    const gates = require('../config/feature-gates');
    return typeof gates.techLoginPrivacyLive === 'function' && gates.techLoginPrivacyLive() === true;
  } catch {
    return false;
  }
}

// Every technician room that has a socket in it right now. Empty when the io
// instance is a test double with no adapter.
function connectedTechRooms(io) {
  const rooms = io?.sockets?.adapter?.rooms;
  if (!rooms || typeof rooms.keys !== 'function') return [];
  return [...rooms.keys()].filter((name) => typeof name === 'string' && name.startsWith(TECH_ROOM_PREFIX));
}

/**
 * Tell technicians a visit changed. Gate off: sends nothing (the technician
 * sockets are in `dispatch:admins` and got the full payload already).
 *
 * @param {object} io
 * @param {string} event
 * @param {object} opts
 * @param {object|null} opts.payload  ids and status only, for the visit's own technicians
 * @param {Array<string|null|undefined>} opts.techIds  the visit's technician(s); old and new on a reassignment
 * @param {boolean} [opts.pingOthers]  the emit point cannot tell who held the visit before:
 *   every other connected technician room gets a ping with NO payload
 * @returns {number} rooms pinged
 */
function pingTechnicianRooms(io, event, { payload = null, techIds = [], pingOthers = false } = {}) {
  if (!io || typeof io.to !== 'function' || !technicianRoomsLive()) return 0;
  const own = new Set(techIds.filter(Boolean).map((id) => techRoom(id)));
  for (const room of own) {
    if (payload) io.to(room).emit(event, payload);
    else io.to(room).emit(event);
  }
  let sent = own.size;
  if (pingOthers) {
    for (const room of connectedTechRooms(io)) {
      if (own.has(room)) continue;
      io.to(room).emit(event);
      sent += 1;
    }
  }
  return sent;
}

module.exports = {
  TECH_ROOM_PREFIX,
  techRoom,
  technicianRoomsLive,
  connectedTechRooms,
  pingTechnicianRooms,
};
