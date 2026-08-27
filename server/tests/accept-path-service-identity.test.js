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

const {
  ENGINE_KEY_SEEDS: EXPANSION_SEEDS,
  ALIAS_APPENDS,
  CONDITIONAL_SEEDS,
} = require('../models/migrations/20260825000011_engine_key_coverage_expansion');

const { catalogLinkForProfile } = _internals;
// id-only view used throughout this suite — the link {id, name, service_key}
// is the single resolver surface since #3485 (the wrapper was removed).
const catalogServiceIdForProfile = async (conn, profile) => {
  const link = await catalogLinkForProfile(conn, profile);
  return link ? link.id : null;
};

// The 2026-08-25 coverage expansion seeds ride on top of the original four
// rows; the alias appends (wasp, pre_slab_termidor) join their parent
// rows' arrays. The combined view is what the LIVE catalog carries after
// both migrations.
const appendsFor = (key) => ALIAS_APPENDS.filter((t) => t.service_key === key).map((t) => t.append);
const COMBINED_SEEDS = [
  ...ENGINE_KEY_SEEDS.map((s) => ({ ...s, engine_keys: [...s.engine_keys, ...appendsFor(s.service_key)] })),
  ...EXPANSION_SEEDS,
  // Conditional seeds land on whichever candidate row the environment has —
  // represented here by their preferred candidate; the DB-backed tests below
  // assert resolution on the LIVE catalog regardless of which row won.
  ...CONDITIONAL_SEEDS.map((s) => ({ service_key: s.service_key_candidates[0], engine_keys: s.engine_keys })),
];

const ALL_SEEDED_KEYS = COMBINED_SEEDS.flatMap((s) => s.engine_keys);

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
  // ONE key for four sanitation tier rows — no tier discriminator on the line.
  'rodent_sanitation',
  // Shared raw key: the engine reuses one_time_lawn for the distinct
  // "Lawn Pest Knockdown" identity, so it cannot name one catalog row.
  'one_time_lawn',
  // Exclusion + bait + guarantee bundle — mapping it to the payment-only
  // guarantee row would hide the sold field work from completion.
  'rodent_guarantee_combo',
  // Retainers are billing plans with no schedulable catalog rows by design
  // (estimate-converter.js: deliberately NO branch), and their surcharge/
  // callback riders bill on the parent line.
  'trap_only_retainer', 'trap_only_setup', 'trap_only_extra_callback',
  'rodent_trapping_emergency_surcharge', 'rodent_trapping_extra_callback',
  // Priced rider with no catalog row of its own.
  'rodent_plugging',
  // One line can carry an AGGREGATE follow-up count while the slot profile
  // books one appointment — unmapped until conversion is count-aware.
  'rodent_trapping_followup',
  // ONE engine key sells TWO plans (Standard: two included callbacks;
  // Unlimited) while the catalog row's completion contract is the
  // unlimited 14-day chaining window — a Standard sale stamped with it
  // would generate callbacks beyond the two purchased (codex r18 P1).
  'rodent_trapping',
  // Active only in prod (admin-reactivated after the 20260519000003
  // archive) — a seed would target an archived row in migration-built
  // databases; the label resolves the row by unique name where it is live.
  'palm_injection',
  // Two-visit program vs one-visit catalog contract — a durable identity
  // would erase the treatment-count difference (flea package's priced
  // follow-up; roach knockdown vs cockroach_control's fixed two-treatment
  // 14-day-follow-up lane). Label resolution keeps status-quo behavior.
  'flea_package',
  'pest_initial_roach',
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
    for (const seed of COMBINED_SEEDS) {
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

  test('all three stinging-insect engine versions resolve to ONE catalog row', () => {
    const owner = (key) => COMBINED_SEEDS.find((s) => s.engine_keys.includes(key))?.service_key;
    expect(owner('stinging_insect')).toBe('bee_wasp_removal');
    expect(owner('stinging_insect_v2')).toBe('bee_wasp_removal');
    // The legacy v1 'wasp' key (service-pricing.js:7842) is the third alias —
    // missed by the original seed, appended by 20260825000011.
    expect(owner('wasp')).toBe('bee_wasp_removal');
  });

  test('legacy pre_slab_termidor stays on the certificate lane', () => {
    // It wraps pricePreSlabTermiticide — same FDACS-certificate service, so
    // it must resolve termite_slab_pretreat, never termite_pretreatment.
    const owner = (key) => COMBINED_SEEDS.find((s) => s.engine_keys.includes(key))?.service_key;
    expect(owner('pre_slab_termidor')).toBe('termite_slab_pretreat');
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

  test('the rodent_guarantee payment-only rider never enters the profile (codex r21 P1)', () => {
    // The engine emits the guarantee before later services; if it entered
    // the profile it would become the PRIMARY and stamp the field visit
    // with a duration-zero internal-only billing identity, hiding the sold
    // plugging work from its completion lane. It stays on billing only.
    const estimate = {
      id: 'est-guarantee',
      service_interest: 'Rodent Services',
      estimate_data: {
        result: {
          oneTime: {
            specItems: [
              { service: 'rodent_guarantee', name: 'Rodent Guarantee', price: 349 },
              { service: 'plugging', name: 'Lawn Plugging', price: 480 },
            ],
            total: 829,
          },
        },
      },
    };
    const profile = resolveEstimateSlotProfile(estimate, { serviceMode: 'one_time' });
    const services = profile?.services || [];
    expect(services.some((s) => s?.engineKey === 'rodent_guarantee')).toBe(false);
    expect(services.some((s) => s?.engineKey === 'plugging')).toBe(true);
  });

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
    // row would claim two different services. The family category resolves
    // through its cadence key (family keys are never containment-queried),
    // so the cadence lookup firing for pest proves pest_control won.
    let where = null;
    const conn = () => ({
      whereRaw: () => { throw new Error('family key must not be containment-queried'); },
      where: (cond) => { where = cond; return { limit: () => ({ select: async () => [{ id: 'svc-pest', name: 'Monthly Pest Control Service', service_key: cond.service_key }] }) }; },
    });
    conn.transaction = async (cb) => cb(conn);
    await catalogServiceIdForProfile(
      conn,
      { services: [{ service: 'pre_slab_termiticide' }, { service: 'pest_control', visitsPerYear: 12 }] },
    );
    expect(where).toEqual({ service_key: 'pest_general_monthly', is_active: true });
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

  // Cadence families share one engine key across per-cadence rows, so
  // containment can never resolve them; the resolver falls back to the
  // cadence-specific service_key — environment-proof where the label
  // whitelist is not (fresh DBs carry different NAMES for the same rows,
  // e.g. "Mosquito Control Service (Monthly)" — codex #3485 r3 P1).
  describe('cadence-keyed fallback', () => {
    const makeCadenceConn = (keyRows, capture = {}) => {
      const builder = () => ({
        whereRaw: () => ({ andWhere: () => ({ limit: () => ({ select: async () => [] }) }) }),
        where: (cond) => {
          capture.where = cond;
          return { limit: () => ({ select: async () => keyRows }) };
        },
      });
      builder.transaction = async (cb) => cb(builder);
      return builder;
    };

    test('a 12-visit mosquito profile resolves mosquito_monthly by service_key', async () => {
      const capture = {};
      const row = { id: 'svc-mm', name: 'Mosquito Control Service (Monthly)', service_key: 'mosquito_monthly' };
      const link = await catalogLinkForProfile(
        makeCadenceConn([row], capture),
        { services: [{ service: 'mosquito', visitsPerYear: 12 }] },
      );
      expect(link).toEqual(row);
      expect(capture.where).toEqual({ service_key: 'mosquito_monthly', is_active: true });
    });

    test('a quarterly pest profile resolves pest_general_quarterly', async () => {
      const capture = {};
      const row = { id: 'svc-pq', name: 'Quarterly Pest Control Service', service_key: 'pest_general_quarterly' };
      const link = await catalogLinkForProfile(
        makeCadenceConn([row], capture),
        { services: [{ service: 'pest_control', visitsPerYear: 4 }] },
      );
      expect(link).toEqual(row);
    });

    test('a legacy 4-application lawn profile resolves lawn_care_quarterly', async () => {
      const capture = {};
      const row = { id: 'svc-lq', name: 'Quarterly Lawn Care Service', service_key: 'lawn_care_quarterly' };
      const link = await catalogLinkForProfile(
        makeCadenceConn([row], capture),
        { services: [{ service: 'lawn_care', visitsPerYear: 4 }] },
      );
      expect(link).toEqual(row);
      expect(capture.where).toEqual({ service_key: 'lawn_care_quarterly', is_active: true });
    });

    test('off-catalog visit counts stay unlinked (exact match, never bucketed)', async () => {
      // 8 pest visits are NOT the 6-visit bi-monthly row; bucketing would
      // stamp an unrelated durable identity (codex #3485 r8 P2).
      const capture = {};
      for (const [service, visits] of [['pest_control', 8], ['lawn_care', 10], ['mosquito', 10], ['tree_shrub', 5]]) {
        expect(await catalogLinkForProfile(
          makeCadenceConn([{ id: 'x' }], capture),
          { services: [{ service, visitsPerYear: visits }] },
        )).toBeNull();
      }
      expect(capture.where).toBeUndefined();
    });

    test('one_time mode and unknown cadence never trigger the keyed lookup', async () => {
      const capture = {};
      expect(await catalogLinkForProfile(
        makeCadenceConn([{ id: 'x' }], capture),
        { serviceMode: 'one_time', services: [{ service: 'pest_control', visitsPerYear: 4 }] },
      )).toBeNull();
      expect(capture.where).toBeUndefined();
      expect(await catalogLinkForProfile(
        makeCadenceConn([{ id: 'x' }], capture),
        { services: [{ service: 'pest_control' }] },
      )).toBeNull();
      expect(capture.where).toBeUndefined();
    });

    test('cadence profiles resolve by cadence key EXCLUSIVELY — a shared family mapping never wins', async () => {
      // An admin-authored 'pest_control' engine key on the quarterly row
      // must not stamp a 12-visit monthly accept (codex #3485 r13 P1).
      let containmentQueried = false;
      const conn = () => ({
        whereRaw: () => { containmentQueried = true; return { andWhere: () => ({ limit: () => ({ select: async () => [{ id: 'svc-quarterly' }] }) }) }; },
        where: (cond) => ({ limit: () => ({ select: async () => [{ id: 'svc-monthly', name: 'Monthly Pest Control Service', service_key: cond.service_key }] }) }),
      });
      conn.transaction = async (cb) => cb(conn);
      const link = await catalogLinkForProfile(conn, {
        services: [{ service: 'pest_control', visitsPerYear: 12 }],
      });
      expect(link).toMatchObject({ id: 'svc-monthly', service_key: 'pest_general_monthly' });
      expect(containmentQueried).toBe(false);
    });

    test('an off-cadence family profile NEVER falls through to containment', async () => {
      // 8-visit pest, cadence-less lawn, 10-visit mosquito: the shared
      // family key spans multiple catalog rows, so a single admin-authored
      // family mapping would stamp every off-cadence accept with that one
      // row's identity (pre-push P1). They stay unlinked instead.
      let containmentQueried = false;
      const conn = () => ({
        whereRaw: () => { containmentQueried = true; return { andWhere: () => ({ limit: () => ({ select: async () => [{ id: 'svc-admin-mapped' }] }) }) }; },
        where: () => ({ limit: () => ({ select: async () => [] }) }),
      });
      conn.transaction = async (cb) => cb(conn);
      for (const services of [
        [{ service: 'pest_control', visitsPerYear: 8 }],
        [{ service: 'lawn_care' }],
        [{ service: 'mosquito', visitsPerYear: 10 }],
        [{ service: 'tree_shrub', visitsPerYear: 12 }],
      ]) {
        expect(await catalogLinkForProfile(conn, { services })).toBeNull();
      }
      expect(containmentQueried).toBe(false);
    });

    test('commercial plans never stamp residential cadence rows', async () => {
      const capture = {};
      expect(await catalogLinkForProfile(
        makeCadenceConn([{ id: 'x' }], capture),
        { services: [{ service: 'pest_control', engineKey: 'commercial_pest', visitsPerYear: 4, name: 'Commercial Pest Control' }] },
      )).toBeNull();
      expect(capture.where).toBeUndefined();
    });

    test('commercial profiles never resolve through CONTAINMENT either (termite bait collapse)', async () => {
      // resolveEstimateSlotProfile collapses commercial_termite_bait to
      // service 'termite_bait' with commercial: true — containment would
      // otherwise stamp the RESIDENTIAL bait row (pre-push P1).
      let containmentQueried = false;
      const conn = () => ({
        whereRaw: () => { containmentQueried = true; return { andWhere: () => ({ limit: () => ({ select: async () => [{ id: 'svc-resi-bait' }] }) }) }; },
        where: () => ({ limit: () => ({ select: async () => [] }) }),
      });
      conn.transaction = async (cb) => cb(conn);
      expect(await catalogLinkForProfile(conn, {
        services: [{ service: 'termite_bait', commercial: true, visitsPerYear: 4 }],
      })).toBeNull();
      // Raw-identity fallback when the flag is absent but the text says so.
      expect(await catalogLinkForProfile(conn, {
        services: [{ service: 'termite_bait', name: 'Commercial Termite Bait Stations', visitsPerYear: 4 }],
      })).toBeNull();
      expect(containmentQueried).toBe(false);
    });

    test('an ambiguous cadence key FAILS CLOSED', async () => {
      expect(await catalogLinkForProfile(
        makeCadenceConn([{ id: 'a' }, { id: 'b' }]),
        { services: [{ service: 'mosquito', visitsPerYear: 12 }] },
      )).toBeNull();
    });
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

describe('itemized V2 exclusion collapses to ONE profile service (codex #3521 r1 P1)', () => {
  const { resolveEstimateSlotProfile } = require('../services/estimate-slot-availability');

  test('three rodent_exclusion section rows yield one rodent_exclusion profile row named for the job', () => {
    const estimate = {
      id: 'est-excl-v2',
      service_interest: 'Rodent Services',
      estimate_data: {
        result: {
          oneTime: {
            specItems: [
              { service: 'rodent_exclusion', name: 'Rodent Exclusion — Wire Mesh Points', price: 150 },
              { service: 'rodent_exclusion', name: 'Rodent Exclusion — Bird Boxes', price: 150 },
              { service: 'rodent_exclusion', name: 'Rodent Exclusion — Linear Mesh', price: 280 },
            ],
            total: 580,
          },
        },
      },
    };
    const profile = resolveEstimateSlotProfile(estimate, { serviceMode: 'one_time' });
    const services = (profile?.services || []).filter(Boolean);
    // adoptedAppointmentCatalogStamp requires exactly one profile service.
    expect(services).toHaveLength(1);
    expect(services[0].engineKey).toBe('rodent_exclusion');
    expect(services[0].label).toBe('Rodent Exclusion');
  });

  test('distinct engine keys still stay distinct', () => {
    const estimate = {
      id: 'est-excl-trap',
      service_interest: 'Rodent Services',
      estimate_data: {
        result: {
          oneTime: {
            specItems: [
              { service: 'rodent_trapping', name: 'Rodent Trapping', price: 350 },
              { service: 'rodent_exclusion', name: 'Rodent Exclusion — Wire Mesh Points', price: 150 },
              { service: 'rodent_exclusion', name: 'Rodent Exclusion — Bird Boxes', price: 150 },
            ],
            total: 650,
          },
        },
      },
    };
    const profile = resolveEstimateSlotProfile(estimate, { serviceMode: 'one_time' });
    const keys = (profile?.services || []).filter(Boolean).map((s) => s.engineKey);
    expect(keys).toEqual(['rodent_trapping', 'rodent_exclusion']);
  });
});

describe('distinct paid products sharing an engine key are NOT collapsed (codex #3521 r8 P1)', () => {
  const { resolveEstimateSlotProfile } = require('../services/estimate-slot-availability');

  test('one-time lawn treatment + lawn pest control both stay in the profile', () => {
    const estimate = {
      id: 'est-lawn-two',
      service_interest: 'Lawn',
      estimate_data: {
        result: {
          oneTime: {
            specItems: [
              { service: 'one_time_lawn', name: 'One-Time Lawn Treatment', price: 174 },
              { service: 'one_time_lawn', name: 'Lawn Pest Control', price: 160 },
            ],
            total: 334,
          },
        },
      },
    };
    const profile = resolveEstimateSlotProfile(estimate, { serviceMode: 'one_time' });
    const labels = (profile?.services || []).filter(Boolean).map((s) => s.label);
    expect(labels).toEqual(['One-Time Lawn Treatment', 'Lawn Pest Control']);
  });

  test('rodent exclusion sections still collapse to one row', () => {
    const estimate = {
      id: 'est-excl-again',
      service_interest: 'Rodent Services',
      estimate_data: {
        result: {
          oneTime: {
            specItems: [
              { service: 'rodent_exclusion', name: 'Rodent Exclusion — Wire Mesh Points', price: 150 },
              { service: 'rodent_exclusion', name: 'Rodent Exclusion — Linear Mesh', price: 280 },
            ],
            total: 430,
          },
        },
      },
    };
    const profile = resolveEstimateSlotProfile(estimate, { serviceMode: 'one_time' });
    const services = (profile?.services || []).filter(Boolean);
    expect(services).toHaveLength(1);
    expect(services[0].label).toBe('Rodent Exclusion');
    expect(services[0].rawLabel).toBeDefined();
  });
});
