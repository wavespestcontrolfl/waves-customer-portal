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
const { pricePestInitialRoach, generateEstimate } = require('../services/pricing-engine');
const { mapV1ToLegacyShape } = require('../services/pricing-engine/v1-legacy-mapper');
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

  test('v1 legacy mapper carries treatments onto the persisted one-time item', () => {
    const next = cloneInitialRoach();
    next.display.regular = { name: 'Cockroach Treatment', treatments: 2 };
    constants.PEST.pestInitialRoach = next;

    // Server-authoritative admin estimates persist through mapV1ToLegacyShape
    // (admin-estimate-persistence) — the public estimate view reads
    // `treatments` off the saved item, so the mapper must not drop it.
    const mapped = mapV1ToLegacyShape(generateEstimate({
      homeSqFt: 2000,
      services: { pest: { frequency: 'quarterly', roachType: 'regular' } },
    }));
    const item = (mapped.oneTime.items || []).find((it) => it.service === 'pest_initial_roach');
    expect(item).toBeTruthy();
    expect(item.treatments).toBe(2);
    expect(item.name).toBe('Cockroach Treatment');
  });

  test('db-bridge reverts a species to code defaults when the row stops carrying it', async () => {
    const dbFor = (display) => {
      const rows = [{ config_key: 'pest_base', data: JSON.stringify({ base: 117, initial_roach: { display } }) }];
      const db = (table) => {
        const query = {
          select: jest.fn(async () => (table === 'pricing_config' ? rows : [])),
          orderBy: jest.fn(() => query),
          then: (resolve) => resolve([]),
        };
        return query;
      };
      db.schema = { hasTable: jest.fn(async () => true) };
      return db;
    };

    // Sync 1: admin customized the german entry.
    await syncConstantsFromDB(dbFor({ german: { name: 'German Roach Rescue', treatments: 3 } }));
    expect(constants.PEST.pestInitialRoach.display.german).toEqual({ name: 'German Roach Rescue', treatments: 3 });

    // Sync 2: the row no longer carries german (removed via Raw JSON). The
    // merge rebases on the pristine in-code defaults, so the customization
    // must revert NOW — not at the next process restart (codex P2, PR #3078).
    await syncConstantsFromDB(dbFor({ regular: { name: 'Roach Rescue', treatments: 2 } }));
    expect(constants.PEST.pestInitialRoach.display.german).toEqual({ name: 'German Cockroach Treatment', treatments: 1 });
    expect(constants.PEST.pestInitialRoach.display.regular).toEqual({ name: 'Roach Rescue', treatments: 2 });
  });

  test('engine-invocation estimates surface the roach fee card with treatments', async () => {
    // Agent estimates persist raw engineInputs (no v1 result shape), so the
    // pricing bundle takes the engine-invocation branch — it must push the
    // same pest_initial_roach first-visit fee the v1 branch does, or the
    // recurring view never shows the configured name/count (codex P2).
    const { buildPricingBundle } = require('../routes/estimate-public');
    const bundle = await buildPricingBundle({
      id: 'estimate-test-roach-engine-branch',
      status: 'draft',
      waveguard_tier: 'Bronze',
      estimate_data: {
        engineInputs: {
          homeSqFt: 2000,
          services: { pest: { frequency: 'quarterly', roachType: 'regular' } },
        },
      },
    });
    const roachFee = (bundle.firstVisitFees || []).find((f) => f.service === 'pest_initial_roach');
    expect(roachFee).toBeTruthy();
    expect(roachFee.amount).toBe(139);
    expect(roachFee.label).toBe('Cockroach Treatment');
    expect(roachFee.treatments).toBe(1);
    expect(roachFee.waivedWithPrepay).toBe(false);
  });

  test('standalone roach work is NOT promoted into first-visit fees (codex #3078 r4 P1)', async () => {
    // A standalone services.pestInitialRoach line shares the service key with
    // the auto-fired recurring-pest add-on but is ordinary one-time work.
    // Promoted alongside a non-pest recurring bundle, the client hid the
    // charge: no recurring pest → showWaveGuardSetupFee false → no fee card,
    // while OneTimeBreakdownCard still excludes every firstVisitFees service.
    const { buildPricingBundle } = require('../routes/estimate-public');
    const bundle = await buildPricingBundle({
      id: 'estimate-test-roach-standalone-bundle',
      status: 'draft',
      waveguard_tier: 'Bronze',
      estimate_data: {
        engineInputs: {
          homeSqFt: 2000,
          services: {
            pestInitialRoach: { roachType: 'regular' },
            lawn: { track: 'A' },
          },
        },
      },
    });
    expect((bundle.firstVisitFees || []).find((f) => f.service === 'pest_initial_roach')).toBeUndefined();
    // The charge stays visible in the one-time breakdown instead.
    const breakdownRow = (bundle.oneTimeBreakdown?.items || []).find((it) => it.service === 'pest_initial_roach');
    expect(breakdownRow).toBeTruthy();
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

  const SEEDED_DISPLAY = {
    regular: { name: 'Cockroach Treatment', treatments: 1 },
    german: { name: 'German Cockroach Treatment', treatments: 1 },
    regular_standalone: { name: 'Cockroach Treatment', treatments: 1 },
  };
  const OWNING_AUDIT_ROW = {
    changed_by: 'migration:20260730110000',
    reason: 'Seed initial_roach.display (customer-facing name + treatment count, owner directive 2026-07-30)',
  };

  test('down() strips display only when up() owns it via the audit row', async () => {
    const owned = fakeKnex({
      pestBaseData: { base: 117, initial_roach: { regular: [{ sqft: null, price: 169 }], display: SEEDED_DISPLAY } },
      auditRows: [OWNING_AUDIT_ROW],
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

  test('down() strips a seeded block even when jsonb reordered its keys', async () => {
    // pricing_config.data is jsonb — Postgres does not preserve object-key
    // insertion order, so the block can come back with species (and inner
    // keys) reordered while still being exactly what up() seeded. The
    // rollback comparison must be structural, not string-order (codex P2).
    const reordered = {
      german: { treatments: 1, name: 'German Cockroach Treatment' },
      regular_standalone: { treatments: 1, name: 'Cockroach Treatment' },
      regular: { treatments: 1, name: 'Cockroach Treatment' },
    };
    const { knex, state } = fakeKnex({
      pestBaseData: { base: 117, initial_roach: { display: reordered } },
      auditRows: [OWNING_AUDIT_ROW],
    });
    await migration.down(knex);
    expect(state.updated).toBeTruthy();
    expect(JSON.parse(state.updated.data).initial_roach.display).toBeUndefined();
  });

  test('down() preserves a display block the admin edited after the migration ran', async () => {
    // Owning audit row exists, but the live block no longer matches what
    // up() seeded (admin bumped treatments to 2) — rollback must not erase
    // the operator's edit (codex P2 on PR #3078).
    const edited = fakeKnex({
      pestBaseData: {
        base: 117,
        initial_roach: {
          display: { ...SEEDED_DISPLAY, regular: { name: 'Cockroach Treatment', treatments: 2 } },
        },
      },
      auditRows: [OWNING_AUDIT_ROW],
    });
    await migration.down(edited.knex);
    expect(edited.state.updated).toBeNull();
    expect(edited.state.auditInserts).toHaveLength(0);
  });
});
