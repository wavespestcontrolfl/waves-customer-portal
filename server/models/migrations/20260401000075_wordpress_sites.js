const { v4: uuidv4 } = require('uuid');

const SITES = [
  { domain: 'wavespestcontrol.com', name: 'Waves Pest Control', area: 'Lakewood Ranch', site_type: 'pest_control' },
  { domain: 'bradentonflpestcontrol.com', name: 'Bradenton Pest Control', area: 'Bradenton', site_type: 'pest_control' },
  { domain: 'sarasotaflpestcontrol.com', name: 'Sarasota Pest Control', area: 'Sarasota', site_type: 'pest_control' },
  { domain: 'veniceflpestcontrol.com', name: 'Venice Pest Control', area: 'Venice', site_type: 'pest_control' },
  { domain: 'palmettoflpestcontrol.com', name: 'Palmetto Pest Control', area: 'Palmetto', site_type: 'pest_control' },
  { domain: 'parrishpestcontrol.com', name: 'Parrish Pest Control', area: 'Parrish', site_type: 'pest_control' },
  { domain: 'bradentonflexterminator.com', name: 'Bradenton Exterminators', area: 'Bradenton', site_type: 'exterminator' },
  { domain: 'sarasotaflexterminator.com', name: 'Sarasota Exterminators', area: 'Sarasota', site_type: 'exterminator' },
  { domain: 'palmettoexterminator.com', name: 'Palmetto Exterminators', area: 'Palmetto', site_type: 'exterminator' },
  { domain: 'parrishexterminator.com', name: 'Parrish Exterminators', area: 'Parrish', site_type: 'exterminator' },
  { domain: 'bradentonfllawncare.com', name: 'Bradenton Lawn Care', area: 'Bradenton', site_type: 'lawn_care' },
  { domain: 'sarasotafllawncare.com', name: 'Sarasota Lawn Care', area: 'Sarasota', site_type: 'lawn_care' },
  { domain: 'venicelawncare.com', name: 'Venice Lawn Care', area: 'Venice', site_type: 'lawn_care' },
  { domain: 'parrishfllawncare.com', name: 'Parrish Lawn Care', area: 'Parrish', site_type: 'lawn_care' },
  { domain: 'waveslawncare.com', name: 'Waves Lawn Care', area: 'Lakewood Ranch', site_type: 'lawn_care' },
];

exports.up = async function (knex) {
  if (await knex.schema.hasTable('wordpress_sites')) return;

  await knex.schema.createTable('wordpress_sites', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.string('domain', 200).unique().notNullable();
    t.string('name', 100);
    t.string('wp_username', 100);
    t.string('wp_app_password', 200);
    t.string('area', 50);
    t.string('site_type', 30);
    t.string('status', 20).defaultTo('active');
    t.timestamp('last_synced_at');
    t.text('last_error');
    t.integer('forms_count').defaultTo(0);
    t.string('webhook_status', 20).defaultTo('unknown');
    t.timestamps(true, true);
  });

  // Seed the 15 sites
  for (const site of SITES) {
    await knex('wordpress_sites').insert({
      id: uuidv4(),
      domain: site.domain,
      name: site.name,
      area: site.area,
      site_type: site.site_type,
    });
  }
};

exports.down = async function (knex) {
  await knex.schema.dropTableIfExists('wordpress_sites');
};
