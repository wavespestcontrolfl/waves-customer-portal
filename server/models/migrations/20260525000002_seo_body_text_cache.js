exports.up = async function (knex) {
  await knex.schema.alterTable('seo_page_audits', (t) => {
    t.text('body_text_5k');
  });
};

exports.down = async function (knex) {
  await knex.schema.alterTable('seo_page_audits', (t) => {
    t.dropColumn('body_text_5k');
  });
};
