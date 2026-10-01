/**
 * Daily owner review item for typed decisions (dark behind GATE_TYPED_DECISIONS).
 *
 * 8:05 AM ET (scheduler.js): refresh the outcome evidence that was still
 * unknown, then raise ONE admin item listing the still-unreviewed shadow
 * decisions of the last 14 days worth a human look: up to 8 where Jev disagreed with a baseline
 * and up to 2 random spot checks, newest first. No rows = nothing raised.
 *
 * The item is a pointer, not a decision: it names each row's capability,
 * question, Jev answer and baselines (ids and yes/no only, never message text)
 * and links to the review tab where the owner labels them. Labeling is the
 * only thing that moves a row; nothing acts on a Jev answer.
 */
const db = require('../../models/db');
const logger = require('../logger');
const { typedDecisionsLive } = require('../../config/feature-gates');
const { raiseAdminAlert } = require('../admin-alert-compose');
const { refreshOutcomeEvidence } = require('./outcome-evidence');
const { etDateString, addETDays, parseETDateTime } = require('../../utils/datetime-et');

const CATEGORY = 'typed_decisions';
// The Typed tab of the Agents hub (client/src/pages/admin/TypedDecisionsReviewPage.jsx).
const LINK = '/admin/agents?tab=typed';
const MAX_DISAGREEMENTS = 8;
const MAX_SPOT_CHECKS = 2;
const BASELINE_LABELS = { production: 'production', deep_judge: 'deep judge', rules: 'rules' };

const parse = (value) => {
  if (value && typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { return null; }
};
const word = (n, one, many) => `${n} ${n === 1 ? one : many}`;

function describeAnswer(answer) {
  if (!answer) return 'no answer';
  if (typeof answer.yes === 'boolean') return `${answer.yes ? 'yes' : 'no'} (p ${Number(answer.p).toFixed(2)})`;
  if (typeof answer.choice === 'string') return answer.choice;
  if (answer.score !== undefined) return `score ${answer.score}`;
  return 'unreadable';
}

function describeBaseline(value) {
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  return String(value);
}

function describeRow(row) {
  const jev = parse(row.jev_answer);
  const baselines = Object.entries(parse(row.baseline_answers) || {})
    .map(([name, value]) => `${BASELINE_LABELS[name] || name} ${describeBaseline(value)}`);
  const evidence = parse(row.outcome_evidence);
  const proof = evidence && evidence.value !== null && evidence.value !== undefined
    ? `; ${evidence.source} ${evidence.window}: ${evidence.value ? 'yes' : 'no'}`
    : '';
  return `${row.capability} ${row.question_id}: Jev ${describeAnswer(jev)} vs ${baselines.join(', ') || 'no baseline'}${proof}`;
}

// The item lists what is STILL waiting, not one calendar day: rows stay in
// it until labeled, so a day whose alert failed to persist is picked up the
// next morning, and a row that a later nightly re-record turned into a
// disagreement (it keeps its first created_at) still reaches the owner.
const REVIEW_WINDOW_DAYS = 14;
function windowStart(now) {
  return parseETDateTime(`${etDateString(addETDays(now, -REVIEW_WINDOW_DAYS))}T00:00:00`);
}

async function runDailyReviewItem({ now = new Date(), conn = db } = {}) {
  if (!typedDecisionsLive()) return { raised: false, reason: 'gate_off' };
  try {
    await refreshOutcomeEvidence({ now, conn });
  } catch (err) {
    logger.warn(`[typed-decisions] evidence refresh failed: ${err.message}`);
  }
  const start = windowStart(now);
  const pick = (sampledFor, limit) => conn('decision_reviews')
    .where({ label_status: 'unreviewed', sampled_for: sampledFor })
    .where('created_at', '>=', start)
    .orderBy('created_at', 'desc').limit(limit)
    .select('id', 'capability', 'question_id', 'jev_answer', 'baseline_answers', 'outcome_evidence', 'created_at');
  const disagreements = await pick('disagreement', MAX_DISAGREEMENTS);
  const spotChecks = await pick('random_audit', MAX_SPOT_CHECKS);
  const total = disagreements.length + spotChecks.length;
  if (!total) return { raised: false, reason: 'no_rows' };

  const day = etDateString(now);
  const detail = [
    `Unreviewed shadow decisions from the last ${REVIEW_WINDOW_DAYS} days, newest first (up to ${MAX_DISAGREEMENTS} disagreements and ${MAX_SPOT_CHECKS} spot checks). Nothing acts on these answers; label each as Jev right, Jev wrong or unclear.`,
    ...disagreements.map((row) => `Disagreement - ${describeRow(row)}`),
    ...spotChecks.map((row) => `Spot check - ${describeRow(row)}`),
    `Review: ${LINK}`,
  ].join('\n');

  const alert = await raiseAdminAlert(CATEGORY, {
    area: 'System',
    action: `review ${word(total, 'AI decision', 'AI decisions')}`,
    why: `${word(disagreements.length, 'disagreement', 'disagreements')}, ${word(spotChecks.length, 'spot check', 'spot checks')} · Jev vs rules/judge`,
    severity: 'needs-you',
    link: LINK,
    subject: { type: 'check', id: 'typed-decisions-review' },
    doneWhen: 'reviews_labeled',
    who: 'person',
  }, {
    detail,
    dedupeKey: `typed-decisions-review:${day}`,
    refreshOnDedupe: true,
    metadata: { lane: 'typed_decisions', disagreements: disagreements.length, spotChecks: spotChecks.length },
  });
  // raiseAdminAlert resolves null when the notification row could not be
  // written: that is a failed run (the rows stay unreviewed, so tomorrow's run
  // raises them again).
  if (!alert) {
    logger.warn('[typed-decisions] daily review item was not persisted; the rows stay queued for the next run');
    return { raised: false, reason: 'alert_not_persisted', disagreements: disagreements.length, spotChecks: spotChecks.length };
  }
  return { raised: true, disagreements: disagreements.length, spotChecks: spotChecks.length, dedupeKey: `typed-decisions-review:${day}`, alert };
}

module.exports = { runDailyReviewItem, describeRow, CATEGORY, LINK, REVIEW_WINDOW_DAYS };
