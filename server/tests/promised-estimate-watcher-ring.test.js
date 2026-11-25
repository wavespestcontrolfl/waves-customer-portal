// The promised-quotes bell must come back after the quiet policy closed it while quotes are still owed.
// The ring decision itself is pinned in ops-digest-ring.test.js; this pins that the watcher asks for it.

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/sendgrid-mail', () => ({ isConfigured: () => true, sendOne: jest.fn() }));
jest.mock('../config/feature-gates', () => ({ isEnabled: jest.fn(() => false) }));
jest.mock('../services/ops-digest-fall-off', () => ({ retireIfClean: jest.fn(async () => 1) }));
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/ops-digest', () => ({
  deliverOpsDigest: jest.fn(async () => ({ ok: true })),
  fullSetItemKeys: (rows) => rows.map((r) => String(r.id)),
}));

// Known env for the watcher's own switches, restored after (a CI or local value must not skip delivery).
const ENV_KEYS = ['PROMISED_ESTIMATE_WATCHER_DISABLED', 'PROMISED_ESTIMATE_WATCHER_EMAIL'];
const savedEnv = {};
beforeAll(() => { for (const k of ENV_KEYS) { savedEnv[k] = process.env[k]; delete process.env[k]; } });
afterAll(() => { for (const k of ENV_KEYS) { if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k]; } });

const { deliverOpsDigest } = require('../services/ops-digest');
const { runPromisedEstimateWatcher } = require('../services/promised-estimate-watcher');

test('the standing row rings again when the quiet policy closed it and the list still stands', async () => {
  const rows = [{ id: 1, created_at: new Date(Date.now() - 3 * 86400000), from_phone: '+19415550100', total_count: 1 }];
  const result = await runPromisedEstimateWatcher({
    loadRows: async () => rows, sentRecently: async () => false, stampSendMarker: async () => {},
  });
  expect(result.sent).toBe(true);
  expect(deliverOpsDigest).toHaveBeenCalledWith(expect.objectContaining({
    dedupeKey: 'ops-digest:promised-estimate', refreshOnDedupe: true, ringAfterQuietClose: true,
  }));
});
