// Reschedule agreement grounding: the extraction judges the agreement, the
// appointment moved and the words that stated the agreed time; this module
// only checks its quotes against the transcript and the words against the
// slot. Fixtures are fictitious (synthetic transcript lines).
const { groundRescheduleAgreement } = require('../services/call-reschedule-agreement');

// Wed Sep 23, 2026, 3 PM ET.
const CALL_STARTED_AT = '2026-09-23T19:00:00Z';
const THURSDAY_2PM = '2026-09-24T14:00:00-04:00';
const COMMIT = 'We will see you Thursday at two in the afternoon.';
const ACCEPT = 'Yes, that works for me.';
const TRANSCRIPT = `Caller: Can we move my visit?\nAgent: ${COMMIT}\nCaller: ${ACCEPT}`;
const WORDS = { day: 'Thursday', hour: 'two', period: 'in the afternoon' };

const quote = (fieldPath, speaker, text) => ({ field_path: fieldPath, speaker, quote: text });
function v2({ scheduling = {}, evidence } = {}) {
  return {
    scheduling: {
      status: 'reschedule_requested', confirmed_start_at: THURSDAY_2PM, agent_committed_booking: true, caller_accepted_slot: true,
      agreed_slot_words: WORDS,
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
// The agent says `text` (also the agreed-slot quote) and the extraction
// records `words` for `slot`.
const agreedAt = (slot, text, words) => ground(v2({ scheduling: { confirmed_start_at: slot, agreed_slot_words: words }, evidence: [
  quote('/scheduling/agent_committed_booking', 'agent', text),
  quote('/scheduling/confirmed_start_at', 'agent', text),
  quote('/scheduling/caller_accepted_slot', 'caller', ACCEPT),
] }), `Caller: Can we move my visit?\nAgent: ${text}\nCaller: ${ACCEPT}`);

describe('groundRescheduleAgreement', () => {
  test('grounded quotes holding the recorded words of the slot establish the agreement', () => {
    expect(ground(v2())).toEqual({ ok: true, reason: 'agreement_grounded', movedDate: null });
    // Case, punctuation and spacing do not matter.
    expect(ground(v2({
      scheduling: { agreed_slot_words: { day: 'thursday', hour: 'Two', period: 'in the afternoon.' } },
      evidence: [
        quote('/scheduling/agent_committed_booking', 'agent', 'we will see you thursday at two'),
        quote('/scheduling/confirmed_start_at', 'agent', 'Thursday at two, in the afternoon'),
        quote('/scheduling/caller_accepted_slot', 'caller', 'yes that works for me'),
      ],
    })).ok).toBe(true);
  });

  test('the extraction must judge both sides agreed', () => {
    expect(ground(v2({ scheduling: { caller_accepted_slot: false } }))).toMatchObject({ ok: false, reason: 'caller_did_not_accept' });
    expect(ground(v2({ scheduling: { caller_accepted_slot: null } }))).toMatchObject({ ok: false, reason: 'caller_did_not_accept' });
    expect(ground(v2({ scheduling: { agent_committed_booking: false } }))).toMatchObject({ ok: false, reason: 'agent_did_not_commit' });
  });

  // The module checks quotes and words, not meaning: which words are the
  // final agreed ones is the extraction's judgement (owner decision
  // 2026-09-27).
  test('it does not re-read the conversation beyond the quotes', () => {
    expect(ground(v2(), `${TRANSCRIPT}\nCaller: Actually, never mind.`).ok).toBe(true);
  });

  test('every quote must appear word for word in a turn of its own speaker', () => {
    expect(ground(v2({ evidence: [] }))).toMatchObject({ ok: false, reason: 'agent_commitment_ungrounded' });
    expect(ground(v2(), `Caller: ${COMMIT}\nAgent: Okay.\nCaller: ${ACCEPT}`)).toMatchObject({ ok: false, reason: 'agent_commitment_ungrounded' });
    expect(ground(v2(), `Caller: Can we move my visit?\nAgent: Let me check.\nCaller: ${ACCEPT}`)).toMatchObject({ ok: false, reason: 'agent_commitment_ungrounded' });
    expect(ground(v2({ evidence: [
      quote('/scheduling/agent_committed_booking', 'caller', COMMIT),
      quote('/scheduling/confirmed_start_at', 'agent', COMMIT),
      quote('/scheduling/caller_accepted_slot', 'caller', ACCEPT),
    ] }))).toMatchObject({ ok: false, reason: 'agent_commitment_ungrounded' });
    expect(ground(v2(), `Caller: Can we move my visit?\nAgent: ${COMMIT}\nCaller: Thanks, bye.`)).toMatchObject({ ok: false, reason: 'caller_acceptance_ungrounded' });
    // The slot quote itself must be real.
    expect(ground(v2({ evidence: [
      quote('/scheduling/agent_committed_booking', 'agent', COMMIT),
      quote('/scheduling/confirmed_start_at', 'agent', 'Thursday at two in the afternoon works'),
      quote('/scheduling/caller_accepted_slot', 'caller', ACCEPT),
    ] }))).toMatchObject({ ok: false, reason: 'agreed_slot_ungrounded' });
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

  test('the recorded slot words must be in the slot quote', () => {
    const withWords = (words) => ground(v2({ scheduling: { agreed_slot_words: { ...WORDS, ...words } } }));
    expect(withWords({ period: 'pm' })).toMatchObject({ ok: false, reason: 'agreed_slot_ungrounded' });
    expect(withWords({ day: 'Thurs.' })).toMatchObject({ ok: false, reason: 'agreed_slot_ungrounded' });
    // Whole words only: "two" is not in "twenty".
    expect(agreedAt(THURSDAY_2PM, 'We will see you Thursday at twenty past in the afternoon.', WORDS)).toMatchObject({ ok: false, reason: 'agreed_slot_ungrounded' });
  });

  test('the recorded words must state the slot: one hour, its half of the day, its date', () => {
    const at = (words, slot = THURSDAY_2PM) => ground(v2({ scheduling: { confirmed_start_at: slot, agreed_slot_words: { ...WORDS, ...words } } }));
    expect(ground(v2({ scheduling: { agreed_slot_words: null } }))).toMatchObject({ ok: false, reason: 'agreed_slot_words_missing' });
    expect(at({ hour: 'three' })).toMatchObject({ ok: false, reason: 'agreed_slot_words_mismatch' });
    expect(at({ hour: 'two thirty' })).toMatchObject({ ok: false, reason: 'agreed_slot_words_mismatch' });
    expect(at({ day: 'Friday' })).toMatchObject({ ok: false, reason: 'agreed_slot_words_mismatch' });
    expect(at({ period: 'in the morning' })).toMatchObject({ ok: false, reason: 'agreed_slot_words_mismatch' });
    // Nobody said which half of the day: not an agreed time.
    expect(at({ period: null })).toMatchObject({ ok: false, reason: 'agreed_slot_words_mismatch' });
    expect(at({ period: 'morning or afternoon' })).toMatchObject({ ok: false, reason: 'agreed_slot_words_mismatch' });
    // The same words for the slot they do state.
    expect(agreedAt('2026-09-24T10:00:00-04:00', 'We will see you Thursday at 10 AM.', { day: 'Thursday', hour: '10', period: 'AM' }).ok).toBe(true);
    // Noon and midnight state their own half of the day.
    expect(agreedAt('2026-09-24T12:00:00-04:00', 'We will see you Thursday at noon.', { day: 'Thursday', hour: 'noon', period: null }).ok).toBe(true);
    expect(agreedAt('2026-09-24T20:00:00-04:00', 'We will be there between eight and nine tonight.', { day: 'tonight', hour: 'eight', period: 'tonight' }))
      .toMatchObject({ ok: false, reason: 'agreed_slot_words_mismatch' }); // "tonight" is the call's own day, not Thursday
    expect(agreedAt('2026-09-23T20:00:00-04:00', 'We will be there between eight and nine tonight.', { day: 'tonight', hour: 'eight', period: 'tonight' }).ok).toBe(true);
  });

  // Codex #5092 r4: day words are read by the shared reschedule date grammar
  // (reschedule-date-evidence.js), abbreviations included.
  test('day words are one date the shared grammar reads, bounded by what they leave unstated', () => {
    const on = (day, slot = THURSDAY_2PM) => agreedAt(slot, `We will see you ${day} at two in the afternoon.`, { day, hour: 'two', period: 'in the afternoon' });
    for (const day of ['Thurs.', 'Thu', 'next Thursday', 'this Thursday', 'tomorrow', 'Sept. 24th', 'September 24', 'the 24th', '9/24', 'Thurs., Sept. 24']) {
      expect([day, on(day).ok]).toEqual([day, true]);
    }
    // Wrong day, not one date, or out of reach.
    for (const day of ['Friday', 'the 25th', 'Thursday or Friday', 'sometime Thursday', 'Wednesday, September 24']) {
      expect([day, on(day).reason]).toEqual([day, 'agreed_slot_words_mismatch']);
    }
    expect(on('Thursday', '2026-10-08T14:00:00-04:00').ok).toBe(false); // three weeks out: not this week or next
    expect(on('the 24th', '2026-12-24T14:00:00-05:00').ok).toBe(false); // three months out
    expect(on('December 24th', '2026-12-24T14:00:00-05:00').ok).toBe(true);
  });

  test('a weekday beside an explicit date describes that date', () => {
    const at = (text, day) => agreedAt('2026-12-17T12:00:00-05:00', text, { day, hour: 'noon', period: null });
    expect(at('We will see you Thursday, December 17 at noon.', 'Thursday, December 17').ok).toBe(true);
    expect(at('We will see you Wednesday, December 17 at noon.', 'Wednesday, December 17')).toMatchObject({ ok: false, reason: 'agreed_slot_words_mismatch' });
    // A weekday alone names only this week's or next week's.
    expect(at('We will see you Thursday at noon.', 'Thursday')).toMatchObject({ ok: false, reason: 'agreed_slot_words_mismatch' });
  });

  test('the moved appointment must be named by its recorded words in a grounded quote, and a same-day change needs no day words', () => {
    const SAME_DAY = 'We will see you at two in the afternoon instead.';
    const moved = (movedQuote, movedWords, { callerOpening = `Can you move ${movedQuote}?`, movedDate = '2026-09-24' } = {}) => ground(v2({
      scheduling: { moved_appointment_date: movedDate, moved_appointment_words: movedWords, agreed_slot_words: { day: null, hour: 'two', period: 'in the afternoon' } },
      evidence: [
        quote('/scheduling/agent_committed_booking', 'agent', SAME_DAY),
        quote('/scheduling/confirmed_start_at', 'agent', SAME_DAY),
        quote('/scheduling/caller_accepted_slot', 'caller', ACCEPT),
        quote('/scheduling/moved_appointment_date', 'caller', movedQuote),
      ],
    }), `Caller: ${callerOpening}\nAgent: ${SAME_DAY}\nCaller: ${ACCEPT}`);
    expect(moved('my September 24th visit', 'September 24th')).toEqual({ ok: true, reason: 'agreement_grounded', movedDate: '2026-09-24' });
    expect(moved('my visit tomorrow', 'tomorrow').ok).toBe(true);
    expect(moved('my September 25th visit', 'September 25th')).toMatchObject({ ok: false, reason: 'moved_appointment_ungrounded' });
    expect(moved('my September 24th visit', null)).toMatchObject({ ok: false, reason: 'moved_appointment_ungrounded' });
    expect(moved('my September 24th visit', 'the 24th')).toMatchObject({ ok: false, reason: 'moved_appointment_ungrounded' });
    expect(moved('my September 24th visit', 'September 24th', { callerOpening: 'Can you move my next visit?' }))
      .toMatchObject({ ok: false, reason: 'moved_appointment_ungrounded' });
    // With no day words, the slot must keep the moved appointment's date.
    expect(moved('my September 25th visit', 'September 25th', { movedDate: '2026-09-25' })).toMatchObject({ ok: false, reason: 'agreed_slot_words_mismatch' });
    // Without the moved appointment, slot words naming no day ground nothing.
    expect(ground(v2({ scheduling: { agreed_slot_words: { day: null, hour: 'two', period: 'in the afternoon' } } })))
      .toMatchObject({ ok: false, reason: 'agreed_slot_words_mismatch' });
  });

  // The fixtures above inject the fields; this pins them to the stored V2
  // contract (schema 1.17.0), where a rename on either side would silently
  // skip every automatic move.
  test('it reads the scheduling fields and evidence speakers the stored V2 extraction defines', () => {
    const schema = require('../schemas/call-extraction.persisted.schema.json');
    const fields = schema.properties.scheduling.properties;
    expect(fields).toMatchObject({
      agent_committed_booking: { type: ['boolean', 'null'] },
      caller_accepted_slot: { type: ['boolean', 'null'] },
      confirmed_start_at: { format: 'date-time' },
      moved_appointment_date: { format: 'date' },
    });
    expect(fields.moved_appointment_words).toBeDefined();
    expect(Object.keys(fields.agreed_slot_words.properties || fields.agreed_slot_words.anyOf?.find((b) => b.properties)?.properties || {}).sort())
      .toEqual(['day', 'hour', 'period']);
    expect(schema.properties.evidence.items.properties.speaker.enum).toEqual(['caller', 'agent']);
  });

  test('an unlabeled or one-sided transcript, or an unreadable slot, fails closed', () => {
    expect(ground(v2(), COMMIT)).toMatchObject({ ok: false, reason: 'unparseable_transcript' });
    expect(ground(v2(), `Agent: ${COMMIT}`)).toMatchObject({ ok: false, reason: 'unparseable_transcript' });
    expect(ground(v2({ scheduling: { confirmed_start_at: 'not-a-time' } }))).toMatchObject({ ok: false, reason: 'unparseable_slot' });
    expect(groundRescheduleAgreement({ v2: v2(), transcript: TRANSCRIPT, callStartedAt: 'nope' })).toMatchObject({ ok: false, reason: 'unparseable_slot' });
  });
});
