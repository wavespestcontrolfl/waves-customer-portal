/**
 * Tech rain-out flow — weather hits mid-route, the tech taps Rain Out,
 * picks where the visit (or the rest of today's route) goes, and the
 * customer gets a "we moved you" text.
 *
 * Design rule: the appointment NEVER goes unbooked. We move it first
 * (SmartRebooker.reschedule with allowLive — works from en_route /
 * on_site since PR #1555). The new slot is already booked, so the SMS
 * asks for nothing: if the time works the customer does nothing, and if
 * it doesn't they self-serve on the tokenized /reschedule/:token page —
 * the same link the 72h/24h reminders send. (The old reply-1/reply-2
 * flow is gone; replies to previously-sent texts still resolve via
 * reschedule-sms from their own reschedule_log rows.)
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
const { isRealProviderSend } = require('./sms-auto-send');
const { buildRescheduleLink } = require('./reschedule-link');
const { getDailyRainOutlook, getHourlyRainOutlook, forecastLinkForZip } = require('./weather-forecast');
const { etParts, etDateString } = require('../utils/datetime-et');
const { arrivalWindowRange, formatSmsTimeRange, ARRIVAL_WINDOW_MINUTES } = require('../utils/sms-time-format');

const WEATHER_PHRASES = {
  weather_rain: 'heavy rain',
  weather_wind: 'high winds',
  weather_lightning: 'lightning',
  weather_heat: 'extreme heat',
};

// Customer-facing lead for the moved SMS, grounded in what we actually know
// instead of a fixed "heavy rain rolled through" claim (owner call,
// 2026-07-18). A same-day push means the tech is standing in the weather —
// present tense. A day move quotes today's NWS chance when we have one, and
// degrades to an honest generic when we don't (NWS is fail-open). Non-rain
// reasons state the real operational constraint rather than a weather label.
function composeWeatherLead({ reasonCode, isSameDay, hour, todayChance }) {
  if (reasonCode === 'weather_wind') return 'winds are too high to spray safely today';
  if (reasonCode === 'weather_lightning') return "there's lightning in the area";
  if (reasonCode === 'weather_heat') return "today's heat is too extreme to treat safely";
  if (isSameDay) {
    const partOfDay = hour < 12 ? 'morning' : (hour < 17 ? 'afternoon' : 'evening');
    return `rain is moving through your area this ${partOfDay}`;
  }
  if (todayChance != null && todayChance >= 60) return `storms are likely today (${todayChance}% chance)`;
  if (todayChance != null && todayChance >= 30) return `rain is in today's forecast (${todayChance}% chance)`;
  return "the weather isn't cooperating today";
}

const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

// 'Tomorrow' when the chosen date is literally tomorrow, else the weekday
// name. Date-only strings are anchored at UTC noon so the weekday can't
// slip a day in either hemisphere of a DST change.
function dayLabel(dateStr, todayStr) {
  const chosen = new Date(`${dateStr}T12:00:00Z`);
  if (Number.isNaN(chosen.getTime())) return null;
  const tomorrow = new Date(`${todayStr}T12:00:00Z`);
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
  if (tomorrow.toISOString().slice(0, 10) === String(dateStr)) return 'Tomorrow';
  return WEEKDAY_NAMES[chosen.getUTCDay()];
}

function partOfDay(hour) {
  return hour < 12 ? 'morning' : (hour < 17 ? 'afternoon' : 'evening');
}

// Max precip chance across the customer-facing arrival window from NWS
// hourly periods — every hour the window touches, so a half-hour start
// like 11:30 samples 11, 12 AND 13 (understating the last hour let the
// SMS claim "looks better" into a stormy period). Null when the hourly
// feed has no coverage for those hours — callers fall back to the
// day-level number.
function windowRainChance(hours, dateStr, windowStartHHMM) {
  if (!Array.isArray(hours)) return null;
  const startMinutes = hhmmToMinutes(windowStartHHMM);
  if (startMinutes == null) return null;
  const firstHour = Math.floor(startMinutes / 60);
  const lastHour = Math.floor((startMinutes + ARRIVAL_WINDOW_MINUTES - 1) / 60);
  const wanted = [];
  for (let h = firstHour; h <= lastHour; h += 1) wanted.push(h);
  let max = null;
  for (const period of hours) {
    const start = String(period?.startTime || '');
    if (start.slice(0, 10) !== String(dateStr)) continue;
    const hour = parseInt(start.slice(11, 13), 10);
    if (!wanted.includes(hour) || period.rainChance == null) continue;
    if (max == null || period.rainChance > max) max = period.rainChance;
  }
  return max;
}

// " Tomorrow morning looks a lot better — just a 10% chance of rain around
// your new time." Only claims what the forecast supports. Preferred source
// is the HOURLY chance scored on the actual booked arrival window (that's
// what lets us say morning vs afternoon, and lets a same-day push say
// "later today"); day-level chance is the fallback. Thresholds: window
// claims need ≤40% (≤30% same-day — same storm system, be conservative)
// and, when today's number is known, today ≥20 points worse. Always
// "looks better", never a dry-weather promise.
function composeBetterDayClause({
  reasonCode, isSameDay, chosenDate, todayStr, todayChance, newChance, windowChance, windowStart,
}) {
  if (reasonCode !== 'weather_rain' && reasonCode !== 'weather_lightning') return '';

  if (windowChance != null) {
    const cap = isSameDay ? 30 : 40;
    if (windowChance > cap) return '';
    if (todayChance != null && todayChance - windowChance < 20) return '';
    const day = isSameDay ? null : dayLabel(chosenDate, todayStr);
    if (!isSameDay && !day) return '';
    const startHour = Math.floor((hhmmToMinutes(windowStart) ?? 0) / 60);
    const label = isSameDay ? 'Later today' : `${day} ${partOfDay(startHour)}`;
    return windowChance <= 20
      ? ` ${label} looks a lot better — just a ${windowChance}% chance of rain around your new time.`
      : ` ${label} looks better — a ${windowChance}% chance of rain around your new time.`;
  }

  if (isSameDay || newChance == null || newChance > 40) return '';
  if (todayChance != null && todayChance - newChance < 20) return '';
  const label = dayLabel(chosenDate, todayStr);
  if (!label) return '';
  return newChance <= 20
    ? ` ${label} looks a lot better — just a ${newChance}% chance of rain.`
    : ` ${label} looks better — a ${newChance}% chance of rain.`;
}

// Explains WHY rain moves a spray visit. Dark until the owner flips
// GATE_RAINOUT_EFFICACY_NOTE; skipped for work rain doesn't wash away.
const EFFICACY_EXEMPT_SERVICE = /interior|granular|termite|wdo|inspection|bait/i;
function composeEfficacyClause({ reasonCode, serviceType }) {
  if (process.env.GATE_RAINOUT_EFFICACY_NOTE !== 'true') return '';
  if (reasonCode !== 'weather_rain') return '';
  if (EFFICACY_EXEMPT_SERVICE.test(String(serviceType || ''))) return '';
  return '\n\nWhy the move? Treatments need a few rain-free hours to bond — applying right before rain washes them away before they can work.';
}

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
    .select(
      'id', 'status', 'scheduled_date', 'window_start', 'window_end', 'customer_id', 'service_type', 'route_order',
      // Stamped service-address fields feed the moved-SMS forecast copy.
      'lat', 'lng', 'service_address_zip',
    );
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
  // Owner blackout: when TODAY is blocked, the "later today" choices must
  // not be offered (findRescheduleOptions covers tomorrow onward; same-day
  // candidates are built here). Fail-open helper.
  const { isBlackoutDate } = require('./scheduling/blackout-dates');
  const sameDay = (await isBlackoutDate(todayStr)) ? [] : sameDayOptions();

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

// Forecast decoration gets this long per stop before the SMS goes out
// without it — the copy is optional, the tech's response is not.
const FORECAST_DECORATION_TIMEOUT_MS = 1500;

async function sendMovedSms({ job, customer, reasonCode, chosen, serviceId, forecastHealth = { degraded: false } }) {
  if (!customer?.phone) return { sent: false, reason: 'no_phone' };

  // Moved-first means the new slot is already booked — no confirmation
  // reply to ask for. Adjustments self-serve through the same tokenized
  // /reschedule link the 72h/24h reminders send.
  const { url: rescheduleUrl } = await buildRescheduleLink(serviceId, { customerId: customer.id });
  const altClause = rescheduleUrl
    ? ` Need a different time? Reschedule online: ${rescheduleUrl}`
    : ' Need a different time? Reply to this message.';
  // Stamped service-address coordinates/zip beat the customer profile —
  // same precedence as track-transitions and gps-arrival-detector — so a
  // rain-out at a secondary property quotes THAT address's forecast.
  const lat = job.lat ?? customer.latitude;
  const lng = job.lng ?? customer.longitude;
  const zip = job.service_address_zip || customer.zip;

  const forecastLink = forecastLinkForZip(zip);
  const forecastClause = forecastLink ? `\n\nYour local forecast: ${forecastLink}` : '';

  // Forecast decoration is fail-open (same rule as the options sheet):
  // any NWS problem renders the generic lead, never blocks the SMS.
  // Daily gives the lead its today-number; hourly scores the actual
  // booked arrival window so the better-day clause can say morning vs
  // afternoon. Fetched in parallel, capped by the per-commit decoration
  // budget: one slow pair marks the whole rain-out degraded so a
  // route-scope move never queues per-stop NWS waits in front of the
  // tech's response (the grid cache makes healthy repeats instant).
  const todayStr = etDateString();
  const isSameDay = String(chosen.date) === todayStr;
  let outlook = null;
  let hourly = null;
  if (lat != null && lng != null && !forecastHealth.degraded) {
    const fetched = await Promise.race([
      Promise.all([
        getDailyRainOutlook(lat, lng).catch(() => null),
        getHourlyRainOutlook(lat, lng).catch(() => null),
      ]),
      new Promise((resolve) => { setTimeout(resolve, FORECAST_DECORATION_TIMEOUT_MS).unref?.(); }),
    ]);
    if (fetched) {
      [outlook, hourly] = fetched;
    } else {
      forecastHealth.degraded = true;
    }
  }
  const todayChance = outlook?.[todayStr]?.rainChance ?? null;
  const newChance = outlook?.[String(chosen.date)]?.rainChance ?? null;
  const windowChance = windowRainChance(hourly, String(chosen.date), chosen.window?.start);

  const sharedVars = {
    first_name: customer.first_name || 'there',
    service_type: (job.service_type || 'service').toLowerCase(),
    new_option: customerArrivalOption(chosen.date, chosen.window),
    alt_clause: altClause,
    forecast_clause: forecastClause,
  };
  const renderContext = {
    workflow: 'tech_rain_out',
    entity_type: 'scheduled_service',
    entity_id: serviceId,
  };

  // rain_out_moved_v2 is the forecast-grounded template this PR's
  // migration seeds; the legacy rain_out_moved row stays untouched so an
  // older server (or a rolled-back deploy) keeps rendering it. The legacy
  // fallback fires ONLY when the v2 ROW is absent (a rolled-back
  // migration) — an existing-but-disabled v2 row is the ops kill switch
  // and must stop the send, not reroute it to old copy. The legacy row
  // is retired in the cleanup PR once this deploy is verified.
  let body = await renderSmsTemplate('rain_out_moved_v2', {
    ...sharedVars,
    weather_lead: composeWeatherLead({ reasonCode, isSameDay, hour: etParts().hour, todayChance }),
    better_day_clause: composeBetterDayClause({
      reasonCode, isSameDay, chosenDate: String(chosen.date), todayStr, todayChance, newChance,
      windowChance, windowStart: chosen.window?.start,
    }),
    efficacy_clause: composeEfficacyClause({ reasonCode, serviceType: job.service_type }),
  }, renderContext);
  if (!body) {
    const v2Row = await db('sms_templates').where({ template_key: 'rain_out_moved_v2' }).first('id');
    if (!v2Row) {
      body = await renderSmsTemplate('rain_out_moved', {
        ...sharedVars,
        weather_phrase: WEATHER_PHRASES[reasonCode] || 'weather',
      }, renderContext);
    }
  }
  if (!body) {
    logger.warn(`[rain-out] rain-out template missing/disabled — moved ${serviceId} without SMS`);
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
    // original_message_type doubles as the per-template ops kill-switch key
    // (twilio.js isTemplateActive) and MUST be the v2 template's key: the
    // legacy rain_out_moved row is retired (is_active=false), and stamping
    // the legacy key suppresses every send as a sentinel "success". An
    // absent v2 row (rolled-back migration) counts as active there, so the
    // legacy-render fallback above still texts.
    metadata: { original_message_type: 'rain_out_moved_v2', reason_code: reasonCode },
  });
  if (result?.blocked || result?.sent === false) {
    return { sent: false, reason: result.code || result.reason || 'blocked' };
  }
  // sent:true is necessary but not sufficient — upstream suppression paths
  // (per-template kill switch, gates) report sent:true with a sentinel
  // provider id and no SMS leaves. Surface those as not-sent so the rain-out
  // sheet never tells the operator a customer was notified when they weren't.
  if (!isRealProviderSend(result)) {
    return { sent: false, reason: result?.providerMessageId || 'send_suppressed' };
  }
  return { sent: true };
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
 * @param {boolean} [args.notifyCustomer=true]
 * @param {string} [args.initiatedBy='tech']  actor recorded on each reschedule
 *                                            for the audit log — 'admin' from the
 *                                            dispatch board, 'tech' from the app.
 */
async function commit({ serviceId, technicianId, reasonCode, scope, target, notifyCustomer = true, initiatedBy = 'tech' }) {
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

  // Exclusion is OUTCOME-BASED, never anticipatory. A batch member's row
  // leaves the rebooker's occupancy probe only once its OLD position is
  // provably out of play:
  //   (a) the row being moved RIGHT NOW — the probe must not clash a move
  //       against that row's own pre-move position; and
  //   (b) members whose moves have already COMMITTED — their old windows
  //       are vacated, and their rows now sit at new positions the batch's
  //       order math keeps consistent with every later member's target
  //       (this also preserves the batch's final-state semantics for stops
  //       that already overlapped each other before the rain-out).
  // Members NOT yet processed are NOT excluded. Blanket-excluding the whole
  // batch up front opened a race: another actor (customer /reschedule link,
  // dispatch board) could concurrently move a to-be-processed member INTO
  // an earlier member's target window — that freshly COMMITTED row was
  // invisible to the earlier move's probe purely because its id sat in the
  // exclusion set, and dropping the id later (when the member's own move
  // failed) could not undo the already-committed overlap. The rebooker's
  // own gates are the last line and they work only on non-excluded rows:
  // its tech-blind probe runs under the rung-1 date lock, so a member moved
  // by another txn IS visible at its committed new position, and its status
  // CAS re-checks the moving row's own state at write time.
  //
  // Why the not-yet-processed members' OLD rows need no exclusion — the
  // ordering proof, per batch shape:
  //   - Day move (target.date differs from the anchor's date): every
  //     unprocessed member still sits on the OLD date, and the occupancy
  //     probe is date-scoped to the TARGET date — those rows cannot match
  //     at all. Members already landed on the target date are covered by
  //     (b) explicitly.
  //   - Same-day forward push (delta > 0, processed tail-first): the
  //     unprocessed members sit EARLIER in the route order, and the current
  //     member's target is its own window shifted LATER by delta — moving
  //     AWAY from every earlier stop's window, so no overlap when the
  //     route's stops run in time order without overlapping one another.
  //   - Same-day backward pull (delta < 0, processed head-first): the
  //     mirror image — unprocessed members sit LATER, the target shifts
  //     EARLIER, away from them.
  //   - Windowless stops (window_start NULL) are inert to the occupancy
  //     predicate (scheduling/occupancy.js header), so an unprocessed
  //     windowless sibling can never block anything.
  // The shapes the order math does NOT cover — stops whose current windows
  // already overlap each other, a manual route_order that inverts time
  // order (sort position no longer implies time position), or a same-day
  // windowless sibling AS THE MOVER (its fallback target is the anchor's
  // window, not an order-preserving shift of its own): there a target CAN
  // land on an unprocessed sibling's old window, the probe now SEES that
  // row, and the move fails SLOT_TAKEN into the existing per-member
  // failure path below (recorded on the sheet; the tech re-runs the
  // straggler). Deliberate: a loud partial failure beats the silent
  // double-book the blanket pre-exclusion risked.
  const movedIds = [];
  const results = [];
  // Shared across the whole rain-out: the first slow NWS pair degrades
  // forecast decoration for every remaining stop's SMS.
  const forecastHealth = { degraded: false };
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
      // excludeServiceIds = the current row + the members already VACATED
      // (see the exclusion rationale above the loop). The rebooker also
      // self-excludes the moving row; passing it keeps the contract
      // explicit. A sibling still awaiting its move is deliberately NOT in
      // this list — its old row (or a position another actor concurrently
      // committed it to) must stay visible to the rebooker's occupancy
      // probe.
      await SmartRebooker.reschedule(job.id, target.date, newWindow, reasonCode, initiatedBy, {
        allowLive: true,
        excludeServiceIds: [job.id, ...movedIds],
      });
      // COMMITTED: this member's old window is vacated — later members'
      // probes may ignore its row from here on.
      movedIds.push(job.id);
    } catch (err) {
      // One job racing to completed/cancelled must not strand the rest
      // of a bulk rain-out — record and continue. This member did NOT move:
      // it never entered movedIds, so every later member's occupancy check
      // keeps seeing its row at the old position and refuses to schedule on
      // top of it.
      logger.warn(`[rain-out] reschedule failed for ${job.id}: ${err.message}`);
      results.push({ id: job.id, ok: false, error: err.message, statusCode: err.statusCode || 500 });
      continue;
    }

    // The move is COMMITTED past this point. Notification problems —
    // a throwing provider/audit wrapper, a failed forecast fetch —
    // must never mark the job failed, or the tech retries and
    // double-reschedules / double-texts an already-moved appointment.
    const chosen = { date: target.date, window: newWindow };
    let sms = { sent: false, reason: 'not_requested' };
    if (notifyCustomer) {
      try {
        const customer = job.id === serviceId
          ? {
            id: service.cust_id || service.customer_id, phone: service.phone, first_name: service.first_name,
            zip: service.zip, latitude: service.customer_latitude, longitude: service.customer_longitude,
          }
          : await db('customers').where({ id: job.customer_id }).first('id', 'phone', 'first_name', 'zip', 'latitude', 'longitude');
        sms = await sendMovedSms({ job, customer, reasonCode, chosen, serviceId: job.id, forecastHealth });
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
  _test: {
    sameDayOptions, customerArrivalOption, minutesToHHMM, hhmmToMinutes, WEATHER_PHRASES,
    composeWeatherLead, composeBetterDayClause, composeEfficacyClause, dayLabel, windowRainChance,
  },
};
