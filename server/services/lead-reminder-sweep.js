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
 *
 * The stamp waits on notifyAdmin's advisory lock for the bell's dedupe key, the lock a refresh of that bell reads and
 * rewrites its metadata under; nothing here row-locks a bell or a lead. Just before a push goes, the row must still be
 * an open bell in the bell feed with exactly the metadata that was stamped: a bell that rang again, moved to Activity
 * or lost its stamp since then sends nothing. Before that read, the reminder judges the lead again with fresh reads (its
 * own `waiting`): a person who reached the lead, or a lead closed or quoted, since the page was read sends nothing. The
 * row read comes last, so a Done or a new ring during the lead's reads still stops the push.
 *
 * A reminder may cap its pushes per claim (the new-lead re-alert: one per lead, new-lead-reminder.js leadClaim): the
 * stamp then also takes an advisory lock on the claim's key, after the dedupe-key lock, and asks whether the claim is
 * taken, all in the stamp's transaction, so two sweeps that reach two bells of one lead never both push. Each push
 * carries an expiry (the reminder's close that day, or the item's late window, whichever is first), so a phone that
 * comes online later never shows a stale reminder.
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

// Open, unstamped bell rows of `kind` ({ stamp, match }) whose latest event is after `since`, one keyset page after
// `cursor` ({ createdAt, id }; createdAt as the database's own text, so no microsecond is lost). A refreshed bell keeps
// its first created_at and carries its latest ring in metadata.rungAt, so either may be recent. `match` lists the bells
// the reminder reads, each { categories, keyPrefixes? }: a row matches an entry when its category is one of
// `categories` and, with `keyPrefixes`, its dedupeKey starts with one of them (plain text: no LIKE wildcard in any).
function candidateQuery({ stamp, match }, since, cursor, pageSize) {
  return openBell(db('notifications'))
    .where((any) => {
      for (const { categories, keyPrefixes = null } of match) {
        any.orWhere((one) => {
          one.whereIn('category', categories);
          if (keyPrefixes) one.where((k) => { for (const prefix of keyPrefixes) k.orWhereRaw("metadata->>'dedupeKey' LIKE ?", [`${prefix}%`]); });
        });
      }
    })
    .whereRaw(`metadata->>'${stamp}' IS NULL`)
    .where((q) => q.where('created_at', '>', since).orWhereRaw("metadata->>'rungAt' > ?", [since.toISOString()]))
    .modify((q) => { if (cursor) q.whereRaw('(created_at, id) > (?::timestamptz, ?::uuid)', [cursor.createdAt, cursor.id]); })
    .orderBy([{ column: 'created_at', order: 'asc' }, { column: 'id', order: 'asc' }])
    .limit(pageSize)
    .select('id', 'title', 'body', 'link', 'metadata', 'created_at', db.raw('created_at::text AS created_at_token'));
}

// An admin bell row that is open and in the bell feed: not done, not retired by the relevance sweep, not Activity-only.
// The scan reads these, and a push is checked against them again just before it goes.
function openBell(query) {
  const { excludeActivityOnlyFromBell } = require('./notification-service')._private;
  return excludeActivityOnlyFromBell(query.where({ recipient_type: 'admin' }))
    .whereNull('done_at')
    .whereRaw("metadata->'retired' IS NULL");
}

// The row's metadata once `stamp` lands at `now`: what stampOnce writes, and what the dispatch check expects to find.
const stampedMeta = (stamp, meta, now) => ({ ...meta, [stamp]: now.toISOString() });

// The one stamp: this row, still open and unchanged since it was read. Returns true when it landed. A bell with a
// dedupe key is stamped under notifyAdmin's advisory lock for that key (notification-service.js dedupeAndInsert): a
// refresh reads the row and writes its whole metadata back under that lock, so a stamp landing between its read and
// its write would be overwritten, and the bell could push a second time. With the lock the stamp waits for the
// refresh, whose new metadata then fails the fence; a refresh after the stamp merges onto it and keeps it. `claim`
// (optional, { key, taken(conn) }) caps the pushes per claim: its own lock is taken after the dedupe-key lock (always in
// that order, and notifyAdmin takes only the first), and `taken` reads in this transaction; a claim already taken
// writes nothing. `ready` (optional) is asked again once the locks are held: a stamp that waited past the reminder's
// hours or the item's late window is not written, so the next open sweep can still judge the bell.
async function stampOnce(stamp, { row, meta }, now, ready = () => true, claim = null) {
  return db.transaction(async (trx) => {
    if (meta.dedupeKey) await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?))', [`admin:${meta.dedupeKey}`]);
    if (claim) await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?))', [claim.key]);
    if (!ready()) return false;
    if (claim && (await claim.taken(trx))) return false;
    const landed = await trx('notifications')
      .where({ id: row.id, recipient_type: 'admin' })
      .whereNull('done_at')
      .whereRaw('metadata IS NOT DISTINCT FROM ?::jsonb', [JSON.stringify(meta)])
      .update({ metadata: trx.raw("COALESCE(metadata, '{}'::jsonb) || ?::jsonb", [JSON.stringify(stampedMeta(stamp, {}, now))]) });
    return Number(landed) === 1;
  });
}

// Still an open bell in the bell feed just before the push goes and, with `stamped`, still the event that was stamped:
// its metadata exactly as the stamp left it. A bell that rang again (a fresh form: notifyAdmin advanced rungAt), moved
// to Activity, or lost its stamp since then sends nothing; its own ring, if any, already reached the phones. A lookup
// that fails reads as closed: no push (the bell row stays).
async function rowStillOpen(id, label, stamped = null) {
  try {
    const stored = await openBell(db('notifications').where({ id }))
      .modify((q) => { if (stamped) q.whereRaw('metadata IS NOT DISTINCT FROM ?::jsonb', [JSON.stringify(stamped)]); })
      .first('done_at');
    return !!stored && !stored.done_at;
  } catch (err) {
    logger.warn(`[${label}] open check failed for notification ${id}: ${safeError(err)}`);
    return false;
  }
}

// The push, with the row's own words. alertRowId gives it its own push tag per bell row. `stamped` is the row's
// metadata as the stamp left it (rowStillOpen). `ready` (optional) is asked with a fresh clock just before dispatch,
// before the reads and again after them: false means the reminder's hours, or this item's late window, closed since the
// sweep began. `stillWaiting` (optional, async) judges the lead again: false means a person reached it, or it closed,
// since the page was read. The open-row read runs after it, the last read before the handoff. The same check runs before
// the dispatch and again before each device's handoff (the push service's beforeHandoff), so a Done, a contact or the
// cutoff while an earlier device's request runs stops the remaining devices. `expiresAt` (optional, an ISO time) is
// when the providers drop the push undelivered (notification-triggers.js pushExpiryFor). Never throws.
async function sendPush({ row, customerId, stamped = null }, label, ready = () => true, stillWaiting = async () => true, expiresAt = null) {
  const stillDue = async () => ready() && (await stillWaiting()) && (await rowStillOpen(row.id, label, stamped)) && ready();
  try {
    const { triggerNotification } = require('./notification-triggers');
    return await triggerNotification(TRIGGER_KEY, {
      alertRowId: row.id, alertTitle: row.title, alertBody: row.body || null, alertLink: row.link || null,
      ...(customerId ? { customerId } : {}),
      ...(expiresAt ? { expiresAt } : {}),
    }, {
      // bellAuthorized: the bell row's writer rang it (bell: true), so the push keeps that answer. pushOnly: the row is
      // not rewritten. adminOnly: nothing goes to a lead, a customer or a technician.
      pushOnly: true, adminOnly: true, bellAuthorized: true,
      beforePush: stillDue,
      beforeHandoff: stillDue,
    });
  } catch (err) {
    logger.warn(`[${label}] push failed for notification ${row.id}: ${safeError(err)}`);
    return null;
  }
}

// One item judged again by its reminder's `waiting`, with fresh reads, just before its push goes. A failed read sends
// nothing: the dispatcher sends when this check throws, so it never throws.
async function waitingNow(kind, item) {
  try {
    return (await kind.waiting([item])).length > 0;
  } catch (err) {
    logger.warn(`[${kind.label}] wait check failed for notification ${item.row.id}, no push: ${safeError(err)}`);
    return false;
  }
}

/**
 * One scan for a reminder `kind`: { label, stamp, match, windowMs, dueItems(rows, now), waiting(items), inHours?(date) }.
 * dueItems picks the rows due now; waiting(items) returns those that still wait on a person and throws when a read
 * fails (no verdict: nothing is sent on that page). Each push asks waiting([item]) again just before it goes. `inHours(date)` is the reminder's own hours rule, asked with a fresh
 * clock (`clock`, default the real time) before each item is stamped and again at each push's dispatch: the parent
 * sweep's `now` can be old by the time its closes and the reads above have finished. When the hours have closed the
 * sweep stops with the rest unstamped, for the next open sweep while they are still inside their late window. An item
 * may carry `expiresAt`, the end of its late window: once the fresh clock passes it, the item is not stamped, and a
 * push already stamped is refused at dispatch. `closesAt(date)` (optional) is when the reminder's hours end on that
 * day: each push expires then, or at the item's `expiresAt` if that is first. `claim(item)` (optional) caps the pushes
 * per claim (stampOnce). Every page is judged first, then the stamps go in the kind's `order` (optional comparator), so
 * the item a claim prefers is stamped first even when its row was read on a later page. Returns { due, sent, sends };
 * `sends` are the pushes, never awaited here. Throws only when a page cannot be read.
 */
async function runSweep(kind, { now, pageSize = PAGE_SIZE, clock = () => new Date() }) {
  const { label, stamp } = kind;
  const since = new Date(now.getTime() - kind.windowMs);
  const total = { due: 0, sent: 0 };
  const ready = () => !kind.inHours || kind.inHours(clock());
  const expired = (item) => !!item.expiresAt && clock().getTime() > item.expiresAt.getTime();
  // The push's expiry, read with the fresh clock: the reminder's close today, or the item's late window, if first.
  const expiryOf = (item) => {
    const ends = [kind.closesAt?.(clock()), item.expiresAt].filter(Boolean).map((at) => at.getTime());
    return ends.length ? new Date(Math.min(...ends)).toISOString() : null;
  };
  const sends = [];
  const waiting = [];
  let cursor = resumeAfter.get(stamp) || null;
  resumeAfter.delete(stamp);
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const rows = await candidateQuery(kind, since, cursor, pageSize);
    if (!rows.length) break;
    const last = rows[rows.length - 1];
    cursor = { createdAt: last.created_at_token, id: last.id };
    const due = kind.dueItems(rows, now);
    total.due += due.length;
    try {
      waiting.push(...(await kind.waiting(due)));
    } catch (err) {
      logger.warn(`[${label}] contact witnesses failed to load, nothing sent on this page: ${safeError(err)}`);
    }
    if (rows.length < pageSize) break;
    if (page === MAX_PAGES - 1) {
      resumeAfter.set(stamp, cursor);
      logger.warn(`[${label}] stopped after ${MAX_PAGES} pages; the next sweep resumes after them`);
    }
  }
  if (kind.order) waiting.sort(kind.order);
  for (const item of waiting) {
    if (!ready()) {
      logger.info(`[${label}] hours closed while the sweep ran: the rest waits for the next open sweep`);
      return { ...total, sends };
    }
    // Its late window closed while the reads above ran: not stamped, and no later sweep finds it due.
    if (expired(item)) continue;
    try {
      if (!(await stampOnce(stamp, item, now, () => ready() && !expired(item), kind.claim ? kind.claim(item) : null))) continue;
      total.sent += 1;
      sends.push(sendPush({ ...item, stamped: stampedMeta(stamp, item.meta, now) }, label, () => ready() && !expired(item),
        () => waitingNow(kind, item), expiryOf(item)));
    } catch (err) {
      logger.warn(`[${label}] notification ${item.row.id} not stamped: ${safeError(err)}`);
    }
  }
  return { ...total, sends };
}

module.exports = { runSweep, TRIGGER_KEY, __private: { candidateQuery, stampOnce, rowStillOpen, sendPush, waitingNow, resumeAfter, PAGE_SIZE, MAX_PAGES } };
