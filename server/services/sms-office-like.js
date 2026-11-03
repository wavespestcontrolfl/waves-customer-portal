'use strict';

/**
 * The office's like on a customer's text (GATE_SMS_LIKE; owner 2026-11-02,
 * decision page "SMS Like Button", option B).
 *
 * Texting has no real reaction: Twilio cannot attach one to a customer's
 * text. So a like is a plain thumbs-up text (OFFICE_LIKE_BODY) sent through
 * the composer's own send handler (routes/admin-communications.js
 * sendSmsHandler: consent, opt-out, line, lock and audit checks all apply),
 * plus a marker in the liked message's metadata that tells the inbox who
 * liked it and when.
 *
 * Only the customer's newest text in its thread qualifies, with nothing after
 * it in either direction: a thumbs-up that lands under a later message answers
 * the wrong thing. The route checks that before it claims the marker, and the
 * send checks it again at the provider boundary, under the phone lock, with
 * only its own reservation row left out (newerThreadMessageExists). The
 * marker is claimed before the send, so two clicks send one text; a send that
 * surely did not leave hands the claim back, and an uncertain one keeps it.
 */

const crypto = require('crypto');
const {
  phoneIdentitySql,
  canonicalSmsLegacyLinkSql,
  canonicalSmsAddressProjectionSql,
} = require('./sms-response-policy');
const { isSmsReaction, customerLikeReaction } = require('./sms-intent');
const { normalizePhone } = require('../utils/phone');

const OFFICE_LIKE_BODY = '\u{1F44D}';
const OFFICE_LIKE_KEY = 'office_like';
// The message_type the Twilio webhook stores a quiet reaction under.
const QUIET_REACTION_MESSAGE_TYPE = 'sms_reaction';
const NEWER_MESSAGE_REFUSAL = 'A newer text is in this thread. Only the newest customer text can get a like.';

// GATE_SMS_LIKE at call time, read through the module object: suites that
// replace feature-gates with a bare mock lack the reader, and the inbox must
// keep loading for them (the gate reads as off).
function likesLive() {
  const gates = require('../config/feature-gates');
  return typeof gates.smsLikeLive === 'function' && gates.smsLikeLive() === true;
}

function parseMetadata(value) {
  if (value && typeof value === 'object') return value;
  try { return JSON.parse(value || '{}') || {}; } catch { return {}; }
}

// The same address projection the Messages log uses (legacy twin first, then
// the canonical event and thread fields), over m / c / cu / legacy.
function addressSql() {
  return {
    legacyLink: canonicalSmsLegacyLinkSql({ messageAlias: 'm', conversationAlias: 'c' }),
    projection: canonicalSmsAddressProjectionSql({
      messageAlias: 'm', conversationAlias: 'c', customerAlias: 'cu', legacyAlias: 'legacy',
    }),
  };
}

function smsWithAddress(dbi) {
  const { legacyLink } = addressSql();
  return dbi('messages as m')
    .join('conversations as c', 'c.id', 'm.conversation_id')
    .leftJoin('customers as cu', 'cu.id', 'c.customer_id')
    .joinRaw(`LEFT JOIN LATERAL (${legacyLink}) legacy ON true`)
    .where('m.channel', 'sms');
}

// The liked text with the send fields "Text back" would use: the customer's
// phone, our line, and the linked customer only when that phone is the
// customer's primary phone (the send handler refuses any other pairing; the
// Messages log names the same reply recipient).
async function loadLikeTarget(dbi, messageId) {
  const { projection } = addressSql();
  const row = await smsWithAddress(dbi)
    .where('m.id', messageId)
    .first(
      'm.id', 'm.direction', 'm.body', 'm.created_at', 'm.twilio_sid', 'm.metadata', 'legacy.id as legacy_id',
      'c.customer_id', 'cu.phone as customer_phone', 'cu.deleted_at as customer_deleted_at',
      dbi.raw(`${projection.contactPhoneSql} AS contact_phone`),
      dbi.raw(`${projection.endpointSql} AS our_endpoint`),
      dbi.raw(`${projection.peerSql} AS peer`),
    );
  if (!row) return null;
  const contactPhone = String(row.contact_phone || '').trim();
  const customerOwnsPhone = Boolean(row.customer_id && !row.customer_deleted_at
    && normalizePhone(contactPhone) && normalizePhone(contactPhone) === normalizePhone(row.customer_phone));
  return {
    id: row.id,
    direction: row.direction,
    body: row.body,
    createdAt: row.created_at,
    twilioSid: row.twilio_sid || null,
    legacyId: row.legacy_id || null,
    metadata: parseMetadata(row.metadata),
    contactPhone,
    ourEndpoint: String(row.our_endpoint || '').trim(),
    peer: row.peer || '',
    recipientCustomerId: customerOwnsPhone ? row.customer_id : null,
  };
}

// Why this text cannot get a like, or null when it can (the thread check is
// separate: it reads the database).
function likeRefusal(target) {
  if (target.direction !== 'inbound') return 'Only a customer text can get a like.';
  if (isSmsReaction(target.body)) return 'This text is a reaction. It cannot get a like.';
  if (target.metadata[OFFICE_LIKE_KEY]) return 'This text already has a like.';
  if (!target.contactPhone || !target.peer) return 'This text has no phone number to answer.';
  return null;
}

// Is there any text after the liked one with the same customer phone, on any
// of our lines? Canonical messages and legacy-only log rows both count, in
// either direction, and a row stamped at the same instant counts too: in
// doubt, no like. At the provider boundary the like's own send has already
// written its reservation log row; excludeLogIds leaves out exactly those rows.
async function newerThreadMessageExists(dbi, target, { excludeLogIds = [] } = {}) {
  if (!target.peer) return true;
  const { projection } = addressSql();
  const canonical = smsWithAddress(dbi)
    .whereNot('m.id', target.id)
    .where('m.created_at', '>=', target.createdAt)
    .whereRaw(`${projection.peerSql} = ?`, [target.peer]);
  if (await canonical.first('m.id')) return true;
  const legacyPeer = phoneIdentitySql("CASE WHEN sl.direction = 'inbound' THEN sl.from_phone ELSE sl.to_phone END");
  const legacy = dbi('sms_log as sl')
    .where('sl.created_at', '>=', target.createdAt)
    .whereRaw(`${legacyPeer} = ?`, [target.peer]);
  // The liked text's own log twin: the row the address projection linked
  // (a historical backfill has no provider id), and any row with its id.
  if (target.legacyId) legacy.whereNot('sl.id', target.legacyId);
  if (target.twilioSid) legacy.where((q) => q.whereNull('sl.twilio_sid').orWhereNot('sl.twilio_sid', target.twilioSid));
  if (excludeLogIds.length) legacy.whereNotIn('sl.id', excludeLogIds);
  return Boolean(await legacy.first('sl.id'));
}

// The marker is written only where none exists, so one of two racing clicks
// wins. jsonb_exists, not the jsonb ? operator: knex reads ? as a binding.
async function claimOfficeLike(dbi, messageId, actor = {}) {
  const claim = {
    status: 'sending',
    token: crypto.randomUUID(),
    by_id: actor.technicianId || null,
    by_name: actor.name || null,
    at: new Date().toISOString(),
  };
  const updated = await dbi('messages')
    .where({ id: messageId, channel: 'sms', direction: 'inbound' })
    .whereRaw(`NOT jsonb_exists(COALESCE(metadata, '{}'::jsonb), '${OFFICE_LIKE_KEY}')`)
    .update({
      metadata: dbi.raw(`COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('${OFFICE_LIKE_KEY}', ?::jsonb)`, [JSON.stringify(claim)]),
    });
  return updated === 1 ? claim : null;
}

function ownClaim(dbi, messageId, token) {
  return dbi('messages')
    .where({ id: messageId })
    .whereRaw(`metadata->'${OFFICE_LIKE_KEY}'->>'token' = ?`, [token]);
}

// After the send, by what it did. 'sent' (the provider took it) and
// 'uncertain' (it may have left) keep the like, so a second click cannot send
// a second thumbs-up; 'not_sent' hands it back and the text can get a like
// again. Only this click's own claim (its token) is touched.
async function finishOfficeLike(dbi, messageId, token, verdict) {
  if (verdict === 'not_sent') {
    await ownClaim(dbi, messageId, token).update({ metadata: dbi.raw(`metadata - '${OFFICE_LIKE_KEY}'`) });
    return;
  }
  const patch = { status: verdict, settled_at: new Date().toISOString() };
  await ownClaim(dbi, messageId, token).update({
    metadata: dbi.raw(`jsonb_set(metadata, '{${OFFICE_LIKE_KEY}}', (metadata->'${OFFICE_LIKE_KEY}') || ?::jsonb)`, [JSON.stringify(patch)]),
  });
}

// What the inbox shows: who liked it and when, and whether the text is known
// to have left. No token or ids.
function officeLikeForClient(metadata) {
  const like = parseMetadata(metadata)[OFFICE_LIKE_KEY];
  if (!like || typeof like !== 'object') return null;
  return {
    status: like.status === 'sent' ? 'sent' : 'unconfirmed',
    by: typeof like.by_name === 'string' && like.by_name.trim() ? like.by_name.trim() : null,
    at: like.at || null,
  };
}

// The like fields the Messages log and the customer's thread carry: none while
// GATE_SMS_LIKE is off (on: likesLive(), read once per request) or for a call.
// On, a text carries the office's like on a customer text, a customer's like
// (customerLikeReaction) on one of our texts, and whether it can get a like at
// all (likeRefusal's per-text half; the inbox adds "newest in the thread").
// Only a quiet reaction (stored as 'sms_reaction': it raised no alert) is sent
// as a customerReaction, so the thread folds it into a line on our text. A loud
// one (an answer, a dislike; stored as an ordinary inbound text and alerted)
// and a row with no message type stay a normal bubble.
function likeFieldsForClient({ on, channel = 'sms', direction, body, metadata, messageType }) {
  if (!on || channel !== 'sms') return {};
  if (direction !== 'inbound') return { officeLike: null, customerReaction: null, likeable: false };
  return {
    officeLike: officeLikeForClient(metadata),
    customerReaction: messageType === QUIET_REACTION_MESSAGE_TYPE ? customerLikeReaction(body) : null,
    likeable: !isSmsReaction(body),
  };
}

module.exports = {
  OFFICE_LIKE_BODY,
  likesLive,
  NEWER_MESSAGE_REFUSAL,
  loadLikeTarget,
  likeRefusal,
  newerThreadMessageExists,
  claimOfficeLike,
  finishOfficeLike,
  officeLikeForClient,
  likeFieldsForClient,
};
