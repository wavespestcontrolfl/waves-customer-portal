/**
 * The bar's visit-history answers (get_service_history, get_stop_details,
 * get_customer_detail) carry the products, technician and notes a visit's
 * service record really holds. Before the 11-23 fix they read columns that no
 * longer exist and always answered "no products logged". Synthetic names only.
 */
const state = {};
const selects = [];

jest.mock('../models/db', () => {
  function query(table) {
    const preds = [];
    const api = {
      where(a, op, val) {
        if (typeof a === 'function') return api;
        if (typeof a === 'object') Object.entries(a).forEach(([k, v]) => preds.push((r) => r[k] === v));
        else if (val === undefined) preds.push((r) => r[a] === op);
        else if (op === '>=') preds.push((r) => r[a] >= val);
        else preds.push((r) => r[a] === val);
        return api;
      },
      whereIn(col, arr) { preds.push((r) => arr.map(String).includes(String(r[col]))); return api; },
      whereNotIn(col, arr) { preds.push((r) => !arr.includes(r[col])); return api; },
      whereNull(col) { preds.push((r) => r[col] == null); return api; },
      whereILike() { return api; },
      whereRaw() { return api; },
      orderBy() { return api; },
      orderByRaw() { return api; },
      limit() { return api; },
      distinct() { return api; },
      pluck(col) { return api.then((rows) => rows.map((r) => r[col])); },
      leftJoin() { return api; },
      select(cols) { selects.push([table, cols]); return api; },
      first() {
        const m = (state[table] || []).find((r) => preds.every((p) => p(r)));
        return Promise.resolve(m ? { ...m } : undefined);
      },
      then(resolve, reject) {
        return Promise.resolve((state[table] || []).filter((r) => preds.every((p) => p(r)))).then(resolve, reject);
      },
    };
    return api;
  }
  const db = (table) => query(table);
  db.raw = (sql) => ({ __raw: sql });
  return db;
});

const { executeTechTool } = require('../services/intelligence-bar/tech-tools');
const { SERVICE_RECORD_COLUMNS } = require('../services/intelligence-bar/service-record-facts');

beforeEach(() => {
  selects.length = 0;
  Object.assign(state, {
    customers: [{ id: 'cust-1', first_name: 'Robin', last_name: 'Sample' }],
    scheduled_services: [],
    property_preferences: [],
    invoices: [],
    service_records: [
      { id: 'sr-new', customer_id: 'cust-1', status: 'completed', service_date: '2099-10-26', service_type: 'Lawn Care',
        technician_id: 'tech-1', technician_notes: 'Edges treated.', labor_hours: '0.33' },
      { id: 'sr-old', customer_id: 'cust-1', status: 'completed', service_date: '2099-09-11', service_type: 'Lawn Care',
        technician_id: null, technician_notes: null, labor_hours: null },
    ],
    service_products: [
      { service_record_id: 'sr-new', product_name: 'Sample Fertilizer 16-0-8', product_category: 'fertilizer',
        application_rate: '3.000', rate_unit: 'lb/1000sqft', total_amount: '15.000', amount_unit: 'lb' },
      { service_record_id: 'sr-new', product_name: 'Sample Herbicide', product_category: 'herbicide',
        application_rate: null, rate_unit: null, total_amount: null, amount_unit: null },
    ],
    technicians: [{ id: 'tech-1', name: 'Sam Tech' }],
  });
});

describe('get_service_history', () => {
  test('returns the products, technician and notes the record holds', async () => {
    const r = await executeTechTool('get_service_history', { customer_id: 'cust-1' }, {});
    expect(r.services).toHaveLength(2);
    const [latest, older] = r.services;
    expect(latest.tech).toBe('Sam Tech');
    expect(latest.notes).toBe('Edges treated.');
    expect(latest.products).toEqual([
      { name: 'Sample Fertilizer 16-0-8', category: 'fertilizer', rate: '3 lb/1000sqft', amount: '15 lb' },
      { name: 'Sample Herbicide', category: 'herbicide', rate: null, amount: null },
    ]);
    expect(latest.duration).toBe('20 min');
    expect(older).toMatchObject({ tech: null, notes: null, products: [] });
  });

  test('selects only the live service_records columns', async () => {
    await executeTechTool('get_service_history', { customer_id: 'cust-1' }, {});
    const recordSelects = selects.filter(([t]) => t === 'service_records').map(([, c]) => c);
    expect(recordSelects).toEqual([SERVICE_RECORD_COLUMNS]);
  });
});

describe('get_stop_details', () => {
  test('recent history carries products, technician and notes, and selects live columns', async () => {
    const r = await executeTechTool('get_stop_details', { customer_id: 'cust-1' }, {});
    expect(r.error).toBeUndefined();
    expect(r.recent_history[0]).toMatchObject({ tech: 'Sam Tech', notes: 'Edges treated.' });
    expect(r.recent_history[0].products.map((p) => p.name)).toEqual(['Sample Fertilizer 16-0-8', 'Sample Herbicide']);
    const recordSelects = selects.filter(([t]) => t === 'service_records').map(([, c]) => c);
    for (const cols of recordSelects) {
      expect(cols).not.toEqual(expect.arrayContaining(['notes']));
      expect(cols).not.toEqual(expect.arrayContaining(['products_used']));
      expect(cols).not.toEqual(expect.arrayContaining(['technician_name']));
    }
  });
});

describe('a technician login gets no past-visit notes (they can hold access codes)', () => {
  beforeEach(() => {
    state.service_records[0].technician_notes = 'Gate code 4821, lockbox on the side door.';
    // tech-1 is on today's route for this customer, so both reads are authorized.
    const { etDateString } = require('../utils/datetime-et');
    state.scheduled_services = [{ id: 'svc-1', customer_id: 'cust-1', technician_id: 'tech-1', status: 'confirmed', scheduled_date: etDateString(new Date()) }];
  });
  const techLogin = { techId: 'tech-1', techName: 'Sam Tech', techRole: 'technician' };

  test.each(['get_service_history', 'get_stop_details'])('%s withholds notes and keeps products', async (tool) => {
    const r = await executeTechTool(tool, { customer_id: 'cust-1' }, techLogin);
    expect(r.error).toBeUndefined();
    const rows = tool === 'get_service_history' ? r.services : r.recent_history;
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(row).not.toHaveProperty('notes');
    expect(JSON.stringify(r)).not.toContain('4821');
    expect(rows[0].products.map((p) => p.name)).toContain('Sample Fertilizer 16-0-8');
  });

  test('the owner reading through the tech rail still sees the notes', async () => {
    const r = await executeTechTool('get_service_history', { customer_id: 'cust-1' }, { techId: 'tech-1', techRole: 'admin' });
    expect(r.services[0].notes).toMatch(/Gate code/);
  });
});
