const fs = require('fs');
const path = require('path');

jest.mock('nodemailer', () => ({
  createTransport: jest.fn(() => ({
    sendMail: jest.fn().mockResolvedValue({ messageId: 'smtp-1' }),
  })),
}));

const nodemailer = require('nodemailer');
const {
  wrapEmail,
  wrapServiceEmail,
  ctaButton,
  stripeFooterLine,
  bodyIsDarkAware,
} = require('../services/email-template');
const { renderTemplate } = require('../services/email-template-library');
const { BUSINESS_PHONE } = require('../services/contracts');
const { WAVES_SUPPORT_PHONE_DISPLAY, WAVES_BRAND_NAME } = require('../constants/business');
const { renderAutomationStepContent } = require('../services/automation-runner');
const { buildEmailContent } = require('../services/recruiting-comms');
const { renderFeedbackHtml } = require('../services/newsletter-feedback');
const { renderQuizHtml } = require('../services/newsletter-quiz');
const { buildWinbackDraftRow } = require('../services/newsletter-sunset');
const { assembleWavesNewsletter } = require('../services/newsletter-draft');
const { renderIssue } = require('../services/pest-insider/render');
const { POST_URLS } = require('../services/pest-insider/posts');
const legacyEmail = require('../services/email');

describe('Customer emails audit PR 1 regressions', () => {
  test('email-template uses Waves Pest Control alt text, MSO CTA/preheader safety, 44px footer links, and detail gutter', () => {
    const html = wrapEmail({
      preheader: 'Invoice WPC-1 ready.',
      heading: 'Your invoice is ready',
      intro: 'Hi Taylor.',
      lines: [
        ['Service', 'Quarterly Pest Control'],
        ['Amount due', '$125.00', true],
      ],
      ctaHref: 'https://portal.wavespestcontrol.com/pay/tok',
      ctaLabel: 'Pay $125.00',
      footerNote: stripeFooterLine(),
    });

    expect(html).toContain(`alt="${WAVES_BRAND_NAME}"`);
    expect(html).not.toContain('Waves Pest Control &amp; Lawn Care');
    expect(html).not.toContain('Waves Pest Control & Lawn Care');
    expect(html).toContain('mso-padding-alt:13px 20px;');
    expect(html).toContain('>Pay $125.00</a>');
    expect(html).toContain('mso-hide:all;');
    expect(html).toContain('font-size:1px;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;mso-hide:all;');
    expect(html).toContain('padding:3px 0;text-decoration:none;border:0;"><img src="https://portal.wavespestcontrol.com/app-email/apple-app-store-badge.png"');
    expect(html).toContain('padding:12px;text-decoration:none;border:0;"><img src="https://portal.wavespestcontrol.com/app-email/social/facebook.png"');
    expect(html).toContain('<a class="dm-link" href="https://stripe.com"');
    expect(html).toContain('valign="top" style="padding:7px 12px 7px 0;vertical-align:top;');

    const btn = ctaButton('https://portal.wavespestcontrol.com/x', 'Open now');
    expect(btn).toContain('mso-padding-alt:13px 20px;');
    expect(btn).toContain('>Open now</a>');

    const serviceHtml = wrapServiceEmail({ body: '<p>Hi</p>', preheader: 'Preview' });
    expect(serviceHtml).toContain(`alt="${WAVES_BRAND_NAME}"`);
    expect(serviceHtml).toContain('mso-hide:all;');
  });

  test('contracts and AI assistant fallback use canonical support phone, never (941) 318-7612', () => {
    expect(BUSINESS_PHONE).toBe(WAVES_SUPPORT_PHONE_DISPLAY);
    expect(BUSINESS_PHONE).not.toContain('318-7612');

    const assistantSrc = fs.readFileSync(
      path.join(__dirname, '../services/ai-assistant/assistant.js'),
      'utf8',
    );
    expect(assistantSrc).not.toContain('318-7612');
  });

  test('email-template-library keeps 14px minimum text, detail gutter, safe image URLs, and escaped unsubscribe URL', () => {
    const rendered = renderTemplate({
      template: { template_key: 'custom.notice', name: 'Notice', mode: 'service' },
      version: {
        subject: 'Hello {{first_name}}',
        preview_text: 'Preview for {{first_name}}',
        blocks: [
          { type: 'details', rows: [{ label: 'Plan', value: 'Quarterly Pest' }] },
          { type: 'image', src: 'javascript:alert(1)', alt: 'Bad' },
          { type: 'image', src: 'mailto:test@example.com', alt: 'BadMailto' },
          { type: 'image', src: 'https://portal.wavespestcontrol.com/ok.png', alt: 'Good' },
          { type: 'cta', variant: 'link', label: 'Details', href: 'https://portal.wavespestcontrol.com/info' },
          { type: 'small_note', content: 'Small note copy' },
        ],
      },
      payload: { first_name: 'Pat' },
      unsubscribeUrl: 'https://portal.wavespestcontrol.com/unsub?a=1&b="x"',
      bodyAppend: { html: 'Follow us', text: 'Follow us' },
    });

    expect(rendered.html).toContain('valign="top" class="dm-muted" style="padding:8px 12px 8px 0;vertical-align:top;');
    expect(rendered.html).not.toContain('font-size:13px');
    expect(rendered.html).not.toContain('javascript:alert(1)');
    expect(rendered.html).not.toContain('BadMailto');
    expect(rendered.html).toContain('src="https://portal.wavespestcontrol.com/ok.png"');
    expect(rendered.html).toContain('href="https://portal.wavespestcontrol.com/unsub?a=1&amp;b=&quot;x&quot;"');
  });

  test('automation-runner passes escaped previewText as preheader and detects darkAwareBody', () => {
    const rendered = renderAutomationStepContent({
      template: { key: 'welcome_drip', name: 'Welcome' },
      htmlBody: '<div class="dm-text"><p>Hi {{first_name}}</p></div>',
      textBody: 'Hi {{first_name}}',
      previewText: 'Welcome {{first_name}} <script>alert(1)</script>',
      customer: { first_name: 'Taylor & Co' },
      asmGroupId: null,
    });

    expect(rendered.html).toContain('Welcome Taylor &amp; Co &lt;script&gt;alert(1)&lt;/script&gt;');
    expect(rendered.html).not.toContain('<script>alert(1)</script>');
    expect(rendered.html).toContain('class="dm-card"');

    const legacy = renderAutomationStepContent({
      template: { key: 'welcome_drip', name: 'Welcome' },
      htmlBody: '<p>Legacy white body</p>',
      textBody: 'Legacy white body',
      customer: { first_name: 'Taylor' },
      asmGroupId: null,
    });
    expect(legacy.html).toContain('class="dm-lightcard"');
  });

  test('recruiting-comms renders inside Waves service shell with gold CTA and no off-brand green', () => {
    const out = buildEmailContent(
      { language: 'en', applicant_name: 'Jordan Rivera' },
      'interview_invite',
      { interview_url: 'https://portal.wavespestcontrol.com/careers/interview/tok123' },
    );

    expect(out.html).toContain('<!DOCTYPE html>');
    expect(out.html).toContain(`alt="${WAVES_BRAND_NAME}"`);
    expect(out.html).toContain('class="dm-gold"');
    expect(out.html).toContain('>Pick a time</a>');
    expect(out.html).not.toContain('#0b5c3f');
    expect(out.html).not.toContain('font-size:12px');

    const received = buildEmailContent(
      { language: 'en', applicant_name: 'Jordan Rivera' },
      'application_received',
      {},
    );
    expect(received.html).toContain('Adam, the owner');
  });

  test('newsletter feedback, quiz, sunset, draft hero, and Pest Insider pass Outlook/dark-mode/typography checks', async () => {
    const token = '11111111-1111-4111-8111-111111111111';
    const feedbackHtml = renderFeedbackHtml({ token });
    expect(feedbackHtml).toContain('color:#04395E');
    expect(feedbackHtml).not.toContain('#1B2C5B');
    expect(feedbackHtml).not.toContain('white-space:nowrap');
    expect(feedbackHtml).toContain('mso-padding-alt:12px 6px;');

    const quizHtml = renderQuizHtml({ token });
    expect(quizHtml).toContain('mso-padding-alt:12px 10px;');

    const winback = buildWinbackDraftRow();
    expect(winback.html_body).toContain('<div class="dm-text">');
    expect(bodyIsDarkAware(winback.html_body)).toBe(true);

    const assembledHtml = await assembleWavesNewsletter({
      greeting: 'Good morning!',
      events: [{
        isHero: true,
        sourceTitle: 'Bradenton Farmers Market',
        imageUrl: 'https://portal.wavespestcontrol.com/hero.jpg',
        dateStr: 'Saturday',
        location: 'Old Main St',
        hook: 'Fresh local produce.',
        heroWhy: 'Best Saturday morning stroll.',
        eventUrl: 'https://example.com/market',
      }, {
        sourceTitle: 'Bayfront Concert',
        dateStr: 'Saturday',
        location: 'Riverwalk',
        summary: 'Live music.',
        eventUrl: 'https://example.com/concert',
      }],
      communityNotes: ['Bring sunscreen'],
    });
    expect(assembledHtml).toContain('<!--[if mso]><img src="https://portal.wavespestcontrol.com/hero.jpg"');
    expect(assembledHtml).toContain('width="544"');
    expect(assembledHtml).not.toContain('font-size:13px');

    const [reviewedPostUrl] = [...POST_URLS];
    const pestInsider = renderIssue({
      sendDate: '2026-11-28',
      subject: 'Winter Ant Guide',
      preview: 'Spot ghost ants early',
      lead: {
        headline: 'Dry eggs, wet future',
        sentences: [{ text: 'The CDC says eggs survive 8 months.' }],
        postUrl: reviewedPostUrl,
      },
      idItem: {
        text: 'It raises a generation in about a week.',
        species: {
          slug: 'aedes-mosquito',
          name: 'Aedes Mosquito',
          scientific: 'Aedes aegypti',
          verdict: 'watch',
        },
      },
      credits: [{
        subject: 'Aedes mosquito',
        author: 'Alex Wild',
        site: 'Wikimedia Commons',
        source: 'https://commons.wikimedia.org/wiki/File:Aedes.jpg',
        license: 'CC BY 4.0',
      }],
    });
    expect(pestInsider.html_body).not.toMatch(/font-size:(?:11|12|13)px/);
    expect(pestInsider.html_body).not.toContain('font-weight:800');
  });

  test('legacy email.js escapes heading/cta and emits stripped plain-text fallback', async () => {
    const prevPw = process.env.GOOGLE_SMTP_PASSWORD;
    process.env.GOOGLE_SMTP_PASSWORD = 'test-smtp-password';
    const sendMail = jest.fn().mockResolvedValue({ messageId: 'smtp-ok' });
    nodemailer.createTransport.mockReturnValue({ sendMail });

    try {
      const html = legacyEmail.wrapHtml({
        heading: 'Alert <img src=x onerror=1>',
        body: '<p>Hello &amp; welcome</p>',
        ctaUrl: 'https://portal.wavespestcontrol.com/a?x=1&y="2"',
        ctaLabel: 'Open <Now>',
      });
      expect(html).toContain('Alert &lt;img src=x onerror=1&gt;');
      expect(html).not.toContain('<img src=x onerror=1>');
      expect(html).toContain('>Open &lt;Now&gt;</a>');

      await legacyEmail.send({
        to: 'customer@example.com',
        subject: 'Update',
        heading: 'Service Update',
        body: '<style>.x{display:none}</style><p>We finished your visit. <a href="https://portal.wavespestcontrol.com/details">See details</a>.</p>',
        ctaUrl: 'https://portal.wavespestcontrol.com/report/1',
        ctaLabel: 'View Report',
      });
      expect(sendMail).toHaveBeenCalledWith(expect.objectContaining({
        text: 'Service Update\n\nWe finished your visit. See details (https://portal.wavespestcontrol.com/details).\n\nView Report: https://portal.wavespestcontrol.com/report/1',
      }));
    } finally {
      if (prevPw === undefined) delete process.env.GOOGLE_SMTP_PASSWORD;
      else process.env.GOOGLE_SMTP_PASSWORD = prevPw;
    }
  });
});
