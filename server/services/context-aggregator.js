const db = require('../models/db');
const logger = require('./logger');

class ContextAggregator {
  async getFullCustomerContext(phone) {
    const clean = (phone || '').replace(/\D/g, '');
    const variants = [clean, `1${clean}`, `+1${clean}`, clean.slice(-10)];

    const customer = await db('customers').where(function () {
      for (const v of variants) this.orWhere('phone', v).orWhere('phone', `+${v}`);
    }).first();

    if (!customer) return { known: false, phone: clean, summary: 'Unknown number — no customer record.' };

    // Parallel data fetch
    const [smsHistory, serviceHistory, upcomingServices, propertyPrefs, payments, interactions, complaints, reschedules, pendingEstimate, activeCancelSave, compliance] = await Promise.all([
      db('sms_log').where({ customer_id: customer.id }).orderBy('created_at', 'desc').limit(20),
      db('service_records').where({ customer_id: customer.id }).orderBy('service_date', 'desc').limit(5),
      db('scheduled_services').where({ customer_id: customer.id }).where('scheduled_date', '>=', new Date().toISOString().split('T')[0]).whereNotIn('status', ['cancelled', 'completed']).orderBy('scheduled_date').limit(3),
      db('property_preferences').where({ customer_id: customer.id }).first(),
      db('payments').where({ 'payments.customer_id': customer.id }).orderBy('payment_date', 'desc').limit(5),
      db('customer_interactions').where({ customer_id: customer.id }).orderBy('created_at', 'desc').limit(10),
      db('customer_interactions').where({ customer_id: customer.id, interaction_type: 'complaint' }).where('created_at', '>', new Date(Date.now() - 90 * 86400000)),
      db('reschedule_log').where({ customer_id: customer.id }).where('created_at', '>', new Date(Date.now() - 30 * 86400000)).count('* as count').first(),
      db('estimates').where({ customer_id: customer.id }).whereIn('status', ['sent', 'viewed']).orderBy('created_at', 'desc').first(),
      db('sms_sequences').where({ customer_id: customer.id, sequence_type: 'cancellation_save', status: 'active' }).first(),
      this.getCompliance(customer.id),
    ]);

    const lastService = serviceHistory[0] || null;
    const balance = payments.filter(p => ['failed', 'pending', 'overdue'].includes(p.status)).reduce((s, p) => s + parseFloat(p.amount || 0), 0);

    // Build flags
    const flags = [];
    if (balance > 0) flags.push({ type: 'overdue_balance', severity: balance > 200 ? 'high' : 'medium', detail: `$${balance.toFixed(2)} outstanding` });
    if (complaints.length > 0) flags.push({ type: 'open_complaint', severity: 'high', detail: complaints[0].subject });
    if (propertyPrefs?.pet_details) flags.push({ type: 'pet_alert', severity: 'info', detail: propertyPrefs.pet_details });
    if (propertyPrefs?.chemical_sensitivities) flags.push({ type: 'sensitivity', severity: 'medium', detail: propertyPrefs.chemical_sensitivity_details || 'Yes' });
    if (parseInt(reschedules?.count || 0) > 1) flags.push({ type: 'reschedule_history', severity: 'medium', detail: `${reschedules.count} reschedules in 30 days` });
    if (['at_risk', 'churned'].includes(customer.pipeline_stage)) flags.push({ type: 'churn_risk', severity: 'high', detail: `Stage: ${customer.pipeline_stage}` });
    if (activeCancelSave) flags.push({ type: 'cancel_save_active', severity: 'high', detail: `Cancel save step ${activeCancelSave.step}` });
    if (pendingEstimate) flags.push({ type: 'pending_estimate', severity: 'info', detail: `$${pendingEstimate.monthly_total}/mo ${pendingEstimate.waveguard_tier}` });

    const summary = this.buildSummary(customer, flags, lastService, upcomingServices, balance);

    return {
      known: true,
      customer: {
        id: customer.id, name: `${customer.first_name} ${customer.last_name}`,
        firstName: customer.first_name, phone: customer.phone, email: customer.email,
        address: `${customer.address_line1}, ${customer.city}, FL ${customer.zip}`,
        tier: customer.waveguard_tier, monthlyRate: parseFloat(customer.monthly_rate || 0),
        pipelineStage: customer.pipeline_stage, leadScore: customer.lead_score,
        customerSince: customer.customer_since,
      },
      smsHistory: smsHistory.map(m => ({ direction: m.direction, body: m.message_body, date: m.created_at, type: m.message_type })),
      lastService: lastService ? { type: lastService.service_type, date: lastService.service_date, notes: lastService.technician_notes } : null,
      upcomingServices: upcomingServices.map(s => ({ type: s.service_type, date: s.scheduled_date, window: s.window_display, status: s.status })),
      billing: { outstandingBalance: balance, recentPayments: payments.slice(0, 3) },
      propertyPrefs: propertyPrefs || {},
      flags, compliance,
      recentInteractions: interactions.slice(0, 5).map(i => ({ type: i.interaction_type, subject: i.subject, date: i.created_at })),
      summary,
    };
  }

  buildSummary(c, flags, lastSvc, upcoming, balance) {
    let s = `${c.first_name} ${c.last_name} | ${c.waveguard_tier || 'No tier'} ($${c.monthly_rate || 0}/mo) | ${c.pipeline_stage}`;
    if (lastSvc) s += ` | Last: ${lastSvc.service_type} ${new Date(lastSvc.service_date).toLocaleDateString()}`;
    if (upcoming.length) s += ` | Next: ${upcoming[0].service_type} ${new Date(upcoming[0].scheduled_date).toLocaleDateString()}`;
    if (balance > 0) s += ` | ⚠️ $${balance.toFixed(2)} overdue`;
    if (flags.some(f => f.type === 'open_complaint')) s += ` | ⚠️ Open complaint`;
    if (flags.some(f => f.type === 'cancel_save_active')) s += ` | 🚨 Cancel save active`;
    return s;
  }

  async getCompliance(customerId) {
    try {
      const LimitChecker = require('./application-limits');
      return await LimitChecker.getPropertyComplianceStatus(customerId);
    } catch { return null; }
  }
}

module.exports = new ContextAggregator();
