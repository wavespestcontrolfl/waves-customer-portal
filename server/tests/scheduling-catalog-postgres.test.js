/** Real catalog row-lock proofs in a synthetic, private schema. */
let mockPg;
jest.mock('../models/db', () => {
  const db = (...args) => mockPg(...args);
  db.raw = (...args) => mockPg.raw(...args);
  db.transaction = (...args) => mockPg.transaction(...args);
  Object.defineProperty(db, 'fn', { get: () => mockPg.fn });
  return db;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const knex = require('knex');
const { randomUUID } = require('node:crypto');
const { catalogLinkForProfile } = require('../services/slot-reservation');
const { resolveCatalogSlotProfile } = require('../services/estimate-slot-availability');
const connection = process.env.SCHEDULING_CAPACITY_TEST_DATABASE_URL;
const describeDb = connection ? describe : describe.skip;
const schema = `scheduling_catalog_${randomUUID().replaceAll('-', '')}`;
const ids = { exact: randomUUID(), cadence: randomUUID(), containment: randomUUID() };
let admin;
jest.setTimeout(30000);

const branches = [
  ['exact catalog key', 'exact', { serviceMode: 'one_time', services: [{ service: 'pest_control',
    engineKey: 'unmapped_exact', catalogServiceKey: 'fixture_catalog_exact' }] }],
  ['cadence key', 'cadence', { serviceMode: 'recurring', services: [{ service: 'pest_control',
    visitsPerYear: 4 }] }],
  ['engine containment', 'containment', { serviceMode: 'one_time', services: [{ service: 'pest_control',
    engineKey: 'fixture_specialty' }] }],
];

const strictBranches = [
  ['exact catalog key', 'exact', { estimate_data: { result: { oneTime: { items: [{ service: 'unmapped_exact',
    label: 'Exact fixture', price: 100, catalogServiceKey: 'fixture_catalog_exact' }] } } } }, { serviceMode: 'one_time' }],
  ['cadence key', 'cadence', { estimate_data: { result: { recurring: { services:
    [{ service: 'pest_control', name: 'Pest control', visitsPerYear: 4 }] } } } }, {}],
  ['engine containment', 'containment', { estimate_data: { result: { oneTime: { items: [{ service: 'fixture_specialty',
    label: 'Containment fixture', price: 100 }] } } } }, { serviceMode: 'one_time' }],
];

describeDb('scheduling catalog locks on PostgreSQL', () => {
  beforeAll(async () => {
    const target = new URL(connection);
    const localCi = process.env.CI === 'true' && process.env.NODE_ENV === 'test'
      && ['localhost', '127.0.0.1'].includes(target.hostname) && target.pathname === '/waves_test';
    if (!localCi && !/^\/waves_qa_[a-f0-9]{32}$/.test(target.pathname)) {
      throw new Error('Use a verified nonproduction, task-private QA database');
    }
    admin = knex({ client: 'pg', connection, pool: { min: 0, max: 1 } });
    await admin.schema.createSchema(schema);
    mockPg = knex({ client: 'pg', connection: { connectionString: connection, application_name: schema },
      searchPath: [schema], pool: { min: 0, max: 5 } });
    await mockPg.raw('CREATE TABLE ?? (LIKE public.?? INCLUDING ALL)', ['services', 'services']);
  });

  afterAll(async () => {
    delete process.env.GATE_SCHEDULING_CAPACITY;
    if (mockPg) await mockPg.destroy();
    if (admin) { await admin.schema.dropSchemaIfExists(schema, true); await admin.destroy(); }
  });

  beforeEach(async () => {
    process.env.GATE_SCHEDULING_CAPACITY = 'true';
    await mockPg('services').del();
    await mockPg('services').insert([
      { id: ids.exact, service_key: 'fixture_catalog_exact', name: 'Exact fixture', category: 'pest',
        billing_type: 'one_time', is_active: true, engine_keys: JSON.stringify([]), default_duration_minutes: 30,
        scheduling_duration_policy: { version: 1, default_duration_minutes: 30, min_duration_minutes: 30, max_duration_minutes: 90 } },
      { id: ids.cadence, service_key: 'pest_general_quarterly', name: 'Cadence fixture', category: 'pest',
        billing_type: 'recurring', is_active: true, engine_keys: JSON.stringify(['pest_control']), default_duration_minutes: 30,
        scheduling_duration_policy: { version: 1, default_duration_minutes: 30, min_duration_minutes: 30, max_duration_minutes: 90 } },
      { id: ids.containment, service_key: 'fixture_specialty_service', name: 'Containment fixture', category: 'pest',
        billing_type: 'one_time', is_active: true, engine_keys: JSON.stringify(['fixture_specialty']), default_duration_minutes: 30,
        scheduling_duration_policy: { version: 1, default_duration_minutes: 30, min_duration_minutes: 30, max_duration_minutes: 90 } },
    ]);
  });

  async function waitForBlockedBy(pid) {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const result = await admin.raw(
        'SELECT 1 FROM pg_stat_activity WHERE application_name = ? AND ?::int = ANY(pg_blocking_pids(pid))',
        [schema, pid],
      );
      if (result.rows.length) return;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    throw new Error('Catalog update never waited for the shared row lock');
  }

  test.each(branches)('%s lock survives its savepoint until outer commit', async (_label, key, profile) => {
    const scheduling = await mockPg.transaction();
    let edit;
    try {
      const { rows: [{ pid }] } = await scheduling.raw('SELECT pg_backend_pid()::int AS pid');
      expect(await catalogLinkForProfile(scheduling, profile)).toMatchObject({ id: ids[key] });
      edit = mockPg('services').where({ id: ids[key] }).update({ default_duration_minutes: 31 }).then(value => value);
      await waitForBlockedBy(pid);
      await scheduling.commit();
      expect(await edit).toBe(1);
    } finally {
      if (!scheduling.isCompleted()) await scheduling.rollback();
      if (edit) await edit.catch(() => {});
    }
  });

  test('editor-first change supplies the preserved allowance after gate shutdown', async () => {
    delete process.env.GATE_SCHEDULING_CAPACITY;
    const editor = await mockPg.transaction();
    let resolving;
    try {
      const { rows: [{ pid }] } = await editor.raw('SELECT pg_backend_pid()::int AS pid');
      await editor('services').where({ id: ids.cadence }).forUpdate().first();
      await editor('services').where({ id: ids.cadence }).update({ scheduling_duration_policy:
        { version: 1, default_duration_minutes: 75, min_duration_minutes: 30, max_duration_minutes: 90 } });
      const estimate = { estimate_data: { result: { recurring: { services:
        [{ service: 'pest_control', name: 'Pest control', visitsPerYear: 4 }] } } } };
      resolving = mockPg.transaction(trx => resolveCatalogSlotProfile(
        estimate, { preserveCapacity: true }, trx,
      ));
      await waitForBlockedBy(pid);
      await editor.commit();
      expect(await resolving).toMatchObject({ durationMinutes: 75,
        services: [expect.objectContaining({ service: 'pest_control', durationMinutes: 75 })] });
    } finally {
      if (!editor.isCompleted()) await editor.rollback();
      if (resolving) await resolving.catch(() => {});
    }
  });

  test.each(strictBranches)('%s strict allowance timeout is recoverable and preserves the outer transaction', async (
    _label, key, estimate, profileOptions,
  ) => {
    delete process.env.GATE_SCHEDULING_CAPACITY;
    const editor = await mockPg.transaction();
    const scheduling = await mockPg.transaction();
    try {
      await editor('services').where({ id: ids[key] }).forUpdate().first();
      await scheduling.raw("SET LOCAL lock_timeout = '100ms'");

      await expect(resolveCatalogSlotProfile(
        estimate, { ...profileOptions, preserveCapacity: true }, scheduling,
      )).rejects.toMatchObject({
        code: 'SLOT_UNAVAILABLE', reason: 'catalog_unavailable', status: 409, statusCode: 409, isOperational: true,
      });
      await expect(scheduling.raw('SELECT 1 AS healthy')).resolves.toMatchObject({ rows: [{ healthy: 1 }] });
    } finally {
      if (!scheduling.isCompleted()) await scheduling.rollback();
      if (!editor.isCompleted()) await editor.rollback();
    }
  });

  test.each(strictBranches)('%s cannot stamp a newly matched identity into its fallback allowance', async (
    _label, key, estimate, profileOptions,
  ) => {
    const original = await mockPg('services').where({ id: ids[key] }).first();
    if (key === 'exact') await mockPg('services').where({ id: ids[key] }).del();
    else if (key === 'cadence') await mockPg('services').where({ id: ids[key] }).update({ is_active: false });
    else await mockPg('services').where({ id: ids[key] }).update({ engine_keys: JSON.stringify([]) });
    delete process.env.GATE_SCHEDULING_CAPACITY;
    const scheduling = await mockPg.transaction();
    try {
      const profile = await resolveCatalogSlotProfile(estimate, { ...profileOptions, preserveCapacity: true }, scheduling);
      expect(profile.durationMinutes).toBe(60);
      // An unchanged missing identity still permits the intentional fallback.
      expect(await catalogLinkForProfile(scheduling, profile, {
        preserveCapacity: true, validateAllowance: true,
      })).toBeNull();
      // A separate connection commits activation/mapping/insertion AFTER the
      // absent read; unlike a positive match, no row lock could block it.
      const policy = { version: 1, default_duration_minutes: 90, min_duration_minutes: 30, max_duration_minutes: 120 };
      if (key === 'exact') await mockPg('services').insert({ ...original, scheduling_duration_policy: policy });
      else await mockPg('services').where({ id: ids[key] }).update({
        is_active: true, engine_keys: JSON.stringify(original.engine_keys), scheduling_duration_policy: policy,
      });
      await expect(catalogLinkForProfile(scheduling, profile, {
        preserveCapacity: true, validateAllowance: true,
      })).rejects.toMatchObject({ code: 'SLOT_UNAVAILABLE', reason: 'service_duration_changed', status: 409 });
      // A deliberately larger work allowance remains valid; never shrink it
      // to the catalog default or compare a combined total to one member.
      const larger = { ...profile, durationMinutes: 120,
        services: profile.services.map(service => ({ ...service, durationMinutes: 120 })) };
      expect(await catalogLinkForProfile(scheduling, larger, {
        preserveCapacity: true, validateAllowance: true,
      })).toMatchObject({ id: ids[key] });
    } finally {
      if (!scheduling.isCompleted()) await scheduling.rollback();
    }
  });

});
