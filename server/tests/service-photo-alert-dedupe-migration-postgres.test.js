const SKIP = !process.env.DATABASE_URL;
const knex = require('knex');
const { randomUUID } = require('node:crypto');
const migration = require('../models/migrations/20261003040000_service_photo_reconciliation_alert_dedupe');

jest.setTimeout(30000);
(SKIP ? describe.skip : describe)('service photo reconciliation alert dedupe migration (PostgreSQL)', () => {
  let database;
  const schema = `photo_alert_dedupe_${randomUUID().replaceAll('-', '')}`;

  beforeAll(async () => {
    database = knex({
      client: 'pg',
      connection: process.env.DATABASE_URL,
      searchPath: [schema],
      pool: { min: 0, max: 2 },
    });
    await database.raw('CREATE SCHEMA ??', [schema]);
    await database.raw(
      'CREATE TABLE ??.dispatch_alerts AS SELECT * FROM public.dispatch_alerts WITH NO DATA',
      [schema],
    );
  });

  afterAll(async () => {
    if (!database) return;
    await database.raw('DROP SCHEMA ?? CASCADE', [schema]);
    await database.destroy();
  });

  test('resolves duplicate handoffs before enforcing one unresolved alert per visit', async () => {
    const visitId = randomUUID();
    const firstId = randomUUID();
    const duplicateId = randomUUID();
    const row = (id, createdAt, payload) => ({
      id,
      type: 'service_photo_reconciliation_required',
      severity: 'warning',
      job_id: visitId,
      payload,
      created_at: createdAt,
    });
    await database('dispatch_alerts').insert([
      row(firstId, new Date('2026-10-03T01:00:00Z'), { original: true }),
      row(duplicateId, new Date('2026-10-03T01:01:00Z'), null),
    ]);

    await migration.up(database);

    const alerts = await database('dispatch_alerts').where({ job_id: visitId }).orderBy('created_at');
    expect(alerts[0]).toMatchObject({ id: firstId, resolved_at: null, payload: { original: true } });
    expect(alerts[1].id).toBe(duplicateId);
    expect(alerts[1].resolved_at).toBeInstanceOf(Date);
    expect(alerts[1].payload).toMatchObject({
      dedupedByMigration: '20261003040000_service_photo_reconciliation_alert_dedupe',
    });

    await expect(database.transaction((trx) => trx('dispatch_alerts').insert(
      row(randomUUID(), new Date('2026-10-03T01:02:00Z'), {}),
    ))).rejects.toMatchObject({ code: '23505' });

    await migration.down(database);
    await expect(database('dispatch_alerts').insert(
      row(randomUUID(), new Date('2026-10-03T01:03:00Z'), {}),
    )).resolves.toBeTruthy();
  });
});
