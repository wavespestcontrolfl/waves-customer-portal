/**
 * Portal messages (GATE_PORTAL_MESSAGES, owner 2026-11-04, "lets build it out" after "do we now have the
 * ability to answer clients in the portal?").
 *
 * The office answers a customer's portal ask inside the portal, and the customer can write back there.
 * One thread per customer row lives in the unified comms tables (services/conversations.js): a
 * `conversations` row with channel 'portal' and our_endpoint_id 'portal' (not null, so the partial unique
 * index conversations_customer_dedup keeps one per customer), and its `messages` rows: the office's answers
 * (outbound, author_type 'admin') and the customer's own words (inbound, author_type 'customer').
 *
 * - staffReply answers one open Portal-tab item (a chat hand-off, a customer service request, or the
 *   customer's own portal message). The customer is read from the item, never from the caller. One
 *   transaction saves the answer and closes the item it answers: a chat hand-off is resolved, a service
 *   request is resolved quietly (no "request updated" email), and a portal message is answered by the new
 *   row itself. After the commit the item's open admin bells close, and the customer gets ONE notice: the
 *   in-app bell plus a push to the Waves app, or an email with the whole answer when no app device took the
 *   push.
 * - customerPost saves a customer's own message, then raises one admin bell per thread (a later message
 *   rewrites it and rings it again) and the admin phone page (GATE_PORTAL_ASK_PUSH).
 * - The customer reads the thread in the portal; their unread count is the office's answers newer than the
 *   thread's customerReadThrough stamp.
 * - A thread is an open Portal-tab item while its newest message is the customer's and is newer than the
 *   thread's handledAt stamp (portal-inbox.js openMessageScope; Mark handled).
 *
 * Nothing here messages a customer on its own: the one send is the notice for an answer a staff member
 * pressed Send on. Every entry point refuses while the gate is off, and an answer to an inactive customer
 * row (who can neither sign in nor take a push) is refused: the office texts them instead.
 */

const db = require('../models/db');
const logger = require('./logger');
const featureGates = require('../config/feature-gates');
const Conversations = require('./conversations');

const CHANNEL = 'portal';
const ENDPOINT = 'portal';
const BODY_MAX = 2000;
const PAGE_SIZE = 50;
const PREVIEW_MAX = 140;
// One attempt at a time runs an answer's notice (claimNotice). A claim older than this belongs to a process
// that stopped, so a retry or the sweep may take it over. The sweep looks back one day.
const CLAIM_STALE_MS = 2 * 60 * 1000;
// A notice that failed for a passing reason is tried at most this many times, then left as it is.
const NOTICE_ATTEMPTS = 5;
const SWEEP_MIN_AGE_MS = 5 * 60 * 1000;
const SWEEP_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const SWEEP_LIMIT = 50;
const MESSAGES_LINK = '/?tab=messages';
const NOTICE_TITLE = 'New message from Waves';
const ANSWERED_NOTE = 'Answered in the portal';
const ITEM_KINDS = ['chat', 'request', 'message'];
const OPEN_CHAT_STATUSES = ['pending', 'claimed'];
const TERMINAL_REQUEST_STATUSES = ['resolved', 'closed', 'cancelled'];
// The admin bell metadata key that names each item kind (portal-inbox.js closeAlerts).
const ALERT_KEY = { chat: 'escalationId', request: 'requestId', message: 'portalConversationId' };

class PortalMessageError extends Error {
  constructor(code, status, message = code) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

// What a person typed, as stored: line endings made plain, control characters and angle brackets
// dropped (no surface may ever read it as markup), runs of blank lines cut to one, trimmed.
function cleanBody(value) {
  return String(value ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/[<>]/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function checkedBody(value) {
  const body = cleanBody(value);
  if (!body) throw new PortalMessageError('empty', 400, 'Write a message first.');
  if (body.length > BODY_MAX) throw new PortalMessageError('too_long', 400, `Keep it under ${BODY_MAX} characters.`);
  return body;
}

// Read at call time; a test that mocks feature-gates without the reader reads off.
const live = () => Boolean(featureGates.portalMessagesLive?.());

function requireLive() {
  if (!live()) throw new PortalMessageError('disabled', 404);
}

const metaOf = (row) => {
  const meta = row?.metadata;
  if (meta && typeof meta === 'object') return meta;
  try { return meta ? JSON.parse(meta) : {}; } catch { return {}; }
};

function preview(body) {
  const flat = String(body || '').replace(/\s+/g, ' ').trim();
  return flat.length > PREVIEW_MAX ? `${flat.slice(0, PREVIEW_MAX - 1).trimEnd()}…` : flat;
}

function findThread(customerId, conn = db) {
  return conn('conversations').where({ customer_id: customerId, channel: CHANNEL, our_endpoint_id: ENDPOINT }).first();
}

// The customer's thread, made on first use. The lock makes find-or-create safe for two first messages at once.
async function threadWith(trx, customerId) {
  await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?))', [`portal-thread:${customerId}`]);
  return Conversations.findOrCreateThreadWith(trx, { customerId, channel: CHANNEL, ourEndpointId: ENDPOINT });
}

// A retried send (same client request id, same side of the thread) returns the row the first try saved,
// under the thread lock.
function priorSend(trx, threadId, direction, clientRequestId) {
  if (!clientRequestId) return null;
  return trx('messages').where({ conversation_id: threadId, channel: CHANNEL, direction })
    .whereRaw("metadata->>'clientRequestId' = ?", [clientRequestId]).first();
}

function customerView(row) {
  return { id: row.id, from: row.direction === 'outbound' ? 'waves' : 'you', body: row.body || '', createdAt: row.created_at };
}

function staffView(row) {
  return { id: row.id, direction: row.direction, body: row.body || '', createdAt: row.created_at, adminUserId: row.admin_user_id || null };
}

// The row each item kind names: a chat must be a portal chat hand-off, a request must be the customer's own
// (not staff-made), and a message item is the portal thread itself.
const ITEM_ROW = {
  chat: (trx, id) => trx('ai_escalations as e').join('agent_sessions as s', 's.id', 'e.conversation_id')
    .where('e.id', id).where('s.channel', 'portal_chat').first('e.customer_id'),
  request: (trx, id) => trx('service_requests').where({ id }).whereRaw("coalesce(source, '') <> 'admin'").first('customer_id'),
  message: (trx, id) => trx('conversations').where({ id, channel: CHANNEL, our_endpoint_id: ENDPOINT }).first('customer_id'),
};

// The customer row an open item belongs to, or a 404.
async function itemCustomerWith(trx, kind, id) {
  const row = await ITEM_ROW[kind](trx, id);
  if (!row?.customer_id) throw new PortalMessageError('not_found', 404, 'This item is gone.');
  const customer = await trx('customers').where({ id: row.customer_id }).first('id', 'active', 'deleted_at');
  if (!customer || customer.deleted_at) throw new PortalMessageError('no_customer', 409, 'This customer record was removed.');
  // An inactive row cannot sign in to the portal or take a push (auth.js, push-notifications.js).
  if (customer.active !== true) throw new PortalMessageError('customer_inactive', 409, 'This customer cannot open the portal. Reply by text instead.');
  return customer.id;
}

// Closes the item the answer is for. Already closed is fine: the answer still stands. A portal message is
// answered by the new outbound row itself (openMessageScope), so there is nothing more to write.
async function closeItemWith(trx, kind, id, customerId) {
  if (kind === 'message') return true;
  const now = new Date();
  if (kind === 'chat') {
    const [esc] = await trx('ai_escalations').where({ id, customer_id: customerId }).whereIn('status', OPEN_CHAT_STATUSES)
      .update({ status: 'resolved', resolution_notes: ANSWERED_NOTE, updated_at: now }).returning(['id', 'conversation_id']);
    if (esc?.conversation_id) {
      await trx('agent_sessions').where({ id: esc.conversation_id }).update({ status: 'resolved', resolved_by: 'human', updated_at: now });
    }
    return Boolean(esc);
  }
  const rows = await trx('service_requests').where({ id, customer_id: customerId })
    .whereRaw("coalesce(status, 'new') not in (?, ?, ?)", TERMINAL_REQUEST_STATUSES)
    .update({
      status: 'resolved',
      resolved_at: now,
      status_version: trx.raw('status_version + 1'),
      admin_notes: trx.raw("CASE WHEN coalesce(admin_notes, '') = '' THEN ?::text ELSE admin_notes || E'\\n' || ?::text END", [ANSWERED_NOTE, ANSWERED_NOTE]),
      updated_at: now,
    })
    .returning('id');
  return rows.length > 0;
}

// The item's open admin bells close once the answer is saved. Never throws: the answer is the record.
async function closeItemBells(kind, id, actor) {
  try {
    const { closeAlerts } = require('./portal-inbox');
    // A message item's id is its thread's id, which is what that thread's bells carry.
    return await closeAlerts(ALERT_KEY[kind], [id], {
      by: String(actor.technicianId || 'admin'),
      role: actor.role || 'admin',
      technicianId: actor.technicianId || null,
      resolution: ANSWERED_NOTE,
    });
  } catch (err) {
    logger.warn(`[portal-messages] could not close the bells of ${kind} ${id}: ${err.message}`);
    return 0;
  }
}

// A try that reached the customer: an app push or the email went out.
const noticeReached = (notice) => Number(notice.pushAccepted) > 0 || notice.email === 'sent';

// What the staff screen is told about a notice: the outcome so far, and pending while tries remain.
function publicNotice(notice) {
  if (!notice) return null;
  const shown = {};
  for (const key of ['bell', 'pushAccepted', 'email']) if (notice[key] !== undefined) shown[key] = notice[key];
  return notice.pending ? { ...shown, pending: true } : shown;
}

async function storedNotice(messageId) {
  const row = await db('messages').where({ id: messageId }).first('metadata');
  return publicNotice(metaOf(row).notice);
}

// Writes a try's outcome, only while that try still holds the claim (a try that was taken over writes nothing).
function recordNotice(messageId, notice) {
  return db('messages').where({ id: messageId })
    .whereRaw("metadata->'notice'->>'claimedAt' = ?", [notice.claimedAt])
    .update({ metadata: db.raw("coalesce(metadata, '{}'::jsonb) || jsonb_build_object('notice', ?::jsonb)", [JSON.stringify(notice)]), updated_at: new Date() });
}

// The claim conditions, shared by claimNotice and the sweep so the sweep only picks notices it can claim.
function claimable(query, now) {
  return query
    .whereRaw("m.metadata->'notice'->>'pending' = 'true'")
    .whereRaw("coalesce((m.metadata->'notice'->>'attempts')::int, 0) < ?", [NOTICE_ATTEMPTS])
    .whereRaw("coalesce((m.metadata->'notice'->>'claimedAt')::timestamptz, '-infinity'::timestamptz) < ?::timestamptz",
      [new Date(now.getTime() - CLAIM_STALE_MS).toISOString()]);
}

// Claims the answer's notice for this try, or null. The one gate for every attempt (the first send, a retried
// click, the sweep): only a notice still pending, under NOTICE_ATTEMPTS tries, and not held by a fresh claim
// (CLAIM_STALE_MS: an older claim's process stopped, or a passing failure waits for its next try) can be taken.
// A final notice (reached, a skip, or out of tries) is never claimed again. The claim counts the try.
// Returns { at, attempts }.
async function claimNotice(messageId, now = new Date()) {
  const [row] = await claimable(db('messages as m').where('m.id', messageId), now)
    .update({
      metadata: db.raw(`coalesce(metadata, '{}'::jsonb) || jsonb_build_object('notice', coalesce(metadata->'notice', '{}'::jsonb)
        || jsonb_build_object('pending', true, 'claimedAt', ?::text, 'attempts', coalesce((metadata->'notice'->>'attempts')::int, 0) + 1))`, [now.toISOString()]),
      updated_at: now,
    })
    .returning('metadata');
  return row ? { at: now.toISOString(), attempts: Number(metaOf(row).notice?.attempts) || 1 } : null;
}

// The in-app bell plus a push to the Waves app. A push another attempt is still sending is not a miss.
async function bellAndPush(customerId, message) {
  try {
    const bell = await require('./notification-service').notifyCustomer(customerId, 'service', NOTICE_TITLE, preview(message.body), {
      link: MESSAGES_LINK,
      dedupeKey: `portal-reply:${message.id}`,
      awaitPush: true,
      pushOptions: { nativeOnly: true },
      metadata: { portalMessageId: message.id },
    });
    return { bell: Boolean(bell?.id) && !bell.suppressed, pushAccepted: Number(bell?.push?.accepted || 0), inFlight: bell?.push?.reason === 'push_in_flight' };
  } catch (err) {
    logger.warn(`[portal-messages] bell or push failed for message ${message.id}: ${err.message}`);
    return { bell: false, pushAccepted: 0, inFlight: false };
  }
}

// The reply email: 'sent', or why it did not go and whether a later try can help. A skip (no address, opted
// out, the address changed) or a provider block is final; anything else (the preferences read failed, a
// provider error, a send already in flight) is worth another try with the same idempotency key, which the
// email library resends only when the earlier row failed or never went out.
async function replyEmail(customerId, message) {
  try {
    const result = await require('./account-membership-email').sendPortalReply({ customerId, messageId: message.id, body: message.body });
    if (result?.ok) return { email: 'sent', retry: false };
    return { email: result?.reason || 'not_sent', retry: !(result?.skipped || result?.blocked) };
  } catch (err) {
    logger.warn(`[portal-messages] reply email failed for message ${message.id}: ${err.message}`);
    return { email: 'failed', retry: true };
  }
}

// The one notice for a saved answer, one try at a time (claimNotice): the customer's in-app bell plus a push
// to the Waves app (app devices only: a browser subscription is not the app); an email with the whole answer
// when no app device took the push. The try's outcome is final when the customer was reached or can't be (an
// email skip or block), or when it was the last try; a passing failure (no bell, or an email worth another try)
// stays pending for a retried click or the sweep. A push another try is still sending leaves this try's claim
// in place (it counted) and adds no email. The stored notice keeps its try count. Never throws. Safe to run
// again: the bell dedupes on its key, an accepted push is claimed by its bell (push-notifications.js), and the
// email carries its own idempotency key.
async function noticeCustomer(customerId, message) {
  try {
    const claim = await claimNotice(message.id);
    if (!claim) return await storedNotice(message.id);
    const { inFlight, ...sent } = await bellAndPush(customerId, message);
    if (inFlight) {
      // Another try is still sending the push: no email. Its claim stays (this try counted); on the last try the
      // notice ends here, since whatever that push does is the outcome.
      if (claim.attempts >= NOTICE_ATTEMPTS) await recordNotice(message.id, { ...sent, email: 'not_needed', pending: false, claimedAt: claim.at, attempts: claim.attempts });
      return { pending: claim.attempts < NOTICE_ATTEMPTS };
    }
    const mail = sent.pushAccepted > 0 ? { email: 'not_needed', retry: false } : await replyEmail(customerId, message);
    const outcome = { ...sent, email: mail.email };
    const pending = !noticeReached(outcome) && (mail.retry || !outcome.bell) && claim.attempts < NOTICE_ATTEMPTS;
    const notice = { ...outcome, pending, claimedAt: claim.at, attempts: claim.attempts };
    await recordNotice(message.id, notice);
    return publicNotice(notice);
  } catch (err) {
    logger.warn(`[portal-messages] notice failed for message ${message.id}: ${err.message}`);
    return { pending: true };
  }
}

// Every 10 minutes (scheduler.js): finish the notices still pending (a stopped process, or a passing failure
// waiting for its next try), for answers 5 minutes to one day old. It only completes a send a staff member
// pressed. Gate off: nothing. Returns how many it picked up (a fresh claim is left to its holder).
async function resumePendingNotices(now = new Date()) {
  if (!live()) return 0;
  const rows = await claimable(db('messages as m'), now).join('conversations as cv', 'cv.id', 'm.conversation_id')
    .where({ 'm.channel': CHANNEL, 'm.direction': 'outbound', 'cv.channel': CHANNEL })
    .where('m.created_at', '<=', new Date(now.getTime() - SWEEP_MIN_AGE_MS))
    .where('m.created_at', '>', new Date(now.getTime() - SWEEP_MAX_AGE_MS))
    .orderBy('m.created_at', 'asc')
    .limit(SWEEP_LIMIT)
    .select('m.id', 'm.body', 'cv.customer_id');
  for (const row of rows) await noticeCustomer(row.customer_id, row);
  if (rows.length) logger.info(`[portal-messages] finished ${rows.length} pending answer notice(s)`);
  return rows.length;
}

/**
 * The office answers an open Portal-tab item inside the portal.
 * @param {{ kind: 'chat'|'request'|'message', id: string, body: string, clientRequestId?: string,
 *   actor: { technicianId: string|null, role: string } }} input
 * @returns {Promise<{ message: object, closed: boolean, notice: object|null, replay?: boolean }>}
 */
async function staffReply({ kind, id, body, clientRequestId = null, actor = {} }) {
  requireLive();
  if (!ITEM_KINDS.includes(kind)) throw new PortalMessageError('bad_kind', 400);
  const text = checkedBody(body);
  const saved = await db.transaction(async (trx) => {
    const customerId = await itemCustomerWith(trx, kind, id);
    const thread = await threadWith(trx, customerId);
    const prior = await priorSend(trx, thread.id, 'outbound', clientRequestId);
    if (prior) return { replay: true, message: prior, customerId };
    const message = await Conversations.appendMessage({
      conn: trx,
      conversationId: thread.id,
      channel: CHANNEL,
      direction: 'outbound',
      authorType: 'admin',
      adminUserId: actor.technicianId || null,
      body: text,
      deliveryStatus: 'sent',
      messageType: 'portal_reply',
      // pending until noticeCustomer records how the customer was told (a stopped process leaves it for the sweep)
      metadata: { portalItem: { kind, id }, notice: { pending: true }, ...(clientRequestId ? { clientRequestId } : {}) },
    });
    const closed = await closeItemWith(trx, kind, id, customerId);
    return { message, closed, customerId };
  });
  if (saved.replay) {
    const { notice } = metaOf(saved.message);
    // A retried click tries a notice that is still pending (claimNotice decides); a final one is only shown.
    return {
      message: staffView(saved.message),
      closed: false,
      notice: notice?.pending ? await noticeCustomer(saved.customerId, saved.message) : publicNotice(notice),
      replay: true,
    };
  }
  await closeItemBells(kind, id, actor);
  const notice = await noticeCustomer(saved.customerId, saved.message);
  return { message: staffView(saved.message), closed: saved.closed, notice };
}

// One admin bell per thread: a later message rewrites the standing bell and rings it again. Then the phone
// page, only when the bell really rang. Never throws: the message is the record.
async function ringOffice(customer, threadId, message) {
  try {
    const { raiseAdminAlert, breaksAlertRules } = require('./admin-alert-compose');
    const { fitAction, redactedWords, whyWithQuote } = require('./admin-alert-names');
    const name = [customer.first_name, customer.last_name].filter(Boolean).join(' ').trim() || 'A customer';
    // The customer's words, redacted and cut like every bell body; a quote the headline rules refuse (a second
    // sentence, a date) falls back to a plain why. The whole message is in the bell's full text either way.
    const quoted = whyWithQuote({ lead: 'They wrote in the portal: ', quote: redactedWords(message.body) });
    const result = await raiseAdminAlert('alert', {
      area: 'Comms',
      action: fitAction('Comms', name, [(who) => `Answer ${who}'s portal message`, (who) => `Answer ${who}`]),
      why: breaksAlertRules(quoted) ? 'They wrote in the portal and are waiting for an answer' : quoted,
      severity: 'needs-you',
      link: '/admin/communications#tab=portal',
      subject: { type: 'customer', id: String(customer.id) },
      doneWhen: 'customer_answered',
      who: 'person',
    }, {
      bell: true,
      dedupeKey: `portal-message:${threadId}`,
      dedupeOpenOnly: true,
      refreshOnDedupe: true,
      bumpOnRefresh: true,
      detail: message.body,
      metadata: { customerId: customer.id, portalConversationId: threadId, portalMessageId: message.id },
    });
    const rang = Boolean(result?.id) && !result.suppressed && (!result.deduped || (result.refreshed === true && result.rung !== false));
    if (rang) {
      const { pushPortalAsk, shortName } = require('./portal-ask-push');
      void pushPortalAsk({
        itemKey: `portal-message:${threadId}`,
        title: 'Answer a portal message',
        body: `${shortName(customer.first_name, customer.last_name)} wrote in the portal`,
        link: '/admin/communications#tab=portal',
        customerId: customer.id,
      });
    }
  } catch (err) {
    logger.error(`[portal-messages] bell failed for thread ${threadId}: ${err.message}`);
  }
}

/**
 * A signed-in customer writes in their portal thread.
 * @param {{ customer: { id: string, first_name?: string, last_name?: string }, body: string, clientRequestId?: string }} input
 */
async function customerPost({ customer, body, clientRequestId = null }) {
  requireLive();
  const text = checkedBody(body);
  const saved = await db.transaction(async (trx) => {
    const thread = await threadWith(trx, customer.id);
    const prior = await priorSend(trx, thread.id, 'inbound', clientRequestId);
    if (prior) return { replay: true, message: prior };
    const message = await Conversations.appendMessage({
      conn: trx,
      conversationId: thread.id,
      channel: CHANNEL,
      direction: 'inbound',
      authorType: 'customer',
      body: text,
      deliveryStatus: 'received',
      messageType: 'portal_message',
      metadata: clientRequestId ? { clientRequestId } : {},
    });
    return { message, threadId: thread.id };
  });
  if (!saved.replay) await ringOffice(customer, saved.threadId, saved.message);
  return customerView(saved.message);
}

async function unreadFor(thread) {
  if (!thread) return 0;
  const through = metaOf(thread).customerReadThrough;
  const query = db('messages').where({ conversation_id: thread.id, channel: CHANNEL, direction: 'outbound' });
  if (through) query.where('created_at', '>', through);
  const row = await query.count({ n: '*' }).first();
  return Number(row?.n || 0);
}

// The customer's thread, newest PAGE_SIZE first in time order; `before` (an ISO time) pages back.
async function customerThread(customerId, { before = null } = {}) {
  requireLive();
  const thread = await findThread(customerId);
  if (!thread) return { messages: [], hasMore: false, unread: 0 };
  const query = db('messages').where({ conversation_id: thread.id, channel: CHANNEL }).whereIn('direction', ['inbound', 'outbound']);
  if (before) query.where('created_at', '<', before);
  const rows = await query.orderBy([{ column: 'created_at', order: 'desc' }, { column: 'id', order: 'desc' }])
    .limit(PAGE_SIZE + 1).select('id', 'direction', 'body', 'created_at');
  return {
    messages: rows.slice(0, PAGE_SIZE).reverse().map(customerView),
    hasMore: rows.length > PAGE_SIZE,
    unread: await unreadFor(thread),
  };
}

async function customerUnread(customerId) {
  requireLive();
  return unreadFor(await findThread(customerId));
}

// The customer has seen the thread up to `throughId` (the newest message the page showed). The stamp only
// moves forward, and the in-app bells of the answers it covers are marked read too.
async function markRead(customerId, throughId) {
  requireLive();
  const thread = await findThread(customerId);
  if (!thread || !throughId) return { unread: await unreadFor(thread) };
  const seen = await db('messages').where({ id: throughId, conversation_id: thread.id }).first('created_at');
  if (!seen) throw new PortalMessageError('not_found', 404);
  const through = new Date(seen.created_at).toISOString();
  await db('conversations').where({ id: thread.id })
    .whereRaw("coalesce((metadata->>'customerReadThrough')::timestamptz, '-infinity'::timestamptz) < ?::timestamptz", [through])
    .update({ metadata: db.raw("coalesce(metadata, '{}'::jsonb) || jsonb_build_object('customerReadThrough', ?::text)", [through]) });
  const answered = db('messages').where({ conversation_id: thread.id, direction: 'outbound' })
    .where('created_at', '<=', through).select(db.raw('id::text'));
  await db('notifications').where({ recipient_type: 'customer', recipient_id: customerId }).whereNull('read_at')
    .whereIn(db.raw("metadata->>'portalMessageId'"), answered).update({ read_at: new Date() });
  return { unread: await unreadFor(await findThread(customerId)) };
}

module.exports = {
  CHANNEL,
  ENDPOINT,
  BODY_MAX,
  MESSAGES_LINK,
  NOTICE_TITLE,
  PortalMessageError,
  cleanBody,
  staffReply,
  customerPost,
  customerThread,
  customerUnread,
  markRead,
  resumePendingNotices,
  __private: { preview, noticeCustomer, closeItemWith, itemCustomerWith, claimNotice },
};
