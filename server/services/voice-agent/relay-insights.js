/**
 * Sandy PR 0a — the caller-heard turn timeline, from Twilio's side.
 *
 * Voice Insights logs every ConversationRelay turn on the carrier edge:
 * end of customer speech, prompt sent to us, first token back, start of agent
 * speech, interrupts, plus Twilio's own STT and TTS latencies. That is the
 * stopwatch the release criteria are written against (end of customer speech
 * → start of agent speech), so this module reads it and splits each gap into
 * hearing (STT), us (application) and voice (TTS). Our own per-turn stats
 * (relay-transcript.storedTurnStats) then split "us" into model vs tools.
 *
 * Read-only: one GET per page against insights.twilio.com. Events carry no
 * spoken text — only names, timestamps, sequence numbers and latencies.
 */

const INSIGHTS_BASE = 'https://insights.twilio.com/v1/Voice';
const CALL_SID_RE = /^CA[0-9a-fA-F]{32}$/;
const MAX_PAGES = 20;
const REQUEST_TIMEOUT_MS = 15000;
// Our prompt clock and Twilio's prompt_sent are the same instant seen from
// two machines; anything further apart than this is a different turn.
const JOIN_WINDOW_MS = 2000;

/** Fetch every ConversationRelay event for one call (all pages, carrier edge). */
async function fetchConversationRelayEvents(callSid, {
  accountSid = process.env.TWILIO_ACCOUNT_SID,
  authToken = process.env.TWILIO_AUTH_TOKEN,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (!CALL_SID_RE.test(String(callSid || ''))) throw new Error('invalid CallSid');
  if (!accountSid || !authToken) throw new Error('TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN not set');
  const auth = `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString('base64')}`;
  const events = [];
  let url = `${INSIGHTS_BASE}/${callSid}/Events?Edge=carrier_edge&PageSize=200`;
  for (let page = 0; url && page < MAX_PAGES; page += 1) {
    // Bounded: a stalled page fails this call, never the whole report.
    const res = await fetchImpl(url, { headers: { Authorization: auth }, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    if (res.status === 404) return { events, available: false };
    if (!res.ok) throw new Error(`Voice Insights events HTTP ${res.status}`);
    const body = await res.json();
    if (Array.isArray(body.events)) events.push(...body.events);
    url = body.meta && body.meta.next_page_url ? body.meta.next_page_url : null;
  }
  return { events, available: true };
}

function eventTime(e) {
  const t = Date.parse(e && e.timestamp);
  return Number.isFinite(t) ? t : null;
}

/** ConversationRelay events only, in Twilio's own order (time, then sequence). */
function relayEvents(events = []) {
  return (Array.isArray(events) ? events : [])
    .filter((e) => e && e.group === 'conversation_relay' && eventTime(e) != null)
    .map((e) => {
      const data = e.conversation_relay_data || {};
      return {
        name: e.name,
        at: eventTime(e),
        seq: Number.isFinite(data.sequence_number) ? data.sequence_number : null,
        sessionId: data.session_id || null,
        latencyMs: (data.stt_latency && data.stt_latency.latency_ms) ?? (data.tts_latency && data.tts_latency.latency_ms) ?? null,
      };
    })
    .sort((a, b) => (a.at - b.at) || ((a.seq ?? 0) - (b.seq ?? 0)));
}

const span = (from, to) => (from != null && to != null && to >= from ? to - from : null);

/**
 * One row per prompt Twilio sent us. Each turn opens at `prompt_sent` and
 * closes at the next one. Outcomes:
 *   spoke            — agent audio started for this turn
 *   superseded       — the caller spoke again before any agent audio
 *                      (a merged or abandoned turn; not a latency sample)
 *   queued           — our reply arrived while earlier agent audio was still
 *                      playing, so Twilio logged no new start (the greeting
 *                      case); heard, but not a latency sample
 *   ambiguous        — the previous prompt was still waiting for its first
 *                      text when this one arrived. Twilio's events do not say which
 *                      prompt a reply answers, so this turn's reply and audio
 *                      are never attributed (not a latency sample)
 *   no_audio_event   — we replied but no agent audio start followed before
 *                      the call ended
 *   silent           — we never replied before the call ended
 *
 * Overlap classes (scope §2.4), from the speech state Twilio reports:
 *   agentOverCaller — agent audio started while the caller was mid-utterance
 *   callerBargeIns  — Twilio `interrupt` events during this turn's playback
 */
function freshState() {
  return {
    current: null,
    customerSpeaking: false,
    agentSpeaking: false,
    lastEndOfCustomerSpeech: null,
    lastSttMs: null,
    pendingTtsMs: null,
  };
}

function closeTurn(turn, byNextPrompt) {
  if (!turn || turn.outcome != null) return;
  if (turn.firstTokenAt != null && turn.agentPlayingAtFirstToken) turn.outcome = 'queued';
  else if (byNextPrompt) turn.outcome = 'superseded';
  else turn.outcome = turn.firstTokenAt != null ? 'no_audio_event' : 'silent';
}

// One handler per Twilio event name; unlisted names are ignored.
const TIMELINE_HANDLERS = {
  start_of_customer_speech: (st) => { st.customerSpeaking = true; },
  end_of_customer_speech: (st, e) => {
    st.customerSpeaking = false;
    st.lastEndOfCustomerSpeech = e.at;
  },
  stt_latency: (st, e) => { st.lastSttMs = e.latencyMs; },
  tts_latency: (st, e) => { st.pendingTtsMs = e.latencyMs; },
  prompt_sent: (st, e, turns) => {
    // The previous prompt saw no reply text yet: the next reply events could
    // be its late answer, so they are not attributed to this one. (Doubt
    // reaches one turn only — a prompt whose reply was cut off for good
    // must not leave every later turn unmeasured.)
    const earlierPending = Boolean(st.current && !st.current.sawReply);
    closeTurn(st.current, true);
    st.current = {
      index: turns.length + 1,
      promptSentAt: e.at,
      // Twilio sends the prompt the instant it marks end of speech (same
      // millisecond in every observed call), but a back-to-back second
      // prompt can arrive with no end marker of its own; the prompt time
      // stands in, flagged.
      endOfCustomerSpeechAt: st.lastEndOfCustomerSpeech ?? e.at,
      endOfSpeechInferred: st.lastEndOfCustomerSpeech == null,
      sttMs: st.lastSttMs,
      firstTokenAt: null,
      agentSpeechStartAt: null,
      ttsMs: null,
      responses: 0,
      sawReply: false,
      agentPlayingAtFirstToken: false,
      agentOverCaller: false,
      callerBargeIns: 0,
      earlierPending,
      outcome: earlierPending ? 'ambiguous' : null,
    };
    st.lastEndOfCustomerSpeech = null;
    st.lastSttMs = null;
    turns.push(st.current);
  },
  first_token_received: (st, e) => {
    const t = st.current;
    if (!t) return;
    t.responses += 1;
    t.sawReply = true;
    if (t.firstTokenAt == null && t.outcome == null) {
      t.firstTokenAt = e.at;
      t.agentPlayingAtFirstToken = st.agentSpeaking;
    }
  },
  start_of_agent_speech: (st, e) => {
    const t = st.current;
    // Only audio that starts AFTER this prompt's own first token can be its
    // reply; earlier audio is a previous reply still reaching the line.
    if (t && t.firstTokenAt != null && t.outcome == null) {
      t.agentSpeechStartAt = e.at;
      t.ttsMs = st.pendingTtsMs;
      t.agentOverCaller = st.customerSpeaking;
      t.outcome = 'spoke';
    }
    st.pendingTtsMs = null;
    st.agentSpeaking = true;
  },
  end_of_agent_speech: (st) => { st.agentSpeaking = false; },
  preempted: (st) => { st.agentSpeaking = false; },
  interrupt: (st) => {
    if (st.current) st.current.callerBargeIns += 1;
    st.agentSpeaking = false;
  },
};

function buildTurnTimeline(events = []) {
  const turns = [];
  let st = freshState();
  let sessionId = null;
  for (const e of relayEvents(events)) {
    // A reconnected call (GATE_VOICE_RELAY_RECOVERY) runs a second relay
    // session on the same CallSid: nothing carries across the boundary.
    if (e.sessionId && sessionId && e.sessionId !== sessionId) {
      closeTurn(st.current, false);
      st = freshState();
    }
    if (e.sessionId) sessionId = e.sessionId;
    const handle = TIMELINE_HANDLERS[e.name];
    if (handle) handle(st, e, turns);
  }
  closeTurn(st.current, false);

  return turns.map((t) => ({
    ...t,
    // The release-criteria gap: caller stops → caller hears Sandy.
    heardGapMs: t.outcome === 'spoke' ? span(t.endOfCustomerSpeechAt, t.agentSpeechStartAt) : null,
    // Three non-overlapping boundary spans that add up to the heard gap:
    // end of speech → prompt sent (Twilio's turn handoff, usually 0),
    // prompt → first text back (us, incl. the websocket round trip),
    // first text → agent audio (synthesis + playout).
    endpointMs: t.outcome === 'spoke' ? span(t.endOfCustomerSpeechAt, t.promptSentAt) : null,
    appMs: span(t.promptSentAt, t.firstTokenAt),
    voiceMs: t.outcome === 'spoke' ? span(t.firstTokenAt, t.agentSpeechStartAt) : null,
    // sttMs / ttsMs stay as Twilio's provider diagnostics — they overlap the
    // spans above and are never added to them.
  }));
}

/**
 * Pair Twilio turns with our stored turn stats (relay-transcript
 * storedTurnStats) by wall clock: our `promptWallAt` vs Twilio's
 * `prompt_sent`, nearest first, each used once. Older rows without a wall
 * clock pair by position only when the counts agree — otherwise unpaired,
 * never guessed.
 */
function joinTurnStats(timeline = [], turnStats = []) {
  const ours = (Array.isArray(turnStats) ? turnStats : []).filter((s) => s && typeof s === 'object');
  const withClock = ours.filter((s) => Number.isFinite(s.promptWallAt));
  const pairs = new Map(); // timeline index → stat
  if (withClock.length) {
    // Closest pairs first, globally, one-to-one — a chronological greedy pass
    // would let an unmatched earlier prompt take a later prompt's exact match.
    const candidates = [];
    timeline.forEach((t, i) => withClock.forEach((s) => {
      const d = Math.abs(s.promptWallAt - t.promptSentAt);
      if (d <= JOIN_WINDOW_MS) candidates.push({ i, s, d });
    }));
    candidates.sort((a, b) => a.d - b.d);
    const usedStats = new Set();
    for (const c of candidates) {
      if (pairs.has(c.i) || usedStats.has(c.s)) continue;
      pairs.set(c.i, c.s);
      usedStats.add(c.s);
    }
  } else if (ours.length === timeline.length) {
    ours.forEach((s, i) => pairs.set(i, s));
  }
  return timeline.map((t, i) => {
    const s = pairs.get(i);
    if (!s) return { ...t, ours: null };
    return {
      ...t,
      ours: {
        turn: s.turn,
        modelMs: Number.isFinite(s.modelMs) ? Math.round(s.modelMs) : null,
        toolMs: Number.isFinite(s.toolMs) ? Math.round(s.toolMs) : null,
        toolCount: Number.isFinite(s.toolCount) ? s.toolCount : null,
        tools: Array.isArray(s.tools) ? s.tools : [],
        rounds: Number.isFinite(s.rounds) ? s.rounds : null,
        renderer: s.renderer || null,
      },
    };
  });
}

function percentile(values, p) {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const idx = Math.min(v.length - 1, Math.max(0, Math.ceil((p / 100) * v.length) - 1));
  return Math.round(v[idx]);
}

function stage(values) {
  const v = values.filter((x) => Number.isFinite(x));
  return { n: v.length, p50: percentile(v, 50), p95: percentile(v, 95), max: v.length ? Math.round(Math.max(...v)) : null };
}

/**
 * Where the seconds go, for the turns that spoke. Plain and tool turns are
 * reported apart (release criteria §2.3); a turn we could not pair with our
 * own stats is `unclassified` rather than assumed plain.
 */
function summarizeTimeline(joined = []) {
  const spoke = joined.filter((t) => t.outcome === 'spoke');
  const group = (rows) => ({
    turns: rows.length,
    heard_gap: stage(rows.map((t) => t.heardGapMs)),
    endpoint: stage(rows.map((t) => t.endpointMs)),
    app: stage(rows.map((t) => t.appMs)),
    voice: stage(rows.map((t) => t.voiceMs)),
    stt_provider: stage(rows.map((t) => t.sttMs)),
    tts_provider: stage(rows.map((t) => t.ttsMs)),
    // WHOLE-TURN work (every model round and tool call, including any after
    // the first reply was sent), not slices of the first-response gap.
    model_turn_total: stage(rows.map((t) => t.ours && t.ours.modelMs)),
    tools_turn_total: stage(rows.map((t) => t.ours && t.ours.toolMs)),
  });
  const plain = spoke.filter((t) => t.ours && t.ours.toolCount === 0);
  const tool = spoke.filter((t) => t.ours && t.ours.toolCount > 0);
  const unclassified = spoke.filter((t) => !t.ours);
  const outcomes = {};
  for (const t of joined) outcomes[t.outcome] = (outcomes[t.outcome] || 0) + 1;
  return {
    prompts: joined.length,
    outcomes,
    all: group(spoke),
    plain: group(plain),
    tool: group(tool),
    unclassified: unclassified.length,
    agent_over_caller: joined.filter((t) => t.agentOverCaller).length,
    caller_barge_ins: joined.reduce((s, t) => s + t.callerBargeIns, 0),
  };
}

module.exports = {
  fetchConversationRelayEvents,
  relayEvents,
  buildTurnTimeline,
  joinTurnStats,
  summarizeTimeline,
  percentile,
  JOIN_WINDOW_MS,
};
