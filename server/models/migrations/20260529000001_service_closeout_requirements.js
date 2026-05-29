const APPLICATION_CATEGORIES = new Set([
  'pest_control',
  'lawn_care',
  'mosquito',
  'termite',
  'tree_shrub',
]);

const INSPECTION_RE = /inspection|assessment|wdo|letter/i;
const APPLICATION_RE = /pest|roach|ant|flea|bed|mosquito|termite|lawn|weed|fertili|tree|shrub|palm|fire ant|treatment|application/i;

function shouldRequireApplicationLog(row) {
  const category = String(row.category || '').toLowerCase();
  const name = String(row.name || '');
  if (INSPECTION_RE.test(name) && !/treatment|application|bond/i.test(name)) return false;
  return APPLICATION_CATEGORIES.has(category) || APPLICATION_RE.test(name);
}

function requiredPhotoCount(row) {
  const category = String(row.category || '').toLowerCase();
  const name = String(row.name || '');
  if (/termite|wdo|rodent|palm|tree|shrub/i.test(`${category} ${name}`)) return 2;
  if (/inspection|assessment/i.test(name)) return 2;
  return 0;
}

function requiresCustomerNotice(row) {
  const category = String(row.category || '').toLowerCase();
  const name = String(row.name || '');
  return APPLICATION_CATEGORIES.has(category) || APPLICATION_RE.test(name);
}

exports.up = async function up(knex) {
  const cols = await knex('services').columnInfo();
  await knex.schema.alterTable('services', (t) => {
    if (!cols.requires_service_report) t.boolean('requires_service_report').notNullable().defaultTo(true);
    if (!cols.requires_application_log) t.boolean('requires_application_log').notNullable().defaultTo(false);
    if (!cols.required_photo_count) t.integer('required_photo_count').notNullable().defaultTo(0);
    if (!cols.requires_customer_signature) t.boolean('requires_customer_signature').notNullable().defaultTo(false);
    if (!cols.requires_customer_notice) t.boolean('requires_customer_notice').notNullable().defaultTo(false);
    if (!cols.closeout_requirements_source) t.string('closeout_requirements_source', 80).notNullable().defaultTo('inferred_v1');
  });

  const services = await knex('services')
    .select('id', 'name', 'category');

  for (const row of services) {
    await knex('services').where({ id: row.id }).update({
      requires_service_report: true,
      requires_application_log: shouldRequireApplicationLog(row),
      required_photo_count: requiredPhotoCount(row),
      requires_customer_signature: false,
      requires_customer_notice: requiresCustomerNotice(row),
      closeout_requirements_source: 'inferred_v1',
    });
  }
};

exports.down = async function down(knex) {
  const cols = await knex('services').columnInfo();
  await knex.schema.alterTable('services', (t) => {
    if (cols.closeout_requirements_source) t.dropColumn('closeout_requirements_source');
    if (cols.requires_customer_notice) t.dropColumn('requires_customer_notice');
    if (cols.requires_customer_signature) t.dropColumn('requires_customer_signature');
    if (cols.required_photo_count) t.dropColumn('required_photo_count');
    if (cols.requires_application_log) t.dropColumn('requires_application_log');
    if (cols.requires_service_report) t.dropColumn('requires_service_report');
  });
};
