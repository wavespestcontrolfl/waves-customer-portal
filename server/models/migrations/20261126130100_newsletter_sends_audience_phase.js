/**
 * newsletter_sends.audience_phase: which phase of the weekly events email's first-readers step an
 * issue used (owner approved 2026-11-26). 'warm' = only readers who opened a Waves email in the
 * last 90 days; 'all' = every active reader. NULL for every issue that has no phase (every send
 * before this column, and every type other than the weekly flagship). Set when the weekly draft
 * is built (services/newsletter-weekly-audience.js) and read by the sender, which refuses a
 * weekly issue with no phase. Additive and idempotent; down() drops only what this adds.
 */

exports.up = async function up(knex) {
  if (!(await knex.schema.hasColumn('newsletter_sends', 'audience_phase'))) {
    await knex.schema.alterTable('newsletter_sends', (t) => {
      t.text('audience_phase').nullable();
    });
  }
  await knex.raw('ALTER TABLE newsletter_sends DROP CONSTRAINT IF EXISTS chk_newsletter_sends_audience_phase');
  await knex.raw(`
    ALTER TABLE newsletter_sends
    ADD CONSTRAINT chk_newsletter_sends_audience_phase
    CHECK (audience_phase IS NULL OR audience_phase IN ('warm', 'all'))
  `);
};

exports.down = async function down(knex) {
  await knex.raw('ALTER TABLE newsletter_sends DROP CONSTRAINT IF EXISTS chk_newsletter_sends_audience_phase');
  if (await knex.schema.hasColumn('newsletter_sends', 'audience_phase')) {
    await knex.schema.alterTable('newsletter_sends', (t) => {
      t.dropColumn('audience_phase');
    });
  }
};
