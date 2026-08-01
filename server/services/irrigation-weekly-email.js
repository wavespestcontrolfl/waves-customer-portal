'use strict';

/**
 * Weekly irrigation recommendation email.
 *
 * Monday-morning email to active lawn-care customers who entered a weekly
 * irrigation-inches value in the customer portal (My Property → Irrigation).
 * Reuses the service report's water balance: last week's rainfall + reference
 * ET₀ at the customer's own lat/lng (fetchServiceWeekWeather) fed through
 * buildIrrigationAdvice. Every eligible customer hears from us weekly —
 * surplus → "cut back", deficit → "add water", balanced (or a light week the
 * upcoming rain forecast covers) → "you're on track" (owner directive
 * 2026-07-02). Only a week without a full trusted rainfall window sends
 * nothing — never quote rain numbers we don't have.
 *
 * Templates (seeded by 20260702000001_seed_irrigation_weekly_email_templates.js):
 *   irrigation.weekly_cut_back
 *   irrigation.weekly_add_water
 *   irrigation.weekly_on_track
 *
 * Sent on the service_operational stream so customer email unsubscribes are
 * honored (a watering tip is not a required notice). Cron wiring lives in
 * scheduler.js; the sweep is gated by GATE_IRRIGATION_WEEKLY_EMAIL and only
 * shadow-logs candidate counts until the owner flips it on.
 */

const crypto = require('crypto');
const db = require('../models/db');
const logger = require('./logger');
const EmailTemplateLibrary = require('./email-template-library');
const { buildIrrigationAdvice } = require('./service-report/irrigation-advice');
const { fetchServiceWeekWeather } = require('./service-report/application-conditions');
const { grassTypeLabel, normalizeGrassType } = require('./lawn-grass-context');
const { isEnabled } = require('../config/feature-gates');
const { CUSTOMER_STAGES } = require('./customer-stages');
const { etDateString, addETDays, etParts } = require('../utils/datetime-et');
const { portalUrl: buildPortalUrl } = require('../utils/portal-url');
const { WAVES_SUPPORT_PHONE_DISPLAY } = require('../constants/business');

const CONTACT_EMAIL = 'contact@wavespestcontrol.com';
const SUPPRESSION_GROUP = 'service_operational';
const TEMPLATE_CUT_BACK = 'irrigation.weekly_cut_back';
const TEMPLATE_ADD_WATER = 'irrigation.weekly_add_water';
const TEMPLATE_ON_TRACK = 'irrigation.weekly_on_track';
// Setup variants — the customer is on a recurring lawn program but we don't
// have a usable watering schedule, so there is no balance to report. They
// still get the week's measured rain and the seasonal target; the ask differs
// by whether they've told us a sprinkler system exists (owner directive
// 2026-08-01: the weekly email goes to the whole recurring-lawn book, not
// just the handful who filled in the portal form).
const TEMPLATE_SETUP_SCHEDULE = 'irrigation.weekly_setup_schedule';
const TEMPLATE_SETUP_SYSTEM = 'irrigation.weekly_setup_system';
// Confirm variant — we DO have a usable schedule, but a technician recorded
// it rather than the customer entering it in the portal. The three advice
// templates credit "the irrigation schedule you shared in your customer
// portal" and prescribe sprinkler-specific actions ("trim a few minutes off
// each zone"); both are false for a tech-recorded reading on a
// hand-watered lawn (codex #3138 r2 P2). Same balance, source-neutral copy,
// and it asks the customer to confirm what's on file.
const TEMPLATE_CONFIRM_SCHEDULE = 'irrigation.weekly_confirm_schedule';

// Sequential per-customer weather fetches; Open-Meteo caching in
// application-conditions dedupes nearby customers (coords keyed at 2 decimals).
// Hard cap on send ATTEMPTS (counted before the provider call, so a downstream
// failure after SendGrid accepts still consumes the budget) — a runaway query
// can never blast the whole book of business.
const MAX_SEND_ATTEMPTS_PER_RUN = 500;

function isEmailLike(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || '').trim().toLowerCase());
}

// Raw provider errors can echo the recipient address (e.g. SendGrid's
// "...does not match a verified Sender Identity: <email>") — email addresses
// in Railway logs are a P1. Keep the status/shape for diagnosis, redact any
// address-looking token from anything we log or persist.
function sanitizeFailureReason(err) {
  const status = err?.status ? ` status=${err.status}` : '';
  const message = String(err?.message || err || 'unknown error')
    .replace(/[^\s@:<>()"']+@[^\s@:<>()"']+\.[^\s@:<>()"']+/g, '[redacted-email]');
  return `${message}${status}`;
}

function numberOrNull(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

// 1.25 → '1.25', 1.5 → '1.5', 2 → '2' — reads naturally inside a sentence.
function formatInches(value) {
  const n = numberOrNull(value);
  if (n == null) return null;
  return String(Math.round(n * 100) / 100);
}

// The Sunday that closed out the last COMPLETED Mon–Sun week, as YYYY-MM-DD
// in ET. The cron fires Monday morning, so that's "yesterday"; a manual run on
// any other weekday still resolves to the same most-recent completed week
// (running ON a Sunday reaches back to the previous Sunday — the current week
// isn't complete until the day ends).
function lastCompletedWeekEnding(now = new Date()) {
  const { dayOfWeek } = etParts(now); // Sun=0 … Sat=6
  const back = dayOfWeek === 0 ? 7 : dayOfWeek;
  return etDateString(addETDays(now, -back));
}

function monthFromYmd(ymd) {
  const m = Number(String(ymd || '').slice(5, 7));
  return Number.isInteger(m) && m >= 1 && m <= 12 ? m : null;
}

/**
 * Upcoming-week rain forecast (inches) at the customer's coordinates: the
 * 7 days starting today, Open-Meteo daily precipitation_sum. Fail-soft null —
 * the email sends without a forecast line rather than blocking on it.
 */
const _forecastCache = new Map();
const FORECAST_TTL_MS = 6 * 60 * 60 * 1000; // 6h — one cron sweep reuses freely

async function fetchUpcomingWeekRainForecast({ latitude, longitude } = {}) {
  const lat = numberOrNull(latitude);
  const lon = numberOrNull(longitude);
  if (lat == null || lon == null) return null;
  const key = `${lat.toFixed(2)},${lon.toFixed(2)}`;
  const cached = _forecastCache.get(key);
  if (cached && Date.now() - cached.at < FORECAST_TTL_MS) return cached.value;

  const url = new URL('https://api.open-meteo.com/v1/forecast');
  url.searchParams.set('latitude', String(lat));
  url.searchParams.set('longitude', String(lon));
  url.searchParams.set('daily', 'precipitation_sum');
  url.searchParams.set('forecast_days', '7');
  url.searchParams.set('precipitation_unit', 'inch');
  url.searchParams.set('timezone', 'America/New_York');

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3500);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) return null;
    const payload = await response.json();
    const days = payload?.daily?.precipitation_sum;
    // A full 7-day window or nothing — a short array (Open-Meteo can 200 with
    // a partial series) would understate the week and read as "little rain".
    if (!Array.isArray(days) || days.length !== 7) return null;
    // Every day must be numeric — a partial window would understate the week.
    let total = 0;
    for (const value of days) {
      const n = numberOrNull(value);
      if (n == null) return null;
      total += n;
    }
    const value = Math.round(total * 100) / 100;
    _forecastCache.set(key, { at: Date.now(), value });
    return value;
  } catch (err) {
    logger.warn(`[irrigation-weekly-email] forecast fetch failed: ${err.message}`);
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

// Deterministic forecast sentence. Null forecast → empty string, and the
// template's forecast_line paragraph renders nothing.
function forecastLine({ forecastRainInches, status, targetInches }) {
  const forecast = numberOrNull(forecastRainInches);
  if (forecast == null) return '';
  if (forecast < 0.1) {
    return 'Looking ahead: little to no rain is in the forecast for your area over the next 7 days.';
  }
  const amount = formatInches(forecast);
  const base = `Looking ahead: about ${amount}" of rain is in the forecast for your area over the next 7 days`;
  const target = numberOrNull(targetInches);
  // (No deficit-with-full-forecast branch: that combination suppresses the
  // email entirely in buildWeeklyEmailDecision rather than sending "add
  // water" against incoming rain.)
  if (status === 'surplus' && target != null && forecast >= target) {
    return `${base} — more than your lawn needs on its own, so easing back now will really pay off.`;
  }
  return `${base}.`;
}

/**
 * Decide whether last week's water balance warrants an email, and build the
 * template key + payload when it does. Pure given its inputs — this is the
 * unit-testable core of the sweep.
 */
function buildWeeklyEmailDecision({
  firstName,
  grassType = null,
  weekEnding,
  irrigationInchesPerWeek,
  turfIrrigationInchesPerWeek = null,
  assessmentIrrigationInchesPerWeek = null,
  turfIrrigationType = null,
  irrigationSystem = null,
  rainfallInches7d = null,
  et0Inches = null,
  forecastRainInches = null,
} = {}) {
  // Same fallback chain, same precedence, as the lawn report's
  // buildLawnWaterContext (report-data.js): PORTAL ENTRY WINS, then a
  // tech-recorded turf-profile reading, then the latest assessment. The two
  // surfaces must agree — a customer whose report shows 1" must never get an
  // email claiming we have no schedule for them (codex #3138 r1 P2).
  const prefsInches = numberOrNull(irrigationInchesPerWeek);
  const turfInches = numberOrNull(turfIrrigationInchesPerWeek);
  const assessmentInches = numberOrNull(assessmentIrrigationInchesPerWeek);
  const effectiveInches = prefsInches != null ? prefsInches
    : (turfInches != null ? turfInches : assessmentInches);
  // …and the same suppression semantics: the portal toggle only zeroes a
  // value the customer did NOT enter — i.e. when the prefs reading is the
  // only one there is. A tech-recorded reading is never suppressed by the
  // customer's toggle.
  const onlyPrefsReading = turfInches == null && assessmentInches == null && prefsInches != null;
  // WHERE the schedule came from decides which copy is truthful, so it is
  // tracked alongside the value itself.
  const scheduleSource = prefsInches != null ? 'portal'
    : (turfInches != null ? 'turf' : (assessmentInches != null ? 'assessment' : null));

  const advice = buildIrrigationAdvice({
    grassType,
    month: monthFromYmd(weekEnding),
    irrigationInchesPerWeek: effectiveInches,
    rainfallInches7d,
    referenceEt0InchesWeek: et0Inches,
    irrigationEnabled: irrigationSystem === false && onlyPrefsReading ? false : true,
  });

  // No usable schedule on file — nothing to balance, so this is the setup
  // variant rather than advice. The rain number is still measured at their
  // home and the target is still real, so the email carries its weight; the
  // ask is what changes. Rain must be KNOWN for the same reason the advice
  // path requires it: the email quotes the week's rainfall, and we never
  // print a number we don't trust.
  if (advice.profileMissing) {
    if (!advice.rainKnown) {
      return { shouldSend: false, reason: 'rain_unknown', advice };
    }
    // "Do we know a sprinkler system exists?" — a technician's recorded
    // irrigation_type is a FIRST-HAND OBSERVATION and outranks the portal
    // toggle, which the customer may have set long ago (codex #3138 r2 P2).
    // An explicit 'none'/'manual' is knowledge that there is no system to ask
    // a run time about, even if the toggle still says true. The toggle is
    // consulted only when no type was recorded.
    const turfType = String(turfIrrigationType || '').trim().toLowerCase();
    const hasSystem = turfType
      ? (turfType === 'in_ground' || turfType === 'mixed')
      : irrigationSystem === true;
    const grassLabelSetup = customerGrassLabel(grassType);
    const rainSetup = formatInches(rainfallInches7d);
    const targetSetup = formatInches(advice.recommendedInchesPerWeek);
    return {
      shouldSend: true,
      templateKey: hasSystem ? TEMPLATE_SETUP_SCHEDULE : TEMPLATE_SETUP_SYSTEM,
      reason: hasSystem ? 'setup_schedule' : 'setup_system',
      advice,
      payload: {
        first_name: String(firstName || '').trim() || 'there',
        grass_label: grassLabelSetup,
        week_ending: weekEnding,
        rain_last_week: rainSetup,
        target_inches: targetSetup,
        forecast_line: forecastLine({
          forecastRainInches,
          status: advice.status,
          targetInches: advice.recommendedInchesPerWeek,
        }),
        customer_portal_url: buildPortalUrl('/?tab=property'),
        company_phone: WAVES_SUPPORT_PHONE_DISPLAY,
        company_email: CONTACT_EMAIL,
      },
    };
  }

  // Every eligible customer hears from us weekly — cut back, add water, or
  // "you're good to go" (owner directive 2026-07-02). The ONLY silent case is
  // an untrusted rainfall window ('rain_unknown', including a surplus computed
  // without rain): this email quotes the week's rain number, so never tell a
  // customer it rained 0" when we just don't know.
  const actionable = advice.status === 'surplus' || advice.status === 'deficit' || advice.status === 'balanced';
  if (!actionable || !advice.rainKnown) {
    return { shouldSend: false, reason: advice.rainKnown ? advice.status : 'rain_unknown', advice };
  }

  // The instruction is for the week AHEAD. The programmed schedule keeps
  // running but last week's rain doesn't, so the projected week is irrigation
  // + forecast rain (same quarter-inch band the advice uses):
  //   - a deficit whose projection is covered → on-track ("rain has it
  //     covered"), not "add water" against incoming rain;
  //   - a balanced week whose projection runs short (rain did part of last
  //     week's work, this week looks dry) → "add water", not "no changes
  //     needed".
  // Forecast unavailable → fail soft to last week's facts. A surplus is NOT
  // forecast-rerouted: after an over-watered week the soil is already
  // saturated, so easing back stays correct whatever this week brings.
  const forecast = numberOrNull(forecastRainInches);
  const projectedDifferential = forecast == null
    ? null
    : (effectiveInches + forecast) - advice.recommendedInchesPerWeek;
  let reason = advice.status;
  if (advice.status === 'deficit' && projectedDifferential != null && projectedDifferential > -0.25) {
    reason = 'deficit_rain_forecast';
  }
  if (advice.status === 'balanced' && projectedDifferential != null && projectedDifferential <= -0.25) {
    reason = 'balanced_dry_forecast';
  }
  const templateKey = reason === 'surplus' ? TEMPLATE_CUT_BACK
    : (reason === 'deficit' || reason === 'balanced_dry_forecast') ? TEMPLATE_ADD_WATER
      : TEMPLATE_ON_TRACK; // 'balanced' and 'deficit_rain_forecast'

  const differential = Math.abs(numberOrNull(advice.differentialInchesPerWeek) ?? 0);
  const grassLabel = customerGrassLabel(grassType);
  const rain = formatInches(rainfallInches7d);

  // A schedule we were told by a technician, not one the customer entered.
  // The advice templates would misattribute it and hand a hand-watering
  // customer sprinkler instructions, so the balance is reported in
  // source-neutral copy that asks them to confirm it instead (codex r2 P2).
  if (scheduleSource !== 'portal') {
    const scheduleFmt = formatInches(effectiveInches);
    const totalFmt = formatInches(advice.appliedInchesPerWeek);
    const targetFmt = formatInches(advice.recommendedInchesPerWeek);
    const diffFmt = formatInches(differential);
    // Keyed on the measured status only — no forecast rerouting here, since
    // the neutral copy never prescribes an action for the week ahead.
    const neutralLead = advice.status === 'surplus'
      ? `Between the rain near your home last week (${rain}") and the ${scheduleFmt}"-per-week watering schedule we have on file for you, your lawn got about ${totalFmt}" of water — roughly ${diffFmt}" more than the ${targetFmt}" your ${grassLabel} needs this time of year.`
      : advice.status === 'deficit'
        ? `Between the rain near your home last week (${rain}") and the ${scheduleFmt}"-per-week watering schedule we have on file for you, your lawn got about ${totalFmt}" of water — roughly ${diffFmt}" short of the ${targetFmt}" your ${grassLabel} needs this time of year.`
        : `Between the rain near your home last week (${rain}") and the ${scheduleFmt}"-per-week watering schedule we have on file for you, your lawn got about ${totalFmt}" of water — right in line with the ${targetFmt}" your ${grassLabel} needs this time of year.`;
    return {
      shouldSend: true,
      templateKey: TEMPLATE_CONFIRM_SCHEDULE,
      reason: `confirm_${advice.status}`,
      advice,
      payload: {
        first_name: String(firstName || '').trim() || 'there',
        grass_label: grassLabel,
        week_ending: weekEnding,
        rain_last_week: rain,
        schedule_inches: scheduleFmt,
        total_inches: totalFmt,
        target_inches: targetFmt,
        summary_line: neutralLead,
        forecast_line: forecastLine({
          forecastRainInches,
          status: advice.status,
          targetInches: advice.recommendedInchesPerWeek,
        }),
        customer_portal_url: buildPortalUrl('/?tab=property'),
        company_phone: WAVES_SUPPORT_PHONE_DISPLAY,
        company_email: CONTACT_EMAIL,
      },
    };
  }
  // The RESOLVED schedule, not the raw prefs column — the copy must quote
  // the same number the advice was computed from (codex #3138 r1 P2).
  const irrigationFmt = formatInches(effectiveInches);
  const total = formatInches(advice.appliedInchesPerWeek);
  const target = formatInches(advice.recommendedInchesPerWeek);

  // Lead sentence for the on-track and add-water templates — the situations
  // they cover read differently (balanced vs rain-covered; light-last-week vs
  // rain-fed-last-week-but-dry-ahead), so the copy is computed here rather
  // than baked into the template. Cut-back keeps its static template lead.
  let summaryLine = null;
  if (reason === 'balanced') {
    summaryLine = `Between last week's rain (${rain}") and your irrigation schedule (${irrigationFmt}" per week), your lawn got about ${total}" of water — right in line with the ${target}" your ${grassLabel} needs this time of year.`;
  } else if (reason === 'deficit_rain_forecast') {
    summaryLine = `Last week ran a touch light (${total}" against the ${target}" your ${grassLabel} needs), but with about ${formatInches(forecast)}" of rain in this week's forecast, your current schedule has it covered.`;
  } else if (reason === 'deficit') {
    summaryLine = `Rain was light near your home last week (${rain}"), so with your irrigation schedule (${irrigationFmt}" per week) your lawn got about ${total}" of water — roughly ${formatInches(differential)}" short of the ${target}" your ${grassLabel} needs this time of year.`;
  } else if (reason === 'balanced_dry_forecast') {
    const projectedShortfall = formatInches(Math.round(Math.abs(projectedDifferential) * 4) / 4);
    summaryLine = `Last week landed right on target (${total}"), but rain did part of the work. With little rain in this week's forecast, your current schedule (${irrigationFmt}" per week) would come up about ${projectedShortfall}" short of the ${target}" your ${grassLabel} needs — a small bump this week will cover it.`;
  }

  const payload = {
    first_name: String(firstName || '').trim() || 'there',
    grass_label: grassLabel,
    week_ending: weekEnding,
    rain_last_week: rain,
    irrigation_inches: irrigationFmt,
    total_inches: total,
    target_inches: target,
    difference_inches: formatInches(differential),
    ...(summaryLine ? { summary_line: summaryLine } : {}),
    // The forecast-rerouted cases explain the forecast in their summary_line —
    // a second forecast sentence would repeat it.
    forecast_line: (reason === 'deficit_rain_forecast' || reason === 'balanced_dry_forecast') ? '' : forecastLine({
      forecastRainInches,
      status: advice.status,
      targetInches: advice.recommendedInchesPerWeek,
    }),
    customer_portal_url: buildPortalUrl('/?tab=property'),
    company_phone: WAVES_SUPPORT_PHONE_DISPLAY,
    company_email: CONTACT_EMAIL,
  };

  return { shouldSend: true, templateKey, reason, advice, payload };
}

/**
 * RECURRING lawn-care customers: real customer (pipeline stage, not the
 * leads-default `active` flag) + an email and coordinates to work with +
 * REQUIRED recurring-lawn-service evidence.
 *
 * The irrigation columns used to be eligibility filters. As of the owner
 * directive 2026-08-01 they are not: the weekly rainfall number is derived
 * from the customer's own coordinates and is useful on its own, so the whole
 * recurring-lawn book hears from us and the irrigation profile only chooses
 * which of three copy variants they get (advice / tell-us-your-schedule /
 * do-you-have-a-system). Measured 2026-08-01: filtering on the columns
 * reached 3 of 23 otherwise-eligible customers.
 *
 * Owner directive 2026-07-09 (refined): the audience is customers on a
 * recurring lawn program — the monthly / every-6-weeks / bi-monthly lawn
 * cadences — never pest-only members or one-time lawn jobs. The earlier
 * hasCustomerLawnCare mirror accepted a bare real waveguard_tier or a
 * customers.lawn_type as membership, but WaveGuard tiers are SHARED across
 * pest and lawn programs and lawn_type is free-text present on pest-only
 * accounts: 86% of the tier-qualified audience was verified pest-only. So
 * tier and lawn_type are NOT eligibility here, and the turf profile is
 * grass-type corroboration only (resolveGrassType), never a qualifier.
 *
 * The enforceable evidence (validated against prod, without hardcoding
 * cadence names): an UPCOMING live lawn-flavored visit ON A RECURRING
 * SERIES (is_recurring / recurring_parent_id / recurring_pattern — a
 * future one-time lawn job must not qualify, Codex #2954), OR ≥2
 * lawn-flavored visits inside the trailing window — one visit is a
 * one-time job; two or more inside 180 days is a real cadence.
 *
 * Customers who turned email off portal-wide (notification_prefs.email_enabled
 * = false) or opted out of Seasonal Lawn Tips are excluded — this is an
 * optional nudge, not a required notice.
 */
// A recurring lawn program visits at least quarterly; 180 days of slack keeps
// a delayed program customer in while excluding long-churned service.
const LAWN_SERVICE_RECENCY_DAYS = 180;

// Statuses that don't evidence current service: cancelled/skipped/no_show
// plus 'rescheduled' phantom rows (see waveguard-existing-services
// TERMINAL_STATUSES). 'completed' DOES count in the trailing window — a
// recent completed lawn visit is exactly the cadence evidence wanted.
const NON_LIVE_VISIT_STATUSES = ['cancelled', 'skipped', 'no_show', 'rescheduled'];

// Lawn-flavored service_type match. '%waveguard%' is deliberately NOT in
// this set (Codex #2954 r2): WaveGuard Membership / Initial Setup are
// generic specialty rows shared across programs, not lawn visits — a
// lawn service that happens to carry the WaveGuard name still matches
// '%lawn%'.
const LAWN_SERVICE_TYPE_LIKES = ['%lawn%', '%fertiliz%', '%fungicide%', '%turf%'];

async function findEligibleCustomers({ now = new Date() } = {}) {
  const lawnServiceCutoff = etDateString(addETDays(now, -LAWN_SERVICE_RECENCY_DAYS));
  const todayET = etDateString(now);
  const lawnLikeSql = LAWN_SERVICE_TYPE_LIKES
    .map(() => 'LOWER(ss2.service_type) LIKE ?')
    .join(' OR ');
  const nonLivePlaceholders = NON_LIVE_VISIT_STATUSES.map(() => '?').join(', ');
  return db('customers as c')
    // LEFT so a recurring-lawn customer who never opened Property Preferences
    // is still reachable — under the old INNER JOIN a missing prefs row made
    // them invisible to the sweep entirely (1 live customer, verified
    // 2026-08-01). Their variant is decided from the columns, which come back
    // null.
    .leftJoin('property_preferences as pp', 'pp.customer_id', 'c.id')
    .leftJoin('customer_turf_profiles as tp', function joinActiveProfile() {
      this.on('tp.customer_id', '=', 'c.id').andOnVal('tp.active', '=', true);
    })
    .leftJoin('notification_prefs as np', 'np.customer_id', 'c.id')
    .whereRaw('np.email_enabled IS DISTINCT FROM false')
    // This email IS a seasonal lawn tip — the portal labels seasonal_tips
    // "Watering, mowing height, and care tips for SW Florida" — so the
    // dedicated opt-out is honored too (the SMS tip path gates on the same
    // pref in twilio.js).
    .whereRaw('np.seasonal_tips IS DISTINCT FROM false')
    .where('c.active', true)
    .whereNull('c.deleted_at')
    // Real customers only (whereLiveCustomer semantics, alias-qualified —
    // the shared helper's unqualified columns would be ambiguous against
    // the tp join): customers.active defaults TRUE for lead rows, so
    // pipeline_stage is what separates a customer from a lead.
    .whereIn('c.pipeline_stage', CUSTOMER_STAGES)
    .whereNotNull('c.email')
    .whereNotNull('c.latitude')
    .whereNotNull('c.longitude')
    // NOTE: irrigation_system / irrigation_inches_per_week are deliberately
    // NOT filters (owner directive 2026-08-01). They select the COPY VARIANT
    // in buildWeeklyEmailDecision — schedule on file gets advice, everyone
    // else gets the same measured rainfall plus the matching ask. Gating on
    // them reached 3 of 23 recurring-lawn customers; the other 20 simply
    // never opened the portal's Property Preferences form.
    .where(function recurringLawnService() {
      // REQUIRED recurring-lawn evidence — tier / lawn_type / turf profile
      // never qualify a customer on their own (see the doc block above).
      this.whereExists(function upcomingLawnVisit() {
        this.select(db.raw('1'))
          .from('scheduled_services as ss')
          .whereRaw('ss.customer_id = c.id')
          .whereNotIn('ss.status', NON_LIVE_VISIT_STATUSES)
          // A same-ET-date row already COMPLETED is not upcoming evidence
          // (Codex #2954 r2 P3): without this, a lapsed recurring-marked
          // customer passes on the day of their last visit.
          .whereNot('ss.status', 'completed')
          .where('ss.scheduled_date', '>=', todayET)
          // Recurring-series marker REQUIRED on the upcoming branch
          // (Codex #2954 P2): a future one-time lawn job would otherwise
          // qualify the moment it's booked. The seeder stamps all three
          // markers on series visits; any one of them is proof.
          .where(function recurringMarker() {
            this.where('ss.is_recurring', true)
              .orWhereNotNull('ss.recurring_parent_id')
              .orWhereNotNull('ss.recurring_pattern');
          })
          .where(function serviceTypes() {
            for (const pattern of LAWN_SERVICE_TYPE_LIKES) {
              this.orWhereRaw('LOWER(ss.service_type) LIKE ?', [pattern]);
            }
          });
      })
        // …or a demonstrated cadence: ≥2 live lawn-flavored visits inside
        // the TRAILING window — bounded on both sides (pre-push P1: with
        // only the lower bound, two future one-time bookings would count;
        // future visits belong to the recurring-marker branch above).
        // Follow-up CHILD rows are excluded (Codex #2954 r2): a one-time
        // lawn treatment plus its linked follow-up (parent_service_id
        // stamped, same service_type) is still one job, not a cadence;
        // recurring-series children carry recurring_parent_id, never
        // parent_service_id, so real cadences are unaffected.
        .orWhereRaw(
          `(SELECT COUNT(*) FROM scheduled_services ss2
             WHERE ss2.customer_id = c.id
               AND ss2.status NOT IN (${nonLivePlaceholders})
               AND ss2.parent_service_id IS NULL
               AND ss2.scheduled_date >= ?
               AND ss2.scheduled_date <= ?
               AND (${lawnLikeSql})) >= 2`,
          [...NON_LIVE_VISIT_STATUSES, lawnServiceCutoff, todayET, ...LAWN_SERVICE_TYPE_LIKES],
        );
    })
    .select(
      'c.id',
      'c.first_name',
      'c.email',
      'c.latitude',
      'c.longitude',
      'pp.irrigation_inches_per_week',
      'pp.irrigation_system',
      // A schedule can also have been recorded by a tech rather than typed by
      // the customer (codex #3138 r1 P2). The lawn report already treats
      // portal → turf profile → assessment as one fallback chain
      // (report-data.js buildLawnWaterContext); this sweep must agree with it
      // or we email "we don't have your watering schedule" to someone whose
      // own report displays that very number.
      'tp.irrigation_inches_per_week as turf_irrigation_inches_per_week',
      'tp.irrigation_type as turf_irrigation_type',
      // LATEST non-null reading, and its value is passed through EVEN IF ZERO
      // (codex #3138 r2 P2). Filtering `> 0` inside the subquery would drop a
      // newer "they stopped watering" row and resurrect an older positive
      // schedule; buildIrrigationAdvice already reads zero as a missing
      // profile, which correctly routes them to a setup email.
      db.raw(`(
        SELECT la.irrigation_inches_per_week
          FROM lawn_assessments la
         WHERE la.customer_id = c.id
           AND la.irrigation_inches_per_week IS NOT NULL
         ORDER BY la.service_date DESC NULLS LAST, la.created_at DESC
         LIMIT 1
      ) as assessment_irrigation_inches_per_week`),
      'tp.grass_type',
      'c.lawn_type',
    )
    .orderBy('c.id');
}

// Grass for the water target: the turf profile's canonical key wins; legacy
// customers without an active profile fall back to free-text customers.lawn_type
// normalized to a canonical key ("Zoysia Empire" → zoysia) so a Bahia/Zoysia
// lawn is not scored against the St. Augustine default.
function resolveGrassType(candidate = {}) {
  return candidate.grass_type || normalizeGrassType(candidate.lawn_type) || null;
}

// Customer-facing grass label. A real grass renders by name ("your St.
// Augustine"); unknown / mixed / missing render as "your lawn" — never "your
// Unknown" (turf profiles can legitimately store grass_type='unknown'), and
// never a named-grass claim we can't back.
const CUSTOMER_GRASS_LABELS = new Set(['st_augustine', 'bermuda', 'zoysia', 'bahia']);
function customerGrassLabel(grassType) {
  const key = String(grassType || '').trim().toLowerCase();
  return CUSTOMER_GRASS_LABELS.has(key) ? grassTypeLabel(key) : 'lawn';
}

async function logEmailAttempt({ customerId, templateKey, status, providerMessageId = null, sentAt = null, failureReason = null, weekEnding }) {
  try {
    await db('customer_interactions').insert({
      customer_id: customerId,
      interaction_type: 'email_outbound',
      subject: `irrigation.weekly email ${status}`,
      body: failureReason
        ? `irrigation.weekly email ${status}: ${failureReason}`
        : `irrigation.weekly email ${status} (week ending ${weekEnding}).`,
      metadata: JSON.stringify({
        customer_id: customerId,
        template_key: templateKey,
        channel: 'email',
        event_type: 'irrigation.weekly',
        week_ending: weekEnding,
        provider_message_id: providerMessageId,
        status,
        sent_at: sentAt,
        failure_reason: failureReason,
      }),
    });
  } catch (err) {
    logger.warn(`[irrigation-weekly-email] audit log failed for ${customerId}: ${err.message}`);
  }
}

/**
 * The Monday sweep. Gated: with GATE_IRRIGATION_WEEKLY_EMAIL off it only
 * shadow-logs the candidate count (no weather fetches, no sends) so the
 * pipeline can be watched in prod before going live.
 *
 * Idempotent per customer-week via email_messages.idempotency_key
 * (`irrigation.weekly:<customerId>:<weekEnding>:<recipientHash>`) — a re-run
 * or overlapping deploy tick dedupes inside the template library, and
 * runExclusive in the cron wiring prevents concurrent sweeps.
 */
async function runWeeklyIrrigationEmailSweep({ now = new Date(), maxSendAttempts = MAX_SEND_ATTEMPTS_PER_RUN } = {}) {
  const weekEnding = lastCompletedWeekEnding(now);
  const candidates = await findEligibleCustomers({ now });

  if (!isEnabled('irrigationWeeklyEmail')) {
    logger.info(`[irrigation-weekly-email] shadow mode (gate off): ${candidates.length} candidate(s) for week ending ${weekEnding} — no emails sent`);
    return { shadow: true, weekEnding, candidates: candidates.length, sent: 0 };
  }

  const summary = {
    shadow: false,
    weekEnding,
    candidates: candidates.length,
    attempted: 0,
    sent: 0,
    deduped: 0,
    blocked: 0,
    skipped: { rain_unknown: 0, unknown: 0, missing_email: 0, capped: 0 },
    failed: 0,
  };

  for (const customer of candidates) {
    if (summary.attempted >= maxSendAttempts) {
      summary.skipped.capped += 1;
      continue;
    }
    try {
      if (!isEmailLike(customer.email)) {
        summary.skipped.missing_email += 1;
        continue;
      }

      const weekWeather = await fetchServiceWeekWeather({
        latitude: customer.latitude,
        longitude: customer.longitude,
        serviceDate: weekEnding,
      });

      const decisionInputs = {
        firstName: customer.first_name,
        grassType: resolveGrassType(customer),
        weekEnding,
        irrigationInchesPerWeek: customer.irrigation_inches_per_week,
        turfIrrigationInchesPerWeek: customer.turf_irrigation_inches_per_week,
        assessmentIrrigationInchesPerWeek: customer.assessment_irrigation_inches_per_week,
        turfIrrigationType: customer.turf_irrigation_type,
        irrigationSystem: customer.irrigation_system,
        rainfallInches7d: weekWeather.rainInches,
        et0Inches: weekWeather.et0Inches,
      };
      // Decide from last week's balance FIRST — the forecast only fills an
      // optional copy line and never changes shouldSend, so skipped customers
      // (balanced / rain-unknown) must not cost an Open-Meteo forecast call.
      let decision = buildWeeklyEmailDecision(decisionInputs);
      if (!decision.shouldSend) {
        if (summary.skipped[decision.reason] != null) summary.skipped[decision.reason] += 1;
        else summary.skipped.unknown += 1;
        continue;
      }
      const forecastRainInches = await fetchUpcomingWeekRainForecast({
        latitude: customer.latitude,
        longitude: customer.longitude,
      });
      decision = buildWeeklyEmailDecision({ ...decisionInputs, forecastRainInches });
      // Defensive recheck — today the forecast only reroutes a deficit to the
      // on-track template (still a send), but a no-send here must be counted.
      if (!decision.shouldSend) {
        if (summary.skipped[decision.reason] != null) summary.skipped[decision.reason] += 1;
        else summary.skipped.unknown += 1;
        continue;
      }

      // Same bounded per-recipient token as appointment-email so the key fits
      // email_messages.idempotency_key even for long addresses.
      const recipientToken = crypto.createHash('sha256')
        .update(String(customer.email).trim().toLowerCase())
        .digest('hex')
        .slice(0, 16);
      // Consume the cap BEFORE the provider call: an error thrown after
      // SendGrid accepts (audit/DB failure) must still count as an attempt.
      summary.attempted += 1;
      const result = await EmailTemplateLibrary.sendTemplate({
        templateKey: decision.templateKey,
        to: String(customer.email).trim(),
        payload: decision.payload,
        recipientType: 'customer',
        recipientId: customer.id,
        triggerEventId: `irrigation.weekly:${customer.id}:${weekEnding}`,
        idempotencyKey: `irrigation.weekly:${customer.id}:${weekEnding}:${recipientToken}`,
        categories: ['irrigation', 'irrigation_weekly', decision.reason],
        suppressionGroupKey: SUPPRESSION_GROUP,
        // sendOne must not log the raw SendGrid body (it can echo the
        // recipient address) — this sweep logs sanitizeFailureReason instead.
        suppressProviderErrorLog: true,
      });

      // Idempotency-dedupe and suppression short-circuit inside the library
      // BEFORE any SendGrid call — refund the budget so a long run of
      // already-sent/suppressed rows cannot starve the rest of the list. The
      // library marks results that DID reach the provider this call
      // (providerAttempted) — those keep their attempt even when reported as
      // deduped (webhook/supersede races), as does a thrown error.
      if ((result.deduped || result.blocked) && !result.providerAttempted) summary.attempted -= 1;

      if (result.deduped) {
        summary.deduped += 1;
      } else if (result.sent) {
        summary.sent += 1;
        await logEmailAttempt({
          customerId: customer.id,
          templateKey: decision.templateKey,
          status: 'sent',
          providerMessageId: result.message?.provider_message_id || null,
          sentAt: result.message?.sent_at || null,
          weekEnding,
        });
      } else if (result.blocked) {
        summary.blocked += 1;
      } else {
        summary.failed += 1;
        await logEmailAttempt({
          customerId: customer.id,
          templateKey: decision.templateKey,
          status: 'failed',
          failureReason: sanitizeFailureReason({ message: result.reason || result.message?.error_message || 'email_not_sent' }),
          weekEnding,
        });
      }
    } catch (err) {
      summary.failed += 1;
      const reason = sanitizeFailureReason(err);
      logger.error(`[irrigation-weekly-email] send failed for customer ${customer.id}: ${reason}`);
      await logEmailAttempt({
        customerId: customer.id,
        templateKey: 'irrigation.weekly',
        status: 'failed',
        failureReason: reason,
        weekEnding,
      });
    }
  }

  logger.info(
    `[irrigation-weekly-email] week ending ${weekEnding}: ${summary.candidates} candidate(s), `
    + `${summary.sent} sent, ${summary.deduped} deduped, ${summary.blocked} suppressed, `
    + `${summary.skipped.rain_unknown} rain-unknown, ${summary.failed} failed`,
  );
  return summary;
}

module.exports = {
  runWeeklyIrrigationEmailSweep,
  buildWeeklyEmailDecision,
  findEligibleCustomers,
  fetchUpcomingWeekRainForecast,
  TEMPLATE_CUT_BACK,
  TEMPLATE_ADD_WATER,
  TEMPLATE_ON_TRACK,
  TEMPLATE_SETUP_SCHEDULE,
  TEMPLATE_SETUP_SYSTEM,
  TEMPLATE_CONFIRM_SCHEDULE,
  _private: { forecastLine, lastCompletedWeekEnding, formatInches, monthFromYmd, resolveGrassType, customerGrassLabel, sanitizeFailureReason },
};
