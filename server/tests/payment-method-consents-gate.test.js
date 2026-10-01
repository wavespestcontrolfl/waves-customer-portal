jest.mock('../models/db', () => {
  const fn = jest.fn();
  fn.raw = jest.fn((sql) => sql);
  return fn;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const db = require('../models/db');
const { hasConsentFor, hasEnrollmentScopedConsent, consentVersionQualifiesForEnrollment, findConsentedChargeableCard } = require('../services/payment-method-consents');

function qb(rows) {
  const q = {};
  q.where = jest.fn(() => q);
  q.select = jest.fn(async () => rows);
  return q;
}

// Enrollment authority requires the v8+ copy (the version whose text
// authorizes charging "for future service visits and invoices as agreed").
// Legacy versions and the backfill's implicit rows are audit anchors only
// (Codex #2507 P1 round-3).
describe('consentVersionQualifiesForEnrollment', () => {
  test('v8+ versions qualify', () => {
    expect(consentVersionQualifiesForEnrollment('v8_2026-06-17')).toBe(true);
    expect(consentVersionQualifiesForEnrollment('v9_2027-01-01')).toBe(true);
    expect(consentVersionQualifiesForEnrollment('v12_2028-05-05')).toBe(true);
  });

  test('legacy, implicit, and malformed versions do NOT qualify', () => {
    expect(consentVersionQualifiesForEnrollment('v0_implicit_pre_consent')).toBe(false);
    expect(consentVersionQualifiesForEnrollment('v7_2026-01-02')).toBe(false);
    expect(consentVersionQualifiesForEnrollment('v1')).toBe(false);
    expect(consentVersionQualifiesForEnrollment('')).toBe(false);
    expect(consentVersionQualifiesForEnrollment(null)).toBe(false);
    expect(consentVersionQualifiesForEnrollment('version8')).toBe(false);
  });
});

describe('hasConsentFor', () => {
  beforeEach(() => jest.clearAllMocks());

  test('true when ANY row for the pm carries qualifying copy', async () => {
    db.mockImplementation(() => qb([
      { consent_text_version: 'v0_implicit_pre_consent' },
      { consent_text_version: 'v8_2026-06-17' },
    ]));
    expect(await hasConsentFor('cust-1', 'pm_x')).toBe(true);
  });

  test('false when only legacy/implicit rows exist (webhook-first race must fail closed)', async () => {
    db.mockImplementation(() => qb([
      { consent_text_version: 'v0_implicit_pre_consent' },
      { consent_text_version: 'v7_2026-01-02' },
    ]));
    expect(await hasConsentFor('cust-1', 'pm_x')).toBe(false);
  });

  test('false with no rows or missing args', async () => {
    db.mockImplementation(() => qb([]));
    expect(await hasConsentFor('cust-1', 'pm_x')).toBe(false);
    expect(await hasConsentFor(null, 'pm_x')).toBe(false);
    expect(await hasConsentFor('cust-1', null)).toBe(false);
  });
});

// The auto-satisfy authority (findConsentedChargeableCard) requires an
// ENROLLMENT-SCOPED consent: the card-hold capture UI only authorizes the
// specific visit's completion charge + no-show fee, so its rows must never
// let a later recurring accept skip the Auto Pay checkbox (Codex #2680 r5).
describe('hasEnrollmentScopedConsent', () => {
  beforeEach(() => jest.clearAllMocks());

  test('a v8+ estimate_card_hold row alone does NOT qualify', async () => {
    db.mockImplementation(() => qb([
      { consent_text_version: 'v8_2026-06-17', source: 'estimate_card_hold' },
    ]));
    expect(await hasEnrollmentScopedConsent('cust-1', 'pm_x')).toBe(false);
  });

  test('a v8+ consent from any save-and-charge surface qualifies', async () => {
    for (const source of ['pay_page', 'portal_add_card', 'estimate_accept', 'onboarding']) {
      db.mockImplementation(() => qb([{ consent_text_version: 'v9_2026-07-12', source }]));
      expect(await hasEnrollmentScopedConsent('cust-1', 'pm_x')).toBe(true);
    }
  });

  test('a hold row does not poison a pm that ALSO carries a real consent', async () => {
    db.mockImplementation(() => qb([
      { consent_text_version: 'v8_2026-06-17', source: 'estimate_card_hold' },
      { consent_text_version: 'v8_2026-06-17', source: 'pay_page' },
    ]));
    expect(await hasEnrollmentScopedConsent('cust-1', 'pm_x')).toBe(true);
  });

  test('legacy versions never qualify regardless of source', async () => {
    db.mockImplementation(() => qb([
      { consent_text_version: 'v7_2026-01-02', source: 'pay_page' },
    ]));
    expect(await hasEnrollmentScopedConsent('cust-1', 'pm_x')).toBe(false);
  });
});

// A prior Auto Pay OPT-OUT blocks the auto-satisfy entirely (Codex #2681
// r6 P1): disabling keeps the saved cards, so an old consent row must not
// silently re-enroll the customer. Never-enrolled customers (no toggle
// history) still flow through to the card/consent checks.
describe('findConsentedChargeableCard — Auto Pay opt-out is sacred', () => {
  beforeEach(() => jest.clearAllMocks());

  function tableDb(map) {
    db.mockImplementation((table) => {
      const rows = map[table] || [];
      const q = {};
      q.where = jest.fn(() => q);
      q.whereIn = jest.fn(() => q);
      q.whereNotNull = jest.fn(() => q);
      q.orderBy = jest.fn(() => q);
      q.first = jest.fn(async () => rows[0] || null);
      q.select = jest.fn(async () => rows);
      q.then = (resolve, reject) => Promise.resolve(rows).then(resolve, reject);
      return q;
    });
  }

  test('latest toggle = autopay_disabled -> returns null before touching cards', async () => {
    tableDb({
      autopay_log: [{ event_type: 'autopay_disabled' }],
      payment_methods: [{ id: 'pm-1', stripe_payment_method_id: 'pm_x', method_type: 'card', exp_month: 12, exp_year: 2031 }],
      payment_method_consents: [{ consent_text_version: 'v9_2026-07-12', source: 'pay_page' }],
    });
    expect(await findConsentedChargeableCard('cust-1')).toBe(null);
  });

  test('latest toggle = autopay_enabled -> auto-satisfy proceeds to the card checks', async () => {
    tableDb({
      autopay_log: [{ event_type: 'autopay_enabled' }],
      payment_methods: [{ id: 'pm-1', stripe_payment_method_id: 'pm_x', method_type: 'card', exp_month: 12, exp_year: 2031 }],
      payment_method_consents: [{ consent_text_version: 'v9_2026-07-12', source: 'pay_page' }],
    });
    const pm = await findConsentedChargeableCard('cust-1');
    expect(pm).toMatchObject({ id: 'pm-1' });
  });

  test('no toggle history (never enrolled) -> gate does not block', async () => {
    tableDb({
      autopay_log: [],
      payment_methods: [{ id: 'pm-1', stripe_payment_method_id: 'pm_x', method_type: 'card', exp_month: 12, exp_year: 2031 }],
      payment_method_consents: [{ consent_text_version: 'v9_2026-07-12', source: 'portal_add_card' }],
    });
    const pm = await findConsentedChargeableCard('cust-1');
    expect(pm).toMatchObject({ id: 'pm-1' });
  });
});

// Rendered-version attestation (codex #5434 r1 P1): the client bundles its
// own copy of the consent text, so a capture attests the version it
// rendered and the server refuses any other — including none.
describe('rendered consent version (codex #5434 r1 P1)', () => {
  const text = require('../services/payment-method-consent-text');

  test('only the exact current CONSENT_VERSION is current; older, absent and malformed are stale', () => {
    expect(text.renderedConsentVersionIsCurrent(text.CONSENT_VERSION)).toBe(true);
    expect(text.renderedConsentVersionIsCurrent(` ${text.CONSENT_VERSION} `)).toBe(true);
    for (const stale of ['v11_2026-08-25', 'v12', '', null, undefined, 12, {}, 'V12_2026-09-30']) {
      expect(text.renderedConsentVersionIsCurrent(stale)).toBe(false);
    }
  });

  test('the refusal names the refresh action and a code the client can branch on', () => {
    expect(text.consentVersionStaleResponse()).toEqual({ error: expect.stringMatching(/refresh the page/i), code: 'CONSENT_VERSION_STALE' });
    const err = text.consentVersionStaleError();
    expect(err.status).toBe(409);
    expect(err.code).toBe('CONSENT_VERSION_STALE');
    // Existing customers are never re-asked: the enrollment floor is unchanged.
    expect(consentVersionQualifiesForEnrollment('v11_2026-08-25')).toBe(true);
  });

  describe('deferredCaptureConsentVersionCurrent (webhook mirrors)', () => {
    const { deferredCaptureConsentVersionCurrent } = require('../services/payment-method-consents');
    const alerts = require('../services/admin-alert-compose');
    let raise;
    beforeEach(() => { raise = jest.spyOn(alerts, 'raiseAdminAlert').mockResolvedValue({ id: 'n1' }); });
    afterEach(() => raise.mockRestore());

    test('a current stamp lets the mirror record, silently', async () => {
      await expect(deferredCaptureConsentVersionCurrent({ id: 'si_1', metadata: { consent_text_version: text.CONSENT_VERSION } }, { customerId: 'cust-1' })).resolves.toBe(true);
      expect(raise).not.toHaveBeenCalled();
    });

    test.each([
      ['a stale stamp', { consent_text_version: 'v11_2026-08-25' }],
      ['no stamp', {}],
      ['no metadata at all', undefined],
    ])('%s refuses and parks ONE billing bell per intent for the office to re-collect', async (_name, metadata) => {
      await expect(deferredCaptureConsentVersionCurrent({ id: 'si_9', metadata }, { context: 'test mirror', customerId: 'cust-1' })).resolves.toBe(false);
      expect(raise).toHaveBeenCalledTimes(1);
      const [category, spec, opts] = raise.mock.calls[0];
      expect(category).toBe('billing');
      expect(spec).toMatchObject({ area: 'Billing', severity: 'needs-you', subject: { type: 'customer', id: 'cust-1' }, doneWhen: 'consent_recorded', who: 'person', link: '/admin/customers?customerId=cust-1' });
      // The composer accepts the copy as written (headline/why limits, no forbidden tokens).
      expect(() => alerts.composeAdminAlert(spec)).not.toThrow();
      expect(opts.dedupeKey).toBe('consent_version_stale:si_9');
    });

    test('a refusal with no customer id logs only (nothing to link the bell to) and still refuses', async () => {
      await expect(deferredCaptureConsentVersionCurrent({ id: 'si_2', metadata: {} }, {})).resolves.toBe(false);
      expect(raise).not.toHaveBeenCalled();
    });

    test('a bell failure never flips the refusal', async () => {
      raise.mockRejectedValue(new Error('bell down'));
      await expect(deferredCaptureConsentVersionCurrent({ id: 'si_3', metadata: {} }, { customerId: 'cust-1' })).resolves.toBe(false);
    });
  });
});

// Deferred prepay recovery (codex #5434 r1 P1): an authorization recorded
// under an OLDER consent text version is looked up by that version (or any
// version for an unstamped job), never by the current text it cannot match.
describe('hasConsentSnapshotForVariant — version / anyVersion lookups', () => {
  const { hasConsentSnapshotForVariant } = require('../services/payment-method-consents');
  const text = require('../services/payment-method-consent-text');
  function chain(row) {
    const q = { wheres: [] };
    q.where = jest.fn((arg, ...rest) => { q.wheres.push(rest.length ? [arg, ...rest] : arg); return q; });
    q.first = jest.fn(async () => row);
    return q;
  }

  beforeEach(() => jest.clearAllMocks());

  test('default: matches the CURRENT text snapshot for the variant', async () => {
    const q = chain({ id: 'c1' });
    db.mockReturnValue(q);
    await expect(hasConsentSnapshotForVariant('cust-1', 'pm_1', { methodType: 'card', variant: 'prepay_card' })).resolves.toBe(true);
    expect(q.wheres[1]).toEqual({ consent_text_snapshot: text.getConsentText('card', { variant: 'prepay_card' }) });
  });

  test('version: matches the row recorded under THAT version, scoped by source and since', async () => {
    const q = chain({ id: 'c1' });
    db.mockReturnValue(q);
    const since = new Date('2026-09-30T20:00:00.000Z');
    await expect(hasConsentSnapshotForVariant('cust-1', 'pm_1', { version: 'v11_2026-08-25', source: 'estimate_accept', since })).resolves.toBe(true);
    expect(q.wheres).toEqual([
      { customer_id: 'cust-1', stripe_payment_method_id: 'pm_1' },
      { consent_text_version: 'v11_2026-08-25' },
      { source: 'estimate_accept' },
      ['created_at', '>=', since],
    ]);
  });

  // codex #5434 r3 P1: a version / any-version lookup for the PREPAY variant
  // still has to be the prepay authorization — never a base consent the
  // recurring-card backstop recorded for the same method.
  test("version + variant 'prepay_card': also requires the prepay marker in the snapshot", async () => {
    const q = chain({ id: 'c1' });
    db.mockReturnValue(q);
    await expect(hasConsentSnapshotForVariant('cust-1', 'pm_1', { version: 'v11_2026-08-25', variant: 'prepay_card', source: 'estimate_accept' })).resolves.toBe(true);
    expect(q.wheres).toEqual([
      { customer_id: 'cust-1', stripe_payment_method_id: 'pm_1' },
      { consent_text_version: 'v11_2026-08-25' },
      ['consent_text_snapshot', 'like', `%${text.PREPAY_CONSENT_MARKER}%`],
      { source: 'estimate_accept' },
    ]);
    // The marker rides every prepay text and no base text.
    expect(text.PREPAY_CARD_CONSENT_TEXT).toContain(text.PREPAY_CONSENT_MARKER);
    expect(text.PREPAY_ACH_CONSENT_TEXT).toContain(text.PREPAY_CONSENT_MARKER);
    expect(text.CARD_CONSENT_TEXT).not.toContain(text.PREPAY_CONSENT_MARKER);
    expect(text.ACH_CONSENT_TEXT).not.toContain(text.PREPAY_CONSENT_MARKER);
  });

  test('anyVersion: no text or version filter at all (unstamped jobs)', async () => {
    const q = chain(null);
    db.mockReturnValue(q);
    await expect(hasConsentSnapshotForVariant('cust-1', 'pm_1', { anyVersion: true, source: 'estimate_accept' })).resolves.toBe(false);
    expect(q.wheres).toEqual([
      { customer_id: 'cust-1', stripe_payment_method_id: 'pm_1' },
      { source: 'estimate_accept' },
    ]);
  });
});

// codex #5434 r3 P1: a one-time card HOLD never showed the card authorization
// — its ledger row snapshots the hold disclosure the modal rendered, under a
// version that can never read as Auto Pay enrollment consent.
describe('card-hold consent snapshot', () => {
  const text = require('../services/payment-method-consent-text');
  const { recordConsent } = require('../services/payment-method-consents');

  test('the hold text mirrors CardHoldModal with the frozen fee and window, and the surcharge line', () => {
    const t = text.cardHoldConsentText({ noShowFeeAmount: 49.5, cancelWindowHours: 48 });
    expect(t).toBe('We won’t charge you today. Your card is charged the final total after your visit is completed. A $49.50 fee applies only if you cancel within 48 hours or aren’t home. Rescheduling is free but doesn’t reset the cancellation window. A credit card surcharge of up to 2.9% may apply; debit cards, prepaid cards, and bank transfers have no added card surcharge.');
    expect(t).not.toContain(text.RATE_IN_EFFECT_SENTENCE);
    expect(text.getConsentText('card', { variant: 'card_hold', holdTerms: { noShowFeeAmount: 75, cancelWindowHours: 24 } })).toContain('A $75.00 fee');
  });

  test("the hold version is not a 'v<N>' card-copy version: it never qualifies for enrollment", () => {
    expect(text.CARD_HOLD_CONSENT_VERSION).toMatch(/^card_hold_v\d+_/);
    expect(consentVersionQualifiesForEnrollment(text.CARD_HOLD_CONSENT_VERSION)).toBe(false);
  });

  test("recordConsent with consentVariant 'card_hold' writes the hold text under the hold version", async () => {
    const inserted = [];
    db.mockReturnValue({ insert: (row) => { inserted.push(row); return { returning: async () => [{ id: 'c-hold', ...row }] }; } });
    await recordConsent({ customerId: 'cust-1', stripePaymentMethodId: 'pm_1', source: 'estimate_card_hold', methodType: 'card', consentVariant: 'card_hold', holdTerms: { noShowFeeAmount: 75, cancelWindowHours: 24 } });
    expect(inserted[0]).toEqual(expect.objectContaining({
      source: 'estimate_card_hold',
      consent_text_version: text.CARD_HOLD_CONSENT_VERSION,
      consent_text_snapshot: text.cardHoldConsentText({ noShowFeeAmount: 75, cancelWindowHours: 24 }),
    }));
    expect(inserted[0].consent_text_snapshot).not.toContain(text.RATE_IN_EFFECT_SENTENCE);
  });
});
