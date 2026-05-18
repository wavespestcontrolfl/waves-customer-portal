require('dotenv').config();
const db = require('../models/db');
const logger = require('../services/logger');
const {
  FALLBACK_PDF_MARKER,
  getReportPdf,
  headReportPdf,
  MIN_EXPECTED_REPORT_BYTES,
} = require('../services/service-report/pdf-storage');
const {
  renderAndStoreServiceReportPdf,
} = require('../services/service-report/pdf-queue');
const { safePdfRenderError } = require('../services/service-report/pdf-events');

const THROTTLE_MS = Number(process.env.PDF_BACKFILL_THROTTLE_MS || 1000);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function isBrokenPdf(record) {
  if (!record.pdf_storage_key) return true;
  const head = await headReportPdf(record.pdf_storage_key);
  if (!head) return true;
  if (Number(head.size || 0) < MIN_EXPECTED_REPORT_BYTES) return true;

  const bytes = await getReportPdf(record.pdf_storage_key);
  if (!bytes) return true;
  const prefix = bytes.toString('utf8', 0, Math.min(bytes.length, 50000));
  return prefix.includes(FALLBACK_PDF_MARKER);
}

async function main() {
  const candidates = await db('service_records')
    .whereIn('status', ['completed', 'complete'])
    .where({ report_template_version: 'service_report_v1' })
    .orderBy('started_at', 'desc');

  let processed = 0;
  let rerendered = 0;
  let skipped = 0;
  let failed = 0;

  for (const record of candidates) {
    processed += 1;

    let broken = false;
    try {
      broken = await isBrokenPdf(record);
    } catch (err) {
      broken = true;
      logger.warn(`[pdf-backfill] treating ${record.id} as broken after storage check failed: ${err.message}`);
    }

    if (!broken) {
      skipped += 1;
      continue;
    }

    try {
      await renderAndStoreServiceReportPdf(record.id);
      rerendered += 1;
      console.log(`ok ${record.id} (${rerendered}/${processed})`);
    } catch (err) {
      failed += 1;
      console.error(`fail ${record.id}: ${safePdfRenderError(err)}`);
    }

    await sleep(THROTTLE_MS);
  }

  console.log(`Done. Processed ${processed}, re-rendered ${rerendered}, skipped ${skipped}, failed ${failed}.`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => db.destroy());
