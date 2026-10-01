process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

// PR-B (GATE_PAF_EXISTING_CUSTOMERS, owner ruling 2026-09-30/10-01): existing
// customers adding a service save/use a card and pay AFTER the visit. The
// policy matrix lives in recurring-card-on-file.test.js and the /data flags in
// estimate-public-pay-after-first-visit-data.test.js; this file pins the rest
// of the mechanism: the accept notification copy, the consent variant the
// accept records, the lane the shared predicate drives, and the paused-Auto-
// Pay contract (no auto-charge, pay link after the visit, pause never lifted).

const fs = require('fs');
const path = require('path');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
const { buildAcceptNotificationPayload } = require('../routes/estimate-public');
const { payAfterFirstVisitInvoiceRail } = require('../services/recurring-card-on-file');

describe('accept notification copy (existing customer on the card rail)', () => {
  const base = { customerName: 'Pat Tester', waveguardTier: 'Silver', monthlyTotal: 60, invoiceMode: false, invoicePayUrl: null };

  test('gate off / not an existing-customer rail accept: today\'s "follow up with the invoice details" copy, byte for byte', () => {
    const payload = buildAcceptNotificationPayload(base);
    expect(payload.customerBody).toBe('Your Silver WaveGuard plan is confirmed. Our team will follow up with the invoice details.');
    expect(payload.adminBody).toMatch(/Invoice follow-up needed\.$/);
    expect(buildAcceptNotificationPayload({ ...base, afterVisitBilling: false })).toEqual(payload);
  });

  test('afterVisitBilling: says the card on file is billed after the first visit and promises no invoice or pay link', () => {
    const payload = buildAcceptNotificationPayload({ ...base, afterVisitBilling: true });
    expect(payload.customerTitle).toBe('Estimate accepted');
    // Tender-neutral: a us_bank_account capture (GATE_ACCEPT_ACH_CAPTURE) is not "a card".
    expect(payload.customerBody).toBe('Your Silver WaveGuard plan is confirmed. Nothing is charged today — your saved payment method is billed after your first visit.');
    expect(payload.customerBody).not.toMatch(/\bcard\b|invoice|pay link/i);
    expect(payload.adminBody).toContain('billed after the first visit');
    expect(payload.adminBody).not.toMatch(/Invoice follow-up needed/);
  });

  test('afterVisitBilling + afterVisitPaused: card kept, nothing charged, a pay link follows the visit (never promises an automatic charge)', () => {
    const payload = buildAcceptNotificationPayload({ ...base, afterVisitBilling: true, afterVisitPaused: true });
    expect(payload.customerBody).toBe('Your Silver WaveGuard plan is confirmed. Nothing is charged today. Your Auto Pay is paused, so we\'ll send you a link to pay after your first visit.');
    expect(payload.customerBody).not.toMatch(/payment method is billed|charged after/i);
    expect(payload.adminBody).toContain('Auto Pay paused');
    expect(payload.adminBody).toContain('no auto-charge');
  });

  test('afterVisitBilling + afterVisitDisabled (explicit Auto Pay opt-out): neutral pay-link-after-the-visit copy, no charge promise, no "paused" claim', () => {
    const payload = buildAcceptNotificationPayload({ ...base, afterVisitBilling: true, afterVisitDisabled: true });
    expect(payload.customerBody).toBe('Your Silver WaveGuard plan is confirmed. Nothing is charged today. We\'ll send you a link to pay after your first visit.');
    expect(payload.customerBody).not.toMatch(/paused|billed after|charged after/i);
    expect(payload.adminBody).toContain('Auto Pay off');
    expect(payload.adminBody).toContain('not enrolled');
    // Paused wins when both somehow arrive.
    expect(buildAcceptNotificationPayload({ ...base, afterVisitBilling: true, afterVisitDisabled: true, afterVisitPaused: true }))
      .toEqual(buildAcceptNotificationPayload({ ...base, afterVisitBilling: true, afterVisitPaused: true }));
  });

  test('afterVisitPaused / afterVisitDisabled alone (no rail accept) change nothing', () => {
    expect(buildAcceptNotificationPayload({ ...base, afterVisitPaused: true })).toEqual(buildAcceptNotificationPayload(base));
    expect(buildAcceptNotificationPayload({ ...base, afterVisitDisabled: true })).toEqual(buildAcceptNotificationPayload(base));
  });

  test('afterVisitBilling never overrides a branch that really sent a pay link (payer fallback re-opened delivery)', () => {
    const payload = buildAcceptNotificationPayload({
      ...base, afterVisitBilling: true, invoiceMode: true, invoiceLinkDelivered: true, invoicePayUrl: '/pay/tok',
    });
    expect(payload.customerBody).toMatch(/invoice pay link/);
  });
});

describe('accept route wiring (source pins)', () => {
  const src = read('routes/estimate-public.js');

  test('the card enrollment records after_visit_card (v12) for a moved existing customer who captures a card (NOT a paused one: never auto-charged), with prepay_card still winning for in-lane prepay', () => {
    expect(src).toMatch(
      /const recurringCardAfterVisitVariant = recurringCardPolicy\.required === true\s*&& recurringCardPolicy\.afterVisitCard === true\s*&& !RecurringCards\.afterVisitHeld\(recurringCardPolicy\)\s*\? 'after_visit_card' : null;/,
    );
    expect(src).toMatch(
      /consentVariant: annualPrepaySelected && recurringCardLaneActive\s*&& RecurringCards\.isPrepayCardAndChargeEnabled\(\)\s*\? 'prepay_card'[\s\S]{0,400}: recurringCardAfterVisitVariant,/,
    );
  });

  test('the variant is stamped on the estimate with the accepted SetupIntent so webhook recovery records the same text', () => {
    expect(src).toMatch(/recurringCardVerification\?\.ok && recurringCardVerification\.setupIntentId && recurringCardAfterVisitVariant/);
    expect(src).toMatch(/'\{acceptedRecurringCardConsentVariant\}', to_jsonb\(\?::text\)\)",\s*\[recurringCardAfterVisitVariant\]/);
  });

  test('the accept notification flag requires the sub-gate, the marker and the lane', () => {
    expect(src).toMatch(
      /afterVisitBilling: recurringCardPolicy\.afterVisitCard === true\s*&& recurringCardLaneActive\s*&& require\('\.\.\/config\/feature-gates'\)\.pafExistingCustomersLive\(\)/,
    );
  });

  test('no pay link at accept rides the SAME shared lane predicate the new-customer rail uses (no second inline predicate)', () => {
    expect(src).toMatch(/const recurringCardLaneActive = RecurringCards\.payAfterFirstVisitInvoiceRail\(recurringCardPolicy\);/);
    expect(src).toMatch(/if \(recurringCardLaneActive && standardInvoiceAttached\) \{[\s\S]{0,900}invoiceModeResult = false;\s*invoicePayUrlResult = null;/);
  });

  test('render attestation: the accept 409s CONSENT_VARIANT_STALE when the recorded variant differs from the one the page rendered (never records unseen text)', () => {
    // Checked only when a card is captured (a consent row is recorded) and not for prepay.
    expect(src).toMatch(/if \(recurringCardPolicy\.required === true && !annualPrepaySelected\) \{[\s\S]{0,1400}code: 'CONSENT_VARIANT_STALE'/);
    // Version is verified against the server's own constant, variant against the live-recomputed one.
    expect(src).toMatch(/attestedConsentVersion === require\('\.\.\/services\/payment-method-consent-text'\)\.AFTER_VISIT_CONSENT_VERSION/);
    expect(src).toMatch(/const consentMismatch = recurringCardAfterVisitVariant === 'after_visit_card'\s*\? !attestedAfterVisit\s*: attestedConsentVariant !== '';/);
    expect(src).toMatch(/return res\.status\(409\)\.json\(\{[^}]*code: 'CONSENT_VARIANT_STALE'/);
  });

  test('locked-customer drift aborts the accept with a reloadable 409 BEFORE any conversion / enrollment (inside the accept transaction)', () => {
    expect(src).toMatch(
      /if \(recurringCardPolicy\.afterVisitCard === true\s*&& await RecurringCards\.pafExistingDriftUnderLock\(trx, \{ customerId, policy: recurringCardPolicy \}\)\) \{[\s\S]{0,300}err\.status = 409;[\s\S]{0,120}err\.code = 'ACCEPT_BILLING_CHANGED';\s*throw err;/,
    );
    // ...and it sits before the intent re-read, i.e. before anything is committed or enrolled.
    expect(src.indexOf("err.code = 'ACCEPT_BILLING_CHANGED'")).toBeLessThan(src.indexOf('verifyRecurringCardIntentUnderLock({ setupIntentId: recurringCardVerification.setupIntentId })'));
  });

  test('explicit Auto Pay opt-out: the card is kept but never enrolled, at accept, from a saved card, and in the webhook recovery', () => {
    expect(src).toMatch(/skipEnrollment: recurringCardPolicy\.autopayDisabled === true,/);
    expect(src).toMatch(/&& recurringCardPolicy\.savedMethodRowId && customerId\s*\/\/[^\n]*\n\s*&& recurringCardPolicy\.autopayDisabled !== true\) \{/);
    expect(src).toMatch(/'\{acceptedRecurringCardSkipEnrollment\}', 'true'::jsonb\)/);
    const hook = read('routes/stripe-webhook.js');
    expect(hook).toMatch(/boundToAccept && estimateData\?\.acceptedRecurringCardSkipEnrollment === true\s*\? \{ skipEnrollment: true \}/);
  });

  test('commercial manual billing clears EVERY card-rail shape through one helper in both /data and the accept', () => {
    expect(src.match(/RecurringCards\.applyCommercialManualBillingExemption\(/g)).toHaveLength(2);
    expect(src).toMatch(/applyCommercialManualBillingExemption\(recurringCardPolicyForData,/);
    expect(src).toMatch(/applyCommercialManualBillingExemption\(recurringCardPolicy,/);
  });

  test('/data never advertises in-lane prepay to the moved cohort (prepay resolves as today for them)', () => {
    expect(src).toMatch(
      /prepayInLane: recurringCardLaneActiveForData && RecurringCards\.isPrepayCardAndChargeEnabled\(\)\s*&& recurringCardPolicyForData\.afterVisitCard !== true,/,
    );
    const rc = read('services/recurring-card-on-file.js');
    expect(rc).toMatch(/const pafExisting = require\('\.\.\/config\/feature-gates'\)\.pafExistingCustomersLive\(\)\s*&& paymentMethodPreference !== 'prepay_annual';/);
  });

  test('every policy shape the resolver now returns for a moved existing customer is on the rail', () => {
    for (const policy of [
      { required: true, exemptReason: null, afterVisitCard: true },
      { required: true, exemptReason: null, afterVisitCard: true, autopayPaused: true },
      { required: false, exemptReason: 'saved_method_consented', afterVisitCard: true },
      { required: false, exemptReason: 'saved_method_consented', afterVisitCard: true, autopayPaused: true },
      { required: true, exemptReason: null, afterVisitCard: true, autopayDisabled: true },
    ]) {
      expect(payAfterFirstVisitInvoiceRail(policy)).toBe(true);
    }
    // ...and the exemptions that stay exempt are still off the rail.
    for (const exemptReason of ['existing_plan_customer', 'autopay_paused', 'payer_billed', 'payer_check_uncertain', 'commercial_manual_billing', 'invoice_mode']) {
      expect(payAfterFirstVisitInvoiceRail({ required: false, exemptReason })).toBe(false);
    }
  });
});

describe('paused Auto Pay (owner R5): card kept, no auto-charge, pay link after the visit, pause never lifted', () => {
  const { customerOnAutopay } = require('../services/autopay-eligibility');

  test('a paused customer is never "on Auto Pay", even with a chargeable method (no DB read needed to decide)', async () => {
    const db = jest.fn(() => { throw new Error('no db read expected'); });
    const on = await customerOnAutopay({
      id: 'cust-1', autopay_enabled: true, autopay_paused_until: '2099-01-01', autopay_payment_method_id: 'pm-1', ach_status: null,
    }, { db });
    expect(on).toBe(false);
    expect(db).not.toHaveBeenCalled();
  });

  test('enrollConsentedMethod (the accept\'s enrollment) never writes the pause columns', () => {
    const src = read('services/autopay-enrollment.js');
    expect(src).not.toMatch(/autopay_paused_until/);
    expect(src).not.toMatch(/autopay_pause/);
  });

  test('the accept enrollment / saved-method auto-enroll paths never touch the pause', () => {
    const rc = read('services/recurring-card-on-file.js');
    const completeFn = rc.slice(rc.indexOf('async function completeRecurringCardEnrollment'), rc.indexOf('async function alertEnrollmentNeedsReview'));
    expect(completeFn.length).toBeGreaterThan(500);
    expect(completeFn).not.toMatch(/autopay_paused_until/);
  });

  test('completion: the auto-charge needs customerAutopayActive (false while paused), re-checked live at the charge boundary', () => {
    const src = read('services/complete-scheduled-service.js');
    expect(src).toMatch(/'customers\.autopay_paused_until as cust_autopay_paused_until'/);
    expect(src).toMatch(/const customerAutopayActive = await customerOnAutopay\(\{[\s\S]{0,260}autopay_paused_until: svc\.cust_autopay_paused_until/);
    expect(src).toMatch(/&& !annualPrepayOfficeReview\s*&& customerAutopayActive\) \{/);
    expect(src).toMatch(/\.first\('id', 'autopay_enabled', 'autopay_paused_until', 'autopay_payment_method_id', 'ach_status'\);\s*autopayStillActive = !!freshCustomer && await customerOnAutopayFresh\(freshCustomer\);/);
    expect(src).toMatch(/if \(liveSelfPay && autopayStillActive && isChargeableAutopayMethod\(autopayPm\)\) \{/);
  });

  test('completion: an unpaid attached invoice that was NOT auto-charged keeps its pay link and the completion SMS carries it', () => {
    const src = read('services/complete-scheduled-service.js');
    // The attached (pre-minted) invoice is adopted; unless it is already paid
    // it sets invoiceCreated, and the pay URL is built from its token.
    expect(src).toMatch(/if \(existingCompletionInvoice\) \{\s*invoice = existingCompletionInvoice;[\s\S]{0,700}if \(\['paid', 'prepaid'\]\.includes\(existingCompletionInvoice\.status\)\) alreadyPaid = true;\s*else invoiceCreated = true;/);
    // The charge success paths are the ONLY places that clear the link.
    expect(src).toMatch(/\} else if \(invoiceCreated && payUrl && allowCompletionInvoiceLink\) \{/);
    // Only a paid / prepaid / processing outcome nulls the link in the charge block.
    const chargeBlock = src.slice(src.indexOf('if (liveSelfPay && autopayStillActive'), src.indexOf('Full-balance sweep (owner ruling 2026-08-08)'));
    expect(chargeBlock).toMatch(/\['paid', 'prepaid'\]\.includes\(freshStatus\)/);
    expect(chargeBlock).toMatch(/freshStatus === 'processing'/);
  });
});
