// Reschedule agreement grounding: the extraction judges the agreement and
// the appointment moved; this module only checks its pinned quotes against
// the transcript. Fixtures are fictitious (synthetic transcript lines).
const { groundRescheduleAgreement } = require('../services/call-reschedule-agreement');

// Wed Sep 23, 2026, 3 PM ET.
const CALL_STARTED_AT = '2026-09-23T19:00:00Z';
const THURSDAY_2PM = '2026-09-24T14:00:00-04:00';
const COMMIT = 'We will see you Thursday at two.';
const ACCEPT = 'Yes, that works for me.';
const TRANSCRIPT = `Caller: Can we move my visit?\nAgent: ${COMMIT}\nCaller: ${ACCEPT}`;

const quote = (fieldPath, speaker, text) => ({ field_path: fieldPath, speaker, quote: text });
function v2({ scheduling = {}, evidence } = {}) {
  return {
    scheduling: {
      status: 'reschedule_requested', confirmed_start_at: THURSDAY_2PM, agent_committed_booking: true, caller_accepted_slot: true,
      ...scheduling,
    },
    evidence: evidence || [
      quote('/scheduling/agent_committed_booking', 'agent', COMMIT),
      quote('/scheduling/confirmed_start_at', 'agent', COMMIT),
      quote('/scheduling/caller_accepted_slot', 'caller', ACCEPT),
    ],
  };
}
const ground = (extraction, transcript = TRANSCRIPT) => groundRescheduleAgreement({ v2: extraction, transcript, callStartedAt: CALL_STARTED_AT });
// The agent commits to `slot` saying `text`, which is also the agreed-slot quote.
const agreedAt = (slot, text) => ground(v2({ scheduling: { confirmed_start_at: slot }, evidence: [
  quote('/scheduling/agent_committed_booking', 'agent', text),
  quote('/scheduling/confirmed_start_at', 'agent', text),
  quote('/scheduling/caller_accepted_slot', 'caller', ACCEPT),
] }), `Caller: Can we move my visit?\nAgent: ${text}\nCaller: ${ACCEPT}`);

describe('groundRescheduleAgreement', () => {
  test('grounded quotes from both speakers naming the slot establish the agreement', () => {
    expect(ground(v2())).toEqual({ ok: true, reason: 'agreement_grounded', movedDate: null });
    // Case, punctuation and spacing do not matter.
    expect(ground(v2({ evidence: [
      quote('/scheduling/agent_committed_booking', 'agent', 'we will see you thursday at two'),
      quote('/scheduling/confirmed_start_at', 'agent', 'Thursday at two'),
      quote('/scheduling/caller_accepted_slot', 'caller', 'yes that works for me'),
    ] })).ok).toBe(true);
  });

  test('the extraction must judge both sides agreed', () => {
    expect(ground(v2({ scheduling: { caller_accepted_slot: false } }))).toMatchObject({ ok: false, reason: 'caller_did_not_accept' });
    expect(ground(v2({ scheduling: { caller_accepted_slot: null } }))).toMatchObject({ ok: false, reason: 'caller_did_not_accept' });
    expect(ground(v2({ scheduling: { agent_committed_booking: false } }))).toMatchObject({ ok: false, reason: 'agent_did_not_commit' });
  });

  // The module checks quotes, not meaning: judging a later withdrawal is the
  // extraction's job (owner decision 2026-09-27), and it already said the
  // caller accepted — this call is one it would have judged otherwise.
  test('it does not re-read the conversation beyond the quotes', () => {
    expect(ground(v2(), `${TRANSCRIPT}\nCaller: Actually, never mind.`).ok).toBe(true);
  });

  test('every quote must appear word for word in a turn of its own speaker', () => {
    expect(ground(v2({ evidence: [] }))).toMatchObject({ ok: false, reason: 'agent_commitment_ungrounded' });
    // Said by the caller, not the agent.
    expect(ground(v2(), `Caller: ${COMMIT}\nAgent: Okay.\nCaller: ${ACCEPT}`)).toMatchObject({ ok: false, reason: 'agent_commitment_ungrounded' });
    // Never said.
    expect(ground(v2(), `Caller: Can we move my visit?\nAgent: Let me check.\nCaller: ${ACCEPT}`)).toMatchObject({ ok: false, reason: 'agent_commitment_ungrounded' });
    // Labeled with the wrong speaker.
    expect(ground(v2({ evidence: [
      quote('/scheduling/agent_committed_booking', 'caller', COMMIT),
      quote('/scheduling/confirmed_start_at', 'agent', COMMIT),
      quote('/scheduling/caller_accepted_slot', 'caller', ACCEPT),
    ] }))).toMatchObject({ ok: false, reason: 'agent_commitment_ungrounded' });
    expect(ground(v2(), `Caller: Can we move my visit?\nAgent: ${COMMIT}\nCaller: Thanks, bye.`)).toMatchObject({ ok: false, reason: 'caller_acceptance_ungrounded' });
  });

  test('a quote under three words must be the whole turn, never a fragment of a longer one', () => {
    const shortYes = (callerLine) => ground(v2({ evidence: [
      quote('/scheduling/agent_committed_booking', 'agent', COMMIT),
      quote('/scheduling/confirmed_start_at', 'agent', COMMIT),
      quote('/scheduling/caller_accepted_slot', 'caller', 'Yes.'),
    ] }), `Caller: Can we move my visit?\nAgent: ${COMMIT}\nCaller: ${callerLine}`);
    expect(shortYes('Yes.').ok).toBe(true);
    expect(shortYes('Yes, but not Thursday.')).toMatchObject({ ok: false, reason: 'caller_acceptance_ungrounded' });
  });

  test('the agreed-slot quote must name the slot: its hour, on the hour, and its day', () => {
    const slotQuote = (text) => agreedAt(THURSDAY_2PM, text);
    expect(slotQuote('We will see you Thursday at one.')).toMatchObject({ ok: false, reason: 'agreed_slot_ungrounded' });
    expect(slotQuote('We will see you Friday at two.')).toMatchObject({ ok: false, reason: 'agreed_slot_ungrounded' });
    for (const said of [
      'Thursday at two or four', 'Thursday at 2:30', 'Thursday before two', 'Thursday at two or later',
      // Codex #5092 r1: an unmarked correction, a decimal clock time, and a
      // period said before the hour that isn't the slot's.
      'Thursday at two, actually three', 'Thursday at 2.30 PM', 'Thursday AM at 2', 'Thursday morning at 2 pm',
    ]) {
      expect(slotQuote(`We will see you ${said}.`)).toMatchObject({ ok: false, reason: 'agreed_slot_ungrounded' });
    }
    // An hour is required, and a day unless the slot keeps the moved visit's day.
    expect(slotQuote('We will see you Thursday.')).toMatchObject({ ok: false, reason: 'agreed_slot_ungrounded' });
    expect(slotQuote('We will see you at two.')).toMatchObject({ ok: false, reason: 'agreed_slot_ungrounded' });
    expect(slotQuote('We will see you September 24th at 2 PM.').ok).toBe(true);
    expect(slotQuote('We will see you Thursday PM at 2.').ok).toBe(true);
    expect(slotQuote('I am moving you to Thursday at two.').ok).toBe(true);
    expect(slotQuote('I am moving you to Thursday at 2 PM.').ok).toBe(true);
  });

  // Pre-push audit P1 (552f7a5ac2): a quote that stops partway through a
  // time, or before a correction, is judged with the rest of its sentence.
  test('a quote is judged with the whole sentence it sits in', () => {
    const cut = (said, slotQuote, movedQuote = null, moved = null) => ground(v2({
      scheduling: moved ? { moved_appointment_date: moved } : {},
      evidence: [
        quote('/scheduling/agent_committed_booking', 'agent', said),
        quote('/scheduling/confirmed_start_at', 'agent', slotQuote),
        quote('/scheduling/caller_accepted_slot', 'caller', ACCEPT),
        ...(movedQuote ? [quote('/scheduling/moved_appointment_date', 'agent', movedQuote)] : []),
      ],
    }), `Caller: Can we move my visit?\nAgent: ${said}\nCaller: ${ACCEPT}`);
    expect(cut('We will see you Thursday at 2:30 PM.', 'see you Thursday at 2')).toMatchObject({ ok: false, reason: 'agreed_slot_ungrounded' });
    expect(cut('We will see you Thursday at two or four.', 'see you Thursday at two')).toMatchObject({ ok: false, reason: 'agreed_slot_ungrounded' });
    expect(cut('We will see you Thursday at two, actually three.', 'see you Thursday at two')).toMatchObject({ ok: false, reason: 'agreed_slot_ungrounded' });
    expect(cut('We will move your October 8th visit, or the October 9th one, to Thursday at two.', 'Thursday at two', 'your October 8th visit', '2026-10-08'))
      .toMatchObject({ ok: false, reason: 'moved_appointment_ungrounded' });
    // Codex #5092 r2: a loose number beside the moved date ("October 8, actually 9").
    expect(cut('We will move your October 8, actually 9, visit to Thursday at two.', 'Thursday at two', 'your October 8', '2026-10-08'))
      .toMatchObject({ ok: false, reason: 'moved_appointment_ungrounded' });
    // A whole time grounds, and the sentence may name the moved date beside the slot.
    expect(cut('Okay so we will see you Thursday at 2 PM then.', 'see you Thursday at 2 PM').ok).toBe(true);
    expect(cut('We will move it from October 8th to Thursday at two.', 'to Thursday at two', 'it from October', '2026-10-08'))
      .toMatchObject({ ok: true, movedDate: '2026-10-08' });
  });

  test('a weekday beside an explicit date describes that date', () => {
    const at = (text) => agreedAt('2026-12-17T12:00:00-05:00', text);
    expect(at('We will see you Thursday, December 17 at noon.').ok).toBe(true);
    expect(at('We will see you Wednesday, December 17 at noon.')).toMatchObject({ ok: false, reason: 'agreed_slot_ungrounded' });
    // A weekday alone names only this week's or next week's.
    expect(at('We will see you Thursday at noon.')).toMatchObject({ ok: false, reason: 'agreed_slot_ungrounded' });
  });

  test('a date\'s own number never stands in for the agreed hour', () => {
    const at = (text) => agreedAt('2026-10-02T14:00:00-04:00', text);
    expect(at('We will see you October 2 in the afternoon.')).toMatchObject({ ok: false, reason: 'agreed_slot_ungrounded' });
    expect(at('We will see you October 2, 2 to 4 pm.').ok).toBe(true);
    // Codex #5092 r2: no am/pm said for the window, so its half of the day is open.
    expect(at('We will see you October 2, 2 to 4.')).toMatchObject({ ok: false, reason: 'agreed_slot_ungrounded' });
    expect(at('We will see you October 2 at two in the afternoon.').ok).toBe(true);
  });

  test('the moved appointment must be named by a grounded quote, and a same-day change needs no day in the slot quote', () => {
    const moved = (movedQuote, callerOpening = `Can you move ${movedQuote}?`, movedDate = '2026-09-24') => ground(v2({
      scheduling: { moved_appointment_date: movedDate },
      evidence: [
        quote('/scheduling/agent_committed_booking', 'agent', 'We will see you at two instead.'),
        quote('/scheduling/confirmed_start_at', 'agent', 'We will see you at two instead.'),
        quote('/scheduling/caller_accepted_slot', 'caller', ACCEPT),
        quote('/scheduling/moved_appointment_date', 'caller', movedQuote),
      ],
    }), `Caller: ${callerOpening}\nAgent: We will see you at two instead.\nCaller: ${ACCEPT}`);
    expect(moved('my September 24th visit')).toEqual({ ok: true, reason: 'agreement_grounded', movedDate: '2026-09-24' });
    expect(moved('my visit tomorrow').ok).toBe(true);
    expect(moved('my September 25th visit')).toMatchObject({ ok: false, reason: 'moved_appointment_ungrounded' });
    expect(moved('my next visit')).toMatchObject({ ok: false, reason: 'moved_appointment_ungrounded' });
    expect(moved('my September 24th visit', 'Can you move my next visit?')).toMatchObject({ ok: false, reason: 'moved_appointment_ungrounded' });
    // Without the moved appointment, a slot quote naming no day grounds nothing.
    expect(ground(v2({ evidence: [
      quote('/scheduling/agent_committed_booking', 'agent', 'We will see you at two instead.'),
      quote('/scheduling/confirmed_start_at', 'agent', 'We will see you at two instead.'),
      quote('/scheduling/caller_accepted_slot', 'caller', ACCEPT),
    ] }), `Caller: Can we make it later?\nAgent: We will see you at two instead.\nCaller: ${ACCEPT}`)).toMatchObject({ ok: false, reason: 'agreed_slot_ungrounded' });
  });

  // The fixtures above inject the fields; this pins them to the stored V2
  // contract (schema 1.16.0), where a rename on either side would silently
  // skip every automatic move.
  test('it reads the scheduling fields and evidence speakers the stored V2 extraction defines', () => {
    const schema = require('../schemas/call-extraction.persisted.schema.json');
    expect(schema.properties.scheduling.properties).toMatchObject({
      agent_committed_booking: { type: ['boolean', 'null'] },
      caller_accepted_slot: { type: ['boolean', 'null'] },
      confirmed_start_at: { format: 'date-time' },
      moved_appointment_date: { format: 'date' },
    });
    expect(schema.properties.evidence.items.properties.speaker.enum).toEqual(['caller', 'agent']);
  });

  test('an unlabeled or one-sided transcript, or an unreadable slot, fails closed', () => {
    expect(ground(v2(), 'We will see you Thursday at two.')).toMatchObject({ ok: false, reason: 'unparseable_transcript' });
    expect(ground(v2(), `Agent: ${COMMIT}`)).toMatchObject({ ok: false, reason: 'unparseable_transcript' });
    expect(ground(v2({ scheduling: { confirmed_start_at: 'not-a-time' } }))).toMatchObject({ ok: false, reason: 'unparseable_slot' });
    expect(groundRescheduleAgreement({ v2: v2(), transcript: TRANSCRIPT, callStartedAt: 'nope' })).toMatchObject({ ok: false, reason: 'unparseable_slot' });
  });
});
