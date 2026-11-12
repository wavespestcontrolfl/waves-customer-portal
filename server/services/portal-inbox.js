/**
 * Portal inbox (GATE_PORTAL_INBOX, owner 2026-10-31, option A).
 *
 * What customers asked for inside the customer portal and nobody answered:
 *   1. portal chat hand-offs: ai_escalations rows still `pending` whose
 *      conversation is a `portal_chat` agent_sessions row;
 *   2. customer service requests that are not resolved / closed / cancelled and
 *      were not made by staff (source 'admin').
 * With GATE_PORTAL_BOOKING_ITEMS on, a third kind joins them (3): the open admin bells for a visitor who
 * started to book and left (portal-unfinished-bookings.js: dedupeKey `portal-unfinished-...`). They are bells,
 * not requests: a person marks one handled with the bell's own Done, and `closeOlder` marks them Done too.
 * With GATE_PORTAL_MESSAGES on, a fourth kind (4): a customer's own message in their portal thread
 * (portal-messages.js) that nobody answered: the thread's newest message is the customer's and is newer than
 * its handledAt stamp. An answer in the portal (a newer outbound row) or Mark handled closes it. The Waves AI's
 * after-hours answer (GATE_PORTAL_MESSAGES_NIGHT_AI, portal-messages-night-ai.js) is NOT an answer: it is an
 * outbound row that leaves the thread's last_message_at where it was, so the thread stays open for this scope
 * and every reader of it, and the item shows what the AI said (aiReply).
 * The Communications Portal tab lists the last 14 days (`items`). Open items at
 * or before the cutoff are listed one by one too (`olderItems`) and counted
 * (`older`); `closeOlder` still closes them and sends NOTHING to a customer.
 *
 * This module never sends an email, text or call. The route files pass in the
 * actor and call these helpers; the gate is read at call time.
 */

const db = require('../models/db');
const logger = require('./logger');
const { portalInboxLive } = require('../config/feature-gates');
const featureGates = require('../config/feature-gates');
const { requestProperty } = require('./service-request-property');

const WINDOW_DAYS = 14;
const LIST_CAP = 200;
const TEXT_CAP = 300;
const TERMINAL_REQUEST_STATUSES = ['resolved', 'closed', 'cancelled'];
// portalConversationId: a customer's portal message thread (portal-messages.js, GATE_PORTAL_MESSAGES).
const ALERT_KEYS = ['escalationId', 'requestId', 'portalConversationId'];
const CHAT_CLOSE_NOTE = 'Closed as older than 14 days from Communications → Portal. No customer message.';
const REQUEST_CLOSE_NOTE = 'Closed as older than 14 days (Portal tab). No email sent.';
const ALERT_CLOSE_RESOLUTION = 'Closed as older than 14 days (Portal tab)';
// The dedupeKey prefix of the unfinished-booking bells (portal-unfinished-bookings.js KEY_PREFIX). Repeated,
// not imported: that module reads the database at load. A test pins the two together.
const BOOKING_KEY_PREFIX = 'portal-unfinished-';

// GATE_PORTAL_BOOKING_ITEMS, read at call time. A test that mocks feature-gates without the reader reads off.
const bookingsLive = () => Boolean(featureGates.portalBookingItemsLive?.());
// GATE_PORTAL_MESSAGES, read at call time the same way.
const messagesLive = () => Boolean(featureGates.portalMessagesLive?.());

// An escalation's admin bell alert marked Done = somebody already dealt with
// it. Hide the chat then. No alert at all (before Oct 2) = keep it listed.
const CHAT_NOT_DONE_SQL = `NOT (
  EXISTS (
    SELECT 1 FROM notifications n
    WHERE n.recipient_type = 'admin' AND n.metadata->>'escalationId' = e.id::text
  ) AND NOT EXISTS (
    SELECT 1 FROM notifications n
    WHERE n.recipient_type = 'admin' AND n.metadata->>'escalationId' = e.id::text AND n.done_at IS NULL
  )
)`;

function windowCutoff(now = new Date()) {
  return new Date(now.getTime() - WINDOW_DAYS * 24 * 60 * 60 * 1000);
}

function cut(text, max = TEXT_CAP) {
  const s = String(text || '').trim();
  return s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s;
}

// The two definitions of an open customer ask, as scopes over a builder on
// `ai_escalations as e` / `service_requests as r`. openChats / openRequests
// below and other readers (the lead staleness sweep, services/lead-staleness.js)
// all go through these two, so "open" is defined once.
function openChatScope(builder) {
  return builder
    .join('agent_sessions as s', 's.id', 'e.conversation_id')
    .where('s.channel', 'portal_chat')
    .where('e.status', 'pending')
    .whereRaw(CHAT_NOT_DONE_SQL);
}

function openRequestScope(builder) {
  return builder
    .whereRaw("coalesce(r.status, 'new') not in (?, ?, ?)", TERMINAL_REQUEST_STATUSES)
    .whereRaw("coalesce(r.source, '') <> 'admin'");
}

function openChats(conn = db) {
  return openChatScope(conn('ai_escalations as e'));
}

function openRequests(conn = db) {
  return openRequestScope(conn('service_requests as r'));
}

// Open unfinished-booking bells (portal-unfinished-bookings.js), as a scope over a
// builder on `notifications as n`: admin rows not done whose key carries the
// prefix. openBookings below and the lead staleness sweep both go through it.
function openBookingScope(builder) {
  return builder
    .where('n.recipient_type', 'admin')
    .whereNull('n.done_at')
    .whereRaw("left(COALESCE(n.metadata->>'dedupeKey', ''), ?) = ?", [BOOKING_KEY_PREFIX.length, BOOKING_KEY_PREFIX]);
}

function openBookings(conn = db) {
  return openBookingScope(conn('notifications as n'));
}

// A customer's portal thread waiting on the office, as a scope over a builder on `conversations as cv`: the
// newest message is the customer's (appendMessage keeps last_inbound_at = last_message_at for it), and it is
// newer than the thread's Mark handled stamp. openMessages below and the lead staleness sweep go through it.
// The Waves AI's answer does not move last_message_at (portal-messages-night-ai.js saveReply puts it back), so it
// is not "the newest message" here: only a staff answer, a newer customer message or Mark handled changes this.
function openMessageScope(builder) {
  return builder
    .where('cv.channel', 'portal')
    .where('cv.our_endpoint_id', 'portal')
    .whereNotNull('cv.customer_id')
    .whereNotNull('cv.last_inbound_at')
    .whereRaw('cv.last_inbound_at >= cv.last_message_at')
    .whereRaw("cv.last_inbound_at > coalesce((cv.metadata->>'handledAt')::timestamptz, '-infinity'::timestamptz)");
}

function openMessages(conn = db) {
  return openMessageScope(conn('conversations as cv'));
}

// Runs fn(trx, open) on the portal thread's locked conversations row, with whether the thread waits on the
// office right now. Every change to a thread's admin bells goes through here (Mark handled, an answer's close,
// a customer message's ring), and saving a message writes the same row, so a bell change and a newer message
// cannot cross: a bell closes only when nothing is left open, and rings only while the thread is open.
async function onLockedThread(threadId, fn) {
  return db.transaction(async (trx) => {
    await trx('conversations').where({ id: threadId }).forUpdate().first('id');
    const open = Boolean(await openMessages(trx).where('cv.id', threadId).first('cv.id'));
    return fn(trx, open);
  });
}

async function countOf(query) {
  const row = await query.clone().count({ n: '*' }).first();
  return Number(row?.n || 0);
}

async function summary(cutoff = windowCutoff()) {
  const [chats, requests, bookings, messages] = await Promise.all([
    countOf(openChats().where('e.created_at', '>', cutoff)),
    countOf(openRequests().where('r.created_at', '>', cutoff)),
    bookingsLive() ? countOf(openBookings().where('n.created_at', '>', cutoff)) : 0,
    messagesLive() ? countOf(openMessages().where('cv.last_inbound_at', '>', cutoff)) : 0,
  ]);
  return { count: chats + requests + bookings + messages };
}

// The assistant's reply right after the customer's hand-off message: the first
// assistant message at or after the customer's own message (found by its text),
// else at or after one minute before the escalation was filed.
const REPLY_SQL = `(
  SELECT m2.content FROM agent_messages m2
  WHERE m2.conversation_id = e.conversation_id
    AND m2.role = 'assistant'
    AND coalesce(m2.content, '') <> ''
    AND m2.created_at >= coalesce(
      (SELECT max(m1.created_at) FROM agent_messages m1
        WHERE m1.conversation_id = e.conversation_id AND m1.role = 'user'
          AND m1.content = e.customer_message AND m1.created_at <= e.created_at),
      e.created_at - interval '1 minute')
  ORDER BY m2.created_at ASC LIMIT 1
)`;

// hasTexts: the customer has an SMS thread, so Reply by text can open it;
// otherwise the tab opens a new text to `phone` (the Customer 360 SMS panel rule).
const HAS_TEXTS_SQL = '(c.id IS NOT NULL AND EXISTS (SELECT 1 FROM sms_log sl WHERE sl.customer_id = c.id)) AS has_texts';

function customerOf(row) {
  return {
    id: row.customer_id || null,
    firstName: row.first_name || '',
    lastName: row.last_name || '',
    phone: row.phone || '',
    hasTexts: row.has_texts === true,
  };
}

function chatItem(row) {
  return {
    kind: 'chat',
    id: row.id,
    createdAt: row.created_at,
    customer: customerOf(row),
    customerMessage: String(row.customer_message || ''),
    summary: row.summary || '',
    reason: row.reason || '',
    assistantReply: cut(row.assistant_reply),
  };
}

function requestItem(row) {
  const property = requestProperty(row.metadata);
  return {
    kind: 'request',
    id: row.id,
    createdAt: row.created_at,
    customer: customerOf(row),
    category: row.category || '',
    subject: row.subject || '',
    description: cut(row.description),
    requestedService: row.requested_service || '',
    source: row.source || '',
    urgency: row.urgency || '',
    status: row.status || '',
    ...(property ? { property } : {}),
  };
}

// A booking item: the bell, with its customer (or the contact the bell carries for a visitor with none).
// `version` is the bell's content version, which the bell's Done route requires.
function bookingItem(row) {
  const meta = row.metadata && typeof row.metadata === 'object' ? row.metadata : {};
  const named = String(meta.contactName || '').trim();
  const customer = row.customer_id
    ? customerOf(row)
    : { id: null, firstName: named, lastName: '', phone: String(meta.contactPhone || '').trim(), hasTexts: false };
  return {
    kind: 'booking',
    id: row.id,
    createdAt: row.created_at,
    version: row.version,
    customer,
    service: String(meta.service || ''),
    ...(meta.checkoutEstimateId ? { estimateId: String(meta.checkoutEstimateId) } : {}),
  };
}

// A customer's unanswered portal message: the words since the office's last answer (and since Mark handled),
// and that last answer for context. The Waves AI's answers are not the office's: they are left out of both.
// AI_TYPE_SQL repeats portal-messages.js AI_MESSAGE_TYPE (a test pins the two together).
const AI_TYPE_SQL = `'portal_ai_reply'`;
const UNANSWERED_SQL = `(
  SELECT string_agg(m.body, E'\\n' ORDER BY m.created_at) FROM messages m
  WHERE m.conversation_id = cv.id AND m.direction = 'inbound'
    AND m.created_at > coalesce((SELECT max(o.created_at) FROM messages o
      WHERE o.conversation_id = cv.id AND o.direction = 'outbound' AND o.message_type IS DISTINCT FROM ${AI_TYPE_SQL}), '-infinity'::timestamptz)
    AND m.created_at > coalesce((cv.metadata->>'handledAt')::timestamptz, '-infinity'::timestamptz)
)`;
const LAST_ANSWER_SQL = `(
  SELECT o.body FROM messages o WHERE o.conversation_id = cv.id AND o.direction = 'outbound' AND o.message_type IS DISTINCT FROM ${AI_TYPE_SQL}
  ORDER BY o.created_at DESC LIMIT 1
)`;
// "The current open stretch", defined once: a Waves AI reply (alias `ai`, on conversation alias `conv`) belongs to
// it when the customer message it answers (metadata.answersMessageId) is newer than the office's last answer (an
// outbound row that is not the AI's) AND newer than Mark handled (handledAt is the time of the newest customer
// message the office handled through). The test is on the answered message, not on the reply's own time: a reply
// is always newer than the handledAt stamp of the message it answers, so a reply-time bound would never let go of
// a hand-off after Mark handled. Used by the item's aiReply below and by the one-hand-off check in
// portal-messages-night-ai.js saveReply.
const aiReplyInStretch = (conv, ai) => `EXISTS (
  SELECT 1 FROM messages q WHERE q.id::text = ${ai}.metadata->>'answersMessageId'
    AND q.created_at > coalesce((SELECT max(o.created_at) FROM messages o
      WHERE o.conversation_id = ${conv}.id AND o.direction = 'outbound' AND o.message_type IS DISTINCT FROM ${AI_TYPE_SQL}), '-infinity'::timestamptz)
    AND q.created_at > coalesce((${conv}.metadata->>'handledAt')::timestamptz, '-infinity'::timestamptz)
)`;
// The Waves AI's newest reply in the current open stretch: { handOff, body }, or null.
const AI_REPLY_SQL = `(
  SELECT json_build_object('handOff', coalesce(a.metadata->>'handOff', '') = 'true', 'body', a.body) FROM messages a
  WHERE a.conversation_id = cv.id AND a.message_type = ${AI_TYPE_SQL} AND ${aiReplyInStretch('cv', 'a')}
  ORDER BY a.created_at DESC LIMIT 1
)`;

// The newest customer message of the thread: what Mark handled covers when the office presses it.
const THROUGH_SQL = `(
  SELECT m.id FROM messages m WHERE m.conversation_id = cv.id AND m.direction = 'inbound'
  ORDER BY m.created_at DESC, m.id DESC LIMIT 1
)`;

function messageItem(row) {
  return {
    kind: 'message',
    id: row.id,
    throughId: row.through_id,
    createdAt: row.created_at,
    customer: customerOf(row),
    customerMessage: cut(row.unanswered),
    lastAnswer: cut(row.last_answer),
    // The Waves AI answered or handed off in this thread's open stretch: { handOff, body }, absent otherwise.
    ...(row.ai_reply ? { aiReply: { handOff: row.ai_reply.handOff === true, body: cut(row.ai_reply.body) } } : {}),
  };
}

async function listMessages(cutoff, op) {
  const rows = await openMessages()
    .leftJoin('customers as c', 'c.id', 'cv.customer_id')
    .where('cv.last_inbound_at', op, cutoff)
    .orderBy('cv.last_inbound_at', 'desc')
    .limit(LIST_CAP)
    .select('cv.id', 'cv.last_inbound_at as created_at', 'cv.customer_id', 'c.first_name', 'c.last_name', 'c.phone',
      db.raw(HAS_TEXTS_SQL), db.raw(`${UNANSWERED_SQL} AS unanswered`), db.raw(`${LAST_ANSWER_SQL} AS last_answer`),
      db.raw(`${AI_REPLY_SQL} AS ai_reply`), db.raw(`${THROUGH_SQL} AS through_id`));
  return rows.map(messageItem);
}

// The bell's content version (notification-service NOTIFICATION_VERSION_SQL), read on the `n` alias: the
// customers join also has a metadata column. Same values, same md5, so the Done route accepts it.
function bookingVersionSql() {
  return require('./notification-service')._private.NOTIFICATION_VERSION_SQL.replace(/\b(title|body|link|detail|metadata)\b/g, 'n.$1');
}

async function listBookings(cutoff, op) {
  const rows = await openBookings()
    .joinRaw("LEFT JOIN customers c ON c.id::text = n.metadata->>'customerId'")
    .where('n.created_at', op, cutoff)
    .orderBy('n.created_at', 'desc')
    .limit(LIST_CAP)
    .select('n.id', 'n.created_at', 'n.metadata', db.raw(`${bookingVersionSql()} AS version`),
      'c.id as customer_id', 'c.first_name', 'c.last_name', 'c.phone', db.raw(HAS_TEXTS_SQL));
  return rows.map(bookingItem);
}

// Open items on one side of the cutoff, newest first, at most LIST_CAP of each
// kind: `recent` is strictly after it, otherwise at or before it.
async function listOpen(cutoff, recent) {
  const op = recent ? '>' : '<=';
  const chatRows = await openChats()
    .leftJoin('customers as c', 'c.id', 'e.customer_id')
    .where('e.created_at', op, cutoff)
    .orderBy('e.created_at', 'desc')
    .limit(LIST_CAP)
    .select('e.id', 'e.created_at', 'e.customer_id', 'e.customer_message', 'e.summary', 'e.reason',
      'c.first_name', 'c.last_name', 'c.phone', db.raw(HAS_TEXTS_SQL), db.raw(`${REPLY_SQL} AS assistant_reply`));
  const requestRows = await openRequests()
    .leftJoin('customers as c', 'c.id', 'r.customer_id')
    .where('r.created_at', op, cutoff)
    .orderBy('r.created_at', 'desc')
    .limit(LIST_CAP)
    .select('r.id', 'r.created_at', 'r.customer_id', 'r.category', 'r.subject', 'r.description',
      'r.requested_service', 'r.source', 'r.urgency', 'r.status', 'r.metadata', 'c.first_name', 'c.last_name', 'c.phone', db.raw(HAS_TEXTS_SQL));
  const bookingItems = bookingsLive() ? await listBookings(cutoff, op) : [];
  const messageItems = messagesLive() ? await listMessages(cutoff, op) : [];
  return [...chatRows.map(chatItem), ...requestRows.map(requestItem), ...bookingItems, ...messageItems]
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

// `total` is every open item in the window; `items` holds at most LIST_CAP of
// each kind, so the tab shows "N of total" and reloads when it runs out.
// `olderItems` lists the open items at or before the cutoff the same way, and
// `older` holds their true totals.
async function list(now = new Date()) {
  const cutoff = windowCutoff(now);
  const withBookings = bookingsLive();
  const withMessages = messagesLive();
  const [items, olderItems, recent, chats, requests, bookings, messages] = await Promise.all([
    listOpen(cutoff, true),
    listOpen(cutoff, false),
    summary(cutoff),
    countOf(openChats().where('e.created_at', '<=', cutoff)),
    countOf(openRequests().where('r.created_at', '<=', cutoff)),
    withBookings ? countOf(openBookings().where('n.created_at', '<=', cutoff)) : 0,
    withMessages ? countOf(openMessages().where('cv.last_inbound_at', '<=', cutoff)) : 0,
  ]);
  return {
    cutoff: cutoff.toISOString(), items, olderItems, total: recent.count,
    older: { chats, requests, ...(withBookings ? { bookings } : {}), ...(withMessages ? { messages } : {}) },
  };
}

// Close the open admin bell alerts raised for these ids. `key` is the metadata
// field the alert carries: 'escalationId' (chat hand-off), 'requestId' or 'portalConversationId'.
async function closeAlerts(key, ids, { by, role, technicianId = null, resolution }, conn = db) {
  if (!ALERT_KEYS.includes(key)) throw new Error(`unknown alert key ${key}`);
  const list = [...new Set([].concat(ids ?? []).filter(Boolean).map(String))];
  if (!list.length || !by) return 0;
  const alertIds = await conn('notifications')
    .where({ recipient_type: 'admin' })
    .whereNull('done_at')
    .whereIn(conn.raw(`metadata->>'${key}'`), list)
    .pluck('id');
  if (!alertIds.length) return 0;
  const NotificationService = require('./notification-service');
  return NotificationService.markAdminDone(alertIds, { by, resolution, role, technicianId }, conn);
}

// Mark-handled hook for the two existing update routes. Gate off: nothing.
// Never throws: closing a bell must not fail the staff action.
async function closeAlertsWhenHandled(key, id, actor) {
  if (!portalInboxLive()) return 0;
  try {
    return await closeAlerts(key, [id], {
      by: String(actor.technicianId),
      role: actor.role,
      technicianId: actor.technicianId,
      resolution: 'Handled in Communications → Portal',
    });
  } catch (err) {
    logger.warn(`[portal-inbox] could not close alerts for ${key} ${id}: ${err.message}`);
    return 0;
  }
}

// PATCH /api/admin/requests/:id hook: only the writer that won the move to
// 'resolved' closes the request's alerts.
async function closeRequestAlertsOnResolve(request, statusChanged, actor) {
  if (!statusChanged || request.status !== 'resolved') return 0;
  return closeAlertsWhenHandled('requestId', request.id, actor);
}

// A request whose admin bell was settled by the alert-relevance sweep (a person
// answered the customer, or an estimate went out) is resolved to match, quietly: the same write as
// closeRequestsOlder for one row, and NO customer email. Only a request still open, and only the
// customer's own. `note` goes on the request as an admin note. Returns the number of rows resolved.
// `notAfter` is the closing bell's ask time: a request touched after it (the shared CTA writer refreshes the
// same request id with a new offer snapshot and bumps updated_at, and rings another bell) is a newer
// revision the old answer does not cover, so the same UPDATE refuses it. No usable boundary, no write.
async function resolveRequestQuietly(requestId, customerId, note, { notAfter = null, conn = db, now = new Date() } = {}) {
  if (!requestId || !customerId) return 0;
  const boundary = notAfter ? new Date(notAfter) : null;
  if (!boundary || Number.isNaN(boundary.getTime())) return 0;
  const cleaned = cut(note, 200);
  const rows = await conn('service_requests')
    .where({ id: requestId, customer_id: customerId })
    // Only a row nobody has moved since it was filed: a staff status change
    // (acknowledged, scheduled) is a newer revision the sweep must not
    // overwrite, and a terminal row is already done.
    .whereRaw("coalesce(status, 'new') = 'new'")
    .where('updated_at', '<=', boundary)
    .update({
      status: 'resolved',
      resolved_at: now,
      status_version: conn.raw('status_version + 1'),
      admin_notes: conn.raw(
        "CASE WHEN coalesce(admin_notes, '') = '' THEN ?::text ELSE admin_notes || E'\\n' || ?::text END",
        [cleaned, cleaned],
      ),
      updated_at: now,
    })
    .returning('id');
  return rows.length;
}

function parseCloseCutoff(raw, now = new Date()) {
  const when = new Date(raw);
  if (!raw || Number.isNaN(when.getTime())) return { error: 'cutoff must be an ISO date' };
  if (when.getTime() > windowCutoff(now).getTime()) return { error: 'cutoff must be at least 14 days ago' };
  return { cutoff: when };
}

async function closeChatsOlder(trx, cutoff, now) {
  const ids = await openChats(trx).where('e.created_at', '<=', cutoff).pluck('e.id');
  if (!ids.length) return [];
  return trx('ai_escalations')
    .whereIn('id', ids)
    .where({ status: 'pending' })
    .update({ status: 'dismissed', resolution_notes: CHAT_CLOSE_NOTE, updated_at: now })
    .returning('id')
    .then((rows) => rows.map((r) => r.id || r));
}

async function closeRequestsOlder(trx, cutoff, now) {
  const rows = await openRequests(trx)
    .where('r.created_at', '<=', cutoff)
    .update({
      status: 'resolved',
      resolved_at: now,
      status_version: trx.raw('status_version + 1'),
      admin_notes: trx.raw(
        "CASE WHEN coalesce(admin_notes, '') = '' THEN ?::text ELSE admin_notes || E'\\n' || ?::text END",
        [REQUEST_CLOSE_NOTE, REQUEST_CLOSE_NOTE],
      ),
      updated_at: now,
    })
    .returning('id');
  return rows.map((r) => r.id || r);
}

// The open unfinished-booking bells at or before the cutoff, marked Done (the bell's own writer, so a bell a
// person closed meanwhile is not touched again). Returns the number closed.
async function closeBookingsOlder(trx, cutoff, alertActor) {
  const ids = await openBookings(trx).where('n.created_at', '<=', cutoff).pluck('n.id');
  if (!ids.length) return 0;
  return require('./notification-service').markAdminDone(ids, alertActor, trx);
}

// The open portal-message threads at or before the cutoff, stamped handled through their own newest customer
// message (the row's last_inbound_at), so a message saved after it opens the thread again. Returns their ids.
async function closeMessagesOlder(trx, cutoff, now) {
  const rows = await openMessages(trx).where('cv.last_inbound_at', '<=', cutoff)
    .update({ metadata: trx.raw("coalesce(metadata, '{}'::jsonb) || jsonb_build_object('handledAt', last_inbound_at)"), updated_at: now })
    .returning('id');
  return rows.map((r) => r.id || r);
}

// Mark handled on a portal message item (GATE_PORTAL_MESSAGES), through the newest customer message the office
// saw (`throughId`, the item's throughId): a message saved after it keeps the item open. On the locked thread
// row the stamp only moves forward, and the thread's bells close only when nothing is left open, in the same
// transaction. Sends nothing. Returns { handled, open }, or null when throughId is not a customer message of
// this thread.
async function markMessageHandled(threadId, throughId, actor) {
  return onLockedThread(threadId, async (trx, wasOpen) => {
    const seen = await trx('messages').where({ id: throughId, conversation_id: threadId, channel: 'portal', direction: 'inbound' }).first('created_at');
    if (!seen) return null;
    if (!wasOpen) return { handled: false, open: false };
    const rows = await openMessages(trx).where('cv.id', threadId)
      .whereRaw("coalesce((cv.metadata->>'handledAt')::timestamptz, '-infinity'::timestamptz) < ?", [seen.created_at])
      .update({
        metadata: trx.raw("coalesce(metadata, '{}'::jsonb) || jsonb_build_object('handledAt', ?::text)", [new Date(seen.created_at).toISOString()]),
        updated_at: new Date(),
      })
      .returning('id');
    const open = Boolean(await openMessages(trx).where('cv.id', threadId).first('cv.id'));
    if (!open) {
      await closeAlerts('portalConversationId', [threadId], {
        by: String(actor.technicianId || 'admin'),
        role: actor.role,
        technicianId: actor.technicianId || null,
        resolution: 'Handled in Communications → Portal',
      }, trx);
    }
    return { handled: rows.length > 0, open };
  });
}

// Close every open item at or before `cutoff` in ONE transaction. Sends no
// email or text: it writes rows and marks the matching admin alerts Done.
async function closeOlder(cutoff, actor, now = new Date()) {
  return db.transaction(async (trx) => {
    const chatIds = await closeChatsOlder(trx, cutoff, now);
    const requestIds = await closeRequestsOlder(trx, cutoff, now);
    const alertActor = { by: String(actor.technicianId), role: actor.role, technicianId: actor.technicianId, resolution: ALERT_CLOSE_RESOLUTION };
    await closeAlerts('escalationId', chatIds, alertActor, trx);
    await closeAlerts('requestId', requestIds, alertActor, trx);
    const withBookings = bookingsLive();
    const bookingsClosed = withBookings ? await closeBookingsOlder(trx, cutoff, alertActor) : 0;
    const withMessages = messagesLive();
    const messageIds = withMessages ? await closeMessagesOlder(trx, cutoff, now) : [];
    await closeAlerts('portalConversationId', messageIds, alertActor, trx);
    await require('./audit-log').recordAuditEvent({
      actor_type: 'technician',
      actor_id: actor.technicianId || null,
      action: 'portal_inbox.close_older',
      resource_type: 'portal_inbox',
      metadata: { cutoff: cutoff.toISOString(), chats: chatIds.length, requests: requestIds.length, ...(withBookings ? { bookings: bookingsClosed } : {}), ...(withMessages ? { messages: messageIds.length } : {}) },
      critical: true,
      trx,
    });
    return { chats: chatIds.length, requests: requestIds.length, ...(withBookings ? { bookings: bookingsClosed } : {}), ...(withMessages ? { messages: messageIds.length } : {}) };
  });
}

module.exports = {
  WINDOW_DAYS,
  openChatScope,
  openRequestScope,
  openBookingScope,
  openMessageScope,
  aiReplyInStretch,
  onLockedThread,
  markMessageHandled,
  windowCutoff,
  summary,
  list,
  closeOlder,
  closeAlerts,
  closeAlertsWhenHandled,
  closeRequestAlertsOnResolve,
  resolveRequestQuietly,
  parseCloseCutoff,
};
