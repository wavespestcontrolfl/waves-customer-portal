/**
 * Intelligence Bar — Social Channel Ops Tools
 * server/services/intelligence-bar/social-ops-tools.js
 *
 * Read-only visibility into the social publishing stack: per-channel
 * enablement flags + credential presence, the automation/dry-run switches,
 * and the most recent social_media_posts rows (drafts, scheduled, failures).
 * Complements token-health — a token can verify while posting still fails,
 * and a channel can be silently disabled by its env flag.
 *
 * Reads SOCIAL_FLAGS and the DB; never posts, approves, or schedules.
 */

const db = require('../../models/db');
const { SOCIAL_FLAGS, isPausedByAdmin } = require('../social-media');
const logger = require('../logger');

const MAX_POSTS_SHOWN = 10;
const MAX_TITLE_LENGTH = 120;

const SOCIAL_OPS_TOOLS = [
  {
    name: 'get_social_channel_status',
    description: `Social publishing health: per-channel (Facebook/Instagram/LinkedIn/Twitter/GBP) enablement flag + credential presence, the automation/dry-run/pause switches, and the latest posts with their statuses. A channel can be silently off via its env flag even with a healthy token.
Use for: "is social posting working?", "why didn't the blog share to LinkedIn?", "what posted recently and what failed?"`,
    input_schema: {
      type: 'object',
      properties: {},
    },
  },
];

function channelStates() {
  return {
    facebook: {
      enabled: SOCIAL_FLAGS.facebookEnabled,
      credentials_present: !!(process.env.FACEBOOK_ACCESS_TOKEN && process.env.FACEBOOK_PAGE_ID),
    },
    instagram: {
      enabled: SOCIAL_FLAGS.instagramEnabled,
      credentials_present: !!(process.env.FACEBOOK_ACCESS_TOKEN && process.env.INSTAGRAM_ACCOUNT_ID),
    },
    linkedin: {
      enabled: SOCIAL_FLAGS.linkedinEnabled,
      credentials_present: !!process.env.LINKEDIN_ACCESS_TOKEN,
    },
    twitter: {
      enabled: SOCIAL_FLAGS.twitterEnabled,
      credentials_present: !!(process.env.TWITTER_API_KEY && process.env.TWITTER_ACCESS_TOKEN),
    },
    gbp: {
      enabled: SOCIAL_FLAGS.gbpEnabled,
      // Per-location GBP OAuth state lives in get_gbp_status / token health
      credentials_present: null,
    },
  };
}

async function getSocialChannelStatus() {
  let recentPosts = [];
  try {
    const rows = await db('social_media_posts')
      .select('title', 'status', 'source_type', 'platforms_posted', 'scheduled_for', 'published_at', 'created_at')
      .orderBy('created_at', 'desc')
      .limit(MAX_POSTS_SHOWN);
    recentPosts = rows.map(row => ({
      title: row.title ? String(row.title).slice(0, MAX_TITLE_LENGTH) : null,
      status: row.status,
      source: row.source_type,
      platforms_posted: Array.isArray(row.platforms_posted) ? row.platforms_posted : [],
      scheduled_for: row.scheduled_for ? new Date(row.scheduled_for).toISOString() : null,
      published_at: row.published_at ? new Date(row.published_at).toISOString() : null,
    }));
  } catch (err) {
    logger.warn(`[intelligence-bar:social-ops] recent posts query failed: ${err.message}`);
  }
  let pausedByAdmin = null;
  try {
    pausedByAdmin = await isPausedByAdmin();
  } catch {
    // Pause flag lives in DB settings — absence of an answer is reported as
    // unknown, not a tool failure.
  }
  return {
    channels: channelStates(),
    switches: {
      automation_enabled: SOCIAL_FLAGS.automationEnabled,
      dry_run: SOCIAL_FLAGS.dryRun,
      paused_by_admin: pausedByAdmin,
      rss_autopublish: SOCIAL_FLAGS.rssAutopublish,
      scheduled_posts: SOCIAL_FLAGS.scheduledPosts,
      newsletter_autoshare: SOCIAL_FLAGS.newsletterAutoshare,
    },
    recent_posts: recentPosts,
    failed_recent: recentPosts.filter(p => p.status === 'failed').length,
    note: 'dry_run=true means publishes are simulated. A channel needs BOTH its flag enabled and credentials present to post; token VALIDITY is the token-health tool. Posting/approval happens in the social studio, never through this tool.',
  };
}

async function executeSocialOpsTool(toolName) {
  try {
    switch (toolName) {
      case 'get_social_channel_status': return await getSocialChannelStatus();
      default: return { error: `Unknown tool: ${toolName}` };
    }
  } catch (err) {
    logger.error(`[intelligence-bar:social-ops] Tool ${toolName} failed:`, err);
    return { error: err.message };
  }
}

module.exports = { SOCIAL_OPS_TOOLS, executeSocialOpsTool };
