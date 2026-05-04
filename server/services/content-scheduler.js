/**
 * Content Scheduler Service
 *
 * Manages the content calendar — scheduling blog posts and social media posts,
 * and auto-publishing them when their scheduled time arrives.
 */

const db = require('../models/db');
const logger = require('./logger');

async function sharePublishedBlog(blog) {
  if (!blog.auto_share_social || blog.shared_to_social) return true;

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

const ContentScheduler = {

  /**
   * Get all scheduled content in a date range (blog + social merged).
   */
  async getCalendar(startDate, endDate) {
    const blogs = await db('blog_posts')
      .where(function () {
        this.whereBetween('scheduled_publish_at', [startDate, endDate])
          .orWhereBetween('publish_date', [startDate, endDate]);
      })
      .select('id', 'title', 'status', 'publish_status', 'scheduled_publish_at', 'publish_date', 'tag', 'city');

    const socials = await db('social_media_posts')
      .whereBetween('scheduled_for', [startDate, endDate])
      .select('id', 'title', 'status', 'publish_status', 'scheduled_for', 'platforms_posted', 'source_type');

    const calendar = [];

    for (const b of blogs) {
      calendar.push({
        id: b.id,
        type: 'blog',
        title: b.title,
        scheduledDate: b.scheduled_publish_at || b.publish_date,
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

    const [updated] = await db('blog_posts')
      .where('id', blogPostId)
      .update({
        scheduled_publish_at: new Date(publishAt),
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
    const [post] = await db('social_media_posts')
      .insert({
        title,
        description,
        source_url: link || null,
        source_type: 'scheduled',
        platforms_posted: JSON.stringify(platforms || []),
        status: 'scheduled',
        publish_status: 'pending',
        scheduled_for: new Date(scheduledFor),
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
            .whereIn('astro_status', ['merged', 'live']);
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
        } else if (['merged', 'live'].includes(blog.astro_status)) {
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
