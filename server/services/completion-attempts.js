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
    .update(JSON.stringify(sortObjectKeys(stableBody)))
    .digest('hex');
}

function sortObjectKeys(value) {
  if (Array.isArray(value)) return value.map(sortObjectKeys);
  if (!value || typeof value !== 'object' || value instanceof Date) return value;
  return Object.keys(value).sort().reduce((acc, key) => {
    acc[key] = sortObjectKeys(value[key]);
    return acc;
  }, {});
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

        // If the stale attempt has already persisted a resolved
        // snapshot, that snapshot is the audit source — marking the
        // attempt failed and starting a fresh one would discard the
        // tech's original attestation and re-run the resolver against
        // a possibly-newer active protocol_template. Refuse the
        // different-key reclaim and surface the state. The same-key
        // path below preserves the snapshot row intact, so the only
        // way to resume legitimately is to retry under the original
        // idempotency key (typically requires admin intervention since
        // panel reloads generate fresh keys).
        if (stalePending.snapshot_written_at) {
          return {
            action: 'conflict',
            status: 409,
            payload: {
              error: 'Completion has a persisted resolved snapshot from an earlier attempt. Retry under the original idempotency key or contact support.',
              code: 'completion_snapshot_persisted_stale',
              attemptId: stalePending.id,
              snapshotHash: stalePending.resolved_completion_snapshot_hash || null,
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

      // Same-key retry where the resolver already persisted a snapshot
      // under this key — the original attempt crashed between snapshot
      // write and service_record creation. The snapshot is the audit
      // truth; the right behavior is to resume the side-effects portion
      // using that snapshot, NOT to bounce through the resolver again.
      // Otherwise storeResolvedSnapshot's pending-only guard (round-2)
      // would reject the retry with snapshot_write_not_eligible, leaving
      // a legitimate recovery stuck. Resume regardless of staleness —
      // a fresh same-key retry milliseconds after the original deserves
      // the same resume path as one 12 minutes later.
      if (existing.snapshot_written_at) {
        return { action: 'resume_from_snapshot', attempt: existing };
      }

      const staleCutoff = new Date(Date.now() - STALE_PENDING_MS);
      if (new Date(existing.updated_at) < staleCutoff) {
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
          .where({ id: existing.id, status: 'pending' })
          .andWhere('updated_at', '<', staleCutoff)
          .update({
            request_hash: requestHash,
            error: null,
            updated_at: new Date(),
          })
          .returning('*');
        if (reclaimed) {
          logger.warn(
            `[completion-attempts] reclaimed stale same-key pending attempt ${reclaimed.id} for service ${serviceId}`
          );
          return { action: 'proceed', attempt: reclaimed };
        }
      }

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

// Stable hash for a resolved completion snapshot. Used by the preview
// → submit handshake: the client receives the hash on the preview
// endpoint and sends it back as expectedSnapshotHash. If the resolver
// produces a different hash at submit time (active protocol template
// changed between preview and submit), the route returns 409
// completion_preview_stale so the tech reopens the modal and reviews
// the updated protocol.
function hashResolvedSnapshot(snapshot) {
  return crypto.createHash('sha256')
    .update(JSON.stringify(sortObjectKeys(snapshot)))
    .digest('hex');
}

// Persist the resolver's output on the completion attempt row before
// any service_record is created. Mandatory for one-tap completions
// (CHECK constraint enforces completion_source='one_tap_completion'
// requires protocol_template_id + version). On replay/resume, the
// route reads this snapshot back rather than re-running the resolver
// — that's the whole point of snapshot ownership living here.
async function storeResolvedSnapshot(
  attempt,
  { snapshot, snapshotHash, completionSource, protocolTemplateId, protocolTemplateVersion },
  knex = db
) {
  if (!attempt?.id) throw new Error('storeResolvedSnapshot requires a claimed attempt');
  if (!snapshot) throw new Error('storeResolvedSnapshot requires a snapshot');
  if (!completionSource) throw new Error('storeResolvedSnapshot requires completion_source');

  // Always compute the hash from the snapshot. If a caller supplied a
  // hash, verify it matches and throw on mismatch — never store an
  // unverified hash. A route accidentally forwarding the client's
  // expectedSnapshotHash next to a server-resolved snapshot would
  // weaken the preview-stale guard and the audit trail (the persisted
  // hash would no longer hash to the persisted snapshot).
  const computedHash = hashResolvedSnapshot(snapshot);
  if (snapshotHash && snapshotHash !== computedHash) {
    const err = new Error('storeResolvedSnapshot supplied snapshotHash does not match hash(snapshot)');
    err.code = 'snapshot_hash_mismatch';
    throw err;
  }
  if (completionSource === 'one_tap_completion' && (!protocolTemplateId || !protocolTemplateVersion)) {
    throw new Error('storeResolvedSnapshot one_tap_completion requires protocol_template_id and version');
  }

  // Guard: only write the snapshot once, and only on a pre-record
  // attempt. A resume path or a stale caller hitting an attempt that
  // has already moved to side_effects_running/succeeded — or whose
  // snapshot was already persisted on an earlier attempt — must not
  // overwrite the original. The "first resolved snapshot is the
  // replay/audit source" invariant depends on this WHERE clause.
  // status='pending' AND snapshot_written_at IS NULL AND
  // service_record_id IS NULL together describe the only state where
  // a fresh snapshot write is legal. We assert .returning row count
  // to throw if a concurrent caller beat us.
  const updated = await knex('service_completion_attempts')
    .where({ id: attempt.id, status: 'pending' })
    .whereNull('snapshot_written_at')
    .whereNull('service_record_id')
    .update({
      resolved_completion_snapshot: JSON.stringify(snapshot),
      resolved_completion_snapshot_hash: computedHash,
      completion_source: completionSource,
      protocol_template_id: protocolTemplateId || null,
      protocol_template_version: protocolTemplateVersion || null,
      snapshot_written_at: new Date(),
      updated_at: new Date(),
    })
    .returning('id');
  if (!updated || updated.length === 0) {
    const err = new Error('storeResolvedSnapshot found no eligible pre-record attempt row (already resolved, resumed, or progressed past pending)');
    err.code = 'snapshot_write_not_eligible';
    throw err;
  }
  return { snapshotHash: computedHash };
}

module.exports = {
  claimCompletionAttempt,
  hashCompletionRequest,
  hashResolvedSnapshot,
  markCompletionAttemptFailed,
  markCompletionAttemptSucceeded,
  markCompletionAttemptSideEffectsPending,
  storeResolvedSnapshot,
};
