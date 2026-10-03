/**
 * "Visit not closed out" — the worklist behind the 6 PM missed-appointment check.
 *
 * That check logs reschedule_log `customer_noshow` for every visit still open at
 * 6 PM. Production (60 days to 2026-10-03): all 74 such rows came from the check;
 * 64% of the visits were later cancelled and 27% later completed. The row means
 * "not closed out", not "we missed it" — only a person knows which. Owner
 * 2026-10-03: give the office a card per flagged visit and record what they
 * decide (missed-visit-worklist rulings).
 *
 * One Action Queue card (dispatch_alerts, type 'visit_not_closed_out') per
 * flagged visit, gated by notClosedOutQueue. What settles a flagged row:
 *   - the visit is rebooked through the rebooker        → 'rebooked'
 *   - the visit is completed                            → 'completed'
 *   - the visit is cancelled / skipped                  → 'dismissed'
 *   - a person says "Not a miss" on the card            → 'dismissed'
 * and separately a person may say "This was a miss" (miss_confirmed_at): the row
 * stays open — it still needs rebooking — but is now a CONFIRMED miss. Only a
 * confirmed, unresolved row may ever reach a customer-facing apology.
 *
 * Every write here is best-effort from its caller's point of view: a failure to
 * stamp a resolution or raise a card must never fail a status change, a move or
 * the nightly check. Callers inside a transaction pass `trx`; this module then
 * runs in a savepoint so a hiccup cannot abort the caller's transaction.
 */
const db = require('../models/db');
const logger = require('./logger');
const { isEnabled } = require('../config/feature-gates');

const ALERT_TYPE = 'visit_not_closed_out';
const ALERT_SOURCE = 'missed_appointment_check';
const RESOLUTIONS = Object.freeze(['rebooked', 'completed', 'dismissed']);
// The status a visit moves TO → how its flagged rows settle. A person marking
// no_show is a confirmed miss that still needs rebooking: not a resolution.
const RESOLUTION_BY_STATUS = Object.freeze({ completed: 'completed', cancelled: 'dismissed', skipped: 'dismissed' });

const queueEnabled = () => isEnabled('notClosedOutQueue');
const dateOnly = (v) => (v instanceof Date ? v.toISOString().slice(0, 10) : (v ? String(v).slice(0, 10) : null));

// Run `fn(t)` in its own transaction, or — inside a caller's — in a savepoint,
// so an error here never poisons the caller's transaction.
function isolated(trx, fn) {
  return (trx || db).transaction(fn);
}

/**
 * Raise the card for a freshly logged flagged visit. `confirmed`: a person
 * marked the no-show (dispatch), so it is a confirmed miss from the start.
 */
async function raiseCard({ logId, service, confirmed = false, trx = null } = {}) {
  if (!queueEnabled() || !logId || !service || !service.id) return { raised: false };
  try {
    const { createAlertOnce } = require('./dispatch-alerts');
    const alert = {
      type: ALERT_TYPE,
      severity: 'warn',
      techId: service.technician_id || null,
      jobId: service.id,
      existingPayloadSource: ALERT_SOURCE,
      payload: {
        source: ALERT_SOURCE,
        log_id: String(logId),
        scheduled_date: dateOnly(service.scheduled_date),
        window_start: service.window_start || null,
        window_end: service.window_end || null,
        service_type: service.service_type || null,
        miss_confirmed: confirmed === true,
      },
    };
    // Inside a caller's transaction the insert runs in a savepoint: a database
    // error here must not abort the caller's transaction (the catch below alone
    // would leave it poisoned).
    const { created } = trx
      ? await trx.transaction((sp) => createAlertOnce({ ...alert, trx: sp }))
      : await createAlertOnce(alert);
    return { raised: created === true };
  } catch (err) {
    logger.warn(`[not-closed-out] card not raised for visit ${service.id}: ${err.message}`);
    return { raised: false };
  }
}

// Close every open card for a visit (auto: a system side effect, not a person
// acknowledging the card itself).
// dispatch_alerts.resolved_by is a uuid (a staff id); callers also pass labels such
// as the rebooker's initiatedBy ("admin", "customer") — those stay on the log row only.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
async function closeCards(t, jobId, resolvedBy) {
  const { resolveAlert } = require('./dispatch-alerts');
  const by = UUID_RE.test(String(resolvedBy || '')) ? resolvedBy : null;
  const open = await t('dispatch_alerts').where({ type: ALERT_TYPE, job_id: jobId }).whereNull('resolved_at').select('id');
  for (const { id } of open || []) await resolveAlert({ id, resolvedBy: by, trx: t, auto: true });
}

/**
 * Settle every unresolved flagged row of a visit and close its card.
 * @returns {Promise<{resolved: number}>}
 */
async function resolveForService({ serviceId, resolution, resolvedBy = null, trx = null } = {}) {
  if (!serviceId || !RESOLUTIONS.includes(resolution)) return { resolved: 0 };
  try {
    let resolved = 0;
    await isolated(trx, async (t) => {
      resolved = Number(await t('reschedule_log')
        .where({ scheduled_service_id: serviceId, reason_code: 'customer_noshow' })
        .whereNull('resolved_at')
        .update({ resolved_at: t.fn.now(), resolution, resolved_by: resolvedBy ? String(resolvedBy).slice(0, 80) : null })) || 0;
      await closeCards(t, serviceId, resolvedBy);
    });
    return { resolved };
  } catch (err) {
    logger.warn(`[not-closed-out] resolution '${resolution}' not recorded for visit ${serviceId}: ${err.message}`);
    return { resolved: 0 };
  }
}

/** job-status hook: a visit's new status settles its flagged rows (or not). */
async function resolveOnTransition({ jobId, toStatus, resolvedBy = null, trx = null } = {}) {
  const resolution = RESOLUTION_BY_STATUS[String(toStatus || '')];
  if (!jobId || !resolution) return { resolved: 0 };
  return resolveForService({ serviceId: jobId, resolution, resolvedBy, trx });
}

// One unresolved flagged row by id (the card's two person actions).
async function loadOpenLog(t, logId) {
  return t('reschedule_log')
    .where({ id: logId, reason_code: 'customer_noshow' })
    .whereNull('resolved_at')
    .first('id', 'scheduled_service_id', 'miss_confirmed_at');
}

/**
 * "This was a miss": the row stays open (it still needs rebooking) and is now a
 * confirmed miss. The card is replaced by one that says so, through the alert
 * writer, so every connected dispatcher sees the change.
 * @returns {Promise<{ok: boolean, reason?: string}>}
 */
async function confirmMiss({ logId, confirmedBy = null } = {}) {
  if (!logId) return { ok: false, reason: 'not_found' };
  return db.transaction(async (t) => {
    const log = await loadOpenLog(t, logId);
    if (!log) return { ok: false, reason: 'not_found' };
    if (!log.miss_confirmed_at) {
      await t('reschedule_log').where({ id: logId }).whereNull('resolved_at')
        .update({ miss_confirmed_at: t.fn.now(), miss_confirmed_by: confirmedBy ? String(confirmedBy).slice(0, 80) : null });
    }
    if (log.scheduled_service_id && queueEnabled()) {
      const service = await t('scheduled_services').where({ id: log.scheduled_service_id })
        .first('id', 'technician_id', 'scheduled_date', 'window_start', 'window_end', 'service_type');
      const stale = await t('dispatch_alerts').where({ type: ALERT_TYPE, job_id: log.scheduled_service_id }).whereNull('resolved_at').first('payload');
      const payload = stale && typeof stale.payload === 'string' ? JSON.parse(stale.payload) : (stale && stale.payload) || {};
      if (payload.miss_confirmed !== true) {
        await closeCards(t, log.scheduled_service_id, confirmedBy);
        // the card names the slot that was MISSED (its own payload), not the row's slot now
        if (service) {
          await raiseCard({
            logId,
            service: { ...service, scheduled_date: payload.scheduled_date || service.scheduled_date, window_start: payload.window_start ?? service.window_start, window_end: payload.window_end ?? service.window_end, service_type: payload.service_type || service.service_type },
            confirmed: true,
            trx: t,
          });
        }
      }
    }
    return { ok: true };
  });
}

/**
 * "Not a miss": settle this one row as dismissed and close the visit's card when
 * no other flagged row of the visit is still open.
 * @returns {Promise<{ok: boolean, reason?: string}>}
 */
async function dismiss({ logId, dismissedBy = null, note = null } = {}) {
  if (!logId) return { ok: false, reason: 'not_found' };
  return db.transaction(async (t) => {
    const log = await loadOpenLog(t, logId);
    if (!log) return { ok: false, reason: 'not_found' };
    const by = dismissedBy ? String(dismissedBy).slice(0, 80) : null;
    const reason = String(note || '').trim().slice(0, 200);
    await t('reschedule_log').where({ id: logId }).whereNull('resolved_at').update({
      resolved_at: t.fn.now(), resolution: 'dismissed', resolved_by: by,
      ...(reason ? { notes: t.raw("left(concat_ws(' | ', NULLIF(notes, ''), ?::text), 500)", [`not a miss: ${reason}`]) } : {}),
    });
    if (log.scheduled_service_id) {
      const stillOpen = await t('reschedule_log')
        .where({ scheduled_service_id: log.scheduled_service_id, reason_code: 'customer_noshow' })
        .whereNull('resolved_at').first('id');
      if (!stillOpen) await closeCards(t, log.scheduled_service_id, dismissedBy);
    }
    return { ok: true };
  });
}

module.exports = {
  ALERT_TYPE,
  ALERT_SOURCE,
  RESOLUTIONS,
  RESOLUTION_BY_STATUS,
  raiseCard,
  resolveForService,
  resolveOnTransition,
  confirmMiss,
  dismiss,
};
