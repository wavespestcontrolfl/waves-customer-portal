/**
 * Voice-relay Phase D — get_open_estimates, get_invoice_history,
 * get_services_catalog.
 *
 * What these lock down:
 *   - SENT-PRICE DOCTRINE: quoted lines come from buildPricingBundle (THE
 *     mechanism the customer's own /estimate/:token page renders from — it
 *     rejects the frozen snapshot and re-derives in six cases), totals come from
 *     the estimate row's persisted columns, and the LIVE quote engine
 *     (generateEstimate) is NEVER called
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
// buildPricingBundle IS the sent-price mechanism (it is what the customer's own
// /estimate/:token page renders from, and it deliberately rejects the frozen
// snapshot and re-derives in six cases). The voice agent must call IT, not read
// sendSnapshot JSON by hand.
// isEstimateCustomerViewable is the CUSTOMER-FACING viewability predicate the
// /estimate/:token page gates on. Mocked with a faithful stand-in for the two
// legs these tests exercise (archived, past-expiry); a test below asserts
// relay-money actually consults it rather than re-deriving one.
jest.mock('../routes/estimate-public', () => ({
  buildPricingBundle: jest.fn(),
  isEstimateCustomerViewable: jest.fn((row = {}, now = new Date()) => !row.archived_at
    && !(row.expires_at && new Date(row.expires_at) < now)),
}));
jest.mock('../services/open-balance', () => ({ openBalanceSummary: jest.fn() }));
// The LIVE payer authority. open-balance.js records the pre-push P0: payer-null
// SQL is not proof of self-pay, because a payer assigned after the invoice row
// was written leaves the row null — every surface must re-resolve per row and
// fail toward DROP.
jest.mock('../services/payer', () => ({ resolveForInvoice: jest.fn(async () => ({ payerId: null })) }));
jest.mock('../services/call-booking-catalog', () => ({ loadBookableCallServices: jest.fn() }));

const db = require('../models/db');
const { generateEstimate } = require('../services/pricing-engine');
const { buildPricingBundle, isEstimateCustomerViewable } = require('../routes/estimate-public');
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
  buildPricingBundle.mockResolvedValue(REAL_BUNDLE);
});

// A sent estimate whose snapshot carries the SENT prices, and whose token
// column would leak a bearer credential if it were ever selected.
const SENT_ESTIMATE = {
  id: 'est-1',
  status: 'sent',
  service_type: 'Quarterly Pest Control',
  created_at: '2026-07-20T12:00:00Z',
  sent_at: '2026-07-21T12:00:00Z',
  // RELATIVE, never a near-today literal (AGENTS.md): the viewability predicate
  // compares this against the real clock, so a fixed date turns this suite into
  // a time bomb that fails on a day nobody changed any code.
  expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
  monthly_total: 41.5,
  annual_total: 498,
  onetime_total: 99,
  token: 'abcd1234abcd1234abcd1234abcd',
  estimate_data: JSON.stringify({ sendSnapshot: { renderedAt: '2026-07-21T12:00:00Z' } }),
};

// ⭐ THE REAL BUNDLE SHAPE. The old fixture invented a `lineItems` key that does
// not exist on a pricing bundle — which is exactly why the dead code path
// passed its test. A bundle is keyed on `frequencies`, each entry carrying
// `perServiceTreatments` (estimate-public.js shapeFrequencyEntry /
// shapeFromV1), and estimate-public's own snapshot fast-path gates on
// `Array.isArray(snapshotBundle.frequencies)`.
const REAL_BUNDLE = {
  source: 'send_snapshot',
  snapshotHit: true,
  frequencies: [
    {
      key: 'quarterly',
      label: 'Quarterly',
      monthly: 41.5,
      annual: 498,
      perVisit: 124.5,
      oneTimeTotal: 99,
      perServiceTreatments: [
        { service: 'pest_control', label: 'Quarterly pest control', monthly: 41.5, perTreatment: 124.5, visitsPerYear: 4 },
      ],
    },
    {
      key: 'bimonthly',
      label: 'Bi-Monthly',
      monthly: 58,
      annual: 696,
      perServiceTreatments: [
        { service: 'pest_control', label: 'Bi-monthly pest control', monthly: 58, perTreatment: 116 },
      ],
    },
  ],
};

describe('get_open_estimates — SENT-price doctrine', () => {
  test('gate off → not registered and refuses', async () => {
    delete process.env.VOICE_RELAY_CONTEXT_ENABLED;
    expect(activeTools().map((t) => t.name)).not.toContain('get_open_estimates');
    const out = await executeTool('get_open_estimates', {}, { customerId: CUSTOMER_ID, customerTier: 'full' });
    expect(out).toMatch(/not available/i);
    expect(db).not.toHaveBeenCalled();
  });

  test('matched caller → per-APPLICATION lines from buildPricingBundle().frequencies, and NO combined plan total', async () => {
    primeDb({ estimates: [SENT_ESTIMATE] });
    const out = await executeTool('get_open_estimates', {}, { customerId: CUSTOMER_ID, customerTier: 'full' });
    // THE mechanism is consulted, with the estimate ROW.
    expect(buildPricingBundle).toHaveBeenCalledWith(expect.objectContaining({ id: 'est-1' }));
    // The LIVE quote engine still is not.
    expect(generateEstimate).not.toHaveBeenCalled();
    // Owner rule: "per application", never "per visit" — and the per-application
    // price LEADS, exactly as the customer's own estimate card does. This
    // fixture carries no `billedPerApplication` flag, so it is a legacy
    // monthly-billed row and keeps PriceCard's "Billed $X/mo" note underneath.
    expect(out).toContain('Quarterly pest control at $124.50 per application, billed $41.50 per month');
    expect(out).not.toMatch(/per visit/i);
    // ⭐ NO COMBINED PLAN TOTALS on a customer-facing estimate surface
    // (AGENTS.md "Per application" price copy, owner 2026-07-23). The
    // estimate's persisted monthly_total/annual_total are never spoken.
    expect(out).not.toMatch(/estimate total/i);
    expect(out).not.toContain('$498');
    expect(out).not.toMatch(/per year/i);
    // One-time work is a single real charge and still prints.
    expect(out).toContain('one-time work totalling $99');
    expect(out).toMatch(/prices the estimate was SENT at/);
    expect(out).toMatch(/never re-price/i);
    expect(out).toMatch(/never add them up into a combined monthly or yearly plan total/i);
    assertNoWrites();
  });

  // A FLAGGED per-application frequency bills exactly its headline, so the
  // customer's estimate card shows no monthly note (PriceCard
  // showBilledMonthlyNote) — neither may the phone.
  test('a billedPerApplication frequency speaks the per-application price ALONE', async () => {
    buildPricingBundle.mockResolvedValue({
      frequencies: [{
        key: 'quarterly',
        monthly: 41.5,
        annual: 498,
        billedPerApplication: true,
        perServiceTreatments: [
          { service: 'pest_control', label: 'Quarterly pest control', monthly: 41.5, perTreatment: 124.5, visitsPerYear: 4 },
        ],
      }],
    });
    primeDb({ estimates: [SENT_ESTIMATE] });
    const out = await executeTool('get_open_estimates', {}, { customerId: CUSTOMER_ID, customerTier: 'full' });
    expect(out).toContain('Quarterly pest control at $124.50 per application');
    expect(out).not.toMatch(/per month/i);
    expect(out).not.toMatch(/per year/i);
  });

  // The bundle offers a cadence LADDER; the sent estimate is one rung of it.
  test('the cadence spoken is the one matching the estimate row\'s own totals', async () => {
    primeDb({ estimates: [{ ...SENT_ESTIMATE, monthly_total: 58, annual_total: 696 }] });
    const out = await executeTool('get_open_estimates', {}, { customerId: CUSTOMER_ID, customerTier: 'full' });
    expect(out).toContain('Bi-monthly pest control at $116 per application');
    expect(out).not.toContain('Quarterly pest control at');
  });

  // buildPricingBundle does a live DB read and can throw; a caller is on the
  // line. The per-application lines ARE the price, so there is nothing honest
  // left to say — and the persisted combined totals are exactly what may not be
  // spoken.
  test('a failing bundle refuses to state a price rather than fall back to the combined totals', async () => {
    buildPricingBundle.mockRejectedValue(new Error('pool exhausted'));
    primeDb({ estimates: [SENT_ESTIMATE] });
    const out = await executeTool('get_open_estimates', {}, { customerId: CUSTOMER_ID, customerTier: 'full' });
    expect(out).not.toMatch(/quoted lines/);
    expect(out).toMatch(/do NOT state a price for this one/i);
    expect(out).not.toContain('$41.50');
    expect(out).not.toContain('$498');
    expect(out).toMatch(/prices the estimate was SENT at/);
  });

  test('a bundle with no frequencies at all yields no invented lines', async () => {
    buildPricingBundle.mockResolvedValue({ frequencies: [] });
    primeDb({ estimates: [SENT_ESTIMATE] });
    const out = await executeTool('get_open_estimates', {}, { customerId: CUSTOMER_ID, customerTier: 'full' });
    expect(out).not.toMatch(/quoted lines/);
  });

  test('only sent/viewed estimates count as open, newest first', async () => {
    primeDb({ estimates: [SENT_ESTIMATE] });
    await executeTool('get_open_estimates', {}, { customerId: CUSTOMER_ID, customerTier: 'full' });
    const b = builders.estimates;
    expect(b.whereIn).toHaveBeenCalledWith('status', ['sent', 'viewed']);
    expect(relayMoney.OPEN_ESTIMATE_STATUSES).toEqual(['sent', 'viewed']);
    expect(b.orderBy).toHaveBeenCalledWith('created_at', 'desc');
  });

  // ⭐ THE PROJECTION IS PART OF THE SENT-PRICE CONTRACT. buildPricingBundle
  // reads more than the totals: customer_id / customer_phone are how
  // estimateRendersMonthlyBilling recognises a legacy monthly member (its
  // resolver returns false outright when BOTH are absent, so a thin projection
  // classified every estimate as per-application and suppressed the truthful
  // "billed $X per month" line), and show_one_time_option / waveguard_tier
  // shape the bundle itself.
  test('the estimate projection carries every field buildPricingBundle reads', async () => {
    primeDb({ estimates: [SENT_ESTIMATE] });
    await executeTool('get_open_estimates', {}, { customerId: CUSTOMER_ID, customerTier: 'full' });
    const selected = builders.estimates.select.mock.calls.flat();
    for (const col of ['customer_id', 'customer_phone', 'show_one_time_option', 'waveguard_tier',
      'monthly_total', 'annual_total', 'onetime_total', 'estimate_data']) {
      expect(selected).toContain(col);
    }
    // …and the row the bundle builder is handed is the row that was read.
    expect(buildPricingBundle).toHaveBeenCalledWith(expect.objectContaining({ id: 'est-1' }));
  });

  test('the estimate view token is never SELECTed, and never reaches the output', async () => {
    primeDb({ estimates: [SENT_ESTIMATE] });
    const out = await executeTool('get_open_estimates', {}, { customerId: CUSTOMER_ID, customerTier: 'full' });
    const selected = builders.estimates.select.mock.calls.flat();
    expect(selected).not.toContain('token');
    expect(out).not.toContain(SENT_ESTIMATE.token);
    expect(out).not.toMatch(TOKEN_LEAK_RE);
    expect(out).toMatch(/Do not read out a link/i);
  });

  // ⭐ STATUS IS NOT VIEWABILITY. `sent`/`viewed` only changes when the expiry
  // sweep gets to the row; /estimate/:token refuses a past-expiry estimate the
  // moment it passes. Quoting one would put a price on the call the customer's
  // own page will not show.
  test('an EXPIRED estimate is not quoted — the customer-facing predicate decides', async () => {
    const expired = {
      ...SENT_ESTIMATE,
      id: 'est-expired',
      expires_at: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
    };
    primeDb({ estimates: [expired] });
    const out = await executeTool('get_open_estimates', {}, { customerId: CUSTOMER_ID, customerTier: 'full' });
    expect(isEstimateCustomerViewable).toHaveBeenCalledWith(expect.objectContaining({ id: 'est-expired' }));
    expect(out).toMatch(/No open estimates on this account/i);
    expect(out).not.toMatch(/\$\d/);
    expect(buildPricingBundle).not.toHaveBeenCalled();
  });

  test('an ARCHIVED estimate does not even count toward the redacted "how many" answer', async () => {
    primeDb({ estimates: [{ ...SENT_ESTIMATE, id: 'est-archived', archived_at: '2026-08-05T12:00:00Z' }] });
    const ctx = { customerId: 'c-other', customerTier: 'full', resolveLookupRef: () => 'c-9001' };
    const out = await executeTool('get_open_estimates', { customer_ref: 'C1' }, ctx);
    expect(out).toMatch(/No open estimates on this account/i);
    expect(out).not.toMatch(/1 open estimate/);
  });

  // ⭐ THE DISCOUNTED CUSTOMER IS THE ONE MOST LIKELY TO CHECK. On a row that
  // takes a tier discount, `perTreatment` is the LIST price and `displayPrice`
  // is the net one PriceCard.jsx renders as "/ application".
  test('a tier-discounted line speaks displayPrice, not the pre-discount perTreatment', async () => {
    buildPricingBundle.mockResolvedValue({
      frequencies: [{
        key: 'quarterly',
        monthly: 41.5,
        annual: 498,
        perServiceTreatments: [
          { service: 'pest_control', label: 'Quarterly pest control', monthly: 41.5, perTreatment: 149, displayPrice: 124.5, visitsPerYear: 4 },
        ],
      }],
    });
    primeDb({ estimates: [SENT_ESTIMATE] });
    const out = await executeTool('get_open_estimates', {}, { customerId: CUSTOMER_ID, customerTier: 'full' });
    expect(out).toContain('$124.50 per application');
    expect(out).not.toContain('$149');
  });

  // ⭐ A CADENCE IS NOT THE CADENCE. The bundle returns the whole ladder; only
  // the entry matching the estimate's own persisted totals is the one it was
  // SENT at. Quoting the first entry instead tells a quarterly customer a
  // monthly price — on the one number they can check us against.
  test('no frequency matching the estimate totals → no price stated, never the first entry', async () => {
    buildPricingBundle.mockResolvedValue({
      frequencies: [
        { key: 'monthly', monthly: 99, annual: 1188, perServiceTreatments: [{ service: 'pest_control', label: 'Monthly pest control', perTreatment: 99, displayPrice: 99 }] },
        { key: 'annual', monthly: 20, annual: 240, perServiceTreatments: [{ service: 'pest_control', label: 'Annual pest control', perTreatment: 240, displayPrice: 240 }] },
      ],
    });
    primeDb({ estimates: [SENT_ESTIMATE] }); // totals 41.5 / 498 — matches neither
    const out = await executeTool('get_open_estimates', {}, { customerId: CUSTOMER_ID, customerTier: 'full' });
    expect(out).toMatch(/do NOT state a price for this one/i);
    expect(out).not.toMatch(/quoted lines:/i); // no quoted line at all…
    expect(out).not.toMatch(/\$99 per application/);
    expect(out).not.toContain('$240');
    // …while the one-time charge, which IS on the row, still prints.
    expect(out).toMatch(/one-time work totalling \$99/);
  });

  test('looked-up ref → existence + date ONLY, never an amount', async () => {
    primeDb({ estimates: [SENT_ESTIMATE] });
    const ctx = { customerId: 'c-other', customerTier: 'full', resolveLookupRef: (r) => (String(r).toUpperCase() === 'C1' ? 'c-9001' : null) };
    const out = await executeTool('get_open_estimates', { customer_ref: 'C1' }, ctx);
    expect(out).toMatch(/1 open estimate/);
    expect(out).toMatch(/Tuesday July 21/);
    expect(out).not.toMatch(/\$\d/);
    expect(out).toMatch(/Do NOT state any amounts/i);
  });

  test('no open estimates → says so and points at get_pricing, no invented quote', async () => {
    primeDb({ estimates: [] });
    const out = await executeTool('get_open_estimates', {}, { customerId: CUSTOMER_ID, customerTier: 'full' });
    expect(out).toMatch(/No open estimates/i);
    expect(out).not.toMatch(/\$\d/);
    expect(generateEstimate).not.toHaveBeenCalled();
  });

  test('a bundle line with no price is named without inventing one', async () => {
    buildPricingBundle.mockResolvedValue({
      frequencies: [{ key: 'quarterly', monthly: 41.5, perServiceTreatments: [{ service: 'termite', label: 'Custom termite work' }] }],
    });
    expect(await relayMoney.quotedLines(SENT_ESTIMATE)).toEqual(['Custom termite work']);
  });
});

describe('get_invoice_history — matched caller only', () => {
  test('looked-up ref → refused; unmatched caller → refused; neither reads invoices', async () => {
    const refCtx = { customerId: CUSTOMER_ID, customerTier: 'full', resolveLookupRef: () => 'c-9001' };
    const refused = await executeTool('get_invoice_history', { customer_ref: 'C1' }, refCtx);
    expect(refused).toMatch(/only available for the account the caller's own phone number matches/i);
    const unmatched = await executeTool('get_invoice_history', {}, { customerId: null });
    expect(unmatched).toMatch(/No customer account matches/i);
    expect(unmatched).toMatch(/Do NOT guess at amounts owed/);
    expect(openBalanceSummary).not.toHaveBeenCalled();
    expect(db).not.toHaveBeenCalled();
  });

  // Tier defaults are 'redacted' everywhere: an exported helper called without
  // an option, and a caller recognised only on a service-contact slot
  // (spouse/tenant/PRIOR OCCUPANT), both get nothing.
  test('no customerTier / contact-slot tier → invoices refused, none read', async () => {
    const noTier = await executeTool('get_invoice_history', {}, { customerId: CUSTOMER_ID });
    expect(noTier).toMatch(/only available for the account whose own phone number/i);
    const slot = await executeTool('get_invoice_history', {}, { customerId: CUSTOMER_ID, customerTier: 'redacted' });
    expect(slot).toMatch(/only available for the account whose own phone number/i);
    expect(slot).not.toMatch(/\$\d/);
    expect(openBalanceSummary).not.toHaveBeenCalled();
    expect(db).not.toHaveBeenCalled();
  });

  test('the exported invoiceHistoryText helper itself defaults to redacted', async () => {
    const { invoiceHistoryText } = require('../services/voice-agent/relay-money');
    const out = await invoiceHistoryText(CUSTOMER_ID);
    expect(out).toMatch(/only available for the account whose own phone number/i);
    expect(openBalanceSummary).not.toHaveBeenCalled();
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
    const out = await executeTool('get_invoice_history', {}, { customerId: CUSTOMER_ID, customerTier: 'full' });
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
    await executeTool('get_invoice_history', {}, { customerId: CUSTOMER_ID, customerTier: 'full' });
    const b = builders.invoices;
    expect(b.whereNull).toHaveBeenCalledWith('payer_id');
    expect(b.whereNull).toHaveBeenCalledWith('payer_statement_id');
    expect(b.select.mock.calls.flat()).not.toContain('token');
  });

  // ⭐ THE PAYER-NULL SQL IS NOT PROOF OF SELF-PAY. open-balance.js records the
  // pre-push P0: a payer assigned AFTER the invoice row was written (per-visit,
  // or the customer's default payer) leaves the row payer-null, so every
  // balance surface re-resolves LIVE per row and fails toward DROP. The spoken
  // history stood on the SQL alone and would read a third party's settled
  // invoice — number, date and amount — to the homeowner.
  test('a settled invoice that LIVE-resolves to a payer is dropped, not spoken', async () => {
    const PayerService = require('../services/payer');
    openBalanceSummary.mockResolvedValue({ total: 0, count: 0, moreCount: 0, invoices: [] });
    primeDb({
      invoices: [
        { invoice_number: 'WPC-2026-0255', status: 'paid', service_type: 'Pest Control', service_date: '2026-06-01', total: 112, scheduled_service_id: 'ss-1' },
      ],
    });
    PayerService.resolveForInvoice.mockResolvedValueOnce({ payerId: 'payer-7' });
    const out = await executeTool('get_invoice_history', {}, { customerId: CUSTOMER_ID, customerTier: 'full' });
    expect(PayerService.resolveForInvoice).toHaveBeenCalledWith(expect.objectContaining({
      customerId: CUSTOMER_ID, scheduledServiceId: 'ss-1', throwOnError: true,
    }));
    expect(out).not.toContain('WPC-2026-0255');
    expect(out).not.toContain('$112');
  });

  test('a payer resolve OUTAGE drops the row too (fail closed, never fail open)', async () => {
    const PayerService = require('../services/payer');
    openBalanceSummary.mockResolvedValue({ total: 0, count: 0, moreCount: 0, invoices: [] });
    primeDb({
      invoices: [{ invoice_number: 'WPC-2026-0255', status: 'paid', service_type: 'Pest Control', service_date: '2026-06-01', total: 112 }],
    });
    PayerService.resolveForInvoice.mockRejectedValueOnce(new Error('pool exhausted'));
    const out = await executeTool('get_invoice_history', {}, { customerId: CUSTOMER_ID, customerTier: 'full' });
    expect(out).not.toContain('WPC-2026-0255');
  });

  test('output carries no pay link, receipt link, or token, and refuses card-taking', async () => {
    openBalanceSummary.mockResolvedValue({
      total: 75, count: 1, moreCount: 0,
      invoices: [{ invoice_number: 'WPC-2026-0311', service_date: '2026-08-01', total: 75, credit_applied: 0 }],
    });
    primeDb({ invoices: [] });
    const out = await executeTool('get_invoice_history', {}, { customerId: CUSTOMER_ID, customerTier: 'full' });
    expect(out).not.toMatch(TOKEN_LEAK_RE);
    expect(out).toMatch(/Never read out a payment link/i);
    expect(out).toMatch(/Never take a card number/i);
    expect(out).toMatch(/customer portal/i);
  });

  test('paid-up account reads as paid up; a failed balance read never guesses', async () => {
    const out = await executeTool('get_invoice_history', {}, { customerId: CUSTOMER_ID, customerTier: 'full' });
    expect(out).toMatch(/none — the account is paid up/i);
    openBalanceSummary.mockRejectedValue(new Error('pool exhausted'));
    const degraded = await executeTool('get_invoice_history', {}, { customerId: CUSTOMER_ID, customerTier: 'full' });
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
