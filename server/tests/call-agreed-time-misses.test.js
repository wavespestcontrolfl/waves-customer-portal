// Three audited bookings that never booked although a time was agreed (prompt
// v22, owner direction 2026-10-06). The judgment is the model's, so what is
// asserted here is the contract it is given (the V2 prompt, the call-time line,
// the version stamp) and that routing books the extraction that contract
// produces for each shape while the guards that must stay closed still hold.
// All names, numbers and addresses are synthetic.
const { buildExtractionPrompt, PROMPT_VERSION, PROMPT_HASH } = require('../services/prompts/call-extraction-v1');
const { canAutoRoute } = require('../services/call-triage-flags');
const { callTimeETString } = require('../services/call-recording-processor')._test;

const AV_CLEAN = { status: 'validated_accept', inServiceArea: true, county: 'Manatee County' };

function extraction(scheduling, extra = {}) {
  return {
    triage_flags: [],
    confidence: { overall: 0.9 },
    scheduling,
    consent: {},
    ...extra,
  };
}

const PROMPT = buildExtractionPrompt('Agent: hi', '+19415550100', '2026-10-05', { callTimeET: '1:12 PM' });

describe('version stamp', () => {
  test('prompt v22 is a new cohort', () => {
    expect(PROMPT_VERSION).toBe('v28');
    expect(PROMPT_HASH).toMatch(/^v28-[a-f0-9]{12}$/);
  });
});

describe('call time line', () => {
  test('rendered when the call start is known, absent otherwise, and outside the version hash', () => {
    expect(PROMPT).toContain('Call date in Eastern Time: 2026-10-05\nCall time in Eastern Time (when the call started): 1:12 PM');
    const without = buildExtractionPrompt('Agent: hi', '+19415550100', '2026-10-05');
    expect(without).not.toContain('Call time in Eastern Time');
    expect(without).toContain('Call date in Eastern Time: 2026-10-05\n');
  });

  test('callTimeETString reads the ET wall clock and never guesses', () => {
    // 17:12Z is 1:12 PM EDT.
    expect(callTimeETString('2026-10-05T17:12:00Z')).toBe('1:12 PM');
    expect(callTimeETString(new Date('2026-12-05T17:12:00Z'))).toBe('12:12 PM');
    expect(callTimeETString(null)).toBeNull();
    expect(callTimeETString(undefined)).toBeNull();
    expect(callTimeETString('not a date')).toBeNull();
  });
});

describe('case: bare time with no day, existing customer (call 0abc5879 shape)', () => {
  test('the prompt resolves a day-less accepted time to today and denies that a known customer means coordination', () => {
    expect(PROMPT).toContain('BARE TIME WITH NO DAY');
    expect(PROMPT).toContain('the day is TODAY (2026-10-05)');
    expect(PROMPT).toContain('still ahead of the call time given at the top');
    expect(PROMPT).toContain('Being an existing customer does NOT turn a call into coordination');
    expect(PROMPT).toContain('"are we still on for Tuesday"');
    // The existing-appointment rule itself is untouched.
    expect(PROMPT).toContain('EXISTING APPOINTMENT: a caller who is re-confirming');
  });

  test('a passed hour or a named day is not guessed', () => {
    expect(PROMPT).toContain('When the hour has already passed on the call date, or a different day was named, do not guess a day');
  });

  test('confirmed today at 3 PM, day never said, books for a known customer on file', () => {
    const r = canAutoRoute(extraction({
      status: 'confirmed',
      confirmed_start_at: '2026-10-05T15:00:00-04:00',
      agreed_slot_words: { day: null, hour: 'three', period: null },
      caller_accepted_slot: true,
    }), { addressValidation: AV_CLEAN });
    expect(r.allowed).toBe(true);
  });
});

describe('case: bare hour inside the caller\'s own window (call 4de755e1 shape)', () => {
  test('a missing AM/PM is never the reason to hold, and the caller\'s window gives the period', () => {
    expect(PROMPT).toContain('A MISSING AM/PM IS NEVER A REASON TO HOLD A SETTLED HOUR');
    expect(PROMPT).toContain('"between 1:30 and 3:30" is the afternoon');
    expect(PROMPT).toContain('Never write "no AM/PM was stated" as the reason a status is not confirmed');
  });

  test('confirmed today at 2 PM books; the old requested/null extraction is still held', () => {
    expect(canAutoRoute(extraction({
      status: 'confirmed',
      confirmed_start_at: '2026-10-05T14:00:00-04:00',
      agreed_slot_words: { day: null, hour: '2', period: null },
      caller_accepted_slot: true,
    }), { addressValidation: AV_CLEAN }).allowed).toBe(true);
    expect(canAutoRoute(extraction({ status: 'requested', confirmed_start_at: null }), { addressValidation: AV_CLEAN }))
      .toMatchObject({ allowed: false, reason: 'not_confirmed' });
  });
});

describe('case: staff hedges, caller accepts (call 732b3a5a shape)', () => {
  test('the prompt lists the staff hedges that do not unconfirm and overrides the approximation exclusion for staff words only', () => {
    expect(PROMPT).toContain('STAFF HEDGES DO NOT UNCONFIRM A NEW BOOKING');
    for (const hedge of ['"I\'m thinking"', '"probably"', '"I could probably make it"', '"around four"']) {
      expect(PROMPT).toContain(hedge);
    }
    expect(PROMPT).toContain('overrides the approximation exclusion above for a hedge in STAFF\'s words only');
  });

  test('the prompt keeps caller hedges, open conditions, alternatives, no answer and off-hour times closed', () => {
    for (const closed of ['the CALLER hedges, declines or defers', '"I\'ll check the schedule and call you back"', 'staff offered alternatives and none was chosen', 'the caller never answered', 'the time is not on the hour']) {
      expect(PROMPT).toContain(closed);
    }
    // A reschedule keeps its own definite-commitment rule.
    expect(PROMPT).toContain('it only gates a RESCHEDULE, which keeps its own rule above');
  });

  test('a family member confirmed tomorrow at 4 PM books on the confirmed status alone; an off-hour time still does not', () => {
    const family = { caller: { relationship_to_property: 'family_member' }, triage_flags: ['caller_not_authorized'] };
    const ok = canAutoRoute(extraction({
      status: 'confirmed',
      confirmed_start_at: '2026-10-06T16:00:00-04:00',
      agreed_slot_words: { day: 'tomorrow', hour: 'four', period: 'afternoon' },
      caller_accepted_slot: true,
      definite_commitment: false,
    }, family), { addressValidation: AV_CLEAN });
    expect(ok.allowed).toBe(true);
    const offHour = canAutoRoute(extraction({
      status: 'confirmed',
      confirmed_start_at: '2026-10-06T16:30:00-04:00',
    }, family), { addressValidation: AV_CLEAN });
    expect(offHour).toMatchObject({ allowed: false, reason: 'off_hour_start' });
  });

  test('an offered-only extraction (the pre-fix result) is still held', () => {
    expect(canAutoRoute(extraction({ status: 'offered', confirmed_start_at: null }), { addressValidation: AV_CLEAN }))
      .toMatchObject({ allowed: false, reason: 'not_confirmed' });
  });
});

describe('guards outside this change stay in force', () => {
  test('a confirmed booking with an unverified address is still held', () => {
    const r = canAutoRoute(extraction({
      status: 'confirmed',
      confirmed_start_at: '2026-10-05T15:00:00-04:00',
    }), { addressValidation: { status: 'unverified', inServiceArea: null } });
    expect(r.allowed).toBe(false);
  });

  test('a confirmed commercial booking still holds on commercial_requires_quote', () => {
    const r = canAutoRoute(extraction({
      status: 'confirmed',
      confirmed_start_at: '2026-10-05T15:00:00-04:00',
    }, { triage_flags: ['commercial_requires_quote'] }), { addressValidation: AV_CLEAN });
    expect(r).toMatchObject({ allowed: false, reason: 'triage_flags' });
  });
});
