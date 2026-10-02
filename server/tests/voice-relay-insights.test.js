// Sandy PR 0a — the Voice Insights turn timeline. The fixture mirrors the
// event order Twilio returned for a real sandbox call (same names, same
// same-millisecond ties resolved by sequence_number), with synthetic SIDs.

const {
  fetchConversationRelayEvents, parseTimeline, alignByTime, buildCallTimeline, summarizeTimeline,
} = require('../services/voice-agent/relay-insights');
const { storedTurnStats, buildTranscriptUpdate } = require('../services/voice-agent/relay-transcript');
const { storedStatsFor } = require('../scripts/voice-relay-turn-timing');

const SID = `CA${'0'.repeat(32)}`;
const T0 = Date.parse('2026-10-02T12:00:00.000Z');
let seq = 0;
function ev(atMs, name, extra = {}) {
  seq += 1;
  return {
    call_sid: SID,
    group: 'conversation_relay',
    edge: 'carrier_edge',
    name,
    timestamp: new Date(T0 + atMs).toISOString(),
    conversation_relay_data: { session_id: 'VX-test', sequence_number: seq, ...extra },
  };
}
const connection = (atMs, name) => ({ call_sid: SID, group: 'connection', name, timestamp: new Date(T0 + atMs).toISOString(), conversation_relay_data: null });

beforeEach(() => { seq = 0; });

// Our stored stat for a turn: prompt at `promptMs`, first send `sendMs`
// later (null = never replied), on our own clock that runs `skewMs` behind
// Twilio's.
function ours(turn, promptMs, sendMs, { toolCount = 0, skewMs = 0, ...rest } = {}) {
  return {
    turn, promptAt: 10000 + promptMs, promptWallAt: T0 + promptMs - skewMs,
    firstSendAt: sendMs == null ? null : 10000 + promptMs + sendMs,
    modelMs: 900, toolMs: toolCount ? 1500 : 0, toolCount, tools: [], rounds: 1, renderer: 'block', ...rest,
  };
}

describe('buildCallTimeline — reply attribution comes from our stats only', () => {
  test('a spoken turn splits the heard gap into three spans that add up; Twilio STT/TTS stay diagnostics', () => {
    const [t] = buildCallTimeline([
      connection(0, 'answered'),
      ev(1000, 'start_of_customer_speech'),
      ev(3000, 'stt_latency', { stt_latency: { latency_ms: 80 } }),
      ev(3000, 'end_of_customer_speech'),
      ev(3000, 'prompt_sent'),
      ev(5400, 'first_token_received'),
      ev(5600, 'tts_latency', { tts_latency: { latency_ms: 200 } }),
      ev(5600, 'start_of_agent_speech'),
      ev(9000, 'end_of_agent_speech'),
    ], [ours(1, 3000, 2390)]);
    expect(t).toMatchObject({ outcome: 'spoke', heardGapMs: 2600, endpointMs: 0, appMs: 2400, voiceMs: 200, sttMs: 80, ttsMs: 200, agentOverCaller: false });
    expect(t.endpointMs + t.appMs + t.voiceMs).toBe(t.heardGapMs);
  });

  test('without stats of ours a prompt is unattributed — Twilio alone never yields a latency', () => {
    const rows = buildCallTimeline([ev(1000, 'prompt_sent'), ev(2000, 'first_token_received'), ev(2100, 'start_of_agent_speech')], []);
    expect(rows[0]).toMatchObject({ outcome: 'unattributed', heardGapMs: null });
    expect(summarizeTimeline(rows).all.heard_gap.n).toBe(0);
  });

  test('a late reply to an earlier prompt is never credited to the newer one (overlapping prompts)', () => {
    const rows = buildCallTimeline([
      ev(1000, 'end_of_customer_speech'), ev(1000, 'prompt_sent'), // A
      ev(1500, 'end_of_customer_speech'), ev(1500, 'prompt_sent'), // B
      ev(1600, 'first_token_received'), ev(1700, 'start_of_agent_speech'), ev(3000, 'end_of_agent_speech'), // A's reply
      ev(3800, 'first_token_received'), ev(3900, 'start_of_agent_speech'), // B's reply
    ], [ours(1, 1000, 600), ours(2, 1500, 2300)]);
    expect(rows.map((t) => [t.outcome, t.heardGapMs])).toEqual([['spoke', 700], ['spoke', 2400]]);
  });

  test('two replies waiting when audio starts: both unclear, never a sample', () => {
    const rows = buildCallTimeline([
      ev(1000, 'prompt_sent'),
      ev(1400, 'first_token_received'), // A's text
      ev(1500, 'end_of_customer_speech'), ev(1500, 'prompt_sent'), // B
      ev(1600, 'first_token_received'), // B's text
      ev(1650, 'start_of_agent_speech'), // A's audio (after B's text, before any later text)
      ev(1900, 'start_of_agent_speech'), ev(2400, 'end_of_agent_speech'), // the other one
      ev(2600, 'end_of_customer_speech'), ev(2600, 'prompt_sent'), // C
      ev(3000, 'first_token_received'), ev(3100, 'start_of_agent_speech'), // C's — nothing else owed
    ], [ours(1, 1000, 400), ours(2, 1500, 100), ours(3, 2600, 400)]);
    // Two texts were waiting when audio started: either could own it.
    expect(rows.map((t) => t.outcome)).toEqual(['audio_unclear', 'audio_unclear', 'spoke']);
    expect(rows[2].heardGapMs).toBe(500);
    expect(summarizeTimeline(rows).all.heard_gap.n).toBe(1);
  });

  test('audio still owed to an unclear reply is never credited to a later one', () => {
    const rows = buildCallTimeline([
      ev(1000, 'prompt_sent'), ev(1400, 'first_token_received'),
      ev(1500, 'prompt_sent'), ev(1600, 'first_token_received'),
      ev(1650, 'start_of_agent_speech'), ev(2000, 'end_of_agent_speech'), // one of A/B
      ev(2100, 'prompt_sent'), ev(2200, 'first_token_received'), // C, while the other A/B audio is still owed
      ev(2300, 'start_of_agent_speech'), // could be the owed one
    ], [ours(1, 1000, 400), ours(2, 1500, 100), ours(3, 2100, 100)]);
    expect(rows.map((t) => t.outcome)).toEqual(['audio_unclear', 'audio_unclear', 'audio_unclear']);
  });

  test('a barge-in drops what was waiting, so measurement resumes cleanly', () => {
    const rows = buildCallTimeline([
      ev(1000, 'prompt_sent'), ev(1400, 'first_token_received'), // A, never plays
      ev(1450, 'interrupt'),
      ev(3000, 'end_of_customer_speech'), ev(3000, 'prompt_sent'),
      ev(3800, 'first_token_received'), ev(3900, 'start_of_agent_speech'),
    ], [ours(1, 1000, 400), ours(2, 3000, 800)]);
    expect(rows.map((t) => [t.outcome, t.heardGapMs])).toEqual([['no_audio_event', null], ['spoke', 900]]);
  });

  test('a multi-part reply (acknowledgement, then the answer) is measured from its FIRST text', () => {
    const rows = buildCallTimeline([
      ev(1000, 'end_of_customer_speech'), ev(1000, 'prompt_sent'),
      ev(1300, 'first_token_received'), ev(1400, 'start_of_agent_speech'), ev(2000, 'end_of_agent_speech'), // "let me check"
      ev(2200, 'end_of_customer_speech'), ev(2200, 'prompt_sent'), // caller adds something
      ev(3500, 'first_token_received'), ev(3600, 'start_of_agent_speech'), // turn 1's answer — our turn 2 sent later
      ev(5000, 'end_of_agent_speech'),
      ev(5200, 'first_token_received'), ev(5300, 'start_of_agent_speech'), // turn 2's reply
    ], [ours(1, 1000, 300), ours(2, 2200, 3000)]);
    expect(rows.map((t) => [t.outcome, t.heardGapMs])).toEqual([['spoke', 400], ['spoke', 3100]]);
  });

  test('clock skew between our server and Twilio is measured on the prompts and removed', () => {
    const rows = buildCallTimeline([
      ev(1000, 'end_of_customer_speech'), ev(1000, 'prompt_sent'),
      ev(2000, 'first_token_received'), ev(2100, 'start_of_agent_speech'),
    ], [ours(1, 1000, 1000, { skewMs: 1200 })]);
    expect(rows[0]).toMatchObject({ outcome: 'spoke', heardGapMs: 1100 });
  });

  test('outcomes: no reply sent, reply queued behind playing audio, reply with no audio start', () => {
    const rows = buildCallTimeline([
      ev(500, 'start_of_agent_speech'), // the welcome greeting
      ev(900, 'end_of_customer_speech'), ev(900, 'prompt_sent'),
      ev(1900, 'first_token_received'), // queued behind the greeting
      ev(6000, 'end_of_agent_speech'),
      ev(8000, 'end_of_customer_speech'), ev(8000, 'prompt_sent'), // never answered
      ev(9000, 'end_of_customer_speech'), ev(9000, 'prompt_sent'),
      ev(9800, 'first_token_received'), // call ends before audio
    ], [ours(1, 900, 1000), ours(2, 8000, null), ours(3, 9000, 800)]);
    expect(rows.map((t) => t.outcome)).toEqual(['queued', 'no_reply', 'no_audio_event']);
    expect(rows.every((t) => t.heardGapMs === null)).toBe(true);
  });

  test('agent audio that starts mid-utterance is flagged as talking over the caller', () => {
    const rows = buildCallTimeline([
      ev(1000, 'end_of_customer_speech'), ev(1000, 'prompt_sent'),
      ev(1800, 'start_of_customer_speech'),
      ev(2000, 'first_token_received'), ev(2100, 'start_of_agent_speech'),
      ev(2600, 'interrupt'),
    ], [ours(1, 1000, 1000, { interrupted: true })]);
    expect(rows[0]).toMatchObject({ outcome: 'spoke', agentOverCaller: true });
    const s = summarizeTimeline(rows, { interrupts: parseTimeline([ev(0, 'interrupt')]).interrupts });
    expect(s).toMatchObject({ agent_over_caller: 1, caller_barge_ins: 1, twilio_interrupts: 1 });
  });

  test('a back-to-back prompt with no end-of-speech marker uses the prompt time, flagged', () => {
    const rows = buildCallTimeline([
      ev(1000, 'end_of_customer_speech'), ev(1000, 'prompt_sent'),
      ev(2500, 'prompt_sent'),
      ev(3000, 'first_token_received'), ev(3200, 'start_of_agent_speech'),
    ], [ours(1, 1000, null), ours(2, 2500, 500)]);
    expect(rows[1]).toMatchObject({ endOfSpeechInferred: true, outcome: 'spoke', heardGapMs: 700 });
  });

  test('a new relay session (reconnect) carries no speech state and never takes audio across the boundary', () => {
    const second = (atMs, name, n) => ({ ...ev(atMs, name), conversation_relay_data: { session_id: 'VX-second', sequence_number: n } });
    const rows = buildCallTimeline([
      ev(1000, 'start_of_customer_speech'),
      ev(1000, 'prompt_sent'), ev(1800, 'first_token_received'), // session A replies, then drops
      second(9000, 'start_of_agent_speech', 1), second(11000, 'end_of_agent_speech', 2), // B's resume greeting
      second(12000, 'end_of_customer_speech', 3), second(12000, 'prompt_sent', 4),
      second(12900, 'first_token_received', 5), second(13000, 'start_of_agent_speech', 6),
    ], [ours(1, 1000, 800), ours(1, 12000, 900)]);
    expect(rows.map((t) => t.outcome)).toEqual(['no_audio_event', 'spoke']);
    expect(rows[1]).toMatchObject({ heardGapMs: 1000, agentOverCaller: false });
  });

  test('plain and tool turns are reported apart; model/tool time is whole-turn work', () => {
    const rows = buildCallTimeline([
      ev(1000, 'end_of_customer_speech'), ev(1000, 'prompt_sent'),
      ev(2000, 'first_token_received'), ev(2200, 'start_of_agent_speech'), ev(4000, 'end_of_agent_speech'),
      ev(6000, 'end_of_customer_speech'), ev(6000, 'prompt_sent'),
      ev(9000, 'first_token_received'), ev(9300, 'start_of_agent_speech'),
    ], [ours(1, 1000, 1000), ours(2, 6000, 3000, { toolCount: 1 })]);
    const s = summarizeTimeline(rows);
    expect(s.plain).toMatchObject({ turns: 1, heard_gap: { p50: 1200 } });
    expect(s.tool).toMatchObject({ turns: 1, heard_gap: { p50: 3300 }, tools_turn_total: { p50: 1500 } });
  });

  test('connection events and garbage are ignored', () => {
    expect(buildCallTimeline([connection(0, 'answered'), null, { group: 'conversation_relay', name: 'prompt_sent', timestamp: 'nope' }], [])).toEqual([]);
    expect(buildCallTimeline(undefined)).toEqual([]);
  });
});

describe('alignByTime', () => {
  const at = (x) => x;
  test('keeps every valid pair, order-preserving (greedy nearest-first would strand one)', () => {
    expect([...alignByTime([0, 1000], [900, 2500], at, at, 2000)]).toEqual([[0, 0], [1, 1]]);
  });

  test('an earlier unmatched item never takes a later item\'s closer match', () => {
    expect([...alignByTime([1000, 1500], [1510], at, at, 2000)]).toEqual([[1, 0]]);
  });

  test('nothing pairs outside the window', () => {
    expect(alignByTime([0], [60000], at, at, 2000).size).toBe(0);
  });
});

describe('stored turn stats carry the join keys', () => {
  test('storedTurnStats keeps promptWallAt and per-tool timing (names only, capped)', () => {
    const tools = Array.from({ length: 10 }, (_, i) => ({ name: `tool_${i}`, ms: 10.4 + i, ok: i % 2 === 0, input: { phone: '+19415550000' } }));
    const [stored] = storedTurnStats([{ turn: 1, promptAt: 5, promptWallAt: T0, toolCount: 10, tools }]);
    expect(stored.promptWallAt).toBe(T0);
    expect(stored.tools).toHaveLength(8);
    expect(stored.tools[0]).toEqual({ name: 'unknown_tool', ms: 10, ok: true }); // digits never stored
    const [named] = storedTurnStats([{ turn: 1, tools: [{ name: 'lookup_customer', ms: 5, ok: true }, { name: '4111111111111111', ms: 5, ok: false }, { name: 'Call +1 941', ms: 1, ok: false }] }]);
    expect(named.tools.map((t) => t.name)).toEqual(['lookup_customer', 'unknown_tool', 'unknown_tool']);
    expect(JSON.stringify(stored)).not.toContain('+1941');
  });

  test('buildTranscriptUpdate stores turn_stats in transcription_metadata, and the script reads them back', () => {
    const turnStats = storedTurnStats([{ turn: 1, promptAt: 5, promptWallAt: T0, tools: [] }]);
    const out = buildTranscriptUpdate({ turns: [{ role: 'caller', text: 'hi' }], modelSummary: 'x', turnStats });
    const meta = JSON.parse(out.transcription_metadata);
    expect(meta.turn_stats).toEqual(turnStats);
    expect(storedStatsFor({ transcription_metadata: out.transcription_metadata })).toEqual(turnStats);
  });

  test('a call whose top-level provenance was rewritten by the recording processor reads Sandy\'s stats under .relay', () => {
    const row = { transcription_metadata: { source: 'recording', relay: { source: 'voice_relay_session', turn_stats: [{ turn: 1 }] } } };
    expect(storedStatsFor(row)).toEqual([{ turn: 1 }]);
  });

  test('a reconnected call reads every recovery segment in order, even when the closing socket also wrote its own turn_stats', () => {
    const segments = [{ turn_stats: [{ turn: 1, segmentGeneration: 1 }] }, { turn_stats: [{ turn: 1, segmentGeneration: 2 }, { turn: 2, segmentGeneration: 2 }] }];
    const row = {
      transcription_metadata: { source: 'voice_relay_session', turn_stats: segments[1].turn_stats },
      metadata: { relay_segments: segments },
    };
    expect(storedStatsFor(row).map((s) => s.segmentGeneration)).toEqual([1, 2, 2]);
    const reversed = { ...row, metadata: { relay_segments: [{ generation: 2, turn_stats: [{ turn: 1, segmentGeneration: 2 }] }, { generation: 1, turn_stats: [{ turn: 1, segmentGeneration: 1 }] }] } };
    expect(storedStatsFor(reversed).map((s) => s.segmentGeneration)).toEqual([1, 2]); // call order, not append order
  });
});

describe('fetchConversationRelayEvents', () => {
  const creds = { accountSid: 'ACtest', authToken: 'secret' };

  test('reads every page on the carrier edge with basic auth', async () => {
    const fetchImpl = jest.fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ events: [ev(0, 'prompt_sent')], meta: { next_page_url: 'https://insights.twilio.com/next' } }) })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ events: [ev(10, 'first_token_received')], meta: { next_page_url: null } }) });
    const out = await fetchConversationRelayEvents(SID, { ...creds, fetchImpl });
    expect(out).toMatchObject({ available: true });
    expect(out.events).toHaveLength(2);
    expect(fetchImpl.mock.calls[0][0]).toBe(`https://insights.twilio.com/v1/Voice/${SID}/Events?Edge=carrier_edge&PageSize=200`);
    expect(fetchImpl.mock.calls[0][1].headers.Authorization).toBe(`Basic ${Buffer.from('ACtest:secret').toString('base64')}`);
    expect(fetchImpl.mock.calls[1][0]).toBe('https://insights.twilio.com/next');
  });

  test('a 404 after the first page fails the call instead of truncating it', async () => {
    const fetchImpl = jest.fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ events: [ev(0, 'prompt_sent')], meta: { next_page_url: 'https://insights.twilio.com/next' } }) })
      .mockResolvedValueOnce({ ok: false, status: 404 });
    await expect(fetchConversationRelayEvents(SID, { ...creds, fetchImpl })).rejects.toThrow('HTTP 404');
  });

  test('every request carries a deadline', async () => {
    const fetchImpl = jest.fn(async () => ({ ok: true, status: 200, json: async () => ({ events: [], meta: {} }) }));
    await fetchConversationRelayEvents(SID, { ...creds, fetchImpl });
    expect(fetchImpl.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
  });

  test('a 404 (events not ready yet) is unavailable, not an error; other failures throw', async () => {
    await expect(fetchConversationRelayEvents(SID, { ...creds, fetchImpl: async () => ({ ok: false, status: 404 }) })).resolves.toEqual({ events: [], available: false });
    await expect(fetchConversationRelayEvents(SID, { ...creds, fetchImpl: async () => ({ ok: false, status: 401 }) })).rejects.toThrow('HTTP 401');
  });

  test('refuses a malformed CallSid or missing credentials before any request', async () => {
    const fetchImpl = jest.fn();
    await expect(fetchConversationRelayEvents('CA../../x', { ...creds, fetchImpl })).rejects.toThrow('invalid CallSid');
    await expect(fetchConversationRelayEvents(SID, { accountSid: '', authToken: '', fetchImpl })).rejects.toThrow('not set');
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
