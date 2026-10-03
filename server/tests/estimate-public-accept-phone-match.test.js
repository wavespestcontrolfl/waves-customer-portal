process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

// B18: the accept path resolves an UNLINKED estimate's customer by phone
// (matchAcceptCustomerByPhone -> pickAcceptCustomerMatch), and that one
// verdict decides whose saved card / Auto Pay the accept relies on. A lone
// phone hit used to be reused unconditionally, so a staff-typed phone that
// belongs to an existing Auto Pay customer silently exempted the person
// accepting from the card capture and bound their plan to that customer.
// A lone hit is now dropped only when the estimate CONTRADICTS it (email and
// address both present on both sides, neither agrees).
//
// The route's matcher runs for real here; only the DB, Stripe-adjacent
// services and Auto Pay eligibility are faked, so the recurring-card policy
// (/data, /recurring-card-intent and the accept's pre-flight all call it) is
// proven to see the same verdict as the accept transaction's match.

let mockDbFixtures = {};
jest.mock('../models/db', () => {
  // Chainable + thenable: the phone sweep awaits the chain itself, the policy's
  // live-row reads end in .first().
  const chain = (table) => {
    const c = {
      first: async () => {
        const v = mockDbFixtures[`${table}:first`];
        return v ?? null;
      },
      then: (resolve, reject) => Promise.resolve(mockDbFixtures[`${table}:list`] || []).then(resolve, reject),
    };
    c.where = (arg) => {
      if (typeof arg === 'function') arg(c);
      return c;
    };
    for (const m of ['orWhereRaw', 'whereRaw', 'whereNot', 'whereNotNull', 'whereNull', 'whereIn', 'orderBy', 'orderByRaw', 'forUpdate']) c[m] = () => c;
    return c;
  };
  const mock = jest.fn((table) => chain(table));
  mock.fn = { now: jest.fn(() => 'NOW') };
  mock.raw = jest.fn();
  mock.transaction = jest.fn(async (fn) => fn(mock));
  return mock;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../services/waveguard-existing-services', () => ({
  loadExistingRecurringQualifyingRows: jest.fn(async () => []),
}));
jest.mock('../services/self-booking-plan-sync', () => ({
  tierLabelStatus: jest.fn(async () => 'not_label'),
}));
jest.mock('../services/payer', () => ({ resolveForInvoice: jest.fn(async () => null) }));
const mockCustomerOnAutopay = jest.fn(async () => false);
jest.mock('../services/autopay-eligibility', () => ({
  customerOnAutopay: (...a) => mockCustomerOnAutopay(...a),
  isPaused: jest.fn(() => false),
  getChargeableAutopayMethod: jest.fn(async () => null),
}));
const mockFindConsentedChargeableCard = jest.fn(async () => null);
jest.mock('../services/payment-method-consents', () => ({
  hasConsentFor: jest.fn(async () => false),
  hasEnrollmentScopedConsent: jest.fn(async () => false),
  hasConsentSnapshotForVariant: jest.fn(async () => false),
  recordConsent: jest.fn(async () => ({ id: 'consent1' })),
  linkPaymentMethodId: jest.fn(async () => {}),
  findConsentedChargeableCard: (...a) => mockFindConsentedChargeableCard(...a),
}));

const { matchAcceptCustomerByPhone } = require('../routes/estimate-public');
const { resolveRecurringCardPolicyForEstimate } = require('../services/recurring-card-on-file');

const BOB = {
  id: 'cust-bob',
  first_name: 'Bob',
  last_name: 'Example',
  phone: '(941) 555-0142',
  email: 'bob@example.com',
  address_line1: '100 Palm Ave',
  autopay_enabled: true,
};

// An unlinked estimate for a different person: Jane, her own email, her own
// address — but the phone staff typed is Bob's.
function janeEstimate(overrides = {}) {
  return {
    id: 'est-jane',
    customer_id: null,
    customer_name: 'Jane Sample',
    customer_phone: '9415550142',
    customer_email: 'jane@example.com',
    address: '742 Evergreen Ter, Sarasota, FL 34236',
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockDbFixtures = {};
  process.env.RECURRING_CARD_ON_FILE = 'true';
});
afterAll(() => {
  delete process.env.RECURRING_CARD_ON_FILE;
});

describe('matchAcceptCustomerByPhone: a lone phone hit the estimate contradicts', () => {
  it('(a) email AND address both present and both disagree: no match, accept creates a fresh profile', async () => {
    mockDbFixtures['customers:list'] = [BOB];
    const res = await matchAcceptCustomerByPhone(janeEstimate());
    expect(res.match).toBeNull();
    expect(res.candidateCount).toBe(1);
    // The reason is exposed so the accept keeps the new profile off Bob's account.
    expect(res.contradicted).toBe(true);
  });

  it('(a) email compare is case/space-insensitive, address compare keeps the token boundary', async () => {
    // '100 palm' must not agree with an estimate on '100 Palmetto Dr'.
    mockDbFixtures['customers:list'] = [{ ...BOB, address_line1: '100 Palm' }];
    const res = await matchAcceptCustomerByPhone(janeEstimate({
      customer_email: '  JANE@Example.com ',
      address: '100 Palmetto Dr, Sarasota, FL 34236',
    }));
    expect(res.match).toBeNull();
  });

  it('(b) email agrees (case-insensitive), address differs: still matches', async () => {
    mockDbFixtures['customers:list'] = [BOB];
    const res = await matchAcceptCustomerByPhone(janeEstimate({ customer_email: ' BOB@Example.COM ' }));
    expect(res.match).toBe(BOB);
    expect(res.contradicted).toBeUndefined();
  });

  it('(c) address agrees, email differs: still matches (new email, same home)', async () => {
    mockDbFixtures['customers:list'] = [BOB];
    const res = await matchAcceptCustomerByPhone(janeEstimate({ address: '100 Palm Ave, Sarasota, FL 34236' }));
    expect(res.match).toBe(BOB);
  });

  it('(d) estimate carries no email: cannot contradict, lone match reused', async () => {
    mockDbFixtures['customers:list'] = [BOB];
    for (const customer_email of [null, '', '   ']) {
      const res = await matchAcceptCustomerByPhone(janeEstimate({ customer_email }));
      expect(res.match).toBe(BOB);
    }
  });

  it('(d) estimate carries no address: cannot contradict, lone match reused', async () => {
    mockDbFixtures['customers:list'] = [BOB];
    for (const address of [null, '', '  ,  ']) {
      const res = await matchAcceptCustomerByPhone(janeEstimate({ address }));
      expect(res.match).toBe(BOB);
    }
  });

  it('(d) candidate lacks an email or a meaningful street line: cannot contradict, lone match reused', async () => {
    mockDbFixtures['customers:list'] = [{ ...BOB, email: null }];
    expect((await matchAcceptCustomerByPhone(janeEstimate())).match).toMatchObject({ id: 'cust-bob' });
    mockDbFixtures['customers:list'] = [{ ...BOB, email: '' }];
    expect((await matchAcceptCustomerByPhone(janeEstimate())).match).toMatchObject({ id: 'cust-bob' });
    mockDbFixtures['customers:list'] = [{ ...BOB, address_line1: null }];
    expect((await matchAcceptCustomerByPhone(janeEstimate())).match).toMatchObject({ id: 'cust-bob' });
    // Too short to be a street line (the multi-candidate rule's own floor).
    mockDbFixtures['customers:list'] = [{ ...BOB, address_line1: '12' }];
    expect((await matchAcceptCustomerByPhone(janeEstimate())).match).toMatchObject({ id: 'cust-bob' });
  });

  it('no phone candidates, or no phone on the estimate: no match (unchanged)', async () => {
    mockDbFixtures['customers:list'] = [];
    expect((await matchAcceptCustomerByPhone(janeEstimate())).match).toBeNull();
    mockDbFixtures['customers:list'] = [BOB];
    expect(await matchAcceptCustomerByPhone(janeEstimate({ customer_phone: null }))).toEqual({ match: null, candidateCount: 0 });
  });
});

describe('matchAcceptCustomerByPhone: the contradiction uses the canonical address comparison', () => {
  // The estimate's email always differs from the profile's here, so ONLY the address decides.
  const same = async (candidate, address) => {
    mockDbFixtures['customers:list'] = [{ ...BOB, ...candidate }];
    const res = await matchAcceptCustomerByPhone(janeEstimate({ address }));
    return res.contradicted !== true && res.match !== null;
  };
  const differs = async (candidate, address) => {
    mockDbFixtures['customers:list'] = [{ ...BOB, ...candidate }];
    const res = await matchAcceptCustomerByPhone(janeEstimate({ address }));
    return res.contradicted === true && res.match === null;
  };

  it('suffix variants of the same address are NOT a contradiction (Street/St, Avenue/Ave, Drive/Dr)', async () => {
    expect(await same({ address_line1: '123 Main St' }, '123 Main Street, Bradenton, FL 34205')).toBe(true);
    expect(await same({ address_line1: '123 Main Street' }, '123 Main St')).toBe(true);
    expect(await same({ address_line1: '88 Bayview Ave' }, '88 Bayview Avenue, Sarasota, FL 34236')).toBe(true);
    expect(await same({ address_line1: '45 Oak Dr' }, '45 Oak Drive')).toBe(true);
  });

  it('unit formatting, case and punctuation are NOT a contradiction', async () => {
    expect(await same({ address_line1: '45 Oak Dr', address_line2: 'Apt 2' }, '45 Oak Drive #2, Sarasota, FL 34236')).toBe(true);
    expect(await same({ address_line1: '45 Oak Dr', address_line2: '#2' }, '45 Oak Drive Apt 2')).toBe(true);
    expect(await same({ address_line1: '123 Main St' }, '123 MAIN ST.')).toBe(true);
    expect(await same({ address_line1: '123 Main St.' }, '123 main street,  bradenton , fl')).toBe(true);
  });

  it('trailing city/state/ZIP on the estimate address is NOT a contradiction (candidate city/ZIP agree or are blank)', async () => {
    expect(await same({ address_line1: '123 Main St', city: 'Bradenton', zip: '34205' }, '123 Main Street, Bradenton, FL 34205')).toBe(true);
    expect(await same({ address_line1: '123 Main St', city: null, zip: null }, '123 Main Street, Bradenton, FL 34205')).toBe(true);
  });

  it('a genuinely different street or house number IS a contradiction', async () => {
    expect(await differs({ address_line1: '100 Palm Ave' }, '742 Evergreen Ter, Sarasota, FL 34236')).toBe(true);
    expect(await differs({ address_line1: '100 Palm Ave' }, '100 Oak Ave, Sarasota, FL 34236')).toBe(true);
    expect(await differs({ address_line1: '100 Palm Ave' }, '102 Palm Ave')).toBe(true);
    expect(await differs({ address_line1: '45 Oak Dr', address_line2: 'Apt 2' }, '45 Oak Drive Apt 9')).toBe(true);
  });

  it('when the comparison cannot decide it is NOT a contradiction (no street number on either side)', async () => {
    expect(await same({ address_line1: '100 Palm Ave' }, 'Sarasota, FL')).toBe(true);
    expect(await same({ address_line1: '100 Palm Ave' }, 'Palm Avenue, Sarasota')).toBe(true);
    expect(await same({ address_line1: 'PO Box 12' }, '742 Evergreen Ter, Sarasota, FL 34236')).toBe(true);
    expect(await same({ address_line1: 'Unit 7' }, '742 Evergreen Ter')).toBe(true);
  });

  it('the narrow raw-prefix agreement still keeps a match the canonical comparison would split (city spelled differently)', async () => {
    expect(await same({ address_line1: '100 Palm Ave', city: 'Sarasota' }, '100 Palm Ave, Tampa, FL')).toBe(true);
  });
});

describe('matchAcceptCustomerByPhone: several phone candidates (unchanged)', () => {
  const LANDLORD = { ...BOB, id: 'cust-landlord', email: 'owner@example.com', address_line1: '10 Oak Ln' };
  const RENTAL = { ...BOB, id: 'cust-rental', email: 'owner@example.com', address_line1: '55 Pine Ct' };

  it('(e) a unique email match wins', async () => {
    mockDbFixtures['customers:list'] = [LANDLORD, { ...RENTAL, email: 'jane@example.com' }];
    const res = await matchAcceptCustomerByPhone(janeEstimate());
    expect(res.match.id).toBe('cust-rental');
    expect(res.candidateCount).toBe(2);
  });

  it('(e) a unique street match wins when email does not decide', async () => {
    mockDbFixtures['customers:list'] = [LANDLORD, RENTAL];
    const res = await matchAcceptCustomerByPhone(janeEstimate({ address: '55 Pine Ct, Sarasota, FL 34236' }));
    expect(res.match.id).toBe('cust-rental');
  });

  it('(e) neither email nor address is unique: no match (fresh profile)', async () => {
    mockDbFixtures['customers:list'] = [LANDLORD, RENTAL];
    const res = await matchAcceptCustomerByPhone(janeEstimate());
    expect(res.match).toBeNull();
    // Not a contradiction: the shared-phone case keeps sharing the account.
    expect(res.contradicted).toBeUndefined();
    expect((await matchAcceptCustomerByPhone(janeEstimate({ customer_email: 'owner@example.com' }))).match).toBeNull();
  });

  it('(e) the 2+ candidate logic does not reuse the lone-candidate rule: a lone-candidate-style email/address pair that would pass alone is still judged by uniqueness', async () => {
    // Both rows share the estimate's email, so email alone cannot decide; the
    // address picks exactly one.
    mockDbFixtures['customers:list'] = [LANDLORD, RENTAL];
    const res = await matchAcceptCustomerByPhone(janeEstimate({
      customer_email: 'owner@example.com',
      address: '10 Oak Ln, Sarasota, FL 34236',
    }));
    expect(res.match.id).toBe('cust-landlord');
  });
});

describe('recurring-card policy sees the same verdict (never binds a stranger to the saved card)', () => {
  beforeEach(() => {
    // Bob is on Auto Pay with a consented saved card: if the phone match lands
    // on him the policy exempts the card (autopay_already_active).
    mockDbFixtures['customers:list'] = [BOB];
    mockDbFixtures['customers:first'] = BOB;
    mockCustomerOnAutopay.mockResolvedValue(true);
    mockFindConsentedChargeableCard.mockResolvedValue({ id: 'pm-bob' });
  });

  it('(a) contradicting estimate: the accepter must supply a card, Bob\'s Auto Pay / saved card is never consulted', async () => {
    const p = await resolveRecurringCardPolicyForEstimate({ estimate: janeEstimate() });
    expect(p).toEqual({ enforced: true, required: true, exemptReason: null });
    expect(mockCustomerOnAutopay).not.toHaveBeenCalled();
    expect(mockFindConsentedChargeableCard).not.toHaveBeenCalled();
  });

  it('(b) agreeing email: unchanged, the existing Auto Pay customer is not re-asked for a card', async () => {
    const p = await resolveRecurringCardPolicyForEstimate({ estimate: janeEstimate({ customer_email: 'bob@example.com' }) });
    expect(p).toMatchObject({ enforced: true, required: false, exemptReason: 'autopay_already_active' });
    expect(mockCustomerOnAutopay).toHaveBeenCalled();
  });

  it('(c) agreeing address with a new email: unchanged, exempt', async () => {
    const p = await resolveRecurringCardPolicyForEstimate({ estimate: janeEstimate({ address: '100 Palm Ave, Sarasota, FL 34236' }) });
    expect(p).toMatchObject({ enforced: true, required: false, exemptReason: 'autopay_already_active' });
  });

  it('(d) phone-only estimate (no email, no address): unchanged, exempt', async () => {
    const p = await resolveRecurringCardPolicyForEstimate({ estimate: janeEstimate({ customer_email: null, address: null }) });
    expect(p).toMatchObject({ enforced: true, required: false, exemptReason: 'autopay_already_active' });
  });
});
