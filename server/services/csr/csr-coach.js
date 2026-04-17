const db = require('../../models/db');
const logger = require('../logger');
const MODELS = require('../../config/models');

let Anthropic;
try { Anthropic = require('@anthropic-ai/sdk'); } catch { Anthropic = null; }

let TwilioService;
try { TwilioService = require('../twilio'); } catch { TwilioService = null; }

class CSRCoach {

  /**
   * Score a call and grade the lead. Returns score + coaching + follow-up task.
   */
  async scoreCall({ csrName, customerId, callDirection, callSource, transcript, metadata }) {
    if (!Anthropic || !process.env.ANTHROPIC_API_KEY) {
      return { error: 'Anthropic API not configured' };
    }

    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    const response = await anthropic.messages.create({
      model: MODELS.FLAGSHIP,
      max_tokens: 3000,
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
      messages: [{
        role: 'user',
        content: `Score this ${callDirection} call:

CSR: ${csrName}
Source: ${callSource || 'unknown'}
${metadata?.customerName ? `Customer: ${metadata.customerName}` : ''}
${metadata?.serviceInterest ? `Service interest: ${metadata.serviceInterest}` : ''}

TRANSCRIPT/NOTES:
${transcript || 'No transcript available — score based on available metadata only.'}

Score the call, grade the lead, and generate a follow-up task if applicable.`
      }]
    });

    let score;
    try {
      score = JSON.parse(response.content[0].text.replace(/```json|```/g, '').trim());
    } catch {
      return { error: 'Failed to parse scoring output' };
    }

    // Check if this is the first call from this lead
    let isFirstCall = false;
    if (customerId) {
      const prev = await db('csr_call_scores').where('customer_id', customerId).count('* as count').first();
      isFirstCall = parseInt(prev.count) === 0;
    }

    // Save the score
    const [callScore] = await db('csr_call_scores').insert({
      customer_id: customerId || null,
      csr_name: csrName,
      call_date: new Date().toISOString().split('T')[0],
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

      // Check for outbound SMS
      const matchingSms = await db('sms_log')
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
    const since = new Date(Date.now() - days * 86400000).toISOString().split('T')[0];

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
      .where('call_date', '>', new Date(Date.now() - 7 * 86400000).toISOString().split('T')[0]);

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
    const periodStart = now.getDate() <= 15
      ? new Date(now.getFullYear(), now.getMonth(), 1).toISOString().split('T')[0]
      : new Date(now.getFullYear(), now.getMonth(), 16).toISOString().split('T')[0];
    const periodEnd = now.getDate() <= 15
      ? new Date(now.getFullYear(), now.getMonth(), 15).toISOString().split('T')[0]
      : new Date(now.getFullYear(), now.getMonth() + 1, 0).toISOString().split('T')[0];

    const overview = await this.getTeamOverview(15);

    // Determine winners
    const csrs = overview.csrStats;
    const bestBooking = csrs.reduce((best, c) => c.firstCallBookingRate > (best?.firstCallBookingRate || 0) ? c : best, null);
    const bestScore = csrs.reduce((best, c) => c.avgScore > (best?.avgScore || 0) ? c : best, null);
    const bestFollowUp = csrs.reduce((best, c) => c.followUpRate > (best?.followUpRate || 0) ? c : best, null);

    return {
      periodStart,
      periodEnd,
      periodLabel: `${new Date(periodStart + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} – ${new Date(periodEnd + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`,
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
