exports.up = async function up(knex) {
  const exists = await knex.schema.hasTable('service_outline_public_tokens');
  if (exists) return;

  await knex.schema.createTable('service_outline_public_tokens', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('packet_id').notNullable().references('id').inTable('service_outline_packets').onDelete('CASCADE');
    t.string('token_hash', 128).notNullable().unique();
    t.string('token_last_four', 12);
    t.timestamp('token_created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('expires_at', { useTz: true });
    t.timestamp('revoked_at', { useTz: true });
    t.timestamps(true, true);
    t.index(['packet_id'], 'idx_service_outline_public_tokens_packet');
    t.index(['token_hash'], 'idx_service_outline_public_tokens_hash');
  });
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('service_outline_public_tokens');
};
