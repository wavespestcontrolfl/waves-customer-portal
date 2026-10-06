/**
 * Follow-up to 20261007110000_kb_bermuda_zoysia_2ee (pushed, so frozen): two
 * wording fixes to the zoysia line it wrote in the staff KB article
 * fusilade-ii-bermuda-bahia-eradication, and a chunk purge that also runs when
 * the article no longer carries the old wrong line.
 *   - Fusilade II is a liquid: its rate is fl oz per 1,000 sq ft (Recognition
 *     stays dry oz).
 *   - The solo-Fusilade warning keeps the 2(ee)'s rate and "may": Fusilade II
 *     ALONE at 12-24 oz/A may injure zoysia (the label's standalone zoysia rate
 *     is lower).
 * Exact-sentence replacement only, so an admin edit to the line is left alone
 * (no write, no audit event). The article's knowledge_embeddings chunks are
 * purged whenever the article no longer contains the original wrong line
 * ("kills bermudagrass AND zoysiagrass"), so chunk search cannot keep serving
 * it when the nightly index rebuild is off. One audit_log event per row write;
 * down() is a documented no-op (waves-db rule).
 */

const MIGRATION = '20261007110100_kb_bermuda_zoysia_2ee_wording';
const KB_SLUG = 'fusilade-ii-bermuda-bahia-eradication';
const ORIGINAL_WRONG = 'The mix kills bermudagrass AND zoysiagrass';
const OLD_SENTENCE = 'at Recognition 0.03–0.045 oz + Fusilade II 0.367–0.55 oz per 1,000 sq ft. A 2(ee) is not the printed label: keep it on hand when applying. Fusilade II ALONE injures zoysia.';
const NEW_SENTENCE = 'at Recognition 0.03–0.045 oz + Fusilade II 0.367–0.55 fl oz per 1,000 sq ft. A 2(ee) is not the printed label: keep it on hand when applying. Fusilade II ALONE at 12–24 fl oz/acre may injure zoysia.';

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('knowledge_base'))) return;
  const article = await knex('knowledge_base').where({ slug: KB_SLUG }).forUpdate().first();
  if (!article || typeof article.content !== 'string') return;

  if (article.content.includes(OLD_SENTENCE)) {
    const changed = await knex('knowledge_base')
      .where({ id: article.id, content: article.content })
      .update({
        content: article.content.replace(OLD_SENTENCE, () => NEW_SENTENCE),
        last_verified_at: new Date(),
        verified_by: 'migration-kb-bermuda-zoysia-2ee-wording',
      });
    if (changed && (await knex.schema.hasTable('audit_log'))) {
      const { recordAuditEvent } = require('../../services/audit-log');
      await recordAuditEvent({
        actor_type: 'system',
        action: 'knowledge_base.bermuda_zoysia_2ee_wording',
        resource_type: 'knowledge_base',
        resource_id: String(article.id),
        metadata: { migration: MIGRATION, slug: KB_SLUG, before: OLD_SENTENCE, after: NEW_SENTENCE },
        critical: true,
        trx: knex,
      });
    }
  }

  // The article no longer says the mix kills zoysia (this PR or an admin fixed it):
  // drop its chunks so the old text is not served before the next index sync.
  const current = await knex('knowledge_base').where({ id: article.id }).first('content');
  if (current && typeof current.content === 'string' && !current.content.includes(ORIGINAL_WRONG)
    && (await knex.schema.hasTable('knowledge_embeddings'))) {
    await knex('knowledge_embeddings').where({ source: 'kb', source_id: KB_SLUG }).del();
  }
};

// Documented no-op: the audit event keeps the before/after for a person to restore.
exports.down = async function down() {};

exports._OLD_SENTENCE = OLD_SENTENCE;
exports._NEW_SENTENCE = NEW_SENTENCE;
