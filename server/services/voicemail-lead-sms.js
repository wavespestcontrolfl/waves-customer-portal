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
 *      (transactional basis — they called us about service).
 *      A transient provider failure re-queues onto the
 *      scheduled-SMS rail (status='scheduled' + scheduled_for) so the
 *      voicemail still gets its text on a later tick instead of never.
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
const { isRealProviderSend } = require('./sms-auto-send');
const { renderSmsTemplate } = require('./sms-template-renderer');
const { readCachedLineType, cacheLineType, lookupLineType, NON_SMS_LINE_TYPES } = require('./messaging/validators/line-type');
const { mintLeadPrefillToken } = require('../utils/lead-prefill-token');
// createShortCode (NOT shortenOrPassthrough): the prefill link carries a
// bearer token, so a shorten failure must fail closed — never fall back to
// putting the long tokenized URL in an SMS body. See the call site.
const { createShortCode } = require('./short-url');
const { autoTextHoldReason } = require('./messaging/auto-text-holds');

const MESSAGE_TYPE = 'voicemail_quote_link';
const PORTAL_BASE_URL = 'https://portal.wavespestcontrol.com';

function maskPhone(value) {
  const digits = String(value || '').replace(/\D/g, '');
  return digits ? `***${digits.slice(-4)}` : 'unknown';
}

// Same normalization sendCustomerMessage applies to its recipient
// (normalizeRecipient) — the caller can hand us Twilio's E.164 caller ID or
// an AI-extracted 10-digit/formatted callback, and the one-shot claim key,
// the sms_log history check, and the pipeline-written sms_log rows must all
// agree on ONE shape or the same prospect can be claimed twice.
function normalizePhoneE164(raw) {
  const trimmed = String(raw || '').trim();
  if (!trimmed) return null;
  const digits = trimmed.replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  if (trimmed.startsWith('+')) return trimmed;
  return trimmed;
}

function capitalizeName(name) {
  const trimmed = String(name || '').trim();
  if (!trimmed) return '';
  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
}

// Stamp the one-shot status onto the lead's extracted_data jsonb. Best-effort
// for the inline send path (the durable dedupe is the sms_log row, this is
// the visible breadcrumb, and the atomic claim below is what prevents a
// concurrent double-send) — but returns success so the deferred-replay
// finalize can ride the durable retry rail instead of swallowing a
// transient DB failure as settled.
async function stampStatus(leadId, status) {
  try {
    await db('leads').where({ id: leadId }).update({
      extracted_data: db.raw(
        "jsonb_set(COALESCE(extracted_data, '{}'::jsonb), '{quote_link_sms_status}', to_jsonb(?::text))",
        [status]
      ),
      updated_at: new Date(),
    });
    return true;
  } catch (e) {
    logger.warn(`[voicemail-sms] status stamp failed for lead ${leadId}: ${e.message}`);
    return false;
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
    return true;
  } catch (e) {
    logger.warn(`[voicemail-sms] phone claim release failed for ${maskPhone(phone)}: ${e.message}`);
    return false;
  }
}

// Stamp the final outcome on the kept claim row (the row's existence is the
// dedupe; the outcome column drives the bounce handler's claimed-lead
// correlation and the admin breadcrumb). Returns success for the same
// durable-finalize reason as stampStatus above.
async function stampPhoneClaim(phone, outcome) {
  try {
    await db('voicemail_sms_claims').where({ phone }).update({ outcome });
    return true;
  } catch (e) {
    logger.warn(`[voicemail-sms] phone claim stamp failed for ${maskPhone(phone)}: ${e.message}`);
    return false;
  }
}

// Reset the per-lead one-shot marker alongside a phone-claim release. The
// call pipeline reuses the same open lead row for a repeat caller, so leaving
// a 'blocked'/'failed' stamp here would make the retry lose the per-lead
// claim ('already_claimed') right after re-taking the phone claim — wedging
// the phone as consumed with no text ever sent. Release always clears BOTH.
async function clearLeadClaim(leadId) {
  try {
    await db('leads').where({ id: leadId }).update({
      extracted_data: db.raw("COALESCE(extracted_data, '{}'::jsonb) - 'quote_link_sms_status'"),
      updated_at: new Date(),
    });
    return true;
  } catch (e) {
    logger.warn(`[voicemail-sms] lead claim clear failed for lead ${leadId}: ${e.message}`);
    return false;
  }
}

// The shared hold check's options for this voicemail (the early check and
// the recheck at the provider boundary): its own call opens the
// recent-conversation window and is read by id (the text may go to a spoken
// callback number that call's row does not carry), and the lane's own texts
// are its one-shot's business, not a conversation.
function holdOptions(call) {
  return {
    callAt: call.created_at ? new Date(call.created_at) : new Date(),
    originCallId: call.id || null,
    excludeMessageTypes: [MESSAGE_TYPE],
  };
}

// The provider-boundary hold refusal's code, read back off the send result.
const HELD_AT_BOUNDARY = 'VOICEMAIL_TEXT_HELD';

async function sendVoicemailQuoteLink({ leadId, extracted = {}, call = {}, phone: rawPhone, doNotContactRequested = false } = {}) {
  if (!isEnabled('voicemailLeadSms')) {
    logger.info(`[voicemail-sms] Gate off — text-back skipped for lead ${leadId || 'unknown'}`);
    return { sent: false, skipped: 'gate_off' };
  }
  const phone = normalizePhoneE164(rawPhone);
  if (!leadId || !phone) return { sent: false, skipped: 'missing_input' };

  // Belt-and-suspenders history check: pre-claim-table sends (or hand-sent
  // rows tagged with the message_type) also consume the one-shot. Advisory
  // only for ordering — the ATOMIC gate is the claim insert below. Every
  // quote-link row counts, whatever its status: a queued replay that ended
  // 'blocked' cannot be proven never sent from the row (a retry-exhausted
  // provider timeout ends 'blocked' too), so a replay held or refused at
  // 8 AM uses up the number's one automated quote link just like a sent
  // one. A hold on the immediate path writes no row and consumes nothing.
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

  // Who never gets this automated text (owner rulings 2026-09-27): someone
  // who asked in this voicemail not to be contacted, or — per the shared
  // messaging/auto-text-holds.js — who already has a quote or estimate, has
  // an open lead a staff member is working, asked on an earlier call not to
  // be contacted, showed on an earlier call to be a salesperson / vendor /
  // robocall / wrong number / job applicant, or texted with us in the last 7
  // days. Checked BEFORE the claim, so a hold never consumes the one-shot;
  // an unreadable check fails closed. A deferred send re-runs the same check
  // at replay (deferred-replay-registry.js voicemail_lead_sms_deferred).
  if (doNotContactRequested) return { sent: false, skipped: 'asked_not_to_be_contacted' };
  try {
    const hold = await autoTextHoldReason(phone, holdOptions(call));
    if (hold) {
      logger.info(`[voicemail-sms] Text-back held for lead ${leadId}: ${hold}`);
      return { sent: false, skipped: hold };
    }
  } catch (e) {
    logger.warn(`[voicemail-sms] hold check failed — skipping (fail closed): ${e.message}`);
    return { sent: false, skipped: 'hold_check_failed' };
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
    // An unexpected throw never consumed the one-shot — release BOTH claims
    // so a later voicemail can retry — then rethrow into the caller's
    // non-blocking catch. (Clearing an un-taken lead claim is a no-op.)
    await clearLeadClaim(leadId);
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
    if (NON_SMS_LINE_TYPES.has(lineType)) {
      if (lineType === 'landline') {
        await stampStatus(leadId, 'blocked');
        await stampPhoneClaim(phone, 'landline'); // keep — a landline stays a landline
      } else {
        // fixedVoip is a REVERSIBLE block (LINETYPE_BLOCK_FIXED_VOIP): no text
        // was sent, so releasing BOTH claims keeps the one-text-per-phone
        // invariant while letting a future voicemail re-evaluate under the
        // then-current set. A 'blocked' lead stamp would wedge the reused open
        // lead row at the claim predicate; the activity note is the audit
        // trail instead.
        await clearLeadClaim(leadId);
        await releasePhoneClaim(phone);
      }
      await logActivity(leadId, 'note', `Quote-link text-back skipped — caller number is a ${lineType}`, {
        message_type: MESSAGE_TYPE,
        reason: lineType,
      });
      logger.info(`[voicemail-sms] Skipping ${maskPhone(phone)} — ${lineType}`);
      return { sent: false, skipped: lineType };
    }
  } catch (e) {
    logger.warn(`[voicemail-sms] line-type pre-check failed (continuing): ${e.message}`);
  }

  // Prefill link. No secret configured → no token → no link worth sending.
  const token = mintLeadPrefillToken(leadId);
  if (!token) {
    // Config failure — never consumed the one-shot: release BOTH claims so a
    // later voicemail (usually reusing this same lead row) can retry.
    await clearLeadClaim(leadId);
    await releasePhoneClaim(phone);
    logger.warn('[voicemail-sms] No prefill token secret configured — skipping (fail closed)');
    return { sent: false, skipped: 'no_token_secret' };
  }
  // The token rides in the URL FRAGMENT: fragments are never sent to the
  // server (no morgan/Railway log line, no Referer leak) and survive the
  // short-link 302 because the Location target carries them verbatim.
  const longUrl = `${PORTAL_BASE_URL}/quote#vlead=${encodeURIComponent(leadId)}&vt=${encodeURIComponent(token)}`;
  // Fail CLOSED if the shortener can't mint a code — shortenOrPassthrough's
  // long-URL fallback is unsafe for THIS link: the fallback body would carry
  // the 14-day bearer token, and the send path persists rendered bodies in
  // plaintext (sms_log, messaging-audit previews) besides handing them to
  // Twilio. Only the opaque short code may leave this function. A shortener
  // failure is transient (DB insert) and never consumed the one-shot, so
  // release BOTH claims for a later retry.
  let quoteUrl;
  try {
    ({ shortUrl: quoteUrl } = await createShortCode(longUrl, {
      kind: 'quote_prefill',
      entityType: 'leads',
      entityId: leadId,
      leadId,
      channel: 'sms',
      purpose: 'voicemail_quote',
    }));
  } catch (shortErr) {
    await clearLeadClaim(leadId);
    await releasePhoneClaim(phone);
    logger.error(`[voicemail-sms] Short-code creation failed — text-back skipped for lead ${leadId} (bearer URL never falls back into an SMS): ${shortErr.message}`);
    return { sent: false, skipped: 'short_link_failed' };
  }

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
    // BOTH claims: re-enabling the template should let a LATER voicemail from
    // this prospect (usually reusing this same lead row) get its text.
    await clearLeadClaim(leadId);
    await releasePhoneClaim(phone);
    logger.info(`[voicemail-sms] Template ${MESSAGE_TYPE} missing/disabled — text-back skipped for lead ${leadId}`);
    return { sent: false, skipped: 'template_disabled' };
  }

  // Recheck the holds at the provider boundary — Twilio runs this after
  // every other await, immediately before its request: the claims, the
  // landline lookup, the short link, the render and the pipeline's own
  // checks all awaited since the first check, and a text exchanged, a lead
  // assigned or an estimate sent meanwhile still stops it. Which hold fired
  // is kept here; an unreadable check fails closed.
  const boundary = { hold: null };
  const providerPreSendCheck = async ({ dbi } = {}) => {
    try {
      boundary.hold = await autoTextHoldReason(phone, { ...holdOptions(call), ...(dbi ? { dbi } : {}) });
    } catch (e) {
      logger.warn(`[voicemail-sms] boundary hold recheck failed — holding the text (fail closed): ${e.message}`);
      boundary.hold = 'hold_check_failed';
    }
    return boundary.hold ? { ok: false, code: HELD_AT_BOUNDARY, reason: boundary.hold } : { ok: true };
  };

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
    providerPreSendCheck,
    metadata: {
      original_message_type: MESSAGE_TYPE,
      call_sid: call.twilio_call_sid || null,
    },
  });

  // A hold at the boundary never consumed the one-shot — release both claims.
  if (!result.sent && result.code === HELD_AT_BOUNDARY) {
    await clearLeadClaim(leadId);
    await releasePhoneClaim(phone);
    logger.info(`[voicemail-sms] Text-back held at the provider boundary for lead ${leadId}: ${boundary.hold}`);
    return { sent: false, skipped: boundary.hold || 'held' };
  }

  if (result.sent && !isRealProviderSend(result)) {
    // Upstream suppression sentinel (SMS gate off, template disabled, owner
    // kill switch) — sent:true but no text left. Same handling as the
    // dropped-call lane: never consume the one-shot; release BOTH claims so
    // the lead is not stamped "texted" forever while the gate is off.
    await clearLeadClaim(leadId);
    await releasePhoneClaim(phone);
    logger.info(`[voicemail-sms] Suppression sentinel for ${maskPhone(phone)} (${result.providerMessageId || 'no-id'}) — released, not sent`);
    return { sent: false, skipped: 'send_suppressed', code: result.providerMessageId || null };
  }
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

  // Transient provider
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
          // Replay lifecycle keys (deferred-replay registry): finalize
          // stamps both claims 'sent'; onTerminal releases them so a
          // repeat caller can re-arm. The phone already lives in the
          // row's to_phone column — this copy just reaches the hooks.
          voicemail_phone: phone,
          call_sid: call.twilio_call_sid || null,
          // The originating call, for the replay's hold recheck: read by id
          // (the text may go to a spoken callback number its row does not
          // carry), and its time opens the recent-conversation window.
          call_log_id: call.id || null,
          call_created_at: call.created_at || null,
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
      // Transient failure — one-shot not consumed; release BOTH claims.
      await clearLeadClaim(leadId);
      await releasePhoneClaim(phone);
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

/**
 * Delivery-status bounce handler (wired into the Twilio /status callback).
 * A bounced quote-link text (30006 = landline is the common case) means the
 * lead has had NO successful first contact — the send looked fine at send
 * time, so nothing else surfaces it and the lead sits silently cold
 * (observed 2026-07-17: undelivered text-back, lead untouched). Pull the
 * lead's follow-up to NOW and leave a call-instead breadcrumb on the
 * timeline. Best-effort by contract: never throws, touches only a still-new
 * lead, and only pulls next_follow_up_at EARLIER (never pushes one out).
 */
async function handleUndeliveredQuoteLink({ sid, status, errorCode, to } = {}) {
  try {
    if (!sid) return { handled: false, reason: 'no_sid' };
    const row = await db('sms_log')
      .where({ twilio_sid: sid, message_type: MESSAGE_TYPE, direction: 'outbound' })
      .first('id', 'to_phone');
    if (!row) return { handled: false, reason: 'not_quote_link' };
    const phone = normalizePhoneE164(to || row.to_phone);
    if (!phone) return { handled: false, reason: 'no_phone' };

    // ONE transaction for the idempotency claim + every remediation write:
    // a transient failure mid-remediation rolls the claim back too, so the
    // Twilio callback retry re-processes instead of short-circuiting on a
    // burned claim with the lead never touched. Deterministic no-op outcomes
    // (no open lead to stamp) COMMIT the claim — a retry can't change them.
    return await db.transaction(async (trx) => {
      // Idempotency claim: Twilio retries status callbacks, and a second
      // pass would re-pull a follow-up an operator may have deliberately
      // moved later, plus duplicate the timeline note. One atomic
      // conditional UPDATE stamping the sms_log row is the claim — zero
      // rows = already handled. jsonb_exists(), not the ? operator (knex
      // reads ? as a binding).
      const claimed = await trx('sms_log')
        .where({ id: row.id })
        .whereRaw("NOT jsonb_exists(COALESCE(metadata, '{}'::jsonb), 'quote_link_bounce_handled_at')")
        .update({
          metadata: trx.raw("COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('quote_link_bounce_handled_at', to_jsonb(now()::text))"),
          updated_at: new Date(),
        });
      if (!claimed) return { handled: false, reason: 'already_handled' };

      // Correlate through the one-shot claim row (phone PK → the exact lead
      // this text went to), not phone+recency — duplicate/reopened leads can
      // share a number and the newest 'new' lead may not be the originator
      // (Codex pre-push P1). The claim row persists on consumed outcomes
      // (sent/scheduled), which are the only ones that can bounce.
      const claim = await trx('voicemail_sms_claims').where({ phone }).first('lead_id');
      let lead = null;
      if (claim) {
        // The claim names the exact lead this text went to. If that lead is
        // no longer open (contacted/converted/deleted before a delayed
        // bounce arrived), STOP — falling back to phone+recency here could
        // stamp an unrelated newer lead sharing the number.
        if (!claim.lead_id) return { handled: false, reason: 'claim_without_lead' };
        lead = await trx('leads')
          .where('id', claim.lead_id)
          .where('status', 'new')
          .whereNull('deleted_at')
          .first('id', 'next_follow_up_at');
        if (!lead) return { handled: false, reason: 'claimed_lead_not_open' };
      } else {
        // No claim row at all (pre-claims-table sends) — newest still-new
        // recent lead on this phone as the fallback.
        lead = await trx('leads')
          .where('phone', phone)
          .where('status', 'new')
          .whereNull('deleted_at')
          .where('created_at', '>=', new Date(Date.now() - 14 * 24 * 60 * 60 * 1000))
          .orderBy('created_at', 'desc')
          .first('id', 'next_follow_up_at');
        if (!lead) return { handled: false, reason: 'no_open_lead' };
      }

      const now = new Date();
      // Single guarded UPDATE, not read-then-write: only pull the follow-up
      // in when none exists or the existing one is LATER — a concurrent
      // operator edit to an earlier date must never be pushed back to now.
      // Zero updated rows just means it's already earlier.
      await trx('leads')
        .where({ id: lead.id })
        .where(function followUpMissingOrLater() {
          this.whereNull('next_follow_up_at').orWhere('next_follow_up_at', '>', now);
        })
        .update({ next_follow_up_at: now, updated_at: now });
      // Inline (trx-bound) versions of stampStatus/logActivity — the shared
      // helpers write through the global db and would escape the rollback.
      await trx('leads').where({ id: lead.id }).update({
        extracted_data: trx.raw(
          "jsonb_set(COALESCE(extracted_data, '{}'::jsonb), '{quote_link_sms_status}', to_jsonb(?::text))",
          ['undelivered']
        ),
        updated_at: now,
      });
      const codeText = String(errorCode || '') === '30006'
        ? 'error 30006 — landline, this number cannot receive SMS'
        : `status ${status}${errorCode ? `, error ${errorCode}` : ''}`;
      await trx('lead_activities').insert({
        lead_id: lead.id,
        activity_type: 'note',
        description: `Quote-link text-back never arrived (${codeText}). Call the lead instead.`,
        performed_by: 'AI Call Processor',
        metadata: JSON.stringify({ message_type: MESSAGE_TYPE, delivery_status: status || null, error_code: errorCode || null }),
      });
      logger.info(`[voicemail-sms] Undelivered quote link for lead ${lead.id} (${maskPhone(phone)}) — follow-up pulled to now`);
      return { handled: true, leadId: lead.id };
    });
  } catch (e) {
    logger.warn(`[voicemail-sms] undelivered quote-link handling failed: ${e.message}`);
    return { handled: false, reason: 'error' };
  }
}

module.exports = { sendVoicemailQuoteLink, handleUndeliveredQuoteLink, MESSAGE_TYPE };
// Deferred-replay registry hooks — settle the lead/phone claims when the
// scheduled executor delivers or terminally fails the queued text-back.
module.exports._deferredClaims = { stampStatus, stampPhoneClaim, clearLeadClaim, releasePhoneClaim };
