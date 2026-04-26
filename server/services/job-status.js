/**
 * Sole writer for scheduled_services.status transitions going forward.
 * Wraps the status update + audit log insert in a single Knex
 * transaction and emits customer:job_update to the customer:<id>
 * room *after* the transaction commits — never before, never inside.
 *
 * Atomicity contract:
 *   The scheduled_services.status update AND the job_status_history
 *   insert MUST happen on the same trx handle. If they're split — even
 *   inside a try/catch — there is a window where the audit table says
 *   "transitioned to on_site" but the source-of-truth column still
 *   says "en_route" (or vice versa). Per-table separate transactions
 *   are not equivalent. The atomic guard below uses the shared trx
 *   for both writes. If either fails, both roll back and the emit
 *   never fires.
 *
 * Post-commit emit:
 *   Same pattern as services/tech-status.js#upsertTechStatus. If
 *   the caller passes their own `trx`, this function uses it for the
 *   writes and chains the emit on `trx.executionPromise` so the
 *   broadcast fires after the caller's commit, and is suppressed if
 *   the caller rolls back. If no trx is passed, this function creates
 *   one, commits it, and emits inline. Either way, the trx scope
 *   wraps both writes and the emit happens after commit.
 *
 * Atomic guard:
 *   The status update is gated on the row currently holding
 *   `fromStatus` — if a racing transition already advanced past it,
 *   the UPDATE affects 0 rows and the function throws. This is the
 *   same shape as track-transitions.markEnRoute. fromStatus may be
 *   null only if the caller is operating on a row whose status has
 *   never been set (legacy default), but in practice every job has a
 *   status.
 *
 * ============================================================
 * PII BOUNDARY — READ THIS BEFORE MODIFYING THE PAYLOAD
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
 *   only (separate PR — admin counterpart, broadcast to dispatch:admins).
 * ============================================================
 */
const db = require('../models/db');
const { getIo } = require('../sockets');
const logger = require('./logger');

const EVENT = 'customer:job_update';

function customerRoom(customerId) {
  return `customer:${customerId}`;
}

/**
 * Build the customer-facing payload from a freshly-committed row.
 * Reads via the trx so we see post-update values without an extra
 * round-trip after commit. Field set is the strict allowlist —
 * see PII BOUNDARY in this file's header.
 *
 * @returns {Promise<{customerId: string, payload: object}>}
 */
async function buildCustomerPayload(trx, jobId, toStatus) {
  const row = await trx('scheduled_services as s')
    .leftJoin('technicians as t', 's.technician_id', 't.id')
    .where('s.id', jobId)
    .first(
      's.id as job_id',
      's.customer_id',
      's.technician_id as tech_id',
      's.updated_at',
      't.name as tech_full_name'
    );
  if (!row) throw new Error(`transitionJobStatus: job ${jobId} not found`);

  // Tech first name only — never last name. technicians.name is full
  // name; split on the first space. If the row has no tech assigned
  // yet (technician_id null), tech_first_name is null too.
  const techFirstName = row.tech_full_name
    ? row.tech_full_name.split(' ')[0]
    : null;

  return {
    customerId: row.customer_id,
    payload: {
      job_id: row.job_id,
      status: toStatus,
      eta: null, // ETA derivation lands in a future PR; field included
                 // now for forward compat with the customer tracker UI.
                 // When wired, source from BouncieService.calculateETA
                 // for status='en_route'; null for other statuses.
      tech_id: row.tech_id,
      tech_first_name: techFirstName,
      updated_at: row.updated_at,
    },
  };
}

/**
 * Transition a scheduled_services row from fromStatus to toStatus.
 * Writes the status column and appends to job_status_history in the
 * same transaction; emits customer:job_update after commit.
 *
 * @param {object} args
 * @param {string} args.jobId           required, scheduled_services.id
 * @param {string|null} args.fromStatus required for the atomic guard
 *                                       (use null only for legacy rows
 *                                       with no prior status)
 * @param {string} args.toStatus        required, must be in the
 *                                       scheduled_services_status_check
 *                                       value set
 * @param {string} args.transitionedBy  required, technicians.id of the
 *                                       admin/tech who triggered it
 * @param {object} [args.trx]           optional Knex transaction; if
 *                                       passed, both writes use it and
 *                                       the emit chains on commit. If
 *                                       not passed, this function owns
 *                                       the trx end-to-end.
 * @returns {Promise<object>} the customer-facing payload that was
 *                             (or will be, on commit) broadcast
 */
async function transitionJobStatus({ jobId, fromStatus, toStatus, transitionedBy, trx }) {
  if (!jobId || !toStatus) {
    throw new Error('transitionJobStatus: jobId and toStatus are required');
  }

  async function doWrites(t) {
    // Atomic guard: only update if the row is currently in fromStatus.
    // 0-row update means a racing transition already advanced past it
    // (or fromStatus is wrong). Either way, we abort — the audit log
    // would otherwise record a transition that didn't happen on the
    // source table.
    const guard = fromStatus == null
      ? { id: jobId }
      : { id: jobId, status: fromStatus };
    const updated = await t('scheduled_services')
      .where(guard)
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

    return buildCustomerPayload(t, jobId, toStatus);
  }

  if (trx) {
    // Caller-owned trx. Do the writes; defer the emit until the
    // caller's outer transaction resolves. trx.executionPromise is
    // the promise returned by db.transaction(fn) — resolves on
    // commit, rejects on rollback.
    const { customerId, payload } = await doWrites(trx);
    if (trx.executionPromise) {
      trx.executionPromise.then(() => emitToCustomer(customerId, payload)).catch(() => {
        // Rollback path. Caller will see the rejection on their
        // db.transaction() promise; we just suppress the emit.
      });
    } else {
      // Defensive: some Knex test harnesses may pass a bare object as
      // trx. Fall back to inline emit (caller is responsible for
      // commit ordering in that case).
      logger.warn('[job-status] trx.executionPromise missing — emitting inline (test harness?)');
      emitToCustomer(customerId, payload);
    }
    return payload;
  }

  // No outer trx — own the lifecycle end-to-end.
  let captured;
  await db.transaction(async (innerTrx) => {
    captured = await doWrites(innerTrx);
  });
  // trx committed by here.
  emitToCustomer(captured.customerId, captured.payload);
  return captured.payload;
}

function emitToCustomer(customerId, payload) {
  const io = getIo();
  if (!io) {
    // attachSockets() didn't run — typically only happens in unit
    // tests that import this module without booting the full server.
    // Don't throw; the DB write already succeeded.
    logger.warn('[job-status] io not initialized; skipping broadcast');
    return;
  }
  io.to(customerRoom(customerId)).emit(EVENT, payload);
}

module.exports = {
  transitionJobStatus,
  EVENT,
  customerRoom,
};
