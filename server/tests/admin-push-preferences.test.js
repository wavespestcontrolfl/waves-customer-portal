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
});
