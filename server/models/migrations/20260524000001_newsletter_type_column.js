/**
 * Add newsletter_type to newsletter_sends. Persists the content-engine
 * type so the AI drafter, email chrome, and (future) validation gate
 * know what kind of newsletter this is.
 *
 * Existing rows stay null (legacy / pre-engine). New drafts created
 * via the flagship flow get 'local-weekly-fresh-events'.
 */

exports.up = async function (knex) {
  await knex.schema.alterTable('newsletter_sends', (table) => {
    table.string('newsletter_type', 64).nullable().defaultTo(null);
    table.index(['newsletter_type'], 'idx_newsletter_sends_type');
  });
};

exports.down = async function (knex) {
  await knex.schema.alterTable('newsletter_sends', (table) => {
    table.dropIndex(['newsletter_type'], 'idx_newsletter_sends_type');
    table.dropColumn('newsletter_type');
  });
};
