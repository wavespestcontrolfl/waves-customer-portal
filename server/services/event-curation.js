/**
 * Event auto-curation — the approval step of the autonomous newsletter
 * lane.
 *
 * The pipeline before this: ingestion (4am) pulls feeds into
 * events_raw, the normalizer (5am) classifies freshness/type, the
 * expiry sweep (5:30) and dedup (5:45) clean up. But approval was
 * 100% manual — when nobody worked the Event Inbox for two weeks the
 * Thursday autopilot starved at 0 eligible events and the flagship
 * lane silently died.
 *
 * This cron (6:15am ET, before the 7am Thursday autopilot) classifies
 * never-examined pending events with Claude and approves the ones a
 * local reader would actually go to. Hard gates (future-dated, has a
 * URL, normalized, fresh) run in SQL; the model only judges "is this a
 * real consumer event worth a things-to-do guide". Rejected events
 * STAY pending with a curation_note — the operator can still approve
 * manually; nothing is auto-rejected.
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
const { etDateString, parseETDateTime } = require('../utils/datetime-et');

let Anthropic;
try {
  Anthropic = require('@anthropic-ai/sdk');
} catch {
  Anthropic = null;
}

const MODELS = require('../config/models');

// Examined per run. One Claude call per CLASSIFY_BATCH; a fully fresh
// backlog (e.g. first deploy) drains within a couple of runs.
const CURATION_RUN_LIMIT = 120;
const CLASSIFY_BATCH = 40;
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
async function fetchCurationCandidates(limit = CURATION_RUN_LIMIT) {
  const etMidnight = parseETDateTime(`${etDateString()}T00:00:00`);
  const horizon = new Date(Date.now() + FORWARD_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  return db('events_raw as e')
    .leftJoin('event_sources as s', 's.id', 'e.source_id')
    .select(
      'e.id', 'e.title', 'e.description', 'e.start_at', 'e.venue_name',
      'e.city', 'e.event_type', 'e.freshness_status', 'e.is_free',
      'e.family_friendly', 's.name as source_name',
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
    .whereNot('e.event_type', 'unknown')
    .orderBy('e.start_at', 'asc')
    .limit(limit);
}

function buildCurationPrompt(events, todayIso) {
  const lines = events.map((e) => {
    const date = e.start_at ? new Date(e.start_at).toISOString() : 'unknown';
    const desc = (e.description || '').replace(/\s+/g, ' ').slice(0, 300);
    return `- id: ${e.id}\n  title: ${e.title}\n  date: ${date}\n  venue: ${e.venue_name || 'unknown'} (${e.city || 'unknown city'})\n  source: ${e.source_name || 'unknown'}\n  description: ${desc || '(none)'}`;
  });

  return `You curate events for "Fresh This Week" — a punchy, FOMO-driven weekly local events guide for Southwest Florida (North Port to Tampa). Today's date: ${todayIso}.

APPROVE events a local reader would actually go to for fun: live music, festivals, markets, food and drink, family activities, arts, outdoors, trivia/karaoke nights, museum and aquarium programs, seasonal happenings.

REJECT (leave for human review):
- Government/civic process: council or committee meetings, agendas, hearings, workshops, procurement notices
- Business networking, ribbon cuttings, chamber luncheons aimed at members
- Webinars, virtual-only events, multi-week classes that require enrollment
- Sales promotions and store openings dressed up as events
- Anything whose title/description doesn't describe a real attendable happening

Output STRICT JSON only:
{"decisions": [{"id": "<uuid exactly as given>", "approve": true, "note": "<one short reason, max 80 chars>"}]}

Rules:
- One decision per input event, using its exact id.
- When unsure, approve: false — a human reviews everything you don't approve.
- Return JSON only — no code fence, no commentary.

Events:
${lines.join('\n')}`;
}

/**
 * Parse + validate the model's decisions. Unknown ids are dropped;
 * a missing decision means the event stays pending (fail-closed).
 */
function parseCurationResponse(text, candidateIds) {
  const jsonMatch = String(text || '').match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('Claude did not return JSON for event curation');
  const parsed = JSON.parse(jsonMatch[0]);
  const raw = Array.isArray(parsed.decisions) ? parsed.decisions : [];
  const known = new Set(candidateIds.map(String));
  const seen = new Set();
  const decisions = [];
  for (const d of raw) {
    const id = d && d.id != null ? String(d.id) : null;
    if (!id || !known.has(id) || seen.has(id)) continue;
    seen.add(id);
    decisions.push({
      id,
      approve: d.approve === true,
      note: d.note ? String(d.note).slice(0, NOTE_MAX) : null,
    });
  }
  return decisions;
}

async function classifyBatch(events, todayIso) {
  if (!Anthropic || !process.env.ANTHROPIC_API_KEY) {
    throw new Error('Anthropic API key not configured (ANTHROPIC_API_KEY)');
  }
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const response = await anthropic.messages.create({
    model: MODELS.WORKHORSE,
    max_tokens: 3000,
    system: 'You are a precise event curator. You output strict JSON and nothing else.',
    messages: [{ role: 'user', content: buildCurationPrompt(events, todayIso) }],
  });
  const text = response.content?.[0]?.text || '';
  return parseCurationResponse(text, events.map((e) => e.id));
}

/**
 * Apply one decision. Approval is guarded on admin_status='pending'
 * (a concurrent operator decision wins); the examined-marker update is
 * unguarded so the row never re-enters the candidate pool either way.
 */
async function applyDecision(decision) {
  if (decision.approve) {
    const updated = await db('events_raw')
      .where({ id: decision.id, admin_status: 'pending' })
      .whereNull('merged_into')
      .update({
        admin_status: 'approved',
        approved_via: 'auto_curation',
        curated_at: db.fn.now(),
        curation_note: decision.note,
        updated_at: db.fn.now(),
      });
    if (updated) return 'approved';
  }
  await db('events_raw')
    .where({ id: decision.id })
    .whereNull('curated_at')
    .update({
      curated_at: db.fn.now(),
      curation_note: decision.note,
      updated_at: db.fn.now(),
    });
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

  const candidates = await fetchCurationCandidates(limit);
  if (!candidates.length) {
    return { examined: 0, approved: 0 };
  }

  const todayIso = etDateString(new Date());
  let approved = 0;
  let examined = 0;

  for (let i = 0; i < candidates.length; i += CLASSIFY_BATCH) {
    const batch = candidates.slice(i, i + CLASSIFY_BATCH);
    let decisions;
    try {
      decisions = await classifyBatch(batch, todayIso);
    } catch (err) {
      // A failed batch leaves its rows un-examined — they'll be
      // retried next run. Don't fail the whole sweep.
      logger.error(`[event-curation] batch classify failed: ${err.message}`);
      continue;
    }
    for (const decision of decisions) {
      const outcome = await applyDecision(decision);
      examined += 1;
      if (outcome === 'approved') approved += 1;
    }
  }

  logger.info(`[event-curation] examined ${examined}/${candidates.length}, approved ${approved}`);
  return { examined, approved, candidates: candidates.length };
}

module.exports = {
  runAutoCuration,
  // Exported for unit tests — pure pieces.
  buildCurationPrompt,
  parseCurationResponse,
  curationEnabled,
};
