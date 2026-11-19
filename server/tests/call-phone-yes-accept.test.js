/**
 * GATE_CALL_PHONE_YES_ACCEPT, the parts that need no database (owner 2026-11-18, step 1: the office taps): the gate
 * reader, the wiring (the scheduler, the booking text, the admin-only card), the card's two states and the caller's
 * words. The sweep runs against PostgreSQL in call-phone-yes-accept.db.test.js. Synthetic names and numbers only.
 */
jest.mock('../models/db', () => jest.fn(() => { throw new Error('db must not be touched'); }));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const fs = require('fs');
const gates = require('../config/feature-gates');
const { runCallPhoneYesSweep, cardSummary, callerWordsOf, REASONS } = require('../services/call-phone-yes-accept');

const GATE = 'GATE_CALL_PHONE_YES_ACCEPT';
const saved = process.env[GATE];
afterEach(() => {
  if (saved === undefined) delete process.env[GATE]; else process.env[GATE] = saved;
});
const read = (path) => fs.readFileSync(require.resolve(path), 'utf8');

describe('the gate', () => {
  test('strict true only, read at call time; the boot log lists it', () => {
    delete process.env[GATE];
    expect(gates.callPhoneYesAcceptLive()).toBe(false);
    for (const v of ['1', 'TRUE', 'yes', 'on', '']) { process.env[GATE] = v; expect(gates.callPhoneYesAcceptLive()).toBe(false); }
    process.env[GATE] = 'true';
    expect(gates.callPhoneYesAcceptLive()).toBe(true);
    delete process.env[GATE];
    expect(gates.callPhoneYesAcceptLive()).toBe(false);
    expect(Object.keys(gates.gates)).toContain('callPhoneYesAccept');
  });

  test('off: the sweep returns before any query', async () => {
    delete process.env[GATE];
    await expect(runCallPhoneYesSweep()).resolves.toEqual({ skipped: true, scanned: 0, filed: 0, closed: 0 });
  });
});

describe('wiring', () => {
  test('the sweep is scheduled behind the gate, inside runExclusive', () => {
    const scheduler = read('../services/scheduler.js');
    expect(scheduler).toMatch(/if \(!require\('\.\.\/config\/feature-gates'\)\.callPhoneYesAcceptLive\(\)\) return;\s+try \{\s+await runExclusive\('call-phone-yes'/);
    expect(scheduler).toContain("require('./call-phone-yes-accept').runCallPhoneYesSweep()");
  });

  test('the booking text is untouched: it keeps the accept link', () => {
    expect(read('../services/call-recording-processor.js')).not.toContain('call-phone-yes-accept');
  });

  test('the cards accept nothing and send nothing', () => {
    const service = read('../services/call-phone-yes-accept.js');
    for (const word of ['markEstimateManuallyAccepted', 'convertEstimate', 'sendSms', 'sendEmail', 'twilio', 'sendgrid', 'sendInvoice',
      'notifyAdmin', 'sendCustomerMessage', 'sendMembershipStarted', '.update({ source_estimate_id', 'estimated_price:']) {
      expect(service).not.toContain(word);
    }
  });

  test('the sweep rewrites the card in place, so its Resolve and Dismiss carry the version; a new recording keeps it', () => {
    expect(read('../routes/admin-triage.js')).toMatch(/const VERSION_BOUND_REASONS = \[[^\]]*'call_phone_yes'/);
    const { SUPERSEDE_KEPT_REASON_CODES, SUPERSEDE_KEPT_CARD_SQL } = require('../services/call-routing-gates');
    expect(SUPERSEDE_KEPT_REASON_CODES).toContain('call_phone_yes');
    // The implausible-transcript rejection reads only the SQL.
    expect(SUPERSEDE_KEPT_CARD_SQL).toContain("OR reason_code = 'call_phone_yes' OR");
  });

  test('the card is admin only and never closed by a call verdict', () => {
    const triage = read('../routes/admin-triage.js');
    expect(triage).toMatch(/const ADMIN_ONLY_REASONS = \[[^\]]*'call_phone_yes'/);
    expect(triage).toMatch(/call_phone_yes: 'This card asks the office to accept/);
    expect(triage).toMatch(/\.whereNotIn\('reason_code', \[[\s\S]*?'call_phone_yes',[\s\S]*?\]\)/);
    const client = read('../../client/src/pages/admin/TriageInboxTabV2.jsx');
    expect(client).toMatch(/const NO_VERDICT_REASONS = new Set\(\[[^\]]*"call_phone_yes"/);
    expect(client).toMatch(/const EVIDENCE_BY_REASON = \{[^}]*call_phone_yes: PhoneYesEvidence/);
  });
});

describe('the card text', () => {
  test('while the call with the yes is read again, the headline says so and claims no yes', () => {
    expect(cardSummary({ yes: null, rechecking: true })).toBe(
      'A call booked a pest visit while an estimate is open. The call with the yes is being read again. The estimate is not accepted yet.',
    );
  });

  test('two states: a yes the call reader recorded, or no yes heard', () => {
    expect(cardSummary({ yes: { callLogId: 'call-1', at: new Date(), quote: null } }))
      .toBe('Caller said yes to pay per application on the call. The estimate is not accepted yet.');
    expect(cardSummary({ yes: null }))
      .toBe('A call booked a pest visit while an estimate is open. No yes heard on the call. The estimate is not accepted yet.');
    expect(cardSummary({ yes: null })).not.toMatch(/said yes/);
  });

  test('every reason is one plain sentence or two, with no code words', () => {
    for (const [code, text] of Object.entries(REASONS)) {
      expect(text).toMatch(/^[A-Z].*\.$/);
      expect(text).not.toContain(code);
    }
  });
});

describe("the caller's words", () => {
  const evidence = (...entries) => ({ evidence: entries });
  const choice = (quote, speaker = 'caller', fieldPath = '/service_request/billing_choice') => ({ field_path: fieldPath, quote, speaker, transcript_offset_ms: 100 });
  const talk = (callerLine, agentLine = 'You are all set.') => ({ transcript: `Agent: Thanks for calling Waves.\nCaller: ${callerLine}\nAgent: ${agentLine}` });

  test("the caller's whole sentence that holds the quote, from a caller turn; never staff's, never another field's", () => {
    const transcript = talk('Okay. Just bill me each time, that works.');
    expect(callerWordsOf(evidence(
      choice('We bill after each visit.', 'agent'),
      choice('Bill me each time.', 'caller', '/scheduling/status'),
      choice('  Just   bill me\neach time  '),
    ), transcript)).toBe('Just bill me each time, that works.');
    expect(callerWordsOf(evidence(choice('just bill me each time', 'caller', 'service_request.billing_choice')), transcript))
      .toBe('Just bill me each time, that works.');
  });

  test.each([
    ['a negated sentence', "Please don't bill me each time."],
    ['a hedge', 'Maybe just bill me each time.'],
    ['a question', 'Can you just bill me each time?'],
  ])('a quote inside %s is no yes', (_name, line) => {
    expect(callerWordsOf(evidence(choice('bill me each time')), talk(line))).toBeNull();
  });

  test('a quote the transcript does not hold in a caller turn is no words', () => {
    expect(callerWordsOf(evidence(choice('Just bill me each time.')), talk('I need someone out for the bugs.'))).toBeNull();
    expect(callerWordsOf(evidence(choice('Just bill me each time.')), talk('Okay.', 'Just bill me each time.'))).toBeNull();
    expect(callerWordsOf(evidence(choice('Just bill me each time.')), { transcript: 'Just bill me each time. You are all set.' })).toBeNull();
    expect(callerWordsOf(evidence(choice('Just bill me each time.')), { transcript: 'Caller: Just bill me each time.' })).toBeNull();
    expect(callerWordsOf(evidence(choice('Just bill me each time.')), {})).toBeNull();
  });

  test('an outbound call with swapped labels is read the way the triage flags read it', () => {
    const swapped = { transcript: 'Caller: Hi, this is Sam with Waves, calling about your quote.\nAgent: Just bill me each time.\nCaller: Will do.', outbound: true };
    expect(callerWordsOf(evidence(choice('Just bill me each time.')), swapped)).toBe('Just bill me each time.');
    expect(callerWordsOf(evidence(choice('Just bill me each time.')), { ...swapped, outbound: false })).toBeNull();
  });

  test('none: null', () => {
    expect(callerWordsOf({}, talk('x'))).toBeNull();
    expect(callerWordsOf(null, talk('x'))).toBeNull();
    expect(callerWordsOf(evidence(choice('   ')), talk('x'))).toBeNull();
    expect(callerWordsOf({ evidence: 'not a list' }, talk('x'))).toBeNull();
  });

  test('a long sentence is cut to 200 characters', () => {
    const long = `${'word '.repeat(80)}done`;
    const words = callerWordsOf(evidence(choice(long)), talk(long));
    expect(words).toHaveLength(200);
    expect(words.endsWith('\u2026')).toBe(true);
  });
});
