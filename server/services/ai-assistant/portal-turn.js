const crypto = require('crypto');
const db = require('../../models/db');
const { WAVES_SUPPORT_PHONE_DISPLAY } = require('../../constants/business');
const logger = require('../logger');

const TURN_BUDGET_MS = 15_000;
const FINALIZE_RESERVE_MS = 650;
const RETRY_POLL_MS = 45;

const TIMEOUT_REPLY = `I'm having trouble getting that answer right now. Please try again, or call us at ${WAVES_SUPPORT_PHONE_DISPLAY}.`;
const BUSY_REPLY = "I'm still finishing your earlier question. Please try again in a moment.";

class PortalTurnDeadlineError extends Error {
  constructor(stage) {
    super(`Portal chat deadline reached during ${stage}`);
    this.name = 'PortalTurnDeadlineError';
    this.code = 'PORTAL_CHAT_DEADLINE';
  }
}

function parseJson(value) {
  if (!value) return null;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { return null; }
}

function hash(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new PortalTurnDeadlineError('queue wait'));
    const onAbort = () => {
      clearTimeout(timer);
      reject(new PortalTurnDeadlineError('queue wait'));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function raceDeadline(promise, signal, stage) {
  if (signal.aborted) return Promise.reject(new PortalTurnDeadlineError(stage));
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener('abort', onAbort);
      reject(new PortalTurnDeadlineError(stage));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve(promise).then((value) => {
      signal.removeEventListener('abort', onAbort);
      resolve(value);
    }, (err) => {
      signal.removeEventListener('abort', onAbort);
      reject(err);
    });
  });
}

function timeoutQuery(query, remainingMs) {
  if (query && typeof query.timeout === 'function') {
    query.timeout(Math.max(1, Math.floor(remainingMs)), { cancel: true });
  }
  return query;
}

async function withBoundedConnection({ deadlineAt, signal }, stage, fn) {
  if (signal.aborted || Date.now() >= deadlineAt) throw new PortalTurnDeadlineError(stage);
  const acquisition = db.client.pool.acquire();
  let connection = null;
  const work = (async () => {
    connection = await acquisition.promise;
    try {
      if (signal.aborted || Date.now() >= deadlineAt) throw new PortalTurnDeadlineError(stage);
      return await fn(connection);
    } finally {
      await db.client.releaseConnection(connection);
    }
  })();
  try {
    return await raceDeadline(work, signal, stage);
  } finally {
    if (!connection) acquisition.abort();
    // Tarn removes an aborted queued acquisition in its promise handler.
    await acquisition.promise.catch(() => {});
  }
}

function queryOnConnection(query, connection, deadlineAt, signal, stage) {
  const remaining = deadlineAt - Date.now();
  if (signal.aborted || remaining <= 0) throw new PortalTurnDeadlineError(stage);
  // Once dispatched, let Knex's cancel-capable timeout settle the driver
  // promise. The outer connection wrapper may return to the HTTP deadline,
  // but it keeps this connection checked out until cancellation completes.
  return timeoutQuery(query.connection(connection), remaining);
}

// A transaction callback often passes its `trx` into an existing service.
// Wrap the callable Knex object so every builder that service creates gets
// the turn's *current* remaining time. This keeps later queries in a short
// multi-query transaction from inheriting a stale timeout set at its start.
function deadlineTransaction(trx, context, stage) {
  const bounded = (query) => {
    context.assertActive(stage);
    return timeoutQuery(query, context.remainingMs());
  };
  return new Proxy(trx, {
    apply(target, _thisArg, args) {
      return bounded(Reflect.apply(target, target, args));
    },
    get(target, property) {
      if (property === 'raw') return (...args) => bounded(target.raw(...args));
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

function turnScopeKey({ customerId, channelIdentifier, propertyId }) {
  return hash([customerId, channelIdentifier, propertyId || 'primary'].join('\0'));
}

// A saved-property token gets its own conversation history. The selected
// property comes only from authenticate; the browser's session id cannot
// move a turn between property scopes. Primary-profile sessions keep their
// existing identifier so already-open chats and reports remain reachable.
function portalConversationIdentifier(channelIdentifier, propertyId) {
  return propertyId ? `property-${hash([propertyId, channelIdentifier].join('\0')).slice(0, 48)}` : channelIdentifier;
}

function fallbackResult(requestId, reply = TIMEOUT_REPLY, extra = {}) {
  return { reply, escalated: false, generated: false, requestId, ...extra };
}

function createTurnContext({ row, attemptId, workDeadlineAt, hardDeadlineAt, workSignal, hardSignal }) {
  let fallbackExtrasProvider = null;
  let committedResult = null;
  const context = {
    requestRowId: row.id,
    requestId: row.request_id,
    attemptId,
    workDeadlineAt,
    hardDeadlineAt,
    signal: workSignal,
    hardSignal,
    remainingMs(finalize = false) {
      return (finalize ? hardDeadlineAt : workDeadlineAt) - Date.now();
    },
    assertActive(stage = 'turn work', finalize = false) {
      const signal = finalize ? hardSignal : workSignal;
      if (signal.aborted || context.remainingMs(finalize) <= 0) {
        throw new PortalTurnDeadlineError(stage);
      }
    },
    registerFallbackExtras(provider) {
      fallbackExtrasProvider = typeof provider === 'function' ? provider : null;
    },
    fallbackExtras() {
      if (!fallbackExtrasProvider) return {};
      try {
        const supplied = fallbackExtrasProvider() || {};
        const extras = {};
        // Only the completed, server-built portal affordances are eligible
        // to ride a timeout reply. Snapshot them now so a raced-away task
        // cannot mutate the response after coordination has moved on.
        if (Array.isArray(supplied.actions) && supplied.actions.length) {
          extras.actions = structuredClone(supplied.actions);
        }
        if (Array.isArray(supplied.cards) && supplied.cards.length) {
          extras.cards = structuredClone(supplied.cards);
        }
        return extras;
      } catch {
        return {};
      }
    },
    async persistCommittedResult(executor, result) {
      context.assertActive('committed response persistence');
      const response = { ...result, requestId: context.requestId };
      const persisted = await executor('portal_chat_requests').where({
        id: context.requestRowId,
        state: 'processing',
        attempt_id: context.attemptId,
      }).update({
        response: executor.raw('COALESCE(response, ?::jsonb)', [JSON.stringify(response)]),
        conversation_id: executor.raw(
          'CASE WHEN response IS NULL THEN ? ELSE conversation_id END',
          [result.conversationId || null],
        ),
        updated_at: executor.fn.now(),
      }).returning('response');
      const authoritative = parseJson(persisted?.[0]?.response);
      if (!authoritative) throw new PortalTurnDeadlineError('stale committed response');
      return authoritative;
    },
    rememberCommittedResult(result) {
      committedResult = result ? structuredClone({ ...result, requestId: context.requestId }) : null;
      return committedResult;
    },
    committedResult() {
      return committedResult ? structuredClone(committedResult) : null;
    },
    async waitFor(work, stage = 'turn work', finalize = false) {
      context.assertActive(stage, finalize);
      const signal = finalize ? hardSignal : workSignal;
      const promise = typeof work === 'function' ? work() : work;
      const value = await raceDeadline(Promise.resolve(promise), signal, stage);
      context.assertActive(stage, finalize);
      return value;
    },
    async query(query, stage = 'database', finalize = false) {
      context.assertActive(stage, finalize);
      const signal = finalize ? hardSignal : workSignal;
      const deadlineAt = finalize ? hardDeadlineAt : workDeadlineAt;
      return withBoundedConnection({ deadlineAt, signal }, stage,
        (connection) => queryOnConnection(query, connection, deadlineAt, signal, stage));
    },
    async transaction(stage, container) {
      context.assertActive(stage);
      return withBoundedConnection({ deadlineAt: workDeadlineAt, signal: workSignal }, stage,
        (connection) => db.transaction(async (trx) => {
          context.assertActive(stage);
          const ownedAttempt = await queryOnConnection(
            trx('portal_chat_requests').where({
              id: context.requestRowId,
              state: 'processing',
              attempt_id: context.attemptId,
            }).forUpdate().first('id'),
            connection, workDeadlineAt, workSignal, stage,
          );
          if (!ownedAttempt) throw new PortalTurnDeadlineError('stale turn attempt');
          await queryOnConnection(
            trx.raw("SELECT set_config('statement_timeout', ?, true)", [`${Math.max(1, context.remainingMs())}ms`]),
            connection, workDeadlineAt, workSignal, stage,
          );
          const result = await container(deadlineTransaction(trx, context, stage));
          context.assertActive(stage);
          // COMMIT is the next command on this connection. Refresh its server
          // timeout from the absolute turn deadline, then check once more.
          await queryOnConnection(
            trx.raw("SELECT set_config('statement_timeout', ?, true)", [`${Math.max(1, context.remainingMs())}ms`]),
            connection, workDeadlineAt, workSignal, stage,
          );
          context.assertActive(stage);
          return result;
        }, { connection }));
    },
    providerOptions() {
      context.assertActive('model call');
      const remaining = context.remainingMs();
      return {
        signal: workSignal,
        timeout: Math.max(1, remaining),
        // A retry is useful only while enough budget remains for its backoff,
        // response, and final persistence. The SDK shares the same timeout.
        maxRetries: remaining >= 6_000 ? 1 : 0,
      };
    },
  };
  return context;
}

async function ensureRequest({ requestId, customerId, propertyId, channelIdentifier, message, scopeKey, leaseExpiresAt }, root) {
  const row = {
    request_id: requestId,
    customer_id: customerId,
    property_id: propertyId || null,
    channel_identifier: channelIdentifier,
    scope_key: scopeKey,
    message_hash: hash(message),
    state: 'pending',
    lease_expires_at: leaseExpiresAt,
  };
  const insert = db('portal_chat_requests').insert(row)
    .onConflict(['customer_id', 'request_id']).ignore();
  await root.query(insert, 'request receipt');
  let existing = await root.query(
    db('portal_chat_requests').where({ customer_id: customerId, request_id: requestId }).first(),
    'request reconciliation',
  );
  if (!existing) throw new Error('Portal chat request receipt was not saved');
  if (existing.message_hash !== row.message_hash
    || existing.scope_key !== scopeKey
    || String(existing.property_id || '') !== String(propertyId || '')) {
    const err = new Error('requestId was already used for a different portal chat turn');
    err.status = 409;
    err.code = 'PORTAL_CHAT_REQUEST_MISMATCH';
    throw err;
  }
  if (existing.state === 'expired') {
    await root.query(db('portal_chat_requests')
      .where({ id: existing.id, state: 'expired' })
      .update({ state: 'pending', lease_expires_at: leaseExpiresAt, updated_at: db.fn.now() }), 'request revival');
  } else if (existing.state === 'pending') {
    await root.query(db('portal_chat_requests')
      .where({ id: existing.id, state: 'pending' })
      .update({ lease_expires_at: leaseExpiresAt, updated_at: db.fn.now() }), 'request lease refresh');
  }
  if (existing.state === 'expired') {
    existing = await root.query(db('portal_chat_requests').where({ id: existing.id }).first(), 'request revival reconciliation');
  }
  return existing;
}

async function claimRequest(row, attemptId, leaseExpiresAt, root) {
  try {
    return await root.transaction('turn claim', async (trx, connection) => {
      root.assertActive('turn claim');
      await root.queryOnConnection(
        trx('portal_chat_requests')
          .where({ scope_key: row.scope_key, state: 'pending' })
          .where('lease_expires_at', '<=', new Date())
          .update({ state: 'expired', attempt_id: null, updated_at: trx.fn.now() }),
        connection, 'abandoned turn expiry',
      );
      const active = await root.queryOnConnection(
        trx('portal_chat_requests').where({ scope_key: row.scope_key, state: 'processing' }).forUpdate().first(),
        connection, 'turn claim',
      );
      // A retry can begin polling before the owning attempt checkpoints a
      // committed handoff. Re-read the locked row on every poll: once a
      // response exists it is the durable outcome, even if the first worker's
      // final state transition later times out. Never release and reclaim that
      // row, because doing so would rerun the turn and overwrite the handoff.
      if (active && String(active.id) === String(row.id)) {
        const response = parseJson(active.response);
        if (response) return { kind: 'completed', response };
      }
      if (active && new Date(active.lease_expires_at).getTime() <= Date.now()) {
        const retryingExpiredAttempt = String(active.id) === String(row.id);
        await root.queryOnConnection(
          trx('portal_chat_requests').where({ id: active.id, attempt_id: active.attempt_id, state: 'processing' })
            .update({
              state: retryingExpiredAttempt ? 'pending' : 'expired',
              attempt_id: null,
              lease_expires_at: retryingExpiredAttempt ? leaseExpiresAt : null,
              updated_at: trx.fn.now(),
            }),
          connection, 'expired turn release',
        );
      } else if (active) {
        return { kind: 'busy' };
      }

      const current = await root.queryOnConnection(
        trx('portal_chat_requests').where({ id: row.id }).forUpdate().first(),
        connection, 'turn claim',
      );
      const committed = parseJson(current.response);
      if (committed) return { kind: 'completed', response: committed };
      if (current.state === 'completed') return { kind: 'completed', response: fallbackResult(row.request_id) };

      const oldest = await root.queryOnConnection(
        trx('portal_chat_requests').where({ scope_key: row.scope_key, state: 'pending' })
          .orderBy('created_at').orderBy('id').first('id'),
        connection, 'turn ordering',
      );
      if (!oldest || String(oldest.id) !== String(row.id)) return { kind: 'busy' };

      const changed = await root.queryOnConnection(
        trx('portal_chat_requests').where({ id: row.id, state: 'pending' }).update({
          state: 'processing',
          attempt_id: attemptId,
          lease_expires_at: leaseExpiresAt,
          updated_at: trx.fn.now(),
        }),
        connection, 'turn claim',
      );
      return changed === 1 ? { kind: 'claimed' } : { kind: 'busy' };
    });
  } catch (err) {
    // The partial unique index is the final cross-process serialization
    // guard if two short claim transactions observe the scope together.
    if (err?.code === '23505') return { kind: 'busy' };
    throw err;
  }
}

async function checkpointResult(context, result) {
  const remembered = context.committedResult();
  if (remembered) return remembered;

  const response = { ...result, requestId: context.requestId };
  const persisted = await context.query(
    db('portal_chat_requests')
      .where({ id: context.requestRowId, state: 'processing', attempt_id: context.attemptId })
      .update({
        response: db.raw('COALESCE(response, ?::jsonb)', [JSON.stringify(response)]),
        conversation_id: db.raw(
          'CASE WHEN response IS NULL THEN ? ELSE conversation_id END',
          [result.conversationId || null],
        ),
        updated_at: db.fn.now(),
      })
      .returning('response'),
    'reply checkpoint',
    true,
  );
  const authoritative = parseJson(persisted?.[0]?.response);
  if (authoritative) return context.rememberCommittedResult(authoritative);
  const recovered = await recoverCommittedResult(context);
  if (recovered) return recovered;
  throw new PortalTurnDeadlineError('stale reply checkpoint');
}

async function finishRequest(context) {
  const persisted = await context.query(
    db('portal_chat_requests')
      .where({ id: context.requestRowId, state: 'processing', attempt_id: context.attemptId })
      .whereNotNull('response')
      .update({
        state: 'completed',
        attempt_id: null,
        lease_expires_at: null,
        updated_at: db.fn.now(),
      })
      .returning('response'),
    'reply completion',
    true,
  );
  const authoritative = parseJson(persisted?.[0]?.response);
  if (authoritative) return authoritative;
  const reconciled = await context.query(
    db('portal_chat_requests').where({ id: context.requestRowId, state: 'completed' }).first('response'),
    'reply reconciliation',
    true,
  );
  return parseJson(reconciled?.response) || context.committedResult() || fallbackResult(context.requestId);
}

async function recoverCommittedResult(context) {
  const remembered = context.committedResult();
  if (remembered) return remembered;
  try {
    const row = await context.query(
      db('portal_chat_requests').where({
        id: context.requestRowId,
        state: 'processing',
        attempt_id: context.attemptId,
      }).whereNotNull('response').first('response'),
      'committed response recovery',
      true,
    );
    const recovered = parseJson(row?.response);
    return recovered ? context.rememberCommittedResult(recovered) : null;
  } catch {
    return context.committedResult();
  }
}

// A response checkpoint is already the customer-visible truth. Promoting its
// receipt to completed is cleanup: try it, but never trade the known response
// for a fallback if that UPDATE is unavailable or misses its deadline.
async function reconcileDurableReplay(row, requestId, customerId, root) {
  const replay = parseJson(row.response);
  if (!replay) return null;
  const durable = { ...replay, requestId };
  if (row.state === 'completed') return durable;
  try {
    await root.query(db('portal_chat_requests')
      .where({ id: row.id })
      .whereNotNull('response')
      .whereIn('state', ['pending', 'processing', 'expired'])
      .update({
        state: 'completed',
        conversation_id: replay.conversationId || null,
        attempt_id: null,
        lease_expires_at: null,
        updated_at: db.fn.now(),
      }), 'committed handoff completion');
  } catch (err) {
    if (err?.code !== 'PORTAL_CHAT_DEADLINE') {
      logger.error(`[portal-chat] committed response cleanup failed: ${err.message}`, { customerId, requestId });
    }
  }
  return durable;
}

async function waitForClaim({ row, attemptId, leaseExpiresAt, workDeadlineAt, workSignal, root }) {
  let claim;
  while (Date.now() < workDeadlineAt) {
    claim = await claimRequest(row, attemptId, leaseExpiresAt, root);
    if (claim.kind !== 'busy') return claim;
    await delay(Math.min(RETRY_POLL_MS, Math.max(1, workDeadlineAt - Date.now())), workSignal);
  }
  return claim;
}

async function runPortalTurn({ requestId, customerId, propertyId = null, channelIdentifier, message, processTurn, budgetMs = TURN_BUDGET_MS }) {
  const startedAt = Date.now();
  const hardDeadlineAt = startedAt + budgetMs;
  const workDeadlineAt = hardDeadlineAt - Math.min(FINALIZE_RESERVE_MS, Math.floor(budgetMs / 4));
  const workController = new AbortController();
  const hardController = new AbortController();
  const workTimer = setTimeout(() => workController.abort(), Math.max(1, workDeadlineAt - Date.now()));
  const hardTimer = setTimeout(() => hardController.abort(), Math.max(1, hardDeadlineAt - Date.now()));
  let turn = null;
  const root = {
    assertActive(stage) {
      if (hardController.signal.aborted || Date.now() >= hardDeadlineAt) throw new PortalTurnDeadlineError(stage);
    },
    async query(query, stage) {
      return withBoundedConnection({ deadlineAt: hardDeadlineAt, signal: hardController.signal }, stage,
        (connection) => queryOnConnection(query, connection, hardDeadlineAt, hardController.signal, stage));
    },
    async queryOnConnection(query, connection, stage) {
      return queryOnConnection(query, connection, hardDeadlineAt, hardController.signal, stage);
    },
    async transaction(stage, container) {
      return withBoundedConnection({ deadlineAt: hardDeadlineAt, signal: hardController.signal }, stage,
        (connection) => db.transaction((trx) => container(trx, connection), { connection }));
    },
  };

  try {
    const scopeKey = turnScopeKey({ customerId, channelIdentifier, propertyId });
    const row = await ensureRequest({
      requestId, customerId, propertyId, channelIdentifier, message, scopeKey,
      leaseExpiresAt: new Date(hardDeadlineAt),
    }, root);
    const replay = await reconcileDurableReplay(row, requestId, customerId, root);
    if (replay) return replay;

    const attemptId = crypto.randomUUID();
    const claim = await waitForClaim({
      row,
      attemptId,
      leaseExpiresAt: new Date(hardDeadlineAt),
      workDeadlineAt,
      workSignal: workController.signal,
      root,
    });
    if (claim?.kind === 'completed') return { ...claim.response, requestId };
    if (claim?.kind !== 'claimed') return fallbackResult(requestId, BUSY_REPLY, { pending: true, retryable: true });
    // A claim transaction can begin before the work deadline and finish in
    // the finalization reserve. Do not turn that unstarted attempt into a
    // completed timeout; its short lease lets a retry reclaim it safely.
    if (workController.signal.aborted || Date.now() >= workDeadlineAt) {
      return fallbackResult(requestId, BUSY_REPLY, { pending: true, retryable: true });
    }

    turn = createTurnContext({
      row, attemptId, workDeadlineAt, hardDeadlineAt,
      workSignal: workController.signal, hardSignal: hardController.signal,
    });
    let result;
    try {
      result = await turn.waitFor(() => processTurn(turn), 'portal chat turn');
    } catch (err) {
      if (err?.code !== 'PORTAL_CHAT_DEADLINE') {
        logger.error(`[portal-chat] turn failed: ${err.message}`, { customerId, requestId });
      }
      result = await recoverCommittedResult(turn)
        || fallbackResult(requestId, TIMEOUT_REPLY, turn.fallbackExtras());
    }
    await checkpointResult(turn, result);
    return await finishRequest(turn);
  } catch (err) {
    if (err?.status === 409) throw err;
    if (err?.code !== 'PORTAL_CHAT_DEADLINE') {
      logger.error(`[portal-chat] request coordination failed: ${err.message}`, { customerId, requestId });
    }
    const committed = turn ? await recoverCommittedResult(turn) : null;
    return committed
      || fallbackResult(requestId, TIMEOUT_REPLY, { ...turn?.fallbackExtras(), retryable: true });
  } finally {
    clearTimeout(workTimer);
    clearTimeout(hardTimer);
    workController.abort();
    hardController.abort();
  }
}

module.exports = {
  TURN_BUDGET_MS,
  PortalTurnDeadlineError,
  fallbackResult,
  portalConversationIdentifier,
  runPortalTurn,
  turnScopeKey,
};
