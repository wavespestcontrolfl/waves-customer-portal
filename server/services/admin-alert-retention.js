/**
 * Admin alert retention: an admin alert expires instead of piling up forever
 * (owner approved 2026-10-26, "ok go"). Two rules, one nightly sweep
 * (runAdminAlertRetention, scheduler.js 1:32 AM ET):
 *   - age30: an admin row not done whose last activity is older than 30 days
 *     is marked done, read or unread. Bell rows only: a row that lives in the
 *     Activity feed (metadata.feed = 'activity') has no bell to leave.
 *   - fyi7: an FYI row (metadata.severity = 'fyi', and an ops_digest row of
 *     audience 'fyi') not done and idle for 7 days is marked done. This is the
 *     09-30 rule (docs/admin-notifications.md section 4 item 4), Activity rows
 *     included.
 * A row is MARKED done, never deleted. Read state is not touched: read_at stays
 * as it was, so an undo puts the row back exactly as it stood. done_by is
 * 'retention', the resolution says why in plain words, and metadata.retention
 * holds {run, rule, at} so one run can be undone (server/scripts/
 * undo-admin-alert-retention.js).
 *
 * Gate GATE_ALERT_RETENTION, three states (alertRetentionMode):
 *   unset / anything else = off, no query
 *   shadow                = judge every candidate and record what WOULD expire
 *                           in one audit_log row (admin_alert_retention.shadow),
 *                           change nothing
 *   true                  = expire, and record one audit_log row per run
 *                           (admin_alert_retention.expire)
 *
 * LAST ACTIVITY. A refresh of a standing row does not always move created_at.
 * What the code leaves behind (notification-service.js notifyAdmin):
 *   - a refresh that RINGS stamps metadata.rungAt = now (and moves created_at
 *     with bumpOnRefresh);
 *   - an ops-crons digest repeat stamps metadata.observedAt;
 *   - the Intelligence Bar model-failure bell stamps metadata.lastFailureAt on
 *     every failure.
 * Last activity = the latest of created_at and those three stamps (a stamp that
 * does not parse, or lies more than a day ahead, is ignored). NO signal exists
 * for a refresh that does not ring: a quiet refresh (ringOnRefresh false) or a
 * repeat with identical content writes nothing, and a plain deduped repeat
 * (no refreshOnDedupe) writes nothing. A row whose emitter only does that
 * ages from its last ringing refresh, or from created_at. Read it as a known
 * limit: such a row is a standing condition, which docs section 1 says belongs
 * on a page, not in the bell.
 *
 * RE-RING RISK. Closing a row can let its emitter raise it again:
 *   - dedupeOpenOnly emitters ignore a done row, so the next emission while
 *     their condition holds is a FRESH row (a ring). RERING below lists each of
 *     them and the decision; a test fails when a new dedupeOpenOnly emitter is
 *     added without one.
 *   - refreshOnDedupe emitters find the done row; a refresh whose content
 *     changed and rings clears done and reopens the SAME row (notifyAdmin
 *     DONE_CLEARED). Identical content leaves it done. That is the doc's
 *     "a comeback rings again" and needs no list.
 *   - an emitter with a dedupeKey and neither option finds the done row and
 *     stays silent, as it does for a person's Done.
 * Per emitter: 'event' (a new event is needed to raise it again: expire, the
 * fresh ring is news), 'periodic' (a sweep re-raises it while the condition
 * holds: a ring with no new event). A periodic row with a live check is SKIPPED
 * while it is live (promises). A periodic row without one is expired at most
 * RING_RISK_CAP per run (the doc's 10 rings a day), oldest first, so the first
 * run cannot burst.
 *
 * SCAN BUDGET. A run reads at most MAX_BATCHES x BATCH_SIZE candidates. The query
 * never returns a row that can never expire (a non-FYI Activity-feed row). A row kept
 * only for now (a recent activity stamp, a held promise, a periodic row past the cap, a
 * fence miss) is returned, so a run that stops on its budget saves a continuation
 * cursor (system_settings admin_alert_retention_cursor_<mode>) and the next run resumes
 * behind it; a run that reaches the end clears it and the next starts at the oldest row.
 *
 * Writes: batches of BATCH_SIZE, one short UPDATE each, fenced on the content
 * version the row was judged at (a refresh that landed since is left alone) and
 * on done_at IS NULL. No FOR UPDATE / FOR SHARE: the sweep is advisory and must
 * never block an emitter or a money path. A batch that cannot get its row locks
 * within LOCK_TIMEOUT_MS is skipped and the next run takes it.
 */

const db = require('../models/db');
const logger = require('./logger');
const { alertRetentionMode } = require('../config/feature-gates');

const DAY_MS = 24 * 60 * 60 * 1000;
const AGE_DAYS = 30;
const FYI_DAYS = 7;
const RETENTION_BY = 'retention';
const STAMP_KEY = 'retention';
const UNDONE_KEY = 'retentionUndone';
const BATCH_SIZE = 500;
const MAX_BATCHES = 40;
const RING_RISK_CAP = 10;
const LOCK_TIMEOUT_MS = 2000;
const STATEMENT_TIMEOUT_MS = 20000;
const FUTURE_SLACK_MS = DAY_MS;
const ACTIVITY_STAMP_KEYS = ['rungAt', 'observedAt', 'lastFailureAt'];
const RESOLUTIONS = {
  age30: 'Expired: no action in 30 days',
  fyi7: 'FYI expired after 7 days',
};

// Every emitter that passes dedupeOpenOnly: true, with the decision. `files` are
// the sources the pin test reads; `prefixes` are dedupeKey prefixes.
//   kind 'event'    : raised again only by a new event of its kind.
//   kind 'periodic' : a sweep raises it again while the condition holds.
//   live            : name of a check in LIVE_CHECKS; a row it calls live is skipped.
const RERING = [
  { emitter: 'lead-repeat-form', files: ['routes/lead-webhook.js'], prefixes: ['lead-repeat-form:'], kind: 'event',
    decision: 'expire: only a new quote form from the same customer raises it again' },
  { emitter: 'stock-shortfall', files: ['services/complete-scheduled-service.js', 'services/inventory-operations.js'], prefixes: ['stock-shortfall:'], kind: 'event',
    decision: 'expire: only another visit that overdraws the same product raises it again' },
  { emitter: 'ib-model-failure', files: ['services/intelligence-bar/model-failure.js'], prefixes: ['ib:model-failure:'], kind: 'event',
    decision: 'expire: only a new failed model call raises it again (one an hour at most)' },
  { emitter: 'series-price-guard-over-last-paid', files: ['services/series-price-guards.js'], prefixes: ['series-price-guard:over-last-paid:'], kind: 'event',
    decision: 'expire: only a new plan visit added over the last paid price raises it again' },
  { emitter: 'series-price-guard-cancelled-root', files: ['services/series-price-guards.js'], prefixes: ['series-price-guard:cancelled-root:'], kind: 'periodic',
    decision: 'expire, capped: the nightly top-up meets the cancelled first visit again and raises one fresh row' },
  { emitter: 'sms-draft-canary', files: ['services/sms-draft-canary.js'], prefixes: ['sms-draft-canary:'], kind: 'periodic',
    decision: 'expire, capped: a canary that still fails raises one fresh row (and the owner text it sends)' },
  { emitter: 'promise-overdue', files: ['services/sms-operational-actions.js', 'services/email-operational-actions.js'], prefixes: ['sms-commitment-source:', 'sms-commitment:', 'email-commitment:'], kind: 'periodic', live: 'promiseOpen',
    decision: 'skip while a promise it covers is still open; expire once none is' },
  { emitter: 'truck-kit', files: ['services/truck-kit.js'], prefixes: ['truck-kit:'], kind: 'event',
    decision: 'expire: only a new truck check that still finds tools missing raises it again' },
  { emitter: 'lead-agent-hold', files: ['services/lead-response-tools.js'], prefixes: ['lead-agent-hold:'], kind: 'event',
    decision: 'expire: only a new held draft for the same lead (a new lead agent run) raises it again' },
  { emitter: 'autopay-hold-charge', files: ['services/invoice-followups.js'], prefixes: ['autopay_hold_charge:'], kind: 'event',
    decision: 'expire: only a new Auto Pay hold charge attempt raises it again; an attempt keeps its invoice out of the charge sweep, and a review (over the agreed price, no price, not performed, a payer, a refusal) re-rings only after the bill or visit price changes' },
];

const parseMeta = (metadata) => {
  if (metadata && typeof metadata === 'object') return metadata;
  if (typeof metadata !== 'string') return {};
  try { const m = JSON.parse(metadata); return m && typeof m === 'object' ? m : {}; } catch { return {}; }
};

const stampMs = (value) => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}/.test(value)) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
};

// The latest sign of life in the row, in ms. A stamp that does not parse, or lies
// more than a day past `nowMs`, is junk and does not keep a row alive.
function lastActivityMs(row, meta, nowMs) {
  let latest = new Date(row.created_at).getTime();
  for (const key of ACTIVITY_STAMP_KEYS) {
    const ms = stampMs(meta[key]);
    if (ms != null && ms <= nowMs + FUTURE_SLACK_MS && ms > latest) latest = ms;
  }
  return latest;
}

const isFyiRow = (row, meta) => meta.severity === 'fyi' || (row.category === 'ops_digest' && meta.audience === 'fyi');
const isActivityOnly = (meta) => meta.feed === 'activity';

// The rule a row falls under at `ageMs` of idleness, or null. Strictly older than
// the limit: a row exactly 30 days idle stays.
function ruleFor(row, meta, ageMs) {
  if (isFyiRow(row, meta) && ageMs > FYI_DAYS * DAY_MS) return 'fyi7';
  if (!isActivityOnly(meta) && ageMs > AGE_DAYS * DAY_MS) return 'age30';
  return null;
}

// -> { expire: true, rule } | { expire: false, reason }
//   reason 'refreshed' : created_at alone would have expired it; a later stamp keeps it
//   reason 'young'     : not idle long enough
//   reason 'activity_only' : older than 30 days but in the Activity feed, not the bell
function judgeRow(row, now = new Date()) {
  const meta = parseMeta(row.metadata);
  const nowMs = now.getTime();
  const rule = ruleFor(row, meta, nowMs - lastActivityMs(row, meta, nowMs));
  if (rule) return { expire: true, rule };
  if (ruleFor(row, meta, nowMs - new Date(row.created_at).getTime())) return { expire: false, reason: 'refreshed' };
  if (isActivityOnly(meta) && nowMs - lastActivityMs(row, meta, nowMs) > AGE_DAYS * DAY_MS) return { expire: false, reason: 'activity_only' };
  return { expire: false, reason: 'young' };
}

// The RERING entry for a row's dedupeKey, or null.
function ringRiskFor(row) {
  const key = String(parseMeta(row.metadata).dedupeKey || '');
  if (!key) return null;
  return RERING.find((entry) => entry.prefixes.some((prefix) => key.startsWith(prefix))) || null;
}

// Live checks: (conn, rows) -> Set of row ids that are live. Fail safe: a check that
// cannot run calls every row live, so the sweep leaves it alone.
const LIVE_CHECKS = {
  async promiseOpen(conn, rows) {
    const bySource = new Map();
    const byCommitment = new Map();
    for (const row of rows) {
      const key = String(parseMeta(row.metadata).dedupeKey || '');
      const [prefix, id] = [key.slice(0, key.indexOf(':') + 1), key.slice(key.indexOf(':') + 1)];
      if (!id) continue;
      const map = prefix === 'sms-commitment-source:' ? bySource : byCommitment;
      map.set(id, [...(map.get(id) || []), row.id]);
    }
    const live = new Set();
    if (bySource.size) {
      const open = await conn('call_commitments')
        .whereRaw('sms_log_id::text = ANY(?::text[])', [[...bySource.keys()]])
        .where({ status: 'open', party: 'waves' }).whereNull('human_state')
        .select(conn.raw('sms_log_id::text AS ref'));
      for (const { ref } of open) (bySource.get(ref) || []).forEach((id) => live.add(id));
    }
    if (byCommitment.size) {
      const open = await conn('call_commitments')
        .whereRaw('id::text = ANY(?::text[])', [[...byCommitment.keys()]])
        .where({ status: 'open' })
        .select(conn.raw('id::text AS ref'));
      for (const { ref } of open) (byCommitment.get(ref) || []).forEach((id) => live.add(id));
    }
    return live;
  },
};

// judgeRow's isActivityOnly in SQL. A non-FYI Activity-feed row can never expire
// (it is not in the bell), so the query never returns it and it cannot eat the scan
// budget. Every other row the query returns can expire once its stamps age.
const NOT_ACTIVITY_SQL = "COALESCE(metadata->>'feed', '') <> 'activity'";
const FYI_SQL = "(metadata->>'severity' = 'fyi' OR (category = 'ops_digest' AND metadata->>'audience' = 'fyi'))";

// One page of candidates, oldest first, keyset on (created_at, id) over the open
// admin rows (notifications_admin_open_keyset_idx order). A row is only a
// candidate when created_at alone is past a cutoff (last activity is never
// earlier than created_at) and it is not a permanently ineligible row (a
// non-FYI Activity-feed row). Rows kept only for now (a recent stamp, a held
// promise, a capped periodic row) are returned; the continuation cursor
// (below) keeps them from starving the rows behind them.
async function loadPage(conn, { now, cursor, limit, scope = null }) {
  const { NOTIFICATION_VERSION_SQL } = require('./notification-service')._private;
  const ageCutoff = new Date(now.getTime() - AGE_DAYS * DAY_MS);
  const fyiCutoff = new Date(now.getTime() - FYI_DAYS * DAY_MS);
  const query = conn('notifications')
    .where({ recipient_type: 'admin' }).whereNull('done_at')
    .where((q) => q.where((a) => a.where('created_at', '<', ageCutoff).whereRaw(NOT_ACTIVITY_SQL))
      .orWhere((f) => f.where('created_at', '<', fyiCutoff).whereRaw(FYI_SQL)));
  if (cursor) query.whereRaw('(created_at, id) > (?::timestamptz, ?::uuid)', [cursor.at, cursor.id]);
  if (scope) scope(query);
  return query
    .select('id', 'category', 'created_at', 'read_at', 'metadata',
      conn.raw(`${NOTIFICATION_VERSION_SQL} AS version`), conn.raw('created_at::text AS created_at_cursor'))
    .orderByRaw('created_at ASC, id ASC')
    .limit(limit);
}

// Continuation cursor (the payment_failed_alert_sweep_cursor pattern): a run that
// stops on its scan budget saves where it stopped, so the next run resumes there
// instead of re-reading the same oldest rows; a run that reaches the end clears it,
// so the next one starts from the oldest row again. One key per mode: a shadow run
// never moves a live run's place.
const CURSOR_KEY = (mode) => `admin_alert_retention_cursor_${mode}`;
const CURSOR_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function parseCursor(value) {
  try {
    const c = JSON.parse(value);
    return c && typeof c.at === 'string' && Number.isFinite(Date.parse(c.at)) && CURSOR_ID_RE.test(c.id || '')
      ? { at: c.at, id: c.id } : null;
  } catch { return null; }
}

async function readCursor(conn, mode) {
  try {
    const row = await conn('system_settings').where({ key: CURSOR_KEY(mode) }).first('value');
    return row?.value ? parseCursor(row.value) : null;
  } catch (err) {
    logger.warn(`[alert-retention] cursor not read, starting from the oldest row: ${err.message}`);
    return null;
  }
}

async function writeCursor(conn, mode, cursor) {
  const value = cursor ? JSON.stringify({ at: cursor.at, id: cursor.id }) : null;
  try {
    await conn('system_settings').insert({ key: CURSOR_KEY(mode), value, category: 'notifications' })
      .onConflict('key').merge({ value, updated_at: conn.fn.now() });
  } catch (err) {
    logger.warn(`[alert-retention] cursor not saved, the next run starts from the oldest row: ${err.message}`);
  }
}

// Bell rows in the Activity feed that are older than 30 days and not FYI: not
// touched (no bell to leave). Counted in shadow so the owner can see the pile.
async function countActivityOnlyBacklog(conn, now) {
  const row = await conn('notifications')
    .where({ recipient_type: 'admin' }).whereNull('done_at')
    .whereRaw("metadata->>'feed' = 'activity'")
    .where('created_at', '<', new Date(now.getTime() - AGE_DAYS * DAY_MS))
    .count('* as count').first();
  return Number(row?.count) || 0;
}

// One short UPDATE per rule group. Fenced on done_at IS NULL and on the content
// version each row was judged at. Read state is not touched. Returns the number
// of rows marked; a lock timeout skips the batch (the next run takes it).
async function expireBatch(conn, rows, rule, { runId, now }) {
  if (!rows.length) return 0;
  const { NOTIFICATION_VERSION_SQL, doneColumns } = require('./notification-service')._private;
  const stamp = JSON.stringify({ [STAMP_KEY]: { run: runId, rule, at: now.toISOString() } });
  try {
    return await conn.transaction(async (trx) => {
      await trx.raw(`SET LOCAL lock_timeout = '${LOCK_TIMEOUT_MS}ms'`);
      await trx.raw(`SET LOCAL statement_timeout = '${STATEMENT_TIMEOUT_MS}ms'`);
      return trx('notifications')
        .whereIn('id', rows.map((r) => r.id))
        .where({ recipient_type: 'admin' }).whereNull('done_at')
        .whereRaw(`(id::text || ':' || ${NOTIFICATION_VERSION_SQL}) = ANY(?::text[])`, [rows.map((r) => `${r.id}:${r.version}`)])
        .update({
          ...doneColumns({ by: RETENTION_BY, resolution: RESOLUTIONS[rule], at: now, conn: trx }),
          metadata: trx.raw("COALESCE(metadata, '{}'::jsonb) || ?::jsonb", [stamp]),
        });
    });
  } catch (err) {
    if (err?.code === '55P03' || err?.code === '57014') {
      logger.warn(`[alert-retention] batch of ${rows.length} skipped (${err.code}); the next run takes it`);
      return 0;
    }
    throw err;
  }
}

async function recordSummary(summary) {
  const { recordAuditEvent } = require('./audit-log');
  await recordAuditEvent({
    actor_type: 'system',
    action: summary.mode === 'true' ? 'admin_alert_retention.expire' : 'admin_alert_retention.shadow',
    resource_type: 'notifications',
    metadata: summary,
  });
}

const bump = (map, key, by = 1) => { map[key] = (map[key] || 0) + by; };

function newSummary({ mode, runId, now }) {
  return {
    mode,
    runId,
    cutoffs: {
      age30: new Date(now.getTime() - AGE_DAYS * DAY_MS).toISOString(),
      fyi7: new Date(now.getTime() - FYI_DAYS * DAY_MS).toISOString(),
    },
    scanned: 0,
    expire: { total: 0, unread: 0, byRule: {}, byCategory: {} },
    kept: { refreshed: 0 },
    held: { livePromise: 0 },
    deferred: { ringRiskCap: 0 },
    written: 0,
    keyed: { registry: 0, other: 0, none: 0 },
    ringRisk: { cap: RING_RISK_CAP, couldRingAgain: 0, ringsWithoutNewEvent: 0, emitters: {} },
    batches: 0,
  };
}

function tally(summary, row, judged, risk) {
  bump(summary.expire.byRule, judged.rule);
  bump(summary.expire.byCategory, row.category || 'unknown');
  summary.expire.total += 1;
  if (!row.read_at) summary.expire.unread += 1;
  const key = String(parseMeta(row.metadata).dedupeKey || '');
  if (risk) summary.keyed.registry += 1; else if (key) summary.keyed.other += 1; else summary.keyed.none += 1;
  if (!risk) return;
  const e = emitterStats(summary, risk);
  e.expire += 1;
  e.couldRingAgain += 1;
  summary.ringRisk.couldRingAgain += 1;
  if (risk.kind === 'periodic') { e.ringsWithoutNewEvent += 1; summary.ringRisk.ringsWithoutNewEvent += 1; }
}

const emitterStats = (summary, risk) => (summary.ringRisk.emitters[risk.emitter] ||= {
  kind: risk.kind, decision: risk.decision, expire: 0, couldRingAgain: 0, ringsWithoutNewEvent: 0, held: 0, deferred: 0,
});

// Judge one page: tally the summary and return the rows to write, by rule.
async function planPage({ rows, now, summary, io, ringRiskCap, state }) {
  const due = [];
  for (const row of rows) {
    const judged = judgeRow(row, now);
    if (!judged.expire) { if (judged.reason === 'refreshed') summary.kept.refreshed += 1; continue; }
    due.push({ row, judged, risk: ringRiskFor(row) });
  }
  // Live checks, one query per check per page.
  const liveIds = new Set();
  for (const name of new Set(due.map((d) => d.risk?.live).filter(Boolean))) {
    const subset = due.filter((d) => d.risk?.live === name).map((d) => d.row);
    for (const id of await io.live(name, subset)) liveIds.add(id);
  }
  const toWrite = { age30: [], fyi7: [] };
  for (const { row, judged, risk } of due) {
    if (risk?.live && liveIds.has(row.id)) {
      summary.held.livePromise += 1;
      emitterStats(summary, risk).held += 1;
      continue;
    }
    if (risk?.kind === 'periodic') {
      if (state.periodicExpired >= ringRiskCap) {
        summary.deferred.ringRiskCap += 1;
        emitterStats(summary, risk).deferred += 1;
        continue;
      }
      state.periodicExpired += 1;
    }
    tally(summary, row, judged, risk);
    toWrite[judged.rule].push(row);
  }
  return toWrite;
}

// `scope` (tests only): a function that narrows the candidate query to a fixture's rows.
const defaultIo = (conn, scope = null) => ({
  page: (args) => loadPage(conn, { ...args, scope }),
  live: (name, rows) => LIVE_CHECKS[name](conn, rows),
  expire: (rows, rule, ctx) => expireBatch(conn, rows, rule, ctx),
  activityBacklog: (now) => countActivityOnlyBacklog(conn, now),
  loadCursor: (mode) => readCursor(conn, mode),
  saveCursor: (mode, cursor) => writeCursor(conn, mode, cursor),
  record: recordSummary,
});

async function writePage(io, toWrite, ctx) {
  let written = 0;
  for (const rule of Object.keys(toWrite)) {
    if (toWrite[rule].length) written += await io.expire(toWrite[rule], rule, ctx);
  }
  return written;
}

function logSummary(summary) {
  const { mode, expire, kept, held, deferred } = summary;
  const result = mode === 'true' ? `expired ${summary.written} of ${expire.total}` : `would expire ${expire.total}`;
  logger.info(`[alert-retention] ${mode}: scanned ${summary.scanned}, ${result} (age30 ${expire.byRule.age30 || 0}, fyi7 ${expire.byRule.fyi7 || 0}), kept refreshed ${kept.refreshed}, held ${held.livePromise}, deferred ${deferred.ringRiskCap}`);
}

/**
 * One sweep. Returns the summary, or { skipped: true, reason: 'gate_off' }.
 * `io` swaps the database edges (unit tests).
 */
async function runAdminAlertRetention({
  now = new Date(), mode = alertRetentionMode(), conn = db, scope = null, io = defaultIo(conn, scope),
  batchSize = BATCH_SIZE, maxBatches = MAX_BATCHES, ringRiskCap = RING_RISK_CAP,
} = {}) {
  if (mode !== 'shadow' && mode !== 'true') return { skipped: true, reason: 'gate_off' };
  const runId = now.toISOString();
  const summary = newSummary({ mode, runId, now });
  summary.ringRisk.cap = ringRiskCap;
  const state = { periodicExpired: 0 };
  let cursor = await io.loadCursor(mode);
  summary.resumedFrom = cursor ? cursor.id : null;
  let reachedEnd = false;

  for (let batch = 0; batch < maxBatches; batch += 1) {
    const rows = await io.page({ now, cursor, limit: batchSize });
    if (!rows.length) { reachedEnd = true; break; }
    summary.batches += 1;
    summary.scanned += rows.length;
    const last = rows[rows.length - 1];
    cursor = { at: last.created_at_cursor, id: last.id };
    reachedEnd = rows.length < batchSize;

    const toWrite = await planPage({ rows, now, summary, io, ringRiskCap, state });

    if (mode === 'true') summary.written += await writePage(io, toWrite, { runId, now });
  }

  // Budget used up with rows left: resume there next run. Reached the end: start over.
  await io.saveCursor(mode, reachedEnd ? null : cursor);
  summary.cursor = reachedEnd ? 'reset' : 'saved';
  if (mode === 'shadow') summary.activityOnlyOpenOlderThan30 = await io.activityBacklog(now);
  logSummary(summary);
  await io.record(summary);
  return summary;
}

// ---------------------------------------------------------------------------
// Undo: reopen the rows one run expired. Fenced on done_by 'retention' and the
// run stamp, so a row a later closer took (episodes, a person) is left alone.
// Read state was never touched, so clearing the done fields restores the row.
// ---------------------------------------------------------------------------

async function listRetentionRuns(conn = db) {
  const rows = await conn('notifications')
    .where({ recipient_type: 'admin', done_by: RETENTION_BY })
    .whereRaw(`metadata->'${STAMP_KEY}'->>'run' IS NOT NULL`)
    .groupByRaw(`metadata->'${STAMP_KEY}'->>'run'`)
    .select(conn.raw(`metadata->'${STAMP_KEY}'->>'run' AS run`), conn.raw('count(*)::int AS rows'))
    .orderBy('run', 'desc');
  return rows.map((r) => ({ run: r.run, rows: Number(r.rows) }));
}

async function undoRetentionRun({ run, execute = false, conn = db, now = new Date(), batchSize = BATCH_SIZE } = {}) {
  if (!run || typeof run !== 'string') throw new Error('undoRetentionRun needs a run');
  const { DONE_CLEARED } = require('./notification-service')._private;
  const match = () => conn('notifications')
    .where({ recipient_type: 'admin', done_by: RETENTION_BY })
    .whereNotNull('done_at')
    .whereRaw(`metadata->'${STAMP_KEY}'->>'run' = ?`, [run]);
  const found = Number((await match().count('* as count').first())?.count) || 0;
  if (!execute) return { run, found, reopened: 0, execute: false };
  const trail = JSON.stringify({ [UNDONE_KEY]: { run, at: now.toISOString() } });
  let reopened = 0;
  for (;;) {
    const ids = await match().orderBy('id').limit(batchSize).pluck('id');
    if (!ids.length) break;
    const n = await conn.transaction(async (trx) => {
      await trx.raw(`SET LOCAL lock_timeout = '${LOCK_TIMEOUT_MS}ms'`);
      return trx('notifications')
        .whereIn('id', ids)
        .where({ recipient_type: 'admin', done_by: RETENTION_BY })
        .whereNotNull('done_at')
        .whereRaw(`metadata->'${STAMP_KEY}'->>'run' = ?`, [run])
        .update({ ...DONE_CLEARED, metadata: trx.raw(`(COALESCE(metadata, '{}'::jsonb) - '${STAMP_KEY}') || ?::jsonb`, [trail]) });
    });
    reopened += n;
    if (!n) break;
  }
  return { run, found, reopened, execute: true };
}

module.exports = {
  runAdminAlertRetention,
  undoRetentionRun,
  listRetentionRuns,
  judgeRow,
  lastActivityMs,
  ringRiskFor,
  expireBatch,
  loadPage,
  RERING,
  RESOLUTIONS,
  RETENTION_BY,
  STAMP_KEY,
  AGE_DAYS,
  FYI_DAYS,
  BATCH_SIZE,
  RING_RISK_CAP,
};
