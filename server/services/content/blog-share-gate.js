/**
 * blog-share-gate.js — the ONE policy for "may this blog post be shared to
 * social media right now?"
 *
 * A share posts a link to every enabled platform (FB/IG/LinkedIn/GBP), so
 * the post's content must be verifiably LIVE first: astro_status === 'live'.
 * Anything else — draft, scheduled, PR open, build failed, merged-but-not-
 * deployed — publishes a dead 404 link under the brand's name (audit
 * P1-10; both the admin "Share to Social Media" button and the legacy
 * content-agent's distribute_to_social had no check at all).
 *
 * Deliberately fail-closed: a legacy published row that predates the Astro
 * live-flip machinery and never had astro_status stamped is blocked too —
 * the returned reason tells the operator why, and a registry sync of live
 * content stamps the status. The scheduled-share lane needs no gate here:
 * content-scheduler only calls sharePublishedBlog after it has observed
 * astro_status === 'live' itself.
 *
 * Shared by routes/admin-content-v2 (share-social) and the content-agent
 * distribute_to_social tool so the policy can never drift between them.
 */

function blogPostShareability(post) {
  if (!post) return { ok: false, reason: 'post_not_found' };
  if (String(post.astro_status || '') !== 'live') {
    return {
      ok: false,
      reason: `post is not live (astro_status=${post.astro_status || 'none'}) — sharing now would post a dead link to every enabled social platform. Publish the post and wait for it to go live first.`,
    };
  }
  return { ok: true };
}

module.exports = { blogPostShareability };
