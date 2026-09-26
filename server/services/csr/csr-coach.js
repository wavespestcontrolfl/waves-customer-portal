const db = require('../../models/db');
const logger = require('../logger');
const MODELS = require('../../config/models');
const { dispatchWithFallback } = require('../llm/call');
const { etDateString, etParts, addETDays, parseETDateTime } = require('../../utils/datetime-et');
const { excludeUnresolvedSendReservations } = require('../messaging/review-ask-reservation');
const { isV2Extraction } = require('../../utils/extraction-compat');


let TwilioService;

// Matches the call pipeline's extraction budget: this runs INSIDE a
// processing claim, so an unbounded hang here wedges the whole call.
const CSR_SCORE_TIMEOUT_MS = Number(process.env.CALL_PROC_EXTRACT_TIMEOUT_MS) > 0
  ? Number(process.env.CALL_PROC_EXTRACT_TIMEOUT_MS)
  : 180000;
try { TwilioService = require('../twilio'); } catch { TwilioService = null; }

// The 15-point rubric below is a SALES call rubric (greeting → close →
// upsell). Applying it to every transcribed call (2026-09-23 audit: 61 rows,
// avg 2.7/15, fifteen zeros) scored billing questions, tech ETA/coordination
// calls, existing-customer service calls and vendor calls as botched sales
// pitches — the model's own coaching text on those rows says "this is not a
// sales call". Score only the calls the rubric actually describes: an
// INBOUND call whose v2 extraction is valid and classifies it `new_lead`.
// (The v2 `call_nature` enum has no separate "returning prospect asking for
// pricing" value — those calls extract as `new_lead` too, so this single
// check covers both.) When v2 is missing/invalid, fall back to the legacy
// behavior (score) so a call is never silently dropped just because
// extraction failed — the false-zero problem this gate fixes is about
// MISCLASSIFYING a known non-sales call, not about an unknown one.
const SALES_RUBRIC_CALL_NATURE = 'new_lead';

/**
 * Pure decision: does the 15-point sales rubric apply to this call?
 * Exported so the rule is unit-testable independent of the DB/LLM.
 *
 * @param {object} opts
 * @param {string} [opts.direction] - 'inbound' | 'outbound' (any other/missing value is treated as inbound)
 * @param {string|null} [opts.callNature] - v2 extraction's `call_nature`, only meaningful when v2Valid
 * @param {boolean} [opts.v2Valid] - whether a valid v2 extraction was available for this call
 * @param {boolean} [opts.v2Promoted] - whether V2 is actually driving routing right now
 *   (CALL_EXTRACTION_V2_DRIVES_ROUTING && CALL_EXTRACTION_V2_ENABLED — the same
 *   "enforce mode" test call-recording-processor.js uses elsewhere). Defaults
 *   to false — the safe direction, since a caller that forgets to pass it
 *   should keep scoring rather than start silently suppressing it.
 * @returns {boolean}
 */
function csrScoringApplies({ direction, callNature, v2Valid, v2Promoted } = {}) {
  const isOutbound = String(direction || '').toLowerCase().startsWith('outbound');
  if (isOutbound) return false;
  // v2 missing/invalid: fall back to legacy behavior rather than silently
  // losing the call from coaching entirely.
  if (!v2Valid) return true;
  // The flag contract at call-recording-processor.js ~64-71 is explicit:
  // demoting CALL_EXTRACTION_V2_DRIVES_ROUTING to shadow restores the FULL
  // legacy V1 drive — V2 has no operational authority over anything until
  // routing is promoted. A shadow-mode misclassification (a genuine lead
  // read as e.g. `billing_question`) must not cost that lead its CSR score
  // or follow-up task (codex r1 P2). Only let v2's call_nature suppress
  // scoring once v2 is actually driving.
  if (!v2Promoted) return true;
  return callNature === SALES_RUBRIC_CALL_NATURE;
}

// Deterministic coaching addendum (schema 1.14.0, live miss 2026-09-25, call
// 6fee5f34): the LLM rubric above scores what it can infer from a transcript
// alone — it has no reliable way to know the extracted caller_id_disclaimed
// signal was ever raised. When the caller explicitly said the incoming
// number isn't theirs and the call still ended with no cell number
// captured, that is a specific, checkable miss worth coaching on every time,
// so it's appended deterministically rather than left to the model to
// notice. Pure/testable; scoreCall appends the text it returns. The
// predicate is NOT re-derived here (pre-push review P1) — it calls
// call-triage-flags.js's callerIdDisclaimedNeedsCallback, the same function
// computeDeterministicTriageFlags uses for callback_number_needed, so
// coaching can never silently disagree with the flag.
const CALLBACK_NUMBER_COACHING_NOTE = "Caller said this number isn't theirs — ask for a cell before ending the call.";
// contactPhone (the call's ANI) is optional and forwarded to
// callerIdDisclaimedNeedsCallback unchanged — see that function's own P1
// fix (call-triage-flags.js) for why a bare phone_e164 presence check isn't
// enough. Omitting it here never widens the coaching note beyond what the
// flag itself would raise; it only means the "provably different from the
// ANI" clearance path can't apply, same fail-closed default as the flag.
function callbackNumberCoachingNote(v2Extraction, contactPhone) {
  const { callerIdDisclaimedNeedsCallback } = require('../call-triage-flags');
  if (!callerIdDisclaimedNeedsCallback(v2Extraction?.caller, { ani: contactPhone })) return null;
  return CALLBACK_NUMBER_COACHING_NOTE;
}

// Every field the csr_call_scores insert (~L305-329) writes straight from
// the model's answer, with no fallback. The old validator only checked
// "object, not array" (codex r1-r9) — a reply missing e.g. total_score, or
// carrying a string where a number belongs, passed that check and then blew
// up on the DB insert deep inside a try/catch the caller reads back as
// "scored: false", with the ledger row already marked a success (Codex r10
// on #4884). Pure/testable.
const CSR_SCORE_NUMERIC_FIELDS = [
  'total_score', 'core_score', 'rescue_score',
  'control_score', 'warmth_score', 'clarity_score', 'objection_handling_score', 'closing_strength_score',
  'lead_quality_score',
];
function isUsableCsrScore(score) {
  if (!score || typeof score !== 'object' || Array.isArray(score)) return false;
  // A strict numeric string ("8") inserts fine into the numeric columns, so it
  // counts; anything that isn't a number at all does not.
  const numeric = (v) => (typeof v === 'number' && Number.isFinite(v)) || (typeof v === 'string' && /^\s*-?\d+(\.\d+)?\s*$/.test(v));
  if (CSR_SCORE_NUMERIC_FIELDS.some((f) => !numeric(score[f]))) return false;
  if (typeof score.call_outcome !== 'string' || !score.call_outcome.trim()) return false;
  // JSON.stringify(undefined) IS undefined — an insert of that column value
  // is exactly the undefined-binding case this whole check exists to catch.
  if (score.point_details === undefined || typeof score.point_details !== 'object' || score.point_details === null || Array.isArray(score.point_details)) return false;
  return true;
}

class CSRCoach {

  /**
   * Single entry point for call-recording-processor.js: applicability gate
   * PLUS scoring, as one call (moved here 2026-09-24, codex r1 P2b). This
   * used to be an if/else the processor owned around `scoreCall` — another
   * decision and nesting level inside a function this diff already
   * rewrites, which the repo's structural-warning rule treats as a P2
   * (AGENTS.md L409-413). The processor now owns none of the applicability
   * decision: it hands over what it has and reads back what happened.
   *
   * @param {object} opts
   * @param {string} [opts.direction] - 'inbound' | 'outbound'
   * @param {object|null} [opts.v2Extraction] - the call's v2 extraction, if any
   * @param {string|null} [opts.v2Status] - the v2 extraction's validation status ('valid' | ...)
   * @param {boolean} [opts.v2Promoted] - CALL_EXTRACTION_V2_DRIVES_ROUTING && CALL_EXTRACTION_V2_ENABLED
   * @param {string} [opts.maskedCallSid] - for the skip log line only
   * @param {...*} opts.rest - forwarded to `scoreCall` when the rubric applies
   * @returns {Promise<{applicable: boolean, abandon?: boolean, scored?: boolean, score?: number, outcome?: string}>}
   */
  async scoreCallIfApplicable({
    direction, v2Extraction, v2Status, v2Promoted, maskedCallSid,
    stillOwnsClaim, csrName, customerId, callSource, transcript, metadata, contactPhone = null,
  }) {
    const v2Valid = v2Status === 'valid' && !!v2Extraction && isV2Extraction(v2Extraction);
    const callNature = v2Valid ? (v2Extraction?.call_nature || null) : null;
    if (!csrScoringApplies({ direction, callNature, v2Valid, v2Promoted })) {
      logger.info(`[call-proc] CSR scoring skipped for ${maskedCallSid}: direction=${direction}, call_nature=${callNature || 'unknown'} — not a sales call, no csr_call_scores row written`);
      return { applicable: false };
    }
    try {
      const scoreResult = await this.scoreCall({
        stillOwnsClaim, csrName, customerId, callDirection: 'inbound', callSource, transcript, metadata,
        // Codex round-5 P2: v2Extraction is used inside scoreCall for
        // exactly one thing — callbackNumberCoachingNote, the deterministic
        // "ask for a cell" coaching addendum. v2Valid alone (shadow mode
        // included) let a shadow-only extraction's signal reach
        // csr_call_scores.coaching_notes even while V2 has no operational
        // authority anywhere else (the same v2Promoted gate this function's
        // own rubric-applicability check already honors above). Gate the
        // extraction on v2Promoted too, so the coaching note stays shadow-
        // mode-inert like everything else V2 hasn't been promoted to drive
        // — the SMS safety hold itself (callbackNumberHoldActiveForVisit /
        // call-recording-processor.js) is untouched by this and still arms
        // in shadow mode, as it must.
        v2Extraction: (v2Valid && v2Promoted) ? v2Extraction : null,
        contactPhone,
      });
      // The scorer's own post-await check found the claim gone. That is not
      // "no score" — it is this pass being superseded, and the caller's
      // route-decision insert and ai_validation write are unfenced, so a
      // stale pass that carried on could win the unique insert or overwrite
      // the replacement's verdict (codex #3677 P1). Abandon.
      if (scoreResult?.skipped && scoreResult.reason === 'ownership_lost') {
        return { applicable: true, abandon: true };
      }
      // scoreCall returns the score object itself (total_score, call_outcome,
      // ...), not a wrapper — the old `.score.` read logged
      // "undefined/15 (undefined)" on every call (2026-09-20 audit).
      const score = scoreResult?.total_score;
      const outcome = scoreResult?.call_outcome;
      logger.info(`[call-proc] CSR scored: ${score}/15 (${outcome})`);
      return { applicable: true, scored: true, score, outcome };
    } catch (err) {
      logger.error(`[call-proc] CSR scoring failed (non-blocking): ${err.message}`);
      return { applicable: true, scored: false };
    }
  }

  /**
   * Score a call and grade the lead. Returns score + coaching + follow-up task.
   */
  /**
   * `stillOwnsClaim` — optional async predicate from a caller that holds a
   * processing claim. Scoring awaits a provider for minutes, and the row it
   * writes is not idempotent, so a caller whose claim was reclaimed during
   * that await must not persist a second score (codex #3677 P1). Checked
   * immediately before the insert, which is the only moment that matters.
   */
  async scoreCall({ csrName, customerId, callDirection, callSource, transcript, metadata, stillOwnsClaim, v2Extraction = null, contactPhone = null }) {
    // FLAGSHIP first, Sol on a miss. The explicit timeoutMs is the shared
    // wall-clock ceiling across BOTH legs (llm/call.js), so the bound
    // reasoned about below covers the whole scoring pass, not one provider.
    const res = await dispatchWithFallback(MODELS.TEXT_POLICIES.highStakes, {
      laneId: 'csr_coach',
      maxTokens: 3000,
      jsonMode: true,
      timeoutMs: CSR_SCORE_TIMEOUT_MS,
      system: `You score customer service calls for Waves Pest Control, a pest control and lawn care company in Southwest Florida.

SCORING — 15 POINTS TOTAL:

CORE 10 POINTS (1 point each, must be clearly present):
1. greeting: Answered with name + company ("Thanks for calling Waves, this is [name]")
2. empathy: Acknowledged the customer's concern before jumping to solutions
3. problem_capture: Asked what specific pest/issue and where in the home/yard
4. address: Confirmed the service address
5. time_options: Offered at least 2 scheduling options ("I can get you Tuesday 8-10 or Thursday 1-3")
6. fee_confirmation: Stated the price and got verbal agreement BEFORE scheduling
7. name_confirmation: Confirmed the customer's name spelling
8. callback_number: Confirmed or captured a callback number
9. set_expectations: Explained what happens next (confirmation text, tech on-the-way text, etc.)
10. strong_close: Ended with confidence and next steps ("We'll get you taken care of")

RESCUE 5 POINTS (1 each, when applicable — only score if the situation arose):
11. objection_save: Customer raised a pricing or timing objection and CSR addressed it effectively
12. upsell_attempt: CSR mentioned WaveGuard membership, recurring service, or related service
13. urgency_creation: CSR created urgency ("I have a spot tomorrow" / "This time of year it only gets worse")
14. referral_mention: CSR mentioned the referral program
15. follow_up_offer: For non-bookings, offered to follow up / send info / call back

SKILL DIMENSIONS (rate each 1-5):
- control: Did CSR guide the conversation or did customer lead?
- warmth: Was CSR friendly, empathetic, personable?
- clarity: Were explanations clear, confident, specific?
- objection_handling: How well were concerns addressed?
- closing_strength: How confidently did CSR drive toward booking?

LEAD GRADING (separate from CSR performance):

LEAD QUALITY (1-10):
10 = Ready to buy today, specific need, in service area
7-9 = Genuine need, some urgency, likely converts with good handling
4-6 = Interested but not urgent, shopping, needs nurturing
1-3 = Tire kicker, out of area, wrong number, spam

LEAD INTENT: urgent, price_shopping, researching, referral_warm, repeat_customer, tire_kicker

LOSS REASON (if not booked):
- bad_lead: Lead quality too low — CSR couldn't save this
- csr_missed_script: CSR had a bookable call but missed key points
- pricing: Customer balked at price, CSR didn't handle objection
- no_availability: Couldn't offer a time that worked
- customer_shopping: Explicitly getting other quotes
- after_hours: Outside business hours
- no_answer: Voicemail / no pickup

FOLLOW-UP TASK (if NOT booked AND lead_quality >= 5):
Generate a specific follow-up with script and deadline.

Return JSON:
{
  "total_score": 0-15,
  "core_score": 0-10,
  "rescue_score": 0-5,
  "point_details": { "greeting": 0/1, "empathy": 0/1, ... },
  "control_score": 1-5,
  "warmth_score": 1-5,
  "clarity_score": 1-5,
  "objection_handling_score": 1-5,
  "closing_strength_score": 1-5,
  "call_outcome": "booked/estimate_sent/callback_scheduled/not_booked/voicemail",
  "call_summary": "2-3 sentence summary",
  "coaching_notes": "top 3 specific improvements with better phrasing examples",
  "better_phrasings": [{"original": "what they said", "better": "what to say instead", "why": "reason"}],
  "lead_quality_score": 1-10,
  "lead_intent": "",
  "lead_source_quality": "high/medium/low",
  "loss_reason": null or string,
  "estimated_job_value": null or number,
  "follow_up_task": null or { "type": "call_back/send_sms/send_estimate", "recommended_action": "specific script", "deadline_hours": 4/24/48, "priority": "high/medium/low" }
}`,
      text: `Score this ${callDirection} call:

CSR: ${csrName}
Source: ${callSource || 'unknown'}
${metadata?.customerName ? `Customer: ${metadata.customerName}` : ''}
${metadata?.serviceInterest ? `Service interest: ${metadata.serviceInterest}` : ''}

TRANSCRIPT/NOTES:
${transcript || 'No transcript available — score based on available metadata only.'}

Score the call, grade the lead, and generate a follow-up task if applicable.`,
    // BOUNDED. The call-recording pass AWAITS this while holding its
    // processing claim, and its heartbeat runs on a timer — so on the SDK's
    // defaults a hang here kept the claim alive and unreclaimable by both the
    // 3-minute human path and the 10-minute automatic one (codex #3677 P1).
    // Scoring is best-effort: failing after four minutes is strictly better
    // than pinning a call in 'processing'.
    }, {
      // The dispatcher's loose parse accepts any JSON value; the old
      // utils/llm-json parser accepted only a non-array object. Keep that
      // contract: a wrongly shaped answer is a rejected leg, not a stored row.
      // Beyond shape, every field the insert below actually writes must be
      // present and correctly typed (isUsableCsrScore) — see its comment.
      validate: (result) => {
        if (!result.json || typeof result.json !== 'object' || Array.isArray(result.json)) return 'not_an_object';
        return isUsableCsrScore(result.json) ? null : 'schema_invalid';
      },
    });

    if (!res.ok) {
      return { error: `Failed to score call (${res.reason})` };
    }
    const score = res.json;

    // Deterministic coaching addendum (see callbackNumberCoachingNote) — the
    // model's own coaching_notes never sees the extracted caller_id_disclaimed
    // signal, so append it rather than hope the transcript alone surfaced it.
    const callbackNote = callbackNumberCoachingNote(v2Extraction, contactPhone);
    if (callbackNote) {
      score.coaching_notes = score.coaching_notes
        ? `${score.coaching_notes}\n\n${callbackNote}`
        : callbackNote;
    }

    // Check if this is the first call from this lead
    let isFirstCall = false;
    if (customerId) {
      const prev = await db('csr_call_scores').where('customer_id', customerId).count('* as count').first();
      isFirstCall = parseInt(prev.count) === 0;
    }

    if (stillOwnsClaim && !(await stillOwnsClaim())) {
      logger.warn('[csr-coach] ownership lost during scoring — discarding the score rather than writing a second one');
      return { skipped: true, reason: 'ownership_lost' };
    }

    // Save the score
    const [callScore] = await db('csr_call_scores').insert({
      customer_id: customerId || null,
      csr_name: csrName,
      call_date: etDateString(),
      call_direction: callDirection || 'inbound',
      call_source: callSource,
      total_score: score.total_score,
      core_score: score.core_score,
      rescue_score: score.rescue_score,
      point_details: JSON.stringify(score.point_details),
      control_score: score.control_score,
      warmth_score: score.warmth_score,
      clarity_score: score.clarity_score,
      objection_handling_score: score.objection_handling_score,
      closing_strength_score: score.closing_strength_score,
      call_outcome: score.call_outcome,
      call_summary: score.call_summary,
      coaching_notes: score.coaching_notes,
      better_phrasings: JSON.stringify(score.better_phrasings || []),
      lead_quality_score: score.lead_quality_score,
      lead_intent: score.lead_intent,
      lead_source_quality: score.lead_source_quality,
      loss_reason: score.loss_reason,
      is_first_call_from_lead: isFirstCall,
      estimated_job_value: score.estimated_job_value,
      transcript_snippet: (transcript || '').substring(0, 2000),
      metadata: JSON.stringify(metadata || {}),
    }).returning('*');

    // Create follow-up task if applicable
    if (score.follow_up_task && score.call_outcome !== 'booked') {
      const [task] = await db('ai_follow_up_tasks').insert({
        call_score_id: callScore.id,
        customer_id: customerId || null,
        assigned_to: csrName || 'Adam',
        task_type: score.follow_up_task.type,
        recommended_action: score.follow_up_task.recommended_action,
        context_summary: score.call_summary,
        deadline: new Date(Date.now() + (score.follow_up_task.deadline_hours || 24) * 3600000),
        status: 'pending',
      }).returning('*');

      await db('csr_call_scores').where('id', callScore.id).update({
        follow_up_task_created: true,
      });

      score._followUpTaskId = task.id;
    }

    score._callScoreId = callScore.id;
    score._isFirstCall = isFirstCall;

    logger.info(`CSR score: ${csrName} — ${score.total_score}/15 (lead: ${score.lead_quality_score}/10, outcome: ${score.call_outcome})`);
    return score;
  }

  /**
   * Verify pending follow-up tasks against SMS/call logs.
   */
  async verifyFollowUps() {
    const pending = await db('ai_follow_up_tasks')
      .whereIn('status', ['pending'])
      .where('deadline', '<', new Date());

    let verified = 0, expired = 0;

    for (const task of pending) {
      if (!task.customer_id) {
        await db('ai_follow_up_tasks').where('id', task.id).update({ status: 'expired', action_verified: false });
        expired++;
        continue;
      }

      // Check for outbound SMS. An unresolved review-ask / reply reservation
      // is a 'sending' placeholder the provider may never have received — it
      // must not read as staff having completed this follow-up (Codex #4331
      // P2); the shared exclusion keeps that rule in one place.
      const matchingSms = await excludeUnresolvedSendReservations(db('sms_log'))
        .where('customer_id', task.customer_id)
        .where('direction', 'outbound')
        .where('created_at', '>', task.created_at)
        .first();

      // Check for outbound call/interaction
      const matchingCall = await db('customer_interactions')
        .where('customer_id', task.customer_id)
        .whereIn('interaction_type', ['call_outbound', 'call', 'note'])
        .where('created_at', '>', task.created_at)
        .first();

      if (matchingSms || matchingCall) {
        await db('ai_follow_up_tasks').where('id', task.id).update({
          status: 'verified',
          action_verified: true,
          verification_method: matchingSms ? 'sms_log_match' : 'call_log_match',
          completed_at: matchingSms?.created_at || matchingCall?.created_at,
        });

        // Check if a job was booked from this follow-up
        const booked = await db('estimates')
          .where('customer_id', task.customer_id)
          .where('status', 'accepted')
          .where('created_at', '>', task.created_at)
          .first();

        if (booked) {
          await db('ai_follow_up_tasks').where('id', task.id).update({ job_booked_from_followup: true });
        }

        verified++;
      } else {
        await db('ai_follow_up_tasks').where('id', task.id).update({ status: 'expired', action_verified: false });
        expired++;
      }
    }

    logger.info(`Follow-up verification: ${verified} verified, ${expired} expired`);
    return { verified, expired };
  }

  /**
   * Get team overview stats for the CSR Coach dashboard.
   */
  async getTeamOverview(days = 30) {
    const since = etDateString(addETDays(new Date(), -days));

    const scores = await db('csr_call_scores').where('call_date', '>=', since);

    // By CSR
    const byCSR = {};
    for (const s of scores) {
      const name = s.csr_name || 'Unknown';
      if (!byCSR[name]) byCSR[name] = { calls: 0, booked: 0, firstCalls: 0, firstCallBooked: 0, totalScore: 0, scored: 0 };
      byCSR[name].calls++;
      if (s.call_outcome === 'booked') byCSR[name].booked++;
      if (s.is_first_call_from_lead) {
        byCSR[name].firstCalls++;
        if (s.call_outcome === 'booked') byCSR[name].firstCallBooked++;
      }
      if (s.total_score != null) { byCSR[name].totalScore += s.total_score; byCSR[name].scored++; }
    }

    // Follow-up rates
    const followUps = await db('ai_follow_up_tasks').where('created_at', '>=', since + 'T00:00:00');
    const fuByCSR = {};
    for (const fu of followUps) {
      const name = fu.assigned_to || 'Unknown';
      if (!fuByCSR[name]) fuByCSR[name] = { assigned: 0, completed: 0, booked: 0 };
      fuByCSR[name].assigned++;
      if (['completed', 'verified'].includes(fu.status)) fuByCSR[name].completed++;
      if (fu.job_booked_from_followup) fuByCSR[name].booked++;
    }

    const csrStats = Object.entries(byCSR).map(([name, data]) => {
      const fu = fuByCSR[name] || { assigned: 0, completed: 0, booked: 0 };
      return {
        name,
        calls: data.calls,
        booked: data.booked,
        bookingRate: data.calls > 0 ? Math.round(data.booked / data.calls * 100) : 0,
        firstCalls: data.firstCalls,
        firstCallBooked: data.firstCallBooked,
        firstCallBookingRate: data.firstCalls > 0 ? Math.round(data.firstCallBooked / data.firstCalls * 100) : 0,
        avgScore: data.scored > 0 ? Math.round(data.totalScore / data.scored * 10) / 10 : 0,
        followUpsAssigned: fu.assigned,
        followUpsCompleted: fu.completed,
        followUpRate: fu.assigned > 0 ? Math.round(fu.completed / fu.assigned * 100) : 0,
        followUpsBooked: fu.booked,
      };
    }).sort((a, b) => b.firstCallBookingRate - a.firstCallBookingRate);

    // Loss reasons breakdown
    const losses = scores.filter(s => s.call_outcome !== 'booked' && s.loss_reason);
    const lossReasons = {};
    for (const s of losses) { lossReasons[s.loss_reason] = (lossReasons[s.loss_reason] || 0) + 1; }
    const totalLosses = losses.length || 1;

    // Revenue impact of fixable losses
    const fixableLosses = scores.filter(s => s.loss_reason === 'csr_missed_script' && s.estimated_job_value);
    const fixableRevenue = fixableLosses.reduce((sum, s) => sum + parseFloat(s.estimated_job_value || 0), 0);

    return {
      csrStats,
      teamTotals: {
        calls: scores.length,
        booked: scores.filter(s => s.call_outcome === 'booked').length,
        bookingRate: scores.length > 0 ? Math.round(scores.filter(s => s.call_outcome === 'booked').length / scores.length * 100) : 0,
        avgScore: scores.filter(s => s.total_score != null).length > 0 ? Math.round(scores.reduce((s, r) => s + (r.total_score || 0), 0) / scores.filter(s => s.total_score != null).length * 10) / 10 : 0,
      },
      lossReasons: Object.entries(lossReasons).map(([reason, count]) => ({
        reason, count, pct: Math.round(count / totalLosses * 100),
      })).sort((a, b) => b.count - a.count),
      fixableRevenue: Math.round(fixableRevenue),
      fixableLossCount: fixableLosses.length,
      period: `${days}d`,
    };
  }

  /**
   * Generate the weekly team recommendation — single most impactful script change.
   */
  async generateWeeklyTeamRecommendation() {
    const allScores = await db('csr_call_scores')
      .where('call_date', '>', etDateString(addETDays(new Date(), -7)));

    if (allScores.length < 5) {
      return { recommendation: 'Not enough data yet — need at least 5 scored calls.', dataPoint: '', estimatedImpact: '' };
    }

    const pointNames = ['greeting', 'empathy', 'problem_capture', 'address', 'time_options', 'fee_confirmation', 'name_confirmation', 'callback_number', 'set_expectations', 'strong_close'];

    let bestRec = null;
    let bestImpact = 0;

    for (const point of pointNames) {
      const withPoint = allScores.filter(s => {
        const details = typeof s.point_details === 'string' ? JSON.parse(s.point_details) : (s.point_details || {});
        return (details[point] || 0) >= 1;
      });
      const withoutPoint = allScores.filter(s => {
        const details = typeof s.point_details === 'string' ? JSON.parse(s.point_details) : (s.point_details || {});
        return (details[point] || 0) < 1;
      });

      if (withPoint.length < 2 || withoutPoint.length < 2) continue;

      const rateWith = withPoint.filter(s => s.call_outcome === 'booked').length / withPoint.length;
      const rateWithout = withoutPoint.filter(s => s.call_outcome === 'booked').length / withoutPoint.length;
      const missRate = withoutPoint.length / allScores.length;
      const impact = (rateWith - rateWithout) * missRate;

      if (impact > bestImpact) {
        bestImpact = impact;
        bestRec = {
          point,
          bookingRateWith: Math.round(rateWith * 100),
          bookingRateWithout: Math.round(rateWithout * 100),
          missRate: Math.round(missRate * 100),
        };
      }
    }

    if (!bestRec) return { recommendation: 'All script points performing similarly this week.', dataPoint: '', estimatedImpact: '' };

    const scripts = {
      greeting: "This week: always answer with name + company. \"Thanks for calling Waves Pest Control, this is [name], how can I help?\"",
      empathy: "This week: lead with empathy BEFORE solutions. \"I completely understand — that sounds really frustrating. The good news is we handle this all the time.\"",
      problem_capture: "This week: always ask what specific pest and where. \"What are you seeing? And where in the house — kitchen, bathroom, around the baseboards?\"",
      address: "This week: confirm the service address early. \"And what's the address we'd be coming to?\"",
      time_options: "This week: always offer TWO time options. \"I can get you tomorrow 8-10 AM or Thursday 1-3 PM — which works better?\"",
      fee_confirmation: "This week: state the fee and get agreement BEFORE scheduling. \"The service is $149 and that includes the full treatment. Does that sound okay?\"",
      name_confirmation: "This week: confirm the customer's name. \"And I want to make sure I have your name right — it's [name], correct?\"",
      callback_number: "This week: always capture or confirm a callback number. \"What's the best number to reach you at if we need to?\"",
      set_expectations: "This week: explain what happens next. \"You'll get a text confirmation, then a reminder the morning of. The tech will text when they're on the way.\"",
      strong_close: "This week: end with a confident close. \"We'll get you taken care of. You should get a text confirmation shortly. Anything else I can help with?\"",
    };

    return {
      recommendation: scripts[bestRec.point] || `Focus on: ${bestRec.point}`,
      dataPoint: `When we nail ${bestRec.point}: ${bestRec.bookingRateWith}% booking rate. When we miss it: ${bestRec.bookingRateWithout}%. We miss it ${bestRec.missRate}% of calls.`,
      estimatedImpact: `Fixing this could add ~${Math.round(bestImpact * allScores.length * 2)} bookings per month.`,
      point: bestRec.point,
      stats: bestRec,
    };
  }

  /**
   * Get the current bonus period leaderboard.
   */
  async getLeaderboard() {
    const now = new Date();
    const { year, month, day } = etParts(now);
    const ym = `${year}-${String(month).padStart(2, '0')}`;
    const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
    const periodStart = day <= 15 ? `${ym}-01` : `${ym}-16`;
    const periodEnd = day <= 15 ? `${ym}-15` : `${ym}-${String(lastDay).padStart(2, '0')}`;

    const overview = await this.getTeamOverview(15);

    // Determine winners
    const csrs = overview.csrStats;
    const bestBooking = csrs.reduce((best, c) => c.firstCallBookingRate > (best?.firstCallBookingRate || 0) ? c : best, null);
    const bestScore = csrs.reduce((best, c) => c.avgScore > (best?.avgScore || 0) ? c : best, null);
    const bestFollowUp = csrs.reduce((best, c) => c.followUpRate > (best?.followUpRate || 0) ? c : best, null);

    return {
      periodStart,
      periodEnd,
      periodLabel: `${parseETDateTime(periodStart + 'T12:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'America/New_York' })} – ${parseETDateTime(periodEnd + 'T12:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'America/New_York' })}`,
      categories: [
        { category: 'Best Booking Rate', winner: bestBooking?.name, value: `${bestBooking?.firstCallBookingRate || 0}%`, bonus: 50 },
        { category: 'Best Script Score', winner: bestScore?.name, value: `${bestScore?.avgScore || 0}/15`, bonus: 50 },
        { category: 'Best Follow-Up Rate', winner: bestFollowUp?.name, value: `${bestFollowUp?.followUpRate || 0}%`, bonus: 50 },
      ],
      csrs,
    };
  }
}

module.exports = new CSRCoach();
module.exports.csrScoringApplies = csrScoringApplies;
module.exports.SALES_RUBRIC_CALL_NATURE = SALES_RUBRIC_CALL_NATURE;
module.exports.callbackNumberCoachingNote = callbackNumberCoachingNote;
module.exports.CALLBACK_NUMBER_COACHING_NOTE = CALLBACK_NUMBER_COACHING_NOTE;
module.exports.isUsableCsrScore = isUsableCsrScore;
