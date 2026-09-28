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

const crypto = require('crypto');
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
  loadSharedYearPool,
} = require('./newsletter-event-selection');
const {
  FACTOR_MAXES,
  FAMILY_STATUSES,
  NOVELTY_TYPES,
  PENALTY_VALUES,
  REJECTION_CODES,
  assessEvent,
  featureScoreFloor,
  malformedAssessmentReason,
} = require('./event-scoring');

const MODELS = require('../config/models');
const { dispatchWithFallback } = require('./llm/call');

// Examined per run. One Claude call per CLASSIFY_BATCH; the structured
// assessment is ~10× the old approve/note payload, so the batch is
// smaller and the token ceiling higher. A fully fresh backlog drains
// within a few runs.
// 60 covers the ~25/day inflow with room; with the 10-minute batch budget
// below, a full run stays inside the lane's 1-hour hard timeout.
const CURATION_RUN_LIMIT = 60;
const CLASSIFY_BATCH = 12;
// Owner ruling 2026-09-27: curation scoring moved to Opus 5.5 at effort
// 'max' (MODELS.TEXT_POLICIES.newsletterWriter). Opus 5+ always thinks and
// spends that from max_tokens ahead of the JSON reply (anthropic-wire.js
// THINKING_FLOOR_TOKENS=8192 is only a floor, not a budget for 'max' effort's
// actual thinking depth), so the old 6000-token cap — sized for a
// non-thinking Sonnet reply — risked truncating a 12-event structured batch
// mid-JSON. 24000 gives headroom for max-effort thinking plus the reply.
const CLASSIFY_MAX_TOKENS = 24000;
// Per-batch wall-clock budget. At most CURATION_RUN_LIMIT/CLASSIFY_BATCH = 5
// sequential batches per run; 10 minutes/batch (≈5 per leg once the fallback
// reserve is split off — max effort on a 12-event batch needs it) keeps a
// full run under 50 minutes, inside the events_curation lane's 1-hour hard_timeout
// (agent-control/lane-policies.js LONG_BATCH). reserveFallbackBudget so a
// slow/failed Opus leg still leaves the OpenAI fallback real time instead of
// losing the whole share to the primary.
const CLASSIFY_TIMEOUT_MS = 10 * 60 * 1000;
const FORWARD_WINDOW_DAYS = 90;
const NOTE_MAX = 200;
// Rescore pass (deterministic, no model call — see runScoreRescore): bounded
// generously since it's pure SQL + arithmetic, not an LLM call.
const RESCORE_RUN_LIMIT = 1000;

function curationEnabled() {
  return process.env.EVENT_AUTO_CURATION !== 'false';
}

// Freshness statuses that hard-reject a row UNCONDITIONALLY, regardless of
// when it was first examined or what the routine/first-of-year gate below
// would otherwise say — shared by fresh curation AND the rescore pass (Codex
// P1: the rescore path used to skip this gate entirely, so an operator flip
// to needs_review/expired after the original assessment never blocked a
// stale stored score from later auto-approving).
//
// 'stale_recurring' is deliberately NOT in this list (Codex P1, 2026-09-27,
// second pass) — it used to be, and that was itself a bug: this constant is
// ANDed at the top level of the query, OUTSIDE excludeRoutineRecurringFromQuery's
// own OR-group. Excluding 'stale_recurring' here unconditionally meant EVERY
// stale_recurring row was removed before it ever reached that OR-group's
// third branch (the NOT EXISTS "no earlier-this-ET-year sibling" admission)
// — so a continuity-proven first-of-year weekly/monthly row, which normally
// KEEPS the normalizer's 'stale_recurring' classification (classifyFreshness
// has no pool access and can't know about continuity), could never be
// admitted at all, silently defeating that whole admission mechanism. A
// stale_recurring row's fate is decided ENTIRELY by
// excludeRoutineRecurringFromQuery now: routine metadata + no earlier sibling
// this year ⇒ admitted (to be re-verified by the JS gate below); routine
// metadata + an earlier sibling exists ⇒ excluded, same as before.
const CURATION_FRESHNESS_EXCLUSIONS = Object.freeze(['expired', 'needs_review']);

/**
 * Hard gates shared by fresh curation's candidate query AND the deterministic
 * rescore pass's candidate query (Codex P1, 2026-09-27): not merged, has a
 * link, dated, normalized, not a hard-rejected freshness status, not an
 * unknown event type, and not routine-recurring (excludeRoutineRecurringFromQuery,
 * itself widened the same day to admit a genuine first-of-year occurrence).
 * Callers add their own admin_status / curated_at / start_at-window
 * conditions on top — those differ between "never examined" and "already
 * curated, re-checking under current rules".
 */
function applyCurationHardGates(query, alias = 'e') {
  const col = (name) => `${alias}.${name}`;
  return excludeRoutineRecurringFromQuery(
    query
      .whereNull(col('merged_into'))
      .whereNotNull(col('event_url'))
      .whereNotNull(col('start_at'))
      .whereNotNull(col('normalized_at'))
      .whereNotIn(col('freshness_status'), CURATION_FRESHNESS_EXCLUSIONS)
      .whereNot(col('event_type'), 'unknown'),
    alias,
  );
}

const CANDIDATE_COLUMNS = [
  'e.id', 'e.title', 'e.description', 'e.start_at', 'e.end_at',
  'e.venue_name', 'e.city', 'e.event_type', 'e.recurrence_type',
  'e.freshness_status', 'e.times_featured', 'e.last_featured_at',
  'e.pulled_at', 'e.is_free', 'e.family_friendly', 'e.event_url',
  'e.price_text', 'e.region_zone',
  'e.admin_status', 'e.merged_into',
  // Version pin for applyDecision's approval/assessment writes (Codex P1,
  // 2026-09-27: "Revalidate content before initial auto-approval") — the
  // classify call can take up to CLASSIFY_TIMEOUT_MS (10 min), during which
  // ingestion or an admin edit can change this row's content underneath a
  // candidate already fetched for classification.
  'e.updated_at',
];

/**
 * Hard gates in SQL: only events the digest could actually use reach
 * the model. Never-examined (curated_at NULL) pending rows, classified
 * by the normalizer, future-dated within the digest horizon, with a
 * link, not merged, not expired/needs_review, and not routine-recurring
 * unless it could be this ET calendar year's first occurrence (a
 * 'stale_recurring' row is admitted or rejected entirely by
 * excludeRoutineRecurringFromQuery, never by a blanket freshness_status
 * exclusion — see CURATION_FRESHNESS_EXCLUSIONS).
 */
function buildCurationCandidateQuery(limit = CURATION_RUN_LIMIT) {
  const etMidnight = parseETDateTime(`${etDateString()}T00:00:00`);
  const horizon = new Date(Date.now() + FORWARD_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const query = db('events_raw as e')
    .leftJoin('event_sources as s', 's.id', 'e.source_id')
    .select(...CANDIDATE_COLUMNS, 's.name as source_name')
    .where('e.admin_status', 'pending')
    .whereNull('e.curated_at')
    .where('e.start_at', '>=', etMidnight)
    .where('e.start_at', '<=', horizon);

  return applyCurationHardGates(query)
    .orderBy('e.start_at', 'asc')
    .limit(limit);
}

/**
 * The identity/history eligibility pipeline shared by fresh curation and the
 * rescore pass (Codex P1, 2026-09-27): filterRepeatedDateIdentities (routine/
 * first-of-year), filterPreviouslyFeaturedIdentities (cross-row feature
 * history), then isEligibleForFreshDigest — the SAME order and the SAME
 * functions used to decide what the digest itself will accept, so neither
 * pass can approve a row the digest would reject.
 */
async function runCurationEligibilityPipeline(rows, { reference = new Date(), knex = db } = {}) {
  // One calendar-year identity pool for this batch, shared by both filters
  // below (Codex P2, 2026-09-27: "Reuse the calendar-year pool across
  // eligibility filters") instead of each loading its own copy.
  const yearPool = await loadSharedYearPool(knex, rows, reference);
  // The SQL gate handles normalized metadata. Keep the shared text backstop at
  // this earlier approval boundary too, so mislabeled weekly classes never get
  // auto-approved and later rely on the digest gate to save them.
  const nonRepeatedRows = await filterRepeatedDateIdentities(rows, { knex, reference, yearPool });
  const historicallyNewRows = await filterPreviouslyFeaturedIdentities(nonRepeatedRows, { knex, reference, yearPool });
  // ONE editorial gate for approval and delivery: isEligibleForFreshDigest is
  // the digest's own hard gate, so curation can never approve a row the
  // digest would reject — and, critically, never DROP a row the digest would
  // accept. A plain isRoutineRecurringEvent check here silently discarded
  // fresh_series_launch debuts (the single-use series-debut carve-out),
  // leaving them pending forever.
  const candidates = historicallyNewRows.filter((row) => isEligibleForFreshDigest(row, reference));
  return { nonRepeatedRows, historicallyNewRows, candidates };
}

async function fetchCurationCandidates(limit = CURATION_RUN_LIMIT) {
  const rows = await buildCurationCandidateQuery(limit);
  const { nonRepeatedRows, historicallyNewRows, candidates } = await runCurationEligibilityPipeline(rows);

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
  const isAnnual = (row) => row.event_type === 'annual' || row.recurrence_type === 'annual';
  const policyDrops = rows
    .filter((row) => !historicallyNewIds.has(String(row.id)))
    // An ANNUAL row dropped by the previously-featured filter is a
    // time-dependent decision — isEditoriallyNewEvent re-admits it after
    // the 300-day cooldown — so it stays unstamped and retries, like the
    // eligibility drops below. Non-annual featured-history drops and all
    // repeated-identity drops are permanent and stamp.
    .filter((row) => !(nonRepeatedIds.has(String(row.id)) && isAnnual(row)))
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

High marks: specialness = inaugural / one-night-only / opening weekend / touring act / special themed edition / annual signature / limited engagement — a major touring headliner or a pro sports team's home match is high specialness and reader_pull regardless of who else it skews toward; score the draw, not a narrow definition of "special". reader_pull = a clear "send this to your spouse" hook with regional draw. audience_fit = judge the event on its OWN terms — a strong family activity, a credible parents' night out, OR a broadly appealing event for the general adult reader (concert, sports, festival) can all score high; do not dock audience_fit just because an event skews toward one audience instead of splitting evenly across several. planning_value = Friday-Sunday timing, enough notice, usable date/time/ticket info. local_relevance = locally distinctive, reasonable drive for its significance. source_confidence = the listing's OWN reliability as a source, not whether it also states a price — an official venue page, museum, performing-arts hall, tourism board, or municipal calendar publishing ITS OWN event is a 9-10 by default; only dock it for a stale, third-party, or otherwise unverifiable listing. accessibility = judge what's actually knowable — public and reasonably reachable, and if the listing does say it's ticketed or free that supports a higher score — but do NOT zero or heavily penalize an otherwise normal, attendable public event just because the feed happens not to state a price or minimum age; those two facts are frequently absent from official listings and are not by themselves an accessibility problem.

Penalty flags — set when true (fixed point values are applied in code, you only flag):
  generic_class — ordinary workshop/class with no exceptional element
  retail_promo — store promotion or lead generation dressed up as an event
  ordinary_screening — regular film showing (no restoration, Q&A, anniversary, or reopening hook)

Hard-policy rejection codes — set when ANY apply (the event can then never be auto-approved):
${REJECTION_CODES.map((c) => `  ${c}`).join('\n')}
A class, screening, market, or store event may still qualify WITHOUT a rejection code when it has a genuinely exceptional, verifiable element — the exceptional element must appear in the listing, never invented.

Per assessment: the event's exact id, a short event_type slug, novelty_type, family_status, audience_tags (from: family, parents_night, teens, free, worth_the_drive), the seven scores, penalty_flags, rejection_codes, a one-sentence editorial_reason (max 200 chars), and evidence (short verifiable statements from the listing).

Rules:
- One assessment per input event, using its exact id.
- Score from the LISTING's evidence only — never invent prices, ticket status, or special elements.
- When unsure whether something is special, score it LOW — a human reviews everything that isn't auto-approved.
Events:
${lines.join('\n')}`;
}

/**
 * Parse + validate the model's assessments. Unknown ids are dropped;
 * a missing assessment means the event stays pending (fail-closed).
 * Factor clamping / code allow-listing happens in event-scoring.
 */
// Structured-output contract (llm/call.js jsonSchema). Score maxima are
// outside the provider subset — normalizeAssessment still clamps them, and
// parseCurationResponse still drops unknown / duplicate ids.
const CURATION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['assessments'],
  properties: {
    assessments: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'event_type', 'novelty_type', 'family_status', 'audience_tags', 'scores', 'penalty_flags', 'rejection_codes', 'editorial_reason', 'evidence'],
        properties: {
          id: { type: 'string', description: 'The event id exactly as given' },
          event_type: { type: 'string', description: 'Short slug' },
          novelty_type: { type: 'string', enum: NOVELTY_TYPES },
          family_status: { type: 'string', enum: FAMILY_STATUSES },
          audience_tags: { type: 'array', items: { type: 'string', enum: ['family', 'parents_night', 'teens', 'free', 'worth_the_drive'] } },
          scores: {
            type: 'object',
            additionalProperties: false,
            required: Object.keys(FACTOR_MAXES),
            properties: Object.fromEntries(Object.keys(FACTOR_MAXES).map((k) => [k, { type: 'integer' }])),
          },
          penalty_flags: { type: 'array', items: { type: 'string', enum: Object.keys(PENALTY_VALUES) } },
          rejection_codes: { type: 'array', items: { type: 'string', enum: REJECTION_CODES } },
          editorial_reason: { type: 'string', description: 'One sentence, max 200 chars' },
          evidence: { type: 'array', items: { type: 'string' }, description: 'Short verifiable statements from the listing' },
        },
      },
    },
  },
};

function parseCurationResponse(parsed, candidateIds) {
  if (!parsed || typeof parsed !== 'object') throw new Error('Claude did not return JSON for event curation');
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
  // A miss on both legs throws, exactly like the old SDK path — the run
  // loop's catch leaves the batch un-examined for the next run. Owner
  // ruling 2026-09-27: curation scoring rides the newsletterWriter policy
  // (Opus 5.5, effort max) — its own laneId ('events_curation', split from
  // the old shared 'events_editorial' laneId so ledger/Control-center rows
  // attribute correctly; event-normalizer.js keeps 'events_editorial' on
  // contentDraft).
  const res = await dispatchWithFallback(MODELS.TEXT_POLICIES.newsletterWriter, {
    laneId: 'events_curation',
    system: 'You are a precise, demanding events editor.',
    text: buildCurationPrompt(events, todayIso),
    jsonMode: true,
    jsonSchema: CURATION_SCHEMA,
    maxTokens: CLASSIFY_MAX_TOKENS,
    timeoutMs: CLASSIFY_TIMEOUT_MS,
  }, { reserveFallbackBudget: true });
  if (!res.ok || !res.json) throw new Error(`event curation LLM unavailable (${res.reason || 'no_json'})`);
  return parseCurationResponse(res.json, events.map((e) => e.id));
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
/**
 * Fingerprint of the content the model actually assessed: the fields the
 * classify prompt shows plus the classification that gates eligibility.
 * Stored inside score_breakdown at curation time; the rescore pass compares
 * it with the row's current content. updated_at can't serve: daily
 * ingestion advances it on every re-pull even when nothing changed.
 */
function contentFingerprint(row) {
  const iso = (value) => {
    const t = value ? new Date(value) : null;
    return t && !Number.isNaN(t.getTime()) ? t.toISOString() : null;
  };
  const payload = [
    row?.title ?? null, row?.description ?? null, iso(row?.start_at), iso(row?.end_at),
    row?.venue_name ?? null, row?.city ?? null, row?.is_free ?? null, row?.family_friendly ?? null,
    row?.price_text ?? null, row?.event_url ?? null, row?.event_type ?? null, row?.recurrence_type ?? null,
  ];
  return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

function storedBreakdown(row) {
  let breakdown = row?.score_breakdown;
  if (typeof breakdown === 'string') { try { breakdown = JSON.parse(breakdown); } catch { breakdown = null; } }
  return breakdown && typeof breakdown === 'object' && !Array.isArray(breakdown) ? breakdown : null;
}

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
    score_breakdown: JSON.stringify({ ...decision.breakdown, content_fingerprint: contentFingerprint(event) }),
    rejection_codes: JSON.stringify(decision.rejectionCodes),
    audience_tags: JSON.stringify(decision.audienceTags),
    novelty_type: decision.noveltyType,
    editorial_evidence: JSON.stringify(decision.evidence),
    curation_note: note,
    updated_at: db.fn.now(),
  };

  // Codex P1, 2026-09-27: "Revalidate content before initial auto-approval".
  // The classify call can take up to CLASSIFY_TIMEOUT_MS (10 minutes);
  // ingestion (or an admin edit) can change this row's title/description/
  // start_at/event_url/recurrence_type underneath a candidate already
  // fetched for classification, and an approved row never re-enters rescore
  // — so an approval (or even just stamping curated_at from this decision)
  // must be pinned to the EXACT version this assessment was computed from.
  // Same date_trunc('milliseconds', …) comparison applyRescore uses: pg's
  // timestamptz is microsecond-precision, but node-pg reads it back as a
  // millisecond-precision JS Date, so a plain `=` never matches even the
  // unchanged row it was just read from.
  const unchangedSinceFetch = (query) => query
    .whereRaw("date_trunc('milliseconds', updated_at) = ?", [event.updated_at]);

  if (decision.approve) {
    const updated = await unchangedSinceFetch(
      db('events_raw')
        .where({ id: event.id, admin_status: 'pending' })
        .whereNull('merged_into'),
    ).update({
      ...assessmentFields,
      admin_status: 'approved',
      approved_via: 'auto_curation',
      curated_at: db.fn.now(),
    });
    if (updated) return 'approved';
  }
  const updated = await unchangedSinceFetch(
    db('events_raw').where({ id: event.id }).whereNull('curated_at'),
  ).update({ ...assessmentFields, curated_at: db.fn.now() });
  if (updated) return decision.approve ? 'raced' : 'left_pending';
  // Version mismatch: the row's content changed since it was fetched for
  // classification (or it was already examined by a concurrent run). Leave
  // it exactly as-is — curated_at is untouched — so the next run classifies
  // the row's CURRENT content instead of stamping a decision computed from
  // content that no longer matches.
  return 'left_pending';
}

/**
 * Rescore candidates: upcoming (start_at in the future), still-pending,
 * already-curated (curated_at set) rows with a stored score_breakdown.
 *
 * Codex P1 (2026-09-27): this used to say "NOT filtered by freshness/
 * eligibility the way fetchCurationCandidates is — those hard gates already
 * ran when the row was first curated, and haven't changed since." That
 * assumption is false — an operator can flip freshness_status to
 * needs_review/expired, or a later merge can set merged_into, on a row that
 * keeps its curated_at and score_breakdown untouched. The query now shares
 * applyCurationHardGates with fresh curation, and runScoreRescore below runs
 * the SAME identity/eligibility pipeline (runCurationEligibilityPipeline)
 * before ever approving, so a row that is no longer eligible under CURRENT
 * rules can never ride a stale assessment to approval.
 */
function buildRescoreCandidateQuery(limit = RESCORE_RUN_LIMIT) {
  const query = db('events_raw as e')
    .select(...CANDIDATE_COLUMNS, 'e.score_breakdown', 'e.rejection_codes', 'e.audience_tags',
      'e.novelty_type', 'e.editorial_evidence', 'e.curation_note', 'e.curated_at')
    .where('e.admin_status', 'pending')
    .whereNotNull('e.curated_at')
    .whereNotNull('e.score_breakdown')
    .where('e.start_at', '>=', new Date());

  return applyCurationHardGates(query)
    .orderBy('e.start_at', 'asc')
    .limit(limit);
}

/**
 * True when the row's content no longer matches what the model assessed —
 * or when that can't be proven (rows curated before content fingerprints
 * existed carry none). Either way the stored assessment can't be trusted
 * for an approval, so the caller returns the row to fresh curation. Codex
 * P1: a later re-pull that replaces the description with a cancellation
 * notice must never let a pre-cancellation stored score ride to approval.
 */
function hasContentChangedSinceCuration(row) {
  const stored = storedBreakdown(row)?.content_fingerprint;
  return !stored || stored !== contentFingerprint(row);
}

/**
 * Send a rescore candidate back to fresh curation instead of ever rescoring
 * it from a STALE assessment: clears the stored assessment and curated_at so
 * the row re-enters buildCurationCandidateQuery's own pool (curated_at IS
 * NULL) for a real model re-examination. Guarded exactly like applyDecision's
 * fail-closed paths (admin_status='pending', merged_into IS NULL) so a
 * concurrent operator decision always wins.
 */
async function revalidateStaleRescoreCandidate(row, note) {
  await db('events_raw')
    .where({ id: row.id, admin_status: 'pending' })
    .whereNull('merged_into')
    .update({
      editorial_score: null,
      score_breakdown: null,
      rejection_codes: null,
      audience_tags: null,
      novelty_type: null,
      editorial_evidence: null,
      curated_at: null,
      curation_note: note.slice(0, NOTE_MAX),
      updated_at: db.fn.now(),
    });
}

/**
 * Deterministic rescore of one already-curated row — NO model call. Rebuilds
 * the model's original structured assessment from what's already stored
 * (score_breakdown.factors / .penalty_flags / .family_status,
 * rejection_codes, audience_tags, novelty_type, editorial_evidence) and runs
 * it back through the same assessEvent() the initial curation used, so the
 * decision math (and any future scoring-rule change) never has two
 * implementations. Returns null when the stored breakdown is missing or
 * malformed (nothing to reconstruct from — left for a human, same as
 * curation's own missing/malformed path).
 */
function rescoreCuratedEvent(row) {
  let breakdown = row.score_breakdown;
  if (typeof breakdown === 'string') { try { breakdown = JSON.parse(breakdown); } catch { breakdown = null; } }
  if (!breakdown || typeof breakdown !== 'object' || Array.isArray(breakdown) || !breakdown.factors) return null;

  const parseArray = (value) => {
    let v = value;
    if (typeof v === 'string') { try { v = JSON.parse(v); } catch { v = []; } }
    return Array.isArray(v) ? v : [];
  };

  const rawAssessment = {
    scores: breakdown.factors,
    penalty_flags: breakdown.penalty_flags,
    rejection_codes: parseArray(row.rejection_codes),
    audience_tags: parseArray(row.audience_tags),
    novelty_type: row.novelty_type,
    family_status: breakdown.family_status,
    editorial_reason: row.curation_note,
    evidence: parseArray(row.editorial_evidence),
  };
  if (malformedAssessmentReason(rawAssessment)) return null;
  return assessEvent(row, rawAssessment);
}

/**
 * Persist one rescore decision. Guarded on admin_status='pending' like
 * applyDecision's approval branch (a concurrent operator decision always
 * wins) — but UNLIKE applyDecision, curated_at is never touched: the row was
 * already examined by the model, this only recomputes deterministic math
 * under whatever rules are live now. The score is written whether or not it
 * now clears the floor, so the Event Inbox never shows a score computed
 * under retired penalty rules.
 *
 * `canApprove` (Codex P1, 2026-09-27) is the caller's own current-eligibility
 * verdict (runScoreRescore's runCurationEligibilityPipeline + freshness
 * check) — decision.approve is ONLY the deterministic score math, so it can't
 * by itself know the row was later marked needs_review/expired or lost its
 * event_url. The approval UPDATE also re-checks the column-level hard gates
 * in its own WHERE, atomically, in case they changed between the SELECT
 * above and this write. The content fingerprint rides along unchanged in the
 * rewritten score_breakdown, so the next rescore pass still compares against
 * what the model actually assessed.
 *
 * Codex P1, 2026-09-27 (second pass): hasContentChangedSinceCuration in the
 * caller only inspects the batch's OWN fetch-time snapshot — it catches drift
 * that happened before this rescore run started, not a write that lands
 * DURING it (a long batch processes many rows; a concurrent ingestion
 * re-pull or admin edit can land on THIS row between the initial SELECT and
 * this UPDATE). The approval UPDATE is therefore made optimistic: its WHERE
 * also pins `updated_at` and `curated_at` to the exact values this decision
 * was computed from (`row`, the SELECT snapshot), so ANY concurrent write to
 * either column — not just one that happens to touch a gate column this
 * function already checks — makes it match 0 rows instead of approving from
 * math that may no longer describe the row.
 *
 * The comparison is via date_trunc('milliseconds', …), NOT plain `=` —
 * verified against real Postgres: pg's timestamptz has microsecond
 * precision, but node-postgres reads it back into a JS Date, which is
 * MILLISECOND precision. A plain `.where('updated_at', row.updated_at)`
 * therefore compares a millisecond-truncated value against the column's own
 * full microsecond value and NEVER matches — not even the unchanged row it
 * was just read from — which would silently zero out every rescore approval
 * forever. Truncating the column to the same millisecond precision before
 * comparing is what makes "unchanged" actually match while a genuine
 * concurrent write (which moves the value by more than a truncation
 * rounding) still does not.
 */
async function applyRescore(row, decision, { canApprove = decision.approve } = {}) {
  const note = (decision.editorialReason
    || (decision.rejectionCodes.length
      ? `Policy: ${decision.rejectionCodes.join(', ')}`
      : `Scored ${decision.score}/100`)
  ).slice(0, NOTE_MAX);
  const assessmentFields = {
    editorial_score: decision.score,
    score_breakdown: JSON.stringify({
      ...decision.breakdown,
      content_fingerprint: storedBreakdown(row)?.content_fingerprint ?? null,
    }),
    curation_note: note,
  };
  // Every rescore write is pinned to the snapshot the decision came from; on
  // a version mismatch the row is left untouched for the next run.
  const unchangedSinceRead = () => db('events_raw')
    .where({ id: row.id, admin_status: 'pending' })
    .whereNull('merged_into')
    .whereRaw("date_trunc('milliseconds', updated_at) = ?", [row.updated_at])
    .whereRaw("date_trunc('milliseconds', curated_at) = ?", [row.curated_at]);
  if (canApprove) {
    const updated = await unchangedSinceRead()
      .whereNotNull('event_url')
      .whereNot('event_type', 'unknown')
      .whereNotIn('freshness_status', CURATION_FRESHNESS_EXCLUSIONS)
      .update({ ...assessmentFields, admin_status: 'approved', approved_via: 'auto_curation' });
    if (updated) return 'approved';
  }
  const updated = await unchangedSinceRead().update(assessmentFields);
  return updated ? (canApprove ? 'raced' : 'rescored') : 'skipped';
}

/**
 * Daily deterministic rescore (no model call, no cost): recomputes the
 * editorial score of every upcoming, still-pending, already-curated event
 * from its stored assessment under whatever penalty rules are LIVE NOW, and
 * auto-approves through the same guarded path as fresh curation when the
 * recomputed score clears the feature floor with zero rejection codes AND the
 * row is STILL eligible under the current rules (Codex P1, 2026-09-27):
 *   - a row whose content changed since it was assessed (ingestion re-pull,
 *     normalizer reclassification, or an admin edit — hasContentChangedSince-
 *     Curation) is never rescored from the stale assessment; it's sent back
 *     to fresh curation for a real re-examination instead.
 *   - a row that no longer clears the SAME eligibility gates fresh curation
 *     itself requires (runCurationEligibilityPipeline: routine/first-of-year,
 *     feature history, isEligibleForFreshDigest — e.g. an operator flipped
 *     freshness_status to needs_review/expired, or a merge landed) is left
 *     exactly as-is: its deterministic math is never recomputed into an
 *     approval it shouldn't have. An operator can still approve manually.
 *
 * Exists because curation examines each event ONCE (curated_at) — an event
 * penalized under a rule that later changes (e.g. the 2026-09-27
 * missing_price/unclear_age removal) would otherwise sit under-scored and
 * pending forever, never re-examined. Idempotent: re-running recomputes the
 * same deterministic value from the same stored factors every time, and an
 * approved row drops out of the admin_status='pending' candidate set on the
 * next run. Shares the EVENT_AUTO_CURATION kill switch with fresh curation —
 * both auto-approve through the same path.
 */
async function runScoreRescore({ limit = RESCORE_RUN_LIMIT } = {}) {
  if (!curationEnabled()) {
    return { disabled: true, candidates: 0, rescored: 0, approved: 0 };
  }
  const rows = await buildRescoreCandidateQuery(limit);
  if (!rows.length) {
    logger.info(`[event-curation] rescore: 0/0 candidates updated, 0 newly approved (feature floor ${featureScoreFloor()})`);
    return {
      candidates: 0, rescored: 0, approved: 0, revalidated: 0,
    };
  }

  const reference = new Date();
  let eligibleIds;
  try {
    const { candidates } = await runCurationEligibilityPipeline(rows, { reference });
    eligibleIds = new Set(candidates.map((row) => String(row.id)));
  } catch (err) {
    // Fail closed: an eligibility-check failure must never fall back to
    // approving from stale math unchecked. Leave every row exactly as-is —
    // the next run retries.
    logger.error(`[event-curation] rescore eligibility check failed: ${err.message}`);
    return {
      candidates: rows.length, rescored: 0, approved: 0, revalidated: 0,
    };
  }

  let rescored = 0;
  let approved = 0;
  let revalidated = 0;
  for (const row of rows) {
    if (hasContentChangedSinceCuration(row)) {
      await revalidateStaleRescoreCandidate(row, 'Returned to fresh curation: row content changed since it was last assessed');
      revalidated += 1;
      continue;
    }
    const decision = rescoreCuratedEvent(row);
    if (!decision) continue;
    const canApprove = decision.approve && eligibleIds.has(String(row.id));
    const outcome = await applyRescore(row, decision, { canApprove });
    if (outcome === 'approved' || outcome === 'rescored' || outcome === 'raced') rescored += 1;
    if (outcome === 'approved') approved += 1;
  }
  logger.info(`[event-curation] rescore: ${rescored}/${rows.length} candidates updated, ${approved} newly approved, ${revalidated} returned to fresh curation (feature floor ${featureScoreFloor()})`);
  return {
    candidates: rows.length, rescored, approved, revalidated,
  };
}

/**
 * Cron entry point. Returns a summary for logging/tests.
 */
async function runAutoCuration({ limit = CURATION_RUN_LIMIT } = {}) {
  if (!curationEnabled()) {
    logger.info('[event-curation] disabled via EVENT_AUTO_CURATION=false');
    return { disabled: true, examined: 0, approved: 0 };
  }

  // Deterministic rescore of already-curated upcoming events runs first
  // (same daily cron, no extra registration needed) — cheap (no model
  // call), so it never risks the classify batches' token/time budget below.
  const rescore = await runScoreRescore().catch((err) => {
    logger.error(`[event-curation] rescore pass failed: ${err.message}`);
    return { candidates: 0, rescored: 0, approved: 0 };
  });

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
    return {
      examined: 0, approved: 0, policyDropped: policyDrops.length, rescore,
    };
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
  return {
    examined, approved, candidates: candidates.length, policyDropped: policyDrops.length, rescore,
  };
}

module.exports = {
  runAutoCuration,
  runScoreRescore,
  // Exported for unit tests — pure pieces.
  buildCurationPrompt,
  CURATION_SCHEMA,
  parseCurationResponse,
  missingAssessmentFallbacks,
  curationEnabled,
  buildCurationCandidateQuery,
  buildRescoreCandidateQuery,
  applyCurationHardGates,
  runCurationEligibilityPipeline,
  hasContentChangedSinceCuration,
  contentFingerprint,
  revalidateStaleRescoreCandidate,
  rescoreCuratedEvent,
  applyRescore,
  applyDecision,
  CURATION_FRESHNESS_EXCLUSIONS,
};
