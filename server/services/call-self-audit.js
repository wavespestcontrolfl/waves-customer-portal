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

const AUDIT_PROMPT = `You are auditing one phone-call analysis for Waves Pest Control (pest control + lawn care, SW Florida; "Agent" = staff, "Caller" = the external customer/contact). Judge ONLY from the transcript. Return ONLY JSON:
{"is_lead": boolean, "is_spam": boolean, "is_voicemail": boolean, "appointment_agreed": boolean, "quote_promised": boolean, "complaint": boolean, "excerpt": "<=25 words supporting your most important judgment"}
Rules: a two-party conversation (both speakers 3+ turns) is never a voicemail; a caller with a service request/address/quoted price is never spam; an existing customer coordinating a visit is not a new lead. Each transcript is preceded by a CALL DIRECTION line — read it, since it can warn that the printed speaker labels are unreliable and tell you to judge by what each party says instead.`;

const OUTBOUND_DIRECTION_SQL = "COALESCE(direction, '') LIKE 'outbound%'";
const INBOUND_DIRECTION_SQL = "COALESCE(direction, '') NOT LIKE 'outbound%'";

// Speaker labels ("Agent:"/"Caller:") in a diarized transcript can be SWAPPED
// on outbound calls (the 2026-07-11 Copeman call — see call-recording-
// processor.js's own callDirectionBlock in prompts/call-extraction-v1.js,
// and the comment on applyRecurringIntentDefault explaining why the
// recurring-intent backstop and agent-commitment authorization stay
// inbound-only for this same reason). The self-audit samples BOTH directions
// (owner directive 2026-09-26; codex #4912 r1 P2), so — unlike those two
// deterministic, label-scanning helpers, which have no safe outbound
// equivalent yet — this LLM judge is told the direction and, on outbound,
// warned to identify parties by CONTENT rather than trust the label. This
// mirrors production's own decision path (extractCallData /
// extractCallDataV2 pass callDirection for the identical reason) rather than
// inventing a parallel contract.
function callDirectionBlock(direction) {
  const isOutbound = /^outbound/i.test(String(direction || ''));
  return isOutbound
    ? 'CALL DIRECTION: OUTBOUND — Waves staff placed this call; the person who answered is the customer/prospect. This transcript\'s "Agent:"/"Caller:" speaker labels can be SWAPPED on outbound calls — do not trust them. Identify who is staff and who is the customer by what each says (who offers/describes pest control or lawn service vs. who requests it, gives their address, or asks about pricing).\n'
    : 'CALL DIRECTION: INBOUND — the caller dialed Waves; the person who answered is staff.\n';
}

// Reserve up to half the sample for each direction; whatever one direction
// cannot fill goes to the other. Each input is newest-first already.
function stratifySample({ inbound = [], outbound = [], size = SAMPLE_SIZE } = {}) {
  const half = Math.floor(size / 2);
  const outTake = Math.min(outbound.length, Math.max(half, size - inbound.length));
  const inTake = Math.min(inbound.length, size - outTake);
  return [...inbound.slice(0, inTake), ...outbound.slice(0, outTake)];
}

async function runSelfAudit(depsIn = {}) {
  if (!isEnabled('callSelfAudit')) return { skipped: 'gate_off' };
  // createDeepMessage's contract is (client, params) — the caller owns the
  // Anthropic client (per llm/deep.js). Injectable for tests.
  const deps = { ...depsIn };
  if (!deps.createMessage) {
    if (!Anthropic || !process.env.ANTHROPIC_API_KEY) return { skipped: 'no_anthropic_client' };
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, timeout: MODEL_TIMEOUT_MS, maxRetries: 1 });
    deps.createMessage = (params) => createDeepMessage(client, { laneId: 'call_self_audit', ...params });
  }

  // Both directions are sampled (owner directive 2026-09-26: every
  // call-agent rule is audited the same way regardless of who dialed), each
  // from its OWN newest-first query so a burst in one direction can never
  // crowd the other out of a single recency-ordered LIMIT (codex #4912 r1 P2).
  const sampleDirection = (directionSql) => db('call_log')
    .modify((qb) => require('./voice-agent/relay-protocol').whereNotSandboxCall(qb)) // bake-off calls are not audited
    .whereRaw(directionSql)
    .whereIn('processing_status', ['processed', 'voicemail', 'spam'])
    .whereRaw("LENGTH(COALESCE(transcription, '')) > 200")
    .where('created_at', '>', db.raw("NOW() - INTERVAL '3 days'"))
    .orderBy('created_at', 'desc')
    .limit(SAMPLE_SIZE)
    .select('id', 'twilio_call_sid', 'created_at', 'direction', 'processing_status', 'transcription', 'ai_extraction', 'disposition');
  const [inboundRows, outboundRows] = await Promise.all([
    sampleDirection(INBOUND_DIRECTION_SQL),
    sampleDirection(OUTBOUND_DIRECTION_SQL),
  ]);
  const calls = stratifySample({ inbound: inboundRows, outbound: outboundRows, size: SAMPLE_SIZE });

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
        messages: [{ role: 'user', content: `${callDirectionBlock(call.direction)}\nTranscript:\n${call.transcription.slice(0, 5000)}` }],
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

    // One finding per disagreeing field — the ledger keeps the per-field
    // evidence, not just the first hit (a spam FP that also flips is_lead
    // must record both).
    for (const f of diffs) {
      await db('call_audit_findings')
        .insert({
          call_log_id: call.id,
          twilio_call_sid: call.twilio_call_sid,
          call_created_at: call.created_at,
          audit_source: 'self_audit',
          category: f === 'is_spam' && prod.is_spam && !verdict.is_spam ? 'spam_false_positive' : 'field_drift',
          severity: f === 'is_spam' && prod.is_spam && !verdict.is_spam ? 'customer_harm' : 'data_quality',
          field: f,
          old_value: String(prod[f]),
          new_value: String(Boolean(verdict[f])),
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
      // Through NotificationService (not a raw insert) so the
      // GATE_ADMIN_BELL_POLICY chokepoint covers this category.
      await require('./notification-service').notifyAdmin(
        'call_pipeline_drift',
        'Call pipeline drift alert',
        `Nightly self-audit breached thresholds: ${breaches.join('; ')}. Sample: ${audited} calls. See call_audit_findings (audit_source='self_audit').`,
      );
    } catch (err) {
      logger.error(`[self-audit] alert write failed: ${err.message}`);
    }
  } else {
    logger.info(`[self-audit] healthy: ${audited} calls, field rate ${(fieldRate * 100).toFixed(1)}%, 0 spam FPs`);
  }
  return { sampled: calls.length, audited, fieldRate, spamFalsePositives, dispositionRate, breaches };
}

function safeParse(v) { if (!v) return {}; if (typeof v === 'object') return v; try { return JSON.parse(v); } catch { return {}; } }

module.exports = { runSelfAudit, stratifySample, OUTBOUND_DIRECTION_SQL, INBOUND_DIRECTION_SQL, callDirectionBlock };
