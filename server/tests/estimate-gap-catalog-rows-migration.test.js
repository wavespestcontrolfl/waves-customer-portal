/**
 * 20260808080000 estimate-gap catalog rows: the seven quotable services
 * that had no catalog identity (bora_care, dethatching, plugging,
 * top_dressing, rodent_wire_mesh, rodent_bird_box, rodent_guarantee).
 * Keys are the ENGINE's emitted keys; names are the estate's scheduling
 * labels, pinned against the pricers where they emit one, so completion's
 * exact-name fallback resolves rows with no service_id (the foam #3306
 * contract, applied batch-wide).
 */
const migration = require('../models/migrations/20260808080000_estimate_gap_catalog_rows');
const { detectServiceCategory } = require('../utils/service-normalizer');
const { detectServiceLine } = require('../services/service-report/service-line-configs');
const { resolveCompletionProfileForScheduledService } = require('../services/service-completion-profiles');
const sp = require('../services/pricing-engine');

const STATE_KEY = 'migration.20260808080000.state';
const ALL_KEYS = ['bora_care', 'dethatching', 'plugging', 'top_dressing', 'rodent_wire_mesh', 'rodent_bird_box', 'rodent_guarantee'];

function fakeKnex(db, { missingTables = [] } = {}) {
  const knex = (table) => {
    const filters = [];
    const rowsNow = () => db[table] || [];
    const rowMatch = (r) => filters.every((f) => {
      if (f.in) return f.in.values.includes(r[f.in.col]);
      if (f.raw) return String(r[f.raw.col] || '').toLowerCase() === String(f.raw.val).toLowerCase();
      return Object.entries(f).every(([k, v]) => r[k] === v);
    });
    const q = {
      where(cond) { filters.push(cond); return q; },
      whereIn(col, values) { filters.push({ in: { col, values } }); return q; },
      whereRaw(sql, bindings) {
        const m = /lower\((\w+)\)\s*=\s*lower\(\?\)/.exec(sql);
        if (!m) throw new Error(`fake whereRaw: unsupported sql ${sql}`);
        filters.push({ raw: { col: m[1], val: bindings[0] } });
        return q;
      },
      first: async () => {
        const hit = rowsNow().find(rowMatch);
        return hit ? { ...hit } : undefined;
      },
      pluck: async (col) => rowsNow().filter(rowMatch).map((r) => r[col]),
      update: async (patch) => {
        const hits = rowsNow().filter(rowMatch);
        hits.forEach((r) => Object.assign(r, patch));
        return hits.length;
      },
      del: async () => {
        const hits = rowsNow().filter(rowMatch);
        db[table] = rowsNow().filter((r) => !hits.includes(r));
        return hits.length;
      },
      insert: (row) => {
        const stored = { id: `${table}-${rowsNow().length + 1}`, ...row };
        (db[table] = rowsNow()).push(stored);
        const p = Promise.resolve([1]);
        p.returning = async (col) => [{ [col]: stored[col] }];
        return p;
      },
    };
    return q;
  };
  knex.schema = {
    hasTable: async (t) => !missingTables.includes(t) && t in db,
    hasColumn: async (t, c) => t in db && !missingTables.includes(t) && c !== undefined,
  };
  return knex;
}

function emptyDb() {
  return {
    services: [],
    service_completion_profiles: [],
    system_settings: [],
    service_records: [],
    scheduled_services: [],
    service_addons: [],
    service_package_items: [],
    scheduled_service_addons: [],
    service_discount_rules: [],
    discounts: [],
  };
}

const svcRow = (db, key) => db.services.find((r) => r.service_key === key);
const profileRow = (db, key) => db.service_completion_profiles.find((r) => r.service_key === key);
const stateValue = (db) => {
  const row = db.system_settings.find((r) => r.key === STATE_KEY);
  return row ? JSON.parse(row.value) : undefined;
};

describe('20260808080000 estimate-gap catalog rows', () => {
  test('up() inserts all seven rows with sane flags; only bora_care is bookable (public-picker parity)', async () => {
    const db = emptyDb();
    await migration.up(fakeKnex(db));

    expect(db.services).toHaveLength(7);
    for (const key of ALL_KEYS) {
      expect(svcRow(db, key)).toMatchObject({
        billing_type: 'one_time',
        is_active: true,
        is_archived: false,
        customer_visible: true,
        is_waveguard: false,
        booking_enabled: key === 'bora_care',
      });
      expect(profileRow(db, key)).toMatchObject(key === 'rodent_guarantee'
        // Payment-only billing rider: the enforced 20260712400000 posture —
        // no report token, completion comms suppressed, billing untouched.
        ? { completion_mode: 'internal_only', project_type: null, delivery_mode: 'disabled', active: true }
        : {
          completion_mode: 'service_report',
          delivery_mode: 'auto_send',
          portal_visibility: 'token_only',
          portal_attach_policy: 'recurring_customer',
          active: true,
        });
    }
    const state = stateValue(db);
    expect(state.services.map((s) => s.key).sort()).toEqual([...ALL_KEYS].sort());
    expect(state.services.every((s) => s.id)).toBe(true);
    expect(state.profiles.sort()).toEqual([...ALL_KEYS].sort());
  });

  test('durations follow the flat-60 owner directive; the billing construct is 0 like waveguard_membership', async () => {
    const db = emptyDb();
    await migration.up(fakeKnex(db));
    for (const key of ALL_KEYS) {
      expect(`${key}:${svcRow(db, key).default_duration_minutes}`)
        .toBe(`${key}:${key === 'rodent_guarantee' ? 0 : 60}`);
    }
  });

  test('catalog names equal the engine line labels where the pricer emits one', async () => {
    const db = emptyDb();
    await migration.up(fakeKnex(db));

    expect(svcRow(db, 'plugging').name).toBe(sp.pricePlugging(1000, 12).name);
    expect(svcRow(db, 'rodent_wire_mesh').name).toBe(sp.priceRodentWireMesh({}).name);
    expect(svcRow(db, 'rodent_bird_box').name).toBe(sp.priceRodentBirdBoxes({ birdBoxQuantity: 1 }).name);
    // Tier-suffixed engine line ('Rodent Guarantee (standard)') — the base
    // name must prefix it; suffixed lines link by service_id like foam's
    // cadence rows.
    expect(sp.priceRodentGuarantee({}).name.startsWith(svcRow(db, 'rodent_guarantee').name)).toBe(true);
    // Engine keys ARE the catalog keys.
    expect(sp.priceBoraCare(2000, {}).service).toBe('bora_care');
    expect(sp.pricePlugging(1000, 12).service).toBe('plugging');
    expect(sp.priceRodentBirdBoxes({ birdBoxQuantity: 1 }).service).toBe('rodent_bird_box');
  });

  test('END-TO-END: every label resolves its typed profile by name with NO service_id', async () => {
    const db = emptyDb();
    await migration.up(fakeKnex(db));

    const expected = {
      // Generic on purpose (registry ONE_TIME_GENERIC_BY_DESIGN): the
      // typed lawn form has no truthful mechanical choices, and the
      // termite form's target options can't record Bora-Care's advertised
      // beetle/fungi targets.
      'Bora-Care Wood Treatment': { serviceKey: 'bora_care', findingsType: null, mode: 'service_report' },
      'Lawn Dethatching': { serviceKey: 'dethatching', findingsType: null, mode: 'service_report' },
      'Lawn Plugging': { serviceKey: 'plugging', findingsType: null, mode: 'service_report' },
      'Lawn Top Dressing': { serviceKey: 'top_dressing', findingsType: null, mode: 'service_report' },
      'Rodent Wire Mesh Exclusion': { serviceKey: 'rodent_wire_mesh', findingsType: 'rodent_exclusion', mode: 'service_report' },
      'Roof-entry cover / bird box': { serviceKey: 'rodent_bird_box', findingsType: 'rodent_exclusion', mode: 'service_report' },
      // Billing rider: payment-only renewal, no report, no comms.
      'Rodent Guarantee': { serviceKey: 'rodent_guarantee', findingsType: null, mode: 'internal_only' },
    };
    for (const [label, want] of Object.entries(expected)) {
      const resolved = await resolveCompletionProfileForScheduledService(
        { service_type: label },
        fakeKnex(db),
      );
      expect({ label, serviceKey: resolved.serviceKey, findingsType: resolved.findingsType, mode: resolved.completionMode })
        .toEqual({ label, ...want });
    }
  });

  test('down() retains a service referenced only by a NAME-ONLY visit — unlinked scheduling is first-class', async () => {
    const db = emptyDb();
    await migration.up(fakeKnex(db));
    // No service_id anywhere — the visit and the scheduled add-on carry
    // only the exact catalog names (codex r3 P1).
    db.scheduled_services.push({ id: 'v1', service_id: null, service_type: 'Bora-Care Wood Treatment' });
    db.scheduled_service_addons.push({ id: 'ssa-1', service_id: null, service_name: 'Rodent Wire Mesh Exclusion' });

    await migration.down(fakeKnex(db));

    for (const key of ['bora_care', 'rodent_wire_mesh']) {
      expect(svcRow(db, key)).toMatchObject({ is_active: false });
      expect(profileRow(db, key)).toMatchObject({ active: true });
    }
    // The five unreferenced rows are gone.
    expect(db.services).toHaveLength(2);
  });

  test('down() retention covers every resolver alias — short_name and trailing-Service labels too', async () => {
    const db = emptyDb();
    await migration.up(fakeKnex(db));
    // A visit under the SHORT name and one under the name + ' Service'
    // suffix both resolve through lookupServiceForScheduledService today
    // (codex r4 P1) — each must prevent deletion.
    db.scheduled_services.push({ id: 'v1', service_id: null, service_type: 'Bora-Care' });
    db.scheduled_service_addons.push({ id: 'ssa-1', service_id: null, service_name: 'Lawn Plugging Service' });

    await migration.down(fakeKnex(db));

    expect(svcRow(db, 'bora_care')).toMatchObject({ is_active: false });
    expect(svcRow(db, 'plugging')).toMatchObject({ is_active: false });
    expect(profileRow(db, 'bora_care')).toMatchObject({ active: true });
    expect(profileRow(db, 'plugging')).toMatchObject({ active: true });
    expect(db.services).toHaveLength(2);
  });

  test('down() removes a HEALED profile from a pre-existing service — restoring the pre-migration fallback', async () => {
    const db = emptyDb();
    // The service predated the migration (admin-created, active, no
    // profile); up() only healed the missing profile (codex r4 P2).
    db.services.push({ id: 'admin-bora-preexisting', service_key: 'bora_care', name: 'Adam Bora', is_active: true });
    await migration.up(fakeKnex(db));
    expect(profileRow(db, 'bora_care')).toBeDefined();

    await migration.down(fakeKnex(db));

    // The pre-existing row survives untouched (still active — it was
    // never ours), and the healed profile is gone: pre-migration state.
    expect(svcRow(db, 'bora_care')).toMatchObject({ id: 'admin-bora-preexisting', is_active: true });
    expect(profileRow(db, 'bora_care')).toBeUndefined();
    expect(stateValue(db)).toBeUndefined();
  });

  test('every catalog name classifies into its own family — including the tokenless bird box (new rodent tokens)', async () => {
    const db = emptyDb();
    await migration.up(fakeKnex(db));

    const want = {
      bora_care: 'termite',
      dethatching: 'lawn',
      plugging: 'lawn',
      top_dressing: 'lawn',
      rodent_wire_mesh: 'rodent',
      rodent_bird_box: 'rodent',
      rodent_guarantee: 'rodent',
    };
    for (const [key, cat] of Object.entries(want)) {
      expect(`${key}:${detectServiceCategory(svcRow(db, key).name)}`).toBe(`${key}:${cat}`);
    }
    // Report-line fallback agrees for the hardware line that carries no
    // rodent token of its own.
    expect(detectServiceLine('Roof-entry cover / bird box')).toBe('rodent');
  });

  test('profile heal skips rows that are not explicitly active', async () => {
    const db = emptyDb();
    db.services.push({ id: 'null-active', service_key: 'bora_care', name: 'Bora-Care Wood Treatment', is_active: null });
    db.services.push({ id: 'inactive', service_key: 'dethatching', name: 'Lawn Dethatching', is_active: false });
    await migration.up(fakeKnex(db));

    expect(profileRow(db, 'bora_care')).toBeUndefined();
    expect(profileRow(db, 'dethatching')).toBeUndefined();
    // The other five inserted normally.
    expect(db.service_completion_profiles).toHaveLength(5);
    expect(stateValue(db).services.map((s) => s.key)).not.toContain('bora_care');
  });

  test('up() is idempotent and never overwrites pre-existing rows or profiles', async () => {
    const db = emptyDb();
    const adminRow = { id: 'admin-bora', service_key: 'bora_care', name: 'Adam Bora Custom', is_active: true };
    db.services.push({ ...adminRow });
    db.service_completion_profiles.push({ service_key: 'plugging', completion_mode: 'project_required', marker: 'admin' });
    await migration.up(fakeKnex(db));
    await migration.up(fakeKnex(db));

    expect(db.services).toHaveLength(7);
    expect(svcRow(db, 'bora_care')).toMatchObject(adminRow);
    // Admin bora row heals a profile snapshotting ITS name; admin plugging
    // profile untouched.
    expect(profileRow(db, 'bora_care')).toMatchObject({ service_name_snapshot: 'Adam Bora Custom' });
    expect(profileRow(db, 'plugging')).toMatchObject({ completion_mode: 'project_required', marker: 'admin' });
    expect(stateValue(db).services.map((s) => s.key)).not.toContain('bora_care');
  });

  test('down() on an unreferenced catalog deletes all seven rows and profiles and clears state', async () => {
    const db = emptyDb();
    await migration.up(fakeKnex(db));
    await migration.down(fakeKnex(db));

    expect(db.services).toHaveLength(0);
    expect(db.service_completion_profiles).toHaveLength(0);
    expect(stateValue(db)).toBeUndefined();
  });

  test('down() retains and DEACTIVATES services with history or add-on/package references — never orphans links', async () => {
    const db = emptyDb();
    await migration.up(fakeKnex(db));
    // A scheduled visit on bora, a completed report on top_dressing, a
    // package wiring on wire mesh, and a scheduled ADD-ON on bird box —
    // four reference classes, all force retention (codex P0s: deleting
    // would orphan history / cascade config / strip the add-on identity).
    const boraId = svcRow(db, 'bora_care').id;
    db.scheduled_services.push({ id: 'v1', service_id: boraId });
    db.service_records.push({ id: 'r1', service_id: svcRow(db, 'top_dressing').id });
    db.service_package_items.push({ id: 'pkg-1', service_id: svcRow(db, 'rodent_wire_mesh').id });
    db.scheduled_service_addons.push({ id: 'ssa-1', service_id: svcRow(db, 'rodent_bird_box').id });
    // Discount wiring references by KEY, not id (canonical guard classes).
    db.service_discount_rules.push({ id: 'sdr-1', service_key: 'dethatching' });
    db.discounts.push({ id: 'd-1', service_key_filter: 'plugging' });

    await migration.down(fakeKnex(db));

    for (const key of ['bora_care', 'top_dressing', 'rodent_wire_mesh', 'rodent_bird_box', 'dethatching', 'plugging']) {
      // Service deactivates; the PROFILE stays active — the pending
      // visits that forced retention still complete through it (codex P1:
      // resolution filters active=true).
      expect(svcRow(db, key)).toMatchObject({ is_active: false });
      expect(profileRow(db, key)).toMatchObject({ active: true });
    }
    // History links stay intact — no FK nulling on retained rows.
    expect(db.scheduled_services[0].service_id).toBe(boraId);
    expect(db.service_records[0].service_id).toBe(svcRow(db, 'top_dressing').id);
    expect(db.scheduled_service_addons[0].service_id).toBe(svcRow(db, 'rodent_bird_box').id);
    // Only the fully unreferenced row (rodent_guarantee) is removed.
    expect(db.services).toHaveLength(6);
    expect(db.service_completion_profiles).toHaveLength(6);
    expect(svcRow(db, 'rodent_guarantee')).toBeUndefined();
  });

  test('down() spares the profile of an admin-recreated same-key service — even with the marker untouched', async () => {
    const db = emptyDb();
    await migration.up(fakeKnex(db));
    // Admin deletes our dethatching row and recreates it under the same
    // key with a new UUID, WITHOUT touching the existing profile (codex
    // P1: the marker alone must not doom the profile the new row uses).
    db.services = db.services.filter((r) => r.service_key !== 'dethatching');
    db.services.push({ id: 'admin-dethatch-v2', service_key: 'dethatching', name: 'Dethatch v2', is_active: true });

    await migration.down(fakeKnex(db));

    expect(svcRow(db, 'dethatching')).toMatchObject({ id: 'admin-dethatch-v2', is_active: true });
    expect(profileRow(db, 'dethatching')).toBeDefined();
    expect(profileRow(db, 'dethatching').active).toBe(true);
    // Everything else rolled back normally.
    expect(db.services).toHaveLength(1);
    expect(db.service_completion_profiles).toHaveLength(1);
  });
});
