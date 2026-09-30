/**
 * Same-stop regroup sweep.
 *
 * Future same-day services at one stop that qualify for a visit group but
 * were never grouped (written before the gates, while autopay customers were
 * excluded, or by a writer that never calls maybeGroupRow — moves, series
 * extension) get folded into ONE visit so the tech closes them out together.
 *
 * Eligibility is NOT re-implemented here. Candidates are pre-filtered by a
 * cheap SQL shape (an ungrouped, not-started, tomorrow-or-later row with a
 * same-day same-customer same-property live partner); every verdict then
 * comes from visit-groups.js: `maybeGroupRow(id, { preview: true })` runs the
 * exact read-only eligibility path (property + window required, canJoin,
 * windowsOverlap, technician partition, autopay fast path, gate) and the
 * apply path IS `maybeGroupRow(id)` — createOrJoinVisit with its customer,
 * stop-advisory and row locks, freeze checks and child-artifact refusals.
 *
 * Grouping writes no customer message. createOrJoinVisit only stamps
 * scheduled_services.visit_id, inserts/widens a service_visits row, and — for
 * a member with no technician when the visit has one — aligns it through
 * assignDispatchJob (tech-facing dispatch broadcast/alert only). Customer
 * texts stay owned by the reminder/tracker/closeout senders, which read
 * visit membership.
 *
 * One extra guard specific to a BACKFILL: a set whose members are at
 * different reminder-tier states (one already got its 72h/24h reminder, the
 * other has not) is left alone. The reminder sender dedupes per visit, so the
 * un-reminded sibling's due tier would otherwise fire ONE combined notice to
 * a customer who already got a reminder for the other service.
 *
 * Never touches today or earlier: a tech's day does not change under them.
 */

const db = require('../models/db');
const { etDateString, addETDays } = require('../utils/datetime-et');
const { JOIN_INELIGIBLE_STATUSES } = require('./visit-context/statuses');

const DEFAULT_LIMIT = 500;

/** Tomorrow (ET) as YYYY-MM-DD — the earliest date the sweep may touch. */
function earliestRegroupDate(now = new Date()) {
  return etDateString(addETDays(now, 1));
}

async function reminderStateKey(database, rowIds) {
  const reminders = await database('appointment_reminders')
    .whereIn('scheduled_service_id', rowIds)
    .select('scheduled_service_id', 'reminder_72h_sent', 'reminder_24h_sent');
  const byRow = new Map(reminders.map((r) => [String(r.scheduled_service_id), r]));
  // A missing reminder row arms fresh (unsent) later, so it reads as unsent.
  return rowIds.map((id) => {
    const r = byRow.get(String(id));
    return `${r && r.reminder_72h_sent ? 1 : 0}${r && r.reminder_24h_sent ? 1 : 0}`;
  });
}

// Every member the eligibility path picked must itself be untouched: a
// partner already en route / on site (or otherwise started) is never folded
// into a group by a backfill, and nothing dated before `earliest` is touched.
async function membersStillUntouched(database, rowIds, earliest) {
  const rows = await database('scheduled_services')
    .whereIn('id', rowIds)
    .select('id', 'status', 'track_state', 'en_route_at', 'arrived_at', 'scheduled_date');
  if (rows.length !== rowIds.length) return false;
  return rows.every((r) => ['pending', 'confirmed'].includes(String(r.status))
    && String(r.track_state) === 'scheduled' && !r.en_route_at && !r.arrived_at
    && dateString(r.scheduled_date) >= earliest);
}

const dateString = (value) => require('./visit-groups').dateOnly(value);

async function findCandidateRows(database, { fromDate, toDate, limit, after = null }) {
  const q = database('scheduled_services as ss')
    .join('services as svc', 'ss.service_id', 'svc.id')
    .whereNull('ss.visit_id')
    .whereIn('ss.status', ['pending', 'confirmed'])
    .where('ss.track_state', 'scheduled')
    .whereNull('ss.en_route_at')
    .whereNull('ss.arrived_at')
    .whereNotNull('ss.property_id')
    .whereNotNull('ss.window_start')
    .where('svc.groupable', true)
    .whereNotNull('svc.group_family')
    .where('ss.scheduled_date', '>=', fromDate)
    .whereRaw(
      `EXISTS (SELECT 1 FROM scheduled_services p
         JOIN services psvc ON psvc.id = p.service_id
        WHERE p.customer_id = ss.customer_id
          AND p.property_id = ss.property_id
          AND p.scheduled_date = ss.scheduled_date
          AND p.id <> ss.id
          AND p.status NOT IN (${JOIN_INELIGIBLE_STATUSES.map(() => '?').join(',')})
          AND psvc.groupable = true
          AND psvc.group_family = svc.group_family)`,
      JOIN_INELIGIBLE_STATUSES,
    )
    .orderBy('ss.scheduled_date', 'asc')
    .orderBy('ss.id', 'asc')
    .limit(limit)
    .select('ss.id', 'ss.customer_id', 'ss.property_id', 'ss.scheduled_date');
  if (toDate) q.where('ss.scheduled_date', '<=', toDate);
  // Keyset paging (date, id): rows judged ineligible stay ungrouped and match
  // every night, so a fixed first page could fill with them and starve later
  // eligible stops. The sweep walks every page instead.
  if (after) q.whereRaw('(ss.scheduled_date, ss.id) > (?::date, ?::uuid)', [after.date, after.id]);
  return q;
}

// Backfill fences re-checked by createOrJoinVisit under its row locks, in
// the membership-write transaction: the preview's unlocked reads can go stale
// if a reminder run or a lifecycle transition lands before the apply. The
// reminder rows are read FOR SHARE so a concurrent reminder stamp serializes
// behind the grouping (or is seen, committed, before it).
function lockedFences(earliest) {
  return async (fresh, trx) => {
    const ids = fresh.map((r) => String(r.id));
    await trx('appointment_reminders').whereIn('scheduled_service_id', ids).forShare().select('id');
    if (!(await membersStillUntouched(trx, ids, earliest)) || new Set(await reminderStateKey(trx, ids)).size > 1) {
      const err = new Error('regroup fence changed under lock');
      err.code = 'REGROUP_FENCE_CHANGED';
      throw err;
    }
  };
}

// One reported group per stop: a transitive window chain (09-10, 10-11,
// 11-12) yields overlapping verdicts that share a member, so a verdict that
// touches an already-reported group widens that group instead of adding one.
function recordGroup(groups, byRow, group) {
  const existing = group.rowIds.map((id) => byRow.get(id)).find(Boolean);
  const target = existing || group;
  if (existing) {
    existing.rowIds = [...new Set([...existing.rowIds, ...group.rowIds])];
    if (!existing.visitId) existing.visitId = group.visitId;
  } else {
    groups.push(group);
  }
  target.rowIds.forEach((id) => byRow.set(id, target));
}

async function judgeCandidate(cand, { database, dryRun, earliest, handled }) {
  const VisitGroups = require('./visit-groups');
  // Read-only verdict from the real eligibility path.
  const verdict = await VisitGroups.maybeGroupRow(cand.id, { database, preview: true, createdBy: 'regroup-sweep' });
  if (!verdict || !verdict.rowIds) {
    handled.add(String(cand.id));
    return { left: [{ rowId: cand.id, reason: 'not_eligible' }] };
  }
  const rowIds = verdict.rowIds.map(String);
  rowIds.forEach((id) => handled.add(id));
  const leave = (reason) => ({ left: rowIds.map((id) => ({ rowId: id, reason })) });
  if (!(await membersStillUntouched(database, rowIds, earliest))) return leave('already_started');
  if (new Set(await reminderStateKey(database, rowIds)).size > 1) return leave('reminder_state_differs');
  const group = {
    customerId: cand.customer_id, propertyId: cand.property_id, date: dateString(cand.scheduled_date), rowIds, visitId: null,
  };
  if (dryRun) return { group };
  const visit = await VisitGroups.maybeGroupRow(cand.id, {
    database, createdBy: 'regroup-sweep', lockedGuard: lockedFences(earliest),
  });
  // createOrJoinVisit refused under its locks (frozen, artifact, in-flight
  // completion, a backfill fence that changed since the preview).
  if (!visit || !visit.id) return leave('refused');
  // The apply recomputes membership under locks; report what it wrote.
  const members = await database('scheduled_services').where({ visit_id: visit.id }).select('id');
  return { group: { ...group, rowIds: members.map((m) => String(m.id)), visitId: visit.id } };
}

/**
 * @param {object}  [opts]
 * @param {string}  [opts.fromDate]  YYYY-MM-DD; clamped up to tomorrow (ET).
 * @param {string}  [opts.toDate]    YYYY-MM-DD inclusive upper bound.
 * @param {boolean} [opts.dryRun=true]  Default is a dry run; pass false to write.
 * @param {object}  [opts.database]  knex handle (default: shared pool).
 * @param {Date}    [opts.now]       Clock, for tests.
 * @param {number}  [opts.limit]     Candidate rows per page (every page is walked).
 * @param {number}  [opts.maxCandidates]  Total candidate rows this run may judge
 *   (operator rollout cap); unset = every candidate.
 * @returns {Promise<{ skipped?: string, dryRun: boolean, fromDate: string,
 *   toDate: string|null, candidates: number, capped: boolean, groups: Array, left: Array }>}
 *   groups: one entry per stop [{ customerId, propertyId, date, rowIds, visitId }]
 *   (visitId null on a dry run); left: [{ rowId, reason }] ('not_eligible' |
 *   'already_started' | 'reminder_state_differs' | 'refused'). Ids only — never a customer name.
 */
async function regroupUngroupedSameStopRows({
  fromDate, toDate = null, dryRun = true, database = db, now = new Date(), limit = DEFAULT_LIMIT,
  maxCandidates = null,
} = {}) {
  const { gates } = require('../config/feature-gates');
  const earliest = earliestRegroupDate(now);
  const effectiveFrom = fromDate && String(fromDate) > earliest ? String(fromDate) : earliest;
  const base = {
    dryRun: Boolean(dryRun), fromDate: effectiveFrom, toDate, candidates: 0, capped: false, groups: [], left: [],
  };
  if (!gates.visitGroups) return { ...base, skipped: 'gate_off' };

  const handled = new Set();
  const byRow = new Map();
  const ctx = { database, dryRun, earliest: effectiveFrom, handled };
  let after = null;
  for (;;) {
    const candidates = await findCandidateRows(database, { fromDate: effectiveFrom, toDate, limit, after });
    if (!candidates.length) break;
    after = { date: dateString(candidates[candidates.length - 1].scheduled_date), id: candidates[candidates.length - 1].id };
    for (const cand of candidates) {
      if (maxCandidates && base.candidates >= maxCandidates) {
        base.capped = true;
        return base;
      }
      base.candidates += 1;
      if (handled.has(String(cand.id))) continue;
      const outcome = await judgeCandidate(cand, ctx);
      if (outcome.left) base.left.push(...outcome.left);
      if (outcome.group) recordGroup(base.groups, byRow, outcome.group);
    }
    if (candidates.length < limit) break;
  }
  return base;
}

/** Count of candidate rows (ungrouped + a same-stop partner) from tomorrow on. */
async function countRegroupCandidateRows({ fromDate, toDate = null, database = db, now = new Date() } = {}) {
  const earliest = earliestRegroupDate(now);
  const effectiveFrom = fromDate && String(fromDate) > earliest ? String(fromDate) : earliest;
  let total = 0;
  let after = null;
  for (;;) {
    const rows = await findCandidateRows(database, { fromDate: effectiveFrom, toDate, limit: DEFAULT_LIMIT, after });
    total += rows.length;
    if (rows.length < DEFAULT_LIMIT) return total;
    const last = rows[rows.length - 1];
    after = { date: dateString(last.scheduled_date), id: last.id };
  }
}

module.exports = { regroupUngroupedSameStopRows, countRegroupCandidateRows, earliestRegroupDate, DEFAULT_LIMIT };
