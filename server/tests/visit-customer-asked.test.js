/**
 * visit-customer-asked.js: the "Customer asked" facts on the tech Visit Brief. Each of the four sources shows; an
 * office-only message, a call-derived item and a closed portal request never do; the property, writer and
 * appointment filters are in the SQL, before the row limit; no money keys; a failed read omits the key; the caps hold.
 * The re-service gather itself is proven in reservice-asks.test.js and is stubbed here.
 */

jest.mock('../models/db', () => {
  const fn = () => { throw new Error('global db must not be used: dbh is passed explicitly'); };
  fn.transaction = jest.fn();
  return fn;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const mockGather = jest.fn();
jest.mock('../services/reservice-asks', () => ({
  ...jest.requireActual('../services/reservice-asks'),
  gatherReserviceAsks: (...args) => mockGather(...args),
}));
const mockSingle = jest.fn();
jest.mock('../services/reservice-property-scope', () => ({ accountProvesSinglePremises: (...args) => mockSingle(...args) }));

const knexLib = require('knex');
const { customerAskedFacts, MAX_ITEMS, MAX_TEXT_CHARS, _test } = require('../services/visit-customer-asked');
const logger = require('../services/logger');

const SVC = {
  id: 'svc-1',
  customer_id: 'cust-1',
  property_id: null,
  self_booking_id: null,
  service_type: 'Pest Control Re-Service',
  created_at: '2026-11-20T15:00:00.000Z',
  notes: null,
};

// A stub dbh: service_requests resolves to `rows`, self_booked_appointments to `booking`; `fail` makes every read throw.
function fakeDbh({ rows = [], booking, props = [], customer, messages = [], fail = false } = {}) {
  const calls = [];
  const dbh = (table) => {
    calls.push(['table', table]);
    const q = {};
    for (const m of ['where', 'whereIn', 'whereRaw', 'orderBy', 'orderByRaw', 'limit', 'join']) {
      q[m] = (...args) => { calls.push([table, m, ...args]); if (m === 'where' && args[0]?.id) q.id = args[0].id; if (m === 'where' && args[0]?.is_primary) q.primary = true; return q; };
    }
    q.select = async () => {
      if (fail) throw Object.assign(new Error('boom with customer text'), { code: 'ECONNRESET' });
      if (table === 'messages as m') return messages;
      return table === 'customer_properties' ? props : rows;
    };
    q.first = async () => {
      if (fail) throw Object.assign(new Error('boom with customer text'), { code: 'ECONNRESET' });
      if (table === 'customer_properties') return (q.primary ? props.find((p) => p.is_primary) : props.find((p) => p.id === q.id)) || undefined;
      if (table === 'customers') return customer;
      return table === 'self_booked_appointments' ? booking : undefined;
    };
    return q;
  };
  dbh.calls = calls;
  return dbh;
}

const HOME = { id: 'prop-1', is_primary: true, address_line1: '100 Example Ave', address_line2: null, city: 'Bradenton', zip: '34205' };
const RENTAL = { id: 'prop-2', is_primary: false, address_line1: '200 Sample St', address_line2: null, city: 'Parrish', zip: '34219' };
const asks = (items) => ({ ok: true, lane: 'pest', window: {}, items });
const askItem = (over) => ({ id: 'text:1', source: 'text', at: '2026-11-22T14:00:00.000Z', text: 'Ants are back in the kitchen.', quoted: true, pests: ['Ants'], ...over });
const formRow = (over) => ({ subject: 'Pest issue', description: 'Ants in room 3', source: null, created_at: '2026-11-23T10:00:00.000Z', ...over });

beforeEach(() => {
  mockGather.mockReset();
  mockGather.mockResolvedValue({ ok: false, reason: 'not_reservice' });
  mockSingle.mockReset();
  mockSingle.mockResolvedValue(true);
  process.env.GATE_RESERVICE_ASKS = 'true';
  logger.warn.mockClear();
});
afterAll(() => { delete process.env.GATE_RESERVICE_ASKS; });

describe('customerAskedFacts: the sources', () => {
  test('shows all four sources, newest first', async () => {
    mockGather.mockResolvedValue(asks([
      askItem({ id: 'booking:svc-1', source: 'request_form', at: '2026-11-20T15:00:00.000Z', text: 'Ants in the kitchen.', pests: ['Ants'] }),
      askItem({ id: 'text:9', at: '2026-11-22T14:00:00.000Z', text: 'They are worse today.', pests: [] }),
    ]));
    const svc = { ...SVC, self_booking_id: 'sb-1', notes: 'Self-booked. Notes: Please text before you arrive — Unit: 5' };
    const dbh = fakeDbh({ rows: [formRow({ subject: 'Lawn Care', description: 'Brown patch by the gate' })] });
    const facts = await customerAskedFacts(svc, dbh);
    expect(facts.items.map((i) => i.kind)).toEqual(['portal_request', 'reservice_words', 'reservice_reason', 'booking_note']);
    expect(facts.items[0]).toEqual({ kind: 'portal_request', at: '2026-11-23T10:00:00.000Z', text: 'Lawn Care: Brown patch by the gate', source: 'portal' });
    expect(facts.items[1]).toMatchObject({ text: 'They are worse today.', source: 'text' });
    expect(facts.items[2]).toMatchObject({ text: 'Ants in the kitchen.', source: 'picker', pests: ['Ants'] });
    expect(facts.items[3]).toEqual({ kind: 'booking_note', at: SVC.created_at, text: 'Please text before you arrive' });
  });

  test('the gather runs with skipCalls like the technician route; an office-only message is not shown', async () => {
    mockGather.mockResolvedValue(asks([
      askItem({ id: 'text:2', text: 'Ants are back.', officeOnly: 'refund' }),
      askItem({ id: 'text:4', text: '', officeOnly: 'damage' }),
      askItem({ id: 'booking:svc-1', source: 'request_form', text: 'Ants in the kitchen.' }),
    ]));
    const dbh = fakeDbh();
    const facts = await customerAskedFacts(SVC, dbh);
    expect(mockGather).toHaveBeenCalledWith('svc-1', { knex: dbh, skipCalls: true });
    expect(facts.items).toHaveLength(1);
    expect(facts.items[0]).toMatchObject({ kind: 'reservice_reason', text: 'Ants in the kitchen.' });
    expect(JSON.stringify(facts)).not.toMatch(/refund/);
  });

  test('with the gate off the re-service gather never runs; no money keys', async () => {
    process.env.GATE_RESERVICE_ASKS = 'false';
    const facts = await customerAskedFacts({ ...SVC, self_booking_id: 'sb-1', notes: 'Self-booked. Notes: Gate is open' }, fakeDbh());
    expect(mockGather).not.toHaveBeenCalled();
    expect(Object.keys(facts.items[0]).sort()).toEqual(['at', 'kind', 'text']);
    expect(JSON.stringify(facts)).not.toMatch(/price|total|amount|discount|invoice|pricing/i);
  });
});

describe('customerAskedFacts: booking note', () => {
  test('the original booking customer_notes win over the visit notes line, and keep their lines', async () => {
    const svc = { ...SVC, self_booking_id: 'sb-1', notes: 'Self-booked. Notes: Cut short — Unit: 5' };
    const dbh = fakeDbh({ booking: { customer_notes: 'Side gate sticks.\nPlease text first.' } });
    const facts = await customerAskedFacts(svc, dbh);
    expect(facts.items).toEqual([{ kind: 'booking_note', at: SVC.created_at, text: 'Side gate sticks. Please text first.' }]);
  });

  test('without the booking row, continuation lines of the notes line are kept up to the appendix', async () => {
    const svc = { ...SVC, self_booking_id: 'sb-1', notes: 'Self-booked. Notes: Side gate sticks.\nPlease text first. — Unit: 5' };
    const facts = await customerAskedFacts(svc, fakeDbh());
    expect(facts.items[0].text).toBe('Side gate sticks. Please text first.');
  });

  test('an unreadable booking row falls back to the notes line', async () => {
    const svc = { ...SVC, self_booking_id: 'sb-1', notes: 'Self-booked. Notes: Beware of the dog' };
    const dbh = fakeDbh({ fail: true });
    const facts = await customerAskedFacts(svc, dbh);
    expect(facts.items.map((i) => i.kind)).toEqual(['booking_note']);
  });

  test('a re-service request line in the notes is the reason, not a booking note', async () => {
    const facts = await customerAskedFacts({ ...SVC, notes: 'Self-booked. Notes: Re-service request: ants are back — Unit: 5' }, fakeDbh());
    expect(facts).toBeNull();
  });
});

describe('customerAskedFacts: portal requests', () => {
  const pg = () => knexLib({ client: 'pg' });
  const sqlOf = (svc, propertyIds) => _test.portalRowsQuery(pg(), svc, propertyIds).toSQL();

  test('the filters run in SQL before the row limit: open, own customer, categories, writer, no pricing column', () => {
    const { sql, bindings } = sqlOf(SVC, ['prop-1']);
    expect(sql).toMatch(/"customer_id" = \?/);
    expect(sql).toMatch(/"status" is null or "status" not in \(\?, \?, \?\)/);
    expect(sql).toMatch(/"category" in \(\?, \?, \?, \?, \?, \?\)/);
    expect(sql).toMatch(/"source" in \(\?, \?, \?\) or \("source" is null and \(metadata->>'writer' = 'portal_form'/);
    expect(sql).toMatch(/order by CASE WHEN source = 'customer_portal_reschedule' THEN GREATEST\(created_at, .*\) ELSE created_at END DESC limit \?/);
    expect(sql).not.toMatch(/updated_at/);
    expect(sql).toMatch(/select "subject", "description", "source", "created_at", "metadata" from/);
    expect(sql).not.toMatch(/pricing_revision/);
    expect(bindings).toEqual(expect.arrayContaining(['cust-1', 'resolved', 'closed', 'cancelled', 'pest_issue']));
    expect(bindings).not.toContain('cancellation');
    expect(sql.indexOf('limit')).toBeGreaterThan(sql.lastIndexOf('where'));
  });

  test('a multi-premises account matches the request property id to the visit premises ids', () => {
    const { sql, bindings } = sqlOf(SVC, ['prop-1', 'prop-9']);
    expect(sql).toContain("metadata->>'propertyId' IN (?, ?)");
    expect(bindings).toEqual(expect.arrayContaining(['prop-1', 'prop-9']));
  });

  test('premises that cannot be matched withhold the property-scoped rows', () => {
    expect(sqlOf(SVC, []).sql).toContain('false');
  });

  test('a provably single-premises account has no property filter; a request naming no property shows', () => {
    const { sql } = sqlOf(SVC, null);
    expect(sql).not.toContain("metadata->>'propertyId' IN");
    expect(sql).not.toMatch(/and false/);
  });

  test('only a null-source row the portal form wrote shows its description; the cancel flow row is excluded in SQL', () => {
    const { sql } = sqlOf(SVC, null);
    expect(sql).toContain("metadata->>'writer' = 'portal_form' OR metadata->>'propertyId' IS NOT NULL OR metadata->'photoIdSource' IS NOT NULL");
  });

  test('a reschedule request is matched on the anchored appointment header, not anywhere in the description', () => {
    const { sql, bindings } = sqlOf(SVC, null);
    expect(sql).toContain("left(COALESCE(description, ''), ?) = ?");
    expect(sql).not.toContain('strpos');
    expect(bindings).toEqual(expect.arrayContaining(['Appointment svc-1: '.length, 'Appointment svc-1: ', 'customer_portal_reschedule']));
  });

  describe('which properties the visit is on (not single premises)', () => {
    const { resolveVisitPropertyScope } = require('../services/service-report/visit-property-scope');
    const idsOf = async (svc, dbh) => _test.visitPropertyIds(svc, dbh, await resolveVisitPropertyScope(svc, dbh));
    beforeEach(() => mockSingle.mockResolvedValue(false));

    test('a visit with no stamp, property or estimate is on the primary property', async () => {
      expect(await idsOf(SVC, fakeDbh({ props: [HOME, RENTAL] }))).toEqual(['prop-1']);
    });

    test('a stamped service address resolves to the property it matches, even with no property_id', async () => {
      const svc = { ...SVC, service_address_line1: '200 Sample St', service_address_city: 'Parrish', service_address_zip: '34219' };
      expect(await idsOf(svc, fakeDbh({ props: [HOME, RENTAL] }))).toEqual(['prop-2']);
    });

    test("a visit's property_id resolves through that property's current address", async () => {
      expect(await idsOf({ ...SVC, property_id: 'prop-2' }, fakeDbh({ props: [HOME, { ...RENTAL, id: 'prop-2' }] }))).toEqual(['prop-2']);
    });

    test('a stamp that matches no property, or an unreadable read, withholds', async () => {
      const stray = { ...SVC, service_address_line1: '300 Nowhere Rd', service_address_city: 'Sarasota', service_address_zip: '34236' };
      expect(await idsOf(stray, fakeDbh({ props: [HOME, RENTAL] }))).toEqual([]);
      expect(await idsOf(SVC, fakeDbh({ fail: true }))).toEqual([]);
    });
  });

  test('a premises proof that fails is not single: the request is withheld by property', async () => {
    mockSingle.mockRejectedValue(Object.assign(new Error('x'), { code: 'XX000' }));
    await customerAskedFacts({ ...SVC, property_id: 'prop-1' }, fakeDbh({ rows: [], props: [HOME] }));
    expect(logger.warn.mock.calls.map((c) => c[0]).join('\n')).toContain('XX000');
  });

  test('a card or chat row shows only its service, never its description', async () => {
    const rows = [formRow({ subject: 'Quote requested in portal chat: Lawn Care', description: 'Their words: x. $149 per visit', source: 'portal_chat' })];
    const facts = await customerAskedFacts(SVC, fakeDbh({ rows }));
    expect(facts.items).toEqual([{ kind: 'portal_request', at: '2026-11-23T10:00:00.000Z', text: 'Quote requested in portal chat: Lawn Care', source: 'portal' }]);
    expect(JSON.stringify(facts)).not.toMatch(/149/);
  });

  describe('reschedule notes', () => {
    const header = 'Appointment svc-1: Pest Control on 2026-12-01\nPreferred date: 2026-12-03\nCustomer notes: Out of town that week.';
    const update = '\nCustomer updated 2026-11-25:\nPreferred date: 2026-12-10\nCustomer notes: Back on the 9th, any time after.';

    test('the newest note shows, dated by the update that supplied it, marked as this appointment\'s', async () => {
      const rows = [formRow({ subject: 'Reschedule request: Pest Control', description: header + update, source: 'customer_portal_reschedule', created_at: '2026-11-20T10:00:00.000Z' })];
      const facts = await customerAskedFacts(SVC, fakeDbh({ rows }));
      expect(facts.items).toEqual([{ kind: 'portal_request', at: '2026-11-25T17:00:00.000Z', text: 'Back on the 9th, any time after.', source: 'portal', appointment: true }]);
      expect(JSON.stringify(facts)).not.toMatch(/Preferred|2026-12/);
    });

    test('the first block is dated by the row; an update with no note falls back to the earlier note', () => {
      expect(_test.rescheduleNote(header, '2026-11-20T10:00:00.000Z')).toEqual({ note: 'Out of town that week.', at: '2026-11-20T10:00:00.000Z' });
      const quiet = `${header}\nCustomer updated 2026-11-25:\nPreferred date: 2026-12-10`;
      expect(_test.rescheduleNote(quiet, '2026-11-20T10:00:00.000Z').note).toBe('Out of town that week.');
    });

    test('a reschedule request with no typed note shows nothing', async () => {
      const rows = [formRow({ description: 'Appointment svc-1: Pest Control on 2026-12-01\nPreferred date: 2026-12-03', source: 'customer_portal_reschedule' })];
      expect(await customerAskedFacts(SVC, fakeDbh({ rows }))).toBeNull();
    });
  });
});

describe('customerAskedFacts: the address the request stored', () => {
  const STAMPED = { ...SVC, service_address_line1: '100 Example Ave', service_address_city: 'Bradenton', service_address_zip: '34205' };
  const withAddress = (address, over) => formRow({ metadata: { writer: 'portal_form', propertyId: 'prop-1', property: { id: 'prop-1', address } }, ...over });

  test('on a provably single-premises account, a request filed for another address is withheld', async () => {
    const rows = [withAddress('200 Sample St, Parrish, FL 34219', { description: 'Roaches at the rental' })];
    expect(await customerAskedFacts(STAMPED, fakeDbh({ rows }))).toBeNull();
  });

  test('a request whose stored address is this visit premises shows, spelled differently', async () => {
    const rows = [withAddress('100 Example Avenue, Bradenton, FL 34205', { description: 'Gate sticks' })];
    const facts = await customerAskedFacts(STAMPED, fakeDbh({ rows }));
    expect(facts.items[0].text).toBe('Pest issue: Gate sticks');
  });

  test('a request with no stored address keeps the property-id rule alone', () => {
    const scope = { hasEvidence: true, key: 'x|y|z' };
    expect(_test.storedAddressMatches({ metadata: null }, scope)).toBe(true);
    expect(_test.storedAddressMatches({ metadata: '{"writer":"portal_form"}' }, scope)).toBe(true);
  });

  test('a stored address cannot be matched when the visit premises are unresolved or the address is unreadable', () => {
    const row = { metadata: { property: { address: '100 Example Ave, Bradenton, FL 34205' } } };
    expect(_test.storedAddressMatches(row, { hasEvidence: true, key: null })).toBe(false);
    expect(_test.storedAddressMatches({ metadata: { property: { address: 'the yellow house' } } }, { hasEvidence: true, key: '100exampleave|bradenton|34205' })).toBe(false);
  });

  describe('an unstamped primary visit checks the saved primary address', () => {
    const row = (address) => withAddress(address, { description: 'Gate sticks' });
    test('a request for the primary address shows', async () => {
      const facts = await customerAskedFacts(SVC, fakeDbh({ props: [HOME], rows: [row('100 Example Avenue, Bradenton, FL 34205')] }));
      expect(facts.items[0].text).toBe('Pest issue: Gate sticks');
    });
    test('a request for another address is withheld', async () => {
      expect(await customerAskedFacts(SVC, fakeDbh({ props: [HOME], rows: [row('200 Sample St, Parrish, FL 34219')] }))).toBeNull();
    });
    test('the customer row address stands in when no property row exists', async () => {
      const customer = { address_line1: '100 Example Ave', address_line2: null, city: 'Bradenton', zip: '34205' };
      expect((await customerAskedFacts(SVC, fakeDbh({ customer, rows: [row('100 Example Ave, Bradenton, FL 34205')] }))).items).toHaveLength(1);
    });
    test('an unresolvable primary address withholds a request that carries an address', async () => {
      expect(await customerAskedFacts(SVC, fakeDbh({ rows: [row('100 Example Ave, Bradenton, FL 34205')] }))).toBeNull();
    });
    test('nothing is read for the primary when no request carries an address', async () => {
      const dbh = fakeDbh({ rows: [formRow()] });
      await customerAskedFacts(SVC, dbh);
      expect(dbh.calls.filter((c) => c[0] === 'customers')).toEqual([]);
    });
  });

  test('the query reads more rows than it shows, so a dropped row does not hide a valid one', () => {
    const { sql, bindings } = _test.portalRowsQuery(knexLib({ client: 'pg' }), SVC, null).toSQL();
    expect(sql).toMatch(/select "subject", "description", "source", "created_at", "metadata" from/);
    expect(bindings[bindings.length - 1]).toBe(20);
  });
});

describe('customerAskedFacts: the eight slots', () => {
  test('the return reason keeps its slot when ten newer messages exist; the display is newest first', async () => {
    mockGather.mockResolvedValue(asks([
      askItem({ id: 'booking:svc-1', source: 'request_form', at: '2026-11-01T15:00:00.000Z', text: 'Ants in the kitchen.' }),
      ...Array.from({ length: 10 }, (_, n) => askItem({ id: `text:${n}`, at: `2026-11-${String(10 + n).padStart(2, '0')}T14:00:00.000Z`, text: `Message number ${n}.` })),
    ]));
    const facts = await customerAskedFacts(SVC, fakeDbh());
    expect(facts.items).toHaveLength(MAX_ITEMS);
    expect(facts.items.filter((i) => i.kind === 'reservice_reason')).toHaveLength(1);
    // The 7 newest messages (n = 3..9) fill the other slots; the reason is oldest, so it sorts last.
    expect(facts.items.map((i) => i.text)).toEqual([...Array.from({ length: 7 }, (_, k) => `Message number ${9 - k}.`), 'Ants in the kitchen.']);
  });
});

describe('customerAskedFacts: entries first, then the limit', () => {
  test('empty reschedule rows (a preferred date only) do not use up the five slots', async () => {
    const quiet = (n) => formRow({ subject: `Reschedule ${n}`, description: 'Appointment svc-1: Pest Control on 2026-12-01\nPreferred date: 2026-12-03', source: 'customer_portal_reschedule', created_at: `2026-11-2${n}T10:00:00.000Z` });
    const rows = [...[1, 2, 3, 4, 5].map(quiet), formRow({ subject: 'Lawn Care', description: 'Brown patch', created_at: '2026-11-10T10:00:00.000Z' })];
    const facts = await customerAskedFacts(SVC, fakeDbh({ rows }));
    expect(facts.items.map((i) => i.text)).toEqual(['Lawn Care: Brown patch']);
  });
});

describe('customerAskedFacts: the generated self-serve note', () => {
  test('a re-service booked with no details is not a booking note, from the notes line or the booking row', async () => {
    const svc = { ...SVC, self_booking_id: 'sb-1', notes: 'Self-booked. Notes: Re-service requested via self-serve link — Unit: 5' };
    expect(await customerAskedFacts(svc, fakeDbh({ booking: { customer_notes: 'Re-service requested via self-serve link' } }))).toBeNull();
    expect(await customerAskedFacts({ ...svc, self_booking_id: null }, fakeDbh())).toBeNull();
  });
});

describe('customerAskedFacts: a seeded follow-up does not repeat the booking note', () => {
  test('the visit the customer booked shows it; a recurring child that copied the notes does not', async () => {
    const notes = 'Self-booked. Notes: Please text first — Unit: 5';
    expect((await customerAskedFacts({ ...SVC, self_booking_id: 'sb-1', notes }, fakeDbh())).items).toHaveLength(1);
    expect(await customerAskedFacts({ ...SVC, self_booking_id: null, recurring_parent_id: 'svc-0', notes }, fakeDbh())).toBeNull();
  });
});

describe('customerAskedFacts: portal messages', () => {
  const GATE = 'GATE_PORTAL_MESSAGES';
  const VISIT = { ...SVC, scheduled_date: '2026-11-27' };
  const message = (body, over) => ({ body, created_at: '2026-11-24T15:00:00.000Z', ...over });
  beforeEach(() => { process.env[GATE] = 'true'; });
  afterAll(() => { delete process.env[GATE]; });

  test('the customer\'s own messages show, newest first, kind portal_message, no home flag on a single-premises account', async () => {
    const rows = [message('Please come after noon', { created_at: '2026-11-25T15:00:00.000Z' }), message('Dog is in the yard')];
    const facts = await customerAskedFacts(VISIT, fakeDbh({ messages: rows }));
    expect(facts.items.map((i) => [i.kind, i.text])).toEqual([['portal_message', 'Please come after noon'], ['portal_message', 'Dog is in the yard']]);
    expect(facts.items[0]).toEqual({ kind: 'portal_message', at: '2026-11-25T15:00:00.000Z', text: 'Please come after noon', source: 'portal' });
  });

  test('on an account that may have several homes the message is marked account-wide', async () => {
    mockSingle.mockResolvedValue(false);
    const facts = await customerAskedFacts(VISIT, fakeDbh({ messages: [message('Please come after noon')], props: [HOME, RENTAL] }));
    expect(facts.items.find((i) => i.kind === 'portal_message').accountWide).toBe(true);
  });

  test('the query reads only the customer\'s inbound portal messages of the 7 days before the visit', async () => {
    const dbh = fakeDbh({ messages: [] });
    await customerAskedFacts(VISIT, dbh);
    const where = dbh.calls.find((c) => c[0] === 'messages as m' && c[1] === 'where');
    expect(where[2]).toEqual({ 'c.customer_id': 'cust-1', 'c.channel': 'portal', 'm.channel': 'portal', 'm.direction': 'inbound', 'm.author_type': 'customer', 'm.message_type': 'portal_message' });
    const { since, until } = _test.messageWindow(VISIT, new Date('2026-12-30T00:00:00Z'));
    expect(since.toISOString()).toBe('2026-11-20T05:00:00.000Z'); // ET midnight, 7 days before the visit day
    expect(until.toISOString()).toBe('2026-11-28T05:00:00.000Z'); // end of the visit day
    expect(_test.messageWindow(VISIT, new Date('2026-11-25T12:00:00Z')).until.toISOString()).toBe('2026-11-25T12:00:00.000Z');
  });

  test.each([
    ['a money word', 'How much will it cost?'],
    ['a price sign', 'Is it $50 for the extra spot'],
    ['a refund', 'I want a refund'],
    ['a link', 'see www.example.com please'],
    ['a link with a scheme', 'look at https://example.org/x'],
    ['a run of 3 digits', 'My gate code is 4455'],
    ['an office-only complaint', 'Nobody came today and your tech was rude'],
  ])('a message with %s is left out', async (_name, body) => {
    expect(await customerAskedFacts(VISIT, fakeDbh({ messages: [message(body)] }))).toBeNull();
  });

  test('a message with two digits and no money word stays; an empty body does not', async () => {
    const facts = await customerAskedFacts(VISIT, fakeDbh({ messages: [message('Come at 9 if you can, the dog is out by 10'), message('   ')] }));
    expect(facts.items).toHaveLength(1);
  });

  test('with the portal messages gate off nothing is read', async () => {
    process.env[GATE] = 'false';
    const dbh = fakeDbh({ messages: [message('Please come after noon')] });
    expect(await customerAskedFacts(VISIT, dbh)).toBeNull();
    expect(dbh.calls.filter((c) => c[0] === 'messages as m')).toEqual([]);
  });
});

describe('customerAskedFacts: portal entries rank by their own date', () => {
  test('entries are ranked by the date derived from the request, not the row order, before the cap of five', async () => {
    // Row order (SQL order) puts an older ask first; the revised reschedule note is the newest ask.
    const stale = (n) => formRow({ subject: `Ask ${n}`, description: `Words ${n}`, created_at: `2026-11-0${n}T10:00:00.000Z` });
    const rows = [1, 2, 3, 4, 5].map(stale).concat(formRow({
      subject: 'Reschedule', source: 'customer_portal_reschedule', created_at: '2026-10-01T10:00:00.000Z',
      description: 'Appointment svc-1: Pest Control on 2026-12-01\nCustomer notes: first\nCustomer updated 2026-11-25:\nCustomer notes: moved to Friday',
    }));
    const facts = await customerAskedFacts(SVC, fakeDbh({ rows }));
    expect(facts.items).toHaveLength(MAX_ITEMS - 3);
    expect(facts.items[0]).toMatchObject({ text: 'moved to Friday', appointment: true });
  });

  test('the SQL read order is the creation time (reschedule: its newest update date), never updated_at', () => {
    const { sql } = _test.portalRowsQuery(knexLib({ client: 'pg' }), SVC, null).toSQL();
    expect(sql).toContain("regexp_matches(COALESCE(description, ''), 'Customer updated (\\d{4}-\\d{2}-\\d{2}):', 'g')");
    expect(sql).not.toContain('updated_at');
  });
});

describe('customerAskedFacts: account-wide re-service messages', () => {
  test('the account-wide flag is kept, on the texts that carry it only', async () => {
    mockGather.mockResolvedValue(asks([
      askItem({ id: 'text:1', text: 'Roaches at the rental.', accountWide: true }),
      askItem({ id: 'booking:svc-1', source: 'request_form', text: 'Ants in the kitchen.' }),
    ]));
    const facts = await customerAskedFacts(SVC, fakeDbh());
    expect(facts.items.find((i) => i.kind === 'reservice_words').accountWide).toBe(true);
    expect(facts.items.find((i) => i.kind === 'reservice_reason').accountWide).toBeUndefined();
  });
});

describe('customerAskedFacts: failures and caps', () => {
  test('every read failing omits the key, logs error codes only, and never throws', async () => {
    mockGather.mockRejectedValue(Object.assign(new Error('customer text in message'), { code: 'XX000' }));
    const facts = await customerAskedFacts({ ...SVC, self_booking_id: 'sb-1' }, fakeDbh({ fail: true }));
    expect(facts).toBeNull();
    const logged = logger.warn.mock.calls.map((c) => c[0]).join('\n');
    expect(logged).toContain('XX000');
    expect(logged).toContain('ECONNRESET');
    expect(logged).not.toMatch(/customer text/);
  });

  test('one failed source leaves the others', async () => {
    const facts = await customerAskedFacts({ ...SVC, self_booking_id: 'sb-1', notes: 'Self-booked. Notes: Beware of the dog' }, fakeDbh({ fail: true }));
    expect(facts.items.map((i) => i.kind)).toEqual(['booking_note']);
  });

  test('caps: 8 items, 280 characters each, repeats of one wording collapse', async () => {
    const long = `${'word '.repeat(100)}end`;
    mockGather.mockResolvedValue(asks(Array.from({ length: 10 }, (_, n) => askItem({
      id: `text:${n}`, at: `2026-11-${String(10 + n).padStart(2, '0')}T14:00:00.000Z`, text: n === 9 ? long : `Ants in room ${n}.`,
    }))));
    const rows = [
      formRow({ created_at: '2026-11-01T10:00:00.000Z' }),
      formRow({ created_at: '2026-11-02T10:00:00.000Z' }),
    ];
    const facts = await customerAskedFacts(SVC, fakeDbh({ rows }));
    expect(facts.items).toHaveLength(MAX_ITEMS);
    expect(facts.items[0].text.length).toBeLessThanOrEqual(MAX_TEXT_CHARS);
    expect(facts.items[0].text.endsWith('…')).toBe(true);
    const times = facts.items.map((i) => Date.parse(i.at));
    expect([...times].sort((a, b) => b - a)).toEqual(times);
  });
});
