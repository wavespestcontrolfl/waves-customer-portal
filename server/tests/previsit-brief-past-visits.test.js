/**
 * deterministicVisitFacts().past_visits (services/previsit-brief.js): the customer's
 * newest five completed visits of EVERY service line for the tech Visit Brief
 * (owner 2026-11-26). The list is the portal's own completed-visit history
 * (listPortalServiceHistory, which has its own suites); these tests cover what
 * past_visits adds on top. Synthetic customer and visits only.
 */

jest.mock('../models/db', () => {
  const fn = () => { throw new Error('global db must not be used — dbh is passed explicitly'); };
  fn.transaction = jest.fn();
  return fn;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../services/llm/call', () => ({ dispatchWithFallback: jest.fn() }));
const mockHistory = jest.fn();
jest.mock('../services/portal-service-history', () => ({
  ...jest.requireActual('../services/portal-service-history'),
  listPortalServiceHistory: (...args) => mockHistory(...args),
}));

const { deterministicVisitFacts } = require('../services/previsit-brief');

const SVC = { id: 'svc-now', customer_id: 'cust-1', service_type: 'Pest Control Service', scheduled_date: '2026-11-26', notes: null };

// One portal history row (the reader's own shape) plus what the marks read returns for it.
const visit = (id, date, type, extra = {}) => ({
  id, date, type, notes: null, products: [],
  mark: { is_callback: false, service_data: null, visit_date: date, service_key: null, service_key_snapshot: null },
  ...extra,
});
const withMark = (v, mark) => ({ ...v, mark: { ...v.mark, ...mark } });

// Newest first, as the portal reader returns them.
const VISITS = [
  // A visit dated AFTER the viewed stop (viewing an older stop): never "past".
  visit('r0', '2026-12-01', 'Pest Control Service'),
  // A record of the viewed day (this stop's own, or a sibling's): never past.
  visit('r8', '2026-11-26', 'Lawn Care Treatment'),
  visit('r1', '2026-11-10', 'Lawn Care Treatment', { notes: 'Edged the bed near the gate.', products: [{ product_name: 'Example Herbicide' }] }),
  withMark(visit('r2', '2026-10-20', 'Pest Control Re-Service', {
    notes: 'Ants back at the lanai door.', products: [{ product_name: 'Example Gel Bait' }, { product_name: 'Example Gel Bait' }],
  }), { is_callback: true }),
  visit('r4', '2026-09-01', 'Mosquito Control', { products: [{ product_name: 'Example Barrier' }] }),
  visit('r5', '2026-08-01', 'Pest Control Service'),
  visit('r6', '2026-07-01', 'Lawn Care Treatment'),
  visit('r7', '2026-06-01', 'Pest Control Service'),
];

// Chainable knex stub. Only the marks read ('service_records as sr') returns rows: one per requested id
// that belongs to the requested customer.
function fakeDbh({ visits = VISITS, marksThrow = false, otherCustomerIds = [] } = {}) {
  return (table) => {
    const state = { ids: null, customerId: undefined };
    const q = {};
    for (const m of ['whereNotIn', 'whereRaw', 'orderBy', 'offset', 'limit', 'leftJoin', 'modify']) q[m] = () => q;
    q.where = (arg, val) => { if (arg === 'sr.customer_id') state.customerId = val; return q; };
    q.whereIn = (col, ids) => { if (col === 'sr.id') state.ids = ids; return q; };
    q.select = async () => {
      if (table !== 'service_records as sr') return [];
      if (marksThrow) throw new Error('service_records outage');
      // A predicate the code never sent filters nothing: a dropped customer filter fails a test.
      return visits
        .filter((v) => (state.ids || []).includes(v.id))
        .filter((v) => state.customerId === undefined || !otherCustomerIds.includes(v.id))
        .map((v) => ({ id: v.id, ...v.mark }));
    };
    q.first = async () => undefined;
    return q;
  };
}

const facts = (svc = SVC, opts = {}) => {
  const visits = opts.visits || VISITS;
  mockHistory.mockImplementation(async () => ({ services: visits.map(({ mark, ...row }) => row), total: visits.length }));
  return deterministicVisitFacts(svc, fakeDbh({ ...opts, visits }));
};

beforeEach(() => mockHistory.mockReset());

describe('deterministicVisitFacts past_visits', () => {
  test('reads the portal\'s completed history for this customer on the passed connection', async () => {
    await facts();
    expect(mockHistory).toHaveBeenCalledTimes(1);
    const [customerId, opts] = mockHistory.mock.calls[0];
    expect(customerId).toBe('cust-1');
    expect(opts).toEqual(expect.objectContaining({ completedOnly: true }));
    expect(typeof opts.database).toBe('function');
    expect(opts.limit).toBeGreaterThan(5);
  });

  test('five newest visits across every line; nothing from the viewed day or later', async () => {
    const { past_visits: visits } = await facts();
    expect(visits.map((v) => v.date)).toEqual(['2026-11-10', '2026-10-20', '2026-09-01', '2026-08-01', '2026-07-01']);
  });

  test('an older stop never lists a later visit', async () => {
    const { past_visits: visits } = await facts({ ...SVC, scheduled_date: '2026-10-25' });
    expect(visits.map((v) => v.date)).toEqual(['2026-10-20', '2026-09-01', '2026-08-01', '2026-07-01', '2026-06-01']);
  });

  test('a record of a visit on the viewed day is left out even when it is dated earlier; a record with no visit stays', async () => {
    const visits = [
      // A project completion dated before the scheduled day, linked to a visit of the viewed day.
      withMark(visit('own', '2026-11-20', 'Pest Control Service'), { visit_date: '2026-11-26' }),
      withMark(visit('legacy', '2026-11-15', 'Pest Control Service'), { visit_date: null }),
      ...VISITS,
    ];
    const { past_visits: list } = await facts(SVC, { visits });
    expect(list.map((v) => v.date)).toEqual(['2026-11-15', '2026-11-10', '2026-10-20', '2026-09-01', '2026-08-01']);
  });

  test('a record the customer-scoped marks read does not return is left out', async () => {
    const visits = [visit('other', '2026-11-24', 'Pest Control Service', { notes: 'Another home.' }), ...VISITS];
    const { past_visits: list } = await facts(SVC, { visits, otherCustomerIds: ['other'] });
    expect(JSON.stringify(list)).not.toContain('Another home');
    expect(list).toHaveLength(5);
  });

  test('an unreadable scheduled_date omits the key instead of listing everything', async () => {
    const out = await facts({ ...SVC, scheduled_date: null });
    expect(out).not.toHaveProperty('past_visits');
    expect(mockHistory).not.toHaveBeenCalled();
  });

  test('no earlier visit is an empty list, not a missing key', async () => {
    const out = await facts(SVC, { visits: [visit('r8', '2026-11-26', 'Lawn Care Treatment')] });
    expect(out.past_visits).toEqual([]);
  });

  test('entry shape: date, service name, note, product names once each, free return mark; no money keys', async () => {
    const { past_visits: visits } = await facts();
    expect(visits[0]).toEqual({
      date: '2026-11-10', type: 'Lawn Care Treatment', notes: 'Edged the bed near the gate.', products: [{ name: 'Example Herbicide' }], callback: false,
    });
    expect(visits[1]).toEqual({
      date: '2026-10-20', type: 'Pest Control Re-Service', notes: 'Ants back at the lanai door.', products: [{ name: 'Example Gel Bait' }], callback: true,
    });
    expect(JSON.stringify(visits)).not.toMatch(/price|total|amount|invoice|rate/i);
  });

  test('notes: one line, an access code masked (also split across lines), money removed (also a range)', async () => {
    const visits = [
      visit('a', '2026-11-14', 'Pest Control Service', { notes: 'Treated the garage.\nGate:\n4521' }),
      visit('b', '2026-11-13', 'Pest Control Service', { notes: 'Treated the lanai for ants. Gate code 4471, lockbox 9902.' }),
      visit('c', '2026-11-12', 'Pest Control Service', { notes: 'Quoted $125–150 for repair. Inspection fee: USD 250. Fed both palms.' }),
      visit('d', '2026-11-11', 'Pest Control Service', { notes: null }),
    ];
    const { past_visits: list } = await facts(SVC, { visits });
    expect(list[0].notes).toContain('Treated the garage.');
    expect(list[0].notes).not.toContain('4521');
    expect(list[1].notes).toContain('Treated the lanai for ants.');
    expect(list[1].notes).not.toMatch(/4471|9902/);
    expect(list[2].notes).toContain('Fed both palms.');
    expect(list[2].notes).not.toMatch(/125|150|250|\$/);
    expect(list[3].notes).toBeNull();
  });

  test('a long note gets the day payload\'s word-boundary preview', async () => {
    const visits = [visit('long', '2026-11-14', 'Pest Control Service', { notes: 'word '.repeat(120).trim() })];
    const { past_visits: list } = await facts(SVC, { visits });
    expect(list[0].notes.length).toBeLessThanOrEqual(201);
    expect(list[0].notes.endsWith('…')).toBe(true);
  });

  test('names: prices removed from service and product names; the recorded label is kept; long names that differ at the end both show', async () => {
    const long = 'Example Granular Fertilizer With A Very Long Recorded Name For The Front And Side Lawn Areas Applied At The Label Rate Formula';
    const visits = [
      visit('n1', '2026-11-14', 'Palm Treatment ($125)', {
        products: [
          { product_name: 'Example Potash 0-0-25 ($2.18)' }, { product_name: 'Example Bait (USD 40)' },
          { product_name: `${long} A` }, { product_name: `${long} B` },
        ],
      }),
      visit('n2', '2026-11-13', 'Palm Fertilization (125 dollars)'),
    ];
    const { past_visits: list } = await facts(SVC, { visits });
    expect(JSON.stringify(list)).not.toMatch(/\$|125|2\.18|USD/);
    expect(list[0].type).toBe('Palm Treatment');
    expect(list[0].products.map((p) => p.name)).toEqual(['Example Potash 0-0-25', 'Example Bait', `${long} A`, `${long} B`]);
    expect(list[1].type).toBe('Palm Fertilization');
  });

  test('a visit lists every distinct product name: no cap of eight', async () => {
    const products = Array.from({ length: 9 }, (_, i) => ({ product_name: `Example Product ${i + 1}` }));
    const visits = [visit('p', '2026-11-14', 'Lawn Care Treatment', { products: [...products, products[0]] })];
    const { past_visits: list } = await facts(SVC, { visits });
    expect(list[0].products).toHaveLength(9);
  });

  test('free return mark: a re-service key counts with the record flag off; a rodent follow-up never does', async () => {
    const visits = [
      withMark(visit('c1', '2026-11-20', 'Pest Control Re-Service'), { service_key: 'pest_re_service' }),
      withMark(visit('c2', '2026-11-19', 'Lawn Care Re-Service'), { service_key_snapshot: 'lawn_re_service' }),
      withMark(visit('c3', '2026-11-18', 'Rodent Trapping Follow-up'), { service_key: 'rodent_trapping_followup', is_callback: true }),
      withMark(visit('c4', '2026-11-17', 'Rodent Trapping Follow-up'), { service_key_snapshot: 'rodent_trapping_followup', is_callback: true }),
      visit('c5', '2026-11-16', 'Pest Control Service'),
    ];
    const { past_visits: list } = await facts(SVC, { visits });
    expect(list.map((v) => v.callback)).toEqual([true, true, false, false, false]);
  });

  test('free return mark: the record\'s own frozen key beats the scheduled row\'s current key (object or JSON string)', async () => {
    const visits = [
      withMark(visit('f1', '2026-11-20', 'Pest Control Re-Service'), { service_data: { completedServiceKey: 'pest_re_service' }, service_key: 'pest_quarterly' }),
      withMark(visit('f2', '2026-11-19', 'Pest Control Service'), { service_data: JSON.stringify({ completedServiceKey: 'pest_quarterly' }), service_key: 'pest_re_service' }),
      withMark(visit('f3', '2026-11-18', 'Pest Control Service'), { service_data: '{not json', service_key: 'pest_re_service' }),
      withMark(visit('f4', '2026-11-17', 'Pest Control Service'), { service_data: { other: 1 }, service_key_snapshot: 'lawn_re_service' }),
    ];
    const { past_visits: list } = await facts(SVC, { visits });
    expect(list.map((v) => v.callback)).toEqual([true, false, true, true]);
  });

  test('history read outage: no throw, key omitted, the other facts still answer', async () => {
    mockHistory.mockRejectedValue(new Error('history outage'));
    const out = await deterministicVisitFacts(SVC, fakeDbh());
    expect(out).not.toHaveProperty('past_visits');
    expect(out).toHaveProperty('access');
  });

  test('marks read outage: key omitted rather than an unchecked list', async () => {
    const out = await facts(SVC, { marksThrow: true });
    expect(out).not.toHaveProperty('past_visits');
  });
});
