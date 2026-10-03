/**
 * Home-line PR 4: the shared email footer shows the phone the sender passes
 * (the recipient's home line), falling back to the main support line; the
 * template library feeds it from the payload's company_phone.
 */
const { wrapEmail, wrapServiceEmail } = require('../services/email-template');

describe('email footer phone', () => {
  test('wrapServiceEmail shows the passed home line with a matching tel link', () => {
    const html = wrapServiceEmail({ body: '<p>Hi</p>', phone: '(941) 297-2817' });
    expect(html).toContain('href="tel:+19412972817"');
    expect(html).toContain('(941) 297-2817');
    expect(html).not.toContain('(941) 297-5749');
  });

  test('wrapEmail shows the passed home line', () => {
    const html = wrapEmail({ heading: 'Invoice', intro: 'Hi', lines: [], phone: '(941) 297-3337' });
    expect(html).toContain('href="tel:+19412973337"');
  });

  test('no phone, or anything that is not a US number → the main line, as before', () => {
    for (const phone of [undefined, null, '', 'call us', '+44 20 7946 0958']) {
      const html = wrapServiceEmail({ body: '<p>Hi</p>', phone });
      expect(html).toContain('href="tel:+19412975749"');
      expect(html).toContain('(941) 297-5749');
    }
  });
});
