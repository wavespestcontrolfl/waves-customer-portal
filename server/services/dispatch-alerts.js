/**
 * Sole writer for dispatch_alerts. Inserts a new alert row and emits
 * dispatch:alert to the dispatch:admins room *after* the transaction
 * commits — never before, never inside.
 *
 * Same atomicity + trx-optional + post-commit-emit pattern as
 * services/tech-status.js#upsertTechStatus and
 * services/job-status.js#transitionJobStatus. If the caller passes
 * their own trx, this function uses it for the insert and chains
 * the emit on trx.executionPromise. If no trx is passed, this
 * function creates one, commits, and emits inline.
 *
 * Why not just db.insert + emit? Because future generators will
 * trigger alerts inline with status transitions — e.g.,
 * "transitionJobStatus to 'completed' AND if no photo uploaded,
 * createAlert(missed_photo)". Both writes need to land atomically
 * or neither lands. Taking trx as an optional parameter today
 * means the call site stays clean tomorrow.
 *
 * dispatch:admins is the office room (admin sockets; technician
 * sockets too while GATE_TECH_LOGIN_PRIVACY is off). Customers
 * never join it and never receive alerts — these are dispatcher
 * coordination signals, not customer-facing notifications.
 *
 * No PII boundary equivalent to customer:job_update because the
 * channel is admin-only end-to-end. Generators are still expected
 * to keep payload reasonable (no pricing internals, no chemical
 * lots — those belong on detail-view fetches), but no enforcement
 * lives in this module. The dispatcher UI consuming the channel
 * is the client; payload shape is type-specific.
 *
 * Resolution also lives here. Single-card and bulk clears use
 * dispatch:alert_resolved so the right-pane can clean up cards in
 * real time across multiple connected dispatchers.
 */
const db = require('../models/db');
const { randomUUID } = require('crypto');
const { getIo } = require('../sockets');
const logger = require('./logger');

const EVENT = 'dispatch:alert';
const EVENT_RESOLVED = 'dispatch:alert_resolved';
const ROOM = 'dispatch:admins';

const VALID_SEVERITIES = ['info', 'warn', 'critical'];
const ALERT_COLUMNS = ['id', 'type', 'severity', 'tech_id', 'job_id', 'payload', 'created_at', 'resolved_at', 'resolved_by'];
const RESOLVED_ALERT_COLUMNS = [...ALERT_COLUMNS, 'resolution_attempt_id'];

function publicResolvedRow(row) {
  if (!row) return row;
  const { resolution_attempt_id: _attempt, ...publicRow } = row;
  return publicRow;
}

async function currentCreatedAlert(row, conn = db) {
  const review = require('./commercial-prepay-dispatch-review');
  if (row?.type !== review.REVIEW_TYPE) return row;
  try {
    const [hydrated] = await review.hydrateCurrentCustomerLinks(conn, [row]);
    return hydrated || { ...row, payload: { ...row.payload, customerId: null } };
  } catch (err) {
    // The card still needs to reach Dispatch after its insert commits, but an
    // unreadable ownership chain must never leave a stale customer link live.
    logger.error(`[dispatch-alerts] setup-review customer-link hydration failed: ${err.message}`);
    return { ...row, payload: { ...row.payload, customerId: null } };
  }
}

async function emitCreatedIfPersisted(row) {
  const persisted = await db('dispatch_alerts')
    .where({ id: row.id })
    .whereNull('resolved_at')
    .first(ALERT_COLUMNS);
  if (persisted) emitAlert(await currentCreatedAlert(persisted));
}

async function emitResolvedRowsIfPersisted(rows) {
  if (!rows.length) return;
  const expectedById = new Map(rows.map((row) => [String(row.id), row]));
  const persistedRows = await db('dispatch_alerts')
    .whereIn('id', rows.map((row) => row.id))
    .whereNotNull('resolved_at')
    .select(RESOLVED_ALERT_COLUMNS);
  persistedRows.forEach((persisted) => {
    const expected = expectedById.get(String(persisted.id));
    if (expected?.resolution_attempt_id
      && persisted.resolution_attempt_id === expected.resolution_attempt_id) {
      emitResolved(persisted);
    }
  });
}

function deferVerifiedBroadcast(trx, effect) {
  // Some installed Knex versions fulfill executionPromise after rollback,
  // including ROLLBACK TO SAVEPOINT. The transaction-chain wait is an
  // ordering fence; the committed-state read proves the requested write.
  require('../utils/trx-commit-promise').afterCommit(trx, () => Promise.resolve()
    .then(effect)
    .catch((err) => logger.error(`[dispatch-alerts] committed-state broadcast check failed: ${err.message}`)));
}

/**
 * Create a dispatch alert and broadcast it to dispatch:admins.
 *
 * @param {object} args
 * @param {string} args.type           required, free-form string. No
 *                                      DB-side CHECK — generators add
 *                                      new types as needed; the
 *                                      frontend renders by type with
 *                                      a generic fallback.
 * @param {string} [args.severity]     'info' | 'warn' | 'critical'.
 *                                      Defaults to 'info'. CHECK on
 *                                      the column rejects anything
 *                                      else.
 * @param {string} [args.techId]       optional, technicians.id the
 *                                      alert is scoped to
 * @param {string} [args.jobId]        optional, scheduled_services.id
 *                                      the alert is scoped to
 * @param {object} [args.payload]      optional, type-specific JSONB.
 *                                      Stored as-is; frontend reads
 *                                      per type.
 * @param {object} [args.trx]          optional Knex transaction; same
 *                                      semantics as transitionJobStatus
 *                                      — caller's trx + deferred emit,
 *                                      or owned trx + inline emit.
 * @returns {Promise<object>} the inserted row (id, type, severity,
 *                             tech_id, job_id, payload, created_at,
 *                             resolved_at, resolved_by)
 */
async function createAlert({ type, severity, techId, jobId, payload, trx } = {}) {
  if (!type) {
    throw new Error('createAlert: type is required');
  }
  const sev = severity || 'info';
  if (!VALID_SEVERITIES.includes(sev)) {
    // Pre-flight check matches the CHECK constraint so the caller
    // gets a clean JS error rather than a Postgres error string.
    throw new Error(`createAlert: invalid severity '${sev}' (expected one of ${VALID_SEVERITIES.join(', ')})`);
  }

  async function doWrite(t) {
    const [row] = await t('dispatch_alerts')
      .insert({
        type,
        severity: sev,
        tech_id: techId || null,
        job_id: jobId || null,
        payload: payload ? JSON.stringify(payload) : null,
      })
      .returning(['id', 'type', 'severity', 'tech_id', 'job_id', 'payload', 'created_at', 'resolved_at', 'resolved_by']);
    return row;
  }

  if (trx) {
    const row = await doWrite(trx);
    if (trx.executionPromise) {
      deferVerifiedBroadcast(trx, () => emitCreatedIfPersisted(row));
    } else {
      logger.warn('[dispatch-alerts] trx.executionPromise missing — emitting inline (test harness?)');
      emitAlert(await currentCreatedAlert(row, trx));
    }
    return row;
  }

  let captured;
  await db.transaction(async (innerTrx) => {
    captured = await doWrite(innerTrx);
  });
  // trx committed by here.
  emitAlert(await currentCreatedAlert(captured));
  return captured;
}

async function createAlertOnce({
  type,
  severity,
  techId,
  jobId,
  payload,
  trx,
  existingPayloadSource,
  existingPayloadServiceRecordId,
} = {}) {
  if (!type) {
    throw new Error('createAlertOnce: type is required');
  }
  const sev = severity || 'info';
  if (!VALID_SEVERITIES.includes(sev)) {
    throw new Error(`createAlertOnce: invalid severity '${sev}' (expected one of ${VALID_SEVERITIES.join(', ')})`);
  }

  async function doWrite(t) {
    const rows = await t('dispatch_alerts')
      .insert({
        type,
        severity: sev,
        tech_id: techId || null,
        job_id: jobId || null,
        payload: payload ? JSON.stringify(payload) : null,
      })
      .onConflict()
      .ignore()
      .returning(['id', 'type', 'severity', 'tech_id', 'job_id', 'payload', 'created_at', 'resolved_at', 'resolved_by']);

    if (rows[0]) return { row: rows[0], created: true };

    const existingQuery = t('dispatch_alerts')
      .where({ type, job_id: jobId || null })
      .whereNull('resolved_at');
    if (existingPayloadSource) {
      existingQuery.whereRaw("payload->>'source' = ?", [existingPayloadSource]);
    }
    if (existingPayloadServiceRecordId) {
      existingQuery.whereRaw("payload->>'serviceRecordId' = ?", [String(existingPayloadServiceRecordId)]);
    }
    const existing = await existingQuery
      .orderBy('created_at', 'desc')
      .first('id', 'type', 'severity', 'tech_id', 'job_id', 'payload', 'created_at', 'resolved_at', 'resolved_by');
    return { row: existing || null, created: false };
  }

  if (trx) {
    const result = await doWrite(trx);
    if (result.created && result.row) {
      if (trx.executionPromise) {
        deferVerifiedBroadcast(trx, () => emitCreatedIfPersisted(result.row));
      } else {
        logger.warn('[dispatch-alerts] trx.executionPromise missing — emitting inline (test harness?)');
        emitAlert(await currentCreatedAlert(result.row, trx));
      }
    }
    return result;
  }

  let result;
  await db.transaction(async (innerTrx) => {
    result = await doWrite(innerTrx);
  });
  if (result.created && result.row) emitAlert(await currentCreatedAlert(result.row));
  return result;
}

function emitAlert(row) {
  const io = getIo();
  if (!io) {
    logger.warn('[dispatch-alerts] io not initialized; skipping broadcast');
    return;
  }
  io.to(ROOM).emit(EVENT, row);
}

async function clearTrackingBells(t, rows) {
  const ids = rows.filter((row) => row?.payload?.source === 'no_show_detector').map((row) => String(row.id));
  if (ids.length) await require('./notification-service')._private.openToCloser(t('notifications').whereIn(t.raw("metadata->>'dispatch_alert_id'"), ids), 'dispatch')
    .update(require('./notification-service')._private.doneColumns({ by: 'dispatch', resolution: 'The dispatch alert was resolved', keepExisting: true, conn: t }));
}

/**
 * Mark an alert resolved and broadcast dispatch:alert_resolved.
 *
 * Idempotent at the DB layer: the UPDATE has `WHERE resolved_at IS NULL`,
 * so a second concurrent resolve from a different dispatcher is a no-op
 * — the second caller gets `null` back and no second broadcast fires.
 * Caller's route layer treats null as "not found OR already resolved"
 * and disambiguates with a follow-up SELECT (see admin-dispatch.js).
 *
 * Same trx-or-not + post-commit emit pattern as createAlert. Future
 * auto-resolve paths (e.g., transitionJobStatus to on_site clearing
 * tech_late alerts for that job) can pass their own trx; this module
 * doesn't emit until the outer trx commits.
 *
 * @param {object} args
 * @param {string} args.id           required, dispatch_alerts.id
 * @param {string} [args.resolvedBy] optional, technicians.id of the
 *                                   actor who resolved. Stored on the
 *                                   row for audit; not in the broadcast
 *                                   payload (other dispatchers don't
 *                                   need it for the cache eviction).
 * @param {object} [args.trx]        optional Knex transaction.
 * @param {boolean} [args.auto]      true when this resolve is a SYSTEM
 *                                   side effect (a status change, a
 *                                   reassignment clearing staleness, a
 *                                   tracking-key supersession) rather
 *                                   than a person explicitly clicking
 *                                   Resolve. Stamps payload.superseded_at
 *                                   on the same write — no-show-
 *                                   detector.js's alreadyHasOpenAlert /
 *                                   recordTrackingNotice dedupe checks
 *                                   read this stamp to tell "the system
 *                                   cleared this, a fresh alert under
 *                                   the same tracking_key may still be
 *                                   warranted" apart from a human's
 *                                   considered dismissal, which must
 *                                   keep blocking recreation (codex P1,
 *                                   pre-push audit on 925e9e977). A
 *                                   non-tracking alert type picks up an
 *                                   inert, unread extra payload key.
 * @returns {Promise<object|null>}   the resolved row, or null if no
 *                                   row matched (already resolved or
 *                                   id doesn't exist).
 */
async function resolveAlert({ id, resolvedBy, trx, auto = false } = {}) {
  if (!id) {
    throw new Error('resolveAlert: id is required');
  }

  const resolveAttemptId = randomUUID();
  async function doWrite(t) {
    const patch = {
      resolved_at: t.fn.now(),
      resolved_by: resolvedBy || null,
      // Durable proof of THIS resolving UPDATE. PostgreSQL now() is stable for
      // the whole outer transaction, so a rolled-back savepoint and its parent
      // can have identical resolved_at values; their random attempt ids cannot.
      resolution_attempt_id: resolveAttemptId,
    };
    if (auto) {
      patch.payload = t.raw("COALESCE(payload, '{}'::jsonb) || jsonb_build_object('superseded_at', ?::text)", [new Date().toISOString()]);
    }
    const rows = await t('dispatch_alerts')
      .where({ id })
      .whereNull('resolved_at')
      .update(patch)
      .returning(RESOLVED_ALERT_COLUMNS);
    // A MANUAL resolve that lost the race still has the last word on
    // provenance: an automatic write landing just before it stamps
    // superseded_at, the manual update then matches no unresolved row, and
    // the stamp would make no-show-detector's alreadyHasOpenAlert recreate a
    // card the dispatcher explicitly resolved. Clearing it here is the same
    // rule the tech-notification /dismiss route applies (codex P2, PR #4403
    // round 25).
    if (!auto && !rows.length) {
      await t('dispatch_alerts').where({ id }).whereNotNull('resolved_at')
        // A receipt episode superseded just before a dispatcher clicks
        // Resolve remains historical; clearing this marker could make it
        // current again beside the replacement episode.
        .whereRaw("payload->>'superseded_at' IS NOT NULL AND type <> 'commercial_prepay_setup_review'")
        .update({ resolved_by: resolvedBy || null,
          payload: t.raw("COALESCE(payload, '{}'::jsonb) - 'superseded_at'") });
    }
    const row = rows[0] || null;
    await clearTrackingBells(t, row ? [row] : []);
    return row;
  }

  if (trx) {
    const written = await doWrite(trx);
    if (!written) return null;
    if (trx.executionPromise) {
      deferVerifiedBroadcast(trx, () => emitResolvedRowsIfPersisted([written]));
    } else {
      logger.warn('[dispatch-alerts] trx.executionPromise missing — emitting inline (test harness?)');
      emitResolved(written);
    }
    return publicResolvedRow(written);
  }

  let captured;
  await db.transaction(async (innerTrx) => {
    captured = await doWrite(innerTrx);
  });
  if (!captured) return null;
  emitResolved(captured);
  return publicResolvedRow(captured);
}

// Resolved broadcast payload is intentionally narrow: just the id and
// the audit fields. Cards have already been hydrated with full data
// on the open broadcast — receivers only need to know "drop this id."
function emitResolved(row) {
  const io = getIo();
  if (!io) {
    logger.warn('[dispatch-alerts] io not initialized; skipping resolve broadcast');
    return;
  }
  io.to(ROOM).emit(EVENT_RESOLVED, {
    id: row.id,
    resolved_at: row.resolved_at,
    resolved_by: row.resolved_by,
  });
}

function summarizeResolvedAlerts(rows) {
  const byKey = new Map();
  for (const row of rows || []) {
    const type = row.type || 'unknown';
    const severity = row.severity || 'unknown';
    const key = `${type}\u0000${severity}`;
    const current = byKey.get(key) || { type, severity, count: 0 };
    current.count += 1;
    byKey.set(key, current);
  }
  return Array.from(byKey.values()).sort((a, b) => {
    if (b.count !== a.count) return b.count - a.count;
    if (a.type !== b.type) return a.type.localeCompare(b.type);
    return a.severity.localeCompare(b.severity);
  });
}

/**
 * Mark every currently open action-queue alert resolved.
 *
 * This is the operational "clear current Action Queue" path. Rows are
 * never deleted; resolved_at/resolved_by preserve the audit trail while
 * dispatch:alert_resolved broadcasts remove cards from connected boards.
 *
 * @param {object} args
 * @param {string} [args.resolvedBy] optional technicians.id of actor
 * @param {object} [args.trx] optional Knex transaction
 * @returns {Promise<{resolved: number, counts: Array, alerts: Array}>}
 */
async function resolveAllOpenAlerts({ resolvedBy, trx } = {}) {
  const resolveAttemptId = randomUUID();
  async function doWrite(t) {
    const rows = await t('dispatch_alerts')
      .whereNull('resolved_at')
      // decision-only cards are never swept away: closing one records nothing
      // Receipt-review episodes likewise require an explicit acknowledgement.
      .whereNotIn('type', [...DECISION_ONLY_ALERT_TYPES, 'commercial_prepay_setup_review'])
      .update({
        resolved_at: t.fn.now(),
        resolved_by: resolvedBy || null,
        resolution_attempt_id: resolveAttemptId,
      })
      .returning(RESOLVED_ALERT_COLUMNS);
    await clearTrackingBells(t, rows);
    return rows;
  }

  let rows;
  if (trx) {
    rows = await doWrite(trx);
    if (trx.executionPromise) {
      deferVerifiedBroadcast(trx, () => emitResolvedRowsIfPersisted(rows));
    } else {
      logger.warn('[dispatch-alerts] trx.executionPromise missing — emitting bulk resolves inline (test harness?)');
      rows.forEach(emitResolved);
    }
  } else {
    await db.transaction(async (innerTrx) => {
      rows = await doWrite(innerTrx);
    });
    rows.forEach(emitResolved);
  }

  return {
    resolved: rows.length,
    counts: summarizeResolvedAlerts(rows),
    alerts: rows.map(publicResolvedRow),
  };
}

// Statuses where any open OVERDUE-FAMILY alert (tech_late OR
// unassigned_overdue) for the job becomes meaningless and should
// be auto-cleared:
//   - on_site:   tech actually arrived; "running behind" is moot
//   - completed: job finished (with or without a prior on_site step)
//   - cancelled: job is off the route entirely
//   - skipped:   tech intentionally bypassed; not "late" anymore
//
// Excluded:
//   - rescheduled: ambiguous — the row may pick up a new window
//     where a fresh overdue-family alert would fire; auto-clearing
//     the old one risks hiding a still-valid signal. Dispatchers
//     can resolve manually.
//   - en_route:   tech started driving but hasn't arrived; still
//     "late" until on_site. (Doesn't apply to unassigned_overdue
//     since en_route requires a tech, but keeping the semantic
//     consistent across the family.)
const OVERDUE_ALERT_AUTO_RESOLVE_STATUSES = new Set([
  'on_site',
  'completed',
  'cancelled',
  'skipped',
  'no_show',
]);

// Cards that are settled ONLY by a recorded decision on the card itself (their
// own routes), never by the generic Resolve or the queue's Clear: closing one of
// these without a decision would drop the visit from the worklist with nothing
// recorded and nothing to bring it back (services/not-closed-out.js).
const DECISION_ONLY_ALERT_TYPES = Object.freeze(['visit_not_closed_out']);

/**
 * The Action Queue's single-card Resolve, shared by the board's route
 * (PATCH /admin/dispatch/alerts/:id/resolve) and the Intelligence Bar's
 * resolve_dispatch_alert card, so the two can never drift.
 *
 * A decision-only card (a visit not closed out) is settled by its own decision
 * routes; a bare resolve would close it and record nothing, so it is refused.
 * Otherwise resolveAlert runs (resolved_at + resolved_by, the linked tracking
 * bells closed, dispatch:alert_resolved broadcast after commit). Idempotent: a
 * card another dispatcher already resolved comes back as already_resolved with
 * its row, and writes and broadcasts nothing.
 *
 * With a trx the caller owns the transaction (the bar holds the alert row
 * FOR UPDATE in it); the reads here use it too.
 *
 * @returns {Promise<{outcome: 'decision_required'|'resolved'|'already_resolved'|'not_found', alert?: object}>}
 */
async function resolveAlertAsDispatcher({ id, resolvedBy, trx } = {}) {
  const conn = trx || db;
  const target = await conn('dispatch_alerts').where({ id }).first('type', 'resolved_at');
  if (target && !target.resolved_at && DECISION_ONLY_ALERT_TYPES.includes(target.type)) {
    return { outcome: 'decision_required' };
  }
  const row = await resolveAlert({ id, resolvedBy, trx });
  if (row) return { outcome: 'resolved', alert: row };

  const existing = await conn('dispatch_alerts').where({ id }).first(ALERT_COLUMNS);
  if (!existing) return { outcome: 'not_found' };
  return { outcome: 'already_resolved', alert: existing };
}

// Alert types in the "overdue family" — both fire on a slipping
// window, just from different scopes (assigned vs unassigned).
// Same terminal-status set clears both.
const OVERDUE_ALERT_TYPES = ['tech_late', 'unassigned_overdue'];

/**
 * Resolve every open overdue-family alert (tech_late +
 * unassigned_overdue) for a job when the job's new status makes
 * the "running late" signal obsolete. Used by:
 *   1. services/job-status.js#transitionJobStatus — the new
 *      sole-writer pattern (uses caller's trx for atomic resolve).
 *   2. routes/admin-dispatch.js PUT /:serviceId/status — the legacy
 *      direct-UPDATE route still in production. Invokes this helper
 *      with no trx since the legacy route doesn't transact its
 *      writes; resolveAlert owns its own trx scope per alert.
 *
 * Either path: each unresolved row goes through resolveAlert, which
 * handles the dispatch:alert_resolved broadcast (deferred on commit
 * if a trx is passed, inline otherwise) and the partial-unique-index
 * 23505 race protection.
 *
 * No-op for any toStatus not in OVERDUE_ALERT_AUTO_RESOLVE_STATUSES,
 * which makes it safe to call unconditionally on every status write.
 *
 * auto: true on every resolveAlert call here — a status transition
 * (including the arrival/on_site case) is a system side effect, never a
 * person acknowledging the alert card itself, so a wrong status reversed
 * later under the same promise + technician must still be able to raise
 * a fresh alert (codex P1, pre-push audit on 925e9e977).
 *
 * @returns {Promise<{resolved: number}>}
 */
async function autoResolveOverdueAlertsForJob({ jobId, resolvedBy, trx, toStatus } = {}) {
  if (!jobId || !OVERDUE_ALERT_AUTO_RESOLVE_STATUSES.has(toStatus)) {
    return { resolved: 0 };
  }
  const t = trx || db;
  const openAlerts = await t('dispatch_alerts')
    .whereIn('type', OVERDUE_ALERT_TYPES)
    .where({ job_id: jobId })
    .whereNull('resolved_at')
    .select('id');
  let resolved = 0;
  for (const { id } of openAlerts) {
    const row = await resolveAlert({ id, resolvedBy, trx, auto: true });
    if (row) resolved += 1;
  }
  return { resolved };
}

/**
 * Resolve a job's open unassigned_overdue alerts once it gains a technician:
 * "unassigned" is stale. Called inside the assignment's own transaction by
 * every writer that gives an unassigned visit a technician
 * (dispatch-assignment.js assignDispatchJob, the rebooker's single-row move).
 *
 * auto: true — assigning a tech is not the dispatcher acknowledging THIS
 * alert, it's a side effect that makes "unassigned" stale. If the visit is
 * later unassigned again under the same promise, a fresh unassigned_overdue
 * alert must still be raisable under the same tracking_key (codex P1,
 * pre-push audit on 925e9e977).
 */
async function autoResolveUnassignedAlertsForJob({ jobId, resolvedBy, trx } = {}) {
  const openAlerts = await (trx || db)('dispatch_alerts')
    .where({ type: 'unassigned_overdue', job_id: jobId })
    .whereNull('resolved_at')
    .select('id');
  for (const { id } of openAlerts) {
    await resolveAlert({ id, resolvedBy, trx, auto: true });
  }
}

module.exports = {
  emitAlert,
  createAlert,
  createAlertOnce,
  resolveAlert,
  resolveAlertAsDispatcher,
  resolveAllOpenAlerts,
  autoResolveOverdueAlertsForJob,
  autoResolveUnassignedAlertsForJob,
  OVERDUE_ALERT_AUTO_RESOLVE_STATUSES,
  OVERDUE_ALERT_TYPES,
  DECISION_ONLY_ALERT_TYPES,
  EVENT,
  EVENT_RESOLVED,
  ROOM,
  VALID_SEVERITIES,
};
