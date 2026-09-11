/**
 * Call-captured email on a PRE-LINKED, non-booking call.
 *
 * Incident 2026-09-11 (customer 7411b13a-3046-4376-b4c8-2d84f32c2ef7): the
 * inbound webhook linked the second and third calls to the customer row
 * minted on the first call, so Step 3's phone-match branch (the only
 * non-booking email backfill) never ran; the booking-branch backfill never
 * ran either, because the office booked the visit by hand. The dictated
 * email sat on call_log.ai_extraction while customers.email stayed null —
 * and the booking sent the no-email prep fallback text instead of the guide
 * email.
 *
 * Rules under test:
 *   • the shared helper fills an EMPTY or GARBLED email from a valid capture
 *     and never overwrites a valid stored email (codex round-12 P2);
 *   • it rides the email-claim guard and only settles the missing-email card
 *     when the guard actually applied the email;
 *   • the pre-linked wiring runs after the phone-match/create chain, gated on
 *     the INBOUND ANI (not a dictated callback number) being the customer's
 *     own, the spoken name not contradicting the record, and never from a
 *     voicemail or a third-party call nature — and NOT on the creation-only
 *     non-customer aggregate, which would skip the existing-customer natures
 *     this repair exists for.
 */

jest.mock('../models/db', () => { const db = jest.fn(); db.raw = jest.fn(); return db; });
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/customer-email-fanout', () => ({
  applyCustomerUpdatesWithEmailClaimGuard: jest.fn(async ({ updates }) => ({ emailApplied: !!updates.email })),
  propagateCustomerEmailChange: jest.fn(async () => {}),
  resolveOpenEmailReviewCards: jest.fn(async () => {}),
}));

const fs = require('fs');
const path = require('path');
const fanout = require('../services/customer-email-fanout');
const { _test } = require('../services/call-recording-processor');

const { backfillLinkedCustomerFromExtraction } = _test;

describe('backfillLinkedCustomerFromExtraction', () => {
  beforeEach(() => jest.clearAllMocks());

  test('fills an empty customers.email from a valid capture and settles the missing-email card', async () => {
    const existing = { id: 'c-1', email: null, address_line1: '2701 9th St E' };
    const out = await backfillLinkedCustomerFromExtraction({
      customerId: 'c-1', existing, extracted: { email: 'dot@example.com' }, source: 'call-extraction-backfill-prelinked',
    });
    expect(out.emailApplied).toBe(true);
    expect(fanout.applyCustomerUpdatesWithEmailClaimGuard).toHaveBeenCalledWith(expect.objectContaining({
      customerId: 'c-1', updates: { email: 'dot@example.com' }, source: 'call-extraction-backfill-prelinked',
    }));
    expect(fanout.resolveOpenEmailReviewCards).toHaveBeenCalledWith(expect.objectContaining({
      customerId: 'c-1', email: 'dot@example.com', reasonCodes: ['customer_email_missing'],
    }));
    // Empty→value: no old address to retarget, so no fan-out.
    expect(fanout.propagateCustomerEmailChange).not.toHaveBeenCalled();
  });

  test('never overwrites a valid stored email', async () => {
    const existing = { id: 'c-1', email: 'kept@example.com', address_line1: 'x' };
    const out = await backfillLinkedCustomerFromExtraction({
      customerId: 'c-1', existing, extracted: { email: 'other@example.com' }, source: 's',
    });
    expect(out.updates).toEqual({});
    expect(fanout.applyCustomerUpdatesWithEmailClaimGuard).not.toHaveBeenCalled();
  });

  test('ignores a garbled capture', async () => {
    const out = await backfillLinkedCustomerFromExtraction({
      customerId: 'c-1', existing: { id: 'c-1', email: null, address_line1: 'x' }, extracted: { email: 'brandon@gmail' }, source: 's',
    });
    expect(out.updates).toEqual({});
    expect(fanout.applyCustomerUpdatesWithEmailClaimGuard).not.toHaveBeenCalled();
  });

  test('replaces a garbled stored email inside the guarded transaction with fan-out', async () => {
    const existing = { id: 'c-1', email: 'brandon@gmail', address_line1: 'x' };
    fanout.applyCustomerUpdatesWithEmailClaimGuard.mockImplementationOnce(async ({ applyWithEmailInTrx }) => {
      const trx = jest.fn(() => ({ where: () => ({ update: async () => 1 }) }));
      await applyWithEmailInTrx(trx);
      return { emailApplied: true };
    });
    await backfillLinkedCustomerFromExtraction({
      customerId: 'c-1', existing, extracted: { email: 'brandon@example.com' }, source: 's',
    });
    expect(fanout.applyCustomerUpdatesWithEmailClaimGuard).toHaveBeenCalledWith(expect.objectContaining({
      replaceExpectedEmail: 'brandon@gmail',
    }));
    expect(fanout.propagateCustomerEmailChange).toHaveBeenCalledWith(expect.objectContaining({
      before: existing, after: { id: 'c-1', email: 'brandon@example.com' },
    }), expect.anything());
    // The replacement's card settlement rides the fan-out, not the
    // empty→value resolver.
    expect(fanout.resolveOpenEmailReviewCards).not.toHaveBeenCalled();
  });

  test('does not settle the missing-email card when the claim guard dropped the email', async () => {
    fanout.applyCustomerUpdatesWithEmailClaimGuard.mockResolvedValueOnce({ emailApplied: false });
    const out = await backfillLinkedCustomerFromExtraction({
      customerId: 'c-1', existing: { id: 'c-1', email: null, address_line1: 'x' }, extracted: { email: 'dot@example.com' }, source: 's',
    });
    expect(out.emailApplied).toBe(false);
    expect(fanout.resolveOpenEmailReviewCards).not.toHaveBeenCalled();
  });

  test('backfills a missing address alongside the email', async () => {
    await backfillLinkedCustomerFromExtraction({
      customerId: 'c-1', existing: { id: 'c-1', email: null, address_line1: '' },
      extracted: { email: 'dot@example.com', address_line1: '2701 9th St E', city: 'Bradenton', zip: '34208' }, source: 's',
    });
    expect(fanout.applyCustomerUpdatesWithEmailClaimGuard).toHaveBeenCalledWith(expect.objectContaining({
      updates: { email: 'dot@example.com', address_line1: '2701 9th St E', city: 'Bradenton', zip: '34208' },
    }));
  });
});

describe('pre-linked call wiring (source guard)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'services', 'call-recording-processor.js'), 'utf8');

  test('the pre-linked backfill runs outside the booking branch with the trust gates', () => {
    const start = src.indexOf("source: 'call-extraction-backfill-prelinked'");
    expect(start).toBeGreaterThan(-1);
    const block = src.slice(Math.max(0, start - 1400), start);
    expect(block).toMatch(/customerId && !createdCustomerFromCall && !phoneMatchedThisPass/);
    expect(block).toMatch(/!extracted\.is_voicemail && !v2ThirdPartyCallNature/);
    expect(block).toMatch(/customerPhoneMatches\(backfillIdentityPhone, linked\) && extractedNameMatchesCustomer\(extracted, linked\)/);
    // Identity is the ANI (or, outbound, the number we dialed) — never
    // resolveCallContactPhone's dictated-callback-preferring result.
    expect(block).toMatch(/isOutboundCall\(call\)\s*\n\s*\? firstExternalPhone\(call\.to_phone\)\s*\n\s*: firstExternalPhone\(call\.from_phone\)/);
    expect(block).toMatch(/whereNull\('deleted_at'\)/);
    // Sits in Step 3, before the appointment branch's own backfill.
    expect(start).toBeLessThan(src.indexOf('backfillCustomerFromAppointmentContact(customerId, customer, extracted'));
  });

  test('the phone-match branch delegates to the same helper', () => {
    const idx = src.indexOf("source: 'call-extraction-backfill',");
    expect(idx).toBeGreaterThan(-1);
    expect(src.slice(idx - 300, idx)).toMatch(/phoneMatchedThisPass = true/);
    expect(src.slice(idx - 300, idx)).toMatch(/backfillLinkedCustomerFromExtraction\(/);
  });
});

describe('third-party call natures (GH codex #4432 r1 P1)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'services', 'call-recording-processor.js'), 'utf8');

  test('the backfill gate uses the third-party subset, not the creation-only aggregate', () => {
    const set = src.match(/const V2_THIRD_PARTY_CALL_NATURES = new Set\(\[([^\]]*)\]\)/);
    expect(set).not.toBeNull();
    const natures = set[1].match(/'[a-z_]+'/g).map((s) => s.replace(/'/g, ''));
    expect(natures.sort()).toEqual(['job_applicant', 'vendor_or_partner']);
    // The linked-customer natures must NOT gate this backfill off.
    for (const nature of ['billing_question', 'existing_customer_service', 'existing_customer_scheduling']) {
      expect(natures).not.toContain(nature);
    }
  });

  test('the creation hold keeps the wider set', () => {
    const set = src.match(/const V2_NON_CUSTOMER_CALL_NATURES = new Set\(\[([\s\S]*?)\]\)/);
    const natures = set[1].match(/'[a-z_]+'/g).map((s) => s.replace(/'/g, ''));
    for (const nature of ['job_applicant', 'billing_question', 'existing_customer_service', 'existing_customer_scheduling', 'other', 'vendor_or_partner']) {
      expect(natures).toContain(nature);
    }
  });
});
