/**
 * BudgetManager.setMode with the `hold` option (owner's budget hold, POST
 * /campaigns/:id/hold). The hold commits in the SAME locked transaction as the
 * mode change and after the Google push, so the 2-hour job can never run between
 * them; a failed push or save leaves no hold; a campaign already in the held mode
 * saves only the hold, decided under the lock. Without the option setMode is
 * unchanged (ads-budget-manager-live-push.test.js pins that).
 */
jest.mock('../config/feature-gates', () => ({ isEnabled: jest.fn(() => true) }));
jest.mock('../services/logger', () => ({ error: jest.fn(), warn: jest.fn(), info: jest.fn() }));
const mockIsConfigured = jest.fn(() => true);
const mockUpdateBudget = jest.fn();
jest.mock('../services/ads/google-ads', () => ({ isConfigured: mockIsConfigured, updateBudget: mockUpdateBudget }));

let row;
let committed; // writes of transactions that committed: { trx, table, op, data }
let failNext; // { table, op } to make throw once
let events; // ordered: 'push' | 'write:<table>:<op>'
let trxCount;

function builderFor(trxName, writes, table) {
  const b = {
    where: () => b,
    forUpdate: () => b,
    first: () => Promise.resolve(table === 'ad_campaigns' ? row : null),
    select: () => Promise.resolve([]),
    update: (data) => record('update', data),
    insert: (data) => record('insert', data),
  };
  function record(op, data) {
    events.push(`write:${table}:${op}`);
    if (failNext && failNext.table === table && failNext.op === op) {
      failNext = null;
      return Promise.reject(new Error(`${table} ${op} failed`));
    }
    writes.push({ trx: trxName, table, op, data });
    return Promise.resolve(1);
  }
  return b;
}
const mockDb = jest.fn((table) => builderFor('db', [], table));
mockDb.transaction = async (cb) => {
  trxCount += 1;
  const name = `trx${trxCount}`;
  const writes = [];
  const trx = jest.fn((table) => builderFor(name, writes, table));
  const out = await cb(trx); // a throw skips the commit: writes are discarded
  committed.push(...writes);
  return out;
};
mockDb.fn = { now: () => 'NOW()' };
jest.mock('../models/db', () => mockDb);

const BudgetManager = require('../services/ads/budget-manager');

const HOLD = { mode: 'base', until: '2026-11-02', set_at: '2026-10-29T12:00:00.000Z', set_by: 'admin-1', reason: 'Held base until 2026-11-02 from the portal' };
const OPTS = { requireLivePush: true, requireActive: true, trigger: 'manual', hold: HOLD };

beforeEach(() => {
  jest.clearAllMocks();
  row = {
    id: 'c-1', campaign_name: 'Waves Pest Control - GBP Search', platform: 'google_ads', platform_campaign_id: '123',
    status: 'active', budget_mode: 'stop', daily_budget_base: '5', daily_budget_current: '0.05', metadata: { keep: 'me' },
  };
  committed = [];
  failNext = null;
  events = [];
  trxCount = 0;
  mockIsConfigured.mockReturnValue(true);
  mockUpdateBudget.mockImplementation(async () => { events.push('push'); return { success: true }; });
});
afterEach(() => jest.restoreAllMocks());

test('mode change and hold commit in ONE transaction, after the push', async () => {
  const out = await BudgetManager.setMode('c-1', 'base', 'Hold: base until 2026-11-02 (set in the portal)', OPTS);
  expect(out).toMatchObject({ newMode: 'base', newBudget: 5, googleAdsUpdated: true });
  expect(mockUpdateBudget).toHaveBeenCalledWith('123', 5);
  const update = committed.find((w) => w.table === 'ad_campaigns' && w.op === 'update');
  const log = committed.find((w) => w.table === 'ad_budget_log');
  expect(update.data).toMatchObject({ budget_mode: 'base', daily_budget_current: 5 });
  // metadata merged into the locked row's metadata, other keys kept
  expect(JSON.parse(update.data.metadata)).toEqual({ keep: 'me', budget_hold: HOLD });
  // mode, hold and audit row share the one locked transaction
  expect(update.trx).toBe(log.trx);
  expect(new Set(committed.map((w) => w.trx)).size).toBe(1);
  expect(events.indexOf('push')).toBeLessThan(events.indexOf('write:ad_campaigns:update'));
  // no separate hold write outside the transaction
  expect(committed.filter((w) => w.table === 'ad_campaigns')).toHaveLength(1);
});

test.each([
  ['the campaign update', { table: 'ad_campaigns', op: 'update' }],
  ['the audit insert', { table: 'ad_budget_log', op: 'insert' }],
])('%s failing after the push saves NO hold and runs the existing rollback', async (_label, fail) => {
  failNext = fail;
  const rollback = jest.spyOn(BudgetManager, 'rollbackAfterLivePush').mockResolvedValue(Object.assign(new Error('rolled back'), { code: 'live_push_rolled_back' }));
  await expect(BudgetManager.setMode('c-1', 'base', 'r', OPTS)).rejects.toThrow('rolled back');
  expect(mockUpdateBudget).toHaveBeenCalledTimes(1);
  expect(rollback).toHaveBeenCalledTimes(1);
  expect(committed).toHaveLength(0); // neither mode, hold nor audit row committed
});

test('a push refusal saves no hold and no rollback is needed', async () => {
  mockUpdateBudget.mockResolvedValue(false);
  const rollback = jest.spyOn(BudgetManager, 'rollbackAfterLivePush');
  await expect(BudgetManager.setMode('c-1', 'base', 'r', OPTS)).rejects.toMatchObject({ code: 'live_push_failed' });
  expect(committed).toHaveLength(0);
  expect(rollback).not.toHaveBeenCalled();
});

test('same mode under the lock saves ONLY the hold: no push, no mode change, no audit row', async () => {
  row.budget_mode = 'base';
  row.daily_budget_current = '5';
  const out = await BudgetManager.setMode('c-1', 'base', 'r', OPTS);
  expect(out).toMatchObject({ holdOnly: true, newMode: 'base', googleAdsUpdated: false, livePushAttempted: false });
  expect(mockUpdateBudget).not.toHaveBeenCalled();
  expect(committed).toHaveLength(1);
  const [only] = committed;
  expect(only).toMatchObject({ table: 'ad_campaigns', op: 'update' });
  expect(Object.keys(only.data).sort()).toEqual(['metadata', 'updated_at']);
  expect(JSON.parse(only.data.metadata)).toEqual({ keep: 'me', budget_hold: HOLD });
});

test('guards still apply with a hold: an inactive campaign saves nothing', async () => {
  row.status = 'paused';
  await expect(BudgetManager.setMode('c-1', 'base', 'r', OPTS)).rejects.toMatchObject({ code: 'campaign_inactive' });
  expect(committed).toHaveLength(0);
  expect(mockUpdateBudget).not.toHaveBeenCalled();
});

test('without the option setMode writes no metadata and still refuses a same-mode call', async () => {
  const { hold: _hold, ...plain } = OPTS;
  await BudgetManager.setMode('c-1', 'base', 'r', plain);
  const update = committed.find((w) => w.table === 'ad_campaigns');
  expect(Object.keys(update.data).sort()).toEqual(['budget_mode', 'daily_budget_current', 'updated_at']);

  committed = [];
  row.budget_mode = 'base';
  await expect(BudgetManager.setMode('c-1', 'base', 'r', plain)).rejects.toMatchObject({ code: 'mode_noop' });
  expect(committed).toHaveLength(0);
});

test('a hold is refused on the legacy (no live push) path rather than silently dropped', async () => {
  await expect(BudgetManager.setMode('c-1', 'base', 'r', { hold: HOLD })).rejects.toThrow(/requireLivePush/);
  expect(committed).toHaveLength(0);
});
