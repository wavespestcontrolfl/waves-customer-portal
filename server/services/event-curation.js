/**
 * Event auto-curation — the approval step of the autonomous newsletter
 * lane.
 *
 * The pipeline before this: ingestion (4am) pulls feeds into
 * events_raw, the normalizer (5am) classifies freshness/type, the
 * expiry sweep (5:30) and dedup (5:45) clean up. But approval was
 * 100% manual — when nobody worked the Event Inbox for two weeks the
 * Monday autopilot starved at 0 eligible events and the flagship
 * lane silently died.
 *
 * This cron (6:15am ET, before the 7am Monday autopilot) runs the
 * owner's 2026-07-28 editorial rubric over never-examined pending
 * events. Hard gates (future-dated, has a URL, normalized, fresh) run
 * in SQL; the model CLASSIFIES each event — per-factor scores, penalty
 * flags, hard-policy rejection codes, audience tags, evidence — and
 * deterministic code (event-scoring.js) computes the final 0–100 score
 * and the decision. The editorial questions are no longer "would a
 * local reader go?" but "would readers be disappointed we failed to
 * tell them?" and "is it special enough to justify the drive and the
 * plan?".
 *
 * Auto-approval requires ZERO rejection codes AND score ≥ the feature
 * floor (75, env-tunable). Everything else STAYS pending with its
 * score, codes, and reasoning persisted — the operator can still
 * approve manually; nothing is auto-rejected. An event can never
 * become publishable merely because the issue needs another card.
 *
 * Idempotent per event: examined rows get curated_at and the candidate
 * query excludes them, so each event costs one classification, not one
 * per day. Approvals are guarded on admin_status='pending' so a
 * concurrent operator decision always wins.
 *
 * Kill switch: EVENT_AUTO_CURATION=false (default ON — the owner wants
 * this lane autonomous like the blog lane).
 */

const db = require('../models/db');
const logger = require('./logger');
const {
  etDateString, parseETDateTime, formatETDay, formatETDate, formatETTime,
} = require('../utils/datetime-et');
const {
  excludeRoutineRecurringFromQuery,
  isEligibleForFreshDigest,
} = require('./event-freshness');
const {
  filterPreviouslyFeaturedIdentities,
  filterRepeatedDateIdentities,
} = require('./newsletter-event-selection');
const {
  FACTOR_MAXES,
  REJECTION_CODES,
  assessEvent,
  featureScoreFloor,
  malformedAssessmentReason,
} = require('./event-scoring');

let Anthropic;
try {
  Anthropic = require('@anthropic-ai/sdk');
} catch {
  Anthropic = null;
}

const MODELS = require('../config/models');
const { stripThinkingBlocks } = require('./llm/deep');

// Examined per run. One Claude call per CLASSIFY_BATCH; the structured
// assessment is ~10× the old approve/note payload, so the batch is
// smaller and the token ceiling higher. A fully fresh backlog drains
// within a few runs.
const CURATION_RUN_LIMIT = 120;
const CLASSIFY_BATCH = 12;
const CLASSIFY_MAX_TOKENS = 6000;
const FORWARD_WINDOW_DAYS = 90;
const NOTE_MAX = 200;

function curationEnabled() {
  return process.env.EVENT_AUTO_CURATION !== 'false';
}

/**
 * Hard gates in SQL: only events the digest could actually use reach
 * the model. Never-examined (curated_at NULL) pending rows, classified
 * by the normalizer, future-dated within the digest horizon, with a
 * link, not merged, not stale/expired/needs_review.
 */
function buildCurationCandidateQuery(limit = CURATION_RUN_LIMIT) {
  const etMidnight = parseETDateTime(`${etDateString()}T00:00:00`);
  const horizon = new Date(Date.now() + FORWARD_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const query = db('events_raw as e')
    .leftJoin('event_sources as s', 's.id', 'e.source_id')
    .select(
      'e.id', 'e.title', 'e.description', 'e.start_at', 'e.end_at',
      'e.venue_name', 'e.city', 'e.event_type', 'e.recurrence_type',
      'e.freshness_status', 'e.times_featured', 'e.last_featured_at',
      'e.pulled_at', 'e.is_free', 'e.family_friendly', 'e.event_url',
      'e.price_text', 'e.region_zone',
      'e.admin_status', 'e.merged_into', 's.name as source_name',
    )
    .where('e.admin_status', 'pending')
    .whereNull('e.curated_at')
    .whereNull('e.merged_into')
    .whereNotNull('e.event_url')
    .whereNotNull('e.start_at')
    .whereNotNull('e.normalized_at')
    .where('e.start_at', '>=', etMidnight)
    .where('e.start_at', '<=', horizon)
    .whereNotIn('e.freshness_status', ['expired', 'stale_recurring', 'needs_review'])
    .whereNot('e.event_type', 'unknown');

  return excludeRoutineRecurringFromQuery(query)
    .orderBy('e.start_at', 'asc')
    .limit(limit);
}

async function fetchCurationCandidates(limit = CURATION_RUN_LIMIT) {
  const rows = await buildCurationCandidateQuery(limit);
  // The SQL gate handles normalized metadata. Keep the shared text backstop at
  // this earlier approval boundary too, so mislabeled weekly classes never get
  // auto-approved and later rely on the digest gate to save them.
  const nonRepeatedRows = await filterRepeatedDateIdentities(rows);
  const historicallyNewRows = await filterPreviouslyFeaturedIdentities(nonRepeatedRows);
  // ONE editorial gate for approval and delivery: isEligibleForFreshDigest is
  // the digest's own hard gate, so curation can never approve a row the
  // digest would reject — and, critically, never DROP a row the digest would
  // accept. A plain isRoutineRecurringEvent check here silently discarded
  // fresh_series_launch debuts (the single-use series-debut carve-out),
  // leaving them pending forever.
  const candidates = historicallyNewRows.filter((row) => isEligibleForFreshDigest(row));

  // Rows dropped by the PERMANENT identity filters must be marked
  // examined — the candidate query is start_at-ASC LIMIT-ed, so
  // un-stamped drops (e.g. a debut series' later siblings) would hold the
  // same earliest slots on every run and eventually starve later events
  // out of classification. They stay pending — the note says why, and
  // the operator can still approve manually.
  //
  // Eligibility drops are deliberately NOT stamped: isEligibleForFreshDigest
  // is time-dependent — a limited_run is only admissible in its opening or
  // closing week, an annual can clear its 300-day cooldown — so a row
  // dropped today can be genuinely scoreable next week. Those rows stay
  // curated_at NULL and retry as the reference advances; they are bounded
  // (real limited-run/annual listings, not fan-out spam, which the identity
  // filters above catch and stamp).
  const nonRepeatedIds = new Set(nonRepeatedRows.map((row) => String(row.id)));
  const historicallyNewIds = new Set(historicallyNewRows.map((row) => String(row.id)));
  const policyDrops = rows
    .filter((row) => !historicallyNewIds.has(String(row.id)))
    .map((row) => ({
      id: String(row.id),
      note: !nonRepeatedIds.has(String(row.id))
        ? 'Excluded by policy: repeated-date identity (routine series occurrence)'
        : 'Excluded by policy: identity already featured in a prior issue',
    }));

  return { candidates, policyDrops };
}

function buildCurationPrompt(events, todayIso) {
  const lines = events.map((e) => {
    // Eastern wall-clock with the weekday spelled out — the rubric awards
    // planning points for Friday–Sunday timing, and a raw UTC ISO string
    // shifts every EDT evening event onto the wrong weekday (Thu 8 PM ET
    // renders as Friday midnight UTC).
    const startDate = e.start_at ? new Date(e.start_at) : null;
    const date = startDate && !Number.isNaN(startDate.getTime())
      ? `${formatETDay(startDate)}, ${formatETDate(startDate)}, ${formatETTime(startDate)} ET`
      : 'unknown';
    const desc = (e.description || '').replace(/\s+/g, ' ').slice(0, 300);
    const free = e.is_free === true ? 'yes' : (e.is_free === false ? 'no' : 'unknown');
    const family = e.family_friendly === true ? 'yes' : (e.family_friendly === false ? 'no' : 'unknown');
    return `- id: ${e.id}\n  title: ${e.title}\n  date: ${date}\n  venue: ${e.venue_name || 'unknown'} (${e.city || 'unknown city'})\n  source: ${e.source_name || 'unknown'}\n  free: ${free} | price: ${e.price_text || 'unknown'} | family-friendly: ${family}\n  description: ${desc || '(none)'}`;
  });

  const factorLines = Object.entries(FACTOR_MAXES)
    .map(([name, max]) => `  ${name}: 0-${max}`).join('\n');

  return `You are the editor of the Waves Newsletter's weekly local events issue — a curated guide for Southwest Florida readers from North Port to Tampa. Today's date: ${todayIso}.

Judge every event by TWO questions — not "might someone go?" but:
1. Would a meaningful number of local readers be DISAPPOINTED that we failed to tell them about this?
2. Is it SPECIAL enough to justify the reader's time, drive, planning, and possibly money this week?

Plenty of people "might go" to a library workshop, a boutique promotion, or an ordinary film screening. That does not earn a slot in a regional newsletter. Inaugural events, one-night-only shows, opening weekends, touring acts, annual signature events, and limited engagements do.

Score each event on these factors (integers, each capped at its maximum):
${factorLines}

High marks: specialness = inaugural / one-night-only / opening weekend / touring act / special themed edition / annual signature / limited engagement. reader_pull = a clear "send this to your spouse" hook with regional draw. audience_fit = strong family activity or credible parents' night out with known age suitability. planning_value = Friday-Sunday timing, enough notice, usable date/time/ticket info. local_relevance = locally distinctive, reasonable drive for its significance. source_confidence = official organizer/venue page with current, verifiable details. accessibility = clear pricing, all-ages access where applicable, a free or reasonably priced option.

Penalty flags — set when true (fixed point values are applied in code, you only flag):
  generic_class — ordinary workshop/class with no exceptional element
  retail_promo — store promotion or lead generation dressed up as an event
  ordinary_screening — regular film showing (no restoration, Q&A, anniversary, or reopening hook)

Hard-policy rejection codes — set when ANY apply (the event can then never be auto-approved):
${REJECTION_CODES.map((c) => `  ${c}`).join('\n')}
A class, screening, market, or store event may still qualify WITHOUT a rejection code when it has a genuinely exceptional, verifiable element — the exceptional element must appear in the listing, never invented.

Output STRICT JSON only:
{"assessments": [{"id": "<uuid exactly as given>", "event_type": "<short slug>", "novelty_type": "one_time|inaugural|opening_weekend|closing_weekend|touring|annual_signature|special_edition|limited_engagement|series_debut|ordinary", "family_status": "confirmed|adults_lean|unknown", "audience_tags": ["family"|"parents_night"|"teens"|"free"|"worth_the_drive"], "scores": {"specialness": 0, "reader_pull": 0, "audience_fit": 0, "planning_value": 0, "local_relevance": 0, "source_confidence": 0, "accessibility": 0}, "penalty_flags": [], "rejection_codes": [], "editorial_reason": "<one sentence, max 200 chars>", "evidence": ["<short verifiable statement from the listing>"]}]}

Rules:
- One assessment per input event, using its exact id.
- Score from the LISTING's evidence only — never invent prices, ticket status, or special elements.
- When unsure whether something is special, score it LOW — a human reviews everything that isn't auto-approved.
- Return JSON only — no code fence, no commentary.

Events:
${lines.join('\n')}`;
}

/**
 * Parse + validate the model's assessments. Unknown ids are dropped;
 * a missing assessment means the event stays pending (fail-closed).
 * Factor clamping / code allow-listing happens in event-scoring.
 */
function parseCurationResponse(text, candidateIds) {
  const jsonMatch = String(text || '').match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('Claude did not return JSON for event curation');
  const parsed = JSON.parse(jsonMatch[0]);
  const raw = Array.isArray(parsed.assessments) ? parsed.assessments : [];
  const known = new Set(candidateIds.map(String));
  const seen = new Set();
  const assessments = [];
  for (const a of raw) {
    const id = a && a.id != null ? String(a.id) : null;
    if (!id || !known.has(id) || seen.has(id)) continue;
    seen.add(id);
    assessments.push({ ...a, id });
  }
  return assessments;
}

async function classifyBatch(events, todayIso) {
  if (!Anthropic || !process.env.ANTHROPIC_API_KEY) {
    throw new Error('Anthropic API key not configured (ANTHROPIC_API_KEY)');
  }
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const response = await anthropic.messages.create({
    model: MODELS.WORKHORSE,
    max_tokens: CLASSIFY_MAX_TOKENS,
    system: 'You are a precise, demanding events editor. You output strict JSON and nothing else.',
    messages: [{ role: 'user', content: buildCurationPrompt(events, todayIso) }],
  });
  // Thinking-block guard: WORKHORSE/FAST resolve to a model that can lead
  // with a thinking block (no .text) on larger inputs, which made a blind
  // content[0] read return '' — see event-ingestion.js for the incident.
  const text = stripThinkingBlocks(response).content?.[0]?.text || '';
  return parseCurationResponse(text, events.map((e) => e.id));
}

/**
 * Fallback for batch members the model's response omitted (or the
 * parser dropped as unknown/duplicate ids). Without these the omitted
 * rows keep curated_at NULL, re-enter the candidate pool, and get sent
 * to the model — and billed — again on every run. Fail-closed:
 * omitted = left pending for human review, marked examined, no score.
 */
function missingAssessmentFallbacks(batch, assessments) {
  const decided = new Set(assessments.map((a) => String(a.id)));
  return batch
    .filter((e) => !decided.has(String(e.id)))
    .map((e) => ({ id: String(e.id), __missing: true }));
}

/**
 * Apply one assessed decision. Approval is guarded on
 * admin_status='pending' (a concurrent operator decision wins); the
 * examined-marker update is unguarded so the row never re-enters the
 * candidate pool either way. The structured assessment persists on the
 * row in both branches — the proof diagnostics panel and the Event
 * Inbox read it.
 */
async function applyDecision(event, rawAssessment, reference = new Date()) {
  // Missing AND structurally malformed assessments take the same
  // fail-closed path: examined, pending, and — critically — the
  // structured assessment columns cleared, so a revived occurrence can
  // never keep a prior occurrence's score/codes/evidence attached to a
  // fresh examination (Codex P1/P2 on this PR).
  const malformedReason = rawAssessment.__missing ? null : malformedAssessmentReason(rawAssessment);
  if (rawAssessment.__missing || malformedReason) {
    await db('events_raw')
      .where({ id: event.id })
      .whereNull('curated_at')
      .update({
        editorial_score: null,
        score_breakdown: null,
        rejection_codes: null,
        audience_tags: null,
        novelty_type: null,
        editorial_evidence: null,
        curated_at: db.fn.now(),
        curation_note: rawAssessment.__missing
          ? 'No assessment returned by model'
          : `Malformed assessment: ${malformedReason}`.slice(0, NOTE_MAX),
        updated_at: db.fn.now(),
      });
    return 'left_pending';
  }

  const decision = assessEvent(event, rawAssessment, reference);
  const note = (decision.editorialReason
    || (decision.rejectionCodes.length
      ? `Policy: ${decision.rejectionCodes.join(', ')}`
      : `Scored ${decision.score}/100`)
  ).slice(0, NOTE_MAX);
  const assessmentFields = {
    editorial_score: decision.score,
    score_breakdown: JSON.stringify(decision.breakdown),
    rejection_codes: JSON.stringify(decision.rejectionCodes),
    audience_tags: JSON.stringify(decision.audienceTags),
    novelty_type: decision.noveltyType,
    editorial_evidence: JSON.stringify(decision.evidence),
    curation_note: note,
    updated_at: db.fn.now(),
  };

  if (decision.approve) {
    const updated = await db('events_raw')
      .where({ id: event.id, admin_status: 'pending' })
      .whereNull('merged_into')
      .update({
        ...assessmentFields,
        admin_status: 'approved',
        approved_via: 'auto_curation',
        curated_at: db.fn.now(),
      });
    if (updated) return 'approved';
  }
  await db('events_raw')
    .where({ id: event.id })
    .whereNull('curated_at')
    .update({ ...assessmentFields, curated_at: db.fn.now() });
  return decision.approve ? 'raced' : 'left_pending';
}

/**
 * Cron entry point. Returns a summary for logging/tests.
 */
async function runAutoCuration({ limit = CURATION_RUN_LIMIT } = {}) {
  if (!curationEnabled()) {
    logger.info('[event-curation] disabled via EVENT_AUTO_CURATION=false');
    return { disabled: true, examined: 0, approved: 0 };
  }

  const { candidates, policyDrops } = await fetchCurationCandidates(limit);

  // Stamp policy-dropped rows first so they leave the candidate window
  // even when the model batches below fail. Same guarded write as the
  // missing-assessment fallback: examined, pending, assessment cleared.
  for (const drop of policyDrops) {
    await db('events_raw')
      .where({ id: drop.id })
      .whereNull('curated_at')
      .update({
        editorial_score: null,
        score_breakdown: null,
        rejection_codes: null,
        audience_tags: null,
        novelty_type: null,
        editorial_evidence: null,
        curated_at: db.fn.now(),
        curation_note: drop.note,
        updated_at: db.fn.now(),
      });
  }

  if (!candidates.length) {
    return { examined: 0, approved: 0, policyDropped: policyDrops.length };
  }

  const byId = new Map(candidates.map((e) => [String(e.id), e]));
  const todayIso = etDateString(new Date());
  const reference = new Date();
  let approved = 0;
  let examined = 0;

  for (let i = 0; i < candidates.length; i += CLASSIFY_BATCH) {
    const batch = candidates.slice(i, i + CLASSIFY_BATCH);
    let assessments;
    try {
      assessments = await classifyBatch(batch, todayIso);
    } catch (err) {
      // A failed batch leaves its rows un-examined — they'll be
      // retried next run. Don't fail the whole sweep.
      logger.error(`[event-curation] batch classify failed: ${err.message}`);
      continue;
    }
    for (const assessment of [...assessments, ...missingAssessmentFallbacks(batch, assessments)]) {
      const event = byId.get(String(assessment.id));
      if (!event) continue;
      const outcome = await applyDecision(event, assessment, reference);
      examined += 1;
      if (outcome === 'approved') approved += 1;
    }
  }

  logger.info(`[event-curation] examined ${examined}/${candidates.length}, approved ${approved}, policy-dropped ${policyDrops.length} (feature floor ${featureScoreFloor()})`);
  return { examined, approved, candidates: candidates.length, policyDropped: policyDrops.length };
}

module.exports = {
  runAutoCuration,
  // Exported for unit tests — pure pieces.
  buildCurationPrompt,
  parseCurationResponse,
  missingAssessmentFallbacks,
  curationEnabled,
  buildCurationCandidateQuery,
  applyDecision,
};
