/**
 * Pins the centralized email fallback gate.
 *
 * The legacy SMTP / hardcoded-HTML fallback bypasses email_messages,
 * email_suppressions, unsubscribe headers, and SendGrid events, so it must
 * stay disabled in production. That decision used to be copy-pasted into five
 * files with only one pinned by a test — this suite pins the single shared
 * helper AND statically guards that no caller silently re-introduces a local
 * gate (which could re-open an SMTP bypass in prod with no failing test).
 */

const fs = require('fs');
const path = require('path');

const GATE_CALLERS = [
  'services/invoice-email.js',
  'services/estimate-auto-renew.js',
  'services/onboarding-follow-up.js',
  'routes/admin-estimates.js',
  'services/service-report/email-delivery.js',
];

describe('email fallback gate', () => {
  const ORIGINAL_ENV = process.env.NODE_ENV;
  afterEach(() => {
    process.env.NODE_ENV = ORIGINAL_ENV;
    jest.resetModules();
  });

  function loadGate() {
    jest.resetModules();
    return require('../services/email-fallback-gate');
  }

  it('disables the fallback in production', () => {
    process.env.NODE_ENV = 'production';
    const gate = loadGate();
    expect(gate.emailFallbackAllowed()).toBe(false);
    expect(gate.smtpFallbackAllowed()).toBe(false);
    expect(gate.legacyTemplateFallbackAllowed()).toBe(false);
  });

  it('allows the fallback outside production', () => {
    for (const env of ['development', 'staging', 'test', undefined]) {
      process.env.NODE_ENV = env;
      const gate = loadGate();
      expect(gate.emailFallbackAllowed()).toBe(true);
      expect(gate.smtpFallbackAllowed()).toBe(true);
      expect(gate.legacyTemplateFallbackAllowed()).toBe(true);
    }
  });

  it('exposes smtp/legacy aliases pointing at the same gate', () => {
    const gate = loadGate();
    expect(gate.smtpFallbackAllowed).toBe(gate.emailFallbackAllowed);
    expect(gate.legacyTemplateFallbackAllowed).toBe(gate.emailFallbackAllowed);
  });

  describe('every caller imports the shared gate (no inline re-definition)', () => {
    it.each(GATE_CALLERS)('%s uses the shared email-fallback-gate', (relPath) => {
      const source = fs.readFileSync(path.join(__dirname, '..', relPath), 'utf8');
      // Must import the shared module...
      expect(source).toMatch(/require\(['"][^'"]*email-fallback-gate['"]\)/);
      // ...and must NOT re-declare a local gate function (the regression we fixed).
      expect(source).not.toMatch(/function\s+(smtpFallbackAllowed|legacyTemplateFallbackAllowed)\s*\(/);
    });
  });
});
