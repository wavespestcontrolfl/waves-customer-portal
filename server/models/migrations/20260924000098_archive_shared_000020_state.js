/**
 * Forward-only containment for two already-applied migrations that share the
 * same system_settings key.
 *
 * Both original files ran before this collision was detected and therefore
 * stay byte-for-byte frozen. Their shared row may contain only whichever
 * ownership record survived last; state overwritten before this migration
 * cannot be recovered safely. This migration archives that surviving value as
 * opaque text under its own unique key. It does not parse or reconstruct lawn,
 * mosquito, service, profile, or flag ownership, and it does not change the
 * legacy row or any operational catalog data.
 *
 * down() is intentionally a no-op. During a historical rollback, the frozen
 * mosquito migration can delete the shared legacy row. Removing this archive
 * first would erase the only remaining evidence of what that row contained.
 */

const LEGACY_STATE_KEY = 'migration.20260924000020.state';
const STATE_KEY = 'migration.20260924000098.state';
const ARCHIVE_KIND = 'applied_migration_state_collision_archive_v1';
const FROZEN_OWNERS = Object.freeze([
  Object.freeze({
    file: '20260924000020_bimonthly_lawn_service_not_offered.js',
    sha256: '08c8b103c6bd95e33d771de5320f7b20a7a75fd5f6389bbec41112c905c9e2e3',
  }),
  Object.freeze({
    file: '20260924000020_mosquito_misting_catalog_row.js',
    sha256: 'c21207ac6cbf54f66cabfda75117a85dfae9f74de6065a9c6a71a540e9cc7bdf',
  }),
]);

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('system_settings'))) return;

  // This key is migration-owned, but leave an existing value untouched. It
  // may be the only archive from an earlier run or a later operator annotation.
  const existingArchive = await knex('system_settings').where({ key: STATE_KEY }).first('value');
  if (existingArchive) return;

  // Read only. The applied migrations retain their original row and rollback
  // behavior; the archive captures presence separately from a null/raw value.
  const legacy = await knex('system_settings').where({ key: LEGACY_STATE_KEY }).first('value');
  await knex('system_settings').insert({
    key: STATE_KEY,
    value: JSON.stringify({
      archive_kind: ARCHIVE_KIND,
      legacy_key: LEGACY_STATE_KEY,
      legacy_present: Boolean(legacy),
      legacy_value: legacy ? legacy.value : null,
      frozen_owners: FROZEN_OWNERS,
      limitation: 'Surviving raw state only; ownership overwritten before archival is unrecoverable.',
    }),
  });
};

exports.down = async function down() {
  // Documented no-op: preserve the archive through rollback of the frozen files.
};

exports.ARCHIVE_KIND = ARCHIVE_KIND;
exports.FROZEN_OWNERS = FROZEN_OWNERS;
exports.LEGACY_STATE_KEY = LEGACY_STATE_KEY;
exports.STATE_KEY = STATE_KEY;
