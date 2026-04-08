/**
 * Add fleet monitoring columns to wordpress_sites table
 * Supports: hub/spoke architecture, content tracking, schema/llms.txt deployment,
 * PageSpeed monitoring, blog/backlink counts, SSL tracking, WP version tracking
 */
exports.up = async function (knex) {
  if (!(await knex.schema.hasTable('wordpress_sites'))) return;

  await knex.schema.alterTable('wordpress_sites', (t) => {
    // Hub/spoke architecture
    t.string('hub_type', 10).defaultTo('spoke'); // 'hub' or 'spoke'
    t.string('nearest_hub_domain', 200); // for spokes: which hub they link to
    t.string('vertical', 30); // 'pest_control', 'lawn_care', 'exterminator' (cleaner than site_type for some uses)

    // Content status tracking
    t.string('content_status', 30).defaultTo('unknown'); // 'built', 'clone', 'needs_rebuild', 'needs_content', 'unknown'
    t.integer('total_pages').defaultTo(0);
    t.integer('blog_post_count').defaultTo(0);
    t.integer('backlinks_to_hub').defaultTo(0);
    t.timestamp('content_last_updated');

    // Schema & AI visibility
    t.boolean('schema_deployed').defaultTo(false);
    t.string('schema_type', 50); // 'PestControlService', 'LandscapingBusiness'
    t.boolean('llms_txt_deployed').defaultTo(false);
    t.boolean('robots_txt_ai_ok').defaultTo(false); // AI crawlers not blocked

    // Performance & health
    t.integer('pagespeed_mobile');
    t.integer('pagespeed_desktop');
    t.timestamp('pagespeed_checked_at');
    t.string('wordpress_version', 20);
    t.timestamp('ssl_expiry');
    t.boolean('ga4_active').defaultTo(false);
    t.boolean('search_console_verified').defaultTo(false);

    // GBP & phone mapping
    t.string('gbp_listing', 255);
    t.string('tracking_phone', 30);
    t.string('schema_phone', 30); // real GBP-matching phone for schema

    // Service area data
    t.jsonb('neighborhoods'); // array of neighborhood names
    t.string('target_city', 100);
    t.string('county', 50);
  });

  // Populate hub_type and vertical from existing site_type
  await knex('wordpress_sites')
    .whereIn('domain', ['wavespestcontrol.com', 'waveslawncare.com'])
    .update({ hub_type: 'hub' });

  // Set vertical = site_type for all
  const sites = await knex('wordpress_sites').select('id', 'site_type');
  for (const site of sites) {
    await knex('wordpress_sites').where({ id: site.id }).update({ vertical: site.site_type });
  }

  // Set nearest_hub for spokes
  await knex('wordpress_sites')
    .where('site_type', 'pest_control')
    .whereNot('domain', 'wavespestcontrol.com')
    .update({ nearest_hub_domain: 'wavespestcontrol.com' });

  await knex('wordpress_sites')
    .where('site_type', 'exterminator')
    .update({ nearest_hub_domain: 'wavespestcontrol.com' });

  await knex('wordpress_sites')
    .where('site_type', 'lawn_care')
    .whereNot('domain', 'waveslawncare.com')
    .update({ nearest_hub_domain: 'waveslawncare.com' });

  // Set content_status based on what we know
  const builtDomains = [
    'wavespestcontrol.com', 'bradentonflpestcontrol.com', 'palmettoflpestcontrol.com',
    'parrishpestcontrol.com', 'sarasotaflpestcontrol.com', 'veniceflpestcontrol.com',
    'bradentonflexterminator.com', 'palmettoexterminator.com', 'parrishexterminator.com',
    'sarasotaflexterminator.com',
  ];
  const cloneDomains = [
    'bradentonfllawncare.com', 'parrishfllawncare.com',
    'sarasotafllawncare.com', 'venicelawncare.com',
  ];

  await knex('wordpress_sites').whereIn('domain', builtDomains).update({ content_status: 'built' });
  await knex('wordpress_sites').whereIn('domain', cloneDomains).update({ content_status: 'clone_needs_rebuild' });
  await knex('wordpress_sites').where('domain', 'waveslawncare.com').update({ content_status: 'partial' });

  // Set target cities
  const cityMap = {
    'wavespestcontrol.com': { target_city: 'Lakewood Ranch', county: 'Manatee' },
    'waveslawncare.com': { target_city: 'Lakewood Ranch', county: 'Manatee' },
    'bradentonflpestcontrol.com': { target_city: 'Bradenton', county: 'Manatee' },
    'bradentonfllawncare.com': { target_city: 'Bradenton', county: 'Manatee' },
    'bradentonflexterminator.com': { target_city: 'Bradenton', county: 'Manatee' },
    'palmettoflpestcontrol.com': { target_city: 'Palmetto', county: 'Manatee' },
    'palmettoexterminator.com': { target_city: 'Palmetto', county: 'Manatee' },
    'parrishpestcontrol.com': { target_city: 'Parrish', county: 'Manatee' },
    'parrishexterminator.com': { target_city: 'Parrish', county: 'Manatee' },
    'parrishfllawncare.com': { target_city: 'Parrish', county: 'Manatee' },
    'sarasotaflpestcontrol.com': { target_city: 'Sarasota', county: 'Sarasota' },
    'sarasotaflexterminator.com': { target_city: 'Sarasota', county: 'Sarasota' },
    'sarasotafllawncare.com': { target_city: 'Sarasota', county: 'Sarasota' },
    'veniceflpestcontrol.com': { target_city: 'Venice', county: 'Sarasota' },
    'venicelawncare.com': { target_city: 'Venice', county: 'Sarasota' },
  };

  for (const [domain, data] of Object.entries(cityMap)) {
    await knex('wordpress_sites').where({ domain }).update(data);
  }

  // Set schema types
  await knex('wordpress_sites')
    .whereIn('site_type', ['pest_control', 'exterminator'])
    .update({ schema_type: 'PestControlService' });

  await knex('wordpress_sites')
    .where('site_type', 'lawn_care')
    .update({ schema_type: 'LandscapingBusiness' });

  console.log('[migration] Added fleet monitoring columns to wordpress_sites');
};

exports.down = async function (knex) {
  if (!(await knex.schema.hasTable('wordpress_sites'))) return;

  await knex.schema.alterTable('wordpress_sites', (t) => {
    const cols = [
      'hub_type', 'nearest_hub_domain', 'vertical', 'content_status',
      'total_pages', 'blog_post_count', 'backlinks_to_hub', 'content_last_updated',
      'schema_deployed', 'schema_type', 'llms_txt_deployed', 'robots_txt_ai_ok',
      'pagespeed_mobile', 'pagespeed_desktop', 'pagespeed_checked_at',
      'wordpress_version', 'ssl_expiry', 'ga4_active', 'search_console_verified',
      'gbp_listing', 'tracking_phone', 'schema_phone',
      'neighborhoods', 'target_city', 'county',
    ];
    for (const col of cols) t.dropColumn(col);
  });
};
