/**
 * Sole writer for scheduled_services.status transitions going forward.
 * Wraps the status update + audit log insert in a single Knex
 * transaction and emits TWO Socket.io events *after* commit:
 *
 *   - customer:job_update    → customer:<customer_id> room (one customer)
 *   - dispatch:job_update    → dispatch:admins        room (all staff)
 *
 * Both fire from the same trx commit. Either both fire (commit) or
 * neither fires (rollback) — see "Post-commit emit" below. They go
 * to different rooms with different payloads (see PII BOUNDARY and
 * ADMIN PAYLOAD SCOPE blocks).
 *
 * Atomicity contract:
 *   The scheduled_services.status update AND the job_status_history
 *   insert MUST happen on the same trx handle. If they're split — even
 *   inside a try/catch — there is a window where the audit table says
 *   "transitioned to on_site" but the source-of-truth column still
 *   says "en_route" (or vice versa). Per-table separate transactions
 *   are not equivalent. The atomic guard below uses the shared trx
 *   for both writes. If either fails, both roll back and the emits
 *   never fire.
 *
 * Post-commit emit:
 *   Same pattern as services/tech-status.js#upsertTechStatus. If
 *   the caller passes their own `trx`, this function uses it for the
 *   writes and chains both emits on `trx.executionPromise` so the
 *   broadcasts fire after the caller's commit, and are suppressed if
 *   the caller rolls back. If no trx is passed, this function creates
 *   one, commits it, and emits inline. Either way, the trx scope
 *   wraps both writes and the emits happen after commit.
 *
 *   Both emits chain on the same promise — they fire in sequence
 *   after commit. There's no scenario where one fires and the other
 *   doesn't (short of the io instance disappearing between calls,
 *   which would be a runtime crash, not a leak).
 *
 * Atomic guard:
 *   The status update is gated on the row currently holding
 *   `fromStatus` — if a racing transition already advanced past it,
 *   the UPDATE affects 0 rows and the function throws. Same shape as
 *   track-transitions.markEnRoute. fromStatus is required (Codex P1
 *   on #290) — null was a footgun that bypassed the guard.
 *
 * Auto-resolve overdue-family alerts on terminal-ish transitions:
 *   When toStatus is in OVERDUE_ALERT_AUTO_RESOLVE_STATUSES (on_site,
 *   completed, cancelled, skipped), any open tech_late OR
 *   unassigned_overdue alert for the job is resolved inside the SAME
 *   trx via resolveAlert(trx). The dispatch:alert_resolved broadcast
 *   chains on the same commit, so the Action Queue cards disappear
 *   for every connected dispatcher the instant the job moves to
 *   on_site (etc.). If the outer transition rolls back, the alert
 *   resolution rolls back too.
 *
 * ============================================================
 * PII BOUNDARY — READ THIS BEFORE MODIFYING THE CUSTOMER PAYLOAD
 * ============================================================
 *   The `customer:job_update` payload is sent to a customer's own
 *   room, where it is consumed by the customer's portal / live
 *   tracker UI. The customer can inspect this object via browser
 *   devtools — assume every field reaches them.
 *
 *   The current allowlist:
 *     job_id, status, eta, tech_id, tech_first_name, updated_at
 *
 *   NEVER include in this payload:
 *     - tech last name
 *     - tech license number, certifications, contact info
 *     - internal job notes (notes, internal_notes, technician_notes)
 *     - profit / cost / pricing data
 *     - product names, EPA reg numbers, application rates,
 *       chemical lot numbers, dilution rates
 *     - other customers' data (cross-customer contamination)
 *     - admin-only fields from scheduled_services (anything that
 *       an admin route filters on but a customer route doesn't)
 *
 *   Customer-facing payload — additions to this object require
 *   security review. Internal/admin data flows via dispatch:job_update
 *   only — that event broadcasts to staff (dispatch:admins room),
 *   not to customers, so admin-only fields belong on the admin
 *   payload below.
 * ============================================================
 *
 * ============================================================
 * ADMIN PAYLOAD SCOPE — what dispatch:job_update can carry
 * ============================================================
 *   The `dispatch:job_update` payload is sent only to dispatch:admins
 *   (staff: admin + technician), so it MAY include data that the
 *   customer payload above redacts:
 *
 *     - tech full name
 *     - customer first name (display in roster) — full
 *       customer record stays in the admin detail-view fetch,
 *       not on this real-time event
 *     - service_type (what's being done)
 *     - scheduled_date / window_start / window_end (timing)
 *     - notes (gate codes, dog warnings — coordinator context)
 *     - internal_notes (dispatcher-to-tech context)
 *     - from_status (so the board can animate the transition)
 *     - transitioned_by (audit attribution on-screen)
 *
 *   It does NOT carry, even on the admin path:
 *     - pricing / profit / cost (admin-only detail-view fetch)
 *     - product names / EPA reg numbers / dilution / lot numbers
 *       (compliance audit, not real-time roster context)
 *     - other customers' rows (one event = one job)
 *     - any field added to scheduled_services after this PR without
 *       a maintainer reviewing whether it belongs on a real-time
 *       event vs. an on-click fetch
 *
 *   Rule of thumb: this payload is what the dispatch board's
 *   left-pane roster and Gantt timeline need to RE-RENDER without
 *   an extra fetch. Anything richer (full chemical history, profit
 *   margin, customer's saved payment methods) is detail-view work
 *   and should be fetched on click, not pushed.
 * ============================================================
 */
const db = require('../models/db');
const { getIo } = require('../sockets');
const logger = require('./logger');
const { autoResolveOverdueAlertsForJob } = require('./dispatch-alerts');

const CUSTOMER_EVENT = 'customer:job_update';
const ADMIN_EVENT = 'dispatch:job_update';
const ADMIN_ROOM = 'dispatch:admins';

function customerRoom(customerId) {
  return `customer:${customerId}`;
}

/**
 * Build BOTH the customer-facing and admin-facing payloads from a
 * freshly-committed row. Reads via the trx so we see post-update
 * values without an extra round-trip after commit. Single LEFT JOIN
 * pulls every column either payload needs in one query.
 *
 * @returns {Promise<{
 *   customerId: string,
 *   customerPayload: object,
 *   adminPayload: object,
 * }>}
 */
async function buildPayloads(trx, jobId, fromStatus, toStatus, transitionedBy) {
  const row = await trx('scheduled_services as s')
    .leftJoin('technicians as t', 's.technician_id', 't.id')
    .leftJoin('customers as c', 's.customer_id', 'c.id')
    .where('s.id', jobId)
    .first(
      's.id as job_id',
      's.customer_id',
      's.technician_id as tech_id',
      's.service_type',
      's.scheduled_date',
      's.window_start',
      's.window_end',
      's.notes',
      's.internal_notes',
      's.updated_at',
      't.name as tech_full_name',
      'c.first_name as cust_first_name'
    );
  if (!row) throw new Error(`transitionJobStatus: job ${jobId} not found`);

  const techFirstName = row.tech_full_name
    ? row.tech_full_name.split(' ')[0]
    : null;

  const customerPayload = {
    // ── PII BOUNDARY: see file header. Strict allowlist. ─────────────
    job_id: row.job_id,
    status: toStatus,
    eta: null, // ETA derivation lands in a future PR; field included
               // now for forward compat with the customer tracker UI.
               // When wired, source from BouncieService.calculateETA
               // for status='en_route'; null for other statuses.
    tech_id: row.tech_id,
    tech_first_name: techFirstName,
    updated_at: row.updated_at,
  };

  const adminPayload = {
    // ── ADMIN PAYLOAD SCOPE: see file header. Broader than customer
    //    but still excludes pricing / products / EPA / etc. ──────────
    job_id: row.job_id,
    customer_id: row.customer_id,
    cust_first_name: row.cust_first_name, // customer-first-name only;
                                          // last name stays in detail
                                          // fetch (less PII surface
                                          // even on admin channel)
    status: toStatus,
    from_status: fromStatus,
    tech_id: row.tech_id,
    tech_full_name: row.tech_full_name,   // admin sees full name
    service_type: row.service_type,
    scheduled_date: row.scheduled_date,
    window_start: row.window_start,
    window_end: row.window_end,
    notes: row.notes,
    internal_notes: row.internal_notes,
    transitioned_by: transitionedBy,
    updated_at: row.updated_at,
  };

  return {
    customerId: row.customer_id,
    customerPayload,
    adminPayload,
  };
}

/**
 * Transition a scheduled_services row from fromStatus to toStatus.
 * Writes the status column and appends to job_status_history in the
 * same transaction; emits customer:job_update AND dispatch:job_update
 * after commit (both fire, or neither fires).
 *
 * @param {object} args
 * @param {string} args.jobId           required, scheduled_services.id
 * @param {string} args.fromStatus      required for the atomic guard.
 *                                       Must match the row's current
 *                                       status; null/undefined rejected.
 * @param {string} args.toStatus        required, must be in the
 *                                       scheduled_services_status_check
 *                                       value set
 * @param {string} args.transitionedBy  required, technicians.id of the
 *                                       admin/tech who triggered it
 * @param {object} [args.trx]           optional Knex transaction; if
 *                                       passed, both writes use it and
 *                                       BOTH emits chain on commit. If
 *                                       not passed, this function owns
 *                                       the trx end-to-end.
 * @returns {Promise<{customerPayload: object, adminPayload: object}>}
 *           the two payloads broadcast (or, with an outer trx, the
 *           payloads that will broadcast on commit)
 */
async function transitionJobStatus({ jobId, fromStatus, toStatus, transitionedBy, trx }) {
  if (!jobId || !toStatus || fromStatus == null) {
    throw new Error(
      'transitionJobStatus: jobId, fromStatus, and toStatus are required'
    );
  }

  async function doWrites(t) {
    // Atomic guard: only update if the row is currently in fromStatus.
    // 0-row update means a racing transition already advanced past it
    // (or fromStatus is wrong). Either way, we abort — the audit log
    // would otherwise record a transition that didn't happen on the
    // source table.
    const updated = await t('scheduled_services')
      .where({ id: jobId, status: fromStatus })
      .update({ status: toStatus, updated_at: t.fn.now() });
    if (updated === 0) {
      throw new Error(
        `transitionJobStatus: ${jobId} not in state ${fromStatus} (racing transition or stale fromStatus)`
      );
    }

    // Audit log on the SAME trx. If the insert fails, the status
    // update above rolls back too — that's the atomicity guarantee.
    await t('job_status_history').insert({
      job_id: jobId,
      from_status: fromStatus,
      to_status: toStatus,
      transitioned_by: transitionedBy || null,
    });

    // Auto-resolve any open overdue-family alerts (tech_late +
    // unassigned_overdue) when the transition makes the "running
    // late" signal obsolete. Same trx — if the outer transition
    // rolls back, the alert resolution rolls back with it. The
    // helper internally calls resolveAlert(trx), which defers the
    // dispatch:alert_resolved broadcast to commit and suppresses on
    // rollback (PR #311). No-op for non-terminal toStatus, so safe
    // to call unconditionally.
    await autoResolveOverdueAlertsForJob({
      jobId, resolvedBy: transitionedBy, trx: t, toStatus,
    });

    return buildPayloads(t, jobId, fromStatus, toStatus, transitionedBy);
  }

  function emitBoth(customerId, customerPayload, adminPayload) {
    // Customer event first, then admin event. Order doesn't matter
    // semantically (different rooms, different payloads, different
    // consumers) but keeping a deterministic sequence makes log
    // ordering easier to follow.
    emitToCustomer(customerId, customerPayload);
    emitToAdmins(adminPayload);
  }

  if (trx) {
    // Caller-owned trx. Do the writes; defer both emits until the
    // caller's outer transaction resolves. trx.executionPromise is
    // the promise returned by db.transaction(fn) — resolves on
    // commit, rejects on rollback.
    const { customerId, customerPayload, adminPayload } = await doWrites(trx);
    if (trx.executionPromise) {
      trx.executionPromise
        .then(() => emitBoth(customerId, customerPayload, adminPayload))
        .catch(() => {
          // Rollback path. Caller will see the rejection on their
          // db.transaction() promise; we just suppress both emits.
        });
    } else {
      // Defensive: some Knex test harnesses may pass a bare object as
      // trx. Fall back to inline emit (caller is responsible for
      // commit ordering in that case).
      logger.warn('[job-status] trx.executionPromise missing — emitting inline (test harness?)');
      emitBoth(customerId, customerPayload, adminPayload);
    }
    return { customerPayload, adminPayload };
  }

  // No outer trx — own the lifecycle end-to-end.
  let captured;
  await db.transaction(async (innerTrx) => {
    captured = await doWrites(innerTrx);
  });
  // trx committed by here.
  emitBoth(captured.customerId, captured.customerPayload, captured.adminPayload);
  return {
    customerPayload: captured.customerPayload,
    adminPayload: captured.adminPayload,
  };
}

function emitToCustomer(customerId, payload) {
  const io = getIo();
  if (!io) {
    logger.warn('[job-status] io not initialized; skipping customer broadcast');
    return;
  }
  io.to(customerRoom(customerId)).emit(CUSTOMER_EVENT, payload);
}

function emitToAdmins(payload) {
  const io = getIo();
  if (!io) {
    logger.warn('[job-status] io not initialized; skipping admin broadcast');
    return;
  }
  io.to(ADMIN_ROOM).emit(ADMIN_EVENT, payload);
}

module.exports = {
  transitionJobStatus,
  CUSTOMER_EVENT,
  ADMIN_EVENT,
  ADMIN_ROOM,
  customerRoom,
};
