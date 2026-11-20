'use strict';

/**
 * Builders list (admin, read only). Which builders pull permits in unincorporated Manatee County, from the two
 * synced county tables: pool_permit_records (pool builders) and construction_permit_records (new homes). The owner
 * uses it to pick builders to pitch pre-slab termite treatment to. It sends nothing and calls no AI.
 *
 * A big builder files under several license numbers and several spellings, so rows are grouped by builder NAME key
 * (builderKey), not by license. Owner-builders (license OWN...) and permits with no contractor name are left out.
 * Logs carry counts and elapsed time only, never an address, owner name or parcel id.
 */

const db = require('../../models/db');
const logger = require('../logger');
const { etDateString } = require('../../utils/datetime-et');
const { dateOnlyString, dateOnlyAtNoonUtc } = require('../../utils/date-only');

const KINDS = ['pool', 'home'];
const COMPANY_WORDS = new Set(['LLC', 'INC', 'CORP', 'CORPORATION', 'CO', 'COMPANY', 'LTD', 'INCORPORATED']);
const DEFAULT_PERMIT_LIMIT = 25;
const MAX_PERMIT_LIMIT = 100;

// Table and column names are fixed here and picked by a validated kind; every value is a bound parameter.
// Pool: a canceled permit is not a pool (the table keeps them on purpose). Home: only new builds on a residential
// permit count; the table also holds commercial permits ("New", "New Multi-Family Residential"), which are not homes.
const SOURCES = {
  pool: {
    table: 'pool_permit_records',
    id: 'record_id',
    status: 'record_status',
    address: 'address_line1',
    city: 'city',
    typeOfWork: 'NULL',
    where: "AND LOWER(COALESCE(record_status, '')) <> 'canceled'",
  },
  home: {
    table: 'construction_permit_records',
    id: 'permit_no',
    status: 'status',
    address: 'address_raw',
    city: 'NULL',
    typeOfWork: 'type_of_work',
    where: "AND LOWER(COALESCE(permit_type, '')) = 'residential' AND type_of_work ILIKE 'New%' AND LOWER(COALESCE(status, '')) NOT IN ('canceled', 'withdrawn')",
  },
};

// The base filter every query shares: a named builder, not an owner-builder.
const BUILDER_ONLY = "AND BTRIM(COALESCE(contractor_name, '')) <> '' AND UPPER(COALESCE(contractor_license, '')) NOT LIKE 'OWN%'";

// A listed kind only: an inherited name such as "constructor" is not a key of SOURCES and never reaches a query.
function sourceFor(kind) {
  if (!KINDS.includes(kind)) throw new Error('unknown builder kind');
  return SOURCES[kind];
}

/** Upper case, punctuation gone, one space between words, trailing company words (LLC, INC, ...) dropped. */
function builderKey(name) {
  const words = String(name == null ? '' : name)
    .toUpperCase()
    .replace(/['.,]/g, '')
    .replace(/[^A-Z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);
  const kept = [...words];
  while (kept.length > 1 && COMPANY_WORDS.has(kept[kept.length - 1])) kept.pop();
  return kept.join(' ');
}

function shiftDay(day, days) {
  const at = dateOnlyAtNoonUtc(day);
  at.setUTCDate(at.getUTCDate() + days);
  return dateOnlyString(at);
}

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

function toRow(raw) {
  return {
    name: raw.name,
    license: raw.license || null,
    permits7: Number(raw.permits7) || 0,
    permits30: Number(raw.permits30) || 0,
    permits90: Number(raw.permits90) || 0,
    permits365: Number(raw.permits365) || 0,
    firstPermit: dateOnlyString(raw.first_permit),
    lastPermit: dateOnlyString(raw.last_permit),
  };
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

// Counts are per name and license across the whole table, so the first permit really is the first one on file.
// A permit dated after today (a county typing slip) is left out, so the counts and the first and newest dates agree.
async function readGroups(source, cut) {
  const result = await db.raw(
    `SELECT UPPER(BTRIM(contractor_name)) AS name,
            UPPER(BTRIM(contractor_license)) AS license,
            COUNT(*) FILTER (WHERE issued_date >= ?::date AND issued_date <= ?::date) AS permits7,
            COUNT(*) FILTER (WHERE issued_date >= ?::date) AS permits30,
            COUNT(*) FILTER (WHERE issued_date >= ?::date) AS permits90,
            COUNT(*) FILTER (WHERE issued_date >= ?::date) AS permits365,
            MIN(issued_date) AS first_permit,
            MAX(issued_date) AS last_permit
       FROM ${source.table}
      WHERE issued_date IS NOT NULL AND issued_date <= ?::date ${BUILDER_ONLY} ${source.where}
      GROUP BY 1, 2`,
    [cut.weekStart, cut.weekEnd, cut.d30, cut.d90, cut.d365, cut.today],
  );
  return result.rows.map(toRow);
}

async function readDataThrough(source, today) {
  const result = await db.raw(`SELECT MAX(issued_date) AS newest FROM ${source.table} WHERE issued_date <= ?::date`, [today]);
  return dateOnlyString(result.rows[0] && result.rows[0].newest);
}

// The keys of every active payer and every live customer company. The caller gets booleans only. A failed read
// fails the whole list (the office presses Try again): an empty set would show every customer as a fresh prospect.
async function readCustomerKeys() {
  const result = await db.raw(
    `SELECT company_name AS name FROM customers WHERE deleted_at IS NULL AND BTRIM(COALESCE(company_name, '')) <> ''
     UNION
     SELECT company_name AS name FROM payers WHERE active AND BTRIM(COALESCE(company_name, '')) <> ''
     UNION
     SELECT display_name AS name FROM payers WHERE active AND BTRIM(COALESCE(display_name, '')) <> ''`,
  );
  return new Set(result.rows.map((row) => builderKey(row.name)).filter(Boolean));
}

async function listBuilders({ kind, now = new Date() }) {
  const source = sourceFor(kind);
  const started = Date.now();
  const today = etDateString(now);
  const dataThrough = await readDataThrough(source, today);
  const cut = cutoffsFor(today, dataThrough);
  const [rows, customerKeys] = await Promise.all([readGroups(source, cut), readCustomerKeys()]);
  const merged = mergeBuilders(rows, { newSince: cut.d30, customerKeys });
  logger.info(`[builder-list] ${kind}: ${merged.builders.length} builders in ${Date.now() - started} ms`);
  return { kind, dataThrough, week: { from: cut.weekStart, through: cut.weekEnd, ...merged.week }, builders: merged.builders };
}

// The names (upper-cased, trimmed) that fold into one builder key.
async function namesForKey(source, key, today) {
  const result = await db.raw(
    `SELECT DISTINCT UPPER(BTRIM(contractor_name)) AS name FROM ${source.table}
      WHERE issued_date IS NOT NULL AND issued_date <= ?::date ${BUILDER_ONLY} ${source.where}`,
    [today],
  );
  return result.rows.map((row) => row.name).filter((name) => builderKey(name) === key);
}

// Job sites, newest first. Like the list, a permit dated after today is left out, so it can never push a real job
// site off the page. The limit is a whole number from 1 to 100 (PostgreSQL refuses a fraction).
async function builderPermits({ kind, key, limit = DEFAULT_PERMIT_LIMIT, now = new Date() }) {
  const source = sourceFor(kind);
  const started = Date.now();
  const today = etDateString(now);
  const names = await namesForKey(source, key, today);
  if (!names.length) return [];
  const take = Math.min(Math.max(Math.trunc(Number(limit)) || DEFAULT_PERMIT_LIMIT, 1), MAX_PERMIT_LIMIT);
  const result = await db.raw(
    `SELECT ${source.id} AS id, issued_date, ${source.status} AS status, ${source.address} AS address,
            ${source.city} AS city, zip, ${source.typeOfWork} AS type_of_work
       FROM ${source.table}
      WHERE issued_date IS NOT NULL AND issued_date <= ?::date ${BUILDER_ONLY} ${source.where}
        AND UPPER(BTRIM(contractor_name)) IN (${names.map(() => '?').join(', ')})
      ORDER BY issued_date DESC, ${source.id}
      LIMIT ?`,
    [today, ...names, take],
  );
  logger.info(`[builder-list] ${kind} permits: ${result.rows.length} rows in ${Date.now() - started} ms`);
  return result.rows.map((row) => ({
    id: row.id,
    issuedDate: dateOnlyString(row.issued_date),
    status: row.status || null,
    address: row.address || null,
    city: row.city || null,
    zip: row.zip || null,
    typeOfWork: row.type_of_work || null,
  }));
}

module.exports = { KINDS, builderKey, mergeBuilders, cutoffsFor, listBuilders, builderPermits };
