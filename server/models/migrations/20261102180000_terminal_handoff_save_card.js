/**
 * terminal_handoff_tokens: a second kind of Tap to Pay handoff that SAVES a
 * card for Auto Pay and charges nothing (Book at the Table, PR 2).
 *
 *   kind                        'collect' (default: every row that exists today
 *                               and every invoice charge) or 'save_card'.
 *   appointment_card_request_id the request the saved card completes. SET NULL
 *                               so a deleted request never blocks the row's
 *                               cleanup.
 *   stripe_setup_intent_id      the card_present SetupIntent minted with the
 *                               row; /complete-setup checks it.
 *   consent_text_version        the card consent version the technician's app
 *                               attested at mint time.
 *   disclosure_version          the sticky cancel-window disclosure echo the
 *                               /secure page rendered (sticky_v1), or NULL.
 *
 * Additive only. Existing rows read as 'collect', so the payment sweepers and
 * the orphaned-validated partial index keep their meaning (save_card rows have
 * no stripe_payment_intent_id and the 5-minute sweeper now filters on kind).
 */

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('terminal_handoff_tokens'))) return;
  const has = (col) => knex.schema.hasColumn('terminal_handoff_tokens', col);
  const needKind = !(await has('kind'));
  const needRequest = !(await has('appointment_card_request_id'));
  const needSetup = !(await has('stripe_setup_intent_id'));
  const needConsent = !(await has('consent_text_version'));
  const needDisclosure = !(await has('disclosure_version'));
  if (!(needKind || needRequest || needSetup || needConsent || needDisclosure)) return;
  await knex.schema.alterTable('terminal_handoff_tokens', (t) => {
    if (needKind) t.string('kind', 16).notNullable().defaultTo('collect');
    if (needRequest) {
      t.uuid('appointment_card_request_id')
        .references('id').inTable('appointment_card_requests').onDelete('SET NULL');
    }
    if (needSetup) t.string('stripe_setup_intent_id', 100);
    if (needConsent) t.string('consent_text_version', 64);
    if (needDisclosure) t.string('disclosure_version', 32);
  });
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('terminal_handoff_tokens'))) return;
  const has = (col) => knex.schema.hasColumn('terminal_handoff_tokens', col);
  const hadRequest = await has('appointment_card_request_id');
  const dropCols = [];
  for (const col of ['kind', 'stripe_setup_intent_id', 'consent_text_version', 'disclosure_version']) {
    if (await has(col)) dropCols.push(col);
  }
  if (!hadRequest && dropCols.length === 0) return;
  await knex.schema.alterTable('terminal_handoff_tokens', (t) => {
    if (hadRequest) {
      t.dropForeign(['appointment_card_request_id']);
      t.dropColumn('appointment_card_request_id');
    }
    dropCols.forEach((col) => t.dropColumn(col));
  });
};
