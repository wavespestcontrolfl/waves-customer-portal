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
 * FAR_DAYS ahead does not ring: it is a line on ONE standing Activity row
 * (an ops digest, audience fyi: the Agents Activity feed, never the bell,
 * outside the ring allowance) that lists every far conflict of the run and
 * retires on a run with none (ops-digest-fall-off.js). Within FAR_DAYS the
 * conflict rings as the notice above. The digest needs the in-app Activity
 * feed (ops-digest.js inAppEnabled); without it far conflicts ring as before.
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

// Far conflicts (D1, header).
const FAR_GATE = 'GATE_AUTO_DISPATCH_FAR_CONFLICT_QUIET';
const FAR_DAYS = 14;
const FAR_DIGEST_KEY = 'auto-dispatch-far-conflicts';
const farGateOn = () => !!gateEnvValue(FAR_GATE);
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
      scheduledServiceId: item.id, customerId: item.customer_id, scheduledDate: item.date, kind: item.kind, problem: item.problem,
    },
  });
}

// Close the notices that no longer apply. A notice stays open while its visit
// is still live on the notice's date, unless the run has proof the conflict is gone: `clearedIds`
// holds the visits it read with the conflict read on and found clear. That
// read covers every visit with an open notice, evaluated this run or not
// (index.js settleConflicts), so a person's same-day fix closes the notice.
// A visit whose read failed keeps its notice, and so does every visit of a
// run whose guard reads failed (Codex #6253 r1 P2).
async function closeResolved(bucket, { nowDate, clearedIds }) {
  try {
    const audit = require('./audit');
    const cleared = [...clearedIds].filter((id) => ![...bucket.values()].some((item) => item.id === id));
    await audit.retireResolvedNotices({
      keyPattern: `${KEY_PREFIX}%`,
      stillOpen: (q) => {
        // No arrival time any more: nothing to overlap, and that visit is the
        // recurring-placement alert's (Codex #6253 r6).
        q.whereRaw("s.scheduled_date::text = notifications.metadata->>'scheduledDate'").whereIn('s.status', ['pending', 'confirmed'])
          .whereRaw('s.window_start IS NOT NULL');
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

// The visits of every notice still open (key = prefix + visit id + ':' + date).
// index.js settleConflicts reads each one's conflict again. Never throws.
async function standingVisitIds() {
  try {
    const keys = await require('./audit').standingNoticeKeys(`${KEY_PREFIX}%`, RESOLVED_TITLE);
    return [...new Set([...keys].map((key) => String(key).slice(KEY_PREFIX.length).split(':')[0]).filter(Boolean))];
  } catch (err) {
    logger.warn(`[auto-dispatch] open needs-a-person notices could not be read: ${err.message}`);
    return [];
  }
}

// The run's conflicts that ring now, and the far ones the Activity row lists
// instead (D1). Off, or with no in-app Activity feed, every conflict rings.
function splitFar(bucket, nowDate) {
  const items = [...bucket.values()];
  let farOn = false;
  try {
    farOn = farGateOn() && require('../ops-digest').inAppEnabled() === true;
  } catch (err) {
    logger.warn(`[auto-dispatch] far double-booking check failed (${err.message}); every conflict rings`);
  }
  if (!farOn) return { nearItems: items, farItems: [], farOn };
  const cutoff = farCutoff(nowDate);
  // notifyAdmin writes nothing for an internal test customer, so its visit is
  // never listed either (it would wait on the list for a notice forever).
  const { isInternalTestCustomerId } = require('../internal-test-customers');
  const real = items.filter((item) => !isInternalTestCustomerId(item.customer_id));
  return { nearItems: items.filter((item) => item.date <= cutoff), farItems: real.filter((item) => item.date > cutoff), farOn };
}

function farLines(sorted, names, shortDateET) {
  return sorted.map((item, i) => `${shortDateET(`${item.date}T12:00:00Z`)}: ${names[i]} ${PROBLEM[item.problem][0]}.`);
}

function escapeHtml(text) {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// The visits on the standing far list (D1), from its stored itemKeys
// (`<visit>:<date>`). The run's end re-reads each one (index.js
// conflictsToSettle), so a listed conflict whose visit the scan no longer
// loads (locked, excluded) stays listed while it stands and rings at
// FAR_DAYS, the way a standing notice keeps its visit in the re-read.
// [] when no list stands; null when it cannot be read (the scan is then
// incomplete and the list is left as it is). Never throws.
async function farListedVisitIds(conn = require('../../models/db')) {
  try {
    const row = await conn('notifications')
      .where({ recipient_type: 'admin', category: 'ops_digest' })
      .whereRaw("COALESCE(metadata->>'resolved', '') <> 'true'")
      .whereRaw("metadata->>'opsKey' = ?", [FAR_DIGEST_KEY])
      .whereRaw("metadata->>'source' IS NULL")
      .orderBy('created_at', 'desc')
      .first('metadata');
    if (!row) return [];
    // farVisits: every listed conflict (the list's own metadata, uncapped);
    // itemKeys: ops-digest's capped copy, for a row written before farVisits.
    const keys = row.metadata && (Array.isArray(row.metadata.farVisits) ? row.metadata.farVisits : row.metadata.itemKeys);
    // A row without either is re-read as empty; the next complete scan rewrites it.
    if (!Array.isArray(keys)) {
      logger.warn('[auto-dispatch] far double-booking list has no stored visits; the next complete scan rewrites it');
      return [];
    }
    return [...new Set(keys.map((key) => String(key).split(':')[0]).filter(Boolean))];
  } catch (err) {
    logger.warn(`[auto-dispatch] far double-booking list read failed: ${err.message}`);
    return null;
  }
}

// The standing Activity row of the run's far conflicts (D1): one ops digest,
// audience fyi (Activity only, never the bell; not a ring-allowance lane),
// refreshed in place each run and retired on a run with none, or with the
// lane off once every conflict on it has its notice (fall-off). The list is
// a snapshot, so it changes only after a COMPLETE conflict scan
// (`scanComplete`: the run did not fail, conflict reads were on and none
// failed); otherwise it stays as it is, the way a notice closes only on
// proof. In-app only: a missing Activity feed sends no email (splitFar rings
// every conflict in that case). Never throws.
async function reportFarConflicts(farItems, { enabled, scanComplete }) {
  try {
    if (!scanComplete) {
      logger.info(`[auto-dispatch] far double-booking list left as it is: this run's conflict scan was incomplete (${farItems.length} to list)`);
      return;
    }
    if (!farItems.length) {
      await require('../ops-digest-fall-off').retireIfClean(FAR_DIGEST_KEY, { lockKey: `ops-digest:${FAR_DIGEST_KEY}` });
      return;
    }
    // Gate off (or no Activity feed): never start a list; keep one that still
    // stands, with the conflicts whose notice is not written yet.
    if (!enabled) {
      const listed = await module.exports.farListedVisitIds();
      if (!Array.isArray(listed) || !listed.length) return;
    }
    const audit = require('./audit');
    const { shortDateET } = require('../admin-alert-names');
    const all = [...farItems].sort((a, b) => (a.date < b.date ? -1 : (a.date > b.date ? 1 : 0)));
    // The text stops at ops-digest's item-key cap. The full set goes in twice:
    // as itemKeys, whose itemSetHash ops-digest computes over every key (past
    // the cap it stores no keys, but the hash still changes with the set, so
    // the standing row refreshes), and as the list's own metadata.farVisits,
    // uncapped, which the next run re-reads (farListedVisitIds).
    const sorted = all.slice(0, require('../ops-digest').MAX_ITEM_KEYS);
    const allKeys = all.map((item) => `${item.id}:${item.date}`);
    const names = [];
    for (const item of sorted) names.push(await audit.namedVisitAction(item.customer_id, [(who) => `${who}'s visit`], 'A visit'));
    const lines = farLines(sorted, names, shortDateET);
    if (all.length > sorted.length) lines.push(`And ${all.length - sorted.length} more after the last date above.`);
    const n = all.length;
    const headline = `Schedule — ${n} double booking${n === 1 ? '' : 's'} more than 2 weeks out`;
    const summary = 'Each one rings as a dispatch alert once it is 2 weeks out.';
    await require('../ops-digest').deliverOpsDigest({
      fallOff: true,
      key: FAR_DIGEST_KEY,
      audience: 'fyi',
      subject: headline,
      headline,
      summary,
      text: [summary, '', ...lines].join('\n'),
      html: `<p>${escapeHtml(summary)}</p><ul>${lines.map((line) => `<li>${escapeHtml(line)}</li>`).join('')}</ul>`,
      count: n,
      itemKeys: allKeys,
      metadata: { farVisits: allKeys },
      link: '/admin/dispatch?tab=schedule',
      dedupeKey: `ops-digest:${FAR_DIGEST_KEY}`,
      refreshOnDedupe: true,
      sendEmail: async () => ({ ok: false, error: 'far double bookings are listed in the Activity feed only' }),
    });
  } catch (err) {
    logger.error(`[auto-dispatch] far double-booking list failed: ${err.message}`);
  }
}

// Raise the collected notices: soonest date first, inside the shared ring
// allowance. Returns how many writes rang. Never throws.
async function raiseNotices(bucket, { nowDate = new Date(), clearedIds = new Set(), scanComplete = false } = {}) {
  if (!bucket) return 0;
  await closeResolved(bucket, { nowDate, clearedIds });
  const { nearItems, farItems, farOn } = splitFar(bucket, nowDate);
  const { rang, persisted } = await ringNear(nearItems);
  // A conflict that just came within FAR_DAYS stays on the list until its
  // notice is persisted (allowance spent, a failed write): the list keeps it
  // tracked, and re-read by the next run (index.js conflictsToSettle), even
  // when the scan no longer loads its visit.
  // Gate off, a list still standing keeps the same ones until their notice
  // stands too, then retires (reportFarConflicts never starts a list then).
  const waiting = nearItems.filter((item) => !persisted.has(item.key));
  await reportFarConflicts(farOn ? [...farItems, ...waiting] : waiting, { enabled: farOn, scanComplete });
  return rang;
}

// The ordinary notices, soonest first inside the shared ring allowance.
// Returns how many writes rang and the keys whose notice now stands. Never throws.
async function ringNear(nearItems) {
  const persisted = new Set();
  let rang = 0;
  if (!nearItems.length) return { rang, persisted };
  try {
    const audit = require('./audit');
    const { raiseAdminAlert } = require('../admin-alert-compose');
    const { shortDateET } = require('../admin-alert-names');
    const standing = await audit.standingNoticeKeys(`${KEY_PREFIX}%`, RESOLVED_TITLE);
    for (const item of nearItems) if (standing.has(item.key)) persisted.add(item.key);
    // The allowance counts a key once (audit.recentBudgetKeys), so a key may
    // ring once in 24 hours: one that already rang is not written again,
    // closed-and-reopened or with new wording (Codex #6253 r6). Its notice,
    // when open, stays as it is.
    const rung = await audit.recentBudgetKeys();
    let left = await audit.ringsLeft();
    const due = nearItems.filter((item) => !rung.has(item.key));
    for (const item of audit.withinRingBudget(due, standing, Infinity, (row) => row.key)) {
      // Allowance spent: nothing more is written, a standing notice included.
      // Its refresh is free only when it does not ring, and a refresh whose
      // text changed can ring (audit.noticeRang: deduped and rung), which
      // would pass the allowance. The same rule as the pin lane (index.js
      // raiseMissingGeoNotices, Codex #6208 r13 to r16).
      if (left <= 0) break;
      try {
        const written = await raiseOne(item, raiseAdminAlert, shortDateET);
        if (written) persisted.add(item.key);
        // Only a write that rang spends a slot.
        if (audit.noticeRang(written)) { left -= 1; rang += 1; }
      } catch (err) {
        logger.error(`[auto-dispatch] needs-a-person notice failed for ${item.id}: ${err.message}`);
      }
    }
  } catch (err) {
    logger.error(`[auto-dispatch] needs-a-person notices failed: ${err.message}`);
  }
  return { rang, persisted };
}

module.exports = {
  RESOLVED_TITLE, noticeKey, FAR_DAYS, FAR_DIGEST_KEY, collect, collectUnmoved, raiseNotices, standingVisitIds, farListedVisitIds,
};
