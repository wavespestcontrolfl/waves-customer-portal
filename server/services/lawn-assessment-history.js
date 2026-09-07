/**
 * Property-scoped, confirmed lawn history. Callers enter this module only after
 * deciding GATE_LAWN_PROPERTY_HISTORY for their operation. Reads throw: rendering
 * may degrade, but a delivery fence must distinguish unavailable from absent.
 */
const crypto = require('crypto');
const db = require('../models/db');
const logger = require('./logger');
const { etCalendarDayOf, etDateString } = require('../utils/datetime-et');
const { calculateLawnOverallScore } = require('../../shared/lawn-scores.cjs');

const RESOLVER_VERSION = 2;

function assessmentQuery(customerId, knex = db, { confirmed = true } = {}) {
  const query = knex('lawn_assessments as la')
    .leftJoin('service_records as sr', 'la.service_record_id', 'sr.id')
    .leftJoin('scheduled_services as ss', 'ss.id', knex.raw('COALESCE(la.service_id, sr.scheduled_service_id)'))
    .where('la.customer_id', customerId)
    .select('la.*',
      'sr.id as history_record_id', 'sr.customer_id as history_record_customer_id',
      'sr.scheduled_service_id as history_record_visit_id', 'sr.service_date as history_record_date',
      'ss.id as history_visit_id', 'ss.customer_id as history_visit_customer_id',
      'ss.property_id as history_visit_property_id', 'ss.scheduled_date as history_visit_date',
      'ss.service_address_line1 as history_address_line1', 'ss.service_address_line2 as history_address_line2',
      'ss.service_address_city as history_city', 'ss.service_address_zip as history_zip',
      // pg Date objects discard microseconds. Preserve the DB's confirmation
      // ordering when two serialized confirmations occur within one millisecond.
      knex.raw('to_char(la.confirmed_at AT TIME ZONE \'UTC\', \'YYYY-MM-DD"T"HH24:MI:SS.US\') as history_confirmed_order'),
      knex.raw('to_char(la.created_at AT TIME ZONE \'UTC\', \'YYYY-MM-DD"T"HH24:MI:SS.US\') as history_created_order'));
  if (confirmed) query.where('la.confirmed_by_tech', true);
  return query;
}

function resolveVisit(row) {
  const recordVisitId = row.history_record_visit_id || null;
  const visitId = row.service_id || recordVisitId;
  const conflict = !!(row.service_id && recordVisitId && row.service_id !== recordVisitId);
  const invalidLink = !!(
    (row.service_record_id && (!row.history_record_id || row.history_record_customer_id !== row.customer_id))
    || (visitId && (!row.history_visit_id || row.history_visit_customer_id !== row.customer_id))
    || (row.property_id && row.history_visit_property_id && row.property_id !== row.history_visit_property_id)
  );
  const identity = visitId ? `visit:${visitId}` : row.service_record_id ? `record:${row.service_record_id}` : `assessment:${row.id}`;
  const date = row.history_visit_date || row.history_record_date || row.service_date;
  return { identity, visitId, visitDate: date ? etCalendarDayOf(date) : null, conflict, invalidLink };
}

/** Explicit property ids may be inactive: a historical visit keeps its lawn. */
async function visitEligibility({ customerId, propertyId, allowPrimary = true }, knex = db) {
  const properties = await knex('customer_properties').where({ customer_id: customerId }).select('*');
  const active = properties.filter((property) => property.active);
  const sole = active.length === 1 ? active[0] : null;
  const selected = propertyId ? properties.find((property) => property.id === propertyId)
    : sole || (allowPrimary ? active.find((property) => property.is_primary) : null);
  const prefs = await knex('property_preferences').where({ customer_id: customerId }).first('irrigation_home_changed_at');
  const movedAt = prefs?.irrigation_home_changed_at || null;
  const { addressKey } = require('./customer-properties');
  return {
    customerId, propertyId: selected?.id || null, solePropertyId: sole?.id || null,
    includeUnlinked: !!(selected && sole?.id === selected.id && !movedAt),
    movedAt, propertyAddressKey: selected ? addressKey(selected) : null,
  };
}

/** Unknown scope is distinct from evidence that contradicts a known property. */
function hasConflictingEvidence(row, scope) {
  const visit = resolveVisit(row);
  if (row.customer_id !== scope.customerId || visit.conflict || visit.invalidLink) return true;
  const propertyId = row.property_id || row.history_visit_property_id;
  if (propertyId && propertyId !== scope.propertyId) return true;
  if (!scope.propertyId || row.history_visit_property_id || !row.history_address_line1) return false;
  const { addressKey } = require('./customer-properties');
  return addressKey({
    address_line1: row.history_address_line1, address_line2: row.history_address_line2,
    city: row.history_city, zip: row.history_zip,
  }) !== scope.propertyAddressKey;
}

/** Unstamped visits retain the live sole-property rule. A confirmed stamp is
 * durable evidence; an unconfirmed draft must still pass confirmation's fence. */
function isEligible(row, scope) {
  if (!scope?.propertyId || hasConflictingEvidence(row, scope)) return false;
  return !!(row.history_visit_property_id || (row.property_id && row.confirmed_by_tech) || scope.includeUnlinked);
}

async function scopeForAssessment(row, knex = db) {
  const scope = await visitEligibility({
    customerId: row.customer_id,
    propertyId: row.property_id || row.history_visit_property_id || null,
    allowPrimary: false,
  }, knex);
  return isEligible(row, scope) ? scope : {
    ...scope, propertyId: null, includeUnlinked: false,
    conflictingEvidence: hasConflictingEvidence(row, scope),
  };
}

function visitEvidence(customerId, visit) {
  return {
    customer_id: customerId, service_id: visit?.id,
    history_visit_id: visit?.id, history_visit_customer_id: visit?.customer_id,
    history_visit_property_id: visit?.property_id, history_visit_date: visit?.scheduled_date,
    history_address_line1: visit?.service_address_line1, history_address_line2: visit?.service_address_line2,
    history_city: visit?.service_address_city, history_zip: visit?.service_address_zip,
  };
}

function installedOrder(a, b) {
  const recordPreference = Number(!!b.history_record_id) - Number(!!a.history_record_id);
  if (recordPreference) return recordPreference;
  // Empty strings sort below real timestamps, giving NULLS LAST descending.
  const confirmation = (row) => row.history_confirmed_order || (row.confirmed_at ? new Date(row.confirmed_at).toISOString() : '');
  const creation = (row) => row.history_created_order || (row.created_at ? new Date(row.created_at).toISOString() : '');
  return confirmation(b).localeCompare(confirmation(a)) || creation(b).localeCompare(creation(a))
    || String(b.id).localeCompare(String(a.id));
}

function installedRows(rows, { current, pinned = false } = {}) {
  const selected = new Map();
  for (const row of [...rows].sort(installedOrder)) {
    const visit = resolveVisit(row);
    if (!row.confirmed_by_tech || visit.conflict || visit.invalidLink || !visit.visitDate) continue;
    if (!selected.has(visit.identity)) selected.set(visit.identity, { ...row, visit_identity: visit.identity, visit_date: visit.visitDate, installed: true });
  }
  if (pinned && current) {
    const visit = resolveVisit(current);
    if (selected.has(visit.identity)) selected.set(visit.identity, { ...current, visit_identity: visit.identity, visit_date: visit.visitDate, installed: false });
  }
  return [...selected.values()].sort((a, b) => a.visit_date.localeCompare(b.visit_date)
    || String(a.history_created_order || a.created_at).localeCompare(String(b.history_created_order || b.created_at))
    || a.visit_identity.localeCompare(b.visit_identity));
}

async function installedForVisit({ customerId, serviceRecordId, serviceId }, knex = db) {
  if (!customerId || (!serviceRecordId && !serviceId)) return null;
  const record = serviceRecordId
    ? await knex('service_records').where({ id: serviceRecordId, customer_id: customerId }).first('id', 'scheduled_service_id')
    : null;
  if (serviceRecordId && !record) return null;
  if (serviceId && record?.scheduled_service_id && record.scheduled_service_id !== serviceId) return null;
  const visitId = serviceId || record?.scheduled_service_id;
  const query = assessmentQuery(customerId, knex).where(function thisVisit() {
    if (visitId) this.where('la.service_id', visitId).orWhere('sr.scheduled_service_id', visitId);
    if (serviceRecordId) this.orWhere('la.service_record_id', serviceRecordId);
  });
  return installedRows(await query)[0] || null;
}

async function eligibleVisitIds(scope, knex = db) {
  if (!scope?.propertyId) return [];
  const visits = await knex('scheduled_services').where({ customer_id: scope.customerId }).select(
    'id as service_id', 'customer_id', 'id as history_visit_id', 'customer_id as history_visit_customer_id',
    'property_id as history_visit_property_id', 'scheduled_date as history_visit_date',
    'service_address_line1 as history_address_line1', 'service_address_line2 as history_address_line2',
    'service_address_city as history_city', 'service_address_zip as history_zip',
  );
  return visits.filter((visit) => isEligible(visit, scope)).map((visit) => visit.service_id);
}

/** Apply the same proven-visit set to the two ancillary history tables. */
function restrictVisitHistory(query, table, eligibleIds, knex = db) {
  if (eligibleIds === undefined) return query;
  const records = knex('service_records as history_record')
    .whereColumn('history_record.customer_id', `${table}.customer_id`)
    .whereIn('history_record.scheduled_service_id', eligibleIds).select('history_record.id');
  if (table === 'turf_height_readings') return query.whereIn(`${table}.service_record_id`, records);
  return query.where(function eligibleSnapshot() {
    this.whereIn(`${table}.service_id`, eligibleIds)
      .orWhere(function recordOnlySnapshot() {
        this.whereNull(`${table}.service_id`).whereIn(`${table}.service_record_id`, records);
      });
  }).where(function consistentRecordLink() {
    this.whereNull(`${table}.service_record_id`).orWhereExists(
      knex('service_records as history_record').select(knex.raw('1'))
        .whereColumn('history_record.id', `${table}.service_record_id`)
        .whereColumn('history_record.customer_id', `${table}.customer_id`)
        .where(function matchingVisit() {
          this.whereNull(`${table}.service_id`).orWhereNull('history_record.scheduled_service_id')
            .orWhereColumn('history_record.scheduled_service_id', `${table}.service_id`);
        }),
    );
  });
}

async function applicableReset({ customerId, propertyId, throughVisitDate, throughConfirmedOrder }, knex = db) {
  if (!propertyId) return null;
  const resets = await knex('lawn_baseline_resets').where({ customer_id: customerId })
    .where(function propertyOrLegacy() { this.where({ property_id: propertyId }).orWhereNull('property_id'); })
    .orderBy('created_at', 'desc').orderBy('id', 'desc')
    .select('*', knex.raw('to_char(created_at AT TIME ZONE \'UTC\', \'YYYY-MM-DD"T"HH24:MI:SS.US\') as history_reset_order'));
  for (const reset of resets) {
    // A later administrative action must not rewrite an earlier report window,
    // even if that action selected an older visit as its replacement baseline.
    const resetDay = etDateString(new Date(reset.created_at));
    if (throughVisitDate && resetDay > throughVisitDate) continue;
    if (resetDay === throughVisitDate && throughConfirmedOrder && reset.history_reset_order > throughConfirmedOrder) continue;
    const baseline = reset.new_baseline_id
      ? await assessmentQuery(customerId, knex, { confirmed: false }).where('la.id', reset.new_baseline_id).first()
      : null;
    const visit = baseline ? resolveVisit(baseline) : null;
    const hasReplacement = visit && !visit.conflict && !visit.invalidLink;
    const boundary = hasReplacement ? visit.visitDate : resetDay;
    if (!throughVisitDate || boundary <= throughVisitDate) return {
      ...reset, boundary, afterConfirmedOrder: hasReplacement ? null : reset.history_reset_order,
    };
  }
  return null;
}

async function propertyHistory({ customerId, scope, throughVisitDate, reset, current, pinned = false, rows }, knex = db) {
  const candidates = rows || await assessmentQuery(customerId, knex);
  const eligible = candidates.filter((row) => {
    const visit = resolveVisit(row);
    if (visit.conflict) logger.warn(`[lawn-history] conflicting assessment links: ${row.id}`);
    return isEligible(row, scope) && (!throughVisitDate || visit.visitDate <= throughVisitDate)
      && (!reset?.boundary || visit.visitDate >= reset.boundary)
      && (!reset?.afterConfirmedOrder || visit.visitDate > reset.boundary
        || (row.history_confirmed_order || row.history_created_order || '') > reset.afterConfirmedOrder);
  });
  let history = installedRows(eligible, { current, pinned });
  if (current) {
    const index = history.findIndex((row) => row.visit_identity === resolveVisit(current).identity);
    if (index >= 0) history = history.slice(0, index + 1);
  }
  return history;
}

function progress(rows, current) {
  const index = rows.findIndex((row) => row.id === current?.id);
  const previous = index > 0 ? rows[index - 1] : null;
  const baseline = rows[0] || null;
  const score = current ? calculateLawnOverallScore(current) : null;
  const previousScore = previous ? calculateLawnOverallScore(previous) : null;
  const baselineScore = baseline ? calculateLawnOverallScore(baseline) : null;
  return {
    score, previousScore, baselineScore,
    previousDelta: score != null && previousScore != null ? score - previousScore : null,
    baselineDelta: score != null && baselineScore != null ? score - baselineScore : null,
  };
}

function historyIdentity(scope, reset, rows, eligibleIds = []) {
  return crypto.createHash('sha1').update(JSON.stringify({
    version: RESOLVER_VERSION, scope, reset: reset ? [reset.id, reset.boundary, reset.created_at] : null,
    eligibleVisitIds: [...eligibleIds].sort(),
    rows: rows.map((row) => [row.id, row.visit_identity, row.visit_date, row.history_confirmed_order || row.confirmed_at,
      row.updated_at, row.is_baseline, row.turf_density, row.weed_suppression, row.color_health,
      row.fungus_control, row.thatch_level, row.stress_damage, row.overall_score]),
  })).digest('hex');
}

async function historyForAssessment(row, { pinned = false, knex = db } = {}) {
  const candidates = await assessmentQuery(row.customer_id, knex);
  const joined = candidates.find((candidate) => candidate.id === row.id) || row;
  const scope = await scopeForAssessment(joined, knex);
  const visit = resolveVisit(joined);
  const reset = await applicableReset({
    customerId: row.customer_id, propertyId: scope.propertyId, throughVisitDate: visit.visitDate,
    throughConfirmedOrder: joined.history_confirmed_order || joined.history_created_order,
  }, knex);
  let rows = await propertyHistory({ customerId: row.customer_id, scope, throughVisitDate: visit.visitDate, reset, current: joined, pinned, rows: candidates }, knex);
  // A normal address stamp does not prove or contradict an unresolved scope.
  // Retain this visit's installed row (or signed pin), with no other history.
  if (!scope.propertyId && !scope.conflictingEvidence) {
    rows = installedRows(candidates.filter((candidate) => resolveVisit(candidate).identity === visit.identity
      && !candidate.property_id && !candidate.history_visit_property_id), { current: joined, pinned });
  }
  const current = rows.find((candidate) => candidate.visit_identity === visit.identity) || null;
  const index = rows.indexOf(current);
  const eligibleIds = await eligibleVisitIds(scope, knex);
  return {
    scope, reset, rows, current, previous: index > 0 ? rows[index - 1] : null,
    baseline: rows[0] || null, isBaseline: !!current && current.id === rows[0]?.id,
    eligibleVisitIds: eligibleIds,
    progress: progress(rows, current), identity: historyIdentity(scope, reset, rows, eligibleIds),
  };
}

async function historyForReport(service, { assessment, pinned = false } = {}, knex = db) {
  if (assessment) return historyForAssessment(assessment, { pinned, knex });
  const visitId = service.scheduled_service_id || service.service_id;
  const visit = visitId ? await knex('scheduled_services').where({ id: visitId, customer_id: service.customer_id }).first() : null;
  const scope = await scopeForAssessment({ ...visitEvidence(service.customer_id, visit), service_id: visitId }, knex);
  const eligibleIds = await eligibleVisitIds(scope, knex);
  return { scope, reset: null, current: null, rows: [], previous: null, baseline: null, isBaseline: false, eligibleVisitIds: eligibleIds, identity: historyIdentity(scope, null, [], eligibleIds) };
}

/** A visit being assessed has no installed current row yet. Its prior context
 * uses the same property/reset scope and excludes every attempt of this visit. */
async function historyBeforeVisit({ customerId, scheduledService, throughVisitDate }, knex = db) {
  const scope = await scopeForAssessment(visitEvidence(customerId, scheduledService), knex);
  const reset = await applicableReset({ customerId, propertyId: scope.propertyId, throughVisitDate }, knex);
  const rows = (await propertyHistory({ customerId, scope, throughVisitDate, reset }, knex))
    .filter((row) => row.visit_identity !== `visit:${scheduledService?.id}` && row.visit_date < throughVisitDate);
  return { scope, reset, rows, previous: rows[rows.length - 1] || null, baseline: rows[0] || null };
}

async function latestForCustomer(customerId, { limit, propertyId } = {}, knex = db) {
  const scope = await visitEligibility({ customerId, propertyId }, knex);
  const throughVisitDate = etDateString();
  const reset = await applicableReset({ customerId, propertyId: scope.propertyId, throughVisitDate }, knex);
  const rows = await propertyHistory({ customerId, scope, reset, throughVisitDate }, knex);
  const decorated = rows.map((row, index) => ({ ...row, is_baseline: index === 0 }));
  return limit ? decorated.slice(-limit) : decorated;
}

module.exports = {
  RESOLVER_VERSION, assessmentQuery, resolveVisit, visitEligibility, isEligible,
  scopeForAssessment, visitEvidence, installedOrder, installedRows, installedForVisit,
  eligibleVisitIds, restrictVisitHistory, applicableReset, propertyHistory, historyForAssessment, historyForReport, historyBeforeVisit,
  latestForCustomer, progress, historyIdentity,
};
