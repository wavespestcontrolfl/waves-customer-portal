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
const { gateEnvValue } = require('../../config/feature-gates');

// Retention (days) before a thread and its turns are hard-deleted. Owner
// default 365; override via IB_THREAD_RETENTION_DAYS.
const DEFAULT_RETENTION_DAYS = 365;

// Idle limit (hours) after which the palette starts a NEW conversation
// instead of resuming the latest thread (owner 2026-10-12: one thread ran
// from 2026-09-03 with 178 turns, and an old customer bled into a new ask).
// Override via IB_THREAD_IDLE_HOURS; 0, negative or invalid = this default.
// The old thread stays in History and opens by hand (getThread has no limit).
const DEFAULT_IDLE_HOURS = 4;
const MAX_IDLE_HOURS = 24 * 365;

// How many trailing turns hydrate the client on resume. The model window
// stays the route's own trim (~8 turns) — this only bounds what the palette
// re-displays.
const RESUME_TURN_LIMIT = 40;

// Cap on client-supplied seed turns persisted into a NEWLY created thread
// (matches the route's model-window trim). Seeding keeps a thread coherent
// when a conversation that started ephemeral — gate flipped mid-chat, or the
// client detached after a rejected append — lands in a fresh thread.
const SEED_TURN_LIMIT = 8;

// Call-time read (a flip needs no redeploy); registered in
// config/feature-gates.js (`ibThreads`) for the centralized status listing.
const THREAD_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function threadsEnabled() {
  return gateEnvValue('GATE_IB_THREADS');
}

function retentionDays() {
  const n = Math.floor(Number(process.env.IB_THREAD_RETENTION_DAYS));
  return Number.isFinite(n) && n >= 30 ? n : DEFAULT_RETENTION_DAYS;
}

// Call-time read, like retentionDays.
function idleHours() {
  const n = Number(process.env.IB_THREAD_IDLE_HOURS);
  // Capped at a year so a typo can never overflow the interval cast.
  return Number.isFinite(n) && n > 0 ? Math.min(n, MAX_IDLE_HOURS) : DEFAULT_IDLE_HOURS;
}

function deriveTitle(userText) {
  const line = String(userText || '').split('\n')[0].trim();
  return line.slice(0, 120) || 'Conversation';
}

/**
 * Append one exchange to a thread, creating the thread when threadId is null.
 * Returns { threadId, lastSeq } on success, null when the thread is missing,
 * owned by a different actor, or when expectedSeq is absent or no longer
 * matches the thread's tail — a concurrent append from another tab landed
 * first, so this exchange was generated without seeing it (the caller then
 * responds without a thread id and the client detaches rather than
 * interleaving). A newly created thread is seeded with the caller's
 * round-tripped history (validated, capped) so it stays coherent when the
 * conversation started ephemeral.
 */
async function appendExchange({ actorId, threadId, expectedSeq, context, userText, assistantText, seedTurns }) {
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
      const seeds = (Array.isArray(seedTurns) ? seedTurns : [])
        .filter((t) => t && (t.role === 'user' || t.role === 'assistant') && typeof t.content === 'string' && t.content)
        .slice(-SEED_TURN_LIMIT);
      if (seeds.length) {
        await trx('ib_thread_turns').insert(
          // Seed rows carry the current time, not their real age, so they are
          // not live turns (live_turn defaults false) and recent-turn
          // grounding (recentOperatorTurns) skips them.
          seeds.map((t, i) => ({ thread_id: thread.id, seq: i + 1, role: t.role, content: t.content })),
        );
      }
    }

    const [{ max }] = await trx('ib_thread_turns').where('thread_id', thread.id).max('seq');
    const tail = max || 0;
    // Existing threads REQUIRE a matching tail seq — a missing/corrupt
    // thread_seq must not bypass the cross-tab interleaving guard.
    if (threadId && (!Number.isInteger(expectedSeq) || expectedSeq !== tail)) return null;
    const nextSeq = tail + 1;
    await trx('ib_thread_turns').insert([
      { thread_id: thread.id, seq: nextSeq, role: 'user', content: String(userText), live_turn: true },
      { thread_id: thread.id, seq: nextSeq + 1, role: 'assistant', content: String(assistantText), live_turn: true },
    ]);
    await trx('ib_threads').where('id', thread.id)
      .update({ last_active_at: trx.fn.now(), updated_at: trx.fn.now() });
    return { threadId: thread.id, lastSeq: nextSeq + 1 };
  });
}

async function turnsAsHistory(threadId) {
  const turns = await db('ib_thread_turns')
    .where('thread_id', threadId)
    .orderBy('seq', 'desc')
    .limit(RESUME_TURN_LIMIT)
    .select('seq', 'role', 'content');
  return {
    // The tail seq anchors the client's optimistic-concurrency check on the
    // next append (two tabs resuming the same thread can't interleave).
    lastSeq: turns.length ? turns[0].seq : 0,
    history: turns.reverse().map(t => ({ role: t.role, content: t.content })),
  };
}

/**
 * The actor's most recently active thread, hydrated for the palette, or null
 * when there is none OR the newest one has been idle past idleHours(): the
 * palette then opens a new conversation. Only this "resume the latest" lookup
 * has the limit: getThread (a thread opened by hand from History, or an
 * explicit thread_id on /query) is never idle-limited. /query itself never
 * picks "the latest" thread; with no thread_id it creates a new one.
 */
async function latestThread(actorId) {
  if (!actorId) return null;
  const thread = await db('ib_threads')
    .where('admin_actor_id', actorId)
    .whereRaw("last_active_at >= NOW() - (? || ' hours')::interval", [String(idleHours())])
    .orderBy('last_active_at', 'desc')
    .first();
  if (!thread) return null;
  const { lastSeq, history } = await turnsAsHistory(thread.id);
  return {
    id: thread.id,
    title: thread.title,
    context: thread.context,
    last_active_at: thread.last_active_at,
    lastSeq,
    conversationHistory: history,
  };
}

/**
 * True when this actor's thread exists and has had no exchange for longer than
 * idleHours(). The /query guard uses it so the limit does not depend on the
 * client clock: an explicit thread id that is idle, and that the operator did
 * not reopen on purpose from History, starts a new conversation. A missing,
 * foreign or malformed id is not "idle" (the normal append path handles it).
 */
async function isThreadIdle(actorId, threadId) {
  if (!actorId || !THREAD_ID_RE.test(String(threadId || ''))) return false;
  const row = await db('ib_threads')
    .where({ id: threadId, admin_actor_id: actorId })
    .whereRaw("last_active_at < NOW() - (? || ' hours')::interval", [String(idleHours())])
    .first('id');
  return !!row;
}

/** One thread by id, actor-bound. */
async function getThread(actorId, threadId) {
  if (!actorId || !threadId) return null;
  const thread = await db('ib_threads')
    .where({ id: threadId, admin_actor_id: actorId })
    .first();
  if (!thread) return null;
  const { lastSeq, history } = await turnsAsHistory(thread.id);
  return {
    id: thread.id,
    title: thread.title,
    context: thread.context,
    last_active_at: thread.last_active_at,
    lastSeq,
    conversationHistory: history,
  };
}

// Lines the IB route appends to a persisted user turn; they are server
// metadata, never operator text. The taint markers keep follow-ups redacted
// (see admin-intelligence-bar.js); the attachment note stands in for images.
const IMAGE_TAINT_MARKER = '[Image attachment context may contain PII]';
const PII_TAINT_MARKER = '[PII-bearing tool context may contain customer PII]';
// Added to the ASSISTANT turn of an exchange in which the general admin read
// (read_admin_data) returned data. The server writes it from its own per-request
// flag and reads it back (hasUntrustedRead) to taint every later request on the
// thread, so the taint lives in the server's record of the thread, never in
// anything the client sends. No LIKE wildcards in it.
const UNTRUSTED_READ_MARKER = '[Admin screen data was read in this conversation and may carry untrusted text]';
const ATTACHMENT_NOTE_RE = /^\[Operator attached \d+ images?\]$/;
// The user turn the route persists when a saved task continues; the operator
// never typed it.
const CONTINUATION_TURN = 'Continue the saved request using its recorded step outcomes.';

// A persisted user turn with the server-added lines removed: what the
// operator actually typed.
function operatorText(content) {
  return String(content || '').split('\n')
    .filter((line) => {
      const trimmed = line.trim();
      return trimmed !== IMAGE_TAINT_MARKER && trimmed !== PII_TAINT_MARKER && trimmed !== UNTRUSTED_READ_MARKER && trimmed !== CONTINUATION_TURN
        && !ATTACHMENT_NOTE_RE.test(trimmed);
    })
    .join('\n').trim();
}

/**
 * The actor's most recent OPERATOR (role='user') turns on one thread, bounded
 * by count and age. Used by the inventory write-target grounding fallback
 * (procurement-tools.resolveInventoryWriteTarget) to let a follow-up like
 * "1 bottle" ground off a product the operator themself named a turn or two
 * earlier — never an assistant turn, tool result, attachment, or note.
 *
 * Actor-bound like every other accessor here: a thread owned by a different
 * actor (or one that doesn't exist) returns []. The CURRENT, in-flight prompt
 * is never in this table yet (persistence happens after the reply), so this
 * only ever returns PRIOR turns.
 *
 * `maxSeq`, when an integer, bounds the read to turns at or before that seq
 * (Codex round-2 P2): with the same thread open in two tabs, this stops a
 * stale tab's request from grounding off turns appended by the OTHER tab
 * after the one it actually saw. The caller (resolveByOperatorGrounding)
 * refuses prior-turn grounding entirely when it has no valid bound to pass —
 * this only enforces whatever bound it IS given.
 */
async function recentOperatorTurns(actorId, threadId, { limit = 3, maxAgeMinutes = 30, maxSeq = null } = {}) {
  // Nothing to read when threads are off, or for a missing actor or a
  // malformed thread id (never sent to the uuid column).
  if (!threadsEnabled() || !actorId || !THREAD_ID_RE.test(String(threadId || ''))) return [];
  const thread = await db('ib_threads').where({ id: threadId, admin_actor_id: actorId }).first();
  if (!thread) return [];
  let query = db('ib_thread_turns')
    .where('thread_id', threadId)
    .where('role', 'user')
    .where('live_turn', true)
    .where('created_at', '>=', db.raw("NOW() - (? || ' minutes')::interval", [maxAgeMinutes]));
  if (Number.isInteger(maxSeq)) query = query.where('seq', '<=', maxSeq);
  // Continuation turns are excluded before the limit, so they never crowd
  // out the operator's real turns; any turn that still strips to nothing is
  // dropped after.
  const rows = await query.whereNot('content', 'like', `${CONTINUATION_TURN}%`)
    .orderBy('seq', 'desc').limit(limit).select('content');
  return rows.map((r) => operatorText(r.content)).filter(Boolean);
}

/** Recent threads for the picker (no turns). */
/**
 * Did an earlier exchange on this thread read admin screen data? Answered from
 * the server's own turns (the marker the route appended), for the life of the
 * thread. Returns false for a thread of this actor with no such turn; throws
 * when the thread cannot be read (not found for this actor, or a database
 * error) so the caller can fail closed.
 */
async function hasUntrustedRead(actorId, threadId) {
  const thread = await db('ib_threads').where({ id: threadId, admin_actor_id: actorId }).first('id');
  if (!thread) throw new Error('thread not readable');
  const marked = await db('ib_thread_turns').where('thread_id', threadId).andWhere('content', 'like', `%${UNTRUSTED_READ_MARKER}%`).first('id');
  return Boolean(marked);
}

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
  idleHours,
  isThreadIdle,
  appendExchange,
  latestThread,
  getThread,
  listThreads,
  recentOperatorTurns,
  IMAGE_TAINT_MARKER,
  PII_TAINT_MARKER,
  UNTRUSTED_READ_MARKER,
  hasUntrustedRead,
  CONTINUATION_TURN,
  purgeExpiredThreads,
  deriveTitle,
  RESUME_TURN_LIMIT,
};
