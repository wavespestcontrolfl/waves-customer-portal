/**
 * Lawn protocol v13 count caps (Codex round 15 on #6104): rolling back the cap work must never bring
 * back "Dismiss NXT ... no annual cap concern" in the Celsius knowledge article.
 *
 * Dismiss is retired (#6098). 20261007177000 rewrote that article line to say so, but its down() puts
 * the old line back, and the old line recommends a retired product. down() of 177000 runs AFTER this
 * migration's down() (rollback runs newest first), and it acts only while the article still holds its
 * exact new line. So this migration's down() first rewrites that line to a differently worded
 * retirement notice (same meaning, not the exact text 177000 keys on): 177000's rollback then finds
 * nothing to restore, and the retired-Dismiss wording stays.
 *
 * up() changes nothing: the state 177000 wrote is already correct going forward.
 *
 * down(), guarded and audited: only while the article holds 177000's exact line; the article's search
 * chunks are purged so the corrected text is re-chunked; one audit_log event records it. Nothing else
 * in the article is touched.
 */
const KB_SLUG = 'celsius-wg-application-limits';
const KB_ACTION = 'knowledge_base.celsius_dismiss_retired_kept';
const { _DISMISS: DISMISS } = require('./20261007177000_lawn_v13_cap_clamp_and_kb_dismiss');

// Same meaning as 177000's line, deliberately not containing it.
const KEPT = '- Dismiss NXT (sulfentrazone + prodiamine) — retired, do not reorder. Existing stock may be used up on green kyllinga under 85°F only. Not an alternative after the Celsius cap';

exports.up = async function up() {};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('knowledge_base'))) return;
  const article = await knex('knowledge_base').where({ slug: KB_SLUG }).first();
  if (!article || typeof article.content !== 'string' || !article.content.includes(DISMISS.next)) return;
  await knex('knowledge_base').where({ id: article.id }).update({
    content: article.content.replace(DISMISS.next, () => KEPT),
    last_verified_at: new Date(),
    verified_by: 'migration-lawn-v13-keep-dismiss-retired',
  });
  if (await knex.schema.hasTable('knowledge_embeddings')) {
    await knex('knowledge_embeddings').where({ source: 'kb', source_id: KB_SLUG }).del();
  }
  if (await knex.schema.hasTable('audit_log')) {
    const { recordAuditEvent } = require('../../services/audit-log');
    await recordAuditEvent({
      actor_type: 'system',
      action: KB_ACTION,
      resource_type: 'knowledge_base',
      resource_id: String(article.id),
      metadata: { migration: '20261007179500_lawn_v13_keep_dismiss_retired', slug: KB_SLUG, before: DISMISS.next, after: KEPT },
      critical: true,
      trx: knex,
    });
  }
};

exports._KEPT = KEPT;
exports._KB_ACTION = KB_ACTION;
