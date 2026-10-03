const migration = require('../models/migrations/20261003010000_service_complete_annual_prepay_after_first_visit_template');

function buildKnex({ existingRow = null } = {}) {
  const state = { inserted: [] };
  const query = {
    where() { return query; },
    first: jest.fn(async () => existingRow),
    insert: jest.fn(async (row) => { state.inserted.push(row); }),
    del: jest.fn(async () => 1),
  };
  const knex = jest.fn((table) => {
    expect(table).toBe('sms_templates');
    return query;
  });
  knex.schema = { hasTable: jest.fn(async () => true) };
  return { knex, query, state };
}

describe('service_complete_annual_prepay_after_first_visit template migration', () => {
  test('inserts the neutral first-visit text when missing', async () => {
    const { knex, state } = buildKnex();
    await migration.up(knex);
    const row = state.inserted[0];
    expect(row.template_key).toBe('service_complete_annual_prepay_after_first_visit');
    expect(JSON.parse(row.variables)).toEqual(['first_name', 'service_type', 'portal_url']);
    // Owner ruling 2026-10-03: neutral, never an amount, "now" or "nothing due".
    expect(row.body).not.toMatch(/\$|\{amount\}|nothing (is )?due|\bnow\b/i);
    expect(row.body).toContain('processed after this first visit');
    expect(row.body).not.toMatch(/reply stop/i);
  });

  test('rendered body stays in GSM-7 encoding', async () => {
    const { detectEncoding } = require('../services/messaging/segment-counter');
    const { knex, state } = buildKnex();
    await migration.up(knex);
    const rendered = state.inserted[0].body
      .replace('{first_name}', 'Chris')
      .replace('{service_type}', 'Quarterly Pest Control')
      .replace('{portal_url}', 'https://portal.wavespestcontrol.com/l/abc');
    expect(detectEncoding(rendered).encoding).toBe('GSM_7');
  });

  test('leaves an existing row alone, and down removes it', async () => {
    const { knex, query, state } = buildKnex({ existingRow: { id: 1 } });
    await migration.up(knex);
    expect(state.inserted).toHaveLength(0);
    await migration.down(knex);
    expect(query.del).toHaveBeenCalled();
  });
});
