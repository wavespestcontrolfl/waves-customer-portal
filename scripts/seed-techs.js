// scripts/seed-techs.js
// Seeds technician records for dev. Run: node scripts/seed-techs.js

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const path = require('path');
const knex = require('knex');
const knexConfig = require('../server/knexfile');
const db = knex(knexConfig[process.env.NODE_ENV || 'development']);

const TECHS = [
  {
    slug: 'adam-benetti',
    name: 'Adam Benetti',
    color: '#0e8c6a',
    licenses: ['pest', 'termite', 'wdo', 'lawn'],
    service_lines: ['general_pest', 'termite', 'wdo_inspection', 'lawn', 'mosquito', 'tree_shrub', 'german_roach', 'stinging_insect', 'rodent', 'callback'],
    territory_zips: ['34219', '34221', '34208', '34209', '34210', '34202', '34240', '34211'],
    territory_label: 'Parrish / Bradenton / Lakewood Ranch',
    upsell_rate: 0.24,
    completion_rate: 0.97,
    callback_rate: 0.02,
    revenue_per_hour: 124,
    active: true,
  },
  {
    slug: 'tech-2',
    name: 'Tech 2',
    color: '#185fa5',
    licenses: ['pest', 'lawn'],
    service_lines: ['general_pest', 'lawn', 'mosquito', 'stinging_insect', 'rodent', 'callback'],
    territory_zips: ['34229', '34231', '34232', '34233', '34234', '34237', '34238', '34285', '34292', '34293'],
    territory_label: 'Sarasota / Venice',
    upsell_rate: 0.14,
    completion_rate: 0.92,
    callback_rate: 0.04,
    revenue_per_hour: 108,
    active: true,
  },
  {
    slug: 'tech-3',
    name: 'Tech 3',
    color: '#ba7517',
    licenses: ['pest'],
    service_lines: ['general_pest', 'mosquito', 'stinging_insect'],
    territory_zips: ['34286', '34287', '34288', '34289', '33948', '33952', '33980', '33981'],
    territory_label: 'North Port / Port Charlotte',
    upsell_rate: 0.11,
    completion_rate: 0.89,
    callback_rate: 0.06,
    revenue_per_hour: 96,
    active: true,
  },
];

async function seed() {
  console.log('Seeding technicians...');
  for (const tech of TECHS) {
    const row = {
      ...tech,
      licenses: JSON.stringify(tech.licenses),
      service_lines: JSON.stringify(tech.service_lines),
      territory_zips: JSON.stringify(tech.territory_zips),
    };
    const existing = await db('dispatch_technicians').where('slug', tech.slug).first();
    if (existing) {
      await db('dispatch_technicians').where('slug', tech.slug).update({ ...row, updated_at: new Date() });
      console.log(`  updated: ${tech.name}`);
    } else {
      await db('dispatch_technicians').insert(row);
      console.log(`  inserted: ${tech.name}`);
    }
  }
  console.log('Done.');
  await db.destroy();
}

seed().catch((e) => { console.error(e); process.exit(1); });
