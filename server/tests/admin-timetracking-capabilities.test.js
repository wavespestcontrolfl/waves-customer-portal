// Team tab capabilities editor (Field Team Program, Phase 0 item 4):
// GET/PUT /admin/timetracking/technicians/:id/capabilities, the roster
// summary, and the new-hire seed on create. Mock style mirrors
// admin-timetracking-employment-status.test.js.
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/time-tracking', () => ({}));
jest.mock('../services/push-notifications', () => ({ deactivateStaffUser: jest.fn(async () => 1) }));
jest.mock('../sockets', () => ({ disconnectStaffSockets: jest.fn() }));
jest.mock('../services/tech-photo', () => ({ resolveTechPhotoUrl: jest.fn(async (_k, fallback) => fallback) }));
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (_req, _res, next) => next(),
  requireTechOrAdmin: (_req, _res, next) => next(),
  requireAdmin: (_req, _res, next) => next(),
}));
jest.mock('@aws-sdk/client-s3', () => ({
  S3Client: jest.fn().mockImplementation(() => ({ send: jest.fn() })),
  PutObjectCommand: jest.fn(), GetObjectCommand: jest.fn(), DeleteObjectCommand: jest.fn(),
}));
jest.mock('@aws-sdk/s3-request-presigner', () => ({ getSignedUrl: jest.fn() }));

const db = require('../models/db');
const router = require('../routes/admin-timetracking');
const {
  createTechnician, getTechnicianCapabilities, listTechnicians, putTechnicianCapabilities,
} = router._handlers;
const {
  CAPABILITY_CATEGORIES, normalizeCapabilityEntries, stateOf,
} = require('../services/technician-capabilities');

const TECH = {
  id: 'tech-1', name: 'Jordan Reyes', email: 'jordan@wavespestcontrol.com', role: 'technician',
  active: true, employment_status: 'active', field_dispatchable: true,
};

function makeChain({ rows = [], first, returning = [] } = {}) {
  const chain = {};
  for (const m of ['insert', 'orderBy', 'orderByRaw', 'select', 'update', 'where', 'whereNot', 'whereIn', 'whereNotIn', 'whereNotNull', 'whereRaw', 'forUpdate', 'leftJoin', 'onConflict']) {
    chain[m] = jest.fn(() => chain);
  }
  chain.first = jest.fn(async () => first);
  chain.returning = jest.fn(async () => returning);
  chain.ignore = jest.fn(async () => undefined);
  chain.merge = jest.fn(async () => undefined);
  chain.then = (res, rej) => Promise.resolve(rows).then(res, rej);
  return chain;
}

function response() {
  return { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
}

async function invoke(handler, req) {
  const res = response();
  const next = jest.fn();
  await handler(req, res, next);
  if (next.mock.calls[0]?.[0]) throw next.mock.calls[0][0];
  return res;
}

// A fake connection keyed by table: `capRows` answers the joined
// capabilities read, `futureVisits` the offboarding-style visit list, and
// every technician_capabilities write is captured on `writes`.
function fakeConn({ tech = TECH, capRows = [], futureVisits = [] } = {}) {
  const writes = [];
  const merges = [];
  const conn = jest.fn((table) => {
    if (table === 'technicians') return makeChain({ first: tech });
    if (table === 'technician_capabilities as tc') return makeChain({ rows: capRows });
    if (table === 'scheduled_services as s') return makeChain({ rows: futureVisits });
    if (table === 'technician_capabilities') {
      const chain = makeChain({ rows: capRows });
      chain.insert = jest.fn((row) => { writes.push(row); return chain; });
      chain.merge = jest.fn(async (cols) => { merges.push(cols); });
      return chain;
    }
    throw new Error(`Unexpected table: ${table}`);
  });
  conn.fn = { now: jest.fn(() => 'NOW') };
  conn.raw = jest.fn(async () => undefined);
  conn.writes = writes;
  conn.merges = merges;
  return conn;
}

function installDb(conn) {
  db.mockImplementation((...args) => conn(...args));
  db.fn = conn.fn;
  db.raw = conn.raw;
  db.transaction = jest.fn(async (cb) => cb(conn));
}

beforeEach(() => jest.clearAllMocks());

describe('stateOf / normalizeCapabilityEntries', () => {
  test('rows map to the three states auto-dispatch already understands; no row is unset', () => {
    expect(stateOf(null)).toBe('unset');
    expect(stateOf({ capability_level: 'qualified', active: true })).toBe('qualified');
    expect(stateOf({ capability_level: 'review_required', active: true })).toBe('review_required');
    expect(stateOf({ capability_level: 'qualified', active: false })).toBe('off');
  });

  test('rejects unknown categories, unknown states, duplicates, and oversized notes', () => {
    expect(normalizeCapabilityEntries(undefined).error).toMatch(/non-empty array/);
    expect(normalizeCapabilityEntries([]).error).toMatch(/non-empty array/);
    expect(normalizeCapabilityEntries([{ service_category: 'plumbing', state: 'qualified' }]).error).toMatch(/service_category/);
    expect(normalizeCapabilityEntries([{ service_category: 'lawn', state: 'expert' }]).error).toMatch(/state/);
    expect(normalizeCapabilityEntries([
      { service_category: 'lawn', state: 'qualified' }, { service_category: 'lawn', state: 'off' },
    ]).error).toMatch(/more than once/);
    expect(normalizeCapabilityEntries([{ service_category: 'lawn', state: 'off', notes: 'x'.repeat(501) }]).error).toMatch(/500/);
    expect(normalizeCapabilityEntries([{ service_category: 'lawn', state: 'off', notes: 42 }]).error).toMatch(/notes/);
    expect(normalizeCapabilityEntries([{ service_category: 'lawn', state: 'off', expected_updated_at: 'yesterday' }]).error).toMatch(/expected_updated_at/);
    const ok = normalizeCapabilityEntries([{ service_category: 'lawn', state: 'qualified', notes: '  saw the fungicide round  ', expected_updated_at: '2026-09-05T10:00:00.000Z' }]);
    expect(ok.entries).toEqual([{ service_category: 'lawn', state: 'qualified', notes: 'saw the fungicide round', expected_updated_at: '2026-09-05T10:00:00.000Z' }]);
    // omitted note → undefined (preserve); '' or null → null (clear); omitted baseline → undefined (no check); null → "I saw no row"
    const [omitted, cleared, nulled] = normalizeCapabilityEntries([
      { service_category: 'lawn', state: 'off' },
      { service_category: 'rodent', state: 'off', notes: '' },
      { service_category: 'termite', state: 'off', notes: null, expected_updated_at: null },
    ]).entries;
    expect(omitted).toEqual({ service_category: 'lawn', state: 'off', notes: undefined, expected_updated_at: undefined });
    expect(cleared.notes).toBeNull();
    expect(nulled).toMatchObject({ notes: null, expected_updated_at: null });
  });
});

describe('GET /technicians/:id/capabilities', () => {
  test('returns all five categories, missing rows as unset, with the verifier name', async () => {
    installDb(fakeConn({
      capRows: [
        { service_category: 'lawn', capability_level: 'qualified', active: true, source: 'admin', notes: null, verified_by: 'adam', verified_by_name: 'Adam', verified_at: 'T1', updated_at: 'T1' },
        { service_category: 'termite', capability_level: 'review_required', active: false, source: 'admin', notes: 'not yet', verified_by: 'adam', verified_by_name: 'Adam', verified_at: 'T2', updated_at: 'T2' },
      ],
    }));
    const res = await invoke(getTechnicianCapabilities, { params: { id: 'tech-1' } });
    expect(res.statusCode).toBe(200);
    expect(res.body.capabilities.map((c) => c.service_category)).toEqual(CAPABILITY_CATEGORIES);
    const byCat = Object.fromEntries(res.body.capabilities.map((c) => [c.service_category, c]));
    expect(byCat.lawn).toMatchObject({ state: 'qualified', verified_by_name: 'Adam', label: 'Lawn, tree & shrub' });
    expect(byCat.termite).toMatchObject({ state: 'off', notes: 'not yet' });
    expect(byCat.general).toMatchObject({ state: 'unset', verified_by: null, notes: null });
  });

  test('404 for an unknown technician', async () => {
    installDb(fakeConn({ tech: null }));
    const res = await invoke(getTechnicianCapabilities, { params: { id: 'nope' } });
    expect(res.statusCode).toBe(404);
  });
});

describe('PUT /technicians/:id/capabilities', () => {
  test('400 on a bad body before any transaction', async () => {
    installDb(fakeConn());
    const res = await invoke(putTechnicianCapabilities, {
      params: { id: 'tech-1' }, technicianId: 'adam',
      body: { capabilities: [{ service_category: 'lawn', state: 'expert' }] },
    });
    expect(res.statusCode).toBe(400);
    expect(db.transaction).not.toHaveBeenCalled();
  });

  test('upserts each entry with the caller as verifier; Off flips active and keeps the level column mergeable-safe', async () => {
    const conn = fakeConn({
      futureVisits: [
        { id: 'v1', scheduled_date: '2026-09-10', service_type: 'Lawn Fertilization', first_name: 'Pat', last_name: 'Lee' },
        { id: 'v2', scheduled_date: '2026-09-11', service_type: 'Quarterly Pest Control', first_name: 'Sam', last_name: 'Ng' },
      ],
    });
    installDb(conn);
    const res = await invoke(putTechnicianCapabilities, {
      params: { id: 'tech-1' }, technicianId: 'adam',
      body: {
        capabilities: [
          { service_category: 'general', state: 'qualified', notes: 'ride-along 9/4' },
          { service_category: 'lawn', state: 'off' },
        ],
      },
    });
    expect(res.statusCode).toBe(200);
    expect(conn.writes).toHaveLength(2);
    expect(conn.writes[0]).toMatchObject({
      technician_id: 'tech-1', service_category: 'general', capability_level: 'qualified', active: true,
      source: 'admin', notes: 'ride-along 9/4', verified_by: 'adam', verified_at: 'NOW',
    });
    expect(conn.writes[1]).toMatchObject({
      technician_id: 'tech-1', service_category: 'lawn', active: false, verified_by: 'adam', notes: null,
    });
    // The Off write must NOT overwrite an existing level on conflict — only
    // `active` (and the audit stamps) merge, so turning it back on restores
    // the prior level.
    expect(conn.merges).toHaveLength(2);
    expect(conn.merges[0]).toEqual(expect.arrayContaining(['capability_level', 'active', 'verified_by', 'notes']));
    // Off keeps the level; an OMITTED note keeps the stored note (not merged)
    expect(conn.merges[1]).not.toContain('capability_level');
    expect(conn.merges[1]).not.toContain('notes');
    // Only the lawn visit is reported back for manual reassignment; the
    // pest visit is unaffected by turning lawn off. Nothing is moved.
    expect(res.body.futureAssignedVisits).toEqual([
      { id: 'v1', scheduledDate: '2026-09-10', serviceType: 'Lawn Fertilization', customerName: 'Pat Lee' },
    ]);
    expect(res.body.capabilities).toHaveLength(5);
  });

  test('no future-visit read when nothing is turned off; 404 for an unknown tech', async () => {
    const conn = fakeConn();
    installDb(conn);
    const res = await invoke(putTechnicianCapabilities, {
      params: { id: 'tech-1' }, technicianId: 'adam',
      body: { capabilities: [{ service_category: 'mosquito', state: 'review_required' }] },
    });
    expect(res.statusCode).toBe(200);
    expect(conn.mock.calls.map((c) => c[0])).not.toContain('scheduled_services as s');
    expect(res.body.futureAssignedVisits).toEqual([]);

    installDb(fakeConn({ tech: null }));
    const missing = await invoke(putTechnicianCapabilities, {
      params: { id: 'nope' }, technicianId: 'adam',
      body: { capabilities: [{ service_category: 'mosquito', state: 'qualified' }] },
    });
    expect(missing.statusCode).toBe(404);
  });
});

describe('PUT /technicians/:id/capabilities — optimistic baseline', () => {
  function connWithRow(currentUpdatedAt) {
    const conn = fakeConn();
    const inner = conn.getMockImplementation();
    conn.mockImplementation((table) => {
      if (table === 'technician_capabilities') {
        const chain = inner(table);
        chain.first = jest.fn(async () => (currentUpdatedAt === undefined ? undefined : { updated_at: currentUpdatedAt }));
        return chain;
      }
      return inner(table);
    });
    return conn;
  }

  test('a matching baseline writes; a mismatched one is refused 409 CAPABILITY_STALE naming the category, nothing written', async () => {
    let conn = connWithRow(new Date('2026-09-05T10:00:00.000Z'));
    installDb(conn);
    const ok = await invoke(putTechnicianCapabilities, {
      params: { id: 'tech-1' }, technicianId: 'adam',
      body: { capabilities: [{ service_category: 'lawn', state: 'qualified', expected_updated_at: '2026-09-05T10:00:00Z' }] },
    });
    expect(ok.statusCode).toBe(200);
    expect(conn.writes).toHaveLength(1);

    conn = connWithRow(new Date('2026-09-05T10:05:00.000Z'));
    installDb(conn);
    const stale = await invoke(putTechnicianCapabilities, {
      params: { id: 'tech-1' }, technicianId: 'adam',
      body: { capabilities: [{ service_category: 'lawn', state: 'qualified', expected_updated_at: '2026-09-05T10:00:00Z' }] },
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.body).toMatchObject({ code: 'CAPABILITY_STALE', service_category: 'lawn' });
    expect(conn.writes).toHaveLength(0);
  });

  test('a valid first entry followed by a stale second one: the error escapes the transaction (everything rolls back), response is 409', async () => {
    const conn = fakeConn();
    const inner = conn.getMockImplementation();
    let capReads = 0;
    conn.mockImplementation((table) => {
      const chain = inner(table);
      if (table === 'technician_capabilities') {
        // first entry (general) matches its baseline; second (lawn) does not
        chain.first = jest.fn(async () => (capReads++ === 0
          ? { updated_at: new Date('2026-09-05T10:00:00.000Z') }
          : { updated_at: new Date('2026-09-05T10:05:00.000Z') }));
      }
      return chain;
    });
    installDb(conn);
    const res = await invoke(putTechnicianCapabilities, {
      params: { id: 'tech-1' }, technicianId: 'adam',
      body: { capabilities: [
        { service_category: 'general', state: 'qualified', expected_updated_at: '2026-09-05T10:00:00Z' },
        { service_category: 'lawn', state: 'off', expected_updated_at: '2026-09-05T10:00:00Z' },
      ] },
    });
    expect(res.statusCode).toBe(409);
    expect(res.body).toMatchObject({ code: 'CAPABILITY_STALE', service_category: 'lawn' });
    // the first write was issued inside the transaction…
    expect(conn.writes).toHaveLength(1);
    // …and the transaction callback REJECTED, so Postgres rolls it back (a
    // normal return would have committed it).
    await expect(db.transaction.mock.results[0].value).rejects.toMatchObject({ code: 'CAPABILITY_STALE' });
  });

  test('"I saw no row" (null) is stale once a row exists; an omitted baseline never reads the row', async () => {
    let conn = connWithRow(new Date('2026-09-05T10:00:00.000Z'));
    installDb(conn);
    const stale = await invoke(putTechnicianCapabilities, {
      params: { id: 'tech-1' }, technicianId: 'adam',
      body: { capabilities: [{ service_category: 'lawn', state: 'qualified', expected_updated_at: null }] },
    });
    expect(stale.statusCode).toBe(409);
    conn = connWithRow(undefined);
    installDb(conn);
    const fresh = await invoke(putTechnicianCapabilities, {
      params: { id: 'tech-1' }, technicianId: 'adam',
      body: { capabilities: [{ service_category: 'lawn', state: 'qualified', expected_updated_at: null }] },
    });
    expect(fresh.statusCode).toBe(200);
    conn = connWithRow(new Date('2026-09-05T10:00:00.000Z'));
    installDb(conn);
    const unchecked = await invoke(putTechnicianCapabilities, {
      params: { id: 'tech-1' }, technicianId: 'adam',
      body: { capabilities: [{ service_category: 'lawn', state: 'qualified' }] },
    });
    expect(unchecked.statusCode).toBe(200);
    const capChains = conn.mock.results.filter((r, i) => conn.mock.calls[i][0] === 'technician_capabilities').map((r) => r.value);
    expect(capChains.some((c) => c.first.mock.calls.length)).toBe(false);
  });
});

describe('roster summary + new-hire seed', () => {
  test('GET /technicians carries per-tech counts; a tech with no rows is fully unset', async () => {
    const techs = [
      { ...TECH },
      { ...TECH, id: 'tech-2', name: 'Tech #2', employment_status: 'prospective', active: false, field_dispatchable: false },
    ];
    const conn = jest.fn((table) => {
      if (table === 'technicians') return makeChain({ rows: techs });
      if (table === 'technician_capabilities') {
        return makeChain({
          rows: [
            { technician_id: 'tech-1', service_category: 'general', capability_level: 'qualified', active: true },
            { technician_id: 'tech-1', service_category: 'lawn', capability_level: 'review_required', active: true },
            { technician_id: 'tech-1', service_category: 'termite', capability_level: 'qualified', active: false },
          ],
        });
      }
      throw new Error(`Unexpected table: ${table}`);
    });
    installDb(conn);
    const res = await invoke(listTechnicians, { technician: { role: 'admin' } });
    expect(res.statusCode).toBe(200);
    const [t1, t2] = res.body.technicians;
    expect(t1.capability_summary).toEqual({ qualified: 1, review_required: 1, off: 1, unset: 2 });
    expect(t2.capability_summary).toEqual({ qualified: 0, review_required: 0, off: 0, unset: 5 });
    // Non-admin roster readers get the summary too (not PII), never payroll.
    const asTech = await invoke(listTechnicians, { technician: { role: 'technician' } });
    expect(asTech.body.technicians[0]).toHaveProperty('capability_summary');
    expect(asTech.body.technicians[0]).not.toHaveProperty('pay_rate');
  });

  test('creating a technician seeds all five categories at review_required on the same transaction', async () => {
    const conn = fakeConn();
    // createTechnician: email probe (first → none), then the insert.
    const probe = makeChain({ first: undefined });
    const insert = makeChain({ returning: [{ ...TECH, id: 'new-1' }] });
    const techQueue = [probe, insert];
    conn.mockImplementation((table) => {
      if (table === 'technicians') return techQueue.shift();
      if (table === 'technician_capabilities') {
        const chain = makeChain();
        chain.insert = jest.fn((rows) => { conn.writes.push(rows); return chain; });
        return chain;
      }
      throw new Error(`Unexpected table: ${table}`);
    });
    installDb(conn);
    const res = await invoke(createTechnician, { body: { name: 'Casey', email: 'casey@example.com' } });
    expect(res.statusCode).toBe(200);
    expect(conn.writes).toHaveLength(1);
    const rows = conn.writes[0];
    expect(rows.map((r) => r.service_category)).toEqual(CAPABILITY_CATEGORIES);
    for (const r of rows) {
      expect(r).toMatchObject({ technician_id: 'new-1', capability_level: 'review_required', active: true, source: 'system_default' });
    }
  });
});
