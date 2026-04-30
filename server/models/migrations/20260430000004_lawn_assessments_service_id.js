// Adds nullable service_id FK on lawn_assessments → scheduled_services.
//
// Today the assessment flow is customer-centred — POST /assess only
// takes { customerId, photos } — but the WaveGuard treatment plan
// engine (Phase 2) needs each assessment to be anchored to the exact
// service visit it ran during. The dispatch completion endpoint
// (admin-dispatch.js:307) resolves :serviceId against
// scheduled_services.id, so this column points at the same canonical
// service entity to keep the chain coherent:
//
//   scheduled_service → lawn_assessment → treatment_plan
//                                       → mix_batch
//                                       → service completion (service_record / service_products)
//
// Nullable on purpose. Historical assessments have no service link,
// and the panel still falls back to a customer-only picker on days
// with no scheduled services. NOT NULL gets considered later, after
// every creation path has been audited.
//
// ON DELETE SET NULL — assessments are historical records and should
// outlive a deleted scheduled_service row. ON UPDATE CASCADE for the
// uuid PK case (currently no-op since service ids are immutable, but
// matches the convention used elsewhere in this schema).
//
// Index on service_id so the future plan engine can look up the
// assessment for a given service in O(1) without scanning the table.
//
// Idempotent via hasColumn guard so re-runs on environments that may
// have hand-patched the column don't error.

exports.up = async function (knex) {
  if (!(await knex.schema.hasTable('lawn_assessments'))) return;
  if (await knex.schema.hasColumn('lawn_assessments', 'service_id')) return;

  await knex.schema.alterTable('lawn_assessments', (t) => {
    t.uuid('service_id')
      .nullable()
      .references('id')
      .inTable('scheduled_services')
      .onDelete('SET NULL')
      .onUpdate('CASCADE');
    t.index('service_id', 'idx_lawn_assessments_service_id');
  });
};

exports.down = async function (knex) {
  if (!(await knex.schema.hasTable('lawn_assessments'))) return;
  if (!(await knex.schema.hasColumn('lawn_assessments', 'service_id'))) return;

  await knex.schema.alterTable('lawn_assessments', (t) => {
    t.dropIndex('service_id', 'idx_lawn_assessments_service_id');
    t.dropForeign('service_id');
    t.dropColumn('service_id');
  });
};
