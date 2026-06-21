/**
 * spoke-blog-network.js — single source of truth for the spoke blog network
 * kill switch.
 *
 * Owner directive 2026-06-16: all blog content is consolidated on the hub
 * (wavespestcontrol.com) — blog posts must NOT fan out to spoke domains. The
 * lane is OFF by default; set SPOKE_BLOG_NETWORK_ENABLED=true to re-enable the
 * curated per-spoke blog lane (a single env flip, no code change).
 *
 * Enforced at BOTH ends of the chain so the directive holds regardless of queue
 * state:
 *   - the SEEDING entry point (spoke-seed-seeder.seedAll) — no NEW spoke topics
 *     are queued, and
 *   - the PUBLISHING chokepoint (astro-publisher.resolveSpokeTarget) — even a
 *     spoke-seed row already sitting in opportunity_queue, or one seeded during
 *     a temporary re-enable that is later turned off, never publishes to a spoke
 *     (it falls back to the hub-only policy).
 */

function spokeBlogNetworkEnabled() {
  const v = String(process.env.SPOKE_BLOG_NETWORK_ENABLED || '').trim().toLowerCase();
  return v === 'true' || v === '1' || v === 'on';
}

module.exports = { spokeBlogNetworkEnabled };
