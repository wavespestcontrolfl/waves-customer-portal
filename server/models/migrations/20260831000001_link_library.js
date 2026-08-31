/**
 * Link Library — the searchable set of links the admin SMS composer's
 * Insert Link sheet can drop into a text (owner ask 2026-08-30).
 *
 * Consumers: services/link-library.js (list/CRUD/sitemap sync),
 * routes/admin-communications.js (composer + Settings endpoints), the
 * daily sitemap sync job in services/scheduler.js.
 *
 * Sources:
 *   manual  — hand-managed rows (seeded below: app stores, socials, the
 *             Yelp/Facebook write-a-review screens). Editable in Settings.
 *   sitemap — every wavespestcontrol.com page, owned by syncSitemapLinks()
 *             (the three booking-funnel pages are pre-seeded so the group
 *             isn't empty before the first sync; the sync adopts them).
 * The per-office Google review links are NOT rows — they're computed live
 * from config/locations.js WAVES_LOCATIONS.
 *
 * `clause` is the SMS sentence prefix the composer renders as
 * "{clause}: {url}"; rows without one fall back to their name.
 */

const CATEGORIES = ['reviews', 'booking', 'app', 'website', 'social'];
const SOURCES = ['manual', 'sitemap'];

const SEED_ROWS = [
  {
    name: 'App Store (iPhone)',
    url: 'https://apps.apple.com/us/app/waves-pest-control/id6782775654',
    clause: 'Download the Waves app on the App Store',
    category: 'app',
    keywords: 'app apple ios iphone download waves portal',
    source: 'manual',
  },
  {
    name: 'Google Play (Android)',
    url: 'https://play.google.com/store/apps/details?id=com.wavespestcontrol.portal',
    clause: 'Get the Waves app on Google Play',
    category: 'app',
    keywords: 'app google play android download waves portal',
    source: 'manual',
  },
  {
    name: 'Yelp — write a review',
    url: 'https://www.yelp.com/writeareview/biz/waves-pest-control-bradenton-6',
    clause: 'Review us on Yelp here',
    category: 'reviews',
    keywords: 'yelp review write stars',
    source: 'manual',
  },
  {
    name: 'Facebook — write a review',
    url: 'https://www.facebook.com/wavespestcontrol/reviews',
    clause: 'Review us on Facebook here',
    category: 'reviews',
    keywords: 'facebook fb review recommend write',
    source: 'manual',
  },
  {
    name: 'Instagram',
    url: 'https://instagram.com/wavespestcontrol',
    clause: 'Follow us on Instagram',
    category: 'social',
    keywords: 'instagram ig social follow',
    source: 'manual',
  },
  {
    name: 'YouTube',
    url: 'https://youtube.com/@wavespestcontrol',
    clause: 'Watch us on YouTube',
    category: 'social',
    keywords: 'youtube video social watch',
    source: 'manual',
  },
  {
    name: 'TikTok',
    url: 'https://www.tiktok.com/@wavespestcontrol',
    clause: 'Follow us on TikTok',
    category: 'social',
    keywords: 'tiktok video social follow',
    source: 'manual',
  },
  // Booking funnel — sitemap-source so the first real sync adopts them.
  {
    name: 'Free quote',
    url: 'https://www.wavespestcontrol.com/quote/',
    clause: 'Get your free quote here',
    category: 'booking',
    keywords: 'quote estimate price pricing free pest lawn',
    source: 'sitemap',
  },
  {
    name: 'Book a service',
    url: 'https://www.wavespestcontrol.com/book/',
    clause: 'Book your service here',
    category: 'booking',
    keywords: 'book schedule appointment new service',
    source: 'sitemap',
  },
  {
    name: 'Pest Control Calculator',
    url: 'https://www.wavespestcontrol.com/pest-control-calculator/',
    clause: 'See your pest control price here',
    category: 'booking',
    keywords: 'calculator cost price estimate',
    source: 'sitemap',
  },
];

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('link_library'))) {
    await knex.schema.createTable('link_library', (t) => {
      t.increments('id').primary();
      t.string('name', 120).notNullable();
      t.text('url').notNullable();
      t.string('clause', 200);
      t.string('category', 20).notNullable().defaultTo('website');
      t.string('keywords', 300);
      t.string('source', 20).notNullable().defaultTo('manual');
      t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
      t.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());
    });
    const quoted = (values) => values.map((v) => `'${v}'`).join(', ');
    await knex.raw(`ALTER TABLE link_library ADD CONSTRAINT link_library_category_check CHECK (category IN (${quoted(CATEGORIES)}))`);
    await knex.raw(`ALTER TABLE link_library ADD CONSTRAINT link_library_source_check CHECK (source IN (${quoted(SOURCES)}))`);
    await knex.raw('CREATE UNIQUE INDEX IF NOT EXISTS link_library_url_unique ON link_library (url)');
    await knex('link_library').insert(SEED_ROWS);
  }
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('link_library');
};

// Re-exported so seeds and tests can assert against the canonical lists
// without duplicating them.
exports.CATEGORIES = CATEGORIES;
exports.SEED_ROWS = SEED_ROWS;
