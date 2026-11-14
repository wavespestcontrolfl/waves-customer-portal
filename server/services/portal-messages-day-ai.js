/**
 * Office-hours Waves AI step-in on the portal Messages page (GATE_PORTAL_MESSAGES_DAY_AI, owner 2026-11-13 "Let
 * Waves AI answer during office hours when no person answers in time").
 *
 * The night step (portal-messages-night-ai.js) answers a message written outside 8 AM to 8 PM Eastern. This step
 * covers the other half: a customer's message that waited 120 OPEN minutes with no answer from a person. The 120
 * is the owner's own rule for texts (2026-10-02 "OK 2 HRS IS FINE", sms-unanswered-reply.js). The clock is
 * followUpDueAt (followup-sla-watcher.js), which counts only 8 AM to 8 PM Eastern minutes; there is no second clock.
 *
 * - When: a sweep every five minutes (scheduler.js) calls answerWaitingMessages. It does nothing while the gate or
 *   its inputs are off, and nothing while the clock is outside office hours, so this step never sends at night.
 *   The clock is read again before each message is taken up and before each answer is saved: a sweep that
 *   starts at 7:59 PM takes up no further message once the office has closed, and an answer whose turn ended
 *   after the close is not saved (outcome `after_close`; the message stays the office's open item).
 * - Which message: the NEWEST customer message of a thread that is still open for the office (openMessageScope,
 *   the Portal tab's own definition: no staff answer and no Mark handled after it), written in the last 72 hours,
 *   that the night step has not taken (metadata.nightAi) and this step has not taken (metadata.dayAi), that no AI
 *   reply answers yet, and that is 120 open minutes old. Oldest first, at most 20 a sweep.
 * - At most once per message: the step claims it with one conditional UPDATE (metadata.dayAi, the night step's
 *   claimMessage with its own key), so a second sweep or a second process does nothing with it.
 * - The same steps as the night step, on the same turn: thanks or a reaction is silent with no model call
 *   (needsNoReply); otherwise the Ask Waves assistant takes the thread lane's turn (ai-assistant/thread-lane.js,
 *   its day wording), and the per-customer cap (GATE_PORTAL_CHAT_CUSTOMER_CAP) counts it. A grounded answer is
 *   saved as Waves AI's (saveReply refuses when the office or the customer wrote after the message, or Mark
 *   handled covered it) and the customer gets the in-app bell plus an app push.
 * - One difference: a hand-off sends NOTHING. The night sentence promises an answer "after 8 AM", which is false
 *   in the day, and the owner has ruled against run-around lines. The outcome `left_for_team` is recorded on the
 *   customer's message and the thread stays exactly as it was: the office's open item, with its bell.
 *
 * Never throws. Never logs a message body.
 */

const db = require('../models/db');
const logger = require('./logger');
const featureGates = require('../config/feature-gates');
const NightAi = require('./portal-messages-night-ai');
const { needsNoReply } = require('./ai-assistant/thread-lane');

const KEY = 'dayAi';
// The owner's rule for texts: two hours of open office time with no answer from a person.
const WAIT_OPEN_MINUTES = 120;
// A message older than this is the office's old item, not a customer waiting now.
const LOOKBACK_MS = 72 * 60 * 60 * 1000;
const SWEEP_LIMIT = 20;
// Rows one sweep reads before the open-minutes clock picks the due ones (oldest first, so due ones come first).
const READ_LIMIT = 200;

const enabled = () => NightAi.enabled(featureGates.portalMessagesDayAiLive);

// The newest customer message of each open thread, written in the lookback and at least WAIT_OPEN_MINUTES of
// plain time ago (open minutes are never more than that, so a younger message is never due), that neither step
// has taken and no AI reply answers.
async function candidates(now) {
  const PortalMessages = require('./portal-messages');
  const { openMessageScope } = require('./portal-inbox');
  const newest = new Date(now.getTime() - WAIT_OPEN_MINUTES * 60 * 1000);
  const oldest = new Date(now.getTime() - LOOKBACK_MS);
  return openMessageScope(db('conversations as cv'))
    .join('messages as m', 'm.conversation_id', 'cv.id')
    .where({ 'm.channel': PortalMessages.CHANNEL, 'm.direction': 'inbound' })
    .where('m.created_at', '>=', oldest)
    .where('m.created_at', '<=', newest)
    .whereRaw("(m.metadata->'nightAi') IS NULL AND (m.metadata->'dayAi') IS NULL")
    .whereNotExists(function newerCustomerMessage() {
      this.select(db.raw('1')).from('messages as n')
        .whereRaw('n.conversation_id = cv.id')
        .where({ 'n.channel': PortalMessages.CHANNEL, 'n.direction': 'inbound' })
        .whereRaw('(n.created_at, n.id) > (m.created_at, m.id)');
    })
    .whereNotExists(function aiAnswer() {
      this.select(db.raw('1')).from('messages as a')
        .whereRaw('a.conversation_id = cv.id')
        .where('a.message_type', PortalMessages.AI_MESSAGE_TYPE)
        .whereRaw("a.metadata->>'answersMessageId' = m.id::text");
    })
    .orderBy([{ column: 'm.created_at', order: 'asc' }, { column: 'm.id', order: 'asc' }])
    .limit(READ_LIMIT)
    .select('m.id', 'm.body', 'm.created_at', 'cv.id as thread_id', 'cv.customer_id');
}

// The step for one due message. Returns the outcome word: 'answered', 'silent', 'left_for_team', 'after_close',
// 'capped', 'superseded', 'failed', or null when another start already took the message. `closed` reads the
// clock: true once the office has closed.
async function answerOne(row, closed) {
  const message = { id: row.id, body: row.body, created_at: row.created_at };
  const { claimMessage, recordOutcome, takeTurn, saveReply, notifyCustomer } = NightAi.__private;
  if (!(await claimMessage(message.id, KEY))) return null;
  try {
    // Only thanks, an acknowledgment or a reaction: no model call and no answer.
    const turn = needsNoReply(message.body) ? { kind: 'silent' } : await takeTurn(row.customer_id, row.thread_id, message, { day: true });
    let outcome = turn.kind;
    // A hand-off sends nothing: the message stays the office's open item, as it was.
    if (turn.kind === 'handoff') outcome = 'left_for_team';
    // The turn can end after the close (it has its own budget of seconds): nothing is sent at night.
    if (turn.kind === 'answer' && closed()) outcome = 'after_close';
    else if (turn.kind === 'answer') {
      const saved = await saveReply(row.thread_id, message, { body: turn.body, handOff: false });
      outcome = saved ? 'answered' : 'superseded';
      if (saved) await notifyCustomer(row.customer_id, saved);
    }
    await recordOutcome(message.id, outcome, KEY);
    return outcome;
  } catch (err) {
    logger.warn(`[portal-day-ai] no AI answer for message ${message.id}: ${[err?.name || 'Error', err?.code].filter(Boolean).join(' ')}`);
    await recordOutcome(message.id, 'failed', KEY);
    return 'failed';
  }
}

const COUNT_KEYS = { answered: 'answered', silent: 'silent', left_for_team: 'leftForTeam', after_close: 'leftForTeam', capped: 'capped', superseded: 'superseded', failed: 'failed' };

/**
 * One sweep. `scanned` is the number of due messages it took up (at most 20), the other counts say what became of
 * them. Returns all zeros while the gate is off or the clock is outside 8 AM to 8 PM Eastern. Never throws.
 * @param {{ now?: Date }} [input]
 */
async function answerWaitingMessages({ now = new Date() } = {}) {
  const counts = { scanned: 0, answered: 0, silent: 0, leftForTeam: 0, capped: 0, superseded: 0, failed: 0 };
  // The sweep's clock: `now` plus the time this sweep has run (its candidate read included), so the close is
  // seen while it works.
  const started = Date.now();
  const closed = () => NightAi.isAfterHours(new Date(now.getTime() + (Date.now() - started)));
  try {
    if (!enabled() || closed()) return counts;
    const { followUpDueAt, OPEN_CALENDAR } = require('./followup-sla-watcher');
    const rows = await candidates(now);
    const due = rows.filter((row) => {
      const at = followUpDueAt(row.created_at, OPEN_CALENDAR, WAIT_OPEN_MINUTES);
      return at && at.getTime() <= now.getTime();
    }).slice(0, SWEEP_LIMIT);
    for (const row of due) {
      // The close, or the gate turned off mid-sweep (the kill switch): stop. A message not taken up is not
      // claimed, so it is due again at the next office-hours sweep.
      if (closed() || !enabled()) break;
      counts.scanned += 1;
      const outcome = await answerOne(row, closed);
      if (COUNT_KEYS[outcome]) counts[COUNT_KEYS[outcome]] += 1;
    }
  } catch (err) {
    logger.warn(`[portal-day-ai] sweep failed: ${[err?.name || 'Error', err?.code].filter(Boolean).join(' ')}`);
  }
  return counts;
}

module.exports = { WAIT_OPEN_MINUTES, SWEEP_LIMIT, enabled, answerWaitingMessages };
