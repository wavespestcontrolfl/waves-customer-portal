// GATE_PORTAL_MESSAGES_DAY_AI (portal-messages-day-ai.js), the parts that need no database: the gate reads strictly
// at call time, the sweep does nothing while it is off or outside office hours, only a message that waited 120
// open minutes is taken, once, and a hand-off sends nothing. The claim, the turn, the save and the notice are the
// night step's own (scripted here); the candidate query runs against real rows in the postgres suite.
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';
process.env.ANTHROPIC_API_KEY = 'test-key';

// The candidate query: a chain that ends in the rows a test sets. Any other use of the database is a failure.
const mockQuery = jest.fn();
let mockRows = [];
jest.mock('../models/db', () => {
  const chain = new Proxy(function chainFn() {}, {
    get: (_, key) => {
      if (key === 'then') return (resolve) => resolve((mockQuery('rows'), mockRows));
      return () => chain;
    },
    apply: () => chain,
  });
  return chain;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('@anthropic-ai/sdk', () => jest.fn());

const mockTaken = new Set();
const mockClaim = jest.fn(async (id) => { if (mockTaken.has(id)) return false; mockTaken.add(id); return true; });
const mockRecord = jest.fn(async () => {});
const mockTurn = jest.fn();
const mockSave = jest.fn();
const mockNotify = jest.fn(async () => {});
jest.mock('../services/portal-messages-night-ai', () => ({
  ...jest.requireActual('../services/portal-messages-night-ai'),
  __private: {
    claimMessage: (...a) => mockClaim(...a),
    recordOutcome: (...a) => mockRecord(...a),
    takeTurn: (...a) => mockTurn(...a),
    saveReply: (...a) => mockSave(...a),
    notifyCustomer: (...a) => mockNotify(...a),
  },
}));

const gates = require('../config/feature-gates');
const DayAi = require('../services/portal-messages-day-ai');

const GATE_KEYS = ['GATE_PORTAL_MESSAGES_DAY_AI', 'GATE_PORTAL_MESSAGES', 'GATE_PORTAL_INBOX', 'PORTAL_CHAT_SELF_SERVE'];
const kept = {};
beforeAll(() => { for (const key of GATE_KEYS) kept[key] = process.env[key]; });
afterAll(() => { for (const key of GATE_KEYS) { if (kept[key] === undefined) delete process.env[key]; else process.env[key] = kept[key]; } });

// 2026-11-12 is a Thursday in EST (UTC-5). The message was written at 10:00 AM ET, so it is due at 12:00 PM ET.
const WRITTEN = '2026-11-12T15:00:00Z';
const DUE = new Date('2026-11-12T17:01:00Z');
const NOT_YET = new Date('2026-11-12T16:30:00Z');
const row = (id = 'm-1', body = 'When is my next visit?') => ({ id, body, created_at: new Date(WRITTEN), thread_id: 't-1', customer_id: 'c-1' });
const ZERO = { scanned: 0, answered: 0, silent: 0, leftForTeam: 0, capped: 0, superseded: 0, failed: 0 };

beforeEach(() => {
  jest.clearAllMocks();
  mockTaken.clear();
  mockRows = [row()];
  process.env.GATE_PORTAL_MESSAGES_DAY_AI = 'true';
  process.env.GATE_PORTAL_MESSAGES = 'true';
  process.env.GATE_PORTAL_INBOX = 'true';
  delete process.env.PORTAL_CHAT_SELF_SERVE;
  mockSave.mockResolvedValue({ id: 'ai-1' });
});

describe('GATE_PORTAL_MESSAGES_DAY_AI', () => {
  it('is dark unless exactly true, read at call time', () => {
    delete process.env.GATE_PORTAL_MESSAGES_DAY_AI;
    expect(gates.portalMessagesDayAiLive()).toBe(false);
    for (const value of ['1', 'TRUE', 'yes', 'false', '']) {
      process.env.GATE_PORTAL_MESSAGES_DAY_AI = value;
      expect(gates.portalMessagesDayAiLive()).toBe(false);
    }
    process.env.GATE_PORTAL_MESSAGES_DAY_AI = 'true';
    expect(gates.portalMessagesDayAiLive()).toBe(true);
  });

  it('needs the portal messages, the Portal tab and Ask Waves on, and not the night gate', () => {
    delete process.env.GATE_PORTAL_MESSAGES_NIGHT_AI;
    expect(DayAi.enabled()).toBe(true);
    process.env.GATE_PORTAL_INBOX = 'false';
    expect(DayAi.enabled()).toBe(false);
    process.env.GATE_PORTAL_INBOX = 'true';
    process.env.GATE_PORTAL_MESSAGES = 'false';
    expect(DayAi.enabled()).toBe(false);
    process.env.GATE_PORTAL_MESSAGES = 'true';
    process.env.PORTAL_CHAT_SELF_SERVE = 'off';
    expect(DayAi.enabled()).toBe(false);
  });
});

describe('answerWaitingMessages', () => {
  it('reads nothing and sends nothing with the gate off', async () => {
    delete process.env.GATE_PORTAL_MESSAGES_DAY_AI;
    expect(await DayAi.answerWaitingMessages({ now: DUE })).toEqual(ZERO);
    expect(mockQuery).not.toHaveBeenCalled();
    expect(mockClaim).not.toHaveBeenCalled();
  });

  it('does nothing while the clock is outside 8 AM to 8 PM Eastern', async () => {
    // 10:00 PM ET and 7:59 AM ET.
    for (const at of ['2026-11-13T03:00:00Z', '2026-11-13T12:59:00Z']) {
      expect(await DayAi.answerWaitingMessages({ now: new Date(at) })).toEqual(ZERO);
    }
    expect(mockQuery).not.toHaveBeenCalled();
    expect(mockClaim).not.toHaveBeenCalled();
  });

  it('skips a message that has not waited 120 open minutes', async () => {
    expect(await DayAi.answerWaitingMessages({ now: NOT_YET })).toEqual(ZERO);
    expect(mockClaim).not.toHaveBeenCalled();
    expect(mockTurn).not.toHaveBeenCalled();
  });

  it('counts only open minutes: a message written at night is not due before 120 minutes after 8 AM', async () => {
    mockRows = [{ ...row(), created_at: new Date('2026-11-12T03:00:00Z') }]; // 10 PM ET the evening before
    expect(await DayAi.answerWaitingMessages({ now: new Date('2026-11-12T14:30:00Z') })).toEqual(ZERO); // 9:30 AM
    expect(await DayAi.answerWaitingMessages({ now: new Date('2026-11-12T15:01:00Z') })).toMatchObject({ scanned: 1 }); // 10:01 AM
  });

  it('saves a grounded answer, notifies the customer and records answered', async () => {
    mockTurn.mockResolvedValue({ kind: 'answer', body: 'Your next visit is Friday.' });
    expect(await DayAi.answerWaitingMessages({ now: DUE })).toEqual({ ...ZERO, scanned: 1, answered: 1 });
    expect(mockClaim).toHaveBeenCalledWith('m-1', 'dayAi');
    expect(mockTurn).toHaveBeenCalledWith('c-1', 't-1', expect.objectContaining({ id: 'm-1' }), { day: true });
    expect(mockSave).toHaveBeenCalledWith('t-1', expect.objectContaining({ id: 'm-1' }), { body: 'Your next visit is Friday.', handOff: false });
    expect(mockNotify).toHaveBeenCalledWith('c-1', { id: 'ai-1' });
    expect(mockRecord).toHaveBeenCalledWith('m-1', 'answered', 'dayAi');
  });

  it('sends nothing for a hand-off and records left_for_team', async () => {
    mockRows = [row('m-2', 'The technician broke my plant')];
    mockTurn.mockResolvedValue({ kind: 'handoff' });
    expect(await DayAi.answerWaitingMessages({ now: DUE })).toEqual({ ...ZERO, scanned: 1, leftForTeam: 1 });
    expect(mockSave).not.toHaveBeenCalled();
    expect(mockNotify).not.toHaveBeenCalled();
    expect(mockRecord).toHaveBeenCalledWith('m-2', 'left_for_team', 'dayAi');
  });

  it('is silent for thanks, with no model call', async () => {
    mockRows = [row('m-3', 'Thanks!')];
    expect(await DayAi.answerWaitingMessages({ now: DUE })).toEqual({ ...ZERO, scanned: 1, silent: 1 });
    expect(mockTurn).not.toHaveBeenCalled();
    expect(mockSave).not.toHaveBeenCalled();
    expect(mockRecord).toHaveBeenCalledWith('m-3', 'silent', 'dayAi');
  });

  it('records the model\'s own silence, a cap, a superseded answer and a failed turn', async () => {
    mockRows = [row('a'), row('b'), row('c'), row('d')];
    mockTurn
      .mockResolvedValueOnce({ kind: 'silent' })
      .mockResolvedValueOnce({ kind: 'capped' })
      .mockResolvedValueOnce({ kind: 'answer', body: 'Friday.' })
      .mockRejectedValueOnce(new Error('model down'));
    mockSave.mockResolvedValueOnce(null);
    expect(await DayAi.answerWaitingMessages({ now: DUE })).toEqual({ ...ZERO, scanned: 4, silent: 1, capped: 1, superseded: 1, failed: 1 });
    expect(mockNotify).not.toHaveBeenCalled();
    expect(mockRecord.mock.calls.map(([id, outcome]) => [id, outcome])).toEqual([['a', 'silent'], ['b', 'capped'], ['c', 'superseded'], ['d', 'failed']]);
  });

  it('does not take the same message twice: a second sweep finds it claimed', async () => {
    mockTurn.mockResolvedValue({ kind: 'answer', body: 'Friday.' });
    expect(await DayAi.answerWaitingMessages({ now: DUE })).toMatchObject({ answered: 1 });
    mockTurn.mockClear();
    expect(await DayAi.answerWaitingMessages({ now: DUE })).toMatchObject({ scanned: 1, answered: 0 });
    expect(mockTurn).not.toHaveBeenCalled();
    expect(mockSave).toHaveBeenCalledTimes(1);
  });

  it('takes at most 20 messages in a sweep and never throws', async () => {
    mockRows = Array.from({ length: 25 }, (_, i) => row(`m-${i}`));
    mockTurn.mockResolvedValue({ kind: 'handoff' });
    expect(await DayAi.answerWaitingMessages({ now: DUE })).toMatchObject({ scanned: 20, leftForTeam: 20 });
    mockQuery.mockImplementationOnce(() => { throw new Error('db down'); });
    expect(await DayAi.answerWaitingMessages({ now: DUE })).toEqual(ZERO);
  });
});
