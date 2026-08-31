// Affiliate links are WEB-ONLY (owner monetization pilot 2026-08-31): the
// newsletter validator hard-blocks affiliate material and the social share
// convergence point (publishToAll) strips or refuses it — both regardless
// of GATE_AFFILIATE_LINKS, so the posture holds while the lane is dark and
// after a kill-switch flip.

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
