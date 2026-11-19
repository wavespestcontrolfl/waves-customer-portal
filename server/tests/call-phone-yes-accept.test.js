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

  test("the caller's own quote for the plan choice, never staff's, never another field's", () => {
    expect(callerWordsOf(evidence(
      choice('We bill after each visit.', 'agent'),
      choice('Bill me each time.', 'caller', '/scheduling/status'),
      choice('  Just   bill me\neach time.  '),
    ))).toBe('Just bill me each time.');
    expect(callerWordsOf(evidence(choice('Bill me each time.', 'caller', 'service_request.billing_choice')))).toBe('Bill me each time.');
  });

  test('none: null', () => {
    expect(callerWordsOf({})).toBeNull();
    expect(callerWordsOf(null)).toBeNull();
    expect(callerWordsOf(evidence(choice('   ')))).toBeNull();
    expect(callerWordsOf(evidence(choice('Bill me.', 'agent')))).toBeNull();
    expect(callerWordsOf({ evidence: 'not a list' })).toBeNull();
  });

  test('a long quote is cut to 200 characters', () => {
    const words = callerWordsOf(evidence(choice('a'.repeat(400))));
    expect(words).toHaveLength(200);
    expect(words.endsWith('…')).toBe(true);
  });
});
