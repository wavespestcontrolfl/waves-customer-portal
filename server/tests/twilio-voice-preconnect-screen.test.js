// Pre-connect caller screen (2026-07-24): unknown callers arriving with
// STIR/SHAKEN attestation B must press a key before staff phones ring
// (GATE_CALL_PRECONNECT_SCREEN; off = shadow 'would_gate' stamping only).
// These tests pin the two safety-critical invariants:
//   1. The decision NEVER gates a known customer, and NEVER gates on
//      attestation A/C/missing alone — absence of attestation is where most
//      real leads arrive and is NOT suspicion. Only the exchange trigger
//      (GATE_CALL_SCREEN_EXCHANGE_HISTORY, owner 2026-11-16) gates an A caller,
//      and its read fails open.
//   2. The challenge TwiML never rings staff (<Dial>) and never hangs up —
//      the no-input path redirects back into /voice as a screen failure,
//      which routes to the Waves voicemail recorder.
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/twilio-failure-alerts', () => ({
  alertTwilioFailure: jest.fn(),
  isFailureStatus: jest.fn(() => false),
}));
jest.mock('../services/conversations', () => ({
  recordTouchpoint: jest.fn(),
  syncVoiceMessageForCall: jest.fn(),
}));
jest.mock('../models/db', () => jest.fn());

const voiceRouter = require('../routes/twilio-voice-webhook');
const { preconnectScreenDecision, exchangeTriggerHit, screenCandidate, buildPreconnectChallengeTwiML, preconnectOpening, knownCallerPhoneExists } = voiceRouter._test;
const TWILIO_NUMBERS = require('../config/twilio-numbers');
const db = require('../models/db');
const missedCallBell = require('../services/missed-call-bell');
const logger = require('../services/logger');

function makeDbLike(rows) {
  const calls = { whereRaw: [] };
  const builder = {
    select: jest.fn(() => builder),
    whereNull: jest.fn(() => builder),
    whereRaw: jest.fn((sql, bindings) => {
      calls.whereRaw.push({ sql, bindings });
      return builder;
    }),
    limit: jest.fn(() => Promise.resolve(rows)),
  };
  const dbLike = jest.fn(() => builder);
  dbLike._calls = calls;
  return dbLike;
}

describe('preconnectScreenDecision', () => {
  const B = 'TN-Validation-Passed-B';

  test('gates an unknown B-attestation caller when the gate is on', () => {
    expect(preconnectScreenDecision({ knownCaller: false, stirVerstat: B, gateOn: true })).toBe('gate');
  });

  test('shadow-stamps (never challenges) when the gate is off', () => {
    expect(preconnectScreenDecision({ knownCaller: false, stirVerstat: B, gateOn: false })).toBe('would_gate');
  });

  test('NEVER gates a known caller, even on attestation B — including a number shared by 2+ customer records (knownCaller true even when not auto-linkable)', () => {
    expect(preconnectScreenDecision({ knownCaller: true, stirVerstat: B, gateOn: true })).toBe('none');
  });

  test('attestation A, C, and missing all bypass — absence is not suspicion', () => {
    for (const stir of ['TN-Validation-Passed-A', 'TN-Validation-Passed-C', null, undefined, '']) {
      expect(preconnectScreenDecision({ knownCaller: false, stirVerstat: stir, gateOn: true })).toBe('none');
    }
  });

  test('a bare "B" without the attestation prefix does not match', () => {
    expect(preconnectScreenDecision({ knownCaller: false, stirVerstat: 'B', gateOn: true })).toBe('none');
  });

  test('the exchange trigger gates an unknown caller on attestation A, or shadow-stamps with the screen gate off', () => {
    const A = 'TN-Validation-Passed-A';
    expect(preconnectScreenDecision({ knownCaller: false, stirVerstat: A, gateOn: true, exchangeHit: true })).toBe('gate');
    expect(preconnectScreenDecision({ knownCaller: false, stirVerstat: null, gateOn: false, exchangeHit: true })).toBe('would_gate');
  });

  test('the exchange trigger never gates a known caller', () => {
    expect(preconnectScreenDecision({ knownCaller: true, stirVerstat: 'TN-Validation-Passed-A', gateOn: true, exchangeHit: true })).toBe('none');
  });
});

describe('exchangeTriggerHit (ring-path read)', () => {
  afterEach(() => jest.restoreAllMocks());

  test('returns the exchange classifier verdict', async () => {
    jest.spyOn(missedCallBell, 'exchangeHangupScreenHit').mockResolvedValue(true);
    await expect(exchangeTriggerHit('+19412360101')).resolves.toBe(true);
    expect(missedCallBell.exchangeHangupScreenHit).toHaveBeenCalledWith('+19412360101');
  });

  test('fails open: a query error or timeout never challenges the caller', async () => {
    jest.spyOn(missedCallBell, 'exchangeHangupScreenHit').mockRejectedValue(new Error('canceling statement due to statement timeout'));
    await expect(exchangeTriggerHit('+19412360101')).resolves.toBe(false);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('failing open'));
  });
});

describe('screenCandidate (who the screen may challenge)', () => {
  const A = 'TN-Validation-Passed-A';
  const B = 'TN-Validation-Passed-B';
  const slotRows = (rows) => db.mockImplementation(makeDbLike(rows));
  afterEach(() => { jest.restoreAllMocks(); db.mockReset(); });

  test('attestation A with no exchange hit: no candidate, and no customer-slot query', async () => {
    jest.spyOn(missedCallBell, 'exchangeHangupScreenHit').mockResolvedValue(false);
    await expect(screenCandidate('+19412360303', A)).resolves.toEqual({ knownCaller: false, exchangeTrigger: false });
    expect(db).not.toHaveBeenCalled();
  });

  test('an exchange hit on an unknown number is a candidate', async () => {
    jest.spyOn(missedCallBell, 'exchangeHangupScreenHit').mockResolvedValue(true);
    slotRows([]);
    await expect(screenCandidate('+19412360303', A)).resolves.toEqual({ knownCaller: false, exchangeTrigger: true });
  });

  test('an exchange hit on a spouse or tenant slot phone is a known caller, never challenged', async () => {
    jest.spyOn(missedCallBell, 'exchangeHangupScreenHit').mockResolvedValue(true);
    slotRows([{ id: 'c1' }]);
    await expect(screenCandidate('+19412360303', A)).resolves.toEqual({ knownCaller: true, exchangeTrigger: false });
  });

  test('attestation B skips the exchange read; a slot-check failure fails open', async () => {
    const spy = jest.spyOn(missedCallBell, 'exchangeHangupScreenHit');
    db.mockImplementation(() => { throw new Error('db down'); });
    await expect(screenCandidate('+19412360303', B)).resolves.toEqual({ knownCaller: true, exchangeTrigger: false });
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('buildPreconnectChallengeTwiML', () => {
  const xml = buildPreconnectChallengeTwiML();

  test('challenges with two DTMF Gathers posting back into /voice as screened', () => {
    const gathers = xml.match(/<Gather[^>]*>/g) || [];
    expect(gathers).toHaveLength(2);
    for (const g of gathers) {
      expect(g).toContain('action="/api/webhooks/twilio/voice?screened=1"');
      expect(g).toContain('numDigits="1"');
    }
  });

  test('no-input path redirects back into /voice as a screen failure — never a Hangup, never a staff Dial', () => {
    expect(xml).toContain('<Redirect method="POST">/api/webhooks/twilio/voice?screenfail=1</Redirect>');
    expect(xml).not.toContain('<Hangup');
    expect(xml).not.toContain('<Dial');
  });

  test('with no number config the opening is plain "Waves"', () => {
    expect(xml).toContain('Thanks for calling Waves. We screen out spam calls. To reach our office, press 1.');
  });
});

describe('buildPreconnectChallengeTwiML words (owner 2026-11-20)', () => {
  const END = 'We screen out spam calls. To reach our office, press 1.';
  const SECOND = 'This is a recording. To reach our office, press any key, or stay on the line to leave a message.';
  const twimlFor = (number) => buildPreconnectChallengeTwiML(TWILIO_NUMBERS.findByNumber(number));
  const says = (xml) => (xml.match(/<Say[^>]*>([^<]*)<\/Say>/g) || []).map((t) => t.replace(/<[^>]+>/g, ''));

  test('Sarasota GBP line says Waves in Sarasota, then the reason and the key', () => {
    expect(says(twimlFor('+19414910407'))[0])
      .toBe('Thanks for calling Waves in Sarasota. We screen out spam calls. To reach our office, press 1.');
  });

  test('every GBP line says Waves plus its own town', () => {
    const towns = { bradenton: 'Bradenton', parrish: 'Parrish', sarasota: 'Sarasota', venice: 'Venice' };
    for (const [id, town] of Object.entries(towns)) {
      expect(says(twimlFor(TWILIO_NUMBERS.gbpTracking[id].number))[0])
        .toBe(`Thanks for calling Waves in ${town}. ${END}`);
    }
  });

  test('HQ line (a location line that is also a website line) says Waves in Lakewood Ranch', () => {
    expect(says(twimlFor('+19413187612'))[0])
      .toBe(`Thanks for calling Waves in Lakewood Ranch. ${END}`);
  });

  test('every location line has a spoken town and says Waves in it', () => {
    for (const loc of Object.values(TWILIO_NUMBERS.locations)) {
      expect(loc.spokenTown).toBeTruthy();
      expect(says(twimlFor(loc.number))[0]).toBe(`Thanks for calling Waves in ${loc.spokenTown}. ${END}`);
    }
  });

  test('a spoke-site line says the site brand and never Waves', () => {
    const xml = twimlFor('+19412972671');
    expect(says(xml)[0]).toBe(`Thanks for calling Sarasota Pest Control. ${END}`);
    expect(xml).not.toContain('Waves');
  });

  test('every non-hub website line has a spoken name; its TwiML never says "Waves in"', () => {
    const entries = [...TWILIO_NUMBERS.domainTracking, ...TWILIO_NUMBERS.lawnDomainTracking]
      .filter((e) => e.domain !== 'wavespestcontrol.com');
    expect(entries.length).toBe(16);
    for (const e of entries) {
      expect(typeof e.spokenName).toBe('string');
      expect(e.spokenName.trim()).not.toBe('');
      // A spoke line on the location list would shadow the spoken name.
      const resolved = TWILIO_NUMBERS.findByNumber(e.number);
      expect(resolved.spokenName).toBe(e.spokenName);
      const xml = buildPreconnectChallengeTwiML(resolved);
      expect(says(xml)[0]).toBe(`Thanks for calling ${e.spokenName}. ${END}`);
      expect(xml).not.toContain('Waves in');
      if (e.domain !== 'waveslawncare.com') expect(xml).not.toContain('Waves');
    }
  });

  test('hub-domain entries carry no spoken fields', () => {
    for (const e of TWILIO_NUMBERS.domainTracking.filter((d) => d.domain === 'wavespestcontrol.com')) {
      expect(e.spokenName).toBeUndefined();
      expect(e.spokenTown).toBeUndefined();
    }
  });

  test.each([
    ['main line', '+19412975749'],
    ['North Port page line', '+19412402066'],
    ['web-only line', '+19412542617'],
    ['toll-free line', '+18559260203'],
  ])('%s says plain Waves, never "Waves in"', (_name, number) => {
    const xml = twimlFor(number);
    expect(says(xml)[0]).toBe(`Thanks for calling Waves. ${END}`);
    expect(xml).not.toContain('Waves in');
  });

  test('a null or undefined config says plain Waves', () => {
    for (const cfg of [null, undefined]) {
      const xml = buildPreconnectChallengeTwiML(cfg);
      expect(says(xml)[0]).toBe(`Thanks for calling Waves. ${END}`);
      expect(xml).not.toContain('Waves in');
      expect(preconnectOpening(cfg)).toBe('Thanks for calling Waves.');
    }
  });

  test('a spoken name wins over a spoken town', () => {
    expect(preconnectOpening({ spokenName: 'Venice Pest Control', spokenTown: 'Venice' }))
      .toBe('Thanks for calling Venice Pest Control.');
  });

  test('the second Gather says the second-try words exactly', () => {
    for (const number of ['+19414910407', '+19412972671', '+19412975749']) {
      const spoken = says(twimlFor(number));
      expect(spoken).toHaveLength(2);
      expect(spoken[1]).toBe(SECOND);
    }
  });
});

describe('knownCallerPhoneExists (screen-bypass identity set)', () => {
  test('matches across the customer phone AND all three service-contact slot phones', async () => {
    const dbLike = makeDbLike([{ id: 'c1' }]);
    await expect(knownCallerPhoneExists(dbLike, '+19415551234')).resolves.toBe(true);
    const { sql } = dbLike._calls.whereRaw[0];
    for (const col of ['phone', 'service_contact_phone', 'service_contact2_phone', 'service_contact3_phone', 'secondary_phone']) {
      expect(sql).toContain(col);
    }
  });

  test('no matching record → false (caller stays gate-eligible)', async () => {
    await expect(knownCallerPhoneExists(makeDbLike([]), '+19415551234')).resolves.toBe(false);
  });

  test('unparseable caller number → false without querying', async () => {
    const dbLike = makeDbLike([{ id: 'c1' }]);
    await expect(knownCallerPhoneExists(dbLike, '')).resolves.toBe(false);
    expect(dbLike).not.toHaveBeenCalled();
  });
});
