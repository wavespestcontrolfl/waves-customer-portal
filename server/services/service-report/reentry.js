const db = require('../../models/db');
const { DEFAULT_TIME_ZONE, formatReadyTime, normalizeDate } = require('./time-format');
const { normalizeAdvisoryForTreatmentScope, parseJsonObject } = require('./report-data');

function addMinutes(date, minutes) {
  return new Date(date.getTime() + (minutes * 60 * 1000));
}

function numericMinutes(value) {
  if (value === null || value === undefined || value === '') return 0;
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(0, Math.round(n)) : 0;
}

function latestDate(values) {
  return values
    .map(normalizeDate)
    .filter(Boolean)
    .sort((a, b) => b.getTime() - a.getTime())[0] || null;
}

function buildTarget(key, label, anchorDate, durationMin, now) {
  const readyAt = addMinutes(anchorDate, durationMin);
  return {
    key,
    label,
    durationMin,
    readyAt: readyAt.toISOString(),
    statusAtGeneratedAt: readyAt.getTime() <= now.getTime() ? 'ready' : 'pending',
  };
}

function buildIrrigationReadyAt(anchorDate, irrigationHoldHr) {
  const hours = Number(irrigationHoldHr);
  if (!Number.isFinite(hours) || hours <= 0) return undefined;
  return addMinutes(anchorDate, Math.round(hours * 60)).toISOString();
}

function buildReentrySummary(targets, now, timeZone = DEFAULT_TIME_ZONE) {
  const pending = targets.filter((target) => Date.parse(target.readyAt) > now.getTime());
  if (!pending.length) return 'Treated areas are ready for normal use.';
  return pending
    .map((target) => `${target.label} ready at ${formatReadyTime(target.readyAt, timeZone)}`)
    .join('. ') + '.';
}

function buildReentryContextFromRecord(record, now = new Date()) {
  const applications = Array.isArray(record?.applications) ? record.applications : [];
  // The anchor must be a real clock time: date-only service_date parses to
  // UTC midnight, which would fabricate ready-at times (and often an instant
  // 'ready') for records with no true timestamp. No clock anchor → no
  // re-entry context, and the page honestly shows no ready times.
  const anchorDate = latestDate(applications.map((app) => app.appliedAt || app.applied_at || app.created_at))
    || normalizeDate(record?.ended_at)
    || normalizeDate(record?.started_at);

  if (!anchorDate) return undefined;

  const advisory = normalizeAdvisoryForTreatmentScope(
    parseJsonObject(record?.advisory),
    { service: record, applications },
  );
  const exteriorMin = numericMinutes(advisory.exterior_reentry_min);
  const interiorMin = numericMinutes(advisory.interior_reentry_min);
  const targets = [];

  if (exteriorMin > 0) targets.push(buildTarget('exterior', 'Exterior', anchorDate, exteriorMin, now));
  if (interiorMin > 0) targets.push(buildTarget('interior', 'Interior', anchorDate, interiorMin, now));
  if (!targets.length) return undefined;

  const displayTimezone = record?.timezone || record?.property_timezone || DEFAULT_TIME_ZONE;
  return {
    anchorAppliedAt: anchorDate.toISOString(),
    generatedAt: now.toISOString(),
    displayTimezone,
    targets,
    petAdvisory: advisory.pet_advisory || undefined,
    irrigationReadyAt: buildIrrigationReadyAt(anchorDate, advisory.irrigation_hold_hr),
    customerSummary: buildReentrySummary(targets, now, displayTimezone),
  };
}

async function buildReentryContext({ record, now = new Date(), knex = db } = {}) {
  if (!record?.id) return undefined;
  let applications = Array.isArray(record.applications) ? record.applications : null;
  if (!applications) {
    applications = await knex('service_products')
      .where({ service_record_id: record.id })
      .select('id', 'applied_at', 'created_at', 'application_area', 'application_method', 'targets')
      .catch(() => []);
  }
  return buildReentryContextFromRecord({ ...record, applications }, now);
}

module.exports = {
  buildReentryContext,
  buildReentryContextFromRecord,
  buildReentrySummary,
};
