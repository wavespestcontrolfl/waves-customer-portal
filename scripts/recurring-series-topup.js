#!/usr/bin/env node
/**
 * One-shot recurring-series top-up.
 *
 * Keeps ongoing recurring plans booked out to a horizon (default 365 days /
 * RECURRING_TOPUP_HORIZON_DAYS) by looping the SAME extend step the
 * completion-time auto-extend uses (server/routes/admin-schedule.js's
 * extendSeriesOnceLocked, via topUpRecurringSeriesLocked /
 * topUpRecurringSeries) — see server/services/recurring-series-topup.js for
 * the nightly cron this script shares its code path with.
 *
 * Dry-run by default: runs the REAL code path (topUpRecurringSeriesLocked)
 * inside a transaction it rolls back, so every line printed is exactly what
 * --apply would do — no separate "preview" logic to drift from the real one.
 * --apply commits and registers a reminder for each spawned visit, exactly
 * like the nightly cron's live pass. No confirmation SMS, no other customer
 * communication either way.
 *
 * Each line prints the customer id (never a name — this codebase's logs,
 * including ops scripts, carry ids only), service type, pattern, the
 * current booked-through date, and the date(s) it added/would add.
 *
 * Usage:
 *   node scripts/recurring-series-topup.js                     # dry run, every eligible ongoing series
 *   node scripts/recurring-series-topup.js --apply              # write
 *   node scripts/recurring-series-topup.js --customer <uuid>    # narrow to one customer's series
 *   node scripts/recurring-series-topup.js --parent <uuid>      # narrow to one series (its root row id)
 *   node scripts/recurring-series-topup.js --horizon-days 180   # override RECURRING_TOPUP_HORIZON_DAYS
 *
 * Under `railway run node scripts/recurring-series-topup.js -- ...`, Railway
 * injects DATABASE_URL (and every other service var) into the process
 * environment before it starts — the dotenv.config() below is a no-op then
 * and only fills gaps for a bare local run (same pattern as the other
 * scripts/*.js one-shots, e.g. scripts/geocode-customers.js).
 */
require('dotenv').config();

const db = require('../server/models/db');

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');

function argValue(flag) {
  const i = args.indexOf(flag);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : null;
}

const CUSTOMER_ID = argValue('--customer');
const PARENT_ID = argValue('--parent');
const HORIZON_DAYS_ARG = argValue('--horizon-days');
const horizonOpt = {};
if (HORIZON_DAYS_ARG) {
  const n = Number(HORIZON_DAYS_ARG);
  if (Number.isFinite(n) && n > 0) horizonOpt.horizonDays = Math.floor(n);
}

async function resolveParentIds() {
  if (PARENT_ID) return [PARENT_ID];
  const cols = await db('scheduled_services').columnInfo();
  if (!cols.recurring_ongoing) return [];
  const query = db('scheduled_services')
    .where({ is_recurring: true, recurring_ongoing: true })
    .whereNull('recurring_parent_id');
  if (CUSTOMER_ID) query.andWhere({ customer_id: CUSTOMER_ID });
  return query.pluck('id');
}

async function main() {
  const { topUpOneSeries } = require('../server/services/recurring-series-topup');
  const parentIds = await resolveParentIds();
  if (!parentIds.length) {
    console.log('No eligible ongoing recurring series matched.');
    await db.destroy();
    return;
  }

  console.log(`${APPLY ? 'APPLYING' : 'DRY RUN'} — ${parentIds.length} candidate series, horizon ${horizonOpt.horizonDays || '(default)'} days\n`);

  const summary = { scanned: parentIds.length, toppedUp: 0, visitsInserted: 0, skipped: {}, errors: 0 };

  for (const parentId of parentIds) {
    try {
      const result = await topUpOneSeries(parentId, { ...horizonOpt, dryRun: !APPLY });
      const insertedDates = (result?.spawnedVisits || []).map((v) => v.scheduledDate);
      if (result?.skipped) {
        summary.skipped[result.skipped] = (summary.skipped[result.skipped] || 0) + 1;
        console.log(`[skip: ${result.skipped}] parent=${parentId}`);
        continue;
      }
      if (insertedDates.length) {
        summary.toppedUp += 1;
        summary.visitsInserted += insertedDates.length;
      }
      // Customer id, not name — this codebase's logs (incl. ops scripts;
      // see ops/agents/README.md) never carry customer names/PII, only ids.
      // Resolve the name from the id in the admin UI when acting on a line.
      console.log(
        `customer=${result.customerId || '(unknown)'} | ${result.serviceType || '(no service type)'} | ${result.recurringPattern || '(no pattern)'} `
        + `| booked through ${result.priorBookedThrough || '(no live visit)'} `
        + `| ${APPLY ? 'added' : 'would add'} ${insertedDates.length ? insertedDates.join(', ') : '(nothing — already at horizon)'}`,
      );
    } catch (e) {
      summary.errors += 1;
      console.error(`[error] parent=${parentId}: ${e.message}`);
    }
  }

  console.log('\nSummary');
  console.log(JSON.stringify(summary, null, 2));
  if (!APPLY) {
    console.log('\nDry run only — nothing was written. Pass --apply to commit.');
  }

  await db.destroy();
}

main().catch(async (err) => {
  console.error(err);
  await db.destroy();
  process.exit(1);
});
