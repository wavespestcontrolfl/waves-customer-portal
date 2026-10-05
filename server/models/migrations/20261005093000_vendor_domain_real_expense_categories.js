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

// Down is a deliberate no-op. The old labels name no expense category, and
// up() cannot tell a row it changed from a row an admin had already set to
// the same real name, so reverting could erase valid admin state. Rolling
// back the code leaves real category names in place, which the old code
// reads correctly.
exports.down = async function down() {};
