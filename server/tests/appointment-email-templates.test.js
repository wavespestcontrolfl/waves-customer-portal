jest.mock('../models/db', () => jest.fn());
jest.mock('../services/sendgrid-mail', () => ({
  newsletterGroupId: jest.fn(() => 101),
  serviceGroupId: jest.fn(() => 202),
}));

const EmailTemplates = require('../services/email-template-library');
const seed = require('../models/migrations/20260616000002_seed_appointment_email_templates');

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

describe('appointment email template seeds', () => {
  test('defines the four appointment fallback templates as required transactional notices', () => {
    const keys = seed.__private.TEMPLATES.map((t) => t.key);
    expect(keys).toEqual([
      'appointment.confirmation',
      'appointment.reminder_72h',
      'appointment.reminder_24h',
      'appointment.en_route',
    ]);

    for (const templateSeed of seed.__private.TEMPLATES) {
      const row = seed.__private.templateRow(templateSeed);
      const allowed = JSON.parse(row.allowed_variables);

      expect(row).toMatchObject({
        mode: 'service',
        audience: 'customer',
        purpose: 'appointment',
        send_stream: 'transactional_required',
        suppression_group_key: 'transactional_required',
        status: 'active',
      });
      expect(allowed).toEqual(expect.arrayContaining(seed.__private.SHARED_VARIABLES));
      expect(JSON.parse(row.required_variables)).toContain('first_name');
    }
  });

  test.each([
    ['appointment.confirmation', 'Your Waves appointment is confirmed'],
    ['appointment.reminder_72h', 'Reminder: your Waves appointment is coming up'],
    ['appointment.reminder_24h', 'Reminder: your Waves appointment is tomorrow'],
    ['appointment.en_route', 'Your Waves technician is on the way'],
  ])('renders %s with sample preview data', (key, subject) => {
    const rendered = renderSeedTemplate(key);

    expect(rendered.subject).toBe(subject);
    expect(rendered.missingPayload).toEqual([]);
    expect(rendered.validation.ok).toBe(true);
    expect(rendered.text).not.toMatch(/\{\{|\}\}/);
    expect(rendered.html).toContain('waves-logo');
  });

  test('confirmation renders without optional schedule details and no raw placeholders', () => {
    const rendered = renderSeedTemplate('appointment.confirmation', {
      appointment_day: '',
      appointment_date: '',
      appointment_time: '',
      property_label: '',
    });

    expect(rendered.missingPayload).toEqual([]);
    expect(rendered.text).toContain('Quarterly Pest Control');
    expect(rendered.text).not.toContain('Day:');
    expect(rendered.text).not.toContain('Scheduled start:');
    expect(rendered.text).not.toMatch(/\{\{|\}\}/);
  });

  test('en-route renders the ETA fallback wording without raw placeholders', () => {
    const rendered = renderSeedTemplate('appointment.en_route', {
      eta_minutes: 'a few',
    });

    expect(rendered.text).toContain('a few minutes');
    expect(rendered.text).not.toMatch(/\{\{|\}\}/);
  });
});
