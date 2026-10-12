/**
 * GATE_CALL_SPELLING_COLLAPSE_TRIGGER: a spelling the primary transcript collapsed
 * ("Serov, Serov") still buys the spelling-preserving second pass and the decoder. Dark by
 * default. Synthetic names only.
 */

jest.mock('../models/db', () => {
  const state = { customer: null };
  const builder = {};
  for (const m of ['where', 'whereNull', 'orWhere', 'whereRaw', 'forUpdate']) builder[m] = jest.fn(() => builder);
  builder.first = jest.fn(async () => state.customer);
  builder.update = jest.fn(async () => 1);
  const db = jest.fn(() => builder);
  db.transaction = jest.fn(async (fn) => fn(db));
  db.raw = jest.fn((sql, bindings) => ({ sql, bindings }));
  db.__state = state;
  db.__builder = builder;
  return db;
});
jest.mock('twilio', () => {
  const remove = jest.fn(async () => {});
  const recordings = Object.assign(jest.fn(() => ({ remove })), { list: jest.fn(async () => []) });
  const factory = jest.fn(() => ({ recordings }));
  factory.__recordings = recordings;
  factory.__remove = remove;
  return factory;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../config/twilio-numbers', () => ({
  isInternalNumber: jest.fn(() => false),
  isOwnedNumber: jest.fn(() => false),
  findByNumber: jest.fn(() => null),
  getLeadSourceFromNumber: jest.fn(() => ({ source: 'phone_call' })),
}));
jest.mock('../utils/triage-locks', () => ({
  lockTriageCall: jest.fn(),
  syncCallReviewStatus: jest.fn(),
}));

const db = require('../models/db');
const twilio = require('twilio');
const logger = require('../services/logger');
const { _test } = require('../services/call-recording-processor');
const {
  spellingCollapseSignals,
  detectContactDictationSignals,
  sanitizeNameEntries,
  nameSpellingDifferences,
} = require('../services/contact-dictation');

const { contactPassTrigger, contactPassTriggerLogged, contactDecoderGate, persistLateContactPass } = _test;
const collapsed = (t, ctx) => spellingCollapseSignals(t, ctx).any;
const GATE = 'GATE_CALL_SPELLING_COLLAPSE_TRIGGER';
const COLLAPSED = 'Agent: Can I get your last name?\nCaller: Serov, Serov.\nAgent: Thanks, and the best number to reach you?';
const SPELLED_SECOND_PASS = 'Agent: Can I get your last name?\nCaller: Serov, S-E-R-O-V.\nAgent: Thanks, and the best number to reach you?';

afterEach(() => {
  delete process.env[GATE];
  delete process.env.CONTACT_DICTATION_ENABLED;
  jest.clearAllMocks();
  db.__state.customer = null;
});

describe('spellingCollapseSignals', () => {
  test.each([
    ['a repeated name token', 'Caller: My last name is Serov, Serov.'],
    ['a repeat across a full stop', 'Caller: It is Tarnow. Tarnow.'],
    ['a repeat across a speaker label', 'Agent: What is your last name?\nCaller: Marlowe.\nAgent: Marlowe? Marlowe.'],
    ['a repeat after "this is"', 'Caller: Hi, this is Okafor. Okafor.'],
    ['spelled, no letters after', 'Caller: Yes, it is spelled the usual way, nothing odd about it at all.'],
    ['"that\'s S" with no letters after', "Caller: Yes that's S and then the rest of it is simple enough, ok?"],
    ['"with a C" with no letters after', 'Caller: It begins with a C, like the sea. Then a long ending that I never say.'],
    ['a letter then "as in" with no word after', 'Caller: T as in, you know, the usual way people say it for the office.'],
  ])('fires on %s', (_label, text) => {
    expect(collapsed(text)).toBe(true);
  });

  test.each([
    ['filler repeats', 'Caller: Okay. Okay. Yes, yes, that works. Very very good.'],
    ['a weekday repeated', 'Caller: It is Monday. Monday. Can you come then?'],
    ['a state repeated', 'Caller: We are in Florida. Florida.'],
    ['a month repeated near "name"', 'Caller: My name is on the account, it is October. October.'],
    ['a capitalized repeat with no name context', 'Caller: Tarnow. Tarnow.'],
    ['a plain greeting', 'Caller: Hi, I have ants in my kitchen and I would like a quote.'],
    ['a dry spell', 'Caller: We had a dry spell and the lawn is brown.'],
    ['a stutter without punctuation', 'Caller: The the garage side is the worst.'],
    ['"with a" and a lowercase word', 'Caller: I need a plan with a bait station around the house.'],
    ['empty', ''],
    ['null', null],
  ])('stays quiet on %s', (_label, text) => {
    expect(collapsed(text)).toBe(false);
  });

  test('an announcement followed by its letters is the detector\'s job, not this one', () => {
    const t = 'Caller: that\'s S, E, R, O, V.';
    expect(spellingCollapseSignals(t).announced).toBe(false);
    expect(detectContactDictationSignals(t).any).toBe(true);
  });

  test('the extracted name itself is name context', () => {
    const t = 'Caller: Tarnow. Tarnow.';
    expect(collapsed(t, { extracted: { last_name: 'Tarnow' } })).toBe(true);
    expect(collapsed(t, { extracted: { last_name: 'Other' } })).toBe(false);
  });

  test('near miss: the extracted last name is the stored one off by one or two letters, same first letter', () => {
    const known = { last_name: 'Serov' };
    expect(collapsed('x', { extracted: { last_name: 'Serof' }, knownCustomer: known })).toBe(true);
    expect(collapsed('x', { extracted: { last_name: 'Sarow' }, knownCustomer: known })).toBe(true);
    expect(collapsed('x', { extracted: { last_name: 'serov' }, knownCustomer: known })).toBe(false); // same name
    expect(collapsed('x', { extracted: { last_name: 'Perov' }, knownCustomer: known })).toBe(false); // first letter differs
    expect(collapsed('x', { extracted: { last_name: 'Sorokin' }, knownCustomer: known })).toBe(false); // too far
    expect(collapsed('x', { extracted: { last_name: 'Lam' }, knownCustomer: { last_name: 'Lee' } })).toBe(false); // short name: one letter only
    expect(collapsed('x', { extracted: { last_name: 'Lea' }, knownCustomer: { last_name: 'Lee' } })).toBe(true);
    expect(collapsed('x', { extracted: { last_name: 'Serof' }, knownCustomer: null })).toBe(false);
    expect(collapsed('x', { extracted: null, knownCustomer: known })).toBe(false);
  });

  test('the boolean wrapper is gone: only spellingCollapseSignals is exported', () => {
    expect(require('../services/contact-dictation').spellingLikelyCollapsed).toBeUndefined();
  });

  test('reports which signal fired', () => {
    expect(spellingCollapseSignals('Caller: my last name is Serov, Serov.')).toEqual({ repeated: true, announced: false, nearMiss: false, any: true });
    expect(spellingCollapseSignals('x', { extracted: { last_name: 'Serof' }, knownCustomer: { last_name: 'Serov' } }))
      .toEqual({ repeated: false, announced: false, nearMiss: true, any: true });
  });
});

describe('contactPassTrigger (the gate for the second pass)', () => {
  test('dark by default: a collapsed transcript buys nothing', () => {
    expect(contactPassTrigger(COLLAPSED)).toBeNull();
  });

  test('gate on: the collapsed transcript buys the pass and says which signal', () => {
    process.env[GATE] = 'true';
    expect(contactPassTrigger(COLLAPSED)).toBe('collapse:repeated');
  });

  test('gate on: only the exact string true turns it on', () => {
    process.env[GATE] = '1';
    expect(contactPassTrigger(COLLAPSED)).toBeNull();
  });

  test('the old detector keeps its own label and wins even with the gate on', () => {
    process.env[GATE] = 'true';
    expect(contactPassTrigger('Caller: my email is jay at gmail dot com')).toBe('signals');
    process.env[GATE] = 'false';
    expect(contactPassTrigger('Caller: my email is jay at gmail dot com')).toBe('signals');
  });

  test('gate on, nothing suspicious: no pass', () => {
    process.env[GATE] = 'true';
    expect(contactPassTrigger('Caller: I have ants in the kitchen.')).toBeNull();
    expect(contactPassTrigger('')).toBeNull();
  });
});

describe('the log line names the signal and masks the call sid', () => {
  test('logs only when the new trigger is what buys the pass', () => {
    process.env[GATE] = 'true';
    const call = { twilio_call_sid: 'CAabcdef0123456789abcdef0123456789' };
    expect(contactPassTriggerLogged(COLLAPSED, call, 'second_pass')).toBe(true);
    expect(logger.info).toHaveBeenCalledTimes(1);
    const line = logger.info.mock.calls[0][0];
    expect(line).toContain('spelling collapse trigger (second_pass): repeated');
    expect(line).not.toContain(call.twilio_call_sid);
    logger.info.mockClear();
    expect(contactPassTriggerLogged('Caller: my email is jay at gmail dot com', call, 'second_pass')).toBe(true);
    expect(contactPassTriggerLogged('Caller: ants.', call, 'second_pass')).toBe(false);
    expect(logger.info).not.toHaveBeenCalled();
  });
});

describe('contactDecoderGate', () => {
  const URL_ = 'https://api.twilio.com/2010-04-01/Accounts/ACtest/Recordings/RE0123456789abcdef0123456789abcdef.mp3';
  const mkCall = () => ({ id: 'call-1', customer_id: 'cust-1', recording_url: URL_, recording_sid: 'RE0123456789abcdef0123456789abcdef' });
  const base = () => ({ call: mkCall(), contactPhone: '+15555550100', callSid: 'CA1234567890abcdef', extracted: { last_name: 'Serof' }, transcription: 'Caller: hello there', contactPassTranscript: null });
  const OFF = { run: false, lateContactPass: null, late: null, panCount: 0 };
  const realFetch = global.fetch;
  const audio = { ok: true, arrayBuffer: async () => new ArrayBuffer(8), headers: { get: () => null } };
  const asr = (text) => ({ ok: true, headers: { get: () => 'application/json' }, json: async () => ({ text }) });
  beforeEach(() => {
    process.env.OPENAI_API_KEY = 'test';
    process.env.TWILIO_ACCOUNT_SID = 'ACtest00000000000000000000000000';
    process.env.TWILIO_AUTH_TOKEN = 'token';
    db.__state.customer = { last_name: 'Serov' };
    global.fetch = jest.fn();
  });
  afterEach(() => { global.fetch = realFetch; });

  test('unchanged paths: a second-pass transcript or a dictation signal runs the decoder with the gate off', async () => {
    expect(await contactDecoderGate({ ...base(), transcription: COLLAPSED, contactPassTranscript: 'second' })).toEqual({ ...OFF, run: true });
    expect(await contactDecoderGate({ ...base(), transcription: 'my email is jay at gmail dot com' })).toEqual({ ...OFF, run: true });
    expect(await contactDecoderGate({ ...base(), transcription: COLLAPSED })).toEqual(OFF);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('gate on, no recording left: fails open to no decoder', async () => {
    process.env[GATE] = 'true';
    const input = base();
    input.call.recording_url = null;
    expect(await contactDecoderGate(input)).toEqual(OFF);
  });

  test('gate on, near miss: one late pass runs and its scrubbed text feeds the decoder', async () => {
    process.env[GATE] = 'true';
    global.fetch.mockResolvedValueOnce(audio).mockResolvedValueOnce(asr('Caller: my last name is Serov, S-E-R-O-V.'));
    const out = await contactDecoderGate(base());
    expect(out).toMatchObject({ run: true, lateContactPass: 'Caller: my last name is Serov, S-E-R-O-V.', panCount: 0 });
    expect(out.late).toMatchObject({ model: 'gpt-4o-transcribe', chars: 'Caller: my last name is Serov, S-E-R-O-V.'.length });
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  test('kill switch: CONTACT_DICTATION_ENABLED=false means no download, no paid pass, no lookup', async () => {
    process.env[GATE] = 'true';
    process.env.CONTACT_DICTATION_ENABLED = 'false';
    expect(await contactDecoderGate(base())).toEqual(OFF);
    expect(global.fetch).not.toHaveBeenCalled();
    expect(db).not.toHaveBeenCalled();
  });

  test('a late pass that is the first to hear a card number quarantines the recording and decodes nothing', async () => {
    process.env[GATE] = 'true';
    global.fetch.mockResolvedValueOnce(audio).mockResolvedValueOnce(asr('Caller: sure, my card is 4111 1111 1111 1111 and Serov.'));
    const input = base();
    const out = await contactDecoderGate(input);
    expect(out).toMatchObject({ run: false, lateContactPass: null, late: null });
    expect(out.panCount).toBeGreaterThan(0);
    // The shared quarantine ran: Twilio delete of the recording, URL stripped on the row and in memory.
    expect(twilio.__remove).toHaveBeenCalled();
    expect(twilio.__recordings).toHaveBeenCalledWith('RE0123456789abcdef0123456789abcdef');
    expect(input.call.recording_url).toBeNull();
    const stripped = db.__builder.update.mock.calls.map((c) => c[0]).find((u) => u.recording_url === null);
    expect(stripped).toBeDefined();
    expect(JSON.parse(stripped.transcription_metadata)).toMatchObject({ pan_detected: true, quarantine_source: 'late_contact_pass' });
  });
});

describe('persistLateContactPass (token-fenced audit write)', () => {
  const gate = { late: { text: 'Caller: Serov, S-E-R-O-V.', model: 'gpt-4o-transcribe', chars: 25 }, panCount: 0 };
  const call = { id: 'call-1' };
  const metaOf = (patch) => JSON.parse(patch.transcription_metadata.bindings[patch.transcription_metadata.bindings.length - 1]);

  test('merges contact_pass_transcript INTO the accepted transcript\'s structured data and writes model / size metadata, fenced to the claim', async () => {
    const meta = { transcript_chars: 99, pan_count: 0 };
    expect(await persistLateContactPass({ call, procToken: 'tok-1', provenanceMetadata: meta, gate, relay: false })).toBe(true);
    expect(db.__builder.where).toHaveBeenCalledWith({ id: 'call-1' });
    expect(db.__builder.where).toHaveBeenCalledWith('processing_token', 'tok-1');
    const patch = db.__builder.update.mock.calls[0][0];
    // A merge (||) onto the existing value: a fallback's segments, or none, are never replaced.
    expect(patch.transcript_structured.sql).toMatch(/COALESCE\(transcript_structured, '\{\}'::jsonb\) \|\| \?::jsonb/);
    expect(JSON.parse(patch.transcript_structured.bindings[0])).toEqual({ contact_pass_transcript: gate.late.text });
    expect(metaOf(patch)).toMatchObject({ transcript_chars: 99, contact_pass_model: 'gpt-4o-transcribe', contact_pass_chars: 25 });
    expect(meta.contact_pass_model).toBe('gpt-4o-transcribe'); // in-memory provenance kept in step
  });

  test('works with no provenance at all (a fallback transcript): still a merge, never a replace', async () => {
    await persistLateContactPass({ call, procToken: 'tok-1', provenanceMetadata: null, gate, relay: false });
    const patch = db.__builder.update.mock.calls[0][0];
    expect(patch.transcript_structured.sql).toContain('||');
    expect(metaOf(patch)).toMatchObject({ contact_pass_model: 'gpt-4o-transcribe' });
  });

  test('a relay composite keeps no structured form: metadata only', async () => {
    await persistLateContactPass({ call, procToken: 'tok-1', provenanceMetadata: {}, gate, relay: true });
    expect(db.__builder.update.mock.calls[0][0]).not.toHaveProperty('transcript_structured');
  });

  test('a pass that heard a card number stamps pan_detected and pan_count, and no transcript', async () => {
    await persistLateContactPass({ call, procToken: 'tok-1', provenanceMetadata: { pan_count: 1 }, gate: { late: null, panCount: 2 }, relay: false });
    const patch = db.__builder.update.mock.calls[0][0];
    expect(patch).not.toHaveProperty('transcript_structured');
    expect(metaOf(patch)).toMatchObject({ pan_detected: true, pan_count: 2 });
  });

  test('a lost claim reports false; nothing to persist writes nothing', async () => {
    db.__builder.update.mockResolvedValueOnce(0);
    expect(await persistLateContactPass({ call, procToken: 'tok-1', provenanceMetadata: {}, gate, relay: false })).toBe(false);
    db.__builder.update.mockClear();
    expect(await persistLateContactPass({ call, procToken: 'tok-1', provenanceMetadata: {}, gate: { late: null, panCount: 0 }, relay: false })).toBe(true);
    expect(db.__builder.update).not.toHaveBeenCalled();
  });
});

describe('downstream: a collapsed primary plus a spelled second pass grounds a spelling', () => {
  const entry = { raw_spoken: 'S-E-R-O-V', spelled_value: 'Serov', field: 'last_name', whose: 'caller', confidence: 0.92 };

  test('the primary alone grounds nothing, so no card could be filed', () => {
    expect(sanitizeNameEntries([entry], [COLLAPSED])).toEqual([]);
  });

  test('the second pass holds the letters: the same functions #6106 used ground the spelling and report the difference', () => {
    const names = sanitizeNameEntries([entry], [COLLAPSED, SPELLED_SECOND_PASS]);
    expect(names).toHaveLength(1);
    expect(names[0]).toMatchObject({ spelled_value: 'Serov', field: 'last_name', whose: 'caller' });
    expect(names[0].turn).toContain('S-E-R-O-V');
    const diffs = nameSpellingDifferences({ dictation: { names }, saved: { last_name: 'Serof' } });
    expect(diffs).toHaveLength(1);
    expect(diffs[0]).toMatchObject({ field: 'last_name', spelled_value: 'Serov', saved_value: 'Serof' });
  });

  test('the logger is unused by the pure detector', () => {
    collapsed(COLLAPSED);
    expect(logger.info).not.toHaveBeenCalled();
  });
});
