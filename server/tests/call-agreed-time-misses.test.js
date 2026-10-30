// Three audited bookings that never booked although a time was agreed (prompt
// v22, owner direction 2026-10-06). The judgment is the model's, so what is
// asserted here is the contract it is given (the V2 prompt, the call-time line,
// the version stamp) and that routing books the extraction that contract
// produces for each shape while the guards that must stay closed still hold.
// All names, numbers and addresses are synthetic.
const { buildExtractionPrompt, PROMPT_VERSION, PROMPT_HASH } = require('../services/prompts/call-extraction-v1');
const {
  bareTimeNoDayRule, MISSING_AMPM_RULE, STAFF_HEDGE_RULE, CALLER_PROPOSED_TIME_RULE, DAY_TIME_CONFLICT_RULE, DAY_TIME_CONFLICT_AUDIT_RULE,
} = require('../services/prompts/appointment-confirmed-rules');
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
    expect(PROMPT_VERSION).toBe('v33');
    expect(PROMPT_HASH).toMatch(/^v33-[a-f0-9]{12}$/);
  });
});

describe('shared confirmation rules (also graded by the call self-audit)', () => {
  test('the V2 prompt renders each shared rule verbatim, bare-time rule with its own date reference', () => {
    expect(PROMPT).toContain(bareTimeNoDayRule('2026-10-05'));
    for (const rule of [MISSING_AMPM_RULE, STAFF_HEDGE_RULE, CALLER_PROPOSED_TIME_RULE, DAY_TIME_CONFLICT_RULE]) expect(PROMPT).toContain(rule);
    const { system } = require('../services/prompts/call-extraction-v1').buildExtractionPromptParts('Agent: hi', '+19415550100', '2026-10-05', { callTimeET: '1:12 PM' });
    expect(system).toContain(bareTimeNoDayRule('the "Call date in Eastern Time" given in the user message'));
    for (const rule of [MISSING_AMPM_RULE, STAFF_HEDGE_RULE, CALLER_PROPOSED_TIME_RULE, DAY_TIME_CONFLICT_RULE]) expect(system).toContain(rule);
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

// Prompt v31 (2026-10-10 call audit): the CALLER proposed the hour, staff
// accepted softly and closed with "I'll see you then"; the extraction answered
// "ambiguous" and the visit was booked by hand 2.5 hours later.
describe('case: the caller proposes the time, staff accept and close (call 07c4bd83 shape)', () => {
  test('the prompt confirms a caller-proposed hour that staff accepted and closed on', () => {
    expect(PROMPT).toContain('CALLER-PROPOSED TIME THAT STAFF ACCEPTED');
    expect(PROMPT).toContain('STAFF then gave a closing commitment to that visit ("I\'ll see you then", "see you then", "we\'ll see you at one")');
    expect(PROMPT).toContain('that is the caller offering a time, not the caller hedging on an offer');
    expect(PROMPT).toContain('does not leave the slot open once staff ALSO gave the closing commitment');
  });

  test('the prompt keeps it open with no closing commitment, a promised callback, a different time, a range, or an off-hour time', () => {
    expect(PROMPT).toContain('for ONE day the caller chose or accepted for this visit');
    expect(PROMPT).toContain('the only day on the call is one the caller rejected, said was unavailable, or merely mentioned');
    for (const guard of [
      'two or more days were named and the caller picked none of them',
      'staff never gave the closing commitment',
      'staff said they would check, text or call back with a time',
      'staff named a different time afterward',
      'the caller proposed a range or a part of the day with no hour',
      'or the time is not on the hour',
    ]) expect(PROMPT).toContain(guard);
  });

  test('confirmed today at 1 PM books; the old ambiguous extraction is still held', () => {
    expect(canAutoRoute(extraction({
      status: 'confirmed',
      confirmed_start_at: '2026-10-05T13:00:00-04:00',
      agreed_slot_words: { day: 'today', hour: 'one', period: null },
      caller_accepted_slot: true,
    }), { addressValidation: AV_CLEAN }).allowed).toBe(true);
    expect(canAutoRoute(extraction({ status: 'ambiguous', confirmed_start_at: null }, { triage_flags: ['ambiguous_scheduling'] }), { addressValidation: AV_CLEAN }).allowed).toBe(false);
  });
});

// Prompt v32 (2026-10-29 call audit): staff and the caller settled Thursday the 5th at 10, staff's
// closing line said Monday, the caller answered only "Okay. See you next week."; the extraction
// answered "ambiguous" and nothing was booked.
describe('case: the day/time conflict rule (staff closing slip, v32)', () => {
  const fixture = require('../fixtures/call-extraction-eval/synthetic-day-conflict-and-billing-choice.json');
  const byId = (id) => fixture.cases.find((c) => c.id === id);
  const { buildExtractionPromptParts } = require('../services/prompts/call-extraction-v1');
  const { auditAppointmentContract } = require('../services/prompts/appointment-confirmed-rules');

  test('the prompt says the caller-accepted slot stands over a later staff-only day or time', () => {
    expect(PROMPT).toContain('DAY/TIME CONFLICT');
    expect(PROMPT).toContain('the agreed slot is the day and time the CALLER accepted in the caller\'s own words and staff committed to. This is NOT a last-said rule.');
    expect(PROMPT).toContain('LATER ONLY by staff');
    expect(PROMPT).toContain('that the caller did not accept in the caller\'s own words does NOT replace that slot');
    expect(PROMPT).toContain('"okay", "see you next week" or "thanks" has not accepted it');
    expect(PROMPT).toContain('write the later staff slip into scheduling_notes_raw');
  });

  test('the prompt lets a caller-accepted later slot supersede, and keeps two accepted slots ambiguous', () => {
    expect(PROMPT).toContain('A later slot the CALLER explicitly accepted');
    expect(PROMPT).toContain('DOES supersede the earlier one');
    expect(PROMPT).toContain('caller_accepted_slot is false when the caller later changed the slot');
    expect(PROMPT).toContain('When two different slots are both still caller-accepted at hangup and neither was withdrawn, the status is "ambiguous" and confirmed_start_at is null');
  });

  test('a calendar date whose weekday disagrees is contested: ambiguous, no confirmed time', () => {
    expect(PROMPT).toContain('When a stated calendar date and its weekday disagree ("Thursday the 6th" when the 6th is a Friday');
    expect(PROMPT).toContain('the day is contested: status "ambiguous", confirmed_start_at null, because a wrong booking is worse than none');
  });

  test('no new triage flag, and CORRECTIONS / FINAL OUTCOME point at the paragraph', () => {
    expect(PROMPT).toContain('Do not add a triage flag for any of this.');
    expect(PROMPT).toMatch(/CORRECTIONS:[^\n]*only a change the CALLER made or accepted counts; see the DAY\/TIME CONFLICT paragraph in SCHEDULING STATUS/);
    expect(PROMPT).toMatch(/FINAL OUTCOME WINS:[^\n]*said only by staff and not accepted by the caller is not a change: see the DAY\/TIME CONFLICT paragraph/);
    expect(PROMPT.match(/DAY\/TIME CONFLICT/g).length).toBeGreaterThanOrEqual(3);
  });

  test('the rule sits in the scheduling rules, before the existing-appointment line, in both layouts', () => {
    const { system } = buildExtractionPromptParts('Agent: hi', '+19415550100', '2026-10-05', { callTimeET: '1:12 PM' });
    for (const text of [PROMPT, system]) {
      expect(text.indexOf(DAY_TIME_CONFLICT_RULE)).toBeGreaterThan(text.indexOf(CALLER_PROPOSED_TIME_RULE));
      expect(text.indexOf(DAY_TIME_CONFLICT_RULE)).toBeLessThan(text.indexOf('EXISTING APPOINTMENT:'));
    }
  });

  test('the self-audit grades V2 answers by the same text, and V1 answers by none of it', () => {
    // The audit contract carries the rule without its weekday/date check (no judge is given the call's date).
    expect(auditAppointmentContract('2026-10-29')).toContain(DAY_TIME_CONFLICT_AUDIT_RULE);
    expect(auditAppointmentContract('2026-10-29')).not.toContain(DAY_TIME_CONFLICT_RULE);
    expect(DAY_TIME_CONFLICT_RULE).toContain('Thursday the 6th');
    expect(DAY_TIME_CONFLICT_AUDIT_RULE).not.toContain('Thursday the 6th');
    expect(auditAppointmentContract('2026-10-29', { v2OnlyRules: false })).not.toContain(DAY_TIME_CONFLICT_AUDIT_RULE);
  });

  test('the synthetic fixture carries the 10-29 shape with invented names only', () => {
    const slip = byId('day-conflict-closing-slip');
    expect(slip.transcript).toContain('I\'ll punch you in for 10 o\'clock on Thursday the 5th');
    expect(slip.transcript).toContain('We\'ll see you at 10 a.m. on Monday.');
    expect(slip.transcript.trim().split('\n').pop()).toBe('Caller: Okay. See you next week.');
    for (const c of fixture.cases) {
      expect(c.transcript).not.toMatch(/\d{3}[-. ]\d{3}[-. ]\d{4}/);
      expect(c.transcript.match(/Pat Example|Sam|100 Example Lane/)).not.toBeNull();
    }
  });

  test('the fixture weekdays match their dates (Nov 5 and Nov 2 2026 are Thursday and Monday, Nov 6 is Friday)', () => {
    const weekday = (iso) => new Date(`${iso.slice(0, 10)}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' });
    expect(weekday(byId('day-conflict-closing-slip').expect.confirmed_start_at)).toBe('Thursday');
    expect(weekday(byId('day-conflict-caller-accepted-change').expect.confirmed_start_at)).toBe('Monday');
    expect(weekday('2026-11-06')).toBe('Friday');
    expect(weekday(fixture.cases[0].call_date_et)).toBe('Thursday');
  });

  test('routing books the closing-slip extraction at Thursday 10 and holds the ambiguous ones', () => {
    const slip = byId('day-conflict-closing-slip').expect;
    expect(canAutoRoute(extraction({
      status: slip.scheduling_status,
      confirmed_start_at: slip.confirmed_start_at,
      agreed_slot_words: slip.agreed_slot_words,
      caller_accepted_slot: slip.caller_accepted_slot,
      agent_committed_booking: slip.agent_committed_booking,
    }, { triage_flags: slip.triage_flags_added }), { addressValidation: AV_CLEAN }).allowed).toBe(true);
    for (const id of ['day-conflict-two-slots-both-accepted', 'day-conflict-weekday-date-mismatch']) {
      const e = byId(id).expect;
      expect(e.scheduling_status).toBe('ambiguous');
      expect(e.confirmed_start_at).toBeNull();
      expect(canAutoRoute(extraction({ status: e.scheduling_status, confirmed_start_at: e.confirmed_start_at }), { addressValidation: AV_CLEAN }).allowed).toBe(false);
    }
  });
});

// Prompt v33 (2026-10-30 call audit): a call started at 12:52 AM on a Friday; the caller said Friday
// was "tomorrow", accepted five o'clock, and staff closed with "see you tomorrow at five". The
// extraction read "tomorrow" as Saturday, called the day contested, and nothing was booked.
describe('case: calls after midnight (v33)', () => {
  const fixture = require('../fixtures/call-extraction-eval/synthetic-after-midnight-tomorrow.json');
  const byId = (id) => fixture.cases.find((c) => c.id === id);
  const { buildExtractionPromptParts } = require('../services/prompts/call-extraction-v1');
  const { afterMidnightDayRule, auditAppointmentContract } = require('../services/prompts/appointment-confirmed-rules');
  const SYSTEM_REF = 'the "Call date in Eastern Time" given in the user message';

  test('the rule renders with the call date in one message and with the date-line reference in the system layout', () => {
    expect(PROMPT).toContain(afterMidnightDayRule('2026-10-05'));
    const { system, user } = buildExtractionPromptParts('Agent: hi', '+19415550100', '2026-11-06', { callTimeET: '12:40 AM' });
    expect(system).toContain(afterMidnightDayRule(SYSTEM_REF));
    expect(user).toContain('Call time in Eastern Time (when the call started): 12:40 AM');
    expect(user).not.toContain('CALLS AFTER MIDNIGHT');
  });

  test('the rule reads "tomorrow" on a 12:00-4:00 AM call as the call date, and a stated other day governs', () => {
    const rule = afterMidnightDayRule('2026-11-06');
    expect(rule).toContain('when the call time given at the top is from 12:00 AM up to 4:00 AM');
    expect(rule).toContain('names the coming daytime, which is the CALL DATE itself (2026-11-06), not the day after it');
    expect(rule).toContain('A weekday that names the call date ("Friday" on a call that started early on a Friday) is that same day, so it agrees with "tomorrow"');
    expect(rule).toContain('the stated weekday or date governs');
    expect(rule).toContain('Outside 12:00 AM to 4:00 AM, "tomorrow" is the day after the call date as usual.');
  });

  test('the rule sits right after the day/time conflict rule, before the existing-appointment line, in both layouts', () => {
    const { system } = buildExtractionPromptParts('Agent: hi', '+19415550100', '2026-11-06', { callTimeET: '12:40 AM' });
    for (const [text, ref] of [[PROMPT, '2026-10-05'], [system, SYSTEM_REF]]) {
      expect(text.indexOf(afterMidnightDayRule(ref))).toBe(text.indexOf(DAY_TIME_CONFLICT_RULE) + DAY_TIME_CONFLICT_RULE.length + 1);
      expect(text.indexOf(afterMidnightDayRule(ref))).toBeLessThan(text.indexOf('EXISTING APPOINTMENT:'));
    }
  });

  test('the self-audit does not carry it: no judge is given the call clock', () => {
    expect(auditAppointmentContract('2026-11-06')).not.toContain('CALLS AFTER MIDNIGHT');
    expect(auditAppointmentContract('2026-11-06', { v2OnlyRules: false })).not.toContain('CALLS AFTER MIDNIGHT');
  });

  test('a 12:52 AM ET start renders as the call time the rule compares against', () => {
    expect(callTimeETString('2026-10-30T04:52:53.766Z')).toBe('12:52 AM');
    expect(callTimeETString('2026-11-06T05:40:00Z')).toBe('12:40 AM');
  });

  test('the fixture weekdays and offsets match (Nov 6 2026 is a Friday, Nov 7 a Saturday, both EST)', () => {
    const weekday = (iso) => new Date(`${iso.slice(0, 10)}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' });
    expect(weekday(byId('after-midnight-tomorrow-is-call-date').call_date_et)).toBe('Friday');
    expect(byId('after-midnight-tomorrow-is-call-date').expect.confirmed_start_at.slice(0, 10)).toBe('2026-11-06');
    expect(weekday(byId('after-midnight-weekday-names-later-day').expect.confirmed_start_at)).toBe('Saturday');
    expect(byId('daytime-tomorrow-is-next-day').expect.confirmed_start_at.slice(0, 10)).toBe('2026-11-07');
    for (const c of fixture.cases) {
      expect(c.expect.confirmed_start_at).toMatch(/-05:00$/);
      expect(c.transcript).not.toMatch(/\d{3}[-. ]\d{3}[-. ]\d{4}/);
      expect(c.transcript).toContain('Pat Example');
    }
  });

  test('routing books the after-midnight extraction on the call date', () => {
    const e = byId('after-midnight-tomorrow-is-call-date').expect;
    expect(canAutoRoute(extraction({
      status: e.scheduling_status,
      confirmed_start_at: e.confirmed_start_at,
    }), { addressValidation: AV_CLEAN }).allowed).toBe(true);
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
