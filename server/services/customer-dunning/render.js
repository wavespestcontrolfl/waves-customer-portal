'use strict';

/**
 * Message bodies and template probes for customer-level reminders (§5 step
 * 9b, step 8). `multi` uses the six combined templates frozen in migration
 * 20260928060000; `single` (the set dropped to one invoice) uses today's
 * per-step templates with today's payload shape, so a promoted customer whose
 * balance shrinks reads exactly like a per-invoice reminder.
 *
 * A template is never substituted: an inactive/missing one drops its channel
 * before any reservation is written (probe), and a render that comes back
 * empty is a TEMPLATE_UNAVAILABLE non-send, never a fallback to other copy.
 *
 * Everything renders from the resolved `set` only. Copy says "open invoices",
 * never "overdue" (D7); SMS is unsigned, brand "Waves".
 */

const db = require('../../models/db');
const smsTemplatesRouter = require('../../routes/admin-sms-templates');
const EmailTemplateLibrary = require('../email-template-library');
const { currency } = require('../email-template');
const { formatDateOnly } = require('../../utils/date-only');
const { publicPortalUrl } = require('../../utils/portal-url');
const { FOLLOWUP_EMAIL_TEMPLATE_BY_STEP_ID } = require('../invoice-followups');

const firstToken = (value) => String(value || '').trim().split(/\s+/)[0] || '';
const dollars = (cents) => (Number(cents) / 100).toFixed(2);

function smsTemplateKey(step, kind) {
  return kind === 'multi' ? `invoice_followup_combined_${step.daysAfterSend}day` : step.template_key;
}

function emailTemplateKey(step, kind) {
  return kind === 'multi'
    ? `invoice.followup_combined_${step.daysAfterSend}_day`
    : FOLLOWUP_EMAIL_TEMPLATE_BY_STEP_ID[step.id] || null;
}

// A template row that is missing or switched off. `is_active === false` is the
// admin toggle getTemplate honours.
async function smsTemplateActive(key, database = db) {
  if (!key) return false;
  const row = await database('sms_templates').where({ template_key: key }).first('is_active');
  return !!row && row.is_active !== false;
}

async function emailTemplateActive(key, database = db) {
  if (!key) return false;
  const loaded = await EmailTemplateLibrary.loadTemplateByKey(key, database);
  if (!loaded?.template || !loaded.activeVersion) return false;
  return String(loaded.template.status || 'active').toLowerCase() === 'active';
}

/**
 * Drop every channel whose template for (step, kind) is unavailable.
 * push shares the SMS body.
 */
async function channelsWithTemplates(step, kind, channels, database = db) {
  const smsOk = channels.includes('sms') || channels.includes('push')
    ? await smsTemplateActive(smsTemplateKey(step, kind), database) : false;
  const emailOk = channels.includes('email') ? await emailTemplateActive(emailTemplateKey(step, kind), database) : false;
  return channels.filter((c) => (c === 'email' ? emailOk : smsOk));
}

function smsVars(kind, set, customer, payUrl) {
  const base = { first_name: firstToken(customer.first_name) || 'there', pay_url: payUrl || '' };
  if (kind === 'multi') {
    return { ...base, invoice_count: String(set.members.length), total_due: dollars(set.totalCents) };
  }
  const serviceDate = formatDateOnly(set.anchor.service_date, { fallback: '' });
  return {
    ...base,
    invoice_title: set.anchor.title || 'your service',
    amount: dollars(set.members[0].cents),
    receipt_url: payUrl || '',
    service_date: serviceDate,
    service_date_clause: serviceDate ? ` completed on ${serviceDate}` : '',
  };
}

/** SMS/push body for the set at `step`; null when the template will not render. */
async function renderSms({ step, set, customer, payUrl, database }) {
  const kind = set.kind;
  return smsTemplatesRouter.getTemplate(smsTemplateKey(step, kind), smsVars(kind, set, customer, payUrl), {
    workflow: 'invoice_followup_customer',
    entity_type: 'customer',
    entity_id: customer.id,
  }, database ? { database } : {}); // the same handle the template probe read
}

/** Email template key + payload for the set at `step`. */
function renderEmail({ step, set, customer, recipient, payUrl }) {
  const kind = set.kind;
  const firstName = firstToken(recipient?.name) || firstToken(customer.first_name) || 'there';
  const portal = `${publicPortalUrl()}/?tab=billing`;
  if (kind === 'multi') {
    return {
      templateKey: emailTemplateKey(step, kind),
      payload: {
        first_name: firstName,
        invoice_count: String(set.members.length),
        total_due: currency(Number(set.totalCents) / 100),
        pay_url: payUrl,
        customer_portal_url: portal,
      },
    };
  }
  const serviceDate = formatDateOnly(set.anchor.service_date, { fallback: '' });
  return {
    templateKey: emailTemplateKey(step, kind),
    payload: {
      first_name: firstName,
      invoice_title: set.anchor.title || 'your service',
      invoice_number: set.anchor.invoice_number || '',
      amount_due: currency(Number(set.members[0].cents) / 100),
      due_date: formatDateOnly(set.anchor.due_date, { fallback: '' }),
      service_date: serviceDate,
      service_date_clause: serviceDate ? ` completed on ${serviceDate}` : '',
      pay_url: payUrl,
      customer_portal_url: portal,
    },
  };
}

module.exports = {
  smsTemplateKey,
  emailTemplateKey,
  smsTemplateActive,
  emailTemplateActive,
  channelsWithTemplates,
  renderSms,
  renderEmail,
};
