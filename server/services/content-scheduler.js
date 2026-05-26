/**
 * Content Scheduler Service
 *
 * Manages the content calendar — scheduling blog posts and social media posts,
 * and auto-publishing them when their scheduled time arrives.
 */

const db = require('../models/db');
const logger = require('./logger');
const { parseETDateTime, etDateString, addETDays } = require('../utils/datetime-et');

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

function parseScheduledTime(value, label) {
  const parsed = parseETDateTime(value);
  if (Number.isNaN(parsed.getTime())) throw new Error(`${label} is invalid`);
  return parsed;
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
    return true;
  }

  try {
    const SocialMediaService = require('./social-media');
    const link = blog.astro_live_url || blog.url || `https://www.wavespestcontrol.com/${blog.slug}`;
    const result = await SocialMediaService.publishToAll({
      title: blog.title,
      description: blog.meta_description || (blog.content || '').replace(/[#*_\[\]]/g, '').substring(0, 300),
      link,
      guid: `blog_${blog.id}`,
      source: 'blog_scheduled',
    });
    if (result?.dryRun) {
      logger.info(`[content-scheduler] Social share dry-run for blog ${blog.id} — not marking as shared`);
      return false;
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
    return false;
  }
}

// ── Newsletter → Social ────────────────────────────────────────────────

const NEWSLETTER_SOCIAL_FALLBACK = {
  facebook: (subject) =>
    `Fresh This Week is here: ${subject} — See what's happening from North Port to Tampa.`,
  instagram: () =>
    'Fresh This Week just dropped — local events across SW Florida. Link in bio. #FreshThisWeek #SWFL #SWFLevents',
  linkedin: () =>
    'Our latest Fresh This Week local guide is live, featuring events and community highlights across Southwest Florida.',
  gbp: () =>
    'Fresh This Week is live — local events and weekend ideas across Southwest Florida.',
};

async function generateNewsletterSocialContent(send) {
  let Anthropic;
  try {
    const sdk = require('@anthropic-ai/sdk');
    Anthropic = sdk.default || sdk.Anthropic || sdk;
  } catch { return null; }
  if (!Anthropic || !process.env.ANTHROPIC_API_KEY) return null;

  const MODELS = require('../config/models');
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const safeSubject = String(send.subject || '').replace(/[\r\n]+/g, ' ').slice(0, 300);
  const safePreview = String(send.preview_text || '').replace(/[\r\n]+/g, ' ').slice(0, 500);

  const response = await client.messages.create({
    model: MODELS.WORKHORSE,
    max_tokens: 600,
    messages: [{
      role: 'user',
      content: `Generate social media captions for Waves Pest Control's weekly local events guide "Fresh This Week."
This is NOT a pest control post — it's a punchy, upbeat local events roundup for SW Florida (North Port to Tampa).
Tone: fun, local-guide energy. Light FOMO is good ("just dropped", "here's what's happening this week") but don't be spammy or clickbaity.

Newsletter subject: ${safeSubject}
Newsletter preview: ${safePreview}

Return ONLY valid JSON with these keys:
- facebook: 150-250 chars, conversational, 1-2 emojis, do NOT include any URL
- instagram: 150-300 chars before hashtags, end with 3-5 hashtags (#FreshThisWeek #SWFL #SWFLevents etc), do NOT include any URL
- linkedin: 100-200 chars, professional but fun community tone, do NOT include any URL
- gbp: 80-150 chars, short community-oriented tone, no hashtags, do NOT include any URL`,
    }],
  });

  const text = (response.content[0]?.text || '').trim();
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return null;

  const parsed = JSON.parse(jsonMatch[0]);
  if (!parsed.facebook || !parsed.instagram || !parsed.linkedin || !parsed.gbp) return null;
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
    return true;
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
    return false;
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
        facebook: NEWSLETTER_SOCIAL_FALLBACK.facebook(send.subject || 'Fresh This Week'),
        instagram: NEWSLETTER_SOCIAL_FALLBACK.instagram(),
        linkedin: NEWSLETTER_SOCIAL_FALLBACK.linkedin(),
        gbp: NEWSLETTER_SOCIAL_FALLBACK.gbp(),
      };
    }

    const result = await SocialMediaService.publishToAll({
      title: send.subject,
      description: send.preview_text || send.subject,
      link,
      guid: `newsletter_${send.id}`,
      source: 'newsletter',
      customContent,
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
      return false;
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
    return false;
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
      .select('id', 'title', 'status', 'publish_status', 'scheduled_publish_at', 'publish_date', 'tag', 'city');

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
   * Schedule a blog post for auto-publish at a specific time.
   */
  async scheduleBlogPost(blogPostId, publishAt, autoShareSocial = true) {
    const post = await db('blog_posts').where('id', blogPostId).first();
    if (!post) throw new Error('Blog post not found');
    const scheduledAt = parseScheduledTime(publishAt, 'publishAt');

    const [updated] = await db('blog_posts')
      .where('id', blogPostId)
      .update({
        scheduled_publish_at: scheduledAt,
        auto_share_social: autoShareSocial,
        publish_status: 'pending',
        updated_at: new Date(),
      })
      .returning('*');

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
   * Process all posts whose scheduled time has passed and status is pending.
   * Called by the cron job every 15 minutes.
   */
  async processScheduledPosts() {
    const now = new Date();
    let blogCount = 0;
    let socialCount = 0;
    let errors = 0;

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
      try {
        await db('blog_posts').where('id', blog.id).update({ publish_status: 'publishing' });

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
          await db('blog_posts').where('id', blog.id).update({
            publish_status: 'pending_review',
            updated_at: new Date(),
          });
        }

        blogCount++;
        logger.info(`[content-scheduler] Opened/synchronized Astro publish review for blog ${blog.id}`);
      } catch (err) {
        errors++;
        const terminalFailure = err.message === 'Scheduled blog has no content; cannot open Astro publish PR';
        await db('blog_posts').where('id', blog.id).update({
          publish_status: terminalFailure ? 'failed' : 'pending_review',
          updated_at: new Date(),
        });
        logger.error(`[content-scheduler] Failed to publish blog ${blog.id}: ${err.message}`);
      }
    }

    // ── Process social posts ────────────────────────────────────
    const { SOCIAL_FLAGS: flags, isPausedByAdmin: checkPause } = require('./social-media');
    if (!flags.automationEnabled || !flags.scheduledPosts || await checkPause()) {
      return { blogCount, socialCount, errors, socialSkipped: true };
    }

    const pendingSocials = await db('social_media_posts')
      .where('publish_status', 'pending')
      .whereNotNull('scheduled_for')
      .where('scheduled_for', '<=', now);

    for (const social of pendingSocials) {
      try {
        await db('social_media_posts').where('id', social.id).update({ publish_status: 'publishing' });

        const SocialMediaService = require('./social-media');
        const customContent = typeof social.custom_content === 'string'
          ? JSON.parse(social.custom_content)
          : social.custom_content;

        await SocialMediaService.publishToAll({
          title: social.title,
          description: social.description,
          link: social.source_url,
          guid: social.source_guid || `social_${social.id}`,
          source: 'scheduled',
          customContent,
        });

        await db('social_media_posts').where('id', social.id).update({
          publish_status: 'published',
          status: 'published',
          published_at: new Date(),
        });
        socialCount++;
        logger.info(`[content-scheduler] Published social: "${social.title}"`);
      } catch (err) {
        errors++;
        await db('social_media_posts').where('id', social.id).update({ publish_status: 'failed' });
        logger.error(`[content-scheduler] Failed to publish social "${social.title}": ${err.message}`);
      }
    }

    return { blogCount, socialCount, errors };
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
