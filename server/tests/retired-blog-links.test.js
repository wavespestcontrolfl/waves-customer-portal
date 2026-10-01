/**
 * Seeded briefs persist their internal_links when queued; the overlays
 * resolve them at compose time so a row queued before the 2026-10-01 blog
 * prune never requires a link to a retired URL (Codex r11 on #5510: the
 * P10 fire-ant seed was already in opportunity_queue).
 */
const { resolveRetiredLinks, resolveRetiredText } = require('../services/content/retired-blog-links');
const category = require('../services/content/category-seed-seeder');

test('a redirected retired link becomes its merge target; a no-redirect retirement is dropped; duplicates collapse', () => {
  expect(resolveRetiredLinks([
    '/pest-control/get-rid-of-fire-ants/',
    'https://www.wavespestcontrol.com/pest-control/get-rid-of-fire-ants',
    '/pest-control/fire-ant-treatment-bradenton-fl/',
    '/lawn-care/kid-safe-lawn/',
    '/pest-control-services/',
  ])).toEqual(['/pest-control/fire-ant-treatment-bradenton-fl/', '/pest-control-services/']);
  expect(resolveRetiredLinks(undefined)).toEqual([]);
});

test('writer notes naming a retired URL point at the merge target', () => {
  expect(resolveRetiredText('Verify /pest-control/get-rid-of-fire-ants/ resolves on the live sitemap.'))
    .toBe('Verify /pest-control/fire-ant-treatment-bradenton-fl/ resolves on the live sitemap.');
});

test('a category-seed row persisted with a retired link composes a brief that requires the merge target', () => {
  const overlay = category._internals?.buildCategoryOverlay
    ? category._internals.buildCategoryOverlay
    : category.buildCategoryOverlay;
  const opportunity = { signal_metadata: { category_brief: {
    id: 'P10', service: 'pest', outline: ['x'], internal_links: ['/pest-control-services/', '/pest-control/get-rid-of-fire-ants/'],
    verify_notes: ['Verify /pest-control/get-rid-of-fire-ants/ resolves.'],
  } } };
  const res = overlay({ opportunity, pageType: 'supporting-blog' });
  const ob = res.operator_brief || res;
  expect(JSON.stringify(ob)).not.toContain('/pest-control/get-rid-of-fire-ants/');
  expect(JSON.stringify(ob)).toContain('/pest-control/fire-ant-treatment-bradenton-fl/');
});

test('intercept and spoke overlays: binding instructions name the merge target, never the retired URL (codex r12)', () => {
  const intercept = require('../services/content/intercept-brief-seeder');
  const spoke = require('../services/content/spoke-seed-seeder');
  const iOverlay = intercept.buildOperatorOverlay;
  const sOverlay = spoke.buildSpokeOverlay || spoke._internals?.buildSpokeOverlay;
  const links = ['/pest-control/get-rid-of-paper-wasps/', '/pest-control-services/'];
  if (iOverlay) {
    const out = JSON.stringify(iOverlay({ opportunity: { signal_metadata: { intercept_brief: { id: 'A3', outline: ['x'], internal_links: links, verify_notes: ['Verify /pest-control/get-rid-of-paper-wasps/ resolves.'] } } }, pageType: 'supporting-blog' }));
    expect(out).not.toContain('/pest-control/get-rid-of-paper-wasps/');
    expect(out).toContain('/pest-control/get-rid-of-wasps/');
  }
  if (sOverlay) {
    const out = JSON.stringify(sOverlay({ opportunity: { signal_metadata: { target_sites: ['sarasotaflpestcontrol.com'], spoke_target_site: 'sarasotaflpestcontrol.com', spoke_brief: { id: 'SAR9', outline: ['x'], internal_links: links, hub_link: '/pest-control/get-rid-of-paper-wasps/', target_site: 'sarasotaflpestcontrol.com' } } }, pageType: 'supporting-blog' }) || {});
    expect(out).not.toContain('/pest-control/get-rid-of-paper-wasps/');
  }
  expect(Boolean(iOverlay && sOverlay)).toBe(true);
});
