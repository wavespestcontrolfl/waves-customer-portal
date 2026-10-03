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
    // ...and a capture that rendered the setup-fee promise (GATE_PAF_SETUP_FEE).
    expect(src).toMatch(/!\(pol\?\.afterVisitConsent === true \|\| pol\?\.afterVisitPaused === true \|\| pol\?\.afterVisitAutopayOff === true\s*\|\| setupFeeAfterVisitShownRef\.current\)\) return \{\};/);
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
    // A setup fee stamped on the first visit (GATE_PAF_SETUP_FEE) is not "at confirm".
    expect(src).toMatch(/const paymentTiming = resolvePaymentTiming\(\{\s*policy: data\?\.recurringCardPolicy,\s*paymentPreference,\s*serviceMode,[\s\S]{0,200}invoiceShape: setupFeeAfterVisitCopy \? \{ \.\.\.afterVisitInvoiceShape, setupOnly: false \} : afterVisitInvoiceShape,\s*selectionKey: afterVisitSelectionKey,\s*timingAnswer,\s*\}\);/);
    expect(src).toMatch(/const captureTiming = \{ \.\.\.captureTimingProps\(paymentTiming\), afterVisitSetup: !!setupFeeAfterVisitCopy \};[\s\S]{0,120}const afterVisitRendered = captureTiming\.afterVisit \|\| captureTiming\.afterVisitSetup;\s*afterVisitTimingShownRef\.current = paymentTiming\?\.attestTiming === true;/);
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

  it('B18: ALL THREE call sites (accept, card-hold-intent, recurring-card-intent) take an ACCEPT_NEEDS_OFFICE_REVIEW 409 through the ONE transition', () => {
    // The accept handler's 409 branch and both intent responses call the same function.
    expect(src.match(/throw new Error\(await enterContactReviewRef\.current\(body\)\);/g)).toHaveLength(3);
    expect(src).toMatch(/if \(body\.code === 'ACCEPT_NEEDS_OFFICE_REVIEW'\) \{\s*throw new Error\(await enterContactReviewRef\.current\(body\)\);/);
    expect(src).toMatch(/\/card-hold-intent`[\s\S]{0,700}r\.status === 409 && body\.code === 'ACCEPT_NEEDS_OFFICE_REVIEW'\) \{\s*throw new Error\(await enterContactReviewRef\.current\(body\)\);/);
    expect(src).toMatch(/\/recurring-card-intent`[\s\S]{0,700}r\.status === 409 && body\.code === 'ACCEPT_NEEDS_OFFICE_REVIEW'\) \{\s*throw new Error\(await enterContactReviewRef\.current\(body\)\);/);
  });

  it('B18: EVERY client fetch of an endpoint that can answer ACCEPT_NEEDS_OFFICE_REVIEW is accounted for - a new caller fails here until it handles the code', () => {
    const slotPicker = fs.readFileSync(path.join(here, '../components/estimate/SlotPicker.jsx'), 'utf8');
    const count = (text, re) => (text.match(re) || []).length;
    // The estimate page's callers, by endpoint, and how many of each there are (a new one changes the count).
    const endpoint = (name) => new RegExp(String.raw`fetch\(\`\$\{API_BASE\}/(?:public/)?estimates/\$\{token\}/${name}\``, 'g');
    expect(count(src, endpoint('accept'))).toBe(1);
    expect(count(src, endpoint('card-hold-intent'))).toBe(1);
    expect(count(src, endpoint('recurring-card-intent'))).toBe(3); // modal mint, replace-payment-method, inline pre-mint
    expect(count(src, endpoint('reserve'))).toBe(1);
    // ...and each one handles the code through the ONE transition: accept + card-hold + 3 recurring + reserve.
    expect(count(src, /code === 'ACCEPT_NEEDS_OFFICE_REVIEW'/g)).toBe(6);
    // (+1: the SlotPicker's onContactReview callback, asserted below.)
    expect(count(src, /enterContactReviewRef\.current\(body\)/g)).toBe(7);
    // The hold-extend call is covered by the existing no-booking recovery (release the hold, refetch /data -> review state).
    expect(count(src, /\/reserve\/\$\{encodeURIComponent\(scheduledServiceId\)\}\/extend`/g)).toBe(1);
    expect(src).toMatch(/body\.reviewBeforeBooking[\s\S]{0,400}return 'no_booking';/);
    // The slot reads live in SlotPicker (3 fetches: default window, AI find, picked date), each hands the review shape up.
    expect(count(slotPicker, /\/public\/estimates\/\$\{token\}\/(?:available-slots|find-slots)/g)).toBe(3);
    expect(count(slotPicker, /isContactReview\(body\)/g)).toBe(3);
    expect(src).toMatch(/onContactReview=\{\(body\) => enterContactReviewRef\.current\(body\)\.catch\(\(\) => \{\}\)\}/);
  });

  it('B18: the replace-payment-method call and the inline pre-mint effect take the park through the transition too (not silently ignored)', () => {
    // replace-payment-method: transitions, then reports "no new intent".
    expect(src).toMatch(/replaceSetupIntentId: setupIntentId \}\),\s*\}\);\s*const body = await r\.json\(\)\.catch\(\(\) => \(\{\}\)\);\s*if \(r\.status === 409 && body\.code === 'ACCEPT_NEEDS_OFFICE_REVIEW'\) \{\s*await enterContactReviewRef\.current\(body\);\s*return false;\s*\}/);
    // inline pre-mint: transitions BEFORE its resolve-time staleness check (a stale tab still leaves checkout).
    expect(src).toMatch(/if \(r\.status === 409 && body\.code === 'ACCEPT_NEEDS_OFFICE_REVIEW'\) \{\s*await enterContactReviewRef\.current\(body\);\s*return;\s*\}\s*\/\/ Staleness re-check at RESOLVE time/);
    // reserve: leaves the booking UI before the generic 409 handling.
    expect(src).toMatch(/if \(body\.code === 'ACCEPT_NEEDS_OFFICE_REVIEW'\) \{[^}]*await enterContactReviewRef\.current\(body\);\s*return;\s*\}\s*const message = body\.error \|\| 'Unable to reserve this slot\.';/);
  });

  it('B18: a failed hold release in the transition keeps the hold id in the existing pending-recovery ref (after one retry), never drops it', () => {
    expect(src).toMatch(
      /let released = await releaseHeldReservation\(heldId\);\s*if \(!released\) released = await releaseHeldReservation\(heldId\);\s*if \(!released && heldId\) pendingRecoveryHoldRef\.current = heldId;[\s\S]{0,300}try \{ await loadEstimate\(\{ preserveSelection: true \}\); \} catch/,
    );
    // The ref it uses is the recovery's own: set before recoverFromDeadHold's release and its retry fallback.
    expect(src).toMatch(/pendingRecoveryHoldRef\.current = deadHoldId;/);
    expect(src).toMatch(/reservationRef\.current\?\.scheduledServiceId\s*\|\| pendingRecoveryHoldRef\.current/);
  });

  it('B18: a CUSTOMER_BUSY_RETRY on reserve is retryable with the server sentence - the picked slot and payment choice are KEPT', () => {
    expect(src).toMatch(
      /if \(body\.code === 'CUSTOMER_BUSY_RETRY'\) \{[^}]*setError\(message\);\s*setCtaPhase\('configure'\);\s*return;\s*\}\s*setPaymentPreference\(null\);\s*setSelectedSlotId\(null\);/,
    );
  });

  it('B18: the one transition drops every captured/minted card, releases the slot hold and refetches /data (the review state)', () => {
    expect(src).toMatch(
      /enterContactReviewRef\.current = async \(body\) => \{\s*recurringCardSetupIntentIdRef\.current = null;\s*setInlineCardIntent\(null\);\s*recurringCardIntentOpenRef\.current = false;\s*setRecurringCardIntent\(null\);\s*cardHoldSetupIntentIdRef\.current = null;\s*setCardHoldIntent\(null\);[\s\S]{0,2000}await releaseHeldReservation\(heldId\);[\s\S]{0,400}await loadEstimate\(\{ preserveSelection: true \}\)/,
    );
  });

  it('r5 P2: the review state is committed locally from the 409 body BEFORE any network call, and the refetch is best effort (caught)', () => {
    const transition = src.slice(src.indexOf('enterContactReviewRef.current = async (body) => {'), src.indexOf('// The ONE recovery for a hold that is definitively gone'));
    const commit = transition.indexOf("reviewReason: 'contact_review'");
    expect(transition).toMatch(/canAccept: false, reviewBeforeBooking: true, reviewReason: 'contact_review', reviewMessage: sentence/);
    expect(commit).toBeGreaterThan(0);
    expect(commit).toBeLessThan(transition.indexOf('await releaseHeldReservation(heldId)'));
    expect(commit).toBeLessThan(transition.indexOf('loadEstimate('));
    expect(transition).toMatch(/try \{ await loadEstimate\(\{ preserveSelection: true \}\); \} catch \{[^}]*\}\s*return sentence;/);
  });

  it('a CONSENT_VARIANT_STALE / ACCEPT_BILLING_CHANGED 409 drops the captured intent and refetches /data so the UI re-renders what the server will record', () => {
    expect(src).toMatch(
      /if \(body\.code === 'CONSENT_VARIANT_STALE' \|\| body\.code === 'ACCEPT_BILLING_CHANGED'\) \{[\s\S]{0,2000}recurringCardSetupIntentIdRef\.current = null;\s*setInlineCardIntent\(null\);\s*await loadEstimate\(\{ preserveSelection: true \}\);/,
    );
  });

});
