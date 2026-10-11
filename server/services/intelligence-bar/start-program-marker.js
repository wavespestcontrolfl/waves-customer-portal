/**
 * start_program's phase marker (audit_log, no migration).
 *
 * The card books the series and then sets the tier and the monthly bill in a second transaction. A crash between the
 * two commits leaves visits booked as bill-covered and a bill that never changed, and the approved action is already
 * consumed. The marker survives that: it is written BEFORE the booking, moved to 'booked_pending_bill' once the visits
 * exist, and moved to 'billed' inside the tier-and-bill transaction itself.
 *
 *   booking              written before the booking; the series may or may not exist yet
 *   booked_pending_bill  the visits exist, the bill step has not committed
 *   billed               done (written in the bill transaction)
 *   abandoned            nothing left to finish (the booking was refused, fewer visits, the bill drifted, set by hand)
 *
 * An open marker (booking, booked_pending_bill) makes the next start_program for that customer offer to FINISH the
 * bill step from the stored target instead of refusing because the series exists. A marker still open after
 * STALE_MINUTES raises one admin alert (sweepStalePending, run by the scheduler every 10 minutes).
 */
const crypto = require('crypto');
const db = require('../../models/db');
const logger = require('../logger');

const ACTION = 'start_program.pending_bill';
const OPEN_PHASES_SQL = "metadata->>'phase' IN ('booking', 'booked_pending_bill')";
const STALE_MINUTES = 10;

const isUuid = (value) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(value || ''));

function readMarker(row) {
  const meta = typeof row.metadata === 'string' ? JSON.parse(row.metadata) : (row.metadata || {});
  return { id: row.id, customerId: row.resource_id, createdAt: row.created_at, phase: meta.phase, target: meta.target || {}, meta };
}

// Throws on a failed write: the caller books nothing without its marker.
async function writeMarker({ customerId, actorId, target }) {
  const id = crypto.randomUUID();
  await db('audit_log').insert({
    id,
    actor_type: isUuid(actorId) ? 'technician' : 'system',
    actor_id: isUuid(actorId) ? actorId : null,
    action: ACTION,
    resource_type: 'customer',
    resource_id: customerId,
    metadata: JSON.stringify({ phase: 'booking', target }),
  });
  return id;
}

// Merge fields into the marker (inside a transaction when `conn` is its trx).
async function mergeMeta(id, fields, conn = db) {
  await conn('audit_log').where({ id }).update({ metadata: conn.raw('metadata || ?::jsonb', [JSON.stringify(fields)]) });
}

const setPhase = (id, phase, extra = {}, conn = db) => mergeMeta(id, { phase, [`${phase}_at`]: new Date().toISOString(), ...extra }, conn);

// Best-effort phase move: a failure is logged and never changes the receipt (the stale-marker alert covers it).
async function settle(id, phase, extra) {
  if (!id) return;
  try {
    await setPhase(id, phase, extra);
  } catch (err) {
    logger.error(`[start-program-marker] could not move marker ${id} to ${phase}: ${err.message}`);
  }
}

// The series the marker's booking would have made, for a marker still at 'booking'.
async function seriesExistsSince(marker) {
  const row = await db('scheduled_services')
    .where({ customer_id: marker.customerId, service_type: marker.target.catalogName, is_recurring: true })
    .where('created_at', '>=', marker.createdAt)
    .whereNotIn('status', ['cancelled', 'canceled'])
    .first('id');
  return !!row;
}

// The customer's open marker whose visits exist (a 'booking' marker is checked against the schedule and settled), else null.
async function findResumable(customerId) {
  if (!isUuid(customerId)) return null;
  const row = await db('audit_log')
    .where({ action: ACTION, resource_type: 'customer', resource_id: customerId })
    .whereRaw(OPEN_PHASES_SQL)
    .orderBy('created_at', 'desc')
    .first('id', 'resource_id', 'created_at', 'metadata');
  if (!row) return null;
  const marker = readMarker(row);
  if (marker.phase === 'booked_pending_bill') return marker;
  if (marker.phase !== 'booking') return null;
  if (await seriesExistsSince(marker)) {
    await setPhase(marker.id, 'booked_pending_bill', { found_by: 'schedule_check' });
    return { ...marker, phase: 'booked_pending_bill' };
  }
  await setPhase(marker.id, 'abandoned', { reason: 'no_series' });
  return null;
}

// One needs-you alert per stale open marker. A 'booking' marker with no series behind it is settled quietly.
async function sweepStalePending() {
  const cutoff = new Date(Date.now() - STALE_MINUTES * 60 * 1000);
  const rows = await db('audit_log')
    .where({ action: ACTION })
    .whereRaw(OPEN_PHASES_SQL)
    .whereRaw("metadata->>'alerted_at' IS NULL")
    .where('created_at', '<', cutoff)
    .orderBy('created_at', 'asc')
    .limit(25)
    .select('id', 'resource_id', 'created_at', 'metadata');
  let raised = 0;
  for (const row of rows) {
    const marker = readMarker(row);
    try {
      if (marker.phase === 'booking' && !(await seriesExistsSince(marker))) {
        await setPhase(marker.id, 'abandoned', { reason: 'no_series' });
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
      await mergeMeta(marker.id, { alerted_at: new Date().toISOString() });
      raised += 1;
    } catch (err) {
      logger.error(`[start-program-marker] stale marker ${marker.id} alert failed: ${err.message}`);
    }
  }
  return raised;
}

module.exports = { ACTION, STALE_MINUTES, writeMarker, setPhase, settle, findResumable, sweepStalePending, seriesExistsSince };
