exports.up = async function (knex) {
  if (await knex.schema.hasTable('gsc_queries')) {
    await knex.raw('ALTER TABLE gsc_queries ALTER COLUMN query TYPE text');
  }

  if (await knex.schema.hasTable('gsc_pages')) {
    await knex.raw('ALTER TABLE gsc_pages ALTER COLUMN page_url TYPE text');
  }

  if (await knex.schema.hasTable('gsc_core_web_vitals')) {
    await knex.raw('ALTER TABLE gsc_core_web_vitals ALTER COLUMN page_url TYPE text');
  }

  if (await knex.schema.hasTable('gsc_indexing_issues')) {
    await knex.raw('ALTER TABLE gsc_indexing_issues ALTER COLUMN page_url TYPE text');
  }
};

exports.down = async function (knex) {
  if (await knex.schema.hasTable('gsc_queries')) {
    await knex.raw('ALTER TABLE gsc_queries ALTER COLUMN query TYPE varchar(255) USING left(query, 255)');
  }

  if (await knex.schema.hasTable('gsc_pages')) {
    await knex.raw('ALTER TABLE gsc_pages ALTER COLUMN page_url TYPE varchar(255) USING left(page_url, 255)');
  }

  if (await knex.schema.hasTable('gsc_core_web_vitals')) {
    await knex.raw('ALTER TABLE gsc_core_web_vitals ALTER COLUMN page_url TYPE varchar(255) USING left(page_url, 255)');
  }

  if (await knex.schema.hasTable('gsc_indexing_issues')) {
    await knex.raw('ALTER TABLE gsc_indexing_issues ALTER COLUMN page_url TYPE varchar(255) USING left(page_url, 255)');
  }
};
