/**
 * Missed-call text-back (services/missed-call-text-back.js) — pure
 * eligibility, the bounded-catch-up math (any hour of the day — owner
 * ruling 2026-09-28 dropped the after-hours defer to 8 AM), the from-number
 * and callback-clause derivations, and the seeded copy itself (no STOP
 * line, no "Pest Control", correct callback_clause behavior).
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
  _private: { textBackCoreEligible, emptyVoicemailOn, EMPTY_VOICEMAIL_LANDING_MS, callEndedAt, sendSlotDeadline, tooOldToText, callbackClause, fromNumberForDialed, normalizePhoneE164 },
} = require('../services/missed-call-text-back');
const { isEnabled } = require('../config/feature-gates');
const {
  missedCallShapeEligible, missedCallEligible, isEmptyVoicemailRecording,
} = require('../services/missed-call-bell');

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

describe('one text per number EVER (missed_call_text_claims row)', () => {
  test('every claim outcome fits the claim table\'s outcome column (varchar 30)', () => {
    for (const outcome of Object.values(CLAIM)) expect(outcome.length).toBeLessThanOrEqual(30);
  });
});

describe('textBackCoreEligible', () => {
  test('an unknown caller who waited 15s+ with no voicemail is eligible', () => {
    expect(textBackCoreEligible(call(), IN_WINDOW)).toBe(true);
  });

  test('a KNOWN customer (customer_id set) is never eligible — that is the bell\'s lane', () => {
    expect(textBackCoreEligible(call({ customer_id: 'cust-1' }), IN_WINDOW)).toBe(false);
  });

  test('under the 15s floor is not eligible; 15 to 24 s is (owner ruling 2026-10-05)', () => {
    expect(textBackCoreEligible(call({ duration_seconds: 10 }), IN_WINDOW)).toBe(false);
    expect(textBackCoreEligible(call({ duration_seconds: 14 }), IN_WINDOW)).toBe(false);
    expect(textBackCoreEligible(call({ duration_seconds: 15 }), IN_WINDOW)).toBe(true);
    expect(textBackCoreEligible(call({ duration_seconds: 22 }), IN_WINDOW)).toBe(true);
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

  test('an after-hours call is textable right after its own grace clears — no wait for 8 AM (owner ruling 2026-09-28)', () => {
    // 22:00 ET call — after the old 8pm-8am moratorium this lane no longer
    // checks at all.
    const row = endedAt('2026-09-09T02:00:00Z');
    expect(tooOldToText(row, Date.parse('2026-09-09T02:10:00Z'))).toBe(false); // 22:10 ET, same night
    expect(tooOldToText(row, Date.parse('2026-09-09T02:34:00Z'))).toBe(false); // 22:34 ET, still in slot
    expect(tooOldToText(row, Date.parse('2026-09-09T02:36:00Z'))).toBe(true); // 22:36 ET, slot closed
    // Never held open for the next morning either — by 08:05 ET the slot
    // that closed the night before is long gone.
    expect(tooOldToText(row, Date.parse('2026-09-09T12:05:00Z'))).toBe(true); // 08:05 ET next day
  });

  test('a 2 AM call is textable right after its own grace — no wait for daylight', () => {
    const row = endedAt('2026-09-09T06:00:00Z'); // 02:00 ET
    expect(tooOldToText(row, Date.parse('2026-09-09T06:10:00Z'))).toBe(false); // 02:10 ET
    expect(tooOldToText(row, Date.parse('2026-09-09T06:34:00Z'))).toBe(false); // 02:34 ET
    expect(tooOldToText(row, Date.parse('2026-09-09T06:36:00Z'))).toBe(true); // 02:36 ET
  });

  test('a call that clears its voicemail grace after 8 PM ET is textable right then, not moved to the next 8 AM', () => {
    const row = endedAt('2026-09-08T23:57:00Z'); // 19:57 ET, ready at 20:02 ET
    expect(tooOldToText(row, Date.parse('2026-09-09T00:05:00Z'))).toBe(false); // 20:05 ET, same night
    expect(tooOldToText(row, Date.parse('2026-09-09T00:33:00Z'))).toBe(true); // 20:33 ET, slot closed
  });

  test('a call whose slot straddles the 8 PM cutoff runs its normal 30 minutes uninterrupted', () => {
    const row = endedAt('2026-09-08T23:40:00Z'); // 19:40 ET, ready at 19:45, slot ends 20:15 ET
    expect(tooOldToText(row, Date.parse('2026-09-08T23:50:00Z'))).toBe(false); // 19:50 ET
    expect(tooOldToText(row, Date.parse('2026-09-09T00:10:00Z'))).toBe(false); // 20:10 ET — still in slot, past 8 PM
    expect(tooOldToText(row, Date.parse('2026-09-09T00:20:00Z'))).toBe(true); // 20:20 ET, slot closed
  });

  test('no first-time text ever goes out past the overall 16h belt', () => {
    expect(MAX_CALL_AGE_MS).toBe(16 * 60 * MIN);
    const row = endedAt('2026-09-09T02:00:00Z');
    expect(tooOldToText(row, Date.parse('2026-09-09T02:00:00Z') + 17 * 60 * MIN)).toBe(true);
  });

  test('a late or retried status callback that rewrites updated_at never reopens the slot', () => {
    // 11:00 ET call (40 s), its row touched again three hours later.
    const row = call({ created_at: new Date(IN_WINDOW), updated_at: new Date(IN_WINDOW + 3 * 60 * MIN), duration_seconds: 40 });
    expect(callEndedAt(row)).toBe(IN_WINDOW + 40 * 1000);
    expect(tooOldToText(row, IN_WINDOW + 3 * 60 * MIN + 6 * MIN)).toBe(true);
  });

  test('a row created at its terminal status is capped by updated_at, not pushed past it by the duration', () => {
    const row = call({ created_at: new Date(IN_WINDOW), updated_at: new Date(IN_WINDOW), duration_seconds: 90 });
    expect(callEndedAt(row)).toBe(IN_WINDOW);
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

  test('the callback number is a required placeholder: template edits and render both refuse a body without it', () => {
    const { REQUIRED_TEMPLATE_PLACEHOLDERS } = require('../routes/admin-sms-templates');
    expect(REQUIRED_TEMPLATE_PLACEHOLDERS[MESSAGE_TYPE]).toEqual(['callback_clause']);
    expect(TEMPLATE.body).toContain('{callback_clause}');
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

// A recording the processor finished with and found speech-less
// (call-recording-processor.js transcriptRejectionUpdate: status 'rejected',
// answered_by/call_outcome 'voicemail').
const REJECTED_SENTINEL = '[Recording had no usable speech; an implausible transcription was rejected.]';
function emptyVoicemailCall(extra = {}) {
  return call({
    answered_by: 'voicemail',
    call_outcome: 'voicemail',
    recording_sid: 'RE123',
    recording_url: 'https://example.invalid/r',
    transcription_status: 'rejected',
    transcription: REJECTED_SENTINEL,
    ...extra,
  });
}

describe('empty voicemail (GATE_MISSED_CALL_TEXT_BACK_EMPTY_VOICEMAIL)', () => {
  const OPTS = { emptyVoicemail: true };

  test('the widening is its own gate, read through isEnabled', () => {
    isEnabled.mockImplementation((gate) => gate === 'missedCallTextBackEmptyVoicemail');
    expect(emptyVoicemailOn()).toBe(true);
    isEnabled.mockImplementation((gate) => gate !== 'missedCallTextBackEmptyVoicemail');
    expect(emptyVoicemailOn()).toBe(false);
    isEnabled.mockImplementation(() => true);
  });

  test('gate off (no option): a rejected recording is still the voicemail lane\'s — unchanged', () => {
    expect(textBackCoreEligible(emptyVoicemailCall())).toBe(false);
    expect(textBackCoreEligible(emptyVoicemailCall(), { emptyVoicemail: false })).toBe(false);
    expect(textBackCoreEligible(call({ recording_url: 'https://example.invalid/r' }))).toBe(false);
  });

  test('gate on: a 15s+ unknown caller with a rejected recording is eligible', () => {
    expect(textBackCoreEligible(emptyVoicemailCall(), OPTS)).toBe(true);
    expect(textBackCoreEligible(emptyVoicemailCall({ duration_seconds: 15 }), OPTS)).toBe(true);
  });

  test('gate on: a completed transcript of only the dead-air markers is eligible', () => {
    for (const transcription of ['[VOICEMAIL]', '[NO SPEECH]', '[voicemail] [no speech].', REJECTED_SENTINEL]) {
      expect(textBackCoreEligible(emptyVoicemailCall({ transcription_status: 'completed', transcription }), OPTS)).toBe(true);
    }
  });

  test('gate on: a recording still pending transcription is NOT eligible', () => {
    for (const transcription_status of ['pending', 'processing', null, undefined]) {
      expect(textBackCoreEligible(emptyVoicemailCall({ transcription_status, transcription: null }), OPTS)).toBe(false);
    }
    expect(textBackCoreEligible(emptyVoicemailCall({ transcription_status: 'completed', transcription: null }), OPTS)).toBe(false);
  });

  test('gate on: a recording with real words, or a failed transcription, is NOT eligible', () => {
    expect(textBackCoreEligible(emptyVoicemailCall({ transcription_status: 'completed', transcription: 'Hi, I need pest control, call me back.' }), OPTS)).toBe(false);
    expect(textBackCoreEligible(emptyVoicemailCall({ transcription_status: 'completed', transcription: '[VOICEMAIL] call me about ants' }), OPTS)).toBe(false);
    expect(textBackCoreEligible(emptyVoicemailCall({ transcription_status: 'failed', transcription: null }), OPTS)).toBe(false);
    expect(textBackCoreEligible(emptyVoicemailCall({ transcription_status: 'rejected', transcription: 'real words survived' }), OPTS)).toBe(false);
  });

  test('gate on: every other rule still applies', () => {
    expect(textBackCoreEligible(emptyVoicemailCall({ duration_seconds: 14 }), OPTS)).toBe(false); // 15s floor
    expect(textBackCoreEligible(emptyVoicemailCall({ customer_id: 'cust-1' }), OPTS)).toBe(false); // unknown callers only
    expect(textBackCoreEligible(emptyVoicemailCall({ from_phone: 'anonymous' }), OPTS)).toBe(false);
    expect(textBackCoreEligible(emptyVoicemailCall({ voicemail_callback_alerted_at: new Date(IN_WINDOW) }), OPTS)).toBe(false);
    expect(textBackCoreEligible(emptyVoicemailCall({ call_outcome: 'ai_handled' }), OPTS)).toBe(false);
    expect(textBackCoreEligible(emptyVoicemailCall({ call_outcome: 'ai_transferred' }), OPTS)).toBe(false);
    expect(textBackCoreEligible(emptyVoicemailCall({ answered_by: 'human' }), OPTS)).toBe(false);
  });

  test('gate on does not change a call with no recording at all', () => {
    expect(textBackCoreEligible(call(), OPTS)).toBe(true);
    expect(textBackCoreEligible(call({ duration_seconds: 10 }), OPTS)).toBe(false);
  });

  const seen = (ms, extra = {}) => emptyVoicemailCall({ updated_at: new Date(IN_WINDOW + 40 * 1000), metadata: { missed_call_text_empty_voicemail_seen_at: new Date(ms).toISOString() }, ...extra });

  test('send slot: opens when the lane first saw the finished verdict, not at the 5-minute grace', () => {
    const MIN = 60 * 1000;
    // Call ended 11:00 ET (created + 40s duration); first seen empty at 11:12.
    const sawAt = IN_WINDOW + 12 * MIN;
    const row = seen(sawAt);
    expect(sendSlotDeadline(row)).toBe(sawAt + SEND_SLOT_MS);
    // Textable 25 minutes after the sighting (a no-recording call's slot would be long closed)...
    expect(tooOldToText(row, sawAt + 25 * MIN)).toBe(false);
    // ...and not after the slot closes.
    expect(tooOldToText(row, sawAt + 31 * MIN)).toBe(true);
  });

  test('send slot: a later updated_at (late status callback) never reopens the slot', () => {
    const MIN = 60 * 1000;
    const sawAt = IN_WINDOW + 10 * MIN;
    const quiet = seen(sawAt, { updated_at: new Date(IN_WINDOW + 10 * MIN) });
    const touched = seen(sawAt, { updated_at: new Date(IN_WINDOW + 50 * MIN) });
    expect(sendSlotDeadline(touched)).toBe(sendSlotDeadline(quiet));
    expect(tooOldToText(touched, IN_WINDOW + 45 * MIN)).toBe(true);
  });

  test('send slot: seen inside the grace keeps the normal slot; no stamp yet gets the plain slot', () => {
    expect(sendSlotDeadline(seen(IN_WINDOW + 60 * 1000))).toBe(IN_WINDOW + 40 * 1000 + VOICEMAIL_GRACE_MS + SEND_SLOT_MS);
    expect(sendSlotDeadline(emptyVoicemailCall({ updated_at: new Date(IN_WINDOW + 20 * 60 * 1000) }))).toBe(IN_WINDOW + 40 * 1000 + VOICEMAIL_GRACE_MS + SEND_SLOT_MS);
  });

  test('send slot: a very late sighting cannot slide the slot out by hours', () => {
    expect(sendSlotDeadline(seen(IN_WINDOW + 5 * 60 * 60 * 1000))).toBe(IN_WINDOW + 40 * 1000 + VOICEMAIL_GRACE_MS + EMPTY_VOICEMAIL_LANDING_MS + SEND_SLOT_MS);
  });

  test('send slot: a call with no recording is unchanged by the empty-voicemail rule', () => {
    const MIN = 60 * 1000;
    const row = call({ updated_at: new Date(IN_WINDOW + 12 * MIN) });
    expect(sendSlotDeadline(row)).toBe(callEndedAt(row) + VOICEMAIL_GRACE_MS + SEND_SLOT_MS);
  });
});

describe('missed-call bell lane is unchanged by the empty-voicemail widening', () => {
  const BELL_OPTS = { unknownCallers: true };

  test('missedCallShapeEligible defaults: any recording is still the voicemail lane\'s', () => {
    expect(missedCallShapeEligible(emptyVoicemailCall(), BELL_OPTS)).toBe(false);
    expect(missedCallShapeEligible(emptyVoicemailCall(), { ...BELL_OPTS, emptyVoicemail: false })).toBe(false);
    expect(missedCallShapeEligible(call({ recording_sid: 'RE1' }), BELL_OPTS)).toBe(false);
    expect(missedCallShapeEligible(call(), BELL_OPTS)).toBe(true);
  });

  test('missedCallEligible (what ringMissedCallIfUnanswered calls) never rings an empty-voicemail call', () => {
    expect(missedCallEligible(emptyVoicemailCall(), IN_WINDOW, BELL_OPTS)).toBe(false);
    // A known customer with an empty recording: still the voicemail lane's.
    expect(missedCallEligible(emptyVoicemailCall({ customer_id: 'cust-1' }), IN_WINDOW)).toBe(false);
  });

  test('isEmptyVoicemailRecording: needs a recording and a finished no-speech verdict', () => {
    expect(isEmptyVoicemailRecording(emptyVoicemailCall())).toBe(true);
    expect(isEmptyVoicemailRecording(call({ transcription_status: 'rejected', transcription: REJECTED_SENTINEL }))).toBe(false); // no recording
    expect(isEmptyVoicemailRecording(emptyVoicemailCall({ transcription_status: 'pending', transcription: null }))).toBe(false);
    expect(isEmptyVoicemailRecording(null)).toBe(false);
  });
});
