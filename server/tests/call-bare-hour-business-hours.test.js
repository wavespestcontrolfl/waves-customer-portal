// A NEW booking's start hour agreed without AM/PM ("can we plan on 2
// o'clock?" / "Sure.") reads as business hours (owner decision 2026-09-29;
// live miss: call 4de755e1, a WDO agreed at "2 o'clock" never booked because
// extraction set appointment_confirmed false: the period was never said).
// It is the rule the owner approved for reschedules on 2026-09-28 (7-11
// morning; 12 and 1-6 afternoon; call-reschedule-agreement.js), now in the
// extraction contract for every booking. The judgment is the model's, so what
// is asserted here is the contract it is given (both prompts, both schemas,
// the version stamps) and that the routing gates accept the extraction that
// contract produces for the real call shape while still holding the shapes
// that stay closed.
const fs = require('fs');
const path = require('path');
const { buildExtractionPrompt, PROMPT_VERSION, PROMPT_HASH } = require('../services/prompts/call-extraction-v1');
const { canAutoRoute } = require('../services/call-triage-flags');
const { V2_DECISION_VERSION, V2_DECISION_VERSIONS } = require('../services/call-routing-gates');

const AV_CLEAN = { status: 'validated_accept', inServiceArea: true, county: 'Manatee County' };

// The exact shape of call 4de755e1 (names synthetic).
const BARE_HOUR_WDO_TRANSCRIPT = [
  'Caller: Hi, this is Sam. I need a WDO inspection today, can somebody come between 1:30 and 3:30?',
  "Agent: Let me look at the schedule. Let's plan on... can we plan on 2 o'clock?",
  'Caller: Sure.',
].join('\n');

function extraction(scheduling) {
  return {
    triage_flags: [],
    confidence: { overall: 0.9 },
    scheduling,
    consent: {},
  };
}

const V2_PROMPT = buildExtractionPrompt(BARE_HOUR_WDO_TRANSCRIPT, '+19415550100', '2026-09-29');
const processorSrc = fs.readFileSync(require.resolve('../services/call-recording-processor'), 'utf8');
const V1_PROMPT = processorSrc.slice(processorSrc.indexOf('- ARRIVAL WINDOW EXCEPTION:'), processorSrc.indexOf('- If the agent says "I\'ll text you"'));

describe.each([
  ['V2 prompt (call-extraction-v1.js)', V2_PROMPT, 'confirmed_start_at null'],
  ['V1 prompt (call-recording-processor.js)', V1_PROMPT, 'appointment_confirmed stays false'],
])('%s reads a committed, accepted hour with no AM/PM as business hours', (_name, prompt, notConfirmed) => {
  test('the bare-hour WDO shape is the worked example, with the 7-11 / 12 / 1-6 reading', () => {
    expect(prompt).toContain('BUSINESS-HOURS READING');
    expect(prompt).toContain('"can we plan on 2 o\'clock?" answered "Sure."');
    expect(prompt).toContain('7 to 11 is the morning, 12 and 1 to 6 the afternoon');
    // Staff committed AND the caller accepted, on a specific day.
    expect(prompt).toMatch(/COMMITTED to that hour and the caller ACCEPTED it/);
    expect(prompt).toContain('on a specific day');
  });

  test('a window\'s start hour takes the same reading', () => {
    expect(prompt).toContain('"Tuesday, 2 to 4"; "between 2 and 4"');
    expect(prompt).toContain('one time, or a range\'s start');
  });

  test('stays closed for approximations, bounds, alternatives, minutes and a non-clock hour', () => {
    for (const shape of ['"around two", "two-ish"', '"by two", "before two"', '"two or three"', '"two or four"', '"two thirty"', 'an hour that is not one of 1 to 12']) {
      expect(prompt).toContain(shape);
    }
  });

  test('a period anyone states that conflicts with the reading blocks confirmation', () => {
    expect(prompt).toContain('conflicts with the business-hours reading');
    expect(prompt).toContain('"two in the morning"');
    expect(prompt).toContain('the stated period governs');
    expect(prompt).toContain(notConfirmed);
  });

  test('an offer staff did not commit to stays not confirmed, and stated periods keep their period', () => {
    expect(prompt).toContain('"we\'ll try to fit you in"');
    expect(prompt).toContain('stays NOT confirmed');
    expect(prompt).toContain('keeps that period');
  });

  test('the old "never inferred / does not qualify" refusal is gone', () => {
    expect(prompt).not.toContain('you would otherwise have to invent AM or PM');
  });
});

describe('the recorded period stays null for an unstated hour', () => {
  test.each(['model-output', 'persisted'])('%s schema description no longer says "never inferred from business hours"', (which) => {
    const schema = fs.readFileSync(path.join(__dirname, '..', 'schemas', `call-extraction.${which}.schema.json`), 'utf8');
    expect(schema).not.toContain('never inferred from business hours');
    expect(schema).toContain('read as business hours by the prompt rule');
    expect(schema).toContain('with period null');
    // Still never a part of day describing the OLD appointment.
    expect(schema).toContain('never a part of day describing the OLD appointment');
  });

  test('the V2 prompt says the same for a new booking and a reschedule', () => {
    expect(V2_PROMPT).toContain('BUSINESS-HOURS READING rule above, for a new booking or a reschedule, with period null');
    expect(V2_PROMPT).toContain('your morning appointment');
  });
});

describe('evidence pinning lets a new booking take its day from an earlier turn (codex #5322 r2 P1)', () => {
  test('the confirmed_start_at quote may state only the time when the day was set earlier, one turn, never stitched', () => {
    expect(V2_PROMPT).toContain('except for a NEW booking whose day was already set earlier in the call');
    expect(V2_PROMPT).toContain('quote the one turn that states the agreed time, verbatim, and resolve the day from that earlier turn; never stitch two turns into one quote');
  });
  test('the agent commitment keeps its day-and-time sentence rule; a split-turn booking leaves it null (codex #5322 r3 P1)', () => {
    expect(V2_PROMPT).toContain('The day-from-an-earlier-turn exception for confirmed_start_at does NOT apply here');
    expect(V2_PROMPT).toContain('leave agent_committed_booking null');
    expect(V2_PROMPT).not.toContain('the agent sentence that states the agreed TIME is enough');
  });
  test('a reschedule keeps its one-turn day-and-time quote rule', () => {
    expect(V2_PROMPT).toContain('For a reschedule, each of the scheduling quotes above is ONE speaker\'s words from ONE turn');
  });
});

describe('routing accepts the extraction the contract produces for the bare-hour WDO call, and holds the rest', () => {
  test('confirmed at 2 PM with no period recorded books', () => {
    const r = canAutoRoute(extraction({
      status: 'confirmed',
      confirmed_start_at: '2026-09-29T14:00:00-04:00',
      agreed_slot_words: { day: null, hour: '2', period: null },
      caller_accepted_slot: true,
    }), { addressValidation: AV_CLEAN });
    expect(r.allowed).toBe(true);
  });

  test('the pre-fix extraction (period never said -> requested) is still held as not_confirmed', () => {
    const r = canAutoRoute(extraction({ status: 'requested', confirmed_start_at: null }), { addressValidation: AV_CLEAN });
    expect(r).toMatchObject({ allowed: false, reason: 'not_confirmed' });
  });

  test('an unaccepted offer (status offered) stays held', () => {
    expect(canAutoRoute(extraction({ status: 'offered', confirmed_start_at: null }), { addressValidation: AV_CLEAN })).toMatchObject({ allowed: false, reason: 'not_confirmed' });
  });

  test('an off-the-hour start is still held (two-thirty)', () => {
    const r = canAutoRoute(extraction({ status: 'confirmed', confirmed_start_at: '2026-09-29T14:30:00-04:00' }), { addressValidation: AV_CLEAN });
    expect(r).toMatchObject({ allowed: false, reason: 'off_hour_start' });
  });
});

describe('version stamps', () => {
  test('prompt v19 and decision v2-1.50.0 are new, listed and current', () => {
    expect(PROMPT_VERSION).toBe('v19');
    expect(PROMPT_HASH).toMatch(/^v19-[a-f0-9]{12}$/);
    expect(V2_DECISION_VERSIONS.indexOf(V2_DECISION_VERSION)).toBeGreaterThanOrEqual(V2_DECISION_VERSIONS.indexOf('v2-1.50.0'));
    expect(V2_DECISION_VERSIONS).toContain('v2-1.50.0');
    expect(V2_DECISION_VERSIONS.indexOf('v2-1.50.0')).toBeGreaterThan(V2_DECISION_VERSIONS.indexOf('v2-1.49.0'));
  });
});
