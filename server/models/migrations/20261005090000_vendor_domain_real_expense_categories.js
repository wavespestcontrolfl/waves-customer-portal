// vendor_email_domains.expense_category is matched against
// expense_categories.name (invoice-processor: whereILike name %category%),
// but the 2026-04-14 seed used labels that name no real category
// ("Products & Chemicals", "Software & Services", "Hosting & Infrastructure"),
// so every mapped vendor's emailed invoice still landed uncategorized.
// Map them to the Schedule C categories the expense categorizer's own rules
// name: chemicals and supplies -> Supplies; software, SaaS, hosting ->
// Software & Technology. Rows an admin already changed are left alone.
const MAP = [
  ['Products & Chemicals', 'Supplies'],
  ['Software & Services', 'Software & Technology'],
  ['Hosting & Infrastructure', 'Software & Technology'],
];

exports.up = async function up(knex) {
  for (const [from, to] of MAP) {
    await knex('vendor_email_domains').where('expense_category', from).update({ expense_category: to });
  }
};

// Two old labels map to one new one, so the down restores by seeded domain.
const SEEDED = {
  'siteone.com': 'Products & Chemicals',
  'siteonelandscape.com': 'Products & Chemicals',
  'lesco.com': 'Products & Chemicals',
  'domyown.com': 'Products & Chemicals',
  'arborjet.com': 'Products & Chemicals',
  'twilio.com': 'Software & Services',
  'anthropic.com': 'Software & Services',
  'railway.app': 'Hosting & Infrastructure',
  'namecheap.com': 'Hosting & Infrastructure',
};

exports.down = async function down(knex) {
  for (const [domain, label] of Object.entries(SEEDED)) {
    const to = MAP.find(([from]) => from === label)[1];
    await knex('vendor_email_domains').where({ domain, expense_category: to }).update({ expense_category: label });
  }
};
