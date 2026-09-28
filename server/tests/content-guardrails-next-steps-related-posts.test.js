/**
 * Codex r2 on #5216: C2 frontmatter next_steps / related_posts render as
 * links on the published post, so content-guardrails.evaluate() judges them
 * through the SAME chokepoints body links use — every next_steps entry is
 * scanned as the body link it renders as ("[label](href)"): customer-copy
 * checks on the label, internalRouteFinding on the href, plus the publish
 * host for an absolute href. related_posts obeys the same publish-time
 * liveness result (staleRelatedPostLinks / relatedPostLinksLive) the body
 * link guard consumes. The quality gate no longer carries a parallel check.
 */
jest.mock('../models/db', () => jest.fn());

const guardrails = require('../services/content/content-guardrails');
const { deriveSyncGuardrailOptions } = require('../services/content/guardrail-options');

const BODY = 'Fire ants build mounds in sunny turf after summer rain. Look for the raised soil and the swarming workers when disturbed.';
const HUB = ['wavespestcontrol.com'];
const SPOKE = ['bradentonflpestcontrol.com'];

function codes(frontmatter, options = {}, body = BODY) {
  return guardrails.evaluate({ frontmatter, body }, { publishHosts: HUB, ...options }).findings.map((f) => f.code);
}
function blocking(frontmatter, options = {}, body = BODY) {
  return guardrails.evaluate({ frontmatter, body }, { publishHosts: HUB, ...options }).findings
    .filter((f) => f.severity === 'P0' || f.severity === 'P1').map((f) => f.code);
}

describe('next_steps labels are customer copy (Apply content guardrails to next-step labels)', () => {
  test.each([
    ['Pet-safe treatment'],
    ['EPA-approved product'],
    ['Plans from $49 a month'],
  ])('"%s" raises the same finding as a body link with that label', (label) => {
    const asBody = blocking({}, {}, `${BODY}\n\n[${label}](/contact/)`);
    expect(asBody.length).toBeGreaterThan(0);
    const asNextStep = blocking({ next_steps: [{ label, href: '/contact/' }] });
    expect(asNextStep).toEqual(asBody);
  });

  // Codex r7 on #5216 ("Apply the CTA wording gate to next-step labels").
  test('a banned CTA wording in a next-step label is flagged like the same body link', () => {
    const cta = (fm, body = BODY) => guardrails.evaluate({ frontmatter: fm, body }, { publishHosts: HUB, targetIsBlog: true })
      .findings.some((f) => f.code === 'FORBIDDEN_CTA_WORDING');
    expect(cta({}, `${BODY}\n\n[Request an Inspection](/contact/)`)).toBe(true);
    expect(cta({ next_steps: [{ label: 'Request an Inspection', href: '/contact/' }] })).toBe(true);
    // Same rule as a body link: a conversion path needs the estimate wording.
    expect(cta({ next_steps: [{ label: 'Found a live one?', href: '/contact/' }] })).toBe(true);
    expect(cta({ next_steps: [{ label: 'Get My Free Pest Estimate', href: '/contact/' }] })).toBe(false);
    expect(cta({}, `${BODY}\n\n[Get My Free Pest Estimate](/contact/)`)).toBe(false);
  });

  test('a clean label on an allowlisted path passes', () => {
    expect(blocking({ next_steps: [{ label: 'Found a live one?', href: '/contact/' }] })).toEqual([]);
  });

  test('a spoke brand leak in a label is caught by the brand-token guard', () => {
    const r = blocking(
      { next_steps: [{ label: 'Ask Waves Pest Control', href: '/contact/' }] },
      { domains: SPOKE, publishHosts: SPOKE },
    );
    const asBody = blocking({}, { domains: SPOKE, publishHosts: SPOKE }, `${BODY}\n\n[Ask Waves Pest Control](/contact/)`);
    expect(r).toContain('BRAND_TOKEN_LEAK');
    expect(r).toEqual(asBody);
  });

  test('labels are skipped on a refresh (publishRefresh never ships draft frontmatter)', () => {
    const r = guardrails.evaluate(
      { frontmatter: { next_steps: [{ label: 'Pet-safe treatment', href: '/made-up/' }] }, body: BODY },
      { isRefresh: true, priorBody: BODY, publishHosts: HUB },
    ).findings.map((f) => f.code);
    expect(r).toEqual([]);
  });
});

describe('next_steps hrefs go through internalRouteFinding with the publish host (Preserve the publish host)', () => {
  test('an invented relative route fails exactly like a body link to it', () => {
    expect(blocking({ next_steps: [{ label: 'Go', href: '/made-up-route/' }] })).toEqual(['UNKNOWN_INTERNAL_ROUTE']);
    expect(blocking({}, {}, `${BODY}\n\n[Go](/made-up-route/)`)).toEqual(['UNKNOWN_INTERNAL_ROUTE']);
  });

  test('a brief-mandated link is allowed, same as in the body', () => {
    expect(blocking({ next_steps: [{ label: 'Go', href: '/special-page/' }] }, { allowedInternalLinks: ['/special-page/'] })).toEqual([]);
  });

  test('an absolute URL on the resolved publish host passes', () => {
    expect(blocking({ next_steps: [{ label: 'Go', href: 'https://www.wavespestcontrol.com/contact/' }] })).toEqual([]);
    expect(blocking({ next_steps: [{ label: 'Go', href: 'https://www.bradentonflpestcontrol.com/contact/' }] }, { domains: SPOKE, publishHosts: SPOKE })).toEqual([]);
  });

  test('a hub post cannot point a next step at a spoke (the r2 finding), nor a spoke at another spoke or the hub', () => {
    expect(blocking({ next_steps: [{ label: 'Go', href: 'https://www.bradentonflpestcontrol.com/contact/' }] })).toContain('UNKNOWN_INTERNAL_ROUTE');
    expect(blocking({ next_steps: [{ label: 'Go', href: 'https://www.northportflpestcontrol.com/contact/' }] }, { domains: SPOKE, publishHosts: SPOKE })).toContain('UNKNOWN_INTERNAL_ROUTE');
    expect(blocking({ next_steps: [{ label: 'Go', href: 'https://www.wavespestcontrol.com/contact/' }] }, { domains: SPOKE, publishHosts: SPOKE })).toContain('UNKNOWN_INTERNAL_ROUTE');
  });

  test.each([
    ['off-site', 'https://unrelated.example/contact/'],
    ['protocol-relative', '//www.wavespestcontrol.com/contact/'],
    ['ftp scheme', 'ftp://www.wavespestcontrol.com/contact/'],
    ['non-standard port', 'https://www.wavespestcontrol.com:8443/contact/'],
    ['credentials', 'https://user:pw@www.wavespestcontrol.com/contact/'],
    ['bare relative', 'contact/'],
  ])('rejects a %s href', (_label, href) => {
    expect(blocking({ next_steps: [{ label: 'Go', href }] }).length).toBeGreaterThan(0);
  });

  test('an absolute href fails closed when the caller supplied no publish host', () => {
    expect(blocking({ next_steps: [{ label: 'Go', href: 'https://www.wavespestcontrol.com/contact/' }] }, { publishHosts: [] })).toContain('UNKNOWN_INTERNAL_ROUTE');
  });

  test('link syntax inside a label or href cannot forge a second link', () => {
    expect(blocking({ next_steps: [{ label: 'x](/made-up/) [y', href: '/contact/' }] })).toContain('NEXT_STEPS_INVALID');
    expect(blocking({ next_steps: [{ label: 'Go', href: '/contact/) [x](/made-up/' }] })).toContain('NEXT_STEPS_INVALID');
  });

  test('shape: non-array, more than 4, missing label or href all fail closed', () => {
    expect(blocking({ next_steps: { label: 'Go', href: '/contact/' } })).toContain('NEXT_STEPS_INVALID');
    expect(blocking({ next_steps: Array.from({ length: 5 }, () => ({ label: 'Go', href: '/contact/' })) })).toContain('NEXT_STEPS_INVALID');
    expect(blocking({ next_steps: [{ label: '', href: '/contact/' }] })).toContain('NEXT_STEPS_INVALID');
    expect(blocking({ next_steps: [{ label: 'Go' }] })).toContain('NEXT_STEPS_INVALID');
  });

  test('absent next_steps is fine (optional, no minimum — #5062)', () => {
    expect(codes({})).toEqual([]);
  });
});

describe('related_posts obeys the publish-time liveness result (Recheck related-post frontmatter against live targets)', () => {
  const REL = '/blog/pest-control/fire-ant-mounds/';
  const opts = (extra = {}) => ({ relatedPostLinks: [REL], relatedPostHosts: HUB, ...extra });

  test('an exact verified path passes', () => {
    expect(blocking({ related_posts: [REL] }, opts())).toEqual([]);
  });

  test('a path not on the verified list, or differing by case, fails', () => {
    expect(blocking({ related_posts: ['/contact/'] }, opts())).toEqual(['UNKNOWN_INTERNAL_ROUTE']);
    expect(blocking({ related_posts: [REL.toUpperCase()] }, opts())).toEqual(['UNKNOWN_INTERNAL_ROUTE']);
  });

  test('a path the publish-time recheck found stale fails, same as a body link to it', () => {
    const o = opts({ staleRelatedPostLinks: [REL] });
    expect(blocking({ related_posts: [REL] }, o)).toEqual(['UNKNOWN_INTERNAL_ROUTE']);
    expect(blocking({}, o, `${BODY}\n\n[Mounds](${REL})`)).toEqual(['UNKNOWN_INTERNAL_ROUTE']);
  });

  test('every related path fails once the publish routing drifted (relatedPostLinksLive=false), same as a body link', () => {
    const o = opts({ relatedPostLinksLive: false });
    expect(blocking({ related_posts: [REL] }, o)).toEqual(['UNKNOWN_INTERNAL_ROUTE']);
    expect(blocking({}, o, `${BODY}\n\n[Mounds](${REL})`)).toEqual(['UNKNOWN_INTERNAL_ROUTE']);
  });

  test('a non-array or a non-string entry fails closed', () => {
    expect(blocking({ related_posts: REL }, opts())).toContain('RELATED_POSTS_INVALID');
    expect(blocking({ related_posts: [{ path: REL }] }, opts())).toContain('RELATED_POSTS_INVALID');
  });
});

describe('deriveSyncGuardrailOptions supplies the resolved publish host', () => {
  const spokeBrief = { action_type: 'new_supporting_blog', page_type: 'supporting-blog', target_sites: ['bradentonflpestcontrol.com'] };
  afterEach(() => { delete process.env.SPOKE_BLOG_NETWORK_ENABLED; });

  test('hub brief → hub host', () => {
    const hub = deriveSyncGuardrailOptions({}, { action_type: 'new_supporting_blog', page_type: 'supporting-blog' });
    expect(hub.publishHosts).toEqual(['wavespestcontrol.com']);
  });

  test('spoke brief with the network on → that spoke only; with it off → the hub it actually publishes to', () => {
    process.env.SPOKE_BLOG_NETWORK_ENABLED = 'true';
    expect(deriveSyncGuardrailOptions({}, spokeBrief).publishHosts).toEqual(['bradentonflpestcontrol.com']);
    delete process.env.SPOKE_BLOG_NETWORK_ENABLED;
    expect(deriveSyncGuardrailOptions({}, spokeBrief).publishHosts).toEqual(['wavespestcontrol.com']);
  });
});
