/**
 * internal-link-seo-policy.js
 *
 * Pure strategy helpers for the autonomous internal-link executor. The
 * executor will still own Markdown patching and PR creation; this module
 * answers whether a proposed source/target/anchor pair is worth trying.
 */

const crypto = require('crypto');

const ALLOWED_HOSTS = new Set(['wavespestcontrol.com', 'www.wavespestcontrol.com']);
const GENERIC_ANCHORS = new Set([
  'click here',
  'here',
  'read more',
  'learn more',
  'this page',
  'this article',
  'this guide',
  'more info',
  'more information',
  'details',
]);
const GENERIC_ANCHOR_PREFIX_RE = /^(?:click|tap|read|learn|see|view|find|get)\s+(?:more\s+)?(?:about|on|for|details|info|information)\b/i;
const COMMERCIAL_TERMS = [
  'pest control',
  'lawn pest control',
  'termite control',
  'termite inspection',
  'mosquito control',
  'rodent control',
  'lawn care',
  'tree shrub',
  'tree and shrub',
  'bed bug',
  'exterminator',
];
const STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'can', 'for', 'from',
  'how', 'in', 'is', 'it', 'of', 'on', 'or', 'our', 'the', 'this', 'to',
  'what', 'when', 'why', 'with', 'your',
]);

function normalizeInternalUrl(value, { allowExternal = false } = {}) {
  const raw = expandTemplatedSiteUrl(String(value || '').trim());
  if (!raw || /[\u0000-\u001F\\]/.test(raw)) return null;

  let pathname;
  if (/^https?:\/\//i.test(raw)) {
    let parsed;
    try {
      parsed = new URL(raw);
    } catch {
      return null;
    }
    const host = parsed.hostname.toLowerCase();
    if (!allowExternal && !ALLOWED_HOSTS.has(host)) return null;
    pathname = parsed.pathname;
  } else if (raw.startsWith('/') && !raw.startsWith('//')) {
    pathname = raw.replace(/[?#].*$/, '');
  } else {
    return null;
  }

  const clean = pathname
    .replace(/\/{2,}/g, '/')
    .replace(/\/+$/, '')
    .toLowerCase();
  if (!clean || !clean.startsWith('/')) return null;
  if (!/^\/[a-z0-9/_~.%+-]+$/.test(clean)) return null;
  return `${clean}/`;
}

function expandTemplatedSiteUrl(value) {
  return String(value || '').replace(/\{\{\s*siteUrl\s*\}\}/gi, 'https://www.wavespestcontrol.com');
}

function urlsEquivalent(a, b) {
  const left = normalizeInternalUrl(a);
  const right = normalizeInternalUrl(b);
  return Boolean(left && right && left === right);
}

function canonicalMatches(expectedUrl, canonicalUrl) {
  if (!expectedUrl || !canonicalUrl) return false;
  return urlsEquivalent(expectedUrl, canonicalUrl);
}

function classifyAnchor(anchorText, { targetKeyword = '', brand = 'waves' } = {}) {
  const anchor = clean(anchorText).toLowerCase();
  const keyword = clean(targetKeyword).toLowerCase();
  if (!anchor) return 'missing';
  if (GENERIC_ANCHORS.has(anchor)) return 'generic';
  if (anchor.includes(brand.toLowerCase())) return 'branded';
  if (keyword && anchor === keyword) return 'exact_match';
  if (keyword && keywordTokenCoverage(anchor, keyword) >= 0.65) return 'partial_match';
  if (isNavigationalAnchor(anchor)) return 'navigational';
  if (anchor.split(/\s+/).length >= 5) return 'long_tail';
  return 'semantic';
}

function validateAnchorPolicy(anchorText, context = {}) {
  const anchor = clean(anchorText);
  const lower = anchor.toLowerCase();
  const words = anchor.split(/\s+/).filter(Boolean);
  const anchorType = classifyAnchor(anchor, context);
  const issues = [];

  if (!anchor) issues.push(issue('anchor_missing', 'Anchor text is required.'));
  if (anchorType === 'generic') issues.push(issue('anchor_generic', 'Anchor text is generic.'));
  if (GENERIC_ANCHOR_PREFIX_RE.test(anchor)) {
    issues.push(issue('anchor_generic_cta_prefix', 'Anchor starts with a generic CTA phrase.'));
  }
  if (splitsServicePhrase(anchor, context.surroundingText)) {
    issues.push(issue('anchor_splits_service_phrase', 'Anchor splits a service phrase instead of linking the complete phrase.'));
  }
  if (leavesDanglingGeoQualifier(anchor, context.surroundingText)) {
    issues.push(issue('anchor_leaves_geo_qualifier', 'Anchor leaves a trailing geographic qualifier outside the link.'));
  }
  if (anchor.length > 80 || words.length > 8) issues.push(issue('anchor_too_long', 'Anchor text is too long.'));
  if (/[.!?]$/.test(anchor)) issues.push(issue('anchor_sentence', 'Anchor should not include sentence punctuation.'));
  if (/\b(click|tap)\b/i.test(anchor)) issues.push(issue('anchor_ui_action', 'Anchor should describe the destination, not a UI action.'));

  const exactCount = Number(context.existingExactMatchAnchorsForTarget || 0);
  if (anchorType === 'exact_match' && exactCount >= Number(context.maxExactMatchAnchorsPerTarget || 1)) {
    issues.push(issue('anchor_exact_match_repeated', 'Exact-match anchor cap reached for target.'));
  }

  const sameAnchorCount = Number(context.sameAnchorCountForTarget || 0);
  if (sameAnchorCount > 0) issues.push(issue('anchor_variant_repeated', 'Anchor variant was already used for target.'));

  const commercialCount = COMMERCIAL_TERMS.filter((term) => lower.includes(term)).length;
  if (commercialCount >= 3) issues.push(issue('anchor_commercially_stacked', 'Anchor repeats too many commercial terms.'));

  return {
    ok: issues.length === 0,
    anchor_type: anchorType,
    issues,
  };
}

function splitsServicePhrase(anchorText, surroundingText) {
  const anchor = clean(anchorText).toLowerCase();
  const text = clean(surroundingText).toLowerCase();
  if (!anchor || !text) return false;

  const anchorStart = text.indexOf(anchor);
  if (anchorStart === -1) return false;
  const anchorEnd = anchorStart + anchor.length;

  for (const phrase of COMMERCIAL_TERMS) {
    let phraseStart = text.indexOf(phrase);
    while (phraseStart !== -1) {
      const phraseEnd = phraseStart + phrase.length;
      const overlaps = anchorStart < phraseEnd && anchorEnd > phraseStart;
      const fullyCovers = anchorStart <= phraseStart && anchorEnd >= phraseEnd;
      if (overlaps && !fullyCovers) return true;
      phraseStart = text.indexOf(phrase, phraseStart + 1);
    }
  }
  return false;
}

function leavesDanglingGeoQualifier(anchorText, surroundingText) {
  const anchor = clean(anchorText).toLowerCase();
  const text = clean(surroundingText).toLowerCase();
  if (!anchor || !text) return false;

  const anchorStart = text.indexOf(anchor);
  if (anchorStart === -1) return false;
  const after = text.slice(anchorStart + anchor.length);
  return /^\s*,\s*(?:fl|florida)\b/.test(after);
}

function scoreTopicalRelevance(source = {}, target = {}) {
  const sourceText = [
    source.topic,
    source.topic_cluster,
    source.page_type,
    source.title,
    source.body_excerpt,
  ].filter(Boolean).join(' ');
  const targetText = [
    target.topic,
    target.topic_cluster,
    target.page_type,
    target.title,
    target.keyword,
  ].filter(Boolean).join(' ');
  const sourceTokens = meaningfulTokens(sourceText);
  const targetTokens = meaningfulTokens(targetText);
  if (!sourceTokens.size || !targetTokens.size) return 0;
  const overlap = Array.from(targetTokens).filter((token) => sourceTokens.has(token)).length;
  return round4(overlap / targetTokens.size);
}

function validateSourceTargetPair({ source = {}, target = {}, now = new Date(), options = {} } = {}) {
  const issues = [];
  const sourceUrl = normalizeInternalUrl(source.url || source.canonical_url);
  const targetUrl = normalizeInternalUrl(target.url || target.canonical_url);

  if (!sourceUrl) issues.push(issue('source_url_invalid', 'Source URL is not a valid Waves URL.'));
  if (!targetUrl) issues.push(issue('target_url_invalid', 'Target URL is not a valid Waves URL.'));
  if (sourceUrl && targetUrl && sourceUrl === targetUrl) issues.push(issue('self_link', 'Source and target normalize to the same URL.'));

  if (options.requireTarget200 !== false && Number(target.http_status || 0) !== 200) {
    issues.push(issue('target_not_200', 'Target URL must return 200.'));
  }
  if (options.requireSource200 !== false && Number(source.http_status || 0) !== 200) {
    issues.push(issue('source_not_200', 'Source URL must return 200.'));
  }
  if (options.requireTargetIndexable !== false && target.indexable !== true) {
    issues.push(issue('target_not_indexable', 'Target must be indexable.'));
  }
  if (options.requireSourceIndexable !== false && source.indexable !== true) {
    issues.push(issue('source_not_indexable', 'Source must be indexable.'));
  }
  if (options.requireCanonicalMatch !== false) {
    if (target.canonical_url && targetUrl && !canonicalMatches(targetUrl, target.canonical_url)) {
      issues.push(issue('target_canonical_mismatch', 'Target canonical must match target URL.'));
    }
    if (source.canonical_url && sourceUrl && !canonicalMatches(sourceUrl, source.canonical_url)) {
      issues.push(issue('source_canonical_mismatch', 'Source canonical must match source URL.'));
    }
  }
  if (sourceUrl && targetUrl && urlsEquivalent(source.canonical_url, target.canonical_url)) {
    issues.push(issue('canonical_equivalent', 'Source and target canonicals are equivalent.'));
  }

  const sourceCooldownDays = Number(options.sourceCooldownDays || 0);
  if (sourceCooldownDays > 0 && withinDays(source.last_linked_at, now, sourceCooldownDays)) {
    issues.push(issue('source_cooldown', 'Source page was modified by internal linking too recently.'));
  }
  const targetCooldownDays = Number(options.targetCooldownDays || 0);
  if (targetCooldownDays > 0 && withinDays(target.last_linked_at, now, targetCooldownDays)) {
    issues.push(issue('target_cooldown', 'Target received internal links too recently.'));
  }

  return { ok: issues.length === 0, source_url: sourceUrl, target_url: targetUrl, issues };
}

function evaluateLinkOpportunity({ source = {}, target = {}, anchor_text = '', context = {}, options = {} } = {}) {
  const pair = validateSourceTargetPair({ source, target, now: options.now || new Date(), options });
  const relevance = scoreTopicalRelevance(source, target);
  const minRelevance = Number(options.minTopicalRelevance ?? 0.75);
  const anchor = validateAnchorPolicy(anchor_text, {
    targetKeyword: target.keyword,
    existingExactMatchAnchorsForTarget: context.existingExactMatchAnchorsForTarget,
    sameAnchorCountForTarget: context.sameAnchorCountForTarget,
    maxExactMatchAnchorsPerTarget: options.maxExactMatchAnchorsPerTarget,
    surroundingText: context.surroundingText,
  });

  const issues = [...pair.issues, ...anchor.issues];
  if (relevance < minRelevance) {
    issues.push(issue('topical_relevance_low', `Topical relevance ${relevance} below ${minRelevance}.`));
  }
  if (Number(context.sourceExistingInternalLinksCount || 0) > Number(options.maxSourceContextualLinks || 30)) {
    issues.push(issue('source_link_density_high', 'Source page already has high contextual link count.'));
  }
  if (Number(context.targetNewLinksInPr || 0) >= Number(options.maxLinksPerTargetPerPr || 2)) {
    issues.push(issue('target_pr_cap_reached', 'Target link cap reached for this PR.'));
  }

  return {
    ok: issues.length === 0,
    anchor_type: anchor.anchor_type,
    topical_relevance_score: relevance,
    source_url: pair.source_url,
    target_url: pair.target_url,
    issues,
  };
}

function paragraphHash(text) {
  return crypto.createHash('sha256').update(String(text || '').replace(/\s+/g, ' ').trim()).digest('hex');
}

function clean(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function meaningfulTokens(value) {
  const tokens = String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .map((token) => token.replace(/^-+|-+$/g, ''))
    .filter((token) => token.length > 2 && !STOPWORDS.has(token));
  return new Set(tokens);
}

function keywordTokenCoverage(anchor, keyword) {
  const anchorTokens = meaningfulTokens(anchor);
  const keywordTokens = meaningfulTokens(keyword);
  if (!keywordTokens.size) return 0;
  const matched = Array.from(keywordTokens).filter((token) => anchorTokens.has(token)).length;
  return matched / keywordTokens.size;
}

function isNavigationalAnchor(anchor) {
  return /\b(service|services|page|guide|inspection|treatment|control|care)\b/.test(anchor);
}

function withinDays(value, now, days) {
  if (!value) return false;
  const then = new Date(value);
  if (!Number.isFinite(then.getTime())) return false;
  return (new Date(now).getTime() - then.getTime()) < days * 86400_000;
}

function issue(code, message) {
  return { code, message };
}

function round4(value) {
  return Math.round(Number(value || 0) * 10000) / 10000;
}

module.exports = {
  ALLOWED_HOSTS,
  GENERIC_ANCHORS,
  normalizeInternalUrl,
  urlsEquivalent,
  canonicalMatches,
  classifyAnchor,
  validateAnchorPolicy,
  scoreTopicalRelevance,
  validateSourceTargetPair,
  evaluateLinkOpportunity,
  paragraphHash,
  expandTemplatedSiteUrl,
  _internals: {
    clean,
    meaningfulTokens,
    keywordTokenCoverage,
    splitsServicePhrase,
    leavesDanglingGeoQualifier,
    withinDays,
  },
};
