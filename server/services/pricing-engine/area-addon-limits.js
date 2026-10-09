'use strict';

/**
 * Yearly application limits of the area add-on treatments (owner ruling 2026-10-08).
 *
 * ADD-ON-ONLY limits. The rule counts the applications of the add-on's PRODUCT at the property
 * (program applications and add-on applications both count toward the total) but it only ever
 * blocks or holds the ADD-ON: it never blocks a Tree & Shrub or lawn program visit, which applies
 * the same product on its own schedule by design. There are no product-wide `product_limits` rows.
 *
 * The numbers live once, in AREA_ADDONS.items[key] (constants.js): `maxPerYear` (applications in
 * any 12 months, the product's program and add-on applications together), `minDaysApart` (days
 * between two applications) and `limitProduct` (the catalog product the history is read for, the
 * same name the governed protocol `area_addon` hints). The pricer, the catalog payload
 * (areaAddOnCatalog), the protocol's label text, the job card and the history check all read this
 * one table; area-addon-limits-agree tests pin the protocol text to it.
 *
 * This file is PURE: it takes an injected history summary and a day, never queries and never reads
 * a clock. The summary is built from the database by services/area-addon-limits.js:
 *   { available: true,  asOf: 'YYYY-MM-DD', byKey: { <addOnKey>: { dates: ['YYYY-MM-DD', ...] } } }
 *   { available: false, reason }                          the history could not be read
 * `dates` are the applications of the add-on's product at the property in the last 12 months plus
 * the add-on visits already booked and not yet done (a booked visit counts: two estimates cannot
 * each book "the one allowed" application). A missing summary (no known customer: a new lead)
 * means no limit applies; a summary that is not this shape is treated as unreadable (fail closed).
 */
const { AREA_ADDONS } = require('./constants');

const WINDOW_DAYS = 365;
const DAY_MS = 86400000;
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

const LIMIT_REACHED_REASON = 'area_addon_yearly_limit_reached';
const HISTORY_UNAVAILABLE_REASON = 'area_addon_history_unavailable';

function isIsoDay(value) {
  return typeof value === 'string' && ISO_DAY.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
}
const dayNumber = (iso) => Math.floor(Date.parse(`${iso}T00:00:00Z`) / DAY_MS);
const dayFromNumber = (n) => new Date(n * DAY_MS).toISOString().slice(0, 10);
function addDays(iso, days) { return dayFromNumber(dayNumber(iso) + days); }

// The limit of one add-on row, or null (web sweep: no limit).
function addOnLimit(cfg) {
  if (!cfg || !(Number(cfg.maxPerYear) > 0)) return null;
  return {
    max: Number(cfg.maxPerYear),
    minDaysApart: Number(cfg.minDaysApart) > 0 ? Number(cfg.minDaysApart) : 0,
    product: cfg.limitProduct || null,
  };
}

// "4 in 12 months, at least 60 days apart" / "1 in 12 months" / null. The one wording of a limit.
function limitText(cfg) {
  const limit = addOnLimit(cfg);
  if (!limit) return null;
  const apart = limit.minDaysApart ? `, at least ${limit.minDaysApart} days apart` : '';
  return `${limit.max} in 12 months${apart}`;
}

// May an application happen on `day`, given the dates already on record (past applications and
// booked visits, either side of `day`)? Two rules: no other date closer than minDaysApart, and no
// 12-month window that holds `day` ends up with more than `max` applications.
function allowedOn(limit, dates, day) {
  const d = dayNumber(day);
  const others = dates.map(dayNumber);
  if (limit.minDaysApart && others.some((o) => Math.abs(o - d) < limit.minDaysApart)) return false;
  for (let start = d - (WINDOW_DAYS - 1); start <= d; start += 1) {
    const inWindow = others.filter((o) => o >= start && o <= start + (WINDOW_DAYS - 1)).length;
    if (inWindow + 1 > limit.max) return false;
  }
  return true;
}

// The first day on or after `day` the add-on may be applied. The search runs at most 800 days; a
// date that never opens (cannot happen with a finite history) falls back to the last day tried.
function nextAllowedDay(limit, dates, day) {
  let candidate = day;
  for (let i = 0; i < 800; i += 1) {
    if (allowedOn(limit, dates, candidate)) return candidate;
    candidate = addDays(candidate, 1);
  }
  return candidate;
}

// Reads the injected summary. null = no history given (no known customer: no limit applies).
// Anything else comes back as { available, asOf, byKey } or { available: false }.
function normalizeAreaAddOnHistory(history) {
  if (history === undefined || history === null) return null;
  if (typeof history !== 'object' || Array.isArray(history)) return { available: false };
  if (history.available === false) return { available: false };
  if (history.available !== true || !isIsoDay(history.asOf)) return { available: false };
  const byKey = history.byKey;
  if (!byKey || typeof byKey !== 'object' || Array.isArray(byKey)) return { available: false };
  const out = {};
  for (const [key, entry] of Object.entries(byKey)) {
    const dates = entry && Array.isArray(entry.dates) ? entry.dates : null;
    if (!dates || !dates.every(isIsoDay)) return { available: false };
    out[key] = { dates: [...dates].sort() };
  }
  return { available: true, asOf: history.asOf, byKey: out };
}

// The verdict for one add-on row on `day` (default: the summary's asOf):
//   null                                       nothing limits it
//   { reason: LIMIT_REACHED_REASON, ... }      the limit is reached; detail names the last application and the next allowed day
//   { reason: HISTORY_UNAVAILABLE_REASON }     the history could not be read (only for a row that has a limit)
function areaAddOnLimitVerdict(key, history, { day = null } = {}) {
  const cfg = Object.prototype.hasOwnProperty.call(AREA_ADDONS.items, key) ? AREA_ADDONS.items[key] : null;
  const limit = addOnLimit(cfg);
  const summary = normalizeAreaAddOnHistory(history);
  if (!limit || !summary) return null;
  if (!summary.available) {
    return {
      reason: HISTORY_UNAVAILABLE_REASON,
      detail: 'The treatment history for this property could not be checked, so the yearly limit cannot be confirmed. Price this add-on by hand.',
    };
  }
  const dates = (summary.byKey[key] && summary.byKey[key].dates) || [];
  const on = isIsoDay(day) ? day : summary.asOf;
  if (allowedOn(limit, dates, on)) return null;
  const nextAllowedOn = nextAllowedDay(limit, dates, on);
  const lastOn = dates.filter((d) => d <= on).pop() || dates[dates.length - 1];
  const inYear = dates.filter((d) => dayNumber(d) > dayNumber(on) - WINDOW_DAYS && dayNumber(d) <= dayNumber(on) + WINDOW_DAYS).length;
  const product = limit.product || 'This product';
  return {
    reason: LIMIT_REACHED_REASON,
    count: inYear,
    max: limit.max,
    lastAppliedOn: lastOn,
    nextAllowedOn,
    detail: `${product} was applied or booked ${inYear} time${inYear === 1 ? '' : 's'} at this property in the last 12 months (limit ${limitText(cfg)}). Last on ${lastOn}. The next one is allowed on ${nextAllowedOn}.`,
  };
}

// "Application 2 of 4 in 12 months; last applied 2026-08-01." for the job card, or null with no limit.
// `dates` are the applications already on record (this visit's own is not among them).
function limitUseText(cfg, dates, day) {
  const limit = addOnLimit(cfg);
  if (!limit || !isIsoDay(day)) return null;
  const clean = (dates || []).filter(isIsoDay).sort();
  const inYear = clean.filter((d) => dayNumber(d) > dayNumber(day) - WINDOW_DAYS && dayNumber(d) <= dayNumber(day)).length;
  const last = clean.filter((d) => d <= day).pop();
  return `Application ${inYear + 1} of ${limit.max} in 12 months${last ? `; last applied ${last}` : ''}.`;
}

module.exports = {
  WINDOW_DAYS,
  LIMIT_REACHED_REASON,
  HISTORY_UNAVAILABLE_REASON,
  isIsoDay,
  addDays,
  addOnLimit,
  limitText,
  normalizeAreaAddOnHistory,
  areaAddOnLimitVerdict,
  limitUseText,
};
