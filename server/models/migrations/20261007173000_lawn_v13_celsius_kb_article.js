/**
 * Lawn protocol v13 count caps (Codex round 7 on #6104): the live staff knowledge-base article
 * "Celsius WG — Application Limits" (slug celsius-wg-application-limits, seeded by
 * scripts/seed-knowledge-base.js) says "Max 3 Applications Per Property Per Year", tells the tech to
 * flag customers "approaching 3rd application" and to stop only after 3. Wiki QA reads the article
 * directly and its chunks sit in knowledge_embeddings. Under the v13 lawn program the limit is 2
 * applications per lawn per year (owner 2026-10-06), so the article now states both numbers:
 *
 *   Label maximum: 3 applications per year per property. Waves lawn program (v13): max 2
 *   applications per lawn per year — do not plan a third.
 *
 * Gate-neutral on purpose: the label figure stays true whatever the program, and the v13 figure is
 * named as the v13 program's.
 *
 * Targeted line replacements (the 20261007110000 pattern), so any other admin edit survives:
 *   - the article is changed only while it still holds the seeded label-restriction line (an article an
 *     admin rewrote, a missing row and a second run are all no-ops);
 *   - each of the four seeded lines is replaced only where that exact line is still present;
 *   - the article's knowledge_embeddings chunks (source 'kb', source_id the slug) are purged, as
 *     20260808000001 and 20261007110000 did, so chunk search cannot serve the old text until the
 *     next index sync re-chunks the corrected article;
 *   - one audit_log event records the lines before and after.
 *
 * down(): reverses a line only where the exact new line is still present, purges the chunks again
 * and records an audit event; an edited line is left as it is.
 */

const MIGRATION = '20261007173000_lawn_v13_celsius_kb_article';
const KB_SLUG = 'celsius-wg-application-limits';
const AUDIT_ACTION = 'knowledge_base.celsius_v13_cap_text';
const AUDIT_ACTION_DOWN = 'knowledge_base.celsius_v13_cap_text_reverted';

const V13_SENTENCE = 'Label maximum: 3 applications per year per property. Waves lawn program (v13): max 2 applications per lawn per year — do not plan a third.';

// The key line: its presence says the article still carries the seeded restriction text.
const KEY_OLD = 'Celsius WG (thiencarbazone-methyl + iodosulfuron + dicamba) is limited to a MAXIMUM of 3 applications per property per calendar year per the label.';
const REPLACEMENTS = [
  {
    old: '# Celsius WG — Max 3 Applications Per Property Per Year',
    next: '# Celsius WG — Label Max 3 Applications Per Property Per Year; Waves v13 Max 2 Per Lawn',
  },
  {
    old: KEY_OLD,
    next: `${KEY_OLD}\n\n## Waves lawn program (v13)\n${V13_SENTENCE}`,
  },
  {
    old: '- Flag customers approaching 3rd application — switch to alternative (Dismiss, Certainty, or manual pulling)',
    next: '- Flag customers approaching their 2nd application under the v13 program (the 3rd is the label maximum) — switch to alternative (Dismiss, Certainty, or manual pulling)',
  },
  {
    old: '- Do NOT apply if property has received 3 applications this calendar year regardless of who applied them',
    next: '- Do NOT apply if the property has received 2 applications this calendar year under the v13 program, or 3 under the label, regardless of who applied them',
  },
];

async function purgeChunks(knex) {
  if (await knex.schema.hasTable('knowledge_embeddings')) {
    await knex('knowledge_embeddings').where({ source: 'kb', source_id: KB_SLUG }).del();
  }
}

async function audit(knex, article, action, changed) {
  if (!(await knex.schema.hasTable('audit_log'))) return;
  const { recordAuditEvent } = require('../../services/audit-log');
  await recordAuditEvent({
    actor_type: 'system',
    action,
    resource_type: 'knowledge_base',
    resource_id: String(article.id),
    metadata: { migration: MIGRATION, slug: KB_SLUG, changed },
    critical: true,
    trx: knex,
  });
}

// Replaces each line (old -> next, or the reverse) that is still present exactly; returns the new
// content and the list of lines changed.
function applyReplacements(content, direction) {
  let next = content;
  const changed = [];
  for (const row of REPLACEMENTS) {
    const from = direction === 'up' ? row.old : row.next;
    const to = direction === 'up' ? row.next : row.old;
    // The new key line starts with the old one: a line already rewritten is never rewritten twice.
    if (!next.includes(from) || (direction === 'up' && next.includes(row.next))) continue;
    next = next.replace(from, () => to);
    changed.push({ before: from, after: to });
  }
  return { next, changed };
}

async function rewrite(knex, direction, action) {
  if (!(await knex.schema.hasTable('knowledge_base'))) return;
  const article = await knex('knowledge_base').where({ slug: KB_SLUG }).first();
  if (!article || typeof article.content !== 'string') return;
  // up: only an article that still carries the seeded restriction line; down: only one that still carries the new one.
  const keyLine = direction === 'up' ? KEY_OLD : REPLACEMENTS[1].next;
  if (!article.content.includes(keyLine)) return;
  const { next, changed } = applyReplacements(article.content, direction);
  if (!changed.length) return;
  await knex('knowledge_base').where({ id: article.id }).update({
    content: next,
    last_verified_at: new Date(),
    verified_by: direction === 'up' ? 'migration-lawn-v13-celsius-kb-article' : 'migration-lawn-v13-celsius-kb-article-down',
  });
  await purgeChunks(knex);
  await audit(knex, article, action, changed);
}

exports.up = (knex) => rewrite(knex, 'up', AUDIT_ACTION);
exports.down = (knex) => rewrite(knex, 'down', AUDIT_ACTION_DOWN);

exports._KB_SLUG = KB_SLUG;
exports._KEY_OLD = KEY_OLD;
exports._REPLACEMENTS = REPLACEMENTS;
exports._V13_SENTENCE = V13_SENTENCE;
exports._AUDIT_ACTION = AUDIT_ACTION;
exports._AUDIT_ACTION_DOWN = AUDIT_ACTION_DOWN;
