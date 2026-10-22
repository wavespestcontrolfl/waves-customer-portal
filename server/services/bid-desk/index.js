'use strict';

/**
 * Bid Desk intake (GATE_BID_DESK, dark; PR 1). Files bid invites found in the `emails` table as bid_opportunities.
 *
 *   runBidDeskTick()      every 15 minutes: new emails since a stored watermark -> ingestEmail, then reminders
 *   runBackfill()         one-time, last 180 days; rows are `historical` (listed, never notified, never reminded)
 *   markEmailAsBid()      an operator marks one email as a bid by hand (source 'manual')
 *   ingestEmail()         detect, parse, group by thread else sender org + project title, attach or create
 *   sendDueReminders()    7 and 2 days before a due date the operator CONFIRMED; each fires once
 *
 * No AI call, no change to leads or to the email classifier, and nothing is ever sent to a buyer or a contractor:
 * the only output is a row here and an admin notification. Inert unless bidDeskLive().
 */
const db = require('../../models/db');
const logger = require('../logger');
const { bidDeskLive } = require('../../config/feature-gates');
const { detectBidEmail, parseBidEmail, classifyKind } = require('./detector');
const { attachPatch, reminderDue, OPEN_STATUSES } = require('./rules');
const alerts = require('./alerts');
const { hasAlignedAuth } = require('../email/inbox-hygiene');
const { domainFromAddress } = require('../email/spam-blocker');

// The email with `provider_verified` set: aligned SPF or DKIM for its own From domain in the stored
// Authentication-Results (the same check the receipts sweep and spam rescue use). The detector trusts a provider
// template only when this is true.
function withProviderCheck(email) {
  return { ...email, provider_verified: hasAlignedAuth(email.authentication_results, domainFromAddress(email.from_address)) };
}

const LOG = '[bid-desk]';
const WATERMARK_KEY = 'bid_desk.watermark';
const BATCH_LIMIT = 200;
const BACKFILL_DAYS = 180;
const BACKFILL_BATCH = 500;
const FIRST_RUN_LOOKBACK_MS = 60 * 60 * 1000;
const MAX_ATTEMPTS = 3;
const REMINDER_LIMIT = 100;
const RECHECK_WINDOW_MS = 30 * 60 * 1000;
// Pages of `limit` rows the late pass may read per tick (bounds one tick; 30 minutes of mail is far below it).
const LATE_MAX_PAGES = 10;
// The sync stores a row first and classifies it a moment later (spam is marked then). A row that is still
// unclassified is held this long before it can be filed, so spam is not filed (and rung) before the classifier
// sees it. After that it is filed anyway (a classifier outage must not stop the desk); the Gmail SPAM label still
// applies, and an owed bell re-checks the classification before it rings.
const CLASSIFY_SETTLE_MS = 10 * 60 * 1000;
const UNSETTLED = new Set(['', 'vendor']);
function unsettled(email, now) {
  return UNSETTLED.has(String(email.classification || '')) && new Date(email.cursor_at).getTime() > now.getTime() - CLASSIFY_SETTLE_MS;
}
const EMAIL_COLUMNS = ['id', 'gmail_thread_id', 'from_address', 'from_name', 'subject', 'body_text', 'body_html', 'received_at', 'classification', 'label_ids', 'authentication_results'];

// Mail the sync stored as spam (a blocked sender, Gmail's SPAM label) never becomes a bid or a bell.
const NOT_SPAM_SQL = "COALESCE(classification, '') <> 'spam' AND NOT jsonb_exists(COALESCE(label_ids, '[]'::jsonb), 'SPAM')";
const NOT_SPAM_SQL_E = NOT_SPAM_SQL.replace(/classification/g, 'e.classification').replace(/label_ids/g, 'e.label_ids');
function isSpam(email) {
  if (String(email.classification || '') === 'spam') return true;
  let labels = email.label_ids;
  if (typeof labels === 'string') { try { labels = JSON.parse(labels); } catch { labels = []; } }
  return Array.isArray(labels) && labels.includes('SPAM');
}

const BID_COLUMNS = [
  'id', 'source', 'buyer_name', 'buyer_email', 'gc_or_agency', 'project_title', 'package_name', 'solicitation_number', 'location',
  'due_at', 'due_source_line', 'due_confirmed', 'job_walk_at', 'questions_due_at', 'status', 'decision_note',
  'historical', 'needs_date_confirmation', 'first_email_id', 'gmail_thread_id', 'created_at', 'updated_at',
];

// ---------- one email ----------

async function findBid(trx, email, groupKey, groupBase = null) {
  const thread = email.gmail_thread_id;
  if (thread) {
    const byThread = await trx('bid_opportunities')
      .where({ gmail_thread_id: thread })
      .orWhereIn('id', trx('bid_opportunity_emails as l').join('emails as e', 'e.id', 'l.email_id')
        .where('e.gmail_thread_id', thread).select('l.bid_id'))
      .orderBy('created_at').first();
    if (byThread) return byThread;
  }
  if (!groupKey) return null;
  // Only OPEN bids group by key: a GC's new solicitation with the same project and package after the old one was
  // decided is new work. (A reply in the bid's own thread above still joins it.)
  const exact = await trx('bid_opportunities').where({ group_key: groupKey }).whereIn('status', OPEN_STATUSES)
    .orderBy('created_at').first();
  if (exact || !groupBase || groupKey !== groupBase) return exact || null;
  // No package named: join the project's bid only when there is exactly one.
  const candidates = await trx('bid_opportunities').whereIn('status', OPEN_STATUSES)
    .where((q) => q.where({ group_key: groupBase }).orWhere('group_key', 'like', `${groupBase.replace(/[\\%_]/g, '\\$&')}#%`))
    .orderBy('created_at').limit(2);
  return candidates.length === 1 ? candidates[0] : null;
}

/**
 * Files one stored email. Idempotent (an email already linked is skipped). `manual` skips detection and rings no bell.
 * @returns {Promise<{ skipped?: string, bidId?: string, created?: boolean, kind?: string }>}
 */
// A later email in a thread that already belongs to a bid joins it even with no bid words ("Reminder: <project>",
// a GC's follow-up). Our own mail and internal ops mail never do.
const THREAD_JOIN_REASONS = new Set(['not_bid', 'provider_not_bid']);
async function detectWithThread(email) {
  const detected = detectBidEmail(email);
  if (detected.bid || !THREAD_JOIN_REASONS.has(detected.reason) || !email.gmail_thread_id) return detected;
  const inThread = await findBid(db, email, null);
  return inThread ? { bid: true, source: inThread.source, kind: classifyKind(email), reason: 'thread' } : detected;
}

async function ingestEmail(rawEmail, { historical = false, manual = false } = {}) {
  const email = withProviderCheck(rawEmail);
  // A person marking an email by hand is already looking at it, and the backfill files history: no bell for either.
  const quiet = manual || historical;
  if (!manual && isSpam(email)) return { skipped: 'spam' };
  const detected = manual ? { bid: true, source: 'manual' } : await detectWithThread(email);
  if (!detected.bid) return { skipped: detected.reason };
  const parsed = parseBidEmail(email);
  const kind = detected.reason === 'thread' ? detected.kind : parsed.kind;

  // Filing commits on its own. The notification is delivered after the commit (deliverOwedAlert), and an owed one
  // that fails is retried by every tick, so a bell outage never loses the bid record.
  const outcome = await db.transaction(async (trx) => {
    // One writer at a time: two emails of one thread must not both create the bid. Volume is a few a month.
    await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?))', ['bid-desk:ingest']);
    if (await trx('bid_opportunity_emails').where({ email_id: email.id }).first('id')) return { skipped: 'already_filed' };

    const found = await findBid(trx, email, parsed.group_key, parsed.group_base);
    // Re-read the bid under a row lock: an operator saving a date between the read and the update must not be
    // overwritten (the advisory lock only orders intake writers).
    const existing = found ? await trx('bid_opportunities').where({ id: found.id }).forUpdate().first() : null;
    if (existing) {
      // Current mail on a bid the backfill filed as history makes it live again: alerts and reminders apply.
      const promote = !historical && existing.historical;
      const live = promote ? { ...existing, historical: false } : existing;
      const { patch, notifyAddendum } = attachPatch(live, parsed, kind);
      if (promote) patch.historical = false;
      // A bid first filed from a plain email (no cross-thread key) takes the key of the first template email in it.
      if (!existing.group_key && parsed.group_key) patch.group_key = parsed.group_key;
      // The backfill attaching OLD mail to a live bid records it but changes no date state: an old invite or
      // addendum must not flag a live bid (and pause its reminders) without anyone being told.
      if (historical && !existing.historical) {
        delete patch.due_at;
        delete patch.due_source_line;
        delete patch.needs_date_confirmation;
      }
      const open = OPEN_STATUSES.includes(live.status);
      let alertKind = null;
      if (!quiet && notifyAddendum) alertKind = 'addendum';
      else if (!quiet && promote && open) alertKind = 'new';
      const [link] = await trx('bid_opportunity_emails')
        .insert({ bid_id: existing.id, email_id: email.id, kind, received_at: email.received_at, alert_kind: alertKind })
        .returning(['id']);
      // Every attached email moves the bid's version (updated_at), even with nothing else to change: a date
      // confirmation the page sends against the older version is then refused.
      // clock_timestamp(), not now(): the version must move even inside one long transaction.
      await trx('bid_opportunities').where({ id: existing.id }).update({ ...patch, updated_at: trx.raw('clock_timestamp()') });
      return { bidId: existing.id, created: false, kind, owedLinkId: alertKind ? link.id : null };
    }

    const [bid] = await trx('bid_opportunities').insert({
      source: detected.source,
      buyer_name: parsed.buyer_name,
      buyer_email: parsed.buyer_email,
      gc_or_agency: parsed.gc_or_agency,
      project_title: parsed.project_title,
      package_name: parsed.package_name,
      solicitation_number: parsed.solicitation_number,
      location: parsed.location,
      due_at: parsed.due_at,
      due_source_line: parsed.due_source_line,
      due_confirmed: false,
      job_walk_at: parsed.job_walk_at,
      questions_due_at: parsed.questions_due_at,
      status: 'new',
      historical,
      needs_date_confirmation: false,
      first_email_id: email.id,
      gmail_thread_id: email.gmail_thread_id || null,
      group_key: parsed.group_key,
    }).returning(BID_COLUMNS);
    const alertKind = quiet ? null : 'new';
    const [link] = await trx('bid_opportunity_emails')
      .insert({ bid_id: bid.id, email_id: email.id, kind, received_at: email.received_at, alert_kind: alertKind })
      .returning(['id']);
    return { bidId: bid.id, created: true, kind, owedLinkId: alertKind ? link.id : null };
  });

  if (outcome.owedLinkId) {
    try {
      await deliverOwedAlert(outcome.owedLinkId);
    } catch (err) {
      logger.error(`${LOG} bell for bid ${outcome.bidId} failed; the next tick retries it: ${safeError(err)}`);
    }
  }
  const { owedLinkId: _owed, ...result } = outcome;
  return result;
}

// ---------- owed notifications ----------

/**
 * Rings the notification owed for one filed email, at most once. A bid that is no longer open (decided while the
 * bell was down) or was filed as history is marked delivered without ringing.
 */
async function deliverOwedAlert(linkId) {
  return db.transaction(async (trx) => {
    const link = await trx('bid_opportunity_emails').where({ id: linkId }).forUpdate().first();
    if (!link || !link.alert_kind || link.alerted_at) return false;
    const bid = await trx('bid_opportunities').where({ id: link.bid_id }).forUpdate().first();
    const email = await trx('emails').where({ id: link.email_id }).first(['id', 'subject', 'from_name', 'from_address', 'classification', 'label_ids']);
    // Moot: the bid is gone, history or closed, or the bell's own job is already done (a new-bid bell after the
    // decision; an addendum bell after the date was confirmed).
    const moot = !bid || bid.historical || !OPEN_STATUSES.includes(bid.status) || !email || isSpam(email)
      || (link.alert_kind === 'new' && bid.status !== 'new')
      || (link.alert_kind === 'addendum' && !bid.needs_date_confirmation);
    if (!moot) {
      if (link.alert_kind === 'new') {
        await alerts.raise(alerts.newBidSpec(bid, email), `bid-desk:new:${bid.id}`, trx);
        await trx('bid_opportunities').where({ id: bid.id }).update({ notified_at: trx.fn.now() });
      } else {
        await alerts.raise(alerts.addendumSpec(bid, email), `bid-desk:addendum:${bid.id}:${link.email_id}`, trx);
      }
    }
    await trx('bid_opportunity_emails').where({ id: linkId }).update({ alerted_at: trx.fn.now() });
    return !moot;
  });
}

async function deliverOwedAlerts({ limit = REMINDER_LIMIT } = {}) {
  const owed = await db('bid_opportunity_emails').whereNotNull('alert_kind').whereNull('alerted_at')
    .orderBy('created_at').limit(limit).select('id');
  let rung = 0;
  for (const { id } of owed) {
    try {
      if (await deliverOwedAlert(id)) rung += 1;
    } catch (err) {
      logger.error(`${LOG} owed bell ${id} still failing: ${safeError(err)}`);
    }
  }
  return rung;
}

// A database or provider error can carry row values; the log keeps its class and code only.
function safeError(err) {
  const name = err?.name || 'Error';
  const code = err?.code ? ` ${err.code}` : '';
  return `${name}${code}`;
}

// ---------- the 15-minute job ----------

async function readWatermark(conn = db) {
  const row = await conn('system_settings').where({ key: WATERMARK_KEY }).first('value');
  try {
    const parsed = row?.value ? JSON.parse(row.value) : null;
    return parsed && parsed.at ? parsed : null;
  } catch {
    return null;
  }
}

async function writeWatermark(state, conn = db) {
  const value = JSON.stringify(state);
  await conn('system_settings').insert({ key: WATERMARK_KEY, value, category: 'bid_desk', description: 'Bid Desk intake: last email filed' })
    .onConflict('key').merge({ value, updated_at: conn.fn.now() });
}

/**
 * Reads a bounded batch of emails newer than the watermark, files the ones that are bids, then sends due reminders.
 * An email that keeps failing blocks the batch for MAX_ATTEMPTS ticks and is then skipped, so one bad row cannot
 * stop the desk for good.
 */
// Files one email and counts it. Throws what ingestEmail throws.
async function fileAndCount(email, result) {
  const outcome = await ingestEmail(email);
  if (outcome.bidId) result.filed += 1;
  if (outcome.created) result.created += 1;
}

// The main pass: mail newer than the cursor, in insert order. The cursor is the row's INSERT time (created_at),
// not Gmail's receive time: a sync retry or a newest-first recovery can store an older message after newer ones.
// It keeps PostgreSQL's microseconds (a JS Date would cut them and re-read the last row). An email that keeps
// failing blocks the batch for MAX_ATTEMPTS ticks and is then passed.
async function mainPass(state, limit, result, now) {
  const rows = await db('emails')
    .whereRaw('(created_at, id) > (?::timestamptz, ?::uuid)', [state.at, state.id])
    .whereRaw(NOT_SPAM_SQL)
    .orderBy([{ column: 'created_at' }, { column: 'id' }])
    .limit(limit)
    .select([...EMAIL_COLUMNS, db.raw('created_at::text AS cursor_at')]);
  result.read = rows.length;
  let next = state;
  for (const email of rows) {
    // Not classified yet: stop here and pick it up on a later tick (the cursor does not pass it).
    if (unsettled(email, now)) return { state: next, rows };
    const failure = await fileAndCount(email, result).then(() => null, (err) => err);
    const attempts = failure && next.retry?.id === email.id ? next.retry.count + 1 : 1;
    if (failure) {
      logger.error(`${LOG} email ${email.id} failed (attempt ${attempts}): ${safeError(failure)}`);
      result.failed += 1;
    }
    if (failure && attempts < MAX_ATTEMPTS) return { state: { ...next, retry: { id: email.id, count: attempts } }, rows };
    next = { at: email.cursor_at, id: email.id };
  }
  return { state: next, rows };
}

// Concurrent inserts can commit out of created_at order. Re-read the last RECHECK_WINDOW behind the cursor for rows
// not yet filed; ingestEmail is idempotent, so a row seen twice is skipped. The pass pages through the whole
// window, so non-bid mail (never filed, so never excluded) cannot hold a late bid row past the limit.
async function latePass(state, limit, result, now) {
  let cursor = null;
  for (let page = 0; page < LATE_MAX_PAGES; page += 1) {
    const late = await db('emails as e')
      .whereRaw('e.created_at > ?::timestamptz - make_interval(secs => ?)', [state.at, RECHECK_WINDOW_MS / 1000])
      .whereRaw('e.created_at <= ?::timestamptz', [state.at])
      .modify((q) => { if (cursor) q.whereRaw('(e.created_at, e.id) > (?::timestamptz, ?::uuid)', [cursor.at, cursor.id]); })
      .whereNotExists(db('bid_opportunity_emails as l').whereRaw('l.email_id = e.id'))
      .whereRaw(NOT_SPAM_SQL_E)
      .orderBy([{ column: 'e.created_at' }, { column: 'e.id' }])
      .limit(limit)
      .select([...EMAIL_COLUMNS.map((c) => `e.${c}`), db.raw('e.created_at::text AS cursor_at')]);
    for (const email of late.filter((row) => !unsettled(row, now))) {
      await fileAndCount(email, result).catch((err) => logger.error(`${LOG} late email ${email.id} failed: ${safeError(err)}`));
    }
    if (late.length < limit) return;
    cursor = { at: late[late.length - 1].cursor_at, id: late[late.length - 1].id };
  }
}

async function runBidDeskTick({ now = new Date(), limit = BATCH_LIMIT } = {}) {
  if (!bidDeskLive()) return { skipped: 'gate_off' };
  const stored = await readWatermark();
  // First run: start an hour back (the backfill covers history). Nothing older is notified as new.
  const start = stored || { at: new Date(now.getTime() - FIRST_RUN_LOOKBACK_MS).toISOString(), id: '00000000-0000-0000-0000-000000000000' };
  const result = { read: 0, filed: 0, created: 0, failed: 0 };
  const { state, rows } = await mainPass(start, limit, result, now);
  await latePass(state, limit, result, now);
  if (rows.length || !stored) await writeWatermark(state);
  result.owedAlerts = await deliverOwedAlerts();
  result.reminders = await sendDueReminders({ now });
  return result;
}

// ---------- reminders ----------

/** One reminder per bid per window, only for a confirmed due date on an open, non-historical bid. */
async function sendDueReminders({ now = new Date() } = {}) {
  if (!bidDeskLive()) return 0;
  const horizon = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
  const twoDays = new Date(now.getTime() + 2 * 24 * 60 * 60 * 1000);
  const candidates = await db('bid_opportunities')
    // A date waiting on an addendum check is not reminded until it is confirmed again.
    .where({ due_confirmed: true, historical: false, needs_date_confirmation: false })
    .whereIn('status', ['new', 'bid'])
    .where('due_at', '>', now).where('due_at', '<=', horizon)
    // Only bids still owed a window, so already-reminded rows cannot fill the limit and starve later ones.
    .where((q) => q.where((w) => w.whereNull('reminder_2d_sent_at').where('due_at', '<=', twoDays))
      .orWhere((w) => w.whereNull('reminder_7d_sent_at').where('due_at', '>', twoDays)))
    .orderBy('due_at').limit(REMINDER_LIMIT).select('id');
  let sent = 0;
  for (const { id } of candidates) {
    try {
      const done = await db.transaction(async (trx) => {
        // Re-read under a row lock: a double tick or a status change between the list and here sends nothing.
        const bid = await trx('bid_opportunities').where({ id }).forUpdate().first();
        const window = reminderDue(bid, now);
        if (!window) return false;
        // The due date is in the key: a changed date (PATCH clears the stamps) gets its own reminders.
        await alerts.raiseReopening(alerts.reminderSpec(bid, window, now), `bid-desk:remind:${bid.id}:${window}:${new Date(bid.due_at).toISOString()}`, trx);
        // Inside 2 days the 7-day reminder is moot: stamp both so it can never fire late.
        await trx('bid_opportunities').where({ id }).update({
          reminder_2d_sent_at: window === '2d' ? trx.fn.now() : bid.reminder_2d_sent_at,
          reminder_7d_sent_at: bid.reminder_7d_sent_at || trx.fn.now(),
          updated_at: trx.fn.now(),
        });
        return true;
      });
      if (done) sent += 1;
    } catch (err) {
      logger.error(`${LOG} reminder for bid ${id} failed: ${safeError(err)}`);
    }
  }
  return sent;
}

// ---------- backfill and manual ----------

/**
 * Files the last `days` days of mail as historical rows, oldest first. `dryRun` counts and writes nothing.
 * Never notifies. Safe to re-run: filed emails are skipped.
 */
async function backfillOne(email, { dryRun, previewThreads, result }) {
  const detected = await detectWithThread(withProviderCheck(email));
  const thread = email.gmail_thread_id;
  const previewJoin = dryRun && !detected.bid && THREAD_JOIN_REASONS.has(detected.reason) && thread && previewThreads.has(thread);
  if (!detected.bid && !previewJoin) return;
  result.matched += 1;
  if (dryRun) {
    if (thread) previewThreads.add(thread);
    return;
  }
  try {
    const outcome = await ingestEmail(email, { historical: true });
    if (outcome.created) result.created += 1;
    else if (outcome.bidId) result.attached += 1;
  } catch (err) {
    result.failed += 1;
    logger.error(`${LOG} backfill email ${email.id} failed: ${safeError(err)}`);
  }
}

/**
 * Files the last `days` of mail as history. It stops where the live intake starts: the stored cursor, or (before
 * the first tick) an hour back, and then writes that cursor so the first tick starts exactly where the backfill
 * stopped. Recent mail is therefore always filed live (with its bell), never as history.
 */
async function runBackfill({ days = BACKFILL_DAYS, dryRun = true, now = new Date() } = {}) {
  if (!bidDeskLive()) return { skipped: 'gate_off' };
  const since = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
  const stored = await readWatermark();
  // The live intake owns everything AFTER this (created_at, id) point; the backfill takes it and everything before.
  // The id matters: several rows can share one created_at, and the cursor may stop between them.
  const until = stored
    ? { at: stored.at, id: stored.id }
    : { at: new Date(now.getTime() - FIRST_RUN_LOOKBACK_MS).toISOString(), id: '00000000-0000-0000-0000-000000000000' };
  const result = { read: 0, matched: 0, created: 0, attached: 0, failed: 0 };
  // The dry run files nothing, so a later email that would join an earlier match by thread is counted here.
  const previewThreads = new Set();
  let cursor = { at: since.toISOString(), id: '00000000-0000-0000-0000-000000000000' };
  for (;;) {
    const rows = await db('emails')
      .whereRaw('(received_at, id) > (?::timestamptz, ?::uuid)', [cursor.at, cursor.id])
      .whereRaw('(created_at, id) <= (?::timestamptz, ?::uuid)', [until.at, until.id])
      .whereRaw(NOT_SPAM_SQL)
      .orderBy([{ column: 'received_at' }, { column: 'id' }])
      .limit(BACKFILL_BATCH).select(EMAIL_COLUMNS);
    if (!rows.length) break;
    for (const email of rows) {
      result.read += 1;
      cursor = { at: new Date(email.received_at).toISOString(), id: email.id };
      await backfillOne(email, { dryRun, previewThreads, result });
    }
  }
  if (!dryRun && !stored) await writeWatermark(until);
  return result;
}

/** The operator marks one stored email as a bid. It joins the bid of its thread when there is one. */
async function markEmailAsBid(emailId) {
  const email = await db('emails').where({ id: emailId }).first(EMAIL_COLUMNS);
  if (!email) return { error: 'email_not_found' };
  const outcome = await ingestEmail(email, { manual: true });
  if (outcome.skipped === 'already_filed') {
    const link = await db('bid_opportunity_emails').where({ email_id: emailId }).first('bid_id');
    return { bidId: link?.bid_id, created: false, alreadyFiled: true };
  }
  return outcome;
}

module.exports = {
  ingestEmail, runBidDeskTick, sendDueReminders, deliverOwedAlerts, runBackfill, markEmailAsBid, BID_COLUMNS, EMAIL_COLUMNS, WATERMARK_KEY,
};
