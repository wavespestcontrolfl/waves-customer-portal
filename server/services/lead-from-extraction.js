/**
 * createLeadFromExtraction — shared lead writer for AI-captured inbound calls.
 *
 * Used by the bilingual voice-agent webhook (routes/webhooks-voice-agent.js).
 * It mirrors the lead insert / empty-only enrich / ai-triage activity shape of
 * the voicemail pipeline in call-recording-processor.js (processRecording), so
 * an agent-captured lead is indistinguishable from a transcribed-voicemail lead
 * in the Leads UI. Only columns that the voicemail path already writes are
 * touched here (plus preferred_language, added by migration
 * 20260626000000) — no schema guessing.
 *
 * Self-contained on purpose: the voicemail path's customer-creation and lead
 * logic is left byte-for-byte untouched (the #1 requirement is not to
 * destabilize the live call path), so this module re-implements only the small
 * phone-match lookup it needs rather than importing internals. It links an
 * existing customer when one unambiguously matches but never creates a
 * customer — the lead is the capture artifact; conversion stays a human step.
 *
 * CONTACT PREFERENCE / CONSENT (Phase E): a caller who says "stop texting me",
 * "call my husband, not me", or "email only" mid-call has stated something that
 * must not evaporate. Those three fields ride `extracted_data` (and the
 * ai_triage activity metadata) so a human sees them on the lead:
 *   - contact_preference        — the caller's own words, verbatim
 *   - preferred_contact_method  — 'phone' | 'sms' | 'email' | 'unspecified'
 *   - do_not_contact_request    — boolean
 * The key names and the enum deliberately MIRROR the call-extraction schemas'
 * existing shape (caller.preferred_contact_method, consent.do_not_contact_request
 * in server/schemas/call-extraction.{model-output,persisted}.schema.json) so the
 * two capture surfaces speak the same vocabulary. This module does NOT extend
 * those JSON schemas: they describe the RECORDED-CALL extraction contract, no
 * relay field flows through them, and any key added there bumps
 * validate-extraction.SCHEMA_VERSION + the prompt contract hash and re-cohorts
 * the promotion-readiness gate.
 *
 * CAPTURED, NEVER ACTED ON. Nothing here (or anywhere in the voice agent)
 * writes an opt-out, a messaging preference, or a suppression from a stated
 * preference — a human actions it. The only customer-row write in this module
 * remains the empty-only preferred_language hint.
 *
 * Core lead writes PROPAGATE on failure (the caller — the agent webhook —
 * returns 5xx so ElevenLabs retries). Unlike the voicemail path there is no
 * persisted recording/transcript to replay, so a swallowed DB error would
 * silently lose the only copy of the lead. Secondary writes (customer language
 * hint, activity log) stay best-effort.
 */
const db = require('../models/db');
const logger = require('./logger');
const { properCase } = require('../utils/name-case');
const { composeServiceInterest } = require('../utils/lead-service-interest');

const isEmpty = (v) => v === null || v === undefined || v === '';

/** jsonb column → plain object ({} for null / string-encoded / array / garbage). */
function parseJsonObject(value) {
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

// Mirrors caller.preferred_contact_method in the call-extraction schemas.
const CONTACT_METHODS = new Set(['phone', 'sms', 'email', 'unspecified']);

/**
 * The stated contact preference / consent instruction, normalized for storage.
 * Returns null when the caller said nothing about it, so a later payload with
 * no preference can never blank one already recorded.
 */
function contactPreferenceFields(extracted = {}) {
  const note = extracted.contact_preference == null ? '' : String(extracted.contact_preference).trim().slice(0, 300);
  const method = String(extracted.preferred_contact_method || '').trim().toLowerCase();
  const dnc = extracted.do_not_contact_request === true;
  if (!note && !CONTACT_METHODS.has(method) && !dnc) return null;
  return {
    contact_preference: note || null,
    preferred_contact_method: CONTACT_METHODS.has(method) ? method : null,
    do_not_contact_request: dnc,
  };
}

/**
 * A stated contact instruction from a caller who is an EXISTING lifecycle
 * customer — the one case with no lead row to record it on.
 *
 * Nothing here writes consent, suppression or messaging-preference state (the
 * voice agent never does — that stays a human decision). This only makes sure
 * the instruction REACHES a human: the same internal admin notification feed
 * the re-service lane files to, on the customer's own deep link. Internal-only
 * and fail-open by contract — the caller is on the line and a notification
 * hiccup can never surface to them.
 */
async function surfaceContactInstructionForCustomer(customer, extracted = {}, opts = {}) {
  const instruction = contactPreferenceFields(extracted);
  if (!customer || !customer.id || !instruction) return false;
  const dnc = instruction.do_not_contact_request === true;
  const result = await fileContactInstructionNotification(customer, instruction, opts, dnc);
  const surfaced = result.persisted;
  // ⭐ A FAILED COMPLIANCE ARTIFACT GETS A RETRY RAIL. This feed row is the
  // ONLY structured artifact for a lifecycle customer's stated instruction —
  // a notifyAdmin hiccup here silently lost a "stop texting me" with nothing
  // left to find it. Same rail as the hot-alert page: a durable obligation
  // marker on the call's own call_log row, recovered by the hourly sweep.
  // The sweep's own retries never re-stamp (the marker is already there), and
  // a SUPPRESSED result stamps nothing: suppression is the internal-test
  // customer gate's deliberate zero-artifact decision, not a delivery failure
  // — an obligation for it would just be cleared by the sweep's first pass.
  if (!surfaced && !result.suppressed && !opts.sweepRetry && opts.callSid) {
    try {
      await db('call_log')
        .where({ twilio_call_sid: opts.callSid })
        .update({
          metadata: db.raw(
            "COALESCE(metadata, '{}'::jsonb) || ?::jsonb",
            [JSON.stringify({
              relay_contact_instruction_needed: 'true',
              relay_contact_instruction: {
                customerId: customer.id,
                smsSuppressionApplied: opts.smsSuppressionApplied === true,
                ...instruction,
              },
            })],
          ),
        });
    } catch (stampErr) {
      logger.error(`[voice-agent-lead] contact-instruction obligation stamp ALSO failed callSid=${opts.callSid}: ${stampErr.message}`);
    }
  }
  return surfaced;
}

async function fileContactInstructionNotification(customer, instruction, opts, dnc) {
  try {
    const NotificationService = require('./notification-service');
    const notif = await NotificationService.notifyAdmin(
      'service',
      `${dnc ? '🚫 DO-NOT-CONTACT request' : '📞 Contact preference'} stated on a phone call`,
      [
        // ⭐ THE ALERT TELLS THE TRUTH ABOUT WHAT ALREADY HAPPENED. The voice
        // agent applies an explicit, verified SMS opt-out itself (the one write
        // it makes — relay-tools, via recordSuppression); telling staff
        // "nothing was changed" over a suppression that already landed reports
        // a false compliance state in the exact place they check it. Everything
        // BEYOND that write (email, broader preferences) is still theirs.
        dnc && opts.smsSuppressionApplied
          ? 'The caller asked NOT to be contacted. Automated TEXTS to their number are ALREADY STOPPED '
            + '(the voice agent applied the SMS opt-out). Any email or broader preference still needs a human — review and action the rest.'
          : null,
        dnc && !opts.smsSuppressionApplied
          ? 'The caller asked NOT to be contacted. Nothing was changed automatically — review and action it.'
          : null,
        instruction.preferred_contact_method ? `Preferred method: ${instruction.preferred_contact_method}.` : null,
        instruction.contact_preference ? `In their words: "${instruction.contact_preference}"` : null,
      ].filter(Boolean).join('\n'),
      {
        icon: dnc ? '🚫' : '📞',
        link: `/admin/customers?customerId=${encodeURIComponent(customer.id)}`,
        // ⭐ THIS ROW IS THE ONLY ARTIFACT. A lifecycle customer gets no lead, so
        // a stated contact instruction lives nowhere but this feed row — and the
        // admin bell policy silences the whole 'service' category by default
        // when it is on, which would have made a caller's "email only" (or the
        // DNC's paper trail) vanish without a sound. `bell: true` is the
        // policy's own site-level tag for "this specific notification must
        // ring": a consent instruction is compliance, not FYI noise.
        bell: true,
        metadata: {
          customerId: customer.id,
          source: 'voice_agent',
          callSid: opts.callSid || null,
          ...instruction,
        },
      },
    );
    // ⭐ SUPPRESSED IS NOT PERSISTED. notifyAdmin's suppression sentinel is
    // truthy on purpose (`{ id: null, suppressed: true }`), so a bare truthiness
    // check here read "no row was written" as success. With `bell: true` the
    // policy can no longer silence this site, so a suppressed return means the
    // internal-test-customer gate — deliberate, but still zero artifact, and
    // this function must never claim otherwise.
    if (!notif || notif.suppressed) {
      logger.error(`[voice-agent-lead] contact instruction for customer ${customer.id} did NOT persist to the admin feed (dnc=${dnc}${notif && notif.suppressed ? `, suppressed:${notif.reason || 'internal_test'}` : ''})`);
      return { persisted: false, suppressed: !!(notif && notif.suppressed) };
    }
    logger.info(`[voice-agent-lead] contact instruction surfaced for existing customer ${customer.id} (dnc=${dnc})`);
    return { persisted: true, suppressed: false };
  } catch (err) {
    logger.error(`[voice-agent-lead] contact instruction surfacing FAILED for customer ${customer.id}: ${err.message}`);
    return { persisted: false, suppressed: false };
  }
}

const phoneDigits = (v) => String(v || '').replace(/\D/g, '');
const nameCase = (v) => (v && String(v).trim() ? properCase(String(v).trim()) : null);

// Mirror call-recording-processor's lead-creation guard: only these lifecycle
// stages may be (re)opened as a lead from a call. Active/won/churned customers
// are NOT reopened as fresh leads from an ordinary support call.
const LEAD_PIPELINE_STAGES = new Set([
  'new_lead', 'contacted', 'qualified', 'estimate_needed', 'estimate_draft',
  'estimate_sent', 'estimate_viewed', 'follow_up', 'negotiating',
]);
const isLeadStage = (stage) => LEAD_PIPELINE_STAGES.has(String(stage || '').toLowerCase());

const normName = (v) => String(v || '').toLowerCase().replace(/[^a-z0-9]/g, '');
// True only when BOTH a captured first name and the customer's first name are
// present AND they differ — i.e. likely a different person on a shared line, so
// we shouldn't link the call/lead to that customer.
function nameConflicts(extracted, customer) {
  const ex = normName(extracted && extracted.first_name);
  const cust = normName(customer && customer.first_name);
  if (!ex || !cust) return false;
  return ex !== cust;
}

function maskPhone(value) {
  const d = phoneDigits(value);
  return d ? `***${d.slice(-4)}` : 'unknown';
}

function lookupKey(value) {
  const d = phoneDigits(value);
  if (d.length === 11 && d.startsWith('1')) return d.slice(1);
  return d;
}

// Single unambiguous customer match by phone, mirroring the 10-digit RIGHT-match
// used in call-recording-processor + twilio-voice-webhook. Returns null when
// there is no match or more than one (never auto-links an ambiguous number).
async function findCustomerByPhone(phone) {
  const key = lookupKey(phone);
  if (!key) return null;
  const q = db('customers').whereNull('deleted_at');
  if (key.length === 10) {
    q.whereRaw("RIGHT(regexp_replace(COALESCE(phone, ''), '[^0-9]', '', 'g'), 10) = ?", [key]);
  } else {
    q.whereRaw("regexp_replace(COALESCE(phone, ''), '[^0-9]', '', 'g') = ?", [key]);
  }
  const matches = await q.orderBy('updated_at', 'desc').limit(2);
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    logger.warn(`[voice-agent-lead] ${matches.length} customers share ${maskPhone(phone)}; not auto-linking`);
  }
  return null;
}

// Resolve lead_sources.twilio_phone_number across the hand-entered shapes
// (E.164 / 11-digit / 10-digit / formatted) — mirrors processRecording.
async function resolveLeadSourceId(toPhone) {
  try {
    const digits = phoneDigits(toPhone);
    const ten = digits.length >= 10 ? digits.slice(-10) : null;
    const variants = new Set([toPhone].filter(Boolean));
    if (ten) {
      variants.add(ten);
      variants.add(`1${ten}`);
      variants.add(`+1${ten}`);
      variants.add(`(${ten.slice(0, 3)}) ${ten.slice(3, 6)}-${ten.slice(6)}`);
    }
    if (variants.size === 0) return null;
    const ls = await db('lead_sources')
      .where('is_active', true)
      .whereIn('twilio_phone_number', [...variants])
      .first();
    return ls ? ls.id : null;
  } catch (e) {
    logger.warn(`[voice-agent-lead] lead_source lookup failed: ${e.message}`);
    return null;
  }
}

/**
 * @param {object} extracted  agent-captured fields:
 *   { first_name, last_name, email, address_line1, city, zip,
 *     requested_service|matched_service, preferred_date_time, pain_points,
 *     call_summary, lead_quality ('hot'|'warm'|'cold'),
 *     contact_preference, preferred_contact_method, do_not_contact_request }
 * @param {object} opts { phone, toPhone, callSid, language, callDurationSeconds }
 * @returns {Promise<{ leadId: string|null, customerId: string|null, created: boolean }>}
 */
async function createLeadFromExtraction(extracted = {}, opts = {}) {
  const phone = opts.phone || extracted.phone || null;
  const language = opts.language ? String(opts.language).toLowerCase().slice(0, 8) : null;
  // composeServiceInterest returns the matched service plus any requested
  // families it doesn't cover (multi-service calls), or null when nothing
  // matched — preserving the legacy matched || requested fallback order.
  const service = composeServiceInterest(extracted) || extracted.requested_service || null;

  let customerId = null;
  let leadId = null;
  let created = false;

  // ⭐ IDENTITY CAN BE HANDED IN, AND WHEN IT IS, IT WINS. The voice relay knows
  // WHO is on the call from the ANI cross-check against the signature-verified
  // /voice row — and it may pass a DIFFERENT `phone` here, because the caller
  // gave an alternate callback number (the capture_lead schema asks for one
  // explicitly, e.g. calling from a blocked line). Resolving identity from that
  // alternate number instead would surface this call — and any contact
  // instruction on it — against whoever else owns that number, or mint a fresh
  // lead for a customer we already recognised. `identityCustomerId` keeps the
  // two apart: the matched account is the identity, the phone is only where to
  // call back.
  let customer = opts.identityCustomerId
    ? await db('customers').where({ id: opts.identityCustomerId }).whereNull('deleted_at').first()
    : await findCustomerByPhone(phone);
  // Name-aware guard: on a shared line the phone-only match can resolve the
  // wrong household member. If the agent captured a name that conflicts with the
  // matched customer's, don't link (treat as a new, unlinked caller) rather than
  // attach the call + language hint to the wrong customer.
  // The name guard is for a PHONE match on a shared line; a caller the ANI
  // already authenticated is not a guess to second-guess.
  if (customer && !opts.identityCustomerId && nameConflicts(extracted, customer)) {
    logger.info(`[voice-agent-lead] Captured name conflicts with customer on ${maskPhone(phone)}; not linking`);
    customer = null;
  }
  customerId = customer?.id || null;

  // Non-routing language hint on the matched customer — applied even if the lead
  // is skipped below. Best-effort; only fills when empty so a prior preference
  // is never clobbered. (Routing never reads this column.)
  if (language && customerId) {
    await db('customers')
      .where({ id: customerId })
      .whereRaw("COALESCE(preferred_language, '') = ''")
      .update({ preferred_language: language })
      .catch((e) => logger.warn(`[voice-agent-lead] customer language hint failed (non-blocking): ${e.message}`));
  }

  // Guard FIRST (mirror the voicemail processor): a matched lifecycle customer
  // that isn't in a lead stage gets NO lead work — even if a historical/
  // converted lead exists for this phone (so an ordinary support call can't
  // overwrite a won lead). Brand-new callers (no match) and lead-stage customers
  // proceed below.
  if (customer && !isLeadStage(customer.pipeline_stage)) {
    logger.info(`[voice-agent-lead] Skipping lead for ${maskPhone(phone)} — existing ${customer.pipeline_stage || 'lifecycle'} customer`);
    // …but a stated CONTACT INSTRUCTION is not lead work and must not leave
    // with it. The lead row is where these get recorded for a human to action
    // (nothing here ever writes consent or suppression state — see the header),
    // and a lifecycle customer has no lead: the instruction would simply
    // vanish, which for a "stop texting me" is the one outcome that matters.
    // Surface it on the SAME internal admin feed the re-service lane uses, so
    // it reaches a person instead of a dropped return value.
    await surfaceContactInstructionForCustomer(customer, extracted, opts).catch(() => {});
    return { leadId: null, customerId, created: false };
  }

  let existingLead = phone
    ? await db('leads').where('phone', phone).whereNull('deleted_at').orderBy('created_at', 'desc').first()
    : null;
  // ⭐ THE IDENTITY FIX HAS TO REACH THE LEAD LOOKUP TOO. Leads resolve BY
  // PHONE, and when the caller gave an ALTERNATE callback number that number
  // can already belong to somebody else's lead — so reusing it would rewrite
  // that lead's customer_id to this authenticated caller and hand them another
  // person's record.
  //
  // ⭐ AND "UNCLAIMED" IS NOT "OURS". The first cut of this guard rejected only
  // a lead already stamped with a DIFFERENT customer_id — but a lead with NO
  // customer_id on an alternate number is somebody's too: it is the record of
  // whoever owns that number calling in as a prospect (a spouse's own inquiry,
  // say), and reusing it would assign it to the authenticated caller and
  // overwrite its rolling fields. So on an authenticated call, a lead found by
  // a number OTHER than the caller's own ANI is reused only when it is already
  // linked to this customer; an unclaimed lead by the caller's OWN ANI is
  // their pre-customer history and stays reusable (idempotency by phone).
  if (existingLead && opts.identityCustomerId && existingLead.customer_id !== customerId) {
    const ownAni = phoneDigits(opts.aniPhone).slice(-10);
    const lookupNumber = phoneDigits(phone).slice(-10);
    const phoneIsOwnAni = !!ownAni && ownAni === lookupNumber;
    if (existingLead.customer_id || !phoneIsOwnAni) {
      logger.info(
        `[voice-agent-lead] lead on ${maskPhone(phone)} is ${existingLead.customer_id ? 'another customer\'s' : 'an unclaimed lead on an alternate number'} — `
        + 'not reusing it for the authenticated caller'
      );
      existingLead = null;
    }
  }

  // Don't reuse a lead that belongs to a different person on a shared line: if
  // the captured name conflicts with the existing lead's name and it isn't our
  // resolved customer's lead, create a separate unlinked lead instead of
  // overwriting their rolling fields (transcript_summary, extracted_data, …).
  if (existingLead && nameConflicts(extracted, existingLead)
      && !(customerId && existingLead.customer_id === customerId)) {
    logger.info(`[voice-agent-lead] Existing lead name conflicts on ${maskPhone(phone)}; creating a separate lead`);
    existingLead = null;
  }

  if (existingLead) {
    leadId = existingLead.id;
  } else {
    const leadSourceId = await resolveLeadSourceId(opts.toPhone);
    const insert = {
      lead_source_id: leadSourceId,
      customer_id: customerId,
      phone,
      first_name: nameCase(extracted.first_name),
      last_name: nameCase(extracted.last_name) || '',
      email: extracted.email || null,
      lead_type: 'inbound_call',
      first_contact_at: new Date(),
      first_contact_channel: 'call',
      status: 'new',
    };
    if (opts.callSid) insert.twilio_call_sid = opts.callSid;
    if (opts.callDurationSeconds != null) insert.call_duration_seconds = opts.callDurationSeconds;
    const [newLead] = await db('leads').insert(insert).returning('*');
    leadId = newLead.id;
    created = true;
    // Log IDs/masked phone only — `service` is caller-provided free text and
    // can contain names/addresses; it belongs in the row, not plain logs.
    logger.info(`[voice-agent-lead] Created lead ${leadId} for ${maskPhone(phone)}`);
  }

  if (leadId) {
    const current = existingLead || (await db('leads').where({ id: leadId }).first());
    const leadUpdates = {};
    if (extracted.first_name && isEmpty(current?.first_name)) leadUpdates.first_name = nameCase(extracted.first_name);
    if (extracted.last_name && isEmpty(current?.last_name)) leadUpdates.last_name = nameCase(extracted.last_name);
    if (extracted.email && isEmpty(current?.email)) leadUpdates.email = extracted.email;
    if (extracted.address_line1 && isEmpty(current?.address)) leadUpdates.address = extracted.address_line1;
    if (extracted.city && isEmpty(current?.city)) leadUpdates.city = extracted.city;
    if (extracted.zip && isEmpty(current?.zip)) leadUpdates.zip = extracted.zip;
    if (service && isEmpty(current?.service_interest)) leadUpdates.service_interest = service;

    // Urgency: upgrade-only (mirror voicemail path) — hot promotes to urgent,
    // otherwise only fill if still empty so a cold follow-up never downgrades.
    if (extracted.lead_quality === 'hot') leadUpdates.urgency = 'urgent';
    else if (extracted.lead_quality && isEmpty(current?.urgency)) leadUpdates.urgency = 'normal';

    if (extracted.call_summary) leadUpdates.transcript_summary = extracted.call_summary;
    // ⭐ extracted_data is MERGED, never replaced.
    //
    // contactPreferenceFields returning null was supposed to mean "a
    // preference-free payload cannot erase a recorded instruction" — but the
    // write below was a wholesale JSON.stringify of a freshly built object, so
    // the spread-or-not was irrelevant: the SECOND capture_lead on the same
    // call (or a call NEXT WEEK, since the lead is resolved by phone) rebuilt
    // extracted_data from scratch and dropped every consent key that was not in
    // that payload. A caller who said "stop texting me" and then answered one
    // more question lost the instruction.
    const priorExtracted = parseJsonObject(current?.extracted_data);
    const merged = { ...priorExtracted };
    // Fill-forward: a payload that simply didn't mention a field keeps the
    // value already on the lead rather than nulling it.
    merged.pain_points = extracted.pain_points || priorExtracted.pain_points || null;
    merged.preferred_date_time = extracted.preferred_date_time || priorExtracted.preferred_date_time || null;
    merged.source = 'voice_agent';
    merged.language = language || priorExtracted.language || null;
    const contactPreference = contactPreferenceFields(extracted);
    if (contactPreference) {
      if (contactPreference.contact_preference) merged.contact_preference = contactPreference.contact_preference;
      if (contactPreference.preferred_contact_method) merged.preferred_contact_method = contactPreference.preferred_contact_method;
      // do_not_contact_request is STICKY-ON. Lifting a stated do-not-contact is
      // a human decision (the agent cannot act on one either way), so a later
      // payload may SET it and never clear it. The false is still recorded on a
      // lead that has never carried a true.
      if (contactPreference.do_not_contact_request === true) merged.do_not_contact_request = true;
      else if (merged.do_not_contact_request !== true) merged.do_not_contact_request = false;
    }
    leadUpdates.extracted_data = JSON.stringify(merged);
    // Only touch is_qualified when the agent sent a recognized quality, so a
    // later quality-less payload can't demote a previously qualified lead.
    if (extracted.lead_quality) leadUpdates.is_qualified = ['hot', 'warm'].includes(extracted.lead_quality);
    if (language) leadUpdates.preferred_language = language;
    // Only (re)link a customer when one was unambiguously resolved — never
    // null out an existing lead's customer_id on a no-match/ambiguous lookup.
    if (customerId) leadUpdates.customer_id = customerId;
    leadUpdates.updated_at = new Date();
    await db('leads').where({ id: leadId }).update(leadUpdates);

    await db('lead_activities').insert({
      lead_id: leadId,
      activity_type: 'ai_triage',
      description: `AI voice agent captured: ${service || 'general inquiry'}${language === 'es' ? ' (Spanish)' : ''}, quality: ${extracted.lead_quality || 'unknown'}`,
      performed_by: 'AI Voice Agent',
      metadata: JSON.stringify({
        call_summary: extracted.call_summary,
        pain_points: extracted.pain_points,
        language,
        source: 'voice_agent',
        ...(contactPreference || {}),
      }),
    }).catch((e) => logger.warn(`[voice-agent-lead] activity log failed (non-blocking): ${e.message}`));
  }

  return { leadId, customerId, created };
}

/**
 * Hourly recovery for contact instructions whose ONLY artifact (the admin feed
 * row) failed to persist on the live call. Mirrors sweepAbandonedHotAlerts:
 * keyed on the durable obligation marker capture time stamped, cleared only on
 * a proven re-file. Fail-open toward a duplicate feed row — a rare duplicate
 * beats a silently lost "stop texting me".
 *
 * ⭐ THE MARKER OUTLIVES ANY OUTAGE. There is no attempt cap: a compliance
 * instruction with no other artifact is never discarded because delivery kept
 * failing — the marker (and the stored instruction) stay until a re-file
 * SUCCEEDS. The only clears besides success are deliberate ones: the
 * internal-test suppression gate (zero-artifact by policy) and a customer row
 * that no longer exists (a debt nobody can pay). Attempts are counted for
 * observability only.
 */
async function sweepUnsurfacedContactInstructions({ limit = 10 } = {}) {
  const rows = await db('call_log')
    .whereRaw("metadata->>'relay_contact_instruction_needed' = 'true'")
    .orderBy('created_at', 'asc')
    .limit(limit)
    .select('id', 'twilio_call_sid', 'metadata');
  let recovered = 0;
  for (const row of rows) {
    const meta = (row.metadata && typeof row.metadata === 'object') ? row.metadata : {};
    const payload = (meta.relay_contact_instruction && typeof meta.relay_contact_instruction === 'object')
      ? meta.relay_contact_instruction : {};
    const clearMarker = () => db('call_log').where({ id: row.id }).update({
      metadata: db.raw("metadata - 'relay_contact_instruction_needed' - 'relay_contact_instruction' - 'relay_contact_instruction_attempts'"),
    }).catch((e) => logger.warn(`[voice-agent-lead] contact-instruction marker clear failed call_log=${row.id}: ${e.message}`));

    const customer = payload.customerId
      ? await db('customers').where({ id: payload.customerId }).whereNull('deleted_at').first().catch(() => null)
      : null;
    if (!customer) {
      // Unresolvable obligation (customer gone / malformed payload): clear it
      // loudly rather than retry a debt nobody can pay.
      logger.error(`[voice-agent-lead] contact-instruction obligation unresolvable (customer ${payload.customerId || 'missing'}) call_log=${row.id} — clearing marker`);
      await clearMarker();
      continue;
    }
    const attempts = Number(meta.relay_contact_instruction_attempts || 0);
    const instruction = {
      contact_preference: payload.contact_preference || null,
      preferred_contact_method: CONTACT_METHODS.has(String(payload.preferred_contact_method || '')) ? payload.preferred_contact_method : null,
      do_not_contact_request: payload.do_not_contact_request === true,
    };
    const dnc = instruction.do_not_contact_request;
    const result = await fileContactInstructionNotification(customer, instruction, {
      callSid: row.twilio_call_sid,
      smsSuppressionApplied: payload.smsSuppressionApplied === true,
      sweepRetry: true,
    }, dnc);
    if (result.persisted) {
      await clearMarker();
      recovered += 1;
    } else if (result.suppressed) {
      // Deliberate zero-artifact (internal-test customer gate) — not a
      // delivery failure. Clearing is the policy's decision, not a give-up.
      logger.warn(`[voice-agent-lead] contact-instruction for customer ${customer.id} suppressed by policy on sweep retry call_log=${row.id} — clearing marker`);
      await clearMarker();
    } else {
      if (attempts > 0 && attempts % 24 === 0) {
        logger.error(`[voice-agent-lead] contact-instruction for customer ${customer.id} STILL unsurfaced after ${attempts} sweep attempts call_log=${row.id} — marker retained, keeps retrying`);
      }
      await db('call_log').where({ id: row.id }).update({
        metadata: db.raw(
          "COALESCE(metadata, '{}'::jsonb) || ?::jsonb",
          [JSON.stringify({ relay_contact_instruction_attempts: attempts + 1 })],
        ),
      }).catch(() => {});
    }
  }
  return { scanned: rows.length, recovered };
}

module.exports = {
  createLeadFromExtraction, findCustomerByPhone, resolveLeadSourceId, contactPreferenceFields,
  sweepUnsurfacedContactInstructions,
};
