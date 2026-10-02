/**
 * Sandy PR 0a — the caller-heard turn timeline, from Twilio's side.
 *
 * Voice Insights logs every ConversationRelay turn on the carrier edge:
 * end of customer speech, prompt sent to us, first token back, start of agent
 * speech, interrupts, plus Twilio's own STT and TTS latencies. That is the
 * stopwatch the release criteria are written against (end of customer speech
 * → start of agent speech), so this module reads it and splits each gap into
 * hearing (STT), us (application) and voice (TTS). Our own per-turn stats
 * (relay-transcript.storedTurnStats) then split "us" into model vs tools,
 * and they alone say which reply answers which prompt: Twilio's events carry
 * no link between a prompt and the text or audio that follows it, so a turn
 * with no stats of ours is never given a latency.
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
// Our first send vs Twilio's first_token_received, after removing the clock
// offset measured on the prompts: the same instant plus one network hop.
const SEND_WINDOW_MS = 750;

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
    // 404 = not ready yet, but only before any page was accepted; a later
    // 404 would silently truncate the call.
    if (res.status === 404 && page === 0) return { events, available: false };
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
 * Twilio's raw timeline, unattributed: the prompts it sent us (with the end
 * of speech and STT latency that produced each), every first text it got
 * back and every agent audio start, each stamped with the speech state at
 * that instant. Speech state never crosses a relay session boundary (a
 * reconnected call runs a second session on the same CallSid).
 */
function parseTimeline(events = []) {
  const out = { prompts: [], tokens: [], audioStarts: [], interrupts: 0 };
  let st = null;
  let sessionId = null;
  const fresh = () => ({ customerSpeaking: false, agentSpeaking: false, lastEnd: null, lastStt: null, pendingTts: null });
  for (const e of relayEvents(events)) {
    if (!st || (e.sessionId && sessionId && e.sessionId !== sessionId)) st = fresh();
    if (e.sessionId) sessionId = e.sessionId;
    const handle = PARSE_HANDLERS[e.name];
    if (handle) handle(st, e, out, sessionId);
  }
  return out;
}

// One handler per Twilio event name; unlisted names are ignored.
const PARSE_HANDLERS = {
  start_of_customer_speech: (st) => { st.customerSpeaking = true; },
  end_of_customer_speech: (st, e) => { st.customerSpeaking = false; st.lastEnd = e.at; },
  stt_latency: (st, e) => { st.lastStt = e.latencyMs; },
  tts_latency: (st, e) => { st.pendingTts = e.latencyMs; },
  prompt_sent: (st, e, out, sessionId) => {
    out.prompts.push({
      index: out.prompts.length + 1,
      sessionId,
      promptSentAt: e.at,
      // Twilio sends the prompt the instant it marks end of speech (same
      // millisecond in every observed call), but a back-to-back second
      // prompt can arrive with no end marker of its own; the prompt time
      // stands in, flagged.
      endOfCustomerSpeechAt: st.lastEnd ?? e.at,
      endOfSpeechInferred: st.lastEnd == null,
      sttMs: st.lastStt,
    });
    st.lastEnd = null;
    st.lastStt = null;
  },
  first_token_received: (st, e, out, sessionId) => {
    out.tokens.push({ at: e.at, sessionId, agentPlaying: st.agentSpeaking });
  },
  start_of_agent_speech: (st, e, out, sessionId) => {
    out.audioStarts.push({ at: e.at, sessionId, customerSpeaking: st.customerSpeaking, ttsMs: st.pendingTts });
    st.pendingTts = null;
    st.agentSpeaking = true;
  },
  end_of_agent_speech: (st) => { st.agentSpeaking = false; },
  preempted: (st) => { st.agentSpeaking = false; },
  interrupt: (st, e, out) => { out.interrupts += 1; st.agentSpeaking = false; },
};

/**
 * Order-preserving one-to-one alignment of two chronological lists: the most
 * pairs within `windowMs`, then the smallest total distance. Pairs never
 * cross, and greedy nearest-first can never strand a valid pair. Returns a
 * Map of left index → right index.
 */
function alignByTime(left, right, leftAt, rightAt, windowMs) {
  const n = left.length;
  const m = right.length;
  const better = (a, b) => (a.count !== b.count ? a.count > b.count : a.dist < b.dist);
  // best[i][j]: the best alignment of left i.. with right j.. (the last row
  // and column, nothing left on one side, stay empty alignments).
  const best = Array.from({ length: n + 1 }, () => Array.from({ length: m + 1 }, () => ({ count: 0, dist: 0, move: null })));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      let pick = { ...best[i + 1][j], move: 'skipLeft' };
      if (better(best[i][j + 1], pick)) pick = { ...best[i][j + 1], move: 'skipRight' };
      const d = Math.abs(leftAt(left[i]) - rightAt(right[j]));
      const take = d <= windowMs ? { count: best[i + 1][j + 1].count + 1, dist: best[i + 1][j + 1].dist + d, move: 'pair' } : null;
      if (take && better(take, pick)) pick = take;
      best[i][j] = pick;
    }
  }
  const pairs = new Map();
  for (let i = 0, j = 0; i < n && j < m;) {
    const { move } = best[i][j];
    if (move === 'pair') { pairs.set(i, j); i += 1; j += 1; } else if (move === 'skipRight') j += 1; else i += 1;
  }
  return pairs;
}

function median(values) {
  const v = [...values].sort((a, b) => a - b);
  return v.length ? v[Math.floor((v.length - 1) / 2)] : 0;
}

function oursView(s) {
  return {
    turn: s.turn,
    modelMs: Number.isFinite(s.modelMs) ? Math.round(s.modelMs) : null,
    toolMs: Number.isFinite(s.toolMs) ? Math.round(s.toolMs) : null,
    toolCount: Number.isFinite(s.toolCount) ? s.toolCount : null,
    tools: Array.isArray(s.tools) ? s.tools : [],
    rounds: Number.isFinite(s.rounds) ? s.rounds : null,
    renderer: s.renderer || null,
    interrupted: s.interrupted === true,
  };
}

/**
 * One row per prompt Twilio sent us, attributed by OUR stats only:
 *   1. prompts ↔ our turns by wall clock (promptWallAt vs prompt_sent);
 *   2. the clock offset between the two machines = median of those pairs;
 *   3. each turn's first send (promptWallAt + firstSendAt − promptAt, offset
 *      applied) ↔ Twilio's first_token_received — the reply that answers
 *      that prompt, whatever else was in flight;
 *   4. the first agent audio start after that text, in the same session and
 *      before the next text Twilio received, is that reply's audio.
 * Outcomes:
 *   spoke          — the reply's audio start is known: a latency sample
 *   queued         — the reply landed while earlier audio was still playing,
 *                    so Twilio logged no start of its own (not a sample)
 *   no_reply       — we sent nothing for this prompt (caller kept talking,
 *                    or the turn was cut off)
 *   no_audio_event — our reply reached Twilio but no attributable audio
 *                    start followed it
 *   unattributed   — no stats of ours for this prompt, or our send matched
 *                    no Twilio text: never guessed, never a sample
 */
function buildCallTimeline(events = [], turnStats = []) {
  const parsed = parseTimeline(events);
  const ours = (Array.isArray(turnStats) ? turnStats : []).filter((s) => s && typeof s === 'object' && Number.isFinite(s.promptWallAt))
    .sort((a, b) => a.promptWallAt - b.promptWallAt);
  const promptPairs = alignByTime(parsed.prompts, ours, (p) => p.promptSentAt, (s) => s.promptWallAt, JOIN_WINDOW_MS);
  const offset = median([...promptPairs].map(([i, j]) => parsed.prompts[i].promptSentAt - ours[j].promptWallAt));

  const sends = [];
  for (const [i, j] of promptPairs) {
    const s = ours[j];
    if (Number.isFinite(s.firstSendAt) && Number.isFinite(s.promptAt)) sends.push({ i, at: s.promptWallAt + offset + (s.firstSendAt - s.promptAt) });
  }
  sends.sort((a, b) => a.at - b.at);
  const sendPairs = alignByTime(sends, parsed.tokens, (x) => x.at, (t) => t.at, SEND_WINDOW_MS);
  const tokenFor = new Map([...sendPairs].map(([k, ti]) => [sends[k].i, ti]));

  return parsed.prompts.map((p, i) => {
    const j = promptPairs.get(i);
    const row = { ...p, ours: j == null ? null : oursView(ours[j]), firstTokenAt: null, agentSpeechStartAt: null, ttsMs: null, agentOverCaller: false };
    const outcome = attributeReply(row, parsed, tokenFor.get(i), j == null ? null : ours[j]);
    return finishRow({ ...row, ...outcome });
  });
}

function attributeReply(row, parsed, tokenIndex, stat) {
  if (!stat) return { outcome: 'unattributed' };
  if (!Number.isFinite(stat.firstSendAt)) return { outcome: 'no_reply' };
  if (tokenIndex == null) return { outcome: 'unattributed' };
  const token = parsed.tokens[tokenIndex];
  if (token.agentPlaying) return { outcome: 'queued', firstTokenAt: token.at };
  const nextToken = parsed.tokens[tokenIndex + 1];
  const audio = parsed.audioStarts.find((a) => a.at >= token.at && a.sessionId === token.sessionId && (!nextToken || a.at < nextToken.at));
  if (!audio) return { outcome: 'no_audio_event', firstTokenAt: token.at };
  return { outcome: 'spoke', firstTokenAt: token.at, agentSpeechStartAt: audio.at, ttsMs: audio.ttsMs, agentOverCaller: audio.customerSpeaking };
}

function finishRow(t) {
  const spoke = t.outcome === 'spoke';
  return {
    ...t,
    // The release-criteria gap: caller stops → caller hears Sandy.
    heardGapMs: spoke ? span(t.endOfCustomerSpeechAt, t.agentSpeechStartAt) : null,
    // Three non-overlapping boundary spans that add up to the heard gap:
    // end of speech → prompt sent (Twilio's turn handoff, usually 0),
    // prompt → first text back (us, incl. the websocket round trip),
    // first text → agent audio (synthesis + playout).
    endpointMs: spoke ? span(t.endOfCustomerSpeechAt, t.promptSentAt) : null,
    appMs: span(t.promptSentAt, t.firstTokenAt),
    voiceMs: spoke ? span(t.firstTokenAt, t.agentSpeechStartAt) : null,
    // sttMs / ttsMs stay as Twilio's provider diagnostics — they overlap the
    // spans above and are never added to them.
  };
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
 * reported apart (release criteria §2.3).
 */
function summarizeTimeline(rows = [], { interrupts = 0 } = {}) {
  const spoke = rows.filter((t) => t.outcome === 'spoke');
  const group = (list) => ({
    turns: list.length,
    heard_gap: stage(list.map((t) => t.heardGapMs)),
    endpoint: stage(list.map((t) => t.endpointMs)),
    app: stage(list.map((t) => t.appMs)),
    voice: stage(list.map((t) => t.voiceMs)),
    stt_provider: stage(list.map((t) => t.sttMs)),
    tts_provider: stage(list.map((t) => t.ttsMs)),
    // WHOLE-TURN work (every model round and tool call, including any after
    // the first reply was sent), not slices of the first-response gap.
    model_turn_total: stage(list.map((t) => t.ours && t.ours.modelMs)),
    tools_turn_total: stage(list.map((t) => t.ours && t.ours.toolMs)),
  });
  const outcomes = {};
  for (const t of rows) outcomes[t.outcome] = (outcomes[t.outcome] || 0) + 1;
  return {
    prompts: rows.length,
    outcomes,
    all: group(spoke),
    plain: group(spoke.filter((t) => t.ours.toolCount === 0)),
    tool: group(spoke.filter((t) => t.ours.toolCount > 0)),
    agent_over_caller: rows.filter((t) => t.agentOverCaller).length,
    caller_barge_ins: rows.filter((t) => t.ours && t.ours.interrupted).length,
    twilio_interrupts: interrupts,
  };
}

module.exports = {
  fetchConversationRelayEvents,
  relayEvents,
  parseTimeline,
  alignByTime,
  buildCallTimeline,
  summarizeTimeline,
  percentile,
  JOIN_WINDOW_MS,
  SEND_WINDOW_MS,
};
