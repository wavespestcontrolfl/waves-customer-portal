/**
 * Estimate Auto-Converter — when an estimate is accepted, automatically:
 *   1. Set customer pipeline_stage to 'active_customer'
 *   2. Determine WaveGuard tier from selected services count
 *   3. Calculate monthly_rate from estimate data
 *   4. Create scheduled_services for recurring services
 *   5. Log the conversion in activity_log
 */

const db = require('../models/db');
const logger = require('./logger');
const AvailabilityEngine = require('./availability');
const { WAVEGUARD } = require('./pricing-engine/constants');

/**
 * Pick the first service date for a freshly-converted customer.
 *
 * Preference order:
 *   1. Earliest date from AvailabilityEngine (a day when a tech is already
 *      working the customer's zone AND zone capacity isn't full). This keeps
 *      new customers clustered onto existing routes instead of creating
 *      one-off detours.
 *   2. Fallback: today + 7 days, bumped forward off Sunday. Used when we
 *      can't resolve the customer's zone (empty city, new area) or when no
 *      tech is scheduled in that zone across the 14-day window.
 *
 * Returns a YYYY-MM-DD string ready for scheduled_services.scheduled_date.
 */
async function pickFirstServiceDate(customer, estimateId) {
  try {
    if (customer.city) {
      const avail = await AvailabilityEngine.getAvailableSlots(customer.city, estimateId);
      const first = avail?.days?.[0]?.date;
      if (first) {
        logger.info(`[estimate-converter] Snapped first service to route day ${first} (zone: ${avail.zone})`);
        return first;
      }
    }
  } catch (e) {
    logger.error(`[estimate-converter] Availability lookup failed, falling back: ${e.message}`);
  }

  // Fallback — today + 7, snap off Sunday
  const fallback = new Date(Date.now() + 7 * 86400000);
  while (fallback.getDay() === 0) fallback.setDate(fallback.getDate() + 1);
  const dateStr = fallback.toISOString().split('T')[0];
  logger.info(`[estimate-converter] No route-day match for city "${customer.city || '(empty)'}", using fallback ${dateStr}`);
  return dateStr;
}

/**
 * Determine WaveGuard tier based on number of recurring services selected.
 *
 * Discount values + min-service thresholds are sourced from
 * `pricing-engine/constants.WAVEGUARD.tiers` — the single source of truth
 * (see docs/pricing/POLICY.md). Returns title-cased tier names because
 * `customers.waveguard_tier` and the admin UI both expect
 * 'Bronze'/'Silver'/'Gold'/'Platinum'.
 *
 * Earlier this file defined a local table with Platinum=0.18, which drifted
 * from the engine's 0.20 — Platinum customers were being activated at 2pp
 * less than they were quoted. Now derived live so any future tier change
 * lands in one place.
 */
function determineTier(serviceCount) {
  const t = WAVEGUARD.tiers;
  if (serviceCount >= t.platinum.minServices) return { tier: 'Platinum', discount: t.platinum.discount };
  if (serviceCount >= t.gold.minServices)     return { tier: 'Gold',     discount: t.gold.discount };
  if (serviceCount >= t.silver.minServices)   return { tier: 'Silver',   discount: t.silver.discount };
  if (serviceCount >= t.bronze.minServices)   return { tier: 'Bronze',   discount: t.bronze.discount };
  return { tier: 'none', discount: 0 };
}

const EstimateConverter = {
  /**
   * Convert an accepted estimate into an active customer with scheduled services.
   * @param {number} estimateId - The ID of the accepted estimate
   * @param {object} [opts]
   * @param {'standard'|'prepay_annual'} [opts.billingTerm='standard'] — when
   *   'prepay_annual', a draft invoice is created for (monthlyRate × 12) and
   *   the $99 WaveGuard setup fee is WAIVED. When 'standard', a $99 WaveGuard
   *   setup draft invoice is created. Either way the invoice is 'draft' —
   *   operator reviews + sends via /admin/invoices. Nothing is auto-charged.
   * @returns {object} Conversion result summary
   */
  async convertEstimate(estimateId, opts = {}) {
    const billingTerm = opts.billingTerm === 'prepay_annual' ? 'prepay_annual' : 'standard';
    const skipSetupInvoice = opts.skipSetupInvoice === true;
    const estimate = await db('estimates').where({ id: estimateId }).first();
    if (!estimate) throw new Error(`Estimate ${estimateId} not found`);
    if (estimate.status !== 'accepted') throw new Error(`Estimate ${estimateId} is not accepted (status: ${estimate.status})`);
    if (!estimate.customer_id) throw new Error(`Estimate ${estimateId} has no linked customer`);

    const customerId = estimate.customer_id;
    const customer = await db('customers').where({ id: customerId }).first();
    if (!customer) throw new Error(`Customer ${customerId} not found`);

    // Parse estimate data
    let estimateData = estimate.estimate_data;
    if (typeof estimateData === 'string') {
      try { estimateData = JSON.parse(estimateData); } catch { estimateData = {}; }
    }
    estimateData = estimateData || {};

    // Count recurring services
    const recurringServices = estimateData.recurring?.services || estimateData.services?.filter(s => s.recurring || s.frequency) || [];
    const serviceCount = recurringServices.length;

    // Determine tier
    const { tier, discount } = determineTier(serviceCount);

    // Calculate monthly rate from estimate
    const monthlyRate = parseFloat(estimate.monthly_total || 0);

    // 1. Update customer to active
    await db('customers').where({ id: customerId }).update({
      pipeline_stage: 'active_customer',
      pipeline_stage_changed_at: new Date(),
      waveguard_tier: tier,
      monthly_rate: monthlyRate,
      active: true,
    });

    // 2. Create scheduled_services for recurring services — but ONLY if
    //    the accept path didn't already create one via slot reservation
    //    (PR B.1). The reservation path commits a scheduled_services row
    //    inside the accept transaction with source_estimate_id set to
    //    this estimate. When that row exists, the customer has already
    //    picked + committed a specific slot — overwriting with our
    //    auto-picked "first available date" would destroy their choice
    //    and silently re-slot them.
    //
    //    All recurring services for this new customer bundle onto the same
    //    first date — they'll be done on one visit. Pick a date where a tech
    //    is already working the zone (falls back safely if we can't resolve).
    let scheduledCount = 0;
    const existingFromReservation = await db('scheduled_services')
      .where({ source_estimate_id: estimateId })
      .count('id as count')
      .first();
    const reservationRowsExist = Number(existingFromReservation?.count || 0) > 0;

    if (reservationRowsExist) {
      logger.info(
        `[estimate-converter] Skipping auto-schedule for estimate ${estimateId} — ` +
        `reservation path already created ${existingFromReservation.count} scheduled_services row(s)`
      );
    } else {
      const firstServiceDate = await pickFirstServiceDate(customer, estimateId);

      for (const svc of recurringServices) {
        const serviceName = svc.name || svc.serviceName || svc.service_name || 'Service';
        const frequency = svc.frequency || 'monthly';

        try {
          await db('scheduled_services').insert({
            customer_id: customerId,
            scheduled_date: firstServiceDate,
            service_type: serviceName,
            status: 'pending',
            notes: `Auto-scheduled from estimate #${estimateId}. Frequency: ${frequency}`,
            source_estimate_id: estimateId,
          });
          scheduledCount++;
        } catch (e) {
          logger.error(`[estimate-converter] Failed to create scheduled_service: ${e.message}`);
        }
      }
    }

    // 3. Log conversion in activity_log
    await db('activity_log').insert({
      customer_id: customerId,
      action: 'estimate_converted',
      description: `Estimate #${estimateId} converted: ${customer.first_name} ${customer.last_name} → WaveGuard ${tier} at $${monthlyRate.toFixed(2)}/mo (${serviceCount} services, ${scheduledCount} scheduled)`,
      metadata: JSON.stringify({
        estimateId, tier, discount, monthlyRate, serviceCount, scheduledCount,
      }),
    });

    // 4. Create draft setup/prepay invoice so Virginia sees it in
    //    /admin/invoices and can review + send. Nothing auto-charges.
    //    Scoped to estimates with recurring pest (monthlyRate > 0) — other
    //    paths (lawn-only, mosquito-only) are left alone for this PR.
    let draftInvoiceId = null;
    let draftInvoiceAmount = null;
    try {
      if (monthlyRate > 0 && !skipSetupInvoice) {
        const InvoiceService = require('./invoice');
        if (billingTerm === 'prepay_annual') {
          const annualAmount = Math.round(monthlyRate * 12 * 100) / 100;
          const inv = await InvoiceService.create({
            customerId,
            title: `WaveGuard ${tier || 'Bronze'} — Annual Prepay (12 months)`,
            lineItems: [{
              description: `WaveGuard Membership — 12 months prepaid (setup fee waived)`,
              quantity: 1,
              unit_price: annualAmount,
            }],
            notes: `Auto-generated from accepted estimate #${estimateId}. Customer selected "Pay the year upfront" — $99 setup fee waived per WaveGuard membership policy.`,
          });
          draftInvoiceId = inv?.id || null;
          draftInvoiceAmount = annualAmount;
        } else {
          const inv = await InvoiceService.create({
            customerId,
            title: 'WaveGuard Membership Setup',
            lineItems: [{
              description: 'WaveGuard Membership — one-time setup fee',
              quantity: 1,
              unit_price: 99,
            }],
            notes: `Auto-generated from accepted estimate #${estimateId}. Standard monthly billing — $99 setup fee applies (waivable if customer later switches to annual prepay).`,
          });
          draftInvoiceId = inv?.id || null;
          draftInvoiceAmount = 99;
        }
      }
    } catch (err) {
      // Don't let an invoice-creation failure block the conversion.
      // Virginia can manually draft the setup invoice if this misfires.
      logger.error(`[estimate-converter] Draft invoice creation failed for estimate ${estimateId}: ${err.message}`);
    }

    logger.info(`[estimate-converter] Estimate ${estimateId} converted: customer ${customerId} → ${tier} tier, $${monthlyRate}/mo, ${scheduledCount} services scheduled, billingTerm=${billingTerm}, draftInvoiceId=${draftInvoiceId || 'none'}`);

    return { customerId, tier, discount, monthlyRate, serviceCount, scheduledCount, billingTerm, draftInvoiceId, draftInvoiceAmount };
  },
};

module.exports = EstimateConverter;
