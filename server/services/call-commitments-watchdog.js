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
    const rows = await commitments.listOpenCommitments(db, { party: 'waves', limit: SCAN_LIMIT, offset: page * SCAN_LIMIT, includeHints: true, now });
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
  const callIds = [...new Set(rows.map((r) => r.call_log_id))];
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
    refreshed += r.fulfilled || 0;
  }
  if (refreshed > 0) rows = await listAllOpenWaves(now);
  const candidates = commitments.selectOverdue(rows, { now }).filter((r) => !isInternalTestCustomerId(r.customer_id));
  const unverified = unverifiedCalls.size;
  // The snapshot is minutes old by now (one refresh per candidate call):
  // a promise the office marked done or dismissed meanwhile must not ring.
  const liveIds = await commitments.stillOpenIds(db, candidates.map((r) => r.id), { now });
  return db.transaction(async (trx) => {
    // Fence the notification version against a concurrent staff action.
    const live = await trx('call_commitments as cc').whereIn('cc.id', [...liveIds]).where('cc.status', 'open')
      .whereRaw(`NOT ${require('./call-commitments').staleAiRowSql('cc')}`).orderBy('cc.id').forUpdate('cc').select('cc.*');
    const current = live.map((r) => ({ ...candidates.find((c) => c.id === r.id), ...r }));
    const noticeRows = () => trx('notifications').where({ recipient_type: 'admin' });
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
        const prior = !inAggregate && await noticeRows().whereRaw("metadata->>'commitment_id' = ?", [row.id])
          .whereRaw("metadata->>'dedupeKey' LIKE 'call-commitment-overdue:%'").orderBy('created_at', 'desc').first('metadata');
        if (!inAggregate && !prior) continue;
        const meta = typeof prior?.metadata === 'string' ? JSON.parse(prior.metadata) : prior?.metadata;
        version = (inAggregate ? aggregateMeta.overdue_versions?.[row.id] : meta?.dedupeVersion) || version;
      }
      overdue.push(row); versions[row.id] = version;
    }
    const result = { skipped: false, scanned: rows.length, overdue: overdue.length, alerted: 0, unverified };
    // Both schedules use the existing identities. A gate change changes the
    // callback deadline policy, never the owner of persisted reminder rows.
    await trx('notifications as n').where({ recipient_type: 'admin' }).whereNull('read_at')
      .whereRaw("metadata->>'dedupeKey' LIKE 'call-commitment-overdue:%'")
      .whereNotExists(trx('call_commitments as cc').join('call_log as cl', 'cl.id', 'cc.call_log_id')
        .whereRaw("cc.id::text = n.metadata->>'commitment_id'").where({ 'cc.status': 'open', 'cc.party': 'waves' })
        .whereRaw(`NOT ${require('./call-commitments').staleAiRowSql('cc')}`)
        .whereRaw(`${require('./call-commitments').effectiveDueSql('cc', 'cl')} < ?`, [now])
        .modify((q) => { if (require('./callback-cards').enabled()) q.whereRaw("(cc.kind <> 'callback' OR cc.snoozed_until IS NULL OR cc.snoozed_until <= ?)", [now]); }))
      .update({ read_at: now });
    if (!overdue.length) {
      await noticeRows().whereNull('read_at').whereRaw("metadata->>'dedupeKey' LIKE 'call-commitments-overdue:%'")
        .update({ read_at: now, metadata: trx.raw("metadata || '{\"retired\":true}'::jsonb") });
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
          metadata: { triggerKey: TRIGGER_KEY, overdue_count: overdue.length, overdue_commitment_ids: ids, overdue_versions: versions, retired: false },
        });
      if (!persisted(notif)) return { ...result, unannounced: overdue.length, aggregate: true };
      await noticeRows().whereNull('read_at').whereRaw("metadata->>'dedupeKey' LIKE 'call-commitment-overdue:%'")
        .whereIn(trx.raw("metadata->>'commitment_id'"), ids)
        .update({ read_at: now, metadata: trx.raw("metadata || jsonb_build_object('batchedBy', ?::text)", [notif.id]) });
      await noticeRows().whereNull('read_at').whereNot('id', notif.id)
        .whereRaw("metadata->>'dedupeKey' LIKE 'call-commitments-overdue:%'")
        .update({ read_at: now, metadata: trx.raw("metadata || '{\"retired\":true}'::jsonb") });
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
      const acknowledged = priorAggregate?.read_at && !aggregateMeta?.retired && aggregateMeta?.overdue_versions?.[r.id] === versions[r.id];
      if (acknowledged || meta?.batchedBy) {
        await noticeRows().where({ id: notif.id }).update({ read_at: acknowledged ? priorAggregate.read_at : null,
          metadata: trx.raw("metadata - 'batchedBy'") });
      }
      if (!acknowledged) result.alerted += 1;
      await noticeRows().whereNull('read_at').whereNot('id', notif.id)
        .whereRaw("metadata->>'dedupeKey' LIKE 'call-commitment-overdue:%'")
        .whereRaw("metadata->>'commitment_id' = ?", [r.id]).update({ read_at: now });
    }
    if (!unannounced) await noticeRows().whereRaw("metadata->>'dedupeKey' LIKE 'call-commitments-overdue:%'")
      .update({ read_at: now, metadata: trx.raw("metadata || '{\"retired\":true,\"dedupeVersion\":\"individuals\"}'::jsonb") });
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
