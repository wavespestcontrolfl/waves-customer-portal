/**
 * Billing email details: every visit / completion record / saved property read
 * goes through ONE ownership-checked path that carries the owning customer id.
 * A stamped pointer that names ANOTHER customer's row reads as "not linked".
 *
 * The db mock applies the `where({...})` object filters to its rows, so a query
 * that forgets the customer id returns the foreign row and these tests fail.
 */

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const db = require('../models/db');
const Details = require('../services/billing-email-details');

function mockTables(tables) {
  db.mockImplementation((table) => {
    let rows = tables[table] || [];
    const q = {};
    q.where = jest.fn((cond) => {
      if (cond && typeof cond === 'object') {
        rows = rows.filter((r) => Object.entries(cond).every(([k, v]) => r[k] === v));
      }
      return q;
    });
    ['whereIn', 'whereRaw', 'orderBy', 'join', 'leftJoin', 'select'].forEach((m) => { q[m] = jest.fn(() => q); });
    q.first = jest.fn(async () => rows[0]);
    q.then = (resolve, reject) => Promise.resolve(rows).then(resolve, reject);
    return q;
  });
}

const HOME = { address_line1: '100 Home Lane', address_line2: null, city: 'Bradenton', state: 'FL', zip: '34205' };
const stamped = (customerId, line1) => ({
  id: 'ss-1', customer_id: customerId, service_type: 'Quarterly Pest Control', scheduled_date: '2026-09-18',
  service_address_line1: line1, service_address_line2: null, service_address_city: 'Sarasota', service_address_state: 'FL', service_address_zip: '34236',
});

describe('invoice property: the visit must belong to the invoice customer', () => {
  test('the customer\'s own stamped visit address is used', async () => {
    mockTables({ scheduled_services: [stamped('c', '55 Rental Court')] });
    expect(await Details.invoicePropertyAddress({ id: 'i', customer_id: 'c', scheduled_service_id: 'ss-1' }, HOME))
      .toBe('55 Rental Court, Sarasota, FL 34236');
  });

  // RULE A (round 5): a link that is present but foreign OMITS the row; the
  // primary address is for an invoice with no link at all.
  test('a scheduled_service_id naming ANOTHER customer\'s visit omits the row (never the primary address)', async () => {
    mockTables({ scheduled_services: [stamped('someone-else', '9 Foreign Road')] });
    const out = await Details.invoicePropertyAddress({ id: 'i', customer_id: 'c', scheduled_service_id: 'ss-1' }, HOME);
    expect(out).toBe('');
  });

  test('an invoice with NO visit or record link falls back to the customer\'s primary address', async () => {
    mockTables({});
    expect(await Details.invoicePropertyAddress({ id: 'i', customer_id: 'c' }, { id: 'c', ...HOME }))
      .toBe('100 Home Lane, Bradenton, FL 34205');
  });

  test('a customer object that is not the invoice customer is never used for the fallback', async () => {
    mockTables({ customers: [{ id: 'c', ...HOME }] });
    expect(await Details.invoicePropertyAddress({ id: 'i', customer_id: 'c' }, { id: 'other', ...HOME, address_line1: '9 Foreign Road' }))
      .toBe('100 Home Lane, Bradenton, FL 34205');
  });

  test('a service record naming another customer\'s visit omits the row too', async () => {
    mockTables({
      service_records: [{ id: 'sr-1', customer_id: 'c', scheduled_service_id: 'ss-1' }],
      scheduled_services: [stamped('someone-else', '9 Foreign Road')],
    });
    expect(await Details.invoicePropertyAddress({ id: 'i', customer_id: 'c', service_record_id: 'sr-1' }, HOME))
      .toBe('');
  });

  test('another customer\'s service record never supplies a visit', async () => {
    mockTables({
      service_records: [{ id: 'sr-1', customer_id: 'someone-else', scheduled_service_id: 'ss-1' }],
      scheduled_services: [stamped('c', '55 Rental Court')],
    });
    expect(await Details.invoicePropertyAddress({ id: 'i', customer_id: 'c', service_record_id: 'sr-1' }, HOME))
      .toBe('');
  });

  test('a FAILED lookup still omits the Property row (not the primary address)', async () => {
    db.mockImplementation(() => { throw new Error('db down'); });
    expect(await Details.invoicePropertyAddress({ id: 'i', customer_id: 'c', scheduled_service_id: 'ss-1' }, HOME)).toBe('');
  });
});

describe('invoice service and date: the visit / record must belong to the invoice customer', () => {
  test('a foreign visit supplies neither service type nor date', async () => {
    mockTables({ scheduled_services: [stamped('someone-else', '9 Foreign Road')] });
    expect(await Details.invoiceServiceDetails({
      id: 'i', customer_id: 'c', scheduled_service_id: 'ss-1', service_type: null, service_date: null, title: 'Lawn Care Visit — August 2026',
    })).toEqual({ label: 'Lawn Care Visit', date: '' });
  });

  test('a foreign completion record supplies neither service type nor date', async () => {
    mockTables({ service_records: [{ id: 'sr-1', customer_id: 'someone-else', service_type: 'Rodent Trapping', service_date: '2026-09-11' }] });
    expect(await Details.invoiceServiceDetails({
      id: 'i', customer_id: 'c', service_record_id: 'sr-1', service_type: null, service_date: null,
    })).toEqual({ label: '', date: '' });
  });

  test('the customer\'s own visit still supplies both', async () => {
    mockTables({ scheduled_services: [stamped('c', '55 Rental Court')] });
    expect(await Details.invoiceServiceDetails({
      id: 'i', customer_id: 'c', scheduled_service_id: 'ss-1', service_type: null, service_date: null,
    })).toEqual({ label: 'Quarterly Pest Control', date: 'September 18, 2026' });
  });
});

describe('invoice service date precedence: the completion record\'s date beats the scheduled date', () => {
  test('invoice has a service but no date; the visit HAS a service type: the record\'s date still wins', async () => {
    mockTables({
      service_records: [{ id: 'sr-1', customer_id: 'c', service_type: 'Quarterly Pest Control', service_date: '2026-09-20', scheduled_service_id: 'ss-1' }],
      scheduled_services: [stamped('c', '55 Rental Court')],
    });
    expect(await Details.invoiceServiceDetails({
      id: 'i', customer_id: 'c', scheduled_service_id: 'ss-1', service_record_id: 'sr-1', service_type: 'Quarterly Pest Control', service_date: null,
    })).toEqual({ label: 'Quarterly Pest Control', date: 'September 20, 2026' });
  });

  test('no service and no date: visit label, record date', async () => {
    mockTables({
      service_records: [{ id: 'sr-1', customer_id: 'c', service_type: 'Other', service_date: '2026-09-20', scheduled_service_id: 'ss-1' }],
      scheduled_services: [stamped('c', '55 Rental Court')],
    });
    expect(await Details.invoiceServiceDetails({
      id: 'i', customer_id: 'c', scheduled_service_id: 'ss-1', service_record_id: 'sr-1', service_type: null, service_date: null,
    })).toEqual({ label: 'Quarterly Pest Control', date: 'September 20, 2026' });
  });
});

describe('estimate follow-up property: the saved property must belong to the estimate customer', () => {
  test('the customer\'s own property is used', async () => {
    mockTables({
      customer_properties: [{ id: 'p-1', customer_id: 'c', address_line1: '77 Saved Street', city: 'Parrish', state: 'FL', zip: '34219' }],
      customers: [{ id: 'c', ...HOME }],
    });
    expect(await Details.customerPropertyAddress('c', 'p-1')).toBe('77 Saved Street, Parrish, FL 34219');
  });

  test('another customer\'s property_id omits the row (never the estimate customer\'s primary address)', async () => {
    mockTables({
      customer_properties: [{ id: 'p-1', customer_id: 'someone-else', address_line1: '9 Foreign Road', city: 'Tampa', state: 'FL', zip: '33601' }],
      customers: [{ id: 'c', ...HOME }],
    });
    expect(await Details.customerPropertyAddress('c', 'p-1')).toBe('');
  });

  test('an owned property with NO street line omits the row (never the primary address)', async () => {
    mockTables({
      customer_properties: [{ id: 'p-1', customer_id: 'c', address_line1: '', city: 'Parrish', state: 'FL', zip: '34219' }],
      customers: [{ id: 'c', ...HOME }],
    });
    expect(await Details.customerPropertyAddress('c', 'p-1')).toBe('');
  });

  test('no property_id at all falls back to the customer\'s primary address', async () => {
    mockTables({ customers: [{ id: 'c', ...HOME }] });
    expect(await Details.customerPropertyAddress('c', null)).toBe('100 Home Lane, Bradenton, FL 34205');
  });

  test('a property with no customer to check it against is never read', async () => {
    mockTables({ customer_properties: [{ id: 'p-1', customer_id: 'someone-else', address_line1: '9 Foreign Road', city: 'Tampa', state: 'FL', zip: '33601' }] });
    expect(await Details.customerPropertyAddress(null, 'p-1')).toBe('');
  });
});

describe('round 5: invoice with BOTH a completion record and a scheduled visit', () => {
  const rec = (sid) => ({ id: 'sr-1', customer_id: 'c', service_type: 'Rodent Trapping', service_date: '2026-09-11', scheduled_service_id: sid });
  const inv = { id: 'i', customer_id: 'c', scheduled_service_id: 'ss-1', service_record_id: 'sr-1', service_type: null, service_date: null, title: 'Visit — August 2026' };

  test('a record that points at a DIFFERENT visit omits service, date and property (no mixing)', async () => {
    mockTables({
      service_records: [rec('ss-other')],
      scheduled_services: [stamped('c', '55 Rental Court'), { ...stamped('c', '1 Other Place'), id: 'ss-other' }],
    });
    expect(await Details.invoicePropertyAddress(inv, HOME)).toBe('');
    expect(await Details.invoiceServiceDetails(inv)).toEqual({ label: 'Visit', date: '' });
  });

  test('a record that points at the SAME visit still supplies everything', async () => {
    mockTables({ service_records: [rec('ss-1')], scheduled_services: [stamped('c', '55 Rental Court')] });
    expect(await Details.invoicePropertyAddress(inv, HOME)).toBe('55 Rental Court, Sarasota, FL 34236');
    expect(await Details.invoiceServiceDetails(inv)).toEqual({ label: 'Quarterly Pest Control', date: 'September 11, 2026' });
  });
});

describe('round 9: BOTH invoice pointers require the record to name the same visit', () => {
  const inv = { id: 'i', customer_id: 'c', scheduled_service_id: 'ss-1', service_record_id: 'sr-1', service_type: null, service_date: null, title: 'Visit — August 2026' };
  const legacy = { id: 'sr-1', customer_id: 'c', service_type: 'Rodent Trapping', service_date: '2026-09-11', scheduled_service_id: null };

  test('a legacy record with NULL scheduled_service_id is a conflict: no property, service or date', async () => {
    mockTables({ service_records: [legacy], scheduled_services: [stamped('c', '55 Rental Court')] });
    expect(await Details.invoicePropertyAddress(inv, HOME)).toBe('');
    expect(await Details.invoiceServiceDetails(inv)).toEqual({ label: 'Visit', date: '' });
    const ctx = await Details._private.ownedVisitContext(inv);
    expect(ctx).toMatchObject({ conflict: true, visit: null, record: null });
  });

  test('a record-only invoice (no direct visit pointer) still resolves through the record\'s own visit', async () => {
    mockTables({ service_records: [{ ...legacy, scheduled_service_id: 'ss-1' }], scheduled_services: [stamped('c', '55 Rental Court')] });
    const recordOnly = { ...inv, scheduled_service_id: null };
    expect(await Details.invoicePropertyAddress(recordOnly, HOME)).toBe('55 Rental Court, Sarasota, FL 34236');
  });

  test('a legacy record with NULL link and NO direct visit pointer stays unresolved (row omitted)', async () => {
    mockTables({ service_records: [legacy] });
    expect(await Details.invoicePropertyAddress({ ...inv, scheduled_service_id: null }, HOME)).toBe('');
  });
});

describe('round 5: an unstamped visit resolves through property_id, then source_estimate_id (Rule A)', () => {
  const unstamped = (extra) => ({ ...stamped('c', null), service_address_city: null, service_address_zip: null, service_address_state: null, ...extra });
  const inv = { id: 'i', customer_id: 'c', scheduled_service_id: 'ss-1' };
  const PROP = { id: 'p-2', customer_id: 'c', address_line1: '55 Rental Court', city: 'Sarasota', state: 'FL', zip: '34236' };

  test('property_id: the visit\'s OWN saved property, not the primary address', async () => {
    mockTables({ scheduled_services: [unstamped({ property_id: 'p-2' })], customer_properties: [PROP] });
    expect(await Details.invoicePropertyAddress(inv, HOME)).toBe('55 Rental Court, Sarasota, FL 34236');
  });

  test('property_id naming another customer\'s property omits the row', async () => {
    mockTables({ scheduled_services: [unstamped({ property_id: 'p-2' })], customer_properties: [{ ...PROP, customer_id: 'someone-else' }] });
    expect(await Details.invoicePropertyAddress(inv, HOME)).toBe('');
  });

  test('property_id naming a property with no street line omits the row', async () => {
    mockTables({ scheduled_services: [unstamped({ property_id: 'p-2' })], customer_properties: [{ ...PROP, address_line1: '' }] });
    expect(await Details.invoicePropertyAddress(inv, HOME)).toBe('');
  });

  test('source_estimate_id: the estimate\'s street address, not the primary address', async () => {
    mockTables({
      scheduled_services: [unstamped({ source_estimate_id: 'e-1' })],
      estimates: [{ id: 'e-1', customer_id: 'c', address: '88 Estimate Way, Venice, FL 34285', property_id: null }],
    });
    expect(await Details.invoicePropertyAddress(inv, HOME)).toBe('88 Estimate Way, Venice, FL 34285');
  });

  test('source_estimate_id: the estimate\'s owned property wins over its free text', async () => {
    mockTables({
      scheduled_services: [unstamped({ source_estimate_id: 'e-1' })],
      estimates: [{ id: 'e-1', customer_id: 'c', address: 'Rental 2', property_id: 'p-2' }],
      customer_properties: [PROP],
    });
    expect(await Details.invoicePropertyAddress(inv, HOME)).toBe('55 Rental Court, Sarasota, FL 34236');
  });

  test('source_estimate_id naming another customer\'s estimate, or a nickname-only estimate, omits the row', async () => {
    mockTables({
      scheduled_services: [unstamped({ source_estimate_id: 'e-1' })],
      estimates: [{ id: 'e-1', customer_id: 'someone-else', address: '9 Foreign Road, Tampa, FL 33601', property_id: null }],
    });
    expect(await Details.invoicePropertyAddress(inv, HOME)).toBe('');
    mockTables({
      scheduled_services: [unstamped({ source_estimate_id: 'e-1' })],
      estimates: [{ id: 'e-1', customer_id: 'c', address: 'Rental 2', property_id: null }],
    });
    expect(await Details.invoicePropertyAddress(inv, HOME)).toBe('');
  });

  test('the stamp still wins over property_id and source_estimate_id', async () => {
    mockTables({ scheduled_services: [stamped('c', '10 Stamp Street')].map((v) => ({ ...v, property_id: 'p-2' })), customer_properties: [PROP] });
    expect(await Details.invoicePropertyAddress(inv, HOME)).toBe('10 Stamp Street, Sarasota, FL 34236');
  });
});

describe('round 5: combined-packet labels are verified against customer, invoice and packet visit', () => {
  const member = (over) => ({
    'i.invoice_id': 'i', 'i.packet_id': 'pk-1', member_visit_row_id: 'ss-1', member_customer_id: 'c',
    packet_visit_id: 'v-1', member_visit_id: 'v-1', service_type: 'Lawn Care', ...over,
  });
  const inv = { id: 'i', customer_id: 'c', visit_completion_packet_id: 'pk-1', service_type: null, service_date: '2026-09-02', title: 'Combined visit' };

  test('own members supply the labels', async () => {
    mockTables({ 'visit_completion_packet_items as i': [member(), member({ service_type: 'Pest Control' })] });
    expect((await Details.invoiceServiceDetails(inv)).label).toBe('Lawn Care, Pest Control');
  });

  test('a member visit owned by ANOTHER customer is never named', async () => {
    mockTables({ 'visit_completion_packet_items as i': [member({ member_customer_id: 'someone-else', service_type: 'Foreign Service' })] });
    expect((await Details.invoiceServiceDetails(inv)).label).toBe('Combined visit');
  });

  test('a member whose visit is not the packet\'s own visit is never named', async () => {
    mockTables({ 'visit_completion_packet_items as i': [member({ member_visit_id: 'v-elsewhere', service_type: 'Foreign Service' })] });
    expect((await Details.invoiceServiceDetails(inv)).label).toBe('Combined visit');
  });

  test('a packet item for another invoice is never named', async () => {
    mockTables({ 'visit_completion_packet_items as i': [member({ 'i.invoice_id': 'another-invoice' })] });
    expect((await Details.invoiceServiceDetails(inv)).label).toBe('Combined visit');
  });

  test('the Property row of a packet-only invoice needs every verified member on the SAME address', async () => {
    const m = (line1, over) => member({ ...stamped('c', line1), ...over });
    mockTables({ 'visit_completion_packet_items as i': [m('55 Rental Court'), m('55 Rental Court')] });
    expect(await Details.invoicePropertyAddress(inv, HOME)).toBe('55 Rental Court, Sarasota, FL 34236');
    mockTables({ 'visit_completion_packet_items as i': [m('55 Rental Court'), m('9 Other Street')] });
    expect(await Details.invoicePropertyAddress(inv, HOME)).toBe('');
    mockTables({ 'visit_completion_packet_items as i': [m('55 Rental Court', { member_customer_id: 'someone-else' })] });
    expect(await Details.invoicePropertyAddress(inv, HOME)).toBe('');
  });
  // Round 9: the packet is verified as a SET. One rejected member (foreign
  // customer, mismatched packet visit, visit row that does not exist) or a
  // failed lookup omits EVERY packet-derived detail, never just that member.
  describe('round 9: one rejected member omits the whole packet', () => {
    const good = (line1, over) => member({ ...stamped('c', line1), ...over });
    const bad = {
      foreign: { member_customer_id: 'someone-else' },
      'another packet visit': { member_visit_id: 'v-elsewhere' },
      'missing visit row': { member_visit_row_id: null, member_customer_id: null, member_visit_id: null },
      'packet without a visit': { packet_visit_id: null, member_visit_id: null },
    };

    test.each(Object.entries(bad))('a %s member drops the service list and the Property row', async (_name, over) => {
      const rows = [good('55 Rental Court', { service_type: 'Lawn Care' }), good('55 Rental Court', { service_type: 'Pest Control', ...over })];
      mockTables({ 'visit_completion_packet_items as i': rows });
      expect((await Details.invoiceServiceDetails(inv)).label).toBe('Combined visit');
      expect(await Details.invoicePropertyAddress(inv, HOME)).toBe('');
    });

    test('the packet query loads every item for the invoice (nothing is filtered out in SQL)', async () => {
      db.mockClear();
      mockTables({ 'visit_completion_packet_items as i': [good('55 Rental Court')] });
      await Details.invoicePropertyAddress(inv, HOME);
      const q = db.mock.results[0].value;
      expect(q.where).toHaveBeenCalledWith({ 'i.invoice_id': 'i', 'i.packet_id': 'pk-1' });
      expect(q.leftJoin).toHaveBeenCalled();
      expect(q.whereRaw).not.toHaveBeenCalled();
    });

    test('a failed packet lookup omits the Property row and the service list', async () => {
      db.mockImplementation(() => { throw new Error('db blip'); });
      expect(await Details.invoicePropertyAddress(inv, HOME)).toBe('');
      expect((await Details.invoiceServiceDetails(inv)).label).toBe('Combined visit');
    });

    test('a rejected member never falls back to the owner visit for the service list', async () => {
      const adopted = { ...inv, scheduled_service_id: 'ss-1' };
      mockTables({
        'visit_completion_packet_items as i': [good('55 Rental Court'), good('55 Rental Court', bad.foreign)],
        scheduled_services: [stamped('c', '55 Rental Court')],
      });
      expect((await Details.invoiceServiceDetails(adopted)).label).toBe('Combined visit');
    });
  });

  // Round 8: visit-completion-invoice adopts a packet onto an invoice that keeps
  // the owner visit's scheduled_service_id and gains service_record_id. The
  // direct link must not speak for the whole packet.
  describe('an adopted packet invoice (keeps the owner visit link)', () => {
    const adopted = { ...inv, scheduled_service_id: 'ss-1', service_record_id: 'sr-1' };
    const m = (line1, over) => member({ ...stamped('c', line1), ...over });
    const tables = (members) => ({
      'visit_completion_packet_items as i': members,
      scheduled_services: [stamped('c', '55 Rental Court')],
      service_records: [{ id: 'sr-1', customer_id: 'c', service_type: 'Lawn Care', service_date: '2026-09-02', scheduled_service_id: 'ss-1' }],
    });

    test('members on different addresses omit the row even though the owner visit resolves', async () => {
      mockTables(tables([m('55 Rental Court'), m('9 Other Street')]));
      expect(await Details.invoicePropertyAddress(adopted, HOME)).toBe('');
    });

    test('members all on one address name it', async () => {
      mockTables(tables([m('9 Other Street'), m('9 Other Street')]));
      expect(await Details.invoicePropertyAddress(adopted, HOME)).toBe('9 Other Street, Sarasota, FL 34236');
    });

    test('a packet with no verified members omits the row (never the owner visit, never primary)', async () => {
      mockTables(tables([]));
      expect(await Details.invoicePropertyAddress(adopted, HOME)).toBe('');
    });

    test('the service label comes from the packet members, not the owner visit alone', async () => {
      mockTables(tables([member(), member({ service_type: 'Pest Control' })]));
      expect((await Details.invoiceServiceDetails(adopted)).label).toBe('Lawn Care, Pest Control');
    });
  });
});
