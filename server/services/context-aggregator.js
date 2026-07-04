const db = require('../models/db');
const logger = require('./logger');
const { etDateString } = require('../utils/datetime-et');
const { arrivalWindowRange } = require('../utils/sms-time-format');

// Statuses that represent a real, confidently-stated upcoming visit. This is
// an ALLOW-list (fail-closed) on purpose: a deny-list of cancelled/completed
// would leak phantom rows into customer-facing facts. 'rescheduled' keeps the
// STALE date/window until the office actions it through SmartRebooker
// (admin-schedule.js:1069-1075), and 'skipped'/'no_show' are terminal — none
// is a visit we can promise a date for. pending+confirmed are the live set
// (545/545 upcoming in prod); en_route/on_site cover the same-day in-progress
// case a texting customer may hit.
const UPCOMING_SERVICE_STATUSES = ['pending', 'confirmed', 'en_route', 'on_site'];

// Calls the extractor affirmatively classified as not-a-real-conversation
// with this customer — their summaries must never ground an SMS reply.
const EXCLUDED_CALL_TYPES = new Set(['spam', 'wrong_number']);

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
    const [smsHistory, serviceHistory, upcomingServices, propertyPrefs, payments, interactions, complaints, reschedules, pendingEstimate, activeCancelSave, compliance, recentCalls] = await Promise.all([
      db('sms_log').where({ customer_id: customer.id }).orderBy('created_at', 'desc').limit(20),
      db('service_records').where({ customer_id: customer.id }).orderBy('service_date', 'desc').limit(5),
      db('scheduled_services as ss').leftJoin('technicians as tech', 'ss.technician_id', 'tech.id').where('ss.customer_id', customer.id).where('ss.scheduled_date', '>=', etDateString()).whereIn('ss.status', UPCOMING_SERVICE_STATUSES).orderBy('ss.scheduled_date').limit(3).select('ss.service_type', 'ss.scheduled_date', 'ss.window_display', 'ss.window_start', 'ss.window_end', 'ss.time_window', 'ss.status', 'tech.name as technician_name'),
      db('property_preferences').where({ customer_id: customer.id }).first(),
      db('payments').where({ 'payments.customer_id': customer.id }).orderBy('payment_date', 'desc').limit(5),
      db('customer_interactions').where({ customer_id: customer.id }).orderBy('created_at', 'desc').limit(10),
      db('customer_interactions').where({ customer_id: customer.id, interaction_type: 'complaint' }).where('created_at', '>', new Date(Date.now() - 90 * 86400000)),
      db('reschedule_log').where({ customer_id: customer.id }).where('created_at', '>', new Date(Date.now() - 30 * 86400000)).count('* as count').first(),
      // whereNull(archived_at): an archived sent/viewed row is a courtship
      // that already closed some other way — not a pending estimate.
      db('estimates').where({ customer_id: customer.id }).whereIn('status', ['sent', 'viewed']).whereNull('archived_at').orderBy('created_at', 'desc').first(),
      db('sms_sequences').where({ customer_id: customer.id, sequence_type: 'cancellation_save', status: 'active' }).first(),
      this.getCompliance(customer.id),
      this.getRecentCalls(customer.id),
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
      upcomingServices: upcomingServices.map(s => ({ type: s.service_type, date: s.scheduled_date, window: this.deriveWindow(s), status: s.status, tech: s.technician_name || null, isToday: this.calendarDay(s.scheduled_date) === etDateString() })),
      billing: { outstandingBalance: balance, recentPayments: payments.slice(0, 3) },
      propertyPrefs: propertyPrefs || {},
      flags, compliance,
      recentInteractions: interactions.slice(0, 5).map(i => ({ type: i.interaction_type, subject: i.subject, date: i.created_at })),
      recentCalls: recentCalls.map(c => ({ summary: c.call_summary, direction: c.direction, outcome: c.call_outcome, date: c.created_at })),
      summary,
    };
  }

  // Last few phone calls that produced an AI summary (call-recording-processor
  // writes call_log.call_summary after transcription). Customers routinely
  // text about what "we discussed on the phone" — without these the drafter
  // is blind to the other channel and invents what was said. Summaries only:
  // raw transcripts are long and speaker-attribution on legacy rows is
  // unreliable, while summaries exist on ~half of recent calls in prod.
  async getRecentCalls(customerId) {
    try {
      const rows = await db('call_log')
        .where({ customer_id: customerId })
        .where('created_at', '>', new Date(Date.now() - 30 * 86400000))
        .whereNotNull('call_summary')
        .whereRaw("length(trim(call_summary)) > 0")
        // The voice webhook links customer_id by caller ID BEFORE the call is
        // classified, so spam/wrong-number calls can carry this customer's id
        // — their summaries must never ground a reply. NULL outcome stays
        // eligible (NOT IN is UNKNOWN on NULL and would drop real calls that
        // simply haven't been assigned an outcome; same rule as the corpus
        // miner's Codex P2).
        .where((q) => q.whereNull('call_outcome').orWhereNotIn('call_outcome', ['wrong_number', 'spam']))
        .orderBy('created_at', 'desc')
        // over-fetch: the extraction-classified misdials below are filtered
        // in JS (ai_extraction is a TEXT column in prod — casting to jsonb in
        // SQL throws on any malformed row), and a filtered row must not
        // silently shrink the pick below 2 real calls.
        .limit(6)
        .select('direction', 'call_outcome', 'call_summary', 'created_at', 'ai_extraction', 'processing_status');
      return rows.filter((r) => !this.isExcludedCall(r)).slice(0, 2);
    } catch (err) {
      logger.warn(`[context] recent-call lookup failed for customer ${customerId}: ${err.message}`);
      return [];
    }
  }

  // Extracted call_type from a call_log.ai_extraction value (TEXT column
  // holding JSON.stringify output; tolerate an already-parsed object and
  // malformed rows). Returns '' when unknown — unknown stays ELIGIBLE, the
  // exclusion is only for calls the extractor affirmatively classified as
  // not-this-customer's-business.
  extractedCallType(raw) {
    try {
      const obj = typeof raw === 'string' ? JSON.parse(raw) : raw;
      return String(obj?.call_type || '').trim().toLowerCase();
    } catch { return ''; }
  }

  // A call is excluded from grounding on ANY affirmative not-a-real-
  // conversation signal, because the processor persists them inconsistently
  // (Codex P2 rounds 2-3): the spam skip path stamps processing_status='spam'
  // + ai_extraction.is_spam WITHOUT call_outcome (and call_type may be
  // missing/invalid there), while other paths only set call_type. is_lead is
  // NOT a signal — existing customers' real calls are all is_lead=false.
  isExcludedCall(row) {
    if (String(row?.processing_status || '').trim().toLowerCase() === 'spam') return true;
    if (EXCLUDED_CALL_TYPES.has(this.extractedCallType(row?.ai_extraction))) return true;
    try {
      const obj = typeof row?.ai_extraction === 'string' ? JSON.parse(row.ai_extraction) : row?.ai_extraction;
      return obj?.is_spam === true;
    } catch { return false; }
  }

  // Calendar day 'YYYY-MM-DD' of a Postgres DATE value. pg hands DATE columns
  // over as Date objects at local midnight, so the local calendar parts are
  // the true day (same idiom as the shadow drafter's formatEtDate); strings
  // pass through their date prefix. Never treat these as instants — a UTC
  // reparse shifts the day.
  calendarDay(value) {
    if (!value) return null;
    if (value instanceof Date) {
      const pad = (n) => String(n).padStart(2, '0');
      return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;
    }
    const m = /^(\d{4}-\d{2}-\d{2})/.exec(String(value));
    return m ? m[1] : null;
  }

  // The arrival window lives in window_start (Postgres `time`, ET wall-clock
  // strings like '13:00:00') on nearly every row — booking and admin-schedule
  // both write it, while window_display is set by only a few legacy paths
  // (1 of 545 upcoming in prod). The CUSTOMER-FACING window is ALWAYS
  // window_start + 2 hours (owner directive; see utils/sms-time-format.js) —
  // window_end is the internal job-duration block that drives scheduling and
  // must never be quoted to a customer. Everything this context feeds is a
  // customer-facing SMS surface, so derive start+2h here; time_window
  // ('morning'/'afternoon') is the coarse fallback.
  deriveWindow(s) {
    // window_start derivation comes FIRST (Codex P2): some writers (e.g. the
    // call processor's phone-booking path) set window_display to a bare start
    // time like '9:00 AM' alongside window_start — letting a display string
    // short-circuit would quote a point time instead of the required 2-hour
    // window. window_display only speaks when there is no derivable start.
    const range = arrivalWindowRange((s.window_start || '').toString());
    if (range) {
      const [rs, re] = range.split('-');
      return `${this.formatClockTime(rs)}–${this.formatClockTime(re)}`;
    }
    const display = (s.window_display || '').toString().trim();
    if (display) return display;
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
