/**
 * Zone route days (GATE_ZONE_ROUTE_DAYS) — a far service zone's standing
 * route weekday (owner ruling 2026-09-29: Fridays are the Venice / North Port
 * day).
 *
 * Why: find-time charges an EMPTY day's first far stop the whole round trip
 * from HQ as "detour", and the customer-facing cap
 * (policy.js customerMaxDetourMinutes) rejects it — so a Venice-zone
 * customer could only ever be offered a day some other south visit had
 * already claimed, and the very first Friday visit could never be booked
 * online. This module names WHICH zone/weekday/technician is allowed a
 * lifted cap; policy.js applies it per candidate.
 *
 * Scope (deliberate): self-serve surfaces only — /book and the estimate
 * picker pass a zone slug into find-time's customerFacing capacity loop.
 * The phone agent, office Find-a-Time, the Intelligence Bar and auto-dispatch
 * never set customerFacing, so they never had this cap and are untouched.
 * Only the OFFER is widened: route feasibility (return time, overcommit,
 * arrival window, travel gap) is still evaluated for every candidate.
 *
 * Config: system_settings key `schedule_zone_route_days` (JSON text), e.g.
 *   {"venice": {"weekdays": [5], "max_detour_minutes": 150, "technician_id": null}}
 *   - key            zone slug (zoneSlugOf format: 'Venice / North Port' ->
 *                    'venice'); a funneled south slug (zone-day-funnel.js)
 *                    matches every other funneled south slug, because the
 *                    consolidated Venice row and the retained Port Charlotte
 *                    row are one south pool
 *   - weekdays       0=Sun .. 6=Sat, ET calendar date of the candidate
 *   - max_detour_minutes  the lifted cap for that zone on those weekdays
 *                    (never LOWERS the normal cap)
 *   - technician_id  optional: only that technician's candidates get the
 *                    lift; null/absent = any technician
 * Key ABSENT -> DEFAULT_ZONE_ROUTE_DAYS (Friday / Venice, any technician), so
 * flipping the gate alone is enough. Row present but blank/invalid/{} -> no
 * route days (set `{}` to switch the lift off without touching the gate).
 * A read failure also means no lift (the normal cap simply applies).
 */

const logger = require('../logger');
const { zoneRouteDaysLive } = require('../../config/feature-gates');
const { etCalendarDayOf } = require('../../utils/datetime-et');

const ZONE_ROUTE_DAYS_KEY = 'schedule_zone_route_days';

// Friday = 5. 150 minutes covers HQ -> Venice / North Port and back with
// headroom (well over the 45-minute normal cap, still bounded so a route that
// truly cannot work is not offered).
const DEFAULT_MAX_DETOUR_MINUTES = 150;
const DEFAULT_ZONE_ROUTE_DAYS = Object.freeze({
  venice: Object.freeze({ weekdays: Object.freeze([5]), max_detour_minutes: DEFAULT_MAX_DETOUR_MINUTES, technician_id: null }),
});

// Pure parse of the stored value (JSON text, or an already-parsed object from
// a jsonb-typed column) into { [slug]: { weekdays: number[], max_detour_minutes, technician_id } }.
// Malformed input -> {} (no lift).
function parseZoneRouteDays(value) {
  let parsed = value;
  if (typeof value === 'string') {
    try { parsed = JSON.parse(value); } catch { return {}; }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  const out = {};
  for (const [rawSlug, rule] of Object.entries(parsed)) {
    const slug = String(rawSlug || '').trim().toLowerCase();
    if (!slug || !rule || typeof rule !== 'object') continue;
    const weekdays = (Array.isArray(rule.weekdays) ? rule.weekdays : [])
      .map(Number).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6);
    if (!weekdays.length) continue;
    const cap = Number(rule.max_detour_minutes);
    out[slug] = {
      weekdays,
      max_detour_minutes: Number.isFinite(cap) && cap >= 0 ? cap : DEFAULT_MAX_DETOUR_MINUTES,
      technician_id: rule.technician_id ? String(rule.technician_id) : null,
    };
  }
  return out;
}

// Loaded once per availability request. Never throws.
async function readZoneRouteDays(conn) {
  try {
    const dbh = conn || require('../../models/db');
    const row = await dbh('system_settings').where('key', ZONE_ROUTE_DAYS_KEY).first('value');
    if (!row) return DEFAULT_ZONE_ROUTE_DAYS;
    return parseZoneRouteDays(row.value);
  } catch (err) {
    logger.warn(`[zone-route-days] config lookup failed (no lift this request): ${err.message}`);
    return {};
  }
}

// Version string of the route-day policy for an offer cache key: 'off' with
// the gate off (no db call), else the stored config text ('default' when the
// key is absent). A gate flip or a config edit — including the `{}` kill
// switch — therefore lands in a different key instead of serving offers built
// under the old cap. null when the config cannot be read: the caller must not
// cache that result (fail closed, request-scoped). Never throws.
async function zoneRouteDaysPolicyKey(conn) {
  if (!zoneRouteDaysLive()) return 'off';
  try {
    const dbh = conn || require('../../models/db');
    const row = await dbh('system_settings').where('key', ZONE_ROUTE_DAYS_KEY).first('value');
    if (!row) return 'default';
    return `cfg:${typeof row.value === 'string' ? row.value : JSON.stringify(row.value)}`;
  } catch (err) {
    logger.warn(`[zone-route-days] policy version lookup failed (result not cached): ${err.message}`);
    return null;
  }
}

// Same south pool: identical slugs, or both in the funnel's slug list.
function zoneSlugsMatch(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  const slugs = require('./zone-day-funnel').funnelZoneSlugs();
  return slugs.has(a) && slugs.has(b);
}

function weekdayOf(date) {
  const day = etCalendarDayOf(date);
  if (!day || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  return new Date(`${day}T12:00:00Z`).getUTCDay();
}

// The route-day rule that applies to (zone, date, technician), or null. Pure.
// technicianId undefined = a date-only question (seed ordering), so a
// technician-pinned rule still counts; a concrete technicianId must match a
// pinned rule.
function routeDayRuleFor(config, { zoneSlug, date, technicianId } = {}) {
  const slug = String(zoneSlug || '').trim().toLowerCase();
  if (!config || !slug || date == null) return null;
  const dow = weekdayOf(date);
  if (dow == null) return null;
  for (const [key, rule] of Object.entries(config)) {
    if (!zoneSlugsMatch(slug, key)) continue;
    if (!rule.weekdays.includes(dow)) continue;
    if (rule.technician_id && technicianId != null && String(technicianId) !== rule.technician_id) continue;
    return rule;
  }
  return null;
}

// The zone slug a self-serve availability request should be evaluated for,
// or null (gate off, no coordinates and no estimate zone, or no route day
// configured for it — i.e. nothing to lift). Coordinates win over the
// estimate's city-resolved zone; when they resolve nothing (no zone centers,
// outside every radius) the estimate's own zone is the fallback. Gate off
// makes NO db call. Never throws.
async function resolveZoneRouteDaySlug({ lat, lng, estimateZone, conn } = {}) {
  if (!zoneRouteDaysLive()) return null;
  try {
    const config = await readZoneRouteDays(conn);
    if (!Object.keys(config).length) return null;
    const { resolveZoneByCoords, zoneSlugOf } = require('../slot-zone');
    let zone = null;
    try { zone = await resolveZoneByCoords(conn || require('../../models/db'), lat, lng); } catch (err) {
      logger.warn(`[zone-route-days] zone-by-coords lookup failed: ${err.message}`);
    }
    return zoneSlugOf(zone || estimateZone) || null;
  } catch (err) {
    logger.warn(`[zone-route-days] zone resolution failed (no lift this request): ${err.message}`);
    return null;
  }
}

// Stable-reorder seed candidates so the zone's route-day dates come first
// (the south-zone funnel seeds preferredSeedDates[0]). Pure; returns the input
// order untouched when nothing matches.
function preferRouteDayDates(dates, { zoneSlug, config }) {
  if (!zoneSlug || !config || !Array.isArray(dates)) return dates;
  const isRoute = (d) => !!routeDayRuleFor(config, { zoneSlug, date: d });
  return [...dates.filter(isRoute), ...dates.filter((d) => !isRoute(d))];
}

module.exports = {
  ZONE_ROUTE_DAYS_KEY,
  DEFAULT_ZONE_ROUTE_DAYS,
  DEFAULT_MAX_DETOUR_MINUTES,
  parseZoneRouteDays,
  readZoneRouteDays,
  zoneRouteDaysPolicyKey,
  routeDayRuleFor,
  resolveZoneRouteDaySlug,
  preferRouteDayDates,
};
