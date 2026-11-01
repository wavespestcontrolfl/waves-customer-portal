'use strict';

/**
 * Public lawn watering plan (GET /api/public/watering-plan, GATE_PUBLIC_WATERING_PLAN).
 *
 * Owner 2026-10-31, backlink tools plan step 2 ("ok go, approved"): a free,
 * embeddable watering calculator. One answer per curated Florida location or
 * ZIP: how much rain fell in the last 7 days, what the plan week's forecast
 * says, what the turf needs, and what to do this week.
 *
 * It reuses the engine behind the Monday irrigation email and builds nothing
 * new:
 *   observed rain + ET0   service-report/application-conditions fetchServiceWeekWeather
 *                         (NOAA MRMS merged with Open-Meteo, 7 days ending yesterday)
 *   plan-week forecast    irrigation-weekly-email fetchUpcomingWeekForecast
 *                         (rain + ET0 from today through the plan week's Sunday)
 *   weekly need           service-report/irrigation-advice buildIrrigationAdvice
 *                         (ET0 x crop coefficient, seasonal fallback)
 *   the decision          @waves/irrigation-runtime buildWeekPlan, the engine
 *                         decideWeekPlan wraps, called directly because a public
 *                         caller has no customer row and the legal policy is an INPUT
 *   copy                  irrigation-week-plan renderWeekPlanReport
 *
 * Differences from the email, all forced by "no customer on file":
 *   - last week's applied water is unknown (we do not know the sprinkler
 *     schedule), so carryover comes from observed RAIN only (rainOnlyCarryover);
 *   - the observed window is the 7 days ending yesterday, not the completed
 *     Monday-to-Sunday week, because a public caller may ask on any day;
 *   - the plan week is Monday to Sunday like the email's, except on a Sunday it
 *     is the coming week (the email never runs on a Sunday);
 *   - the forecast covers today through the plan week's Sunday, so its ET0 is
 *     scaled to a 7-day figure before it sizes the weekly need.
 *
 * Owner rulings carried over (comments at the top of irrigation-week-plan.js):
 * the legal restriction is a hard ceiling above the model and is NEVER
 * invented. currentRestrictionPolicy fails closed (null) outside established
 * coverage, and then the answer is `need_only`: the week's need in inches with
 * no event count and no legal maximum. Copy says "each turf zone", "skip your
 * turf watering", "your permitted watering day" and never names a weekday.
 *
 * No paid AI, no database access, no writes, nothing sent to anyone.
 */

const logger = require('./logger');
const { buildWeekPlan, defaultEventMinutes, WEEK_PLAN_CONSTANTS } = require('@waves/irrigation-runtime');
const { resolveLocation, BY_SLUG } = require('./pest-forecast/locations');
const { freshUntil } = require('./pest-forecast/weather');
const { buildIrrigationAdvice, isKnownGrass, _private: advicePrivate } = require('./service-report/irrigation-advice');
const { resolveRateTable, ratesForTable } = require('./irrigation-rates');
const { renderWeekPlanReport, _private: planPrivate } = require('./irrigation-week-plan');
const { currentRestrictionPolicy, resolveRestrictionCounty } = require('../config/irrigation-restrictions');
const { etDateString, addETDays, etParts } = require('../utils/datetime-et');

const LANDING_URL = 'https://www.wavespestcontrol.com/tools/lawn-watering-calculator/';
const BRAND = 'Waves Pest Control';
const DISCLAIMER = 'This is a weather-based estimate, not a measurement of your yard, and your local watering rules always come first.';

const GRASS_TYPES = Object.freeze(['st_augustine', 'zoysia', 'bahia', 'bermuda', 'unknown']);
const HEAD_TYPES = Object.freeze(['spray', 'rotor']);
const MIN_MINUTES = 1;
const MAX_MINUTES = 240;
const SLUG_RE = /^[a-z0-9-]{1,64}$/;
const ZIP_RE = /^\d{5}$/;

// ---------------------------------------------------------------------------
// Watering rules pages. County -> water management district -> page.
// URL check date: 2026-10-31, `curl -sL -o /dev/null -w '%{http_code}'` = 200 for
// every URL below except SJRWMD: sjrwmd.com answers 403 to a plain curl on every
// path (bot filter), so no SJRWMD page could be verified. Its counties point at
// the Florida DEP water conservation page (200), which links to every district's
// conservation page. Swap in an SJRWMD page once one can be verified.
// Charlotte, Orange and Polk straddle two districts; the district that holds most
// of the county is used and the page says to check the city or county first.
// ---------------------------------------------------------------------------
const DISTRICTS = Object.freeze({
  swfwmd: { name: 'Southwest Florida Water Management District', rulesUrl: 'https://www.swfwmd.state.fl.us/business/epermitting/district-water-restrictions' },
  sfwmd: { name: 'South Florida Water Management District', rulesUrl: 'https://www.sfwmd.gov/community-residents/water-shortage' },
  sjrwmd: { name: 'St. Johns River Water Management District', rulesUrl: 'https://floridadep.gov/owper/water-policy/content/water-conservation' },
  nwfwmd: { name: 'Northwest Florida Water Management District', rulesUrl: 'https://nwfwater.com/water-resources/conservation/' },
});
const COUNTY_DISTRICT = Object.freeze({
  Manatee: 'swfwmd',
  Sarasota: 'swfwmd',
  Charlotte: 'swfwmd',
  Hillsborough: 'swfwmd',
  Pinellas: 'swfwmd',
  Polk: 'swfwmd',
  Lee: 'sfwmd',
  Collier: 'sfwmd',
  'Miami-Dade': 'sfwmd',
  Broward: 'sfwmd',
  'Palm Beach': 'sfwmd',
  Orange: 'sjrwmd',
  Duval: 'sjrwmd',
  Leon: 'nwfwmd',
});
// A county not in the table (never a curated one today) gets the statewide page.
const FALLBACK_DISTRICT = DISTRICTS.sjrwmd.rulesUrl;

function rulesFor(county) {
  const district = DISTRICTS[COUNTY_DISTRICT[county]];
  return district
    ? { url: district.rulesUrl, districtName: district.name }
    : { url: FALLBACK_DISTRICT, districtName: 'your water management district' };
}

// ---------------------------------------------------------------------------
// Query parsing. Strict: a value that is present and wrong is a 400, never a
// silent default. A blank value counts as absent (form embeds send blanks).
// Unknown query keys are ignored (cache-busters).
// ---------------------------------------------------------------------------
function textParam(query, name) {
  const raw = query ? query[name] : undefined;
  if (raw === undefined) return { present: false };
  if (typeof raw !== 'string') return { present: true, invalid: true };
  const value = raw.trim();
  return value === '' ? { present: false } : { present: true, value };
}

function bad(error, message) {
  return { ok: false, error, message };
}

function parseLocationParams(query) {
  const loc = textParam(query, 'location');
  const zip = textParam(query, 'zip');
  if (loc.invalid || (loc.present && !SLUG_RE.test(loc.value))) return bad('invalid_location', 'location must be a city slug such as bradenton-fl.');
  if (zip.invalid || (zip.present && !ZIP_RE.test(zip.value))) return bad('invalid_zip', 'zip must be a 5-digit ZIP code.');
  if (!loc.present && !zip.present) return bad('location_required', 'Send location (a city slug) or zip (a 5-digit Florida ZIP code).');

  if (loc.present) {
    if (!BY_SLUG.has(loc.value)) return bad('unknown_location', 'That location is not on the list. See /api/public/pest-forecast/locations.');
    const location = resolveLocation({ location: loc.value });
    return { ok: true, location, county: location.county || null, policyCounty: location.county || null };
  }
  const location = resolveLocation({ zip: zip.value });
  // resolveLocation falls back to its default for a ZIP outside Florida's
  // curated prefixes. A watering answer for the wrong state is worse than none.
  if (!BY_SLUG.has(location.slug)) return bad('unsupported_zip', 'That ZIP code is not in a supported Florida area. Try a city slug instead.');
  // The county that decides the legal ceiling comes from the ZIP itself
  // (null when the ZIP straddles a county line: fail closed), never from the
  // nearest curated city, which can sit in the next county.
  const zipCounty = resolveRestrictionCounty({ zip: zip.value });
  return { ok: true, location, county: zipCounty || location.county || null, policyCounty: zipCounty };
}

function parseOptionChoice(query, name, choices) {
  const param = textParam(query, name);
  if (param.invalid || (param.present && !choices.includes(param.value))) return bad(`invalid_${name}`, `${name} must be one of ${choices.join(', ')}.`);
  return { ok: true, value: param.present ? param.value : null };
}

function parseMinutes(query) {
  const param = textParam(query, 'minutes');
  if (!param.present) return { ok: true, value: null };
  const n = param.invalid || !/^\d{1,3}$/.test(param.value) ? NaN : Number(param.value);
  if (!Number.isInteger(n) || n < MIN_MINUTES || n > MAX_MINUTES) return bad('invalid_minutes', `minutes must be a whole number from ${MIN_MINUTES} to ${MAX_MINUTES}.`);
  return { ok: true, value: n };
}

function parseWateringQuery(query) {
  const where = parseLocationParams(query);
  if (!where.ok) return where;
  const grass = parseOptionChoice(query, 'grass', GRASS_TYPES);
  if (!grass.ok) return grass;
  const head = parseOptionChoice(query, 'head', HEAD_TYPES);
  if (!head.ok) return head;
  const minutes = parseMinutes(query);
  if (!minutes.ok) return minutes;
  const sensor = parseOptionChoice(query, 'sensor', ['0', '1']);
  if (!sensor.ok) return sensor;

  return {
    ok: true,
    value: {
      location: where.location,
      // The county the response reports and the rules page is chosen from.
      county: where.county,
      // The county the legal ceiling is judged in: a ZIP request uses only a county the ZIP establishes.
      policyCounty: where.policyCounty,
      grass: grass.value && grass.value !== 'unknown' ? grass.value : null,
      head: head.value,
      // Minutes mean nothing without a head type; ignored then.
      minutes: head.value ? minutes.value : null,
      sensor: sensor.value === '1',
    },
  };
}

// ---------------------------------------------------------------------------
// Plan week. Monday to Sunday, the same horizon the Monday email uses
// (lastCompletedWeekEnding + 7). On a Sunday it is the coming week.
// ---------------------------------------------------------------------------
function planWeekBounds(now = new Date()) {
  const { dayOfWeek } = etParts(now);
  const toSunday = dayOfWeek === 0 ? 7 : 7 - dayOfWeek;
  return {
    start: etDateString(addETDays(now, toSunday - 6)),
    end: etDateString(addETDays(now, toSunday)),
  };
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

function finiteOrNull(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// ---------------------------------------------------------------------------
// The decision and its copy. Pure: no network, no clock besides `now`.
// ---------------------------------------------------------------------------
function inchesText(n) {
  return planPrivate.fmtInches(n) || '0"';
}

function restrictionNote(policy) {
  const days = Number(policy.maxDaysPerWeek);
  if (days === 0) return `${policy.label}: lawn irrigation is not permitted right now.`;
  const dayWord = days === 1 ? 'one day' : `${days} days`;
  const hours = policy.hoursNote ? `, ${String(policy.hoursNote).trim()}` : '';
  return `${policy.label} limits lawn watering to ${dayWord} a week${hours}. Your city or county can set stricter limits, so check with your utility.`;
}

function rainNote(observed) {
  if (!observed || observed.rainInches == null) {
    return 'We could not get the last 7 days of rainfall, so this plan counts none of it.';
  }
  const how = observed.rainSource === 'mrms' ? ' (NOAA radar and rain-gauge estimate)' : ' (weather-model estimate)';
  return `About ${inchesText(observed.rainInches)} of rain fell in the last 7 days${how}.`;
}

// Deterministic copy: the plan card's own renderer for a covered county, a
// need-only sentence otherwise. No model call.
function buildText({
  covered, action, engine, policy, plan, observed, forecast, forecastRain, lastWeekRain, targetInches, basis, grass, head, minutes, sensor, rules, rateTable,
}) {
  const notes = [];
  let headline;
  let actionText;
  if (covered) {
    const card = renderWeekPlanReport(engine, { runMinutes: minutes, restriction: policy, rateTable });
    headline = card.title;
    actionText = card.detail;
    notes.push(restrictionNote(policy));
  } else if (action === 'need_only') {
    headline = `Your lawn needs about ${inchesText(targetInches)} of water this week`;
    const rainClause = forecastRain != null ? `, and about ${inchesText(forecastRain)} is in the forecast` : '';
    actionText = `Rain counts toward that: about ${inchesText(lastWeekRain != null ? lastWeekRain : 0)} fell in the last 7 days${rainClause}. Water only on the days your county allows, inside its allowed hours, and skip a run after ½" of rain. Check the current rules from the ${rules.districtName}: ${rules.url}`;
    notes.push('We cannot confirm a watering order for this area, so this shows what the lawn needs, not a schedule.');
  } else {
    headline = 'We could not build a watering plan right now';
    actionText = `Check the current watering rules from the ${rules.districtName}: ${rules.url}`;
  }

  notes.push(rainNote(observed));
  if (forecast == null) notes.push('We could not get the forecast for this week, so this plan assumes a dry week.');
  notes.push(basis === 'evapotranspiration'
    ? 'The weekly need comes from this week\'s forecast evapotranspiration for this grass type.'
    : 'The weekly need is a typical figure for this time of year.');
  if (!isKnownGrass(grass)) notes.push('No grass type was given, so this assumes St. Augustine, the most common Florida lawn.');
  if (covered && head) {
    notes.push(`Minutes assume typical ${head}-head rates, so treat them as a starting point.`);
  } else if (covered && action === 'run' && !plan.conditionalOnForecast) {
    const m = defaultEventMinutes(ratesForTable(rateTable));
    notes.push(`If you do not know your head type: a ½" run takes about ${m.spray} minutes on spray zones and ${m.rotor} on rotor zones.`);
  }
  if (sensor) notes.push('Your rain sensor will skip a run on its own if we get a soaking.');
  return { headline, action: actionText, notes };
}

// The four weather numbers the plan reads, each null when its source is missing.
// The forecast covers today through the plan week's Sunday: 1 to 8 days. The
// weekly need is a 7-day figure, so a short or long window is scaled to 7 days.
// Without a forecast the need is the seasonal figure, never last week's ET0
// (irrigation-week-plan.js: a cool, cloudy week must not size a hot week).
function weatherFigures(observed, forecast) {
  const forecastDays = forecast && Number(forecast.days) > 0 ? Number(forecast.days) : 7;
  const forecastEt0 = forecast ? finiteOrNull(forecast.et0Inches) : null;
  return {
    lastWeekRain: observed ? finiteOrNull(observed.rainInches) : null,
    forecastRain: forecast ? finiteOrNull(forecast.rainInches) : null,
    forecastEt0,
    et0Week: forecastEt0 != null ? round2((forecastEt0 * 7) / forecastDays) : null,
  };
}

// Rain-only carryover, bounded at root-zone storage: the same rule buildWeekPlan applies.
function rainCarryover(lastWeekRain, lastWeekTarget) {
  if (lastWeekRain == null || lastWeekRain <= lastWeekTarget) return 0;
  return round2(Math.min(WEEK_PLAN_CONSTANTS.ROOT_ZONE_STORAGE_INCHES, lastWeekRain - lastWeekTarget));
}

function restrictionView(policy) {
  return policy ? { label: policy.label, maxDaysPerWeek: policy.maxDaysPerWeek, source: policy.source || null } : null;
}

// The public plan block. Outside a covered county there is no event count, no
// depth, no minutes and no legal maximum: the engine's numbers belong to a
// legal policy this caller does not have.
function planFields(covered, action, engine) {
  if (!covered) {
    return { action, events: null, depthInches: null, minutesPerEvent: null, conditionalOnForecast: false, legalMaxEvents: null };
  }
  return {
    action,
    events: engine.events,
    depthInches: engine.depthInches,
    minutesPerEvent: engine.minutesPerEvent,
    conditionalOnForecast: engine.conditionalOnForecast === true,
    legalMaxEvents: engine.legalMaxEvents,
  };
}

function computePublicWateringPlan({
  location,
  observed = null,
  forecast = null,
  grass = null,
  head = null,
  minutes = null,
  sensor = false,
  policy = null,
  now = new Date(),
} = {}) {
  const asOf = etDateString(now);
  const week = planWeekBounds(now);
  const planMonth = etParts(now).month;
  const lastWeekMonth = etParts(addETDays(now, -1)).month;
  const county = location.county || null;
  const rules = rulesFor(county);

  const { lastWeekRain, forecastRain, forecastEt0, et0Week } = weatherFigures(observed, forecast);
  const rainKnown = lastWeekRain != null;

  // Last week's need (carryover compares last week's water to it) and this week's.
  const lastWeekAdvice = buildIrrigationAdvice({
    grassType: grass, month: lastWeekMonth, rainfallInches7d: lastWeekRain, referenceEt0InchesWeek: observed ? observed.et0Inches : null,
  });
  const planAdvice = buildIrrigationAdvice({ grassType: grass, month: planMonth, referenceEt0InchesWeek: et0Week });
  const targetInches = planAdvice.recommendedInchesPerWeek;
  const basis = planAdvice.targetBasis;

  const carryover = rainCarryover(lastWeekRain, lastWeekAdvice.recommendedInchesPerWeek);
  const netInches = round2(Math.max(0, targetInches - carryover));

  const rateTable = resolveRateTable();
  const engine = buildWeekPlan({
    targetInchesPerWeek: targetInches,
    lastWeekAppliedInches: null,
    lastWeekRainInches: lastWeekRain,
    lastWeekTargetInches: lastWeekAdvice.recommendedInchesPerWeek,
    forecastRainInches: forecastRain,
    season: advicePrivate.classifySeason(planMonth),
    restriction: policy,
    runMinutes: minutes,
    systemType: head ? [head] : null,
    rainSensor: sensor === true,
    rainKnown,
    rainOnlyCarryover: true,
    rates: ratesForTable(rateTable),
  });

  const covered = !!policy && engine.action !== 'unavailable';
  const action = covered ? engine.action : (policy ? 'unavailable' : 'need_only');

  const plan = planFields(covered, action, engine);

  const text = buildText({
    covered, action, engine, policy, plan, observed, forecast, forecastRain, lastWeekRain, targetInches, basis, grass, head, minutes, sensor, rules, rateTable,
  });

  return {
    location: { slug: location.slug, label: location.label, county },
    asOf,
    week,
    rain: { last7Inches: lastWeekRain, source: observed ? observed.rainSource || null : null },
    forecast: forecast ? { rainInches: forecastRain, et0Inches: forecastEt0 } : null,
    need: { targetInches, basis, netInches },
    plan,
    restriction: restrictionView(policy),
    rulesUrl: rules.url,
    text,
    landing: LANDING_URL,
    brand: BRAND,
    disclaimer: DISCLAIMER,
  };
}

// ---------------------------------------------------------------------------
// Weather inputs: fetch, fail soft, cache per location slug.
// ---------------------------------------------------------------------------
const FULL_TTL_MS = 3 * 60 * 60 * 1000;
const PARTIAL_RETRY_MS = 15 * 60 * 1000; // one of the two inputs missing
const NONE_RETRY_MS = 60 * 1000; // both missing: do not hammer a down upstream

const _cache = new Map(); // slug -> { observed, forecast, freshUntil }
const _inflight = new Map(); // slug -> Promise<entry>

async function fetchWeatherInputs(location, now) {
  const { fetchServiceWeekWeather } = require('./service-report/application-conditions');
  const { fetchUpcomingWeekForecast } = require('./irrigation-weekly-email');
  const serviceDate = etDateString(addETDays(now, -1));
  const [obs, fc] = await Promise.allSettled([
    fetchServiceWeekWeather({ latitude: location.lat, longitude: location.lng, serviceDate }),
    fetchUpcomingWeekForecast({ latitude: location.lat, longitude: location.lng, horizonEnd: planWeekBounds(now).end, now }),
  ]);
  for (const [name, result] of [['observed', obs], ['forecast', fc]]) {
    if (result.status === 'rejected') logger.warn(`[public-watering-plan] ${name} weather failed for ${location.slug}: ${result.reason && result.reason.message}`);
  }
  const o = obs.status === 'fulfilled' ? obs.value : null;
  const observed = o && (o.rainInches != null || o.et0Inches != null)
    ? { rainInches: finiteOrNull(o.rainInches), et0Inches: finiteOrNull(o.et0Inches), rainSource: o.rainSource || null }
    : null;
  const forecast = fc.status === 'fulfilled' && fc.value ? fc.value : null;

  const at = now.getTime();
  const ttl = observed && forecast ? FULL_TTL_MS : (observed || forecast ? PARTIAL_RETRY_MS : NONE_RETRY_MS);
  // Never past the next ET midnight, when "yesterday" and the plan week move.
  return { observed, forecast, freshUntil: Math.min(at + ttl, freshUntil(now)) };
}

async function getWeatherInputs(location, now) {
  const hit = _cache.get(location.slug);
  if (hit && now.getTime() < hit.freshUntil) return hit;
  if (_inflight.has(location.slug)) return _inflight.get(location.slug);
  const pending = fetchWeatherInputs(location, now)
    .then((entry) => {
      _cache.set(location.slug, entry);
      return entry;
    })
    .finally(() => {
      _inflight.delete(location.slug);
    });
  _inflight.set(location.slug, pending);
  return pending;
}

/**
 * The route's one call. Resolves to
 *   { status: 'invalid', error, message }      bad query (400)
 *   { status: 'unavailable' }                  no weather at all (503)
 *   { status: 'ok', body, freshUntil }         the plan and the instant its inputs stop being fresh
 */
async function getPublicWateringPlan(query, { now = new Date() } = {}) {
  const parsed = parseWateringQuery(query);
  if (!parsed.ok) return { status: 'invalid', error: parsed.error, message: parsed.message };
  const { location, county, policyCounty, grass, head, minutes, sensor } = parsed.value;

  let weather;
  try {
    weather = await getWeatherInputs(location, now);
  } catch (err) {
    logger.warn(`[public-watering-plan] weather lookup failed for ${location.slug}: ${err.message}`);
    return { status: 'unavailable' };
  }
  if (!weather.observed && !weather.forecast) return { status: 'unavailable' };

  // The legal ceiling. Fails closed: null outside established coverage, and for a
  // policy that ends before the plan week's Sunday.
  const policy = currentRestrictionPolicy(now, { county: policyCounty, horizonEnd: planWeekBounds(now).end });
  const body = computePublicWateringPlan({
    location: { ...location, county },
    observed: weather.observed,
    forecast: weather.forecast,
    grass,
    head,
    minutes,
    sensor,
    policy,
    now,
  });
  return { status: 'ok', body, freshUntil: weather.freshUntil };
}

function _clearCache() {
  _cache.clear();
  _inflight.clear();
}

module.exports = {
  getPublicWateringPlan,
  computePublicWateringPlan,
  parseWateringQuery,
  planWeekBounds,
  rulesFor,
  LANDING_URL,
  DISCLAIMER,
  GRASS_TYPES,
  HEAD_TYPES,
  _private: { DISTRICTS, COUNTY_DISTRICT, _clearCache },
};
