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
      return { action: 'proceed', attempt: row || existing };
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
