/**
 * Non-blocking customer email polish.
 *
 * Keeps active copy stable while making review/default renders show full-year
 * estimate dates and action-specific customer links for estimate, invoice,
 * receipt, payment, and report CTAs.
 */

const ESTIMATE_URL = 'https://portal.wavespestcontrol.com/estimate/est_2026_1042';
const PAY_URL = 'https://portal.wavespestcontrol.com/pay/inv_2026_1042';
const RECEIPT_URL = 'https://portal.wavespestcontrol.com/receipt/inv_2026_1042';
const SERVICE_REPORT_URL = 'https://portal.wavespestcontrol.com/report/6f2e4c8a90b14d7ea6c3f9d812345678';
const PROJECT_REPORT_URL = 'https://portal.wavespestcontrol.com/report/project/taylor-morgan-6f2e4c8a90b1';

const ESTIMATE_TEMPLATES = [
  'estimate.delivery',
  'estimate.unviewed_followup',
  'estimate.viewed_followup',
  'estimate.followup_final',
];

const INVOICE_TEMPLATES = [
  'invoice.sent',
  'payment.failed',
  'payment.retry_notice',
  'billing_late_payment_7_day',
  'billing_late_payment_14_day',
  'billing_late_payment_30_day',
  'billing_late_payment_60_day',
  'billing_late_payment_90_day',
];

const FIXTURE_PATCHES = {
  ...Object.fromEntries(ESTIMATE_TEMPLATES.map((key) => [key, { estimate_url: ESTIMATE_URL }])),
  'estimate.expiring_notice': {
    estimate_url: ESTIMATE_URL,
    expires_at: 'June 12, 2026',
  },
  'estimate.extension_notice': {
    estimate_url: ESTIMATE_URL,
    new_expires_at: 'June 19, 2026',
  },
  ...Object.fromEntries(INVOICE_TEMPLATES.map((key) => [key, {
    invoice_url: PAY_URL,
    payment_url: PAY_URL,
    pay_url: PAY_URL,
  }])),
  'invoice.receipt': {
    receipt_url: RECEIPT_URL,
  },
  'service.report_ready': {
    report_url: SERVICE_REPORT_URL,
  },
  'project.report_ready': {
    report_url: PROJECT_REPORT_URL,
  },
};

function parsePayload(value) {
  if (!value) return {};
  if (typeof value === 'string') {
    try {
      return JSON.parse(value) || {};
    } catch {
      return {};
    }
  }
  return value;
}

exports.up = async function up(knex) {
  const hasTemplates = await knex.schema.hasTable('email_templates');
  const hasFixtures = await knex.schema.hasTable('email_template_fixtures');
  if (!hasTemplates || !hasFixtures) return;

  for (const [templateKey, patch] of Object.entries(FIXTURE_PATCHES)) {
    const template = await knex('email_templates').where({ template_key: templateKey }).first();
    if (!template) continue;

    const fixture = await knex('email_template_fixtures')
      .where({ template_id: template.id, is_default: true })
      .first();

    if (!fixture) {
      await knex('email_template_fixtures').insert({
        template_id: template.id,
        name: 'Happy path',
        payload: JSON.stringify({ first_name: 'Taylor', ...patch }),
        is_default: true,
      });
      continue;
    }

    const payload = parsePayload(fixture.payload);
    await knex('email_template_fixtures').where({ id: fixture.id }).update({
      payload: JSON.stringify({ ...payload, ...patch }),
      updated_at: new Date(),
    });
  }
};

exports.down = async function down() {
  // Review fixture polish is intentionally retained.
};
