/**
 * Add the `channel`, `notes`, and `status` columns that the CRM-interaction
 * write path has assumed for a long time but that `customer_interactions`
 * (created in 20260401000023_crm.js with only interaction_type/subject/body/
 * metadata) never actually had.
 *
 * 13 insert sites across the workflow engine, lead attribution, health alerts,
 * invoice follow-ups, payment-lifecycle/account/renewal emails and the
 * scheduler write one or more of these columns. Every one of them throws
 * `column "channel" does not exist` (Postgres reports the first missing column;
 * `notes`/`status` are next behind it) and the row is silently dropped — the
 * automated customer-interaction timeline has been recording nothing.
 *
 * All three are added nullable with no default, so this is a metadata-only,
 * non-rewriting ALTER that cannot affect existing rows, reads, or queries.
 * Idempotent via hasColumn guards. A companion code change renames the
 * mislabeled `type:` key to `interaction_type:` in the workflow inserts so the
 * NOT NULL interaction_type constraint is also satisfied.
 */

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('customer_interactions'))) return;

  const [hasChannel, hasNotes, hasStatus] = await Promise.all([
    knex.schema.hasColumn('customer_interactions', 'channel'),
    knex.schema.hasColumn('customer_interactions', 'notes'),
    knex.schema.hasColumn('customer_interactions', 'status'),
  ]);

  await knex.schema.alterTable('customer_interactions', (t) => {
    if (!hasChannel) t.string('channel', 30); // 'sms' | 'email' | 'voice' | 'internal' | 'lead_source'
    if (!hasNotes) t.text('notes');
    if (!hasStatus) t.string('status', 30); // 'pending' | 'completed' | 'opted_in' | ...
  });
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('customer_interactions'))) return;

  const [hasChannel, hasNotes, hasStatus] = await Promise.all([
    knex.schema.hasColumn('customer_interactions', 'channel'),
    knex.schema.hasColumn('customer_interactions', 'notes'),
    knex.schema.hasColumn('customer_interactions', 'status'),
  ]);

  await knex.schema.alterTable('customer_interactions', (t) => {
    if (hasChannel) t.dropColumn('channel');
    if (hasNotes) t.dropColumn('notes');
    if (hasStatus) t.dropColumn('status');
  });
};
