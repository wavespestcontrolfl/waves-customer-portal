/**
 * technician_capabilities gets an editor (Field Team Program, Phase 0 item 4).
 *
 * Until now the only writer was the June seed, so the two free-text columns
 * auto-dispatch interprets had nothing pinning them:
 *   - capability_level: scoring.js knows 'qualified' and 'review_required'
 *     ('deactivated' is derived from active=false, never stored). Any other
 *     string would score as undefined → NaN. Stray values are normalized to
 *     'review_required' (logged) before the CHECK lands.
 *   - service_category: the classifier vocabulary (service-category.js).
 *
 * Plus the audit pair the editor stamps: verified_by (staff row; SET NULL on
 * delete so the capability survives an offboarded verifier) and verified_at.
 *
 * Vocabularies are inlined on purpose — a migration must not change meaning
 * when application code changes later.
 */
const LEVELS = ['qualified', 'review_required'];
const CATEGORIES = ['general', 'mosquito', 'lawn', 'rodent', 'termite'];

const LEVEL_CHECK = 'technician_capabilities_level_check';
const CATEGORY_CHECK = 'technician_capabilities_category_check';

const quoted = (list) => list.map((v) => `'${v}'`).join(', ');

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('technician_capabilities'))) return;

  // Each audit column guarded on its own: a preview or hand-reconciled
  // database with only one of them still converges, both directions.
  if (!(await knex.schema.hasColumn('technician_capabilities', 'verified_by'))) {
    await knex.schema.alterTable('technician_capabilities', (t) => {
      t.uuid('verified_by').nullable().references('id').inTable('technicians').onDelete('SET NULL');
    });
  }
  if (!(await knex.schema.hasColumn('technician_capabilities', 'verified_at'))) {
    await knex.schema.alterTable('technician_capabilities', (t) => {
      t.timestamp('verified_at', { useTz: true }).nullable();
    });
  }

  const strayLevels = await knex('technician_capabilities')
    .whereNotIn('capability_level', LEVELS)
    .update({ capability_level: 'review_required', updated_at: knex.fn.now() });
  if (strayLevels) {
    console.log(`[migrate:technician_capabilities_verified] normalized ${strayLevels} row(s) with an unknown capability_level to review_required`);
  }
  await knex.raw(`ALTER TABLE technician_capabilities DROP CONSTRAINT IF EXISTS ${LEVEL_CHECK}`);
  await knex.raw(`
    ALTER TABLE technician_capabilities
    ADD CONSTRAINT ${LEVEL_CHECK}
    CHECK (capability_level IN (${quoted(LEVELS)}))
  `);

  // A row in an unknown category is inert (auto-dispatch only ever looks up
  // the five classifier values) but deleting it here would be destructive.
  // Log and leave the category CHECK off rather than fail every deploy.
  const [{ count: strayCategories }] = await knex('technician_capabilities')
    .whereNotIn('service_category', CATEGORIES)
    .count({ count: '*' });
  if (Number(strayCategories) > 0) {
    console.log(`[migrate:technician_capabilities_verified] ${strayCategories} row(s) carry a service_category outside ${CATEGORIES.join('/')} — category CHECK NOT added; review those rows`);
  } else {
    await knex.raw(`ALTER TABLE technician_capabilities DROP CONSTRAINT IF EXISTS ${CATEGORY_CHECK}`);
    await knex.raw(`
      ALTER TABLE technician_capabilities
      ADD CONSTRAINT ${CATEGORY_CHECK}
      CHECK (service_category IN (${quoted(CATEGORIES)}))
    `);
  }
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('technician_capabilities'))) return;
  await knex.raw(`ALTER TABLE technician_capabilities DROP CONSTRAINT IF EXISTS ${CATEGORY_CHECK}`);
  await knex.raw(`ALTER TABLE technician_capabilities DROP CONSTRAINT IF EXISTS ${LEVEL_CHECK}`);
  if (await knex.schema.hasColumn('technician_capabilities', 'verified_at')) {
    await knex.schema.alterTable('technician_capabilities', (t) => t.dropColumn('verified_at'));
  }
  if (await knex.schema.hasColumn('technician_capabilities', 'verified_by')) {
    await knex.schema.alterTable('technician_capabilities', (t) => t.dropColumn('verified_by'));
  }
};
