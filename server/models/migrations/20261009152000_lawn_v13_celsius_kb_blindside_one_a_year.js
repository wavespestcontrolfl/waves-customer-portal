/**
 * Lawn protocol v13 final pass, part 3 (Codex round 2 on #6187): the live "Celsius WG — Application Limits" article.
 *
 * 20261007176000 wrote into the article that, after the Celsius cap, a tech uses "Blindside (also capped at 2 applications per
 * lawn per year under v13)". Blindside is now held to ONE application a year at 0.149 oz per 1,000 sq ft (label EPA 279-3411:
 * warm-season rate 0.149 to 0.23 oz a pass, no more than 0.23 oz per 1,000 sq ft a year; see 20261009151000 and
 * config/lawn-v13-count-caps.js), so the article would tell a tech something the app no longer allows.
 *
 * This replaces only that Blindside statement (an exact-text replacement, the mechanism of 20261007176000):
 *   old  use Blindside (also capped at 2 applications per lawn per year under v13) or manual pulling
 *   new  use Blindside (1 application per lawn per year at 0.149 oz per 1,000 sq ft; label: warm-season rate 0.149 to 0.23 oz
 *        a pass, no more than 0.23 oz per 1,000 sq ft a year) or manual pulling
 * Guarded: it writes only while the article still holds the exact old text. A person's edit of that line, a missing article and a
 * second run are no-ops (an edit is logged and left). The rest of the article is never touched. The article's knowledge_embeddings
 * chunks are purged so search re-chunks the corrected text, last_verified_at and verified_by are set, and one audit_log event
 * records the replacement.
 *
 * down() puts the old text back only while the article still holds the exact new text, purges the chunks again and audits.
 *
 * Why this is its own file: 20261009151000 returns early while a visit or a completion references a v13 protocol, which is right
 * for protocol and catalog facts but has nothing to do with an article. The two concerns have separate guards, so each has its own down().
 *
 * How the older KB downs behave after this write (rollback runs newest first, so this down() restores the old text before any of them):
 *   - 20261007176000 rewrites its two lines back only where the exact new line is present. Its Flag line contains the old Blindside
 *     text; if this down() was skipped (the line was edited by a person, or the new text is still there), the full line no longer
 *     matches and 176000's down() skips THAT line and leaves the corrected Blindside wording in place. Its Certainty line is
 *     unaffected. A skip, never a wrong restore.
 *   - 20261007177000 and 20261007179500 act on the Dismiss NXT line only. Not read here.
 *   - 20261007173000 (the article) and 20260808000001 (the Fusilade line) act on other lines.
 */
const MIGRATION = '20261009152000_lawn_v13_celsius_kb_blindside_one_a_year';
const KB_SLUG = 'celsius-wg-application-limits';
const AUDIT_ACTION = 'knowledge_base.celsius_blindside_one_a_year';
const AUDIT_ACTION_DOWN = 'knowledge_base.celsius_blindside_one_a_year_reverted';
const LOG = '[lawn-v13-celsius-kb-blindside-one-a-year]';

const OLD = 'use Blindside (also capped at 2 applications per lawn per year under v13) or manual pulling';
const NEXT = 'use Blindside (1 application per lawn per year at 0.149 oz per 1,000 sq ft; label: warm-season rate 0.149 to 0.23 oz a pass, no more than 0.23 oz per 1,000 sq ft a year) or manual pulling';

async function rewrite(knex, direction, action) {
  if (!(await knex.schema.hasTable('knowledge_base'))) return;
  const article = await knex('knowledge_base').where({ slug: KB_SLUG }).first();
  if (!article || typeof article.content !== 'string') return;
  const from = direction === 'up' ? OLD : NEXT;
  const to = direction === 'up' ? NEXT : OLD;
  if (!article.content.includes(from)) {
    // Up with the new text already there is the second run; anything else is a person's edit (or the article never had the line).
    if (direction === 'up' && !article.content.includes(NEXT)) console.log(`${LOG} the Blindside statement is not the text 20261007176000 wrote (edited by a person?): article left as it is`);
    if (direction === 'down' && article.content.includes(OLD)) return;
    if (direction === 'down') console.log(`${LOG} the new Blindside statement is gone (edited by a person?): article left as it is`);
    return;
  }
  await knex('knowledge_base').where({ id: article.id }).update({
    content: article.content.replace(from, () => to),
    last_verified_at: new Date(),
    verified_by: direction === 'up' ? 'migration-lawn-v13-celsius-kb-blindside-one-a-year' : 'migration-lawn-v13-celsius-kb-blindside-one-a-year-down',
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
      metadata: { migration: MIGRATION, slug: KB_SLUG, changed: [{ before: from, after: to }] },
      critical: true,
      trx: knex,
    });
  }
}

exports.up = (knex) => rewrite(knex, 'up', AUDIT_ACTION);
exports.down = (knex) => rewrite(knex, 'down', AUDIT_ACTION_DOWN);

exports._KB_SLUG = KB_SLUG;
exports._OLD = OLD;
exports._NEXT = NEXT;
exports._AUDIT_ACTION = AUDIT_ACTION;
exports._AUDIT_ACTION_DOWN = AUDIT_ACTION_DOWN;
