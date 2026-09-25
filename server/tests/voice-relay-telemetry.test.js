/**
 * Voice-relay telemetry — what the caller heard and when.
 *
 * Per-turn stats (monotonic clock), the played-text record (utteranceUntilInterrupt
 * / tokens-played rewrite the stored agent text; the full model text survives
 * in `planned`), the relay event classifier, the latency summary, and the
 * version stamps every later bake-off / audit finding is attributed by.
 */
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/lead-from-extraction', () => ({ createLeadFromExtraction: jest.fn() }));
jest.mock('../services/conversations', () => ({ syncVoiceMessageForCall: jest.fn() }));

const logger = require('../services/logger');
const db = require('../models/db');
const { RelayConversation, MODEL } = require('../services/voice-agent/relay-conversation');
const { classifyRelayEvent } = require('../services/voice-agent/relay-protocol');
const { summarizeTurnStats, storedTurnStats, buildTranscriptUpdate, LATENCY_BOUNDARIES, LATENCY_BOUNDARIES_VERSION } = require('../services/voice-agent/relay-transcript');

function convoWithSpokenTurn({ callSid = 'CA-tel-1', ...rest } = {}) {
  const send = jest.fn();
  const convo = new RelayConversation({ callSid, from: '+19415551234', send, ...rest });
  // Drive a caller turn without a model: _runLoop early-returns (no Anthropic
  // client in tests) after the stat is created, then the agent "speaks".
  const stat = { turn: 1, promptAt: 1000, callerSpeechStoppedAt: null, loopStartAt: 1001, firstTokenAt: null, firstSendAt: null, agentSpeakingStartAt: null, agentSpeakingEndAt: null, modelMs: 0, toolMs: 0, toolCount: 0, rounds: 0, effort: 'low', renderer: 'block', interrupted: false, durationUntilInterruptMs: null, interruptWithoutFollowupTranscript: false, timedOut: false, partialCount: 0, playedSource: 'assumed', agentEntries: [] };
  convo._turnStats.push(stat);
  convo._currentTurn = stat;
  return { convo, stat, send };
}

const agentEntries = (convo) => convo._transcript.filter((t) => t.role === 'agent');

describe('classifyRelayEvent — tolerant of the undocumented payload', () => {
  test.each([
    [{ type: 'info', name: 'agentSpeaking', state: 'started' }, 'agent_speaking_start'],
    [{ type: 'info', name: 'agentSpeaking', state: 'stopped' }, 'agent_speaking_end'],
    [{ type: 'speaker-event', event: 'agent_speaking', speaking: false }, 'agent_speaking_end'],
    [{ type: 'speaker-event', event: 'clientSpeaking', speaking: true }, 'caller_speaking_start'],
    [{ type: 'info', payload: { event: 'clientSpeaking', status: 'ended' } }, 'caller_speaking_end'],
    [{ type: 'info', name: 'agentSpeaking' }, 'agent_speaking_start'],
    [{ type: 'info', name: 'agentSpeakingStopped' }, 'agent_speaking_end'],
    [{ type: 'info', name: 'clientSpeakingStarted' }, 'caller_speaking_start'],
    [{ type: 'tokens-played', tokens: 'Waves, this is Sandy.' }, 'tokens_played'],
    [{ type: 'info', name: 'tokensPlayed', playedText: 'How can I help' }, 'tokens_played'],
    [{ type: 'info', name: 'tokensPlayed', value: 'How can I help' }, 'tokens_played'],
    [{ type: 'something-new', foo: 'bar' }, 'unknown'],
    [null, 'unknown'],
    ['nope', 'unknown'],
  ])('%j ⇒ %s', (frame, kind) => {
    expect(classifyRelayEvent(frame).kind).toBe(kind);
  });

  test("Twilio's documented info envelope — the label in `name`, the text in `value` (codex r1 P1)", () => {
    const ev = classifyRelayEvent({ type: 'info', name: 'tokensPlayed', value: 'Waves, this is Sandy.' });
    expect(ev).toEqual({ kind: 'tokens_played', shape: 'info:name,type,value', text: 'Waves, this is Sandy.' });
    // The label decides the kind BEFORE any value is read: a played sentence
    // that mentions the speakers is still what the caller heard (codex r2 P1).
    const spoken = classifyRelayEvent({ type: 'info', name: 'tokensPlayed', value: 'I hear the caller speaking over the agent speaking.' });
    expect(spoken).toMatchObject({ kind: 'tokens_played', text: 'I hear the caller speaking over the agent speaking.' });
    // The label is read from label fields only — played TEXT mentioning a
    // token does not make an unrelated frame a tokens-played event.
    expect(classifyRelayEvent({ type: 'info', name: 'somethingElse', value: 'played a token' }).kind).toBe('unknown');
  });

  test('the shape names keys only — never values', () => {
    const ev = classifyRelayEvent({ type: 'tokens-played', tokens: 'your card number is 4111' });
    expect(ev.shape).toBe('tokens-played:tokens,type');
    expect(ev.shape).not.toContain('4111');
    expect(ev.text).toBe('your card number is 4111'); // our own agent speech, routed to the record, never logged
  });
});

describe('per-turn stats', () => {
  test('handlePrompt stamps the prompt arrival; say() stamps first send and links the agent entry', async () => {
    const send = jest.fn();
    const convo = new RelayConversation({ callSid: 'CA-tel-2', from: '+19415551234', send });
    await convo.handlePrompt('hi there');
    expect(convo._turnStats).toHaveLength(1);
    const stat = convo._turnStats[0];
    expect(stat.turn).toBe(1);
    expect(Number.isFinite(stat.promptAt)).toBe(true);
    expect(stat.loopStartAt).toBeGreaterThanOrEqual(stat.promptAt);
    // The turn spoke, so its log line waits for Twilio's agent-speaking event.
    expect(logger.info.mock.calls.some((c) => /\[voice-relay\] turn=1 /.test(c[0]))).toBe(false);
    convo.handleRelayEvent({ type: 'info', name: 'agentSpeaking', state: 'started' });
    // The turn log line ran once and carries durations, never text.
    const line = logger.info.mock.calls.map((c) => c[0]).find((s) => /\[voice-relay\] turn=1 /.test(s));
    expect(line).toMatch(/endpoint=n\/a firstToken=n\/a/);
    expect(line).not.toContain('hi there');

    // (No Anthropic client in tests: the loop already spoke the "unavailable"
    // line on this turn, which is why firstSendAt is set and one entry exists.)
    expect(Number.isFinite(stat.firstSendAt)).toBe(true);
    const firstSendAt = stat.firstSendAt;
    convo._currentTurn = stat;
    convo.say('I can help with that.');
    expect(stat.firstSendAt).toBe(firstSendAt); // first send is stamped once per turn
    expect(stat.agentEntries).toHaveLength(2);
    expect(stat.agentEntries[1]).toMatchObject({ role: 'agent', text: 'I can help with that.', planned: 'I can help with that.', playedSource: 'assumed', interrupted: false, turn: 1 });
    expect(send).toHaveBeenCalledWith('I can help with that.');
  });

  test('a caller-stop event just before the prompt becomes the turn endpoint; a stale one does not', async () => {
    const convo = new RelayConversation({ callSid: 'CA-tel-3', from: '+19415551234', send: jest.fn() });
    convo.handleRelayEvent({ type: 'info', name: 'clientSpeaking', state: 'stopped' });
    await convo.handlePrompt('first');
    expect(convo._turnStats[0].callerSpeechStoppedAt).not.toBeNull();
    expect(convo._turnStats[0].promptAt).toBeGreaterThanOrEqual(convo._turnStats[0].callerSpeechStoppedAt);
    // Consumed: the next turn does not reuse it.
    await convo.handlePrompt('second');
    expect(convo._turnStats[1].callerSpeechStoppedAt).toBeNull();
  });

  test('agent speaking start/end land on the turn that spoke; tokens-played rewrites what the caller heard', () => {
    const { convo, stat } = convoWithSpokenTurn();
    convo.say('Your next service is Tuesday at nine. Anything else?');
    convo.handleRelayEvent({ type: 'info', name: 'agentSpeaking', state: 'started' });
    expect(stat.agentSpeakingStartAt).not.toBeNull();
    convo.handleRelayEvent({ type: 'tokens-played', tokens: 'Your next service is Tuesday' });
    convo.handleRelayEvent({ type: 'tokens-played', tokens: 'at nine.' });
    convo.handleRelayEvent({ type: 'info', name: 'agentSpeaking', state: 'stopped' });
    expect(stat.agentSpeakingEndAt).toBeGreaterThanOrEqual(stat.agentSpeakingStartAt);
    expect(stat.playedSource).toBe('twilio_event');
    const entry = agentEntries(convo)[0];
    expect(entry.played).toBe('Your next service is Tuesday at nine.');
    expect(entry.text).toBe('Your next service is Tuesday at nine.');
    expect(entry.planned).toBe('Your next service is Tuesday at nine. Anything else?');
    expect(entry.done).toBe(false); // not the whole utterance yet
  });

  // ⭐ A BURST OF QUEUED PROMPTS. Three final prompts land while turn 1 is
  // still processing: three stats exist, only turn 1 has sent. Its speaking
  // events must still find it (codex r13 P2 — the old two-entry window lost it).
  test('agent speaking events find the sent turn behind two queued, unsent prompts', () => {
    const { convo, stat } = convoWithSpokenTurn();
    convo.say('One moment.'); // turn 1 sent
    const queued = (turn) => ({ ...stat, turn, firstSendAt: null, agentSpeakingStartAt: null, agentSpeakingEndAt: null, interrupted: false, agentEntries: [] });
    convo._turnStats.push(queued(2), queued(3));
    convo.handleRelayEvent({ type: 'info', name: 'agentSpeaking', state: 'started' });
    expect(stat.agentSpeakingStartAt).not.toBeNull();
    expect(convo._turnStats[1].agentSpeakingStartAt).toBeNull();
    convo.handleRelayEvent({ type: 'info', name: 'agentSpeaking', state: 'stopped' });
    expect(stat.agentSpeakingEndAt).toBeGreaterThanOrEqual(stat.agentSpeakingStartAt);
    // …and a later sent turn takes the NEXT start, not turn 1's slot again.
    convo._turnStats[1].firstSendAt = stat.firstSendAt + 10;
    convo.handleRelayEvent({ type: 'info', name: 'agentSpeaking', state: 'started' });
    expect(convo._turnStats[1].agentSpeakingStartAt).not.toBeNull();
  });

  test('a cumulative tokens-played snapshot replaces rather than duplicates, and a complete utterance retires', () => {
    const { convo } = convoWithSpokenTurn();
    convo.say('Hello there, this is Sandy.');
    convo.handleRelayEvent({ type: 'tokens-played', tokens: 'Hello there,' });
    convo.handleRelayEvent({ type: 'tokens-played', tokens: 'Hello there, this is Sandy.' });
    const entry = agentEntries(convo)[0];
    expect(entry.played).toBe('Hello there, this is Sandy.');
    expect(entry.done).toBe(true);
    expect(convo._playing).toHaveLength(0);
  });

  test('a legitimately repeated chunk is appended when the planned text continues with it; a true duplicate is not (codex r10 P2)', () => {
    const { convo } = convoWithSpokenTurn();
    convo.say('It is very very effective.');
    convo.handleRelayEvent({ type: 'tokens-played', tokens: 'It is very' });
    convo.handleRelayEvent({ type: 'tokens-played', tokens: 'very' });
    convo.handleRelayEvent({ type: 'tokens-played', tokens: 'very' }); // a redelivered chunk — planned does not continue with a third
    convo.handleRelayEvent({ type: 'tokens-played', tokens: 'effective.' });
    const entry = agentEntries(convo)[0];
    expect(entry.played).toBe('It is very very effective.');
    expect(entry.done).toBe(true);
  });

  test('an EQUAL repeated chunk at the start of an utterance is not mistaken for a cumulative snapshot (codex r11 P2)', () => {
    const { convo } = convoWithSpokenTurn();
    convo.say('very very effective');
    convo.handleRelayEvent({ type: 'tokens-played', tokens: 'very' });
    convo.handleRelayEvent({ type: 'tokens-played', tokens: 'very' });
    convo.handleRelayEvent({ type: 'tokens-played', tokens: 'effective' });
    const entry = agentEntries(convo)[0];
    expect(entry.played).toBe('very very effective');
    expect(entry.done).toBe(true);
    // …while a redelivered identical whole chunk still dedupes.
    const again = convoWithSpokenTurn({ callSid: 'CA-tel-dup' });
    again.convo.say('Hello there, this is Sandy.');
    again.convo.handleRelayEvent({ type: 'tokens-played', tokens: 'Hello there,' });
    again.convo.handleRelayEvent({ type: 'tokens-played', tokens: 'Hello there,' });
    expect(agentEntries(again.convo)[0].played).toBe('Hello there,');
  });

  test('a re-sent completion for an already-retired utterance never lands on the next one (codex r14 P2)', () => {
    const { convo } = convoWithSpokenTurn();
    convo.say('Let me check that for you.');
    convo.say('Your next visit is Tuesday.');
    convo.handleRelayEvent({ type: 'tokens-played', tokens: 'Let me check that for you.' }); // retires #1
    convo.handleRelayEvent({ type: 'tokens-played', tokens: 'Let me check that for you.' }); // Twilio repeats it
    const [filler, answer] = agentEntries(convo);
    expect(filler.done).toBe(true);
    expect(answer.played).toBeNull(); // untouched by the repeat
    convo.handleRelayEvent({ type: 'tokens-played', tokens: 'Your next visit' });
    expect(answer.played).toBe('Your next visit'); // later valid tokens still match
  });

  // ⭐ ONE CALLER TURN, TWO UTTERANCES. A read-tool round speaks its filler,
  // the tool runs, then the answer is spoken. Tokens belong to the utterance
  // they fit, never to "the latest one".
  test('two utterances in one turn keep their own played text', () => {
    const { convo } = convoWithSpokenTurn();
    convo.say('Let me check that for you.');
    convo.say('Your next visit is Tuesday at nine.');
    convo.handleRelayEvent({ type: 'tokens-played', tokens: 'Let me check that for you.' });
    convo.handleRelayEvent({ type: 'tokens-played', tokens: 'Your next visit is' });
    const [filler, answer] = agentEntries(convo);
    expect(filler).toMatchObject({ text: 'Let me check that for you.', played: 'Let me check that for you.', done: true });
    expect(answer).toMatchObject({ text: 'Your next visit is', played: 'Your next visit is', done: false });
    expect(answer.planned).toBe('Your next visit is Tuesday at nine.');
  });

  test('tokens that only fit a LATER utterance retire the earlier ones as finished', () => {
    const { convo } = convoWithSpokenTurn();
    convo.say('One moment.');
    convo.say('The office opens at eight.');
    convo.handleRelayEvent({ type: 'tokens-played', tokens: 'The office opens' });
    const [first, second] = agentEntries(convo);
    expect(first).toMatchObject({ text: 'One moment.', done: true, playedSource: 'assumed' });
    expect(second).toMatchObject({ played: 'The office opens', done: false });
  });

  test('the turn log waits for the agent-speaking event so firstAudio is real, and end() flushes the rest (codex r3 P2)', async () => {
    const { convo, stat } = convoWithSpokenTurn({ callSid: 'CA-tel-log' });
    stat.callerSpeechStoppedAt = performance.now() - 100; // firstAudio is measured from the caller's stop, on the same clock as now()
    convo.say('One moment.');
    logger.info.mockClear();
    convo._finishTurn(stat);
    expect(stat.logged).toBeUndefined();
    expect(logger.info.mock.calls.some(([m]) => /turn=1/.test(m))).toBe(false);
    convo.handleRelayEvent({ type: 'info', name: 'agentSpeaking', state: 'started' });
    const line = logger.info.mock.calls.map(([m]) => m).find((m) => /turn=1/.test(m));
    expect(line).toMatch(/firstAudio=\d+ms/);
    expect(stat.logged).toBe(true);
    // A turn whose event never comes is flushed at close.
    const second = { ...stat, turn: 2, logged: undefined, awaitingAudio: undefined, agentSpeakingStartAt: null };
    convo._turnStats.push(second);
    convo._finishTurn(second);
    expect(second.logged).toBeUndefined();
    convo.leadCaptured = true; // keep the hangup capture floor out of this test
    await convo.end('caller_hangup');
    expect(second.logged).toBe(true);
  });

  test('Flux partial prompts are counted on the turn they precede, never acted on — after the first turn too (codex r2 P1)', async () => {
    const convo = new RelayConversation({ callSid: 'CA-tel-4', from: '+19415551234', send: jest.fn() });
    convo.notePartialPrompt();
    convo.notePartialPrompt();
    await convo.handlePrompt('full utterance');
    expect(convo._turnStats[0].partialCount).toBe(2);
    expect(convo._userTurns).toEqual(['full utterance']);
    // Turn 2's partials precede turn 2's final prompt — they never land on turn 1.
    convo.notePartialPrompt();
    convo.notePartialPrompt();
    convo.notePartialPrompt();
    await convo.handlePrompt('second utterance');
    expect(convo._turnStats[0].partialCount).toBe(2);
    expect(convo._turnStats[1].partialCount).toBe(3);
  });
});

describe('events subscribed / received — trustworthy measurement (brief §3A)', () => {
  test('no relay profile ⇒ speaker-events/tokens-played were never subscribed (confirmed false, not unknown)', () => {
    const convo = new RelayConversation({ callSid: 'CA-obs-1', from: '+19415551234', send: jest.fn() });
    expect(convo._relayEventsSubscribed).toEqual({ speaker: false, tokensPlayed: false });
    expect(convo._eventsTelemetry()).toMatchObject({
      subscribed: { speaker: false, tokensPlayed: false },
      counts: {},
      shapes: {},
    });
  });

  test('a known profile whose events attribute includes both ⇒ subscribed true', () => {
    const convo = new RelayConversation({ callSid: 'CA-obs-2', from: '+19415551234', send: jest.fn(), relayProfileId: 'flux_balanced_v1' });
    expect(convo._relayEventsSubscribed).toEqual({ speaker: true, tokensPlayed: true });
  });

  test('an unresolvable profile id (e.g. a sandbox raw-attribute hash) is reported UNKNOWN, never guessed', () => {
    const convo = new RelayConversation({ callSid: 'CA-obs-3', from: '+19415551234', send: jest.fn(), relayProfileId: 'sandbox_raw_deadbeefcafe' });
    expect(convo._relayEventsSubscribed).toEqual({ speaker: null, tokensPlayed: null });
  });

  test('handleRelayEvent counts every classified kind and records its shape ONCE per kind — even when two kinds share an identical shape', () => {
    const convo = new RelayConversation({ callSid: 'CA-obs-4', from: '+19415551234', send: jest.fn() });
    logger.info.mockClear(); // isolate this test's log lines from earlier tests sharing the module-level mock
    // Both frames below have the identical key set (speaker-event:event,speaking,type)
    // but classify as two DIFFERENT kinds — a per-shape dedupe would have logged
    // only the first; per-kind dedupe must record both.
    convo.handleRelayEvent({ type: 'speaker-event', event: 'clientSpeaking', speaking: true }); // caller_speaking_start
    convo.handleRelayEvent({ type: 'speaker-event', event: 'agent_speaking', speaking: false }); // agent_speaking_end
    convo.handleRelayEvent({ type: 'speaker-event', event: 'clientSpeaking', speaking: false }); // caller_speaking_end
    convo.handleRelayEvent({ type: 'tokens-played', tokens: 'hello there' });
    convo.handleRelayEvent({ type: 'tokens-played', tokens: 'again' }); // same kind, second occurrence — not re-logged
    const telemetry = convo._eventsTelemetry();
    expect(telemetry.counts).toEqual({ caller_speaking_start: 1, agent_speaking_end: 1, caller_speaking_end: 1, tokens_played: 2 });
    expect(telemetry.shapes).toEqual({
      caller_speaking_start: 'speaker-event:event,speaking,type',
      agent_speaking_end: 'speaker-event:event,speaking,type',
      caller_speaking_end: 'speaker-event:event,speaking,type',
      tokens_played: 'tokens-played:tokens,type',
    });
    // Logged once per KIND, not once per shape.
    const shapeLines = logger.info.mock.calls.map((c) => c[0]).filter((s) => /relay event shape seen/.test(s));
    expect(shapeLines).toHaveLength(4);
  });

  test('the per-turn log line names whether events were subscribed and how many of each kind arrived', async () => {
    const convo = new RelayConversation({ callSid: 'CA-obs-5', from: '+19415551234', send: jest.fn(), relayProfileId: 'flux_balanced_v1' });
    await convo.handlePrompt('hi there');
    logger.info.mockClear(); // isolate: only this call's own turn=1 line should be found below
    convo.handleRelayEvent({ type: 'info', name: 'agentSpeaking', state: 'started' });
    const line = logger.info.mock.calls.map((c) => c[0]).find((s) => /\[voice-relay\] turn=1 /.test(s));
    expect(line).toContain('events=subscribed');
    expect(line).toMatch(/eventCounts=caller_speaking_end=0,agent_speaking_start=1,agent_speaking_end=0,tokens_played=0/);
  });

  test('no profile ⇒ the per-turn log line reports events=none', async () => {
    const convo = new RelayConversation({ callSid: 'CA-obs-6', from: '+19415551234', send: jest.fn() });
    await convo.handlePrompt('hi there');
    logger.info.mockClear(); // isolate: only this call's own turn=1 line should be found below
    convo.handleRelayEvent({ type: 'info', name: 'agentSpeaking', state: 'started' });
    const line = logger.info.mock.calls.map((c) => c[0]).find((s) => /\[voice-relay\] turn=1 /.test(s));
    expect(line).toContain('events=none');
  });

  test('each turn stat carries the session/segment generation it ran under, so a metric survives being pulled out of the session (brief §3A item 4)', async () => {
    const convo = new RelayConversation({ callSid: 'CA-obs-7', from: '+19415551234', sessionGeneration: 42, send: jest.fn() });
    await convo.handlePrompt('hi there');
    expect(convo._turnStats[0].segmentGeneration).toBe(42);
    expect(storedTurnStats(convo._turnStats)[0]).toMatchObject({ segmentGeneration: 42 });
    // turn index / model round count / renderer were already carried — reused, not duplicated.
    expect(convo._turnStats[0]).toMatchObject({ turn: 1, rounds: expect.any(Number), renderer: expect.any(String) });
  });

  test('no reconnect/segment concept in play ⇒ null, not 0 (a real generation 0 would be indistinguishable)', async () => {
    const convo = new RelayConversation({ callSid: 'CA-obs-8', from: '+19415551234', send: jest.fn() });
    await convo.handlePrompt('hi there');
    expect(convo._turnStats[0].segmentGeneration).toBeNull();
  });
});

describe('interrupt(detail) — the record is what the caller heard', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  test('a relay interrupt truncates the stored agent text to the played utterance and marks the turn', () => {
    const { convo, stat } = convoWithSpokenTurn();
    convo.say('I can get someone out Tuesday morning, and we will send a confirmation.');
    convo.interrupt({ utteranceUntilInterrupt: 'I can get someone out Tuesday', durationUntilInterruptMs: 1840 });
    expect(stat.interrupted).toBe(true);
    expect(stat.durationUntilInterruptMs).toBe(1840);
    expect(stat.playedSource).toBe('interrupt_truncation');
    const entry = agentEntries(convo)[0];
    expect(entry.text).toBe('I can get someone out Tuesday [interrupted]');
    expect(entry.planned).toBe('I can get someone out Tuesday morning, and we will send a confirmation.');
    expect(entry).toMatchObject({ interrupted: true, done: true });
    expect(convo._playing).toHaveLength(0);
  });

  test('a bare interrupt() (end()\'s own abort) records nothing', () => {
    const { convo, stat } = convoWithSpokenTurn();
    convo.say('Goodbye.');
    convo.interrupt();
    expect(stat.interrupted).toBe(false);
    expect(agentEntries(convo)[0].text).toBe('Goodbye.');
  });

  test('an interrupt with no utterance never credits the planned text (codex r4 P2)', () => {
    const { convo, stat } = convoWithSpokenTurn();
    convo.say('I can get someone out Tuesday morning.');
    convo.interrupt({ durationUntilInterruptMs: 40 });
    expect(stat.interrupted).toBe(true);
    const [entry] = agentEntries(convo);
    expect(entry.text).toBe('[interrupted — played text unknown]');
    expect(entry.playedSource).toBe('interrupt_truncation');
  });

  test('a longer, compatible interrupt prefix extends an earlier tokens-played chunk (codex r6 P2)', () => {
    const { convo, stat } = convoWithSpokenTurn();
    convo.say('One two three four five.');
    convo.handleRelayEvent({ type: 'tokens-played', tokens: 'One two' });
    convo.interrupt({ utteranceUntilInterrupt: 'One two three four', durationUntilInterruptMs: 900 });
    expect(stat.playedSource).toBe('twilio_event');
    expect(agentEntries(convo)[0].text).toBe('One two three four [interrupted]');
    // An INCOMPATIBLE longer prefix is not trusted over the event.
    const other = convoWithSpokenTurn({ callSid: 'CA-tel-x' });
    other.convo.say('One two three four five.');
    other.convo.handleRelayEvent({ type: 'tokens-played', tokens: 'One two' });
    other.convo.interrupt({ utteranceUntilInterrupt: 'Something else entirely', durationUntilInterruptMs: 900 });
    expect(agentEntries(other.convo)[0].text).toBe('One two [interrupted]');
  });

  test('tokens-played outranks the interrupt utterance for the played text', () => {
    const { convo, stat } = convoWithSpokenTurn();
    convo.say('One two three four.');
    convo.handleRelayEvent({ type: 'tokens-played', tokens: 'One two' });
    convo.interrupt({ utteranceUntilInterrupt: 'One', durationUntilInterruptMs: 300 });
    expect(stat.playedSource).toBe('twilio_event');
    expect(agentEntries(convo)[0].text).toBe('One two [interrupted]');
  });

  // ⭐ A BARGE-IN DROPS THE QUEUE. The filler was cut; the answer queued
  // behind it was never played — the record must not credit it.
  test('an interrupt during the first utterance marks the queued second one as not played', () => {
    const { convo } = convoWithSpokenTurn();
    convo.say('Let me check that for you.');
    convo.say('Your next visit is Tuesday at nine.');
    convo.interrupt({ utteranceUntilInterrupt: 'Let me check', durationUntilInterruptMs: 600 });
    const [filler, answer] = agentEntries(convo);
    expect(filler.text).toBe('Let me check [interrupted]');
    expect(answer).toMatchObject({ text: '[not played — caller interrupted]', notPlayed: true, played: '', done: true });
    expect(answer.planned).toBe('Your next visit is Tuesday at nine.');
  });

  test('an interrupt that names the SECOND utterance leaves the first intact', () => {
    const { convo } = convoWithSpokenTurn();
    convo.say('Let me check that for you.');
    convo.say('Your next visit is Tuesday at nine.');
    convo.interrupt({ utteranceUntilInterrupt: 'Your next visit', durationUntilInterruptMs: 2100 });
    const [filler, answer] = agentEntries(convo);
    expect(filler).toMatchObject({ text: 'Let me check that for you.', interrupted: false, done: true });
    expect(answer.text).toBe('Your next visit [interrupted]');
  });

  test('a new caller turn retires the queue, so a later interrupt never truncates an old utterance', async () => {
    const convo = new RelayConversation({ callSid: 'CA-q-1', from: '+19415551234', send: jest.fn() });
    const first = await (async () => { const p = convo.handlePrompt('hello'); jest.advanceTimersByTime(1); await p; return agentEntries(convo)[0]; })();
    expect(first).toBeDefined(); // the "unavailable" line (no model client in tests)
    const p2 = convo.handlePrompt('one more thing');
    jest.advanceTimersByTime(1);
    await p2;
    expect(first.done).toBe(true);
    convo.interrupt({ utteranceUntilInterrupt: 'Sorry', durationUntilInterruptMs: 100 });
    expect(first.interrupted).toBe(false);
    expect(agentEntries(convo)[1].interrupted).toBe(true);
  });

  test('no caller transcript within 1.5s of a barge-in ⇒ interrupt_without_followup_transcript', async () => {
    const { convo, stat } = convoWithSpokenTurn();
    convo.say('Let me check.');
    convo.interrupt({ utteranceUntilInterrupt: 'Let me', durationUntilInterruptMs: 200 });
    jest.advanceTimersByTime(1499);
    expect(stat.interruptWithoutFollowupTranscript).toBe(false);
    jest.advanceTimersByTime(2);
    expect(stat.interruptWithoutFollowupTranscript).toBe(true);
  });

  test('a hang-up inside the window closes the watch as missing follow-up (codex r9 P2)', async () => {
    const { convo, stat } = convoWithSpokenTurn();
    convo.say('Let me check.');
    convo.interrupt({ utteranceUntilInterrupt: 'Let me', durationUntilInterruptMs: 200 });
    jest.advanceTimersByTime(300);
    convo.leadCaptured = true; // keep the hangup capture floor out of this test
    const p = convo.end('caller_hangup');
    jest.advanceTimersByTime(5000);
    await p;
    expect(stat.interruptWithoutFollowupTranscript).toBe(true);
    expect(convo._interruptFollowupTimer).toBeNull();
  });

  test('a caller prompt inside the window clears the watch', async () => {
    const { convo, stat } = convoWithSpokenTurn();
    convo.say('Let me check.');
    convo.interrupt({ utteranceUntilInterrupt: 'Let me', durationUntilInterruptMs: 200 });
    jest.advanceTimersByTime(300);
    const p = convo.handlePrompt('no wait, the other address');
    jest.advanceTimersByTime(3000);
    await p;
    expect(stat.interruptWithoutFollowupTranscript).toBe(false);
  });
});

describe('summarizeTurnStats — estimates and audio metrics never mix', () => {
  const turn = (over) => ({ promptAt: 0, callerSpeechStoppedAt: null, firstTokenAt: null, firstSendAt: null, agentSpeakingStartAt: null, modelMs: 0, toolMs: 0, toolCount: 0, rounds: 1, effort: 'low', renderer: 'block', interrupted: false, interruptWithoutFollowupTranscript: false, timedOut: false, partialCount: 0, playedSource: 'assumed', ...over });

  test('empty ⇒ zero turns and null percentiles', () => {
    expect(summarizeTurnStats([])).toMatchObject({ turns: 0, audio_metric_turns: 0, stop_to_first_audio_p50: null, prompt_to_first_send_p50: null, effort_counts: {}, played_sources: {} });
    expect(summarizeTurnStats(null).turns).toBe(0);
  });

  test('audio percentiles come only from turns with real speaker events', () => {
    const stats = [
      turn({ promptAt: 100, firstSendAt: 700, callerSpeechStoppedAt: 0, agentSpeakingStartAt: 1000, playedSource: 'twilio_event' }),
      turn({ promptAt: 100, firstSendAt: 900 }),   // estimate only — no events
      turn({ promptAt: 100, firstSendAt: 4200, toolMs: 3100, toolCount: 2, modelMs: 800, timedOut: true, interrupted: true }),
    ];
    const s = summarizeTurnStats(stats);
    expect(s.turns).toBe(3);
    expect(s.audio_metric_turns).toBe(1);
    expect(s.stop_to_first_audio_p50).toBe(1000);
    expect(s.stop_to_first_audio_p95).toBe(1000);
    expect(s.send_to_first_audio_p50).toBe(300);
    expect(s.stop_to_first_send_p50).toBe(700);
    expect(s.endpoint_delay_p50).toBe(100);
    expect(s.prompt_to_first_send_p50).toBe(800);
    expect(s.prompt_to_first_send_p95).toBe(4100);
    expect(s.tool_ms_total).toBe(3100);
    expect(s.tool_ms_max).toBe(3100);
    expect(s.tool_calls).toBe(2);
    expect(s.model_ms_total).toBe(800);
    expect(s.model_rounds).toBe(3);
    expect(s.long_silence_turns).toBe(1);
    expect(s.timed_out_turns).toBe(1);
    expect(s.barge_ins).toBe(1);
    expect(s.effort_counts).toEqual({ low: 3 });
    expect(s.played_sources).toEqual({ twilio_event: 1, assumed: 2 });
    // Every audio field had data ⇒ no null-explaining sibling fields at all.
    expect(s.missing).toBeUndefined();
    expect(s.audio_metrics_reason).toBeUndefined();
    expect(s.boundaries_version).toBe(1);
  });

  test('a garbage entry is ignored, never thrown on', () => {
    expect(() => summarizeTurnStats([null, 'x', turn({ promptAt: 5, firstSendAt: 1 })])).not.toThrow();
    expect(summarizeTurnStats([null, turn({})]).turns).toBe(1);
  });
});

describe('summarizeTurnStats — every null audio field is explainable (brief §3A)', () => {
  const turn = (over) => ({ promptAt: 0, callerSpeechStoppedAt: null, firstTokenAt: null, firstSendAt: null, agentSpeakingStartAt: null, modelMs: 0, toolMs: 0, toolCount: 0, rounds: 1, effort: 'low', renderer: 'block', interrupted: false, interruptWithoutFollowupTranscript: false, timedOut: false, partialCount: 0, playedSource: 'assumed', ...over });

  test('no turns at all ⇒ no reason fields (nothing happened yet, not a diagnosed failure)', () => {
    const s = summarizeTurnStats([]);
    expect(s.missing).toBeUndefined();
    expect(s.audio_metrics_reason).toBeUndefined();
    expect(s.boundaries_version).toBe(1);
    expect(s.observability).toEqual({ events_subscribed: { speaker: null, tokens_played: null }, events_received: {}, event_shapes: {} });
  });

  test('events_not_subscribed — no profile rendered the events attribute, every audio field null, one shared reason', () => {
    const stats = [turn({ promptAt: 500 }), turn({ promptAt: 900 })];
    const meta = { subscribed: { speaker: false, tokensPlayed: false }, counts: {}, shapes: {} };
    const s = summarizeTurnStats(stats, meta);
    expect(s.audio_metrics_reason).toBe('events_not_subscribed');
    expect(s.missing).toBeUndefined(); // the single shared-reason field replaces the per-field map
    expect(s.endpoint_delay_p50).toBeNull();
    expect(s.stop_to_first_audio_p50).toBeNull();
    expect(s.observability.events_subscribed).toEqual({ speaker: false, tokens_played: false });
  });

  test('no_events_received — subscribed (or unknown), but not a single speaker/tokens-played event arrived', () => {
    const stats = [turn({ promptAt: 500 })];
    const subscribedTrue = summarizeTurnStats(stats, { subscribed: { speaker: true, tokensPlayed: true }, counts: {} });
    expect(subscribedTrue.audio_metrics_reason).toBe('no_events_received');
    // Unknown subscription (e.g. a sandbox raw-attribute id) with zero arrivals
    // reads the same way — it is still, literally, true that none arrived.
    const unknown = summarizeTurnStats(stats, { subscribed: { speaker: null, tokensPlayed: null }, counts: {} });
    expect(unknown.audio_metrics_reason).toBe('no_events_received');
  });

  test('insufficient_turns — events DID arrive but never landed on a turn with both stamps; only the affected fields are named', () => {
    // One turn spoke and got an agent_speaking_start (send_to_first_audio is
    // fine), but no turn ever recorded a caller_speaking_end even though the
    // session-wide count says three arrived — a real caller_speaking_end was
    // received and is simply unusable for pairing, not "never subscribed".
    const stats = [turn({ promptAt: 0, firstSendAt: 500, agentSpeakingStartAt: 800 })];
    const meta = { subscribed: { speaker: true, tokensPlayed: true }, counts: { caller_speaking_end: 3, agent_speaking_start: 1 } };
    const s = summarizeTurnStats(stats, meta);
    expect(s.send_to_first_audio_p50).toBe(300); // unaffected — this one paired fine
    expect(s.missing).toEqual({
      endpoint_delay: 'insufficient_turns',
      stop_to_first_send: 'insufficient_turns',
      stop_to_first_audio: 'insufficient_turns',
    });
    expect(s.audio_metrics_reason).toBeUndefined(); // partial, not all four ⇒ the map, not the single reason
  });

  test('a received event count is persisted as observability evidence a call row can be diagnosed from alone', () => {
    const meta = {
      subscribed: { speaker: true, tokensPlayed: true },
      counts: { caller_speaking_end: 2, agent_speaking_start: 2, agent_speaking_end: 2, tokens_played: 5 },
      shapes: { caller_speaking_end: 'info:name,type', agent_speaking_start: 'info:name,type', tokens_played: 'tokens-played:tokens,type' },
    };
    const s = summarizeTurnStats([turn({ promptAt: 0, callerSpeechStoppedAt: 0, firstSendAt: 100, agentSpeakingStartAt: 200 })], meta);
    expect(s.observability).toEqual({
      events_subscribed: { speaker: true, tokens_played: true },
      events_received: { caller_speaking_end: 2, agent_speaking_start: 2, agent_speaking_end: 2, tokens_played: 5 },
      event_shapes: { caller_speaking_end: 'info:name,type', agent_speaking_start: 'info:name,type', tokens_played: 'tokens-played:tokens,type' },
    });
  });
});

describe('latency boundaries doc (brief §3A item 3)', () => {
  test('documents exactly the six persisted spans, each naming its clock kind', () => {
    expect(LATENCY_BOUNDARIES_VERSION).toBe(1);
    const fields = ['endpoint_delay', 'prompt_to_first_send', 'first_token', 'stop_to_first_send', 'send_to_first_audio', 'stop_to_first_audio'];
    expect(Object.keys(LATENCY_BOUNDARIES).sort()).toEqual(fields.sort());
    for (const field of fields) expect(typeof LATENCY_BOUNDARIES[field]).toBe('string');
    // Application-clock spans say so, and never claim a provider proxy.
    expect(LATENCY_BOUNDARIES.prompt_to_first_send).toMatch(/application-observed/i);
    expect(LATENCY_BOUNDARIES.first_token).toMatch(/application-observed/i);
    // Provider-derived spans are explicit that event arrival is a proxy.
    expect(LATENCY_BOUNDARIES.stop_to_first_audio).toMatch(/provider-reported/);
    expect(LATENCY_BOUNDARIES.send_to_first_audio).toMatch(/proxy/i);
  });
});

describe('version stamps', () => {
  test('every field a bake-off or audit needs, from the session — profile and voice from the TwiML parameters', () => {
    process.env.RAILWAY_GIT_COMMIT_SHA = 'abc123';
    const convo = new RelayConversation({ callSid: 'CA-v-1', from: '+19415551234', send: jest.fn(), relayProfileId: 'flux_balanced_v1', ttsVoice: 'NYC9WEgkq1u4jiqBseQ9-turbo_v2_5-0.8_0.8_0.6', language: 'es-US' });
    expect(convo._versionStamps()).toEqual({
      git_sha: 'abc123', model: MODEL, effort: 'low',
      prompt_sha: null, context_snapshot_sha: null, tool_schema_sha: null, policy_pack_sha: null,
      relay_profile_id: 'flux_balanced_v1', stt_language: 'es-US', tts_language: 'es-US',
      tts_provider: 'ElevenLabs', voice_id: 'NYC9WEgkq1u4jiqBseQ9', tts_model: 'turbo_v2_5', tts_settings: '0.8_0.8_0.6',
      renderer_version: 'block-v1', speech_format_version: null,
    });
    delete process.env.RAILWAY_GIT_COMMIT_SHA;
  });

  test('no profile ⇒ null profile id and the env default voice', () => {
    const stamps = new RelayConversation({ callSid: 'CA-v-2', from: '+19415551234', send: jest.fn() })._versionStamps();
    expect(stamps.relay_profile_id).toBeNull();
    expect(stamps.voice_id).toBe('21m00Tcm4TlvDq8ikWAM');
    expect(stamps.stt_language).toBe('en-US');
  });

  test('an empty tts_voice parameter (the Spanish leg with no configured voice) stamps NO voice, not the English default', () => {
    const stamps = new RelayConversation({ callSid: 'CA-v-5', from: '+19415551234', send: jest.fn(), ttsVoice: '', language: 'es-US' })._versionStamps();
    expect(stamps.voice_id).toBeNull();
    expect(stamps.tts_model).toBeNull();
    expect(stamps.tts_language).toBe('es-US');
  });

  test('the prompt hash is frozen with the system prompt and excludes the caller block', async () => {
    const a = new RelayConversation({ callSid: 'CA-v-3', from: '+19415551234', send: jest.fn() });
    const b = new RelayConversation({ callSid: 'CA-v-4', from: '+19415551234', send: jest.fn() });
    b._callerContext = { customer: { id: 'c-1' }, tier: 'full', block: 'KNOWN CALLER: Pat' };
    await a._runLoop('hi').catch(() => {});
    await b._runLoop('hi').catch(() => {});
    expect(a._promptSha).toMatch(/^[0-9a-f]{64}$/);
    expect(a._toolSchemaSha).toMatch(/^[0-9a-f]{64}$/);
    // Same prompt ⇒ same hash whether or not a caller block rode along.
    expect(b._promptSha).toBe(a._promptSha);
    expect(a._contextSnapshotSha).toBeNull();
  });
});

describe('end() persists latency + versions in transcription_metadata', () => {
  test('the reconcile UPDATE carries the summary and the stamps', async () => {
    const update = jest.fn().mockResolvedValue(1);
    const guardQ = { whereNull: jest.fn().mockReturnThis(), orWhereNotIn: jest.fn().mockReturnThis() };
    const builder = { update, whereRaw: jest.fn().mockReturnThis(), where: jest.fn((arg) => { if (typeof arg === 'function') arg(guardQ); return builder; }) };
    db.mockReturnValue(builder);
    const { convo } = convoWithSpokenTurn({ callSid: 'CA-end-1' });
    convo.leadCaptured = true;
    convo._recordTurn('caller', 'hello');
    convo.say('Hi, how can I help?');
    convo.handleRelayEvent({ type: 'info', name: 'agentSpeaking', state: 'started' });
    await convo.end('agent_complete');
    const row = update.mock.calls[0][0];
    const meta = JSON.parse(row.transcription_metadata);
    expect(meta.latency).toMatchObject({ turns: 1, audio_metric_turns: 0, played_sources: { assumed: 1 } });
    expect(meta.versions).toMatchObject({ model: MODEL, effort: 'low', renderer_version: 'block-v1', tts_provider: 'ElevenLabs' });
  });

  test('buildTranscriptUpdate tolerates absent latency/versions (older callers)', () => {
    const out = buildTranscriptUpdate({ turns: [{ role: 'caller', text: 'hi' }], modelSummary: 'x' });
    const meta = JSON.parse(out.transcription_metadata);
    expect(meta.latency).toBeNull();
    expect(meta.versions).toBeNull();
  });
});
