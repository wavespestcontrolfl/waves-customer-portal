const crypto = require('crypto');
const db = require('../models/db');
const logger = require('./logger');

function isUniqueViolation(err) {
  return err?.code === '23505';
}

function hashCompletionRequest(body) {
  return crypto.createHash('sha256')
    .update(JSON.stringify(body || {}))
    .digest('hex');
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

module.exports = {
  claimCompletionAttempt,
  hashCompletionRequest,
  markCompletionAttemptFailed,
  markCompletionAttemptSucceeded,
};
