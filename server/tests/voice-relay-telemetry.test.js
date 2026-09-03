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
const { summarizeTurnStats, buildTranscriptUpdate } = require('../services/voice-agent/relay-transcript');

function convoWithSpokenTurn({ callSid = 'CA-tel-1', ...rest } = {}) {
  const send = jest.fn();
  const convo = new RelayConversation({ callSid, from: '+19415551234', send, ...rest });
  // Drive a caller turn without a model: _runLoop early-returns (no Anthropic
  // client in tests) after the stat is created, then the agent "speaks".
  const stat = { turn: 1, promptAt: 1000, callerSpeechStoppedAt: null, loopStartAt: 1001, firstTokenAt: null, firstSendAt: null, agentSpeakingStartAt: null, agentSpeakingEndAt: null, modelMs: 0, toolMs: 0, toolCount: 0, rounds: 0, effort: 'low', renderer: 'block', interrupted: false, durationUntilInterruptMs: null, interruptWithoutFollowupTranscript: false, timedOut: false, partialCount: 0, played: null, playedUtterance: null, playedSource: 'assumed', agentEntries: [] };
  convo._turnStats.push(stat);
  convo._currentTurn = stat;
  return { convo, stat, send };
}

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
    [{ type: 'something-new', foo: 'bar' }, 'unknown'],
    [null, 'unknown'],
    ['nope', 'unknown'],
  ])('%j ⇒ %s', (frame, kind) => {
    expect(classifyRelayEvent(frame).kind).toBe(kind);
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
    expect(stat.agentEntries[1]).toEqual({ role: 'agent', text: 'I can help with that.', planned: 'I can help with that.' });
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
    expect(stat.played).toBe('Your next service is Tuesday at nine.');
    const entry = convo._transcript.find((t) => t.role === 'agent');
    expect(entry.text).toBe('Your next service is Tuesday at nine.');
    expect(entry.planned).toBe('Your next service is Tuesday at nine. Anything else?');
  });

  test('a cumulative tokens-played snapshot replaces rather than duplicates', () => {
    const { convo, stat } = convoWithSpokenTurn();
    convo.say('Hello there, this is Sandy.');
    convo.handleRelayEvent({ type: 'tokens-played', tokens: 'Hello there,' });
    convo.handleRelayEvent({ type: 'tokens-played', tokens: 'Hello there, this is Sandy.' });
    expect(stat.played).toBe('Hello there, this is Sandy.');
  });

  test('Flux partial prompts are counted on the turn they precede, never acted on', async () => {
    const convo = new RelayConversation({ callSid: 'CA-tel-4', from: '+19415551234', send: jest.fn() });
    convo.notePartialPrompt();
    convo.notePartialPrompt();
    await convo.handlePrompt('full utterance');
    expect(convo._turnStats[0].partialCount).toBe(2);
    expect(convo._userTurns).toEqual(['full utterance']);
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
    const entry = convo._transcript.find((t) => t.role === 'agent');
    expect(entry.text).toBe('I can get someone out Tuesday [interrupted]');
    expect(entry.planned).toBe('I can get someone out Tuesday morning, and we will send a confirmation.');
  });

  test('a bare interrupt() (end()\'s own abort) records nothing', () => {
    const { convo, stat } = convoWithSpokenTurn();
    convo.say('Goodbye.');
    convo.interrupt();
    expect(stat.interrupted).toBe(false);
    expect(convo._transcript.find((t) => t.role === 'agent').text).toBe('Goodbye.');
  });

  test('tokens-played outranks the interrupt utterance for the played text', () => {
    const { convo, stat } = convoWithSpokenTurn();
    convo.say('One two three four.');
    convo.handleRelayEvent({ type: 'tokens-played', tokens: 'One two' });
    convo.interrupt({ utteranceUntilInterrupt: 'One', durationUntilInterruptMs: 300 });
    expect(stat.playedSource).toBe('twilio_event');
    expect(convo._transcript.find((t) => t.role === 'agent').text).toBe('One two [interrupted]');
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
  });

  test('a garbage entry is ignored, never thrown on', () => {
    expect(() => summarizeTurnStats([null, 'x', turn({ promptAt: 5, firstSendAt: 1 })])).not.toThrow();
    expect(summarizeTurnStats([null, turn({})]).turns).toBe(1);
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
