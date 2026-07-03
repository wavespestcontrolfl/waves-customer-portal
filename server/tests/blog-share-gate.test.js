/**
 * blog-share-gate — the single "may this post be shared to social?" policy
 * (audit P1-10): sharing a non-live post publishes a dead 404 link to every
 * enabled platform, and neither the admin Share button/route nor the legacy
 * content-agent's distribute_to_social checked anything at all.
 */

const { blogPostShareability } = require('../services/content/blog-share-gate');

describe('blogPostShareability', () => {
  test('a live post is shareable', () => {
    expect(blogPostShareability({ id: 'p1', astro_status: 'live' }).ok).toBe(true);
  });

  test('every non-live state is blocked (fail closed)', () => {
    for (const astro_status of [null, undefined, '', 'pr_open', 'build_failed', 'merged', 'publish_failed', 'unpublish_pending']) {
      const r = blogPostShareability({ id: 'p1', astro_status, status: 'published' });
      expect(r.ok).toBe(false);
      expect(r.reason).toMatch(/not live/);
    }
  });

  test('a missing post is blocked', () => {
    expect(blogPostShareability(null).ok).toBe(false);
  });

  test('both consumers actually require the gate (policy cannot drift apart)', () => {
    const fs = require('fs');
    for (const mod of [
      '../routes/admin-content-v2',
      '../services/content/content-agent-tools',
    ]) {
      const src = fs.readFileSync(require.resolve(mod), 'utf8');
      expect(src).toMatch(/blog-share-gate/);
      expect(src).toMatch(/blogPostShareability/);
    }
  });
});
