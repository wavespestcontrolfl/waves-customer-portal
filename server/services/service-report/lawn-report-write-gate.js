/**
 * Lawn Report V2 — write-time gate (single source of truth).
 *
 * At completion, build the V2 synthesis once and FREEZE it onto the service record
 * (structured_notes.lawnReportV2). Two purposes:
 *   1. Single source of truth — the SMS (delivery.js) and any later render read the
 *      same synthesized line instead of re-deriving it independently (the root cause
 *      of the contradictions the consistency layer reconciles at render time).
 *   2. Write-time consistency check — run reconcileLawnReport and surface any
 *      blocker-severity contradictions to the office (logged; never blocks completion).
 *
 * Best-effort: any failure leaves the record untouched and the render-time path still
 * reconciles. Lawn visits only.
 */

const logger = require('../logger');

function parseJsonObject(value) {
  if (!value) return {};
  if (typeof value === 'object') return value;
  try { return JSON.parse(value) || {}; } catch { return {}; }
}

/**
 * @param {object} input
 * @param {object} input.service  the service_records row (needs id, service_line/type, customer_id)
 * @param {object} input.knex
 * @returns {Promise<{ smsSummary: string|null, warnings: object[], persisted: boolean }>}
 */
async function finalizeLawnReportSynthesis({ service, knex } = {}) {
  const empty = { smsSummary: null, warnings: [], persisted: false };
  if (!service || !service.id || !knex) return empty;
  const serviceLine = service.service_line || (/(lawn)/i.test(String(service.service_type || '')) ? 'lawn' : null);
  if (serviceLine !== 'lawn') return empty;

  try {
    const { buildReportV1Data } = require('./report-data');
    const { reconcileLawnReport } = require('./report-consistency');
    const { loadServiceRecordForPdf, ensureReportToken } = require('./pdf-queue');

    // Freeze the SAME reportV2 the customer report renders — built from the full
    // inputs (applications, actions, mowing, customer concern, water snapshot) on a
    // customer-JOINED record (lat/lng for area weather) — so the frozen SMS line
    // can't diverge from the report the link opens. (gated on LAWN_REPORT_V2 by the
    // caller; buildReportV1Data only emits reportV2 under that flag.)
    const joined = await loadServiceRecordForPdf(service.id, knex).catch(() => null);
    const record = joined || service;
    const token = await ensureReportToken(service.id, knex);
    const data = await buildReportV1Data(record, token, knex).catch(() => null);
    const reportV2 = data && data.reportV2;
    if (!reportV2) return empty;

    const fix = reconcileLawnReport({ data, reportV2 }) || { warnings: [] };
    const warnings = fix.warnings || [];

    // Surface contradictions to the office without blocking completion.
    const blockers = warnings.filter((w) => w.severity === 'blocker');
    if (blockers.length) {
      logger.warn(`[lawn-report-gate] ${blockers.length} blocker contradiction(s) on service_record ${service.id}: ${blockers.map((b) => b.code).join(', ')}`);
    }

    const frozen = {
      smsSummary: reportV2.smsSummary || null,
      todaysResult: fix.todaysResult || null,
      statusHeadline: reportV2.snapshot?.statusHeadline || null,
      generatedAt: new Date().toISOString(),
      warningCodes: warnings.map((w) => w.code),
    };

    const existing = parseJsonObject(service.structured_notes);
    const merged = { ...existing, lawnReportV2: frozen };
    await knex('service_records').where({ id: service.id }).update({ structured_notes: JSON.stringify(merged) });

    return { smsSummary: frozen.smsSummary, frozen, warnings, persisted: true };
  } catch (err) {
    logger.warn(`[lawn-report-gate] synthesis failed for service_record ${service?.id}: ${err.message}`);
    return empty;
  }
}

// Read the frozen SMS line off a record (used by delivery.js so the text matches the report).
function frozenSmsSummary(record) {
  const sn = parseJsonObject(record && record.structured_notes);
  const s = sn.lawnReportV2 && sn.lawnReportV2.smsSummary;
  return typeof s === 'string' && s.trim() ? s.trim() : null;
}

module.exports = { finalizeLawnReportSynthesis, frozenSmsSummary };
