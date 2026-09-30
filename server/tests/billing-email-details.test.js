/**
 * Billing email details (GATE_BILLING_EMAIL_DETAILS, dark; owner-approved
 * 2026-09-29): the lookups behind the extra rows on invoice / receipt /
 * payment-failed / estimate follow-up emails, and the idempotency keys.
 *
 * Every reader answers '' when the data does not exist (the renderer drops a
 * blank row), and nothing here reads the gate itself except the reader that
 * every sender goes through.
 */

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const db = require('../models/db');
const Details = require('../services/billing-email-details');

// Table -> rows. A `first()` returns rows[0]; select/order/etc. chain.
function mockTables(tables) {
  db.mockImplementation((table) => {
    const rows = tables[table];
    if (rows instanceof Error) throw rows;
    const q = {};
    ['where', 'whereIn', 'whereRaw', 'orderBy', 'join', 'select'].forEach((m) => { q[m] = jest.fn(() => q); });
    q.first = jest.fn(async () => (rows || [])[0]);
    q.then = (resolve, reject) => Promise.resolve(rows || []).then(resolve, reject);
    return q;
  });
}

describe('gate reader', () => {
  afterEach(() => { delete process.env.GATE_BILLING_EMAIL_DETAILS; });

  test.each([
    [undefined, false],
    ['', false],
    ['1', false],
    ['TRUE', false],
    ['on', false],
    ['true', true],
  ])('GATE_BILLING_EMAIL_DETAILS=%p reads %p (exactly "true", at call time)', (value, expected) => {
    if (value === undefined) delete process.env.GATE_BILLING_EMAIL_DETAILS;
    else process.env.GATE_BILLING_EMAIL_DETAILS = value;
    expect(Details.billingEmailDetailsLive()).toBe(expected);
    expect(require('../config/feature-gates').billingEmailDetailsLive()).toBe(expected);
  });

  test('flipping the variable takes effect without a reload', () => {
    expect(Details.billingEmailDetailsLive()).toBe(false);
    process.env.GATE_BILLING_EMAIL_DETAILS = 'true';
    expect(Details.billingEmailDetailsLive()).toBe(true);
    process.env.GATE_BILLING_EMAIL_DETAILS = 'false';
    expect(Details.billingEmailDetailsLive()).toBe(false);
  });
});

describe('card and tender labels', () => {
  test.each([
    ['visa', 'Visa'],
    ['VISA', 'Visa'],
    ['mastercard', 'Mastercard'],
    ['amex', 'American Express'],
    ['diners', 'Diners Club'],
    ['Store Card', 'Store Card'],
    ['', ''],
    [null, ''],
  ])('cardBrandName(%p) -> %p', (brand, expected) => {
    expect(Details.cardBrandName(brand)).toBe(expected);
  });

  test('dottedCardLabel keeps the receipt format and needs both halves', () => {
    expect(Details.dottedCardLabel('visa', '4242')).toBe('VISA ···· 4242');
    expect(Details.dottedCardLabel('visa', '')).toBe('');
    expect(Details.dottedCardLabel('', '4242')).toBe('');
  });

  describe('receiptTenderLabel', () => {
    test('a card on the ledger row wins, then a card on the invoice', () => {
      expect(Details.receiptTenderLabel({
        payment: { card_brand: 'amex', card_last_four: '1005' },
        invoice: { card_brand: 'visa', card_last_four: '4242' },
      })).toBe('AMEX ···· 1005');
      expect(Details.receiptTenderLabel({ payment: null, invoice: { card_brand: 'visa', card_last_four: '4242' } }))
        .toBe('VISA ···· 4242');
    });

    test.each([
      ['cash', 'Cash'],
      ['check', 'Check'],
      ['zelle', 'Zelle'],
      ['venmo', 'Venmo'],
      ['paypal', 'PayPal'],
      ['other', 'Other payment'],
      ['us_bank_account', 'Bank account (ACH)'],
    ])('an off-Stripe or bank tender on the invoice (%s) reads %s', (tender, expected) => {
      expect(Details.receiptTenderLabel({ payment: null, invoice: { payment_method: tender } })).toBe(expected);
    });

    test('an ACH ledger row names the bank and last four when it has them', () => {
      expect(Details.receiptTenderLabel({
        payment: { payment_method_type: 'us_bank_account', bank_name: 'Example Credit Union', card_last_four: '0123' },
        invoice: {},
      })).toBe('Example Credit Union ···· 0123');
      expect(Details.receiptTenderLabel({ payment: { payment_method_type: 'ach' }, invoice: {} })).toBe('Bank account');
    });

    test('the ledger metadata names the tender when the invoice does not (string or object)', () => {
      expect(Details.receiptTenderLabel({ payment: { metadata: JSON.stringify({ payment_method: 'check' }) }, invoice: {} })).toBe('Check');
      expect(Details.receiptTenderLabel({ payment: { metadata: { payment_method: 'cash' } }, invoice: {} })).toBe('Cash');
      expect(Details.receiptTenderLabel({ payment: { metadata: '{not json' }, invoice: {} })).toBe('');
    });

    test('a reopened card invoice settled by cash/check/Zelle names the CURRENT tender, not the stale card', () => {
      const staleCard = { card_brand: 'visa', card_last_four: '4242' };
      expect(Details.receiptTenderLabel({ payment: null, invoice: { ...staleCard, payment_method: 'cash' } })).toBe('Cash');
      expect(Details.receiptTenderLabel({ payment: null, invoice: { ...staleCard, payment_method: 'check' } })).toBe('Check');
      expect(Details.receiptTenderLabel({ payment: { metadata: { payment_method: 'zelle' } }, invoice: staleCard })).toBe('Zelle');
      // A card tender (or no manual tender) still reads as the card.
      expect(Details.receiptTenderLabel({ payment: null, invoice: { ...staleCard, payment_method: 'card' } })).toBe('VISA ···· 4242');
      expect(Details.receiptTenderLabel({ payment: null, invoice: staleCard })).toBe('VISA ···· 4242');
    });

    test('nothing known -> blank, never a guess', () => {
      expect(Details.receiptTenderLabel({ payment: null, invoice: {} })).toBe('');
      expect(Details.receiptTenderLabel({ payment: null, invoice: { payment_method: 'mystery' } })).toBe('');
      expect(Details.receiptTenderLabel()).toBe('');
    });
  });

  describe('payMethodOnFileLabel (unpaid invoice)', () => {
    const invoice = { id: 'inv-1', customer_id: 'cust-1' };

    test('names the customer\'s autopay method, else the default saved method', async () => {
      mockTables({
        customers: [{ autopay_payment_method_id: 'pm-1' }],
        payment_methods: [{ id: 'pm-1', method_type: 'card', card_brand: 'visa', last_four: '4242' }],
      });
      expect(await Details.payMethodOnFileLabel(invoice)).toBe('VISA ···· 4242');

      mockTables({
        customers: [{ autopay_payment_method_id: null }],
        payment_methods: [{ id: 'pm-2', method_type: 'ach', bank_name: 'Example Bank', bank_last_four: '6789' }],
      });
      expect(await Details.payMethodOnFileLabel(invoice)).toBe('Example Bank ···· 6789');
    });

    test('a card stamped on the invoice is NOT used: a dispute-reopened invoice keeps the charged-back card, so only the saved method is named', async () => {
      mockTables({
        customers: [{ autopay_payment_method_id: 'pm-1' }],
        payment_methods: [{ id: 'pm-1', method_type: 'card', card_brand: 'visa', last_four: '4242' }],
      });
      expect(await Details.payMethodOnFileLabel({ ...invoice, status: 'overdue', card_brand: 'mastercard', card_last_four: '4444' }))
        .toBe('VISA ···· 4242');
      mockTables({ customers: [{}], payment_methods: [] });
      expect(await Details.payMethodOnFileLabel({ ...invoice, card_brand: 'mastercard', card_last_four: '4444' })).toBe('');
    });

    test('the autopay pointer is read scoped to the customer', async () => {
      const seen = [];
      db.mockImplementation((table) => {
        const q = {};
        q.where = jest.fn((cond) => { seen.push([table, cond]); return q; });
        q.first = jest.fn(async () => (table === 'customers' ? { autopay_payment_method_id: 'pm-9' } : undefined));
        return q;
      });
      await Details.payMethodOnFileLabel(invoice);
      expect(seen).toContainEqual(['payment_methods', { id: 'pm-9', customer_id: 'cust-1' }]);
    });

    test('a payer-billed invoice or a one-off recipient never sees the homeowner\'s card', async () => {
      db.mockClear();
      expect(await Details.payMethodOnFileLabel({ ...invoice, payer_id: 7 })).toBe('');
      expect(await Details.payMethodOnFileLabel(invoice, { allowed: false })).toBe('');
      expect(db).not.toHaveBeenCalled();
    });

    test('no saved method, or an unreadable lookup, is blank', async () => {
      mockTables({ customers: [{}], payment_methods: [] });
      expect(await Details.payMethodOnFileLabel(invoice)).toBe('');
      mockTables({ customers: new Error('db down') });
      expect(await Details.payMethodOnFileLabel(invoice)).toBe('');
    });
  });
});

describe('property address (full street address, never a nickname)', () => {
  const customer = {
    address_line1: '100 Example Lane', address_line2: 'Unit 4', city: 'Bradenton', state: 'FL', zip: '34205', profile_label: 'Primary',
  };

  test('the customer\'s street address, with unit, city, state and zip — not "Primary"', async () => {
    mockTables({});
    expect(await Details.invoicePropertyAddress({ id: 'inv-1', customer_id: 'c' }, customer))
      .toBe('100 Example Lane Unit 4, Bradenton, FL 34205');
  });

  test('the address frozen on the invoice wins over the customer\'s current one', async () => {
    mockTables({});
    const invoice = {
      id: 'inv-1',
      customer_id: 'c',
      customer_address_snapshot: { address_line1: '9 Old Road', address_line2: null, city: 'Palmetto', state: 'FL', zip: '34221' },
    };
    expect(await Details.invoicePropertyAddress(invoice, customer)).toBe('9 Old Road, Palmetto, FL 34221');
  });

  test('a visit stamped with its own service address (a secondary property) wins over both', async () => {
    mockTables({
      scheduled_services: [{
        service_address_line1: '55 Rental Court', service_address_line2: null,
        service_address_city: 'Sarasota', service_address_state: 'FL', service_address_zip: '34236',
      }],
    });
    const invoice = {
      id: 'inv-1', customer_id: 'c', scheduled_service_id: 'ss-1',
      customer_address_snapshot: { address_line1: '9 Old Road', city: 'Palmetto', state: 'FL', zip: '34221' },
    };
    expect(await Details.invoicePropertyAddress(invoice, customer)).toBe('55 Rental Court, Sarasota, FL 34236');
  });

  test('a customer with only a nickname and a city gets NO Property row, not "Primary"', async () => {
    mockTables({});
    expect(await Details.invoicePropertyAddress(
      { id: 'inv-1', customer_id: 'c' },
      { address_line1: '', city: 'Bradenton', state: 'FL', zip: '34205', profile_label: 'Primary' },
    )).toBe('');
  });

  test('a caller projection that omits the unit line is reloaded so the unit is not dropped', async () => {
    mockTables({ customers: [{ address_line1: '100 Example Lane', address_line2: 'Apt 4', city: 'Bradenton', state: 'FL', zip: '34205' }] });
    const projection = { address_line1: '100 Example Lane', city: 'Bradenton', state: 'FL', zip: '34205' };
    expect(await Details.invoicePropertyAddress({ id: 'inv-1', customer_id: 'c' }, projection))
      .toBe('100 Example Lane Apt 4, Bradenton, FL 34205');
  });

  test('a customer row without address columns is read back from the database', async () => {
    mockTables({ customers: [{ address_line1: '12 Loaded Way', city: 'Venice', state: 'FL', zip: '34285' }] });
    expect(await Details.invoicePropertyAddress({ id: 'inv-1', customer_id: 'c' }, { id: 'c', first_name: 'Sam' }))
      .toBe('12 Loaded Way, Venice, FL 34285');
  });

  test('customerPropertyAddress prefers the saved property, falls back to the customer, blank when neither has a street', async () => {
    mockTables({
      customer_properties: [{ address_line1: '77 Saved Street', city: 'Parrish', state: 'FL', zip: '34219' }],
      customers: [{ address_line1: '1 Main Street', city: 'Bradenton', state: 'FL', zip: '34205' }],
    });
    expect(await Details.customerPropertyAddress('c', 'prop-1')).toBe('77 Saved Street, Parrish, FL 34219');
    expect(await Details.customerPropertyAddress('c', null)).toBe('1 Main Street, Bradenton, FL 34205');

    mockTables({ customer_properties: [{ address_line1: '', city: 'Parrish' }], customers: [{ address_line1: '', profile_label: 'Primary' }] });
    expect(await Details.customerPropertyAddress('c', 'prop-1')).toBe('');
    expect(await Details.customerPropertyAddress(null, null)).toBe('');
  });

  test('a FAILED visit-address lookup omits the Property row instead of falling back to the primary address', async () => {
    mockTables({ scheduled_services: new Error('db down') });
    const invoice = {
      id: 'inv-1', customer_id: 'c', scheduled_service_id: 'ss-1',
      customer_address_snapshot: { address_line1: '9 Old Road', city: 'Palmetto', state: 'FL', zip: '34221' },
    };
    expect(await Details.invoicePropertyAddress(invoice, customer)).toBe('');
    // RULE A (round 5): a visit the invoice points at that carries no stamp,
    // property_id or source estimate names no property at all, so the row is
    // omitted; the primary/frozen address is for an invoice with NO link only.
    mockTables({ scheduled_services: [{ service_address_line1: null }] });
    expect(await Details.invoicePropertyAddress(invoice, customer)).toBe('');
    expect(await Details.invoicePropertyAddress({ ...invoice, scheduled_service_id: null }, customer))
      .toBe('9 Old Road Unit 4, Palmetto, FL 34221');
  });

  test('an unreadable lookup is blank, never a throw', async () => {
    mockTables({ customers: new Error('db down'), scheduled_services: new Error('db down') });
    expect(await Details.invoicePropertyAddress({ id: 'inv-1', customer_id: 'c', scheduled_service_id: 'ss-1' }, { id: 'c' })).toBe('');
    expect(await Details.customerPropertyAddress('c', null)).toBe('');
  });
});

describe('service and service date', () => {
  test('an invoice that already has both needs no lookup', async () => {
    db.mockClear();
    const out = await Details.invoiceServiceDetails({ id: 'i', service_type: 'Quarterly Pest Control', service_date: '2026-09-29' });
    expect(out).toEqual({ label: 'Quarterly Pest Control', date: 'September 29, 2026' });
    expect(db).not.toHaveBeenCalled();
  });

  test('a blank service and date are read from the visit the invoice bills', async () => {
    mockTables({ scheduled_services: [{ service_type: 'Bi-Monthly Pest Control', scheduled_date: '2026-09-18' }] });
    expect(await Details.invoiceServiceDetails({ id: 'i', customer_id: 'c', scheduled_service_id: 'ss-1', service_type: null, service_date: null }))
      .toEqual({ label: 'Bi-Monthly Pest Control', date: 'September 18, 2026' });
  });

  test('or from the completion record when there is no visit', async () => {
    mockTables({ service_records: [{ service_type: 'Rodent Trapping', service_date: '2026-09-11' }] });
    expect(await Details.invoiceServiceDetails({ id: 'i', customer_id: 'c', service_record_id: 'sr-1', service_type: '', service_date: null }))
      .toEqual({ label: 'Rodent Trapping', date: 'September 11, 2026' });
  });

  test('a combined visit names every service on the packet once', async () => {
    mockTables({ 'visit_completion_packet_items as i': [{ service_type: 'Pest Control' }, { service_type: 'Lawn Care' }, { service_type: 'Pest Control' }] });
    const out = await Details.invoiceServiceDetails({ id: 'i', customer_id: 'c', visit_completion_packet_id: 'p-1', service_type: null, service_date: '2026-09-02' });
    expect(out.label).toBe('Pest Control, Lawn Care');
    expect(out.date).toBe('September 2, 2026');
  });

  test('the invoice title is the last resort, without its month suffix', async () => {
    mockTables({});
    expect(await Details.invoiceServiceDetails({ id: 'i', title: 'Quarterly Pest Control Service — August 2026' }))
      .toEqual({ label: 'Quarterly Pest Control Service', date: '' });
  });

  test('nothing known is blank and an unreadable lookup does not throw', async () => {
    mockTables({ scheduled_services: new Error('db down') });
    expect(await Details.invoiceServiceDetails({ id: 'i', customer_id: 'c', scheduled_service_id: 'ss-1' })).toEqual({ label: '', date: '' });
  });
});

describe('street-shaped address text', () => {
  test.each([
    ['123 Main St', true],
    ['123 Example Street, Bradenton, FL 34205', true],
    ['5A Palm Ave', true],
    ['12345 Gulf Drive Bradenton', true],
    ['Rental 2', false],
    ['Property #2', false],
    ['Unit 4', false],
    ['Primary', false],
    ['Additional property', false],
    ['2', false],
    ['', false],
    [null, false],
  ])('isStreetShapedAddress(%p) -> %p', (value, expected) => {
    expect(Details.isStreetShapedAddress(value)).toBe(expected);
  });
});

describe('no idempotency-key helpers ship in this lane', () => {
  test('keys stay exactly as on main (the follow-up owns them)', () => {
    expect(Details).not.toHaveProperty('invoiceSentKey');
    expect(Details).not.toHaveProperty('receiptAttemptKey');
    expect(Details).not.toHaveProperty('receiptKey');
  });
});
