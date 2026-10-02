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
 * past AGGREGATE_THRESHOLD collapses into one standing row keyed on the batch,
 * kept out of the bell (a backlog is a count on the Owed tab, not a bell).
 * Rows that a human dismissed or that were fulfilled leave the scan on
 * their own. Read-only except admin notifications.
 *
 * Runs only while GATE_CALL_COMMITMENTS is on (there are no rows otherwise).
 */

const db = require('../models/db');
const logger = require('./logger');
const NotificationService = require('./notification-service');
const commitments = require('./call-commitments');
const { OVERDUE_IMPLICIT_DAYS } = commitments;

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
    const rows = await commitments.listOpenCommitments(db, { party: 'waves', limit: SCAN_LIMIT, offset: page * SCAN_LIMIT, includeHints: true, prepare: true, now });
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

function reminderVersion(row) {
  return JSON.stringify([row.id, row.updated_at, row.due_at || row.callback_due_at || null,
    row.snoozed_until || null, row.reviewed_at || null, row.assigned_to || null]);
}

async function runCallCommitmentsWatchdog({ now = new Date() } = {}) {
  const { isEnabled } = require('../config/feature-gates');
  if (!isEnabled('callCommitments')) return { skipped: true, reason: 'gated_off' };
  const { runExclusive } = require('../utils/cron-lock');
  return runExclusive('call-commitments-watchdog', async () => {
    const result = await runInner({ now });
    // Reconciliation already committed verified work. Report partial proof
    // failures to job health without rolling those notifications back.
    if (result.unverified) throw new Error(`Fulfillment verification incomplete for ${result.unverified} call(s)`);
    return result;
  });
}

async function runInner({ now = new Date() } = {}) {
  const today = require('../utils/datetime-et').etDateString(now);
  let rows = await listAllOpenWaves(now);
  // A promise a later record already kept must not ring: nothing stamps
  // fulfillment unless someone opens the queue or the panel, so refresh the
  // candidate calls here — the same cheap indexed lookups the queue route
  // runs — and re-list before deciding what is overdue.
  // A call whose refresh FAILED — the call threw, or any of its lookups did
  // (`failed` in the summary) — is not verified either way. Carry forward
  // its existing reminder version while independently verified work proceeds.
  // Calls holding a promise kept by a booking for its promised slot whose
  // proof has lapsed (visit cancelled, skipped or moved, call relinked) are
  // judged again too — nothing open on the call would bring them here.
  // …and so are calls holding a promise the evidence close shut on a visit
  // since cancelled or a customer no longer churned (PROMISE_EVIDENCE_CLOSE).
  const callIds = [...new Set([...rows.map((r) => r.call_log_id), ...await commitments.listSlotKeptCallIds(db),
    ...await commitments.listLapsedEvidenceClosedCallIds(db)])];
  const unverifiedCalls = new Set();
  let refreshed = 0;
  for (const id of callIds) {
    const r = await commitments.refreshFulfillment(db, id).catch((err) => {
      logger.warn(`[call-commitments-watchdog] fulfillment refresh failed for call ${id}: ${err.message}`);
      unverifiedCalls.add(id);
      return {};
    });
    if (r.failed > 0) {
      logger.warn(`[call-commitments-watchdog] ${r.failed} fulfillment lookup(s) failed for call ${id} — retaining prior reminder evidence`);
      unverifiedCalls.add(id);
    }
    refreshed += (r.fulfilled || 0) + (r.reopened || 0);
  }
  if (refreshed > 0) rows = await listAllOpenWaves(now);
  let candidates = commitments.selectOverdue(rows, { now }).filter((r) => !isInternalTestCustomerId(r.customer_id));
  // While the one-hour follow-up pager is live AND healthy it owns the
  // callback / quote / scheduling promises still inside its 24-hour list;
  // this watchdog takes each over once it ages off that list. Isolated: any
  // failure in the pager lookups means "not deferring" — this watchdog then
  // pages everything as it did before the pager existed.
  if (require('../config/feature-gates').isEnabled('followupSlaAlerts')) {
    try {
      const sla = require('./followup-sla-watcher');
      // A pager that has not run for its latest tick (just switched on, or
      // behind) gets one catch-up run first; only if that fails does this
      // watchdog cover its promises itself.
      if (!await sla.pagerHealthy(db, now)) {
        await sla.runFollowUpSlaWatcher({ now }).catch((err) => logger.warn(`[call-commitments-watchdog] follow-up pager catch-up failed: ${err.message}`));
      }
      if (await sla.pagerHealthy(db, now)) {
        const owned = await sla.slaOwnedIds(db, candidates, now);
        if (owned.size) candidates = candidates.filter((r) => !owned.has(r.id));
      }
    } catch (err) {
      logger.warn(`[call-commitments-watchdog] follow-up pager ownership check failed — not deferring: ${err.message}`);
    }
  }
  const unverified = unverifiedCalls.size;
  // The snapshot is minutes old by now (one refresh per candidate call):
  // a promise the office marked done or dismissed meanwhile must not ring.
  const liveIds = await commitments.stillOpenIds(db, candidates.map((r) => r.id), { now });
  return db.transaction(async (trx) => {
    // Fence the notification version against a concurrent staff action.
    const live = await trx('call_commitments as cc').whereIn('cc.id', [...liveIds]).where('cc.status', 'open')
      .whereRaw(`NOT ${require('./call-commitments').staleAiRowSql('cc')}`).orderBy('cc.id').forUpdate('cc').select('cc.*');
    // Locked in id order; restored to the candidate order (effective due
    // time, then call age) so "Oldest" in the aggregate is the longest overdue.
    const rank = new Map(candidates.map((c, i) => [c.id, i]));
    const current = live.map((r) => ({ ...candidates.find((c) => c.id === r.id), ...r }))
      .sort((a, b) => rank.get(a.id) - rank.get(b.id));
    const noticeRows = () => trx('notifications').where({ recipient_type: 'admin' });
    // The closing UPDATE's selection: not done, or done by a person (the
    // watchdog takes the row over once; see openToCloser).
    const openToCloser = (q) => NotificationService._private.openToCloser(q, 'call-commitments-watchdog');
    // A system retire closes the row as done (read is not done): a person's
    // earlier read and first done_at stand (doneColumns COALESCEs), done_by is
    // the watchdog's, the bell drops it.
    const closeDone = (resolution) => NotificationService._private.doneColumns({
      by: 'call-commitments-watchdog', resolution, at: now, keepExisting: true, conn: trx,
    });
    const priorAggregate = await noticeRows().whereRaw("metadata->>'dedupeKey' LIKE 'call-commitments-overdue:%'")
      .orderBy('created_at', 'desc').first('id', 'metadata', 'read_at');
    const aggregateMeta = typeof priorAggregate?.metadata === 'string' ? JSON.parse(priorAggregate.metadata) : priorAggregate?.metadata;
    const overdue = [], versions = {};
    for (const row of commitments.selectOverdue(current, { now }).filter((r) => !isInternalTestCustomerId(r.customer_id))) {
      let version = reminderVersion(row);
      if (unverifiedCalls.has(row.call_log_id)) {
        // Never create a first alert from unverified evidence, but retain
        // previously announced work and its acknowledgment version.
        const inAggregate = !aggregateMeta?.retired && aggregateMeta?.overdue_commitment_ids?.includes(row.id);
        // A retired row (the callback stopped being overdue meanwhile) is
        // not prior evidence: copying its literal 'retired' version would
        // dedupe onto a read bell and leave nothing unread.
        const prior = !inAggregate && await noticeRows().whereRaw("metadata->>'commitment_id' = ?", [row.id])
          .whereRaw("metadata->>'dedupeKey' LIKE 'call-commitment-overdue:%'")
          .whereRaw("metadata->>'dedupeVersion' IS DISTINCT FROM 'retired'").orderBy('created_at', 'desc').first('metadata');
        if (!inAggregate && !prior) continue;
        const meta = typeof prior?.metadata === 'string' ? JSON.parse(prior.metadata) : prior?.metadata;
        version = (inAggregate ? aggregateMeta.overdue_versions?.[row.id] : meta?.dedupeVersion) || version;
      }
      overdue.push(row); versions[row.id] = version;
    }
    const result = { skipped: false, scanned: rows.length, overdue: overdue.length, alerted: 0, unverified };
    // Both schedules use the existing identities. A gate change changes the
    // callback deadline policy, never the owner of persisted reminder rows.
    await trx('notifications as n').where({ recipient_type: 'admin' })
      .whereRaw("metadata->>'dedupeVersion' IS DISTINCT FROM 'retired'")
      .whereRaw("metadata->>'dedupeKey' LIKE 'call-commitment-overdue:%'")
      .whereNotExists(trx('call_commitments as cc').join('call_log as cl', 'cl.id', 'cc.call_log_id')
        .whereRaw("cc.id::text = n.metadata->>'commitment_id'").where({ 'cc.status': 'open', 'cc.party': 'waves' })
        .whereRaw(`NOT ${require('./call-commitments').staleAiRowSql('cc')}`)
        .whereRaw(`${require('./call-commitments').effectiveDueSql('cc', 'cl')} < ?`, [now]))
      .update({ ...closeDone('The promise is no longer overdue'), metadata: trx.raw("metadata || '{\"dedupeVersion\":\"retired\"}'::jsonb") });
    if (!overdue.length) {
      await noticeRows().whereRaw("metadata->>'dedupeKey' LIKE 'call-commitments-overdue:%'")
        .whereRaw("metadata->>'dedupeVersion' IS DISTINCT FROM 'empty'")
        .update({ ...closeDone('No promises to callers are overdue now'), metadata: trx.raw("metadata || '{\"retired\":true,\"dedupeVersion\":\"empty\"}'::jsonb") });
      return result;
    }
    const openSince = (r) => r.source === 'human' ? r.created_at : (r.call_started_at || r.created_at);
    const describe = (r) => `${whoFor(r)} — ${r.description}${r.due_at ? ` (due ${etWhen(r.due_at)} ET)` : ` (open since ${etWhen(openSince(r))} ET)`}`;
    if (overdue.length > AGGREGATE_THRESHOLD) {
      const ids = overdue.map((r) => r.id).sort();
      const notif = await NotificationService.notifyAdmin('alert', `${overdue.length} promises to callers are overdue`,
        `${overdue.length} things Waves told callers it would do have not happened. Oldest: ${describe(overdue[0])}. Open the Owed tab and work them oldest-first.`, {
          link: '/admin/communications#tab=owed', dedupeKey: `call-commitments-overdue:${today}`,
          dedupeVersion: require('node:crypto').createHash('sha256').update(JSON.stringify(ids.map((id) => versions[id]))).digest('hex'),
          refreshOnDedupe: true, bell: true, trx,
          // A backlog of overdue promises is a standing condition, not an event
          // (owner 2026-10-01: it rang every day). It stays a count on the Owed
          // tab and an open row for needs-me, but never reaches the bell: an
          // Activity-only row is hidden from the bell list, its unread count and
          // mark-all-read. The row is still the watchdog's state (versions, batch).
          metadata: { triggerKey: TRIGGER_KEY, overdue_count: overdue.length, overdue_commitment_ids: ids, overdue_versions: versions, retired: false, feed: 'activity' },
        });
      if (!persisted(notif)) return { ...result, unannounced: overdue.length, aggregate: true };
      // Rows are picked by done_at, not read_at: a reminder someone only
      // opened is still open work, and the batch now carries it. A reminder a
      // person marked Done is absorbed too (openToCloser), so it can't be
      // reopened beside the summary; if it later comes back out of the batch,
      // the un-batch re-arms it as live work.
      await require('./notification-service')._private.openToCloser(noticeRows(), 'call-commitments-watchdog')
        .whereRaw("metadata->>'dedupeKey' LIKE 'call-commitment-overdue:%'")
        .whereIn(trx.raw("metadata->>'commitment_id'"), ids)
        // batchedUnread: whether the absorb found it unread (SET reads the old
        // row), so the un-batch undoes only the read this close added.
        .update({ ...closeDone('Included in the overdue promises summary'), metadata: trx.raw("metadata || jsonb_build_object('batchedBy', ?::text, 'batchedUnread', read_at IS NULL)", [notif.id]) });
      await openToCloser(noticeRows()).whereNot('id', notif.id)
        .whereRaw("metadata->>'dedupeKey' LIKE 'call-commitments-overdue:%'")
        .update({ ...closeDone('Replaced by a newer overdue promises summary'), metadata: trx.raw("metadata || '{\"retired\":true}'::jsonb") });
      return { ...result, alerted: 1, aggregate: true };
    }
    let unannounced = 0;
    for (const r of overdue) {
      const notif = await NotificationService.notifyAdmin('alert', 'A promise to a caller is overdue',
        `${describe(r)}. Open the Owed tab to mark it done or dismiss it.`, {
          link: '/admin/communications#tab=owed', dedupeKey: `call-commitment-overdue:${r.id}:${today}`,
          dedupeVersion: versions[r.id], refreshOnDedupe: true, bell: true, trx,
          metadata: { triggerKey: TRIGGER_KEY, commitment_id: r.id, call_log_id: r.call_log_id, kind: r.kind, customer_id: r.customer_id },
        });
      if (!persisted(notif)) { unannounced += 1; continue; }
      const meta = typeof notif.metadata === 'string' ? JSON.parse(notif.metadata) : notif.metadata;
      // An acknowledgment transfers only from TODAY's aggregate: a backlog
      // read yesterday says nothing about today's overdue escalation.
      const acknowledged = priorAggregate?.read_at && !aggregateMeta?.retired && aggregateMeta?.dedupeKey === `call-commitments-overdue:${today}`
        && aggregateMeta?.overdue_versions?.[r.id] === versions[r.id];
      if (acknowledged || meta?.batchedBy) {
        // Un-read (a reminder back out of the batch) re-arms it: a Done on the
        // batched row must not keep a still-overdue promise out of the bell.
        // A batch-absorbed row was closed done by this watchdog (or, absorbed
        // before the done state existed, by the done backfill); taking it back
        // out of the batch reopens it. A person's own done is never undone.
        // Back out of the batch, the read the absorb added is undone; a staff
        // member's own earlier read (an acknowledgment) stands. A row absorbed
        // before batchedUnread existed keeps the old behaviour (unread).
        await noticeRows().where({ id: notif.id }).update({
          read_at: acknowledged ? priorAggregate.read_at
            : trx.raw("CASE WHEN metadata->>'batchedUnread' = 'false' THEN read_at ELSE NULL END"),
          ...(acknowledged
            ? (meta?.batchedBy ? {
              done_at: trx.raw("CASE WHEN done_by IN ('call-commitments-watchdog', 'backfill') THEN NULL ELSE done_at END"),
              done_by: trx.raw("CASE WHEN done_by IN ('call-commitments-watchdog', 'backfill') THEN NULL ELSE done_by END"),
              resolution: trx.raw("CASE WHEN done_by IN ('call-commitments-watchdog', 'backfill') THEN NULL ELSE resolution END"),
            } : {})
            : { done_at: null, done_by: null, resolution: null }),
          metadata: trx.raw("metadata - 'batchedBy' - 'batchedUnread'"),
        });
      }
      if (!acknowledged) result.alerted += 1;
      await openToCloser(noticeRows()).whereNot('id', notif.id)
        .whereRaw("metadata->>'dedupeKey' LIKE 'call-commitment-overdue:%'")
        .whereRaw("metadata->>'commitment_id' = ?", [r.id]).update(closeDone('Replaced by a newer reminder for this promise'));
    }
    if (!unannounced) await noticeRows().whereRaw("metadata->>'dedupeKey' LIKE 'call-commitments-overdue:%'")
      .update({ ...closeDone('The overdue promises are listed one by one now'), metadata: trx.raw("metadata || '{\"retired\":true,\"dedupeVersion\":\"individuals\"}'::jsonb") });
    return { ...result, unannounced };
  });
}

module.exports = {
  runCallCommitmentsWatchdog,
  runInner,
  AGGREGATE_THRESHOLD,
  TRIGGER_KEY,
  OVERDUE_IMPLICIT_DAYS,
};
