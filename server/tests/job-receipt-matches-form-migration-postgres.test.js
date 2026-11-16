// CI's DB-gated pass runs this against PostgreSQL. Fixture data lives in a
// unique schema dropped after the suite.
//
// 20261112210000_job_receipt_matches_form (owner 2026-11-12: the application
// receipt stops promising a reply "within 2 business days"):
//  - the base sms_templates rows of the two receipt texts AND a matching
//    sms_template_variants row swap, and each changed row gets its own
//    audit_log event;
//  - a base or variant row an admin already edited is left alone and never
//    audited; the other recruiting texts are not touched;
//  - down() reverts exactly the tracked rows, and an admin edit made after
//    up() survives it.
const SKIP = !process.env.DATABASE_URL;
const knex = require('knex');
const { randomUUID } = require('crypto');

const migration = require('../models/migrations/20261112210000_job_receipt_matches_form');

const { _SWAPS: SWAPS, _AUDIT_ACTION: AUDIT_ACTION, _AUDIT_ROLLBACK_ACTION: ROLLBACK_ACTION } = migration;
const BEFORE = Object.fromEntries(SWAPS.map(([key, before]) => [key, before]));
const AFTER = Object.fromEntries(SWAPS.map(([key, , after]) => [key, after]));
const KEYS = SWAPS.map(([key]) => key);
const INVITE_BODY = 'Hi {first_name}, Waves would like to interview you. Pick a phone or in-person time that works for you: {interview_url}';

jest.setTimeout(30000);
(SKIP ? describe.skip : describe)('job-receipt-matches-form migration on PostgreSQL', () => {
  let database;
  const schema = `job_receipt_copy_${randomUUID().replaceAll('-', '')}`;
  const tables = ['sms_templates', 'sms_template_variants', 'audit_log'];

  beforeAll(async () => {
    database = knex({ client: 'pg', connection: process.env.DATABASE_URL, searchPath: [schema], pool: { min: 0, max: 3 } });
    await database.raw('CREATE SCHEMA ??', [schema]);
    for (const table of tables) await database.raw('CREATE TABLE ??.?? AS SELECT * FROM public.?? WITH NO DATA', [schema, table, table]);
  });
  afterEach(async () => {
    for (const table of tables) await database.raw('TRUNCATE TABLE ??.?? CASCADE', [schema, table]);
  });
  afterAll(async () => {
    await database.raw('DROP SCHEMA ?? CASCADE', [schema]);
    await database.destroy();
  });

  const seedTemplate = (key, body) => database('sms_templates').insert({
    id: randomUUID(), template_key: key, name: key, category: 'recruiting', body,
    variables: JSON.stringify([]), sort_order: 100, is_active: true,
  }).returning('id').then(([r]) => r.id);
  const seedVariant = (key, variantKey, body) => database('sms_template_variants').insert({
    id: randomUUID(), template_key: key, variant_key: variantKey, body,
  }).returning('id').then(([r]) => r.id);
  const bodyOf = async (table, id) => (await database(table).where({ id }).first('body'))?.body;
  const auditRows = (action) => database('audit_log').where({ action }).select('resource_type', 'resource_id', 'metadata');
  const meta = (row) => (typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata);

  test('the two receipt rows and a matching variant swap and are each audited; down() reverts exactly those rows', async () => {
    const baseIds = {};
    for (const key of KEYS) baseIds[key] = await seedTemplate(key, BEFORE[key]);
    const variantId = await seedVariant('job_application_received', 'shorter', BEFORE.job_application_received);
    const customVariantId = await seedVariant('job_application_received_es', 'custom', 'Adam wrote this variant by hand.');
    const inviteId = await seedTemplate('job_interview_invite', INVITE_BODY);

    await migration.up(database);

    for (const key of KEYS) expect(await bodyOf('sms_templates', baseIds[key])).toBe(AFTER[key]);
    expect(await bodyOf('sms_template_variants', variantId)).toBe(AFTER.job_application_received);
    expect(await bodyOf('sms_template_variants', customVariantId)).toBe('Adam wrote this variant by hand.');
    expect(await bodyOf('sms_templates', inviteId)).toBe(INVITE_BODY);

    const tracked = await auditRows(AUDIT_ACTION);
    expect(tracked.map((row) => `${row.resource_type}:${row.resource_id}`).sort()).toEqual([
      ...KEYS.map((key) => `sms_templates:${baseIds[key]}`),
      `sms_template_variants:${variantId}`,
    ].sort());
    for (const row of tracked) expect(meta(row).migration).toBe('20261112210000_job_receipt_matches_form');

    // A second up() finds no row at its "before" text: nothing changes, nothing more is tracked.
    await migration.up(database);
    expect(await auditRows(AUDIT_ACTION)).toHaveLength(3);

    await migration.down(database);

    for (const key of KEYS) expect(await bodyOf('sms_templates', baseIds[key])).toBe(BEFORE[key]);
    expect(await bodyOf('sms_template_variants', variantId)).toBe(BEFORE.job_application_received);
    expect(await bodyOf('sms_template_variants', customVariantId)).toBe('Adam wrote this variant by hand.');
    expect(await auditRows(ROLLBACK_ACTION)).toHaveLength(3);
  });

  test('a receipt row an admin edited before up() is skipped and never tracked', async () => {
    const editedId = await seedTemplate('job_application_received', 'Hi {first_name}, we got your application. Reply STOP to opt out.');
    await migration.up(database);
    expect(await bodyOf('sms_templates', editedId)).toBe('Hi {first_name}, we got your application. Reply STOP to opt out.');
    expect(await auditRows(AUDIT_ACTION)).toHaveLength(0);
  });

  test('an admin edit made after up() survives down()', async () => {
    const id = await seedTemplate('job_application_received_es', BEFORE.job_application_received_es);
    await migration.up(database);
    await database('sms_templates').where({ id }).update({ body: 'Edited by the office after the swap.' });
    await migration.down(database);
    expect(await bodyOf('sms_templates', id)).toBe('Edited by the office after the swap.');
    expect(await auditRows(ROLLBACK_ACTION)).toHaveLength(0);
  });
});
