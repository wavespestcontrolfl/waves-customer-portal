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
 *   2. One text per phone number EVER (sms_log message_type check), plus an
 *      atomic per-lead claim on leads.extracted_data so concurrent processing
 *      can't double-send.
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
 * The link carries a lead-prefill HMAC token (utils/lead-prefill-token.js):
 * the wizard exchanges it for the lead's own contact fields and attaches its
 * submission to the SAME lead row — prefill/attach authority only, never
 * identity or pricing.
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

async function sendVoicemailQuoteLink({ leadId, extracted = {}, call = {}, phone } = {}) {
  if (!isEnabled('voicemailLeadSms')) {
    logger.info(`[voicemail-sms] Gate off — text-back skipped for lead ${leadId || 'unknown'}`);
    return { sent: false, skipped: 'gate_off' };
  }
  if (!leadId || !phone) return { sent: false, skipped: 'missing_input' };

  // One text per phone number, ever — covers duplicate lead rows on the same
  // phone and a reused lead whose claim marker was overwritten by a later
  // enrichment pass. A 'scheduled' rail row counts as sent.
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

  // Atomic per-lead claim: only the caller whose UPDATE affects a row proceeds.
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
    logger.warn('[voicemail-sms] No prefill token secret configured — skipping (fail closed)');
    return { sent: false, skipped: 'no_token_secret' };
  }
  const longUrl = `${PORTAL_BASE_URL}/estimate?vlead=${encodeURIComponent(leadId)}&vt=${encodeURIComponent(token)}`;
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
    // Template missing or admin-disabled — respect the kill switch.
    await stampStatus(leadId, 'blocked');
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
        }),
      });
      await stampStatus(leadId, 'scheduled');
      await logActivity(leadId, 'note',
        `Quote-link text-back queued for ${new Date(result.nextAllowedAt).toISOString()} (${result.code || 'hold'})`,
        { message_type: MESSAGE_TYPE, code: result.code || null });
      logger.info(`[voicemail-sms] Text-back for lead ${leadId} deferred to ${result.nextAllowedAt} (${result.code || 'hold'})`);
      return { sent: false, scheduled: true, nextAllowedAt: result.nextAllowedAt };
    } catch (queueErr) {
      logger.error(`[voicemail-sms] Re-queue failed for lead ${leadId}: ${queueErr.message}`);
      await stampStatus(leadId, 'failed');
      return { sent: false, skipped: 'requeue_failed' };
    }
  }

  // Terminal block: suppression (STOP), no consent, landline validator, etc.
  // Keep the claim — a blocked prospect must not be retried.
  await stampStatus(leadId, 'blocked');
  await logActivity(leadId, 'note', `Quote-link text-back blocked: ${result.code || 'unknown'}`, {
    message_type: MESSAGE_TYPE,
    code: result.code || null,
    reason: result.reason || null,
  });
  logger.info(`[voicemail-sms] Text-back blocked for lead ${leadId}: ${result.code || 'unknown'}`);
  return { sent: false, skipped: result.code || 'blocked' };
}

module.exports = { sendVoicemailQuoteLink, MESSAGE_TYPE };
