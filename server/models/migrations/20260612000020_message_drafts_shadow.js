/**
 * message_drafts → shadow-draft telemetry (SMS brand-voice loop, Phase B).
 *
 * Adds 'shadow' to the status enum: silent house-voice drafts of what the
 * AI would have replied to an inbound customer SMS. Shadow rows are never
 * sent and never enter the approval queue — admin-drafts lists
 * status='pending' by default and its approve/revise routes require
 * status='pending', so 'shadow' is structurally unsendable.
 *
 * Telemetry columns let a later judge pass pair each draft with the reply
 * a human actually sent and score per intent class:
 *   drafter          which engine produced the draft ('house_voice' vs legacy NULL)
 *   model            resolved model id at draft time
 *   prompt_version   prompt contract version ('house_voice_v1')
 *   intended_actions declared (not executed) actions: escalate/book/payment link
 *   scheduling_intent high-stakes class flag — shadow drafts INCLUDE scheduling
 *                    messages (a shadow row can't send; the historical
 *                    auto-reply incident was about sending)
 *   draft_ms         generation latency
 */
exports.up = async function (knex) {
  await knex.raw('ALTER TABLE message_drafts DROP CONSTRAINT IF EXISTS message_drafts_status_check');
  await knex.raw(
    `ALTER TABLE message_drafts ADD CONSTRAINT message_drafts_status_check CHECK (status IN ('pending','approved','revised','rejected','sent','shadow'))`
  );

  const cols = await knex('message_drafts').columnInfo();
  await knex.schema.alterTable('message_drafts', (t) => {
    if (!cols.drafter) t.string('drafter', 40);
    if (!cols.model) t.string('model', 80);
    if (!cols.prompt_version) t.string('prompt_version', 40);
    if (!cols.intended_actions) t.jsonb('intended_actions');
    if (!cols.scheduling_intent) t.boolean('scheduling_intent').defaultTo(false);
    if (!cols.draft_ms) t.integer('draft_ms');
  });

  await knex.raw(
    `CREATE INDEX IF NOT EXISTS message_drafts_shadow_created_idx ON message_drafts (created_at) WHERE status = 'shadow'`
  );
};

exports.down = async function (knex) {
  await knex.raw('DROP INDEX IF EXISTS message_drafts_shadow_created_idx');

  // Shadow rows would violate the restored constraint — park them as rejected.
  await knex('message_drafts').where({ status: 'shadow' }).update({ status: 'rejected' });
  await knex.raw('ALTER TABLE message_drafts DROP CONSTRAINT IF EXISTS message_drafts_status_check');
  await knex.raw(
    `ALTER TABLE message_drafts ADD CONSTRAINT message_drafts_status_check CHECK (status IN ('pending','approved','revised','rejected','sent'))`
  );

  const cols = await knex('message_drafts').columnInfo();
  await knex.schema.alterTable('message_drafts', (t) => {
    if (cols.drafter) t.dropColumn('drafter');
    if (cols.model) t.dropColumn('model');
    if (cols.prompt_version) t.dropColumn('prompt_version');
    if (cols.intended_actions) t.dropColumn('intended_actions');
    if (cols.scheduling_intent) t.dropColumn('scheduling_intent');
    if (cols.draft_ms) t.dropColumn('draft_ms');
  });
};
