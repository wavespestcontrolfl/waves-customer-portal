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
  test('one template per email stage, keyed as the sender expects, saying only what the code does at that stage', () => {
    expect(Object.keys(byKey).sort()).toEqual(['payment.ach_card_fallback', 'payment.ach_retry_notice', 'payment.ach_suspended', 'payment.ach_suspended_no_card']);
    const first = render('payment.ach_retry_notice').text;
    expect(first).toContain('Your bank payment did not go through. You can pay now or update your payment method in your account.');
    const second = render('payment.ach_card_fallback').text;
    expect(second).toContain('Your bank payment did not go through again, so bank payments are paused on your account. To pay by bank again, add your bank account again in your account. You can also pay by card there. Credit card payments include a surcharge.');
    const onCard = render('payment.ach_suspended').text;
    expect(onCard).toContain('Your bank payment did not go through again, so bank payments are now off on your account. Your Auto Pay now uses your card on file. Credit card payments include a surcharge.');
    const noCard = render('payment.ach_suspended_no_card').text;
    expect(noCard).toContain('Your bank payment did not go through again, so bank payments are now off on your account. Please pay by card in your account. If you used Auto Pay, it is off for now. You can turn it back on with a card. Credit card payments include a surcharge.');
    // The texts' lines that the code does not do never reach an email: a promised retry, a switch to the card at the
    // second failure, a bank update link at the third (the pay page offers card only once bank payments are off).
    const all = Object.keys(byKey).map((key) => `${byKey[key].subject} ${byKey[key].preview} ${render(key).text}`).join('\n');
    expect(all).not.toMatch(/retry|business days|switched this payment|update your bank account|no added fee|processing fee/i);
    for (const key of Object.keys(byKey)) expect(render(key).text).toContain('https://portal.wavespestcontrol.com/?tab=billing');
  });

  test.each(Object.keys(byKey))('%s renders cleanly and never names "Waves Pest Control" in the body', (key) => {
    const rendered = render(key);
    expect(rendered.missingPayload).toEqual([]);
    expect(rendered.validation.ok).toBe(true);
    expect(rendered.text).not.toMatch(/\{\{|\}\}/);
    expect(rendered.text).toContain('Stan');
    expect(JSON.stringify(byKey[key].blocks)).not.toContain('Waves Pest Control');
  });

  test('every stage carries the billing link, so a collections dispute hold withholds each one', () => {
    for (const key of Object.keys(byKey)) {
      expect(HOLD_GATED_EMAIL_TEMPLATES.has(key)).toBe(true);
      expect(byKey[key].required).toContain('billing_url');
    }
  });

  test('the migration file name stays within 57 characters', () => {
    const names = fs.readdirSync(path.join(__dirname, '..', 'models', 'migrations')).filter((n) => n.includes('ach_failure_email'));
    expect(names).toHaveLength(1);
    expect(names[0].length).toBeLessThanOrEqual(57);
  });
});
