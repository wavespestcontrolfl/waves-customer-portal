/**
 * Add blog cross-publish fields to newsletter_sends.
 *
 * blog_convertible: admin marks a sent newsletter as blog-worthy.
 * blog_exported_at: timestamp when the newsletter was exported to
 *   blog-ready markdown format via the admin export endpoint.
 */

exports.up = async function (knex) {
  await knex.schema.alterTable('newsletter_sends', (table) => {
    table.boolean('blog_convertible').notNullable().defaultTo(false);
    table.timestamp('blog_exported_at', { useTz: true }).nullable();
  });
};

exports.down = async function (knex) {
  await knex.schema.alterTable('newsletter_sends', (table) => {
    table.dropColumn('blog_exported_at');
    table.dropColumn('blog_convertible');
  });
};
