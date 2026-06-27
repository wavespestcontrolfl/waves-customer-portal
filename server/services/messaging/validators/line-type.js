/**
 * Proactive line-type guard (validator) — the proactive counterpart to the
 * reactive 30006 suppression in PR #2160.
 *
 * Before the FIRST SMS to a number, look up its line type (Twilio Lookup
 * line_type_intelligence) and block landlines, so we never waste a send + the
 * 30006 bounce that the reactive path would otherwise catch after the fact.
 *
 * Cost control (this adds a paid Lookup, ~$0.008, so it is conservative):
 *   - GATED dark behind GATE_PROACTIVE_LINETYPE_LOOKUP — zero lookups until the
 *     owner enables it.
 *   - Positioned LAST in the send pipeline, so we only pay for a lookup when the
 *     message would otherwise actually send (suppression / consent / quiet-hours
 *     blocks short-circuit first).
 *   - Every result is cached in phone_line_types (phone-keyed → works for
 *     customers, leads, and service-contact numbers alike), so each number is
 *     looked up at most once, ever.
 *   - A detected landline also gets a non_mobile suppression row, so subsequent
 *     sends short-circuit at check_suppression — before this validator runs.
 *   - Fails OPEN: any lookup/cache error allows the send (never block on infra).
 *
 * Only 'landline' is treated as non-SMS-capable (mirrors the appointment path's
 * isLandline). voip / tollFree / mobile are allowed through; the rare
 * non-deliverable ones are still caught reactively by the 30006 path.
 */

const db = require('../../../models/db');
const logger = require('../../logger');
const { isEnabled } = require('../../../config/feature-gates');
const { recordNonMobileSuppression } = require('./suppression');

const NON_SMS_LINE_TYPES = new Set(['landline']);

function maskPhone(p) {
  const d = String(p || '').replace(/\D/g, '');
  return d ? `***${d.slice(-4)}` : 'unknown';
}

// Mirror send_customer_message's normalizeRecipient so a cache key is identical
// whether it's written by this validator (which gets an already-normalized
// input.to) or by the appointment path's isLandline (which passes a raw phone).
// Normalizing here, in the cache layer, keeps both callers' keys in lockstep.
function normalizeE164(phone) {
  if (!phone) return null;
  const trimmed = String(phone).trim();
  if (!trimmed) return null;
  const digits = trimmed.replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  if (trimmed.startsWith('+')) return trimmed;
  return trimmed;
}

// Returns a discriminated result: { state: 'hit', lineType } | { state: 'miss' }
// | { state: 'error' }. A read ERROR must NOT be treated as a miss — proceeding
// to a paid Lookup we then can't cache would make EVERY send incur a lookup if
// the table is missing/unreadable (e.g. migration not yet landed, or access
// breaks after the gate is enabled).
async function readCachedLineType(phone) {
  const key = normalizeE164(phone);
  if (!key) return { state: 'miss' };
  try {
    const row = await db('phone_line_types').where({ phone: key }).first('line_type');
    return row ? { state: 'hit', lineType: row.line_type } : { state: 'miss' };
  } catch (err) {
    if (!/relation .* does not exist|phone_line_types/i.test(err.message)) {
      logger.warn(`[line-type] cache read failed: ${err.message}`);
    }
    return { state: 'error' };
  }
}

// Best-effort: never throws (callers treat caching as advisory). Quietly no-ops
// when the table doesn't exist yet (pre-migration deploy window).
async function cacheLineType(phone, lineType) {
  const key = normalizeE164(phone);
  if (!key || !lineType) return;
  try {
    await db('phone_line_types')
      .insert({ phone: key, line_type: lineType, checked_at: db.fn.now() })
      .onConflict('phone')
      .merge({ line_type: lineType, checked_at: db.fn.now() });
  } catch (err) {
    if (!/relation .* does not exist|phone_line_types/i.test(err.message)) {
      logger.warn(`[line-type] cache write failed: ${err.message}`);
    }
  }
}

async function lookupLineType(phone) {
  try {
    const config = require('../../../config');
    if (!config.twilio || !config.twilio.accountSid || !config.twilio.authToken) return null;
    const twilio = require('twilio');
    const client = twilio(config.twilio.accountSid, config.twilio.authToken);
    const lookup = await client.lookups.v2.phoneNumbers(phone).fetch({ fields: 'line_type_intelligence' });
    return (lookup.lineTypeIntelligence && lookup.lineTypeIntelligence.type) || null;
  } catch (err) {
    logger.warn(`[line-type] Twilio Lookup failed for ${maskPhone(phone)} — allowing send`);
    return null;
  }
}

function blockResult() {
  return {
    ok: false,
    code: 'NON_MOBILE_SMS_RECIPIENT',
    reason: 'Recipient is a landline (proactive line-type lookup) — SMS not deliverable',
  };
}

/**
 * @param {import('../policy').SendCustomerMessageInput} input
 * @returns {Promise<{ ok: boolean, code?: string, reason?: string }>}
 */
async function checkLineType(input, _policy, _contactState) {
  if (!isEnabled('proactiveLineTypeLookup')) return { ok: true };
  if (!input || input.channel !== 'sms') return { ok: true };
  if (!['customer', 'lead'].includes(input.audience)) return { ok: true };
  const phone = input.to;
  if (!phone) return { ok: true };

  // Cache read. An error fails OPEN without a paid lookup — we couldn't cache the
  // result anyway, so looking up would just burn money on every send.
  const cached = await readCachedLineType(phone);
  if (cached.state === 'error') return { ok: true };
  if (cached.state === 'hit') {
    return NON_SMS_LINE_TYPES.has(cached.lineType) ? blockResult() : { ok: true };
  }

  // Confirmed cache miss — the one-time Twilio Lookup.
  const lineType = await lookupLineType(phone);
  if (!lineType) return { ok: true }; // fail open — never block on a lookup failure

  await cacheLineType(phone, lineType);

  if (NON_SMS_LINE_TYPES.has(lineType)) {
    // Persist a suppression so future sends short-circuit at check_suppression
    // (earlier in the pipeline) and we pay for the lookup exactly once.
    await recordNonMobileSuppression({ phone, source: 'proactive_lookup_landline' }).catch(() => {});
    logger.info(`[line-type] Skipping SMS to ${maskPhone(phone)} — landline (proactive lookup)`);
    return blockResult();
  }
  return { ok: true };
}

module.exports = {
  checkLineType,
  // Shared phone-keyed line-type cache — also consumed by appointment-reminders'
  // isLandline so the two landline checks share one Lookup per number.
  readCachedLineType,
  cacheLineType,
  _internals: { lookupLineType, normalizeE164, NON_SMS_LINE_TYPES },
};
