'use strict';

/**
 * Weekly irrigation recommendation email.
 *
 * Monday-morning email to active lawn-care customers who entered a weekly
 * irrigation-inches value in the customer portal (My Property → Irrigation).
 * Reuses the service report's water balance: last week's rainfall + reference
 * ET₀ at the customer's own lat/lng (fetchServiceWeekWeather) fed through
 * buildIrrigationAdvice. Only a clear surplus ("cut back") or deficit ("add
 * water") sends — balanced weeks and weeks with unknown rainfall send nothing,
 * so the email stays a signal, not a newsletter.
 *
 * Templates (seeded by 20260702000001_seed_irrigation_weekly_email_templates.js):
 *   irrigation.weekly_cut_back
 *   irrigation.weekly_add_water
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
const { etDateString, addETDays, etParts } = require('../utils/datetime-et');
const { portalUrl: buildPortalUrl } = require('../utils/portal-url');
const { WAVES_SUPPORT_PHONE_DISPLAY } = require('../constants/business');

const CONTACT_EMAIL = 'contact@wavespestcontrol.com';
const SUPPRESSION_GROUP = 'service_operational';
const TEMPLATE_CUT_BACK = 'irrigation.weekly_cut_back';
const TEMPLATE_ADD_WATER = 'irrigation.weekly_add_water';

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
  if (status === 'deficit' && target != null && forecast >= target) {
    return `${base} — that alone could cover what your lawn needs, so watch the weather before adding sprinkler time.`;
  }
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
  rainfallInches7d = null,
  et0Inches = null,
  forecastRainInches = null,
} = {}) {
  const advice = buildIrrigationAdvice({
    grassType,
    month: monthFromYmd(weekEnding),
    irrigationInchesPerWeek,
    rainfallInches7d,
    referenceEt0InchesWeek: et0Inches,
    // Eligibility already required the portal toggle on; a stale-false here
    // would wrongly zero out the schedule the customer just confirmed.
    irrigationEnabled: true,
  });

  // Only a clear, actionable imbalance sends. 'rain_unknown' means we could
  // not trust a full week of rainfall — never guess at a recommendation. A
  // surplus CAN be reported without rainfall (irrigation alone over target),
  // but this email quotes the week's rain number, so it too requires a full
  // rain window — never tell a customer it rained 0" when we just don't know.
  if ((advice.status !== 'surplus' && advice.status !== 'deficit') || !advice.rainKnown) {
    return { shouldSend: false, reason: advice.rainKnown ? advice.status : 'rain_unknown', advice };
  }

  const surplus = advice.status === 'surplus';
  const differential = Math.abs(numberOrNull(advice.differentialInchesPerWeek) ?? 0);
  const payload = {
    first_name: String(firstName || '').trim() || 'there',
    grass_label: customerGrassLabel(grassType),
    week_ending: weekEnding,
    rain_last_week: formatInches(rainfallInches7d),
    irrigation_inches: formatInches(irrigationInchesPerWeek),
    total_inches: formatInches(advice.appliedInchesPerWeek),
    target_inches: formatInches(advice.recommendedInchesPerWeek),
    difference_inches: formatInches(differential),
    forecast_line: forecastLine({
      forecastRainInches,
      status: advice.status,
      targetInches: advice.recommendedInchesPerWeek,
    }),
    customer_portal_url: buildPortalUrl('/?tab=property'),
    company_phone: WAVES_SUPPORT_PHONE_DISPLAY,
    company_email: CONTACT_EMAIL,
  };

  return {
    shouldSend: true,
    templateKey: surplus ? TEMPLATE_CUT_BACK : TEMPLATE_ADD_WATER,
    reason: advice.status,
    advice,
    payload,
  };
}

/**
 * Active lawn-care customers with a portal-entered weekly irrigation schedule:
 * live customer + irrigation toggle ON + inches entered + an email and
 * coordinates to work with + lawn-care membership (mirrors
 * lawn-health.js hasCustomerLawnCare: active turf profile, or waveguard_tier /
 * lawn_type on the customer, or any lawn-flavored scheduled service).
 * Customers who turned email off portal-wide (notification_prefs.email_enabled
 * = false) are excluded — this is an optional nudge, not a required notice
 * (same rule as booking-abandon-recovery's customerEmailDisabled).
 */
async function findEligibleCustomers() {
  return db('customers as c')
    .join('property_preferences as pp', 'pp.customer_id', 'c.id')
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
    .whereNotNull('c.email')
    .whereNotNull('c.latitude')
    .whereNotNull('c.longitude')
    .where('pp.irrigation_system', true)
    .whereNotNull('pp.irrigation_inches_per_week')
    .where('pp.irrigation_inches_per_week', '>', 0)
    .where(function lawnMembership() {
      this.whereNotNull('tp.id')
        .orWhereNotNull('c.waveguard_tier')
        .orWhereNotNull('c.lawn_type')
        .orWhereExists(function lawnService() {
          this.select(db.raw('1'))
            .from('scheduled_services as ss')
            .whereRaw('ss.customer_id = c.id')
            .where(function serviceTypes() {
              this.whereRaw("LOWER(ss.service_type) LIKE ?", ['%lawn%'])
                .orWhereRaw("LOWER(ss.service_type) LIKE ?", ['%waveguard%'])
                .orWhereRaw("LOWER(ss.service_type) LIKE ?", ['%fertiliz%'])
                .orWhereRaw("LOWER(ss.service_type) LIKE ?", ['%fungicide%'])
                .orWhereRaw("LOWER(ss.service_type) LIKE ?", ['%turf%']);
            });
        });
    })
    .select(
      'c.id',
      'c.first_name',
      'c.email',
      'c.latitude',
      'c.longitude',
      'pp.irrigation_inches_per_week',
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
  const candidates = await findEligibleCustomers();

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
    skipped: { balanced: 0, rain_unknown: 0, unknown: 0, missing_email: 0, capped: 0 },
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
    + `${summary.skipped.balanced} balanced, ${summary.skipped.rain_unknown} rain-unknown, ${summary.failed} failed`,
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
  _private: { forecastLine, lastCompletedWeekEnding, formatInches, monthFromYmd, resolveGrassType, customerGrassLabel, sanitizeFailureReason },
};
