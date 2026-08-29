/**
 * Series children resolve the CURRENT catalog identity at insert instead of
 * copying parent.service_type verbatim (owner GO 2026-08-29, follow-up to
 * the label backfills 20260829000010/000040 — a terminal parent keeps its
 * retired label by Invariant 1, so verbatim copying kept birthing stale
 * children).
 *
 * Covers: the resolver's fail-closed contract (linked → current catalog
 * name; unlinked → rename alias / legacy (label, cadence) map → exactly one
 * ACTIVE row, born linked; anything else verbatim + unlinked), the runtime
 * legacy map equalling the backfill migration's table, and source guards
 * over every child-insert site in admin-schedule.js (house style —
 * recurring-spawn-hardening).
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const { resolveSeriesChildIdentity } = require('../services/service-catalog-names');
const {
  LEGACY_LABEL_CADENCE_NAMES, legacyCatalogName, renamedCatalogName, counterpartServiceName,
} = require('../config/service-name-aliases');

function fakeConn(services, { fail = false } = {}) {
  return (table) => {
    if (table !== 'services') throw new Error(`unexpected table ${table}`);
    const filters = [];
    let lowerName = null;
    const q = {
      where(cond) { filters.push(cond); return q; },
      whereRaw(sql, bindings) {
        if (sql !== 'lower(name) = lower(?)') throw new Error(`unexpected whereRaw ${sql}`);
        lowerName = String(bindings[0]).toLowerCase();
        return q;
      },
      rows() {
        if (fail) throw new Error('db down');
        return services.filter((s) => (lowerName == null || String(s.name).toLowerCase() === lowerName)
          && filters.every((f) => Object.entries(f).every(([k, v]) => s[k] === v)));
      },
      async select() { return q.rows().map((s) => ({ ...s })); },
      async first() { return q.rows()[0] || null; },
    };
    return q;
  };
}

const CATALOG = [
  { id: 'svc-q', name: 'Quarterly Pest Control Service', service_key: 'pest_quarterly', is_active: true },
  { id: 'svc-m', name: 'Monthly Pest Control Service', service_key: 'pest_monthly', is_active: true },
  { id: 'svc-bm', name: 'Bi-Monthly Pest Control Service', service_key: 'pest_general_bimonthly', is_active: true },
  { id: 'svc-mosq', name: 'Mosquito Control', service_key: 'mosquito', is_active: true },
  { id: 'svc-retired', name: 'Retired Thing', service_key: 'retired', is_active: false },
  // two ACTIVE rows with one name — ambiguous, never a link target
  { id: 'svc-dup-a', name: 'Palm Care', service_key: 'palm_a', is_active: true },
  { id: 'svc-dup-b', name: 'Palm Care', service_key: 'palm_b', is_active: true },
];

describe('resolveSeriesChildIdentity', () => {
  test('linked parent → the catalog row\'s CURRENT name (a rename after stamping propagates), same link', async () => {
    const parent = { id: 'p', service_id: 'svc-q', service_type: 'Quarterly Pest Control', recurring_pattern: 'quarterly' };
    await expect(resolveSeriesChildIdentity(fakeConn(CATALOG), parent)).resolves.toEqual(
      { service_type: 'Quarterly Pest Control Service', service_id: 'svc-q', service_key: 'pest_quarterly' }
    );
  });

  test('linked parent whose row is gone → verbatim label, link kept as-is', async () => {
    const parent = { id: 'p', service_id: 'svc-missing', service_type: 'Old Label' };
    await expect(resolveSeriesChildIdentity(fakeConn(CATALOG), parent)).resolves.toEqual(
      { service_type: 'Old Label', service_id: 'svc-missing', service_key: null }
    );
  });

  test('unlinked pre-convention label + cadence → legacy map → born linked to the one active row', async () => {
    const parent = { id: 'p', service_id: null, service_type: 'Pest Control', recurring_pattern: 'monthly' };
    await expect(resolveSeriesChildIdentity(fakeConn(CATALOG), parent)).resolves.toEqual(
      { service_type: 'Monthly Pest Control Service', service_id: 'svc-m', service_key: 'pest_monthly' }
    );
    // Same label, other cadence → other row: the pair is the evidence.
    await expect(resolveSeriesChildIdentity(fakeConn(CATALOG), { ...parent, recurring_pattern: 'quarterly' })).resolves.toEqual(
      { service_type: 'Quarterly Pest Control Service', service_id: 'svc-q', service_key: 'pest_quarterly' }
    );
  });

  test('unlinked pre-rename catalog name → rename alias → current row', async () => {
    const parent = { id: 'p', service_id: null, service_type: 'General Pest Control Service (Bi-Monthly)', recurring_pattern: 'bimonthly' };
    await expect(resolveSeriesChildIdentity(fakeConn(CATALOG), parent)).resolves.toEqual(
      { service_type: 'Bi-Monthly Pest Control Service', service_id: 'svc-bm', service_key: 'pest_general_bimonthly' }
    );
  });

  test('unlinked current name → born linked by exact (case-insensitive) match', async () => {
    const parent = { id: 'p', service_id: null, service_type: 'mosquito control', recurring_pattern: 'monthly' };
    await expect(resolveSeriesChildIdentity(fakeConn(CATALOG), parent)).resolves.toEqual(
      { service_type: 'Mosquito Control', service_id: 'svc-mosq', service_key: 'mosquito' }
    );
  });

  test('fails closed to verbatim + unlinked: unknown label, ambiguous cadence, inactive-only row, ambiguous name, DB failure', async () => {
    const verbatim = (label, pattern = 'quarterly') => ({ service_type: label, service_id: null, service_key: null });
    await expect(resolveSeriesChildIdentity(fakeConn(CATALOG), { service_id: null, service_type: 'Owner Custom Plan' })).resolves.toEqual(verbatim('Owner Custom Plan'));
    // "Pest Control" on a custom interval: no (label, cadence) pair, no exact row
    await expect(resolveSeriesChildIdentity(fakeConn(CATALOG), { service_id: null, service_type: 'Pest Control', recurring_pattern: 'custom' })).resolves.toEqual(verbatim('Pest Control'));
    await expect(resolveSeriesChildIdentity(fakeConn(CATALOG), { service_id: null, service_type: 'Retired Thing' })).resolves.toEqual(verbatim('Retired Thing'));
    await expect(resolveSeriesChildIdentity(fakeConn(CATALOG), { service_id: null, service_type: 'Palm Care' })).resolves.toEqual(verbatim('Palm Care'));
    await expect(resolveSeriesChildIdentity(fakeConn(CATALOG, { fail: true }), { service_id: null, service_type: 'Mosquito Control' })).resolves.toEqual(verbatim('Mosquito Control'));
    await expect(resolveSeriesChildIdentity(fakeConn(CATALOG, { fail: true }), { service_id: 'svc-q', service_type: 'Quarterly Pest Control' })).resolves.toEqual(
      { service_type: 'Quarterly Pest Control', service_id: 'svc-q', service_key: null }
    );
    await expect(resolveSeriesChildIdentity(fakeConn(CATALOG), null)).resolves.toEqual({ service_type: 'Service', service_id: null, service_key: null });
  });
});

describe('service-name-aliases legacy map', () => {
  test('equals migration 20260829000040\'s UNLINKED_MAPPING (frozen artifact — the runtime copy must not drift)', () => {
    const src = fs.readFileSync(path.join(__dirname, '../models/migrations/20260829000040_backfill_pre_convention_visit_labels.js'), 'utf8');
    const m = /const UNLINKED_MAPPING = (\[[\s\S]*?\n\]);/.exec(src);
    expect(m).not.toBeNull();
    const fromMigration = vm.runInNewContext(`(${m[1]})`);
    expect(LEGACY_LABEL_CADENCE_NAMES).toEqual(fromMigration);
  });

  test('legacyCatalogName is pair-keyed and case-insensitive on the label; renamedCatalogName is one-directional', () => {
    expect(legacyCatalogName('pest control', 'monthly')).toBe('Monthly Pest Control Service');
    expect(legacyCatalogName('Pest Control', 'custom')).toBeNull();
    expect(legacyCatalogName('Pest Control', null)).toBeNull();
    expect(renamedCatalogName('Lawn Care Program — Monthly')).toBe('Monthly Lawn Care Service');
    expect(renamedCatalogName('Monthly Lawn Care Service')).toBeNull(); // current form is not "renamed to" anything
    expect(counterpartServiceName('Monthly Lawn Care Service')).toBe('Lawn Care Program — Monthly'); // bidirectional bridge unchanged
  });
});

describe('admin-schedule child-insert sites (source)', () => {
  const src = fs.readFileSync(path.join(__dirname, '../routes/admin-schedule.js'), 'utf8');

  test('no child row copies parent.service_type verbatim any more', () => {
    expect(src).not.toMatch(/service_type:\s*parent\.service_type/);
    // The only remaining parent.service_type "serviceType" is the parent's own
    // duplicate-series guard (checkActiveSeriesLocked), not a child.
    const remaining = src.split('\n').filter((l) => /serviceType:\s*parent\.service_type/.test(l));
    expect(remaining).toHaveLength(1);
  });

  test('every child-insert site resolves the identity on its own connection and stamps link + snapshot from it', () => {
    const resolves = src.match(/const childIdentity = await resolveSeriesChildIdentity\((trx|conn), parent\);/g) || [];
    expect(resolves).toHaveLength(5);
    expect(src.match(/service_type: childIdentity\.service_type/g)).toHaveLength(5);
    expect(src.match(/if \(cols\.service_id && childIdentity\.service_id\) \w+\.service_id = childIdentity\.service_id;/g)).toHaveLength(5);
    expect(src.match(/if \(cols\.service_key_snapshot && !\w+\.service_key_snapshot && childIdentity\.service_key\) \w+\.service_key_snapshot = childIdentity\.service_key;/g)).toHaveLength(5);
    expect(src.match(/classifyAppointmentTag\(childIdentity\.service_type\)/g)).toHaveLength(5);
    expect(src).not.toMatch(/classifyAppointmentTag\(parent\.service_type\)/);
  });

  test('reminder registrations for spawned children carry the resolved label', () => {
    // 3 in-transaction registrations + the 2 alert-action spawn records the
    // post-commit registration reads back.
    expect(src.match(/serviceType: childIdentity\.service_type/g)).toHaveLength(5);
    expect(src).toContain("spawned.push({ id: row?.id, date: nd, serviceType: childIdentity.service_type });");
    expect(src).toContain('serviceType: row.serviceType || parent.service_type,');
  });
});
