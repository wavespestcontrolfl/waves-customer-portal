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
 * usable pin, and hands it back in the old response shape.
 *
 * Modes (assistantRouteTimesMode, read at CALL time):
 *   off     unset or any other value. The new list is never built (byte-identical).
 *   shadow  the caller serves the old finder as always; this module builds the
 *           new list AFTER the answer (detached, capped) and logs one
 *           `[assistant-route-times] ...` line with the difference.
 *   on      GATE_ASSISTANT_ROUTE_TIMES=true. The new list is served in the old
 *           shape. A customer with no usable pin, a list that did not build
 *           inside the cap, or any error falls back to the old finder.
 *
 * Quote and re-check: the text drafter stamps the engine on the offer it
 * quotes (sms-offer-sources.js ROUTE_TIMES_OFFER_SOURCE, in the snapshot's
 * lookup.source) and the send-time re-check asks that same engine, so a gate
 * flip between the quote and the send never holds or releases a reply for the
 * wrong reason. A snapshot with no source is the old finder's.
 *
 * Read-only. Spends nothing of its own (the drive clock and the customer pages'
 * own pin lookup are what they always were), sends no message.
 */

const logger = require('../logger');

const SERVED_BUDGET_MS = 1500;
const SHADOW_BUDGET_MS = 5000;
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

async function buildRouteDays({ customerId, estimateId, serviceKey }) {
  if (!customerId || !serviceKey) return { days: null, reason: customerId ? 'no_service' : 'no_customer' };
  const pin = await require('./text-offer-times').resolveTextOfferPin({ customerId, estimateId });
  // Only the customer's own pin: a city centre is not a place a route can be checked.
  if (!pin || pin.source !== 'customer') return { days: null, reason: 'no_pin' };
  const { availabilityForPin } = require('../../routes/booking')._internals;
  const availability = await availabilityForPin({ lat: pin.lat, lng: pin.lng, serviceKey });
  return availability ? { days: availability.days || [] } : { days: null, reason: 'unavailable' };
}

/**
 * The customer pages' days for this customer's own pin, as { days } or
 * { days: null, reason } (no_customer, no_service, no_pin, unavailable, timeout,
 * error). Never throws; gives up after `budgetMs`.
 */
async function loadRouteDays({ customerId, estimateId = null, serviceKey, budgetMs = SERVED_BUDGET_MS } = {}) {
  try {
    return await raceBudget(buildRouteDays({ customerId, estimateId, serviceKey }), budgetMs);
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

function logComparison({ surface, loaded, oldDays, startedAt }) {
  const ms = Date.now() - startedAt;
  if (!loaded.days) {
    logger.info(`[assistant-route-times] surface=${surface} mode=shadow old=${compareDays(oldDays, []).old} new=- reason=${loaded.reason || 'none'} ms=${ms}`);
    return;
  }
  const c = compareDays(oldDays, loaded.days);
  logger.info(`[assistant-route-times] surface=${surface} mode=shadow old=${c.old} new=${c.new} both=${c.both}`
    + ` only_old=${c.onlyOld} only_new=${c.onlyNew} ms=${ms}`);
}

/**
 * Shadow: build the new list for the same customer and log how it differs from
 * the list that was served. Resolves when done; never throws. Callers do not
 * await it on the reply path.
 */
async function shadowCompare({ surface, customerId, estimateId = null, serviceKey, oldDays }) {
  const startedAt = Date.now();
  try {
    const key = serviceKey ?? await assistantServiceKey(estimateId);
    const loaded = await loadRouteDays({ customerId, estimateId, serviceKey: key, budgetMs: SHADOW_BUDGET_MS });
    logComparison({ surface, loaded, oldDays, startedAt });
  } catch (err) {
    logger.warn(`[assistant-route-times] shadow compare failed (${String(err?.message || err).slice(0, 120)})`);
  }
}

/**
 * The assistant's availability answer in the old finder's shape.
 *   off     { engine: 'old', result: await loadOld() }, nothing else runs.
 *   shadow  the same, plus a detached comparison (`settled` resolves when it is logged).
 *   on      the customer pages' list in the old shape, else the old finder.
 */
async function serveAssistantTimes({ surface = 'assistant', customerId, estimateId = null, loadOld }) {
  const mode = assistantRouteTimesMode();
  if (mode === 'off' || !customerId) return { engine: 'old', result: await loadOld() };
  if (mode === 'shadow') {
    const result = await loadOld();
    const settled = shadowCompare({ surface, customerId, estimateId, oldDays: result?.days });
    return { engine: 'old', result, settled };
  }
  const serviceKey = await assistantServiceKey(estimateId);
  const loaded = await loadRouteDays({ customerId, estimateId, serviceKey });
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
