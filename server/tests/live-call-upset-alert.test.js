/**
 * Upset-caller alert on a live call (GATE_LIVE_CALL_UPSET_ALERT, owner 2026-11-16 "ok build all, use haiku").
 *
 * Pins: gate off = no read and no model call; a call the owner took is never checked; the cadence (3 new caller
 * utterances, 45 s apart, 8 checks, one racing check wins); one alert per call; a refusal, bad JSON, a calm read
 * or an API error is no alert; the model request (Haiku pin, lane, labeled last 2 minutes); the alert's shape.
 */
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../config/feature-gates', () => ({ isEnabled: jest.fn(() => true) }));
jest.mock('../services/admin-alert-names', () => ({ redactedWords: (t) => t }));

const mockCreate = jest.fn();
jest.mock('@anthropic-ai/sdk', () => jest.fn(() => ({ messages: { create: (...args) => mockCreate(...args) } })));

const mockLedger = jest.fn((provider, model, fn) => fn());
jest.mock('../services/llm-dispatch-metrics', () => ({ ledgerCall: (...args) => mockLedger(...args) }));

const mockRaise = jest.fn();
jest.mock('../services/admin-alert-compose', () => {
  const actual = jest.requireActual('../services/admin-alert-compose');
  return { ...actual, raiseAdminAlert: (category, spec, opts) => { actual.composeAdminAlert(spec); return mockRaise(category, spec, opts); } };
});

// call_log holds one row; call_live_utterances is a list. The claim UPDATEs run against the row's JSON.
jest.mock('../models/db', () => {
  const state = { call: null, utterances: [] };
  const live = () => state.call.metadata.live_transcription;
  function callLog() {
    const q = { raws: [] };
    q.where = jest.fn(() => q);
    q.whereRaw = jest.fn((sql, bindings) => { q.raws.push({ sql, bindings }); return q; });
    q.first = jest.fn(async () => (state.call ? JSON.parse(JSON.stringify(state.call)) : undefined));
    q.update = jest.fn(async (patch) => {
      const sql = patch.metadata.sql;
      if (sql.includes("'upset_alert_at'")) {
        if (live().upset_alert_at) return 0;
        live().upset_alert_at = patch.metadata.bindings[0];
        return 1;
      }
      if (sql.includes('upset_alert_at": null')) { live().upset_alert_at = null; return 1; }
      const expected = q.raws.find((r) => r.sql.includes('upset_checks'))?.bindings[0];
      if ((Number(live().upset_checks) || 0) !== expected || live().upset_alert_at) return 0;
      Object.assign(live(), JSON.parse(patch.metadata.bindings[0]));
      return 1;
    });
    return q;
  }
  function utterances() {
    const q = {};
    q.where = jest.fn(() => q);
    q.count = jest.fn(async () => [{ n: String(state.utterances.filter((u) => u.speaker === 'caller').length) }]);
    q.orderBy = jest.fn(() => q);
    q.limit = jest.fn(() => q);
    q.select = jest.fn(async () => [...state.utterances].sort((a, b) => b.spoken_at - a.spoken_at || b.id - a.id));
    return q;
  }
  const db = jest.fn((table) => (table === 'call_log' ? callLog() : utterances()));
  db.raw = jest.fn((sql, bindings) => ({ sql, bindings }));
  db.__state = state;
  return db;
});

const db = require('../models/db');
const { isEnabled } = require('../config/feature-gates');
const MODELS = require('../config/models');
const upset = require('../services/live-call-upset-alert');

const SID = 'CA' + 'a'.repeat(32);
const OWNER = '+19415550100';
const STAFF = '+19415550111';
const T0 = Date.UTC(2026, 10, 16, 15, 0, 0);

function setCall({ answeredBy = STAFF, csr = 'Virginia', liveState = {} } = {}) {
  db.__state.call = {
    id: 'log-1',
    twilio_call_sid: SID,
    metadata: {
      live_transcription: { status: 'started', ...liveState },
      forward_acceptance: { accepted: true, answered_by_number: answeredBy, csr_name: csr },
    },
  };
}

// n caller lines (and one agent line) ending at `end` seconds after T0.
function speak(n, end = 100, text = 'This is the third time nobody showed up') {
  let id = db.__state.utterances.length;
  for (let i = 0; i < n; i += 1) {
    id += 1;
    db.__state.utterances.push({ id, speaker: 'caller', text: `${text} ${id}`, spoken_at: T0 + (end - (n - i)) * 1000 });
  }
  id += 1;
  db.__state.utterances.push({ id, speaker: 'staff', text: 'I am sorry about that', spoken_at: T0 + end * 1000 });
}

const reply = (obj) => ({ stop_reason: 'end_turn', content: [{ type: 'thinking', thinking: '...' }, { type: 'text', text: typeof obj === 'string' ? obj : JSON.stringify(obj) }] });
const liveState = () => db.__state.call.metadata.live_transcription;

beforeEach(() => {
  jest.clearAllMocks();
  db.__state.utterances = [];
  isEnabled.mockReturnValue(true);
  process.env.ADAM_PHONE = OWNER;
  process.env.ANTHROPIC_API_KEY = 'test-key';
  mockCreate.mockResolvedValue(reply({ mood: 'upset', reason: 'Caller says nobody has come three times and wants a manager' }));
  setCall();
  speak(3);
});

describe('live-call upset check', () => {
  test('gate off: no read and no model call', async () => {
    isEnabled.mockReturnValue(false);
    await expect(upset.checkCall(SID)).resolves.toEqual({ checked: false, reason: 'gate_off' });
    expect(db).not.toHaveBeenCalled();
    expect(mockCreate).not.toHaveBeenCalled();
  });

  test('a call the owner answered is never checked', async () => {
    setCall({ answeredBy: OWNER });
    await expect(upset.checkCall(SID)).resolves.toEqual({ checked: false, reason: 'owner_on_call' });
    expect(mockCreate).not.toHaveBeenCalled();
  });

  test('a call this suite never transcribed is skipped', async () => {
    db.__state.call.metadata = {};
    await expect(upset.checkCall(SID)).resolves.toEqual({ checked: false, reason: 'not_live' });
    expect(mockCreate).not.toHaveBeenCalled();
  });

  test('waits for 3 new caller utterances since the last check', async () => {
    db.__state.utterances = [];
    speak(2);
    await expect(upset.checkCall(SID)).resolves.toMatchObject({ checked: false, reason: 'not_due' });
    speak(1, 110);
    await expect(upset.checkCall(SID)).resolves.toMatchObject({ checked: true });
    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(liveState()).toMatchObject({ upset_checks: 1, upset_checked_count: 3 });
  });

  test('a second check needs 3 more utterances and 45 s', async () => {
    mockCreate.mockResolvedValue(reply({ mood: 'calm', reason: 'fine' }));
    await upset.checkCall(SID);
    speak(3, 120);
    await expect(upset.checkCall(SID)).resolves.toMatchObject({ reason: 'not_due' });
    liveState().upset_checked_at = new Date(Date.now() - 46 * 1000).toISOString();
    await expect(upset.checkCall(SID)).resolves.toMatchObject({ checked: true });
    expect(mockCreate).toHaveBeenCalledTimes(2);
  });

  test('stops after 8 checks', async () => {
    setCall({ liveState: { upset_checks: 8, upset_checked_count: 0, upset_checked_at: new Date(0).toISOString() } });
    await expect(upset.checkCall(SID)).resolves.toMatchObject({ reason: 'not_due' });
    expect(mockCreate).not.toHaveBeenCalled();
  });

  test('two webhooks racing for one check run the model once', async () => {
    await Promise.all([upset.checkCall(SID), upset.checkCall(SID)]);
    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(mockRaise).toHaveBeenCalledTimes(1);
  });

  test('once an alert is raised the call is never checked or alerted again', async () => {
    await expect(upset.checkCall(SID)).resolves.toEqual({ checked: true, alerted: true });
    expect(liveState().upset_alert_at).toBeTruthy();
    speak(3, 200);
    liveState().upset_checked_at = new Date(0).toISOString();
    await expect(upset.checkCall(SID)).resolves.toMatchObject({ reason: 'not_due' });
    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(mockRaise).toHaveBeenCalledTimes(1);
  });

  test.each([
    ['a refusal', { stop_reason: 'refusal', content: [] }],
    ['bad JSON', reply('the caller is upset')],
    ['an unknown mood', reply({ mood: 'furious', reason: 'x' })],
    ['a calm read', reply({ mood: 'calm', reason: 'Routine question about service dates' })],
    ['a concerned read', reply({ mood: 'concerned', reason: 'Worried about termites' })],
  ])('%s raises no alert but still counts as a check', async (_name, response) => {
    mockCreate.mockResolvedValue(response);
    await expect(upset.checkCall(SID)).resolves.toEqual({ checked: true, alerted: false });
    expect(mockRaise).not.toHaveBeenCalled();
    expect(liveState().upset_checks).toBe(1);
  });

  test('an API error raises no alert and never throws', async () => {
    mockCreate.mockRejectedValue(Object.assign(new Error('overloaded'), { status: 529 }));
    await expect(upset.checkCall(SID)).resolves.toEqual({ checked: true, alerted: false });
    expect(mockRaise).not.toHaveBeenCalled();
  });

  test('sends the last two minutes, labeled, on the pinned Haiku model and the lane', async () => {
    db.__state.utterances = [{ id: 1, speaker: 'caller', text: 'old news from long ago', spoken_at: T0 - 600 * 1000 }];
    speak(3, 300);
    await upset.checkCall(SID);
    expect(MODELS.LIVE_CALL).toBe(process.env.MODEL_LIVE_CALL || 'claude-haiku-5-5');
    expect(mockLedger).toHaveBeenCalledWith('anthropic', MODELS.LIVE_CALL, expect.any(Function), { laneId: 'live_call_upset' });
    const request = mockCreate.mock.calls[0][0];
    expect(request.model).toBe(MODELS.LIVE_CALL);
    const sent = request.messages[0].content;
    expect(sent).toContain('Caller: This is the third time');
    expect(sent).toContain('Agent: I am sorry about that');
    expect(sent).not.toContain('old news');
    expect(sent.length).toBeLessThanOrEqual(1500);
  });

  test('a long window is cut to the newest 1,500 characters', async () => {
    db.__state.utterances = [];
    speak(3, 100, 'x'.repeat(900));
    await upset.checkCall(SID);
    const sent = mockCreate.mock.calls[0][0].messages[0].content;
    expect(sent.length).toBe(1500);
    expect(sent.endsWith('I am sorry about that')).toBe(true);
  });
});

describe('the alert', () => {
  test('one needs-you alert: category, words, link, subject, banner kind, dedupe per call', async () => {
    await upset.checkCall(SID);
    expect(mockRaise).toHaveBeenCalledTimes(1);
    const [category, spec, opts] = mockRaise.mock.calls[0];
    expect(category).toBe('live_call_upset');
    expect(spec).toMatchObject({
      area: 'Comms',
      action: "step in on Virginia's upset caller",
      why: 'Caller says nobody has come three times and wants a manager',
      severity: 'needs-you',
      link: '/admin/communications#tab=calls&call=log-1',
      subject: { type: 'call', id: 'log-1' },
      who: 'person',
    });
    expect(opts).toEqual({ bell: true, dedupeKey: `live-call-upset:${SID}`, bannerKind: 'live_call_upset' });
  });

  test('no staff name: the headline still reads and fits', async () => {
    setCall({ csr: null });
    await upset.checkCall(SID);
    expect(mockRaise.mock.calls[0][1].action).toBe('step in on an upset caller');
  });

  test('the why drops phone numbers and card digits, keeps one sentence, fits 110', async () => {
    expect(upset._test.whyFrom('Caller gave 941-555-0123 and card 4242424242424242. Wants a manager.')).toBe('Caller gave and card.');
    expect(upset._test.whyFrom('x'.repeat(300)).length).toBeLessThanOrEqual(110);
  });

  test('a reason that breaks the notification rules falls back to a fixed line', async () => {
    expect(upset._test.whyFrom('see call_log_id for details')).toBe('The caller sounds upset about how the call is going.');
    expect(upset._test.whyFrom('')).toBe('The caller sounds upset about how the call is going.');
  });

  test('a failed raise gives the claim back and still never throws', async () => {
    mockRaise.mockRejectedValueOnce(new Error('db down'));
    await expect(upset.checkCall(SID)).resolves.toEqual({ checked: false, reason: 'error' });
    expect(liveState().upset_alert_at).toBeNull();
  });
});
