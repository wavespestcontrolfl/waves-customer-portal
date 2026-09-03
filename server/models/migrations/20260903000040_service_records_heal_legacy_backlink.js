/**
 * Heal the legacy service_records → scheduled_services backlink.
 *
 * Visits completed before 20260427000007 have service_records rows with a
 * NULL scheduled_service_id; every FK-only reader (the dispatch day / week /
 * list feeds' has_service_record, Billing Recovery's leak join) sees them
 * as status-only completions and offers a "Closeout owed" resume that would
 * re-run /complete. The runtime already FK-heals such a record when a
 * completion edit touches it through job-costing's resolveServiceRecord
 * (FK first, then the (customer_id, service_date, service_type) soft-join
 * with ambiguity detection); this stamps the same resolution up front, ONLY
 * where the tuple is unique on both sides — exactly one unlinked record and
 * exactly one completed visit. Ambiguous tuples are left NULL on purpose
 * (stamping the wrong visit is worse than an owed badge). Idempotent; prod
 * has 4 such rows (read-only check 2026-09-03). No down: a healed backlink
 * is correct data, and the pre-heal state is not distinguishable afterwards.
 */
exports.up = async function up(knex) {
  if (!(await knex.schema.hasColumn('service_records', 'scheduled_service_id'))) return;
  await knex.raw(`
    UPDATE service_records sr
    SET scheduled_service_id = ss.id
    FROM scheduled_services ss
    WHERE sr.scheduled_service_id IS NULL
      AND sr.customer_id = ss.customer_id
      AND sr.service_date = ss.scheduled_date
      AND sr.service_type = ss.service_type
      AND ss.status = 'completed'
      AND (SELECT count(*) FROM service_records sr2
            WHERE sr2.scheduled_service_id IS NULL
              AND sr2.customer_id = ss.customer_id
              AND sr2.service_date = ss.scheduled_date
              AND sr2.service_type = ss.service_type) = 1
      AND (SELECT count(*) FROM scheduled_services ss2
            WHERE ss2.customer_id = ss.customer_id
              AND ss2.scheduled_date = ss.scheduled_date
              AND ss2.service_type = ss.service_type
              AND ss2.status = 'completed') = 1
  `);
};

exports.down = async function down() {};
