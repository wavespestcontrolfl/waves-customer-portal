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
 * recurring scheduled service. Recurring rows are the precise population for the
 * `recurring_service_booked` trigger; we deliberately do NOT key off the
 * WaveGuard tier, because tier values like `One-Time`/`None`/`N/A` are NOT plan
 * members (see waveguard-existing-services.js NON_MEMBERSHIP_TIER_KEYS) and a
 * one-time buyer must not be swept in. Legacy recurring rows may carry a cadence
 * in `recurring_pattern`/`recurring_parent_id` without ever stamping the
 * `is_recurring` boolean, so detection matches the same OR the cleanup scripts
 * use (cleanup-one-time-placeholder-recurring.js).
 *
 * For each customer it reuses the shared `convertLeadFromEvent` with
 * `enforceOriginating: true`, so the conversion is identical to the live
 * `recurring_service_booked` trigger PLUS a backfill-only guard: because this
 * runs long after the booking, the fuzzy contact fallback is restricted to the
 * customer's ORIGINATING lead (first contacted on/before they became a
 * customer) and can never mark a later add-on inquiry as won. Single
 * unambiguous open lead only, never an established customer's add-on,
 * idempotent.
 *
 *   node server/scripts/backfill-recurring-booking-lead-conversions.js
 *   node server/scripts/backfill-recurring-booking-lead-conversions.js --commit
 *
 * SAFE BY DEFAULT: dry-run unless `--commit` is passed. Dry-run runs the EXACT
 * resolution the commit path would (inside a transaction that is rolled back),
 * so the preview is an accurate list of the leads --commit will convert. This
 * writes to whatever DATABASE_URL points at, so run it deliberately (break-glass
 * on prod, per the waves-db policy).
 */
require('dotenv').config();
const db = require('../models/db');
const logger = require('../services/logger');
const { convertLeadFromEvent } = require('../services/lead-estimate-link');

const COMMIT = process.argv.includes('--commit');

// Customers whose deal a recurring booking closed: at least one recurring
// scheduled service that isn't cancelled/rescheduled. `is_recurring` was not
// always stamped on legacy rows, so also accept a row that carries a cadence via
// recurring_pattern or rides a recurring parent — the same fallback the cleanup
// scripts use. Columns are feature-detected in case a schema predates them.
async function discoverCustomerIds() {
  const cols = await db('scheduled_services').columnInfo();
  const rows = await db('scheduled_services')
    .distinct('customer_id')
    .whereNotNull('customer_id')
    .whereNotIn('status', ['cancelled', 'rescheduled'])
    .where((q) => {
      q.where('is_recurring', true);
      if (cols.recurring_pattern) q.orWhereNotNull('recurring_pattern');
      if (cols.recurring_parent_id) q.orWhereNotNull('recurring_parent_id');
    });
  return rows.map((r) => r.customer_id);
}

async function run() {
  const customerIds = await discoverCustomerIds();
  logger.info(`[backfill-recurring-leads] starting (${COMMIT ? 'COMMIT' : 'DRY-RUN'}) — ${customerIds.length} customer(s) with a recurring booking`);

  let converted = 0;
  let skipped = 0;

  for (const customerId of customerIds) {
    // Run the real resolution inside a transaction so dry-run mirrors commit
    // exactly: same convertLeadFromEvent, same enforceOriginating guard, same
    // ambiguity/first-close checks. Dry-run rolls the transaction back so the
    // preview lists precisely what --commit would convert, with zero writes.
    let result;
    await db.transaction(async (trx) => {
      result = await convertLeadFromEvent({
        source: 'recurring_service_booked',
        customerId,
        enforceOriginating: true,
        database: trx,
      });
      // Throwing rolls the transaction back (knex) — dry-run discards every
      // write while keeping `result` so the preview reflects the real resolution.
      if (!COMMIT) throw new Error('dry-run rollback');
    }).catch((err) => {
      if (!/dry-run rollback/.test(err.message)) throw err;
    });

    if (result && result.converted) {
      converted += result.count;
      logger.info(`[backfill-recurring-leads] ${COMMIT ? 'converted' : 'DRY-RUN would convert'} ${result.count} lead(s) for customer ${customerId}: ${result.leadIds.join(', ')}`);
    } else {
      skipped += 1;
    }
  }

  logger.info(`[backfill-recurring-leads] done — ${COMMIT ? 'converted' : 'would convert'}=${converted} skipped=${skipped}${COMMIT ? '' : ' (dry-run, no writes)'}`);
}

run()
  .then(() => db.destroy())
  .then(() => process.exit(0))
  .catch((err) => {
    logger.error(`[backfill-recurring-leads] failed: ${err.message}`);
    db.destroy().finally(() => process.exit(1));
  });
