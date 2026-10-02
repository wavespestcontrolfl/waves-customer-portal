// Sandy PR 0a — the Voice Insights turn timeline. The fixture mirrors the
// event order Twilio returned for a real sandbox call (same names, same
// same-millisecond ties resolved by sequence_number), with synthetic SIDs.

const {
  fetchConversationRelayEvents, buildTurnTimeline, joinTurnStats, summarizeTimeline,
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

describe('buildTurnTimeline', () => {
  test('a spoken turn splits the heard gap into hearing, us and voice', () => {
    const turns = buildTurnTimeline([
      connection(0, 'answered'),
      ev(1000, 'start_of_customer_speech'),
      ev(3000, 'stt_latency', { stt_latency: { latency_ms: 80 } }),
      ev(3000, 'end_of_customer_speech'),
      ev(3000, 'prompt_sent'),
      ev(5400, 'first_token_received'),
      ev(5600, 'tts_latency', { tts_latency: { latency_ms: 200 } }),
      ev(5600, 'start_of_agent_speech'),
      ev(9000, 'end_of_agent_speech'),
    ]);
    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({ outcome: 'spoke', heardGapMs: 2600, sttMs: 80, appMs: 2400, voiceMs: 200, agentOverCaller: false, callerBargeIns: 0 });
  });

  test('events out of order in the payload are sorted by time, then sequence number', () => {
    const events = [
      ev(3000, 'end_of_customer_speech'),
      ev(3000, 'prompt_sent'),
      ev(4000, 'first_token_received'),
      ev(4100, 'start_of_agent_speech'),
    ];
    const turns = buildTurnTimeline([...events].reverse());
    expect(turns[0]).toMatchObject({ outcome: 'spoke', heardGapMs: 1100, appMs: 1000 });
  });

  test('the caller speaking again before any agent audio supersedes the turn (not a latency sample)', () => {
    const turns = buildTurnTimeline([
      ev(1000, 'end_of_customer_speech'), ev(1000, 'prompt_sent'),
      ev(1500, 'start_of_customer_speech'),
      ev(2500, 'end_of_customer_speech'), ev(2500, 'prompt_sent'),
      ev(3500, 'first_token_received'), ev(3700, 'start_of_agent_speech'),
    ]);
    expect(turns.map((t) => t.outcome)).toEqual(['superseded', 'spoke']);
    expect(turns[0].heardGapMs).toBeNull();
    expect(turns[1].heardGapMs).toBe(1200);
    expect(summarizeTimeline(joinTurnStats(turns, [])).all.heard_gap.n).toBe(1);
  });

  test('a reply that lands while earlier agent audio is still playing is queued, not superseded', () => {
    const turns = buildTurnTimeline([
      ev(500, 'start_of_agent_speech'), // the welcome greeting
      ev(900, 'end_of_customer_speech'), ev(900, 'prompt_sent'),
      ev(1900, 'first_token_received'),
      ev(6000, 'end_of_agent_speech'),
      ev(8000, 'end_of_customer_speech'), ev(8000, 'prompt_sent'),
    ]);
    expect(turns[0]).toMatchObject({ outcome: 'queued', heardGapMs: null, appMs: 1000 });
    expect(turns[1].outcome).toBe('silent');
  });

  test('a back-to-back prompt with no end-of-speech marker uses the prompt time, flagged', () => {
    const turns = buildTurnTimeline([
      ev(1000, 'end_of_customer_speech'), ev(1000, 'prompt_sent'),
      ev(2500, 'prompt_sent'),
      ev(3000, 'first_token_received'), ev(3200, 'start_of_agent_speech'),
    ]);
    expect(turns[0].endOfSpeechInferred).toBe(false);
    expect(turns[1]).toMatchObject({ endOfSpeechInferred: true, heardGapMs: 700 });
  });

  test('overlap classes: agent audio starting mid-utterance, and caller barge-ins during playback', () => {
    const turns = buildTurnTimeline([
      ev(1000, 'end_of_customer_speech'), ev(1000, 'prompt_sent'),
      ev(1800, 'start_of_customer_speech'), // caller resumes…
      ev(2000, 'first_token_received'),
      ev(2100, 'start_of_agent_speech'), // …and Sandy starts over them
      ev(2600, 'interrupt'),
    ]);
    expect(turns[0]).toMatchObject({ outcome: 'spoke', agentOverCaller: true, callerBargeIns: 1 });
    const s = summarizeTimeline(joinTurnStats(turns, []));
    expect(s.agent_over_caller).toBe(1);
    expect(s.caller_barge_ins).toBe(1);
  });

  test('audio that starts before a prompt has its own first token belongs to an earlier reply, never the newer prompt', () => {
    const turns = buildTurnTimeline([
      ev(1000, 'end_of_customer_speech'), ev(1000, 'prompt_sent'),
      ev(1800, 'first_token_received'), // reply A, not playing yet
      ev(1900, 'end_of_customer_speech'), ev(1900, 'prompt_sent'), // prompt B
      ev(1950, 'start_of_agent_speech'), // A's audio
      ev(2800, 'first_token_received'), // B's reply, queued behind A
    ]);
    expect(turns[1].heardGapMs).toBeNull();
    expect(turns[1].outcome).toBe('queued');
  });

  test('a reply with no agent audio before the call ends is no_audio_event; no reply is silent', () => {
    expect(buildTurnTimeline([ev(0, 'prompt_sent'), ev(900, 'first_token_received')])[0].outcome).toBe('no_audio_event');
    expect(buildTurnTimeline([ev(0, 'prompt_sent')])[0].outcome).toBe('silent');
  });

  test('connection events and garbage are ignored', () => {
    expect(buildTurnTimeline([connection(0, 'answered'), null, { group: 'conversation_relay', name: 'prompt_sent', timestamp: 'nope' }])).toEqual([]);
    expect(buildTurnTimeline(undefined)).toEqual([]);
  });
});

describe('joinTurnStats', () => {
  const timeline = () => buildTurnTimeline([
    ev(1000, 'end_of_customer_speech'), ev(1000, 'prompt_sent'),
    ev(2000, 'first_token_received'), ev(2200, 'start_of_agent_speech'), ev(4000, 'end_of_agent_speech'),
    ev(6000, 'end_of_customer_speech'), ev(6000, 'prompt_sent'),
    ev(9000, 'first_token_received'), ev(9300, 'start_of_agent_speech'),
  ]);

  test('pairs by wall clock and splits plain from tool turns', () => {
    const ours = [
      { turn: 1, promptWallAt: T0 + 1040, modelMs: 900, toolMs: 0, toolCount: 0, tools: [], rounds: 1, renderer: 'block' },
      { turn: 2, promptWallAt: T0 + 6030, modelMs: 1100, toolMs: 1800, toolCount: 1, tools: [{ name: 'lookup_customer', ms: 1800, ok: true }], rounds: 2, renderer: 'block' },
    ];
    const joined = joinTurnStats(timeline(), ours);
    expect(joined[0].ours).toMatchObject({ turn: 1, toolCount: 0 });
    expect(joined[1].ours.tools).toEqual([{ name: 'lookup_customer', ms: 1800, ok: true }]);
    const s = summarizeTimeline(joined);
    expect(s.plain.turns).toBe(1);
    expect(s.plain.heard_gap.p50).toBe(1200);
    expect(s.tool.turns).toBe(1);
    expect(s.tool.tools.p50).toBe(1800);
    expect(s.unclassified).toBe(0);
  });

  test('a stat further than the window from every prompt stays unpaired — never guessed', () => {
    const joined = joinTurnStats(timeline(), [{ turn: 1, promptWallAt: T0 + 60000, toolCount: 0 }]);
    expect(joined.every((t) => t.ours === null)).toBe(true);
    expect(summarizeTimeline(joined).unclassified).toBe(2);
  });

  test('an earlier unmatched prompt never takes a later prompt\'s closer match', () => {
    const tl = buildTurnTimeline([ev(1000, 'prompt_sent'), ev(1500, 'prompt_sent')]);
    const joined = joinTurnStats(tl, [{ turn: 7, promptWallAt: T0 + 1510, toolCount: 0 }]);
    expect(joined.map((t) => t.ours && t.ours.turn)).toEqual([null, 7]);
  });

  test('rows stored before the wall clock existed pair by position only when the counts agree', () => {
    expect(joinTurnStats(timeline(), [{ turn: 1, toolCount: 0 }, { turn: 2, toolCount: 1 }]).map((t) => t.ours && t.ours.turn)).toEqual([1, 2]);
    expect(joinTurnStats(timeline(), [{ turn: 1, toolCount: 0 }]).every((t) => t.ours === null)).toBe(true);
  });
});

describe('stored turn stats carry the join keys', () => {
  test('storedTurnStats keeps promptWallAt and per-tool timing (names only, capped)', () => {
    const tools = Array.from({ length: 10 }, (_, i) => ({ name: `tool_${i}`, ms: 10.4 + i, ok: i % 2 === 0, input: { phone: '+19415550000' } }));
    const [stored] = storedTurnStats([{ turn: 1, promptAt: 5, promptWallAt: T0, toolCount: 10, tools }]);
    expect(stored.promptWallAt).toBe(T0);
    expect(stored.tools).toHaveLength(8);
    expect(stored.tools[0]).toEqual({ name: 'tool_0', ms: 10, ok: true });
    expect(JSON.stringify(stored)).not.toContain('+1941');
  });

  test('buildTranscriptUpdate stores turn_stats in transcription_metadata, and the script reads them back', () => {
    const turnStats = storedTurnStats([{ turn: 1, promptAt: 5, promptWallAt: T0, tools: [] }]);
    const out = buildTranscriptUpdate({ turns: [{ role: 'caller', text: 'hi' }], modelSummary: 'x', turnStats });
    const meta = JSON.parse(out.transcription_metadata);
    expect(meta.turn_stats).toEqual(turnStats);
    expect(storedStatsFor({ transcription_metadata: out.transcription_metadata })).toEqual(turnStats);
  });

  test('a reconnected call reads every recovery segment in order, even when the closing socket also wrote its own turn_stats', () => {
    const segments = [{ turn_stats: [{ turn: 1, segmentGeneration: 1 }] }, { turn_stats: [{ turn: 1, segmentGeneration: 2 }, { turn: 2, segmentGeneration: 2 }] }];
    const row = {
      transcription_metadata: { source: 'voice_relay_session', turn_stats: segments[1].turn_stats },
      metadata: { relay_segments: segments },
    };
    expect(storedStatsFor(row).map((s) => s.segmentGeneration)).toEqual([1, 2, 2]);
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
