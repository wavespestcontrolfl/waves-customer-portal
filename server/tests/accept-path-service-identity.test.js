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

describe('catalogServiceIdForProfile', () => {
  const conn = (rows) => {
    const fn = () => ({
      where: () => ({ first: async () => rows }),
    });
    return fn;
  };

  test('resolves the primary service key to a catalog id', async () => {
    const id = await catalogServiceIdForProfile(
      conn({ id: 'svc-1' }),
      { services: [{ service: 'pre_slab_termiticide' }] },
    );
    expect(id).toBe('svc-1');
  });

  test('picks the SAME primary the display label picks (pest_control wins)', async () => {
    // canonicalServiceTypeForProfile prefers a pest_control line over
    // services[0]; the id must describe the same service as the label, or one
    // row would claim two different services.
    let queried = null;
    const spyConn = () => ({
      where: (w) => { queried = w; return { first: async () => ({ id: 'svc-pest' }) }; },
    });
    await catalogServiceIdForProfile(spyConn, {
      services: [{ service: 'pre_slab_termiticide' }, { service: 'pest_control' }],
    });
    expect(queried.engine_key).toBe('pest_control');
    expect(queried.is_active).toBe(true);
  });

  test('returns null when the profile carries no service key', async () => {
    expect(await catalogServiceIdForProfile(conn({ id: 'x' }), { services: [] })).toBeNull();
    expect(await catalogServiceIdForProfile(conn({ id: 'x' }), {})).toBeNull();
  });

  test('returns null (never throws) when the key maps to nothing', async () => {
    expect(await catalogServiceIdForProfile(
      conn(undefined), { services: [{ service: 'not_a_real_key' }] },
    )).toBeNull();
  });

  test('FAILS OPEN when the lookup throws (pre-migration deploy)', async () => {
    const throwingConn = () => ({
      where: () => ({ first: async () => { throw new Error('column "engine_key" does not exist'); } }),
    });
    await expect(catalogServiceIdForProfile(
      throwingConn, { services: [{ service: 'pre_slab_termiticide' }] },
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
});
