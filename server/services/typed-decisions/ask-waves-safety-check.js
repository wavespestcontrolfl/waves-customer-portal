/**
 * Ask Waves Jev second check (GATE_ASK_WAVES_JEV_CHECK = off | shadow | enforce,
 * on top of GATE_TYPED_DECISIONS).
 *
 * The website chat's model-written replies already pass a word list
 * (ask-waves-intake.js intakeSafetyClaimSupplement). This puts the same reply to
 * Jev as ask_waves_safety.v1: does it make a blanket safety claim, and does it
 * give a re-entry or use time. The owner approved it 2026-10-28 after a replay
 * (24 new unsafe replies: word list 22, Jev 23, both together 24 of 24).
 *
 *  - shadow: nothing a visitor sees changes and the request path waits for
 *    nothing. After the chat log has written the assistant row, Jev is asked and
 *    both answers are recorded in decision_reviews against that row
 *    (subject_type agent_messages) for labeling.
 *  - enforce: the intake service waits a short grace for the answer; a yes on
 *    either question swaps the reply for the reviewed copy the word list serves.
 *    A late, failed or absent answer keeps the reply (the word list passed it).
 *    The answer is recorded the same way when the reply was kept.
 *
 * Baseline: the word list passed every reply that reaches this check, so each
 * question's production answer is false (`production: false`); a Jev yes lands
 * in the review queue as a disagreement. Rows hold ids and answers only; the
 * reviewer reads the text live from agent_messages (routes/admin-typed-decisions.js).
 * Nothing here throws.
 */
const logger = require('../logger');
const PACKAGE_ID = 'ask_waves_safety.v1';
const SUBJECT_TYPE = 'agent_messages';

/** Jev's state for one chat turn: the visitor's cleaned message and the reply served. */
function safetyState({ visitorMessage, reply }) {
  return { visitor_message: visitorMessage, reply };
}

/** Asks Jev. Resolves { ok:false } on any failure; never rejects. */
async function askSafety(state) {
  try {
    const { askPackage } = require('./jev');
    return (await askPackage(PACKAGE_ID, state)) || { ok: false, reason: 'error' };
  } catch (err) {
    logger.warn(`[ask-waves] jev check threw: ${err.message}`);
    return { ok: false, reason: 'error' };
  }
}

/** The question ids Jev answered yes to, or [] for anything but a usable answer. */
function flaggedQuestions(result) {
  if (!result || result.ok !== true || !result.answers) return [];
  return Object.entries(result.answers).filter(([, answer]) => answer && answer.yes === true).map(([id]) => id);
}

/**
 * Records the answers against the assistant agent_messages row. `result` is an
 * answer already in hand (enforce) or a promise of one; absent, Jev is asked now
 * (shadow). Resolves the recorder's summary, or null when nothing was recorded.
 */
async function recordSafetyCheck({ state, assistantMessageId, result = null }) {
  try {
    if (!assistantMessageId) return null;
    const answered = await (result || askSafety(state));
    if (!answered || answered.ok !== true) return null;
    const { packageFor, DEFAULT_DECISION_PROVIDER } = require('./packages');
    const pkg = packageFor(PACKAGE_ID);
    const { recordDecisions } = require('./shadow-recorder');
    const { askWavesSubjectHash } = require('./subject-hash');
    return await recordDecisions({
      capability: pkg.capability,
      pkg,
      provider: answered.provider || DEFAULT_DECISION_PROVIDER,
      subjectType: SUBJECT_TYPE,
      subjectId: assistantMessageId,
      result: answered,
      // The word list passed this reply: production said no to both questions.
      baselines: Object.fromEntries(Object.keys(pkg.questions).map((id) => [id, { production: false }])),
      subjectHash: askWavesSubjectHash({ visitorMessage: state.visitor_message, reply: state.reply }),
    });
  } catch (err) {
    logger.warn(`[ask-waves] jev check record failed: ${err.message}`);
    return null;
  }
}

module.exports = { PACKAGE_ID, SUBJECT_TYPE, safetyState, askSafety, flaggedQuestions, recordSafetyCheck };
