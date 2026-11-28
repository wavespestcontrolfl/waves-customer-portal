jest.mock('../models/db', () => jest.fn());
jest.mock('../services/notification-triggers', () => ({
  listTriggers: jest.fn(() => [
    { key: 'new_lead', label: 'New lead' },
    { key: 'payment_failed', label: 'Payment failed' },
  ]),
  // Only new_lead is classified techVisible here.
  TRIGGER_REGISTRY: { new_lead: { techVisible: true }, payment_failed: {} },
}));
jest.mock('../services/notification-bell-policy', () => ({
  OVERRIDABLE_CATEGORY_SET: new Set(['alert', 'estimate_change_request']),
  DEFAULT_ON_CATEGORIES: new Set(['estimate_change_request']),
  clearOverrideCache: jest.fn(),
  isBellPolicyEnabled: jest.fn(() => false),
  _private: {
    TRIGGER_BELL_DENYLIST: new Set(['payment_succeeded', 'payment_refunded', 'dashboard_alert', 'internal_admin_alert', 'repeat_caller']),
  },
}));
jest.mock('../services/push-notifications', () => ({
  status: jest.fn(() => ({ available: false, configured: false })),
  sendToAdminUser: jest.fn(),
}));
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (_req, _res, next) => next(),
  requireAdmin: (_req, _res, next) => next(),
  requireTechOrAdmin: (_req, _res, next) => next(),
  staffTokenVersionMatches: jest.fn(),
}));

const db = require('../models/db');
const router = require('../routes/admin-push');

const preferencesHandler = router.stack
  .find((layer) => layer.route?.path === '/preferences' && layer.route.methods.get)
  .route.stack[0].handle;

function response() {
  return { json: jest.fn() };
}

async function invokePreferences({ rows, error, techRole = 'admin' } = {}) {
  const where = jest.fn(() => (
    error ? Promise.reject(error) : Promise.resolve(rows || [])
  ));
  db.mockReturnValue({ where });

  const req = { technicianId: 'admin-1', techRole };
  const res = response();
  const next = jest.fn();
  await preferencesHandler(req, res, next);
  return { where, res, next };
}

describe('GET /preferences', () => {
  beforeEach(() => jest.clearAllMocks());

  test('propagates a preference query failure instead of returning fabricated defaults', async () => {
    const error = new Error('database unavailable');
    const { res, next } = await invokePreferences({ error });

    expect(next).toHaveBeenCalledWith(error);
    expect(res.json).not.toHaveBeenCalled();
  });

  test('a quietByDefault trigger reads OFF on every channel when no row is saved', async () => {
    const { listTriggers } = require('../services/notification-triggers');
    listTriggers.mockReturnValueOnce([
      { key: 'new_lead', label: 'New lead' },
      { key: 'job_complete', label: 'Tech marked job complete', quietByDefault: true },
    ]);
    const { res, next } = await invokePreferences({ rows: [] });
    expect(next).not.toHaveBeenCalled();
    const prefs = res.json.mock.calls[0][0].preferences;
    expect(prefs.find((p) => p.key === 'new_lead')).toMatchObject({ push_enabled: true, bell_enabled: true, sound_enabled: true });
    expect(prefs.find((p) => p.key === 'job_complete')).toMatchObject({ push_enabled: false, bell_enabled: false, sound_enabled: false });
  });

  test('hides bell-policy denylisted triggers only when GATE_ADMIN_BELL_POLICY is enabled', async () => {
    const { listTriggers } = require('../services/notification-triggers');
    const bellPolicy = require('../services/notification-bell-policy');
    const triggers = [
      { key: 'new_lead', label: 'New lead' },
      { key: 'payment_refunded', label: 'Payment refunded' },
      { key: 'repeat_caller', label: 'Repeat caller' },
    ];

    // Policy OFF: denylisted triggers remain active and visible.
    listTriggers.mockReturnValueOnce(triggers);
    bellPolicy.isBellPolicyEnabled.mockReturnValueOnce(false);
    const off = await invokePreferences({ rows: [] });
    expect(off.res.json.mock.calls[0][0].preferences.map((p) => p.key)).toEqual([
      'new_lead',
      'payment_refunded',
      'repeat_caller',
    ]);

    // Policy ON: denylisted retired triggers are hidden.
    listTriggers.mockReturnValueOnce(triggers);
    bellPolicy.isBellPolicyEnabled.mockReturnValueOnce(true);
    const on = await invokePreferences({ rows: [] });
    expect(on.res.json.mock.calls[0][0].preferences.map((p) => p.key)).toEqual(['new_lead']);
  });

  test('returns defaults when the query succeeds with genuinely no saved rows', async () => {
    const { where, res, next } = await invokePreferences({ rows: [] });

    expect(db).toHaveBeenCalledWith('notification_preferences');
    expect(where).toHaveBeenCalledWith({ admin_user_id: 'admin-1' });
    expect(next).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith({
      preferences: [
        expect.objectContaining({
          key: 'new_lead', push_enabled: true, bell_enabled: true, sound_enabled: true,
        }),
        expect.objectContaining({
          key: 'payment_failed', push_enabled: true, bell_enabled: true, sound_enabled: true,
        }),
      ],
      bellCategories: [
        { key: 'category:alert', category: 'alert', bell_enabled: false },
        {
          key: 'category:estimate_change_request',
          category: 'estimate_change_request',
          bell_enabled: true,
        },
      ],
      version: expect.stringMatching(/^[0-9a-f]{32}$/),
    });
  });

  test('returns saved opt-outs and category overrides instead of defaults', async () => {
    const { res, next } = await invokePreferences({
      rows: [
        {
          trigger_key: 'new_lead',
          push_enabled: false,
          bell_enabled: false,
          sound_enabled: false,
        },
        { trigger_key: 'category:alert', bell_enabled: true },
        { trigger_key: 'category:estimate_change_request', bell_enabled: false },
      ],
    });

    expect(next).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith({
      preferences: [
        expect.objectContaining({
          key: 'new_lead', push_enabled: false, bell_enabled: false, sound_enabled: false,
        }),
        expect.objectContaining({
          key: 'payment_failed', push_enabled: true, bell_enabled: true, sound_enabled: true,
        }),
      ],
      bellCategories: [
        { key: 'category:alert', category: 'alert', bell_enabled: true },
        {
          key: 'category:estimate_change_request',
          category: 'estimate_change_request',
          bell_enabled: false,
        },
      ],
      version: expect.stringMatching(/^[0-9a-f]{32}$/),
    });
  });
});

describe('a technician login (owner 2026-11-04)', () => {
  beforeEach(() => jest.clearAllMocks());

  test('lists only the alert types a technician can receive, and no bell category overrides', async () => {
    const { res, next } = await invokePreferences({ rows: [], techRole: 'technician' });
    expect(next).not.toHaveBeenCalled();
    const body = res.json.mock.calls[0][0];
    expect(body.preferences.map((p) => p.key)).toEqual(['new_lead']);
    expect(body.bellCategories).toEqual([]);
  });

  test('an admin still gets every alert type', async () => {
    const { res } = await invokePreferences({ rows: [], techRole: 'admin' });
    expect(res.json.mock.calls[0][0].preferences.map((p) => p.key)).toEqual(['new_lead', 'payment_failed']);
  });

  const putHandler = router.stack
    .find((layer) => layer.route?.path === '/preferences' && layer.route.methods.put)
    .route.stack[0].handle;

  function mockWrites() {
    const onConflict = jest.fn(() => ({ merge: jest.fn().mockResolvedValue() }));
    const insert = jest.fn(() => ({ onConflict }));
    db.mockReturnValue({ insert });
    db.transaction = jest.fn(async (fn) => fn(db));
    return insert;
  }

  test('a technician mutes its own alert type; a type it cannot receive is not written', async () => {
    const insert = mockWrites();
    const res = { json: jest.fn(), status: jest.fn(() => res) };
    await putHandler({
      technicianId: 'tech-1',
      techRole: 'technician',
      body: { preferences: [
        { key: 'new_lead', push_enabled: false, bell_enabled: true, sound_enabled: true },
        { key: 'payment_failed', push_enabled: false, bell_enabled: false, sound_enabled: false },
      ] },
    }, res, jest.fn());
    expect(insert).toHaveBeenCalledTimes(1);
    expect(insert).toHaveBeenCalledWith(expect.objectContaining({ admin_user_id: 'tech-1', trigger_key: 'new_lead', push_enabled: false }));
    expect(res.json).toHaveBeenCalledWith({ ok: true });
  });

  test('an admin still saves every alert type', async () => {
    const insert = mockWrites();
    const res = { json: jest.fn(), status: jest.fn(() => res) };
    await putHandler({
      technicianId: 'admin-1',
      techRole: 'admin',
      body: { preferences: [
        { key: 'new_lead', push_enabled: true, bell_enabled: true, sound_enabled: true },
        { key: 'payment_failed', push_enabled: false, bell_enabled: false, sound_enabled: false },
      ] },
    }, res, jest.fn());
    expect(insert).toHaveBeenCalledTimes(2);
  });

  test('rejects stale PUT with 409 VERSION_CONFLICT when expectedVersion no longer matches persisted rows', async () => {
    const persisted = [
      { trigger_key: 'new_lead', push_enabled: false, bell_enabled: true, sound_enabled: true },
    ];
    const insert = jest.fn();
    db.mockReturnValue({
      where: jest.fn(async () => persisted),
      insert,
    });
    db.transaction = jest.fn(async (fn) => fn(db));
    const res = { json: jest.fn(), status: jest.fn(() => res) };
    await putHandler({
      technicianId: 'admin-1',
      techRole: 'admin',
      body: {
        expectedVersion: '00000000000000000000000000000000',
        preferences: [{ key: 'new_lead', push_enabled: true, bell_enabled: true, sound_enabled: true }],
      },
    }, res, jest.fn());
    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'VERSION_CONFLICT' }));
    expect(insert).not.toHaveBeenCalled();
  });

  test('serializes concurrent PUTs with pg_advisory_xact_lock and advances version even on identical-value saves', async () => {
    const t0 = new Date('2026-11-27T12:00:00.000Z');
    const store = new Map([
      ['new_lead', {
        admin_user_id: 'admin-1',
        trigger_key: 'new_lead',
        push_enabled: true,
        bell_enabled: true,
        sound_enabled: true,
        created_at: t0,
        updated_at: t0,
      }],
    ]);
    // Do NOT serialize db.transaction itself — ONLY pg_advisory_xact_lock
    // serializes overlapping transactions, proving the route acquires the lock
    // BEFORE reading notification_preferences.
    const opOrder = [];
    let lockChain = Promise.resolve();
    let releaseFirstWrite;
    let firstWriteEntered;
    const firstWriteReady = new Promise((r) => { firstWriteEntered = r; });

    const makeTrx = (tag) => {
      let releaseLock = null;
      const trx = (table) => ({
        where: jest.fn(async () => {
          opOrder.push(`${tag}:read:${table}`);
          return [...store.values()].map((r) => ({ ...r }));
        }),
        insert: jest.fn((row) => ({
          onConflict: jest.fn(() => ({
            merge: jest.fn(async (patch) => {
              opOrder.push(`${tag}:write:${table}`);
              if (tag === 'tx2') {
                firstWriteEntered();
                await new Promise((r) => { releaseFirstWrite = r; });
              }
              const existing = store.get(row.trigger_key);
              store.set(row.trigger_key, existing ? { ...existing, ...patch } : { ...row });
            }),
          })),
        })),
      });
      trx.raw = jest.fn(async (sql) => {
        if (/pg_advisory_xact_lock/.test(sql)) {
          const prev = lockChain;
          lockChain = new Promise((r) => { releaseLock = r; });
          await prev;
          opOrder.push(`${tag}:${/lock_shared/.test(sql) ? 'shared-lock' : 'lock'}`);
        }
        return { rows: [] };
      });
      trx._releaseLock = () => { if (releaseLock) releaseLock(); };
      return trx;
    };

    let txSeq = 0;
    db.transaction = jest.fn(async (fn) => {
      const trx = makeTrx(`tx${++txSeq}`);
      try { return await fn(trx); } finally { trx._releaseLock(); }
    });
    db.mockImplementation(() => ({
      where: jest.fn(async () => [...store.values()].map((r) => ({ ...r }))),
    }));

    // Read initial version V1 (new_lead push_enabled=true).
    const getRes = { json: jest.fn() };
    await preferencesHandler({ technicianId: 'admin-1', techRole: 'admin' }, getRes, jest.fn());
    const v1 = getRes.json.mock.calls[0][0].version;

    // Launch two CONCURRENT PUTs both carrying expectedVersion=V1:
    // - PUT 1 re-saves the IDENTICAL original value (push_enabled=true)
    // - PUT 2 attempts to overwrite with push_enabled=false while PUT 1 is mid-transaction
    const res1 = { json: jest.fn(), status: jest.fn(() => res1) };
    const res2 = { json: jest.fn(), status: jest.fn(() => res2) };
    const p1 = putHandler({
      technicianId: 'admin-1',
      techRole: 'admin',
      body: {
        expectedVersion: v1,
        preferences: [{ key: 'new_lead', push_enabled: true, bell_enabled: true, sound_enabled: true }],
      },
    }, res1, jest.fn());
    await firstWriteReady;
    // Launch a concurrent retry GET (e.g. after a 504) AND a stale overlapping PUT
    // while PUT 1 still holds its advisory lock.
    const retryGetRes = { json: jest.fn() };
    const pGet = preferencesHandler({ technicianId: 'admin-1', techRole: 'admin' }, retryGetRes, jest.fn());
    const p2 = putHandler({
      technicianId: 'admin-1',
      techRole: 'admin',
      body: {
        expectedVersion: v1,
        preferences: [{ key: 'new_lead', push_enabled: false, bell_enabled: true, sound_enabled: true }],
      },
    }, res2, jest.fn());
    await new Promise((r) => setTimeout(r, 10));
    releaseFirstWrite();
    await Promise.all([p1, pGet, p2]);

    // Advisory locks precede reads in every transaction, and both retry GET and tx2 wait for tx1 to commit.
    expect(opOrder.indexOf('tx2:lock')).toBeLessThan(opOrder.indexOf('tx2:read:notification_preferences'));
    expect(opOrder.indexOf('tx3:shared-lock')).toBeLessThan(opOrder.indexOf('tx3:read:notification_preferences'));
    expect(opOrder.indexOf('tx4:lock')).toBeLessThan(opOrder.indexOf('tx4:read:notification_preferences'));
    expect(opOrder.indexOf('tx2:write:notification_preferences')).toBeLessThan(opOrder.indexOf('tx3:shared-lock'));
    expect(opOrder.indexOf('tx2:write:notification_preferences')).toBeLessThan(opOrder.indexOf('tx4:lock'));

    // Exactly one save succeeds (with a new version V2 != V1), retry GET observes V2, and the stale PUT gets 409.
    expect(res1.status).not.toHaveBeenCalled();
    const v2 = res1.json.mock.calls[0][0].version;
    expect(v2).toBeTruthy();
    expect(v2).not.toBe(v1);
    expect(retryGetRes.json.mock.calls[0][0].version).toBe(v2);
    expect(res2.status).toHaveBeenCalledWith(409);
    expect(res2.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'VERSION_CONFLICT', version: v2 }));
    expect(store.get('new_lead').push_enabled).toBe(true);
  });
});
