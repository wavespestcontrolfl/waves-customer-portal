// Owner alerts that used to be texts to the owner's phone (owner-alert-sms scope, 2026-10-31).
//
// Each caller below sent TwilioService.sendSMS(ADAM_PHONE, ..., { messageType: 'internal_alert' }). Since about
// 2026-09-01 twilio.js turns that text into the internal_admin_alert trigger, and the 08-28 bell policy
// denylists the trigger: no text, no row, and the caller read success. The 7 AM credential check found an
// expired token on 2026-10-30 and nobody saw it.
//
// recordOwnerAlert composes the alert by the notification rule (composeAdminAlert, docs/admin-notifications.md)
// and writes it as an ops digest row (deliverOpsDigest, which writes through NotificationService.notifyAdmin)
// under a dedupe key, so a retry or a second process holds one row. Quiet by default (owner ruling 2026-08-28:
// only customer contact rings): audience 'fyi', so the row is Activity-only (Agents → Activity), never rings or
// counts in the bell, and the 7-day FYI expiry closes it; a needs-you kind is still listed by needs-me.
// A kind in RINGING_KINDS is written for the owner instead: it rings the bell when something new appears
// (ops-digest ring-only-on-change, judged on itemKeys). Which kinds ring is the owner's call.
//
// Sends no text and no email, to the owner or anyone else. Never throws outside tests (a rule violation
// throws under NODE_ENV=test, as raiseAdminAlert does, so a caller's own tests catch it). Logs carry the kind
// and rule names only, never the alert's text (it names customers).
const logger = require('./logger');
const { composeAdminAlert, validStructuredFields, cutAtWord, firstSentence, breaksAlertRules, MAX_HEADLINE_CHARS, MAX_WHY_CHARS } = require('./admin-alert-compose');

// kind -> the parts of the notification rule every alert of that kind shares. needs-you = a person has
// something to do (needs-me lists it, quiet or not); fyi = a report whose full text is also on its own page.
const OWNER_ALERT_KINDS = Object.freeze({
  'credential-check': Object.freeze({ area: 'System', severity: 'needs-you', doneWhen: 'credential_renewed' }),
  'inbound-text': Object.freeze({ area: 'Comms', severity: 'needs-you', doneWhen: 'text_answered' }),
  'ai-escalation': Object.freeze({ area: 'Comms', severity: 'needs-you', doneWhen: 'customer_answered' }),
  'overdue-visit': Object.freeze({ area: 'Billing', severity: 'needs-you', doneWhen: 'balance_paid' }),
  'self-booked': Object.freeze({ area: 'Schedule', severity: 'fyi', doneWhen: 'visit_reviewed' }),
  'self-rescheduled': Object.freeze({ area: 'Schedule', severity: 'fyi', doneWhen: 'visit_reviewed' }),
  'ads-daily-report': Object.freeze({ area: 'Leads', severity: 'fyi', doneWhen: 'report_read' }),
  'csr-weekly-tip': Object.freeze({ area: 'Comms', severity: 'fyi', doneWhen: 'report_read' }),
  'seo-rank-drops': Object.freeze({ area: 'Content', severity: 'fyi', doneWhen: 'report_read' }),
  'seo-toxic-links': Object.freeze({ area: 'Content', severity: 'fyi', doneWhen: 'report_read' }),
  'seo-competitor-gaps': Object.freeze({ area: 'Content', severity: 'fyi', doneWhen: 'report_read' }),
  'seo-weekly-report': Object.freeze({ area: 'Content', severity: 'fyi', doneWhen: 'report_read' }),
});

// The kinds the owner chose to ring. Empty until the owner picks (asked 2026-10-31).
const RINGING_KINDS = new Set([]);

// deliverOpsDigest falls back to email when the in-app row cannot be written. These alerts never had an
// email, so there is none to send: the fallback reports the miss and recordOwnerAlert logs it.
const noEmail = async () => ({ ok: false, error: 'owner alerts have no email path' });

// A why taken from model-written text (a report's assessment): its first sentence cut to fit, or none when
// it still breaks the rule. Only an fyi kind may go without a why.
function whyFromFreeText(text) {
  const why = cutAtWord(firstSentence(text), MAX_WHY_CHARS);
  return why && !breaksAlertRules(why) ? why : '';
}

// The composed headline, why and structured fields. A rule violation outside tests keeps the alert, cut to fit
// and stamped with the rules it broke (raiseAdminAlert's fallback); under NODE_ENV=test it throws.
function composeFor(kind, spec, { action, why = '', link, subject }) {
  const alert = { area: spec.area, action, why, severity: spec.severity, link, subject, doneWhen: spec.doneWhen, who: 'person' };
  try {
    return composeAdminAlert(alert);
  } catch (err) {
    if (!Array.isArray(err.violations) || process.env.NODE_ENV === 'test') throw err;
    logger.warn(`[owner-alerts] ${kind} broke the notification rule: ${err.violations.join(', ')}`);
    return {
      headline: cutAtWord(`${spec.area} — ${action}`, MAX_HEADLINE_CHARS),
      why: cutAtWord(firstSentence(why), MAX_WHY_CHARS),
      link: link || null,
      metadata: { ...validStructuredFields(alert), ruleViolations: err.violations },
    };
  }
}

// The deliverOpsDigest call: quiet (fyi audience, Activity only) unless the owner chose the kind to ring.
function digestFor(kind, spec, composed, { text, dedupeKey, itemKeys, metadata }) {
  const keys = Array.isArray(itemKeys) && itemKeys.length ? itemKeys.map(String) : null;
  return {
    key: `owner-alert:${kind}`,
    // The ACT prefix only sets the digest's kind (the Activity feed shows it as awaiting review).
    subject: `${spec.severity === 'needs-you' ? 'ACT: ' : ''}${composed.headline}`,
    headline: composed.headline,
    summary: composed.why || null,
    text: text || composed.why || composed.headline,
    link: composed.link,
    audience: RINGING_KINDS.has(kind) ? 'owner' : 'fyi',
    dedupeKey,
    ...(keys ? { itemKeys: keys, count: keys.length } : {}),
    metadata: { ...(metadata || {}), ...composed.metadata, ownerAlert: kind },
    sendEmail: noEmail,
  };
}

/**
 * @param {string} kind  a key of OWNER_ALERT_KINDS (sets area, severity and done-when)
 * @param {object} fields
 * @param {string} fields.action     what to do; the headline is `<Area> — <action>`, 60 chars at most
 * @param {string} [fields.why]      one sentence, 110 chars at most (required for a needs-you kind)
 * @param {string} fields.link       admin page that opens the work
 * @param {{type: string, id: string}} fields.subject  what the alert is about (docs/admin-notifications.md)
 * @param {string} [fields.text]     the full alert (what the text used to say)
 * @param {string} fields.dedupeKey  one row per key
 * @param {string[]} [fields.itemKeys]  record ids (never names or phones): a ringing kind rings when one is new
 * @param {object} [fields.metadata]  e.g. { customerId } so an internal test account's alert is dropped
 * @returns {Promise<{ ok: boolean, channel?: string, id?: string|null, error?: string }>}
 */
async function recordOwnerAlert(kind, fields = {}) {
  const spec = OWNER_ALERT_KINDS[kind];
  if (!spec || !fields.dedupeKey) {
    logger.error(`[owner-alerts] refused: ${spec ? 'no dedupe key' : 'unknown kind'} (${kind})`);
    return { ok: false, error: 'invalid owner alert' };
  }
  const composed = composeFor(kind, spec, fields);
  try {
    const result = await require('./ops-digest').deliverOpsDigest(digestFor(kind, spec, composed, fields));
    if (!result?.ok || result.channel !== 'in_app') logger.warn(`[owner-alerts] ${kind}: no row written`);
    return result;
  } catch (err) {
    // The code only: a database error can quote the row it refused, and the row names a customer.
    const code = (err && (err.code || err.name)) || 'error';
    logger.error(`[owner-alerts] ${kind}: write failed (${code})`);
    return { ok: false, error: code };
  }
}

// An urgent AI assistant hand-off (assistant.js, managed-assistant.js). One row per escalation; the model's
// reason and the customer's words go in the full text, never the why.
function recordUrgentEscalation({ customer, reason, customerMessage, conversationId, escalationId }) {
  const name = customer ? ([customer.first_name, customer.last_name].filter(Boolean).join(' ') || 'A customer') : 'A customer';
  const id = String(escalationId || conversationId);
  return recordOwnerAlert('ai-escalation', {
    action: 'answer an urgent assistant hand-off',
    why: `${name} asked the assistant for a person.`,
    link: customer?.id ? `/admin/customers?customerId=${encodeURIComponent(customer.id)}` : '/admin/communications',
    subject: customer?.id ? { type: 'customer', id: String(customer.id) } : { type: 'check', id: 'ai-escalation' },
    text: `AI Escalation (urgent)\n${name}\nReason: ${reason}\nMsg: "${String(customerMessage || '').substring(0, 100)}"`,
    dedupeKey: `owner-alert:ai-escalation:${id}`,
    itemKeys: [id],
    metadata: customer?.id ? { customerId: customer.id } : {},
  });
}

module.exports = { recordOwnerAlert, recordUrgentEscalation, whyFromFreeText, OWNER_ALERT_KINDS, RINGING_KINDS };
