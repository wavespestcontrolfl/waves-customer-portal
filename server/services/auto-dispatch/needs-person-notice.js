/**
 * NEEDS A PERSON — the admin notice for a visit in conflict that
 * auto-dispatch leaves where it is (owner 2026-10-09: a forced move past the
 * move limit raises an alert, never moves silently).
 *
 * A notice is raised for EVERY loaded visit still in conflict (it overlaps
 * another stop, or sits on a closed day) when the run ends, whatever path
 * left it there, a visit a guard skipped before any evaluation included. The
 * run decides once (index.js settleConflicts). A visit with no arrival time
 * is NOT this lane's: the recurring-placement alert (`recurring-dispatch:*`,
 * flagUnplacedVisits) already tells a person, and a second bell for the same
 * visit would be noise (Codex #6253 r5). The reason only picks the wording:
 *       move_limit    it has used all its automatic moves (move-limit.js);
 *       no_near_slot  every free slot adds more drive than
 *                     config.conflictMaxAddedDriveMinutes;
 *       no_slot       no valid slot exists;
 *       not_moved     anything else: a freeze, a person-placed visit, a
 *                     guard on a grouped sibling, the per-run cap, a
 *                     refused, failed or partial write, a dry run. One rule
 *                     for all, so a new path cannot leave a
 *                     conflict unseen (Codex #6253 r1 and r2: lists of
 *                     reasons and of call sites each missed some).
 *
 * Collected during the run, raised once at its end. One notice per visit and
 * date (dedupe key below). The lane shares the auto-dispatch ring allowance
 * of 24 hours (audit.ringsLeft: all lanes and runs together), soonest date
 * first; a standing notice is refreshed free and the rest wait for the next
 * run. Raising is best effort: a failure is logged and never fails the run.
 *
 * A notice closes when its visit is cancelled or leaves the date, or when
 * the run has PROOF the conflict is gone:
 * it read the visit with the conflict read on and found none (closeResolved).
 * A run that could not look at the visit closes nothing.
 *
 * FAR CONFLICTS (GATE_AUTO_DISPATCH_FAR_CONFLICT_QUIET; owner 2026-10-22,
 * audit decision D1: "note double bookings more than 2 weeks away quietly;
 * alert when they are 2 weeks out"). Gate on, a conflict dated more than
 * FAR_DAYS ahead is a quiet Activity row under its own key (FAR_KEY_PREFIX):
 * off the bell list and outside the ring allowance, so it never takes a slot
 * from a near one. Within FAR_DAYS the ordinary notice rings as above, and
 * the quiet row closes once that notice stands. A quiet row closes on the
 * same proof as a notice; gate off, any still standing close.
 */
const logger = require('../logger');
const { toDateStr } = require('./dates');
const { gateEnvValue } = require('../../config/feature-gates');
const { etDateString, addETDays } = require('../../utils/datetime-et');

const RESOLVED_TITLE = 'Visit placement alert resolved';
const KEY_PREFIX = 'auto-dispatch-needs-person:';

// The wording for the reason codes that say why no slot was taken. Any other
// reason on a visit in conflict is 'not_moved'.
const REASON_KIND = {
  MOVE_LIMIT_REACHED: 'move_limit',
  CONFLICT_NO_NEAR_SLOT: 'no_near_slot',
  NO_VALID_SLOT: 'no_slot',
  NO_SLOT_MATCHING_PREFERENCE: 'no_slot',
  DRIFT_ANCHOR_STALE: 'no_slot',
};

const noticeKey = (id, date) => `${KEY_PREFIX}${id}:${date}`;

// Far conflicts (D1, header): their own key, so a quiet row is never the row
// the ordinary notice would refresh (a refresh that does not ring keeps a row
// hidden behind feed:'activity', notification-service mergeRefreshMetadata).
const FAR_GATE = 'GATE_AUTO_DISPATCH_FAR_CONFLICT_QUIET';
const FAR_KEY_PREFIX = 'auto-dispatch-needs-person-far:';
const FAR_DAYS = 14;
const farNoticeKey = (id, date) => `${FAR_KEY_PREFIX}${id}:${date}`;
const farEnabled = () => !!gateEnvValue(FAR_GATE);
// The last date that rings; a conflict after it is far.
const farCutoff = (nowDate) => etDateString(addETDays(nowDate, FAR_DAYS));

// What is wrong with the visit, in the words of the notice: [now, still].
const PROBLEM = {
  overlap: ['overlaps another stop', 'still overlaps another stop'],
  closed_day: ['is on a closed day', 'is still on a closed day'],
};

function problemOf(conflict) {
  return conflict.kind === 'closed_day' ? 'closed_day' : 'overlap';
}

// Remember a visit in conflict for the end-of-run notice. `bucket` is the run's Map.
function collect(bucket, service, kind, conflict) {
  if (!conflict) return;
  const date = toDateStr(service.scheduled_date);
  const key = noticeKey(service.id, date);
  if (!date || bucket.has(key)) return;
  bucket.set(key, {
    key, id: String(service.id), customer_id: service.customer_id || null, date, kind, problem: problemOf(conflict),
  });
}

// A visit in conflict that this run leaves where it is, for `reasonCode`.
// No conflict: nothing to tell a person.
function collectUnmoved(bucket, service, reasonCode, conflict) {
  if (conflict) collect(bucket, service, REASON_KIND[reasonCode] || 'not_moved', conflict);
}


function whyFor(item, spoken) {
  const [now, still] = PROBLEM[item.problem];
  if (item.kind === 'move_limit') return `The ${spoken} visit used all its automatic moves and ${still}.`;
  const reason = {
    no_near_slot: 'every open slot adds too much drive', no_slot: 'no open slot fits it',
  }[item.kind] || 'auto-dispatch did not move it';
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

async function noticeSpec(item, shortDateET) {
  const [templates, generic] = actionFor(item);
  return {
    area: 'Schedule',
    action: await require('./audit').namedVisitAction(item.customer_id, templates, generic),
    why: whyFor(item, shortDateET(`${item.date}T12:00:00Z`)),
    severity: 'needs-you',
    link: `/admin/dispatch?tab=schedule&date=${item.date}&appointment=${encodeURIComponent(item.id)}`,
    subject: { type: 'visit', id: item.id },
    doneWhen: 'visit_moved_or_done',
    who: 'person',
  };
}

function noticeMetadata(item) {
  return { scheduledServiceId: item.id, customerId: item.customer_id, scheduledDate: item.date, kind: item.kind, problem: item.problem };
}

async function raiseOne(item, raiseAdminAlert, shortDateET) {
  return raiseAdminAlert('schedule_conflict', await noticeSpec(item, shortDateET), {
    bell: true,
    dedupeKey: item.key,
    refreshOnDedupe: true,
    metadata: noticeMetadata(item),
  });
}

// A far conflict's quiet row (D1). bell: true only so the row is written (a
// bell:false notice inserts nothing under GATE_ADMIN_BELL_POLICY); feed
// 'activity' keeps it off the bell list, its unread count and the ring
// allowance (audit.recentBudgetKeys), as apply.js flagReminderSyncOverflow
// does. No refreshOnDedupe: written once, never rewritten, so it never rings.
async function raiseFarOne(item, raiseAdminAlert, shortDateET) {
  return raiseAdminAlert('schedule_conflict', await noticeSpec(item, shortDateET), {
    bell: true,
    dedupeKey: farNoticeKey(item.id, item.date),
    metadata: { ...noticeMetadata(item), feed: 'activity' },
  });
}

// Close the quiet rows named by `keys` (exact keys, LIKE-escaped): their
// visit is within FAR_DAYS now and its ordinary notice stands.
async function retireFarRows(keys, nowDate) {
  const audit = require('./audit');
  for (const key of keys) {
    await audit.retireResolvedNotices({
      keyPattern: String(key).replace(/[\\%_]/g, '\\$&'),
      stillOpen: (q) => q.whereRaw('false'),
      resolvedTitle: RESOLVED_TITLE,
      resolution: 'The visit is within two weeks; its dispatch alert took over',
      body: 'This visit is now within two weeks; the dispatch alert covers it.',
    }, nowDate);
  }
}

// Close the notices that no longer apply. A notice stays open while its visit
// is still live on the notice's date, unless the run has proof the conflict is gone: `clearedIds`
// holds the visits it read with the conflict read on and found clear. That
// read covers every visit with an open notice, evaluated this run or not
// (index.js settleConflicts), so a person's same-day fix closes the notice.
// A visit whose read failed keeps its notice, and so does every visit of a
// run whose guard reads failed (Codex #6253 r1 P2).
// The "visit still matches" conditions for a notice or quiet row of this
// lane: still live on the notice's date with an arrival time, and not among
// the visits the run proved clear.
function stillOpenFor(bucket, clearedIds) {
  const cleared = [...clearedIds].filter((id) => ![...bucket.values()].some((item) => item.id === id));
  return (q) => {
    // No arrival time any more: nothing to overlap, and that visit is the
    // recurring-placement alert's (Codex #6253 r6).
    q.whereRaw("s.scheduled_date::text = notifications.metadata->>'scheduledDate'").whereIn('s.status', ['pending', 'confirmed'])
      .whereRaw('s.window_start IS NOT NULL');
    if (cleared.length) q.whereNotIn('s.id', cleared);
  };
}

async function closeResolved(bucket, { nowDate, clearedIds }) {
  try {
    const audit = require('./audit');
    await audit.retireResolvedNotices({
      keyPattern: `${KEY_PREFIX}%`,
      stillOpen: stillOpenFor(bucket, clearedIds),
      resolvedTitle: RESOLVED_TITLE,
      resolution: 'The visit no longer needs a person to place it',
      body: 'This visit moved, was fixed or is no longer on that date.',
    }, nowDate);
  } catch (err) {
    logger.error(`[auto-dispatch] needs-a-person notice close failed: ${err.message}`);
  }
}

// Quiet far rows still standing (D1). The prefix filter guards the LIKE.
async function standingFarKeys(audit) {
  const keys = await audit.standingNoticeKeys(`${FAR_KEY_PREFIX}%`, RESOLVED_TITLE);
  return new Set([...keys].filter((key) => String(key).startsWith(FAR_KEY_PREFIX)));
}

// Gate on: close the quiet rows on the same proof as a notice (stillOpenFor).
// Gate off: close every one still standing, so the ordinary notice covers each
// conflict again (one read; nothing written when none stands). Never throws.
async function settleFarNotices(bucket, { nowDate, clearedIds, enabled }) {
  try {
    const audit = require('./audit');
    if (!enabled && !(await standingFarKeys(audit)).size) return;
    await audit.retireResolvedNotices({
      keyPattern: `${FAR_KEY_PREFIX}%`,
      stillOpen: enabled ? stillOpenFor(bucket, clearedIds) : (q) => q.whereRaw('false'),
      resolvedTitle: RESOLVED_TITLE,
      resolution: enabled ? 'The visit no longer needs a person to place it' : 'Quiet notes for far double bookings are off',
      body: enabled ? 'This visit moved, was fixed or is no longer on that date.' : 'The dispatch alert covers this visit again.',
    }, nowDate);
  } catch (err) {
    logger.error(`[auto-dispatch] far double-booking notes close failed: ${err.message}`);
  }
}

// Write the quiet row of each far conflict that has none standing (D1).
// Outside the ring allowance; a failure is logged and the rest still go.
async function raiseFarNotices(farItems, farStanding, raiseAdminAlert, shortDateET) {
  for (const item of farItems) {
    if (farStanding.has(farNoticeKey(item.id, item.date))) continue;
    try {
      await raiseFarOne(item, raiseAdminAlert, shortDateET);
    } catch (err) {
      logger.error(`[auto-dispatch] far double-booking note failed for ${item.id}: ${err.message}`);
    }
  }
}

// The visits of every notice still open (key = prefix + visit id + ':' + date).
// index.js settleConflicts reads each one's conflict again. Never throws.
async function standingVisitIds() {
  try {
    const audit = require('./audit');
    const ids = new Set();
    for (const prefix of [KEY_PREFIX, FAR_KEY_PREFIX]) {
      const keys = await audit.standingNoticeKeys(`${prefix}%`, RESOLVED_TITLE);
      for (const key of keys) {
        const id = String(key).startsWith(prefix) ? String(key).slice(prefix.length).split(':')[0] : '';
        if (id) ids.add(id);
      }
    }
    return [...ids];
  } catch (err) {
    logger.warn(`[auto-dispatch] open needs-a-person notices could not be read: ${err.message}`);
    return [];
  }
}

// Raise the collected notices: soonest date first, inside the shared ring
// allowance. Returns how many writes rang. Never throws.
async function raiseNotices(bucket, { nowDate = new Date(), clearedIds = new Set() } = {}) {
  if (!bucket) return 0;
  await closeResolved(bucket, { nowDate, clearedIds });
  const far = farEnabled();
  await settleFarNotices(bucket, { nowDate, clearedIds, enabled: far });
  if (bucket.size === 0) return 0;
  const cutoff = farCutoff(nowDate);
  const items = [...bucket.values()];
  const nearItems = far ? items.filter((item) => item.date <= cutoff) : items;
  let rang = 0;
  try {
    const audit = require('./audit');
    const { raiseAdminAlert } = require('../admin-alert-compose');
    const { shortDateET } = require('../admin-alert-names');
    const farStanding = far ? await standingFarKeys(audit) : new Set();
    if (far) await raiseFarNotices(items.filter((item) => item.date > cutoff), farStanding, raiseAdminAlert, shortDateET);
    const standing = await audit.standingNoticeKeys(`${KEY_PREFIX}%`, RESOLVED_TITLE);
    // The allowance counts a key once (audit.recentBudgetKeys), so a key may
    // ring once in 24 hours: one that already rang is not written again,
    // closed-and-reopened or with new wording (Codex #6253 r6). Its notice,
    // when open, stays as it is.
    const rung = await audit.recentBudgetKeys();
    let left = await audit.ringsLeft();
    const due = nearItems.filter((item) => !rung.has(item.key));
    // The near items whose ordinary notice stands after this run: their quiet row closes (D1).
    const covered = new Set(nearItems.filter((item) => standing.has(item.key) || rung.has(item.key)).map((item) => item.key));
    for (const item of audit.withinRingBudget(due, standing, Infinity, (row) => row.key)) {
      // Allowance spent: nothing more is written, a standing notice included.
      // Its refresh is free only when it does not ring, and a refresh whose
      // text changed can ring (audit.noticeRang: deduped and rung), which
      // would pass the allowance. The same rule as the pin lane (index.js
      // raiseMissingGeoNotices, Codex #6208 r13 to r16).
      if (left <= 0) break;
      try {
        const written = await raiseOne(item, raiseAdminAlert, shortDateET);
        if (written) covered.add(item.key);
        // Only a write that rang spends a slot.
        if (audit.noticeRang(written)) { left -= 1; rang += 1; }
      } catch (err) {
        logger.error(`[auto-dispatch] needs-a-person notice failed for ${item.id}: ${err.message}`);
      }
    }
    if (far) {
      await retireFarRows(nearItems.filter((item) => covered.has(item.key) && farStanding.has(farNoticeKey(item.id, item.date)))
        .map((item) => farNoticeKey(item.id, item.date)), nowDate);
    }
  } catch (err) {
    logger.error(`[auto-dispatch] needs-a-person notices failed: ${err.message}`);
  }
  return rang;
}

module.exports = {
  RESOLVED_TITLE, noticeKey, farNoticeKey, FAR_DAYS, collect, collectUnmoved, raiseNotices, standingVisitIds,
};
