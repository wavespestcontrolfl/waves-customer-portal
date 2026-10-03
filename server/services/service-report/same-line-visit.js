/**
 * One rule for "the next visit on this report's service line", shared by
 * the report's next-appointment pick (report-data.js) and the report
 * writer's NEXT VISIT record (report-writer-records.js), so the generated
 * copy and the displayed schedule never disagree.
 *
 * A rodent report's next visit spans the whole rodent program (trapping,
 * exclusion, sanitation, proofing), including service names that carry no
 * rodent token ("Exclusion Service" alone falls to the pest default). Owner
 * 2026-07-27: the rodent report shows the next service date if and only if
 * it is rodent-related. Under GATE_RODENT_REPORT_REFRESH the catalog is the
 * authority: a candidate whose service_id points at a services row with
 * category 'rodent' is rodent-related under any label, and a resolvable
 * link to a non-rodent service vetoes a rodent-sounding label (codex
 * round-8 P2). Unlinked legacy rows fall back to an exact rodent-catalog
 * name plus the adjacent-shape regex, and only for names no other line
 * detects (the 'pest' fallback). Other report lines keep the strict
 * same-line match. Best-effort: an unavailable catalog keeps the strict
 * match.
 */
const { detectServiceLine, isRodentAdjacentServiceType } = require('./service-line-configs');
const { resolveVisitPropertyScope, sameResolvedProperty } = require('./visit-property-scope');

// The columns resolveVisitPropertyScope reads off a scheduled_services row.
const PROPERTY_SCOPE_COLUMNS = Object.freeze([
  'property_id', 'source_estimate_id',
  'service_address_line1', 'service_address_line2', 'service_address_city', 'service_address_zip',
]);

function rodentReportRefreshFor(serviceLine) {
  return serviceLine === 'rodent' && process.env.GATE_RODENT_REPORT_REFRESH === 'true';
}

async function loadRodentCatalogIndex(knex) {
  try {
    const catalogRows = await knex('services').select('id', 'name', 'category');
    const rows = Array.isArray(catalogRows) ? catalogRows : [];
    return {
      serviceCategoryById: new Map(rows
        .filter((row) => row && row.id)
        .map((row) => [String(row.id), String(row.category || '')])),
      rodentCatalogNames: new Set(rows
        .filter((row) => String(row?.category || '') === 'rodent')
        .map((row) => String(row.name || '').trim().toLowerCase())
        .filter(Boolean)),
    };
  } catch {
    return { serviceCategoryById: null, rodentCatalogNames: null };
  }
}

function isSameLineVisit(row, {
  serviceLine, rodentReportRefresh = false, serviceCategoryById = null, rodentCatalogNames = null,
} = {}) {
  const linkedCategory = rodentReportRefresh && serviceCategoryById && row?.service_id
    ? serviceCategoryById.get(String(row.service_id)) || null
    : null;
  if (linkedCategory) return linkedCategory === 'rodent';
  const rowLine = detectServiceLine(row?.service_type);
  if (rowLine === serviceLine) return true;
  if (!rodentReportRefresh) return false;
  return rowLine === 'pest'
    && isRodentAdjacentServiceType(row?.service_type)
    && !!rodentCatalogNames
    && rodentCatalogNames.has(String(row?.service_type || '').trim().toLowerCase());
}

// The first of `rows` (already in date order; same-day rows in any order) on the report's service line
// AND at the report's own property: on a multi-property account a booking
// at another address is never this property's next visit. Same resolver as
// the report's upcoming-visits card (visit-property-scope.js). Fails
// closed: when the report's own visit, or an earlier same-line booking,
// cannot be tied to a property, the answer is 'unknown', never 'none'.
// `onLookupFailure` (optional) is told when a property read FAILED, as
// opposed to a property that is simply unresolvable; the answer is the same.
async function nextSameLineVisitAtProperty({
  knex, rows, reportVisit, serviceLine, onLookupFailure,
}) {
  const failed = () => { if (typeof onLookupFailure === 'function') onLookupFailure(); return null; };
  const reportScope = reportVisit
    ? await resolveVisitPropertyScope(reportVisit, knex, { onLookupFailure }).catch(failed)
    : null;
  if (!reportScope?.key) return { state: 'unknown' };
  const rodentReportRefresh = rodentReportRefreshFor(serviceLine);
  const catalog = rodentReportRefresh
    ? await loadRodentCatalogIndex(knex)
    : { serviceCategoryById: null, rodentCatalogNames: null };
  const caches = { propertyById: new Map(), estimateById: new Map(), onLookupFailure };
  // Same-day bookings are judged TOGETHER: SQL does not order rows within a
  // date, so a proven match on a day wins over an unplaceable booking on that
  // same day, whichever came first. Only a day with no match and an
  // unplaceable booking is 'unknown'.
  const dayOf = (row) => {
    const raw = row?.scheduled_date;
    if (!raw) return null;
    return raw instanceof Date ? raw.toISOString().slice(0, 10) : String(raw).slice(0, 10);
  };
  const candidates = (Array.isArray(rows) ? rows : [])
    .filter((row) => isSameLineVisit(row, { serviceLine, rodentReportRefresh, ...catalog }));
  let index = 0;
  while (index < candidates.length) {
    const day = dayOf(candidates[index]);
    const group = [candidates[index++]];
    while (day && index < candidates.length && dayOf(candidates[index]) === day) group.push(candidates[index++]);
    let unplaceable = false;
    for (const row of group) {
       
      const scope = await resolveVisitPropertyScope(row, knex, caches).catch(failed);
      if (!scope?.key) { unplaceable = true; continue; }
      if (sameResolvedProperty(scope.key, reportScope.key)) return { state: 'scheduled', row };
    }
    if (unplaceable) return { state: 'unknown' };
  }
  return { state: 'none' };
}

module.exports = {
  PROPERTY_SCOPE_COLUMNS,
  rodentReportRefreshFor,
  loadRodentCatalogIndex,
  isSameLineVisit,
  nextSameLineVisitAtProperty,
};
