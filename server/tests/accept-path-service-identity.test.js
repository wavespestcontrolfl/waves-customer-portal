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
 * `services.engine_key` (migration 20260810000002) is the fix: the accept path
 * stamps `service_id` from it, and lookupServiceForScheduledService checks
 * `service_id` FIRST. This suite pins BOTH halves — the resolver's behavior
 * (static) and the seeded mapping against the migrated catalog (DB-backed,
 * self-skips without DATABASE_URL, mirroring
 * completion-lane-coverage-contract.test.js).
 */
const path = require('path');
const { _internals } = require('../services/slot-reservation');
const { ENGINE_KEY_SEEDS } = require('../models/migrations/20260810000002_services_engine_key');

const { catalogServiceIdForProfile } = _internals;

// Every engine key observed on an ACCEPTED estimate's one-time spec items in
// prod (audit 2026-08-10). All three fell through the label whitelist, so all
// three MUST carry a catalog mapping — this list is the regression fence.
const ENGINE_KEYS_REACHING_ACCEPT = [
  'pre_slab_termiticide',
  'german_roach',
  'stinging_insect',
];

// Load the knexfile BEFORE deciding to skip — it resolves the Railway
// fallbacks into process.env.DATABASE_URL (same reasoning as the
// completion-lane contract).
const knexConfig = require(path.join(__dirname, '..', 'knexfile.js'));
const SKIP = !process.env.DATABASE_URL;
const describeOrSkip = SKIP ? describe.skip : describe;

describe('accept-path engine-key mapping (static)', () => {
  test('every engine key that reaches the accept path is mapped', () => {
    const mapped = new Set(ENGINE_KEY_SEEDS.map((s) => s.engine_key));
    const unmapped = ENGINE_KEYS_REACHING_ACCEPT.filter((k) => !mapped.has(k));
    expect(unmapped).toEqual([]);
  });

  test('no engine key is claimed by two catalog rows', () => {
    const seen = new Map();
    for (const seed of ENGINE_KEY_SEEDS) {
      expect(seen.has(seed.engine_key)
        ? `${seed.engine_key} claimed by both ${seen.get(seed.engine_key)} and ${seed.service_key}`
        : null).toBeNull();
      seen.set(seed.engine_key, seed.service_key);
    }
  });
});

// The REAL profile-building path (codex #3328 r1 P1). Fabricated profiles hid
// the bug entirely: oneTimeProfileServices stores serviceCategoryForOneTimeItem
// in `service`, and every pest specialty collapses to 'pest_control' — so
// german_roach and stinging_insect would have queried engine_key='pest_control'
// and silently stayed unstamped, i.e. 2 of the 3 production cases unfixed.
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

  test('german_roach: category collapses to pest_control but engineKey survives', () => {
    const primary = primaryOf(estimateWith('german_roach', 'German Roach Cleanout'));
    expect(primary).toBeTruthy();
    // The collapse that caused the bug — pinned so a future change is visible.
    expect(primary.service).toBe('pest_control');
    expect(primary.engineKey).toBe('german_roach');
  });

  test('stinging_insect: category collapses to pest_control but engineKey survives', () => {
    const primary = primaryOf(estimateWith('stinging_insect', 'Wasp Nest Removal'));
    expect(primary).toBeTruthy();
    expect(primary.service).toBe('pest_control');
    expect(primary.engineKey).toBe('stinging_insect');
  });

  test('pre_slab_termiticide keeps its own category AND engine key', () => {
    const primary = primaryOf(estimateWith('pre_slab_termiticide', 'Pre-Slab Termiticide Treatment'));
    expect(primary).toBeTruthy();
    expect(primary.engineKey).toBe('pre_slab_termiticide');
  });

  test('the resolver queries the RAW key, not the collapsed category', async () => {
    // End-to-end through the real builder: what would actually hit the DB.
    const estimate = estimateWith('german_roach', 'German Roach Cleanout');
    const profile = resolveEstimateSlotProfile(estimate, { serviceMode: 'one_time' });
    let queried = null;
    const conn = () => ({ where: (w) => { queried = w; return { first: async () => null }; } });
    conn.transaction = async (cb) => cb(conn);
    await catalogServiceIdForProfile(conn, profile);
    expect(queried).toEqual({ engine_key: 'german_roach', is_active: true });
  });
});

describe('catalogServiceIdForProfile', () => {
  // The helper runs its read inside conn.transaction(...) — a SAVEPOINT when
  // the caller already holds a transaction — so the fake connection must model
  // that, not a bare query builder.
  const makeConn = (onQuery) => {
    const builder = () => ({ where: (w) => ({ first: async () => onQuery(w) }) });
    builder.transaction = async (cb) => cb(builder);
    return builder;
  };

  test('resolves the primary service key to a catalog id', async () => {
    const id = await catalogServiceIdForProfile(
      makeConn(() => ({ id: 'svc-1' })),
      { services: [{ service: 'pre_slab_termiticide' }] },
    );
    expect(id).toBe('svc-1');
  });

  test('picks the SAME primary the display label picks (pest_control wins)', async () => {
    // canonicalServiceTypeForProfile prefers a pest_control line over
    // services[0]; the id must describe the same service as the label, or one
    // row would claim two different services.
    let queried = null;
    await catalogServiceIdForProfile(
      makeConn((w) => { queried = w; return { id: 'svc-pest' }; }),
      { services: [{ service: 'pre_slab_termiticide' }, { service: 'pest_control' }] },
    );
    expect(queried.engine_key).toBe('pest_control');
    expect(queried.is_active).toBe(true);
  });

  test('returns null when the profile carries no service key', async () => {
    const c = makeConn(() => ({ id: 'x' }));
    expect(await catalogServiceIdForProfile(c, { services: [] })).toBeNull();
    expect(await catalogServiceIdForProfile(c, {})).toBeNull();
  });

  test('returns null (never throws) when the key maps to nothing', async () => {
    expect(await catalogServiceIdForProfile(
      makeConn(() => undefined), { services: [{ service: 'not_a_real_key' }] },
    )).toBeNull();
  });

  test('FAILS OPEN when the lookup throws (pre-migration deploy)', async () => {
    await expect(catalogServiceIdForProfile(
      makeConn(() => { throw new Error('column "engine_key" does not exist'); }),
      { services: [{ service: 'pre_slab_termiticide' }] },
    )).resolves.toBeNull();
  });

  test('never queries on a connection that cannot open a savepoint', async () => {
    // Guards the P1 directly: without conn.transaction the read would run
    // bare on the caller's transaction and a failure would abort it.
    const bare = () => { throw new Error('should not be queried'); };
    await expect(catalogServiceIdForProfile(
      bare, { services: [{ service: 'pre_slab_termiticide' }] },
    )).resolves.toBeNull();
  });
});

describeOrSkip('seeded engine_key mapping against the migrated catalog', () => {
  let knex;
  beforeAll(() => {
    knex = require('knex')(knexConfig[process.env.NODE_ENV || 'development'] || knexConfig.development);
  });
  afterAll(async () => { if (knex) await knex.destroy(); });

  test('services.engine_key column exists', async () => {
    expect(await knex.schema.hasColumn('services', 'engine_key')).toBe(true);
  });

  test('every seeded engine key resolves to exactly one ACTIVE catalog row', async () => {
    for (const seed of ENGINE_KEY_SEEDS) {
      const rows = await knex('services')
        .where({ engine_key: seed.engine_key })
        .select('service_key', 'is_active', 'billing_type');
      expect({ key: seed.engine_key, count: rows.length }).toEqual({ key: seed.engine_key, count: 1 });
      expect(rows[0].service_key).toBe(seed.service_key);
      expect(rows[0].is_active).toBe(true);
    }
  });

  test('the accept-path resolver returns a real id for each mapped key', async () => {
    for (const seed of ENGINE_KEY_SEEDS) {
      const id = await catalogServiceIdForProfile(knex, { services: [{ service: seed.engine_key }] });
      expect(id).toBeTruthy();
    }
  });

  // The P1 regression, on a REAL Postgres transaction. A fake connection
  // cannot expose this: Postgres aborts the whole transaction after a failed
  // statement, so the savepoint — not the try/catch — is what keeps the
  // caller's accept usable. Everything happens inside a transaction that is
  // deliberately rolled back, so the schema is never actually altered.
  test('a missing engine_key column does NOT abort the caller transaction', async () => {
    const ROLLBACK = new Error('intentional rollback');
    let resolved = 'unset';
    let survivedQuery = null;

    await expect(knex.transaction(async (trx) => {
      // Simulate the deploy-skew window (code live, migration not yet run).
      await trx.raw('ALTER TABLE services RENAME COLUMN engine_key TO engine_key__absent');

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

    // And the rollback really did restore the column.
    expect(await knex.schema.hasColumn('services', 'engine_key')).toBe(true);
  });
});
