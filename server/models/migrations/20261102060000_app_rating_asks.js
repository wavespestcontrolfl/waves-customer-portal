// Store rating pop-up in the Waves customer app (owner 2026-11-02, "do the
// rating for everyone"), dark behind GATE_APP_RATING_PROMPT.
//
//   app_rating_asks  one row each time the server let the app ask the store
//                    (Apple's rating card on iPhone, Google Play's on Android)
//                    for its rating pop-up. mode 'on' = the app asked;
//                    mode 'shadow' = the gate was in shadow, the app showed
//                    nothing and the row only counts who would have been
//                    asked. The store alone decides whether its card shows
//                    and never says what the customer did, so a row means
//                    "asked", nothing more. The 120-day spacing reads the
//                    newest row of the same mode (services/app-rating-prompt.js).
//
// No data is written here; the table starts empty.
exports.up = async function up(knex) {
  if (await knex.schema.hasTable('app_rating_asks')) return;
  await knex.schema.createTable('app_rating_asks', (t) => {
    t.uuid('id').primary().defaultTo(knex.fn.uuid());
    t.uuid('customer_id').notNullable().references('id').inTable('customers').onDelete('CASCADE');
    t.string('platform', 10).notNullable();
    t.string('mode', 10).notNullable();
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.index(['customer_id', 'mode', 'created_at'], 'app_rating_asks_customer_mode_created_idx');
  });
  await knex.raw(`ALTER TABLE app_rating_asks ADD CONSTRAINT app_rating_asks_platform_check
    CHECK (platform IN ('ios', 'android'))`);
  await knex.raw(`ALTER TABLE app_rating_asks ADD CONSTRAINT app_rating_asks_mode_check
    CHECK (mode IN ('shadow', 'on'))`);
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('app_rating_asks');
};
