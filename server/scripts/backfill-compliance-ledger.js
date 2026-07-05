/**
 * Backfill the FDACS compliance ledger (property_application_history) for
 * completions whose products were never ledgered.
 *
 * The live V2 completion path (admin-dispatch :serviceId/complete) wrote
 * service_records + service_products but never called
 * ComplianceService.createComplianceRecords — only the legacy
 * admin-schedule status flip did. Every V2-path completion since the
 * cutover is therefore missing from the DACS inspector export and
 * under-counts application-limit caps (e.g. Celsius 3/yr).
 *
 * This script finds service_records that have service_products rows with no
 * matching ledger row and reconstructs the ledger through the SAME corrected
 * writer the live paths now use (single source of truth) — target_pest from
 * the stored service_products.targets verbatim, weather from
 * service_records.conditions, area only from explicit sqft measurements.
 * Nothing is guessed: records with no stored targets get a NULL target_pest
 * (counted and reported), never an inferred pest.
 *
 * Idempotent: the writer dedupes on service_product_id (unique index,
 * migration 20260705000401) and skips products legacy rows already cover,
 * so re-runs and already-ledgered legacy completions write nothing.
 *
 * Usage:
 *   node server/scripts/backfill-compliance-ledger.js               # dry-run (default)
 *   node server/scripts/backfill-compliance-ledger.js --dry-run     # same, explicit
 *   node server/scripts/backfill-compliance-ledger.js --execute     # write ledger rows
 *   node server/scripts/backfill-compliance-ledger.js --limit 200
 *
 * Dry-run opens a transaction per record, runs the real writer, and ROLLS
 * BACK — the printed counts/sample are exactly what --execute would commit.
 */
require('dotenv').config();
const db = require('../models/db');
const logger = require('../services/logger');
const ComplianceService = require('../services/compliance');

const BATCH = 200;
const SAMPLE_MAX = 10;

// Sentinel used to abort (roll back) the per-record transaction in dry-run
// mode after the writer has produced its rows.
class DryRunRollback extends Error {
  constructor(rows) {
    super('dry-run rollback');
    this.isDryRunRollback = true;
    this.rows = rows;
  }
}

function parseArgs(argv = process.argv) {
  const execute = argv.includes('--execute');
  const limitIdx = argv.indexOf('--limit');
  const limit = limitIdx >= 0 ? (parseInt(argv[limitIdx + 1], 10) || Infinity) : Infinity;
  return { execute, limit };
}

// service_records that still have at least one un-ledgered product row.
// Keyset-paginated on the uuid PK (uuid > uuid is a stable ordering).
async function fetchCandidates(lastId) {
  return db('service_records as sr')
    .whereExists(function productMissingLedgerRow() {
      this.select(1)
        .from('service_products as sp')
        .whereRaw('sp.service_record_id = sr.id')
        .whereNotExists(function alreadyLedgered() {
          this.select(1)
            .from('property_application_history as pah')
            .whereRaw('pah.service_product_id = sp.id');
        });
    })
    .modify((qb) => { if (lastId) qb.andWhere('sr.id', '>', lastId); })
    .orderBy('sr.id', 'asc')
    .limit(BATCH)
    .select('sr.id', 'sr.customer_id', 'sr.service_date', 'sr.service_type', 'sr.status');
}

// Run the writer for one record. Dry-run: same writer, same transaction
// shape, rolled back before commit. Returns the rows it wrote/would write.
async function reconstructRecord(serviceRecordId, execute) {
  if (execute) {
    let rows = [];
    await db.transaction(async (trx) => {
      rows = await ComplianceService.createComplianceRecords(serviceRecordId, { trx });
    });
    return rows;
  }
  try {
    await db.transaction(async (trx) => {
      const rows = await ComplianceService.createComplianceRecords(serviceRecordId, { trx });
      throw new DryRunRollback(rows);
    });
  } catch (err) {
    if (err && err.isDryRunRollback) return err.rows;
    throw err;
  }
  return [];
}

async function runBackfill({ execute = false, limit = Infinity } = {}) {
  const summary = {
    executed: execute,
    recordsScanned: 0,
    recordsReconstructed: 0,
    rowsWritten: 0,
    rowsMissingTargetPest: 0,
    samples: [],
  };

  logger.info(`[compliance-backfill] starting (${execute ? 'EXECUTE' : 'dry-run'}, limit=${limit})`);

  let lastId = null;
  outer:
  for (;;) {
    const candidates = await fetchCandidates(lastId);
    if (!candidates.length) break;

    for (const sr of candidates) {
      lastId = sr.id;
      if (summary.recordsScanned >= limit) break outer;
      summary.recordsScanned += 1;

      const rows = await reconstructRecord(sr.id, execute);
      if (!rows.length) continue; // legacy rows already cover every product

      summary.recordsReconstructed += 1;
      summary.rowsWritten += rows.length;

      for (const row of rows) {
        if (!row.target_pest) summary.rowsMissingTargetPest += 1;
        if (summary.samples.length < SAMPLE_MAX) {
          let productName = null;
          if (row.product_id) {
            const catalogRow = await db('products_catalog')
              .where({ id: row.product_id })
              .first('name')
              .catch(() => null);
            productName = catalogRow?.name || null;
          }
          // pg returns date columns as JS Dates (midnight ET) — format back
          // to the calendar date for the sample printout.
          const appDate = row.application_date instanceof Date
            ? row.application_date.toISOString().slice(0, 10)
            : row.application_date;
          summary.samples.push({
            serviceRecordId: sr.id,
            applicationDate: appDate,
            serviceType: sr.service_type || null,
            product: productName || row.product_id || '(no catalog match)',
            targetPest: row.target_pest || null,
            areaTreatedSqft: row.area_treated_sqft || null,
            quantityApplied: row.quantity_applied || null,
            quantityUnit: row.quantity_unit || null,
            weather: row.weather_conditions || null,
            applicatorLicense: row.applicator_license || null,
          });
        }
      }
    }
  }

  return summary;
}

function printSummary(summary) {
  const verb = summary.executed ? 'wrote' : 'would write';
  console.log('');
  console.log(`Compliance ledger backfill — ${summary.executed ? 'EXECUTE' : 'DRY RUN'}`);
  console.log(`  service_records scanned (with un-ledgered products): ${summary.recordsScanned}`);
  console.log(`  records reconstructed:                               ${summary.recordsReconstructed}`);
  console.log(`  ledger rows ${verb}:                             ${summary.rowsWritten}`);
  console.log(`  rows with NULL target_pest (no stored targets — conservative, never guessed): ${summary.rowsMissingTargetPest}`);

  if (summary.samples.length) {
    console.log('\nSample rows:');
    for (const s of summary.samples) {
      console.log(
        `  ${s.applicationDate} record=${s.serviceRecordId} product="${s.product}"`
        + ` target_pest=${s.targetPest ?? 'NULL'} area_sqft=${s.areaTreatedSqft ?? 'NULL'}`
        + ` qty=${s.quantityApplied ?? 'NULL'}${s.quantityUnit ? ` ${s.quantityUnit}` : ''}`
        + ` weather="${s.weather ?? 'NULL'}" license=${s.applicatorLicense ?? 'NULL'}`
      );
    }
  }

  if (!summary.executed) {
    console.log('\nDRY RUN — nothing written. Re-run with --execute to write these ledger rows.');
  }
}

async function main() {
  const { execute, limit } = parseArgs();
  const summary = await runBackfill({ execute, limit });
  printSummary(summary);
  logger.info(
    `[compliance-backfill] done — scanned ${summary.recordsScanned}, `
    + `${summary.executed ? 'wrote' : 'would write'} ${summary.rowsWritten} rows `
    + `across ${summary.recordsReconstructed} records (${summary.rowsMissingTargetPest} NULL target_pest)`
  );
}

if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch((err) => {
      logger.error('[compliance-backfill] failed', { error: err.message });
      console.error(err);
      process.exit(1);
    });
}

module.exports = { runBackfill, parseArgs };
