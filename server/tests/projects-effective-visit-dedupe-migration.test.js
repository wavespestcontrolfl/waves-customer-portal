const originalMigration = require('../models/migrations/20260714000010_projects_scheduled_service_unique');
const followupMigration = require('../models/migrations/20260715210000_projects_effective_visit_dedupe');

const SKIP = !process.env.DATABASE_URL;

function schemaWithAllLinks() {
  return {
    hasTable: jest.fn(async () => true),
    hasColumn: jest.fn(async () => true),
  };
}

describe('projects effective-visit dedupe migrations', () => {
  let warnSpy;

  beforeEach(() => {
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  test('fresh migration clears both direct and service-record links on duplicate losers', async () => {
    const raw = jest.fn()
      .mockResolvedValueOnce({ rows: [{ present: false }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: 'project-loser', was_linked_to: 'visit-1' }] })
      .mockResolvedValueOnce({ rows: [] });
    const knex = { schema: schemaWithAllLinks(), raw };

    await originalMigration.up(knex);

    const normalizeSql = raw.mock.calls[1][0];
    expect(normalizeSql).toContain('p.scheduled_service_id IS DISTINCT FROM sr.scheduled_service_id');
    expect(normalizeSql).toContain('SET scheduled_service_id = a.authoritative_visit');
    const dedupeSql = raw.mock.calls[2][0];
    expect(dedupeSql).toContain('scheduled_service_id = NULL, service_record_id = NULL');
    expect(dedupeSql).toContain('ROW_NUMBER() OVER');
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('project-loser'));
  });

  test('follow-up ranks the effective record link, clears both loser links, and restores the direct fence', async () => {
    const trx = {
      raw: jest.fn()
        .mockResolvedValueOnce({ rows: [{
          id: 'project-mismatch',
          released_visit: 'visit-old',
          authoritative_visit: 'visit-1',
        }] })
        .mockResolvedValueOnce({ rows: [{ id: 'project-loser', was_linked_to: 'visit-1' }] })
        .mockResolvedValueOnce({ rows: [{ id: 'project-keeper', adopted_visit: 'visit-1' }] }),
    };
    const knex = {
      schema: schemaWithAllLinks(),
      transaction: jest.fn(async (callback) => callback(trx)),
    };

    await followupMigration.up(knex);

    expect(knex.transaction).toHaveBeenCalledTimes(1);
    const mismatchSql = trx.raw.mock.calls[0][0];
    expect(mismatchSql).toContain('p.scheduled_service_id <> sr.scheduled_service_id');
    expect(mismatchSql).toContain('p.scheduled_service_id AS released_visit');
    expect(mismatchSql).toContain('SET scheduled_service_id = NULL');

    const dedupeSql = trx.raw.mock.calls[1][0];
    expect(dedupeSql).toContain('COALESCE(sr.scheduled_service_id, p.scheduled_service_id)');
    expect(dedupeSql).toContain('scheduled_service_id = NULL');
    expect(dedupeSql).toContain('service_record_id = NULL');
    expect(dedupeSql).toContain('e.rn > 1');

    const normalizeSql = trx.raw.mock.calls[2][0];
    expect(normalizeSql).toContain('SET scheduled_service_id = sr.scheduled_service_id');
    expect(normalizeSql).toContain('p.scheduled_service_id IS NULL');
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('project-loser'));
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('project-keeper'));
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('project-mismatch'));
  });

  test('follow-up is a no-op when the legacy link shape is absent', async () => {
    const schema = schemaWithAllLinks();
    schema.hasColumn.mockResolvedValueOnce(false);
    const knex = { schema, transaction: jest.fn() };

    await followupMigration.up(knex);

    expect(knex.transaction).not.toHaveBeenCalled();
  });
});

(SKIP ? describe.skip : describe)('projects effective-visit dedupe PostgreSQL regression', () => {
  let database;

  beforeAll(() => {
    database = require('knex')({
      client: 'pg',
      connection: process.env.DATABASE_URL,
    });
  });

  afterAll(async () => {
    await database?.destroy();
  });

  test('fresh repair normalizes mismatches before ranking so neither real visit loses its report', async () => {
    await database.transaction(async (trx) => {
      await trx.raw(`
        CREATE TEMP TABLE service_records (
          id uuid PRIMARY KEY,
          scheduled_service_id uuid
        ) ON COMMIT DROP;
        CREATE TEMP TABLE projects (
          id uuid PRIMARY KEY,
          service_record_id uuid REFERENCES service_records(id),
          scheduled_service_id uuid,
          status text NOT NULL,
          created_at timestamptz NOT NULL,
          updated_at timestamptz NOT NULL DEFAULT NOW()
        ) ON COMMIT DROP;
      `);

      const visitX = '00000000-0000-0000-0000-000000000111';
      const visitY = '00000000-0000-0000-0000-000000000112';
      const recordY = '00000000-0000-0000-0000-000000000211';
      const recordX = '00000000-0000-0000-0000-000000000212';
      const mismatchedProject = '00000000-0000-0000-0000-000000000311';
      const trueVisitXProject = '00000000-0000-0000-0000-000000000312';

      await trx('service_records').insert([
        { id: recordY, scheduled_service_id: visitY },
        { id: recordX, scheduled_service_id: visitX },
      ]);
      await trx('projects').insert([
        {
          id: mismatchedProject,
          service_record_id: recordY,
          scheduled_service_id: visitX,
          status: 'closed',
          created_at: '2026-07-01T12:00:00Z',
        },
        {
          id: trueVisitXProject,
          service_record_id: recordX,
          scheduled_service_id: visitX,
          status: 'sent',
          created_at: '2026-07-02T12:00:00Z',
        },
      ]);

      await originalMigration._normalizeAndDedupeProjectVisitLinks(trx, { hasRecordLink: true });

      await expect(trx('projects')
        .where({ id: mismatchedProject })
        .first('scheduled_service_id', 'service_record_id'))
        .resolves.toEqual({
          scheduled_service_id: visitY,
          service_record_id: recordY,
        });
      await expect(trx('projects')
        .where({ id: trueVisitXProject })
        .first('scheduled_service_id', 'service_record_id'))
        .resolves.toEqual({
          scheduled_service_id: visitX,
          service_record_id: recordX,
        });
    });
  });

  test('releases a mismatched direct link before normalizing a record-only project onto it', async () => {
    await database.transaction(async (trx) => {
      // Temporary tables shadow the migrated public tables on this connection,
      // keeping the regression isolated from every other DB-gated suite.
      await trx.raw(`
        CREATE TEMP TABLE service_records (
          id uuid PRIMARY KEY,
          scheduled_service_id uuid
        ) ON COMMIT DROP;
        CREATE TEMP TABLE projects (
          id uuid PRIMARY KEY,
          service_record_id uuid REFERENCES service_records(id),
          scheduled_service_id uuid,
          status text NOT NULL,
          created_at timestamptz NOT NULL,
          updated_at timestamptz NOT NULL DEFAULT NOW()
        ) ON COMMIT DROP;
        CREATE UNIQUE INDEX projects_scheduled_service_id_unique_regression
          ON projects (scheduled_service_id)
          WHERE scheduled_service_id IS NOT NULL;
      `);

      const visitX = '00000000-0000-0000-0000-000000000101';
      const visitY = '00000000-0000-0000-0000-000000000102';
      const recordY = '00000000-0000-0000-0000-000000000201';
      const recordX = '00000000-0000-0000-0000-000000000202';
      const mismatchedProject = '00000000-0000-0000-0000-000000000301';
      const recordOnlyProject = '00000000-0000-0000-0000-000000000302';

      await trx('service_records').insert([
        { id: recordY, scheduled_service_id: visitY },
        { id: recordX, scheduled_service_id: visitX },
      ]);
      await trx('projects').insert([
        {
          id: mismatchedProject,
          service_record_id: recordY,
          scheduled_service_id: visitX,
          status: 'closed',
          created_at: '2026-07-01T12:00:00Z',
        },
        {
          id: recordOnlyProject,
          service_record_id: recordX,
          scheduled_service_id: null,
          status: 'sent',
          created_at: '2026-07-02T12:00:00Z',
        },
      ]);

      await followupMigration.up(trx);

      await expect(trx('projects')
        .where({ id: mismatchedProject })
        .first('scheduled_service_id', 'service_record_id'))
        .resolves.toEqual({
          scheduled_service_id: visitY,
          service_record_id: recordY,
        });
      await expect(trx('projects')
        .where({ id: recordOnlyProject })
        .first('scheduled_service_id', 'service_record_id'))
        .resolves.toEqual({
          scheduled_service_id: visitX,
          service_record_id: recordX,
        });
    });
  });
});
