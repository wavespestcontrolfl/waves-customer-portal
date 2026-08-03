/**
 * Admin re-entry correction (adjustable interior/exterior dry-down windows).
 *
 * Owner rule 2026-08-03: interior and exterior spray re-entry both default
 * to 30 minutes, and an admin can adjust either per visit — mirroring the
 * time-on-site correction's after-the-fact leg:
 *  - PATCH /:serviceId/reentry corrects a completed row's report advisory.
 *    Pure data write — no status transition, no markComplete, NO customer
 *    communications. Admin-only, validated fail-closed.
 *  - The typed windows are authoritative on every read surface: the stored
 *    `reentry_adjusted: true` marker short-circuits scope-derived zeroing in
 *    normalizeAdvisoryForTreatmentScope.
 *
 * Mirrors the time-on-site suite's layers: pure helpers from the route's
 * _test bag, source-contract pins on the route wiring, and a behavioral
 * drive of the PATCH handler against a scripted knex mock.
 */

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

// The PATCH behavioral tests drive the real route handler — the module-level
// db is swapped per test via this holder (permissive default so the huge
// route module's dependency tree loads without a database).
let mockDbCurrent = null;
jest.mock('../models/db', () => {
  const defaultChain = () => {
    const chain = {};
    const methods = [
      'where', 'whereIn', 'whereNot', 'whereNull', 'whereNotNull', 'andWhere',
      'orWhere', 'join', 'leftJoin', 'select', 'orderBy', 'groupBy', 'limit',
      'offset', 'update', 'insert', 'del', 'onConflict', 'merge', 'ignore',
    ];
    for (const m of methods) chain[m] = () => chain;
    chain.first = async () => null;
    chain.returning = async () => [];
    chain.count = async () => [{ count: 0 }];
    chain.columnInfo = async () => ({});
    chain.then = (resolve) => Promise.resolve([]).then(resolve);
    chain.catch = () => chain;
    return chain;
  };
  const proxy = (...args) => (mockDbCurrent ? mockDbCurrent(...args) : defaultChain());
  proxy.transaction = (...args) => (mockDbCurrent?.transaction
    ? mockDbCurrent.transaction(...args)
    : Promise.resolve());
  proxy.raw = (...args) => (mockDbCurrent?.raw ? mockDbCurrent.raw(...args) : {});
  proxy.fn = { now: () => new Date() };
  proxy.schema = { hasTable: async () => true, hasColumn: async () => true };
  return proxy;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
// resolveServiceRecord stays REAL — the behavioral tests exercise the actual
// FK-then-legacy resolution against the scripted db (same posture as the
// time-on-site suite).
jest.mock('../services/job-costing', () => ({
  calculateJobCost: jest.fn(async () => ({})),
  resolveServiceRecord: jest.requireActual('../services/job-costing').resolveServiceRecord,
}));
jest.mock('../services/time-tracking', () => ({
  adminEditEntry: jest.fn(async () => ({})),
}));

const fs = require('fs');
const path = require('path');

const router = require('../routes/admin-dispatch');
const { reentryEditPlan, REENTRY_EDIT_MAX_MINUTES } = require('../routes/admin-dispatch')._test;
const { normalizeAdvisoryForTreatmentScope } = require('../services/service-report/report-data');
const { buildReentryContextFromRecord } = require('../services/service-report/reentry');
const { SERVICE_LINE_CONFIGS } = require('../services/service-report/service-line-configs');
const { reentryAdjustedPdfSignature } = require('../services/service-report/pdf-storage');

const source = fs.readFileSync(path.join(__dirname, '../routes/admin-dispatch.js'), 'utf8');
const pdfQueueSource = fs.readFileSync(path.join(__dirname, '../services/service-report/pdf-queue.js'), 'utf8');
const reportsPublicSource = fs.readFileSync(path.join(__dirname, '../routes/reports-public.js'), 'utf8');

// ---------------------------------------------------------------------------
// Defaults (owner rule 2026-08-03)
// ---------------------------------------------------------------------------

describe('service-line advisory defaults', () => {
  test('pest spray re-entry defaults to 30 min for BOTH interior and exterior', () => {
    expect(SERVICE_LINE_CONFIGS.pest.advisoryDefaults).toMatchObject({
      exterior_reentry_min: 30,
      interior_reentry_min: 30,
    });
  });
});

// ---------------------------------------------------------------------------
// Pure helper
// ---------------------------------------------------------------------------

describe('reentryEditPlan — the after-the-fact edit gate', () => {
  const COMPLETED = { status: 'completed' };

  test('invalid minutes on either side → 400 reentry_invalid', () => {
    for (const bad of [-5, REENTRY_EDIT_MAX_MINUTES + 1, 'abc', NaN, {}]) {
      for (const body of [{ exteriorMinutes: bad }, { interiorMinutes: bad }, { exteriorMinutes: 30, interiorMinutes: bad }]) {
        const plan = reentryEditPlan({ ...body, service: COMPLETED });
        expect(plan.status).toBe(400);
        expect(plan.error.code).toBe('reentry_invalid');
      }
    }
  });

  test('neither side provided → 400 reentry_invalid (blank is not an edit)', () => {
    for (const body of [{}, { exteriorMinutes: '' }, { exteriorMinutes: null, interiorMinutes: undefined }]) {
      const plan = reentryEditPlan({ ...body, service: COMPLETED });
      expect(plan.status).toBe(400);
      expect(plan.error.code).toBe('reentry_invalid');
    }
  });

  test('non-completed row → 409 service_not_completed', () => {
    for (const status of ['pending', 'confirmed', 'en_route', 'on_site', 'cancelled', 'no_show', undefined]) {
      const plan = reentryEditPlan({ exteriorMinutes: 30, service: { status } });
      expect(plan.status).toBe(409);
      expect(plan.error.code).toBe('service_not_completed');
    }
  });

  test('valid values pass through; one-sided edits leave the other side undefined', () => {
    expect(reentryEditPlan({ exteriorMinutes: 30, interiorMinutes: 45, service: COMPLETED }))
      .toEqual({ exterior: 30, interior: 45 });
    expect(reentryEditPlan({ exteriorMinutes: 20, service: COMPLETED }))
      .toEqual({ exterior: 20, interior: undefined });
    expect(reentryEditPlan({ interiorMinutes: 90, service: COMPLETED }))
      .toEqual({ exterior: undefined, interior: 90 });
  });

  test('zero is legal (removes the wait) and fractional input rounds to an integer', () => {
    expect(reentryEditPlan({ exteriorMinutes: 0, service: COMPLETED }))
      .toEqual({ exterior: 0, interior: undefined });
    expect(reentryEditPlan({ interiorMinutes: '45.6', service: COMPLETED }))
      .toEqual({ exterior: undefined, interior: 46 });
    expect(reentryEditPlan({ exteriorMinutes: REENTRY_EDIT_MAX_MINUTES, service: COMPLETED }))
      .toEqual({ exterior: REENTRY_EDIT_MAX_MINUTES, interior: undefined });
  });
});

// ---------------------------------------------------------------------------
// Read-surface authority of the adjusted marker
// ---------------------------------------------------------------------------

describe('normalizeAdvisoryForTreatmentScope honors the admin correction', () => {
  const EXTERIOR_ONLY_SCOPE = {
    service: { areas_serviced: JSON.stringify(['Exterior perimeter']) },
    applications: [{ application_area: 'Exterior perimeter' }],
  };
  const UNKNOWN_SCOPE = {
    service: { areas_serviced: JSON.stringify([]) },
    applications: [],
  };

  test('without the marker, scope zeroing applies (baseline unchanged)', () => {
    const normalized = normalizeAdvisoryForTreatmentScope(
      { exterior_reentry_min: 45, interior_reentry_min: 60 },
      EXTERIOR_ONLY_SCOPE,
    );
    expect(normalized).toMatchObject({ exterior_reentry_min: 45, interior_reentry_min: 0 });
  });

  test('with reentry_adjusted, the typed windows survive scope zeroing', () => {
    const adjusted = { exterior_reentry_min: 45, interior_reentry_min: 60, reentry_adjusted: true };
    expect(normalizeAdvisoryForTreatmentScope(adjusted, EXTERIOR_ONLY_SCOPE))
      .toMatchObject({ exterior_reentry_min: 45, interior_reentry_min: 60 });
    // Unknown scope would zero the exterior row at read time (owner rule
    // 2026-07-27) — the correction outranks that too.
    expect(normalizeAdvisoryForTreatmentScope(adjusted, UNKNOWN_SCOPE))
      .toMatchObject({ exterior_reentry_min: 45, interior_reentry_min: 60 });
  });

  test('the marker is PER-SIDE — a one-sided edit never resurrects the untouched side (codex P1 PR #3180)', () => {
    // Interior-only correction on an exterior-only-classified visit: the
    // corrected interior survives, the untouched exterior keeps its
    // scope-derived treatment.
    const interiorOnly = {
      exterior_reentry_min: 30,
      interior_reentry_min: 60,
      reentry_adjusted: { exterior: false, interior: true },
    };
    // Unknown scope: without the exterior marker, the exterior row still
    // zeroes at read time (owner rule 2026-07-27) — the write path retained
    // the raw default only for later trace evidence, never for display.
    expect(normalizeAdvisoryForTreatmentScope(interiorOnly, UNKNOWN_SCOPE))
      .toMatchObject({ exterior_reentry_min: 0, interior_reentry_min: 60 });
    // Exterior-only scope: corrected interior survives the interior zeroing.
    expect(normalizeAdvisoryForTreatmentScope(interiorOnly, EXTERIOR_ONLY_SCOPE))
      .toMatchObject({ exterior_reentry_min: 30, interior_reentry_min: 60 });
    // And the mirror: exterior-only correction leaves interior governed by
    // scope (zeroed on an exterior-only visit).
    const exteriorOnly = {
      exterior_reentry_min: 45,
      interior_reentry_min: 60,
      reentry_adjusted: { exterior: true, interior: false },
    };
    expect(normalizeAdvisoryForTreatmentScope(exteriorOnly, EXTERIOR_ONLY_SCOPE))
      .toMatchObject({ exterior_reentry_min: 45, interior_reentry_min: 0 });
    expect(normalizeAdvisoryForTreatmentScope(exteriorOnly, UNKNOWN_SCOPE))
      .toMatchObject({ exterior_reentry_min: 45, interior_reentry_min: 60 });
  });

  test('marker is a strict boolean gate — truthy strings do not bypass', () => {
    for (const marker of ['yes', 1, { exterior: 'yes', interior: 1 }]) {
      const normalized = normalizeAdvisoryForTreatmentScope(
        { exterior_reentry_min: 45, interior_reentry_min: 60, reentry_adjusted: marker },
        EXTERIOR_ONLY_SCOPE,
      );
      expect(normalized).toMatchObject({ interior_reentry_min: 0 });
    }
  });

  test('the re-entry context builds both targets from an adjusted advisory', () => {
    const context = buildReentryContextFromRecord({
      id: 'service-adjusted',
      ended_at: '2026-08-03T13:20:00.000Z',
      areas_serviced: JSON.stringify(['Exterior perimeter']),
      applications: [{ appliedAt: '2026-08-03T13:20:00.000Z', application_area: 'Exterior perimeter' }],
      advisory: { exterior_reentry_min: 30, interior_reentry_min: 30, reentry_adjusted: true },
    }, new Date('2026-08-03T13:25:00.000Z'));
    expect(context.targets.map((t) => t.key)).toEqual(['exterior', 'interior']);
    expect(context.targets[0].durationMin).toBe(30);
    expect(context.targets[1].durationMin).toBe(30);
  });
});

// ---------------------------------------------------------------------------
// Source-contract pins on the route wiring
// ---------------------------------------------------------------------------

function routeLayer(method, routePath) {
  return router.stack.find(
    (l) => l.route && l.route.path === routePath && l.route.methods[method],
  );
}

describe('route wiring contracts', () => {
  test('GET and PATCH /:serviceId/reentry are registered with requireAdmin in their chains', () => {
    for (const method of ['get', 'patch']) {
      const layer = routeLayer(method, '/:serviceId/reentry');
      expect(layer).toBeTruthy();
      expect(layer.route.stack.map((s) => s.handle.name)).toContain('requireAdmin');
    }
  });

  test('the PATCH block is a pure data write: pdf invalidation yes, comms/transitions never', () => {
    const start = source.indexOf("router.patch('/:serviceId/reentry'");
    expect(start).toBeGreaterThan(-1);
    const closer = '} catch (err) { next(err); }\n});';
    const end = source.indexOf(closer, start);
    expect(end).toBeGreaterThan(start);
    const block = source.slice(start, end + closer.length);
    expect(block).toMatch(/pdf_storage_key = null|pdf_storage_key: null/);
    for (const forbidden of [
      'sendCustomerMessage',
      'sendCompletionSms',
      'markComplete',
      'transitionJobStatus',
      'notifyCustomer',
      'twilio',
      'calculateJobCost',
    ]) {
      expect(block).not.toMatch(new RegExp(forbidden, 'i'));
    }
    // Record resolution runs under the row lock, before any write — an
    // in-flight completion finalization's fresh record is seen, and a
    // resolution failure aborts the whole correction.
    const lockAt = block.indexOf('.forUpdate().first();');
    const resolveAt = block.indexOf('.resolveServiceRecord(trx, lockedSvc || svc, serviceRecordCols)');
    const writeAt = block.indexOf("await trx('service_records').where({ id: record.id }).update(recordUpdate);");
    expect(lockAt).toBeGreaterThan(-1);
    expect(resolveAt).toBeGreaterThan(lockAt);
    expect(writeAt).toBeGreaterThan(resolveAt);
    // The audit rides the correction transaction.
    const auditAt = block.indexOf("await trx('activity_log').insert({");
    expect(auditAt).toBeGreaterThan(writeAt);
  });

  test('the advisory merge is a single-statement jsonb expression with first-edit prior capture', () => {
    const start = source.indexOf("router.patch('/:serviceId/reentry'");
    const block = source.slice(start, source.indexOf('} catch (err) { next(err); }\n});', start));
    expect(block).toMatch(/COALESCE\(advisory::jsonb, '\{\}'::jsonb\) \|\| \?::jsonb/);
    expect(block).toMatch(/CASE WHEN COALESCE\(advisory::jsonb, '\{\}'::jsonb\) -> 'reentry_prior' IS NOT NULL\s*\n\s*THEN '\{\}'::jsonb/);
    expect(block).toMatch(/jsonb_build_object\('reentry_prior', jsonb_build_object\(/);
    // The stale-render fence bumps structured_notes.reentryRev in the same
    // atomic-merge shape (codex P1 PR #3180).
    expect(block).toMatch(/jsonb_build_object\('reentryRev',\s*\n\s*COALESCE\(NULLIF\(COALESCE\(structured_notes::jsonb, '\{\}'::jsonb\) ->> 'reentryRev', ''\), '0'\)::int \+ 1\)/);
  });

  test('the re-entry PDF signature rides EVERY storage-key composition site (codex P1 PR #3180)', () => {
    // Same contract the time-on-site fence carries: pdf-queue renderAndStore
    // + getOrRender, reports-public expected-key + store-key. A site missing
    // the component lets a stale in-flight render re-occupy the key.
    expect((pdfQueueSource.match(/reentryAdjustedPdfSignature\(service\)/g) || []).length).toBe(2);
    expect((reportsPublicSource.match(/reentryAdjustedPdfSignature\(service\)/g) || []).length).toBe(2);
    // And every site pairs it with the time-on-site component (same
    // signature string, no site diverges).
    for (const src of [pdfQueueSource, reportsPublicSource]) {
      expect((src.match(/timeOnSiteAdjustedPdfSignature\(service\) \+ reentryAdjustedPdfSignature\(service\)/g) || []).length).toBe(2);
    }
  });
});

// ---------------------------------------------------------------------------
// PDF signature component
// ---------------------------------------------------------------------------

describe('reentryAdjustedPdfSignature', () => {
  test('empty for uncorrected records, rev-keyed for corrected ones', () => {
    expect(reentryAdjustedPdfSignature({})).toBe('');
    expect(reentryAdjustedPdfSignature({ structured_notes: JSON.stringify({ timeOnSiteAdjusted: true }) })).toBe('');
    expect(reentryAdjustedPdfSignature({ structured_notes: JSON.stringify({ reentryAdjusted: true, reentryRev: 1 }) })).toBe('-rer1');
    expect(reentryAdjustedPdfSignature({ structured_notes: { reentryAdjusted: true, reentryRev: 3 } })).toBe('-rer3');
    // Strict marker + malformed notes fail soft to no component.
    expect(reentryAdjustedPdfSignature({ structured_notes: JSON.stringify({ reentryAdjusted: 'yes', reentryRev: 2 }) })).toBe('');
    expect(reentryAdjustedPdfSignature({ structured_notes: '{not json' })).toBe('');
  });
});

// ---------------------------------------------------------------------------
// Behavioral: the PATCH handler against a scripted knex mock
// ---------------------------------------------------------------------------

function makeRecordingDb({ svc, record, recordCols, legacyRows = null, serviceProducts = null, catalogRows = null }) {
  // `record` answers resolveServiceRecord's FK query (.first()); `legacyRows`
  // (when set) answers its awaited (customer, date, type) soft-join so the
  // pre-FK shapes exercise the REAL legacy resolution path. `serviceProducts`
  // / `catalogRows` script the REI-floor lookups (applied products and their
  // products_catalog rei_hours).
  const calls = [];
  const chainFor = (table) => {
    const op = { table };
    calls.push(op);
    const chain = {
      where(criteria) { op.whereCriteria = criteria; return chain; },
      whereIn(col, vals) { op.whereInCriteria = [col, vals]; return chain; },
      orderBy(col, dir) { op.orderBy = [col, dir]; return chain; },
      limit(n) { op.limited = n; return chain; },
      count(spec) { op.counted = spec; return chain; },
      whereNot(col, val) { op.whereNot = [col, val]; return chain; },
      select(...cols) { op.selected = cols; return chain; },
      forUpdate() { op.locked = true; return chain; },
      async first() {
        if (table === 'scheduled_services') return op.counted ? { c: 1 } : svc;
        if (table === 'service_records') return record;
        return null;
      },
      async update(payload) { op.updatePayload = payload; return 1; },
      async insert(payload) { op.insertPayload = payload; return [1]; },
      async columnInfo() { return recordCols; },
      then(resolve, reject) {
        let rows = [];
        if (table === 'service_records' && op.limited) rows = legacyRows || [];
        else if (table === 'service_products') rows = serviceProducts || [];
        else if (table === 'products_catalog') rows = catalogRows || [];
        return Promise.resolve(rows).then(resolve, reject);
      },
    };
    chain.catch = () => chain;
    return chain;
  };
  const trxFn = (table) => chainFor(table);
  trxFn.raw = (sql, bindings) => ({ __raw: true, sql, bindings });
  const dbMock = (table) => chainFor(table);
  dbMock.transaction = async (fn) => fn(trxFn);
  dbMock.calls = calls;
  return dbMock;
}

function makeRes() {
  const res = { statusCode: 200, body: null };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (payload) => { res.body = payload; return res; };
  return res;
}

function patchHandler() {
  const layer = routeLayer('patch', '/:serviceId/reentry');
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

const RECORD_COLS = {
  id: {}, structured_notes: {}, advisory: {}, pdf_storage_key: {},
  scheduled_service_id: {}, ended_at: {}, completed_at: {},
  report_template_version: {},
};

const COMPLETED_SVC = {
  id: 'svc-1',
  customer_id: 'cust-1',
  status: 'completed',
  service_type: 'Quarterly Pest Control',
};
const RECORD = {
  id: 'rec-1',
  report_template_version: 'service_report_v1',
  advisory: JSON.stringify({ exterior_reentry_min: 30, interior_reentry_min: 30, irrigation_hold_hr: 24 }),
};

describe('PATCH /:serviceId/reentry — behavioral', () => {
  afterEach(() => { mockDbCurrent = null; jest.clearAllMocks(); });

  test('happy path: atomic advisory merge, pdf invalidation, in-trx audit', async () => {
    const dbMock = makeRecordingDb({ svc: COMPLETED_SVC, record: RECORD, recordCols: RECORD_COLS });
    mockDbCurrent = dbMock;
    const res = makeRes();
    await patchHandler()(
      { params: { serviceId: 'svc-1' }, body: { exteriorMinutes: 20, interiorMinutes: 45 }, technicianId: 'admin-1', techRole: 'admin' },
      res,
      (err) => { throw err; },
    );

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      success: true,
      exteriorMinutes: 20,
      interiorMinutes: 45,
      recordUpdated: true,
    });

    const recUpdate = dbMock.calls.find((c) => c.table === 'service_records' && c.updatePayload);
    expect(recUpdate.whereCriteria).toEqual({ id: 'rec-1' });
    expect(recUpdate.updatePayload.pdf_storage_key).toBeNull();
    const advisoryRaw = recUpdate.updatePayload.advisory;
    expect(advisoryRaw.__raw).toBe(true);
    expect(advisoryRaw.sql).toMatch(/\|\| \?::jsonb/);
    expect(advisoryRaw.sql).toMatch(/COALESCE\(advisory::jsonb, '\{\}'::jsonb\)/);
    expect(JSON.parse(advisoryRaw.bindings[0])).toEqual({
      reentry_adjusted: { exterior: true, interior: true },
      exterior_reentry_min: 20,
      interior_reentry_min: 45,
    });
    // The stale-render fence rides the same update: reentryAdjusted marker +
    // per-save rev bump in structured_notes (codex P1 PR #3180).
    const notesRaw = recUpdate.updatePayload.structured_notes;
    expect(notesRaw.__raw).toBe(true);
    expect(notesRaw.sql).toMatch(/'reentryRev'/);
    expect(JSON.parse(notesRaw.bindings[0])).toEqual({ reentryAdjusted: true });
    // An FK-linked record needs no heal — the linkage column stays untouched.
    expect(recUpdate.updatePayload.scheduled_service_id).toBeUndefined();

    // The visit row is locked but never written — re-entry is report data.
    const lockedRead = dbMock.calls.find((c) => c.table === 'scheduled_services' && c.locked);
    expect(lockedRead).toBeTruthy();
    expect(dbMock.calls.find((c) => c.table === 'scheduled_services' && c.updatePayload)).toBeUndefined();

    const audit = dbMock.calls.find((c) => c.table === 'activity_log');
    expect(audit.insertPayload.action).toBe('reentry_adjusted');
    expect(audit.insertPayload.admin_user_id).toBe('admin-1');
    expect(JSON.parse(audit.insertPayload.metadata)).toMatchObject({
      scheduled_service_id: 'svc-1',
      service_record_id: 'rec-1',
      previous: { exterior_reentry_min: 30, interior_reentry_min: 30 },
      new: { exterior_reentry_min: 20, interior_reentry_min: 45 },
    });
  });

  test('one-sided edit: only that key travels, and the marker claims ONLY that side', async () => {
    const dbMock = makeRecordingDb({ svc: COMPLETED_SVC, record: RECORD, recordCols: RECORD_COLS });
    mockDbCurrent = dbMock;
    const res = makeRes();
    await patchHandler()(
      { params: { serviceId: 'svc-1' }, body: { interiorMinutes: 0 }, technicianId: 'admin-1', techRole: 'admin' },
      res,
      (err) => { throw err; },
    );
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ success: true, interiorMinutes: 0, recordUpdated: true });
    const recUpdate = dbMock.calls.find((c) => c.table === 'service_records' && c.updatePayload);
    expect(JSON.parse(recUpdate.updatePayload.advisory.bindings[0])).toEqual({
      reentry_adjusted: { exterior: false, interior: true },
      interior_reentry_min: 0,
    });
  });

  test('a later one-sided edit UNIONS the marker with the prior sides — earlier corrections stay authoritative', async () => {
    const priorAdjusted = {
      ...RECORD,
      advisory: JSON.stringify({
        exterior_reentry_min: 20,
        interior_reentry_min: 30,
        reentry_adjusted: { exterior: true, interior: false },
      }),
    };
    const dbMock = makeRecordingDb({ svc: COMPLETED_SVC, record: priorAdjusted, recordCols: RECORD_COLS });
    mockDbCurrent = dbMock;
    const res = makeRes();
    await patchHandler()(
      { params: { serviceId: 'svc-1' }, body: { interiorMinutes: 45 }, technicianId: 'admin-1', techRole: 'admin' },
      res,
      (err) => { throw err; },
    );
    expect(res.statusCode).toBe(200);
    const recUpdate = dbMock.calls.find((c) => c.table === 'service_records' && c.updatePayload);
    expect(JSON.parse(recUpdate.updatePayload.advisory.bindings[0])).toEqual({
      reentry_adjusted: { exterior: true, interior: true },
      interior_reentry_min: 45,
    });
    // A legacy both-sides `true` marker unions the same way.
    const legacyTrue = {
      ...RECORD,
      advisory: JSON.stringify({ exterior_reentry_min: 20, reentry_adjusted: true }),
    };
    const dbMock2 = makeRecordingDb({ svc: COMPLETED_SVC, record: legacyTrue, recordCols: RECORD_COLS });
    mockDbCurrent = dbMock2;
    const res2 = makeRes();
    await patchHandler()(
      { params: { serviceId: 'svc-1' }, body: { exteriorMinutes: 25 }, technicianId: 'admin-1', techRole: 'admin' },
      res2,
      (err) => { throw err; },
    );
    const recUpdate2 = dbMock2.calls.find((c) => c.table === 'service_records' && c.updatePayload);
    expect(JSON.parse(recUpdate2.updatePayload.advisory.bindings[0])).toEqual({
      reentry_adjusted: { exterior: true, interior: true },
      exterior_reentry_min: 25,
    });
  });

  test('an exterior correction below the applied products\' label REI is rejected, at-or-above passes (codex P1 PR #3180)', async () => {
    const withRei = {
      serviceProducts: [{ product_id: 'prod-1' }, { product_id: 'prod-2' }],
      // Most restrictive wins: 4h → 240 min floor.
      catalogRows: [{ rei_hours: 0.5 }, { rei_hours: 4 }],
    };
    let dbMock = makeRecordingDb({ svc: COMPLETED_SVC, record: RECORD, recordCols: RECORD_COLS, ...withRei });
    mockDbCurrent = dbMock;
    let res = makeRes();
    await patchHandler()(
      { params: { serviceId: 'svc-1' }, body: { exteriorMinutes: 30 }, technicianId: 'admin-1', techRole: 'admin' },
      res,
      (err) => { throw err; },
    );
    expect(res.statusCode).toBe(400);
    expect(res.body.code).toBe('reentry_below_product_rei');
    expect(res.body.productReiMinutes).toBe(240);
    expect(dbMock.calls.find((c) => c.updatePayload)).toBeUndefined();

    // Exactly at the floor is legal.
    dbMock = makeRecordingDb({ svc: COMPLETED_SVC, record: RECORD, recordCols: RECORD_COLS, ...withRei });
    mockDbCurrent = dbMock;
    res = makeRes();
    await patchHandler()(
      { params: { serviceId: 'svc-1' }, body: { exteriorMinutes: 240 }, technicianId: 'admin-1', techRole: 'admin' },
      res,
      (err) => { throw err; },
    );
    expect(res.statusCode).toBe(200);

    // Interior-only corrections are not floored (rei_hours is the
    // outdoor-treatment REI — mirrors the completion path).
    dbMock = makeRecordingDb({ svc: COMPLETED_SVC, record: RECORD, recordCols: RECORD_COLS, ...withRei });
    mockDbCurrent = dbMock;
    res = makeRes();
    await patchHandler()(
      { params: { serviceId: 'svc-1' }, body: { interiorMinutes: 10 }, technicianId: 'admin-1', techRole: 'admin' },
      res,
      (err) => { throw err; },
    );
    expect(res.statusCode).toBe(200);
  });

  test('legacy (pre-v1) record → 409 record_legacy, nothing written (codex P2 PR #3180)', async () => {
    const legacyRecord = { ...RECORD, report_template_version: null };
    const dbMock = makeRecordingDb({ svc: COMPLETED_SVC, record: legacyRecord, recordCols: RECORD_COLS });
    mockDbCurrent = dbMock;
    const res = makeRes();
    await patchHandler()(
      { params: { serviceId: 'svc-1' }, body: { exteriorMinutes: 20 }, technicianId: 'admin-1', techRole: 'admin' },
      res,
      (err) => { throw err; },
    );
    expect(res.statusCode).toBe(409);
    expect(res.body.code).toBe('record_legacy');
    expect(dbMock.calls.find((c) => c.updatePayload)).toBeUndefined();
  });

  test('legacy record found through the soft-join gets the FK heal stamped', async () => {
    const legacyRecord = { ...RECORD, id: 'rec-legacy' };
    const dbMock = makeRecordingDb({
      svc: { ...COMPLETED_SVC, scheduled_date: '2026-08-01' },
      record: null,
      recordCols: RECORD_COLS,
      legacyRows: [legacyRecord],
    });
    mockDbCurrent = dbMock;
    const res = makeRes();
    await patchHandler()(
      { params: { serviceId: 'svc-1' }, body: { exteriorMinutes: 15 }, technicianId: 'admin-1', techRole: 'admin' },
      res,
      (err) => { throw err; },
    );
    expect(res.statusCode).toBe(200);
    const recUpdate = dbMock.calls.find((c) => c.table === 'service_records' && c.updatePayload);
    expect(recUpdate.whereCriteria).toEqual({ id: 'rec-legacy' });
    expect(recUpdate.updatePayload.scheduled_service_id).toBe('svc-1');
  });

  test('no report record → 404 record_not_found, nothing written', async () => {
    const dbMock = makeRecordingDb({ svc: COMPLETED_SVC, record: null, recordCols: RECORD_COLS });
    mockDbCurrent = dbMock;
    const res = makeRes();
    await patchHandler()(
      { params: { serviceId: 'svc-1' }, body: { exteriorMinutes: 20 }, technicianId: 'admin-1', techRole: 'admin' },
      res,
      (err) => { throw err; },
    );
    expect(res.statusCode).toBe(404);
    expect(res.body.code).toBe('record_not_found');
    expect(dbMock.calls.find((c) => c.updatePayload)).toBeUndefined();
    expect(dbMock.calls.find((c) => c.table === 'activity_log')).toBeUndefined();
  });

  test('ambiguous legacy match → 409 record_ambiguous, nothing written (no half-landed correction)', async () => {
    const dbMock = makeRecordingDb({
      svc: { ...COMPLETED_SVC, scheduled_date: '2026-08-01' },
      record: null,
      recordCols: RECORD_COLS,
      legacyRows: [{ ...RECORD, id: 'rec-a' }, { ...RECORD, id: 'rec-b' }],
    });
    mockDbCurrent = dbMock;
    const res = makeRes();
    await patchHandler()(
      { params: { serviceId: 'svc-1' }, body: { exteriorMinutes: 20 }, technicianId: 'admin-1', techRole: 'admin' },
      res,
      (err) => { throw err; },
    );
    expect(res.statusCode).toBe(409);
    expect(res.body.code).toBe('record_ambiguous');
    expect(dbMock.calls.find((c) => c.updatePayload)).toBeUndefined();
  });

  test('non-completed visit → 409 before any transaction opens', async () => {
    const dbMock = makeRecordingDb({ svc: { ...COMPLETED_SVC, status: 'on_site' }, record: RECORD, recordCols: RECORD_COLS });
    let transacted = false;
    const origTransaction = dbMock.transaction;
    dbMock.transaction = async (fn) => { transacted = true; return origTransaction(fn); };
    mockDbCurrent = dbMock;
    const res = makeRes();
    await patchHandler()(
      { params: { serviceId: 'svc-1' }, body: { exteriorMinutes: 20 }, technicianId: 'admin-1', techRole: 'admin' },
      res,
      (err) => { throw err; },
    );
    expect(res.statusCode).toBe(409);
    expect(res.body.code).toBe('service_not_completed');
    expect(transacted).toBe(false);
  });

  test('deployment without an advisory column → 409 advisory_unsupported', async () => {
    const dbMock = makeRecordingDb({ svc: COMPLETED_SVC, record: RECORD, recordCols: { id: {}, structured_notes: {} } });
    mockDbCurrent = dbMock;
    const res = makeRes();
    await patchHandler()(
      { params: { serviceId: 'svc-1' }, body: { exteriorMinutes: 20 }, technicianId: 'admin-1', techRole: 'admin' },
      res,
      (err) => { throw err; },
    );
    expect(res.statusCode).toBe(409);
    expect(res.body.code).toBe('advisory_unsupported');
  });
});

// ---------------------------------------------------------------------------
// Behavioral: the GET seed endpoint
// ---------------------------------------------------------------------------

function getHandler() {
  const layer = routeLayer('get', '/:serviceId/reentry');
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

describe('GET /:serviceId/reentry — behavioral', () => {
  afterEach(() => { mockDbCurrent = null; jest.clearAllMocks(); });

  test('returns raw stored windows, adjusted flag, and service-line defaults', async () => {
    const dbMock = makeRecordingDb({
      svc: COMPLETED_SVC,
      record: { ...RECORD, advisory: JSON.stringify({ exterior_reentry_min: 20, interior_reentry_min: 45, reentry_adjusted: true }) },
      recordCols: RECORD_COLS,
    });
    mockDbCurrent = dbMock;
    const res = makeRes();
    await getHandler()(
      { params: { serviceId: 'svc-1' }, technicianId: 'admin-1', techRole: 'admin' },
      res,
      (err) => { throw err; },
    );
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      hasRecord: true,
      exteriorMinutes: 20,
      interiorMinutes: 45,
      adjusted: true,
      defaults: { exteriorMinutes: 30, interiorMinutes: 30 },
    });
  });

  test('no record → hasRecord false with defaults still present for the UI', async () => {
    const dbMock = makeRecordingDb({ svc: COMPLETED_SVC, record: null, recordCols: RECORD_COLS });
    mockDbCurrent = dbMock;
    const res = makeRes();
    await getHandler()(
      { params: { serviceId: 'svc-1' }, technicianId: 'admin-1', techRole: 'admin' },
      res,
      (err) => { throw err; },
    );
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      hasRecord: false,
      defaults: { exteriorMinutes: 30, interiorMinutes: 30 },
    });
  });

  test('legacy (pre-v1) record → hasRecord false so the editor stays hidden (codex P2 PR #3180)', async () => {
    const dbMock = makeRecordingDb({
      svc: COMPLETED_SVC,
      record: { ...RECORD, report_template_version: 'legacy' },
      recordCols: RECORD_COLS,
    });
    mockDbCurrent = dbMock;
    const res = makeRes();
    await getHandler()(
      { params: { serviceId: 'svc-1' }, technicianId: 'admin-1', techRole: 'admin' },
      res,
      (err) => { throw err; },
    );
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      hasRecord: false,
      legacyRecord: true,
      defaults: { exteriorMinutes: 30, interiorMinutes: 30 },
    });
  });

  test('a per-side marker reads back as adjusted', async () => {
    const dbMock = makeRecordingDb({
      svc: COMPLETED_SVC,
      record: {
        ...RECORD,
        advisory: JSON.stringify({ interior_reentry_min: 45, reentry_adjusted: { exterior: false, interior: true } }),
      },
      recordCols: RECORD_COLS,
    });
    mockDbCurrent = dbMock;
    const res = makeRes();
    await getHandler()(
      { params: { serviceId: 'svc-1' }, technicianId: 'admin-1', techRole: 'admin' },
      res,
      (err) => { throw err; },
    );
    expect(res.body).toMatchObject({ hasRecord: true, interiorMinutes: 45, adjusted: true });
  });
});
