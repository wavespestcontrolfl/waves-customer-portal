/**
 * Property Preferences — gate codes, pets, scheduling, irrigation, HOA info
 */
exports.up = async function (knex) {
  await knex.schema.createTable('property_preferences', (t) => {
    t.uuid('id').primary().defaultTo(knex.fn.uuid());
    t.uuid('customer_id').notNullable().unique().references('id').inTable('customers').onDelete('CASCADE');

    // Access & Gate Codes
    t.string('neighborhood_gate_code', 100);
    t.string('property_gate_code', 100);
    t.string('garage_code', 100);
    t.string('lockbox_code', 100);
    t.text('parking_notes');

    // Pets
    t.integer('pet_count').defaultTo(0);
    t.text('pet_details');
    t.text('pets_secured_plan');

    // Scheduling
    t.enu('preferred_day', ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'no_preference']).defaultTo('no_preference');
    t.enu('preferred_time', ['early_morning', 'morning', 'midday', 'afternoon', 'no_preference']).defaultTo('no_preference');
    t.enu('contact_preference', ['call', 'text', 'email']).defaultTo('text');

    // Irrigation
    t.boolean('irrigation_system').defaultTo(false);
    t.string('irrigation_controller_location', 200);
    t.integer('irrigation_zones');
    t.text('irrigation_schedule_notes');

    // HOA
    t.string('hoa_name', 150);
    t.text('hoa_restrictions');

    // Access notes & special instructions
    t.text('access_notes');
    t.text('special_instructions');

    t.timestamps(true, true);
  });
};

exports.down = async function (knex) {
  await knex.schema.dropTableIfExists('property_preferences');
};
