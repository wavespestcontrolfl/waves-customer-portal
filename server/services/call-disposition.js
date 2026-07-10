/**
 * Terminal disposition rules layer — zero-triage mission (2026-07-10).
 *
 * Every processed call maps to EXACTLY ONE terminal disposition from the fixed
 * enum below. There is deliberately no "needs_human_review" member: genuine
 * ambiguity resolves to `lead_response_flow_triggered` — the existing
 * A2P-compliant Lead Response flow follows up automatically, so the worst case
 * for a junk call is one automated follow-up, while a real lead can never die
 * in a review queue (the 30-day audit found 356 triage cards created, 0 ever
 * reviewed — a queue is where calls went to die).
 *
 * Pure decision function: no I/O, no side effects. The caller (the recording
 * processor, behind GATE_CALL_DISPOSITION_V1) persists the result to
 * call_log.disposition and executes the mapped action. Spam is the only
 * destructive disposition and is NEVER decided here alone — it requires the
 * layered classifier's verdict (content + independent signal + no history),
 * passed in as `spamVerdict`.
 */

const TERMINAL_DISPOSITIONS = Object.freeze([
  'booked',                        // appointment created on the call
  'callback_task_created',         // caller asked for a callback at a specific time
  'lead_response_flow_triggered',  // lead/prospect OR ambiguous — automated follow-up owns it
  'existing_customer_routed',      // existing-customer service/scheduling/billing handled
  'estimate_send',                 // quote promised or requested — estimate draft lane
  'cancellation_processed',        // cancel/reschedule intent applied to the appointment
  'complaint_escalated',           // complaint / no-show / emergency — owner alert path
  'vendor_logged',                 // B2B vendor/partner — logged, no customer artifacts
  'voicemail_processed',           // voicemail whose intent was extracted and actioned
  'spam_discarded',                // layered-classifier spam (>=2 independent signals)
  'wrong_number_closed',           // misdial / competitor's customer
  'no_action_needed',              // dead air, silence, sub-threshold noise
]);

const NATURE_DEFAULTS = {
  new_lead: 'lead_response_flow_triggered',
  existing_customer_service: 'existing_customer_routed',
  existing_customer_scheduling: 'existing_customer_routed',
  billing_question: 'existing_customer_routed',
  vendor_or_partner: 'vendor_logged',
  job_applicant: 'vendor_logged',
  spam_solicitation: 'lead_response_flow_triggered', // content alone never discards
  robocall: 'lead_response_flow_triggered',
  wrong_number: 'wrong_number_closed',
  voicemail_message: 'voicemail_processed',
  silent_or_noise: 'no_action_needed',
  other: 'lead_response_flow_triggered',
};

/**
 * Decide the terminal disposition for a processed call.
 *
 * @param {object} args
 * @param {object|null} args.extraction   V2 extraction (schema >=1.4.0; 1.5.0 fields used when present)
 * @param {object|null} args.legacy       V1 flat extraction (is_lead / is_spam / is_voicemail / appointment_confirmed / quote_promised)
 * @param {object|null} args.spamVerdict  layered classifier result: { verdict: 'spam'|'not_spam'|'insufficient_signals' }
 * @param {object}      args.outcome      what the pipeline actually did: { appointmentCreated, customerId, isKnownCustomer }
 * @returns {{ disposition: string, reason: string }}
 */
function decideDisposition({ extraction = null, legacy = null, spamVerdict = null, outcome = {} }) {
  const v2 = extraction || {};
  const v1 = legacy || {};
  const nature = v2.call_nature || null;
  const recommended = v2.recommended_disposition || null;

  // 1. Reality first: if an appointment was actually created, the call is booked.
  if (outcome.appointmentCreated) return done('booked', 'appointment_created');

  // 2. Spam ONLY via the layered classifier — never from extraction alone.
  if (spamVerdict?.verdict === 'spam') return done('spam_discarded', 'layered_classifier_spam');

  // 3. Complaint / emergency beats everything else that remains: a booked-nothing
  //    call from an angry customer must reach the owner, not a follow-up drip.
  // Schema-real complaint signals (1.4.0+): customer_history.prior_complaint_mentioned
  // + the prior_complaint_unresolved triage flag; emergency urgency and the
  // legacy pain-point regex back them up. (complaint_or_service_issue is NOT
  // a schema field — a naming ghost from the offline audit tooling.)
  const complaint = v2.customer_history?.prior_complaint_mentioned === true
    || (v2.triage_flags || []).includes('prior_complaint_unresolved')
    || ['emergency_same_day', 'emergency'].includes(v2.service_request?.urgency) // schema enum = emergency_same_day
    || (v1.pain_points || []).some?.((p) => /no.?show|complain|angry|refund|lawyer|legal/i.test(String(p)));
  const knownParty = outcome.isKnownCustomer || !!outcome.customerId;
  if (complaint && knownParty) return done('complaint_escalated', 'complaint_from_known_customer');

  // 4. Cancellation / reschedule intent.
  const cancels = (v2.triage_flags || []).some((f) => ['cancellation_request', 'reschedule_or_cancel'].includes(f));
  if (cancels && knownParty) return done('cancellation_processed', 'cancel_or_reschedule_intent');

  // 5. Quote promised/requested with no booking → estimate lane.
  const quote = v1.quote_promised === true || v1.quote_requested === true
    || v2.service_request?.quote_promised === true || v2.service_request?.quote_requested === true;
  if (quote) return done('estimate_send', 'quote_promised_or_requested');

  // 6. Voicemail: intent decides. Actionable voicemail intents route like live calls.
  const isVoicemail = v1.is_voicemail === true || nature === 'voicemail_message';
  if (isVoicemail) {
    if (cancels) return done('cancellation_processed', 'voicemail_cancel_intent');
    if (complaint) return done('complaint_escalated', 'voicemail_complaint');
    if (v1.is_lead === true) return done('lead_response_flow_triggered', 'voicemail_lead');
    return done('voicemail_processed', 'voicemail_default');
  }

  // 7. Model recommendation, when it is a member of the enum and consistent
  //    with the hard rules above.
  if (recommended && TERMINAL_DISPOSITIONS.includes(recommended)
      && !['spam_discarded', 'booked'].includes(recommended)) {
    return done(recommended, 'model_recommended');
  }

  // 8. Nature default; final fallback is the lead-response flow — the safe
  //    automated action for anything genuinely ambiguous.
  if (nature && NATURE_DEFAULTS[nature]) return done(NATURE_DEFAULTS[nature], `nature_${nature}`);
  if (v1.is_lead === true) return done('lead_response_flow_triggered', 'v1_is_lead');
  if (knownParty) return done('existing_customer_routed', 'known_customer_default');
  return done('lead_response_flow_triggered', 'ambiguous_fail_safe');
}

function done(disposition, reason) {
  if (!TERMINAL_DISPOSITIONS.includes(disposition)) {
    // Defensive: an unknown disposition falls back to the safe action rather
    // than throwing inside the call pipeline.
    return { disposition: 'lead_response_flow_triggered', reason: `invalid_${disposition}` };
  }
  return { disposition, reason };
}

module.exports = { decideDisposition, TERMINAL_DISPOSITIONS };
