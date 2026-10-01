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
      // The extraction's own language judgements (schema 1.20.0).
      definite_commitment: true, relative_date_used: false, moved_appointment_relative_date_used: false,
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
    expect(committed('We will see you Thursday at two sharp a.m')).toMatchObject({ ok: false, reason: 'agent_commitment_not_the_slot' });
    expect(committed('I am seeing you Thursday at two')).toMatchObject({ ok: true });
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
    // Codex #5163 r1: "in the a.m." is a period.
    expect(plain(THURSDAY_2PM, 'We will move it to Thursday at two in the a.m.', 'two')).toMatchObject({ ok: false, reason: 'agreed_slot_ungrounded' });
    // "Morning appointment" may be the old visit or the new one: fails closed.
    expect(plain(THURSDAY_2PM, 'I will move your morning appointment to Thursday at two.', 'two')).toMatchObject({ ok: false, reason: 'agreed_slot_ungrounded' });
    // Codex #5163 r2: any sign of a period in the agreement's sentences, the
    // caller's acceptance included, blocks the fallback; zero minutes too.
    expect(plain(THURSDAY_2PM, 'We will move it to Thursday at two sharp a.m.', 'two')).toMatchObject({ ok: false, reason: 'agreed_slot_ungrounded' });
    expect(plain(THURSDAY_2PM, 'We will move it to Thursday at two a m.', 'two')).toMatchObject({ ok: false, reason: 'agreed_slot_ungrounded' });
    expect(plain(THURSDAY_2PM, 'We will move it to Thursday at two o five.', 'two')).toMatchObject({ ok: false, reason: 'agreed_slot_ungrounded' });
    expect(plain(THURSDAY_2PM, 'We will move it to Thursday at two o clock.', 'two').ok).toBe(true);
    expect(plain(THURSDAY_2PM, 'I really am moving you to Thursday at two, a tech will call.', 'two').ok).toBe(true);
    expect(ground(v2({
      scheduling: { agreed_slot_words: { day: 'Thursday', hour: 'two', period: null } },
      evidence: [
        quote('/scheduling/agent_committed_booking', 'agent', 'We will see you Thursday at two'),
        quote('/scheduling/confirmed_start_at', 'agent', 'We will see you Thursday at two'),
        quote('/scheduling/caller_accepted_slot', 'caller', 'Yes, Thursday at two AM works for me'),
      ],
    }), 'Caller: Can we move my visit?\nAgent: We will see you Thursday at two.\nCaller: Yes, Thursday at two AM works for me.'))
      .toMatchObject({ ok: false, reason: 'agreed_slot_ungrounded' });
    // Codex #5163 r3: "I mean a.m." / "I said AM" / "I prefer AM" are the morning.
    for (const said of ['We will move it to Thursday at two, I mean a.m.', 'We will move it to Thursday at two, I said AM.', 'I prefer AM, we will move it to Thursday at two.']) {
      expect([said, plain(THURSDAY_2PM, said, 'two').reason]).toEqual([said, 'agreed_slot_ungrounded']);
    }
    // Codex #5163 r4: only an exact hour takes the business-hours reading.
    for (const said of ['We will move it to Thursday around two.', 'We will move it to Thursday by two.', 'We will move it to Thursday at two or four.', 'We will move it to Thursday at 02:00.']) {
      expect([said, plain(THURSDAY_2PM, said, said.includes('02') ? '02' : 'two').ok]).toEqual([said, false]);
    }
    expect(plain(THURSDAY_2PM, 'We will move it to Thursday between two and four.', 'two').ok).toBe(true);
    expect(plain(THURSDAY_2PM, 'We will move it to Thursday at 2:00.', '2').ok).toBe(true);
    // Codex #5163 r5: nothing after the hour may correct it or offer another,
    // and a month's day number is never the hour.
    for (const said of ['We will move it to Thursday at two, actually three.', 'We will move it to Thursday at two, or four.', 'We will move it to Thursday at two sharp or four.']) {
      expect([said, plain(THURSDAY_2PM, said, 'two').ok]).toEqual([said, false]);
    }
    expect(agreedAt('2027-03-02T14:00:00-05:00', 'We will move it to March 2.', { day: 'March 2', hour: '2', period: null }).ok).toBe(false);
    // Codex #5163 r6: doubt or a length after the hour, and an unrecorded "next".
    for (const said of ['We will see you Thursday at two, I think.', 'We will see you Thursday at two, approximately.', 'The treatment on Thursday is for two to four hours.']) {
      expect([said, plain(THURSDAY_2PM, said, 'two').ok]).toEqual([said, false]);
    }
    expect(plain(THURSDAY_2PM, 'We will move you to two next Thursday.', 'two').ok).toBe(false);
    expect(plain(THURSDAY_2PM, 'We will see you Thursday at two, thanks so much.', 'two').ok).toBe(true);
    expect(plain(THURSDAY_2PM, 'We will see you Thursday at two, thank you, have a great day.', 'two').ok).toBe(true);
    expect(plain(THURSDAY_2PM, 'We will move it to Thursday at 2:00 or 4:00.', '2').ok).toBe(false);
    // A quote cut short before a qualifier is judged by its whole turn.
    expect(ground(v2({
      scheduling: { agreed_slot_words: { day: 'Thursday', hour: 'two', period: null } },
      evidence: [
        quote('/scheduling/agent_committed_booking', 'agent', 'We will move it to Thursday at two'),
        quote('/scheduling/confirmed_start_at', 'agent', 'We will move it to Thursday at two'),
        quote('/scheduling/caller_accepted_slot', 'caller', ACCEPT),
      ],
    }), `Caller: Can we move my visit?\nAgent: We will move it to Thursday at two or four.\nCaller: ${ACCEPT}`).ok).toBe(false);
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

  // Follow-ups after #5163 (owner go-ahead 2026-09-28): three wrong-move
  // closures and three loosenings measured on the 20-call replay.
  test('follow-ups: relative weeks, alternatives before the hour, and inexact commitments fail', () => {
    const plainDay = (text, words, slot = THURSDAY_2PM) => agreedAt(slot, text, words);
    const thu = { day: 'Thursday', hour: 'two', period: null };
    expect(plainDay('We will move you to Thursday a week from now at two.', thu).ok).toBe(false);
    expect(plainDay('We will move you to the following Thursday at two.', thu).ok).toBe(false);
    expect(plainDay('We will see you at three or Thursday at two.', thu).ok).toBe(false);
    expect(plainDay('We will see you either Thursday at two.', thu).ok).toBe(false);
    // The agent's own commitment must say the unstated hour exactly.
    expect(ground(v2({
      scheduling: { agreed_slot_words: thu },
      evidence: [
        quote('/scheduling/agent_committed_booking', 'agent', 'We should arrive around Thursday at two'),
        quote('/scheduling/confirmed_start_at', 'caller', 'Thursday at two, please'),
        quote('/scheduling/caller_accepted_slot', 'caller', 'Thursday at two, please'),
      ],
    }), 'Caller: Thursday at two, please.\nAgent: We should arrive around Thursday at two.')).toMatchObject({ ok: false });
  });

  test('follow-ups: real phrasings that now ground', () => {
    // A courtesy word right after the hour, and a date whose number equals the hour.
    expect(agreedAt(THURSDAY_2PM, 'Thursday at two is perfect.', { day: 'Thursday', hour: 'two', period: null }).ok).toBe(true);
    expect(agreedAt('2026-10-10T10:00:00-04:00', 'We will move it to October 10 at 10.', { day: 'October 10', hour: '10', period: null }).ok).toBe(true);
    // The agent need not repeat the day the caller named; "9 o'clock" needs no lead word.
    const nine = { day: 'tomorrow', hour: '9', period: null };
    expect(ground(v2({
      scheduling: { confirmed_start_at: '2026-09-24T09:00:00-04:00', agreed_slot_words: nine },
      evidence: [
        quote('/scheduling/agent_committed_booking', 'agent', "Yep, we'll see them at 9."),
        quote('/scheduling/confirmed_start_at', 'caller', "Okay, 9 o'clock tomorrow"),
        quote('/scheduling/caller_accepted_slot', 'caller', "Okay, 9 o'clock tomorrow. I'll let them know."),
      ],
    }), "Caller: Can we make it earlier?\nAgent: Yep, we'll see them at 9.\nCaller: Okay, 9 o'clock tomorrow. I'll let them know.").ok).toBe(true);
    // A relative day in the commitment is a day, and must be the recorded one.
    expect(ground(v2({
      scheduling: { confirmed_start_at: '2026-09-24T09:00:00-04:00', agreed_slot_words: nine },
      evidence: [
        quote('/scheduling/agent_committed_booking', 'agent', "We'll see them in two days at 9."),
        quote('/scheduling/confirmed_start_at', 'caller', "Okay, 9 o'clock tomorrow"),
        quote('/scheduling/caller_accepted_slot', 'caller', "Okay, 9 o'clock tomorrow"),
      ],
    }), "Caller: Okay, 9 o'clock tomorrow.\nAgent: We'll see them in two days at 9.")).toMatchObject({ ok: false });
    for (const commit of ["We'll see them May 3 at 9.", "We'll see them 9/25 at 9."]) {
      expect([commit, ground(v2({
        scheduling: { confirmed_start_at: '2026-09-24T09:00:00-04:00', agreed_slot_words: nine },
        evidence: [
          quote('/scheduling/agent_committed_booking', 'agent', commit),
          quote('/scheduling/confirmed_start_at', 'caller', "Okay, 9 o'clock tomorrow"),
          quote('/scheduling/caller_accepted_slot', 'caller', "Okay, 9 o'clock tomorrow"),
        ],
      }), `Caller: Okay, 9 o'clock tomorrow.\nAgent: ${commit}`).ok]).toEqual([commit, false]);
    }
    // A bound before "o'clock" is still a bound.
    for (const said of ["We will be there tomorrow before 9 o'clock.", "We will be there tomorrow by 9 o'clock."]) {
      expect([said, agreedAt('2026-09-24T09:00:00-04:00', said, { day: 'tomorrow', hour: '9', period: null }).ok]).toEqual([said, false]);
    }
    // A day the agent does name must be the recorded one.
    expect(ground(v2({
      scheduling: { agreed_slot_words: { day: 'Thursday', hour: 'two', period: null } },
      evidence: [
        quote('/scheduling/agent_committed_booking', 'agent', 'We will see you Friday at two'),
        quote('/scheduling/confirmed_start_at', 'caller', 'Thursday at two, please'),
        quote('/scheduling/caller_accepted_slot', 'caller', 'Thursday at two, please'),
      ],
    }), 'Caller: Thursday at two, please.\nAgent: We will see you Friday at two.')).toMatchObject({ ok: false, reason: 'agent_commitment_not_the_slot' });
    // An agent's leading "No," answering the caller is not a refusal.
    expect(agreedAt('2026-09-24T12:00:00-04:00', 'No, we will just pop in Thursday at noon.', { day: 'Thursday', hour: 'noon', period: null }).ok).toBe(true);
    expect(agreedAt('2026-09-24T12:00:00-04:00', 'No, we will not come Thursday at noon.', { day: 'Thursday', hour: 'noon', period: null }).ok).toBe(false);
  });

  test('follow-ups: an availability phrase names the visit to move; "do not move" still fails', () => {
    const SAME = 'We will see you at two in the afternoon then.';
    const moved = (callerLine, movedQuote) => ground(v2({
      scheduling: { moved_appointment_date: '2026-09-24', moved_appointment_words: 'tomorrow', agreed_slot_words: { day: null, hour: 'two', period: 'in the afternoon' } },
      evidence: [
        quote('/scheduling/agent_committed_booking', 'agent', SAME),
        quote('/scheduling/confirmed_start_at', 'agent', SAME),
        quote('/scheduling/caller_accepted_slot', 'caller', ACCEPT),
        quote('/scheduling/moved_appointment_date', 'caller', movedQuote),
      ],
    }), `Caller: ${callerLine}\nAgent: ${SAME}\nCaller: ${ACCEPT}`);
    expect(moved("We're not going to be home tomorrow morning.", "We're not going to be home tomorrow").ok).toBe(true);
    expect(moved("I can't make it tomorrow.", "I can't make it tomorrow").ok).toBe(true);
    expect(moved('Do not move my visit tomorrow.', 'Do not move my visit tomorrow')).toMatchObject({ ok: false, reason: 'moved_appointment_ungrounded' });
  });

  // Codex #5207 r1: each loosening kept to its own case.
  test('follow-ups r1: loosenings do not reach past their case', () => {
    const thu = { day: 'Thursday', hour: 'two', period: null };
    // A leading "No," only before "we'll"/"I'll".
    expect(agreedAt(THURSDAY_2PM, 'No, Thursday at two PM.', { day: 'Thursday', hour: 'two', period: 'PM' }).ok).toBe(false);
    // "9 o'clock" without a lead only at a clause start or after a plain yes.
    expect(agreedAt('2026-09-24T09:00:00-04:00', "Avoid 9 o'clock Thursday.", { day: 'Thursday', hour: '9', period: null }).ok).toBe(false);
    expect(agreedAt('2026-09-24T09:00:00-04:00', "Okay, 9 o'clock Thursday.", { day: 'Thursday', hour: '9', period: null }).ok).toBe(true);
    // The agent's "let me know" / "I will let you know" is not a booking.
    expect(agreedAt(THURSDAY_2PM, 'Thursday at two, let me know.', thu).ok).toBe(false);
    // A same-day commitment may end "have a nice day".
    const SAME = 'We will see you at two PM, have a nice day.';
    expect(ground(v2({
      scheduling: { moved_appointment_date: '2026-09-24', moved_appointment_words: 'September 24th', agreed_slot_words: { day: null, hour: 'two', period: 'PM' } },
      evidence: [
        quote('/scheduling/agent_committed_booking', 'agent', SAME),
        quote('/scheduling/confirmed_start_at', 'agent', SAME),
        quote('/scheduling/caller_accepted_slot', 'caller', ACCEPT),
        quote('/scheduling/moved_appointment_date', 'caller', 'my September 24th visit'),
      ],
    }), `Caller: Can you move my September 24th visit?\nAgent: ${SAME}\nCaller: ${ACCEPT}`).ok).toBe(true);
    // "now" is not a plain commitment word.
    expect(ground(v2({
      scheduling: { confirmed_start_at: '2026-09-24T09:00:00-04:00', agreed_slot_words: { day: 'tomorrow', hour: '9', period: null } },
      evidence: [
        quote('/scheduling/agent_committed_booking', 'agent', "We'll see you now at 9."),
        quote('/scheduling/confirmed_start_at', 'caller', "Okay, 9 o'clock tomorrow"),
        quote('/scheduling/caller_accepted_slot', 'caller', "Okay, 9 o'clock tomorrow"),
      ],
    }), "Caller: Okay, 9 o'clock tomorrow.\nAgent: We'll see you now at 9.")).toMatchObject({ ok: false });
    // An availability phrase must govern the moved visit, with no "but".
    const movedFri = (callerLine, movedQuote) => ground(v2({
      scheduling: { moved_appointment_date: '2026-09-25', moved_appointment_words: 'Friday', agreed_slot_words: thu },
      evidence: [
        quote('/scheduling/agent_committed_booking', 'agent', 'We will see you Thursday at two'),
        quote('/scheduling/confirmed_start_at', 'agent', 'We will see you Thursday at two'),
        quote('/scheduling/caller_accepted_slot', 'caller', ACCEPT),
        quote('/scheduling/moved_appointment_date', 'caller', movedQuote),
      ],
    }), `Caller: ${callerLine}\nAgent: We will see you Thursday at two.\nCaller: ${ACCEPT}`);
    expect(movedFri("I'm not going to be home tomorrow, but my appointment is Friday.", 'my appointment is Friday')).toMatchObject({ ok: false, reason: 'moved_appointment_ungrounded' });
    expect(movedFri("I'm not going to be home Friday.", "I'm not going to be home Friday").ok).toBe(true);
    // Codex #5207 r2.
    expect(movedFri("I'm not home tomorrow, but Friday works.", 'but Friday works')).toMatchObject({ ok: false, reason: 'moved_appointment_ungrounded' });
    expect(agreedAt(THURSDAY_2PM, 'No, we will see you Thursday at two PM or Friday at three PM.', { day: 'Thursday', hour: 'two', period: 'PM' }).ok).toBe(false);
    expect(agreedAt('2026-09-24T09:00:00-04:00', "We'll see you tomorrow at 9, right.", { day: 'tomorrow', hour: '9', period: null }).ok).toBe(false);
    expect(agreedAt('2026-10-10T09:00:00-04:00', "We'll see you at 9 for your 10th appointment.", { day: '10th', hour: '9', period: null }).ok).toBe(false);
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
  // Owner direction 2026-09-30 (schema 1.20.0, prompt v19): word lists judging
  // free conversation never converged over five Codex rounds on #5201, so the
  // extraction judges the promise's language (definite_commitment,
  // relative_date_used, moved_appointment_relative_date_used) and resolves
  // relative dates; the code verifies flags, quotes and the resolved date.
  // Fixtures are mocked extraction outputs. Call: Wed Sep 23, 2026 (Thursday
  // Sep 24 is the nearest Thursday, Oct 1 the one after).
  describe('extraction-judged language (schema 1.20.0)', () => {
    const NEXT_THURSDAY_2PM = '2026-10-01T14:00:00-04:00';
    const PM = { day: 'Thursday', hour: 'two', period: 'PM' };
    // The agent says `said`; the extraction reports `flags` and `slot`.
    const judged = ({ said, callerSays = ACCEPT, slot = THURSDAY_2PM, words = PM, flags = {}, relativeQuote = said, extraEvidence = [] }) => ground(v2({
      scheduling: { confirmed_start_at: slot, agreed_slot_words: words, ...flags },
      evidence: [
        quote('/scheduling/agent_committed_booking', 'agent', said),
        quote('/scheduling/confirmed_start_at', 'agent', said),
        quote('/scheduling/caller_accepted_slot', 'caller', callerSays),
        ...(relativeQuote ? [quote('/scheduling/relative_date_used', 'agent', relativeQuote)] : []),
        ...extraEvidence,
      ],
    }), `Caller: Can we move my visit?\nAgent: ${said}\nCaller: ${callerSays}`);
    const relativeTrue = { relative_date_used: true };

    test('a relative date the extraction resolved and flagged grounds by its own date, never the nearest weekday', () => {
      for (const said of [
        'We will see you Thursday eight days away at two PM.',
        'We will see you the Thursday following this one at two PM.',
        'We will see you Thursday eight days from now at two PM.',
        'We will see you Thursday after this one at two PM.',
        'We will see you Thursday next week at two PM.',
      ]) {
        expect([said, judged({ said, slot: NEXT_THURSDAY_2PM, flags: relativeTrue }).ok]).toEqual([said, true]);
      }
    });

    test('a flagged relative date the code cannot verify fails closed', () => {
      const said = 'We will see you Thursday eight days away at two PM.';
      // No pinned quote for the relative expression.
      expect(judged({ said, slot: NEXT_THURSDAY_2PM, flags: relativeTrue, relativeQuote: null }))
        .toMatchObject({ ok: false, reason: 'relative_date_ungrounded' });
      // Flagged relative but resolved to the nearest Thursday: ambiguous ("next Thursday").
      expect(judged({ said, slot: THURSDAY_2PM, flags: relativeTrue })).toMatchObject({ ok: false, reason: 'agreed_slot_words_mismatch' });
      // Resolved date is not a Thursday, is in the past, or is beyond the horizon.
      expect(judged({ said, slot: '2026-10-02T14:00:00-04:00', flags: relativeTrue })).toMatchObject({ ok: false, reason: 'agreed_slot_words_mismatch' });
      expect(judged({ said, slot: '2026-09-17T14:00:00-04:00', flags: relativeTrue })).toMatchObject({ ok: false, reason: 'agreed_slot_words_mismatch' });
      expect(judged({ said, slot: '2026-12-03T14:00:00-05:00', flags: relativeTrue })).toMatchObject({ ok: false, reason: 'agreed_slot_words_mismatch' });
      // Relative dates need a weekday to check against.
      expect(judged({ said, slot: NEXT_THURSDAY_2PM, flags: relativeTrue, words: { day: 'October 1st', hour: 'two', period: 'PM' } }))
        .toMatchObject({ ok: false, reason: 'agreed_slot_words_mismatch' });
    });

    // Weekday-less relative dates: only a closed arithmetic set, computed by
    // the code from the pinned quote and the call's day (Wed Sep 23), and it
    // must EQUAL the extraction's resolved date.
    test('weekday-less relative dates ground only for the closed arithmetic forms, when the computed date equals the extraction\'s', () => {
      const at = (date) => `${date}T14:00:00-04:00`;
      const FORMS = [
        ['We will see you tomorrow at two PM.', 'tomorrow', '2026-09-24'],
        ['We will see you the day after tomorrow at two PM.', 'the day after tomorrow', '2026-09-25'],
        ['We will see you in three days at two PM.', 'in three days', '2026-09-26'],
        ['We will see you in 5 days at two PM.', 'in 5 days', '2026-09-28'],
        ['We will see you eight days from now at two PM.', 'eight days from now', '2026-10-01'],
        ['We will see you 2 days from today at two PM.', '2 days from today', '2026-09-25'],
        ['We will see you two weeks from now at two PM.', 'two weeks from now', '2026-10-07'],
        ['We will see you in 3 weeks at two PM.', 'in 3 weeks', '2026-10-14'],
        ['We will see you one week from today at two PM.', 'one week from today', '2026-09-30'],
        ['We will see you in a week at two PM.', 'in a week', '2026-09-30'],
        ['We will see you a week from now at two PM.', 'a week from now', '2026-09-30'],
        ['We will see you a week from today at two PM.', 'a week from today', '2026-09-30'],
        ['We will see you in a day at two PM.', 'in a day', '2026-09-24'],
        ['We will see you in one day at two PM.', 'in one day', '2026-09-24'],
      ];
      for (const [said, day, date] of FORMS) {
        const words = { day, hour: 'two', period: 'PM' };
        expect([said, judged({ said, slot: at(date), words, flags: relativeTrue }).ok]).toEqual([said, true]);
        // The extraction's date must equal the computed one: a day either way fails.
        const off = new Date(`${date}T12:00:00Z`); off.setUTCDate(off.getUTCDate() + 1);
        expect([said, judged({ said, slot: at(off.toISOString().slice(0, 10)), words, flags: relativeTrue }).ok]).toEqual([said, false]);
      }
      // The quote, not the recorded words, is what is computed; a missing pin fails.
      expect(judged({ said: FORMS[4][0], slot: at('2026-10-01'), words: { day: 'eight days from now', hour: 'two', period: 'PM' }, flags: relativeTrue, relativeQuote: null }))
        .toMatchObject({ ok: false, reason: 'relative_date_ungrounded' });
      // Past today, and beyond the 60-day horizon, fail even when they equal the computed date.
      expect(judged({ said: 'We will see you in 8 weeks at two PM.', slot: at('2026-11-18'), words: { day: 'in 8 weeks', hour: 'two', period: 'PM' }, flags: relativeTrue }).ok).toBe(true);
      expect(judged({ said: 'We will see you in 9 weeks at two PM.', slot: at('2026-11-25'), words: { day: 'in 9 weeks', hour: 'two', period: 'PM' }, flags: relativeTrue }).ok).toBe(false);
      // The recorded phrase must sit verbatim in the quote, and the quote must state
      // no other offset form.
      expect(judged({ said: 'We will see you at least two days from now at two PM.', slot: at('2026-09-25'), words: { day: 'two days from now', hour: 'two', period: 'PM' },
        flags: relativeTrue, relativeQuote: 'We will see you in two days at two PM.' }).ok).toBe(false);
      expect(judged({ said: 'We will see you in two days at two PM, not tomorrow.', slot: at('2026-09-25'), words: { day: 'in two days', hour: 'two', period: 'PM' },
        flags: relativeTrue }).ok).toBe(false);
      // A quantity bound around the recorded phrase makes it a range, not a date.
      for (const before of ['at least', 'at most', 'more than', 'less than', 'fewer than', 'over', 'under', 'within', 'by', 'up to',
        'about', 'around', 'roughly', 'approximately', 'no later than', 'no sooner than', 'before', 'after']) {
        const said = `We will see you ${before} two days from now at two PM.`;
        expect([said, judged({ said, slot: at('2026-09-25'), words: { day: 'two days from now', hour: 'two', period: 'PM' }, flags: relativeTrue }).ok]).toEqual([said, false]);
      }
      for (const after of ['or so', 'or more', 'or two']) {
        const said = `We will see you two days from now ${after} at two PM.`;
        expect([said, judged({ said, slot: at('2026-09-25'), words: { day: 'two days from now', hour: 'two', period: 'PM' }, flags: relativeTrue }).ok]).toEqual([said, false]);
      }
      for (const said of ['We will see you by the day after tomorrow at two PM.', 'We will see you before tomorrow at two PM.']) {
        expect([said, judged({ said, slot: at('2026-09-25'), words: { day: said.includes('after') ? 'the day after tomorrow' : 'tomorrow', hour: 'two', period: 'PM' }, flags: relativeTrue }).ok]).toEqual([said, false]);
      }
      // Everything else weekday-less stays manual.
      for (const [said, day] of [
        ['We will see you sometime next month at two PM.', 'sometime next month'],
        ['We will see you in a few days at two PM.', 'in a few days'],
        ['We will see you in a couple of weeks at two PM.', 'in a couple of weeks'],
        ['We will see you at least two days from now at two PM.', 'at least two days from now'],
        ['We will see you half of a day from now at two PM.', 'half of a day from now'],
        ['We will see you more than a week from now at two PM.', 'more than a week from now'],
        ['We will see you within two days at two PM.', 'within two days'],
        ['We will see you by the day after tomorrow at two PM.', 'by the day after tomorrow'],
        ['We will see you about eight days from now at two PM.', 'about eight days from now'],
        ['We will see you up to two weeks from now at two PM.', 'up to two weeks from now'],
        ['We will see you half a day from now at two PM.', 'half a day from now'],
        ['We will see you in a week or two at two PM.', 'in a week or two'],
        ['We will see you in nine days at two PM.', 'in nine days'],
        ['We will see you eight days away at two PM.', 'eight days away'],
        ['We will see you in two days or three days at two PM.', 'in two days'],
      ]) {
        expect([said, judged({ said, slot: at('2026-09-25'), words: { day, hour: 'two', period: 'PM' }, flags: relativeTrue }).ok]).toEqual([said, false]);
      }
    });

    // The offset's number is part of the date, never a second clock hour.
    // A weekday with an exact offset is that weekday's first occurrence on or
    // after the offset date; an extraction date in any other week contradicts it.
    // One span detector drives both the hour scan and the parser: "N days/weeks
    // away|out" compute like "from now", and any offset-shaped span the parser
    // cannot compute in the pinned clause rejects.
    test('away/out compute exactly, and any uncomputed offset span in the clause fails closed', () => {
      const oct = (d) => `2026-10-${d}T14:00:00-04:00`;
      const weekday = (said, slot) => judged({ said, slot, flags: relativeTrue }).ok;
      expect(weekday('We will see you Thursday eight days away at two PM.', oct('01'))).toBe(true);
      expect(weekday('We will see you Thursday eight days away at two PM.', oct('08'))).toBe(false);
      expect(weekday('We will see you Thursday eight days out at two PM.', oct('08'))).toBe(false);
      expect(weekday('We will see you Thursday two weeks out at two PM.', oct('08'))).toBe(true);
      expect(weekday('We will see you Thursday two weeks away at two PM.', oct('15'))).toBe(false);
      const bare = (said, day, slot) => judged({ said, slot, words: { day, hour: 'two', period: 'PM' }, flags: relativeTrue }).ok;
      expect(bare('We will see you eight days away at two PM.', 'eight days away', oct('01'))).toBe(true);
      expect(bare('We will see you two weeks out at two PM.', 'two weeks out', oct('07'))).toBe(true);
      expect(bare('We will see you eight days away at two PM.', 'eight days away', oct('08'))).toBe(false);
      // Spans the parser does not compute reject even with a weekday to fall back on.
      for (const said of [
        'We will see you Thursday two weeks later at two PM.',
        'We will see you Thursday two weeks hence at two PM.',
        'We will see you Thursday nine days from now at two PM.',
        'We will see you Thursday for two days at two PM.',
        'We will see you Thursday half a day from now at two PM.',
        'We will see you Thursday half of a day from now at two PM.',
        'We will see you a week from Thursday at two PM.',
        'We will see you Thursday in a week or two at two PM.',
      ]) expect([said, weekday(said, oct('08'))]).toEqual([said, false]);
    });

    test('a range or alternative around an offset fails, after or before it', () => {
      const bare = (said, day) => judged({ said, slot: '2026-09-25T14:00:00-04:00', words: { day, hour: 'two', period: 'PM' }, flags: relativeTrue }).ok;
      expect(bare('We will see you in two days at two PM.', 'in two days')).toBe(true);
      for (const [said, day] of [
        ['We will see you two days from now or three at two PM.', 'two days from now'],
        ['We will see you two days from now or 3 at two PM.', 'two days from now'],
        ['We will see you two days from now to three days at two PM.', 'two days from now'],
        ['We will see you in two to three days at two PM.', 'in two'],
        ['We will see you two or three days from now at two PM.', 'three days from now'],
        ['We will see you 2 or 3 days from now at two PM.', '3 days from now'],
        ['We will see you two days from now through four at two PM.', 'two days from now'],
        ['We will see you two three days from now at two PM.', 'three days from now'],
        ['We will see you tomorrow or the day after at two PM.', 'tomorrow'],
      ]) expect([said, bare(said, day)]).toEqual([said, false]);
    });

    test('a weekday with an exact offset must agree with the offset', () => {
      const said = 'We will see you Thursday eight days from now at two PM.';
      expect(judged({ said, slot: '2026-10-01T14:00:00-04:00', flags: relativeTrue }).ok).toBe(true);
      expect(judged({ said, slot: '2026-10-08T14:00:00-04:00', flags: relativeTrue }).ok).toBe(false);
      expect(judged({ said, slot: '2026-09-24T14:00:00-04:00', flags: relativeTrue }).ok).toBe(false);
      const weeks = 'We will see you Thursday two weeks from now at two PM.';
      expect(judged({ said: weeks, slot: '2026-10-08T14:00:00-04:00', flags: relativeTrue }).ok).toBe(true);
      expect(judged({ said: weeks, slot: '2026-10-15T14:00:00-04:00', flags: relativeTrue }).ok).toBe(false);
      expect(judged({ said: 'We will see you Thursday a week from now at two PM.', slot: '2026-10-01T14:00:00-04:00', flags: relativeTrue }).ok).toBe(true);
      expect(judged({ said: 'We will see you Thursday a week from now at two PM.', slot: '2026-10-08T14:00:00-04:00', flags: relativeTrue }).ok).toBe(false);
      // Two different offsets in one clause are ambiguous.
      expect(judged({ said: 'We will see you Thursday in two days or in eight days at two PM.', slot: '2026-10-01T14:00:00-04:00', flags: relativeTrue }).ok).toBe(false);
    });

    test('a relative offset\'s number is not read as a clock hour', () => {
      const bare = { day: 'Thursday', hour: 'two', period: null };
      for (const said of [
        'We will see you Thursday eight days from now at two.',
        'We will see you Thursday two weeks from now at two.',
        'We will see you Thursday in 8 days at two.',
        'We will see you Thursday eight days away at two.',
      ]) {
        const days = /two weeks/.test(said) ? '2026-10-08' : '2026-10-01';
        expect([said, judged({ said, slot: `${days}T14:00:00-04:00`, words: bare, flags: relativeTrue }).ok]).toEqual([said, true]);
      }
      // Unflagged, the same number still counts as a second hour.
      expect(judged({ said: 'We will see you Thursday eight days from now at two.', relativeQuote: null, words: bare }).ok).toBe(false);
      // A relative phrase with no hour of its own still needs the hour.
      expect(judged({ said: 'We will see you Thursday two weeks from now.', slot: '2026-10-08T14:00:00-04:00', words: bare, flags: relativeTrue }).ok).toBe(false);
    });

    // Call on Monday Sep 28: the nearest Thursday is Oct 1, and "three days from
    // now" is also Oct 1. An exact closed-set offset that computes to the
    // resolved date grounds even when that is the nearest weekday; only the
    // inherently ambiguous forms ("next/this/following Thursday") need a
    // non-nearest date.
    test('an exact offset that computes to the resolved date grounds even on the nearest weekday', () => {
      const MONDAY = '2026-09-28T19:00:00Z';
      const OCT1 = '2026-10-01T14:00:00-04:00';
      const run = ({ said, relativeQuote = said, slot = OCT1, moved = null }) => groundRescheduleAgreement({
        callStartedAt: MONDAY,
        transcript: `Caller: Can we move my visit?\nAgent: ${said}\nCaller: ${ACCEPT}`,
        v2: v2({
          scheduling: { confirmed_start_at: slot, agreed_slot_words: PM, relative_date_used: true, ...(moved ? moved.scheduling : {}) },
          evidence: [
            quote('/scheduling/agent_committed_booking', 'agent', said),
            quote('/scheduling/confirmed_start_at', 'agent', said),
            quote('/scheduling/caller_accepted_slot', 'caller', ACCEPT),
            ...(relativeQuote ? [quote('/scheduling/relative_date_used', 'agent', relativeQuote)] : []),
            ...(moved ? moved.evidence : []),
          ],
        }),
      }).ok;
      for (const said of [
        'We will see you Thursday three days from now at two PM.',
        'We will see you Thursday in 3 days at two PM.',
        'We will see you Thursday three days from today at two PM.',
      ]) expect([said, run({ said })]).toEqual([said, true]);
      // A bound on the offset still rejects; a wrong count computes another date.
      expect(run({ said: 'We will see you Thursday at least three days from now at two PM.' })).toBe(false);
      expect(run({ said: 'We will see you Thursday within three days at two PM.' })).toBe(false);
      expect(run({ said: 'We will see you Thursday about three days from now at two PM.' })).toBe(false);
      // Ambiguous forms with no offset still need a non-nearest date.
      for (const said of ['We will see you next Thursday at two PM.', 'We will see you this Thursday at two PM.', 'We will see you the following Thursday at two PM.']) {
        expect([said, run({ said })]).toEqual([said, false]);
      }
      expect(run({ said: 'We will see you the following Thursday at two PM.', slot: '2026-10-08T14:00:00-04:00' })).toBe(true);
      // The moved appointment: the same rule, with its own flag and pin.
      const SAME = 'We will see you at two in the afternoon.';
      const movedRun = (movedQuote) => groundRescheduleAgreement({
        callStartedAt: MONDAY,
        transcript: `Caller: Can you move ${movedQuote}?\nAgent: ${SAME}\nCaller: ${ACCEPT}`,
        v2: v2({
          scheduling: {
            confirmed_start_at: OCT1, moved_appointment_date: '2026-10-01', moved_appointment_words: 'Thursday',
            moved_appointment_relative_date_used: true, agreed_slot_words: { day: null, hour: 'two', period: 'in the afternoon' },
          },
          evidence: [
            quote('/scheduling/agent_committed_booking', 'agent', SAME),
            quote('/scheduling/confirmed_start_at', 'agent', SAME),
            quote('/scheduling/caller_accepted_slot', 'caller', ACCEPT),
            quote('/scheduling/moved_appointment_date', 'caller', movedQuote),
            quote('/scheduling/moved_appointment_relative_date_used', 'caller', movedQuote),
          ],
        }),
      }).ok;
      expect(movedRun('my Thursday three days from now appointment')).toBe(true);
      expect(movedRun('my Thursday at least three days from now appointment')).toBe(false);
      expect(movedRun('my next Thursday appointment')).toBe(false);
    });

    test('a relative moved-appointment flag with no resolved date is not grounded', () => {
      const SAME = 'We will see you at two in the afternoon.';
      const movedQuote = 'my Thursday a week from now appointment';
      const run = (scheduling) => ground(v2({
        scheduling: { agreed_slot_words: { day: null, hour: 'two', period: 'in the afternoon' }, ...scheduling },
        evidence: [
          quote('/scheduling/agent_committed_booking', 'agent', SAME),
          quote('/scheduling/confirmed_start_at', 'agent', SAME),
          quote('/scheduling/caller_accepted_slot', 'caller', ACCEPT),
          quote('/scheduling/moved_appointment_date', 'caller', movedQuote),
          quote('/scheduling/moved_appointment_relative_date_used', 'caller', movedQuote),
        ],
      }), `Caller: Can you move ${movedQuote}?\nAgent: ${SAME}\nCaller: ${ACCEPT}`);
      // Flag true but no resolved date (the planner would fall back to a lone
      // same-service candidate): its own reason. Null flag or words still fail.
      expect(run({ moved_appointment_relative_date_used: true, moved_appointment_date: null, moved_appointment_words: 'Thursday' }))
        .toMatchObject({ ok: false, reason: 'moved_relative_without_date' });
      expect(run({ moved_appointment_relative_date_used: true, moved_appointment_date: null, moved_appointment_words: null }))
        .toMatchObject({ ok: false, reason: 'moved_relative_without_date' });
      expect(run({ moved_appointment_relative_date_used: true, moved_appointment_date: '2026-10-01', moved_appointment_words: null }))
        .toMatchObject({ ok: false, reason: 'moved_appointment_ungrounded' });
    });

    test('a weekday-less relative moved appointment follows the same closed forms', () => {
      const SAME = 'We will see you at two in the afternoon.';
      const movedQuote = 'my appointment the day after tomorrow';
      const movedCase = (date) => ground(v2({
        scheduling: {
          confirmed_start_at: `${date}T14:00:00-04:00`, moved_appointment_date: date, moved_appointment_words: 'the day after tomorrow',
          moved_appointment_relative_date_used: true, agreed_slot_words: { day: null, hour: 'two', period: 'in the afternoon' },
        },
        evidence: [
          quote('/scheduling/agent_committed_booking', 'agent', SAME),
          quote('/scheduling/confirmed_start_at', 'agent', SAME),
          quote('/scheduling/caller_accepted_slot', 'caller', ACCEPT),
          quote('/scheduling/moved_appointment_date', 'caller', movedQuote),
          quote('/scheduling/moved_appointment_relative_date_used', 'caller', movedQuote),
        ],
      }), `Caller: Can you move ${movedQuote}?\nAgent: ${SAME}\nCaller: ${ACCEPT}`);
      expect(movedCase('2026-09-25').ok).toBe(true);
      expect(movedCase('2026-09-26').ok).toBe(false);
    });

    test('an extraction that dropped the qualifier disagrees with the code and fails closed', () => {
      // Bare Thursday, not flagged relative, but the extraction resolved Oct 1:
      // the nearest-Thursday rule disagrees -> manual (never a silent pick).
      expect(judged({ said: 'We will see you Thursday eight days away at two PM.', slot: NEXT_THURSDAY_2PM, relativeQuote: null }))
        .toMatchObject({ ok: false, reason: 'agreed_slot_words_mismatch' });
      // An unflagged relative phrase in the quote never grounds on main's own screen.
      expect(judged({ said: 'We will see you Thursday next week at two PM.', relativeQuote: null }))
        .toMatchObject({ ok: false, reason: 'agreed_slot_ungrounded' });
      expect(judged({ said: 'We will see you the Thursday following this one at two PM.', relativeQuote: null }).ok).toBe(false);
    });

    test('the extraction must judge the promise definite, and judge the relative date either way', () => {
      const said = 'We will see you Thursday at two PM.';
      expect(judged({ said, relativeQuote: null }).ok).toBe(true);
      // Codex r1-r3 promise shapes, correctly judged by the extraction.
      for (const soft of [
        'We can tentatively see you Thursday at two PM.',
        'We will probably see you Thursday at two PM.',
        'The payment is pending, and we could see you Thursday at two PM.',
        'The payment is pending, and we will see you Thursday at two PM upon clearance.',
        'We will see you Thursday at two PM once cleared.',
        'We will see you Thursday at two PM after the rain.',
        'We will see you Thursday at two PM, weather permitting.',
      ]) {
        expect([soft, judged({ said: soft, relativeQuote: null, flags: { definite_commitment: false } })])
          .toEqual([soft, expect.objectContaining({ ok: false, reason: 'agent_commitment_not_definite' })]);
      }
      // Unjudged (older extraction, or the model left it out) is manual.
      expect(judged({ said, relativeQuote: null, flags: { definite_commitment: null } })).toMatchObject({ ok: false, reason: 'agent_commitment_not_definite' });
      expect(judged({ said, relativeQuote: null, flags: { definite_commitment: undefined } })).toMatchObject({ ok: false, reason: 'agent_commitment_not_definite' });
      expect(judged({ said, relativeQuote: null, flags: { relative_date_used: null } })).toMatchObject({ ok: false, reason: 'relative_date_unjudged' });
      expect(judged({ said, relativeQuote: null, flags: { relative_date_used: undefined } })).toMatchObject({ ok: false, reason: 'relative_date_unjudged' });
      // Main's own condition screen still backs up a mistaken definite flag
      // for "if"; "could" and "might" rest on the extraction alone.
      expect(judged({ said: 'If the tech is free we will see you Thursday at two PM.', relativeQuote: null }).ok).toBe(false);
    });

    test('courtesy and ordinary acceptance ground on main\'s own rules', () => {
      for (const said of [
        'We will see you Thursday at two PM, thank you for your time.',
        'We will see you Thursday at two PM. Enjoy the rest of your day.',
        'I have you scheduled for Thursday at two PM.',
        'We will see you Thursday at two PM, and a tech will call you.',
      ]) expect([said, judged({ said, relativeQuote: null }).ok]).toEqual([said, true]);
      for (const callerSays of ['Thursday at two PM works perfectly.', 'That fits my schedule.', 'Thursday at two PM is perfect, thank you.', 'Yes, that works for me.']) {
        expect([callerSays, judged({ said: 'We will see you Thursday at two PM.', callerSays, relativeQuote: null }).ok]).toEqual([callerSays, true]);
      }
      // Main's coarse screen (a "week"/"next"/"following" word next to an
      // UNflagged slot) is kept as a safety net, so unrelated timing in the
      // slot's sentence still goes to the office: the known trade-off.
      expect(judged({ said: 'Your plan renews a week from now, and we will see you Thursday at two PM.', relativeQuote: null }).ok).toBe(false);
    });

    test('the caller confirming a relative slot ("... and next week sounds perfect") follows the flags', () => {
      const said = 'We will see you Thursday at two PM.';
      const callerSays = 'Thursday at two PM and next week sounds perfect.';
      // Unflagged: main's screen refuses the slot quote's "next week".
      expect(ground(v2({
        evidence: [
          quote('/scheduling/agent_committed_booking', 'agent', said),
          quote('/scheduling/confirmed_start_at', 'caller', callerSays),
          quote('/scheduling/caller_accepted_slot', 'caller', callerSays),
        ],
        scheduling: { agreed_slot_words: PM },
      }), `Caller: ${callerSays}\nAgent: ${said}`).ok).toBe(false);
      // Flagged and resolved to Oct 1: grounds through the extraction's date.
      expect(ground(v2({
        evidence: [
          quote('/scheduling/agent_committed_booking', 'agent', said),
          quote('/scheduling/confirmed_start_at', 'caller', callerSays),
          quote('/scheduling/caller_accepted_slot', 'caller', callerSays),
          quote('/scheduling/relative_date_used', 'caller', callerSays),
        ],
        scheduling: { agreed_slot_words: PM, confirmed_start_at: NEXT_THURSDAY_2PM, relative_date_used: true },
      }), `Caller: ${callerSays}\nAgent: ${said}`).ok).toBe(true);
    });

    test('a relative moved appointment follows its own flag and resolved date', () => {
      const SAME = 'We will see you at two in the afternoon.';
      const movedQuote = 'my Thursday a week from now appointment';
      const movedCase = ({ date, words = 'Thursday', flag, pin = true }) => ground(v2({
        scheduling: {
          confirmed_start_at: '2026-10-01T14:00:00-04:00',
          moved_appointment_date: date, moved_appointment_words: words, moved_appointment_relative_date_used: flag,
          agreed_slot_words: { day: null, hour: 'two', period: 'in the afternoon' },
        },
        evidence: [
          quote('/scheduling/agent_committed_booking', 'agent', SAME),
          quote('/scheduling/confirmed_start_at', 'agent', SAME),
          quote('/scheduling/caller_accepted_slot', 'caller', ACCEPT),
          quote('/scheduling/moved_appointment_date', 'caller', movedQuote),
          ...(pin ? [quote('/scheduling/moved_appointment_relative_date_used', 'caller', movedQuote)] : []),
        ],
      }), `Caller: Can you move ${movedQuote}?\nAgent: ${SAME}\nCaller: ${ACCEPT}`);
      expect(movedCase({ date: '2026-10-01', flag: true })).toEqual({ ok: true, reason: 'agreement_grounded', movedDate: '2026-10-01' });
      // Dropped qualifier: resolved Oct 1 but unflagged, or flagged with the nearest date.
      expect(movedCase({ date: '2026-10-01', flag: false })).toMatchObject({ ok: false, reason: 'moved_appointment_ungrounded' });
      expect(movedCase({ date: '2026-09-24', flag: true })).toMatchObject({ ok: false, reason: 'moved_appointment_ungrounded' });
      expect(movedCase({ date: '2026-10-01', flag: true, pin: false })).toMatchObject({ ok: false, reason: 'moved_appointment_ungrounded' });
      expect(movedCase({ date: '2026-10-01', flag: null })).toMatchObject({ ok: false, reason: 'moved_appointment_ungrounded' });
    });

    test('the period of an abbreviated month stays part of the date (Oct. 10 at 10)', () => {
      expect(agreedAt('2026-10-10T10:00:00-04:00', 'We will move it to Oct. 10 at 10.', { day: 'Oct. 10', hour: '10', period: null }).ok).toBe(true);
    });
  });
});
