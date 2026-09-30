const migration = require('../models/migrations/20260930100000_service_report_fixture_hide_empty_findings');

const SEEDED = 'No action-required findings were documented.';

function knexStub({ hasTables = true, template = { id: 'tpl-1' }, fixtures = [] } = {}) {
  const updates = [];
  const knex = jest.fn((table) => ({
    where: jest.fn((criteria) => {
      if (table === 'email_templates') {
        expect(criteria).toEqual({ template_key: 'service.report_ready' });
        return { first: jest.fn(async () => template) };
      }
      const chain = Promise.resolve(fixtures);
      chain.update = jest.fn(async (values) => { updates.push({ criteria, values }); return 1; });
      if (criteria.template_id) return chain;
      return { update: chain.update };
    }),
  }));
  knex.schema = { hasTable: jest.fn(async () => hasTables) };
  return { knex, updates };
}

describe('service report fixture: hide empty Findings row migration', () => {
  beforeEach(() => jest.spyOn(console, 'log').mockImplementation(() => {}));
  afterEach(() => jest.restoreAllMocks());

  test('blanks finding_summary only where it is still the seeded sentence', async () => {
    const { knex, updates } = knexStub({
      fixtures: [
        { id: 'f-default', payload: JSON.stringify({ first_name: 'Taylor', finding_summary: SEEDED }) },
        { id: 'f-edited', payload: JSON.stringify({ finding_summary: 'Staff wrote this.' }) },
        { id: 'f-lawn', payload: JSON.stringify({ finding_summary: 'Lawn score baseline recorded.' }) },
        { id: 'f-none', payload: { first_name: 'Taylor' } },
      ],
    });

    await migration.up(knex);

    expect(updates).toHaveLength(1);
    expect(updates[0].criteria).toEqual({ id: 'f-default' });
    expect(JSON.parse(updates[0].values.payload)).toEqual({ first_name: 'Taylor', finding_summary: '' });
  });

  test('is idempotent: a blanked fixture is not touched again', async () => {
    const { knex, updates } = knexStub({
      fixtures: [{ id: 'f-default', payload: JSON.stringify({ finding_summary: '' }) }],
    });
    await migration.up(knex);
    expect(updates).toHaveLength(0);
  });

  test('no-ops without the tables or the template', async () => {
    const a = knexStub({ hasTables: false });
    await migration.up(a.knex);
    expect(a.updates).toHaveLength(0);
    const b = knexStub({ template: undefined });
    await migration.up(b.knex);
    expect(b.updates).toHaveLength(0);
  });

  test('down is a documented no-op', async () => {
    const { knex, updates } = knexStub();
    await expect(migration.down(knex)).resolves.toBeUndefined();
    expect(updates).toHaveLength(0);
  });
});
