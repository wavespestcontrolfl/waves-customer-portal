/**
 * Consent provenance for the collections contact policy (PR A — policy +
 * shadow only; nothing here dials or messages anyone).
 *
 * "May we place an automated voice call to this number?" needs EVIDENCE that
 * the number belongs to this customer and that they initiated contact with
 * Waves Pest Control on it. This module derives that evidence from EXISTING
 * tables only — it creates no new consent store:
 *
 *   1. inbound_sms   — an inbound sms_log row from the number (strongest:
 *                      the customer texted us from it)
 *   2. inbound_call  — an inbound call_log row from the number
 *   3. lead_form     — a leads row carrying the number (form/booking intake)
 *
 * A portal-session arm was considered and SKIPPED: the customer portal has no
 * customer-keyed session/last-login trace (technicians.last_login_at is
 * admin-side only), so there is nothing to read. If such a trace ships later,
 * add it between inbound_call and lead_form.
 *
 * ERROR POLICY: FAIL CLOSED. Reads here gate an outbound voice contact, so a
 * DB error THROWS to the caller (contact-policy converts any throw into a
 * denial) rather than degrading to a weaker arm or to "no evidence" — a
 * half-answered query must never be mistaken for a definitive verdict.
 */

const db = require('../../models/db');

// Mirror send-customer-message/line-type normalization so the same number
// matches regardless of which rail stored it.
function normalizeE164(phone) {
  if (!phone) return null;
  const trimmed = String(phone).trim();
  if (!trimmed) return null;
  const digits = trimmed.replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  if (trimmed.startsWith('+')) return trimmed;
  return trimmed;
}

// The storage variants a US number appears under across sms_log / call_log /
// leads (E.164, bare 10-digit, 1-prefixed 11-digit).
function phoneVariants(phone) {
  const e164 = normalizeE164(phone);
  if (!e164) return [];
  const digits = e164.replace(/\D/g, '');
  const last10 = digits.slice(-10);
  const variants = new Set([e164]);
  if (last10.length === 10) {
    variants.add(last10);
    variants.add(`1${last10}`);
    variants.add(`+1${last10}`);
  }
  return [...variants];
}

async function latestInboundSms(customerId, variants) {
  return db('sms_log')
    .where({ customer_id: customerId, direction: 'inbound' })
    .whereIn('from_phone', variants)
    .orderBy('created_at', 'desc')
    .first('id', 'created_at');
}

async function latestInboundCall(customerId, variants) {
  return db('call_log')
    .where({ customer_id: customerId, direction: 'inbound' })
    .whereIn('from_phone', variants)
    .orderBy('created_at', 'desc')
    .first('id', 'created_at');
}

// Lead rows only count as consent evidence when the CUSTOMER originated the
// contact (codex 2026-08-14 P1): staff-created rows (admin manual entry,
// tech field observations, tech-run lawn diagnostics) prove a staffer typed
// a number, not that its owner ever reached out to Waves Pest Control.
// Allowlist drawn from the live leads.first_contact_channel vocabulary —
// admin-leads.js writes 'manual', tech-field-lead.js 'field_observation',
// tech-lawn-diagnostic.js 'lawn_diagnostic' (all staff-side, excluded);
// the customer-originated intakes below are the web/booking/quote forms,
// the public photo funnels, inbound call/sms/email, and chat. Unknown or
// novel channels are NOT evidence (fail closed at the query).
const CUSTOMER_ORIGINATED_LEAD_CHANNELS = [
  'web',
  'form',
  'booking',
  'website_quote',
  'lawn_diagnostic_report', // public self-serve funnel (vs tech-run 'lawn_diagnostic')
  'pest_identifier_funnel',
  'lawn_assessment_funnel',
  'call',
  'sms',
  'chat',
  'email',
];

async function latestLeadWithPhone(customerId, variants) {
  return db('leads')
    .where({ customer_id: customerId })
    .whereIn('phone', variants)
    .whereIn('first_contact_channel', CUSTOMER_ORIGINATED_LEAD_CHANNELS)
    .orderBy('created_at', 'desc')
    .first('id', 'created_at', 'first_contact_at');
}

/**
 * Strongest-first consent evidence for calling `phone` about this customer's
 * account, or null when no arm has evidence. Shape:
 *   { source: 'inbound_sms'|'inbound_call'|'lead_form',
 *     evidenceRef: <row id>, evidenceAt: <Date> }
 */
async function resolve(customerId, phone) {
  const variants = phoneVariants(phone);
  if (!customerId || !variants.length) return null;

  const sms = await latestInboundSms(customerId, variants);
  if (sms) return { source: 'inbound_sms', evidenceRef: sms.id, evidenceAt: sms.created_at };

  const call = await latestInboundCall(customerId, variants);
  if (call) return { source: 'inbound_call', evidenceRef: call.id, evidenceAt: call.created_at };

  const lead = await latestLeadWithPhone(customerId, variants);
  if (lead) {
    return {
      source: 'lead_form',
      evidenceRef: lead.id,
      evidenceAt: lead.first_contact_at || lead.created_at,
    };
  }

  return null;
}

/**
 * The most recent CUSTOMER-INITIATED contact from `phone` (inbound SMS,
 * inbound call, or lead intake) — the timestamp the reassigned-number
 * staleness rule runs against. Returns a Date, or null when the number has
 * never contacted us (which the policy treats as requiring an RND check —
 * the RND query itself is PR B / manual).
 */
async function freshness(customerId, phone) {
  const variants = phoneVariants(phone);
  if (!customerId || !variants.length) return null;

  const stamps = [];
  const sms = await latestInboundSms(customerId, variants);
  if (sms?.created_at) stamps.push(new Date(sms.created_at));
  const call = await latestInboundCall(customerId, variants);
  if (call?.created_at) stamps.push(new Date(call.created_at));
  const lead = await latestLeadWithPhone(customerId, variants);
  const leadAt = lead?.first_contact_at || lead?.created_at;
  if (leadAt) stamps.push(new Date(leadAt));

  const valid = stamps.filter((d) => !Number.isNaN(d.getTime()));
  if (!valid.length) return null;
  return new Date(Math.max(...valid.map((d) => d.getTime())));
}

module.exports = {
  resolve,
  freshness,
  normalizeE164,
  phoneVariants,
  CUSTOMER_ORIGINATED_LEAD_CHANNELS,
};
