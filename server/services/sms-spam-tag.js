/**
 * Spam TAG for SMS senders (owner 2026-11-02, "mark spam, no alerts, never
 * remove customer texts"), dark behind GATE_SMS_SPAM_TAG.
 *
 * The inbox "Mark spam" button used to BLOCK a sender (blocked_numbers, read
 * by middleware/spam-block.js): the webhook then dropped that number's later
 * texts before anything was logged, so nobody could read them. A tag drops
 * nothing. A tagged sender's texts are saved and shown like any other; each is
 * stamped with a manual spam verdict, marked read, and raises no bell, badge,
 * lead, quote or auto-reply.
 *
 * This reuses the auto screen's silencing path and builds no second one. The
 * screen writes metadata.spam_verdict = { enforced: true, ... } on the unified
 * messages row and the legacy sms_log row; every consumer keys on
 * spam_verdict.enforced === true (sms-response-policy.responseFlags, lead
 * extraction, the late drafter, outbound-call-reason, the webhook). A manual
 * verdict is the same shape with method 'manual', so those consumers need no
 * change. The webhook stamps new texts (routes/twilio-webhook.js, through
 * taggedVerdictForInbound); tagSpamSender stamps the texts already on file.
 *
 * A customer or an open lead always wins: the tag is refused for their number
 * and the webhook ignores a tag once their number matches one. Calls are not
 * touched; only blocked_numbers rejects calls.
 *
 * Phones match by identity (utils/phone.js phoneIdentityKey; SQL twin
 * sms-response-policy.js phoneIdentitySql): a NANP number by its last ten
 * digits, any other country code by its full digits, so a foreign number never
 * collides with a NANP number that shares its last ten digits.
 */
const db = require('../models/db');
const logger = require('./logger');
const { normalizePhone, phoneMatchDigits, phoneIdentityKey } = require('../utils/phone');
const { phoneIdentitySql, NON_ACTIONABLE_INBOUND_TYPES } = require('./sms-response-policy');
const { excludeRecruitingSmsLog } = require('../utils/recruiting-thread-scope');
const { detectHelp } = require('./messaging/opt-out-detector');

const VERDICT_VERSION = 'sms-spam-tag-v1';

// Gate read at call time; a test that replaces feature-gates with a bare mock
// reads as off, so the inbox keeps working for them.
function spamTagLive() {
  const gates = require('../config/feature-gates');
  return typeof gates.smsSpamTagLive === 'function' && gates.smsSpamTagLive() === true;
}

function tagError(code, message, details = {}) {
  return Object.assign(new Error(message), { code, details });
}

// The verdict the auto screen would write, from a person instead of a model.
function manualVerdict({ adminUserId = null, at = new Date() } = {}) {
  const markedAt = at instanceof Date ? at.toISOString() : new Date(at).toISOString();
  return {
    solicitation: true,
    confidence: 1,
    method: 'manual',
    mode: 'manual',
    enforced: true,
    version: VERDICT_VERSION,
    marked_by: adminUserId || null,
    marked_at: markedAt,
  };
}

// The tag row for a sender, matched by phone identity. Throws on a database
// error so the webhook can fail OPEN (treat the sender as untagged).
async function findTaggedSender(phone) {
  const key = phoneIdentityKey(typeof phone === 'string' ? phone : '');
  if (!key) return null;
  const row = await db('sms_spam_senders').whereRaw(`${phoneIdentitySql('phone')} = ?`, [key]).first();
  return row || null;
}

// Identity keys of every tagged sender, for the inbox payload (the table holds
// one row per number the office tagged). Fails soft to an empty set: the inbox
// must load even if this read fails; Mark spam is idempotent.
async function taggedSenderKeys() {
  try {
    const rows = await db('sms_spam_senders').select('phone');
    return new Set(rows.map((row) => phoneIdentityKey(row.phone)).filter(Boolean));
  } catch (err) {
    logger.warn(`[sms-spam-tag] tagged-sender read failed: ${err.code || err.name || 'error'}`);
    return new Set();
  }
}

// An OPEN lead (a quote requester who has not converted) has no customer row
// yet, so its thread looks unknown in the inbox. Same query the block route
// uses. No catch: a failing safety check must refuse the tag, not allow it.
async function findOpenLeadByPhone(phone) {
  const { OPEN_LEAD_STATUSES } = require('./lead-statuses');
  const digits = phoneMatchDigits(phone);
  if (!digits.length) return null;
  const lead = await db('leads')
    .whereIn('status', OPEN_LEAD_STATUSES)
    .whereNull('converted_at')
    .whereNull('deleted_at')
    .whereIn(db.raw("regexp_replace(COALESCE(phone, ''), '[^0-9]', '', 'g')"), digits)
    .first('id', 'first_name', 'last_name');
  return lead || null;
}

// Which new texts may be silenced by a tag at all. Staff, the AI line,
// reactions, photos, an empty body, an applicant, a sender with a customer
// record (or a failed lookup), a carrier keyword (STOP, START, HELP, YES ...)
// and any text the webhook is treating as an opt-out or opt-in keep ordinary
// handling, so consent is never touched.
function canTagInbound({
  body, rawOptCommand, optCommand, isAiNumber, staffSender, smsReaction, hasMedia, recruitingReply, hasCustomerRecord,
} = {}) {
  const text = String(body || '').trim();
  if (!text || isAiNumber || staffSender || smsReaction || hasMedia || recruitingReply || hasCustomerRecord) return false;
  if (optCommand?.action) return false;
  if (rawOptCommand?.action && /keyword$/.test(rawOptCommand.detectionMethod || '')) return false;
  return !detectHelp(text).help;
}

// The webhook's question for one new text: is this sender tagged, and is the
// tag still valid? Null means "ordinary handling". The caller has already
// ruled out staff, the AI line, reactions, media, empty bodies, carrier
// keywords and a sender with a customer record; this adds the open-lead check.
// Throws on a lookup error; the webhook treats that as not tagged.
async function taggedVerdictForInbound({ phone }) {
  if (!spamTagLive()) return null;
  const row = await findTaggedSender(phone);
  if (!row) return null;
  if (await findOpenLeadByPhone(phone)) return null;
  return manualVerdict({ adminUserId: row.marked_by, at: row.marked_at });
}

// The webhook's one call for a new text: the manual verdict to write, or null
// for ordinary handling. Any lookup error reads as not tagged (fails OPEN), so
// the auto screen below still runs.
async function verdictForNewText({ phone, ...context } = {}) {
  if (!canTagInbound(context)) return null;
  try {
    return await taggedVerdictForInbound({ phone });
  } catch {
    logger.warn('[sms-spam-tag] tag lookup failed; continuing normal handling');
    return null;
  }
}

// "Not spam" can land while a text from that sender is in flight: the webhook
// read the tag, then the undo deleted it and cleared the texts on file before
// this text's rows existed. The webhook calls this after BOTH rows are written.
// Either this read sees the undo and releases the text (true: ordinary
// handling, unread, verdict cleared), or the undo committed after this read,
// so its own scan, which runs after its delete, sees and clears these rows. A
// failed read or write keeps the tag (false); "Not spam" can be pressed again.
async function releaseIfUntagged({ phone, messageSid, smsLogId = null } = {}) {
  try {
    if (await findTaggedSender(phone)) return false;
    const clearJson = JSON.stringify({ enforced: false, cleared_by: null, cleared_at: new Date().toISOString() });
    await db('messages').where({ channel: 'sms', twilio_sid: messageSid })
      .update({ metadata: db.raw(CLEAR_VERDICT_SQL, [clearJson]), is_read: false, read_at: null, updated_at: new Date() });
    if (smsLogId) {
      await db('sms_log').where({ id: smsLogId }).update({ metadata: db.raw(CLEAR_VERDICT_SQL, [clearJson]), is_read: false });
    }
    return true;
  } catch (err) {
    logger.warn(`[sms-spam-tag] in-flight release check failed: ${err.code || err.name || 'error'}`);
    return false;
  }
}

// Sets spam_verdict.enforced = false (plus who and when) and keeps the rest.
const CLEAR_VERDICT_SQL = "jsonb_set(COALESCE(metadata, '{}'::jsonb), '{spam_verdict}', COALESCE(metadata->'spam_verdict', '{}'::jsonb) || ?::jsonb)";
const ENFORCED_SQL = "COALESCE({col}->'spam_verdict'->>'enforced', 'false') = 'true'";
const enforcedSql = (col) => ENFORCED_SQL.replace('{col}', col);
// A text with a photo always stays actionable (responseFlags), so a tag never
// reads or silences one.
const noMediaSql = (col) => `jsonb_array_length(CASE WHEN jsonb_typeof(${col}) = 'array' THEN ${col} ELSE '[]'::jsonb END) = 0`;

function actionableTypes(qb, column) {
  return excludeRecruitingSmsLog(qb, column)
    .where((b) => b.whereNull(column).orWhereNotIn(column, NON_ACTIONABLE_INBOUND_TYPES));
}

// Legacy inbound texts for one sender, by identity.
function legacyRows(key) {
  return db('sms_log')
    .where({ direction: 'inbound' })
    .whereRaw(`${phoneIdentitySql('from_phone')} = ?`, [key]);
}

// Unified inbound texts for one sender. The legacy twin keeps the original
// sender identity after a thread is promoted, so it wins over contact_phone.
function unifiedRows(key) {
  return db('messages as m')
    .join('conversations as c', 'c.id', 'm.conversation_id')
    .leftJoin('sms_log as l', function twin() {
      this.on('l.twilio_sid', '=', 'm.twilio_sid').andOnVal('l.direction', 'inbound');
    })
    .where({ 'm.channel': 'sms', 'm.direction': 'inbound' })
    .whereRaw(`${phoneIdentitySql("COALESCE(NULLIF(l.from_phone, ''), c.contact_phone)")} = ?`, [key]);
}

const mergeVerdictSql = () => "COALESCE(metadata, '{}'::jsonb) || ?::jsonb";

// Stamp the sender's texts already on file with the manual verdict and mark
// them read. Skips texts that already carry an enforced verdict (a model
// verdict stays as it is), photo texts, opt-out/opt-in/help commands and
// recruiting replies.
async function stampExistingTexts(key, verdict, adminUserId) {
  const verdictJson = JSON.stringify({ spam_verdict: verdict });
  const legacyIds = await actionableTypes(legacyRows(key), 'message_type')
    .whereRaw(`NOT (${enforcedSql('metadata')})`)
    .whereRaw(noMediaSql("metadata->'media'"))
    .pluck('id');
  if (legacyIds.length) {
    await db('sms_log').whereIn('id', legacyIds)
      .update({ is_read: true, metadata: db.raw(mergeVerdictSql(), [verdictJson]) });
  }
  const stampIds = await actionableTypes(unifiedRows(key), 'm.message_type')
    .whereRaw(`NOT (${enforcedSql('m.metadata')})`)
    .whereRaw(noMediaSql('m.media'))
    .distinct('m.id')
    .pluck('m.id');
  if (stampIds.length) {
    await db('messages').whereIn('id', stampIds)
      .update({ metadata: db.raw(mergeVerdictSql(), [verdictJson]), updated_at: new Date() });
  }
  // Read every eligible text that carries an enforced verdict and is still
  // unread, not only the ones stamped now: a text stamped by an earlier tag
  // whose read failed is repaired by the next tag (pre-push audit P1).
  const readIds = await actionableTypes(unifiedRows(key), 'm.message_type')
    .whereRaw(enforcedSql('m.metadata'))
    .whereRaw(noMediaSql('m.media'))
    .where((b) => b.where('m.is_read', false).orWhereNull('m.is_read'))
    .distinct('m.id')
    .pluck('m.id');
  let readFailed = false;
  if (readIds.length) {
    // The ONE read writer: messages.is_read, the sms_log mirror, and the
    // unknown-sender bell clean-up.
    try {
      const { markInboundSmsRead } = require('./inbound-sms-read');
      await markInboundSmsRead({ messageIds: readIds, adminUserId: adminUserId || null, role: 'admin' });
    } catch (err) {
      readFailed = true;
      logger.warn(`[sms-spam-tag] marking the tagged texts read failed: ${err.code || err.name || 'error'}`);
    }
  }
  return { legacy: legacyIds.length, unified: stampIds.length, readFailed };
}

/**
 * Tag a sender. Refuses a live customer's number (CUSTOMER_NUMBER) and an open
 * lead's (LEAD_NUMBER); a bad number is INVALID_NUMBER. Tagging a number that
 * is already tagged is not an error.
 */
async function tagSpamSender({ number, adminUserId = null, reason = null, source = 'inbox' } = {}) {
  const phone = normalizePhone(number);
  const key = phoneIdentityKey(phone || '');
  if (!phone || !key || !phoneMatchDigits(number).length) throw tagError('INVALID_NUMBER', 'valid number required');

  const { findKnownCallerCustomer } = require('../utils/known-caller-phone');
  const owner = await findKnownCallerCustomer(db, phone);
  if (owner) {
    throw tagError('CUSTOMER_NUMBER', 'This number belongs to an existing customer and cannot be marked as spam. Archive or edit the customer record instead.', {
      customer_id: owner.id,
      customer_name: [owner.first_name, owner.last_name].filter(Boolean).join(' ') || null,
    });
  }
  const openLead = await findOpenLeadByPhone(phone);
  if (openLead) {
    throw tagError('LEAD_NUMBER', 'This number belongs to an open lead and cannot be marked as spam. Close or convert the lead first.', { lead_id: openLead.id });
  }

  const existing = await findTaggedSender(phone);
  const markedAt = existing?.marked_at || new Date();
  if (!existing) {
    await db('sms_spam_senders')
      .insert({ phone, marked_by: adminUserId || null, marked_at: markedAt, reason: reason || null, source })
      .onConflict('phone').ignore();
  }
  const stamped = await stampExistingTexts(key, manualVerdict({ adminUserId, at: markedAt }), adminUserId);
  return { phone, alreadyTagged: Boolean(existing), ...stamped };
}

/**
 * Undo a tag. Deletes the row and sets spam_verdict.enforced = false (with
 * cleared_by and cleared_at) on that sender's texts that carry an enforced
 * verdict, manual or model, so they count as needing a reply again (owner
 * ruling 2026-09-24: no durable dismissal marker). is_read is not touched.
 */
async function untagSpamSender({ number, adminUserId = null } = {}) {
  const phone = normalizePhone(number);
  const key = phoneIdentityKey(phone || '');
  if (!key) throw tagError('INVALID_NUMBER', 'valid number required');
  const removed = await db('sms_spam_senders').whereRaw(`${phoneIdentitySql('phone')} = ?`, [key]).del();
  const clearJson = JSON.stringify({ enforced: false, cleared_by: adminUserId || null, cleared_at: new Date().toISOString() });
  const legacyIds = await legacyRows(key).whereRaw(enforcedSql('metadata')).pluck('id');
  if (legacyIds.length) {
    await db('sms_log').whereIn('id', legacyIds).update({ metadata: db.raw(CLEAR_VERDICT_SQL, [clearJson]) });
  }
  const messageIds = await unifiedRows(key).whereRaw(enforcedSql('m.metadata')).distinct('m.id').pluck('m.id');
  if (messageIds.length) {
    await db('messages').whereIn('id', messageIds)
      .update({ metadata: db.raw(CLEAR_VERDICT_SQL, [clearJson]), updated_at: new Date() });
  }
  return { phone, removed: removed > 0, legacy: legacyIds.length, unified: messageIds.length };
}

module.exports = {
  VERDICT_VERSION,
  spamTagLive,
  manualVerdict,
  findTaggedSender,
  taggedSenderKeys,
  findOpenLeadByPhone,
  canTagInbound,
  taggedVerdictForInbound,
  releaseIfUntagged,
  verdictForNewText,
  tagSpamSender,
  untagSpamSender,
};
