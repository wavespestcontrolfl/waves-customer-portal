/**
 * Seed SEO target keywords (84 clusters), competitors, and citations.
 * Run: node scripts/seed-seo-keywords.js
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const knex = require('knex');
const knexConfig = require('../server/knexfile');
const db = knex(knexConfig[process.env.NODE_ENV || 'development']);

const CITIES = ['Bradenton', 'Sarasota', 'Lakewood Ranch', 'Venice', 'Parrish', 'North Port', 'Port Charlotte'];
const SERVICES = ['pest control', 'lawn care', 'mosquito control', 'termite inspection', 'termite treatment', 'fire ant treatment', 'rodent control', 'tree and shrub care', 'lawn fertilization', 'mosquito spraying', 'exterminator', 'weed control'];

// Priority 1 — tracked daily
const PRIORITY_1 = [
  'pest control bradenton', 'pest control sarasota', 'pest control lakewood ranch',
  'lawn care bradenton', 'lawn care sarasota', 'mosquito control bradenton',
  'mosquito control sarasota', 'termite inspection bradenton', 'termite treatment sarasota',
  'lawn care lakewood ranch', 'pest control near me', 'exterminator bradenton',
  'fire ant treatment bradenton', 'rat control sarasota', 'tree spraying sarasota',
  'mosquito spraying lakewood ranch', 'pest control parrish fl', 'lawn fertilization bradenton',
  'pest control north port', 'termite inspection venice fl',
];

const COMPETITORS = [
  { name: 'Turner Pest Control', domain: 'turnerpest.com', market_area: 'SWFL' },
  { name: 'Hoskins Pest Control', domain: 'hoskinspest.com', market_area: 'SWFL' },
  { name: 'HomeTeam Pest Defense', domain: 'hometeampestdefense.com', market_area: 'National' },
  { name: 'Orkin', domain: 'orkin.com', market_area: 'National' },
  { name: 'Terminix', domain: 'terminix.com', market_area: 'National' },
  { name: 'Truly Nolen', domain: 'trulynolen.com', market_area: 'Regional' },
  { name: 'Nozzle Nolen', domain: 'nozzlenolen.com', market_area: 'Regional' },
  { name: 'ABC Home & Commercial', domain: 'abchomeandcommercial.com', market_area: 'Regional' },
];

const CITATIONS = [
  // High priority
  { directory_name: 'Google Business Profile — LWR', priority: 'high' },
  { directory_name: 'Google Business Profile — Parrish', priority: 'high' },
  { directory_name: 'Google Business Profile — Sarasota', priority: 'high' },
  { directory_name: 'Google Business Profile — Venice', priority: 'high' },
  { directory_name: 'Yelp', directory_url: 'https://yelp.com', priority: 'high' },
  { directory_name: 'BBB Southwest Florida', directory_url: 'https://bbb.org', priority: 'high' },
  { directory_name: 'FPMA Directory', directory_url: 'https://flpma.org', priority: 'high' },
  { directory_name: 'NPMA Directory', directory_url: 'https://npmapestworld.org', priority: 'high' },
  { directory_name: 'Angi', directory_url: 'https://angi.com', priority: 'high' },
  { directory_name: 'HomeAdvisor', directory_url: 'https://homeadvisor.com', priority: 'high' },
  { directory_name: 'Thumbtack', directory_url: 'https://thumbtack.com', priority: 'high' },
  { directory_name: 'Facebook', directory_url: 'https://facebook.com', priority: 'high' },
  { directory_name: 'Nextdoor', directory_url: 'https://nextdoor.com', priority: 'high' },
  // Medium priority
  { directory_name: 'Yellow Pages', directory_url: 'https://yellowpages.com', priority: 'medium' },
  { directory_name: 'Manta', directory_url: 'https://manta.com', priority: 'medium' },
  { directory_name: 'MapQuest', directory_url: 'https://mapquest.com', priority: 'medium' },
  { directory_name: 'Apple Maps', priority: 'medium' },
  { directory_name: 'Bing Places', priority: 'medium' },
  { directory_name: 'Bradenton Herald Directory', priority: 'medium' },
  { directory_name: 'Sarasota Herald-Tribune', priority: 'medium' },
  // Industry
  { directory_name: 'QualityPro Directory', priority: 'medium' },
  { directory_name: 'PCT Online', directory_url: 'https://pctonline.com', priority: 'medium' },
  { directory_name: 'PestWorld.org', directory_url: 'https://pestworld.org', priority: 'medium' },
];

async function seed() {
  console.log('Seeding SEO target keywords...');

  // Seed keywords — 7 cities × 12 services = 84
  let seeded = 0;
  for (const city of CITIES) {
    for (const service of SERVICES) {
      const keyword = `${service} ${city.toLowerCase()}`;
      const isPriority1 = PRIORITY_1.some(p => keyword.includes(p.replace(/ fl$/, '')));

      const exists = await db('seo_target_keywords').where('keyword', keyword).first();
      if (!exists) {
        await db('seo_target_keywords').insert({
          keyword,
          primary_city: city,
          service_category: service.replace(/\s+/g, '_'),
          priority: isPriority1 ? 1 : 2,
        });
        seeded++;
      }
    }
  }

  // Add "near me" keywords
  const nearMe = ['pest control near me', 'exterminator near me', 'lawn care near me', 'mosquito control near me', 'termite inspection near me'];
  for (const kw of nearMe) {
    const exists = await db('seo_target_keywords').where('keyword', kw).first();
    if (!exists) {
      await db('seo_target_keywords').insert({ keyword: kw, service_category: kw.split(' near')[0].replace(/\s+/g, '_'), priority: kw === 'pest control near me' ? 1 : 2 });
      seeded++;
    }
  }

  console.log(`  ${seeded} keywords seeded`);

  // Seed competitors
  let compSeeded = 0;
  for (const comp of COMPETITORS) {
    const exists = await db('seo_competitors').where('domain', comp.domain).first();
    if (!exists) {
      await db('seo_competitors').insert(comp);
      compSeeded++;
    }
  }
  console.log(`  ${compSeeded} competitors seeded`);

  // Seed citations
  let citSeeded = 0;
  for (const cit of CITATIONS) {
    const exists = await db('seo_citations').where('directory_name', cit.directory_name).first();
    if (!exists) {
      await db('seo_citations').insert({ ...cit, status: 'unchecked' });
      citSeeded++;
    }
  }
  console.log(`  ${citSeeded} citations seeded`);

  console.log('Done.');
  await db.destroy();
}

seed().catch(e => { console.error(e); process.exit(1); });
