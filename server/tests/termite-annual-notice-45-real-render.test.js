/**
 * Real PostgreSQL, real migrations, real renderers: this is the behavior a
 * customer actually receives for the termite annual-plan 45/30-day renewal
 * notice (slice 5, "notice ladder") — not just schema/validation shape.
 *
 * 1. Seeds the SMS row (20260926000102) and the email template+version+
 *    fixture (20260926000103) into a disposable schema via the REAL
 *    migrations, cloning the connected database's real table shapes (same
 *    technique as termite-annual-renewal-notice-templates-migration.test.js).
 * 2. Renders the SMS through the production path
 *    (services/sms-template-renderer.js -> routes/admin-sms-templates.js
 *    getTemplate) with realistic values.
 * 3. Renders the email through the production path
 *    (services/email-template-library.js loadTemplateByKey + renderTemplate)
 *    with the same realistic values sendTermiteRenewalReminder assembles.
 *
 * Self-skips without REPAIR_TEST_DATABASE_URL, e.g.:
 *   REPAIR_TEST_DATABASE_URL=postgresql://waves_user@localhost:5432/waves_test \
 *     npx jest --runInBand server/tests/termite-annual-notice-45-real-render.test.js
 */
const knexLib = require('knex');
const { randomUUID } = require('crypto');
const smsMigration = require('../models/migrations/20260926000102_termite_annual_renewal_notice_sms_template');
const emailMigration = require('../models/migrations/20260926000103_termite_annual_renewal_reminder_email_template');

const SKIP = !process.env.REPAIR_TEST_DATABASE_URL;
const describeOrSkip = SKIP ? describe.skip : describe;

async function createScratchDb() {
  const url = new URL(process.env.REPAIR_TEST_DATABASE_URL);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || !['/invoice_repair_test', '/waves_test'].includes(url.pathname)) {
    throw new Error('This test requires a local invoice_repair_test or waves_test database');
  }
  const schema = `termite_notice_render_${randomUUID().replace(/-/g, '')}`;
  const admin = knexLib({ client: 'pg', connection: url.toString(), pool: { min: 0, max: 1 } });
  await admin.raw('CREATE SCHEMA ??', [schema]);
  const db = knexLib({ client: 'pg', connection: url.toString(), searchPath: [schema], pool: { min: 0, max: 4 } });
  for (const table of ['sms_templates', 'email_templates', 'email_template_versions', 'email_template_fixtures']) {
    await db.raw('CREATE TABLE ?? (LIKE ?? INCLUDING ALL)', [table, `public.${table}`]);
  }
  return {
    db,
    async destroy() {
      await db.destroy();
      await admin.raw('DROP SCHEMA ?? CASCADE', [schema]);
      await admin.destroy();
    },
  };
}

describeOrSkip('termite annual renewal notice — real render through the production renderers', () => {
  let fixture;

  beforeEach(async () => {
    fixture = await createScratchDb();
    await smsMigration.up(fixture.db);
    await emailMigration.up(fixture.db);
  });

  afterEach(async () => {
    jest.resetModules();
    if (fixture) await fixture.destroy();
  });

  test('SMS: renders every variable, no leftover {placeholders}, currency formatted, cancel link present with the https:// scheme stripped (owner SMS-link policy)', async () => {
    const { db } = fixture;
    jest.doMock('../models/db', () => db);
    jest.doMock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
    const { renderSmsTemplate } = require('../services/sms-template-renderer');

    const body = await renderSmsTemplate('termite_annual_renewal_notice', {
      first_name: 'Stan',
      address_short: '123 Bayshore Rd, Bradenton',
      renewal_date: 'January 5, 2027',
      renewal_fee: '$650.00',
      cancel_link: 'https://portal.wavespestcontrol.com/?tab=plan',
    });

    expect(body).toBe(
      'Hi Stan, your Waves Subterranean Termite Protection at 123 Bayshore Rd, Bradenton renews on '
      + 'January 5, 2027 for another 12 months at $650.00. It renews automatically unless you cancel '
      + 'first: portal.wavespestcontrol.com/?tab=plan. Questions? Reply here.',
    );
    expect(body).not.toMatch(/\{[a-zA-Z_]+\}/); // no unresolved {placeholder}
    expect(body).not.toContain('https://'); // owner SMS-link policy: scheme stripped
    expect(body).toContain('portal.wavespestcontrol.com/?tab=plan'); // cancel link still present
  });

  test('SMS: a very long address still renders one clean body with no leftover placeholders (length/segment sanity check)', async () => {
    const { db } = fixture;
    jest.doMock('../models/db', () => db);
    jest.doMock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
    const { renderSmsTemplate } = require('../services/sms-template-renderer');

    const longAddress = 'Suite 4400, Building C, The Enclave at Riverwalk Commons, 987654 West Bayshore Boulevard Extension, Bradenton';
    const body = await renderSmsTemplate('termite_annual_renewal_notice', {
      first_name: 'Stanislaus-Alexander',
      address_short: longAddress,
      renewal_date: 'January 5, 2027',
      renewal_fee: '$1,234.56',
      cancel_link: 'https://portal.wavespestcontrol.com/?tab=plan',
    });

    expect(body).not.toMatch(/\{[a-zA-Z_]+\}/);
    expect(body).toContain(longAddress);
    expect(body).toContain('$1,234.56');
    // GSM-7 single segment is 160 chars, concatenated segments are 153 each.
    // This is a sanity/documentation check, not a hard product limit — a
    // long address legitimately pushes this into multi-segment territory.
    expect(body.length).toBeGreaterThan(160);
  });

  test('email: renders subject/body with every variable, currency formatted, cancel link present (full https:// URL, NOT stripped — that policy is SMS-only), and the last-inspection sentence cleanly absent when null', async () => {
    const { db } = fixture;
    jest.doMock('../models/db', () => db);
    const EmailTemplateLibrary = require('../services/email-template-library');

    const { template, activeVersion } = await EmailTemplateLibrary.loadTemplateByKey('membership.termite_renewal_reminder', db);
    expect(template).toBeTruthy();
    expect(activeVersion).toBeTruthy();

    const payload = {
      first_name: 'Stan',
      address: '123 Bayshore Rd, Bradenton, FL 34205',
      new_start: 'January 5, 2027',
      new_end: 'January 5, 2028',
      renewal_fee: '$650.00',
      renewal_date: 'January 5, 2027',
      cancel_link: 'https://portal.wavespestcontrol.com/?tab=plan',
      last_inspection_sentence: '', // no annual-inspection tracking exists yet — always empty today
    };
    const rendered = EmailTemplateLibrary.renderTemplate({ template, version: activeVersion, payload });

    expect(rendered.missingPayload).toEqual([]);
    expect(rendered.subject).toBe('Your termite protection renews January 5, 2027');
    expect(rendered.text).toContain('$650.00');
    expect(rendered.text).toContain('January 5, 2027');
    expect(rendered.text).toContain('123 Bayshore Rd, Bradenton, FL 34205');
    expect(rendered.text).toContain('https://portal.wavespestcontrol.com/?tab=plan'); // full scheme kept for email
    expect(rendered.html).toContain('https://portal.wavespestcontrol.com/?tab=plan');
    // No leftover {{placeholders}} anywhere in the rendered output.
    expect(rendered.subject).not.toMatch(/\{\{.*\}\}/);
    expect(rendered.text).not.toMatch(/\{\{.*\}\}/);
    expect(rendered.html).not.toMatch(/\{\{.*\}\}/);
    // The last-inspection sentence paragraph is its own block whose entire
    // content is {{last_inspection_sentence}} — dropped cleanly when empty,
    // never a blank "Your last annual inspection: ." fragment.
    expect(rendered.text).not.toContain('Your last annual inspection');
    expect(rendered.html).not.toContain('Your last annual inspection');
  });

  test('email: the last-inspection sentence renders cleanly when a date IS present', async () => {
    const { db } = fixture;
    jest.doMock('../models/db', () => db);
    const EmailTemplateLibrary = require('../services/email-template-library');
    const { template, activeVersion } = await EmailTemplateLibrary.loadTemplateByKey('membership.termite_renewal_reminder', db);

    const payload = {
      first_name: 'Stan',
      address: '123 Bayshore Rd, Bradenton, FL 34205',
      new_start: 'January 5, 2027',
      new_end: 'January 5, 2028',
      renewal_fee: '$650.00',
      renewal_date: 'January 5, 2027',
      cancel_link: 'https://portal.wavespestcontrol.com/?tab=plan',
      last_inspection_sentence: 'Your last annual inspection: March 1, 2026.',
    };
    const rendered = EmailTemplateLibrary.renderTemplate({ template, version: activeVersion, payload });

    expect(rendered.missingPayload).toEqual([]);
    expect(rendered.text).toContain('Your last annual inspection: March 1, 2026.');
    expect(rendered.html).toContain('Your last annual inspection: March 1, 2026.');
  });

  test('email: a blank/NULL renewal_fee is flagged as missing-required (fails closed, never renders as $0.00 or empty)', async () => {
    const { db } = fixture;
    jest.doMock('../models/db', () => db);
    const EmailTemplateLibrary = require('../services/email-template-library');
    const { template, activeVersion } = await EmailTemplateLibrary.loadTemplateByKey('membership.termite_renewal_reminder', db);

    const payload = {
      first_name: 'Stan',
      address: '123 Bayshore Rd, Bradenton, FL 34205',
      new_start: 'January 5, 2027',
      new_end: 'January 5, 2028',
      renewal_fee: '', // account-membership-email.js's money(null) returns '' (not "$0.00")
      renewal_date: 'January 5, 2027',
      cancel_link: 'https://portal.wavespestcontrol.com/?tab=plan',
      last_inspection_sentence: '',
    };
    const rendered = EmailTemplateLibrary.renderTemplate({ template, version: activeVersion, payload });

    expect(rendered.missingPayload).toContain('renewal_fee');
  });
});
