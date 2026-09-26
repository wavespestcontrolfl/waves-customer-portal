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

// The two describes above render a hand-built, minimal stand-in version
// (paragraph / primary cta / link / signature). This describe instead pulls
// the ACTUAL current template definition — 20260715200000's seed as amended
// by 20260723300000 (report-video module) and 20260724100000 (round 2: van
// photo removed from gone_quiet, report tour already present) — so a real
// structural change to the template (an extra 'cta'-typed block landing
// ahead of "Take another look", e.g. inside a future why-Waves or FAQ
// module) would break this test rather than only the migration's own
// synthetic fixture. 20260724100000._TEMPLATES is the up-to-date export
// (it transforms 20260723300000's export, which transforms the seed's).
describe('render QA — the REAL estimate.engage_gone_quiet seeded content', () => {
  const round2 = require('../models/migrations/20260724100000_engage_email_round2');
  const REAL_TEMPLATE_DEF = round2._TEMPLATES.find((t) => t.key === 'estimate.engage_gone_quiet');
  if (!REAL_TEMPLATE_DEF) {
    throw new Error('estimate.engage_gone_quiet missing from the round2 seed export — template key renamed?');
  }

  // Mirrors templateRow()'s allowed_variables formula in the seed migration
  // (SHARED_VARIABLES + CATEGORY_VARIABLES + this template's own required +
  // optional) — the union every real seeded template actually gets.
  const SHARED_VARIABLES = ['first_name', 'customer_portal_url', 'company_phone', 'company_email'];
  const CATEGORY_VARIABLES = [
    'service_label', 'category_headline', 'category_hook', 'category_benefit', 'category_question',
    'category_included', 'category_process',
    'faq_start', 'faq_terms', 'faq_between_visits', 'faq_price',
  ];
  const realAllowed = [...new Set([
    ...SHARED_VARIABLES, ...CATEGORY_VARIABLES,
    ...(REAL_TEMPLATE_DEF.required || []), ...(REAL_TEMPLATE_DEF.optional || []),
  ])];

  const REAL_TEMPLATE = {
    id: 'tmpl-gone-quiet-real',
    template_key: REAL_TEMPLATE_DEF.key,
    name: REAL_TEMPLATE_DEF.name,
    mode: 'service',
    send_stream: 'service_operational',
    allowed_variables: realAllowed,
    required_variables: REAL_TEMPLATE_DEF.required || [],
  };

  const BASE_PAYLOAD = {
    first_name: 'Taylor',
    service_label: 'pest control',
    estimate_url: 'https://portal.wavespestcontrol.com/estimate/tok',
    category_question: 'Wondering about pets and kids? Reply and ask.',
    category_benefit: 'No long-term contract, unlimited free callbacks.',
    category_included: 'Exterior and interior pest protection on a recurring schedule.',
    // category_headline/hook/process, faq_*, and report_video_* are all
    // optional/truth-scoped — left blank so their blocks/rows drop, same as
    // a real send for a category missing that content.
  };

  function realVersion(blocks) {
    return {
      id: 'ver-gone-quiet-real',
      subject: REAL_TEMPLATE_DEF.subject,
      preview_text: REAL_TEMPLATE_DEF.preview,
      text_body: null,
      blocks,
    };
  }

  // The migration's own logic applied by hand to the REAL blocks (mirrors
  // exports.up's splice, without the DB round-trip).
  function withConsultationBlock(blocks) {
    const anchor = primaryCtaAnchorIndex(blocks);
    const next = [...blocks];
    next.splice(anchor + 1, 0, { type: 'cta', variant: 'link', label: LINK_LABEL, url_variable: NEW_VARIABLE });
    return next;
  }

  test('the real template has exactly one cta ahead of the consultation-link anchor: "Take another look", never the secondary safety chip', () => {
    const ctaBlocks = REAL_TEMPLATE_DEF.blocks.filter((b) => b.type === 'cta');
    expect(ctaBlocks).toHaveLength(2);
    expect(ctaBlocks[0].label).toBe('Take another look');
    expect(primaryCtaAnchorIndex(REAL_TEMPLATE_DEF.blocks)).toBe(
      REAL_TEMPLATE_DEF.blocks.findIndex((b) => b.type === 'cta'),
    );
  });

  test('a blank consultation_url renders BYTE-IDENTICAL html/text to rendering the pre-migration real blocks', () => {
    const preMigration = EmailTemplates.renderTemplate({
      template: REAL_TEMPLATE,
      version: realVersion(REAL_TEMPLATE_DEF.blocks),
      payload: BASE_PAYLOAD,
    });
    const postMigrationBlank = EmailTemplates.renderTemplate({
      template: { ...REAL_TEMPLATE, allowed_variables: [...realAllowed, NEW_VARIABLE] },
      version: realVersion(withConsultationBlock(REAL_TEMPLATE_DEF.blocks)),
      payload: { ...BASE_PAYLOAD, consultation_url: '' },
    });
    expect(postMigrationBlank.validation.ok).toBe(true);
    expect(postMigrationBlank.html).toBe(preMigration.html);
    expect(postMigrationBlank.text).toBe(preMigration.text);
  });

  test('a real consultation URL renders the link exactly once, directly after "Take another look", in both html and text — href unchanged by safeUrl for https', () => {
    const url = 'https://portal.wavespestcontrol.com/l/real-short-code';
    const rendered = EmailTemplates.renderTemplate({
      template: { ...REAL_TEMPLATE, allowed_variables: [...realAllowed, NEW_VARIABLE] },
      version: realVersion(withConsultationBlock(REAL_TEMPLATE_DEF.blocks)),
      payload: { ...BASE_PAYLOAD, consultation_url: url },
    });

    expect(rendered.validation.ok).toBe(true);

    // Exactly once in each body.
    expect(rendered.html.split(url)).toHaveLength(2);
    expect(rendered.text.split(url)).toHaveLength(2);

    // href is the raw https URL, unmangled by safeUrl/escapeHtml (no query
    // chars needing escaping in a short code, so this also pins that
    // safeUrl's allowlist does not rewrite an ordinary https URL).
    expect(rendered.html).toContain(`href="${url}"`);
    expect(rendered.text).toContain(`${LINK_LABEL}: ${url}`);

    // Directly after the primary CTA button, ahead of the secondary safety
    // chip: in the html, "Take another look" appears, then the consultation
    // link's paragraph, then the safety-chip button — in that order.
    const takeAnotherLookIdx = rendered.html.indexOf('Take another look');
    const consultationIdx = rendered.html.indexOf(url);
    const safetyChipIdx = rendered.html.indexOf('products &amp; safety');
    expect(takeAnotherLookIdx).toBeGreaterThan(-1);
    expect(consultationIdx).toBeGreaterThan(takeAnotherLookIdx);
    expect(safetyChipIdx).toBeGreaterThan(consultationIdx);
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

  test('the template row does not exist in this environment — a clean no-op, nothing written', async () => {
    await db.transaction(async (trx) => {
      // No email_templates row for estimate.engage_gone_quiet at all (a
      // fresh/partial environment where the 20260715200000 seed never ran).
      await expect(migration.up(trx)).resolves.toBeUndefined();
      expect(await trx('email_templates').count('* as n').first()).toEqual({ n: '0' });
      expect(await trx('email_template_versions').count('* as n').first()).toEqual({ n: '0' });
      expect(await trx('audit_log').count('* as n').first()).toEqual({ n: '0' });
      await trx.rollback();
    });
  });

  test('an active version with NO cta block throws (fail loud) and writes NOTHING', async () => {
    await db.transaction(async (trx) => {
      const blocksWithoutCta = [
        { type: 'paragraph', content: 'Hi {{first_name}}, just checking in on your {{service_label}} estimate.' },
        { type: 'signature', content: '— The Waves Team' },
      ];
      const [template] = await trx('email_templates').insert({
        template_key: 'estimate.engage_gone_quiet', status: 'active', from_email: 'contact@wavespestcontrol.com',
        send_stream: 'service_operational',
        allowed_variables: JSON.stringify(['first_name', 'service_label']),
        optional_variables: JSON.stringify([]), required_variables: JSON.stringify(['first_name', 'service_label']),
      }).returning('*');
      const [version] = await trx('email_template_versions').insert({
        template_id: template.id, version_number: 1, status: 'active',
        subject: 'Any questions about your Waves estimate?', preview_text: 'Reply and ask — real answers in minutes.',
        blocks: JSON.stringify(blocksWithoutCta), validation_snapshot: JSON.stringify({ staff_reviewed: true }),
      }).returning('*');
      await trx('email_templates').where({ id: template.id }).update({ active_version_id: version.id });

      await expect(migration.up(trx)).rejects.toThrow(/no primary CTA block found/);

      // Nothing changed: same active version, no new version row, template
      // row's own fields untouched, no audit event recorded.
      const afterThrow = await trx('email_templates').where({ id: template.id }).first();
      expect(afterThrow.active_version_id).toBe(version.id);
      expect(afterThrow.allowed_variables).toEqual(['first_name', 'service_label']);
      expect(await trx('email_template_versions').where({ template_id: template.id }).count('* as n').first())
        .toEqual({ n: '1' });
      expect(await trx('audit_log').where({ resource_id: template.id }).count('* as n').first())
        .toEqual({ n: '0' });

      await trx.rollback();
    });
  });
});
