/**
 * Voicemail lead text-back — texts a NEW prospect who left a voicemail a
 * prefilled quote-wizard link, so the speed-to-lead window isn't left to a
 * manual callback (the 2026-07-01 inbound-lead investigation: voicemail
 * prospects got NOTHING proactive).
 *
 * Called from call-recording-processor.js Step 4b, ONLY on the voicemail lead
 * path (new prospect, workable signal, no existing customer). Gates, in order:
 *   1. GATE_VOICEMAIL_LEAD_SMS — a customer-facing auto-send, fails CLOSED in
 *      every environment until the owner enables it.
 *   2. One text per phone number EVER — a DB-atomic claim on
 *      voicemail_sms_claims (phone PRIMARY KEY, INSERT ... ON CONFLICT DO
 *      NOTHING: two concurrently-processed voicemails from the same phone
 *      race to one winner), belt-and-suspenders sms_log history check, plus
 *      an atomic per-lead claim on leads.extracted_data for same-lead
 *      idempotency. The phone claim is released ONLY on outcomes that never
 *      consumed the one-shot (template disabled, missing secret, re-queue
 *      failure, unexpected error).
 *   3. Landline pre-check via the shared phone_line_types cache + one paid
 *      Twilio Lookup per uncached number (a voicemail caller can easily be on
 *      a landline — don't burn the one-shot on an undeliverable send).
 *   4. The sendCustomerMessage policy pipeline: suppression (STOP), consent
 *      (transactional basis — they called us about service), Florida quiet
 *      hours (purpose missed_call_followup is quiet-enforced, 8am–8pm ET).
 *      A quiet-hours hold or transient provider failure re-queues onto the
 *      scheduled-SMS rail (status='scheduled' + scheduled_for) so an evening
 *      voicemail gets its text the next allowed morning instead of never.
 *   5. Template kill switch — voicemail_quote_link is admin-editable and
 *      is_active-toggleable like every automated template.
 *
 * The link carries a lead-prefill HMAC token (utils/lead-prefill-token.js) in
 * the URL FRAGMENT (#vlead=…&vt=…) — fragments never reach the server, so the
 * bearer token stays out of morgan/Railway request logs and Referer headers
 * (the AGENTS.md PII-in-logs rule). The wizard exchanges it via POST for the
 * lead's own contact fields and attaches its submission to the SAME lead
 * row — prefill/attach authority only, never identity or pricing.
 */

const db = require('../models/db');
const logger = require('./logger');
const { isEnabled } = require('../config/feature-gates');
const TWILIO_NUMBERS = require('../config/twilio-numbers');
const { sendCustomerMessage } = require('./messaging/send-customer-message');
const { renderSmsTemplate } = require('./sms-template-renderer');
const { readCachedLineType, cacheLineType, lookupLineType } = require('./messaging/validators/line-type');
const { mintLeadPrefillToken } = require('../utils/lead-prefill-token');
const { shortenOrPassthrough } = require('./short-url');

const MESSAGE_TYPE = 'voicemail_quote_link';
const PORTAL_BASE_URL = 'https://portal.wavespestcontrol.com';

function maskPhone(value) {
  const digits = String(value || '').replace(/\D/g, '');
  return digits ? `***${digits.slice(-4)}` : 'unknown';
}

function capitalizeName(name) {
  const trimmed = String(name || '').trim();
  if (!trimmed) return '';
  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
}

// Stamp the one-shot status onto the lead's extracted_data jsonb. Best-effort:
// the durable dedupe is the sms_log row, this is the visible breadcrumb (and
// the atomic claim below is what prevents a concurrent double-send).
async function stampStatus(leadId, status) {
  try {
    await db('leads').where({ id: leadId }).update({
      extracted_data: db.raw(
        "jsonb_set(COALESCE(extracted_data, '{}'::jsonb), '{quote_link_sms_status}', to_jsonb(?::text))",
        [status]
      ),
      updated_at: new Date(),
    });
  } catch (e) {
    logger.warn(`[voicemail-sms] status stamp failed for lead ${leadId}: ${e.message}`);
  }
}

// Timeline breadcrumb on the lead Virginia works. Best-effort.
async function logActivity(leadId, activityType, description, metadata = {}) {
  try {
    await db('lead_activities').insert({
      lead_id: leadId,
      activity_type: activityType,
      description,
      performed_by: 'AI Call Processor',
      metadata: JSON.stringify(metadata),
    });
  } catch (e) {
    logger.warn(`[voicemail-sms] lead activity insert failed for lead ${leadId}: ${e.message}`);
  }
}

// Release the per-phone claim for outcomes that never consumed the one-shot
// (template disabled, missing secret, re-queue failure, unexpected error) so
// a LATER voicemail from the same prospect can be texted once the config
// issue is fixed. Best-effort; a leaked claim fails safe (no text, no dup).
async function releasePhoneClaim(phone) {
  try {
    await db('voicemail_sms_claims').where({ phone }).del();
  } catch (e) {
    logger.warn(`[voicemail-sms] phone claim release failed for ${maskPhone(phone)}: ${e.message}`);
  }
}

// Stamp the final outcome on the kept claim row (visibility only; the row's
// existence is the dedupe, the outcome column is the breadcrumb).
async function stampPhoneClaim(phone, outcome) {
  try {
    await db('voicemail_sms_claims').where({ phone }).update({ outcome });
  } catch (e) {
    logger.warn(`[voicemail-sms] phone claim stamp failed for ${maskPhone(phone)}: ${e.message}`);
  }
}

async function sendVoicemailQuoteLink({ leadId, extracted = {}, call = {}, phone } = {}) {
  if (!isEnabled('voicemailLeadSms')) {
    logger.info(`[voicemail-sms] Gate off — text-back skipped for lead ${leadId || 'unknown'}`);
    return { sent: false, skipped: 'gate_off' };
  }
  if (!leadId || !phone) return { sent: false, skipped: 'missing_input' };

  // Belt-and-suspenders history check: pre-claim-table sends (or hand-sent
  // rows tagged with the message_type) also consume the one-shot. Advisory
  // only for ordering — the ATOMIC gate is the claim insert below.
  try {
    const prior = await db('sms_log')
      .where({ to_phone: phone, message_type: MESSAGE_TYPE })
      .first('id');
    if (prior) {
      return { sent: false, skipped: 'already_sent_to_phone' };
    }
  } catch (e) {
    // A failed dedupe read must not fire a possibly-duplicate automated text.
    logger.warn(`[voicemail-sms] sms_log dedupe read failed — skipping (fail closed): ${e.message}`);
    return { sent: false, skipped: 'dedupe_read_failed' };
  }

  // One text per phone number, EVER — DB-atomic: phone is the PRIMARY KEY of
  // voicemail_sms_claims, so of two concurrently-processed voicemails from
  // the same phone (two calls → two lead rows) exactly one insert wins.
  // Fails closed: if the claim can't be taken (conflict OR error), no text.
  let phoneClaimed = false;
  try {
    const inserted = await db('voicemail_sms_claims')
      .insert({ phone, lead_id: leadId, outcome: 'claimed' })
      .onConflict('phone')
      .ignore()
      .returning('phone');
    phoneClaimed = Array.isArray(inserted) ? inserted.length > 0 : !!inserted;
  } catch (e) {
    logger.warn(`[voicemail-sms] phone claim insert failed — skipping (fail closed): ${e.message}`);
    return { sent: false, skipped: 'claim_insert_failed' };
  }
  if (!phoneClaimed) {
    return { sent: false, skipped: 'already_sent_to_phone' };
  }

  try {
    return await sendClaimedVoicemailQuoteLink({ leadId, extracted, call, phone });
  } catch (err) {
    // An unexpected throw never consumed the one-shot — release so a later
    // voicemail can retry — and rethrows into the caller's non-blocking catch.
    await releasePhoneClaim(phone);
    throw err;
  }
}

// Runs with the per-phone claim held. Every return path must either keep the
// claim (one-shot consumed) or release it (config/transient failure).
async function sendClaimedVoicemailQuoteLink({ leadId, extracted, call, phone }) {
  // Atomic per-lead claim: same-lead idempotency (re-processing, admin
  // Reprocess). Losing it means THIS lead already ran; keep the phone claim.
  const claimed = await db('leads')
    .where({ id: leadId })
    .whereRaw("COALESCE(extracted_data->>'quote_link_sms_status', '') = ''")
    .update({
      extracted_data: db.raw(
        "jsonb_set(COALESCE(extracted_data, '{}'::jsonb), '{quote_link_sms_status}', to_jsonb('claimed'::text))"
      ),
      updated_at: new Date(),
    });
  if (!claimed) {
    return { sent: false, skipped: 'already_claimed' };
  }

  // Landline pre-check (shared phone_line_types cache; at most one paid Lookup
  // per number, ever). Fails open on lookup errors — the pipeline's reactive
  // 30006 suppression is the backstop.
  try {
    let lineType = null;
    const cached = await readCachedLineType(phone);
    if (cached.state === 'hit') {
      lineType = cached.lineType;
    } else if (cached.state === 'miss') {
      lineType = await lookupLineType(phone);
      if (lineType) await cacheLineType(phone, lineType);
    }
    if (lineType === 'landline') {
      await stampStatus(leadId, 'blocked');
      await stampPhoneClaim(phone, 'landline'); // keep — a landline stays a landline
      await logActivity(leadId, 'note', 'Quote-link text-back skipped — caller number is a landline', {
        message_type: MESSAGE_TYPE,
        reason: 'landline',
      });
      logger.info(`[voicemail-sms] Skipping ${maskPhone(phone)} — landline`);
      return { sent: false, skipped: 'landline' };
    }
  } catch (e) {
    logger.warn(`[voicemail-sms] line-type pre-check failed (continuing): ${e.message}`);
  }

  // Prefill link. No secret configured → no token → no link worth sending.
  const token = mintLeadPrefillToken(leadId);
  if (!token) {
    await stampStatus(leadId, 'failed');
    await releasePhoneClaim(phone); // config failure — never consumed the one-shot
    logger.warn('[voicemail-sms] No prefill token secret configured — skipping (fail closed)');
    return { sent: false, skipped: 'no_token_secret' };
  }
  // The token rides in the URL FRAGMENT: fragments are never sent to the
  // server (no morgan/Railway log line, no Referer leak) and survive the
  // short-link 302 because the Location target carries them verbatim.
  const longUrl = `${PORTAL_BASE_URL}/estimate#vlead=${encodeURIComponent(leadId)}&vt=${encodeURIComponent(token)}`;
  const quoteUrl = await shortenOrPassthrough(longUrl, {
    kind: 'quote_prefill',
    entityType: 'leads',
    entityId: leadId,
  });

  const firstName = capitalizeName(extracted.first_name);
  const serviceLabel = String(extracted.matched_service || extracted.requested_service || '').trim()
    || 'pest control';
  const body = await renderSmsTemplate(MESSAGE_TYPE, {
    first_name: firstName || 'there',
    service_label: serviceLabel,
    quote_url: quoteUrl,
  }, {
    workflow: MESSAGE_TYPE,
    entity_type: 'lead',
    entity_id: leadId,
  });
  if (!body) {
    // Template missing or admin-disabled — respect the kill switch. Release
    // the phone claim: re-enabling the template should let a LATER voicemail
    // from this prospect get its text.
    await stampStatus(leadId, 'blocked');
    await releasePhoneClaim(phone);
    logger.info(`[voicemail-sms] Template ${MESSAGE_TYPE} missing/disabled — text-back skipped for lead ${leadId}`);
    return { sent: false, skipped: 'template_disabled' };
  }

  const result = await sendCustomerMessage({
    to: phone,
    body,
    channel: 'sms',
    audience: 'lead',
    purpose: 'missed_call_followup',
    leadId,
    identityTrustLevel: 'phone_provided_unverified',
    consentBasis: { status: 'transactional_allowed', source: 'voicemail_text_back' },
    entryPoint: 'voicemail_lead_sms',
    metadata: {
      original_message_type: MESSAGE_TYPE,
      call_sid: call.twilio_call_sid || null,
    },
  });

  if (result.sent) {
    await stampStatus(leadId, 'sent');
    await stampPhoneClaim(phone, 'sent');
    await logActivity(leadId, 'sms_sent', `Auto-texted quote link after voicemail to ${maskPhone(phone)}`, {
      message_type: MESSAGE_TYPE,
      quote_url: quoteUrl,
      call_sid: call.twilio_call_sid || null,
    });
    logger.info(`[voicemail-sms] Quote link texted to ${maskPhone(phone)} for lead ${leadId}`);
    return { sent: true };
  }

  // Quiet-hours hold (evening/holiday voicemail) or transient provider
  // failure → re-queue onto the scheduled-SMS rail for the next allowed time.
  if (result.retryable && result.nextAllowedAt) {
    try {
      await db('sms_log').insert({
        customer_id: null,
        direction: 'outbound',
        from_phone: TWILIO_NUMBERS.getOutboundNumber(),
        to_phone: phone,
        message_body: body,
        status: 'scheduled',
        scheduled_for: new Date(result.nextAllowedAt),
        message_type: MESSAGE_TYPE,
        metadata: JSON.stringify({
          entry_point: 'voicemail_lead_sms_deferred',
          lead_id: leadId,
          call_sid: call.twilio_call_sid || null,
          original_block_code: result.code || null,
          // The scheduled-SMS cron replays this row through sendCustomerMessage,
          // and an anonymous-lead transactional send only clears the consent
          // validator when the consentBasis rides along — persist it so the
          // deferred send carries the same basis as the immediate one.
          consent_basis: { status: 'transactional_allowed', source: 'voicemail_text_back' },
        }),
      });
      await stampStatus(leadId, 'scheduled');
      await stampPhoneClaim(phone, 'scheduled');
      await logActivity(leadId, 'note',
        `Quote-link text-back queued for ${new Date(result.nextAllowedAt).toISOString()} (${result.code || 'hold'})`,
        { message_type: MESSAGE_TYPE, code: result.code || null });
      logger.info(`[voicemail-sms] Text-back for lead ${leadId} deferred to ${result.nextAllowedAt} (${result.code || 'hold'})`);
      return { sent: false, scheduled: true, nextAllowedAt: result.nextAllowedAt };
    } catch (queueErr) {
      logger.error(`[voicemail-sms] Re-queue failed for lead ${leadId}: ${queueErr.message}`);
      await stampStatus(leadId, 'failed');
      await releasePhoneClaim(phone); // transient failure — one-shot not consumed
      return { sent: false, skipped: 'requeue_failed' };
    }
  }

  // Terminal block: suppression (STOP), no consent, landline validator, etc.
  // Keep both claims — a blocked prospect must not be retried.
  await stampStatus(leadId, 'blocked');
  await stampPhoneClaim(phone, result.code || 'blocked');
  await logActivity(leadId, 'note', `Quote-link text-back blocked: ${result.code || 'unknown'}`, {
    message_type: MESSAGE_TYPE,
    code: result.code || null,
    reason: result.reason || null,
  });
  logger.info(`[voicemail-sms] Text-back blocked for lead ${leadId}: ${result.code || 'unknown'}`);
  return { sent: false, skipped: result.code || 'blocked' };
}

module.exports = { sendVoicemailQuoteLink, MESSAGE_TYPE };
