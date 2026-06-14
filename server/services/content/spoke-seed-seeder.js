/**
 * spoke-seed-seeder.js — curated per-spoke blog topics (Phase 2 of the spoke
 * blog network) → opportunity_queue rows that flow through the EXISTING
 * autonomous chain (claim → decision-router → brief → writer agent → gates →
 * hero → Astro PR → poller auto-merge) with zero human touchpoints.
 *
 * Source of truth: server/data/spoke-seed-topics-v1.json. Each brief carries a
 * full editorial plan (working title, thesis, outline, primary/secondary
 * keywords, the most-relevant hub link + its branded-local anchor, byline,
 * schema, CTA) AND a `target_site` — the single spoke domain the post renders
 * on. The post is published with `domains: [target_site]` and a SELF-canonical
 * spoke URL, so it appears ONLY on that spoke (never the hub, never a sibling),
 * with exactly one contextual in-body link back to the hub for authority.
 *
 * Reuse of the operator-intercept lane (intentional, verified against the
 * engine):
 *  - bucket 'operator_intercept' (re-exported from intercept-brief-seeder):
 *    decision-router treats this bucket as operator-PINNED (no SERP-profile
 *    upgrades, no do_not_publish demotion); the runner composes these briefs
 *    with skipSerp; and content-quality-gate / seo-completion-gate exempt the
 *    serp/gsc evidence-attachment hard checks (keyed on the persisted
 *    gsc_signal.bucket) — the curated manifest IS the provenance. Spoke seeds
 *    need exactly that posture, so they share the bucket.
 *  - signal_metadata.operator_pinned=true is the belt-and-suspenders flag the
 *    router/quality-gate also accept.
 *  - signal_metadata.spoke_seed=true distinguishes a spoke seed from a
 *    competitor intercept so content-brief-builder applies THIS module's
 *    overlay (spoke-local binding instructions, hub-link anchor, target_sites)
 *    instead of intercept-brief-seeder's competitor-comparison overlay.
 *
 * city = NULL on every row (mirrors intercept-brief-seeder): a spoke seed is a
 * city-LOCAL blog post, not a facts-gated city×service landing page, so the
 * facts-sufficiency gate correctly reports "not applicable" rather than parking
 * it for facts gaps. Locality is carried by `target_sites` + the outline (which
 * names the city + neighborhoods) and verified by the quality gate's
 * two-city-mentions check; the LLM fact-check gate still runs at publish.
 *
 * dedupe_key `spoke:v1:<id>` + ON CONFLICT DO UPDATE → idempotent re-runs
 * (same status-preserving CASE as gsc-opportunity-miner / intercept-brief-
 * seeder: a claimed/done/pending_review row is never reset by a re-seed).
 */

const fs = require('fs');
const path = require('path');
const db = require('../../models/db');
const logger = require('../logger');
const { parseETDateTime } = require('../../utils/datetime-et');
const interceptSeeder = require('./intercept-brief-seeder');
const { normalizeSpokeSites } = require('../content-astro/spoke-sites');

const OPERATOR_INTERCEPT_BUCKET = interceptSeeder.OPERATOR_INTERCEPT_BUCKET;
const { BYLINE_AUTHORS } = interceptSeeder._internals;

const DEDUPE_PREFIX = 'spoke:v1:';
const DEFAULT_MANIFEST_PATH = path.join(__dirname, '../../data/spoke-seed-topics-v1.json');
const EXPIRES_DAYS_AFTER_AVAILABLE = 45;
const HUB_DOMAIN_KEY = 'wavespestcontrol.com';
// Spoke seeds score below the competitor-intercept clusters (82–88) so a
// time-sensitive intercept still outranks a routine spoke seed, but well above
// the 45 blog floor so they reliably clear the autonomous lane.
const DEFAULT_SCORE = 80;

// Resolve the single spoke key a brief targets. Must be a real role:spoke
// domain in the fleet AND not the hub (a hub-targeted "spoke seed" is a
// manifest error — those posts belong on the regular hub blog lane).
function normalizeTargetSite(value) {
  const keys = normalizeSpokeSites(value);
  const spokeKeys = keys.filter((k) => k !== HUB_DOMAIN_KEY);
  return spokeKeys.length > 0 ? spokeKeys[0] : null;
}

// A FAQ-policy-blocked pest topic → its SPECIFIC blocked service id (the same
// ids content-guardrails.FAQ_BLOCKED_SERVICES enforces). Carrying this onto the
// opportunity's `service` (instead of the coarse 'pest') means every RUNTIME
// guard — content-guardrails.evaluate + content-quality-gate, which key on
// `service` — sees the blocked topic and rejects an FAQ even if the writer
// emits one the manifest never asked for. Coarse 'pest' would hide it.
const BLOCKED_TOPIC_SERVICE = [
  [/\bbed[\s-]?bugs?\b/i, 'bed-bug'],
  [/\b(?:cockroach(?:es)?|roach(?:es)?)\b/i, 'cockroach'],
  [/\b(?:rodents?|rats?|mice|mouse)\b/i, 'rodent'],
  [/\bspiders?\b/i, 'spider'],
  [/\b(?:wasps?|hornets?)\b/i, 'wasp'],
  [/\b(?:termites?|drywood)\b/i, 'termite'],
];

// Engine service category. A blocked pest topic resolves to its specific
// blocked id (so the runtime FAQ guards see it); otherwise the coarse category
// from the slug prefix (mirrors intercept-brief-seeder.serviceForBrief).
function serviceForBrief(brief) {
  const slug = String(brief.slug || brief.page_url || '');
  const topic = briefTopicText(brief);
  for (const [re, id] of BLOCKED_TOPIC_SERVICE) {
    if (re.test(topic)) return id;
  }
  if (slug.includes('/lawn-care/')) return 'lawn';
  if (slug.includes('/termite/')) return 'termite';
  return 'pest';
}

function dedupeKeyFor(brief) {
  return `${DEDUPE_PREFIX}${brief.id}`;
}

function availableAtFor(brief) {
  const window = String(brief.window || 'immediate').trim();
  if (!window || window.toLowerCase() === 'immediate') return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(window)) {
    throw new Error(`spoke seed ${brief.id}: unrecognized window "${window}" (expected "immediate" or YYYY-MM-DD)`);
  }
  return parseETDateTime(`${window}T00:00`);
}

function loadManifest(file = DEFAULT_MANIFEST_PATH) {
  const raw = fs.readFileSync(file, 'utf8');
  const manifest = JSON.parse(raw);
  if (!Array.isArray(manifest.briefs) || manifest.briefs.length === 0) {
    throw new Error(`spoke seed manifest at ${file} has no briefs`);
  }
  const seenIds = new Set();
  for (const brief of manifest.briefs) {
    if (!brief.id || !brief.action) {
      throw new Error(`spoke seed manifest entry missing id/action: ${JSON.stringify(brief).slice(0, 120)}`);
    }
    if (seenIds.has(brief.id)) {
      throw new Error(`spoke seed manifest has a duplicate id: ${brief.id}`);
    }
    seenIds.add(brief.id);
    if (!brief.slug || !String(brief.slug).startsWith('/')) {
      throw new Error(`spoke seed ${brief.id}: slug must be an absolute path (got "${brief.slug || ''}")`);
    }
    if (!normalizeTargetSite(brief.target_site || brief.target_sites)) {
      throw new Error(`spoke seed ${brief.id}: target_site "${brief.target_site || ''}" is not a known role:spoke domain (and must not be the hub)`);
    }
    if (brief.hub_link && !/^https?:\/\//i.test(brief.hub_link)) {
      throw new Error(`spoke seed ${brief.id}: hub_link must be an absolute https URL`);
    }
    // FAQ policy: a spoke seed carries the coarse 'pest' service, so the
    // downstream FAQ-blocked-service guards can't see a blocked pest topic
    // (bed bug, cockroach, rodent, …). Enforce the no-FAQ-for-blocked-topics
    // rule at seed time instead — reject a blocked-topic brief that requests an
    // FAQ (FAQPage schema or an outline FAQ section).
    if (FAQ_BLOCKED_TOPIC_RE.test(briefTopicText(brief)) && briefRequestsFaq(brief)) {
      throw new Error(`spoke seed ${brief.id}: topic is FAQ-policy-blocked but requests an FAQ (FAQPage schema / outline FAQ) — remove the FAQ for this topic`);
    }
  }
  return manifest;
}

// Pest topics whose FAQ sections are policy-blocked (mirrors the ids in
// content-guardrails.FAQ_BLOCKED_SERVICES, matched as free-text phrases so a
// slug/keyword/title like "bed-bugs-…" is caught even though the row's coarse
// service is 'pest').
const FAQ_BLOCKED_TOPIC_RE = /\b(bed[\s-]?bugs?|cockroach(?:es)?|roach(?:es)?|rodents?|rats?|mice|mouse|spiders?|wasps?|hornets?|termites?|drywood)\b/i;
const FAQ_OUTLINE_RE = /\bfaq\b|frequently asked|common questions/i;

function briefTopicText(brief) {
  return `${brief.slug || ''} ${brief.primary_kw || ''} ${brief.working_title || ''}`;
}

function briefRequestsFaq(brief) {
  const schema = Array.isArray(brief.schema_types) ? brief.schema_types : [];
  const outline = Array.isArray(brief.outline) ? brief.outline : [];
  return schema.includes('FAQPage') || outline.some((s) => FAQ_OUTLINE_RE.test(String(s || '')));
}

function rowForBrief(brief, manifest, { now = new Date() } = {}) {
  const targetSite = normalizeTargetSite(brief.target_site || brief.target_sites);
  const availableAt = availableAtFor(brief);
  const expiresBase = availableAt || now;
  const expiresAt = new Date(expiresBase.getTime() + EXPIRES_DAYS_AFTER_AVAILABLE * 86400_000);
  return {
    bucket: OPERATOR_INTERCEPT_BUCKET,
    action_type: brief.action,
    query: brief.primary_kw || null,
    page_url: null, // new post — no existing page to refresh
    service: serviceForBrief(brief),
    city: null, // deliberate — keeps the facts gate "not applicable" (see header)
    score: DEFAULT_SCORE,
    score_breakdown: { base: DEFAULT_SCORE, spoke_seed: `manifest ${manifest.set || 'spoke-seed'} → ${targetSite}` },
    signal_metadata: {
      source: 'spoke-seed-seeder',
      operator_pinned: true,
      spoke_seed: true,
      target_sites: [targetSite],
      spoke_target_site: targetSite,
      spoke_city: brief.city || null,
      manifest_set: manifest.set || null,
      manifest_version: manifest.version || null,
      spoke_brief: brief,
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
 * status CASE mirrors intercept-brief-seeder.seedAll — claimed / done /
 * pending_review rows are never reset, while skipped/expired rows revive to
 * pending.
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
             updated_at = now()
      `,
      [
        row.bucket, row.action_type, row.query, row.page_url, row.service, row.city,
        row.score, JSON.stringify(row.score_breakdown), JSON.stringify(row.signal_metadata), row.status,
        row.mined_at, row.expires_at, row.available_at, row.dedupe_key,
      ]
    );
    count += result.rowCount || 1;
  }
  logger.info(`[spoke-seed-seeder] seeded ${count}/${rows.length} spoke topic(s) from ${path.basename(file)}`);
  return { dryRun: false, count, rows };
}

// ── recognition + targeting helpers ──────────────────────────────────

function isSpokeSeed(opportunity = {}) {
  const meta = opportunity && opportunity.signal_metadata;
  return !!(meta && typeof meta === 'object' && meta.spoke_seed === true);
}

// The normalized spoke target(s) for an opportunity, sourced from the seeded
// signal_metadata. Returns [] for non-spoke-seed opportunities.
function targetSitesFor(opportunity = {}) {
  const meta = opportunity && opportunity.signal_metadata;
  if (!meta || typeof meta !== 'object') return [];
  return normalizeSpokeSites(meta.target_sites).filter((k) => k !== HUB_DOMAIN_KEY);
}

// ── brief overlay (consumed by content-brief-builder) ────────────────

const FAQ_SECTION_RE = /\bfaq\b|frequently asked|common questions/i;

/**
 * Build the overlay content-brief-builder applies when composing a brief for a
 * spoke-seed opportunity. The curated payload is injected VERBATIM — outline
 * becomes the content plan, the hub link becomes a required in-body anchor, and
 * the binding instructions reach the writer agent as hard rules. Unlike the
 * competitor-intercept overlay there is NO competitor-comparison framing /
 * pricing-disclaimer footer; instead the writer is told to make the post
 * genuinely city-local and to carry exactly one branded-local hub link.
 */
function buildSpokeOverlay({ opportunity, pageType, requiredSections = [], schemaTypes = [] }) {
  const meta = (opportunity && typeof opportunity.signal_metadata === 'object' && opportunity.signal_metadata) || {};
  const payload = meta.spoke_brief;
  if (!payload) return null;

  const targetSite = normalizeTargetSite(payload.target_site || meta.spoke_target_site || meta.target_sites);
  const city = payload.city || meta.spoke_city || null;
  const outline = Array.isArray(payload.outline) ? [...payload.outline] : [];
  const outlineHasFaq = outline.some((s) => FAQ_SECTION_RE.test(String(s || '')));
  const structural = requiredSections.filter((s) => {
    // FAQ on a spoke post is governed SOLELY by the manifest outline — drop the
    // default supporting-blog FAQ section so a topic that doesn't request an FAQ
    // (e.g. the bed-bug seed, whose coarse 'pest' service hides it from the
    // FAQ-blocked guard) never silently gains one.
    if (FAQ_SECTION_RE.test(String(s || ''))) return false;
    return !outline.includes(s);
  });

  const schema = Array.from(new Set([
    ...(Array.isArray(payload.schema_types) ? payload.schema_types : []),
    ...(pageType === 'supporting-blog' ? ['Article', 'BreadcrumbList'] : []),
    ...schemaTypes,
  ]));

  const byline = BYLINE_AUTHORS[payload.byline] || BYLINE_AUTHORS.adam;
  const ctaCodes = meta.cta_codes || {};
  const ctaDirectives = (Array.isArray(payload.cta) ? payload.cta : [])
    .map((code) => `${code}: ${ctaCodes[code] || 'see manifest'}`);
  const hubLink = payload.hub_link || null;
  const hubAnchor = payload.hub_anchor || null;
  // Required in-body links: the hub link leads (most-relevant hub city/service
  // page) so the supporting-blog hub_link_present hard check is satisfied by
  // the curated target rather than a writer guess.
  const internalLinks = Array.from(new Set([
    ...(hubLink ? [hubLink] : []),
    ...(Array.isArray(payload.internal_links) ? payload.internal_links : []),
  ]));

  const operatorBrief = {
    id: payload.id,
    set: meta.manifest_set || null,
    spoke_seed: true,
    target_sites: targetSite ? [targetSite] : [],
    target_site: targetSite,
    city,
    working_title: payload.working_title || null,
    intent: payload.intent || null,
    slug: payload.slug || null,
    thesis: payload.thesis || null,
    outline,
    primary_kw: payload.primary_kw || null,
    secondary_kws: Array.isArray(payload.secondary_kws) ? payload.secondary_kws : [],
    hub_link: hubLink,
    hub_anchor: hubAnchor,
    internal_links_required: internalLinks,
    schema_types: Array.isArray(payload.schema_types) ? payload.schema_types : [],
    verify_notes: Array.isArray(payload.verify_notes) ? payload.verify_notes : [],
    faq_required: (Array.isArray(payload.schema_types) && payload.schema_types.includes('FAQPage')) || outlineHasFaq,
    cta_directives: ctaDirectives,
    byline: {
      key: payload.byline || 'adam',
      author_slug: byline.author_slug,
      author_frontmatter: byline.frontmatter,
      emphasis: byline.emphasis,
    },
    global_rules: meta.manifest_notes || null,
    binding_instructions: buildBindingInstructions({ payload, byline, ctaDirectives, city, targetSite, hubLink, hubAnchor, globalRules: meta.manifest_notes }),
  };

  return {
    required_sections: [...outline, ...structural],
    schema_types: schema,
    internal_links: internalLinks,
    operator_brief: operatorBrief,
  };
}

function buildBindingInstructions({ payload, byline, ctaDirectives, city, targetSite, hubLink, hubAnchor, globalRules }) {
  const cityName = city || 'the target city';
  const lines = [
    `This is a CURATED SPOKE blog post for ${cityName} (renders only on the ${targetSite} spoke). Everything below is BINDING — do not re-derive the topic, angle, slug, or hub link.`,
    payload.working_title ? `TITLE DIRECTION: "${payload.working_title}" — refine for length/SEO but keep the meaning and local promise intact.` : null,
    payload.slug ? `SLUG (exact, binding): ${payload.slug} — set the frontmatter slug to match exactly.` : null,
    payload.thesis ? `THESIS (the post must argue exactly this): ${payload.thesis}` : null,
    'OUTLINE: cover every outline item in the brief\'s required_sections, in order — they are the content plan, not suggestions.',
    `LOCAL SPECIFICITY (mandatory): write this as a genuinely ${cityName}-local article — name ${cityName} neighborhoods, landmarks, climate, or housing stock where the outline calls for it. The body must mention ${cityName} at least twice. Do NOT produce a city-swappable generic article; it must be distinct from every other post in the network.`,
    `SERVICE AREA: set the frontmatter service_areas_tag to ["${cityName}"].`,
    hubLink
      ? `REQUIRED HUB LINK (exactly one, contextual, in-body): link once to ${hubLink}${hubAnchor ? ` using a branded-local anchor like "${hubAnchor}"` : ' using a natural branded-local anchor'} — placed naturally inside a sentence near the end where you hand off to a professional, never as a button or a list item. The hub URL MUST be the absolute https://www.wavespestcontrol.com/... URL exactly as given — never a relative path and never a {{siteUrl}} token (that token rewrites to this spoke's own domain).`
      : null,
    `BRAND TOKENS: this post publishes on a spoke domain. Use the {{brandName}} token for any reference to the site's own brand. The ONLY place the literal hub brand "Waves Pest Control" may appear is inside the single hub-link anchor above.`,
    payload.internal_links?.length
      ? `ADDITIONAL HUB LINKS (optional, each a natural in-body anchor): ${payload.internal_links.join(', ')}.`
      : null,
    ...(Array.isArray(payload.verify_notes) ? payload.verify_notes.map((n) => `VERIFY BEFORE WRITING (mandatory): ${n} If a claim cannot be verified, OMIT it.`) : []),
    `AUTHOR (exact frontmatter author block): ${JSON.stringify(byline.frontmatter)}.`,
    byline.emphasis || null,
    ctaDirectives.length ? `CTAs (link each with its RELATIVE on-site path, e.g. [request a quote](/pest-control-quote/) — never an absolute URL; the conversion-CTA gate only recognizes relative hrefs): ${ctaDirectives.join(' || ')}` : null,
    Array.isArray(payload.schema_types) && payload.schema_types.includes('FAQPage')
      ? 'SCHEMA: emit FAQPage structured data with a matching VISIBLE FAQ section (questions as ### headings).'
      : null,
    'Never hardcode Waves pricing — link to /pest-control-calculator/ instead.',
    globalRules ? `GLOBAL RULES: ${globalRules}` : null,
  ];
  return lines.filter(Boolean);
}

module.exports = {
  OPERATOR_INTERCEPT_BUCKET,
  DEFAULT_MANIFEST_PATH,
  loadManifest,
  seedAll,
  isSpokeSeed,
  targetSitesFor,
  buildSpokeOverlay,
  _internals: {
    normalizeTargetSite,
    serviceForBrief,
    dedupeKeyFor,
    availableAtFor,
    rowForBrief,
    buildBindingInstructions,
    DEFAULT_SCORE,
    EXPIRES_DAYS_AFTER_AVAILABLE,
  },
};
