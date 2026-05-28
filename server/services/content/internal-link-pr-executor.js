/**
 * internal-link-pr-executor.js
 *
 * Dry-run foundation for turning queued internal-link tasks into safe,
 * SEO-aware patch candidates. This module does not open Astro PRs yet;
 * it validates tasks, independently constructs the would-be patch, and
 * records patch_candidate / skipped / failed outcomes for review.
 */

const db = require('../../models/db');
const logger = require('../logger');
const GitHubClient = require('../content-astro/github-client');
const frontmatter = require('../content-astro/frontmatter');
const planner = require('./internal-link-planner');
const policy = require('./internal-link-seo-policy');

const EXECUTOR_VERSION = 'internal-link-dry-run-v1';
const DEFAULT_LIMIT = 10;

class InternalLinkPrExecutor {
  async runDryRun({ limit = DEFAULT_LIMIT, taskIds = null } = {}) {
    const tasks = await this._loadQueuedTasks({ limit, taskIds });
    const results = [];
    for (const task of tasks) {
      let result;
      try {
        result = await this.dryRunTask(task);
      } catch (err) {
        logger.warn(`[internal-link-pr-executor] dry-run failed for ${task.id}: ${err.message}`);
        result = {
          task_id: task.id,
          status: 'failed',
          failure_reason: err.message,
          executor_version: EXECUTOR_VERSION,
        };
      }
      await this._persistDryRunResult(task.id, result);
      results.push(result);
    }
    return { count: results.length, results };
  }

  async dryRunTask(task, { sourcePage = null, targetPage = null } = {}) {
    if (!task?.id && !task?.source_file) throw new Error('internal link task required');
    const source = sourcePage || await this._loadSourcePage(task);
    const target = targetPage || await this._loadTargetPage(task);
    return evaluateDryRunTask(task, { sourcePage: source, targetPage: target });
  }

  async _loadQueuedTasks({ limit, taskIds }) {
    let query = db('content_internal_link_tasks')
      .whereIn('status', ['pending', 'queued'])
      .orderByRaw('COALESCE(target_priority, 0) DESC')
      .orderBy('planned_at', 'asc')
      .limit(limit);
    if (Array.isArray(taskIds) && taskIds.length) query = query.whereIn('id', taskIds);
    return query.select('*');
  }

  async _loadSourcePage(task) {
    const file = await GitHubClient.getFile(task.source_file);
    if (!file?.content) throw new Error(`source_file_not_found:${task.source_file}`);
    return pageFromAstroFile(task.source_file, file.content);
  }

  async _loadTargetPage(task) {
    const targetFile = task.target_file || resolveAstroFileForUrl(task.target_url);
    if (!targetFile) throw new Error(`target_file_unresolved:${task.target_url}`);
    const file = await GitHubClient.getFile(targetFile);
    if (!file?.content) throw new Error(`target_file_not_found:${targetFile}`);
    return pageFromAstroFile(targetFile, file.content, { fallbackUrl: task.target_url });
  }

  async _persistDryRunResult(taskId, result) {
    if (!taskId) return;
    const patch = {
      status: result.status,
      source_url: result.source_url || null,
      source_canonical_url: result.source_canonical_url || null,
      target_canonical_url: result.target_canonical_url || null,
      target_file: result.target_file || null,
      source_page_type: result.source_page_type || null,
      target_page_type: result.target_page_type || null,
      topic_cluster: result.topic_cluster || null,
      source_topic: result.source_topic || null,
      target_topic: result.target_topic || null,
      topical_relevance_score: result.topical_relevance_score ?? null,
      anchor_type: result.anchor_type || null,
      anchor_variant: result.anchor_variant || null,
      anchor_confidence: result.anchor_confidence ?? null,
      source_existing_internal_links_count: result.source_existing_internal_links_count ?? null,
      target_existing_inlinks_count: result.target_existing_inlinks_count ?? null,
      target_indexable: result.target_indexable ?? null,
      target_http_status: result.target_http_status ?? null,
      target_canonical_matches: result.target_canonical_matches ?? null,
      source_indexable: result.source_indexable ?? null,
      source_http_status: result.source_http_status ?? null,
      source_canonical_matches: result.source_canonical_matches ?? null,
      link_context_before: result.link_context_before || null,
      link_context_after: result.link_context_after || null,
      paragraph_hash: result.paragraph_hash || null,
      executor_version: result.executor_version || EXECUTOR_VERSION,
      skip_reason: result.skip_reason || null,
      failure_reason: result.failure_reason || null,
      updated_at: new Date(),
    };
    await db('content_internal_link_tasks').where({ id: taskId }).update(patch);
  }
}

function evaluateDryRunTask(task, { sourcePage, targetPage, options = {} } = {}) {
  const base = baseResult(task, sourcePage, targetPage);
  if (!sourcePage?.body) return skipped(base, 'source_body_missing');
  if (!targetPage?.body) return skipped(base, 'target_body_missing');

  const targetUrl = policy.normalizeInternalUrl(task.target_url || targetPage.url || targetPage.canonical_url);
  const sourceUrl = policy.normalizeInternalUrl(task.source_url || sourcePage.url || sourcePage.canonical_url);
  if (!targetUrl) return skipped(base, 'target_url_invalid');
  if (!sourceUrl) return skipped(base, 'source_url_invalid');
  if (sourceUrl === targetUrl) return skipped(base, 'self_link');
  if (planner._internals.pageAlreadyLinksTo(sourcePage.body, targetUrl)) return skipped(base, 'source_already_links_target');

  const occurrence = planner._internals.findFirstUnlinkedOccurrence(sourcePage.body, task.anchor_text);
  if (!occurrence) return skipped(base, 'anchor_not_found');
  if (isHeadingOccurrence(sourcePage.body, occurrence.index)) return skipped(base, 'anchor_in_heading');

  const paragraph = paragraphAround(sourcePage.body, occurrence.index);
  if (paragraphHasLink(paragraph)) return skipped(base, 'paragraph_already_has_link');

  const sourceFacts = pageFacts(sourcePage, { url: sourceUrl });
  const targetFacts = pageFacts(targetPage, { url: targetUrl });
  const opportunity = policy.evaluateLinkOpportunity({
    source: sourceFacts,
    target: targetFacts,
    anchor_text: task.anchor_text,
    context: {
      sourceExistingInternalLinksCount: countInternalLinks(sourcePage.body),
      targetNewLinksInPr: Number(options.targetNewLinksInPr || 0),
      sameAnchorCountForTarget: Number(task.same_anchor_count_for_target || 0),
      existingExactMatchAnchorsForTarget: Number(task.existing_exact_match_anchors_for_target || 0),
      surroundingText: paragraph,
    },
    options: {
      minTopicalRelevance: Number(options.minTopicalRelevance ?? process.env.AUTONOMOUS_INTERNAL_LINK_MIN_TOPICAL_RELEVANCE ?? 0.75),
      maxLinksPerTargetPerPr: Number(options.maxLinksPerTargetPerPr ?? process.env.AUTONOMOUS_INTERNAL_LINK_MAX_LINKS_PER_TARGET_PER_PR ?? 2),
      maxExactMatchAnchorsPerTarget: Number(options.maxExactMatchAnchorsPerTarget ?? process.env.AUTONOMOUS_INTERNAL_LINK_MAX_EXACT_MATCH_ANCHORS_PER_TARGET ?? 1),
      sourceCooldownDays: Number(options.sourceCooldownDays ?? process.env.AUTONOMOUS_INTERNAL_LINK_SOURCE_COOLDOWN_DAYS ?? 30),
      targetCooldownDays: Number(options.targetCooldownDays ?? process.env.AUTONOMOUS_INTERNAL_LINK_TARGET_COOLDOWN_DAYS ?? 7),
    },
  });
  if (!opportunity.ok) {
    return skipped({
      ...base,
      ...seoFieldsFromOpportunity(opportunity),
      link_context_before: paragraph,
      paragraph_hash: policy.paragraphHash(paragraph),
    }, opportunity.issues.map((issue) => issue.code).join(','));
  }

  const patched = planner.applyTaskToBody(sourcePage.body, { ...task, target_url: targetUrl });
  if (patched === sourcePage.body) return skipped(base, 'patch_noop');
  const patchedParagraph = paragraphAround(patched, occurrence.index);

  return {
    ...base,
    ...seoFieldsFromOpportunity(opportunity),
    status: 'patch_candidate',
    source_url: sourceUrl,
    source_canonical_url: sourceFacts.canonical_url,
    target_canonical_url: targetFacts.canonical_url,
    target_file: targetPage.file,
    source_page_type: sourceFacts.page_type,
    target_page_type: targetFacts.page_type,
    topic_cluster: targetFacts.topic_cluster || sourceFacts.topic_cluster || null,
    source_topic: sourceFacts.topic,
    target_topic: targetFacts.topic,
    source_existing_internal_links_count: countInternalLinks(sourcePage.body),
    target_existing_inlinks_count: task.target_existing_inlinks_count ?? null,
    source_http_status: sourceFacts.http_status,
    target_http_status: targetFacts.http_status,
    source_indexable: sourceFacts.indexable,
    target_indexable: targetFacts.indexable,
    source_canonical_matches: policy.canonicalMatches(sourceUrl, sourceFacts.canonical_url),
    target_canonical_matches: policy.canonicalMatches(targetUrl, targetFacts.canonical_url),
    link_context_before: paragraph,
    link_context_after: patchedParagraph,
    paragraph_hash: policy.paragraphHash(paragraph),
    executor_version: EXECUTOR_VERSION,
  };
}

function baseResult(task, sourcePage, targetPage) {
  return {
    task_id: task.id || null,
    source_file: task.source_file || sourcePage?.file || null,
    target_file: task.target_file || targetPage?.file || null,
    target_url: task.target_url || targetPage?.url || null,
    anchor_text: task.anchor_text || null,
    executor_version: EXECUTOR_VERSION,
  };
}

function skipped(base, reason) {
  return {
    ...base,
    status: 'skipped',
    skip_reason: reason,
    executor_version: EXECUTOR_VERSION,
  };
}

function seoFieldsFromOpportunity(opportunity) {
  return {
    anchor_type: opportunity.anchor_type,
    anchor_variant: opportunity.anchor_type === 'exact_match' ? 'exact' : opportunity.anchor_type,
    anchor_confidence: opportunity.ok ? 1 : 0,
    topical_relevance_score: opportunity.topical_relevance_score,
  };
}

function pageFromAstroFile(file, body, { fallbackUrl = null } = {}) {
  const parsed = frontmatter.parse(body || '');
  const data = parsed.data || {};
  const url = firstValidInternalUrl(
    slugToInternalUrl(data.slug),
    data.canonical,
    data.canonical_url,
    fallbackUrl,
    deriveUrlFromFile(file)
  );
  const canonicalUrl = canonicalUrlFromFrontmatter(data, url);
  return {
    file,
    body,
    frontmatter: data,
    title: data.title || null,
    url,
    canonical_url: canonicalUrl,
    page_type: inferPageType(file, data),
    topic: data.primary_keyword || data.target_keyword || data.title || null,
    topic_cluster: data.category || data.service || data.target_service || inferCluster(file, data),
    http_status: 200,
    indexable: !robotsNoindex(data),
  };
}

function canonicalUrlFromFrontmatter(data = {}, fallbackUrl = null) {
  const hasCanonical = data.canonical != null && String(data.canonical).trim() !== '';
  const hasCanonicalUrl = data.canonical_url != null && String(data.canonical_url).trim() !== '';
  if (hasCanonical || hasCanonicalUrl) {
    return firstValidInternalUrl(data.canonical, data.canonical_url)
      || data.canonical
      || data.canonical_url
      || null;
  }
  return fallbackUrl;
}

function firstValidInternalUrl(...values) {
  for (const value of values) {
    const normalized = policy.normalizeInternalUrl(value);
    if (normalized) return normalized;
  }
  return null;
}

function slugToInternalUrl(slug) {
  const raw = String(slug || '').trim();
  if (!raw) return null;
  return raw.startsWith('/') ? raw : `/${raw}/`;
}

function pageFacts(page, { url }) {
  const front = page.frontmatter || {};
  return {
    url: url || page.url,
    canonical_url: page.canonical_url || front.canonical || front.canonical_url || url || page.url,
    http_status: page.http_status ?? 200,
    indexable: page.indexable !== false && !robotsNoindex(front),
    page_type: page.page_type || inferPageType(page.file, front),
    topic: page.topic || front.primary_keyword || front.target_keyword || front.title || page.title || null,
    topic_cluster: page.topic_cluster || front.category || front.service || inferCluster(page.file, front),
    title: page.title || front.title || null,
    keyword: page.keyword || front.primary_keyword || front.target_keyword || null,
    last_linked_at: page.last_linked_at || null,
  };
}

function deriveUrlFromFile(file) {
  const normalized = String(file || '').replace(/\\/g, '/');
  const match = normalized.match(/src\/content\/(blog|services|locations)\/(.+?)\.mdx?$/);
  if (!match) return null;
  if (match[1] === 'blog') return `/blog/${match[2]}/`;
  return `/${match[2]}/`;
}

function resolveAstroFileForUrl(url) {
  const path = policy.normalizeInternalUrl(url);
  if (!path) return null;
  const slug = path.replace(/^\/+|\/+$/g, '');
  if (!slug) return null;
  if (slug.startsWith('blog/')) return `src/content/blog/${slug.slice(5)}.md`;
  if (/-fl$/.test(slug) || SERVICE_HUB_SLUGS.has(slug)) return `src/content/services/${slug}.md`;
  return `src/content/locations/${slug}.md`;
}

const SERVICE_HUB_SLUGS = new Set([
  'pest-control',
  'lawn-care',
  'mosquito-control',
  'termite-control',
  'rodent-control',
  'bed-bug-control',
  'commercial-pest-control',
  'pest-control-services',
  'pest-control-quote',
  'termite-inspection',
  'tree-shrub-care',
  'tree-and-shrub-care',
]);

function inferPageType(file, frontmatter = {}) {
  if (frontmatter.page_type || frontmatter.content_type) return String(frontmatter.page_type || frontmatter.content_type);
  const normalized = String(file || '').replace(/\\/g, '/');
  if (normalized.includes('/blog/')) return 'supporting-blog';
  if (normalized.includes('/services/')) return /-fl\.mdx?$/.test(normalized) ? 'city-service' : 'service';
  if (normalized.includes('/locations/')) return 'location';
  return 'unknown';
}

function inferCluster(file, frontmatter = {}) {
  const text = [
    frontmatter.category,
    frontmatter.service,
    frontmatter.primary_keyword,
    frontmatter.title,
    file,
  ].filter(Boolean).join(' ').toLowerCase();
  for (const cluster of ['termite', 'mosquito', 'rodent', 'lawn', 'tree', 'shrub', 'pest']) {
    if (text.includes(cluster)) return cluster === 'tree' || cluster === 'shrub' ? 'tree-shrub' : cluster;
  }
  return null;
}

function robotsNoindex(frontmatter = {}) {
  return String(frontmatter.robots || frontmatter.indexing || '').toLowerCase().includes('noindex')
    || frontmatter.noindex === true;
}

function isHeadingOccurrence(body, index) {
  const lineStart = String(body || '').lastIndexOf('\n', Math.max(0, index - 1)) + 1;
  return /^[ \t]{0,3}#{1,6}\s/.test(String(body || '').slice(lineStart, index + 1));
}

function paragraphAround(body, index) {
  const text = String(body || '');
  let start = text.lastIndexOf('\n\n', Math.max(0, index - 1));
  start = start === -1 ? 0 : start + 2;
  let end = text.indexOf('\n\n', index);
  end = end === -1 ? text.length : end;
  return text.slice(start, end).trim();
}

function paragraphHasLink(paragraph) {
  return /\[[^\]\n]+\]\(\s*[^)]+\)/.test(paragraph) || /<a\b[^>]*\bhref\s*=/i.test(paragraph);
}

function countInternalLinks(body) {
  const text = String(body || '');
  let count = 0;
  const mdLink = /\[[^\]\n]+\]\(\s*(<[^>]+>|[^\s)]+)(?:\s+[^)]*)?\)/g;
  let match;
  while ((match = mdLink.exec(text)) !== null) {
    if (policy.normalizeInternalUrl(String(match[1] || '').replace(/^<|>$/g, ''))) count++;
  }
  const href = /<a\b[^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*>/gi;
  while ((match = href.exec(text)) !== null) {
    if (policy.normalizeInternalUrl(match[1])) count++;
  }
  return count;
}

module.exports = new InternalLinkPrExecutor();
module.exports.InternalLinkPrExecutor = InternalLinkPrExecutor;
module.exports._internals = {
  EXECUTOR_VERSION,
  evaluateDryRunTask,
  pageFromAstroFile,
  pageFacts,
  firstValidInternalUrl,
  canonicalUrlFromFrontmatter,
  slugToInternalUrl,
  resolveAstroFileForUrl,
  inferPageType,
  inferCluster,
  robotsNoindex,
  isHeadingOccurrence,
  paragraphAround,
  paragraphHasLink,
  countInternalLinks,
};
