/**
 * Content Scheduler Service
 *
 * Manages the content calendar — scheduling blog posts and social media posts,
 * and acting on them when their scheduled time arrives: a social post
 * publishes, and a blog post opens its Astro preview PR, which goes live when
 * an admin approves it.
 */

const db = require('../models/db');
const logger = require('./logger');
const MODELS = require('../config/models');
const { dispatchWithFallback } = require('./llm/call');
const { parseETDateTime, etDateString, addETDays } = require('../utils/datetime-et');

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

// Astro states the scheduled-publish consumer (processScheduledPosts) skips:
// a row in one of them, or carrying PR/branch markers, would be accepted and
// then never published (audit BLOG-03).
const SCHEDULE_BLOCKING_ASTRO = ['pr_open', 'build_failed', 'publish_failed', 'merged', 'live', 'unpublish_pending'];

function scheduleConflict(message) {
  const err = new Error(message);
  err.isOperational = true;
  err.statusCode = 409;
  return err;
}

// Why the consumer could not publish this row, or null when it can.
function scheduleRefusal(post) {
  if (post.publish_status === 'publishing') return 'Publishing has already started for this post.';
  if (post.astro_pr_number || post.astro_branch_name || SCHEDULE_BLOCKING_ASTRO.includes(post.astro_status)) {
    const pr = post.astro_pr_number ? ` (PR #${post.astro_pr_number})` : '';
    return `This post already has Astro state '${post.astro_status || 'pending'}'${pr}. Open it in the post editor instead.`;
  }
  if (!post.content) return 'This draft has no content to publish.';
  return null;
}

function parseScheduledTime(value, label) {
  const parsed = parseETDateTime(value);
  if (Number.isNaN(parsed.getTime())) throw new Error(`${label} is invalid`);
  return parsed;
}

// Only http(s) image URLs reach the publishers; anything else posts text-only.
function httpUrlOrNull(value) {
  const text = String(value || '').trim();
  try {
    const { protocol } = new URL(text);
    return protocol === 'http:' || protocol === 'https:' ? text : null;
  } catch {
    return null;
  }
}

// A weekly series post from the intake route (routes/social-series-ingest.js).
const SERIES_SOURCE_TYPE = 'series';

// A saved Social Studio campaign draft (Campaign Builder > Save Draft, SOC-01)
// waits at status 'draft' with no time until the Calendar gives it one.
const SAVED_DRAFT = { source_type: 'campaign_builder', status: 'draft', publish_status: 'pending' };

// An autonomous Studio run also saves its draft through saveCampaignDraft
// (social_content_studio_runs.social_media_post_id), but that draft posts only
// through its own guarded approval (approveAutonomousRun: review liveness,
// milestone, season and location checks, one shared claim). Never list or
// schedule it here, or an approval could post it a second time.
function notAutonomousRunDraft(query) {
  return query.whereNotIn('id', db('social_content_studio_runs')
    .whereNotNull('social_media_post_id')
    .select('social_media_post_id'));
}

// Pre-publish, platforms_posted holds the REQUESTED channel list (strings, or
// {platform} objects once publishToAll has written results).
function storedChannels(platformsPosted) {
  let stored = platformsPosted;
  if (typeof stored === 'string') {
    try { stored = JSON.parse(stored); } catch { stored = null; }
  }
  return Array.isArray(stored)
    ? stored.map((p) => (typeof p === 'string' ? p : p?.platform)).filter(Boolean)
    : [];
}

// A jsonb list column (node-pg parses it; a string is tolerated): an array, else null.
function storedList(value) {
  let stored = value;
  if (typeof stored === 'string') {
    try { stored = JSON.parse(stored); } catch { stored = null; }
  }
  return Array.isArray(stored) ? stored : null;
}

// Extra publishToAll options for the two kinds of stored row that carry their
// own media. A saved campaign draft: its own image, and never a fresh generated
// image in place of the saved one. A series post (routes/social-series-ingest.js,
// source_type 'series'): its hosted image or video, the same image as the GBP
// picture when the row asked for GBP, and the GBP locations it names
// (gbp_location_ids; none stored = every location). A real publish folds its results into the same row (postId: one
// History entry). A dry run does not: publishToAll would replace the REQUESTED
// channels in platforms_posted with results, and the next tick reads them; it
// records like a typed scheduled post instead. A saved draft takes no GBP image
// (GBP takes only an approved card), so it posts to GBP text-only. Every other
// scheduled row gets none and publishes exactly as before.
function storedPostOptions(social, { dryRun = false } = {}) {
  const postId = dryRun ? {} : { postId: social.id };
  if (social.source_type === SERIES_SOURCE_TYPE) {
    const imageUrl = httpUrlOrNull(social.image_url);
    const videoUrl = httpUrlOrNull(social.video_url);
    const gbpLocationIds = storedList(social.gbp_location_ids);
    // The image doubles as the GBP picture only on a row that asked for GBP:
    // the intake accepts only media the series job uploaded through /media
    // (its rendered cards), never another CDN object.
    const gbpImage = imageUrl && storedChannels(social.platforms_posted).includes('gbp');
    return {
      ...(imageUrl ? { imageUrl } : {}),
      ...(gbpImage ? { gbpImageUrl: imageUrl } : {}),
      ...(videoUrl ? { videoUrl } : {}),
      ...(gbpLocationIds ? { gbpLocationIds } : {}),
      noAiImage: true,
      ...postId,
    };
  }
  if (social.source_type !== SAVED_DRAFT.source_type) return {};
  const imageUrl = httpUrlOrNull(social.image_url);
  return { ...(imageUrl ? { imageUrl } : {}), noAiImage: true, ...postId };
}

function parseCalendarStart(value) {
  const text = String(value || '').trim();
  return parseScheduledTime(DATE_ONLY.test(text) ? `${text}T00:00` : text, 'startDate');
}

function parseCalendarEnd(value) {
  const text = String(value || '').trim();
  if (!DATE_ONLY.test(text)) return parseScheduledTime(text, 'endDate');
  const nextDay = etDateString(addETDays(parseETDateTime(`${text}T12:00`), 1));
  return parseScheduledTime(`${nextDay}T00:00`, 'endDate');
}

function normalizeCalendarRange(startDate, endDate) {
  const start = parseCalendarStart(startDate);
  const end = parseCalendarEnd(endDate);
  if (end <= start) throw new Error('endDate must be after startDate');
  return { start, end };
}

function dateColumnKey(value) {
  if (!value) return value;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  const text = String(value);
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(text);
  return match ? match[1] : text;
}

async function sharePublishedBlog(blog) {
  if (!blog.auto_share_social || blog.shared_to_social) return true;

  const { SOCIAL_FLAGS, isPausedByAdmin } = require('./social-media');
  if (!SOCIAL_FLAGS.automationEnabled) {
    logger.info(`[content-scheduler] Social share skipped for blog ${blog.id} — automation disabled`);
    return true;
  }
  if (await isPausedByAdmin()) {
    logger.info(`[content-scheduler] Social share skipped for blog ${blog.id} — paused by admin`);
    return false;
  }

  try {
    const SocialMediaService = require('./social-media');
    const link = blog.astro_live_url || blog.url || `https://www.wavespestcontrol.com/${blog.slug}`;
    // shareUrlOnce (not publishToAll directly): the advisory-lock +
    // source_url dedupe serializes this against the RSS backstop AND the
    // pages-poll live-flip share — two lanes can observe the same live row
    // in the same window and must not double-post. shareUrlOnce opts into
    // every platform incl. Twitter and runs publishToAll's blog-hero
    // resolve (og:image re-hosted as JPEG, brand-card fallback, never AI).
    const once = await SocialMediaService.shareUrlOnce({
      title: blog.title,
      description: blog.meta_description || (blog.content || '').replace(/[#*_\[\]]/g, '').substring(0, 300),
      link,
      source: 'blog_scheduled',
      noAiImage: true,
    });
    if (once?.skipped === 'already_posted') {
      // Same blocker distinction as the pages-poll live-flip path: only a
      // published/scheduled row means the URL definitively went out (stamp,
      // done). A studio DRAFT blocker means an admin has copy in flight for
      // this URL and NOTHING has posted — don't stamp; return false so the
      // caller parks the row at pending_review for the human who owns it.
      if (['published', 'scheduled'].includes(once.blocking_status)) {
        await db('blog_posts').where('id', blog.id).update({
          shared_to_social: true,
          shared_at: new Date(),
        });
        return true;
      }
      logger.info(`[content-scheduler] Social share for blog ${blog.id} blocked by a studio ${once.blocking_status || 'draft'} row for the same URL — leaving unshared for the admin to resolve`);
      return false;
    }
    if (once?.skipped) {
      logger.info(`[content-scheduler] Social share skipped for blog ${blog.id} — ${once.skipped}`);
      return true;
    }
    const result = once;
    if (result?.dryRun) {
      logger.info(`[content-scheduler] Social share dry-run for blog ${blog.id} — not marking as shared`);
      return true;
    }

    const platforms = Array.isArray(result?.platforms) ? result.platforms : [];
    const shared = result?.success || platforms.some((platform) => platform.success);

    if (!shared) {
      const failures = platforms
        .filter((platform) => !platform.success)
        .map((platform) => `${platform.platform || 'unknown'}:${platform.error || 'failed'}`)
        .join('; ');
      logger.warn(`[content-scheduler] Social share produced no successful platforms for blog ${blog.id}${failures ? `: ${failures}` : ''}`);
      return false;
    }

    await db('blog_posts').where('id', blog.id).update({
      shared_to_social: true,
      shared_at: new Date(),
    });
    return true;
  } catch (err) {
    logger.warn(`[content-scheduler] Social share failed for blog ${blog.id}: ${err.message}`);
    return true;
  }
}

// ── Newsletter → Social ────────────────────────────────────────────────

const NEWSLETTER_SOCIAL_FALLBACK = {
  facebook: (subject) =>
    `The latest Waves Newsletter is here: ${subject} — See what's happening from North Port to Tampa.`,
  instagram: () =>
    'The latest Waves Newsletter just dropped — local events across SW Florida. Link in bio. #WavesNewsletter #SWFL #SWFLevents',
  linkedin: () =>
    'The latest Waves Newsletter is live, featuring events and community highlights across Southwest Florida.',
};

// GBP posts go to each of the 4 Waves locations. Build per-location copy so
// the four profiles don't all post the same generic blast — name each area.
function gbpFallbackByLocation() {
  const { WAVES_LOCATIONS } = require('../config/locations');
  const out = {};
  for (const loc of WAVES_LOCATIONS) {
    out[loc.id] = `The latest Waves Newsletter is live — local events and weekend plans near ${loc.name}, all across SW Florida.`;
  }
  return out;
}

// Coerce whatever the model returned for `gbp` into a complete
// { [locationId]: caption } object — one entry per Waves location. Accepts a
// per-location object (preferred), a single string (legacy/uniform — ignored
// in favor of localized fallback), or nothing. Any missing/blank location is
// filled from gbpFallbackByLocation() so the social loop always has copy.
function normalizeGbpByLocation(gbp) {
  const { WAVES_LOCATIONS } = require('../config/locations');
  const fallback = gbpFallbackByLocation();
  const fromModel = gbp && typeof gbp === 'object' && !Array.isArray(gbp) ? gbp : {};
  const out = {};
  for (const loc of WAVES_LOCATIONS) {
    const v = fromModel[loc.id];
    out[loc.id] = typeof v === 'string' && v.trim() ? v.trim() : fallback[loc.id];
  }
  return out;
}

async function generateNewsletterSocialContent(send) {
  const safeSubject = String(send.subject || '').replace(/[\r\n]+/g, ' ').slice(0, 300);
  const safePreview = String(send.preview_text || '').replace(/[\r\n]+/g, ' ').slice(0, 500);

  const { WAVES_LOCATIONS } = require('../config/locations');
  const locationList = WAVES_LOCATIONS
    .map((l) => `  "${l.id}": ${l.name} (${l.area})`)
    .join('\n');

  // Structured-output contract (llm/call.js jsonSchema): one gbp caption per
  // location id; normalizeGbpByLocation still backfills an empty value.
  const jsonSchema = {
    type: 'object',
    additionalProperties: false,
    required: ['facebook', 'instagram', 'linkedin', 'gbp'],
    properties: {
      facebook: { type: 'string' },
      instagram: { type: 'string' },
      linkedin: { type: 'string' },
      gbp: {
        type: 'object',
        additionalProperties: false,
        required: WAVES_LOCATIONS.map((l) => l.id),
        properties: Object.fromEntries(WAVES_LOCATIONS.map((l) => [l.id, { type: 'string', description: `GBP post for ${l.name} (${l.area})` }])),
      },
    },
  };

  const response = await dispatchWithFallback(MODELS.TEXT_POLICIES.contentDraft, {
    laneId: 'content_misc',
    maxTokens: 800,
    jsonMode: true,
    jsonSchema,
    text: `Generate social media captions for Waves Pest Control's weekly local events guide "Waves Newsletter."
This is NOT a pest control post — it's a punchy, upbeat local events roundup for SW Florida (North Port to Tampa).
Tone: fun, local-guide energy. Light FOMO is good ("just dropped", "here's what's happening this week") but don't be spammy or clickbaity.

Newsletter subject: ${safeSubject}
Newsletter preview: ${safePreview}

Waves has these Google Business Profile locations. Each GBP post must feel local to THAT area — name or nod to the area so the four profiles don't all post the same blast:
${locationList}

Write these captions:
- facebook: 150-250 chars, conversational, 1-2 emojis, do NOT include any URL
- instagram: 150-300 chars before hashtags, end with 3-5 hashtags (#WavesNewsletter #SWFL #SWFLevents etc), do NOT include any URL
- linkedin: 100-200 chars, professional but fun community tone, do NOT include any URL
- gbp: one caption per location id above. Each is 80-150 chars, community-oriented, names/nods to THAT specific area, no hashtags, no URL.`,
  });
  if (!response.ok || !response.json) return null;
  const parsed = response.json;
  if (!parsed.facebook || !parsed.instagram || !parsed.linkedin) return null;
  // Always hand the social loop a complete per-location gbp object, filling
  // any area the model skipped (or a legacy single string) from fallback.
  parsed.gbp = normalizeGbpByLocation(parsed.gbp);
  return parsed;
}

async function sharePublishedNewsletter(send) {
  if (send.shared_to_social) return true;

  const { SOCIAL_FLAGS, isPausedByAdmin } = require('./social-media');
  if (!SOCIAL_FLAGS.automationEnabled || !SOCIAL_FLAGS.newsletterAutoshare) {
    logger.info(`[content-scheduler] Newsletter social share skipped for send ${send.id} — automation/newsletter flag disabled`);
    return true;
  }
  if (await isPausedByAdmin()) {
    logger.info(`[content-scheduler] Newsletter social share skipped for send ${send.id} — paused by admin`);
    return false;
  }

  if (!send.auto_share_social) {
    await db('newsletter_sends').where('id', send.id)
      .whereNot('social_share_status', 'skipped')
      .update({ social_share_status: 'skipped' });
    return true;
  }

  // Atomic claim — prevents double-posting from concurrent resume/retry paths.
  // Also recovers rows stranded in 'processing' for >5 min (process died mid-share).
  const STALE_PROCESSING_MS = 5 * 60 * 1000;
  const staleThreshold = new Date(Date.now() - STALE_PROCESSING_MS);

  const claimed = await db('newsletter_sends')
    .where({ id: send.id })
    .where('auto_share_social', true)
    .where('shared_to_social', false)
    .where((builder) =>
      builder
        .whereIn('social_share_status', ['pending', 'failed'])
        .orWhereNull('social_share_status')
        .orWhere((b) =>
          b.where('social_share_status', 'processing')
            .where('social_share_attempted_at', '<', staleThreshold),
        ),
    )
    .update({
      social_share_status: 'processing',
      social_share_attempted_at: new Date(),
    });

  if (!claimed) return true;

  if (!send.slug) {
    logger.warn(`[content-scheduler] Skipping social share; missing slug for newsletter send ${send.id}`);
    await db('newsletter_sends').where('id', send.id).update({ social_share_status: 'skipped' });
    return true;
  }

  try {
    const SocialMediaService = require('./social-media');
    const link = `https://www.wavespestcontrol.com/newsletter/archive/${send.slug}`;

    let customContent = null;
    try {
      customContent = await generateNewsletterSocialContent(send);
    } catch (err) {
      logger.warn(`[content-scheduler] Newsletter social content generation failed for send ${send.id}: ${err.message} — using fallback`);
    }

    if (!customContent) {
      customContent = {
        facebook: NEWSLETTER_SOCIAL_FALLBACK.facebook(send.subject || 'Waves Newsletter'),
        instagram: NEWSLETTER_SOCIAL_FALLBACK.instagram(),
        linkedin: NEWSLETTER_SOCIAL_FALLBACK.linkedin(),
        gbp: gbpFallbackByLocation(),
      };
    }

    const result = await SocialMediaService.publishToAll({
      title: send.subject,
      description: send.preview_text || send.subject,
      link,
      guid: `newsletter_${send.id}`,
      source: 'newsletter',
      customContent,
      // Autonomous: brand card (publishToAll renders it) — never an AI image.
      noAiImage: true,
    });

    if (result?.dryRun) {
      logger.info(`[content-scheduler] Newsletter social share dry-run for send ${send.id} �� not marking as shared`);
      await db('newsletter_sends').where('id', send.id).update({
        social_share_status: 'pending',
        social_share_attempted_at: null,
      });
      return true;
    }

    const platforms = Array.isArray(result?.platforms) ? result.platforms : [];
    const shared = result?.success || platforms.some((p) => p.success);

    if (!shared) {
      const failures = platforms
        .filter((p) => !p.success)
        .map((p) => `${p.platform || 'unknown'}:${p.error || 'failed'}`)
        .join('; ');
      logger.warn(`[content-scheduler] Social share produced no successful platforms for newsletter send ${send.id}${failures ? `: ${failures}` : ''}`);
      await db('newsletter_sends').where('id', send.id).update({
        social_share_status: 'failed',
        social_share_error: (failures || 'all platforms failed').slice(0, 2000),
        social_share_result: JSON.stringify(platforms),
      });
      return true;
    }

    await db('newsletter_sends').where('id', send.id).update({
      shared_to_social: true,
      shared_at: new Date(),
      social_share_status: 'shared',
      social_share_result: JSON.stringify(platforms),
    });
    return true;
  } catch (err) {
    logger.warn(`[content-scheduler] Social share failed for newsletter send ${send.id}: ${err.message}`);
    await db('newsletter_sends').where('id', send.id).update({
      social_share_status: 'failed',
      social_share_error: String(err.message).slice(0, 2000),
    });
    return true;
  }
}

const ContentScheduler = {

  /**
   * Get all scheduled content in a date range (blog + social merged).
   */
  async getCalendar(startDate, endDate) {
    const range = normalizeCalendarRange(startDate, endDate);
    const blogs = await db('blog_posts')
      .where(function () {
        this.where(function () {
          this.where('scheduled_publish_at', '>=', range.start)
            .where('scheduled_publish_at', '<', range.end);
        }).orWhere(function () {
          this.where('publish_date', '>=', range.start)
            .where('publish_date', '<', range.end);
        });
      })
      .select('id', 'title', 'status', 'publish_status', 'astro_status', 'scheduled_publish_at', 'publish_date', 'tag', 'city');

    const socials = await db('social_media_posts')
      .where('scheduled_for', '>=', range.start)
      .where('scheduled_for', '<', range.end)
      .select('id', 'title', 'status', 'publish_status', 'scheduled_for', 'platforms_posted', 'source_type');

    const calendar = [];

    for (const b of blogs) {
      calendar.push({
        id: b.id,
        type: 'blog',
        title: b.title,
        scheduledDate: b.scheduled_publish_at || dateColumnKey(b.publish_date),
        status: b.publish_status || b.status,
        astroStatus: b.astro_status || null,
        platforms: ['blog'],
        tag: b.tag,
        city: b.city,
      });
    }

    for (const s of socials) {
      const platforms = Array.isArray(s.platforms_posted)
        ? s.platforms_posted.map(p => typeof p === 'string' ? p : p.platform)
        : [];
      calendar.push({
        id: s.id,
        type: 'social',
        title: s.title,
        scheduledDate: s.scheduled_for,
        status: s.publish_status || s.status,
        platforms,
      });
    }

    // Sort by date ascending
    calendar.sort((a, b) => new Date(a.scheduledDate) - new Date(b.scheduledDate));

    return calendar;
  },

  /**
   * Schedule a blog post to open its Astro preview PR at a specific time. The
   * post goes live when an admin approves that PR (Approve & Go Live).
   * Refuses rows the consumer would skip, so success always means the
   * scheduled run will pick the row up.
   */
  async scheduleBlogPost(blogPostId, publishAt, autoShareSocial = true) {
    const post = await db('blog_posts').where('id', blogPostId).first();
    if (!post) throw new Error('Blog post not found');
    const scheduledAt = parseScheduledTime(publishAt, 'publishAt');
    const refusal = scheduleRefusal(post);
    if (refusal) throw scheduleConflict(refusal);

    // Same predicate on the write: a publish that starts between the read
    // and here must not be re-armed under its running claim.
    const [updated] = await db('blog_posts')
      .where('id', blogPostId)
      .where((q) => q.whereNull('publish_status').orWhereNot('publish_status', 'publishing'))
      .whereNull('astro_pr_number')
      .whereNull('astro_branch_name')
      .where((q) => q.whereNull('astro_status').orWhereNotIn('astro_status', SCHEDULE_BLOCKING_ASTRO))
      .update({
        scheduled_publish_at: scheduledAt,
        auto_share_social: autoShareSocial,
        publish_status: 'pending',
        updated_at: new Date(),
      })
      .returning('*');
    if (!updated) throw scheduleConflict('This post changed while scheduling. Reload and try again.');

    logger.info(`[content-scheduler] Scheduled blog "${updated.title}" for ${publishAt}`);
    return updated;
  },

  /**
   * Create a scheduled social media post.
   */
  async scheduleSocialPost({ title, description, link, platforms, scheduledFor, customContent }) {
    const scheduledAt = parseScheduledTime(scheduledFor, 'scheduledFor');
    const [post] = await db('social_media_posts')
      .insert({
        title,
        description,
        source_url: link || null,
        source_type: 'scheduled',
        platforms_posted: JSON.stringify(platforms || []),
        status: 'scheduled',
        publish_status: 'pending',
        scheduled_for: scheduledAt,
        custom_content: customContent ? JSON.stringify(customContent) : null,
        created_at: new Date(),
      })
      .returning('*');

    logger.info(`[content-scheduler] Scheduled social post "${title}" for ${scheduledFor}`);
    return post;
  },

  /**
   * Saved campaign drafts the Calendar can still schedule: no time, not
   * published, not already queued.
   */
  async listSavedSocialDrafts() {
    const rows = await db('social_media_posts')
      .where(SAVED_DRAFT)
      .whereNull('scheduled_for')
      .modify(notAutonomousRunDraft)
      .orderBy('created_at', 'desc')
      .limit(100)
      .select('id', 'title', 'platforms_posted');
    return rows.map((r) => ({ id: r.id, title: r.title, channels: storedChannels(r.platforms_posted) }));
  },

  /**
   * Give a saved campaign draft its time. The same row posts later, with its
   * own copy, image, channels, title and link. The WHERE is the whole check:
   * a row that published, is queued, or is not a campaign draft updates
   * nothing and reads as a conflict.
   */
  async scheduleSavedSocialDraft(postId, scheduledFor) {
    const scheduledAt = parseScheduledTime(scheduledFor, 'scheduledFor');
    const [post] = await db('social_media_posts')
      .where({ id: postId, ...SAVED_DRAFT })
      .whereNull('scheduled_for')
      .modify(notAutonomousRunDraft)
      .update({ scheduled_for: scheduledAt, status: 'scheduled' })
      .returning('*');
    if (!post) throw scheduleConflict('This draft is no longer available to schedule. Reload and pick again.');

    logger.info(`[content-scheduler] Scheduled saved social draft "${post.title}" for ${scheduledFor}`);
    return post;
  },

  /**
   * Take a social row off the schedule. A saved campaign draft goes back to
   * status 'draft' with publish_status 'pending' and no time, so it can be
   * picked again; once the scheduler claimed it, that is a conflict.
   */
  async unscheduleSocialPost(social) {
    // Exactly the states processScheduledPosts selects ('pending', 'dry_run'):
    // nothing has posted yet. The scheduler claims a row by moving it to
    // 'publishing', so the WHERE refuses a claimed (or finished) row instead
    // of reporting a cancel. A saved draft goes back to 'pending' (also out of
    // a dry run) so it can be picked again.
    const saved = social.source_type === SAVED_DRAFT.source_type;
    const back = await db('social_media_posts')
      .where({ id: social.id })
      .whereIn('publish_status', ['pending', 'dry_run'])
      .update(saved
        ? { scheduled_for: null, status: 'draft', publish_status: 'pending' }
        : { scheduled_for: null, publish_status: null, status: 'draft' });
    if (!back) throw scheduleConflict('Posting already started for this post, so it can no longer be unscheduled.');
  },

  /**
   * Process all posts whose scheduled time has passed and status is pending.
   * Called by the cron job every 15 minutes.
   */
  async processScheduledPosts() {
    const now = new Date();
    let blogCount = 0;
    let socialCount = 0;
    let errors = 0;

    // Un-strand blogs whose 'publishing' claim never resolved (process died
    // mid-publish). Without this the row is stuck forever AND — because
    // pages-poll's auto-merge branch fires on pr_open + publishing —
    // a stranded claim would keep that scheduler-only auto-merge path armed
    // indefinitely. See the matching comment in pages-poll.pollPost().
    try {
      await this.resetStalePublishingBlogs();
    } catch (err) {
      logger.warn(`[content-scheduler] stale-publishing sweep failed: ${err.message}`);
    }
    // Same sweep for social rows — a crash mid-publishToAll strands them at
    // 'publishing' with no other reader (the pending query selects only
    // pending/dry_run).
    try {
      await this.resetStalePublishingSocials();
    } catch (err) {
      logger.warn(`[content-scheduler] stale social-publishing sweep failed: ${err.message}`);
    }

    // ── Process blog posts ──────────────────────────────────────
    const pendingBlogs = await db('blog_posts')
      .where(function () {
        this.where(function () {
          this.where('publish_status', 'pending')
            .where(function () {
              this.whereNull('astro_status')
                .orWhereNotIn('astro_status', ['pr_open', 'build_failed', 'publish_failed', 'merged', 'live', 'unpublish_pending']);
            });
        }).orWhere(function () {
          this.where('publish_status', 'pending_review')
            .where('astro_status', 'live');
        });
      })
      .whereNotNull('scheduled_publish_at')
      .where('scheduled_publish_at', '<=', now);

    for (const blog of pendingBlogs) {
      let claimed = false;
      try {
        // Atomic compare-and-set claim: guard on the publish_status we
        // selected so an overlapping instance (deploy overlap / slow prior
        // tick) can't double-drive the same blog — whoever flips the row to
        // 'publishing' first wins, the other sees 0 rows updated and skips.
        // updated_at is stamped so the stale-publishing sweep above measures
        // the claim's age, not some older edit.
        claimed = (await db('blog_posts')
          .where('id', blog.id)
          .where('publish_status', blog.publish_status)
          // Mutual exclusion with the manual /publish-astro lane: a live
          // publish_claimed_at means an admin's publishAstro is mid-flight —
          // claiming now would run two publishers over the same row and
          // cross-wire their PR markers. Stale (>30m) claims are crashed
          // publishes and don't block.
          .where((q) => q.whereNull('publish_claimed_at')
            .orWhere('publish_claimed_at', '<', new Date(Date.now() - 30 * 60 * 1000)))
          // Re-check eligibility ATOMICALLY (mirrors the pending SELECT): a
          // manual publish that FINISHED between the SELECT and this CAS
          // left pr_open + a cleared lease with publish_status untouched —
          // claiming from that stale snapshot would pair the manual PR with
          // 'publishing', which pages-poll reads as auto-merge authorization
          // (bypassing the Approve & Go Live click). Two lanes: the
          // first-publish lane requires zero external progress (no PR, no
          // branch, no in-flight astro state — 'draft' and other settled
          // states pass); the pending_review+live lane is the social-share
          // finish for an already-live post and keeps its markers.
          .where((q) => q
            .where((first) => first
              .whereNull('astro_pr_number')
              .whereNull('astro_branch_name')
              .where((m) => m.whereNull('astro_status')
                .orWhereNotIn('astro_status', ['pr_open', 'build_failed', 'publish_failed', 'merged', 'live', 'unpublish_pending'])))
            .orWhere((share) => share
              .where('publish_status', 'pending_review')
              .where('astro_status', 'live')))
          .update({ publish_status: 'publishing', updated_at: new Date() })) > 0;
        if (!claimed) {
          logger.info(`[content-scheduler] blog ${blog.id} already claimed by a concurrent tick — skipping`);
          continue;
        }

        if (!blog.content) {
          throw new Error('Scheduled blog has no content; cannot open Astro publish PR');
        }

        if (['pr_open', 'build_failed'].includes(blog.astro_status)) {
          await db('blog_posts').where('id', blog.id).update({
            publish_status: 'pending_review',
            updated_at: new Date(),
          });
        } else if (blog.astro_status === 'live') {
          const socialShared = await sharePublishedBlog(blog);
          if (!socialShared) {
            await db('blog_posts').where('id', blog.id).update({
              publish_status: 'pending_review',
              updated_at: new Date(),
            });
            continue;
          }
          await db('blog_posts').where('id', blog.id).update({
            publish_status: 'published',
            status: 'published',
            updated_at: new Date(),
          });
        } else {
          const AstroPublisher = require('./content-astro/astro-publisher');
          await AstroPublisher.publishAstro(blog.id);
          // Only while this run still holds the claim: an unschedule or the
          // stale sweep that moved the row on must not be overwritten (BLOG-04).
          await db('blog_posts').where('id', blog.id).where('publish_status', 'publishing').update({
            publish_status: 'pending_review',
            updated_at: new Date(),
          });
        }

        blogCount++;
        logger.info(`[content-scheduler] Opened/synchronized Astro publish review for blog ${blog.id}`);
      } catch (err) {
        errors++;
        const terminalFailure = err.message === 'Scheduled blog has no content; cannot open Astro publish PR';
        // Deterministic content-policy rejections fail IDENTICALLY every
        // run — frontmatter/schema, guardrails, comparison gate, fact
        // check, MDX token leak are all properties of the post's content,
        // not of the moment. Retrying them every 15 minutes re-burns the
        // gates (the fact check is an LLM call) and can never succeed, so
        // they park as 'failed' like the no-content terminal case: the
        // author edits the post and republishes. Everything else (GitHub /
        // network / DB blips) stays on the transient retry fork below.
        const DETERMINISTIC_PUBLISH_CODES = new Set([
          'BLOG_FRONTMATTER_INVALID',
          'BLOG_GUARDRAILS_FAILED',
          'BLOG_COMPARISON_GATE_FAILED',
          'BLOG_FACTCHECK_FAILED',
          'BLOG_EDITORIAL_REVIEW_FAILED',
          // A semantic compliance P0 is edit-required exactly like the
          // fact-check above: the copy states an unconditional safety claim or
          // offers a service Waves does not provide, and re-running the same
          // draft through the same gate every 15 minutes cannot change that.
          'BLOG_COMPLIANCE_FAILED',
          // Topic-targeting block (out-of-footprint geo / statewide-only
          // framing / owned entity): the same row fails the same way every
          // attempt — edit-required, owner rulings 2026-08-27.
          'BLOG_TOPIC_TARGETING_BLOCKED',
          'BLOG_MDX_TOKEN_LEAK',
          // Curated hero URL that 404s / isn't an image — fails identically
          // every attempt (AI hero GENERATION failures stay untagged/transient).
          'BLOG_HERO_MEDIA_FAILED',
          // Body-image contract failures (no insertion slots, unreadable or
          // duplicate pictures) are properties of the content too — and each
          // retry would pay for image generations again.
          'BLOG_BODY_IMAGES_FAILED',
          // Owner competitor list (named off-list company on the final text):
          // edit-required. A company-check OUTAGE (BLOG_OWNER_LIST_UNVERIFIED)
          // stays on the transient retry fork below.
          'BLOG_OWNER_LIST_BLOCKED',
        ]);
        // Only release a claim WE hold — if the claim update itself failed
        // (or another instance holds it), writing here would stomp the
        // active attempt's 'publishing' state (hence the publish_status
        // guard on every branch).
        if (claimed) {
          // A company-check failure that is NOT an outage (the post is over
          // the extraction input bound) fails the same way every attempt.
          const terminalOwnerListCheck = err.code === 'BLOG_OWNER_LIST_UNVERIFIED' && err.retryable !== true;
          if (terminalFailure || terminalOwnerListCheck || DETERMINISTIC_PUBLISH_CODES.has(err.code)) {
            await db('blog_posts').where('id', blog.id).where('publish_status', 'publishing')
              .update({
                publish_status: 'failed',
                // publishAstro already stamped astro_status='publish_failed'
                // (deterministic codes all throw pre-PR, so no PR marker) —
                // clear it, or the fixed post re-scheduled via
                // scheduleBlogPost (which only sets publish_status) is never
                // re-selected: the pending query excludes publish_failed.
                // Guarded on BOTH markers so a publish_failed row that DOES
                // carry an opened PR or a surviving branch keeps its state
                // for the retry cleanup.
                astro_status: db.raw("CASE WHEN astro_status = 'publish_failed' AND astro_pr_number IS NULL AND astro_branch_name IS NULL THEN NULL ELSE astro_status END"),
                updated_at: new Date(),
              }).catch(() => {});
          } else {
            // Same fork as resetStalePublishingBlogs: where the row goes
            // depends on whether Astro made external progress (publishAstro
            // may have written state before throwing — re-check, don't
            // trust the tick-start snapshot).
            //   - no astro_status, OR 'publish_failed' with NO PR opened
            //     (publishAstro's own catch stamps publish_failed on every
            //     pre-PR throw before this handler ever sees the row, so a
            //     bare whereNull never matched a transient GitHub blip):
            //     release to 'pending' and clear the failed marker so the
            //     next tick retries — parking at pending_review would
            //     strand it permanently (the pending query only re-selects
            //     pending_review rows when astro_status='live', and
            //     pages-poll only watches pr_open/build_failed/merged).
            //     astro_publish_error is kept for the audit trail.
            //   - anything else (PR opened / surviving branch / build
            //     failed / live — astro_pr_number marks an opened PR, and
            //     astro_branch_name alone marks a branch the publisher
            //     could not prove PR-less or could not delete):
            //     'pending_review'; blind-retrying those could open a
            //     duplicate PR.
            const retried = await db('blog_posts').where('id', blog.id)
              .where('publish_status', 'publishing')
              .where(function () {
                this.whereNull('astro_status').orWhere(function () {
                  this.where('astro_status', 'publish_failed').whereNull('astro_pr_number').whereNull('astro_branch_name');
                });
              })
              .update({ publish_status: 'pending', astro_status: null, updated_at: new Date() }).catch(() => 0);
            if (!retried) {
              await db('blog_posts').where('id', blog.id).where('publish_status', 'publishing')
                .update({ publish_status: 'pending_review', updated_at: new Date() }).catch(() => {});
            }
          }
        }
        logger.error(`[content-scheduler] Failed to publish blog ${blog.id}: ${err.message}`);
      }
    }

    // ── Process social posts ────────────────────────────────────
    const { SOCIAL_FLAGS: flags, isPausedByAdmin: checkPause } = require('./social-media');
    if (!flags.automationEnabled || !flags.scheduledPosts || await checkPause()) {
      return { blogCount, socialCount, errors, socialSkipped: true };
    }

    const pendingSocials = await db('social_media_posts')
      .where(function() {
        this.where('publish_status', 'pending')
          .orWhere('publish_status', 'dry_run');
      })
      .whereNotNull('scheduled_for')
      .where('scheduled_for', '<=', now);

    for (const social of pendingSocials) {
      let claimed = false;
      try {
        // Atomic compare-and-set claim, same rule as the blog loop above:
        // guard on the publish_status we selected so an overlapping
        // instance (deploy overlap / slow prior tick) can't double-drive
        // the same row into publishToAll — scheduled-source posts have no
        // pre-post dedupe, so a double-drive here is a duplicate post on
        // every enabled platform. Whoever flips to 'publishing' first
        // wins; the loser sees 0 rows updated and skips.
        claimed = (await db('social_media_posts')
          .where('id', social.id)
          .where('publish_status', social.publish_status)
          // Still scheduled for the time this tick selected: an unschedule
          // (time cleared; a saved draft keeps publish_status 'pending') or a
          // reschedule landing after the select must not post the row now.
          .where('scheduled_for', social.scheduled_for)
          .update({ publish_status: 'publishing' })) > 0;
        if (!claimed) {
          logger.info(`[content-scheduler] social ${social.id} already claimed by a concurrent tick — skipping`);
          continue;
        }

        const SocialMediaService = require('./social-media');
        const customContent = typeof social.custom_content === 'string'
          ? JSON.parse(social.custom_content)
          : social.custom_content;

        // Pre-publish, platforms_posted holds the REQUESTED platform list the
        // admin picked at scheduling time (publishToAll rewrites it with the
        // results afterwards). Pass it through so a post scheduled for a
        // narrower set (e.g. Facebook-only) never fans out to platforms the
        // admin didn't select. Empty/missing → publishToAll's default set.
        const requestedChannels = storedChannels(social.platforms_posted);

        const result = await SocialMediaService.publishToAll({
          title: social.title,
          description: social.description,
          link: social.source_url,
          guid: social.source_guid || `social_${social.id}`,
          source: 'scheduled',
          channels: requestedChannels.length ? requestedChannels : undefined,
          customContent,
          ...storedPostOptions(social, { dryRun: SocialMediaService.SOCIAL_FLAGS?.dryRun === true }),
        });

        const complianceRejected = !result?.dryRun && !result?.success
          && Array.isArray(result?.platforms)
          && result.platforms.some((e) => String(e?.error || '').startsWith('Compliance judge'));
        if (result?.dryRun) {
          await db('social_media_posts').where('id', social.id).update({ publish_status: 'dry_run', status: 'dry_run' });
          logger.info(`[content-scheduler] Dry-run social: "${social.title}" — marked dry_run`);
        } else if (complianceRejected) {
          // Exception-based handling: a judge-rejected scheduled post PARKS
          // for review instead of being silently consumed as "published"
          // (nothing actually posted). The status change stops the retry
          // loop; the notification surfaces it.
          const reasons = result.platforms
            .map((e) => e?.error).filter((e) => String(e || '').startsWith('Compliance judge'));
          await db('social_media_posts').where('id', social.id).update({
            publish_status: 'compliance_rejected',
            status: 'compliance_rejected',
          });
          try {
            // Through NotificationService (not a raw insert) so the
            // GATE_ADMIN_BELL_POLICY chokepoint covers this category.
            await require('./notification-service').notifyAdmin(
              'social_compliance_rejected',
              'Scheduled social post rejected by compliance judge',
              `"${String(social.title || '').slice(0, 120)}" was not published: ${[...new Set(reasons)].join('; ').slice(0, 400)}. Edit the copy and reschedule from Social Studio.`,
            );
          } catch (err) {
            logger.error(`[content-scheduler] compliance-rejection notification failed: ${err.message}`);
          }
          logger.warn(`[content-scheduler] Compliance judge rejected scheduled social: "${social.title}" — parked for review`);
        } else {
          await db('social_media_posts').where('id', social.id).update({
            publish_status: 'published',
            status: 'published',
            published_at: new Date(),
          });
          socialCount++;
          logger.info(`[content-scheduler] Published social: "${social.title}"`);
        }
      } catch (err) {
        errors++;
        // Only mark failed a claim WE hold (and that is still 'publishing'):
        // if the claim update itself failed — or another instance holds the
        // row — writing 'failed' here would stomp the active attempt.
        if (claimed) {
          await db('social_media_posts')
            .where('id', social.id)
            .where('publish_status', 'publishing')
            .update({ publish_status: 'failed' })
            .catch(() => {});
        }
        logger.error(`[content-scheduler] Failed to publish social "${social.title}": ${err.message}`);
      }
    }

    return { blogCount, socialCount, errors };
  },

  /**
   * Reset blogs stranded at publish_status='publishing'.
   *
   * 'publishing' is a transient claim the scheduler holds while it drives a
   * scheduled blog (open PR / share / mark published) — every path clears it
   * within the same tick. A crash mid-publish strands the row: nothing ever
   * re-selects it (the pending query excludes 'publishing'), and the strand
   * leaves pages-poll's pr_open+publishing auto-merge branch armed forever.
   *
   * Where a stale row goes (>~30 min) depends on whether Astro state exists:
   *   - astro_status NULL (crashed BEFORE publishAstro opened a PR): there is
   *     no PR/live state for pages-poll or a human to drive, and the pending
   *     query only re-selects 'pending_review' rows when astro_status='live'
   *     — parking these at 'pending_review' would strand them permanently.
   *     Reset to 'pending' so the scheduler retries the publish from scratch
   *     (the claim is compare-and-set, so the retry is race-safe).
   *   - astro_status set (PR opened / build failed / merged / live before
   *     the crash): 'pending_review' — the same safe parking state the error
   *     path uses — pages-poll drives pr_open/merged forward and the
   *     live-flip path re-selects it.
   */
  async resetStalePublishingBlogs({ staleMinutes = 30 } = {}) {
    const cutoff = new Date(Date.now() - staleMinutes * 60000);
    // Retryable = crashed with no Astro progress: either no astro state at
    // all, or publishAstro's catch stamped 'publish_failed' with NEITHER
    // marker (astro_pr_number = an opened PR; astro_branch_name alone = a
    // branch the publisher could not prove PR-less or could not delete —
    // with either out there, blind-retrying could open a duplicate, so
    // those park below instead).
    const retried = await db('blog_posts')
      .where('publish_status', 'publishing')
      .where('updated_at', '<', cutoff)
      .where(function () {
        this.whereNull('astro_status').orWhere(function () {
          this.where('astro_status', 'publish_failed').whereNull('astro_pr_number').whereNull('astro_branch_name');
        });
      })
      .update({ publish_status: 'pending', astro_status: null, updated_at: new Date() });
    if (retried > 0) {
      logger.warn(`[content-scheduler] reset ${retried} blog(s) stranded in publish_status='publishing' for >${staleMinutes}m with no Astro progress back to pending (crashed pre-PR; publish will retry)`);
    }
    const reset = await db('blog_posts')
      .where('publish_status', 'publishing')
      .where('updated_at', '<', cutoff)
      .whereNotNull('astro_status')
      .update({ publish_status: 'pending_review', updated_at: new Date() });
    if (reset > 0) {
      logger.warn(`[content-scheduler] reset ${reset} blog(s) stranded in publish_status='publishing' for >${staleMinutes}m back to pending_review (crashed mid-publish with Astro state)`);
    }
    return retried + reset;
  },

  /**
   * Reset SOCIAL rows stranded at publish_status='publishing'.
   *
   * Same strand shape as the blogs: the claim is transient (publishToAll
   * resolves within the tick), so a crash mid-publish leaves a row nothing
   * re-selects (the pending query takes only pending/dry_run). Unlike the
   * blog sweep this NEVER retries: publishToAll may have posted to some
   * platforms before the crash, and a retry would duplicate those posts —
   * the exact failure the CAS claim exists to prevent. Stranded rows go to
   * 'failed' (the same state the error path uses) for a human to reschedule.
   *
   * social_media_posts has no updated_at column, so staleness keys on
   * scheduled_for: a claim is only ever taken when scheduled_for <= now,
   * so any row still 'publishing' well past its scheduled time is stranded.
   * The 30-minute margin keeps a slow in-flight publish of an overdue
   * backlog row safe (the cron also runs under an exclusive advisory lock,
   * so no publish is in flight while this sweep runs).
   */
  async resetStalePublishingSocials({ staleMinutes = 30 } = {}) {
    const cutoff = new Date(Date.now() - staleMinutes * 60000);
    const reset = await db('social_media_posts')
      .where('publish_status', 'publishing')
      .where('scheduled_for', '<', cutoff)
      .update({ publish_status: 'failed', status: 'failed' });
    if (reset > 0) {
      logger.warn(`[content-scheduler] marked ${reset} social post(s) stranded in publish_status='publishing' as failed (crashed mid-publish; NOT retried — platforms may have partially posted, reschedule manually)`);
    }
    return reset;
  },

  /**
   * Re-drive newsletter social shares that were stranded.
   *
   * sendCampaign fires sharePublishedNewsletter as a fire-and-forget promise,
   * so if the process crashes/restarts before it runs, the row is left with
   * shared_to_social=false and social_share_status pending/failed and nothing
   * ever retries it (sharePublishedNewsletter's own stale-recovery only fires
   * from within a call — and nothing calls it again). This sweep finds those
   * rows and re-invokes the share; the atomic claim inside sharePublishedNewsletter
   * makes it safe against the original promise still being in flight.
   *
   * Scoped to recently-sent rows so we never reanimate ancient shares. Called
   * by the content-scheduler cron.
   */
  async retryStrandedNewsletterShares({ lookbackDays = 7, limit = 25 } = {}) {
    const cutoff = new Date(Date.now() - lookbackDays * 86400000);
    const staleProcessing = new Date(Date.now() - 5 * 60 * 1000);

    const stranded = await db('newsletter_sends')
      .where('status', 'sent')
      .where('shared_to_social', false)
      .where('auto_share_social', true)
      .where('sent_at', '>=', cutoff)
      .where((b) =>
        b.whereIn('social_share_status', ['pending', 'failed'])
          .orWhereNull('social_share_status')
          .orWhere((p) =>
            p.where('social_share_status', 'processing')
              .where('social_share_attempted_at', '<', staleProcessing),
          ),
      )
      .orderBy('sent_at', 'asc')
      .limit(limit);

    let retried = 0;
    for (const send of stranded) {
      try {
        await sharePublishedNewsletter(send);
        retried += 1;
      } catch (err) {
        logger.warn(`[content-scheduler] stranded-share retry failed for send ${send.id}: ${err.message}`);
      }
    }
    if (retried > 0) logger.info(`[content-scheduler] re-drove ${retried} stranded newsletter social share(s)`);
    return { candidates: stranded.length, retried };
  },

  /**
   * Get upcoming scheduled content for the next N days.
   */
  async getUpcoming(days = 7) {
    const now = new Date();
    const end = new Date(now.getTime() + days * 86400000);
    return this.getCalendar(now.toISOString(), end.toISOString());
  },
};

module.exports = ContentScheduler;
module.exports.normalizeCalendarRange = normalizeCalendarRange;
module.exports.sharePublishedNewsletter = sharePublishedNewsletter;
module.exports.gbpFallbackByLocation = gbpFallbackByLocation;
module.exports.normalizeGbpByLocation = normalizeGbpByLocation;
