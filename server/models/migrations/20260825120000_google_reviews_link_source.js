/**
 * Provenance stamp for automated review→customer links.
 *
 * 'click_auto' = linked by the confident click-tracking auto-link
 * (GATE_REVIEW_CLICK_AUTOLINK) rather than a reviewer-name match or the
 * office's manual attribution flow. NULL = legacy row, name-match, or manual
 * link — those paths are unchanged and never stamped retroactively.
 */
exports.up = async function (knex) {
  const has = await knex.schema.hasColumn('google_reviews', 'link_source');
  if (!has) {
    await knex.schema.alterTable('google_reviews', (t) => {
      t.string('link_source', 24);
    });
  }
};

exports.down = async function (knex) {
  const has = await knex.schema.hasColumn('google_reviews', 'link_source');
  if (has) {
    await knex.schema.alterTable('google_reviews', (t) => {
      t.dropColumn('link_source');
    });
  }
};
