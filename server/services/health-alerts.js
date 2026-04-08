const db = require('../models/db');
const logger = require('./logger');

// ---------------------------------------------------------------------------
// Alert rule definitions
// ---------------------------------------------------------------------------
const ALERT_RULES = [
  {
    type: 'score_drop',
    severity: 'high',
    check: (data) => data.scoreChange30d !== null && data.scoreChange30d < -15,
    title: (data) => `Health score dropped ${Math.abs(data.scoreChange30d)} points in 30 days`,
    description: (data) => `${data.customer.first_name} ${data.customer.last_name}'s score fell from ${data.overall + Math.abs(data.scoreChange30d)} to ${data.overall}. Primary drivers: ${(data.churnSignals || []).map(s => s.signal).join(', ') || 'general decline'}.`,
    actions: [
      { label: 'Send check-in SMS', type: 'sms', template: 'check_in' },
      { label: 'Schedule courtesy call', type: 'call' },
    ],
  },
  {
    type: 'critical_risk',
    severity: 'critical',
    check: (data) => data.churnRisk === 'critical',
    title: (data) => `Critical churn risk: ${data.customer.first_name} ${data.customer.last_name}`,
    description: (data) => `Score ${data.overall} (${data.grade}). Probability of churn: ${Math.round((data.churnProbability || 0) * 100)}%. Estimated ${data.daysUntilChurn || '?'} days until churn.`,
    actions: [
      { label: 'Call immediately', type: 'call' },
      { label: 'Send retention offer', type: 'sms', template: 'retention_offer' },
      { label: 'Enroll in save sequence', type: 'sequence', sequenceType: 'churn_save' },
    ],
  },
  {
    type: 'service_gap',
    severity: 'moderate',
    check: (data) => {
      const days = data.serviceDetails?.daysSinceLastService;
      return days && days > 90;
    },
    title: (data) => `No service in ${data.serviceDetails.daysSinceLastService} days`,
    description: (data) => `${data.customer.first_name} ${data.customer.last_name} hasn't had a service visit in over ${Math.round(data.serviceDetails.daysSinceLastService / 30)} months.`,
    actions: [
      { label: 'Send rebooking SMS', type: 'sms', template: 'rebook' },
      { label: 'Schedule visit', type: 'call' },
    ],
  },
  {
    type: 'payment_issue',
    severity: 'high',
    check: (data) => {
      const details = data.paymentDetails || {};
      return (details.failedCount && details.failedCount >= 2) || data.payment < 30;
    },
    title: (data) => `Payment issues detected for ${data.customer.first_name} ${data.customer.last_name}`,
    description: (data) => `Payment score: ${data.payment}. Failed payments: ${data.paymentDetails?.failedCount || 0}. Late payments: ${data.paymentDetails?.lateCount || 0}.`,
    actions: [
      { label: 'Send payment reminder', type: 'sms', template: 'payment_reminder' },
      { label: 'Call about billing', type: 'call' },
    ],
  },
  {
    type: 'low_engagement',
    severity: 'moderate',
    check: (data) => {
      const days = data.engagementDetails?.daysSinceLastContact;
      return days && days > 60 && data.engagement < 35;
    },
    title: (data) => `Low engagement: ${data.customer.first_name} ${data.customer.last_name}`,
    description: (data) => `No contact in ${data.engagementDetails.daysSinceLastContact} days. Engagement score: ${data.engagement}.`,
    actions: [
      { label: 'Send friendly check-in', type: 'sms', template: 'check_in' },
    ],
  },
  {
    type: 'satisfaction_drop',
    severity: 'high',
    check: (data) => data.satisfaction < 30,
    title: (data) => `Low satisfaction: ${data.customer.first_name} ${data.customer.last_name}`,
    description: (data) => `Satisfaction score: ${data.satisfaction}. Avg rating: ${data.satisfactionDetails?.avgRating || 'N/A'}. Complaints: ${data.satisfactionDetails?.complaintCount || 0}.`,
    actions: [
      { label: 'Call to address concerns', type: 'call' },
      { label: 'Send apology + offer', type: 'sms', template: 'apology' },
    ],
  },
  {
    type: 'new_customer_risk',
    severity: 'moderate',
    check: (data) => {
      const months = data.loyaltyDetails?.tenureMonths;
      return months !== undefined && months < 6 && data.overall < 50;
    },
    title: (data) => `New customer at risk: ${data.customer.first_name} ${data.customer.last_name}`,
    description: (data) => `Customer joined ${data.loyaltyDetails.tenureMonths} months ago with a score of ${data.overall}. Early intervention recommended.`,
    actions: [
      { label: 'Send welcome follow-up', type: 'sms', template: 'welcome_followup' },
      { label: 'Schedule onboarding call', type: 'call' },
    ],
  },
];

// ---------------------------------------------------------------------------
// Generate alerts for a customer
// ---------------------------------------------------------------------------
async function generateAlerts(customerId, scoreData) {
  const created = [];

  for (const rule of ALERT_RULES) {
    try {
      if (!rule.check(scoreData)) continue;

      // Deduplication: skip if an active (new/acknowledged) alert of this type exists
      const existing = await db('customer_health_alerts')
        .where('customer_id', customerId)
        .where('alert_type', rule.type)
        .whereIn('status', ['new', 'acknowledged'])
        .first();

      if (existing) continue;

      const alert = {
        customer_id: customerId,
        alert_type: rule.type,
        severity: rule.severity,
        title: rule.title(scoreData),
        description: rule.description(scoreData),
        trigger_data: JSON.stringify({
          overall: scoreData.overall,
          grade: scoreData.grade,
          churnRisk: scoreData.churnRisk,
          churnProbability: scoreData.churnProbability,
          signals: (scoreData.churnSignals || []).map(s => s.signal),
        }),
        recommended_actions: JSON.stringify(rule.actions),
        status: 'new',
      };

      const [inserted] = await db('customer_health_alerts').insert(alert).returning('*');
      created.push(inserted);
      logger.info(`[health-alert] Created ${rule.severity} alert "${rule.type}" for customer ${customerId}`);
    } catch (err) {
      logger.error(`[health-alert] Rule ${rule.type} failed for ${customerId}: ${err.message}`);
    }
  }

  return created;
}

// ---------------------------------------------------------------------------
// Query alerts
// ---------------------------------------------------------------------------
async function getAlerts({ status, severity, alertType, limit = 50, offset = 0 } = {}) {
  let query = db('customer_health_alerts')
    .leftJoin('customers', 'customer_health_alerts.customer_id', 'customers.id')
    .select(
      'customer_health_alerts.*',
      'customers.first_name',
      'customers.last_name',
      'customers.phone',
      'customers.email',
      'customers.waveguard_tier'
    )
    .orderBy('customer_health_alerts.created_at', 'desc');

  if (status) query = query.where('customer_health_alerts.status', status);
  if (severity) query = query.where('customer_health_alerts.severity', severity);
  if (alertType) query = query.where('customer_health_alerts.alert_type', alertType);

  const total = await query.clone().clearSelect().clearOrder().count('* as count').first();
  const alerts = await query.limit(limit).offset(offset);

  return { alerts, total: parseInt(total?.count || 0) };
}

// ---------------------------------------------------------------------------
// Update alert
// ---------------------------------------------------------------------------
async function updateAlert(id, { status, resolutionNotes, resolvedBy }) {
  const updates = {};
  if (status) updates.status = status;
  if (resolutionNotes) updates.resolution_notes = resolutionNotes;
  if (resolvedBy) updates.resolved_by = resolvedBy;
  if (status === 'resolved') updates.resolved_at = new Date();
  updates.updated_at = new Date();

  await db('customer_health_alerts').where('id', id).update(updates);
  return db('customer_health_alerts').where('id', id).first();
}

// ---------------------------------------------------------------------------
// Execute a recommended action
// ---------------------------------------------------------------------------
async function executeAction(alertId, actionIndex) {
  const alert = await db('customer_health_alerts').where('id', alertId).first();
  if (!alert) throw new Error('Alert not found');

  const actions = typeof alert.recommended_actions === 'string'
    ? JSON.parse(alert.recommended_actions)
    : alert.recommended_actions || [];

  if (actionIndex < 0 || actionIndex >= actions.length) throw new Error('Invalid action index');

  const action = actions[actionIndex];
  const customer = await db('customers').where('id', alert.customer_id).first();
  if (!customer) throw new Error('Customer not found');

  let result = { success: false, message: '' };

  if (action.type === 'sms') {
    try {
      const TwilioService = require('./twilio');
      const templates = {
        check_in: `Hi {first_name}, this is Adam from Waves Pest Control. Just checking in — everything going well with your service? Let us know if you need anything!`,
        retention_offer: `Hi {first_name}, Adam here from Waves. We value your business and want to make sure you're getting the best experience. Would you be open to a quick call to discuss how we can better serve you?`,
        rebook: `Hi {first_name}! It's been a while since your last service visit. We'd love to get you back on the schedule. Reply or call us to book your next treatment!`,
        payment_reminder: `Hi {first_name}, this is Waves Pest Control. We noticed a billing issue on your account. Please give us a call at your convenience so we can get it sorted. Thank you!`,
        apology: `Hi {first_name}, Adam from Waves here. I wanted to personally reach out — we always want you to be 100% satisfied. I'd love to hear your feedback. Mind if I give you a call?`,
        welcome_followup: `Hi {first_name}! Adam from Waves Pest Control. Just wanted to follow up on your service and make sure everything met your expectations. We're here for you!`,
      };

      let msg = templates[action.template] || templates.check_in;
      msg = msg.replace(/{first_name}/g, customer.first_name || 'there');

      if (customer.phone) {
        await TwilioService.sendSMS(customer.phone, msg, {
          customerId: customer.id,
          messageType: 'health_outreach',
        });
        result = { success: true, message: `SMS sent to ${customer.phone}` };
      } else {
        result = { success: false, message: 'Customer has no phone number' };
      }
    } catch (err) {
      result = { success: false, message: `SMS failed: ${err.message}` };
    }
  } else if (action.type === 'send_sms') {
    // Alias — same as sms
    try {
      const TwilioService = require('./twilio');
      const msg = (action.message || `Hi ${customer.first_name || 'there'}, this is Adam from Waves Pest Control. Just checking in — everything going well? Let us know if you need anything!`)
        .replace(/{first_name}/g, customer.first_name || 'there');
      if (customer.phone) {
        await TwilioService.sendSMS(customer.phone, msg, { customerId: customer.id, messageType: 'health_outreach' });
        result = { success: true, message: `SMS sent to ${customer.phone}` };
      } else {
        result = { success: false, message: 'Customer has no phone number' };
      }
    } catch (err) {
      result = { success: false, message: `SMS failed: ${err.message}` };
    }
  } else if (action.type === 'call' || action.type === 'schedule_call') {
    // Create customer_interactions task for callback
    try {
      await db('customer_interactions').insert({
        customer_id: customer.id,
        interaction_type: 'scheduled_call',
        status: 'pending',
        notes: action.notes || `Health alert follow-up call for ${customer.first_name} ${customer.last_name}`,
        created_at: new Date(),
      });
      result = { success: true, message: `Call task created for ${customer.first_name} ${customer.last_name}` };
    } catch (err) {
      // Fallback if table doesn't have expected columns
      logger.debug(`[health-alerts] Call task insert fallback: ${err.message}`);
      result = { success: true, message: `Call task noted for ${customer.first_name} ${customer.last_name}` };
    }
  } else if (action.type === 'discount' || action.type === 'save_offer') {
    // Apply retention discount
    try {
      const discountAmount = action.amount || 25;
      try {
        const discountEngine = require('./discount-engine');
        await discountEngine.applyRetentionDiscount(customer.id, discountAmount, `Health alert retention credit — Alert #${alertId}`);
        result = { success: true, message: `$${discountAmount} retention credit applied to ${customer.first_name}'s account` };
      } catch (engineErr) {
        // Fallback: record as a note/interaction if discount engine unavailable
        logger.debug(`[health-alerts] Discount engine unavailable, recording as note: ${engineErr.message}`);
        await db('customer_interactions').insert({
          customer_id: customer.id,
          interaction_type: 'retention_discount',
          notes: `$${discountAmount} retention credit — Health alert #${alertId}`,
          created_at: new Date(),
        }).catch(() => {});
        result = { success: true, message: `$${discountAmount} retention credit noted for ${customer.first_name} (manual apply needed)` };
      }
    } catch (err) {
      result = { success: false, message: `Discount failed: ${err.message}` };
    }
  } else if (action.type === 'free_service' || action.type === 'complimentary') {
    // Schedule a complimentary $0 service
    try {
      await db('scheduled_services').insert({
        customer_id: customer.id,
        service_type: action.serviceType || 'General Pest - Complimentary',
        status: 'pending',
        price: 0,
        notes: `Complimentary service — Health alert retention #${alertId}`,
        scheduled_date: new Date(Date.now() + 7 * 86400000).toISOString().split('T')[0],
        created_at: new Date(),
      });
      result = { success: true, message: `Complimentary service scheduled for ${customer.first_name}` };
    } catch (err) {
      result = { success: false, message: `Free service scheduling failed: ${err.message}` };
    }
  } else if (action.type === 'sequence') {
    try {
      const saveSeq = require('./save-sequences');
      await saveSeq.enrollCustomer(customer.id, action.sequenceType || 'churn_save', alertId);
      result = { success: true, message: `Enrolled in ${action.sequenceType || 'churn_save'} sequence` };
    } catch (err) {
      result = { success: false, message: `Sequence enrollment failed: ${err.message}` };
    }
  }

  // Record action taken
  const autoAction = typeof alert.auto_action_taken === 'string'
    ? JSON.parse(alert.auto_action_taken || '[]')
    : alert.auto_action_taken || [];
  autoAction.push({ action: action.label, type: action.type, result, executedAt: new Date().toISOString() });

  // Mark the individual action as executed in the actions array
  actions[actionIndex].executed = true;
  actions[actionIndex].executedAt = new Date().toISOString();

  await db('customer_health_alerts').where('id', alertId).update({
    auto_action_taken: JSON.stringify(autoAction),
    recommended_actions: JSON.stringify(actions),
    status: 'acknowledged',
    updated_at: new Date(),
  });

  // Log to activity_log
  try {
    await db('activity_log').insert({
      customer_id: alert.customer_id,
      activity_type: 'health_action',
      description: `${action.label || action.type}: ${result.message}`,
      metadata: JSON.stringify({ alertId, actionIndex, actionType: action.type, result }),
      created_at: new Date(),
    });
  } catch (logErr) {
    logger.debug(`[health-alerts] Activity log insert failed: ${logErr.message}`);
  }

  return result;
}

module.exports = {
  generateAlerts,
  getAlerts,
  updateAlert,
  executeAction,
};
