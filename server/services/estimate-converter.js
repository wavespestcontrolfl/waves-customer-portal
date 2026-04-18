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
 * 1 service = Bronze (0% discount)
 * 2 services = Silver (10% discount)
 * 3 services = Gold (15% discount)
 * 4+ services = Platinum (18% discount)
 */
function determineTier(serviceCount) {
  if (serviceCount >= 4) return { tier: 'Platinum', discount: 0.18 };
  if (serviceCount >= 3) return { tier: 'Gold', discount: 0.15 };
  if (serviceCount >= 2) return { tier: 'Silver', discount: 0.10 };
  if (serviceCount >= 1) return { tier: 'Bronze', discount: 0 };
  return { tier: 'none', discount: 0 };
}

const EstimateConverter = {
  /**
   * Convert an accepted estimate into an active customer with scheduled services.
   * @param {number} estimateId - The ID of the accepted estimate
   * @returns {object} Conversion result summary
   */
  async convertEstimate(estimateId) {
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

    // 2. Create scheduled_services for recurring services
    //    All recurring services for this new customer bundle onto the same
    //    first date — they'll be done on one visit. Pick a date where a tech
    //    is already working the zone (falls back safely if we can't resolve).
    let scheduledCount = 0;
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
        });
        scheduledCount++;
      } catch (e) {
        logger.error(`[estimate-converter] Failed to create scheduled_service: ${e.message}`);
      }
    }

    // 3. Log conversion in activity_log
    await db('activity_log').insert({
      customer_id: customerId,
      action: 'estimate_converted',
      description: `Estimate #${estimateId} converted: ${customer.first_name} ${customer.last_name} → ${tier} WaveGuard at $${monthlyRate.toFixed(2)}/mo (${serviceCount} services, ${scheduledCount} scheduled)`,
      metadata: JSON.stringify({
        estimateId, tier, discount, monthlyRate, serviceCount, scheduledCount,
      }),
    });

    logger.info(`[estimate-converter] Estimate ${estimateId} converted: customer ${customerId} → ${tier} tier, $${monthlyRate}/mo, ${scheduledCount} services scheduled`);

    return { customerId, tier, discount, monthlyRate, serviceCount, scheduledCount };
  },
};

module.exports = EstimateConverter;
