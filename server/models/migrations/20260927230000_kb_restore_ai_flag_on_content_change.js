/**
 * An entry the weekly AI audit hid (status='flagged') returns to search when
 * its content changes — the change is the fix the flag asked for. A trigger,
 * not service code, because many writers rewrite knowledge_base.content
 * directly (auto-sync, the wiki compiler, WikiQA file-back, admin routes).
 *
 * Only AI-owned flags: the latest result='flagged' audit row must be an
 * 'ai-review' (a person's 'manual-flag' stays until a person clears it), and
 * wiki-sync mirrors are skipped — agronomic-wiki syncKbCopyTrust owns their
 * status. A writer that sets a status itself is left alone.
 */
exports.up = async function up(knex) {
  await knex.raw(`CREATE OR REPLACE FUNCTION kb_restore_ai_flag_on_content_change() RETURNS trigger AS $$
    BEGIN
      IF NEW.content IS DISTINCT FROM OLD.content
        AND OLD.status = 'flagged' AND NEW.status = 'flagged'
        AND COALESCE(OLD.source, '') <> 'wiki-sync'
        AND (
          SELECT a.audit_type FROM knowledge_base_audits a
          WHERE a.kb_entry_id = OLD.id AND a.audit_type IN ('ai-review', 'manual-flag')
            AND a.result = 'flagged'
          ORDER BY a.created_at DESC LIMIT 1
        ) = 'ai-review' THEN
        NEW.status := 'active';
      END IF;
      RETURN NEW;
    END;
  $$ LANGUAGE plpgsql;`);
  await knex.raw('DROP TRIGGER IF EXISTS kb_restore_ai_flag_on_content_change ON knowledge_base');
  await knex.raw(`CREATE TRIGGER kb_restore_ai_flag_on_content_change
    BEFORE UPDATE OF content ON knowledge_base
    FOR EACH ROW EXECUTE FUNCTION kb_restore_ai_flag_on_content_change()`);
};

exports.down = async function down(knex) {
  await knex.raw('DROP TRIGGER IF EXISTS kb_restore_ai_flag_on_content_change ON knowledge_base');
  await knex.raw('DROP FUNCTION IF EXISTS kb_restore_ai_flag_on_content_change()');
};
