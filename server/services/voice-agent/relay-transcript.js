/**
 * Voice-relay Phase E — SESSION TRANSCRIPT PERSISTENCE (the audit trail).
 *
 * Before this, an agent-handled call left a lead but the conversation itself
 * was unreviewable: the owner could not replay what Sandy actually said. Every
 * relay session now writes its turn-by-turn transcript and a one-line summary
 * onto the SAME `call_log` row human calls use, so agent calls render in the
 * existing admin call views with no new surface:
 *   - CommunicationsPageV2 → Calls tab (client CallLogTabV2) renders
 *     `call_log.transcription` in the collapsible transcript panel, sourced
 *     from GET /api/ai/admin/calls (routes/ai-assistant.js) — which applies no
 *     processing_status or recording_url filter, so a recording-less relay row
 *     shows up like any other call;
 *   - admin-triage (routes/admin-triage.js) renders `call_log.call_summary`
 *     next to `lead_synopsis` on any triage card the call raised.
 *
 * COLUMN CONTRACT is the call pipeline's own, not a new one
 * (call-recording-processor.js transcript write, ~line 5913): `transcription`
 * (text), `transcription_status` 'completed', `transcription_provider`,
 * `transcription_model`, `transcription_metadata` (jsonb, JSON.stringify'd),
 * and `call_summary` (text) exactly where processRecording puts the
 * extraction's own summary (~line 8259). The `Caller:` / `Agent:` line labels
 * match the pipeline convention CallLogTabV2's displayTranscript already
 * relabels for outbound calls.
 *
 * NO SECOND LLM ROUND-TRIP ON THE LIVE CALL PATH. The summary is the one the
 * model ALREADY produced: capture_lead's required `call_summary` argument,
 * captured by the session as the tool ran. When no capture_lead happened
 * (hangup mid-call, model error, spam), a deterministic fallback is composed
 * from the caller's own turns — the same shape the hangup capture floor
 * already writes to the lead. generateLeadSynopsis / generateSynopsis are
 * deliberately NOT called here: that is a MODELS.FLAGSHIP round trip, and the
 * row is reviewable without it (the admin "Synopsis" action can still be run
 * by hand afterwards, since it only needs `transcription` to be present).
 *
 * WRITTEN ON EVERY CLOSE — normal end, hangup, turn cap, idle/max-session
 * teardown, and error paths — because this is an audit trail. It is FOLDED
 * INTO the existing end() reconcile UPDATE rather than issued as a second
 * statement, which is what keeps the PR #2177 voicemail-clobber guard intact:
 * the transcript inherits `call_outcome IS NULL OR call_outcome <> 'voicemail'`,
 * so a relay-failure row that /relay-complete already stamped as voicemail is
 * not retro-fitted with an AI transcript. When that guard skips a row that DID
 * have turns, buildTranscriptUpdate's caller logs it loudly rather than
 * silently dropping the record.
 *
 * FAIL-OPEN: composition never throws (a bad turn can't break a call), and the
 * caller's write is inside the reconcile try/catch. A persistence failure is
 * logged at error level and the call continues.
 *
 * PII: the transcript rows ARE the record — they are stored verbatim and are
 * never masked. Only LOGS are masked (phone numbers via maskPhone, and no
 * transcript text is ever logged).
 */

const logger = require('../logger');

const TRANSCRIPTION_PROVIDER = 'conversation_relay';
// Cap the stored transcript. A 15-minute hard-capped call cannot realistically
// reach this, but a runaway loop must never write an unbounded text column.
const MAX_TRANSCRIPT_CHARS = 60000;
const MAX_SUMMARY_CHARS = 2000;
const MAX_TURN_CHARS = 4000;

const CALLER_LABEL = 'Caller';
const AGENT_LABEL = 'Agent';

function clean(value, max) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim().slice(0, max);
}

/**
 * Render the session's ordered turn list as the pipeline's labeled dialogue.
 * turns: [{ role: 'caller'|'agent'|'tool', text }]
 */
function buildTranscriptText(turns = []) {
  const lines = [];
  for (const turn of Array.isArray(turns) ? turns : []) {
    const text = clean(turn && turn.text, MAX_TURN_CHARS);
    if (!text) continue;
    if (turn.role === 'caller') lines.push(`${CALLER_LABEL}: ${text}`);
    else if (turn.role === 'agent') lines.push(`${AGENT_LABEL}: ${text}`);
    // Tool calls are part of the record too — the owner reviewing a call needs
    // to see that Sandy looked something up rather than invented it. Marked so
    // they can never be mistaken for spoken words.
    else if (turn.role === 'tool') lines.push(`[tool] ${text}`);
  }
  return lines.join('\n').slice(0, MAX_TRANSCRIPT_CHARS);
}

/**
 * The one-line summary for call_log.call_summary. Prefers the summary the
 * model already wrote via capture_lead (no extra round trip); otherwise
 * composes a deterministic one from the caller's turns.
 */
function buildCallSummary({ modelSummary, turns = [], reason, leadCaptured } = {}) {
  const provided = clean(modelSummary, MAX_SUMMARY_CHARS);
  if (provided) return provided;
  const callerTurns = (Array.isArray(turns) ? turns : [])
    .filter((t) => t && t.role === 'caller')
    .map((t) => clean(t.text, 300))
    .filter(Boolean);
  const head = leadCaptured
    ? 'AI phone assistant handled this call.'
    : 'AI phone assistant call — no lead captured on the call.';
  const tail = callerTurns.length
    ? ` Caller said: ${callerTurns.join(' | ')}`
    : ' No caller speech was transcribed.';
  const why = reason ? ` (session ended: ${clean(reason, 40)})` : '';
  return clean(`${head}${tail}${why}`, MAX_SUMMARY_CHARS);
}

/**
 * The call_log columns to fold into the end() reconcile UPDATE, or null when
 * there is nothing worth recording (no turns AND no model summary — e.g. a
 * caller who hung up during the greeting; the reconcile still stamps outcome
 * and duration on its own).
 *
 * Never throws: a composition failure returns null and the reconcile proceeds
 * with the original outcome/duration columns.
 */
function buildTranscriptUpdate({ turns = [], modelSummary = null, reason = null, leadCaptured = false, callSid = null, model = null, startedAt = null } = {}) {
  try {
    const transcription = buildTranscriptText(turns);
    if (!transcription && !clean(modelSummary, MAX_SUMMARY_CHARS)) return null;
    const callerTurns = turns.filter((t) => t && t.role === 'caller').length;
    const agentTurns = turns.filter((t) => t && t.role === 'agent').length;
    const toolCalls = turns.filter((t) => t && t.role === 'tool').length;
    return {
      transcription,
      transcription_status: 'completed',
      transcription_provider: TRANSCRIPTION_PROVIDER,
      transcription_model: model || null,
      transcription_metadata: JSON.stringify({
        provider: TRANSCRIPTION_PROVIDER,
        model: model || null,
        source: 'voice_relay_session',
        call_sid: callSid || null,
        end_reason: reason || null,
        lead_captured: Boolean(leadCaptured),
        caller_turns: callerTurns,
        agent_turns: agentTurns,
        tool_calls: toolCalls,
        started_at: startedAt ? new Date(startedAt).toISOString() : null,
        ended_at: new Date().toISOString(),
      }),
      call_summary: buildCallSummary({ modelSummary, turns, reason, leadCaptured }),
      // Terminal for the recording pipeline: this call has no recording to
      // download and nothing for processRecording to do, so it must not sit in
      // an unprocessed sweep forever. (ai_extraction is deliberately left NULL
      // — the relay runs no extraction, and a synthesized one would enter the
      // extraction eval cohorts under false pretenses.)
      processing_status: 'processed',
    };
  } catch (err) {
    logger.error(`[voice-relay-transcript] transcript composition FAILED callSid=${callSid || 'n/a'}: ${err.message}`);
    return null;
  }
}

module.exports = {
  buildTranscriptText,
  buildCallSummary,
  buildTranscriptUpdate,
  TRANSCRIPTION_PROVIDER,
  MAX_TRANSCRIPT_CHARS,
  CALLER_LABEL,
  AGENT_LABEL,
};
