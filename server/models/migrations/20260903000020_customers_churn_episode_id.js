// The churn EPISODE identifier (cancel-flow lock lane, split item 1 of
// #3758). The end-of-coverage side effects of a decided prepaid term — the
// dated termite retrieval task and the end-of-term confirmation — are sent
// once per (term, churn episode), never per request: a repeat commit on the
// same decided term after the admin latch's 24h echo window opens a NEW
// request, while a won-back customer churning the same still-current term
// again must get fresh side effects. Inferring the episode from
// churned_at (a DATE) + the stage + request age leaked in six review rounds
// (same-day win-back and re-churn, booked rows left at a lead stage with a
// stale churned_at, acceptances left open across the boundary), so the
// episode is PERSISTED instead:
//   - minted by the cancellation processor on a whole-account churn when
//     the row carries no stamp (never re-minted on a repeat run);
//   - cleared by every path that clears churned_at (customer-stages
//     lifecycle stamps + promoteCustomerOnBooking, the lead booking route,
//     proposal win, estimate conversion, the Intelligence Bar stage edit) —
//     one rule, the same sites;
//   - carried on the cancellation request (metadata.cancel_plan) and case
//     snapshot at processing time; a repair reads the request's own stamp.
// No backfill: a row churned before this shipped mints on its next
// processor run (its pre-deploy request-keyed sends are not found by the
// new key — at most one extra end-of-term confirmation, once).
exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('customers'))) return;
  if (await knex.schema.hasColumn('customers', 'churn_episode_id')) return;
  await knex.schema.alterTable('customers', (table) => {
    table.uuid('churn_episode_id').nullable();
  });
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('customers'))) return;
  if (!(await knex.schema.hasColumn('customers', 'churn_episode_id'))) return;
  await knex.schema.alterTable('customers', (table) => {
    table.dropColumn('churn_episode_id');
  });
};
