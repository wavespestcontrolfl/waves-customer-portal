// outbox_messages.commitment_id carried a bare per-column UNIQUE constraint
// (20260909000092_reschedule_link_promises.js) on the assumption that a
// promised-link commitment gets exactly one outbox row, ever. A replacement
// or adopted recording (call-commitments.js upsertCommitments) resets an
// untouched AI commitment back to status 'open' and hands it a NEW
// processing_generation on the very next reprocess pass — but if that
// commitment_id already owns a delivered/cancelled outbox row from before,
// the bare unique constraint means no second row can ever be inserted for
// it, and stagePromises' own `leftJoin ... whereNull('o.id')` guard treats
// "a row already exists" as "already staged" regardless of terminal status
// or generation — so the reopened promise stays open in call_commitments
// forever with no live outbox row ever working it again.
//
// commitment_generation (a copy of the commitment's own processing_generation
// at staging time) plus a composite (commitment_id, commitment_generation)
// uniqueness lets a NEW generation of the SAME commitment stage its OWN
// outbox row — a fresh attempt, not an overwrite — while the OLD row stays
// exactly as it is: a durable record of what happened under the prior
// recording. The constraint is discovered and dropped by its actual name
// (not a guessed one) since knex's auto-generated name for a plain
// `.unique()` is an implementation detail, not something this migration
// should gamble on matching by string literal.
exports.up = async function up(knex) {
  const hasCol = await knex.schema.hasColumn('outbox_messages', 'commitment_generation');
  if (!hasCol) {
    await knex.schema.alterTable('outbox_messages', (t) => {
      t.integer('commitment_generation').nullable();
    });
  }
  await knex.raw(`
    DO $$
    DECLARE
      con_name text;
    BEGIN
      SELECT conname INTO con_name
      FROM pg_constraint
      WHERE conrelid = 'outbox_messages'::regclass
        AND contype = 'u'
        AND conkey = (
          SELECT array_agg(attnum ORDER BY attnum)
          FROM pg_attribute
          WHERE attrelid = 'outbox_messages'::regclass AND attname = 'commitment_id'
        );
      IF con_name IS NOT NULL THEN
        EXECUTE format('ALTER TABLE outbox_messages DROP CONSTRAINT %I', con_name);
      END IF;
    END $$;
  `);
  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS outbox_messages_commitment_id_generation_unique
    ON outbox_messages (commitment_id, commitment_generation)
    WHERE commitment_id IS NOT NULL
  `);
};

exports.down = async function down(knex) {
  await knex.raw('DROP INDEX IF EXISTS outbox_messages_commitment_id_generation_unique');
  // The original bare-column constraint is NOT restored on rollback: by the
  // time anyone rolls this back, more than one generation may already exist
  // per commitment_id, and re-adding a bare UNIQUE(commitment_id) would fail
  // outright against that data. Down here is "remove what this migration
  // added," not "guarantee a clean reverse."
};
