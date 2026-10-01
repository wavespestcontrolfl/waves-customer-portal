// @vitest-environment node
// GATE_PAF_EXISTING_CUSTOMERS (GitHub Codex #5481 r1 P1): the accept PUT
// attests the card-authorization variant + version THIS TAB RENDERED, and the
// page recovers from the server's reloadable 409s. The page itself is far too
// heavy to mount for this, so the wiring is pinned from source (same approach
// as the server-side route pins) and the version constant against the server.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { AFTER_VISIT_CONSENT_VERSION } from '../lib/paymentMethodConsentText';
import serverConsent from '../../../server/services/payment-method-consent-text';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(here, 'EstimateViewPage.jsx'), 'utf8');

describe('EstimateViewPage accept consent attestation', () => {
  it('the client version constant mirrors the server one (the server verifies it)', () => {
    expect(AFTER_VISIT_CONSENT_VERSION).toBe(serverConsent.AFTER_VISIT_CONSENT_VERSION);
  });

  it('sends the variant + version only when the after_visit_card text is what the capture UI renders, never for prepay', () => {
    expect(src).toMatch(
      /recurringCardConsentVariant: \(paymentPreference !== 'prepay_annual' && data\?\.recurringCardPolicy\?\.afterVisitConsent === true\)\s*\? 'after_visit_card' : undefined,/,
    );
    expect(src).toMatch(
      /recurringCardConsentVersion: \(paymentPreference !== 'prepay_annual' && data\?\.recurringCardPolicy\?\.afterVisitConsent === true\)\s*\? AFTER_VISIT_CONSENT_VERSION : undefined,/,
    );
  });

  it('the attestation is keyed off the SAME flag the capture UI uses to render the after-visit text', () => {
    const renders = src.match(/afterVisit=\{paymentPreference !== 'prepay_annual' && data\?\.recurringCardPolicy\?\.afterVisitConsent === true\}/g) || [];
    expect(renders.length).toBe(2);
  });

  it('a CONSENT_VARIANT_STALE / ACCEPT_BILLING_CHANGED 409 drops the captured intent and refetches /data so the UI re-renders what the server will record', () => {
    expect(src).toMatch(
      /if \(body\.code === 'CONSENT_VARIANT_STALE' \|\| body\.code === 'ACCEPT_BILLING_CHANGED'\) \{[\s\S]{0,700}recurringCardSetupIntentIdRef\.current = null;[\s\S]{0,200}await loadEstimate\(\{ preserveSelection: true \}\);/,
    );
  });

  it('the Auto-Pay-off cohort reaches the capture UI and the review copy', () => {
    expect(src.match(/afterVisitAutopayOff === true/g).length).toBeGreaterThanOrEqual(5);
  });
});
