/**
 * start_program's phase ledger (ib_action_phases, one row per attempt).
 *
 * The card books the series and then sets the tier and the monthly bill in a second transaction. A crash between the
 * two commits leaves visits booked as bill-covered and a bill that never changed, and the confirmed action is already
 * consumed. The ledger row records how far the attempt got, so the office hears about it and the next program start for
 * that customer is refused until a person has set the bill by hand. Nothing replays the stored bill: the office decides.
 *
 *   booking              written before the booking; the series may or may not exist yet
 *   booked_pending_bill  visits carrying this row's action_key exist; the bill step has not committed
 *   billed               done (set in the bill transaction)
 *   abandoned            nothing left to do (booking refused, fewer visits, the bill drifted, marked done by the office,
 *                        or a booking that never produced visits)
 *
 * The series is bound to the row, never inferred: the booking transaction stamps the row's action_key on every visit it
 * creates (a booking_action_stamp activity_log row per visit, written in the same transaction as the visits;
 * scheduled_services has no metadata column). booked_pending_bill is set only when stamped visits exist. No lookup by
 * service name or timestamp anywhere.
 *
 * The state is mutable, so it lives in its own table (migration 20261011020000); every transition also appends an
 * audit_log event (recordAuditEvent), the immutable record.
 *
 * One open row per customer: a partial unique index (migration 20261011030000) is the hard guarantee, and writeMarker
 * maps its unique violation to MARKER_OPEN_EXISTS (the caller refuses program_start_in_progress).
 *
 * Two readers, one answer shape:
 *   readOpenMarker(customerId)  SELECT only, no lock, no write. The preview path uses it: a preview never changes state.
 *   findOpenMarker(customerId)  the confirmed path, under the customer row lock (the lock the booking transaction takes), so
 *                               a request that arrives while a booking is committing waits for it and then sees its
 *                               stamps. It may move a row (stamped booking -> booked_pending_bill, an old unstamped
 *                               booking -> abandoned plus a bell, a done alert -> abandoned).
 * They answer:
 *   {}                        nothing blocks a new program start
 *   { inProgress: marker }    a booking with no stamped visits is still running (or, read-only, is old: the sweep clears it)
 *   { owed: marker }          visits are booked and the bill step is owed (the office sets it by hand)
 * and THROW on any read failure or malformed row: the caller refuses, it never falls through to planning.
 *
 * Clearing an owed row: the office marks the alert done (the row reads notifications.done_at on the stored alert id).
 * There is NO expiry. A row with no alert id (the alert post failed) is posted again by the sweep until it has one.
 */
const crypto = require('crypto');
const db = require('../../models/db');
const logger = require('../logger');

const TOOL = 'start_program';
const STAMP_ACTION = 'booking_action_stamp';
const OPEN_PHASES = ['booking', 'booked_pending_bill'];
const ALERT_MINUTES = 10;
const BOOKING_STALE_MINUTES = 30;

const OWED_INSTRUCTION = 'Set the tier and monthly bill by hand on the customer page, then mark this done.';
const UNFINISHED_INSTRUCTION = 'Check the schedule for this customer. If the visits are there, set the tier and monthly bill by hand on the customer page.';

const isUuid = (value) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(value || ''));
const minutesAgo = (n) => new Date(Date.now() - n * 60 * 1000);

// A malformed row throws: findOpenMarker's caller refuses rather than plan around a row it cannot read.
function readMarker(row) {
  if (!row || typeof row !== 'object') throw new Error('phase row is missing');
  const payload = typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload;
  const created = new Date(row.created_at);
  if (!row.id || !row.customer_id || !OPEN_PHASES.includes(row.phase) || typeof row.action_key !== 'string' || !row.action_key
    || !payload || typeof payload !== 'object' || Number.isNaN(created.getTime())) {
    throw new Error(`phase row ${row.id || '(no id)'} is malformed`);
  }
  const target = payload.target && typeof payload.target === 'object' ? payload.target : {};
  return { id: row.id, customerId: row.customer_id, actionKey: row.action_key, createdAt: created, phase: row.phase, target, payload };
}

// Append-only evidence of a transition. recordAuditEvent swallows its own failures (the phase row is the state).
async function audit(id, phase, extra = {}) {
  try {
    const { recordAuditEvent } = require('../audit-log');
    await recordAuditEvent({
      actor_type: 'system', action: 'start_program.phase', resource_type: 'ib_action_phase', resource_id: id,
      metadata: { phase, ...extra },
    });
  } catch (err) {
    logger.warn(`[start-program-marker] audit event for ${id} (${phase}) not written: ${err.message}`);
  }
}

const ONE_OPEN_INDEX = 'ib_action_phases_one_open_per_customer';
const isOneOpenViolation = (err) => err && err.code === '23505' && (!err.constraint || err.constraint === ONE_OPEN_INDEX);

// Throws on a failed write: the caller books nothing without its phase row. Returns { id, actionKey }. The insert runs
// under the customer row lock (the lock the booking takes); the partial unique index is the hard guarantee, and its
// violation (another open attempt for this customer) becomes MARKER_OPEN_EXISTS.
async function writeMarker({ customerId, target, actorId = null }) {
  const id = crypto.randomUUID();
  const actionKey = `${target.version}:${id}`;
  try {
    await db.transaction(async (trx) => {
      await trx('customers').where({ id: customerId }).forUpdate().first('id');
      await trx('ib_action_phases').insert({
        id, tool: TOOL, customer_id: customerId, action_key: actionKey, phase: 'booking', payload: JSON.stringify({ target }),
      });
    });
  } catch (err) {
    if (isOneOpenViolation(err)) throw Object.assign(new Error('another program start for this customer is open'), { code: 'MARKER_OPEN_EXISTS' });
    throw err;
  }
  await audit(id, 'booking', { customer_id: customerId, actor: actorId ? String(actorId) : null });
  return { id, actionKey };
}

// Move the row (inside a transaction when `conn` is its trx; the audit event is written by the caller after the commit).
async function setPhase(id, phase, extra = {}, conn = db) {
  await conn('ib_action_phases').where({ id }).update({
    phase,
    payload: conn.raw('payload || ?::jsonb', [JSON.stringify({ [`${phase}_at`]: new Date().toISOString(), ...extra })]),
    updated_at: new Date(),
  });
}

// Best-effort phase move plus its audit event: a failure is logged and never changes the receipt (the sweep covers it).
async function settle(id, phase, extra = {}) {
  if (!id) return;
  try {
    await setPhase(id, phase, extra);
    await audit(id, phase, extra);
  } catch (err) {
    logger.error(`[start-program-marker] could not move ${id} to ${phase}: ${err.message}`);
  }
}

// The visits this attempt's booking created: the stamp rows carry the action_key, and the visit must exist.
async function stampedVisitIds(actionKey, conn = db) {
  const stamps = await conn('activity_log').where({ action: STAMP_ACTION }).whereRaw("metadata->>'action_key' = ?", [actionKey]).select('metadata');
  const ids = stamps.map((s) => (typeof s.metadata === 'string' ? JSON.parse(s.metadata) : s.metadata)?.scheduled_service_id).filter(Boolean).map(String);
  if (!ids.length) return [];
  const rows = await conn('scheduled_services').whereIn('id', ids).select('id');
  return rows.map((r) => String(r.id));
}

// After the booking returned: booked_pending_bill only when stamped visits exist. False = the booking reported success
// but no stamped visit can be found (the caller reports an unknown outcome and the office checks the schedule).
async function markBooked(id, actionKey, extra = {}) {
  const ids = await module.exports.stampedVisitIds(actionKey);
  if (!ids.length) return false;
  await settle(id, 'booked_pending_bill', { ...extra, visits: ids.length });
  return true;
}

// Raise one admin alert; returns the notification id (or null). Copy follows docs/admin-notifications.md.
async function raiseLedgerAlert(marker, { action, why, detail, dedupe }) {
  const { raiseAdminAlert, cutAtWord } = require('../admin-alert-compose');
  const name = cutAtWord(String(marker.target.customerName || 'a customer').replace(/\s+/g, ' '), 30);
  const result = await raiseAdminAlert('billing', {
    area: 'Billing',
    action,
    why: why(name),
    severity: 'needs-you',
    link: `/admin/customers?customerId=${encodeURIComponent(marker.customerId)}`,
    subject: { type: 'customer', id: marker.customerId },
    doneWhen: 'bill_step_finished',
    who: 'person',
  }, {
    bell: true,
    detail: detail(name),
    dedupeKey: `${dedupe}:${marker.id}`,
    metadata: { markerId: marker.id },
  });
  return result?.id || null;
}

const alertOwed = (marker) => raiseLedgerAlert(marker, {
  action: 'Program bill not set',
  why: (name) => `A program start for ${name} booked its visits, but the bill update did not finish.`,
  detail: (name) => `A program start for ${name} booked its visits but the monthly bill update did not finish. ${OWED_INSTRUCTION}`,
  dedupe: 'start-program-pending-bill',
});

const alertUnfinished = (marker) => raiseLedgerAlert(marker, {
  action: 'Program start unfinished',
  why: (name) => `A program start for ${name} may not have finished; check the schedule.`,
  detail: (name) => `A program start for ${name} may not have finished; check the schedule. ${UNFINISHED_INSTRUCTION}`,
  dedupe: 'start-program-unfinished',
});

async function stampAlerted(id, extra = {}) {
  await db('ib_action_phases').where({ id }).update({ alerted_at: new Date(), updated_at: new Date(), ...extra });
}

// The office marks the alert done: the stored notification id reads done. Anything unreadable counts as not done.
async function alertIsDone(marker, conn) {
  const alertId = marker.payload.alert_id;
  if (!alertId) return false;
  const row = await conn('notifications').where({ id: alertId }).first('done_at');
  return !!(row && row.done_at);
}

// What the lookup does with an open row, as a table. Each handler runs in the customer-locked transaction and returns
// { out } (the answer) plus an optional { audit: [phase, extra], bell } to do after the commit.
const OPEN_ROW = {
  async booking(marker, conn) {
    if ((await module.exports.stampedVisitIds(marker.actionKey, conn)).length) {
      await setPhase(marker.id, 'booked_pending_bill', { found_by: 'stamp' }, conn);
      return { out: { owed: { ...marker, phase: 'booked_pending_bill' } }, audit: ['booked_pending_bill', { found_by: 'stamp' }] };
    }
    if (marker.createdAt > minutesAgo(BOOKING_STALE_MINUTES)) return { out: { inProgress: marker } };
    await setPhase(marker.id, 'abandoned', { reason: 'no_stamped_visits' }, conn);
    return { out: {}, audit: ['abandoned', { reason: 'no_stamped_visits' }], bell: alertUnfinished };
  },
  async booked_pending_bill(marker, conn) {
    if (!(await alertIsDone(marker, conn))) return { out: { owed: marker } };
    await setPhase(marker.id, 'abandoned', { reason: 'marked_done' }, conn);
    return { out: {}, audit: ['abandoned', { reason: 'marked_done' }] };
  },
};

// The open row for a customer, newest first. Throws on a malformed row.
async function openRow(conn, customerId) {
  const row = await conn('ib_action_phases')
    .where({ tool: TOOL, customer_id: customerId }).whereIn('phase', OPEN_PHASES)
    .orderBy('created_at', 'desc').first();
  return row ? readMarker(row) : null;
}

/**
 * The preview path: SELECT only, no lock, no write, no alert. Same answers as findOpenMarker, except that nothing is
 * moved: a stamped booking reads as owed, a done alert reads as clear, and an old booking with no stamped visits reads as
 * in progress with `stale: true` (check the schedule; the sweep clears it). Throws on a read failure or malformed row.
 */
async function readOpenMarker(customerId) {
  if (!isUuid(customerId)) return {};
  const marker = await openRow(db, customerId);
  if (!marker) return {};
  if (marker.phase === 'booked_pending_bill') return (await alertIsDone(marker, db)) ? {} : { owed: marker };
  if ((await module.exports.stampedVisitIds(marker.actionKey, db)).length) return { owed: marker };
  return { inProgress: marker, stale: marker.createdAt <= minutesAgo(BOOKING_STALE_MINUTES) };
}

/**
 * The confirmed path: the customer's open attempt, read under the customer row lock, and moved when it should be.
 * Throws on a read failure or a malformed row.
 */
async function findOpenMarker(customerId) {
  if (!isUuid(customerId)) return {};
  let after = null;
  const found = await db.transaction(async (trx) => {
    await trx('customers').where({ id: customerId }).forUpdate().first('id');
    const marker = await openRow(trx, customerId);
    if (!marker) return {};
    const step = await OPEN_ROW[marker.phase](marker, trx);
    after = { marker, step };
    return step.out;
  });
  if (after && after.step.audit) await audit(after.marker.id, ...after.step.audit);
  if (after && after.step.bell) await ringAfterAbandon(after.marker, after.step.bell);
  return found;
}

async function ringAfterAbandon(marker, alert) {
  try {
    await alert(marker);
    await stampAlerted(marker.id);
  } catch (err) {
    logger.error(`[start-program-marker] alert for ${marker.id} failed: ${err.message}`);
  }
}

// One alert per open row older than ALERT_MINUTES (the scheduler runs this every 10 minutes):
//   booked_pending_bill  (or a booking whose stamped visits now exist)  -> "bill not set", the row stays open
//   booking, no stamped visits, older than BOOKING_STALE_MINUTES        -> "may not have finished", the row is abandoned
// A younger booking with no stamped visits is left alone: it may still be running.
async function sweepStalePending() {
  const rows = await db('ib_action_phases')
    .where({ tool: TOOL }).whereIn('phase', OPEN_PHASES)
    // Not yet alerted, or owed with no alert id (the earlier post failed or came back without one): post it again.
    .where((q) => q.whereNull('alerted_at').orWhere((r) => r.where('phase', 'booked_pending_bill').whereRaw("payload->>'alert_id' IS NULL")))
    .where('created_at', '<', minutesAgo(ALERT_MINUTES))
    .orderBy('created_at', 'asc').limit(25);
  let raised = 0;
  for (const row of rows) {
    try {
      const marker = readMarker(row);
      let phase = marker.phase;
      if (phase === 'booking' && (await module.exports.stampedVisitIds(marker.actionKey)).length) {
        await settle(marker.id, 'booked_pending_bill', { found_by: 'stamp' });
        phase = 'booked_pending_bill';
      }
      if (phase === 'booked_pending_bill') {
        const alertId = await alertOwed(marker);
        if (!alertId) {
          // No id to store: leave the row unstamped so the next pass posts it again. The row never expires.
          logger.warn(`[start-program-marker] bill-owed alert for ${marker.id} came back without an id; it will be posted again`);
        } else {
          await stampAlerted(marker.id, { payload: db.raw('payload || ?::jsonb', [JSON.stringify({ alert_id: alertId })]) });
          raised += 1;
        }
      } else if (marker.createdAt <= minutesAgo(BOOKING_STALE_MINUTES)) {
        await alertUnfinished(marker);
        await settle(marker.id, 'abandoned', { reason: 'no_stamped_visits' });
        await stampAlerted(marker.id);
        raised += 1;
      }
    } catch (err) {
      logger.error(`[start-program-marker] stale row ${row.id} alert failed: ${err.message}`);
    }
  }
  return raised;
}

module.exports = {
  TOOL, STAMP_ACTION, ONE_OPEN_INDEX, ALERT_MINUTES, BOOKING_STALE_MINUTES, OWED_INSTRUCTION,
  writeMarker, setPhase, settle, audit, markBooked, stampedVisitIds, readOpenMarker, findOpenMarker, sweepStalePending,
};
