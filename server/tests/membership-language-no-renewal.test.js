jest.mock('../models/db', () => jest.fn());
jest.mock('../services/sendgrid-mail', () => ({
  newsletterGroupId: jest.fn(() => 101),
  serviceGroupId: jest.fn(() => 202),
}));

const EmailTemplates = require('../services/email-template-library');
const migration = require('../models/migrations/20260713000010_membership_language_no_renewal');

const { NEW_EMAIL_VERSION, NEW_SMS_BODY } = migration.__private;

// OWNER RULING (2026-07-13): "renewal" language is reserved for termite
// bonds. The annual-prepay year-end notice stays (real paid term, real
// next-year invoice) but must never call itself a renewal.
describe('annual-prepay year-end notices carry no renewal language', () => {
  const renderedEmail = () => EmailTemplates.renderTemplate({
    template: {
      id: 'tmpl-membership.renewal_reminder',
      template_key: 'membership.renewal_reminder',
      mode: 'service',
      layout_wrapper_id: 'service_default_v1',
      from_name: 'Waves Pest Control',
      from_email: 'contact@wavespestcontrol.com',
    },
    version: {
      id: 'ver-new',
      subject: NEW_EMAIL_VERSION.subject,
      preview_text: NEW_EMAIL_VERSION.preview,
      blocks: NEW_EMAIL_VERSION.blocks,
      text_body: '',
    },
    payload: {
      first_name: 'Pat',
      membership_name: 'WaveGuard Gold',
      renewal_date: 'June 20, 2026',
      renewal_notice_window: '30 days',
      monthly_rate: '$120',
      billing_cadence: 'Annual prepay',
      last_service_date: 'June 13, 2026',
      customer_portal_url: 'https://portal.test/account',
    },
  });

  test('the new email version never says renewal to the customer', () => {
    const { subject, html, text } = renderedEmail();
    for (const surface of [subject, html, text]) {
      expect(surface).not.toMatch(/renew/i);
    }
    // The notice content itself survives the rewording.
    expect(html).toContain('June 20, 2026');
    expect(html).toContain('No action is needed');
  });

  test('payload variable contract is unchanged for the existing sender', () => {
    const blockText = JSON.stringify(NEW_EMAIL_VERSION.blocks);
    for (const variable of ['renewal_date', 'renewal_notice_window', 'monthly_rate', 'billing_cadence', 'last_service_date', 'membership_name']) {
      expect(blockText).toContain(`{{${variable}}}`);
    }
    // CTA references the portal URL by variable name, not interpolation.
    expect(blockText).toContain('"url_variable":"customer_portal_url"');
  });

  // The sender passes renewal_date/{term_end} as the LAST covered day of the
  // current paid year (annual-prepay-renewals.js), so the copy must frame the
  // date as the year ENDING — "next year starts {date}" would be a day early
  // (Codex #2702 round 1).
  test('the date is framed as the plan year ending, never the next year starting', () => {
    const blockText = JSON.stringify(NEW_EMAIL_VERSION.blocks);
    expect(blockText).toContain('"label":"Plan year ends","value":"{{renewal_date}}"');
    expect(blockText).not.toMatch(/start[^"]*\{\{renewal_date\}\}/i);
    expect(NEW_SMS_BODY).toContain('plan year ends on {term_end}');
  });

  test('the SMS body never says renewal and keeps its variables', () => {
    expect(NEW_SMS_BODY).not.toMatch(/renew/i);
    for (const variable of ['{first_name}', '{term_end}', '{last_service_sentence}']) {
      expect(NEW_SMS_BODY).toContain(variable);
    }
    expect(NEW_SMS_BODY).toContain('Reply STOP to opt out.');
    // GSM-7 only — no smart punctuation that would flip UCS-2 encoding.
    expect(/^[\x20-\x7E\n]*$/.test(NEW_SMS_BODY.replace(/\{[a-z_]+\}/g, ''))).toBe(true);
  });
});
