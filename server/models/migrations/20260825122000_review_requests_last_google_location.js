/**
 * Location paired with last_redirected_at. google_location is overwritten on
 * every click, so after a revisit the immutable first-click timestamp could
 * be evaluated against a location it was never recorded with — the
 * correlation must only judge timestamp/location pairs captured together
 * (GH codex #3483 r4). google_location now freezes at the FIRST click's
 * routing; this column carries the latest click's routing.
 */
exports.up = async function (knex) {
  const has = await knex.schema.hasColumn('review_requests', 'last_google_location');
  if (!has) {
    await knex.schema.alterTable('review_requests', (t) => {
      t.string('last_google_location', 30);
    });
  }
};

exports.down = async function (knex) {
  const has = await knex.schema.hasColumn('review_requests', 'last_google_location');
  if (has) {
    await knex.schema.alterTable('review_requests', (t) => {
      t.dropColumn('last_google_location');
    });
  }
};
