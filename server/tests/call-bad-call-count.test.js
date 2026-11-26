/**
 * Bad inbound calls per lead source: the source fill for a new inbound row, the answer-speed stamp,
 * the weekly summary shape and the weekly notification. Synthetic rows only.
 */
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../models/db', () => jest.fn());

const TWILIO_NUMBERS = require('../config/twilio-numbers');
const logger = require('../services/logger');
const { composeAdminAlert } = require('../services/admin-alert-compose');
const {
  inboundCallSource, stampAnswerSeconds, weeklyBadCallSummary, runWeeklyBadCallAlert, _private,
} = require('../services/call-bad-call-count');

const GBP = TWILIO_NUMBERS.gbpTracking.venice.number;
const GOOGLE_ADS = TWILIO_NUMBERS.paidTracking.googleAdsPest.number;
const HUB_LINE = TWILIO_NUMBERS.locations.sarasota.number;

describe('inboundCallSource (call_log.source on a new inbound row)', () => {
  test('uses the number registry mapping, not a second one', () => {
    expect(inboundCallSource(GBP)).toBe(TWILIO_NUMBERS.getLeadSourceFromNumber(GBP).source);
    expect(inboundCallSource(GBP)).toBe('google_business');
    expect(inboundCallSource(GOOGLE_ADS)).toBe('google_ads');
    expect(inboundCallSource(HUB_LINE)).toBe('waves_website');
  });
  test('normalizes a formatted number the way the row stores it', () => {
    expect(inboundCallSource(`(${GBP.slice(2, 5)}) ${GBP.slice(5, 8)}-${GBP.slice(8)}`)).toBe('google_business');
  });
  test('an unmapped or empty number gives null, so the column stays empty', () => {
    expect(inboundCallSource('+19415550100')).toBeNull();
    expect(inboundCallSource('')).toBeNull();
    expect(inboundCallSource(undefined)).toBeNull();
  });
});

describe('the /voice webhook source column', () => {
  const { _test } = require('../routes/twilio-voice-webhook');
  test('adds source only when the dialed number maps, so an already-set source is never overwritten by an insert', () => {
    expect(_test.dialedSourceColumn(GBP)).toEqual({ source: 'google_business' });
    expect(_test.dialedSourceColumn('+19415550100')).toEqual({});
  });
});

describe('stampAnswerSeconds', () => {
  function chain(update) {
    const q = { where: jest.fn(() => q), whereNull: jest.fn(() => q), update };
    const database = jest.fn(() => q);
    database.raw = jest.fn((sql, bindings) => ({ sql, bindings }));
    return { database, q };
  }

  test('stamps once, on the parent row, from the call start to the accept time', async () => {
    const update = jest.fn().mockResolvedValue(1);
    const { database, q } = chain(update);
    const acceptedAt = new Date('2026-11-23T15:00:12.000Z');
    await expect(stampAnswerSeconds({ parentCallSid: 'CA_parent', acceptedAt, database })).resolves.toBe(1);
    expect(q.where).toHaveBeenCalledWith('twilio_call_sid', 'CA_parent');
    expect(q.whereNull).toHaveBeenCalledWith('answer_seconds');
    const { answer_seconds: stamp } = update.mock.calls[0][0];
    expect(stamp.sql).toContain('created_at');
    expect(stamp.bindings).toEqual(['2026-11-23T15:00:12.000Z']);
  });

  test('fails soft: a database error never reaches the call', async () => {
    const { database } = chain(jest.fn().mockRejectedValue(Object.assign(new Error('boom'), { code: '42703' })));
    await expect(stampAnswerSeconds({ parentCallSid: 'CA_parent', database })).resolves.toBe(0);
    expect(logger.warn).toHaveBeenCalledWith('[answer-seconds] stamp failed (42703)');
  });

  test('fails soft when the query builder itself throws, and skips a call with no parent sid', async () => {
    const database = jest.fn(() => { throw new Error('no pool'); });
    await expect(stampAnswerSeconds({ parentCallSid: 'CA_parent', database })).resolves.toBe(0);
    await expect(stampAnswerSeconds({ parentCallSid: null, database })).resolves.toBe(0);
  });

  test('rememberForwardAccept still returns its own write when the stamp cannot run', async () => {
    const db = require('../models/db');
    db.raw = jest.fn((sql, bindings) => ({ sql, bindings }));
    const update = jest.fn().mockResolvedValue(1);
    db.mockReturnValue({ where: jest.fn(() => ({ update })) }); // no whereNull: the stamp throws inside its try
    const { _test } = require('../routes/twilio-voice-webhook');
    await expect(_test.rememberForwardAccept({ parentCallSid: 'CA_parent', dialCallSid: 'CA_child' })).resolves.toBe(1);
  });
});

const T = (iso) => new Date(iso);
const rows = [
  // Google Business Profile: answered fast, answered slow, one voicemail, one spam found only by the old fields
  { source: 'google_business', to_phone: GBP, answered_by: 'human', answer_seconds: 8, invalid_reason: null },
  { source: null, to_phone: GBP, answered_by: 'human', answer_seconds: 20, invalid_reason: null },
  { source: null, to_phone: GBP, answered_by: 'voicemail', call_outcome: 'voicemail', answer_seconds: null, ai_extraction: { is_spam: true } },
  { source: 'google_business', to_phone: GBP, answered_by: null, invalid_reason: 'wrong_number' },
  // Google Ads: one solicitor
  { source: 'google_ads', to_phone: GOOGLE_ADS, answered_by: 'human', answer_seconds: 5, invalid_reason: 'solicitor' },
  // an old row with no source and a number the registry does not know
  { source: null, to_phone: '+19415550100', answered_by: 'ai_agent', ai_extraction: JSON.stringify({ call_type: 'new_inquiry' }) },
];

describe('weekly summary shape', () => {
  test('one entry per source with calls, people, voicemail, each reason and the median answer time', () => {
    const sources = _private.summarizeRows(rows);
    expect(sources.map((s) => s.source)).toEqual(['google_business', 'google_ads', 'unknown']);
    const gbp = sources[0];
    expect(gbp).toMatchObject({ calls: 4, answeredByPerson: 2, voicemail: 1, invalid: 2, medianAnswerSeconds: 14 });
    expect(gbp.reasons).toEqual({ spam: 1, wrong_number: 1, solicitor: 0, out_of_area: 0, service_not_offered: 0, silent: 0 });
    expect(sources[1]).toMatchObject({ calls: 1, invalid: 1, medianAnswerSeconds: 5 });
    expect(sources[1].reasons.solicitor).toBe(1);
    expect(sources[2]).toMatchObject({ calls: 1, invalid: 0, answeredByPerson: 0, medianAnswerSeconds: null });
  });

  test('a null source is derived from the dialed number and a null reason from the row itself (rows older than the change)', () => {
    const [only] = _private.summarizeRows([{ source: null, to_phone: HUB_LINE, ai_extraction: { is_spam: true } }]);
    expect(only.source).toBe('waves_website');
    expect(only.reasons.spam).toBe(1);
  });

  test('median of an even count rounds to a whole second', () => {
    expect(_private.median([])).toBeNull();
    expect(_private.median([4, 9])).toBe(7);
    expect(_private.median([30, 2, 10])).toBe(10);
  });

  test('weeklyBadCallSummary reads the previous Monday-to-Sunday week and totals it', async () => {
    const loadRows = jest.fn().mockResolvedValue(rows);
    const summary = await weeklyBadCallSummary({ now: T('2026-11-30T12:58:00Z'), loadRows }); // Monday 7:58 AM ET
    expect(loadRows.mock.calls[0][0].start.toISOString()).toBe('2026-11-23T05:00:00.000Z');
    expect(loadRows.mock.calls[0][0].end.toISOString()).toBe('2026-11-30T05:00:00.000Z');
    expect(summary.totals).toEqual({ calls: 6, invalid: 3 });
    expect(summary.sources).toHaveLength(3);
  });
});

describe('weekly notification', () => {
  const summary = { start: T('2026-11-23T05:00:00Z'), end: T('2026-11-30T05:00:00Z'), totals: { calls: 6, invalid: 3 }, sources: _private.summarizeRows(rows) };

  test('composes a valid alert with one short line per source and no phone number or name', () => {
    const { spec, detail } = _private.composeBadCallAlert(summary);
    expect(() => composeAdminAlert(spec)).not.toThrow();
    const lines = detail.split('\n').slice(1);
    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe('Google Business Profile: 4 calls, 2 answered by a person, 1 voicemail, 2 bad (1 spam, 1 wrong number), median answer 14 s.');
    expect(lines[2]).toContain('Unmapped number: 1 call,');
    expect(lines[2]).toContain('no answer time');
    expect(detail).not.toMatch(/\+?\d{10}|\(\d{3}\) ?\d{3}/);
  });

  test('a week with no inbound calls writes nothing', async () => {
    const raise = jest.fn();
    const out = await runWeeklyBadCallAlert({ summarize: async () => ({ ...summary, totals: { calls: 0, invalid: 0 }, sources: [] }), raise });
    expect(out.skipped).toBe('no_calls');
    expect(raise).not.toHaveBeenCalled();
  });

  test('raises one system row per report week and rings (bell: true)', async () => {
    const raise = jest.fn().mockResolvedValue({ id: 'n1', deduped: false });
    const out = await runWeeklyBadCallAlert({ summarize: async () => summary, raise });
    expect(out).toMatchObject({ raised: true, calls: 6, invalid: 3 });
    const [category, spec, opts] = raise.mock.calls[0];
    expect(category).toBe('system');
    expect(spec.who).toBe('person');
    expect(opts).toMatchObject({ dedupeKey: 'bad-call-count-weekly:2026-11-30', bell: true });
  });

  test('a failed write throws, so the cron records it', async () => {
    await expect(runWeeklyBadCallAlert({ summarize: async () => summary, raise: jest.fn().mockResolvedValue(null) })).rejects.toThrow('not written');
  });
});
