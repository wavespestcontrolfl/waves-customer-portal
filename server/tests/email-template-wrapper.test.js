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
});
