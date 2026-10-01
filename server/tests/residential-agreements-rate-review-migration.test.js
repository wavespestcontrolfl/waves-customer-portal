/**
 * 20260930213000_residential_agreements_rate_review_sentence — adds the
 * annual rate-review disclosure to the two RESIDENTIAL signable agreements
 * as a NEW active version each, leaving every existing version row and
 * every existing send (customer_contracts) untouched.
 *
 * The first block is pure (always runs). The second runs the migration
 * against real PostgreSQL in a scratch schema (same harness and local-only
 * safety as termite-annual-v3-countersignature-clause-migration.test.js):
 *   REPAIR_TEST_DATABASE_URL=postgresql://waves_user@localhost:5432/waves_test \
 *     npm exec jest -- --runInBand server/tests/residential-agreements-rate-review-migration.test.js
 */
const knexLib = require('knex');
const { randomUUID } = require('crypto');
const library = require('../models/migrations/20260601000009_document_template_library');
const lawnSeed = require('../models/migrations/20260623000006_seed_lawn_ornamental_agreement');
const commercialSeed = require('../models/migrations/20260623000005_seed_commercial_service_agreement');
const migration = require('../models/migrations/20260930213000_residential_agreements_rate_review_sentence');
const {
  buildCustomerDocumentContext,
  renderDocumentTemplate,
} = require('../services/document-template-library');

const LAWN_KEY = 'service_agreement.lawn_ornamental';
const PEST_KEY = 'service_agreement.residential_pest';
const COMMERCIAL_KEY = 'service_agreement.commercial_pest';

// Byte-for-byte the "Services" line suffix the estimate acceptance drawer
// shows (server/services/acceptance-terms-text.js, PR #5434). If the owner
// edits the sentence there, this pin and the migration change together.
const SENTENCE = 'Rates are reviewed once a year after your first 12 months, with at least 30 days’ written notice before any change.';

describe('rate-review sentence and splice (pure)', () => {
  test('the sentence is pinned verbatim to the acceptance drawer wording', () => {
    expect(migration.RATE_REVIEW_SENTENCE).toBe(SENTENCE);
    expect(migration.RATE_REVIEW_SENTENCE).not.toMatch(/per visit/i);
    expect(migration.RATE_REVIEW_SENTENCE).not.toMatch(/\$|\d+\.\d{2}/);
  });

  test('targets exactly the two residential agreements — termite and commercial are left alone', () => {
    expect(migration.TARGETS.map((t) => t.template_key).sort()).toEqual([LAWN_KEY, PEST_KEY]);
    for (const target of migration.TARGETS) {
      expect(target.anchor).toMatch(/pricing/);
      expect(target.anchor.endsWith('.')).toBe(true);
    }
  });

  test('splices the sentence right after the pricing sentence, inside the same paragraph, exactly once', () => {
    const anchor = migration.TARGETS[0].anchor;
    const body = `Heading\n\nScope of service: Waves Pest Control, LLC will provide the services. ${anchor}\n\nTerm and cancellation: ongoing.`;
    const result = migration.spliceRateReviewSentence(body, anchor);
    expect(result.changed).toBe(true);
    expect(result.reason).toBeNull();
    expect(result.body).toBe(`Heading\n\nScope of service: Waves Pest Control, LLC will provide the services. ${anchor} ${SENTENCE}\n\nTerm and cancellation: ongoing.`);
    expect(result.body.split(SENTENCE).length - 1).toBe(1);
  });

  test('is idempotent: a body that already carries the sentence is returned unchanged', () => {
    const anchor = migration.TARGETS[1].anchor;
    const once = migration.spliceRateReviewSentence(`Intro. ${anchor} Tail.`, anchor);
    const twice = migration.spliceRateReviewSentence(once.body, anchor);
    expect(twice).toEqual({ body: once.body, changed: false, reason: 'already_present' });
  });

  test('refuses to splice when the pricing sentence was edited away (no safe splice point)', () => {
    const result = migration.spliceRateReviewSentence('Scope of service: an operator rewrote this paragraph.', migration.TARGETS[0].anchor);
    expect(result).toEqual({ body: 'Scope of service: an operator rewrote this paragraph.', changed: false, reason: 'anchor_missing' });
  });
});

const SKIP = !process.env.REPAIR_TEST_DATABASE_URL;
const describeOrSkip = SKIP ? describe.skip : describe;

async function createScratchDb() {
  const url = new URL(process.env.REPAIR_TEST_DATABASE_URL);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || !['/invoice_repair_test', '/waves_test'].includes(url.pathname)) {
    throw new Error('This test requires a local invoice_repair_test or waves_test database');
  }
  const schema = `rate_review_${randomUUID().replace(/-/g, '')}`;
  const db = knexLib({ client: 'pg', connection: url.toString(), searchPath: [schema], pool: { min: 0, max: 4 } });
  await db.raw('CREATE SCHEMA ??', [schema]);
  // The library tables as 20260601000009 creates them (minus the
  // technicians FKs), plus the customer_contracts document columns that
  // migration adds, so its up() seeds without altering anything, and the
  // two tables a comms side effect would have to write to.
  await db.raw(`
    CREATE TABLE document_templates (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      template_key varchar(120) NOT NULL UNIQUE,
      name varchar(180) NOT NULL,
      category varchar(80) NOT NULL DEFAULT 'general',
      document_type varchar(80) NOT NULL DEFAULT 'other',
      status varchar(30) NOT NULL DEFAULT 'active',
      description text,
      requires_signature boolean NOT NULL DEFAULT true,
      audience varchar(60) NOT NULL DEFAULT 'customer',
      variables jsonb NOT NULL DEFAULT '[]'::jsonb,
      tags jsonb NOT NULL DEFAULT '[]'::jsonb,
      active_version_id uuid,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE document_template_versions (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      template_id uuid NOT NULL REFERENCES document_templates(id) ON DELETE CASCADE,
      version_number integer NOT NULL,
      title varchar(220) NOT NULL,
      body text NOT NULL,
      signer_disclosure text,
      variables jsonb NOT NULL DEFAULT '[]'::jsonb,
      required_fields jsonb NOT NULL DEFAULT '[]'::jsonb,
      created_by uuid,
      published_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (template_id, version_number)
    );
    CREATE TABLE customer_contracts (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      customer_id uuid NOT NULL,
      contract_type varchar(60) NOT NULL,
      title text,
      status varchar(30) NOT NULL,
      contract_text_snapshot text,
      document_template_id uuid REFERENCES document_templates(id) ON DELETE SET NULL,
      document_template_version_id uuid REFERENCES document_template_versions(id) ON DELETE SET NULL,
      document_template_key varchar(120),
      document_variables_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
      document_render_summary jsonb NOT NULL DEFAULT '{}'::jsonb,
      cancelled_at timestamptz,
      cancelled_reason text,
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE customer_contract_events (
      id serial PRIMARY KEY,
      contract_id uuid NOT NULL,
      customer_id uuid NOT NULL,
      event_type varchar(60) NOT NULL,
      actor_type varchar(30),
      metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE notifications (
      id serial PRIMARY KEY,
      title text,
      body text,
      created_at timestamptz NOT NULL DEFAULT now()
    );
  `);
  return { db, async destroy() { await db.raw('DROP SCHEMA ?? CASCADE', [schema]); await db.destroy(); } };
}

// The join the admin issue route (templateQuery) and the bulk-send service
// use to pick the version a NEW send renders from.
async function activeVersionFor(db, key) {
  return db('document_templates as dt')
    .leftJoin('document_template_versions as av', 'dt.active_version_id', 'av.id')
    .where('dt.template_key', key)
    .first('dt.id as template_id', 'dt.template_key', 'dt.name', 'dt.active_version_id', 'dt.updated_at', 'av.id as version_id', 'av.version_number', 'av.title', 'av.body', 'av.signer_disclosure', 'av.published_at');
}

async function versionsFor(db, key) {
  const template = await db('document_templates').where({ template_key: key }).first('id');
  return db('document_template_versions').where({ template_id: template.id }).orderBy('version_number', 'asc');
}

const SYNTHETIC_CUSTOMER = {
  id: null,
  first_name: 'Stan',
  last_name: 'Sample',
  email: 'stan@example.com',
  phone: '9415550000',
  address_line1: '123 Perimeter Way',
  city: 'Bradenton',
  state: 'FL',
  zip: '34202',
};
const CONTEXT_VALUES = { service: { name: 'Lawn program' }, agreement: { start_date: '2026-10-01' } };

async function seedAll(db) {
  await library.up(db); // residential_pest scaffold (+ wdo notice, bed bug prep)
  await lawnSeed.up(db);
  await commercialSeed.up(db);
}

// An open (unsigned) send issued from the lawn v1 wording BEFORE the
// migration — the shape the admin issue route writes.
async function issueOpenSend(db, key) {
  const loaded = await activeVersionFor(db, key);
  const rendered = renderDocumentTemplate({
    template: { template_key: loaded.template_key, name: loaded.name },
    version: { id: loaded.version_id, version_number: loaded.version_number, title: loaded.title, body: loaded.body },
    context: buildCustomerDocumentContext(SYNTHETIC_CUSTOMER, CONTEXT_VALUES),
  });
  const [row] = await db('customer_contracts').insert({
    customer_id: randomUUID(),
    contract_type: 'document_template',
    title: rendered.title,
    status: 'sent',
    contract_text_snapshot: rendered.body,
    document_template_id: loaded.template_id,
    document_template_version_id: loaded.version_id,
    document_template_key: key,
    document_render_summary: JSON.stringify(rendered.renderSummary),
  }).returning('*');
  return row;
}

describeOrSkip('20260930213000_residential_agreements_rate_review_sentence — real Postgres', () => {
  let fixture;
  beforeEach(async () => { fixture = await createScratchDb(); });
  afterEach(async () => { if (fixture) await fixture.destroy(); });

  test('adds version 2 with the sentence to both residential templates, repoints new sends to it, and leaves version 1 byte-identical', async () => {
    const { db } = fixture;
    await seedAll(db);
    const before = {
      [LAWN_KEY]: await versionsFor(db, LAWN_KEY),
      [PEST_KEY]: await versionsFor(db, PEST_KEY),
    };
    expect(before[LAWN_KEY]).toHaveLength(1);
    expect(before[PEST_KEY]).toHaveLength(1);
    expect(before[LAWN_KEY][0].body).not.toContain(SENTENCE);
    expect(before[PEST_KEY][0].body).not.toContain(SENTENCE);

    await migration.up(db);

    for (const key of [LAWN_KEY, PEST_KEY]) {
      const target = migration.TARGETS.find((t) => t.template_key === key);
      const versions = await versionsFor(db, key);
      expect(versions).toHaveLength(2);
      const [v1, v2] = versions;
      // The old version row is untouched — every column, not just the body.
      expect(v1).toEqual(before[key][0]);
      // The new version is the old body with the sentence spliced after the pricing sentence, once.
      expect(v2.version_number).toBe(2);
      expect(v2.body).toBe(migration.spliceRateReviewSentence(v1.body, target.anchor).body);
      expect(v2.body).toContain(`${target.anchor} ${SENTENCE}`);
      expect(v2.body.split(SENTENCE).length - 1).toBe(1);
      expect(v2.title).toBe(v1.title);
      expect(v2.signer_disclosure).toBe(v1.signer_disclosure);
      expect(v2.variables).toEqual(v1.variables);
      expect(v2.required_fields).toEqual(v1.required_fields);
      expect(v2.published_at).not.toBeNull();
      // Sentence wording hygiene inside the signed document.
      expect(v2.body).not.toMatch(/per visit/i);
      expect(v2.body).toContain('Waves Pest Control, LLC');
      // NEW sends resolve the active pointer at issue time — the join the
      // admin issue route and bulk send use now lands on v2 ...
      const live = await activeVersionFor(db, key);
      expect(live.active_version_id).toBe(v2.id);
      expect(live.version_id).toBe(v2.id);
      // ... and the rendered body a new send would snapshot carries the sentence with no unresolved merge fields.
      const rendered = renderDocumentTemplate({
        template: { template_key: live.template_key, name: live.name },
        version: { id: live.version_id, version_number: live.version_number, title: live.title, body: live.body },
        context: buildCustomerDocumentContext(SYNTHETIC_CUSTOMER, CONTEXT_VALUES),
      });
      expect(rendered.body).toContain(SENTENCE);
      expect(rendered.unresolvedVariables).toEqual([]);
      expect(rendered.renderSummary.templateVersionId).toBe(v2.id);
    }
  });

  test('an open (unsigned) send issued before the migration keeps its original version and wording, and nothing is cancelled, re-sent, or belled', async () => {
    const { db } = fixture;
    await seedAll(db);
    const open = await issueOpenSend(db, LAWN_KEY);
    const [lawnV1] = await versionsFor(db, LAWN_KEY);
    expect(open.document_template_version_id).toBe(lawnV1.id);
    expect(open.contract_text_snapshot).not.toContain(SENTENCE);

    await migration.up(db);

    const after = await db('customer_contracts').where({ id: open.id }).first();
    expect(after).toEqual(open);
    expect(after.status).toBe('sent');
    expect(after.cancelled_at).toBeNull();
    expect(after.document_template_version_id).toBe(lawnV1.id);
    expect(after.contract_text_snapshot).not.toContain(SENTENCE);
    // Version 1 is still there to be pointed at (nothing deleted), it is just no longer the active one.
    const [v1Still] = await versionsFor(db, LAWN_KEY);
    expect(v1Still.id).toBe(lawnV1.id);
    expect((await activeVersionFor(db, LAWN_KEY)).active_version_id).not.toBe(lawnV1.id);
    // No comms side effect: no cancellation event, no admin bell.
    expect(await db('customer_contract_events').count('* as n').first()).toEqual({ n: '0' });
    expect(await db('notifications').count('* as n').first()).toEqual({ n: '0' });
  });

  test('the commercial agreement and the other library documents are not touched', async () => {
    const { db } = fixture;
    await seedAll(db);
    const snapshotTemplates = async () => db('document_templates').orderBy('template_key').select('template_key', 'active_version_id', 'status', 'updated_at');
    const untouchedBefore = (await snapshotTemplates()).filter((t) => ![LAWN_KEY, PEST_KEY].includes(t.template_key));
    expect(untouchedBefore.map((t) => t.template_key)).toEqual(expect.arrayContaining([COMMERCIAL_KEY, 'notice.wdo_inspection', 'prep.bed_bug']));
    const versionCountBefore = Number((await db('document_template_versions').count('* as n').first()).n);

    await migration.up(db);

    const untouchedAfter = (await snapshotTemplates()).filter((t) => ![LAWN_KEY, PEST_KEY].includes(t.template_key));
    expect(untouchedAfter).toEqual(untouchedBefore);
    expect(Number((await db('document_template_versions').count('* as n').first()).n)).toBe(versionCountBefore + 2);
    expect((await versionsFor(db, COMMERCIAL_KEY))).toHaveLength(1);
  });

  test('is idempotent: a second run adds nothing and moves nothing', async () => {
    const { db } = fixture;
    await seedAll(db);
    await migration.up(db);
    const snapshot = async () => ({
      templates: await db('document_templates').orderBy('template_key').select('template_key', 'active_version_id', 'updated_at'),
      versions: await db('document_template_versions').orderBy(['template_id', 'version_number']).select('id', 'template_id', 'version_number', 'body', 'published_at'),
    });
    const first = await snapshot();
    await migration.up(db);
    expect(await snapshot()).toEqual(first);
  });

  test('preserves an admin edit made since the seed: the sentence is added to the LIVE body, not the seed text', async () => {
    const { db } = fixture;
    await seedAll(db);
    const [v1] = await versionsFor(db, LAWN_KEY);
    const target = migration.TARGETS.find((t) => t.template_key === LAWN_KEY);
    const edited = v1.body.replace('Limitation: Waves is not responsible', 'Limitation (edited by the office): Waves is not responsible');
    expect(edited).not.toBe(v1.body);
    await db('document_template_versions').where({ id: v1.id }).update({ body: edited });

    await migration.up(db);

    const [, v2] = await versionsFor(db, LAWN_KEY);
    expect(v2.body).toContain('Limitation (edited by the office)');
    expect(v2.body).toContain(`${target.anchor} ${SENTENCE}`);
    expect(v2.body).toBe(migration.spliceRateReviewSentence(edited, target.anchor).body);
  });

  test('leaves a template alone when its pricing sentence was edited away, when it already carries the sentence, or when it has no active version', async () => {
    const { db } = fixture;
    await seedAll(db);
    const lawn = await db('document_templates').where({ template_key: LAWN_KEY }).first();
    const pest = await db('document_templates').where({ template_key: PEST_KEY }).first();
    const [lawnV1] = await versionsFor(db, LAWN_KEY);
    const [pestV1] = await versionsFor(db, PEST_KEY);
    // Lawn: the office rewrote the scope paragraph — no safe splice point.
    await db('document_template_versions').where({ id: lawnV1.id }).update({ body: 'Lawn & Ornamental Service Agreement\n\nScope of service: rewritten by the office.' });
    // Pest: the office already added the sentence by hand.
    await db('document_template_versions').where({ id: pestV1.id }).update({ body: `${pestV1.body}\n\n${SENTENCE}` });

    await migration.up(db);

    expect(await versionsFor(db, LAWN_KEY)).toHaveLength(1);
    expect((await db('document_templates').where({ id: lawn.id }).first()).active_version_id).toBe(lawnV1.id);
    expect(await versionsFor(db, PEST_KEY)).toHaveLength(1);
    expect((await db('document_templates').where({ id: pest.id }).first()).active_version_id).toBe(pestV1.id);

    // No active version: nothing to derive from — the operator publishes by hand.
    await db('document_template_versions').where({ id: lawnV1.id }).update({ body: lawnV1.body });
    await db('document_templates').where({ id: lawn.id }).update({ active_version_id: null });
    await migration.up(db);
    expect(await versionsFor(db, LAWN_KEY)).toHaveLength(1);
    expect((await db('document_templates').where({ id: lawn.id }).first()).active_version_id).toBeNull();
  });

  test('reuses a version whose body already equals the spliced text instead of inserting a duplicate', async () => {
    const { db } = fixture;
    await seedAll(db);
    const lawn = await db('document_templates').where({ template_key: LAWN_KEY }).first();
    const [v1] = await versionsFor(db, LAWN_KEY);
    const target = migration.TARGETS.find((t) => t.template_key === LAWN_KEY);
    // An unpublished admin draft that already carries exactly the spliced wording.
    const [draft] = await db('document_template_versions').insert({
      template_id: lawn.id,
      version_number: 2,
      title: v1.title,
      body: migration.spliceRateReviewSentence(v1.body, target.anchor).body,
      signer_disclosure: v1.signer_disclosure,
      variables: JSON.stringify(v1.variables),
      required_fields: JSON.stringify(v1.required_fields),
      published_at: null,
    }).returning('*');

    await migration.up(db);

    const versions = await versionsFor(db, LAWN_KEY);
    expect(versions).toHaveLength(2);
    const live = await activeVersionFor(db, LAWN_KEY);
    expect(live.active_version_id).toBe(draft.id);
    expect(live.published_at).not.toBeNull();
  });

  test('down() is a documented no-op: the pointer stays on version 2 and every row stays', async () => {
    const { db } = fixture;
    await seedAll(db);
    await migration.up(db);
    const templatesBefore = await db('document_templates').orderBy('template_key').select('template_key', 'active_version_id');
    const versionsBefore = await db('document_template_versions').orderBy(['template_id', 'version_number']).select('id', 'body', 'published_at');

    await migration.down(db);

    expect(await db('document_templates').orderBy('template_key').select('template_key', 'active_version_id')).toEqual(templatesBefore);
    expect(await db('document_template_versions').orderBy(['template_id', 'version_number']).select('id', 'body', 'published_at')).toEqual(versionsBefore);
    expect((await activeVersionFor(db, LAWN_KEY)).version_number).toBe(2);
  });

  test('no-ops when the templates were never seeded or the tables are absent', async () => {
    const { db } = fixture;
    await expect(migration.up(db)).resolves.toBeUndefined();
    expect(Number((await db('document_template_versions').count('* as n').first()).n)).toBe(0);
    await db.raw('DROP TABLE customer_contracts; DROP TABLE document_template_versions; DROP TABLE document_templates;');
    await expect(migration.up(db)).resolves.toBeUndefined();
    await expect(migration.down(db)).resolves.toBeUndefined();
  });
});
