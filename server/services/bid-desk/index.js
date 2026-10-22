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
const { attachPatch, reminderDue } = require('./rules');
const alerts = require('./alerts');

const LOG = '[bid-desk]';
const WATERMARK_KEY = 'bid_desk.watermark';
const BATCH_LIMIT = 200;
const BACKFILL_DAYS = 180;
const BACKFILL_BATCH = 500;
const FIRST_RUN_LOOKBACK_MS = 60 * 60 * 1000;
const MAX_ATTEMPTS = 3;
const REMINDER_LIMIT = 100;
const EMAIL_COLUMNS = ['id', 'gmail_thread_id', 'from_address', 'from_name', 'subject', 'body_text', 'body_html', 'received_at'];

const BID_COLUMNS = [
  'id', 'source', 'buyer_name', 'buyer_email', 'gc_or_agency', 'project_title', 'package_name', 'solicitation_number', 'location',
  'due_at', 'due_source_line', 'due_confirmed', 'job_walk_at', 'questions_due_at', 'status', 'decision_note',
  'historical', 'needs_date_confirmation', 'first_email_id', 'gmail_thread_id', 'created_at', 'updated_at',
];

// ---------- one email ----------

async function findBid(trx, email, groupKey) {
  const thread = email.gmail_thread_id;
  if (thread) {
    const byThread = await trx('bid_opportunities')
      .where({ gmail_thread_id: thread })
      .orWhereIn('id', trx('bid_opportunity_emails as l').join('emails as e', 'e.id', 'l.email_id')
        .where('e.gmail_thread_id', thread).select('l.bid_id'))
      .orderBy('created_at').first();
    if (byThread) return byThread;
  }
  return groupKey ? trx('bid_opportunities').where({ group_key: groupKey }).orderBy('created_at').first() : null;
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

async function ingestEmail(email, { historical = false, manual = false } = {}) {
  // A person marking an email by hand is already looking at it: no bell for that.
  const quiet = manual;
  const detected = manual ? { bid: true, source: 'manual' } : await detectWithThread(email);
  if (!detected.bid) return { skipped: detected.reason };
  const parsed = parseBidEmail(email);
  const kind = detected.reason === 'thread' ? detected.kind : parsed.kind;

  return db.transaction(async (trx) => {
    // One writer at a time: two emails of one thread must not both create the bid. Volume is a few a month.
    await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?))', ['bid-desk:ingest']);
    if (await trx('bid_opportunity_emails').where({ email_id: email.id }).first('id')) return { skipped: 'already_filed' };

    const existing = await findBid(trx, email, parsed.group_key);
    if (existing) {
      const { patch, notifyAddendum } = attachPatch(existing, parsed, kind);
      await trx('bid_opportunity_emails').insert({ bid_id: existing.id, email_id: email.id, kind, received_at: email.received_at });
      const updated = { ...existing, ...patch };
      if (Object.keys(patch).length) await trx('bid_opportunities').where({ id: existing.id }).update({ ...patch, updated_at: trx.fn.now() });
      if (notifyAddendum && !quiet) await alerts.raise(alerts.addendumSpec(updated, email), `bid-desk:addendum:${email.id}`, trx);
      return { bidId: existing.id, created: false, kind };
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
    await trx('bid_opportunity_emails').insert({ bid_id: bid.id, email_id: email.id, kind, received_at: email.received_at });
    if (!historical && !quiet) {
      await alerts.raise(alerts.newBidSpec(bid, email), `bid-desk:new:${bid.id}`, trx);
      await trx('bid_opportunities').where({ id: bid.id }).update({ notified_at: trx.fn.now() });
    }
    return { bidId: bid.id, created: true, kind };
  });
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
async function runBidDeskTick({ now = new Date(), limit = BATCH_LIMIT } = {}) {
  if (!bidDeskLive()) return { skipped: 'gate_off' };
  let state = await readWatermark();
  const firstRun = !state;
  if (!state) {
    // First run: start an hour back (the backfill covers history). Nothing older is notified as new.
    state = { at: new Date(now.getTime() - FIRST_RUN_LOOKBACK_MS).toISOString(), id: '00000000-0000-0000-0000-000000000000' };
  }
  const rows = await db('emails')
    .whereRaw('(received_at, id) > (?::timestamptz, ?::uuid)', [state.at, state.id])
    .orderBy([{ column: 'received_at' }, { column: 'id' }])
    .limit(limit)
    .select(EMAIL_COLUMNS);
  const result = { read: rows.length, filed: 0, created: 0, failed: 0 };
  for (const email of rows) {
    try {
      const outcome = await ingestEmail(email);
      if (outcome.bidId) {
        result.filed += 1;
        if (outcome.created) result.created += 1;
      }
      state = { at: new Date(email.received_at).toISOString(), id: email.id };
    } catch (err) {
      const attempts = state.retry?.id === email.id ? state.retry.count + 1 : 1;
      logger.error(`${LOG} email ${email.id} failed (attempt ${attempts}): ${err.message}`);
      result.failed += 1;
      if (attempts < MAX_ATTEMPTS) {
        state = { ...state, retry: { id: email.id, count: attempts } };
        break;
      }
      state = { at: new Date(email.received_at).toISOString(), id: email.id };
    }
  }
  if (rows.length || firstRun) await writeWatermark(state);
  result.reminders = await sendDueReminders({ now });
  return result;
}

// ---------- reminders ----------

/** One reminder per bid per window, only for a confirmed due date on an open, non-historical bid. */
async function sendDueReminders({ now = new Date() } = {}) {
  if (!bidDeskLive()) return 0;
  const horizon = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
  const candidates = await db('bid_opportunities')
    .where({ due_confirmed: true, historical: false })
    .whereIn('status', ['new', 'bid'])
    .where('due_at', '>', now).where('due_at', '<=', horizon)
    .orderBy('due_at').limit(REMINDER_LIMIT).select('id');
  let sent = 0;
  for (const { id } of candidates) {
    try {
      const done = await db.transaction(async (trx) => {
        // Re-read under a row lock: a double tick or a status change between the list and here sends nothing.
        const bid = await trx('bid_opportunities').where({ id }).forUpdate().first();
        const window = reminderDue(bid, now);
        if (!window) return false;
        await alerts.raise(alerts.reminderSpec(bid, window), `bid-desk:remind:${bid.id}:${window}`, trx);
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
      logger.error(`${LOG} reminder for bid ${id} failed: ${err.message}`);
    }
  }
  return sent;
}

// ---------- backfill and manual ----------

/**
 * Files the last `days` days of mail as historical rows, oldest first. `dryRun` counts and writes nothing.
 * Never notifies. Safe to re-run: filed emails are skipped.
 */
async function runBackfill({ days = BACKFILL_DAYS, dryRun = true, now = new Date() } = {}) {
  if (!bidDeskLive()) return { skipped: 'gate_off' };
  const since = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
  const result = { read: 0, matched: 0, created: 0, attached: 0, failed: 0 };
  let cursor = { at: since.toISOString(), id: '00000000-0000-0000-0000-000000000000' };
  for (;;) {
    const rows = await db('emails')
      .whereRaw('(received_at, id) > (?::timestamptz, ?::uuid)', [cursor.at, cursor.id])
      .orderBy([{ column: 'received_at' }, { column: 'id' }])
      .limit(BACKFILL_BATCH).select(EMAIL_COLUMNS);
    if (!rows.length) break;
    for (const email of rows) {
      result.read += 1;
      cursor = { at: new Date(email.received_at).toISOString(), id: email.id };
      if (!(await detectWithThread(email)).bid) continue;
      result.matched += 1;
      if (dryRun) continue;
      try {
        const outcome = await ingestEmail(email, { historical: true });
        if (outcome.created) result.created += 1;
        else if (outcome.bidId) result.attached += 1;
      } catch (err) {
        result.failed += 1;
        logger.error(`${LOG} backfill email ${email.id} failed: ${err.message}`);
      }
    }
  }
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
  ingestEmail, runBidDeskTick, sendDueReminders, runBackfill, markEmailAsBid, BID_COLUMNS, EMAIL_COLUMNS, WATERMARK_KEY,
};
