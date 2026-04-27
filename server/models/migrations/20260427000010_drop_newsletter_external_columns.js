/**
 * Drops the Beehiiv-import scaffolding from newsletter_sends. The
 * /api/admin/newsletter/import-beehiiv route + the History tab "Import
 * from Beehiiv" button were removed in the same change, and all sends
 * now route through the in-house pipeline (newsletter-sender.js) — so
 * external_post_id, external_source, external_web_url have no remaining
 * writers or readers.
 *
 * The down migration mirrors 20260424000004 (the migration this
 * reverses) so a future Beehiiv re-introduction can roll back to the
 * pre-rip-out shape if needed.
 */

exports.up = async function (knex) {
  await knex.schema.alterTable('newsletter_sends', (t) => {
    t.dropUnique(['external_post_id']);
    t.dropColumn('external_post_id');
    t.dropColumn('external_source');
    t.dropColumn('external_web_url');
  });
};

exports.down = async function (knex) {
  await knex.schema.alterTable('newsletter_sends', (t) => {
    t.string('external_post_id').unique();
    t.string('external_source');
    t.text('external_web_url');
  });
};
