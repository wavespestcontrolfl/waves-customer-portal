/**
 * Intelligence Bar pending-action store (issue #1568).
 *
 * Trust boundary: the pending-action id is the confirmation credential. It
 * is returned ONLY in the HTTP response's client-only payload — never inside
 * any tool_result or other content that re-enters the model's message array.
 * Confirmation therefore requires a real client event; the model cannot
 * commit a write by echoing anything it has seen.
 */

const crypto = require('crypto');
const db = require('../../models/db');
const logger = require('../logger');

const TTL_MINUTES = 10;

// Deterministic stringify (sorted keys, recursively) so the hash is stable
// across JSON property ordering.
function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function paramsHash(toolName, params) {
  return crypto.createHash('sha256')
    .update(`${toolName}\n${stableStringify(params || {})}`)
    .digest('hex');
}

async function createPendingAction({ toolName, params, summary, requestedBy, context }) {
  const [row] = await db('ib_pending_actions').insert({
    tool_name: toolName,
    params: JSON.stringify(params || {}),
    params_hash: paramsHash(toolName, params || {}),
    summary: summary || null,
    requested_by: String(requestedBy),
    context: context || null,
    status: 'pending',
    expires_at: new Date(Date.now() + TTL_MINUTES * 60 * 1000),
  }).returning('*');

  logger.info(`[intelligence-bar:pending] Proposed ${toolName} as pending action ${row.id}`);
  return row;
}

/**
 * Atomically claim a pending action for execution. The single-statement
 * UPDATE ... WHERE status='pending' is the replay guard: a second confirm
 * (or a concurrent one) finds no pending row to claim.
 *
 * Returns { action } on success or { error } with one of:
 * not_found | actor_mismatch | already_used | cancelled | expired | hash_mismatch
 */
async function claimForConfirm(id, requestedBy) {
  const [claimed] = await db('ib_pending_actions')
    .where({ id, status: 'pending', requested_by: String(requestedBy) })
    .where('expires_at', '>', db.fn.now())
    .update({ status: 'confirmed', consumed_at: db.fn.now(), updated_at: db.fn.now() })
    .returning('*');

  if (!claimed) {
    const row = await db('ib_pending_actions').where({ id }).first();
    if (!row) return { error: 'not_found' };
    if (String(row.requested_by) !== String(requestedBy)) return { error: 'actor_mismatch' };
    if (row.status === 'confirmed') return { error: 'already_used' };
    if (row.status === 'cancelled') return { error: 'cancelled' };
    return { error: 'expired' };
  }

  const params = typeof claimed.params === 'string' ? JSON.parse(claimed.params) : claimed.params;
  if (paramsHash(claimed.tool_name, params) !== claimed.params_hash) {
    // Stored payload no longer matches what the operator approved — refuse.
    await db('ib_pending_actions').where({ id }).update({ status: 'cancelled', updated_at: db.fn.now() });
    logger.error(`[intelligence-bar:pending] Hash mismatch on pending action ${id} — cancelled`);
    return { error: 'hash_mismatch' };
  }

  return { action: { ...claimed, params } };
}

async function cancelPendingAction(id, requestedBy) {
  const count = await db('ib_pending_actions')
    .where({ id, status: 'pending', requested_by: String(requestedBy) })
    .update({ status: 'cancelled', updated_at: db.fn.now() });
  return { cancelled: count > 0 };
}

async function recordResult(id, result) {
  try {
    await db('ib_pending_actions').where({ id }).update({
      result: JSON.stringify(result ?? null),
      updated_at: db.fn.now(),
    });
  } catch (err) {
    logger.warn(`[intelligence-bar:pending] Could not record result for ${id}: ${err.message}`);
  }
}

module.exports = {
  TTL_MINUTES,
  paramsHash,
  stableStringify,
  createPendingAction,
  claimForConfirm,
  cancelPendingAction,
  recordResult,
};
