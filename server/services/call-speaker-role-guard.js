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
const QUOTED_SPEECH_RE = /\b(?:(?:they|she|he|recording|voicemail|message|greeting|prompt|menu|someone)\s+(?:said|says|mentioned|left|calling|starts?\s+with|plays?)|your\s+(?:voicemail|recording|greeting|prompt|menu|message)|heard)\b/i;
const CALLER_CHECK_WAVES_RE = /\b(?:is\s+this|am\s+i\s+speaking\s+with|did\s+i\s+reach|is\s+that|calling\s+for)\s+waves\b/i;

const NON_NAME_WORDS = 'not|really|very|so|just|frustrated|upset|angry|mad|happy|unhappy|done|still|someone|somebody|anybody|anyone|calling|speaking|talking|working|switching';
const PERSON_NAME_TOKEN = `(?!(?:${NON_NAME_WORDS})\\b)[a-z][a-z'-]{1,20}`;

const WAVES_BRAND_TOKEN = 'waves(?:\\s+pest(?:\\s+control)?\\b|(?=$|[.,!?;:\\-—]|\\s+(?:about|regarding|checking|confirming|following|to\\s+(?:confirm|check|follow|schedule|let))))';

const STAFF_SELF_ID_PATTERNS = Object.freeze([
  new RegExp(`^(?:(?:hi|hello|hey|good\\s+(?:morning|afternoon|evening)|yes|yeah)\\s*[,!.\\-—]\\s*)?(?:thank(?:s|\\s+you)\\s+for\\s+calling|welcome\\s+to)\\s+${WAVES_BRAND_TOKEN}`, 'i'),
  new RegExp(`(?:^|[.!\\n]\\s*)waves(?:\\s+pest(?:\\s+control)?)?\\s*[,\\.\\-—]\\s*(?:this\\s+is\\s+${PERSON_NAME_TOKEN}|my\\s+name\\s+is\\s+${PERSON_NAME_TOKEN}|how\\s+(?:can|may)\\s+(?:i|we)\\s+(?:help|assist)\\s+you)\\b`, 'i'),
  new RegExp(`\\b(?:this\\s+is|my\\s+name\\s+is)\\s+${PERSON_NAME_TOKEN}\\s+(?:calling\\s+)?(?:back\\s+)?(?:with|from|at)\\s+${WAVES_BRAND_TOKEN}`, 'i'),
  new RegExp(`\\bi['’]?m\\s+${PERSON_NAME_TOKEN}\\s+calling\\s+(?:you\\s+)?(?:back\\s+)?(?:with|from)\\s+${WAVES_BRAND_TOKEN}`, 'i'),
  new RegExp(`\\b(?:i['’]?m|i\\s+am|we['’]?re|we\\s+are)\\s+calling\\s+(?:you\\s+)?(?:back\\s+)?from\\s+${WAVES_BRAND_TOKEN}`, 'i'),
]);

function sentenceHasStaffSelfId(sentence) {
  const clean = String(sentence || '').trim();
  if (!clean || QUOTED_SPEECH_RE.test(clean) || CALLER_CHECK_WAVES_RE.test(clean)) return false;
  if (!STAFF_SELF_ID_PATTERNS.some((re) => re.test(clean))) return false;
  // Allow trailing `?` on a self-ID sentence only when it is a staff offer or asking for the customer.
  if (/\?\s*$/.test(clean) && !/\b(?:how\s+(?:can|may)\s+(?:i|we)\s+(?:help|assist)\s+you|am\s+i\s+speaking\s+with|is\s+[a-z][a-z'-]{1,20}\s+available)\b/i.test(clean)) {
    return false;
  }
  return true;
}

function hasUnambiguousStaffSelfId(turnBody) {
  const body = String(turnBody || '').trim();
  if (!body || QUOTED_SPEECH_RE.test(body) || CALLER_CHECK_WAVES_RE.test(body)) return false;
  return body.split(/(?<=[.!?])\s+|\n+/).some(sentenceHasStaffSelfId);
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
