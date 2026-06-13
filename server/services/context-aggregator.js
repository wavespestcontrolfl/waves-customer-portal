const db = require('../models/db');
const logger = require('./logger');
const { etDateString } = require('../utils/datetime-et');

// Statuses that represent a real, confidently-stated upcoming visit. This is
// an ALLOW-list (fail-closed) on purpose: a deny-list of cancelled/completed
// would leak phantom rows into customer-facing facts. 'rescheduled' keeps the
// STALE date/window until the office actions it through SmartRebooker
// (admin-schedule.js:1069-1075), and 'skipped'/'no_show' are terminal — none
// is a visit we can promise a date for. pending+confirmed are the live set
// (545/545 upcoming in prod); en_route/on_site cover the same-day in-progress
// case a texting customer may hit.
const UPCOMING_SERVICE_STATUSES = ['pending', 'confirmed', 'en_route', 'on_site'];

class ContextAggregator {
  async getFullCustomerContext(phone) {
    const clean = (phone || '').replace(/\D/g, '');
    const variants = [clean, `1${clean}`, `+1${clean}`, clean.slice(-10)];

    const customer = await db('customers').where(function () {
      for (const v of variants) this.orWhere('phone', v).orWhere('phone', `+${v}`);
    }).first();

    if (!customer) return { known: false, phone: clean, summary: 'Unknown number — no customer record.' };

    return this.getContextForCustomer(customer);
  }

  // Build context from an already-matched customer row. Callers like the
  // inbound SMS webhook resolve a single active customer with deleted_at and
  // shared-number protection — re-looking up by phone here could silently
  // pick a different (or deleted) account that shares the number.
  async getContextForCustomer(customer) {
    // Parallel data fetch
    const [smsHistory, serviceHistory, upcomingServices, propertyPrefs, payments, interactions, complaints, reschedules, pendingEstimate, activeCancelSave, compliance] = await Promise.all([
      db('sms_log').where({ customer_id: customer.id }).orderBy('created_at', 'desc').limit(20),
      db('service_records').where({ customer_id: customer.id }).orderBy('service_date', 'desc').limit(5),
      db('scheduled_services as ss').leftJoin('technicians as tech', 'ss.technician_id', 'tech.id').where('ss.customer_id', customer.id).where('ss.scheduled_date', '>=', etDateString()).whereIn('ss.status', UPCOMING_SERVICE_STATUSES).orderBy('ss.scheduled_date').limit(3).select('ss.service_type', 'ss.scheduled_date', 'ss.window_display', 'ss.window_start', 'ss.window_end', 'ss.time_window', 'ss.status', 'tech.name as technician_name'),
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
    // Superseded failed attempts were collected by their retry's own row —
    // counting them would describe already-taken money as owed in
    // customer-facing replies.
    const balance = payments.filter(p => ['failed', 'pending', 'overdue'].includes(p.status) && !p.superseded_by_payment_id).reduce((s, p) => s + parseFloat(p.amount || 0), 0);

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
      upcomingServices: upcomingServices.map(s => ({ type: s.service_type, date: s.scheduled_date, window: this.deriveWindow(s), status: s.status, tech: s.technician_name || null })),
      billing: { outstandingBalance: balance, recentPayments: payments.slice(0, 3) },
      propertyPrefs: propertyPrefs || {},
      flags, compliance,
      recentInteractions: interactions.slice(0, 5).map(i => ({ type: i.interaction_type, subject: i.subject, date: i.created_at })),
      summary,
    };
  }

  // The arrival window lives in window_start/window_end (Postgres `time`, ET
  // wall-clock strings like '13:00:00') on nearly every row — booking and
  // admin-schedule both write those, while window_display is set by only a
  // few legacy paths (1 of 545 upcoming in prod). Derive a human window from
  // whatever is present so the drafter states the REAL time instead of
  // "no window set"; time_window ('morning'/'afternoon') is the coarse fallback.
  deriveWindow(s) {
    const display = (s.window_display || '').toString().trim();
    if (display) return display;
    const start = this.formatClockTime(s.window_start);
    const end = this.formatClockTime(s.window_end);
    if (start && end) return `${start}–${end}`;
    if (start) return start;
    const tw = (s.time_window || '').toString().trim();
    if (tw) return tw.charAt(0).toUpperCase() + tw.slice(1);
    return null;
  }

  // 'HH:MM:SS' (already ET wall clock, no tz) → '1:00 PM'. Returns null on a
  // shape it can't parse so deriveWindow falls through rather than guessing.
  formatClockTime(t) {
    const m = /^(\d{1,2}):(\d{2})/.exec((t || '').toString());
    if (!m) return null;
    let h = parseInt(m[1], 10);
    if (Number.isNaN(h)) return null;
    const ampm = h >= 12 ? 'PM' : 'AM';
    h = h % 12 || 12;
    return `${h}:${m[2]} ${ampm}`;
  }

  buildSummary(c, flags, lastSvc, upcoming, balance) {
    let s = `${c.first_name} ${c.last_name} | ${c.waveguard_tier || 'No tier'} ($${c.monthly_rate || 0}/mo) | ${c.pipeline_stage}`;
    if (lastSvc) s += ` | Last: ${lastSvc.service_type} ${new Date(lastSvc.service_date).toLocaleDateString('en-US', { timeZone: 'America/New_York' })}`;
    if (upcoming.length) s += ` | Next: ${upcoming[0].service_type} ${new Date(upcoming[0].scheduled_date).toLocaleDateString('en-US', { timeZone: 'America/New_York' })}`;
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
module.exports.UPCOMING_SERVICE_STATUSES = UPCOMING_SERVICE_STATUSES;
