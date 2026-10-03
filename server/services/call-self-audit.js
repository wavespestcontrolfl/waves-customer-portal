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
const { isEnabled, typedDecisionsLive, typedDecisionsClefLive } = require('../config/feature-gates');
const { CALL_TRANSCRIPT_CHARS } = require('./typed-decisions/packages');
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

// The direction line as the typed-decision package takes it: the same two
// facts the judge's CALL DIRECTION block carries (who dialed, and that
// outbound speaker labels can be swapped), without the instructions.
function compactDirection(direction) {
  return /^outbound/i.test(String(direction || ''))
    ? 'OUTBOUND: Waves staff placed the call; the person who answered is the customer. Speaker labels may be swapped, so judge parties by what each says.'
    : 'INBOUND: the caller dialed Waves; the person who answered is staff.';
}

// Shadow: put the same call to TypeSafe Jev (call_judge.v2) and record its
// answers beside production's and the deep judge's in decision_reviews. Dark
// behind GATE_TYPED_DECISIONS. With GATE_TYPED_DECISIONS_CLEF also on, the
// same package goes to Cloudflare Clef as a second leg and each provider's
// rows carry the other's answers (siblingAnswers), so a case where they
// differ queues both for the reviewer. Never throws and never touches the
// audit's own findings or counters; it only tallies into `tally`
// ({ asked, recorded, failed } counts calls, not rows; `tally.clef` holds the
// second leg's own counts and exists only while that gate is on).
const JEV_SHARED_FIELDS = ['is_lead', 'is_spam', 'is_voicemail', 'appointment_agreed', 'quote_promised'];
async function shadowJevJudge(call, prod, verdict, tally, gateBaselines = {}) {
  if (!typedDecisionsLive()) return;
  const clef = typedDecisionsClefLive();
  const bool = (v) => (typeof v === 'boolean' ? v : undefined);
  const judgeBaselines = { complaint: { deep_judge: bool(verdict.complaint) } };
  for (const f of JEV_SHARED_FIELDS) judgeBaselines[f] = { production: prod[f], deep_judge: bool(verdict[f]) };
  count(tally, clef, await askAndRecord(call, { packageId: 'call_judge.v2', baselines: judgeBaselines }, clef));
  // The dark call gates' own decisions beside the same providers' answers
  // (call_gate_checks.v1); tallied apart so call_judge's counts keep their meaning.
  // Asked only when the WHOLE transcript fits the span the models and the
  // reviewer are shown (94% of calls, measured 10-02): the baselines come from
  // extractions over the full call, so a cut-off call would show a gate's
  // reason to neither (Codex #5645 r1). Long calls are counted, not asked.
  tally.gateChecks = tally.gateChecks || { asked: 0, recorded: 0, failed: 0, skippedLong: 0 };
  if (String(call.transcription || '').length > CALL_TRANSCRIPT_CHARS) { tally.gateChecks.skippedLong++; return; }
  count(tally.gateChecks, clef, await askAndRecord(call, { packageId: 'call_gate_checks.v1', baselines: gateBaselines }, clef));
}

// Folds one call's { typesafe, cloudflare } outcome into a tally.
function count(tally, clef, outcome) {
  tally.asked++;
  if (outcome.typesafe === 'recorded') tally.recorded++; else tally.failed++;
  if (clef) {
    tally.clef = tally.clef || { asked: 0, recorded: 0, failed: 0 };
    tally.clef.asked++;
    if (outcome.cloudflare === 'recorded') tally.clef.recorded++; else tally.clef.failed++;
  }
}

// What each dark call gate decided for this call, as call_gate_checks.v1's
// `production` baselines. Each is the exact signal the gate acts on:
//   service_unclear      the v2 extraction's ambiguous_pest_or_service flag
//                        (call-triage-flags serviceMayForceAssessment)
//   reschedule_committed the v2 extraction's committed reschedule that the
//                        caller accepted (call-reschedule-apply
//                        planRescheduleFromCall + groundRescheduleAgreement's
//                        caller_accepted_slot check)
//   promise_open         an AI-extracted Waves commitment of a kind the
//                        chaser acts on (SLA_KINDS: callback, send_estimate,
//                        schedule_visit) that a later pass did not drop
// A gate with no reading for the call (no valid v2 extraction; commitments
// off) gets no baseline, never a false one.
function gateCheckBaselines(call, wavesPromiseCallIds) {
  const out = {};
  const v2 = call.v2_extraction_status === 'valid' ? safeParse(call.ai_extraction_enriched) : null;
  if (v2 && Object.keys(v2).length) {
    out.service_unclear = { production: Array.isArray(v2.triage_flags) && v2.triage_flags.includes('ambiguous_pest_or_service') };
    const sched = v2.scheduling || {};
    out.reschedule_committed = {
      production: sched.status === 'reschedule_requested' && sched.agent_committed_booking === true
        && sched.caller_accepted_slot === true && Boolean(sched.confirmed_start_at),
    };
  }
  if (wavesPromiseCallIds) out.promise_open = { production: wavesPromiseCallIds.has(String(call.id)) };
  return out;
}

// Voicemail triage evidence (voicemail.v1, Clef second wave idea 6): every
// INBOUND voicemail (not a sample: ~44 a month), put to the same providers
// once it has finished processing and recorded beside what production decided:
//   callback_requested  production = production put it in front of a person:
//                       the callback alert's durable claim
//                       (call_log.voicemail_callback_alerted_at, stamped before
//                       delivery, so a push-only or bell-silenced alert counts),
//                       a lead minted from the call, or a triage item opened
//                       for it (a failed lead creation opens one)
//   is_vendor_or_spam   production = spam status, the extraction's is_spam, or
//                       a vendor call by the v2 extraction's call_nature
//                       (vendor_or_partner, unless V2's spam verdict cleared
//                       the content: a property manager or referral partner;
//                       a job applicant shares the vendor_logged disposition
//                       but is not a vendor)
//   needs_attention_today  no baseline: nothing decides urgency today
// Two idempotent steps over every terminal, quiet voicemail whose row changed
// in the last 7 days (Codex #5655 r1-r6):
//   ASK      each enabled provider until its answer on the CURRENT transcript
//            is recorded: a missed run, a failed leg or a new transcript is
//            picked up next time, and nothing is asked twice;
//   REFRESH  (no model call) every unreviewed answer's production baseline and
//            review cohort, recomputed from what production shows NOW, so a
//            baseline is never frozen at the moment a question was asked: a
//            retry, a reprocess or a late callback claim all show up on the
//            next pass, and a cohort inherited from an old transcript's row is
//            replaced. A voicemail longer than the span the models and reviewer see is
// counted, never asked (as for the gate checks). Never throws; evidence only.
const VOICEMAIL_STATUSES = ['voicemail', 'processed', 'spam', 'lead_creation_failed', 'extraction_failed'];
const VOICEMAIL_LOOKBACK_DAYS = 7;
// The processor commits a terminal status before its post-terminal side
// effects (the callback alert's claim comes later in the same pass), so a
// voicemail is read only once its row has been quiet this long and nobody
// holds its processing claim (Codex #5655 r5).
const VOICEMAIL_QUIET_MINUTES = 30;

// Phase 1: terminal, quiet inbound voicemails with usable words. The window
// follows the row's last change (updated_at), not its creation, so a voicemail
// that settles late is still read; created_at only bounds how far back.
const VOICEMAIL_MAX_AGE_DAYS = 30;
async function loadVoicemailCandidates(now) {
  const ago = (ms) => new Date(now.getTime() - ms);
  const DAY = 24 * 60 * 60 * 1000;
  const rows = await db('call_log')
    .modify((qb) => require('./voice-agent/relay-protocol').whereNotSandboxCall(qb))
    .whereRaw(INBOUND_DIRECTION_SQL)
    .whereIn('processing_status', VOICEMAIL_STATUSES)
    .where('created_at', '>', ago(VOICEMAIL_MAX_AGE_DAYS * DAY))
    .where('updated_at', '>', ago(VOICEMAIL_LOOKBACK_DAYS * DAY))
    .where('updated_at', '<', ago(VOICEMAIL_QUIET_MINUTES * 60 * 1000))
    .whereNull('processing_token')
    .whereRaw("LENGTH(TRIM(COALESCE(transcription, ''))) > 0")
    // A rejected transcription stores an internal sentinel, not the caller's
    // words (Codex #5655 r4): never evidence.
    .where((q) => q.whereNull('transcription_status').orWhereNot('transcription_status', 'rejected'))
    .orderBy('created_at', 'asc')
    .select('id', 'twilio_call_sid', 'direction', 'processing_status', 'answered_by', 'call_outcome',
      'voicemail_callback_alerted_at', 'transcription', 'ai_extraction', 'ai_extraction_enriched', 'v2_extraction_status', 'duration_seconds');
  return rows.filter(isVoicemailRow);
}

// A lead-path voicemail ends 'processed' (or 'lead_creation_failed'); only the
// extraction says it was a voicemail. A failed extraction has none to say so,
// so the voice webhook's durable channel fields decide. Whether an
// extraction_failed row will still be retried is NOT judged here: a retry that
// changes the outcome is picked up by the next pass's REFRESH (and a new
// transcript by ASK).
function isVoicemailRow(c) {
  if (c.processing_status === 'voicemail' || safeParse(c.ai_extraction).is_voicemail === true) return true;
  return c.processing_status === 'extraction_failed' && (c.answered_by === 'voicemail' || c.call_outcome === 'voicemail');
}

// Phase 2: which enabled providers are done with each voicemail. Done = an
// answer on the CURRENT transcript (subject_hash), or rows that can no longer
// be re-answered (labeled or held out). Also the current answers, the siblings
// a retried leg is compared with.
async function loadProviderState(candidates, currentHash) {
  const rows = await db('decision_reviews').where({ capability: 'voicemail', subject_type: 'call_log' })
    .whereIn('subject_id', candidates.map((c) => c.id))
    .select('subject_id', 'provider', 'question_id', 'jev_answer', 'subject_hash', 'label_status', 'sampled_for');
  const done = new Map();
  const stale = new Map();
  const storedAnswers = new Map();
  const add = (map, key, value) => { if (!map.has(key)) map.set(key, new Set()); map.get(key).add(value); };
  for (const r of rows) {
    const key = String(r.subject_id);
    const current = Boolean(r.subject_hash) && r.subject_hash === currentHash.get(key);
    if (!current && r.label_status === 'unreviewed' && r.sampled_for !== 'heldout') { add(stale, key, r.provider); continue; }
    add(done, key, r.provider);
    if (!current) continue;
    if (!storedAnswers.has(key)) storedAnswers.set(key, {});
    const byQuestion = storedAnswers.get(key);
    (byQuestion[r.question_id] = byQuestion[r.question_id] || []).push(safeParse(r.jev_answer));
  }
  // A provider with any stale, re-answerable row is not done.
  for (const [key, providers] of stale) for (const p of providers) done.get(key)?.delete(p);
  return { done, storedAnswers };
}

// Phase 3: what production decided, read once for the voicemails to ask.
async function loadReachedPerson(voicemails) {
  const sids = voicemails.map((c) => c.twilio_call_sid).filter(Boolean);
  const [leads, triage] = await Promise.all([
    sids.length ? db('leads').whereIn('twilio_call_sid', sids).select('twilio_call_sid') : [],
    db('triage_items').whereIn('call_log_id', voicemails.map((c) => c.id)).distinct('call_log_id'),
  ]);
  return { leadSids: new Set(leads.map((r) => r.twilio_call_sid)), triaged: new Set(triage.map((r) => String(r.call_log_id))) };
}

// The production baselines for one voicemail (see the header).
function voicemailBaselines(call, { leadSids, triaged }) {
  const ex = safeParse(call.ai_extraction);
  const v2 = call.v2_extraction_status === 'valid' ? safeParse(call.ai_extraction_enriched) : {};
  // vendor_or_partner is a pitch only when V2's spam verdict did not clear the
  // content (extraction-compat's rule): a cleared partner is not.
  const vendorPitch = v2.call_nature === 'vendor_or_partner' && v2.spam_verdict?.is_spam_content !== false;
  return {
    callback_requested: { production: Boolean(call.voicemail_callback_alerted_at) || leadSids.has(call.twilio_call_sid) || triaged.has(String(call.id)) },
    is_vendor_or_spam: { production: call.processing_status === 'spam' || ex.is_spam === true || vendorPitch },
  };
}

// Counts one voicemail's asked legs: Jev on the main tally, Clef under .clef.
function tallyLegs(tally, only, outcome) {
  for (const provider of only) {
    const t = provider === 'typesafe' ? tally : (tally.clef = tally.clef || { asked: 0, recorded: 0, failed: 0 });
    t.asked++;
    if (outcome[provider] === 'recorded') t.recorded++; else t.failed++;
  }
}

async function shadowVoicemails({ now = new Date() } = {}) {
  const tally = { asked: 0, recorded: 0, failed: 0, skippedLong: 0 };
  if (!typedDecisionsLive()) return tally;
  try {
    const candidates = await loadVoicemailCandidates(now);
    if (!candidates.length) return tally;
    const { callSubjectHash } = require('./typed-decisions/subject-hash');
    const currentHash = new Map(candidates.map((c) => [String(c.id), callSubjectHash(c.transcription)]));
    const { done, storedAnswers } = await loadProviderState(candidates, currentHash);
    const clef = typedDecisionsClefLive();
    const enabled = clef ? ['typesafe', 'cloudflare'] : ['typesafe'];
    const missingFor = (call) => enabled.filter((p) => !(done.get(String(call.id)) || new Set()).has(p));
    const toAsk = candidates.filter((c) => missingFor(c).length > 0);
    const reached = await loadReachedPerson(candidates);
    for (const call of toAsk) {
      if (String(call.transcription || '').length > CALL_TRANSCRIPT_CHARS) { tally.skippedLong++; continue; }
      const only = missingFor(call);
      const outcome = await askAndRecord(call, {
        packageId: 'voicemail.v1', baselines: voicemailBaselines(call, reached), only, storedSiblings: storedAnswers.get(String(call.id)) || null,
      }, clef);
      tallyLegs(tally, only, outcome);
    }
    for (const call of candidates) {
      await refreshVoicemailEvidence(call, voicemailBaselines(call, reached), currentHash.get(String(call.id)));
    }
  } catch (err) {
    logger.warn(`[self-audit] voicemail shadow failed: ${err.message}`);
  }
  return tally;
}

// REFRESH (no model call): for one voicemail's answers on the current
// transcript, rewrite the production baseline from what production shows now
// and recompute the review cohort with the recorder's own rule (sampleFor: the
// subject-keyed audit draw first, then a disagreement with a baseline or with
// another provider's current answer). Only unreviewed rows that are not held
// out are written; labeled answers still count as siblings. Idempotent.
async function refreshVoicemailEvidence(call, baselines, subjectHash) {
  try {
    const { sampleFor, stableDraw } = require('./typed-decisions/shadow-recorder');
    const rows = await db('decision_reviews')
      .where({ capability: 'voicemail', subject_type: 'call_log', subject_id: call.id, subject_hash: subjectHash })
      .select('id', 'capability', 'package_id', 'subject_type', 'subject_id', 'question_id', 'provider', 'jev_answer', 'baseline_answers', 'sampled_for', 'label_status');
    for (const row of rows) {
      if (row.label_status !== 'unreviewed' || row.sampled_for === 'heldout') continue;
      const baseline = baselines[row.question_id] || null;
      const siblings = rows.filter((r) => r.question_id === row.question_id && r.provider !== row.provider).map((r) => safeParse(r.jev_answer));
      const cohort = sampleFor(safeParse(row.jev_answer), baseline, () => stableDraw(row), siblings);
      const sameBaseline = JSON.stringify(safeParseOrNull(row.baseline_answers)) === JSON.stringify(baseline);
      if (sameBaseline && (row.sampled_for || null) === cohort) continue;
      await db('decision_reviews').where({ id: row.id, label_status: 'unreviewed' }).whereRaw("sampled_for IS DISTINCT FROM 'heldout'")
        .update({ baseline_answers: baseline ? JSON.stringify(baseline) : null, sampled_for: cohort });
    }
  } catch (err) {
    logger.warn(`[self-audit] voicemail evidence refresh failed for ${call.id}: ${err.message}`);
  }
}
const safeParseOrNull = (v) => { if (v == null) return null; if (typeof v === 'object') return v; try { return JSON.parse(v); } catch { return null; } };

// The sampled calls that carry a live AI-extracted Waves promise. null when
// commitments are off (no reading, so no baseline). Never throws.
async function loadWavesPromiseCallIds(calls) {
  if (!typedDecisionsLive() || !isEnabled('callCommitments') || !calls.length) return null;
  try {
    const { staleAiRowSql } = require('./call-commitments');
    // The kinds the promise chaser acts on (Codex #5645 r1): a promise to
    // send a report or paperwork is real but no gate decision.
    const { SLA_KINDS } = require('./followup-sla-watcher');
    const rows = await db('call_commitments as cc')
      .whereIn('cc.call_log_id', calls.map((c) => c.id))
      .where({ 'cc.party': 'waves', 'cc.source': 'ai' })
      .whereIn('cc.kind', SLA_KINDS)
      .whereRaw(`NOT ${staleAiRowSql('cc')}`)
      .distinct('cc.call_log_id');
    return new Set(rows.map((r) => String(r.call_log_id)));
  } catch (err) {
    logger.warn(`[self-audit] commitments read failed: ${err.message}`);
    return null;
  }
}

// What the production extraction recorded for the call_judge fields.
function productionAnswers(call) {
  const ex = safeParse(call.ai_extraction);
  return {
    is_lead: ex.is_lead === true,
    is_spam: call.processing_status === 'spam' || ex.is_spam === true,
    is_voicemail: call.processing_status === 'voicemail' || ex.is_voicemail === true,
    appointment_agreed: ex.appointment_confirmed === true,
    quote_promised: ex.quote_promised === true,
  };
}

// One call to every live provider, then one record per provider that
// answered, each handed the others' answers. Returns { typesafe, cloudflare }
// as 'recorded' | 'failed' (cloudflare only when asked).
async function askAndRecord(call, { packageId, baselines, only = null, storedSiblings = null }, clef = false) {
  // `only`: ask just these providers (a voicemail one provider already answered).
  // `storedSiblings`: { questionId: [answer] } recorded earlier by the providers
  // not asked now, handed to each new row like this run's own siblings.
  const providers = (clef ? ['typesafe', 'cloudflare'] : ['typesafe']).filter((p) => !only || only.includes(p));
  const outcome = Object.fromEntries(providers.map((p) => [p, 'failed']));
  try {
    const { askPackage } = require('./typed-decisions/jev');
    const { packageFor } = require('./typed-decisions/packages');
    const { recordDecisions } = require('./typed-decisions/shadow-recorder');
    const { callSubjectHash, callTranscriptSpan } = require('./typed-decisions/subject-hash');
    const state = {
      call_direction: compactDirection(call.direction),
      duration_seconds: call.duration_seconds ?? null,
      transcript: callTranscriptSpan(call.transcription),
    };
    const legs = await Promise.all(providers.map(async (provider) => {
      try {
        const result = provider === 'typesafe' ? await askPackage(packageId, state) : await askPackage(packageId, state, { provider });
        return result && result.ok ? { provider, result } : null;
      } catch (err) {
        logger.warn(`[self-audit] ${provider} shadow ask (${packageId}) failed for ${call.id}: ${err.message}`);
        return null;
      }
    }));
    const answered = legs.filter(Boolean);
    if (!answered.length) return outcome;
    const pkg = packageFor(packageId);
    const subjectHash = callSubjectHash(call.transcription);
    await Promise.all(answered.map(async ({ provider, result }) => {
      try {
        const siblingAnswers = {};
        for (const [questionId, list] of Object.entries(storedSiblings || {})) {
          siblingAnswers[questionId] = [...list];
        }
        for (const other of answered) {
          if (other.provider === provider) continue;
          for (const [questionId, answer] of Object.entries(other.result.answers || {})) {
            (siblingAnswers[questionId] = siblingAnswers[questionId] || []).push(answer);
          }
        }
        const recorded = await recordDecisions({
          capability: pkg.capability, pkg, provider, subjectType: 'call_log', subjectId: call.id, result, baselines,
          siblingAnswers, subjectHash,
        });
        outcome[provider] = recorded.recorded > 0 ? 'recorded' : 'failed';
      } catch (err) {
        logger.warn(`[self-audit] ${provider} shadow record (${packageId}) failed for ${call.id}: ${err.message}`);
      }
    }));
    return outcome;
  } catch (err) {
    logger.warn(`[self-audit] jev shadow (${packageId}) failed for ${call.id}: ${err.message}`);
    return outcome;
  }
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
    // effort: 'medium' — a bounded per-call yes/no/field-diff audit, not deep
    // reasoning; caps Opus 5.5 spend on a short structured verdict.
    deps.createMessage = (params) => createDeepMessage(client, { laneId: 'call_self_audit', effort: 'medium', ...params });
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
    .select('id', 'twilio_call_sid', 'created_at', 'direction', 'processing_status', 'transcription', 'ai_extraction', 'disposition',
      // Jev shadow: the call's length is part of call_judge's state; the v2
      // extraction carries two dark call gates' own decisions (gateCheckBaselines).
      'duration_seconds', 'ai_extraction_enriched', 'v2_extraction_status');
  const [inboundRows, outboundRows] = await Promise.all([
    sampleDirection(INBOUND_DIRECTION_SQL),
    sampleDirection(OUTBOUND_DIRECTION_SQL),
  ]);
  const calls = stratifySample({ inbound: inboundRows, outbound: outboundRows, size: SAMPLE_SIZE });
  // Every voicemail of the day, independent of the call sample (and of whether there is one).
  const voicemails = await shadowVoicemails();

  if (!calls.length) return { sampled: 0, voicemails };

  let disagreements = 0; let checkedFields = 0; let spamFalsePositives = 0; let dispositionMismatches = 0; let audited = 0;
  const jev = { asked: 0, recorded: 0, failed: 0 };
  const wavesPromiseCallIds = await loadWavesPromiseCallIds(calls);
  for (const call of calls) {
    const gateBaselines = gateCheckBaselines(call, wavesPromiseCallIds);
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
      // Jev is still asked, against production alone: dropping every call the
      // deep judge fails on would bias the shadow sample toward easy calls.
      await shadowJevJudge(call, productionAnswers(call), {}, jev, gateBaselines);
      continue;
    }
    audited++;
    const prod = productionAnswers(call);
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

    await shadowJevJudge(call, prod, verdict, jev, gateBaselines);
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
  return { sampled: calls.length, audited, fieldRate, spamFalsePositives, dispositionRate, breaches, jev, voicemails };
}

function safeParse(v) { if (!v) return {}; if (typeof v === 'object') return v; try { return JSON.parse(v); } catch { return {}; } }

module.exports = { runSelfAudit, stratifySample, OUTBOUND_DIRECTION_SQL, INBOUND_DIRECTION_SQL, callDirectionBlock, gateCheckBaselines, shadowVoicemails };
