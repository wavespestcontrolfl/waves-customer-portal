const crypto = require('crypto');
const db = require('../models/db');
const logger = require('./logger');

// A pending attempt that hasn't transitioned to succeeded/failed within
// this window is treated as orphaned (caller process crashed between
// INSERT and markSucceeded/markFailed). Without a reclaim path, the
// partial unique index would block every retry forever and the service
// would be stuck "completion_pending." 10 min is comfortably longer
// than any normal completion (sub-second) plus webhook retries.
const STALE_PENDING_MS = 10 * 60 * 1000;
const STALE_SIDE_EFFECTS_MS = 10 * 60 * 1000;

function isUniqueViolation(err) {
  return err?.code === '23505';
}

function hashCompletionRequest(body) {
  const { idempotencyKey, timeOnSite, ...stableBody } = body || {};
  return crypto.createHash('sha256')
    .update(JSON.stringify(stableBody))
    .digest('hex');
}

function sideEffectsRunningPayload() {
  return {
    action: 'conflict',
    status: 409,
    payload: {
      error: 'Completion side effects are still running for this service.',
      code: 'completion_side_effects_running',
    },
  };
}

async function claimSideEffectsRun(row, requestHash, knex = db) {
  if (!row?.service_record_id) return null;
  if (row.request_hash && requestHash && row.request_hash !== requestHash) {
    return {
      action: 'conflict',
      status: 409,
      payload: {
        error: 'Service completion has committed with a different completion payload.',
        code: 'completion_resume_payload_mismatch',
        serviceRecordId: row.service_record_id,
      },
    };
  }

  const staleCutoff = new Date(Date.now() - STALE_SIDE_EFFECTS_MS);
  if (row.status === 'side_effects_running' && new Date(row.updated_at) >= staleCutoff) {
    return sideEffectsRunningPayload();
  }

  let query = knex('service_completion_attempts')
    .where({ id: row.id, status: row.status });
  if (row.status === 'side_effects_running') {
    query = query.andWhere('updated_at', '<', staleCutoff);
  }
  const [claimed] = await query.update({
    status: 'side_effects_running',
    updated_at: new Date(),
  }).returning('*');

  if (!claimed) return sideEffectsRunningPayload();
  return { action: 'resume', attempt: claimed, serviceRecordId: claimed.service_record_id };
}

async function claimCompletionAttempt({ serviceId, idempotencyKey, requestHash }, knex = db) {
  // Per-service terminal-state guard. The unique index on
  // (service_id, idempotency_key) plus the partial pending-only
  // index don't prevent a NEW attempt under a fresh key for an
  // already-succeeded service. Panel mounts generate a fresh key
  // each time, so a lost response followed by reload would let
  // /complete re-run and create a duplicate service_record /
  // invoice / SMS — money-correctness bug.
  //
  // Guard: if any prior attempt for this service has succeeded,
  // replay (same key) or 409 (different key) — never insert a new
  // pending row.
  const priorSuccess = await knex('service_completion_attempts')
    .where({ service_id: serviceId, status: 'succeeded' })
    .orderBy('updated_at', 'desc')
    .first();
  if (priorSuccess) {
    if (priorSuccess.idempotency_key === idempotencyKey && priorSuccess.response) {
      // Same client retry after success — replay stored response.
      if (priorSuccess.request_hash && requestHash && priorSuccess.request_hash !== requestHash) {
        return {
          action: 'conflict',
          status: 409,
          payload: {
            error: 'Idempotency key reused with a different completion payload.',
            code: 'idempotency_key_mismatch',
          },
        };
      }
      return { action: 'replay', payload: { ...priorSuccess.response, replayed: true } };
    }
    // Different idempotency key for an already-completed service —
    // refuse to run side effects again.
    return {
      action: 'conflict',
      status: 409,
      payload: {
        error: 'Service has already been completed.',
        code: 'service_already_completed',
        serviceRecordId: priorSuccess.service_record_id || null,
        invoiceId: priorSuccess.invoice_id || null,
      },
    };
  }

  const resumable = await knex('service_completion_attempts')
    .where({ service_id: serviceId })
    .whereIn('status', ['side_effects_pending', 'side_effects_running'])
    .orderBy('updated_at', 'desc')
    .first();
  if (resumable?.service_record_id) {
    return claimSideEffectsRun(resumable, requestHash, knex);
  }

  try {
    const [row] = await knex('service_completion_attempts').insert({
      service_id: serviceId,
      idempotency_key: idempotencyKey,
      status: 'pending',
      request_hash: requestHash,
    }).returning('*');
    return { action: 'proceed', attempt: row };
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;

    const existing = await knex('service_completion_attempts')
      .where({ service_id: serviceId, idempotency_key: idempotencyKey })
      .first();

    if (!existing) {
      // No row by (service_id, idempotency_key) — the partial unique
      // index on (service_id) WHERE status='pending' must have fired,
      // meaning a different-key attempt is already pending. Before
      // returning 409, check whether that pending row is orphaned
      // (caller crashed mid-completion). If so, mark it failed and
      // retry the original insert so this caller can proceed.
      const stalePending = await knex('service_completion_attempts')
        .where({ service_id: serviceId, status: 'pending' })
        .andWhere('updated_at', '<', new Date(Date.now() - STALE_PENDING_MS))
        .first();

      if (stalePending) {
        // Defense in depth: even with the in-trx markSucceeded in
        // admin-dispatch, an out-of-band path (admin tooling, a future
        // route) could leave a pending attempt while the dispatch
        // service_record is already committed. Reclaiming + re-running
        // /complete in that case would duplicate everything. Check
        // service_records first; if the service is already completed,
        // 409 instead of reclaiming.
        const completedRecord = await knex('service_records')
          .where({ scheduled_service_id: serviceId })
          .orderBy('created_at', 'desc')
          .first();
        if (completedRecord) {
          return {
            action: 'conflict',
            status: 409,
            payload: {
              error: 'Service has already been completed.',
              code: 'service_already_completed',
              serviceRecordId: completedRecord.id,
            },
          };
        }

        const [reclaimed] = await knex('service_completion_attempts')
          .where({ id: stalePending.id, status: 'pending' })
          .update({
            status: 'failed',
            error: 'Reclaimed: pending attempt exceeded stale threshold (caller likely crashed)',
            updated_at: new Date(),
          })
          .returning('*');
        if (reclaimed) {
          logger.warn(
            `[completion-attempts] reclaimed stale pending attempt ${reclaimed.id} for service ${serviceId} (key ${reclaimed.idempotency_key})`
          );
          // Pending row is now failed — partial unique index is clear.
          // Retry the original insert under this caller's key.
          const [row] = await knex('service_completion_attempts').insert({
            service_id: serviceId,
            idempotency_key: idempotencyKey,
            status: 'pending',
            request_hash: requestHash,
          }).returning('*');
          return { action: 'proceed', attempt: row };
        }
        // Lost the reclaim race to another retry — fall through.
      }

      return {
        action: 'conflict',
        status: 409,
        payload: {
          error: 'Completion already pending for this service.',
          code: 'service_completion_pending',
        },
      };
    }

    // Strict idempotency: if the prior attempt under this key has a
    // recorded request_hash and the new payload doesn't match it, the
    // client is reusing the key with different data. Reject before
    // replaying a stale response or rerunning under a different body.
    const hashMismatch =
      existing.request_hash && requestHash && existing.request_hash !== requestHash;

    if (existing.status === 'succeeded' && existing.response) {
      if (hashMismatch) {
        return {
          action: 'conflict',
          status: 409,
          payload: {
            error: 'Idempotency key reused with a different completion payload.',
            code: 'idempotency_key_mismatch',
          },
        };
      }
      return { action: 'replay', payload: { ...existing.response, replayed: true } };
    }

    if ((existing.status === 'side_effects_pending' || existing.status === 'side_effects_running') && existing.service_record_id) {
      return claimSideEffectsRun(existing, requestHash, knex);
    }

    if (existing.status === 'pending') {
      return {
        action: 'conflict',
        status: 409,
        payload: {
          error: 'Completion already pending.',
          code: 'completion_pending',
        },
      };
    }

    if (existing.status === 'failed') {
      if (hashMismatch) {
        return {
          action: 'conflict',
          status: 409,
          payload: {
            error: 'Idempotency key reused with a different completion payload.',
            code: 'idempotency_key_mismatch',
          },
        };
      }
      const [row] = await knex('service_completion_attempts')
        .where({ id: existing.id, status: 'failed' })
        .update({
          status: 'pending',
          request_hash: requestHash,
          response: null,
          error: null,
          updated_at: new Date(),
        })
        .returning('*');
      // The conditional UPDATE matches at most one row across concurrent
      // retries. The loser of that race gets nothing back — another
      // retry already flipped the row to pending, so this caller must
      // not proceed and double-execute the side effects.
      if (!row) {
        return {
          action: 'conflict',
          status: 409,
          payload: {
            error: 'Completion already pending.',
            code: 'completion_pending',
          },
        };
      }
      return { action: 'proceed', attempt: row };
    }

    return {
      action: 'conflict',
      status: 409,
      payload: {
        error: 'Completion attempt is not retryable.',
        code: 'completion_not_retryable',
      },
    };
  }
}

async function markCompletionAttemptFailed(attempt, err, knex = db) {
  if (!attempt?.id) return;
  try {
    await knex('service_completion_attempts').where({ id: attempt.id }).update({
      status: 'failed',
      error: err?.message || String(err || 'Unknown completion error'),
      updated_at: new Date(),
    });
  } catch (updateErr) {
    logger.error(`[dispatch] mark completion attempt failed failed: ${updateErr.message}`);
  }
}

async function markCompletionAttemptSucceeded(attempt, { record, invoice, response }, knex = db) {
  if (!attempt?.id) return;
  await knex('service_completion_attempts').where({ id: attempt.id }).update({
    status: 'succeeded',
    service_record_id: record?.id || null,
    invoice_id: invoice?.id || null,
    response,
    error: null,
    updated_at: new Date(),
  });
}

async function markCompletionAttemptSideEffectsPending(attempt, { record, response }, knex = db) {
  if (!attempt?.id) return;
  await knex('service_completion_attempts').where({ id: attempt.id }).update({
    status: 'side_effects_running',
    service_record_id: record?.id || null,
    response,
    error: null,
    updated_at: new Date(),
  });
}

module.exports = {
  claimCompletionAttempt,
  hashCompletionRequest,
  markCompletionAttemptFailed,
  markCompletionAttemptSucceeded,
  markCompletionAttemptSideEffectsPending,
};
