'use strict';

/**
 * Technician Visit Brief — zero-price Add-On Prompt (owner 2026-11-27 "ok go", Decision 3).
 *
 * Surfaces a one-line cross-sell opportunity on the technician's expanded Visit Brief when an
 * active residential recurring customer owns only ONE of the two approved cross-sell pillars
 * at THIS visit's primary premises (`OFFER_LADDER = ['pest_control', 'lawn_care']`, owner
 * ruling 2026-11-21: never push Tree & Shrub or Termite).
 *
 * Hard constraints honored (delegating to Waves' canonical eligibility authorities):
 *   - Account-wide commercial & liveness proof: `planStartBlocker` (`plan-start-eligibility.js`)
 *     checks every commercial record on the account (property type, hotels/motels/churches,
 *     property-manager condos, any populated `building_use`, saved properties, estimates, leads,
 *     visits, visit add-ons, series templates, service reports, contracts, calls) and confirms
 *     an active plan (`blocker === 'has_plan'`).
 *   - Customer lifecycle & holds: `seriesCustomerSkipReason` (`series-customer-eligibility.js`)
 *     excludes deleted, inactive, churned/former, and whole-account operator-paused accounts.
 *   - Existing coverage at this premises: scoped live recurring rows (`loadLiveRecurringObligationRows`),
 *     off-calendar legacy/null-status recurring rows, ongoing series roots with current
 *     `recurring_template_overrides` + catalog resolution (`parseTemplateOverrides`), recurring
 *     add-ons on scoped visits (`scheduled_service_addons`, respecting each add-on's cadence),
 *     paid annual prepay coverage (`coveredTermsAsOf`, fail-closed on unknown family),
 *     `plan-rate-ledger` (`strictProbe: true`, fail-closed on unattributed rate), and `plan_holds`.
 *   - ZERO prices, margins, discount percentages, or hardcoded tier claims (owner 2026-11-04).
 *   - Pre-fills the existing Field Lead modal (`Lawn` or `Pest`) so the office quotes it and
 *     credits the technician's seller commission (owner ruling 2026-11-09).
 */

const {
  loadLiveRecurringObligationRows,
  loadCatalogFieldsByRowId,
  isLiveObligationRow,
  filterRowsToStreet,
  ownershipKeysForRow,
} = require('./waveguard-existing-services');
const { isPlanSeriesRow } = require('./recurring-series-cancel-reseed');
const { eligibleSeriesParentIds } = require('./recurring-series-topup');
const {
  PRICE_SERVICE_SERVICE_KEYS,
  isOneTimeOnlyAddonKey,
  parseTemplateOverrides,
  overlayRecurringTemplateOverrides,
} = require('./recurring-template-overrides');
const { recurringServiceAddress } = require('./booking/visit-financial-stamps');
const { isCommercialServiceRow } = require('./self-booking-plan-sync');
const { OFFER_LADDER } = require('./service-report/cross-sell');
const { planStartBlocker } = require('./plan-start-eligibility');
const { seriesCustomerSkipReason, SERIES_CUSTOMER_COLUMNS } = require('./series-customer-eligibility');
const { coveredTermsAsOf } = require('./annual-prepay-renewals');
const { loadComponents } = require('./plan-rate-ledger');
const { etDateString } = require('../utils/datetime-et');
const linkage = require('./estimate-property-linkage');
const {
  resolveVisitPropertyScope,
  sameResolvedProperty,
  customerHasOnlyPrimaryPremises,
} = require('./service-report/visit-property-scope');

const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ONE_TIME_ADDON_PATTERNS = new Set(['one_time', 'none', 'once']);

const PILLAR_PROMPTS = Object.freeze({
  lawn_care: Object.freeze({
    targetFamily: 'lawn_care',
    targetLabel: 'Lawn Care',
    fieldLeadServiceType: 'Lawn',
    headline: 'No Lawn Care plan on file',
    detail: 'Ask if they want a Lawn Care quote (WaveGuard bundle savings apply). Tap below to flag for the office.',
  }),
  pest_control: Object.freeze({
    targetFamily: 'pest_control',
    targetLabel: 'Pest Control',
    fieldLeadServiceType: 'Pest',
    headline: 'No Pest Control plan on file',
    detail: 'Ask if they want a Pest Control quote (WaveGuard bundle savings apply). Tap below to flag for the office.',
  }),
});

const CUSTOMER_PROMPT_COLUMNS = Object.freeze([
  ...SERIES_CUSTOMER_COLUMNS,
  'property_type', 'building_use', 'waveguard_tier', 'contact_role',
  'address_line1', 'address_line2', 'city', 'zip', 'has_multi_home',
]);

const OFF_CALENDAR_COLS = Object.freeze([
  'id', 'customer_id', 'service_type', 'service_key_snapshot', 'scheduled_date', 'status', 'source',
  'is_recurring', 'recurring_parent_id', 'is_callback', 'followup_included',
  'service_address_line1', 'service_address_line2', 'service_address_city', 'service_address_zip',
  'property_id', 'source_estimate_id',
]);

function pickTechAddonPrompt(ownedKeys, { isCommercial = false, planRateFamilies = [], heldFamilies = [], prepayFamilies = [] } = {}) {
  if (isCommercial || !Array.isArray(ownedKeys)) return null;
  const owned = new Set(ownedKeys);
  const ownedPillars = OFFER_LADDER.filter((k) => owned.has(k));
  const missingPillars = OFFER_LADDER.filter((k) => !owned.has(k));
  if (ownedPillars.length !== 1 || missingPillars.length !== 1) return null;
  const target = missingPillars[0];
  const suppressed = new Set([...planRateFamilies, ...heldFamilies, ...prepayFamilies]);
  if (suppressed.has(target)) return null;
  return PILLAR_PROMPTS[target] ? { ...PILLAR_PROMPTS[target] } : null;
}

async function resolvePrimaryVisitStreetScope(svc, customer, dbh, deps = {}) {
  const primaryStreet = linkage.normalizedStampedStreet(
    customer.address_line1, customer.address_line2, customer.city, customer.zip,
  );
  if (!primaryStreet || linkage.scopeKeyLacksLocality(primaryStreet)) return null;

  const resolveScope = deps.resolveVisitPropertyScope || resolveVisitPropertyScope;
  const scope = await resolveScope(svc, dbh);
  if (scope.hasEvidence) {
    if (!scope.key || !sameResolvedProperty(scope.key, primaryStreet)) return null;
  } else {
    const proveSingle = deps.customerHasOnlyPrimaryPremises || customerHasOnlyPrimaryPremises;
    const onlyPrimary = await proveSingle(dbh, svc.customer_id, customer, primaryStreet, { unresolvedFails: true });
    if (!onlyPrimary) return null;
  }

  return {
    estimateStreet: primaryStreet,
    customerPrimaryStreet: primaryStreet,
    requireSharedLocality: true,
  };
}

function collectResidentialKeysOrNull(rows, catalogById = null) {
  const keys = new Set();
  for (const row of rows) {
    const enriched = catalogById ? { ...row, ...(catalogById.get(row.id) || {}) } : row;
    if (isCommercialServiceRow(enriched)) return null;
    for (const key of ownershipKeysForRow(enriched)) keys.add(key);
  }
  return [...keys];
}

function isRecurringAddonRow(addon) {
  const effectiveKey = addon?.service_key || addon?.service_key_snapshot || null;
  if (effectiveKey && isOneTimeOnlyAddonKey(effectiveKey)) return false;
  const pattern = String(addon?.recurring_pattern || '').trim().toLowerCase();
  if (pattern && ONE_TIME_ADDON_PATTERNS.has(pattern)) return false;
  return true;
}

/**
 * Loads recurring add-ons attached to scoped recurring visits (respecting each add-on's
 * cadence and excluding sold-once keys via shared `isOneTimeOnlyAddonKey`).
 */
async function loadScopedVisitAddonKeys(dbh, visitIds) {
  const ids = [...new Set((visitIds || []).filter(Boolean))];
  if (!ids.length) return [];
  const addons = await dbh('scheduled_service_addons as addon')
    .leftJoin('services as svc', 'addon.service_id', 'svc.id')
    .whereIn('addon.scheduled_service_id', ids)
    .select(
      'addon.service_name', 'addon.service_key_snapshot', 'addon.service_category_snapshot',
      'addon.recurring_pattern', 'addon.recurring_interval_days',
      'svc.service_key', 'svc.category as service_category', 'svc.name as catalog_name',
    );
  const keys = new Set();
  for (const addon of addons || []) {
    if (!isRecurringAddonRow(addon)) continue;
    const normalized = {
      service_type: addon.service_name,
      service_name: addon.catalog_name || addon.service_name || null,
      service_key: addon.service_key || addon.service_key_snapshot || null,
      service_category: addon.service_category || addon.service_category_snapshot || null,
      catalog_name: addon.catalog_name || null,
    };
    if (isCommercialServiceRow(normalized)) return null;
    for (const key of ownershipKeysForRow(normalized)) keys.add(key);
  }
  return [...keys];
}

async function loadScopedLiveRows(dbh, customerId, { streetScope }) {
  const joined = await loadLiveRecurringObligationRows(dbh, customerId);
  return filterRowsToStreet(dbh, joined, streetScope);
}

async function loadScopedOffCalendarRows(dbh, customerId, { streetScope, catalogById }) {
  const [legacy, noStatus] = await Promise.all([
    dbh('scheduled_services')
      .where({ customer_id: customerId })
      .whereNull('is_recurring')
      .whereNotNull('recurring_parent_id')
      .select(...OFF_CALENDAR_COLS),
    dbh('scheduled_services')
      .where({ customer_id: customerId, is_recurring: true })
      .whereNull('status')
      .select(...OFF_CALENDAR_COLS),
  ]);
  const today = etDateString();
  const live = [...legacy, ...noStatus].filter((row) => isPlanSeriesRow(row) && isLiveObligationRow(row, today));
  if (!live.length) return [];
  const scoped = await filterRowsToStreet(dbh, live, streetScope);
  return scoped.map((row) => {
    const cat = catalogById.get(row.id) || {};
    return { ...row, ...cat, service_key: cat.service_key || row.service_key_snapshot || null };
  });
}

function resolveSeriesRootTemplateRow(row, cols, catalogById, overrideCatalogById) {
  const baseCatalog = catalogById.get(row.id) || {};
  const fallbackBase = { ...baseCatalog, service_key: baseCatalog.service_key || row.service_key_snapshot || null };
  const overlaid = overlayRecurringTemplateOverrides(row, cols);
  if (overlaid === row) return { ...row, ...fallbackBase };
  const overrides = parseTemplateOverrides(row.recurring_template_overrides) || {};
  const hasServiceOverride = PRICE_SERVICE_SERVICE_KEYS.some((k) => k in overrides);
  if (!hasServiceOverride) return { ...overlaid, ...fallbackBase };
  const svcCatalog = overrides.service_id && overrideCatalogById.get(overrides.service_id);
  return {
    ...overlaid,
    service_key: svcCatalog?.service_key || overrides.service_key_snapshot || null,
    service_category: svcCatalog?.category || overrides.service_category_snapshot || null,
    service_name: svcCatalog?.name || null,
    catalog_name: svcCatalog?.name || null,
  };
}

/**
 * Loads ongoing series roots between visits (`eligibleSeriesParentIds`), applies
 * `recurringServiceAddress` before street scoping, and overlays `recurring_template_overrides`
 * (honoring the scheduler's edit-scope feature gate) while preserving saved snapshot / catalog
 * identity on unlinked or price-only roots.
 */
async function loadScopedOngoingRootRows(dbh, customerId, { streetScope, catalogById }) {
  const parentIds = await eligibleSeriesParentIds(dbh, { customerId });
  if (!parentIds?.length) return [];
  const cols = await dbh('scheduled_services').columnInfo();
  const selectCols = cols.recurring_template_overrides
    ? [...OFF_CALENDAR_COLS, 'recurring_template_overrides']
    : [...OFF_CALENDAR_COLS];
  const roots = await dbh('scheduled_services')
    .where({ customer_id: customerId })
    .whereIn('id', parentIds)
    .select(...selectCols);
  const addressedRoots = roots.map((r) => ({ ...r, ...recurringServiceAddress(r) }));
  const scoped = await filterRowsToStreet(dbh, addressedRoots, streetScope);
  const overrideServiceIds = [...new Set(
    scoped
      .map((r) => overlayRecurringTemplateOverrides(r, cols))
      .filter((r, i) => r !== scoped[i])
      .map((r) => parseTemplateOverrides(r.recurring_template_overrides)?.service_id)
      .filter((id) => UUID_SHAPE.test(String(id || ''))),
  )];
  const overrideCatalogRows = overrideServiceIds.length
    ? await dbh('services').whereIn('id', overrideServiceIds).select('id', 'service_key', 'category', 'name')
    : [];
  const overrideCatalogById = new Map(overrideCatalogRows.map((s) => [s.id, s]));
  return scoped.map((row) => resolveSeriesRootTemplateRow(row, cols, catalogById, overrideCatalogById));
}

async function loadActivePrepayCoveredFamilies(dbh, customerId) {
  const terms = await coveredTermsAsOf(dbh, null)
    .where('t.customer_id', customerId)
    .where('t.term_end', '>=', etDateString())
    .select('t.id', 't.coverage_service_type');
  if (!terms?.length) return [];
  const keys = new Set();
  for (const term of terms) {
    const row = { service_type: term.coverage_service_type };
    if (isCommercialServiceRow(row)) return null;
    const matched = ownershipKeysForRow(row);
    if (!matched.length) return null;
    for (const k of matched) keys.add(k);
  }
  return [...keys];
}

async function loadActivePlanHoldFamilies(dbh, customerId) {
  const rows = await dbh('plan_holds')
    .where({ customer_id: customerId, status: 'active' })
    .select('family_key');
  return (rows || []).map((r) => String(r.family_key || '')).filter(Boolean);
}

const DEFAULT_FACT_DEPS = Object.freeze({
  planStartBlocker,
  loadCatalogFieldsByRowId,
  loadScopedLiveRows,
  loadScopedOffCalendarRows,
  loadScopedOngoingRootRows,
  loadScopedVisitAddonKeys,
  loadActivePrepayCoveredFamilies,
  loadPlanComponents: loadComponents,
  loadActivePlanHoldFamilies,
});

/**
 * Fail-closed DB loader for the Visit Brief route. Never throws; returns null on any error,
 * deleted/inactive/churned/held/commercial account, secondary/unprovable premises, unattributed
 * billed/prepay coverage, or ambiguous ownership state.
 */
async function techAddonPromptFacts(svc, dbh, deps = {}) {
  if (!svc?.customer_id || !dbh) return null;
  const d = { ...DEFAULT_FACT_DEPS, ...deps };
  try {
    const customer = await dbh('customers')
      .where({ id: svc.customer_id })
      .whereNull('deleted_at')
      .first(...CUSTOMER_PROMPT_COLUMNS);
    if (seriesCustomerSkipReason(customer) || isCommercialServiceRow(svc)) return null;

    const [blocker, catalogById] = await Promise.all([
      d.planStartBlocker(dbh, svc.customer_id),
      d.loadCatalogFieldsByRowId(dbh, svc.customer_id),
    ]);
    if (blocker !== 'has_plan' || !catalogById) return null;
    if (isCommercialServiceRow({ ...svc, ...(catalogById.get(svc.id) || {}) })) return null;

    const streetScope = await resolvePrimaryVisitStreetScope(svc, customer, dbh, deps);
    if (!streetScope) return null;

    const [liveRows, offCalRows, ongoingRows, prepayFamilies, planComponents, heldFamilies] = await Promise.all([
      d.loadScopedLiveRows(dbh, svc.customer_id, { streetScope }),
      d.loadScopedOffCalendarRows(dbh, svc.customer_id, { streetScope, catalogById }),
      d.loadScopedOngoingRootRows(dbh, svc.customer_id, { streetScope, catalogById }),
      d.loadActivePrepayCoveredFamilies(dbh, svc.customer_id),
      d.loadPlanComponents(dbh, svc.customer_id, { strictProbe: true }),
      d.loadActivePlanHoldFamilies(dbh, svc.customer_id),
    ]);
    const allScopedRows = [liveRows, offCalRows, ongoingRows].flat().filter(Boolean);
    const visitKeys = collectResidentialKeysOrNull(allScopedRows);
    const addonKeys = await d.loadScopedVisitAddonKeys(dbh, allScopedRows.map((r) => r.id));
    if (!visitKeys || !addonKeys || !prepayFamilies) return null;

    const activeRates = planComponents.filter((row) => Number(row.monthly_rate) > 0);
    if (activeRates.some((row) => !row.family_key || row.family_key === 'unattributed')) return null;

    return pickTechAddonPrompt([...new Set([...visitKeys, ...addonKeys])], {
      isCommercial: false,
      planRateFamilies: activeRates.map((row) => String(row.family_key)),
      heldFamilies,
      prepayFamilies,
    });
  } catch {
    return null;
  }
}

module.exports = {
  PILLAR_PROMPTS,
  CUSTOMER_PROMPT_COLUMNS,
  pickTechAddonPrompt,
  resolvePrimaryVisitStreetScope,
  collectResidentialKeysOrNull,
  isRecurringAddonRow,
  loadScopedVisitAddonKeys,
  loadScopedLiveRows,
  loadScopedOffCalendarRows,
  loadScopedOngoingRootRows,
  loadActivePrepayCoveredFamilies,
  loadActivePlanHoldFamilies,
  techAddonPromptFacts,
};
