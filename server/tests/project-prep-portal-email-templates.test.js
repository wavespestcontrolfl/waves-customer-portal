jest.mock('../models/db', () => jest.fn());
jest.mock('../services/sendgrid-mail', () => ({
  newsletterGroupId: jest.fn(() => 101),
  serviceGroupId: jest.fn(() => 202),
}));

const EmailTemplates = require('../services/email-template-library');
const seed = require('../models/migrations/20260521000004_seed_project_prep_portal_email_templates');

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

describe('prep and portal email template seeds', () => {
  test('defines editable prep and portal templates', () => {
    const keys = seed.__private.TEMPLATES.map((t) => t.key);

    expect(keys).toEqual([
      'prep.rodent',
      'prep.flea',
      'prep.mosquito',
      'prep.lawn',
      'prep.termite',
      'prep.interior_pest',
      'portal.invite',
    ]);

    for (const templateSeed of seed.__private.TEMPLATES) {
      const row = seed.__private.templateRow(templateSeed);
      const allowed = JSON.parse(row.allowed_variables);

      expect(row).toMatchObject({
        mode: 'service',
        audience: 'customer',
        status: 'active',
      });
      expect(['prep', 'account']).toContain(row.purpose);
      expect(allowed).toEqual(expect.arrayContaining(seed.__private.SHARED_VARIABLES));
      expect(JSON.parse(row.required_variables)).toContain('first_name');
    }
  });

  test('uses service-operational stream for prep guides', () => {
    const serviceTemplates = seed.__private.TEMPLATES.filter((t) => t.key !== 'portal.invite');

    for (const templateSeed of serviceTemplates) {
      const row = seed.__private.templateRow(templateSeed);
      expect(row).toMatchObject({
        send_stream: 'service_operational',
        suppression_group_key: 'service_operational',
      });
    }
  });

  test('uses required transactional stream for portal invites', () => {
    const row = seed.__private.templateRow(
      seed.__private.TEMPLATES.find((t) => t.key === 'portal.invite'),
    );

    expect(row).toMatchObject({
      purpose: 'account',
      send_stream: 'transactional_required',
      suppression_group_key: 'transactional_required',
    });
  });

  test.each([
    ['prep.rodent', 'How to prepare for your Waves rodent service'],
    ['prep.flea', 'How to prepare for your Waves flea treatment'],
    ['prep.mosquito', 'How to prepare for your Waves mosquito service'],
    ['prep.lawn', 'How to prepare for your Waves lawn treatment'],
    ['prep.termite', 'How to prepare for your Waves termite treatment'],
    ['prep.interior_pest', 'How to prepare for your Waves interior pest treatment'],
    ['portal.invite', 'Access your Waves customer portal'],
  ])('renders %s with sample preview data', (key, subject) => {
    const rendered = renderSeedTemplate(key);

    expect(rendered.subject).toBe(subject);
    expect(rendered.missingPayload).toEqual([]);
    expect(rendered.validation.ok).toBe(true);
    expect(rendered.text).not.toMatch(/\{\{|\}\}/);
    expect(rendered.html).toContain('waves-logo-2026.png');
  });

  test('prep guide omits optional rows and CTA when details are missing', () => {
    const rendered = renderSeedTemplate('prep.rodent', {
      service_date: '',
      property_address: '',
      customer_portal_url: '',
    });

    expect(rendered.text).not.toContain('Service date:');
    expect(rendered.text).not.toContain('Property:');
    expect(rendered.text).not.toContain('Open customer portal:');
    expect(rendered.text).not.toMatch(/\{\{|\}\}/);
  });
});
