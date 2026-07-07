const {
  wrapEmail,
  wrapServiceEmail,
  wrapNewsletter,
  ensureLegalTextFooter,
} = require('../services/email-template');
const { WAVES_ADDRESS_LINE } = require('../constants/business');

describe('email template wrappers', () => {
  test('include the physical mailing address in customer-facing HTML footers', () => {
    expect(wrapEmail({
      heading: 'Your Waves update',
      intro: '<p>Hi Taylor, your update is ready.</p>',
    })).toContain(WAVES_ADDRESS_LINE);

    expect(wrapServiceEmail({
      body: '<p>Hi Taylor, your update is ready.</p>',
    })).toContain(WAVES_ADDRESS_LINE);

    expect(wrapNewsletter({
      body: '<p>Hi Taylor, here is the latest.</p>',
      unsubscribeUrl: 'https://portal.wavespestcontrol.com/unsubscribe/token',
    })).toContain(WAVES_ADDRESS_LINE);
  });

  test('renders the Google Preferred Sources line only when opted in', () => {
    const ctaUrl = 'https://www.google.com/preferences/source?q=wavespestcontrol.com';

    expect(wrapNewsletter({
      body: '<p>Hi Taylor, here is the latest.</p>',
      unsubscribeUrl: 'https://portal.wavespestcontrol.com/unsubscribe/token',
      preferredSourcesCta: true,
    })).toContain(ctaUrl);

    // Default off — automation drips and library templates that share this
    // wrapper must not grow the CTA without opting in.
    expect(wrapNewsletter({
      body: '<p>Hi Taylor, here is the latest.</p>',
      unsubscribeUrl: 'https://portal.wavespestcontrol.com/unsubscribe/token',
    })).not.toContain(ctaUrl);
  });

  test('keeps the physical mailing address in legal plain-text footers', () => {
    const text = ensureLegalTextFooter('Hi Taylor, here is the latest.', {
      unsubscribeUrl: 'https://portal.wavespestcontrol.com/unsubscribe/token',
    });

    expect(text).toContain(WAVES_ADDRESS_LINE);
    expect(text).toContain('Unsubscribe: https://portal.wavespestcontrol.com/unsubscribe/token');
  });

  test('bounds width for Outlook with an MSO ghost table per wrapper variant', () => {
    // Word's engine ignores max-width, so without the conditional ghost table
    // every email stretches to the full Outlook window width.
    expect(wrapEmail({ heading: 'Update', intro: '<p>Hi.</p>' }))
      .toContain('<!--[if mso]><table role="presentation" width="560"');
    expect(wrapServiceEmail({ body: '<p>Hi.</p>' }))
      .toContain('<!--[if mso]><table role="presentation" width="620"');
    expect(wrapNewsletter({ body: '<p>Hi.</p>', unsubscribeUrl: 'https://x.example/u' }))
      .toContain('<!--[if mso]><table role="presentation" width="640"');
    expect(wrapServiceEmail({ body: '<p>Hi.</p>' }))
      .toContain('<!--[if mso]></td></tr></table><![endif]-->');
  });

  test('pads the hidden preheader so inbox previews do not bleed into the header', () => {
    const html = wrapServiceEmail({ body: '<p>Hi.</p>', preheader: 'Short preview.' });
    expect(html).toContain('Short preview.&nbsp;&zwnj;&nbsp;&zwnj;');
    // No preheader → no hidden div at all (unchanged behavior).
    expect(wrapServiceEmail({ body: '<p>Hi.</p>' })).not.toContain('&nbsp;&zwnj;&nbsp;&zwnj;');
  });
});
