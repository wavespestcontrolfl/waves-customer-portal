// Property-lookup persistence: cached lookup results keyed on the normalized
// address, plus tech field-verified overrides that never expire. expires_at
// gates only the cached lookup data — verified_overrides survive expiry and
// re-apply to every fresh lookup of the same address.
exports.up = async function up(knex) {
  const exists = await knex.schema.hasTable('property_lookups');
  if (exists) return;

  await knex.schema.createTable('property_lookups', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.string('address_hash', 64).notNullable().unique('uq_property_lookups_address_hash');
    t.text('normalized_address').notNullable();
    t.string('parcel_id', 40);
    t.string('county', 40);
    t.decimal('lat', 10, 7);
    t.decimal('lng', 10, 7);
    t.jsonb('property_record');
    t.jsonb('ai_analysis');
    t.jsonb('parcel');
    t.jsonb('providers');
    t.jsonb('enriched_snapshot');
    t.jsonb('verified_overrides').notNullable().defaultTo('{}');
    t.string('verified_by', 120);
    t.timestamp('verified_at', { useTz: true });
    t.integer('lookup_ms');
    t.timestamp('expires_at', { useTz: true });
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());

    t.index(['parcel_id'], 'idx_property_lookups_parcel_id');
    t.index(['expires_at'], 'idx_property_lookups_expires_at');
  });
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('property_lookups');
};
