/**
 * Lead staleness sweep (leads funnel integrity).
 *
 * Runs daily at 6:35am ET via scheduler.js. Flips `new` leads to
 * `unresponsive` once they've sat past LEAD_STALENESS_DAYS (default 21)
 * with nobody working them: no lead_activities row inside the window, no
 * scheduled future follow-up, and no booked service on a linked customer
 * (a lead whose customer already has scheduled service is pending
 * won-conversion — burying it as unresponsive would hide it from that fix).
 *
 * Threshold lives in env so it can be tuned without a deploy:
 *   LEAD_STALENESS_DAYS=21
 * Setting it to 0 / empty / any non-numeric value disables the sweep
 * entirely (fail-safe off switch). Leave it unset for the default.
 */
const db = require('../models/db');
const logger = require('./logger');

function getThresholdDays() {
  const raw = process.env.LEAD_STALENESS_DAYS;
  if (raw === undefined) return 21;
  const parsed = parseInt(raw, 10);
  // Any explicit falsy/zero/non-numeric value is the off switch — fail
  // safe to "do nothing" rather than guessing at a threshold.
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  return parsed;
}

// Set-based UPDATE for stale `new` leads. `qb` is the knex instance or an
// open transaction; the caller awaits the returned builder. Exported so
// tests can compile it to SQL and pin the WHERE semantics.
// `excludeSoftDeleted` is passed by the caller only when leads.deleted_at
// exists (the soft-delete lane ships separately) — a removed lead must not
// be flipped or have activity written on it.
function buildStaleLeadUpdate(qb, { now, cutoff, excludeSoftDeleted = false }) {
  return qb('leads')
    .where('leads.status', 'new')
    .where('leads.created_at', '<=', cutoff)
    .modify((builder) => {
      if (excludeSoftDeleted) builder.whereNull('leads.deleted_at');
    })
    // A scheduled future callback means the lead is being worked.
    .where(function () {
      this.whereNull('leads.next_follow_up_at')
        .orWhere('leads.next_follow_up_at', '<=', now);
    })
    // Any activity inside the window means someone/something is on it.
    .whereNotExists(function () {
      this.select(1).from('lead_activities')
        .whereRaw('lead_activities.lead_id = leads.id')
        .where('lead_activities.created_at', '>=', cutoff);
    })
    // A lead linked to a customer with booked (or already-delivered) service
    // is pending won-conversion, not unresponsive. Cancelled/rescheduled
    // rows don't count: a reschedule is replaced by a live row that still
    // matches, and a customer whose only visit was cancelled has no standing
    // service — without the status filter one dead visit from months ago
    // would exempt the lead forever. The correlated subquery can never match
    // when customer_id is NULL, so unlinked leads pass through.
    .whereNotExists(function () {
      this.select(1).from('scheduled_services')
        .whereRaw('scheduled_services.customer_id = leads.customer_id')
        .whereNotIn('scheduled_services.status', ['cancelled', 'rescheduled']);
    })
    .update({ status: 'unresponsive', updated_at: now })
    .returning('id');
}

async function runLeadStalenessSweep() {
  const thresholdDays = getThresholdDays();
  if (!thresholdDays) {
    logger.info('[lead-staleness] LEAD_STALENESS_DAYS disabled — skipping sweep');
    return { disabled: true, marked: 0 };
  }

  const now = new Date();
  const cutoff = new Date(now.getTime() - thresholdDays * 24 * 60 * 60 * 1000);

  // Column-gated so the sweep is correct on either side of the leads
  // soft-delete migration (separate lane): once deleted_at exists, removed
  // leads are excluded; before it lands, the condition would 500 the query.
  const excludeSoftDeleted = await db.schema.hasColumn('leads', 'deleted_at').catch(() => false);

  // One UPDATE + one batched activity INSERT inside a transaction, so a
  // failed insert rolls the flips back and the next run retries cleanly.
  const marked = await db.transaction(async (trx) => {
    const flipped = await buildStaleLeadUpdate(trx, { now, cutoff, excludeSoftDeleted });

    if (flipped.length) {
      await trx('lead_activities').insert(flipped.map(({ id }) => ({
        lead_id: id,
        activity_type: 'status_change',
        description: `Auto-marked unresponsive after ${thresholdDays} days with no contact`,
        performed_by: 'system',
        metadata: JSON.stringify({ auto: true, threshold_days: thresholdDays }),
      })));
    }

    return flipped.length;
  });

  logger.info(`[lead-staleness] thresholdDays=${thresholdDays} marked=${marked}`);
  return { disabled: false, marked };
}

module.exports = { runLeadStalenessSweep, getThresholdDays, buildStaleLeadUpdate };
