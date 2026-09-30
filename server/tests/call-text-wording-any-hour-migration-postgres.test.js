// CI's DB-gated pass runs this against PostgreSQL. Fixture data lives in a
// unique schema dropped after the suite.
//
// 20260928050000_call_text_wording_any_hour (FROZEN — already ran on a PR
// preview, never edited) is superseded by 20260928060000_call_text_wording_
// variants_audit, which every real deploy runs in the same release. This
// suite runs BOTH migrations together, in their real order, and their
// down()s in reverse (060000 first, then 050000) exactly as knex would:
//  - the base sms_templates row (050000's own write) AND a matching active
//    sms_template_variants row (060000's own write) both end up swapped and
//    each has its own audit_log event under 060000's action;
//  - a variant an admin already customized is left alone and never audited;
//  - a base row an admin edited BEFORE either migration ran is skipped by
//    050000 and therefore never tracked by 060000 either;
//  - 060000's down() reverts every row it tracked (base rows included, even
//    though 050000 wrote their body) and 050000's own down() then finds
//    nothing left to touch — a safe no-op, never a double-revert or a fight
//    over the same row;
//  - an admin edit made AFTER both up()s (before either down()) survives
//    both down()s untouched.
const SKIP = !process.env.DATABASE_URL;
const knex = require('knex');
const { randomUUID } = require('crypto');

const migration050000 = require('../models/migrations/20260928050000_call_text_wording_any_hour');
const migration060000 = require('../models/migrations/20260928060000_call_text_wording_variants_audit');
const { _SWAPS: SWAPS } = migration050000;
const { _AUDIT_ACTION: AUDIT_ACTION, _AUDIT_ROLLBACK_ACTION: ROLLBACK_ACTION } = migration060000;
const [MISSED_CALL, VOICEMAIL] = SWAPS.map(([key]) => key);
const BEFORE = Object.fromEntries(SWAPS.map(([key, before]) => [key, before]));
const AFTER = Object.fromEntries(SWAPS.map(([key, , after]) => [key, after]));

async function up(knexConn) { await migration050000.up(knexConn); await migration060000.up(knexConn); }
async function down(knexConn) { await migration060000.down(knexConn); await migration050000.down(knexConn); }

jest.setTimeout(30000);
(SKIP ? describe.skip : describe)('call-text-wording-any-hour + variants-audit migrations on PostgreSQL', () => {
  let database;
  const schema = `call_text_wording_${randomUUID().replaceAll('-', '')}`;
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

  const seedTemplate = (key, body, extra = {}) => database('sms_templates').insert({
    id: randomUUID(), template_key: key, name: key, category: 'service', body,
    variables: JSON.stringify([]), sort_order: 100, is_active: true, ...extra,
  }).returning('id').then(([r]) => r.id);

  const seedVariant = (key, variantKey, body, extra = {}) => database('sms_template_variants').insert({
    id: randomUUID(), template_key: key, variant_key: variantKey, body, ...extra,
  }).returning('id').then(([r]) => r.id);

  const auditRows = (action) => database('audit_log').where({ action }).select('resource_type', 'resource_id', 'metadata');
  const bodyOf = async (table, id) => (await database(table).where({ id }).first('body'))?.body;

  test('base row (050000) + matching active variant (060000) both swap and are each individually audited; down() reverts exactly those rows in the right order', async () => {
    const missedId = await seedTemplate(MISSED_CALL, BEFORE[MISSED_CALL]);
    const voicemailId = await seedTemplate(VOICEMAIL, BEFORE[VOICEMAIL]);
    const variantId = await seedVariant(MISSED_CALL, 'friendlier', BEFORE[MISSED_CALL]);
    // A variant an admin already customized must never be touched — it
    // doesn't match BEFORE, so body equality alone can't pick it up either.
    const customVariantId = await seedVariant(VOICEMAIL, 'custom', 'Adam wrote this variant by hand.');

    await up(database);

    expect(await bodyOf('sms_templates', missedId)).toBe(AFTER[MISSED_CALL]);
    expect(await bodyOf('sms_templates', voicemailId)).toBe(AFTER[VOICEMAIL]);
    expect(await bodyOf('sms_template_variants', variantId)).toBe(AFTER[MISSED_CALL]);
    expect(await bodyOf('sms_template_variants', customVariantId)).toBe('Adam wrote this variant by hand.');

    const tracked = await auditRows(AUDIT_ACTION);
    expect(tracked).toHaveLength(3);
    const byResourceId = Object.fromEntries(tracked.map((r) => [r.resource_id, r]));
    expect(byResourceId[missedId]).toMatchObject({ resource_type: 'sms_templates', metadata: expect.objectContaining({ template_key: MISSED_CALL }) });
    expect(byResourceId[voicemailId]).toMatchObject({ resource_type: 'sms_templates', metadata: expect.objectContaining({ template_key: VOICEMAIL }) });
    expect(byResourceId[variantId]).toMatchObject({ resource_type: 'sms_template_variants', metadata: expect.objectContaining({ template_key: MISSED_CALL }) });
    expect(byResourceId[customVariantId]).toBeUndefined();

    await down(database);

    expect(await bodyOf('sms_templates', missedId)).toBe(BEFORE[MISSED_CALL]);
    expect(await bodyOf('sms_templates', voicemailId)).toBe(BEFORE[VOICEMAIL]);
    expect(await bodyOf('sms_template_variants', variantId)).toBe(BEFORE[MISSED_CALL]);
    expect(await bodyOf('sms_template_variants', customVariantId)).toBe('Adam wrote this variant by hand.');

    const rolledBack = await auditRows(ROLLBACK_ACTION);
    expect(rolledBack).toHaveLength(3);
    expect(rolledBack.map((r) => r.resource_id).sort()).toEqual([missedId, voicemailId, variantId].sort());
  });

  test('a base row an admin edited before either migration runs is skipped by 050000 and never tracked by 060000', async () => {
    const editedId = await seedTemplate(MISSED_CALL, 'Custom copy Adam wrote in the admin UI {callback_clause}.');
    const untouchedId = await seedTemplate(VOICEMAIL, BEFORE[VOICEMAIL]);

    await up(database);

    expect(await bodyOf('sms_templates', editedId)).toBe('Custom copy Adam wrote in the admin UI {callback_clause}.');
    expect(await bodyOf('sms_templates', untouchedId)).toBe(AFTER[VOICEMAIL]);
    const tracked = await auditRows(AUDIT_ACTION);
    expect(tracked.map((r) => r.resource_id)).toEqual([untouchedId]);
  });

  test('an admin edit made AFTER both up()s (before either down()) is preserved — only the untouched row reverts', async () => {
    const editedId = await seedTemplate(MISSED_CALL, BEFORE[MISSED_CALL]);
    const untouchedId = await seedTemplate(VOICEMAIL, BEFORE[VOICEMAIL]);

    await up(database);
    await database('sms_templates').where({ id: editedId }).update({ body: 'Adam rewrote this after the migrations ran.' });

    await down(database);

    expect(await bodyOf('sms_templates', editedId)).toBe('Adam rewrote this after the migrations ran.');
    expect(await bodyOf('sms_templates', untouchedId)).toBe(BEFORE[VOICEMAIL]);
  });

  test('050000 finds nothing left to touch once 060000 has already reverted the base rows (rollback order)', async () => {
    const missedId = await seedTemplate(MISSED_CALL, BEFORE[MISSED_CALL]);
    await up(database);
    expect(await bodyOf('sms_templates', missedId)).toBe(AFTER[MISSED_CALL]);

    await migration060000.down(database);
    expect(await bodyOf('sms_templates', missedId)).toBe(BEFORE[MISSED_CALL]);

    // 050000's own down() looks for body === AFTER; it's already BEFORE, so
    // this is a harmless no-op, not a double-revert or an error.
    await migration050000.down(database);
    expect(await bodyOf('sms_templates', missedId)).toBe(BEFORE[MISSED_CALL]);
  });

  test('running the full down() twice is a no-op the second time', async () => {
    const missedId = await seedTemplate(MISSED_CALL, BEFORE[MISSED_CALL]);
    await up(database);
    await down(database);
    expect(await bodyOf('sms_templates', missedId)).toBe(BEFORE[MISSED_CALL]);
    await down(database); // nothing left at the AFTER body to match
    expect(await bodyOf('sms_templates', missedId)).toBe(BEFORE[MISSED_CALL]);
    expect(await auditRows(ROLLBACK_ACTION)).toHaveLength(1);
  });
});

describe('call-text-wording-variants-audit migration — sms_template_variants / audit_log unavailable', () => {
  let database;
  const schema = `call_text_wording_minimal_${randomUUID().replaceAll('-', '')}`;

  beforeAll(async () => {
    if (SKIP) return;
    database = knex({ client: 'pg', connection: process.env.DATABASE_URL, searchPath: [schema], pool: { min: 0, max: 3 } });
    await database.raw('CREATE SCHEMA ??', [schema]);
    // Only the base table exists here — no sms_template_variants, no audit_log.
    await database.raw('CREATE TABLE ??.sms_templates AS SELECT * FROM public.sms_templates WITH NO DATA', [schema]);
  });
  afterAll(async () => {
    if (SKIP) return;
    await database.raw('DROP SCHEMA ?? CASCADE', [schema]);
    await database.destroy();
  });

  (SKIP ? test.skip : test)('050000 still swaps the base body with no variants/audit table present; 060000 is a safe no-op, and neither down() errors', async () => {
    const [row] = await database('sms_templates').insert({
      id: randomUUID(), template_key: MISSED_CALL, name: MISSED_CALL, category: 'service',
      body: BEFORE[MISSED_CALL], variables: JSON.stringify([]), sort_order: 100, is_active: true,
    }).returning('id');

    await up(database);
    expect((await database('sms_templates').where({ id: row.id }).first('body')).body).toBe(AFTER[MISSED_CALL]);

    // Neither down() has an audit trail (or, for 050000, an admin edit) to
    // work from here besides plain body equality — 050000's own CAS still
    // reverts it since 060000 wrote nothing.
    await down(database);
    expect((await database('sms_templates').where({ id: row.id }).first('body')).body).toBe(BEFORE[MISSED_CALL]);
  });
});
