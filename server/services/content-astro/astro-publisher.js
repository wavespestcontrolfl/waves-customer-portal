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

const ASTRO_BLOG_DIR = 'src/content/blog';
const ASTRO_HERO_DIR = 'public/images/blog';

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
  const hub = process.env.ASTRO_HUB_ORIGIN || 'https://www.wavespestcontrol.com';
  const canonical = `${hub}/${slug}/`;

  const heroRef = post.featured_image_url
    ? (post.featured_image_url.startsWith('/images/blog/')
        ? post.featured_image_url
        : `${ASTRO_HERO_PUBLIC_BASE}/${slug}/hero.${post.hero_image_ext || imageExtFromSource(post.featured_image_url)}`)
    : null;
  const technicallyReviewedDate = dateOnly(post.technically_reviewed_at);
  const factCheckedDate = dateOnly(post.fact_checked_at);

  const data = {
    schemaVersion: 2,
    title: post.title,
    slug: `/${slug}/`,
    meta_description: post.meta_description || '',
    primary_keyword: post.keyword || undefined,
    secondary_keywords: undefined,
    category: post.category || undefined,
    post_type: post.post_type || 'article',
    service_areas_tag: Array.isArray(post.service_areas_tag) ? post.service_areas_tag
      : (post.service_areas_tag ? safeJson(post.service_areas_tag, []) : undefined),
    related_services: Array.isArray(post.related_services) ? post.related_services
      : (post.related_services ? safeJson(post.related_services, []) : undefined),
    // Per-post spoke targeting. Written as `domains` to match the existing
    // Astro convention — src/pages/[...slug].astro already has a
    // `domainMatches()` filter that reads this field. Absent/empty keeps
    // the astro defaults ("hub sees it, spokes don't") so old posts that
    // never set target_sites keep their current behavior on the detail
    // route. The list route (src/pages/blog.astro) is being updated in a
    // matching commit in the astro repo to honor `domains` too.
    domains: Array.isArray(post.target_sites) && post.target_sites.length > 0
      ? post.target_sites
      : (post.target_sites
          ? (safeJson(post.target_sites, []).length > 0 ? safeJson(post.target_sites, []) : undefined)
          : undefined),
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
    schema_types: ['Article'],
    disclosure: { type: 'pricing-transparency' },
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

function estimateReadingTime(text) {
  if (!text) return 3;
  const words = String(text).split(/\s+/).length;
  return Math.max(1, Math.round(words / 220));
}

const ASTRO_HERO_PUBLIC_BASE = '/images/blog';

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

// ── Main publish ───────────────────────────────────────────────────

async function publishAstro(postId) {
  const post = await db('blog_posts').where({ id: postId }).first();
  if (!post) throw new Error(`blog_post ${postId} not found`);
  if (!post.title) throw new Error('post missing title');

  const slug = post.slug || slugify(post.title);
  const branch = `content/blog-${slug}-${shortId()}`;

  try {
    await gh.createBranch(branch);

    // 1. Hero image (optional) — only commit when the source isn't already in-repo.
    let heroImageExt = imageExtFromSource(post.featured_image_url);
    if (post.featured_image_url && !post.featured_image_url.startsWith('/images/blog/')) {
      const image = await fetchImageBuffer(post.featured_image_url);
      if (image?.buffer) {
        heroImageExt = image.ext || heroImageExt;
        await gh.putBinary({
          path: `${ASTRO_HERO_DIR}/${slug}/hero.${heroImageExt}`,
          buffer: image.buffer,
          message: `chore(blog): add hero image for ${slug}`,
          branch,
        });
      }
    }

    // 2. Markdown file
    const data = await buildFrontmatter({ ...post, slug, hero_image_ext: heroImageExt });
    const body = (post.content || '').trim();
    const markdown = fm.stringify(data, body + '\n');
    const filePath = `${ASTRO_BLOG_DIR}/${slug}.md`;

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

    // 3. PR
    const prBody = buildPrBody({ post, slug, branch, content: body });
    const pr = await gh.createPr({
      head: branch,
      title: `Blog: ${post.title}`.slice(0, 72),
      body: prBody,
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

// ── Merge (approval → prod) ────────────────────────────────────────

async function mergeAstro(postId) {
  const post = await db('blog_posts').where({ id: postId }).first();
  if (!post) throw new Error(`blog_post ${postId} not found`);
  if (!post.astro_pr_number) throw new Error('post has no open PR');

  const isUnpublish = post.astro_status === 'unpublish_pending';

  try {
    const pr = await gh.getPr(post.astro_pr_number);
    if (pr.merged) {
      await applyMergeEffect(postId, post, pr.merged_at ? new Date(pr.merged_at) : new Date(), isUnpublish, null);
      return { already_merged: true, pr_number: pr.number };
    }
    if (pr.state !== 'open') {
      throw new Error(`PR #${pr.number} is ${pr.state}, cannot merge`);
    }

    const result = await gh.mergePr(post.astro_pr_number, {
      method: 'squash',
      title: isUnpublish ? `Unpublish: ${post.title}`.slice(0, 72) : `Blog: ${post.title}`.slice(0, 72),
    });

    await applyMergeEffect(postId, post, new Date(), isUnpublish, result?.sha);

    logger.info(`[astro-publisher] merged PR #${post.astro_pr_number} for post ${postId}${isUnpublish ? ' (unpublish)' : ''}`);
    return { merged: true, pr_number: post.astro_pr_number, sha: result?.sha, unpublished: isUnpublish };
  } catch (err) {
    logger.error(`[astro-publisher] merge failed for ${postId}: ${err.message}`);
    await db('blog_posts').where({ id: postId }).update({
      astro_publish_error: err.message.slice(0, 1000),
      updated_at: new Date(),
    });
    throw err;
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
      updated_at: new Date(),
    });
    return;
  }
  await db('blog_posts').where({ id: postId }).update({
    astro_status: 'merged',
    astro_merged_at: mergedAt,
    astro_commit_sha: sha || post.astro_commit_sha,
    status: 'published',
    astro_live_url: `${process.env.ASTRO_HUB_ORIGIN || 'https://www.wavespestcontrol.com'}/${post.slug || slugify(post.title)}/`,
    astro_published_at: new Date(),
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

    const mdPath = `${ASTRO_BLOG_DIR}/${slug}.md`;
    const mdFile = await gh.getFile(mdPath);
    if (!mdFile) throw new Error(`markdown not found on main: ${mdPath}`);

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

function formatList(v) {
  if (!v) return '—';
  const arr = Array.isArray(v) ? v : safeJson(v, []);
  return arr.length ? arr.join(', ') : '—';
}

module.exports = { publishAstro, mergeAstro, unpublishAstro, buildFrontmatter };
