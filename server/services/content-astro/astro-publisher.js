/**
 * astro-publisher.js — commits a blog_posts row into the Astro repo as
 * a PR for preview, and merges it into main for production.
 *
 * Flow:
 *   draft → publishAstro()    → pr_open  (branch + file commits + PR open)
 *   pr_open → mergeAstro()    → merged   (PR merged to main; live build kicks off)
 *   merged → (Pages poll)     → live     (CF Pages deployment completes)
 *
 * Unpublish (soft):
 *   live → unpublishAstro()           → unpublish_pending (revert PR open)
 *   unpublish_pending → mergeAstro()  → draft (file gone from main; clears astro_* urls)
 *
 * Any GitHub failure → publish_failed with the error recorded. A CF Pages
 * build failure on the preview is flagged as build_failed by the poll
 * worker (not this service).
 *
 * Image handling: admin UI uploads/generates `featured_image_url`. If it
 * points at a portal-hosted or remote image, we download the bytes and commit
 * a hero image using the detected source format in the same feature branch as
 * the markdown file. Referenced in the frontmatter as
 * `/images/blog/<slug>/hero.<ext>`.
 */

const gh = require('./github-client');
const fm = require('./frontmatter');
const authorService = require('./author-service');
const db = require('../../models/db');
const logger = require('../logger');
const { assertValidBlogFrontmatter } = require('./schema-validator');
const contentGuardrails = require('../content/content-guardrails');
const { refineFootprintFindings } = require('../content/footprint-claim-classifier');
const comparisonTableGate = require('../content/comparison-table-gate');
const factCheckGate = require('../content/fact-check-gate');
const complianceGate = require('../content/compliance-gate');
const { describeHeroForAlt } = require('../content/hero-alt-vision');
const { normalizeContentUrl } = require('../content/content-registry');
const { normalizeSpokeSites, SPOKE_SITE_KEYS, HUB_SITE_KEYS } = require('./spoke-sites');
const { spokeBlogNetworkEnabled } = require('../content/spoke-blog-network');
const { resolveSpokeTarget, blogOriginForSpoke: sharedBlogOriginForSpoke } = require('./spoke-routing');
const { etDateString } = require('../../utils/datetime-et');

const ASTRO_BLOG_DIR = 'src/content/blog';
const ASTRO_HERO_DIR = 'public/images/blog';

// Only blog posts are governed by the blog frontmatter schema. Service/location
// pages live elsewhere and carry their own fields (trackingNumberKey, cityPhone,
// pageType, …) that the blog schema's additionalProperties:false would reject, so
// they must NOT be blog-schema-validated on refresh/metadata rewrite.
function isBlogTarget(filePath) {
  return typeof filePath === 'string' && filePath.startsWith(`${ASTRO_BLOG_DIR}/`);
}
const ASTRO_HERO_PUBLIC_BASE = '/images/blog';
const HUB_ORIGIN = (process.env.ASTRO_HUB_ORIGIN || 'https://www.wavespestcontrol.com').replace(/\/$/, '');
// Single-sourced from spoke-sites so the runner's publish-origin mirror can
// never disagree on what counts as the hub.
const BLOG_HUB_DOMAINS = HUB_SITE_KEYS;

// A hero already committed to the Astro repo — either the relative /images/blog
// path or its absolute hub URL. These are NOT re-fetched on republish (the
// asset already lives in the repo / on the live site).
function isCommittedHeroUrl(url) {
  return !!url && (
    url.startsWith(`${ASTRO_HERO_PUBLIC_BASE}/`)
    || url.startsWith(`${HUB_ORIGIN}${ASTRO_HERO_PUBLIC_BASE}/`)
  );
}

// Absolute public URL for DB/admin consumers. The portal admin editor renders
// blog_posts.featured_image_url directly, served from the PORTAL origin — which
// does not host the Astro repo's /images/blog assets — so a bare relative path
// would show a broken hero preview. Frontmatter keeps relative paths; the DB
// stores absolute.
function absoluteHeroUrl(ref) {
  if (!ref) return null;
  if (/^https?:\/\//i.test(ref)) return ref;
  if (ref.startsWith('/')) return `${HUB_ORIGIN}${ref}`;
  return null;
}

function hubOnlyBlogDomains() {
  return [...BLOG_HUB_DOMAINS];
}

function stampHubOnlyBlogDomains(frontmatter) {
  return stampBlogDomains(frontmatter, null);
}

// Stamp the post's domain targeting. A `spokeKey` (a single non-hub spoke from
// the fleet) renders the post ONLY on that spoke with a self-canonical spoke
// URL; null is the hub-only default. Both top-level `domains` and
// `tracking.domains` are set (the Astro build reads top-level; tracking mirrors
// it for the multi-domain analytics layer).
function stampBlogDomains(frontmatter, spokeKey) {
  const domains = spokeKey ? [spokeKey] : hubOnlyBlogDomains();
  const tracking = frontmatter.tracking
    && typeof frontmatter.tracking === 'object'
    && !Array.isArray(frontmatter.tracking)
    ? frontmatter.tracking
    : {};
  frontmatter.domains = [...domains];
  frontmatter.tracking = { ...tracking, domains: [...domains] };
  return frontmatter;
}

// The publish-origin routing decision (single-spoke resolution + kill switch
// + origin mapping) lives in the SHARED spoke-routing module — the runner's
// slug repair makes the same decision, and two copies would let repaired
// draft.url values and self-links point at a different host than the
// publisher actually uses (Codex r10). This wrapper only binds the
// publisher's HUB_ORIGIN default.
function blogOriginForSpoke(spokeKey) {
  return sharedBlogOriginForSpoke(spokeKey, HUB_ORIGIN);
}

// The first remark-substitution token (brandName/siteUrl/…) left un-interpolated
// in a body, or null. These belong to the .md remark pipeline; in an autonomous
// .mdx post they reach the build as undefined references and crash it.
function mdxBreakingToken(body) {
  const m = String(body || '').match(/\{\{\s*(brandName|brandShort|siteUrl|phone|tel|email|primaryCity|cityPhone)\s*\}\}/);
  return m ? m[0] : null;
}

// Write the resolved publish target (canonical + domains) back onto the ORIGINAL
// draft frontmatter so the persisted autonomous_runs.draft_payload reflects what
// was actually published — the PR poller / post-merge reconciliation read
// draft_payload.frontmatter.canonical to resolve the merged target. (The
// publisher resolves these on a clone, so the original draft would otherwise
// keep the writer's hub-defaulted canonical.)
function syncDraftPublishTarget(draft, frontmatter) {
  if (draft && draft.frontmatter && typeof draft.frontmatter === 'object' && !Array.isArray(draft.frontmatter)) {
    if (frontmatter.canonical) draft.frontmatter.canonical = frontmatter.canonical;
    if (Array.isArray(frontmatter.domains)) draft.frontmatter.domains = [...frontmatter.domains];
    // tracking is publisher-normalized too (stampBlogDomains rewrites
    // tracking.domains): the poller's merge gate compares the head's
    // targeting fields against this persisted draft, so an unsynced
    // tracking would flag the publisher's OWN normalized head as drift and
    // deadlock a green PR (PR #3508 r8 P1).
    if (frontmatter.tracking && typeof frontmatter.tracking === 'object' && !Array.isArray(frontmatter.tracking)) {
      draft.frontmatter.tracking = { ...frontmatter.tracking };
    }
  }
  return draft;
}

const { POST_CATEGORIES, slugLeafOf } = require('./blog-categories');
const POST_TYPES = new Set(['diagnostic', 'seasonal', 'by-grass-type', 'protocol', 'cost', 'comparison', 'case-study', 'location', 'decision']);
const SCHEMA_TYPES = new Set(['Article', 'BlogPosting', 'FAQPage', 'BreadcrumbList', 'HowTo', 'Service', 'Review']);
const SERVICE_AREAS = new Set(['Bradenton', 'Lakewood Ranch', 'Sarasota', 'Venice', 'North Port', 'Palmetto', 'Parrish', 'Port Charlotte']);
const DEFAULT_SERVICE_AREAS = Object.freeze(['Sarasota', 'Bradenton', 'Venice', 'Lakewood Ranch', 'North Port', 'Palmetto', 'Parrish', 'Port Charlotte']);
// Author blocks are WHITELISTED to name/role/fdacs_license/bio_url. No
// years_*/tenure field may ever be assembled into post frontmatter: the
// company was founded in 2024 and any years-of-experience claim is a
// fabrication (owner hard rule — the old years_swfl: 12 default shipped on
// every generated post).
const DEFAULT_BLOG_AUTHOR = Object.freeze({
  name: 'Adam Benetti',
  role: 'Founder & Lead Technician',
  fdacs_license: 'JB351547',
  bio_url: '/about/authors/adam-benetti',
});
const DEFAULT_TECHNICAL_REVIEWER = Object.freeze({
  name: 'Adam Benetti',
  credential: 'FDACS Licensed Pest Control Operator',
  fdacs_license: 'JB351547',
  bio_url: '/about/authors/adam-benetti',
});
const DISCLOSURE_TYPES = new Set(['pricing-transparency', 'service-area-limits', 'regulatory', 'none']);

const CATEGORY_ALIASES = {
  pest: 'pest-control',
  'pest control': 'pest-control',
  lawn: 'lawn-care',
  'lawn care': 'lawn-care',
  termite: 'termite',
  termites: 'termite',
  mosquito: 'mosquito',
  mosquitoes: 'mosquito',
  rodent: 'pest-control',
  rodents: 'pest-control',
  commercial: 'pest-control',
  'bed-bug': 'pest-control',
  'bed bugs': 'pest-control',
};

const POST_TYPE_ALIASES = {
  article: 'location',
  checklist: 'location',
  'how-to': 'protocol',
  howto: 'protocol',
};

function shortId(n = 6) {
  return Math.random().toString(36).slice(2, 2 + n);
}

function slugify(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 80);
}

// ── Frontmatter builder ────────────────────────────────────────────

async function buildFrontmatter(post) {
  const slug = post.slug || slugify(post.title);
  const author = post.author_slug ? await authorService.getAuthor(post.author_slug) : null;
  const reviewer = post.reviewer_slug ? await authorService.getAuthor(post.reviewer_slug) : null;

  // Frontmatter dates must never exceed the ACTUAL publish date: the Astro
  // site renders the post as soon as the PR merges, so a scheduled
  // publish_date (or a future reviewed/fact-checked stamp) would ship a
  // future-dated live page. Clamp everything to today (ET) at PR-open time;
  // a genuinely PAST publish_date (backdated original publish) is preserved.
  const todayEt = etDateString();
  const today = clampDateToToday(calendarDateOnly(post.publish_date), todayEt) || todayEt;
  const hub = (process.env.ASTRO_HUB_ORIGIN || 'https://www.wavespestcontrol.com').replace(/\/$/, '');
  const canonical = `${hub}/${slug}/`;

  const heroRef = post.featured_image_url
    ? (post.featured_image_url.startsWith('/images/blog/')
        ? post.featured_image_url
        : `${ASTRO_HERO_PUBLIC_BASE}/${slug}/hero.${post.hero_image_ext || imageExtFromSource(post.featured_image_url)}`)
    : null;
  // technically_reviewed / fact_checked are schema-REQUIRED: a present-but-
  // corrupt stamp heals to today ET (matching publish_date's fallback) rather
  // than dropping to undefined, which would fail assertValidBlogFrontmatter
  // and strand the row before a PR ever opens. An absent stamp stays absent
  // (unchanged behavior). Valid stamps are clamped so they never sit in the
  // future on a live page.
  const technicallyReviewedDate = clampDateToToday(calendarDateOnly(post.technically_reviewed_at), todayEt)
    || (post.technically_reviewed_at ? todayEt : null);
  const factCheckedDate = clampDateToToday(calendarDateOnly(post.fact_checked_at), todayEt)
    || (post.fact_checked_at ? todayEt : null);
  // City substitution applies to ABSENT stored areas only: with an invalid
  // stored value (['Tampa']) plus a valid city, letting city stand in would
  // silently replace the corrupt field and publish it — present-but-invalid
  // must normalize to empty so schema validation rejects the row (Codex r3).
  // ABSENT means null/undefined ONLY: the admin editor can persist an
  // explicit [] — an operator CLEARING the field — and inferring over it
  // could publish every default service area; it stays present-but-invalid
  // for validation to reject, same contract as the legacy backfill
  // (Codex r12).
  const storedAreasAbsent = post.service_areas_tag == null;
  const serviceAreas = normalizeServiceAreas(post.service_areas_tag, storedAreasAbsent ? post.city : undefined);
  const relatedServices = normalizeArray(post.related_services);
  // Blog posts from this publisher are hub-only. Spoke/service pages can still
  // carry spoke domains, but blog content should not fan out to city spokes.
  const domains = hubOnlyBlogDomains();

  const data = {
    title: post.title,
    slug: `/${slug}/`,
    meta_description: post.meta_description || '',
    primary_keyword: post.keyword || undefined,
    secondary_keywords: normalizeArray(post.secondary_keywords),
    category: normalizeCategory(post.category, post.tag),
    post_type: normalizePostType(post.post_type),
    // service_areas_tag is schema-REQUIRED (minItems 1). A row with no stored
    // areas and a city outside the service-area set used to emit `undefined`
    // here (dropped by the JSON round-trip) and hard-fail
    // assertValidBlogFrontmatter after the whole generation was already spent
    // — a mechanical failure, not a content problem. Infer from the
    // title/keyword haystack (DEFAULT_SERVICE_AREAS as the final fallback,
    // same rule the autonomous path uses); stored valid areas pass through
    // unchanged via inferServiceAreas' direct path. Inference is for
    // GENUINELY ABSENT data only: a stored value that normalizes to empty
    // (mistyped / out-of-area entries) is corrupt operator data, and
    // guessing over it would publish geographically inaccurate metadata —
    // keep the empty result so assertValidBlogFrontmatter rejects the row
    // (the pre-hardening behavior for invalid data; Codex r2).
    service_areas_tag: (serviceAreas.length > 0 || !storedAreasAbsent)
      ? serviceAreas
      : inferServiceAreas({ title: post.title, primary_keyword: post.keyword, tags: post.tag, city: post.city }, {}),
    related_services: relatedServices,
    spoke_links: normalizeArray(post.spoke_links),
    // Per-post domain targeting. For publisher-created blogs this is always
    // hub-only; spoke/domain-specific pages live in the service/location
    // collections, not the blog collection.
    domains,
    author: author ? {
      // Whitelisted author fields only — never years_*/tenure (fabricated
      // claim; see DEFAULT_BLOG_AUTHOR).
      name: author.name,
      role: author.role,
      fdacs_license: author.fdacs_license || undefined,
      bio_url: author.bio_url,
    } : undefined,
    technically_reviewed_by: reviewer ? {
      name: reviewer.name,
      credential: (reviewer.credentials && reviewer.credentials[0]) || reviewer.role,
      fdacs_license: reviewer.fdacs_license || undefined,
      bio_url: reviewer.bio_url,
    } : undefined,
    published: today,
    updated: today,
    technically_reviewed: reviewer && technicallyReviewedDate ? technicallyReviewedDate : undefined,
    fact_checked: factCheckedDate || undefined,
    review_cadence: 'quarterly',
    reading_time_min: post.reading_time_min || estimateReadingTime(post.content),
    hero_image: heroRef ? {
      src: heroRef,
      alt: post.hero_image_alt || post.title,
    } : undefined,
    og_image: heroRef || undefined,
    canonical,
    schema_types: schemaTypesForContent(post.content, ['Article']),
    disclosure: { type: 'pricing-transparency' },
    tracking: { domains: hubOnlyBlogDomains() },
  };

  // Drop undefined keys so YAML output stays clean.
  return JSON.parse(JSON.stringify(data));
}

function safeJson(v, fallback) {
  if (Array.isArray(v)) return v;
  if (typeof v === 'string') {
    try { return JSON.parse(v); } catch { return fallback; }
  }
  return fallback;
}

function normalizeArray(v) {
  const arr = safeJson(v, []);
  return Array.isArray(arr) ? arr.filter((item) => item != null && String(item).trim() !== '') : [];
}

function normalizeCategory(category, tag) {
  const raw = String(category || '').trim();
  if (POST_CATEGORIES.has(raw)) return raw;
  const mapped = CATEGORY_ALIASES[raw.toLowerCase()];
  if (mapped) return mapped;

  const tagText = String(tag || '').toLowerCase();
  if (tagText.includes('lawn')) return 'lawn-care';
  if (tagText.includes('termite') || tagText.includes('wdo')) return 'termite';
  if (tagText.includes('mosquito')) return 'mosquito';
  if (tagText.includes('tree') || tagText.includes('shrub')) return 'tree-shrub';
  if (tagText.includes('pest')
    || tagText.includes('ant')
    || tagText.includes('roach')
    || tagText.includes('rodent')
    || tagText.includes('bed bug')
    || tagText.includes('bedbug')
    || tagText.includes('spider')
    || tagText.includes('flea')
    || tagText.includes('tick')
    || tagText.includes('wasp')) return 'pest-control';
  return raw ? undefined : undefined;
}

function normalizePostType(postType) {
  const raw = String(postType || '').trim();
  if (POST_TYPES.has(raw)) return raw;
  const mapped = POST_TYPE_ALIASES[raw.toLowerCase()];
  return mapped || 'location';
}

function normalizeServiceAreas(value, city) {
  const areas = normalizeArray(value).filter((area) => SERVICE_AREAS.has(area));
  if (areas.length > 0) return areas;
  if (SERVICE_AREAS.has(city)) return [city];
  return [];
}

function inferServiceAreas(frontmatter = {}, brief = {}) {
  const direct = normalizeServiceAreas(frontmatter.service_areas_tag, frontmatter.city || brief.city);
  if (direct.length > 0) return direct;

  // An EXPLICIT city outside the service-area set is corrupt geography
  // data, exactly like invalid stored areas — haystack inference (or the
  // all-area fallback) over it would publish inaccurate metadata. Return
  // empty so schema validation rejects the row; the fallback chain below is
  // reserved for genuinely generic posts with NO city signal (Codex r11).
  const explicitCity = String(frontmatter.city || brief.city || '').trim();
  if (explicitCity && !SERVICE_AREAS.has(explicitCity)) return [];

  const haystack = [
    frontmatter.title,
    frontmatter.primary_keyword,
    brief.target_keyword,
    brief.city,
    frontmatter.tags,
  ].flatMap((value) => Array.isArray(value) ? value : [value]).filter(Boolean).join(' ').toLowerCase();
  // "Palmetto bugs" / "saw palmetto" / "laurel oaks" are Florida vernacular
  // (pests/plants), not the cities Palmetto / Laurel — scrub them before the
  // city-name match or a generic roach post gets committed with false city
  // metadata (Codex r13; same scrub social-content-studio applies to its
  // city-mention scanner, which is too heavy to require from here).
  const scrubbed = haystack.replace(/\b(?:saw\s+palmetto|palmetto\s+bugs?|laurel\s+oaks?)\b/g, ' ');
  const inferred = DEFAULT_SERVICE_AREAS.filter((area) => scrubbed.includes(area.toLowerCase()));
  return inferred.length > 0 ? inferred : [...DEFAULT_SERVICE_AREAS];
}

// Self-heal schema-required, safely inferable fields on a BLOG frontmatter
// about to be re-committed by the refresh / metadata-rewrite lanes. Those
// lanes freeze the LIVE page's frontmatter and swap only the editable
// fields — so a legacy (pre-schema-v2) post that never carried post_type /
// service_areas_tag re-validates with BOTH missing and hard-fails
// assertValidBlogFrontmatter ("post_type is required; service_areas_tag is
// required") on every attempt: a mechanical park, not a content problem.
// Backfill ONLY absent fields, and only from RELIABLE signals (a page_type
// that maps to a real post type; inferServiceAreas' haystack, all-area
// fallback reserved for no-city-signal posts). A field that is PRESENT —
// valid or not — is never touched, and an absent field with no reliable
// signal stays absent, so corrupt or unclassifiable rows still fail
// validation loudly and park for a one-time human fix.
function backfillLegacyBlogRequiredFields(nextFrontmatter, brief = {}) {
  const healed = [];
  const postType = nextFrontmatter.post_type;
  // Backfill covers GENUINELY ABSENT fields only: an explicit "" or
  // whitespace-only post_type is present-but-invalid data, and healing it
  // would bypass the schema rejection that exposes corrupt metadata (and
  // could select the wrong structural component requirements) — leave it
  // for validation to reject (Codex r5).
  if (postType == null) {
    // Only a page_type that RELIABLY maps to a post type is backfilled: the
    // 'location' fallback misclassifies seasonal/cost/comparison content
    // (writer contract), and post_type drives structural component
    // requirements. An unmappable legacy post stays missing and parks for
    // a one-time human classification (Codex r11).
    const rawPageType = String(nextFrontmatter.page_type || '').trim();
    const mapped = POST_TYPES.has(rawPageType) ? rawPageType : POST_TYPE_ALIASES[rawPageType.toLowerCase()];
    if (mapped) {
      nextFrontmatter.post_type = mapped;
      // page_type is a pre-schema-v2 key the blog schema rejects as
      // unknown — once consumed as the mapping signal it must not ride
      // into the committed frontmatter. An UNMAPPABLE page_type stays put
      // so validation parks the row loudly. The removal is DISCLOSED in
      // the healed list so PR-body summaries reflect the complete
      // metadata migration (Codex r12).
      delete nextFrontmatter.page_type;
      healed.push('post_type', 'page_type (legacy key consumed & removed)');
    }
  }
  // Same contract as post_type: an explicit empty array is PRESENT data —
  // someone (or something) wrote it — and inferring areas over it could
  // publish geographically inaccurate metadata; leave it for validation to
  // reject (Codex r11 pre-push audit).
  const areas = nextFrontmatter.service_areas_tag;
  if (areas == null) {
    nextFrontmatter.service_areas_tag = inferServiceAreas(nextFrontmatter, brief);
    healed.push('service_areas_tag');
  }
  if (healed.length) {
    logger.warn(`[astro-publisher] backfilled missing schema-required blog field(s) ${healed.join(', ')} on a legacy live frontmatter (pre-schema-v2 post)`);
  }
  return healed;
}

function normalizeAuthorBlock(value, fallback) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const name = String(source.name || fallback.name || '').trim();
  const role = String(source.role || fallback.role || '').trim();
  const bioUrl = String(source.bio_url || fallback.bio_url || '').trim();
  if (!name || !role || !/^\/about\/authors\/[a-z0-9-]+$/.test(bioUrl)) return { ...fallback };
  // Whitelist: name/role/bio_url/fdacs_license only. A writer-emitted
  // years_swfl (or any other tenure field) is DROPPED, never passed through —
  // the old years_swfl emission was a fabricated "12" (owner ruling
  // 2026-07-09 — real figure is 3, and tenure is not displayed anywhere).
  const out = { name, role, bio_url: bioUrl };
  const fdacs = String(source.fdacs_license || fallback.fdacs_license || '').trim();
  if (/^JB\d{4,}$/.test(fdacs)) out.fdacs_license = fdacs;
  return out;
}

function normalizeReviewerBlock(value, fallback) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const name = String(source.name || fallback.name || '').trim();
  const credential = String(source.credential || source.role || fallback.credential || '').trim();
  const bioUrl = String(source.bio_url || fallback.bio_url || '').trim();
  if (!name || !credential || !/^\/about\/authors\/[a-z0-9-]+$/.test(bioUrl)) return { ...fallback };
  const out = { name, credential, bio_url: bioUrl };
  const fdacs = String(source.fdacs_license || fallback.fdacs_license || '').trim();
  if (/^JB\d{4,}$/.test(fdacs)) out.fdacs_license = fdacs;
  return out;
}

function normalizeDisclosure(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const type = String(source.type || '').trim();
  const out = { type: DISCLOSURE_TYPES.has(type) ? type : 'pricing-transparency' };
  const text = String(source.text || '').trim();
  if (text) out.text = text;
  return out;
}

function normalizeAutonomousCategory(frontmatter = {}, brief = {}) {
  return normalizeCategory(frontmatter.category, [
    frontmatter.tag,
    frontmatter.tags,
    frontmatter.service,
    brief.service,
    frontmatter.primary_keyword,
    brief.target_keyword,
    frontmatter.title,
  ].flatMap((value) => Array.isArray(value) ? value : [value]).filter(Boolean).join(' ')) || 'pest-control';
}

// The binding blog schema caps meta_description at 160 chars
// (packages/blog-schema/schema.json), and the title/meta spam gate hard-fails a
// title over 90 chars (content-quality-gate `title_meta_spam_free`). The writer
// LLM reliably overshoots both despite its prompt (prod: meta_length_192–240,
// title_length_92/98), which previously hard-failed the WHOLE generation and
// wasted it. The publisher already owns fields the agent drifts on (hero); clamp
// title + meta the same way — truncate at a word boundary to the cap — instead
// of rejecting. (meta stays ≥115 for any real sentence, so the schema min still
// holds; a 90-char title still carries the keyword intent. Genuine spam — hype
// stacking, "the best", repeats — is unaffected and still blocks.)
const META_DESCRIPTION_MAX = 160;
const TITLE_MAX = 90;
function clampToWordBoundary(value, max) {
  const s = String(value || '').trim();
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const lastSpace = cut.lastIndexOf(' ');
  const trimmed = (lastSpace > 0 ? cut.slice(0, lastSpace) : cut)
    .replace(/[\s.,;:–—-]+$/u, '')
    .trim();
  return trimmed || cut.trim();
}
// Meta clamp is SENTENCE-aware: the bare word-boundary cut shipped visibly
// truncated meta_descriptions (no terminal punctuation, dangling phrases) —
// one of the recurring Codex findings on generated posts. Prefer cutting at
// the last complete sentence that still satisfies the schema minimum (115);
// only when no complete sentence fits fall back to the word-boundary cut,
// dropping a dangling connective and closing the fragment with a period so
// the shipped meta always reads as finished copy.
const META_DESCRIPTION_MIN = 115;
// The dangling-word set is content-quality-gate's DANGLING_META_ENDINGS —
// the SAME set checkMetaDescriptionComplete rejects on, so a clamped meta
// can never end on a word the gate calls dangling. Stripping loops because
// removing one dangling word can expose another ("…of the" → "…of").
const { DANGLING_META_ENDINGS } = require('../content/content-quality-gate');
function stripDanglingTail(s) {
  let out = String(s || '').trim();
  for (;;) {
    const words = out.split(/\s+/);
    if (words.length <= 1) return out;
    const last = (words[words.length - 1] || '').toLowerCase().replace(/[^a-z']/g, '');
    if (!DANGLING_META_ENDINGS.has(last)) return out;
    out = words.slice(0, -1).join(' ');
  }
}
// Dotted abbreviations whose period is NOT a sentence end — "St. Augustine
// grass" is a staple topic in this content, and cutting at "St." ships a
// meta ending mid-name.
const META_ABBREVIATION_TAIL_RE = /\b(?:St|Ft|Mt|Dr|Mr|Mrs|Ms|vs|etc|approx|U\.S|e\.g|i\.e)\.$/i;
function clampMetaDescription(meta) {
  const s = String(meta || '').trim();
  if (s.length <= META_DESCRIPTION_MAX) return s;
  const window = s.slice(0, META_DESCRIPTION_MAX);
  for (let i = window.length - 1; i >= META_DESCRIPTION_MIN - 1; i--) {
    // A sentence end is . ! ? followed by whitespace/close-quote/end in the
    // ORIGINAL string (so "4.5 stars" never counts), and not the period of a
    // dotted abbreviation ("St. Augustine" never counts either).
    if ('.!?'.includes(window[i])
      && (i + 1 >= s.length || /[\s"'”’)\]]/.test(s[i + 1]))
      && !META_ABBREVIATION_TAIL_RE.test(window.slice(0, i + 1))) {
      // Carry adjacent closing quotes/brackets so a sentence ending inside
      // a quotation ships whole ('…the silent lawn killer."', not a
      // dangling open quote). Still bounded by the window (<= max).
      let end = i + 1;
      while (end < window.length && /["'”’)\]]/.test(window[end])) end += 1;
      return window.slice(0, end).trim();
    }
  }
  const wordCut = clampToWordBoundary(s, META_DESCRIPTION_MAX - 1); // leave room for the closing period
  return `${stripDanglingTail(wordCut)}.`;
}
function clampTitle(title) {
  return clampToWordBoundary(title, TITLE_MAX);
}

function normalizeAutonomousBlogFrontmatter(frontmatter = {}, brief = {}, body = '', { slug, canonical } = {}) {
  // Dates are stamped deterministically at PR-open, never taken from the
  // writer agent's emitted frontmatter — models echo their (UTC) context date,
  // which reads as "tomorrow" when the PR opens in the ET evening, and
  // placeholder dates pass schema validation. This lane only ever publishes
  // brand-new posts (single caller, fresh content/autonomous-* branch), so
  // PR-open day in ET IS the publication date for all four fields.
  const published = etDateString();
  const updated = published;
  const reviewed = published;
  const factChecked = published;
  const heroAlt = String(frontmatter?.hero_image?.alt || frontmatter.hero_image_alt || frontmatter.title || '').trim();
  const defaultHeroSrc = `${ASTRO_HERO_PUBLIC_BASE}/${slug}/hero.webp`;
  const emittedHeroSrc = String(frontmatter?.hero_image?.src || '').trim();
  const heroSrc = emittedHeroSrc.startsWith(`${ASTRO_HERO_PUBLIC_BASE}/`) ? emittedHeroSrc : defaultHeroSrc;
  const schemaBase = [
    ...normalizeArray(brief.schema_types),
    ...normalizeArray(frontmatter.schema_types),
  ].filter((type) => type !== 'FAQPage' || contentHasFaqSection(body));

  const data = {
    title: clampTitle(frontmatter.title || brief.title || brief.target_keyword || ''),
    slug: `/${slug}/`,
    meta_description: clampMetaDescription(frontmatter.meta_description),
    primary_keyword: String(frontmatter.primary_keyword || brief.target_keyword || '').trim(),
    secondary_keywords: normalizeArray(frontmatter.secondary_keywords),
    category: normalizeAutonomousCategory(frontmatter, brief),
    post_type: normalizePostType(frontmatter.post_type || frontmatter.page_type),
    service_areas_tag: inferServiceAreas(frontmatter, brief),
    related_services: normalizeArray(frontmatter.related_services),
    spoke_links: normalizeArray(frontmatter.spoke_links),
    author: normalizeAuthorBlock(frontmatter.author, DEFAULT_BLOG_AUTHOR),
    technically_reviewed_by: normalizeReviewerBlock(frontmatter.technically_reviewed_by, DEFAULT_TECHNICAL_REVIEWER),
    published,
    updated,
    technically_reviewed: reviewed,
    fact_checked: factChecked,
    review_cadence: ['monthly', 'quarterly', 'annually'].includes(frontmatter.review_cadence) ? frontmatter.review_cadence : 'quarterly',
    reading_time_min: Number.isInteger(frontmatter.reading_time_min) && frontmatter.reading_time_min > 0
      ? frontmatter.reading_time_min
      : estimateReadingTime(body),
    hero_image: {
      src: heroSrc,
      alt: heroAlt || String(frontmatter.title || brief.target_keyword || 'Blog post hero image').trim(),
    },
    og_image: heroSrc,
    canonical,
    schema_types: schemaTypesForContent(body, schemaBase),
    disclosure: normalizeDisclosure(frontmatter.disclosure),
    tracking: frontmatter.tracking && typeof frontmatter.tracking === 'object' && !Array.isArray(frontmatter.tracking)
      ? { ...frontmatter.tracking }
      : undefined,
  };

  return JSON.parse(JSON.stringify(data));
}

function normalizeTargetSites(value) {
  const sites = normalizeSpokeSites(value);
  if (sites.length > 0) return sites;
  return normalizeArray(value).length > 0 ? ['wavespestcontrol.com'] : [];
}

function contentHasFaqSection(content) {
  const body = String(content || '');
  return /^#{2,3}\s+(?:\*\*)?(?:frequently asked|common questions|faqs?\b)/im.test(body)
    && /^#{3,4}\s+.+\?/m.test(body);
}

function schemaTypesForContent(content, baseTypes = ['Article']) {
  const types = Array.from(new Set((Array.isArray(baseTypes) && baseTypes.length > 0 ? baseTypes : ['Article'])
    .map((type) => String(type))
    .filter((type) => SCHEMA_TYPES.has(type))));
  if (types.length === 0) types.push('Article');
  if (contentHasFaqSection(content) && !types.includes('FAQPage')) {
    types.push('FAQPage');
  }
  return types;
}

function estimateReadingTime(text) {
  if (!text) return 3;
  const words = String(text).split(/\s+/).length;
  return Math.max(1, Math.round(words / 220));
}

// Calendar-date normalization for STORED blog dates (publish_date /
// technically_reviewed_at / fact_checked_at are DATE columns). pg/Knex
// returns DATE columns as midnight Date objects, so the stored calendar day
// is read directly (local date fields / date-string prefix) — round-tripping
// it through a timezone conversion shifts every persisted date to the
// previous ET day. Timezone (ET, via etDateString) only applies to "now"
// stamps. Sanity rails: dates before the company existed (2024) are corrupt
// rows → null, caller falls back (a live post shipped dated 1970-01-01 from
// exactly this); no post may claim a future publish date (clamped to today
// ET — the UTC version of this bug stamped "tomorrow" on ET-evening PRs).
const EARLIEST_VALID_CONTENT_DATE = '2024-01-01';

function calendarDateOnly(value) {
  if (!value) return null;
  let s = null;
  if (typeof value === 'string') {
    const m = /^(\d{4}-\d{2}-\d{2})(?:[T ]|$)/.exec(value.trim());
    if (m) s = m[1];
  }
  if (!s) {
    const d = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(d.getTime())) return null;
    s = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }
  if (s < EARLIEST_VALID_CONTENT_DATE) return null;
  const today = etDateString();
  return s > today ? today : s;
}

// Clamp a YYYY-MM-DD date so it never exceeds today (ET). ISO date strings
// compare correctly as strings. Null-safe: null in → null out (the callers'
// || fallbacks handle absence).
function clampDateToToday(isoDate, todayEt = etDateString()) {
  if (!isoDate) return null;
  return isoDate > todayEt ? todayEt : isoDate;
}

function imageExtFromMime(mime) {
  if (mime === 'image/png') return 'png';
  if (mime === 'image/jpeg' || mime === 'image/jpg') return 'jpg';
  if (mime === 'image/webp') return 'webp';
  return null;
}

function imageExtFromSource(url) {
  if (!url) return 'webp';
  const dataMatch = String(url).match(/^data:(image\/[a-z0-9.+-]+);base64,/i);
  if (dataMatch) return imageExtFromMime(dataMatch[1].toLowerCase()) || 'webp';
  try {
    const path = new URL(url, 'https://www.wavespestcontrol.com').pathname.toLowerCase();
    if (path.endsWith('.png')) return 'png';
    if (path.endsWith('.jpg') || path.endsWith('.jpeg')) return 'jpg';
    if (path.endsWith('.webp')) return 'webp';
  } catch { /* fall through */ }
  return 'webp';
}

// ── Image fetch (optional) ─────────────────────────────────────────

// Parse a base64 image data: URL WITHOUT running a regex across the payload.
// Generated heroes arrive as ~5-8MB data URLs; the previous
// /^data:...;base64,(.+)$/ match executed V8's backtracking engine over the
// whole multi-megabyte payload (and simply failed on provider base64 that
// contains whitespace/newlines, falling through to a network fetch() of a
// data: URL). Deep in the publish call chain that regex is the only
// huge-input operation and the prime suspect for the prod
// "Maximum call stack size exceeded" hero failure. Split at the first comma
// and regex ONLY the bounded header; Buffer.from(base64) tolerates embedded
// whitespace, so wrapped payloads now decode instead of erroring.
function parseImageDataUrl(url) {
  const s = String(url || '');
  if (!s.toLowerCase().startsWith('data:')) return null;
  const comma = s.indexOf(',');
  if (comma === -1) return null;
  const header = s.slice(0, comma); // bounded — never the multi-MB payload
  const m = header.match(/^data:(image\/[a-z0-9.+-]+);base64$/i);
  if (!m) return null;
  return { mime: m[1].toLowerCase(), base64: s.slice(comma + 1) };
}

async function fetchImageBuffer(url) {
  if (!url) return null;
  // In-repo path — nothing to fetch, already committed.
  if (url.startsWith('/images/blog/')) return null;
  const dataParsed = parseImageDataUrl(url);
  if (dataParsed) {
    return {
      buffer: Buffer.from(dataParsed.base64, 'base64'),
      ext: imageExtFromMime(dataParsed.mime),
    };
  }
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buffer = Buffer.from(await res.arrayBuffer());
    const ext = imageExtFromMime((res.headers.get('content-type') || '').split(';')[0].toLowerCase()) || imageExtFromSource(url);
    return { buffer, ext };
  } catch (err) {
    logger.warn(`[astro-publisher] image fetch failed (${url}): ${err.message}`);
    return null;
  }
}

// ── Hero image processing (publish-time) ───────────────────────────

// Resize + convert a hero image buffer to WebP. Generated heroes arrive as
// multi-MB PNGs and the hero renders eager + fetchpriority=high (LCP path),
// so the raw bytes must not ship. Forcing WebP also fixes the committed
// filename (hero.webp) so the merge step can persist the path deterministically.
// Mandatory (throws on failure → publish fails loudly) so the merge-time
// /images/blog/<slug>/hero.webp assumption always holds.
async function compressToWebp(buffer, { width = 1600 } = {}) {
  const sharp = require('sharp');
  return sharp(buffer)
    // Bake EXIF orientation into pixels before stripping metadata — a curated
    // phone/camera JPEG with an Orientation tag would otherwise serve sideways.
    .rotate()
    .resize({ width, withoutEnlargement: true })
    .webp({ quality: 80 })
    .toBuffer();
}

// ── Hero generation (publish-time) ─────────────────────────────────

// Generate a unique AI hero image for a post that has no curated
// featured_image_url, and return its bytes. The image-generator returns a
// `data:` URL (~5MB); we decode it to a Buffer in memory and the caller
// commits it into the PR branch as /images/blog/<slug>/hero.<ext>. The data
// URL is never written to the DB — featured_image_url is varchar(255) and the
// blog list does SELECT *, so persisting it would break/bloat both.
async function generateHeroBuffer(post) {
  const imageGenerator = require('../content/image-generator');
  const gen = await imageGenerator.generate({
    title: post.title,
    topic: post.meta_description,
    keyword: post.keyword,
    mode: 'blog-hero',
  });
  let img;
  try {
    img = await fetchImageBuffer(gen.dataUrl);
    if (!img?.buffer) throw new Error('hero image generation produced no usable image');
  } catch (err) {
    // Post-provider failure: the generator SUCCEEDED, so carry its provider
    // chain onto the thrown error — describeHeroFailure reads err.attempts,
    // and this failure class is exactly what the full diagnosis exists for
    // (Codex r1).
    if (!err.attempts && Array.isArray(gen.attempts)) err.attempts = gen.attempts;
    throw err;
  }
  logger.info(`[astro-publisher] generated hero image for ${post.slug || post.title} via ${gen.model}`);
  // Carry the generator's alt (derived from the actual generation prompt's
  // subject/setting) so callers can overwrite any pre-written
  // hero_image_alt — alt authored BEFORE the image exists routinely
  // mismatches what was generated. `attempts` rides along so downstream
  // post-generation failures (e.g. Sharp compression) can attach it too.
  return { ...img, alt: gen.alt || null, attempts: Array.isArray(gen.attempts) ? gen.attempts : null };
}

// ── Main publish ───────────────────────────────────────────────────

// Close + delete a post's still-open PR/branch before a build_failed retry so
// the replacement PR doesn't orphan it. Best-effort: each step is independent
// and non-fatal — a cleanup hiccup must not block the author's retry.
async function cleanupStaleAstroPr(post) {
  if (post.astro_pr_number) {
    try {
      const pr = await gh.getPr(post.astro_pr_number);
      if (pr && pr.state === 'open' && !pr.merged) {
        await gh.closePr(post.astro_pr_number);
        logger.info(`[astro-publisher] closed stale PR #${post.astro_pr_number} for post ${post.id} before republish`);
      }
    } catch (err) {
      logger.warn(`[astro-publisher] could not close stale PR #${post.astro_pr_number} for post ${post.id}: ${err.message}`);
    }
  }
  if (post.astro_branch_name) {
    try {
      await gh.deleteRef(post.astro_branch_name);
      logger.info(`[astro-publisher] deleted stale branch ${post.astro_branch_name} for post ${post.id} before republish`);
    } catch (err) {
      logger.warn(`[astro-publisher] could not delete stale branch ${post.astro_branch_name} for post ${post.id}: ${err.message}`);
    }
  }
}

// Run the LLM fact-check and throw BLOG_FACTCHECK_FAILED on a P0/P1 finding;
// advisory P2s are logged. Shared by every blog-content publish path (new
// admin draft, autonomous draft, refresh) so they all gate identically. The
// gate itself fails open, so this only throws on a real factual block.
async function assertFactCheckClear({ title, body, city, keyword, tag }, label) {
  const factCheck = await factCheckGate.evaluate({ title, body, city, keyword, tag });
  if (!factCheck.pass) {
    // Only P0 (objective, unambiguous) findings block; P1/P2 are advisory.
    const blocking = factCheck.findings.filter((f) => f.severity === 'P0');
    const err = new Error(`fact-check failed: ${blocking.map((f) => `${f.severity} ${f.message}`).join(' | ')}`);
    err.code = 'BLOG_FACTCHECK_FAILED';
    err.details = blocking;
    throw err;
  }
  // Non-blocking P1/P2 nuance — log for visibility but let the post publish.
  if (factCheck.findings.length) {
    logger.info(`[astro-publisher] fact-check advisory for ${label}: ${factCheck.findings.map((f) => `${f.severity} ${f.message}`).join(' | ')}`);
  }
}

// Run the LLM SEMANTIC compliance check and throw BLOG_COMPLIANCE_FAILED on a
// P0. The regex guardrails above already blocked every violation they can
// match; this catches the paraphrases their representation cannot express —
// most importantly whether a dry/timing clause actually GOVERNS the safety
// predicate ("safe once dry", exempt) or some other one ("safe for pets and
// works after it dries", a bare unconditional claim). Same fail-open posture
// as the fact-check above, so this only throws on a real compliance block.
// `meta` carries the EDITABLE metadata strings this lane actually writes —
// meta description, meta title, hero alt. The deterministic guard scans them as
// publishable text (content-guardrails.js `publishableText`), and a
// clause-attachment violation in a meta description is exactly as
// customer-visible as one in the body, so the semantic layer must see the same
// surface (Codex PR #3295 r1). Refresh lanes pass no hero alt, mirroring the
// regex gate: publishRefresh freezes frontmatter, so an alt it will not commit
// must not park the run. The sanctioned {{cityPhone}} token is scrubbed for the
// same reason the regex gate scrubs it — it is contract-required boilerplate,
// not prose, and only the deterministic guard polices where it may appear.
async function assertComplianceClear({ title, body, meta = [], city, keyword, tag }, label) {
  const metaText = meta
    .filter(Boolean)
    .map((v) => String(v).replace(/\{\{\s*cityPhone\s*\}\}/g, '').trim())
    .filter(Boolean)
    .join('\n\n');
  // The marker tells the semantic gate these are field VALUES — comment
  // delimiters here are literal rendered characters, so the prompt's
  // body-markup comment exemption is withdrawn past this line (Codex PR
  // #3302 r1: an alt text of "<!-- pesticide is EPA-approved -->" is
  // customer-visible copy, and the deterministic guard blanks comment-shaped
  // spans, so an unscoped exemption left no layer covering it).
  const publishableText = metaText ? `${body}\n\n${complianceGate.META_SECTION_MARKER}\n\n${metaText}` : body;
  const compliance = await complianceGate.evaluate({ title, body: publishableText, city, keyword, tag });
  if (!compliance.pass) {
    const blocking = compliance.findings.filter((f) => f.severity === 'P0');
    const err = new Error(`compliance gate failed: ${blocking.map((f) => `${f.code} ${f.message}`).join(' | ')}`);
    err.code = 'BLOG_COMPLIANCE_FAILED';
    err.details = blocking;
    throw err;
  }
  if (compliance.findings.length) {
    logger.info(`[astro-publisher] compliance advisory for ${label}: ${compliance.findings.map((f) => `${f.severity} ${f.code} ${f.message}`).join(' | ')}`);
  }
}

async function publishAstro(postId) {
  const post = await db('blog_posts').where({ id: postId }).first();
  if (!post) throw new Error(`blog_post ${postId} not found`);
  if (!post.title) throw new Error('post missing title');

  // Idempotency: each call cuts a fresh branch (random shortId) and overwrites
  // astro_branch_name/astro_pr_number, so publishing while a prior PR is still
  // open would orphan it. Two cases:
  //   - pr_open / unpublish_pending → an active PR awaiting merge/unpublish.
  //     Refuse: republishing now would duplicate in-flight work. Resolve it
  //     first. (No retry UI targets these.)
  //   - build_failed → the "fix the content and retry" path (admin Retry
  //     button hits this). The failed PR/branch are still open, so CLOSE +
  //     DELETE them before opening the replacement — that both unblocks the
  //     retry and prevents an orphan. Best-effort: cleanup failure is logged
  //     but doesn't block the republish.
  //   - publish_failed WITH a PR marker → the catch below persists the
  //     PR/branch when the failure landed after gh.createPr (e.g. the
  //     pr_open stamp itself died), so the admin Retry on publish_failed
  //     gets the same close+delete — without it the retry opened a SECOND
  //     PR and overwrote the marker, orphaning the first.
  // live/merged/draft and marker-less publish_failed have no open PR to
  // orphan (the existing-file SHA path handles in-place updates), so they
  // fall through.
  if (post.astro_status === 'pr_open' || post.astro_status === 'unpublish_pending') {
    throw new Error(
      `cannot publish post ${postId}: an Astro PR is already in flight (status "${post.astro_status}"`
      + `${post.astro_pr_number ? `, PR #${post.astro_pr_number}` : ''}); merge or unpublish it before republishing`,
    );
  }
  if (
    (post.astro_status === 'build_failed' || post.astro_status === 'publish_failed')
    && (post.astro_pr_number || post.astro_branch_name)
  ) {
    await cleanupStaleAstroPr(post);
  }

  const slug = post.slug || slugify(post.title);
  const branch = `content/blog-${slug}-${shortId()}`;
  // Tracked OUTSIDE the try: once a PR exists on GitHub, the catch below
  // must persist its number even though the pr_open stamp never landed —
  // "astro_pr_number IS NULL" is what the scheduler's transient-retry fork
  // reads as proof the failure happened BEFORE PR creation, and losing the
  // marker here would let the next tick open a duplicate PR.
  let openedPr = null;
  // Same discipline for the branch: each attempt cuts a FRESH shortId
  // branch, so a branch that was created but never reached a PR must be
  // deleted on the way out — the scheduler's retry would otherwise leave
  // one orphan branch (with its hero commit) per 15-minute tick that no
  // later cleanup can locate.
  let branchCreated = false;
  // Whether gh.createPr was CALLED: a call that threw may still have
  // created the PR on GitHub's side (ghFetch retries POSTs on 5xx, and a
  // timeout can land after creation) — the catch must look the branch up
  // before deleting it, or it deletes a live PR's head.
  let prCreateAttempted = false;

  try {
    // 1. Hero image (required by the Astro schema). Fetch before branch
    // creation so validation/fetch failures do not leave orphan branches.
    //
    // Three cases:
    //   - featured_image_url is a curated/hosted URL → fetch its bytes and
    //     commit them as the hero (a real photo always wins).
    //   - featured_image_url is empty → generate a unique AI hero at publish
    //     time and commit it. The bytes stay in memory; we never persist the
    //     ~5MB data: URL to the DB (featured_image_url is varchar(255) and the
    //     blog list does SELECT *, so storing it there would bloat every load).
    //   - featured_image_url already references a committed hero (relative
    //     /images/blog/ path or its absolute hub URL) → it's in the repo from a
    //     prior merged publish; reference it as-is, don't re-fetch.
    let heroImage = null;
    if (post.featured_image_url && !isCommittedHeroUrl(post.featured_image_url)) {
      // Tagged BLOG_HERO_MEDIA_FAILED so the scheduler parks it with the
      // other deterministic publish errors: a curated featured_image_url
      // that 404s or isn't an image fails identically every attempt, and
      // the transient-retry fork would re-burn the publish every 15
      // minutes forever. (A rare network blip parking for review is the
      // fail-safe direction; the author just reschedules.) AI hero
      // GENERATION failures below stay untagged — provider hiccups are
      // genuinely transient.
      try {
        heroImage = await fetchImageBuffer(post.featured_image_url);
      } catch (mediaErr) {
        const e = new Error(`featured image could not be fetched for Astro publish: ${mediaErr.message}`);
        e.code = 'BLOG_HERO_MEDIA_FAILED';
        throw e;
      }
      if (!heroImage?.buffer) {
        const e = new Error('featured image could not be fetched for Astro publish');
        e.code = 'BLOG_HERO_MEDIA_FAILED';
        throw e;
      }
    } else if (!post.featured_image_url) {
      heroImage = await generateHeroBuffer(post);
    }
    // Normalize any committed hero to a resized WebP. Generated heroes are
    // ~3-5MB PNGs and the layout renders the hero eager + fetchpriority=high
    // (it's on the LCP path), so shipping the raw PNG would tank first-paint.
    // Converting also makes the committed filename deterministic (hero.webp),
    // which lets the merge step persist the public path without tracking the
    // source extension.
    if (heroImage?.buffer) {
      // Preserve alt across the recompress — only the generated path sets it.
      heroImage = { buffer: await compressToWebp(heroImage.buffer), ext: 'webp', alt: heroImage.alt || null };
    }
    const heroImageExt = heroImage?.buffer ? 'webp' : imageExtFromSource(post.featured_image_url);

    // Public path the frontmatter references. Whenever we have bytes to commit
    // they land at /images/blog/<slug>/hero.webp; a /images/blog/ value is
    // already committed from a prior (merged) publish.
    const heroPublicRef = heroImage?.buffer
      ? `${ASTRO_HERO_PUBLIC_BASE}/${slug}/hero.webp`
      : (post.featured_image_url || null);

    // 2. Markdown frontmatter/body validation
    // A freshly GENERATED hero carries its own alt (derived from the
    // generation prompt) and overrides any pre-written hero_image_alt — the
    // stored alt was authored before this image existed. Curated/committed
    // heroes keep the stored alt.
    const data = await buildFrontmatter({
      ...post,
      slug,
      hero_image_ext: heroImageExt,
      featured_image_url: heroPublicRef,
      hero_image_alt: vetGeneratedAlt(heroImage?.alt, post.hero_image_alt),
    });
    assertValidBlogFrontmatter(data);
    const body = (post.content || '').trim();

    // 2b. Content-policy guardrails (hardcoded price, brand-token leak on
    // multi-domain blogs, FAQ on a policy-blocked service, keyword stuffing).
    // The autonomous engine runs these before publishing; the legacy BlogWriter
    // → publish-astro path (admin + the blog-calendar cron) previously had only
    // schema validation, so a generated post could ship "$39/month" or a
    // spoke-domain brand leak with nothing but the prompt stopping it. Block
    // P0/P1 here too — body + editable meta are checked.
    const guardrailDomains = (Array.isArray(data.domains) && data.domains.length > 0)
      ? data.domains
      : SPOKE_SITE_KEYS;
    const guardrails = contentGuardrails.evaluate(
      { body, frontmatter: data },
      {
        domains: guardrailDomains,
        // Legacy BlogWriter rows carry the topic on `tag` (e.g. "Rodents",
        // "Bed Bugs"), while `category` may be the broad Astro value
        // ("pest-control"). Pass BOTH so the FAQ-blocked-service guard sees the
        // real topic regardless of which field holds it.
        service: [post.category, post.tag],
        primaryKeyword: post.keyword || data.primary_keyword || null,
        // publishAstro publishes BLOG posts — declare it so the blog meta
        // contract (no phone, nothing salesy, soft CTA at the end) applies on
        // this path too; the autonomous lanes get it from the supporting-blog
        // quality bundle, but this legacy BlogWriter/admin/calendar path runs
        // guardrails only.
        targetIsBlog: true,
      },
    );
    if (!guardrails.pass) {
      // Async LLM refinement (footprint-claim-classifier) may dismiss a
      // false-positive OFF_FOOTPRINT_CITY_CLAIM; every other finding — and
      // any classifier failure — keeps the deterministic verdict.
      const refined = await refineFootprintFindings(guardrails.findings);
      const blocking = refined.filter((f) => f.severity === 'P0' || f.severity === 'P1');
      if (blocking.length) {
        const gErr = new Error(`content guardrails failed: ${blocking.map((f) => `${f.severity} ${f.code}`).join('; ')}`);
        gErr.code = 'BLOG_GUARDRAILS_FAILED';
        gErr.details = blocking;
        throw gErr;
      }
    }

    // 2b-2. Comparison-table / named-competitor legal scan. The autonomous
    // lane runs this before every publish, but the manual/calendar path
    // skipped it entirely — a calendar-scheduled AI draft disparaging or
    // ranking against a competitor could go fully live unattended (the
    // scheduler-lane auto-merge needs no human once the build is green and
    // Codex is clean). Same P0/P1 block as the guardrails above. A draft
    // that PASSES but names curated competitors in a validated
    // <ComparisonTable> (requiresHumanReview) is allowed to open its PR:
    // the human sign-off happens at MERGE time — the admin lane's
    // merge-astro click provides it, and the scheduler lane's unattended
    // pages-poll auto-merge reads the astro_requires_human_merge stamp
    // (persisted with the PR state below, from this exact evaluation) and
    // withholds the merge for an admin instead.
    let namedCompetitorEnabled = false;
    try { namedCompetitorEnabled = require('../../config/feature-gates').isEnabled('namedCompetitorComparison') === true; } catch (_) { namedCompetitorEnabled = false; }
    const comparison = comparisonTableGate.evaluate({ body, frontmatter: data }, { namedCompetitorEnabled });
    if (!comparison.pass) {
      // UNCLASSIFIED_OPTION is fail-closed classification AMBIGUITY (a
      // business-SHAPED phrase like "Comparing Pest Control" in a title, or
      // a category column the classifier can't prove is generic) — designed
      // for the unattended autonomous lane, where a reviewer resolves it.
      // Hard-blocking it here strands legitimate category-only comparisons
      // at publish_failed, so on this lane it is ADVISORY (logged; Codex
      // still reviews the PR). Every DEFINITE finding — disparagement,
      // unknown real competitor, rigged ranking, unsourced competitor facts,
      // competitor-in-prose, named-competitor-disabled — still blocks.
      const blocking = comparison.findings.filter((f) =>
        (f.severity === 'P0' || f.severity === 'P1') && f.code !== 'COMPARISON_UNCLASSIFIED_OPTION');
      if (blocking.length > 0) {
        const cErr = new Error(`comparison/named-competitor gate failed: ${blocking.map((f) => `${f.severity} ${f.code}`).join('; ')}`);
        cErr.code = 'BLOG_COMPARISON_GATE_FAILED';
        cErr.details = blocking;
        throw cErr;
      }
      const advisory = comparison.findings.filter((f) => f.code === 'COMPARISON_UNCLASSIFIED_OPTION');
      if (advisory.length > 0) {
        logger.warn(`[astro-publisher] comparison gate advisory for ${slug}: ${advisory.map((f) => f.message).join(' | ')}`);
      }
    }

    // 2c. LLM fact-check — the rule-based guardrails can't catch a wrong
    // species/pathogen name, a mislabeled active ingredient, or a bad Florida
    // ordinance date. This gate does, before the post ships under the licensed
    // reviewer byline. Fail-open; blocks only on P0/P1 findings.
    await assertFactCheckClear(
      { title: post.title, body, city: post.city, keyword: post.keyword, tag: post.tag },
      slug,
    );

    // 2c-2. LLM SEMANTIC compliance check — the second layer for the two hard
    // codes. Gate 2b's regexes catch every phrasing they encode; this reads for
    // meaning and catches the ones no pattern can express (see compliance-gate
    // header). Runs AFTER the deterministic gate so the cheap check rejects the
    // obvious cases first and the model only sees copy that already passed.
    await assertComplianceClear(
      {
        title: post.title,
        body,
        meta: [data.metaTitle, data.meta_description, data.hero_image_alt, data.hero_image?.alt],
        city: post.city,
        keyword: post.keyword,
        tag: post.tag,
      },
      slug,
    );

    const markdown = fm.stringify(data, body + '\n');
    const filePath = `${ASTRO_BLOG_DIR}/${slug}.md`;

    await gh.createBranch(branch);
    branchCreated = true;

    // 3. Hero + markdown in ONE commit (git data API). Splitting them into
    // per-file Contents API commits let Cloudflare register the branch
    // deployment against the hero commit instead of the head, which starves
    // the PR poller's head==deployment gate (PR #374, 2026-07-15). The tree
    // write replaces existing paths unconditionally, so a republish needs no
    // per-file SHA.
    const fileCommit = await gh.commitFiles({
      branch,
      message: `feat(blog): publish ${slug}`,
      files: [
        ...(heroImage?.buffer
          ? [{ path: `${ASTRO_HERO_DIR}/${slug}/hero.${heroImageExt}`, buffer: heroImage.buffer }]
          : []),
        { path: filePath, content: markdown },
      ],
    });

    // 4. PR
    const prBody = buildPrBody({ post, slug, branch, content: body });
    prCreateAttempted = true;
    const pr = await gh.createPr({
      head: branch,
      title: `Blog: ${post.title}`.slice(0, 72),
      body: prBody,
    });
    openedPr = pr;
    await requestCodexReview({
      pr,
      headSha: pr.head?.sha || fileCommit?.commit?.sha,
      context: `Blog publish for \`${slug}\``,
    });

    const previewUrl = cloudflarePreviewUrl(branch);
    await db('blog_posts').where({ id: postId }).update({
      astro_status: 'pr_open',
      astro_branch_name: branch,
      astro_pr_number: pr.number,
      astro_commit_sha: fileCommit?.commit?.sha || null,
      astro_preview_url: previewUrl,
      astro_publish_error: null,
      astro_published_at: null,
      // Stamped from the comparison gate's evaluation of THIS publish (not
      // re-derived later from row fields, which could drift from what was
      // actually scanned): pages-poll withholds the scheduler-lane
      // auto-merge when true, so competitor-naming posts always get a
      // human merge. Explicit false otherwise — a republish of a post
      // whose competitor mentions were edited out clears an old stamp.
      // (GATE_NAMED_COMPETITOR_AUTOPUBLISH deliberately does NOT reach this
      // lane: publishAstro serves manual/calendar posts with no
      // operator-intercept provenance, so the human merge stays.)
      astro_requires_human_merge: comparison.requiresHumanReview === true,
      updated_at: new Date(),
    });

    logger.info(`[astro-publisher] opened PR #${pr.number} for ${slug} on ${branch}`);
    return {
      pr_number: pr.number,
      pr_url: pr.html_url,
      branch,
      preview_url: previewUrl,
    };
  } catch (err) {
    logger.error(`[astro-publisher] publish failed for ${slug}: ${err.message}`);
    // Branch disposition, in order of certainty:
    //   - a KNOWN PR (openedPr) keeps its branch — the PR references it.
    //   - createPr was ATTEMPTED but threw: GitHub may still have opened
    //     the PR, so look the head branch up before deleting — deleting a
    //     live PR's head leaves an open, broken PR with no DB marker. A
    //     found PR is recovered as this attempt's PR and persisted below.
    //   - lookup or deletion failed: the branch SURVIVES and is recorded
    //     as external progress (astro_branch_name below) so the scheduler
    //     parks for review instead of retrying into a duplicate; the
    //     stale-PR cleanup reclaims it on the next republish.
    //   - otherwise the pre-PR branch is deleted: retries publish on a
    //     fresh shortId branch, so an undeleted one is an orphan per tick.
    let survivingBranch = null;
    if (branchCreated && !openedPr) {
      let safeToDelete = true;
      if (prCreateAttempted) {
        try {
          openedPr = await gh.findOpenPrByHead(branch) || null;
          safeToDelete = !openedPr;
          if (openedPr) logger.warn(`[astro-publisher] recovered PR #${openedPr.number} for ${branch} after a createPr error — persisting the marker instead of deleting the branch`);
        } catch (lookupErr) {
          safeToDelete = false;
          logger.warn(`[astro-publisher] post-failure PR lookup failed for ${branch}: ${lookupErr.message}; leaving the branch in place`);
        }
      }
      if (safeToDelete) {
        try {
          await gh.deleteRef(branch);
        } catch (cleanupErr) {
          survivingBranch = branch;
          logger.warn(`[astro-publisher] pre-PR branch cleanup failed for ${branch}: ${cleanupErr.message} (branch marker persisted; the stale-PR cleanup reclaims it on republish)`);
        }
      } else if (!openedPr) {
        survivingBranch = branch;
      }
    }
    await db('blog_posts').where({ id: postId }).update({
      astro_status: 'publish_failed',
      astro_publish_error: err.message.slice(0, 1000),
      // Markers record THIS attempt's true external state. A known or
      // recovered PR persists number+branch (the scheduler treats the row
      // as PR-backed; the stale-PR path cleans it up on republish). A
      // surviving branch persists alone — same parking, same reclaim. A
      // provably-clean failure NULLs both: a retried publish_failed row
      // must not keep the PREVIOUS attempt's marker after
      // cleanupStaleAstroPr closed that PR, or the fixed post stays
      // parked as PR-backed forever.
      ...(openedPr
        ? { astro_pr_number: openedPr.number, astro_branch_name: branch }
        : { astro_pr_number: null, astro_branch_name: survivingBranch }),
      updated_at: new Date(),
    });
    throw err;
  }
}

// Resolve an existing content file to its real path, tolerating the .md→.mdx
// migration. New autonomous blog posts are written as .mdx so they can render
// MDX infographic components (SeasonalPressureChart, HomeZoneMap, …); legacy
// and hand-authored posts may still be .md. Given a path or base (with or
// without extension), try .mdx first, then .md. Returns { path, file } (file =
// github-client getFile result: { sha, path, content, raw }) or null.
async function resolveExistingAstroFile(pathOrBase, { ref = null } = {}) {
  if (!pathOrBase) return null;
  const base = String(pathOrBase).replace(/\.mdx?$/, '');
  // Only blog posts migrate to .mdx (so they can use MDX components); service
  // and location pages stay .md, so don't waste a lookup or change their path.
  const exts = isBlogTarget(`${base}.md`) ? ['.mdx', '.md'] : ['.md'];
  for (const ext of exts) {
    const file = ref ? await gh.getFile(`${base}${ext}`, ref) : await gh.getFile(`${base}${ext}`);
    if (file) return { path: `${base}${ext}`, file };
  }
  return null;
}

// Normalize a slug / canonical / URL to its bare route path (no origin, query,
// hash, surrounding slashes, lowercased) for route-equality comparison.
function blogRouteKey(value) {
  return String(value || '')
    .replace(/^https?:\/\/[^/]+/i, '')
    .split(/[?#]/)[0]
    .replace(/^\/+|\/+$/g, '')
    .toLowerCase();
}

// Return the first existing blog file (across candidate base paths) that already
// renders `routeSlug` — i.e. whose own frontmatter slug normalizes to the same
// route. A candidate whose slug points at a DIFFERENT route (a post that merely
// shares the topic leaf — e.g. a different category) is skipped so we never
// clobber it; a candidate with no readable slug is adopted (it occupies the path
// we resolved it from). Lets publishOrUpdatePage update/migrate an existing post
// in place whether it lives at the flat or the category path.
async function firstExistingRouteFile(basePaths, routeSlug, { ref = null } = {}) {
  const want = blogRouteKey(routeSlug);
  const seen = new Set();
  for (const base of basePaths) {
    if (!base || seen.has(base)) continue;
    seen.add(base);
    const found = await resolveExistingAstroFile(base, { ref });
    if (!found) continue;
    let existingSlug = '';
    try {
      existingSlug = fm.parse(found.file && found.file.content)?.data?.slug || '';
    } catch {
      existingSlug = '';
    }
    if (!existingSlug || blogRouteKey(existingSlug) === want) return found;
  }
  return null;
}

async function resolveExistingAstroFileForTarget(targetUrlOrPath, opts = {}) {
  // `opts.ref`: resolve against a branch (the PR head) instead of main.
  const { ref = null } = opts;
  const target = /^src\/content\//.test(String(targetUrlOrPath || '')) ? targetUrlOrPath : urlToAstroPath(targetUrlOrPath);
  if (target) {
    const resolved = await resolveExistingAstroFile(target, { ref });
    if (resolved) return resolved;
  }

  const registryPath = await registryAstroPathForTarget(targetUrlOrPath, opts);
  if (registryPath && registryPath !== target) {
    const resolved = await resolveExistingAstroFile(registryPath, { ref });
    if (resolved) return resolved;
  }

  return null;
}

async function registryAstroPathForTarget(targetUrlOrPath, { rethrowLookupErrors = false } = {}) {
  if (!targetUrlOrPath || /^src\/content\//.test(String(targetUrlOrPath))) return null;
  const lookup = registryLookupValuesForUrl(targetUrlOrPath);
  if (!lookup.exact.length) return null;

  const exact = await registryAstroPathForLiveUrl(lookup.exact, { rethrowLookupErrors });
  if (exact) return exact;
  if (lookup.host && lookup.pathOnly) {
    const hostedPath = await registryAstroPathForLiveUrl([lookup.pathOnly], { requiredHost: lookup.host, rethrowLookupErrors });
    if (hostedPath) return hostedPath;
  }
  return registryAstroPathForCanonicalUrl(lookup.exact, { requiredHost: lookup.host, rethrowLookupErrors });
}

async function registryAstroPathForLiveUrl(liveUrlValues, { requiredHost = null, rethrowLookupErrors = false } = {}) {
  try {
    const query = db('content_registry');
    if (!query || typeof query.select !== 'function') return null;
    let q = query
      .select('astro_source_path')
      .whereNotNull('astro_source_path')
      .whereNot('reconciliation_status', 'conflict')
      .andWhere(function registryUrlMatch() {
        const [first, ...rest] = liveUrlValues;
        this.where('live_url', first);
        for (const value of rest) {
          this.orWhere('live_url', value);
        }
      });
    if (requiredHost) q = q.whereRaw('metadata::text ILIKE ?', [`%${requiredHost}%`]);
    const row = await q
      .orderByRaw("CASE WHEN astro_status = 'present' THEN 0 ELSE 1 END")
      .orderBy('astro_source_path', 'asc')
      .first();
    const sourcePath = row?.astro_source_path;
    return isSafeAstroContentPath(sourcePath) ? sourcePath : null;
  } catch (err) {
    if (rethrowLookupErrors) {
      err.code = err.code || 'REGISTRY_LOOKUP_FAILED';
      throw err;
    }
    logger.warn(`[astro-publisher] content registry path lookup failed for ${liveUrlValues[0]}: ${err.message}`);
    return null;
  }
}

async function registryAstroPathForCanonicalUrl(urlValues, { requiredHost = null, rethrowLookupErrors = false } = {}) {
  try {
    const query = db('content_registry');
    if (!query || typeof query.select !== 'function') return null;
    let q = query
      .select('astro_source_path')
      .whereNotNull('astro_source_path')
      .whereNot('reconciliation_status', 'conflict')
      .andWhere(function registryCanonicalMatch() {
        const [first, ...rest] = urlValues;
        this.where('canonical_url_normalized', first)
          .orWhere('canonical_target_url', first);
        for (const value of rest) {
          this.orWhere('canonical_url_normalized', value)
            .orWhere('canonical_target_url', value);
        }
      });
    if (requiredHost) q = q.whereRaw('metadata::text ILIKE ?', [`%${requiredHost}%`]);
    const rows = await q
      .orderByRaw("CASE WHEN astro_status = 'present' THEN 0 ELSE 1 END")
      .orderBy('astro_source_path', 'asc')
      .limit(2);
    if (!Array.isArray(rows) || rows.length !== 1) return null;
    const sourcePath = rows[0]?.astro_source_path;
    return isSafeAstroContentPath(sourcePath) ? sourcePath : null;
  } catch (err) {
    if (rethrowLookupErrors) {
      err.code = err.code || 'REGISTRY_LOOKUP_FAILED';
      throw err;
    }
    logger.warn(`[astro-publisher] content registry canonical lookup failed for ${urlValues[0]}: ${err.message}`);
    return null;
  }
}

// ── Autonomous hero pipeline ───────────────────────────────────────

// Stamp the publisher-owned hero reference into autonomous frontmatter,
// overriding whatever the writer agent emitted (including caption/credit —
// agent-invented attribution for a generated image would be wrong).
// A generation/vision-derived alt is produced AFTER the draft's guardrails
// scan, so run it through the same policy before it lands in frontmatter —
// prices, product names, brand tokens, footprint claims, citation residue.
// `domains` carries the draft's resolved target domains so the brand-token
// leak guard applies with the same spoke context as the draft scan. Fail
// closed to the fallback (the already-scanned draft alt): a policy hit or
// an evaluation error must never publish an unvetted string.
function vetGeneratedAlt(generatedAlt, fallbackAlt, domains = null) {
  if (!generatedAlt) return fallbackAlt || null;
  try {
    const check = contentGuardrails.evaluate({ body: '', frontmatter: { hero_image_alt: String(generatedAlt) } }, { domains });
    if (!check.pass) {
      logger.warn(`[astro-publisher] generated hero alt failed guardrails (${check.findings.map((f) => f.code).join(', ')}) — keeping the draft alt`);
      return fallbackAlt || null;
    }
  } catch (err) {
    logger.warn(`[astro-publisher] generated-alt guardrail check errored (${err.message}) — keeping the draft alt`);
    return fallbackAlt || null;
  }
  return String(generatedAlt);
}

function stampAutonomousHero(frontmatter, src, alt) {
  frontmatter.hero_image = { src, alt };
  frontmatter.og_image = src;
  return frontmatter;
}

// Alt text for the stamped hero: the agent's alt when it provided a usable
// one (it describes the post's subject, which the generated hero also
// depicts — both derive from the same title/keyword), else the title.
function heroAltForDraft(frontmatter) {
  const alt = typeof frontmatter?.hero_image?.alt === 'string' ? frontmatter.hero_image.alt.trim() : '';
  return alt || String(frontmatter?.title || '').trim() || 'Blog post hero image';
}

// A /images/blog/... hero src is only trustworthy if the file actually exists
// in the Astro repo (under public/). Returns the src when verified, else null.
async function verifiedCommittedHeroSrc(src) {
  if (typeof src !== 'string' || !src.startsWith(`${ASTRO_HERO_PUBLIC_BASE}/`)) return null;
  if (src.includes('..') || !/\.(webp|jpe?g|png|avif)$/i.test(src)) return null;
  const file = await gh.getFile(`public${src}`);
  return file ? src : null;
}

// A committed category-default hero asset, or null. Probed only on the hero
// generation FAILURE path: the schema requires a hero, so the only safe
// fallback is an asset proven to already exist in the Astro repo. Probe the
// category default first, then the site-wide default, under the standard
// hero directory conventions.
async function defaultHeroForCategory(category) {
  const cat = String(category || '').trim().toLowerCase();
  const candidates = [
    ...(cat && /^[a-z0-9-]+$/.test(cat) ? [`defaults/${cat}/hero.webp`] : []),
    'defaults/hero.webp',
  ];
  for (const rel of candidates) {
    if (await gh.getFile(`${ASTRO_HERO_DIR}/${rel}`)) return `${ASTRO_HERO_PUBLIC_BASE}/${rel}`;
  }
  return null;
}

// Full root cause for a hero-pipeline failure. err.message alone loses the
// error CLASS (a RangeError "Maximum call stack size exceeded" reads like
// provider text), the provider-chain attempts (image-generator attaches
// them), and where it threw — all of which the parked run's failure_message
// needs for a diagnosis that doesn't require a redeploy with extra logging.
function describeHeroFailure(err) {
  const parts = [
    err?.name && err.name !== 'Error' ? `${err.name}: ${err?.message || ''}`.trim() : String(err?.message || err || 'unknown error'),
  ];
  if (Array.isArray(err?.attempts) && err.attempts.length) {
    parts.push(`providers: ${err.attempts.map((a) => `${a.provider}=${a.result?.dataUrl ? 'ok' : (a.result?.status || a.result?.error || a.result?.reason || 'failed')}`).join(', ')}`);
  }
  const frame = String(err?.stack || '').split('\n').find((line) => /^\s+at /.test(line));
  if (frame) parts.push(`at ${frame.trim().replace(/^at\s+/, '')}`);
  return parts.join(' | ');
}

// Resolve the hero for an autonomous blog publish. Reuse-first:
//   1. the live post's own frontmatter hero (mirrors mergedHeroRef), verified
//      to exist in the repo — refresh/update runs must not regenerate;
//   2. a canonical /images/blog/<slug>/hero.* asset probed on main (covers a
//      live post whose frontmatter predates the hero pipeline);
//   3. an agent-emitted src that actually exists in the repo;
//   4. otherwise generate an AI hero + compress to WebP for the caller to
//      commit into the PR branch.
// Returns { src, buffer: null } for reuse (nothing to commit) or
// { src, repoPath, buffer } when bytes must be committed. Generation or
// compression failure throws BLOG_HERO_IMAGE_FAILED — a DETERMINISTIC publish
// error (see isDeterministicPublishError in autonomous-runner) so the runner
// parks the run for review instead of retry-looping, and never publishes
// hero-less.
async function resolveAutonomousHero({ frontmatter, slug, existingFile }) {
  if (existingFile) {
    try {
      const liveSrc = fm.parse(existingFile.file.content)?.data?.hero_image?.src;
      const verified = await verifiedCommittedHeroSrc(liveSrc);
      if (verified) return { src: verified, buffer: null };
    } catch (err) {
      logger.warn(`[astro-publisher] could not read live hero ref for ${slug}: ${err.message}`);
    }
    for (const ext of ['webp', 'png', 'jpg']) {
      if (await gh.getFile(`${ASTRO_HERO_DIR}/${slug}/hero.${ext}`)) {
        return { src: `${ASTRO_HERO_PUBLIC_BASE}/${slug}/hero.${ext}`, buffer: null };
      }
    }
  }

  const agentVerified = await verifiedCommittedHeroSrc(frontmatter?.hero_image?.src);
  if (agentVerified) return { src: agentVerified, buffer: null };

  let generated;
  try {
    const img = await generateHeroBuffer({
      title: frontmatter.title,
      meta_description: frontmatter.meta_description,
      keyword: frontmatter.primary_keyword,
      slug,
    });
    let buffer;
    try {
      buffer = await compressToWebp(img.buffer);
    } catch (err) {
      // Same post-provider contract as generateHeroBuffer: compression
      // failures keep the successful provider chain for the diagnosis.
      if (!err.attempts && Array.isArray(img.attempts)) err.attempts = img.attempts;
      throw err;
    }
    generated = {
      src: `${ASTRO_HERO_PUBLIC_BASE}/${slug}/hero.webp`,
      repoPath: `${ASTRO_HERO_DIR}/${slug}/hero.webp`,
      buffer,
      // Generation-derived alt: describes the image that was ACTUALLY
      // produced. The caller stamps it over the agent's pre-generation alt.
      alt: img.alt || null,
    };
  } catch (err) {
    // The blog schema REQUIRES hero_image + og_image (packages/blog-schema/
    // schema.json), so a hero-less publish is never an option. Before
    // parking, probe the repo for a CATEGORY-DEFAULT hero asset under the
    // existing hero conventions and reuse it (deterministic, already
    // committed, so nothing new can fail). Committing
    // public/images/blog/defaults/<category>/hero.webp (or the site-wide
    // defaults/hero.webp) in the Astro repo arms this fallback; while no
    // such asset exists the run still parks — fail-closed, with the FULL
    // root cause on the failure message.
    const fallback = await defaultHeroForCategory(frontmatter.category).catch(() => null);
    if (fallback) {
      logger.warn(`[astro-publisher] hero generation failed for ${slug} (${describeHeroFailure(err)}) — publishing with committed default hero ${fallback}`);
      // Reuse shape (buffer:null): the asset is already committed on main.
      // Supply a GENERIC alt describing the fallback asset — without one the
      // caller stamps the agent's subject-specific draft alt over an image
      // that was never generated (Codex r1: a category/site-wide default can
      // depict something entirely different).
      const catLabel = String(frontmatter.category || '').trim().replace(/-/g, ' ');
      // The category-specific alt is only truthful for the CATEGORY asset:
      // the site-wide defaults/hero.webp is not guaranteed to depict the
      // category, so it keeps the neutral text (Codex r16).
      const isCategoryAsset = Boolean(catLabel) && !fallback.endsWith('/defaults/hero.webp');
      return {
        src: fallback,
        buffer: null,
        alt: isCategoryAsset ? `Illustrative ${catLabel} article header image` : 'Illustrative article header image',
      };
    }
    const heroErr = new Error(`autonomous blog hero image generation failed for ${slug}: ${describeHeroFailure(err)}`);
    heroErr.code = 'BLOG_HERO_IMAGE_FAILED';
    heroErr.cause = err;
    throw heroErr;
  }

  // Describe the image we just generated so the stamped alt matches what the
  // generator actually rendered — the writer authored its alt before any
  // image existed, and an image/alt mismatch is a recurring Codex P2 that
  // parks the PR (remediation is body-only and cannot touch frontmatter).
  // Outside the fail-closed block above: fail-open. When vision is
  // unavailable (no key / SDK / unusable output) fall back to the
  // generation-prompt-derived alt already on `generated` — still closer to
  // the real image than the writer's pre-image alt, which is the last
  // resort in the caller.
  generated.alt = (await describeHeroForAlt({
    buffer: generated.buffer,
    title: frontmatter.title,
    keyword: frontmatter.primary_keyword,
  })) || generated.alt || null;
  return generated;
}

// ── Body images (publish-time) ──────────────────────────────────────
//
// Owner rule 2026-08-27: every autopublished post ships ≥3 images — the hero
// plus at least BODY_IMAGE_MIN in-article illustrations. The writer emits
// prose only; the publisher adds the illustrations deterministically so the
// rule never depends on prompt compliance:
//   - each image is generated from one H2 section (heading = subject, first
//     prose paragraph = context) and inserted at the END of that section's
//     prose — the shape the reference post (quarterly-pest-control.mdx) uses;
//   - files commit beside the hero as /images/blog/<slug>/body-N.webp in the
//     same atomic commit; an update run reuses a body-N.webp already on main
//     (with the alt the live body carries) instead of regenerating;
//   - failure is fail-closed (BLOG_BODY_IMAGES_FAILED, deterministic → parks
//     the run for review), mirroring the hero.
// Dark-shipped behind GATE_BLOG_BODY_IMAGES (feature-gates.blogBodyImages).
const BODY_IMAGE_MIN = 2;
const BODY_IMAGE_WIDTH = 1200;
// Framing rotates per slot (the hero is the wide shot) so the three pictures
// differ in kind, not just subject.
const BODY_IMAGE_SHOTS = ['close-up', 'action', 'environment'];
// dHash distance (of 64 bits) at or below which two images are the same
// picture for a reader — regenerate once with the next framing, then park.
const NEAR_DUPLICATE_MAX_DISTANCE = 12;

// 64-bit difference hash: grayscale 9×8, each bit = left pixel darker than
// its right neighbour. Robust to resize/recompress, blind to palette.
// Alpha is flattened onto white first and pixels are indexed by the channel
// count Sharp actually returned — an RGBA source must hash like its opaque
// twin, never as interleaved luma/alpha bytes. A buffer Sharp cannot decode
// (corrupt file, pixel limit) is a DETERMINISTIC body-image failure: the
// same bytes fail the same way every run, so the run parks instead of
// retry-looping.
async function imageDHash(buffer) {
  const sharp = require('sharp');
  let data;
  let info;
  try {
    ({ data, info } = await sharp(buffer)
      // Display orientation first: an orientation-tagged JPEG and its
      // auto-oriented WebP twin are the same picture to a reader.
      .rotate()
      .flatten({ background: '#ffffff' })
      .grayscale()
      .resize(9, 8, { fit: 'fill' })
      .raw()
      .toBuffer({ resolveWithObject: true }));
  } catch (err) {
    const e = new Error(`body image could not be decoded for the distinctness check: ${err.message}`);
    e.code = 'BLOG_BODY_IMAGES_FAILED';
    e.cause = err;
    throw e;
  }
  const ch = Math.max(1, Number(info?.channels) || 1);
  const at = (x, y) => data[(y * 9 + x) * ch];
  const bits = new Array(64);
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) bits[y * 8 + x] = at(x, y) < at(x + 1, y) ? 1 : 0;
  return bits;
}
function hammingDistance(a, b) {
  let d = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) d += 1;
  return d;
}
// Bytes of an image already committed in the Astro repo (contents API
// returns base64 for files < 1 MB — every hero/body WebP is far under). Null
// when unavailable; callers then treat the image as unverifiable for the
// near-duplicate check and regenerate rather than reuse blind.
// Only a MISSING or unreadable asset is null (the contents API answers 404
// with null): an operational failure (GitHub 5xx, network) is thrown, not
// swallowed — callers turn null into a deterministic park, and a transient
// outage must instead propagate so the runner retries the publish.
async function committedImageBuffer(repoPath, getFile = (path) => gh.getFile(path)) {
  const file = await getFile(repoPath);
  if (!file) return null;
  let b64 = file?.raw?.content;
  // The contents API omits inline bytes for files over 1 MB (metadata with
  // an empty `content`): the blob is fetched by SHA instead — a large legacy
  // hero is a real, verifiable picture, not a missing one.
  if (!b64 && file?.raw?.sha && typeof gh.getBlob === 'function') {
    const blob = await gh.getBlob(file.raw.sha);
    b64 = blob?.content;
  }
  if (!b64) return null;
  const buffer = Buffer.from(String(b64).replace(/\s/g, ''), 'base64');
  return buffer.length ? buffer : null;
}

// Picture-level half of the body-image contract, shared with remediation:
// every referenced image (fetched via `getFile`, e.g. on the PR branch) must
// differ visually from the hero and from each other. Returns { ok, reason }.
async function assertDistinctPictures({ srcs, heroSrc = '', getFile }) {
  const seen = [];
  const hero = String(heroSrc || '');
  if (hero) {
    // Fail closed: without the hero's bytes a body image cannot be proven
    // different from it.
    const buf = hero.startsWith('/') ? await committedImageBuffer(`public${hero}`, getFile) : null;
    if (!buf) return { ok: false, reason: `hero bytes unavailable for ${hero} — cannot verify body images differ from the hero` };
    seen.push({ label: 'hero', hash: await imageDHash(buf) });
  }
  for (const src of srcs) {
    const buf = await committedImageBuffer(`public${src}`, getFile);
    if (!buf) return { ok: false, reason: `image bytes unavailable for ${src}` };
    const dup = await nearDuplicateOf(buf, seen);
    if (dup.label) return { ok: false, reason: `${src} is a near-duplicate of ${dup.label} — body images must be distinct pictures` };
    seen.push({ label: src, hash: dup.hash });
  }
  return { ok: true, reason: null };
}

// Merge-time contract for the autonomous PR poller: with the gate ON, the
// post file at the PR HEAD must satisfy the whole body-image contract (refs
// valid, ≥ minimum distinct, distinct pictures) — a PR opened while the gate
// was OFF must not auto-merge hero-only the moment the gate flips.
// Returns { ok, reason }; anything unreadable fails closed.
async function assertBodyImagesAtHead({ frontmatter, brief = {}, branch, actionType = 'new_supporting_blog', targetUrl = null, filePath = null }) {
  if (!bodyImagesEnabled()) return { ok: true, reason: 'gate_off' };
  if (!branch) return { ok: false, reason: 'PR head branch unknown' };
  const getFile = (path) => gh.getFile(path, branch);
  let found = null;
  let label = '';
  let legacyHeroSrcs = [];
  if (actionType === 'refresh_existing_page') {
    // EXACTLY publishRefresh's target resolution (explicit file_path, else
    // URL → path, else the content_registry source path — a blog canonical
    // outside /blog/ lives there), on the PR head. Only a RESOLVED non-blog
    // file is exempt; an unresolved target fails closed.
    found = filePath
      ? await resolveExistingAstroFile(filePath, { ref: branch })
      : await resolveExistingAstroFileForTarget(targetUrl, { ref: branch });
    label = filePath || targetUrl || 'refresh target';
    if (!found) return { ok: false, reason: `refresh target ${label} not found on ${branch}` };
    if (!isBlogTarget(found.path)) return { ok: true, reason: 'non_blog_target' };
    // Grandfather: ONLY the exact hero reference(s) the post on MAIN already
    // embeds in its body — a hero ref the refresh introduces or changes is
    // validated normally.
    const live = await resolveExistingAstroFile(found.path);
    if (live?.file?.content) {
      try { const lp = fm.parse(live.file.content); legacyHeroSrcs = legacyHeroRefs(lp?.content || '', lp?.data?.hero_image?.src); } catch (_) { legacyHeroSrcs = []; }
    }
  } else {
    // EXACTLY the file publishOrUpdatePage wrote: the route-matched existing
    // file (category or flat path, .mdx or legacy .md), else the new
    // category-route .mdx.
    let slug;
    try {
      slug = categoryRouteSlug(slugPathFromFrontmatter(frontmatter || {}), normalizeAutonomousCategory(frontmatter || {}, brief || {}));
    } catch (err) {
      return { ok: false, reason: `post slug unresolved: ${err.message}` };
    }
    found = await firstExistingRouteFile([`${ASTRO_BLOG_DIR}/${slug}`, `${ASTRO_BLOG_DIR}/${slugLeafOf(slug)}`], slug, { ref: branch });
    if (!found) {
      const path = `${ASTRO_BLOG_DIR}/${slug}.mdx`;
      const file = await getFile(path);
      if (file) found = { path, file };
    }
    label = slug;
  }
  if (!found?.file?.content) return { ok: false, reason: `post file for ${label} not found on ${branch}` };
  let parsed;
  try { parsed = fm.parse(found.file.content); } catch (err) { return { ok: false, reason: `post file unparseable: ${err.message}` }; }
  const body = String(parsed?.content || '');
  const heroSrc = String(parsed?.data?.hero_image?.src || '');
  try {
    const valid = await validateBodyImageRefs({ body, heroSrc, getFile, legacyHeroSrcs });
    if (!valid.ok) return { ok: false, reason: valid.reason };
    if (valid.distinct < BODY_IMAGE_MIN) return { ok: false, reason: `${valid.distinct} distinct in-article image(s) on ${branch}, minimum ${BODY_IMAGE_MIN}` };
    const pictures = await assertDistinctPictures({ srcs: [...new Set(valid.refs.map((r) => r.src))], heroSrc, getFile });
    if (!pictures.ok) return { ok: false, reason: pictures.reason };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
  return { ok: true, reason: null };
}

async function nearDuplicateOf(buffer, siblings) {
  const hash = await imageDHash(buffer);
  for (const sib of siblings) if (hammingDistance(hash, sib.hash) <= NEAR_DUPLICATE_MAX_DISTANCE) return { label: sib.label, hash };
  return { label: null, hash };
}
const MARKDOWN_IMAGE_RE = /!\[[^\]]*\]\([^)]*\)/g;
// Upper bound on body-N names scanned per post before parking (a directory
// full of files this run can neither reuse nor overwrite is a human problem).
const BODY_IMAGE_NAME_SCAN_MAX = 50;
const BODY_IMAGE_SKIP_HEADING_RE = /\b(?:faq|faqs|frequently asked|questions|sources|references|summary|bottom line|key takeaways|next steps)\b/i;

function bodyImagesEnabled() {
  try { return require('../../config/feature-gates').isEnabled('blogBodyImages') === true; } catch (_) { return false; }
}

// Rendered image references in the body — fenced code is skipped (an
// `![x](y)` inside a code block is text, not an image).
// Only an ODD backslash run escapes the "!" (Markdown escape parity).
// Destination = up to the first whitespace; ONE level of balanced parens is
// part of the path ("/body-(detail).webp"), as CommonMark allows.
// Inline OR reference-style image: `![alt](dest)`, `![alt][label]`,
// `![alt][]` (collapsed), `![alt]` (shortcut). A reference form renders a
// picture only when its label has a definition in the body — an undefined
// label is text, not an image.
// An angle-bracketed inline destination (`](</images/a b.webp>)`, valid
// CommonMark, may hold spaces) is rewritten to its equivalent bare form
// (`](/images/a%20b.webp)`) BEFORE tag masking — `</images/…>` otherwise
// reads as a closing HTML tag and is blanked. Same-line rewrite: line
// indices hold. Bare destinations are percent-DECODED when resolved so the
// committed-file check sees the real path.
const ANGLE_DESTINATION_RE = /\]\(<([^<>\n]*)>/g;
function normalizeAngleDestinations(text) {
  return String(text || '').replace(ANGLE_DESTINATION_RE, (m, dest) => `](${dest.trim().replace(/ /g, '%20')}`);
}
function decodeDestination(src) {
  try { return decodeURIComponent(src); } catch (_) { return src; }
}
// Every image the rendered body shows — inline (`![alt](dest "title")`),
// full/collapsed/shortcut reference (`![alt][label]`, `![alt][]`, `![alt]`)
// — found with the guardrails' balanced scanner run over the WHOLE
// newline-preserving text (a label may wrap across a soft line break), each
// tagged with the line its `![` sits on. An inline destination must satisfy
// the full destination-plus-optional-title grammar (parseLinkDestination) or
// the construct is literal text, not a picture; reference labels resolve
// through `defs` (markdownReferenceDefinitions); a malformed image is text.
function imageRefsInText(text, defs) {
  const out = [];
  const str = String(text || '');
  let line = 0;
  let cursor = 0;
  for (const span of contentGuardrails.eachMarkdownLink(str)) {
    if (!span.isImage) continue;
    for (; cursor < span.start; cursor += 1) if (str[cursor] === '\n') line += 1;
    const alt = str.slice(span.labelStart + 1, span.labelEnd).replace(/\s+/g, ' ').trim();
    if (span.kind === 'inline') {
      const dest = contentGuardrails.parseLinkDestination(str.slice(span.destStart, span.destEnd + 1));
      if (dest) out.push({ alt, src: decodeDestination(dest), line });
      continue;
    }
    if (span.kind === 'malformed') continue;
    const tail = span.kind === 'reference' ? str.slice(span.refStart, span.refEnd + 1) : '';
    const label = contentGuardrails.normalizeReferenceLabel(tail || alt);
    if (label && defs && defs.has(label)) out.push({ alt, src: defs.get(label), line });
  }
  return out;
}

// The body with every non-rendered region blanked (fenced/indented code,
// code spans, HTML/JSX comments, <pre>) — newline-preserving, so line indices
// still address the original text. Shared stripper, so "rendered" here means
// exactly what the table scanner and CTA extraction mean by it.
// Markdown image syntax inside a JSX/HTML tag (an attribute string) or an
// MDX expression is data, not a rendered image — mask tags (multi-line
// components included) and balanced {…} expressions after the shared
// stripper has removed code and comments.
// Tags are walked QUOTE-AWARE (content-guardrails.eachTag — a quoted
// attribute may contain ">") and MDX expressions are blanked balanced and
// quote-aware (blankExpressions); both keep newlines so line indices hold.
function blankJsxAndExpressions(text) {
  const str = String(text || '');
  const out = str.split('');
  for (const tag of contentGuardrails.eachTag(str)) {
    for (let k = tag.start; k <= tag.end; k += 1) if (out[k] !== '\n') out[k] = ' ';
  }
  return contentGuardrails.blankExpressions(out.join(''));
}

// Rendered view of the body plus each line's blockquote depth: shared
// stripper (code, spans, comments, <pre>; quote markers and list indent
// removed) → link destinations / reference definitions / titles blanked with
// images kept (a `![..]` nested in a link destination goes with it; one in a
// link label renders and stays) → tags + MDX expressions.
// `inList` (per line, from the shared scanner's list tracking) tells the
// section scanner which blocks are list content; `defs` are the body's link
// reference definitions, read BEFORE link blanking removes them, so a
// reference-style image (`![alt][label]`) resolves to its destination.
function renderedBodyView(body) {
  const { text, depths, inList } = contentGuardrails.blankNonRenderedMarkdownWithDepths(String(body || ''));
  // Children of a container a reader may never see (<script>, <template>,
  // <div hidden>, closed <details>, …) are blanked by the guardrails'
  // visibility walker — the same judgement the attribution rules use.
  const visible = normalizeAngleDestinations(contentGuardrails.blankHiddenContent(text));
  const defs = contentGuardrails.markdownReferenceDefinitions(visible);
  const rendered = blankJsxAndExpressions(
    contentGuardrails.blankMarkdownLinkDestinations(visible, { keepImages: true }),
  );
  return { text: rendered, lines: rendered.split('\n'), depths, inList: inList || [], defs };
}
function renderedBodyLines(body) {
  return renderedBodyView(body).lines;
}

function bodyImageRefs(body) {
  const { text, defs } = renderedBodyView(body);
  return imageRefsInText(text, defs);
}

function countBodyImages(body) {
  return bodyImageRefs(body).length;
}

function headingKey(text) {
  return String(text || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

// Plain-text lead of a paragraph for the generation prompt: links → label,
// decoration stripped, clamped.
function proseLead(text) {
  return String(text || '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/[*_`~]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 240);
}

// Lines that open something other than a prose paragraph: lists, quotes,
// tables, MDX/HTML blocks, images, definition-ish labels, fences.
const NON_PROSE_LINE_RE = /^\s*(?:[-*+]\s|\d+[.)]\s|>|\||<|!\[|`{3,}|~{3,}|:::|\{)/;

// Scan the body into H2 sections and return up to `wanted` insertion slots,
// spread across the article. A slot is the line index AFTER the last prose
// paragraph of an eligible section (no image yet, not a FAQ/summary-style
// section). Fenced code is never split. The intro (text before the first
// heading) is the fallback slot when too few sections qualify.
function scanBodySections(body, { title = '' } = {}) {
  const lines = String(body || '').split('\n');
  // ALL structure (headings, blank lines, paragraph openers, images) is read
  // off the rendered view — fenced/indented code, code spans, comments and
  // <pre> are blank there, so a "## heading" inside a comment or a fence is
  // never a section and a code sample is never prose. Only TOP-LEVEL blocks
  // are placement candidates: a heading or paragraph counts only at quote
  // depth 0 and outside list content (both read off the shared scanner's
  // per-line depth / list tracking — an H2 inside a blockquote or a list
  // item is neither a section nor a slot: an image inserted there would
  // land outside the quote or break the list). A top-level block with 1–3
  // leading spaces is still top-level (CommonMark). Raw lines feed the
  // lead text.
  const { text: renderedText, lines: rendered, depths, inList, defs } = renderedBodyView(body);
  const topLevel = (i) => (depths[i] || 0) === 0 && !inList[i];
  const refsByLine = new Map();
  for (const ref of imageRefsInText(renderedText, defs)) {
    if (!refsByLine.has(ref.line)) refsByLine.set(ref.line, []);
    refsByLine.get(ref.line).push(ref);
  }
  const sections = [];
  let cur = { heading: String(title || '').trim(), start: 0, intro: true, images: [] };
  let paraStart = -1;
  const closePara = (end) => {
    if (paraStart < 0) return;
    if (topLevel(paraStart) && !NON_PROSE_LINE_RE.test(rendered[paraStart])) {
      cur.lastProse = end; // insert BEFORE this index
      if (!cur.lead) cur.lead = proseLead(lines.slice(paraStart, end).join(' '));
    }
    paraStart = -1;
  };
  for (let i = 0; i < rendered.length; i++) {
    const line = rendered[i];
    const heading = topLevel(i) ? line.match(/^ {0,3}(#{1,6})\s+(.+?)\s*#*\s*$/) : null;
    if (heading) {
      closePara(i);
      // Only an H2 opens a new section: H3+ sub-headings stay INSIDE the
      // current H2 range, so their prose, images and lead roll up to it (an
      // H2 whose prose lives entirely under H3s is still eligible, and an
      // image under an H3 marks the H2 illustrated). An H1 closes the range.
      if (heading[1].length <= 2) {
        sections.push(cur);
        cur = heading[1].length === 2 ? { heading: heading[2].trim(), start: i, images: [] } : { heading: cur.heading, start: i, sub: true, images: [] };
      }
      continue;
    }
    for (const ref of refsByLine.get(i) || []) { cur.hasImage = true; cur.images.push(ref.src); }
    if (line.trim() === '') { closePara(i); continue; }
    // A dashes-only or equals-only underline DIRECTLY under a top-level
    // paragraph is a SETEXT heading (CommonMark): the paragraph is heading
    // text, not prose, and — like its ATX twin — `---` opens an H2 section
    // while `===` (H1) closes the current range. The underline must sit in
    // the same (top-level) container as the paragraph: `> ---` or `- ---`
    // under a paragraph is a nested break, not its underline.
    const setext = paraStart >= 0 && topLevel(paraStart) && topLevel(i) ? line.match(/^ {0,3}(-+|=+)[ \t]*$/) : null;
    if (setext) {
      const text = rendered.slice(paraStart, i).join(' ').replace(/\s+/g, ' ').trim();
      paraStart = -1;
      sections.push(cur);
      cur = setext[1][0] === '-' ? { heading: text, start: i, images: [] } : { heading: cur.heading, start: i, sub: true, images: [] };
      continue;
    }
    // A standalone thematic break (`---`, `***`, `- - -`) is a divider, never
    // prose: it closes the paragraph before it (the slot stays ABOVE the
    // divider, inside the section it illustrates) and opens none — a section
    // holding only a divider has no prose to generate from.
    if (contentGuardrails.isThematicBreak(line)) { closePara(i); continue; }
    if (paraStart < 0) paraStart = i;
  }
  closePara(rendered.length);
  sections.push(cur);
  return { lines, sections };
}

// The H2 heading a committed image sits under in the LIVE body (null when
// the body no longer references it).
function liveSectionForImage(content, src, { title = '' } = {}) {
  const { sections } = scanBodySections(content, { title });
  return sections.find((sec) => sec.images.includes(src)) || null;
}
// A section's CONTEXT for reuse decisions: heading + the opening prose the
// image was generated from (headings like "What to expect" carry no subject
// on their own).
function sectionContextKey(heading, lead) {
  return `${headingKey(heading)}|${headingKey(lead).slice(0, 120)}`;
}

function bodyImageSlots(body, wanted, { title = '' } = {}) {
  const { sections } = scanBodySections(body, { title });
  const eligible = sections.filter((sec) => !sec.intro && !sec.sub && !sec.hasImage
    && sec.lastProse != null && !BODY_IMAGE_SKIP_HEADING_RE.test(sec.heading));
  const picked = [];
  const n = eligible.length;
  // Centered spread: 2 images over 3 sections → 1st and 3rd; over 4 → 2nd and 4th.
  for (let k = 0; k < wanted && k < n; k++) picked.push(eligible[Math.round(((k + 0.5) * n) / wanted - 0.5)]);
  if (picked.length < wanted) {
    const intro = sections.find((sec) => sec.intro && sec.lastProse != null && !sec.hasImage);
    if (intro && !picked.includes(intro)) picked.unshift(intro);
  }
  return picked.slice(0, wanted).map((sec) => ({
    insertAt: sec.lastProse,
    heading: sec.heading,
    lead: sec.lead || '',
  }));
}

// Insert `![alt](src)` lines at the given slots (descending so indices stay
// valid), each on its own paragraph.
function insertBodyImages(body, placements) {
  const lines = String(body || '').split('\n');
  const ordered = [...placements].sort((a, b) => b.insertAt - a.insertAt);
  for (const { insertAt, src, alt } of ordered) {
    const label = String(alt || '').replace(/[\[\]]/g, '').replace(/\s+/g, ' ').trim();
    // Blank lines only where the neighbours don't already provide them —
    // never a global whitespace rewrite (fenced code keeps its blank lines).
    const before = insertAt > 0 && lines[insertAt - 1].trim() !== '' ? [''] : [];
    const after = insertAt < lines.length && lines[insertAt].trim() !== '' ? [''] : [];
    lines.splice(insertAt, 0, ...before, `![${label}](${src})`, ...after);
  }
  return lines.join('\n').trim();
}

// A committed body image is reusable for a NEW slot only when the live body
// still references it (its alt is the only truthful description of the
// picture) AND it sat under the same H2 heading — a rewritten or reordered
// article must not inherit an accurate-but-unrelated picture. Returns the
// live alt, or null (regenerate).
function reusableLiveBodyImage(existingFile, src, slotHeading, { title = '', lead = '' } = {}) {
  const content = existingFile?.file?.content;
  if (!content) return null;
  let liveBody;
  let liveTitle = '';
  try {
    const parsed = fm.parse(content);
    liveBody = parsed?.content ?? String(content);
    liveTitle = String(parsed?.data?.title || '').trim();
  } catch { liveBody = String(content); }
  const ref = bodyImageRefs(liveBody).find((r) => r.src === src);
  if (!ref?.alt) return null;
  // The intro pseudo-section is named by the TITLE; the live side must use
  // the live file's title, not the new draft's, or a retitled article
  // would always match its old intro illustration.
  const liveSection = liveSectionForImage(liveBody, src, { title: liveTitle || title });
  if (!liveSection) return null;
  // Same heading AND same opening prose — a rewritten section under a kept
  // heading gets a new picture.
  if (sectionContextKey(liveSection.heading, liveSection.lead) !== sectionContextKey(slotHeading, lead)) return null;
  return ref.alt;
}

// Shared validity contract for the body's image references (publisher at
// PR-open time; codex-remediation re-checks a rewritten body against the PR
// branch): every rendered `![..](src)` must (a) not be the hero — the layout
// renders it, a body that embeds it repeats the picture — and (b) resolve to
// a file committed at `getFile` (an invented path or remote URL would ship
// as a broken image). Returns { ok, reason, distinct } — distinct = number
// of distinct verified sources.
// `legacyHeroSrcs`: the exact hero reference(s) a LIVE legacy post already
// repeats in its body (the pre-2026 convention), grandfathered on refresh —
// those refs, by exact src, are excluded from the count and the checks
// instead of parking the refresh. Any OTHER hero ref (another post's hero,
// a changed or invented `/hero.*` path) is validated normally: the
// grandfather covers what already ships, never what the refresh introduces.
async function validateBodyImageRefs({ body, heroSrc = '', getFile, legacyHeroSrcs = [] }) {
  // A raw <img> is outside the writer's plain-Markdown subset: it renders a
  // picture the Markdown scan cannot see, so it can neither count toward the
  // minimum nor be verified — park (the syntax gate parks raw HTML upstream;
  // this keeps the publisher fail-closed on its own).
  const stripped = contentGuardrails.blankNonRenderedMarkdown(String(body || ''));
  for (const tag of contentGuardrails.eachTag(stripped)) {
    if (/^<img\b/i.test(stripped.slice(tag.start, tag.end + 1))) {
      return { ok: false, reason: `body contains a raw <img> tag (${stripped.slice(tag.start, Math.min(tag.end + 1, tag.start + 80))}) — body images must be plain Markdown images`, distinct: 0 };
    }
  }
  const hero = String(heroSrc || '');
  const isHeroRef = (src) => (hero && src === hero) || /\/hero\.(?:webp|jpe?g|png|avif)$/i.test(src);
  const grandfathered = new Set((Array.isArray(legacyHeroSrcs) ? legacyHeroSrcs : []).map((src) => String(src || '')).filter((src) => src && isHeroRef(src)));
  const refs = bodyImageRefs(body).filter((r) => !grandfathered.has(String(r.src || '')));
  for (const ref of refs) {
    const src = String(ref.src || '');
    if (isHeroRef(src)) {
      return { ok: false, reason: `body embeds the hero image (${src}) — the layout renders the hero; body images must be distinct illustrations`, distinct: 0 };
    }
    // A required illustration must be accessible: an authored image with no
    // alt text is not accepted toward the minimum (generated images always
    // carry a vetted alt) — fail closed rather than ship `![](…)`.
    if (!String(ref.alt || '').trim()) {
      return { ok: false, reason: `body image ${src || 'with empty src'} has no alt text — every in-article image needs a descriptive alt`, distinct: 0 };
    }
    const committed = src.startsWith('/') && !src.includes('..') && /\.(webp|jpe?g|png|avif|gif|svg)$/i.test(src)
      && await getFile(`public${src}`);
    if (!committed) {
      return { ok: false, reason: `body references an image that is not committed in the Astro repo (${src || 'empty src'})`, distinct: 0 };
    }
  }
  return { ok: true, reason: null, distinct: new Set(refs.map((r) => r.src)).size, refs };
}

// The exact hero reference(s) the LIVE body embeds (legacy convention) →
// refresh grandfathers those srcs and nothing else.
function legacyHeroRefs(body, heroSrc) {
  const hero = String(heroSrc || '');
  const out = new Set();
  for (const r of bodyImageRefs(body)) {
    const src = String(r.src || '');
    if ((hero && src === hero) || /\/hero\.(?:webp|jpe?g|png|avif)$/i.test(src)) out.add(src);
  }
  return [...out];
}

// `siblings` = already-resolved images with bytes (the freshly generated
// hero) that every body image must differ from.
async function resolveBodyImages({ frontmatter, slug, body, existingFile, brief = {}, siblings = [], legacyHeroSrcs = [] }) {
  const none = { body, files: [], images: [], newAlts: [] };
  if (!bodyImagesEnabled()) return none;
  const valid = await validateBodyImageRefs({ body, heroSrc: frontmatter?.hero_image?.src, getFile: (path) => gh.getFile(path), legacyHeroSrcs });
  if (!valid.ok) {
    const err = new Error(`autonomous blog body images: draft for ${slug} ${valid.reason}`);
    err.code = 'BLOG_BODY_IMAGES_FAILED';
    throw err;
  }
  // Distinct pictures, not references — two links to one file is one image.
  const draftSrcs = new Set(valid.refs.map((r) => r.src));

  // Every picture the body images must differ from — the hero (fresh bytes,
  // or a REUSED hero fetched from the repo) and the draft's own committed
  // images — enters the hash set BEFORE the minimum is judged: two draft
  // paths holding the same picture, or a draft image that repeats the hero,
  // are not distinct illustrations and park the run (the draft body is not
  // ours to rewrite).
  // Fail closed: a picture whose bytes cannot be read cannot be proven
  // distinct, so it parks rather than slipping past the check.
  const seen = [];
  for (const sib of siblings) {
    let buf = Buffer.isBuffer(sib?.buffer) && sib.buffer.length ? sib.buffer : null;
    if (!buf && sib?.repoPath) buf = await committedImageBuffer(sib.repoPath);
    if (!buf && (sib?.repoPath || sib?.buffer)) {
      const err = new Error(`autonomous blog body images: ${sib.label || 'hero'} bytes unavailable for ${slug} (${sib.repoPath || 'buffer'}) — cannot verify body images differ from it`);
      err.code = 'BLOG_BODY_IMAGES_FAILED';
      throw err;
    }
    if (buf) seen.push({ label: sib.label || 'hero', hash: await imageDHash(buf) });
  }
  for (const src of draftSrcs) {
    const buf = await committedImageBuffer(`public${src}`);
    if (!buf) {
      const err = new Error(`autonomous blog body images: draft for ${slug} references ${src} whose bytes cannot be read — cannot verify it is a distinct picture`);
      err.code = 'BLOG_BODY_IMAGES_FAILED';
      throw err;
    }
    const dup = await nearDuplicateOf(buf, seen);
    if (dup.label) {
      const err = new Error(`autonomous blog body images: draft for ${slug} references ${src}, a near-duplicate of ${dup.label} — body images must be distinct pictures`);
      err.code = 'BLOG_BODY_IMAGES_FAILED';
      throw err;
    }
    seen.push({ label: src, hash: dup.hash });
  }

  const have = valid.distinct;
  const need = BODY_IMAGE_MIN - have;
  if (need <= 0) return none;

  const slots = bodyImageSlots(body, need, { title: frontmatter?.title });
  if (slots.length < need) {
    const err = new Error(`autonomous blog body images: only ${slots.length} of ${need} insertion slot(s) found for ${slug} — the body needs at least ${need} prose section(s) without an image`);
    err.code = 'BLOG_BODY_IMAGES_FAILED';
    throw err;
  }

  const files = [];
  const images = [];
  const newAlts = [];
  const placements = [];
  const city = brief.city || (Array.isArray(frontmatter?.service_areas_tag) ? frontmatter.service_areas_tag[0] : '');
  const heroSubject = String(frontmatter?.primary_keyword || frontmatter?.title || '').trim();
  // body-N names: a name the draft already references is skipped (a draft
  // carrying body-2.webp must not have it overwritten by a new generation
  // that would then be linked twice); a name already COMMITTED in the repo
  // is either REUSED (the live body still describes that picture and it is
  // not a near-duplicate) or skipped — a committed path is never overwritten
  // by a generation, so the atomic commit only ever ADDS asset paths (its
  // lock can then require each one to still be absent on the fresh branch).
  let n = 0;
  for (let k = 0; k < slots.length; k++) {
    const slot = slots[k];
    let src;
    let repoPath;
    let reuse = null;
    for (;;) {
      n += 1;
      if (n > BODY_IMAGE_NAME_SCAN_MAX) {
        const err = new Error(`autonomous blog body images: no free body-N name under ${slug} within ${BODY_IMAGE_NAME_SCAN_MAX} — the post's image directory is full of files this run cannot reuse`);
        err.code = 'BLOG_BODY_IMAGES_FAILED';
        throw err;
      }
      src = `${ASTRO_HERO_PUBLIC_BASE}/${slug}/body-${n}.webp`;
      repoPath = `${ASTRO_HERO_DIR}/${slug}/body-${n}.webp`;
      if (draftSrcs.has(src)) continue;
      const onMain = await gh.getFile(repoPath);
      if (!onMain) break; // free name → generate here
      // Reuse a file already committed on main when the live body still
      // describes it — never reuse a picture blind.
      if (existingFile) {
        const liveAlt = reusableLiveBodyImage(existingFile, src, slot.heading, { title: frontmatter?.title, lead: slot.lead });
        // A reused alt is customer-facing copy too: it must clear the same
        // guardrails as a generated alt (no fallback → regenerate) and it
        // joins the compliance second pass below.
        const vettedAlt = liveAlt ? vetGeneratedAlt(liveAlt, null, Array.isArray(frontmatter?.domains) ? frontmatter.domains : null) : null;
        const committed = vettedAlt ? await committedImageBuffer(repoPath, async () => onMain) : null;
        if (committed) {
          // A reused picture obeys the same rule as a generated one: if it
          // duplicates the (possibly new) hero or a sibling, a NEW picture is
          // generated under the next free name instead.
          const dup = await nearDuplicateOf(committed, seen);
          if (!dup.label) { reuse = { alt: vettedAlt, hash: dup.hash, sha: onMain.sha || null }; break; }
          logger.warn(`[astro-publisher] committed body image ${repoPath} is a near-duplicate of ${dup.label} — generating a new picture under the next name instead of reusing`);
        }
      }
      // Occupied by a picture this run cannot reuse → next name.
    }
    if (reuse) {
      seen.push({ label: `body-${n}`, hash: reuse.hash });
      images.push({ src, alt: reuse.alt, reused: true, repoPath, sha: reuse.sha });
      newAlts.push(reuse.alt);
      placements.push({ insertAt: slot.insertAt, src, alt: reuse.alt });
      continue;
    }

    let gen;
    let buffer;
    let hash;
    // Framing rotates with the slot; a near-duplicate of the hero or a
    // sibling regenerates ONCE with the next framing, then parks — three of
    // the same picture never ship.
    for (let attempt = 0; ; attempt++) {
      const shot = BODY_IMAGE_SHOTS[(k + attempt) % BODY_IMAGE_SHOTS.length];
      try {
        const imageGenerator = require('../content/image-generator');
        gen = await imageGenerator.generate({
          title: frontmatter.title,
          topic: slot.lead || frontmatter.meta_description,
          keyword: slot.heading || frontmatter.primary_keyword,
          city,
          mode: 'blog-body',
          shot,
          avoid: heroSubject,
        });
        const img = await fetchImageBuffer(gen.dataUrl);
        if (!img?.buffer) throw new Error('body image generation produced no usable image');
        buffer = await compressToWebp(img.buffer, { width: BODY_IMAGE_WIDTH });
      } catch (err) {
        if (!err.attempts && Array.isArray(gen?.attempts)) err.attempts = gen.attempts;
        const bodyErr = new Error(`autonomous blog body image ${n} generation failed for ${slug} ("${slot.heading}"): ${describeHeroFailure(err)}`);
        bodyErr.code = 'BLOG_BODY_IMAGES_FAILED';
        bodyErr.cause = err;
        throw bodyErr;
      }
      const dup = await nearDuplicateOf(buffer, seen);
      hash = dup.hash;
      if (!dup.label) break;
      if (attempt >= 1) {
        const err = new Error(`autonomous blog body image ${n} for ${slug} ("${slot.heading}") is a near-duplicate of ${dup.label} even after regenerating with a different framing — parked so the post never ships repeated pictures`);
        err.code = 'BLOG_BODY_IMAGES_FAILED';
        throw err;
      }
      logger.warn(`[astro-publisher] body image ${n} for ${slug} is a near-duplicate of ${dup.label} (${shot}) — regenerating with the next framing`);
    }
    seen.push({ label: `body-${n}`, hash });
    // Vision-described alt (fail-open) over the prompt-derived one, vetted by
    // the same guardrails as the hero alt; the prompt-derived alt is the
    // fallback — it describes what was asked for, never the writer's text.
    const described = await describeHeroForAlt({ buffer, title: frontmatter.title, keyword: slot.heading });
    const alt = vetGeneratedAlt(described, gen.alt || `Illustration for ${slot.heading}`, Array.isArray(frontmatter.domains) ? frontmatter.domains : null);
    logger.info(`[astro-publisher] generated body image ${n} for ${slug} via ${gen.model} ("${slot.heading}")`);
    files.push({ path: repoPath, buffer });
    images.push({ src, alt, reused: false });
    newAlts.push(alt);
    placements.push({ insertAt: slot.insertAt, src, alt });
  }

  const nextBody = insertBodyImages(body, placements);
  if (countBodyImages(nextBody) < BODY_IMAGE_MIN) {
    const err = new Error(`autonomous blog body images: ${slug} still has fewer than ${BODY_IMAGE_MIN} body images after insertion`);
    err.code = 'BLOG_BODY_IMAGES_FAILED';
    throw err;
  }
  return { body: nextBody, files, images, newAlts };
}

// Paths a body-image commit depends on, re-checked on the FRESH branch just
// before the commit: every generated asset must still be absent (allocated
// as absent — a committed picture is never overwritten) and every REUSED
// asset must still carry the blob its alt and section verdict were judged
// on (a replacement landing on main mid-run would otherwise ship under a
// stale alt). Returns conflict descriptions (empty = clean).
async function bodyImageCommitConflicts(bodyImages, branch) {
  const conflicts = [];
  for (const f of bodyImages.files || []) {
    if (await gh.getFile(f.path, branch)) conflicts.push(`${f.path} (appeared since it was allocated)`);
  }
  for (const img of (bodyImages.images || []).filter((i) => i.reused && i.repoPath)) {
    const onBranch = await gh.getFile(img.repoPath, branch);
    if (!onBranch || (img.sha && onBranch.sha !== img.sha)) conflicts.push(`${img.repoPath} (reused picture changed: expected ${img.sha}, found ${onBranch?.sha || 'missing'})`);
  }
  return conflicts;
}
// Drop a branch no PR references yet (a retry cuts a fresh one).
async function dropUnreferencedBranch(branch, why) {
  try { await gh.deleteRef(branch); } catch (cleanupErr) {
    logger.warn(`[astro-publisher] could not delete branch ${branch} after ${why}: ${cleanupErr.message}`);
  }
}

async function publishOrUpdatePage(draft, brief = {}) {
  if (!canPublishDraftBrief(draft, brief)) {
    throw new Error(`unsupported autonomous draft for Astro publish: ${brief.action_type || 'unknown'}`);
  }

  const sourceFrontmatter = { ...(draft.frontmatter || {}) };
  const rawSlug = slugPathFromFrontmatter(sourceFrontmatter);
  const body = String(draft.body || '').trim();
  // MDX guard: autonomous posts are written as .mdx, where `{{ }}` is parsed as a
  // JS expression — NOT a token (remark-token-substitution only rewrites .md text
  // nodes). An un-substituted {{brandName}}/{{siteUrl}}/… reaches the build as an
  // undefined reference and CRASHES it (ReferenceError), parking the PR after a
  // full generation spend. Fail fast to review instead of shipping a crasher.
  const mdxToken = mdxBreakingToken(body);
  if (mdxToken) {
    const err = new Error(`autonomous blog body contains an MDX-breaking token "${mdxToken}" — .mdx posts must use literal text, not {{ }} tokens`);
    err.code = 'BLOG_MDX_TOKEN_LEAK';
    throw err;
  }
  // Spoke routing: a curated spoke-seed brief publishes the post on its single
  // spoke domain with a SELF-canonical spoke URL (the publisher owns domain
  // routing). The override is applied by assertCanonicalMatchesSlug below —
  // it validates the writer's EMITTED canonical first (off-site → throw →
  // park) and then stamps the blogOrigin-derived canonical itself. Replacing
  // the canonical BEFORE the guard would silently erase an off-site canonical
  // on spoke seeds that the identical hub draft gets parked for (Codex r5).
  // Non-spoke briefs keep the hub-only blog policy unchanged.
  const spokeTarget = resolveSpokeTarget(brief);
  const blogOrigin = blogOriginForSpoke(spokeTarget);
  // Validate the writer's slug↔canonical self-consistency on the EMITTED slug (a
  // genuinely mismatched draft still throws → review). THEN enforce the blog URL
  // protocol: the published slug, canonical, committed FILE, hero, and branch all
  // live under the post's own category route (/{category}/{slug}/). The writer
  // occasionally emits a FLAT top-level slug (e.g. /plaster-bagworms-southwest-
  // florida/), which renders locally but THROWS at the astro blog-slug-protocol
  // guardrail → fails every Pages build and parks the PR after a full generation
  // spend. Keying everything on the category route keeps file location 1:1 with
  // the URL, so a flat/nested duplicate of the same route can never be committed.
  assertCanonicalMatchesSlug(sourceFrontmatter, rawSlug, blogOrigin);
  const slug = categoryRouteSlug(rawSlug, normalizeAutonomousCategory(sourceFrontmatter, brief));
  const canonical = canonicalUrlForSlug(slug, blogOrigin);
  const branchSlug = slugify(slug.replace(/\//g, '-'));
  const branch = `content/autonomous-${branchSlug}-${shortId()}`;
  const frontmatter = normalizeAutonomousBlogFrontmatter(sourceFrontmatter, brief, body, { slug, canonical });
  stampBlogDomains(frontmatter, spokeTarget);
  // Keep the persisted run payload consistent with what we ACTUALLY publish.
  // The runner stores this same `draft` object in autonomous_runs.draft_payload,
  // and autonomous-pr-poller.targetForRun resolves the merged target from
  // draft_payload.frontmatter.canonical. We resolved the canonical/domains on a
  // clone (sourceFrontmatter) above, so without this write-back a spoke PR would
  // reconcile against the hub URL the agent emitted (which the spoke never
  // renders) and park forever. Mutate the original draft's canonical + domains
  // to the resolved values before the runner persists it.
  syncDraftPublishTarget(draft, frontmatter);

  // Hero contract: the writer agent's emit_draft tool only constrains
  // `frontmatter` to "object", while the binding blog schema REQUIRES
  // hero_image + og_image — so the agent typically invents a plausible
  // /images/blog/... path to satisfy validation. Nothing in this lane ever
  // committed hero bytes, so that invented path would 404 on the live hero
  // (eager + fetchpriority=high — the LCP element). The publisher therefore
  // OWNS the hero: whatever the agent emitted is overridden below with either
  // a verified already-committed hero or a freshly generated one committed
  // into the same branch as the markdown. (Publisher-side override needs zero
  // prompt surgery vs. teaching the agent the canonical path, and is robust
  // to the agent drifting anyway.)
  const heroAlt = heroAltForDraft(frontmatter);

  // Early pre-spend schema gate: validate the draft with a provisional
  // canonical hero stamped in (the final src always matches the schema's hero
  // pattern, so hero shape can't fail later). This keeps schema-invalid
  // drafts (bad meta_description length, missing fields, …) failing BEFORE we
  // spend an LLM fact-check call or image-generation dollars — same fail-fast
  // position the pre-hero-pipeline code had. The BINDING validation runs
  // again after the real hero is stamped.
  assertValidBlogFrontmatter(stampAutonomousHero(
    { ...frontmatter },
    `${ASTRO_HERO_PUBLIC_BASE}/${slug}/hero.webp`,
    heroAlt,
  ));

  // New autonomous posts are written as .mdx so they can embed MDX infographic
  // components. If a post already exists, update it in place; if a LEGACY .md
  // post exists, MIGRATE it to .mdx (write the .mdx and delete the stale .md in
  // the same branch — never leave both).
  //
  // An existing post that renders this route may sit at the category path
  // (src/content/blog/pest-control/foo.mdx) OR the flat path
  // (src/content/blog/foo.mdx — the older live convention), both carrying the
  // same /pest-control/foo/ slug. Probe the category path (= `slug` now) AND the
  // flat leaf path and adopt whichever ALREADY renders this exact route, so we
  // update it in place instead of committing a SECOND file with the same Astro
  // slug/canonical (a duplicate-route build conflict, in either direction). A
  // same-leaf file under a DIFFERENT category is skipped (not our post). When
  // nothing matches, a NEW post is written at the category route path — 1:1 with
  // its URL, so it can never collide with an unrelated leaf.
  const existingFile = await firstExistingRouteFile(
    [`${ASTRO_BLOG_DIR}/${slug}`, `${ASTRO_BLOG_DIR}/${slugLeafOf(slug)}`],
    slug,
  );
  const isLegacyMd = !!existingFile && existingFile.path.endsWith('.md');
  const filePath = existingFile && !isLegacyMd ? existingFile.path : `${ASTRO_BLOG_DIR}/${slug}.mdx`;

  // LLM fact-check (same gate as the admin publish path) before any branch is
  // cut, so a factual error never opens an orphan PR. The autonomous runner's
  // upstream gates are rule-based (quality, uniqueness) — none catch a wrong
  // species/ingredient/ordinance fact. Fail-open; blocks only on P0/P1.
  // Runs BEFORE hero resolution so a factually-blocked post never burns
  // image-generation cost.
  await assertFactCheckClear({
    title: frontmatter.title,
    body,
    city: brief.city || (Array.isArray(frontmatter.service_areas_tag) ? frontmatter.service_areas_tag[0] : ''),
    keyword: frontmatter.primary_keyword,
    tag: frontmatter.category,
  }, slug);

  // Semantic compliance, same placement as the fact-check above. This is the
  // UNATTENDED lane — an autonomous draft that clears every gate publishes with
  // no human in the loop — so it needs the semantic layer at least as much as
  // the admin lane does. Hero alt is included: publishOrUpdatePage writes it.
  await assertComplianceClear({
    title: frontmatter.title,
    body,
    meta: [frontmatter.metaTitle, frontmatter.meta_description, frontmatter.hero_image_alt, frontmatter.hero_image?.alt],
    city: brief.city || (Array.isArray(frontmatter.service_areas_tag) ? frontmatter.service_areas_tag[0] : ''),
    keyword: frontmatter.primary_keyword,
    tag: frontmatter.category,
  }, slug);

  // Resolve the real hero: reuse a hero already committed on main (update /
  // refresh runs must not regenerate), otherwise generate + compress one to
  // commit into this branch. Fails CLOSED (deterministic publish error) —
  // never a silent hero-less publish. Resolution happens BEFORE the branch is
  // cut so a hero failure can't orphan a branch/PR.
  const hero = await resolveAutonomousHero({ frontmatter, slug, existingFile });
  // A freshly generated hero carries a generation-derived alt that describes
  // the actual image — it wins over the agent's alt, which was written
  // before the image existed (the recurring alt↔hero mismatch). Reused
  // committed heroes keep the draft alt. The generated alt was produced
  // AFTER the runner's guardrails scanned the draft, so vet it against the
  // same policy here — a violating alt falls back to the already-scanned
  // draft alt instead of bypassing the gates.
  stampAutonomousHero(frontmatter, hero.src, vetGeneratedAlt(hero.alt, heroAlt, Array.isArray(frontmatter.domains) ? frontmatter.domains : null));

  // The compliance gate above scanned the DRAFT alt; a generated hero replaces
  // it, and vetGeneratedAlt is the deterministic guard only — so the alt that
  // actually ships never saw the semantic layer (Codex PR #3295 r3). The
  // reasoning is already in the comment above for the regex guard; it applies
  // identically here. Re-checked only when the stamped alt DIFFERS from the one
  // already scanned, so a reused hero costs nothing. The main gate stays before
  // hero resolution so a compliance block still never burns image-generation
  // cost — this is the narrow second pass for text that did not exist yet.
  const stampedAlt = String(frontmatter.hero_image?.alt || '').trim();
  if (stampedAlt && stampedAlt !== heroAlt) {
    await assertComplianceClear({
      title: frontmatter.title,
      body: '',
      meta: [stampedAlt],
      city: brief.city || (Array.isArray(frontmatter.service_areas_tag) ? frontmatter.service_areas_tag[0] : ''),
      keyword: frontmatter.primary_keyword,
      tag: frontmatter.category,
    }, `${slug} (generated hero alt)`);
  }

  // Body images (owner rule: ≥3 images per post) — resolved after the hero so
  // a hero failure never burns two more generations, and before the branch is
  // cut so a failure can't orphan a PR. Their alts (generated OR reused from
  // the live post) are text the semantic gate never saw on this draft: the
  // same narrow second pass as the hero alt.
  const bodyImages = await resolveBodyImages({
    frontmatter, slug, body, existingFile, brief,
    // Fresh hero bytes, or the committed hero's repo path when it was reused.
    siblings: [{ label: 'hero', buffer: hero.buffer, repoPath: hero.buffer ? null : (String(hero.src || '').startsWith('/') ? `public${hero.src}` : null) }],
  });
  if (bodyImages.newAlts.length) {
    await assertComplianceClear({
      title: frontmatter.title,
      body: '',
      meta: bodyImages.newAlts,
      city: brief.city || (Array.isArray(frontmatter.service_areas_tag) ? frontmatter.service_areas_tag[0] : ''),
      keyword: frontmatter.primary_keyword,
      tag: frontmatter.category,
    }, `${slug} (generated body image alts)`);
  }
  const finalBody = bodyImages.body;

  // Binding validation — runs on the FINAL frontmatter, after hero stamping,
  // so what we validate is exactly what we commit.
  assertValidBlogFrontmatter(frontmatter);

  const markdown = fm.stringify(frontmatter, `${finalBody}\n`);

  await gh.createBranch(branch);
  // Reused body pictures are pinned to the blob they were judged on; a
  // generated path must still be free. Any conflict is transient: the
  // branch is dropped and the runner retries against the live repo.
  {
    const conflicts = await bodyImageCommitConflicts(bodyImages, branch);
    if (conflicts.length) {
      await dropUnreferencedBranch(branch, 'a body-image lock mismatch');
      throw new Error(`body images for ${slug} changed since they were resolved on ${branch}: ${conflicts.join('; ')} — retry against the live content`);
    }
  }
  // ONE commit for hero bytes + markdown (+ legacy .md removal). The hero
  // still ships on the same branch as the frontmatter that references it
  // (mirrors publishAstro), but atomically: the multi-commit version of this
  // block pushed 2–3 commits seconds apart, Cloudflare Pages could register
  // the branch deployment against the first one, and the autonomous
  // PR poller's fail-closed head==deployment gate then starved the PR
  // forever on `preview_build_stale_commit` (PR #374, 2026-07-15).
  const fileCommit = await gh.commitFiles({
    branch,
    message: `feat(blog): publish ${slug}`,
    files: [
      ...(hero.buffer ? [{ path: hero.repoPath, buffer: hero.buffer }] : []),
      ...bodyImages.files,
      { path: filePath, content: markdown },
    ],
    deletes: isLegacyMd ? [existingFile.path] : [],
  });

  const pr = await gh.createPr({
    head: branch,
    title: `Blog: ${frontmatter.title}`.slice(0, 72),
    body: buildDraftPrBody({ frontmatter, slug, branch, content: finalBody, brief }),
  });
  await requestCodexReview({
    pr,
    headSha: pr.head?.sha || fileCommit?.commit?.sha,
    context: `Autonomous blog publish for \`${slug}\``,
  });

  return {
    url: canonical,
    status: 'pr_open',
    live: false,
    pr_number: pr.number,
    pr_url: pr.html_url,
    branch,
    preview_url: cloudflarePreviewUrl(branch),
    commit_sha: fileCommit?.commit?.sha || null,
  };
}

// Resolve which frontmatter casing variant a metadata rewrite should write,
// per field. Prefer the variant that exists on the live page (camelCase wins
// when both exist — it's the one the service/location layout renders). When
// neither variant of a field exists, follow the page's casing family
// (camelCase if the OTHER meta field is camelCase, else the blog snake_case
// contract) so we never introduce a dead duplicate field.
function metaRewriteFieldTargets(currentFrontmatter = {}) {
  const camelFamily = currentFrontmatter.metaTitle !== undefined
    || currentFrontmatter.metaDescription !== undefined;
  const titleField = currentFrontmatter.metaTitle !== undefined
    ? 'metaTitle'
    : (currentFrontmatter.title !== undefined ? 'title' : (camelFamily ? 'metaTitle' : 'title'));
  const metaField = currentFrontmatter.metaDescription !== undefined
    ? 'metaDescription'
    : (currentFrontmatter.meta_description !== undefined ? 'meta_description' : (camelFamily ? 'metaDescription' : 'meta_description'));
  return { titleField, metaField };
}

async function publishMetadataRewrite(draft, brief = {}) {
  if (!canPublishMetadataRewrite(draft, brief)) {
    throw new Error(`unsupported metadata rewrite for Astro publish: ${brief.action_type || 'unknown'}`);
  }

  const targetUrl = brief.target_url || brief.page_url || draft.page_url;
  const target = draft.file_path || urlToAstroPath(targetUrl);
  if (!target) throw new Error(`could not resolve metadata rewrite target: ${targetUrl || 'missing target_url'}`);

  const resolved = draft.file_path
    ? await resolveExistingAstroFile(target)
    : await resolveExistingAstroFileForTarget(targetUrl);
  if (!resolved) throw new Error(`Astro file not found for metadata rewrite: ${target}`);
  const filePath = resolved.path;
  const existing = resolved.file;

  const parsed = fm.parse(existing.content);
  const currentFrontmatter = parsed.data || {};
  const newTitle = String(draft.title || '').trim();
  const newMeta = String(draft.meta_description || '').trim();

  // Casing-aware field targeting — mirrors publishRefresh's
  // REFRESH_EDITABLE_META_FIELDS handling. Service/location pages use
  // metaTitle/metaDescription (the Astro layout renders fm.metaTitle ||
  // fm.title and fm.metaDescription); blog pages use title/meta_description.
  // Unconditionally writing the snake_case fields onto a camelCase page never
  // rendered, but still diffed → bumped `modified` (fake sitemap freshness)
  // and left dead duplicate fields behind. Write the variant that EXISTS on
  // the live page; only when neither variant exists, follow the page's
  // casing family so we never create a dead duplicate.
  const { titleField, metaField } = metaRewriteFieldTargets(currentFrontmatter);
  // Owner hard rule (2026-07-16): service/location metaTitles — the
  // intentional long near-me titles — are NEVER edited by automation. When
  // the rewrite lane targets a non-blog page whose rendered title field is
  // the protected metaTitle, keep the live value and apply only the
  // meta-description rewrite. (Blog titles are legitimately editable, and
  // non-blog pages rendering plain `title` are outside the protected
  // contract — PR #224 edited those deliberately.)
  const protectedMetaTitle = titleField === 'metaTitle'
    && !isBlogTarget(filePath)
    && currentFrontmatter.metaTitle !== undefined;
  const effectiveTitle = protectedMetaTitle ? currentFrontmatter[titleField] : newTitle;
  if (protectedMetaTitle && newTitle && newTitle !== String(currentFrontmatter[titleField] ?? '').trim()) {
    logger.warn(`[astro-publisher] metadata rewrite for ${filePath} attempted a metaTitle rewrite — kept the live metaTitle (protected field)`);
  }
  const nextFrontmatter = {
    ...currentFrontmatter,
    [titleField]: effectiveTitle,
    [metaField]: newMeta,
  };

  // Semantic no-op check on the RENDERED fields (a parse→stringify round-trip
  // rarely reproduces the source byte-for-byte, so compare meaning, not text).
  const titleChanged = protectedMetaTitle
    ? false // live value carried through untouched
    : newTitle !== String(currentFrontmatter[titleField] ?? '').trim();
  const metaChanged = newMeta !== String(currentFrontmatter[metaField] ?? '').trim();
  if (!titleChanged && !metaChanged) {
    return {
      url: canonicalForExistingPage(targetUrl, currentFrontmatter, filePath),
      status: 'no_changes',
      live: false,
      pr_number: null,
      pr_url: null,
      branch: null,
      preview_url: null,
      commit_sha: null,
    };
  }

  // Bump the freshness field the live page already uses (services: `modified`;
  // blog v2: `updated`) so sitemap lastmod updates and Google recrawls the
  // rewritten title/meta — these are high-SEO-value edits. Only when a
  // RENDERED field actually changed (checked above); mirrors publishRefresh
  // and avoids fake-freshness churn.
  {
    const today = etDateString();
    if (currentFrontmatter.modified !== undefined) nextFrontmatter.modified = `${today}T12:00:00`;
    else if (currentFrontmatter.updated !== undefined) nextFrontmatter.updated = today;
  }

  // Blog targets must stay schema-valid after a metadata rewrite (e.g.
  // meta_description 115-160). Non-blog pages use a different contract.
  // Legacy (pre-schema-v2) live posts may lack schema-required post_type /
  // service_areas_tag entirely — backfill the absent ones deterministically
  // instead of hard-failing a rewrite that never touched them.
  let backfilledFields = [];
  if (isBlogTarget(filePath)) {
    backfilledFields = backfillLegacyBlogRequiredFields(nextFrontmatter, brief);
    assertValidBlogFrontmatter(nextFrontmatter);
  }

  const markdown = fm.stringify(nextFrontmatter, parsed.content || '');
  if (markdown === existing.content) {
    return {
      url: canonicalForExistingPage(targetUrl, currentFrontmatter, filePath),
      status: 'no_changes',
      live: false,
      pr_number: null,
      pr_url: null,
      branch: null,
      preview_url: null,
      commit_sha: null,
    };
  }

  // Semantic compliance on the METADATA lane. This is the fourth publisher
  // entry point and the easiest one to overlook, because it writes no body —
  // but a meta description is customer-visible on every SERP and social card,
  // and the compliance codes govern it exactly as they govern prose. Runs
  // BEFORE branch creation so a blocked rewrite never opens an orphan PR, same
  // placement rationale as the fact-check on the other lanes. There is no body
  // here, so the effective title + description ARE the publishable text.
  await assertComplianceClear({
    title: nextFrontmatter.title,
    body: '',
    meta: [nextFrontmatter.title, nextFrontmatter.metaTitle, nextFrontmatter.meta_description, nextFrontmatter.metaDescription],
    city: brief.city || '',
    keyword: brief.primary_keyword || '',
    tag: nextFrontmatter.category || '',
  }, filePath);

  const branchSlug = slugify(filePath.replace(/^src\/content\//, '').replace(/\.mdx?$/, '').replace(/\//g, ' '));
  const branch = `content/meta-${branchSlug}-${shortId()}`;
  await gh.createBranch(branch);
  const fileCommit = await gh.putFile({
    path: filePath,
    content: markdown,
    message: `fix(seo): update title and meta for ${publicPathFromAstroFile(filePath)}`,
    branch,
    sha: existing.sha,
  });

  const pr = await gh.createPr({
    head: branch,
    title: `SEO metadata: ${nextFrontmatter[titleField]}`.slice(0, 72),
    body: buildMetadataPrBody({
      filePath,
      targetUrl,
      branch,
      before: currentFrontmatter,
      after: nextFrontmatter,
      titleField,
      metaField,
      brief,
      backfilledFields,
    }),
  });
  await requestCodexReview({
    pr,
    headSha: pr.head?.sha || fileCommit?.commit?.sha,
    context: `Autonomous title/meta rewrite for \`${filePath}\``,
  });

  return {
    url: canonicalForExistingPage(targetUrl, nextFrontmatter, filePath),
    status: 'pr_open',
    live: false,
    pr_number: pr.number,
    pr_url: pr.html_url,
    branch,
    preview_url: cloudflarePreviewUrl(branch),
    commit_sha: fileCommit?.commit?.sha || null,
  };
}

// Frontmatter fields the refresh agent is allowed to change. Everything else
// (canonical, slug, schema, domains, trackingNumberKey, cityPhone, city,
// pageType, category, robots, ogImage, …) is FROZEN to the live page's values
// so a refresh draft can never silently re-point a canonical, change a slug,
// or strip a tracking number. The freshness field (modified/updated) is bumped
// programmatically, only when the body actually changed.
const REFRESH_EDITABLE_META_FIELDS = ['title', 'metaTitle', 'meta_description', 'metaDescription'];

async function publishRefresh(draft, brief = {}) {
  if (!canPublishRefresh(draft, brief)) {
    throw new Error(`unsupported refresh for Astro publish: ${brief.action_type || 'unknown'}`);
  }

  const targetUrl = brief.target_url || brief.page_url || draft.page_url;
  const target = draft.file_path || urlToAstroPath(targetUrl);
  if (!target) throw new Error(`could not resolve refresh target: ${targetUrl || 'missing target_url'}`);

  const resolved = draft.file_path
    ? await resolveExistingAstroFile(target)
    : await resolveExistingAstroFileForTarget(targetUrl);
  if (!resolved) throw new Error(`Astro file not found for refresh: ${target}`);
  const filePath = resolved.path;
  const existing = resolved.file;

  const parsed = fm.parse(existing.content);
  const currentFrontmatter = parsed.data || {};
  const draftFm = draft.frontmatter || {};

  // FREEZE: start from the live frontmatter; override only the editable meta
  // fields, and only those that already exist on the live page (so we don't
  // introduce a title field a service page doesn't use, etc.).
  const nextFrontmatter = { ...currentFrontmatter };
  const refreshBlogTarget = isBlogTarget(filePath);
  for (const field of REFRESH_EDITABLE_META_FIELDS) {
    // Owner hard rule (2026-07-16): service/location metaTitles — the
    // intentional long near-me titles — are NEVER edited by automation.
    // Guardrails park a rewriting draft upstream (PROTECTED_META_TITLE_REWRITE);
    // this freeze is the last-resort backstop for any caller that reaches the
    // publisher without that gate. Blog pages don't carry the protected field
    // contract (their titles are legitimately editable).
    if (field === 'metaTitle' && !refreshBlogTarget) {
      const attempted = draftFm[field] !== undefined && String(draftFm[field]).trim()
        && currentFrontmatter[field] !== undefined
        && String(draftFm[field]).trim() !== String(currentFrontmatter[field]).trim();
      if (attempted) {
        logger.warn(`[astro-publisher] refresh draft for ${filePath} attempted a metaTitle rewrite — kept the live metaTitle (protected field)`);
      }
      continue;
    }
    if (currentFrontmatter[field] !== undefined && draftFm[field] !== undefined && String(draftFm[field]).trim()) {
      nextFrontmatter[field] = String(draftFm[field]).trim();
    }
  }

  const newBody = String(draft.body || '').trim();
  if (!newBody) throw new Error('refresh draft has empty body');
  const oldBody = String(parsed.content || '').trim();
  const bodyChanged = newBody !== oldBody;
  const metaChanged = REFRESH_EDITABLE_META_FIELDS.some((f) => nextFrontmatter[f] !== currentFrontmatter[f]);

  // Semantic no-op check (a parse→stringify round-trip rarely reproduces the
  // source byte-for-byte, so compare meaning, not text).
  if (!bodyChanged && !metaChanged) {
    return {
      url: canonicalForExistingPage(targetUrl, currentFrontmatter, filePath),
      status: 'no_changes', live: false, pr_number: null, pr_url: null, branch: null, preview_url: null, commit_sha: null,
    };
  }

  // Conditional freshness bump — only the field the live page already uses
  // (services: `modified`; blog v2: `updated`). Prevents fake-freshness churn.
  const today = etDateString();
  if (currentFrontmatter.modified !== undefined) nextFrontmatter.modified = `${today}T12:00:00`;
  else if (currentFrontmatter.updated !== undefined) nextFrontmatter.updated = today;

  // Blog targets must stay schema-valid after a refresh (meta_description
  // 115-160, required fields intact). The merge only overrides fields that
  // already exist on the live page, so a valid blog post stays valid unless the
  // agent produced an out-of-bounds title/meta — which this gate now blocks
  // before a PR is ever opened. Non-blog pages use a different contract.
  // Legacy (pre-schema-v2) live posts may lack schema-required post_type /
  // service_areas_tag entirely — backfill the absent ones deterministically
  // instead of hard-failing a refresh that never touched them.
  let backfilledFields = [];
  if (isBlogTarget(filePath)) {
    backfilledFields = backfillLegacyBlogRequiredFields(nextFrontmatter, brief);
    assertValidBlogFrontmatter(nextFrontmatter);
  }

  // Fact-check a refreshed blog body too — a refresh can introduce a wrong
  // pesticide/pathogen/ordinance fact just like a new draft. Only when the body
  // actually changed and the target is a blog post (the gate is blog-content
  // tuned; service/location pages use a different contract).
  if (isBlogTarget(filePath) && bodyChanged) {
    await assertFactCheckClear({
      title: nextFrontmatter.title,
      body: newBody,
      city: brief.city || (Array.isArray(nextFrontmatter.service_areas_tag) ? nextFrontmatter.service_areas_tag[0] : ''),
      keyword: nextFrontmatter.primary_keyword,
      tag: nextFrontmatter.category,
    }, filePath);
  }

  // Semantic compliance on the refresh lane too, for EVERY customer-facing
  // target — not just blogs. The fact-check above is blog-scoped because its
  // prompt is blog-tuned (pest biology, turf pathogens, county ordinances);
  // the compliance codes are not. An unconditional safety claim or a
  // wildlife-trapping offer on a SERVICE or LOCATION page is the same
  // violation, on a page with more commercial intent than most blog posts.
  // Also NOT gated on bodyChanged, unlike the fact-check: a refresh can rewrite
  // only the meta description, and that description ships. Hero alt is EXCLUDED
  // here, mirroring the regex gate — publishRefresh freezes frontmatter and
  // applies only the title/meta fields, so an alt it never commits must not
  // park the run.
  await assertComplianceClear({
    title: nextFrontmatter.title,
    body: newBody,
    meta: [nextFrontmatter.metaTitle, nextFrontmatter.meta_description, nextFrontmatter.metaDescription],
    city: brief.city || (Array.isArray(nextFrontmatter.service_areas_tag) ? nextFrontmatter.service_areas_tag[0] : ''),
    keyword: nextFrontmatter.primary_keyword,
    tag: nextFrontmatter.category,
  }, filePath);

  // Body images on refresh (owner rule: ≥3 images per post — a refresh is
  // how the image-poor legacy posts gain theirs). Same resolver as the new-
  // post lane: images the live body already carries are reused when their
  // section context is unchanged, the rest are generated and committed
  // beside the post; a live post that repeats its hero in the body (legacy
  // convention) keeps THAT exact reference rather than parking — any other
  // hero ref the draft introduces still parks. Blog targets only.
  let refreshImages = { body: newBody, files: [], newAlts: [] };
  if (refreshBlogTarget) {
    const heroSrc = String(nextFrontmatter?.hero_image?.src || '');
    refreshImages = await resolveBodyImages({
      frontmatter: nextFrontmatter,
      slug: filePath.replace(/^src\/content\/blog\//, '').replace(/\.mdx?$/, ''),
      body: newBody,
      existingFile: { path: filePath, file: existing },
      brief,
      siblings: heroSrc.startsWith('/') ? [{ label: 'hero', repoPath: `public${heroSrc}` }] : [],
      legacyHeroSrcs: legacyHeroRefs(oldBody, heroSrc),
    });
    if (refreshImages.newAlts.length) {
      await assertComplianceClear({
        title: nextFrontmatter.title,
        body: '',
        meta: refreshImages.newAlts,
        city: brief.city || (Array.isArray(nextFrontmatter.service_areas_tag) ? nextFrontmatter.service_areas_tag[0] : ''),
        keyword: nextFrontmatter.primary_keyword,
        tag: nextFrontmatter.category,
      }, `${filePath} (generated body image alts)`);
    }
  }
  const finalBody = refreshImages.body;
  const markdown = fm.stringify(nextFrontmatter, `${finalBody}\n`);

  const branchSlug = slugify(filePath.replace(/^src\/content\//, '').replace(/\.mdx?$/, '').replace(/\//g, ' '));
  const branch = `content/refresh-${branchSlug}-${shortId()}`;
  await gh.createBranch(branch);
  // Optimistic lock on the multi-file path: the tree write replaces paths
  // unconditionally (no per-file SHA like putFile), and image generation
  // ran BEFORE the branch was cut — a main-branch edit landing in between
  // would be carried into the branch and silently overwritten by markdown
  // diffed against the older read (then auto-merged). Re-read the target on
  // the fresh branch and require the SHA the draft was diffed against; a
  // mismatch is transient — the run retries against the new live content.
  // The lock covers EVERY path the commit writes: the post must still carry
  // the SHA it was diffed against, and each generated asset path (allocated
  // as ABSENT from main — resolveBodyImages never overwrites a committed
  // picture) must still be absent, or a concurrent write would be lost.
  if (refreshImages.files.length || (refreshImages.images || []).some((i) => i.reused)) {
    const conflicts = [];
    const onBranch = await gh.getFile(filePath, branch);
    if (!onBranch || onBranch.sha !== existing.sha) conflicts.push(`${filePath} (expected ${existing.sha}, found ${onBranch?.sha || 'missing'})`);
    conflicts.push(...await bodyImageCommitConflicts(refreshImages, branch));
    if (conflicts.length) {
      // No PR references the branch yet — drop it, or every collision
      // (the runner retries with a fresh shortId) leaves an orphan ref.
      await dropUnreferencedBranch(branch, 'a refresh lock mismatch');
      throw new Error(`refresh target changed since it was read on ${branch}: ${conflicts.join('; ')} — retry against the live content`);
    }
  }
  // New image bytes ride the SAME commit as the post (atomic, like the
  // autonomous lane); with nothing to add the single-file put stays.
  const fileCommit = refreshImages.files.length
    ? await gh.commitFiles({
      branch,
      message: `feat(content): refresh ${publicPathFromAstroFile(filePath)}`,
      files: [...refreshImages.files, { path: filePath, content: markdown }],
    })
    : await gh.putFile({
      path: filePath,
      content: markdown,
      message: `feat(content): refresh ${publicPathFromAstroFile(filePath)}`,
      branch,
      sha: existing.sha,
    });

  const pr = await gh.createPr({
    head: branch,
    title: `Refresh: ${nextFrontmatter.title || nextFrontmatter.metaTitle || publicPathFromAstroFile(filePath)}`.slice(0, 72),
    body: buildRefreshPrBody({ filePath, targetUrl, branch, before: currentFrontmatter, after: nextFrontmatter, oldBody, newBody: finalBody, brief, backfilledFields }),
  });
  await requestCodexReview({
    pr,
    headSha: pr.head?.sha || fileCommit?.commit?.sha,
    context: `Autonomous refresh for \`${filePath}\``,
  });

  return {
    url: canonicalForExistingPage(targetUrl, nextFrontmatter, filePath),
    status: 'pr_open',
    live: false,
    pr_number: pr.number,
    pr_url: pr.html_url,
    branch,
    preview_url: cloudflarePreviewUrl(branch),
    commit_sha: fileCommit?.commit?.sha || null,
  };
}

function canPublishDraftBrief(draft, brief = {}) {
  const actionType = String(brief.action_type || '').trim();
  return !!(
    draft
    && draft.type === 'draft'
    && draft.frontmatter
    && String(draft.body || '').trim()
    && actionType === 'new_supporting_blog'
  );
}

function canPublishMetadataRewrite(draft, brief = {}) {
  const actionType = String(brief.action_type || '').trim();
  return !!(
    draft
    && draft.type === 'metadata'
    && String(draft.title || '').trim()
    && String(draft.meta_description || '').trim()
    && actionType === 'rewrite_title_meta'
  );
}

/**
 * Read the LIVE page's frontmatter from the Astro repo. Used by guardrails to
 * enforce brand-token / multi-domain rules against the real page being
 * refreshed (the refresh draft carries only editable meta).
 *
 * Returns the parsed frontmatter object on success (possibly {} for a found
 * page with empty frontmatter — a legitimate hub-only page). Returns NULL when
 * the target can't be resolved or the file can't be read, so callers can tell
 * "this page has no domains" from "we couldn't check" and fail closed on the
 * latter.
 */
async function getLiveFrontmatter(targetUrlOrPath) {
  const resolved = await resolveExistingAstroFileForTarget(targetUrlOrPath);
  if (!resolved) return null;
  // _astro_source_path: the resolved repo path, under a reserved key no
  // frontmatter schema uses — callers need it to tell blog targets (titles
  // legitimately editable) from service/location targets (metaTitle
  // protected, owner rule 2026-07-16) without a second fetch.
  return { ...(fm.parse(resolved.file.content).data || {}), _astro_source_path: resolved.path };
}

/**
 * Load the live page BODY (markdown after the frontmatter) for a refresh
 * improvement comparison. Returns { body, word_count } on success, or NULL
 * when the target can't be resolved or the file can't be read — callers fail
 * closed (the content-quality gate's improvement_over_prior check refuses to
 * publish a refresh without a prior version to compare against).
 */
async function loadExistingPageBody(targetUrlOrPath, { strictRegistryErrors = false } = {}) {
  // strictRegistryErrors: a registry DB failure THROWS (code
  // REGISTRY_LOOKUP_FAILED) instead of reading as null — callers that
  // treat null as 'confirmed non-Astro' (the family miner's probe cache)
  // must be able to tell a transient failure apart (Codex #3255 r34).
  const resolved = await resolveExistingAstroFileForTarget(targetUrlOrPath, { rethrowLookupErrors: strictRegistryErrors });
  if (!resolved) return null;
  const parsed = fm.parse(resolved.file.content);
  const body = parsed.content || '';
  const word_count = body.split(/\s+/).filter(Boolean).length;
  // frontmatter rides along (additive): local blog slugs embed their city
  // without the -fl marker URL inference needs, but service_areas_tag
  // carries it authoritatively — the family miner derives refresh cities
  // from it (Codex #3255 r29).
  return { body, word_count, frontmatter: parsed.data || {} };
}

function canPublishRefresh(draft, brief = {}) {
  const actionType = String(brief.action_type || '').trim();
  return !!(
    draft
    && draft.type === 'draft'
    && String(draft.body || '').trim()
    && (brief.target_url || brief.page_url || draft.page_url)
    && actionType === 'refresh_existing_page'
  );
}

// ── Merge (approval → prod) ────────────────────────────────────────

async function mergeAstro(postId, { expectHeadSha = null } = {}) {
  const post = await db('blog_posts').where({ id: postId }).first();
  if (!post) throw new Error(`blog_post ${postId} not found`);
  if (!post.astro_pr_number) throw new Error('post has no open PR');

  const isUnpublish = post.astro_status === 'unpublish_pending';

  try {
    const pr = await gh.getPr(post.astro_pr_number);
    if (pr.merged) {
      await applyMergeEffect(postId, post, pr.merged_at ? new Date(pr.merged_at) : new Date(), isUnpublish, pr.merge_commit_sha || null);
      if (!isUnpublish) queueInternalLinkPlanning(post);
      return { already_merged: true, pr_number: pr.number, live_url: isUnpublish ? null : liveUrlForPost(post) };
    }
    if (pr.state !== 'open') {
      // Closed without merging (operator closed it on GitHub): pages-poll has
      // no finalizeClosed equivalent, so this retry path is the scheduler
      // lane's only observation of the closed PR — retire its remediation
      // row here or it reads as a live park forever.
      const { markPrTerminal } = require('../content/codex-remediation');
      await markPrTerminal(pr.number, 'closed');
      throw new Error(`PR #${pr.number} is ${pr.state}, cannot merge`);
    }
    // Callers that gated on an EXTERNAL signal (pages-poll: "the branch's
    // green build") bind that signal to a commit; if the PR head has moved
    // since, the signal doesn't vouch for what would merge — refuse (the
    // fresh head gets its own build + review, and the next tick retries).
    if (expectHeadSha && pr.head?.sha
        && String(expectHeadSha).trim().toLowerCase() !== String(pr.head.sha).trim().toLowerCase()) {
      throw new Error(`PR #${pr.number} head ${String(pr.head.sha).slice(0, 7)} no longer matches the verified build commit ${String(expectHeadSha).slice(0, 7)}; re-verify before merge`);
    }
    if (!isUnpublish) await assertOpenPublishPrIsHubOnly(post, pr);
    // A remediation push whose blog_posts.content mirror never completed must not
    // merge on ANY path — including a clean review, which never consults the P2
    // bar where this used to be checked. Merging would ship the fix with the
    // portal row still pre-fix, and a later republish/social share rebuilds from
    // that stale row. Unpublish PRs are exempt: they remove the page, so a stale
    // body mirror is moot.
    if (!isUnpublish) {
      const { syncPendingHold } = require('../content/codex-remediation');
      const hold = await syncPendingHold(pr.number, { headSha: pr.head?.sha, branch: pr.head?.ref });
      if (hold.pending) throw new Error(`PR #${pr.number} cannot merge: ${hold.reason}`);
    }
    await assertCodexReviewClear(pr.number, { headSha: pr.head?.sha });

    const result = await gh.mergePr(post.astro_pr_number, {
      method: 'squash',
      title: isUnpublish ? `Unpublish: ${post.title}`.slice(0, 72) : `Blog: ${post.title}`.slice(0, 72),
      // Pin the merge to the exact head the hub-only/Codex gates just vetted —
      // GitHub 409s if another push lands while this call is in flight
      // (mergePr supports this; the autonomous poller already pins, this
      // manual/scheduler path did not).
      sha: pr.head?.sha,
    });

    await applyMergeEffect(postId, post, new Date(), isUnpublish, result?.sha);
    if (!isUnpublish) queueInternalLinkPlanning(post);

    logger.info(`[astro-publisher] merged PR #${post.astro_pr_number} for post ${postId}${isUnpublish ? ' (unpublish)' : ''}`);
    return { merged: true, pr_number: post.astro_pr_number, sha: result?.sha, unpublished: isUnpublish, live_url: isUnpublish ? null : liveUrlForPost(post) };
  } catch (err) {
    logger.error(`[astro-publisher] merge failed for ${postId}: ${err.message}`);
    await db('blog_posts').where({ id: postId }).update({
      astro_publish_error: err.message.slice(0, 1000),
      updated_at: new Date(),
    });
    throw err;
  }
}

async function assertOpenPublishPrIsHubOnly(post, pr) {
  // Hub-only merge guard. Enforced whenever the spoke blog network is disabled
  // (the default) — a post can only carry non-hub domains here if it slipped
  // past the publish-time routing, so reject it. When an operator has EXPLICITLY
  // re-enabled the lane (SPOKE_BLOG_NETWORK_ENABLED=true), spoke-targeted PRs are
  // intended, so skip the assertion — otherwise the seed -> publish -> merge
  // chain is half-enabled (spoke PRs would be created but could never merge).
  if (spokeBlogNetworkEnabled()) return;
  const ref = post.astro_branch_name || pr?.head?.ref;
  const slug = post.slug || slugify(post.title);
  const resolved = await resolveExistingAstroFileAtRef(`${ASTRO_BLOG_DIR}/${slug}`, ref);
  if (!resolved) {
    throw new Error(`Astro PR #${pr.number} could not be verified as hub-only; republish the post before merge`);
  }

  const data = fm.parse(resolved.file.content)?.data || {};
  const tracking = data.tracking && typeof data.tracking === 'object' && !Array.isArray(data.tracking)
    ? data.tracking
    : {};
  const trackingHasDomains = Object.prototype.hasOwnProperty.call(tracking, 'domains');
  if (
    !isExplicitHubOnlyDomains(data.domains)
    || (trackingHasDomains && !isExplicitHubOnlyDomains(tracking.domains))
  ) {
    throw new Error(
      `Astro PR #${pr.number} was created with non-hub blog publish targets; republish the post before merge`,
    );
  }
}

async function resolveExistingAstroFileAtRef(pathOrBase, ref) {
  if (!pathOrBase || !ref) return null;
  const base = String(pathOrBase).replace(/\.mdx?$/, '');
  const exts = isBlogTarget(`${base}.md`) ? ['.mdx', '.md'] : ['.md'];
  for (const ext of exts) {
    const file = await gh.getFile(`${base}${ext}`, ref);
    if (file) return { path: `${base}${ext}`, file };
  }
  return null;
}

function isExplicitHubOnlyDomains(value) {
  const raw = normalizeArray(value);
  const normalized = normalizeSpokeSites(value);
  return raw.length === 1 && normalized.length === 1 && normalized[0] === 'wavespestcontrol.com';
}

// ── Internal links (post-merge) ────────────────────────────────────
//
// Mirror of the autonomous engine's publish-time planning: once a post is
// live on main, plan contextual internal links from existing hub content to
// the new URL and dry-run them to patch_candidate so they surface in the
// admin review queue. Fire-and-forget — a planner or corpus outage must
// never fail or slow the merge. PR opening stays with the existing gated
// executor paths; this only produces content_internal_link_tasks rows.
// Spoke-published posts are excluded by construction: liveUrlForPost returns
// a spoke-domain URL for them, which the planner's hub-only canonicalization
// rejects.
// Kill switch: enabled by default; any conventional falsy value disables it
// (previously only the literal string 'false' was honored, so '0'/'no'/'off'
// silently left planning on).
function internalLinkPlanningDisabled() {
  return /^(0|false|no|off)$/i.test(String(process.env.INTERNAL_LINK_PLAN_ON_BLOG_MERGE || '').trim());
}

function queueInternalLinkPlanning(post) {
  if (internalLinkPlanningDisabled()) return;
  planInternalLinksForMergedPost(post)
    .then((result) => {
      if (result) {
        logger.info(`[astro-publisher] internal-link planning for ${result.url}: queued=${result.queued} candidates=${result.candidates}`);
      }
    })
    .catch((err) => {
      logger.warn(`[astro-publisher] internal-link planning failed for post ${post.id}: ${err.message}`);
    });
}

async function planInternalLinksForMergedPost(post) {
  const url = liveUrlForPost(post);
  if (!url) return null;
  return planInternalLinksForTarget({
    url,
    keyword: post.keyword,
    city: post.city,
    title: post.title,
  });
}

// Target-shaped core of the post-merge planning above. Autonomous publishes
// have no blog_posts row (the run's draft_payload is the source of truth), so
// the PR-lifecycle poller calls this directly with { url, keyword, city,
// title } once the PR merges — same planner, corpus, dedupe, and dry-run as
// the blog_posts path.
async function planInternalLinksForTarget(target = {}) {
  const planner = require('../content/internal-link-planner');
  if (!planner?.planForTarget) return null;
  const url = target.url;
  if (!url) return null;
  const corpus = await loadAstroCorpusForPlanning(planner);
  if (!corpus.length) return null;
  const tasks = planner.planForTarget(
    { url, keyword: target.keyword, city: target.city, title: target.title },
    { corpus }
  );
  // Same insert-or-refresh helper as the runner's planning paths — a raw
  // onConflict().ignore() here discarded the current plan's keyword and
  // placement fields on duplicates and left retryable skipped rows parked.
  const { queueInternalLinkTaskForDryRun } = require('../content/autonomous-runner')._internals;
  const taskIds = [];
  for (const task of tasks) {
    // No catch: a DB error (e.g. unapplied migration) must reach the outer
    // planning rejection handler — swallowing it reported queued=0 as a
    // successful plan and silently lost every task.
    const queued = await queueInternalLinkTaskForDryRun(task, target.opportunity_id || null);
    if (queued?.id) taskIds.push(queued.id);
  }
  let candidates = 0;
  if (taskIds.length) {
    const executor = require('../content/internal-link-pr-executor');
    if (executor?.runDryRun) {
      const dryRun = await executor.runDryRun({ taskIds, limit: taskIds.length });
      candidates = (dryRun?.results || []).filter((r) => r.status === 'patch_candidate').length;
    }
  }
  return { url, queued: taskIds.length, candidates };
}

async function loadAstroCorpusForPlanning(planner) {
  const astroDir = process.env.ASTRO_REPO_DIR;
  if (astroDir && planner.loadAstroCorpus) return planner.loadAstroCorpus(astroDir, {});
  if (planner.loadAstroCorpusFromGitHub) return planner.loadAstroCorpusFromGitHub({});
  return [];
}

// Read the hero_image.src that the just-merged post's frontmatter actually
// references on main. Authoritative across publish-path versions (hero.webp
// from the new path, hero.png/.jpg from older in-flight PRs). Returns null if
// the file/field can't be read so the caller can fall back.
async function mergedHeroRef(slug) {
  try {
    const found = await resolveExistingAstroFile(`${ASTRO_BLOG_DIR}/${slug}`);
    const src = found?.file?.content ? fm.parse(found.file.content)?.data?.hero_image?.src : null;
    return (typeof src === 'string' && src.startsWith('/images/blog/')) ? src : null;
  } catch (err) {
    logger.warn(`[astro-publisher] could not read merged hero ref for ${slug}: ${err.message}`);
    return null;
  }
}

async function applyMergeEffect(postId, post, mergedAt, isUnpublish, sha) {
  // The PR left the open state — retire its codex_remediation_state row so
  // stale 'parked'/'remediating' rows over merged PRs don't read as live
  // park telemetry. Fail-soft bookkeeping (markPrTerminal never throws).
  if (post.astro_pr_number) {
    const { markPrTerminal } = require('../content/codex-remediation');
    await markPrTerminal(post.astro_pr_number, 'merged');
  }
  if (isUnpublish) {
    await db('blog_posts').where({ id: postId }).update({
      astro_status: 'draft',
      astro_pr_number: null,
      astro_branch_name: null,
      astro_preview_url: null,
      astro_live_url: null,
      astro_merged_at: null,
      astro_published_at: null,
      astro_publish_error: null,
      astro_commit_sha: sha || post.astro_commit_sha,
      status: 'draft',
      // The revert PR deleted the committed hero asset, so drop a stale
      // committed ref — a future republish regenerates/recommits. A CURATED
      // source URL is preserved: it's the only reference to the original
      // image, and clearing it would make a republish silently swap the
      // curated photo for a generated AI hero.
      ...(isCommittedHeroUrl(post.featured_image_url) ? { featured_image_url: null } : {}),
      updated_at: new Date(),
    });
    return;
  }
  const slug = post.slug || slugify(post.title);
  const updates = {
    astro_status: 'merged',
    astro_merged_at: mergedAt,
    astro_commit_sha: sha || post.astro_commit_sha,
    status: 'published',
    astro_live_url: liveUrlForPost(post),
    astro_published_at: null,
    updated_at: new Date(),
  };
  // Persist the now-live hero path ONLY at merge — the asset exists on main
  // exactly now. Persisting earlier (at PR open) would point downstream
  // consumers (auto social-share, republish) at a file that lives only on a
  // PR branch and vanishes if the build fails and the branch is deleted.
  //
  // And ONLY for generated/already-committed heroes. A curated
  // featured_image_url is the sole reference to the original source image —
  // overwriting it with the Astro copy means unpublish (which deletes that
  // copy) leaves the draft with nothing to refetch, and a republish would
  // silently replace the curated photo with a generated AI hero. Curated
  // URLs are already absolute and renderable for admin/social, so they need
  // no rewrite.
  if (!post.featured_image_url || isCommittedHeroUrl(post.featured_image_url)) {
    // Read the authoritative path straight from the merged frontmatter rather
    // than assuming an extension: a PR opened by the new code committed
    // hero.webp, but one opened by the OLD path (still in flight when this
    // deploys) committed hero.png/.jpg, and guessing webp would record a
    // broken path. Fall back to the existing committed path, then hero.webp.
    const rawHeroRef =
      (await mergedHeroRef(slug))
      || (isCommittedHeroUrl(post.featured_image_url) ? post.featured_image_url : null)
      || `${ASTRO_HERO_PUBLIC_BASE}/${slug}/hero.webp`;
    // Store an ABSOLUTE hub URL for DB/admin/social consumers; the relative
    // /images/blog path only resolves on the Astro site, not the portal origin.
    updates.featured_image_url = absoluteHeroUrl(rawHeroRef);
  }
  await db('blog_posts').where({ id: postId }).update(updates);
}

// ── Unpublish (soft, via revert PR) ────────────────────────────────

async function unpublishAstro(postId) {
  const post = await db('blog_posts').where({ id: postId }).first();
  if (!post) throw new Error(`blog_post ${postId} not found`);
  if (post.astro_status !== 'live' && post.astro_status !== 'merged') {
    throw new Error(`cannot unpublish from status "${post.astro_status}"; expected live or merged`);
  }

  const slug = post.slug || slugify(post.title);
  const branch = `content/unpublish-${slug}-${shortId()}`;

  try {
    await gh.createBranch(branch);

    const resolved = await resolveExistingAstroFile(`${ASTRO_BLOG_DIR}/${slug}`);
    if (!resolved) throw new Error(`markdown not found on main: ${ASTRO_BLOG_DIR}/${slug}.{mdx,md}`);
    const mdPath = resolved.path;
    const mdFile = resolved.file;

    await gh.deleteFile({
      path: mdPath,
      message: `chore(blog): unpublish ${slug}`,
      branch,
      sha: mdFile.sha,
    });

    const heroCandidates = ['webp', 'png', 'jpg'].map((ext) => `${ASTRO_HERO_DIR}/${slug}/hero.${ext}`);
    const heroFiles = [];
    for (const path of heroCandidates) {
      const file = await gh.getFile(path);
      if (file) heroFiles.push({ path, file });
    }
    const heroFile = heroFiles[0]?.file || null;
    if (heroFile) {
      for (const found of heroFiles) {
        await gh.deleteFile({
          path: found.path,
          message: `chore(blog): remove hero for ${slug}`,
          branch,
          sha: found.file.sha,
        });
      }
    }

    const prBody = [
      `**Unpublish from admin portal**`,
      ``,
      `Removes \`${mdPath}\`${heroFile ? ' and committed hero image assets' : ''} from main.`,
      ``,
      `Merge to take the post offline. After merge the post returns to \`draft\` state in the portal and can be republished later.`,
      ``,
      `Branch: \`${branch}\``,
    ].join('\n');

    const pr = await gh.createPr({
      head: branch,
      title: `Unpublish: ${post.title}`.slice(0, 72),
      body: prBody,
    });
    await requestCodexReview({
      pr,
      headSha: pr.head?.sha || null,
      context: `Blog unpublish for \`${slug}\``,
    });

    await db('blog_posts').where({ id: postId }).update({
      astro_status: 'unpublish_pending',
      astro_branch_name: branch,
      astro_pr_number: pr.number,
      astro_preview_url: null,
      astro_publish_error: null,
      updated_at: new Date(),
    });

    logger.info(`[astro-publisher] opened unpublish PR #${pr.number} for ${slug} on ${branch}`);
    return { pr_number: pr.number, pr_url: pr.html_url, branch };
  } catch (err) {
    logger.error(`[astro-publisher] unpublish failed for ${slug}: ${err.message}`);
    await db('blog_posts').where({ id: postId }).update({
      astro_publish_error: err.message.slice(0, 1000),
      updated_at: new Date(),
    });
    throw err;
  }
}

// ── Helpers ────────────────────────────────────────────────────────

function cloudflarePreviewUrl(branch) {
  // CF Pages preview pattern: <branch-hash>.<project>.pages.dev. We don't
  // know the hash until the build completes — the poll worker resolves it.
  // For now we surface the branch name; the admin UI treats this as "preview
  // pending" until the poll updates the URL.
  const project = process.env.CF_PAGES_PROJECT || 'wavespestcontrol-astro';
  const safeBranch = branch.replace(/[^a-z0-9]/gi, '-').toLowerCase();
  return `https://${safeBranch}.${project}.pages.dev`;
}

function liveUrlForPost(post) {
  const slug = post.slug || slugify(post.title);
  const origin = process.env.ASTRO_HUB_ORIGIN || 'https://www.wavespestcontrol.com';
  return `${origin.replace(/\/$/, '')}/${slug}/`;
}

function buildPrBody({ post, slug, branch, content }) {
  const wordCount = content ? content.split(/\s+/).filter(Boolean).length : 0;
  return [
    `**Blog publish from admin portal**`,
    ``,
    `- Slug: \`${slug}\``,
    `- Category: ${post.category || '—'}`,
    `- Service areas: ${formatList(post.service_areas_tag)}`,
    `- Author: ${post.author_slug || '—'}`,
    `- Reviewer: ${post.reviewer_slug || '—'}`,
    `- Word count: ${wordCount}`,
    ``,
    `Generated by waves-customer-portal → astro-publisher. Merge to go live.`,
    ``,
    `Branch: \`${branch}\``,
  ].join('\n');
}

function buildDraftPrBody({ frontmatter, slug, branch, content, brief }) {
  const wordCount = content ? content.split(/\s+/).filter(Boolean).length : 0;
  const seoSection = buildSeoReviewSection({ frontmatter, brief });
  return [
    `**Autonomous content publish**`,
    ``,
    `- Slug: \`${slug}\``,
    `- Action type: ${brief.action_type || '—'}`,
    `- Category: ${frontmatter.category || '—'}`,
    `- Service areas: ${formatList(frontmatter.service_areas_tag)}`,
    `- Word count: ${wordCount}`,
    ``,
    seoSection,
    ``,
    `Generated by waves-customer-portal autonomous runner. Merge to go live.`,
    ``,
    `Branch: \`${branch}\``,
  ].join('\n');
}

function buildMetadataPrBody({ filePath, targetUrl, branch, before = {}, after = {}, titleField = 'title', metaField = 'meta_description', brief = {}, backfilledFields = [] }) {
  return [
    `**Autonomous title/meta rewrite**`,
    ``,
    `- File: \`${filePath}\``,
    `- URL: ${targetUrl || canonicalForExistingPage(null, after, filePath)}`,
    `- Action type: ${brief.action_type || 'rewrite_title_meta'}`,
    `- Target query: ${brief.target_keyword || '—'}`,
    `- City/service: ${(brief.city || '—')} / ${(brief.service || '—')}`,
    ``,
    `## Frontmatter Changes`,
    ``,
    `| Field | Before | After |`,
    `| --- | --- | --- |`,
    `| ${titleField} | ${markdownTableCell(before[titleField])} | ${markdownTableCell(after[titleField])} |`,
    `| ${metaField} | ${markdownTableCell(before[metaField])} | ${markdownTableCell(after[metaField])} |`,
    ``,
    ...(backfilledFields.length ? [
      `**Backfilled schema-required fields (inferred — legacy pre-schema-v2 post):** ${backfilledFields.map((f) => `\`${f}\``).join(', ')}. Review the inferred values in the diff.`,
      ``,
    ] : []),
    `Body, slug, canonical, and schema are intentionally unchanged${backfilledFields.length ? ' (other than the backfilled fields above)' : ''}.`,
    ``,
    `Generated by waves-customer-portal autonomous runner. Merge after review.`,
    ``,
    `Branch: \`${branch}\``,
  ].join('\n');
}

function buildRefreshPrBody({ filePath, targetUrl, branch, before = {}, after = {}, oldBody = '', newBody = '', brief = {}, backfilledFields = [] }) {
  const oldWords = String(oldBody).split(/\s+/).filter(Boolean).length;
  const newWords = String(newBody).split(/\s+/).filter(Boolean).length;
  const titleField = after.metaTitle !== undefined ? 'metaTitle' : 'title';
  const metaField = after.metaDescription !== undefined ? 'metaDescription' : 'meta_description';
  return [
    `**Autonomous page refresh**`,
    ``,
    `- File: \`${filePath}\``,
    `- URL: ${targetUrl || canonicalForExistingPage(null, after, filePath)}`,
    `- Action type: ${brief.action_type || 'refresh_existing_page'}`,
    `- City/service: ${(brief.city || '—')} / ${(brief.service || '—')}`,
    `- Body: ${oldWords} → ${newWords} words`,
    ``,
    `## Editable frontmatter changes`,
    ``,
    `| Field | Before | After |`,
    `| --- | --- | --- |`,
    `| ${titleField} | ${markdownTableCell(before[titleField])} | ${markdownTableCell(after[titleField])} |`,
    `| ${metaField} | ${markdownTableCell(before[metaField])} | ${markdownTableCell(after[metaField])} |`,
    ``,
    ...(backfilledFields.length ? [
      `**Backfilled schema-required fields (inferred — legacy pre-schema-v2 post):** ${backfilledFields.map((f) => `\`${f}\``).join(', ')}. Review the inferred values in the diff.`,
      ``,
    ] : []),
    `**Frozen (unchanged):** canonical, slug, schema, domains, trackingNumberKey, cityPhone, ${backfilledFields.some((f) => String(f).startsWith('page_type')) ? '' : 'pageType, '}category, robots, ogImage — all preserved from the live page. Only body + meta + freshness date${backfilledFields.length ? ' + the backfilled fields above' : ''} changed.`,
    ``,
    `Generated by waves-customer-portal autonomous runner. Merge after review.`,
    ``,
    `Branch: \`${branch}\``,
  ].join('\n');
}

function buildSeoReviewSection({ frontmatter = {}, brief = {} } = {}) {
  const result = brief.seo_completion_gate_result || {};
  const contract = brief.seo_contract || result.contract || {};
  const summary = result.summary || {};
  const findings = Array.isArray(result.findings) ? result.findings : [];
  const internalLinks = Array.isArray(contract.internalLinkRecommendations)
    ? contract.internalLinkRecommendations
    : (Array.isArray(contract.internalLinks) ? contract.internalLinks : []);
  const schemaTypes = Array.isArray(frontmatter.schema_types) ? frontmatter.schema_types : [];

  const findingLines = findings.length
    ? findings.slice(0, 12).map((item) => `- ${item.severity} ${item.code}: ${item.message}`)
    : ['- No SEO completion findings were reported by the portal gate.'];

  const linkLines = internalLinks.length
    ? internalLinks.slice(0, 8).map((link, index) => `${index + 1}. ${link.url}\n   Anchor: ${link.anchorText || '—'}\n   Reason: ${link.reason || '—'}${link.required ? ' (required)' : ''}`)
    : ['None reported.'];

  return [
    `## Autonomous Blog SEO Review`,
    ``,
    `### Gate Summary`,
    `- SEO gate passed: ${result.passed === false ? 'no' : 'yes'}`,
    `- P0/P1/P2 findings: ${summary.p0 || 0}/${summary.p1 || 0}/${summary.p2 || 0}`,
    `- Score: ${result.score ?? 'not reported'}`,
    ``,
    `### Content`,
    `- [ ] Topic matches opportunity intent`,
    `- [ ] Page type is supporting blog, not service page`,
    `- [ ] Local SWFL framing is present`,
    `- [ ] Waves voice is present`,
    `- [ ] No customer PII or verbatim call/SMS quotes`,
    `- [ ] No hardcoded prices unless approved`,
    ``,
    `### SEO Completion`,
    `- [ ] Visible breadcrumbs render`,
    `- [ ] BreadcrumbList JSON-LD renders${schemaTypes.includes('BreadcrumbList') ? ' (schema_types includes BreadcrumbList)' : ''}`,
    `- [ ] BlogPosting/Article JSON-LD renders${schemaTypes.some((type) => ['Article', 'BlogPosting'].includes(type)) ? ' (schema_types includes Article/BlogPosting)' : ''}`,
    `- [ ] FAQ section visible if brief required it`,
    `- [ ] FAQPage schema only emitted if visible FAQ exists`,
    `- [ ] Internal links included or recommended`,
    `- [ ] CTA appears near top`,
    `- [ ] CTA appears near bottom`,
    `- [ ] Pest-practices section included`,
    ``,
    `### Findings`,
    ...findingLines,
    ``,
    `### Recommended Links`,
    ...linkLines,
    ``,
    `### Review`,
    `- [ ] Codex review completed`,
    `- [ ] P0/P1 findings fixed`,
    `- [ ] Cloudflare preview checked`,
    `- [ ] Rendered output matches expected structure`,
  ].join('\n');
}

// The topic segment of a slug/canonical/URL — the LAST non-empty path part,
// stripped of origin, query, hash, and surrounding slashes.
// slugLeafOf moved to ./blog-categories — the runner's slug repair gates
// canonical rewrites on the same leaf comparison (Codex r11).

// The ROUTE slug (the /{category}/{slug}/ URL path) for a blog post: the post's
// own category, then the topic leaf of its raw slug. The astro
// blog-slug-protocol guardrail THROWS at astro:config:setup unless a post's
// frontmatter slug is exactly /{category}/{slug}/, and the writer agent
// occasionally emits a FLAT top-level slug (e.g. plaster-bagworms-southwest-
// florida) — which renders locally but fails every Pages build and parks the PR
// after a full generation spend. Deriving the route from the post's own category
// keeps slug + canonical + category consistent by construction, for every
// category (pest-control / lawn-care / termite / mosquito / tree-shrub), not a
// hardcoded one. The committed file/hero PATHS keep using the raw slug, so this
// only governs the public URL (matching the live flat-file/prefixed-URL posts).
// Idempotent: an already-correct {category}/{leaf} returns unchanged.
function categoryRouteSlug(rawSlug, category) {
  const cat = String(category || '').replace(/^\/+|\/+$/g, '');
  const leaf = slugLeafOf(rawSlug);
  if (!cat) return leaf || String(rawSlug || '').replace(/^\/+|\/+$/g, '');
  return leaf ? `${cat}/${leaf}` : cat;
}

function slugPathFromFrontmatter(frontmatter) {
  const raw = String(frontmatter?.slug || '').trim();
  const pathname = raw
    .replace(/^https?:\/\/[^/]+/i, '')
    .split(/[?#]/)[0]
    .replace(/^\/+|\/+$/g, '');
  if (!pathname || pathname.startsWith('..') || pathname.includes('/../')) {
    throw new Error('autonomous draft missing safe frontmatter slug');
  }
  return pathname;
}

function canonicalUrlForSlug(slug, origin = HUB_ORIGIN) {
  const base = String(origin || HUB_ORIGIN).replace(/\/$/, '');
  return `${base}/${slug}/`;
}

function normalizeCanonicalPath(pathname) {
  return `/${String(pathname || '').replace(/^\/+|\/+$/g, '')}/`;
}

// Hosts an autonomous draft canonical may legitimately point at: the resolved
// publish origin, the hub, and the spoke fleet (with/without www). A canonical
// on any of these is publisher-repairable (we derive the binding canonical
// from the slug anyway); a canonical on ANY OTHER host would hand the page's
// ranking signal to an off-fleet site and must fail, never be silently
// "repaired" into a publish.
function isFleetCanonicalHost(host, expectedOrigin) {
  const h = String(host || '').toLowerCase().replace(/^www\./, '');
  if (!h) return false;
  try {
    if (h === new URL(expectedOrigin).hostname.toLowerCase().replace(/^www\./, '')) return true;
  } catch { /* fall through to the fleet list */ }
  try {
    if (h === new URL(HUB_ORIGIN).hostname.toLowerCase().replace(/^www\./, '')) return true;
  } catch { /* fall through to the fleet list */ }
  return SPOKE_SITE_KEYS.some((key) => h === String(key).toLowerCase());
}

function assertCanonicalMatchesSlug(frontmatter, slug, origin = HUB_ORIGIN) {
  const expected = canonicalUrlForSlug(slug, origin);
  const supplied = String(frontmatter?.canonical || '').trim();
  // The writer's canonical is ADVISORY — the binding canonical is derived from
  // the (category-route) slug by the caller regardless. Reject ONLY:
  //   - a canonical that VALIDLY points to a DIFFERENT post (different leaf
  //     slug): a genuinely confused draft worth parking for review;
  //   - an OFF-FLEET canonical (absolute URL on a host that is neither the
  //     publish origin, the hub, nor a spoke): repairing that would silently
  //     convert a cross-site canonical into a publish — fail closed instead.
  // An absent, malformed, relative, fleet-origin, or mere category-prefix
  // variant ("/foo/" vs "/pest-control/foo/", which the publisher resolves via
  // categoryRouteSlug) is normalized to the slug-derived canonical — those
  // mismatches were wasting whole generations on a field we overwrite anyway.
  if (supplied) {
    // Route-bearing forms (leading slash or backslash, or an absolute URL)
    // parse against the expected origin, and the host check below runs on
    // the RESOLVED hostname (Codex r9/r10): textual prefix tests keep
    // missing host-bearing forms — protocol-relative `//host/…`,
    // slash-backslash `/\host/…`, and network-path `\\host/…` all resolve
    // onto a foreign host under WHATWG rules, while a genuinely relative
    // path resolves onto the expected origin and passes the fleet check by
    // construction. A base-less parse is equally wrong in the other
    // direction: `\\host/…` fails it outright and was silently replaced
    // instead of parked. Bare junk with no route shape ("not a valid url")
    // stays OUT of classification — it validly points nowhere, so it is
    // derived from the slug instead of wasting the generation.
    let suppliedUrl = null;
    let routeBearing = /^[/\\]/.test(supplied);
    if (!routeBearing) {
      try { new URL(supplied); routeBearing = true; } catch { /* bare junk → derive */ }
    }
    if (routeBearing) {
      try {
        suppliedUrl = new URL(supplied, new URL(expected).origin);
      } catch {
        suppliedUrl = null; // malformed → derive from slug below
      }
    }
    if (suppliedUrl) {
      // The off-site check runs on the PARSED hostname regardless of the raw
      // prefix (Codex r9): the WHATWG parser resolves slash-backslash forms
      // like `/\competitor.example/foo/` as HOST-BEARING URLs, so a textual
      // "starts with a single slash" test would skip the fleet check on an
      // off-fleet canonical. A genuinely path-relative canonical resolves
      // onto the expected origin and passes the fleet check by construction.
      if (!isFleetCanonicalHost(suppliedUrl.hostname, origin)) {
        // Deterministic publish error (autonomous-runner parks it for review
        // instead of retry-looping the same draft).
        throw new Error(`autonomous draft canonical points off-site (${suppliedUrl.hostname}) — refusing to repair a cross-site canonical`);
      }
      const suppliedLeaf = slugLeafOf(suppliedUrl.pathname);
      const expectedLeaf = slugLeafOf(slug);
      if (suppliedLeaf && expectedLeaf && suppliedLeaf !== expectedLeaf) {
        throw new Error(`autonomous draft canonical must match slug ${frontmatter.slug}`);
      }
    }
  }
  frontmatter.canonical = expected;
  return expected;
}

function formatList(v) {
  if (!v) return '—';
  const arr = Array.isArray(v) ? v : safeJson(v, []);
  return arr.length ? arr.join(', ') : '—';
}

function markdownTableCell(value) {
  return String(value || '—').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

function canonicalForExistingPage(targetUrl, frontmatter = {}, filePath = '') {
  const explicit = String(frontmatter.canonical || frontmatter.canonical_url || targetUrl || '').trim();
  if (explicit) return explicit;
  const origin = (process.env.ASTRO_HUB_ORIGIN || 'https://www.wavespestcontrol.com').replace(/\/$/, '');
  return `${origin}${publicPathFromAstroFile(filePath)}`;
}

function publicPathFromAstroFile(filePath) {
  const cleaned = String(filePath || '')
    .replace(/^src\/content\/(?:blog|services|locations)\//, '')
    .replace(/\.mdx?$/, '')
    .replace(/^\/+|\/+$/g, '');
  if (!cleaned) return '/';
  return `/${cleaned}/`;
}

const SERVICE_HUB_SLUGS = new Set([
  'pest-control',
  'lawn-care',
  'mosquito-control',
  'termite-control',
  'rodent-control',
  'bed-bug-control',
  'commercial-pest-control',
  'pest-control-services',
  'pest-control-quote',
  'termite-inspection',
  'tree-shrub-care',
  'tree-and-shrub-care',
]);

const SLUG_SEGMENT = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

function isSafeSlugPath(value) {
  const s = String(value || '');
  if (!s || s.includes('..') || s.includes('%') || s.includes('\\')) return false;
  return s.split('/').every((segment) => SLUG_SEGMENT.test(segment));
}

function isSafeAstroContentPath(value) {
  const path = String(value || '').replace(/^\/+/, '');
  const match = path.match(/^src\/content\/(?:blog|services|locations)\/(.+)\.mdx?$/);
  if (!match) return false;
  return isSafeSlugPath(match[1]);
}

function registryLookupValuesForUrl(urlOrPath) {
  const normalized = normalizeContentUrl(urlOrPath);
  if (!normalized) return { exact: [], host: null, pathOnly: null };
  const normalizedPath = normalized.replace(/^https?:\/\/[^/]+/i, '').replace(/^\/+|\/+$/g, '');
  if (normalizedPath && !isSafeSlugPath(normalizedPath)) return { exact: [], host: null, pathOnly: null };

  const values = [normalized];
  const raw = String(urlOrPath || '').trim();
  let host = null;
  let pathOnly = null;
  if (normalized.startsWith('/')) {
    const hub = (process.env.ASTRO_HUB_ORIGIN || 'https://www.wavespestcontrol.com').replace(/\/$/, '');
    values.push(`${hub}${normalized}`);
  }
  if (/^https?:\/\//i.test(raw)) {
    try {
      const parsed = new URL(raw);
      const normalizedPathOnly = normalizeContentUrl(parsed.pathname);
      const parsedHost = parsed.hostname.toLowerCase().replace(/^www\./, '');
      if (normalizedPathOnly) values.push(`${parsed.origin.replace(/\/$/, '')}${normalizedPathOnly}`);
      if (normalizedPathOnly && !isHubHost(parsedHost)) {
        host = parsedHost;
        pathOnly = normalizedPathOnly;
      }
    } catch {
      // normalizeContentUrl already rejected malformed absolute URLs.
    }
  }
  return { exact: [...new Set(values)], host, pathOnly };
}

function isHubHost(host) {
  return host === 'wavespestcontrol.com' || host === 'www.wavespestcontrol.com';
}

function urlToAstroPath(url) {
  const cleaned = String(url || '')
    .replace(/^https?:\/\/[^/]+/i, '')
    .replace(/\?.*$/, '')
    .replace(/^\/+|\/+$/g, '');
  if (!cleaned || !isSafeSlugPath(cleaned)) return null;
  if (cleaned.startsWith('blog/')) return `src/content/blog/${cleaned.slice(5)}.md`;
  if (/-fl$/.test(cleaned)) return `src/content/services/${cleaned}.md`;
  if (SERVICE_HUB_SLUGS.has(cleaned)) return `src/content/services/${cleaned}.md`;
  return `src/content/locations/${cleaned}.md`;
}

async function requestCodexReview({ pr, headSha, context }) {
  if (!pr?.number || typeof gh.createIssueComment !== 'function') return { requested: false, skipped: true };
  const reviewHead = headSha ? String(headSha) : 'unknown';
  const body = [
    '@codex review',
    '',
    `${context || 'Astro content PR'} is ready for review on head \`${reviewHead}\`.`,
    '',
    'Please review before merge.',
  ].join('\n');
  try {
    await gh.createIssueComment(pr.number, body);
    logger.info(`[astro-publisher] requested Codex review for PR #${pr.number}`);
    return { requested: true };
  } catch (err) {
    logger.warn(`[astro-publisher] failed to request Codex review for PR #${pr.number}: ${err.message}`);
    return { requested: false, error: err.message };
  }
}

async function assertCodexReviewClear(prNumber, { headSha = null } = {}) {
  if (process.env.ASTRO_REQUIRE_CODEX_REVIEW === 'false') return true;
  if (typeof gh.listIssueComments !== 'function' || typeof gh.listPrReviews !== 'function') {
    throw new Error('Codex review is required before merge, but GitHub review lookup is unavailable');
  }

  const [comments, reviews] = await Promise.all([
    gh.listIssueComments(prNumber),
    gh.listPrReviews(prNumber),
  ]);
  const status = codexReviewStatus({ comments, reviews, headSha });
  if (status.clean) return true;

  const err = new Error(status.reason || `Codex review is required before merging PR #${prNumber}`);
  err.code = 'CODEX_REVIEW_REQUIRED';
  throw err;
}

function codexReviewStatus({ comments = [], reviews = [], headSha = null } = {}) {
  const requestedAt = latestReviewRequestAt(comments, headSha);
  const codexComments = comments
    .filter((comment) => isCodexAuthor(comment?.user?.login || comment?.author?.login))
    .filter((comment) => commentEligibleForHead(comment, { headSha, requestedAt }))
    .sort((a, b) => Date.parse(a.created_at || a.createdAt || 0) - Date.parse(b.created_at || b.createdAt || 0));
  const codexReviews = reviews
    .filter((review) => isCodexAuthor(review?.user?.login || review?.author?.login))
    .filter((review) => reviewEligibleForHead(review, { headSha, requestedAt }))
    .sort((a, b) => Date.parse(a.submitted_at || a.submittedAt || 0) - Date.parse(b.submitted_at || b.submittedAt || 0));
  const latestBody = [
    codexComments.at(-1)?.body,
    codexReviews.at(-1)?.body,
  ].filter(Boolean).join('\n\n');

  if (/usage limits|reached your Codex usage limits/i.test(latestBody)) {
    return { clean: false, reason: 'Codex review did not complete because usage limits were reached' };
  }
  // Codex posts the clean verdict in two shapes: the issue-comment form
  // ("Codex Review: Didn't find any major issues. Breezy!") and — since the
  // 2026-07 format change — a submitted REVIEW OBJECT headed "### 💡 Codex
  // Review" with the verdict sentence in its body (content PRs #394–#399
  // received only review-object rounds, no issue comments at all). Both
  // markers must appear in the SAME artifact body: testing the joined
  // latestBody would let a findings review ("Codex Review …suggestions")
  // plus an unrelated comment mentioning the verdict sentence combine into
  // a false clean and authorize an auto-merge.
  // …and only the NEWEST eligible artifact across both types renders the
  // verdict: accepting either artifact independently would let a stale
  // commit-pinned clean review (eligible regardless of the latest re-request
  // timestamp) override a newer findings round delivered as an issue
  // comment, and auto-merge past live findings.
  const cleanVerdictIn = (body) => /Codex Review/i.test(String(body || ''))
    && /Didn'?t find any major issues/i.test(String(body || ''));
  const newestArtifact = [
    { body: codexComments.at(-1)?.body, at: Date.parse(codexComments.at(-1)?.created_at || codexComments.at(-1)?.createdAt || 0) || 0 },
    { body: codexReviews.at(-1)?.body, at: Date.parse(codexReviews.at(-1)?.submitted_at || codexReviews.at(-1)?.submittedAt || 0) || 0 },
  ].filter((a) => a.body).sort((a, b) => b.at - a.at)[0];
  // …and it must POSTDATE the latest same-head review request: a commit-
  // pinned review stays eligible regardless of requestedAt, so after a
  // same-head re-request an old clean review would otherwise authorize the
  // merge before the requested round ever responds (same strictly-after
  // posture as codexRoundCompleted).
  if (newestArtifact && cleanVerdictIn(newestArtifact.body)
    && (!requestedAt || newestArtifact.at > requestedAt)) return { clean: true };
  if (/approved/i.test(String(codexReviews.at(-1)?.state || ''))) return { clean: true };
  if (headSha && !requestedAt) return { clean: false, reason: 'Codex review has not been requested for the current PR head' };
  return { clean: false, reason: 'Codex review is required before merging this Astro PR' };
}

// A body "matches" the head when it embeds the full SHA or any abbreviated
// SHA (≥7 hex chars) that is a prefix of it. Codex's clean verdict arrives
// as an ISSUE COMMENT embedding a 10-char "Reviewed commit:" SHA (no review
// object), while this matcher previously demanded the first 12 chars — so
// every comment-only clean verdict was ineligible and the poller sat at
// codex_review_pending forever (astro PR #357 stalled >1h fully green).
function bodyMatchesHead(body, headSha) {
  const head = String(headSha || '').trim().toLowerCase();
  if (!head) return false;
  const text = String(body || '');
  if (text.toLowerCase().includes(head)) return true;
  const runs = text.match(/\b[0-9a-f]{7,40}\b/gi) || [];
  return runs.some((run) => head.startsWith(run.toLowerCase()));
}

// Only HUMAN/engine comments are review requests. Codex's own verdict comment
// ends with an "About Codex in GitHub" footer that literally reads
// `Comment "@codex review"` and embeds the reviewed SHA — so without this
// exclusion the clean verdict was counted as a same-head re-request that it
// could never strictly postdate, and every astro PR sat at
// codex_review_pending forever (#472–#476, 2026-08-23).
function latestReviewRequestAt(comments = [], headSha = null) {
  const head = String(headSha || '').trim();
  const candidates = comments
    .filter((comment) => !isCodexAuthor(comment?.user?.login || comment?.author?.login))
    .filter((comment) => /@codex\s+review/i.test(String(comment?.body || '')))
    .filter((comment) => !head || bodyMatchesHead(comment.body, head))
    .map((comment) => Date.parse(comment.created_at || comment.createdAt || 0))
    .filter(Number.isFinite)
    .sort((a, b) => b - a);
  return candidates[0] || null;
}

function codexReviewMatchesHead(review, headSha) {
  const head = String(headSha || '').trim();
  if (!head) return false;
  const commit = String(review?.commit_id || review?.commit?.oid || '').trim();
  return commit && commit === head;
}

function reviewEligibleForHead(review, { headSha = null, requestedAt = null } = {}) {
  const commit = String(review?.commit_id || review?.commit?.oid || '').trim();
  if (headSha && commit) return codexReviewMatchesHead(review, headSha);
  if (headSha) return false;
  if (!requestedAt) return true;
  return Date.parse(review.submitted_at || review.submittedAt || 0) >= requestedAt;
}

function commentEligibleForHead(comment, { headSha = null, requestedAt = null } = {}) {
  const head = String(headSha || '').trim();
  if (head) {
    if (!requestedAt) return false;
    if (!bodyMatchesHead(comment?.body, head)) return false;
  }
  if (headSha && !requestedAt) return false;
  if (!requestedAt) return true;
  return Date.parse(comment.created_at || comment.createdAt || 0) >= requestedAt;
}

function isCodexAuthor(login) {
  const value = String(login || '').toLowerCase();
  return value === 'chatgpt-codex-connector' || value === 'chatgpt-codex-connector[bot]';
}

module.exports = {
  publishAstro,
  publishOrUpdatePage,
  publishMetadataRewrite,
  publishRefresh,
  getLiveFrontmatter,
  isBlogTarget,
  loadExistingPageBody,
  resolveExistingAstroFileForTarget,
  canPublishDraftBrief,
  canPublishMetadataRewrite,
  canPublishRefresh,
  mergeAstro,
  unpublishAstro,
  buildFrontmatter,
  liveUrlForPost,
  // Reused by the autonomous PR-lifecycle poller (no blog_posts row exists
  // for autonomous publishes, so it drives these directly).
  planInternalLinksForTarget,
  internalLinkPlanningDisabled,
  assertCodexReviewClear,
  // Merge-time body-image contract for the autonomous PR poller.
  assertBodyImagesAtHead,
  // Length clamps reused by the autonomous runner to normalize a draft's
  // title/meta BEFORE the quality gate (the gate runs before publish, so the
  // in-publisher normalization above is too late to salvage a length overshoot).
  clampTitle,
  clampMetaDescription,
  _internals: {
    generateHeroBuffer,
    compressToWebp,
    resolveAutonomousHero,
    resolveBodyImages,
    bodyImageSlots,
    insertBodyImages,
    countBodyImages,
    bodyImageRefs,
    validateBodyImageRefs,
    scanBodySections,
    renderedBodyView,
    imageRefsInText,
    assertBodyImagesAtHead,
    legacyHeroRefs,
    imageDHash,
    hammingDistance,
    committedImageBuffer,
    assertDistinctPictures,
    BODY_IMAGE_SHOTS,
    NEAR_DUPLICATE_MAX_DISTANCE,
    reusableLiveBodyImage,
    BODY_IMAGE_MIN,
    fetchImageBuffer,
    parseImageDataUrl,
    defaultHeroForCategory,
    describeHeroFailure,
    inferServiceAreas,
    backfillLegacyBlogRequiredFields,
    isFleetCanonicalHost,
    stampAutonomousHero,
    heroAltForDraft,
    verifiedCommittedHeroSrc,
    applyMergeEffect,
    queueInternalLinkPlanning,
    internalLinkPlanningDisabled,
    planInternalLinksForMergedPost,
    planInternalLinksForTarget,
    isCommittedHeroUrl,
    absoluteHeroUrl,
    slugPathFromFrontmatter,
    categoryRouteSlug,
    slugLeafOf,
    canonicalUrlForSlug,
    assertCanonicalMatchesSlug,
    clampMetaDescription,
    clampTitle,
    clampDateToToday,
    normalizeAutonomousBlogFrontmatter,
    normalizeAuthorBlock,
    buildDraftPrBody,
    buildMetadataPrBody,
    buildRefreshPrBody,
    buildSeoReviewSection,
    urlToAstroPath,
    publicPathFromAstroFile,
    canonicalForExistingPage,
    codexReviewStatus,
    latestReviewRequestAt,
    codexReviewMatchesHead,
    reviewEligibleForHead,
    commentEligibleForHead,
    isCodexAuthor,
    contentHasFaqSection,
    schemaTypesForContent,
    resolveSpokeTarget,
    blogOriginForSpoke,
    stampBlogDomains,
    stampHubOnlyBlogDomains,
    assertOpenPublishPrIsHubOnly,
    syncDraftPublishTarget,
    mdxBreakingToken,
    normalizeAutonomousCategory,
  },
};
