/**
 * Tech rain-out flow — weather hits mid-route, the tech taps Rain Out,
 * picks where the visit (or the rest of today's route) goes, and the
 * customer gets a "we moved you" text they can adjust by reply.
 *
 * Design rule: the appointment NEVER goes unbooked. We move it first
 * (SmartRebooker.reschedule with allowLive — works from en_route /
 * on_site since PR #1555), then the SMS offers an adjustment:
 *   reply 1 → confirm (re-stamps the same slot)
 *   reply 2 → switch to the alternate option
 * Both replies are handled by the existing reschedule-sms webhook flow;
 * we feed it by writing option1/option2 into the reschedule_log row the
 * rebooker just created.
 *
 * Florida reality: storm cells roll in and roll back out, so the first
 * options offered are LATER TODAY (+2h / +4h), then SmartRebooker's
 * route-scored day options badged with NWS rain probabilities so the
 * tech doesn't reschedule into tomorrow's 65% thunderstorms.
 */

const db = require('../models/db');
const logger = require('./logger');
const SmartRebooker = require('./rebooker');
const { renderSmsTemplate } = require('./sms-template-renderer');
const { sendCustomerMessage } = require('./messaging/send-customer-message');
const { getDailyRainOutlook, forecastLinkForZip } = require('./weather-forecast');
const { etParts, etDateString } = require('../utils/datetime-et');
const { arrivalWindowRange, formatSmsTimeRange } = require('../utils/sms-time-format');

const WEATHER_PHRASES = {
  weather_rain: 'heavy rain',
  weather_wind: 'high winds',
  weather_lightning: 'lightning',
  weather_heat: 'extreme heat',
};

// Statuses a rain-out may move. Mirrors the rebooker's reschedulable +
// live-override sets; terminal rows are never touched.
const MOVABLE_STATUSES = ['pending', 'confirmed', 'rescheduled', 'en_route', 'on_site'];

// Same-day options stop offering starts after this ET hour — a slot
// starting later than 5 PM runs past a reasonable service day.
const LAST_SAME_DAY_START_HOUR = 17;
const SAME_DAY_OFFSETS_MINUTES = [120, 240];

// Reschedule slots are booked as a 1-hour, on-the-hour block — the internal
// job-duration window, matching how normal appointments are scheduled. The
// customer-facing 2-hour "arrival between" promise is derived separately from
// the start time (arrivalWindowRange in admin-dispatch.js), so a tight 1-hour
// internal block still texts the customer their usual leniency window. Rain-out
// used to offer 2-hour windows here, which drifted from the rest of the
// schedule; on-the-hour keeps dispatch times clean.
const RESCHEDULE_WINDOW_MINUTES = 60;

function pad2(n) {
  return String(n).padStart(2, '0');
}

function minutesToHHMM(totalMinutes) {
  const clamped = Math.max(0, Math.min(23 * 60 + 59, totalMinutes));
  return `${pad2(Math.floor(clamped / 60))}:${pad2(clamped % 60)}`;
}

function hhmmToMinutes(value) {
  const m = String(value || '').match(/^(\d{1,2}):(\d{2})/);
  if (!m) return null;
  return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
}

// Postgres TIME columns come back as 'HH:MM:SS'; the rest of the rain-out
// flow and the reminder/SMS helpers speak 'HH:MM'. Trim, preserving null.
function toHHMM(value) {
  if (value == null) return value;
  const m = String(value).match(/^(\d{1,2}):(\d{2})/);
  return m ? `${pad2(parseInt(m[1], 10))}:${m[2]}` : value;
}

function displayTime(hhmm) {
  const minutes = hhmmToMinutes(hhmm);
  if (minutes == null) return hhmm;
  const h = Math.floor(minutes / 60);
  const mm = minutes % 60;
  const h12 = h % 12 || 12;
  return `${h12}:${pad2(mm)} ${h >= 12 ? 'PM' : 'AM'}`;
}

function displayWindow(window) {
  if (!window?.start || !window?.end) return '';
  return `${displayTime(window.start)}-${displayTime(window.end)}`;
}

function displayDate(dateStr) {
  return new Date(`${String(dateStr).split('T')[0]}T12:00:00`)
    .toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'America/New_York' });
}

// Customer-facing option label. The slot is BOOKED as a tight 1-hour on-the-hour
// block (window.start→end drives scheduling/overlap), but the customer is always
// quoted the 2-hour arrival window from the start — the owner directive encoded
// in arrivalWindowRange. So the moved-SMS and reply text promise the usual
// leniency even though the internal slot is 1 hour. Falls back to the raw window
// only if the start can't be parsed into an arrival range.
function customerArrivalLabel(window) {
  const range = arrivalWindowRange(window?.start);
  return range ? formatSmsTimeRange(range) : displayWindow(window);
}

function customerArrivalOption(dateStr, window) {
  const label = customerArrivalLabel(window);
  return label ? `${displayDate(dateStr)}, ${label}` : displayDate(dateStr);
}

// Normalize a suggested start to an on-the-hour 1-hour block. The rebooker's
// findBestWindow returns 2-3h arrival-promise ranges shared with the SMS
// self-reschedule flow; rain-out books the tighter internal slot here without
// touching that shared helper. Falls back to a zero-length window if the start
// can't be parsed (day option renders its start with no end rather than crash).
function oneHourWindow(startHHMM) {
  const startMin = hhmmToMinutes(startHHMM);
  if (startMin == null) return { start: startHHMM, end: startHHMM };
  const onHour = Math.floor(startMin / 60) * 60;
  return {
    start: minutesToHHMM(onHour),
    end: minutesToHHMM(onHour + RESCHEDULE_WINDOW_MINUTES),
  };
}

async function loadServiceWithCustomer(serviceId) {
  return db('scheduled_services')
    .where('scheduled_services.id', serviceId)
    .leftJoin('customers', 'scheduled_services.customer_id', 'customers.id')
    .select(
      'scheduled_services.*',
      'customers.first_name',
      'customers.phone',
      'customers.zip',
      'customers.latitude as customer_latitude',
      'customers.longitude as customer_longitude',
      'customers.id as cust_id',
    )
    .first();
}

// Other not-yet-terminal jobs on this tech's plate today, ordered the
// way the route actually runs: COALESCE(route_order, 999) then window_start
// (the canonical dispatch order, admin-dispatch.js).
//
// `anchor` ({ route_order, window_start }) scopes "rest of route" to the
// anchor stop and everything AFTER it in that order — never an earlier
// stop. The tech sheet always anchors on the next stop, so this is a no-op
// there; but dispatch can rain-out an arbitrary mid-route stop, and a
// window-only bound would wrongly sweep stops that share the anchor's
// window or sit before it under a manual route_order.
async function remainingRouteJobs(technicianId, todayStr, excludeServiceId = null, anchor = null) {
  if (!technicianId) return [];
  const query = db('scheduled_services')
    .where({ technician_id: technicianId, scheduled_date: todayStr })
    .whereIn('status', MOVABLE_STATUSES)
    .orderByRaw('COALESCE(route_order, 999), window_start NULLS LAST')
    .select('id', 'status', 'scheduled_date', 'window_start', 'window_end', 'customer_id', 'service_type', 'route_order');
  if (excludeServiceId) query.whereNot('id', excludeServiceId);
  if (anchor) {
    const anchorOrder = anchor.route_order == null ? 999 : anchor.route_order;
    // window_start sorts NULLS LAST, so a null ("anytime") window is the
    // GREATEST time. Map nulls to 24:00:00 on both sides so an anytime stop
    // after the anchor stays in "rest of route", and a timed stop before an
    // anytime anchor stays out — consistent with the ORDER BY above.
    const anchorWindow = anchor.window_start || '24:00:00';
    query.whereRaw(
      "(COALESCE(route_order, 999), COALESCE(window_start, '24:00:00'::time)) >= (?::int, ?::time)",
      [anchorOrder, anchorWindow],
    );
  }
  return query;
}

// "Later today" candidates: now + 2h and now + 4h, snapped to the nearest
// hour, 1-hour on-the-hour windows, none starting after LAST_SAME_DAY_START_HOUR.
function sameDayOptions(now = new Date()) {
  const parts = etParts(now);
  const nowMinutes = parts.hour * 60 + parts.minute;
  const todayStr = etDateString(now);

  const options = [];
  for (const offset of SAME_DAY_OFFSETS_MINUTES) {
    // Snap to the nearest hour so same-day slots land on the hour like the
    // rest of the schedule; the 2h/4h offset keeps them safely in the future.
    const start = Math.round((nowMinutes + offset) / 60) * 60;
    if (start > LAST_SAME_DAY_START_HOUR * 60) continue;
    const window = {
      start: minutesToHHMM(start),
      end: minutesToHHMM(start + RESCHEDULE_WINDOW_MINUTES),
    };
    options.push({
      kind: 'same_day',
      date: todayStr,
      window,
      label: `Later today (+${offset / 60}h)`,
      display: `Today, ${displayWindow(window)}`,
    });
  }
  return options;
}

/**
 * Everything the tech sheet needs in one fetch: same-day windows,
 * route-scored day options with rain badges, the remaining-route count
 * for the scope toggle, and today's outlook for the header.
 */
async function getOptions(serviceId) {
  const service = await loadServiceWithCustomer(serviceId);
  if (!service) return { ok: false, reason: 'not_found' };

  const todayStr = etDateString();
  const sameDay = sameDayOptions();

  const dayOptionsRaw = await SmartRebooker.findRescheduleOptions(serviceId, 'weather_rain');

  // Rain badges — best effort, never blocking. Customer coords first,
  // falling back to nothing (options render without percentages).
  let outlook = null;
  try {
    outlook = await getDailyRainOutlook(service.customer_latitude, service.customer_longitude);
  } catch (err) {
    logger.info(`[rain-out] outlook lookup failed for ${serviceId}: ${err.message}`);
  }

  const days = (dayOptionsRaw || []).slice(0, 3).map((opt) => {
    // Book the tighter on-the-hour slot, but re-derive the display string from
    // it so the pill matches what actually gets scheduled (the rebooker's own
    // suggestedWindow.display is the wider 2-3h arrival range).
    const window = oneHourWindow(opt.suggestedWindow.start);
    return {
      kind: 'day',
      date: opt.date,
      window,
      display: `${opt.displayDate}, ${displayWindow(window)}`,
      rainChance: outlook?.[opt.date]?.rainChance ?? null,
      shortForecast: outlook?.[opt.date]?.shortForecast ?? null,
    };
  });

  const route = await remainingRouteJobs(service.technician_id, todayStr, serviceId, service);

  return {
    ok: true,
    service: {
      id: service.id,
      serviceType: service.service_type,
      status: service.status,
      scheduledDate: service.scheduled_date,
      window: { start: service.window_start, end: service.window_end },
      customerFirstName: service.first_name || null,
      hasPhone: !!service.phone,
    },
    today: {
      date: todayStr,
      rainChance: outlook?.[todayStr]?.rainChance ?? null,
      shortForecast: outlook?.[todayStr]?.shortForecast ?? null,
    },
    sameDay,
    days,
    remainingRouteCount: route.length,
  };
}

async function sendMovedSms({ job, customer, reasonCode, chosen, alt, serviceId }) {
  if (!customer?.phone) return { sent: false, reason: 'no_phone' };

  const altClause = alt
    ? ` Reply 1 to confirm, or 2 to switch to ${customerArrivalOption(alt.date, alt.window)}.`
    : ' Reply to this message if you need a different time.';
  const forecastLink = forecastLinkForZip(customer.zip);
  const forecastClause = forecastLink ? `\n\nYour local forecast: ${forecastLink}` : '';

  const body = await renderSmsTemplate('rain_out_moved', {
    first_name: customer.first_name || 'there',
    weather_phrase: WEATHER_PHRASES[reasonCode] || 'weather',
    service_type: (job.service_type || 'service').toLowerCase(),
    new_option: customerArrivalOption(chosen.date, chosen.window),
    alt_clause: altClause,
    forecast_clause: forecastClause,
  }, {
    workflow: 'tech_rain_out',
    entity_type: 'scheduled_service',
    entity_id: serviceId,
  });
  if (!body) {
    logger.warn(`[rain-out] rain_out_moved template missing/disabled — moved ${serviceId} without SMS`);
    return { sent: false, reason: 'missing_template' };
  }

  const result = await sendCustomerMessage({
    to: customer.phone,
    body,
    channel: 'sms',
    audience: 'customer',
    purpose: 'appointment',
    customerId: customer.id,
    identityTrustLevel: 'phone_matches_customer',
    metadata: { original_message_type: 'rain_out_moved', reason_code: reasonCode },
  });
  if (result?.blocked || result?.sent === false) {
    return { sent: false, reason: result.code || result.reason || 'blocked' };
  }
  return { sent: true };
}

// Wire the reply path: the rebooker's reschedule() just inserted a
// reschedule_log row for this move; write option1 (the chosen slot —
// reply 1 re-confirms) and option2 (the alternate) into its notes so
// the existing handleRescheduleReply webhook flow can act on 1/2.
// Windows carry `display` because the reply confirmation SMS renders
// selectedOption.window.display for its {time} variable. The reply window spans
// the full 2-hour arrival window the customer was quoted — start on the hour,
// end at the arrival-window end — NOT the tighter internal slot. If it stored
// the 1-hour end, a customer replying "1" during the back half of the promised
// window would be rejected by the rebooker's same-day elapsed check (cutoff =
// window end) and dropped to office follow-up, despite replying inside the
// window we texted them.
function replyWindow(window) {
  const arrival = arrivalWindowRange(window?.start);
  const end = (arrival && arrival.split('-')[1]) || window.end;
  return { start: window.start, end, display: customerArrivalLabel(window) };
}

async function attachReplyOptions(serviceJobId, chosen, alt) {
  const latest = await db('reschedule_log')
    .where({ scheduled_service_id: serviceJobId })
    .orderBy('created_at', 'desc')
    .first('id');
  if (!latest) return;
  await db('reschedule_log').where({ id: latest.id }).update({
    notes: JSON.stringify({
      option1: { date: chosen.date, window: replyWindow(chosen.window) },
      option2: alt ? { date: alt.date, window: replyWindow(alt.window) } : undefined,
    }),
  });
}

/**
 * Commit a rain-out.
 *
 * @param {object} args
 * @param {string} args.serviceId       the job the tech is acting on
 * @param {string} args.technicianId    acting tech (route scope filter)
 * @param {string} args.reasonCode      weather_rain | weather_wind | weather_lightning | weather_heat
 * @param {string} args.scope           'job' | 'route' (this job + the rest of today's route)
 * @param {object} args.target          { date, window: {start, end} } — the ANCHOR books exactly
 *                                       this window (what the tech saw). On a same-day route push
 *                                       the siblings shift by the anchor's window delta so stop
 *                                       order survives; day moves keep each sibling's own window.
 * @param {object} [args.alt]           alternate option offered in the SMS ({ date, window })
 * @param {boolean} [args.notifyCustomer=true]
 * @param {string} [args.initiatedBy='tech']  actor recorded on each reschedule
 *                                            for the audit log — 'admin' from the
 *                                            dispatch board, 'tech' from the app.
 */
async function commit({ serviceId, technicianId, reasonCode, scope, target, alt, notifyCustomer = true, initiatedBy = 'tech' }) {
  const service = await loadServiceWithCustomer(serviceId);
  if (!service) return { ok: false, reason: 'not_found' };
  if (!WEATHER_PHRASES[reasonCode]) return { ok: false, reason: 'bad_reason' };
  if (!target?.date || !target.window?.start || !target.window?.end) {
    return { ok: false, reason: 'bad_target' };
  }

  const todayStr = etDateString();
  let jobs;
  if (scope === 'route') {
    const rest = await remainingRouteJobs(technicianId, todayStr, serviceId, service);
    jobs = [service, ...rest];
  } else {
    jobs = [service];
  }

  // Same-day route push: the anchor books exactly target.window (what
  // the tech saw in the sheet); siblings shift by the anchor's window
  // delta so the route's running order survives. "Same day" compares
  // against the ANCHOR's scheduled date (not the wall clock) — a push
  // is same-day when the jobs stay on the date they were already on.
  // Falls back to 0 (keep own windows) when the anchor has no
  // parseable window.
  const anchorDateStr = service.scheduled_date
    ? String(service.scheduled_date instanceof Date
        ? service.scheduled_date.toISOString()
        : service.scheduled_date).slice(0, 10)
    : todayStr;
  const isSameDay = String(target.date) === anchorDateStr;
  const anchorStartMin = hhmmToMinutes(service.window_start);
  const targetStartMin = hhmmToMinutes(target.window.start);
  const siblingDelta = (isSameDay && anchorStartMin != null && targetStartMin != null)
    ? targetStartMin - anchorStartMin
    : 0;

  // Same-day forward pushes (positive delta) must move tail-first: the rebooker
  // checks the anchor's new window against the not-yet-moved next stop, so
  // moving the anchor first would SLOT_TAKEN against a sibling about to vacate
  // that slot. Process later stops first so each target window is already clear.
  // A backward pull (custom time earlier than the anchor — negative delta) is
  // the mirror image: process head-first (anchor first) so each stop vacates its
  // old slot before the next, earlier-shifted stop claims it. Day moves land on
  // a different (empty) date — order doesn't matter, and keeping anchor-first
  // there fires its reply-alt SMS first.
  const orderedJobs = (isSameDay && siblingDelta > 0) ? [...jobs].reverse() : jobs;
  const results = [];
  for (const job of orderedJobs) {
    let newWindow;
    if (job.id === serviceId) {
      newWindow = target.window;
    } else if (isSameDay) {
      const startMin = hhmmToMinutes(job.window_start);
      const endMin = hhmmToMinutes(job.window_end);
      newWindow = (startMin != null && endMin != null)
        ? { start: minutesToHHMM(startMin + siblingDelta), end: minutesToHHMM(endMin + siblingDelta) }
        : target.window;
    } else {
      // Day move for the rest of the route: same new date, keep each
      // job's own window so the route's running order survives. DB TIME
      // values are 'HH:MM:SS'; trim to 'HH:MM' so the downstream reminder
      // helper (normalizeHHMM is strict) doesn't reject them and re-arm the
      // reminder to a default time.
      newWindow = { start: toHHMM(job.window_start), end: toHHMM(job.window_end) };
    }

    try {
      await SmartRebooker.reschedule(job.id, target.date, newWindow, reasonCode, initiatedBy, { allowLive: true });
    } catch (err) {
      // One job racing to completed/cancelled must not strand the rest
      // of a bulk rain-out — record and continue.
      logger.warn(`[rain-out] reschedule failed for ${job.id}: ${err.message}`);
      results.push({ id: job.id, ok: false, error: err.message, statusCode: err.statusCode || 500 });
      continue;
    }

    // The move is COMMITTED past this point. Notification problems —
    // a throwing provider/audit wrapper, a reply-option write failure —
    // must never mark the job failed, or the tech retries and
    // double-reschedules / double-texts an already-moved appointment.
    const chosen = { date: target.date, window: newWindow };
    let sms = { sent: false, reason: 'not_requested' };
    if (notifyCustomer) {
      try {
        const customer = job.id === serviceId
          ? { id: service.cust_id || service.customer_id, phone: service.phone, first_name: service.first_name, zip: service.zip }
          : await db('customers').where({ id: job.customer_id }).first('id', 'phone', 'first_name', 'zip');
        sms = await sendMovedSms({ job, customer, reasonCode, chosen, alt: job.id === serviceId ? alt : null, serviceId: job.id });
        if (sms.sent && job.id === serviceId && alt) {
          await attachReplyOptions(job.id, chosen, alt);
        }
      } catch (err) {
        logger.warn(`[rain-out] post-move notification failed for ${job.id}: ${err.message}`);
        sms = { sent: false, reason: err.message };
      }
    }

    results.push({ id: job.id, ok: true, newDate: target.date, newWindow, smsSent: sms.sent, smsReason: sms.sent ? null : sms.reason });
  }

  const moved = results.filter((r) => r.ok);
  return {
    ok: moved.length > 0,
    reason: moved.length === 0 ? (results[0]?.error || 'nothing_moved') : undefined,
    movedCount: moved.length,
    failedCount: results.length - moved.length,
    results,
  };
}

module.exports = {
  getOptions,
  commit,
  _test: { sameDayOptions, customerArrivalOption, minutesToHHMM, hhmmToMinutes, WEATHER_PHRASES },
};
