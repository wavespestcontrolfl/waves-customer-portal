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
 *   push. With GATE_PORTAL_ANSWER_TEXT on (owner 2026-11-22, "ok do your rec"): the in-app bell plus one text
 *   that carries the answer, or the email when no text can go, and no push.
 * - customerPost saves a customer's own message, then raises one admin bell per thread (a later message
 *   rewrites it and rings it again) and the admin phone page.
 * - The customer reads the thread in the portal; their unread count is the office's answers newer than the
 *   thread's customerReadThrough stamp.
 * - A thread is an open Portal-tab item while its newest message is the customer's and is newer than the
 *   thread's handledAt stamp (portal-inbox.js openMessageScope; Mark handled).
 *
 * With GATE_PORTAL_MESSAGES_NIGHT_AI on, a customer message written outside 8 AM to 8 PM Eastern is also answered
 * by the Ask Waves assistant in the same thread (portal-messages-night-ai.js): an outbound row of author_type
 * 'agent', message_type AI_MESSAGE_TYPE, labelled Waves AI. It is not an answer by the office: the thread stays
 * an open Portal-tab item until a staff answer or Mark handled.
 *
 * A customer message may carry up to PHOTO_MAX photos (owner 2026-11-20, "photos can go in chat"), sent as
 * multipart files. Each is checked and re-encoded by the prep-photo sanitizer (visit-prep.js
 * prepareUploadFile), stored in the private photo bucket under the customer's own folder, and named on the
 * row's `media` as { type: 'photo', key, contentType, size }. The key never leaves the server: a thread page
 * carries a signed view link per photo. A message with a photo may have no words. The Waves AI never answers
 * a message with a photo: it stays the office's open item.
 *
 * Nothing here messages a customer on its own: the one send is the notice for an answer a staff member
 * pressed Send on (the AI's answer gets the in-app bell and an app push only, never the email or a text; with
 * GATE_PORTAL_ANSWER_TEXT on, the bell alone). Every entry point refuses while the gate is off, and an answer to an inactive customer
 * row (who can neither sign in nor take a push) is refused: the office texts them instead.
 */

const db = require('../models/db');
const logger = require('./logger');
const featureGates = require('../config/feature-gates');
const Conversations = require('./conversations');
const PhotoService = require('./photos');
const { parseStoredMedia } = require('./sms-media');

const CHANNEL = 'portal';
const ENDPOINT = 'portal';
const BODY_MAX = 2000;
const PAGE_SIZE = 50;
const PHOTO_MAX = 3;
// The sanitizer's own ceiling (visit-prep.js VISIT_PREP_LIMITS.maxPhotoBytes); the route stops reading a file here.
const PHOTO_MAX_BYTES = 5 * 1024 * 1024;
// The office reads a thread page and moves on; the customer's page stays open (photos.js on the dwell time).
const STAFF_PHOTO_TTL_SECONDS = 60 * 60;
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
// GATE_PORTAL_ANSWER_TEXT: the answer's text goes only on the staff press, the office's own send (send-window.js
// OPERATOR_ENTRY_POINTS admin_portal_answer: a night answer goes at once, owner 2026-11-05). The notice sweep never
// starts a text: a notice it finishes goes by email, so no automatic step texts a customer, at night or by day.
// The cost bound on the owner's page: a text is at most 3 segments. A longer answer sends its first part and the link.
const TEXT_MAX_SEGMENTS = 3;
// The after-hours AI answer's row (portal-messages-night-ai.js). portal-inbox.js repeats the message type in its
// SQL (a test pins the two together).
const AI_MESSAGE_TYPE = 'portal_ai_reply';
const AI_AGENT_NAME = 'Waves AI';
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

function checkedBody(value, { withPhotos = false } = {}) {
  const body = cleanBody(value);
  if (!body && !withPhotos) throw new PortalMessageError('empty', 400, 'Write a message first.');
  if (body.length > BODY_MAX) throw new PortalMessageError('too_long', 400, `Keep it under ${BODY_MAX} characters.`);
  return body;
}

// Read at call time; a test that mocks feature-gates without the reader reads off.
const live = () => Boolean(featureGates.portalMessagesLive?.());
const answerTextLive = () => Boolean(featureGates.portalAnswerTextLive?.());

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

const isAiReply = (row) => row.message_type === AI_MESSAGE_TYPE;

const photosOn = (row) => parseStoredMedia(row?.media).filter((item) => item && item.type === 'photo' && item.key);

// Checks and stores a message's photos before its row is saved: all of them, or none (what was stored is
// removed again). The sanitizer's own refusals are customer-safe words and keep their status.
async function storePhotos(customerId, files) {
  if (files.length > PHOTO_MAX) throw new PortalMessageError('too_many_photos', 400, `Attach no more than ${PHOTO_MAX} photos.`);
  if (!files.length) return [];
  // Loaded on first use: the sanitizer brings the image libraries and the request routes with it.
  const { prepareUploadFile } = require('./visit-prep');
  const { uploadFunnelPhotoToS3 } = require('../utils/funnel-photos');
  const stored = [];
  try {
    for (const file of files) {
      const photo = await prepareUploadFile(file);
      const key = await uploadFunnelPhotoToS3({
        rowId: `portal-messages/${customerId}`,
        keyPrefix: 'photo',
        index: stored.length,
        mimeType: photo.mimeType,
        base64: photo.buffer.toString('base64'),
      });
      if (!key) throw new PortalMessageError('photo_storage', 503, 'Your photos could not be saved. Please try again shortly.');
      stored.push({ type: 'photo', key, contentType: photo.mimeType, size: photo.buffer.length });
    }
  } catch (err) {
    await dropPhotos(stored);
    if (err.visitPrep) throw new PortalMessageError('invalid_photo', err.statusCode, err.message);
    throw err;
  }
  return stored;
}

const dropPhotos = (media) => Promise.all(media.map((item) => require('./visit-prep').deleteUploadedObject(item.key)));

// A message as a page shows it: the view, plus a signed link per photo. A link that cannot be signed is left
// out, and the words still show.
async function shown(row, view, ttlSeconds) {
  const links = await Promise.all(photosOn(row).map((item) => PhotoService.getViewUrl(item.key, ttlSeconds).catch(() => null)));
  const photos = links.filter(Boolean).map((url) => ({ url }));
  return photos.length ? { ...view(row), photos } : view(row);
}

// `ai: true` marks the Waves AI's answer (the bubble is labelled Waves AI); a staff answer carries no flag.
function customerView(row) {
  return {
    id: row.id, from: row.direction === 'outbound' ? 'waves' : 'you', body: row.body || '', createdAt: row.created_at,
    ...(isAiReply(row) ? { ai: true } : {}),
  };
}

function staffView(row) {
  return {
    id: row.id, direction: row.direction, body: row.body || '', createdAt: row.created_at, adminUserId: row.admin_user_id || null,
    ...(isAiReply(row) ? { ai: true, ...(row.hand_off === 'true' ? { handOff: true } : {}) } : {}),
  };
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
    // The chat writer (assistant.js upsertOpenItem) locks the session row before the hand-off row. Same order
    // here, so a customer adding to the hand-off while staff answers waits instead of deadlocking.
    const open = await trx('ai_escalations').where({ id, customer_id: customerId }).first('conversation_id');
    if (open?.conversation_id) await trx('agent_sessions').where({ id: open.conversation_id }).forUpdate().first('id');
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
async function closeItemBells(kind, id, actor, threadId) {
  try {
    const { closeAlerts, onLockedThread } = require('./portal-inbox');
    const by = { by: String(actor.technicianId || 'admin'), role: actor.role || 'admin', technicianId: actor.technicianId || null, resolution: ANSWERED_NOTE };
    // Any answer lands in the thread, so it covers the thread's open message too: the thread's bells close on its
    // locked row, and only when the answer left nothing open (a newer customer message keeps its bell).
    const threadBells = await onLockedThread(threadId, (trx, open) => (open ? 0 : closeAlerts(ALERT_KEY.message, [threadId], by, trx)));
    // A message item's id is its thread's id; a chat or a request has bells of its own.
    return kind === 'message' ? threadBells : threadBells + await closeAlerts(ALERT_KEY[kind], [id], by);
  } catch (err) {
    logger.warn(`[portal-messages] could not close the bells of ${kind} ${id}: ${err.message}`);
    return 0;
  }
}

// A text the provider took, or one whose outcome is unknown (it may have gone out): either one rules out a second
// text and the email.
const textReached = (text) => text === 'sent' || text === 'uncertain';

// A try that reached the customer: an app push, the text or the email went out.
const noticeReached = (notice) => Number(notice.pushAccepted) > 0 || textReached(notice.text) || notice.email === 'sent';

// What the staff screen is told about a notice: the outcome so far, and pending while tries remain.
function publicNotice(notice) {
  if (!notice) return null;
  const shown = {};
  for (const key of ['bell', 'pushAccepted', 'pushUnknown', 'text', 'email']) if (notice[key] !== undefined) shown[key] = notice[key];
  return notice.pending ? { ...shown, pending: true } : shown;
}

async function storedNotice(messageId) {
  const row = await db('messages').where({ id: messageId }).first('metadata');
  return publicNotice(metaOf(row).notice);
}

// Writes a try's outcome, only while that try still holds the claim (a try that was taken over writes nothing).
// `conn` is the marker connection for the write made inside the held text handoff (textStep).
function recordNotice(messageId, notice, conn = db) {
  return conn('messages').where({ id: messageId })
    .whereRaw("metadata->'notice'->>'claimedAt' = ?", [notice.claimedAt])
    .update({ metadata: conn.raw("coalesce(metadata, '{}'::jsonb) || jsonb_build_object('notice', ?::jsonb)", [JSON.stringify(notice)]), updated_at: new Date() });
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
// Returns { at, attempts, email, text, textCode }: what an earlier try stored for the email and the text (none before
// the move to it).
async function claimNotice(messageId, now = new Date()) {
  const [row] = await claimable(db('messages as m').where('m.id', messageId), now)
    .update({
      metadata: db.raw(`coalesce(metadata, '{}'::jsonb) || jsonb_build_object('notice', coalesce(metadata->'notice', '{}'::jsonb)
        || jsonb_build_object('pending', true, 'claimedAt', ?::text, 'attempts', coalesce((metadata->'notice'->>'attempts')::int, 0) + 1))`, [now.toISOString()]),
      updated_at: now,
    })
    .returning('metadata');
  if (!row) return null;
  const { attempts, email, text, textCode } = metaOf(row).notice || {};
  return { at: now.toISOString(), attempts: Number(attempts) || 1, email, text, textCode };
}

// The push an earlier try sent for this bell, from the bell's own record (push-notifications.js keeps pushState on
// it): 'accepted', 'sending' while its lease runs (it may still be accepted), else null.
function earlierPush(bell, now = Date.now()) {
  const meta = metaOf(bell);
  if (meta.pushState === 'accepted') return 'accepted';
  if (meta.pushState !== 'sending') return null;
  const leaseUntil = Date.parse(meta.pushLeaseUntil || '') || (Date.parse(meta.pushAttemptedAt || '') + 10 * 60 * 1000);
  return leaseUntil > now ? 'sending' : null;
}

// The in-app bell plus, unless push is false, a push to the Waves app. A push another attempt is still sending
// is not a miss. With readEarlierPush (GATE_PORTAL_ANSWER_TEXT on), a try that sends no push still reads the bell's
// record of an earlier try's push (a try made before the gate went on): one the app took counts as reached, so no
// text or email follows it, and one still sending is in flight. pushUnknown: that record could not be read (the bell
// lookup failed). Gate off, the outcome is this try's push alone.
async function bellAndPush(customerId, message, { push = true, readEarlierPush = false } = {}) {
  const readsEarlier = readEarlierPush && !push;
  try {
    const bell = await require('./notification-service').notifyCustomer(customerId, 'service', NOTICE_TITLE, preview(message.body), {
      link: MESSAGES_LINK,
      dedupeKey: `portal-reply:${message.id}`,
      push,
      awaitPush: true,
      pushOptions: { nativeOnly: true },
      metadata: { portalMessageId: message.id },
    });
    const earlier = readsEarlier ? earlierPush(bell) : null;
    return {
      bell: Boolean(bell?.id) && !bell.suppressed,
      pushAccepted: Number(bell?.push?.accepted || 0) || (earlier === 'accepted' ? 1 : 0),
      inFlight: bell?.push?.reason === 'push_in_flight' || earlier === 'sending',
      // notifyCustomer answers null when its dedupe read failed (it cannot tell this bell from a new one).
      ...(readsEarlier && !bell ? { pushUnknown: true } : {}),
    };
  } catch (err) {
    logger.warn(`[portal-messages] bell or push failed for message ${message.id}: ${err.message}`);
    return { bell: false, pushAccepted: 0, inFlight: false, ...(readsEarlier ? { pushUnknown: true } : {}) };
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

// The answer's text (owner 2026-11-22, D2 A and D4): "Hi {first name}, here's our answer from Waves: {answer}". An
// answer that does not fit TEXT_MAX_SEGMENTS sends its longest first part that fits, cut back to a space, and ends
// "… Read the rest in your portal: {link}". The link is the reply email's (account-membership-email.js
// sendPortalReply): the Messages tab, qualified with the customer's profile so an account with several homes opens
// the right one. Built in the characters the send step sends (send-customer-message.js makes the punctuation GSM and
// drops a link's scheme), so the segment count is the provider's; a short link (GATE_SMS_LINK_WRAP) only shortens it.
function answerTextBody(firstName, body, customerId) {
  const { normalizeGsmPunctuation, gsmSafeName } = require('./messaging/gsm-normalize');
  const { stripSmsUrlScheme } = require('./messaging/sms-link-policy');
  const { countSegments } = require('./messaging/segment-counter');
  const sendable = (text) => normalizeGsmPunctuation(stripSmsUrlScheme(text));
  const fits = (text) => countSegments(text).segmentCount <= TEXT_MAX_SEGMENTS;
  const lead = `Hi ${gsmSafeName(firstName)}, here's our answer from Waves: `;
  const whole = sendable(`${lead}${body}`);
  if (fits(whole)) return whole;
  const { qualifyNotificationLink } = require('./notification-links');
  const link = require('../utils/portal-url').portalUrl(qualifyNotificationLink(MESSAGES_LINK, customerId));
  const chars = Array.from(body);
  const cut = (n) => sendable(`${lead}${chars.slice(0, n).join('').trimEnd()}… Read the rest in your portal: ${link}`);
  // The longest first part that fits: lo fits (an empty part does), hi does not (the whole answer did not).
  let lo = 0;
  let hi = chars.length;
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (fits(cut(mid))) lo = mid;
    else hi = mid;
  }
  // A part that stops inside a word drops that word; one long word is cut where it stands.
  let end = lo;
  while (end > 0 && /\S/.test(chars[end] || '') && /\S/.test(chars[end - 1])) end -= 1;
  return cut(end > 0 ? end : lo);
}

// True when `destination` (the number the send step texts: its normalizeRecipient form) is a whole E.164 number and
// is the customer's stored phone in canonical E.164. The send step reads any ten digits as a US number, so a stored
// number it would turn into another one (a +45 number of eight national digits becomes +1 and ten digits) fails here,
// and that customer gets the email.
function sameDestination(storedPhone, destination) {
  return typeof destination === 'string' && /^\+\d{8,15}$/.test(destination)
    && require('../utils/phone').toE164(storedPhone) === destination;
}

// GATE_PORTAL_ANSWER_TEXT: the number the answer's text may go to, read in the answer's own transaction (staffReply)
// and saved on the message as `answerTextTo`: the send step's form of the customer's phone, when it is that phone
// (sameDestination). Null when there is none to bind (no phone, or one the send step would read as another number).
// The text goes only while the customer's row still holds this number, so a phone correction at any point after the
// save gets the email, never a text to the new number.
async function boundTextNumber(trx, customerId) {
  const row = await trx('customers').where({ id: customerId }).whereNull('deleted_at').first('phone');
  const destination = require('./messaging/send-customer-message').normalizeRecipient(row?.phone);
  return sameDestination(row?.phone, destination) ? destination : null;
}

// True when the answer may carry a Waves link: an owned host (composer-customer-links.js ownedPortalHosts: the portal
// and the short-link host) anywhere in the text, read as a browser reads a typed link (full-width letters as ASCII,
// the ideographic full stops as dots, invisible characters, tabs and line breaks dropped, percent-escapes decoded
// until the text stops changing). There is no word-boundary rule, so a host right after a line break or a word is
// still found; it over-reports on purpose (fail closed), and text still decoding after LINK_DECODE_PASSES counts as
// a link. Such an answer is not texted: before the SMS composer texts a page link, it checks who owns the link
// (bearerLinkSendCheck), and this text does not. The answer stays in the portal, and the reply email goes, as with
// the gate off.
const LINK_DECODE_PASSES = 12;
const foldLinkText = (text) => text.normalize('NFKC').replace(/[\p{Default_Ignorable_Code_Point}\t\r\n]/gu, '')
  .replace(/[。．｡]/g, '.').toLowerCase();
const decodeEscapes = (text) => text.replace(/(?:%[0-9a-f]{2})+/g, (run) => {
  try {
    return decodeURIComponent(run);
  } catch {
    return run;
  }
});
function answerCarriesLink(body) {
  const hosts = require('./composer-customer-links').ownedPortalHosts().map((host) => host.toLowerCase().replace(/:\d+$/, ''));
  let view = foldLinkText(String(body || ''));
  for (let pass = 0; pass < LINK_DECODE_PASSES; pass += 1) {
    if (hosts.some((host) => view.includes(host))) return true;
    const next = foldLinkText(decodeEscapes(view));
    if (next === view) return false;
    view = next;
  }
  return true;
}

// The answer's text goes to the number bound at the save, and only while the customer's row still holds it. The send
// step runs this handoff around the provider request (send-customer-message.js smsHandoffAllowed: this entry point
// only): the customer-comms and phone locks (STOP and sms_enabled writers serialize on them), then the row read FOR
// SHARE, so a phone correction commits before the read (a changed number refuses the text, and the email goes) or
// waits for the request. The send step reloads consent, suppression and the send window on the same connection before
// the request.
function phoneHeldHandoff(customerId, destination) {
  const { withSmsConsentLock } = require('../utils/customer-comms-lock');
  return (dispatch) => withSmsConsentLock(db, { phone: destination, customerId }, async (trx) => {
    const row = await trx('customers').where({ id: customerId }).whereNull('deleted_at').forShare().first('phone');
    if (!sameDestination(row?.phone, destination)) {
      return { ok: false, code: 'RECIPIENT_CHANGED', reason: 'recipient_changed', retryable: false };
    }
    return dispatch(trx);
  });
}

// The answer's one text, through the canonical send (STOP list, consent, audit log, the provider handoff the
// automatic SMS lanes respect). It resolves the customer's portal item, the same purpose as the text for a request's
// update (support_resolution: 3 segments, the number on the customer's own row). It is not a reply on the SMS thread,
// so it takes neither purpose 'conversational' nor the interlocked manual wrapper: that one settles the SMS thread's
// waiting question as answered by staff, and the customer's text may wait on something else
// (send-manual-customer-sms.js: it "interlocks staff REPLIES only"). `boundary` holds the try's mark at the provider
// boundary (textStep). { text: 'sent' } when the provider took it, 'uncertain' when it may have gone out, else
// 'not_sent' with the refusal's code: a link in the answer, no number bound at the save, a changed number, STOP or no
// consent, a failure. Never throws.
async function answerText(customerId, message, boundary) {
  const Send = require('./messaging/send-customer-message');
  try {
    if (answerCarriesLink(message.body)) return { text: 'not_sent', textCode: 'ANSWER_HAS_LINK' };
    const destination = metaOf(message).answerTextTo;
    if (!destination) return { text: 'not_sent', textCode: 'NO_TEXT_NUMBER' };
    const customer = await db('customers').where({ id: customerId }).whereNull('deleted_at').first('first_name', 'phone');
    if (!sameDestination(customer?.phone, destination)) return { text: 'not_sent', textCode: 'RECIPIENT_CHANGED' };
    const result = await Send.sendCustomerMessage({
      to: destination,
      body: answerTextBody(customer.first_name, message.body, customerId),
      channel: 'sms',
      audience: 'customer',
      purpose: 'support_resolution',
      customerId,
      identityTrustLevel: 'phone_matches_customer',
      entryPoint: 'admin_portal_answer',
      withSmsHandoff: phoneHeldHandoff(customerId, destination),
      // The provider boundary (twilio.js): after the send step's last check, right before the request.
      onDispatchStart: boundary.start,
      onDispatchAbort: boundary.undo,
      onDispatchRejected: boundary.undo,
      metadata: {
        original_message_type: 'portal_answer',
        portalMessageId: message.id,
        ...(message.admin_user_id ? { adminUserId: message.admin_user_id } : {}),
      },
    });
    return textOutcome(result, Send.classifyDeliveryCertainty, 'NOT_SENT');
  } catch (err) {
    // The error's code or name only: a send error's words can carry the number or the message (AGENTS.md: log ids).
    logger.warn(`[portal-messages] answer text failed for message ${message.id} (${err?.code || err?.name || 'error'})`);
    // A throw before the send (the customer read, the body) sent nothing. A throw from the send carries the outcome
    // the provider step saw (send-customer-message.js tags every throw), read as send-manual-customer-sms.js does.
    if (!err?.providerOutcome) return { text: 'not_sent', textCode: 'SEND_FAILED' };
    return textOutcome(err.providerOutcome, Send.classifyDeliveryCertainty, 'SEND_FAILED');
  }
}

// The text's outcome by the shared derivation (classifyDeliveryCertainty), never by `sent` alone (the Twilio adapter
// answers sent: true with deliveryOutcome 'not_sent' for a suppressed owner number): 'sent' when the provider took it,
// 'not_sent' with the refusal's code when it surely did not go, else 'uncertain' (it may have gone out).
function textOutcome(outcome, classify, fallbackCode) {
  const certainty = classify(outcome);
  if (certainty === 'sent') return { text: 'sent' };
  if (certainty === 'not_sent') return { text: 'not_sent', textCode: outcome?.code || fallbackCode };
  return { text: 'uncertain' };
}

// GATE_PORTAL_ANSWER_TEXT: a try's text part, or null when the notice has none: the gate is off, the try is the
// sweep's (it never starts a text), an earlier try moved to the email, or an earlier push reached the app. The move
// to the text ('sending') is saved at the provider boundary only, while this try still holds the claim: the send
// step's onDispatchStart, after its last check and right before the request. A try that stops before it sent
// nothing, so its notice still goes by email; a check that refuses after the move takes it back (onDispatchAbort,
// onDispatchRejected). A later try never texts again: it reuses the stored outcome, and a text still 'sending' (a try
// that stopped mid-request) counts as maybe gone. { lost: true } when the claim was lost (a try that was taken over
// sends nothing: the mark refuses the request). The mark and its undo run inside the held handoff transaction, so
// they write through the marker connection (models/marker-db.js), never a second root-pool connection.
async function textStep(customerId, message, claim, sent, { byStaff, textLive }) {
  if (claim.text !== undefined) {
    return { text: claim.text === 'sending' ? 'uncertain' : claim.text, ...(claim.textCode ? { textCode: claim.textCode } : {}) };
  }
  if (!byStaff || !textLive || claim.email !== undefined || sent.pushAccepted > 0) return null;
  const markerDb = require('../models/marker-db');
  const before = { ...sent, pending: true, claimedAt: claim.at, attempts: claim.attempts };
  let lost = false;
  const texted = await answerText(customerId, message, {
    start: async () => {
      if (await recordNotice(message.id, { ...before, text: 'sending' }, markerDb())) return;
      lost = true;
      // A throw before the request is a refusal: twilio.js sends nothing (SMS_HANDOFF_CHECK_FAILED).
      throw new Error('the answer notice moved to another try');
    },
    undo: () => recordNotice(message.id, before, markerDb()),
  });
  return lost ? { lost: true } : texted;
}

// A try's email part. Not needed after an accepted push or a text that went out; done already when an earlier try
// sent it (this try is for a missing bell). Otherwise the move to the email is saved while this try holds the claim,
// then the email goes. Null when the claim was lost (a try that was taken over sends nothing).
async function emailStep(customerId, message, claim, sent) {
  if (sent.pushAccepted > 0 || textReached(sent.text)) return { email: 'not_needed', retry: false };
  if (claim.email === 'sent') return { email: 'sent', retry: false };
  const held = await recordNotice(message.id, { ...sent, email: 'sending', pending: true, claimedAt: claim.at, attempts: claim.attempts });
  return held ? replyEmail(customerId, message) : null;
}

// The one notice for a saved answer, one try at a time (claimNotice): the customer's in-app bell plus a push
// to the Waves app (app devices only: a browser subscription is not the app); an email with the whole answer
// when no app device took the push. With GATE_PORTAL_ANSWER_TEXT on, the bell plus one text with the answer in
// place of the push (textStep), and the email when no text went out. The move to the text or the email is saved
// before it goes, and a later try never pushes after it (it makes sure of the bell and finishes that step): a try
// that stopped after the email went out cannot add a push. The try's outcome is final when the bell exists and the customer was reached or
// can't be (an email skip or block), or when it was the last try. A missing bell, or an email worth another
// try, stays pending for a retried click or the sweep (a bell missed after a sent email is made with no push
// and no second email). A push another try is still sending leaves this try's claim
// in place (it counted) and adds no email. The stored notice keeps its try count. Never throws. Safe to run
// again: the bell dedupes on its key, an accepted push is claimed by its bell (push-notifications.js), the text
// goes at most once (textStep), and the email carries its own idempotency key. `byStaff` marks a try run by the
// staff press itself (staffReply): only such a try starts a text, never the sweep.
async function noticeCustomer(customerId, message, { byStaff = false } = {}) {
  try {
    const claim = await claimNotice(message.id);
    if (!claim) return await storedNotice(message.id);
    // GATE_PORTAL_ANSWER_TEXT, read once for this try.
    const textLive = answerTextLive();
    const push = !textLive && claim.email === undefined && claim.text === undefined;
    const { inFlight, pushUnknown, ...sent } = await bellAndPush(customerId, message, { push, readEarlierPush: textLive });
    // A retry (an earlier try may have pushed, before GATE_PORTAL_ANSWER_TEXT went on) that cannot read the bell's
    // push record sends nothing: its claim stays, like a push in flight, and a later try reads the record. The last
    // try sends nothing either (running out of tries is no news about that push, and a second notice is worse than a
    // missing one): the notice ends unconfirmed (pushUnknown) for the staff screen. A first try has no earlier push
    // to miss.
    if (pushUnknown && claim.attempts > 1) {
      if (claim.attempts < NOTICE_ATTEMPTS) return { pending: true };
      const unconfirmed = { ...sent, pushUnknown: true, pending: false, claimedAt: claim.at, attempts: claim.attempts };
      return (await recordNotice(message.id, unconfirmed)) ? publicNotice(unconfirmed) : await storedNotice(message.id);
    }
    if (inFlight) {
      // Another try is still sending the push: no email. Its claim stays (this try counted); on the last try the
      // notice ends here, since whatever that push does is the outcome.
      if (claim.attempts >= NOTICE_ATTEMPTS) await recordNotice(message.id, { ...sent, email: 'not_needed', pending: false, claimedAt: claim.at, attempts: claim.attempts });
      return { pending: claim.attempts < NOTICE_ATTEMPTS };
    }
    const texted = await textStep(customerId, message, claim, sent, { byStaff, textLive });
    if (texted?.lost) return await storedNotice(message.id);
    const mail = await emailStep(customerId, message, claim, { ...sent, ...texted });
    if (!mail) return await storedNotice(message.id);
    const outcome = { ...sent, ...texted, email: mail.email };
    const pending = (!outcome.bell || (!noticeReached(outcome) && mail.retry)) && claim.attempts < NOTICE_ATTEMPTS;
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
    .select('m.id', 'm.body', 'm.admin_user_id', 'cv.customer_id');
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
    // GATE_PORTAL_ANSWER_TEXT: the number the answer's text may go to is the one on file when the answer is saved.
    const answerTextTo = answerTextLive() ? await boundTextNumber(trx, customerId) : null;
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
      metadata: {
        portalItem: { kind, id },
        notice: { pending: true },
        ...(clientRequestId ? { clientRequestId } : {}),
        ...(answerTextTo ? { answerTextTo } : {}),
      },
    });
    const closed = await closeItemWith(trx, kind, id, customerId);
    return { message, closed, customerId, threadId: thread.id };
  });
  if (saved.replay) {
    const { notice } = metaOf(saved.message);
    // A retried click tries a notice that is still pending (claimNotice decides); a final one is only shown.
    return {
      message: staffView(saved.message),
      closed: false,
      notice: notice?.pending ? await noticeCustomer(saved.customerId, saved.message, { byStaff: true }) : publicNotice(notice),
      replay: true,
    };
  }
  await closeItemBells(kind, id, actor, saved.threadId);
  const notice = await noticeCustomer(saved.customerId, saved.message, { byStaff: true });
  return { message: staffView(saved.message), closed: saved.closed, notice };
}

// One admin bell per thread: a later message rewrites the standing bell and rings it again. It rings on the
// locked thread row and only while the thread waits on the office (an answer saved first means a late ring
// would stand for nothing). Then the phone page, only when the bell really rang. Never throws: the message is
// the record.
async function ringOffice(customer, threadId, message) {
  try {
    const { raiseAdminAlert, breaksAlertRules } = require('./admin-alert-compose');
    const { fitAction, redactedWords, whyWithQuote } = require('./admin-alert-names');
    const name = [customer.first_name, customer.last_name].filter(Boolean).join(' ').trim() || 'A customer';
    // The customer's words, redacted and cut like every bell body; a quote the headline rules refuse (a second
    // sentence, a date) falls back to a plain why. The whole message is in the bell's full text either way.
    const photoCount = photosOn(message).length;
    const photoNote = photoCount ? `Sent ${photoCount} photo${photoCount === 1 ? '' : 's'}.` : '';
    const quoted = message.body
      ? whyWithQuote({ lead: 'They wrote in the portal: ', quote: redactedWords(message.body) })
      : 'They sent a photo in the portal and are waiting for an answer';
    const rang = await require('./portal-inbox').onLockedThread(threadId, async (trx, open) => {
      // Only the newest customer message writes the bell: an older one whose ring ran late would put back stale
      // words (the newer message's ring wrote, or will write, the bell).
      const newest = await trx('messages').where({ conversation_id: threadId, channel: CHANNEL, direction: 'inbound' })
        .orderBy([{ column: 'created_at', order: 'desc' }, { column: 'id', order: 'desc' }]).first('id');
      if (!open || newest?.id !== message.id) return false;
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
        // On the locked thread's own transaction: no second connection while the lock is held.
        trx,
        bell: true,
        dedupeKey: `portal-message:${threadId}`,
        // Each message is news, even with the same words as the last ("Hello?" twice): the version refreshes and
        // re-rings the standing bell.
        dedupeVersion: message.id,
        dedupeOpenOnly: true,
        refreshOnDedupe: true,
        bumpOnRefresh: true,
        detail: [message.body, photoNote].filter(Boolean).join('\n\n'),
        metadata: { customerId: customer.id, portalConversationId: threadId, portalMessageId: message.id },
      });
      return Boolean(result?.id) && !result.suppressed && (!result.deduped || (result.refreshed === true && result.rung !== false));
    });
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

// GATE_PORTAL_MESSAGES_NIGHT_AI: the after-hours AI answer, started after the message is saved and the office
// rung, and never awaited, so the customer's POST does not wait for the model. Gate off: nothing is loaded or
// read. Never throws.
function startNightAi(customer, threadId, message) {
  try {
    if (!featureGates.portalMessagesNightAiLive?.()) return;
    void require('./portal-messages-night-ai').answerAfterHours({ customer, threadId, message });
  } catch (err) {
    logger.warn(`[portal-messages] after-hours AI answer not started for message ${message.id}: ${err.message}`);
  }
}

/**
 * A signed-in customer writes in their portal thread.
 * @param {{ customer: { id: string, first_name?: string, last_name?: string }, body: string, clientRequestId?: string, files?: Array<{ buffer: Buffer, mimetype: string }> }} input
 */
async function customerPost({ customer, body, clientRequestId = null, files = [] }) {
  requireLive();
  const text = checkedBody(body, { withPhotos: files.length > 0 });
  const media = await storePhotos(customer.id, files);
  const saved = await db.transaction(async (trx) => {
    const thread = await threadWith(trx, customer.id);
    const prior = await priorSend(trx, thread.id, 'inbound', clientRequestId);
    if (prior) return { replay: true, message: prior };
    const message = await Conversations.appendMessage({
      ...(media.length ? { media } : {}),
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
  }).catch(async (err) => {
    await dropPhotos(media);
    throw err;
  });
  if (saved.replay) {
    // The first try saved the message and its photos: this try's copies are not on any row.
    await dropPhotos(media);
  } else {
    await ringOffice(customer, saved.threadId, saved.message);
    // A photo is for a person to look at: the assistant does not take the turn.
    if (!media.length) startNightAi(customer, saved.threadId, saved.message);
  }
  return shown(saved.message, customerView, PhotoService.CUSTOMER_DWELL_TTL_SECONDS);
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
// One page of a thread: the newest PAGE_SIZE messages before `before` (or the newest), oldest first.
async function threadPage(threadId, before, view, photoTtlSeconds) {
  const query = db('messages').where({ conversation_id: threadId, channel: CHANNEL }).whereIn('direction', ['inbound', 'outbound']);
  if (before) query.where('created_at', '<', before);
  const rows = await query.orderBy([{ column: 'created_at', order: 'desc' }, { column: 'id', order: 'desc' }])
    .limit(PAGE_SIZE + 1).select('id', 'direction', 'body', 'media', 'created_at', 'admin_user_id', 'message_type',
      db.raw("metadata->>'handOff' AS hand_off"));
  const messages = await Promise.all(rows.slice(0, PAGE_SIZE).reverse().map((row) => shown(row, view, photoTtlSeconds)));
  return { messages, hasMore: rows.length > PAGE_SIZE };
}

async function customerThread(customerId, { before = null } = {}) {
  requireLive();
  const thread = await findThread(customerId);
  if (!thread) return { messages: [], hasMore: false, unread: 0 };
  return { ...(await threadPage(thread.id, before, customerView, PhotoService.CUSTOMER_DWELL_TTL_SECONDS)), unread: await unreadFor(thread) };
}

// The office's view of a portal thread, every body whole (a Portal-tab message item shows a cut preview).
// Admin routes only.
async function staffThread(threadId, { before = null } = {}) {
  requireLive();
  const thread = await db('conversations').where({ id: threadId, channel: CHANNEL, our_endpoint_id: ENDPOINT }).first('id');
  if (!thread) throw new PortalMessageError('not_found', 404, 'This thread is gone.');
  return threadPage(thread.id, before, staffView, STAFF_PHOTO_TTL_SECONDS);
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
  PHOTO_MAX,
  PHOTO_MAX_BYTES,
  AI_MESSAGE_TYPE,
  AI_AGENT_NAME,
  MESSAGES_LINK,
  NOTICE_TITLE,
  PortalMessageError,
  cleanBody,
  staffReply,
  customerPost,
  customerThread,
  staffThread,
  customerUnread,
  markRead,
  resumePendingNotices,
  __private: { preview, noticeCustomer, closeItemWith, closeItemBells, itemCustomerWith, claimNotice, ringOffice, metaOf, bellAndPush, answerTextBody, textOutcome, earlierPush, sameDestination, answerCarriesLink },
};
