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

/**
 * Determine WaveGuard tier based on number of recurring services selected.
 * 1 service = Bronze (0% discount)
 * 2 services = Silver (10% discount)
 * 3 services = Gold (15% discount)
 * 4+ services = Platinum (20% discount)
 */
function determineTier(serviceCount) {
  if (serviceCount >= 4) return { tier: 'Platinum', discount: 0.20 };
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
    let scheduledCount = 0;
    const today = new Date();

    for (const svc of recurringServices) {
      const serviceName = svc.name || svc.serviceName || svc.service_name || 'Service';
      const frequency = svc.frequency || 'monthly';

      // Determine interval in days
      let intervalDays;
      switch (frequency.toLowerCase()) {
        case 'weekly': intervalDays = 7; break;
        case 'bi-weekly': case 'biweekly': intervalDays = 14; break;
        case 'monthly': intervalDays = 30; break;
        case 'bi-monthly': case 'bimonthly': intervalDays = 60; break;
        case 'quarterly': intervalDays = 90; break;
        case 'annually': case 'annual': intervalDays = 365; break;
        default: intervalDays = 30; break;
      }

      // Schedule first service 7 days from now
      const scheduledDate = new Date(today.getTime() + 7 * 86400000);
      const dateStr = scheduledDate.toISOString().split('T')[0];

      try {
        await db('scheduled_services').insert({
          customer_id: customerId,
          scheduled_date: dateStr,
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
