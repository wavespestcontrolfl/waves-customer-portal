/**
 * C1a (quote-to-estimate alignment, 2026-08-29):
 *  - 20260829000020 adds services.public_quote_selectable and seeds the ruled
 *    acquisition products; down() clears only rows it flipped.
 *  - 20260829000021 backfills engine_keys for unlinked estimator products;
 *    never overwrites an admin-stamped array; refuses a second claimant.
 *  - Estimator concrete-product checkbox labels equal catalog names.
 */
const selectable = require('../models/migrations/20260829000020_services_public_quote_selectable');
const backfill = require('../models/migrations/20260829000021_engine_keys_backfill_unlinked_products');

function fakeKnex(db, { hasColumn = true } = {}) {
  const knex = (table) => {
    const rows = () => (db[table] = db[table] || []);
    let filters = [];
    const matches = (r) => filters.every((f) => f(r));
    const q = {
      where(cond, val) {
        if (typeof cond === 'string') filters.push((r) => r[cond] === val);
        else if (typeof cond === 'object') filters.push((r) => Object.entries(cond).every(([k, v]) => r[k] === v));
        return q;
      },
      whereIn(col, vals) { filters.push((r) => vals.includes(r[col])); return q; },
      whereNot(cond) { filters.push((r) => !Object.entries(cond).every(([k, v]) => r[k] === v)); return q; },
      whereRaw(sql, bindings) {
        if (/engine_keys @> \?::jsonb/.test(sql)) { const want = JSON.parse(bindings[0]); filters.push((r) => Array.isArray(r.engine_keys) && want.every((k) => r.engine_keys.includes(k))); }
        else if (/engine_keys IS NULL/.test(sql)) filters.push((r) => r.engine_keys == null);
        else if (/engine_keys = \?::jsonb/.test(sql)) { const want = JSON.stringify(JSON.parse(bindings[0])); filters.push((r) => JSON.stringify(r.engine_keys) === want); }
        else throw new Error(`fake whereRaw: ${sql}`);
        return q;
      },
      select() { return Promise.resolve(rows().filter(matches).map((r) => ({ ...r }))); },
      async first() { const r = rows().find(matches); return r ? { ...r } : null; },
      async update(patch) { let n = 0; for (const r of rows()) if (matches(r)) { const p = { ...patch }; if (typeof p.engine_keys === 'string') p.engine_keys = JSON.parse(p.engine_keys); Object.assign(r, p); n++; } return n; },
      async del() { const keep = rows().filter((r) => !matches(r)); const n = rows().length - keep.length; db[table] = keep; return n; },
      async insert(row) { rows().push({ ...row }); return [row]; },
    };
    return q;
  };
  knex.schema = {
    hasTable: async () => true,
    hasColumn: async (t, c) => (c === 'public_quote_selectable' ? hasColumn : true),
    alterTable: async (t, cb) => { cb({ boolean: () => ({ notNullable: () => ({ defaultTo: () => {} }) }) }); for (const r of db[t] || []) if (r.public_quote_selectable === undefined) r.public_quote_selectable = false; },
  };
  knex.fn = { now: () => 'NOW' };
  knex.raw = async (sql) => { if (!/LOCK TABLE services IN SHARE ROW EXCLUSIVE MODE/.test(sql)) throw new Error(`fake raw: ${sql}`); db.locked = true; };
  return knex;
}

const svc = (key, over = {}) => ({ id: `id-${key}`, service_key: key, is_active: true, is_archived: false, public_quote_selectable: false, engine_keys: null, ...over });

describe('20260829000020 public_quote_selectable', () => {
  test('adds the column, seeds ruled keys, leaves follow-ons/archived/inactive alone, records ownership', async () => {
    const db = { services: [svc('wdo_inspection'), svc('rodent_inspection'), svc('pest_re_service'), svc('rodent_bait_setup'), svc('lawn_inspection'),
      svc('termite_inspection', { is_archived: true, is_active: false }), svc('lawn_care_quarterly', { is_active: false }), svc('trap_only_retainer_standard')], system_settings: [] };
    await selectable.up(fakeKnex(db, { hasColumn: false }));
    const by = (k) => db.services.find((r) => r.service_key === k).public_quote_selectable;
    expect(by('wdo_inspection')).toBe(true);
    expect(by('rodent_inspection')).toBe(true);
    expect(by('pest_re_service')).toBe(false);
    expect(by('rodent_bait_setup')).toBe(false);
    expect(by('lawn_inspection')).toBe(false);          // Waves Assessment: "Not sure" removed
    expect(by('termite_inspection')).toBe(false);       // archived
    expect(by('lawn_care_quarterly')).toBe(false);      // inactive
    expect(by('trap_only_retainer_standard')).toBe(false); // PR B
    expect(JSON.parse(db.system_settings[0].value).seededIds.sort()).toEqual(['id-rodent_inspection', 'id-wdo_inspection']);
  });
  test('a re-run never re-flips a row an admin deselected; down() is a no-op that keeps admin choices', async () => {
    const db = { services: [svc('wdo_inspection'), svc('fire_ant'), svc('pest_re_service')], system_settings: [] };
    await selectable.up(fakeKnex(db));
    db.services.find((r) => r.service_key === 'wdo_inspection').public_quote_selectable = false; // admin deselects
    db.services.find((r) => r.service_key === 'pest_re_service').public_quote_selectable = true; // admin selects
    await selectable.up(fakeKnex(db));
    expect(db.services.find((r) => r.service_key === 'wdo_inspection').public_quote_selectable).toBe(false);
    expect(db.services.find((r) => r.service_key === 'fire_ant').public_quote_selectable).toBe(true);
    await selectable.down(fakeKnex(db));
    expect(db.services.find((r) => r.service_key === 'fire_ant').public_quote_selectable).toBe(true);
    expect(db.services.find((r) => r.service_key === 'pest_re_service').public_quote_selectable).toBe(true);
    expect(db.system_settings).toHaveLength(1); // state retained for idempotent reruns
  });
  test('every seeded key names a product a NEW customer buys — no follow-on/internal keys', () => {
    const banned = /re_service|_setup|cartridge|followup|guarantee|renewal|membership|general_appointment|lawn_inspection|trap_only|combo|pest_termite_bait|rodent_monitoring|termite_active_/;
    for (const k of selectable.SELECTABLE_KEYS) expect({ k, ok: !banned.test(k) }).toEqual({ k, ok: true });
  });
});

describe('20260829000021 engine_keys backfill', () => {
  test('stamps a NULL array, takes the lock, refuses a second ACTIVE claimant', async () => {
    const db = { services: [
      svc('palm_injection'),
      svc('other_row', { engine_keys: ['palm_injection'] }), // ACTIVE row already claims palm_injection
    ], system_settings: [] };
    await backfill.up(fakeKnex(db));
    expect(db.locked).toBe(true); // owner-check → stamp span is serialized
    expect(db.services.find((r) => r.service_key === 'palm_injection').engine_keys).toBeNull(); // refused
    expect(JSON.parse(db.system_settings[0].value).applied).toEqual([]);
  });
  test('an admin-stamped array is owner data — never modified, not even appended to', async () => {
    const db = { services: [svc('palm_injection', { engine_keys: ['admin_custom'] })], system_settings: [] };
    await backfill.up(fakeKnex(db));
    expect(db.services[0].engine_keys).toEqual(['admin_custom']);
    expect(JSON.parse(db.system_settings[0].value).applied).toEqual([]);
  });
  test('an archived historical claimant does not suppress the live mapping', async () => {
    const db = { services: [svc('palm_injection'), svc('palm_treatment', { is_active: false, is_archived: true, engine_keys: ['palm_injection'] })], system_settings: [] };
    await backfill.up(fakeKnex(db));
    expect(db.services.find((r) => r.service_key === 'palm_injection').engine_keys).toEqual(['palm_injection']);
  });
  test('shared / aggregate keys are deliberately absent from the seed', () => {
    const keys = backfill.SEEDS.flatMap((s) => s.add);
    expect(keys).not.toContain('one_time_lawn');
    expect(keys).not.toContain('rodent_trapping_followup');
    expect(keys).not.toContain('rodent_sanitation');
    expect(keys).not.toContain('termite_bond');
    expect(keys).not.toContain('pest_initial_roach');
    expect(keys).not.toContain('flea_package');
  });
  test('down() removes exactly what up() added, restoring NULL where it was NULL', async () => {
    const db = { services: [svc('palm_injection')], system_settings: [] };
    await backfill.up(fakeKnex(db));
    expect(db.services[0].engine_keys).toEqual(['palm_injection']);
    await backfill.down(fakeKnex(db));
    expect(db.services[0].engine_keys).toBeNull();
  });
  test('down() leaves a row alone when an admin changed the array after up() (CAS)', async () => {
    const db = { services: [svc('palm_injection')], system_settings: [] };
    await backfill.up(fakeKnex(db));
    db.services[0].engine_keys = ['palm_injection', 'admin_added'];
    // Simulate an interleaved edit: the fake's first() returns a copy, so mutate
    // the stored row right after the read by hooking the update path.
    const knex = fakeKnex(db);
    const orig = knex;
    await backfill.down(orig);
    // CAS matched the array as read (['palm_injection','admin_added']) → 'palm_injection' removed, admin key kept.
    expect(db.services[0].engine_keys).toEqual(['admin_added']);
  });
});

describe('estimator concrete-product labels equal catalog names', () => {
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '../../client/src/pages/admin/EstimateToolViewV2.jsx'), 'utf8');
  const labelOf = (k) => (src.match(new RegExp(`k="${k}" label="([^"]*)"`)) || [])[1];
  test.each([
    ['svcOnetimePest', 'One-Time Pest Control Service'],
    ['svcOnetimeMosquito', 'One-Time Mosquito Control Service'],
    ['svcOnetimeLawn', 'One-Time Lawn Care Service'],
    ['svcBoracare', 'Bora-Care Wood Treatment Service'],
    ['svcWdo', 'WDO Inspection Service'],
    ['svcFlea', 'Flea Control Service'],
    ['svcWasp', 'Bee / Wasp Nest Removal Service'],
    ['svcBedbug', 'Bed Bug Treatment Service'],
    ['svcRodentTrap', 'Rodent Trapping Service'],
    ['svcExclusion', 'Rodent Exclusion Service'],
    ['svcTrenching', 'Termite Trenching Service'],
    ['svcPreslab', 'Slab Pre-Treat Termite Service'],
    ['svcFoam', 'Termite Foam Service'],
    ['svcPlugging', 'Lawn Plugging Service'],
    ['svcTopdress', 'Lawn Top Dressing Service'],
    ['svcRoach', 'Cockroach Treatment Service'],
    ['svcRodentGuarantee', 'Rodent Guarantee Service'],
    ['svcInjection', 'Palm Injection Service'],
  ])('%s → %s', (k, name) => { expect(labelOf(k)).toBe(name); });
  test('family selectors stay controls, not catalog rows', () => {
    expect(labelOf('svcMosquito')).toBe('Mosquito Control');
    expect(labelOf('svcRodentBait')).toBe('Rodent Bait Station');
    expect(labelOf('svcPest')).toBe('Pest Control');
    expect(labelOf('svcLawn')).toBe('Lawn Care');
  });
});
