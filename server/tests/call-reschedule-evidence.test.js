// Reschedule-only whole-call agreement evidence. Fixtures are fictitious
// (synthetic transcript lines, no real customer content).
const { rescheduleAgreementEvidence } = require('../services/call-reschedule-evidence');

// Wed Sep 23, 2026, 3pm ET — a fixed call-started anchor so relative day
// words ("tomorrow", "Thursday", "Monday") resolve predictably.
const CALL_STARTED_AT = '2026-09-23T19:00:00Z';
const THURSDAY_2PM = '2026-09-24T14:00:00-04:00'; // the day after the call, 2pm ET

function evidence(transcript, confirmedStartAt = THURSDAY_2PM) {
  return rescheduleAgreementEvidence({ transcript, confirmedStartAt, callStartedAt: CALL_STARTED_AT });
}

describe('rescheduleAgreementEvidence', () => {
  test('day and hour agreed in separate exchanges both resolve to the slot', () => {
    const r = evidence('Caller: Can we move my visit?\nAgent: Would Thursday work for you?\nCaller: Thursday is fine.\nAgent: Great, we will see you at two o clock then.');
    expect(r).toMatchObject({ ok: true, reason: 'agreement_established' });
  });

  test('"tomorrow" plus a later hour in the same agent turn', () => {
    const r = evidence('Caller: Can we do tomorrow?\nAgent: Sure, tomorrow at 2 PM works. We will see you then.');
    expect(r.ok).toBe(true);
  });

  test('a spelled-out hour ("at two") resolves with business-hours inference', () => {
    const r = evidence('Caller: Can you come by Thursday?\nAgent: We will see you Thursday at two.');
    expect(r.ok).toBe(true);
  });

  test('"we will see you Monday at 11"', () => {
    const r = evidence('Caller: Can we push it to Monday?\nAgent: We will see you Monday at 11.', '2026-09-28T11:00:00-04:00');
    expect(r.ok).toBe(true);
  });

  test('a range reference counts its START as the hour ("mark it to two to four")', () => {
    const r = evidence('Caller: Can you come Thursday afternoon?\nAgent: We will mark it to two to four on Thursday.');
    expect(r.ok).toBe(true);
  });

  test('a later, different hour anywhere in the call fails closed', () => {
    const r = evidence('Caller: Can we do Thursday at two?\nAgent: We will see you Thursday at two. Actually, let us do it at three instead.');
    expect(r).toMatchObject({ ok: false, reason: 'last_hour_ref_mismatch' });
  });

  test('a later, different day anywhere in the call fails closed', () => {
    const r = evidence('Caller: Can we do Thursday at two?\nAgent: We will see you Thursday at two. Actually, Friday works better for us.');
    expect(r).toMatchObject({ ok: false, reason: 'last_day_ref_mismatch' });
  });

  test('a hedge AFTER the agreement fails closed, but the same hedge BEFORE it is fine', () => {
    const after = evidence('Caller: Can we do Thursday at two?\nAgent: We will see you Thursday at two.\nAgent: Let me check on that.');
    expect(after).toMatchObject({ ok: false, reason: 'hedge_on_slot' });
    const before = evidence('Caller: Let me check on that.\nAgent: We will see you Thursday at two.');
    expect(before.ok).toBe(true);
  });

  test('an agent question with no later answer fails', () => {
    const r = evidence('Caller: Can we move it?\nAgent: Would Thursday at two work for you?');
    expect(r).toMatchObject({ ok: false, reason: 'no_affirming_agent_turn' });
  });

  test('a caller-only "we will see you tomorrow" with no agent affirmation fails', () => {
    const r = evidence('Caller: We will see you tomorrow at two then.\nAgent: Thanks for calling.');
    expect(r).toMatchObject({ ok: false, reason: 'no_affirming_agent_turn' });
  });

  test('an availability condition makes the slot conditional, but an ordinary closer does not', () => {
    const conditional = evidence('Caller: Can we do Thursday at two?\nAgent: If we have space. We will see you Thursday at two.');
    expect(conditional).toMatchObject({ ok: false, reason: 'hedge_on_slot' });
    const closer = evidence('Caller: Can we do Thursday at two?\nAgent: We will see you Thursday at two. If you need anything, give us a call.');
    expect(closer.ok).toBe(true);
  });

  // Each day kind is found in its own pass; last-mention-wins must still
  // follow the order the words were spoken in.
  test('the last day and hour are the last ones SPOKEN, not the last kind parsed', () => {
    const notFriday = 'Caller: Can we do Friday at two?\nAgent: Not Friday, we will see you tomorrow at two.';
    expect(evidence(notFriday, '2026-09-25T14:00:00-04:00')).toMatchObject({ ok: false, reason: 'last_day_ref_mismatch' });
    expect(evidence(notFriday).ok).toBe(true);
    const noonNotEleven = 'Caller: Can we do Thursday?\nAgent: We will see you Thursday at 11, no, make it noon.';
    expect(evidence(noonNotEleven, '2026-09-24T12:00:00-04:00').ok).toBe(true);
    expect(evidence(noonNotEleven, '2026-09-24T11:00:00-04:00')).toMatchObject({ ok: false, reason: 'last_hour_ref_mismatch' });
  });

  test('a refusal after the agreement undoes it; refusing another day first does not', () => {
    const withdrawn = evidence("Caller: Can we do Thursday at two?\nAgent: We will see you Thursday at two.\nCaller: Actually never mind, that won't work.");
    expect(withdrawn).toMatchObject({ ok: false, reason: 'slot_refused' });
    const otherDayFirst = evidence('Caller: Friday or Thursday at two?\nAgent: Friday does not work, but we will see you Thursday at two.');
    expect(otherDayFirst.ok).toBe(true);
  });

  // A slot is always on the hour, so a time spoken with minutes never
  // grounds it: 2:30 is not 2:00.
  test('an hour spoken with minutes never grounds an on-the-hour slot', () => {
    for (const said of ['at 2:30', 'at two thirty', 'at half past two', 'at 2:45 PM']) {
      expect(evidence(`Caller: Can we do Thursday?\nAgent: We will see you Thursday ${said}.`))
        .toMatchObject({ ok: false, reason: 'last_hour_ref_mismatch' });
    }
    expect(evidence('Caller: Can we do Thursday?\nAgent: We will see you Thursday at 2:00 PM.').ok).toBe(true);
  });

  test('a courtesy word after a refusal does not restore the agreement, and "let me see" is not an agreement', () => {
    const courtesyAfterRefusal = evidence("Caller: Can we do Thursday at two?\nAgent: We will see you Thursday at two. Actually that won't work, alright.");
    expect(courtesyAfterRefusal).toMatchObject({ ok: false, reason: 'slot_refused' });
    const stillLooking = evidence('Caller: Can we do Thursday at two?\nAgent: Okay, let me see what I have for Thursday at two.');
    expect(stillLooking).toMatchObject({ ok: false, reason: 'hedge_on_slot' });
  });

  // "Thursday at two won't work" then a polite "okay" is not an agreement.
  test('a refusal of the slot itself, politely acknowledged, is not an agreement', () => {
    const refusedThenOkay = evidence("Caller: Thursday at two won't work for me.\nAgent: Okay, no problem.");
    expect(refusedThenOkay).toMatchObject({ ok: false, reason: 'slot_refused' });
  });

  // "I cannot make it Thursday at two" refuses the slot even though the refusal
  // comes first; "Friday doesn't work, but ... Thursday at two" refuses Friday.
  test('a refusal in the clause stating the slot fails, one in an earlier clause does not', () => {
    expect(evidence('Caller: I cannot make it Thursday at two.\nAgent: Okay, no problem.'))
      .toMatchObject({ ok: false, reason: 'slot_refused' });
    expect(evidence('Caller: Friday or Thursday at two?\nAgent: Friday does not work, but we will see you Thursday at two.').ok).toBe(true);
  });

  // "2pm" written together is still an hour: otherwise the caller's earlier
  // "10" would be the last hour mentioned.
  test('an hour written with its am/pm attached is still the last hour', () => {
    const said = 'Caller: Can you do Thursday at 10?\nAgent: No, we will see you Thursday at 2pm.';
    expect(evidence(said, '2026-09-24T10:00:00-04:00')).toMatchObject({ ok: false, reason: 'last_hour_ref_mismatch' });
    expect(evidence(said).ok).toBe(true);
  });

  // A condition attached to the slot itself, however politely acknowledged.
  test('an availability condition stated with the slot fails even after courtesies', () => {
    expect(evidence('Agent: If we have space, Thursday at two.\nCaller: Thank you.\nAgent: No problem.'))
      .toMatchObject({ ok: false, reason: 'hedge_on_slot' });
  });

  // "two ten" is 2:10, never an on-the-hour 2:00.
  test('an hour followed by any spoken minutes is off the hour', () => {
    for (const said of ['at two ten', 'at 2 10', 'at two oh five']) {
      expect(evidence(`Caller: Can we do Thursday?\nAgent: We will see you Thursday ${said}.`))
        .toMatchObject({ ok: false, reason: 'last_hour_ref_mismatch' });
    }
  });

  // A later "great" about something else is not agreeing to the slot: the
  // first agent turn after it must affirm it, and a new question changes the subject.
  test('the first agent turn after the slot must affirm it, not a later answer on another topic', () => {
    expect(evidence("Caller: Can we do Thursday at two?\nAgent: Would you like text reminders too?\nCaller: Sure.\nAgent: Great, I'll set that up."))
      .toMatchObject({ ok: false, reason: 'no_affirming_agent_turn' });
    // The agent may propose the slot as a question and affirm after the caller accepts.
    expect(evidence('Agent: So you want to mark it Thursday two to four?\nCaller: That would be so much better.\nAgent: No worries, we will mark it.').ok).toBe(true);
  });

  // A bare "okay" that moves on to something else confirms nothing; a short
  // yes to the slot does.
  // A bare acknowledgment answers whatever came before it ("I need to ask my
  // husband" — "Okay"); only the agent committing to the slot affirms it.
  test('only an agent commitment affirms the slot, never a bare acknowledgment', () => {
    for (const reply of ['Okay, we also have a special on mosquito service this month.', 'All right. Yep.', 'Okay, Thursday at two.', 'Sounds good.', 'Okay, please hold.',
      'I will do my best.', 'I will do what I can.']) {
      expect(evidence(`Caller: Can we do Thursday at two?\nAgent: ${reply}`)).toMatchObject({ ok: false, reason: 'no_affirming_agent_turn' });
    }
    expect(evidence('Agent: Would Thursday at two work?\nCaller: I need to ask my husband.\nAgent: Okay, we will see you then.').ok).toBe(false);
    // A condition on the commitment itself leaves the slot open; one in
    // another sentence does not.
    expect(evidence('Caller: Can we do Thursday at two?\nAgent: We will see you then if a slot opens up.').ok).toBe(false);
    expect(evidence('Caller: Can we move my visit to Thursday at two?\nAgent: I will put you down on the waiting list.').ok).toBe(false);
    expect(evidence('Caller: Can we do Thursday at two?\nAgent: I will put you down for a callback about Thursday at two.').ok).toBe(false);
    expect(evidence('Caller: Can we do Thursday at two?\nAgent: Make that three. I will put you down for Thursday.').ok).toBe(false);
    expect(evidence('Caller: Can we do Thursday at two?\nAgent: We will see you then. If you need anything, give us a call.').ok).toBe(true);
    expect(evidence('Caller: Can we move it to Thursday?\nAgent: We will see you Thursday at quarter past noon.', '2026-09-24T12:00:00-04:00').ok).toBe(false);
    for (const reply of ['We will do that, two o clock then.', 'Okay, you are all set for Thursday at two.', 'Great, I will put you down.']) {
      expect(evidence(`Caller: Can we do Thursday at two?\nAgent: ${reply}`).ok).toBe(true);
    }
  });

  // Words that are Object.prototype keys are just words, not numbers.
  test('a word like "constructor" beside an hour is not a number', () => {
    expect(evidence('Caller: The constructor says Thursday at two works.\nAgent: We will see you Thursday at two.').ok).toBe(true);
  });

  // Structural fail-closed guards, no fixture speaks the slot at all.
  // A question anywhere in the agent's turn puts the slot to the caller, so
  // the agreement waits for the answer; a closing question does not.
  test('an agent turn asking the caller anything but a closing question is not an agreement', () => {
    expect(evidence('Caller: Can we move my visit?\nAgent: Okay, would Thursday at two work? Please let me know.'))
      .toMatchObject({ ok: false, reason: 'no_affirming_agent_turn' });
    const confirmAsk = 'Caller: Can we move my visit?\nAgent: Okay, Thursday at two. Does that work for you?';
    expect(evidence(confirmAsk)).toMatchObject({ ok: false, reason: 'no_affirming_agent_turn' });
    expect(evidence(`${confirmAsk}\nCaller: Yes, that works.\nAgent: Great, you are all set.`).ok).toBe(true);
    expect(evidence(`${confirmAsk}\nCaller: Yes, that works.\nAgent: Great.`).ok).toBe(false);
    expect(evidence('Caller: Can we move my visit to Thursday at two?\nAgent: Okay, we will see you then. Anything else I can help with?\nCaller: No, that is all.').ok)
      .toBe(true);
  });

  // "No" to the proposal, or a slot the agent turns down while saying okay.
  test('a negation on the slot, however politely acknowledged, is not an agreement', () => {
    expect(evidence('Caller: Can we do Thursday at two?\nAgent: We will see you then. Oh, but not Thursday.')).toMatchObject({ ok: false, reason: 'slot_refused' });
    expect(evidence('Caller: Can we do Thursday at two?\nAgent: Okay, we will see you then. Oh, I don\'t have that.')).toMatchObject({ ok: false, reason: 'slot_refused' });
    expect(evidence('Caller: Can we do Thursday at two?\nAgent: We will see you, there are no Thursday openings.')).toMatchObject({ ok: false, reason: 'slot_refused' });
    expect(evidence('Agent: Would Thursday at two work?\nCaller: No.\nAgent: Okay, we will see you then.')).toMatchObject({ ok: false, reason: 'slot_refused' });
    expect(evidence('Caller: I can\'t do Thursday at two.\nAgent: Okay, we will see you then.')).toMatchObject({ ok: false, reason: 'slot_refused' });
    expect(evidence('Caller: Can we do Thursday?\nAgent: We will see you Thursday at two, is that not good?').ok).toBe(false);
  });

  test('a negation governing the commitment itself, or a cancellation, is not an agreement', () => {
    expect(evidence('Caller: Can we do Thursday at two?\nAgent: I cannot promise we will see you Thursday at two.').ok).toBe(false);
    expect(evidence('Caller: Can we move my visit?\nAgent: We will see you Thursday at two.\nCaller: Please cancel it.\nAgent: Okay.').ok).toBe(false);
  });

  test('a negation that answers something else, or a courtesy, does not refuse the slot', () => {
    expect(evidence('Caller: Can we do Thursday at two?\nAgent: No problem, we will see you Thursday at two.').ok).toBe(true);
    expect(evidence('Caller: Can we move it?\nAgent: We will see you Thursday at two. You don\'t need to be home.').ok).toBe(true);
    expect(evidence('Caller: Can we do Friday at two?\nAgent: We can\'t do Friday, we will see you Thursday at two.').ok).toBe(true);
  });

  // A weekday beside a date only describes it, and alternatives never settle
  // the day.
  test('a weekday next to a date describes that date; "or" leaves the day open', () => {
    const oct8 = 'Caller: Can we move my visit?\nAgent: We will see you October 8, Thursday at two.';
    expect(evidence(oct8)).toMatchObject({ ok: false, reason: 'last_day_ref_mismatch' });
    expect(evidence(oct8, '2026-10-08T14:00:00-04:00').ok).toBe(true);
    const the8th = 'Caller: Can we move my visit?\nAgent: We will see you Thursday the 8th at two.';
    expect(evidence(the8th, '2026-10-08T14:00:00-04:00').ok).toBe(true);
    expect(evidence(the8th)).toMatchObject({ ok: false, reason: 'last_day_ref_mismatch' });
    expect(evidence('Caller: Can we move my visit?\nAgent: We will see you Wednesday, October 8 at two.', '2026-10-08T14:00:00-04:00'))
      .toMatchObject({ ok: false, reason: 'last_day_ref_mismatch' });
    expect(evidence('Caller: Can we move my visit?\nAgent: We will see you on the 1st of October at two.', '2026-10-01T14:00:00-04:00').ok).toBe(true);
    expect(evidence('Caller: I can do Monday or Thursday at two.\nAgent: Great, we will see you then.'))
      .toMatchObject({ ok: false, reason: 'last_day_ref_mismatch' });
  });

  // Codex #5071: a question sentence followed by another in the same turn is
  // still a question, and the "okay" after it answers nothing.
  test('a slot put as a question stays unanswered whatever follows it in the turn', () => {
    expect(evidence('Caller: Can we move my visit?\nAgent: Would Thursday at two work for you? Okay.'))
      .toMatchObject({ ok: false, reason: 'no_affirming_agent_turn' });
  });

  // An am/pm said about another time ("my 9 AM visit") says nothing about a
  // bare "two", which reads as business hours.
  test('an am/pm belongs to its own time, not to every hour in the call', () => {
    const r = evidence('Caller: My 9 AM appointment is too early; can we move it to Thursday at two?\nAgent: Yes, we will see you Thursday at two.');
    expect(r.ok).toBe(true);
    expect(evidence('Caller: Can we do Thursday morning?\nAgent: We will see you Thursday at 9 AM.', '2026-09-24T09:00:00-04:00').ok).toBe(true);
  });

  // A length of time is not a clock time: "for two" ends no sentence as an
  // hour, and a number running into hours or minutes is a duration.
  test('a duration is never read as the appointment hour', () => {
    expect(evidence('Caller: Can we move it to Thursday?\nAgent: We will see you Thursday. The service should last for two.'))
      .toMatchObject({ ok: false, reason: 'no_hour_ref_in_call' });
    for (const length of ['about three hours', 'about two and a half hours', 'around three to four hours', 'about one or two hours']) {
      expect(evidence(`Caller: Can we do Thursday at two?\nAgent: We will see you Thursday at two. It takes ${length}.`).ok).toBe(true);
    }
  });

  // After the agent agrees, the caller can still take it back: a "no" does,
  // unless it answers the agent's closing question, and so do the phrases
  // that withdraw without naming another time.
  test('a caller taking the move back after the agreement undoes it', () => {
    const agreed = 'Caller: Can we move my visit?\nAgent: We will see you Thursday at two.';
    expect(evidence(`${agreed}\nCaller: No, please don't move it.`)).toMatchObject({ ok: false, reason: 'slot_refused' });
    expect(evidence(`${agreed}\nCaller: Actually, let's keep the original time.`)).toMatchObject({ ok: false, reason: 'slot_refused' });
    expect(evidence(`${agreed} Anything else?\nCaller: No, I changed my mind about that.`)).toMatchObject({ ok: false, reason: 'slot_refused' });
    expect(evidence(`${agreed} Anything else?\nCaller: No, that's all. Thank you.`).ok).toBe(true);
    expect(evidence(`${agreed}\nCaller: Okay. Thank you. Bye.`).ok).toBe(true);
  });

  // Two hours offered as alternatives never settle which one, even when the
  // second has no marker of its own; a range is one time.
  test('hours offered as alternatives are not an agreed hour', () => {
    for (const offer of ['Thursday at two or at four', 'Thursday at two or three', 'Thursday at 2 pm or 4', 'Thursday at noon or at two']) {
      expect(evidence(`Caller: Can we do ${offer}?\nAgent: We will see you then.`)).toMatchObject({ ok: false, reason: 'last_hour_ref_mismatch' });
    }
    expect(evidence('Caller: Can we do Thursday between two and four?\nAgent: We will see you then.').ok).toBe(true);
  });

  // After the commitment, the agent can take it back too, and a caller who
  // corrects the time without a clock marker ("three instead", "can we do
  // three?") is still talking it over.
  test('a retraction or an unmarked correction after the commitment undoes it', () => {
    const agreed = 'Caller: Can we do Thursday at two?\nAgent: We will see you Thursday at two.';
    expect(evidence(`${agreed}\nAgent: Actually, we cannot move it.\nCaller: Okay.`)).toMatchObject({ ok: false, reason: 'slot_refused' });
    expect(evidence(`${agreed}\nCaller: Actually three instead.\nAgent: We will do that.`)).toMatchObject({ ok: false, reason: 'slot_refused' });
    expect(evidence(`${agreed}\nCaller: Can we do three?\nAgent: We will do that.`)).toMatchObject({ ok: false, reason: 'slot_refused' });
    expect(evidence(`${agreed}\nCaller: Make that three.\nAgent: We will do that.`)).toMatchObject({ ok: false, reason: 'slot_refused' });
    expect(evidence(`${agreed}\nCaller: Make that one.\nAgent: We will do that.`)).toMatchObject({ ok: false, reason: 'slot_refused' });
    expect(evidence(`${agreed}\nCaller: Thanks, and one more thing, my name is spelled with a C.`).ok).toBe(true);
    // Before the commitment too, from either side: an unmarked hour is a
    // correction no mention reads.
    expect(evidence('Agent: Would Thursday at two work?\nCaller: Make that three.\nAgent: I will put you down.'))
      .toMatchObject({ ok: false, reason: 'slot_refused' });
    expect(evidence('Caller: Can we do Thursday at two?\nAgent: Make that three. We will see you then.'))
      .toMatchObject({ ok: false, reason: 'slot_refused' });
    // Conservative by design: the caller repeating the slot after the
    // commitment makes it the last mention, with no commitment after it.
    expect(evidence(`${agreed}\nCaller: Thanks, Thursday at two is perfect.`).ok).toBe(false);
    // Any caller question after the commitment keeps the slot open, even one
    // shaped like a closer ("Anything else available?").
    expect(evidence(`${agreed} Anything else?\nCaller: Anything else available?`).ok).toBe(false);
    expect(evidence(`${agreed} Anything else?\nCaller: Is there anything else I need to do before then?`).ok).toBe(false);
  });

  test('a range takes its am/pm from its end, and an am/pm on its start keeps it one range', () => {
    const fromTwo = 'Caller: Can we move my visit?\nAgent: We will see you Thursday from 2 pm to 4 pm.';
    expect(evidence(fromTwo, '2026-09-24T16:00:00-04:00')).toMatchObject({ ok: false, reason: 'last_hour_ref_mismatch' });
    expect(evidence(fromTwo).ok).toBe(true);
    const evening = 'Caller: Can we move my visit?\nAgent: We will see you Thursday between eight and ten pm.';
    expect(evidence(evening, '2026-09-24T08:00:00-04:00')).toMatchObject({ ok: false, reason: 'last_hour_ref_mismatch' });
    expect(evidence(evening, '2026-09-24T20:00:00-04:00').ok).toBe(true);
  });

  // The agent repeating the slot does not clear what the caller said after
  // it was first put to them; the agent's own "let me check" meanwhile is
  // part of settling it.
  test('a caller objection stands however the agent then repeats the slot', () => {
    expect(evidence('Agent: Would Thursday at two work?\nCaller: No, I cannot make it.\nAgent: Okay, I will put you down for Thursday at two.'))
      .toMatchObject({ ok: false, reason: 'slot_refused' });
    expect(evidence('Agent: Would Thursday at two work?\nCaller: I need to ask my husband.\nAgent: Okay, I will put you down for Thursday at two.'))
      .toMatchObject({ ok: false, reason: 'hedge_on_slot' });
    expect(evidence('Agent: Would Thursday at two work?\nCaller: How about three?\nAgent: Okay, I will put you down for Thursday at two.').ok).toBe(false);
    // The caller's own first mention of the slot counts too, less a leading
    // "no" answering what came before it.
    expect(evidence('Caller: I cannot make it Thursday at two.\nAgent: Okay, I will put you down for Thursday at two.').ok).toBe(false);
    expect(evidence('Caller: I need to ask my husband about Thursday at two.\nAgent: Okay, I will put you down for Thursday at two.').ok).toBe(false);
    expect(evidence('Agent: How about Friday at two?\nCaller: No, Thursday at two.\nAgent: Okay, I will put you down for Thursday at two.').ok).toBe(true);
    // A caller's condition on the slot is a hedge; a polite request is not.
    expect(evidence('Caller: If my husband agrees, Thursday at two.\nAgent: I will put you down.').ok).toBe(false);
    expect(evidence('Caller: Can we do Thursday at two?\nAgent: I will put you down.\nCaller: Only if my husband agrees.').ok).toBe(false);
    expect(evidence('Caller: If you could come Thursday at two, that would be great.\nAgent: I will put you down.').ok).toBe(true);
    // The reply completing the slot can refuse it too.
    expect(evidence('Agent: Would Thursday at two work?\nCaller: That won\'t work. Thursday at two is when I have another appointment.\nAgent: I will put you down.').ok).toBe(false);
    // An objection to the day stands before the hour is named.
    expect(evidence('Agent: Would Thursday work?\nCaller: No, I cannot make it.\nAgent: Okay, we will see you Thursday at two.').ok).toBe(false);
    expect(evidence('Agent: Would Thursday work?\nCaller: Yes.\nAgent: Okay, we will see you Thursday at two.').ok).toBe(true);
    expect(evidence('Agent: Would Thursday at two work?\nCaller: Yes, Thursday works.\nAgent: Great, I will put you down for Thursday at two.').ok).toBe(true);
    expect(evidence('Caller: Can we do Thursday at two?\nAgent: Let me check.\nAgent: Okay, we will see you Thursday at two.').ok).toBe(true);
    // A counter-proposal the caller then takes, or the caller offering two
    // hours the agent picks between, is agreement.
    expect(evidence('Caller: Can we do Friday at two?\nAgent: How about Thursday at two?\nCaller: Sure.\nAgent: Great, I will put you down.').ok).toBe(true);
    expect(evidence('Caller: Can we do Thursday? At 11 o clock, 2 o clock?\nAgent: Yep, we will switch it to two.').ok).toBe(true);
    // Replay shapes: a "no" answering talk of another time chooses the slot,
    // and chatter after the caller's own "yes" to the slot is not a reply to it.
    expect(evidence(['Agent: Is 8 AM on Monday too early, or we could do 11 AM?', 'Caller: That sounds good.',
      'Agent: Okay. Well, you do not want to do 8?', 'Caller: No.', 'Agent: All right, let us do 11 then.', 'Caller: Okay.',
      'Agent: Yep, we will see you Monday at 11.'].join('\n'), '2026-09-28T11:00:00-04:00').ok).toBe(true);
    expect(evidence(['Agent: You want to do Thursday at two?', 'Caller: Thursday at two, yes. I have an appointment at four, but Thursday at two.',
      'Agent: Yep, and we will be better about texting.', 'Caller: I understand, with the rain you might cancel.', 'Agent: That is on us.',
      'Caller: Yeah, okay.', 'Agent: All right, I will see you Thursday at two.'].join('\n')).ok).toBe(true);
  });

  // Codex #5071 round 2.
  test('a comparative reply, a bound instead of an hour, or a range of days settles nothing', () => {
    expect(evidence('Agent: Would Thursday at two work?\nCaller: That is too late.\nAgent: We will see you Thursday at two.').ok).toBe(false);
    for (const bound of ['before noon', 'by noon', 'after noon', 'until noon']) {
      expect(evidence(`Caller: Can we move it?\nAgent: We will see you Thursday ${bound}.`, '2026-09-24T12:00:00-04:00').ok).toBe(false);
    }
    expect(evidence('Caller: Can we move it?\nAgent: We will see you sometime Monday through Thursday at two.').ok).toBe(false);
    expect(evidence('Caller: Can we move it?\nAgent: We will see you October 1 to October 8 at two.', '2026-10-08T14:00:00-04:00').ok).toBe(false);
    // A move from one day to another is not a range.
    expect(evidence('Caller: Can we move it from Friday to Thursday at two?\nAgent: We will see you then.').ok).toBe(true);
  });

  test('a numeric date keeps its stated year, and a fraction of an hour is not a date', () => {
    expect(evidence('Caller: Can we do 12/24/2027 at two?\nAgent: We will see you 12/24/2027 at two.', '2026-12-24T14:00:00-05:00').ok).toBe(false);
    expect(rescheduleAgreementEvidence({ transcript: 'Caller: It takes 1/2 hour, right? Can you move it?\nAgent: We will move you at two.',
      confirmedStartAt: '2027-01-02T14:00:00-05:00', callStartedAt: '2027-01-01T15:00:00Z' }).ok).toBe(false);
  });

  test('"I am" is not a time, and a courtesy "if" does not condition the commitment', () => {
    expect(evidence('Caller: Can we move my visit?\nAgent: We will see you Thursday at two.\nCaller: I am good, thank you.').ok).toBe(true);
    expect(evidence('Caller: Can we move my visit?\nAgent: We will see you Thursday at two, and if you need anything, call us.').ok).toBe(true);
  });

  test('an unlabeled transcript line fails closed rather than trusting turn order', () => {
    const r = evidence('Hello, this is a call with no speaker labels.');
    expect(r).toMatchObject({ ok: false, reason: 'unparseable_transcript' });
  });

  test('no day or hour reference anywhere in the call fails closed', () => {
    const r = evidence('Caller: Thanks for calling.\nAgent: You are welcome, have a good day.');
    expect(r).toMatchObject({ ok: false, reason: 'no_day_ref_in_call' });
  });

  test('an unparseable confirmed_start_at fails closed', () => {
    const r = evidence('Caller: Can we do Thursday at two?\nAgent: We will see you Thursday at two.', 'not-a-real-timestamp');
    expect(r).toMatchObject({ ok: false, reason: 'unparseable_or_out_of_range_slot' });
  });
});
