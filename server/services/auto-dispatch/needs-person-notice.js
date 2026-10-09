/**
 * NEEDS A PERSON — the admin notice for a visit auto-dispatch cannot fix by
 * itself (owner 2026-10-09: a forced move past the move limit raises an alert,
 * never moves silently).
 *
 * Three cases, collected during the run and raised once at its end:
 *   move_limit    the visit is in conflict (overlaps another stop, or sits on a
 *                 closed day) or has no arrival time yet, and has used all its
 *                 automatic moves (move-limit.js);
 *   no_near_slot  in conflict, and every free slot adds more drive than
 *                 config.conflictMaxAddedDriveMinutes (CONFLICT_NO_NEAR_SLOT);
 *   no_slot       in conflict, and no valid slot exists at all.
 *
 * One notice per visit and date (dedupe key below). Budget: at most
 * MAX_NOTICES_PER_RUN per run, soonest date first; the rest wait for the next
 * run. Raising is best effort: a failure is logged and never fails the run.
 *
 * NOT built here: a path that closes a notice once the visit is fixed. The
 * shared dedupe key only stops a repeat; a card whose visit later moves or
 * clears stays open until staff mark it done.
 */
const logger = require('../logger');
const { toDateStr } = require('./dates');

const MAX_NOTICES_PER_RUN = 10;
const KEY_PREFIX = 'auto-dispatch-needs-person:';

// evaluatePlacement reason codes that, on a visit in conflict, mean no move
// is coming from auto-dispatch.
const REASON_KIND = {
  CONFLICT_NO_NEAR_SLOT: 'no_near_slot',
  NO_VALID_SLOT: 'no_slot',
  NO_SLOT_MATCHING_PREFERENCE: 'no_slot',
};

const noticeKey = (id, date) => `${KEY_PREFIX}${id}:${date}`;

// What is wrong with the visit, in the words of the notice: [now, still].
const PROBLEM = {
  overlap: ['overlaps another stop', 'still overlaps another stop'],
  closed_day: ['is on a closed day', 'is still on a closed day'],
  unplaced: ['has no arrival time', 'still has no arrival time'],
};

function problemOf(conflict) {
  if (!conflict) return 'unplaced';
  return conflict.kind === 'closed_day' ? 'closed_day' : 'overlap';
}

// Remember a visit for the end-of-run notice. `bucket` is the run's Map.
function collect(bucket, service, kind, conflict) {
  const date = toDateStr(service.scheduled_date);
  const key = noticeKey(service.id, date);
  if (!date || bucket.has(key)) return;
  bucket.set(key, {
    key, id: String(service.id), customerId: service.customer_id || null, date, kind, problem: problemOf(conflict),
  });
}

// A no_change evaluation of a visit in conflict that auto-dispatch cannot fix.
function collectFromEvaluation(bucket, service, evalResult) {
  const kind = REASON_KIND[evalResult.reason_code];
  if (kind && evalResult.conflict) collect(bucket, service, kind, evalResult.conflict);
}

function whyFor(item, spoken) {
  const [now, still] = PROBLEM[item.problem];
  if (item.kind === 'move_limit') return `The ${spoken} visit used all its automatic moves and ${still}.`;
  const reason = item.kind === 'no_near_slot' ? 'every open slot adds too much drive' : 'no open slot fits it';
  return `The ${spoken} visit ${now}, and ${reason}.`;
}

function actionFor(item) {
  if (item.kind === 'move_limit') return 'move a visit auto-dispatch cannot move again';
  return item.problem === 'closed_day' ? 'move a visit off a closed day' : 'place a visit that overlaps another stop';
}

async function raiseOne(item, raiseAdminAlert, shortDateET) {
  await raiseAdminAlert('schedule_conflict', {
    area: 'Schedule',
    action: actionFor(item),
    why: whyFor(item, shortDateET(`${item.date}T12:00:00Z`)),
    severity: 'needs-you',
    link: `/admin/dispatch?tab=schedule&date=${item.date}&appointment=${encodeURIComponent(item.id)}`,
    subject: { type: 'visit', id: item.id },
    doneWhen: 'visit_moved_or_done',
    who: 'person',
  }, {
    bell: true,
    dedupeKey: item.key,
    refreshOnDedupe: true,
    metadata: {
      scheduledServiceId: item.id, customerId: item.customerId, scheduledDate: item.date, kind: item.kind,
    },
  });
}

// Raise the collected notices: soonest date first, at most the budget.
// Returns how many were raised. Never throws.
async function raiseNotices(bucket) {
  if (!bucket || bucket.size === 0) return 0;
  let raised = 0;
  try {
    const { raiseAdminAlert } = require('../admin-alert-compose');
    const { shortDateET } = require('../admin-alert-names');
    const soonest = [...bucket.values()].sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
    for (const item of soonest.slice(0, MAX_NOTICES_PER_RUN)) {
      try {
        await raiseOne(item, raiseAdminAlert, shortDateET);
        raised += 1;
      } catch (err) {
        logger.error(`[auto-dispatch] needs-a-person notice failed for ${item.id}: ${err.message}`);
      }
    }
  } catch (err) {
    logger.error(`[auto-dispatch] needs-a-person notices failed: ${err.message}`);
  }
  return raised;
}

module.exports = {
  MAX_NOTICES_PER_RUN, noticeKey, collect, collectFromEvaluation, raiseNotices,
};
