'use strict';

/**
 * Builders list (admin, read only). Which builders pull permits in unincorporated Manatee County, from the two
 * synced county tables: pool_permit_records (pool builders) and construction_permit_records (new homes). The owner
 * uses it to pick builders to pitch pre-slab termite treatment to. It sends nothing and calls no AI.
 *
 * A big builder files under several license numbers and several spellings, so rows are grouped by builder NAME key
 * (builderKey), not by license. Owner-builders (license OWN...) and permits with no contractor name are left out.
 * Logs carry counts and elapsed time only, never an address, owner name or parcel id.
 *
 * This file starts with the pure rules: the name key, the date windows and the merge. The database reads come in
 * the next change.
 */

const { addETDays } = require('../../utils/datetime-et');
const { dateOnlyString, dateOnlyAtNoonUtc } = require('../../utils/date-only');

const COMPANY_WORDS = new Set(['LLC', 'INC', 'CORP', 'CORPORATION', 'CO', 'COMPANY', 'LTD', 'INCORPORATED']);

/**
 * Upper case, accents dropped (PEÑA -> PENA, so it matches a customer typed without the accent), apostrophes and
 * periods gone (straight or curly), commas and other punctuation a space (POOLS,LLC is POOLS LLC), trailing company
 * words (LLC, INC, ...) dropped.
 * Letters of any script and digits stay, so two names in another alphabet never share a key.
 */
function builderKey(name) {
  const words = String(name == null ? '' : name)
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toUpperCase()
    .replace(/['‘’.]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);
  const kept = [...words];
  while (kept.length > 1 && COMPANY_WORDS.has(kept[kept.length - 1])) kept.pop();
  return kept.join(' ');
}

// A calendar day moved by whole days, with the shared helper: noon UTC is the same day in Eastern time.
const shiftDay = (day, days) => dateOnlyString(addETDays(dateOnlyAtNoonUtc(day), days));

// The county file arrives once a week (Mondays), so "the last 7 days from today" would fall to zero as the week goes on.
// The week summary is the 7 days that end on the newest permit date on file (weekEnd), never a day after today.
function cutoffsFor(today, dataThrough = null) {
  const weekEnd = dataThrough && dataThrough < today ? dataThrough : today;
  return {
    today,
    weekStart: shiftDay(weekEnd, -6), // 7 days, weekEnd included
    weekEnd,
    d30: shiftDay(today, -29), // the last 30 days, today included
    d90: shiftDay(today, -89),
    d365: shiftDay(today, -364),
  };
}

// The value with the highest weight; a tie goes to the smaller text so the answer never depends on row order.
function heaviest(rows, field) {
  const weight = new Map();
  for (const row of rows) {
    if (row[field]) weight.set(row[field], (weight.get(row[field]) || 0) + row.permits365);
  }
  const ranked = [...weight.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  return ranked.length ? ranked[0][0] : null;
}

function mergeGroup(key, group, { newSince, customerKeys }) {
  const sum = (field) => group.reduce((total, row) => total + row[field], 0);
  const firsts = group.map((row) => row.firstPermit).filter(Boolean).sort();
  const lasts = group.map((row) => row.lastPermit).filter(Boolean).sort();
  const firstPermit = firsts[0] || null;
  return {
    key,
    name: heaviest(group, 'name') || key,
    license: heaviest(group, 'license'),
    permits7: sum('permits7'),
    permits30: sum('permits30'),
    permits90: sum('permits90'),
    permits365: sum('permits365'),
    firstPermit,
    lastPermit: lasts.length ? lasts[lasts.length - 1] : null,
    isNew: Boolean(firstPermit && firstPermit >= newSince),
    isCustomer: customerKeys.has(key),
  };
}

/**
 * Pure merge. rows: one per upper-cased name and license from the database. Returns the builders (permits in the last
 * 365 days only), sorted by 90-day permits, then 12-month permits, then name, and the newest-week summary. The week is
 * counted before the 12-month cut: it ends on the newest permit on file, which can be older than 12 months.
 */
function mergeBuilders(rows, { newSince, customerKeys = new Set() }) {
  const groups = new Map();
  for (const row of rows) {
    const key = builderKey(row.name);
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  const merged = [...groups.entries()].map(([key, group]) => mergeGroup(key, group, { newSince, customerKeys }));
  const active = merged.filter((builder) => builder.permits7 > 0);
  const builders = merged
    .filter((builder) => builder.permits365 > 0)
    .sort((a, b) => b.permits90 - a.permits90 || b.permits365 - a.permits365 || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return {
    week: { permits: active.reduce((total, builder) => total + builder.permits7, 0), builders: active.length },
    builders: builders.map(({ permits7, ...builder }) => builder),
  };
}

module.exports = { builderKey, mergeBuilders, cutoffsFor };
