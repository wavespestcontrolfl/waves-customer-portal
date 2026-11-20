/**
 * Far-south days stay far-south (owner 2026-11-12; rule 2026-09-29: Friday is the Venice / North Port day).
 *
 * The night run may not move a visit whose own address is NOT in a funneled far-south zone onto a DATE that
 * already holds a live stop in one. On 2026-11-09 the mowing-day rule moved a Parrish lawn visit onto a Friday
 * that already held Nokomis, Osprey and Venice stops: 343 model drive minutes. A far-south visit may still move
 * onto a south day, a date with no far-south stop is untouched whatever its weekday, and a same-day re-time is
 * not a date move.
 *
 * Zones come from the south-zone day funnel's own helpers (scheduling/zone-day-funnel.js): which zones are
 * funneled (funnelZoneRows), which dates hold a stop in one (getZoneFunnelDays) and whether a visit belongs to
 * one (rowInFunnelZones). The funnel's gate (GATE_SOUTH_ZONE_DAY_FUNNEL) is therefore this rule's off switch:
 * off, no query runs and nothing is dropped. Any lookup failure, or a visit with no zone stamp and no city,
 * fails OPEN (today's behavior), logged.
 *
 * Per truck (GATE_MULTI_TECH_CONFIRM, owner 2026-11-19 "build south"): for a single visit, a far-south stop holds
 * its date only for its own technician, and an unassigned far-south stop holds it for every technician. The slot's
 * technician decides at candidate time; at apply time, the receiving technician and the one the move transaction
 * writes. A grouped visit (visit_id) keeps the fleet's view: its unit move commits each member's date on that
 * member's current technician and re-points it after (visit-groups alignMember), and grouping is retired (owner
 * 2026-10-22), so only older visits carry one. Off, the date is the fleet's (one truck) for every visit.
 * The per-truck view comes from the same funnel read (getZoneFunnelDays techDays, zone-day-funnel.js onZoneDay).
 *
 * Two places enforce it, so a date move of any kind is covered:
 *   - candidate time (candidate-slots.js HARD_FILTERS 'south_day_kept'): score moves, mowing-day moves,
 *     conflict moves, the 05:00 catch-up run (same job) and the dry-window starts all pass candidateFromSlot.
 *     The far-south dates are read ONCE per run (SouthDays, the run's store), not per visit or candidate.
 *   - apply time (apply.js makeMoveGuard -> assertDestinationClear): the move transaction reads the target
 *     date's far-south stops again.
 */
const logger = require('../logger');
const { toDateStr } = require('./dates');
const { etDateString, addETDays } = require('../../utils/datetime-et');

const CODE = 'SOUTH_DAY_KEPT';

const zoneFields = (row, fallback = {}) => ({
  zone: row.zone ?? fallback.zone,
  service_city: row.service_address_city ?? fallback.service_address_city,
  customer_city: row.customer_city ?? fallback.customer_city,
});

// The funnel module, read at call time (a suite that mocks feature-gates whole must not break a bare require).
const funnel = () => require('../scheduling/zone-day-funnel');

// Funneled zone rows plus the dates in the window (`window()` -> [dateFrom, dateTo]) that hold a live stop in one,
// and their per-truck view (`techDays`: date -> technician ids, null = unassigned; null with GATE_MULTI_TECH_CONFIRM
// off); null when a lookup fails. { zones: [], dates: empty, techDays: null } when the funnel is off (no query).
async function readSouth(dbc, window) {
  try {
    const f = funnel();
    const [dateFrom, dateTo] = window();
    const zones = await f.funnelZoneRows(dbc);
    const dates = new Set();
    let techDays = null;
    for (const estimateZone of zones) {
      const { days, techDays: zoneTechs, failed } = await f.getZoneFunnelDays(dbc, { estimateZone, dateFrom, dateTo });
      if (failed || !days) return null;
      days.forEach((d) => dates.add(d));
      if (zoneTechs) {
        techDays = techDays || new Map();
        zoneTechs.forEach((ids, d) => techDays.set(d, new Set([...(techDays.get(d) || []), ...ids])));
      }
    }
    return { zones, dates, techDays };
  } catch (err) {
    logger.warn(`[auto-dispatch] south-day rule off for this read (failing open): ${err.message}`);
    return null;
  }
}

// The run's store of far-south stop dates over the horizon [today, today + lookahead]: read once on first use,
// again after a move changed the schedule (invalidate). Gate off: the read is a no-op and is not repeated.
class SouthDays {
  constructor() { this.state = undefined; }

  invalidate() { this.state = undefined; }

  async read(dbc, ctx) {
    if (this.state === undefined) {
      this.state = await readSouth(dbc, () => [etDateString(ctx.nowDate), etDateString(addETDays(ctx.nowDate, ctx.lookaheadDays))]);
    }
    return this.state;
  }
}

// The per-truck view (`techDays`) for a single visit only; null = the fleet's (the gate off, or a grouped visit).
// Apply time also passes the fresh row: a visit grouped in either keeps the fleet's view.
const truckView = (state, ...rows) => (rows.some((row) => row && row.visit_id) ? null : state.techDays);

// This visit's rule for the evaluation, or null (rule off, visit far-south, or zone unresolved: no filter).
// `dates` = far-south stop dates, `techDays` = their per-truck view (truckView); `ownDate` = the visit's current
// date (a same-day re-time is never dropped).
async function ruleFor(service, ctx) {
  const state = await (ctx.southDays || new SouthDays()).read(ctx.db, ctx);
  if (!state || !state.zones.length) return null;
  const south = funnel().rowInFunnelZones(zoneFields(service), state.zones);
  if (south === null) {
    logger.info(`[auto-dispatch] south-day rule skipped for visit ${service.id}: no zone stamp and no city (failing open)`);
    return null;
  }
  return south ? null : { dates: state.dates, techDays: truckView(state, service), ownDate: toDateStr(service.scheduled_date) };
}

// HARD filter test: the candidate date is another day that holds a far-south stop of the slot's technician
// (`techId`; per truck only, else any far-south stop holds the date).
const blocks = (dateStr, rule, techId = null) => !!rule && dateStr !== rule.ownDate
  && funnel().onZoneDay(dateStr, techId, rule.dates, rule.techDays);

// Apply time, inside the move transaction: the destination date's far-south stops as stored now, for each technician
// the visit can sit with on that date (`techIds`; null = unassigned, which any far-south stop holds; a grouped visit
// has the fleet's view, truckView). Same fail-open as the candidate side. `row` = the row being moved; `service` = the
// pass-1 snapshot (zone fields fallback).
async function assertDestinationClear(trx, row, service, dateStr, refuse, techIds = [null]) {
  let held = false;
  try {
    if (dateStr === toDateStr(row.scheduled_date)) return;
    const state = await readSouth(trx, () => [dateStr, dateStr]);
    if (!state || !state.zones.length) return;
    const south = funnel().rowInFunnelZones(zoneFields(row, service), state.zones);
    const techDays = truckView(state, row, service);
    const ids = techIds.length ? techIds : [null];
    held = south === false && ids.some((techId) => funnel().onZoneDay(dateStr, techId, state.dates, techDays));
  } catch (err) {
    logger.warn(`[auto-dispatch] south-day apply check off (failing open): ${err.message}`);
    return;
  }
  if (held) throw refuse(row.id, `would land on ${dateStr}, a day that already holds a far-south stop`);
}

module.exports = { CODE, SouthDays, ruleFor, blocks, assertDestinationClear };
