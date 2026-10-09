// GATE_AGENT_SESSION_GUARD: a hard spend cap on a Managed Agents session, and
// a user.interrupt for a session its runner gave up on. Both must be inert
// with the gate off, and the interrupt must never throw into the ledger
// recorder that calls it on every runner exit.

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const { sessionBudget, stopAbandonedSession } = require('../services/agent-control/session-guard');
const { isBudgetReached, isSessionTerminal } = require('../services/agent-control/session-events');

const ORIGINAL_ENV = { ...process.env };
const ORIGINAL_FETCH = global.fetch;

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV, ANTHROPIC_API_KEY: 'k', GATE_AGENT_SESSION_GUARD: 'true' };
  global.fetch = jest.fn(async () => ({ ok: true, status: 200, json: async () => ({}) }));
});
afterAll(() => { process.env = ORIGINAL_ENV; global.fetch = ORIGINAL_FETCH; });

describe('sessionBudget', () => {
  it('gives the lane cap in the shape the sessions API takes: cents as an integer string, USD', () => {
    expect(sessionBudget('agent_lead')).toEqual({ budget: { type: 'limit', max_list_cost: { amount: '100', currency: 'USD' } } });
  });

  it('adds nothing with the gate off', () => {
    delete process.env.GATE_AGENT_SESSION_GUARD;
    expect(sessionBudget('agent_lead')).toEqual({});
  });

  it('never caps the customer assistant: a pause there is customer-facing', () => {
    expect(sessionBudget('agent_assistant')).toEqual({});
  });

  it('takes a per-lane override and ignores one the API would reject', () => {
    process.env.AGENT_SESSION_BUDGET_CENTS_AGENT_LEAD = '250';
    expect(sessionBudget('agent_lead').budget.max_list_cost.amount).toBe('250');
    for (const bad of ['2.50', '0', '025', '-5', 'abc']) {
      process.env.AGENT_SESSION_BUDGET_CENTS_AGENT_LEAD = bad;
      expect(sessionBudget('agent_lead').budget.max_list_cost.amount).toBe('100');
    }
  });
});

describe('stopAbandonedSession', () => {
  const stop = (over = {}) => stopAbandonedSession({ laneId: 'agent_content', sessionId: 'sess-1', failure: 'session_timeout', pollMs: 1, settleMs: 50, ...over });
  // POST = the interrupt; GET = the session, running for the first `runningPolls` reads.
  const platform = (runningPolls = 0) => {
    let reads = 0;
    return jest.fn(async (_url, opts = {}) => ({ ok: true, status: 200, json: async () => (opts.method === 'POST' ? {} : { status: reads++ < runningPolls ? 'running' : 'idle' }) }));
  };

  it('sends user.interrupt to a session whose runner failed', async () => {
    global.fetch = platform();
    await expect(stop()).resolves.toBe(true);
    const [url, opts] = global.fetch.mock.calls[0];
    expect(url).toBe('https://api.anthropic.com/v1/sessions/sess-1/events');
    expect(opts.method).toBe('POST');
    expect(opts.headers['anthropic-beta']).toBe('managed-agents-2026-04-01');
    expect(JSON.parse(opts.body)).toEqual({ events: [{ type: 'user.interrupt' }] });
  });

  it('returns only after the session stopped running, so the usage read next is settled', async () => {
    global.fetch = platform(2);
    await expect(stop()).resolves.toBe(true);
    const reads = global.fetch.mock.calls.filter(([, opts]) => opts.method !== 'POST');
    expect(reads).toHaveLength(3);
    expect(reads[0][0]).toBe('https://api.anthropic.com/v1/sessions/sess-1');
  });

  it('gives up waiting at the limit and still reports the interrupt as sent', async () => {
    global.fetch = platform(Infinity);
    await expect(stop({ settleMs: 5 })).resolves.toBe(true);
  });

  it('reads a thrown Error as a failure too', async () => {
    global.fetch = platform();
    await expect(stop({ failure: Object.assign(new Error('x'), { code: 'session_stream_eof' }) })).resolves.toBe(true);
  });

  it.each([
    ['a run that succeeded', { failure: null }],
    ['a session already paused at its cap', { failure: 'budget_exhausted' }],
    ['no session id', { sessionId: null }],
    ['the customer assistant, whose session takes the next turn', { laneId: 'agent_assistant' }],
  ])('sends nothing for %s', async (_label, over) => {
    await expect(stop(over)).resolves.toBe(false);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('sends nothing with the gate off', async () => {
    delete process.env.GATE_AGENT_SESSION_GUARD;
    await expect(stop()).resolves.toBe(false);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it.each([
    ['a refused request', async () => ({ ok: false, status: 409 })],
    ['a network error', async () => { throw new Error('socket hang up'); }],
  ])('never throws on %s', async (_label, impl) => {
    global.fetch = jest.fn(impl);
    await expect(stop({ failure: 'max_events' })).resolves.toBe(false);
  });
});

describe('isBudgetReached', () => {
  it('reads a string or an object stop reason, and is not a terminal', () => {
    expect(isBudgetReached({ stop_reason: 'budget_reached' })).toBe(true);
    expect(isBudgetReached({ stop_reason: { type: 'budget_reached' } })).toBe(true);
    expect(isBudgetReached({ stop_reason: { type: 'requires_action' } })).toBe(false);
    expect(isSessionTerminal('session.status_idle', { stop_reason: { type: 'budget_reached' } })).toBe(false);
  });
});
