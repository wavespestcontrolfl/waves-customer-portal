// products_catalog.service_lines, the other services a product is used on
// (follow-up to 20261006120000 and 20261006130000). Those seeds tag a row from
// its category, or from the lawn protocols alone, so a product the lawn
// protocols list but another service also uses was left lawn-only: Bifen I/T is
// a lawn-protocol product and the mosquito barrier's adulticide
// (20260507000004), and Inventory showed it as lawn only (Codex #5993 round 7).
//
// service_product_usage records which service uses which product. For a row
// that already carries lines, each line its usage rows name is added; nothing
// is removed. A null row stays null: null means "not tagged yet" (the lawn
// sheet then reads the category), and tagging it from usage alone could take a
// product off the lawn sheet. The service name is read here with a fixed list
// of words, not the app's service-line detector, so a later change to that
// detector never changes what this migration did.
//
// down() is a documented no-op, as for 20261006130000: these rows are
// owner-editable in Inventory, and a revert would erase later edits.

const LINE_WORDS = [
  ['mosquito', /mosquito/],
  ['termite', /termite|\bwdo\b/],
  ['rodent', /rodent|\brats?\b|\bmice\b|\bmouse\b/],
  ['tree_shrub', /\btree|shrub/],
  ['palm', /\bpalms?\b/],
  ['lawn', /lawn|turf|weed|fertili[sz]/],
  ['pest', /\bpest\b|roach|flea|\bants?\b|spider|bed ?bugs?/],
];

function linesForService(serviceType) {
  const text = String(serviceType || '').toLowerCase();
  return LINE_WORDS.filter(([, words]) => words.test(text)).map(([line]) => line);
}

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('products_catalog'))) return;
  if (!(await knex.schema.hasColumn('products_catalog', 'service_lines'))) return;
  if (!(await knex.schema.hasTable('service_product_usage'))) return;
  const usage = await knex('service_product_usage as u')
    .join('products_catalog as p', 'p.id', 'u.product_id')
    .whereNotNull('p.service_lines')
    .select('u.product_id', 'u.service_type', 'p.service_lines');
  const byProduct = new Map();
  for (const row of usage) {
    const id = String(row.product_id);
    if (!byProduct.has(id)) {
      const current = Array.isArray(row.service_lines) ? row.service_lines : JSON.parse(row.service_lines || '[]');
      byProduct.set(id, { current, add: new Set() });
    }
    const entry = byProduct.get(id);
    for (const line of linesForService(row.service_type)) if (!entry.current.includes(line)) entry.add.add(line);
  }
  for (const [id, { current, add }] of byProduct) {
    if (!add.size) continue;
    await knex('products_catalog').where({ id }).update({ service_lines: JSON.stringify([...current, ...add]) });
  }
};

exports.down = async function down() {
  // Documented no-op: see the header.
};
