/**
 * Voice-relay Phase D — get_open_estimates, get_invoice_history,
 * get_services_catalog.
 *
 * What these lock down:
 *   - SENT-PRICE DOCTRINE: open estimates are read from the persisted totals +
 *     the frozen sendSnapshot, and the pricing engine is NEVER called
 *   - estimates tier split: amounts only for the ANI-matched caller; a
 *     looked-up ref gets existence + date, no numbers
 *   - invoices are ANI-matched-caller only
 *   - NO pay link, receipt link, reservice token, URL, or long token in ANY of
 *     these outputs (the outputs are regexed)
 *   - the catalog works for an unmatched caller (public information) and names
 *     only what the catalog actually carries
 */

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/lead-from-extraction', () => ({ createLeadFromExtraction: jest.fn() }));
jest.mock('../services/conversations', () => ({ syncVoiceMessageForCall: jest.fn() }));
jest.mock('../config/feature-gates', () => ({ isEnabled: jest.fn(() => false) }));
jest.mock('../services/call-recording-processor', () => ({
  CONTACT_MATCH_PHONE_COLS: ['phone'],
  summarizePriorCall: jest.fn(),
}));
jest.mock('../services/call-booking-source-actions', () => ({ DISPATCH_OWNED_PENDING_SOURCE_ACTIONS: ['call_followup'] }));
jest.mock('../services/project-types', () => ({ customerSafeServiceNotes: jest.fn((n) => n || null) }));
// The pricing engine must NEVER be reached from the estimate path.
jest.mock('../services/pricing-engine', () => ({ generateEstimate: jest.fn() }));
jest.mock('../services/open-balance', () => ({ openBalanceSummary: jest.fn() }));
jest.mock('../services/call-booking-catalog', () => ({ loadBookableCallServices: jest.fn() }));

const db = require('../models/db');
const { generateEstimate } = require('../services/pricing-engine');
const { openBalanceSummary } = require('../services/open-balance');
const { loadBookableCallServices } = require('../services/call-booking-catalog');

const relayMoney = require('../services/voice-agent/relay-money');
const { activeTools, executeTool } = require('../services/voice-agent/relay-tools');
const { buildBasePrompt } = require('../services/voice-agent/relay-conversation');

const CUSTOMER_ID = 'c-1111';

function makeBuilder(rows) {
  const b = {};
  const chain = ['whereNull', 'whereIn', 'whereNotIn', 'whereNotNull', 'orderBy', 'select', 'limit',
    'whereRaw', 'orWhereRaw', 'orWhere', 'orWhereNot', 'orWhereNotIn', 'whereNot', 'join', 'leftJoin'];
  for (const m of chain) b[m] = jest.fn(() => b);
  b.where = jest.fn(function whereImpl(arg) { if (typeof arg === 'function') arg.call(b, b); return b; });
  b.first = jest.fn(() => Promise.resolve(rows[0] || null));
  b.then = (resolve, reject) => Promise.resolve(rows).then(resolve, reject);
  b.insert = jest.fn(() => { throw new Error('WRITE ATTEMPTED'); });
  b.update = jest.fn(() => { throw new Error('WRITE ATTEMPTED'); });
  b.del = jest.fn(() => { throw new Error('WRITE ATTEMPTED'); });
  return b;
}

let builders;
function primeDb(tables = {}) {
  builders = {};
  for (const [t, rows] of Object.entries(tables)) builders[t] = makeBuilder(rows);
  db.mockImplementation((table) => {
    if (!builders[table]) builders[table] = makeBuilder([]);
    return builders[table];
  });
}

function assertNoWrites() {
  for (const b of Object.values(builders || {})) {
    expect(b.insert).not.toHaveBeenCalled();
    expect(b.update).not.toHaveBeenCalled();
    expect(b.del).not.toHaveBeenCalled();
  }
}

// House rule: /pay + receipt + reservice tokens never leave their channel.
const TOKEN_LEAK_RE = /\/pay\/|\/receipt\/|\/estimate\/|reservice|https?:\/\/|[A-Za-z0-9_-]{20,}/;

const savedGate = process.env.VOICE_RELAY_CONTEXT_ENABLED;
afterAll(() => {
  if (savedGate === undefined) delete process.env.VOICE_RELAY_CONTEXT_ENABLED;
  else process.env.VOICE_RELAY_CONTEXT_ENABLED = savedGate;
});

beforeEach(() => {
  jest.clearAllMocks();
  process.env.VOICE_RELAY_CONTEXT_ENABLED = 'true';
  primeDb();
  openBalanceSummary.mockResolvedValue({ total: 0, count: 0, moreCount: 0, invoices: [] });
  loadBookableCallServices.mockResolvedValue([]);
});

// A sent estimate whose snapshot carries the SENT prices, and whose token
// column would leak a bearer credential if it were ever selected.
const SENT_ESTIMATE = {
  id: 'est-1',
  status: 'sent',
  service_type: 'Quarterly Pest Control',
  created_at: '2026-07-20T12:00:00Z',
  sent_at: '2026-07-21T12:00:00Z',
  expires_at: '2026-08-20T12:00:00Z',
  monthly_total: 41.5,
  annual_total: 498,
  onetime_total: 99,
  token: 'abcd1234abcd1234abcd1234abcd',
  estimate_data: JSON.stringify({
    sendSnapshot: {
      renderedAt: '2026-07-21T12:00:00Z',
      pricingBundle: {
        lineItems: [
          { description: 'Quarterly pest control', monthly: 41.5 },
          { description: 'Initial service setup', amount: 99 },
        ],
      },
    },
  }),
};

describe('get_open_estimates — SENT-price doctrine', () => {
  test('gate off → not registered and refuses', async () => {
    delete process.env.VOICE_RELAY_CONTEXT_ENABLED;
    expect(activeTools().map((t) => t.name)).not.toContain('get_open_estimates');
    const out = await executeTool('get_open_estimates', {}, { customerId: CUSTOMER_ID });
    expect(out).toMatch(/not available/i);
    expect(db).not.toHaveBeenCalled();
  });

  test('matched caller → snapshot line items + persisted totals, and NO pricing-engine call', async () => {
    primeDb({ estimates: [SENT_ESTIMATE] });
    const out = await executeTool('get_open_estimates', {}, { customerId: CUSTOMER_ID });
    // The whole point: sent prices are READ, never recomputed.
    expect(generateEstimate).not.toHaveBeenCalled();
    expect(out).toContain('Quarterly pest control at $41.50 per month');
    expect(out).toContain('Initial service setup at $99');
    expect(out).toContain('$41.50 per month');
    expect(out).toContain('$498 per year');
    expect(out).toContain('$99 one-time');
    expect(out).toMatch(/prices the estimate was SENT at/);
    expect(out).toMatch(/never re-price/i);
    assertNoWrites();
  });

  test('only sent/viewed estimates count as open, newest first', async () => {
    primeDb({ estimates: [SENT_ESTIMATE] });
    await executeTool('get_open_estimates', {}, { customerId: CUSTOMER_ID });
    const b = builders.estimates;
    expect(b.whereIn).toHaveBeenCalledWith('status', ['sent', 'viewed']);
    expect(relayMoney.OPEN_ESTIMATE_STATUSES).toEqual(['sent', 'viewed']);
    expect(b.orderBy).toHaveBeenCalledWith('created_at', 'desc');
  });

  test('the estimate view token is never SELECTed, and never reaches the output', async () => {
    primeDb({ estimates: [SENT_ESTIMATE] });
    const out = await executeTool('get_open_estimates', {}, { customerId: CUSTOMER_ID });
    const selected = builders.estimates.select.mock.calls.flat();
    expect(selected).not.toContain('token');
    expect(out).not.toContain(SENT_ESTIMATE.token);
    expect(out).not.toMatch(TOKEN_LEAK_RE);
    expect(out).toMatch(/Do not read out a link/i);
  });

  test('looked-up ref → existence + date ONLY, never an amount', async () => {
    primeDb({ estimates: [SENT_ESTIMATE] });
    const ctx = { customerId: 'c-other', resolveLookupRef: (r) => (String(r).toUpperCase() === 'C1' ? 'c-9001' : null) };
    const out = await executeTool('get_open_estimates', { customer_ref: 'C1' }, ctx);
    expect(out).toMatch(/1 open estimate/);
    expect(out).toMatch(/Tuesday July 21/);
    expect(out).not.toMatch(/\$\d/);
    expect(out).toMatch(/Do NOT state any amounts/i);
  });

  test('no open estimates → says so and points at get_pricing, no invented quote', async () => {
    primeDb({ estimates: [] });
    const out = await executeTool('get_open_estimates', {}, { customerId: CUSTOMER_ID });
    expect(out).toMatch(/No open estimates/i);
    expect(out).not.toMatch(/\$\d/);
    expect(generateEstimate).not.toHaveBeenCalled();
  });

  test('a snapshot line with no price is named without inventing one', () => {
    const lines = relayMoney.snapshotLines({ sendSnapshot: { pricingBundle: { lineItems: [{ description: 'Custom termite work' }] } } });
    expect(lines).toEqual(['Custom termite work']);
  });
});

describe('get_invoice_history — matched caller only', () => {
  test('looked-up ref → refused; unmatched caller → refused; neither reads invoices', async () => {
    const refCtx = { customerId: CUSTOMER_ID, resolveLookupRef: () => 'c-9001' };
    const refused = await executeTool('get_invoice_history', { customer_ref: 'C1' }, refCtx);
    expect(refused).toMatch(/only available for the account the caller's own phone number matches/i);
    const unmatched = await executeTool('get_invoice_history', {}, { customerId: null });
    expect(unmatched).toMatch(/No customer account matches/i);
    expect(unmatched).toMatch(/Do NOT guess at amounts owed/);
    expect(openBalanceSummary).not.toHaveBeenCalled();
    expect(db).not.toHaveBeenCalled();
  });

  test('matched caller → itemized unpaid + total + recently settled, via the open-balance loader', async () => {
    openBalanceSummary.mockResolvedValue({
      total: 237.5,
      count: 2,
      moreCount: 1,
      invoices: [
        { invoice_number: 'WPC-2026-0301', service_type: 'Pest Control', service_date: '2026-07-31', total: 137.5, credit_applied: 0 },
        { invoice_number: 'WPC-2026-0288', service_type: 'Lawn Care', service_date: '2026-07-02', total: 120, credit_applied: 20 },
      ],
    });
    primeDb({
      invoices: [{ invoice_number: 'WPC-2026-0255', status: 'paid', service_type: 'Pest Control', service_date: '2026-06-01', total: 112 }],
    });
    const out = await executeTool('get_invoice_history', {}, { customerId: CUSTOMER_ID });
    expect(openBalanceSummary).toHaveBeenCalledWith(CUSTOMER_ID, expect.objectContaining({ displayLimit: relayMoney.INVOICE_HISTORY_LIMIT }));
    expect(out).toContain('WPC-2026-0301');
    expect(out).toContain('$137.50 still owed');
    expect(out).toContain('$100 still owed'); // total minus credit_applied, via invoiceAmountDue
    expect(out).toContain('Total open balance: $237.50 across 2 invoices');
    expect(out).toMatch(/1 older open invoice/);
    expect(out).toContain('WPC-2026-0255');
    expect(out).toMatch(/paid/);
    assertNoWrites();
  });

  test('paid-side read stays self-pay (no payer-owned statements) and selects no token', async () => {
    primeDb({ invoices: [] });
    await executeTool('get_invoice_history', {}, { customerId: CUSTOMER_ID });
    const b = builders.invoices;
    expect(b.whereNull).toHaveBeenCalledWith('payer_id');
    expect(b.whereNull).toHaveBeenCalledWith('payer_statement_id');
    expect(b.select.mock.calls.flat()).not.toContain('token');
  });

  test('output carries no pay link, receipt link, or token, and refuses card-taking', async () => {
    openBalanceSummary.mockResolvedValue({
      total: 75, count: 1, moreCount: 0,
      invoices: [{ invoice_number: 'WPC-2026-0311', service_date: '2026-08-01', total: 75, credit_applied: 0 }],
    });
    primeDb({ invoices: [] });
    const out = await executeTool('get_invoice_history', {}, { customerId: CUSTOMER_ID });
    expect(out).not.toMatch(TOKEN_LEAK_RE);
    expect(out).toMatch(/Never read out a payment link/i);
    expect(out).toMatch(/Never take a card number/i);
    expect(out).toMatch(/customer portal/i);
  });

  test('paid-up account reads as paid up; a failed balance read never guesses', async () => {
    const out = await executeTool('get_invoice_history', {}, { customerId: CUSTOMER_ID });
    expect(out).toMatch(/none — the account is paid up/i);
    openBalanceSummary.mockRejectedValue(new Error('pool exhausted'));
    const degraded = await executeTool('get_invoice_history', {}, { customerId: CUSTOMER_ID });
    expect(degraded).toMatch(/could not be checked right now/i);
    expect(degraded).toMatch(/do not guess/i);
  });
});

describe('get_services_catalog — public, no tier gate', () => {
  test('works for an UNMATCHED caller and names only catalog rows', async () => {
    loadBookableCallServices.mockResolvedValue([
      { name: 'Quarterly Pest Control' },
      { name: 'Lawn Care Program' },
      { name: 'Waves Assessment' },
    ]);
    const out = await executeTool('get_services_catalog', {}, { customerId: null });
    expect(loadBookableCallServices).toHaveBeenCalled();
    expect(out).toContain('Quarterly Pest Control');
    expect(out).toContain('Lawn Care Program');
    expect(out).toMatch(/never invent or promise a service/i);
    // No prices ride the catalog — NULL stays absent, never rendered as $0.
    expect(out).not.toMatch(/\$\d/);
    expect(out).not.toMatch(/\$0/);
    expect(out).not.toMatch(TOKEN_LEAK_RE);
  });

  test('empty/unavailable catalog → general terms only, still no invented names', async () => {
    loadBookableCallServices.mockResolvedValue([]);
    const out = await executeTool('get_services_catalog', {}, { customerId: null });
    expect(out).toMatch(/not available right now/i);
    expect(out).toMatch(/Do not invent a service name/i);
  });

  test('gate off → not registered and refuses', async () => {
    delete process.env.VOICE_RELAY_CONTEXT_ENABLED;
    expect(activeTools().map((t) => t.name)).not.toContain('get_services_catalog');
    const out = await executeTool('get_services_catalog', {}, {});
    expect(out).toMatch(/not available/i);
    expect(loadBookableCallServices).not.toHaveBeenCalled();
  });
});

describe('Prompt', () => {
  test('gate-on prompt carries the sent-price, billing, and catalog rules', () => {
    const p = buildBasePrompt(true);
    expect(p).toContain('get_open_estimates');
    expect(p).toMatch(/honoured AT THE PRICE IT WAS SENT/);
    expect(p).toMatch(/never re-price, discount, round/i);
    expect(p).toContain('get_invoice_history');
    expect(p).toMatch(/never read out a payment link/i);
    expect(p).toMatch(/Never ask for or accept a card number/i);
    expect(p).toContain('get_services_catalog');
  });
});
