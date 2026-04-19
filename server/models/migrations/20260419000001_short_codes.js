/**
 * short_codes — branded URL shortener, self-hosted.
 *
 * Customer-facing SMS/email/print surfaces paste links like
 * https://portal.wavespestcontrol.com/estimate/{36-char-uuid}. That's 80+
 * chars, eats a whole SMS segment, and reads like phishing next to the
 * customer's name. This table trades that long URL for a short code we own:
 *   https://portal.wavespestcontrol.com/l/k3j9
 *
 * `code` is opaque-random (4-6 chars alphanum). `kind` + `entity_id` let
 * future admin views answer "which estimate this points to, how many
 * clicks, and when the last click landed" without joining URL parsing.
 */

exports.up = async function (knex) {
  const has = await knex.schema.hasTable('short_codes');
  if (has) return;

  await knex.schema.createTable('short_codes', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    // Lowercase alphanum only. 6-char cap supports ~2B codes; we'll start
    // issuing at 4 chars (~1.6M) and grow the length once collision rate
    // passes our retry budget — no schema change needed.
    t.string('code', 16).notNullable().unique();
    t.text('target_url').notNullable();
    // Classifier so we can filter admin views / analytics by link purpose
    // without parsing target_url. Known values: estimate, invoice, booking,
    // newsletter, referral, review, other.
    t.string('kind', 32).notNullable().defaultTo('other');
    // Optional back-pointer to the source row for this link. Kept as loose
    // (type, id) rather than FK so we can point at heterogeneous tables
    // (estimates, invoices, newsletter_sends, ...) from one column.
    t.string('entity_type', 64);
    t.uuid('entity_id');
    t.uuid('customer_id').references('id').inTable('customers').onDelete('SET NULL');
    t.integer('click_count').notNullable().defaultTo(0);
    t.timestamp('last_clicked_at');
    t.string('last_click_ip', 64);
    t.text('last_click_ua');
    t.uuid('created_by').references('id').inTable('technicians').onDelete('SET NULL');
    // Null = never expires. Estimate links default to null (the underlying
    // estimate already has its own expires_at); other callers may set this
    // explicitly for one-off short-lived links.
    t.timestamp('expires_at');
    t.timestamps(true, true);
    t.index(['kind']);
    t.index(['entity_type', 'entity_id']);
    t.index(['customer_id']);
    t.index(['expires_at']);
  });
};

exports.down = async function (knex) {
  await knex.schema.dropTableIfExists('short_codes');
};
