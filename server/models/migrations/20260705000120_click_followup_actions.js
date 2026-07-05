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
 * short_code_click_id ties the action to the SPECIFIC click that triggered it
 * — the cron's candidate anti-join is per click, not per code, so a fresh
 * re-click after a terminal outcome (dismissed/converted/expired) re-qualifies
 * instead of being shadowed forever by the old action row.
 *
 * Status lifecycle:
 *   pending   — claimed by the cron, draft not written yet (transient)
 *   drafted   — a message_drafts row (status='pending', intent='click_followup')
 *               awaits owner approval in /admin/drafts; draft_id points at it
 *   sent      — the owner approved/revised the linked draft and the nudge
 *               went out (admin-drafts success path). Terminal for the
 *               open-claim guards — review is complete, so a later click by
 *               the same contact re-qualifies — but distinguishable from
 *               dismissed in outcome telemetry
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
    // The specific click that triggered this action — the cron's candidate
    // anti-join key. Nullable (SET NULL) so a pruned click row never strands
    // the audit trail.
    t.uuid('short_code_click_id')
      .references('id').inTable('short_code_clicks').onDelete('SET NULL');
    t.uuid('customer_id').references('id').inTable('customers').onDelete('SET NULL');
    t.uuid('lead_id').references('id').inTable('leads').onDelete('SET NULL');
    // Normalized last-10 digits of the contact's phone — the dedupe key of
    // last resort for contactless estimates (no customer, no resolvable
    // lead). Persisted so the one-open-action guard holds ACROSS cron ticks,
    // not just within a run: the same phone clicking a DIFFERENT estimate
    // tomorrow must not mint a second open draft.
    t.string('contact_phone', 20);
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
    t.index(['short_code_click_id']);
    t.index(['entity_type', 'entity_id']);
  });

  await knex.raw(
    `ALTER TABLE click_followup_actions
       ADD CONSTRAINT click_followup_actions_status_check
       CHECK (status IN ('pending','drafted','sent','dismissed','converted','expired'))`
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
  // One open action per PHONE too — same reachable human regardless of which
  // customer/lead/estimate row the click resolved through.
  await knex.raw(
    `CREATE UNIQUE INDEX click_followup_actions_open_phone_uniq
       ON click_followup_actions (contact_phone)
       WHERE contact_phone IS NOT NULL AND status IN ('pending','drafted')`
  );
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('click_followup_actions');
};
