jest.mock('../models/db', () => jest.fn());
jest.mock('../services/sendgrid-mail', () => ({
  newsletterGroupId: jest.fn(() => 101),
  serviceGroupId: jest.fn(() => 202),
}));

const EmailTemplates = require('../services/email-template-library');
const seed = require('../models/migrations/20260521000001_seed_late_payment_email_templates');

function renderSeedTemplate(key, payloadOverrides = {}) {
  const templateSeed = seed.__private.TEMPLATES.find((t) => t.key === key);
  const template = {
    id: `tmpl-${key}`,
    ...seed.__private.templateRow(templateSeed),
  };
  const version = {
    id: `ver-${key}`,
    subject: templateSeed.subject,
    preview_text: templateSeed.preview,
    blocks: templateSeed.blocks,
    text_body: '',
  };
  return EmailTemplates.renderTemplate({
    template,
    version,
    payload: {
      first_name: 'Taylor',
      invoice_title: 'Quarterly Pest Control',
      pay_url: 'https://portal.wavespestcontrol.com/pay/sample',
      amount_due: '$129.00',
      due_date: 'May 19, 2026',
      ...payloadOverrides,
    },
  });
}

describe('late-payment email template seeds', () => {
  test('defines the five editable billing/service templates with the expected variable contract', () => {
    const keys = seed.__private.TEMPLATES.map((t) => t.key);

    expect(keys).toEqual([
      'billing_late_payment_7_day',
      'billing_late_payment_14_day',
      'billing_late_payment_30_day',
      'billing_late_payment_60_day',
      'billing_late_payment_90_day',
    ]);

    for (const templateSeed of seed.__private.TEMPLATES) {
      const row = seed.__private.templateRow(templateSeed);
      expect(row).toMatchObject({
        mode: 'service',
        purpose: 'billing',
        audience: 'customer',
        send_stream: 'transactional_required',
        suppression_group_key: 'transactional_required',
        status: 'active',
      });
      expect(JSON.parse(row.allowed_variables)).toEqual(seed.__private.VARIABLES);
      expect(JSON.parse(row.required_variables)).toEqual(seed.__private.REQUIRED);
      expect(JSON.parse(row.optional_variables)).toEqual(seed.__private.OPTIONAL);
    }
  });

  test('renders with missing optional variables without crashing or leaking empty invoice labels', () => {
    const rendered = renderSeedTemplate('billing_late_payment_7_day');

    expect(rendered.missingPayload).toEqual([]);
    expect(rendered.validation.ok).toBe(true);
    expect(rendered.text).toContain('Amount due: $129.00');
    expect(rendered.text).toContain('Due date: May 19, 2026');
    expect(rendered.text).not.toContain('Invoice #:');
    expect(rendered.text).toContain('Pay invoice: https://portal.wavespestcontrol.com/pay/sample');
  });

  test('uses important reminder language at 30 days and final notice language only at 90 days', () => {
    const day30 = renderSeedTemplate('billing_late_payment_30_day', {
      service_date_clause: ' completed on May 12, 2026',
    });
    const day90 = renderSeedTemplate('billing_late_payment_90_day', {
      service_date_clause: ' completed on May 12, 2026',
    });

    expect(day30.subject).toBe('Important: your Waves account has a past-due balance');
    expect(day30.text).not.toMatch(/final reminder/i);
    expect(day30.text).not.toMatch(/final notice/i);
    expect(day90.subject).toBe('Final notice: Waves invoice 90 days overdue');
    expect(day90.text).toMatch(/final notice/i);
  });
});
