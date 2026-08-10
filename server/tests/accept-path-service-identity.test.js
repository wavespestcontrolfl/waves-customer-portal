/**
 * Accept-path service identity — fall-through guard.
 *
 * The estimate-accept path stamps `service_type`, a DISPLAY label whose
 * whitelist (canonicalServiceTypeForProfile) silently returns the estimate's
 * `service_interest` verbatim for any engine key it doesn't list. A label that
 * matches no catalog row degrades the visit to the GENERIC completion profile,
 * which kills typed one-time billing (no invoice ⇒ the card-hold completion
 * charge never fires) and the compliance-project lane.
 *
 * `services.engine_keys` (migration 20260810000002) is the fix: the accept path
 * stamps `service_id` from it, and lookupServiceForScheduledService checks
 * `service_id` FIRST. This suite pins the resolver's behavior (static), the REAL
 * profile-building path, and the seeded mapping against the migrated catalog
 * (DB-backed, self-skips without DATABASE_URL, mirroring
 * completion-lane-coverage-contract.test.js).
 */
const path = require('path');
const { _internals } = require('../services/slot-reservation');
const { ENGINE_KEY_SEEDS } = require('../models/migrations/20260810000002_services_engine_key');

const { catalogServiceIdForProfile } = _internals;

const ALL_SEEDED_KEYS = ENGINE_KEY_SEEDS.flatMap((s) => s.engine_keys);

// Every engine key that can reach a one-time accept for a service observed on
// accepted estimates in prod (audit 2026-08-10), INCLUDING the engine's current
// versioned aliases (codex #3328 r2 P1 — service-pricing.js emits
// stinging_insect at :7770 and stinging_insect_v2 at :8203; german_roach at
// :6208 and german_roach_initial at :6241). All must be mapped.
const ENGINE_KEYS_REACHING_ACCEPT = [
  'pre_slab_termiticide',
  'german_roach',
  'german_roach_initial',
  'stinging_insect',
  'stinging_insect_v2',
];

// COVERAGE IS PARTIAL BY DESIGN — listed so the gap is visible, never silent.
// These engine keys are emitted by service-pricing.js but are NOT mapped:
// mapping each is a business decision per service, and an unmapped key fails
// open (service_id stays null = exact pre-change behavior). Anything added here
// that later gets seeded will fail the "no key is both mapped and declared
// unmapped" test below, forcing this list to stay honest.
const KNOWN_UNMAPPED_ENGINE_KEYS = [
  'bora_care', 'dethatching', 'exclusion', 'exclusion_v2', 'flea_knockdown_single',
  'flea_package', 'foam_drill', 'one_time_lawn', 'one_time_mosquito', 'one_time_pest',
  'palm_injection', 'pest_initial_roach', 'plugging', 'rodent_bait_setup',
  'rodent_bird_box', 'rodent_exclusion', 'rodent_guarantee', 'rodent_guarantee_combo',
  'rodent_inspection', 'rodent_plugging', 'rodent_sanitation', 'rodent_trapping',
  'rodent_trapping_followup', 'rodent_wire_mesh', 'termite_foam', 'trap_only_retainer',
  'trap_only_setup', 'trenching', 'wasp', 'wdo_inspection',
];

// Load the knexfile BEFORE deciding to skip — it resolves the Railway
// fallbacks into process.env.DATABASE_URL (same reasoning as the
// completion-lane contract).
const knexConfig = require(path.join(__dirname, '..', 'knexfile.js'));
const SKIP = !process.env.DATABASE_URL;
const describeOrSkip = SKIP ? describe.skip : describe;

describe('accept-path engine-key mapping (static)', () => {
  test('every engine key that reaches the accept path is mapped', () => {
    const mapped = new Set(ALL_SEEDED_KEYS);
    const unmapped = ENGINE_KEYS_REACHING_ACCEPT.filter((k) => !mapped.has(k));
    expect(unmapped).toEqual([]);
  });

  test('no engine key is claimed by two catalog rows', () => {
    const seen = new Map();
    for (const seed of ENGINE_KEY_SEEDS) {
      for (const key of seed.engine_keys) {
        expect(seen.has(key)
          ? `${key} claimed by both ${seen.get(key)} and ${seed.service_key}`
          : null).toBeNull();
        seen.set(key, seed.service_key);
      }
    }
  });

  test('no key is both mapped and declared unmapped', () => {
    const mapped = new Set(ALL_SEEDED_KEYS);
    expect(KNOWN_UNMAPPED_ENGINE_KEYS.filter((k) => mapped.has(k))).toEqual([]);
  });

  test('german_roach and german_roach_initial stay DISTINCT services', () => {
    // They are different catalog rows ("Cleanout" vs "Initial (3-Visit)") —
    // aliasing them would bill and complete the wrong service.
    const owner = (key) => ENGINE_KEY_SEEDS.find((s) => s.engine_keys.includes(key))?.service_key;
    expect(owner('german_roach')).toBe('german_roach');
    expect(owner('german_roach_initial')).toBe('german_roach_initial');
  });

  test('both stinging-insect engine versions resolve to ONE catalog row', () => {
    const owner = (key) => ENGINE_KEY_SEEDS.find((s) => s.engine_keys.includes(key))?.service_key;
    expect(owner('stinging_insect')).toBe('bee_wasp_removal');
    expect(owner('stinging_insect_v2')).toBe('bee_wasp_removal');
  });
});

// The REAL profile-building path (codex #3328 r1 P1). Fabricated profiles hid
// the bug entirely: oneTimeProfileServices stores serviceCategoryForOneTimeItem
// in `service`, and every pest specialty collapses to 'pest_control' — so
// german_roach and stinging_insect would have queried 'pest_control' and
// silently stayed unstamped, i.e. 2 of the 3 production cases unfixed.
describe('resolveEstimateSlotProfile carries the RAW engine key', () => {
  const { resolveEstimateSlotProfile } = require('../services/estimate-slot-availability');

  const estimateWith = (service, name) => ({
    id: 'est-1',
    service_interest: 'Pest Control',
    estimate_data: {
      result: { oneTime: { specItems: [{ service, name, price: 250 }], total: 250 } },
    },
  });

  const primaryOf = (estimate) => {
    const profile = resolveEstimateSlotProfile(estimate, { serviceMode: 'one_time' });
    const services = profile?.services || [];
    return services.find((s) => s?.service === 'pest_control') || services[0] || null;
  };

  test.each([
    ['german_roach', 'German Roach Cleanout'],
    ['german_roach_initial', 'German Roach Initial'],
    ['stinging_insect', 'Wasp Nest Removal'],
    ['stinging_insect_v2', 'Wasp Nest Removal'],
  ])('%s: category collapses to pest_control but engineKey survives', (key, label) => {
    const primary = primaryOf(estimateWith(key, label));
    expect(primary).toBeTruthy();
    // The collapse that caused the bug — pinned so a future change is visible.
    expect(primary.service).toBe('pest_control');
    expect(primary.engineKey).toBe(key);
  });

  test('pre_slab_termiticide keeps its own category AND engine key', () => {
    const primary = primaryOf(estimateWith('pre_slab_termiticide', 'Pre-Slab Termiticide Treatment'));
    expect(primary).toBeTruthy();
    expect(primary.engineKey).toBe('pre_slab_termiticide');
  });

  test('the resolver queries the RAW key by containment, not the category', async () => {
    const estimate = estimateWith('german_roach', 'German Roach Cleanout');
    const profile = resolveEstimateSlotProfile(estimate, { serviceMode: 'one_time' });
    let bindings = null;
    const conn = () => ({
      whereRaw: (_sql, b) => {
        bindings = b;
        return { andWhere: () => ({ limit: () => ({ select: async () => [] }) }) };
      },
    });
    conn.transaction = async (cb) => cb(conn);
    await catalogServiceIdForProfile(conn, profile);
    expect(bindings).toEqual([JSON.stringify(['german_roach'])]);
  });
});

describe('catalogServiceIdForProfile', () => {
  // The helper runs its read inside conn.transaction(...) — a SAVEPOINT when
  // the caller already holds a transaction — so the fake connection must model
  // that, not a bare query builder.
  // onQuery returns the ROW ARRAY the limited select would produce.
  const makeConn = (onQuery) => {
    const builder = () => ({
      whereRaw: (_sql, b) => ({
        andWhere: (w) => ({ limit: () => ({ select: async () => onQuery(b, w) }) }),
      }),
    });
    builder.transaction = async (cb) => cb(builder);
    return builder;
  };

  test('resolves the primary service key to a catalog id', async () => {
    const id = await catalogServiceIdForProfile(
      makeConn(() => [{ id: 'svc-1' }]),
      { services: [{ service: 'pre_slab_termiticide' }] },
    );
    expect(id).toBe('svc-1');
  });

  test('FAILS CLOSED when two active rows claim the same engine key', async () => {
    // Nondeterministic .first() could stamp the WRONG billing/completion lane;
    // no stamp merely reverts to pre-change behavior (codex #3328 r3 P1).
    const id = await catalogServiceIdForProfile(
      makeConn(() => [{ id: 'svc-a' }, { id: 'svc-b' }]),
      { services: [{ service: 'pre_slab_termiticide' }] },
    );
    expect(id).toBeNull();
  });

  test('picks the SAME primary the display label picks (pest_control wins)', async () => {
    // canonicalServiceTypeForProfile prefers a pest_control line over
    // services[0]; the id must describe the same service as the label, or one
    // row would claim two different services.
    let bindings = null;
    await catalogServiceIdForProfile(
      makeConn((b) => { bindings = b; return [{ id: 'svc-pest' }]; }),
      { services: [{ service: 'pre_slab_termiticide' }, { service: 'pest_control' }] },
    );
    expect(bindings).toEqual([JSON.stringify(['pest_control'])]);
  });

  test('only ACTIVE catalog rows are eligible', async () => {
    let where = null;
    await catalogServiceIdForProfile(
      makeConn((_b, w) => { where = w; return [{ id: 'x' }]; }),
      { services: [{ service: 'pre_slab_termiticide' }] },
    );
    expect(where).toEqual({ is_active: true });
  });

  test('returns null when the profile carries no service key', async () => {
    const c = makeConn(() => [{ id: 'x' }]);
    expect(await catalogServiceIdForProfile(c, { services: [] })).toBeNull();
    expect(await catalogServiceIdForProfile(c, {})).toBeNull();
  });

  test('returns null (never throws) when the key maps to nothing', async () => {
    expect(await catalogServiceIdForProfile(
      makeConn(() => []), { services: [{ service: 'not_a_real_key' }] },
    )).toBeNull();
  });

  test('FAILS OPEN when the lookup throws (pre-migration deploy)', async () => {
    await expect(catalogServiceIdForProfile(
      makeConn(() => { throw new Error('column "engine_keys" does not exist'); }),
      { services: [{ service: 'pre_slab_termiticide' }] },
    )).resolves.toBeNull();
  });

  test('never queries on a connection that cannot open a savepoint', async () => {
    // Guards the r1 P1 directly: without conn.transaction the read would run
    // bare on the caller's transaction and a failure would abort it.
    const bare = () => { throw new Error('should not be queried'); };
    await expect(catalogServiceIdForProfile(
      bare, { services: [{ service: 'pre_slab_termiticide' }] },
    )).resolves.toBeNull();
  });
});

describe('migration rollback touches nothing', () => {
  // codex #3328 r6/r7 P2: value equality cannot establish ownership, so down()
  // is a documented no-op rather than a "clear only what I wrote" heuristic.
  const migration = require('../models/migrations/20260810000002_services_engine_key');

  test('down() performs NO database work at all', async () => {
    const touched = [];
    const qb = new Proxy(() => { touched.push('query'); return qb; }, {
      get: (_t, prop) => {
        if (prop === 'then') return undefined;
        touched.push(String(prop));
        return qb;
      },
      apply: () => { touched.push('query'); return qb; },
    });
    await migration.down(qb);
    expect(touched).toEqual([]);
  });
});

describeOrSkip('seeded engine_keys mapping against the migrated catalog', () => {
  let knex;
  beforeAll(() => {
    knex = require('knex')(knexConfig[process.env.NODE_ENV || 'development'] || knexConfig.development);
  });
  afterAll(async () => { if (knex) await knex.destroy(); });

  test('services.engine_keys column exists', async () => {
    expect(await knex.schema.hasColumn('services', 'engine_keys')).toBe(true);
  });

  test('every seeded engine key resolves to exactly one ACTIVE catalog row', async () => {
    for (const key of ALL_SEEDED_KEYS) {
      const rows = await knex('services')
        .whereRaw('engine_keys @> ?::jsonb', [JSON.stringify([key])])
        .select('service_key', 'is_active');
      expect({ key, count: rows.length }).toEqual({ key, count: 1 });
      expect(rows[0].is_active).toBe(true);
    }
  });

  test('no engine key is claimed by two rows in the LIVE catalog', async () => {
    // The array column cannot carry a scalar unique index, so uniqueness is
    // enforced here (same posture as the completion-lane coverage contract).
    const rows = await knex('services').whereNotNull('engine_keys').select('service_key', 'engine_keys');
    const seen = new Map();
    for (const row of rows) {
      const keys = Array.isArray(row.engine_keys) ? row.engine_keys : JSON.parse(row.engine_keys || '[]');
      for (const key of keys) {
        expect(seen.has(key)
          ? `${key} claimed by both ${seen.get(key)} and ${row.service_key}`
          : null).toBeNull();
        seen.set(key, row.service_key);
      }
    }
  });

  test('the accept-path resolver returns a real id for each mapped key', async () => {
    for (const key of ALL_SEEDED_KEYS) {
      const id = await catalogServiceIdForProfile(knex, { services: [{ service: key }] });
      expect(id).toBeTruthy();
    }
  });

  // The r1 P1 regression, on a REAL Postgres transaction. A fake connection
  // cannot expose this: Postgres aborts the whole transaction after a failed
  // statement, so the savepoint — not the try/catch — is what keeps the
  // caller's accept usable. Everything runs inside a transaction that is
  // deliberately rolled back, so the schema is never actually altered.
  test('a missing engine_keys column does NOT abort the caller transaction', async () => {
    const ROLLBACK = new Error('intentional rollback');
    let resolved = 'unset';
    let survivedQuery = null;

    await expect(knex.transaction(async (trx) => {
      await trx.raw('ALTER TABLE services RENAME COLUMN engine_keys TO engine_keys__absent');

      resolved = await catalogServiceIdForProfile(trx, {
        services: [{ service: 'pre_slab_termiticide' }],
      });

      // THE ASSERTION THAT MATTERS: the caller's transaction is still usable.
      // Before the savepoint fix this threw "current transaction is aborted",
      // which in production is a FAILED ESTIMATE ACCEPT.
      const row = await trx('services').select('service_key').limit(1).first();
      survivedQuery = row ? 'ok' : 'empty';

      throw ROLLBACK;
    })).rejects.toBe(ROLLBACK);

    expect(resolved).toBeNull();
    expect(survivedQuery).toBe('ok');
    expect(await knex.schema.hasColumn('services', 'engine_keys')).toBe(true);
  });
});
