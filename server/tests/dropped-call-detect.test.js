/**
 * Dropped-call detector (services/dropped-call-detect.js).
 *
 * Pins the detector heuristic: endedAbruptly over the transcript tail, and
 * detectDroppedMidIntake (long enough, no address on either extraction leg,
 * abrupt ending). The detector opens the always-on call_dropped_mid_intake
 * review card; it sends nothing.
 */

const {
  endedAbruptly,
  detectDroppedMidIntake,
  MIN_CALL_SECONDS,
} = require('../services/dropped-call-detect');

describe('endedAbruptly', () => {
  const mk = (lines) => lines.join('\n');

  it('true for a mid-sentence cutoff at the contact exchange', () => {
    expect(endedAbruptly(mk([
      'Agent: When are you available to be on site?',
      'Caller: Tomorrow works.',
      'Agent: And what is your best email address and then your service address?',
      'Caller: Um, oh, you said — I do have one,',
    ]))).toBe(true);
  });

  it("open questions containing 'see you' are not farewells", () => {
    expect(endedAbruptly(mk([
      'Caller: I called last year I think.',
      "Agent: Hmm, I don't see you in our system — what is your service address?",
      'Caller: Sure, it is one eight —',
      'Caller: Are you there?',
    ]))).toBe(true);
  });

  it('false when the tail carries a farewell', () => {
    expect(endedAbruptly(mk([
      'Caller: That all sounds right.',
      'Agent: Great, see you Tuesday.',
      'Caller: Thank you.',
      'Agent: Bye-bye.',
    ]))).toBe(false);
  });

  it('false when the tail thanks without a literal bye', () => {
    expect(endedAbruptly(mk([
      'Agent: We will get that quote over today.',
      'Caller: Perfect.',
      'Caller: Appreciate it.',
      'Agent: Talk soon.',
    ]))).toBe(false);
  });

  it('mid-tail acknowledgements do not mask a drop at the address exchange', () => {
    expect(endedAbruptly(mk([
      'Caller: Tomorrow works great.',
      'Agent: Sounds good — and what is your service address?',
      'Caller: Sure, it is one eight one —',
      'Caller: Hello? Can you hear me?',
    ]))).toBe(true);
  });

  it('weak farewell IN the final utterance still reads as a normal ending', () => {
    expect(endedAbruptly(mk([
      'Agent: We will see you Tuesday at nine.',
      'Caller: Perfect.',
      'Agent: Anything else I can help with?',
      'Caller: No, thanks so much.',
    ]))).toBe(false);
  });

  it("false for a completed call that just lacks a goodbye — 'No, that's all.' is not a drop", () => {
    expect(endedAbruptly(mk([
      'Agent: So we are set for Tuesday morning.',
      'Caller: Yes.',
      'Agent: Anything else I can help with today?',
      "Caller: No, that's all.",
    ]))).toBe(false);
  });

  it('false when the final utterance ends as a complete sentence (no positive cutoff evidence)', () => {
    expect(endedAbruptly(mk([
      'Agent: What area are you in?',
      'Caller: Bayshore Gardens.',
      'Agent: Great, we cover that.',
      'Caller: Okay then.',
    ]))).toBe(false);
  });

  it('true on connection-trouble language even when turns end with punctuation', () => {
    expect(endedAbruptly(mk([
      'Caller: It is one eight one one zero.',
      'Agent: Sorry, you cut out.',
      'Caller: Hello? Can you hear me?',
      'Caller: Hello?',
    ]))).toBe(true);
  });

  it('folds diarized wrap lines into their turn (wrapped farewell still detected)', () => {
    expect(endedAbruptly(mk([
      'Agent: We are all set for Tuesday.',
      'Caller: Perfect, works for me.',
      'Agent: Great talking with you.',
      'Caller: Thanks so',
      'much, bye now.',
    ]))).toBe(false);
  });

  it('wrapped mid-thought continuation still reads as a cutoff', () => {
    expect(endedAbruptly(mk([
      'Agent: What can I help with?',
      'Caller: I have rats in the garage.',
      'Agent: What is your service address?',
      'Caller: Sure, it is one',
      'eight one one zero,',
    ]))).toBe(true);
  });

  it('weak farewell mid-utterance never outranks a cutoff — "Thanks — what is your service add" detects', () => {
    expect(endedAbruptly(mk([
      'Caller: Tomorrow morning is fine.',
      'Agent: Great.',
      'Caller: Ready when you are.',
      'Agent: Thanks — now what is your service add',
    ]))).toBe(true);
  });

  it("'take care of the ants' mid-question is not a farewell", () => {
    expect(endedAbruptly(mk([
      'Caller: I keep seeing ants by the sink.',
      'Agent: We can take care of the ants — what is your service address?',
      'Caller: It is one eight',
      'Caller: one one zero,',
    ]))).toBe(true);
  });

  it('false for transcripts too short to judge', () => {
    expect(endedAbruptly(mk(['Agent: Hello?', 'Caller: Hi —']))).toBe(false);
    expect(endedAbruptly('')).toBe(false);
  });
});

describe('detectDroppedMidIntake', () => {
  const ABRUPT = 'Agent: One?\nCaller: Two.\nAgent: What is your service address?\nCaller: It is —';

  it('fires on a long abrupt call with no address on either extraction leg', () => {
    expect(detectDroppedMidIntake({
      durationSeconds: 300, transcription: ABRUPT, extracted: {}, v2Extraction: null,
    })).toBe(true);
  });

  it('needs at least MIN_CALL_SECONDS of conversation', () => {
    expect(detectDroppedMidIntake({ durationSeconds: MIN_CALL_SECONDS, transcription: ABRUPT, extracted: {} })).toBe(true);
    expect(detectDroppedMidIntake({ durationSeconds: MIN_CALL_SECONDS - 1, transcription: ABRUPT, extracted: {} })).toBe(false);
  });

  it('does not fire when the V2 canonical extraction already holds the street', () => {
    expect(detectDroppedMidIntake({
      durationSeconds: 300,
      transcription: ABRUPT,
      extracted: {},
      v2Extraction: { property: { service_address: { street_line_1: '123 Main St' } } },
    })).toBe(false);
  });

  it('does not fire when V1 captured the street, or the call is short', () => {
    expect(detectDroppedMidIntake({
      durationSeconds: 300, transcription: ABRUPT, extracted: { address_line1: '123 Main St' },
    })).toBe(false);
    expect(detectDroppedMidIntake({ durationSeconds: 60, transcription: ABRUPT, extracted: {} })).toBe(false);
  });
});
