/**
 * Nightly call self-audit — the loop that replaces human triage review
 * (zero-triage mission, 2026-07-10).
 *
 * Samples recent processed calls, re-reads each transcript with the DEEP tier
 * (blind to production output), diffs the decision-critical fields, writes
 * drift metrics to call_audit_findings (audit_source='self_audit'), and alerts
 * ONLY when a threshold breaches:
 *   - any spam false positive (production spam, auditor says real caller)
 *   - field disagreement rate > 3 points above baseline
 *   - disposition mismatch > 5%
 * Silence means healthy. No digests, no FYI pings.
 *
 * Gate: GATE_CALL_SELF_AUDIT. DEEP calls go through createDeepMessage per the
 * repo contract (thinking-block stripping + FLAGSHIP retry on refusal).
 */

const db = require('../models/db');
const logger = require('./logger');
const { isEnabled } = require('../config/feature-gates');
const { createDeepMessage } = require('./llm/deep');
let Anthropic;
try { Anthropic = require('@anthropic-ai/sdk'); } catch { Anthropic = null; }
const MODEL_TIMEOUT_MS = Number(process.env.CALL_SELF_AUDIT_TIMEOUT_MS || 60000);

const SAMPLE_SIZE = Number(process.env.CALL_SELF_AUDIT_SAMPLE || 25);
const BASELINE_DISAGREE_RATE = 0.11; // measured in the 2026-07 mining run (fast-pass diff rate on decision fields)
const FIELD_DRIFT_ALERT = BASELINE_DISAGREE_RATE + 0.03;
const DISPOSITION_MISMATCH_ALERT = 0.05;

const AUDIT_PROMPT = `You are auditing one phone-call analysis for Waves Pest Control (pest control + lawn care, SW Florida; "Agent" = staff). Judge ONLY from the transcript. Return ONLY JSON:
{"is_lead": boolean, "is_spam": boolean, "is_voicemail": boolean, "appointment_agreed": boolean, "quote_promised": boolean, "complaint": boolean, "excerpt": "<=25 words supporting your most important judgment"}
Rules: a two-party conversation (both speakers 3+ turns) is never a voicemail; a caller with a service request/address/quoted price is never spam; an existing customer coordinating a visit is not a new lead.`;

async function runSelfAudit(depsIn = {}) {
  if (!isEnabled('callSelfAudit')) return { skipped: 'gate_off' };
  // createDeepMessage's contract is (client, params) — the caller owns the
  // Anthropic client (per llm/deep.js). Injectable for tests.
  const deps = { ...depsIn };
  if (!deps.createMessage) {
    if (!Anthropic || !process.env.ANTHROPIC_API_KEY) return { skipped: 'no_anthropic_client' };
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, timeout: MODEL_TIMEOUT_MS, maxRetries: 1 });
    deps.createMessage = (params) => createDeepMessage(client, params);
  }

  const calls = await db('call_log')
    .where('direction', 'inbound')
    .whereIn('processing_status', ['processed', 'voicemail', 'spam'])
    .whereRaw("LENGTH(COALESCE(transcription, '')) > 200")
    .where('created_at', '>', db.raw("NOW() - INTERVAL '3 days'"))
    .orderBy('created_at', 'desc')
    .limit(SAMPLE_SIZE)
    .select('id', 'twilio_call_sid', 'created_at', 'processing_status', 'transcription', 'ai_extraction', 'disposition');

  if (!calls.length) return { sampled: 0 };

  let disagreements = 0; let checkedFields = 0; let spamFalsePositives = 0; let dispositionMismatches = 0; let audited = 0;
  for (const call of calls) {
    let verdict;
    try {
      // Blind audit: the model sees ONLY the transcript. Leaking production's
      // status would bias the auditor toward the very label being audited.
      const res = await deps.createMessage({
        max_tokens: 4096,
        system: AUDIT_PROMPT,
        messages: [{ role: 'user', content: `Transcript:\n${call.transcription.slice(0, 5000)}` }],
      });
      const text = (res?.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
      verdict = JSON.parse((text.match(/\{[\s\S]*\}/) || ['{}'])[0]);
    } catch (err) {
      logger.warn(`[self-audit] audit call failed for ${call.id}: ${err.message}`);
      continue;
    }
    audited++;
    const ex = safeParse(call.ai_extraction);
    const prod = {
      is_lead: ex.is_lead === true,
      is_spam: call.processing_status === 'spam' || ex.is_spam === true,
      is_voicemail: call.processing_status === 'voicemail' || ex.is_voicemail === true,
      appointment_agreed: ex.appointment_confirmed === true,
      quote_promised: ex.quote_promised === true,
    };
    const diffs = [];
    for (const f of Object.keys(prod)) {
      checkedFields++;
      if (Boolean(prod[f]) !== Boolean(verdict[f])) { disagreements++; diffs.push(f); }
    }
    if (prod.is_spam && verdict.is_spam === false) spamFalsePositives++;
    // ANY terminal disposition that routes an auditor-confirmed lead away
    // from revenue counts as drift — not just the discard-shaped ones.
    const LEAD_LOSING = ['spam_discarded', 'wrong_number_closed', 'no_action_needed', 'vendor_logged', 'voicemail_processed', 'cancellation_processed'];
    if (call.disposition && verdict.is_lead && LEAD_LOSING.includes(call.disposition)) dispositionMismatches++;

    if (diffs.length) {
      await db('call_audit_findings')
        .insert({
          call_log_id: call.id,
          twilio_call_sid: call.twilio_call_sid,
          call_created_at: call.created_at,
          audit_source: 'self_audit',
          category: prod.is_spam && !verdict.is_spam ? 'spam_false_positive' : 'field_drift',
          severity: prod.is_spam && !verdict.is_spam ? 'customer_harm' : 'data_quality',
          field: diffs[0],
          old_value: String(prod[diffs[0]]),
          new_value: String(Boolean(verdict[diffs[0]])),
          transcript_excerpt: String(verdict.excerpt || '').slice(0, 300),
          detail: JSON.stringify({ diffs, verdict, disposition: call.disposition }),
        })
        .onConflict(['call_log_id', 'audit_source', 'category', 'field'])
        .merge(['old_value', 'new_value', 'transcript_excerpt', 'detail'])
        .catch((err) => logger.warn(`[self-audit] finding write failed: ${err.message}`));
    }
  }

  const fieldRate = checkedFields ? disagreements / checkedFields : 0;
  const dispositionRate = audited ? dispositionMismatches / audited : 0;
  const breaches = [];
  // Auditor-down is itself a breach: a provider/prompt outage must not read
  // as a healthy night — that is exactly the silent-failure class this loop
  // exists to kill.
  if (calls.length > 0 && audited === 0) breaches.push(`auditor down: 0/${calls.length} sampled calls audited`);
  if (spamFalsePositives > 0) breaches.push(`${spamFalsePositives} spam false positive(s)`);
  if (fieldRate > FIELD_DRIFT_ALERT) breaches.push(`field disagreement ${(fieldRate * 100).toFixed(1)}% (baseline ${(BASELINE_DISAGREE_RATE * 100).toFixed(0)}%)`);
  if (dispositionRate > DISPOSITION_MISMATCH_ALERT) breaches.push(`disposition mismatch ${(dispositionRate * 100).toFixed(1)}%`);

  if (breaches.length) {
    logger.error(`[self-audit] DRIFT ALERT: ${breaches.join('; ')} (sample ${audited})`);
    try {
      await db('notifications').insert({
        recipient_type: 'admin',
        category: 'call_pipeline_drift',
        title: 'Call pipeline drift alert',
        body: `Nightly self-audit breached thresholds: ${breaches.join('; ')}. Sample: ${audited} calls. See call_audit_findings (audit_source='self_audit').`,
        created_at: new Date(),
      });
    } catch (err) {
      logger.error(`[self-audit] alert write failed: ${err.message}`);
    }
  } else {
    logger.info(`[self-audit] healthy: ${audited} calls, field rate ${(fieldRate * 100).toFixed(1)}%, 0 spam FPs`);
  }
  return { sampled: calls.length, audited, fieldRate, spamFalsePositives, dispositionRate, breaches };
}

function safeParse(v) { if (!v) return {}; if (typeof v === 'object') return v; try { return JSON.parse(v); } catch { return {}; } }

module.exports = { runSelfAudit };
