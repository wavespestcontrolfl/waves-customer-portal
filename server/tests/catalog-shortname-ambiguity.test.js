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
function fakeKnex({ byName = [], byShortName = [], byKey = [] } = {}) {
  const calls = { name: 0, shortName: 0, key: 0 };
  const builder = () => ({
    // service_id / service_key_snapshot lookups
    where: (cond) => {
      calls.key += 1;
      return {
        first: async () => byKey.find((r) => r.service_key === cond.service_key) || undefined,
      };
    },
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

  test('service_key_snapshot settles identity BEFORE any label matching', async () => {
    // The legitimate one-time visit the fail-closed rule would otherwise strand
    // (codex #3334 r2 P1): its LABEL is the ambiguous abbreviation, but the row
    // names its catalog key outright.
    const { builder, calls } = fakeKnex({
      byKey: [{ service_key: 'lawn_care_one_time', name: 'One-Time Lawn Care Service', category: 'lawn_care', billing_type: 'one_time' }],
      byShortName: LAWN_ROWS,
    });
    const profile = await profiles.resolveCompletionProfileForScheduledService(
      { service_type: 'Lawn Care', service_key_snapshot: 'lawn_care_one_time' }, builder,
    );
    expect(profile.serviceKey).toBe('lawn_care_one_time');
    expect(profile.billingType).toBe('one_time');
    expect(calls.name).toBe(0);
    expect(calls.shortName).toBe(0);
  });

  test('is_recurring TRUE narrows away the one_time candidate', async () => {
    const { builder } = fakeKnex({
      byShortName: [
        { service_key: 'mosquito_monthly', name: 'Monthly Mosquito Control Service', short_name: 'Mosquito', category: 'mosquito', billing_type: 'recurring' },
        { service_key: 'mosquito_one_time', name: 'One-Time Mosquito Control Service', short_name: 'Mosquito', category: 'mosquito', billing_type: 'one_time' },
      ],
    });
    const profile = await profiles.resolveCompletionProfileForScheduledService(
      { service_type: 'Mosquito', is_recurring: true }, builder,
    );
    expect(profile.serviceKey).toBe('mosquito_monthly');
  });

  test('is_recurring FALSE does NOT narrow — the column defaults false', async () => {
    // Deliberate asymmetry. `false` is indistinguishable from "never set"
    // (nullable, DEFAULT false), so trusting it would let a recurring visit
    // resolve to the one_time row and auto-invoice a plan-covered customer.
    const { builder } = fakeKnex({
      byShortName: [
        { service_key: 'mosquito_monthly', name: 'Monthly Mosquito Control Service', short_name: 'Mosquito', category: 'mosquito', billing_type: 'recurring' },
        { service_key: 'mosquito_one_time', name: 'One-Time Mosquito Control Service', short_name: 'Mosquito', category: 'mosquito', billing_type: 'one_time' },
      ],
    });
    const profile = await profiles.resolveCompletionProfileForScheduledService(
      { service_type: 'Mosquito', is_recurring: false }, builder,
    );
    expect(profile.serviceKey).toBeNull();
    expect(profile.billingType).toBeNull();
  });

  test('narrowing can never INVENT an identity (recurring-only collision)', async () => {
    // All 4 lawn recurring rows survive narrowing ⇒ still ambiguous ⇒ null.
    const { builder } = fakeKnex({ byShortName: LAWN_ROWS.filter((r) => r.billing_type === 'recurring') });
    const profile = await profiles.resolveCompletionProfileForScheduledService(
      { service_type: 'Lawn Care', is_recurring: true }, builder,
    );
    expect(profile.serviceKey).toBeNull();
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
// The DB-gated CI stage DISCOVERS suites by grepping for this exact literal
// (.github/workflows/tests.yml) — a differently-worded guard means the suite
// runs in NEITHER stage and its contract silently never executes (codex
// #3334 r2 P2). Keep the marker verbatim.
const SKIP = !process.env.DATABASE_URL;
const describeOrSkip = SKIP ? describe.skip : describe;

describeOrSkip('live catalog short-name collisions', () => {
  let knex;
  beforeAll(() => {
    knex = require('knex')(knexConfig[process.env.NODE_ENV || 'development'] || knexConfig.development);
  });
  afterAll(async () => { if (knex) await knex.destroy(); });

  test('no short-name collision mixes one_time with recurring', async () => {
    // The dangerous shape specifically: a shared abbreviation whose rows
    // disagree on billing_type decides whether a visit auto-invoices. The code
    // now fails closed, so this is a data-hygiene alarm rather than a crash —
    // it fails loudly with the offending group so the catalog gets fixed.
    //
    // NO is_active filter, deliberately (codex #3334 r2 P2): the RESOLVER does
    // not filter either, so an active row colliding with an ARCHIVED one still
    // returns two rows and still refuses to resolve. Filtering here would let
    // this contract report a collision as fixed while name-only appointments
    // kept falling through to the generic profile. Contract and resolver must
    // read the same rows.
    const rows = await knex('services')
      .whereNotNull('short_name')
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
