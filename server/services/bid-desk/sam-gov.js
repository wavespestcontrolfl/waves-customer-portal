'use strict';

/**
 * Bid Desk SAM.gov reader (GATE_BID_DESK_SAM, dark; PR 2). Federal bids for pest control and grounds work come from
 * the official SAM.gov Get Opportunities API (https://open.gsa.gov/api/get-opportunities-public-api/), the only bid
 * source with a sanctioned API (the SAM.gov website itself forbids scraping).
 *
 *   runSamGovPoll()     once a day: notices posted since the stored cursor, for each NAICS code, filed as bids
 *   mapOpportunity()    PURE: one API notice -> its bid row and why it may not create a new bid (block)
 *
 * A notice creates a bid when it is a solicitation, combined synopsis, presolicitation or sources sought, active, its
 * response deadline (if any) is in the future, and its place of performance is a Florida ZIP in SERVICE_ZIP3. Each
 * notice id is filed once (unique source + external_id). A notice already filed is refreshed whatever its type, place
 * or state now (refreshPatch): a republish, a moved or removed deadline, an archive or an award all reach the bid. The
 * deadline is the API's own field, stored unconfirmed with the raw value as its source line: reminders still need the
 * operator to confirm it. One admin notification per new bid, and one when a republished notice changes the deadline,
 * owed on the bid and delivered by the Bid Desk's shared owed-bell sweep (deliverOwedAlerts). No AI call; nothing is sent to an
 * agency, a contractor or a customer. The API key is never logged (errors carry the HTTP status only).
 */
const db = require('../../models/db');
const { bidDeskSamLive } = require('../../config/feature-gates');
const { etDateString, addETDays, parseETDateTime, validCalendarDate } = require('../../utils/datetime-et');
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
// Open SAM.gov bids re-read by notice id each run (one API call each; a registered key allows 1,000 calls a day).
const REFRESH_LIMIT = 25;

// ---------- pure helpers ----------

// The API's date parameters are MM/dd/yyyy, in the America/New_York calendar (server/utils/datetime-et.js).
const apiDate = (ymd) => { const [y, m, d] = ymd.split('-'); return `${m}/${d}/${y}`; };
const etDayOffset = (now, days) => etDateString(addETDays(now, days));

// SAM.gov deadlines come with an offset ("2026-11-05T14:00:00-05:00"), as Florida wall time with no zone
// ("2026-11-05T14:00:00"), or as a date only ("2026-11-05"). A wall time is read in Eastern time and a date alone is
// 11:59 PM Eastern that day (as for an email bid); only an offset-bearing value goes to the runtime parser.
function parseDeadline(raw) {
  const value = String(raw || '').trim();
  let at;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) at = validCalendarDate(value) ? parseETDateTime(`${value}T23:59`) : null;
  else if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?$/.test(value)) at = parseETDateTime(value.replace(/\.\d+$/, ''));
  else if (/(?:Z|[+-]\d{2}:?\d{2})$/i.test(value)) at = new Date(value);
  else at = null;
  return at && !Number.isNaN(at.getTime()) ? at : null;
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

// Why a notice may not create a NEW bid (null = it may). A notice already filed is refreshed whatever this says:
// SAM.gov changing its type to an award, archiving it, moving its deadline into the past or changing its place still
// has to reach the stored bid.
function newBidBlock({ filedType, active, place, dueAt }, now) {
  if (!filedType) return 'type';
  if (place.state !== 'FL') return 'not_florida';
  if (!place.zip || !SERVICE_ZIP3.includes(place.zip.slice(0, 3))) return 'outside_area';
  if (!active) return 'inactive';
  if (dueAt != null && dueAt.getTime() <= now.getTime()) return 'deadline_passed';
  return null;
}

/**
 * One API notice -> { row, block } (block: why it may not create a new bid, else null), or { skip } with no notice id.
 * `row.source_active` is false when the notice is inactive or no longer a solicitation-type notice (an award): either
 * way it is closed on SAM.gov.
 */
function mapOpportunity(notice, now = new Date()) {
  const id = text(notice?.noticeId);
  if (!id) return { skip: 'no_notice_id' };
  const filedType = FILED_TYPES.has(String(notice.type || '').toLowerCase().trim());
  const active = String(notice.active || '').toLowerCase() !== 'no';
  const place = placeOf(notice);
  const rawDeadline = text(notice.responseDeadLine);
  const dueAt = rawDeadline ? parseDeadline(rawDeadline) : null;
  return {
    block: newBidBlock({ filedType, active, place, dueAt }, now),
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
      source_active: active && filedType,
      due_source_line: dueAt ? `SAM.gov response deadline: ${rawDeadline}` : null,
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
// `filter` is the search: { ncode, state } for discovery, { noticeid } to re-read one notice already filed.
async function fetchPage({ apiKey, filter, postedFrom, postedTo, offset, fetchImpl }) {
  const params = new URLSearchParams({
    api_key: apiKey, postedFrom, postedTo, ...filter, limit: String(PAGE_LIMIT), offset: String(offset),
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
async function fetchAll({ apiKey, filter, postedFrom, postedTo, fetchImpl }) {
  const notices = [];
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const { notices: batch, total } = await fetchPage({ apiKey, filter, postedFrom, postedTo, offset: page, fetchImpl });
    notices.push(...batch);
    if (batch.length < PAGE_LIMIT || notices.length >= total) return notices;
  }
  throw new SamApiError('too_many_pages');
}

// ---------- cursor ----------

// { from, refreshAfter }: the next posted-from date, and the notice id the by-id refresh continues after (null = start).
async function readCursor() {
  const row = await db('system_settings').where({ key: CURSOR_KEY }).first('value');
  try {
    const parsed = row?.value ? JSON.parse(row.value) : null;
    return {
      from: parsed && /^\d{4}-\d{2}-\d{2}$/.test(parsed.from || '') ? parsed.from : null,
      refreshAfter: typeof parsed?.refresh_after === 'string' ? parsed.refresh_after : null,
    };
  } catch {
    return { from: null, refreshAfter: null };
  }
}

async function writeCursor({ from, refreshAfter }) {
  const value = JSON.stringify({ from, refresh_after: refreshAfter });
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
 * overwritten. A moved or removed deadline, or a notice that turned inactive, flags the bid for confirmation (which
 * pauses its reminders) and owes one addendum bell for that change.
 */
function refreshPatch(bid, row) {
  const patch = {};
  for (const field of REFRESH_FIELDS) {
    if (row[field] != null && row[field] !== bid[field]) patch[field] = row[field];
  }
  // Compared with what SAM.gov last showed, not with due_at: a date the operator typed is not a source change. A
  // deadline that moved, a deadline the notice no longer lists, and a notice that turned inactive each flag the bid.
  const deadlineChanged = !sameInstant(bid.source_due_at, row.due_at);
  const closed = row.source_active === false && bid.source_active !== false;
  if (row.source_active !== bid.source_active) patch.source_active = row.source_active;
  if (!deadlineChanged && !closed) return patch;
  if (deadlineChanged) {
    patch.source_due_at = row.due_at;
    patch.due_source_line = row.due_source_line || 'SAM.gov no longer lists a response deadline';
    if (row.due_at && !bid.due_confirmed) patch.due_at = row.due_at;
  }
  if (closed) patch.due_source_line = 'SAM.gov no longer lists this notice as active';
  patch.needs_date_confirmation = true;
  const open = OPEN_STATUSES.includes(bid.status) && !bid.historical;
  // A new-bid bell still owed rings with the current state; it is not replaced by an addendum bell.
  if (open && bid.owed_alert_kind !== 'new') {
    const what = closed ? 'inactive' : (row.due_at ? new Date(row.due_at).toISOString() : 'none');
    patch.owed_alert_kind = 'addendum';
    patch.owed_alert_key = `bid-desk:addendum:${bid.id}:sam:${what}`;
  }
  return patch;
}

// Files one notice: a new bid (with its new-bid bell owed), a refresh of the bid already filed for it, or nothing.
// The partial unique index on (source, external_id) cannot be named by knex's onConflict, so the conflict target is
// written out; DO NOTHING keeps the transaction usable, and the existing row is then re-read under a row lock.
async function upsertNotice(row, { block = null } = {}) {
  return db.transaction(async (trx) => {
    await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?))', ['bid-desk:ingest']);
    if (!block) {
      const { sql, bindings } = trx('bid_opportunities').insert({ ...row, owed_alert_kind: 'new' }).toSQL();
      const inserted = await trx.raw(`${sql} ON CONFLICT (source, external_id) WHERE external_id IS NOT NULL DO NOTHING RETURNING id`, bindings);
      const id = inserted.rows?.[0]?.id;
      if (id) {
        await trx('bid_opportunities').where({ id }).update({ owed_alert_key: `bid-desk:new:${id}` });
        return { outcome: 'filed' };
      }
    }
    const bid = await trx('bid_opportunities').where({ source: 'sam_gov', external_id: row.external_id }).forUpdate().first();
    if (!bid) return { outcome: block || 'not_open' };
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

// Every notice posted in the window, once per notice id across the NAICS codes, plus the latest version of open
// SAM.gov bids already filed (one rotating batch a run). The posted-date window alone would never see an older notice again once it is archived
// without a repost, so each run re-reads the open bids by notice id: republish, a removed deadline and an archive all
// reach refreshPatch the same way. A failure on any call throws before the cursor moves, so the next run tries again.
async function collectNotices({ apiKey, postedFrom, postedTo, refreshFrom, refreshAfter, fetchImpl }) {
  const seen = new Map();
  const add = (notices, onlyId = null) => {
    for (const notice of notices) {
      const id = text(notice?.noticeId);
      if (id && (!onlyId || id === onlyId)) seen.set(id, notice);
    }
  };
  for (const ncode of NAICS_CODES) {
    add(await fetchAll({ apiKey, filter: { ncode, state: 'FL' }, postedFrom, postedTo, fetchImpl }));
  }
  // The by-id read needs a posted-date range too. The notice may have been posted long before it was filed here (the
  // first run looks back 30 days), so it uses the API's whole one-year range.
  const batch = await openSamBids(refreshAfter);
  for (const externalId of batch) {
    const { notices } = await fetchPage({ apiKey, filter: { noticeid: externalId }, postedFrom: refreshFrom, postedTo, offset: 0, fetchImpl });
    add(notices, externalId);
  }
  // A full batch continues after its last id next run; a short one wraps to the start, so every open bid is checked.
  return { notices: [...seen.values()], nextRefreshAfter: batch.length === REFRESH_LIMIT ? batch[batch.length - 1] : null };
}

// Open SAM.gov bids whose notice is still listed active (the ones a change on SAM.gov could still affect), in notice-id
// order after `after`, one batch a run.
async function openSamBids(after) {
  const rows = await db('bid_opportunities').where({ source: 'sam_gov', historical: false }).whereIn('status', OPEN_STATUSES)
    .whereNot('source_active', false).whereNotNull('external_id')
    .modify((q) => { if (after) q.where('external_id', '>', after); })
    .orderBy('external_id').limit(REFRESH_LIMIT).select('external_id');
  return rows.map((r) => r.external_id);
}

async function fileNotices(notices, now) {
  const counts = { filed: 0, refreshed: 0, skippedByReason: {} };
  for (const notice of notices) {
    const mapped = mapOpportunity(notice, now);
    const outcome = mapped.skip || (await upsertNotice(mapped.row, { block: mapped.block })).outcome;
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

  const today = etDateString(now);
  // The API refuses a posted-date range longer than a year, so an old cursor (the job off for a long time) is clamped.
  const oldest = etDayOffset(now, -MAX_WINDOW_DAYS);
  const cursor = await readCursor();
  const stored = cursor.from || etDayOffset(now, -FIRST_RUN_LOOKBACK_DAYS);
  let from = stored < oldest ? oldest : stored;
  if (from > today) from = today;
  const { notices, nextRefreshAfter } = await collectNotices({
    apiKey: key, postedFrom: apiDate(from), postedTo: apiDate(today), refreshFrom: apiDate(oldest), refreshAfter: cursor.refreshAfter, fetchImpl,
  });
  const counts = await fileNotices(notices, now);
  await writeCursor({ from: etDayOffset(now, -CURSOR_OVERLAP_DAYS), refreshAfter: nextRefreshAfter });
  // The bells go out through the Bid Desk's one owed-bell sweep (also run every 15 minutes, so a failure retries there).
  const rung = await deliverOwedAlerts();
  return { read: notices.length, ...counts, rung };
}

module.exports = {
  runSamGovPoll, mapOpportunity, newBidBlock, refreshPatch, fetchPage, fetchAll, safeError, SamApiError, apiDate, parseDeadline,
  CURSOR_KEY, NAICS_CODES, SERVICE_ZIP3, LOG, PAGE_LIMIT, MAX_PAGES, REFRESH_LIMIT,
};
