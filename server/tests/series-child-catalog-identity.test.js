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

function fakeConn(services, { fail = false, onQuery = null } = {}) {
  return (table) => {
    if (table !== 'services') throw new Error(`unexpected table ${table}`);
    const filters = [];
    let lowerNames = null;
    const q = {
      where(cond) { filters.push(cond); return q; },
      whereRaw(sql, bindings) {
        // The resolver reads every name candidate in ONE statement.
        if (!/^lower\(name\) IN \((lower\(\?\)(, )?)+\)$/.test(sql)) throw new Error(`unexpected whereRaw ${sql}`);
        lowerNames = bindings.map((b) => String(b).toLowerCase());
        return q;
      },
      rows() {
        if (fail) throw new Error('db down');
        if (onQuery) onQuery();
        return services.filter((s) => (lowerNames == null || lowerNames.includes(String(s.name).toLowerCase()))
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

  test('an unlinked parent\'s service_key_snapshot outranks every label bridge (identity order: id → snapshot → name)', async () => {
    // Label + cadence map to Quarterly; the durable snapshot says Monthly → Monthly.
    const parent = { id: 'p', service_id: null, service_type: 'Quarterly Pest Control', recurring_pattern: 'quarterly', service_key_snapshot: 'pest_monthly' };
    await expect(resolveSeriesChildIdentity(fakeConn(CATALOG), parent)).resolves.toEqual(
      { service_type: 'Monthly Pest Control Service', service_id: 'svc-m', service_key: 'pest_monthly' }
    );
    // Snapshot naming an inactive or unknown key → verbatim, never a label guess.
    await expect(resolveSeriesChildIdentity(fakeConn(CATALOG), { ...parent, service_key_snapshot: 'retired' })).resolves.toEqual(
      { service_type: 'Quarterly Pest Control', service_id: null, service_key: null }
    );
    await expect(resolveSeriesChildIdentity(fakeConn(CATALOG), { ...parent, service_key_snapshot: 'never_existed' })).resolves.toEqual(
      { service_type: 'Quarterly Pest Control', service_id: null, service_key: null }
    );
  });

  test('inside a caller transaction the catalog read runs in a SAVEPOINT (nested trx), so a failed read cannot abort the caller\'s trx', async () => {
    const parent = { id: 'p', service_id: null, service_type: 'Mosquito Control', recurring_pattern: 'monthly' };
    const conn = fakeConn(CATALOG);
    conn.isTransaction = true;
    conn.transaction = jest.fn(async (fn) => fn(conn));
    await expect(resolveSeriesChildIdentity(conn, parent)).resolves.toMatchObject({ service_id: 'svc-mosq' });
    expect(conn.transaction).toHaveBeenCalledTimes(1);
    // A read failing inside the savepoint still resolves verbatim.
    const failing = fakeConn(CATALOG, { fail: true });
    failing.isTransaction = true;
    failing.transaction = jest.fn(async (fn) => fn(failing));
    await expect(resolveSeriesChildIdentity(failing, parent)).resolves.toEqual({ service_type: 'Mosquito Control', service_id: null, service_key: null });
    expect(failing.transaction).toHaveBeenCalledTimes(1);
    // A plain (non-transaction) connection reads directly — no nested trx.
    const plain = fakeConn(CATALOG);
    plain.transaction = jest.fn();
    await resolveSeriesChildIdentity(plain, parent);
    expect(plain.transaction).not.toHaveBeenCalled();
  });

  test('alias + exact label are read in ONE catalog query', async () => {
    let queries = 0;
    const parent = { id: 'p', service_id: null, service_type: 'General Pest Control Service (Bi-Monthly)', recurring_pattern: 'bimonthly' };
    await resolveSeriesChildIdentity(fakeConn(CATALOG, { onQuery: () => { queries += 1; } }), parent);
    expect(queries).toBe(1);
  });

  test('alias vs exact-name conflict: both spellings active → verbatim unlinked; only the old spelling active → it is the exact match', async () => {
    const old = { id: 'svc-old-spelling', name: 'General Pest Control Service (Bi-Monthly)', service_key: 'pest_bimonthly_legacy', is_active: true };
    const parent = { id: 'p', service_id: null, service_type: 'General Pest Control Service (Bi-Monthly)', recurring_pattern: 'bimonthly' };
    await expect(resolveSeriesChildIdentity(fakeConn([...CATALOG, old]), parent)).resolves.toEqual(
      { service_type: 'General Pest Control Service (Bi-Monthly)', service_id: null, service_key: null }
    );
    const withoutRenamed = CATALOG.filter((s) => s.id !== 'svc-bm');
    await expect(resolveSeriesChildIdentity(fakeConn([...withoutRenamed, old]), parent)).resolves.toEqual(
      { service_type: 'General Pest Control Service (Bi-Monthly)', service_id: 'svc-old-spelling', service_key: 'pest_bimonthly_legacy' }
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

describe('canonical recurring seeder (source)', () => {
  const seeder = fs.readFileSync(path.join(__dirname, '../services/recurring-appointment-seeder.js'), 'utf8');
  test('seedFollowUpsForParent resolves the child identity on its connection and hands it to the builder', () => {
    // Against the EFFECTIVE cadence: public booking supplies it via opts.pattern only.
    expect(seeder).toContain('const childIdentity = opts.childIdentity || await resolveSeriesChildIdentity(conn, { ...parent, recurring_pattern: pattern });');
    expect(seeder).toContain("service_type: opts.serviceType || (opts.childIdentity && opts.childIdentity.service_type) || parent.service_type || 'Service',");
    expect(seeder).toContain('if (opts.childIdentity.service_id) row.service_id = opts.childIdentity.service_id;');
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
    // 5 parent-driven sites (spawn, visit-count extend, completion
    // auto-extend, 2 recurring-alert extends) + the POST create path, which
    // resolves from the freshly inserted parent (`svc`) for its seeded
    // children AND boosters.
    const resolves = src.match(/const childIdentity = await resolveSeriesChildIdentity\((trx|conn), parent\);/g) || [];
    expect(resolves).toHaveLength(5);
    // Create path: resolved from the inserted parent, and ONLY when a child
    // or booster will be inserted (no catalog read on one-off bookings; a
    // failed read inside trx cannot poison the parent insert).
    expect(src).toContain('const childIdentity = (plannedChildDates.length || plannedBoosterDates.length)\n        ? await resolveSeriesChildIdentity(trx, svc)\n        : null;');
    expect(src.match(/service_type: childIdentity\.service_type/g)).toHaveLength(7);
    expect(src.match(/classifyAppointmentTag\(childIdentity\.service_type\)/g)).toHaveLength(7);
    expect(src).not.toMatch(/classifyAppointmentTag\(parent\.service_type\)/);
    // Parent-driven sites: link from the resolver; snapshot fills a gap
    // AFTER the parent-field copy (which writes the parent's own snapshot).
    expect(src.match(/if \(cols\.service_id && childIdentity\.service_id\) \w+\.service_id = childIdentity\.service_id;/g)).toHaveLength(5);
    expect(src.match(/if \(cols\.service_key_snapshot && !\w+\.service_key_snapshot && childIdentity\.service_key\) \w+\.service_key_snapshot = childIdentity\.service_key;/g)).toHaveLength(5);
    const spawnCopy = src.indexOf('copyLineDiscountFields(childData, parent, cols);');
    const spawnStamp = src.indexOf('if (cols.service_key_snapshot && !childData.service_key_snapshot && childIdentity.service_key) childData.service_key_snapshot = childIdentity.service_key;');
    expect(spawnCopy).toBeGreaterThan(-1);
    expect(spawnStamp).toBeGreaterThan(spawnCopy);
    // Create path: resolver link outranks the optional request serviceId;
    // pricing's primary key outranks the resolver's (it priced the visit).
    for (const v of ['childData', 'boosterData']) {
      expect(src).toContain(`if (cols.service_id && (childIdentity.service_id || serviceId)) ${v}.service_id = childIdentity.service_id || serviceId;`);
      expect(src).toContain(`if (cols.service_key_snapshot) ${v}.service_key_snapshot = pricing.primaryServiceKey || childIdentity.service_key || null;`);
    }
    // The only `service_type: serviceType, status: 'pending'` left is the
    // PARENT insert on the create path — the request's own label.
    expect(src.match(/service_type:\s*serviceType,\s*status:\s*'pending'/g)).toHaveLength(1);
  });

  test('reminder registrations for spawned children carry the resolved label', () => {
    // 3 in-transaction registrations + the 2 alert-action spawn records the
    // post-commit registration reads back.
    expect(src.match(/serviceType: childIdentity\.service_type/g)).toHaveLength(5);
    expect(src).toContain("spawned.push({ id: row?.id, date: nd, serviceType: childIdentity.service_type });");
    expect(src).toContain('serviceType: row.serviceType || parent.service_type,');
  });
});
