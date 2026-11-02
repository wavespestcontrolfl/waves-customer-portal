/**
 * Lawn Soil Test Service (owner 2026-11-02: any customer can order a soil test for an added fee; unpriced for now): the
 * catalog migration (service row + completion profile + taxability) and the four key maps that decide how a soil test
 * visit completes, reports, traces and loads the job card. Synthetic data only.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const catalog = require('../models/migrations/20261102070000_lawn_soil_test_catalog');
const { ALL_LISTS, classifyCatalogRow } = require('../config/completion-lane-registry');
const { normalizeRequirements } = require('../services/service-closeout-requirements');
const { resolveTraceEligibility } = require('../services/service-report/trace-eligibility');
const { selectReportCopyPrompt } = require('../services/service-report/lawn-report-copy-prompt');

const KEY = 'lawn_soil_test';
const NAME = 'Lawn Soil Test Service';

// A small in-memory knex: tables are arrays of rows; just the calls the migration makes.
function fakeKnex(db) {
  const knex = (table) => {
    const filters = [];
    const rowsNow = () => db[table] || [];
    const matches = (r) => filters.every((f) => {
      if (f.in) return f.in.values.includes(r[f.in.col]);
      if (f.lower) return String(r[f.lower.col] || '').toLowerCase() === String(f.lower.val).toLowerCase();
      if (f.like) return JSON.stringify(r[f.like.col] || '').includes(f.like.needle);
      return Object.entries(f).every(([k, v]) => r[k] === v);
    });
    const q = {
      where(cond) { filters.push(cond); return q; },
      whereIn(col, values) { filters.push({ in: { col, values } }); return q; },
      whereRaw(sql, bindings) {
        const lower = /lower\((\w+)\)\s*=\s*lower\(\?\)/.exec(sql);
        if (lower) { filters.push({ lower: { col: lower[1], val: bindings[0] } }); return q; }
        const like = /(\w+)::text LIKE \?/.exec(sql);
        if (like) { filters.push({ like: { col: like[1], needle: String(bindings[0]).replace(/%/g, '') } }); return q; }
        throw new Error(`fake whereRaw: unsupported sql ${sql}`);
      },
      first: async () => { const hit = rowsNow().find(matches); return hit ? { ...hit } : undefined; },
      pluck: async (col) => rowsNow().filter(matches).map((r) => r[col]),
      select: async () => rowsNow().filter(matches).map((r) => ({ ...r })),
      columnInfo: async () => Object.fromEntries((db.__columns[table] || Object.keys(rowsNow()[0] || {})).map((c) => [c, {}])),
      update: async (patch) => { const hits = rowsNow().filter(matches); hits.forEach((r) => Object.assign(r, patch)); return hits.length; },
      del: async () => { const hits = rowsNow().filter(matches); db[table] = rowsNow().filter((r) => !hits.includes(r)); return hits.length; },
      insert: (row) => {
        const stored = { id: `${table}-${rowsNow().length + 1}`, ...row };
        const insertNow = () => { (db[table] = rowsNow()).push(stored); };
        return {
          returning: async (col) => { insertNow(); return [{ [col]: stored[col] }]; },
          then: (resolve, reject) => Promise.resolve().then(insertNow).then(resolve, reject),
        };
      },
    };
    return q;
  };
  knex.fn = { now: () => 'now()' };
  knex.schema = {
    hasTable: async (t) => t in db,
    hasColumn: async (t, c) => t in db && c !== undefined,
  };
  return knex;
}

const emptyDb = () => ({
  __columns: { services: Object.keys({ ...catalog.SERVICE, ...catalog.CLOSEOUT, id: 1, updated_at: 1 }) },
  services: [], service_completion_profiles: [], service_taxability: [], system_settings: [],
  service_records: [], scheduled_services: [], scheduled_service_addons: [], service_addons: [], service_package_items: [],
  discounts: [], leads: [], estimates: [],
});
const svc = (db) => db.services.find((r) => r.service_key === KEY);

describe('20261102070000 lawn soil test catalog row, completion profile and taxability', () => {
  test('up() inserts an UNPRICED one-time lawn row that only staff book (owner "leave it unpiced for now")', async () => {
    const db = emptyDb();
    await catalog.up(fakeKnex(db));
    expect(svc(db)).toMatchObject({
      service_key: KEY, name: NAME, category: 'lawn_care', billing_type: 'one_time', is_active: true, is_archived: false,
      base_price: null, price_range_min: null, price_range_max: null,
      public_quote_selectable: false, booking_enabled: false, customer_visible: true, is_waveguard: false,
      requires_license: false,
    });
    // No estimate engine prices it, so no engine key can stamp it from an estimate.
    expect(svc(db).engine_keys).toBeUndefined();
  });

  test('NO product is applied: the closeout columns are written as read, where the name alone would infer an application', async () => {
    const db = emptyDb();
    await catalog.up(fakeKnex(db));
    expect(normalizeRequirements(svc(db))).toMatchObject({
      requiresServiceReport: true, requiresApplicationLog: false, requiresCustomerNotice: false, requiredPhotoCount: 1,
      requiresCustomerSignature: false, source: 'soil_test_no_application_v1',
    });
    const inferred = normalizeRequirements({ id: 'x', name: NAME, category: 'lawn_care', closeout_requirements_source: 'inferred_v1' });
    expect(inferred).toMatchObject({ requiresApplicationLog: true, requiresCustomerNotice: true });
  });

  test('the completion profile is the generic Service Report, and the registry decides the key as generic by design', async () => {
    const db = emptyDb();
    await catalog.up(fakeKnex(db));
    const profile = db.service_completion_profiles.find((r) => r.service_key === KEY);
    expect(profile).toMatchObject({
      completion_mode: 'service_report', project_type: null, delivery_mode: 'auto_send', creates_service_record: true,
      billing_type: 'one_time', category: 'lawn_care', active: true, followup_policy: 'none',
    });
    expect(profile.notes).toContain(catalog.MARKER);
    expect(ALL_LISTS.one_time_generic_by_design).toContain(KEY);
    expect(classifyCatalogRow({
      service_key: KEY, billing_type: 'one_time', completion_mode: profile.completion_mode, project_type: profile.project_type,
      delivery_mode: profile.delivery_mode, profile_active: true,
    })).toEqual({ lane: 'one_time_generic_by_design', flags: [] });
  });

  test('the taxability row follows the lawn family: residential not taxed, commercial taxed; the label equals the name', async () => {
    const db = emptyDb();
    await catalog.up(fakeKnex(db));
    expect(db.service_taxability.find((r) => r.service_key === KEY)).toMatchObject({
      service_label: NAME, is_taxable: true, tax_category: 'lawn_maintenance', residential_taxable: false,
    });
    expect(svc(db)).toMatchObject({ tax_service_key: 'lawn_care', is_taxable: false });
  });

  test('up() is idempotent and leaves a pre-existing row untouched', async () => {
    const db = emptyDb();
    db.services.push({ id: 'existing', service_key: KEY, name: 'Edited name', is_active: true });
    await catalog.up(fakeKnex(db));
    await catalog.up(fakeKnex(db));
    expect(db.services).toHaveLength(1);
    expect(svc(db).name).toBe('Edited name');
    const again = emptyDb();
    await catalog.up(fakeKnex(again));
    await catalog.up(fakeKnex(again));
    expect(again.services).toHaveLength(1);
    expect(again.service_completion_profiles).toHaveLength(1);
    expect(again.service_taxability).toHaveLength(1);
  });

  test('down() removes exactly what up() inserted when nothing references the service', async () => {
    const db = emptyDb();
    const knex = fakeKnex(db);
    await catalog.up(knex);
    await catalog.down(knex);
    expect(db.services).toHaveLength(0);
    expect(db.service_completion_profiles).toHaveLength(0);
    expect(db.service_taxability).toHaveLength(0);
    expect(db.system_settings).toHaveLength(0);
  });

  test.each([
    ['a scheduled visit by service_id', (db, id) => db.scheduled_services.push({ id: 'v1', service_id: id })],
    ['a scheduled add-on row', (db, id) => db.scheduled_service_addons.push({ id: 'a1', service_id: id })],
    ['a scheduled visit by label', (db) => db.scheduled_services.push({ id: 'v2', service_type: NAME.toUpperCase() })],
    ['a service record', (db, id) => db.service_records.push({ id: 'r1', service_id: id })],
  ])('down() keeps and deactivates the row when %s references it', async (_label, addRef) => {
    const db = emptyDb();
    const knex = fakeKnex(db);
    await catalog.up(knex);
    addRef(db, svc(db).id);
    await catalog.down(knex);
    expect(svc(db)).toMatchObject({ is_active: false });
    expect(db.service_completion_profiles).toHaveLength(1);
    expect(db.service_taxability).toHaveLength(1);
  });

  test('down() never deletes an operator-edited profile (insertion marker gone)', async () => {
    const db = emptyDb();
    const knex = fakeKnex(db);
    await catalog.up(knex);
    db.service_completion_profiles[0].notes = 'office edited';
    await catalog.down(knex);
    expect(db.service_completion_profiles).toHaveLength(1);
  });
});

describe('a soil test visit: report writer and trace (the job card case is in job-card-service.test.js)', () => {
  test('the report writer is the assessment module, which never reports a sample as a finished lab result', () => {
    const shared = '# Shared writer\nDescribe the rating in words only; never quote the number.';
    const prompt = selectReportCopyPrompt(shared, NAME, { serviceKey: KEY, findingsType: null });
    expect(prompt).toContain('SERVICE MODULE — ASSESSMENT / INSPECTION ONLY');
    expect(prompt).toContain('Do not present a quote as approval, a sample as a completed laboratory result');
  });

  test('no coverage trace: nothing is applied on a soil test', () => {
    expect(resolveTraceEligibility({ serviceKey: KEY })).toMatchObject({ eligible: false, reason: 'inspection_lane' });
  });
});
