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
function fakeDbh({ rows = [], booking, props = [], fail = false } = {}) {
  const calls = [];
  const dbh = (table) => {
    calls.push(['table', table]);
    const q = {};
    for (const m of ['where', 'whereIn', 'whereRaw', 'orderBy', 'orderByRaw', 'limit']) {
      q[m] = (...args) => { calls.push([table, m, ...args]); if (m === 'where' && args[0]?.id) q.id = args[0].id; return q; };
    }
    q.select = async () => {
      if (fail) throw Object.assign(new Error('boom with customer text'), { code: 'ECONNRESET' });
      return table === 'customer_properties' ? props : rows;
    };
    q.first = async () => {
      if (fail) throw Object.assign(new Error('boom with customer text'), { code: 'ECONNRESET' });
      if (table === 'customer_properties') return props.find((p) => p.id === q.id) || undefined;
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
    const svc = { ...SVC, notes: 'Self-booked. Notes: Please text before you arrive — Unit: 5' };
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
    const facts = await customerAskedFacts({ ...SVC, notes: 'Self-booked. Notes: Gate is open' }, fakeDbh());
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
    const svc = { ...SVC, notes: 'Self-booked. Notes: Side gate sticks.\nPlease text first. — Unit: 5' };
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
    expect(sql).toMatch(/order by GREATEST\(created_at, COALESCE\(updated_at, created_at\)\) DESC limit \?/);
    expect(sql).toMatch(/select "subject", "description", "source", "created_at" from/);
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
    beforeEach(() => mockSingle.mockResolvedValue(false));

    test('a visit with no stamp, property or estimate is on the primary property', async () => {
      expect(await _test.visitPropertyIds(SVC, fakeDbh({ props: [HOME, RENTAL] }))).toEqual(['prop-1']);
    });

    test('a stamped service address resolves to the property it matches, even with no property_id', async () => {
      const svc = { ...SVC, service_address_line1: '200 Sample St', service_address_city: 'Parrish', service_address_zip: '34219' };
      expect(await _test.visitPropertyIds(svc, fakeDbh({ props: [HOME, RENTAL] }))).toEqual(['prop-2']);
    });

    test("a visit's property_id resolves through that property's current address", async () => {
      expect(await _test.visitPropertyIds({ ...SVC, property_id: 'prop-2' }, fakeDbh({ props: [HOME, { ...RENTAL, id: 'prop-2' }] }))).toEqual(['prop-2']);
    });

    test('a stamp that matches no property, or an unreadable read, withholds', async () => {
      const stray = { ...SVC, service_address_line1: '300 Nowhere Rd', service_address_city: 'Sarasota', service_address_zip: '34236' };
      expect(await _test.visitPropertyIds(stray, fakeDbh({ props: [HOME, RENTAL] }))).toEqual([]);
      expect(await _test.visitPropertyIds(SVC, fakeDbh({ fail: true }))).toEqual([]);
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
    const facts = await customerAskedFacts({ ...SVC, notes: 'Self-booked. Notes: Beware of the dog' }, fakeDbh({ fail: true }));
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
