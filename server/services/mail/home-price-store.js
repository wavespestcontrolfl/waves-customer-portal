'use strict';

/**
 * The database side of the home price pass (services/mail/home-price.js): which mail_prospects rows are due, the
 * permit facts the pass may use, and the one write of a row's facts and price. Every function takes a knex handle or a
 * transaction as its last argument so a test can inject one; the default is the portal's shared handle.
 *
 * It writes only the price columns of mail_prospects (migration 20261122200000). The permit page result is stored by
 * the permit reader's own recordResult, not here.
 */

const db = require('../../models/db');
const { etDateString } = require('../../utils/datetime-et');

const LIST_KEY = 'new_home';
const DEFAULT_LIMIT = 40;
const RETRY_AFTER_HOURS = 20; // a failed or missing_fact row is read again after this many hours
const RETRY_WINDOW_DAYS = 21; // and only while its deed is no older than this
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

const PRICE_STATUSES = ['priced', 'missing_fact', 'not_clean', 'failed'];
const RETRY_STATUSES = ['failed', 'missing_fact'];
// A row's version: its last check time to the microsecond, as text ('' = never checked). dueForPrice hands it to the
// pass, and savePriceResult writes only while the row still has it. So a run that read a row before another run wrote
// it cannot replace the newer result or restart its 20-hour wait.
const PRICE_VERSION_SQL = "COALESCE(to_char(price_checked_at AT TIME ZONE 'UTC', 'YYYYMMDDHH24MISSUS'), '')";

function asDate(value, name) {
  const date = value === undefined ? new Date() : new Date(value);
  if (Number.isNaN(date.getTime())) throw new TypeError(`${name}: now is not a date`);
  return date;
}

/**
 * The rows the pass reads, in order, at most `limit` (default 40):
 *   1. never tried (price_status is NULL), oldest recorded_date first;
 *   2. failed or missing_fact rows last checked more than 20 hours ago (a row with no check time counts as old),
 *      oldest recorded_date first, and only while the deed was recorded in the last 21 Eastern days.
 * Only `eligible` rows of the new-home list. A priced or not_clean row is settled and never returned. Returns only what
 * the pass needs; recorded_date is YYYY-MM-DD text, and price_version is the row's version for savePriceResult.
 */
async function dueForPrice(options, conn = db) {
  // The connection is the last argument, as in the other store functions: a handle in the options' place would be
  // ignored and the read would run on the default handle.
  if (typeof options === 'function') throw new TypeError('dueForPrice: the connection is the second argument');
  const { limit = DEFAULT_LIMIT, now } = options || {};
  if (!Number.isInteger(limit) || limit < 1) throw new TypeError('dueForPrice: limit must be a positive integer');
  const at = asDate(now, 'dueForPrice');
  const retryBefore = new Date(at.getTime() - RETRY_AFTER_HOURS * HOUR_MS);
  const [y, m, d] = etDateString(at).split('-').map(Number);
  const oldestDeed = new Date(Date.UTC(y, m - 1, d) - RETRY_WINDOW_DAYS * DAY_MS).toISOString().slice(0, 10);
  return conn('mail_prospects')
    .where({ list_key: LIST_KEY, status: 'eligible' })
    .where((b) => b
      .whereNull('price_status')
      .orWhere((retry) => retry
        .whereIn('price_status', RETRY_STATUSES)
        .where((checked) => checked.whereNull('price_checked_at').orWhere('price_checked_at', '<', retryBefore))
        .where('recorded_date', '>=', oldestDeed)))
    .orderByRaw('(price_status IS NOT NULL) ASC')
    .orderBy('recorded_date', 'asc')
    .orderBy('id', 'asc')
    .limit(limit)
    .select(
      'id', 'parcel_pin', 'permit_no', 'address_line1', 'city', 'state', 'zip', 'price_status',
      conn.raw("to_char(recorded_date, 'YYYY-MM-DD') AS recorded_date"),
      conn.raw(`${PRICE_VERSION_SQL} AS price_version`),
    );
}

/**
 * The stored facts of one permit, or null when the permit is not in construction_permit_records. The row carries the
 * names the permit reader's recordResult wants of a candidate (permit_no, co_date, detail_status), so it can be passed
 * to it as it is. conditioned_sqft and stories are numbers or null; detail_fetched_at is a Date or null; co_date is
 * YYYY-MM-DD text or null.
 */
async function permitFacts(permitNo, conn = db) {
  if (typeof permitNo === 'function') throw new TypeError('permitFacts: the connection is the second argument');
  const no = String(permitNo ?? '').trim();
  if (!no) return null;
  const row = await conn('construction_permit_records')
    .where({ permit_no: no })
    .first(
      'permit_no', 'type_of_work', 'detail_status', 'detail_fetched_at', 'conditioned_sqft', 'stories',
      conn.raw("to_char(co_date, 'YYYY-MM-DD') AS co_date"),
    );
  if (!row) return null;
  const num = (v) => (v === null || v === undefined ? null : Number(v));
  return { ...row, conditioned_sqft: num(row.conditioned_sqft), stories: num(row.stories) };
}

const orNull = (v) => (v === undefined ? null : v);

/**
 * Write one row's facts and result. `row` is a row of dueForPrice: its id and the version this run read. `result`:
 *   { status, reason, homeSqft, homeSqftSource, stories, lotSqft, priceAnnual, priceSetupFee, priceDigest }
 * status is priced | missing_fact | not_clean | failed; the facts are the ones the pass knew (a missing one is stored
 * as NULL, so an older read never leaves a stale fact). A priced row gets its price columns and priced_at; any other
 * row gets none, and price_checked_at is always set. The table's CHECKs refuse a half-written price (code 23514).
 *
 * A row that is already priced or not_clean, that is no longer an eligible row of the list, or that another run wrote
 * after this run read it (its version changed) is left as it is. The test and the write are one statement, so two runs
 * cannot both write one read. Returns `{ written: true, price_status }`, or `{ written: false, why, price_status }`
 * with why = settled | changed | not_eligible | not_found.
 */
async function savePriceResult(row, result, conn = db) {
  if (typeof result === 'function') throw new TypeError('savePriceResult: the connection is the third argument');
  if (!row || typeof row !== 'object' || !row.id || typeof row.price_version !== 'string') {
    throw new TypeError('savePriceResult: the first argument is a row of dueForPrice (its id and price_version)');
  }
  const { id } = row;
  if (!result || !PRICE_STATUSES.includes(result.status)) throw new TypeError('savePriceResult: unknown status');
  const priced = result.status === 'priced';
  const now = conn.fn.now();
  const changes = {
    price_status: result.status,
    price_reason: orNull(result.reason),
    home_sqft: orNull(result.homeSqft),
    home_sqft_source: orNull(result.homeSqftSource),
    home_stories: orNull(result.stories),
    lot_sqft: orNull(result.lotSqft),
    price_annual: priced ? orNull(result.priceAnnual) : null,
    price_setup_fee: priced ? orNull(result.priceSetupFee) : null,
    price_digest: priced ? orNull(result.priceDigest) : null,
    priced_at: priced ? now : null,
    price_checked_at: now,
    updated_at: now,
  };
  const updated = await conn('mail_prospects')
    .where({ id, list_key: LIST_KEY, status: 'eligible' })
    .where((b) => b.whereNull('price_status').orWhereIn('price_status', RETRY_STATUSES))
    .whereRaw(`${PRICE_VERSION_SQL} = ?`, [row.price_version])
    .update(changes)
    .returning('price_status');
  if (updated.length) return { written: true, price_status: updated[0].price_status };
  const stored = await conn('mail_prospects').where({ id }).first('status', 'price_status', 'list_key');
  if (!stored) return { written: false, why: 'not_found', price_status: null };
  if (stored.list_key !== LIST_KEY || stored.status !== 'eligible') {
    return { written: false, why: 'not_eligible', price_status: stored.price_status };
  }
  // Still a retry row (or untried): then only the version stopped the write.
  const open = stored.price_status === null || RETRY_STATUSES.includes(stored.price_status);
  return { written: false, why: open ? 'changed' : 'settled', price_status: stored.price_status };
}

module.exports = {
  dueForPrice, permitFacts, savePriceResult, LIST_KEY, DEFAULT_LIMIT, RETRY_AFTER_HOURS, RETRY_WINDOW_DAYS,
  PRICE_VERSION_SQL,
};
