jest.mock('../models/db', () => jest.fn());
jest.mock('../services/sendgrid-mail', () => ({
  newsletterGroupId: jest.fn(() => 101),
  serviceGroupId: jest.fn(() => 202),
}));

const EmailTemplates = require('../services/email-template-library');
const seed = require('../models/migrations/20260521000003_seed_account_membership_email_templates');

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

describe('account and membership email template seeds', () => {
  test('defines editable transactional account and membership templates', () => {
    const keys = seed.__private.TEMPLATES.map((t) => t.key);

    expect(keys).toEqual([
      'account.updated',
      'account.request_received',
      'account.request_updated',
      'membership.started',
      'membership.updated',
      'membership.renewal_reminder',
      'membership.canceled',
      'membership.paused',
      'membership.reactivated',
    ]);

    for (const templateSeed of seed.__private.TEMPLATES) {
      const row = seed.__private.templateRow(templateSeed);
      const allowed = JSON.parse(row.allowed_variables);

      expect(row).toMatchObject({
        mode: 'service',
        audience: 'customer',
        send_stream: 'transactional_required',
        suppression_group_key: 'transactional_required',
        status: 'active',
      });
      expect(['account', 'membership']).toContain(row.purpose);
      expect(allowed).toEqual(expect.arrayContaining(seed.__private.SHARED_VARIABLES));
      expect(JSON.parse(row.required_variables)).toContain('first_name');
    }
  });

  test.each([
    ['account.updated', 'Your Waves account settings were updated'],
    ['account.request_received', 'We received your Waves request'],
    ['account.request_updated', 'Your Waves request was updated'],
    ['membership.started', 'Your Waves membership is active'],
    ['membership.updated', 'Your Waves membership was updated'],
    ['membership.renewal_reminder', 'Your Waves membership renewal is coming up'],
    ['membership.canceled', 'Your Waves membership has been canceled'],
    ['membership.paused', 'Your Waves service is paused'],
    ['membership.reactivated', 'Your Waves service is active again'],
  ])('renders %s with sample preview data', (key, subject) => {
    const rendered = renderSeedTemplate(key);

    expect(rendered.subject).toBe(subject);
    expect(rendered.missingPayload).toEqual([]);
    expect(rendered.validation.ok).toBe(true);
    expect(rendered.text).not.toMatch(/\{\{|\}\}/);
    expect(rendered.html).toContain('waves-logo-2026.png');
  });

  test('account.updated handles a 72-hour reminder toggle without raw placeholders', () => {
    const rendered = renderSeedTemplate('account.updated', {
      change_summary: 'Your 72-Hour Appointment Reminder was turned off.',
      changed_items_summary: '72-Hour Appointment Reminder: On to Off',
      property_label: '',
    });

    expect(rendered.text).toContain('72-Hour Appointment Reminder: On to Off');
    expect(rendered.text).not.toMatch(/\{\{|\}\}/);
  });

  test('membership renewal copy does not require optional renewal details', () => {
    const rendered = renderSeedTemplate('membership.renewal_reminder', {
      renewal_date: '',
      renewal_notice_window: '',
      last_service_date: '',
      monthly_rate: '',
    });

    expect(rendered.missingPayload).toEqual([]);
    expect(rendered.text).not.toContain('Renewal date:');
    expect(rendered.text).not.toContain('Notice window:');
    expect(rendered.text).not.toContain('Last scheduled service:');
    expect(rendered.text).not.toMatch(/\{\{|\}\}/);
  });
});
