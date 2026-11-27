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
const mockTechStopMemberIds = jest.fn();
jest.mock('../services/visit-prep', () => ({ techStopMemberIds: (...a) => mockTechStopMemberIds(...a) }));

const { deterministicVisitFacts } = require('../services/previsit-brief');

const SVC = { id: 'svc-now', customer_id: 'cust-1', service_type: 'Pest Control Service', scheduled_date: '2026-11-26', notes: null };

const rec = (id, date, type, extra = {}) => ({
  id, customer_id: 'cust-1', service_type: type, service_line: null, service_date: date,
  technician_notes: null, is_callback: false, service_key: null, scheduled_service_id: `sched-${id}`, ...extra,
});

// Newest first, mixed lines, so the cap, the stop exclusion and the date bound all matter.
const ROWS = [
  // A visit dated AFTER the viewed stop (viewing an older stop): never "past".
  rec('r0', '2026-12-01', 'Pest Control Service'),
  // Just-completed record of a sibling member on the same grouped stop.
  rec('r8', '2026-11-26', 'Lawn Care Treatment', { scheduled_service_id: 'svc-sib' }),
  rec('r1', '2026-11-10', 'Lawn Care Treatment', { technician_notes: 'Edged the bed near the gate.' }),
  rec('r2', '2026-10-20', 'Pest Control Re-Service', { is_callback: true, technician_notes: 'Ants back at the lanai door.' }),
  rec('r3', '2026-09-30', 'Pest Control Service', { scheduled_service_id: 'svc-now' }),
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
// "not this stop" where-callback, the date bound and the limit to ROWS.
function fakeDbh({ throws = {} } = {}) {
  return (table) => {
    const state = { excludeIds: [], maxDay: null, limit: null };
    const q = {};
    for (const m of ['whereIn', 'whereNotIn', 'orderBy', 'offset', 'leftJoin']) q[m] = () => q;
    q.modify = (fn) => { fn(q); return q; };
    q.where = (arg, op, val) => {
      if (typeof arg === 'function') {
        const r = { whereNull: () => r, orWhereNotIn: (col, ids) => { if (col === 'sr.scheduled_service_id') state.excludeIds = ids.map(String); return r; } };
        arg.call(r);
      } else if (arg === 'sr.service_date' && op === '<=') {
        state.maxDay = val;
      }
      return q;
    };
    q.limit = (n) => { state.limit = n; return q; };
    q.select = async () => {
      if (throws[table]) throw new Error(`${table} outage`);
      if (table === 'service_products as sp') return PRODUCTS;
      if (table !== 'service_records as sr') return [];
      return ROWS
        .filter((r) => !state.excludeIds.includes(String(r.scheduled_service_id)))
        .filter((r) => !state.maxDay || r.service_date <= state.maxDay)
        .slice(0, state.limit ?? ROWS.length);
    };
    q.first = async () => undefined;
    return q;
  };
}

beforeEach(() => { mockTechStopMemberIds.mockReset().mockResolvedValue(['svc-now', 'svc-sib']); });

describe('deterministicVisitFacts past_visits', () => {
  test('five newest completed visits across every line, current visit left out', async () => {
    const facts = await deterministicVisitFacts(SVC, fakeDbh());
    expect(facts.past_visits).toHaveLength(5);
    expect(facts.past_visits.map((v) => v.date)).toEqual(['2026-11-10', '2026-10-20', '2026-09-01', '2026-08-01', '2026-07-01']);
    expect(facts.past_visits.map((v) => v.date)).not.toContain('2026-09-30');
  });

  test('a grouped stop: a sibling member\'s just-completed record is not a past visit', async () => {
    const { past_visits: visits } = await deterministicVisitFacts(SVC, fakeDbh());
    expect(visits.map((v) => v.date)).not.toContain('2026-11-26');
  });

  test('stop lookup outage: the viewed visit itself is still left out, no throw', async () => {
    mockTechStopMemberIds.mockRejectedValue(new Error('stop outage'));
    const { past_visits: visits } = await deterministicVisitFacts(SVC, fakeDbh());
    expect(visits.map((v) => v.date)).not.toContain('2026-09-30');
    // Without the stop lookup the sibling cannot be known: it shows (never a thrown facts read).
    expect(visits).toHaveLength(5);
  });

  test('bounded by the viewed visit day: an older stop never lists a later visit', async () => {
    const { past_visits: visits } = await deterministicVisitFacts({ ...SVC, scheduled_date: '2026-10-25' }, fakeDbh());
    expect(visits.map((v) => v.date)).toEqual(['2026-10-20', '2026-09-01', '2026-08-01', '2026-07-01', '2026-06-01']);
  });

  test('free return mark: a catalog re-service counts with the record flag off; a rodent follow-up never does', async () => {
    const extra = [
      rec('c1', '2026-11-20', 'Pest Control Re-Service', { service_key: 'pest_re_service', is_callback: false }),
      rec('c2', '2026-11-19', 'Lawn Care Re-Service', { service_key: 'lawn_re_service', is_callback: false }),
      rec('c3', '2026-11-18', 'Rodent Trapping Follow-up', { service_key: 'rodent_trapping_followup', is_callback: true }),
      rec('c4', '2026-11-17', 'Pest Control Service', { service_key: 'pest_control', is_callback: false }),
    ];
    ROWS.splice(2, 0, ...extra);
    try {
      const { past_visits: visits } = await deterministicVisitFacts(SVC, fakeDbh());
      expect(Object.fromEntries(visits.map((v) => [v.date, v.callback]))).toMatchObject({
        '2026-11-20': true, '2026-11-19': true, '2026-11-18': false, '2026-11-17': false,
      });
    } finally {
      ROWS.splice(2, extra.length);
    }
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
