/**
 * Lawn protocol v13 count caps (Codex round 10 on #6104): the live "Celsius WG — Application Limits"
 * article, as 20261007173000 left it, tells a tech whose lawn is nearing the Celsius cap to switch to
 * "Dismiss, Certainty, or manual pulling". Certainty is applied WITH Celsius and has the same
 * 2-per-lawn-per-year cap under the v13 program, so it is not the switch; the recipe says "use
 * Blindside after the Celsius cap", and Blindside is also capped at 2 per lawn per year. Dismiss NXT
 * is a November-to-March sedge tool, not a general switch.
 *
 * Two exact-line replacements (guarded: a line an admin changed, a missing article and a second run
 * are no-ops, and the rest of the article is never touched):
 *   - the "Flag customers approaching their 2nd application" line names Blindside (and its own cap)
 *     and says why Certainty is not the switch;
 *   - the "Certainty (sulfosulfuron) — good for sedge pressure" alternative says it is capped at 2
 *     per lawn per year under v13 and goes with Celsius.
 *
 * The article's knowledge_embeddings chunks are purged, as 173000 did, so search re-chunks the
 * corrected text; one audit_log event records the lines; down() reverses a line only where the exact
 * new line is still present, purges the chunks again and audits.
 */
const MIGRATION = '20261007176000_lawn_v13_celsius_kb_after_cap';
const KB_SLUG = 'celsius-wg-application-limits';
const AUDIT_ACTION = 'knowledge_base.celsius_v13_after_cap_text';
const AUDIT_ACTION_DOWN = 'knowledge_base.celsius_v13_after_cap_text_reverted';

const REPLACEMENTS = [
  {
    old: '- Flag customers approaching their 2nd application under the v13 program (the 3rd is the label maximum) — switch to alternative (Dismiss, Certainty, or manual pulling)',
    next: '- Flag customers approaching their 2nd application under the v13 program (the 3rd is the label maximum) — after the Celsius cap use Blindside (also capped at 2 applications per lawn per year under v13) or manual pulling. Certainty goes with Celsius and shares the same 2 per lawn per year, so it is not the switch',
  },
  {
    old: '- Certainty (sulfosulfuron) — good for sedge pressure',
    next: '- Certainty (sulfosulfuron) — good for sedge pressure; under v13 it is capped at 2 applications per lawn per year and goes with Celsius, so it does not replace a capped Celsius pass',
  },
];

async function rewrite(knex, direction, action) {
  if (!(await knex.schema.hasTable('knowledge_base'))) return;
  const article = await knex('knowledge_base').where({ slug: KB_SLUG }).first();
  if (!article || typeof article.content !== 'string') return;
  let content = article.content;
  const changed = [];
  for (const row of REPLACEMENTS) {
    const from = direction === 'up' ? row.old : row.next;
    const to = direction === 'up' ? row.next : row.old;
    // The new Certainty line starts with the old one: a line already rewritten is never rewritten twice.
    if (!content.includes(from) || (direction === 'up' && content.includes(row.next))) continue;
    content = content.replace(from, () => to);
    changed.push({ before: from, after: to });
  }
  if (!changed.length) return;
  await knex('knowledge_base').where({ id: article.id }).update({
    content,
    last_verified_at: new Date(),
    verified_by: direction === 'up' ? 'migration-lawn-v13-celsius-kb-after-cap' : 'migration-lawn-v13-celsius-kb-after-cap-down',
  });
  if (await knex.schema.hasTable('knowledge_embeddings')) {
    await knex('knowledge_embeddings').where({ source: 'kb', source_id: KB_SLUG }).del();
  }
  if (await knex.schema.hasTable('audit_log')) {
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
}

exports.up = (knex) => rewrite(knex, 'up', AUDIT_ACTION);
exports.down = (knex) => rewrite(knex, 'down', AUDIT_ACTION_DOWN);

exports._KB_SLUG = KB_SLUG;
exports._REPLACEMENTS = REPLACEMENTS;
exports._AUDIT_ACTION = AUDIT_ACTION;
exports._AUDIT_ACTION_DOWN = AUDIT_ACTION_DOWN;
