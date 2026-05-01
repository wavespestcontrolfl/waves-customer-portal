// Adds per-row claim markers used by the scheduled-send crons in
// services/scheduler.js to avoid duplicate dispatch when more than one
// app instance runs the tick. Each cron's first action is an atomic
// UPDATE…RETURNING that stamps `*_claim_at = now()` only where it's
// either NULL or older than the 10-minute TTL — so a worker crash
// mid-send leaves the row reclaimable on the next tick instead of
// stuck forever.
exports.up = async (knex) => {
  await knex.schema.alterTable('invoices', (t) => {
    t.timestamp('send_claim_at').nullable();
  });
  await knex.schema.alterTable('scheduled_services', (t) => {
    t.timestamp('completion_sms_claim_at').nullable();
  });
};

exports.down = async (knex) => {
  await knex.schema.alterTable('invoices', (t) => {
    t.dropColumn('send_claim_at');
  });
  await knex.schema.alterTable('scheduled_services', (t) => {
    t.dropColumn('completion_sms_claim_at');
  });
};
