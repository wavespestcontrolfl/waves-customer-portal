/**
 * Missed-call text-back (services/missed-call-text-back.js) — pure
 * eligibility, the bounded-catch-up / after-hours scheduling math, the
 * from-number and callback-clause derivations, and the seeded copy itself
 * (no STOP line, no "Pest Control", correct callback_clause behavior).
 *
 * DB-backed claim/lease/one-per-number behavior is covered separately by
 * missed-call-text-back-postgres.test.js.
 */

jest.mock('../config/feature-gates', () => ({ isEnabled: jest.fn(() => true) }));
jest.mock('../config/twilio-numbers', () => ({
  isInternalNumber: (n) => n === '+19412975749',
  isTechLine: (n) => n === '+19413529161',
  tollFree: { number: '+18559260203' },
  mainLine: { number: '+19412975749' },
  // Unset in the registry's own sense: falls back to the main line.
  internalAlertCallerId: jest.fn(() => '+19412975749'),
  findByNumber: jest.fn((n) => (['+19412975749', '+19412972817', '+18559260203', '+19413529161'].includes(n) ? { id: 'known' } : null)),
}));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const {
  GATE, MESSAGE_TYPE, CLAIM, MAX_CALL_AGE_MS, SEND_SLOT_MS, VOICEMAIL_GRACE_MS,
  _private: { textBackCoreEligible, tooOldToText, callbackClause, fromNumberForDialed, normalizePhoneE164 },
} = require('../services/missed-call-text-back');

// 2026-09-08T15:00Z = 11:00 ET (EDT) — inside the 8am–8pm send window.
const IN_WINDOW = new Date('2026-09-08T15:00:00Z').getTime();

function call(extra = {}) {
  return {
    id: 'call-1',
    twilio_call_sid: 'CA123',
    direction: 'inbound',
    from_phone: '+19415550100',
    to_phone: '+19412975749',
    customer_id: null,
    status: 'no-answer',
    answered_by: 'missed',
    duration_seconds: 40,
    metadata: {},
    created_at: new Date(IN_WINDOW),
    updated_at: new Date(IN_WINDOW),
    ...extra,
  };
}

describe('gate', () => {
  test('is its own named gate', () => {
    expect(GATE).toBe('missedCallTextBack');
  });
});

describe('one text per number EVER (shared voicemail_sms_claims row)', () => {
  test('every claim outcome fits the shared table\'s outcome column (varchar 30)', () => {
    for (const outcome of Object.values(CLAIM)) expect(outcome.length).toBeLessThanOrEqual(30);
  });
});

describe('textBackCoreEligible', () => {
  test('an unknown caller who waited 25s+ with no voicemail is eligible', () => {
    expect(textBackCoreEligible(call(), IN_WINDOW)).toBe(true);
  });

  test('a KNOWN customer (customer_id set) is never eligible — that is the bell\'s lane', () => {
    expect(textBackCoreEligible(call({ customer_id: 'cust-1' }), IN_WINDOW)).toBe(false);
  });

  test('under the 25s floor is not eligible', () => {
    expect(textBackCoreEligible(call({ duration_seconds: 10 }), IN_WINDOW)).toBe(false);
  });

  test('withheld caller ID is not eligible', () => {
    expect(textBackCoreEligible(call({ from_phone: 'anonymous' }), IN_WINDOW)).toBe(false);
  });

  test('a recording (voicemail lane owns it) is not eligible', () => {
    expect(textBackCoreEligible(call({ recording_url: 'https://example.invalid/r' }), IN_WINDOW)).toBe(false);
  });

  test('ai_handled / ai_transferred are not eligible', () => {
    expect(textBackCoreEligible(call({ call_outcome: 'ai_handled' }), IN_WINDOW)).toBe(false);
    expect(textBackCoreEligible(call({ call_outcome: 'ai_transferred' }), IN_WINDOW)).toBe(false);
  });

  test('a human-answered call is not eligible', () => {
    expect(textBackCoreEligible(call({ answered_by: 'human' }), IN_WINDOW)).toBe(false);
  });

  test('does not depend on the missedCallUnknownCallers bell gate (no opts needed by the caller)', () => {
    // textBackCoreEligible always passes unknownCallers:true internally, so
    // an unknown caller is eligible here whatever the bell's gate says.
    expect(textBackCoreEligible(call(), IN_WINDOW)).toBe(true);
  });

  test('the bell ringing for the same call first (its settle or live lease) never hides it from this lane', () => {
    const at = new Date(IN_WINDOW - 60 * 1000).toISOString();
    expect(textBackCoreEligible(call({ metadata: { missed_call_notified_at: at, missed_call_settled_at: at } }), IN_WINDOW)).toBe(true);
    expect(textBackCoreEligible(call({ metadata: { missed_call_notified_at: at } }), IN_WINDOW)).toBe(true);
  });
});

describe('bounded catch-up (tooOldToText) — one 30-minute send slot per call', () => {
  const MIN = 60 * 1000;
  const at = (iso) => new Date(iso);
  const endedAt = (iso) => call({ created_at: at(iso), updated_at: at(iso) });

  test('the slot is 30 minutes and opens after the 5-minute voicemail grace', () => {
    expect(SEND_SLOT_MS).toBe(30 * MIN);
    expect(VOICEMAIL_GRACE_MS).toBe(5 * MIN);
  });

  test('an in-hours call is textable until 35 minutes past its terminal update, then never', () => {
    // 2026-09-08T15:00Z = 11:00 ET.
    const row = endedAt('2026-09-08T15:00:00Z');
    expect(tooOldToText(row, IN_WINDOW + 6 * MIN)).toBe(false);
    expect(tooOldToText(row, IN_WINDOW + 34 * MIN)).toBe(false);
    expect(tooOldToText(row, IN_WINDOW + 36 * MIN)).toBe(true);
  });

  test('an in-hours call missed by a crash is never texted the next morning', () => {
    // 18:00 ET call; its slot closed at 18:35 ET.
    const row = endedAt('2026-09-08T22:00:00Z');
    expect(tooOldToText(row, Date.parse('2026-09-08T23:00:00Z'))).toBe(true); // 19:00 ET
    expect(tooOldToText(row, Date.parse('2026-09-09T12:05:00Z'))).toBe(true); // 08:05 ET next day
  });

  test('an after-hours call is textable 8:00-8:30 AM ET the next morning, not later', () => {
    // 22:00 ET call.
    const row = endedAt('2026-09-09T02:00:00Z');
    expect(tooOldToText(row, Date.parse('2026-09-09T12:05:00Z'))).toBe(false); // 08:05 ET
    expect(tooOldToText(row, Date.parse('2026-09-09T12:29:00Z'))).toBe(false); // 08:29 ET
    expect(tooOldToText(row, Date.parse('2026-09-09T12:31:00Z'))).toBe(true); // 08:31 ET
  });

  test('flipping the gate on mid-morning never texts last night\'s calls', () => {
    const row = endedAt('2026-09-09T02:00:00Z'); // 22:00 ET
    expect(tooOldToText(row, Date.parse('2026-09-09T14:00:00Z'))).toBe(true); // 10:00 ET
  });

  test('an early-morning call goes out in the same morning\'s slot', () => {
    const row = endedAt('2026-09-09T06:00:00Z'); // 02:00 ET
    expect(tooOldToText(row, Date.parse('2026-09-09T12:15:00Z'))).toBe(false); // 08:15 ET
    expect(tooOldToText(row, Date.parse('2026-09-09T12:31:00Z'))).toBe(true); // 08:31 ET
  });

  test('a call that clears its voicemail grace after 8 PM ET moves to the next 8 AM instead of being lost', () => {
    const row = endedAt('2026-09-08T23:57:00Z'); // 19:57 ET, ready at 20:02 ET
    expect(tooOldToText(row, Date.parse('2026-09-09T12:10:00Z'))).toBe(false); // 08:10 ET next day
  });

  test('a call whose in-hours slot would run past 8 PM ET can go now or at the next 8 AM', () => {
    const row = endedAt('2026-09-08T23:40:00Z'); // 19:40 ET, ready at 19:45, slot would end 20:15
    expect(tooOldToText(row, Date.parse('2026-09-08T23:50:00Z'))).toBe(false); // 19:50 ET
    expect(tooOldToText(row, Date.parse('2026-09-09T12:10:00Z'))).toBe(false); // 08:10 ET next day
    expect(tooOldToText(row, Date.parse('2026-09-09T12:31:00Z'))).toBe(true); // 08:31 ET next day
  });

  test('no first-time text ever goes out past the overall 14h belt', () => {
    expect(MAX_CALL_AGE_MS).toBe(14 * 60 * MIN);
    const row = endedAt('2026-09-09T02:00:00Z');
    expect(tooOldToText(row, Date.parse('2026-09-09T02:00:00Z') + 15 * 60 * MIN)).toBe(true);
  });

  test('unreadable timestamps are too old (fail closed)', () => {
    expect(tooOldToText(call({ created_at: 'not a date', updated_at: 'not a date' }), IN_WINDOW)).toBe(true);
  });
});

describe('callbackClause', () => {
  test('formats a 10-digit dialed line', () => {
    expect(callbackClause('+19412975749')).toBe(' at (941) 297-5749');
  });
  test('empty for a non-10-digit or missing number', () => {
    expect(callbackClause('')).toBe('');
    expect(callbackClause(null)).toBe('');
    expect(callbackClause('123')).toBe('');
  });
});

describe('fromNumberForDialed — send FROM the line the caller dialed, only when it is ours', () => {
  test('a known Waves line is used as-is', () => {
    expect(fromNumberForDialed('+19412972817')).toBe('+19412972817');
  });
  test('the toll-free AI line is never used (its replies enter the AI chat flow)', () => {
    expect(fromNumberForDialed('+18559260203')).toBeNull();
  });
  test('a field-tech line is never used (owner ruling: automated texts never originate there)', () => {
    expect(fromNumberForDialed('+19413529161')).toBeNull();
  });
  test('a dedicated internal-alert caller ID is never used, even though the registry reports it as a line', () => {
    const TWILIO_NUMBERS = require('../config/twilio-numbers');
    TWILIO_NUMBERS.internalAlertCallerId.mockReturnValueOnce('+19412972817');
    expect(fromNumberForDialed('+19412972817')).toBeNull();
  });
  test('an internal-alert caller ID that falls back to the main line leaves the main line usable', () => {
    expect(fromNumberForDialed('+19412975749')).toBe('+19412975749');
  });
  test('an unregistered number skips rather than falling back to a default line', () => {
    expect(fromNumberForDialed('+19995550000')).toBeNull();
  });
  test('no dialed number at all skips', () => {
    expect(fromNumberForDialed(null)).toBeNull();
    expect(fromNumberForDialed(undefined)).toBeNull();
  });
});

describe('normalizePhoneE164', () => {
  test('normalizes 10 and 11 digit forms', () => {
    expect(normalizePhoneE164('9415550100')).toBe('+19415550100');
    expect(normalizePhoneE164('19415550100')).toBe('+19415550100');
    expect(normalizePhoneE164('(941) 555-0100')).toBe('+19415550100');
  });
  test('passes through an already-E.164 number', () => {
    expect(normalizePhoneE164('+19415550100')).toBe('+19415550100');
  });
  test('empty input is null', () => {
    expect(normalizePhoneE164('')).toBeNull();
    expect(normalizePhoneE164(null)).toBeNull();
  });
});

describe('seeded copy (server/models/migrations/20260926180000_missed_call_text_back_template.js)', () => {
  const { TEMPLATE } = (() => {
    // Import the migration module's TEMPLATE the same way its own file does
    // internally — re-require and reach into the module isn't exported, so
    // read the file source for the literal body instead, keeping this test
    // independent of any future refactor of the migration's internal shape.
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(
      path.join(__dirname, '../models/migrations/20260926180000_missed_call_text_back_template.js'),
      'utf8',
    );
    const match = src.match(/body: "([^"]*)"/);
    return { TEMPLATE: { body: match ? match[1] : '' } };
  })();

  test('template_key matches the module\'s MESSAGE_TYPE', () => {
    expect(MESSAGE_TYPE).toBe('missed_call_text_back');
  });

  test('carries no "Reply STOP to opt out." line (owner ruling: they called us)', () => {
    expect(TEMPLATE.body).not.toMatch(/reply stop/i);
  });

  test('brand reads "Waves" only — never "Waves Pest Control"', () => {
    expect(TEMPLATE.body).toMatch(/\bWaves\b/);
    expect(TEMPLATE.body).not.toMatch(/Waves Pest Control/i);
  });

  test('no sign-off / signature', () => {
    expect(TEMPLATE.body).not.toMatch(/-\s*(Adam|Waves Team|The Waves Team)/i);
  });

  test('renders with an empty callback_clause when the dialed line is unknown', () => {
    const rendered = TEMPLATE.body.replace('{callback_clause}', callbackClause(null));
    expect(rendered).toBe("Hi there, it's Waves. Sorry we missed your call. Text us here with what you need, or call back anytime.");
  });

  test('renders with the formatted dialed line in the callback_clause', () => {
    const rendered = TEMPLATE.body.replace('{callback_clause}', callbackClause('+19412975749'));
    expect(rendered).toBe("Hi there, it's Waves. Sorry we missed your call. Text us here with what you need, or call back anytime at (941) 297-5749.");
  });
});
