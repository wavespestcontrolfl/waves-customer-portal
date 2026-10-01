/**
 * Estimate expiration worker (Estimates v2 spec §5).
 *
 * Runs daily at 6am ET via scheduler.js. Flips any `sent` or `viewed`
 * estimate older than `ESTIMATE_EXPIRATION_DAYS` (default 7) to `expired`,
 * and also flips anything whose `expires_at` has passed regardless of
 * inactivity. Writes `declined_at = now()` only when the row also moves
 * to expired via the age rule (so Virginia can see when it flipped).
 *
 * Threshold lives in env so Virginia can tune without a deploy:
 *   ESTIMATE_EXPIRATION_DAYS=7
 */
const db = require('../models/db');
const logger = require('./logger');
const { scrubSentryText } = require('../utils/sentry-scrub');
const { excludePendingFirstBookings } = require('./estimate-conversion-guard');
const { ESTIMATE_SEND_EXPIRY_DAYS } = require('./admin-estimate-persistence');
const { EXPIRED_DISPOSITION_SQL } = require('./estimate-disposition');
const { estimateFollowupBlockedReason } = require('./estimate-comms-eligibility');
const { FIXED_BID_VALIDITY_ABSENT_SQL } = require('./proposal-bid');

// Every expiry flip also stamps WHY (estimator audit 2026-08-29 P0): the
// 130-of-161 losses that expire silently were the whole learning gap. The
// CASE reads the PRE-update row (Postgres SET semantics) so an opened-then-
// abandoned estimate classifies as expired_viewed, never-opened as
// expired_unviewed; a disposition staff already stamped is kept (COALESCE).
function expiredUpdate(now) {
  return {
    status: 'expired',
    updated_at: now,
    disposition: db.raw(EXPIRED_DISPOSITION_SQL),
    disposition_source: db.raw("COALESCE(disposition_source, 'system')"),
    disposition_at: db.raw('COALESCE(disposition_at, ?)', [now]),
  };
}

function getThresholdDays() {
  const raw = parseInt(process.env.ESTIMATE_EXPIRATION_DAYS, 10);
  if (!Number.isFinite(raw) || raw <= 0) return 7;
  return raw;
}

// codex round 3 on #5154 (P1): the lifecycle sweep used to re-derive "missed
// estimate.expired events" by guessing from estimates.updated_at, which the
// archive endpoint (admin-estimates.js POST /:id/archive) also stamps on an
// already-expired row with no new automation run — archiving or otherwise
// editing an old expired estimate looked exactly like a fresh expiry and
// could send a stale expiration email. The fix is structural: the flip
// itself durably records its own intent marker, in the SAME transaction as
// the status UPDATE, so a rollback of the flip rolls back the marker too and
// the sweep never has to infer anything from a timestamp again (see
// email-template-automation-emitters.js's email_template_automation_intents
// outbox and retryPendingIntents).
//
// Only an estimate that may receive automated follow-up at all earns a
// marker (codex P1 round 6): estimate-comms-eligibility.js's shared rule —
// not archived, and not stamped estimate_data.noEngagementAutomation (the
// zero-comms promise of report cross-sell / plan-restart / website
// self-service publications) — the same rule the engagement engine,
// follow-up cron, auto-renew and extension flow read. The executor re-judges
// it at execution (livePayloadForRun), so a later archive still stops a
// pending or delayed run.
async function flipExpiredBatch(buildQuery, columns, now) {
  return db.transaction(async (trx) => {
    const rows = await buildQuery(trx).update(expiredUpdate(now), columns);
    const flipped = Array.isArray(rows) ? rows : [];
    const intentIdByEstimateId = new Map();
    const eligible = flipped.filter((row) => !estimateFollowupBlockedReason(row));
    if (eligible.length) {
      const { recordAutomationIntents } = require('./email-template-automation-emitters');
      const intents = await recordAutomationIntents(trx, eligible.map((row) => ({
        triggerEventKey: 'estimate.expired',
        entityType: 'estimate',
        entityId: row.id,
        occurredAt: now,
        payload: {
          id: row.id,
          customer_id: row.customer_id || null,
          customer_email: row.customer_email || null,
          category: row.category || null,
          service_interest: row.service_interest || null,
          expires_at: row.expires_at || null,
          // The flip's own instant: the expiry date stand-in for an estimate
          // with no expires_at (Rule 1), so a replay derives the same run key.
          flipped_at: row.updated_at || null,
        },
      })));
      for (const intent of intents) intentIdByEstimateId.set(String(intent.entity_id), intent.id);
    }
    return { rows: flipped, intentIdByEstimateId };
  });
}

async function runEstimateExpiration() {
  const thresholdDays = getThresholdDays();
  const ageCutoff = new Date(Date.now() - thresholdDays * 24 * 60 * 60 * 1000);
  const now = new Date();
  // archived_at + estimate_data feed the shared follow-up rule
  // (estimateFollowupBlockedReason) for the estimate.expired automation.
  const flippedColumns = ['id', 'customer_name', 'monthly_total', 'annual_total', 'onetime_total', 'disposition', 'customer_id', 'customer_email', 'category', 'service_interest', 'expires_at', 'updated_at', 'archived_at', 'estimate_data'];

  // Rule 1: aged-out — sent/viewed with sent_at older than the cutoff and
  // no accept/decline yet. Only flips live rows. Archived rows are parked
  // status-neutral (manual archive + converted-customer sweep) — expiring
  // them would rewrite their status and ping Virginia about dead courtships.
  const { rows: agedRows, intentIdByEstimateId: agedIntents } = await flipExpiredBatch((conn) => conn('estimates')
    .whereIn('status', ['sent', 'viewed'])
    .whereNull('archived_at')
    .whereNotNull('sent_at')
    .where('sent_at', '<', ageCutoff)
    .whereNull('accepted_at')
    .whereNull('declined_at')
    // A bid's authored date governs even when it is close to a resend date.
    .whereRaw(FIXED_BID_VALIDITY_ABSENT_SQL)
    // An operator EXTENSION overrides the inactivity rule: POST /:id/extend
    // pushes expires_at (and texts the customer the new deadline) but
    // leaves sent_at, so without this carve-out every extension of an
    // estimate older than the threshold was re-expired at the next 6am
    // run. Extensions are distinguished from the STANDARD send stamp —
    // every successful send writes expires_at = send time + 7d
    // (estimateExpiresAt, admin-estimate-persistence.js) — by exceeding
    // sent_at + that send window (+1h clock slack): only a deadline pushed
    // beyond the send default suppresses the age rule, so tuning
    // ESTIMATE_EXPIRATION_DAYS below 7 still controls normal sends.
    // Passed expires_at rows age out here regardless (Rule 2 flips them
    // anyway).
    .where(function () {
      this.whereNull('expires_at')
        .orWhere('expires_at', '<=', now)
        .orWhereRaw("expires_at <= sent_at + (? * interval '1 day') + interval '1 hour'", [ESTIMATE_SEND_EXPIRY_DAYS]);
    })
    // Hold: a first-booking customer's estimate stays live until the visit
    // resolves — the archive sweep (which runs before this in the 6am chain)
    // claims it on completion; expiring it here would strand a booked
    // conversion at `expired`, where the sweep's sent/viewed filter can
    // never reclaim it. The hold self-lifts if the booking dies.
    .modify(excludePendingFirstBookings)
    // RETURNING the flipped rows so the admin bell can name who walked away
    // (owner ruling 2026-07-30: a bell that says "Customer expired without a
    // decision" is not actionable). customer_id/customer_email/category/
    // service_interest/expires_at ride along for the estimate.expired
    // email_template_automation intent marker recorded in the same
    // transaction (flipExpiredBatch, above).
  , flippedColumns, now);

  // Rule 2: explicit expires_at — any non-terminal row whose expires_at has
  // passed. Accepted/declined estimates are left alone.
  const { rows: dateRows, intentIdByEstimateId: dateIntents } = await flipExpiredBatch((conn) => conn('estimates')
    .whereNotNull('expires_at')
    .whereNull('archived_at')
    .where('expires_at', '<', now)
    .whereNotIn('status', ['expired', 'accepted', 'declined'])
    // One-tap purchase drafts are synthesized, never sent — their lifecycle
    // (void ledger + archive) belongs to sweepStaleOneTapDrafts. Flipping
    // one here stranded its open ledger row (that sweep matched drafts
    // only) and put a phantom "walked away" line in the 6am bell for an
    // estimate no customer ever received (Codex #3395 r9 P1).
    .whereNot({ source: 'one_tap_purchase' })
    // Same first-booking hold as Rule 1 — an explicit expires_at date set
    // before the customer booked doesn't make expiring their live courtship
    // any less wrong.
    .modify(excludePendingFirstBookings)
  , flippedColumns, now);
  const unviewed = [...agedRows, ...dateRows].filter((r) => r.disposition === 'expired_unviewed').length;
  logger.info(`[estimate-expiration] thresholdDays=${thresholdDays} aged=${agedRows.length} dateExpired=${dateRows.length} unviewed=${unviewed}`);

  // Refund acceptance deposits stranded on terminal estimates — money
  // received while the estimate was live (paid then abandoned, or paid then
  // declined) has no other refund path once the row goes declined/expired.
  // Self-healing daily sweep: covers today's flips AND any prior strand
  // (failed inline decline sweep, admin-side terminal status change).
  try {
    const { sweepTerminalEstimateDeposits } = require('./estimate-deposits');
    await sweepTerminalEstimateDeposits();
  } catch (e) {
    logger.error(`[estimate-expiration] terminal-estimate deposit sweep failed: ${e.message}`);
  }

  // Fire a single batched notification when anything flipped — one ping per
  // cron run, not per estimate, so Virginia doesn't get 5 bells at 6am. The
  // payload names who walked away so the bell/banner is actionable.
  const expiredRows = [...agedRows, ...dateRows];
  const total = expiredRows.length;
  if (total > 0) {
    try {
      const { triggerNotification } = require('./notification-triggers');
      const single = total === 1 ? expiredRows[0] : null;
      await triggerNotification('estimate_expired', {
        count: total,
        customerName: single?.customer_name || null,
        monthlyTotal: single?.monthly_total || null,
        annualTotal: single?.annual_total || null,
        onetimeTotal: single?.onetime_total || null,
        estimateId: single?.id || null,
        names: expiredRows.map((r) => r.customer_name).filter(Boolean).slice(0, 5),
      });
    } catch (e) {
      logger.warn(`[estimate-expiration] notification trigger failed: ${e.message}`);
    }
  }

  // estimate.expired (email_template_automation, dark/shadow): one emit per
  // flipped row, immediately after its own transaction committed its
  // durable intent marker (flipExpiredBatch, above) — the marker's id rides
  // along so a success/failure here settles that SAME marker (processed /
  // pending-with-error / unrecoverable) rather than leaving the sweep to
  // guess. Never blocks the sweep — each is its own try/catch so one bad
  // row can't stop the rest, and the emitter itself is a no-op when the
  // gate is off (its marker just stays pending for later replay). Same
  // shared follow-up rule as the marker (flipExpiredBatch): an archived or
  // zero-comms estimate is never emitted, marker or not.
  const automationRows = expiredRows.filter((row) => !estimateFollowupBlockedReason(row));
  if (automationRows.length) {
    const { emitEstimateExpired } = require('./email-template-automation-emitters');
    const intentIdByEstimateId = new Map([...agedIntents, ...dateIntents]);
    for (const row of automationRows) {
      try {
        await emitEstimateExpired(row, intentIdByEstimateId.get(String(row.id)) || null);
      } catch (e) {
        logger.warn(`[estimate-expiration] estimate.expired emit failed for ${row.id}: ${scrubSentryText(e && e.message ? e.message : e)}`);
      }
    }
  }

  return { aged: agedRows.length, dateExpired: dateRows.length };
}

module.exports = { runEstimateExpiration };
