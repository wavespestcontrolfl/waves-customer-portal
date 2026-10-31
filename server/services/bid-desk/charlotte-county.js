'use strict';

/**
 * Bid Desk Charlotte County due dates (GATE_BID_DESK_CHARLOTTE_DATES, dark; needs GATE_BID_DESK). Charlotte County's
 * emailed notices ("Addendum Notification for Bid 26-674") carry no due date, so those bids were filed with none and
 * never reminded or closed. The county publishes its active bid list as public JSON, read by its own bids page:
 * https://purchasingbids.charlottecountyfl.gov/ContractsCatalogs/GetContractData
 *
 *   parseCountyList(json)     PURE: the county's rows -> Map of bid number ("26-674") -> due Date
 *   fetchCountyList()         the ONE fixed URL (no input reaches it): 15 s limit, 2xx, JSON, 5 MB at most
 *   runCharlotteDates()       fills the due date of open, dateless Charlotte County bids from that list
 *
 * The county is called only when an open Charlotte County bid with a bid number has no date (a cheap database check
 * first), so a quiet week makes no outside call. A date is only ever filled into an empty field: an existing date, a
 * decided bid, a status, a title and a decision are never touched. The date counts as confirmed only while
 * GATE_BID_DESK_AUTO_DATES is on (the same policy as a template date), so the 14 / 7 / 2-day reminders and the
 * automatic close then work as for any confirmed date. Nothing is sent to anyone and no new bell rings. Errors carry
 * the HTTP status or the error class only.
 */
const db = require('../../models/db');
const logger = require('../logger');
const { bidDeskCharlotteDatesLive, bidDeskAutoDatesLive } = require('../../config/feature-gates');
const { OPEN_STATUSES } = require('./rules');
const { closeDoneAlerts } = require('./close-alerts');

const LOG = '[bid-desk-charlotte]';
const COUNTY_URL = 'https://purchasingbids.charlottecountyfl.gov/ContractsCatalogs/GetContractData';
const USER_AGENT = 'WavesBidDesk/1.0';
const REQUEST_TIMEOUT_MS = 15 * 1000;
const MAX_BODY_BYTES = 5 * 1024 * 1024;
// The group key every Charlotte County Purchasing template bid carries (detector.js groupKeys: agency, then title).
const COUNTY_KEY_PREFIX = 'charlotte county purchasing division|';
const CANDIDATE_LIMIT = 200;
const FILE_NO = /^\d{2}-\d{3,4}$/;
const DATE_VALUE = /^\/Date\((-?\d+)\)\/$/;

class CountyError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CountyError';
  }
}

// ---------- pure ----------

/**
 * The county's list -> Map(bid number -> due Date). Keeps a row whose FileNo looks like a bid number, whose DueDate is
 * a real "/Date(ms)/" and which is not awarded. A bid number that appears more than once (any row) is ambiguous and
 * is dropped. Every other field (the HTML link strings) is ignored.
 */
function parseCountyList(json) {
  const rows = Array.isArray(json) ? json : [];
  const counts = new Map();
  const kept = new Map();
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const fileNo = typeof row.FileNo === 'string' ? row.FileNo.trim() : '';
    if (!FILE_NO.test(fileNo)) continue;
    counts.set(fileNo, (counts.get(fileNo) || 0) + 1);
    if (row.bAwarded === true) continue;
    const match = typeof row.DueDate === 'string' ? DATE_VALUE.exec(row.DueDate) : null;
    if (!match) continue;
    const ms = Number(match[1]);
    if (!Number.isSafeInteger(ms)) continue;
    const at = new Date(ms);
    if (Number.isNaN(at.getTime())) continue;
    kept.set(fileNo, at);
  }
  for (const [fileNo, n] of counts) if (n > 1) kept.delete(fileNo);
  return kept;
}

function safeError(err) {
  if (err instanceof CountyError) return err.message;
  return `${err?.name || 'Error'}${err?.code ? ` ${err.code}` : ''}`;
}

// "Nov 4, 2026, 2:00 PM ET"
function etStamp(at) {
  const text = new Date(at).toLocaleString('en-US', {
    timeZone: 'America/New_York', month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit',
  });
  return `${text} ET`;
}

// ---------- the one outside call ----------

// Reads the body up to the cap, whatever the headers say.
async function readCapped(res) {
  const declared = Number(res.headers?.get?.('content-length'));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) throw new CountyError('Charlotte County list too large');
  if (res.body && typeof res.body.getReader === 'function') {
    const reader = res.body.getReader();
    const chunks = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) {
        await reader.cancel().catch(() => {});
        throw new CountyError('Charlotte County list too large');
      }
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks).toString('utf8');
  }
  const body = await res.text();
  if (Buffer.byteLength(body, 'utf8') > MAX_BODY_BYTES) throw new CountyError('Charlotte County list too large');
  return body;
}

/** One GET of the county's public bid list. `fetchImpl` is for tests only. Errors carry the status or class only. */
async function fetchCountyList({ fetchImpl = globalThis.fetch } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    let res;
    let body;
    try {
      res = await fetchImpl(COUNTY_URL, {
        method: 'GET',
        headers: { Accept: 'application/json', 'User-Agent': USER_AGENT },
        credentials: 'omit',
        redirect: 'error',
        signal: controller.signal,
      });
      if (!res.ok) throw new CountyError(`Charlotte County list HTTP ${res.status}`);
      const type = String(res.headers?.get?.('content-type') || '').toLowerCase();
      if (!type.includes('json')) throw new CountyError('Charlotte County list is not JSON');
      body = await readCapped(res);
    } catch (err) {
      if (err instanceof CountyError) throw err;
      throw new CountyError(`Charlotte County list request failed: ${err?.name || 'Error'}`);
    }
    let json;
    try { json = JSON.parse(body); } catch { throw new CountyError('Charlotte County list is not JSON'); }
    if (!Array.isArray(json)) throw new CountyError('Charlotte County list is not a list');
    return json;
  } finally {
    clearTimeout(timer);
  }
}

// ---------- the run ----------

async function openDatelessCandidates() {
  return db('bid_opportunities')
    .whereIn('status', OPEN_STATUSES).whereNull('due_at').whereNotNull('solicitation_number')
    .whereRaw('group_key LIKE ?', [`${COUNTY_KEY_PREFIX}%`])
    .orderBy('created_at').limit(CANDIDATE_LIMIT)
    .select('id', 'solicitation_number', 'group_key');
}

/**
 * Fills the due date of open Charlotte County bids that have none. Gate off: nothing, no call. No open dateless
 * Charlotte County bid: nothing, no call. Otherwise one read of the county's list. A failed read throws (a failed run
 * in job health) and writes nothing. Returns { filled, unmatched, fetched }.
 */
async function runCharlotteDates({ fetchImpl } = {}) {
  if (!bidDeskCharlotteDatesLive()) return { skipped: 'gate_off' };
  const candidates = await openDatelessCandidates();
  if (!candidates.length) return { skipped: 'nothing_to_fill' };
  const list = parseCountyList(await fetchCountyList({ fetchImpl }));
  let filled = 0;
  let unmatched = 0;
  for (const candidate of candidates) {
    const due = list.get(String(candidate.solicitation_number).trim());
    if (!due) { unmatched += 1; continue; }
    try {
      const done = await db.transaction(async (trx) => {
        const before = await trx('bid_opportunities').where({ id: candidate.id }).forUpdate().first();
        if (!before || !bidDeskCharlotteDatesLive()) return false;
        if (!OPEN_STATUSES.includes(before.status) || before.due_at || before.group_key !== candidate.group_key) return false;
        const patch = {
          due_at: due,
          due_source_line: `Charlotte County bid list: due ${etStamp(due)}`,
          due_confirmed: bidDeskAutoDatesLive(),
          needs_date_confirmation: false,
          reminder_14d_sent_at: null,
          reminder_7d_sent_at: null,
          reminder_2d_sent_at: null,
        };
        // clock_timestamp(), not now(): the version the page fences a date save on must move.
        await trx('bid_opportunities').where({ id: candidate.id }).update({ ...patch, updated_at: trx.raw('clock_timestamp()') });
        // The same bell clean-up as an operator confirming a date.
        await closeDoneAlerts(trx, candidate.id, before, { ...before, ...patch });
        return true;
      });
      if (done) filled += 1;
    } catch (err) {
      logger.error(`${LOG} fill for bid ${candidate.id} failed: ${safeError(err)}`);
    }
  }
  if (filled || unmatched) logger.info(`${LOG} ${filled} date(s) filled, ${unmatched} not on the county list`);
  return { filled, unmatched, fetched: true };
}

module.exports = {
  parseCountyList, fetchCountyList, runCharlotteDates, safeError, CountyError,
  COUNTY_URL, USER_AGENT, REQUEST_TIMEOUT_MS, MAX_BODY_BYTES, COUNTY_KEY_PREFIX,
};
