/**
 * Area add-ons are never cut by a percentage, in every path that prices a visit or an add-on row by CATALOG key
 * (Codex round 9 on #6135). The engine line says `discountable: false`, but the six `area_addon_*` catalog rows carry no
 * engine_keys, so the scheduler (booking, update, extension), the picker's flags, the completion pricing and the IB
 * reprice tools judge them by WAVEGUARD.excludedFromPercentDiscount. A 10% discount used to turn an $89 add-on into $80.10.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';
jest.mock('../models/db', () => jest.fn());
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (req, res, next) => next(),
  requireAdmin: (req, res, next) => next(),
  requireTechOrAdmin: (req, res, next) => next(),
}));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const fs = require('fs');
const path = require('path');
const { WAVEGUARD, AREA_ADDONS } = require('../services/pricing-engine/constants');
const { getEffectiveDiscount, serviceExcludedFromPercentDiscount } = require('../services/pricing-engine/discount-engine');
const schedule = require('../routes/admin-schedule');

const KEYS = Object.values(AREA_ADDONS.items).map((cfg) => cfg.serviceKey);
const GOLD = { tier: 'gold', discount: 0.15 };

describe('the shared exclusion authority lists every add-on catalog key', () => {
  test('the six catalog keys and the engine key are excluded, taken from the one AREA_ADDONS table', () => {
    expect(KEYS).toHaveLength(6);
    for (const key of [...KEYS, 'area_addon']) {
      expect(WAVEGUARD.excludedFromPercentDiscount[key]).toBe(true);
      expect(serviceExcludedFromPercentDiscount(key)).toBe(true);
    }
  });

  test('the scheduler\'s catalog judge (and so the picker flags) agree, with no engine_keys on the row', () => {
    for (const key of KEYS) expect(schedule.lineExcludedFromPercentDiscount(key, new Map())).toBe(true);
    expect(schedule.lineExcludedFromPercentDiscount('pest_general_quarterly', new Map())).toBe(false);
  });

  test('a 10% discount no longer turns an $89 add-on into $80.10: preview and write paths price it at $89', () => {
    const discount = { discountType: 'percentage', discountAmount: 10 };
    const pct = { discountType: 'percentage', amount: 10, discountDollars: null };
    const sweep = { serviceKey: 'area_addon_web_sweep', serviceCategory: 'pest_control', price: 89 };
    const out = schedule._test.calculateVisitFinancialsForAddons({ primaryNet: 0, appointmentDiscount: { ...discount, ...pct } }, [sweep]);
    expect(out.price).toBe(89);
    expect(out.appointmentDiscountDollars).toBeNull();
    // A discountable line next to it still gets its percentage, on its own price only.
    const mixed = schedule._test.calculateVisitFinancialsForAddons({ primaryNet: 100, primaryServiceKey: 'pest_general_quarterly', appointmentDiscount: { ...discount, ...pct } }, [sweep]);
    expect(mixed.price).toBe(179);
  });

  test('the completion pricing and the engine\'s own tier path: no WaveGuard percentage, no one-time perk', () => {
    for (const key of [...KEYS, 'area_addon']) {
      expect(getEffectiveDiscount(key, GOLD, { isOneTimeService: true, isRecurringCustomer: true })).toMatchObject({ effectiveDiscount: 0, totalDiscount: 0 });
    }
  });
});

describe('the sweep of every path that prices a visit or an add-on row by catalog key', () => {
  const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

  test('the schedule paths all judge a line by lineExcludedFromPercentDiscount (the shared authority), none by a private key list', () => {
    const src = read('routes/admin-schedule.js');
    // booking, update-details/extension restack, stored-visit financials, the new-appointment catalog feed, the preset filter
    expect((src.match(/lineExcludedFromPercentDiscount\(/g) || []).length).toBeGreaterThanOrEqual(15);
    expect(src).not.toMatch(/excludedKeys?\s*=\s*new Set\(\[[^\]]*termite_bond/);
  });

  test('completion pricing reads the same authority and the engine line flag; the IB reprice tool reads the schedule judge', () => {
    expect(read('services/completion-pricing.js')).toContain("require('./pricing-engine/discount-engine')");
    expect(read('services/completion-pricing.js')).toContain('lineFlagsBlockPercentDiscount(line.sourceLine)');
    expect(read('services/intelligence-bar/tools.js')).toContain('lineExcludedFromPercentDiscount(catalogRow.service_key || null)');
  });

  test('annual prepay never carries an add-on (the estimate is one-time only), and the catalog rule rows exclude the keys too', () => {
    expect(read('services/annual-prepay-estimate-suggestion.js')).toContain('annualPrepayBlockingAddOnReason(estData, { pricingAuthority: estimate.pricing_authority })');
    const migration = require('../models/migrations/20261010100000_area_addon_discount_rules');
    expect(migration.SERVICE_KEYS).toEqual(KEYS);
  });
});

describe('20261010100000: the service_discount_rules rows', () => {
  const migration = require('../models/migrations/20261010100000_area_addon_discount_rules');
  function fakeKnex(existing = []) {
    const rules = existing.map((key) => ({ service_key: key, notes: 'staff note', exclude_from_pct_discount: false }));
    const knex = (table) => {
      if (table !== 'service_discount_rules') throw new Error(`unexpected ${table}`);
      const preds = [];
      const q = {
        where(cond) { preds.push((r) => Object.entries(cond).every(([k, v]) => r[k] === v)); return q; },
        whereIn(col, values) { preds.push((r) => values.includes(r[col])); return q; },
        first() { return Promise.resolve(rules.find((r) => preds.every((p) => p(r)))); },
        insert(row) { return { onConflict: () => ({ ignore: async () => { if (!rules.some((r) => r.service_key === row.service_key)) rules.push({ ...row }); } }) }; },
        async del() { const hit = rules.filter((r) => preds.every((p) => p(r))); for (const r of hit) rules.splice(rules.indexOf(r), 1); return hit.length; },
      };
      return q;
    };
    knex.schema = { hasTable: async (t) => t === 'service_discount_rules' };
    knex.fn = { now: () => 'now()' };
    knex.rules = rules;
    return knex;
  }

  test('inserts one excluded row per key, skips a row that exists, is idempotent, and down removes only its own', async () => {
    const knex = fakeKnex(['area_addon_web_sweep']);
    await migration.up(knex);
    await migration.up(knex);
    expect(knex.rules).toHaveLength(6);
    expect(knex.rules.find((r) => r.service_key === 'area_addon_web_sweep').notes).toBe('staff note');
    expect(knex.rules.filter((r) => r.notes === migration.NOTE).every((r) => r.exclude_from_pct_discount === true && r.tier_qualifier === false)).toBe(true);
    await migration.down(knex);
    expect(knex.rules.map((r) => r.service_key)).toEqual(['area_addon_web_sweep']);
  });

  test('a missing table is skipped', async () => {
    const knex = fakeKnex();
    knex.schema = { hasTable: async () => false };
    await migration.up(knex);
    await migration.down(knex);
    expect(knex.rules).toEqual([]);
  });
});
