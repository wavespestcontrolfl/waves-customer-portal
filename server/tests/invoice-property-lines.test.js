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
const { attachInvoiceLineProperties, techSafeInvoiceLineItems } = require('../services/invoice-property-lines');

const CUSTOMER = '11111111-1111-4111-8111-111111111111';
const PALM = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const BAY = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const OTHER = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const REMOVED = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';

const PROPERTIES = {
  [PALM]: { id: PALM, customer_id: CUSTOMER, active: true, address_line1: '1842 Palm Harbor Dr', address_line2: null, city: 'Bradenton', state: 'FL', zip: '34209' },
  [BAY]: { id: BAY, customer_id: CUSTOMER, active: true, address_line1: '410 Bayshore Rd', address_line2: 'Unit B', city: 'Parrish', state: 'FL', zip: '34219' },
  [OTHER]: { id: OTHER, customer_id: 'someone-else', active: true, address_line1: '9 Elsewhere Ln', city: 'Venice', state: 'FL', zip: '34285' },
  // Removed from the customer (customer-properties deactivates, never deletes).
  [REMOVED]: { id: REMOVED, customer_id: CUSTOMER, active: false, address_line1: '77 Former Pl', city: 'Bradenton', state: 'FL', zip: '34209' },
};

// Minimal knex-shaped fake over customer_properties: honours where({customer_id, active}) + whereIn(id).
function fakeConn() {
  return (table) => {
    expect(table).toBe('customer_properties');
    const q = { criteria: {}, ids: [] };
    q.where = (criteria) => { q.criteria = criteria; return q; };
    q.whereIn = (_col, ids) => { q.ids = ids; return q; };
    q.select = async () => Object.values(PROPERTIES)
      .filter((row) => Object.entries(q.criteria).every(([k, v]) => row[k] === v) && q.ids.includes(row.id));
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

  test('a property-tagged line without a client_id gets a stable one, so a later edit keeps its frozen address', async () => {
    const created = await attachInvoiceLineProperties(fakeConn(), CUSTOMER, [service(undefined, PALM), service(undefined, BAY)]);
    expect(created.map((l) => l.client_id)).toEqual([expect.stringMatching(/^li_[0-9a-f-]{36}$/), expect.stringMatching(/^li_[0-9a-f-]{36}$/)]);
    expect(created[0].client_id).not.toBe(created[1].client_id);
    // The same lines resubmitted on an edit are recognised as unchanged: no property read, snapshots kept.
    const neverCalled = () => { throw new Error('no property read expected'); };
    const edited = await attachInvoiceLineProperties(neverCalled, CUSTOMER, created.map((l) => ({ ...l, property_address: undefined })), { existingLineItems: created });
    expect(edited.map((l) => l.property_address)).toEqual(created.map((l) => l.property_address));
    // An untagged line is left exactly as sent (no identity minted).
    const plain = await attachInvoiceLineProperties(neverCalled, CUSTOMER, [{ description: 'Service', quantity: 1, unit_price: 10, amount: 10 }]);
    expect(plain[0]).not.toHaveProperty('client_id');
  });

  test('refuses a property that is not this customer\'s (400, invalid_line_property)', async () => {
    await expect(attachInvoiceLineProperties(fakeConn(), CUSTOMER, [service('a', PALM), service('b', OTHER)]))
      .rejects.toMatchObject({ statusCode: 400, code: 'invalid_line_property' });
    await expect(attachInvoiceLineProperties(fakeConn(), CUSTOMER, [service('a', 'not-a-uuid')]))
      .rejects.toMatchObject({ statusCode: 400, code: 'invalid_line_property' });
    // A property removed from the customer (deactivated) cannot be chosen for a new line either...
    await expect(attachInvoiceLineProperties(fakeConn(), CUSTOMER, [service('a', REMOVED)]))
      .rejects.toMatchObject({ statusCode: 400, code: 'invalid_line_property' });
    // ...but an unchanged line that was frozen at it before the removal keeps its history on edit.
    const frozenRemoved = { address_line1: '77 Former Pl', address_line2: null, city: 'Bradenton', state: 'FL', zip: '34209' };
    const kept = await attachInvoiceLineProperties(fakeConn(), CUSTOMER, [service('a', REMOVED)], { existingLineItems: [{ ...service('a', REMOVED), property_address: frozenRemoved }] });
    expect(kept[0].property_address).toEqual(frozenRemoved);
  });

  test('an edit keeps the frozen snapshot of an unchanged property without reading it; only a changed property is looked up', async () => {
    const frozen = { address_line1: '1842 Palm Harbor Dr (as invoiced)', address_line2: null, city: 'Bradenton', state: 'FL', zip: '34209' };
    const existing = [{ ...service('a', PALM), property_address: frozen }, { ...service('b', PALM), property_address: frozen }];
    const reads = [];
    const conn = (table) => { reads.push(table); return fakeConn()(table); };
    // Line a keeps PALM (frozen snapshot retained, even though the live row differs);
    // line b moves to BAY (looked up and frozen now).
    const items = await attachInvoiceLineProperties(conn, CUSTOMER, [service('a', PALM), service('b', BAY), discount('a-d', 'a')], { existingLineItems: existing });
    expect(items[0].property_address).toEqual(frozen);
    expect(items[1].property_address).toMatchObject({ address_line1: '410 Bayshore Rd' });
    expect(items[2]).toMatchObject({ property_id: PALM, property_address: frozen });
    expect(reads).toEqual(['customer_properties']);

    // A NEW line for a property another unchanged line already names is still looked up and frozen
    // from the live row (per-line history, not per-property), so it gets the current address.
    const added = await attachInvoiceLineProperties(fakeConn(), CUSTOMER, [service('a', PALM), service('c', PALM)], { existingLineItems: existing });
    expect(added[0].property_address).toEqual(frozen);
    expect(added[1].property_address).toMatchObject({ address_line1: '1842 Palm Harbor Dr' });
    // ...and a new line naming a property that no longer exists is refused even beside an unchanged line.
    await expect(attachInvoiceLineProperties(fakeConn(), CUSTOMER, [service('a', PALM), service('c', 'dddddddd-dddd-4ddd-8ddd-dddddddddddd')], { existingLineItems: existing }))
      .rejects.toMatchObject({ statusCode: 400, code: 'invalid_line_property' });

    // Nothing changed → no read at all, so a property edited or removed since never blocks the edit.
    const neverCalled = () => { throw new Error('no property read expected'); };
    const same = await attachInvoiceLineProperties(neverCalled, CUSTOMER, existing.map((l) => ({ ...l, property_address: undefined })), { existingLineItems: existing });
    expect(same.map((l) => l.property_address)).toEqual([frozen, frozen]);
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

test('techSafeInvoiceLineItems drops property metadata from every line (array or stored JSON) and keeps the money', () => {
  const lines = [{ client_id: 'a', description: 'Service', quantity: 1, unit_price: 149, amount: 149, property_id: PALM, property_address: { address_line1: 'x' } },
    { client_id: 'a-d', _kind: 'discount', discount_for: 'a', amount: -14.9, property_id: PALM, property_address: { address_line1: 'x' } }];
  for (const input of [lines, JSON.stringify(lines)]) {
    const safe = techSafeInvoiceLineItems(input);
    expect(safe).toEqual([{ client_id: 'a', description: 'Service', quantity: 1, unit_price: 149, amount: 149 }, { client_id: 'a-d', _kind: 'discount', discount_for: 'a', amount: -14.9 }]);
  }
  expect(techSafeInvoiceLineItems('not json')).toEqual([]);
  expect(techSafeInvoiceLineItems(null)).toEqual([]);
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

  test('a line-item discount that fits no group keeps the invoice flat; a stamped property places an orphaned one', () => {
    // Service lines without client_ids (an API or Intelligence Bar create): the discount's parent cannot be
    // found by discount_for, so grouping would drop it and the subtotals would overstate the charge → flat.
    const noIds = [
      { ...service(undefined, PALM), property_address: addr(PALM) }, { ...service(undefined, BAY), property_address: addr(BAY) },
      { _kind: 'discount', discount_for: 'gone', description: 'Multi-Home Discount (10%)', quantity: 1, unit_price: -14.9, amount: -14.9 },
    ];
    expect(groupInvoiceLinesByProperty(noIds)).toBeNull();
    // The same orphan stamped with its property (attachInvoiceLineProperties does this from the parent) is placed.
    const stamped = [...noIds.slice(0, 2), { ...noIds[2], property_id: BAY }];
    const groups = groupInvoiceLinesByProperty(stamped);
    expect(groups[1].discounts).toHaveLength(1);
    expect(groups.map((g) => g.subtotal)).toEqual([149, 134.1]);
  });

  test('one property frozen at two addresses (re-frozen after an address change) is two groups and two email labels', () => {
    const before = { ...addr(PALM), address_line1: '1842 Palm Harbor Dr (old)' };
    const lines = [
      { ...service('a', PALM), property_address: before }, { ...discount('a-d', 'a'), property_id: PALM, property_address: before },
      { ...service('b', PALM), property_address: addr(PALM) },
    ];
    const groups = groupInvoiceLinesByProperty(lines);
    expect(groups.map((g) => g.label)).toEqual(['1842 Palm Harbor Dr (old), Bradenton, FL 34209', '1842 Palm Harbor Dr, Bradenton, FL 34209']);
    expect(groups[0].discounts).toHaveLength(1);
    expect(groups.map((g) => g.lines.map((l) => l.client_id))).toEqual([['a'], ['b']]);
    expect(invoicePropertyLabels(lines)).toEqual(['1842 Palm Harbor Dr (old), Bradenton, FL 34209', '1842 Palm Harbor Dr, Bradenton, FL 34209']);
  });

  test('flat invoices answer null: no lines, one property, or any line without a property', () => {
    expect(groupInvoiceLinesByProperty([])).toBeNull();
    expect(groupInvoiceLinesByProperty(null)).toBeNull();
    expect(groupInvoiceLinesByProperty([service('a', PALM), service('b', PALM)])).toBeNull();
    expect(groupInvoiceLinesByProperty([service('a', PALM), service('b', null)])).toBeNull();
    expect(groupInvoiceLinesByProperty([{ description: 'Legacy', quantity: 1, unit_price: 99, amount: 99 }])).toBeNull();
    expect(invoicePropertyLabels([service('a', PALM)])).toEqual([]); // no frozen address → legacy resolution
    expect(propertyAddressLabel(null)).toBe('');
  });

  test('the email names the one frozen property even when the table stays flat (a second home, not the primary)', async () => {
    const bayOnly = [{ ...service('a', BAY), property_address: addr(BAY) }, { ...service('b', BAY), property_address: addr(BAY) }];
    expect(groupInvoiceLinesByProperty(bayOnly)).toBeNull();
    expect(invoicePropertyLabels(bayOnly)).toEqual(['410 Bayshore Rd Unit B, Parrish, FL 34219']);
    const Details = require('../services/billing-email-details');
    const text = await Details.invoicePropertyAddress({ customer_id: CUSTOMER, line_items: bayOnly }, { id: CUSTOMER, address_line1: '1842 Palm Harbor Dr', city: 'Bradenton', state: 'FL', zip: '34209' });
    expect(text).toBe('410 Bayshore Rd Unit B, Parrish, FL 34219');
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

  test('a long grouped PDF paginates: every row and the totals stay inside the printable page', async () => {
    const PDFDocument = require('pdfkit');
    const written = jest.spyOn(PDFDocument.prototype, 'text');
    const addPage = jest.spyOn(PDFDocument.prototype, 'addPage');
    try {
      const lines = [];
      for (let i = 0; i < 10; i++) {
        const id = i % 2 ? BAY : PALM;
        lines.push({ ...service(`s${i}`, id, 149), description: `Service ${i + 1} with a long description that wraps onto a second line in the PDF table column`, property_address: addr(id) });
        lines.push({ ...discount(`s${i}-d`, `s${i}`), property_id: id, property_address: addr(id) });
      }
      const invoice = {
        invoice_number: 'QA-LONG', status: 'sent', subtotal: 1490, discount_amount: 149, discount_label: 'Multi-Home Discount', total: 1341,
        created_at: new Date(), due_date: new Date(), line_items: lines, notes: 'Thank you.',
        customer: { first_name: 'Synthetic', last_name: 'Fixture', address_line1: '1842 Palm Harbor Dr', city: 'Bradenton', state: 'FL', zip: '34209' },
      };
      const pdf = require('../services/pdf/invoice-pdf');
      const buffer = await pdf.buildInvoicePDFBuffer(invoice);
      expect(buffer.subarray(0, 4).toString()).toBe('%PDF');
      expect(addPage).toHaveBeenCalled();
      // Table and totals content only (the page header/footer chrome is drawn in the margins on purpose).
      const content = written.mock.calls.filter((args) => typeof args[2] === 'number'
        && /^(Service \d+|Multi-Home Discount|.* subtotal$|1842 Palm|410 Bayshore|SUBTOTAL|Subtotal|TOTAL|Discount)/.test(String(args[0])));
      expect(content.length).toBeGreaterThan(20); // 10 lines + 10 discounts + headings, subtotals, totals
      const outside = content.filter((args) => args[2] < 40 || args[2] > 752).map((args) => `${String(args[0]).slice(0, 30)}@${args[2]}`);
      expect(outside).toEqual([]);
      expect(content.some((args) => String(args[0]) === 'TOTAL')).toBe(true);
    } finally { written.mockRestore(); addPage.mockRestore(); }
  });

  test('the billing email Property row names both properties, outranking the visit link', async () => {
    const Details = require('../services/billing-email-details');
    const text = await Details.invoicePropertyAddress({ customer_id: CUSTOMER, scheduled_service_id: 'visit-1', line_items: JSON.stringify(twoHomes) }, null);
    expect(text).toBe('1842 Palm Harbor Dr, Bradenton, FL 34209 and 410 Bayshore Rd Unit B, Parrish, FL 34219');
  });
});
