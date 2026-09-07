/**
 * Relay segment storage and transcript composition.
 * The reconnect lifecycle lives in relay-recovery; both the closing socket
 * and recording processor consume this shared storage representation.
 */
const SEGMENT_SEPARATOR = '\n\n[Reconnected]\n';
const MAX_SEGMENT_TEXT_CHARS = require('./relay-transcript').MAX_TRANSCRIPT_CHARS;

/** One socket's close record — played text only (buildTranscriptText reads played text). */
function buildSegment({ generation, sessionKey, reason, text, turns, latency, versions, model = null, leadCaptured, leadId = null, reserviceFiled, noLeadCreated, promises = [], holdOpen, estimateFields = null, startedAt = null, lookupsUsed = 0, lookupRefs = [], lookupResults = [], slotRefs = [], modelFailures = 0, toolFailures = 0, turnCounts = null, turnStats = null }) {
  return {
    ...Object.fromEntries(Object.entries({ model_failures: modelFailures, tool_failures: toolFailures,
      lookups_used: lookupsUsed, generation, turns }).map(([key, value]) => [key, Number(value) || 0])),
    ...Object.fromEntries(Object.entries({ session_key: sessionKey, reason, latency, versions, model })
      .map(([key, value]) => [key, value || null])),
    slot_refs: slotRefs,
    lookup_refs: lookupRefs,
    lookup_results: lookupResults,
    // When this leg's session started (the first leg's is the CALL's start —
    // restored on the resumed leg so duration_seconds covers the whole call,
    // hook r25 P1).
    started_at: Number.isFinite(Number(startedAt)) && Number(startedAt) > 0 ? new Date(Number(startedAt)).toISOString() : null,
    // An INCOMPLETE estimate capture at this leg's close: the call was being
    // held open for the missing fields, and these are the fields already
    // given — both restored on the resumed leg (codex r2 P1).
    hold_open: holdOpen === true,
    estimate_fields: nonEmptyFields(estimateFields),
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
    text: String(text || '').slice(0, MAX_SEGMENT_TEXT_CHARS),
    turn_counts: turnCounts,
    turn_stats: turnStats,
    lead_captured: leadCaptured === true,
    lead_id: leadId,
    ended_at: new Date().toISOString(),
  };
}

/** The non-empty string entries of a fields object; null when there are none. */
function nonEmptyFields(fields) {
  if (!fields || typeof fields !== 'object') return null;
  const kept = Object.fromEntries(Object.entries(fields).filter(([, v]) => v != null && String(v).trim() !== '').map(([k, v]) => [k, String(v).trim()]));
  return Object.keys(kept).length ? kept : null;
}

/** Match the claim's generation/nonce total order (nonce tokens are ASCII). */
function compareSegments(a, b) {
  const generation = (Number(a.generation) || 0) - (Number(b.generation) || 0);
  if (generation) return generation;
  const left = String(a.session_key || '');
  const right = String(b.session_key || '');
  return left === right ? 0 : (left < right ? -1 : 1);
}

/** Scrub the ordered turn sequence before rendering socket boundaries. */
function scrubStoredSegments(segments) {
  const { scrubTurnsForStorage, CALLER_LABEL, AGENT_LABEL } = require('./relay-transcript');
  const ordered = [...segments].sort(compareSegments);
  const lines = ordered.flatMap((segment, index) => String(segment.text || '').split('\n').map((line) => {
    const caller = line.startsWith(`${CALLER_LABEL}: `);
    const agent = line.startsWith(`${AGENT_LABEL}: `);
    const prefix = caller ? `${CALLER_LABEL}: ` : (agent ? `${AGENT_LABEL}: ` : '');
    return { index, prefix, role: caller ? 'caller' : 'agent', text: line.slice(prefix.length) };
  }));
  const scrubbed = scrubTurnsForStorage(lines);
  if (!scrubbed) throw new Error('Relay segment scrub unavailable');
  const texts = ordered.map(() => []);
  scrubbed.forEach((turn, i) => {
    if (turn.text) texts[lines[i].index].push(lines[i].prefix + turn.text);
  });
  return ordered.map((segment, index) => ({ ...segment, text: texts[index].join('\n') }));
}

/** Called only for a server-authenticated socket, before it can run a model turn. */
async function registerSegmentSession(db, callSid, sessionKey) {
  if (!callSid || !sessionKey) return false;
  const written = await db('call_log').where('twilio_call_sid', callSid)
    .whereRaw("COALESCE(metadata->>'relay_segments_sealed', 'false') <> 'true'")
    .update({ metadata: db.raw(
      "COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('relay_segment_owners', COALESCE(metadata->'relay_segment_owners', '[]'::jsonb) || ?::jsonb)",
      [JSON.stringify([sessionKey])],
    ) });
  return Number(written) > 0;
}

/**
 * Serialize closes on the call row. Repair prior fragments and append the new
 * leg in one transaction, so no reader sees a reconstructed card number and
 * a concurrent late close cannot reintroduce a fragment from a stale read.
 */
async function appendSegment(db, callSid, segment, { allowUnclaimed = false } = {}) {
  return db.transaction(async (trx) => {
    const query = trx('call_log').where('twilio_call_sid', callSid)
      .where((q) => {
        q.whereRaw("(metadata->>'relay_session_claim_owner') = ?", [segment.session_key || ''])
        .orWhereRaw("metadata->'relay_segment_owners' @> ?::jsonb", [JSON.stringify([segment.session_key || ''])])
        .orWhereRaw("(COALESCE((metadata->>'relay_reconnects')::int, 0) > 0 AND (COALESCE((metadata->>'relay_reconnect_ms')::bigint, 0) > ? OR (COALESCE((metadata->>'relay_session_claim_gen')::bigint, 0) = ? AND COALESCE(metadata->>'relay_session_claim_owner', '') > ?)))", [segment.generation || 0, segment.generation || 0, segment.session_key || '']);
        if (allowUnclaimed) q.orWhereRaw("metadata->>'relay_session_claim_owner' IS NULL");
      });
    const row = await query.clone().forUpdate().first('metadata');
    if (!row) return 0;
    const meta = typeof row.metadata === 'string' ? JSON.parse(row.metadata) : (row.metadata || {});
    const prior = Array.isArray(meta.relay_segments) ? meta.relay_segments : [];
    if (prior.some((s) => s.session_key === segment.session_key)) return 1;
    // Extraction seals only a complete registered set. No later socket may
    // change the evidence after either extractor or routing has started.
    if (meta.relay_segments_sealed === true) return 0;
    if (Array.isArray(meta.relay_segment_owners) && !meta.relay_segment_owners.includes(segment.session_key)) return 0;
    const scrubbed = scrubStoredSegments([...prior, segment]);
    const next = scrubbed.find((s) => s.session_key === segment.session_key);
    const repaired = scrubbed.filter((s) => s !== next);
    // The existing append owns all transcript/stash/composite updates. Only
    // its input metadata changes here, under the same row lock.
    if (JSON.stringify(repaired) !== JSON.stringify(prior)) {
      await query.clone().update({ metadata: trx.raw(
        "COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('relay_segments', ?::jsonb)",
        [JSON.stringify(repaired)],
      ) });
    }
    return query.update(appendSegmentPatch(trx, next));
  });
}

/**
 * Close the existing claim/append lifecycle before recording extraction.
 * Every claimed socket, including a silent one, must have a durable close.
 * The same call-row lock orders this seal against appends and new claims.
 */
async function sealSegmentsForExtraction(db, callId, processingToken) {
  return db.transaction(async (trx) => {
    const query = trx('call_log').where({ id: callId }).where('processing_token', processingToken);
    const row = await query.clone().forUpdate().first();
    if (!row) return { status: 'ownership_lost' };
    const meta = typeof row.metadata === 'string' ? JSON.parse(row.metadata) : (row.metadata || {});
    const owners = meta.relay_segment_owners;
    if (Array.isArray(owners) && !hasCompleteSegments(meta)) {
      return { status: 'pending' };
    }
    await query.update({ metadata: trx.raw(
      "COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('relay_segments_sealed', true)",
    ) });
    return { status: 'ready', row };
  });
}

/** A silent close counts; absent registration cannot prove completion. */
function hasCompleteSegments(meta, excludedOwner = null) {
  const owners = meta?.relay_segment_owners;
  const segments = Array.isArray(meta?.relay_segments) ? meta.relay_segments : [];
  return Array.isArray(owners) && owners.every((owner) => owner === excludedOwner
    || segments.some((segment) => segment.session_key === owner));
}

/** Recompute percentiles from observations, never from per-socket percentiles. */
function summarizeSegments(meta) {
  const legs = Array.isArray(meta?.relay_segments) ? meta.relay_segments : [];
  if (!legs.length) return null;
  // Old durable records remain readable; missing observations are unknown,
  // not zero-latency samples or a complete recovery evaluation.
  const countKeys = ['caller_turns', 'agent_turns', 'tool_calls'];
  const telemetryComplete = hasCompleteSegments(meta) && legs.every((leg) => Array.isArray(leg.turn_stats)
    && countKeys.every((key) => Number.isFinite(leg.turn_counts?.[key])));
  const counts = Object.fromEntries(countKeys.map((key) => [key,
    telemetryComplete ? legs.reduce((sum, leg) => sum + leg.turn_counts[key], 0) : null,
  ]));
  const latest = [...legs].sort(compareSegments).at(-1);
  return {
    ...counts,
    lead_captured: Boolean(meta.relay_lead_id) || legs.some((leg) => leg.lead_captured === true),
    reservice_filed: meta.relay_reservice_filed === true || legs.some((leg) => leg.reservice_filed === true),
    ...Object.fromEntries(Object.entries({ end_reason: latest.reason, versions: latest.versions, model: latest.model })
      .filter(([, value]) => value != null)),
    latency: telemetryComplete ? require('./relay-transcript').summarizeTurnStats(legs.flatMap((leg) => leg.turn_stats)) : null,
    segments: { count: legs.length, complete: hasCompleteSegments(meta), telemetry_complete: telemetryComplete },
  };
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
    `(SELECT left(string_agg(seg->>'text', ? ORDER BY (seg->>'generation')::bigint, COALESCE(seg->>'session_key', '') COLLATE \"C\", ord), ${MAX_SEGMENT_TEXT_CHARS}) FROM jsonb_array_elements(${source}) WITH ORDINALITY AS s(seg, ord) WHERE COALESCE(seg->>'text', '') <> '')`,
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
      // column on a RECONNECTED row (the resumed socket closed silently
      // before this segment landed) ⇒ filled — never on a call that never
      // reconnected (a failed claim's voicemail row keeps its columns for
      // the recording's transcript, hook r28 P1). A COMPOSITE the recording processor already wrote
      // ("[AI segment]…[Staff|Voicemail segment]…") ⇒ only its AI portion is
      // refreshed; the recorded portion is preserved verbatim
      // (substring(from) with a NON-capturing group returns the whole
      // match — a capturing group would return just the word, hook P0).
      // A recording's own transcript is never touched.
      `CASE
         WHEN transcription_provider = ? AND COALESCE(transcription, '') <> '' AND ? IS NOT NULL THEN ?
         WHEN ${FILL_EMPTY_SQL} AND ? IS NOT NULL THEN ?
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
      `CASE WHEN ${FILL_EMPTY_SQL} AND ? IS NOT NULL THEN ? ELSE transcription_provider END`,
      [compose(), RELAY_PROVIDER],
    ),
    transcription_status: db.raw(
      `CASE WHEN ${FILL_EMPTY_SQL} AND ? IS NOT NULL THEN 'completed' ELSE transcription_status END`,
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
// An EMPTY, unowned transcript column on a row that RECONNECTED — the only
// empty column a late segment may fill (hook r28 P1).
const FILL_EMPTY_SQL = "(COALESCE(transcription, '') = '' AND transcription_provider IS NULL AND COALESCE((metadata->>'relay_reconnects')::int, 0) > 0)";
// A recorded transcript on a reconnected call or a durably proven transfer: the
// processor finished before this segment landed (a silent resumed leg wrote
// no stash). The recording is preserved; the AI segment goes ahead of it.
const RECORDED_ONLY_SQL = "((transcription_provider <> ? OR (transcription_provider IS NULL AND transcription_metadata->'recorded_segment_rejected' IS NOT NULL)) AND COALESCE(transcription, '') <> '' AND transcription NOT LIKE '[AI segment]%' AND (COALESCE((metadata->>'relay_reconnects')::int, 0) > 0 OR call_outcome = 'ai_transferred' OR jsonb_typeof(metadata->'relay_handoff') = 'object' OR metadata->>'relay_transfer_ring_at' IS NOT NULL OR jsonb_array_length(COALESCE(metadata->'relay_segment_owners', '[]'::jsonb)) > 0))";
const RELAY_PROVIDER = require('./relay-transcript').TRANSCRIPTION_PROVIDER;
// The recorded half of a processor composite, from its segment header to the end (non-capturing!).
const COMPOSITE_RECORDED_RE = '\\n\\n\\[(?:Staff|Voicemail) segment\\]\\n[\\s\\S]*$';

/** Order segments the way the SQL does; the in-memory twin for summaries/tests. */
function segmentsText(segments = []) {
  return Array.from([...(Array.isArray(segments) ? segments : [])]
    .filter((s) => s && String(s.text || '').trim())
    .sort(compareSegments)
    .map((s) => String(s.text))
    .join(SEGMENT_SEPARATOR)).slice(0, MAX_SEGMENT_TEXT_CHARS).join('');
}

/** The caller's lines of a played-text transcript (the capture floor's summary is built from these). */
function callerTurnsFromText(text) {
  const callerLabel = `${require('./relay-transcript').CALLER_LABEL}: `;
  return String(text || '').split('\n').filter((line) => line.startsWith(callerLabel)).map((line) => line.slice(callerLabel.length).trim()).filter(Boolean);
}


/** A close must remain both the current owner and no older than a pending reconnect. */
function closeFenceSql(q, generation, sessionKey) {
  return q.whereRaw("COALESCE((metadata->>'relay_reconnect_ms')::bigint, 0) <= ?", [Number(generation) || 0])
    .whereRaw("((metadata->>'relay_session_claim_owner') IS NULL OR (metadata->>'relay_session_claim_owner') = ?)", [sessionKey || '']);
}

/** The latest promise per kind across a row's segments, in generation order. */
function latestPromises(segments) {
  const ordered = [...(Array.isArray(segments) ? segments : [])]
    .filter((seg) => seg && typeof seg === 'object')
    .sort(compareSegments);
  const byKind = new Map();
  for (const seg of ordered) {
    for (const p of (Array.isArray(seg.promises) ? seg.promises : [])) {
      if (p && p.kind) byKind.set(String(p.kind), { verdict: p.verdict === true, expectation: p.expectation || null, at: p.at || null });
    }
  }
  return [...byKind.entries()].map(([kind, v]) => ({ kind, ...v }));
}


module.exports = {
  summarizeSegments, hasCompleteSegments, compareSegments, appendSegment, registerSegmentSession, sealSegmentsForExtraction, scrubStoredSegments, closeFenceSql, latestPromises, SEGMENT_SEPARATOR, buildSegment, nonEmptyFields, appendSegmentSql,
  appendSegmentPatch, composeSegmentsSql, segmentsText, callerTurnsFromText,
};
