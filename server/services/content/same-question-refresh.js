/**
 * same-question-refresh.js — the rewrite half of the same-question check.
 *
 * Owner 2026-10-30 ("all"): before the engine writes a NEW supporting blog,
 * topic-targeting-gate.evaluateSameQuestion looks for a live post that
 * already answers the same question. With GATE_SAME_QUESTION_CHECK on, the
 * runner (autonomous-runner step 2d) skips the new-post row by design and
 * calls enqueueOwnerRefresh() here, which queues ONE refresh of the owner
 * page that folds the blocked question in as an answer section:
 *
 *   bucket 'same_question_refresh' · action refresh_existing_page · page_url
 *   = the owner page · query NULL · city NULL · signal_metadata.
 *   unanswered_queries = [the question] (the refresh agent's ANSWER-GAP MODE)
 *
 * The row is an ordinary opportunity_queue refresh, so it flows through the
 * EXISTING autonomous chain (claim → decision-router → brief → refresh agent
 * → quality gates → Astro PR → poller auto-merge). Nothing here bypasses a
 * refresh gate:
 *  - protected pages (money pages, registry, high-traffic): checked here so no
 *    row is queued for one, and again by the runner at claim time.
 *  - in-flight page edit: findInflightPageEdit under the shared
 *    'opportunity_page_edit' advisory lock, the same arbitration
 *    refresh-audit and the citability seeder use. Another edit already
 *    queued or running on the page means NO row (reason page_edit_in_flight).
 *  - 28-day page cooldown and route fence: the bucket sits in
 *    opportunity-queue's QUESTION_REFRESH_BUCKETS, so the claim waits while
 *    any other row for the route is claimed / in review / has an open PR, and
 *    for AEO_QUESTION_GAP_COOLDOWN_DAYS (28) after another row wrote the page.
 *  - terminal-writer flow, uniqueness, quality gates: unchanged runner path.
 *  - kill switch: opportunity-queue sameQuestionLaneOpen — gate off means
 *    queued rows are not claimed.
 *
 * Dedupe: one row per (owner page, question words). A frozen row (claimed /
 * done / pending_review / skipped) is never reset, so a question answered once
 * is not queued again; an expired row revives.
 */

const { createHash } = require('node:crypto');
const db = require('../../models/db');
const logger = require('../logger');

const SAME_QUESTION_REFRESH_BUCKET = 'same_question_refresh';
const DEDUPE_PREFIX = 'same_question:v1:';
// Just above the 75 refresh floor: claims order by score, so mined GSC work
// (which earns its rank) still goes first and this never floods the day.
const BASE_SCORE = 78;
const EXPIRES_DAYS = 60;
const HUB_ORIGIN = 'https://www.wavespestcontrol.com';

// First URL segment → engine service (the coarse key the guardrails read).
const CATEGORY_TO_SERVICE = {
  'pest-control': 'pest',
  'lawn-care': 'lawn',
  termite: 'termite',
  mosquito: 'mosquito',
  'tree-shrub': 'tree-shrub',
  rodent: 'rodent',
};

function ownerPath(url) {
  return String(url || '').trim().replace(/^[a-z]+:\/\/[^/]+/i, '').split(/[?#]/)[0].replace(/\/+$/, '').toLowerCase() || '/';
}

function serviceForOwner(url) {
  const first = ownerPath(url).split('/').filter(Boolean)[0] || '';
  return CATEGORY_TO_SERVICE[first] || 'pest';
}

// One key per (owner page, question words). Token order never matters.
function dedupeKeyFor(ownerUrl, tokens = []) {
  const key = `${DEDUPE_PREFIX}${ownerPath(ownerUrl)}::${[...new Set(tokens)].sort().join('+')}`;
  return key.length <= 200 ? key : `${key.slice(0, 135)}:${createHash('sha256').update(key).digest('hex')}`;
}

/**
 * Pure: shape the queue row. `owner` is evaluateSameQuestion's owner
 * ({url, title}); `question` is the blocked brief's keyword (or title).
 */
function buildRow({ owner, tokens, question, sourceOpportunityId = null, sourceRunId = null, now = new Date() }) {
  const pageUrl = new URL(owner.url, HUB_ORIGIN).href;
  const text = String(question || '').trim();
  let specialty = null;
  try {
    specialty = require('../seo/gsc-opportunity-miner').extractSpecialtyTopic([text, ownerPath(owner.url)]) || null;
  } catch { specialty = null; }
  return {
    bucket: SAME_QUESTION_REFRESH_BUCKET,
    action_type: 'refresh_existing_page',
    query: null, // page-only: the refresh edits THIS page; no new target keyword, no SERP profiling
    page_url: pageUrl,
    service: serviceForOwner(owner.url),
    city: null,
    score: BASE_SCORE,
    score_breakdown: { base: BASE_SCORE, source: 'same-question-refresh' },
    signal_metadata: {
      source: 'same-question-refresh',
      same_question: {
        owner_url: pageUrl,
        owner_title: owner.title || null,
        question: text,
        tokens: [...new Set(tokens)],
        source_opportunity_id: sourceOpportunityId,
        source_run_id: sourceRunId,
        matched_at: now.toISOString(),
      },
      // The refresh agent's ANSWER-GAP MODE contract (same key and entry shape
      // answer_gap uses). No impressions or position: the question has no
      // traffic on this page yet.
      unanswered_queries: [{ query: text, impressions: 0, source: SAME_QUESTION_REFRESH_BUCKET, owner_url: pageUrl }],
      specialty_topic: specialty,
    },
    status: 'pending',
    mined_at: now,
    expires_at: new Date(now.getTime() + EXPIRES_DAYS * 86400_000),
    dedupe_key: dedupeKeyFor(owner.url, tokens),
  };
}

/**
 * enqueueOwnerRefresh({ owner, tokens, question, sourceOpportunityId, sourceRunId }, { now, protectedPages, refreshAudit })
 * → { queued, reason, status?, dedupe_key, page_url }
 * Never reaches around a refresh gate. Throws only on a database fault; the
 * caller records it and still skips the new-post row.
 */
async function enqueueOwnerRefresh(args = {}, deps = {}) {
  const { owner, tokens = [], question = '' } = args;
  if (!owner || !owner.url || !tokens.length || !String(question).trim()) {
    return { queued: false, reason: 'incomplete_match' };
  }
  const now = deps.now || new Date();
  const row = buildRow({ ...args, now });
  const protectedPages = deps.protectedPages || require('./protected-pages');
  const refreshAudit = deps.refreshAudit || require('../seo/refresh-audit');
  const { _internals: { maxClaimAttempts } } = require('./opportunity-queue');

  const prot = await protectedPages.isProtected(row.page_url, { db });
  if (prot?.protected) {
    return { queued: false, reason: `protected_page:${prot.reason || 'protected'}`, dedupe_key: row.dedupe_key, page_url: row.page_url };
  }

  const path = refreshAudit._identity.urlToPath(row.page_url);
  const outcome = await db.transaction(async (trx) => {
    // The page-edit lock every refresh producer shares (refresh-audit,
    // citability seeder, miner persist): the in-flight re-check and the insert
    // are one step.
    await trx.raw("SELECT pg_advisory_xact_lock(hashtext('opportunity_page_edit'))");
    const inflight = await refreshAudit.findInflightPageEdit(trx, { path, targetDomain: 'wavespestcontrol.com' });
    if (inflight) {
      return { queued: false, reason: inflight.dedupe_key === row.dedupe_key ? 'already_queued' : 'page_edit_in_flight', status: inflight.status };
    }
    const result = await trx.raw(
      `INSERT INTO opportunity_queue
         (bucket, action_type, query, page_url, service, city,
          score, score_breakdown, signal_metadata, status,
          mined_at, expires_at, dedupe_key, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?::jsonb, ?::jsonb, ?, ?, ?, ?, now(), now())
       ON CONFLICT (dedupe_key) DO UPDATE
         SET score = EXCLUDED.score,
             score_breakdown = EXCLUDED.score_breakdown,
             signal_metadata = EXCLUDED.signal_metadata,
             mined_at = EXCLUDED.mined_at,
             expires_at = EXCLUDED.expires_at,
             page_url = EXCLUDED.page_url,
             service = EXCLUDED.service,
             claim_id = NULL,
             status = 'pending',
             skip_reason = NULL,
             attempt_count = CASE WHEN opportunity_queue.attempt_count >= ? THEN 0 ELSE opportunity_queue.attempt_count END,
             updated_at = now()
       -- Frozen rows (claimed / done / pending_review / skipped) are records of
       -- what was processed or decided: a question already answered, or
       -- dismissed by a person, is never re-opened. 'expired' revives.
       WHERE opportunity_queue.status NOT IN ('claimed', 'done', 'pending_review', 'skipped')
       RETURNING id, status`,
      [
        row.bucket, row.action_type, row.query, row.page_url, row.service, row.city,
        row.score, JSON.stringify(row.score_breakdown), JSON.stringify(row.signal_metadata), row.status,
        row.mined_at, row.expires_at, row.dedupe_key,
        maxClaimAttempts(),
      ]
    );
    const inserted = result.rows?.[0];
    if (!inserted) return { queued: false, reason: 'already_handled' };
    const { supersedeCitabilityBackfillsForPage } = require('./opportunity-queue')._internals;
    await supersedeCitabilityBackfillsForPage(trx, { pageUrl: row.page_url, ordinaryDedupeKey: row.dedupe_key });
    return { queued: true, reason: 'queued', status: inserted.status, id: inserted.id };
  });
  logger.info(`[same-question-refresh] ${row.page_url} ← "${String(question).slice(0, 80)}": ${outcome.reason}`);
  return { ...outcome, dedupe_key: row.dedupe_key, page_url: row.page_url };
}

module.exports = { enqueueOwnerRefresh, buildRow, dedupeKeyFor, SAME_QUESTION_REFRESH_BUCKET };
module.exports._internals = { ownerPath, serviceForOwner, BASE_SCORE, EXPIRES_DAYS, DEDUPE_PREFIX };
