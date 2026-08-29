jest.mock('../models/db', () => jest.fn());
jest.mock('../services/sendgrid-mail', () => ({
  newsletterGroupId: jest.fn(() => 101),
  serviceGroupId: jest.fn(() => 202),
}));

const EmailTemplates = require('../services/email-template-library');
const seed = require('../models/migrations/20260828000002_seed_payment_method_removal_email_templates');

function renderSeedTemplate(key, payloadOverrides = {}) {
  const templateSeed = seed.__private.TEMPLATES.find((t) => t.key === key);
  const template = { id: `tmpl-${key}`, ...seed.__private.templateRow(templateSeed) };
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
    payload: { ...seed.__private.PREVIEW_PAYLOAD, ...payloadOverrides },
  });
}

describe('payment method removal / autopay disabled template seeds', () => {
  test('defines the two negative lifecycle templates on the required transactional stream', () => {
    expect(seed.__private.TEMPLATES.map((t) => t.key)).toEqual(['payment.autopay_disabled', 'payment.method_removed']);
    for (const t of seed.__private.TEMPLATES) {
      const row = seed.__private.templateRow(t);
      expect(row).toMatchObject({
        mode: 'service',
        purpose: 'payment',
        audience: 'customer',
        send_stream: 'transactional_required',
        suppression_group_key: 'transactional_required',
        status: 'active',
      });
      expect(JSON.parse(row.required_variables)).toEqual(['first_name']);
      expect(JSON.parse(row.allowed_variables)).toEqual(expect.arrayContaining(seed.__private.SHARED_VARIABLES));
    }
  });

  test.each([
    ['payment.autopay_disabled', 'Auto Pay is now off for your Waves account'],
    ['payment.method_removed', 'A payment method was removed from your Waves account'],
  ])('renders %s with sample data and no leaked placeholders', (key, subject) => {
    const rendered = renderSeedTemplate(key);
    expect(rendered.subject).toBe(subject);
    expect(rendered.missingPayload).toEqual([]);
    expect(rendered.validation.ok).toBe(true);
    expect(rendered.text).not.toMatch(/\{\{|\}\}/);
    expect(rendered.text).toContain('Visa ending in 4242');
  });

  test('method_removed carries the Auto Pay note only when the removal turned Auto Pay off', () => {
    const withNote = renderSeedTemplate('payment.method_removed', {
      autopay_removed_note: 'Auto Pay was turned off because it was using this payment method.',
    });
    expect(withNote.text).toContain('Auto Pay was turned off because it was using this payment method.');
    const without = renderSeedTemplate('payment.method_removed', { autopay_removed_note: '' });
    expect(without.text).not.toContain('Auto Pay was turned off');
    expect(without.validation.ok).toBe(true);
  });
});
