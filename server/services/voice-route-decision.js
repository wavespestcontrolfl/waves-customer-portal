/**
 * Voice Route Decision — pure, no I/O.
 *
 * Decides whether an inbound voice call should be handed to the bilingual AI
 * voice agent or follow the normal flow (greeting → simul-ring staff →
 * voicemail). Kept side-effect-free so the safety-critical routing logic is
 * fully unit-testable without Twilio or a database.
 *
 * The #1 invariant: this never returns `agent` unless the caller explicitly
 * enabled the feature (gateEnabled) AND an agent endpoint is configured. With
 * either missing it fails safe to `normal`, so the existing human/voicemail
 * path is byte-for-byte unchanged. The agent is a leaf, never the trunk.
 *
 * Two call sites / phases:
 *   - 'initial'    : at /voice, BEFORE staff are dialed. The AI answers first
 *                    only via the explicit `aiAnswersFirst` override or an
 *                    active nightly `answerFirstSchedule`. Otherwise humans
 *                    always ring first.
 *   - 'after_dial' : at /call-complete, AFTER the staff <Dial>. The AI backstops
 *                    an unanswered call (instead of dumb voicemail) when the
 *                    backstop is enabled. "Unanswered" is the caller's
 *                    authoritative `noHumanAnswered` signal (the same
 *                    shouldRecordVoicemail the webhook already computed), so
 *                    this can't diverge from the existing voicemail decision.
 */

const { etParts } = require('../utils/datetime-et');

// Twilio DialCallStatus values that mean "no human took the call".
const NO_ANSWER_STATUSES = new Set(['no-answer', 'busy', 'failed', 'canceled']);

function isNoAnswerStatus(dialStatus) {
  if (!dialStatus) return false;
  return NO_ANSWER_STATUSES.has(String(dialStatus).toLowerCase());
}

/**
 * Is the optional nightly "AI answers first" schedule active right now?
 *
 * Window is [startHourET, endHourET) in Eastern Time with overnight-wrap
 * support: start=18, end=8 means 6pm through 8am the next morning. `openDays`,
 * if a non-empty array, restricts to those ET weekdays (0=Sun … 6=Sat),
 * evaluated at `now`. Evaluated against the wall-clock ET hour (DST-safe via
 * etParts), so it tracks DST automatically.
 */
function isAnswerFirstScheduleActive(schedule, now = new Date()) {
  if (!schedule || schedule.enabled !== true) return false;
  const start = Number(schedule.startHourET);
  const end = Number(schedule.endHourET);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start === end) return false;

  const { hour, dayOfWeek } = etParts(now);
  const days = Array.isArray(schedule.openDays) ? schedule.openDays : [];
  const dayAllowed = (d) => days.length === 0 || days.includes(d);

  if (start < end) {
    // Same-day window — gated on today.
    return hour >= start && hour < end && dayAllowed(dayOfWeek);
  }

  // Overnight wrap. openDays is keyed to the day the window STARTS, so the
  // morning tail (hour < end) belongs to the window that began the PREVIOUS ET
  // day and must be gated on yesterday's membership, not today's.
  if (hour >= start) return dayAllowed(dayOfWeek);        // evening portion → today started it
  if (hour < end) return dayAllowed((dayOfWeek + 6) % 7); // morning tail → yesterday started it
  return false;
}

/**
 * @param {object} args
 * @param {'initial'|'after_dial'} args.phase
 * @param {boolean} [args.gateEnabled]      isEnabled('voiceAiAgent') — passed in to keep this pure.
 * @param {object}  [args.config]           the `call_routing` system_settings value.
 * @param {boolean} [args.noHumanAnswered]  (after_dial) authoritative "nobody took it" signal.
 * @param {string}  [args.dialStatus]       (after_dial) Twilio DialCallStatus — fallback + reason.
 * @param {Date}    [args.now]              injectable clock for schedule evaluation.
 * @returns {{ action: 'normal'|'agent', reason: string }}
 */
function decideVoiceRoute({ phase, gateEnabled, config, noHumanAnswered, dialStatus, now } = {}) {
  if (!gateEnabled) return { action: 'normal', reason: 'gate_off' };

  const cfg = config && typeof config === 'object' ? config : {};

  // Hard safety backstop: with no configured agent endpoint we can never hand a
  // live call to the agent, no matter what toggles say.
  if (!cfg.agentEndpoint) return { action: 'normal', reason: 'no_agent_endpoint' };

  if (phase === 'initial') {
    if (cfg.aiAnswersFirst === true) return { action: 'agent', reason: 'answers_first_toggle' };
    if (isAnswerFirstScheduleActive(cfg.answerFirstSchedule, now)) {
      return { action: 'agent', reason: 'answers_first_schedule' };
    }
    return { action: 'normal', reason: 'ring_staff_first' };
  }

  if (phase === 'after_dial') {
    // Backstop is on by default once the gate + endpoint are set; only an
    // explicit `false` disables it.
    if (cfg.noAnswerBackstopEnabled === false) {
      return { action: 'normal', reason: 'backstop_disabled' };
    }
    const noAnswer = typeof noHumanAnswered === 'boolean'
      ? noHumanAnswered
      : isNoAnswerStatus(dialStatus);
    if (noAnswer) {
      const suffix = dialStatus ? `_${String(dialStatus).toLowerCase()}` : '';
      return { action: 'agent', reason: `backstop${suffix}` };
    }
    return { action: 'normal', reason: 'human_answered' };
  }

  return { action: 'normal', reason: 'unknown_phase' };
}

module.exports = { decideVoiceRoute, isAnswerFirstScheduleActive, isNoAnswerStatus };
