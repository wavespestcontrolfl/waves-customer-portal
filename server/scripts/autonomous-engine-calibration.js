#!/usr/bin/env node
/**
 * autonomous-engine-calibration.js — read-only dry-run for the autonomous
 * local-SEO content engine. Before any miner / agent / cron is built, this
 * script answers: "if we ran the engine today against real data, what would
 * it decide, and would those decisions look sane?"
 *
 * Pulls samples from gsc_queries, gsc_pages, blog_posts, call_log,
 * messages, google_reviews — runs them through inline simplified versions
 * of the future scorers — writes a markdown report.
 *
 * Default is read-only — only the DB queries that aggregate gsc_*,
 * blog_posts, call_log, messages, google_reviews run. Safe for prod.
 *
 * Opt-in `--with-serp` enables SERP profiling for 5 sample keywords
 * via the existing SERPAnalyzer.analyzeKeyword path, which DOES write
 * to seo_serp_analyses AND spends DataForSEO credits. Initial design
 * had this enabled by default with a --no-serp opt-out; codex review
 * pointed out the contradiction with the "read-only" header.
 *
 * Usage:
 *   node server/scripts/autonomous-engine-calibration.js
 *   node server/scripts/autonomous-engine-calibration.js --with-serp
 *   node server/scripts/autonomous-engine-calibration.js --days=28 --output=/tmp/report.md
 *
 * For prod data (recommended for real calibration):
 *   railway run -s Postgres -- bash -c '
 *     DATABASE_URL=$DATABASE_PUBLIC_URL \
 *       node server/scripts/autonomous-engine-calibration.js
 *   '
 */

const fs = require('fs');
const path = require('path');
const db = require('../models/db');
const { etDateString, addETDays } = require('../utils/datetime-et');
const { WEIGHTS, THRESHOLDS, REVENUE_PRIORITY, CITIES, SERP_SAMPLE_CITIES } =
  require('../services/content/scoring-config');

// ── args ──────────────────────────────────────────────────────────

const ARGS = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    if (!a.startsWith('--')) return [a, true];
    const [k, v] = a.slice(2).split('=');
    return [k, v === undefined ? true : v];
  })
);

const PERIOD_DAYS = parseInt(ARGS.days || 28, 10);
// SERP profiling is opt-in: it writes to seo_serp_analyses and spends
// DataForSEO credits, which violates this script's "read-only / safe for
// prod" contract by default. --no-serp accepted for backward compat.
const SKIP_SERP = !ARGS['with-serp'] || !!ARGS['no-serp'];
const OUTPUT_PATH =
  ARGS.output ||
  path.join(__dirname, '..', '..', 'reports', `calibration-${new Date().toISOString().slice(0, 10)}.md`);

// ET-pinned date boundaries — Railway runs UTC but the portal's other
// date filters all use ET (AGENTS.md). Plain toISOString().slice(0,10)
// would advance the window one day early between 8pm ET and midnight ET.
const SINCE = etDateString(addETDays(new Date(), -PERIOD_DAYS));
const PRIOR_SINCE = etDateString(addETDays(new Date(), -PERIOD_DAYS * 2));

// ── helpers ───────────────────────────────────────────────────────

const out = [];
const log = (s = '') => out.push(s);

function pct(n) { return `${(n * 100).toFixed(1)}%`; }
function num(n) { return Number(n || 0).toLocaleString(); }
function round(n, p = 1) { return Number(n || 0).toFixed(p); }

function tableExists(name) {
  return db.schema.hasTable(name).catch(() => false);
}

async function safeCount(table) {
  try { const r = await db(table).count('* as c').first(); return parseInt(r.c, 10); }
  catch { return null; }
}

// ── 1. GSC opportunity scoring (inline) ────────────────────────────

function classifyGscBucket(row) {
  const pos = parseFloat(row.avg_position);
  const imp = parseInt(row.impressions, 10);
  const ctr = parseFloat(row.ctr);
  const T = THRESHOLDS;

  if (imp < T.minImpressionsToScore) return 'too_few_impressions';
  if (pos >= T.strikingDistancePositionMin && pos <= T.strikingDistancePositionMax) {
    return 'striking_distance';
  }
  if (pos <= T.ctrRewritePositionMax && imp >= T.ctrRewriteMinImpressions && ctr < T.ctrRewriteMaxCtr) {
    return 'ctr_rewrite';
  }
  if (pos > T.strikingDistancePositionMax && pos <= 30) return 'deep_opportunity';
  if (pos < T.strikingDistancePositionMin) return 'already_ranking';
  return 'unclassified';
}

function gscOpportunityScore(row, bucket) {
  const W = WEIGHTS.gscOpportunity;
  if (bucket === 'striking_distance') {
    const pos = parseFloat(row.avg_position);
    const distance = Math.max(0, pos - 3);
    return Math.round(W * (1 - distance / 15));
  }
  if (bucket === 'ctr_rewrite') return Math.round(W * 0.7);
  if (bucket === 'deep_opportunity') return Math.round(W * 0.3);
  return 0;
}

function localRevenueScore(serviceCategory) {
  const key = (serviceCategory || '').toLowerCase();
  const priority = REVENUE_PRIORITY[key] ?? 0.5;
  return Math.round(WEIGHTS.localRevenue * priority);
}

function conversionIntentScore(query) {
  const q = (query || '').toLowerCase();
  const transactional = /(near me|today|same.?day|emergency|cost|price|quote|estimate|hire|company|service|company|service\s)/;
  const informational = /(how|what|why|when|signs?|identify|prevent|safe for|diy)/;
  if (transactional.test(q)) return WEIGHTS.conversionIntent;
  if (informational.test(q)) return Math.round(WEIGHTS.conversionIntent * 0.3);
  return Math.round(WEIGHTS.conversionIntent * 0.6);
}

function decideAction({ bucket, hasExistingPage, isLocalQuery }) {
  if (bucket === 'ctr_rewrite' && hasExistingPage) return 'rewrite_title_meta';
  if (bucket === 'striking_distance' && hasExistingPage) return 'refresh_existing_page';
  if (bucket === 'striking_distance' && isLocalQuery) return 'create_or_refresh_city_service_page';
  if (bucket === 'striking_distance') return 'new_supporting_blog';
  if (bucket === 'deep_opportunity') return 'do_not_publish';
  if (bucket === 'too_few_impressions') return 'do_not_publish';
  if (bucket === 'already_ranking') return 'do_not_publish';
  return 'do_not_publish';
}

async function pickGscOpportunities() {
  const rows = await db('gsc_queries')
    .where('date', '>=', SINCE)
    .where('is_branded', false)
    .select('query', 'service_category', 'city_target', 'intent_type')
    .sum('clicks as clicks')
    .sum('impressions as impressions')
    .avg('position as avg_position')
    .avg('ctr as ctr')
    .groupBy('query', 'service_category', 'city_target', 'intent_type')
    .havingRaw('sum(impressions) >= ?', [THRESHOLDS.minImpressionsToScore])
    .orderBy('impressions', 'desc')
    .limit(40);

  // Score and pick top 20 by score
  const scored = await Promise.all(rows.map(async (r) => {
    const bucket = classifyGscBucket(r);
    const hasExistingPage = !!(await db('gsc_pages')
      .where('date', '>=', SINCE)
      .where('service_category', r.service_category || '')
      .where('city_target', r.city_target || '')
      .first()
      .catch(() => null));
    const isLocalQuery = !!(r.city_target) || /\b(fl|florida|bradenton|sarasota|venice|parrish|palmetto|lakewood|north port|port charlotte)\b/i.test(r.query);
    const score =
      gscOpportunityScore(r, bucket) +
      localRevenueScore(r.service_category) +
      conversionIntentScore(r.query);
    const action = decideAction({ bucket, hasExistingPage, isLocalQuery });
    return { ...r, bucket, hasExistingPage, isLocalQuery, score, action };
  }));

  return scored.sort((a, b) => b.score - a.score).slice(0, 20);
}

// ── 2. Service/location page health ────────────────────────────────

async function pickServiceLocationPages() {
  const rows = await db('gsc_pages')
    .where('date', '>=', SINCE)
    .whereIn('page_type', ['city', 'service', 'landing'])
    .select('page_url', 'page_type', 'service_category', 'city_target')
    .sum('clicks as clicks')
    .sum('impressions as impressions')
    .avg('position as avg_position')
    .avg('ctr as ctr')
    .groupBy('page_url', 'page_type', 'service_category', 'city_target')
    .orderBy('impressions', 'desc')
    .limit(20)
    .catch(() => []);

  // Pick 10 with traffic spread: top 3, middle 4, lower 3.
  if (rows.length < 4) return rows;
  const top = rows.slice(0, 3);
  const mid = rows.slice(Math.floor(rows.length / 3), Math.floor(rows.length / 3) + 4);
  const low = rows.slice(-3);
  return [...top, ...mid, ...low];
}

async function pageDecayClassification(page_url) {
  try {
    const recent = await db('gsc_pages')
      .where('page_url', page_url)
      .where('date', '>=', SINCE)
      .sum('clicks as clicks')
      .first();
    const prior = await db('gsc_pages')
      .where('page_url', page_url)
      .where('date', '>=', PRIOR_SINCE)
      .where('date', '<', SINCE)
      .sum('clicks as clicks')
      .first();
    const r = parseInt(recent?.clicks || 0, 10);
    const p = parseInt(prior?.clicks || 0, 10);
    if (p < 5) return { decay: false, note: 'no comparable prior period' };
    const drop = (p - r) / p;
    if (drop >= THRESHOLDS.decayMinDropPct) return { decay: true, drop, note: `down ${pct(drop)} vs prior ${PERIOD_DAYS}d` };
    return { decay: false, drop, note: `stable / improving` };
  } catch { return { decay: false, note: 'unavailable' }; }
}

// ── 3. Blog posts sample ───────────────────────────────────────────

async function pickBlogPosts() {
  const rows = await db('gsc_pages')
    .where('date', '>=', SINCE)
    .where('page_type', 'blog')
    .select('page_url', 'service_category', 'city_target')
    .sum('clicks as clicks')
    .sum('impressions as impressions')
    .avg('position as avg_position')
    .groupBy('page_url', 'service_category', 'city_target')
    .orderBy('impressions', 'desc')
    .limit(15)
    .catch(() => []);
  return rows.slice(0, 10);
}

// ── 4. Customer-question clusters (inline simplified) ──────────────

const QUESTION_PATTERNS = [
  { topic: 'pet safety', re: /(safe for (dog|cat|pet)s?|toxic|harmful)/i },
  { topic: 'rain-after-treatment', re: /(rain (after|ruin)|wash off|raining)/i },
  { topic: 'same-day service', re: /(today|same.?day|right now|asap|emergency)/i },
  { topic: 'price-cost', re: /(how much|cost|price|estimate|quote)/i },
  { topic: 'termite vs flying ants', re: /(termite|flying ants?|swarm)/i },
  { topic: 'rodent attic noise', re: /(scratching|attic|rats?|mice|noise at night|in the walls)/i },
  { topic: 'mosquito treatment timing', re: /(mosquit(o|oes)|skeeters|biting outside)/i },
  { topic: 'roach identification', re: /(roach|palmetto bug|water bug|cockroach)/i },
  { topic: 'tiny bugs', re: /(tiny bugs?|small bugs?|ants? in (kitchen|bathroom))/i },
  { topic: 'leave house after spray', re: /(leave (the )?house|when can i (come back|reenter)|airing out)/i },
  { topic: 'bugs worse after spray', re: /(worse after|more bugs after|coming out after)/i },
  { topic: 'lawn fungus brown spots', re: /(brown spots?|fungus|dollar spot|grey leaf)/i },
  { topic: 'chinch bug damage', re: /(chinch|st\.?\s*augustine dying)/i },
  { topic: 'fire ants', re: /(fire ants?|ant mounds?|stinging)/i },
  { topic: 'ant trail kitchen', re: /(ant trails?|ants? in (line|kitchen|sink))/i },
  { topic: 'spider in house', re: /(spider|web|brown recluse|black widow)/i },
  { topic: 'fertilizer blackout question', re: /(fertiliz|nitrogen|phosphorus|summer feed)/i },
  { topic: 'service area-confirm', re: /(do you (service|cover|come to)|service area)/i },
];

function classifyQuestion(text) {
  if (!text) return null;
  for (const { topic, re } of QUESTION_PATTERNS) {
    if (re.test(text)) return topic;
  }
  return null;
}

// PII redaction for any example we surface. Mirrors the production
// pii-redactor.js (which lives on Step 3's branch and isn't importable
// from here) — structured patterns + an aggressive standalone name pair
// pass guarded by a small allowlist of SWFL cities, staff, and common
// non-name capitalized words. False-positive redactions are cheap;
// false-negative name leaks in the calibration report are not.
const NAME_ALLOWLIST = new Set([
  'Bradenton', 'Sarasota', 'Venice', 'Parrish', 'Palmetto', 'North', 'Port',
  'Charlotte', 'Lakewood', 'Ranch', 'Manatee', 'Anna', 'Maria', 'Longboat',
  'Siesta', 'Key', 'Island', 'Wave', 'Waves', 'Pest', 'Control', 'Lawn',
  'Care', 'Mosquito', 'Termite', 'Rodent', 'Ant', 'Roach', 'Spider',
  'Florida', 'Friday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday',
  'Saturday', 'Sunday', 'January', 'February', 'March', 'April', 'May',
  'June', 'July', 'August', 'September', 'October', 'November', 'December',
  'Saint', 'St', 'Google', 'Facebook', 'Yelp', 'BBB', 'YouTube', 'Stripe',
  'Twilio', 'Adam', 'Virginia', 'Jose', 'Jacob', 'Alvarado', 'Heaton',
]);

function looksLikeAllowlist(first, last) {
  if (!first || !last) return true;
  if (NAME_ALLOWLIST.has(first) || NAME_ALLOWLIST.has(last)) return true;
  if (first === first.toUpperCase() || last === last.toUpperCase()) return true;
  if (first.length < 2 || last.length < 2) return true;
  return false;
}

function redact(text) {
  if (!text) return '';
  let out = String(text);
  // Structured patterns.
  out = out.replace(/\b\+?1?[-.\s]?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/g, '[phone]');
  out = out.replace(/[\w._%+-]+@[\w.-]+\.[A-Za-z]{2,}/g, '[email]');
  out = out.replace(/\b\d{3}-\d{2}-\d{4}\b/g, '[ssn]');
  out = out.replace(/\b\d{1,6}\s+([A-Z][a-zA-Z]+\s+){1,4}(St|Street|Ave|Avenue|Blvd|Boulevard|Rd|Road|Dr|Drive|Ln|Lane|Way|Ct|Court|Cir|Circle|Pl|Place|Pkwy|Parkway|Hwy|Highway|Ter|Terrace|Trl|Trail)\.?\b/g, '[address]');
  out = out.replace(/\b(FL|Florida)\s+\d{5}(-\d{4})?\b/g, '[zip]');
  // Aggressive standalone first+last name pair (allowlist filtered).
  out = out.replace(/\b([A-Z][a-z]{1,15})\s+([A-Z][a-z]{1,20})\b/g, (m, f, l) =>
    looksLikeAllowlist(f, l) ? m : '[name]'
  );
  return out.slice(0, 220);
}

async function pickCustomerClusters() {
  const clusters = new Map();
  const bump = (topic, city, source, example) => {
    const key = `${topic}::${city || 'unknown'}`;
    const c = clusters.get(key) || { topic, city: city || 'unknown', sources: {}, last_seen: null, example: null };
    c.sources[source] = (c.sources[source] || 0) + 1;
    if (!c.example && example) c.example = redact(example);
    clusters.set(key, c);
  };

  // Eligibility audit for the report — mirrors the production
  // customer-insights-miner gates so calibration output can't surface
  // sources the production engine would refuse to mine.
  const eligibility = { records_seen: 0, excluded: {} };
  const reject = (reason) => {
    eligibility.excluded[reason] = (eligibility.excluded[reason] || 0) + 1;
  };

  // Pre-load suppression list + check whether the consent column exists.
  // FL 934.03 + FTC data-minimization: don't surface call examples
  // without explicit recording consent, and don't surface SMS from
  // opted-out senders.
  let consentColumnPresent = false;
  try {
    const cols = await db('information_schema.columns')
      .where({ table_name: 'call_log', table_schema: 'public' })
      .pluck('column_name');
    consentColumnPresent = cols.includes('call_recording_consent_disclaimer_played');
  } catch { /* */ }

  let suppressedPhones = new Set();
  try {
    const rows = await db('messaging_suppression').where('active', true).pluck('phone');
    suppressedPhones = new Set(rows.map((p) => String(p || '').replace(/\D/g, '').replace(/^1/, '')));
  } catch { /* table absent */ }

  // SMS — inbound, recent, sender not suppressed.
  try {
    const sms = await db('messages')
      .where('messages.direction', 'inbound')
      .where('messages.channel', 'sms')
      .where('messages.author_type', 'customer')
      .where('messages.created_at', '>=', new Date(Date.now() - THRESHOLDS.customerClusterRecencyDays * 86400_000))
      .leftJoin('conversations', 'messages.conversation_id', 'conversations.id')
      .leftJoin('customers', 'conversations.customer_id', 'customers.id')
      .select(
        'messages.body',
        db.raw('COALESCE(conversations.contact_phone, customers.phone) as from_phone')
      )
      .limit(2000);
    for (const m of sms) {
      eligibility.records_seen++;
      const fromPhone = String(m.from_phone || '').replace(/\D/g, '').replace(/^1/, '');
      if (!fromPhone) { reject('suppression_lookup_unavailable'); continue; }
      if (suppressedPhones.has(fromPhone)) { reject('suppressed_sender'); continue; }
      const topic = classifyQuestion(m.body);
      if (topic) bump(topic, null, 'sms', m.body);
    }
  } catch { /* table absent or schema drift */ }

  // Call lead_synopsis — degrade closed when consent column missing.
  // Production miner does the same; calibration must match so the
  // report doesn't surface unconsented call snippets.
  try {
    if (!consentColumnPresent) {
      // Count and reject without ever reading lead_synopsis.
      const count = await db('call_log')
        .where('direction', 'inbound')
        .where('created_at', '>=', new Date(Date.now() - THRESHOLDS.customerClusterRecencyDays * 86400_000))
        .whereNotNull('lead_synopsis')
        .count('* as c')
        .first();
      const n = parseInt(count?.c || 0, 10);
      eligibility.records_seen += n;
      if (n > 0) eligibility.excluded.consent_column_missing = n;
    } else {
      const calls = await db('call_log')
        .where('direction', 'inbound')
        .where('created_at', '>=', new Date(Date.now() - THRESHOLDS.customerClusterRecencyDays * 86400_000))
        .whereNotNull('lead_synopsis')
        .select('lead_synopsis', 'call_outcome', 'call_recording_consent_disclaimer_played')
        .limit(2000);
      for (const c of calls) {
        eligibility.records_seen++;
        if (c.call_recording_consent_disclaimer_played !== true) { reject('consent_not_played'); continue; }
        if (['wrong_number', 'spam'].includes(c.call_outcome)) { reject('non_service_call'); continue; }
        const topic = classifyQuestion(c.lead_synopsis);
        if (topic) bump(topic, null, 'call', c.lead_synopsis);
      }
    }
  } catch { /* */ }

  // Google reviews — public content; still gate against low-star
  // (cherry-picking complaints is bad faith) and JSON-blob review_text
  // rows (Step 0 surfaced ~3 such rows in google_reviews).
  try {
    const reviews = await db('google_reviews')
      .where('review_created_at', '>=', new Date(Date.now() - 365 * 86400_000))
      .whereNotNull('review_text')
      .select('review_text', 'star_rating', 'location_id')
      .limit(2000);
    for (const r of reviews) {
      eligibility.records_seen++;
      if (typeof r.star_rating === 'number' && r.star_rating < 3) { reject('low_star_complaint'); continue; }
      if (/^\s*\{[\s\S]*\}\s*$/.test(r.review_text)) { reject('json_blob_in_text'); continue; }
      const topic = classifyQuestion(r.review_text);
      if (topic) bump(topic, r.location_id, 'review', r.review_text);
    }
  } catch { /* */ }

  // Stash eligibility on the function for the report writer to surface.
  pickCustomerClusters.lastEligibility = eligibility;

  return Array.from(clusters.values())
    .map((c) => ({
      ...c,
      total: Object.values(c.sources).reduce((a, b) => a + b, 0),
    }))
    .sort((a, b) => b.total - a.total)
    .slice(0, 20);
}

// ── 5. SERP profiling (optional) ───────────────────────────────────

async function profileSampleSerps() {
  if (SKIP_SERP) return { skipped: true };
  let SERPAnalyzer;
  try { SERPAnalyzer = require('../services/seo/serp-analyzer'); }
  catch (e) { return { skipped: true, error: `serp-analyzer unavailable: ${e.message}` }; }

  // Pick top 5 striking-distance keywords across the sample cities.
  // Position is an aggregate after groupBy, so the predicate has to be
  // in HAVING; Postgres rejects aggregates in WHERE. The earlier
  // version used whereRaw and silently produced an empty result via
  // the catch — fail-open on a SERP sampling pass would skip every
  // keyword and the calibration report's section 5 would read
  // 'no profiles' even with --no-serp omitted.
  const sampleKeywords = await db('gsc_queries')
    .where('date', '>=', SINCE)
    .where('is_branded', false)
    .select('query', 'city_target')
    .sum('impressions as impressions')
    .avg('position as avg_position')
    .groupBy('query', 'city_target')
    .havingRaw('avg(position) BETWEEN ? AND ?', [
      THRESHOLDS.strikingDistancePositionMin,
      THRESHOLDS.strikingDistancePositionMax,
    ])
    .orderBy('impressions', 'desc')
    .limit(5)
    .catch(() => []);

  const results = [];
  for (const k of sampleKeywords) {
    try {
      // serp-analyzer expects a keywordId from seo_target_keywords. Find or create soft-lookup.
      const targetRow = await db('seo_target_keywords')
        .whereRaw('LOWER(keyword) = ?', [String(k.query).toLowerCase()])
        .first()
        .catch(() => null);
      if (!targetRow) {
        results.push({ keyword: k.query, city: k.city_target, error: 'not in seo_target_keywords' });
        continue;
      }
      const profile = await SERPAnalyzer.analyzeKeyword(targetRow.id);
      results.push({ keyword: k.query, city: k.city_target, profile });
    } catch (e) {
      results.push({ keyword: k.query, city: k.city_target, error: e.message });
    }
  }
  return { profiles: results };
}

// ── markdown writers ──────────────────────────────────────────────

function writeHeader() {
  log(`# Autonomous Local SEO Engine — Calibration Report`);
  log('');
  log(`- **Generated:** ${new Date().toISOString()}`);
  log(`- **Lookback:** ${PERIOD_DAYS} days (since ${SINCE})`);
  log(`- **SERP profiling:** ${SKIP_SERP ? 'skipped (default — pass --with-serp to enable)' : 'enabled (--with-serp)'}`);
  log(`- **DB env:** ${process.env.NODE_ENV || 'development'}`);
  log('');
  log(`## Active thresholds (server/services/content/scoring-config.js)`);
  log('```json');
  log(JSON.stringify(THRESHOLDS, null, 2));
  log('```');
  log('');
}

function writeOpportunitiesSection(opps) {
  log(`## 1. Top 20 GSC opportunities`);
  log('');
  if (!opps.length) {
    log(`_No rows in \`gsc_queries\` matching filters. Confirm GSC sync is running._`);
    log('');
    return;
  }
  log('| # | Query | City | Bucket | Imp | Pos | CTR | Score | Action |');
  log('|---|---|---|---|---|---|---|---|---|');
  opps.forEach((o, i) => {
    log(`| ${i + 1} | ${o.query} | ${o.city_target || '—'} | ${o.bucket} | ${num(o.impressions)} | ${round(o.avg_position)} | ${pct(o.ctr || 0)} | ${o.score} | ${o.action} |`);
  });
  log('');
  const skips = opps.filter((o) => o.action === 'do_not_publish').length;
  log(`_${skips} of ${opps.length} would be skipped at current thresholds._`);
  log('');
}

function writePagesSection(title, rows, withDecay) {
  log(`## ${title}`);
  log('');
  if (!rows?.length) {
    log(`_No matching rows in \`gsc_pages\`. Confirm page-type classification has been backfilled._`);
    log('');
    return;
  }
  log('| URL | Type | City | Service | Clicks | Imp | Pos | Decay |');
  log('|---|---|---|---|---|---|---|---|');
  return Promise.all(rows.map(async (r) => {
    const d = withDecay ? await pageDecayClassification(r.page_url) : { note: '—' };
    log(`| ${r.page_url} | ${r.page_type || '—'} | ${r.city_target || '—'} | ${r.service_category || '—'} | ${num(r.clicks)} | ${num(r.impressions)} | ${round(r.avg_position)} | ${d.decay ? '⚠ ' : ''}${d.note} |`);
  })).then(() => log(''));
}

function writeClustersSection(clusters) {
  log(`## 4. Customer-question clusters (top 20)`);
  log('');

  // Eligibility audit: matches the production customer-insights-miner
  // gates (FL 934.03 call-recording consent, messaging suppression,
  // cherry-pick review guard). Calibration must surface these exclusions
  // so the report is honest about what was filtered before redaction.
  const e = pickCustomerClusters.lastEligibility || { records_seen: 0, excluded: {} };
  log(`Source eligibility (production gates applied):`);
  log(`- records seen: ${e.records_seen}`);
  for (const [reason, n] of Object.entries(e.excluded || {})) {
    log(`- excluded \`${reason}\`: ${n}`);
  }
  log('');

  if (!clusters.length) {
    log(`_No clusters detected. Either inbound message volume is low, regex patterns need tuning, all sources were gated out (e.g., consent column absent), or source tables are absent._`);
    log('');
    return;
  }
  log('| # | Topic | City | Sources | Total | Example (redacted) |');
  log('|---|---|---|---|---|---|');
  clusters.forEach((c, i) => {
    const sources = Object.entries(c.sources).map(([k, v]) => `${k}:${v}`).join(' ');
    const qualifies = c.total >= THRESHOLDS.customerClusterMinSize ? '✓' : '·';
    log(`| ${i + 1} ${qualifies} | ${c.topic} | ${c.city} | ${sources} | ${c.total} | ${c.example || '—'} |`);
  });
  log('');
  log(`_✓ marks clusters meeting the min-size threshold (${THRESHOLDS.customerClusterMinSize}). Adjust in scoring-config if too few/many qualify._`);
  log('');
}

function writeSerpSection(result) {
  log(`## 5. SERP profiles`);
  log('');
  if (result.skipped) {
    log(`_Skipped (${result.error || 'default — SERP profiling is opt-in'}). Pass --with-serp to spend DataForSEO credits on 5 sample profiles (also writes to seo_serp_analyses)._`);
    log('');
    return;
  }
  for (const p of result.profiles || []) {
    log(`### \`${p.keyword}\` — ${p.city || 'no city'}`);
    if (p.error) { log(`> error: ${p.error}`); log(''); continue; }
    // serp-analyzer returns `top_10_results` (snake_case), not `top10`.
    // Earlier iteration read profile.top10 — silently rendered empty
    // page-type/domain lists despite spending DataForSEO credits +
    // writing seo_serp_analyses.
    const top10 = p.profile?.top_10_results || p.profile?.top10 || [];
    log(`- Top 10 page types: ${top10.map((r) => r.type).join(', ')}`);
    log(`- Domains: ${top10.slice(0, 5).map((r) => r.domain).join(', ')}`);
    log('');
  }
}

function writeTuningSection(opps, clusters) {
  log(`## 6. Threshold tuning suggestions`);
  log('');
  const skips = opps.filter((o) => o.action === 'do_not_publish').length;
  const skipPct = opps.length ? skips / opps.length : 0;

  const notes = [];
  if (skipPct > 0.6) notes.push(`- **${pct(skipPct)} of opportunities are being skipped.** Threshold \`minImpressionsToScore\` (${THRESHOLDS.minImpressionsToScore}) or position bands may be too strict.`);
  if (skipPct < 0.15) notes.push(`- Only ${pct(skipPct)} of opportunities are being skipped. Engine would be very aggressive — consider raising \`minScoreToAct\`.`);

  const qualifyingClusters = clusters.filter((c) => c.total >= THRESHOLDS.customerClusterMinSize).length;
  if (clusters.length && qualifyingClusters === 0) {
    notes.push(`- Zero clusters meet \`customerClusterMinSize\` (${THRESHOLDS.customerClusterMinSize}). Either lower the threshold or extend the lookback window.`);
  } else if (qualifyingClusters > 15) {
    notes.push(`- ${qualifyingClusters} clusters qualify — engine will be overwhelmed with customer-question candidates. Raise \`customerClusterMinSize\`.`);
  }

  if (!notes.length) notes.push(`- Distribution looks reasonable. Re-run weekly during shadow-mode and watch for drift.`);
  notes.forEach((n) => log(n));
  log('');
}

// ── main ──────────────────────────────────────────────────────────

(async function main() {
  try {
    writeHeader();

    // Quick table presence audit so failure modes are obvious in the report.
    log(`## 0. Source table audit`);
    log('');
    log('| Table | Row count |');
    log('|---|---|');
    for (const t of ['gsc_queries', 'gsc_pages', 'blog_posts', 'call_log', 'messages', 'google_reviews', 'seo_target_keywords']) {
      const c = await safeCount(t);
      log(`| \`${t}\` | ${c === null ? '✗ unavailable' : num(c)} |`);
    }
    log('');

    const opps = await pickGscOpportunities().catch((e) => { log(`> gsc opportunities failed: ${e.message}`); return []; });
    writeOpportunitiesSection(opps);

    const pages = await pickServiceLocationPages().catch((e) => { log(`> service/location page sample failed: ${e.message}`); return []; });
    await writePagesSection('2. Service/location page sample (10 across traffic spread)', pages, true);

    const blogs = await pickBlogPosts().catch((e) => { log(`> blog page sample failed: ${e.message}`); return []; });
    await writePagesSection('3. Blog post sample (top 10 by impressions)', blogs, true);

    const clusters = await pickCustomerClusters().catch((e) => { log(`> customer clustering failed: ${e.message}`); return []; });
    writeClustersSection(clusters);

    const serp = await profileSampleSerps().catch((e) => ({ skipped: true, error: e.message }));
    writeSerpSection(serp);

    writeTuningSection(opps, clusters);

    fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
    fs.writeFileSync(OUTPUT_PATH, out.join('\n'));
    console.log(`\nWrote ${OUTPUT_PATH} (${out.length} lines)`);
    await db.destroy();
  } catch (err) {
    console.error('Calibration failed:', err);
    await db.destroy().catch(() => {});
    process.exit(1);
  }
})();
