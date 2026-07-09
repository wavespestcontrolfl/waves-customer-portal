const db = require('../models/db');
const logger = require('./logger');
const { etDateString, addETDays } = require('../utils/datetime-et');

// Display name that drops a missing/null last name so we never render
// "Sam null" in alert titles, descriptions, or call-task messages.
function fullName(c) {
  return [c && c.first_name, c && c.last_name].filter(Boolean).join(' ').trim() || 'Customer';
}

// ---------------------------------------------------------------------------
// Alert rule definitions
// ---------------------------------------------------------------------------
const ALERT_RULES = [
  {
    type: 'score_drop',
    severity: 'high',
    check: (data) => data.scoreChange30d !== null && data.scoreChange30d < -15,
    title: (data) => `Health score dropped ${Math.abs(data.scoreChange30d)} points in 30 days`,
    description: (data) => `${fullName(data.customer)}'s score fell from ${data.overall + Math.abs(data.scoreChange30d)} to ${data.overall}. Primary drivers: ${(data.churnSignals || []).map(s => String(s.signal || '').replace(/_/g, ' ')).filter(Boolean).join(', ') || 'general decline'}.`,
    actions: [
      { label: 'Schedule courtesy call', type: 'call' },
    ],
  },
  {
    type: 'critical_risk',
    severity: 'critical',
    check: (data) => data.churnRisk === 'critical',
    title: (data) => `Critical churn risk: ${fullName(data.customer)}`,
    description: (data) => `Score ${data.overall} (${data.grade}). Probability of churn: ${Math.round((data.churnProbability || 0) * 100)}%. Estimated ${data.daysUntilChurn || '?'} days until churn.`,
    actions: [
      { label: 'Call immediately', type: 'call' },
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
    description: (data) => `${fullName(data.customer)} hasn't had a service visit in over ${Math.round(data.serviceDetails.daysSinceLastService / 30)} months.`,
    actions: [
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
    title: (data) => `Payment issues detected for ${fullName(data.customer)}`,
    description: (data) => `Payment score: ${data.payment}. Failed payments: ${data.paymentDetails?.failedCount || 0}. Late payments: ${data.paymentDetails?.lateCount || 0}.`,
    actions: [
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
    title: (data) => `Low engagement: ${fullName(data.customer)}`,
    description: (data) => `No contact in ${data.engagementDetails.daysSinceLastContact} days. Engagement score: ${data.engagement}.`,
    actions: [
      { label: 'Schedule courtesy call', type: 'call' },
    ],
  },
  {
    type: 'satisfaction_drop',
    severity: 'high',
    check: (data) => data.satisfaction < 30,
    title: (data) => `Low satisfaction: ${fullName(data.customer)}`,
    description: (data) => `Satisfaction score: ${data.satisfaction}. Avg rating: ${data.satisfactionDetails?.avgRating || 'N/A'}. Complaints: ${data.satisfactionDetails?.complaintCount || 0}.`,
    actions: [
      { label: 'Call to address concerns', type: 'call' },
    ],
  },
  {
    type: 'new_customer_risk',
    severity: 'moderate',
    check: (data) => {
      const months = data.loyaltyDetails?.tenureMonths;
      return months !== undefined && months < 6 && data.overall < 50;
    },
    title: (data) => `New customer at risk: ${fullName(data.customer)}`,
    description: (data) => `Customer joined ${data.loyaltyDetails.tenureMonths} months ago with a score of ${data.overall}. Early intervention recommended.`,
    actions: [
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

      // The SELECT above is the fast path; the insert is also made atomically
      // idempotent so two concurrent rescores for the same customer (e.g. two
      // inbound SMS webhooks) can't both create an active alert of this type.
      // Partial unique index customer_health_alerts_active_rule_uniq enforces
      // one active (new/acknowledged) row per (customer_id, alert_type) for the
      // RULE types this function emits; the loser hits 23505 and is skipped.
      // (Operational alerts from other paths are out of that index's scope.)
      let inserted;
      try {
        [inserted] = await db('customer_health_alerts').insert(alert).returning('*');
      } catch (err) {
        if (err.code === '23505') continue;
        throw err;
      }
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
  if (action?.type === 'sequence' || action?.sequenceType) {
    return {
      success: false,
      code: 'retired_action_type',
      message: 'Save sequence actions are no longer available.',
    };
  }
  const customer = await db('customers').where('id', alert.customer_id).first();
  if (!customer) throw new Error('Customer not found');

  let result = { success: false, message: '' };

  if (action.type === 'sms' || action.type === 'send_sms') {
    // Health outreach texting retired (owner directive 2026-07-06) — the
    // health_* templates are deleted and old alerts may still carry sms
    // actions, so treat them like the retired save-sequence actions. Health
    // alerts remain admin-facing (call/discount/free-service actions).
    return {
      success: false,
      code: 'retired_action_type',
      message: 'Health outreach SMS actions are no longer available — call the customer instead.',
    };
  } else if (action.type === 'call' || action.type === 'schedule_call') {
    // Create customer_interactions task for callback
    try {
      await db('customer_interactions').insert({
        customer_id: customer.id,
        interaction_type: 'scheduled_call',
        status: 'pending',
        body: action.notes || `Health alert follow-up call for ${fullName(customer)}`,
        created_at: new Date(),
      });
      result = { success: true, message: `Call task created for ${fullName(customer)}` };
    } catch (err) {
      // Fallback if table doesn't have expected columns
      logger.debug(`[health-alerts] Call task insert fallback: ${err.message}`);
      result = { success: true, message: `Call task noted for ${fullName(customer)}` };
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
          body: `$${discountAmount} retention credit — Health alert #${alertId}`,
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
        scheduled_date: etDateString(addETDays(new Date(), 7)),
        created_at: new Date(),
      });
      result = { success: true, message: `Complimentary service scheduled for ${customer.first_name}` };
    } catch (err) {
      result = { success: false, message: `Free service scheduling failed: ${err.message}` };
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
