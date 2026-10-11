/**
 * start_program's phase row (ib_action_phases, one row per attempt).
 *
 * The card books the series and then sets the tier and the monthly bill in a second transaction. A crash between the
 * two commits leaves visits booked as bill-covered and a bill that never changed, and the confirmed action is already
 * consumed. The phase row survives that: it is written BEFORE the booking, moved to 'booked_pending_bill' once the visits
 * exist, and moved to 'billed' inside the tier-and-bill transaction itself.
 *
 *   booking              written before the booking; the series may or may not exist yet
 *   booked_pending_bill  the visits exist, the bill step has not committed
 *   billed               done (set in the bill transaction)
 *   abandoned            nothing left to finish (booking refused, fewer visits, the bill drifted, changed by hand)
 *
 * The state is mutable, so it lives in its own table (migration 20261011020000); every transition also appends an
 * audit_log event (recordAuditEvent), the immutable record.
 *
 * An open row makes the next start_program for that customer offer to FINISH the bill step from the stored target
 * instead of refusing because the series exists. The lookup runs under the customer row lock (the lock the booking
 * transaction takes), so a request that arrives while a booking is committing waits for it and then sees its rows. A
 * 'booking' row younger than BOOKING_STALE_MINUTES with no series is a booking still in flight: it is never abandoned
 * by a concurrent request. A row still open after ALERT_MINUTES raises one admin alert (sweepStalePending).
 */
const crypto = require('crypto');
const db = require('../../models/db');
const logger = require('../logger');

const TOOL = 'start_program';
const OPEN_PHASES = ['booking', 'booked_pending_bill'];
const ALERT_MINUTES = 10;
const BOOKING_STALE_MINUTES = 30;

const isUuid = (value) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(value || ''));
const minutesAgo = (n) => new Date(Date.now() - n * 60 * 1000);

function readMarker(row) {
  const payload = typeof row.payload === 'string' ? JSON.parse(row.payload) : (row.payload || {});
  return { id: row.id, customerId: row.customer_id, createdAt: row.created_at, phase: row.phase, target: payload.target || {}, payload };
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

// Throws on a failed write: the caller books nothing without its phase row.
async function writeMarker({ customerId, target, actorId = null }) {
  const id = crypto.randomUUID();
  await db('ib_action_phases').insert({
    id, tool: TOOL, customer_id: customerId, action_key: `${target.version}:${id}`, phase: 'booking', payload: JSON.stringify({ target }),
  });
  await audit(id, 'booking', { customer_id: customerId, actor: actorId ? String(actorId) : null });
  return id;
}

// Move the row (inside a transaction when `conn` is its trx; the audit event is written by the caller after the commit).
async function setPhase(id, phase, extra = {}, conn = db) {
  await conn('ib_action_phases').where({ id }).update({
    phase,
    payload: conn.raw('payload || ?::jsonb', [JSON.stringify({ [`${phase}_at`]: new Date().toISOString(), ...extra })]),
    updated_at: new Date(),
  });
}

// Best-effort phase move plus its audit event: a failure is logged and never changes the receipt (the alert covers it).
async function settle(id, phase, extra = {}) {
  if (!id) return;
  try {
    await setPhase(id, phase, extra);
    await audit(id, phase, extra);
  } catch (err) {
    logger.error(`[start-program-marker] could not move ${id} to ${phase}: ${err.message}`);
  }
}

// The series the attempt's booking would have made.
async function seriesExistsSince(marker, conn = db) {
  const row = await conn('scheduled_services')
    .where({ customer_id: marker.customerId, service_type: marker.target.catalogName, is_recurring: true })
    .where('created_at', '>=', marker.createdAt)
    .whereNotIn('status', ['cancelled', 'canceled'])
    .first('id');
  return !!row;
}

// One decision per open row, in a table: what the lookup does with a row in each state.
//   'resume'      the visits exist; offer to finish the bill
//   'in_progress' a booking is still in flight; the caller waits
//   'abandon'     nothing was booked and the booking window has passed
async function decide(marker, conn) {
  if (marker.phase === 'booked_pending_bill') return 'resume';
  if (await seriesExistsSince(marker, conn)) return 'found_series';
  return new Date(marker.createdAt) > minutesAgo(BOOKING_STALE_MINUTES) ? 'in_progress' : 'abandon';
}

const AFTER_DECISION = {
  resume: async () => ({}),
  found_series: async (marker, conn) => { await setPhase(marker.id, 'booked_pending_bill', { found_by: 'schedule_check' }, conn); return { audit: ['booked_pending_bill', { found_by: 'schedule_check' }] }; },
  in_progress: async () => ({ inProgress: true }),
  abandon: async (marker, conn) => { await setPhase(marker.id, 'abandoned', { reason: 'no_series' }, conn); return { audit: ['abandoned', { reason: 'no_series' }], gone: true }; },
};

/**
 * The customer's open attempt, read under the customer row lock.
 * Returns { marker } (visits exist: resume), { inProgress: true } (a booking is still running), or {} (nothing to do).
 */
async function findResumable(customerId) {
  if (!isUuid(customerId)) return {};
  let audited = null;
  const found = await db.transaction(async (trx) => {
    await trx('customers').where({ id: customerId }).forUpdate().first('id');
    const row = await trx('ib_action_phases')
      .where({ tool: TOOL, customer_id: customerId }).whereIn('phase', OPEN_PHASES)
      .orderBy('created_at', 'desc').first();
    if (!row) return {};
    const marker = readMarker(row);
    const decision = await decide(marker, trx);
    const outcome = await AFTER_DECISION[decision](marker, trx);
    audited = outcome.audit ? [marker.id, ...outcome.audit] : null;
    if (outcome.inProgress) return { inProgress: true };
    return outcome.gone ? {} : { marker: { ...marker, phase: 'booked_pending_bill' } };
  });
  if (audited) await audit(audited[0], audited[1], audited[2]);
  return found;
}

// One needs-you alert per open row older than ALERT_MINUTES. A 'booking' row with no series behind it waits out the
// booking window, then is abandoned quietly.
async function sweepStalePending() {
  const rows = await db('ib_action_phases')
    .where({ tool: TOOL }).whereIn('phase', OPEN_PHASES).whereNull('alerted_at')
    .where('created_at', '<', minutesAgo(ALERT_MINUTES))
    .orderBy('created_at', 'asc').limit(25);
  let raised = 0;
  for (const row of rows) {
    const marker = readMarker(row);
    try {
      if (marker.phase === 'booking' && !(await seriesExistsSince(marker))) {
        if (new Date(marker.createdAt) <= minutesAgo(BOOKING_STALE_MINUTES)) await settle(marker.id, 'abandoned', { reason: 'no_series' });
        continue;
      }
      const { raiseAdminAlert } = require('../admin-alert-compose');
      await raiseAdminAlert('billing', {
        area: 'Billing',
        action: 'Program booked, bill not set',
        why: 'A program start booked the visits, but the tier and monthly bill did not finish.',
        severity: 'needs-you',
        link: `/admin/customers?customerId=${encodeURIComponent(marker.customerId)}`,
        subject: { type: 'customer', id: marker.customerId },
        doneWhen: 'bill_step_finished',
        who: 'person',
      }, {
        bell: true,
        detail: 'Ask the Intelligence Bar to start the program for this customer again: it offers to finish the tier and bill. Or set them on the customer page.',
        dedupeKey: `start-program-pending-bill:${marker.id}`,
        metadata: { markerId: marker.id },
      });
      await db('ib_action_phases').where({ id: marker.id }).update({ alerted_at: new Date(), updated_at: new Date() });
      raised += 1;
    } catch (err) {
      logger.error(`[start-program-marker] stale row ${marker.id} alert failed: ${err.message}`);
    }
  }
  return raised;
}

module.exports = { TOOL, ALERT_MINUTES, BOOKING_STALE_MINUTES, writeMarker, setPhase, settle, audit, findResumable, sweepStalePending, seriesExistsSince };
