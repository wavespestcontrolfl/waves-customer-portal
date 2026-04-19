/**
 * Migration — service_areas table
 *
 * Canonical source of truth for SWFL cities the business serves. Consumed by:
 *   - Admin blog creation UI (multi-select tags + related-services scoping)
 *   - Astro spoke/hub builds via GET /api/public/service-areas (generated JSON)
 *   - Dispatch / CRM / pricing (future — migrate off hardcoded lists)
 *
 * `slug` matches the slug fragment used in Astro content paths
 * (e.g. `pest-control-bradenton-fl` → slug `bradenton`).
 * `domain_key` ties a city to its spoke domain in wavespestcontrol-astro/src/data/domains.json
 * when one exists; null for hub-only cities.
 */

exports.up = async function (knex) {
  await knex.schema.createTable('service_areas', t => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.string('city').notNullable();
    t.string('slug').notNullable().unique();
    t.string('county').notNullable();
    t.string('phone');
    t.string('tel_href');
    t.string('domain_key');
    t.boolean('is_primary').defaultTo(false);
    t.boolean('active').defaultTo(true);
    t.integer('display_order').defaultTo(100);
    t.timestamps(true, true);

    t.index('active');
    t.index('display_order');
  });

  const rows = [
    { city: 'Bradenton',       slug: 'bradenton',       county: 'Manatee',  phone: '(941) 297-5749', tel_href: 'tel:+19412975749', domain_key: null,                          is_primary: true,  display_order: 10 },
    { city: 'Lakewood Ranch',  slug: 'lakewood-ranch',  county: 'Manatee',  phone: '(941) 297-5749', tel_href: 'tel:+19412975749', domain_key: null,                          is_primary: false, display_order: 20 },
    { city: 'Parrish',         slug: 'parrish',         county: 'Manatee',  phone: '(941) 297-5749', tel_href: 'tel:+19412975749', domain_key: 'wavespestcontrolparrish.com', is_primary: false, display_order: 30 },
    { city: 'Palmetto',        slug: 'palmetto',        county: 'Manatee',  phone: '(941) 297-5749', tel_href: 'tel:+19412975749', domain_key: null,                          is_primary: false, display_order: 40 },
    { city: 'Ellenton',        slug: 'ellenton',        county: 'Manatee',  phone: '(941) 297-5749', tel_href: 'tel:+19412975749', domain_key: null,                          is_primary: false, display_order: 50 },
    { city: 'Sarasota',        slug: 'sarasota',        county: 'Sarasota', phone: '(941) 297-5749', tel_href: 'tel:+19412975749', domain_key: 'wavespestcontrolsarasota.com', is_primary: true,  display_order: 60 },
    { city: 'Venice',          slug: 'venice',          county: 'Sarasota', phone: '(941) 297-3337', tel_href: 'tel:+19412973337', domain_key: 'wavespestcontrolvenice.com',  is_primary: true,  display_order: 70 },
    { city: 'North Port',      slug: 'north-port',      county: 'Sarasota', phone: '(941) 297-3337', tel_href: 'tel:+19412973337', domain_key: null,                          is_primary: false, display_order: 80 },
    { city: 'Nokomis',         slug: 'nokomis',         county: 'Sarasota', phone: '(941) 297-3337', tel_href: 'tel:+19412973337', domain_key: null,                          is_primary: false, display_order: 90 },
    { city: 'Osprey',          slug: 'osprey',          county: 'Sarasota', phone: '(941) 297-3337', tel_href: 'tel:+19412973337', domain_key: null,                          is_primary: false, display_order: 100 },
    { city: 'Englewood',       slug: 'englewood',       county: 'Sarasota', phone: '(941) 297-3337', tel_href: 'tel:+19412973337', domain_key: null,                          is_primary: false, display_order: 110 },
    { city: 'Port Charlotte',  slug: 'port-charlotte',  county: 'Charlotte',phone: '(941) 297-3337', tel_href: 'tel:+19412973337', domain_key: null,                          is_primary: true,  display_order: 120 },
  ];

  await knex('service_areas').insert(rows);
};

exports.down = function (knex) {
  return knex.schema.dropTableIfExists('service_areas');
};
