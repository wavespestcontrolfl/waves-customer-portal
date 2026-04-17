const db = require('../models/db');
const logger = require('./logger');
const { etDateString, addETDays } = require('../utils/datetime-et');

class PipelineManager {
  async onEvent(customerId, eventType, eventData = {}) {
    const customer = await db('customers').where({ id: customerId }).first();
    if (!customer) return;

    const stageMap = {
      lead_created: 'new_lead',
      first_contact: customer.pipeline_stage === 'new_lead' ? 'contacted' : null,
      estimate_created: ['new_lead', 'contacted'].includes(customer.pipeline_stage) ? 'estimate_sent' : null,
      estimate_sent: ['new_lead', 'contacted'].includes(customer.pipeline_stage) ? 'estimate_sent' : null,
      estimate_viewed: customer.pipeline_stage === 'estimate_sent' ? 'estimate_viewed' : null,
      estimate_followup_sent: ['estimate_sent', 'estimate_viewed'].includes(customer.pipeline_stage) ? 'follow_up' : null,
      estimate_accepted: 'won',
      estimate_declined: 'lost',
      first_service_completed: 'active_customer',
      cancellation: 'churned',
      no_service_60_days: customer.pipeline_stage === 'active_customer' ? 'at_risk' : null,
      no_service_120_days: ['active_customer', 'at_risk'].includes(customer.pipeline_stage) ? 'dormant' : null,
    };

    const newStage = stageMap[eventType];

    if (eventType === 'service_completed') {
      await db('customers').where({ id: customerId }).update({
        last_contact_date: new Date(), last_contact_type: 'service',
      });
    }

    if (newStage && newStage !== customer.pipeline_stage) {
      await db('customers').where({ id: customerId }).update({
        pipeline_stage: newStage, pipeline_stage_changed_at: new Date(),
      });
      await db('customer_interactions').insert({
        customer_id: customerId, interaction_type: 'note',
        subject: `Pipeline: ${customer.pipeline_stage} → ${newStage}`,
        body: `Auto-moved to "${newStage}". Trigger: ${eventType}`,
        metadata: JSON.stringify(eventData),
      });
      logger.info(`Pipeline: ${customer.first_name} ${customer.last_name} → ${newStage} (${eventType})`);
    }
  }

  async checkStaleCustomers() {
    const now = new Date();
    const d60 = etDateString(addETDays(now, -60));
    const d120 = etDateString(addETDays(now, -120));

    const atRisk = await db('customers')
      .where({ pipeline_stage: 'active_customer', active: true })
      .whereRaw("NOT EXISTS (SELECT 1 FROM service_records WHERE service_records.customer_id = customers.id AND service_records.service_date > ?)", [d60])
      .select('id');
    for (const c of atRisk) await this.onEvent(c.id, 'no_service_60_days');

    const dormant = await db('customers')
      .whereIn('pipeline_stage', ['active_customer', 'at_risk']).where({ active: true })
      .whereRaw("NOT EXISTS (SELECT 1 FROM service_records WHERE service_records.customer_id = customers.id AND service_records.service_date > ?)", [d120])
      .select('id');
    for (const c of dormant) await this.onEvent(c.id, 'no_service_120_days');
  }
}

module.exports = new PipelineManager();
