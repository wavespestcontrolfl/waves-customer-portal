/**
 * Messenger inbox (GATE_MESSENGER_INBOX, owner 2026-10-31).
 *
 * Facebook Messenger for the Waves Pest Control page, inside Admin >
 * Communications. The page has no webhook subscription, so intake is a poll:
 * every 3 minutes `pollMessenger` reads new messages from the Graph API into
 * the unified `conversations` / `messages` store (channel `facebook_messenger`,
 * the shapes Phase 1 already wrote: thread `messenger:<psid>` on endpoint
 * `messenger:<page id>`, label = the person's Facebook name).
 *
 * - One admin bell per thread with a new customer message (dedupeKey
 *   `messenger-thread:<conversation id>`), closed when a reply appears, from
 *   the portal or seen in Facebook.
 * - `sendReply` answers through Facebook's Send API, only inside Meta's
 *   24-hour window from the customer's last message.
 *
 * Nothing here texts, emails or calls anyone. A reply to a Facebook message is
 * a staff action in the tab. No Graph response, token or message body is ever
 * logged.
 */

const crypto = require('crypto');
const db = require('../models/db');
const logger = require('./logger');
const { messengerInboxLive } = require('../config/feature-gates');
const { findOrCreateThread, appendMessage } = require('./conversations');

const CHANNEL = 'facebook_messenger';
const GRAPH = 'https://graph.facebook.com/v25.0';
const CURSOR_KEY = 'messenger_inbox_cursor';
// Set once a first import has finished with nothing failed and no cap hit. Until then every
// poll reads back the full first-run window and keeps the first-run read and ring policy.
const BOOTSTRAP_KEY = 'messenger_inbox_bootstrap_done';
const FIRST_RUN_DAYS = 183;
const REPLY_WINDOW_MS = 24 * 60 * 60 * 1000;
// A conversation's messages are read back to the cursor less this overlap; the
// store dedupes, so the overlap only costs a few already-stored rows.
const MESSAGE_OVERLAP_MS = 6 * 60 * 60 * 1000;
const CONVERSATION_PAGE = 25;
const MESSAGE_PAGE = 100;
const MAX_CONVERSATION_PAGES = 40;
const MAX_MESSAGE_PAGES = 30;
const FETCH_TIMEOUT_MS = 20000;
const REPLY_MAX_CHARS = 2000;
const SNIPPET_CHARS = 140;
const BELL_RESOLUTION = 'Answered in Messenger';
const BELL_ACTOR = 'messenger-inbox';
const LIST_LIMIT = 100;
const THREAD_MESSAGE_LIMIT = 500;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const bellKey = (conversationId) => `messenger-thread:${conversationId}`;

// messages.twilio_sid is varchar(64) and a Graph message id is about 90 chars:
// the dedupe key is 'fb:' + the first 48 hex of sha256(mid). The Graph id
// itself rides in metadata.graph_mid.
function messageKey(mid) {
  return `fb:${crypto.createHash('sha256').update(String(mid)).digest('hex').slice(0, 48)}`;
}

function pageConfig() {
  const token = process.env.FACEBOOK_ACCESS_TOKEN;
  const pageId = process.env.FACEBOOK_PAGE_ID;
  return token && pageId ? { token, pageId: String(pageId) } : null;
}

// One Graph call. The token travels as access_token (the repo's convention) and
// is never part of an error: a failure carries Facebook's numeric code only.
async function graph(urlOrPath, { token, params = {}, method = 'GET', body } = {}) {
  const isUrl = /^https:\/\//.test(urlOrPath);
  // A paging link is followed only on Facebook's own host: it carries the token.
  if (isUrl && !urlOrPath.startsWith('https://graph.facebook.com/')) throw new Error('Facebook paging link refused');
  const url = new URL(isUrl ? urlOrPath : `${GRAPH}/${urlOrPath}`);
  if (!isUrl) for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  if (!url.searchParams.has('access_token')) url.searchParams.set('access_token', token);
  const res = await fetch(url.toString(), {
    method,
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw Object.assign(new Error(`Facebook Graph request failed (HTTP ${res.status}, code ${json?.error?.code ?? 'none'})`), {
      status: res.status, fbCode: json?.error?.code ?? null,
    });
  }
  return json;
}

// A failure for the logs: Facebook's status and code, or the error's name and database code.
// Never the error text: a database error can quote the row it refused, and a row holds message text.
function safeError(err) {
  if (err?.status) return `Facebook HTTP ${err.status}, code ${err.fbCode ?? 'none'}`;
  return [err?.name || 'Error', err?.code].filter(Boolean).join(' ');
}

// ── cursor ────────────────────────────────────────────────────

async function readCursor() {
  const row = await db('system_settings').where({ key: CURSOR_KEY }).first('value');
  const at = row?.value ? new Date(row.value) : null;
  return at && !Number.isNaN(at.getTime()) ? at : null;
}

async function writeSetting(key, value) {
  await db('system_settings').insert({ key, value, category: 'messenger' })
    .onConflict('key').merge({ value, updated_at: db.fn.now() });
}

const writeCursor = (at) => writeSetting(CURSOR_KEY, at.toISOString());

async function bootstrapDone() {
  const row = await db('system_settings').where({ key: BOOTSTRAP_KEY }).first('value');
  return Boolean(row?.value);
}

// ── reading from Facebook ─────────────────────────────────────

// Conversations changed at or after `since`, oldest first. The boundary is
// inclusive: a conversation that shares the cursor's time is read again, and the
// message dedupe keys make that replay write nothing twice. `complete` is false
// when the page cap stopped the walk with more (older) conversations left.
async function listChangedConversations({ token, pageId }, since, maxPages) {
  const changed = [];
  let next = `${GRAPH}/${pageId}/conversations?${new URLSearchParams({
    platform: 'messenger', fields: 'updated_time,unread_count,message_count,participants', limit: String(CONVERSATION_PAGE),
  })}`;
  for (let page = 0; next && page < maxPages; page += 1) {
    const json = await graph(next, { token });
    for (const conv of json.data || []) {
      const updated = new Date(conv.updated_time);
      if (Number.isNaN(updated.getTime())) continue;
      if (updated < since) return { changed: changed.reverse(), complete: true };
      changed.push({ ...conv, updatedAt: updated });
    }
    next = json.paging?.next || null;
  }
  return { changed: changed.reverse(), complete: !next };
}

function bodyOf(msg) {
  const text = typeof msg.message === 'string' ? msg.message.trim() : '';
  if (text) return text;
  const files = msg.attachments?.data || [];
  if (files.length && files.every((f) => String(f.mime_type || '').startsWith('image/'))) return '[Photo]';
  return '[Attachment]';
}

// A conversation's messages from `from` on, oldest first. Throws when the page
// cap stops the walk with older messages still unread: a partial read must not
// count as done.
async function readMessages({ token }, conversationId, from, maxPages) {
  const all = [];
  let next = `${GRAPH}/${conversationId}/messages?${new URLSearchParams({
    fields: 'id,message,from,created_time,attachments', limit: String(MESSAGE_PAGE),
  })}`;
  for (let page = 0; next && page < maxPages; page += 1) {
    const json = await graph(next, { token });
    let reachedOlder = false;
    for (const msg of json.data || []) {
      const createdAt = new Date(msg.created_time);
      if (!msg.id || Number.isNaN(createdAt.getTime())) continue;
      if (createdAt < from) { reachedOlder = true; continue; }
      all.push({ ...msg, createdAt });
    }
    if (reachedOlder) return all.sort((a, b) => a.createdAt - b.createdAt);
    next = json.paging?.next || null;
  }
  if (next) throw new Error(`Messenger conversation has more than ${maxPages} pages of messages`);
  return all.sort((a, b) => a.createdAt - b.createdAt);
}

// The customer in a conversation: the participant that is not the page, else
// the sender of an inbound message.
function contactOf(conv, messages, pageId) {
  const person = (conv.participants?.data || []).find((p) => p?.id && String(p.id) !== pageId);
  if (person) return { psid: String(person.id), name: person.name || null };
  const inbound = messages.find((m) => m.from?.id && String(m.from.id) !== pageId);
  return inbound ? { psid: String(inbound.from.id), name: inbound.from.name || null } : null;
}

// ── thread + bell ─────────────────────────────────────────────

async function findThread(psid, pageId) {
  return db('conversations')
    .where({ contact_external_id: `messenger:${psid}`, channel: CHANNEL, our_endpoint_id: `messenger:${pageId}` })
    .orderByRaw('customer_id IS NULL')
    .first();
}

async function closeBell(conversationId) {
  const rows = await db('notifications')
    .where({ recipient_type: 'admin' })
    .whereRaw("metadata->>'dedupeKey' = ?", [bellKey(conversationId)])
    .whereNull('done_at')
    .select('id');
  if (!rows.length) return 0;
  const NotificationService = require('./notification-service');
  return NotificationService.markAdminDone(rows.map((r) => r.id), { by: BELL_ACTOR, resolution: BELL_RESOLUTION });
}

// "<Area> — reply to <name> on Facebook", the words behind it in the why.
async function ringBell(thread, latestInbound) {
  const { raiseAdminAlert, breaksAlertRules } = require('./admin-alert-compose');
  const { fitAction, redactedWords, whyWithQuote } = require('./admin-alert-names');
  const name = thread.contact_label || 'a Facebook contact';
  const words = redactedWords(latestInbound.body);
  const quoted = whyWithQuote({ lead: 'Facebook: ', quote: words });
  const why = words && !/^\[/.test(words) && !breaksAlertRules(quoted) ? quoted : 'New Facebook message; open the thread to read it.';
  await raiseAdminAlert('alert', {
    area: 'Comms',
    action: fitAction('Comms', name, [(n) => `reply to ${n} on Facebook`, (n) => `reply to ${n}`]),
    why,
    severity: 'needs-you',
    link: `/admin/communications#tab=messenger&thread=${thread.id}`,
    // The customer the thread is linked to; an unlinked Facebook contact has no customer and
    // compose has no thread subject type, so the thread id stands in (nothing reads a customer
    // subject off a messenger-thread bell).
    subject: { type: 'customer', id: String(thread.customer_id || thread.id) },
    doneWhen: 'customer_answered',
    who: 'person',
  }, {
    bell: true,
    dedupeKey: bellKey(thread.id),
    // A new message is a new version: the standing row is rewritten, reopened and rung again.
    dedupeVersion: latestInbound.key,
    refreshOnDedupe: true,
    bumpOnRefresh: true,
    detail: words ? words.slice(0, 1000) : undefined,
    metadata: { conversationId: thread.id },
  });
}

// ── the poll ──────────────────────────────────────────────────

async function ensureThread(contact, pageId) {
  const thread = await findThread(contact.psid, pageId);
  if (!thread) {
    return findOrCreateThread({
      channel: CHANNEL, ourEndpointId: `messenger:${pageId}`, contactExternalId: `messenger:${contact.psid}`, contactLabel: contact.name,
    });
  }
  if (!thread.contact_label && contact.name) {
    await db('conversations').where({ id: thread.id }).update({ contact_label: contact.name });
    return { ...thread, contact_label: contact.name };
  }
  return thread;
}

// The bell follows the PERSISTED thread, so a run that stored the messages but
// failed before the bell is finished by the next run, and a replay changes nothing:
// the latest customer message not yet read and newer than any reply rings (the
// same message is the same dedupe version, so it never rings twice); a reply newer
// than the latest customer message closes it (closing is idempotent). A first-run
// import is stored read unless Facebook showed the conversation unread, so only
// those ring.
async function reconcileBell(thread) {
  const latestIn = await db('messages').where({ conversation_id: thread.id, direction: 'inbound' })
    .orderBy('created_at', 'desc').first('body', 'twilio_sid', 'created_at', 'is_read');
  const latestOut = await db('messages').where({ conversation_id: thread.id, direction: 'outbound' })
    .max({ at: 'created_at' }).first();
  const answered = latestOut?.at && (!latestIn || new Date(latestOut.at) >= new Date(latestIn.created_at));
  if (answered) return closeBell(thread.id);
  if (latestIn && latestIn.is_read !== true) return ringBell(thread, { body: latestIn.body, key: latestIn.twilio_sid });
  return null;
}

// One conversation: read it, store what is new, then settle its bell.
async function importConversation(config, conv, { since, firstRun, limits }) {
  const { pageId } = config;
  const messages = await readMessages(config, conv.id, new Date(since.getTime() - MESSAGE_OVERLAP_MS), limits.messagePages);
  if (!messages.length) return { inserted: 0 };
  const contact = contactOf(conv, messages, pageId);
  if (!contact) return { inserted: 0, skipped: 'no_contact' };

  const keys = messages.map((m) => messageKey(m.id));
  const known = new Set((await db('messages').where({ channel: CHANNEL }).whereIn('twilio_sid', keys).select('twilio_sid')).map((r) => r.twilio_sid));
  const fresh = messages.filter((m, i) => !known.has(keys[i]));
  const thread = fresh.length ? await ensureThread(contact, pageId) : await findThread(contact.psid, pageId);
  if (!thread) return { inserted: 0 };

  // First run: what Facebook already shows as read stays read here.
  const importRead = firstRun && !(Number(conv.unread_count) > 0);
  for (const msg of fresh) {
    const outbound = String(msg.from?.id) === pageId;
    await appendMessage({
      conversationId: thread.id,
      channel: CHANNEL,
      direction: outbound ? 'outbound' : 'inbound',
      authorType: outbound ? 'admin' : 'customer',
      body: bodyOf(msg),
      twilioSid: messageKey(msg.id),
      createdAt: msg.createdAt,
      isRead: outbound || importRead,
      metadata: { graph_mid: msg.id, source: 'facebook' },
    });
  }
  await reconcileBell(thread);
  return { inserted: fresh.length };
}

// Cursor, bootstrap flag and failure signal after a poll. A capped list or a failed conversation
// is an error for job health; the bootstrap flag is set only by a first run that finished clean.
async function settlePoll({ complete, failed, firstRun, advanced, empty, now, pageLimit }) {
  if (complete && advanced) await writeCursor(advanced);
  else if (complete && firstRun && empty && !failed) await writeCursor(now);
  if (!complete) {
    logger.warn(`[messenger-inbox] conversation list stopped at ${pageLimit} page(s) with more left; the cursor stays`);
    throw new Error('Messenger poll stopped at its page cap with conversations left; the cursor stays');
  }
  if (failed) throw new Error(`Messenger poll left ${failed} conversation(s) unread; the cursor stays before them`);
  if (firstRun) await writeSetting(BOOTSTRAP_KEY, now.toISOString());
}

/**
 * One poll. The cursor moves only through update-time groups in which every
 * conversation succeeded, so a failed conversation (or one sharing its time) is
 * read again next run; the boundary is inclusive and replays are deduped by key.
 * A page or message cap that stops the walk early leaves the cursor where it was.
 */
async function pollMessenger({ now = new Date(), limits: override } = {}) {
  if (!messengerInboxLive()) return { skipped: 'gate_off' };
  const config = pageConfig();
  if (!config) return { skipped: 'not_configured' };
  const limits = { conversationPages: MAX_CONVERSATION_PAGES, messagePages: MAX_MESSAGE_PAGES, ...override };

  // Until the first import has finished clean, the cursor is only progress: every poll reads back
  // the whole first-run window under the first-run policy (stored messages dedupe).
  const firstRun = !(await bootstrapDone());
  const cursor = firstRun ? null : await readCursor();
  const since = cursor || new Date(now.getTime() - FIRST_RUN_DAYS * 24 * 60 * 60 * 1000);
  const { changed, complete } = await listChangedConversations(config, since, limits.conversationPages);

  let inserted = 0;
  let failed = 0;
  let advanced = null;
  for (let i = 0; i < changed.length; i += 1) {
    const conv = changed[i];
    try {
      inserted += (await importConversation(config, conv, { since, firstRun, limits })).inserted;
    } catch (err) {
      failed += 1;
      logger.warn(`[messenger-inbox] conversation not imported: ${safeError(err)}`);
    }
    const groupEnds = !changed[i + 1] || changed[i + 1].updatedAt.getTime() !== conv.updatedAt.getTime();
    if (groupEnds && !failed) advanced = conv.updatedAt;
  }
  await settlePoll({ complete, failed, firstRun, advanced, empty: !changed.length, now, pageLimit: limits.conversationPages });
  if (inserted) logger.info(`[messenger-inbox] stored ${inserted} new message(s) from ${changed.length} changed conversation(s)`);
  return { conversations: changed.length, inserted, firstRun };
}

// ── reading for the tab ───────────────────────────────────────

// A technician sees only threads linked to a customer on their route (the SMS
// rule); an unlinked Facebook contact belongs to the office.
function scopeTo(query, req) {
  const { isTechnicianRequest, technicianCustomerIdsSubquery } = require('./technician-visit-scope');
  return isTechnicianRequest(req) ? query.whereIn('c.customer_id', technicianCustomerIdsSubquery(req, db)) : query;
}

function threadsQuery(req) {
  return scopeTo(db('conversations as c').where('c.channel', CHANNEL), req).joinRaw(`LEFT JOIN LATERAL (
    SELECT MAX(created_at) FILTER (WHERE direction = 'inbound') AS last_in,
           MAX(created_at) FILTER (WHERE direction = 'outbound') AS last_out,
           COUNT(*) FILTER (WHERE direction = 'inbound' AND is_read IS NOT TRUE)::int AS unread,
           (SELECT body FROM messages lm WHERE lm.conversation_id = c.id ORDER BY lm.created_at DESC LIMIT 1) AS snippet
      FROM messages m WHERE m.conversation_id = c.id
  ) s ON true`);
}

const iso = (value) => (value ? new Date(value).toISOString() : null);
const isAnswered = (row) => !row.last_in || (row.last_out && new Date(row.last_out) >= new Date(row.last_in));
const canReplyNow = (row, now = new Date()) => Boolean(
  row.last_in && String(row.contact_external_id || '').startsWith('messenger:')
  && now - new Date(row.last_in) < REPLY_WINDOW_MS,
);
const cutText = (text, max) => {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s;
};

function threadRow(row, now) {
  return {
    id: row.id,
    name: row.contact_label || 'Facebook contact',
    lastMessageAt: iso(row.last_in && row.last_out ? (new Date(row.last_in) > new Date(row.last_out) ? row.last_in : row.last_out) : (row.last_in || row.last_out)),
    lastInboundAt: iso(row.last_in),
    snippet: cutText(row.snippet, SNIPPET_CHARS),
    unread: Number(row.unread) || 0,
    answered: Boolean(isAnswered(row)),
    canReply: canReplyNow(row, now),
  };
}

const THREAD_COLUMNS = ['c.id', 'c.contact_label', 'c.contact_external_id', 's.last_in', 's.last_out', 's.unread', 's.snippet'];

// Threads waiting for an answer: the latest customer message is newer than any reply.
// One definition for the tab count, whatever page of the list is on screen.
const UNANSWERED_SQL = 's.last_in IS NOT NULL AND (s.last_out IS NULL OR s.last_in > s.last_out)';
const SORT_KEY_SQL = "date_trunc('milliseconds', GREATEST(s.last_in, s.last_out))";

async function countUnanswered(req) {
  const row = await threadsQuery(req).whereRaw(UNANSWERED_SQL).count({ n: '*' }).first();
  return Number(row?.n || 0);
}

async function summary(req) {
  return { unanswered: await countUnanswered(req) };
}

/**
 * One page of threads, newest activity first. `before` (ISO of the last row's
 * lastMessageAt) plus `beforeId` (its id) is the keyset for the next page.
 * `unanswered` is the total across all threads, not the page.
 */
async function listThreads(req, now = new Date(), { limit = LIST_LIMIT, before = null, beforeId = null } = {}) {
  let query = threadsQuery(req).select(...THREAD_COLUMNS).whereRaw('GREATEST(s.last_in, s.last_out) IS NOT NULL');
  if (before) {
    query = beforeId
      ? query.whereRaw(`(${SORT_KEY_SQL} < ?::timestamptz OR (${SORT_KEY_SQL} = ?::timestamptz AND c.id < ?))`, [before, before, beforeId])
      : query.whereRaw(`${SORT_KEY_SQL} < ?::timestamptz`, [before]);
  }
  const rows = await query.orderByRaw(`${SORT_KEY_SQL} DESC, c.id DESC`).limit(limit + 1);
  return {
    threads: rows.slice(0, limit).map((r) => threadRow(r, now)),
    hasMore: rows.length > limit,
    unanswered: await countUnanswered(req),
  };
}

async function loadThread(req, id) {
  if (!UUID_RE.test(String(id))) return null;
  return threadsQuery(req).where('c.id', id).select(...THREAD_COLUMNS).first();
}

async function getThread(req, id, now = new Date(), { limit = THREAD_MESSAGE_LIMIT } = {}) {
  const row = await loadThread(req, id);
  if (!row) return null;
  const messages = await db('messages as m')
    .leftJoin('technicians as t', 't.id', 'm.admin_user_id')
    .where('m.conversation_id', row.id)
    .orderBy('m.created_at', 'desc')
    .limit(limit + 1)
    .select('m.id', 'm.direction', 'm.body', 'm.created_at', 'm.author_type', 't.name as staff_name');
  // The newest `limit` messages, oldest first for display.
  const hasOlder = messages.length > limit;
  return {
    thread: threadRow(row, now),
    hasOlder,
    messages: messages.slice(0, limit).reverse().map((m) => ({
      id: m.id,
      direction: m.direction,
      body: m.body || '',
      createdAt: iso(m.created_at),
      author: m.direction === 'inbound'
        ? { type: 'customer', name: row.contact_label || null }
        : { type: 'staff', name: m.staff_name || null },
    })),
  };
}

async function markThreadRead(req, id, technicianId) {
  const row = await loadThread(req, id);
  if (!row) return null;
  const updated = await db('messages')
    .where({ conversation_id: row.id, direction: 'inbound' })
    .where((q) => q.where('is_read', false).orWhereNull('is_read'))
    .update({ is_read: true, read_at: new Date(), read_by_admin_user_id: technicianId || null });
  return { updated };
}

// ── replying ──────────────────────────────────────────────────

/**
 * Send one reply through Facebook's Send API.
 * @returns {Promise<{ok: true, message: object|null}|{ok: false, status: number, error: string}>}
 * Nothing is written when Facebook refuses the reply.
 */
async function sendReply(req, id, text, { now = new Date() } = {}) {
  const row = await loadThread(req, id);
  if (!row) return { ok: false, status: 404, error: 'not_found' };
  if (!canReplyNow(row, now)) return { ok: false, status: 409, error: 'outside_window' };
  const config = pageConfig();
  if (!config) return { ok: false, status: 502, error: 'send_failed' };

  let sent;
  try {
    sent = await graph(`${config.pageId}/messages`, {
      token: config.token,
      method: 'POST',
      body: {
        recipient: { id: String(row.contact_external_id).slice('messenger:'.length) },
        messaging_type: 'RESPONSE',
        message: { text },
      },
    });
  } catch (err) {
    logger.warn(`[messenger-inbox] reply not sent: ${safeError(err)}`);
    // No HTTP answer (a timeout or a dropped connection): Facebook may have delivered it, so the
    // staff member must check before sending again. An HTTP error is a refusal: nothing went out.
    if (!err?.status) return { ok: false, status: 504, error: 'send_uncertain' };
    return { ok: false, status: 502, error: 'send_failed' };
  }
  const mid = sent?.message_id;
  // A 200 without a message id: Facebook took the request but did not confirm a message.
  if (!mid) return { ok: false, status: 504, error: 'send_uncertain' };

  const actorId = req.technicianId || null;
  let message = null;
  try {
    message = await appendMessage({
      conversationId: row.id,
      channel: CHANNEL,
      direction: 'outbound',
      authorType: 'admin',
      adminUserId: actorId,
      body: text,
      twilioSid: messageKey(mid),
      createdAt: now,
      isRead: true,
      metadata: { graph_mid: mid, source: 'portal' },
    });
    // The poll may have stored this message first, as seen in Facebook: it becomes the portal's.
    if (message && !message.admin_user_id && actorId) {
      await db('messages').where({ id: message.id }).update({
        admin_user_id: actorId,
        metadata: db.raw("COALESCE(metadata, '{}'::jsonb) || ?::jsonb", [JSON.stringify({ source: 'portal' })]),
      });
    }
  } catch (err) {
    // Facebook has the reply; a resend would double it. The next poll stores it.
    logger.error(`[messenger-inbox] reply sent but not stored: ${safeError(err)}`);
  }
  try {
    await closeBell(row.id);
  } catch (err) {
    logger.warn(`[messenger-inbox] bell not closed after reply: ${safeError(err)}`);
  }
  return { ok: true, message: message ? { id: message.id, createdAt: iso(message.created_at) } : null };
}

module.exports = {
  CHANNEL,
  REPLY_MAX_CHARS,
  bellKey,
  messageKey,
  pollMessenger,
  summary,
  listThreads,
  getThread,
  markThreadRead,
  sendReply,
};
