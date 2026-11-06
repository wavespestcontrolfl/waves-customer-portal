const db = require('../../models/db');
const logger = require('../logger');
const { sendCustomerMessage } = require('../messaging/send-customer-message');
const { renderSmsTemplate } = require('../sms-template-renderer');
const { etDateString, addETDays, parseETDateTime } = require('../../utils/datetime-et');

// GATE_MONEY_NOTICE_CATCHUP (owner 2026-11-06): a termite bond 30/15/7 text
// whose day passed at most this many days ago, and that has not gone out
// (the 35-day 'renewal' cooldown below), still matches on the next run, so a
// lost 10:12 tick is made up. One day, not the 3 of NOTICE_CATCHUP_DAYS in
// annual-prepay-renewals.js: these texts state the time left in relative words
// ("in 30 days", "in 2 weeks", "in just 1 week"), so a later send would state
// it wrong. A prepay notice names the exact end date, so it can wait longer.
const RENEWAL_CATCHUP_DAYS = 1;

// The earliest renewal date a rung may still notice today. Gate off, the
// exact day only (`DATE(col) BETWEEN d AND d`, the same match as `= d`).
function earliestRenewalDate(dateStr) {
  if (!require('../../config/feature-gates').moneyNoticeCatchupLive()) return dateStr;
  return etDateString(addETDays(parseETDateTime(`${dateStr}T12:00`), -RENEWAL_CATCHUP_DAYS));
}

// Counters that mean the termite renewal sweep did something worth a log
// line: EVERY action counter runTermiteAnnualRenewalSweep returns (Codex
// #4971 r8 P2 — a night whose only work was recovery, a withdrawal, a
// resolved charge outcome or a late-paid alert, logs too). The *Scanned
// counters are not activity: a quiet night stays silent. A test pins this
// list against the sweep's own counts object, so a new action counter can't
// be missed. The leg lives outside checkAndSend so that function's
// complexity stays at its baseline.
const TERMITE_RENEWAL_ACTIVITY_KEYS = [
  'noWitnessBelled', 'unanchoredBelled', 'staleOverdueBelled',
  'minted', 'charged', 'failed', 'skipped',
  'graceLapsed', 'graceReconciliationDeferred', 'graceRetiredSettled',
  'lapseEffectsReconciled', 'reconcileSkipped', 'reconcileNeverReachedStripeBelled',
  'reconcilePendingOutcomeResolved', 'latePaidBelled', 'withdrawn', 'parentRenewedStamped',
];

// Every numeric counter the sweep returned, scanned and action alike.
function termiteRenewalSummary(counts) {
  return Object.entries(counts)
    .filter(([, value]) => typeof value === 'number')
    .map(([key, value]) => `${key}=${value}`)
    .join(', ');
}

// A step that logs its own failure and lets the next step run reports it here.
// checkAndSend throws once after the last step, so job_health records the failure
// (runExclusive records one only when the body throws).
function noteFailedPasses(failedSteps, step, result) {
  if (result?.failedPasses?.length) failedSteps.push(step);
}

// The restamp sweep logs a failed candidate query and returns its summary.
// Both runners (the hourly tick in scheduler.js and the leg below) call this
// inside the shared 'annual-prepay-restamp-sweep' lock, so that job's
// job_health row records the failed pass.
function throwIfRestampFailed(summary) {
  if (summary?.failedPasses?.length) {
    throw new Error(`annual-prepay restamp: ${summary.failedPasses.length} pass(es) failed (${summary.failedPasses.join(', ')})`);
  }
  return summary;
}

function throwIfStepsFailed(failedSteps, totalSent) {
  if (failedSteps.length > 0) {
    throw new Error(`renewal-reminders: ${failedSteps.length} step(s) failed (${failedSteps.join(', ')}); ${totalSent} sent`);
  }
}

async function runTermiteRenewalChargeLeg(failedSteps = []) {
  try {
    const { runTermiteAnnualRenewalSweep } = require('../termite-annual-renewal-charge');
    const renewalCharge = await runTermiteAnnualRenewalSweep();
    if (!TERMITE_RENEWAL_ACTIVITY_KEYS.some((key) => renewalCharge[key])) return;
    logger.info(`Termite annual renewal charge: ${termiteRenewalSummary(renewalCharge)}`);
  } catch (err) {
    logger.error(`Termite annual renewal charge sweep failed: ${err.message}`);
    failedSteps.push('termite renewal charge');
  }
}

// Re-applies annual-prepay coverage to live paid terms whose canonical visits
// were left unstamped because a stamp pass failed (webhook activation only
// logs). Runs BEFORE the covered-term sweep so the sweep's pending-window
// reconcile sees freshly stamped rows. Outside checkAndSend for the same
// complexity reason as the termite leg; never throws (a failure is added to
// failedSteps, which checkAndSend turns into one throw after the last leg).
async function runPrepayRestampLeg(prepay, failedSteps = []) {
  try {
    const service = prepay || require('../annual-prepay-renewals');
    if (service.restampUnstampedActiveTerms) {
      // Same lease as the hourly tick (scheduler.js): the two runners never
      // overlap, and a held lease just skips this leg until the next tick.
      const { runExclusive } = require('../../utils/cron-lock');
      // Thrown inside the lock, so the restamp lease's own job_health row records it.
      await runExclusive('annual-prepay-restamp-sweep', async () => throwIfRestampFailed(await service.restampUnstampedActiveTerms()));
    }
  } catch (err) {
    logger.error(`Annual prepay restamp sweep failed: ${err.message}`);
    failedSteps.push('prepay restamp');
  }
}

// Office bell before a prepaid year ends (GATE_PREPAY_YEAR_END_BELL, dark by default;
// the runner returns before any query while the gate is off). Office only: it texts,
// emails and charges nobody. Outside checkAndSend for the same complexity reason as the
// legs above; never throws (a failure is added to failedSteps).
async function runPrepayYearEndBellLeg(failedSteps = []) {
  try {
    const { runPrepayYearEndBell } = require('../prepay-year-end-bell');
    const { raised, closed } = await runPrepayYearEndBell();
    if (raised || closed) logger.info(`Prepay year end bell: raised=${raised}, closed=${closed}`);
  } catch (err) {
    logger.error(`Prepay year end bell failed: ${err.message}`);
    failedSteps.push('prepay year end bell');
  }
}

class RenewalReminder {
  /**
   * Check all customers for upcoming renewal dates and send reminders
   * at 30, 15, and 7 days out. Skips if already sent within 35 days.
   */
  async checkAndSend() {
    let annualPrepaySent = 0;
    let annualPrepay = null;
    // Every step below logs its own failure and the next step still runs;
    // a failed step is named here and thrown once, after the last step.
    const failedSteps = [];
    try {
      annualPrepay = require('../annual-prepay-renewals');
      if (annualPrepay.checkAndSend) {
        const result = await annualPrepay.checkAndSend();
        annualPrepaySent = Number(result?.sent || 0);
        noteFailedPasses(failedSteps, 'prepay reminder passes', result);
      }
    } catch (err) {
      logger.error(`Annual prepay renewal reminder failed: ${err.message}`);
      failedSteps.push('prepay reminders');
    }

    // Restamp leg first (see runPrepayRestampLeg): a stamp pass that failed
    // at activation must not leave a covered visit billing on top of the
    // prepay any longer than one daily run.
    await runPrepayRestampLeg(annualPrepay, failedSteps);

    // Daily catch-all reconcile for live covered terms: recovers
    // pending-window settle/credit/reversal work whose one-shot
    // payment/refund hook was lost to a transient error (idempotent — see
    // reconcileCoveredTermsSweep). Independent try/catch: a sweep failure
    // must not silence the reminders below.
    try {
      const prepay = annualPrepay || require('../annual-prepay-renewals');
      if (prepay.reconcileCoveredTermsSweep) {
        const summary = await prepay.reconcileCoveredTermsSweep();
        noteFailedPasses(failedSteps, 'prepay covered-term sweep', summary);
      }
    } catch (err) {
      logger.error(`Annual prepay covered-term sweep failed: ${err.message}`);
      failedSteps.push('prepay covered-term sweep');
    }

    // Termite annual plan: the automatic renewal charge (slice 6b, dark
    // behind GATE_TERMITE_ANNUAL_PLAN — no-ops end to end while the gate is
    // off). Mints a renewal successor for every due, witnessed, undecided
    // termite term, charges the saved consented method at most once, and
    // voids/retires any successor whose grace period lapsed unpaid.
    // Independent try/catch (inside the helper), same as every other leg
    // in this workflow.
    await runTermiteRenewalChargeLeg(failedSteps);

    // Office bell before a prepaid year ends (dark behind GATE_PREPAY_YEAR_END_BELL).
    // Own try/catch inside the helper: a failure here must not silence the legs below.
    await runPrepayYearEndBellLeg(failedSteps);

    // OWNER RULING (2026-07-13): "renewal" language is reserved for termite
    // bonds — the one service with a real fixed term. WaveGuard and mosquito
    // are no-term recurring services, so their reminder legs are removed
    // (their date columns remain for admin/reporting use). Price changes on
    // no-term services use the price-change notice workflow instead.
    const renewalFields = [
      { column: 'termite_renewal_date', label: 'Termite Bond Renewal' },
    ];

    let totalSent = annualPrepaySent;

    for (const field of renewalFields) {
      for (const daysOut of [30, 15, 7]) {
        const targetDate = new Date();
        targetDate.setDate(targetDate.getDate() + daysOut);
        const dateStr = targetDate.toISOString().split('T')[0];

        // No phone requirement at the query level: the email leg (sequence
        // enrollment below) must reach email-only customers too; the SMS
        // branch guards on phone itself.
        const customers = await db('customers')
          .whereNotNull(field.column)
          .whereRaw(`DATE(${field.column}) BETWEEN ? AND ?`, [earliestRenewalDate(dateStr), dateStr])
          .whereNull('deleted_at') // soft-deleted customers get no renewal outreach
          .select('id', 'first_name', 'phone', 'nearest_location_id as location_id', field.column);

        for (const customer of customers) {
          try {
            // SMS leg needs a phone; email-only customers stop here.
            if (!customer.phone) continue;

            // Check cooldown — skip if renewal SMS sent in last 35 days
            const recent = await db('sms_log')
              .where({ customer_id: customer.id, message_type: 'renewal' })
              .where('created_at', '>', db.raw("NOW() - INTERVAL '35 days'"))
              .first();

            if (recent) continue;

            const urgency = daysOut === 7 ? 'expires in just 1 week'
              : daysOut === 15 ? 'is coming up in 2 weeks'
              : 'is approaching in 30 days';

            const body = await renderSmsTemplate(
              'renewal_reminder',
              {
                first_name: customer.first_name || 'there',
                renewal_label: field.label,
                urgency,
              },
              { workflow: 'renewal_reminder', entity_type: 'customer', entity_id: customer.id }
            );
            if (!body) {
              logger.warn(`[renewal-reminder] template missing/disabled — skipping customer ${customer.id} (${field.column})`);
              continue;
            }

            const smsResult = await sendCustomerMessage({
              to: customer.phone,
              body,
              channel: 'sms',
              audience: 'customer',
              purpose: 'retention',
              customerId: customer.id,
              identityTrustLevel: 'phone_matches_customer',
              entryPoint: 'renewal_reminder',
              consentBasis: {
                status: 'opted_in',
                source: 'customer_retention_preferences',
                capturedAt: customer.updated_at || customer.created_at || new Date().toISOString(),
              },
              metadata: {
                original_message_type: 'renewal',
                customerLocationId: customer.location_id,
                renewal_field: field.column,
                days_out: daysOut,
              },
            });
            if (!smsResult.sent) {
              logger.warn(`Renewal reminder blocked/failed for customer ${customer.id}: ${smsResult.code || smsResult.reason || 'unknown'}`);
              continue;
            }

            await db('customer_interactions').insert({
              customer_id: customer.id,
              interaction_type: 'sms_outbound',
              channel: 'sms',
              subject: `${field.label} — ${daysOut}-day reminder`,
              body: `Automated renewal reminder sent (${daysOut} days out)`,
            });

            totalSent++;
          } catch (err) {
            logger.error(`Renewal reminder failed for customer ${customer.id}: ${err.message}`);
          }
        }
      }
    }

    logger.info(`Renewal reminders: ${totalSent} sent`);
    throwIfStepsFailed(failedSteps, totalSent);
    return { sent: totalSent };
  }
}

module.exports = new RenewalReminder();
// The hourly restamp tick (scheduler.js) shares this check, inside the same lock.
module.exports.throwIfRestampFailed = throwIfRestampFailed;
module.exports._private = { TERMITE_RENEWAL_ACTIVITY_KEYS, runTermiteRenewalChargeLeg };
