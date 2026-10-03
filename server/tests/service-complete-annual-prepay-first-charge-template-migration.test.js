const migration = require('../models/migrations/20261002100000_service_complete_annual_prepay_first_charge_template');

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

describe('service_complete_annual_prepay_first_charge template migration', () => {
  test('inserts the first-visit charge text when missing', async () => {
    const { knex, state } = buildKnex();
    await migration.up(knex);
    expect(state.inserted).toHaveLength(1);
    const row = state.inserted[0];
    expect(row.template_key).toBe('service_complete_annual_prepay_first_charge');
    expect(row.is_active).toBe(true);
    expect(JSON.parse(row.variables)).toEqual(['first_name', 'service_type', 'amount', 'method_line', 'portal_url']);
    // The point of the template: the year is charged right after this visit,
    // so it must never say nothing is due.
    expect(row.body).not.toMatch(/nothing (is )?due/i);
    expect(row.body).toContain('{amount}');
    expect(row.body).toContain('{portal_url}');
    // Transactional texts carry no STOP line (20260810000060).
    expect(row.body).not.toMatch(/reply stop/i);
  });

  test('rendered body stays in GSM-7 encoding', async () => {
    const { detectEncoding } = require('../services/messaging/segment-counter');
    const { knex, state } = buildKnex();
    await migration.up(knex);
    const rendered = state.inserted[0].body
      .replace('{first_name}', 'Chris')
      .replace('{service_type}', 'Quarterly Pest Control')
      .replace('{amount}', '$480.00')
      .replace('{method_line}', 'card on file')
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
