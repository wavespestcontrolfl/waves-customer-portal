const mockState = { rows: [], labels: new Map(), paid: new Map(), where: [] };

jest.mock('../models/db', () => {
  const db = jest.fn(() => {
    const q = {};
    q.where = jest.fn((...args) => { mockState.where.push(args); return q; });
    q.whereNotNull = jest.fn((...args) => { mockState.where.push(args); return q; });
    q.orderBy = jest.fn(() => q);
    q.select = jest.fn(() => q);
    q.then = (resolve, reject) => Promise.resolve(mockState.rows).then(resolve, reject);
    return q;
  });
  db.raw = jest.fn((sql) => sql);
  return db;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../services/annual-prepay-renewals', () => ({
  coverageAwaitsInstallation: (term) => Boolean(term.annual_plan_version && !term.renewed_from_term_id && !term.installation_anchored_at),
  isCoveredTerm: (id) => Promise.resolve(mockState.paid.get(id) !== false),
  isPaidDecidedLapseTerm: (term) => Promise.resolve(mockState.paid.get(term.id) !== false),
  termiteDeclineBlockedReason: (term, today) => {
    if (term.renewal_decision) return 'already_decided';
    if (term.status === 'renewed') return null;
    if (!['active', 'renewal_pending', 'payment_pending'].includes(term.status)) return 'not_active';
    if (term.annual_plan_version && !term.renewed_from_term_id && !term.installation_anchored_at) return null;
    return term.term_end <= today ? 'term_ended' : null;
  },
  termPropertyLabelsForCustomer: () => Promise.resolve(mockState.labels),
  whereTermCurrentOrAwaitingInstallation: (builder, today) => builder.where('term_end', '>=', today),
}));

const db = require('../models/db');
const {
  getAnnualPlanDocumentForCustomer,
  listAnnualPlanDocumentsForCustomer,
} = require('../services/annual-plan-documents');

const anchored = (id, extra = {}) => ({
  id, term_end: '2027-10-25', prepay_amount: '450.00', status: 'active', renewal_decision: null,
  annual_plan_version: 'v3', renewed_from_term_id: null, installation_anchored_at: '2026-10-25T14:00:00Z',
  created_at: '2026-10-01T14:00:00Z', updated_at: '2026-10-24T14:00:00Z', ...extra,
});

beforeEach(() => {
  mockState.rows = [];
  mockState.labels = new Map();
  mockState.paid = new Map();
  mockState.where = [];
  jest.clearAllMocks();
});

test('list is customer-scoped, excludes refunded lapse rows, and exposes only the stable public projection', async () => {
  mockState.rows = [
    anchored('term-current'),
    anchored('term-refunded', { status: 'cancelled', renewal_decision: 'cancel' }),
  ];
  mockState.paid.set('term-refunded', false);
  mockState.labels = new Map([['term-current', { label: '100 Synthetic Way, Bradenton, FL 34202', termTied: true }]]);

  const documents = await listAnnualPlanDocumentsForCustomer('customer-a', { today: '2026-10-25' });

  expect(mockState.where).toContainEqual([{ customer_id: 'customer-a' }]);
  expect(mockState.where).toContainEqual(['annual_plan_version']);
  expect(documents).toHaveLength(1);
  expect(documents[0]).toMatchObject({
    id: 'annual_plan_term-current', documentType: 'annual_summary', title: 'Annual plan renewal',
    description: 'Renewal details for 100 Synthetic Way, Bradenton, FL 34202',
    downloadUrl: '/api/documents/annual-plan/annual_plan_term-current', shareable: false,
    facts: {
      currentPlanAmount: 450, currentTermEnds: '2027-10-25', awaitsInstallation: false,
      declined: false, unpaid: false,
    },
  });
  expect(documents[0]).not.toHaveProperty('termId');
  expect(documents[0]).not.toHaveProperty('customerId');
  expect(documents[0]).not.toHaveProperty('canDecline');
  expect(documents[0].facts).not.toHaveProperty('canDecline');
});

test('provisional dates are suppressed and get exact-matches only an eligible document id', async () => {
  mockState.rows = [anchored('term-awaiting', {
    term_end: '2025-01-01', prepay_amount: '399.00', status: 'payment_pending',
    renewal_decision: 'cancel', installation_anchored_at: null,
  })];
  mockState.labels = new Map([['term-awaiting', { label: '200 Test Loop', termTied: true }]]);

  const document = await getAnnualPlanDocumentForCustomer(
    'customer-a', 'annual_plan_term-awaiting', { conn: db, today: '2026-10-25' },
  );
  expect(document.facts).toEqual({
    propertyLabel: '200 Test Loop', currentPlanAmount: 399, currentTermEnds: null,
    awaitsInstallation: true, declined: true, unpaid: true,
  });
  expect(document.fileName).toBe('Annual_Plan_Renewal_current.pdf');
  await expect(getAnnualPlanDocumentForCustomer('customer-a', 'term-awaiting', { conn: db, today: '2026-10-25' })).resolves.toBeNull();
  await expect(getAnnualPlanDocumentForCustomer('customer-a', 'annual_plan_other', { conn: db, today: '2026-10-25' })).resolves.toBeNull();
});
