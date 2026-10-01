/**
 * citability-backfill-seeder.js — operator-triggered backfill that lets the
 * EXISTING blog corpus pick up the citability rules (2026-09-25 owner
 * directive: "let the old posts pick up the rules now" instead of waiting
 * for quarterly refreshes).
 *
 * Scans every live blog post with the SAME four heuristics the quality
 * gate's weight-0 citability nudges use (content-quality-gate:
 * citability_named_sources / concrete_specifics / comparison /
 * how_to_choose) and upserts one opportunity_queue row per post that misses
 * at least `minGaps` of them:
 *
 *   bucket 'citability_backfill' · action refresh_existing_page · page_url
 *   = the post's live path · query NULL · city NULL
 *
 * The row flows through the EXISTING autonomous chain (claim →
 * decision-router → brief → refresh agent → gates → Astro PR → poller
 * auto-merge), so every publish guardrail still applies. Design decisions,
 * each verified against the engine:
 *  - page-anchored: decision-router keeps refresh_existing_page and the
 *    'refresh' page_type (improvement_over_prior stays hard) exactly like
 *    answer_gap — the row exists to edit THE page it was scanned from.
 *  - query NULL ⇒ the brief has no target_keyword ⇒ the quality gate's SERP
 *    evidence check is already satisfied as a page-only opportunity; the
 *    GSC evidence check is exempted for this bucket by
 *    isCitabilityBackfillBrief (the scan result IS the provenance).
 *  - city NULL ⇒ the facts-sufficiency gate reports "not applicable"; local
 *    claims the refresher adds still need facts_pack ids (refresh prompt).
 *  - signal_metadata.citability_gaps rides into the brief's gsc_signal (the
 *    answer_gap pattern) and required_sections, and switches the refresh
 *    agent's CITABILITY MODE on.
 *  - pacing: rows are staggered `perDay` per ET day via available_at so the
 *    backfill never floods the daily run or the Cloudflare Pages build
 *    queue (one astro PR per refresh); score sits just above the 75
 *    refresh floor so mined GSC work still outranks it.
 *  - dedupe_key `citability:v1:<page_url>` + ON CONFLICT DO UPDATE (same
 *    revive semantics as intercept-brief-seeder: an operator re-seed is an
 *    explicit "run these"; claimed/done/pending_review rows never reset).
 *  - dark: isEnabled('citabilityBackfill') (GATE_CITABILITY_BACKFILL) —
 *    seedAll refuses to write while the gate is off; --dry-run still scans.
 */

const db = require('../../models/db');
const { createHash } = require('node:crypto');
const logger = require('../logger');
const { isEnabled } = require('../../config/feature-gates');
const fm = require('../content-astro/frontmatter');
const { _internals: { maxClaimAttempts } } = require('./opportunity-queue');
const { parseETDateTime, etDateString } = require('../../utils/datetime-et');
const { _internals: gate } = require('./content-quality-gate');

const CITABILITY_BACKFILL_BUCKET = 'citability_backfill';
const DEDUPE_PREFIX = 'citability:v1:';
const EXPIRES_DAYS_AFTER_AVAILABLE = 45;
// Refresh rows sit exactly on the 75 non-blog floor (opportunity-queue ELSE
// arm, score >= floor). Claims order by score, so a backfill never outranks
// mined work (Codex r2 P2: 76 + gaps took every daily slot ahead of mined
// rows at 75–77). Worst-first order comes from the ET-day batching instead.
const BASE_SCORE = 75;
const DEFAULT_PER_DAY = 5;
const DEFAULT_MIN_GAPS = 2;

// Gap id → the gate check that measures it. Order = the order the refresh
// agent should address them (sources and numbers are always applicable;
// comparison / how-to-choose only when the post frames a choice — the gate
// returns ok:true with a "not applicable" reason in that case, so they
// never appear as gaps on a post with no choice).
const GAP_CHECKS = [
  ['named_sources', gate.checkCitabilityNamedSources],
  ['concrete_specifics', gate.checkCitabilityConcreteSpecifics],
  ['comparison', gate.checkCitabilityComparison],
  ['how_to_choose', gate.checkCitabilityHowToChoose],
];

// Astro blog category → engine service (the coarse key the guardrails and
// FAQ policy read). Unknown / seasonal categories fall back to the first
// related_services slug prefix, then 'pest'.
const CATEGORY_TO_SERVICE = {
  'pest-control': 'pest',
  'lawn-care': 'lawn',
  termite: 'termite',
  mosquito: 'mosquito',
  'tree-shrub': 'tree-shrub',
  rodent: 'rodent',
};

function relatedServiceFor(slug) {
  const s = String(slug || '').toLowerCase();
  if (s.startsWith('lawn-care')) return 'lawn';
  if (s.startsWith('termite')) return 'termite';
  if (s.startsWith('mosquito')) return 'mosquito';
  if (s.startsWith('tree-and-shrub') || s.startsWith('tree-shrub')) return 'tree-shrub';
  if (s.startsWith('rodent')) return 'rodent';
  if (s.startsWith('pest-control')) return 'pest';
  return null;
}

// The blog schema files rodent / bed-bug / cockroach / spider / wasp posts
// under the broad 'pest-control' category, so a specific related service
// outranks a category that maps to 'pest' (Codex r6 P2).
function serviceForPost(frontmatter = {}) {
  const cat = String(frontmatter.category || '').toLowerCase().trim();
  const related = Array.isArray(frontmatter.related_services) ? frontmatter.related_services : [];
  const specific = related.map(relatedServiceFor).find((svc) => svc && svc !== 'pest') || null;
  const byCategory = CATEGORY_TO_SERVICE[cat] || null;
  if (byCategory && byCategory !== 'pest') return byCategory;
  if (specific) return specific;
  if (byCategory) return byCategory;
  return related.map(relatedServiceFor).find(Boolean) || 'pest';
}

// Specialty topics the FAQ_BLOCKED_SERVICE guard keys on (content-guardrails
// FAQ_BLOCKED_SERVICES) that the coarse service hides. Rides the row as
// signal_metadata.specialty_topic → brief gsc_signal.specialty_topic →
// guardrail-options, the same path mined family rows use (Codex r6 P2).
const SPECIALTY_TOPIC_PATTERNS = [
  ['bed-bug', /\bbed[- ]?bugs?\b/],
  ['cockroach', /\b(?:cockroach(?:es)?|roach(?:es)?)\b/],
  ['rodent', /\b(?:rodents?|rats?|mice|mouse)\b/],
  ['spider', /\bspiders?\b/],
  ['wasp', /\b(?:wasps?|hornets?|yellow[- ]?jackets?|mud[- ]?daubers?)\b/],
  ['drywood', /\bdrywood\b/],
  ['termite', /\btermites?\b/],
  ['palm', /\bpalms?\b/],
  ['aeration', /\baerat(?:e|ion|ing)\b/],
  ['plugging', /\bplugg?(?:ing|s)\b/],
  ['lawn-pest', /\b(?:chinch[- ]?bugs?|sod[- ]?webworms?|armyworms?|mole[- ]?crickets?|grubs?)\b/],
  ['commercial', /\bcommercial\b/],
];

function specialtyTopicForPost(frontmatter = {}, url = '') {
  const related = Array.isArray(frontmatter.related_services) ? frontmatter.related_services.join(' ') : '';
  const hay = [url, frontmatter.title, related, Array.isArray(frontmatter.tags) ? frontmatter.tags.join(' ') : '']
    .map((v) => String(v || '').toLowerCase().replace(/[/_]+/g, ' '))
    .join(' ');
  const hit = SPECIALTY_TOPIC_PATTERNS.find(([, re]) => re.test(hay));
  return hit ? hit[0] : null;
}

/**
 * Split a raw Astro file into { frontmatter, body }. Falls back to an empty
 * frontmatter when the file has none (legacy root-level posts).
 */
function splitPost(raw) {
  try {
    const parsed = fm.parse(String(raw || ''));
    return { frontmatter: parsed?.data || {}, body: parsed?.content ?? String(raw || '') };
  } catch {
    return { frontmatter: {}, body: String(raw || '') };
  }
}

/**
 * Run the four citability checks over one post. Pure.
 * → { gaps: string[], results: { [gapId]: { ok, reason } } }
 */
function scanPost({ body: raw, url, file }) {
  const { frontmatter, body } = splitPost(raw);
  return scanParsed({ frontmatter, body, url, file });
}

// The checks see the page exactly as a refresh of it would: a blog target
// (never the non-blog short-circuit) whose file path lets the gate skip the
// comparison signal on a legacy .md post, which cannot carry MDX components
// (publishRefresh 422s a .md body with <ComparisonTable>). No previous
// version: the scan measures the live page itself.
function scanParsed({ frontmatter = {}, body = '', url, file = null }) {
  const draft = { url, title: frontmatter.title || '', body, frontmatter };
  const brief = { target_page_type: 'blog', target_file_path: file || null };
  const results = {};
  const gaps = [];
  for (const [id, check] of GAP_CHECKS) {
    let r;
    try { r = check(draft, brief, {}); } catch (err) { r = { ok: true, reason: `check_threw:${err.message}` }; }
    results[id] = { ok: !!r.ok, reason: r.reason || null };
    if (!r.ok) gaps.push(id);
  }
  // No comparison → how_to_choose coupling: the gate already applies
  // how_to_choose to every post that frames a choice (the only posts that can
  // have a comparison gap), so a satisfied how-to-choose section stays
  // satisfied rather than being planned as work.
  return { gaps, results, frontmatter, title: draft.title };
}

/**
 * Re-scan the LIVE page for a queued row just before its brief is composed.
 * Rows wait up to --per-day pacing days; a post fixed in between (manual
 * edit or another refresh) must not get a stale, redundant brief (Codex P2,
 * 2026-09-26). → { gaps, results, ineligible } or null when the page can't be read
 * (caller keeps the seeded gaps; the refresh gate still fails closed
 * without a prior version).
 */
async function rescanLive(opportunity, { publisher = require('../content-astro/astro-publisher') } = {}) {
  const url = opportunity?.page_url;
  if (!url || !publisher?.loadExistingPageBody) return null;
  const live = await publisher.loadExistingPageBody(url);
  if (!live || typeof live.body !== 'string') return null;
  // The seed-time eligibility filter can go stale over the paced wait: a
  // post that turned noindex / spoke-rendered / off-hub or mismatched
  // canonical must resolve without drafting (Codex r7 P2).
  const link = require('./internal-link-planner')._internals;
  const fmData = live.frontmatter || {};
  if (link.sourceRendersOffHub(fmData) || link.canonicalPointsOffHub(fmData) || link.robotsNoindex(fmData)
    || link.sourceCanonicalMismatch(fmData, url)) {
    return { gaps: [], results: {}, ineligible: true };
  }
  if (!live.source_file) return null;
  const scan = scanParsed({ frontmatter: fmData, body: live.body, url, file: live.source_file });
  // The topic can change over the wait too (a broad pest post retagged bed
  // bugs): re-derive it so compose's FAQ_BLOCKED_SERVICE check and facts
  // lookups follow the article as it reads now (Codex P2, 2026-09-27).
  return {
    gaps: scan.gaps,
    results: scan.results,
    ineligible: false,
    service: serviceForPost(fmData),
    specialty_topic: specialtyTopicForPost(fmData, url),
  };
}

function dedupeKeyFor(url) {
  const key = `${DEDUPE_PREFIX}${String(url || '').trim()}`;
  return key.length <= 200 ? key : `${key.slice(0, 135)}:${createHash('sha256').update(key).digest('hex')}`;
}

// ET-midnight of today + dayOffset, so rows self-activate one batch per day
// (claimNext/peek filter available_at IS NULL OR available_at <= now()).
// Calendar arithmetic on the ET date string, then the shared ET parser
// resolves the wall-clock midnight — no private offset inference (a noon
// probe read the wrong offset on DST transition days; fallback P1).
function availableAtFor(now, dayOffset) {
  if (dayOffset <= 0) return null;
  const [y, m, d] = etDateString(now).split('-').map(Number);
  const ymd = new Date(Date.UTC(y, m - 1, d + dayOffset)).toISOString().slice(0, 10);
  return parseETDateTime(`${ymd}T00:00`);
}

function rowForPost(post, scan, { now = new Date(), dayOffset = 0, scannedRef = null } = {}) {
  // Other page-edit producers compare domain + path, so persist a full hub URL.
  const pageUrl = new URL(post.url, 'https://www.wavespestcontrol.com').href;
  const score = BASE_SCORE;
  const availableAt = availableAtFor(now, dayOffset);
  const expiresBase = availableAt || now;
  return {
    bucket: CITABILITY_BACKFILL_BUCKET,
    action_type: 'refresh_existing_page',
    query: null, // page-only: no target_keyword, no SERP profiling
    page_url: pageUrl,
    service: serviceForPost(scan.frontmatter),
    city: null, // facts gate "not applicable"; local claims still need facts_pack ids
    score,
    score_breakdown: { base: BASE_SCORE, citability_gaps: scan.gaps.length },
    signal_metadata: {
      source: 'citability-backfill-seeder',
      citability_gaps: scan.gaps,
      citability_scan: scan.results,
      scanned_at: now.toISOString(),
      scanned_ref: scannedRef,
      source_file: post.file || null,
      post_title: scan.title || null,
      specialty_topic: specialtyTopicForPost(scan.frontmatter, post.url),
    },
    status: 'pending',
    mined_at: now,
    expires_at: new Date(expiresBase.getTime() + EXPIRES_DAYS_AFTER_AVAILABLE * 86400_000),
    available_at: availableAt,
    // Keep the seed identity stable for existing rows while normalizing page_url.
    dedupe_key: dedupeKeyFor(post.url),
  };
}

/**
 * Load the live blog corpus: local ASTRO_REPO_DIR when present (dev), else
 * the configured GitHub Astro repo (Railway). Same loader the internal-link
 * planner and topic-targeting gate use.
 */
async function loadBlogCorpus({ planner = require('./internal-link-planner') } = {}) {
  const astroDir = process.env.ASTRO_REPO_DIR;
  if (astroDir && planner.loadAstroCorpus) return planner.loadAstroCorpus(astroDir, { collections: ['blog'] });
  if (planner.loadAstroCorpusFromGitHub) return planner.loadAstroCorpusFromGitHub({ collections: ['blog'] });
  return [];
}

function indexableHubPost(post) {
  const link = require('./internal-link-planner')._internals;
  if (!link.eligibleLinkSource(post)) return false;
  return !link.sourceCanonicalMismatch(splitPost(post.body).frontmatter, post.url);
}

/**
 * Scan the corpus and shape rows. Pure given the corpus. Posts are ordered
 * worst-first (most gaps), then by url for a stable batch order, and
 * assigned to ET-day batches of `perDay`.
 */
function planRows(corpus, { now = new Date(), perDay = DEFAULT_PER_DAY, minGaps = DEFAULT_MIN_GAPS, limit = null, scannedRef = null } = {}) {
  const scanned = [];
  for (const post of corpus) {
    // Blog collection only (the loaders may return services/locations too).
    if (!post?.url || !/(?:^|\/)src\/content\/blog\//.test(String(post.file || ''))) continue;
    // Indexable hub pages only: noindex, spoke-rendered, off-hub-canonical
    // and canonical-mismatch posts would burn paced slots on refreshes that
    // cannot improve the indexed corpus (Codex P2, 2026-09-26). Same checks
    // the internal-link planner applies to this loader's output.
    if (!indexableHubPost(post)) continue;
    const scan = scanPost(post);
    if (scan.gaps.length < minGaps) continue;
    scanned.push({ post, scan });
  }
  scanned.sort((a, b) => (b.scan.gaps.length - a.scan.gaps.length) || a.post.url.localeCompare(b.post.url));
  const picked = limit ? scanned.slice(0, limit) : scanned;
  const per = Math.max(1, Number(perDay) || DEFAULT_PER_DAY);
  return picked.map(({ post, scan }, i) => rowForPost(post, scan, { now, dayOffset: Math.floor(i / per), scannedRef }));
}

async function seedAll({ dryRun = false, perDay = DEFAULT_PER_DAY, minGaps = DEFAULT_MIN_GAPS, limit = null, now = new Date(), corpus = null } = {}) {
  const posts = corpus || await loadBlogCorpus();
  const rows = planRows(posts, { now, perDay, minGaps, limit });
  const summary = { scanned: posts.length, eligible: rows.length, days: rows.length ? Math.floor((rows.length - 1) / Math.max(1, perDay)) + 1 : 0 };
  if (dryRun) return { dryRun: true, count: rows.length, rows, summary };
  if (!isEnabled('citabilityBackfill')) {
    throw new Error('citability backfill is gated off (set GATE_CITABILITY_BACKFILL=true) — nothing written; use --dry-run to inspect');
  }

  let count = 0;
  for (const row of rows) {
    const result = await db.transaction(async (trx) => {
      const refreshAudit = require('../seo/refresh-audit');
      // Share the page-edit lock and identity check with the other producers.
      await trx.raw("SELECT pg_advisory_xact_lock(hashtext('opportunity_page_edit'))");
      const inflight = await refreshAudit.findInflightPageEdit(trx, {
        path: refreshAudit._identity.urlToPath(row.page_url),
        targetDomain: 'wavespestcontrol.com',
      });
      if (inflight) {
        if (inflight.bucket === CITABILITY_BACKFILL_BUCKET && inflight.dedupe_key === row.dedupe_key && inflight.page_url !== row.page_url) {
          // Repair legacy route identity without changing an active claim or scan.
          await trx('opportunity_queue').where({ id: inflight.id }).update({ page_url: row.page_url });
        }
        return { rowCount: 0 };
      }
      return trx.raw(
      `INSERT INTO opportunity_queue
         (bucket, action_type, query, page_url, service, city,
          score, score_breakdown, signal_metadata, status,
          mined_at, expires_at, available_at, dedupe_key, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?::jsonb, ?::jsonb, ?, ?, ?, ?, ?, now(), now())
       ON CONFLICT (dedupe_key) DO UPDATE
         SET score = EXCLUDED.score,
             score_breakdown = EXCLUDED.score_breakdown,
             claim_id = CASE WHEN opportunity_queue.status IN ('claimed', 'done', 'pending_review')
                             THEN opportunity_queue.claim_id ELSE NULL END,
             signal_metadata = EXCLUDED.signal_metadata,
             mined_at = EXCLUDED.mined_at,
             expires_at = EXCLUDED.expires_at,
             available_at = EXCLUDED.available_at,
             action_type = EXCLUDED.action_type,
             page_url = EXCLUDED.page_url,
             service = EXCLUDED.service,
             status = CASE WHEN opportunity_queue.status IN ('claimed', 'done', 'pending_review')
                           THEN opportunity_queue.status
                           ELSE 'pending'
                      END,
             attempt_count = CASE WHEN opportunity_queue.status IN ('skipped', 'expired')
                                  THEN 0
                                  WHEN opportunity_queue.status = 'pending'
                                       AND opportunity_queue.attempt_count >= ?
                                  THEN 0
                                  ELSE opportunity_queue.attempt_count
                             END,
             updated_at = now()
       -- An ordinary producer can take this page while the lane is off.
       -- That ownership transfer is durable: do not revive the retired row
       -- or erase the marker if an operator runs the seeder after re-enable.
       -- A done row was refreshed already: leave it untouched so a re-run
       -- neither reopens nor counts it (Codex r2 P2).
       WHERE NOT jsonb_exists(COALESCE(opportunity_queue.signal_metadata, '{}'::jsonb), 'page_edit_superseded')
         AND opportunity_queue.status <> 'done'
      `,
      [
        row.bucket, row.action_type, row.query, row.page_url, row.service, row.city,
        row.score, JSON.stringify(row.score_breakdown), JSON.stringify(row.signal_metadata), row.status,
        row.mined_at, row.expires_at, row.available_at, row.dedupe_key,
        maxClaimAttempts(),
      ]
      );
    });
    count += result.rowCount || 0;
  }
  logger.info(`[citability-backfill-seeder] seeded ${count}/${rows.length} refresh row(s) over ${summary.days} ET day(s) (perDay=${perDay}, minGaps=${minGaps}) from ${posts.length} scanned post(s)`);
  return { dryRun: false, count, rows, summary };
}

module.exports = { seedAll, planRows, scanPost, rescanLive, loadBlogCorpus, CITABILITY_BACKFILL_BUCKET };
module.exports._internals = {
  GAP_CHECKS, CATEGORY_TO_SERVICE, BASE_SCORE, DEFAULT_PER_DAY, DEFAULT_MIN_GAPS, EXPIRES_DAYS_AFTER_AVAILABLE,
  serviceForPost, specialtyTopicForPost, splitPost, dedupeKeyFor, availableAtFor, rowForPost,
};
