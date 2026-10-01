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

  it('attests {variant, version, tender} from what the capture UI RENDERED at capture time (r3: never recomputed at accept, never a constant), never for prepay', () => {
    // Recorded when the card is saved, from the same flag the capture surfaces render from + the tender in use.
    expect(src).toMatch(/noteRenderedRecurringConsent = useCallback\(\(tender\) => \{[\s\S]{0,500}variant: afterVisit \? 'after_visit_card' : null,[\s\S]{0,200}version: afterVisit \? cur\.version : CONSENT_VERSION,/);
    expect(src).toMatch(/noteRenderedRecurringConsent\(renderedTender\);/);
    expect(src).toMatch(/noteRenderedRecurringConsent\(cardResult\.methodType\);/);
    // r7: every after-visit cohort attests, the held ones included.
    expect(src).toMatch(/!\(pol\?\.afterVisitConsent === true \|\| pol\?\.afterVisitPaused === true \|\| pol\?\.afterVisitAutopayOff === true\)\) return \{\};/);
    expect(src).toMatch(/recurringCardConsentVariant: afterVisit \? 'after_visit_card' : undefined,/);
    expect(src).toMatch(/recurringCardConsentVersion: \(afterVisit \|\| recurringCardSetupIntentIdRef\.current\) \? version : undefined,/);
    // r5: the base card / ACH text's version is attested too, and a newer
    // server-side base copy forces a full reload (the copy lives in the bundle).
    expect(src).toMatch(/const version = rendered \? rendered\.version : \(afterVisit \? cur\.version : CONSENT_VERSION\);/);
    expect(src).toMatch(/body\.collectionPromise\.version !== \(body\.collectionPromise\.variant \? AFTER_VISIT_CONSENT_VERSION : CONSENT_VERSION\)\)\s*\{\s*recurringCardSetupIntentIdRef\.current = null;\s*window\.location\.reload\(\);/);
    expect(src).toMatch(/recurringCardConsentTender: recurringCardSetupIntentIdRef\.current \? tender : undefined,/);
    // r6: the version of the text THIS bundle renders, never the server's.
    expect(src).not.toMatch(/afterVisitConsentVersion \|\| AFTER_VISIT_CONSENT_VERSION/);
    expect(src).toMatch(/afterVisitRenderedRef\.current = \{[\s\S]{0,400}version: AFTER_VISIT_CONSENT_VERSION,/);
  });

  it('the capture surfaces render from the SAME promise flag the attestation reads (server best case AND a setup-only invoice is not the after-visit promise)', () => {
    expect(src).toMatch(/const afterVisitRendered = paymentPreference !== 'prepay_annual'\s*&& data\?\.recurringCardPolicy\?\.afterVisitConsent === true\s*&& !afterVisitInvoiceShape\.setupOnly\s*&& afterVisitDeniedKey !== afterVisitSelectionKey;/);
    // A CONSENT_VARIANT_STALE 409 carries the promise the server would record;
    // a card promise without the after-visit variant is remembered for THIS
    // selection so the reloaded capture renders the base text (no 409 loop).
    expect(src).toMatch(/body\.code === 'CONSENT_VARIANT_STALE' && body\.collectionPromise\?\.tender === 'card'\) \{\s*setAfterVisitDeniedKey\(body\.collectionPromise\.variant \? null : afterVisitSelectionKeyRef\.current\);/);
    expect(src).toMatch(/afterVisitRenderedRef\.current = \{\s*afterVisit: afterVisitRendered,/);
    const renders = src.match(/afterVisit=\{afterVisitRendered\}/g) || [];
    expect(renders.length).toBe(2);
    // Both capture surfaces report the tender the consent was rendered for.
    expect(src.match(/onSuccess\([^)]*, bank \? 'us_bank_account' : 'card'\);/g).length).toBe(3);
  });

  it('r5 audit: the payment-timing copy reads the same server answer as the capture text, is attested, and a PAYMENT_TIMING_REFRESH 409 records the answer for this selection', () => {
    expect(src).toMatch(/const payAfterFirstVisitEffective = \(data\?\.recurringCardPolicy\?\.afterVisitExisting === true \|\| afterVisitForced\)\s*&& afterVisitDeniedKey !== afterVisitSelectionKey;/);
    // r7: a deferred:true refresh forces the after-visit timing for the selection.
    expect(src).toMatch(/if \(body\.afterVisitDeferred === true\) \{\s*setAfterVisitForcedKey\(afterVisitSelectionKeyRef\.current\);/);
    expect(src.match(/payAfterFirstVisit=\{payAfterFirstVisitEffective\}\s*paymentTimingDenied=\{afterVisitDeniedKey === afterVisitSelectionKey\}/g)).toHaveLength(2);
    expect(src).toMatch(/afterVisitTimingShownRef\.current = payAfterFirstVisitEffective && serviceMode !== 'one_time'\s*&& \(afterVisitInvoiceShape\.hasFirstVisitInvoice \|\| afterVisitForced\);/);
    expect(src).toMatch(/afterVisitTimingShown: \(paymentPreference !== 'prepay_annual' && afterVisitTimingShownRef\.current\) \? true : undefined,/);
    expect(src).toMatch(/if \(body\.code === 'PAYMENT_TIMING_REFRESH'\) \{[\s\S]{0,600}setAfterVisitDeniedKey\(afterVisitSelectionKeyRef\.current\);/);
  });

  it('r3 P2: the held cohorts (Auto Pay paused / explicitly off) get a save-only modal title, not "Set up Auto Pay"', () => {
    expect(src).toMatch(/\(paused \|\| autopayOff\) \? 'Save a payment method' : 'Set up Auto Pay'/);
  });

  it('a CONSENT_VARIANT_STALE / ACCEPT_BILLING_CHANGED 409 drops the captured intent and refetches /data so the UI re-renders what the server will record', () => {
    expect(src).toMatch(
      /if \(body\.code === 'CONSENT_VARIANT_STALE' \|\| body\.code === 'ACCEPT_BILLING_CHANGED'\) \{[\s\S]{0,2000}recurringCardSetupIntentIdRef\.current = null;\s*setInlineCardIntent\(null\);\s*await loadEstimate\(\{ preserveSelection: true \}\);/,
    );
  });

  it('the Auto-Pay-off cohort reaches the capture UI and the review copy', () => {
    expect(src.match(/afterVisitAutopayOff === true/g).length).toBeGreaterThanOrEqual(5);
  });
});
