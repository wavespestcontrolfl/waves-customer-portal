// GATE_PORTAL_CHAT_FACTS: the portal assistant answers "explain my last
// charge" with a server-rendered card of the customer's recent payments (the
// Billing tab's own rows) and an Open Billing button. The model is told the
// card is there and the status words; no amount, date or description it
// could misstate ever reaches it.
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../routes/reschedule-public', () => ({ _internals: { loadById: jest.fn(), pageEligibility: jest.fn() } }));
jest.mock('../services/portal-payment-history', () => ({ listPortalPayments: jest.fn() }));

const { listPortalPayments } = require('../services/portal-payment-history');
const { PORTAL_TOOLS, PORTAL_FACTS_TOOLS, executeToolCall } = require('../services/ai-assistant/tools');

const PAYMENTS = [
  { id: 'p1', date: '2026-09-28', amount: 129, status: 'paid', description: 'Invoice WV-1042 — Quarterly Pest Control — per application', cardBrand: 'visa', lastFour: '4242', methodType: 'card', refundAmount: null, receiptUrl: '/receipt/tok_abc', receiptPdfUrl: '/api/receipt/tok_abc/pdf' },
  { id: 'p2', date: new Date('2026-08-28T00:00:00Z'), amount: 1250.5, status: 'failed', description: 'Silver WaveGuard Monthly', cardBrand: null, lastFour: '9876', methodType: 'bank_account', bankName: 'Example Bank', refundAmount: null, receiptUrl: null },
  { id: 'p3', date: '2026-07-28', amount: 129, status: 'paid', description: 'Invoice WV-0990', cardBrand: 'visa', lastFour: '4242', methodType: 'card', refundAmount: 29, refundStatus: 'partial', receiptUrl: null, stripeReceiptUrl: 'https://pay.stripe.com/receipts/x' },
];

beforeEach(() => jest.clearAllMocks());

test('the facts tool set is the portal set plus show_recent_payments', () => {
  expect(PORTAL_TOOLS.map((t) => t.name)).not.toContain('show_recent_payments');
  expect(PORTAL_FACTS_TOOLS.map((t) => t.name)).toEqual([
    'get_upcoming_services', 'get_pest_advice', 'offer_reschedule_link', 'open_portal_section', 'show_recent_payments', 'escalate',
  ]);
});

test('renders the Billing tab rows as a card, adds Open Billing, and tells the model only statuses', async () => {
  listPortalPayments.mockResolvedValue({ payments: PAYMENTS });
  const actions = []; const cards = [];

  const result = await executeToolCall('show_recent_payments', {}, 'cust-1', actions, cards);

  expect(listPortalPayments).toHaveBeenCalledWith('cust-1', { limit: 3 });
  expect(actions).toEqual([{ type: 'tab', label: 'Open Billing', tab: 'billing' }]);
  expect(cards).toEqual([{
    type: 'payments',
    title: 'Your last 3 payments',
    rows: [
      { id: 'p1', description: 'Invoice WV-1042 — Quarterly Pest Control', dateLabel: 'Sep 28, 2026', amountLabel: '$129.00', statusLabel: 'Paid', methodLabel: 'Visa ending in 4242', receiptUrl: '/receipt/tok_abc' },
      { id: 'p2', description: 'Silver WaveGuard Monthly', dateLabel: 'Aug 28, 2026', amountLabel: '$1,250.50', statusLabel: 'Failed', methodLabel: 'Example Bank ending in 9876', receiptUrl: null },
      { id: 'p3', description: 'Invoice WV-0990', dateLabel: 'Jul 28, 2026', amountLabel: '$129.00', statusLabel: 'Paid, $29.00 refunded', methodLabel: 'Visa ending in 4242', receiptUrl: null },
    ],
  }]);
  expect(result.shown).toBe(true);
  expect(result.count).toBe(3);
  expect(result.statuses).toEqual(['Paid', 'Failed', 'Paid']);
  // Nothing the model receives carries a figure, date, description or card.
  const toModel = JSON.stringify(result);
  for (const secret of ['129', '1,250', '$', 'Sep', 'Aug', '2026', 'WV-1042', 'WaveGuard', '4242', '9876', 'Visa', 'Example Bank', 'tok_abc', 'stripe.com']) {
    expect(toModel).not.toContain(secret);
  }
  // No Stripe-hosted receipt on the card either: only the Waves receipt page.
  expect(JSON.stringify(cards)).not.toContain('stripe.com');
});

test('a scheduled Auto Pay row is labeled Scheduled and never hides the card', async () => {
  // A date always in the future, so the fixture never ages into Processing.
  const nextMonth = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
  listPortalPayments.mockResolvedValue({ payments: [{ id: 'up', date: nextMonth, amount: 129, status: 'upcoming', description: 'Silver WaveGuard Monthly', cardBrand: 'visa', lastFour: '4242', methodType: 'card', receiptUrl: null }, PAYMENTS[0]] });
  const cards = [];
  const result = await executeToolCall('show_recent_payments', {}, 'cust-1', [], cards);
  expect(result.shown).toBe(true);
  expect(result.statuses).toEqual(['Scheduled', 'Paid']);
  expect(cards[0].rows.map((r) => r.statusLabel)).toEqual(['Scheduled', 'Paid']);
});

test('a past-dated upcoming row shows as Processing, as on the Billing tab, and a repeated call replaces the card', async () => {
  listPortalPayments.mockResolvedValue({ payments: [{ id: 'up', date: '2026-01-05', amount: 129, status: 'upcoming', description: 'Monthly', cardBrand: 'visa', lastFour: '4242', methodType: 'card', receiptUrl: null }] });
  const cards = [];
  await executeToolCall('show_recent_payments', {}, 'cust-1', [], cards);
  const result = await executeToolCall('show_recent_payments', {}, 'cust-1', [], cards);
  expect(cards).toHaveLength(1);
  expect(cards[0].rows[0].statusLabel).toBe('Processing');
  expect(result.statuses).toEqual(['Processing']);
  // A later read that must not show clears the earlier card.
  listPortalPayments.mockRejectedValue(new Error('db down'));
  await executeToolCall('show_recent_payments', {}, 'cust-1', [], cards);
  expect(cards).toEqual([]);
});

test('any payment the card cannot label means no card: a disputed newest payment never lets an older paid one read as the latest', async () => {
  listPortalPayments.mockResolvedValue({ payments: [{ ...PAYMENTS[0], status: 'disputed' }, PAYMENTS[2]] });
  const actions = []; const cards = [];
  const result = await executeToolCall('show_recent_payments', {}, 'cust-1', actions, cards);
  expect(cards).toEqual([]);
  expect(result.shown).toBe(false);
  expect(result.instruction).toMatch(/pass the question to the team/);
  expect(actions).toEqual([{ type: 'tab', label: 'Open Billing', tab: 'billing' }]);
});

test('a refund that has not settled withholds the card', async () => {
  listPortalPayments.mockResolvedValue({ payments: [{ ...PAYMENTS[2], refundStatus: 'pending' }] });
  const cards = [];
  const result = await executeToolCall('show_recent_payments', {}, 'cust-1', [], cards);
  expect(cards).toEqual([]);
  expect(result.shown).toBe(false);
  expect(result.instruction).toMatch(/pass the question to the team/);
});

test('an unreadable payer ownership lookup shows no card', async () => {
  listPortalPayments.mockResolvedValue({ payments: PAYMENTS, payerLookupFailed: true });
  const cards = []; const actions = [];
  const result = await executeToolCall('show_recent_payments', {}, 'cust-1', actions, cards);
  expect(cards).toEqual([]);
  expect(result.shown).toBe(false);
  expect(actions).toEqual([{ type: 'tab', label: 'Open Billing', tab: 'billing' }]);
});

test('an empty page with history behind it is not "no payments"', async () => {
  listPortalPayments.mockResolvedValue({ payments: [], hasMore: true, total: 4 });
  const result = await executeToolCall('show_recent_payments', {}, 'cust-1', [], []);
  expect(result.shown).toBe(false);
  expect(result.instruction).not.toMatch(/No payments are on record/);
  expect(result.instruction).toMatch(/pass the question to the team/);
});

test('no payments on record says so', async () => {
  listPortalPayments.mockResolvedValue({ payments: [], hasMore: false, total: 0 });
  const result = await executeToolCall('show_recent_payments', {}, 'cust-1', [], []);
  expect(result).toEqual(expect.objectContaining({ shown: false, count: 0 }));
  expect(result.instruction).toMatch(/No payments are on record/);
});

test('a read failure shows nothing, never throws, and still offers Open Billing', async () => {
  listPortalPayments.mockRejectedValue(new Error('db down'));
  const cards = []; const actions = [];
  const result = await executeToolCall('show_recent_payments', {}, 'cust-1', actions, cards);
  expect(result.shown).toBe(false);
  expect(cards).toEqual([]);
  expect(actions).toEqual([{ type: 'tab', label: 'Open Billing', tab: 'billing' }]);
});

test('refuses a model-supplied customer id and a channel without cards', async () => {
  expect(await executeToolCall('show_recent_payments', { customer_id: 'other' }, 'cust-1', [], [])).toEqual({ error: 'Customer scope mismatch' });
  expect((await executeToolCall('show_recent_payments', {}, 'cust-1', [])).shown).toBe(false);
  expect(listPortalPayments).not.toHaveBeenCalled();
});
