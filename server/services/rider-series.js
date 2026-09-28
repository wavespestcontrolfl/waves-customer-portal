/**
 * Rider-series core (pest-rides-the-lawn-rhythm PR 1).
 * Scope doc: ~/lawn-pest-rhythm-scope-20260928.md ("Date rule", "PR 1").
 *
 * A rider series (e.g. quarterly pest) derives its future visit dates from
 * a host series (e.g. lawn every 6 weeks) instead of walking its own
 * interval. Nothing in this repository SETS `scheduled_services.
 * rides_parent_id` yet (PR 2 = estimate accept, PR 3 = existing-customer
 * backfill) — this module is dark by construction: every entry point below
 * is a no-op unless that column is already set on real data.
 *
 * Date rule (MIN_GAP 77 / TARGET 84 / MAX_WAIT 105 days): repeatedly, the
 * next rider date is the first live host date at least MIN_GAP days after
 * the last rider date; if none exists within MAX_WAIT days, the rider
 * places its own TARGET-day standalone date instead. See planRiderDates.
 *
 * Locking: the per-parent recurring-series-maintenance advisory lock (key
 * derivation owned by routes/admin-schedule.js#acquireRecurringSeriesMaintenanceLock,
 * reused here — see that function's own comment: "key derivation must stay
 * byte-identical across all of them or they silently stop contending") is
 * taken for BOTH the host's parent id and the rider's parent id, and the
 * customer-comms lock for the shared customer. All three acquisitions use
 * the NON-BLOCKING (wait:false) form. This module is reached from BOTH
 * directions — a rider's own completion/top-up hook already holds the
 * RIDER's lock before calling in here, and a host's extend/seed hook
 * already holds the HOST's lock before calling in here — so a fixed
 * blocking order (host-then-rider) is not achievable without releasing and
 * re-acquiring a lock mid-transaction, which pg_advisory_xact_lock does not
 * support. Non-blocking acquisition on whichever lock is not already held
 * makes a deadlock structurally impossible (a try-lock never waits): on
 * contention this sync is skipped for this pass and the nightly reconcile
 * (server/services/rider-series-reconcile.js) retries it. The order
 * host-then-rider is still followed wherever both are being acquired fresh
 * (the nightly reconcile, the seeder's post-seed hook), matching the
 * ORDERING CONTRACT convention in scheduling/occupancy.js.
 */
const logger = require('./logger');
const {
  parseETDateTime, etDateString, addETDays,
} = require('../utils/datetime-et');
const { TERMINAL_ROW_STATUSES, JOIN_INELIGIBLE_STATUSES } = require('./visit-context/statuses');
const { LIVE_COMPLETION_CLAIM_STATUSES, maybeGroupRow } = require('./visit-groups');
const { transitionJobStatus } = require('./job-status');

const MIN_GAP_DAYS = 77;
const TARGET_GAP_DAYS = 84;
const MAX_WAIT_DAYS = 105;
// Owner ruling: existing customers' pest dates move with NO texts — a row
// inside this window is close enough that the customer may already be
// acting on it (packing a cooler, arranging access), so it's a fixed
// anchor regardless of what any reminder/confirmation ledger shows.
const NEAR_TERM_DAYS = 7;

// In-progress statuses: a visit a tech is actively on stops being a
// candidate to move or cancel, same posture as every other series writer
// (cancellation-processor.js's LIVE_TRACK_STATES / CANCELLABLE_STATUSES).
const IN_PROGRESS_STATUSES = ['en_route', 'on_site'];

function dateOnly(value) {
  if (!value) return null;
  if (typeof value === 'string') return value.slice(0, 10);
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

function addDaysStr(dateStr, days) {
  const base = parseETDateTime(`${dateOnly(dateStr)}T12:00`);
  if (isNaN(base.getTime())) return null;
  return etDateString(addETDays(base, days));
}

// Same weekend-shift arithmetic the seeder applies to every date it walks
// (recurring-appointment-seeder.js#shiftPastWeekend), reused verbatim
// rather than re-derived — used only for a STANDALONE fallback date (a
// host date is already the host series' own, already-shifted, date).
function shiftPastWeekend(dateStr, skip, direction = 'forward') {
  if (!skip || !dateStr) return dateStr;
  const { shiftPastWeekend: seederShift } = require('./recurring-appointment-seeder');
  return seederShift(dateStr, skip, direction);
}

/**
 * Pure date rule — no DB access. Returns a sorted array of future rider
 * dates (each strictly after the previous, all <= horizonDate).
 *
 * @param {string[]} hostDates - the host series' live future dates
 *   (YYYY-MM-DD), any order/duplicates tolerated.
 * @param {string} lastRiderDate - the anchor: the rider's latest
 *   completed-or-immovable date (YYYY-MM-DD).
 * @param {string} horizonDate - never plan a date past this (YYYY-MM-DD).
 * @param {boolean} [skipWeekends] - the rider series' own weekend
 *   preference, applied only to a standalone fallback date.
 * @param {'forward'|'back'} [weekendShift] - the rider series' own shift
 *   direction, applied only to a standalone fallback date.
 */
function planRiderDates({
  hostDates = [], lastRiderDate, horizonDate, skipWeekends = false, weekendShift = 'forward',
} = {}) {
  const anchor = dateOnly(lastRiderDate);
  const horizon = dateOnly(horizonDate);
  const dates = [];
  if (!anchor || !horizon) return dates;
  const sortedHosts = Array.from(new Set((hostDates || []).map(dateOnly).filter(Boolean))).sort();
  const dir = weekendShift === 'back' ? 'back' : 'forward';

  let last = anchor;
  // Bounded: at MIN_GAP_DAYS per step this comfortably covers any
  // realistic horizon (a 20-year horizon is ~95 steps at 77 days).
  for (let guard = 0; guard < 1000; guard++) {
    const minDate = addDaysStr(last, MIN_GAP_DAYS);
    const maxDate = addDaysStr(last, MAX_WAIT_DAYS);
    if (!minDate || !maxDate) break;
    const hostCandidate = sortedHosts.find((d) => d >= minDate);
    let next = (hostCandidate && hostCandidate <= maxDate)
      ? hostCandidate
      : shiftPastWeekend(addDaysStr(last, TARGET_GAP_DAYS), skipWeekends, dir);
    if (!next || next <= last) break; // malformed input guard — never stall/reverse
    if (next > horizon) break;
    dates.push(next);
    last = next;
  }
  return dates;
}

// Non-blocking acquire of the SAME per-parent maintenance advisory lock
// admin-schedule.js#acquireRecurringSeriesMaintenanceLock uses — key
// derivation copied verbatim (namespace 'recurring-series-maintenance',
// key = String(parentId)) rather than imported, because that function is
// not exported for production reuse (only via router._test) and this
// module must never risk drifting from routes/admin-schedule.js's own copy
// silently — any future change to that key derivation must be mirrored
// here by the same rule its own comment states.
async function tryLockSeriesMaintenance(trx, parentId) {
  const result = await trx.raw(
    'SELECT pg_try_advisory_xact_lock(hashtext(?), hashtext(?::text)) AS locked',
    ['recurring-series-maintenance', String(parentId)],
  );
  return result.rows[0]?.locked === true;
}

async function lockCustomerCommsIfKnown(trx, customerId) {
  if (!customerId) return;
  const { lockCustomerComms } = require('../utils/customer-comms-lock');
  await lockCustomerComms(trx, customerId);
}

// Batched "is this rider row an immovable anchor" lookup — never move,
// re-date or cancel a row a customer or the business is already committed
// to. Conservative by design (see the module header's per-condition list).
// FAILS CLOSED: any one of these queries throwing propagates straight out
// (no try/catch here) — a query failure means "can't prove this row is
// safe to touch," never "safe to touch." The caller (syncRiderSeries) runs
// this whole reconcile inside a savepoint, so the thrown error aborts and
// rolls back JUST this rider's sync (nothing moved/inserted/cancelled),
// logged as skipped: 'error'; the nightly reconcile retries later.
async function immovableRowIdSet(trx, rowIds) {
  const ids = (rowIds || []).filter(Boolean);
  const immovable = new Set();
  if (!ids.length) return immovable;
  const [
    invoiced, held, cardApproved, packeted, completionClaims, reminderSent,
  ] = await Promise.all([
    trx('invoices').whereIn('scheduled_service_id', ids).pluck('scheduled_service_id'),
    trx('estimate_card_holds').whereIn('scheduled_service_id', ids)
      .whereIn('status', ['held', 'charged_completion', 'charged_no_show']).pluck('scheduled_service_id'),
    trx('appointment_card_requests').whereIn('scheduled_service_id', ids)
      .whereIn('status', ['completed', 'satisfied']).pluck('scheduled_service_id'),
    trx('visit_completion_packet_items').whereIn('scheduled_service_id', ids).pluck('scheduled_service_id'),
    trx('service_completion_attempts').whereIn('service_id', ids)
      .whereIn('status', LIVE_COMPLETION_CLAIM_STATUSES).pluck('service_id'),
    // The authoritative "already told the customer" ledger
    // (appointment-reminders.js) — a row whose 72h/24h reminder or booking
    // confirmation already sent must stay put (owner ruling: existing
    // customers' pest dates move with NO texts, so a row the customer has
    // already been told about is fixed).
    trx('appointment_reminders').whereIn('scheduled_service_id', ids)
      .where((q) => q.where('confirmation_sent', true).orWhere('reminder_72h_sent', true).orWhere('reminder_24h_sent', true))
      .pluck('scheduled_service_id'),
  ]);
  for (const id of [...invoiced, ...held, ...cardApproved, ...packeted, ...completionClaims, ...reminderSent]) immovable.add(id);
  return immovable;
}

// Status/attribute-only immovability (no DB) — combined with
// immovableRowIdSet's attribute lookups by the caller. Includes the
// scheduled_services-column "already told the customer" stamps
// (appointment-reminders.js also writes confirmation_sms_sent_at on this
// row for a legacy/placeholder path; reminder_24h_sent / arrival_sms_sent_at
// / prep_sent_at are this row's own send stamps outside that ledger) and
// visit_id: a grouped row's date is kept in sync with its service_visits
// stop only through visit-groups.js's own move paths (handleChildStopChanged
// runs on the pool, not this module's trx) — a plain UPDATE here would
// silently desync the row from its stop's base key, so a grouped row is
// never a move/cancel candidate; the visit's own move (or ungrouping) is
// what relocates it.
function immovableByOwnFields(row) {
  return IN_PROGRESS_STATUSES.includes(row.status)
    || row.prepaid_amount != null
    || row.customer_confirmed === true
    || row.field_confirmed_at != null
    || row.visit_id != null
    || row.confirmation_sms_sent_at != null
    || row.reminder_24h_sent === true
    || row.arrival_sms_sent_at != null
    || row.prep_sent_at != null;
}

// ALLOWLIST, not a blocklist: scheduled_services carries dozens of
// per-visit transient/unique columns (track_view_token, reschedule_token,
// prep_token, followup_source_service_id, dispatch/auto-dispatch state,
// SMS-sent timestamps, ...) that must never ride onto a brand-new row —
// several are UNIQUE and would fail the insert outright. This list is the
// same shape buildRecurringFollowUpRows (recurring-appointment-seeder.js)
// stamps for an ordinary seeded follow-up, plus the price/discount fields
// extendSeriesOnceLocked (admin-schedule.js) additionally copies for an
// auto-extend insert — together "what the rider series would have
// produced" per the PR brief, without re-deriving either writer's pricing
// logic. A rider's own price does not vary by date the way a host's
// due-add-on rows can (owner ruling 2026-09-28: keep the per-visit pest
// price), so a flat copy of these fields from the template needs no
// per-date recomputation.
const TEMPLATE_COPY_FIELDS = [
  'customer_id', 'service_type', 'notes', 'time_window', 'zone',
  'estimated_duration_minutes', 'estimated_price', 'payment_method_preference',
  'source_estimate_id', 'source', 'is_recurring', 'recurring_pattern',
  'recurring_ongoing', 'skip_weekends', 'weekend_shift',
  'recurring_nth', 'recurring_weekday', 'recurring_interval_days',
  'appointment_type', 'create_invoice_on_complete', 'annual_prepay_term_id',
  'service_id', 'service_key_snapshot', 'service_category_snapshot',
  'discount_type', 'discount_amount', 'discount_dollars',
  'line_discount_id', 'line_discount_type', 'line_discount_amount',
  'line_discount_dollars', 'line_discount_name',
  'discount_id', 'discount_name', 'discount_max_dollars',
  'discount_service_key_filter', 'discount_service_category_filter',
  'primary_line_price', 'pricing_provenance',
  'payer_id', 'po_number', 'self_pay_override',
  'property_id', 'service_address_line1', 'service_address_line2',
  'service_address_city', 'service_address_state', 'service_address_zip',
  'lat', 'lng',
];
// Builds a brand-new row scheduled at `scheduledDate`, off `template`
// (the rider's own most recently dated row). `riderParentId` is always
// this rider's series parent id — never copied off the template, which
// may itself BE the parent (recurring_parent_id null). When scheduledDate
// is a host date, hostWindow overrides window_start/window_end/
// technician_id so the rider actually joins the host's stop; otherwise the
// template's own window/tech carry over unchanged.
function buildRiderRowFromTemplate(template, scheduledDate, hostWindow, riderParentId) {
  const row = {};
  for (const field of TEMPLATE_COPY_FIELDS) {
    if (template[field] !== undefined) row[field] = template[field];
  }
  row.recurring_parent_id = riderParentId;
  row.scheduled_date = scheduledDate;
  row.status = 'pending';
  row.customer_confirmed = false;
  row.confirmed_at = null;
  row.window_start = hostWindow ? hostWindow.window_start : template.window_start;
  row.window_end = hostWindow ? hostWindow.window_end : template.window_end;
  row.technician_id = hostWindow ? hostWindow.technician_id : template.technician_id;
  return row;
}

// FAILS CLOSED: a read or insert failure here throws straight out (no
// try/catch) — a rider visit missing its billable add-ons is a silent
// under-bill, never an acceptable "logged and moved on" outcome. The
// caller runs the whole insert inside syncRiderSeries's savepoint, so the
// throw rolls back just this rider's sync (skipped: 'error'); the nightly
// reconcile retries.
async function copyAddonRows(trx, fromServiceId, toServiceId) {
  const rows = await trx('scheduled_service_addons').where({ scheduled_service_id: fromServiceId });
  if (!rows.length) return;
  const inserts = rows.map((r) => {
    const clone = { ...r };
    delete clone.id;
    delete clone.created_at;
    clone.scheduled_service_id = toServiceId;
    return clone;
  });
  await trx('scheduled_service_addons').insert(inserts);
}

/**
 * Reconciles ONE rider parent's future movable rows against its host.
 * No-op (returns { skipped: <reason> }) unless the rider has
 * rides_parent_id set and points at a real host series. Never sends any
 * customer communication: inserted/moved rows get their reminder rows from
 * the existing self-heal sweep (appointment-reminders.js
 * selfHealMissingReminderRows) or the silent-move DB trigger
 * (scheduled_services_sync_reminder) — the exact same mechanism every other
 * seeder-built or silently-moved row already relies on — never a fresh
 * confirmation text, and cancels go through transitionJobStatus with
 * notifyCustomer: 'caller_suppress'.
 *
 * @param {object} conn - a knex connection or an open transaction.
 * @param {string} riderParentId
 * @param {{dryRun?: boolean, source?: string}} [opts]
 * @returns {Promise<{skipped?: string, keep: Array, move: Array,
 *   insert: string[], cancel: Array}>}
 */
async function syncRiderSeries(conn, riderParentId, { dryRun = false, source = 'sync' } = {}) {
  const empty = () => ({ keep: [], move: [], insert: [], cancel: [] });
  const run = async (trx) => {
    const cols = await trx('scheduled_services').columnInfo();
    if (!cols.rides_parent_id) return { ...empty(), skipped: 'no_column' };

    const riderParentPeek = await trx('scheduled_services').where({ id: riderParentId }).first();
    if (!riderParentPeek || !riderParentPeek.rides_parent_id) return { ...empty(), skipped: 'not_a_rider' };
    const hostParentId = riderParentPeek.rides_parent_id;

    // Non-blocking, in this fixed order — see the module header for why a
    // blocking host-then-rider order is not achievable from every call
    // site, and why non-blocking makes that safe.
    if (!(await tryLockSeriesMaintenance(trx, hostParentId))) {
      return { ...empty(), skipped: 'host_locked' };
    }
    if (!(await tryLockSeriesMaintenance(trx, riderParentId))) {
      return { ...empty(), skipped: 'rider_locked' };
    }

    const riderParent = await trx('scheduled_services').where({ id: riderParentId }).first();
    const hostParent = await trx('scheduled_services').where({ id: hostParentId }).first();
    if (!riderParent || !riderParent.rides_parent_id) return { ...empty(), skipped: 'not_a_rider' };
    // TOCTOU: hostParentId was read from the pre-lock peek, before either
    // lock was held — a concurrent admin edit could repoint rides_parent_id
    // to a DIFFERENT host between that peek and here. Re-check the LOCKED
    // row rather than trusting the peek: a mismatch means we locked and are
    // about to read/write against the WRONG host. Never write on a stale
    // link — return and let the nightly reconcile (or the next in-band
    // trigger) pick up the fresh link with its own fresh locks.
    if (String(riderParent.rides_parent_id) !== String(hostParentId)) {
      logger.warn(`[rider-series] parent=${riderParentId} rides_parent_id changed between the pre-lock peek (${hostParentId}) and the locked read (${riderParent.rides_parent_id}) — deferring to the next sync`);
      return { ...empty(), skipped: 'host_changed' };
    }
    if (!hostParent) return { ...empty(), skipped: 'host_missing' };
    if (String(riderParent.customer_id) !== String(hostParent.customer_id)) {
      logger.warn(`[rider-series] parent=${riderParentId} rides_parent=${hostParentId} but the two series belong to different customers — refusing to sync`);
      return { ...empty(), skipped: 'cross_customer' };
    }

    await lockCustomerCommsIfKnown(trx, riderParent.customer_id);

    const todayStr = etDateString();

    const hostRows = await trx('scheduled_services')
      .where((q) => { q.where('id', hostParentId).orWhere('recurring_parent_id', hostParentId); })
      .whereNotIn('status', JOIN_INELIGIBLE_STATUSES)
      .where('scheduled_date', '>=', todayStr)
      .orderBy('scheduled_date', 'asc')
      .select('id', 'scheduled_date', 'window_start', 'window_end', 'technician_id');
    const hostByDate = new Map();
    for (const r of hostRows) {
      const d = dateOnly(r.scheduled_date);
      if (d && !hostByDate.has(d)) hostByDate.set(d, r);
    }
    const hostDates = Array.from(hostByDate.keys()).sort();

    const riderRows = await trx('scheduled_services')
      .where((q) => { q.where('id', riderParentId).orWhere('recurring_parent_id', riderParentId); })
      .select('*');
    const attributeImmovable = await immovableRowIdSet(trx, riderRows.map((r) => r.id));
    const nearTermCutoff = addDaysStr(todayStr, NEAR_TERM_DAYS);
    const isImmovable = (r) => immovableByOwnFields(r)
      || attributeImmovable.has(r.id)
      || (dateOnly(r.scheduled_date) != null && dateOnly(r.scheduled_date) <= nearTermCutoff);

    let lastRiderDate = null;
    for (const r of riderRows) {
      if (r.status === 'completed' || isImmovable(r)) {
        const d = dateOnly(r.scheduled_date);
        if (d && (!lastRiderDate || d > lastRiderDate)) lastRiderDate = d;
      }
    }
    // No completed/immovable row yet (a brand-new rider series) — the
    // parent's own scheduled_date is the only anchor available.
    if (!lastRiderDate) lastRiderDate = dateOnly(riderParent.scheduled_date);
    if (!lastRiderDate) return { ...empty(), skipped: 'no_anchor' };

    // Strictly AFTER the anchor (never >= it): the anchor is whatever row
    // realized lastRiderDate — a real completed/immovable row is already
    // excluded by the isImmovable/status checks below, but the FALLBACK
    // anchor (a brand-new series with no completed/immovable row yet, so
    // lastRiderDate === the rider parent's own still-pending date) would
    // otherwise treat that same anchor row as an unmatched movable row —
    // every planned date is by construction > the anchor, so the anchor's
    // own row could never match one and would be moved/cancelled on its
    // own sync (self-inflicted churn, and non-idempotent: the next sync
    // would then need to move it right back). Leaving it untouched is also
    // the conservative choice for any other row dated on/before the
    // anchor — the plan only concerns what comes after it.
    const movableRows = riderRows.filter((r) => (
      !JOIN_INELIGIBLE_STATUSES.includes(r.status)
      && r.status !== 'completed'
      && !isImmovable(r)
      && dateOnly(r.scheduled_date) >= todayStr
      && dateOnly(r.scheduled_date) > lastRiderDate
    ));

    let horizonDate;
    if (hostDates.length) {
      horizonDate = hostDates[hostDates.length - 1];
    } else {
      const { plannedVisitCountForPattern } = require('./recurring-appointment-seeder');
      const count = plannedVisitCountForPattern(riderParent.recurring_pattern, {});
      horizonDate = addDaysStr(lastRiderDate, count * TARGET_GAP_DAYS);
    }

    const plan = planRiderDates({
      hostDates,
      lastRiderDate,
      horizonDate,
      skipWeekends: !!riderParent.skip_weekends,
      weekendShift: riderParent.weekend_shift === 'back' ? 'back' : 'forward',
    });

    const movableByDate = new Map();
    for (const r of movableRows) {
      const d = dateOnly(r.scheduled_date);
      if (d) movableByDate.set(d, r);
    }
    const planSet = new Set(plan);

    const keep = [];
    const unmatchedPlanned = [];
    for (const d of plan) {
      const existing = movableByDate.get(d);
      if (existing) keep.push({ id: existing.id, date: d });
      else unmatchedPlanned.push(d);
    }
    const unmatchedMovable = movableRows
      .filter((r) => !planSet.has(dateOnly(r.scheduled_date)))
      .sort((a, b) => dateOnly(a.scheduled_date).localeCompare(dateOnly(b.scheduled_date)));

    const pairCount = Math.min(unmatchedMovable.length, unmatchedPlanned.length);
    const move = [];
    for (let i = 0; i < pairCount; i++) {
      const row = unmatchedMovable[i];
      const to = unmatchedPlanned[i];
      move.push({ id: row.id, from: dateOnly(row.scheduled_date), to });
    }
    const insertDates = unmatchedPlanned.slice(pairCount);
    const cancelRows = unmatchedMovable.slice(pairCount)
      .map((r) => ({ id: r.id, date: dateOnly(r.scheduled_date) }));

    const result = { keep, move, insert: insertDates, cancel: cancelRows };
    if (dryRun) return result;

    // Template row for a new insert: the most recently dated existing
    // rider row (parent or child, any status) carries the freshest
    // price/discount/service-identity/property snapshot; falls back to the
    // rider parent itself for a series with no children yet.
    const template = riderRows.reduce((best, r) => {
      if (!best) return r;
      return dateOnly(r.scheduled_date) > dateOnly(best.scheduled_date) ? r : best;
    }, null) || riderParent;

    for (const { id, to } of move) {
      const hostRow = hostByDate.get(to);
      const updates = { scheduled_date: to, updated_at: new Date() };
      if (hostRow) {
        updates.window_start = hostRow.window_start;
        updates.window_end = hostRow.window_end;
        updates.technician_id = hostRow.technician_id;
      }
      await trx('scheduled_services').where({ id }).update(updates);
      await maybeGroupRow(id, { database: trx, createdBy: 'seeder' });
    }

    const insertedRows = [];
    const { createScheduledService } = require('./booking/create-scheduled-service');
    for (const d of insertDates) {
      const hostRow = hostByDate.get(d);
      const rowData = buildRiderRowFromTemplate(template, d, hostRow || null, riderParentId);
      const inserted = await createScheduledService({
        trx, insertData: rowData, cols, source: { sourceAction: 'recurring_series_rider_sync' },
      });
      if (inserted) {
        await copyAddonRows(trx, template.id, inserted.id);
        await maybeGroupRow(inserted.id, { database: trx, createdBy: 'seeder' });
        insertedRows.push(inserted);
      }
    }

    for (const { id } of cancelRows) {
      const fresh = await trx('scheduled_services').where({ id }).first('status');
      if (!fresh || TERMINAL_ROW_STATUSES.includes(fresh.status)) continue;
      try {
        await transitionJobStatus({
          jobId: id,
          fromStatus: fresh.status,
          toStatus: 'cancelled',
          transitionedBy: null,
          notes: 'rider_resync',
          trx,
          notifyCustomer: 'caller_suppress',
          suppressTechNotice: true,
        });
      } catch (err) {
        logger.warn(`[rider-series] cancel of surplus rider row ${id} skipped (race or guard mismatch): ${err.message}`);
      }
    }

    logger.info(`[rider-series] synced parent=${riderParentId} rides=${hostParentId} source=${source} keep=${keep.length} move=${move.length} insert=${insertedRows.length} cancel=${cancelRows.length}`);
    return { ...result, insertedRows };
  };

  try {
    // ALWAYS goes through .transaction() — when `conn` is already an open
    // transaction (every in-band hook: a rider's own completion/top-up/
    // alert path, or a host's extend/seed hook), Knex makes this a SAVEPOINT
    // rather than a nested independent transaction (same idiom
    // visit-groups.js#maybeGroupRow uses for the identical reason): a
    // failure inside `run` rolls back only to the savepoint, never poisons
    // the caller's whole transaction (25P02) — "best-effort, never fails
    // the host/rider write it rides behind" would otherwise be false the
    // moment any query in here threw. A plain (non-transaction) `conn`
    // opens a real transaction as usual.
    return await conn.transaction(run);
  } catch (err) {
    logger.error(`[rider-series] syncRiderSeries failed for parent=${riderParentId}: ${err.message}`);
    return { ...empty(), skipped: 'error' };
  }
}

/**
 * Best-effort: sync every rider whose rides_parent_id points at
 * `hostParentId`. Called after a host series gains new future rows
 * (seeder seeding, auto-extend, top-up) — see the call sites in
 * recurring-appointment-seeder.js and routes/admin-schedule.js. Never
 * throws: a sync failure for one rider (or all of them) must never fail
 * the host write it rides behind.
 */
async function syncRidersOfHost(conn, hostParentId, opts = {}) {
  if (!hostParentId) return;
  try {
    const cols = await conn('scheduled_services').columnInfo();
    if (!cols.rides_parent_id) return;
    const riders = await conn('scheduled_services')
      .where({ rides_parent_id: hostParentId })
      .pluck('id');
    for (const riderId of riders) {
      await syncRiderSeries(conn, riderId, { ...opts, source: opts.source || 'host_extend' });
    }
  } catch (err) {
    logger.warn(`[rider-series] syncRidersOfHost failed for host=${hostParentId}: ${err.message}`);
  }
}

module.exports = {
  MIN_GAP_DAYS,
  TARGET_GAP_DAYS,
  MAX_WAIT_DAYS,
  NEAR_TERM_DAYS,
  planRiderDates,
  syncRiderSeries,
  syncRidersOfHost,
  _internals: { immovableByOwnFields, buildRiderRowFromTemplate, addDaysStr },
};
