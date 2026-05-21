exports.up = async function (knex) {
  if (!(await knex.schema.hasTable('system_settings'))) return;

  await knex('system_settings')
    .insert([
      {
        key: 'gps_arrival.enabled',
        value: 'true',
        category: 'gps_arrival',
        description: 'Enable GPS proximity arrival detection for the current en-route job',
      },
      {
        key: 'gps_arrival.radius_meters',
        value: '175',
        category: 'gps_arrival',
        description: 'Outer arrival radius in meters; requires low speed or stopped signal',
      },
      {
        key: 'gps_arrival.immediate_radius_meters',
        value: '55',
        category: 'gps_arrival',
        description: 'Inner arrival radius in meters; allows a slightly higher speed threshold',
      },
      {
        key: 'gps_arrival.max_speed_mph',
        value: '12',
        category: 'gps_arrival',
        description: 'Maximum speed for arrival inside the outer radius',
      },
      {
        key: 'gps_arrival.immediate_max_speed_mph',
        value: '20',
        category: 'gps_arrival',
        description: 'Maximum speed for arrival inside the inner radius',
      },
    ])
    .onConflict('key')
    .ignore();
};

exports.down = async function (knex) {
  if (!(await knex.schema.hasTable('system_settings'))) return;
  await knex('system_settings')
    .whereIn('key', [
      'gps_arrival.enabled',
      'gps_arrival.radius_meters',
      'gps_arrival.immediate_radius_meters',
      'gps_arrival.max_speed_mph',
      'gps_arrival.immediate_max_speed_mph',
    ])
    .del();
};
