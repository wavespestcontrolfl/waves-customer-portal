/**
 * collection_cases — one row per proposed/observed billing-follow-up case.
 *
 * PR A of the collections lane is POLICY + SHADOW ONLY: rows in state
 * 'shadow' are written by the shadow sweep (GATE_COLLECTIONS_SHADOW) purely
 * as observational proposals for the admin bell. No dialing, no customer
 * contact of any kind originates from this table in this PR.
 *
 * Money convention: eligible_balance_snapshot is INTEGER CENTS (the
 * invoiceAmountDue cents-authoritative convention) — never a float dollars
 * column.
 */

exports.up = async function up(knex) {
  if (await knex.schema.hasTable('collection_cases')) return;
  await knex.schema.createTable('collection_cases', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('customer_id').notNullable().references('id').inTable('customers').onDelete('CASCADE');
    // The open self-pay invoice ids this case covers, as a JSON array of ids.
    t.jsonb('eligible_invoice_ids').notNullable().defaultTo('[]');
    // INTEGER CENTS (invoiceAmountDue convention) at proposal time.
    t.integer('eligible_balance_snapshot').notNullable().defaultTo(0);
    t.date('earliest_due_date');
    t.integer('case_version').notNullable().defaultTo(1);
    // { source, evidence_ref, evidence_at } from the consent-provenance resolver.
    t.jsonb('consent_evidence');
    // Reassigned-number (RND) check result — populated by PR B / manual runs,
    // never by this PR (which only records the REQUIREMENT as a denial).
    t.jsonb('rnd_check');
    t.timestamp('proposal_created_at', { useTz: true });
    t.uuid('approved_by');
    t.timestamp('approved_at', { useTz: true });
    t.timestamp('approval_expires_at', { useTz: true });
    // proposed | approved | expired | cancelled | held | shadow
    t.string('current_state', 20).notNullable().defaultTo('proposed');
    t.text('hold_reason');
    t.timestamp('next_eligible_at', { useTz: true });
    // `collections:{customer_id}:{case_version}:{tier}` — dupe guard for the
    // shadow sweep's upsert (and PR B's proposal mint).
    t.string('idempotency_key', 120).notNullable().unique();
    t.timestamps(true, true);

    t.index('customer_id');
  });

  // Only the live states are ever polled; keep the index partial so the
  // terminal/shadow bulk never bloats it.
  await knex.raw(`
    CREATE INDEX collection_cases_live_state_idx
      ON collection_cases (current_state)
      WHERE current_state IN ('proposed', 'approved')
  `);
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('collection_cases');
};
