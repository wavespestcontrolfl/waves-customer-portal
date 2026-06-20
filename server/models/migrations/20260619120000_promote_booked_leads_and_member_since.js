/**
 * Backfill the customer lifecycle:
 *
 *  1) Promote customers stuck at a pre-sale lead stage (new_lead, contacted,
 *     estimate_sent, …) who are demonstrably real customers — they have a paid
 *     invoice OR a completed service. The lead-book route's reuse path never
 *     promoted pipeline_stage when it reused an existing linked customer, so
 *     booked/paying customers were left labeled as leads and under-counted in
 *     every customer KPI. (Owner-confirmed criterion: paid OR completed;
 *     bookings that are only scheduled and not yet paid/completed are left as
 *     leads until they transact. Deliberate end-states — churned/lost/dormant —
 *     are NOT promoted from old transactions.)
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
    UPDATE customers AS c
    SET pipeline_stage = 'active_customer',
        -- Promotion = they became a customer; drop any stale churn metadata.
        churned_at = NULL,
        churn_reason = NULL,
        -- member_since = the CONVERSION date (first paid invoice / completed
        -- service), not created_at (lead intake) — these rows were leads, so an
        -- existing member_since is an intake date. Backdate stage-change to match
        -- so they read as established customers, not fresh converts.
        member_since = COALESCE(t.first_txn, c.member_since, (c.created_at AT TIME ZONE 'America/New_York')::date),
        pipeline_stage_changed_at = COALESCE(
          (COALESCE(t.first_txn, c.member_since)::timestamp AT TIME ZONE 'America/New_York'),
          c.pipeline_stage_changed_at,
          c.created_at)
    FROM (
      SELECT cc.id,
        LEAST(
          (SELECT MIN((COALESCE(i.paid_at, i.created_at) AT TIME ZONE 'America/New_York')::date) FROM invoices i WHERE i.customer_id = cc.id AND (i.paid_at IS NOT NULL OR i.status = 'paid')),
          (SELECT MIN(s.scheduled_date) FROM scheduled_services s WHERE s.customer_id = cc.id AND s.status = 'completed'),
          (SELECT MIN(r.service_date) FROM service_records r WHERE r.customer_id = cc.id AND r.status = 'completed')
        ) AS first_txn
      FROM customers cc
      WHERE cc.deleted_at IS NULL AND cc.active = true
        AND cc.pipeline_stage NOT IN ('active_customer', 'won', 'at_risk', 'churned', 'lost', 'dormant')
    ) AS t
    WHERE c.id = t.id
      AND c.deleted_at IS NULL
      AND c.active = true
      -- Any pre-sale lead stage (not just new_lead) — a paying customer could
      -- be stuck at contacted/estimate_sent/etc. EXCLUDE the deliberate
      -- end-states (churned/lost/dormant): an old payment must not resurrect a
      -- relationship that was intentionally ended.
      AND c.pipeline_stage NOT IN ('active_customer', 'won', 'at_risk', 'churned', 'lost', 'dormant')
      AND (
        -- paid_at OR status='paid' — the app treats status='paid' as paid even
        -- when paid_at is null (annual-prepay-renewals.js).
        EXISTS (SELECT 1 FROM invoices i WHERE i.customer_id = c.id AND (i.paid_at IS NOT NULL OR i.status = 'paid'))
        OR EXISTS (SELECT 1 FROM scheduled_services s WHERE s.customer_id = c.id AND s.status = 'completed')
        OR EXISTS (SELECT 1 FROM service_records r WHERE r.customer_id = c.id AND r.status = 'completed')
      )
  `);

  // 2) Fill missing member_since on existing customer-stage rows. Prefer the
  // stage-change timestamp (~when they converted) over created_at (the lead
  // intake date), so tenure/member-since isn't skewed early for leads that
  // converted later.
  await knex.raw(`
    UPDATE customers
    SET member_since = COALESCE(
          (pipeline_stage_changed_at AT TIME ZONE 'America/New_York')::date,
          (created_at AT TIME ZONE 'America/New_York')::date)
    WHERE deleted_at IS NULL
      AND pipeline_stage IN ('active_customer', 'won', 'at_risk')
      AND member_since IS NULL
  `);
};

exports.down = async function down() {
  // One-way data backfill — the prior 'new_lead' stage of promoted rows isn't
  // recoverable, so this is intentionally a no-op.
};
