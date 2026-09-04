/**
 * The Managed Agents SSE vocabulary every session runner reads — one place
 * for "did the session end", "did it fail", and "what was the stop reason",
 * instead of six copied predicates that drifted (turn_end / session_end
 * only the dispatcher knew; object-valued stop reasons only half the
 * runners read — Codex r9 / r10 on #3846).
 *
 * Terminal = the session said it ended: a terminal event name, or any event
 * carrying an `end_turn` stop reason. `session.status_idle` on its own is
 * NOT terminal — it arrives with stop_reason requires_action while the
 * agent waits for a tool result. Anything else that ends a stream is the
 * runner's `session_stream_eof` failure.
 */

const TERMINAL_EVENTS = new Set(['done', 'session_complete', 'turn_end', 'session_end']);
const ERROR_EVENTS = new Set(['error', 'session.error']);

// `stop_reason` arrives as a string or as `{ type }`.
function stopReasonOf(data) {
  return typeof data?.stop_reason === 'string' ? data.stop_reason : data?.stop_reason?.type;
}

function isSessionTerminal(event, data) {
  return TERMINAL_EVENTS.has(event) || stopReasonOf(data) === 'end_turn';
}

function isSessionError(event) {
  return ERROR_EVENTS.has(event);
}

module.exports = { stopReasonOf, isSessionTerminal, isSessionError };
