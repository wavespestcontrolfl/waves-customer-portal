/**
 * Lead-only automation enrollment dedupe.
 *
 * automation_enrollments.customer_id is nullable, so the existing unique
 * (template_key, customer_id) does not prevent duplicate active lead rows.
 * Customer-linked enrollments keep using that constraint; lead-only rows are
 * deduped by template + normalized email.
 */
exports.up = async function (knex) {
  await knex.raw(`
    WITH ranked AS (
      SELECT id,
             row_number() OVER (
               PARTITION BY template_key, lower(email)
               ORDER BY updated_at DESC NULLS LAST, enrolled_at DESC NULLS LAST, id DESC
             ) AS rn
      FROM automation_enrollments
      WHERE customer_id IS NULL
        AND email IS NOT NULL
        AND status = 'active'
    )
    UPDATE automation_enrollments
    SET status = 'cancelled',
        updated_at = NOW()
    WHERE id IN (SELECT id FROM ranked WHERE rn > 1)
  `);

  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS uniq_automation_enrollments_lead_email_active
      ON automation_enrollments (template_key, lower(email))
      WHERE customer_id IS NULL
        AND email IS NOT NULL
        AND status = 'active'
  `);
};

exports.down = async function (knex) {
  await knex.raw('DROP INDEX IF EXISTS uniq_automation_enrollments_lead_email_active');
};
