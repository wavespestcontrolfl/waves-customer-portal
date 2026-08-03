const migration = require('../models/migrations/20260802100000_service_report_sms_name_the_service');
const { buildServiceReportV1SmsVars } = require('../services/service-report/delivery');

// Chainable stub: records every (where, patch) pair the migration issues and
// reports how many rows each UPDATE "matched".
function buildKnex({ matched = 1 } = {}) {
  const state = { updates: [] };
  const knex = jest.fn((table) => {
    expect(table).toBe('sms_templates');
    const query = {
      where: jest.fn((criteria) => { query.__where = criteria; return query; }),
      update: jest.fn(async (patch) => {
        state.updates.push({ where: query.__where, patch });
        return matched;
      }),
      columnInfo: jest.fn(async () => ({ body: {}, updated_at: {}, variables: {} })),
    };
    return query;
  });
  knex.schema = { hasTable: jest.fn(async () => true) };
  return { knex, state };
}

describe('service-report SMS: name the service, drop the re-entry line', () => {
  test('rewrites both variants and moves the variables column with the body', async () => {
    const { knex, state } = buildKnex();
    await migration.up(knex);

    expect(state.updates).toHaveLength(2);
    const keys = state.updates.map((u) => u.where.template_key);
    expect(keys).toEqual(['service_report_v1', 'service_report_v1_with_invoice']);

    for (const { patch } of state.updates) {
      expect(patch.body).toContain('{service_type}');
      expect(patch.body).not.toContain('{reentry_line}');
      // The variables column drives the admin editor's placeholder list; a body
      // carrying {service_type} while variables omits it makes the editor lie.
      expect(JSON.parse(patch.variables)).toContain('service_type');
      expect(JSON.parse(patch.variables)).not.toContain('reentry_line');
    }
  });

  test('the expected body is part of the UPDATE predicate, so an edited row is skipped', async () => {
    const { knex, state } = buildKnex({ matched: 0 });
    await migration.up(knex);

    // Every UPDATE is keyed on template_key AND the exact prior body — an
    // operator edit between the audit and the deploy must not be overwritten.
    for (const { where } of state.updates) {
      expect(where).toHaveProperty('template_key');
      expect(where).toHaveProperty('body');
      expect(where.body).toContain('{reentry_line}');
    }
  });

  test('down() restores the prior body and variables', async () => {
    const { knex, state } = buildKnex();
    await migration.down(knex);

    expect(state.updates).toHaveLength(2);
    for (const { where, patch } of state.updates) {
      // Reverses only rows still carrying exactly what up() wrote.
      expect(where.body).toContain('{service_type}');
      expect(patch.body).toContain('{reentry_line}');
      expect(JSON.parse(patch.variables)).toContain('reentry_line');
    }
  });

  test('every placeholder in the new bodies is supplied by the vars builder', () => {
    // The failure this guards is silent and total: an unresolved placeholder
    // suppresses the whole send rather than rendering blank (#3121).
    const vars = buildServiceReportV1SmsVars({
      customerFirstName: 'Adam',
      reportUrl: 'https://portal.wavespestcontrol.com/r/abc',
      payUrl: 'https://portal.wavespestcontrol.com/p/xyz',
      serviceType: 'Lawn Care',
    });

    for (const [, , nextBody] of migration.REWRITES) {
      const placeholders = [...nextBody.matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
      expect(placeholders.length).toBeGreaterThan(0);
      for (const name of placeholders) {
        expect(Object.prototype.hasOwnProperty.call(vars, name)).toBe(true);
      }
    }

    // reentry_line is retired from the bodies but STILL supplied, so a stale
    // row or a half-applied migration can never silence a completion text.
    expect(vars.reentry_line).toBe('');
  });
});
