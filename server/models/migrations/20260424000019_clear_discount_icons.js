/**
 * Clear the `icon` column on all discount rows.
 *
 * Originally the discount seed set a decorative emoji per discount
 * (🥉 Bronze, 🎖 Military, ❤ Family & Friends, etc.) which bled into
 * every surface that rendered `d.icon`: the estimator preset picker,
 * admin discount management grid, customer-facing estimate labels,
 * PDF invoices. Operator preference is plain professional text — no
 * emojis on customer documents.
 *
 * This migration empties the column for existing rows (''). The
 * column itself stays (seed data + future API writes still work), and
 * renders of `d.icon` safely produce nothing.
 *
 * `down` does NOT restore the original emojis — that history lives in
 * the seed migration files if we ever want them back.
 */
exports.up = async function (knex) {
  if (!(await knex.schema.hasTable('discounts'))) return;
  if (!(await knex.schema.hasColumn('discounts', 'icon'))) return;
  await knex('discounts').update({ icon: '', updated_at: new Date() });
};

exports.down = async function () {
  // no-op — clearing emojis is intentional and reversible by reseeding
};
