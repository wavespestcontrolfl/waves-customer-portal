// The follow-up SLA phrase on a closed day (owner 2026-11-24: Waves is closed on six holidays). The phrase rides only in the
// per-draft facts block, names the next OPEN day when today is closed or the next 9 AM is, and keeps every normal-day phrase.
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../services/scheduling/blackout-dates', () => ({ getBlackoutDates: jest.fn() }));

const logger = require('../services/logger');
const { getBlackoutDates } = require('../services/scheduling/blackout-dates');
const sla = require('../services/sms-followup-sla');
const drafter = require('../services/sms-shadow-drafter');

const { followupSlaPhrase, buildFactsBlock, buildSystemPrompt } = drafter;
const THANKSGIVING = new Set(['2026-11-26']);
const CHRISTMAS_2027 = new Set(['2027-12-24', '2027-12-25']); // Saturday Christmas closes Friday 12-24 too
const at = (iso) => new Date(iso);

const REOPEN = 'as soon as the office reopens';
const { CLOSED_DAYS_UNREADABLE } = sla;

describe('followupSlaPhrase with closed days', () => {
  test('Thanksgiving, daytime: the untimed phrase, not "within the hour"', () => {
    expect(followupSlaPhrase(at('2026-11-26T15:00:00Z'), THANKSGIVING)).toBe(REOPEN); // 10 AM ET
    expect(followupSlaPhrase(at('2026-11-26T10:00:00Z'), THANKSGIVING)).toBe(REOPEN); // 5 AM ET
    expect(followupSlaPhrase(at('2026-11-27T03:00:00Z'), THANKSGIVING)).toBe(REOPEN); // 10 PM ET
  });

  test('the evening before Thanksgiving, from 8 PM ET: untimed; earlier the office is open, so the plain phrase', () => {
    expect(followupSlaPhrase(at('2026-11-26T02:00:00Z'), THANKSGIVING)).toBe(REOPEN); // Wed 9 PM ET
    expect(followupSlaPhrase(at('2026-11-26T01:00:00Z'), THANKSGIVING)).toBe(REOPEN); // Wed 8 PM ET (boundary)
    expect(followupSlaPhrase(at('2026-11-25T23:00:00Z'), THANKSGIVING)).toBe('within the hour'); // Wed 6 PM ET
    expect(followupSlaPhrase(at('2026-11-25T13:00:00Z'), THANKSGIVING)).toBe('within the hour'); // Wed 8 AM ET
  });

  test('Christmas 2027 (a Saturday): Friday 12-24 and Saturday 12-25 closed, Sunday a work day', () => {
    expect(followupSlaPhrase(at('2027-12-24T15:00:00Z'), CHRISTMAS_2027)).toBe(REOPEN); // Fri 10 AM ET
    expect(followupSlaPhrase(at('2027-12-25T15:00:00Z'), CHRISTMAS_2027)).toBe(REOPEN); // Sat 10 AM ET
    expect(followupSlaPhrase(at('2027-12-24T02:00:00Z'), CHRISTMAS_2027)).toBe(REOPEN); // Thu 9 PM ET, tomorrow closed
    expect(followupSlaPhrase(at('2027-12-26T15:00:00Z'), CHRISTMAS_2027)).toBe('within the hour'); // Sunday 10 AM ET
  });

  test('a closure of any length is the same: the phrase never depends on how many days are closed', () => {
    const fortnight = new Set(Array.from({ length: 14 }, (_, i) => `2026-12-${String(10 + i).padStart(2, '0')}`));
    expect(followupSlaPhrase(at('2026-12-14T15:00:00Z'), fortnight)).toBe(REOPEN);
    expect(followupSlaPhrase(at('2026-12-18T02:00:00Z'), fortnight)).toBe(REOPEN);
  });

  test('a failed closure read gives the untimed phrase, at every hour', () => {
    for (const utc of ['2026-09-28T14:00:00Z', '2026-09-28T04:00:00Z', '2026-09-29T02:00:00Z']) {
      expect(followupSlaPhrase(at(utc), CLOSED_DAYS_UNREADABLE)).toBe(REOPEN);
    }
  });

  test('a normal weekday keeps the old phrases, byte for byte, with no closed days, an empty set or far ones', () => {
    const far = new Set(['2026-12-25']);
    const cases = [
      ['2026-09-28T14:00:00Z', 'within the hour'], ['2026-09-28T12:00:00Z', 'within the hour'], ['2026-09-28T23:00:00Z', 'within the hour'],
      ['2026-09-28T04:00:00Z', 'by 9 AM this morning'], ['2026-09-28T11:59:00Z', 'by 9 AM this morning'],
      ['2026-09-29T00:00:00Z', 'by 9 AM tomorrow morning'], ['2026-09-29T03:59:00Z', 'by 9 AM tomorrow morning'],
    ];
    for (const [utc, expected] of cases) {
      expect(followupSlaPhrase(at(utc))).toBe(expected);
      expect(followupSlaPhrase(at(utc), null)).toBe(expected);
      expect(followupSlaPhrase(at(utc), new Set())).toBe(expected);
      expect(followupSlaPhrase(at(utc), far)).toBe(expected);
    }
  });
});

describe('loadFollowupClosedDates', () => {
  beforeEach(() => jest.clearAllMocks());

  test('reads today and tomorrow ET from the shared closed-day reader, strictly', async () => {
    getBlackoutDates.mockResolvedValue(new Set(['2026-11-26']));
    const closed = await sla.loadFollowupClosedDates(at('2026-11-26T15:00:00Z'));
    expect(getBlackoutDates).toHaveBeenCalledWith('2026-11-26', '2026-11-27', undefined, { strict: true });
    expect(closed).toEqual(new Set(['2026-11-26']));
  });

  test('a failed read logs a warning and reads as unreadable, which gives the untimed phrase', async () => {
    getBlackoutDates.mockRejectedValue(new Error('settings down'));
    const closed = await sla.loadFollowupClosedDates(at('2026-09-28T14:00:00Z'));
    expect(closed).toBe(CLOSED_DAYS_UNREADABLE);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('closed days not read'));
    expect(followupSlaPhrase(at('2026-09-28T14:00:00Z'), closed)).toBe(REOPEN);
  });
});

describe('the verifier side accepts the untimed phrase and keeps its strictness', () => {
  const now = at('2026-11-26T15:00:00Z'); // Thanksgiving 10 AM ET

  test('the untimed phrase is in SLA_PHRASES, so it reads as a follow-up promise; no weekday family exists', () => {
    expect(sla.SLA_PHRASES).toEqual(['within the hour', 'by 9 AM this morning', 'by 9 AM tomorrow morning', REOPEN]);
    expect(sla.replyPromisesFollowup(`A person will reply ${REOPEN}.`)).toBe(true);
  });

  const snap = { intended_actions: [{ type: 'escalate', note: 'followup_promised' }] };
  const V12 = 'house_voice_v12_real_answers41_n';
  const reopenBody = `A person will reply ${REOPEN}.`;

  test('the untimed phrase has no deadline and is judged against the closed days at send time', () => {
    expect(sla.followupDeadline(REOPEN, now)).toBeNull();
    // still closed: current (Thanksgiving itself, and the evening before it)
    expect(sla.slaPhraseStatus(reopenBody, now, THANKSGIVING)).toBe('current');
    expect(sla.slaPhraseStatus(reopenBody, at('2026-11-26T02:00:00Z'), THANKSGIVING)).toBe('current'); // Wed 9 PM ET, tomorrow closed
    // a caller that has not read the closed days cannot judge it: not counted against the body
    expect(sla.slaPhraseStatus(reopenBody, now)).toBe('current');
    expect(sla.slaPhraseStatus('See you soon.', now, THANKSGIVING)).toBe('none');
  });

  test('drafted on Thanksgiving and sent Friday 10 AM, the untimed phrase is stale and the stale path blocks it', () => {
    const friday10 = at('2026-11-27T15:00:00Z');
    const args = { inputSnapshot: snap, promptVersion: V12, body: reopenBody, draftedAt: now };
    expect(sla.slaPhraseStatus(reopenBody, friday10, new Set())).toBe('stale'); // the office is open: within the hour is the phrase now
    expect(sla.slaPhraseStatus(reopenBody, friday10, THANKSGIVING)).toBe('stale'); // only Thanksgiving was closed
    expect(sla.followupPromiseBlockReason({ ...args, now: friday10, closedDates: new Set() })).toBe('sla_phrase_stale');
    // the same send while Thanksgiving is still on: not stale, and nothing to expire however long the closure
    expect(sla.followupPromiseBlockReason({ ...args, now: at('2026-11-26T20:00:00Z'), closedDates: THANKSGIVING })).toBeNull();
    // an open early morning (before 8 AM) is open too: the phrase now is "by 9 AM this morning"
    expect(sla.slaPhraseStatus(reopenBody, at('2026-11-27T10:00:00Z'), new Set())).toBe('stale');
    // a long closure: still current on day 5 while those days stay closed
    const week = new Set(['2026-12-01', '2026-12-02', '2026-12-03', '2026-12-04', '2026-12-05']);
    expect(sla.followupPromiseBlockReason({ ...args, now: at('2026-12-04T15:00:00Z'), closedDates: week })).toBeNull();
  });

  test('an unreadable closure read at send time is its own retryable reason, never "stale", for a timed or an untimed phrase', () => {
    const timedBody = 'A person will reply within the hour.';
    for (const body of [timedBody, reopenBody]) {
      const reason = sla.followupPromiseBlockReason({
        inputSnapshot: snap, promptVersion: V12, body, draftedAt: at('2026-11-26T14:30:00Z'), now, closedDates: CLOSED_DAYS_UNREADABLE,
      });
      expect(reason).toBe('closed_days_unreadable');
      expect(reason).toBe(sla.CLOSED_DAYS_UNREADABLE_REASON);
    }
    // not a follow-up promise: no phrase, nothing to hold
    expect(sla.followupPromiseBlockReason({ inputSnapshot: snap, promptVersion: V12, body: 'See you soon.', draftedAt: now, now, closedDates: CLOSED_DAYS_UNREADABLE })).toBeNull();
    // a timed phrase whose own deadline passed is still refused for good, read or no read
    expect(sla.followupPromiseBlockReason({
      inputSnapshot: snap, promptVersion: V12, body: timedBody, draftedAt: at('2026-11-26T10:00:00Z'), now, closedDates: CLOSED_DAYS_UNREADABLE,
    })).toBe('sla_deadline_passed');
  });

  test('a TIMED phrase is stale at send time once today is closed', () => {
    const timed = 'A person will reply within the hour.';
    expect(sla.slaPhraseStatus(timed, now, THANKSGIVING)).toBe('stale');
    const ordinary = at('2026-09-28T14:10:00Z');
    expect(sla.followupPromiseBlockReason({ inputSnapshot: snap, promptVersion: V12, body: timed, draftedAt: at('2026-09-28T14:00:00Z'), now: ordinary, closedDates: new Set() })).toBeNull();
    expect(sla.slaPhraseStatus('A person will reply by 9 AM tomorrow morning.', at('2026-09-28T23:00:00Z'), new Set())).toBe('stale');
  });

  // owner 2026-11-25: the drafter no longer quotes the follow-up phrase at all (quotesFactsSlaTiming is gone); the facts block still carries it
  // for the send seams above, and a draft that quotes it is refused.
  test('the drafter refuses every follow-up phrase, whichever one the facts state', () => {
    const prior = process.env.GATE_SMS_REAL_ANSWERS;
    process.env.GATE_SMS_REAL_ANSWERS = 'true';
    try {
      for (const phrase of [REOPEN, 'within the hour', 'by 9 AM tomorrow morning']) {
        expect(drafter.validateNoFollowupPromise({ reply: `A person will reply ${phrase}.` }).ok).toBe(false);
      }
      expect(drafter.validateNoFollowupPromise({ reply: 'Thanks!' }).ok).toBe(true);
    } finally {
      if (prior === undefined) delete process.env.GATE_SMS_REAL_ANSWERS;
      else process.env.GATE_SMS_REAL_ANSWERS = prior;
    }
  });
});

describe('the send seams treat an unreadable closure read as a retryable infrastructure failure', () => {
  const checks = require('../services/agent-decision-send-checks');

  test('the Agent Review block string is infrastructure: the card is kept, not superseded; a stale phrase still retires it', () => {
    expect(checks.blockReasonIsRecheckInfrastructure('follow-up promise unsendable (closed_days_unreadable)')).toBe(true);
    expect(checks.blockReasonIsFollowupInfrastructure('follow-up promise unsendable (closed_days_unreadable)')).toBe(true);
    expect(checks.blockReasonIsRecheckInfrastructure('follow-up promise unsendable (sla_phrase_stale)')).toBe(false);
    expect(checks.blockReasonIsRecheckInfrastructure('follow-up promise unsendable (sla_deadline_passed)')).toBe(false);
  });

  const decisionConn = (row) => {
    const conn = jest.fn(() => ({ where: () => ({ first: async () => row }) }));
    return conn;
  };
  const row = {
    input_snapshot: { intended_actions: [{ type: 'escalate', note: 'followup_promised' }] }, prompt_version: 'house_voice_v12_real_answers41_n',
    suggested_message: 'A person will reply as soon as the office reopens.', created_at: new Date('2026-11-26T15:00:00Z'),
  };
  const run = (body, conn = decisionConn(row)) => checks.followupProviderPreSendCheck({ decisionId: 'd1', getBody: () => body })({ dbi: conn });

  test('at the provider boundary: unreadable is retryable, an open office makes the untimed phrase stale for good', async () => {
    jest.useFakeTimers({ toFake: ['Date'], now: new Date('2026-11-27T15:00:00Z') }); // Friday 10 AM ET
    try {
      getBlackoutDates.mockRejectedValueOnce(new Error('settings down'));
      const unreadable = await run(row.suggested_message);
      expect(unreadable).toMatchObject({ ok: false, code: 'CLOSED_DAYS_UNREADABLE_AT_BOUNDARY', retryable: true, reason: 'follow-up promise unsendable (closed_days_unreadable)' });
      getBlackoutDates.mockResolvedValueOnce(new Set(['2026-11-26']));
      const stale = await run(row.suggested_message);
      expect(stale).toMatchObject({ ok: false, code: 'FOLLOWUP_PROMISE_STALE_AT_BOUNDARY' });
      expect(stale.retryable).toBeUndefined();
      // a body with no follow-up phrase is not this check's business
      expect(await run('See you soon.')).toEqual({ ok: true });
    } finally {
      jest.useRealTimers();
    }
  });

  test('at the provider boundary: still closed passes, and a decision row that cannot be read refuses retryably', async () => {
    jest.useFakeTimers({ toFake: ['Date'], now: new Date('2026-11-26T20:00:00Z') }); // Thanksgiving 3 PM ET
    try {
      getBlackoutDates.mockResolvedValueOnce(new Set(['2026-11-26']));
      expect(await run(row.suggested_message)).toEqual({ ok: true });
      const broken = jest.fn(() => { throw new Error('db down'); });
      expect(await run(row.suggested_message, broken)).toMatchObject({ ok: false, retryable: true, code: 'CLOSED_DAYS_UNREADABLE_AT_BOUNDARY' });
    } finally {
      jest.useRealTimers();
    }
  });

  test('the scheduler defers an unreadable read to that boundary check instead of retiring the queued text, and composes the check', () => {
    const src = require('fs').readFileSync(require('path').join(__dirname, '../services/scheduler.js'), 'utf8');
    expect(src).toContain("if (slaReason === 'closed_days_unreadable') {");
    expect(src).toMatch(/slaReason === 'closed_days_unreadable'\) \{\n\s+logger\.warn[^\n]*deferring to the provider-boundary check[\s\S]*?\} else if \(slaReason\) \{\n\s+slaStale = true;/);
    expect(src).toContain('followupProviderPreSendCheck({ decisionId: claimMeta.agent_decision_id, getBody: () => replayInput.body })');
    const route = require('fs').readFileSync(require('path').join(__dirname, '../routes/admin-communications.js'), 'utf8');
    expect(route).toContain('checks.followupProviderPreSendCheck({ decisionId: verifiedAgentDecision.id, getBody: () => cleanBody })');
  });
});

describe('the value rides only in the per-draft facts block', () => {
  const GATE = 'GATE_SMS_REAL_ANSWERS';
  const saved = process.env[GATE];
  beforeEach(() => { process.env[GATE] = 'true'; });
  afterEach(() => { if (saved === undefined) delete process.env[GATE]; else process.env[GATE] = saved; });

  test('buildFactsBlock renders the closure-aware phrase; the system prompt never carries it', () => {
    const before = buildSystemPrompt();
    const ctx = { summary: 'Test customer' };
    const block = buildFactsBlock(ctx, { now: at('2026-11-26T15:00:00Z'), closedDates: THANKSGIVING });
    expect(block).toContain(`FOLLOW-UP SLA RIGHT NOW: ${REOPEN}\n`);
    expect(buildFactsBlock(ctx, { now: at('2026-11-26T15:00:00Z') })).toContain('FOLLOW-UP SLA RIGHT NOW: within the hour\n');
    expect(buildSystemPrompt()).toBe(before);
    expect(before).not.toContain(REOPEN);
  });
});
