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
const { executionOutcome } = require('./outcomes');

const TTL_MINUTES = 10;

// Deterministic stringify (sorted keys, recursively) so the hash is stable
// across JSON property ordering.
function stableStringify(value) {
  if (value && typeof value.toJSON === 'function') return stableStringify(value.toJSON());
  if (Array.isArray(value)) return `[${value.map(item => stableStringify(item) ?? 'null').join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().filter(k => value[k] !== undefined).map(k => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function paramsHash(toolName, params) {
  return crypto.createHash('sha256')
    .update(`${toolName}\n${stableStringify(params || {})}`)
    .digest('hex');
}

function stepKey(toolName, params, preview = {}) {
  const canonical = Object.fromEntries(Object.entries(params || {}).filter(([key]) => !key.startsWith('_') && !['confirmed', 'confirm'].includes(key)));
  for (const [snake, camel, name] of [['customer_id', 'customerId', 'customer_name'], ['lead_id', 'leadId', 'lead_name'], ['technician_id', 'technicianId', 'technician_name']]) {
    if (!(canonical[snake] || canonical[camel])) continue;
    canonical[snake] = String(canonical[snake] || canonical[camel]).toLowerCase();
    delete canonical[camel]; delete canonical[name];
  }
  if (canonical.customer_id) delete canonical.customerName;
  if (preview.product?.id) { canonical.product_id = preview.product.id; delete canonical.product_name; }
  for (const key of ['customer_ids', 'lead_ids', 'service_ids']) {
    if (Array.isArray(canonical[key])) canonical[key] = [...new Set(canonical[key])].sort();
  }
  if (toolName === 'send_sms') {
    canonical.message_type = canonical.message_type || 'manual';
    if (canonical.phone) canonical.phone = String(canonical.phone).replace(/\D/g, '');
  }
  if (['adjust_stock', 'create_restock_request', 'update_restock_request'].includes(toolName)) {
    for (const key of ['unit', 'priority', 'vendor', 'needed_by', 'reason']) {
      if (preview[key] !== undefined) canonical[key] = preview[key];
    }
  }
  if (canonical.engineInputs) delete canonical.engineResult; // Derived cross-check, never a second intended effect.
  return paramsHash(toolName, canonical);
}

async function createPendingAction({ toolName, params, summary, requestedBy, context, contract, contractHash, taskId, stepKey, runnerToken }) {
  const persist = async trx => {
  if (taskId) {
    const task = await trx('ib_tasks').where({ id: taskId, actor_id: String(requestedBy), runner_token: runnerToken, state: 'running' })
      .where('lease_expires_at', '>', trx.fn.now()).forUpdate().first('id');
    if (!task) throw new Error('Task execution was superseded');
    const previous = await trx('ib_pending_actions').where({ task_id: taskId, requested_by: String(requestedBy) });
    const existing = previous.find(row => row.step_key === stepKey);
    if (existing) return existing;
    if (previous.some(row => row.status !== 'confirmed'
      || !['completed', 'provider_accepted'].includes(executionOutcome(row.result)))) {
      throw new Error('Resolve the preceding action outcome before preparing another write');
    }
  }
  let insert = trx('ib_pending_actions').insert({
    tool_name: toolName,
    params: JSON.stringify(params || {}),
    params_hash: paramsHash(toolName, params || {}),
    summary: summary || null,
    requested_by: String(requestedBy),
    context: context || null,
    status: 'pending',
    expires_at: new Date(Date.now() + TTL_MINUTES * 60 * 1000),
    // W0B authorization contract: the structured effect set the card shows;
    // its hash is what the operator's Confirm must echo.
    contract: contract ? JSON.stringify(contract) : null,
    contract_hash: contractHash || null,
    ...(taskId ? { task_id: taskId, step_key: stepKey } : {}),
  });
  if (taskId) insert = insert.onConflict(['task_id', 'step_key']).ignore();
  const [created] = await insert.returning('*');
  const row = created || await trx('ib_pending_actions').where({ task_id: taskId, step_key: stepKey, requested_by: String(requestedBy) }).first();
  if (!row) throw new Error('Pending action could not be recorded');

  logger.info(`[intelligence-bar:pending] Proposed ${toolName} as pending action ${row.id}`);
  return row;
  };
  return taskId ? db.transaction(persist) : persist(db);
}

async function forTask(taskId, requestedBy) {
  return db('ib_pending_actions').where({ task_id: taskId, requested_by: String(requestedBy) }).orderBy('created_at');
}

/**
 * Atomically claim a pending action for execution. The single-statement
 * UPDATE ... WHERE status='pending' is the replay guard: a second confirm
 * (or a concurrent one) finds no pending row to claim.
 *
 * W0B exact-effect confirm: when the row carries a contract_hash, the claim
 * succeeds only if the caller echoes the SAME hash (what the card displayed)
 * — checked inside the atomic UPDATE so a stale or different contract can
 * never claim the row. Rows without a contract (pre-W0B) are unaffected.
 *
 * Returns { action } on success or { error } with one of:
 * not_found | actor_mismatch | already_used | cancelled | expired |
 * hash_mismatch | contract_mismatch
 */
async function claimForConfirm(id, requestedBy, { contractHash = null } = {}) {
  const echoed = contractHash ? String(contractHash) : null;
  const [claimed] = await db('ib_pending_actions')
    .where({ id, status: 'pending', requested_by: String(requestedBy) })
    .where('expires_at', '>', db.fn.now())
    .where((qb) => {
      qb.whereNull('contract_hash');
      if (echoed) qb.orWhere('contract_hash', echoed);
    })
    .update({ status: 'confirmed', consumed_at: db.fn.now(), updated_at: db.fn.now() })
    .returning('*');

  if (!claimed) {
    const row = await db('ib_pending_actions').where({ id }).first();
    if (!row) return { error: 'not_found' };
    if (String(row.requested_by) !== String(requestedBy)) return { error: 'actor_mismatch' };
    if (row.status === 'confirmed') return { error: 'already_used' };
    if (row.status === 'cancelled') return { error: 'cancelled' };
    if (row.status === 'pending' && row.contract_hash && row.contract_hash !== echoed
      && new Date(row.expires_at).getTime() > Date.now()) {
      logger.warn(`[intelligence-bar:pending] Contract hash mismatch on pending action ${id} — refused`);
      return { error: 'contract_mismatch' };
    }
    return { error: 'expired' };
  }

  const params = typeof claimed.params === 'string' ? JSON.parse(claimed.params) : claimed.params;
  if (paramsHash(claimed.tool_name, params) !== claimed.params_hash) {
    // Stored payload no longer matches what the operator approved — refuse.
    await db('ib_pending_actions').where({ id }).update({ status: 'cancelled', updated_at: db.fn.now() });
    logger.error(`[intelligence-bar:pending] Hash mismatch on pending action ${id} — cancelled`);
    return { error: 'hash_mismatch' };
  }

  const contract = typeof claimed.contract === 'string' ? JSON.parse(claimed.contract) : (claimed.contract || null);
  return { action: { ...claimed, params, contract } };
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
    return true;
  } catch (err) {
    logger.warn(`[intelligence-bar:pending] Could not record result for ${id} (code=${err.code || 'unknown'})`);
    return false;
  }
}

/** Actor-bound recovery after disconnect. Consumed-without-result is unknown,
 * never permission to execute again. Confirmation credentials stay client-only.
 */
async function getActionReceipt(id, requestedBy) {
  const row = await db('ib_pending_actions').where({ id, requested_by: String(requestedBy) }).first();
  if (!row) return null;
  const result = typeof row.result === 'string' ? JSON.parse(row.result) : row.result;
  const outcome = row.status === 'confirmed' ? executionOutcome(result)
    : row.status === 'cancelled' ? 'canceled'
      : new Date(row.expires_at).getTime() <= Date.now() ? 'expired' : 'awaiting_approval';
  return {
    id: row.id, tool: row.tool_name, outcome,
    summary: row.summary || null, contract: row.contract || null,
    result: result || null,
    success: ['completed', 'partially_completed', 'provider_accepted'].includes(outcome),
    consumedAt: row.consumed_at || null, updatedAt: row.updated_at,
    retryAllowed: outcome === 'awaiting_approval',
  };
}

/**
 * Stamp the persisted thread AND the exact exchange (its assistant turn
 * seq) onto the proposals that exchange produced, so recall
 * (search_ib_history) attributes receipts to the matched exchange — never
 * thread-wide. Actor-bound: only rows the same actor requested are touched.
 * Best-effort from the /query path — a failure here never fails the answer.
 */
async function attachThread(ids, threadId, turnSeq, requestedBy) {
  if (!threadId || !Number.isInteger(turnSeq) || !requestedBy
    || !Array.isArray(ids) || ids.length === 0) return 0;
  return db('ib_pending_actions')
    .whereIn('id', ids)
    .where('requested_by', String(requestedBy))
    .whereNull('thread_id')
    .update({ thread_id: threadId, thread_turn_seq: turnSeq, updated_at: db.fn.now() });
}

module.exports = {
  TTL_MINUTES,
  paramsHash,
  stepKey,
  stableStringify,
  createPendingAction,
  claimForConfirm,
  cancelPendingAction,
  recordResult,
  getActionReceipt,
  attachThread,
  forTask,
};
