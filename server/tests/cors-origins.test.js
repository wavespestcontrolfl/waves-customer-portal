const { allowedOrigins } = require('../config/cors-origins');
const { SPOKE_SITE_KEYS } = require('../services/content-astro/spoke-sites');

// Regression guard for the 2026-07 spoke lead-capture outage: the allowlist
// contained only the hub, so every spoke's quote-wizard / estimate / slider
// POST died in the browser as "Failed to fetch" (preflight answered without
// Access-Control-Allow-Origin). The allowlist must cover the whole fleet.
describe('cors-origins allowlist', () => {
  test('portal + hub origins are allowed', () => {
    expect(allowedOrigins).toContain('https://portal.wavespestcontrol.com');
    expect(allowedOrigins).toContain('https://wavespestcontrol.com');
    expect(allowedOrigins).toContain('https://www.wavespestcontrol.com');
  });

  test('every fleet domain is allowed on both www and apex origins', () => {
    for (const domain of SPOKE_SITE_KEYS) {
      expect(allowedOrigins).toContain(`https://${domain}`);
      expect(allowedOrigins).toContain(`https://www.${domain}`);
    }
  });

  test('the spoke from the original customer report is allowed', () => {
    expect(allowedOrigins).toContain('https://www.bradentonfllawncare.com');
  });

  test('fleet coverage is derived, not hand-counted: every registry domain × 2 hosts + portal', () => {
    // clientUrl (dev/Railway override) may or may not collide with a listed
    // origin, so assert a lower bound rather than an exact length.
    expect(allowedOrigins.length).toBeGreaterThanOrEqual(SPOKE_SITE_KEYS.length * 2 + 1);
  });

  test('no duplicate origins (Socket.io consumes the same list)', () => {
    expect(new Set(allowedOrigins).size).toBe(allowedOrigins.length);
  });
});
