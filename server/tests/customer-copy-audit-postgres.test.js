/** Real PostgreSQL proof in rollback-only schemas on an explicit synthetic QA DB. */
jest.mock('../models/db', () => jest.fn(() => { throw new Error('Audit must use the supplied transaction'); }));
const knex = require('knex');
const { randomUUID } = require('node:crypto');
const sms = require('../models/migrations/20260926120000_customer_copy_audit_sms');
const email = require('../models/migrations/20260926120100_customer_copy_audit_email');
const automations = require('../models/migrations/20260926120200_customer_copy_audit_automations');
const r1 = require('../models/migrations/20260926120300_customer_copy_audit_codex_r1');
const r3 = require('../models/migrations/20260926120400_customer_copy_audit_codex_r3');
const baseline = require('./fixtures/customer-copy-audit-email-baseline.json');

const connection = process.env.COPY_AUDIT_TEST_DATABASE_URL;
const postgres = connection ? describe : describe.skip;
let db;
jest.setTimeout(60000);

const TABLES = [
  'sms_templates', 'sms_template_variants', 'audit_log', 'email_templates',
  'email_template_versions', 'automation_templates', 'automation_steps',
];

async function inRollback(work) {
  const rollback = new Error('intentional test rollback');
  try {
    await db.transaction(async (trx) => {
      const schema = `copy_audit_${randomUUID().replaceAll('-', '')}`;
      await trx.raw('CREATE SCHEMA ??', [schema]);
      for (const table of TABLES) {
        await trx.raw('CREATE TABLE ??.?? (LIKE public.?? INCLUDING ALL)', [schema, table, table]);
      }
      await trx.raw('SET LOCAL search_path TO ??, public', [schema]);
      await work(trx);
      throw rollback;
    });
  } catch (err) {
    if (err !== rollback) throw err;
  }
}

async function seedEmail(trx, fixture, { textBody = null } = {}) {
  const [template] = await trx('email_templates').insert({
    template_key: fixture.template_key, name: 'Synthetic', status: 'active',
  }).returning('*');
  const [version] = await trx('email_template_versions').insert({
    template_id: template.id, version_number: fixture.version_number, status: 'active',
    subject: fixture.subject, preview_text: fixture.preview_text,
    blocks: JSON.stringify(fixture.blocks), text_body: textBody,
  }).returning('*');
  await trx('email_templates').where({ id: template.id }).update({ active_version_id: version.id });
  return { template, version };
}

postgres('customer copy audit migrations on PostgreSQL', () => {
  beforeAll(() => {
    if (!/^\/(waves_test|waves_qa_[a-f0-9]+)$/.test(new URL(connection).pathname)) {
      throw new Error('Select a synthetic Waves QA database in a verified dev/preview environment');
    }
    db = knex({ client: 'pg', connection, pool: { min: 0, max: 1 } });
  });
  afterAll(async () => { if (db) await db.destroy(); });

  test('SMS: swaps exact defaults and variants, keeps administrator copy', async () => inRollback(async (trx) => {
    const [[firstKey, firstBefore, firstAfter], [secondKey, secondBefore]] = sms._SWAPS;
    await trx('sms_templates').insert({ template_key: firstKey, name: 'S', category: 'custom', body: firstBefore });
    await trx('sms_template_variants').insert({ template_key: firstKey, variant_key: 'control', body: firstBefore });
    await trx('sms_templates').insert({ template_key: secondKey, name: 'S', category: 'custom', body: 'Administrator copy' });
    await sms.up(trx);
    expect((await trx('sms_templates').where({ template_key: firstKey }).first()).body).toBe(firstAfter);
    expect((await trx('sms_template_variants').where({ template_key: firstKey }).first()).body).toBe(firstAfter);
    expect((await trx('sms_templates').where({ template_key: secondKey }).first()).body).toBe('Administrator copy');
    expect(await trx('audit_log')).toHaveLength(2);
    await sms.up(trx);
    expect(await trx('audit_log')).toHaveLength(2);
    expect(secondBefore).not.toBe('Administrator copy');
  }));

  test('email: publishes a patched version and archives only the version it replaced', async () => inRollback(async (trx) => {
    const fixture = baseline.find((t) => t.template_key === 'billing_late_payment_60_day');
    const { template, version: prior } = await seedEmail(trx, fixture);
    // An older archived version must stay archived; nothing else is touched.
    await trx('email_template_versions').insert({
      template_id: template.id, version_number: fixture.version_number - 1, status: 'archived',
      subject: 'old', blocks: JSON.stringify([]),
    });
    expect(await email._publishPatched(trx, fixture.template_key)).toBe('published');
    const live = await trx('email_templates').where({ id: template.id }).first();
    const current = await trx('email_template_versions').where({ id: live.active_version_id }).first();
    expect(current.version_number).toBe(fixture.version_number + 1);
    expect(JSON.stringify(current.blocks)).toContain('work out a payment plan');
    expect(JSON.stringify(current.blocks)).not.toContain('remains on hold');
    expect((await trx('email_template_versions').where({ id: prior.id }).first()).status).toBe('archived');
    expect(await trx('email_template_versions').where({ template_id: template.id, status: 'active' })).toHaveLength(1);
    await email.down(trx);
    expect((await trx('email_templates').where({ id: template.id }).first()).active_version_id).toBe(prior.id);
  }));

  test('email: an edited template or a custom plain-text body is left whole', async () => inRollback(async (trx) => {
    const edited = { ...baseline.find((t) => t.template_key === 'membership.paused'), blocks: [{ type: 'paragraph', content: 'Administrator copy' }] };
    const { version: editedPrior } = await seedEmail(trx, edited);
    const plain = baseline.find((t) => t.template_key === 'payment.refund_issued');
    const { version: plainPrior } = await seedEmail(trx, plain, { textBody: 'Administrator plain text' });
    expect(await email._publishPatched(trx, 'membership.paused')).toBe('skipped');
    expect(await email._publishPatched(trx, 'payment.refund_issued')).toBe('skipped');
    expect((await trx('email_templates').where({ template_key: 'membership.paused' }).first()).active_version_id).toBe(editedPrior.id);
    expect((await trx('email_templates').where({ template_key: 'payment.refund_issued' }).first()).active_version_id).toBe(plainPrior.id);
    expect(await trx('email_template_versions')).toHaveLength(2);
  }));

  test('email: a version-number collision skips the template and keeps the transaction usable', async () => inRollback(async (trx) => {
    const fixture = baseline.find((t) => t.template_key === 'payment.refund_issued');
    const { template, version: prior } = await seedEmail(trx, fixture);
    // Stand-in for an admin draft taking the same max+1 number between this
    // migration's read and its insert: the insert raises unique_violation.
    await trx.raw(`CREATE FUNCTION copy_audit_collide() RETURNS trigger LANGUAGE plpgsql AS $fn$
      BEGIN RAISE EXCEPTION 'duplicate version' USING ERRCODE = '23505'; END $fn$`);
    await trx.raw(`CREATE TRIGGER copy_audit_collide BEFORE INSERT ON email_template_versions
      FOR EACH ROW WHEN (NEW.validation_snapshot->>'source' = '${email.MIGRATION_MARKER}')
      EXECUTE FUNCTION copy_audit_collide()`);
    expect(await email._publishPatched(trx, fixture.template_key)).toBe('raced');
    expect((await trx('email_templates').where({ id: template.id }).first()).active_version_id).toBe(prior.id);
    expect((await trx('email_template_versions').where({ id: prior.id }).first()).status).toBe('active');
    await trx.raw('DROP TRIGGER copy_audit_collide ON email_template_versions');
    expect(await email._publishPatched(trx, fixture.template_key)).toBe('published');
  }));

  test('email: every audited template publishes from its live baseline', async () => inRollback(async (trx) => {
    for (const fixture of baseline) await seedEmail(trx, fixture);
    await email.up(trx);
    const templates = await trx('email_templates').select('active_version_id');
    const versions = await trx('email_template_versions').whereIn('id', templates.map((t) => t.active_version_id));
    expect(versions).toHaveLength(baseline.length);
    for (const v of versions) expect(v.validation_snapshot.source).toBe(email.MIGRATION_MARKER);
  }));

  test('automations: swaps exact step and SMS copy, keeps edits', async () => inRollback(async (trx) => {
    const step = automations._STEP_SWAPS.find((s) => s.key === 'new_lead' && s.field === 'html_body');
    const smsSwap = automations._SMS_SWAPS[0];
    await trx('automation_templates').insert({ key: 'new_lead', name: 'New Lead', sms_template: null });
    await trx('automation_templates').insert({ key: smsSwap.key, name: 'S', sms_template: smsSwap.before });
    await trx('automation_steps').insert({ template_key: 'new_lead', step_order: 0, delay_hours: 0, subject: 's', html_body: step.before });
    await trx('automation_steps').insert({ template_key: 'estimate_sent', step_order: 0, delay_hours: 2, subject: 's', html_body: '<p>Administrator copy</p>' });
    await automations.up(trx);
    expect((await trx('automation_steps').where({ template_key: 'new_lead' }).first()).html_body).toBe(step.after);
    expect((await trx('automation_steps').where({ template_key: 'estimate_sent' }).first()).html_body).toBe('<p>Administrator copy</p>');
    expect((await trx('automation_templates').where({ key: smsSwap.key }).first()).sms_template).toBe(smsSwap.after);
    expect(await trx('audit_log')).toHaveLength(2);
  }));

  test('codex r1: service_renewal becomes a renewal ask after 120200, edits are kept', async () => inRollback(async (trx) => {
    const { before, after } = r1.RENEWAL;
    const original = before.preview_text[0];
    await trx('automation_templates').insert({ key: 'service_renewal', name: 'Service Renewal Reminder', sms_template: r1.RENEWAL.sms.before[0] });
    const [step] = await trx('automation_steps').insert({
      template_key: 'service_renewal', step_order: 0, delay_hours: 0,
      subject: before.subject, preview_text: original, html_body: before.html_body, text_body: before.text_body,
    }).returning('*');
    await automations.up(trx);
    expect((await trx('automation_steps').where({ id: step.id }).first()).preview_text).toBe(before.preview_text[1]);
    await r1.up(trx);
    expect(await trx('automation_steps').where({ id: step.id }).first()).toMatchObject(after);
    expect((await trx('automation_templates').where({ key: 'service_renewal' }).first()).sms_template).toBe(r1.RENEWAL.sms.after);
    // An administrator-edited body keeps every field, preview included.
    await trx('automation_steps').where({ id: step.id }).update({ ...before, preview_text: original, html_body: '<p>Administrator copy</p>' });
    await r1.up(trx);
    expect(await trx('automation_steps').where({ id: step.id }).first()).toMatchObject({ preview_text: original, html_body: '<p>Administrator copy</p>' });
  }));

  test('codex r1: micro-deposit email republishes over 120100 and rolls back to it', async () => inRollback(async (trx) => {
    const fixture = baseline.find((t) => t.template_key === 'payment.microdeposit_verification');
    const { template } = await seedEmail(trx, fixture);
    expect(await email._publishPatched(trx, fixture.template_key)).toBe('published');
    const v120100 = (await trx('email_templates').where({ id: template.id }).first()).active_version_id;
    expect(await r1._publishPatched(trx, fixture.template_key)).toBe('published');
    const live = await trx('email_templates').where({ id: template.id }).first();
    const current = await trx('email_template_versions').where({ id: live.active_version_id }).first();
    expect(JSON.stringify(current.blocks)).toContain('one or two small test deposits');
    expect(await trx('email_template_versions').where({ template_id: template.id, status: 'active' })).toHaveLength(1);
    await r1.down(trx);
    expect((await trx('email_templates').where({ id: template.id }).first()).active_version_id).toBe(v120100);
  }));

  test('codex r3: the service-request text is rewritten over 120000 output only', async () => inRollback(async (trx) => {
    const [[key, before, after]] = r3._SWAPS;
    const [original] = sms._SWAPS.filter(([k]) => k === key);
    await trx('sms_templates').insert({ template_key: key, name: 'S', category: 'custom', body: original[1] });
    await trx('sms_template_variants').insert({ template_key: key, variant_key: 'custom', body: 'Administrator copy' });
    await sms.up(trx);
    expect((await trx('sms_templates').where({ template_key: key }).first()).body).toBe(before);
    await r3.up(trx);
    expect((await trx('sms_templates').where({ template_key: key }).first()).body).toBe(after);
    expect((await trx('sms_template_variants').where({ template_key: key }).first()).body).toBe('Administrator copy');
  }));
});
