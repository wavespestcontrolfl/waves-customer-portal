/**
 * deterministicVisitFacts().past_visits (services/previsit-brief.js): the customer's
 * newest five completed visits of EVERY service line for the tech Visit Brief
 * (owner 2026-11-26). Synthetic customer and visits only.
 */

jest.mock('../models/db', () => {
  const fn = () => { throw new Error('global db must not be used — dbh is passed explicitly'); };
  fn.transaction = jest.fn();
  return fn;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../services/llm/call', () => ({ dispatchWithFallback: jest.fn() }));

const { deterministicVisitFacts } = require('../services/previsit-brief');

const SVC = { id: 'svc-now', customer_id: 'cust-1', service_type: 'Pest Control Service', scheduled_date: '2026-11-26', notes: null };

const rec = (id, date, type, extra = {}) => ({
  id, customer_id: 'cust-1', service_type: type, service_line: null, service_date: date,
  status: 'completed', technician_notes: null, is_callback: false, service_key: null, service_key_snapshot: null, service_data: null, scheduled_service_id: `sched-${id}`, ...extra,
});

// Newest first, mixed lines, so the cap and the strictly-before rule matter.
const ROWS = [
  // A visit dated AFTER the viewed stop (viewing an older stop): never "past".
  rec('r0', '2026-12-01', 'Pest Control Service'),
  // Just-completed record of a sibling member on the same grouped stop.
  rec('r8', '2026-11-26', 'Lawn Care Treatment', { scheduled_service_id: 'svc-sib' }),
  rec('r1', '2026-11-10', 'Lawn Care Treatment', { technician_notes: 'Edged the bed near the gate.' }),
  rec('r2', '2026-10-20', 'Pest Control Re-Service', { is_callback: true, technician_notes: 'Ants back at the lanai door.' }),
  // The viewed visit's own record, dated the viewed day: never past.
  rec('r3', '2026-11-26', 'Pest Control Service', { scheduled_service_id: 'svc-now' }),
  rec('r4', '2026-09-01', 'Mosquito Control'),
  rec('r5', '2026-08-01', 'Pest Control Service'),
  rec('r6', '2026-07-01', 'Lawn Care Treatment'),
  rec('r7', '2026-06-01', 'Pest Control Service'),
];

const PRODUCTS = [
  { service_record_id: 'r1', product_name: 'Example Herbicide', active_ingredient: 'x', targets: [], application_rate: 4, rate_unit: 'oz' },
  { service_record_id: 'r2', product_name: 'Example Gel Bait', targets: [] },
  { service_record_id: 'r2', product_name: 'Example Gel Bait', targets: [] },
  { service_record_id: 'r4', product_name: 'Example Barrier', targets: [] },
];

// Chainable knex stub. The past-visits read is the 'service_records as sr' select: it applies the
// strictly-before date bound and the limit to ROWS.
function fakeDbh({ throws = {}, rows = ROWS } = {}) {
  return (table) => {
    const state = { beforeDay: null, limit: null, notVisit: undefined, customerId: undefined, status: undefined };
    const q = {};
    for (const m of ['whereIn', 'whereNotIn', 'orderBy', 'offset', 'leftJoin', 'modify']) q[m] = () => q;
    q.where = (arg, op, val) => {
      if (arg === 'sr.service_date' && op === '<') state.beforeDay = val;
      if (arg && typeof arg === 'object') {
        if ('sr.customer_id' in arg) state.customerId = arg['sr.customer_id'];
        if ('sr.status' in arg) state.status = arg['sr.status'];
      }
      return q;
    };
    q.whereRaw = (sql, bindings) => {
      // The viewed day's visits of this customer (the stub's scheduled_services): the viewed one and a sibling.
      if (/NOT IN \(\s*SELECT vd\.id FROM scheduled_services vd/.test(sql) && bindings[0] === 'cust-1') state.notVisit = ['svc-now', 'svc-sib'];
      return q;
    };
    q.limit = (n) => { state.limit = n; return q; };
    q.select = async () => {
      if (throws[table]) throw new Error(`${table} outage`);
      if (table === 'service_products as sp') return PRODUCTS;
      if (table !== 'service_records as sr') return [];
      // No bound given = every row: a test fails if the code ever drops the bound.
      // A predicate the code never sent filters nothing: a dropped customer or status filter fails a test.
      return rows
        .filter((r) => state.customerId === undefined || r.customer_id === state.customerId)
        .filter((r) => state.status === undefined || r.status === state.status)
        .filter((r) => !state.beforeDay || r.service_date < state.beforeDay)
        .filter((r) => state.notVisit === undefined || !state.notVisit.includes(r.scheduled_service_id))
        .slice(0, state.limit ?? rows.length);
    };
    q.first = async () => undefined;
    return q;
  };
}

describe('deterministicVisitFacts past_visits', () => {
  test('five newest completed visits across every line, current visit left out', async () => {
    const facts = await deterministicVisitFacts(SVC, fakeDbh());
    expect(facts.past_visits).toHaveLength(5);
    expect(facts.past_visits.map((v) => v.date)).toEqual(['2026-11-10', '2026-10-20', '2026-09-01', '2026-08-01', '2026-07-01']);
    expect(facts.past_visits.map((v) => v.date)).not.toContain('2026-09-30');
  });

  test('nothing from the viewed day is listed: the stop\'s own records and a sibling\'s just-completed one stay out', async () => {
    const { past_visits: visits } = await deterministicVisitFacts(SVC, fakeDbh());
    expect(visits.map((v) => v.date)).not.toContain('2026-11-26');
  });

  test('records of the viewed day\'s visits are left out even when dated earlier (own and a sibling); a record with no schedule link stays', async () => {
    const rows = [
      rec('own', '2026-11-20', 'Pest Control Service', { scheduled_service_id: 'svc-now' }),
      rec('sib', '2026-11-19', 'Lawn Care Treatment', { scheduled_service_id: 'svc-sib' }),
      rec('legacy', '2026-11-15', 'Pest Control Service', { scheduled_service_id: null }),
      ...ROWS,
    ];
    const { past_visits: visits } = await deterministicVisitFacts(SVC, fakeDbh({ rows }));
    expect(visits.map((v) => v.date)).toEqual(['2026-11-15', '2026-11-10', '2026-10-20', '2026-09-01', '2026-08-01']);
  });

  test('another customer\'s record and an unfinished record are never listed', async () => {
    const rows = [
      rec('other', '2026-11-24', 'Pest Control Service', { customer_id: 'cust-2', technician_notes: 'Another home.' }),
      rec('draft', '2026-11-23', 'Pest Control Service', { status: 'in_progress' }),
      ...ROWS,
    ];
    const { past_visits: visits } = await deterministicVisitFacts(SVC, fakeDbh({ rows }));
    expect(visits.map((v) => v.date)).toEqual(['2026-11-10', '2026-10-20', '2026-09-01', '2026-08-01', '2026-07-01']);
    expect(JSON.stringify(visits)).not.toContain('Another home');
  });

  test('an older stop never lists a later visit', async () => {
    const { past_visits: visits } = await deterministicVisitFacts({ ...SVC, scheduled_date: '2026-10-25' }, fakeDbh());
    expect(visits.map((v) => v.date)).toEqual(['2026-10-20', '2026-09-01', '2026-08-01', '2026-07-01', '2026-06-01']);
  });

  test('an unreadable scheduled_date omits the key instead of listing everything', async () => {
    const facts = await deterministicVisitFacts({ ...SVC, scheduled_date: null }, fakeDbh());
    expect(facts).not.toHaveProperty('past_visits');
  });

  test('free return mark: catalog or saved key re-service counts with the record flag off; a rodent follow-up never does', async () => {
    const extra = [
      rec('c1', '2026-11-20', 'Pest Control Re-Service', { service_key: 'pest_re_service', is_callback: false }),
      rec('c2', '2026-11-19', 'Lawn Care Re-Service', { service_key: 'lawn_re_service', is_callback: false }),
      rec('c3', '2026-11-18', 'Rodent Trapping Follow-up', { service_key: 'rodent_trapping_followup', is_callback: true }),
      rec('c4', '2026-11-17', 'Pest Control Service', { service_key: 'pest_control', is_callback: false }),
      // No catalog link (null service_id): the visit's saved key decides.
      rec('c5', '2026-11-16', 'Pest Control Re-Service', { service_key: null, service_key_snapshot: 'pest_re_service', is_callback: false }),
      rec('c6', '2026-11-15', 'Rodent Trapping Follow-up', { service_key: null, service_key_snapshot: 'rodent_trapping_followup', is_callback: true }),
    ];
    const { past_visits: visits } = await deterministicVisitFacts(SVC, fakeDbh({ rows: extra.slice(0, 5) }));
    const more = await deterministicVisitFacts(SVC, fakeDbh({ rows: extra.slice(5) }));
    const byDate = Object.fromEntries([...visits, ...more.past_visits].map((v) => [v.date, v.callback]));
    expect(byDate).toEqual({
      '2026-11-20': true, '2026-11-19': true, '2026-11-18': false, '2026-11-17': false, '2026-11-16': true, '2026-11-15': false,
    });
  });

  test('free return mark: the record\'s own frozen key beats the scheduled row\'s current key (object or JSON string)', async () => {
    const rows = [
      rec('f1', '2026-11-20', 'Pest Control Re-Service', { service_data: { completedServiceKey: 'pest_re_service' }, service_key: 'pest_control' }),
      rec('f2', '2026-11-19', 'Pest Control Service', { service_data: JSON.stringify({ completedServiceKey: 'pest_control' }), service_key: 'pest_re_service', is_callback: false }),
      rec('f3', '2026-11-18', 'Lawn Care Re-Service', { service_data: '{not json', service_key: 'lawn_re_service' }),
      rec('f4', '2026-11-17', 'Pest Control Service', { service_data: { other: 1 }, service_key_snapshot: 'pest_re_service' }),
    ];
    const { past_visits: visits } = await deterministicVisitFacts(SVC, fakeDbh({ rows }));
    expect(Object.fromEntries(visits.map((v) => [v.date, v.callback]))).toEqual({
      '2026-11-20': true, '2026-11-19': false, '2026-11-18': true, '2026-11-17': true,
    });
  });

  test('a past visit lists every distinct product name: no cap of eight', async () => {
    const names = Array.from({ length: 9 }, (_, i) => `Example Product ${i + 1}`);
    const products = [...names, names[0]].map((product_name) => ({ service_record_id: 'p1', product_name, targets: [] }));
    const dbh = (table) => {
      const q = fakeDbh({ rows: [rec('p1', '2026-11-10', 'Pest Control Service')] })(table);
      if (table === 'service_products as sp') q.select = async () => products;
      return q;
    };
    const { past_visits: visits } = await deterministicVisitFacts(SVC, dbh);
    expect(visits[0].products.map((p) => p.name)).toEqual(names);
  });

  test('entry shape: service name, the day note, product names, free return visit mark', async () => {
    const { past_visits: visits } = await deterministicVisitFacts(SVC, fakeDbh());
    expect(visits[0]).toEqual({ date: '2026-11-10', type: expect.any(String), notes: 'Edged the bed near the gate.', products: [{ name: 'Example Herbicide' }], callback: false });
    expect(visits[1].callback).toBe(true);
    expect(visits[1].notes).toBe('Ants back at the lanai door.');
    // Duplicate product name collapses.
    expect(visits[1].products).toEqual([{ name: 'Example Gel Bait' }]);
    expect(visits[2].products).toEqual([{ name: 'Example Barrier' }]);
    expect(visits[3].notes).toBeNull();
    expect(visits[3].callback).toBe(false);
  });

  test('a long note gets the same word-boundary preview as the day payload', async () => {
    const dbh = fakeDbh();
    const r1 = ROWS.find((r) => r.id === 'r1');
    r1.technician_notes = `${'word '.repeat(80)}end`;
    try {
      const { past_visits: visits } = await deterministicVisitFacts(SVC, dbh);
      expect(visits[0].notes.length).toBeLessThanOrEqual(201);
      expect(visits[0].notes.endsWith('…')).toBe(true);
    } finally {
      r1.technician_notes = 'Edged the bed near the gate.';
    }
  });

  test('no money keys on any entry', async () => {
    const { past_visits: visits } = await deterministicVisitFacts(SVC, fakeDbh());
    for (const v of visits) {
      expect(Object.keys(v).sort()).toEqual(['callback', 'date', 'notes', 'products', 'type']);
      for (const p of v.products) expect(Object.keys(p)).toEqual(['name']);
    }
    expect(JSON.stringify(visits)).not.toMatch(/price|amount|total|rate|invoice|\$/i);
  });

  test('history read outage: no throw, key omitted, history_unavailable still set', async () => {
    const facts = await deterministicVisitFacts(SVC, fakeDbh({ throws: { service_records: true, 'service_records as sr': true } }));
    expect(facts).not.toHaveProperty('past_visits');
    expect(facts.history_unavailable).toBe(true);
  });

  test('product read outage: visits stay, names empty', async () => {
    const { past_visits: visits } = await deterministicVisitFacts(SVC, fakeDbh({ throws: { 'service_products as sp': true } }));
    expect(visits).toHaveLength(5);
    expect(visits.every((v) => v.products.length === 0)).toBe(true);
  });
});
