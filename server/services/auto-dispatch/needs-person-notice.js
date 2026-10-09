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
 * One notice per visit and date (dedupe key below). The lane shares the
 * auto-dispatch ring allowance of 24 hours (audit.ringsLeft: all lanes and
 * runs together), soonest date first; a standing notice is refreshed free
 * and the rest wait for the next run. Raising is best effort: a failure is
 * logged and never fails the run.
 *
 * A notice closes when its visit is cancelled or leaves the date, or when a
 * complete run loaded the visit and no longer collected it: closeResolved.
 */
const logger = require('../logger');
const { toDateStr } = require('./dates');

const RESOLVED_TITLE = 'Visit placement alert resolved';
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
    key, id: String(service.id), customer_id: service.customer_id || null, date, kind, problem: problemOf(conflict),
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

// [templates with the customer's name, generic wording] for the headline
// (docs/admin-notifications.md "Say who and what").
function actionFor(item) {
  if (item.kind === 'move_limit') {
    return [[(who) => `move ${who}'s visit; auto-dispatch cannot`, (who) => `move ${who}'s visit`], 'move a visit auto-dispatch cannot move again'];
  }
  if (item.problem === 'closed_day') {
    return [[(who) => `move ${who}'s visit off a closed day`, (who) => `move ${who}'s visit`], 'move a visit off a closed day'];
  }
  return [[(who) => `place ${who}'s visit; it overlaps a stop`, (who) => `place ${who}'s visit`], 'place a visit that overlaps another stop'];
}

async function raiseOne(item, raiseAdminAlert, shortDateET) {
  const [templates, generic] = actionFor(item);
  return raiseAdminAlert('schedule_conflict', {
    area: 'Schedule',
    action: await require('./audit').namedVisitAction(item.customer_id, templates, generic),
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
      scheduledServiceId: item.id, customerId: item.customer_id, scheduledDate: item.date, kind: item.kind,
    },
  });
}

// Close the notices that no longer apply. A notice stays open while its visit
// is still live on the notice's date, unless this run LOADED the visit, looked
// at every visit (`complete`) and did not collect it: then it moved off the
// conflict or got a time. A visit the run did not load (inside the lock
// window, or a run that failed part way) keeps its notice. Best effort.
async function closeResolved(bucket, { nowDate, complete, loadedIds }) {
  try {
    const audit = require('./audit');
    const standing = await audit.standingNoticeKeys(`${KEY_PREFIX}%`, RESOLVED_TITLE);
    const cleared = complete
      ? [...standing].filter((key) => !bucket.has(key)).map((key) => key.slice(KEY_PREFIX.length).split(':')[0]).filter((id) => loadedIds.has(id))
      : [];
    await audit.retireResolvedNotices({
      keyPattern: `${KEY_PREFIX}%`,
      stillOpen: (q) => {
        q.whereRaw("s.scheduled_date::text = notifications.metadata->>'scheduledDate'").whereIn('s.status', ['pending', 'confirmed']);
        if (cleared.length) q.whereNotIn('s.id', cleared);
      },
      resolvedTitle: RESOLVED_TITLE,
      resolution: 'The visit no longer needs a person to place it',
      body: 'This visit moved, was fixed or is no longer on that date.',
    }, nowDate);
  } catch (err) {
    logger.error(`[auto-dispatch] needs-a-person notice close failed: ${err.message}`);
  }
}

// Raise the collected notices: soonest date first, inside the shared ring
// allowance. Returns how many writes rang. Never throws.
async function raiseNotices(bucket, { nowDate = new Date(), complete = false, loadedIds = new Set() } = {}) {
  if (!bucket) return 0;
  await closeResolved(bucket, { nowDate, complete, loadedIds });
  if (bucket.size === 0) return 0;
  let rang = 0;
  try {
    const audit = require('./audit');
    const { raiseAdminAlert } = require('../admin-alert-compose');
    const { shortDateET } = require('../admin-alert-names');
    const standing = await audit.standingNoticeKeys(`${KEY_PREFIX}%`, RESOLVED_TITLE);
    let left = await audit.ringsLeft();
    for (const item of audit.withinRingBudget([...bucket.values()], standing, Infinity, (row) => row.key)) {
      // Allowance spent: nothing more is raised, a standing notice included.
      if (left <= 0) break;
      try {
        // Only a write that rang spends a slot.
        if (audit.noticeRang(await raiseOne(item, raiseAdminAlert, shortDateET))) { left -= 1; rang += 1; }
      } catch (err) {
        logger.error(`[auto-dispatch] needs-a-person notice failed for ${item.id}: ${err.message}`);
      }
    }
  } catch (err) {
    logger.error(`[auto-dispatch] needs-a-person notices failed: ${err.message}`);
  }
  return rang;
}

module.exports = {
  RESOLVED_TITLE, noticeKey, collect, collectFromEvaluation, raiseNotices,
};
