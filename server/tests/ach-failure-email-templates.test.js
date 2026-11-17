jest.mock('../models/db', () => jest.fn());
jest.mock('../services/sendgrid-mail', () => ({
  newsletterGroupId: jest.fn(() => 101),
  serviceGroupId: jest.fn(() => 202),
}));

const fs = require('fs');
const path = require('path');
const EmailTemplates = require('../services/email-template-library');
const seed = require('../models/migrations/20261116120000_seed_ach_failure_email_templates');
const { HOLD_GATED_EMAIL_TEMPLATES } = require('../services/collections/collection-hold');

const byKey = Object.fromEntries(seed.__private.EMAIL_TEMPLATES.map((t) => [t.key, t]));

function render(key, payload = seed.__private.PREVIEW_PAYLOAD) {
  const t = byKey[key];
  return EmailTemplates.renderTemplate({
    template: { id: `tmpl-${key}`, template_key: key },
    version: { id: `ver-${key}`, subject: t.subject, preview_text: t.preview, blocks: t.blocks, text_body: '' },
    payload,
  });
}

describe('bank payment failure email seeds (GATE_ACH_FAILURE_EMAIL)', () => {
  test('one template per stage, keyed as the sender expects, with the owner-approved wording', () => {
    expect(Object.keys(byKey).sort()).toEqual(['payment.ach_card_fallback', 'payment.ach_retry_notice', 'payment.ach_suspended']);
    expect(render('payment.ach_retry_notice').text).toContain("Your bank payment did not go through. We'll retry automatically in 3 business days. Nothing you need to do right now.");
    expect(render('payment.ach_card_fallback').text).toContain('Your bank payment failed again, so we switched this payment to your card on file. Card payments include a processing fee. You can switch back to bank payment once your account is verified.');
    const suspended = render('payment.ach_suspended').text;
    expect(suspended).toContain('Your bank payment failed again, so we set your card as the default. Card payments include a processing fee. To pay by bank with no added fee, update your bank account here:');
    expect(suspended).toContain('https://portal.wavespestcontrol.com/?tab=billing');
  });

  test.each(Object.keys(byKey))('%s renders cleanly and never names "Waves Pest Control" in the body', (key) => {
    const rendered = render(key);
    expect(rendered.missingPayload).toEqual([]);
    expect(rendered.validation.ok).toBe(true);
    expect(rendered.text).not.toMatch(/\{\{|\}\}/);
    expect(rendered.text).toContain('Stan');
    expect(JSON.stringify(byKey[key].blocks)).not.toContain('Waves Pest Control');
  });

  test('only the stage that carries an update link is held by a collections dispute hold', () => {
    expect(HOLD_GATED_EMAIL_TEMPLATES.has('payment.ach_suspended')).toBe(true);
    expect(HOLD_GATED_EMAIL_TEMPLATES.has('payment.ach_retry_notice')).toBe(false);
    expect(HOLD_GATED_EMAIL_TEMPLATES.has('payment.ach_card_fallback')).toBe(false);
    expect(byKey['payment.ach_suspended'].required).toContain('billing_url');
  });

  test('the migration file name stays within 57 characters', () => {
    const names = fs.readdirSync(path.join(__dirname, '..', 'models', 'migrations')).filter((n) => n.includes('ach_failure_email'));
    expect(names).toHaveLength(1);
    expect(names[0].length).toBeLessThanOrEqual(57);
  });
});
