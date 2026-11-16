/**
 * Portal reply email subject says "Waves" (owner 2026-11-12, "Just do waves"), against live Postgres.
 * Migration 20261112020000 publishes a new version of the template only while its active subject is still
 * the seeded "Your answer from Waves Pest Control". Pins: the customer reads the new subject, the body is the
 * same, the old version is archived and audited, a second run changes nothing, and a subject the office
 * rewrote is left alone. Every row is made inside a transaction that is rolled back, on a template key of
 * its own, so the real template is only read.
 */
const { randomUUID } = require('crypto');

const SKIP = !process.env.DATABASE_URL;
const maybeDescribe = SKIP ? describe.skip : describe;

maybeDescribe('portal reply email subject (live Postgres)', () => {
  let db;
  let trx;
  let EmailTemplates;
  const seed = require('../models/migrations/20261105000000_seed_portal_reply_email_template').__private;
  const { publishSubject, SUBJECT, SEEDED_SUBJECT, TEMPLATE_KEY, AUDIT_ACTION } = require('../models/migrations/20261112020000_portal_reply_subject_waves').__private;

  beforeAll(() => {
    db = require('../models/db');
    EmailTemplates = require('../services/email-template-library');
  });
  beforeEach(async () => { trx = await db.transaction(); });
  afterEach(async () => { await trx.rollback(); });
  afterAll(async () => { await db.destroy(); });

  // The template as 20261105000000 seeds it, under a key of this test's own.
  async function seeded(subject = SEEDED_SUBJECT) {
    const key = `portal_reply_test_${randomUUID().slice(0, 8)}`;
    const [template] = await trx('email_templates').insert(seed.templateRow({ ...seed.TEMPLATE, key })).returning('*');
    const [version] = await trx('email_template_versions').insert({
      template_id: template.id, version_number: 1, status: 'active', subject, preview_text: seed.TEMPLATE.preview,
      blocks: JSON.stringify(seed.TEMPLATE.blocks), published_at: new Date(),
    }).returning('*');
    await trx('email_templates').where({ id: template.id }).update({ active_version_id: version.id });
    return { key, template, version };
  }
  const versionsOf = (templateId) => trx('email_template_versions').where({ template_id: templateId }).orderBy('version_number');

  test('the seeded subject is superseded once: the customer reads "Your answer from Waves", the body is the same, the old version is archived and audited', async () => {
    const { key, template, version } = await seeded();

    expect(await publishSubject(trx, key)).toBe('published');

    const [old, live] = await versionsOf(template.id);
    expect([old.id, old.status, old.subject]).toEqual([version.id, 'archived', SEEDED_SUBJECT]);
    expect(live).toMatchObject({ version_number: 2, status: 'active', subject: 'Your answer from Waves', preview_text: seed.TEMPLATE.preview, text_body: null });
    expect(live.blocks).toEqual(seed.TEMPLATE.blocks);
    expect(live.validation_snapshot).toMatchObject({ ok: true, supersedes_version: 1, disallowed_variables: [], missing_required_in_template: [] });
    const row = await trx('email_templates').where({ id: template.id }).first();
    expect([row.active_version_id, row.status, row.from_name]).toEqual([live.id, 'active', template.from_name]);

    // What the customer is sent: the new subject over the same answer.
    const rendered = EmailTemplates.renderTemplate({ template: row, version: live, payload: seed.PREVIEW_PAYLOAD });
    expect(rendered.subject).toBe(SUBJECT);
    expect(rendered.text).toContain(seed.PREVIEW_PAYLOAD.reply_body);

    const audits = await trx('audit_log').where({ resource_id: template.id, action: AUDIT_ACTION });
    expect(audits).toHaveLength(1);
    expect(audits[0].metadata).toMatchObject({
      template_key: key, from_version_number: 1, to_version_number: 2,
      changes: { subject: { before: SEEDED_SUBJECT, after: SUBJECT } },
    });

    // A second run finds it done and writes nothing.
    expect(await publishSubject(trx, key)).toBe('already');
    expect(await versionsOf(template.id)).toHaveLength(2);
    expect(await trx('audit_log').where({ resource_id: template.id, action: AUDIT_ACTION })).toHaveLength(1);
  }, 30000);

  test('a subject the office rewrote is left alone, and a template that is not there is no error', async () => {
    const { key, template, version } = await seeded('We answered your question');

    expect(await publishSubject(trx, key)).toBe('skipped');
    const versions = await versionsOf(template.id);
    expect(versions.map((v) => [v.id, v.status, v.subject])).toEqual([[version.id, 'active', 'We answered your question']]);
    expect(await trx('audit_log').where({ resource_id: template.id, action: AUDIT_ACTION })).toHaveLength(0);

    expect(await publishSubject(trx, `portal_reply_absent_${randomUUID().slice(0, 8)}`)).toBe('missing');
  }, 30000);

  test('on a migrated database the real template says "Waves"', async () => {
    const live = await trx('email_templates as t').join('email_template_versions as v', 'v.id', 't.active_version_id')
      .where('t.template_key', TEMPLATE_KEY).first('v.subject', 'v.status');
    expect(live).toEqual({ subject: SUBJECT, status: 'active' });
  });
});
