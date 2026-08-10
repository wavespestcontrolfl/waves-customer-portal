/**
 * Catalog link for pricing-engine service keys — `services.engine_keys`.
 *
 * The estimate-accept path stamps only `service_type`, a DISPLAY label produced
 * by canonicalServiceTypeForProfile's whitelist. That whitelist falls through to
 * the estimate's `service_interest` verbatim for any key it doesn't know, and
 * EVERY one-time engine key observed on accepted estimates in prod falls through
 * (`pre_slab_termiticide`, `german_roach`, `stinging_insect`). The resulting
 * label matches no `services` row, so resolveCompletionProfileForScheduledService
 * degrades to the GENERIC profile — which silently kills typed one-time billing
 * (no invoice ⇒ the card-hold completion charge, gated on `if (invoice?.id)`,
 * never fires) AND the compliance-project lane (a pre-slab visit could not
 * produce its FDACS certificate of compliance).
 *
 * The catalog is the authority on service identity, so the engine→catalog link
 * lives ON the catalog row rather than in a second code-side registry (owner
 * ruling 2026-08-10). lookupServiceForScheduledService checks `service_id`
 * FIRST, so stamping the id at accept makes profile resolution
 * label-independent and changes NO customer-facing text.
 *
 * ONE-TO-MANY (jsonb array, not a scalar column — codex #3328 r2 P1): the engine
 * emits VERSIONED aliases for a single catalog service. `stinging_insect` and
 * `stinging_insect_v2` (service-pricing.js:7770 / :8203) are the same real
 * service and both must resolve to `bee_wasp_removal`, which a scalar column
 * cannot express. Note the contrast with `german_roach` vs
 * `german_roach_initial` (:6208 / :6241): those are DIFFERENT services with
 * their own catalog rows ("German Roach Cleanout" vs "German Roach Initial
 * (3-Visit)"), so they map 1:1 each and must NOT be aliased together.
 *
 * COVERAGE IS DELIBERATELY PARTIAL. Seeded: the three services observed on
 * accepted estimates, plus every current engine alias of those services. The
 * engine emits ~51 keys in total; the rest stay unmapped and FAIL OPEN (exactly
 * today's behavior) rather than be guessed at — mapping them is a business
 * decision per service. server/tests/accept-path-service-identity.test.js lists
 * the known-unmapped set explicitly so the gap is visible, never silent.
 *
 * Admin edits are preserved: a row that already carries engine_keys is never
 * overwritten.
 */
const ENGINE_KEY_SEEDS = [
  // Pre-construction slab treatment — the key that surfaced this bug.
  { service_key: 'termite_slab_pretreat', engine_keys: ['pre_slab_termiticide'] },
  // Distinct services, distinct catalog rows — NOT aliases of each other.
  { service_key: 'german_roach', engine_keys: ['german_roach'] },
  { service_key: 'german_roach_initial', engine_keys: ['german_roach_initial'] },
  // Owner ruling 2026-08-10: the engine's stinging-insect line is the broad
  // bee/wasp nest removal row, not the narrower mud-dauber row. Both engine
  // versions are the same service.
  { service_key: 'bee_wasp_removal', engine_keys: ['stinging_insect', 'stinging_insect_v2'] },
];

const GIN_INDEX = 'services_engine_keys_gin';

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('services'))) return;

  if (!(await knex.schema.hasColumn('services', 'engine_keys'))) {
    await knex.schema.alterTable('services', (t) => {
      t.jsonb('engine_keys').nullable();
    });
  }

  // Containment lookups (`engine_keys @> '["pre_slab_termiticide"]'`) are what
  // the accept path runs on every acceptance.
  await knex.raw(
    `CREATE INDEX IF NOT EXISTS ${GIN_INDEX} ON services USING GIN (engine_keys)`,
  );

  for (const seed of ENGINE_KEY_SEEDS) {
    // Read-modify-write: only stamp rows that exist and are still unstamped,
    // so an admin edit (or a re-run) is never clobbered.
    await knex('services')
      .where({ service_key: seed.service_key })
      .whereNull('engine_keys')
      .update({ engine_keys: JSON.stringify(seed.engine_keys), updated_at: knex.fn.now() });
  }
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('services'))) return;

  // Clear only the values this migration seeded — engine_keys added by an admin
  // or a later migration are not ours to drop.
  for (const seed of ENGINE_KEY_SEEDS) {
    await knex('services')
      .where({ service_key: seed.service_key })
      .whereRaw('engine_keys = ?::jsonb', [JSON.stringify(seed.engine_keys)])
      .update({ engine_keys: null, updated_at: knex.fn.now() });
  }

  await knex.raw(`DROP INDEX IF EXISTS ${GIN_INDEX}`);

  if (await knex.schema.hasColumn('services', 'engine_keys')) {
    await knex.schema.alterTable('services', (t) => {
      t.dropColumn('engine_keys');
    });
  }
};

exports.ENGINE_KEY_SEEDS = ENGINE_KEY_SEEDS;
