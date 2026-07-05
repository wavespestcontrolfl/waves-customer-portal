const db = require('../../models/db');
const TWILIO_NUMBERS = require('../../config/twilio-numbers');
const logger = require('../logger');
const { isEnabled } = require('../../config/feature-gates');
const { renderSmsTemplate } = require('../sms-template-renderer');
const {
  CAMPAIGN_GATE,
  toGsm7Safe,
  prefsAllowMarketingSms,
  campaignCooldownReason,
} = require('../campaign-drafts');

const SEASONAL_HOOKS = {
  // month index (0-based) → hooks (plain hyphens/apostrophes — GSM-7 safe)
  0: { type: 'general', hook: 'Start the new year pest-free!' },
  1: { type: 'general', hook: 'Valentine\'s gift idea: a bug-free home' },
  2: { type: 'lawn', hook: 'Spring is here - time for pre-emergent lawn treatment' },
  3: { type: 'mosquito', hook: 'Mosquito season is starting - protect your yard now' },
  4: { type: 'mosquito', hook: 'Peak mosquito season is here. Don\'t let them take over' },
  5: { type: 'pest', hook: 'Summer bugs are out in force. Let us handle them' },
  6: { type: 'pest', hook: 'Mid-summer pest pressure is at its peak' },
  7: { type: 'pest', hook: 'Back-to-school? Make sure pests don\'t follow the kids inside' },
  8: { type: 'pest', hook: 'Fall pests are looking for warm places - like your home' },
  9: { type: 'lawn', hook: 'Fall is the perfect time for lawn recovery treatment' },
  10: { type: 'general', hook: 'Holiday prep starts with a pest-free home' },
  11: { type: 'general', hook: 'End the year right - schedule your winter treatment' },
};

class SeasonalReactivation {
  /**
   * Seasonal reactivation, campaign-drafts V1: find lapsed customers and write
   * PENDING campaign drafts for owner approval — this cron no longer sends.
   *
   * Audience fix: the old query filtered `customers.status IN ('dormant',
   * 'at_risk','churned','inactive')`, but no migration ever defined those
   * values on customers — churn state lives on pipeline_stage / active /
   * churned_at (customer-stages.js, cancellation-processor.js). The filter was
   * dead: it matched ~0 lapsed customers, so this cron never actually reached
   * its audience. The canonical lapsed predicate below is deliberately coupled
   * with the auto-send → pending-draft conversion: fixing the filter alone
   * would have unleashed a previously-dead auto-send marketing cron on the
   * newly-matched audience.
   *
   * Gate: GATE_CAMPAIGN_DRAFTS. Off = shadow-log the candidate count only —
   * no drafts, and never a send via the old path either.
   */
  async run() {
    const gateOn = isEnabled(CAMPAIGN_GATE);
    const month = new Date().getMonth();
    const seasonal = SEASONAL_HOOKS[month];

    // Canonical lapsed-customer predicate (cancellation-processor stamps
    // pipeline_stage='churned', active=false, churned_at on cancellation).
    // Soft-deleted customers must never get reactivation outreach (same
    // deleted_at guard the billing/reminder/dunning sweeps use).
    const customers = await db('customers')
      .whereIn('pipeline_stage', ['churned', 'dormant'])
      .where('active', false)
      .whereNotNull('churned_at')
      .whereNull('deleted_at')
      .whereNotNull('phone')
      .where(function () {
        this.where('last_contact_date', '<', db.raw("NOW() - INTERVAL '30 days'"))
          .orWhereNull('last_contact_date');
      })
      .select('id', 'first_name', 'phone', 'nearest_location_id as location_id', 'address_line1 as address');

    // Guards shared with the upsell generator: opted-out prefs and the unified
    // 30-day campaign cooldown (campaign drafts + campaign-grade sms_log +
    // prepay renewal notices). The draft cooldown also keeps this weekly cron
    // from re-drafting the same lapsed customer every Monday — drafting no
    // longer stamps last_contact_date (nothing was sent yet).
    const candidates = [];
    for (const customer of customers) {
      if (!(await prefsAllowMarketingSms(customer.id))) continue;
      if (await campaignCooldownReason(customer.id)) continue;
      candidates.push(customer);
    }

    if (!gateOn) {
      logger.info(
        `[seasonal-reactivation] shadow: ${candidates.length} reactivation candidate(s) ` +
        `of ${customers.length} lapsed customer(s) (gate off - no drafts written, no sends)`
      );
      return { candidates: candidates.length, drafted: 0, gate: 'off', month, hookType: seasonal.type };
    }

    let drafted = 0;

    for (const customer of candidates) {
      try {
        // Check if customer has history matching the seasonal hook type
        let hookText = seasonal.hook;
        if (seasonal.type !== 'general') {
          const matchingService = await db('service_records')
            .where({ customer_id: customer.id })
            .where('service_type', 'ilike', `%${seasonal.type}%`)
            .first();

          // Fall back to general if no matching service history
          if (!matchingService) {
            hookText = 'We haven\'t seen you in a while - let\'s get your home protected';
          }
        }

        const locationPhone = TWILIO_NUMBERS.getOutboundNumber(customer.location_id);
        const locationInfo = TWILIO_NUMBERS.findByNumber(locationPhone);
        const callNumber = locationInfo?.formatted || '(941) 318-7612';

        const body = await renderSmsTemplate('seasonal_reactivation', {
          first_name: customer.first_name || 'there',
          hook_text: hookText,
          address_clause: customer.address ? ` at ${customer.address}` : '',
          call_number: callNumber,
        }, {
          workflow: 'seasonal_reactivation',
          entity_type: 'customer',
          entity_id: customer.id,
        });
        if (!body) {
          logger.warn(`[seasonal-reactivation] template missing/disabled — skipping customer ${customer.id}`);
          continue;
        }

        // Pending draft for owner approval — NEVER a send. The approve route
        // sends under purpose 'marketing' with the full consent chain.
        await db('message_drafts').insert({
          customer_id: customer.id,
          draft_response: toGsm7Safe(body),
          status: 'pending',
          campaign_type: 'reactivation',
          purpose: 'marketing',
          source_ref: `customers:${customer.id}`,
          context_summary: `Seasonal reactivation (${seasonal.type}): ${hookText}`,
        });

        drafted++;
      } catch (err) {
        logger.error(`Reactivation draft failed for customer ${customer.id}: ${err.message}`);
      }
    }

    logger.info(
      `Seasonal reactivation: ${drafted} pending draft(s) written for owner approval ` +
      `(${candidates.length} candidate(s), month ${month})`
    );
    return { candidates: candidates.length, drafted, gate: 'on', month, hookType: seasonal.type };
  }
}

module.exports = new SeasonalReactivation();
