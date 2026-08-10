/**
 * Catalog short-name ambiguity — fail closed instead of guessing an identity.
 *
 * `services.short_name` is a display abbreviation with no uniqueness
 * constraint, and the LIVE catalog shares it across services that behave
 * differently: "Lawn Care" is carried by five active rows (four recurring +
 * lawn_care_one_time) and "Mosquito" by two (mosquito_monthly +
 * mosquito_one_time).
 *
 * lookupServiceForScheduledService fell back to `.first()` on that column with
 * no ORDER BY, so which identity a visit got was physical heap order. Picking
 * the one_time row for a recurring customer's visit sets billing_type
 * 'one_time' ⇒ typedOneTimeBilling TRUE ⇒ shouldAutoInvoiceCompletion mints a
 * completion invoice for a visit the customer's plan already covers.
 *
 * DB-backed assertions self-skip without DATABASE_URL, mirroring
 * completion-lane-coverage-contract.test.js.
 */
const path = require('path');
const profiles = require('../services/service-completion-profiles');

// Minimal knex double: `knex('services')` → builder. The exact-name path uses
// .whereRaw().first(); the short-name path uses .whereRaw().limit().select().
function fakeKnex({ byName = [], byShortName = [] } = {}) {
  const calls = { name: 0, shortName: 0 };
  const builder = () => ({
    whereRaw: (sql, [value]) => {
      const isName = /lower\(name\)/.test(sql);
      if (isName) {
        calls.name += 1;
        return {
          first: async () => byName.find((r) => r.name.toLowerCase() === String(value).toLowerCase()) || undefined,
        };
      }
      calls.shortName += 1;
      const hits = byShortName.filter((r) => String(r.short_name).toLowerCase() === String(value).toLowerCase());
      return { limit: (n) => ({ select: async () => hits.slice(0, n) }) };
    },
  });
  builder.schema = { hasTable: async () => false };
  return { builder, calls };
}

const LAWN_ROWS = [
  { service_key: 'lawn_care_quarterly', name: 'Quarterly Lawn Care Service', short_name: 'Lawn Care', category: 'lawn_care', billing_type: 'recurring' },
  { service_key: 'lawn_care_one_time', name: 'One-Time Lawn Care Service', short_name: 'Lawn Care', category: 'lawn_care', billing_type: 'one_time' },
  { service_key: 'lawn_care_6week', name: 'Every 6 Weeks Lawn Care Service', short_name: 'Lawn Care', category: 'lawn_care', billing_type: 'recurring' },
];

describe('ambiguous short_name resolves NOTHING', () => {
  test('a short name shared by several services yields no identity', async () => {
    const { builder } = fakeKnex({ byShortName: LAWN_ROWS });
    const profile = await profiles.resolveCompletionProfileForScheduledService(
      { service_type: 'Lawn Care' }, builder,
    );
    // Falls back to the generic service-report profile — never a coin flip.
    expect(profile.serviceKey).toBeNull();
    expect(profile.billingType).toBeNull();
    expect(profile.completionMode).toBe('service_report');
  });

  test('CRITICAL: it can never return the one_time identity for a shared name', async () => {
    // The money case. billing_type 'one_time' drives typedOneTimeBilling, which
    // mints a completion invoice for a plan-covered recurring lawn visit.
    for (let i = 0; i < 5; i += 1) {
      const rows = [...LAWN_ROWS].sort(() => (i % 2 ? 1 : -1)); // any heap order
      const { builder } = fakeKnex({ byShortName: rows });
      const profile = await profiles.resolveCompletionProfileForScheduledService(
        { service_type: 'Lawn Care' }, builder,
      );
      expect(profile.billingType).not.toBe('one_time');
    }
  });

  test('an UNambiguous short name still resolves', async () => {
    const { builder } = fakeKnex({
      byShortName: [{ service_key: 'wdo_inspection', name: 'WDO Inspection Service', short_name: 'WDO Inspect', category: 'termite', billing_type: 'one_time' }],
    });
    const profile = await profiles.resolveCompletionProfileForScheduledService(
      { service_type: 'WDO Inspect' }, builder,
    );
    expect(profile.serviceKey).toBe('wdo_inspection');
    expect(profile.billingType).toBe('one_time');
  });

  test('an exact NAME match still wins before short_name is consulted', async () => {
    const { builder, calls } = fakeKnex({
      byName: [{ service_key: 'lawn_care_one_time', name: 'One-Time Lawn Care Service', category: 'lawn_care', billing_type: 'one_time' }],
      byShortName: LAWN_ROWS,
    });
    const profile = await profiles.resolveCompletionProfileForScheduledService(
      { service_type: 'One-Time Lawn Care Service' }, builder,
    );
    expect(profile.serviceKey).toBe('lawn_care_one_time');
    expect(calls.shortName).toBe(0);
  });
});

const knexConfig = require(path.join(__dirname, '..', 'knexfile.js'));
const describeOrSkip = process.env.DATABASE_URL ? describe : describe.skip;

describeOrSkip('live catalog short-name collisions', () => {
  let knex;
  beforeAll(() => {
    knex = require('knex')(knexConfig[process.env.NODE_ENV || 'development'] || knexConfig.development);
  });
  afterAll(async () => { if (knex) await knex.destroy(); });

  test('no ACTIVE short-name collision mixes one_time with recurring', async () => {
    // The dangerous shape specifically: a shared abbreviation whose rows
    // disagree on billing_type decides whether a visit auto-invoices. The code
    // now fails closed, so this is a data-hygiene alarm rather than a crash —
    // it fails loudly with the offending group so the catalog gets fixed.
    const rows = await knex('services')
      .whereNotNull('short_name')
      .where({ is_active: true })
      .select('service_key', 'short_name', 'billing_type');
    const groups = new Map();
    for (const r of rows) {
      const k = String(r.short_name).toLowerCase();
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(r);
    }
    const mixed = [...groups.entries()]
      .filter(([, g]) => g.length > 1 && new Set(g.map((r) => r.billing_type)).size > 1)
      .map(([k, g]) => `${k}: ${g.map((r) => `${r.service_key}(${r.billing_type})`).join(', ')}`);
    // Known and accepted TODAY (the code fails closed on both); listed so a NEW
    // collision fails this test instead of hiding among them.
    const KNOWN = ['lawn care', 'mosquito'];
    const unexpected = mixed.filter((m) => !KNOWN.includes(m.split(':')[0]));
    expect(unexpected).toEqual([]);
  });
});
