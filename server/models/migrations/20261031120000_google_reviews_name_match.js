/**
 * The review matcher's decision for each Google review (owner 2026-10-31, review matching plan
 * PR 3; services/review-name-match.js writes it, GATE_REVIEW_NAME_MATCH_V2).
 *
 * name_match_result: for an unlinked review, what the evidence says (review-link-evidence.js):
 *   link | link_confirm | pause | household | queue | reject. For a linked review, 'disputed' =
 *   the linked customer's first contact came after the review. NULL = not scored, or no candidate.
 * name_match_customer_id: the customer the result points at (link, link_confirm, pause, household,
 *   disputed); NULL for queue / reject.
 * name_match_dismissed_customer_ids: every customer a person ruled out for this review in Reviews
 *   (Not this customer / Keep link); the matcher never names them for this review again.
 *   name_match_dismissed_at marks the latest dismissal, so a pass that read the row before it never
 *   writes over it.
 *
 * Nothing here links a review or changes a customer. The Reviews match queue lists the decisions,
 * and a later send-time guard reads them under its own gate.
 */
const RESULTS = ['link', 'link_confirm', 'pause', 'household', 'queue', 'reject', 'disputed'];

exports.up = async function up(knex) {
  if (await knex.schema.hasColumn('google_reviews', 'name_match_result')) return;
  await knex.schema.alterTable('google_reviews', (t) => {
    t.string('name_match_result', 16);
    t.uuid('name_match_customer_id').references('id').inTable('customers').onDelete('SET NULL');
    t.string('name_match_reason', 32);
    t.timestamp('name_match_at', { useTz: true });
    t.specificType('name_match_dismissed_customer_ids', 'uuid[]').notNullable().defaultTo(knex.raw("'{}'::uuid[]"));
    t.timestamp('name_match_dismissed_at', { useTz: true });
  });
  await knex.raw(`ALTER TABLE google_reviews
    ADD CONSTRAINT google_reviews_name_match_result_check
    CHECK (name_match_result IS NULL OR name_match_result IN (${RESULTS.map((r) => `'${r}'`).join(', ')}))`);
  await knex.raw(`CREATE INDEX google_reviews_name_match_customer_idx
    ON google_reviews (name_match_customer_id) WHERE name_match_customer_id IS NOT NULL`);
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasColumn('google_reviews', 'name_match_result'))) return;
  await knex.raw('DROP INDEX IF EXISTS google_reviews_name_match_customer_idx');
  await knex.raw('ALTER TABLE google_reviews DROP CONSTRAINT IF EXISTS google_reviews_name_match_result_check');
  await knex.schema.alterTable('google_reviews', (t) => {
    t.dropColumn('name_match_dismissed_at');
    t.dropColumn('name_match_dismissed_customer_ids');
    t.dropColumn('name_match_at');
    t.dropColumn('name_match_reason');
    t.dropColumn('name_match_customer_id');
    t.dropColumn('name_match_result');
  });
};
