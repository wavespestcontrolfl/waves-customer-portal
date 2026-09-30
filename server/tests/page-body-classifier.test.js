const { classifyPageBody } = require('../services/seo/page-body-classifier');

// Strict mode is the shared challenge detector (link prospect verifier,
// editorial sources, content-registry live status / owned cited-URL health).
const strict = (html) => classifyPageBody(html, 'text/html', { strictChallenge: true });
const REAL_BODY = '<p>Ghost ants are tiny pale ants common in Southwest Florida kitchens.</p>'.repeat(30);
const page = (head = '', body = REAL_BODY) => `<html><head><title>Ghost ants</title>${head}</head><body>${body}</body></html>`;

describe('classifyPageBody strict challenge detection', () => {
  test('Cloudflare JS Detections script on an ordinary page is not a challenge', () => {
    expect(strict(page('<script src="/cdn-cgi/challenge-platform/scripts/jsd/main.js"></script>'))).toBe('html');
  });

  test('interstitial markup is a challenge', () => {
    expect(strict(page('<script>window._cf_chl_opt={cvId:"3"};</script>', ''))).toBe('challenge');
    expect(strict(page('<script src="/cdn-cgi/challenge-platform/h/b/orchestrate/chl_page/v1?ray=1"></script>', ''))).toBe('challenge');
    expect(strict(page('', '<form id="challenge-form"></form>'))).toBe('challenge');
  });

  test('interstitial headings are a challenge', () => {
    expect(strict('<html><head><title>Please wait...</title></head><body>x</body></html>')).toBe('challenge');
    expect(strict('<html><head><title>Security check</title></head><body>x</body></html>')).toBe('challenge');
  });

  test('challenge wording counts only on a thin page', () => {
    expect(strict(page('', '<p>Verify you are human by completing the action below.</p>'))).toBe('challenge');
    expect(strict(page('', `${REAL_BODY}<p>Some sites ask you to verify you are human.</p>`))).toBe('html');
  });

  test('a CAPTCHA widget alone never makes a page a challenge', () => {
    expect(strict(page('', '<p>Short contact page.</p><div class="g-recaptcha"></div>'))).toBe('html');
    expect(strict(page('', '<div class="cf-turnstile"></div>'))).toBe('html');
  });
});
