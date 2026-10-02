// GATE_PORTAL_CHAT_VISIT_FACTS: "what was done last visit?" is answered from
// the Completed tab's own read. The model gets the date, service, technician
// first name and kinds of product. The reviewed summary is free text, so it
// and the report link go on a server-built card the model never sees.
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

test('the model gets structured facts; the summary and report link go on a card it never sees', async () => {
  listPortalServiceHistory.mockResolvedValue({ services: [
    // Reviewed text is free text: it can carry a brand, a price or an address.
    { ...VISITS[0], notes: 'Applied BrandName SC at 123 Example Ave. A $49 add-on was discussed.' },
    VISITS[1],
  ], total: 2 });
  const actions = []; const cards = [];

  const result = await executeToolCall('get_recent_visits', {}, 'cust-1', actions, cards);

  expect(listPortalServiceHistory).toHaveBeenCalledWith('cust-1', { limit: 3 });
  expect(result.visits).toEqual([
    { date: 'Sep 28, 2026', service: 'Quarterly Pest Control', technician: 'Jordan', product_kinds: ['insecticide', 'bait'], summary_on_card: true, report_link_on_card: true },
    { date: 'Aug 20, 2026', service: 'Lawn Care', technician: null, product_kinds: [], summary_on_card: false, report_link_on_card: false },
  ]);
  expect(actions).toEqual([OPEN_COMPLETED]);
  expect(cards).toEqual([{
    type: 'visits',
    title: 'Your last 2 visits',
    rows: [
      { id: 's1', service: 'Quarterly Pest Control', dateLabel: 'Sep 28, 2026', technician: 'Jordan', summary: 'Applied BrandName SC at 123 Example Ave. A $49 add-on was discussed.', reportUrl: '/report/tok_report_1' },
      { id: 's2', service: 'Lawn Care', dateLabel: 'Aug 20, 2026', technician: null, summary: null, reportUrl: null },
    ],
  }]);
  // Nothing free-text, and no brand, price, address, surname or token, reaches the model.
  const toModel = JSON.stringify(result);
  for (const secret of ['BrandName', 'OtherBrand', 'BaitBrand', '123 Example', '$49', 'add-on', 'tok_report_1', 'Sample']) {
    expect(toModel).not.toContain(secret);
  }
});

test('a long summary is capped on the card, a report hosted elsewhere gets no link, and a repeat read replaces the card', async () => {
  listPortalServiceHistory.mockResolvedValue({ services: [{ ...VISITS[0], notes: 'x'.repeat(2000), reportUrl: 'https://files.example/report.pdf' }], total: 1 });
  const cards = [];
  await executeToolCall('get_recent_visits', {}, 'cust-1', [], cards);
  const result = await executeToolCall('get_recent_visits', {}, 'cust-1', [], cards);
  expect(cards).toHaveLength(1);
  expect(cards[0].rows[0].summary).toHaveLength(600);
  expect(cards[0].rows[0].reportUrl).toBeNull();
  expect(result.visits[0].report_link_on_card).toBe(false);
  // A later read that fails clears the earlier card.
  listPortalServiceHistory.mockRejectedValue(new Error('db down'));
  await executeToolCall('get_recent_visits', {}, 'cust-1', [], cards);
  expect(cards).toEqual([]);
});

test('no visits says so; an empty page with history behind it does not', async () => {
  listPortalServiceHistory.mockResolvedValue({ services: [], total: 0 });
  expect((await executeToolCall('get_recent_visits', {}, 'cust-1', [], [])).instruction).toMatch(/No completed visits are on record/);
  listPortalServiceHistory.mockResolvedValue({ services: [], total: 5 });
  expect((await executeToolCall('get_recent_visits', {}, 'cust-1', [], [])).instruction).not.toMatch(/No completed visits/);
});

test('a read failure never throws and still offers the Completed visits page', async () => {
  listPortalServiceHistory.mockRejectedValue(new Error('db down'));
  const actions = []; const cards = [];
  const result = await executeToolCall('get_recent_visits', {}, 'cust-1', actions, cards);
  expect(result.visits).toBeNull();
  expect(cards).toEqual([]);
  expect(actions).toEqual([OPEN_COMPLETED]);
});

test('refuses a model-supplied customer id and a channel without buttons', async () => {
  expect(await executeToolCall('get_recent_visits', { customer_id: 'other' }, 'cust-1', [], [])).toEqual({ error: 'Customer scope mismatch' });
  expect((await executeToolCall('get_recent_visits', {}, 'cust-1', [])).visits).toBeNull();
  expect(listPortalServiceHistory).not.toHaveBeenCalled();
});
