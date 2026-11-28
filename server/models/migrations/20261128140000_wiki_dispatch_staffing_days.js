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
 * Safety invariants:
 *   - Runs inside a transaction and locks matching `knowledge_base` rows with
 *     `FOR UPDATE` (ordered by `id`) before reading `content`, so concurrent
 *     staff edits can never be overwritten.
 *   - Matches complete lines strictly inside the target markdown section, so a
 *     line with an appended staff qualification/exception is never rewritten.
 *   - Purges `knowledge_embeddings` chunks for any modified `knowledge_base`
 *     row (`source='kb', source_id=row.slug`), AND purges stale `kb` / `ops_rule`
 *     chunks still carrying superseded text even if the article already holds
 *     the new wording.
 *   - `down()` reverses ONLY the specific replacements this migration's `up()`
 *     recorded on that locked row (`metadata.migrationApplied[MIGRATION]`),
 *     still verifying exact full-line match in the target section, so
 *     pre-existing human edits to the new wording are never clobbered on
 *     rollback and rollback has zero cross-table timestamp ordering ambiguity.
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
        key: 'adam_service_lines',
        sectionPrefix: '### Service Lines After the Second Tech Is Hired',
        old: 'Lawn care, tree & shrub, and exclusion (including the first rodent visit and the rodent inspection), in every served ZIP. Aggressive Colony Surcharge stinging-insect jobs. Fills in on pest when needed.',
        next: 'Lawn care, tree & shrub, and exclusion (including the first rodent visit and the rodent inspection), in every served ZIP. Aggressive Colony Surcharge stinging-insect jobs. Works 5 days a week (Wed–Sun, Mon–Tue off; owner 2026-11-26) starting Jan 1, 2027 (~60 total stops/week across all of Adam\'s service lines at 12 stops/day). After the second tech\'s 48-stop weekly target is filled, Adam takes pest overflow only within his remaining weekly capacity.',
      },
      {
        key: 'second_tech_service_lines',
        sectionPrefix: '### Service Lines After Hire',
        old: 'Pest control and termite work, in every served ZIP. Not these (they stay with Adam): Aggressive Colony Surcharge stinging-insect jobs, the first rodent visit, the rodent inspection, and sealing / exclusion work.',
        next: 'Pest control and termite work, in every served ZIP (routed pest first to fill his route). Not these (they stay with Adam): Aggressive Colony Surcharge stinging-insect jobs, the first rodent visit, the rodent inspection, and sealing / exclusion work.',
      },
      {
        key: 'second_tech_planned_day',
        sectionPrefix: '### Planned Day',
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
        key: 'routing_adam_overflow',
        sectionPrefix: '## Who Covers What',
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

function findBlockIndexInSection(lines, sectionPrefix, targetLines) {
  let inSection = false;
  const maxStart = lines.length - targetLines.length;
  for (let i = 0; i <= lines.length - 1; i += 1) {
    const trimmed = lines[i].trim();
    if (/^#{1,6}\s/.test(trimmed)) {
      inSection = trimmed.startsWith(sectionPrefix);
      continue;
    }
    if (!inSection || i > maxStart) continue;
    let matches = true;
    for (let j = 0; j < targetLines.length; j += 1) {
      if (lines[i + j] !== targetLines[j]) {
        matches = false;
        break;
      }
    }
    if (matches) return i;
  }
  return -1;
}

function replaceInSection(content, row, direction, articlePath) {
  const from = direction === 'up' ? row.old : row.next;
  const to = direction === 'up' ? row.next : row.old;
  const lines = content.split('\n');
  const fromLines = from.split('\n');
  const toLines = to.split('\n');

  if (findBlockIndexInSection(lines, row.sectionPrefix, toLines) !== -1) {
    return { content, changed: null };
  }
  const idx = findBlockIndexInSection(lines, row.sectionPrefix, fromLines);
  if (idx === -1) {
    console.log(`${LOG} ${articlePath} [${row.key}]: exact line not found in "${row.sectionPrefix}" (edited by a person?): line left as it is`);
    return { content, changed: null };
  }
  const updated = [...lines.slice(0, idx), ...toLines, ...lines.slice(idx + fromLines.length)];
  return { content: updated.join('\n'), changed: { key: row.key, before: from, after: to } };
}

function applyReplacements(content, replacements, direction, articlePath) {
  let nextContent = content;
  const changed = [];
  for (const row of replacements) {
    const res = replaceInSection(nextContent, row, direction, articlePath);
    nextContent = res.content;
    if (res.changed) changed.push(res.changed);
  }
  return { content: nextContent, changed };
}

async function purgeStaleChunks(trx, source, sourceId, replacements, direction) {
  if (!sourceId) return;
  const existing = await trx('knowledge_embeddings')
    .where({ source, source_id: sourceId })
    .select('content');
  if (!existing.length) return;
  const stale = existing.some((chunk) => replacements.some((r) => {
    const from = direction === 'up' ? r.old : r.next;
    return typeof chunk.content === 'string' && chunk.content.includes(from);
  }));
  if (stale) {
    await trx('knowledge_embeddings').where({ source, source_id: sourceId }).del();
  }
}

function parseMetadata(raw) {
  if (!raw) return {};
  if (typeof raw === 'string') {
    try { return JSON.parse(raw) || {}; } catch { return {}; }
  }
  return typeof raw === 'object' ? { ...raw } : {};
}

function readAppliedKeys(row) {
  const meta = parseMetadata(row.metadata);
  const applied = meta.migrationApplied && meta.migrationApplied[MIGRATION];
  return new Set(Array.isArray(applied) ? applied.filter(Boolean) : []);
}

function withAppliedKeys(row, keys) {
  const meta = parseMetadata(row.metadata);
  const map = meta.migrationApplied && typeof meta.migrationApplied === 'object'
    ? { ...meta.migrationApplied }
    : {};
  if (keys && keys.length) {
    map[MIGRATION] = keys;
    meta.migrationApplied = map;
  } else {
    delete map[MIGRATION];
    if (Object.keys(map).length) meta.migrationApplied = map;
    else delete meta.migrationApplied;
  }
  return JSON.stringify(meta);
}

async function updateArticleRow(trx, row, article, opts) {
  if (typeof row.content !== 'string') return;
  const articlePath = row.path || article.path;
  let activeReplacements = article.replacements;
  let hadRecordedKeys = false;
  if (opts.direction === 'down') {
    const keys = opts.hasMetadata ? readAppliedKeys(row) : new Set();
    hadRecordedKeys = keys.size > 0;
    activeReplacements = article.replacements.filter((r) => keys.has(r.key));
  }

  const { content, changed } = activeReplacements.length
    ? applyReplacements(row.content, activeReplacements, opts.direction, articlePath)
    : { content: row.content, changed: [] };

  if (!changed.length) {
    if (opts.direction === 'down' && hadRecordedKeys && opts.hasMetadata) {
      await trx('knowledge_base').where({ id: row.id }).update({ metadata: withAppliedKeys(row, null) });
    }
    if (opts.hasEmbeddings && row.slug && opts.direction === 'up') {
      await purgeStaleChunks(trx, 'kb', row.slug, article.replacements, 'up');
    }
    return;
  }

  const now = new Date();
  const patch = {
    content,
    word_count: countWords(content),
    updated_at: now,
    last_verified_at: now,
    verified_by: opts.verifiedBy,
  };
  if (opts.hasMetadata) {
    const nextKeys = opts.direction === 'up'
      ? [...new Set([...readAppliedKeys(row), ...changed.map((c) => c.key)])]
      : null;
    patch.metadata = withAppliedKeys(row, nextKeys);
  }
  await trx('knowledge_base').where({ id: row.id }).update(patch);
  if (opts.hasEmbeddings && row.slug) {
    await trx('knowledge_embeddings').where({ source: 'kb', source_id: row.slug }).del();
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
      trx,
    });
  }
}

async function runRewrite(trx, direction, action) {
  const hasKb = await trx.schema.hasTable('knowledge_base');
  const hasEmbeddings = await trx.schema.hasTable('knowledge_embeddings');
  const hasAudit = await trx.schema.hasTable('audit_log');
  const hasSlug = hasKb ? await trx.schema.hasColumn('knowledge_base', 'slug') : false;
  const hasMetadata = hasKb ? await trx.schema.hasColumn('knowledge_base', 'metadata') : false;
  const verifiedBy = direction === 'up'
    ? 'migration-wiki-dispatch-staffing-days'
    : 'migration-wiki-dispatch-staffing-days-down';
  const opts = { direction, action, verifiedBy, hasEmbeddings, hasAudit, hasMetadata };

  for (const article of ARTICLES) {
    if (hasKb) {
      const rows = await trx('knowledge_base')
        .where((qb) => {
          qb.where('path', article.path);
          if (hasSlug) qb.orWhere('slug', article.slug);
        })
        .orderBy('id', 'asc')
        .forUpdate();
      for (const row of rows) await updateArticleRow(trx, row, article, opts);
    }
    if (hasEmbeddings) {
      await purgeStaleChunks(trx, 'ops_rule', article.opsRuleSourceId, article.replacements, direction);
    }
  }
}

function rewrite(knex, direction, action) {
  if (knex.isTransaction) return runRewrite(knex, direction, action);
  return knex.transaction((trx) => runRewrite(trx, direction, action));
}

exports.up = (knex) => rewrite(knex, 'up', AUDIT_ACTION);
exports.down = (knex) => rewrite(knex, 'down', AUDIT_ACTION_DOWN);

exports._ARTICLES = ARTICLES;
exports._AUDIT_ACTION = AUDIT_ACTION;
exports._AUDIT_ACTION_DOWN = AUDIT_ACTION_DOWN;
exports._applyReplacements = applyReplacements;
