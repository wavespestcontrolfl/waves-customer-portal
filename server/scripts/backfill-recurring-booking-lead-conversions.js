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
 * resolution the commit path would, but swaps in a no-op attribution service so
 * the terminal markConverted writes nothing — the preview is an accurate list of
 * the leads --commit will convert, with zero database writes. (markConverted
 * writes through its own module-level connection, so a wrapping transaction
 * would NOT make it rollback-safe — the stub is what guarantees a clean
 * dry-run.) --commit writes to whatever DATABASE_URL points at, so run it
 * deliberately (break-glass on prod, per the waves-db policy).
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

  // Dry-run runs the EXACT same resolution as commit — convertLeadFromEvent's
  // only write is the terminal markConverted (it otherwise just reads), and
  // markConverted writes through its own module-level db connection (NOT any
  // transaction we could wrap), so a no-op attribution stub is the only true
  // preview: every tier, the enforceOriginating guard, and the ambiguity/first-
  // close checks all run and the returned leadIds are exactly what --commit
  // would convert, with zero writes. Commit uses the real attribution service.
  const previewAttribution = { markConverted: async () => {} };

  let converted = 0;
  let skipped = 0;

  for (const customerId of customerIds) {
    const result = await convertLeadFromEvent({
      source: 'recurring_service_booked',
      customerId,
      enforceOriginating: true,
      ...(COMMIT ? {} : { leadAttributionService: previewAttribution }),
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
