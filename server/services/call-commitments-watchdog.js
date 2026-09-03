/**
 * Overdue-promise watchdog — the exception bell for the Owed queue.
 *
 * The queue (Communications → Owed) is where the office works promises; this
 * is the pager for the ones that slipped. A Waves promise is overdue when
 * its stated due time has passed, or, for the kinds that imply a prompt
 * action, when its implicit deadline has (24 hours for an estimate, the end
 * of the call's ET day for a callback, OVERDUE_IMPLICIT_DAYS for the rest —
 * `implicitDueAt` in call-commitments). Customer promises never ring — the
 * office cannot act on the customer's side.
 *
 * Alerting mirrors the stall watchdog: one bell per commitment per ET day
 * (dedupeKey), `bell: true` because the 'alert' category is silenced under
 * GATE_ADMIN_BELL_POLICY and a pager that cannot page is no pager; a burst
 * past AGGREGATE_THRESHOLD collapses into one bell keyed on the batch.
 * Rows that a human dismissed or that were fulfilled leave the scan on
 * their own. Read-only except admin notifications.
 *
 * Runs only while GATE_CALL_COMMITMENTS is on (there are no rows otherwise).
 */

const db = require('../models/db');
const logger = require('./logger');
const NotificationService = require('./notification-service');
const { listOpenCommitments, selectOverdue, refreshFulfillment, stillOpenIds, OVERDUE_IMPLICIT_DAYS } = require('./call-commitments');

// Registered in notification-triggers (techVisible) so the bell reaches the
// staff who work the Owed tab, not only admins: scopeAdminFeedToRole hides
// any persisted row whose triggerKey is not classified tech-visible.
const TRIGGER_KEY = 'call_commitment_overdue';
const { isInternalTestCustomerId } = require('./internal-test-customers');

const AGGREGATE_THRESHOLD = 5;
// Page size of the open-commitments read; the scan walks EVERY page (up to
// MAX_PAGES — 5,000 open Waves promises is a backlog no bell fixes) so an
// obligation past the first page is never silently unpaged: overdue rows
// sort first and stay open until worked, so a fixed first page would rescan
// the same rows every day.
const SCAN_LIMIT = 200;
const MAX_PAGES = 25;

async function listAllOpenWaves(now) {
  const all = [];
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const rows = await listOpenCommitments(db, { party: 'waves', limit: SCAN_LIMIT, offset: page * SCAN_LIMIT, includeHints: true, now });
    all.push(...rows);
    if (rows.length < SCAN_LIMIT) break;
  }
  return all;
}

function maskPhone(value) {
  const digits = String(value || '').replace(/\D/g, '');
  return digits ? `***${digits.slice(-4)}` : 'unknown';
}

function persisted(notif) {
  return !!(notif && notif.id && !notif.suppressed);
}

function whoFor(row) {
  const name = [row.customer_first_name, row.customer_last_name].filter(Boolean).join(' ');
  if (name) return name;
  const phone = String(row.direction || '').startsWith('outbound') ? row.to_phone : row.from_phone;
  return maskPhone(phone);
}

function etWhen(value) {
  return value ? new Date(value).toLocaleString('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : null;
}

async function runCallCommitmentsWatchdog({ now = new Date() } = {}) {
  const { isEnabled } = require('../config/feature-gates');
  if (!isEnabled('callCommitments')) return { skipped: true, reason: 'gated_off' };
  const { runExclusive } = require('../utils/cron-lock');
  return runExclusive('call-commitments-watchdog', () => runInner({ now }));
}

async function runInner({ now = new Date() } = {}) {
  const today = require('../utils/datetime-et').etDateString(now);
  let rows = await listAllOpenWaves(now);
  // A promise a later record already kept must not ring: nothing stamps
  // fulfillment unless someone opens the queue or the panel, so refresh the
  // candidate calls here — the same cheap indexed lookups the queue route
  // runs — and re-list before deciding what is overdue.
  // A call whose refresh FAILED — the call threw, or any of its lookups did
  // (`failed` in the summary) — is not verified either way: its promise may
  // already be kept, so it is left out of today's bell (and logged) rather
  // than paged on a stale row; tomorrow's tick retries it.
  const callIds = [...new Set(rows.map((r) => r.call_log_id))];
  const unverifiedCalls = new Set();
  let refreshed = 0;
  for (const id of callIds) {
    const r = await refreshFulfillment(db, id).catch((err) => {
      logger.warn(`[call-commitments-watchdog] fulfillment refresh failed for call ${id}: ${err.message}`);
      unverifiedCalls.add(id);
      return {};
    });
    if (r.failed > 0) {
      logger.warn(`[call-commitments-watchdog] ${r.failed} fulfillment lookup(s) failed for call ${id} — left out of today's bell`);
      unverifiedCalls.add(id);
    }
    refreshed += r.fulfilled || 0;
  }
  if (refreshed > 0) rows = await listAllOpenWaves(now);
  const candidates = selectOverdue(rows, { now }).filter((r) => !isInternalTestCustomerId(r.customer_id) && !unverifiedCalls.has(r.call_log_id));
  const unverified = unverifiedCalls.size;
  // The snapshot is minutes old by now (one refresh per candidate call):
  // a promise the office marked done or dismissed meanwhile must not ring.
  const liveIds = await stillOpenIds(db, candidates.map((r) => r.id));
  const overdue = candidates.filter((r) => liveIds.has(r.id));
  if (!overdue.length) return { skipped: false, scanned: rows.length, overdue: 0, alerted: 0, unverified };

  // A human-recorded promise has been open since it was RECORDED (the
  // same instant implicitDueAt ages it from), not since a call that may be
  // weeks older (Codex #3725 r18 P2).
  const openSince = (r) => (r.source === 'human' ? r.created_at : (r.call_started_at || r.created_at));
  const describe = (r) => `${whoFor(r)} — ${r.description}${r.due_at ? ` (due ${etWhen(r.due_at)} ET)` : ` (open since ${etWhen(openSince(r))} ET)`}`;

  if (overdue.length > AGGREGATE_THRESHOLD) {
    const ids = overdue.map((r) => r.id).sort();
    // ONE aggregate row per ET day. Keying identity to the batch would mint
    // a fresh bell every time the overdue set moved between runs (an
    // operator settling one item) and page the office again for the same
    // backlog (Codex #3725 r16 P2). The standing row is refreshed instead:
    // a changed count rewrites its title/body/metadata and surfaces it
    // unread again; identical content is a plain dedupe.
    const notif = await NotificationService.notifyAdmin(
      'alert',
      `${overdue.length} promises to callers are overdue`,
      `${overdue.length} things Waves told callers it would do have not happened. Oldest: ${describe(overdue[0])}. Open the Owed tab and work them oldest-first.`,
      {
        link: '/admin/communications#tab=owed',
        dedupeKey: `call-commitments-overdue:${today}`,
        refreshOnDedupe: true,
        bell: true,
        metadata: { triggerKey: TRIGGER_KEY, overdue_count: overdue.length, overdue_commitment_ids: ids },
      },
    );
    if (!persisted(notif)) {
      logger.error('[call-commitments-watchdog] aggregate alert did NOT persist — overdue promises are unannounced');
      return { skipped: false, scanned: rows.length, overdue: overdue.length, alerted: 0, unannounced: overdue.length, aggregate: true, unverified };
    }
    logger.warn(`[call-commitments-watchdog] ${overdue.length} overdue promises — aggregate alert fired`);
    return { skipped: false, scanned: rows.length, overdue: overdue.length, alerted: 1, aggregate: true, unverified };
  }

  let alerted = 0;
  let unannounced = 0;
  for (const r of overdue) {
    const notif = await NotificationService.notifyAdmin(
      'alert',
      'A promise to a caller is overdue',
      `${describe(r)}. Open the Owed tab to mark it done or dismiss it.`,
      {
        link: '/admin/communications#tab=owed',
        dedupeKey: `call-commitment-overdue:${r.id}:${today}`,
        bell: true,
        metadata: { triggerKey: TRIGGER_KEY, commitment_id: r.id, call_log_id: r.call_log_id, kind: r.kind },
      },
    );
    if (!persisted(notif)) {
      unannounced += 1;
      logger.error(`[call-commitments-watchdog] overdue commitment ${r.id} alert did NOT persist — unannounced`);
      continue;
    }
    alerted += 1;
  }
  return { skipped: false, scanned: rows.length, overdue: overdue.length, alerted, unannounced, unverified };
}

module.exports = {
  runCallCommitmentsWatchdog,
  runInner,
  AGGREGATE_THRESHOLD,
  TRIGGER_KEY,
  OVERDUE_IMPLICIT_DAYS,
};
