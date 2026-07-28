/**
 * category-seed-seeder.js — curated lawn / tree-shrub hub-blog topics
 * → opportunity_queue rows that flow through the EXISTING autonomous chain
 * (claim → decision-router → brief → writer agent → gates → hero → Astro PR
 * → poller auto-merge → IndexNow/links) with zero human touchpoints.
 *
 * Why this exists (owner rulings 2026-07-27): the GSC-driven miner never
 * surfaces lawn/tree-shrub blog opportunities because the site's query
 * footprint is pest-dominated (chicken-and-egg: little lawn content →
 * little lawn signal → no lawn opportunities mined). This seeder closes the
 * loop with a curated backlog — 24 lawn + 8 tree-shrub briefs in
 * server/data/category-seed-topics-v1.json — dripped ~2/week via
 * `available_at` windows.
 *
 * Reuse of the operator-intercept lane (intentional, verified against the
 * engine — same posture as spoke-seed-seeder):
 *  - bucket 'operator_intercept': decision-router treats the bucket as
 *    operator-PINNED (no SERP-profile upgrades, no do_not_publish demotion);
 *    the runner composes these briefs with skipSerp; content-quality-gate /
 *    seo-completion-gate exempt the serp/gsc evidence-attachment hard checks
 *    (keyed on the persisted gsc_signal.bucket) — the curated manifest IS
 *    the provenance.
 *  - signal_metadata.operator_pinned=true is the belt-and-suspenders flag
 *    the router/quality-gate also accept.
 *  - signal_metadata.category_seed=true distinguishes a category seed from a
 *    competitor intercept and from a spoke seed, so content-brief-builder
 *    applies THIS module's overlay (plain informational binding rules for a
 *    HUB post) instead of the competitor-comparison or spoke-local overlay.
 *
 * Hub-only by construction: no target_sites in signal_metadata, so
 * spoke-seed-seeder.targetSitesFor() returns [] and the publisher renders
 * the post on the hub like every mined supporting blog.
 *
 * city = NULL on every row (mirrors both sibling seeders): these are
 * city-FLAVORED informational posts, not facts-gated city×service landing
 * pages, so the facts-sufficiency gate correctly reports "not applicable"
 * instead of parking them for facts gaps. Local color is carried by the
 * curated outline and verified by the LLM fact-check gate at publish.
 *
 * Listicle note: applyListicleTreatment deliberately skips operator-pinned
 * briefs, so the list-shaped briefs in this manifest carry the citable-
 * listicle architecture (count-in-title, quick answer naming every item,
 * numbered H2s, sourced how-we-chose note, visible last-updated line)
 * directly in their curated outlines instead.
 *
 * dedupe_key `catseed:v1:<id>` + ON CONFLICT DO UPDATE → idempotent re-runs
 * (same status-preserving CASE as gsc-opportunity-miner / the sibling
 * seeders: a claimed/done/pending_review row is never reset by a re-seed).
 *
 * seedAll only runs when an operator invokes the seed script
 * (server/scripts/seed-category-topics.js) — an explicit operator action,
 * never a cron. Pacing after that is entirely `available_at` windows.
 */

const fs = require('fs');
const path = require('path');
const db = require('../../models/db');
const logger = require('../logger');
const { parseETDateTime } = require('../../utils/datetime-et');
// Same claim-budget ceiling claimNext/peek enforce — the reseed CASE below
// resets exhausted counts against this exact number, never a private copy.
const { _internals: { maxClaimAttempts } } = require('./opportunity-queue');
const interceptSeeder = require('./intercept-brief-seeder');
// Single source of truth for the FAQ-section policy: 'tree-shrub' (among
// others) is FAQ-blocked, and category seeds must NEVER ride the narrow
// operator-intercept FAQ exemption — a blocked service simply gets no FAQ.
const { isFaqBlockedService } = require('./content-guardrails');

const OPERATOR_INTERCEPT_BUCKET = interceptSeeder.OPERATOR_INTERCEPT_BUCKET;
const { BYLINE_AUTHORS, splitBriefSources } = interceptSeeder._internals;

const DEDUPE_PREFIX = 'catseed:v1:';
const DEFAULT_MANIFEST_PATH = path.join(__dirname, '../../data/category-seed-topics-v1.json');
const EXPIRES_DAYS_AFTER_AVAILABLE = 45;
// Category seeds score with spoke seeds (80): below the competitor-intercept
// clusters (82–88) so a time-sensitive intercept still outranks them, but
// above routine mined opportunities and well clear of the 45 blog floor, so
// each brief claims its slot in the window it activates (owner ruling
// 2026-07-27: "timed drip, wins its slot").
const DEFAULT_SCORE = 80;

// slug prefix → engine service category. Both are real service ids in
// blog-seo-contract (category lawn-care / tree-shrub, service targets
// /lawn-care/ and /tree-shrub-care/), so the service-link and category
// gates work unchanged.
const SERVICE_BY_SLUG_PREFIX = [
  ['/lawn-care/', 'lawn'],
  ['/tree-shrub/', 'tree-shrub'],
];

// FAQ-blocked pest topics (mirrors content-guardrails.FAQ_BLOCKED_SERVICES
// ids, matched as free-text so a slug/keyword/title names the topic even
// though the row's service is 'lawn'/'tree-shrub'). Lawn and tree-shrub
// topics shouldn't hit these — the check guards future manifest edits that
// drift a brief onto a blocked pest topic.
const BLOCKED_TOPIC_SERVICE = [
  [/\bbed[\s-]?bugs?\b/i, 'bed-bug'],
  [/\b(?:cockroach(?:es)?|roach(?:es)?)\b/i, 'cockroach'],
  [/\b(?:rodents?|rats?|mice|mouse)\b/i, 'rodent'],
  [/\bspiders?\b/i, 'spider'],
  [/\b(?:wasps?|hornets?)\b/i, 'wasp'],
  [/\b(?:termites?|drywood)\b/i, 'termite'],
];
const FAQ_SECTION_RE = /\bfaq\b|frequently asked|common questions/i;

function briefTopicText(brief) {
  return `${brief.slug || ''} ${brief.primary_kw || ''} ${brief.working_title || ''}`;
}

function blockedTopicIdFor(brief) {
  const topic = briefTopicText(brief);
  for (const [re, id] of BLOCKED_TOPIC_SERVICE) {
    if (re.test(topic)) return id;
  }
  return null;
}

function briefRequestsFaq(brief) {
  const schema = Array.isArray(brief.schema_types) ? brief.schema_types : [];
  const outline = Array.isArray(brief.outline) ? brief.outline : [];
  return schema.includes('FAQPage') || outline.some((s) => FAQ_SECTION_RE.test(String(s || '')));
}

function serviceForBrief(brief) {
  const slug = String(brief.slug || '');
  for (const [prefix, service] of SERVICE_BY_SLUG_PREFIX) {
    if (slug.startsWith(prefix)) return service;
  }
  return null;
}

function dedupeKeyFor(brief) {
  return `${DEDUPE_PREFIX}${brief.id}`;
}

function availableAtFor(brief) {
  const window = String(brief.window || 'immediate').trim();
  if (!window || window.toLowerCase() === 'immediate') return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(window)) {
    throw new Error(`category seed ${brief.id}: unrecognized window "${window}" (expected "immediate" or YYYY-MM-DD)`);
  }
  // Midnight ET of the window date — the row becomes claimable on that ET
  // day (the engine cron runs 9am ET).
  return parseETDateTime(`${window}T00:00`);
}

function loadManifest(file = DEFAULT_MANIFEST_PATH) {
  const raw = fs.readFileSync(file, 'utf8');
  const manifest = JSON.parse(raw);
  if (!Array.isArray(manifest.briefs) || manifest.briefs.length === 0) {
    throw new Error(`category seed manifest at ${file} has no briefs`);
  }
  const seenIds = new Set();
  const seenSlugs = new Set();
  for (const brief of manifest.briefs) {
    if (!brief.id || !brief.action) {
      throw new Error(`category seed manifest entry missing id/action: ${JSON.stringify(brief).slice(0, 120)}`);
    }
    if (seenIds.has(brief.id)) {
      throw new Error(`category seed manifest has a duplicate id: ${brief.id}`);
    }
    seenIds.add(brief.id);
    // This manifest is a NEW-POST backlog only. Refreshes of existing lawn
    // pages go through the mined aeo_gap/decay lanes, not here.
    if (brief.action !== 'new_supporting_blog') {
      throw new Error(`category seed ${brief.id}: action must be new_supporting_blog (got "${brief.action}")`);
    }
    if (!serviceForBrief(brief)) {
      throw new Error(`category seed ${brief.id}: slug must start with /lawn-care/ or /tree-shrub/ (got "${brief.slug || ''}")`);
    }
    if (seenSlugs.has(brief.slug)) {
      throw new Error(`category seed manifest has a duplicate slug: ${brief.slug}`);
    }
    seenSlugs.add(brief.slug);
    if (!brief.working_title || !brief.thesis || !Array.isArray(brief.outline) || brief.outline.length === 0) {
      throw new Error(`category seed ${brief.id}: working_title, thesis, and a non-empty outline are required`);
    }
    // Truth rule: every category seed must carry sources AND verify notes —
    // the lawn facts bank is only partially verified and the tree-shrub
    // facts bank is an unverified template, so the cited-source discipline
    // is the grounding for every claim.
    if (!Array.isArray(brief.sources) || brief.sources.length === 0) {
      throw new Error(`category seed ${brief.id}: sources are required (facts-bank refs and/or citable URLs)`);
    }
    if (!Array.isArray(brief.verify_notes) || brief.verify_notes.length === 0) {
      throw new Error(`category seed ${brief.id}: verify_notes are required`);
    }
    if (brief.byline && !BYLINE_AUTHORS[brief.byline]) {
      throw new Error(`category seed ${brief.id}: unknown byline "${brief.byline}"`);
    }
    // FAQ policy, fail-closed at seed time: a brief whose SERVICE is
    // FAQ-blocked ('tree-shrub' is), or whose topic text names a blocked
    // pest topic, may not request an FAQ. Category seeds never carry the
    // operator-intercept FAQ exemption.
    if ((isFaqBlockedService(serviceForBrief(brief)) || blockedTopicIdFor(brief)) && briefRequestsFaq(brief)) {
      throw new Error(`category seed ${brief.id}: service/topic is FAQ-policy-blocked but requests an FAQ (FAQPage schema / outline FAQ) — remove the FAQ`);
    }
    // The quality gate's localization check reads operator_brief.city — a
    // city-suffixed slug without a matching manifest city would let a
    // Sarasota post pass on Bradenton+Venice mentions alone.
    const citySuffix = String(brief.slug).match(/-(bradenton|sarasota|venice|parrish|palmetto|north-port|lakewood-ranch|port-charlotte)-fl\/$/);
    if (citySuffix) {
      const expected = citySuffix[1].replace(/-/g, ' ');
      const got = String(brief.city || '').trim().toLowerCase();
      if (got !== expected) {
        throw new Error(`category seed ${brief.id}: slug targets "${expected}" but city is "${brief.city || ''}" — set city to match`);
      }
    }
    availableAtFor(brief); // throws on a malformed window
  }
  return manifest;
}

function rowForBrief(brief, manifest, { now = new Date() } = {}) {
  const availableAt = availableAtFor(brief);
  // Expiry anchors on the LATER of activation and seed time: seeding (or
  // re-seeding) after a window has elapsed must still yield a claimable row,
  // not one expireStale() sweeps away immediately.
  const expiresBase = availableAt && availableAt.getTime() > now.getTime() ? availableAt : now;
  const expiresAt = new Date(expiresBase.getTime() + EXPIRES_DAYS_AFTER_AVAILABLE * 86400_000);
  return {
    bucket: OPERATOR_INTERCEPT_BUCKET,
    action_type: brief.action,
    query: brief.primary_kw || null,
    page_url: null, // new post — no existing page to refresh
    service: serviceForBrief(brief),
    city: null, // deliberate — keeps the facts gate "not applicable" (see header)
    score: DEFAULT_SCORE,
    score_breakdown: { base: DEFAULT_SCORE, category_seed: `manifest ${manifest.set || 'category-seed'}` },
    signal_metadata: {
      source: 'category-seed-seeder',
      operator_pinned: true,
      category_seed: true,
      manifest_set: manifest.set || null,
      manifest_version: manifest.version || null,
      category_brief: brief,
      manifest_notes: manifest.notes || null,
      cta_codes: manifest.cta_codes || {},
    },
    status: 'pending',
    mined_at: now,
    expires_at: expiresAt,
    available_at: availableAt,
    dedupe_key: dedupeKeyFor(brief),
  };
}

/**
 * Upsert every manifest brief into opportunity_queue. Idempotent: re-runs
 * update payload/score/window in place via ON CONFLICT (dedupe_key); the
 * status CASE mirrors the sibling seeders — claimed / done / pending_review
 * rows are never reset, while skipped/expired rows revive to pending.
 */
async function seedAll({ file = DEFAULT_MANIFEST_PATH, dryRun = false, now = new Date() } = {}) {
  const manifest = loadManifest(file);
  const rows = manifest.briefs.map((brief) => rowForBrief(brief, manifest, { now }));
  if (dryRun) return { dryRun: true, count: rows.length, rows };

  let count = 0;
  for (const row of rows) {
    const result = await db.raw(
      `INSERT INTO opportunity_queue
         (bucket, action_type, query, page_url, service, city,
          score, score_breakdown, signal_metadata, status,
          mined_at, expires_at, available_at, dedupe_key, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?::jsonb, ?::jsonb, ?, ?, ?, ?, ?, now(), now())
       ON CONFLICT (dedupe_key) DO UPDATE
         SET score = EXCLUDED.score,
             score_breakdown = EXCLUDED.score_breakdown,
             signal_metadata = EXCLUDED.signal_metadata,
             mined_at = EXCLUDED.mined_at,
             expires_at = EXCLUDED.expires_at,
             available_at = EXCLUDED.available_at,
             action_type = EXCLUDED.action_type,
             query = EXCLUDED.query,
             page_url = EXCLUDED.page_url,
             service = EXCLUDED.service,
             city = EXCLUDED.city,
             status = CASE WHEN opportunity_queue.status IN ('claimed', 'done', 'pending_review')
                           THEN opportunity_queue.status
                           ELSE 'pending'
                      END,
             -- Reviving a skipped/expired row is a fresh explicit operator
             -- signal — reset the lifetime claim budget, or a re-seeded
             -- attempts_exhausted row would be pending yet unclaimable
             -- (claimNext refuses it, the janitor instantly re-skips it).
             -- The pending-with-exhausted-count arm covers the window
             -- between the claim that hit the budget and the daily sweep
             -- that flips it to skipped — still 'pending' there, so the
             -- skipped/expired arm alone left the reseed silently inert.
             attempt_count = CASE WHEN opportunity_queue.status IN ('skipped', 'expired')
                                  THEN 0
                                  WHEN opportunity_queue.status = 'pending'
                                       AND opportunity_queue.attempt_count >= ?
                                  THEN 0
                                  ELSE opportunity_queue.attempt_count
                             END,
             updated_at = now()
      `,
      [
        row.bucket, row.action_type, row.query, row.page_url, row.service, row.city,
        row.score, JSON.stringify(row.score_breakdown), JSON.stringify(row.signal_metadata), row.status,
        row.mined_at, row.expires_at, row.available_at, row.dedupe_key,
        maxClaimAttempts(),
      ]
    );
    count += result.rowCount || 1;
  }
  logger.info(`[category-seed-seeder] seeded ${count}/${rows.length} category topic(s) from ${path.basename(file)}`);
  return { dryRun: false, count, rows };
}

// ── recognition helper ───────────────────────────────────────────────

function isCategorySeed(opportunity = {}) {
  const meta = opportunity && opportunity.signal_metadata;
  return !!(meta && typeof meta === 'object' && meta.category_seed === true);
}

// ── brief overlay (consumed by content-brief-builder) ────────────────

/**
 * Build the overlay content-brief-builder applies when composing a brief for
 * a category-seed opportunity. The curated payload is injected VERBATIM —
 * outline becomes the content plan, sources become required citations, and
 * the binding instructions reach the writer agent as hard rules. Unlike the
 * competitor-intercept overlay there is NO competitor-comparison framing,
 * and unlike the spoke overlay there is no spoke-domain binding — this is a
 * plain informational HUB post.
 */
function buildCategoryOverlay({ opportunity, pageType, requiredSections = [], schemaTypes = [] }) {
  const meta = (opportunity && typeof opportunity.signal_metadata === 'object' && opportunity.signal_metadata) || {};
  const payload = meta.category_brief;
  if (!payload) return null;

  const outline = Array.isArray(payload.outline) ? [...payload.outline] : [];
  const { urls: requiredSources, notes: sourceNotes } = splitBriefSources(payload);
  // FAQ policy, fail-closed at compose time too: a blocked service
  // ('tree-shrub') gets NO FAQ, period — category seeds never carry the
  // operator-intercept FAQ exemption, so faq_required must never be true
  // for a blocked service (loadManifest already rejects such briefs; this
  // guards rows seeded from an older/edited manifest).
  const service = serviceForBrief(payload);
  const faqBlocked = isFaqBlockedService(service) || !!blockedTopicIdFor(payload);
  const outlineHasFaq = !faqBlocked && outline.some((s) => FAQ_SECTION_RE.test(String(s || '')));
  const structural = requiredSections.filter((s) => {
    if (FAQ_SECTION_RE.test(String(s || ''))) {
      if (faqBlocked) return false; // blocked service never gains a default FAQ section
      if (outlineHasFaq) return false; // curated FAQ spec wins
    }
    return !outline.includes(s);
  });

  const payloadSchema = (Array.isArray(payload.schema_types) ? payload.schema_types : [])
    .filter((t) => !(faqBlocked && t === 'FAQPage'));
  const schema = Array.from(new Set([
    ...payloadSchema,
    ...(pageType === 'supporting-blog' ? ['Article', 'BreadcrumbList'] : []),
    ...schemaTypes,
  ]));

  const byline = BYLINE_AUTHORS[payload.byline] || BYLINE_AUTHORS.adam;
  const ctaCodes = meta.cta_codes || {};
  const ctaDirectives = (Array.isArray(payload.cta) ? payload.cta : [])
    .map((code) => `${code}: ${ctaCodes[code] || 'see manifest'}`);
  const internalLinks = Array.isArray(payload.internal_links) ? payload.internal_links : [];

  const operatorBrief = {
    id: payload.id,
    set: meta.manifest_set || null,
    category_seed: true,
    // The quality gate's localization check reads operator_brief.city and
    // requires the TARGET city twice — carried for city-specific briefs,
    // null for the genuinely SWFL-regional ones (which fall back to the
    // any-two-cities check).
    city: payload.city || null,
    working_title: payload.working_title || null,
    intent: payload.intent || null,
    slug: payload.slug || null,
    thesis: payload.thesis || null,
    outline,
    primary_kw: payload.primary_kw || null,
    secondary_kws: Array.isArray(payload.secondary_kws) ? payload.secondary_kws : [],
    required_sources: requiredSources,
    source_notes: sourceNotes,
    verify_notes: Array.isArray(payload.verify_notes) ? payload.verify_notes : [],
    internal_links_required: internalLinks,
    schema_types: payloadSchema,
    faq_required: !faqBlocked && (payloadSchema.includes('FAQPage') || outlineHasFaq),
    // The specific FAQ-blocked service id if a future manifest edit drifts a
    // brief onto a blocked pest topic (else null) — the runtime FAQ guards
    // read this so an FAQ the writer adds anyway is rejected.
    faq_blocked_topic: blockedTopicIdFor(payload),
    cta_directives: ctaDirectives,
    byline: {
      key: payload.byline || 'adam',
      author_slug: byline.author_slug,
      author_frontmatter: byline.frontmatter,
      emphasis: byline.emphasis,
    },
    global_rules: meta.manifest_notes || null,
    binding_instructions: buildBindingInstructions({ payload, byline, ctaDirectives, requiredSources, sourceNotes, globalRules: meta.manifest_notes, faqBlocked, payloadSchema }),
  };

  return {
    required_sections: [...outline, ...structural],
    schema_types: schema,
    internal_links: internalLinks,
    operator_brief: operatorBrief,
  };
}

function buildBindingInstructions({ payload, byline, ctaDirectives, requiredSources, sourceNotes, globalRules, faqBlocked, payloadSchema = [] }) {
  const city = String(payload.city || '').trim();
  const lines = [
    'This is a CURATED category-seed blog post for the hub (wavespestcontrol.com). Everything below is BINDING — do not re-derive the topic, angle, or slug.',
    payload.working_title ? `TITLE DIRECTION: "${payload.working_title}" — refine for length/SEO but keep the meaning intact.` : null,
    payload.slug ? `SLUG (exact, binding): ${payload.slug} — set the frontmatter slug to match exactly.` : null,
    payload.thesis ? `THESIS (the post must argue exactly this): ${payload.thesis}` : null,
    'OUTLINE: cover every outline item in the brief\'s required_sections, in order — they are the content plan, not suggestions.',
    'INFORMATIONAL LANE (hard rule): no near-me or transactional phrasing anywhere in the post — this is the blog, not a service page.',
    city
      ? `LOCAL SPECIFICITY (mandatory): this is a ${city} post — ground it in ${city} genuinely (neighborhoods, soils, housing stock, local conditions the outline calls for) and mention ${city} by name at least twice in the body. Never write a city-swappable template article.`
      : 'LOCALITY: this is a Southwest-Florida-regional post — ground it in the region\'s real conditions and name at least two of our SWFL cities naturally in the body.',
    requiredSources.length
      ? `REQUIRED SOURCES (cite in-post with explicit attribution): ${requiredSources.join(', ')}.`
      : null,
    ...(sourceNotes || []).map((n) => `SOURCING (binding): ${n}`),
    ...(Array.isArray(payload.verify_notes) ? payload.verify_notes.map((n) => `VERIFY BEFORE WRITING (mandatory): ${n} If a claim cannot be verified, OMIT it.`) : []),
    `AUTHOR (exact frontmatter author block): ${JSON.stringify(byline.frontmatter)}.`,
    byline.emphasis || null,
    ctaDirectives.length ? `CTAs (link each with its RELATIVE on-site path, e.g. [request a quote](/pest-control-quote/) — never an absolute URL; the conversion-CTA gate only recognizes relative hrefs): ${ctaDirectives.join(' || ')}` : null,
    faqBlocked
      ? 'FAQ (hard rule): this topic/service is FAQ-policy-blocked — do NOT add an FAQ section or FAQPage schema, even if it seems helpful.'
      : (payloadSchema.includes('FAQPage')
        ? 'SCHEMA: emit FAQPage structured data with a matching VISIBLE FAQ section (questions as ### headings).'
        : null),
    'Never hardcode Waves pricing or dollar amounts — if cost comes up, direct readers to /contact/ (lawn and tree & shrub have no calculator flow).',
    globalRules ? `GLOBAL RULES: ${globalRules}` : null,
  ];
  return lines.filter(Boolean);
}

module.exports = {
  OPERATOR_INTERCEPT_BUCKET,
  DEFAULT_MANIFEST_PATH,
  loadManifest,
  seedAll,
  isCategorySeed,
  buildCategoryOverlay,
  _internals: {
    serviceForBrief,
    blockedTopicIdFor,
    briefRequestsFaq,
    availableAtFor,
    rowForBrief,
    dedupeKeyFor,
    buildBindingInstructions,
    DEFAULT_SCORE,
    DEDUPE_PREFIX,
  },
};
