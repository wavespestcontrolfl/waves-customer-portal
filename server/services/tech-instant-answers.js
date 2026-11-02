/**
 * Tech instant answers — three deterministic, read-only answers for a
 * technician's own route today: next stop, access notes, last treatment.
 *
 * No model call, no write, no cost. The same functions back the tech
 * Intelligence Bar chips (GET /api/tech/answers) and, later, a voice line.
 *
 * Scope: every answer is about visits assigned to the technician id passed
 * in, even when that technician is an admin (the owner works the route too).
 * The route never lends this module a "any visit" scope.
 *
 * Never returned: a phone number, or any gate / garage / lockbox code. The
 * access facts come from property_preferences, one row per CUSTOMER, which
 * can be the wrong home for a two-home customer, so the code fields are
 * dropped here and free text is passed through the shared code redactor.
 */
const { etDateString } = require('../utils/datetime-et');
const { deterministicVisitFacts } = require('./previsit-brief');
const { redactAccessCodes } = require('./context-aggregator');

const ENDED_STATUSES = ['completed', 'cancelled', 'skipped', 'no_show', 'rescheduled'];

// The tech day plan order: dispatch.js jobs, stops-ahead.js and
// visit-tech-relay.js sort the same way (route_order, window start, created).
// id is the deterministic tiebreak. Table-qualified for the customers join.
const DAY_PLAN_ORDER = "COALESCE(scheduled_services.route_order, 999), COALESCE(scheduled_services.window_start, '23:59'), scheduled_services.created_at, scheduled_services.id";

const INSTANT_ANSWER_KINDS = {
  next_stop: 'Next stop',
  access_notes: 'Access notes',
  last_treatment: 'Last treatment',
};

function arrivedMs(row) {
  const t = row && row.arrived_at ? new Date(row.arrived_at).getTime() : NaN;
  return Number.isFinite(t) ? t : -Infinity;
}

// The stop the tech is at (newest arrival first), else the next open stop of
// today's route. Returns the visit row (with customer name and address) or null.
async function pickStop(conn, technicianId, now = new Date()) {
  if (!technicianId) return null;
  const rows = await conn('scheduled_services')
    .leftJoin('customers', 'customers.id', 'scheduled_services.customer_id')
    .where('scheduled_services.technician_id', technicianId)
    .where('scheduled_services.scheduled_date', etDateString(now))
    .whereRaw(
      `COALESCE(scheduled_services.status, 'pending') NOT IN (${ENDED_STATUSES.map(() => '?').join(', ')})`,
      ENDED_STATUSES
    )
    .orderByRaw(DAY_PLAN_ORDER)
    .select(
      'scheduled_services.id',
      'scheduled_services.customer_id',
      'scheduled_services.technician_id',
      'scheduled_services.status',
      'scheduled_services.service_type',
      'scheduled_services.scheduled_date',
      'scheduled_services.window_start',
      'scheduled_services.window_end',
      'scheduled_services.arrived_at',
      'scheduled_services.notes',
      'customers.first_name',
      'customers.last_name',
      conn.raw('COALESCE(scheduled_services.service_address_line1, customers.address_line1) as address_line1'),
      conn.raw('COALESCE(scheduled_services.service_address_city, customers.city) as city')
    );
  const list = Array.isArray(rows) ? rows : [];
  const onSite = list.filter((r) => r.status === 'on_site');
  if (onSite.length) return onSite.reduce((best, r) => (arrivedMs(r) > arrivedMs(best) ? r : best));
  return list[0] || null;
}

// 'HH:MM[:SS]' → '9:30 AM'. A time column is already ET wall clock.
function clock(value) {
  const m = /^(\d{1,2}):(\d{2})/.exec(String(value || ''));
  if (!m) return null;
  const h = Number(m[1]);
  return `${h % 12 || 12}:${m[2]} ${h >= 12 ? 'PM' : 'AM'}`;
}

function windowText(stop) {
  const start = clock(stop.window_start);
  const end = clock(stop.window_end);
  if (start && end) return `${start}–${end}`;
  return start || null;
}

function present(label, value) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text ? `${label}: ${text}` : null;
}

function nextStopLines(stop) {
  const name = [stop.first_name, stop.last_name].filter(Boolean).join(' ');
  const address = [stop.address_line1, stop.city].filter(Boolean).join(', ');
  return [
    present('Customer', name),
    present('Address', address),
    present('Window', windowText(stop)),
    present('Service', stop.service_type),
  ].filter(Boolean);
}

function accessLines(facts) {
  const access = facts && facts.access;
  if (!access) return ['The access notes could not be read. Check the visit brief.'];
  // codes (gate, garage, lockbox) are deliberately never read.
  const lines = [
    present('Pets', access.pets),
    present('Chemical sensitivities', access.chemicalSensitivities),
    present('Access', access.accessNotes),
    present('Parking', access.parkingNotes),
  ].filter(Boolean).map((line) => redactAccessCodes(line));
  return lines.length ? lines : ['No access notes on file.'];
}

function productNames(products) {
  return (Array.isArray(products) ? products : [])
    .map((p) => (typeof p === 'string' ? p : p && p.name))
    .filter(Boolean);
}

function lastTreatmentLines(facts) {
  const last = facts && facts.last_visit;
  if (!last) return ['No earlier visit on this service line.'];
  const names = productNames(last.products);
  return [
    `Last visit: ${[last.date, last.type].filter(Boolean).join(' — ') || 'date not on file'}`,
    names.length ? `Products: ${names.join(', ')}` : null,
  ].filter(Boolean);
}

async function stopAnswer(conn, kind, stop) {
  if (kind === 'next_stop') {
    return { title: stop.status === 'on_site' ? 'Current stop' : 'Next stop', lines: nextStopLines(stop) };
  }
  const facts = await deterministicVisitFacts(stop, conn);
  return {
    title: INSTANT_ANSWER_KINDS[kind],
    lines: kind === 'access_notes' ? accessLines(facts) : lastTreatmentLines(facts),
  };
}

async function answer(conn, kind, { technicianId, now = new Date() } = {}) {
  if (!Object.prototype.hasOwnProperty.call(INSTANT_ANSWER_KINDS, kind)) {
    throw new Error(`Unknown instant answer kind: ${kind}`);
  }
  const stop = await pickStop(conn, technicianId, now);
  if (!stop) {
    return { kind, title: 'No stop', lines: ['No more stops on your route today.'], visitId: null };
  }
  const body = await stopAnswer(conn, kind, stop);
  return { kind, title: body.title, lines: body.lines, visitId: stop.id };
}

module.exports = { INSTANT_ANSWER_KINDS, pickStop, answer, _test: { DAY_PLAN_ORDER, ENDED_STATUSES } };
