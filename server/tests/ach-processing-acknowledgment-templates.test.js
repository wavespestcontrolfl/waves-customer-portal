jest.mock('../models/db', () => jest.fn());
jest.mock('../services/sendgrid-mail', () => ({
  newsletterGroupId: jest.fn(() => 101),
  serviceGroupId: jest.fn(() => 202),
}));

const EmailTemplates = require('../services/email-template-library');
const seed = require('../models/migrations/20260522000002_seed_ach_processing_acknowledgment_templates');

describe('ach processing acknowledgment template seeds', () => {
  test('defines an SMS template with billing category and required vars', () => {
    const sms = seed.__private.SMS_TEMPLATE;
    expect(sms.template_key).toBe('ach_payment_processing');
    expect(sms.category).toBe('billing');
    expect(sms.variables).toEqual(expect.arrayContaining(['first_name', 'invoice_number']));
    expect(sms.body).toMatch(/{first_name}/);
    expect(sms.body).toMatch(/{invoice_number}/);
    expect(sms.body).toMatch(/3-5 business days/i);
  });

  test('defines an email template with the transactional-required suppression group', () => {
    const email = seed.__private.EMAIL_TEMPLATE;
    expect(email.key).toBe('payment.ach_processing');
    expect(email.required).toEqual(['first_name']);
    expect(email.optional).toEqual(expect.arrayContaining([
      'invoice_title',
      'invoice_number',
      'amount_paid',
      'payment_initiated_date',
      'expected_clear_date',
    ]));
    expect(email.blocks.some(b => /3-5 business days/i.test(b.content || ''))).toBe(true);
  });

  test('renders the email template cleanly with the happy-path preview payload', () => {
    const t = seed.__private.EMAIL_TEMPLATE;
    const template = {
      id: 'tmpl-payment.ach_processing',
      template_key: t.key,
    };
    const version = {
      id: 'ver-payment.ach_processing',
      subject: t.subject,
      preview_text: t.preview,
      blocks: t.blocks,
      text_body: '',
    };
    const rendered = EmailTemplates.renderTemplate({
      template,
      version,
      payload: seed.__private.PREVIEW_PAYLOAD,
    });

    expect(rendered.subject).toBe('We received your bank payment - processing');
    expect(rendered.missingPayload).toEqual([]);
    expect(rendered.validation.ok).toBe(true);
    expect(rendered.text).not.toMatch(/\{\{|\}\}/);
    expect(rendered.text).toContain('Stan');
    expect(rendered.text).toContain('WPC-2026-0091');
    expect(rendered.text).toContain('$117.00');
  });

  test('handles missing optional fields without leaking raw placeholders', () => {
    const t = seed.__private.EMAIL_TEMPLATE;
    const template = { id: 'tmpl', template_key: t.key };
    const version = {
      id: 'ver', subject: t.subject, preview_text: t.preview, blocks: t.blocks, text_body: '',
    };
    const rendered = EmailTemplates.renderTemplate({
      template,
      version,
      payload: {
        ...seed.__private.PREVIEW_PAYLOAD,
        invoice_number: '',
        amount_paid: '',
        expected_clear_date: '',
      },
    });

    expect(rendered.text).not.toMatch(/\{\{|\}\}/);
  });
});
