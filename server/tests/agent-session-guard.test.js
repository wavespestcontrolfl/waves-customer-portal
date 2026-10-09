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
  it('sends user.interrupt to a session whose runner failed', async () => {
    await expect(stopAbandonedSession('sess-1', 'session_timeout')).resolves.toBe(true);
    const [url, opts] = global.fetch.mock.calls[0];
    expect(url).toBe('https://api.anthropic.com/v1/sessions/sess-1/events');
    expect(opts.method).toBe('POST');
    expect(opts.headers['anthropic-beta']).toBe('managed-agents-2026-04-01');
    expect(JSON.parse(opts.body)).toEqual({ events: [{ type: 'user.interrupt' }] });
  });

  it('reads a thrown Error as a failure too', async () => {
    await expect(stopAbandonedSession('sess-1', Object.assign(new Error('x'), { code: 'session_stream_eof' }))).resolves.toBe(true);
  });

  it.each([
    ['a run that succeeded', 'sess-1', null],
    ['a session already paused at its cap', 'sess-1', 'budget_exhausted'],
    ['no session id', null, 'session_timeout'],
  ])('sends nothing for %s', async (_label, sessionId, failure) => {
    await expect(stopAbandonedSession(sessionId, failure)).resolves.toBe(false);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('sends nothing with the gate off', async () => {
    delete process.env.GATE_AGENT_SESSION_GUARD;
    await expect(stopAbandonedSession('sess-1', 'session_timeout')).resolves.toBe(false);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it.each([
    ['a refused request', async () => ({ ok: false, status: 409 })],
    ['a network error', async () => { throw new Error('socket hang up'); }],
  ])('never throws on %s', async (_label, impl) => {
    global.fetch = jest.fn(impl);
    await expect(stopAbandonedSession('sess-1', 'max_events')).resolves.toBe(false);
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
