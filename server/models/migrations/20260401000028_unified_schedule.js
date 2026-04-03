exports.up = async function (knex) {
  const cols = await knex('scheduled_services').columnInfo();

  await knex.schema.alterTable('scheduled_services', (t) => {
    if (!cols.time_window) t.string('time_window', 20);
    if (!cols.window_display) t.string('window_display', 30);
    if (!cols.estimated_duration_minutes) t.integer('estimated_duration_minutes');
    if (!cols.zone) t.string('zone', 30);
    if (!cols.lat) t.decimal('lat', 10, 6);
    if (!cols.lng) t.decimal('lng', 10, 6);
    if (!cols.distance_from_previous_miles) t.decimal('distance_from_previous_miles', 8, 2);
    if (!cols.check_in_time) t.timestamp('check_in_time');
    if (!cols.check_out_time) t.timestamp('check_out_time');
    if (!cols.actual_duration_minutes) t.integer('actual_duration_minutes');
    if (!cols.materials_needed) t.jsonb('materials_needed');
    if (!cols.materials_loaded_confirmed) t.boolean('materials_loaded_confirmed').defaultTo(false);
    if (!cols.is_recurring) t.boolean('is_recurring').defaultTo(false);
    if (!cols.recurring_pattern) t.string('recurring_pattern', 20);
    if (!cols.confirmation_sms_sent_at) t.timestamp('confirmation_sms_sent_at');
    if (!cols.reminder_24h_sent) t.boolean('reminder_24h_sent').defaultTo(false);
    if (!cols.weather_advisory) t.string('weather_advisory', 10);
    if (!cols.weather_advisory_detail) t.text('weather_advisory_detail');
    if (!cols.weather_at_service) t.jsonb('weather_at_service');
  });

  // Set zones on existing services
  const services = await knex('scheduled_services')
    .leftJoin('customers', 'scheduled_services.customer_id', 'customers.id')
    .select('scheduled_services.id', 'customers.city', 'customers.zip');

  for (const svc of services) {
    const c = (svc.city || '').toLowerCase();
    const z = svc.zip || '';
    let zone = 'lakewood_ranch';
    if (['parrish', 'ellenton'].includes(c)) zone = 'parrish';
    else if (c === 'palmetto') zone = 'palmetto';
    else if (c.includes('lakewood')) zone = 'lakewood_ranch';
    else if (c.includes('bradenton')) zone = 'bradenton_north';
    else if (c === 'sarasota') zone = 'sarasota';
    else if (['venice', 'nokomis', 'north port'].includes(c)) zone = 'venice_north_port';
    await knex('scheduled_services').where({ id: svc.id }).update({ zone });
  }
};

exports.down = async function (knex) {};
