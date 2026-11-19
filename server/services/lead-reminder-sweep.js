/**
 * The steps the two lead reminders share (lead-call-reminder.js, new-lead-reminder.js). Each reminder keeps its own
 * rules: which bells, the due time, the business-hours rule, what counts as "reached", the stamp key and the push
 * text. This file holds only the common mechanism: the paged, keyset-ordered read of open bell rows; the cursor that
 * carries a capped scan across sweeps; the once-only stamp; the open-row recheck; and the admin-only push.
 *
 * Capped scans resume. A bell that is reached, expired or names no lead is never stamped, so it matches the query on
 * every sweep. Without a saved cursor, MAX_PAGES x PAGE_SIZE such rows at the front would hide every later bell until
 * they aged out, possibly past its send deadline. So a sweep that hits the page cap remembers where it stopped and the
 * next sweep starts there, the way the parent relevance sweep does (admin-alert-relevance.js resumeAfter, a module
 * variable: a restart starts from the oldest row again). A sweep that reaches the end of the rows starts over.
 * Nothing here row-locks a bell or a lead.
 */

const db = require('../models/db');
const logger = require('./logger');

const TRIGGER_KEY = 'lead_call_reminder';
const PAGE_SIZE = 100;
// Pages read per sweep: 500 open candidates is far past a busy day. The next sweep reads the rest.
const MAX_PAGES = 5;

// Where each reminder's capped scan stopped, by stamp key. In memory, like the parent sweep's cursor.
const resumeAfter = new Map();

const safeError = (err) => require('./notification-service').safeErrorSummary(err);

// Open, unstamped bell rows of `kind` ({ category, stamp, keyPrefixes? }) whose latest event is after `since`, one keyset
// page after `cursor` ({ createdAt, id }; createdAt as the database's own text, so no microsecond is lost). A refreshed
// bell keeps its first created_at and carries its latest ring in metadata.rungAt, so either may be recent. With
// `keyPrefixes`, only rows whose dedupeKey starts with one of them (plain text: no LIKE wildcard in any).
function candidateQuery({ category, stamp, keyPrefixes = null }, since, cursor, pageSize) {
  const { excludeActivityOnlyFromBell } = require('./notification-service')._private;
  return excludeActivityOnlyFromBell(db('notifications').where({ recipient_type: 'admin', category }))
    .whereNull('done_at')
    .whereRaw("metadata->'retired' IS NULL")
    .whereRaw(`metadata->>'${stamp}' IS NULL`)
    .where((q) => q.where('created_at', '>', since).orWhereRaw("metadata->>'rungAt' > ?", [since.toISOString()]))
    .modify((q) => {
      if (!keyPrefixes) return;
      q.where((k) => { for (const prefix of keyPrefixes) k.orWhereRaw("metadata->>'dedupeKey' LIKE ?", [`${prefix}%`]); });
    })
    .modify((q) => { if (cursor) q.whereRaw('(created_at, id) > (?::timestamptz, ?::uuid)', [cursor.createdAt, cursor.id]); })
    .orderBy([{ column: 'created_at', order: 'asc' }, { column: 'id', order: 'asc' }])
    .limit(pageSize)
    .select('id', 'title', 'body', 'link', 'metadata', 'created_at', db.raw('created_at::text AS created_at_token'));
}

// The one stamp: this row, still open and unchanged since it was read. Returns true when it landed.
async function stampOnce(stamp, { row, meta }, now) {
  const landed = await db('notifications')
    .where({ id: row.id, recipient_type: 'admin' })
    .whereNull('done_at')
    .whereRaw('metadata IS NOT DISTINCT FROM ?::jsonb', [JSON.stringify(meta)])
    .update({ metadata: db.raw("COALESCE(metadata, '{}'::jsonb) || ?::jsonb", [JSON.stringify({ [stamp]: now.toISOString() })]) });
  return Number(landed) === 1;
}

// Still open just before the push goes. A lookup that fails reads as closed: no push (the bell row stays).
async function rowStillOpen(id, label) {
  try {
    const stored = await db('notifications').where({ id, recipient_type: 'admin' }).first('done_at');
    return !!stored && !stored.done_at;
  } catch (err) {
    logger.warn(`[${label}] open check failed for notification ${id}: ${safeError(err)}`);
    return false;
  }
}

// The push, with the row's own words. alertRowId gives it its own push tag per bell row. `ready` (optional) is asked once
// more just before dispatch, with a fresh clock: false means the reminder's hours have closed since the sweep began.
// Never throws.
async function sendPush({ row, customerId }, label, ready = () => true) {
  try {
    const { triggerNotification } = require('./notification-triggers');
    return await triggerNotification(TRIGGER_KEY, {
      alertRowId: row.id, alertTitle: row.title, alertBody: row.body || null, alertLink: row.link || null,
      ...(customerId ? { customerId } : {}),
    }, {
      // bellAuthorized: the bell row's writer rang it (bell: true), so the push keeps that answer. pushOnly: the row is
      // not rewritten. adminOnly: nothing goes to a lead, a customer or a technician.
      pushOnly: true, adminOnly: true, bellAuthorized: true,
      beforePush: async () => ready() && rowStillOpen(row.id, label),
    });
  } catch (err) {
    logger.warn(`[${label}] push failed for notification ${row.id}: ${safeError(err)}`);
    return null;
  }
}

/**
 * One scan for a reminder `kind`: { label, category, stamp, keyPrefixes?, windowMs, dueItems(rows, now),
 * waiting(items), inHours?(date) }. dueItems picks the rows due now; waiting(items) returns those that still wait on a
 * person and throws when a read fails (no verdict: nothing is sent on that page). `inHours(date)` is the reminder's own
 * hours rule, asked with a fresh clock (`clock`, default the real time) before each item is stamped and again just before
 * each push goes: the parent sweep's `now` can be old by the time its closes and the reads above have finished. When the
 * hours have closed the sweep stops with the rest unstamped, for the next open sweep while they are still inside their
 * late window. Returns { due, sent, sends }; `sends` are the
 * pushes, never awaited here. Throws only when a page cannot be read.
 */
async function runSweep(kind, { now, pageSize = PAGE_SIZE, clock = () => new Date() }) {
  const { label, stamp } = kind;
  const since = new Date(now.getTime() - kind.windowMs);
  const total = { due: 0, sent: 0 };
  const ready = () => !kind.inHours || kind.inHours(clock());
  const sends = [];
  let cursor = resumeAfter.get(stamp) || null;
  resumeAfter.delete(stamp);
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const rows = await candidateQuery(kind, since, cursor, pageSize);
    if (!rows.length) break;
    const last = rows[rows.length - 1];
    cursor = { createdAt: last.created_at_token, id: last.id };
    const due = kind.dueItems(rows, now);
    total.due += due.length;
    let waiting = [];
    try {
      waiting = await kind.waiting(due);
    } catch (err) {
      logger.warn(`[${label}] contact witnesses failed to load, nothing sent on this page: ${safeError(err)}`);
    }
    for (const item of waiting) {
      if (!ready()) {
        logger.info(`[${label}] hours closed while the sweep ran: the rest waits for the next open sweep`);
        return { ...total, sends };
      }
      try {
        if (!(await stampOnce(stamp, item, now))) continue;
        total.sent += 1;
        sends.push(sendPush(item, label, ready));
      } catch (err) {
        logger.warn(`[${label}] notification ${item.row.id} not stamped: ${safeError(err)}`);
      }
    }
    if (rows.length < pageSize) break;
    if (page === MAX_PAGES - 1) {
      resumeAfter.set(stamp, cursor);
      logger.warn(`[${label}] stopped after ${MAX_PAGES} pages; the next sweep resumes after them`);
    }
  }
  return { ...total, sends };
}

module.exports = { runSweep, TRIGGER_KEY, __private: { candidateQuery, stampOnce, rowStillOpen, sendPush, resumeAfter, PAGE_SIZE, MAX_PAGES } };
