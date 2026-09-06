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
const { compareSegments, segmentsText, callerTurnsFromText, nonEmptyFields, latestPromises } = require('./relay-segments');

const RECONNECT_LIMIT = 1;
const RESUME_STATE_TIMEOUT_MS = 2000;
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

/** A failure callback may finalize only the generation it proved. */
function fallbackFence(q, { generation, callbackGeneration, ringClaim = null }) {
  // A callback may compensate only its own atomically stamped ring claim,
  // including when the claim's result arrives after the webhook deadline.
  return q.whereRaw("((call_outcome IS DISTINCT FROM ? AND metadata->>'relay_transfer_ring_at' IS NULL) OR metadata->>'relay_transfer_ring_claim' = ?)", ['ai_transferred', ringClaim])
    .whereRaw("COALESCE((metadata->>'relay_reconnect_ms')::bigint, 0) = ?", [generation])
    .whereRaw("(?::bigint = 0 OR ?::bigint = ?::bigint OR COALESCE((metadata->>'relay_session_claim_gen')::bigint, 0) < ?)",
      [generation, callbackGeneration, generation, generation]);
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
      const latest = [...legs].sort(compareSegments).at(-1) || null;
      return {
        reconnects,
        reconnectMs: Number(meta.relay_reconnect_ms) || null,
        modelFailures: latest ? Number(latest.model_failures) || 0 : 0,
        toolFailures: latest ? Number(latest.tool_failures) || 0 : 0,
        reserviceFiled: meta.relay_reservice_filed === true || legs.some((seg) => seg.reservice_filed === true),
        noLeadCreated: legs.some((seg) => seg.no_lead_created === true),
        // A lead captured on an earlier leg even when its relay_lead_id
        // stamp (best-effort) did not land (codex r3 P2).
        leadCaptured: legs.some((seg) => seg.lead_captured === true),
        lookupsUsed: legs.reduce((max, seg) => Math.max(max, Number(seg.lookups_used) || 0), 0),
        lookupResults: [...new Set(legs.flatMap((seg) => Array.isArray(seg.lookup_results) ? seg.lookup_results.filter((result) => typeof result === 'string') : []))],
        lookupRefs: legs.flatMap((seg) => Array.isArray(seg.lookup_refs) ? seg.lookup_refs : [])
          .filter((entry) => Array.isArray(entry) && entry.length === 2 && typeof entry[0] === 'string' && typeof entry[1] === 'string'),
        // Later offers carry the context used for the commit-time slot recheck.
        // Old segments without the registry remain readable.
        slotRefs: [...new Map([...legs].sort((a, b) => (Number(a.generation) || 0) - (Number(b.generation) || 0))
          .flatMap((seg) => Array.isArray(seg.slot_refs) ? seg.slot_refs : [])
          .filter((entry) => Array.isArray(entry) && entry.length === 2 && typeof entry[0] === 'string'
            && typeof entry[1]?.date === 'string' && Number.isFinite(entry[1]?.startMinutes)))],
        // The earliest leg's start = the call's start (null when no leg recorded one).
        startedAtMs: legs.map((seg) => Date.parse(seg.started_at || '')).filter((ms) => Number.isFinite(ms) && ms > 0).reduce((min, ms) => (min === null || ms < min ? ms : min), null),
        // The LATEST leg's hold (a later complete capture clears it) and the
        // estimate fields accumulated across every leg, later legs winning.
        holdOpen: latest ? latest.hold_open === true : false,
        estimateFields: nonEmptyFields(Object.assign({}, ...[...legs].sort((a, b) => (Number(a.generation) || 0) - (Number(b.generation) || 0)).map((seg) => nonEmptyFields(seg.estimate_fields) || {}))),
        // The seed keeps the TAIL (the most recent turns matter most).
        segmentsText: full.length > RESUME_SEED_MAX_CHARS ? `[…]${full.slice(-RESUME_SEED_MAX_CHARS)}` : full,
        relayLeadId: meta.relay_lead_id ? String(meta.relay_lead_id) : ([...legs].reverse().find((seg) => seg.lead_id)?.lead_id || null),
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

/**
 * The row's reconnect marks (bounded, fail-soft null) — /relay-complete's
 * discriminator between a Twilio RETRY of the first failure (no `gen`, or a
 * stale one, on a row already reconnected) and the resumed leg's own
 * failure (its action URL carries `gen` = the row's relay_reconnect_ms).
 */
async function readReconnectState(db, callSid, { timeoutMs = RESUME_STATE_TIMEOUT_MS } = {}) {
  if (!callSid) return null;
  let timer;
  const read = db('call_log').where('twilio_call_sid', callSid).first('metadata', 'call_outcome').then((row) => {
    if (!row) return null;
    let meta = row.metadata;
    if (typeof meta === 'string') { try { meta = JSON.parse(meta); } catch { meta = null; } }
    if (!meta || typeof meta !== 'object') meta = {};
    // The relay profile the first leg was stamped with (id + validated
    // attrs) — the resumed leg opens with the SAME one, so a sandbox cell
    // or a production profile is attributed to the whole call.
    const profile = Object.hasOwn(meta, 'relay_profile_id')
      ? { relayProfileId: meta.relay_profile_id ? String(meta.relay_profile_id) : null, relayAttrs: (meta.relay_attrs && typeof meta.relay_attrs === 'object') ? meta.relay_attrs : {} }
      : null;
    return {
      reconnects: Number(meta.relay_reconnects) || 0,
      reconnectMs: Number(meta.relay_reconnect_ms) || null,
      // The generation of the row's CURRENT claim owner (a token's mint ms):
      // ≥ reconnectMs ⇒ a socket minted by the reconnect has claimed the
      // call (the resumed leg is live); below it ⇒ only the first leg ever
      // did — the reconnect TwiML was never acted on.
      claimGen: Number(meta.relay_session_claim_gen) || 0,
      transferClaimed: row.call_outcome === 'ai_transferred' || Boolean(meta.relay_transfer_ring_at),
      profile,
    };
  });
  const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve(null), timeoutMs); timer.unref?.(); });
  try { return await Promise.race([read, timeout]); } catch { return null; } finally { clearTimeout(timer); }
}


module.exports = {
  RECONNECT_LIMIT,
  isRecoveryGateOn,
  claimReconnect,
  undoLateReconnect,
  reissueReconnect,
  resumeGreeting,
  fallbackFence,
  loadResumeState,
  readReconnectState,
  RESUME_SEED_MAX_CHARS,
};
