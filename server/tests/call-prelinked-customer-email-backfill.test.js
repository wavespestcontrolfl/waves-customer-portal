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
 *   • the gate itself (prelinkedBackfillGate + linkedCustomerAcceptsBackfill)
 *     rejects a voicemail, a third-party call nature, a call that already
 *     backfilled, and any caller whose IDENTITY number (the inbound ANI, not
 *     a dictated callback number) is not the linked customer's own or whose
 *     spoken name contradicts the record — tested as behavior, not as a
 *     source-text shape (GH codex #4432 r2 P1);
 *   • the gate does NOT reuse the creation-only non-customer aggregate, which
 *     would skip the existing-customer natures this repair exists for.
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

const {
  backfillLinkedCustomerFromExtraction, prelinkedBackfillGate, linkedCustomerAcceptsBackfill,
  thirdPartyCallNatureFromV2,
} = _test;

describe('backfillLinkedCustomerFromExtraction', () => {
  beforeEach(() => jest.clearAllMocks());

  test('fills an empty customers.email from a valid capture and settles the missing-email card', async () => {
    const existing = { id: 'c-1', email: null, address_line1: '100 Test Street' };
    const out = await backfillLinkedCustomerFromExtraction({
      customerId: 'c-1', existing, extracted: { email: 'captured@example.com' }, source: 'call-extraction-backfill-prelinked',
    });
    expect(out.emailApplied).toBe(true);
    expect(fanout.applyCustomerUpdatesWithEmailClaimGuard).toHaveBeenCalledWith(expect.objectContaining({
      customerId: 'c-1', updates: { email: 'captured@example.com' }, source: 'call-extraction-backfill-prelinked',
    }));
    expect(fanout.resolveOpenEmailReviewCards).toHaveBeenCalledWith(expect.objectContaining({
      customerId: 'c-1', email: 'captured@example.com', reasonCodes: ['customer_email_missing'],
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
      customerId: 'c-1', existing: { id: 'c-1', email: null, address_line1: 'x' }, extracted: { email: 'captured@example.com' }, source: 's',
    });
    expect(out.emailApplied).toBe(false);
    expect(fanout.resolveOpenEmailReviewCards).not.toHaveBeenCalled();
  });

  test('backfills a missing address alongside the email', async () => {
    await backfillLinkedCustomerFromExtraction({
      customerId: 'c-1', existing: { id: 'c-1', email: null, address_line1: '' },
      extracted: { email: 'captured@example.com', address_line1: '100 Test Street', city: 'Testville', zip: '00000' }, source: 's',
    });
    expect(fanout.applyCustomerUpdatesWithEmailClaimGuard).toHaveBeenCalledWith(expect.objectContaining({
      updates: { email: 'captured@example.com', address_line1: '100 Test Street', city: 'Testville', zip: '00000' },
    }));
  });
});

describe('prelinkedBackfillGate — identity and trust rules (behavioral)', () => {
  const inbound = { direction: 'inbound', from_phone: '+15555550188', to_phone: '+15555550199' };
  const base = {
    call: inbound, customerId: 'c-1', createdCustomerFromCall: false,
    phoneMatchedThisPass: false, extracted: {}, thirdPartyCallNature: false,
  };

  test('an ordinary pre-linked inbound call is eligible, on the ANI', () => {
    expect(prelinkedBackfillGate(base)).toEqual({ eligible: true, identityPhone: '+15555550188' });
  });

  test('identity is the ANI even when a different callback number was dictated', () => {
    // resolveCallContactPhone would prefer extracted.phone here; the gate
    // must not (r1 P2) — the ANI is what established the link.
    const gate = prelinkedBackfillGate({ ...base, extracted: { phone: '+15555550166' } });
    expect(gate.identityPhone).toBe('+15555550188');
  });

  test('an outbound call is identified by the number we dialed', () => {
    const gate = prelinkedBackfillGate({
      ...base, call: { direction: 'outbound-api', from_phone: '+15555550199', to_phone: '+15555550177' },
    });
    expect(gate).toEqual({ eligible: true, identityPhone: '+15555550177' });
  });

  test.each([
    ['no linked customer', { customerId: null }],
    ['the customer was created from this call', { createdCustomerFromCall: true }],
    ['the phone-match branch already backfilled', { phoneMatchedThisPass: true }],
    ['a voicemail', { extracted: { is_voicemail: true } }],
    ['a third-party call nature', { thirdPartyCallNature: true }],
    ['an operator unlink', { explicitUnlink: true }],
    ['no usable identity number', { call: { direction: 'inbound', from_phone: null, to_phone: '+15555550199' } }],
  ])('is not eligible: %s', (_label, patch) => {
    expect(prelinkedBackfillGate({ ...base, ...patch }).eligible).toBe(false);
  });
});

describe('linkedCustomerAcceptsBackfill', () => {
  const linked = { id: 'c-1', first_name: 'Pat', last_name: 'Rivera', phone: '+15555550188' };

  test('accepts when the identity number is the customer\'s own and the name agrees', () => {
    expect(linkedCustomerAcceptsBackfill(linked, '+15555550188', { first_name: 'Pat', last_name: 'Rivera' })).toBe(true);
  });

  test('accepts a nickname of the stored first name', () => {
    expect(linkedCustomerAcceptsBackfill(linked, '+15555550188', { first_name: 'Patricia' })).toBe(true);
  });

  test('rejects when the identity number is not on the record', () => {
    expect(linkedCustomerAcceptsBackfill(linked, '+15555550166', { first_name: 'Pat' })).toBe(false);
  });

  test('rejects when the spoken name contradicts the record', () => {
    expect(linkedCustomerAcceptsBackfill(linked, '+15555550188', { first_name: 'Jordan' })).toBe(false);
  });

  test('rejects a missing or soft-deleted customer', () => {
    expect(linkedCustomerAcceptsBackfill(null, '+15555550188', {})).toBe(false);
    expect(linkedCustomerAcceptsBackfill({ ...linked, deleted_at: new Date() }, '+15555550188', {})).toBe(false);
  });
});

describe('pre-linked call wiring (placement)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'services', 'call-recording-processor.js'), 'utf8');

  test('the call site delegates to the tested gate and sits before the booking backfill', () => {
    const start = src.indexOf("source: 'call-extraction-backfill-prelinked'");
    expect(start).toBeGreaterThan(-1);
    const block = src.slice(Math.max(0, start - 900), start);
    expect(block).toMatch(/prelinkedBackfillGate\(/);
    expect(block).toMatch(/linkedCustomerAcceptsBackfill\(linked, prelinkedGate\.identityPhone, extracted\)/);
    expect(block).toMatch(/thirdPartyCallNature: v2ThirdPartyCallNature/);
    expect(block).toMatch(/explicitUnlink/);
    expect(start).toBeLessThan(src.indexOf('backfillCustomerFromAppointmentContact(customerId, customer, extracted'));
  });

  test('the phone-match branch delegates to the same backfill helper', () => {
    const idx = src.indexOf("source: 'call-extraction-backfill',");
    expect(idx).toBeGreaterThan(-1);
    expect(src.slice(idx - 300, idx)).toMatch(/phoneMatchedThisPass = true/);
    expect(src.slice(idx - 300, idx)).toMatch(/backfillLinkedCustomerFromExtraction\(/);
  });
});

describe('thirdPartyCallNatureFromV2', () => {
  const v2 = (call_nature, status = 'valid') => ({ status, extraction: { call_nature } });

  test.each(['job_applicant', 'vendor_or_partner'])('vetoes %s', (nature) => {
    expect(thirdPartyCallNatureFromV2(v2(nature))).toBe(true);
  });

  test.each(['billing_question', 'existing_customer_service', 'existing_customer_scheduling', 'new_lead', 'other'])(
    'lets %s through — these are the linked-customer calls the backfill serves (r1 P1)',
    (nature) => {
      expect(thirdPartyCallNatureFromV2(v2(nature))).toBe(false);
    },
  );

  test('needs a valid extraction', () => {
    expect(thirdPartyCallNatureFromV2(v2('job_applicant', 'parse_failed'))).toBe(false);
    expect(thirdPartyCallNatureFromV2(null)).toBe(false);
    expect(thirdPartyCallNatureFromV2({ status: 'valid', extraction: {} })).toBe(false);
  });

  test('the veto does not depend on the V2-primary adoption flag (r3 P1)', () => {
    // Suppression-only consumer: a shadow-mode verdict may veto, so the
    // applicant/vendor exclusion survives a flag flip or rollback.
    const src = fs.readFileSync(path.join(__dirname, '..', 'services', 'call-recording-processor.js'), 'utf8');
    const fn = src.slice(src.indexOf('function thirdPartyCallNatureFromV2'));
    expect(fn.slice(0, fn.indexOf('\n}'))).not.toMatch(/callExtractionV2PrimaryEnabled/);
  });
});

describe('call-nature sets', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'services', 'call-recording-processor.js'), 'utf8');

  test('the creation hold keeps the wider set', () => {
    const set = src.match(/const V2_NON_CUSTOMER_CALL_NATURES = new Set\(\[([\s\S]*?)\]\)/);
    const natures = set[1].match(/'[a-z_]+'/g).map((x) => x.replace(/'/g, ''));
    for (const nature of ['job_applicant', 'billing_question', 'existing_customer_service', 'existing_customer_scheduling', 'other', 'vendor_or_partner']) {
      expect(natures).toContain(nature);
    }
  });
});
