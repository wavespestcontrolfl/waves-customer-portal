// The follow-up SLA phrase on a closed day (owner 2026-11-24: Waves is closed on six holidays). The phrase rides only in the
// per-draft facts block, names the next OPEN day when today is closed or the next 9 AM is, and keeps every normal-day phrase.
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../services/scheduling/blackout-dates', () => ({ getBlackoutDates: jest.fn() }));

const logger = require('../services/logger');
const { getBlackoutDates } = require('../services/scheduling/blackout-dates');
const sla = require('../services/sms-followup-sla');
const drafter = require('../services/sms-shadow-drafter');

const { followupSlaPhrase, quotesFactsSlaTiming, buildFactsBlock, buildSystemPrompt } = drafter;
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

  test('the untimed phrase is never stale and has no deadline', () => {
    const body = `A person will reply ${REOPEN}.`;
    for (const closed of [null, THANKSGIVING, new Set(), CLOSED_DAYS_UNREADABLE]) {
      expect(sla.slaPhraseStatus(body, now, closed)).toBe('current');
      expect(sla.slaPhraseStatus(body, at('2026-12-30T15:00:00Z'), closed)).toBe('current');
    }
    expect(sla.slaPhraseStatus('See you soon.', now, THANKSGIVING)).toBe('none');
    expect(sla.followupDeadline(REOPEN, now)).toBeNull();
    // a multi-day closure: nothing to expire, nothing blocked for timing, however late it is sent
    const snap = { intended_actions: [{ type: 'escalate', note: 'followup_promised' }] };
    const args = { inputSnapshot: snap, promptVersion: 'house_voice_v12_real_answers41_n', body: `A person will reply ${REOPEN}.`, draftedAt: now };
    expect(sla.followupPromiseBlockReason({ ...args, now: at('2026-12-05T15:00:00Z'), closedDates: THANKSGIVING })).toBeNull();
    expect(sla.followupPromiseBlockReason({ ...args, now: at('2026-12-05T15:00:00Z'), closedDates: CLOSED_DAYS_UNREADABLE })).toBeNull();
    expect(sla.followupPromiseBlockReason({ ...args, now: at('2026-12-05T15:00:00Z') })).toBeNull();
  });

  test('a TIMED phrase is blocked at send time once today is closed or the closed days cannot be read', () => {
    const snap = { intended_actions: [{ type: 'escalate', note: 'followup_promised' }] };
    const timed = { inputSnapshot: snap, promptVersion: 'house_voice_v12_real_answers41_n', body: 'A person will reply within the hour.', draftedAt: at('2026-11-25T15:00:00Z') };
    const sendAt = at('2026-11-26T15:00:00Z');
    const sameDay = { ...timed, draftedAt: at('2026-11-26T14:30:00Z') };
    expect(sla.slaPhraseStatus(timed.body, sendAt, THANKSGIVING)).toBe('stale');
    expect(sla.slaPhraseStatus(timed.body, sendAt, CLOSED_DAYS_UNREADABLE)).toBe('stale');
    expect(sla.followupPromiseBlockReason({ ...sameDay, now: sendAt, closedDates: THANKSGIVING })).toBe('sla_phrase_stale');
    expect(sla.followupPromiseBlockReason({ ...sameDay, now: sendAt, closedDates: CLOSED_DAYS_UNREADABLE })).toBe('sla_phrase_stale');
    // an ordinary day with the closed days read: the timed phrase still passes
    const ordinary = at('2026-09-28T14:10:00Z');
    expect(sla.followupPromiseBlockReason({ ...timed, draftedAt: at('2026-09-28T14:00:00Z'), now: ordinary, closedDates: new Set() })).toBeNull();
    expect(sla.slaPhraseStatus('A person will reply by 9 AM tomorrow morning.', at('2026-09-28T23:00:00Z'), new Set())).toBe('stale');
  });

  test('the drafter\'s own check quotes only the phrase the facts state', () => {
    const facts = `FOLLOW-UP SLA RIGHT NOW: ${REOPEN}\nBILLING:\n`;
    expect(quotesFactsSlaTiming(`A person will reply ${REOPEN}.`, facts)).toBe(true);
    expect(quotesFactsSlaTiming('A person will reply within the hour.', facts)).toBe(false);
    expect(quotesFactsSlaTiming('A person will reply by 9 AM tomorrow morning.', facts)).toBe(false);
    expect(quotesFactsSlaTiming(`A person will reply ${REOPEN} or within the hour.`, facts)).toBe(false);
    expect(quotesFactsSlaTiming('Thanks!', facts)).toBe(false);
    expect(quotesFactsSlaTiming(`A person will reply ${REOPEN}.`, 'FOLLOW-UP SLA RIGHT NOW: within the hour\nBILLING:\n')).toBe(false);
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
