/**
 * Ask Waves Jev second check (GATE_ASK_WAVES_JEV_CHECK = off | shadow | enforce):
 * what is asked, what a visitor sees, and what is recorded against the assistant
 * row. No provider, no database: Jev, the recorder and the chat log are stand-ins.
 */
jest.mock('../services/llm/call', () => ({ dispatchWithFallback: jest.fn() }));
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
const mockAsk = jest.fn();
jest.mock('../services/typed-decisions/jev', () => ({ askPackage: (...a) => mockAsk(...a) }));
const mockRecord = jest.fn();
jest.mock('../services/typed-decisions/shadow-recorder', () => ({ recordDecisions: (...a) => mockRecord(...a) }));

const db = require('../models/db');
const logger = require('../services/logger');
const { dispatchWithFallback } = require('../services/llm/call');
const { processIntakeMessage, _internals } = require('../services/ask-waves-intake');
const { PACKAGES } = require('../services/typed-decisions/packages');
const { askWavesSubjectHash } = require('../services/typed-decisions/subject-hash');
const { askWavesJevCheckMode } = require('../config/feature-gates');

const { FALLBACK_RESULT, ASK_WAVES_JEV_CHECK_GRACE_MS } = _internals;
const PKG = PACKAGES['ask_waves_safety.v1'];
const GATES = ['GATE_ASK_WAVES_JEV_CHECK', 'GATE_TYPED_DECISIONS'];
const before = Object.fromEntries(GATES.map((g) => [g, process.env[g]]));
afterAll(() => { for (const g of GATES) { if (before[g] === undefined) delete process.env[g]; else process.env[g] = before[g]; } });

const ASSISTANT_ID = '55555555-5555-4555-8555-555555555555';
const SESSION = 'jev-check-session-1';
const MESSAGE = 'Do you treat for ants?';
// A reply the word list passes: the Jev check is the only thing that can flag it.
const REPLY = 'We can treat that. Want a quick quote?';
const modelAnswer = { reply: REPLY, intent: 'quote', service_keys: ['generalPest'], ready_for_quote: true };
const chainOk = (json) => ({ ok: true, provider: 'openai', json, fallbackUsed: false, failures: [] });

const verdict = (over = {}) => ({
  ok: true,
  answers: { safety_claim: { p: 0.03, yes: false, confident: true }, access_timing: { p: 0.02, yes: false, confident: true }, ...over },
  servedModel: 'jev-1.13.0',
  packageId: 'ask_waves_safety.v1',
  provider: 'typesafe',
});
const yes = { p: 0.97, yes: true, confident: true };

let inserted;
function installChatLog({ assistantId = ASSISTANT_ID } = {}) {
  inserted = [];
  db.mockImplementation((table) => {
    const b = {
      where() { return b; },
      orderBy() { return b; },
      first: async () => ({ id: 'session-row', message_count: 0 }),
      update: async () => 1,
      insert: (rows) => {
        if (table === 'agent_messages') inserted.push(...rows);
        return { returning: async () => (table === 'agent_messages'
          ? rows.map((row, i) => ({ id: row.role === 'assistant' ? assistantId : `user-${i}`, role: row.role }))
          : [{ id: 'session-row', message_count: 0 }]) };
      },
    };
    return b;
  });
}
// Lets the fire-and-forget log and the recording behind it finish.
const settle = async () => { for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setImmediate(resolve)); };
const turn = (over = {}) => processIntakeMessage({ message: MESSAGE, sessionId: SESSION, ...over });

beforeEach(() => {
  jest.clearAllMocks();
  mockAsk.mockReset(); mockRecord.mockReset(); dispatchWithFallback.mockReset();
  process.env.GATE_TYPED_DECISIONS = 'true';
  delete process.env.GATE_ASK_WAVES_JEV_CHECK;
  dispatchWithFallback.mockResolvedValue(chainOk(modelAnswer));
  mockAsk.mockResolvedValue(verdict());
  mockRecord.mockResolvedValue({ recorded: 2, passedOver: 0, sampled: {} });
  installChatLog();
});

describe('askWavesJevCheckMode', () => {
  test.each([
    [undefined, 'off'], ['', 'off'], ['off', 'off'], ['true', 'off'], ['1', 'off'], ['suggest', 'off'],
    ['shadow', 'shadow'], [' Shadow ', 'shadow'], ['enforce', 'enforce'], ['ENFORCE', 'enforce'],
  ])('%j reads as %s', (value, mode) => {
    if (value === undefined) delete process.env.GATE_ASK_WAVES_JEV_CHECK; else process.env.GATE_ASK_WAVES_JEV_CHECK = value;
    expect(askWavesJevCheckMode()).toBe(mode);
  });
});

describe('gate off', () => {
  test('Jev is never asked, nothing is recorded, and the reply is untouched', async () => {
    const out = await turn();
    await settle();
    expect(out.reply).toBe(REPLY);
    expect(mockAsk).not.toHaveBeenCalled();
    expect(mockRecord).not.toHaveBeenCalled();
  });

  test('any value that is not a mode is off', async () => {
    process.env.GATE_ASK_WAVES_JEV_CHECK = 'true';
    await turn();
    await settle();
    expect(mockAsk).not.toHaveBeenCalled();
  });
});

describe('shadow', () => {
  beforeEach(() => { process.env.GATE_ASK_WAVES_JEV_CHECK = 'shadow'; });

  test('the visitor gets the model reply byte for byte, even when Jev says yes to both', async () => {
    delete process.env.GATE_ASK_WAVES_JEV_CHECK;
    const unchecked = await turn();
    process.env.GATE_ASK_WAVES_JEV_CHECK = 'shadow';
    mockAsk.mockResolvedValue(verdict({ safety_claim: yes, access_timing: yes }));
    const out = await turn();
    expect(out).toEqual(unchecked);
    expect(out.reply).toBe(REPLY);
    await settle();
  });

  test('Jev is not asked until the chat log has written the assistant row', async () => {
    let releaseInsert;
    const insertGate = new Promise((resolve) => { releaseInsert = resolve; });
    db.mockImplementation((table) => {
      const b = {
        where() { return b; }, orderBy() { return b; }, first: async () => ({ id: 'session-row', message_count: 0 }), update: async () => 1,
        insert: (rows) => ({ returning: async () => { if (table === 'agent_messages') await insertGate; return rows.map((r) => ({ id: ASSISTANT_ID, role: r.role })); } }),
      };
      return b;
    });
    const out = await turn();
    expect(out.reply).toBe(REPLY);
    await settle();
    expect(mockAsk).not.toHaveBeenCalled();
    releaseInsert();
    await settle();
    expect(mockAsk).toHaveBeenCalledTimes(1);
  });

  test('asks the package with the cleaned visitor message and the served reply, then records against the assistant row', async () => {
    mockAsk.mockResolvedValue(verdict({ access_timing: yes }));
    await turn({ message: '  Do you treat for ants?  ' });
    await settle();
    expect(mockAsk).toHaveBeenCalledTimes(1);
    const [packageId, state] = mockAsk.mock.calls[0];
    expect(packageId).toBe('ask_waves_safety.v1');
    expect(state).toEqual({ visitor_message: MESSAGE, reply: REPLY });

    expect(mockRecord).toHaveBeenCalledTimes(1);
    const [record] = mockRecord.mock.calls[0];
    expect(record).toMatchObject({ capability: 'ask_waves_safety', provider: 'typesafe', subjectType: 'agent_messages', subjectId: ASSISTANT_ID });
    expect(record.pkg).toBe(PKG);
    expect(record.result.answers.access_timing.yes).toBe(true);
    // the word list passed the reply: production said no to both questions
    expect(record.baselines).toEqual({ safety_claim: { production: false }, access_timing: { production: false } });
    expect(record.subjectHash).toBe(askWavesSubjectHash({ visitorMessage: MESSAGE, reply: REPLY }));
    // ids and answers only: no message text reaches the recorder's own fields
    expect(JSON.stringify({ ...record, pkg: undefined, subjectHash: undefined })).not.toContain('ants');
  });

  test('the stored rows are what the review route digests: the cleaned message and "[intent] reply"', async () => {
    await turn();
    await settle();
    expect(inserted.map((r) => [r.role, r.content])).toEqual([['user', MESSAGE], ['assistant', `[quote] ${REPLY}`]]);
  });

  test('no session id: no log, so nothing is asked or recorded', async () => {
    await turn({ sessionId: undefined });
    await settle();
    expect(mockAsk).not.toHaveBeenCalled();
    expect(mockRecord).not.toHaveBeenCalled();
  });

  test('a log that fails records nothing and the reply still goes out', async () => {
    db.mockImplementation(() => { throw new Error('db down'); });
    const out = await turn();
    await settle();
    expect(out.reply).toBe(REPLY);
    expect(mockAsk).not.toHaveBeenCalled();
    expect(mockRecord).not.toHaveBeenCalled();
  });

  test.each([
    ['ok:false', () => mockAsk.mockResolvedValue({ ok: false, reason: 'gate_off' })],
    ['a rejection', () => mockAsk.mockRejectedValue(new Error('boom'))],
  ])('Jev failing (%s) records nothing and never reaches the chat turn', async (_name, arrange) => {
    arrange();
    const out = await turn();
    await settle();
    expect(out.reply).toBe(REPLY);
    expect(mockRecord).not.toHaveBeenCalled();
  });

  test('a recorder that throws is swallowed', async () => {
    mockRecord.mockRejectedValue(new Error('pg down'));
    const out = await turn();
    await settle();
    expect(out.reply).toBe(REPLY);
    expect(logger.warn).toHaveBeenCalled();
  });

  test('a Jev call that never answers cannot hold the reply', async () => {
    mockAsk.mockReturnValue(new Promise(() => {}));
    const start = Date.now();
    const out = await turn();
    expect(Date.now() - start).toBeLessThan(500);
    expect(out.reply).toBe(REPLY);
  });
});

describe('enforce', () => {
  beforeEach(() => { process.env.GATE_ASK_WAVES_JEV_CHECK = 'enforce'; });
  const { unsafeClaimResult } = _internals;
  const expectedCopy = (reply, message, intent) => unsafeClaimResult({ ...modelAnswer, reply, intent }, message, message);

  test.each([
    ['safety_claim', { safety_claim: yes }],
    ['access_timing', { access_timing: yes }],
    ['both', { safety_claim: yes, access_timing: yes }],
  ])('a yes on %s swaps the reply for the reviewed English copy, and the swap is what is logged', async (_name, answers) => {
    mockAsk.mockResolvedValue(verdict(answers));
    const out = await turn();
    expect(out.reply).toMatch(/^I can't make a blanket safety claim or give a fixed re-entry time/);
    expect(out.reply).not.toContain(REPLY);
    expect(out.intent).toBe('quote');
    expect(out.reply).toBe(expectedCopy(REPLY, MESSAGE, 'quote').reply);
    await settle();
    expect(inserted.find((r) => r.role === 'assistant').content).toBe(`[quote] ${out.reply}`);
    // a swapped reply's stored text is not the judged text: nothing is recorded
    expect(mockRecord).not.toHaveBeenCalled();
  });

  test('the swap logs the flagged questions but never the reply text', async () => {
    mockAsk.mockResolvedValue(verdict({ access_timing: yes }));
    await turn();
    const line = logger.info.mock.calls.map(([m]) => m).find((m) => /jev check swapped/.test(m));
    expect(line).toContain('access_timing');
    expect(line).not.toContain('quick quote');
  });

  test('a Spanish turn gets the Spanish copy', async () => {
    dispatchWithFallback.mockResolvedValue(chainOk({ ...modelAnswer, reply: 'Puede volver a entrar a su casa cuando terminemos.', intent: 'question', ready_for_quote: false }));
    mockAsk.mockResolvedValue(verdict({ access_timing: yes }));
    const out = await turn({ message: '¿Cuándo puedo volver a entrar a mi casa?' });
    expect(out.reply).toMatch(/^No puedo dar una garantía general de seguridad/);
    expect(out.intent).toBe('question');
  });

  test('a flagged reply to a described emergency gets the emergency guidance, as the word list would give it', async () => {
    mockAsk.mockResolvedValue(verdict({ safety_claim: yes }));
    const message = 'My son swallowed some of the ant bait';
    const out = await turn({ message });
    expect(out.reply).toContain('1-800-222-1222');
    expect(out.intent).toBe('emergency');
    expect(out.reply).toBe(expectedCopy(REPLY, message, 'quote').reply);
  });

  test('a mislabeled "emergency" with no emergency evidence comes back as a question', async () => {
    // The emergency turn is skipped before the check, so exercise the shared helper directly.
    const out = unsafeClaimResult({ ...modelAnswer, intent: 'emergency' }, MESSAGE, MESSAGE);
    expect(out.intent).toBe('question');
    expect(out.reply).toMatch(/^I can't make a blanket safety claim/);
  });

  test('a no on both questions keeps the reply and records the answers once the reply is logged', async () => {
    const out = await turn();
    expect(out.reply).toBe(REPLY);
    await settle();
    expect(mockAsk).toHaveBeenCalledTimes(1);
    expect(mockRecord).toHaveBeenCalledTimes(1);
    expect(mockRecord.mock.calls[0][0]).toMatchObject({ subjectType: 'agent_messages', subjectId: ASSISTANT_ID });
  });

  test.each([
    ['ok:false', () => mockAsk.mockResolvedValue({ ok: false, reason: 'error' })],
    ['gate_off', () => mockAsk.mockResolvedValue({ ok: false, reason: 'gate_off' })],
    ['a rejection', () => mockAsk.mockRejectedValue(new Error('boom'))],
  ])('Jev failing (%s) keeps the reply and records nothing', async (_name, arrange) => {
    arrange();
    const out = await turn();
    await settle();
    expect(out.reply).toBe(REPLY);
    expect(mockRecord).not.toHaveBeenCalled();
  });

  test('an answer later than the grace keeps the reply, then is still recorded', async () => {
    jest.useFakeTimers();
    try {
      let answerLate;
      mockAsk.mockReturnValue(new Promise((resolve) => { answerLate = () => resolve(verdict({ safety_claim: yes })); }));
      let done = null;
      const pending = turn().then((r) => { done = r; });
      await jest.advanceTimersByTimeAsync(ASK_WAVES_JEV_CHECK_GRACE_MS - 100);
      expect(done).toBeNull();
      await jest.advanceTimersByTimeAsync(200);
      await pending;
      // a late yes cannot change a reply that has gone out
      expect(done.reply).toBe(REPLY);
      answerLate();
      await jest.advanceTimersByTimeAsync(0);
    } finally {
      jest.useRealTimers();
    }
    await settle();
    expect(mockRecord).toHaveBeenCalledTimes(1);
    expect(mockRecord.mock.calls[0][0].result.answers.safety_claim.yes).toBe(true);
  });

  test('the wait is a named 800 ms', () => {
    expect(ASK_WAVES_JEV_CHECK_GRACE_MS).toBe(800);
  });
});

describe.each(['shadow', 'enforce'])('turns that are never asked (%s)', (mode) => {
  beforeEach(() => { process.env.GATE_ASK_WAVES_JEV_CHECK = mode; });
  const { SUPPORT_FALLBACK_RESULT, EMERGENCY_FALLBACK_RESULT } = _internals;

  test('reviewed copy is not asked: the price redirect', async () => {
    dispatchWithFallback.mockResolvedValue(chainOk({ ...modelAnswer, reply: 'It costs $89 a month.' }));
    const out = await turn();
    await settle();
    expect(out.reply).not.toContain('$89');
    expect(mockAsk).not.toHaveBeenCalled();
  });

  test('reviewed copy is not asked: a word-list hit becomes the safety copy', async () => {
    dispatchWithFallback.mockResolvedValue(chainOk({ ...modelAnswer, reply: 'Yes, it is completely safe for pets and kids.', intent: 'question' }));
    const out = await turn();
    await settle();
    expect(out.reply).toMatch(/^I can't make a blanket safety claim/);
    expect(mockAsk).not.toHaveBeenCalled();
  });

  test('an emergency turn is not asked', async () => {
    dispatchWithFallback.mockResolvedValue(chainOk({ reply: 'Please call 911 right away.', intent: 'emergency', service_keys: [], ready_for_quote: false }));
    const out = await turn({ message: 'My son swallowed bait' });
    await settle();
    expect(out.intent).toBe('emergency');
    expect(mockAsk).not.toHaveBeenCalled();
  });

  test('the deterministic fallback after both providers miss is not asked', async () => {
    dispatchWithFallback.mockResolvedValue({ ok: false, reason: 'all_providers_failed', failures: [] });
    const out = await turn();
    await settle();
    expect(out.reply).toBe(FALLBACK_RESULT.reply);
    expect(mockAsk).not.toHaveBeenCalled();
  });

  test('the support and emergency fallbacks are not asked', async () => {
    dispatchWithFallback.mockResolvedValue({ ok: false, reason: 'all_providers_failed', failures: [] });
    expect((await turn({ message: 'I need to cancel my account' })).reply).toBe(SUPPORT_FALLBACK_RESULT.reply);
    expect((await turn({ message: "No, he can't breathe", sessionId: 'jev-check-session-2' })).reply).toContain(EMERGENCY_FALLBACK_RESULT.reply);
    await settle();
    expect(mockAsk).not.toHaveBeenCalled();
  });
});

describe('logIntakeExchange', () => {
  test('returns the assistant agent_messages row id', async () => {
    const id = await _internals.logIntakeExchange({ sessionId: SESSION, message: MESSAGE, reply: REPLY, intent: 'quote' });
    expect(id).toBe(ASSISTANT_ID);
    expect(inserted.map((r) => r.role)).toEqual(['user', 'assistant']);
  });

  test('finds the assistant row whatever order the database returns the rows in', async () => {
    db.mockImplementation((table) => {
      const b = {
        where() { return b; }, orderBy() { return b; }, first: async () => ({ id: 'session-row', message_count: 0 }), update: async () => 1,
        insert: (rows) => ({ returning: async () => (table === 'agent_messages'
          ? [{ id: ASSISTANT_ID, role: 'assistant' }, { id: 'user-row', role: 'user' }] : [{ id: 'session-row', message_count: 0 }]) }),
      };
      return b;
    });
    expect(await _internals.logIntakeExchange({ sessionId: SESSION, message: MESSAGE, reply: REPLY, intent: 'quote' })).toBe(ASSISTANT_ID);
  });

  test('no valid session id: nothing is logged and no id comes back', async () => {
    expect(await _internals.logIntakeExchange({ sessionId: 'x', message: MESSAGE, reply: REPLY, intent: 'quote' })).toBeUndefined();
    expect(db).not.toHaveBeenCalled();
  });

  test('a failing log never throws and returns no id', async () => {
    db.mockImplementation(() => { throw new Error('db down'); });
    await expect(_internals.logIntakeExchange({ sessionId: SESSION, message: MESSAGE, reply: REPLY, intent: 'quote' })).resolves.toBeUndefined();
  });
});
