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
const { normalizeContentUrl } = require('../content/content-registry');
const { normalizeSpokeSites, SPOKE_SITE_KEYS } = require('./spoke-sites');

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

const POST_CATEGORIES = new Set(['pest-control', 'lawn-care', 'termite', 'mosquito', 'tree-shrub', 'seasonal']);
const POST_TYPES = new Set(['diagnostic', 'seasonal', 'by-grass-type', 'protocol', 'cost', 'comparison', 'case-study', 'location', 'decision']);
const SERVICE_AREAS = new Set(['Bradenton', 'Lakewood Ranch', 'Sarasota', 'Venice', 'North Port', 'Palmetto', 'Parrish', 'Port Charlotte']);

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

  const today = (post.publish_date ? new Date(post.publish_date) : new Date()).toISOString().slice(0, 10);
  const hub = (process.env.ASTRO_HUB_ORIGIN || 'https://www.wavespestcontrol.com').replace(/\/$/, '');
  const canonical = `${hub}/${slug}/`;

  const heroRef = post.featured_image_url
    ? (post.featured_image_url.startsWith('/images/blog/')
        ? post.featured_image_url
        : `${ASTRO_HERO_PUBLIC_BASE}/${slug}/hero.${post.hero_image_ext || imageExtFromSource(post.featured_image_url)}`)
    : null;
  const technicallyReviewedDate = dateOnly(post.technically_reviewed_at);
  const factCheckedDate = dateOnly(post.fact_checked_at);
  const serviceAreas = normalizeServiceAreas(post.service_areas_tag, post.city);
  const targetSites = normalizeTargetSites(post.target_sites);
  const relatedServices = normalizeArray(post.related_services);
  // Automated blog posts (idea generator / demand miner / content calendar)
  // target the hub only — they're general SWFL educational content, not
  // spoke-domain material. Without an explicit target the empty-list default
  // would fan them across every spoke domain, so pin automated, untargeted
  // posts to wavespestcontrol.com. Manually-authored posts keep the existing
  // empty-means-astro-default behavior (so the "publish to all domains" option
  // still works for hand-curated content).
  const AUTOMATED_BLOG_SOURCES = new Set(['ai_generated', 'demand_mined', 'calendar']);
  const effectiveTargets = targetSites.length > 0
    ? targetSites
    : (AUTOMATED_BLOG_SOURCES.has(post.source) ? ['wavespestcontrol.com'] : []);
  const domains = effectiveTargets.length > 0 ? effectiveTargets : undefined;

  const data = {
    title: post.title,
    slug: `/${slug}/`,
    meta_description: post.meta_description || '',
    primary_keyword: post.keyword || undefined,
    secondary_keywords: normalizeArray(post.secondary_keywords),
    category: normalizeCategory(post.category, post.tag),
    post_type: normalizePostType(post.post_type),
    service_areas_tag: serviceAreas.length > 0 ? serviceAreas : undefined,
    related_services: relatedServices,
    spoke_links: normalizeArray(post.spoke_links),
    // Per-post spoke targeting. Written as `domains` to match the existing
    // Astro convention — src/pages/[...slug].astro already has a
    // `domainMatches()` filter that reads this field. Absent/empty keeps
    // the astro defaults ("hub sees it, spokes don't") so old posts that
    // never set target_sites keep their current behavior on the detail
    // route. The list route (src/pages/blog.astro) is being updated in a
    // matching commit in the astro repo to honor `domains` too.
    domains,
    author: author ? {
      name: author.name,
      role: author.role,
      fdacs_license: author.fdacs_license || undefined,
      years_swfl: author.years_swfl || undefined,
      bio_url: author.bio_url,
    } : undefined,
    technically_reviewed_by: reviewer ? {
      name: reviewer.name,
      credential: (reviewer.credentials && reviewer.credentials[0]) || reviewer.role,
      fdacs_license: reviewer.fdacs_license || undefined,
      bio_url: reviewer.bio_url,
    } : undefined,
    fact_checked_by: post.fact_checked_by || undefined,
    published: today,
    updated: today,
    technically_reviewed: reviewer && technicallyReviewedDate ? technicallyReviewedDate : undefined,
    fact_checked: post.fact_checked_by && factCheckedDate ? factCheckedDate : undefined,
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
    tracking: domains ? { domains } : undefined,
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
    .filter(Boolean)));
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

function dateOnly(value) {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
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

async function fetchImageBuffer(url) {
  if (!url) return null;
  // In-repo path — nothing to fetch, already committed.
  if (url.startsWith('/images/blog/')) return null;
  const dataMatch = String(url).match(/^data:(image\/[a-z0-9.+-]+);base64,(.+)$/i);
  if (dataMatch) {
    return {
      buffer: Buffer.from(dataMatch[2], 'base64'),
      ext: imageExtFromMime(dataMatch[1].toLowerCase()),
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
async function compressToWebp(buffer) {
  const sharp = require('sharp');
  return sharp(buffer)
    // Bake EXIF orientation into pixels before stripping metadata — a curated
    // phone/camera JPEG with an Orientation tag would otherwise serve sideways.
    .rotate()
    .resize({ width: 1600, withoutEnlargement: true })
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
  const img = await fetchImageBuffer(gen.dataUrl);
  if (!img?.buffer) throw new Error('hero image generation produced no usable image');
  logger.info(`[astro-publisher] generated hero image for ${post.slug || post.title} via ${gen.model}`);
  return img;
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
  // live/merged/draft/publish_failed have no open PR to orphan (the existing-
  // file SHA path handles in-place updates), so they fall through.
  if (post.astro_status === 'pr_open' || post.astro_status === 'unpublish_pending') {
    throw new Error(
      `cannot publish post ${postId}: an Astro PR is already in flight (status "${post.astro_status}"`
      + `${post.astro_pr_number ? `, PR #${post.astro_pr_number}` : ''}); merge or unpublish it before republishing`,
    );
  }
  if (post.astro_status === 'build_failed' && (post.astro_pr_number || post.astro_branch_name)) {
    await cleanupStaleAstroPr(post);
  }

  const slug = post.slug || slugify(post.title);
  const branch = `content/blog-${slug}-${shortId()}`;

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
      heroImage = await fetchImageBuffer(post.featured_image_url);
      if (!heroImage?.buffer) throw new Error('featured image could not be fetched for Astro publish');
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
      heroImage = { buffer: await compressToWebp(heroImage.buffer), ext: 'webp' };
    }
    const heroImageExt = heroImage?.buffer ? 'webp' : imageExtFromSource(post.featured_image_url);

    // Public path the frontmatter references. Whenever we have bytes to commit
    // they land at /images/blog/<slug>/hero.webp; a /images/blog/ value is
    // already committed from a prior (merged) publish.
    const heroPublicRef = heroImage?.buffer
      ? `${ASTRO_HERO_PUBLIC_BASE}/${slug}/hero.webp`
      : (post.featured_image_url || null);

    // 2. Markdown frontmatter/body validation
    const data = await buildFrontmatter({ ...post, slug, hero_image_ext: heroImageExt, featured_image_url: heroPublicRef });
    assertValidBlogFrontmatter(data);
    const body = (post.content || '').trim();

    // 2b. Content-policy guardrails (hardcoded price, brand-token leak on
    // multi-domain blogs, FAQ on a policy-blocked service, keyword stuffing).
    // The autonomous engine runs these before publishing; the legacy BlogWriter
    // → publish-astro path (admin + the blog-calendar cron) previously had only
    // schema validation, so a generated post could ship "$39/month" or a
    // spoke-domain brand leak with nothing but the prompt stopping it. Block
    // P0/P1 here too — body + editable meta are checked.
    // target_sites semantics: a non-empty list targets those domains, but an
    // EMPTY/null list renders on ALL spoke domains (backward-compat — see the
    // target_sites migration + admin "publish to ALL 15 domains" warning).
    // buildFrontmatter omits data.domains when target_sites is empty, so expand
    // that to the full spoke list here — otherwise the brand-token guard would
    // wrongly treat an all-domains post as hub-only and let a literal-brand leak
    // ship to every spoke. (New posts default to hub-only targeting, so this
    // mainly catches legacy/cleared rows — exactly the multi-domain case.)
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
      },
    );
    if (!guardrails.pass) {
      const blocking = guardrails.findings.filter((f) => f.severity === 'P0' || f.severity === 'P1');
      const gErr = new Error(`content guardrails failed: ${blocking.map((f) => `${f.severity} ${f.code}`).join('; ')}`);
      gErr.code = 'BLOG_GUARDRAILS_FAILED';
      gErr.details = blocking;
      throw gErr;
    }

    const markdown = fm.stringify(data, body + '\n');
    const filePath = `${ASTRO_BLOG_DIR}/${slug}.md`;

    await gh.createBranch(branch);

    if (heroImage?.buffer) {
      const heroPath = `${ASTRO_HERO_DIR}/${slug}/hero.${heroImageExt}`;
      const existingHero = await gh.getFile(heroPath);
      await gh.putBinary({
        path: heroPath,
        buffer: heroImage.buffer,
        message: `chore(blog): add hero image for ${slug}`,
        branch,
        sha: existingHero ? existingHero.sha : undefined,
      });
    }

    // 3. Markdown file
    // If the file already exists on main (republish), pass its SHA so the
    // branch commit is an update instead of a conflict.
    const existing = await gh.getFile(filePath);
    const fileCommit = await gh.putFile({
      path: filePath,
      content: markdown,
      message: `feat(blog): publish ${slug}`,
      branch,
      sha: existing ? existing.sha : undefined,
    });

    // 4. PR
    const prBody = buildPrBody({ post, slug, branch, content: body });
    const pr = await gh.createPr({
      head: branch,
      title: `Blog: ${post.title}`.slice(0, 72),
      body: prBody,
    });
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
    await db('blog_posts').where({ id: postId }).update({
      astro_status: 'publish_failed',
      astro_publish_error: err.message.slice(0, 1000),
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
async function resolveExistingAstroFile(pathOrBase) {
  if (!pathOrBase) return null;
  const base = String(pathOrBase).replace(/\.mdx?$/, '');
  // Only blog posts migrate to .mdx (so they can use MDX components); service
  // and location pages stay .md, so don't waste a lookup or change their path.
  const exts = isBlogTarget(`${base}.md`) ? ['.mdx', '.md'] : ['.md'];
  for (const ext of exts) {
    const file = await gh.getFile(`${base}${ext}`);
    if (file) return { path: `${base}${ext}`, file };
  }
  return null;
}

async function resolveExistingAstroFileForTarget(targetUrlOrPath) {
  const target = /^src\/content\//.test(String(targetUrlOrPath || '')) ? targetUrlOrPath : urlToAstroPath(targetUrlOrPath);
  if (target) {
    const resolved = await resolveExistingAstroFile(target);
    if (resolved) return resolved;
  }

  const registryPath = await registryAstroPathForTarget(targetUrlOrPath);
  if (registryPath && registryPath !== target) {
    const resolved = await resolveExistingAstroFile(registryPath);
    if (resolved) return resolved;
  }

  return null;
}

async function registryAstroPathForTarget(targetUrlOrPath) {
  if (!targetUrlOrPath || /^src\/content\//.test(String(targetUrlOrPath))) return null;
  const lookup = registryLookupValuesForUrl(targetUrlOrPath);
  if (!lookup.exact.length) return null;

  const exact = await registryAstroPathForLiveUrl(lookup.exact);
  if (exact) return exact;
  if (lookup.host && lookup.pathOnly) {
    const hostedPath = await registryAstroPathForLiveUrl([lookup.pathOnly], { requiredHost: lookup.host });
    if (hostedPath) return hostedPath;
  }
  return registryAstroPathForCanonicalUrl(lookup.exact, { requiredHost: lookup.host });
}

async function registryAstroPathForLiveUrl(liveUrlValues, { requiredHost = null } = {}) {
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
    logger.warn(`[astro-publisher] content registry path lookup failed for ${liveUrlValues[0]}: ${err.message}`);
    return null;
  }
}

async function registryAstroPathForCanonicalUrl(urlValues, { requiredHost = null } = {}) {
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
    logger.warn(`[astro-publisher] content registry canonical lookup failed for ${urlValues[0]}: ${err.message}`);
    return null;
  }
}

async function publishOrUpdatePage(draft, brief = {}) {
  if (!canPublishDraftBrief(draft, brief)) {
    throw new Error(`unsupported autonomous draft for Astro publish: ${brief.action_type || 'unknown'}`);
  }

  const frontmatter = { ...(draft.frontmatter || {}) };
  assertValidBlogFrontmatter(frontmatter);

  const slug = slugPathFromFrontmatter(frontmatter);
  const canonical = assertCanonicalMatchesSlug(frontmatter, slug);
  const branchSlug = slugify(slug.replace(/\//g, '-'));
  const branch = `content/autonomous-${branchSlug}-${shortId()}`;
  const body = String(draft.body || '').trim();
  frontmatter.schema_types = schemaTypesForContent(body, frontmatter.schema_types);
  const markdown = fm.stringify(frontmatter, `${body}\n`);
  // New autonomous posts are written as .mdx so they can embed MDX infographic
  // components. If a post already exists as .mdx, update it in place. If a
  // LEGACY .md post exists at this slug, MIGRATE it to .mdx (the body may carry
  // MDX-only components that would render broken in a .md file): write the
  // .mdx and delete the stale .md in the same branch — never leave both.
  const existingFile = await resolveExistingAstroFile(`${ASTRO_BLOG_DIR}/${slug}`);
  const isLegacyMd = !!existingFile && existingFile.path.endsWith('.md');
  const filePath = existingFile && !isLegacyMd ? existingFile.path : `${ASTRO_BLOG_DIR}/${slug}.mdx`;

  await gh.createBranch(branch);
  const fileCommit = await gh.putFile({
    path: filePath,
    content: markdown,
    message: `feat(blog): publish ${slug}`,
    branch,
    sha: existingFile && !isLegacyMd ? existingFile.file.sha : undefined,
  });
  if (isLegacyMd) {
    await gh.deleteFile({
      path: existingFile.path,
      message: `chore(blog): migrate ${slug} to .mdx`,
      branch,
      sha: existingFile.file.sha,
    });
  }

  const pr = await gh.createPr({
    head: branch,
    title: `Blog: ${frontmatter.title}`.slice(0, 72),
    body: buildDraftPrBody({ frontmatter, slug, branch, content: body, brief }),
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
  const nextFrontmatter = {
    ...currentFrontmatter,
    title: newTitle,
    meta_description: newMeta,
  };

  // Bump the freshness field the live page already uses (services: `modified`;
  // blog v2: `updated`) so sitemap lastmod updates and Google recrawls the
  // rewritten title/meta — these are high-SEO-value edits. Only when something
  // actually changed; mirrors publishRefresh and avoids fake-freshness churn.
  if (newTitle !== String(currentFrontmatter.title || '').trim()
    || newMeta !== String(currentFrontmatter.meta_description || '').trim()) {
    const today = dateOnly(new Date());
    if (currentFrontmatter.modified !== undefined) nextFrontmatter.modified = `${today}T12:00:00`;
    else if (currentFrontmatter.updated !== undefined) nextFrontmatter.updated = today;
  }

  // Blog targets must stay schema-valid after a metadata rewrite (e.g.
  // meta_description 115-160). Non-blog pages use a different contract.
  if (isBlogTarget(filePath)) assertValidBlogFrontmatter(nextFrontmatter);

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
    title: `SEO metadata: ${nextFrontmatter.title}`.slice(0, 72),
    body: buildMetadataPrBody({
      filePath,
      targetUrl,
      branch,
      before: currentFrontmatter,
      after: nextFrontmatter,
      brief,
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
  for (const field of REFRESH_EDITABLE_META_FIELDS) {
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
  const today = dateOnly(new Date());
  if (currentFrontmatter.modified !== undefined) nextFrontmatter.modified = `${today}T12:00:00`;
  else if (currentFrontmatter.updated !== undefined) nextFrontmatter.updated = today;

  // Blog targets must stay schema-valid after a refresh (meta_description
  // 115-160, required fields intact). The merge only overrides fields that
  // already exist on the live page, so a valid blog post stays valid unless the
  // agent produced an out-of-bounds title/meta — which this gate now blocks
  // before a PR is ever opened. Non-blog pages use a different contract.
  if (isBlogTarget(filePath)) assertValidBlogFrontmatter(nextFrontmatter);

  const markdown = fm.stringify(nextFrontmatter, `${newBody}\n`);

  const branchSlug = slugify(filePath.replace(/^src\/content\//, '').replace(/\.mdx?$/, '').replace(/\//g, ' '));
  const branch = `content/refresh-${branchSlug}-${shortId()}`;
  await gh.createBranch(branch);
  const fileCommit = await gh.putFile({
    path: filePath,
    content: markdown,
    message: `feat(content): refresh ${publicPathFromAstroFile(filePath)}`,
    branch,
    sha: existing.sha,
  });

  const pr = await gh.createPr({
    head: branch,
    title: `Refresh: ${nextFrontmatter.title || nextFrontmatter.metaTitle || publicPathFromAstroFile(filePath)}`.slice(0, 72),
    body: buildRefreshPrBody({ filePath, targetUrl, branch, before: currentFrontmatter, after: nextFrontmatter, oldBody, newBody, brief }),
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
  return fm.parse(resolved.file.content).data || {};
}

/**
 * Load the live page BODY (markdown after the frontmatter) for a refresh
 * improvement comparison. Returns { body, word_count } on success, or NULL
 * when the target can't be resolved or the file can't be read — callers fail
 * closed (the content-quality gate's improvement_over_prior check refuses to
 * publish a refresh without a prior version to compare against).
 */
async function loadExistingPageBody(targetUrlOrPath) {
  const resolved = await resolveExistingAstroFileForTarget(targetUrlOrPath);
  if (!resolved) return null;
  const body = fm.parse(resolved.file.content).content || '';
  const word_count = body.split(/\s+/).filter(Boolean).length;
  return { body, word_count };
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

async function mergeAstro(postId) {
  const post = await db('blog_posts').where({ id: postId }).first();
  if (!post) throw new Error(`blog_post ${postId} not found`);
  if (!post.astro_pr_number) throw new Error('post has no open PR');

  const isUnpublish = post.astro_status === 'unpublish_pending';

  try {
    const pr = await gh.getPr(post.astro_pr_number);
    if (pr.merged) {
      await applyMergeEffect(postId, post, pr.merged_at ? new Date(pr.merged_at) : new Date(), isUnpublish, pr.merge_commit_sha || null);
      return { already_merged: true, pr_number: pr.number, live_url: isUnpublish ? null : liveUrlForPost(post) };
    }
    if (pr.state !== 'open') {
      throw new Error(`PR #${pr.number} is ${pr.state}, cannot merge`);
    }
    await assertCodexReviewClear(pr.number, { headSha: pr.head?.sha });

    const result = await gh.mergePr(post.astro_pr_number, {
      method: 'squash',
      title: isUnpublish ? `Unpublish: ${post.title}`.slice(0, 72) : `Blog: ${post.title}`.slice(0, 72),
    });

    await applyMergeEffect(postId, post, new Date(), isUnpublish, result?.sha);

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
      // The revert PR deleted the hero from the repo, so drop the stale
      // path — a future republish regenerates/recommits.
      featured_image_url: null,
      updated_at: new Date(),
    });
    return;
  }
  const slug = post.slug || slugify(post.title);
  // Persist the now-live hero path ONLY at merge — the asset exists on main
  // exactly now. Persisting earlier (at PR open) would point downstream
  // consumers (auto social-share, republish) at a file that lives only on a
  // PR branch and vanishes if the build fails and the branch is deleted.
  //
  // Read the authoritative path straight from the merged frontmatter rather
  // than assuming an extension: a PR opened by the new code committed
  // hero.webp, but one opened by the OLD path (still in flight when this
  // deploys) committed hero.png/.jpg, and guessing webp would record a broken
  // path. Fall back to the existing committed path, then to hero.webp.
  const rawHeroRef =
    (await mergedHeroRef(slug))
    || (isCommittedHeroUrl(post.featured_image_url) ? post.featured_image_url : null)
    || `${ASTRO_HERO_PUBLIC_BASE}/${slug}/hero.webp`;
  // Store an ABSOLUTE hub URL for DB/admin/social consumers; the relative
  // /images/blog path only resolves on the Astro site, not the portal origin.
  const heroRef = absoluteHeroUrl(rawHeroRef);
  await db('blog_posts').where({ id: postId }).update({
    astro_status: 'merged',
    astro_merged_at: mergedAt,
    astro_commit_sha: sha || post.astro_commit_sha,
    status: 'published',
    astro_live_url: liveUrlForPost(post),
    astro_published_at: null,
    featured_image_url: heroRef,
    updated_at: new Date(),
  });
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
  const targets = normalizeTargetSites(post.target_sites);
  const firstTarget = targets[0] || 'wavespestcontrol.com';
  const origin = firstTarget === 'wavespestcontrol.com'
    ? (process.env.ASTRO_HUB_ORIGIN || 'https://www.wavespestcontrol.com')
    : `https://${firstTarget}`;
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

function buildMetadataPrBody({ filePath, targetUrl, branch, before = {}, after = {}, brief = {} }) {
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
    `| title | ${markdownTableCell(before.title)} | ${markdownTableCell(after.title)} |`,
    `| meta_description | ${markdownTableCell(before.meta_description)} | ${markdownTableCell(after.meta_description)} |`,
    ``,
    `Body, slug, canonical, and schema are intentionally unchanged.`,
    ``,
    `Generated by waves-customer-portal autonomous runner. Merge after review.`,
    ``,
    `Branch: \`${branch}\``,
  ].join('\n');
}

function buildRefreshPrBody({ filePath, targetUrl, branch, before = {}, after = {}, oldBody = '', newBody = '', brief = {} }) {
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
    `**Frozen (unchanged):** canonical, slug, schema, domains, trackingNumberKey, cityPhone, pageType, category, robots, ogImage — all preserved from the live page. Only body + meta + freshness date changed.`,
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

function canonicalUrlForSlug(slug) {
  const hub = (process.env.ASTRO_HUB_ORIGIN || 'https://www.wavespestcontrol.com').replace(/\/$/, '');
  return `${hub}/${slug}/`;
}

function normalizeCanonicalPath(pathname) {
  return `/${String(pathname || '').replace(/^\/+|\/+$/g, '')}/`;
}

function assertCanonicalMatchesSlug(frontmatter, slug) {
  const expected = canonicalUrlForSlug(slug);
  const supplied = String(frontmatter?.canonical || '').trim();
  let suppliedUrl;
  let expectedUrl;
  try {
    suppliedUrl = new URL(supplied);
    expectedUrl = new URL(expected);
  } catch {
    throw new Error('autonomous draft canonical is not a valid URL');
  }
  if (
    suppliedUrl.origin !== expectedUrl.origin
    || normalizeCanonicalPath(suppliedUrl.pathname) !== normalizeCanonicalPath(expectedUrl.pathname)
  ) {
    throw new Error(`autonomous draft canonical must match slug ${frontmatter.slug}`);
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
  if (/Codex Review:\s*Didn'?t find any major issues/i.test(latestBody)) return { clean: true };
  if (/approved/i.test(String(codexReviews.at(-1)?.state || ''))) return { clean: true };
  if (headSha && !requestedAt) return { clean: false, reason: 'Codex review has not been requested for the current PR head' };
  return { clean: false, reason: 'Codex review is required before merging this Astro PR' };
}

function latestReviewRequestAt(comments = [], headSha = null) {
  const head = String(headSha || '').trim();
  const shortHead = head.slice(0, 12);
  const candidates = comments
    .filter((comment) => /@codex\s+review/i.test(String(comment?.body || '')))
    .filter((comment) => !head || String(comment.body || '').includes(head) || (shortHead && String(comment.body || '').includes(shortHead)))
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
    const body = String(comment?.body || '');
    const shortHead = head.slice(0, 12);
    if (!requestedAt) return false;
    if (!body.includes(head) && !(shortHead && body.includes(shortHead))) return false;
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
  loadExistingPageBody,
  canPublishDraftBrief,
  canPublishMetadataRewrite,
  canPublishRefresh,
  mergeAstro,
  unpublishAstro,
  buildFrontmatter,
  liveUrlForPost,
  _internals: {
    generateHeroBuffer,
    compressToWebp,
    slugPathFromFrontmatter,
    canonicalUrlForSlug,
    assertCanonicalMatchesSlug,
    buildDraftPrBody,
    buildMetadataPrBody,
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
  },
};
