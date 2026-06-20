const db = require('../models/db');
const RULES = require('../config/reschedule-rules');
const logger = require('./logger');
const { scheduledServiceTrackTokenExpiry } = require('./track-token-expiry');
const { clearTechCurrentJob } = require('./tech-status');
const { getIo } = require('../sockets');
const {
  parseETDateTime, etParts, etDateString, addETDays,
  addETMonthsByWeekday, etNthWeekdayOfMonth,
} = require('../utils/datetime-et');

const MONTH_RECURRENCE_INTERVALS = {
  monthly: 1, bimonthly: 2, quarterly: 3, triannual: 4,
  semiannual: 6, biannual: 6, annual: 12, yearly: 12,
};

const RESCHEDULABLE_STATUSES = new Set(['pending', 'confirmed', 'rescheduled']);

// Live lifecycle states a staff-initiated reschedule may override via
// options.allowLive (rain starts while en route, customer calls to push
// the visit while the tech is on site). Terminal states (completed /
// cancelled / skipped) stay non-reschedulable on every path.
const LIVE_OVERRIDE_STATUSES = new Set(['en_route', 'on_site']);

// Tracker-lifecycle rewind applied when a live job is force-rescheduled.
// track_state returns to 'scheduled' so En Route can fire again on the
// new day, track_sms_sent_at clears so the en-route SMS re-sends, and
// the arrival/start timestamps clear so duration capture on the new
// visit doesn't measure from the abandoned attempt (a stale arrived_at
// would make buildCompletionLifecycleUpdates compute a days-long
// service time).
const LIVE_LIFECYCLE_RESET = {
  track_state: 'scheduled',
  en_route_at: null,
  arrived_at: null,
  actual_start_time: null,
  check_in_time: null,
  track_sms_sent_at: null,
};

function recurrenceOrdinalOptions(baseDateStr, opts = {}) {
  const safe = baseDateStr ? String(baseDateStr).split('T')[0] : null;
  if (!safe) return opts;
  const base = parseETDateTime(safe + 'T12:00');
  if (isNaN(base.getTime())) return opts;
  const et = etParts(base);
  return {
    ...opts,
    nth: (opts.nth != null && opts.nth !== '' && !isNaN(parseInt(opts.nth)))
      ? parseInt(opts.nth)
      : Math.ceil(et.day / 7),
    weekday: (opts.weekday != null && opts.weekday !== '' && !isNaN(parseInt(opts.weekday)))
      ? parseInt(opts.weekday)
      : et.dayOfWeek,
  };
}

// ET-safe duplicate of nextRecurringDate (the original lives in
// server/routes/admin-schedule.js). Schedule dates are ET wall-clock
// strings — Railway runs TZ=UTC, so naive `new Date(s + 'T12:00:00')`
// math drifts at DST/midnight boundaries. Routed through datetime-et
// helpers here. Keep recurrence semantics in sync with the original.
function nextRecurringDate(baseDateStr, pattern, i, opts = {}) {
  const { nth, weekday, intervalDays } = opts;
  const safe = baseDateStr ? String(baseDateStr).split('T')[0] : null;
  if (!safe) return null;
  const base = parseETDateTime(safe + 'T12:00');
  if (isNaN(base.getTime())) return safe;
  const nthNum = (nth != null && nth !== '' && !isNaN(parseInt(nth))) ? parseInt(nth) : null;
  const wdayNum = (weekday != null && weekday !== '' && !isNaN(parseInt(weekday))) ? parseInt(weekday) : null;
  const intNum = (intervalDays != null && intervalDays !== '' && !isNaN(parseInt(intervalDays))) ? parseInt(intervalDays) : null;

  if (pattern === 'monthly_nth_weekday' && nthNum != null && wdayNum != null) {
    const baseEt = etParts(base);
    const totalMonths = (baseEt.month - 1) + i;
    const targetYear = baseEt.year + Math.floor(totalMonths / 12);
    const targetMonth1 = ((totalMonths % 12) + 12) % 12 + 1; // 1-12
    return etDateString(etNthWeekdayOfMonth(targetYear, targetMonth1, nthNum, wdayNum));
  }

  if (MONTH_RECURRENCE_INTERVALS[pattern]) {
    return etDateString(addETMonthsByWeekday(base, MONTH_RECURRENCE_INTERVALS[pattern] * i, opts));
  }

  const intervals = { daily: 1, weekly: 7, biweekly: 14 };
  let gap;
  if (pattern === 'custom' && intNum) gap = Math.max(1, intNum);
  else gap = intervals[pattern] || 91;
  return etDateString(addETDays(base, gap * i));
}

// Tell an open TrackPage (or customer portal) that a live job was
// rewound. The public tracker refetches on customer:job_update but only
// polls while en_route — an on_property viewer would otherwise sit on
// the stale "tech on site" screen until a manual refresh. Payload
// follows the strict customer-facing allowlist in job-status.js
// (job_id / status / eta / tech_id / tech_first_name / updated_at) —
// see the PII BOUNDARY block there before adding fields.
function emitCustomerJobRefresh(service, toStatus) {
  if (!service?.customer_id) return;
  const io = getIo();
  if (!io) {
    logger.warn('[rebooker] io not initialized; skipping customer refresh broadcast');
    return;
  }
  io.to(`customer:${service.customer_id}`).emit('customer:job_update', {
    job_id: service.id,
    status: toStatus,
    eta: null,
    tech_id: service.technician_id || null,
    tech_first_name: null,
    updated_at: new Date(),
  });
}

// Convert "08:00-09:00" → { start: '08:00', end: '09:00' }. Tolerates objects.
function parseWindow(w) {
  if (!w) return { start: null, end: null };
  if (typeof w === 'object') return { start: w.start || null, end: w.end || null };
  const m = String(w).match(/^(\d{1,2}:\d{2})-(\d{1,2}:\d{2})$/);
  if (!m) return { start: null, end: null };
  return { start: m[1], end: m[2] };
}

class SmartRebooker {
  async findRescheduleOptions(serviceId, reason) {
    const service = await db('scheduled_services')
      .where('scheduled_services.id', serviceId)
      .leftJoin('customers', 'scheduled_services.customer_id', 'customers.id')
      .select('scheduled_services.*', 'customers.first_name', 'customers.last_name',
        'customers.city', 'customers.zip', 'customers.waveguard_tier')
      .first();

    if (!service) throw new Error('Service not found');

    const options = [];
    const today = new Date();

    for (let d = 1; d <= 10; d++) {
      // ET calendar math — toISOString() reads the UTC date while displayDate
      // below formats in ET, so between 8 PM and midnight ET the customer would
      // see "Thu Jun 11" but the system would book Jun 12. Derive both from ET.
      const candidateDate = addETDays(today, d); // anchored at noon UTC on the ET calendar day

      const dateStr = etDateString(candidateDate);

      const dayLoad = await db('scheduled_services')
        .where('scheduled_date', dateStr)
        .whereIn('status', ['pending', 'confirmed'])
        .count('* as count').first();

      const nearbyServices = await db('scheduled_services')
        .where('scheduled_date', dateStr)
        .whereIn('status', ['pending', 'confirmed'])
        .leftJoin('customers', 'scheduled_services.customer_id', 'customers.id')
        .select('customers.zip', 'customers.city');

      const sameAreaCount = nearbyServices.filter(s =>
        s.zip === service.zip || (s.city || '').toLowerCase() === (service.city || '').toLowerCase()
      ).length;

      let score = 100;
      const load = parseInt(dayLoad.count);
      if (load > 8) score -= 30;
      else if (load > 6) score -= 15;
      else if (load > 4) score -= 5;

      score += sameAreaCount * 10; // Route density bonus
      score += Math.max(0, (8 - d)) * 5; // Sooner is better
      if (candidateDate.getDay() === new Date(service.scheduled_date).getDay()) score += 8; // Same day of week

      const window = this.findBestWindow(service);

      options.push({
        date: dateStr,
        dayOfWeek: candidateDate.toLocaleDateString('en-US', { weekday: 'long', timeZone: 'America/New_York' }),
        displayDate: candidateDate.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'America/New_York' }),
        currentLoad: load,
        sameAreaServices: sameAreaCount,
        suggestedWindow: window,
        score,
      });
    }

    options.sort((a, b) => b.score - a.score);
    return options.slice(0, 3);
  }

  findBestWindow(service) {
    const s = (service.service_type || '').toLowerCase();
    if (s.includes('lawn') || s.includes('mosquito')) return { start: '08:00', end: '10:00', display: '8:00-10:00 AM' };
    return { start: '09:00', end: '12:00', display: '9:00 AM-12:00 PM' };
  }

  async reschedule(serviceId, newDate, newWindow, reason, initiatedBy, options = {}) {
    const service = await db('scheduled_services').where({ id: serviceId }).first();
    if (!service) throw new Error('Service not found');
    const allowedStatuses = options.allowLive === true
      ? new Set([...RESCHEDULABLE_STATUSES, ...LIVE_OVERRIDE_STATUSES])
      : RESCHEDULABLE_STATUSES;
    if (!allowedStatuses.has(service.status)) {
      throw Object.assign(new Error(`Cannot reschedule a ${service.status} job`), {
        statusCode: 409,
      });
    }
    const wasLive = LIVE_OVERRIDE_STATUSES.has(service.status);

    // A past target date moves the job where no "upcoming" query will ever
    // find it — silently never serviced. Stale SMS replies and freeform
    // admin input both reach this path.
    const newDateStr = String(newDate || '').split('T')[0];
    if (!/^\d{4}-\d{2}-\d{2}$/.test(newDateStr) || newDateStr < etDateString()) {
      throw Object.assign(new Error('Reschedule target date is invalid or in the past'), {
        statusCode: 400,
        isOperational: true,
        code: 'INVALID_DATE',
      });
    }

    const originalDate = service.scheduled_date;
    const win = parseWindow(newWindow);
    const windowEnd = win.end || service.window_end;

    // Same-day target whose window already elapsed in ET is just as
    // unreachable as yesterday — a stale morning option accepted in the
    // afternoon would move the job into a past window.
    if (newDateStr === etDateString()) {
      const cutoff = windowEnd || win.start || service.window_start;
      if (cutoff) {
        const nowEt = etParts(new Date());
        const [ch, cm] = String(cutoff).split(':').map(Number);
        if (ch * 60 + (cm || 0) <= nowEt.hour * 60 + nowEt.minute) {
          throw Object.assign(new Error('That window has already passed today'), {
            statusCode: 409,
            isOperational: true,
            code: 'SLOT_TAKEN',
          });
        }
      }
    }
    const updates = {
      scheduled_date: newDate,
      window_start: win.start || service.window_start,
      window_end: windowEnd,
      status: 'confirmed',
      ...(wasLive ? LIVE_LIFECYCLE_RESET : {}),
    };
    if (Object.prototype.hasOwnProperty.call(options, 'technicianId')) {
      updates.technician_id = options.technicianId;
    }

    await db.transaction(async (trx) => {
      // The kept technician's route is real — writing 'confirmed' on top
      // of an overlapping job double-books them deterministically (the
      // customer picked from offers that never checked the route).
      const keptTechId = Object.prototype.hasOwnProperty.call(options, 'technicianId')
        ? options.technicianId
        : service.technician_id;
      if (keptTechId && updates.window_start && windowEnd) {
        await trx.raw(
          'SELECT pg_advisory_xact_lock(hashtext(?), hashtext(?::text))',
          ['slot-reserve', `${keptTechId}:${newDateStr}`],
        );
        const overlap = await trx('scheduled_services')
          .where('scheduled_date', newDateStr)
          .where('technician_id', keptTechId)
          .whereNot('id', serviceId)
          .whereNotIn('status', ['cancelled', 'completed'])
          // Expired estimate-slot holds are dead weight until cleanup
          // reclaims them — same active-reservation predicate
          // slot-reservation.js uses, so a lapsed hold can't block a
          // legitimate reschedule.
          .where((q) => {
            q.whereNull('reservation_expires_at')
              .orWhereRaw('reservation_expires_at > NOW()');
          })
          // COALESCE the nullable window_end (same predicate as
          // slot-reservation) — rows without an end time would otherwise
          // never register as conflicts.
          .whereRaw(
            "window_start < ?::time AND COALESCE(window_end, window_start + ((COALESCE(NULLIF(estimated_duration_minutes, 0), 60)::text || ' minutes')::interval)) > ?::time",
            [windowEnd, updates.window_start],
          )
          .first('id');
        if (overlap) {
          throw Object.assign(new Error('That window conflicts with another job on the technician\'s route'), {
            statusCode: 409,
            isOperational: true,
            code: 'SLOT_TAKEN',
          });
        }
      }

      const updated = await trx('scheduled_services')
        .where({ id: serviceId, status: service.status })
        .whereIn('status', Array.from(allowedStatuses))
        // Optional caller-supplied expected-state predicate (e.g. auto-dispatch
        // passing the locked/excluded flags + original date) so a concurrent
        // operator lock/move is caught atomically here, not just by a prior read.
        // .where({}) is a no-op, so callers that omit it are unaffected.
        .where(options.expect || {})
        .update({
          ...updates,
          track_token_expires_at: scheduledServiceTrackTokenExpiry(trx, newDate, windowEnd),
        });
      if (updated === 0) {
        throw Object.assign(new Error('Cannot reschedule — job transitioned to a non-reschedulable state concurrently'), {
          statusCode: 409,
        });
      }

      if (service.status !== 'confirmed') {
        await trx('job_status_history').insert({
          job_id: serviceId,
          from_status: service.status,
          to_status: 'confirmed',
          transitioned_by: null,
        });
      }

      await trx('reschedule_log').insert({
        scheduled_service_id: serviceId,
        customer_id: service.customer_id,
        original_date: originalDate,
        new_date: newDate,
        reason_code: reason,
        initiated_by: initiatedBy,
        original_window: service.window_start ? `${service.window_start}-${service.window_end}` : null,
        new_window: win.start ? `${win.start}-${win.end}` : null,
      });
    });

    // Live override post-commit cleanup:
    //   1. The tech's tech_status row still points at this job
    //      (en_route / on_site). Release it so the tech shows idle and
    //      the next job can claim them. Best-effort outside the trx —
    //      same pattern as track-transitions.markComplete; a failure
    //      here leaves a stale pointer, not inconsistent job state.
    //   2. A customer watching the public tracker would otherwise stay
    //      on the stale en-route / on-site screen — push the refresh.
    if (wasLive) {
      if (service.technician_id) {
        try {
          await clearTechCurrentJob({
            tech_id: service.technician_id,
            current_job_id: serviceId,
            status: 'idle',
          });
        } catch (err) {
          logger.error(`[rebooker] tech_status clear after live reschedule failed for ${serviceId}: ${err.message}`);
        }
      }
      emitCustomerJobRefresh({ ...service, ...updates, id: serviceId }, 'confirmed');
    }

    // Check escalation
    const count = await db('reschedule_log')
      .where({ scheduled_service_id: serviceId })
      .count('* as count').first();

    if (parseInt(count.count) >= RULES.escalation.max_auto_reschedules_per_service) {
      const customer = await db('customers').where({ id: service.customer_id }).first();
      logger.warn(`Service ${serviceId} for ${customer.first_name} ${customer.last_name} has been rescheduled ${count.count} times — needs manual review`);
      await db('reschedule_log').where({ scheduled_service_id: serviceId }).orderBy('created_at', 'desc').first()
        .then(log => log && db('reschedule_log').where({ id: log.id }).update({ escalated: true }));
    }

    return { success: true, originalDate, newDate };
  }

  // Reschedule the dropped occurrence AND every future sibling in the
  // recurring series. The dropped slot becomes the new anchor and every
  // later occurrence is recomputed from it via nextRecurringDate(),
  // so a quarterly series anchored on May 1 dragged to Apr 29 will
  // re-anchor at Apr 29 and shift the next occurrences accordingly.
  // Past + completed/cancelled rows are left untouched.
  //
  // All sibling updates + per-row job_status_history inserts + the
  // reschedule_log row run inside a single trx — either every row
  // shifts and is audited, or none do. We don't go through
  // transitionJobStatus per-sibling because that helper has a strict
  // fromStatus atomic guard meant for live single-job lifecycle
  // events; here we're sweeping a known set of rows we just SELECTed
  // inside the same trx, so a direct UPDATE + history INSERT keeps
  // the audit trail consistent without re-introducing racing checks
  // designed for a different access pattern.
  async rescheduleSeries(serviceId, newDate, newWindow, reason, initiatedBy, options = {}) {
    const service = await db('scheduled_services').where({ id: serviceId }).first();
    if (!service) throw new Error('Service not found');
    const allowedStatuses = options.allowLive === true
      ? new Set([...RESCHEDULABLE_STATUSES, ...LIVE_OVERRIDE_STATUSES])
      : RESCHEDULABLE_STATUSES;
    if (!allowedStatuses.has(service.status)) {
      // Strict callers (no allowLive) get pointed at the
      // single-occurrence path, which the admin route always overrides.
      const hint = LIVE_OVERRIDE_STATUSES.has(service.status)
        ? ' as a series — reschedule this appointment only, then adjust the series from the new date if needed'
        : '';
      throw Object.assign(new Error(`Cannot reschedule a ${service.status} job${hint}`), {
        statusCode: 409,
      });
    }
    // Only the ANCHOR may be live under allowLive — it's the job the
    // staffer is explicitly standing in front of (rain mid-visit, the
    // customer asking to push the cadence). Other live siblings are a
    // different visit actively in progress and stay untouched below.
    const wasLive = LIVE_OVERRIDE_STATUSES.has(service.status);

    const parentId = service.recurring_parent_id || service.id;
    const parent = await db('scheduled_services').where({ id: parentId }).first();
    if (!parent || (!parent.is_recurring && !parent.recurring_pattern)) {
      throw new Error('Service is not part of a recurring series');
    }

    const win = parseWindow(newWindow);

    // Same target validation as reschedule(): a past (or same-day elapsed)
    // anchor would shift the whole chain into dates no "upcoming" query
    // ever finds. Siblings shift forward of the anchor, so a valid anchor
    // keeps them valid.
    const seriesDateStr = String(newDate || '').split('T')[0];
    if (!/^\d{4}-\d{2}-\d{2}$/.test(seriesDateStr) || seriesDateStr < etDateString()) {
      throw Object.assign(new Error('Reschedule target date is invalid or in the past'), {
        statusCode: 400,
        isOperational: true,
        code: 'INVALID_DATE',
      });
    }
    if (seriesDateStr === etDateString()) {
      const cutoff = win.end || service.window_end || win.start || service.window_start;
      if (cutoff) {
        const nowEt = etParts(new Date());
        const [ch, cm] = String(cutoff).split(':').map(Number);
        if (ch * 60 + (cm || 0) <= nowEt.hour * 60 + nowEt.minute) {
          throw Object.assign(new Error('That window has already passed today'), {
            statusCode: 409,
            isOperational: true,
            code: 'SLOT_TAKEN',
          });
        }
      }
    }
    const pattern = parent.recurring_pattern;
    const isMonthBasedPattern = pattern === 'monthly_nth_weekday' || !!MONTH_RECURRENCE_INTERVALS[pattern];
    const opts = {
      ...(isMonthBasedPattern
        ? recurrenceOrdinalOptions(newDate)
        : {
            nth: parent.recurring_nth,
            weekday: parent.recurring_weekday,
          }),
      intervalDays: parent.recurring_interval_days,
    };

    // Live lifecycle states (en_route, on_site) and intentional drop-offs
    // (skipped) must NOT be steamrolled back to 'confirmed' by a series
    // shift — only pending + confirmed are safe to update. BUT we still
    // need to count them for cadence math: if a quarterly series has a
    // skipped occurrence between two confirmed ones, the next confirmed
    // sibling should land at the +2-quarter mark, not +1, otherwise the
    // recomputed date collides with the skipped one. So we fetch ALL
    // non-terminal siblings, index by their position in the ordered
    // list, and only UPDATE/audit the reschedulable ones.
    const TERMINAL = ['completed', 'cancelled'];
    const RESCHEDULABLE = RESCHEDULABLE_STATUSES;

    const occurrencesRescheduled = await db.transaction(async (trx) => {
      if (isMonthBasedPattern) {
        await trx('scheduled_services').where({ id: parentId }).update({
          recurring_nth: opts.nth,
          recurring_weekday: opts.weekday,
          updated_at: trx.fn.now(),
        });
      }

      const siblings = await trx('scheduled_services')
        .where(function () {
          this.where('id', parentId).orWhere('recurring_parent_id', parentId);
        })
        .where('scheduled_date', '>=', service.scheduled_date)
        .whereNotIn('status', TERMINAL)
        .orderBy('scheduled_date', 'asc')
        .select('id', 'status', 'scheduled_date', 'window_start', 'window_end');

      // Anchor cadence at the dropped service's position so siblings
      // before it (same-date ties) don't pull index 0 away from it.
      const droppedIdx = siblings.findIndex((s) => String(s.id) === String(serviceId));
      // Live-anchor race guard: between the outer service read and this
      // SELECT the anchor may have completed/cancelled (absent — the
      // terminal filter dropped it) or been marked skipped (present,
      // since 'skipped' is non-terminal for cadence math, but a no-show
      // drop that must NOT be revived to confirmed). Either way the
      // series must not shift, the tech must not be freed, and the
      // customer must not be notified — throw, rolling back the trx and
      // skipping the wasLive post-commit cleanup. A raced live→live
      // advance (en_route→on_site) or live→confirmed flip stays movable.
      if (wasLive) {
        const anchorRow = droppedIdx === -1 ? null : siblings[droppedIdx];
        const anchorStillMovable = !!anchorRow
          && (RESCHEDULABLE.has(anchorRow.status) || LIVE_OVERRIDE_STATUSES.has(anchorRow.status));
        if (!anchorStillMovable) {
          throw Object.assign(new Error('Cannot reschedule — job transitioned to a non-reschedulable state concurrently'), {
            statusCode: 409,
          });
        }
      }
      const startIdx = droppedIdx === -1 ? 0 : droppedIdx;

      const touched = [];
      for (let i = startIdx; i < siblings.length; i++) {
        const sib = siblings[i];
        // The live anchor (allowLive) moves like a single-job override;
        // every OTHER live/skipped row is still skipped — see the
        // cadence-math comment above.
        const isLiveAnchor = wasLive && String(sib.id) === String(serviceId);
        if (!RESCHEDULABLE.has(sib.status) && !isLiveAnchor) continue;

        const occurrenceIndex = i - startIdx;
        const date = occurrenceIndex === 0
          ? newDate
          : nextRecurringDate(newDate, parent.recurring_pattern, occurrenceIndex, opts);

        const updateData = {
          scheduled_date: date,
          window_start: win.start || sib.window_start,
          window_end: win.end || sib.window_end,
          status: 'confirmed',
          updated_at: trx.fn.now(),
          ...(isLiveAnchor ? LIVE_LIFECYCLE_RESET : {}),
        };
        updateData.track_token_expires_at = scheduledServiceTrackTokenExpiry(
          trx,
          date,
          updateData.window_end,
        );
        if (isMonthBasedPattern) {
          updateData.recurring_nth = opts.nth;
          updateData.recurring_weekday = opts.weekday;
        }

        const rowUpdate = trx('scheduled_services').where({ id: sib.id });
        if (isLiveAnchor) {
          // Atomic guard for the live anchor — same contract as the
          // single-job override: the tech can complete/cancel this job
          // between the sibling SELECT above and this UPDATE, and a
          // terminal row must not be steamrolled back to confirmed +
          // a rewound tracker. 0 rows updated → the whole series trx
          // rolls back (all-or-none).
          rowUpdate.where({ status: sib.status });
        }
        const updated = await rowUpdate.update(updateData);
        if (isLiveAnchor && updated === 0) {
          throw Object.assign(new Error('Cannot reschedule — job transitioned to a non-reschedulable state concurrently'), {
            statusCode: 409,
          });
        }

        if (sib.status !== 'confirmed') {
          // transitioned_by is a UUID FK to technicians; the route
          // currently passes the sentinel 'admin' string for
          // initiatedBy, which would violate the FK. Until we plumb
          // the real authenticated admin UUID, leave this null —
          // reschedule_log.initiated_by below preserves the 'admin'
          // sentinel for the action audit.
          await trx('job_status_history').insert({
            job_id: sib.id,
            from_status: sib.status,
            to_status: 'confirmed',
            transitioned_by: null,
          });
        }
        touched.push({
          id: sib.id,
          date,
          windowStart: win.start || sib.window_start,
          windowEnd: win.end || sib.window_end,
        });
      }

      await trx('reschedule_log').insert({
        scheduled_service_id: serviceId,
        customer_id: service.customer_id,
        original_date: service.scheduled_date,
        new_date: newDate,
        reason_code: `${reason}_series`,
        initiated_by: initiatedBy,
        original_window: service.window_start ? `${service.window_start}-${service.window_end}` : null,
        new_window: win.start ? `${win.start}-${win.end}` : null,
      });

      return touched;
    });

    // Live-anchor post-commit cleanup — same pattern as the single-job
    // override in reschedule(): free the tech_status pointer and push
    // the customer-tracker refresh so an open TrackPage doesn't sit on
    // the stale en-route / on-site screen.
    if (wasLive) {
      if (service.technician_id) {
        try {
          await clearTechCurrentJob({
            tech_id: service.technician_id,
            current_job_id: serviceId,
            status: 'idle',
          });
        } catch (err) {
          logger.error(`[rebooker] tech_status clear after live series reschedule failed for ${serviceId}: ${err.message}`);
        }
      }
      emitCustomerJobRefresh({ ...service, id: serviceId }, 'confirmed');
    }

    return {
      success: true,
      originalDate: service.scheduled_date,
      newDate,
      occurrencesRescheduled: occurrencesRescheduled.length,
      rescheduledOccurrences: occurrencesRescheduled,
    };
  }
}

module.exports = new SmartRebooker();
