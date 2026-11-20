'use strict';

exports.up = async function up(knex) {
  // Acknowledgement resolves the current episode; only a later opposite
  // verified receipt state supersedes it and permits the replacement card.
  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_dispatch_alerts_commercial_prepay_review_current
      ON dispatch_alerts ((payload->>'sourceInvoiceId'))
      WHERE type = 'commercial_prepay_setup_review'
        AND payload->>'superseded_at' IS NULL
  `);
};

exports.down = async function down(knex) {
  await knex.raw('DROP INDEX IF EXISTS idx_dispatch_alerts_commercial_prepay_review_current');
};
