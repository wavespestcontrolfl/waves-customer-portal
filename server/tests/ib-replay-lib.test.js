/**
 * Intelligence Bar replay test helpers (ops/agents/ib-replay-lib.js) and the
 * runner's pure parts (ib-replay.js, ib-replay-export.js). Synthetic data only.
 */

const os = require('os');
const path = require('path');
const lib = require('../../ops/agents/ib-replay-lib');
const replay = require('../../ops/agents/ib-replay');
const exporter = require('../../ops/agents/ib-replay-export');

const REPO_ROOT = path.resolve(__dirname, '..', '..');

const conversation = [
  { role: 'user', content: 'When is the next visit for Pat Example?' },
  { role: 'assistant', content: [{ type: 'thinking', thinking: '' }, { type: 'tool_use', id: 't1', name: 'search_customers', input: { query: 'Pat Example' } }] },
  { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: '[{"id":"c1"}]' }] },
  { role: 'assistant', content: [{ type: 'tool_use', id: 't2', name: 'get_schedule', input: { customer_id: 'c1' } }] },
  { role: 'assistant', content: [{ type: 'text', text: 'Tuesday.' }] },
];
const task = (overrides = {}) => ({
  id: 'task-1', created_at: '2026-11-01T14:00:00Z', checkpoint: conversation, cards: [],
  request: { prompt: 'When is the next visit for Pat Example?', context: 'customers', pageData: { page: 'customers' }, conversationHistory: [] },
  page_context: { page: 'ignored' }, target: { target: { customer_id: 'c1' } }, response: { response: 'Tuesday.' },
  ...overrides,
});

describe('replay cases from saved bar requests', () => {
  test('the tape pairs each tool call with its recorded answer, in order', () => {
    expect(lib.buildTape(conversation)).toEqual([
      { name: 'search_customers', input: { query: 'Pat Example' }, result: '[{"id":"c1"}]', isError: false },
      { name: 'get_schedule', input: { customer_id: 'c1' }, result: null, isError: null },
    ]);
    expect(lib.buildTape(null)).toEqual([]);
  });

  test('a request becomes a read case, or a card case only when the operator confirmed a card', () => {
    const read = lib.caseFromTask(task());
    expect(read).toMatchObject({ id: 'task-1', kind: 'read', context: 'customers', pageData: { page: 'customers' }, firstTool: { name: 'search_customers', input: { query: 'Pat Example' } }, target: { target: { customer_id: 'c1' } }, answer: 'Tuesday.' });

    const card = lib.caseFromTask(task({ cards: [
      { tool_name: 'reschedule_visit', params: { visit_id: 'v1', _ib_task_context: { private: true } }, status: 'confirmed' },
      { tool_name: 'send_sms', params: { to: 'x' }, status: 'cancelled' },
    ] }));
    expect(card.kind).toBe('card');
    expect(card.cards).toEqual([{ tool: 'reschedule_visit', params: { visit_id: 'v1' } }]);

    expect(lib.caseFromTask(task({ cards: [{ tool_name: 'send_sms', params: {}, status: 'expired' }] }))).toBeNull();
    expect(lib.caseFromTask(task({ checkpoint: [{ role: 'assistant', content: [{ type: 'text', text: 'Hi' }] }] }))).toBeNull();
    expect(lib.caseFromTask(task({ request: { prompt: 'p' } })).pageData).toEqual({ page: 'ignored' });
  });

  test('picking splits card and read cases, and one kind fills the other kind\'s short side', () => {
    const many = (kind, n) => Array.from({ length: n }, (_, i) => ({ id: `${kind}${i}`, kind }));
    expect(lib.pickCases([...many('card', 30), ...many('read', 30)], 40).map((c) => c.kind).join()).toBe([...Array(20).fill('card'), ...Array(20).fill('read')].join());
    expect(lib.pickCases([...many('card', 5), ...many('read', 50)], 40).filter((c) => c.kind === 'card')).toHaveLength(5);
    expect(lib.pickCases([...many('card', 50), ...many('read', 3)], 40)).toHaveLength(40);
  });
});

describe('scoring and cost', () => {
  test('the first tool passes on the same name; same input ignores key order', () => {
    const expected = { name: 'get_schedule', input: { customer_id: 'c1', days: 7 } };
    expect(lib.scoreFirstTool(expected, { name: 'get_schedule', input: { days: 7, customer_id: 'c1' } })).toEqual({ verdict: 'pass', sameInput: true });
    expect(lib.scoreFirstTool(expected, { name: 'get_schedule', input: { customer_id: 'c2' } })).toEqual({ verdict: 'pass', sameInput: false });
    expect(lib.scoreFirstTool(expected, { name: 'read_admin_data', input: {} })).toEqual({ verdict: 'fail', sameInput: false });
    expect(lib.scoreFirstTool(expected, null)).toEqual({ verdict: 'no_tool', sameInput: false });
  });

  test('cost uses Opus 5.5 list prices; an unsplit cache write prices as the 1 hour write', () => {
    const usage = { input_tokens: 1000000, output_tokens: 100000, cache_read_input_tokens: 1000000, cache_creation_input_tokens: 1000000 };
    expect(lib.costUsd('claude-opus-5-5', usage)).toBeCloseTo(4 + 2 + 0.2 + 8, 6);
    const split = { ...usage, cache_creation: { ephemeral_5m_input_tokens: 1000000, ephemeral_1h_input_tokens: 0 } };
    expect(lib.costUsd('claude-opus-5-5', split)).toBeCloseTo(4 + 2 + 0.2 + 5, 6);
    expect(lib.costUsd('some-other-model', usage)).toBeNull();
  });
});

describe('replay safety', () => {
  const caller = { PATH: '/bin', HOME: '/home/x', USER: 'owner', STRIPE_SECRET_KEY: 'sk', TWILIO_AUTH_TOKEN: 't', DATABASE_URL: 'postgres://prod/db', RAILWAY_ENVIRONMENT: 'production' };
  const profile = { GATE_IB_PLATFORM: 'true', GATE_IB_OWNER_DIRECT: 'true', MODEL_FLAGSHIP: 'claude-opus-5-5', IB_FULL_ACCESS_EMAILS: 'owner@example.com', IB_SIGNING_KEY: 'k', SENDGRID_API_KEY: 's' };

  test('the environment keeps only the bar settings and a local database, never a credential', () => {
    const env = lib.replayEnv(caller, profile, { databaseUrl: 'postgresql://localhost/ib_replay' });
    expect(env).toEqual({
      PATH: '/bin', HOME: '/home/x', USER: 'owner', GATE_IB_PLATFORM: 'true', MODEL_FLAGSHIP: 'claude-opus-5-5', IB_FULL_ACCESS_EMAILS: 'owner@example.com',
      GATE_IB_OWNER_DIRECT: 'false', GATE_IB_OPENAI_BACKUP: 'false', GATE_AI_CREDIT_KEYS: 'false',
      NODE_ENV: 'development', WAVES_LOCAL_DEV: '1', JWT_SECRET: 'ib-replay-local',
      DATABASE_URL: 'postgresql://localhost/ib_replay', ANTHROPIC_API_KEY: 'ib-replay-dry-run',
    });
    expect(lib.replayEnv(caller, {}, { databaseUrl: 'postgresql://127.0.0.1:5432/ib_replay_b', apiKey: 'real' }).ANTHROPIC_API_KEY).toBe('real');
  });

  test('only a localhost database named ib_replay* is accepted', () => {
    for (const url of ['postgres://prod.example.com/ib_replay', 'postgresql://localhost/waves_test', 'not a url', undefined]) {
      expect(() => lib.localDatabaseUrl(url)).toThrow(/ib_replay/);
    }
  });

  test('case and result files must be outside the checkout', () => {
    expect(() => lib.assertOutsideRepo(path.join(REPO_ROOT, 'cases.json'), REPO_ROOT)).toThrow(/outside the checkout/);
    expect(() => lib.assertOutsideRepo(undefined, REPO_ROOT)).toThrow(/outside the checkout/);
    const outside = path.join(os.tmpdir(), 'ib-replay', 'cases.json');
    expect(lib.assertOutsideRepo(outside, REPO_ROOT)).toBe(outside);
    expect(() => exporter.parseArgs(['--out', path.join(REPO_ROOT, 'x.json')])).toThrow(/outside the checkout/);
    expect(() => exporter.parseArgs(['--out', outside, '--days', '45'])).toThrow(/--days/);
  });

  test('--set accepts bar settings only', () => {
    expect(replay.overrides(['GATE_IB_TOOL_ADDITIONS=true', 'MODEL_FLAGSHIP=claude-sonnet-5-5'])).toEqual({ GATE_IB_TOOL_ADDITIONS: 'true', MODEL_FLAGSHIP: 'claude-sonnet-5-5' });
    expect(() => replay.overrides(['ANTHROPIC_API_KEY=x'])).toThrow(/bar setting/);
    expect(() => replay.overrides(['GATE_X'])).toThrow(/bar setting/);
  });

  test('only the first model call of a case is sent; it and every later call get a final answer', async () => {
    const send = jest.fn().mockResolvedValue({ usage: { input_tokens: 10 }, content: [{ type: 'tool_use', name: 'get_schedule', input: { customer_id: 'c1' } }] });
    const state = { current: { calls: 0 } };
    const first = await replay.measure(state, { model: 'claude-opus-5-5', tools: [{}, {}] }, send);
    const second = await replay.measure(state, { model: 'claude-opus-5-5' }, send);
    expect(send).toHaveBeenCalledTimes(1);
    expect(state.current).toMatchObject({ calls: 2, toolCount: 2, actual: { name: 'get_schedule', input: { customer_id: 'c1' } }, usage: { input_tokens: 10 } });
    for (const reply of [first, second]) expect(reply).toMatchObject({ stop_reason: 'end_turn', content: [{ type: 'text' }] });

    const dry = { current: { calls: 0 } };
    await replay.measure(dry, { model: 'claude-opus-5-5', tools: [] }, null);
    expect(dry.current).toMatchObject({ calls: 1, toolCount: 0 });
    expect(dry.current.actual).toBeUndefined();
  });

  test('a model with no list price is never sent, and an API error is kept for the result', async () => {
    const send = jest.fn();
    const unpriced = { current: { calls: 0 } };
    await replay.measure(unpriced, { model: 'claude-unknown-9' }, send);
    expect(send).not.toHaveBeenCalled();
    expect(unpriced.current.error).toMatch(/no list price for claude-unknown-9/);

    const failing = { current: { calls: 0 } };
    await expect(replay.measure(failing, { model: 'claude-opus-5-5' }, jest.fn().mockRejectedValue(new Error('overloaded')))).rejects.toThrow('overloaded');
    expect(failing.current.error).toBe('overloaded');
  });
});

test('compare lists the cases whose verdict changed', () => {
  const run = (verdicts) => ({ results: verdicts.map((verdict, i) => ({ id: `c${i}`, kind: 'read', expected: 'get_schedule', verdict, actual: verdict === 'pass' ? 'get_schedule' : 'read_admin_data' })) });
  const report = lib.compareRuns(run(['pass', 'pass', 'fail']), run(['pass', 'fail', 'pass']));
  expect(report).toMatchObject({ passBefore: 2, passAfter: 2 });
  expect(report.changed.map((r) => [r.id, r.before, r.after])).toEqual([['c1', 'pass', 'fail'], ['c2', 'fail', 'pass']]);
});
