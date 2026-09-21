jest.mock('../models/db', () => jest.fn());
jest.mock('../services/notification-triggers', () => ({
  listTriggers: jest.fn(() => [
    { key: 'new_lead', label: 'New lead' },
    { key: 'payment_failed', label: 'Payment failed' },
  ]),
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
