/**
 * Price-match draft queue (PR3 of the vendor price-scan lane).
 *
 * The weekly job composes a price-match request email to the SiteOne rep (Mark)
 * from proof-backed opportunities and stages it here as a PENDING draft. Nothing
 * reaches the external recipient until an admin reviews it in /admin and clicks
 * send (status -> sent) or dismisses it (status -> dismissed). The composed
 * subject/html/text + the opportunity snapshot are persisted so the review shows
 * exactly what will go out.
 */
exports.up = async function up(knex) {
  if (await knex.schema.hasTable('price_match_drafts')) return;
  await knex.schema.createTable('price_match_drafts', (t) => {
    t.increments('id').primary();
    t.string('status', 20).notNullable().defaultTo('pending'); // pending | sending (transient claim) | sent | dismissed
    t.string('recipient', 255).notNullable(); // snapshot of MARK_EMAIL at creation
    t.text('subject').notNullable();
    t.text('html').notNullable();
    t.text('text_body').notNullable();
    t.jsonb('matches').notNullable().defaultTo('[]'); // opportunity snapshot for the review UI
    t.integer('included_count').notNullable().defaultTo(0);
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('claimed_at', { useTz: true }).nullable(); // when send claimed it (pending -> sending); for stuck-claim recovery
    t.string('claim_token', 64).nullable(); // per-claim token so a stale send can't finalize a newer claim
    // Stamped right BEFORE SendGrid is called. Once set, the email MAY have gone
    // out, so resetStuckDraft refuses to reopen the row (no duplicate external
    // send) — only a claim that crashed BEFORE the attempt (this still NULL) is
    // safe to auto-recover. A stale attempted row is cleared by manual dismiss.
    t.timestamp('send_attempted_at', { useTz: true }).nullable();
    t.timestamp('sent_at', { useTz: true }).nullable();
    t.string('sent_by', 255).nullable(); // admin who clicked send
    t.string('message_id', 255).nullable(); // SendGrid message id
    t.timestamp('dismissed_at', { useTz: true }).nullable();
    t.index(['status', 'created_at'], 'idx_price_match_drafts_status_created');
  });
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('price_match_drafts');
};
