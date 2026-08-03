const migration = require('../models/migrations/20260802100000_service_report_sms_name_the_service');
const { buildServiceReportV1SmsVars } = require('../services/service-report/delivery');

// Chainable stub over BOTH tables the migration touches. getTemplate prefers an
// active variant body over the base row, so a migration that rewrites
// sms_templates alone leaves variant recipients on the old copy — `variants`
// tracks that second sweep separately from `updates`.
function buildKnex({ matched = 1, hasVariantsTable = true } = {}) {
  const state = { updates: [], variants: [] };
  const knex = jest.fn((table) => {
    expect(['sms_templates', 'sms_template_variants']).toContain(table);
    const sink = table === 'sms_templates' ? state.updates : state.variants;
    const query = {
      where: jest.fn((criteria) => { query.__where = criteria; return query; }),
      update: jest.fn(async (patch) => {
        sink.push({ where: query.__where, patch });
        return matched;
      }),
      columnInfo: jest.fn(async () => ({ body: {}, updated_at: {}, variables: {} })),
    };
    return query;
  });
  knex.schema = {
    hasTable: jest.fn(async (t) => (t === 'sms_template_variants' ? hasVariantsTable : true)),
  };
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

  test('sweeps sms_template_variants too — a variant outranks the base row', () => {
    // getTemplate resolves `variant?.body || t.body`, so rewriting the base
    // alone would leave variant recipients on the old generic copy.
    const { knex, state } = buildKnex();
    return migration.up(knex).then(() => {
      expect(state.variants.length).toBeGreaterThan(0);
      for (const { where, patch } of state.variants) {
        expect(where).toHaveProperty('template_key');
        expect(where).toHaveProperty('body');
        expect(patch.body).toContain('{service_type}');
        expect(patch.body).not.toContain('{reentry_line}');
      }
      // Two generations swept forward per key: the body this migration
      // expects, plus the pre-house-voice body an older variant would carry.
      const perKey = state.variants.filter((v) => v.where.template_key === 'service_report_v1');
      expect(perKey.length).toBe(2);
    });
  });

  test('a missing variants table is not an error', async () => {
    const { knex, state } = buildKnex({ hasVariantsTable: false });
    await expect(migration.up(knex)).resolves.toBeUndefined();
    expect(state.updates).toHaveLength(2);
    expect(state.variants).toHaveLength(0);
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
