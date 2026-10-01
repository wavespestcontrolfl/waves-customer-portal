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
    expect(payload.customerBody).toBe('Your Silver WaveGuard plan is confirmed. Nothing is charged today — your card on file is billed after your first visit.');
    expect(payload.customerBody).not.toMatch(/invoice|pay link/i);
    expect(payload.adminBody).toContain('billed after the first visit');
    expect(payload.adminBody).not.toMatch(/Invoice follow-up needed/);
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

  test('the card enrollment records after_visit_card (v12) for a moved existing customer, with prepay_card still winning for in-lane prepay', () => {
    expect(src).toMatch(
      /consentVariant: annualPrepaySelected && recurringCardLaneActive\s*&& RecurringCards\.isPrepayCardAndChargeEnabled\(\)\s*\? 'prepay_card'\s*: \(recurringCardPolicy\.afterVisitCard === true \? 'after_visit_card' : null\)/,
    );
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

  test('every policy shape the resolver now returns for a moved existing customer is on the rail', () => {
    for (const policy of [
      { required: true, exemptReason: null, afterVisitCard: true },
      { required: true, exemptReason: null, afterVisitCard: true, autopayPaused: true },
      { required: false, exemptReason: 'saved_method_consented', afterVisitCard: true },
      { required: false, exemptReason: 'saved_method_consented', afterVisitCard: true, autopayPaused: true },
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
