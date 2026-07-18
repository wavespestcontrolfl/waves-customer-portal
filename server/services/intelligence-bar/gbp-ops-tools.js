/**
 * Intelligence Bar — Google Business Profile Ops Tools
 * server/services/intelligence-bar/gbp-ops-tools.js
 *
 * Read-only listing health across the four GBP locations: connection state,
 * verification/suspension flags, and the latest local posts. Reviews are
 * NOT here — the review tools already cover them from the DB. A suspended
 * or disconnected listing silently stops posts and review replies; this is
 * the check that catches it.
 *
 * Reuses services/google-business.js (per-location OAuth from
 * system_settings). NO writes — posting and review replies keep their own
 * flows.
 */

const gbp = require('../google-business');
const { WAVES_LOCATIONS } = require('../../config/locations');
const logger = require('../logger');

const POSTS_PER_LOCATION = 3;
const MAX_POST_SUMMARY_LENGTH = 140;

const GBP_OPS_TOOLS = [
  {
    name: 'get_gbp_status',
    description: `Google Business Profile health for all four locations: OAuth connection state, listing verification/suspension flags, and the most recent local posts. A disconnected or suspended listing silently stops posting and review replies.
Use for: "are the GBP listings healthy?", "when did we last post to the Venice profile?", "is any location suspended or disconnected?"`,
    input_schema: {
      type: 'object',
      properties: {},
    },
  },
];

const NOT_CONFIGURED_MESSAGE = 'Google Business Profile access is not configured. GBP_CLIENT_ID_*/GBP_CLIENT_SECRET_* must be set in the Railway dashboard, then each location connects via /admin/settings.';

async function describeLocation(loc) {
  const out = { location: loc.name, location_id: loc.id, connected: false };
  try {
    out.connected = await gbp.isLocationConfigured(loc.id);
    if (!out.connected) {
      out.note = 'Not connected — reconnect via /admin/settings Google Business Profile.';
      return out;
    }
    // Listing state and recent posts are independent reads — one failing
    // must not blank the other.
    try {
      const details = await gbp.getLocationDetails(loc.googleLocationResourceName, loc.id);
      const state = details.locationState || {};
      out.listing_state = {
        is_verified: state.isVerified ?? null,
        is_published: state.isPublished ?? null,
        is_suspended: state.isSuspended ?? null,
        is_disconnected: state.isDisconnected ?? null,
      };
    } catch (err) {
      out.listing_state_error = err.message;
    }
    try {
      const posts = await gbp.listLocalPosts(loc.googleLocationResourceName, loc.id, POSTS_PER_LOCATION);
      out.recent_posts = posts.map(post => ({
        created: post.createTime || null,
        state: post.state || null,
        summary: post.summary ? String(post.summary).slice(0, MAX_POST_SUMMARY_LENGTH) : null,
      }));
    } catch (err) {
      out.posts_error = err.message;
    }
  } catch (err) {
    out.error = err.message;
  }
  return out;
}

async function getGbpStatus() {
  const locations = await Promise.all(WAVES_LOCATIONS.map(describeLocation));
  return {
    locations,
    total: locations.length,
    connected: locations.filter(l => l.connected).length,
    note: 'Live GBP state per location. Reviews live in the review tools; posting and reconnection happen in their own admin flows, never through this tool.',
  };
}

async function executeGbpOpsTool(toolName) {
  // "Not configured" is the expected DARK state, not a failure — an
  // { error } result would count against the shared admin circuit breaker
  // (see ops-tools.js for the full rationale).
  if (!gbp.configured) {
    return { configured: false, message: NOT_CONFIGURED_MESSAGE };
  }
  try {
    switch (toolName) {
      case 'get_gbp_status': return await getGbpStatus();
      default: return { error: `Unknown tool: ${toolName}` };
    }
  } catch (err) {
    logger.error(`[intelligence-bar:gbp-ops] Tool ${toolName} failed:`, err);
    return { error: err.message };
  }
}

module.exports = { GBP_OPS_TOOLS, executeGbpOpsTool };
