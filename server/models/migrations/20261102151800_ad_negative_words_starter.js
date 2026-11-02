// The starter list for ad_negative_words (owner plan A, 2026-11-02, PR 2 of 2): the words the owner approved on the
// plan page, wildlife and job seekers. He left free / diy / how to out on purpose. Each word is inserted only when the
// list has no row for it (ON CONFLICT DO NOTHING), so a word the owner already removed or re-added keeps his state.
// One audit_log row per word this migration adds. Down is a documented no-op (waves-db SKILL): once the list is live
// the owner edits it, and the audit rows name every word this migration added.
const { recordAuditEvent } = require('../../services/audit-log');

// audit_log.action is varchar(96): `migration:<name>:insert` must fit, so the name stays short.
const MIGRATION = '20261102151800_ad_negative_words_starter';

const STARTER_WORDS = [
  'squirrel', 'squirrels', 'raccoon', 'raccoons', 'opossum', 'armadillo', 'snake', 'snakes',
  'bat removal', 'wildlife', 'jobs', 'careers', 'hiring', 'salary', 'license', 'training',
];

exports.STARTER_WORDS = STARTER_WORDS;

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('ad_negative_words'))) return;
  const canAudit = await knex.schema.hasTable('audit_log');
  const added = await knex('ad_negative_words')
    .insert(STARTER_WORDS.map((text) => ({ text, added_by: 'starter-list' })))
    .onConflict('text')
    .ignore()
    .returning(['id', 'text']);
  if (!canAudit) return;
  for (const row of added) {
    // audit_log.actor_id is a uuid column: the migration names itself in action + metadata.
    await recordAuditEvent({
      actor_type: 'system',
      action: `migration:${MIGRATION}:insert`,
      resource_type: 'ad_negative_words',
      resource_id: String(row.id),
      metadata: { migration: MIGRATION, text: row.text, before: null, after: { text: row.text, added_by: 'starter-list' } },
      critical: true,
      trx: knex,
    });
  }
};

// Documented no-op: see the header. The audit rows name every word this migration added.
exports.down = async function down() {};
