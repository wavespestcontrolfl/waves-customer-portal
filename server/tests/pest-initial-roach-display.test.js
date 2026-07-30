/**
 * Cockroach Treatment display config (owner directive 2026-07-30).
 *
 * The recurring-customer roach add-on (`pest_initial_roach`) renders with an
 * admin-editable customer-facing name + treatment-visit count from
 * pest_base.initial_roach.display. These tests pin:
 *   - the renamed defaults (no "Initial" anywhere in the label),
 *   - config-driven label/treatments flowing through the engine line item,
 *   - db-bridge merging a partial/invalid display blob safely, and
 *   - the seed migration's read-modify-write + audit-keyed rollback.
 */
const constants = require('../services/pricing-engine/constants');
const { syncConstantsFromDB } = require('../services/pricing-engine/db-bridge');
const { pricePestInitialRoach } = require('../services/pricing-engine');
const migration = require('../models/migrations/20260730110000_pest_initial_roach_display_config');

const PROPERTY = { homeSqFt: 2000 };

function cloneInitialRoach() {
  const src = constants.PEST.pestInitialRoach;
  return {
    regular: src.regular.map((b) => ({ ...b })),
    german: src.german.map((b) => ({ ...b })),
    regular_standalone: src.regular_standalone.map((b) => ({ ...b })),
    display: {
      regular: { ...src.display.regular },
      german: { ...src.display.german },
      regular_standalone: { ...src.display.regular_standalone },
    },
  };
}

describe('pest_initial_roach display config', () => {
  const originalInitialRoach = constants.PEST.pestInitialRoach;

  afterEach(() => {
    constants.PEST.pestInitialRoach = originalInitialRoach;
  });

  test('defaults carry no "Initial" and one treatment visit', () => {
    const regular = pricePestInitialRoach(PROPERTY, { roachType: 'regular', autoFiredFromRecurringPest: true });
    expect(regular.label).toBe('Cockroach Treatment');
    expect(regular.treatments).toBe(1);
    expect(regular.detail).toContain('Includes 1 treatment visit.');
    expect(regular.price).toBe(139);

    const german = pricePestInitialRoach(PROPERTY, { roachType: 'german', autoFiredFromRecurringPest: true });
    expect(german.label).toBe('German Cockroach Treatment');
    expect(german.treatments).toBe(1);
  });

  test('admin-edited name and treatment count flow into the line item', () => {
    const next = cloneInitialRoach();
    next.display.regular = { name: 'Roach Spot Treatment', treatments: 3 };
    constants.PEST.pestInitialRoach = next;

    const line = pricePestInitialRoach(PROPERTY, { roachType: 'regular', autoFiredFromRecurringPest: true });
    expect(line.label).toBe('Roach Spot Treatment');
    expect(line.treatments).toBe(3);
    expect(line.detail).toContain('Includes 3 treatment visits.');
    // Treatment count is display metadata only — the price bracket is untouched.
    expect(line.price).toBe(139);
  });

  test('standalone scale uses its own display entry', () => {
    const next = cloneInitialRoach();
    next.display.regular_standalone = { name: 'One-Time Cockroach Service', treatments: 2 };
    constants.PEST.pestInitialRoach = next;

    const line = pricePestInitialRoach(PROPERTY, { roachType: 'regular', standalone: true });
    expect(line.label).toBe('One-Time Cockroach Service');
    expect(line.treatments).toBe(2);
    expect(line.price).toBe(239);
  });

  test('db-bridge merges a partial display blob and ignores invalid values', async () => {
    const rows = [{
      config_key: 'pest_base',
      data: JSON.stringify({
        base: 117,
        initial_roach: {
          display: {
            regular: { name: '  Roach Rescue  ', treatments: 2 },
            german: { name: '', treatments: 0 }, // both invalid → keep defaults
          },
        },
      }),
    }];
    const db = (table) => {
      const query = {
        select: jest.fn(async () => (table === 'pricing_config' ? rows : [])),
        orderBy: jest.fn(() => query),
        then: (resolve) => resolve([]),
      };
      return query;
    };
    db.schema = { hasTable: jest.fn(async () => true) };

    const synced = await syncConstantsFromDB(db);
    expect(synced).toBe(true);
    expect(constants.PEST.pestInitialRoach.display.regular).toEqual({ name: 'Roach Rescue', treatments: 2 });
    expect(constants.PEST.pestInitialRoach.display.german).toEqual({ name: 'German Cockroach Treatment', treatments: 1 });
    expect(constants.PEST.pestInitialRoach.display.regular_standalone).toEqual({ name: 'Cockroach Treatment', treatments: 1 });
  });
});

describe('20260730110000 seed migration', () => {
  function fakeKnex({ pestBaseData, auditRows = [], hasAuditTable = true }) {
    const state = {
      updated: null,
      auditInserts: [],
    };
    const knex = (table) => {
      if (table === 'pricing_config') {
        return {
          where: (cond) => {
            expect(cond).toEqual({ config_key: 'pest_base' });
            return {
              first: async () => (pestBaseData === null ? undefined : { config_key: 'pest_base', data: JSON.stringify(pestBaseData) }),
              update: async (payload) => { state.updated = payload; return 1; },
            };
          },
        };
      }
      if (table === 'pricing_config_audit') {
        return {
          insert: async (row) => { state.auditInserts.push(row); return [1]; },
          where: (cond) => ({
            first: async () => auditRows.find((r) => r.changed_by === cond.changed_by && r.reason === cond.reason),
          }),
        };
      }
      throw new Error(`unexpected table ${table}`);
    };
    knex.schema = {
      hasTable: async (table) => (table === 'pricing_config_audit' ? hasAuditTable : true),
    };
    knex.fn = { now: () => new Date(0) };
    return { knex, state };
  }

  test('up() adds display, preserves tuned brackets, writes audit', async () => {
    const tunedBrackets = { regular: [{ sqft: 1500, price: 129 }, { sqft: null, price: 189 }] };
    const { knex, state } = fakeKnex({ pestBaseData: { base: 120, floor: 89, initial_roach: tunedBrackets } });

    await migration.up(knex);

    expect(state.updated).toBeTruthy();
    const written = JSON.parse(state.updated.data);
    expect(written.base).toBe(120);
    expect(written.initial_roach.regular).toEqual(tunedBrackets.regular);
    expect(written.initial_roach.display.regular).toEqual({ name: 'Cockroach Treatment', treatments: 1 });
    expect(written.initial_roach.display.german).toEqual({ name: 'German Cockroach Treatment', treatments: 1 });
    expect(state.auditInserts).toHaveLength(1);
    expect(state.auditInserts[0].config_key).toBe('pest_base');
  });

  test('up() skips a row that already carries a display block', async () => {
    const { knex, state } = fakeKnex({
      pestBaseData: { base: 117, initial_roach: { display: { regular: { name: 'Custom', treatments: 2 } } } },
    });

    await migration.up(knex);

    expect(state.updated).toBeNull();
    expect(state.auditInserts).toHaveLength(0);
  });

  test('down() strips display only when up() owns it via the audit row', async () => {
    const owned = fakeKnex({
      pestBaseData: { base: 117, initial_roach: { regular: [{ sqft: null, price: 169 }], display: { regular: { name: 'Cockroach Treatment', treatments: 1 } } } },
      auditRows: [{
        changed_by: 'migration:20260730110000',
        reason: 'Seed initial_roach.display (customer-facing name + treatment count, owner directive 2026-07-30)',
      }],
    });
    await migration.down(owned.knex);
    expect(owned.state.updated).toBeTruthy();
    const written = JSON.parse(owned.state.updated.data);
    expect(written.initial_roach.display).toBeUndefined();
    expect(written.initial_roach.regular).toEqual([{ sqft: null, price: 169 }]);

    // No owning audit row → admin-authored display survives rollback.
    const unowned = fakeKnex({
      pestBaseData: { base: 117, initial_roach: { display: { regular: { name: 'Admin Custom', treatments: 4 } } } },
      auditRows: [],
    });
    await migration.down(unowned.knex);
    expect(unowned.state.updated).toBeNull();
  });
});
