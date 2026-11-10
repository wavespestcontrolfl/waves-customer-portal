'use strict';

/**
 * estimates.sold_by_source gets a fourth value, 'creator' (owner 2026-11-05: "Sold by = the creator"): the
 * W-2 technician who made the estimate with the technician estimate tool (services/estimate-sold-by.js
 * creditCreator). Like 'flag' and 'office' it needs a seller; it has no lead. Replaces the two CHECKs of
 * 20261029190000_commission_sold_by.js in one ALTER (that file is not edited).
 *
 * down restores the old two CHECKs and refuses while a 'creator' row exists: they would fail the old
 * constraint, and clearing a seller is the owner's call, not a rollback's.
 */
const OLD_SOURCE = "sold_by_source IS NULL OR sold_by_source IN ('flag', 'office', 'cleared')";
const NEW_SOURCE = "sold_by_source IS NULL OR sold_by_source IN ('flag', 'office', 'cleared', 'creator')";
const SHAPE = (creator) => `CASE sold_by_source
      WHEN 'flag' THEN sold_by_technician_id IS NOT NULL
      WHEN 'office' THEN sold_by_technician_id IS NOT NULL${creator ? `
      WHEN 'creator' THEN sold_by_technician_id IS NOT NULL` : ''}
      WHEN 'cleared' THEN sold_by_technician_id IS NULL
      ELSE sold_by_technician_id IS NULL AND sold_by_lead_id IS NULL
    END`;

const swap = (knex, source, shape) => knex.raw(`ALTER TABLE estimates
    DROP CONSTRAINT IF EXISTS estimates_sold_by_shape_check,
    DROP CONSTRAINT IF EXISTS estimates_sold_by_source_check,
    ADD CONSTRAINT estimates_sold_by_source_check CHECK (${source}),
    ADD CONSTRAINT estimates_sold_by_shape_check CHECK (${shape})`);

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('estimates')) || !(await knex.schema.hasColumn('estimates', 'sold_by_source'))) return;
  await swap(knex, NEW_SOURCE, SHAPE(true));
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('estimates')) || !(await knex.schema.hasColumn('estimates', 'sold_by_source'))) return;
  const { rows } = await knex.raw("SELECT count(*)::int AS n FROM estimates WHERE sold_by_source = 'creator'");
  if (rows[0].n > 0) {
    throw new Error(`Cannot roll back: ${rows[0].n} estimate(s) have Sold by = creator. Clear or reassign them first.`);
  }
  await swap(knex, OLD_SOURCE, SHAPE(false));
};
