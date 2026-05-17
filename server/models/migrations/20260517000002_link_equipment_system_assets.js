/**
 * Link calibrated equipment systems to operational equipment assets.
 *
 * `equipment_systems` remains the WaveGuard calibration concept: a composed
 * spray rig used for carrier-rate math. This migration only gives that concept
 * first-class links back to the canonical operational `equipment` table.
 */

const ASSET_COLUMNS = [
  'tank_asset_id',
  'pump_asset_id',
  'reel_asset_id',
  'hose_asset_id',
  'gun_asset_id',
];

async function addForeignKeyIfMissing(knex, column) {
  const constraintName = `equipment_systems_${column}_equipment_fkey`;
  await knex.raw(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = '${constraintName}'
      ) THEN
        ALTER TABLE equipment_systems
        ADD CONSTRAINT ${constraintName}
        FOREIGN KEY (${column})
        REFERENCES equipment(id)
        ON DELETE SET NULL;
      END IF;
    END;
    $$;
  `);
}

async function addIndexIfMissing(knex, column, indexName) {
  await knex.raw(`CREATE INDEX IF NOT EXISTS ${indexName} ON equipment_systems (${column})`);
}

async function clearOrphanAssetLinks(knex, column) {
  await knex.raw(`
    UPDATE equipment_systems es
    SET ${column} = NULL,
        updated_at = NOW()
    WHERE ${column} IS NOT NULL
      AND NOT EXISTS (
        SELECT 1
        FROM equipment e
        WHERE e.id = es.${column}
      )
  `);
}

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('equipment_systems'))) return;
  if (!(await knex.schema.hasTable('equipment'))) return;

  if (!(await knex.schema.hasColumn('equipment_systems', 'primary_equipment_id'))) {
    await knex.schema.alterTable('equipment_systems', (t) => {
      t.uuid('primary_equipment_id')
        .nullable()
        .after('system_type');
    });
  }

  await addIndexIfMissing(knex, 'primary_equipment_id', 'idx_eqs_primary_equipment');
  for (const column of ASSET_COLUMNS) {
    await addIndexIfMissing(knex, column, `idx_eqs_${column}`);
  }

  await clearOrphanAssetLinks(knex, 'primary_equipment_id');
  for (const column of ASSET_COLUMNS) {
    await clearOrphanAssetLinks(knex, column);
  }

  await addForeignKeyIfMissing(knex, 'primary_equipment_id');
  for (const column of ASSET_COLUMNS) {
    await addForeignKeyIfMissing(knex, column);
  }

  // Backfill obvious 1:1 system links by exact normalized display name.
  await knex.raw(`
    UPDATE equipment_systems es
    SET primary_equipment_id = e.id,
        updated_at = NOW()
    FROM equipment e
    WHERE es.primary_equipment_id IS NULL
      AND LOWER(REGEXP_REPLACE(es.name, '\\s+', ' ', 'g'))
        = LOWER(REGEXP_REPLACE(e.name, '\\s+', ' ', 'g'))
  `);

  // The seeded 110-gallon WaveGuard systems are tank formulations that use
  // the same operational pump/reel assets in the service van. There is no
  // separate tank asset in operational inventory yet, so leave
  // primary_equipment_id/tank_asset_id null and link only known components.
  await knex.raw(`
    WITH pump AS (
      SELECT id
      FROM equipment
      WHERE asset_tag = 'PUMP-001'
         OR (category = 'pump' AND name ILIKE '%Udor%')
      ORDER BY asset_tag NULLS LAST, name
      LIMIT 1
    ),
    reel AS (
      SELECT id
      FROM equipment
      WHERE asset_tag = 'REEL-001'
         OR (category = 'reel' AND name ILIKE '%Hannay%')
      ORDER BY asset_tag NULLS LAST, name
      LIMIT 1
    )
    UPDATE equipment_systems es
    SET pump_asset_id = COALESCE(es.pump_asset_id, (SELECT id FROM pump)),
        reel_asset_id = COALESCE(es.reel_asset_id, (SELECT id FROM reel)),
        updated_at = NOW()
    WHERE es.system_type = 'tank'
      AND es.name ILIKE '110-Gallon%'
      AND (
        es.pump_asset_id IS NULL
        OR es.reel_asset_id IS NULL
      )
  `);
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('equipment_systems'))) return;

  for (const column of ['primary_equipment_id', ...ASSET_COLUMNS]) {
    const constraintName = `equipment_systems_${column}_equipment_fkey`;
    await knex.raw(`ALTER TABLE equipment_systems DROP CONSTRAINT IF EXISTS ${constraintName}`);
  }

  for (const column of ASSET_COLUMNS) {
    await knex.raw(`DROP INDEX IF EXISTS idx_eqs_${column}`);
  }

  if (await knex.schema.hasColumn('equipment_systems', 'primary_equipment_id')) {
    await knex.raw('DROP INDEX IF EXISTS idx_eqs_primary_equipment');
    await knex.schema.alterTable('equipment_systems', (t) => {
      t.dropColumn('primary_equipment_id');
    });
  }
};
