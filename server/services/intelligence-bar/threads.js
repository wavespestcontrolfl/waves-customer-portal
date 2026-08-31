/**
 * Server-persisted Intelligence Bar conversations (owner-ratified 2026-08-31).
 *
 * Dark behind GATE_IB_THREADS (default OFF; kill = unset). Admin actors only —
 * technician sessions keep the ephemeral client-held behavior. Every accessor
 * is actor-bound: a thread is readable/appendable only by the admin actor who
 * created it.
 *
 * What gets persisted is exactly what the client already round-trips: the
 * marker-tainted user/assistant text pair per exchange. Images are never
 * persisted (their text markers are). Persistence is best-effort from the
 * query path — a thread write failure must never fail the operator's answer.
 */

const db = require('../../models/db');
const logger = require('../logger');

// Retention (days) before a thread and its turns are hard-deleted. Owner
// default 365; override via IB_THREAD_RETENTION_DAYS.
const DEFAULT_RETENTION_DAYS = 365;

// How many trailing turns hydrate the client on resume. The model window
// stays the route's own trim (~8 turns) — this only bounds what the palette
// re-displays.
const RESUME_TURN_LIMIT = 40;

function threadsEnabled() {
  return process.env.GATE_IB_THREADS === 'true';
}

function retentionDays() {
  const n = Math.floor(Number(process.env.IB_THREAD_RETENTION_DAYS));
  return Number.isFinite(n) && n >= 30 ? n : DEFAULT_RETENTION_DAYS;
}

function deriveTitle(userText) {
  const line = String(userText || '').split('\n')[0].trim();
  return line.slice(0, 120) || 'Conversation';
}

/**
 * Append one exchange to a thread, creating the thread when threadId is null.
 * Returns { threadId } on success, null when the thread is missing or owned
 * by a different actor (the caller then responds without a thread id — the
 * client falls back to its ephemeral history).
 */
async function appendExchange({ actorId, threadId, context, userText, assistantText }) {
  if (!actorId || !userText || assistantText === undefined) return null;
  return db.transaction(async (trx) => {
    let thread;
    if (threadId) {
      thread = await trx('ib_threads')
        .where({ id: threadId, admin_actor_id: actorId })
        .forUpdate()
        .first();
      if (!thread) return null;
    } else {
      [thread] = await trx('ib_threads').insert({
        admin_actor_id: actorId,
        title: deriveTitle(userText),
        context: context || null,
      }).returning('*');
    }

    const [{ max }] = await trx('ib_thread_turns').where('thread_id', thread.id).max('seq');
    const nextSeq = (max || 0) + 1;
    await trx('ib_thread_turns').insert([
      { thread_id: thread.id, seq: nextSeq, role: 'user', content: String(userText) },
      { thread_id: thread.id, seq: nextSeq + 1, role: 'assistant', content: String(assistantText) },
    ]);
    await trx('ib_threads').where('id', thread.id)
      .update({ last_active_at: trx.fn.now(), updated_at: trx.fn.now() });
    return { threadId: thread.id };
  });
}

async function turnsAsHistory(threadId) {
  const turns = await db('ib_thread_turns')
    .where('thread_id', threadId)
    .orderBy('seq', 'desc')
    .limit(RESUME_TURN_LIMIT)
    .select('seq', 'role', 'content');
  return turns.reverse().map(t => ({ role: t.role, content: t.content }));
}

/** The actor's most recently active thread, hydrated for the palette. */
async function latestThread(actorId) {
  if (!actorId) return null;
  const thread = await db('ib_threads')
    .where('admin_actor_id', actorId)
    .orderBy('last_active_at', 'desc')
    .first();
  if (!thread) return null;
  return {
    id: thread.id,
    title: thread.title,
    context: thread.context,
    last_active_at: thread.last_active_at,
    conversationHistory: await turnsAsHistory(thread.id),
  };
}

/** One thread by id, actor-bound. */
async function getThread(actorId, threadId) {
  if (!actorId || !threadId) return null;
  const thread = await db('ib_threads')
    .where({ id: threadId, admin_actor_id: actorId })
    .first();
  if (!thread) return null;
  return {
    id: thread.id,
    title: thread.title,
    context: thread.context,
    last_active_at: thread.last_active_at,
    conversationHistory: await turnsAsHistory(thread.id),
  };
}

/** Recent threads for the picker (no turns). */
async function listThreads(actorId, limit = 20) {
  if (!actorId) return [];
  return db('ib_threads')
    .where('admin_actor_id', actorId)
    .orderBy('last_active_at', 'desc')
    .limit(Math.min(Math.max(Math.floor(Number(limit)) || 20, 1), 50))
    .select('id', 'title', 'context', 'last_active_at', 'created_at');
}

/** Hard-delete threads idle past retention; turns ride the FK cascade. */
async function purgeExpiredThreads() {
  const days = retentionDays();
  const deleted = await db('ib_threads')
    .whereRaw("last_active_at < NOW() - (? || ' days')::interval", [days])
    .del();
  if (deleted > 0) {
    logger.info(`[ib-threads] retention purge removed ${deleted} thread(s) idle > ${days}d`);
  }
  return { deleted, retention_days: days };
}

module.exports = {
  threadsEnabled,
  appendExchange,
  latestThread,
  getThread,
  listThreads,
  purgeExpiredThreads,
  deriveTitle,
  RESUME_TURN_LIMIT,
};
