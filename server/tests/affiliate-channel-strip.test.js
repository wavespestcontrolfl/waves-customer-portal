// Affiliate links are WEB-ONLY (owner monetization pilot 2026-08-31): the
// newsletter validator hard-blocks affiliate material and the social share
// convergence point (publishToAll) strips or refuses it — both regardless
// of GATE_AFFILIATE_LINKS, so the posture holds while the lane is dark and
// after a kill-switch flip. One email exception (owner 2026-11-19): the
// Pest Insider's reviewed Amazon tool link with Amazon's sentence.

jest.mock('../models/db', () => {
  const fn = jest.fn();
  fn.transaction = jest.fn();
  return fn;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../config', () => ({ s3: {} }));

const { validateNewsletterDraft } = require('../services/newsletter-validator');
const social = require('../services/social-media');

const AFFILIATE_URL = 'https://www.amazon.com/dp/B000TEST01?tag=wavespest-20';
const BLOG_URL = 'https://www.wavespestcontrol.com/lawn-care/measuring-sprinkler-output/';

describe('newsletter validator: AFFILIATE_LINK_IN_UNAPPROVED_CHANNEL', () => {
  const base = { subject: 'March events', preview_text: 'What is on', newsletter_type: 'service-promo' };

  test('an affiliate/tracking URL in any segment hard-blocks the send', () => {
    for (const seg of [
      { html_body: `<p>Deals at <a href="${AFFILIATE_URL}">this link</a></p>` },
      { text_body: `Deals: https://amzn.to/abc today` },
      { html_body: '<p>ok</p>', preview_text: `via https://shareasale.com/r.cfm?b=1` },
    ]) {
      const { errors } = validateNewsletterDraft({ ...base, html_body: '<p>ok</p>', ...seg });
      expect(errors.join(' ')).toMatch(/AFFILIATE_LINK_IN_UNAPPROVED_CHANNEL/);
    }
  });

  test('ordinary blog links do not trip the channel block', () => {
    const { errors } = validateNewsletterDraft({ ...base, html_body: `<p>Read <a href="${BLOG_URL}">the guide</a></p>` });
    expect(errors.join(' ')).not.toMatch(/AFFILIATE_LINK_IN_UNAPPROVED_CHANNEL/);
  });
});

// The one email exception (owner 2026-11-19): the Pest Insider's reviewed
// Amazon tool link, followed by Amazon's exact sentence, in the body only.
describe('newsletter validator: the Pest Insider tool link', () => {
  const registry = require('../../packages/affiliate-registry');
  const { TOOLS, AMAZON_DISCLOSURE } = require('../services/pest-insider/tools');
  const { TOOL_DISCLOSURE_WINDOW } = require('../services/newsletter-validator');
  const [TOOL] = TOOLS;
  const send = { subject: 'Termites swarm after rain', preview_text: 'What to look for', newsletter_type: 'pest-insider-monthly' };
  const html = (url = TOOL.url, gap = '') => `<p><a class="dm-link" href="${url}">${TOOL.name} on Amazon</a></p>${gap}\n<p>${AMAZON_DISCLOSURE}</p>`;
  const text = (url = TOOL.url) => `${TOOL.name} on Amazon: ${url}\n${AMAZON_DISCLOSURE}`;
  const blocked = (draft) => /AFFILIATE_LINK_IN_UNAPPROVED_CHANNEL/.test(validateNewsletterDraft(draft).errors.join(' '));

  test("a reviewed tool link with Amazon's sentence right after it passes, in both bodies", () => {
    expect(blocked({ ...send, html_body: html(), text_body: text() })).toBe(false);
  });

  test('no other newsletter type gets the exception', () => {
    expect(blocked({ ...send, newsletter_type: 'service-promo', html_body: html() })).toBe(true);
    expect(blocked({ ...send, newsletter_type: 'manual', html_body: '<p>ok</p>', text_body: text() })).toBe(true);
  });

  test("the link needs Amazon's sentence close after it", () => {
    expect(blocked({ ...send, html_body: `<p><a href="${TOOL.url}">${TOOL.name} on Amazon</a></p>` })).toBe(true);
    expect(blocked({ ...send, html_body: `<p>${AMAZON_DISCLOSURE}</p>\n<p><a href="${TOOL.url}">${TOOL.name} on Amazon</a></p>` })).toBe(true);
    expect(blocked({ ...send, html_body: html(TOOL.url, `<p>${'x'.repeat(TOOL_DISCLOSURE_WINDOW)}</p>`) })).toBe(true);
  });

  test('any other affiliate URL still blocks, even with the sentence', () => {
    const index = registry.productIndex();
    for (const url of [
      index.get('ks-adjustable-door-sweep').row.approved_affiliate_url, // an approved row that is not a reviewed tool
      index.get(TOOL.productId).row.plain_url, // the untracked fallback is still a registry URL
      `${TOOL.url}&ascsubtag=email`,
      'https://amzn.to/3abcdef',
    ]) {
      expect(url).toBeTruthy();
      expect(blocked({ ...send, html_body: html(url) })).toBe(true);
    }
  });

  test('the subject and the preview never carry a tool link', () => {
    expect(blocked({ ...send, subject: `${TOOL.name} ${TOOL.url} ${AMAZON_DISCLOSURE}`, html_body: html() })).toBe(true);
    expect(blocked({ ...send, preview_text: `${TOOL.url} ${AMAZON_DISCLOSURE}`, html_body: html() })).toBe(true);
  });
});

describe('social sanitizeShareContent (publishToAll strip point)', () => {
  test('a share whose LINK is affiliate material is refused outright', () => {
    expect(social.sanitizeShareContent({ title: 'T', description: 'D', link: AFFILIATE_URL }).refused).toBe(true);
  });

  test('affiliate material in copy fields is dropped field-by-field; the share survives', () => {
    const out = social.sanitizeShareContent({
      title: 'Clean title',
      description: `Buy via https://amzn.to/abc now`,
      customContent: `<AffiliateLink product="x">y</AffiliateLink>`,
      link: BLOG_URL,
    });
    expect(out.refused).toBe(false);
    expect(out.title).toBe('Clean title');
    expect(out.description).toBe('');
    expect(out.customContent).toBeNull();
  });

  test('per-platform customContent objects are scanned leaf by leaf (Codex r3 P1)', () => {
    const out = social.sanitizeShareContent({
      title: 'T',
      description: 'D',
      customContent: { facebook: 'Clean caption', gbp: `Buy https://amzn.to/abc`, instagram: 'Also clean' },
      link: BLOG_URL,
    });
    expect(out.refused).toBe(false);
    expect(out.customContent).toEqual({ facebook: 'Clean caption', instagram: 'Also clean' });
    const allBad = social.sanitizeShareContent({ customContent: { gbp: `https://amzn.to/abc` }, link: BLOG_URL });
    expect(allBad.customContent).toBeNull();
  });

  test('nested GBP { locationId: caption } maps are scanned leaf by leaf (Codex r5 P1)', () => {
    const out = social.sanitizeShareContent({
      customContent: { facebook: 'Clean', gbp: { loc1: 'Clean too', loc2: 'Buy https://amzn.to/abc' } },
      link: BLOG_URL,
    });
    expect(out.customContent).toEqual({ facebook: 'Clean', gbp: { loc1: 'Clean too' } });
    const allBad = social.sanitizeShareContent({ customContent: { gbp: { loc1: 'https://amzn.to/abc' } }, link: BLOG_URL });
    expect(allBad.customContent).toBeNull();
  });

  test('validateContent — the last check on every FINAL platform text — rejects affiliate material generated after input sanitization (Codex r6 P1)', () => {
    const { validateContent } = social._internals || {};
    const check = validateContent || social.validateContent;
    expect(check(`New guide! Grab the gauge at amzn.to/abc`, 'facebook').valid).toBe(false);
    expect(check(`New guide! Read it at ${BLOG_URL}`, 'facebook').issues.some((i) => /AFFILIATE/.test(i))).toBe(false);
  });

  test('postToSingle (admin publish-single + tech-social path) applies the same guard', async () => {
    process.env.SOCIAL_AUTOMATION_ENABLED = 'true';
    try {
      const res = await social.postToSingle('facebook', { title: 'T', description: 'D', link: AFFILIATE_URL });
      expect(res.success).toBe(false);
      expect(res.error).toBe('AFFILIATE_LINK_IN_UNAPPROVED_CHANNEL');
    } finally {
      delete process.env.SOCIAL_AUTOMATION_ENABLED;
    }
  });

  test('publishToAll surfaces the refusal before any platform work', async () => {
    process.env.SOCIAL_AUTOMATION_ENABLED = 'true';
    try {
      const res = await social.publishToAll({ title: 'T', description: 'D', link: AFFILIATE_URL, guid: AFFILIATE_URL, source: 'rss' });
      expect(res.success).toBe(false);
      expect(res.platforms[0].skipped).toBe('AFFILIATE_LINK_IN_UNAPPROVED_CHANNEL');
    } finally {
      delete process.env.SOCIAL_AUTOMATION_ENABLED;
    }
  });
});
