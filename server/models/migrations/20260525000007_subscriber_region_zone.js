/**
 * Add region_zone to newsletter_subscribers.
 *
 * Backfills from linked customers' city field using the same CITY_ZONE_MAP
 * from server/services/event-freshness.js. Only touches rows that already
 * have a customer_id link and a NULL region_zone.
 */

exports.up = async function (knex) {
  await knex.schema.alterTable('newsletter_subscribers', (table) => {
    table.string('region_zone', 32).nullable();
  });

  // Inline copy of the city→zone map so the migration is self-contained
  // and doesn't break if event-freshness.js ever changes.
  const CITY_ZONE_MAP = {
    'north port': 'south_sarasota', 'wellen park': 'south_sarasota',
    'venice': 'south_sarasota', 'nokomis': 'south_sarasota',
    'osprey': 'south_sarasota', 'englewood': 'south_sarasota',
    'port charlotte': 'south_sarasota', 'punta gorda': 'south_sarasota',
    'sarasota': 'sarasota', 'siesta key': 'sarasota', 'longboat key': 'sarasota',
    'bradenton': 'manatee', 'palmetto': 'manatee', 'anna maria': 'manatee',
    'lakewood ranch': 'manatee', 'parrish': 'manatee', 'ellenton': 'manatee',
    'cortez': 'manatee',
    'st petersburg': 'pinellas', 'st pete': 'pinellas', 'clearwater': 'pinellas',
    'gulfport': 'pinellas', 'dunedin': 'pinellas', 'safety harbor': 'pinellas',
    'tampa': 'tampa', 'ybor city': 'tampa', 'hyde park': 'tampa',
    'brandon': 'tampa', 'riverview': 'tampa',
  };

  // Backfill from linked customer city
  const linked = await knex('newsletter_subscribers as ns')
    .join('customers as c', 'c.id', 'ns.customer_id')
    .whereNotNull('ns.customer_id')
    .whereNull('ns.region_zone')
    .select('ns.id', 'c.city');

  let updated = 0;
  for (const row of linked) {
    const zone = row.city ? CITY_ZONE_MAP[row.city.trim().toLowerCase()] : null;
    if (zone) {
      await knex('newsletter_subscribers').where({ id: row.id }).update({ region_zone: zone });
      updated++;
    }
  }
  console.log(`[20260525000007] Backfilled ${updated} subscriber region zones from customer city`);
};

exports.down = async function (knex) {
  await knex.schema.alterTable('newsletter_subscribers', (table) => {
    table.dropColumn('region_zone');
  });
};
