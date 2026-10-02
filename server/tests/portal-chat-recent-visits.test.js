// GATE_PORTAL_CHAT_VISIT_FACTS: "what was done last visit?" is answered from
// the Completed tab's own read. The model gets the date, service, technician
// first name, kinds of product and the reviewed summary — never a product
// brand, a price, an address or a report token.
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../routes/reschedule-public', () => ({ _internals: { loadById: jest.fn(), pageEligibility: jest.fn() } }));
jest.mock('../services/portal-payment-history', () => ({ listPortalPayments: jest.fn() }));
jest.mock('../services/portal-service-history', () => ({ listPortalServiceHistory: jest.fn() }));

const { listPortalServiceHistory } = require('../services/portal-service-history');
const { portalToolsFor, executeToolCall } = require('../services/ai-assistant/tools');

const OPEN_COMPLETED = { type: 'tab', label: 'Open completed visits and reports', tab: 'services' };
const VISITS = [
  {
    id: 's1', date: '2026-09-28', type: 'Quarterly Pest Control', technician: 'Jordan Sample',
    notes: 'Treated the exterior perimeter and the lanai. Ant activity at the garage door was treated.',
    products: [
      { product_name: 'BrandName SC', product_category: 'insecticide', active_ingredient: 'x' },
      { product_name: 'OtherBrand G', product_category: 'insecticide', active_ingredient: 'y' },
      { product_name: 'BaitBrand', product_category: 'bait', active_ingredient: 'z' },
    ],
    reportUrl: '/report/tok_report_1', reportAvailable: true,
  },
  {
    id: 's2', date: new Date('2026-08-20T00:00:00Z'), type: 'Lawn Care', technician: null,
    notes: null, products: [], reportUrl: null, reportAvailable: false,
  },
];

beforeEach(() => jest.clearAllMocks());

test('the tool is in the set only when its gate is on, and escalate stays last', () => {
  expect(portalToolsFor({}).map((t) => t.name)).not.toContain('get_recent_visits');
  expect(portalToolsFor({ payments: true, visits: true }).map((t) => t.name)).toEqual([
    'get_upcoming_services', 'get_pest_advice', 'offer_reschedule_link', 'open_portal_section',
    'show_recent_payments', 'get_recent_visits', 'escalate',
  ]);
});

test('returns the visit facts to the model and a View report button, with no brand, price, address or token', async () => {
  listPortalServiceHistory.mockResolvedValue({ services: VISITS, total: 2 });
  const actions = [];

  const result = await executeToolCall('get_recent_visits', {}, 'cust-1', actions);

  expect(listPortalServiceHistory).toHaveBeenCalledWith('cust-1', { limit: 3 });
  expect(result.visits).toEqual([
    {
      date: 'Sep 28, 2026', service: 'Quarterly Pest Control', technician: 'Jordan',
      product_kinds: ['insecticide', 'bait'],
      summary: 'Treated the exterior perimeter and the lanai. Ant activity at the garage door was treated.',
      report_button_shown: true,
    },
    { date: 'Aug 20, 2026', service: 'Lawn Care', technician: null, product_kinds: [], summary: null, report_button_shown: false },
  ]);
  expect(actions).toEqual([
    OPEN_COMPLETED,
    { type: 'link', label: 'View report, Quarterly Pest Control, Sep 28, 2026', href: '/report/tok_report_1' },
  ]);
  const toModel = JSON.stringify(result);
  for (const secret of ['BrandName', 'OtherBrand', 'BaitBrand', 'tok_report_1', 'Sample', '$']) {
    expect(toModel).not.toContain(secret);
  }
});

test('a long summary is capped, and a report hosted elsewhere gets no button', async () => {
  listPortalServiceHistory.mockResolvedValue({ services: [{ ...VISITS[0], notes: 'x'.repeat(2000), reportUrl: 'https://files.example/report.pdf' }], total: 1 });
  const actions = [];
  const result = await executeToolCall('get_recent_visits', {}, 'cust-1', actions);
  expect(result.visits[0].summary).toHaveLength(600);
  expect(result.visits[0].report_button_shown).toBe(false);
  expect(actions).toEqual([OPEN_COMPLETED]);
});

test('two visits that would share a button label get no report button', async () => {
  listPortalServiceHistory.mockResolvedValue({ services: [VISITS[0], { ...VISITS[0], id: 's9', reportUrl: '/report/tok_report_9' }], total: 2 });
  const actions = [];
  const result = await executeToolCall('get_recent_visits', {}, 'cust-1', actions);
  expect(actions).toEqual([OPEN_COMPLETED]);
  expect(result.visits.map((v) => v.report_button_shown)).toEqual([false, false]);
});

test('no visits says so; an empty page with history behind it does not', async () => {
  listPortalServiceHistory.mockResolvedValue({ services: [], total: 0 });
  expect((await executeToolCall('get_recent_visits', {}, 'cust-1', [])).instruction).toMatch(/No completed visits are on record/);
  listPortalServiceHistory.mockResolvedValue({ services: [], total: 5 });
  expect((await executeToolCall('get_recent_visits', {}, 'cust-1', [])).instruction).not.toMatch(/No completed visits/);
});

test('a read failure never throws and still offers the Completed visits page', async () => {
  listPortalServiceHistory.mockRejectedValue(new Error('db down'));
  const actions = [];
  const result = await executeToolCall('get_recent_visits', {}, 'cust-1', actions);
  expect(result.visits).toBeNull();
  expect(actions).toEqual([OPEN_COMPLETED]);
});

test('refuses a model-supplied customer id and a channel without buttons', async () => {
  expect(await executeToolCall('get_recent_visits', { customer_id: 'other' }, 'cust-1', [])).toEqual({ error: 'Customer scope mismatch' });
  expect((await executeToolCall('get_recent_visits', {}, 'cust-1')).visits).toBeNull();
  expect(listPortalServiceHistory).not.toHaveBeenCalled();
});
