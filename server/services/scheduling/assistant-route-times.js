'use strict';

/**
 * Route Check Everywhere, build 3c (GATE_ASSISTANT_ROUTE_TIMES, owner
 * 2026-10-29, "start the builds", "drive clock").
 *
 * The portal assistant's check_availability and the text drafter's city-based
 * OPEN TIMES fallback asked the old by-city zone finder
 * (services/availability.js AvailabilityEngine.getAvailableSlots: a city maps
 * to a zone, an hourly grid, overlap plus a straight-line travel gap). The
 * customer pages (/book, the public reschedule and re-service pages) offer from
 * routes/booking.js buildBookingAvailability, per technician and route-aware,
 * with the customer route check (GATE_CUSTOMER_ROUTE_CHECK) applied. This
 * module lets those two callers read the SAME list for a customer who has a
 * stored pin, and hands it back in the old response shape.
 *
 * Modes (assistantRouteTimesMode, read at CALL time):
 *   off     unset or any other value. The new list is never built (byte-identical).
 *   shadow  the caller serves the old finder as always; this module builds the
 *           new list AFTER the answer (detached, capped) and logs one
 *           `[assistant-route-times] ...` line with the difference.
 *   on      GATE_ASSISTANT_ROUTE_TIMES=true. The new list is served in the old
 *           shape. A customer with no stored pin, a list that did not build
 *           inside the cap, or any error falls back to the old finder.
 *
 * Quote and re-check: the text drafter stamps the engine on the offer it
 * quotes (sms-offer-sources.js ROUTE_TIMES_OFFER_SOURCE, in the snapshot's
 * lookup.source) and the send-time re-check asks that same engine, so a gate
 * flip between the quote and the send never holds or releases a reply for the
 * wrong reason. A snapshot with no source is the old finder's.
 *
 * Read-only. Spends nothing of its own (the drive clock and the customer pages'
 * stored pin is read from the customer row: no geocode), sends no message.
 */

const logger = require('../logger');

const SERVED_BUDGET_MS = 1500;
const SHADOW_BUDGET_MS = 5000;
const COMMIT_FILTER_BUDGET_MS = 1000;
const COMMIT_PROBE_BATCH = 8;
const DEFAULT_SERVICE_KEY = 'pest_control';

/** 'off' | 'shadow' | 'on'. A partial test mock of the gates module reads as off. */
function assistantRouteTimesMode() {
  try {
    const gates = require('../../config/feature-gates');
    const mode = typeof gates.assistantRouteTimesMode === 'function' ? gates.assistantRouteTimesMode() : 'off';
    return mode === 'shadow' || mode === 'on' ? mode : 'off';
  } catch {
    return 'off';
  }
}

function hhmm(value) {
  const match = String(value || '').match(/^(\d{1,2}):(\d{2})/);
  return match ? `${match[1].padStart(2, '0')}:${match[2]}` : null;
}

// The start of a slot from either list shape (the old finder's startTime24, the
// customer pages' startTime24 / start_time).
function slotStart(slot) {
  return hhmm(slot?.startTime24 ?? slot?.start_time);
}

/**
 * The old finder's day shape from the customer pages' days: the same keys, one
 * slot per distinct start (two technicians free at 09:00 are one 09:00), and none
 * of the page-only fields (technician, signature, rank). Days with no slot are
 * dropped, like the old finder.
 */
function toOldShape(days) {
  const out = [];
  for (const day of days || []) {
    const seen = new Set();
    const slots = [];
    for (const slot of day?.slots || []) {
      const start = slotStart(slot);
      if (!start || seen.has(start)) continue;
      seen.add(start);
      slots.push({ start: slot.start, end: slot.end, startTime24: start, endTime24: hhmm(slot.endTime24 ?? slot.end_time) });
    }
    if (!slots.length) continue;
    out.push({
      date: day.date, dayOfWeek: day.dayOfWeek, dayNum: day.dayNum, month: day.month, fullDate: day.fullDate, slots, zone: null,
    });
  }
  return out;
}

// date|start for every offered slot, from either list shape.
function slotKeys(days) {
  const keys = new Set();
  for (const day of days || []) {
    for (const slot of day?.slots || []) {
      const start = slotStart(slot);
      if (day?.date && start) keys.add(`${String(day.date).slice(0, 10)}|${start}`);
    }
  }
  return keys;
}

/** { old, new, both, onlyOld, onlyNew } slot counts of two day lists. */
function compareDays(oldDays, newDays) {
  const a = slotKeys(oldDays);
  const b = slotKeys(newDays);
  let both = 0;
  for (const key of a) if (b.has(key)) both += 1;
  return { old: a.size, new: b.size, both, onlyOld: a.size - both, onlyNew: b.size - both };
}

function raceBudget(promise, budgetMs) {
  let timer;
  const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve({ days: null, reason: 'timeout' }), budgetMs); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// The customer's STORED pin only (the same latitude / longitude /book commits at):
// a customer without one is never geocoded here, so this step costs nothing.
// customerBookingLocation (the geocode path) is deliberately not called.
async function buildRouteDays({ customerId, serviceKey }) {
  if (!customerId || !serviceKey) return { days: null, reason: customerId ? 'no_service' : 'no_customer' };
  const booking = require('../../routes/booking')._internals;
  const customer = await booking.bookableOfferCustomer(customerId);
  const pin = customer ? booking.storedBookingPin(customer) : null;
  if (!pin) return { days: null, reason: 'no_stored_pin' };
  const availability = await booking.availabilityForPin({ lat: pin.lat, lng: pin.lng, serviceKey });
  return availability ? { days: availability.days || [], customer } : { days: null, reason: 'unavailable' };
}

function addMinutes24(start24, minutes) {
  const total = Number(start24.slice(0, 2)) * 60 + Number(start24.slice(3, 5)) + minutes;
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

// What confirmBooking (services/availability.js, the assistant's book_appointment
// commit) reads before it probes: the slot length, the customer's stored pin
// (customers.latitude / longitude, null stays null), and the candidate's own
// expected-minutes credit when the travel-gap mirror is on.
async function commitContext({ customer, estimateId }) {
  const db = require('../../models/db');
  const config = await db('booking_config').first();
  const slotDuration = config?.slot_duration_minutes || 60;
  const estimate = estimateId ? await db('estimates').where('id', estimateId).first() : null;
  const serviceType = estimate?.service_interest || 'General Pest Control';
  const expected = require('./travel-gap').travelGapEnabled()
    ? await require('./expected-service-minutes').expectedServiceMinutes(db, { serviceType, windowMinutes: slotDuration })
    : null;
  return { db, slotDuration, pin: { lat: customer.latitude ?? null, lng: customer.longitude ?? null }, expected, closedDays: new Map() };
}

// Would confirmBooking refuse this start? The same functions, in its order: the
// closed-day check, the self-serve notice window, the last customer start, then
// the TECHNICIAN-BLIND occupancy probe (findConflictingVisits with no technicianId,
// interviews included, and the travel gap when its gate is on). Nothing here is a
// copy of those rules.
async function commitRefuses(ctx, date, start24) {
  if (!ctx.closedDays.has(date)) ctx.closedDays.set(date, require('./blackout-dates').isBlackoutDate(date));
  if (await ctx.closedDays.get(date)) return true;
  if (require('./self-serve-notice').violatesSelfServeNotice({ date, startTime: start24 })) return true;
  if (require('./customer-windows').pastCustomerLastStart(Number(start24.slice(0, 2)) * 60 + Number(start24.slice(3, 5)))) return true;
  const clash = await require('./occupancy').findConflictingVisits({
    db: ctx.db,
    includeInterviews: true,
    date,
    windowStart: start24,
    windowEnd: addMinutes24(start24, ctx.slotDuration),
    excludeServiceIds: [],
    travel: Number.isFinite(ctx.expected) ? { ...ctx.pin, expectedMinutes: ctx.expected } : ctx.pin,
  });
  return clash.length > 0;
}

async function refusedStarts(ctx, day) {
  const starts = [...new Set((day.slots || []).map(slotStart).filter(Boolean))];
  const refused = new Set();
  for (let i = 0; i < starts.length; i += COMMIT_PROBE_BATCH) {
    await Promise.all(starts.slice(i, i + COMMIT_PROBE_BATCH).map(async (start) => {
      if (await commitRefuses(ctx, String(day.date).slice(0, 10), start)) refused.add(start);
    }));
  }
  return refused;
}

/**
 * The customer pages' days without the starts confirmBooking would refuse:
 * { days, dropped } (distinct starts dropped). The customer pages offer per
 * technician; confirmBooking's occupancy probe is technician-blind, so a start
 * only one technician has free would be offered and then refused as SLOT_TAKEN.
 */
async function filterByCommit({ days, customer, estimateId }) {
  const ctx = await commitContext({ customer, estimateId });
  const out = [];
  let dropped = 0;
  for (const day of days) {
    const refused = await refusedStarts(ctx, day);
    dropped += refused.size;
    const slots = (day.slots || []).filter((slot) => !refused.has(slotStart(slot)));
    if (slots.length) out.push({ ...day, slots });
  }
  return { days: out, dropped };
}

/**
 * The customer pages' days for this customer's stored pin, as { days } or
 * { days: null, reason } (no_customer, no_service, no_stored_pin, unavailable, timeout,
 * error). Never throws; gives up after `budgetMs`. With `commitFilter` the starts
 * confirmBooking would refuse are removed ({ days, rawDays, commitDropped }).
 */
async function loadRouteDays({ customerId, estimateId = null, serviceKey, budgetMs = SERVED_BUDGET_MS, commitFilter = false } = {}) {
  try {
    const { customer, ...built } = await raceBudget(buildRouteDays({ customerId, serviceKey }), budgetMs);
    if (!built.days || !commitFilter) return built;
    // An answer that is not commit-checked is never served: a filter that fails or is slow reads as no list.
    const checked = await raceBudget(filterByCommit({ days: built.days, customer, estimateId }), COMMIT_FILTER_BUDGET_MS);
    return { days: checked.days, reason: checked.reason, rawDays: built.days, commitDropped: checked.dropped ?? null };
  } catch (err) {
    logger.warn(`[assistant-route-times] route list failed (${String(err?.message || err).slice(0, 120)})`);
    return { days: null, reason: 'error' };
  }
}

/** The /book funnel service the assistant's availability check is for. '' = none. */
async function assistantServiceKey(estimateId) {
  if (!estimateId) return DEFAULT_SERVICE_KEY;
  try {
    return await require('../estimate-converter').funnelKeyForEstimateId(estimateId);
  } catch {
    return '';
  }
}

function logComparison({ surface, loaded, oldDays, startedAt, commitFilter }) {
  const ms = Date.now() - startedAt;
  const raw = loaded.rawDays || loaded.days;
  const dropped = commitFilter ? ` commit_dropped=${loaded.commitDropped ?? '-'}` : '';
  if (!raw) {
    logger.info(`[assistant-route-times] surface=${surface} mode=shadow old=${compareDays(oldDays, []).old} new=- reason=${loaded.reason || 'none'} ms=${ms}`);
    return;
  }
  const c = compareDays(oldDays, raw);
  logger.info(`[assistant-route-times] surface=${surface} mode=shadow old=${c.old} new=${c.new} both=${c.both}`
    + ` only_old=${c.onlyOld} only_new=${c.onlyNew}${dropped} ms=${ms}`);
}

/**
 * Shadow: build the new list for the same customer and log how it differs from
 * the list that was served. Resolves when done; never throws. Callers do not
 * await it on the reply path.
 */
async function shadowCompare({ surface, customerId, estimateId = null, serviceKey, oldDays, commitFilter = false }) {
  const startedAt = Date.now();
  try {
    const key = serviceKey ?? await assistantServiceKey(estimateId);
    const loaded = await loadRouteDays({ customerId, estimateId, serviceKey: key, budgetMs: SHADOW_BUDGET_MS, commitFilter });
    logComparison({ surface, loaded, oldDays, startedAt, commitFilter });
  } catch (err) {
    logger.warn(`[assistant-route-times] shadow compare failed (${String(err?.message || err).slice(0, 120)})`);
  }
}

/**
 * The assistant's availability answer in the old finder's shape.
 *   off     { engine: 'old', result: await loadOld() }, nothing else runs.
 *   shadow  the same, plus a detached comparison (`settled` resolves when it is logged),
 *           with `commit_dropped=N`: the starts confirmBooking would refuse.
 *   on      the customer pages' list WITHOUT the starts confirmBooking would refuse,
 *           in the old shape, else the old finder.
 */
async function serveAssistantTimes({ surface = 'assistant', customerId, estimateId = null, loadOld }) {
  const mode = assistantRouteTimesMode();
  if (mode === 'off' || !customerId) return { engine: 'old', result: await loadOld() };
  if (mode === 'shadow') {
    const result = await loadOld();
    const settled = shadowCompare({ surface, customerId, estimateId, oldDays: result?.days, commitFilter: true });
    return { engine: 'old', result, settled };
  }
  const serviceKey = await assistantServiceKey(estimateId);
  const loaded = await loadRouteDays({ customerId, estimateId, serviceKey, commitFilter: true });
  if (loaded.days) return { engine: 'route_times', result: { zone: null, days: toOldShape(loaded.days) } };
  logger.info(`[assistant-route-times] surface=${surface} mode=on served=old reason=${loaded.reason || 'none'}`);
  return { engine: 'old', result: await loadOld() };
}

/**
 * Inside confirmBooking's transaction, after the visit insert: number the
 * visit in its technician's day with the placement helper the phone agent and
 * New Appointment use. A no-op unless the gate is on, and (like those callers)
 * the helper itself places only a visit that carries a technician and a window,
 * under a savepoint, and never fails the booking.
 */
async function placeAssistantBooking(trx, serviceId) {
  if (assistantRouteTimesMode() !== 'on' || !serviceId) return null;
  return require('./arrival-route').placeMovedVisit(trx, { serviceId, source: 'assistant_booking' });
}

module.exports = {
  assistantRouteTimesMode,
  filterByCommit,
  loadRouteDays,
  assistantServiceKey,
  serveAssistantTimes,
  shadowCompare,
  placeAssistantBooking,
  toOldShape,
  compareDays,
  SERVED_BUDGET_MS,
  SHADOW_BUDGET_MS,
};
