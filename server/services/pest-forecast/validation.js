/** Read-only, positive-case evaluation. Operational observations are not a
 * population sample: an unrecorded pest is NOT a verified absence. This report
 * never certifies accuracy, changes the model, or enables public claims.
 */
const { LOCATIONS } = require('./locations');
const { MODEL_VERSION, PESTS } = require('./pests');
const { etDateString, etWeekStart, addETDays, validCalendarDate, parseETDateTime } = require('../../utils/datetime-et');
const { dateOnlyString } = require('../../utils/date-only');
const { parseJsonObject, serviceRecordSuppressesCustomerArtifacts } = require('../pest-pressure/history-filter');

const OBSERVATION_RULE_VERSION = 'typed-live-pest-v1';
const EVALUATION_QUERY_TIMEOUT_MS = 5000;
// Exact controlled form choices only. No substring matching, AI species IDs,
// findings titles, customer ratings, or prose summaries become observations.
const PEST_MAP = {
  'Ghost ants': 'ants', 'Fire ants': 'ants', 'Carpenter ants': 'ants',
  'German cockroaches': 'german_roach', 'American / palmetto cockroaches': 'palmetto_roach',
  Mosquitoes: 'mosquitoes', Fleas: 'fleas_ticks', Ticks: 'fleas_ticks',
  'Paper wasps': 'wasps', Yellowjackets: 'wasps', 'Mud daubers': 'wasps',
};
const LIVE_EVIDENCE = {
  one_time_pest_treatment: new Set(['Live pests observed', 'Active trail / foraging']),
  cockroach: new Set(['Live roaches']),
};
const CONTRADICTORY_EVIDENCE = new Set(['No evidence observed', 'Customer-reported activity only', 'Other']);
const cityKey = value => typeof value === 'string' ? value.trim().toLowerCase() : '';
const CITIES = new Map(LOCATIONS.filter(l => l.region === 'sw' && l.slug !== 'southwest-florida')
  .map(l => [cityKey(l.label.replace(/, FL$/, '')), l.slug]));
const chips = value => Array.isArray(value) ? value : typeof value === 'string' ? value.split(',').map(s => s.trim()).filter(Boolean) : [];

function observationFromRecord(record) {
  if (record.status !== 'completed' || !record.technician_id || !record.customer_id
    || serviceRecordSuppressesCustomerArtifacts(record)) return { excluded: 'not_confirmed_completed_visit' };
  const data = parseJsonObject(record.service_data);
  // Combined visits freeze additional forms as companion snapshots. Only an
  // explicitly customer-visible companion is eligible; its own delivery
  // posture is authoritative and missing delivery fails closed.
  const snapshots = [
    data.typedReportSnapshot,
    ...(Array.isArray(data.companionReportSnapshots)
      ? data.companionReportSnapshots.filter(snapshot => snapshot?.delivery === 'auto_send')
      : []),
  ].filter(snapshot => ['one_time_pest_treatment', 'cockroach'].includes(snapshot?.type));
  if (!snapshots.length) return { excluded: 'unsupported_form' };
  const pestsObserved = [];
  const rejected = [];
  for (const snapshot of snapshots) {
    const values = snapshot.values || {};
    // The general one-time form was retired in July. New cockroach visits
    // still freeze this controlled species field and explicit live evidence.
    // Unknown/mixed species and signs such as droppings are not live sightings.
    const pests = snapshot.type === 'cockroach'
      ? [{ German: 'German cockroaches', American: 'American / palmetto cockroaches' }[values.species]]
      : chips(values.pests_observed);
    if (pests.length !== 1 || !Object.hasOwn(PEST_MAP, pests[0])) {
      rejected.push('ambiguous_or_unmapped_pest');
      continue;
    }
    const evidence = chips(values.evidence_observed);
    const live = evidence.some(e => LIVE_EVIDENCE[snapshot.type].has(e));
    if (!live || evidence.some(e => CONTRADICTORY_EVIDENCE.has(e))
      || values.activity_level === 'None observed') {
      rejected.push('no_unambiguous_live_evidence');
      continue;
    }
    pestsObserved.push(PEST_MAP[pests[0]]);
  }
  if (!pestsObserved.length) {
    const reason = rejected.every(value => value === rejected[0])
      ? rejected[0] : 'no_unambiguous_live_evidence';
    return { excluded: reason };
  }
  // Frozen identity is authoritative even when its city is missing. Never
  // follow a customer who moved, or approximate a ZIP into another city.
  const frozen = data.reportIdentitySnapshot?.address;
  const city = frozen ? frozen.city : record.service_address_city;
  const state = frozen ? frozen.state : record.service_address_state;
  const location = CITIES.get(cityKey(city));
  if (!location || !['fl', 'florida'].includes(cityKey(state))) return { excluded: 'unverified_location' };
  const day = validCalendarDate(dateOnlyString(record.service_date));
  if (!day) return { excluded: 'invalid_observation_date' };
  return { observations: pestsObserved.map(pest => ({
    customerId: record.customer_id, serviceRecordId: record.id, date: day,
    location, pest, source: 'technician_recorded_live_pest',
  })) };
}

// Average rank for tied scores avoids rewarding a pest merely because its
// label sorts ahead of another equally likely pest.
function rankOf(pests, key, field) {
  const value = pests.find(p => p.key === key)[field];
  const higher = pests.filter(p => p[field] > value).length;
  const tied = pests.filter(p => p[field] === value).length;
  return higher + (tied + 1) / 2;
}

function usableForecast(forecast) {
  if (forecast?.model_version !== MODEL_VERSION || forecast.weather?.available !== true
    || !validCalendarDate(forecast.as_of_date) || !Array.isArray(forecast.pests)) return false;
  const generated = new Date(forecast.generated_at);
  if (!Number.isFinite(generated.getTime()) || etDateString(generated) !== forecast.as_of_date) return false;
  const keys = new Set(forecast.pests.map(p => p.key));
  return keys.size === PESTS.length && forecast.pests.length === PESTS.length
    && PESTS.every(p => keys.has(p.key))
    && forecast.pests.every(p => [p.score, p.baseline].every(n => Number.isFinite(n) && n >= 0 && n <= 10));
}

function evaluateForecasts({ records, forecasts }) {
  const excluded = {};
  const observations = [];
  for (const record of records) {
    const result = observationFromRecord(record);
    if (result.excluded) excluded[result.excluded] = (excluded[result.excluded] || 0) + 1;
    else observations.push(...result.observations);
  }
  const saved = forecasts.filter(usableForecast).sort((a, b) => b.as_of_date.localeCompare(a.as_of_date));
  const seen = new Set();
  const buckets = new Map();
  let duplicates = 0;
  let noPriorForecast = 0;
  // First observation per customer / city / pest / ET week. Repeat callbacks
  // from the same customer must not make one infestation look like many.
  observations.sort((a, b) => a.date.localeCompare(b.date) || String(a.serviceRecordId).localeCompare(String(b.serviceRecordId)));
  for (const observation of observations) {
    const day = new Date(`${observation.date}T12:00:00Z`);
    const key = `${observation.customerId}|${observation.location}|${observation.pest}|${etWeekStart(day)}`;
    if (seen.has(key)) { duplicates += 1; continue; }
    seen.add(key);
    const since = etDateString(addETDays(day, -7));
    const midnight = parseETDateTime(`${observation.date}T00:00`);
    // Only forecasts captured BEFORE the observation day, at most 7 days
    // earlier. Never use same-day weather or reconstruct a past prediction.
    const prior = saved.find(f => f.location?.slug === observation.location
      && f.as_of_date >= since && f.as_of_date < observation.date
      && new Date(f.generated_at) < midnight);
    if (!prior) { noPriorForecast += 1; continue; }
    const pest = prior.pests.find(p => p.key === observation.pest);
    const bucketKey = `${observation.location}|${observation.pest}`;
    const bucket = buckets.get(bucketKey) || { location: observation.location, pest: observation.pest, samples: 0, score: 0, baseline: 0, rank: 0, baselineRank: 0 };
    bucket.samples += 1;
    bucket.score += pest.score;
    bucket.baseline += pest.baseline;
    bucket.rank += rankOf(prior.pests, pest.key, 'score');
    bucket.baselineRank += rankOf(prior.pests, pest.key, 'baseline');
    buckets.set(bucketKey, bucket);
  }
  const mean = (sum, count) => Math.round(sum / count * 100) / 100;
  const results = [...buckets.values()].map(b => ({
    location: b.location, pest: b.pest, samples: b.samples,
    meanModelScore: mean(b.score, b.samples), meanSeasonalBaseline: mean(b.baseline, b.samples),
    meanModelRank: mean(b.rank, b.samples), meanSeasonalRank: mean(b.baselineRank, b.samples),
  })).sort((a, b) => a.location.localeCompare(b.location) || a.pest.localeCompare(b.pest));
  return {
    modelVersion: MODEL_VERSION, observationRuleVersion: OBSERVATION_RULE_VERSION,
    validationStatus: results.length ? 'positive_case_review_only' : 'insufficient_evidence',
    publicAccuracyClaimsSupported: false,
    coverage: { recordsReviewed: records.length, eligibleObservations: observations.length, excluded,
      duplicateCustomerWeeks: duplicates, noPriorForecast, matchedObservations: results.reduce((n, b) => n + b.samples, 0),
      invalidOrOtherModelSnapshots: forecasts.length - saved.length },
    results,
    limitations: [
      'Technician-recorded live-pest findings from cockroach and legacy one-time pest forms only; not independently adjudicated species identifications.',
      'Positive service-call sample only. Missing pests and no-activity rows are not verified negatives; accuracy, false-positive rate and probability calibration cannot be estimated.',
      'Ranks compare the weather-adjusted model with its seasonal baseline on the same cases; they do not establish population-level predictive skill.',
    ],
  };
}

// Explicit connection supplied by the read-only CLI; never implicitly opens
// an application database or falls back to customers' current addresses.
async function loadEvaluationData(knex, { from, to }) {
  const since = etDateString(addETDays(new Date(`${from}T12:00:00Z`), -7));
  return knex.transaction(async trx => {
    await trx.raw('SET TRANSACTION READ ONLY');
    // READ ONLY prevents mutations but does not bound a lock wait. Keep both
    // source reads server-cancellable so an abandoned lock cannot hang the CLI.
    await trx.raw("SELECT set_config('statement_timeout', ?, true)", [`${EVALUATION_QUERY_TIMEOUT_MS}ms`]);
    const records = await trx('service_records as sr')
      .leftJoin('scheduled_services as ss', 'ss.id', 'sr.scheduled_service_id')
      .whereBetween('sr.service_date', [from, to]).where('sr.status', 'completed')
      .select('sr.id', 'sr.customer_id', 'sr.technician_id', 'sr.status', 'sr.service_date', 'sr.service_data', 'sr.structured_notes',
        'ss.service_address_city', 'ss.service_address_state');
    // Load every stored model in the range so the aggregate can distinguish
    // rejected versions from missing history.
    const rows = await trx('pest_forecast_snapshots').whereBetween('forecast_date', [since, to])
      .select('forecast');
    return { records, forecasts: rows.map(r => r.forecast) };
  });
}

module.exports = { OBSERVATION_RULE_VERSION, observationFromRecord, usableForecast, evaluateForecasts, loadEvaluationData };
