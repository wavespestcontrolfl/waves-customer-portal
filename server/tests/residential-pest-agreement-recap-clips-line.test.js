// 20261101233000_residential_pest_agreement_recap_clips_line (owner 2026-11-01, "approved"): the visit-recap
// clips line becomes its own paragraph after "Customer responsibilities" in the Residential Pest Service
// Agreement, as a NEW active version; older versions and the lawn agreement are untouched, and a re-run
// adds nothing. The first block is pure. The second runs the migration against the migrated PostgreSQL
// database inside a transaction that is rolled back. Skips without DATABASE_URL (CI runs it).
const SKIP = !process.env.DATABASE_URL;

const knexLib = require('knex');
const migration = require('../models/migrations/20261101233000_residential_pest_agreement_recap_clips_line');

const LINE = 'Visit recap: your technician may record short video clips of the work for your visit recap.';
const PEST_KEY = 'service_agreement.residential_pest';
const LAWN_KEY = 'service_agreement.lawn_ornamental';

describe('recap clips line and splice (pure)', () => {
  test('the line is pinned verbatim to the owner-approved wording', () => {
    expect(migration.RECAP_CLIPS_LINE).toBe(LINE);
    expect(migration.TEMPLATE_KEY).toBe(PEST_KEY);
  });

  test('adds the line as its own paragraph right after the Customer responsibilities paragraph', () => {
    const body = 'Heading\n\nCustomer responsibilities: provide safe access.\n\nCancellation and changes: in writing.';
    const result = migration.spliceRecapClipsLine(body);
    expect(result).toEqual({
      body: `Heading\n\nCustomer responsibilities: provide safe access.\n\n${LINE}\n\nCancellation and changes: in writing.`,
      changed: true,
      reason: null,
    });
  });

  test('a Customer responsibilities paragraph at the end gets the line after it', () => {
    expect(migration.spliceRecapClipsLine('Intro.\n\nCustomer responsibilities: access.').body)
      .toBe(`Intro.\n\nCustomer responsibilities: access.\n\n${LINE}`);
  });

  test('is idempotent: a body that already carries the line is returned unchanged', () => {
    const once = migration.spliceRecapClipsLine('Customer responsibilities: access.\n\nTail.');
    expect(migration.spliceRecapClipsLine(once.body)).toEqual({ body: once.body, changed: false, reason: 'already_present' });
  });

  test('no paragraph starting with Customer responsibilities: nothing is spliced', () => {
    expect(migration.spliceRecapClipsLine('Intro. See Customer responsibilities: below.\n\nTail.'))
      .toMatchObject({ changed: false, reason: 'anchor_missing' });
    expect(migration.spliceRecapClipsLine('No such paragraph.')).toMatchObject({ changed: false, reason: 'anchor_missing' });
  });
});

const describeDb = SKIP ? describe.skip : describe;

describeDb('recap clips line migration (PostgreSQL, rolled back)', () => {
  let database;
  let trx;
  beforeAll(() => {
    database = knexLib({ client: 'pg', connection: process.env.DATABASE_URL, pool: { min: 0, max: 2 } });
  });
  beforeEach(async () => {
    trx = await database.transaction();
    await asBeforeTheLine();
  });
  afterEach(async () => { await trx.rollback(); });
  afterAll(async () => { if (database) await database.destroy(); });

  // CI migrates every file first, this one included: put the pest agreement back to a version without
  // the line (made active), so each test runs the migration from the state it was written for.
  async function asBeforeTheLine() {
    const { template, active } = await activeOf(PEST_KEY);
    if (!active || !active.body.includes(LINE)) return;
    const top = await trx('document_template_versions').where({ template_id: template.id }).max('version_number as max').first();
    const [prior] = await trx('document_template_versions').insert({
      template_id: template.id,
      version_number: Number(top.max) + 1,
      title: active.title,
      body: active.body.replace(`\n\n${LINE}`, ''),
      signer_disclosure: active.signer_disclosure,
      variables: JSON.stringify(active.variables ?? []),
      required_fields: JSON.stringify(active.required_fields ?? ['initials', 'signedName']),
      created_by: null,
      published_at: trx.fn.now(),
    }).returning('*');
    await trx('document_templates').where({ id: template.id }).update({ active_version_id: prior.id });
  }

  async function activeOf(key) {
    const template = await trx('document_templates').where({ template_key: key }).first();
    if (!template) return { template: null, active: null };
    const active = await trx('document_template_versions').where({ id: template.active_version_id }).first();
    return { template, active };
  }

  test('the pest agreement gets a new active version with the line once; older versions and the lawn agreement stay', async () => {
    const before = await activeOf(PEST_KEY);
    expect(before.active).toBeTruthy();
    expect(before.active.body).toContain('Customer responsibilities:');
    const lawnBefore = await activeOf(LAWN_KEY);

    await migration.up(trx);

    const after = await activeOf(PEST_KEY);
    expect(before.active.body).not.toContain(LINE);
    expect(after.active.id).not.toBe(before.active.id);
    expect(after.active.body).toBe(migration.spliceRecapClipsLine(before.active.body).body);
    expect(after.active.body.split(LINE).length - 1).toBe(1);
    expect(after.active.title).toBe(before.active.title);
    const oldRow = await trx('document_template_versions').where({ id: before.active.id }).first();
    expect(oldRow.body).toBe(before.active.body);
    const lawnAfter = await activeOf(LAWN_KEY);
    expect(lawnAfter.active?.id).toBe(lawnBefore.active?.id);
  });

  test('a second run adds no version', async () => {
    await migration.up(trx);
    const once = await activeOf(PEST_KEY);
    const count = await trx('document_template_versions').where({ template_id: once.template.id }).count('* as n').first();

    await migration.up(trx);

    const twice = await activeOf(PEST_KEY);
    const countAgain = await trx('document_template_versions').where({ template_id: once.template.id }).count('* as n').first();
    expect(twice.active.id).toBe(once.active.id);
    expect(Number(countAgain.n)).toBe(Number(count.n));
  });
});
