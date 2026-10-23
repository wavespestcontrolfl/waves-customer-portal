// Lawn catalog cleanup (owner 2026-10-23): T-Storm 2G and Endurant PR approved for reports with watering rules,
// Dismiss NXT's identity, two moved EPA numbers, one knowledge-base line.
const SKIP = !process.env.DATABASE_URL;
const describeDb = SKIP ? describe.skip : describe;
const { randomUUID } = require('crypto');
const knexFactory = require('knex');
const migration = require('../models/migrations/20261023120000_lawn_catalog_report_approvals_and_identity');
const { validateRule } = require('../services/service-report/lawn-watering-rule');
const { approvedReportProductFacts } = require('../services/service-report/report-data');

const item = (name) => migration.ITEMS.find((entry) => entry.name === name);
const before = (name) => Object.fromEntries(Object.entries(item(name).set).map(([column, [from]]) => [column, from]));
const after = (name) => Object.fromEntries(Object.entries(item(name).set).map(([column, [, to]]) => [column, to]));

describe('lawn catalog cleanup (pure)', () => {
  test('every watering rule it writes passes the validator', () => {
    for (const entry of migration.ITEMS) {
      const rule = entry.set.post_application_watering && entry.set.post_application_watering[1];
      if (rule) expect(validateRule(rule)).toMatchObject({ valid: true });
    }
  });

  test('once approved, both products freeze report facts that carry their watering rule', () => {
    const tStorm = approvedReportProductFacts({ name: 'LESCO T-Storm 2G Fungicide', category: 'fungicide', epa_reg_number: '228-631-10404', ...after('LESCO T-Storm 2G Fungicide') });
    expect(tStorm).toMatchObject({ productType: 'pesticide', wateringRule: { mode: 'water_in', water_in_inches: 0.25, water_in_by_hours: 24, source: 'label' } });
    // A granule: the label's entry line is about settling, never spray drying.
    expect(tStorm.precautionSummary).toMatch(/granules and dust have settled/);
    expect(tStorm.reentrySummary).toMatch(/granules and dust have settled/);
    expect(`${tStorm.precautionSummary} ${tStorm.reentrySummary}`).not.toMatch(/dried|sprays/);
    const endurant = approvedReportProductFacts({ name: 'Endurant PR Turf Colorant', category: 'adjuvant', epa_reg_number: 'N/A', ...after('Endurant PR Turf Colorant') });
    expect(endurant).toMatchObject({ productType: 'other', wateringRule: { mode: 'hold', hold_hours: 8, hold_until: 'dry' } });
    // Before the migration neither froze any facts, so no rule reached the visit's instruction.
    expect(approvedReportProductFacts({ name: 'LESCO T-Storm 2G Fungicide', category: 'fungicide', ...before('LESCO T-Storm 2G Fungicide') })).toBeNull();
  });

  test('T-Storm 2G: rain counts and the 24-hour deadline runs from the visit, never moved past a hold', () => {
    const { buildWateringInstruction } = require('../services/service-report/lawn-watering-instruction');
    const rule = validateRule(after('LESCO T-Storm 2G Fungicide').post_application_watering).rule;
    const at = '2026-10-21T14:00:00Z'; // Wed 10 AM ET
    const alone = buildWateringInstruction({ rules: [{ name: 'LESCO T-Storm 2G Fungicide', rule }], completedAt: at, plainWhenNoSetup: true, labelFirst: true });
    expect(alone.lines.join(' ')).toMatch(/Rain and your regular watering both count/);
    expect(alone.lines.join(' ')).toMatch(/by Thu 10 AM/);
    // Beside the owner's 24-hour herbicide hold: a clash (office alert), never a 48-hour window.
    const herbicide = { mode: 'hold', hold_hours: 24, source: 'owner' };
    const mixed = buildWateringInstruction({ rules: [{ name: 'Herbicide', rule: herbicide }, { name: 'LESCO T-Storm 2G Fungicide', rule }], completedAt: at, plainWhenNoSetup: true, labelFirst: true });
    expect(mixed.state).toBeNull();
    expect(mixed.noClaim).toMatchObject({ reason: 'water_in_conflict' });
  });

  test('Prodiamine 65 WDG: the provenance note names the new registration', () => {
    expect(after('Prodiamine 65 WDG').label_source_note).toMatch(/This row: 53883-429/);
    expect(after('Prodiamine 65 WDG').label_source_note).not.toMatch(/this row: 66222-89/);
  });

  test('Dismiss NXT reads as its own label: both actives Group 14, no second HRAC group', () => {
    expect(after('Dismiss NXT')).toMatchObject({ epa_reg_number: '101563-315', active_ingredient: 'Sulfentrazone + Carfentrazone-ethyl', hrac_group_secondary: null });
  });
});

describeDb('20261023120000 lawn catalog cleanup', () => {
  let knex;
  let schema;

  beforeEach(async () => {
    schema = `catalog_cleanup_${randomUUID().replace(/-/g, '')}`;
    knex = knexFactory({ client: 'pg', connection: process.env.DATABASE_URL, searchPath: [schema], pool: { min: 0, max: 4 } });
    await knex.raw('CREATE SCHEMA ??', [schema]);
    for (const table of ['products_catalog', 'audit_log', 'knowledge_base', 'knowledge_embeddings']) {
      await knex.raw(`CREATE TABLE ??.${table} (LIKE public.${table} INCLUDING ALL)`, [schema]);
    }
  });

  afterEach(async () => {
    await knex.raw('DROP SCHEMA ?? CASCADE', [schema]);
    await knex.destroy();
  });

  const insert = async (name, values) => {
    const row = { id: randomUUID(), name, ...values };
    if (row.post_application_watering && typeof row.post_application_watering === 'object') row.post_application_watering = JSON.stringify(row.post_application_watering);
    await knex('products_catalog').insert(row);
    return row.id;
  };
  const read = (id) => knex('products_catalog').where({ id }).first();

  test('writes each item only while every field still holds the value read; once, audited', async () => {
    const tStorm = await insert('LESCO T-Storm 2G Fungicide', before('LESCO T-Storm 2G Fungicide'));
    const dismiss = await insert('Dismiss NXT', before('Dismiss NXT'));
    // An admin already changed one field of Endurant: the whole item is left alone.
    const endurant = await insert('Endurant PR Turf Colorant', { ...before('Endurant PR Turf Colorant'), service_report_summary: 'Our own copy.' });
    const arena = await insert('Nufarm Arena 0.25G Clothianidin 0.25 Systemic Granular Insecticide', before('Nufarm Arena 0.25G Clothianidin 0.25 Systemic Granular Insecticide'));

    await migration.up(knex);
    await migration.up(knex);

    const t = await read(tStorm);
    expect(t).toMatchObject({ approved_for_service_report: true, moa_group: 'Group 1', service_report_summary: after('LESCO T-Storm 2G Fungicide').service_report_summary });
    expect(t.post_application_watering).toEqual(after('LESCO T-Storm 2G Fungicide').post_application_watering);
    expect(await read(dismiss)).toMatchObject({ epa_reg_number: '101563-315', active_ingredient: 'Sulfentrazone + Carfentrazone-ethyl', hrac_group_secondary: null, label_verified_by: 'label-check-2026-10-22' });
    expect((await read(dismiss)).label_verified_at.toISOString()).toBe('2026-10-22T00:00:00.000Z');
    expect(await read(endurant)).toMatchObject({ approved_for_service_report: false, service_report_summary: 'Our own copy.', post_application_watering: null });
    expect((await read(arena)).epa_reg_number).toBe('59639-157');
    const audits = await knex('audit_log').where('action', 'like', 'migration:20261023120000_%');
    expect(audits.map((a) => a.resource_id).sort()).toEqual([tStorm, dismiss, arena].sort());
    await migration.down(knex);
  });

  test('corrects the article line once, purges its search chunks, and leaves an edited line alone', async () => {
    const content = `Intro\n${migration.KB_OLD} Use up existing stock on green kyllinga under 85°F only.\nEnd`;
    const [{ id }] = await knex('knowledge_base').insert({ title: 'Celsius WG — Application Limits', slug: 'celsius-wg-application-limits', path: 'lawn/celsius-wg-application-limits', content }).returning('id');
    await knex('knowledge_embeddings').insert({ source: 'kb', source_id: 'celsius-wg-application-limits', content: 'old chunk', content_hash: 'h' });
    await migration.up(knex);
    await migration.up(knex);
    const article = await knex('knowledge_base').where({ id }).first();
    expect(article.content).toContain(migration.KB_NEW);
    expect(article.content).not.toContain('prodiamine');
    expect(await knex('knowledge_embeddings').where({ source_id: 'celsius-wg-application-limits' })).toEqual([]);

    // The form 20261007179500's down() writes carries the same wrong actives: corrected too.
    const kept = '- Dismiss NXT (sulfentrazone + prodiamine) — retired, do not reorder. Existing stock may be used up on green kyllinga under 85°F only. Not an alternative after the Celsius cap';
    await knex('knowledge_base').where({ id }).update({ content: `Intro\n${kept}\nEnd` });
    await migration.up(knex);
    expect((await knex('knowledge_base').where({ id }).first()).content).toBe(`Intro\n${kept.replace(migration.KB_OLD, migration.KB_NEW)}\nEnd`);

    await knex('knowledge_base').where({ id }).update({ content: 'Dismiss NXT: our own note.' });
    await migration.up(knex);
    expect((await knex('knowledge_base').where({ id }).first()).content).toBe('Dismiss NXT: our own note.');
  });
});
