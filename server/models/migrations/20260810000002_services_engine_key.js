/**
 * Catalog link for pricing-engine service keys — `services.engine_key`.
 *
 * The estimate-accept path (slot-reservation) stamps only `service_type`, a
 * DISPLAY label produced by canonicalServiceTypeForProfile's whitelist. That
 * whitelist falls through to the estimate's `service_interest` verbatim for
 * any key it doesn't know, and EVERY one-time engine key observed on accepted
 * estimates in prod falls through (`pre_slab_termiticide`, `german_roach`,
 * `stinging_insect`). The resulting label matches no `services` row, so
 * resolveCompletionProfileForScheduledService degrades to the GENERIC profile
 * — which silently kills typed one-time billing (no invoice ⇒ the card-hold
 * completion charge, gated on `if (invoice?.id)`, never fires) AND the
 * compliance-project lane (a pre-slab visit could not produce its FDACS
 * certificate of compliance).
 *
 * The catalog is the authority on service identity, so the engine→catalog
 * link lives ON the catalog row rather than in a second code-side registry
 * (owner ruling 2026-08-10). lookupServiceForScheduledService checks
 * `service_id` FIRST, so stamping the id at accept makes profile resolution
 * label-independent and changes NO customer-facing text.
 *
 * Seeds only the three keys observed on accepted estimates. Admin edits are
 * preserved: a row that already carries an engine_key is never overwritten.
 */
const ENGINE_KEY_SEEDS = [
  // Pre-construction slab treatment — the key that surfaced this bug.
  { service_key: 'termite_slab_pretreat', engine_key: 'pre_slab_termiticide' },
  { service_key: 'german_roach', engine_key: 'german_roach' },
  // Owner ruling 2026-08-10: the engine's stinging-insect line is the
  // broad bee/wasp nest removal row, not the narrower mud-dauber row.
  { service_key: 'bee_wasp_removal', engine_key: 'stinging_insect' },
];

const UNIQUE_INDEX = 'services_engine_key_unique';

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('services'))) return;

  if (!(await knex.schema.hasColumn('services', 'engine_key'))) {
    await knex.schema.alterTable('services', (t) => {
      t.string('engine_key', 64).nullable();
    });
  }

  // Partial unique: one catalog row per engine key, but many rows legitimately
  // carry no key at all. A duplicate engine_key would make the accept-path
  // lookup non-deterministic.
  await knex.raw(
    `CREATE UNIQUE INDEX IF NOT EXISTS ${UNIQUE_INDEX}
       ON services (engine_key) WHERE engine_key IS NOT NULL`,
  );

  for (const seed of ENGINE_KEY_SEEDS) {
    // Read-modify-write: only stamp rows that exist and are still unstamped,
    // so an admin edit (or a re-run) is never clobbered.
    await knex('services')
      .where({ service_key: seed.service_key })
      .whereNull('engine_key')
      .update({ engine_key: seed.engine_key, updated_at: knex.fn.now() });
  }
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('services'))) return;

  // Clear only the values this migration seeded — an engine_key added by an
  // admin or a later migration is not ours to drop.
  for (const seed of ENGINE_KEY_SEEDS) {
    await knex('services')
      .where({ service_key: seed.service_key, engine_key: seed.engine_key })
      .update({ engine_key: null, updated_at: knex.fn.now() });
  }

  await knex.raw(`DROP INDEX IF EXISTS ${UNIQUE_INDEX}`);

  if (await knex.schema.hasColumn('services', 'engine_key')) {
    await knex.schema.alterTable('services', (t) => {
      t.dropColumn('engine_key');
    });
  }
};

exports.ENGINE_KEY_SEEDS = ENGINE_KEY_SEEDS;
