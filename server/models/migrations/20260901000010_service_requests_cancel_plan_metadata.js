/**
 * Durable retry state for admin cancel-plan acceptances (cancel-flow C3).
 *
 * A partial cancellation's acceptance is the repair key, and two of its
 * facts must survive everything downstream failing:
 *   - the canonical SCOPE SET (sorted family keys), so another operator,
 *     the other surface (Customer 360 ↔ Intelligence Bar), or a reordered
 *     family list still lands the retry on the same request — matching on
 *     the presentation subject was operator- and order-fragile;
 *   - the accepted fee WAIVER, which previously lived only on the
 *     cancellation case snapshot — a run that lost BOTH a fee side effect
 *     and its case write would let a default-unchecked retry charge the
 *     fee the operator waived.
 *
 * `metadata` is written at acceptance time (before any processing) by the
 * admin cancel-plan commit; other request writers leave it NULL.
 */
exports.up = async function up(knex) {
  if (!(await knex.schema.hasColumn('service_requests', 'metadata'))) {
    await knex.schema.alterTable('service_requests', (t) => {
      t.jsonb('metadata');
    });
  }
};

exports.down = async function down(knex) {
  if (await knex.schema.hasColumn('service_requests', 'metadata')) {
    await knex.schema.alterTable('service_requests', (t) => {
      t.dropColumn('metadata');
    });
  }
};
