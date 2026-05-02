const db = require('../models/db');
const logger = require('./logger');
const { sendCustomerMessage } = require('./messaging/send-customer-message');

// ---------------------------------------------------------------------------
// Sequence templates
// ---------------------------------------------------------------------------
const SEQUENCE_TEMPLATES = {
  churn_save: {
    totalSteps: 3,
    steps: [
      {
        step: 1,
        type: 'sms',
        delayDays: 0,
        template: `Hi {first_name}, this is Adam from Waves Pest Control. I noticed it's been a bit since we last connected. I wanted to personally check in — is everything going well with your pest and lawn care? We're always here to help. Just reply or give us a call!`,
        description: 'Personal check-in SMS from owner',
      },
      {
        step: 2,
        type: 'call',
        delayDays: 3,
        template: null,
        description: 'Follow-up courtesy call — discuss concerns, offer solutions',
      },
      {
        step: 3,
        type: 'sms',
        delayDays: 10,
        template: `Hi {first_name}, Adam here from Waves. I hope all is well! As a valued {tier} member, I'd love to make sure you're getting the most out of your service. We have some great options for your {street_name} property. Reply YES for a quick call or let us know how we can help!`,
        description: 'Value reinforcement SMS with retention offer',
      },
    ],
  },
  win_back: {
    totalSteps: 3,
    steps: [
      {
        step: 1,
        type: 'sms',
        delayDays: 0,
        template: `Hi {first_name}, this is Adam from Waves Pest Control. We miss having you as a customer! I wanted to reach out and see if there's anything we can do better. We'd love the chance to earn your business back. Reply or call anytime!`,
        description: 'Win-back initial outreach',
      },
      {
        step: 2,
        type: 'sms',
        delayDays: 30,
        template: `Hi {first_name}, Adam from Waves again. Just a friendly reminder that we're here whenever you need us. Whether it's pest control, lawn care, or anything in between — we've got you covered in {city}. Let us know if you'd like to schedule a visit!`,
        description: 'Win-back reminder with service mention',
      },
      {
        step: 3,
        type: 'sms',
        delayDays: 90,
        template: `Hey {first_name}! Adam from Waves Pest Control. It's been a while and I wanted to extend a special offer. We'd love to have you back — reply WAVES for a free property assessment at your {street_name} home. Hope to hear from you!`,
        description: 'Final win-back with special offer',
      },
    ],
  },
};

// ---------------------------------------------------------------------------
// Enroll customer in a save sequence
// ---------------------------------------------------------------------------
async function enrollCustomer(customerId, sequenceType, alertId = null) {
  const template = SEQUENCE_TEMPLATES[sequenceType];
  if (!template) throw new Error(`Unknown sequence type: ${sequenceType}`);

  // Check if customer already has an active sequence of this type
  const existing = await db('customer_save_sequences')
    .where('customer_id', customerId)
    .where('sequence_type', sequenceType)
    .where('status', 'active')
    .first();

  if (existing) {
    logger.info(`[save-seq] Customer ${customerId} already in active ${sequenceType} sequence`);
    return existing;
  }

  // Build steps with scheduled dates
  const now = new Date();
  const steps = template.steps.map(step => ({
    ...step,
    scheduledAt: new Date(now.getTime() + step.delayDays * 86400000).toISOString(),
    status: step.step === 1 ? 'pending' : 'waiting',
    executedAt: null,
    result: null,
  }));

  const [sequence] = await db('customer_save_sequences').insert({
    customer_id: customerId,
    trigger_alert_id: alertId,
    sequence_type: sequenceType,
    status: 'active',
    current_step: 1,
    total_steps: template.totalSteps,
    steps: JSON.stringify(steps),
    started_at: now,
  }).returning('*');

  logger.info(`[save-seq] Enrolled customer ${customerId} in ${sequenceType} sequence (${template.totalSteps} steps)`);

  // Execute step 1 immediately if delayDays is 0
  if (steps[0].delayDays === 0) {
    await executeStep(sequence.id, 0);
  }

  return sequence;
}

// ---------------------------------------------------------------------------
// Execute a single step
// ---------------------------------------------------------------------------
async function executeStep(sequenceId, stepIndex) {
  const sequence = await db('customer_save_sequences').where('id', sequenceId).first();
  if (!sequence || sequence.status !== 'active') return;

  const steps = typeof sequence.steps === 'string' ? JSON.parse(sequence.steps) : sequence.steps;
  if (stepIndex < 0 || stepIndex >= steps.length) return;

  const step = steps[stepIndex];
  if (step.status === 'completed') return;

  const customer = await db('customers').where('id', sequence.customer_id).first();
  if (!customer) {
    logger.warn(`[save-seq] Customer ${sequence.customer_id} not found, cancelling sequence`);
    await cancelSequence(sequenceId, 'customer_not_found');
    return;
  }

  let result = { success: false, message: '' };

  if (step.type === 'sms' && step.template) {
    try {
      let msg = step.template;
      msg = msg.replace(/{first_name}/g, customer.first_name || 'there');
      msg = msg.replace(/{owner_name}/g, 'Adam');
      msg = msg.replace(/{tier}/g, customer.waveguard_tier || 'valued');
      msg = msg.replace(/{city}/g, customer.city || 'your area');
      msg = msg.replace(/{street_name}/g, customer.street || customer.address || 'your');
      msg = msg.replace(/{services_list}/g, 'pest control & lawn care');

      if (customer.phone) {
        const smsResult = await sendCustomerMessage({
          to: customer.phone,
          body: msg,
          channel: 'sms',
          audience: 'customer',
          purpose: 'retention',
          customerId: customer.id,
          identityTrustLevel: 'phone_matches_customer',
          entryPoint: 'save_sequence',
          consentBasis: {
            status: 'opted_in',
            source: 'customer_retention_preferences',
            capturedAt: customer.updated_at || customer.created_at || new Date().toISOString(),
          },
          metadata: {
            original_message_type: 'save_sequence',
            sequence_id: sequence.id,
            sequence_type: sequence.sequence_type,
            step_number: step.step,
          },
        });
        result = smsResult.sent
          ? { success: true, message: 'SMS sent' }
          : { success: false, message: `SMS blocked/failed: ${smsResult.code || smsResult.reason || 'unknown'}` };
      } else {
        result = { success: false, message: 'No phone number' };
      }
    } catch (err) {
      result = { success: false, message: `SMS failed: ${err.message}` };
    }
  } else if (step.type === 'call') {
    // Create alert for manual call
    try {
      await db('customer_health_alerts').insert({
        customer_id: customer.id,
        alert_type: 'save_call_task',
        severity: 'high',
        title: `Save sequence call: ${customer.first_name} ${customer.last_name}`,
        description: step.description || 'Follow-up call as part of customer save sequence.',
        trigger_data: JSON.stringify({ sequenceId, stepIndex }),
        recommended_actions: JSON.stringify([
          { label: 'Mark call completed', type: 'resolve' },
        ]),
        status: 'new',
      });
      result = { success: true, message: 'Call task created' };
    } catch (err) {
      result = { success: false, message: `Call task creation failed: ${err.message}` };
    }
  }

  // Update step status
  steps[stepIndex].status = 'completed';
  steps[stepIndex].executedAt = new Date().toISOString();
  steps[stepIndex].result = result;

  // Mark next step as pending
  if (stepIndex + 1 < steps.length) {
    steps[stepIndex + 1].status = 'pending';
  }

  const nextStep = stepIndex + 2; // current_step is 1-based
  const updates = {
    steps: JSON.stringify(steps),
    current_step: Math.min(nextStep, sequence.total_steps),
    updated_at: new Date(),
  };

  // If all steps complete
  if (stepIndex + 1 >= steps.length) {
    updates.status = 'completed';
    updates.completed_at = new Date();
    updates.outcome = 'sequence_completed';
  }

  await db('customer_save_sequences').where('id', sequenceId).update(updates);
  logger.info(`[save-seq] Executed step ${stepIndex + 1}/${steps.length} for sequence ${sequenceId}: ${result.message}`);
}

// ---------------------------------------------------------------------------
// Process all due sequences (run hourly)
// ---------------------------------------------------------------------------
async function processSequences() {
  let processed = 0;
  let errors = 0;

  try {
    const active = await db('customer_save_sequences').where('status', 'active');

    for (const seq of active) {
      try {
        const steps = typeof seq.steps === 'string' ? JSON.parse(seq.steps) : seq.steps;

        for (let i = 0; i < steps.length; i++) {
          const step = steps[i];
          if (step.status !== 'pending') continue;

          const scheduledAt = new Date(step.scheduledAt);
          if (scheduledAt <= new Date()) {
            await executeStep(seq.id, i);
            processed++;
          }
        }
      } catch (err) {
        errors++;
        logger.error(`[save-seq] Processing failed for sequence ${seq.id}: ${err.message}`);
      }
    }

    if (processed > 0 || errors > 0) {
      logger.info(`[save-seq] Processed ${processed} steps, ${errors} errors`);
    }
  } catch (err) {
    logger.error(`[save-seq] Batch processing error: ${err.message}`);
  }

  return { processed, errors };
}

// ---------------------------------------------------------------------------
// Cancel a sequence
// ---------------------------------------------------------------------------
async function cancelSequence(id, reason) {
  await db('customer_save_sequences').where('id', id).update({
    status: 'cancelled',
    completed_at: new Date(),
    outcome: 'cancelled',
    outcome_notes: reason || 'Manually cancelled',
    updated_at: new Date(),
  });
  logger.info(`[save-seq] Cancelled sequence ${id}: ${reason}`);
}

// ---------------------------------------------------------------------------
// Complete a sequence with outcome
// ---------------------------------------------------------------------------
async function completeSequence(id, outcome, notes) {
  await db('customer_save_sequences').where('id', id).update({
    status: 'completed',
    completed_at: new Date(),
    outcome: outcome || 'manual_complete',
    outcome_notes: notes || '',
    updated_at: new Date(),
  });
  logger.info(`[save-seq] Completed sequence ${id}: ${outcome}`);
}

module.exports = {
  enrollCustomer,
  processSequences,
  cancelSequence,
  completeSequence,
};
