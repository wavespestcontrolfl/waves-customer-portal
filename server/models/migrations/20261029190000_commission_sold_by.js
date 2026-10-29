/**
 * Commission "Sold by" (owner ruling 2026-10-29, D5 part 3b-1 of the first-technician pay plan:
 * "the technician's flag, checked by the truck GPS, fills in 'Sold by'"). Dark behind
 * GATE_COMMISSION_SOLD_BY; additive. This change records WHO sold. The commission ledger that
 * pays it is part 3b-2 and reads only estimates.sold_by_technician_id.
 *
 * leads: gps_verified (false on every existing lead) and gps_check (jsonb; null = no check ran).
 * gps_check keys: result ('verified' | 'no_gps_arrival' | 'no_truck' | 'no_truck_position' |
 * 'stale_truck_position' | 'address_not_found' | 'too_far'), mode ('customer' | 'prospect'),
 * scheduled_service_id, distance_m, radius_m, truck_reported_at, checked_at. The truck's raw
 * latitude and longitude are never stored: distance only.
 *
 * estimates: sold_by_technician_id (the seller), sold_by_source ('flag' = a GPS-verified field
 * flag, 'office' = an admin chose the seller, 'cleared' = an admin chose no one, so the flag
 * never refills it), sold_by_lead_id (the flag), sold_by_set_by (the admin, for 'office' and
 * 'cleared') and sold_by_set_at. created_by_technician_id is the admin who saved the form; it is
 * NOT the seller and is left alone.
 *
 * A recorded seller cannot be deleted (plain foreign key: payroll reads the seller). A flag's lead
 * can: its link empties and the estimate keeps source 'flag' and the seller.
 */
exports.up = async function up(knex) {
  await knex.raw(`ALTER TABLE leads
    ADD COLUMN IF NOT EXISTS gps_verified boolean NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS gps_check jsonb NULL`);

  await knex.raw(`ALTER TABLE estimates
    ADD COLUMN IF NOT EXISTS sold_by_technician_id uuid NULL REFERENCES technicians(id),
    ADD COLUMN IF NOT EXISTS sold_by_source varchar(10) NULL,
    ADD COLUMN IF NOT EXISTS sold_by_lead_id uuid NULL REFERENCES leads(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS sold_by_set_by uuid NULL REFERENCES technicians(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS sold_by_set_at timestamptz NULL`);

  await knex.raw(`ALTER TABLE estimates
    ADD CONSTRAINT estimates_sold_by_source_check CHECK (sold_by_source IS NULL OR sold_by_source IN ('flag', 'office', 'cleared')),
    ADD CONSTRAINT estimates_sold_by_shape_check CHECK (CASE sold_by_source
      WHEN 'flag' THEN sold_by_technician_id IS NOT NULL
      WHEN 'office' THEN sold_by_technician_id IS NOT NULL
      WHEN 'cleared' THEN sold_by_technician_id IS NULL
      ELSE sold_by_technician_id IS NULL AND sold_by_lead_id IS NULL
    END)`);

  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_estimates_sold_by_technician
    ON estimates (sold_by_technician_id) WHERE sold_by_technician_id IS NOT NULL`);
};

exports.down = async function down(knex) {
  await knex.raw('DROP INDEX IF EXISTS idx_estimates_sold_by_technician');
  await knex.raw(`ALTER TABLE estimates
    DROP CONSTRAINT IF EXISTS estimates_sold_by_shape_check,
    DROP CONSTRAINT IF EXISTS estimates_sold_by_source_check`);
  await knex.raw(`ALTER TABLE estimates
    DROP COLUMN IF EXISTS sold_by_set_at,
    DROP COLUMN IF EXISTS sold_by_set_by,
    DROP COLUMN IF EXISTS sold_by_lead_id,
    DROP COLUMN IF EXISTS sold_by_source,
    DROP COLUMN IF EXISTS sold_by_technician_id`);
  await knex.raw('ALTER TABLE leads DROP COLUMN IF EXISTS gps_check, DROP COLUMN IF EXISTS gps_verified');
};
