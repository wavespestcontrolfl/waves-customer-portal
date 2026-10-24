/**
 * Multi-property invoices: a service line may name one of the customer's saved
 * properties. The write path checks ownership and freezes the address on the
 * line; the documents group lines under each property only when the lines
 * span 2+ properties, so every existing invoice renders exactly as before.
 */

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const {
  groupInvoiceLinesByProperty, invoicePropertyLabels, propertyAddressLabel,
} = require('@waves/invoice-property-groups');
const { attachInvoiceLineProperties } = require('../services/invoice-property-lines');

const CUSTOMER = '11111111-1111-4111-8111-111111111111';
const PALM = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const BAY = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const OTHER = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

const PROPERTIES = {
  [PALM]: { id: PALM, customer_id: CUSTOMER, address_line1: '1842 Palm Harbor Dr', address_line2: null, city: 'Bradenton', state: 'FL', zip: '34209' },
  [BAY]: { id: BAY, customer_id: CUSTOMER, address_line1: '410 Bayshore Rd', address_line2: 'Unit B', city: 'Parrish', state: 'FL', zip: '34219' },
  [OTHER]: { id: OTHER, customer_id: 'someone-else', address_line1: '9 Elsewhere Ln', city: 'Venice', state: 'FL', zip: '34285' },
};

// Minimal knex-shaped fake over customer_properties: honours customer_id + whereIn(id).
function fakeConn() {
  return (table) => {
    expect(table).toBe('customer_properties');
    const q = { criteria: {}, ids: [] };
    q.where = (criteria) => { q.criteria = criteria; return q; };
    q.whereIn = (_col, ids) => { q.ids = ids; return q; };
    q.select = async () => Object.values(PROPERTIES)
      .filter((row) => row.customer_id === q.criteria.customer_id && q.ids.includes(row.id));
    return q;
  };
}

const service = (client_id, property_id, amount = 149) => ({ client_id, description: 'Quarterly pest control service', quantity: 1, unit_price: amount, amount, property_id });
const discount = (client_id, discount_for, amount = -14.9) => ({ client_id, _kind: 'discount', discount_for, description: 'Multi-Home Discount (10%)', quantity: 1, unit_price: amount, amount });

describe('attachInvoiceLineProperties (write path)', () => {
  test('freezes each owned property address onto its line and onto its discount rows', async () => {
    const items = await attachInvoiceLineProperties(fakeConn(), CUSTOMER, [
      service('a', PALM), discount('a-d', 'a'), service('b', BAY), discount('b-d', 'b'),
    ]);
    expect(items[0]).toMatchObject({ property_id: PALM, property_address: { address_line1: '1842 Palm Harbor Dr', address_line2: null, city: 'Bradenton', state: 'FL', zip: '34209' } });
    expect(items[1]).toMatchObject({ discount_for: 'a', property_id: PALM, property_address: { address_line1: '1842 Palm Harbor Dr' } });
    expect(items[2].property_address).toMatchObject({ address_line1: '410 Bayshore Rd', address_line2: 'Unit B' });
    expect(items[3]).toMatchObject({ discount_for: 'b', property_id: BAY });
    // Money fields are untouched.
    expect(items.map((i) => i.amount)).toEqual([149, -14.9, 149, -14.9]);
  });

  test('refuses a property that is not this customer\'s (400, invalid_line_property)', async () => {
    await expect(attachInvoiceLineProperties(fakeConn(), CUSTOMER, [service('a', PALM), service('b', OTHER)]))
      .rejects.toMatchObject({ statusCode: 400, code: 'invalid_line_property' });
    await expect(attachInvoiceLineProperties(fakeConn(), CUSTOMER, [service('a', 'not-a-uuid')]))
      .rejects.toMatchObject({ statusCode: 400, code: 'invalid_line_property' });
  });

  test('lines without a property pass through unchanged and shed a stale snapshot; no DB read', async () => {
    const neverCalled = () => { throw new Error('no property read expected'); };
    const items = await attachInvoiceLineProperties(neverCalled, CUSTOMER, [
      { client_id: 'a', description: 'Service', quantity: 1, unit_price: 100, amount: 100, property_address: { address_line1: 'stale' } },
      discount('a-d', 'a', -10),
      { category: 'deposit_credit', description: 'Deposit credit', quantity: 1, unit_price: -50, amount: -50 },
    ]);
    expect(items[0]).toEqual({ client_id: 'a', description: 'Service', quantity: 1, unit_price: 100, amount: 100 });
    expect(items[1]).not.toHaveProperty('property_id');
    expect(items[2]).toMatchObject({ category: 'deposit_credit', amount: -50 });
  });
});

describe('groupInvoiceLinesByProperty (documents)', () => {
  const addr = (id) => ({ address_line1: PROPERTIES[id].address_line1, address_line2: PROPERTIES[id].address_line2 || null, city: PROPERTIES[id].city, state: 'FL', zip: PROPERTIES[id].zip });
  const twoHomes = [
    { ...service('a', PALM), property_address: addr(PALM) }, { ...discount('a-d', 'a'), property_id: PALM, property_address: addr(PALM) },
    { ...service('b', BAY), property_address: addr(BAY) }, { ...discount('b-d', 'b'), property_id: BAY, property_address: addr(BAY) },
    { client_id: 'doc', _kind: 'discount', discount_for: null, description: 'Military Discount', quantity: 1, unit_price: -5, amount: -5 },
  ];

  test('two properties → two groups in line order, each with its own discount and subtotal; document-wide discounts stay out', () => {
    const groups = groupInvoiceLinesByProperty(twoHomes);
    expect(groups).toHaveLength(2);
    expect(groups[0]).toMatchObject({ property_id: PALM, label: '1842 Palm Harbor Dr, Bradenton, FL 34209', subtotal: 134.1 });
    expect(groups[0].lines.map((l) => l.client_id)).toEqual(['a']);
    expect(groups[0].discounts.map((l) => l.client_id)).toEqual(['a-d']);
    expect(groups[1]).toMatchObject({ property_id: BAY, label: '410 Bayshore Rd Unit B, Parrish, FL 34219', subtotal: 134.1 });
    expect(groups.flatMap((g) => g.discounts).map((d) => d.client_id)).not.toContain('doc');
    expect(groupInvoiceLinesByProperty(JSON.stringify(twoHomes))).toHaveLength(2);
    expect(invoicePropertyLabels(twoHomes)).toEqual(['1842 Palm Harbor Dr, Bradenton, FL 34209', '410 Bayshore Rd Unit B, Parrish, FL 34219']);
  });

  test('flat invoices answer null: no lines, one property, or any line without a property', () => {
    expect(groupInvoiceLinesByProperty([])).toBeNull();
    expect(groupInvoiceLinesByProperty(null)).toBeNull();
    expect(groupInvoiceLinesByProperty([service('a', PALM), service('b', PALM)])).toBeNull();
    expect(groupInvoiceLinesByProperty([service('a', PALM), service('b', null)])).toBeNull();
    expect(groupInvoiceLinesByProperty([{ description: 'Legacy', quantity: 1, unit_price: 99, amount: 99 }])).toBeNull();
    expect(invoicePropertyLabels([service('a', PALM)])).toEqual([]);
    expect(propertyAddressLabel(null)).toBe('');
  });

  test('the invoice and receipt PDFs print each property heading, its discount and subtotal', async () => {
    const PDFDocument = require('pdfkit');
    const written = jest.spyOn(PDFDocument.prototype, 'text');
    try {
      const invoice = {
        invoice_number: 'QA-MULTI', status: 'paid', subtotal: 298, discount_amount: 29.8, discount_label: 'Multi-Home Discount', total: 268.2,
        created_at: new Date(), paid_at: new Date(), line_items: twoHomes,
        customer: { first_name: 'Synthetic', last_name: 'Fixture', address_line1: '1842 Palm Harbor Dr', city: 'Bradenton', state: 'FL', zip: '34209' },
      };
      const pdf = require('../services/pdf/invoice-pdf');
      for (const build of [() => pdf.buildInvoicePDFBuffer(invoice), () => pdf.buildReceiptPDFBuffer(invoice, null)]) {
        written.mockClear();
        const buffer = await build();
        expect(buffer.subarray(0, 4).toString()).toBe('%PDF');
        const text = written.mock.calls.map((args) => String(args[0])).join('\n');
        expect(text).toContain('1842 Palm Harbor Dr, Bradenton, FL 34209');
        expect(text).toContain('410 Bayshore Rd Unit B, Parrish, FL 34219');
        expect(text).toContain('Multi-Home Discount (10%)');
        expect(text).toContain('1842 Palm Harbor Dr subtotal');
        expect(text).toContain('410 Bayshore Rd Unit B subtotal');
      }
    } finally { written.mockRestore(); }
  });

  test('the billing email Property row names both properties, outranking the visit link', async () => {
    const Details = require('../services/billing-email-details');
    const text = await Details.invoicePropertyAddress({ customer_id: CUSTOMER, scheduled_service_id: 'visit-1', line_items: JSON.stringify(twoHomes) }, null);
    expect(text).toBe('1842 Palm Harbor Dr, Bradenton, FL 34209 and 410 Bayshore Rd Unit B, Parrish, FL 34219');
  });
});
