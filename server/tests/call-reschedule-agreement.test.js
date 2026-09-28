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

  // Codex #5092 r6: the sentences a quote sits in are screened with the
  // booking check's negation/hedge and condition screens.
  test('a quote from a negated, hedged or conditional sentence does not ground', () => {
    const said = (agentLine, callerLine, { commit = 'see you Thursday at two in the afternoon', accept = 'Thursday at two works for me' } = {}) => ground(v2({ evidence: [
      quote('/scheduling/agent_committed_booking', 'agent', commit),
      quote('/scheduling/confirmed_start_at', 'agent', commit),
      quote('/scheduling/caller_accepted_slot', 'caller', accept),
    ] }), `Caller: Can we move my visit?\nAgent: ${agentLine}\nCaller: ${callerLine}`);
    const OK_CALLER = 'Thursday at two works for me.';
    expect(said('We will not see you Thursday at two in the afternoon.', OK_CALLER)).toMatchObject({ ok: false, reason: 'agent_commitment_ungrounded' });
    expect(said('If the tech is free we will see you Thursday at two in the afternoon.', OK_CALLER)).toMatchObject({ ok: false, reason: 'agent_commitment_ungrounded' });
    expect(said('We will see you Thursday at two in the afternoon.', 'Thursday at two works for me, but actually no it does not.'))
      .toMatchObject({ ok: false, reason: 'caller_acceptance_ungrounded' });
    // Codex #5092 r8: a question is not a commitment or an acceptance.
    expect(said('Will we see you Thursday at two in the afternoon?', OK_CALLER)).toMatchObject({ ok: false, reason: 'agent_commitment_ungrounded' });
    // A caller may ask for exactly the slot the agent then commits to.
    expect(said('We will see you Thursday at two in the afternoon.', 'Can you do Thursday at two?', { accept: 'Can you do Thursday at two' }).ok).toBe(true);
    // Codex #5092 r12: "p.m." ending a sentence keeps the boundary.
    const PM_LINE = 'We will see you Thursday at two p.m. Do not forget to unlock the gate.';
    expect(ground(v2({
      scheduling: { agreed_slot_words: { day: 'Thursday', hour: 'two', period: 'p.m.' } },
      evidence: [
        quote('/scheduling/agent_committed_booking', 'agent', 'We will see you Thursday at two p.m.'),
        quote('/scheduling/confirmed_start_at', 'agent', 'We will see you Thursday at two p.m.'),
        quote('/scheduling/caller_accepted_slot', 'caller', OK_CALLER),
      ],
    }), `Caller: Can we move my visit?\nAgent: ${PM_LINE}\nCaller: ${OK_CALLER}`).ok).toBe(true);
    // Another sentence of the turn is not screened: "No worries." does not void it.
    expect(said('No worries. We will see you Thursday at two in the afternoon.', `Great. ${OK_CALLER}`).ok).toBe(true);
  });

  // Codex #5092 r15: the agent's commitment must be to the recorded slot.
  test('the agent commitment quote must say the slot\'s hour and day', () => {
    const committed = (commit) => ground(v2({ evidence: [
      quote('/scheduling/agent_committed_booking', 'agent', commit),
      quote('/scheduling/confirmed_start_at', 'caller', 'Thursday at two in the afternoon works for me'),
      quote('/scheduling/caller_accepted_slot', 'caller', 'Thursday at two in the afternoon works for me'),
    ] }), `Caller: Thursday at two in the afternoon works for me.\nAgent: ${commit}.`);
    expect(committed('We will see you Friday at three')).toMatchObject({ ok: false, reason: 'agent_commitment_not_the_slot' });
    expect(committed('Okay we will see you then')).toMatchObject({ ok: false, reason: 'agent_commitment_not_the_slot' });
    expect(committed('We will see you Thursday at two AM')).toMatchObject({ ok: false, reason: 'agent_commitment_not_the_slot' });
    expect(ground(v2({ evidence: [
      quote('/scheduling/agent_committed_booking', 'agent', 'We will see you Thursday at two'),
      quote('/scheduling/confirmed_start_at', 'caller', 'Thursday at two in the afternoon works for me'),
      quote('/scheduling/caller_accepted_slot', 'caller', 'Thursday at two in the afternoon works for me'),
    ] }), 'Caller: Thursday at two in the afternoon works for me.\nAgent: We will see you Thursday at two AM.'))
      .toMatchObject({ ok: false, reason: 'agent_commitment_not_the_slot' });
    expect(committed('Great, we will see you Thursday at two').ok).toBe(true);
    expect(committed('Great, we will see you Thursday at two PM').ok).toBe(true);
    // Codex #5092 r16: "minutes before" is a minute count too.
    expect(committed('We will see you Thursday at five minutes before two')).toMatchObject({ ok: false, reason: 'agent_commitment_not_the_slot' });
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
    // No period recorded while the quote does say one: the recorded words
    // do not match what was said.
    expect(at({ period: null })).toMatchObject({ ok: false, reason: 'agreed_slot_ungrounded' });
    expect(at({ period: 'morning or afternoon' })).toMatchObject({ ok: false, reason: 'agreed_slot_words_mismatch' });
    // The same words for the slot they do state.
    expect(agreedAt('2026-09-24T10:00:00-04:00', 'We will see you Thursday at 10 AM.', { day: 'Thursday', hour: '10', period: 'AM' }).ok).toBe(true);
    // Noon and midnight state their own half of the day.
    expect(agreedAt('2026-09-24T12:00:00-04:00', 'We will see you Thursday at noon.', { day: 'Thursday', hour: 'noon', period: null }).ok).toBe(true);
    expect(agreedAt('2026-09-24T20:00:00-04:00', 'We will be there between eight and nine tonight.', { day: 'tonight', hour: 'eight', period: 'tonight' }))
      .toMatchObject({ ok: false, reason: 'agreed_slot_words_mismatch' }); // "tonight" is the call's own day, not Thursday
    expect(agreedAt('2026-09-23T20:00:00-04:00', 'We will be there tonight between eight and nine.', { day: 'tonight', hour: 'eight', period: 'tonight' }).ok).toBe(true);
    // A period said only after the window's end cannot be told from one
    // belonging to the end ("between 10 and 2 PM"), so it fails closed.
    expect(agreedAt('2026-09-23T20:00:00-04:00', 'We will be there between eight and nine tonight.', { day: 'tonight', hour: 'eight', period: 'tonight' }))
      .toMatchObject({ ok: false, reason: 'agreed_slot_ungrounded' });
    // Codex #5092 r5: "this evening" is the call's day, and a window ending at
    // noon puts its start in the morning.
    expect(agreedAt('2026-09-23T18:00:00-04:00', 'We can come by at six this evening.', { day: 'this evening', hour: 'six', period: 'this evening' }).ok).toBe(true);
    // Codex #5092 r10: punctuation kept in the recorded words.
    expect(agreedAt('2026-09-23T18:00:00-04:00', 'We can come by at six this evening.', { day: 'this evening.', hour: 'six', period: 'this evening.' }).ok).toBe(true);
    expect(agreedAt('2026-09-24T10:00:00-04:00', 'We will be there between 10 and noon tomorrow.', { day: 'tomorrow', hour: '10', period: 'noon' }).ok).toBe(true);
    expect(agreedAt('2026-09-24T22:00:00-04:00', 'We will be there between 10 and noon tomorrow.', { day: 'tomorrow', hour: '10', period: 'noon' }))
      .toMatchObject({ ok: false, reason: 'agreed_slot_words_mismatch' });
    // Codex #5092 r7: "12 noon" is noon, not a window ending at noon.
    expect(agreedAt('2026-09-24T12:00:00-04:00', 'We will see you tomorrow at 12 noon.', { day: 'tomorrow', hour: '12', period: 'noon' }).ok).toBe(true);
    expect(agreedAt('2026-09-24T12:00:00-04:00', 'We will see you tomorrow at twelve noon.', { day: 'tomorrow', hour: 'twelve', period: 'noon' }).ok).toBe(true);
    expect(agreedAt('2026-09-24T00:00:00-04:00', 'We will see you tomorrow at 12 noon.', { day: 'tomorrow', hour: '12', period: 'noon' }))
      .toMatchObject({ ok: false, reason: 'agreed_slot_words_mismatch' });
    // Codex #5092 r11: period words are one whole phrase from a closed list,
    // and belong to the recorded hour (no other hour between them).
    expect(agreedAt(THURSDAY_2PM, 'We will see you Thursday at two pm-ish.', { day: 'Thursday', hour: 'two', period: 'pm-ish' }))
      .toMatchObject({ ok: false, reason: 'agreed_slot_words_mismatch' });
    expect(agreedAt('2026-09-24T22:00:00-04:00', 'We will be there Thursday between 10 and 2 PM.', { day: 'Thursday', hour: '10', period: 'PM' }))
      .toMatchObject({ ok: false, reason: 'agreed_slot_ungrounded' });
    expect(agreedAt('2026-09-24T10:00:00-04:00', 'We will be there Thursday between 10 and 2 PM.', { day: 'Thursday', hour: '10', period: 'PM' }))
      .toMatchObject({ ok: false, reason: 'agreed_slot_words_mismatch' });
    expect(agreedAt(THURSDAY_2PM, 'We will see you Thursday afternoon at two.', { day: 'Thursday', hour: 'two', period: 'afternoon' }).ok).toBe(true);
    expect(agreedAt(THURSDAY_2PM, 'We will see you Thursday at 2:00 PM.', { day: 'Thursday', hour: '2', period: 'PM' }).ok).toBe(true);
    // Codex #5092 r14: minutes on either side of the hour never ground it.
    for (const said of ['Thursday at two thirty PM', 'Thursday at 2 15 PM', 'Thursday at two oh five PM', 'Thursday at quarter past two PM', 'Thursday at ten to two PM']) {
      expect([said, agreedAt(THURSDAY_2PM, `We will see you ${said}.`, { day: 'Thursday', hour: said.includes(' 2 ') ? '2' : 'two', period: 'PM' }).reason])
        .toEqual([said, 'agreed_slot_ungrounded']);
    }
    expect(agreedAt(THURSDAY_2PM, 'We will move it to two PM Thursday.', { day: 'Thursday', hour: 'two', period: 'PM' }).ok).toBe(true);
    expect(agreedAt(THURSDAY_2PM, 'We will see you Thursday at ten minutes to two PM.', { day: 'Thursday', hour: 'two', period: 'PM' }))
      .toMatchObject({ ok: false, reason: 'agreed_slot_ungrounded' });
    // Codex #5092 r15: a minute word right before the hour, and a part of the
    // day that does not contain the hour.
    expect(agreedAt(THURSDAY_2PM, 'We will see you Thursday at half two in the afternoon.', { day: 'Thursday', hour: 'two', period: 'in the afternoon' }))
      .toMatchObject({ ok: false, reason: 'agreed_slot_ungrounded' });
    expect(agreedAt(THURSDAY_2PM, 'We will see you Thursday at two at night.', { day: 'Thursday', hour: 'two', period: 'at night' }))
      .toMatchObject({ ok: false, reason: 'agreed_slot_words_mismatch' });
    expect(agreedAt('2026-09-24T20:00:00-04:00', 'We will see you Thursday at eight at night.', { day: 'Thursday', hour: 'eight', period: 'at night' }).ok).toBe(true);
    // Codex #5092 r13: twelve with a part of the day states no hour; with am/pm it does.
    expect(agreedAt('2026-09-23T12:00:00-04:00', 'We will see you at 12 tonight.', { day: 'tonight', hour: '12', period: 'tonight' }))
      .toMatchObject({ ok: false, reason: 'agreed_slot_words_mismatch' });
    expect(agreedAt('2026-09-24T12:00:00-04:00', 'We will see you tomorrow at 12 pm.', { day: 'tomorrow', hour: '12', period: 'pm' }).ok).toBe(true);
    // Codex #5092 r12: clock-formatted twelve.
    expect(agreedAt('2026-09-24T12:00:00-04:00', 'We will see you tomorrow at 12:00 noon.', { day: 'tomorrow', hour: '12', period: 'noon' }).ok).toBe(true);
    // Codex #5092 r9: twelve beside a window's named end is not "12 midnight".
    expect(agreedAt('2026-09-24T00:00:00-04:00', 'We will be there between 12 and midnight tomorrow.', { day: 'tomorrow', hour: '12', period: 'midnight' }))
      .toMatchObject({ ok: false, reason: 'agreed_slot_ungrounded' });
  });

  // Codex #5092 r4: day words are read by the shared reschedule date grammar
  // (reschedule-date-evidence.js), abbreviations included.
  test('day words are one date the shared grammar reads, bounded by what they leave unstated', () => {
    const on = (day, slot = THURSDAY_2PM) => agreedAt(slot, `We will see you ${day} at two in the afternoon.`, { day, hour: 'two', period: 'in the afternoon' });
    // Codex #5092 r16: "the day after tomorrow".
    expect(on('the day after tomorrow', '2026-09-25T14:00:00-04:00').ok).toBe(true);
    expect(on('the day after tomorrow').ok).toBe(false);
    for (const day of ['Thurs.', 'Thu', 'this Thursday', 'tomorrow', 'Sept. 24th', 'September 24', 'the 24th', '9/24', 'Thurs., Sept. 24']) {
      expect([day, on(day).ok]).toEqual([day, true]);
    }
    // Wrong day, not one date, or two dates ("next Thursday").
    for (const day of ['Friday', 'the 25th', 'Thursday or Friday', 'sometime Thursday', 'Wednesday, September 24', 'next Thursday']) {
      expect([day, on(day).reason]).toEqual([day, 'agreed_slot_words_mismatch']);
    }
    // Codex #5092 r8: day words name the NEXT date that fits, never a later one.
    expect(on('Thursday', '2026-10-01T14:00:00-04:00').ok).toBe(false); // a week after the next Thursday
    expect(on('the 24th', '2026-10-24T14:00:00-04:00').ok).toBe(false); // September 24 is still ahead
    expect(on('the 1st', '2026-10-01T14:00:00-04:00').ok).toBe(true);
    expect(on('the 1st', '2026-12-01T14:00:00-05:00').ok).toBe(false);
    expect(on('December 24th', '2026-12-24T14:00:00-05:00').ok).toBe(true);
    expect(on('September 22nd', '2027-09-22T14:00:00-04:00').ok).toBe(true); // passed this year: next year's
  });

  test('a day of the month skips months that lack it', () => {
    // Codex #5092 r9: said on January 31, "the 30th" is March 30.
    const jan31 = (day, slot) => groundRescheduleAgreement({
      v2: v2({ scheduling: { confirmed_start_at: slot, agreed_slot_words: { day, hour: 'two', period: 'in the afternoon' } }, evidence: [
        quote('/scheduling/agent_committed_booking', 'agent', `We will see you ${day} at two in the afternoon.`),
        quote('/scheduling/confirmed_start_at', 'agent', `We will see you ${day} at two in the afternoon.`),
        quote('/scheduling/caller_accepted_slot', 'caller', ACCEPT),
      ] }),
      transcript: `Caller: Can we move my visit?\nAgent: We will see you ${day} at two in the afternoon.\nCaller: ${ACCEPT}`,
      callStartedAt: '2027-01-31T15:00:00Z',
    });
    expect(jan31('the 30th', '2027-03-30T14:00:00-04:00').ok).toBe(true);
    expect(jan31('the 30th', '2027-02-28T14:00:00-05:00').ok).toBe(false);
    // Codex #5092 r10: "February 29" waits for the next leap year.
    expect(jan31('February 29th', '2028-02-29T14:00:00-05:00').ok).toBe(true);
  });

  // Owner decision 2026-09-28: a reschedule's hour said with no AM/PM reads
  // as business hours (7-11 morning, 12 and 1-6 afternoon).
  test('an hour said without AM/PM reads as business hours', () => {
    const plain = (slot, text, hour) => agreedAt(slot, text, { day: 'Thursday', hour, period: null });
    expect(plain(THURSDAY_2PM, 'We will move it to Thursday, 2 to 4.', '2').ok).toBe(true);
    expect(plain('2026-09-24T02:00:00-04:00', 'We will move it to Thursday, 2 to 4.', '2')).toMatchObject({ ok: false, reason: 'agreed_slot_words_mismatch' });
    expect(plain('2026-09-24T10:00:00-04:00', 'We will see you Thursday at ten.', 'ten').ok).toBe(true);
    expect(plain('2026-09-24T12:00:00-04:00', 'We will see you Thursday at twelve.', 'twelve').ok).toBe(true);
    // Outside business hours an unstated hour states nothing.
    expect(plain('2026-09-24T20:00:00-04:00', 'We will see you Thursday at eight.', 'eight')).toMatchObject({ ok: false, reason: 'agreed_slot_words_mismatch' });
    expect(plain('2026-09-24T08:00:00-04:00', 'We will see you Thursday at eight.', 'eight').ok).toBe(true);
    expect(plain('2026-09-24T11:00:00-04:00', 'We will be there Thursday between 11 and midnight.', '11')).toMatchObject({ ok: false, reason: 'agreed_slot_ungrounded' });
    // Codex #5163 r1: "in the a.m." is a period; a part of the day describing
    // the old appointment is not.
    expect(plain(THURSDAY_2PM, 'We will move it to Thursday at two in the a.m.', 'two')).toMatchObject({ ok: false, reason: 'agreed_slot_ungrounded' });
    expect(plain(THURSDAY_2PM, 'I will move your morning appointment to Thursday at two.', 'two').ok).toBe(true);
    // "Am" the verb is not a period.
    expect(plain(THURSDAY_2PM, 'I am moving you to Thursday at two.', 'two').ok).toBe(true);
    // Nor one said just past the end of the quote, in the same sentence.
    expect(ground(v2({
      scheduling: { agreed_slot_words: { day: 'Thursday', hour: 'two', period: null } },
      evidence: [
        quote('/scheduling/agent_committed_booking', 'agent', 'We will see you Thursday at two'),
        quote('/scheduling/confirmed_start_at', 'agent', 'We will see you Thursday at two'),
        quote('/scheduling/caller_accepted_slot', 'caller', ACCEPT),
      ],
    }), `Caller: Can we move my visit?\nAgent: We will see you Thursday at two in the morning.\nCaller: ${ACCEPT}`))
      .toMatchObject({ ok: false, reason: 'agreed_slot_ungrounded' });
    // A period said in the quote but not recorded never falls back.
    expect(plain(THURSDAY_2PM, 'We will see you Thursday at two in the morning.', 'two')).toMatchObject({ ok: false, reason: 'agreed_slot_ungrounded' });
  });

  test('a weekday beside an explicit date describes that date', () => {
    const at = (text, day) => agreedAt('2026-12-17T12:00:00-05:00', text, { day, hour: 'noon', period: null });
    expect(at('We will see you Thursday, December 17 at noon.', 'Thursday, December 17').ok).toBe(true);
    expect(at('We will see you Wednesday, December 17 at noon.', 'Wednesday, December 17')).toMatchObject({ ok: false, reason: 'agreed_slot_words_mismatch' });
    // A weekday alone names only this week's or next week's.
    expect(at('We will see you Thursday at noon.', 'Thursday')).toMatchObject({ ok: false, reason: 'agreed_slot_words_mismatch' });
  });

  test('the moved appointment must be named by its recorded words in a grounded quote, and a same-day change needs no day words', () => {
    const SAME_DAY = 'We will see you at two in the afternoon then.';
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
    // Codex #5092 r8: a negated moved-date sentence does not name the visit to move.
    expect(moved('my September 24th visit', 'September 24th', { callerOpening: 'Do not move my September 24th visit.' }))
      .toMatchObject({ ok: false, reason: 'moved_appointment_ungrounded' });
    // Codex #5092 r16: a same-day commitment must name no other day.
    const SAME_DAY_OTHER = 'We will see you Friday at two in the afternoon.';
    const sameDayCommit = (commit) => ground(v2({
      scheduling: { moved_appointment_date: '2026-09-24', moved_appointment_words: 'September 24th', agreed_slot_words: { day: null, hour: 'two', period: 'in the afternoon' } },
      evidence: [
        quote('/scheduling/agent_committed_booking', 'agent', commit),
        quote('/scheduling/confirmed_start_at', 'caller', 'Two in the afternoon works for me'),
        quote('/scheduling/caller_accepted_slot', 'caller', 'Two in the afternoon works for me'),
        quote('/scheduling/moved_appointment_date', 'caller', 'my September 24th visit'),
      ],
    }), `Caller: Can you move my September 24th visit? Two in the afternoon works for me.\nAgent: ${commit}`);
    expect(sameDayCommit(SAME_DAY_OTHER)).toMatchObject({ ok: false, reason: 'agent_commitment_not_the_slot' });
    expect(sameDayCommit('Okay, we will mark it for two in the afternoon.').ok).toBe(true);
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
