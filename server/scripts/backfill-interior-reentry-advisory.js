/**
 * Backfill interior re-entry advisory for services completed before the
 * structured-scope fix (PR1).
 *
 * Before the fix, the completion write zeroed advisory.interior_reentry_min
 * whenever the chipped areas read exterior-only — even if an interior
 * treatment action was recorded — and the report build can only zero further,
 * never restore. This script recovers the interior window for affected
 * records by re-deriving scope from the action text/area data already stored
 * on each service_record, then recomputing the advisory the same way the
 * fixed completion route now does.
 *
 * Only records where:
 *   - advisory.interior_reentry_min === 0, AND
 *   - the service line has a non-zero interior re-entry default (pest/termite), AND
 *   - the stored actions/areas indicate an interior treatment
 * are corrected. Exterior-only visits are left untouched. Idempotent —
 * corrected rows have interior_reentry_min > 0 and are skipped on re-run.
 *
 * Usage:
 *   node server/scripts/backfill-interior-reentry-advisory.js            # dry-run (default)
 *   node server/scripts/backfill-interior-reentry-advisory.js --apply    # write changes
 *   node server/scripts/backfill-interior-reentry-advisory.js --limit 200
 *
 * Against prod from a local machine, alias DATABASE_URL to DATABASE_PUBLIC_URL
 * (see repo notes on Railway prod DB access).
 */
require('dotenv').config();
const db = require('../models/db');
const logger = require('../services/logger');
const {
  parseJsonObject,
  parseJsonArray,
  buildCompletionAdvisory,
} = require('../services/service-report/report-data');
const { detectServiceLine, getServiceLineConfig } = require('../services/service-report/service-line-configs');
const { classifyActionScope } = require('../services/service-report/action-scope');

const APPLY = process.argv.includes('--apply');
const BATCH = 500;
function getLimit() {
  const idx = process.argv.indexOf('--limit');
  return idx >= 0 ? (parseInt(process.argv[idx + 1], 10) || Infinity) : Infinity;
}

// Resolve the interior/exterior scope entries for a record, preferring the
// structured field (new records) and falling back to the historical action
// text labels (old records, where the structured field never existed).
function resolveScopes(structured) {
  const existing = parseJsonArray(structured.protocolActionScopesCompleted)
    .map((entry) => {
      if (!entry || typeof entry !== 'object') return null;
      const scope = String(entry.scope || '').toLowerCase();
      if (scope !== 'interior' && scope !== 'exterior') return null;
      return { label: entry.label || null, scope, treatmentApplied: entry.treatmentApplied === true };
    })
    .filter(Boolean);
  if (existing.length) return existing;

  return parseJsonArray(structured.protocolActionsCompleted)
    .map((label) => {
      const { scope, treatmentApplied } = classifyActionScope(label);
      if (!scope) return null;
      return { label: String(label || '').trim() || null, scope, treatmentApplied };
    })
    .filter(Boolean);
}

async function main() {
  let scanned = 0;
  let fixed = 0;
  let lastId = 0;
  const limit = getLimit();
  const samples = [];

  logger.info(`[reentry-backfill] starting (apply=${APPLY}, limit=${limit})`);

  for (;;) {
    const rows = await db('service_records')
      .whereNotNull('advisory')
      .andWhere('id', '>', lastId)
      .orderBy('id', 'asc')
      .limit(BATCH)
      .select('id', 'service_type', 'service_line', 'structured_notes', 'advisory');
    if (!rows.length) break;

    for (const row of rows) {
      lastId = row.id;
      if (scanned >= limit) break;
      scanned += 1;

      const advisory = parseJsonObject(row.advisory);
      if (advisory.interior_reentry_min !== 0) continue; // only zeroed rows

      const line = row.service_line || detectServiceLine(row.service_type);
      const config = getServiceLineConfig(line);
      const defaultInterior = config?.advisoryDefaults?.interior_reentry_min || 0;
      if (!defaultInterior) continue; // this service line never has interior re-entry

      const structured = parseJsonObject(row.structured_notes);
      const scopes = resolveScopes(structured);
      const areasTreated = parseJsonArray(structured.areasTreated).length
        ? parseJsonArray(structured.areasTreated)
        : parseJsonArray(structured.areasServiced);

      const recomputed = buildCompletionAdvisory({
        advisoryDefaults: config.advisoryDefaults,
        completionAreas: areasTreated,
        protocolActionScopes: scopes,
      });
      if (!(recomputed.interior_reentry_min > 0)) continue; // no interior signal — leave as-is

      fixed += 1;
      if (samples.length < 15) {
        samples.push({ id: row.id, line, restoredTo: recomputed.interior_reentry_min, scopes: scopes.map((s) => `${s.scope}${s.treatmentApplied ? '' : '(insp)'}`) });
      }

      if (APPLY) {
        const newAdvisory = { ...advisory, interior_reentry_min: recomputed.interior_reentry_min };
        const newStructured = { ...structured, protocolActionScopesCompleted: scopes };
        await db('service_records')
          .where({ id: row.id })
          .update({
            advisory: JSON.stringify(newAdvisory),
            structured_notes: JSON.stringify(newStructured),
          });
      }
    }
    if (scanned >= limit) break;
  }

  logger.info(`[reentry-backfill] done — scanned ${scanned}, ${APPLY ? 'updated' : 'would update'} ${fixed}`);
  if (samples.length) {
    console.log('Sample corrections:');
    for (const s of samples) {
      console.log(`  service_record ${s.id} [${s.line}] interior_reentry_min 0 -> ${s.restoredTo} (scopes: ${s.scopes.join(', ') || 'from areas'})`);
    }
  }
  if (!APPLY) console.log('\nDRY RUN — re-run with --apply to write these changes.');
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    logger.error('[reentry-backfill] failed', { error: err.message });
    console.error(err);
    process.exit(1);
  });
