/**
 * Trusted quote-flow flag for post-confirmation lead automation.
 *
 * Public newsletter signup accepts a source value from the client, so source
 * alone cannot decide whether confirmation should enqueue a promotional
 * quote-lead automation. Only the server-side quote route sets this flag.
 */

exports.up = async function (knex) {
  const hasColumn = await knex.schema.hasColumn('newsletter_subscribers', 'quote_lead_automation_pending');
  if (!hasColumn) {
    await knex.schema.alterTable('newsletter_subscribers', (t) => {
      t.boolean('quote_lead_automation_pending').notNullable().defaultTo(false);
    });
  }
};

exports.down = async function (knex) {
  const hasColumn = await knex.schema.hasColumn('newsletter_subscribers', 'quote_lead_automation_pending');
  if (hasColumn) {
    await knex.schema.alterTable('newsletter_subscribers', (t) => {
      t.dropColumn('quote_lead_automation_pending');
    });
  }
};
