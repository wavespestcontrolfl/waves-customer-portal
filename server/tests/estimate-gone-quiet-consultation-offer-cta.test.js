/**
 * Migration 20260926010000 — adds the "Rather have us come look first?"
 * consultation-offer link to estimate.engage_gone_quiet (owner ruling
 * 2026-09-26). Three layers:
 *   - pure block-placement helpers (no DB);
 *   - render QA through the REAL EmailTemplateLibrary renderer: a blank
 *     consultation_url drops the block cleanly, a non-blank one renders the
 *     ruled copy as a text link in both HTML and plaintext;
 *   - a Postgres-backed pass (same convention as
 *     app-onboarding-postgres.test.js) pinning that up() derives from the
 *     CURRENT active version (never the original seed), is idempotent, and
 *     down() restores the prior active version — but only while it is still
 *     the active one.
 */

const EmailTemplates = require('../services/email-template-library');
const migration = require('../models/migrations/20260926010000_estimate_gone_quiet_consultation_offer_cta');

const { primaryCtaAnchorIndex, alreadyHasConsultationLink, NEW_VARIABLE, LINK_LABEL, MIGRATION } = migration._private;

describe('block-placement helpers (no DB)', () => {
  test('primaryCtaAnchorIndex finds the FIRST cta block, ahead of a later secondary chip CTA', () => {
    const blocks = [
      { type: 'paragraph', content: 'Hi {{first_name}}' },
      { type: 'cta', label: 'Take another look', url_variable: 'estimate_url' },
      { type: 'cta', label: 'How we treat your home — products & safety', url: 'https://example.com' },
      { type: 'signature', content: '— The Waves Team' },
    ];
    expect(primaryCtaAnchorIndex(blocks)).toBe(1);
  });

  test('primaryCtaAnchorIndex throws when the active version has no CTA at all — fail loud, never half-apply', () => {
    expect(() => primaryCtaAnchorIndex([{ type: 'paragraph', content: 'Hi' }]))
      .toThrow(/no primary CTA block found/);
  });

  test('alreadyHasConsultationLink is true only once the block is actually present', () => {
    const before = [{ type: 'cta', label: 'Take another look', url_variable: 'estimate_url' }];
    const after = [...before, { type: 'cta', variant: 'link', label: LINK_LABEL, url_variable: NEW_VARIABLE }];
    expect(alreadyHasConsultationLink(before)).toBe(false);
    expect(alreadyHasConsultationLink(after)).toBe(true);
  });
});

describe('render QA — the real EmailTemplateLibrary renderer', () => {
  function templateWithConsultationVariable(overrides = {}) {
    return {
      id: 'tmpl-gone-quiet',
      template_key: 'estimate.engage_gone_quiet',
      name: 'Estimate Engagement — Gone Quiet',
      mode: 'service',
      send_stream: 'service_operational',
      allowed_variables: ['first_name', 'estimate_url', 'service_label', NEW_VARIABLE],
      // consultation_url is ALLOWED, never required — a dark gate or an
      // ineligible send must never fail validation or block the send.
      required_variables: ['first_name', 'estimate_url', 'service_label'],
      ...overrides,
    };
  }

  function versionWithConsultationLink() {
    return {
      id: 'ver-gone-quiet',
      subject: 'Any questions about your Waves estimate?',
      preview_text: 'Reply and ask — real answers in minutes.',
      text_body: '',
      blocks: [
        { type: 'paragraph', content: 'Hi {{first_name}}, just checking in on your {{service_label}} estimate.' },
        { type: 'cta', label: 'Take another look', url_variable: 'estimate_url' },
        // The block this migration inserts, right after the primary CTA.
        { type: 'cta', variant: 'link', label: LINK_LABEL, url_variable: NEW_VARIABLE },
        { type: 'signature', content: '— The Waves Team' },
      ],
    };
  }

  test('a blank consultation_url drops the block cleanly — the email renders as if the migration never ran', () => {
    const rendered = EmailTemplates.renderTemplate({
      template: templateWithConsultationVariable(),
      version: versionWithConsultationLink(),
      payload: {
        first_name: 'Taylor',
        service_label: 'pest control',
        estimate_url: 'https://portal.wavespestcontrol.com/estimate/tok',
        consultation_url: '',
      },
    });

    expect(rendered.validation.ok).toBe(true);
    expect(rendered.html).not.toContain(LINK_LABEL);
    expect(rendered.text).not.toContain(LINK_LABEL);
    expect(rendered.html).toContain('Take another look');
  });

  test('a non-blank consultation_url renders the ruled copy as a text link in BOTH html and text', () => {
    const url = 'https://portal.wavespestcontrol.com/l/abc123';
    const rendered = EmailTemplates.renderTemplate({
      template: templateWithConsultationVariable(),
      version: versionWithConsultationLink(),
      payload: {
        first_name: 'Taylor',
        service_label: 'pest control',
        estimate_url: 'https://portal.wavespestcontrol.com/estimate/tok',
        consultation_url: url,
      },
    });

    expect(rendered.validation.ok).toBe(true);
    expect(rendered.html).toContain(url);
    expect(rendered.html).toContain('Rather have us come look first?');
    // variant:'link' renders as a plain text link, not a button.
    expect(rendered.html).toMatch(new RegExp(`<a[^>]*href="${url}"[^>]*>${'Rather have us come look first\\? Pick a time for a free consultation'}`));
    expect(rendered.text).toContain(`${LINK_LABEL}: ${url}`);
  });

  test('the variable is allowed, never required — an omitted consultation_url never fails validation or reports as missing', () => {
    const rendered = EmailTemplates.renderTemplate({
      template: templateWithConsultationVariable(),
      version: versionWithConsultationLink(),
      payload: {
        first_name: 'Taylor',
        service_label: 'pest control',
        estimate_url: 'https://portal.wavespestcontrol.com/estimate/tok',
        // consultation_url omitted entirely.
      },
    });
    expect(rendered.validation.ok).toBe(true);
    expect(rendered.missingPayload).not.toContain(NEW_VARIABLE);
  });
});

// Runs with the existing CI PostgreSQL pass; never a production connection.
// Same schema-per-run convention as app-onboarding-postgres.test.js.
const SKIP = !process.env.DATABASE_URL;
const { randomUUID } = require('crypto');
const knexLib = require('knex');

(SKIP ? describe.skip : describe)('estimate.engage_gone_quiet consultation-offer migration — PostgreSQL', () => {
  let db;
  const schema = `gone_quiet_cta_${randomUUID().replaceAll('-', '')}`;

  beforeAll(async () => {
    db = knexLib({ client: 'pg', connection: process.env.DATABASE_URL, searchPath: [schema], pool: { min: 0, max: 3 } });
    await db.raw('CREATE SCHEMA ??', [schema]);
    await db.schema.createTable('audit_log', (t) => {
      t.uuid('id').primary().defaultTo(db.raw('gen_random_uuid()'));
      t.string('actor_type'); t.uuid('actor_id'); t.string('action');
      t.string('resource_type'); t.uuid('resource_id'); t.jsonb('metadata');
      t.string('ip_address'); t.string('user_agent');
    });
    await db.schema.createTable('email_templates', (t) => {
      t.uuid('id').primary().defaultTo(db.raw('gen_random_uuid()'));
      t.string('template_key').notNullable().unique();
      t.uuid('active_version_id');
      t.jsonb('allowed_variables'); t.jsonb('optional_variables'); t.jsonb('required_variables');
      t.string('status'); t.string('from_email'); t.string('send_stream');
      t.timestamp('last_published_at'); t.timestamp('updated_at');
    });
    await db.schema.createTable('email_template_versions', (t) => {
      t.uuid('id').primary().defaultTo(db.raw('gen_random_uuid()'));
      t.uuid('template_id').notNullable().references('id').inTable('email_templates');
      t.integer('version_number').notNullable(); t.unique(['template_id', 'version_number']);
      t.string('status'); t.string('subject').notNullable(); t.string('preview_text');
      t.jsonb('blocks'); t.text('text_body'); t.jsonb('validation_snapshot');
      t.timestamp('published_at'); t.timestamp('updated_at'); // real table: timestamps(true, true)
    });
    await db.schema.createTable('email_template_fixtures', (t) => {
      t.uuid('id').primary().defaultTo(db.raw('gen_random_uuid()'));
      t.uuid('template_id').notNullable().references('id').inTable('email_templates');
      t.string('name'); t.boolean('is_default'); t.jsonb('payload'); t.timestamp('updated_at');
    });
  });

  afterAll(async () => {
    if (db) {
      await db.raw('DROP SCHEMA ?? CASCADE', [schema]);
      await db.destroy();
    }
  });

  const SEED_BLOCKS = [
    { type: 'paragraph', content: 'Hi {{first_name}}, just checking in on your {{service_label}} estimate.' },
    { type: 'cta', label: 'Take another look', url_variable: 'estimate_url' },
    { type: 'cta', label: 'How we treat your home — products & safety', url: 'https://www.wavespestcontrol.com/products-and-safety' },
    { type: 'signature', content: '— The Waves Team' },
  ];

  test('up() derives from the CURRENT active version, is idempotent, and down() restores the prior active version while it is still active', async () => {
    await db.transaction(async (trx) => {
      // A hand-edited paragraph (an owner/admin edit through the template
      // library) must survive: this is NOT the original 20260715200000 seed
      // content, and up() must never overwrite it with fresh seed text.
      const editedBlocks = structuredClone(SEED_BLOCKS);
      editedBlocks[0].content += ' Staff edit — no rush at all.';
      const [seededTemplate] = await trx('email_templates').insert({
        template_key: 'estimate.engage_gone_quiet', status: 'active', from_email: 'contact@wavespestcontrol.com',
        send_stream: 'service_operational',
        allowed_variables: JSON.stringify(['first_name', 'estimate_url', 'service_label']),
        optional_variables: JSON.stringify([]), required_variables: JSON.stringify(['first_name', 'estimate_url', 'service_label']),
      }).returning('*');
      const [seededVersion] = await trx('email_template_versions').insert({
        template_id: seededTemplate.id, version_number: 3, status: 'active',
        subject: 'Any questions about your Waves estimate?', preview_text: 'Reply and ask — real answers in minutes.',
        blocks: JSON.stringify(editedBlocks), validation_snapshot: JSON.stringify({ staff_reviewed: true }),
      }).returning('*');
      await trx('email_templates').where({ id: seededTemplate.id }).update({ active_version_id: seededVersion.id });
      await trx('email_template_fixtures').insert({
        template_id: seededTemplate.id, name: 'Default preview', is_default: true,
        payload: JSON.stringify({ first_name: 'Taylor', estimate_url: 'https://portal.wavespestcontrol.com/estimate/sample', service_label: 'pest control' }),
      });

      await migration.up(trx);
      await migration.up(trx); // idempotent — no duplicate version

      const afterFirstUp = await trx('email_templates').where({ id: seededTemplate.id }).first();
      const versionsAfterUp = await trx('email_template_versions').where({ template_id: seededTemplate.id });
      expect(versionsAfterUp).toHaveLength(2); // staff version + ONE published version
      const published = await trx('email_template_versions').where({ id: afterFirstUp.active_version_id }).first();
      expect(published.version_number).toBe(4);
      expect(published.blocks).toContainEqual({ type: 'paragraph', content: editedBlocks[0].content });
      expect(published.blocks).toContainEqual({ type: 'cta', variant: 'link', label: LINK_LABEL, url_variable: NEW_VARIABLE });
      // Inserted right after the PRIMARY cta, ahead of the secondary chip.
      const ctaIdx = published.blocks.findIndex((b) => b.url_variable === 'estimate_url');
      const linkIdx = published.blocks.findIndex((b) => b.url_variable === NEW_VARIABLE);
      expect(linkIdx).toBe(ctaIdx + 1);
      expect(afterFirstUp.allowed_variables).toContain(NEW_VARIABLE);
      expect(published.validation_snapshot).toMatchObject({ ok: true, migration: MIGRATION, prior_version_id: seededVersion.id });
      // The same hand-off the library's publish makes: exactly one active
      // version — the replaced one is archived.
      expect(published.status).toBe('active');
      expect((await trx('email_template_versions').where({ id: seededVersion.id }).first()).status).toBe('archived');

      // A later staff/admin publish supersedes ours — down() must NOT touch
      // an active_version_id that is no longer the version we published.
      const [laterVersion] = await trx('email_template_versions').insert({
        template_id: seededTemplate.id, version_number: 5, status: 'active',
        subject: published.subject, preview_text: published.preview_text,
        blocks: JSON.stringify(published.blocks), validation_snapshot: JSON.stringify({ staff_reviewed: true }),
      }).returning('*');
      await trx('email_templates').where({ id: seededTemplate.id }).update({ active_version_id: laterVersion.id });
      await migration.down(trx);
      const afterNoopDown = await trx('email_templates').where({ id: seededTemplate.id }).first();
      expect(afterNoopDown.active_version_id).toBe(laterVersion.id); // untouched

      // Roll the later publish back to OUR version and confirm down() DOES
      // restore the original staff version in that case.
      await trx('email_templates').where({ id: seededTemplate.id }).update({ active_version_id: published.id });
      await migration.down(trx);
      const afterRealDown = await trx('email_templates').where({ id: seededTemplate.id }).first();
      expect(afterRealDown.active_version_id).toBe(seededVersion.id);
      expect((await trx('email_template_versions').where({ id: seededVersion.id }).first()).status).toBe('active');
      expect((await trx('email_template_versions').where({ id: published.id }).first()).status).toBe('archived');
      // History retained — nothing deleted.
      expect(await trx('email_template_versions').where({ template_id: seededTemplate.id }).count('* as n').first())
        .toEqual({ n: '3' });

      await trx.rollback();
    });
  });

  test('an active version that already carries the block is a no-op', async () => {
    await db.transaction(async (trx) => {
      const blocksWithLink = [
        ...SEED_BLOCKS.slice(0, 2),
        { type: 'cta', variant: 'link', label: LINK_LABEL, url_variable: NEW_VARIABLE },
        ...SEED_BLOCKS.slice(2),
      ];
      const [template] = await trx('email_templates').insert({
        template_key: 'estimate.engage_gone_quiet', status: 'active', from_email: 'contact@wavespestcontrol.com',
        send_stream: 'service_operational',
        allowed_variables: JSON.stringify(['first_name', 'estimate_url', 'service_label', NEW_VARIABLE]),
        optional_variables: JSON.stringify([NEW_VARIABLE]), required_variables: JSON.stringify(['first_name', 'estimate_url', 'service_label']),
      }).returning('*');
      const [version] = await trx('email_template_versions').insert({
        template_id: template.id, version_number: 1, status: 'active',
        subject: 'Any questions about your Waves estimate?', preview_text: 'Reply and ask — real answers in minutes.',
        blocks: JSON.stringify(blocksWithLink), validation_snapshot: JSON.stringify({ hand_authored: true }),
      }).returning('*');
      await trx('email_templates').where({ id: template.id }).update({ active_version_id: version.id });

      await migration.up(trx);

      const afterUp = await trx('email_templates').where({ id: template.id }).first();
      expect(afterUp.active_version_id).toBe(version.id); // no new version published
      expect(await trx('email_template_versions').where({ template_id: template.id }).count('* as n').first())
        .toEqual({ n: '1' });

      await trx.rollback();
    });
  });
});
