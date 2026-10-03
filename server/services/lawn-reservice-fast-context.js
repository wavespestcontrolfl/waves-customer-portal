/**
 * Lawn re-service Fast Complete — what the one-screen completion sheet loads
 * (GET /:serviceId/lawn-reservice/fast-context, GATE_LAWN_RESERVICE_FAST_COMPLETE).
 *
 * Read-only. The sheet submits through the existing full /complete path with
 * one_time_lawn_treatment structuredFindings (the lawn_re_service profile stays
 * typed), so every rule still runs there; this only assembles suggestions:
 *   - the products recorded at this property's most recent COMPLETED lawn visit
 *     are SUGGESTION tiles (nothing is assumed applied); an amount is pre-filled
 *     only from what that visit recorded, else left blank;
 *   - the active catalog the "+ Other product" picker searches.
 */
const db = require('../models/db');
const logger = require('./logger');
const { resolveEligibility, recapServiceIdentity, loadRecapCatalogProducts } = require('./pest-recap');
const { detectServiceLine } = require('./service-report/service-line-configs');
const { pestLabels } = require('./reservice-request');
const { etCalendarDayOf } = require('../utils/datetime-et');

const SERVICE_KEY = 'lawn_re_service';
// The application methods the sheet offers on a lawn row, in screen order: the
// full completion form's own method list (SchedulePage.jsx), so a tech can
// always record how a product really went down. Each value is one /complete
// accepts as is; `requiresSqft` is /complete's own verdict for the lawn line
// (requiresSqftForReportApplication), so the sheet never decides it. `common`
// ones are buttons on the row, the rest sit under "More methods". A method that
// needs linear feet (perimeter spray) is left out: the sheet collects none, so
// that application takes the full form.
const LAWN_METHODS = [
  { value: 'spot_treatment', label: 'Spot treatment', common: true },
  { value: 'broadcast_spray', label: 'Broadcast spray', common: true },
  { value: 'granular_broadcast', label: 'Granular broadcast', common: true },
  { value: 'soil_drench', label: 'Soil drench' },
  { value: 'foliar_spray', label: 'Foliar spray' },
  { value: 'fog_ulv', label: 'Fog/ULV' },
  { value: 'pin_stream', label: 'Pin stream' },
  { value: 'bait_placement', label: 'Bait' },
  { value: 'station_check', label: 'Station check' },
  { value: 'trunk_injection', label: 'Trunk injection' },
];
const FINDINGS_TYPE = 'one_time_lawn_treatment';
const HISTORY_PAGE_SIZE = 50;
const HISTORY_MAX_ROWS = 300;
// 'rescheduled' is the phantom row a legacy customer reschedule leaves behind
// (both schedule feeds hide it); /complete does not refuse it, so this does.
const TERMINAL_STATUSES = new Set(['completed', 'cancelled', 'skipped', 'no_show', 'incomplete', 'rescheduled']);

// Why this visit cannot use the sheet, or null. The service key is checked by
// the caller (a different visit type is a refusal, not an ineligibility).
async function lawnReserviceIneligibleReason(svc, profile, knex) {
  if (profile.findingsType !== FINDINGS_TYPE) return 'not_typed_lawn';
  if (profile.projectBacked || profile.requiresProject) return 'project_backed';
  if (Array.isArray(profile.companions) && profile.companions.length) return 'has_companions';
  if (svc.visit_id) {
    // An orphaned pointer blocks too: dissolution NULLs child visit_id, so a
    // missing visit row means something is mid-flight (same rule as
    // /completion-status). A grouped stop takes the full form.
    const visit = await knex('service_visits').where({ id: svc.visit_id }).first('status');
    if (!visit || String(visit.status || '') !== 'dissolved') return 'grouped_visit';
  }
  if (TERMINAL_STATUSES.has(String(svc.status || ''))) return 'terminal_status';
  return null;
}

const normalizedMethod = (value) => require('./complete-scheduled-service').normalizeServiceReportApplicationMethod(value);

const positiveOrNull = (value) => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
};

// An amount unit, or null for a per-area rate unit ("lb/1000sf", which the
// completion writer can store when no amount unit was sent): a rate is not an
// amount applied, so it never pre-fills.
const quantityUnit = (unit) => {
  const value = String(unit || '').trim();
  return value && !value.includes('/') ? value : null;
};

// The offered lawn methods with /complete's area verdict on each. The helpers
// load lazily: complete-scheduled-service is a very large module.
function lawnMethodChoices() {
  const {
    normalizeServiceReportApplicationMethod,
    requiresSqftForReportApplication,
    requiresLinearFtForReportApplication,
  } = require('./complete-scheduled-service');
  return LAWN_METHODS
    .filter(({ value }) => normalizeServiceReportApplicationMethod(value) === value && !requiresLinearFtForReportApplication(value))
    .map(({ value, label, common }) => ({ value, label, common: common === true, requiresSqft: requiresSqftForReportApplication(value, 'lawn') }));
}

/**
 * The most recent COMPLETED lawn service_record at this visit's property
 * (the customer's, when the visit has no property id), never after this
 * visit's date. The line is the stamped service_line, falling back to the
 * label classifier for legacy rows where it is null (the same rule as
 * utils/last-line-service.js). Re-service callbacks count: a prior re-service
 * is a valid last lawn visit. Paged newest-first and classified in memory.
 * Throws on a failed read; the caller degrades to no last visit.
 */
// Whether the customer has more than one property on file: per-customer facts
// (another visit's history, the turf profile's lawn size) may then describe a
// different address.
async function customerHasSeveralProperties(svc, knex) {
  const properties = await knex('customer_properties').where({ customer_id: svc.customer_id }).count('* as n').first();
  return Number(properties?.n || 0) > 1;
}

async function findLastLawnRecord(svc, knex, visitDate) {
  // No property on the visit and several on file: the customer's history
  // cannot say which address a record treated, so there is no last visit.
  if (!svc.property_id && await customerHasSeveralProperties(svc, knex)) return null;
  for (let offset = 0; offset < HISTORY_MAX_ROWS; offset += HISTORY_PAGE_SIZE) {
    const query = knex('service_records as sr')
      .where('sr.customer_id', svc.customer_id)
      .where('sr.status', 'completed')
      .where('sr.service_date', '<=', visitDate)
      .whereRaw('sr.scheduled_service_id IS DISTINCT FROM ?', [svc.id]);
    // The record has no property column: scope through its scheduled visit. A
    // record with no visit link proves nothing about the address, so it is
    // skipped when the property is known.
    if (svc.property_id) {
      query.join('scheduled_services as ss', 'ss.id', 'sr.scheduled_service_id').where('ss.property_id', svc.property_id);
    }
    const rows = await query
      .orderBy('sr.service_date', 'desc')
      .orderBy('sr.created_at', 'desc')
      .orderBy('sr.id', 'desc')
      .offset(offset)
      .limit(HISTORY_PAGE_SIZE)
      .select('sr.id', 'sr.service_type', 'sr.service_line', 'sr.service_date');
    const found = rows.find((row) => (String(row.service_line || '').trim() || detectServiceLine(row.service_type)) === 'lawn');
    if (found) return found;
    if (rows.length < HISTORY_PAGE_SIZE) break;
  }
  return null;
}

/**
 * The last lawn visit as the sheet reads it: its date and the products it
 * recorded. A product that is unlinked, or inactive / missing in the active
 * catalog, is dropped (it cannot be selected). `catalogIds` is the set of
 * active catalog ids.
 */
async function loadLastVisit(svc, knex, visitDate, catalogIds, methodValues = new Set()) {
  const record = await findLastLawnRecord(svc, knex, visitDate);
  if (!record) return null;
  const rows = await knex('service_products')
    .where('service_record_id', record.id)
    .orderBy('created_at')
    .select('product_id', 'product_name', 'total_amount', 'amount_unit', 'application_method', 'area_value', 'area_unit',
      'application_rate', 'rate_unit');
  const seen = new Set();
  const products = [];
  for (const row of rows) {
    const id = row.product_id == null ? null : String(row.product_id);
    if (!id || !catalogIds.has(id) || seen.has(id)) continue;
    seen.add(id);
    const unit = quantityUnit(row.amount_unit);
    const recordedMethod = normalizedMethod(row.application_method);
    const areaValue = positiveOrNull(row.area_value);
    products.push({
      productId: row.product_id,
      name: row.product_name,
      totalAmount: unit ? positiveOrNull(row.total_amount) : null,
      amountUnit: unit,
      // The recorded method, only when the sheet offers it: anything else
      // leaves the tile with no method for the tech to pick.
      method: methodValues.has(recordedMethod) ? recordedMethod : null,
      // The area recorded with it, as recorded (the sheet reads sqft only).
      areaValue,
      areaUnit: areaValue ? String(row.area_unit || '').trim() || null : null,
      // The rate recorded with it (service_products.application_rate / rate_unit),
      // as recorded: the sheet only pre-fills a unit /complete accepts.
      applicationRate: positiveOrNull(row.application_rate),
      rateUnit: positiveOrNull(row.application_rate) ? String(row.rate_unit || '').trim() || null : null,
    });
  }
  return {
    serviceRecordId: record.id,
    serviceDate: etCalendarDayOf(record.service_date),
    serviceType: record.service_type || null,
    products,
  };
}

// The property's lawn size from the customer's turf profile (the typed form's
// own prefill source, GET /admin/customers/:id/turf-profile), or null. The
// profile is keyed by customer, not property: with more than one property on
// file it may describe another address, so it prefills nothing then.
async function loadLawnSqft(svc, knex) {
  try {
    if (await customerHasSeveralProperties(svc, knex)) return null;
    const profile = await knex('customer_turf_profiles').where({ customer_id: svc.customer_id }).first('lawn_sqft');
    return positiveOrNull(profile?.lawn_sqft);
  } catch (err) {
    logger.warn(`[lawn-reservice-fast-context] lawn size unavailable for ${svc.id}: ${err?.code || err?.name || 'Error'}`);
    return null;
  }
}

// Whether /complete treats a 0 stock count on this visit as an advisory, not a
// hold: a WaveGuard member's lawn completion allows negative inventory and
// records the shortfall (complete-scheduled-service.js isWaveGuardLawnCompletion,
// the same classifier, so the sheet never refuses what the server accepts). A
// failed read answers false: the sheet then keeps its stock hold.
async function loadStockAdvisory(svc, knex) {
  try {
    const customer = await knex('customers').where({ id: svc.customer_id }).first('waveguard_tier');
    return require('./complete-scheduled-service').isWaveGuardLawnCompletion({
      cust_waveguard_tier: customer?.waveguard_tier || null,
      service_type: svc.service_type,
    });
  } catch (err) {
    logger.warn(`[lawn-reservice-fast-context] WaveGuard tier unavailable for ${svc.id}: ${err?.code || err?.name || 'Error'}`);
    return false;
  }
}

// The customer's own words from booking, for the sheet's "They said" line.
function customerRequestOf(svc) {
  const text = String(svc.customer_request || '').trim();
  const keys = Array.isArray(svc.customer_request_pests) ? svc.customer_request_pests : [];
  const pests = pestLabels(keys, 'lawn');
  return text || pests.length ? { text: text || null, pests } : null;
}

/**
 * The sheet's context for one scheduled service. `{ ok: false, reason }` for a
 * missing service or one whose live completion profile is not lawn_re_service
 * (the route refuses both); an otherwise ineligible visit answers
 * `eligible: false` with the reason and the visit identity, and skips the
 * heavier reads.
 */
async function buildLawnReserviceFastContext(serviceId, knex = db) {
  const { ok, reason, svc, profile } = await resolveEligibility(serviceId, knex);
  if (!ok) return { ok: false, reason };
  const service = recapServiceIdentity(svc, profile);
  if (!profile) return { ok: true, eligible: false, reason: 'profile_unavailable', service };
  if (profile.serviceKey !== SERVICE_KEY) return { ok: false, reason: 'not_lawn_re_service' };
  const ineligibleReason = await lawnReserviceIneligibleReason(svc, profile, knex);
  if (ineligibleReason) return { ok: true, eligible: false, reason: ineligibleReason, service };

  const catalog = await loadRecapCatalogProducts(knex).catch(() => []);
  // A failed read leaves no usable catalog. With no catalog the sheet
  // has nothing to pick from, so the visit goes to the full form.
  if (!catalog.length) return { ok: true, eligible: false, reason: 'catalog_unavailable', service };

  const visitDate = etCalendarDayOf(svc.scheduled_date);
  const methods = lawnMethodChoices();
  let lastVisit = null;
  try {
    lastVisit = await loadLastVisit(svc, knex, visitDate, new Set(catalog.map((row) => String(row.id))), new Set(methods.map((m) => m.value)));
  } catch (err) {
    // No driver message: it can echo SQL and bound values. No suggestion tiles
    // is the safe degradation: the tech adds what they applied.
    logger.warn(`[lawn-reservice-fast-context] last visit unavailable for ${serviceId}: ${err?.code || err?.name || 'Error'}`);
  }

  return {
    ok: true,
    eligible: true,
    reason: null,
    service,
    customerRequest: customerRequestOf(svc),
    products: catalog,
    methods,
    lawnSqft: await loadLawnSqft(svc, knex),
    stockAdvisory: await loadStockAdvisory(svc, knex),
    lastVisit,
  };
}

module.exports = {
  SERVICE_KEY,
  FINDINGS_TYPE,
  LAWN_METHODS,
  lawnMethodChoices,
  buildLawnReserviceFastContext,
  lawnReserviceIneligibleReason,
  findLastLawnRecord,
  loadLastVisit,
  loadStockAdvisory,
};
