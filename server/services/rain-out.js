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

const WEATHER_PHRASES = {
  weather_rain: 'heavy rain',
  weather_wind: 'high winds',
  weather_lightning: 'lightning',
  weather_heat: 'extreme heat',
};

// Statuses a rain-out may move. Mirrors the rebooker's reschedulable +
// live-override sets; terminal rows are never touched.
const MOVABLE_STATUSES = ['pending', 'confirmed', 'rescheduled', 'en_route', 'on_site'];

// Same-day options stop offering starts after this ET hour — a 2-hour
// window starting later than 5 PM runs past a reasonable service day.
const LAST_SAME_DAY_START_HOUR = 17;
const SAME_DAY_OFFSETS_MINUTES = [120, 240];
const SAME_DAY_WINDOW_MINUTES = 120;

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

function displayOption(dateStr, window) {
  const win = displayWindow(window);
  return win ? `${displayDate(dateStr)}, ${win}` : displayDate(dateStr);
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
// way the route runs. Used for the "rest of route" scope.
async function remainingRouteJobs(technicianId, todayStr, excludeServiceId = null) {
  if (!technicianId) return [];
  const query = db('scheduled_services')
    .where({ technician_id: technicianId, scheduled_date: todayStr })
    .whereIn('status', MOVABLE_STATUSES)
    .orderBy('window_start', 'asc')
    .select('id', 'status', 'scheduled_date', 'window_start', 'window_end', 'customer_id', 'service_type');
  if (excludeServiceId) query.whereNot('id', excludeServiceId);
  return query;
}

// "Later today" candidates: now + 2h and now + 4h, rounded up to the
// half hour, 2-hour windows, none starting after LAST_SAME_DAY_START_HOUR.
function sameDayOptions(now = new Date()) {
  const parts = etParts(now);
  const nowMinutes = parts.hour * 60 + parts.minute;
  const todayStr = etDateString(now);

  const options = [];
  for (const offset of SAME_DAY_OFFSETS_MINUTES) {
    const start = Math.ceil((nowMinutes + offset) / 30) * 30;
    if (start > LAST_SAME_DAY_START_HOUR * 60) continue;
    const window = {
      start: minutesToHHMM(start),
      end: minutesToHHMM(start + SAME_DAY_WINDOW_MINUTES),
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

  const days = (dayOptionsRaw || []).slice(0, 3).map((opt) => ({
    kind: 'day',
    date: opt.date,
    window: { start: opt.suggestedWindow.start, end: opt.suggestedWindow.end },
    display: `${opt.displayDate}, ${opt.suggestedWindow.display}`,
    rainChance: outlook?.[opt.date]?.rainChance ?? null,
    shortForecast: outlook?.[opt.date]?.shortForecast ?? null,
  }));

  const route = await remainingRouteJobs(service.technician_id, todayStr, serviceId);

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
    ? ` Reply 1 to confirm, or 2 to switch to ${displayOption(alt.date, alt.window)}.`
    : ' Reply to this message if you need a different time.';
  const forecastLink = forecastLinkForZip(customer.zip);
  const forecastClause = forecastLink ? `\n\nYour local forecast: ${forecastLink}` : '';

  const body = await renderSmsTemplate('rain_out_moved', {
    first_name: customer.first_name || 'there',
    weather_phrase: WEATHER_PHRASES[reasonCode] || 'weather',
    service_type: (job.service_type || 'service').toLowerCase(),
    new_option: displayOption(chosen.date, chosen.window),
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
async function attachReplyOptions(serviceJobId, chosen, alt) {
  const latest = await db('reschedule_log')
    .where({ scheduled_service_id: serviceJobId })
    .orderBy('created_at', 'desc')
    .first('id');
  if (!latest) return;
  await db('reschedule_log').where({ id: latest.id }).update({
    notes: JSON.stringify({
      option1: { date: chosen.date, window: chosen.window },
      option2: alt ? { date: alt.date, window: alt.window } : undefined,
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
 * @param {object} args.target          { date, window: {start, end}, deltaMinutes? }
 *                                       deltaMinutes (same-day) shifts each job's OWN window;
 *                                       day moves keep each job's own window on the new date.
 * @param {object} [args.alt]           alternate option offered in the SMS ({ date, window })
 * @param {boolean} [args.notifyCustomer=true]
 */
async function commit({ serviceId, technicianId, reasonCode, scope, target, alt, notifyCustomer = true }) {
  const service = await loadServiceWithCustomer(serviceId);
  if (!service) return { ok: false, reason: 'not_found' };
  if (!WEATHER_PHRASES[reasonCode]) return { ok: false, reason: 'bad_reason' };
  if (!target?.date || (!target.window && target.deltaMinutes == null)) {
    return { ok: false, reason: 'bad_target' };
  }

  const todayStr = etDateString();
  let jobs;
  if (scope === 'route') {
    const rest = await remainingRouteJobs(technicianId, todayStr, serviceId);
    jobs = [service, ...rest];
  } else {
    jobs = [service];
  }

  const isSameDayShift = target.deltaMinutes != null;
  const results = [];
  for (const job of jobs) {
    let newWindow;
    if (isSameDayShift) {
      const startMin = hhmmToMinutes(job.window_start);
      const endMin = hhmmToMinutes(job.window_end);
      newWindow = {
        start: startMin != null ? minutesToHHMM(startMin + target.deltaMinutes) : target.window?.start,
        end: endMin != null ? minutesToHHMM(endMin + target.deltaMinutes) : target.window?.end,
      };
    } else if (scope === 'route' && job.id !== serviceId) {
      // Day move for the rest of the route: same new date, keep each
      // job's own window so the route's running order survives.
      newWindow = { start: job.window_start, end: job.window_end };
    } else {
      newWindow = target.window;
    }

    try {
      await SmartRebooker.reschedule(job.id, target.date, newWindow, reasonCode, 'tech', { allowLive: true });

      const chosen = { date: target.date, window: newWindow };
      let sms = { sent: false, reason: 'not_requested' };
      if (notifyCustomer) {
        const customer = job.id === serviceId
          ? { id: service.cust_id || service.customer_id, phone: service.phone, first_name: service.first_name, zip: service.zip }
          : await db('customers').where({ id: job.customer_id }).first('id', 'phone', 'first_name', 'zip');
        sms = await sendMovedSms({ job, customer, reasonCode, chosen, alt: job.id === serviceId ? alt : null, serviceId: job.id });
        if (sms.sent && job.id === serviceId && alt) {
          await attachReplyOptions(job.id, chosen, alt);
        }
      }

      results.push({ id: job.id, ok: true, newDate: target.date, newWindow, smsSent: sms.sent, smsReason: sms.sent ? null : sms.reason });
    } catch (err) {
      // One job racing to completed/cancelled must not strand the rest
      // of a bulk rain-out — record and continue.
      logger.warn(`[rain-out] reschedule failed for ${job.id}: ${err.message}`);
      results.push({ id: job.id, ok: false, error: err.message, statusCode: err.statusCode || 500 });
    }
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
  _test: { sameDayOptions, displayOption, minutesToHHMM, hhmmToMinutes, WEATHER_PHRASES },
};
