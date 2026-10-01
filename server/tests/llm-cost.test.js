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
const mockOpenMeta = jest.fn();
jest.mock('../services/admin-alert-episodes', () => ({
  openAdminAlertKeys: (...a) => mockOpenKeys(...a),
  openAdminAlertMetadata: (...a) => mockOpenMeta(...a),
  closeAdminAlertKeys: (...a) => mockCloseKeys(...a),
}));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const llmCost = require('../services/llm-cost');

const saved = {};
const ENV = ['GATE_LLM_COST_TRACKING', 'GATE_LLM_CALL_LEDGER', 'LLM_COST_ALERT_MIN_USD', 'LLM_COST_ALERT_MULTIPLIER'];
beforeAll(() => { for (const k of ENV) saved[k] = process.env[k]; });
afterAll(() => { for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });
beforeEach(() => {
  for (const k of ENV) delete process.env[k];
  mockRaise.mockReset();
  mockOpenKeys.mockReset().mockResolvedValue([]);
  mockCloseKeys.mockReset().mockResolvedValue(0);
  mockOpenMeta.mockReset().mockResolvedValue([]);
});

// A feed body with `extra` filler models so it clears MIN_FEED_ROWS.
function feed(models, extra = llmCost.MIN_FEED_ROWS) {
  const filler = Array.from({ length: extra }, (_, i) => ({ id: `openai/filler-${i}`, pricing: { prompt: '0.000001', completion: '0.000002' } }));
  return { data: [...models, ...filler] };
}
const okFetch = (body) => jest.fn(async () => ({ ok: true, status: 200, json: async () => body }));

describe('model ids', () => {
  test('a feed id and the ledger served model normalise the same way; a date stamp is kept', () => {
    expect(llmCost.normalizeModelId('anthropic/claude-haiku-4.5')).toBe('claude-haiku-4-5');
    expect(llmCost.normalizeModelId('claude-haiku-4-5-20251001')).toBe('claude-haiku-4-5-20251001');
    expect(llmCost.normalizeModelId('openai/gpt-5.6-sol')).toBe(llmCost.normalizeModelId('gpt-5.6-sol'));
    expect(llmCost.normalizeModelId('openai/gpt-4o-2024-08-06')).toBe('gpt-4o-2024-08-06');
    expect(llmCost.normalizeModelId('anthropic/claude-sonnet-4.5:thinking')).toBe('claude-sonnet-4-5');
    expect(llmCost.normalizeModelId('')).toBeNull();
    expect(llmCost.normalizeModelId(null)).toBeNull();
  });

  test('a listed snapshot is priced as itself, never as its alias', () => {
    const prices = new Map([
      ['gpt-4o', { input: 2.5, output: 10 }],
      ['gpt-4o-2024-05-13', { input: 5, output: 15 }],
    ]);
    expect(llmCost.priceFor(prices, 'gpt-4o-2024-05-13')).toEqual({ input: 5, output: 15 });
    expect(llmCost.priceFor(prices, 'gpt-4o')).toEqual({ input: 2.5, output: 10 });
  });

  test('an unlisted snapshot takes its alias price only when no listed snapshot of that alias costs differently', () => {
    const aliasOnly = new Map([['claude-haiku-4-5', { input: 1, output: 5 }]]);
    expect(llmCost.priceFor(aliasOnly, 'claude-haiku-4-5-20251001')).toEqual({ input: 1, output: 5 });
    const agreeing = new Map([['gpt-4o', { input: 2.5, output: 10 }], ['gpt-4o-2024-11-20', { input: 2.5, output: 10 }]]);
    expect(llmCost.priceFor(agreeing, 'gpt-4o-2024-08-06')).toEqual({ input: 2.5, output: 10 });
    const disagreeing = new Map([['gpt-4o', { input: 2.5, output: 10 }], ['gpt-4o-2024-05-13', { input: 5, output: 15 }]]);
    expect(llmCost.priceFor(disagreeing, 'gpt-4o-2024-08-06')).toBeNull();
  });

  test('a preview build or other lookalike the feed does not list is unpriced', () => {
    const prices = new Map([['gemini-3-8-flash', { input: 0.3, output: 2.5 }]]);
    expect(llmCost.priceFor(prices, 'gemini-3.8-flash-preview-09-2026')).toBeNull();
    expect(llmCost.priceFor(prices, 'gemini-3.8-pro')).toBeNull();
    expect(llmCost.priceFor(prices, 'gemini-3.8-flash')).toEqual({ input: 0.3, output: 2.5 });
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
    expect(Object.keys(byKey).sort()).toEqual(['claude-opus-5-5', 'gemini-3-8-flash', 'gpt-5-6-sol', 'gpt-5-6-sol-2026-08-01']);
    expect(byKey['claude-opus-5-5']).toMatchObject({ provider: 'anthropic', input_per_mtok: 5, output_per_mtok: 25, cache_read_per_mtok: 0.5, cache_write_per_mtok: 6.25, fetched_at: at });
    expect(byKey['gemini-3-8-flash']).toMatchObject({ provider: 'gemini', cache_read_per_mtok: null, reasoning_per_mtok: 2.5 });
    // a dated snapshot keeps its own row and price beside the alias
    expect(byKey['gpt-5-6-sol']).toMatchObject({ source_model_id: 'openai/gpt-5.6-sol', input_per_mtok: 1.5 });
    expect(byKey['gpt-5-6-sol-2026-08-01']).toMatchObject({ source_model_id: 'openai/gpt-5.6-sol-2026-08-01', input_per_mtok: 2 });
  });
});

describe('long-prompt tiers', () => {
  const M = 1_000_000;

  test('the feed\'s overrides are kept as tiers per million tokens; an unreadable tier leaves the model out', () => {
    const at = new Date('2026-10-01T11:40:00Z');
    const rows = llmCost.parseFeed({
      data: [
        { id: 'openai/gpt-6-sol', pricing: { prompt: '0.000002', completion: '0.000008', overrides: [{ min_prompt_tokens: 272000, prompt: '0.000004', completion: '0.000015', input_cache_read: '0.0000004' }] } },
        { id: 'openai/gpt-6-luna', pricing: { prompt: '0.0000001', completion: '0.0000004', overrides: [{ prompt: '0.0000002', completion: '0.00000075' }] } },
        { id: 'openai/gpt-6-astra', pricing: { prompt: '0.00001', completion: '0.00004' } },
      ],
    }, at);
    const byKey = Object.fromEntries(rows.map((r) => [r.model_key, r]));
    expect(Object.keys(byKey).sort()).toEqual(['gpt-6-astra', 'gpt-6-sol']);
    expect(JSON.parse(byKey['gpt-6-sol'].pricing_tiers)).toEqual([
      { min_prompt_tokens: 272000, input_per_mtok: 4, output_per_mtok: 15, cache_read_per_mtok: 0.4, cache_write_per_mtok: null, reasoning_per_mtok: null },
    ]);
    expect(byKey['gpt-6-astra'].pricing_tiers).toBeNull();
  });

  test('a cache write bills at the higher of the five-minute and one-hour rates: the ledger does not say which', () => {
    const [row] = llmCost.parseFeed({ data: [{ id: 'anthropic/claude-opus-5.5', pricing: { prompt: '0.000004', completion: '0.00002', input_cache_write: '0.000005', input_cache_write_1h: '0.000008' } }] }, new Date());
    expect(row.cache_write_per_mtok).toBe(8);
    const [only5m] = llmCost.parseFeed({ data: [{ id: 'anthropic/claude-opus-5.5', pricing: { prompt: '0.000004', completion: '0.00002', input_cache_write: '0.000005' } }] }, new Date());
    expect(only5m.cache_write_per_mtok).toBe(5);
  });

  test('a call bills at the highest tier its whole prompt reaches', () => {
    const p = { input: 2, output: 8, tiers: [{ minPromptTokens: 272000, input: 4, output: 15 }] };
    expect(llmCost.ratesForCall(p, 271999)).toBe(p);
    expect(llmCost.ratesForCall(p, 272000)).toBe(p.tiers[0]);
    // anthropic counts cache reads and writes into the prompt; the others report them inside input
    expect(llmCost.promptTokens('anthropic', { input_tokens: 100, cached_input_tokens: 200, cache_write_tokens: 300 })).toBe(600);
    expect(llmCost.promptTokens('openai', { input_tokens: 600, cached_input_tokens: 200 })).toBe(600);
  });

  test('per-call rows are priced at their tier, summed rows at the base rate, and a tier with no rate is unpriced', () => {
    const prices = new Map([
      ['gpt-6-sol', { input: 2, output: 8, tiers: [{ minPromptTokens: 272000, input: 4, output: 15 }] }],
      ['gpt-6-luna', { input: 0.1, output: 0.4, tiers: [{ minPromptTokens: 272000, input: null, output: null }] }],
    ]);
    const rows = [
      { lane_id: 'report', provider: 'openai', model: 'gpt-6-sol', calls: 3, usage_unknown: 0, input_tokens: M, output_tokens: 0 },
      { lane_id: 'report', provider: 'openai', model: 'gpt-6-sol', calls: 1, usage_unknown: 0, per_call: true, input_tokens: M, output_tokens: 0 },
      { lane_id: 'report', provider: 'openai', model: 'gpt-6-luna', calls: 1, usage_unknown: 0, per_call: true, input_tokens: 300000, output_tokens: 0 },
    ];
    const out = llmCost.foldLaneCosts(rows, prices).get('report');
    expect(out.usd).toBeCloseTo(2 + 4, 9);
    expect(out.unpricedCalls).toBe(1);
  });

  test('a session turn reaching a tier may be several short calls: unpriced; one below every tier stays base-rate', () => {
    const prices = new Map([['claude-opus-5-5', { input: 5, output: 25, tiers: [{ minPromptTokens: 200000, input: 10, output: 37.5 }] }]]);
    const turn = (input) => ({ lane_id: 'lead_agent', row_kind: 'session_turn', provider: 'anthropic', model: 'claude-opus-5-5', calls: 1, usage_unknown: 0, per_call: true, input_tokens: input, output_tokens: 0 });
    // three 90k-token calls in one turn: 270k in total, no single call past 200k
    const out = llmCost.foldLaneCosts([turn(270000), { ...turn(100000), per_call: undefined }], prices).get('lead_agent');
    expect(out.usd).toBeCloseTo(0.5, 9);
    expect(out.unpricedCalls).toBe(1);
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
    // a cache write can cost more than input: no listed write rate = unpriced, never the input rate
    expect(llmCost.costUsd('anthropic', { input_tokens: M, cache_write_tokens: 1 }, { input: 3, output: 15 })).toBeNull();
    expect(llmCost.costUsd('anthropic', { input_tokens: M, cache_write_tokens: 0 }, { input: 3, output: 15 })).toBeCloseTo(3, 9);
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
        whereNotIn: jest.fn(() => q),
        del: jest.fn(async () => 0),
      };
      return q;
    });
    conn.transaction = jest.fn((work) => work(conn));
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

test('the spend check does nothing while the call ledger is off: no data is not a recovery', async () => {
  process.env.GATE_LLM_COST_TRACKING = 'true';
  const fetchImpl = jest.fn();
  await expect(llmCost.runLlmCostCheck({ conn: jest.fn(), fetchImpl })).resolves.toEqual({ ran: false, reason: 'ledger_off' });
  expect(fetchImpl).not.toHaveBeenCalled();
  expect(mockRaise).not.toHaveBeenCalled();
  expect(mockCloseKeys).not.toHaveBeenCalled();
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

  test('a pull is a snapshot: a model the feed no longer lists loses its stored price', async () => {
    const sonnet = { id: 'anthropic/claude-sonnet-5', pricing: { prompt: '0.000003', completion: '0.000015' } };
    const opus = { id: 'anthropic/claude-opus-5.5', pricing: { prompt: '0.000005', completion: '0.000025' } };
    await llmCost.pullPrices({ conn: app, fetchImpl: okFetch(feed([sonnet, opus])), now: NOW });
    const res = await llmCost.pullPrices({ conn: app, fetchImpl: okFetch(feed([sonnet])), now: NOW });
    expect(res.retired).toBe(1);
    const { map } = await llmCost.loadPrices(app);
    expect(map.has('claude-opus-5-5')).toBe(false);
    expect(map.has('claude-sonnet-5')).toBe(true);
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

  test('laneCosts prices a call that reaches a long-prompt tier at that tier, and the calls below it at the base rate', async () => {
    const sol = { id: 'openai/gpt-6-sol', pricing: { prompt: '0.000002', completion: '0.000008', overrides: [{ min_prompt_tokens: 272000, prompt: '0.000004', completion: '0.000015' }] } };
    await llmCost.pullPrices({ conn: app, fetchImpl: okFetch(feed([sol])), now: NOW });
    const at = atET('2026-09-30');
    const openai = { provider: 'openai', requested_model: 'gpt-6-sol', served_model: 'gpt-6-sol', created_at: at };
    await app('llm_dispatch_log').insert([
      row({ ...openai, input_tokens: 200_000 }),
      row({ ...openai, input_tokens: 200_000 }), // together past the threshold, each below it: base rate
      row({ ...openai, input_tokens: 300_000 }), // one long call: the tier rate
    ]);
    const res = await llmCost.laneCosts(atET('2026-09-30', '00'), atET('2026-10-01', '00'), { conn: app });
    expect(res.byLane.get('sms_draft').usd).toBeCloseTo(0.4 * 2 + 0.3 * 4, 9);
    expect(res.byLane.get('sms_draft').unpricedCalls).toBe(0);
  });

  test('a cache-writing call on a model with no listed write rate leaves only that call unpriced', async () => {
    await llmCost.pullPrices({ conn: app, fetchImpl: okFetch(feed([{ id: 'anthropic/claude-sonnet-5', pricing: { prompt: '0.000003', completion: '0.000015' } }])), now: NOW });
    const at = atET('2026-09-30');
    await app('llm_dispatch_log').insert([row({ created_at: at }), row({ created_at: at }), row({ created_at: at, cache_write_tokens: 10_000 })]);
    const res = await llmCost.laneCosts(atET('2026-09-30', '00'), atET('2026-10-01', '00'), { conn: app });
    expect(res.byLane.get('sms_draft').usd).toBeCloseTo(6, 9);
    expect(res.byLane.get('sms_draft').unpricedCalls).toBe(1);
  });

  test('a session turn whose total prompt reaches a tier is unpriced, not billed at the tier', async () => {
    const sol = { id: 'openai/gpt-6-sol', pricing: { prompt: '0.000002', completion: '0.000008', overrides: [{ min_prompt_tokens: 272000, prompt: '0.000004', completion: '0.000015' }] } };
    await llmCost.pullPrices({ conn: app, fetchImpl: okFetch(feed([sol])), now: NOW });
    const at = atET('2026-09-30');
    const openai = { provider: 'openai', requested_model: 'gpt-6-sol', served_model: 'gpt-6-sol', created_at: at, row_kind: 'session_turn' };
    await app('llm_dispatch_log').insert([row({ ...openai, input_tokens: 300_000 }), row({ ...openai, input_tokens: 100_000 })]);
    const res = await llmCost.laneCosts(atET('2026-09-30', '00'), atET('2026-10-01', '00'), { conn: app });
    expect(res.byLane.get('sms_draft').usd).toBeCloseTo(0.1 * 2, 9);
    expect(res.byLane.get('sms_draft').unpricedCalls).toBe(1);
  });

  test('the spend check pulls missing prices, raises one item for a spike, then closes it once spend is normal', async () => {
    process.env.GATE_LLM_COST_TRACKING = 'true';
    process.env.GATE_LLM_CALL_LEDGER = 'true';
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

    // the next morning with no ledger rows for 10-01 at all: no data, so the standing item stays
    mockOpenKeys.mockResolvedValue(['llm-cost-spike:2026-09-30']);
    const silent = await llmCost.runLlmCostCheck({ now: new Date('2026-10-02T11:40:00Z'), conn: app, fetchImpl });
    expect(silent).toMatchObject({ ran: true, raised: false, reason: 'no_ledger_rows' });
    expect(mockCloseKeys).not.toHaveBeenCalled();

    // with 10-01's ordinary spend recorded: prices are fresh (no fetch) and spend is normal → the item closes
    await app('llm_dispatch_log').insert(row({ created_at: atET('2026-10-01'), input_tokens: 100_000 }));
    const next = await llmCost.runLlmCostCheck({ now: new Date('2026-10-02T11:40:00Z'), conn: app, fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(next).toMatchObject({ ran: true, raised: false, spikes: 0 });
    expect(mockCloseKeys).toHaveBeenCalledWith(app, ['llm-cost-spike:2026-09-30'], 'spend_normal', expect.any(Object));
  });

  test('a standing spike item stays open while its lane has unpriced calls: $0 priced is neither a recovery nor superseded', async () => {
    process.env.GATE_LLM_COST_TRACKING = 'true';
    process.env.GATE_LLM_CALL_LEDGER = 'true';
    mockRaise.mockResolvedValue({ id: 2 });
    const fetchImpl = okFetch(feed([{ id: 'anthropic/claude-sonnet-5', pricing: { prompt: '0.000003', completion: '0.000015' } }]));
    const NEXT = new Date('2026-10-02T11:40:00Z');
    const standing = [
      { dedupeKey: 'llm-cost-spike:2026-09-29', spikes: [{ laneId: 'sms_draft', usd: 12, avgUsd: 0.43 }] },
      { dedupeKey: 'llm-cost-spike:2026-09-30', spikes: [{ laneId: 'call_extraction', usd: 9, avgUsd: 0.5 }] },
    ];
    mockOpenKeys.mockResolvedValue(standing.map((m) => m.dedupeKey));
    mockOpenMeta.mockResolvedValue(standing);
    // 10-01: sms_draft ran only on a model the feed no longer lists
    await app('llm_dispatch_log').insert(row({ created_at: atET('2026-10-01'), served_model: 'claude-unlisted', input_tokens: 9_000_000 }));

    // no new spike: only the item naming a judgeable lane closes
    await llmCost.runLlmCostCheck({ now: NEXT, conn: app, fetchImpl });
    expect(mockCloseKeys).toHaveBeenCalledWith(app, ['llm-cost-spike:2026-09-30'], 'spend_normal', expect.any(Object));

    // a new spike on another lane supersedes the judgeable item, never the held one
    mockCloseKeys.mockClear();
    await app('llm_dispatch_log').insert(row({ created_at: atET('2026-10-01'), lane_id: 'call_extraction', input_tokens: 4_000_000 }));
    const res = await llmCost.runLlmCostCheck({ now: NEXT, conn: app, fetchImpl });
    expect(res).toMatchObject({ raised: true, dedupeKey: 'llm-cost-spike:2026-10-01' });
    expect(mockCloseKeys).toHaveBeenCalledWith(app, ['llm-cost-spike:2026-09-30'], 'superseded', expect.any(Object));

    // the items cannot be read: nothing closes
    mockCloseKeys.mockClear();
    mockOpenMeta.mockRejectedValue(new Error('db down'));
    await llmCost.runLlmCostCheck({ now: NEXT, conn: app, fetchImpl });
    expect(mockCloseKeys).not.toHaveBeenCalled();
  });

  test('with no stored prices and a failing feed, the check fails loudly', async () => {
    process.env.GATE_LLM_COST_TRACKING = 'true';
    process.env.GATE_LLM_CALL_LEDGER = 'true';
    await expect(llmCost.runLlmCostCheck({ now: NOW, conn: app, fetchImpl: jest.fn(async () => ({ ok: false, status: 500 })) })).rejects.toThrow(/500/);
    expect(mockRaise).not.toHaveBeenCalled();
  });
});
