/**
 * Backfill the customer lifecycle:
 *
 *  1) Promote customers stuck at pipeline_stage='new_lead' who are demonstrably
 *     real customers — they have a paid invoice OR a completed service. The
 *     lead-book route's reuse path never promoted pipeline_stage when it reused
 *     an existing linked customer, so booked/paying customers were left labeled
 *     as leads and under-counted in every customer KPI. (Owner-confirmed
 *     criterion: paid OR completed; bookings that are only scheduled and not yet
 *     paid/completed are left as new_lead until they transact.)
 *
 *  2) Fill any missing `member_since` (the app-wide "became a customer" date) on
 *     existing customer-stage rows.
 *
 * pipeline_stage_changed_at and member_since are backdated to the customer's
 * start (member_since, else created_at) so the promoted rows read as the
 * long-standing customers they are, not fresh conversions.
 *
 * Pairs with the forward fixes that keep these populated going forward:
 *   - admin-leads.js  (book route reuse branch promotes stage + member_since)
 *   - admin-customers.js (stage route stamps member_since + churned_at)
 *   - estimate-converter.js (sets member_since on conversion)
 */

exports.up = async function up(knex) {
  // 1) Promote booked/paid customers stuck at new_lead.
  await knex.raw(`
    UPDATE customers
    SET pipeline_stage = 'active_customer',
        member_since = COALESCE(member_since, (created_at AT TIME ZONE 'America/New_York')::date),
        pipeline_stage_changed_at = COALESCE(
          (member_since::timestamp AT TIME ZONE 'America/New_York'),
          pipeline_stage_changed_at,
          created_at)
    WHERE deleted_at IS NULL
      AND active = true
      AND pipeline_stage = 'new_lead'
      AND (
        EXISTS (SELECT 1 FROM invoices i WHERE i.customer_id = customers.id AND i.paid_at IS NOT NULL)
        OR EXISTS (SELECT 1 FROM scheduled_services s WHERE s.customer_id = customers.id AND s.status = 'completed')
        OR EXISTS (SELECT 1 FROM service_records r WHERE r.customer_id = customers.id AND r.status = 'completed')
      )
  `);

  // 2) Fill missing member_since on existing customer-stage rows.
  await knex.raw(`
    UPDATE customers
    SET member_since = (created_at AT TIME ZONE 'America/New_York')::date
    WHERE deleted_at IS NULL
      AND pipeline_stage IN ('active_customer', 'won', 'at_risk')
      AND member_since IS NULL
  `);
};

exports.down = async function down() {
  // One-way data backfill — the prior 'new_lead' stage of promoted rows isn't
  // recoverable, so this is intentionally a no-op.
};
