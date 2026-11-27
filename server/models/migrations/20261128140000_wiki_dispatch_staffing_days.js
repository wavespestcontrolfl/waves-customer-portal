/**
 * Sync the two live dispatch wiki articles in `knowledge_base` (and purge stale
 * `knowledge_embeddings` chunks) to match the 2026-11-26 owner staffing-days
 * and pest-overflow rulings updated in `wiki/techs/technician-profiles.md` and
 * `wiki/protocols/routing-rules.md`:
 *
 *   - `wiki/techs/technician-profiles.md` (admin-only): records Adam's Wed–Sun
 *     5-day schedule (~60 total stops/week across his service lines), the second
 *     tech's Mon–Thu 4-day schedule (48-stop weekly target, routed pest first),
 *     and that Adam takes pest overflow only after the second tech's 48-stop
 *     target is filled and within Adam's remaining weekly capacity.
 *   - `wiki/protocols/routing-rules.md` (technician-readable `protocols`):
 *     updates Adam's pest overflow rule to match the routing order without
 *     exposing coworker weekly stop targets or linking to admin-only `techs/`.
 *
 * Guarded exact-text replacements (same pattern as 20261007176000 /
 * 20261009152000): unrelated article edits (including filed-back Q&A sections)
 * are preserved untouched; a line manually edited by a person, a missing row,
 * a missing table, and a repeat run are all no-ops (manual edits are logged).
 *
 * Purges `knowledge_embeddings` chunks for any updated `knowledge_base` row
 * (`source='kb', source_id=row.slug`) and any `ops_rule` chunks still carrying
 * the superseded wording (`source='ops_rule', source_id=opsRuleSourceId`).
 * Records one `audit_log` event per modified `knowledge_base` row.
 *
 * `down()` reverses only lines still holding the exact new wording, purges
 * stale chunks, and audits.
 */
const MIGRATION = '20261128140000_wiki_dispatch_staffing_days';
const AUDIT_ACTION = 'knowledge_base.wiki_dispatch_staffing_days';
const AUDIT_ACTION_DOWN = 'knowledge_base.wiki_dispatch_staffing_days_reverted';
const LOG = '[wiki-dispatch-staffing-days]';

const ARTICLES = [
  {
    path: 'wiki/techs/technician-profiles.md',
    slug: 'technician-profiles-waves-pest-control',
    opsRuleSourceId: 'techs/technician-profiles.md',
    replacements: [
      {
        old: 'Lawn care, tree & shrub, and exclusion (including the first rodent visit and the rodent inspection), in every served ZIP. Aggressive Colony Surcharge stinging-insect jobs. Fills in on pest when needed.',
        next: 'Lawn care, tree & shrub, and exclusion (including the first rodent visit and the rodent inspection), in every served ZIP. Aggressive Colony Surcharge stinging-insect jobs. Works 5 days a week (Wed–Sun, Mon–Tue off; owner 2026-11-26) starting Jan 1, 2027 (~60 total stops/week across all of Adam\'s service lines at 12 stops/day). After the second tech\'s 48-stop weekly target is filled, Adam takes pest overflow only within his remaining weekly capacity.',
      },
      {
        old: 'Pest control and termite work, in every served ZIP. Not these (they stay with Adam): Aggressive Colony Surcharge stinging-insect jobs, the first rodent visit, the rodent inspection, and sealing / exclusion work.',
        next: 'Pest control and termite work, in every served ZIP (routed pest first to fill his route). Not these (they stay with Adam): Aggressive Colony Surcharge stinging-insect jobs, the first rodent visit, the rodent inspection, and sealing / exclusion work.',
      },
      {
        old: '- A full day is 12 stops (owner 2026-11-22); 16 is a stretch day only.',
        next: '- Planned schedule starting Jan 1, 2027: 4 days a week, Mon–Thu (owner 2026-11-26; Mon–Tue = tech pest only, Wed–Thu = both techs, Fri–Sun = Adam only).\n- A full day is 12 stops (48/week; owner 2026-11-22); 16 is a stretch day only.',
      },
    ],
  },
  {
    path: 'wiki/protocols/routing-rules.md',
    slug: 'routing-rules-waves-pest-control',
    opsRuleSourceId: 'protocols/routing-rules.md',
    replacements: [
      {
        old: '- **Adam:** lawn care, tree & shrub, and exclusion, in every served ZIP; fills in on pest when needed.',
        next: '- **Adam:** lawn care, tree & shrub, and exclusion, in every served ZIP; takes pest overflow only after the second tech\'s route is filled and within Adam\'s available capacity.',
      },
    ],
  },
];

function countWords(text) {
  const trimmed = String(text || '').trim();
  return trimmed ? trimmed.split(/\s+/).length : 0;
}

function applyReplacements(content, replacements, direction, articlePath) {
  let nextContent = content;
  const changed = [];
  for (const row of replacements) {
    const from = direction === 'up' ? row.old : row.next;
    const to = direction === 'up' ? row.next : row.old;
    if (!nextContent.includes(from)) {
      if (!nextContent.includes(to)) {
        console.log(`${LOG} ${articlePath}: expected text not found (edited by a person?): line left as it is`);
      }
      continue;
    }
    if (nextContent.includes(to)) continue;
    nextContent = nextContent.replace(from, () => to);
    changed.push({ before: from, after: to });
  }
  return { content: nextContent, changed };
}

async function purgeStaleOpsRuleChunks(knex, article, direction) {
  const existing = await knex('knowledge_embeddings')
    .where({ source: 'ops_rule', source_id: article.opsRuleSourceId })
    .select('content');
  if (!existing.length) return;
  const stale = existing.some((chunk) => article.replacements.some((r) => {
    const from = direction === 'up' ? r.old : r.next;
    return typeof chunk.content === 'string' && chunk.content.includes(from);
  }));
  if (stale) {
    await knex('knowledge_embeddings')
      .where({ source: 'ops_rule', source_id: article.opsRuleSourceId })
      .del();
  }
}

async function updateArticleRow(knex, row, article, opts) {
  if (typeof row.content !== 'string') return;
  const articlePath = row.path || article.path;
  const { content, changed } = applyReplacements(row.content, article.replacements, opts.direction, articlePath);
  if (!changed.length) return;

  const now = new Date();
  await knex('knowledge_base').where({ id: row.id }).update({
    content,
    word_count: countWords(content),
    updated_at: now,
    last_verified_at: now,
    verified_by: opts.verifiedBy,
  });
  if (opts.hasEmbeddings && row.slug) {
    await knex('knowledge_embeddings').where({ source: 'kb', source_id: row.slug }).del();
  }
  if (opts.hasAudit) {
    const { recordAuditEvent } = require('../../services/audit-log');
    await recordAuditEvent({
      actor_type: 'system',
      action: opts.action,
      resource_type: 'knowledge_base',
      resource_id: String(row.id),
      metadata: { migration: MIGRATION, path: articlePath, slug: row.slug || null, changed },
      critical: true,
      trx: knex,
    });
  }
}

async function rewrite(knex, direction, action) {
  const hasKb = await knex.schema.hasTable('knowledge_base');
  const hasEmbeddings = await knex.schema.hasTable('knowledge_embeddings');
  const hasAudit = await knex.schema.hasTable('audit_log');
  const hasSlug = hasKb ? await knex.schema.hasColumn('knowledge_base', 'slug') : false;
  const verifiedBy = direction === 'up'
    ? 'migration-wiki-dispatch-staffing-days'
    : 'migration-wiki-dispatch-staffing-days-down';
  const opts = { direction, action, verifiedBy, hasEmbeddings, hasAudit };

  for (const article of ARTICLES) {
    if (hasKb) {
      const rows = await knex('knowledge_base').where((qb) => {
        qb.where('path', article.path);
        if (hasSlug) qb.orWhere('slug', article.slug);
      });
      for (const row of rows) await updateArticleRow(knex, row, article, opts);
    }
    if (hasEmbeddings) await purgeStaleOpsRuleChunks(knex, article, direction);
  }
}

exports.up = (knex) => rewrite(knex, 'up', AUDIT_ACTION);
exports.down = (knex) => rewrite(knex, 'down', AUDIT_ACTION_DOWN);

exports._ARTICLES = ARTICLES;
exports._AUDIT_ACTION = AUDIT_ACTION;
exports._AUDIT_ACTION_DOWN = AUDIT_ACTION_DOWN;
