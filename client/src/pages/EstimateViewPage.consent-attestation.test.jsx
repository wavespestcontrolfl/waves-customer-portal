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

  it('ONE timing answer (owner 2026-10-01): every surface and the attestation read resolvePaymentTiming, never flags of their own', () => {
    expect(src).toMatch(/const paymentTiming = resolvePaymentTiming\(\{\s*policy: data\?\.recurringCardPolicy,\s*paymentPreference,\s*serviceMode,\s*invoiceShape: afterVisitInvoiceShape,\s*selectionKey: afterVisitSelectionKey,\s*timingAnswer,\s*\}\);/);
    expect(src).toMatch(/const captureTiming = captureTimingProps\(paymentTiming\);\s*const afterVisitRendered = captureTiming\.afterVisit;\s*afterVisitTimingShownRef\.current = paymentTiming\?\.attestTiming === true;/);
    // Both payment-option renders and both capture surfaces take the one answer.
    // Both payment-option renders and the review confirm summary.
    expect(src.match(/paymentTiming=\{paymentTiming\}/g)).toHaveLength(3);
    expect(src.match(/\{\.\.\.captureTiming\}/g)).toHaveLength(2);
    // No surface reads the cohort flags directly any more.
    expect(src).not.toMatch(/afterVisitDeniedKey|afterVisitForcedKey|payAfterFirstVisitEffective|paymentTimingDenied=/);
    expect(src).not.toMatch(/(?:paused|autopayOff|autopayPaused)=\{[^}]*recurringCardPolicy/);
    // The accept's refusals record ONE per-selection answer.
    expect(src).toMatch(/setTimingAnswer\(\{ key: afterVisitSelectionKeyRef\.current, deferred: body\.afterVisitDeferred === true \}\);/);
    // A consent refresh changes the timing only on an explicit "not deferred".
    expect(src).toMatch(/if \(body\.collectionPromise\.deferred === false\) \{\s*setTimingAnswer\(\{ key: afterVisitSelectionKeyRef\.current, deferred: false \}\);/);
    expect(src).toMatch(/\? \(paymentTiming\?\.firstInvoice === 'after_visit'\s*\? `\$\{existingApptLede\} Nothing is charged today/);
    expect(src).toMatch(/afterVisitTimingShown: \(paymentPreference !== 'prepay_annual' && afterVisitTimingShownRef\.current\) \? true : undefined,/);
    expect(src).toMatch(/afterVisitRenderedRef\.current = \{\s*afterVisit: afterVisitRendered,/);
    // Both capture surfaces report the tender the consent was rendered for.
    expect(src.match(/onSuccess\([^)]*, bank \? 'us_bank_account' : 'card'\);/g).length).toBe(3);
  });

  it('the review line and every non-prepay capture-modal branch disclose a first invoice sent at confirm', () => {
    expect(src).toMatch(/const firstNow = paymentTiming\?\.firstInvoice === 'at_confirm' \? `\$\{FIRST_INVOICE_AT_CONFIRM_COPY\} ` : '';/);
    expect(src.match(/\$\{firstInvoiceNow \? `\$\{FIRST_INVOICE_AT_CONFIRM_COPY\} ` : ''\}/g)).toHaveLength(3);
  });

  it('r3 P2: the held cohorts (Auto Pay paused / explicitly off) get a save-only modal title, not "Set up Auto Pay"', () => {
    expect(src).toMatch(/\(paused \|\| autopayOff\) \? 'Save a payment method' : 'Set up Auto Pay'/);
  });

  it('a CONSENT_VARIANT_STALE / ACCEPT_BILLING_CHANGED 409 drops the captured intent and refetches /data so the UI re-renders what the server will record', () => {
    expect(src).toMatch(
      /if \(body\.code === 'CONSENT_VARIANT_STALE' \|\| body\.code === 'ACCEPT_BILLING_CHANGED'\) \{[\s\S]{0,2000}recurringCardSetupIntentIdRef\.current = null;\s*setInlineCardIntent\(null\);\s*await loadEstimate\(\{ preserveSelection: true \}\);/,
    );
  });

});
