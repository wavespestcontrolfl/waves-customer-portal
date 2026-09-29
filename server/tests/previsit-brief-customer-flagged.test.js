/**
 * deterministicVisitFacts's customerFlagged wiring (PR 3a — customer
 * photos before a visit, tech Visit Brief surface). Companion to
 * previsit-brief-visit-facts.test.js (access/last_visit), which this file
 * does not duplicate: same fixture shape, but every case here turns only
 * on GATE_VISIT_PREP_PHOTOS (visitPrepPhotosLive()) and
 * visit-prep.js's customerFlaggedFacts, both mocked so the membership-
 * resolution behavior itself (proven directly in
 * visit-prep-tech-facts.test.js) is not re-tested here.
 */

jest.mock('../models/db', () => {
  const fn = () => { throw new Error('global db must not be used — dbh is passed explicitly'); };
  fn.transaction = jest.fn();
  return fn;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../config/models', () => ({
  TEXT_POLICIES: { visitBrief: { name: 'visitBrief' } },
}));
jest.mock('../services/llm/call', () => ({
  dispatchWithFallback: jest.fn(),
}));

const mockVisitPrepPhotosLive = jest.fn();
jest.mock('../config/feature-gates', () => ({
  visitPrepPhotosLive: (...args) => mockVisitPrepPhotosLive(...args),
}));

const mockCustomerFlaggedFacts = jest.fn();
jest.mock('../services/visit-prep', () => ({
  customerFlaggedFacts: (...args) => mockCustomerFlaggedFacts(...args),
}));

const { deterministicVisitFacts } = require('../services/previsit-brief');
const logger = require('../services/logger');

const SVC = {
  id: 'svc-1',
  customer_id: 'cust-1',
  visit_id: null,
  service_type: 'Lawn Care Service',
  scheduled_date: '2026-08-13',
  notes: null,
};

// A dbh stub whose reads all succeed but resolve to nothing — this suite
// only asserts on customerFlagged, so access/last_visit are left empty
// rather than exercised here (see previsit-brief-visit-facts.test.js).
function emptyDbh() {
  return (table) => {
    const q = {};
    for (const m of ['where', 'whereIn', 'whereNotIn', 'orderBy', 'offset', 'limit', 'leftJoin', 'modify']) {
      q[m] = () => q;
    }
    q.select = async () => [];
    q.first = async () => undefined;
    return q;
  };
}

describe('deterministicVisitFacts — customerFlagged', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('gate off: visit-prep is never consulted, key is omitted entirely (byte-identical facts)', async () => {
    mockVisitPrepPhotosLive.mockReturnValue(false);
    const facts = await deterministicVisitFacts(SVC, emptyDbh());
    expect(mockCustomerFlaggedFacts).not.toHaveBeenCalled();
    expect('customerFlagged' in facts).toBe(false);
  });

  test('gate on, stop has submissions: customerFlagged is populated straight from visit-prep\'s read', async () => {
    mockVisitPrepPhotosLive.mockReturnValue(true);
    const entries = [{
      id: 'sub-1', sentAt: '2026-09-30T23:42:00.000Z', topic: 'lawn',
      locationOnProperty: 'back_yard', note: 'Brown spots spreading', photoIds: ['photo-a', 'photo-b'],
    }];
    mockCustomerFlaggedFacts.mockResolvedValue(entries);
    const dbh = emptyDbh();
    const facts = await deterministicVisitFacts(SVC, dbh);
    expect(facts.customerFlagged).toEqual(entries);
    // Threaded through with the SAME svc row and dbh the rest of the facts
    // builder uses — never the global pool (scope §5.2/§7 grouping rule,
    // proven at the visit-prep layer; this only checks the wiring).
    expect(mockCustomerFlaggedFacts).toHaveBeenCalledWith(SVC, dbh);
  });

  test('gate on, stop has no submissions: visit-prep returns null → key omitted, not an empty array', async () => {
    mockVisitPrepPhotosLive.mockReturnValue(true);
    mockCustomerFlaggedFacts.mockResolvedValue(null);
    const facts = await deterministicVisitFacts(SVC, emptyDbh());
    expect('customerFlagged' in facts).toBe(false);
  });

  test('gate on, visit-prep read throws: fail-soft — key omitted, facts still returned, warning logged', async () => {
    mockVisitPrepPhotosLive.mockReturnValue(true);
    mockCustomerFlaggedFacts.mockRejectedValue(new Error('boom'));
    const facts = await deterministicVisitFacts(SVC, emptyDbh());
    expect('customerFlagged' in facts).toBe(false);
    expect(facts.access).toBeDefined();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('customerFlagged unreadable'));
  });
});
