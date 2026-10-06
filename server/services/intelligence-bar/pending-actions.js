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
const { phoneMatchDigits } = require('../../utils/phone');

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

function canonicalStepInput(toolName, params, preview = {}) {
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
    if (canonical.phone) canonical.phone = phoneMatchDigits(canonical.phone)[0] || String(canonical.phone).replace(/\D/g, '');
  }
  if (['adjust_stock', 'create_restock_request', 'update_restock_request'].includes(toolName)) {
    for (const key of ['unit', 'priority', 'vendor', 'needed_by', 'reason']) {
      if (preview[key] !== undefined) canonical[key] = preview[key];
    }
  }
  if (canonical.engineInputs) delete canonical.engineResult; // Derived cross-check, never a second intended effect.
  return canonical;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const IDENTIFIER_KEY_RE = /^(?:id|estimate_identifier)$|_ids?$|Ids?$/;
const SET_ID_KEYS = new Set(['customer_ids', 'lead_ids', 'service_ids']);
function normalizeStepIds(value, key = '') {
  if (value && typeof value.toJSON === 'function') return normalizeStepIds(value.toJSON(), key);
  if (Array.isArray(value)) {
    const items = value.map(item => normalizeStepIds(item, key));
    return SET_ID_KEYS.has(key) ? [...new Set(items)].sort() : items;
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, normalizeStepIds(item, name)]));
  }
  return typeof value === 'string' && IDENTIFIER_KEY_RE.test(key) && UUID_RE.test(value) ? value.toLowerCase() : value;
}

function stepKey(toolName, params, preview) {
  return paramsHash(toolName, normalizeStepIds(canonicalStepInput(toolName, params, preview)));
}

// Persisted pre-version keys are an external contract. Prove their original
// input before comparing a normalized retry; today's product preview cannot
// reconstruct a product/default that existed only in yesterday's preview.
function legacyStepKey(row) {
  const canonical = canonicalStepInput(row.tool_name, row.params);
  const oldHashes = [paramsHash(row.tool_name, canonical)];
  if (row.tool_name === 'send_sms' && row.params.phone) {
    oldHashes.push(paramsHash(row.tool_name, { ...canonical, phone: String(row.params.phone).replace(/\D/g, '') }));
  }
  if (!oldHashes.includes(row.step_key)) {
    throw Object.assign(new Error('Reconcile the earlier action before preparing another write of this kind'), { code: 'action_reconciliation_required' });
  }
  return paramsHash(row.tool_name, normalizeStepIds(canonical));
}

// A newer card supersedes an older pending card only when it is the same
// intent: same actor, same conversation (session), same tool, same target
// record, and it re-states everything the older card would have written. An
// allowlist, not a guess: a second text to one customer, or an edit of a
// different field on the same lead, is a different intent and stays pending.
const idPart = value => (value === undefined || value === null || value === '' ? null : String(value).toLowerCase());
// One intent per rule. The key is computed from a card's STORED params, so the
// proposal path and the confirm path always agree on it.
//   afterConfirmed: what a NEW card for the same intent does when an earlier
//   card for it was already confirmed and ran (or may be running).
//     'refuse' - a second card would repeat a one-off effect (a booking): the
//                new card is refused, the operator moves the visit instead.
//     'allow'  - a later edit is a legitimate new edit and stays confirmable.
const LEAD_CONTACT_FIELDS = ['first_name', 'last_name', 'phone', 'email', 'address', 'city', 'zip'];
function leadFieldsChanged(p) {
  const approved = p._approved_changes;
  const isSet = approved && typeof approved === 'object' && !Array.isArray(approved);
  return LEAD_CONTACT_FIELDS.filter(f => (isSet ? approved[f] !== undefined : approved == null && p[f] !== undefined));
}
// The fields a NEWER card states: its approved changes plus the fields a whole
// address asserts (params._asserted_fields: address, city, zip) even when one
// of them is a preview-time no-op, so it still replaces an older card for
// that field.
function leadFieldsAsserted(p) {
  const asserted = Array.isArray(p._asserted_fields) ? p._asserted_fields.filter(f => LEAD_CONTACT_FIELDS.includes(f)) : [];
  return [...new Set([...leadFieldsChanged(p), ...asserted])];
}
const SUPERSEDE_RULES = {
  // A booking is one event: a new proposal for the same customer, catalog
  // service and day replaces the earlier one (a changed time or price is the
  // revision). The preview pins the resolved catalog id (_booking_service_id),
  // so two accepted names for one service share a key; the raw name is the
  // fallback when no catalog row was pinned.
  create_appointment: {
    key: p => {
      const service = idPart(p._booking_service_id) ? `svc:${idPart(p._booking_service_id)}` : (idPart(p.service_type) ? `name:${idPart(p.service_type)}` : null);
      const parts = [idPart(p.customer_id ?? p.customerId), service, idPart(p.scheduled_date)];
      return parts.every(Boolean) ? parts.join('|') : null;
    },
    covers: () => true,
    afterConfirmed: 'refuse',
    confirmedMessage: 'An earlier card for this booking was already confirmed. Nothing was prepared. Tell the operator to move that visit instead of booking it again.',
  },
  // A lead edit replaces an earlier edit when the newer one changes ANY field
  // the earlier one would change (their approved fields overlap). Partial
  // overlap counts: if the older card still saved its wrong value for the shared
  // field, the newer card's proposal-time "from" check would fail at Confirm and
  // the correction would be lost. KNOWN COST: the older card is cancelled whole,
  // so a field it changed that the newer card does not touch is lost with it and
  // the operator re-asks. Disjoint fields coexist (a card for another field
  // stays). "Changes" is the card's approved change set (params._approved_changes,
  // { field: { from, to } }, pinned from the preview and holding only fields
  // whose value really differs), not the raw input: a raw field that already had
  // that value is not part of the card's effect. Rows with no approved set (older
  // rows) fall back to the raw contact fields, with the same overlap rule. A card
  // whose approved set is empty or malformed changes nothing (its Confirm is
  // refused by the tool), so it is never treated as replaced and is left alone.
  update_lead_contact: {
    key: p => idPart(p.lead_id ?? p.leadId),
    covers: (newer, older) => {
      // Both sides count asserted fields (Codex r7): an older whole-address
      // card that keeps the current city is still replaced by a newer city card.
      const written = leadFieldsAsserted(older);
      const covered = leadFieldsAsserted(newer);
      return written.some(f => covered.includes(f));
    },
    afterConfirmed: 'allow',
  },
};

const REQUEST_STAMP = '_ib_request_started_at';
const paramsOf = row => (typeof row.params === 'string' ? JSON.parse(row.params) : (row.params || {}));
function intentKey(toolName, params) {
  const rule = SUPERSEDE_RULES[toolName];
  return rule ? rule.key(params || {}) : null;
}
const intentLock = (actor, toolName, key) => `ib-supersede:${actor}:${toolName}:${key}`;

// WHAT "SAME INTENT" MEANS (owner-visible rule). The same operator proposing
// the same booking (same customer, same catalog service, same day) or the same
// lead edit again IS a replacement, whichever chat window or surface it came
// from. A wrong cancel costs one re-ask; a missed cancel costs a double booking
// or a wrong edit. So scope is: same actor (requested_by, set from the admin id
// on the platform-on and platform-off paths alike) + same tool + same intent
// key. Evidence is read from ib_pending_actions itself, never from ib_tasks, so
// it works with GATE_IB_PLATFORM on or off. How far back a sibling counts
// depends on its direction (see intentSiblings).
//
// ORDER: the card's request-start stamp (params._ib_request_started_at, set by
// the /query route on both paths), else its created_at; ties break on
// (created_at, id). A request that FINISHES late still carries its early start,
// so it cannot cancel, or override, a card from a request that started later.
//
// LOCK: createPendingAction and claimForConfirm both take
// pg_advisory_xact_lock(hashtextextended('ib-supersede:<actor>:<tool>:<key>'))
// before they read or write. Lock order, everywhere: [own ib_tasks row FOR
// UPDATE, proposals on the platform path only] -> intent advisory lock -> card
// rows. The confirm path never touches ib_tasks, and nothing takes a card row
// first and then waits for an advisory lock, so no cycle exists.
//
// Reads this card's same-intent siblings (any status) in one query, in SQL so
// microsecond timestamps are compared exactly. The window depends on direction:
//   NEWER siblings (a later request's card; the evidence that this card is
//     stale): every card whose order key is after this card's, no matter how
//     long ago this request started - a task stays resumable for 30 days. The
//     lower bound is the index-friendly fact that a card of a later request
//     cannot have been created before this request started:
//     sibling.created_at >= this request's start - 1 minute. The minute only
//     absorbs clock skew between the app (which stamps the start) and the
//     database (which stamps created_at).
//   OLDER siblings (cards this one replaces or repeats): created within
//     TTL_MINUTES before this card. Pending cards expire after TTL_MINUTES, so
//     nothing older is a live proposal, and an older confirmed card only counts
//     as "already booked" within one card lifetime.
const STAMP_OF = alias => `COALESCE(NULLIF(${alias}.params->>'${REQUEST_STAMP}', '')::timestamptz, ${alias}.created_at)`;
const IS_NEWER = `(${STAMP_OF('pa')}, pa.created_at, pa.id::text) > (${STAMP_OF('o')}, o.created_at, o.id::text)`;
async function intentSiblings(q, ownId, toolName, key) {
  const rule = SUPERSEDE_RULES[toolName];
  const rows = await q('ib_pending_actions as pa')
    .join('ib_pending_actions as o', 'o.id', q.raw('?', [ownId]))
    .whereNot('pa.id', ownId)
    .whereRaw('pa.requested_by = o.requested_by')
    .whereRaw('pa.tool_name = o.tool_name')
    .where(function () {
      this.whereRaw(`${IS_NEWER} AND pa.created_at >= ${STAMP_OF('o')} - interval '1 minute'`)
        .orWhereRaw(`NOT (${IS_NEWER}) AND pa.created_at >= o.created_at - make_interval(mins => ${Number(TTL_MINUTES)})`);
    })
    .select('pa.id', 'pa.params', 'pa.status', 'pa.result', 'pa.expires_at', q.raw(`${IS_NEWER} AS newer`));
  return rows.filter(row => rule.key(paramsOf(row)) === key).map(row => ({ ...row, params: paramsOf(row) }));
}

// Serialize with every other proposal and Confirm for this intent; the lock is
// released at commit, after the writes made under it are visible.
const lockIntent = (q, requestedBy, toolName, key) =>
  q.raw('SELECT pg_advisory_xact_lock(hashtextextended(?, 0))', [intentLock(requestedBy, toolName, key)]);

// Intent cards carry when their request started (see ORDER above).
function stampRequestStart(params, requestStartedAt) {
  const startedAt = requestStartedAt ? new Date(requestStartedAt) : null;
  return startedAt && !Number.isNaN(startedAt.getTime()) ? { ...params, [REQUEST_STAMP]: startedAt.toISOString() } : params;
}

// Locks the running task and reads this actor's earlier cards of the task.
// Returns the card this step already stored (a retry), or null when the step
// is new; throws when the lease is lost or a preceding action is unresolved.
async function loadTaskStep(trx, { taskId, requestedBy, runnerToken, toolName, stepKey: actionStepKey }) {
  const task = await trx('ib_tasks').where({ id: taskId, actor_id: String(requestedBy), runner_token: runnerToken, state: 'running' })
    .where('lease_expires_at', '>', trx.fn.now()).forUpdate().first('id');
  if (!task) throw new Error('Task execution was superseded');
  const previous = await trx('ib_pending_actions').where({ task_id: taskId, requested_by: String(requestedBy) });
  const existing = previous.find(row => row.tool_name === toolName && row.step_key === actionStepKey)
    || previous.find(row => row.tool_name === toolName && row.params?._ib_step_key_version !== 2 && legacyStepKey(row) === actionStepKey);
  if (existing) return existing;
  if (previous.some(row => row.status !== 'confirmed'
    || !['completed', 'provider_accepted'].includes(executionOutcome(row.result)))) {
    throw new Error('Resolve the preceding action outcome before preparing another write');
  }
  return null;
}

// The params a card stores: task step marker plus the validated task context.
// New step hashes include normalized UUID identity even when their canonical
// product/default inputs come from a preview. Old approval payloads/hashes
// remain untouched; the marker is server-owned and bound in new params_hash.
async function approvalParams(params, { taskId, toolName }) {
  if (taskId) params = { ...params, _ib_step_key_version: 2 };
  if (!params?._ib_task_context) return params;
  const scope = await require('./task-context').validateRecordTarget(params, params._ib_task_context,
    { toolName, forApproval: true });
  if (scope.error) throw Object.assign(new Error(scope.error), { code: scope.code });
  return { ...params, _ib_task_context: scope };
}

// Inserts a pending card. { created: false } means a task step replay hit the
// unique (task_id, step_key) key and `row` is the card stored earlier.
async function insertPendingRow(trx, { toolName, params, summary, requestedBy, context, contract, contractHash, taskId, stepKey: actionStepKey }) {
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
    ...(taskId ? { task_id: taskId, step_key: actionStepKey } : {}),
  });
  if (taskId) insert = insert.onConflict(['task_id', 'step_key']).ignore();
  const [created] = await insert.returning('*');
  const row = created || await trx('ib_pending_actions').where({ task_id: taskId, step_key: actionStepKey, requested_by: String(requestedBy) }).first();
  if (!row) throw new Error('Pending action could not be recorded');
  return { row, created: !!created };
}

// A newer card that covers this one, in ANY status (pending, confirmed,
// cancelled, expired): the operator has moved past this proposal.
const supersededByNewer = (rule, siblings, params) => siblings.some(sib => sib.newer && rule.covers(sib.params, params));

// An older card that already ran (or may be running): a one-off effect must not
// be repeated by a second confirmable card.
const repeatsConfirmedCard = (rule, siblings, params) => rule.afterConfirmed === 'refuse'
  && siblings.some(sib => !sib.newer && sib.status === 'confirmed' && rule.covers(params, sib.params)
    && !['failed', 'blocked'].includes(executionOutcome(sib.result)));

async function cancelCards(q, ids) {
  return q('ib_pending_actions').whereIn('id', ids).where({ status: 'pending' })
    .update({ status: 'cancelled', updated_at: q.fn.now() });
}

// Cancels the pending cards of older requests that `params` replaces.
async function cancelOlderCards(trx, rule, siblings, params, newRowId) {
  const ids = siblings.filter(sib => !sib.newer && sib.status === 'pending' && rule.covers(params, sib.params)).map(sib => sib.id);
  if (!ids.length) return;
  const count = await cancelCards(trx, ids);
  if (count) logger.info(`[intelligence-bar:pending] Cancelled ${count} card(s) superseded by pending action ${newRowId}`);
}

// Applies the supersession rules to a card just stored under the intent lock.
// Returns the row to hand back to the caller (flagged when the card is not
// confirmable): stale cards are stored cancelled, a repeated booking is removed.
async function applySupersession(trx, row, { toolName, params }) {
  const rule = SUPERSEDE_RULES[toolName];
  const siblings = await intentSiblings(trx, row.id, toolName, intentKey(toolName, params));
  if (supersededByNewer(rule, siblings, params)) {
    await cancelCards(trx, [row.id]);
    logger.info(`[intelligence-bar:pending] Pending action ${row.id} was already superseded by a newer request; stored cancelled`);
    return { ...row, status: 'cancelled', superseded_by_newer_request: true };
  }
  if (repeatsConfirmedCard(rule, siblings, params)) {
    await trx('ib_pending_actions').where({ id: row.id }).del();
    logger.info(`[intelligence-bar:pending] ${toolName} refused: an earlier card for this intent was already confirmed`);
    return { ...row, status: 'cancelled', earlier_card_confirmed: rule.confirmedMessage };
  }
  await cancelOlderCards(trx, rule, siblings, params, row.id);
  return row;
}

async function createPendingAction({ toolName, params, requestedBy, taskId, requestStartedAt = null, ...card }) {
  const intent = intentKey(toolName, params);
  if (intent) params = stampRequestStart(params, requestStartedAt);
  const persist = async trx => {
    if (taskId) {
      const existing = await loadTaskStep(trx, { taskId, requestedBy, runnerToken: card.runnerToken, toolName, stepKey: card.stepKey });
      if (existing) return existing;
    }
    const stored = await approvalParams(params, { taskId, toolName });
    if (intent) await lockIntent(trx, requestedBy, toolName, intent);
    const { row, created } = await insertPendingRow(trx, { ...card, toolName, params: stored, requestedBy, taskId });
    const result = created && intent ? await applySupersession(trx, row, { toolName, params: stored }) : row;
    if (result === row) logger.info(`[intelligence-bar:pending] Proposed ${toolName} as pending action ${row.id}`);
    return result;
  };
  return taskId || intent ? db.transaction(persist) : persist(db);
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
  // A card for an intent with a supersede rule claims under the intent lock and
  // is refused when a NEWER card for the same intent exists (any status). Every
  // other card takes the single-statement claim below, unchanged.
  const peek = await db('ib_pending_actions').where({ id }).first('tool_name', 'params', 'requested_by', 'status', 'expires_at');
  const key = peek && peek.status === 'pending' && String(peek.requested_by) === String(requestedBy)
    && new Date(peek.expires_at).getTime() > Date.now() ? intentKey(peek.tool_name, paramsOf(peek)) : null;
  if (!key) return claimRow(db, id, requestedBy, echoed);
  const rule = SUPERSEDE_RULES[peek.tool_name];
  return db.transaction(async (trx) => {
    await lockIntent(trx, requestedBy, peek.tool_name, key);
    const siblings = await intentSiblings(trx, id, peek.tool_name, key);
    if (siblings.some(sib => sib.newer && rule.covers(sib.params, paramsOf(peek)))) {
      await trx('ib_pending_actions').where({ id, status: 'pending', requested_by: String(requestedBy) })
        .update({ status: 'cancelled', updated_at: trx.fn.now() });
      logger.warn(`[intelligence-bar:pending] Confirm on ${id} refused: a newer card for the same intent exists`);
      return { error: 'cancelled' };
    }
    return claimRow(trx, id, requestedBy, echoed);
  });
}

async function claimRow(q, id, requestedBy, echoed) {
  const [claimed] = await q('ib_pending_actions')
    .where({ id, status: 'pending', requested_by: String(requestedBy) })
    .where('expires_at', '>', q.fn.now())
    .where((qb) => {
      qb.whereNull('contract_hash');
      if (echoed) qb.orWhere('contract_hash', echoed);
    })
    .update({ status: 'confirmed', consumed_at: q.fn.now(), updated_at: q.fn.now() })
    .returning('*');

  if (!claimed) {
    const row = await q('ib_pending_actions').where({ id }).first();
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
    await q('ib_pending_actions').where({ id }).update({ status: 'cancelled', updated_at: q.fn.now() });
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

async function recordResult(id, result, { database = db, critical = false, onlyIfEmpty = false } = {}) {
  try {
    const query = database('ib_pending_actions').where({ id });
    if (critical) query.where({ status: 'confirmed' }).whereNotNull('consumed_at');
    if (onlyIfEmpty) query.whereNull('result');
    const updated = await query.update({
      result: JSON.stringify(result ?? null),
      updated_at: database.fn.now(),
    });
    if (critical && updated !== 1) throw new Error('Consumed action receipt was not saved');
    return true;
  } catch (err) {
    if (critical) throw err;
    logger.warn(`[intelligence-bar:pending] Could not record result for ${id} (code=${err.code || 'unknown'})`);
    return false;
  }
}

/** Actor-bound recovery after disconnect. Consumed-without-result is unknown,
 * never permission to execute again. Confirmation credentials stay client-only.
 */
async function getActionReceipt(id, requestedBy) {
  const row = await db('ib_pending_actions').where({ id, requested_by: String(requestedBy) }).first();
  return row ? actionReceipt(row) : null;
}

// Format rows already selected under their actor scope. Task snapshots and
// lists share this projection without issuing a second read per action.
function actionReceipt(row) {
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
  actionReceipt,
  TTL_MINUTES,
  paramsHash,
  stepKey,
  stableStringify,
  createPendingAction,
  intentKey,
  intentLock,
  claimForConfirm,
  cancelPendingAction,
  recordResult,
  getActionReceipt,
  attachThread,
  forTask,
};
