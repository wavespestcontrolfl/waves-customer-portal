/**
 * One-time backfill for newsletter_subscribers rows still linked to an
 * ARCHIVED customer (customers.deleted_at set) whose OWN normalized email has
 * a LIVE twin profile. The archive route now relinks at archive time
 * (newsletter-subscribers.js relinkSubscribersForEmail); this
 * catches links archived before that landed, so the sender's archived-customer
 * anti-join does not silence multi-property households.
 *
 * Twin selection mirrors the helper exactly: same LOWER(TRIM(email)), canonical
 * live-customer scope (active = true, deleted_at IS NULL, pipeline_stage in
 * CUSTOMER_STAGES — imported, not copied), ordered is_primary_profile DESC
 * NULLS LAST, created_at ASC, id ASC, one winner per EMAIL (DISTINCT ON the
 * normalized email). Only rows whose CURRENT link is an archived customer
 * move; archived links whose email has no live profile are left alone.
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
  // Twin is picked from the SUBSCRIBER's own normalized email (never from the
  // archived customer's current email), and only rows whose CURRENT link is
  // an archived customer move. Mirrors relinkSubscribersForEmail.
  await knex.raw(
    `UPDATE newsletter_subscribers ns
        SET customer_id = t.twin_id, updated_at = NOW()
       FROM (
         SELECT DISTINCT ON (LOWER(TRIM(c.email))) LOWER(TRIM(c.email)) AS email_key, c.id AS twin_id
           FROM customers c
          WHERE c.active = true
            AND c.deleted_at IS NULL
            AND c.pipeline_stage IN (${stagePlaceholders})
          ORDER BY LOWER(TRIM(c.email)), c.is_primary_profile DESC NULLS LAST, c.created_at ASC, c.id ASC
       ) t
      WHERE LOWER(TRIM(ns.email)) = t.email_key
        AND ns.customer_id <> t.twin_id
        AND EXISTS (SELECT 1 FROM customers a WHERE a.id = ns.customer_id AND a.deleted_at IS NOT NULL)`,
    CUSTOMER_STAGES,
  );
};

exports.down = async function down() {
  // Intentional no-op.
};
