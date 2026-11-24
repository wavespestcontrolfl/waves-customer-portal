/**
 * Approve a standard recurring plan with preferred days instead of a time slot
 * (GATE_ESTIMATE_APPROVE_PREFERRED_TIME, owner 2026-11-23 "do all").
 *
 * The estimate page shows the time picker first. Under it, a customer whose
 * times do not work can approve now and give the days (Mon to Sat) and a part
 * of the day (morning, afternoon or either) that suit them, plus an optional
 * short note. The accept stores that on the estimate and the office gets ONE
 * admin notification to book the first visit. No visit is auto-scheduled for
 * this accept (the route passes skipAutoSchedule), so nothing tells the
 * customer a date the office has not set.
 *
 * Nothing here texts, emails or calls a customer. Annual prepay, one-time
 * accepts, invoice-mode and commercial accepts keep requiring their own steps:
 * the route refuses a preferred time on those shapes.
 *
 * Storage: estimates.estimate_data.acceptPreferredTime (jsonb key, no
 * migration). Alert: raiseAdminAlert('estimate', ...), one row per estimate.
 */

const logger = require('./logger');

const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const DAY_LABELS = { mon: 'Mon', tue: 'Tue', wed: 'Wed', thu: 'Thu', fri: 'Fri', sat: 'Sat' };
const WINDOWS = ['morning', 'afternoon', 'either'];
const MAX_NOTE_CHARS = 300;

const INVALID_MESSAGE = 'Please pick at least one day that works for you, and whether mornings or afternoons are better.';

/**
 * Validate and normalize the customer's `preferredTime` request body.
 * Returns { ok: true, value } or { ok: false, error }. Unknown days are
 * refused (never silently dropped); days come back in week order, deduped.
 */
function normalizePreferredTime(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: INVALID_MESSAGE };
  const days = Array.isArray(raw.days) ? raw.days.map((d) => String(d || '').trim().toLowerCase()) : [];
  if (!days.length || days.some((d) => !DAYS.includes(d))) return { ok: false, error: INVALID_MESSAGE };
  const window = typeof raw.window === 'string' ? raw.window.trim().toLowerCase() : '';
  if (!WINDOWS.includes(window)) return { ok: false, error: INVALID_MESSAGE };
  const note = typeof raw.note === 'string'
    ? raw.note.replace(/\s+/g, ' ').trim().slice(0, MAX_NOTE_CHARS)
    : '';
  return {
    ok: true,
    value: { days: DAYS.filter((d) => days.includes(d)), window, ...(note ? { note } : {}) },
  };
}

// "Mon, Wed, Fri mornings" / "any day Mon to Sat, either" read for the office.
function describePreferredTime({ days = [], window = 'either' } = {}) {
  const dayText = days.length === DAYS.length ? 'Any day Mon to Sat' : days.map((d) => DAY_LABELS[d] || d).join(', ');
  const part = { morning: 'mornings', afternoon: 'afternoons', either: 'mornings or afternoons' }[window] || 'any time of day';
  return `${dayText}, ${part}`;
}

/**
 * The ONE office alert to book the first visit. Never throws: a failed alert
 * must not undo an accept that already committed. Deduped per estimate, so a
 * retry never rings twice. Returns true when a row exists for the estimate.
 */
async function raisePreferredTimeAlert({ estimate, customerId = null, preferredTime, serviceLabel = null, invoiceHeld = false }) {
  try {
    const { fitAction, redactedWords } = require('./admin-alert-names');
    const { raiseAdminAlert, cutAtWord } = require('./admin-alert-compose');
    const link = customerId
      ? `/admin/customers?customerId=${encodeURIComponent(customerId)}`
      : `/admin/estimates?estimateId=${encodeURIComponent(estimate.id)}`;
    const when = describePreferredTime(preferredTime);
    const note = preferredTime.note ? redactedWords(preferredTime.note) : '';
    const plan = String(serviceLabel || '').trim();
    const detail = [
      `${estimate.customer_name || 'The customer'} approved${plan ? ` ${plan}` : ' the plan'} on the estimate page without picking a time. No visit is booked and nothing was auto-scheduled.`,
      `Preferred days and time: ${when}.`,
      note ? `Their note: “${note}”` : null,
      invoiceHeld ? 'The setup and first-application invoice is created but NOT sent, so no pay link names a date. Send it once the visit is booked.' : null,
      `Estimate: /admin/estimates?estimateId=${estimate.id}`,
      'Book the first visit, then call or text them to confirm. The page and the emails promise no date.',
    ].filter(Boolean).join('\n');
    const filed = await raiseAdminAlert('estimate', {
      area: 'Schedule',
      action: fitAction('Schedule', estimate.customer_name || 'this customer', [
        (n) => `book ${n}'s first visit`,
        (n) => `book ${n}`,
      ]),
      why: cutAtWord(`Approved with no time picked; prefers ${when}.`, 110),
      severity: 'needs-you',
      link,
      subject: { type: 'estimate', id: String(estimate.id) },
      doneWhen: 'visit_booked',
      who: 'person',
      contact: true,
    }, {
      bell: true,
      dedupeKey: `estimate-preferred-time:${estimate.id}`,
      detail,
      metadata: { estimateId: String(estimate.id), customerId: customerId ? String(customerId) : null, source: 'estimate_preferred_time' },
    });
    return !!(filed && filed.id != null && filed.suppressed !== true);
  } catch (err) {
    logger.error(`[estimate-preferred-time] office alert failed for estimate ${estimate?.id}: ${err.message}`);
    return false;
  }
}

module.exports = { DAYS, WINDOWS, MAX_NOTE_CHARS, normalizePreferredTime, describePreferredTime, raisePreferredTimeAlert };
