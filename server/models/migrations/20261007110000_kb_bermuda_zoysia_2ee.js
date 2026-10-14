/**
 * Owner ruling 2026-10-06 ("label is right"): the staff knowledge-base article
 * "Recognition + Fusilade II — Bermudagrass Suppression in St. Augustine"
 * (slug fusilade-ii-bermuda-bahia-eradication, seeded by 20260808000001) says
 * under "Critical warnings": "The mix kills bermudagrass AND zoysiagrass —
 * confirm the lawn is St. Augustine first." That is wrong for zoysia.
 *
 * Syngenta's FIFRA Section 2(ee) Recommendation dated 2023-03-28 (Recognition
 * EPA 100-1658 + Fusilade II T&O EPA 100-1084), "Tank Mix for Weed Control on
 * Additional Pests In Zoysiagrass", lists Florida: Recognition 1.29-1.95 oz/A
 * (0.03-0.045 oz per 1,000 sq ft) + Fusilade II 12-24 oz/A (0.367-0.55 oz per
 * 1,000 sq ft) + non-ionic surfactant (>=80% active, 0.25-0.5% v/v) controls
 * bermudagrass and goosegrass in zoysiagrass, repeated on a 4- to 6-week
 * interval. Fusilade II ALONE at 12-24 oz/A may injure zoysiagrass. Sources:
 * https://www.syngenta-us.com/newsroom/news_release_detail?id=224989 and
 * https://lawnandlandscape.com/news/syngenta-debuts-recognition-herbicide.
 *
 * Targeted replacement of that one line in the article (the Celsius pattern in
 * 20260808000001) so any other admin edit to the article survives:
 *   - Exact-line match only. A row whose line an admin already edited, a row
 *     that no longer exists, and a second run are all no-ops (no audit event).
 *   - The title changes only if it still equals the 20260808000001 value;
 *     'zoysia' and '2ee' tags are added only if absent.
 *   - The article's knowledge_embeddings chunks (source='kb', source_id=slug)
 *     are purged, exactly as 20260808000001 did, so chunk search cannot serve
 *     the old line until the next index sync re-chunks the corrected article.
 *   - One audit_log event for the row it changes (waves-db rule for
 *     admin-editable rows); down() is a documented no-op.
 *
 * Seeds are corrected in the same PR (scripts/seed-knowledge-base.js) so fresh
 * environments come up right.
 */

const MIGRATION = '20261007110000_kb_bermuda_zoysia_2ee';
const KB_SLUG = 'fusilade-ii-bermuda-bahia-eradication';
const OLD_TITLE = 'Recognition + Fusilade II — Bermudagrass Suppression in St. Augustine';
const NEW_TITLE = 'Recognition + Fusilade II — Bermudagrass Suppression in St. Augustine and Zoysia';
const ADD_TAGS = ['zoysia', '2ee'];

const OLD_LINE = '- The mix kills bermudagrass AND zoysiagrass — confirm the lawn is St. Augustine first.';
const NEW_LINES = [
  '- Zoysiagrass: the Recognition + Fusilade II tank mix is supported on established zoysia under the Syngenta FIFRA 2(ee) recommendation (2023-03-28, FL listed) at Recognition 0.03–0.045 oz + Fusilade II 0.367–0.55 oz per 1,000 sq ft. A 2(ee) is not the printed label: keep it on hand when applying. Fusilade II ALONE injures zoysia.',
  '- The mix kills bermudagrass (including bermudagrass lawns): confirm the lawn is St. Augustine or zoysia first.',
].join('\n');

function parseTags(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('knowledge_base'))) return;
  const article = await knex('knowledge_base').where({ slug: KB_SLUG }).first();
  if (!article || typeof article.content !== 'string' || !article.content.includes(OLD_LINE)) return;

  const update = {
    content: article.content.replace(OLD_LINE, () => NEW_LINES),
    last_verified_at: new Date(),
    verified_by: 'migration-kb-bermuda-zoysia-2ee',
  };
  if (article.title === OLD_TITLE) update.title = NEW_TITLE;
  const tags = parseTags(article.tags);
  const nextTags = [...tags, ...ADD_TAGS.filter((tag) => !tags.includes(tag))];
  if (nextTags.length !== tags.length) update.tags = JSON.stringify(nextTags);

  await knex('knowledge_base').where({ id: article.id }).update(update);

  // /api/mcp serves raw chunk snippets from knowledge_embeddings, and the index
  // rebuild is nightly and gated — purge this article's chunks so the old line
  // is not served (same handling as 20260808000001).
  if (await knex.schema.hasTable('knowledge_embeddings')) {
    await knex('knowledge_embeddings').where({ source: 'kb', source_id: KB_SLUG }).del();
  }

  if (await knex.schema.hasTable('audit_log')) {
    const { recordAuditEvent } = require('../../services/audit-log');
    await recordAuditEvent({
      actor_type: 'system',
      action: 'knowledge_base.bermuda_zoysia_2ee_line',
      resource_type: 'knowledge_base',
      resource_id: String(article.id),
      metadata: {
        migration: MIGRATION,
        slug: KB_SLUG,
        before: { line: OLD_LINE, title: article.title },
        after: { lines: NEW_LINES, title: update.title || article.title },
        source: 'Syngenta FIFRA 2(ee) Recommendation 2023-03-28 (Recognition EPA 100-1658 + Fusilade II T&O EPA 100-1084), zoysiagrass, FL listed',
      },
      critical: true,
      trx: knex,
    });
  }
};

// Documented no-op (waves-db rule for data corrections that keep admin edits):
// matching the new lines does not prove this migration wrote them, so a revert
// could erase an operator's identical edit, and the old line was wrong. The
// audit_log event keeps the before/after for a person to restore if ever needed.
exports.down = async function down() {};

exports._OLD_LINE = OLD_LINE;
exports._NEW_LINES = NEW_LINES;
exports._OLD_TITLE = OLD_TITLE;
exports._NEW_TITLE = NEW_TITLE;
exports._AUDIT_ACTION = 'knowledge_base.bermuda_zoysia_2ee_line';
