/**
 * visit_billing_dispositions — Billing Recovery workbench audit trail.
 *
 * The completion flow (admin-dispatch.js) only auto-invoices a completed
 * visit when `(create_invoice_on_complete OR waveguard_tier) AND invoiceAmount>0`.
 * Non-WaveGuard, per-visit-billed customers (e.g. quarterly pest) whose visit
 * carries a price but neither the flag nor a tier therefore complete WITHOUT
 * an invoice — a silent revenue leak (~$3.5k/90d measured 2026-06-19).
 *
 * The Billing Recovery workbench (/admin/billing-recovery) surfaces those
 * uninvoiced-completed visits for human review. Each operator decision is
 * recorded here, one row per visit:
 *   - 'billed'             — operator cut a draft invoice (invoice_id set)
 *   - 'intentionally_free' — operator confirmed the visit is a no-cost type
 *                            (callback, in-window rodent trap check, waived
 *                            inspection, follow-up, appointment service, …)
 *
 * The row both (a) removes the visit from the leak queue so it can't be
 * double-handled, and (b) accrues the structured "intentionally free" labels
 * the schema currently lacks, so over time the two cases become separable
 * without human review. NEVER auto-bill from this table — it is a log of
 * human decisions, not an automation trigger.
 *
 * scheduled_service_id is UNIQUE: a visit can be dispositioned exactly once.
 */
exports.up = async function (knex) {
  await knex.schema.createTable('visit_billing_dispositions', (t) => {
    t.uuid('id').primary().defaultTo(knex.fn.uuid());
    t.uuid('scheduled_service_id').notNullable().unique()
      .references('id').inTable('scheduled_services');
    t.uuid('service_record_id').references('id').inTable('service_records');
    t.string('disposition', 30).notNullable(); // 'billed' | 'intentionally_free'
    t.text('reason');                           // free-text / preset reason for 'intentionally_free'
    t.uuid('invoice_id').references('id').inTable('invoices'); // set when disposition='billed'
    t.uuid('actor_user_id').references('id').inTable('technicians'); // who decided
    t.timestamp('created_at').defaultTo(knex.fn.now());

    t.index('service_record_id');
    t.index('disposition');
    t.index('created_at');
  });
};

exports.down = async function (knex) {
  await knex.schema.dropTableIfExists('visit_billing_dispositions');
};
