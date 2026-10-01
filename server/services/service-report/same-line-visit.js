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

module.exports = { rodentReportRefreshFor, loadRodentCatalogIndex, isSameLineVisit };
