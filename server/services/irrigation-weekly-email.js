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
const {
  deriveIrrigationInchesPerWeek,
  describeRuntimeBasis,
  normalizeRuntimeInputs,
  HEAD_LABELS,
} = require('@waves/irrigation-runtime');

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

function roundHundredth(value) {
  const n = numberOrNull(value);
  return n == null ? null : Math.round(n * 100) / 100;
}

// The Sunday that closed out the last COMPLETED Mon–Sun week, as YYYY-MM-DD
// in ET. The cron fires Monday morning, so that's "yesterday"; a manual run on
// any other weekday still resolves to the same most-recent completed week
// (running ON a Sunday reaches back to the previous Sunday — the current week
// isn't complete until the day ends).
const PORTAL_IRRIGATION_ASK = 'under Irrigation in your portal';
const SETUP_CLOSER = "and these check-ins become real recommendations — ease back this week, add a few minutes, or you're right on track.";

function joinList(parts) {
  if (parts.length <= 1) return parts.join('');
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

/**
 * The setup_schedule callout, per customer. A customer with days, zones and
 * per-zone minutes on file read the old static "we have a system on file
 * but not how much you run it" as "you lost my schedule" (2026-08-17). So:
 * name what IS on file, then the ONE thing that still blocks the conversion.
 * `derived` is deriveIrrigationInchesPerWeek's result for their prefs.
 */
function buildScheduleAsk({ derived, inputs, toggleOff = false, explicitInches = null }) {
  const have = [];
  if (inputs.wateringDays.length) have.push(`${inputs.wateringDays.length} watering ${inputs.wateringDays.length === 1 ? 'day' : 'days'}`);
  if (inputs.runMinutes != null) have.push(`${inputs.runMinutes} minutes per zone`);
  if (inputs.headTypes.length) have.push(joinList(inputs.headTypes.map((t) => HEAD_LABELS[t] || t)));
  const haveClause = have.length ? ` — ${joinList(have)} — ` : ' for you, ';
  const reason = derived?.reason || 'missing_minutes';

  // Toggle conflict: this branch is only reachable with the toggle off when
  // a technician's first-hand observation says a system exists (hasSystem).
  // The blocker is the switch, not a missing field — complete inputs (or an
  // explicit inches entry) suppressed by the toggle must never be described
  // as absent (GH codex P1 on #3478 r13).
  if (toggleOff) {
    const scheduleOnFile = explicitInches != null || derived?.inchesPerWeek != null || have.length > 0;
    return `Our technician noted an in-ground sprinkler system at your property, but your portal has the irrigation system switched off${scheduleOnFile ? ", so the schedule on file isn't being counted" : ''}. If the system is running, switch it on under Irrigation in your portal ${SETUP_CLOSER} If it truly is off, you're all set — we'll plan around the rain alone.`;
  }

  // Inputs complete but unconvertible — the two declines that are not about
  // a missing field keep their own copy.
  if (reason === 'mixed_head_types') {
    return `Your sprinkler system is on file as ${joinList(inputs.headTypes.map((t) => HEAD_LABELS[t] || t))}, which put down water at very different rates, so we can't turn run time into inches on our own. If you know roughly how many inches your lawn gets each week, enter that ${PORTAL_IRRIGATION_ASK} ${SETUP_CLOSER}`;
  }
  if (reason === 'drip_only') {
    return `Your system is on file as drip, which waters beds rather than turf. If the lawn does get sprinkler water, add the head type and minutes per zone (or your weekly inches) ${PORTAL_IRRIGATION_ASK} ${SETUP_CLOSER}`;
  }
  // Legacy rows can hold a head type outside the spray/drip/rotor vocabulary
  // (new writes are restricted at the route). Complete inputs + an unknown
  // type must not fall through to "we don't know how long it runs" — every
  // other input may be on file.
  if (reason === 'unknown_head_type') {
    return `Your sprinkler system is on file${haveClause}but "${joinList(inputs.headTypes)}" isn't a head type we have a watering rate for. Pick In-ground Spray or Rotor ${PORTAL_IRRIGATION_ASK} (or enter your weekly inches, if you know them) ${SETUP_CLOSER}`;
  }
  // Complete inputs whose math exceeds any plausible weekly total (e.g. a
  // typo like 200 minutes) — asking for a "missing" field would be false.
  if (reason === 'implausible_total') {
    return `Your sprinkler schedule is on file${haveClause}but those numbers work out to more water each week than any lawn could use, so we suspect a typo. Double-check the minutes per zone ${PORTAL_IRRIGATION_ASK} (or enter your weekly inches, if you know them) ${SETUP_CLOSER}`;
  }

  // Enumerate EVERY missing input, not the derivation's first failure reason
  // — its checks are sequential, and naming only the first blocker sends the
  // customer through a second setup email after they comply (GH codex P1 on
  // #3478 r2). Single-blocker copy stays tailored; multiple blockers are
  // asked for together.
  const missing = [];
  const missingActions = [];
  if (!inputs.wateringDays.length) { missing.push('which days it runs'); missingActions.push('your watering days'); }
  if (inputs.runMinutes == null) { missing.push('how many minutes each zone runs'); missingActions.push('minutes per zone'); }
  if (!inputs.headTypes.length) { missing.push('what kind of heads it uses'); missingActions.push('your system type'); }

  if (missing.length === 1) {
    if (inputs.runMinutes == null) {
      return `We have your sprinkler system on file${haveClause}but not how many minutes each zone runs. Add that ${PORTAL_IRRIGATION_ASK} (or your weekly inches, if you know them) ${SETUP_CLOSER}`;
    }
    if (!inputs.wateringDays.length) {
      return `We have your sprinkler system on file${haveClause}but not which days it runs. Pick your watering days ${PORTAL_IRRIGATION_ASK} (or enter your weekly inches, if you know them) ${SETUP_CLOSER}`;
    }
    return `We have your sprinkler system on file${haveClause}but not what kind of heads it uses. Spray and rotor heads put down water at very different rates, so pick your system type ${PORTAL_IRRIGATION_ASK} (or enter your weekly inches, if you know them) ${SETUP_CLOSER}`;
  }
  if (missing.length > 1 && have.length) {
    return `We have your sprinkler system on file${haveClause}but not ${joinList(missing)}. Add ${joinList(missingActions)} ${PORTAL_IRRIGATION_ASK} (or your weekly inches, if you know them) ${SETUP_CLOSER}`;
  }
  return `We have a sprinkler system on file for you, but not how long or how often it runs. Add your watering days, minutes per zone and head type (or your weekly inches, if you know them) ${PORTAL_IRRIGATION_ASK} ${SETUP_CLOSER}`;
}

// Seeded confirm_schedule callout — still exactly right for a technician-
// recorded reading (20260801200000 seed; the 20260825000001 migration turned
// the block into {{schedule_note}} so a derived figure can say otherwise).
const TECH_SCHEDULE_NOTE = "That schedule came from our records rather than from you, so it may be out of date. If it looks right, you're all set — we'll keep checking the numbers every week. If it's changed, update it under Irrigation in your portal, or just reply to this email and tell us how you water.";

/**
 * Where the confirm_schedule figure came from. A DERIVED figure is the
 * customer's own entries run through a published head rate — say so, and
 * say which rate, so the customer can overrule it with a real number.
 */
function buildScheduleNote({ scheduleSource, derived, scheduleFmt, rainSensor = false }) {
  if (scheduleSource !== 'portal_derived' || !derived) return TECH_SCHEDULE_NOTE;
  // A rain sensor can skip programmed runs in a wet week. Which runs it
  // skipped is unknowable (threshold and hold time are not on file), so the
  // balance deliberately assumes the full program ran — the note SAYS so,
  // and the disclosure keeps a sensor-skipped week's "ease back" honest as
  // an upper bound rather than silently overstating delivered water.
  const sensorClause = rainSensor
    ? ' Since you have a rain sensor, some of those runs may have been skipped after rain — this figure assumes the full schedule ran, so read it as the most your system would have applied.'
    : '';
  return `We worked that ${scheduleFmt}" out from what you entered under Irrigation in your portal — ${describeRuntimeBasis(derived)} — using the typical ${HEAD_LABELS[derived.headType] || derived.headType} rate from University of Florida turf guidance (about ${formatInches(derived.rateInPerHr)}" per hour).${sensorClause} If you know your actual weekly inches, enter them there and we'll use your number instead.`;
}

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

// Attribution for a radar/gauge-measured week, matching the lawn report's rule
// (LawnReportV2 measuredSourceNote): shown ONLY when the figure really is
// MRMS-derived, never over a pure model week. Empty string → the template's
// paragraph renders nothing, same as forecast_line.
function rainSourceNote(rainSource) {
  return String(rainSource || '').startsWith('mrms')
    ? 'Based on NOAA radar and rain-gauge data — local totals may vary.'
    : '';
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
  // Runtime the customer entered instead of inches: minutes per zone ×
  // watering days × head type → inches via @waves/irrigation-runtime.
  irrigationRunMinutes = null,
  wateringDays = null,
  irrigationSystemType = null,
  rainSensor = null,
  rainSource = null,
  rainfallInches7d = null,
  et0Inches = null,
  forecastRainInches = null,
} = {}) {
  // Same fallback chain, same precedence, as the lawn report's
  // buildLawnWaterContext (report-data.js): PORTAL ENTRY WINS, then a
  // tech-recorded turf-profile reading, then the latest assessment. The two
  // surfaces must agree — a customer whose report shows 1" must never get an
  // email claiming we have no schedule for them (codex #3138 r1 P2).
  const turfType = String(turfIrrigationType || '').trim().toLowerCase();
  // Only a POSITIVE explicit entry is an authoritative schedule — the advice
  // engine (buildIrrigationAdvice) and the portal UI both treat <= 0 as "no
  // schedule", so a zero here must fall through to the runtime derivation
  // rather than block it and then read as missing anyway.
  const prefsInchesRaw = numberOrNull(irrigationInchesPerWeek);
  const prefsInches = prefsInchesRaw != null && prefsInchesRaw > 0 ? prefsInchesRaw : null;
  // A figure DERIVED from the customer's own runtime entries. It is still a
  // portal entry (their minutes, their days, their heads) so it outranks a
  // tech reading — but their explicit inches number always outranks it: the
  // head rate is a published typical, not a measurement of their system.
  const runtimeInputs = normalizeRuntimeInputs({ runMinutes: irrigationRunMinutes, wateringDays, systemType: irrigationSystemType });
  const derived = deriveIrrigationInchesPerWeek({ runMinutes: irrigationRunMinutes, wateringDays, systemType: irrigationSystemType });
  // A toggle turned OFF means the runtime entries describe a system the
  // customer says is not running — no figure may be derived from them, and
  // any tech reading falls through as before. (A typed inches value keeps
  // the existing prefs-only suppression semantics below; without this gate,
  // a coexisting tech reading made onlyPrefsReading false and the disabled
  // derived schedule silently won the balance.)
  const derivedInches = prefsInches == null && irrigationSystem !== false ? derived.inchesPerWeek : null;
  // A technician recording irrigation_type 'none' is saying this property
  // does not irrigate. Any tech-sourced inches alongside that are
  // contradictory, and adding them to the balance would tell the customer
  // their lawn received water it never got (codex #3138 r2 P1). The
  // customer's OWN portal entry still stands — if they typed a number, they
  // water, whatever the type column says.
  const techReadingsUsable = turfType !== 'none';
  const turfInches = techReadingsUsable ? numberOrNull(turfIrrigationInchesPerWeek) : null;
  const assessmentInches = techReadingsUsable ? numberOrNull(assessmentIrrigationInchesPerWeek) : null;
  const effectiveInches = prefsInches != null ? prefsInches
    : (derivedInches != null ? derivedInches
      : (turfInches != null ? turfInches : assessmentInches));
  // …and the same suppression semantics: the portal toggle only zeroes a
  // value the customer did NOT enter — i.e. when the prefs reading is the
  // only one there is. A tech-recorded reading is never suppressed by the
  // customer's toggle.
  const onlyPrefsReading = turfInches == null && assessmentInches == null && (prefsInches != null || derivedInches != null);
  // WHERE the schedule came from decides which copy is truthful, so it is
  // tracked alongside the value itself.
  const scheduleSource = prefsInches != null ? 'portal'
    : (derivedInches != null ? 'portal_derived'
      : (turfInches != null ? 'turf' : (assessmentInches != null ? 'assessment' : null)));

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
        // setup_schedule's callout ({{schedule_ask}}): what is on file and
        // the one input still missing. setup_system has no such block, and
        // an empty optional variable renders nothing.
        schedule_ask: hasSystem ? buildScheduleAsk({ derived, inputs: runtimeInputs, toggleOff: irrigationSystem === false, explicitInches: prefsInches }) : '',
        forecast_line: forecastLine({
          forecastRainInches,
          status: advice.status,
          targetInches: advice.recommendedInchesPerWeek,
        }),
        customer_portal_url: buildPortalUrl('/?tab=property'),
        rain_source_note: rainSourceNote(rainSource),
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

  const grassLabel = customerGrassLabel(grassType);
  const rain = formatInches(rainfallInches7d);

  // Printed water math must add up EXACTLY as displayed — a customer checked
  // (2026-08-10): the email said 2.69" + 1.5" = 4.25" because the total came
  // from the advice engine's quarter-rounded appliedInchesPerWeek. The engine
  // keeps its quarter-inch rounding for banding/status; the PRINTED total is
  // the sum of the printed components, and the printed difference is the
  // printed total minus the printed target.
  const rainDisplayNum = roundHundredth(rainfallInches7d) ?? 0;
  const totalDisplayNum = roundHundredth(rainDisplayNum + roundHundredth(effectiveInches));
  const differenceDisplayNum = roundHundredth(Math.abs(totalDisplayNum - advice.recommendedInchesPerWeek));

  // A schedule we were told by a technician, not one the customer entered.
  // The advice templates would misattribute it and hand a hand-watering
  // customer sprinkler instructions, so the balance is reported in
  // source-neutral copy that asks them to confirm it instead (codex r2 P2).
  if (scheduleSource !== 'portal') {
    const scheduleFmt = formatInches(effectiveInches);
    const totalFmt = formatInches(totalDisplayNum);
    const targetFmt = formatInches(advice.recommendedInchesPerWeek);
    const diffFmt = formatInches(differenceDisplayNum);
    // Keyed on the measured status only — no forecast rerouting here, since
    // the neutral copy never prescribes an action for the week ahead.
    // A derived figure is the customer's OWN schedule (their minutes, days
    // and heads) expressed in inches — never "on file for you" from records.
    const scheduleClause = scheduleSource === 'portal_derived'
      ? `your sprinkler schedule as entered in your portal (about ${scheduleFmt}" per week)`
      : `the ${scheduleFmt}"-per-week watering schedule we have on file for you`;
    const neutralLead = advice.status === 'surplus'
      ? `Between the rain near your home last week (${rain}") and ${scheduleClause}, your lawn got about ${totalFmt}" of water — roughly ${diffFmt}" more than the ${targetFmt}" your ${grassLabel} needs this time of year.`
      : advice.status === 'deficit'
        ? `Between the rain near your home last week (${rain}") and ${scheduleClause}, your lawn got about ${totalFmt}" of water — roughly ${diffFmt}" short of the ${targetFmt}" your ${grassLabel} needs this time of year.`
        : `Between the rain near your home last week (${rain}") and ${scheduleClause}, your lawn got about ${totalFmt}" of water — right in line with the ${targetFmt}" your ${grassLabel} needs this time of year.`;
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
        schedule_note: buildScheduleNote({ scheduleSource, derived, scheduleFmt, rainSensor: rainSensor === true || rainSensor === 't' }),
        forecast_line: forecastLine({
          forecastRainInches,
          status: advice.status,
          targetInches: advice.recommendedInchesPerWeek,
        }),
        customer_portal_url: buildPortalUrl('/?tab=property'),
        rain_source_note: rainSourceNote(rainSource),
    company_phone: WAVES_SUPPORT_PHONE_DISPLAY,
        company_email: CONTACT_EMAIL,
      },
    };
  }
  // The RESOLVED schedule, not the raw prefs column — the copy must quote
  // the same number the advice was computed from (codex #3138 r1 P2).
  const irrigationFmt = formatInches(effectiveInches);
  const total = formatInches(totalDisplayNum);
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
    summaryLine = `Rain was light near your home last week (${rain}"), so with your irrigation schedule (${irrigationFmt}" per week) your lawn got about ${total}" of water — roughly ${formatInches(differenceDisplayNum)}" short of the ${target}" your ${grassLabel} needs this time of year.`;
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
    difference_inches: formatInches(differenceDisplayNum),
    ...(summaryLine ? { summary_line: summaryLine } : {}),
    // The forecast-rerouted cases explain the forecast in their summary_line —
    // a second forecast sentence would repeat it.
    forecast_line: (reason === 'deficit_rain_forecast' || reason === 'balanced_dry_forecast') ? '' : forecastLine({
      forecastRainInches,
      status: advice.status,
      targetInches: advice.recommendedInchesPerWeek,
    }),
    customer_portal_url: buildPortalUrl('/?tab=property'),
    rain_source_note: rainSourceNote(rainSource),
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

// The recurring-lawn-evidence WHERE, shared VERBATIM between the Monday
// sweep's audience (findEligibleCustomers) and the daily audience-gap check
// (findLawnEmailAudienceGaps). Two copies of one predicate diverge — the gap
// check must see exactly the evidence the sender sees, or it reports gaps
// the send doesn't have (or misses ones it does).
// The upcoming-visit branch of the evidence, as a correlated subquery
// builder — used inside recurringLawnEvidenceFilter's whereExists AND as a
// selected EXISTS column by findLawnEmailAudienceGaps (a customer whose only
// evidence is the trailing window has churned; stage/inactive on them is a
// legitimate drop, not a gap — Codex #3209 r1).
function upcomingLawnEvidenceBuilder(todayET) {
  return db('scheduled_services as ss')
    .select(db.raw('1'))
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
}

function recurringLawnEvidenceFilter(todayET, lawnServiceCutoff) {
  const lawnLikeSql = LAWN_SERVICE_TYPE_LIKES
    .map(() => 'LOWER(ss2.service_type) LIKE ?')
    .join(' OR ');
  const nonLivePlaceholders = NON_LIVE_VISIT_STATUSES.map(() => '?').join(', ');
  return function recurringLawnService() {
    // REQUIRED recurring-lawn evidence — tier / lawn_type / turf profile
    // never qualify a customer on their own (see the doc block above).
    this.whereExists(upcomingLawnEvidenceBuilder(todayET))
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
  };
}

// Does ONE customer carry the recurring-lawn evidence above? The portal's
// Weekly Inches field (and the PUT that stores it) gate on this — the same
// predicate the Monday sweep uses to decide who gets the irrigation email,
// so a customer the email asks for inches can always enter them. The
// tier / lawn_type shortcut in routes/property.js stays as a fast path;
// this is the authoritative fallback for standalone lawn-plan customers
// with no turf type on file (2026-08-27: a lawn customer's portal showed
// no Inches field on the day of her service).
async function hasRecurringLawnEvidence(customerId, { now = new Date() } = {}) {
  if (!customerId) return false;
  const lawnServiceCutoff = etDateString(addETDays(now, -LAWN_SERVICE_RECENCY_DAYS));
  const todayET = etDateString(now);
  const row = await db('customers as c')
    .where('c.id', customerId)
    .where(recurringLawnEvidenceFilter(todayET, lawnServiceCutoff))
    .first('c.id');
  return !!row;
}

async function findEligibleCustomers({ now = new Date() } = {}) {
  const lawnServiceCutoff = etDateString(addETDays(now, -LAWN_SERVICE_RECENCY_DAYS));
  const todayET = etDateString(now);
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
    .where(recurringLawnEvidenceFilter(todayET, lawnServiceCutoff))
    .select(
      'c.id',
      'c.first_name',
      'c.email',
      'c.latitude',
      'c.longitude',
      'pp.irrigation_inches_per_week',
      'pp.irrigation_system',
      // Rain sensor drives only the derived schedule_note disclosure — the
      // balance itself deliberately assumes the full program ran (which runs
      // a sensor skipped is unknowable; never impute).
      'pp.rain_sensor',
      // Runtime entries — minutes per zone × watering days × head type — the
      // natural-unit schedule @waves/irrigation-runtime converts to inches
      // when the inches column itself is blank.
      'pp.irrigation_run_minutes',
      'pp.watering_days',
      'pp.irrigation_system_type',
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
      // …and only CONFIRMED assessments (codex #3138 r2 P1). `confirmed_by_tech`
      // defaults false, so an in-progress draft would otherwise drive customer
      // email. Every other customer-facing read gates on it the same way
      // (routes/lawn-health.js:191,358). This is a VALIDITY filter, not a value
      // filter — unconfirmed rows are not readings yet, so removing them before
      // ORDER BY is correct and does not reintroduce the skipped-newer-zero bug.
      db.raw(`(
        SELECT la.irrigation_inches_per_week
          FROM lawn_assessments la
         WHERE la.customer_id = c.id
           AND la.confirmed_by_tech = true
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
        irrigationRunMinutes: customer.irrigation_run_minutes,
        wateringDays: customer.watering_days,
        irrigationSystemType: customer.irrigation_system_type,
        rainSensor: customer.rain_sensor === true || customer.rain_sensor === 't',
        rainfallInches7d: weekWeather.rainInches,
        et0Inches: weekWeather.et0Inches,
        rainSource: weekWeather.rainSource,
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

/**
 * Recurring-lawn customers who would MISS the Monday email — the complement
 * of findEligibleCustomers over the SAME evidence predicate
 * (recurringLawnEvidenceFilter), so this check cannot diverge from the send.
 * The audience is computed at send time, so there is no enrollment list to
 * reconcile; the only drift class is a customer WITH recurring-lawn evidence
 * failing a prerequisite. Returns ONLY pageable gaps (Codex #3209 r1):
 *  - Opted-out customers (email_enabled / seasonal_tips = false) never
 *    appear — this email is optional; their other missing fields are not
 *    defects to fix for a send they declined.
 *  - Prerequisites use the SEND PATH's validators, not null checks: an
 *    unusable email ('not-an-email') or non-finite coordinates would pass
 *    selection and then be skipped by the sender — those are gaps too.
 *  - Stage/inactive failures page only with LIVE FUTURE recurring evidence;
 *    trailing-window-only evidence on a non-customer stage is legitimate
 *    churn, not something to "fix".
 */
async function findLawnEmailAudienceGaps({ now = new Date() } = {}) {
  const lawnServiceCutoff = etDateString(addETDays(now, -LAWN_SERVICE_RECENCY_DAYS));
  const todayET = etDateString(now);
  const rows = await db('customers as c')
    .leftJoin('notification_prefs as np', 'np.customer_id', 'c.id')
    .whereNull('c.deleted_at')
    .where(recurringLawnEvidenceFilter(todayET, lawnServiceCutoff))
    .select(
      'c.id', 'c.first_name', 'c.last_name', 'c.email', 'c.latitude', 'c.longitude',
      'c.active', 'c.pipeline_stage',
      db.raw('(np.email_enabled IS DISTINCT FROM false) as email_pref_ok'),
      db.raw('(np.seasonal_tips IS DISTINCT FROM false) as tips_pref_ok'),
      db.raw('exists(?) as has_future_evidence', [upcomingLawnEvidenceBuilder(todayET)]),
    );
  const gaps = [];
  for (const r of rows) {
    // Intentional opt-out: never pageable, whatever else is missing.
    if (!r.email_pref_ok || !r.tips_pref_ok) continue;
    const isCustomer = CUSTOMER_STAGES.includes(r.pipeline_stage) && r.active === true;
    // Trailing-window evidence on a non-customer = churn, a legitimate drop.
    if (!isCustomer && !r.has_future_evidence) continue;
    const fixable = [];
    if (!isCustomer) {
      if (!CUSTOMER_STAGES.includes(r.pipeline_stage)) fixable.push(`pipeline_stage=${r.pipeline_stage}`);
      if (r.active !== true) fixable.push('inactive');
    }
    // Mirror the sender's own validators: it skips non-email-like addresses
    // (isEmailLike) and can't fetch weather without finite coordinates
    // (numberOrNull) — a non-null-but-unusable value is still a gap. 0,0 is
    // a failed geocode (the Gulf of Guinea, never a Waves property):
    // fetchServiceWeekWeather returns empty weather for it, so the sender
    // selects and then silently skips the customer as rain_unknown — that
    // guard must count as a gap here too.
    if (!isEmailLike(r.email)) fixable.push(r.email ? 'unusable_email' : 'no_email');
    const lat = numberOrNull(r.latitude);
    const lng = numberOrNull(r.longitude);
    if (lat == null || lng == null) fixable.push('no_coordinates');
    else if (lat === 0 && lng === 0) fixable.push('placeholder_coordinates');
    if (fixable.length === 0) continue;
    gaps.push({
      customerId: r.id,
      name: [r.first_name, r.last_name].filter(Boolean).join(' '),
      fixable,
    });
  }
  return gaps;
}

// Membership evidence is AUTHORITATIVE CURRENT STATE — the same
// hasMembership predicate the membership lifecycle emails key off (extracted
// to services/membership-state.js, one shared copy). Email history was
// deliberately abandoned as evidence here (codex #3341 r4 + pre-push P1
// chain): email_messages rows are delivery artifacts — senders skip when the
// address is missing/invalid — so a no-email member (exactly the class a gap
// check exists to find) never accumulates email evidence, cancellation
// leaves started rows behind, and reactivation emits a different key. The
// customers row is current-state truth for all of those at once.

/**
 * Membership-evidence gap leg (owner ruling 2026-08-10). The evidence-based
 * gap check above shares the sender's predicate BY DESIGN, which leaves one
 * blind spot: a customer whose CURRENT state says recurring member
 * (hasMembership on the customers row — real tier or paid monthly rate,
 * excluding auto-derived label-only rows) but whose lawn visits were never
 * stamped as a recurring series and who has no demonstrated cadence yet. They fail the evidence filter, so the Monday
 * sweep AND findLawnEmailAudienceGaps are both blind to them — indefinitely,
 * not just for one week (verified live 2026-08-10: a new member's first lawn
 * visit booked as a one-time, no future row). This leg pages that class; the
 * fix is operational (book/stamp their series) — it never widens the send
 * audience itself.
 *
 * Membership evidence alone is deliberately NOT lawn evidence (memberships
 * span pest and lawn programs), so the leg also requires a live lawn-flavored
 * visit on or after the trailing cutoff — future visits included, since an
 * unstamped future one-time booking is exactly the "stamp the series" case.
 * A pest-only member with a single one-time lawn add-on can page here; that
 * is an accepted false positive (one dismissible card) — the alternative is
 * a real member silently excluded forever.
 */
async function findUnstampedRecurringLawnMembers({ now = new Date() } = {}) {
  const lawnServiceCutoff = etDateString(addETDays(now, -LAWN_SERVICE_RECENCY_DAYS));
  const todayET = etDateString(now);
  const lawnLikeSql = LAWN_SERVICE_TYPE_LIKES
    .map(() => 'LOWER(ss3.service_type) LIKE ?')
    .join(' OR ');
  const nonLivePlaceholders = NON_LIVE_VISIT_STATUSES.map(() => '?').join(', ');
  const rows = await db('customers as c')
    .leftJoin('notification_prefs as np', 'np.customer_id', 'c.id')
    .whereNull('c.deleted_at')
    // Only live customers: a churned/lead-stage member with unstamped visits
    // is not a send-audience loss (stage alone already excludes them).
    .whereIn('c.pipeline_stage', CUSTOMER_STAGES)
    .where('c.active', true)
    // NOT already visible to the sweep (or to the evidence-based gap legs,
    // which cover everything this filter admits).
    .whereNot(recurringLawnEvidenceFilter(todayET, lawnServiceCutoff))
    // A live lawn-flavored visit since the trailing cutoff (no upper bound —
    // an unstamped FUTURE one-time lawn booking is still this class).
    .whereRaw(
      `EXISTS (SELECT 1 FROM scheduled_services ss3
         WHERE ss3.customer_id = c.id
           AND ss3.status NOT IN (${nonLivePlaceholders})
           AND ss3.scheduled_date >= ?
           AND (${lawnLikeSql}))`,
      [...NON_LIVE_VISIT_STATUSES, lawnServiceCutoff, ...LAWN_SERVICE_TYPE_LIKES],
    )
    // …plus a coarse SQL prefilter for membership state; the EXACT rule
    // (tier-key normalization, non-membership labels, auto-derived
    // label-only rows) runs in JS below via the shared hasMembership /
    // isAutoDerivedTierLabelRow predicates — never a SQL re-implementation
    // that could diverge from them.
    .where(function membershipStatePrefilter() {
      this.whereNotNull('c.waveguard_tier').orWhere('c.monthly_rate', '>', 0);
    })
    .select(
      'c.id', 'c.first_name', 'c.last_name', 'c.email', 'c.latitude', 'c.longitude',
      // Fields the exact membership predicates below read.
      'c.waveguard_tier', 'c.monthly_rate', 'c.waveguard_tier_source', 'c.billing_mode',
      db.raw('(np.email_enabled IS DISTINCT FROM false) as email_pref_ok'),
      db.raw('(np.seasonal_tips IS DISTINCT FROM false) as tips_pref_ok'),
      // The most recent visit evidencing the class, so the watchdog can key
      // its dedupe to the OFFENDING BOOKING (codex #3341 r3 P2): a customer
      // fixed once and regressed later — stamped series cancelled, replaced
      // by another one-time — carries a new visit id and pages again,
      // while the same unresolved card stays deduped day after day.
      db.raw(
        `(SELECT ss4.id FROM scheduled_services ss4
           WHERE ss4.customer_id = c.id
             AND ss4.status NOT IN (${nonLivePlaceholders})
             AND ss4.scheduled_date >= ?
             AND (${lawnLikeSql.replace(/ss3\./g, 'ss4.')})
           ORDER BY ss4.scheduled_date DESC, ss4.id DESC LIMIT 1) as trigger_visit_id`,
        [...NON_LIVE_VISIT_STATUSES, lawnServiceCutoff, ...LAWN_SERVICE_TYPE_LIKES],
      ),
    );
  // Lazy requires: self-booking-plan-sync is a heavy module and this leg
  // runs once per daily watchdog tick.
  const { hasMembership } = require('./membership-state');
  const { isAutoDerivedTierLabelRow } = require('./self-booking-plan-sync');
  const { resolveBillingLane } = require('./billing-lane');
  const gaps = [];
  // Intentional opt-out: never pageable, same rule as the evidence legs.
  // Membership must hold under the EXACT shared predicates: hasMembership
  // (real tier or paid monthly rate) minus auto-derived label-only rows —
  // the same pairing the lifecycle emails use (admin-customers.js) — and
  // the resolved billing lane must not be one_time (codex #3341 r5 P2):
  // an explicit one_time lane means NO recurring relationship no matter
  // what tier/rate values linger on the row, the same lane gate
  // sendMembershipStarted suppresses on. resolveBillingLane is the
  // existing resolver; per_visit/per_application stay in — a real tier
  // billed at completion IS an ongoing plan.
  for (const r of rows.filter((row) => row.email_pref_ok && row.tips_pref_ok
    && hasMembership(row) && !isAutoDerivedTierLabelRow(row)
    && resolveBillingLane(row).mode !== 'one_time')) {
    // Same prerequisite validators as findLawnEmailAudienceGaps (codex
    // #3341 r1 P2): stamping the series makes the customer evidence-
    // positive, but the SENDER still skips an unusable email or bad
    // coordinates — one card must list everything standing between the
    // customer and Monday, or the operator fixes half and gets paged
    // again by the evidence leg on a later run.
    const fixable = ['no_recurring_marked_lawn_visit'];
    if (!isEmailLike(r.email)) {
      fixable.push(r.email ? 'unusable_email' : 'no_email');
    } else {
      // Active suppressions block sendTemplate even after stamping (codex
      // #3341 r2 P2) — evaluated with the sender's OWN gate on this
      // sweep's stream, never a copy of its rules. ALL applicable rows are
      // inspected (r3 P2: several can be active at once, and an arbitrary
      // first match let a bounce mask a coexisting opt-out): any consent
      // suppression (do_not_email, spam_complaint, unsubscribes incl.
      // group-scoped) wins — the customer's own choice is never pageable,
      // same rule as the prefs opt-outs above. Only a pure bounce rides
      // the card as a fixable deliverability failure (the bounce-rescue
      // lane exists to repair addresses). The evidence legs don't need
      // this: their customers reach the sender, whose blocked operational
      // sends already alert (alertBlockedOperationalSend); this class
      // never reaches the sender, so this card is their only signal.
      const suppressions = await EmailTemplateLibrary.activeSuppressionsFor(
        { suppression_group_key: SUPPRESSION_GROUP }, r.email, SUPPRESSION_GROUP,
      );
      if (suppressions.length) {
        const allBounces = suppressions.every(
          (row) => String(row.suppression_type || '').toLowerCase() === 'bounce',
        );
        if (!allBounces) continue;
        fixable.push('bounced_email');
      }
    }
    const lat = numberOrNull(r.latitude);
    const lng = numberOrNull(r.longitude);
    if (lat == null || lng == null) fixable.push('no_coordinates');
    else if (lat === 0 && lng === 0) fixable.push('placeholder_coordinates');
    gaps.push({
      customerId: r.id,
      name: [r.first_name, r.last_name].filter(Boolean).join(' '),
      kind: 'unstamped_member',
      fixable,
      triggerVisitId: r.trigger_visit_id || null,
    });
  }
  return gaps;
}

module.exports = {
  runWeeklyIrrigationEmailSweep,
  buildWeeklyEmailDecision,
  findUnstampedRecurringLawnMembers,
  findEligibleCustomers,
  findLawnEmailAudienceGaps,
  hasRecurringLawnEvidence,
  fetchUpcomingWeekRainForecast,
  TEMPLATE_CUT_BACK,
  TEMPLATE_ADD_WATER,
  TEMPLATE_ON_TRACK,
  TEMPLATE_SETUP_SCHEDULE,
  TEMPLATE_SETUP_SYSTEM,
  TEMPLATE_CONFIRM_SCHEDULE,
  _private: { forecastLine, rainSourceNote, lastCompletedWeekEnding, formatInches, monthFromYmd, resolveGrassType, customerGrassLabel, sanitizeFailureReason, buildScheduleAsk, buildScheduleNote, TECH_SCHEDULE_NOTE },
};
