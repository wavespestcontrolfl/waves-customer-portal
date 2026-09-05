/**
 * Sandy PR 2B — voice-session recovery (GATE_VOICE_RELAY_RECOVERY).
 *
 * Twilio does not reconnect a dropped <ConversationRelay> socket: the call
 * fails and /relay-complete fires. This module is the small, testable core
 * of the recovery: the ONE reconnect claim per CallSid, the segment record
 * every socket appends at close, the SQL that composes the whole call from
 * its segments, the resumed session's proof, and the provider-failure
 * policy. Everything here is fail-closed: an unconfirmed claim never
 * re-renders, an unproven `resumed` hint changes nothing, the gate is read
 * at call time so unsetting it is the live kill switch.
 */
const logger = require('../logger');

const RECONNECT_LIMIT = 1;
const RESUME_STATE_TIMEOUT_MS = 2000;
const PROVIDER_FAILURE_LIMIT = 2;
const SEGMENT_SEPARATOR = '\n\n[Reconnected]\n';
// A segment keeps everything the transcript store keeps (relay-transcript's
// own cap) — the composition must never be shorter than today's transcript.
// The smaller cap applies ONLY to the model-history seed on a resumed leg.
const MAX_SEGMENT_TEXT_CHARS = require('./relay-transcript').MAX_TRANSCRIPT_CHARS;
const RESUME_SEED_MAX_CHARS = 20000;

function isRecoveryGateOn() {
  return process.env.GATE_VOICE_RELAY_RECOVERY === 'true';
}

/**
 * The reconnect claim — ONE statement, atomic, fenced: only a row that has
 * never reconnected AND is still live or AI-handled (a voicemail /
 * transferred / relay_failed row is never resumed) takes the stamp. The same
 * statement puts the call back into its live shape (the first socket's close
 * may already have stamped it completed / ai_handled) so the resumed session
 * can transfer and reconcile like any live session. `relay_reconnect_ms` is
 * the GENERATION FENCE for close-time column writes: the new token is minted
 * after this stamp, so its generation is ≥ the fence and the old socket's is
 * below it. Returns the row count (0 = not resumable / already reconnected).
 */
function claimReconnect(db, { callSid, nowMs = Date.now() }) {
  return db('call_log')
    .where('twilio_call_sid', callSid)
    .whereRaw("COALESCE((metadata->>'relay_reconnects')::int, 0) < ?", [RECONNECT_LIMIT])
    .where((q) => q.whereNull('call_outcome').orWhere('call_outcome', 'ai_handled'))
    .update({
      metadata: db.raw(
        "COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('relay_reconnects', COALESCE((metadata->>'relay_reconnects')::int, 0) + 1, 'relay_reconnect_ms', ?::bigint)",
        [nowMs],
      ),
      call_outcome: null,
      status: 'in-progress',
      answered_by: 'ai_agent',
      updated_at: new Date(),
    });
}

/**
 * The compensator for a claim that timed out but LANDS later (the deadline
 * cannot cancel a queued UPDATE): the caller is already in the fallback, so
 * the live shape the claim restored is put back to what the fallback wrote.
 * Fenced on the claim's own marks, so a row a later socket actually resumed
 * is left alone.
 */
function undoLateReconnect(db, { callSid, nowMs, outcome = 'voicemail', answeredBy = 'voicemail', status = 'completed' }) {
  return db('call_log')
    .where('twilio_call_sid', callSid)
    .whereRaw("(metadata->>'relay_reconnect_ms')::bigint = ?", [nowMs])
    // …and no socket minted by the reconnect has claimed the call meanwhile
    // (a retry may have re-issued the render while this compensation was
    // pending): a claim at or after the stamp is the healthy resumed
    // session, never put back (hook r21 P1).
    .whereRaw("COALESCE((metadata->>'relay_session_claim_gen')::bigint, 0) < ?", [nowMs])
    .whereNull('call_outcome')
    .update({ call_outcome: outcome, answered_by: answeredBy, status, updated_at: new Date() });
}

/**
 * The RE-ISSUE of a reconnect whose response Twilio never received (codex
 * r2 P1): one fenced UPDATE that moves the stamp forward to `nowMs` — only
 * while the row is still in the live shape the claim left (outcome NULL:
 * a claim put back to voicemail / relay_failed is never re-rendered, hook
 * r21 P1) and no socket minted by the prior stamp has claimed it (the
 * resumed leg is not live). The new stamp is the fence the fresh token is
 * minted against, and it retires the prior stamp's pending compensation
 * (fenced on `priorMs`). Returns the row count.
 */
function reissueReconnect(db, { callSid, priorMs, nowMs = Date.now() }) {
  return db('call_log')
    .where('twilio_call_sid', callSid)
    .whereRaw("(metadata->>'relay_reconnect_ms')::bigint = ?", [priorMs])
    .whereRaw("COALESCE((metadata->>'relay_session_claim_gen')::bigint, 0) < ?", [priorMs])
    .whereNull('call_outcome')
    .update({
      metadata: db.raw("COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('relay_reconnect_ms', ?::bigint)", [nowMs]),
      updated_at: new Date(),
    });
}

/** The welcome greeting Twilio speaks on the reconnected leg. */
function resumeGreeting(language) {
  return require('./relay-language').copy('resumed', language);
}

/** One socket's close record — played text only (buildTranscriptText reads played text). */
function buildSegment({ generation, sessionKey, reason, text, turns, latency, versions, leadCaptured, reserviceFiled = false, noLeadCreated = false, modelFailures = 0, toolFailures = 0, promises = [], holdOpen = false, estimateFields = null, startedAt = null }) {
  return {
    // When this leg's session started (the first leg's is the CALL's start —
    // restored on the resumed leg so duration_seconds covers the whole call,
    // hook r25 P1).
    started_at: Number.isFinite(Number(startedAt)) && Number(startedAt) > 0 ? new Date(Number(startedAt)).toISOString() : null,
    // An INCOMPLETE estimate capture at this leg's close: the call was being
    // held open for the missing fields, and these are the fields already
    // given — both restored on the resumed leg (codex r2 P1).
    hold_open: holdOpen === true,
    estimate_fields: nonEmptyFields(estimateFields),
    // The provider-failure streak at this leg's close (restored on resume).
    model_failures: Number(modelFailures) || 0,
    tool_failures: Number(toolFailures) || 0,
    // This leg's capture state: a filed re-service deliberately creates NO
    // lead, and the resumed leg must not route it through lead capture again.
    reservice_filed: reserviceFiled === true,
    no_lead_created: noLeadCreated === true,
    // Sandy's promises on this leg (kind, verdict, spoken expectation, when
    // spoken) — restored on the resumed leg so the commitments pass keeps
    // the original deadline instead of deriving a bare promise (hook P1).
    promises: (Array.isArray(promises) ? promises : []).map((p) => ({
      kind: String(p.kind || ''),
      verdict: p.verdict === true,
      expectation: p.expectation || null,
      at: p.at instanceof Date ? p.at.toISOString() : (p.at || null),
    })).filter((p) => p.kind),
    generation: Number(generation) || 0,
    session_key: sessionKey || null,
    reason: reason || null,
    text: String(text || '').slice(0, MAX_SEGMENT_TEXT_CHARS),
    turns: Number(turns) || 0,
    latency: latency || null,
    versions: versions || null,
    lead_captured: leadCaptured === true,
    ended_at: new Date().toISOString(),
  };
}

/** The non-empty string entries of a fields object; null when there are none. */
function nonEmptyFields(fields) {
  if (!fields || typeof fields !== 'object') return null;
  const kept = Object.fromEntries(Object.entries(fields).filter(([, v]) => v != null && String(v).trim() !== '').map(([k, v]) => [k, String(v).trim()]));
  return Object.keys(kept).length ? kept : null;
}

/** metadata := metadata || { relay_segments: existing || [segment] } — an append, never an overwrite. */
function appendSegmentSql(db, segment) {
  return db.raw(
    "COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('relay_segments', COALESCE(metadata->'relay_segments', '[]'::jsonb) || ?::jsonb)",
    [JSON.stringify([segment])],
  );
}

/**
 * The whole call's transcript composed from EVERY segment on the row (the
 * closing socket appends its own segment FIRST, in its own statement) in
 * generation order, separated by [Reconnected]. NULL when the row has no
 * segments — callers COALESCE to their local text.
 */
function composeSegmentsSql(db, segment = null) {
  // With `segment`, the not-yet-appended segment is unioned in (the UPDATE
  // reads the old row) — the append statement composes this way, and so
  // does a close whose append was UNCONFIRMED (hook r27 P1): the row's copy
  // of this socket's segment, if the append landed after all, is dropped by
  // session key so the text never appears twice.
  const rowSegments = "COALESCE(metadata->'relay_segments', '[]'::jsonb)";
  const keyed = segment && segment.session_key;
  const source = segment
    ? `${keyed ? `(SELECT COALESCE(jsonb_agg(e), '[]'::jsonb) FROM jsonb_array_elements(${rowSegments}) e WHERE COALESCE(e->>'session_key', '') <> ?)` : rowSegments} || ?::jsonb`
    : rowSegments;
  return db.raw(
    `(SELECT string_agg(seg->>'text', ? ORDER BY (seg->>'generation')::bigint, ord) FROM jsonb_array_elements(${source}) WITH ORDINALITY AS s(seg, ord) WHERE COALESCE(seg->>'text', '') <> '')`,
    segment ? [SEGMENT_SEPARATOR, ...(keyed ? [String(segment.session_key)] : []), JSON.stringify([segment])] : [SEGMENT_SEPARATOR],
  );
}

/**
 * The append that also RECOMPOSES a call the other socket already finalized
 * (hook P1): the old socket can still be draining when the resumed socket
 * closes and composes; when its segment then lands, supersession skips every
 * column write it would do — so the append itself refreshes the columns
 * Sandy owns (transcription_provider = conversation_relay; a recording's
 * transcript is never touched) and the relay_transcript stash when present.
 * Deterministic whichever socket runs it: all segments, generation order.
 */
function appendSegmentPatch(db, segment) {
  const compose = () => composeSegmentsSql(db, segment);
  const appended = appendSegmentSql(db, segment);
  return {
    metadata: db.raw(
      "CASE WHEN (metadata->'relay_transcript') IS NOT NULL AND ? IS NOT NULL THEN jsonb_set(?, '{relay_transcript,text}', to_jsonb(?::text), false) ELSE ? END",
      [compose(), appended, compose(), appended],
    ),
    transcription: db.raw(
      // Sandy-owned column ⇒ the whole composed call. An EMPTY, unowned
      // column (the resumed socket closed silently before this segment
      // landed) ⇒ filled. A COMPOSITE the recording processor already wrote
      // ("[AI segment]…[Staff|Voicemail segment]…") ⇒ only its AI portion is
      // refreshed; the recorded portion is preserved verbatim
      // (substring(from) with a NON-capturing group returns the whole
      // match — a capturing group would return just the word, hook P0).
      // A recording's own transcript is never touched.
      `CASE
         WHEN transcription_provider = ? AND COALESCE(transcription, '') <> '' AND ? IS NOT NULL THEN ?
         WHEN COALESCE(transcription, '') = '' AND transcription_provider IS NULL AND ? IS NOT NULL THEN ?
         WHEN transcription LIKE '[AI segment]%' AND transcription ~ ? AND ? IS NOT NULL
           THEN '[AI segment]' || E'\\n' || ? || substring(transcription from ?)
         WHEN ${RECORDED_ONLY_SQL} AND ? IS NOT NULL
           THEN '[AI segment]' || E'\\n' || ? || E'\\n\\n[' || CASE WHEN call_outcome = 'voicemail' THEN 'Voicemail' ELSE 'Staff' END || E' segment]' || E'\\n' || transcription
         ELSE transcription
       END`,
      [RELAY_PROVIDER, compose(), compose(), compose(), compose(), COMPOSITE_RECORDED_RE, compose(), compose(), COMPOSITE_RECORDED_RE, RELAY_PROVIDER, compose(), compose()],
    ),
    // The fill above also claims provider/status for the row; every other
    // branch leaves them as they are.
    transcription_provider: db.raw(
      "CASE WHEN COALESCE(transcription, '') = '' AND transcription_provider IS NULL AND ? IS NOT NULL THEN ? ELSE transcription_provider END",
      [compose(), RELAY_PROVIDER],
    ),
    transcription_status: db.raw(
      "CASE WHEN COALESCE(transcription, '') = '' AND transcription_provider IS NULL AND ? IS NOT NULL THEN 'completed' ELSE transcription_status END",
      [compose()],
    ),
    // A composite has no structured form: the recorded-only branch clears it.
    transcript_structured: db.raw(
      `CASE WHEN ${RECORDED_ONLY_SQL} AND ? IS NOT NULL THEN NULL ELSE transcript_structured END`,
      [RELAY_PROVIDER, compose()],
    ),
    updated_at: new Date(),
  };
}
// A RECORDING's own transcript, alone, on a row that reconnected: the
// processor finished before this segment landed (a silent resumed leg wrote
// no stash). The recording is preserved; the AI segment goes ahead of it.
const RECORDED_ONLY_SQL = "(transcription_provider IS NOT NULL AND transcription_provider <> ? AND COALESCE(transcription, '') <> '' AND transcription NOT LIKE '[AI segment]%' AND COALESCE((metadata->>'relay_reconnects')::int, 0) > 0)";
const RELAY_PROVIDER = require('./relay-transcript').TRANSCRIPTION_PROVIDER;
// The recorded half of a processor composite, from its segment header to the end (non-capturing!).
const COMPOSITE_RECORDED_RE = '\\n\\n\\[(?:Staff|Voicemail) segment\\]\\n[\\s\\S]*$';

/** The close-time column-write fence: a socket older than the latest reconnect never writes columns. */
function generationFenceSql(q, generation) {
  return q.whereRaw("COALESCE((metadata->>'relay_reconnect_ms')::bigint, 0) <= ?", [Number(generation) || 0]);
}

/** Order segments the way the SQL does; the in-memory twin for summaries/tests. */
function segmentsText(segments = []) {
  return [...(Array.isArray(segments) ? segments : [])]
    .filter((s) => s && String(s.text || '').trim())
    .sort((a, b) => (Number(a.generation) || 0) - (Number(b.generation) || 0))
    .map((s) => String(s.text))
    .join(SEGMENT_SEPARATOR);
}

/**
 * The resumed session's PROOF (bounded, fail-soft null): the row's reconnect
 * stamp AND the requesting session's OWNERSHIP of the claim — the earlier
 * caller's dialogue, lead and promises are privileged context, handed only
 * to the socket whose nonce is the row's current claim owner (a verified
 * session that won the takeover). A `resumed` <Parameter> on any other
 * socket — unverified, superseded, forged — proves nothing (hook P0).
 */
async function loadResumeState(db, callSid, { sessionKey = null, timeoutMs = RESUME_STATE_TIMEOUT_MS } = {}) {
  if (!callSid || !sessionKey) return null;
  let timer;
  const read = db('call_log').where('twilio_call_sid', callSid).first('metadata')
    .then((row) => {
      if (!row) return null;
      let meta = row.metadata;
      if (typeof meta === 'string') { try { meta = JSON.parse(meta); } catch { meta = null; } }
      if (!meta || typeof meta !== 'object') return null;
      if (String(meta.relay_session_claim_owner || '') !== String(sessionKey)) return null; // not this socket's call
      const reconnects = Number(meta.relay_reconnects) || 0;
      if (reconnects <= 0) return null;
      const full = segmentsText(meta.relay_segments);
      const promises = latestPromises(meta.relay_segments);
      const callerTurns = callerTurnsFromText(full);
      const legs = Array.isArray(meta.relay_segments) ? meta.relay_segments.filter((seg) => seg && typeof seg === 'object') : [];
      const latest = [...legs].sort((a, b) => (Number(b.generation) || 0) - (Number(a.generation) || 0))[0] || null;
      return {
        reconnects,
        reconnectMs: Number(meta.relay_reconnect_ms) || null,
        modelFailures: latest ? Number(latest.model_failures) || 0 : 0,
        toolFailures: latest ? Number(latest.tool_failures) || 0 : 0,
        reserviceFiled: legs.some((seg) => seg.reservice_filed === true),
        noLeadCreated: legs.some((seg) => seg.no_lead_created === true),
        // A lead captured on an earlier leg even when its relay_lead_id
        // stamp (best-effort) did not land (codex r3 P2).
        leadCaptured: legs.some((seg) => seg.lead_captured === true),
        // The earliest leg's start = the call's start (null when no leg recorded one).
        startedAtMs: legs.map((seg) => Date.parse(seg.started_at || '')).filter((ms) => Number.isFinite(ms) && ms > 0).reduce((min, ms) => (min === null || ms < min ? ms : min), null),
        // The LATEST leg's hold (a later complete capture clears it) and the
        // estimate fields accumulated across every leg, later legs winning.
        holdOpen: latest ? latest.hold_open === true : false,
        estimateFields: nonEmptyFields(Object.assign({}, ...[...legs].sort((a, b) => (Number(a.generation) || 0) - (Number(b.generation) || 0)).map((seg) => nonEmptyFields(seg.estimate_fields) || {}))),
        // The seed keeps the TAIL (the most recent turns matter most).
        segmentsText: full.length > RESUME_SEED_MAX_CHARS ? `[…]${full.slice(-RESUME_SEED_MAX_CHARS)}` : full,
        relayLeadId: meta.relay_lead_id ? String(meta.relay_lead_id) : null,
        promises,
        callerTurns, // the earlier legs' caller lines — the resumed capture floor's summary starts from these
      };
    });
  const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve(null), timeoutMs); timer.unref?.(); });
  try {
    return await Promise.race([read, timeout]);
  } catch (err) {
    logger.warn(`[voice-relay-recovery] resume state read failed: ${err.message}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** The caller's lines of a played-text transcript (the capture floor's summary is built from these). */
function callerTurnsFromText(text) {
  const callerLabel = `${require('./relay-transcript').CALLER_LABEL}: `;
  return String(text || '').split('\n').filter((line) => line.startsWith(callerLabel)).map((line) => line.slice(callerLabel.length).trim()).filter(Boolean);
}

/** The latest promise per kind across a row's segments, in generation order. */
function latestPromises(segments) {
  const ordered = [...(Array.isArray(segments) ? segments : [])]
    .filter((seg) => seg && typeof seg === 'object')
    .sort((a, b) => (Number(a.generation) || 0) - (Number(b.generation) || 0));
  const byKind = new Map();
  for (const seg of ordered) {
    for (const p of (Array.isArray(seg.promises) ? seg.promises : [])) {
      if (p && p.kind) byKind.set(String(p.kind), { verdict: p.verdict === true, expectation: p.expectation || null, at: p.at || null });
    }
  }
  return [...byKind.entries()].map(([kind, v]) => ({ kind, ...v }));
}

/**
 * The row's reconnect marks (bounded, fail-soft null) — /relay-complete's
 * discriminator between a Twilio RETRY of the first failure (no `gen`, or a
 * stale one, on a row already reconnected) and the resumed leg's own
 * failure (its action URL carries `gen` = the row's relay_reconnect_ms).
 */
async function readReconnectState(db, callSid, { timeoutMs = RESUME_STATE_TIMEOUT_MS } = {}) {
  if (!callSid) return null;
  let timer;
  const read = db('call_log').where('twilio_call_sid', callSid).first('metadata').then((row) => {
    if (!row) return null;
    let meta = row.metadata;
    if (typeof meta === 'string') { try { meta = JSON.parse(meta); } catch { meta = null; } }
    if (!meta || typeof meta !== 'object') return { reconnects: 0, reconnectMs: null, profile: null };
    // The relay profile the first leg was stamped with (id + validated
    // attrs) — the resumed leg opens with the SAME one, so a sandbox cell
    // or a production profile is attributed to the whole call.
    const profile = meta.relay_profile_id
      ? { relayProfileId: String(meta.relay_profile_id), relayAttrs: (meta.relay_attrs && typeof meta.relay_attrs === 'object') ? meta.relay_attrs : {} }
      : null;
    return {
      reconnects: Number(meta.relay_reconnects) || 0,
      reconnectMs: Number(meta.relay_reconnect_ms) || null,
      // The generation of the row's CURRENT claim owner (a token's mint ms):
      // ≥ reconnectMs ⇒ a socket minted by the reconnect has claimed the
      // call (the resumed leg is live); below it ⇒ only the first leg ever
      // did — the reconnect TwiML was never acted on.
      claimGen: Number(meta.relay_session_claim_gen) || 0,
      profile,
    };
  });
  const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve(null), timeoutMs); timer.unref?.(); });
  try { return await Promise.race([read, timeout]); } catch { return null; } finally { clearTimeout(timer); }
}

/** 'handoff' once either counter reaches the limit; null otherwise. */
function providerFailurePolicy({ modelFailures = 0, toolFailures = 0 } = {}) {
  return (modelFailures >= PROVIDER_FAILURE_LIMIT || toolFailures >= PROVIDER_FAILURE_LIMIT) ? 'handoff' : null;
}

module.exports = {
  RECONNECT_LIMIT,
  PROVIDER_FAILURE_LIMIT,
  SEGMENT_SEPARATOR,
  isRecoveryGateOn,
  claimReconnect,
  undoLateReconnect,
  reissueReconnect,
  resumeGreeting,
  buildSegment,
  appendSegmentSql,
  appendSegmentPatch,
  composeSegmentsSql,
  generationFenceSql,
  segmentsText,
  loadResumeState,
  readReconnectState,
  latestPromises,
  callerTurnsFromText,
  providerFailurePolicy,
  RESUME_SEED_MAX_CHARS,
};
