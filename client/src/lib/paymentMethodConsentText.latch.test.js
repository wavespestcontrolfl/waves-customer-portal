// @vitest-environment jsdom
// Redirect-return latch (codex #5434 r2 P1): the consent text version a
// Stripe-redirected capture was authorized under survives the redirect in
// sessionStorage; a return into a bundle with a different version (or with
// nothing latched) must not restore the capture.
import { afterEach, describe, expect, it } from 'vitest';
import {
  CONSENT_VERSION, clearLatchedConsentVersion, latchConsentVersion, latchedConsentVersionIsCurrent,
} from './paymentMethodConsentText';

afterEach(() => { try { sessionStorage.clear(); } catch { /* jsdom */ } });

describe('consent version latch', () => {
  it('nothing latched ⇒ not current (a bundle from before the latch, or a cleared tab)', () => {
    expect(latchedConsentVersionIsCurrent('estimate:tok')).toBe(false);
  });

  it('latched by this bundle ⇒ current, scoped to the page key', () => {
    latchConsentVersion('estimate:tok');
    expect(latchedConsentVersionIsCurrent('estimate:tok')).toBe(true);
    expect(latchedConsentVersionIsCurrent('estimate:other')).toBe(false);
  });

  it('a latch written by an OLDER bundle is not current for this one', () => {
    sessionStorage.setItem('waves-ccv:estimate:tok', 'v11_2026-08-25');
    expect(CONSENT_VERSION).not.toBe('v11_2026-08-25');
    expect(latchedConsentVersionIsCurrent('estimate:tok')).toBe(false);
  });

  it('clear removes the latch; defaults key on the page path', () => {
    latchConsentVersion();
    expect(latchedConsentVersionIsCurrent()).toBe(true);
    clearLatchedConsentVersion();
    expect(latchedConsentVersionIsCurrent()).toBe(false);
  });
});
