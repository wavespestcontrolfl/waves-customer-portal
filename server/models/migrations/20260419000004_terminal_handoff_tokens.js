/**
 * terminal_handoff_tokens — signed-JWT handoff for Tap to Pay deep links.
 *
 * When a tech hits "Collect Payment" in the PWA, the server mints a 60-second
 * HMAC-JWT and embeds its jti + amount + invoice_id in a wavespay:// deep
 * link. The native iOS app receives the deep link, POSTs to /validate-handoff,
 * and only then shows the "Tap to Charge" screen. This table backs both:
 *
 *   1. Replay protection — jti is PK, used_at flipped once in a single
 *      atomic UPDATE on validate. A second attempt sees used_at NOT NULL
 *      and is rejected.
 *   2. Mint audit — one row per mint captures who minted, for what invoice,
 *      at what amount, from where. Rows stay after expiry so BI can query
 *      mint-to-charge ratios, per-tech activity, etc.
 */

exports.up = async function (knex) {
  const has = await knex.schema.hasTable('terminal_handoff_tokens');
  if (has) return;

  await knex.schema.createTable('terminal_handoff_tokens', (t) => {
    t.string('jti', 64).primary();
    t.uuid('tech_user_id').notNullable().references('id').inTable('technicians').onDelete('CASCADE');
    t.uuid('invoice_id').notNullable().references('id').inTable('invoices').onDelete('CASCADE');
    t.integer('amount_cents').notNullable();
    t.string('ip_address', 64);
    t.text('user_agent');
    t.timestamp('expires_at').notNullable();
    t.timestamp('used_at');
    t.timestamps(true, true);
    t.index(['expires_at']);
    t.index(['tech_user_id', 'created_at']);
    t.index(['invoice_id']);
  });
};

exports.down = async function (knex) {
  await knex.schema.dropTableIfExists('terminal_handoff_tokens');
};
