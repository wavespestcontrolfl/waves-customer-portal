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

describe('followupSlaPhrase with closed days', () => {
  test('Thanksgiving at 10 AM ET: names the next open day, not "within the hour"', () => {
    expect(followupSlaPhrase(at('2026-11-26T15:00:00Z'), THANKSGIVING)).toBe('by 9 AM Friday');
  });

  test('the evening before Thanksgiving, after 8 PM ET: Friday, not "tomorrow morning"', () => {
    expect(followupSlaPhrase(at('2026-11-26T02:00:00Z'), THANKSGIVING)).toBe('by 9 AM Friday'); // Wed 9 PM ET
    expect(followupSlaPhrase(at('2026-11-26T01:00:00Z'), THANKSGIVING)).toBe('by 9 AM Friday'); // Wed 8 PM ET (boundary)
    // before 8 PM Wednesday the office is still open, so the promise is the plain one
    expect(followupSlaPhrase(at('2026-11-25T23:00:00Z'), THANKSGIVING)).toBe('within the hour'); // Wed 6 PM ET
  });

  test('Thanksgiving early morning and late night, both before Friday 9 AM', () => {
    expect(followupSlaPhrase(at('2026-11-26T10:00:00Z'), THANKSGIVING)).toBe('by 9 AM Friday'); // Thu 5 AM ET
    expect(followupSlaPhrase(at('2026-11-27T03:00:00Z'), THANKSGIVING)).toBe('by 9 AM Friday'); // Thu 10 PM ET
  });

  test('Christmas 2027 (a Saturday): Friday 12-24 and Saturday 12-25 are closed, Sunday is a work day', () => {
    expect(followupSlaPhrase(at('2027-12-24T15:00:00Z'), CHRISTMAS_2027)).toBe('by 9 AM Sunday'); // Fri 10 AM ET
    expect(followupSlaPhrase(at('2027-12-25T15:00:00Z'), CHRISTMAS_2027)).toBe('by 9 AM Sunday'); // Sat 10 AM ET
    expect(followupSlaPhrase(at('2027-12-24T02:00:00Z'), CHRISTMAS_2027)).toBe('by 9 AM Sunday'); // Thu 9 PM ET, tomorrow closed
    expect(followupSlaPhrase(at('2027-12-26T15:00:00Z'), CHRISTMAS_2027)).toBe('within the hour'); // Sunday 10 AM ET
  });

  test('a normal weekday keeps the old phrases, byte for byte, with or without closed days elsewhere', () => {
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

  test('a window with nothing open inside it keeps the plain phrase', () => {
    const all = new Set();
    for (let d = 1; d <= 31; d += 1) all.add(`2026-12-${String(d).padStart(2, '0')}`);
    for (let d = 1; d <= 31; d += 1) all.add(`2027-01-${String(d).padStart(2, '0')}`);
    expect(followupSlaPhrase(at('2026-12-10T15:00:00Z'), all)).toBe('within the hour');
  });
});

describe('loadFollowupClosedDates', () => {
  beforeEach(() => jest.clearAllMocks());

  test('reads today through 30 days ahead from the shared closed-day reader, strictly', async () => {
    getBlackoutDates.mockResolvedValue(new Set(['2026-11-26']));
    const closed = await sla.loadFollowupClosedDates(at('2026-11-26T15:00:00Z'));
    expect(getBlackoutDates).toHaveBeenCalledWith('2026-11-26', '2026-12-26', undefined, { strict: true });
    expect(closed).toEqual(new Set(['2026-11-26']));
  });

  test('a failed read keeps today\'s phrase and logs a warning', async () => {
    getBlackoutDates.mockRejectedValue(new Error('settings down'));
    const closed = await sla.loadFollowupClosedDates(at('2026-11-26T15:00:00Z'));
    expect(closed).toEqual(new Set());
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('closed days not read'));
    expect(followupSlaPhrase(at('2026-11-26T15:00:00Z'), closed)).toBe('within the hour');
  });
});

describe('the verifier side accepts the weekday family and keeps its strictness', () => {
  test('the named-day phrases are in SLA_PHRASES, so a promise to a named day reads as a follow-up promise', () => {
    for (const day of sla.WEEKDAY_NAMES) expect(sla.SLA_PHRASES).toContain(`by 9 AM ${day}`);
    expect(sla.replyPromisesFollowup('We will get back to you by 9 AM Friday.')).toBe(true);
  });

  test('slaPhraseStatus: only the phrase the clock and closed days give is current', () => {
    const now = at('2026-11-26T15:00:00Z'); // Thanksgiving 10 AM ET
    expect(sla.slaPhraseStatus('A person will reply by 9 AM Friday.', now, THANKSGIVING)).toBe('current');
    expect(sla.slaPhraseStatus('A person will reply within the hour.', now, THANKSGIVING)).toBe('stale');
    expect(sla.slaPhraseStatus('A person will reply by 9 AM Monday.', now, THANKSGIVING)).toBe('stale');
    expect(sla.slaPhraseStatus('A person will reply by 9 AM tomorrow morning.', now, THANKSGIVING)).toBe('stale');
    // without the closed days the same Friday promise is not the current phrase
    expect(sla.slaPhraseStatus('A person will reply by 9 AM Friday.', now)).toBe('stale');
    expect(sla.slaPhraseStatus('See you soon.', now, THANKSGIVING)).toBe('none');
  });

  test('the drafter\'s own check quotes only the phrase the facts state', () => {
    const facts = 'FOLLOW-UP SLA RIGHT NOW: by 9 AM Friday\nBILLING:\n';
    expect(quotesFactsSlaTiming('A person will reply by 9 AM Friday.', facts)).toBe(true);
    expect(quotesFactsSlaTiming('A person will reply by 9 AM tomorrow morning.', facts)).toBe(false);
    expect(quotesFactsSlaTiming('A person will reply within the hour.', facts)).toBe(false);
    expect(quotesFactsSlaTiming('A person will reply by 9 AM Friday or by 9 AM Monday.', facts)).toBe(false);
    expect(quotesFactsSlaTiming('Thanks!', facts)).toBe(false);
    // a frozen block with no SLA line falls back to the clock
    expect(quotesFactsSlaTiming('A person will reply within the hour.', 'BILLING:\n')).toBe(
      sla.slaPhraseStatus('A person will reply within the hour.') === 'current',
    );
  });

  test('the deadline of a named-day promise is that weekday 9 AM ET after the draft', () => {
    // drafted Thanksgiving 10 AM ET: Friday 2026-11-27 9 AM ET = 14:00Z
    expect(sla.followupDeadline('by 9 AM Friday', at('2026-11-26T15:00:00Z')).toISOString()).toBe('2026-11-27T14:00:00.000Z');
    // drafted Thursday 12-23 9 PM ET before Christmas 2027: Sunday 12-26 9 AM ET = 14:00Z
    expect(sla.followupDeadline('by 9 AM Sunday', at('2027-12-24T02:00:00Z')).toISOString()).toBe('2027-12-26T14:00:00.000Z');
    expect(sla.followupDeadline('by 9 AM Saturday', at('2026-11-26T15:00:00Z')).toISOString()).toBe('2026-11-28T14:00:00.000Z');
  });

  test('the send seam: a named-day promise passes while current, blocks stale, and blocks past its deadline', () => {
    const snap = { intended_actions: [{ type: 'escalate', note: 'followup_promised' }] };
    const args = { inputSnapshot: snap, promptVersion: 'house_voice_v12_real_answers41_n', body: 'A person will reply by 9 AM Friday.', draftedAt: at('2026-11-26T15:00:00Z') };
    expect(sla.followupPromiseBlockReason({ ...args, now: at('2026-11-26T18:00:00Z'), closedDates: THANKSGIVING })).toBeNull();
    // same body when the closed days could not be read now: not the current phrase
    expect(sla.followupPromiseBlockReason({ ...args, now: at('2026-11-26T18:00:00Z') })).toBe('sla_phrase_stale');
    // Friday 9 AM ET has passed
    expect(sla.followupPromiseBlockReason({ ...args, now: at('2026-11-27T15:00:00Z'), closedDates: THANKSGIVING })).toBe('sla_deadline_passed');
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
    expect(block).toContain('FOLLOW-UP SLA RIGHT NOW: by 9 AM Friday\n');
    expect(buildFactsBlock(ctx, { now: at('2026-11-26T15:00:00Z') })).toContain('FOLLOW-UP SLA RIGHT NOW: within the hour\n');
    expect(buildSystemPrompt()).toBe(before);
    expect(before).not.toMatch(/by 9 AM (Friday|Sunday)/);
  });
});
