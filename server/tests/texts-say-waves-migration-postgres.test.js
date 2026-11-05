// CI's DB-gated pass runs this against PostgreSQL. Fixture data lives in a
// unique schema dropped after the suite.
//
// 20261105000000_texts_say_waves (owner 2026-11-04: texts say "Waves"):
//  - the base sms_templates rows of the four recruiting texts AND a matching
//    sms_template_variants row swap, and each changed row gets its own
//    audit_log event;
//  - a variant or base row an admin already edited is left alone and never
//    audited; another template that still names "Waves Pest Control" (the
//    opt-in request) is not touched;
//  - down() reverts exactly the tracked rows, and an admin edit made after
//    up() survives it.
const SKIP = !process.env.DATABASE_URL;
const knex = require('knex');
const { randomUUID } = require('crypto');

const migration = require('../models/migrations/20261105000000_texts_say_waves');

const { _SWAPS: SWAPS, _AUDIT_ACTION: AUDIT_ACTION, _AUDIT_ROLLBACK_ACTION: ROLLBACK_ACTION } = migration;
const BEFORE = Object.fromEntries(SWAPS.map(([key, before]) => [key, before]));
const AFTER = Object.fromEntries(SWAPS.map(([key, , after]) => [key, after]));
const KEYS = SWAPS.map(([key]) => key);
const OPTIN_BODY = 'Hello {recipient_first_name}! {account_first_name} added you to receive appointment and service texts from Waves Pest Control for {property_address}.';

jest.setTimeout(30000);
(SKIP ? describe.skip : describe)('texts-say-waves migration on PostgreSQL', () => {
  let database;
  const schema = `texts_say_waves_${randomUUID().replaceAll('-', '')}`;
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

  test('the four base rows and a matching variant swap and are each audited; down() reverts exactly those rows', async () => {
    const baseIds = {};
    for (const key of KEYS) baseIds[key] = await seedTemplate(key, BEFORE[key]);
    const variantId = await seedVariant('job_interview_invite', 'shorter', BEFORE.job_interview_invite);
    const customVariantId = await seedVariant('job_application_received', 'custom', 'Adam wrote this variant by hand.');
    const optinId = await seedTemplate('recipient_optin_request', OPTIN_BODY);

    await migration.up(database);

    for (const key of KEYS) expect(await bodyOf('sms_templates', baseIds[key])).toBe(AFTER[key]);
    expect(await bodyOf('sms_template_variants', variantId)).toBe(AFTER.job_interview_invite);
    expect(await bodyOf('sms_template_variants', customVariantId)).toBe('Adam wrote this variant by hand.');
    expect(await bodyOf('sms_templates', optinId)).toBe(OPTIN_BODY);

    const tracked = await auditRows(AUDIT_ACTION);
    expect(tracked.map((row) => `${row.resource_type}:${row.resource_id}`).sort()).toEqual([
      ...KEYS.map((key) => `sms_templates:${baseIds[key]}`),
      `sms_template_variants:${variantId}`,
    ].sort());
    for (const row of tracked) expect(meta(row).migration).toBe('20261105000000_texts_say_waves');

    await migration.down(database);

    for (const key of KEYS) expect(await bodyOf('sms_templates', baseIds[key])).toBe(BEFORE[key]);
    expect(await bodyOf('sms_template_variants', variantId)).toBe(BEFORE.job_interview_invite);
    expect(await bodyOf('sms_template_variants', customVariantId)).toBe('Adam wrote this variant by hand.');
    expect(await auditRows(ROLLBACK_ACTION)).toHaveLength(5);
  });

  test('a base row an admin edited before up() is skipped and never tracked', async () => {
    const editedId = await seedTemplate('job_interview_invite', 'Hi {first_name}, pick a time: {interview_url}');
    await migration.up(database);
    expect(await bodyOf('sms_templates', editedId)).toBe('Hi {first_name}, pick a time: {interview_url}');
    expect(await auditRows(AUDIT_ACTION)).toHaveLength(0);
  });

  test('an admin edit made after up() survives down()', async () => {
    const id = await seedTemplate('job_application_received', BEFORE.job_application_received);
    await migration.up(database);
    await database('sms_templates').where({ id }).update({ body: 'Edited by the office after the swap.' });
    await migration.down(database);
    expect(await bodyOf('sms_templates', id)).toBe('Edited by the office after the swap.');
    expect(await auditRows(ROLLBACK_ACTION)).toHaveLength(0);
  });

  // 20261105000100_optin_text_says_waves (owner "change": the consent texts too).
  describe('the opt-in request follow-up', () => {
    const optin = require('../models/migrations/20261105000100_optin_text_says_waves');

    test('the base row and a matching variant swap and are audited; an edited variant stays; down() reverts the tracked rows', async () => {
      const baseId = await seedTemplate(optin._KEY, optin._BEFORE);
      const variantId = await seedVariant(optin._KEY, 'short', optin._BEFORE);
      const customId = await seedVariant(optin._KEY, 'custom', 'Office wording for the opt-in.');
      await optin.up(database);
      expect(await bodyOf('sms_templates', baseId)).toBe(optin._AFTER);
      expect(await bodyOf('sms_template_variants', variantId)).toBe(optin._AFTER);
      expect(await bodyOf('sms_template_variants', customId)).toBe('Office wording for the opt-in.');
      expect((await auditRows(optin._AUDIT_ACTION)).map((row) => `${row.resource_type}:${row.resource_id}`).sort())
        .toEqual([`sms_template_variants:${variantId}`, `sms_templates:${baseId}`].sort());

      await optin.down(database);
      expect(await bodyOf('sms_templates', baseId)).toBe(optin._BEFORE);
      expect(await bodyOf('sms_template_variants', variantId)).toBe(optin._BEFORE);
      expect(await auditRows(optin._AUDIT_ROLLBACK_ACTION)).toHaveLength(2);
    });

    test('an opt-in body an admin edited is skipped and never tracked', async () => {
      const id = await seedTemplate(optin._KEY, 'Edited opt-in text. Reply YES to confirm.');
      await optin.up(database);
      expect(await bodyOf('sms_templates', id)).toBe('Edited opt-in text. Reply YES to confirm.');
      expect(await auditRows(optin._AUDIT_ACTION)).toHaveLength(0);
    });
  });
});
