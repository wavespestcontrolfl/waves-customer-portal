const db = require('../models/db');
const RULES = require('../config/reschedule-rules');
const logger = require('./logger');
const { parseETDateTime, etParts, etDateString, addETDays } = require('../utils/datetime-et');

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
    const firstDay = parseETDateTime(`${targetYear}-${String(targetMonth1).padStart(2, '0')}-01T12:00`);
    const firstW = etParts(firstDay).dayOfWeek;
    const offset = (wdayNum - firstW + 7) % 7;
    const dayOfMonth = 1 + offset + (nthNum - 1) * 7;
    return etDateString(addETDays(firstDay, dayOfMonth - 1));
  }

  const intervals = {
    daily: 1, weekly: 7, biweekly: 14, monthly: 30, bimonthly: 60,
    quarterly: 91, triannual: 122,
  };
  let gap;
  if (pattern === 'custom' && intNum) gap = Math.max(1, intNum);
  else gap = intervals[pattern] || 91;
  return etDateString(addETDays(base, gap * i));
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
      const candidateDate = new Date(today);
      candidateDate.setDate(today.getDate() + d);

      const dateStr = candidateDate.toISOString().split('T')[0];

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

  async reschedule(serviceId, newDate, newWindow, reason, initiatedBy) {
    const service = await db('scheduled_services').where({ id: serviceId }).first();
    if (!service) throw new Error('Service not found');

    const originalDate = service.scheduled_date;

    await db('scheduled_services').where({ id: serviceId }).update({
      scheduled_date: newDate,
      window_start: newWindow?.start || service.window_start,
      window_end: newWindow?.end || service.window_end,
      status: 'confirmed',
    });

    await db('reschedule_log').insert({
      scheduled_service_id: serviceId,
      customer_id: service.customer_id,
      original_date: originalDate,
      new_date: newDate,
      reason_code: reason,
      initiated_by: initiatedBy,
      original_window: service.window_start ? `${service.window_start}-${service.window_end}` : null,
      new_window: newWindow ? `${newWindow.start}-${newWindow.end}` : null,
    });

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
  // Past + completed/cancelled/rescheduled rows are left untouched.
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
  async rescheduleSeries(serviceId, newDate, newWindow, reason, initiatedBy) {
    const service = await db('scheduled_services').where({ id: serviceId }).first();
    if (!service) throw new Error('Service not found');

    const parentId = service.recurring_parent_id || service.id;
    const parent = await db('scheduled_services').where({ id: parentId }).first();
    if (!parent || (!parent.is_recurring && !parent.recurring_pattern)) {
      throw new Error('Service is not part of a recurring series');
    }

    const win = parseWindow(newWindow);
    const opts = {
      nth: parent.recurring_nth,
      weekday: parent.recurring_weekday,
      intervalDays: parent.recurring_interval_days,
    };

    // Only sweep siblings that are still reschedulable. Live lifecycle
    // states (en_route, on_site) and intentional drop-offs (skipped)
    // must NOT be steamrolled back to 'confirmed' by a series shift —
    // that would corrupt active dispatch state and the audit trail.
    // pending + confirmed are the only statuses where a future-date
    // shift is safe.
    const RESCHEDULABLE = ['pending', 'confirmed'];

    const occurrencesRescheduled = await db.transaction(async (trx) => {
      const siblings = await trx('scheduled_services')
        .where(function () {
          this.where('id', parentId).orWhere('recurring_parent_id', parentId);
        })
        .where('scheduled_date', '>=', service.scheduled_date)
        .whereIn('status', RESCHEDULABLE)
        .orderBy('scheduled_date', 'asc')
        .select('id', 'status', 'scheduled_date', 'window_start', 'window_end');

      for (let i = 0; i < siblings.length; i++) {
        const sib = siblings[i];
        const date = i === 0 ? newDate : nextRecurringDate(newDate, parent.recurring_pattern, i, opts);
        await trx('scheduled_services').where({ id: sib.id }).update({
          scheduled_date: date,
          window_start: win.start || sib.window_start,
          window_end: win.end || sib.window_end,
          status: 'confirmed',
          updated_at: trx.fn.now(),
        });

        if (sib.status !== 'confirmed') {
          await trx('job_status_history').insert({
            job_id: sib.id,
            from_status: sib.status,
            to_status: 'confirmed',
            transitioned_by: initiatedBy || null,
          });
        }
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

      return siblings.length;
    });

    return {
      success: true,
      originalDate: service.scheduled_date,
      newDate,
      occurrencesRescheduled,
    };
  }
}

module.exports = new SmartRebooker();
