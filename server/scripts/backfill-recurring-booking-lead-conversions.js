/**
 * One-off backfill: convert leads that are stuck in an open status even though
 * the customer already has a recurring service booked (e.g. a quarterly
 * WaveGuard membership). Booking a recurring service did not used to write back
 * to the lead — only a completed/invoiced/accepted event did — so a lead whose
 * first visit hasn't happened yet stayed `new`. The triggers added alongside
 * this script fix that going forward (admin + self-booking); leads that were
 * booked BEFORE the triggers shipped need a one-time nudge.
 *
 * Unlike the contact-targeted backfill (backfill-lead-acceptance-triggers.js),
 * this one DISCOVERS its own targets: every customer that has at least one
 * recurring scheduled service (or an active WaveGuard plan). For each it reuses
 * the shared `convertLeadFromEvent` so the conversion is identical to the live
 * `recurring_service_booked` trigger — single unambiguous open ORIGINATING lead
 * only, never an established customer's add-on, idempotent. Already-won leads
 * and ambiguous matches are skipped, not guessed.
 *
 *   node server/scripts/backfill-recurring-booking-lead-conversions.js
 *   node server/scripts/backfill-recurring-booking-lead-conversions.js --commit
 *
 * SAFE BY DEFAULT: dry-run unless `--commit` is passed. This writes to whatever
 * DATABASE_URL points at, so run it deliberately (break-glass on prod, per the
 * waves-db policy).
 */
require('dotenv').config();
const db = require('../models/db');
const logger = require('../services/logger');
const { convertLeadFromEvent } = require('../services/lead-estimate-link');

const COMMIT = process.argv.includes('--commit');

// Customers whose deal a recurring booking closed: at least one recurring
// scheduled service that isn't cancelled, OR an active WaveGuard plan. UNION
// dedupes; either signal alone is enough to mirror the live trigger.
async function discoverCustomerIds() {
  const fromRecurring = await db('scheduled_services')
    .distinct('customer_id')
    .where('is_recurring', true)
    .whereNotNull('customer_id')
    .whereNotIn('status', ['cancelled', 'rescheduled']);

  const ids = new Set(fromRecurring.map((r) => r.customer_id));

  // WaveGuard plan as a secondary signal — guard the column in case the schema
  // predates it on some environment.
  try {
    const fromPlan = await db('customers')
      .distinct('id')
      .whereNotNull('waveguard_tier')
      .whereNotIn('waveguard_tier', ['none', 'onetime']);
    for (const row of fromPlan) ids.add(row.id);
  } catch (err) {
    logger.warn(`[backfill-recurring-leads] waveguard_tier discovery skipped: ${err.message}`);
  }

  return Array.from(ids);
}

async function run() {
  const customerIds = await discoverCustomerIds();
  logger.info(`[backfill-recurring-leads] starting (${COMMIT ? 'COMMIT' : 'DRY-RUN'}) — ${customerIds.length} customer(s) with a recurring booking`);

  let converted = 0;
  let skipped = 0;

  for (const customerId of customerIds) {
    if (!COMMIT) {
      // Dry-run still resolves so the operator can see what WOULD convert,
      // but passes no source side-effects: convertLeadFromEvent has no
      // write-free preview mode, so we only report the candidate here.
      const open = await db('leads')
        .where('customer_id', customerId)
        .whereNotIn('status', ['won', 'lost', 'unresponsive', 'disqualified', 'duplicate']);
      if (open.length) {
        logger.info(`[backfill-recurring-leads] DRY-RUN customer ${customerId}: ${open.length} open lead(s) candidate`);
      }
      continue;
    }

    const result = await convertLeadFromEvent({ source: 'recurring_service_booked', customerId });
    if (result.converted) {
      converted += result.count;
      logger.info(`[backfill-recurring-leads] converted ${result.count} lead(s) for customer ${customerId}: ${result.leadIds.join(', ')}`);
    } else {
      skipped += 1;
    }
  }

  logger.info(`[backfill-recurring-leads] done — converted=${converted} skipped=${skipped}${COMMIT ? '' : ' (dry-run, no writes)'}`);
}

run()
  .then(() => db.destroy())
  .then(() => process.exit(0))
  .catch((err) => {
    logger.error(`[backfill-recurring-leads] failed: ${err.message}`);
    db.destroy().finally(() => process.exit(1));
  });
