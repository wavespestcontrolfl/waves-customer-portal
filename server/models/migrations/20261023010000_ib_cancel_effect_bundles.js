/**
 * ib_cancel_effect_bundles — the approved follow-on work of an Intelligence Bar cancel card, saved IN the cancel
 * transaction (GATE_IB_CANCEL_WITH_EFFECTS, follow-up to #6377; owner ruling 2026-10-22, option A).
 *
 * The bar's approved cancel commits the status change first and then, after the commit, voids the pinned invoices,
 * reverses the pinned inspection credits, sends the approved text and cancels the approved linked visits. A process
 * exit between the commit and that work left nothing to finish it. The writer (services/ib-cancel-effect-bundles.js,
 * called from the cancel handler's own transaction) saves exactly what the card approved, so it commits or rolls back
 * with the cancel. The request marks the row complete when it finishes; the recovery sweep
 * (services/scheduler.js, every 5 minutes) finishes a row still pending after 10 minutes, through the same pinned
 * code paths, and reports what it did or skipped to the office. A row older than 24 hours is only reported.
 *
 * Shape decisions (a pushed migration is frozen):
 *  - pending_action_id is UNIQUE (one bundle per approved card; NULL allowed and distinct for a caller with no card id).
 *    It is the ib_pending_actions id. NO foreign key: pending actions expire and are cleaned up independently.
 *  - scheduled_service_id is indexed, NOT unique: a visit can be cancelled, restored and cancelled again by the bar,
 *    and the old bundle must stay readable. NO foreign key, and no customer_id column at all, so nothing here can block
 *    a customer merge or delete (a merge moves visits; this table never needs to follow). The sweep deletes finished
 *    rows after 90 days, since approved_notice holds the approved text bodies.
 *  - status: pending (open work) | complete (the request finished it) | recovered (the sweep finished it) |
 *    expired (past the 24 hour stop, or out of attempts: reported only) | abandoned (the visit is no longer
 *    cancelled: nothing run, reported).
 *  - lease_owner / lease_until: one runner at a time. The request takes a 'request' lease as a heartbeat; a sweep
 *    claims with FOR UPDATE SKIP LOCKED and a random token, and only the holder of the token writes results.
 *  - restorations_seen: the cancellation GENERATION, with no time comparison anywhere. job_status_history is append-only
 *    and every status write inserts its row in the same transaction as the status UPDATE, which holds the visit row lock.
 *    The cancel transaction (visit row locked) stores how many restorations (from 'cancelled' to any other status) the
 *    visit has ever had. Later, under FOR SHARE NOWAIT on the visit, the count can only differ if a restoration happened
 *    after this cancel, however early that transaction began (its transitioned_at is its start time, which can precede
 *    this row's created_at, so timestamps cannot order them). A re-cancel needs a restoration first, so it changes the
 *    count too. See services/cancel-generation-fence.js.
 *  - next_attempt_at: when only the customer text has to wait (the 8 AM to 8 PM send window is closed), the sweep sets
 *    this to the next window opening and the claim skips the row until then, so the money and linked work of other
 *    bundles never queue behind a deferred text. NULL = claimable now.
 *  - followthrough_done_at / followthrough_outcome: the money and linked-visit step; notice_outcome: the text step.
 *    Each is written the moment its step ends, so a crashed sweep resumes without redoing a finished step.
 */
const STATUSES = ['pending', 'complete', 'recovered', 'expired', 'abandoned'];

exports.up = async function up(knex) {
  if (await knex.schema.hasTable('ib_cancel_effect_bundles')) return;
  await knex.schema.createTable('ib_cancel_effect_bundles', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('pending_action_id').unique();
    t.uuid('scheduled_service_id').notNullable();
    t.text('actor_id');
    t.text('notes');
    t.boolean('notify_customer').notNullable().defaultTo(false);
    t.jsonb('approved_notice');
    t.jsonb('linked_children').notNullable().defaultTo('[]');
    t.jsonb('approved_money').notNullable().defaultTo('{}');
    t.string('status', 16).notNullable().defaultTo('pending');
    t.text('lease_owner');
    t.timestamp('lease_until', { useTz: true });
    t.integer('restorations_seen').notNullable().defaultTo(0);
    t.integer('attempts').notNullable().defaultTo(0);
    t.timestamp('next_attempt_at', { useTz: true });
    t.timestamp('followthrough_done_at', { useTz: true });
    t.jsonb('followthrough_outcome');
    t.jsonb('notice_outcome');
    t.timestamp('finished_at', { useTz: true });
    t.text('finish_note');
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });
  await knex.raw(`ALTER TABLE ib_cancel_effect_bundles ADD CONSTRAINT ib_cancel_effect_bundles_status_check
    CHECK (status IN (${STATUSES.map((s) => `'${s}'`).join(', ')}))`);
  await knex.raw('ALTER TABLE ib_cancel_effect_bundles ADD CONSTRAINT ib_cancel_effect_bundles_attempts_check CHECK (attempts >= 0)');
  await knex.raw('CREATE INDEX ib_cancel_effect_bundles_visit_idx ON ib_cancel_effect_bundles (scheduled_service_id)');
  // The sweep reads only open rows, oldest first; the partial index follows the open work, not the history.
  await knex.raw(`CREATE INDEX ib_cancel_effect_bundles_open_idx ON ib_cancel_effect_bundles (created_at) WHERE status = 'pending'`);
  // The 90 day prune of finished rows.
  await knex.raw(`CREATE INDEX ib_cancel_effect_bundles_finished_idx ON ib_cancel_effect_bundles (finished_at) WHERE status <> 'pending'`);
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('ib_cancel_effect_bundles');
};
