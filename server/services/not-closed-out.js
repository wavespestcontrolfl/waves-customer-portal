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
 *   - a person presses "Done" on a confirmed miss       → 'handled'
 *     (a no_show visit is terminal: it cannot be moved, so its rebooking is a
 *     new appointment and only a person can say it was dealt with)
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
const RESOLUTIONS = Object.freeze(['rebooked', 'completed', 'dismissed', 'handled']);
// The status a visit moves TO → how its flagged rows settle. A person marking
// no_show is a confirmed miss that still needs rebooking: not a resolution.
const RESOLUTION_BY_STATUS = Object.freeze({ completed: 'completed', cancelled: 'dismissed', skipped: 'dismissed' });

const queueEnabled = () => isEnabled('notClosedOutQueue');
const dateOnly = (v) => (v instanceof Date ? v.toISOString().slice(0, 10) : (v ? String(v).slice(0, 10) : null));

/**
 * Is the visit — read under its row lock — still the no-show occurrence a flagged
 * row recorded (`date` + `window` = the row's original_date / original_window)?
 * A manual no-show is recorded after its status change committed, so a rebook, a
 * completion or a second no-show can land first; the occurrence key is the slot,
 * not the visit row. A NULL date or window on the row matches (legacy rows).
 */
function isSameNoShowOccurrence(visit, { date = null, window = null } = {}) {
  if (!visit || visit.status !== 'no_show') return false;
  if (date && dateOnly(date) !== dateOnly(visit.scheduled_date)) return false;
  const visitWindow = visit.window_start ? `${visit.window_start}-${visit.window_end}` : null;
  if (window && window !== visitWindow) return false;
  return true;
}

// Run `fn(t)` in its own transaction, or — inside a caller's — in a savepoint,
// so an error here never poisons the caller's transaction.
function isolated(trx, fn) {
  return (trx || db).transaction(fn);
}

/**
 * Raise the card for a freshly logged flagged visit. `confirmed`: a person
 * marked the no-show (dispatch), so it is a confirmed miss from the start.
 * `strict`: the card REPLACES one the caller just closed in the same transaction
 * (a decision). A failure is thrown so that transaction rolls back and the old
 * card stays — never an open flagged row with no card.
 */
async function raiseCard({ logId, service, confirmed = false, trx = null, strict = false } = {}) {
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
    if (strict) throw err;
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

/**
 * Settle the flagged rows of every visit a series move moved. One read finds the
 * few (usually zero) moved visits that carry an open flagged row; only those are
 * settled, each as resolveForService does.
 * @returns {Promise<{resolved: number}>}
 */
async function resolveForServices({ serviceIds, resolution, resolvedBy = null, trx = null } = {}) {
  const ids = [...new Set((serviceIds || []).filter(Boolean).map(String))];
  if (!ids.length || !RESOLUTIONS.includes(resolution)) return { resolved: 0 };
  let flagged = [];
  try {
    flagged = await isolated(trx, (t) => t('reschedule_log')
      .whereIn('scheduled_service_id', ids)
      .where({ reason_code: 'customer_noshow' })
      .whereNull('resolved_at')
      .select('scheduled_service_id'));
  } catch (err) {
    logger.warn(`[not-closed-out] flagged rows of a series move not read: ${err.message}`);
    return { resolved: 0 };
  }
  let resolved = 0;
  for (const serviceId of new Set((Array.isArray(flagged) ? flagged : []).map((r) => String(r.scheduled_service_id)))) {
    resolved += (await resolveForService({ serviceId, resolution, resolvedBy, trx })).resolved;
  }
  return { resolved };
}

/** job-status hook: a visit's new status settles its flagged rows (or not). */
async function resolveOnTransition({ jobId, toStatus, resolvedBy = null, trx = null } = {}) {
  const resolution = RESOLUTION_BY_STATUS[String(toStatus || '')];
  if (!jobId || !resolution) return { resolved: 0 };
  return resolveForService({ serviceId: jobId, resolution, resolvedBy, trx });
}

// One flagged row by id, LOCKED: the two person decisions, a completion, a
// cancellation and a rebooker move all settle the same row, so a decision reads it
// under FOR UPDATE and acts on what the lock shows — never on an earlier read.
async function lockLog(t, logId) {
  return t('reschedule_log')
    .where({ id: logId, reason_code: 'customer_noshow' })
    .forUpdate()
    .first('id', 'scheduled_service_id', 'customer_id', 'resolved_at', 'miss_confirmed_at', 'original_date', 'original_window');
}

// Every decision takes the VISIT's row lock before the log row's — the order a
// status change, a move and the nightly check take them (visit lock, then the
// visit's flagged rows). The other order deadlocks against them: a replacement
// card's job_id foreign key needs a share lock on the visit while they wait on
// the log row.
async function lockVisitThenLog(t, logId) {
  const ref = await t('reschedule_log').where({ id: logId, reason_code: 'customer_noshow' }).first('scheduled_service_id');
  if (!ref) return { visit: null, log: null };
  const visit = ref.scheduled_service_id
    ? await t('scheduled_services').where({ id: ref.scheduled_service_id }).forUpdate().first('id', 'status', 'scheduled_date', 'window_start', 'window_end')
    : null;
  return { visit: visit || null, log: await lockLog(t, logId) };
}

// The slot a flagged row recorded as missed ("HH:MM:SS-HH:MM:SS"), for its card.
function loggedSlot(log) {
  const [start, end] = String((log && log.original_window) || '').split('-');
  return { scheduled_date: dateOnly(log && log.original_date), window_start: start || null, window_end: end || null };
}

/**
 * "This was a miss": the row stays open (it still needs rebooking) and is now a
 * confirmed miss. The card is replaced by one that says so, through the alert
 * writer, so every connected dispatcher sees the change.
 *
 * `reopen`: a person marking the visit no-show in dispatch when the nightly check
 * had ALREADY flagged that same occurrence (admin-dispatch skips a second log
 * row). That person's call stands even on a row settled earlier — a "not a miss"
 * dismissal or the backlog clear — so the row is reopened as a confirmed miss.
 * The card's own button never reopens: a settled row is `not_found` there.
 * A reopen runs after the no-show transition committed, so it holds only while the
 * visit, read under its own lock, is still that no-show occurrence: one that was
 * rebooked or completed in between keeps the settlement it got (`visit_moved_on`).
 * @returns {Promise<{ok: boolean, reason?: string}>}
 */
async function confirmMiss({ logId, confirmedBy = null, reopen = false } = {}) {
  if (!logId) return { ok: false, reason: 'not_found' };
  let newlyConfirmedFor = null;
  const result = await db.transaction(async (t) => {
    const { visit, log } = await lockVisitThenLog(t, logId);
    if (!log) return { ok: false, reason: 'not_found' };
    if (!log.miss_confirmed_at) newlyConfirmedFor = log.customer_id || null;
    if (log.resolved_at && !reopen) return { ok: false, reason: 'not_found' };
    const by = confirmedBy ? String(confirmedBy).slice(0, 80) : null;
    if (log.resolved_at) {
      if (!isSameNoShowOccurrence(visit, { date: log.original_date, window: log.original_window })) {
        newlyConfirmedFor = null;
        return { ok: false, reason: 'visit_moved_on' };
      }
      await t('reschedule_log').where({ id: logId })
        .update({ resolved_at: null, resolution: null, resolved_by: null, miss_confirmed_at: t.fn.now(), miss_confirmed_by: by });
    } else if (!log.miss_confirmed_at) {
      await t('reschedule_log').where({ id: logId })
        .update({ miss_confirmed_at: t.fn.now(), miss_confirmed_by: by });
    }
    // The stale card is closed whether or not the queue gate is still on (a gate
    // turned off must not strand a decision-only card); raiseCard itself is gated.
    if (log.scheduled_service_id) {
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
            strict: true,
          });
        }
      }
    }
    return { ok: true };
  });
  // The repeated-miss outreach task counts person-confirmed misses only while the
  // queue is on (missed-appointment.js evaluateThreshold), so a first confirmation
  // is when it is evaluated. After the commit; never fails the decision.
  if (result.ok && newlyConfirmedFor && queueEnabled()) {
    try {
      await require('./workflows/missed-appointment').evaluateThreshold(newlyConfirmedFor, 'confirmed_miss');
    } catch (err) {
      logger.warn(`[not-closed-out] outreach evaluation failed after a confirmed miss: ${err.message}`);
    }
  }
  return result;
}

// A person settled one flagged row. Close the visit's card when no other flagged
// row of the visit is still open; otherwise hand the card to the row still open.
// Card cleanup runs whether or not the queue gate is on; raiseCard is gated.
async function cardAfterSettle(t, log, settledBy) {
  if (!log.scheduled_service_id) return;
  const stillOpen = await t('reschedule_log')
    .where({ scheduled_service_id: log.scheduled_service_id, reason_code: 'customer_noshow' })
    .whereNull('resolved_at').orderBy('created_at', 'desc')
    .first('id', 'miss_confirmed_at', 'original_date', 'original_window');
  if (!stillOpen) {
    await closeCards(t, log.scheduled_service_id, settledBy);
    return;
  }
  // A card that pointed at the row just settled would come back on reload with
  // buttons that only answer not_found: replace it with one for the row that
  // still needs a call.
  const open = await t('dispatch_alerts').where({ type: ALERT_TYPE, job_id: log.scheduled_service_id }).whereNull('resolved_at').first('payload');
  const payload = open && typeof open.payload === 'string' ? JSON.parse(open.payload) : (open && open.payload) || {};
  if (String(payload.log_id || '') === String(stillOpen.id)) return;
  await closeCards(t, log.scheduled_service_id, settledBy);
  const service = await t('scheduled_services').where({ id: log.scheduled_service_id })
    .first('id', 'technician_id', 'scheduled_date', 'window_start', 'window_end', 'service_type');
  if (!service) return;
  const slot = loggedSlot(stillOpen);
  await raiseCard({
    logId: stillOpen.id,
    service: slot.scheduled_date ? { ...service, ...slot } : service,
    confirmed: !!stillOpen.miss_confirmed_at,
    trx: t,
    strict: true,
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
    const { log } = await lockVisitThenLog(t, logId);
    if (!log || log.resolved_at) return { ok: false, reason: 'not_found' };
    const by = dismissedBy ? String(dismissedBy).slice(0, 80) : null;
    const reason = String(note || '').trim().slice(0, 200);
    await t('reschedule_log').where({ id: logId }).whereNull('resolved_at').update({
      resolved_at: t.fn.now(), resolution: 'dismissed', resolved_by: by,
      ...(reason ? { notes: t.raw("left(concat_ws(' | ', NULLIF(notes, ''), ?::text), 500)", [`not a miss: ${reason}`]) } : {}),
    });
    await cardAfterSettle(t, log, dismissedBy);
    return { ok: true };
  });
}

/**
 * "Done" on a CONFIRMED miss: the office dealt with it (the customer was rebooked
 * on a new appointment, or declined). A no_show visit is terminal — it cannot be
 * moved or completed — so nothing else can settle its row. An unconfirmed row is
 * `not_confirmed`: it is settled by closing the visit out or by "Not a miss".
 * @returns {Promise<{ok: boolean, reason?: string}>}
 */
async function markHandled({ logId, handledBy = null } = {}) {
  if (!logId) return { ok: false, reason: 'not_found' };
  return db.transaction(async (t) => {
    const { log } = await lockVisitThenLog(t, logId);
    if (!log || log.resolved_at) return { ok: false, reason: 'not_found' };
    if (!log.miss_confirmed_at) return { ok: false, reason: 'not_confirmed' };
    await t('reschedule_log').where({ id: logId }).whereNull('resolved_at').update({
      resolved_at: t.fn.now(), resolution: 'handled', resolved_by: handledBy ? String(handledBy).slice(0, 80) : null,
    });
    await cardAfterSettle(t, log, handledBy);
    return { ok: true };
  });
}

/**
 * Raise the card for every open flagged row that has none. A first card is
 * best-effort (raiseCard never fails the nightly check or a status change), and
 * the check skips an occurrence it already logged — so without this pass a card
 * whose insert failed once would never appear. Run by the nightly check after its
 * own flags. Each card is raised under the visit's lock, re-reading the row, so a
 * visit settled in between gets none. Rows older than `days` are left alone.
 * @returns {Promise<{raised: number}>}
 */
async function backfillMissingCards({ days = 7 } = {}) {
  if (!queueEnabled()) return { raised: 0 };
  let raised = 0;
  try {
    const open = await db('reschedule_log')
      .where({ reason_code: 'customer_noshow' })
      .whereNull('resolved_at')
      .where('created_at', '>', db.raw("NOW() - (?::int * INTERVAL '1 day')", [days]))
      .orderBy('created_at', 'desc')
      .select('id', 'scheduled_service_id');
    const seen = new Set();
    for (const row of Array.isArray(open) ? open : []) {
      const visitId = row.scheduled_service_id;
      if (!visitId || seen.has(String(visitId))) continue;
      seen.add(String(visitId));
      const hasCard = await db('dispatch_alerts').where({ type: ALERT_TYPE, job_id: visitId }).whereNull('resolved_at').first('id');
      if (hasCard) continue;
      try {
        const result = await db.transaction(async (t) => {
          const { log } = await lockVisitThenLog(t, row.id);
          if (!log || log.resolved_at) return { raised: false };
          const service = await t('scheduled_services').where({ id: visitId })
            .first('id', 'technician_id', 'scheduled_date', 'window_start', 'window_end', 'service_type');
          if (!service) return { raised: false };
          const slot = loggedSlot(log);
          return raiseCard({ logId: log.id, service: slot.scheduled_date ? { ...service, ...slot } : service, confirmed: !!log.miss_confirmed_at, trx: t });
        });
        if (result && result.raised) raised += 1;
      } catch (err) {
        logger.warn(`[not-closed-out] missing card not raised for visit ${visitId}: ${err.message}`);
      }
    }
  } catch (err) {
    logger.warn(`[not-closed-out] missing-card pass failed: ${err.message}`);
  }
  return { raised };
}

module.exports = {
  ALERT_TYPE,
  ALERT_SOURCE,
  RESOLUTIONS,
  RESOLUTION_BY_STATUS,
  isSameNoShowOccurrence,
  raiseCard,
  resolveForService,
  resolveForServices,
  resolveOnTransition,
  confirmMiss,
  dismiss,
  markHandled,
  backfillMissingCards,
  queueEnabled,
};
