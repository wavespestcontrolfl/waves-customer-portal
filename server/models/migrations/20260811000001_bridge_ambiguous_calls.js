/**
 * Persisted bridge-ambiguity records (owner ruling 2026-08-11, closing the
 * GH-r24 P1 on PR #3303).
 *
 * When the Google Ads call bridge finds SEVERAL equally plausible CRM calls
 * for one ads-reported call, it deliberately claims none of them, and every
 * lead linked to a candidate call is held out of the unclaimed→organic
 * fallback — the organic label is irreversible. That exclusion set was
 * rebuilt each morning from the bridge's fixed 30-day scan, while the
 * organic sweep has no upper bound: the day a candidate call aged past the
 * window, the system forgot it was ever ambiguous and the waiting lead took
 * the permanent organic label the hold-back exists to prevent.
 *
 * One row per candidate CALL (the exclusion machinery already maps calls to
 * leads through the shared linkage arms at sweep time — persisting leads
 * here would just duplicate that logic). A row holds its leads out of the
 * organic sweep until POSITIVELY resolved: the call gets bridged (claimed
 * paid), or a healthy, uncapped rescan that still covers the call's date no
 * longer reports it ambiguous. Absence from an aged-out scan resolves
 * nothing — that non-evidence is exactly the bug this table closes. An
 * unresolvable ambiguity therefore holds its lead out of attribution stats
 * permanently; the owner chose that trade over a silent wrong paid/organic
 * label.
 *
 * ON DELETE CASCADE: a purged call cannot be re-scanned or bridged, and its
 * linkage arms match nothing once the call_log row is gone — the record
 * would be dead weight that holds nothing out.
 */

exports.up = async function up(knex) {
  if (await knex.schema.hasTable('bridge_ambiguous_calls')) return;
  await knex.schema.createTable('bridge_ambiguous_calls', (t) => {
    t.uuid('call_log_id').primary().references('id').inTable('call_log').onDelete('CASCADE');
    // Denormalized for the sweep's sid-exclusion arm (leads link by sid
    // without a call_log join); the call's sid never changes after mint.
    t.string('twilio_call_sid');
    t.timestamp('first_seen_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('last_seen_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('resolved_at', { useTz: true });
    t.string('resolve_reason', 40);
  });
  // The daily read is "all open rows" — keep it index-backed as history grows.
  await knex.raw(
    'CREATE INDEX IF NOT EXISTS bridge_ambiguous_calls_open_index ON bridge_ambiguous_calls (call_log_id) WHERE resolved_at IS NULL',
  );
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('bridge_ambiguous_calls'))) return;
  await knex.raw('DROP INDEX IF EXISTS bridge_ambiguous_calls_open_index');
  await knex.schema.dropTable('bridge_ambiguous_calls');
};
