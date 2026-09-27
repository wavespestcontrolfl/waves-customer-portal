/**
 * spoke-routing.js — the publish-origin routing decision for autonomous blog
 * drafts, shared by the publisher (astro-publisher.publishOrUpdatePage) and
 * the runner's operator slug repair so the two can never disagree on which
 * host a draft actually publishes on (target precedence, kill-switch
 * behavior, and origin mapping live HERE, once).
 *
 * Dependency-free by design: only spoke-sites, spoke-blog-network, and the
 * logger — requirable from the runner's unit env without the publisher's
 * full module graph.
 */

const logger = require('../logger');
const { normalizeSpokeSites, HUB_SITE_KEYS, spokeSiteOrigin } = require('./spoke-sites');
const { spokeBlogNetworkEnabled } = require('../content/spoke-blog-network');

// Resolve the single spoke a blog post targets, from the composed brief
// (top-level target_sites, or the persisted operator_brief copy). Spoke routing
// is only well-defined for EXACTLY ONE non-hub spoke (single-domain render +
// self-canonical); a hub target, an empty target, or multiple spokes all fall
// back to the hub-only blog policy.
function resolveSpokeTarget(brief = {}) {
  const fromBrief = normalizeSpokeSites(brief.target_sites);
  const fromOverlay = normalizeSpokeSites(brief?.voice_constraints?.operator_brief?.target_sites);
  const sites = (fromBrief.length ? fromBrief : fromOverlay)
    .filter((k) => !HUB_SITE_KEYS.includes(k));
  const spoke = sites.length === 1 ? sites[0] : null;
  // Kill-switch enforcement at the PUBLISHING chokepoint. The seeder gate stops
  // NEW spoke topics from being queued, but a spoke-seed row already in
  // opportunity_queue — or one seeded during a temporary re-enable that is later
  // turned off — would otherwise still fan out here. Honor the owner directive:
  // when the network is disabled, no blog post publishes to a spoke; it falls
  // back to the hub-only policy (null) and publishes on the hub instead.
  if (spoke && !spokeBlogNetworkEnabled()) {
    logger.info(`[spoke-routing] spoke blog network disabled — "${spoke}"-targeted post routed to the hub only (set SPOKE_BLOG_NETWORK_ENABLED=true to fan out to spokes)`);
    return null;
  }
  return spoke;
}

// The canonical origin a blog post publishes under: the spoke's own canonical
// origin (from the fleet map, mirroring the Astro build's SITE_DOMAIN) when
// spoke-targeted, else the given hub origin. Never assumes a host prefix at
// the call site — spokeSiteOrigin owns the www/apex decision per domains.json.
function blogOriginForSpoke(spokeKey, hubOrigin) {
  if (!spokeKey) return hubOrigin;
  return spokeSiteOrigin(spokeKey) || hubOrigin;
}

// Convenience for callers that want the full decision in one step (the
// runner's slug repair): the origin this brief's draft will publish on, and
// the spoke key when one is targeted.
function resolvePublishOrigin(brief, hubOrigin) {
  const spoke = resolveSpokeTarget(brief);
  return { origin: blogOriginForSpoke(spoke, hubOrigin), spoke };
}

module.exports = { resolveSpokeTarget, blogOriginForSpoke, resolvePublishOrigin };
