jest.mock('../models/db', () => jest.fn());
jest.mock('../services/sendgrid-mail', () => ({
  newsletterGroupId: jest.fn(() => 101),
  serviceGroupId: jest.fn(() => 202),
}));

const EmailTemplates = require('../services/email-template-library');
const seed = require('../models/migrations/20260521000002_seed_payment_lifecycle_email_templates');

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
      ...seed.__private.PREVIEW_PAYLOAD,
      ...payloadOverrides,
    },
  });
}

describe('payment lifecycle email template seeds', () => {
  test('defines the six editable payment/service templates with transactional metadata', () => {
    const keys = seed.__private.TEMPLATES.map((t) => t.key);

    expect(keys).toEqual([
      'payment.autopay_enabled',
      'payment.method_updated',
      'payment.method_expiring',
      'payment.retry_notice',
      'payment.plan_confirmed',
      'payment.refund_issued',
    ]);

    for (const templateSeed of seed.__private.TEMPLATES) {
      const row = seed.__private.templateRow(templateSeed);
      const allowed = JSON.parse(row.allowed_variables);

      expect(row).toMatchObject({
        mode: 'service',
        purpose: 'payment',
        audience: 'customer',
        send_stream: 'transactional_required',
        suppression_group_key: 'transactional_required',
        status: 'active',
      });
      expect(allowed).toEqual(expect.arrayContaining(seed.__private.SHARED_VARIABLES));
      expect(JSON.parse(row.required_variables)).toEqual(['first_name']);
    }
  });

  test.each([
    ['payment.autopay_enabled', 'Autopay is now active for your Waves account'],
    ['payment.method_updated', 'Your Waves payment method was updated'],
    ['payment.method_expiring', 'Your Waves payment method is expiring soon'],
    ['payment.retry_notice', "We'll retry your Waves payment soon"],
    ['payment.plan_confirmed', 'Your Waves payment plan is confirmed'],
    ['payment.refund_issued', 'Your Waves refund has been issued'],
  ])('renders %s with sample preview data', (key, subject) => {
    const rendered = renderSeedTemplate(key);

    expect(rendered.subject).toBe(subject);
    expect(rendered.missingPayload).toEqual([]);
    expect(rendered.validation.ok).toBe(true);
    expect(rendered.text).not.toMatch(/\{\{|\}\}/);
    expect(rendered.html).toContain('waves-logo-2026.png');
  });

  test('handles missing optional URLs and values without leaking raw placeholders', () => {
    const rendered = renderSeedTemplate('payment.method_expiring', {
      customer_portal_url: '',
      payment_method_brand: '',
      payment_method_last4: '',
      payment_method_label: 'your saved payment method',
      expiration_month: '',
      expiration_year: '',
      expiration_label: '',
    });

    expect(rendered.missingPayload).toEqual([]);
    expect(rendered.text).toContain('Payment method: your saved payment method');
    expect(rendered.text).not.toContain('Expiration:');
    expect(rendered.text).not.toContain('Update payment method:');
    expect(rendered.text).not.toMatch(/\{\{|\}\}/);
  });

  test('refund copy never exposes processor identifiers from preview payload', () => {
    const rendered = renderSeedTemplate('payment.refund_issued');

    expect(rendered.text).toContain('Refund amount: $49.00');
    expect(rendered.text).not.toMatch(/pm_|pi_|ch_|tok_/);
  });
});
