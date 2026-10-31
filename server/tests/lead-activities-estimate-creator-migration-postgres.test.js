// Runs with the existing CI PostgreSQL pass; never a production connection.
// 20261031013000: "Estimate created from lead" history rows that read 'system'
// get the estimate creator's name back. The UPDATE ... FROM join and the jsonb
// reads need a real database; a knex mock can't exercise them honestly.
// Synthetic data only.
const SKIP = !process.env.DATABASE_URL;
const { randomUUID } = require('crypto');
const knex = require('knex');

const migration = require('../models/migrations/20261031013000_lead_activities_estimate_creator');

(SKIP ? describe.skip : describe)('lead_activities estimate creator backfill (PostgreSQL)', () => {
  let db;
  const schema = `lead_activities_estimate_creator_${randomUUID().replaceAll('-', '')}`;
  const robin = randomUUID();
  const blankName = randomUUID();

  beforeAll(async () => {
    db = knex({ client: 'pg', connection: process.env.DATABASE_URL, searchPath: [schema], pool: { min: 0, max: 3 } });
    await db.raw('CREATE SCHEMA ??', [schema]);
    // Relevant columns only: lead_activities from 20260401000095_lead_attribution.
    await db.schema.createTable('technicians', (t) => {
      t.uuid('id').primary();
      t.string('name');
    });
    await db.schema.createTable('estimates', (t) => {
      t.uuid('id').primary();
      t.uuid('created_by_technician_id').nullable();
    });
    await db.schema.createTable('lead_activities', (t) => {
      t.increments('id').primary();
      t.uuid('lead_id');
      t.string('activity_type', 50);
      t.text('description');
      t.string('performed_by', 100);
      t.jsonb('metadata');
    });
    await db('technicians').insert([
      { id: robin, name: '  Robin Sample ' },
      { id: blankName, name: '  ' },
    ]);
  }, 30000);

  afterAll(async () => {
    await db?.schema.dropSchemaIfExists(schema, true).catch(() => {});
    await db?.destroy();
  });

  async function estimate(createdBy) {
    const id = randomUUID();
    await db('estimates').insert({ id, created_by_technician_id: createdBy });
    return id;
  }

  async function activity({ type = 'estimate_created', description, performedBy = 'system', metadata }) {
    const [row] = await db('lead_activities').insert({
      lead_id: randomUUID(),
      activity_type: type,
      description,
      performed_by: performedBy,
      metadata: metadata === undefined ? null : JSON.stringify(metadata),
    }).returning('id');
    return row.id;
  }

  const performer = async (id) => (await db('lead_activities').where({ id }).first('performed_by')).performed_by;

  test('names only staff-created estimates; system links and unknown creators stay', async () => {
    const byRobin = await estimate(robin);
    const noCreator = await estimate(null);
    const blank = await estimate(blankName);

    const rows = {
      created: await activity({ description: `Estimate created from lead (${byRobin})`, metadata: { estimateId: byRobin } }),
      contactMatch: await activity({
        description: `Estimate linked to lead by contact match (${byRobin})`,
        metadata: { estimateId: byRobin, linkedBy: 'contact_match' },
      }),
      noCreator: await activity({ description: `Estimate created from lead (${noCreator})`, metadata: { estimateId: noCreator } }),
      blankName: await activity({ description: `Estimate created from lead (${blank})`, metadata: { estimateId: blank } }),
      missingEstimate: await activity({ description: 'Estimate created from lead (gone)', metadata: { estimateId: randomUUID() } }),
      noMetadata: await activity({ description: `Estimate created from lead (${byRobin})` }),
      alreadyNamed: await activity({
        description: `Estimate created from lead (${byRobin})`,
        performedBy: 'Ava Tech',
        metadata: { estimateId: byRobin },
      }),
      backfill: await activity({
        description: `Estimate created from lead (${byRobin})`,
        performedBy: 'backfill-2214',
        metadata: { estimateId: byRobin },
      }),
      otherType: await activity({ type: 'estimate_sent', description: 'Estimate sent', metadata: { estimateId: byRobin } }),
    };

    await migration.up(db);

    expect(await performer(rows.created)).toBe('Robin Sample');
    expect(await performer(rows.contactMatch)).toBe('system');
    expect(await performer(rows.noCreator)).toBe('system');
    expect(await performer(rows.blankName)).toBe('system');
    expect(await performer(rows.missingEstimate)).toBe('system');
    expect(await performer(rows.noMetadata)).toBe('system');
    expect(await performer(rows.alreadyNamed)).toBe('Ava Tech');
    expect(await performer(rows.backfill)).toBe('backfill-2214');
    expect(await performer(rows.otherType)).toBe('system');

    const before = await db('lead_activities').orderBy('id');
    await migration.up(db);
    expect(await db('lead_activities').orderBy('id')).toEqual(before);
  });
});

test('writes nothing when a column it reads is missing', async () => {
  const raw = jest.fn();
  const fakeKnex = {
    raw,
    schema: {
      hasTable: async () => true,
      hasColumn: async (table, column) => !(table === 'estimates' && column === 'created_by_technician_id'),
    },
  };
  await migration.up(fakeKnex);
  expect(raw).not.toHaveBeenCalled();
});
