/**
 * One-time backfill for newsletter_subscribers rows still linked to an
 * ARCHIVED customer (customers.deleted_at set) that has a LIVE twin sharing
 * the normalized email. The archive route now relinks at archive time
 * (newsletter-subscribers.js relinkSubscribersFromArchivedCustomer); this
 * catches links archived before that landed, so the sender's archived-customer
 * anti-join does not silence multi-property households.
 *
 * Twin selection mirrors the helper exactly: same LOWER(TRIM(email)), canonical
 * live-customer scope (active = true, deleted_at IS NULL, pipeline_stage in
 * CUSTOMER_STAGES — imported, not copied), ordered is_primary_profile DESC
 * NULLS LAST, created_at ASC, id ASC, one twin per archived customer
 * (DISTINCT ON). Archived links with no live twin are left alone.
 *
 * Data-only; down is a no-op (relinking back to an archived profile is never
 * desirable).
 */
const { CUSTOMER_STAGES } = require('../../services/customer-stages');

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('newsletter_subscribers'))) return;
  if (!(await knex.schema.hasTable('customers'))) return;
  if (!(await knex.schema.hasColumn('customers', 'deleted_at'))) return;
  if (!(await knex.schema.hasColumn('customers', 'is_primary_profile'))) return;

  const stagePlaceholders = CUSTOMER_STAGES.map(() => '?').join(', ');
  await knex.raw(
    `UPDATE newsletter_subscribers ns
        SET customer_id = t.twin_id, updated_at = NOW()
       FROM (
         SELECT DISTINCT ON (a.id) a.id AS archived_id, c.id AS twin_id
           FROM customers a
           JOIN customers c
             ON LOWER(TRIM(c.email)) = LOWER(TRIM(a.email))
            AND c.id <> a.id
          WHERE a.deleted_at IS NOT NULL
            AND c.active = true
            AND c.deleted_at IS NULL
            AND c.pipeline_stage IN (${stagePlaceholders})
            AND EXISTS (SELECT 1 FROM newsletter_subscribers x WHERE x.customer_id = a.id)
          ORDER BY a.id, c.is_primary_profile DESC NULLS LAST, c.created_at ASC, c.id ASC
       ) t
      WHERE ns.customer_id = t.archived_id`,
    CUSTOMER_STAGES,
  );
};

exports.down = async function down() {
  // Intentional no-op.
};
