'use strict';

/**
 * Deterministic speaker-role swap guard for diarized/labeled call transcripts.
 *
 * Outbound calls (and occasional inbound diarization glitches) can invert the
 * `Agent:` and `Caller:` speaker prefixes so the Waves representative's opening
 * greeting ("Thank you for calling Waves Pest Control...") sits on `Caller:`.
 *
 * Contract:
 * - Zero LLM / DB / network calls.
 * - Never mutates any spoken word — ONLY swaps line-leading `Agent:` <-> `Caller:` prefixes.
 * - Skips composite / multi-segment transcripts (`[AI segment]`, `[Live segment]`, `---`)
 *   so mid-call transfer boundaries are never inverted.
 * - Swaps ONLY when `Caller:` contains an unambiguous Waves staff self-identification
 *   AND `Agent:` contains none.
 */

const COMPOSITE_MARKER_RE = /(?:^|\n)\s*(?:\[(?:AI|Live|Human|Transfer|Segment)\b[^\]]*\]|---{1,})/i;
const SPEAKER_LINE_RE = /^(\s*)(Agent|Caller)(\s*:)(.*)$/i;
const QUOTED_GREETING_RE = /\b(?:they\s+said|she\s+said|he\s+said|recording\s+said|voicemail\s+said|message\s+said|heard)\b/i;

const STAFF_SELF_ID_PATTERNS = Object.freeze([
  /\b(?:thank(?:s|\s+you)\s+for\s+calling|welcome\s+to)\s+waves(?:\s+pest(?:\s+control)?)?\b/i,
  /\bwaves(?:\s+pest(?:\s+control)?)?\s*[,.\-—]?\s*(?:this\s+is\s+[a-z]|my\s+name\s+is|how\s+(?:can|may)\s+(?:i|we)\s+(?:help|assist)\s+you)\b/i,
  /\b(?:this\s+is|my\s+name\s+is|i['’]?m)\s+[a-z][a-z'-]{1,20}\s+(?:calling\s+)?(?:back\s+)?(?:with|from|at)\s+waves(?:\s+pest(?:\s+control)?)?\b/i,
  /\bcalling\s+(?:you\s+)?(?:back\s+)?from\s+waves(?:\s+pest(?:\s+control)?)?\b/i,
  /\b(?:good\s+(?:morning|afternoon|evening)[,.\s]+)?waves\s+pest\s+control\b/i,
]);

function hasUnambiguousStaffSelfId(turnBody) {
  const body = String(turnBody || '').trim();
  if (!body || QUOTED_GREETING_RE.test(body)) return false;
  if (STAFF_SELF_ID_PATTERNS.some((re) => re.test(body))) return true;
  return /\bwaves\b/i.test(body) && /\bhow\s+(?:can|may)\s+(?:i|we)\s+(?:help|assist)\s+you\b/i.test(body);
}

function collectLabeledTurns(lines) {
  const turns = [];
  for (const line of lines) {
    const m = line.match(SPEAKER_LINE_RE);
    if (m) {
      turns.push({ role: m[2].toLowerCase(), body: m[4] || '' });
    } else if (turns.length) {
      turns[turns.length - 1].body += `\n${line}`;
    }
  }
  return turns;
}

function swapAgentCallerPrefixes(lines) {
  return lines.map((line) => line.replace(SPEAKER_LINE_RE, (_full, indent, role, colon, rest) => {
    const nextRole = role.toLowerCase() === 'agent' ? 'Caller' : 'Agent';
    return `${indent}${nextRole}${colon}${rest}`;
  })).join('\n');
}

function fixSwappedSpeakerRoles(transcript) {
  const text = String(transcript || '');
  if (!text.trim()) return { text, swapped: false, reason: null };
  if (COMPOSITE_MARKER_RE.test(text)) return { text, swapped: false, reason: 'composite_transcript' };

  const lines = text.split('\n');
  const turns = collectLabeledTurns(lines);
  const agentTurns = turns.filter((t) => t.role === 'agent');
  const callerTurns = turns.filter((t) => t.role === 'caller');
  if (!agentTurns.length || !callerTurns.length) return { text, swapped: false, reason: null };

  const callerHasStaffId = callerTurns.some((t) => hasUnambiguousStaffSelfId(t.body));
  const agentHasStaffId = agentTurns.some((t) => hasUnambiguousStaffSelfId(t.body));
  if (!callerHasStaffId || agentHasStaffId) return { text, swapped: false, reason: null };

  return {
    text: swapAgentCallerPrefixes(lines),
    swapped: true,
    reason: 'caller_identified_as_waves_staff',
  };
}

function applySpeakerRoleGuard(result, log = null) {
  if (!result || typeof result.transcription !== 'string') return result;
  const guard = fixSwappedSpeakerRoles(result.transcription);
  if (!guard.swapped) return result;
  if (log && typeof log.info === 'function') {
    log.info(`[call-proc] speaker-role guard swapped Agent/Caller labels on ${result.provider || 'transcript'} (${guard.reason})`);
  }
  return {
    ...result,
    transcription: guard.text,
    metadata: { ...(result.metadata || {}), speaker_roles_swapped: true },
  };
}

module.exports = {
  fixSwappedSpeakerRoles,
  applySpeakerRoleGuard,
  _test: { hasUnambiguousStaffSelfId, collectLabeledTurns, swapAgentCallerPrefixes },
};
