'use strict';

/**
 * Bid Desk SAM.gov reader (GATE_BID_DESK_SAM, dark; PR 2). Federal bids for pest control and grounds work come from
 * the official SAM.gov Get Opportunities API (https://open.gsa.gov/api/get-opportunities-public-api/), the only bid
 * source with a sanctioned API (the SAM.gov website itself forbids scraping).
 *
 *   runSamGovPoll()     once a day: notices posted since the stored cursor, for each NAICS code, filed as bids
 *   mapOpportunity()    PURE: one API notice -> the bid row we would file, or { skip } with the reason
 *
 * A notice is filed when it is a solicitation, combined synopsis, presolicitation or sources sought, still active, its
 * response deadline (if any) is in the future (a passed one still updates a bid already filed), and its place of performance is a Florida ZIP in SERVICE_ZIP3. Each
 * notice id is filed once (unique source + external_id); a republished notice refreshes its bid (refreshPatch). The
 * deadline is the API's own field, stored unconfirmed with the raw value as its source line: reminders still need the
 * operator to confirm it. One admin notification per new bid, and one when a republished notice changes the deadline,
 * owed on the bid and delivered by the Bid Desk's shared owed-bell sweep (deliverOwedAlerts). No AI call; nothing is sent to an
 * agency, a contractor or a customer. The API key is never logged (errors carry the HTTP status only).
 */
const db = require('../../models/db');
const { bidDeskSamLive } = require('../../config/feature-gates');
const { deliverOwedAlerts } = require('./index');
const { OPEN_STATUSES } = require('./rules');

const LOG = '[bid-desk-sam]';
const API_URL = 'https://api.sam.gov/opportunities/v2/search';
const CURSOR_KEY = 'bid_desk.sam_cursor';
const NAICS_CODES = ['561710', '561730'];
// Tampa Bay through Southwest Florida: MacDill and Tampa (336), Bay Pines and St. Petersburg (337), Lakeland (338),
// Fort Myers, Punta Gorda and Port Charlotte (339), Naples (341), Sarasota, Manatee and Venice (342), Pasco (335).
const SERVICE_ZIP3 = ['335', '336', '337', '338', '339', '341', '342'];
const FILED_TYPES = new Set(['solicitation', 'combined synopsis/solicitation', 'presolicitation', 'sources sought']);
const FIRST_RUN_LOOKBACK_DAYS = 30;
// The cursor steps back a day, so a notice posted late on the last day read is seen again (and skipped as filed).
const CURSOR_OVERLAP_DAYS = 1;
const PAGE_LIMIT = 1000;
const MAX_PAGES = 5;
const REQUEST_TIMEOUT_MS = 30 * 1000;
// The API's longest posted-date range is one year.
const MAX_WINDOW_DAYS = 364;

// ---------- pure helpers ----------

const pad = (n) => String(n).padStart(2, '0');
// The API's date parameters are MM/dd/yyyy, in the America/New_York calendar.
function etYmd(at) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(at).map((p) => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}
const apiDate = (ymd) => { const [y, m, d] = ymd.split('-'); return `${m}/${d}/${y}`; };
function addDays(ymd, days) {
  const at = new Date(`${ymd}T12:00:00Z`);
  at.setUTCDate(at.getUTCDate() + days);
  return `${at.getUTCFullYear()}-${pad(at.getUTCMonth() + 1)}-${pad(at.getUTCDate())}`;
}

const text = (value) => {
  const out = String(value ?? '').replace(/\s+/g, ' ').trim();
  return out || null;
};

// The agency as the office knows it: the last two parts of "DEPT OF X.SUB AGENCY.OFFICE" read best.
function agencyOf(notice) {
  const path = text(notice.fullParentPathName) || text(notice.department) || text(notice.subTier);
  if (!path) return null;
  const parts = path.split('.').map((p) => p.trim()).filter(Boolean);
  return parts.slice(-2).join(' · ');
}

function placeOf(notice) {
  const pop = notice.placeOfPerformance || {};
  const zip = text(pop.zip)?.replace(/\D/g, '').slice(0, 5) || null;
  const state = text(pop.state?.code)?.toUpperCase() || null;
  const city = text(pop.city?.name);
  return { zip, state, city };
}

function locationWords({ city, state, zip }) {
  return [city, [state, zip].filter(Boolean).join(' ')].filter(Boolean).join(', ') || null;
}

// The notice's public page, built from its id. The API's uiLink is not used: it can need a contracting-officer login.
function publicUrl(notice) {
  const id = text(notice.noticeId);
  return id && /^[A-Za-z0-9-]+$/.test(id) ? `https://sam.gov/opp/${id}/view` : null;
}

/**
 * One API notice -> { row, expired } to file, or { skip: reason }. `expired` (the deadline has passed at `now`) files no
 * new bid but still refreshes one already filed.
 */
function mapOpportunity(notice, now = new Date()) {
  const id = text(notice?.noticeId);
  if (!id) return { skip: 'no_notice_id' };
  if (!FILED_TYPES.has(String(notice.type || '').toLowerCase().trim())) return { skip: 'type' };
  if (String(notice.active || '').toLowerCase() === 'no') return { skip: 'inactive' };
  const place = placeOf(notice);
  if (place.state !== 'FL') return { skip: 'not_florida' };
  if (!place.zip || !SERVICE_ZIP3.includes(place.zip.slice(0, 3))) return { skip: 'outside_area' };

  const rawDeadline = text(notice.responseDeadLine);
  let dueAt = null;
  if (rawDeadline) {
    const parsed = new Date(rawDeadline);
    if (!Number.isNaN(parsed.getTime())) {
      dueAt = parsed;
    }
  }
  // A passed deadline files no NEW bid, but still updates a bid already filed (SAM.gov moved the date earlier).
  return {
    expired: dueAt != null && dueAt.getTime() <= now.getTime(),
    row: {
      source: 'sam_gov',
      external_id: id,
      external_url: publicUrl(notice),
      gc_or_agency: agencyOf(notice),
      project_title: text(notice.title),
      solicitation_number: text(notice.solicitationNumber),
      location: locationWords(place),
      due_at: dueAt,
      source_due_at: dueAt,
      due_source_line: rawDeadline ? `SAM.gov response deadline: ${rawDeadline}` : null,
      due_confirmed: false,
      status: 'new',
      historical: false,
      needs_date_confirmation: false,
    },
  };
}

// ---------- API ----------

class SamApiError extends Error {
  constructor(status) {
    super(`SAM.gov request failed (HTTP ${status})`);
    this.name = 'SamApiError';
    this.status = status;
  }
}

// One page of notices. Errors name the HTTP status only: the request URL carries the API key.
async function fetchPage({ apiKey, ncode, postedFrom, postedTo, offset, fetchImpl }) {
  const params = new URLSearchParams({
    api_key: apiKey, postedFrom, postedTo, ncode, state: 'FL', limit: String(PAGE_LIMIT), offset: String(offset),
  });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    let res;
    try {
      res = await fetchImpl(`${API_URL}?${params}`, { headers: { Accept: 'application/json' }, signal: controller.signal });
    } catch (err) {
      throw new SamApiError(err?.name === 'AbortError' ? 'timeout' : 'network');
    }
    // The API answers 404 "No Data found" for an empty window (its documented response codes): that is an empty page.
    if (res.status === 404) return { notices: [], total: 0 };
    if (!res.ok) throw new SamApiError(res.status);
    const body = await res.json().catch(() => null);
    if (!body || !Array.isArray(body.opportunitiesData)) throw new SamApiError('bad_body');
    return { notices: body.opportunitiesData, total: Number(body.totalRecords) || 0 };
  } finally {
    clearTimeout(timer);
  }
}

// SAM.gov's `offset` is a zero-based PAGE index, not a record offset. A window with more pages than MAX_PAGES throws,
// so an incomplete read never moves the cursor past notices it did not see.
async function fetchAll({ apiKey, ncode, postedFrom, postedTo, fetchImpl }) {
  const notices = [];
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const { notices: batch, total } = await fetchPage({ apiKey, ncode, postedFrom, postedTo, offset: page, fetchImpl });
    notices.push(...batch);
    if (batch.length < PAGE_LIMIT || notices.length >= total) return notices;
  }
  throw new SamApiError('too_many_pages');
}

// ---------- cursor ----------

async function readCursor() {
  const row = await db('system_settings').where({ key: CURSOR_KEY }).first('value');
  try {
    const parsed = row?.value ? JSON.parse(row.value) : null;
    return parsed && /^\d{4}-\d{2}-\d{2}$/.test(parsed.from || '') ? parsed.from : null;
  } catch {
    return null;
  }
}

async function writeCursor(from) {
  const value = JSON.stringify({ from });
  await db('system_settings').insert({ key: CURSOR_KEY, value, category: 'bid_desk', description: 'Bid Desk SAM.gov reader: next posted-from date' })
    .onConflict('key').merge({ value, updated_at: db.fn.now() });
}

// ---------- filing and notifications ----------

// Columns a republished notice refreshes: SAM.gov is their only source and the operator never edits them.
const REFRESH_FIELDS = ['gc_or_agency', 'project_title', 'solicitation_number', 'location', 'external_url'];
const sameInstant = (a, b) => (a == null ? null : new Date(a).getTime()) === (b == null ? null : new Date(b).getTime());

/**
 * What a republished notice changes on its bid. SAM.gov keeps the notice id and serves only the latest version, so
 * a new deadline replaces an UNCONFIRMED date (still unconfirmed); a date the operator confirmed is never
 * overwritten. Either way a different deadline flags the bid for confirmation (which pauses its reminders) and owes
 * one addendum bell for that deadline. A notice that drops its deadline changes no date.
 */
function refreshPatch(bid, row) {
  const patch = {};
  for (const field of REFRESH_FIELDS) {
    if (row[field] != null && row[field] !== bid[field]) patch[field] = row[field];
  }
  // Compared with the deadline SAM.gov last showed, not with due_at: a date the operator typed is not a source change.
  if (row.due_at && !sameInstant(bid.source_due_at ?? bid.due_at, row.due_at)) {
    patch.source_due_at = row.due_at;
    patch.due_source_line = row.due_source_line;
    if (!bid.due_confirmed) patch.due_at = row.due_at;
    patch.needs_date_confirmation = true;
    const open = OPEN_STATUSES.includes(bid.status) && !bid.historical;
    // A new-bid bell still owed rings with the current date; it is not replaced by an addendum bell.
    if (open && bid.owed_alert_kind !== 'new') {
      patch.owed_alert_kind = 'addendum';
      patch.owed_alert_key = `bid-desk:addendum:${bid.id}:sam:${new Date(row.due_at).toISOString()}`;
    }
  }
  return patch;
}

// Files one notice: a new bid (with its new-bid bell owed), a refresh of the bid already filed for it, or nothing.
// The partial unique index on (source, external_id) cannot be named by knex's onConflict, so the conflict target is
// written out; DO NOTHING keeps the transaction usable, and the existing row is then re-read under a row lock.
async function upsertNotice(row, { expired = false } = {}) {
  return db.transaction(async (trx) => {
    await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?))', ['bid-desk:ingest']);
    if (!expired) {
      const { sql, bindings } = trx('bid_opportunities').insert({ ...row, owed_alert_kind: 'new' }).toSQL();
      const inserted = await trx.raw(`${sql} ON CONFLICT (source, external_id) WHERE external_id IS NOT NULL DO NOTHING RETURNING id`, bindings);
      const id = inserted.rows?.[0]?.id;
      if (id) {
        await trx('bid_opportunities').where({ id }).update({ owed_alert_key: `bid-desk:new:${id}` });
        return { outcome: 'filed' };
      }
    }
    const bid = await trx('bid_opportunities').where({ source: 'sam_gov', external_id: row.external_id }).forUpdate().first();
    if (!bid) return { outcome: 'deadline_passed' };
    const patch = refreshPatch(bid, row);
    if (!Object.keys(patch).length) return { outcome: 'already_filed' };
    // clock_timestamp(), not now(): the version the page fences a date save on must move.
    await trx('bid_opportunities').where({ id: bid.id }).update({ ...patch, updated_at: trx.raw('clock_timestamp()') });
    return { outcome: 'refreshed' };
  });
}

function safeError(err) {
  if (err instanceof SamApiError) return err.message;
  return `${err?.name || 'Error'}${err?.code ? ` ${err.code}` : ''}`;
}

// Every notice posted in the window, once per notice id across the NAICS codes. A failure on any code throws before
// the cursor moves, so the next run reads the same window again.
async function collectNotices({ apiKey, postedFrom, postedTo, fetchImpl }) {
  const seen = new Map();
  for (const ncode of NAICS_CODES) {
    const notices = await fetchAll({ apiKey, ncode, postedFrom, postedTo, fetchImpl });
    for (const notice of notices) {
      const id = text(notice?.noticeId);
      if (id && !seen.has(id)) seen.set(id, notice);
    }
  }
  return [...seen.values()];
}

async function fileNotices(notices, now) {
  const counts = { filed: 0, refreshed: 0, skippedByReason: {} };
  for (const notice of notices) {
    const mapped = mapOpportunity(notice, now);
    const outcome = mapped.skip || (await upsertNotice(mapped.row, { expired: mapped.expired })).outcome;
    if (outcome === 'filed' || outcome === 'refreshed') counts[outcome] += 1;
    else counts.skippedByReason[outcome] = (counts.skippedByReason[outcome] || 0) + 1;
  }
  return counts;
}

/**
 * Reads notices posted since the cursor and files the ones in scope. Inert unless bidDeskSamLive() and an API key.
 * @returns {Promise<{ skipped?: string, read?: number, filed?: number, rung?: number, skippedByReason?: object }>}
 */
async function runSamGovPoll({ now = new Date(), fetchImpl = globalThis.fetch, apiKey = process.env.SAM_GOV_API_KEY } = {}) {
  if (!bidDeskSamLive()) return { skipped: 'gate_off' };
  const key = String(apiKey || '').trim();
  if (!key) return { skipped: 'no_api_key' };

  const today = etYmd(now);
  // The API refuses a posted-date range longer than a year, so an old cursor (the job off for a long time) is clamped.
  const oldest = addDays(today, -MAX_WINDOW_DAYS);
  const stored = (await readCursor()) || addDays(today, -FIRST_RUN_LOOKBACK_DAYS);
  let from = stored < oldest ? oldest : stored;
  if (from > today) from = today;
  const notices = await collectNotices({ apiKey: key, postedFrom: apiDate(from), postedTo: apiDate(today), fetchImpl });
  const counts = await fileNotices(notices, now);
  await writeCursor(addDays(today, -CURSOR_OVERLAP_DAYS));
  // The bells go out through the Bid Desk's one owed-bell sweep (also run every 15 minutes, so a failure retries there).
  const rung = await deliverOwedAlerts();
  return { read: notices.length, ...counts, rung };
}

module.exports = {
  runSamGovPoll, mapOpportunity, refreshPatch, fetchPage, fetchAll, safeError, SamApiError, etYmd, apiDate, addDays,
  CURSOR_KEY, NAICS_CODES, SERVICE_ZIP3, LOG, PAGE_LIMIT, MAX_PAGES,
};
