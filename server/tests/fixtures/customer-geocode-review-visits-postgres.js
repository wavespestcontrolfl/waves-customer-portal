const { addressKey } = require('../../services/customer-properties');

const CUSTOMER_ID = '71000000-0000-4000-8000-000000000011';
const PRIMARY_ID = '71000000-0000-4000-8000-000000000012';
const ACTOR_ID = '72000000-0000-4000-8000-000000000011';
const TECH_ID = '73000000-0000-4000-8000-000000000011';
const ADDRESS = {
  address_line1: '100 Fixture Way', address_line2: null,
  city: 'Bradenton', state: 'FL', zip: '34205',
};
const CORRECTED = {
  address_line1: '101 Fixture Way', address_line2: null,
  city: 'Bradenton', state: 'FL', zip: '34205',
};

async function createSchema(trx) {
  await trx.schema.createTable('customers', table => {
    table.uuid('id').primary();
    table.string('first_name'); table.string('last_name');
    table.string('profile_label'); table.string('contact_role');
    table.string('address_line1'); table.string('address_line2'); table.string('city');
    table.string('state'); table.string('zip');
    table.decimal('latitude', 10, 7); table.decimal('longitude', 10, 7);
    table.string('property_type'); table.string('lawn_type'); table.integer('property_sqft');
    table.integer('lot_sqft'); table.integer('bed_sqft'); table.integer('linear_ft_perimeter');
    table.integer('palm_count'); table.string('canopy_type');
    table.timestamp('updated_at', { useTz: true }); table.timestamp('deleted_at', { useTz: true });
  });
  await trx.schema.createTable('customer_properties', table => {
    table.uuid('id').primary().defaultTo(trx.raw('gen_random_uuid()')); table.uuid('customer_id');
    table.boolean('active'); table.boolean('is_primary');
    table.string('label'); table.string('occupancy_type'); table.string('relationship'); table.string('source');
    table.string('address_line1'); table.string('address_line2'); table.string('city');
    table.string('state'); table.string('zip'); table.string('address_key');
    table.string('property_type'); table.string('lawn_type'); table.integer('property_sqft');
    table.integer('lot_sqft'); table.integer('bed_sqft'); table.integer('linear_ft_perimeter');
    table.integer('palm_count'); table.string('canopy_type');
    table.decimal('latitude', 10, 7); table.decimal('longitude', 10, 7);
    table.timestamp('updated_at', { useTz: true });
  });
  await trx.raw('CREATE UNIQUE INDEX customer_properties_customer_address_uniq ON customer_properties (customer_id, address_key) WHERE active');
  await trx.schema.createTable('scheduled_services', table => {
    table.uuid('id').primary(); table.uuid('customer_id'); table.uuid('property_id');
    table.uuid('technician_id'); table.uuid('visit_id');
    table.string('status'); table.date('scheduled_date');
    table.string('service_address_line1'); table.string('service_address_line2');
    table.string('service_address_city'); table.string('service_address_state'); table.string('service_address_zip');
    table.decimal('lat', 10, 6); table.decimal('lng', 10, 6);
    table.string('zone'); table.integer('route_order');
    table.text('pre_service_brief'); table.string('pre_service_brief_type');
    table.timestamp('pre_service_brief_generated_at', { useTz: true });
    table.boolean('is_recurring').defaultTo(false); table.uuid('recurring_parent_id');
    table.boolean('recurring_ongoing').defaultTo(false); table.jsonb('recurring_template_overrides');
    table.boolean('auto_dispatch_locked').defaultTo(false);
    table.boolean('auto_dispatch_excluded').defaultTo(false);
    table.timestamp('updated_at', { useTz: true });
  });
  await trx.schema.createTable('service_visits', table => {
    table.uuid('id').primary(); table.uuid('customer_id'); table.uuid('property_id');
    table.date('scheduled_date'); table.string('stop_base_key'); table.integer('stop_seq');
    table.uuid('technician_id'); table.string('status');
  });
  await trx.schema.createTable('audit_log', table => {
    table.increments('id'); table.string('actor_type'); table.uuid('actor_id');
    table.string('action'); table.string('resource_type'); table.string('resource_id');
    table.jsonb('metadata'); table.string('ip_address'); table.string('user_agent');
    table.timestamp('created_at', { useTz: true }).defaultTo(trx.fn.now());
  });
}

async function seedLocation(trx, {
  customerPin = { latitude: 27.4981235, longitude: -82.5748125 },
  propertyAddress = CORRECTED,
  propertyPin = { latitude: 27.5000001, longitude: -82.5000001 },
} = {}) {
  await trx('customers').insert({ id: CUSTOMER_ID, ...ADDRESS, ...customerPin });
  await trx('customer_properties').insert({
    id: PRIMARY_ID, customer_id: CUSTOMER_ID, active: true, is_primary: true,
    ...propertyAddress, ...propertyPin, address_key: addressKey(propertyAddress),
  });
  return {
    customer: { id: CUSTOMER_ID, ...ADDRESS, ...customerPin },
    primary: { id: PRIMARY_ID, customer_id: CUSTOMER_ID, active: true, is_primary: true,
      ...propertyAddress, ...propertyPin },
  };
}

function visitRow(id, overrides = {}) {
  return {
    id, customer_id: CUSTOMER_ID, property_id: null, technician_id: TECH_ID,
    status: 'confirmed', scheduled_date: '2099-10-01',
    service_address_line1: ADDRESS.address_line1,
    service_address_line2: ADDRESS.address_line2,
    service_address_city: ADDRESS.city,
    service_address_state: ADDRESS.state,
    service_address_zip: ADDRESS.zip,
    ...overrides,
  };
}

module.exports = {
  CUSTOMER_ID,
  PRIMARY_ID,
  ACTOR_ID,
  TECH_ID,
  ADDRESS,
  CORRECTED,
  createSchema,
  seedLocation,
  visitRow,
};
