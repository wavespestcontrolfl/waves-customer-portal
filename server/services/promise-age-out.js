/**
 * Promise age-out (owner 2026-11-16, "do these": "an age-out rule. A promise from September still reads open").
 *
 * An open promise that nobody settled does not stay open forever. Once a night (scheduler.js, 1:44 AM ET) a
 * promise is dismissed when all of these hold:
 *   - it is open and no person has touched it (human_state IS NULL). A promise the office confirmed, edited,
 *     claimed, snoozed or reopened is the office's and stays;
 *   - its last date is more than AGE_OUT_DAYS days old. Last date = the latest of when it was recorded, its
 *     stated due time, a callback card's staffed deadline and a snooze. 30 days is the admin bell's own limit
 *     (admin-alert-retention.js AGE_DAYS, owner 2026-10-26);
 *   - it is not a promised reschedule link (send_reschedule_link): that worker and its delivery ledger own it;
 *   - on a call, it is live work, not a row a later pass of the call stopped detecting (staleAiRowSql).
 * Call, text and email promises; Waves' promises and the customer's.
 *
 * The promise is dismissed, never deleted and never marked kept: status 'dismissed', human_state stays NULL, and
 * fulfillment says why ({ kind: 'aged_out', basis, closed_by: 'promise_age_out', closed_at, run, days }). An open
 * promise can carry a suggested proof (an association the evidence pass stored and did not close on); the marker
 * keeps it under `prior`. The closed_by marker is its own, so the evidence re-judge (call-commitments.js
 * autoClosedSql) never reads the row as one of its closes and never reopens it. The Owed tab lists an expired Waves
 * call promise under "Closed automatically" for 7 days with its Reopen; a person's Reopen sets human_state, so the
 * promise never expires again.
 *
 * What closes with it. A text promise's alert through the text lane's own closer (closeSmsCommitmentAlerts: the
 * shared alert stays for the text's other open promises). An email promise's alert by its key. A call promise's
 * overdue reminder is the watchdog's: its next run retires a reminder whose promise is no longer open.
 * Nothing is sent to a customer. A text promise a booked visit holds (GATE_PROMISE_RECORD_EVIDENCE rule 3) is
 * never dismissed while held: a hold ends at most 14 days after the due time, and the limit is 30 days after it.
 *
 * Writes: one short statement per call promise, one short transaction per text or email promise (the promise,
 * then its alert). Every promise of one text shares one alert, and the text lane does its work on a text under
 * that text's row lock (sms-operational-actions.js lockLiveCommitment, lockCommitmentSource), so a text promise
 * takes that lock first: the alert is then closed, or kept, on the text's other promises as they stand. The
 * customer row is never locked here: estimate and payment paths take it with NOWAIT.
 * Every write repeats the whole rule in its WHERE, so a person's action, a new due time or a snooze that landed
 * since the read leaves the promise alone. A run that closed something records one audit_log row
 * (promise_age_out.expire). A second run finds nothing left.
 *
 * The undo. Every dismissed promise carries its run id (fulfillment.run), written with the dismissal itself, so a
 * run can be found and reopened from the promises alone (listPromiseAgeOutRuns), also when its audit row was never
 * written. reopenPromiseAgeOut puts back the promises, each with the proof it carried, and the alerts that run
 * closed for them.
 * server/scripts/promise-age-out-dry-run.js prints what a run would close; reopen-promise-age-out.js lists the
 * runs and reopens one.
 */

const db = require('../models/db');
const logger = require('./logger');

const DAY_MS = 24 * 60 * 60 * 1000;
const AGE_OUT_DAYS = 30;
const AGED_OUT_KIND = 'aged_out';
const AGED_OUT_BASIS = `no_action_in_${AGE_OUT_DAYS}_days`;
const CLOSED_BY_AGE_OUT = 'promise_age_out';
const DONE_BY = 'promise-age-out';
const RESOLUTION = `The promise expired: no action in ${AGE_OUT_DAYS} days`;
const AUDIT_ACTION = 'promise_age_out.expire';
const UNDO_AUDIT_ACTION = 'promise_age_out.reopen';
const BATCH_SIZE = 200;
const MAX_BATCHES = 25;
// Owned by reschedule-link-promises.js (its outbox rows and delivery ledger settle with the promise).
const WORKER_OWNED_KINDS = ['send_reschedule_link'];
const CHANNELS = ['call', 'text', 'email'];

const channelOf = (row) => (row.sms_log_id ? 'text' : (row.email_id ? 'email' : 'call'));

// The promise's last date, over a call_commitments alias. GREATEST skips NULLs; created_at is never NULL.
const lastDateSql = (cc) => `GREATEST(${cc}.created_at, ${cc}.due_at, ${cc}.callback_due_at, ${cc}.snoozed_until)`;

// The whole rule, on a query over call_commitments named `cc` (the table name, or an alias). Every read and every
// write goes through it. IS NOT TRUE: staleAiRowSql is NULL for a text or email promise (no call to compare with).
function agedScope(query, cc, cutoff) {
  const { staleAiRowSql } = require('./call-commitments');
  return query.where(`${cc}.status`, 'open').whereNull(`${cc}.human_state`)
    .whereNotIn(`${cc}.kind`, WORKER_OWNED_KINDS)
    .whereRaw(`${lastDateSql(cc)} < ?`, [cutoff])
    .whereRaw(`(${staleAiRowSql(cc)}) IS NOT TRUE`);
}

// The dismissal every channel writes, on one promise. The marker keeps the proof the promise carried as `prior`.
const dismiss = (conn, row, { cutoff, proof, now }) => agedScope(conn('call_commitments').where({ id: row.id }), 'call_commitments', cutoff).update({
  status: 'dismissed', fulfilled_at: null, updated_at: now,
  fulfillment: conn.raw("?::jsonb || CASE WHEN fulfillment IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('prior', fulfillment) END", [JSON.stringify(proof)]),
});

const doneColumns = (trx, now) => require('./notification-service')._private.doneColumns({
  by: DONE_BY, resolution: RESOLUTION, at: now, keepExisting: true, conn: trx,
});

// One closer per channel: (conn, row, { cutoff, proof, now }) -> 1 when the promise was dismissed, else 0.
const CLOSERS = {
  call: dismiss,
  text: (conn, row, rule) => conn.transaction(async (trx) => {
    await trx('sms_log').where({ id: row.sms_log_id }).forUpdate().first('id');
    const closed = await dismiss(trx, row, rule);
    if (closed) {
      await require('./sms-operational-actions').closeSmsCommitmentAlerts(trx,
        { commitmentId: row.id, smsLogId: row.sms_log_id, now: rule.now }, doneColumns(trx, rule.now));
    }
    return closed;
  }),
  email: (conn, row, rule) => conn.transaction(async (trx) => {
    const closed = await dismiss(trx, row, rule);
    if (closed) {
      const { openToCloser } = require('./notification-service')._private;
      await openToCloser(trx('notifications').where({ recipient_type: 'admin' })
        .whereRaw("metadata->>'dedupeKey' = ?", [`email-commitment:${row.id}`]), DONE_BY).update(doneColumns(trx, rule.now));
    }
    return closed;
  }),
};

const emptyCounts = () => ({ total: 0, byChannel: Object.fromEntries(CHANNELS.map((c) => [c, 0])), byParty: { waves: 0, customer: 0 }, byKind: {} });
function count(counts, row) {
  counts.total += 1;
  counts.byChannel[channelOf(row)] += 1;
  counts.byParty[row.party] = (counts.byParty[row.party] || 0) + 1;
  counts.byKind[row.kind] = (counts.byKind[row.kind] || 0) + 1;
}

// One page of promises past the limit, in id order, after `afterId`.
const agedPage = (conn, { cutoff, afterId, limit, scope }) => agedScope(conn('call_commitments as cc'), 'cc', cutoff)
  .modify((q) => { if (afterId) q.where('cc.id', '>', afterId); })
  .modify((q) => { if (scope) scope(q); })
  .orderBy('cc.id').limit(limit)
  .select('cc.id', 'cc.call_log_id', 'cc.sms_log_id', 'cc.email_id', 'cc.party', 'cc.kind');

/**
 * dryRun: reads only, and counts what a run would dismiss.
 * scope: narrows the read (a query over `cc`); the tests keep a run to their own fixtures with it.
 * -> { runId, cutoff, dryRun, expired: counts, failed, complete }
 */
async function runPromiseAgeOut({ now = new Date(), conn = db, dryRun = false, scope = null, batchSize = BATCH_SIZE, maxBatches = MAX_BATCHES } = {}) {
  const runId = now.toISOString();
  const cutoff = new Date(now.getTime() - AGE_OUT_DAYS * DAY_MS);
  const proof = { kind: AGED_OUT_KIND, basis: AGED_OUT_BASIS, closed_by: CLOSED_BY_AGE_OUT, closed_at: runId, run: runId, days: AGE_OUT_DAYS };
  const expired = emptyCounts();
  let failed = 0;
  let afterId = null;
  let complete = false;
  for (let batch = 0; batch < maxBatches && !complete; batch += 1) {
    const rows = await agedPage(conn, { cutoff, afterId, limit: batchSize, scope });
    for (const row of rows) {
      try {
        if (dryRun || await CLOSERS[channelOf(row)](conn, row, { cutoff, proof, now })) count(expired, row);
      } catch (err) {
        // The promise stays open and the next run takes it.
        failed += 1;
        logger.warn(`[promise-age-out] promise ${row.id} left open: ${err.message}`);
      }
    }
    complete = rows.length < batchSize;
    afterId = rows.length ? rows[rows.length - 1].id : afterId;
  }
  const summary = { runId, cutoff: cutoff.toISOString(), dryRun, expired, failed, complete };
  if (expired.total > 0 || failed > 0) {
    logger.info(`[promise-age-out] run ${runId} ${dryRun ? 'would dismiss' : 'dismissed'} ${expired.total} promise(s) past ${AGE_OUT_DAYS} days (${JSON.stringify(expired.byChannel)}), ${failed} left open on an error`);
  }
  if (!dryRun && expired.total > 0) await recordRun(conn, summary);
  return summary;
}

// The run's audit row, written after its dismissals committed. When the insert fails the dismissals stand and the
// run is still named: by the log line above, by each promise it dismissed (listPromiseAgeOutRuns) and by this
// error, which fails the job so the missing row is seen.
async function recordRun(conn, { runId, cutoff, expired, failed, complete }) {
  try {
    await require('./audit-log').recordAuditEvent({ actor_type: 'system', action: AUDIT_ACTION, resource_type: 'call_commitment',
      metadata: { runId, days: AGE_OUT_DAYS, cutoff, expired, failed, complete }, critical: true, trx: conn });
  } catch (err) {
    throw new Error(`run ${runId} dismissed ${expired.total} promise(s) and its audit row was not written: ${err.message}`, { cause: err });
  }
}

// The promises an age-out run dismissed that still carry its marker (a person's later verdict changes human_state).
const dismissed = (conn) => conn('call_commitments').where({ status: 'dismissed' }).whereNull('human_state')
  .whereRaw("fulfillment->>'closed_by' = ?", [CLOSED_BY_AGE_OUT]);
const dismissedBy = (conn, run) => dismissed(conn).whereRaw("fulfillment->>'run' = ?", [String(run)]);

// The runs whose dismissals still stand, newest first, read from the promises themselves. -> [{ run, promises }]
const listPromiseAgeOutRuns = ({ conn = db, limit = 50 } = {}) => dismissed(conn)
  .groupByRaw("fulfillment->>'run'").orderByRaw("fulfillment->>'run' DESC").limit(limit)
  .select(conn.raw("fulfillment->>'run' AS run"), conn.raw('count(*)::int AS promises'));

// The alerts that run closed for those promises go back to the bell as they were. A row the run closed has the
// run's own time as its done time and this job as its closer (a row some earlier close already held keeps that
// earlier time and stays closed); it names a promise in commitment_id or commitment_ids. It is unread again when
// the close is what marked it read.
const reopenAlerts = (conn, run, ids) => conn('notifications').where({ recipient_type: 'admin', done_by: DONE_BY })
  .whereRaw('done_at = ?::timestamptz', [String(run)])
  .whereRaw("(metadata->>'commitment_id' = ANY(?::text[]) OR jsonb_exists_any(COALESCE(metadata->'commitment_ids', '[]'::jsonb), ?::text[]))", [ids, ids])
  .update({
    ...require('./notification-service')._private.DONE_CLEARED,
    read_at: conn.raw('CASE WHEN read_at = ?::timestamptz THEN NULL ELSE read_at END', [String(run)]),
  });

/**
 * Reopen what one run dismissed: the promises that still carry its marker (each gets back the proof it carried)
 * and the alerts it closed for them, with the audit row, in one transaction. A promise still past the limit expires again on the next nightly run, so this
 * is for after the rule changed.
 * -> { run, found: counts, reopened, alertsReopened }
 */
async function reopenPromiseAgeOut({ run, apply = false, conn = db, now = new Date() } = {}) {
  if (!run) throw new Error('reopenPromiseAgeOut needs the run id of an age-out run');
  const found = emptyCounts();
  (await dismissedBy(conn, run).select('id', 'call_log_id', 'sms_log_id', 'email_id', 'party', 'kind')).forEach((row) => count(found, row));
  if (!apply || !found.total) return { run, found, reopened: 0, alertsReopened: 0 };
  return conn.transaction(async (trx) => {
    // `->` gives NULL for a promise that carried no proof.
    const ids = (await dismissedBy(trx, run).update({ status: 'open', fulfillment: trx.raw("fulfillment -> 'prior'"), fulfilled_at: null, updated_at: now })
      .returning(['id'])).map((row) => row.id);
    const alertsReopened = ids.length ? await reopenAlerts(trx, run, ids) : 0;
    await require('./audit-log').recordAuditEvent({ actor_type: 'system', action: UNDO_AUDIT_ACTION, resource_type: 'call_commitment',
      metadata: { runId: String(run), reopened: ids.length, alertsReopened }, critical: true, trx });
    return { run, found, reopened: ids.length, alertsReopened };
  });
}

module.exports = {
  runPromiseAgeOut,
  reopenPromiseAgeOut,
  listPromiseAgeOutRuns,
  AGE_OUT_DAYS,
  AGED_OUT_KIND,
  CLOSED_BY_AGE_OUT,
  AUDIT_ACTION,
};
