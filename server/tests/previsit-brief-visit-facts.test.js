/**
 * deterministicVisitFacts (services/previsit-brief.js) — the zero-LLM facts
 * block the visit-brief route serves alongside { brief: null } when
 * GATE_VISIT_FACTS is on:
 *  - access block copied from property_preferences (codes/pets/notes) via
 *    the real buildAccessBlock/compilePropertyAlerts pair
 *  - last same-line visit + deduped products
 *  - FAIL-SOFT everywhere: a prefs or product-history outage degrades the
 *    section instead of throwing (unlike brief GENERATION, which is
 *    strict-fail to protect the cached artifact)
 */

jest.mock('../models/db', () => {
  const fn = () => { throw new Error('global db must not be used — dbh is passed explicitly'); };
  fn.transaction = jest.fn();
  return fn;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../config/models', () => ({
  TEXT_POLICIES: { visitBrief: { name: 'visitBrief' } },
}));
jest.mock('../services/llm/call', () => ({
  dispatchWithFallback: jest.fn(),
}));

const { deterministicVisitFacts } = require('../services/previsit-brief');

const SVC = {
  id: 'svc-1',
  customer_id: 'cust-1',
  service_type: 'Pest Control Service',
  scheduled_date: '2026-08-13',
  notes: null,
};

const PREFS_ROW = {
  customer_id: 'cust-1',
  neighborhood_gate_code: '9911',
  property_gate_code: null,
  garage_code: null,
  lockbox_code: null,
  pet_count: 2,
  pet_details: 'Two dogs in the back yard',
  chemical_sensitivities: false,
};

const RECORD_ROWS = [
  { id: 'rec-1', customer_id: 'cust-1', service_type: 'Pest Control Service', service_line: 'pest', service_date: '2026-07-14', technician_notes: 'Ant trail at garage' },
  { id: 'rec-2', customer_id: 'cust-1', service_type: 'Pest Control Service', service_line: 'pest', service_date: '2026-06-12', technician_notes: null },
];

const PRODUCT_ROWS = [
  { service_record_id: 'rec-1', product_name: 'Talstar P', active_ingredient: 'Bifenthrin', targets: [] },
  // Duplicate name — the dedupe cap must collapse it.
  { service_record_id: 'rec-1', product_name: 'Talstar P', active_ingredient: 'Bifenthrin', targets: [] },
  { service_record_id: 'rec-1', product_name: 'Taurus SC', active_ingredient: 'Fipronil', targets: [] },
];

// Chainable knex stub: every builder method returns the chain; the
// terminal reads (`select` awaited on service_records / service_products,
// `first` on property_preferences) resolve from the per-table fixtures.
// Per-table `throws` turns a read into an outage.
function fakeDbh({ prefs = PREFS_ROW, records = RECORD_ROWS, products = PRODUCT_ROWS, throws = {} } = {}) {
  return (table) => {
    const q = {};
    for (const m of ['where', 'whereIn', 'whereNotIn', 'orderBy', 'offset', 'limit', 'leftJoin', 'modify']) {
      q[m] = () => q;
    }
    q.select = async () => {
      if (throws[table]) throw new Error(`${table} outage`);
      if (table === 'service_records') return records;
      if (table === 'service_products as sp') return products;
      return [];
    };
    q.first = async () => {
      if (throws[table]) throw new Error(`${table} outage`);
      if (table === 'property_preferences') return prefs;
      return undefined;
    };
    return q;
  };
}

describe('deterministicVisitFacts', () => {
  test('full path: access codes + pets + last same-line visit with deduped products', async () => {
    const facts = await deterministicVisitFacts(SVC, fakeDbh());
    expect(facts.access.codes.neighborhoodGate).toBe('9911');
    expect(facts.access.codes.propertyGate).toBeNull();
    expect(facts.access.pets).toBe('Two dogs in the back yard');
    expect(Array.isArray(facts.access.alerts)).toBe(true);
    expect(facts.last_visit.date).toBe('2026-07-14');
    expect(facts.last_visit.type).toBe('Pest Control Service');
    // rec-1's rows only, duplicate name collapsed.
    expect(facts.last_visit.products.map((p) => p.name)).toEqual(['Talstar P', 'Taurus SC']);
  });

  test('no prefs + no history: null codes, no last_visit (first-visit claim only when history readable)', async () => {
    const facts = await deterministicVisitFacts(SVC, fakeDbh({ prefs: null, records: [] }));
    expect(facts.access.codes).toEqual({ neighborhoodGate: null, propertyGate: null, garage: null, lockbox: null });
    expect(facts.access.pets).toBeNull();
    expect(facts.last_visit).toBeNull();
  });

  test('property_preferences outage is fail-soft: facts still answer without codes', async () => {
    const facts = await deterministicVisitFacts(SVC, fakeDbh({ throws: { property_preferences: true } }));
    expect(facts.access.codes.neighborhoodGate).toBeNull();
    expect(facts.last_visit.date).toBe('2026-07-14');
  });

  test('service-history outage is fail-soft: no last_visit, no first-visit assertion', async () => {
    const facts = await deterministicVisitFacts(SVC, fakeDbh({ throws: { service_records: true } }));
    expect(facts.access.codes.neighborhoodGate).toBe('9911');
    expect(facts.last_visit).toBeNull();
  });

  test('product-history outage is fail-soft: last_visit stands with empty products', async () => {
    const facts = await deterministicVisitFacts(SVC, fakeDbh({ throws: { 'service_products as sp': true } }));
    expect(facts.last_visit.date).toBe('2026-07-14');
    expect(facts.last_visit.products).toEqual([]);
  });

  test('history is line-scoped: another line\'s records never become this visit\'s last_visit', async () => {
    const facts = await deterministicVisitFacts(SVC, fakeDbh({
      records: [
        { id: 'rec-9', customer_id: 'cust-1', service_type: 'Lawn Care Service', service_line: 'lawn', service_date: '2026-07-20', technician_notes: null },
      ],
      products: [],
    }));
    expect(facts.last_visit).toBeNull();
  });
});
