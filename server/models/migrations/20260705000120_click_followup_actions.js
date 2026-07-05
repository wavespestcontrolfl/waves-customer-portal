/**
 * Outbound-comms click tracking, part B: the clicked-but-didn't-book action
 * queue.
 *
 * One row per short-link click the click-followup cron decided to act on
 * (services/click-followup.js). The row is BOTH the audit trail and the atomic
 * claim: the cron inserts status='pending' before drafting, and the partial
 * unique indexes below guarantee at most ONE open (pending|drafted) action per
 * customer / per lead at a time — two overlapping runs, or two clicks by the
 * same person on different links, collapse to a single nudge draft.
 *
 * Status lifecycle:
 *   pending   — claimed by the cron, draft not written yet (transient)
 *   drafted   — a message_drafts row (status='pending', intent='click_followup')
 *               awaits owner approval in /admin/drafts; draft_id points at it
 *   dismissed — cron decided never to act on this click (terminal estimate,
 *               suppressed recipient, cadence nudge already imminent, ...)
 *   converted — the contact converted (paid invoice / live booking / customer
 *               pipeline stage) — no nudge needed; converted_at stamps when
 *   expired   — stale open action swept after CLICK_ACTION_TTL so the partial
 *               unique guard frees the contact for future clicks
 *
 * NOTHING in this table sends anything. The only path to a customer is the
 * owner approving the linked draft in /admin/drafts.
 */

exports.up = async function up(knex) {
  if (await knex.schema.hasTable('click_followup_actions')) return;
  await knex.schema.createTable('click_followup_actions', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('short_code_id').notNullable()
      .references('id').inTable('short_codes').onDelete('CASCADE');
    t.uuid('customer_id').references('id').inTable('customers').onDelete('SET NULL');
    t.uuid('lead_id').references('id').inTable('leads').onDelete('SET NULL');
    // Loose back-pointer to the row the clicked link resolved to (mirrors
    // short_codes.entity_type/entity_id — 'estimates' for this lane).
    t.string('entity_type', 64);
    t.uuid('entity_id');
    t.timestamp('clicked_at');
    t.string('status', 20).notNullable().defaultTo('pending');
    t.uuid('draft_id').references('id').inTable('message_drafts').onDelete('SET NULL');
    t.timestamp('converted_at');
    t.timestamps(true, true);
    t.index(['status']);
    t.index(['short_code_id']);
    t.index(['entity_type', 'entity_id']);
  });

  await knex.raw(
    `ALTER TABLE click_followup_actions
       ADD CONSTRAINT click_followup_actions_status_check
       CHECK (status IN ('pending','drafted','dismissed','converted','expired'))`
  );

  // One OPEN action per contact at a time. Partial (pending|drafted only) so
  // terminal rows (dismissed/converted/expired) never block a future action.
  await knex.raw(
    `CREATE UNIQUE INDEX click_followup_actions_open_customer_uniq
       ON click_followup_actions (customer_id)
       WHERE customer_id IS NOT NULL AND status IN ('pending','drafted')`
  );
  await knex.raw(
    `CREATE UNIQUE INDEX click_followup_actions_open_lead_uniq
       ON click_followup_actions (lead_id)
       WHERE lead_id IS NOT NULL AND status IN ('pending','drafted')`
  );
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('click_followup_actions');
};
