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
 * including ops scripts, carry ids only; AGENTS.md's PII-in-logs rule is
 * unconditional, with no opt-in carve-out — resolve the name from the id
 * in the admin UI), service type, pattern, the current booked-through
 * date, and the date(s) it added/would add.
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

// A selector flag with no value (e.g. a trailing `--apply --customer`) must
// fail, never widen to every eligible series (Codex GitHub r5 P2).
for (const flag of ['--customer', '--parent', '--horizon-days']) {
  if (!args.includes(flag)) continue;
  const v = argValue(flag);
  if (v == null || v.startsWith('--')) {
    console.error(`Missing value for ${flag}.`);
    process.exit(1);
  }
}

const CUSTOMER_ID = argValue('--customer');
const PARENT_ID = argValue('--parent');
const HORIZON_DAYS_ARG = argValue('--horizon-days');
// Default through the SAME env reader the nightly sweep uses
// (RECURRING_TOPUP_HORIZON_DAYS, else 365) — without this, an operator who
// has that env var set to override the default would silently get
// topUpRecurringSeriesLocked's own 365-day fallback instead whenever
// --horizon-days is omitted (Codex pre-push P1).
const { horizonDaysFromEnv } = require('../server/services/recurring-series-topup');
let horizonDays = horizonDaysFromEnv();
// An explicit --horizon-days is an operator typo risk (a stray decimal, a
// negative, a value orders of magnitude too large) that topUpOneSeries has
// no reason to validate itself — it only ever sees the env-sourced default
// otherwise. Reject before any DB work rather than silently falling back to
// the default (which would mask the typo) or passing a bad value through
// (Codex GitHub r3 P2). 730 (two years) is a generous sanity ceiling — no
// legitimate recurring plan needs a longer look-ahead, and it keeps a
// fat-fingered "18000" from asking the sweep to walk years of candidate
// dates per series.
if (HORIZON_DAYS_ARG != null) {
  const n = Number(HORIZON_DAYS_ARG);
  if (!Number.isInteger(n) || n < 1 || n > 730) {
    console.error(`Invalid --horizon-days "${HORIZON_DAYS_ARG}" — must be a positive integer from 1 to 730.`);
    process.exit(1);
  }
  horizonDays = n;
}
const horizonOpt = { horizonDays };

// Classifies one series' topUpOneSeries() result into exactly one summary
// bucket — 'toppedUp', 'no_change' (Codex GitHub r3 P2: an eligible series
// that inserted nothing without any named skip reason was invisible in the
// outcome table before this, so toppedUp + no_change + every skip reason +
// errors did not sum to scanned), or `skip:<reason>`. Pulled out as its
// own function so the no_change bucket has a direct unit test without
// running the whole CLI against a real database.
function classifySeriesOutcome(result) {
  if (result?.skipped) return `skip:${result.skipped}`;
  const inserted = (result?.spawnedVisits || []).length;
  return inserted > 0 ? 'toppedUp' : 'no_change';
}

// One row for the owner's "Duplicate series for review" table — ids only,
// per the PII rule (see main()'s own comment on this).
function duplicateReviewRow(parentId, result) {
  return {
    parent_id: parentId,
    customer_id: result.customerId || '(unknown)',
    service_type: result.serviceType || '(no service type)',
    sibling_parent_ids: (result.duplicateSeriesIds || []).join(', '),
  };
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

  console.log(`${APPLY ? 'APPLYING' : 'DRY RUN'} — ${parentIds.length} candidate series, horizon ${horizonOpt.horizonDays} days\n`);

  // noChange: an eligible series that inserted nothing without any of the
  // named skip reasons — extendSeriesOnceLocked's own 12-cadence-step
  // search came up empty for some reason other than the horizon (a busy
  // calendar in non-advisory mode, a persistent blackout shift) and
  // already logged its own warning above this line. Counted separately so
  // toppedUp + noChange + every skip reason + errors always sums to
  // scanned — without it this bucket was invisible in the outcome table
  // and the totals silently didn't add up.
  const summary = {
    scanned: parentIds.length, toppedUp: 0, visitsInserted: 0, noChange: 0, skipped: {}, errors: 0,
  };
  // Duplicate-series hits for the owner's own review — parent id, customer
  // id, service type, and the sibling parent ids duplicate_series matched
  // against. The guard skips BOTH sides rather than guessing which one to
  // keep (see isDuplicateActiveSeries's own comment), so this list is how
  // the owner finds and clears the stale recurring_ongoing root by hand.
  // Ids only, never a name — same PII rule as every other line here.
  const duplicatesForReview = [];

  for (const parentId of parentIds) {
    try {
      const result = await topUpOneSeries(parentId, { ...horizonOpt, dryRun: !APPLY });
      const insertedDates = (result?.spawnedVisits || []).map((v) => v.scheduledDate);
      const outcome = classifySeriesOutcome(result);
      if (outcome.startsWith('skip:')) {
        const reason = outcome.slice('skip:'.length);
        summary.skipped[reason] = (summary.skipped[reason] || 0) + 1;
        console.log(`[skip: ${reason}] parent=${parentId}`);
        if (reason === 'duplicate_series' && Array.isArray(result.duplicateSeriesIds)) {
          duplicatesForReview.push(duplicateReviewRow(parentId, result));
        }
        continue;
      }
      if (outcome === 'toppedUp') {
        summary.toppedUp += 1;
        summary.visitsInserted += insertedDates.length;
      } else {
        summary.noChange += 1;
      }
      // Customer id, not name — this codebase's logs (incl. ops scripts;
      // see ops/agents/README.md) never carry customer names/PII, only
      // ids, and AGENTS.md's rule here is unconditional (no opt-in
      // carve-out — a prior version of this script tried a `--names` flag
      // for the owner reviewing a preview directly, and Codex's local
      // pre-push audit correctly caught that an opt-in doesn't create an
      // exception the rule itself doesn't grant). Resolve the name from
      // the id in the admin UI when acting on a line.
      console.log(
        `customer=${result.customerId || '(unknown)'} | ${result.serviceType || '(no service type)'} | ${result.recurringPattern || '(no pattern)'} `
        + `| booked through ${result.priorBookedThrough || '(no live visit)'} `
        // A falsy `skipped` here (result?.skipped was already handled above,
        // including the honest at_horizon / no_live_visit / unbillable /
        // duplicate_series reasons — every empty-run case
        // topUpRecurringSeriesLocked can actually name) with an empty
        // insertedDates is the noChange bucket above: extendSeriesOnceLocked's
        // own 12-cadence-step search came up empty for some OTHER reason
        // and already logged its own "already booked" warning above this
        // line — never re-claim a specific reason this branch doesn't
        // actually know to be true.
        + `| ${APPLY ? 'added' : 'would add'} ${insertedDates.length ? insertedDates.join(', ') : '(nothing inserted — see warning above)'}`,
      );
    } catch (e) {
      summary.errors += 1;
      console.error(`[error] parent=${parentId}: ${e.message}`);
    }
  }

  console.log('\nSummary');
  console.log(JSON.stringify(summary, null, 2));
  console.log('\nBy outcome');
  console.table([
    { outcome: 'toppedUp', count: summary.toppedUp },
    { outcome: 'no_change', count: summary.noChange },
    ...Object.entries(summary.skipped).map(([reason, count]) => ({ outcome: `skip: ${reason}`, count })),
    { outcome: 'errors', count: summary.errors },
  ]);
  if (duplicatesForReview.length) {
    console.log('\nDuplicate series for review — clear the stale recurring_ongoing flag by hand:');
    console.table(duplicatesForReview);
  }
  if (!APPLY) {
    console.log('\nDry run only — nothing was written. Pass --apply to commit.');
  }

  await db.destroy();
  // A per-series failure is caught and tallied above so one bad series
  // never stops the run, but the process must still leave a nonzero exit
  // code behind it — a cron/CI wrapper checking $? off a summary that says
  // "errors: 3" and exit 0 would report the whole run healthy (Codex
  // GitHub r3 P2).
  if (summary.errors > 0) process.exitCode = 1;
}

// require.main guard: lets recurring-series-topup.test.js require this
// file to unit-test classifySeriesOutcome directly, without main() running
// against a real database as a side effect of the require() — `node
// scripts/recurring-series-topup.js` (require.main === module) is
// completely unaffected.
if (require.main === module) {
  main().catch(async (err) => {
    console.error(err);
    await db.destroy();
    process.exit(1);
  });
}

module.exports = { classifySeriesOutcome };
