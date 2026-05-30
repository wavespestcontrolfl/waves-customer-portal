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
const {
  inferFrequencyKeyFromEstimateData,
  resolveBillingCadence,
} = require('./billing-cadence');
const AccountMembershipEmail = require('./account-membership-email');

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
 * Determine WaveGuard tier based on the number of tier-qualifying recurring
 * services selected. Excluded recurring rows such as Palm Injection and Rodent
 * Bait Stations still schedule, but they do not move the customer into Silver+.
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
function determineTier(serviceCount, hasRecurringServices = false) {
  const t = WAVEGUARD.tiers;
  if (serviceCount >= t.platinum.minServices) return { tier: 'Platinum', discount: t.platinum.discount };
  if (serviceCount >= t.gold.minServices)     return { tier: 'Gold',     discount: t.gold.discount };
  if (serviceCount >= t.silver.minServices)   return { tier: 'Silver',   discount: t.silver.discount };
  if (serviceCount >= t.bronze.minServices)   return { tier: 'Bronze',   discount: t.bronze.discount };
  if (hasRecurringServices)                   return { tier: 'Bronze',   discount: t.bronze.discount };
  return { tier: 'none', discount: 0 };
}

function recurringServiceKey(svc = {}) {
  const raw = String(svc.service || svc.key || svc.name || svc.label || svc.displayName || '').toLowerCase();
  const words = raw.replace(/[_-]+/g, ' ');
  if (
    raw.includes('palm_injection')
    || raw.includes('palm_treatment')
    || /\bpalm injection\b|\bpalm tree\b|\bpalms?\b/.test(words)
  ) return 'palm_injection';
  if (
    raw.includes('rodent_bait')
    || raw.includes('rodent_monitoring')
    || (raw.includes('rodent') && /bait|station|monitor/.test(raw))
  ) return 'rodent_bait';
  if (raw.includes('pest')) return 'pest_control';
  if (raw.includes('lawn')) return 'lawn_care';
  if (raw.includes('tree') || raw.includes('shrub') || raw.includes('ornamental')) return 'tree_shrub';
  if (raw.includes('mosquito')) return 'mosquito';
  if (raw.includes('termite') && raw.includes('bait')) return 'termite_bait';
  return raw.replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

function serviceCountsTowardWaveGuardTier(svc = {}) {
  if (svc.waveGuardTierEligible === false || svc.countsTowardWaveGuardTier === false) return false;
  return WAVEGUARD.qualifyingServices.includes(recurringServiceKey(svc));
}

function countTierQualifyingRecurringServices(services = []) {
  const seen = new Set();
  for (const svc of services) {
    if (!serviceCountsTowardWaveGuardTier(svc)) continue;
    const key = recurringServiceKey(svc);
    if (key) seen.add(key);
  }
  return seen.size;
}

function hasWaveGuardSetupService(services = []) {
  return services.some((svc) => recurringServiceKey(svc) === 'pest_control');
}

function calculateAnnualPrepayAmount(monthlyRate) {
  return Math.round((parseFloat(monthlyRate || 0) || 0) * 12 * 100) / 100;
}

function normalizeEstimateData(value) {
  if (!value) return {};
  if (typeof value === 'string') {
    try { return JSON.parse(value) || {}; } catch { return {}; }
  }
  return value;
}

function estimateLineItemsFromData(estimateData = {}) {
  const data = normalizeEstimateData(estimateData);
  return data.lineItems
    || data.result?.lineItems
    || data.engineResult?.lineItems
    || data.estimate?.lineItems
    || [];
}

function isNonDiscountableRecurringLine(item = {}) {
  const annual = Number(item.annualAfterDiscount ?? item.annualAfterCredits ?? item.annual ?? item.ann ?? 0);
  if (recurringServiceKey(item) === 'lawn_care') return false;
  return annual > 0 && (
    item.discountable === false ||
    item.discount?.discountable === false ||
    item.discount?.policy === 'LAWN_V2_NET_55_FLOOR_PRICE'
  );
}

function nonDiscountableRecurringAnnualFloor(estimateData = {}) {
  return Math.round(estimateLineItemsFromData(estimateData)
    .filter(isNonDiscountableRecurringLine)
    .reduce((sum, item) => {
      const amount = Number(item.annualAfterDiscount ?? item.annualAfterCredits ?? item.annual ?? item.ann ?? 0);
      return sum + (Number.isFinite(amount) && amount > 0 ? amount : 0);
    }, 0) * 100) / 100;
}

function resolveAnnualPrepayDraftAmount({ prepayInvoiceAmount, annualTotal, monthlyRate } = {}) {
  const explicit = parseFloat(prepayInvoiceAmount);
  if (Number.isFinite(explicit) && explicit > 0) return Math.round(explicit * 100) / 100;
  const annual = parseFloat(annualTotal);
  if (Number.isFinite(annual) && annual > 0) return Math.round(annual * 100) / 100;
  return calculateAnnualPrepayAmount(monthlyRate);
}

function shouldCreateDraftInvoiceForRecurring({ billingTerm = 'standard', recurringServices = [] } = {}) {
  if (!Array.isArray(recurringServices) || recurringServices.length === 0) return false;
  if (billingTerm === 'prepay_annual') return true;
  return hasWaveGuardSetupService(recurringServices);
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
    // Manual Mark Won path passes skipAutoSchedule=true — Adam wants to
    // schedule the visit himself on the calendar rather than have the
    // converter auto-pick the next feasible zone date. Self-accept paths
    // still auto-schedule when there's no reservation row.
    const skipAutoSchedule = opts.skipAutoSchedule === true;
    const database = opts.database || db;
    const estimate = await database('estimates').where({ id: estimateId }).first();
    if (!estimate) throw new Error(`Estimate ${estimateId} not found`);
    if (estimate.status !== 'accepted') throw new Error(`Estimate ${estimateId} is not accepted (status: ${estimate.status})`);
    if (!estimate.customer_id) throw new Error(`Estimate ${estimateId} has no linked customer`);

    const customerId = estimate.customer_id;
    const customer = await database('customers').where({ id: customerId }).first();
    if (!customer) throw new Error(`Customer ${customerId} not found`);

    // Parse estimate data
    let estimateData = estimate.estimate_data;
    if (typeof estimateData === 'string') {
      try { estimateData = JSON.parse(estimateData); } catch { estimateData = {}; }
    }
    estimateData = estimateData || {};

    // Count recurring services for scheduling, but only tier-qualifying rows
    // for WaveGuard tier activation. Palm Injection and Rodent Bait Stations
    // are recurring services, but they are excluded from WaveGuard tier count
    // and percentage discounts in the pricing engine.
    // V2 pricing-engine estimates store services at estimate_data.result.recurring.services,
    // while older shapes use estimate_data.recurring.services or a flat estimate_data.services.
    // Without the result.* fallback, V2 estimates resolved to 0 services → tier='none' →
    // CHECK constraint violation on customers.waveguard_tier and the whole accept rolled back.
    const recurringServices =
      estimateData.recurring?.services
      || estimateData.result?.recurring?.services
      || estimateData.services?.filter(s => s.recurring || s.frequency)
      || [];
    const serviceCount = countTierQualifyingRecurringServices(recurringServices);
    const shouldCreateDraftInvoice = shouldCreateDraftInvoiceForRecurring({
      billingTerm,
      recurringServices,
    });

    // Determine tier
    const { tier, discount } = determineTier(serviceCount, recurringServices.length > 0);

    // Calculate monthly rate from estimate
    const monthlyRate = parseFloat(estimate.monthly_total || 0);
    const inferredFrequencyKey = estimateData.customerSelection?.frequency
      || inferFrequencyKeyFromEstimateData(estimateData);
    const billingCadence = inferredFrequencyKey
      ? resolveBillingCadence({
          monthlyRate,
          frequencyKey: inferredFrequencyKey,
          estimateData,
          fallbackFrequencyKey: inferredFrequencyKey,
        })
      : null;

    // 1. Update customer to active
    await database('customers').where({ id: customerId }).update({
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
    let termStartDate = null;
    const existingFromReservation = await database('scheduled_services')
      .where({ source_estimate_id: estimateId })
      .whereNotNull('customer_id')
      .whereNull('reservation_expires_at')
      .count('id as count')
      .first();
    const reservationRowsExist = Number(existingFromReservation?.count || 0) > 0;

    if (reservationRowsExist) {
      logger.info(
        `[estimate-converter] Skipping auto-schedule for estimate ${estimateId} — ` +
        `reservation path already created ${existingFromReservation.count} scheduled_services row(s)`
      );
      const reservedStart = await database('scheduled_services')
        .where({ source_estimate_id: estimateId })
        .whereNotNull('customer_id')
        .whereNull('reservation_expires_at')
        .orderBy('scheduled_date', 'asc')
        .first('scheduled_date');
      termStartDate = reservedStart?.scheduled_date || null;
    } else if (skipAutoSchedule) {
      logger.info(
        `[estimate-converter] Skipping auto-schedule for estimate ${estimateId} — ` +
        `skipAutoSchedule=true (manual Mark Won)`,
      );
    } else {
      const firstServiceDate = await pickFirstServiceDate(customer, estimateId);
      termStartDate = firstServiceDate;

      for (const svc of recurringServices) {
        const serviceName = svc.name || svc.serviceName || svc.service_name || 'Service';
        const frequency = svc.frequency || 'monthly';
        const estimatedPrice = billingCadence && recurringServices.length === 1
          ? billingCadence.amount
          : null;

        try {
          const row = {
            customer_id: customerId,
            scheduled_date: firstServiceDate,
            service_type: serviceName,
            status: 'pending',
            notes: `Auto-scheduled from estimate #${estimateId}. Frequency: ${frequency}`,
            source_estimate_id: estimateId,
          };
          if (estimatedPrice) row.estimated_price = estimatedPrice;
          await database('scheduled_services').insert(row);
          scheduledCount++;
        } catch (e) {
          logger.error(`[estimate-converter] Failed to create scheduled_service: ${e.message}`);
        }
      }
    }

    // 3. Log conversion in activity_log
    await database('activity_log').insert({
      customer_id: customerId,
      action: 'estimate_converted',
      description: `Estimate #${estimateId} converted: ${customer.first_name} ${customer.last_name} → WaveGuard ${tier} at $${monthlyRate.toFixed(2)}/mo (${serviceCount} services, ${scheduledCount} scheduled)`,
      metadata: JSON.stringify({
        estimateId, tier, discount, monthlyRate, serviceCount, scheduledCount,
      }),
    });

    // 4. Create draft setup/prepay invoice so Virginia sees it in
    //    /admin/invoices and can review + send. Nothing auto-charges.
    //    Standard setup invoices stay scoped to recurring pest. Annual
    //    prepay invoices are created for any recurring plan that offered
    //    annual prepay on the public estimate, including lawn-only.
    let draftInvoiceId = null;
    let draftInvoiceAmount = null;
    try {
      const annualPrepayAmountRaw = resolveAnnualPrepayDraftAmount({
        prepayInvoiceAmount: opts.prepayInvoiceAmount,
        annualTotal: estimate.annual_total,
        monthlyRate,
      });
      const nonDiscountableFloor = nonDiscountableRecurringAnnualFloor(estimateData);
      const annualPrepayAmount = billingTerm === 'prepay_annual'
        ? Math.max(annualPrepayAmountRaw, nonDiscountableFloor)
        : annualPrepayAmountRaw;
      const hasDraftAmount = billingTerm === 'prepay_annual'
        ? annualPrepayAmount > 0
        : monthlyRate > 0;
      if (hasDraftAmount && !skipSetupInvoice && shouldCreateDraftInvoice) {
        const InvoiceService = require('./invoice');
        if (billingTerm === 'prepay_annual') {
          const annualAmount = annualPrepayAmount;
          const termMonthlyRate = monthlyRate > 0
            ? monthlyRate
            : Math.round((annualAmount / 12) * 100) / 100;
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

          try {
            const AnnualPrepayRenewals = require('./annual-prepay-renewals');
            await AnnualPrepayRenewals.createTermForAnnualPrepay({
              customerId,
              sourceEstimateId: estimateId,
              prepayInvoiceId: draftInvoiceId,
              planLabel: `WaveGuard ${tier || 'Bronze'} Annual Prepay`,
              monthlyRate: termMonthlyRate,
              prepayAmount: annualAmount,
              termStart: termStartDate || null,
            });
          } catch (termErr) {
            logger.error(`[estimate-converter] Annual prepay term creation failed for estimate ${estimateId}: ${termErr.message}`);
          }
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

    const membershipEmail = {
      customerId,
      effectiveDate: termStartDate || new Date(),
      sourceId: `estimate:${estimateId}`,
      membershipTier: tier,
      monthlyRate,
      billingCadence: billingCadence?.periodLabel || (billingTerm === 'prepay_annual' ? 'annual prepay' : 'monthly'),
      includedServices: recurringServices
        .map((svc) => svc.name || svc.serviceName || svc.service_name || svc.label)
        .filter(Boolean)
        .join(', '),
    };

    if (opts.skipMembershipEmail !== true) {
      void AccountMembershipEmail.sendMembershipStarted(membershipEmail)
        .catch((err) => logger.warn(`[estimate-converter] membership.started email failed for customer ${customerId}: ${err.message}`));
    }

    return {
      customerId,
      tier,
      discount,
      monthlyRate,
      serviceCount,
      scheduledCount,
      billingTerm,
      draftInvoiceId,
      draftInvoiceAmount,
      membershipEmail,
    };
  },
};

module.exports = EstimateConverter;
module.exports.calculateAnnualPrepayAmount = calculateAnnualPrepayAmount;
module.exports.countTierQualifyingRecurringServices = countTierQualifyingRecurringServices;
module.exports.determineTier = determineTier;
module.exports.hasWaveGuardSetupService = hasWaveGuardSetupService;
module.exports.nonDiscountableRecurringAnnualFloor = nonDiscountableRecurringAnnualFloor;
module.exports.recurringServiceKey = recurringServiceKey;
module.exports.resolveAnnualPrepayDraftAmount = resolveAnnualPrepayDraftAmount;
module.exports.serviceCountsTowardWaveGuardTier = serviceCountsTowardWaveGuardTier;
module.exports.shouldCreateDraftInvoiceForRecurring = shouldCreateDraftInvoiceForRecurring;
