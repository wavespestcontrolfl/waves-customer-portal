// The owner's negative word list (owner plan A, 2026-11-02, PR 2 of 2). A word on this list goes to Google Ads as a
// phrase-match negative keyword on every linked Google campaign (services/ads/negative-keyword-actions.js
// syncOwnerWords), with no bell. Account level: one row per word, whatever the campaign.
//
//   text        normalized: lowercase, trimmed, single spaces (services/ads/negative-keywords.js)
//   match_type  'phrase'
//   added_by    the admin's id, or 'starter-list' for the words the owner approved on 2026-11-02
//   removed_at  set when the word comes off the list (the row stays); adding it again clears it
//
// The same migration gives ad_negative_keywords the two columns the bell needs: notified_at (the day the advisor
// word's bell rang, for the 3-a-day cap) and last_error (why Google refused it, shown on the Ads page).
// A pushed migration is frozen: edit nothing here after the first push, add a new migration instead.
const STARTER_WORDS = [
  'squirrel', 'squirrels', 'raccoon', 'raccoons', 'opossum', 'armadillo', 'snake', 'snakes',
  'bat removal', 'wildlife', 'jobs', 'careers', 'hiring', 'salary', 'license', 'training',
];

exports.STARTER_WORDS = STARTER_WORDS;

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('ad_negative_words'))) {
    await knex.schema.createTable('ad_negative_words', (t) => {
      t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
      t.string('text', 80).notNullable().unique();
      t.string('match_type', 10).notNullable().defaultTo('phrase');
      t.string('added_by', 64).nullable();
      t.string('removed_by', 64).nullable();
      t.timestamp('removed_at', { useTz: true }).nullable();
      t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
      t.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    });
  }
  if (!(await knex.schema.hasColumn('ad_negative_keywords', 'notified_at'))) {
    await knex.schema.alterTable('ad_negative_keywords', (t) => {
      t.timestamp('notified_at', { useTz: true }).nullable();
    });
  }
  if (!(await knex.schema.hasColumn('ad_negative_keywords', 'last_error'))) {
    await knex.schema.alterTable('ad_negative_keywords', (t) => {
      t.text('last_error').nullable();
    });
  }
  // The approved starter list. The owner left free / diy / how to out on purpose.
  await knex('ad_negative_words')
    .insert(STARTER_WORDS.map((text) => ({ text, added_by: 'starter-list' })))
    .onConflict('text')
    .ignore();
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('ad_negative_words');
  if (await knex.schema.hasColumn('ad_negative_keywords', 'notified_at')) {
    await knex.schema.alterTable('ad_negative_keywords', (t) => t.dropColumn('notified_at'));
  }
  if (await knex.schema.hasColumn('ad_negative_keywords', 'last_error')) {
    await knex.schema.alterTable('ad_negative_keywords', (t) => t.dropColumn('last_error'));
  }
};
