/**
 * Lawn protocol v13, atrazine option follow-up. The job card and the plan withhold a dose for a catalog
 * row with no label_verified_at ("Label rate not yet verified — amount withheld"), so the February atrazine
 * bag was selectable but never showed its 40 lb dose.
 *
 * The rate, range, annual limit, turf list and watering sentence on the row were read from the EPA-stamped
 * label (EPA Reg. 10404-94, 2008 notification label, 3.27 to 4.37 lb per 1,000 sq ft, 4 lb ai per acre per
 * year, "must be watered in immediately"). This stamps that read: label_verified_at and label_verified_by,
 * only where label_verified_at is still NULL (a stamp anyone else wrote stays). The SiteOne 702202 bag label
 * itself has not been read; the stamp says so in its verified-by text and the row's own source note.
 *
 * down() clears the stamp only while the row still carries this migration's label_verified_by.
 */
const { NAME } = require('./20261007160000_lawn_v13_atrazine_feb_option');

const VERIFIED_BY = 'label-stamp-2026-10-07: EPA Reg. 10404-94 label read; bag 702202 label not read';

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('products_catalog'))) return;
  await knex('products_catalog').whereRaw('lower(name) = lower(?)', [NAME]).whereNull('label_verified_at')
    .update({ label_verified_at: knex.fn.now(), label_verified_by: VERIFIED_BY, updated_at: knex.fn.now() });
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('products_catalog'))) return;
  await knex('products_catalog').whereRaw('lower(name) = lower(?)', [NAME]).where({ label_verified_by: VERIFIED_BY })
    .update({ label_verified_at: null, label_verified_by: null, updated_at: knex.fn.now() });
};

exports.VERIFIED_BY = VERIFIED_BY;
