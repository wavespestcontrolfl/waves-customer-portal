/**
 * Estimated LLM spend (services/llm-cost.js, GATE_LLM_COST_TRACKING).
 * Invariants: feed and ledger model ids meet on one key; each provider's
 * token semantics are priced without double counting; a model with no
 * price, or a call with no usage, is counted as unpriced, never guessed; a
 * short or failed feed never overwrites stored prices; the spend check is
 * inert while the gate is off, raises one item on a spike and closes it
 * when spend is back to normal. The SQL and the migration run for real in
 * a disposable schema (skipped without APP_TEST_DATABASE_URL).
 */

const { randomUUID } = require('node:crypto');

const mockRaise = jest.fn();
jest.mock('../services/admin-alert-compose', () => ({ raiseAdminAlert: (...a) => mockRaise(...a) }));
const mockOpenKeys = jest.fn();
const mockCloseKeys = jest.fn();
jest.mock('../services/admin-alert-episodes', () => ({
  openAdminAlertKeys: (...a) => mockOpenKeys(...a),
  closeAdminAlertKeys: (...a) => mockCloseKeys(...a),
}));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const llmCost = require('../services/llm-cost');

const saved = {};
const ENV = ['GATE_LLM_COST_TRACKING', 'LLM_COST_ALERT_MIN_USD', 'LLM_COST_ALERT_MULTIPLIER'];
beforeAll(() => { for (const k of ENV) saved[k] = process.env[k]; });
afterAll(() => { for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });
beforeEach(() => {
  for (const k of ENV) delete process.env[k];
  mockRaise.mockReset();
  mockOpenKeys.mockReset().mockResolvedValue([]);
  mockCloseKeys.mockReset().mockResolvedValue(0);
});

// A feed body with `extra` filler models so it clears MIN_FEED_ROWS.
function feed(models, extra = llmCost.MIN_FEED_ROWS) {
  const filler = Array.from({ length: extra }, (_, i) => ({ id: `openai/filler-${i}`, pricing: { prompt: '0.000001', completion: '0.000002' } }));
  return { data: [...models, ...filler] };
}
const okFetch = (body) => jest.fn(async () => ({ ok: true, status: 200, json: async () => body }));

describe('model ids', () => {
  test('a feed id and the ledger served model meet on one key', () => {
    expect(llmCost.normalizeModelId('anthropic/claude-haiku-4.5')).toBe('claude-haiku-4-5');
    expect(llmCost.normalizeModelId('claude-haiku-4-5-20251001')).toBe('claude-haiku-4-5');
    expect(llmCost.normalizeModelId('openai/gpt-5.6-sol')).toBe(llmCost.normalizeModelId('gpt-5.6-sol'));
    expect(llmCost.normalizeModelId('openai/gpt-4o-2024-08-06')).toBe('gpt-4o');
    expect(llmCost.normalizeModelId('anthropic/claude-sonnet-4.5:thinking')).toBe('claude-sonnet-4-5');
    expect(llmCost.normalizeModelId('')).toBeNull();
    expect(llmCost.normalizeModelId(null)).toBeNull();
  });

  test('a preview build falls back to its base model price', () => {
    const prices = new Map([['gemini-3-8-flash', { input: 0.3, output: 2.5 }]]);
    expect(llmCost.priceFor(prices, 'gemini-3.8-flash-preview-09-2026')).toEqual({ input: 0.3, output: 2.5 });
    expect(llmCost.priceFor(prices, 'gemini-3.8-pro')).toBeNull();
  });
});

describe('parseFeed', () => {
  test('keeps priced anthropic / openai / google models per million tokens; drops variants, other vendors and unpriced rows', () => {
    const at = new Date('2026-10-01T11:40:00Z');
    const rows = llmCost.parseFeed({
      data: [
        { id: 'anthropic/claude-opus-5.5', pricing: { prompt: '0.000005', completion: '0.000025', input_cache_read: '0.0000005', input_cache_write: '0.00000625' } },
        { id: 'google/gemini-3.8-flash', pricing: { prompt: '0.0000003', completion: '0.0000025', internal_reasoning: '0.0000025' } },
        { id: 'openai/gpt-5.6-sol:free', pricing: { prompt: '0', completion: '0' } },
        { id: 'meta-llama/llama-4', pricing: { prompt: '0.0000001', completion: '0.0000001' } },
        { id: 'openai/gpt-router', pricing: { prompt: '-1', completion: '-1' } },
        { id: 'openai/gpt-5.6-sol-2026-08-01', pricing: { prompt: '0.000002', completion: '0.000008' } },
        { id: 'openai/gpt-5.6-sol', pricing: { prompt: '0.0000015', completion: '0.000006' } },
      ],
    }, at);
    const byKey = Object.fromEntries(rows.map((r) => [r.model_key, r]));
    expect(Object.keys(byKey).sort()).toEqual(['claude-opus-5-5', 'gemini-3-8-flash', 'gpt-5-6-sol']);
    expect(byKey['claude-opus-5-5']).toMatchObject({ provider: 'anthropic', input_per_mtok: 5, output_per_mtok: 25, cache_read_per_mtok: 0.5, cache_write_per_mtok: 6.25, fetched_at: at });
    expect(byKey['gemini-3-8-flash']).toMatchObject({ provider: 'gemini', cache_read_per_mtok: null, reasoning_per_mtok: 2.5 });
    // the undated alias wins over a dated snapshot with the same key
    expect(byKey['gpt-5-6-sol']).toMatchObject({ source_model_id: 'openai/gpt-5.6-sol', input_per_mtok: 1.5 });
  });
});

describe('costUsd', () => {
  const p = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75, reasoning: null };
  const M = 1_000_000;

  test('anthropic: input excludes cache reads and writes, each billed at its own rate', () => {
    expect(llmCost.costUsd('anthropic', { input_tokens: M, cached_input_tokens: M, cache_write_tokens: M, output_tokens: M }, p))
      .toBeCloseTo(3 + 0.3 + 3.75 + 15, 9);
  });

  test('openai: cached tokens are inside input, reasoning inside output — neither double counted', () => {
    expect(llmCost.costUsd('openai', { input_tokens: M, cached_input_tokens: M / 2, output_tokens: M, reasoning_tokens: M / 2 }, p))
      .toBeCloseTo(1.5 + 0.15 + 15, 9);
  });

  test('gemini: cached tokens inside input, thoughts billed beside output', () => {
    expect(llmCost.costUsd('gemini', { input_tokens: M, cached_input_tokens: 0, output_tokens: M, reasoning_tokens: M }, p))
      .toBeCloseTo(3 + 15 + 15, 9);
  });

  test('a missing cache rate bills at the input rate; no price or an unknown provider is null', () => {
    expect(llmCost.costUsd('anthropic', { cached_input_tokens: M }, { input: 3, output: 15 })).toBeCloseTo(3, 9);
    expect(llmCost.costUsd('anthropic', { input_tokens: M }, null)).toBeNull();
    expect(llmCost.costUsd('typesafe', { input_tokens: M }, p)).toBeNull();
  });
});

describe('foldLaneCosts', () => {
  test('sums priced models per lane; an unlisted model and calls with no usage are unpriced', () => {
    const prices = new Map([['claude-sonnet-5', { input: 3, output: 15 }]]);
    const rows = [
      { lane_id: 'sms_draft', provider: 'anthropic', model: 'claude-sonnet-5', calls: 4, usage_unknown: 1, input_tokens: 1_000_000, cached_input_tokens: 0, cache_write_tokens: 0, output_tokens: 0, reasoning_tokens: 0 },
      { lane_id: 'sms_draft', provider: 'openai', model: 'gpt-unlisted', calls: 2, usage_unknown: 0, input_tokens: 5, output_tokens: 5 },
      { lane_id: 'call_extraction', provider: 'anthropic', model: null, calls: 3, usage_unknown: 3, input_tokens: 0, output_tokens: 0 },
    ];
    const out = llmCost.foldLaneCosts(rows, prices);
    expect(out.get('sms_draft').usd).toBeCloseTo(3, 9);
    expect(out.get('sms_draft').unpricedCalls).toBe(3);
    expect(out.get('call_extraction')).toEqual({ usd: 0, unpricedCalls: 3 });
  });
});

describe('findSpikes', () => {
  test('a spike clears both the minimum and the multiple of the lane average; a lane new this week needs only the minimum', () => {
    const day = new Map([['a', { usd: 12 }], ['b', { usd: 12 }], ['c', { usd: 4 }], ['d', { usd: 6 }]]);
    const baseline = new Map([['a', { usd: 14 }], ['b', { usd: 35 }], ['c', { usd: 0 }]]);
    const spikes = llmCost.findSpikes(day, baseline, { minUsd: 5, multiplier: 3, baselineDays: 7 });
    expect(spikes.map((s) => s.laneId)).toEqual(['a', 'd']);
    expect(spikes[0]).toEqual({ laneId: 'a', usd: 12, avgUsd: 2 });
  });
});

describe('pullPrices', () => {
  function fakeConn() {
    const calls = [];
    const conn = jest.fn(() => {
      const q = {
        insert: jest.fn((rows) => { calls.push(rows); return q; }),
        onConflict: jest.fn(() => q),
        merge: jest.fn(async () => undefined),
      };
      return q;
    });
    return { conn, calls };
  }

  test('a healthy feed upserts every usable model', async () => {
    const { conn, calls } = fakeConn();
    const res = await llmCost.pullPrices({ conn, fetchImpl: okFetch(feed([{ id: 'anthropic/claude-opus-5.5', pricing: { prompt: '0.000005', completion: '0.000025' } }])) });
    expect(res.models).toBe(llmCost.MIN_FEED_ROWS + 1);
    expect(calls[0].some((r) => r.model_key === 'claude-opus-5-5')).toBe(true);
    expect(conn).toHaveBeenCalledWith('llm_model_prices');
  });

  test('a short feed or an error answer writes nothing', async () => {
    const { conn, calls } = fakeConn();
    await expect(llmCost.pullPrices({ conn, fetchImpl: okFetch(feed([], 3)) })).rejects.toThrow(/only 3 usable models/);
    await expect(llmCost.pullPrices({ conn, fetchImpl: jest.fn(async () => ({ ok: false, status: 503 })) })).rejects.toThrow(/503/);
    expect(calls).toHaveLength(0);
  });
});

test('the spend check does nothing while the gate is off', async () => {
  const fetchImpl = jest.fn();
  await expect(llmCost.runLlmCostCheck({ conn: jest.fn(), fetchImpl })).resolves.toEqual({ ran: false, reason: 'gate_off' });
  expect(fetchImpl).not.toHaveBeenCalled();
  expect(mockRaise).not.toHaveBeenCalled();
});

// ── Real PostgreSQL ───────────────────────────────────────────────────

const connection = process.env.APP_TEST_DATABASE_URL;
const postgres = connection ? describe : describe.skip;
const schema = `llm_cost_${randomUUID().replaceAll('-', '')}`;

postgres('llm cost (PostgreSQL)', () => {
  const knex = require('knex');
  const migration = require('../models/migrations/20261001190000_llm_model_prices');
  let admin;
  let app;

  // 2026-10-01 07:40 ET (EDT) — the cron's own time.
  const NOW = new Date('2026-10-01T11:40:00Z');
  const atET = (day, hh = '12') => new Date(`${day}T${hh}:00:00-04:00`);

  beforeAll(async () => {
    const target = new URL(connection);
    const privateQa = /^\/waves_qa_[a-f0-9]{32}$/.test(target.pathname);
    const ci = process.env.CI === 'true' && ['localhost', '127.0.0.1'].includes(target.hostname) && target.pathname === '/waves_test';
    if (!privateQa && !ci) throw new Error('Use a private QA or isolated CI database');
    admin = knex({ client: 'pg', connection, pool: { min: 0, max: 1 } });
    await admin.schema.createSchema(schema);
    app = knex({ client: 'pg', connection, searchPath: [schema], pool: { min: 0, max: 2 } });
    // the ledger columns this module reads (migrations 20260731500000 + 20260904000010)
    await app.schema.createTable('llm_dispatch_log', (t) => {
      t.bigIncrements('id');
      t.string('row_kind', 20).notNullable().defaultTo('chain');
      t.boolean('ok');
      t.string('provider', 40);
      t.string('lane_id', 80);
      t.string('workload', 40);
      t.string('requested_model', 120);
      t.string('served_model', 120);
      for (const c of ['input_tokens', 'cached_input_tokens', 'cache_write_tokens', 'output_tokens', 'reasoning_tokens']) t.integer(c);
      t.timestamp('created_at', { useTz: true }).notNullable();
    });
    await migration.up(app);
  });

  afterAll(async () => {
    if (admin) await admin.raw(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    if (app) await app.destroy();
    if (admin) await admin.destroy();
  });

  beforeEach(async () => {
    await app('llm_dispatch_log').del();
    await app('llm_model_prices').del();
  });

  const row = (over) => ({
    row_kind: 'call', ok: true, provider: 'anthropic', lane_id: 'sms_draft', workload: null,
    requested_model: 'claude-sonnet-5', served_model: 'claude-sonnet-5',
    input_tokens: 1_000_000, cached_input_tokens: 0, cache_write_tokens: 0, output_tokens: 0, reasoning_tokens: 0,
    ...over,
  });

  test('the migration is idempotent both ways', async () => {
    await migration.up(app);
    await migration.down(app);
    expect(await app.schema.hasTable('llm_model_prices')).toBe(false);
    await migration.down(app);
    await migration.up(app);
    expect(await app.schema.hasTable('llm_model_prices')).toBe(true);
  });

  test('a pull upserts prices, and a second pull updates them in place', async () => {
    const model = (prompt) => ({ id: 'anthropic/claude-sonnet-5', pricing: { prompt, completion: '0.000015' } });
    await llmCost.pullPrices({ conn: app, fetchImpl: okFetch(feed([model('0.000003')])), now: NOW });
    await llmCost.pullPrices({ conn: app, fetchImpl: okFetch(feed([model('0.000004')])), now: NOW });
    const rows = await app('llm_model_prices').where({ model_key: 'claude-sonnet-5' });
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].input_per_mtok)).toBe(4);
    const { map } = await llmCost.loadPrices(app);
    expect(map.get('claude-sonnet-5')).toMatchObject({ input: 4, output: 15, cacheRead: null });
  });

  test('laneCosts reads only live call / session_turn rows inside the window', async () => {
    await llmCost.pullPrices({ conn: app, fetchImpl: okFetch(feed([{ id: 'anthropic/claude-sonnet-5', pricing: { prompt: '0.000003', completion: '0.000015' } }])), now: NOW });
    const at = atET('2026-09-30');
    await app('llm_dispatch_log').insert([
      row({ created_at: at }),
      row({ created_at: at, served_model: null }), // falls back to the requested model
      row({ created_at: at, row_kind: 'session_turn', workload: 'live' }),
      row({ created_at: at, row_kind: 'session' }), // cumulative row: never summed
      row({ created_at: at, workload: 'replay' }), // evaluator traffic: never summed
      row({ created_at: atET('2026-09-29') }), // outside the window
      row({ created_at: at, input_tokens: null }), // usage never captured
      row({ created_at: at, served_model: 'claude-unlisted' }),
    ]);
    const res = await llmCost.laneCosts(atET('2026-09-30', '00'), atET('2026-10-01', '00'), { conn: app });
    expect(res.priced).toBe(true);
    const lane = res.byLane.get('sms_draft');
    expect(lane.usd).toBeCloseTo(9, 9); // three priced rows × 1M input × $3
    expect(lane.unpricedCalls).toBe(2);
  });

  test('the spend check pulls missing prices, raises one item for a spike, then closes it once spend is normal', async () => {
    process.env.GATE_LLM_COST_TRACKING = 'true';
    mockRaise.mockResolvedValue({ id: 1 });
    const fetchImpl = okFetch(feed([{ id: 'anthropic/claude-sonnet-5', pricing: { prompt: '0.000003', completion: '0.000015' } }]));
    // yesterday (09-30 ET): 4M input = $12; the 7 days before: $3 in total
    await app('llm_dispatch_log').insert([
      row({ created_at: atET('2026-09-30'), input_tokens: 4_000_000 }),
      row({ created_at: atET('2026-09-25'), input_tokens: 1_000_000 }),
    ]);

    const res = await llmCost.runLlmCostCheck({ now: NOW, conn: app, fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(res).toMatchObject({ ran: true, raised: true, spikes: 1, dedupeKey: 'llm-cost-spike:2026-09-30' });
    expect(mockRaise).toHaveBeenCalledTimes(1);
    const [category, spec, opts] = mockRaise.mock.calls[0];
    expect(category).toBe('llm_cost');
    expect(spec).toMatchObject({ area: 'System', severity: 'needs-you', link: '/admin/agents', doneWhen: 'spend_reviewed', who: 'person' });
    expect(spec.why).toMatch(/cost \$12\.00 yesterday vs \$0\.43 on an average day$/);
    expect(opts.metadata.spikes).toEqual([{ laneId: 'sms_draft', usd: 12, avgUsd: 0.4286 }]);
    // the composed copy obeys the notification rules
    const { composeAdminAlert } = jest.requireActual('../services/admin-alert-compose');
    expect(() => composeAdminAlert(spec)).not.toThrow();

    // the next morning: prices are fresh (no fetch) and spend is normal → the standing item closes
    mockOpenKeys.mockResolvedValue(['llm-cost-spike:2026-09-30']);
    const next = await llmCost.runLlmCostCheck({ now: new Date('2026-10-02T11:40:00Z'), conn: app, fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(next).toMatchObject({ ran: true, raised: false, spikes: 0 });
    expect(mockCloseKeys).toHaveBeenCalledWith(app, ['llm-cost-spike:2026-09-30'], 'spend_normal', expect.any(Object));
  });

  test('with no stored prices and a failing feed, the check fails loudly', async () => {
    process.env.GATE_LLM_COST_TRACKING = 'true';
    await expect(llmCost.runLlmCostCheck({ now: NOW, conn: app, fetchImpl: jest.fn(async () => ({ ok: false, status: 500 })) })).rejects.toThrow(/500/);
    expect(mockRaise).not.toHaveBeenCalled();
  });
});
