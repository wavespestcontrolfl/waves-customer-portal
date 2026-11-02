'use strict';

// Monday review bell: ONE weekly bell for the work that sits (owner 2026-11-02,
// "build all", B2; builds item 6 of the 2026-09-30 notification rules: "a
// needs-you row unread 14 days goes into a Monday summary").
//
// Four lists get old without any bell ringing for them. Each is computed fresh
// on every run, and a line appears only when its count is above zero:
//   1. Needs-you alerts nobody has read for 14+ days. The retention sweep marks
//      a bell row done after 30 idle days (admin-alert-retention.js), so this is
//      the last look before they expire. Judged the way needs-me judges them
//      (needs-me.js mapAlertRow): known needs-you severity only, never an
//      "unsorted" row, never an Activity-only row, never Claude's queue.
//   2. Overdue promises Waves made to callers: the watchdog's own selection
//      (call-commitments selectOverdue, then the internal-test filter and the
//      still-open fence). Past 5 of them the watchdog's daily row is
//      Activity-only and never reaches the bell, so a backlog sits unseen.
//   3. Completed visits whose only invoice is a draft nobody sent (the
//      dashboard's "unsent drafts" rule, same 3-day floor and same exclusions).
//   4. Past-dated visits still open (stale-visit-sweep findStaleVisits).
//
// One needs-you row per Monday (dedupeKey monday-review:<ET date>) with a
// detail line per list and the page that opens it. Older monday-review rows
// close first ("Replaced by this week's review"); with every count at zero the
// run raises nothing and closes the older ones ("Nothing to review"). A rerun
// the same day finds the same key and writes nothing. The row is 7 days old
// when it is replaced, so the 30-day retention sweep never takes it early, and
// the list-1 query skips this key so the bell never counts itself.
//
// Sends nothing to a customer, calls no paid API, and writes only admin
// notifications. GATE_MONDAY_REVIEW_BELL (strict 'true', read at call time).
// Off = the weekly cron returns before any read.

const db = require('../models/db');
const logger = require('./logger');
const { mondayReviewBellLive } = require('../config/feature-gates');
const { etDateString } = require('../utils/datetime-et');
const { MAX_HEADLINE_CHARS, MAX_WHY_CHARS, cutAtWord, raiseAdminAlert } = require('./admin-alert-compose');

const KEY_PREFIX = 'monday-review:';
const CATEGORY = 'system';
const SUBJECT_ID = 'monday-review';
const AREA = 'System';
const DAY_MS = 24 * 60 * 60 * 1000;
const UNREAD_DAYS = 14;
const DRAFT_FLOOR_DAYS = 3;
// Candidates are paged (keyset on created_at, id) because the needs-you test runs in JS after the SQL filter: a
// fixed LIMIT could leave every qualifying row behind older ineligible ones. The cap only bounds a runaway table.
const ALERT_PAGE = 1000;
const ALERT_MAX_PAGES = 50;
const ALERT_HEADLINES = 5;
const HEADLINE_CHARS = 90;
const PROMISE_PAGE = 200;
const PROMISE_MAX_PAGES = 25;
const ID_CHUNK = 500;
const ET = 'America/New_York';
const NON_LIVE_INVOICE_STATUSES = ['draft', 'void', 'voided', 'cancelled'];
const REPLACED = "Replaced by this week's review";
const NOTHING = 'Nothing to review';

const plural = (n, one, many) => (n === 1 ? one : many);
const moneyWhole = (n) => `$${Math.round(n).toLocaleString('en-US')}`;
const moneyCents = (n) => `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

// "Oct 5" for an instant or a YYYY-MM-DD date, on the Eastern calendar.
function shortDate(value) {
  if (!value) return null;
  const text = typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T12:00:00Z` : value;
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString('en-US', { timeZone: ET, month: 'short', day: 'numeric' });
}

function parseMeta(metadata) {
  if (metadata && typeof metadata === 'object') return metadata;
  if (typeof metadata !== 'string') return {};
  try { const parsed = JSON.parse(metadata); return parsed && typeof parsed === 'object' ? parsed : {}; } catch { return {}; }
}

// ---------------------------------------------------------------------------
// The four loaders. Each returns { count, ... } and reads only.
// ---------------------------------------------------------------------------

// List 1. A needs-you row (needs-me's reading) that is not done, was never
// read, and has shown no sign of life for UNREAD_DAYS (created_at or a later
// ring stamp, the way the retention sweep computes it).
async function loadUnreadAlerts({ now = new Date(), database = db, pageSize = ALERT_PAGE, maxPages = ALERT_MAX_PAGES } = {}) {
  const { mapAlertRow } = require('./needs-me');
  const { lastActivityMs } = require('./admin-alert-retention');
  const nowMs = now.getTime();
  const cutoff = new Date(nowMs - UNREAD_DAYS * DAY_MS);
  const kept = [];
  let after = null;
  let capped = false;
  for (let page = 0; ; page += 1) {
    if (page >= maxPages) { capped = true; break; }
    const query = database('notifications')
      .where({ recipient_type: 'admin' }).whereNull('done_at').whereNull('read_at')
      .where('created_at', '<', cutoff)
      .whereRaw("COALESCE(metadata->>'feed', '') <> 'activity'")
      .whereRaw("COALESCE(metadata->>'claudeQueue', '') = ''")
      .whereRaw("COALESCE(metadata->>'who', '') <> 'claude'")
      .whereRaw("COALESCE(metadata->>'triggerKey', '') <> 'dashboard_alert'")
      .whereRaw("COALESCE(metadata->>'resolved', '') <> 'true'")
      .whereRaw("COALESCE(metadata->>'dedupeKey', '') NOT LIKE 'monday-review:%'");
    // The cursor carries the database's own text timestamp: a JS Date drops the microseconds Postgres keeps, which
    // would move the cursor back and re-read the boundary row (Codex r2).
    if (after) query.whereRaw('(created_at, id) > (?::timestamptz, ?)', [after.cursorAt, after.id]);
    const rows = await query.orderByRaw('created_at ASC, id ASC').limit(pageSize)
      .select('id', 'category', 'title', 'link', 'metadata', 'created_at', 'read_at', database.raw('created_at::text AS cursor_at'));
    for (const row of rows) {
      const item = mapAlertRow(row);
      if (item.severity !== 'needs-you' || item.unsorted || item.activityOnly || item.who === 'claude') continue;
      const idleSince = lastActivityMs(row, parseMeta(row.metadata), nowMs);
      if (idleSince < cutoff.getTime()) kept.push({ headline: String(row.title || '').trim(), idleSince });
    }
    if (rows.length < pageSize) break;
    const last = rows[rows.length - 1];
    after = { cursorAt: last.cursor_at, id: last.id };
  }
  if (capped) logger.warn(`[monday-review] unread alert scan stopped after ${maxPages} pages; the count is a floor`);
  kept.sort((a, b) => a.idleSince - b.idleSince);
  return {
    count: kept.length,
    capped,
    oldestAt: kept[0] ? new Date(kept[0].idleSince) : null,
    headlines: kept.slice(0, ALERT_HEADLINES).map((k) => ({ headline: k.headline, at: new Date(k.idleSince) })),
  };
}

// List 2. The watchdog's selection, read only (prepare stays false: this bell
// must not initialize callback cards).
async function loadOverduePromises({ now = new Date(), database = db } = {}) {
  const commitments = require('./call-commitments');
  const { isInternalTestCustomerId } = require('./internal-test-customers');
  const open = [];
  for (let page = 0; page < PROMISE_MAX_PAGES; page += 1) {
    const rows = await commitments.listOpenCommitments(database, {
      party: 'waves', limit: PROMISE_PAGE, offset: page * PROMISE_PAGE, includeHints: true, prepare: false, now,
    });
    open.push(...rows);
    if (rows.length < PROMISE_PAGE) break;
  }
  const overdue = commitments.selectOverdue(open, { now }).filter((r) => !isInternalTestCustomerId(r.customer_id));
  const live = await commitments.stillOpenIds(database, overdue.map((r) => r.id), { now });
  const current = overdue.filter((r) => live.has(r.id));
  const due = current.map((r) => commitments.overdueAt(r)).filter(Boolean);
  due.sort((a, b) => a.getTime() - b.getTime());
  return { count: current.length, oldestAt: due[0] || null };
}

// List 3. A completed visit whose only invoice is an unsent draft.
async function loadDraftOnlyVisits({ now = new Date(), database = db } = {}) {
  const floor = new Date(now.getTime() - DRAFT_FLOOR_DAYS * DAY_MS);
  const rows = await database('invoices as i')
    .join('scheduled_services as ss', 'i.scheduled_service_id', 'ss.id')
    .where('i.status', 'draft')
    // A delivery can be stamped while the status stays draft (e.g. a summary text the customer accepted), so mirror
    // the dashboard's stale_draft_invoices guards: a draft that went out by email or text is not unsent work.
    .whereNull('i.sent_at')
    .whereNull('i.sms_sent_at')
    .whereNull('i.archived_at')
    .whereNull('i.payer_statement_id')
    .where('i.total', '>', 0)
    .where('i.created_at', '<', floor)
    .where('ss.status', 'completed')
    .whereNotExists(function anotherLiveInvoice() {
      this.select(1).from('invoices as o')
        .whereRaw('o.scheduled_service_id = i.scheduled_service_id')
        .whereRaw('o.id <> i.id')
        .whereNotIn('o.status', NON_LIVE_INVOICE_STATUSES);
    })
    .orderByRaw('i.created_at ASC, i.id ASC')
    .select('i.id', 'i.invoice_number', 'i.total', 'i.created_at');
  const total = rows.reduce((sum, r) => sum + (Number(r.total) || 0), 0);
  const oldest = rows[0] || null;
  return {
    count: rows.length,
    total: Math.round(total * 100) / 100,
    oldestId: oldest ? String(oldest.id) : null,
    oldestNumber: oldest ? (oldest.invoice_number || String(oldest.id).slice(0, 8)) : null,
  };
}

// List 4. Past-dated visits still open, with what they are worth when priced.
async function loadOpenPastVisits({ now = new Date(), database = db, findStaleVisits } = {}) {
  const sweep = require('./stale-visit-sweep')._private;
  const find = findStaleVisits || sweep.findStaleVisits;
  const { oldestDate } = sweep;
  const visits = await find(now);
  let priced = 0;
  const ids = visits.map((v) => v.id);
  for (let i = 0; i < ids.length; i += ID_CHUNK) {
    const row = await database('scheduled_services').whereIn('id', ids.slice(i, i + ID_CHUNK))
      .where('estimated_price', '>', 0).sum({ total: 'estimated_price' }).first();
    priced += Number(row?.total) || 0;
  }
  return { count: visits.length, priced: Math.round(priced * 100) / 100, oldestDate: oldestDate(visits) };
}

// ---------------------------------------------------------------------------
// Assembly (pure)
// ---------------------------------------------------------------------------

// The lists with a count above zero, in the owner's order, each with the short
// phrase for the "why" and the detail text.
function buildLists({ alerts, promises, drafts, visits }) {
  const lists = [];
  if (alerts?.count > 0) {
    const lines = (alerts.headlines || []).map((h) => `   - ${cutAtWord(h.headline, HEADLINE_CHARS)} (idle since ${shortDate(h.at)})`);
    lists.push({
      key: 'alerts',
      count: alerts.count,
      phrase: `${alerts.count}${alerts.capped ? '+' : ''} unread ${plural(alerts.count, 'alert', 'alerts')}`,
      detail: [
        `Needs-you alerts nobody read for ${UNREAD_DAYS}+ days: ${alerts.count}. A row expires after 30 idle days. Page: the bell.`,
        ...(lines.length ? [`   Oldest ${lines.length}:`, ...lines] : []),
      ].join('\n'),
      link: '/admin/dashboard',
    });
  }
  if (promises?.count > 0) {
    lists.push({
      key: 'promises',
      count: promises.count,
      phrase: `${promises.count} late ${plural(promises.count, 'promise', 'promises')}`,
      detail: `Promises to callers that are overdue: ${promises.count}.${promises.oldestAt ? ` Oldest due ${shortDate(promises.oldestAt)}.` : ''} Page: /admin/communications#tab=owed`,
      link: '/admin/communications#tab=owed',
    });
  }
  if (drafts?.count > 0) {
    const link = drafts.oldestId ? `/admin/invoices?invoice=${encodeURIComponent(drafts.oldestId)}` : '/admin/invoices';
    lists.push({
      key: 'drafts',
      count: drafts.count,
      phrase: `${drafts.count} unsent ${plural(drafts.count, 'draft', 'drafts')}`,
      detail: `Completed visits whose only invoice is an unsent draft: ${drafts.count}, ${moneyCents(drafts.total)}.${drafts.oldestNumber ? ` Oldest: ${drafts.oldestNumber}.` : ''} Page: ${link}`,
      link,
    });
  }
  if (visits?.count > 0) {
    lists.push({
      key: 'visits',
      count: visits.count,
      phrase: `${visits.count} open past ${plural(visits.count, 'visit', 'visits')}`,
      detail: `Past-dated visits still open: ${visits.count}${visits.priced > 0 ? `, ${moneyWhole(visits.priced)} priced` : ''}.${visits.oldestDate ? ` Oldest ${shortDate(visits.oldestDate)}.` : ''} Page: /admin/dashboard`,
      link: '/admin/dashboard',
    });
  }
  return lists;
}

// The composeAdminAlert spec and the detail text for a non-empty review.
function composeReview(lists) {
  const n = lists.length;
  const action = `review ${n} ${plural(n, 'list', 'lists')} that ${plural(n, 'sits', 'sit')}`;
  let why = `Waiting for you: ${lists.map((l) => l.phrase).join(', ')}.`;
  if (why.length > MAX_WHY_CHARS) why = `${cutAtWord(why.replace(/\.$/, ''), MAX_WHY_CHARS - 1)}.`;
  const detail = [
    `${n} ${plural(n, 'list has', 'lists have')} work that sits. Each line names its page. This check sent nothing to a customer.`,
    ...lists.map((l, i) => `${i + 1}. ${l.detail}`),
  ].join('\n');
  const spec = {
    area: AREA,
    action,
    why,
    severity: 'needs-you',
    link: '/admin/dashboard',
    subject: { type: 'check', id: SUBJECT_ID },
    doneWhen: 'reviewed',
    who: 'person',
  };
  if (`${AREA} — ${action}`.length > MAX_HEADLINE_CHARS) throw new Error('monday review headline too long');
  return { spec, detail };
}

// ---------------------------------------------------------------------------
// Close and raise
// ---------------------------------------------------------------------------

// Close every open monday-review row except `keepKey` (the system close, done_by
// 'episodes': a person's earlier done keeps its own stamps).
async function closeReviewRows({ database = db, now = new Date(), keepKey = null, resolution, reason }) {
  const episodes = require('./admin-alert-episodes');
  const keys = (await episodes.openAdminAlertKeys(database, KEY_PREFIX)).filter((k) => k !== keepKey);
  if (!keys.length) return 0;
  return Number(await episodes.closeAdminAlertKeys(database, keys, reason, { now, resolution })) || 0;
}

const defaultLoaders = {
  alerts: loadUnreadAlerts,
  promises: loadOverduePromises,
  drafts: loadDraftOnlyVisits,
  visits: loadOpenPastVisits,
};

/**
 * Monday cron entry point. Returns { skipped } when the gate is off, otherwise
 * { count, outcome }: raised | unchanged | suppressed | closed | clear.
 * A read failure throws (runExclusive records it in job_health) and closes
 * nothing. `loaders` replaces the four list readers (tests).
 */
async function runMondayReview({ now = new Date(), database = db, gateEnabled, loaders = {} } = {}) {
  if (!(gateEnabled ?? mondayReviewBellLive())) return { skipped: 'disabled' };
  const read = { ...defaultLoaders, ...loaders };
  const ctx = { now, database };
  const [alerts, promises, drafts, visits] = [
    await read.alerts(ctx), await read.promises(ctx), await read.drafts(ctx), await read.visits(ctx),
  ];
  const lists = buildLists({ alerts, promises, drafts, visits });
  const dedupeKey = `${KEY_PREFIX}${etDateString(now)}`;
  if (!lists.length) {
    const closed = await closeReviewRows({ database, now, resolution: NOTHING, reason: 'count_zero' });
    return { count: 0, outcome: closed ? 'closed' : 'clear' };
  }
  const { spec, detail } = composeReview(lists);
  await closeReviewRows({ database, now, keepKey: dedupeKey, resolution: REPLACED, reason: 'replaced' });
  const counts = Object.fromEntries(lists.map((l) => [l.key, l.count]));
  const result = await raiseAdminAlert(CATEGORY, spec, {
    dedupeKey,
    // GATE_ADMIN_BELL_POLICY drops an admin row that does not ask to ring.
    bell: true,
    detail,
    metadata: { mondayReview: true, weekOf: etDateString(now), counts },
  });
  if (!result) throw new Error('monday review bell was not written');
  let outcome = 'raised';
  if (result.suppressed) outcome = 'suppressed';
  else if (result.deduped) outcome = 'unchanged';
  logger.info(`[monday-review] ${lists.length} list(s): ${lists.map((l) => `${l.key} ${l.count}`).join(', ')} (${outcome})`);
  return { count: lists.length, counts, outcome };
}

module.exports = {
  runMondayReview,
  KEY_PREFIX,
  _private: {
    loadUnreadAlerts, loadOverduePromises, loadDraftOnlyVisits, loadOpenPastVisits,
    buildLists, composeReview, closeReviewRows, shortDate,
    UNREAD_DAYS, DRAFT_FLOOR_DAYS, REPLACED, NOTHING,
  },
};
