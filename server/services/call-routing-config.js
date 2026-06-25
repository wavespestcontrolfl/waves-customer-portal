/**
 * Call Routing config — shared by the admin settings endpoints and the inbound
 * voice webhook. Persisted as the `call_routing` system_settings row.
 *
 * Shipped defaults are intentionally INERT: the no-answer backstop is "on" but
 * `agentEndpoint` is empty, so decideVoiceRoute fails safe to the normal
 * human/voicemail flow until the owner (a) enters the agent endpoint here AND
 * (b) flips GATE_VOICE_AI_AGENT. Two independent locks before any call is ever
 * handed to the AI.
 */
const CALL_ROUTING_CONFIG_KEY = 'call_routing';

const DEFAULT_CALL_ROUTING_CONFIG = {
  noAnswerBackstopEnabled: true,
  ringTimeoutSec: 30,
  aiAnswersFirst: false,
  answerFirstSchedule: { enabled: false, startHourET: 18, endHourET: 8, openDays: [] },
  agentEndpoint: '',
  agentTimeoutSec: 10,
};

function clampInt(value, min, max, fallback) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function sanitizeSchedule(input) {
  const d = DEFAULT_CALL_ROUTING_CONFIG.answerFirstSchedule;
  const s = input && typeof input === 'object' ? input : {};
  const openDays = Array.isArray(s.openDays)
    ? [...new Set(s.openDays
        .map((x) => Math.round(Number(x)))
        .filter((x) => Number.isInteger(x) && x >= 0 && x <= 6))]
    : [];
  return {
    enabled: s.enabled === true,
    startHourET: clampInt(s.startHourET, 0, 23, d.startHourET),
    endHourET: clampInt(s.endHourET, 0, 24, d.endHourET),
    openDays,
  };
}

function parseValue(value) {
  if (!value) return {};
  if (typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value !== 'string') return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** Merge a stored value (string|object|null) onto defaults with type coercion + clamping. */
function mergeCallRoutingConfig(value) {
  const c = parseValue(value);
  const d = DEFAULT_CALL_ROUTING_CONFIG;
  return {
    noAnswerBackstopEnabled: c.noAnswerBackstopEnabled === undefined
      ? d.noAnswerBackstopEnabled
      : c.noAnswerBackstopEnabled === true,
    ringTimeoutSec: clampInt(c.ringTimeoutSec, 5, 120, d.ringTimeoutSec),
    aiAnswersFirst: c.aiAnswersFirst === true,
    answerFirstSchedule: sanitizeSchedule(c.answerFirstSchedule),
    agentEndpoint: typeof c.agentEndpoint === 'string' ? c.agentEndpoint.trim() : '',
    agentTimeoutSec: clampInt(c.agentTimeoutSec, 5, 30, d.agentTimeoutSec),
  };
}

/**
 * Runtime read for the voice webhook. Fail-safe: any DB error yields the inert
 * defaults (empty agentEndpoint ⇒ decideVoiceRoute routes to the normal flow),
 * so a settings-read failure can never block or misroute a live call.
 */
async function getCallRoutingConfig(db) {
  try {
    const row = await db('system_settings').where({ key: CALL_ROUTING_CONFIG_KEY }).first();
    return mergeCallRoutingConfig(row?.value);
  } catch {
    return mergeCallRoutingConfig(null);
  }
}

module.exports = {
  CALL_ROUTING_CONFIG_KEY,
  DEFAULT_CALL_ROUTING_CONFIG,
  mergeCallRoutingConfig,
  getCallRoutingConfig,
};
