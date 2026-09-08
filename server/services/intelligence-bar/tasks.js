/** Durable request identity over the existing IB query/confirmation loop.
 * No execution authority is stored in prose. Pending actions remain the only
 * write approvals. A task response and its credentials are actor/session-bound.
 */
const crypto = require('crypto');
const db = require('../../models/db');
const { stableStringify } = require('./pending-actions');
const PendingActions = require('./pending-actions');
const { UUID_RE } = require('./task-context');
const REQUEST_KEY_RE = /^[a-zA-Z0-9._:-]{8,120}$/;
const STATES = new Set(['running', 'responded', 'awaiting_approval', 'needs_information', 'failed', 'outcome_unknown', 'canceled']);
const leaseExpiry = () => new Date(Date.now() + 120000);

function requestHash(request) {
  return crypto.createHash('sha256').update(stableStringify(request)).digest('hex');
}

function withoutImages(messages) {
  return messages.map(message => ({ ...message, content: Array.isArray(message.content)
    ? message.content.map(block => block.type === 'image' ? { type: 'text', text: '[Image omitted from recovery; ask the operator to reattach if required]' } : block)
    : message.content }));
}

async function begin({ actorId, sessionId, requestKey, request, pageContext }) {
  if (!actorId || !UUID_RE.test(sessionId || '') || !REQUEST_KEY_RE.test(requestKey || '')) {
    return { error: 'A valid session and request key are required', code: 'invalid_request_identity' };
  }
  const hash = requestHash(request);
  // Images remain ephemeral, as in threads. Their hash still participates in
  // request identity so swapping an attachment cannot replay an old response.
  const { images, ...persistedRequest } = request;
  const row = {
    actor_id: String(actorId), session_id: sessionId, request_key: requestKey, request_hash: hash,
    runner_token: crypto.randomUUID(), lease_expires_at: leaseExpiry(),
    page_context: JSON.stringify(pageContext || {}), request: JSON.stringify({ ...persistedRequest, had_images: !!images?.length }),
    expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
  };
  const [created] = await db('ib_tasks').insert(row).onConflict(['actor_id', 'session_id', 'request_key']).ignore().returning('*');
  const task = created || await db('ib_tasks').where({ actor_id: String(actorId), session_id: sessionId, request_key: requestKey }).first();
  if (!task || task.request_hash !== hash
    || stableStringify(task.page_context || {}) !== stableStringify(pageContext || {})) return { error: 'This request key belongs to different request details', code: 'request_changed' };
  return { task, created: !!created };
}

async function checkpoint(id, actorId, { messages, target, state = 'running', response, runnerToken }) {
  if (!UUID_RE.test(runnerToken || '')) throw new Error('A valid task runner token is required');
  if (!STATES.has(state)) throw new Error('Invalid IB task state');
  const updates = { state, updated_at: db.fn.now(), lease_expires_at: leaseExpiry() };
  if (messages) updates.checkpoint = JSON.stringify(withoutImages(messages));
  if (target !== undefined) updates.target = JSON.stringify(target);
  if (response) updates.response = JSON.stringify(response);
  const query = db('ib_tasks').where({ id, actor_id: String(actorId), runner_token: runnerToken });
  if (!(await query.update(updates))) throw new Error('Task execution was superseded');
}

async function claimResume(id, actorId, sessionId, { selectedTarget } = {}) {
  const task = await get(id, actorId, sessionId);
  if (!task) return { error: 'Task not found', code: 'not_found' };
  if (selectedTarget && task.state !== 'needs_information') return { error: 'This task is not awaiting a target choice', code: 'not_awaiting_target' };
  const saved = await snapshot(task, actorId);
  const blocked = continuationError(task, saved.receipts, { selectedTarget });
  if (blocked) return blocked;
  const [claimed] = await db('ib_tasks').where({ id, actor_id: String(actorId), runner_token: task.runner_token })
    .where('state', task.state)
    .where(q => q.whereNot('state', 'running').orWhere('lease_expires_at', '<', db.fn.now()))
    .update({ state: 'running', runner_token: crypto.randomUUID(), lease_expires_at: leaseExpiry(), updated_at: db.fn.now(),
      ...(selectedTarget ? { request: JSON.stringify({ ...task.request, selectedTarget }) } : {}),
    }).returning('*');
  return claimed ? { task: claimed, receipts: saved.receipts.map(({ tool, outcome, result }) => ({ tool, outcome, result })) }
    : { error: 'This task is already running', code: 'already_running' };
}

function continuationError(task, receipts, { selectedTarget } = {}) {
  if (receipts.some(r => !['completed', 'provider_accepted'].includes(r.outcome))) {
    return { error: 'Resolve the saved action outcomes before continuing', code: 'steps_unresolved' };
  }
  if (task.request?.had_images && !task.checkpoint?.length) {
    return { error: 'The attachments were not saved before this request stopped. Reattach them in a new request.', code: 'attachments_required' };
  }
  if (['responded', 'canceled'].includes(task.state)
      || (task.state === 'needs_information' && !selectedTarget)
      || (task.state === 'awaiting_approval' && !receipts.length)) {
    return { error: 'This task has no interrupted step to continue.', code: 'not_resumable' };
  }
  if (task.state === 'running' && new Date(task.lease_expires_at).getTime() >= Date.now()) {
    return { error: 'This task is already running', code: 'already_running' };
  }
  return null;
}

async function snapshot(task, actorId) {
  const rows = await PendingActions.forTask(task.id, actorId);
  const receipts = [];
  const pendingActions = [];
  for (const row of rows) {
    const receipt = PendingActions.actionReceipt(row);
    receipts.push(receipt);
    if (receipt.outcome === 'awaiting_approval') pendingActions.push({
      id: row.id, tool: row.tool_name, summary: row.summary,
      contract: row.contract, contract_hash: row.contract_hash, params: {},
      expiresAt: row.expires_at,
      expiresInMs: Math.max(0, new Date(row.expires_at).getTime() - Date.now()),
    });
  }
  return { ...(task.response || {}), taskId: task.id, taskState: exposedTaskState(task, receipts),
    taskTarget: task.target?.target || null, pendingActions, receipts,
    canContinue: !continuationError(task, receipts),
    response: task.response?.response || (task.request?.had_images && !task.checkpoint?.length
      ? 'The attachments were not saved before this request stopped. Reattach them in a new request.'
      : 'This request has not returned a final answer. Its saved actions are shown below.'),
  };
}

function exposedTaskState(task, receipts) {
  if (task.state !== 'awaiting_approval' || !receipts.length) return task.state;
  const outcomes = new Set(receipts.map(receipt => receipt.outcome));
  if (outcomes.has('awaiting_approval')) return 'awaiting_approval';
  if (outcomes.has('outcome_unknown')) return 'outcome_unknown';
  if ([...outcomes].every(outcome => ['completed', 'provider_accepted'].includes(outcome))) return 'ready_to_continue';
  if (outcomes.has('completed') || outcomes.has('provider_accepted') || outcomes.has('partially_completed')) return 'partially_completed';
  return outcomes.size === 1 && outcomes.has('canceled') ? 'canceled' : 'failed';
}

async function get(id, actorId, sessionId) {
  if (!UUID_RE.test(id || '') || !UUID_RE.test(sessionId || '')) return null;
  return db('ib_tasks').where({ id, actor_id: String(actorId), session_id: sessionId }).where('expires_at', '>', db.fn.now()).first();
}

async function list(actorId, sessionId) {
  if (!UUID_RE.test(sessionId || '')) return [];
  const scoped = () => db('ib_tasks').where({ actor_id: String(actorId), session_id: sessionId }).where('expires_at', '>', db.fn.now());
  // The latest twenty plus every task still open for the operator, so an
  // older approval, interruption or unknown outcome stays reachable.
  const latest = scoped().orderBy('created_at', 'desc').limit(20).select('id');
  const tasks = await scoped().where(query => query.whereIn('id', latest).orWhereNotIn('state', ['responded', 'canceled']))
    .orderBy('created_at', 'desc').select('id', 'state', 'target', 'page_context', 'created_at', 'updated_at');
  if (!tasks.length) return tasks;
  const actions = await db('ib_pending_actions').where('requested_by', String(actorId)).whereIn('task_id', tasks.map(task => task.id));
  return tasks.map(task => ({ ...task, state: exposedTaskState(task,
    actions.filter(action => action.task_id === task.id).map(PendingActions.actionReceipt)) }));
}

// Run from the existing IB retention sweep even while the platform gate is off.
// Keep an active runner until its lease ends. Pending-action receipts survive
// through their existing FK SET NULL and remain actor-bound for reconciliation.
async function purgeExpiredTasks() {
  // Legacy proposals stored the whole resolution context in params. Never
  // rewrite an approval that can still be claimed; after expiry remove only
  // that private evidence while retaining params, result and the receipt IDs.
  // This also reaches orphaned receipts whose task FK has already been nulled.
  await db('ib_pending_actions').where('expires_at', '<=', db.fn.now())
    .whereRaw("params->'_ib_task_context' IS NOT NULL")
    .update({ params: db.raw("params - '_ib_task_context'") });
  return db('ib_tasks').where('expires_at', '<=', db.fn.now())
    .where('lease_expires_at', '<=', db.fn.now()).del();
}

module.exports = { REQUEST_KEY_RE, begin, checkpoint, claimResume, get, list, snapshot, requestHash, withoutImages, purgeExpiredTasks };
