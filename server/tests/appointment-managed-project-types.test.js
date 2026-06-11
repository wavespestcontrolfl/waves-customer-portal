const { appointmentManagedProjectTypes } = require('../services/service-completion-profiles');

function makeKnex({ rows = [], hasTable = true, throwOnQuery = false } = {}) {
  const knex = jest.fn(() => {
    const chain = {
      where: jest.fn(() => chain),
      whereNotNull: jest.fn(() => chain),
      distinct: jest.fn(async () => {
        if (throwOnQuery) throw new Error('boom');
        return rows;
      }),
    };
    return chain;
  });
  knex.schema = { hasTable: jest.fn(async () => hasTable) };
  return knex;
}

describe('appointmentManagedProjectTypes', () => {
  test('returns the set of project types with active service_report profiles', async () => {
    const knex = makeKnex({
      rows: [{ project_type: 'cockroach' }, { project_type: 'flea' }, { project_type: null }],
    });
    const managed = await appointmentManagedProjectTypes(knex);
    expect(managed).toEqual(new Set(['cockroach', 'flea']));
  });

  test('pre-cutover (no flipped rows) is an empty set — Projects creation unchanged', async () => {
    const managed = await appointmentManagedProjectTypes(makeKnex({ rows: [] }));
    expect(managed.size).toBe(0);
  });

  test('fails open to empty set when the table is missing or the query errors', async () => {
    expect((await appointmentManagedProjectTypes(makeKnex({ hasTable: false }))).size).toBe(0);
    expect((await appointmentManagedProjectTypes(makeKnex({ throwOnQuery: true }))).size).toBe(0);
  });
});
