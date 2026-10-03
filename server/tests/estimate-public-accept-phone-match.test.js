process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

// B18: the accept path resolves an UNLINKED estimate's customer by phone (matchAcceptCustomerByPhone), and that
// verdict decides whose saved card / Auto Pay the accept relies on. A lone phone hit the estimate CONTRADICTS
// (email AND address both present on both sides, neither agrees) is flagged on the verdict; the accept path parks
// it for the office. The match itself is unchanged for every other reader. The route's matcher runs for real
// here; only the DB and unrelated services are faked.

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

const { matchAcceptCustomerByPhone, acceptPhoneParkedVerdict } = require('../routes/estimate-public');

const BOB = {
  id: 'cust-bob',
  first_name: 'Bob',
  last_name: 'Example',
  phone: '(941) 555-0142',
  email: 'bob@example.com',
  address_line1: '100 Palm Ave',
};

// An unlinked estimate for a different person: Jane, her own email, her own address - but the phone staff typed is Bob's.
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
});

describe('matchAcceptCustomerByPhone: a lone phone hit the estimate contradicts', () => {
  it('(a) email AND address both present and both disagree: flagged contradicted, the match itself is unchanged', async () => {
    mockDbFixtures['customers:list'] = [BOB];
    const res = await matchAcceptCustomerByPhone(janeEstimate());
    expect(res.contradicted).toBe(true);
    expect(res.rejectedCustomerId).toBe('cust-bob');
    expect(res.candidateCount).toBe(1);
    expect(res.match).toBe(BOB);
  });

  it('(a) email compare is case/space-insensitive, address compare keeps the token boundary', async () => {
    // '100 palm' must not agree with an estimate on '100 Palmetto Dr'.
    mockDbFixtures['customers:list'] = [{ ...BOB, address_line1: '100 Palm' }];
    const res = await matchAcceptCustomerByPhone(janeEstimate({
      customer_email: '  JANE@Example.com ',
      address: '100 Palmetto Dr, Sarasota, FL 34236',
    }));
    expect(res.contradicted).toBe(true);
  });

  it('(b) email agrees (case-insensitive), address differs: not contradicted', async () => {
    mockDbFixtures['customers:list'] = [BOB];
    const res = await matchAcceptCustomerByPhone(janeEstimate({ customer_email: ' BOB@Example.COM ' }));
    expect(res.match).toBe(BOB);
    expect(res.contradicted).toBeUndefined();
  });

  it('(c) address agrees, email differs (new email, same home): not contradicted', async () => {
    mockDbFixtures['customers:list'] = [BOB];
    const res = await matchAcceptCustomerByPhone(janeEstimate({ address: '100 Palm Ave, Sarasota, FL 34236' }));
    expect(res.match).toBe(BOB);
    expect(res.contradicted).toBeUndefined();
  });

  it('(d) estimate carries no email or no address: cannot contradict', async () => {
    mockDbFixtures['customers:list'] = [BOB];
    for (const customer_email of [null, '', '   ']) {
      expect((await matchAcceptCustomerByPhone(janeEstimate({ customer_email }))).contradicted).toBeUndefined();
    }
    for (const address of [null, '', '  ,  ']) {
      expect((await matchAcceptCustomerByPhone(janeEstimate({ address }))).contradicted).toBeUndefined();
    }
  });

  it('(d) candidate lacks an email or a meaningful street line: cannot contradict', async () => {
    for (const patch of [{ email: null }, { email: '' }, { address_line1: null }, { address_line1: '12' }]) {
      mockDbFixtures['customers:list'] = [{ ...BOB, ...patch }];
      expect((await matchAcceptCustomerByPhone(janeEstimate())).contradicted).toBeUndefined();
    }
  });

  it('no phone candidates, or no phone on the estimate: no match (unchanged)', async () => {
    mockDbFixtures['customers:list'] = [];
    expect((await matchAcceptCustomerByPhone(janeEstimate())).match).toBeNull();
    mockDbFixtures['customers:list'] = [BOB];
    expect(await matchAcceptCustomerByPhone(janeEstimate({ customer_phone: null }))).toEqual({ match: null, candidateCount: 0 });
  });
});

describe('the contradiction uses the canonical address comparison alone', () => {
  // The estimate's email always differs from the profile's here, so ONLY the address decides.
  const verdictFor = async (candidate, address) => {
    mockDbFixtures['customers:list'] = [{ ...BOB, ...candidate }];
    return (await matchAcceptCustomerByPhone(janeEstimate({ address }))).contradicted === true;
  };

  it('suffix, unit-format, case, punctuation and trailing city/ZIP variants of one address do NOT contradict', async () => {
    expect(await verdictFor({ address_line1: '123 Main St' }, '123 Main Street, Bradenton, FL 34205')).toBe(false);
    expect(await verdictFor({ address_line1: '88 Bayview Ave' }, '88 Bayview Avenue, Sarasota, FL 34236')).toBe(false);
    expect(await verdictFor({ address_line1: '45 Oak Dr', address_line2: 'Apt 2' }, '45 Oak Drive #2, Sarasota, FL 34236')).toBe(false);
    expect(await verdictFor({ address_line1: '123 Main St.' }, '123 main street,  bradenton , fl')).toBe(false);
    expect(await verdictFor({ address_line1: '123 Main St', city: 'Bradenton', zip: '34205' }, '123 Main Street, Bradenton, FL 34205')).toBe(false);
  });

  it('a genuinely different street, house number, explicit unit, city or ZIP DOES contradict - a street-line prefix does not rescue it', async () => {
    expect(await verdictFor({ address_line1: '100 Palm Ave' }, '742 Evergreen Ter, Sarasota, FL 34236')).toBe(true);
    expect(await verdictFor({ address_line1: '100 Palm Ave' }, '102 Palm Ave')).toBe(true);
    expect(await verdictFor({ address_line1: '45 Oak Dr', address_line2: 'Apt 2' }, '45 Oak Dr Apt 9')).toBe(true);
    expect(await verdictFor({ address_line1: '100 Palm Ave', city: 'Sarasota' }, '100 Palm Ave, Tampa, FL')).toBe(true);
    expect(await verdictFor({ address_line1: '100 Palm Ave', zip: '34236' }, '100 Palm Ave, Sarasota, FL 33602')).toBe(true);
  });

  it('what the comparison cannot decide is NOT a contradiction: no street number, or a missing unit / city / ZIP', async () => {
    expect(await verdictFor({ address_line1: '100 Palm Ave' }, 'Sarasota, FL')).toBe(false);
    expect(await verdictFor({ address_line1: 'PO Box 12' }, '742 Evergreen Ter, Sarasota, FL 34236')).toBe(false);
    expect(await verdictFor({ address_line1: '45 Oak Dr', address_line2: 'Apt 2' }, '45 Oak Dr')).toBe(false);
    expect(await verdictFor({ address_line1: '100 Palm Ave', city: null, zip: null }, '100 Palm Ave, Tampa, FL 33602')).toBe(false);
  });
});

describe('several phone candidates (unchanged from before)', () => {
  const LANDLORD = { ...BOB, id: 'cust-landlord', email: 'owner@example.com', address_line1: '10 Oak Ln' };
  const RENTAL = { ...BOB, id: 'cust-rental', email: 'owner@example.com', address_line1: '55 Pine Ct' };

  it('a unique email match wins; a unique street match wins; neither unique: no match and NOT parked', async () => {
    mockDbFixtures['customers:list'] = [LANDLORD, { ...RENTAL, email: 'jane@example.com' }];
    expect((await matchAcceptCustomerByPhone(janeEstimate())).match.id).toBe('cust-rental');
    mockDbFixtures['customers:list'] = [LANDLORD, RENTAL];
    expect((await matchAcceptCustomerByPhone(janeEstimate({ address: '55 Pine Ct, Sarasota, FL 34236' }))).match.id).toBe('cust-rental');
    const none = await matchAcceptCustomerByPhone(janeEstimate());
    expect(none.match).toBeNull();
    expect(none.contradicted).toBeUndefined();
  });

  it('the lone-candidate rule is not applied to several candidates, even when each would contradict alone', async () => {
    mockDbFixtures['customers:list'] = [LANDLORD, RENTAL];
    expect((await acceptPhoneParkedVerdict(janeEstimate()))).toBeNull();
  });
});

describe('acceptPhoneParkedVerdict (the preflight park decision)', () => {
  it('parks an unlinked estimate whose lone phone candidate is contradicted, and only that', async () => {
    mockDbFixtures['customers:list'] = [BOB];
    expect(await acceptPhoneParkedVerdict(janeEstimate())).toEqual({ rejectedCustomerId: 'cust-bob' });
    expect(await acceptPhoneParkedVerdict(janeEstimate({ customer_email: 'bob@example.com' }))).toBeNull();
    // Linked or phone-less estimates are never parked, and never hit the database.
    mockDbFixtures['customers:list'] = [];
    expect(await acceptPhoneParkedVerdict(janeEstimate({ customer_id: 'cust-1' }))).toBeNull();
    expect(await acceptPhoneParkedVerdict(janeEstimate({ customer_phone: null }))).toBeNull();
  });

  it('forms ONE verdict per estimate object: a second call reads the cache, not the database', async () => {
    mockDbFixtures['customers:list'] = [BOB];
    const dbMock = require('../models/db');
    const est = janeEstimate();
    await acceptPhoneParkedVerdict(est);
    dbMock.mockClear();
    mockDbFixtures['customers:list'] = [];
    expect(await acceptPhoneParkedVerdict(est)).toEqual({ rejectedCustomerId: 'cust-bob' });
    expect(dbMock).not.toHaveBeenCalled();
  });
});
