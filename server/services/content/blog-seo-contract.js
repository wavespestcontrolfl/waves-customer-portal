/**
 * Shared SEO completion contract helpers for autonomous supporting blog
 * drafts. This module is deliberately dependency-light so the brief
 * builder, agent tools, gate, publisher, and review read model can all
 * consume the same rules without pulling in web/runtime dependencies.
 */

const BLOG_CATEGORY_BY_SERVICE = {
  pest: { value: 'pest-control', label: 'Pest Control', url: '/blog/category/pest-control/' },
  lawn: { value: 'lawn-care', label: 'Lawn Care', url: '/blog/category/lawn-care/' },
  termite: { value: 'termite', label: 'Termites', url: '/blog/category/termite/' },
  mosquito: { value: 'mosquito', label: 'Mosquito Control', url: '/blog/category/mosquito/' },
  rodent: { value: 'pest-control', label: 'Pest Control', url: '/blog/category/pest-control/' },
  'tree-shrub': { value: 'tree-shrub', label: 'Tree & Shrub Care', url: '/blog/category/tree-shrub/' },
  specialty: { value: 'pest-control', label: 'Pest Control', url: '/blog/category/pest-control/' },
};

const SERVICE_TARGETS = {
  pest: { name: 'Pest Control', slug: 'pest-control', url: '/pest-control-services/' },
  lawn: { name: 'Lawn Care', slug: 'lawn-care', url: '/lawn-care/' },
  termite: { name: 'Termite Control', slug: 'termite-control', url: '/termite-control/' },
  mosquito: { name: 'Mosquito Control', slug: 'mosquito-control', url: '/mosquito-control/' },
  rodent: { name: 'Rodent Control', slug: 'rodent-control', url: '/rodent-control/' },
  'tree-shrub': { name: 'Tree & Shrub Care', slug: 'tree-shrub-care', url: '/tree-shrub-care/' },
  specialty: { name: 'Pest Control', slug: 'pest-control', url: '/pest-control-services/' },
};

const CITY_SERVICE_SLUG = {
  pest: 'pest-control',
  lawn: 'lawn-care',
  mosquito: 'mosquito-control',
  termite: 'termite-control',
  rodent: 'rodent-control',
};

const CONTENT_CLUSTERS = [
  'bed_bugs',
  'rodents',
  'termites',
  'termite_bond',
  'wdo_wdi',
  'taexx_in_wall',
  'florida_pest_identification',
  'lawn_turf',
  'mosquitoes',
  'ants',
  'roaches',
  'general_pest_control',
];

const REVIEW_FLAGS = [
  'missing_city_link',
  'missing_service_link',
  'missing_conversion_cta',
  'missing_breadcrumbs',
  'missing_article_schema',
  'faq_schema_without_visible_faq',
  'visible_faq_without_schema',
  'missing_pest_practices',
  'possible_cannibalization',
  'hardcoded_price',
  'pii_risk',
  'public_health_sensitive',
];

const INTERNAL_LINK_REASONS = [
  'city',
  'service',
  'conversion',
  'related_blog',
  'hub',
  'supporting_authority',
];

function buildSeoRequirements(brief = {}) {
  const pageType = brief.page_type || brief.pageType || 'none';
  if (pageType !== 'supporting-blog') {
    return {
      breadcrumbsRequired: false,
      articleSchemaRequired: false,
      faqSectionRequired: 'not_required',
      faqSchemaPolicy: 'only_when_visible_faq_exists',
      internalLinksRequired: {},
      ctaRequired: { intro: false, middle: 'not_required', final: false },
      pestPracticesRequired: false,
    };
  }

  return {
    breadcrumbsRequired: true,
    articleSchemaRequired: true,
    faqSectionRequired: 'when_useful',
    faqSchemaPolicy: 'only_when_visible_faq_exists',
    internalLinksRequired: {
      city: brief.city ? 1 : 0,
      service: brief.service ? 1 : 0,
      conversion: 1,
      relatedBlog: 2,
      hub: 0,
    },
    ctaRequired: {
      intro: true,
      middle: 'when_natural',
      final: true,
    },
    pestPracticesRequired: isPestPracticeTopic(brief),
  };
}

function buildBlogSeoContract({ draft = {}, brief = {} } = {}) {
  const frontmatter = draft.frontmatter || {};
  const body = String(draft.body || draft.markdown || '');
  const title = cleanText(draft.title || frontmatter.title);
  const slug = normalizeSlug(draft.slug || frontmatter.slug || urlPath(frontmatter.canonical || draft.url));
  const description = cleanText(draft.meta_description || frontmatter.meta_description || frontmatter.description);
  const primaryKeyword = cleanText(frontmatter.primary_keyword || draft.primary_keyword || brief.target_keyword);
  const secondaryKeywords = normalizeTextArray(frontmatter.secondary_keywords || draft.secondary_keywords);
  const serviceKey = normalizeService(brief.service || frontmatter.service);
  const category = normalizeCategory(frontmatter.category, serviceKey);
  const city = buildCityTarget(brief.city || firstValue(frontmatter.service_areas_tag), serviceKey);
  const primaryService = SERVICE_TARGETS[serviceKey] || null;
  const faq = extractVisibleFaqs(body);
  const schema = resolveSchemaState({ draft, frontmatter, body });
  let breadcrumbs = normalizeBreadcrumbs(
    draft.seo_contract?.breadcrumbs
    || draft.seoContract?.breadcrumbs
    || frontmatter.breadcrumbs
    || []
  );
  if (!breadcrumbs.length) {
    // Drafts have no legal channel to carry breadcrumbs: the writer's
    // emit_draft tool has no seo_contract field and the binding blog schema
    // (additionalProperties: false) rejects a breadcrumbs frontmatter key.
    // The Astro blog layout renders Home > Waves Blog > <post> unconditionally
    // (visible nav + BreadcrumbList JSON-LD), so an empty draft-level list
    // means "layout default", not "missing breadcrumbs" — without this
    // fallback P1_MISSING_BREADCRUMBS fired on every autonomous draft.
    breadcrumbs = normalizeBreadcrumbs(buildDefaultBlogBreadcrumbs({ title, slug }));
  }
  const includedInternalLinks = normalizeInternalLinks(
    extractMarkdownLinkItems(body).map((link) => {
      const reason = inferLinkReason(link.url);
      return {
        ...link,
        reason,
        required: ['city', 'service', 'conversion'].includes(reason),
      };
    })
  );
  const internalLinkRecommendations = normalizeInternalLinks(
    draft.seo_contract?.internalLinkRecommendations
    || draft.seoContract?.internalLinkRecommendations
    || recommendationsFromBrief(brief, { city, primaryService })
  );

  const contract = {
    title,
    slug,
    description,
    category,
    cluster: inferContentCluster({
      title,
      body,
      service: serviceKey,
      keyword: primaryKeyword || brief.target_keyword,
    }),
    primaryKeyword,
    secondaryKeywords,
    city,
    primaryService,
    breadcrumbs,
    includedInternalLinks,
    internalLinks: includedInternalLinks,
    internalLinkRecommendations,
    faq,
    pestPractices: extractPestPractices(body),
    ctas: extractCtas(body),
    schema,
    reviewFlags: [],
  };

  const validation = validateBlogSeoContract(contract, { brief });
  contract.reviewFlags = validation.reviewFlags;
  return { contract, validation };
}

function validateBlogSeoContract(contract = {}, { brief = {} } = {}) {
  const errors = [];
  const reviewFlags = new Set(normalizeTextArray(contract.reviewFlags));

  if (!contract.title) errors.push(error('missing_title', 'title is required'));
  if (!contract.slug) errors.push(error('missing_slug', 'slug is required'));
  if (!contract.description) errors.push(error('missing_description', 'description is required'));
  if (!contract.category) errors.push(error('missing_category', 'category is required'));
  if (!contract.cluster || !CONTENT_CLUSTERS.includes(contract.cluster)) {
    errors.push(error('missing_cluster', 'valid content cluster is required'));
  }
  if (!contract.primaryKeyword) errors.push(error('missing_primary_keyword', 'primaryKeyword is required'));

  if (contract.schema?.faqPage === true && !contract.faq?.length) {
    errors.push(error('faq_schema_without_visible_faq', 'FAQPage schema requires visible FAQ items'));
    reviewFlags.add('faq_schema_without_visible_faq');
  }
  if (contract.faq?.length && contract.schema?.faqPage !== true) {
    reviewFlags.add('visible_faq_without_schema');
  }
  if (contract.schema?.breadcrumb === true && !contract.breadcrumbs?.length) {
    errors.push(error('breadcrumb_schema_without_breadcrumbs', 'BreadcrumbList schema requires visible breadcrumbs'));
    reviewFlags.add('missing_breadcrumbs');
  }
  if (brief.page_type === 'supporting-blog' && !contract.schema?.article) {
    reviewFlags.add('missing_article_schema');
  }

  if (brief.city && !hasRequiredLink(contract.internalLinks, 'city')) reviewFlags.add('missing_city_link');
  if (brief.service && !hasRequiredLink(contract.internalLinks, 'service')) reviewFlags.add('missing_service_link');
  if (!hasRequiredLink(contract.internalLinks, 'conversion')) reviewFlags.add('missing_conversion_cta');
  if (isPestPracticeTopic(brief) && !pestPracticesComplete(contract.pestPractices)) {
    reviewFlags.add('missing_pest_practices');
  }

  return {
    ok: errors.length === 0,
    errors,
    reviewFlags: Array.from(reviewFlags).filter((flag) => REVIEW_FLAGS.includes(flag)),
  };
}

function extractVisibleFaqs(markdown = '') {
  const lines = String(markdown || '').replace(/\r\n/g, '\n').split('\n');
  const start = lines.findIndex((line) => /^#{2,3}\s+(?:\*\*)?(frequently asked questions|frequently asked|common questions|faqs?)\b/i.test(line.trim()));
  if (start < 0) return [];

  const faqs = [];
  let current = null;
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i];
    const heading = line.match(/^(#{2,4})\s+(.+?)\s*$/);
    if (heading && heading[1].length <= 2) break;
    if (heading && heading[1].length >= 3) {
      if (current) faqs.push(current);
      current = { question: cleanQuestion(heading[2]), answerLines: [] };
      continue;
    }
    if (current) current.answerLines.push(line);
  }
  if (current) faqs.push(current);

  return faqs
    .map((item) => ({
      question: item.question,
      answer: normalizeAnswer(item.answerLines.join('\n')),
    }))
    .filter((item) => item.question && item.answer);
}

function inferContentCluster({ title = '', body = '', service = '', keyword = '' } = {}) {
  const text = `${title} ${keyword} ${body}`.toLowerCase();
  if (/\bbed\s*bugs?\b/.test(text)) return 'bed_bugs';
  if (/\b(roof\s*rats?|rodents?|mice|mouse|rats?)\b/.test(text)) return 'rodents';
  if (/\b(termite\s*bond|bond\s+transfer|termite\s+cost)\b/.test(text)) return 'termite_bond';
  if (/\b(wdo|wdi|wood[-\s]?destroying)\b/.test(text)) return 'wdo_wdi';
  if (/\b(taexx|in[-\s]?wall)\b/.test(text)) return 'taexx_in_wall';
  if (/\btermites?\b/.test(text) || service === 'termite') return 'termites';
  if (/\b(chinch|sod|st\.?\s*augustine|turf|lawn|grass|yellowing|fertiliz)\b/.test(text) || service === 'lawn') return 'lawn_turf';
  if (/\bmosquito(?:es)?\b/.test(text) || service === 'mosquito') return 'mosquitoes';
  if (/\b(ants?|ghost ants?|fire ants?|carpenter ants?)\b/.test(text)) return 'ants';
  if (/\b(roaches?|cockroaches?|palmetto bugs?)\b/.test(text)) return 'roaches';
  if (/\b(florida|swfl|identify|identification|what is this pest)\b/.test(text)) return 'florida_pest_identification';
  return 'general_pest_control';
}

function normalizeInternalLinks(links = []) {
  const seen = new Set();
  const out = [];
  for (const raw of Array.isArray(links) ? links : []) {
    const url = normalizeUrl(raw.url || raw);
    if (!url || seen.has(url)) continue;
    const reason = INTERNAL_LINK_REASONS.includes(raw.reason) ? raw.reason : inferLinkReason(url);
    seen.add(url);
    out.push({
      url,
      anchorText: cleanText(raw.anchorText || raw.anchor_text || raw.title || labelForUrl(url)),
      reason,
      required: raw.required === false ? false : ['city', 'service', 'conversion'].includes(reason),
    });
  }
  return out;
}

function recommendationsFromBrief(brief = {}, { city, primaryService } = {}) {
  const links = [];
  if (city) {
    links.push({
      url: city.url,
      anchorText: city.name,
      reason: 'city',
      required: true,
    });
  }
  if (primaryService) {
    links.push({
      url: primaryService.url,
      anchorText: primaryService.name.toLowerCase(),
      reason: 'service',
      required: true,
    });
  }
  links.push({
    url: '/contact/',
    anchorText: 'request a pest control quote',
    reason: 'conversion',
    required: true,
  });
  for (const url of normalizeTextArray(brief.internal_links_to_add)) {
    links.push({
      url,
      anchorText: labelForUrl(url),
      reason: inferLinkReason(url),
      required: false,
    });
  }
  return normalizeInternalLinks(links);
}

function buildDefaultBlogBreadcrumbs({ title, slug } = {}) {
  return [
    { name: 'Home', url: '/' },
    { name: 'Waves Blog', url: '/blog/' },
    { name: title || 'Blog Post', url: slug || '/' },
  ];
}

function resolveSchemaState({ draft = {}, frontmatter = {}, body = '' } = {}) {
  const types = new Set(normalizeTextArray(frontmatter.schema_types || draft.schema_types));
  const schemaText = JSON.stringify(draft.schema || frontmatter.schema || '');
  return {
    article: types.has('Article') || types.has('BlogPosting') || /"@type"\s*:\s*"?(Article|BlogPosting)"?/i.test(schemaText),
    breadcrumb: types.has('BreadcrumbList') || /BreadcrumbList/i.test(schemaText),
    faqPage: types.has('FAQPage') || /FAQPage/i.test(schemaText) || false,
    visibleFaqCount: extractVisibleFaqs(body).length,
  };
}

function extractPestPractices(markdown = '') {
  // Writers emit typographic punctuation (don’t, “quotes”, em-dashes) —
  // normalize to ASCII before literal matching or the whatNotToDo bucket
  // never sees a curly-apostrophe "don't".
  const body = String(markdown || '')
    .toLowerCase()
    .replace(/[‘’ʼ]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, '-');
  return {
    identification: matchSection(body, /\b(what you'?re seeing|identify|identification|signs of|what this means|how to tell|what (?:it|they) looks? like|telltale|recognize)\b/),
    swflContext: matchSection(body, /\b(swfl|southwest florida|sarasota|bradenton|lakewood ranch|venice|parrish|palmetto|north port|afternoon storms?|sandy soil|humidity)\b/),
    homeownerChecks: collectSignals(body, ['check', 'look for', 'inspect', 'confirm', 'watch for', 'walk the', 'shine a flashlight']),
    whatNotToDo: collectSignals(body, ['avoid', 'do not', "don't", 'what not to do', 'never ', 'skip the', 'resist the']),
    whenToCallPro: matchSection(body, /\b(when to call|call waves|call a pro|professional|schedule|inspection|exterminator|pest control company)\b/),
    wavesApproach: matchSection(body, /\b(waves pest control|waves can|our approach|we inspect|we treat|we start|our technicians?)\b/),
  };
}

function pestPracticesComplete(practices = {}) {
  return Boolean(
    practices.identification
    && practices.swflContext
    && practices.homeownerChecks?.length
    && practices.whatNotToDo?.length
    && practices.whenToCallPro
    && practices.wavesApproach
  );
}

function extractCtas(markdown = '') {
  const body = String(markdown || '');
  const ctaMatches = body.match(/\b(request a quote|schedule|contact waves|call waves|free inspection|estimate|book|inspection)\b[^.\n]{0,160}/gi) || [];
  return {
    introCta: ctaMatches[0] || '',
    midArticleCta: ctaMatches[1] || '',
    finalCta: ctaMatches.at(-1) || '',
  };
}

function isPestPracticeTopic(brief = {}) {
  const pageType = brief.page_type || brief.pageType;
  if (pageType !== 'supporting-blog') return false;
  const service = normalizeService(brief.service);
  return ['pest', 'termite', 'mosquito', 'rodent', 'lawn', 'tree-shrub', 'specialty'].includes(service);
}

function buildCityTarget(cityName, serviceKey) {
  const name = cleanText(cityName);
  if (!name) return undefined;
  const citySlug = slugify(name);
  const serviceSlug = CITY_SERVICE_SLUG[serviceKey];
  return {
    name,
    slug: citySlug,
    url: serviceSlug ? `/${serviceSlug}-${citySlug}-fl/` : `/service-areas/${citySlug}/`,
  };
}

function normalizeBreadcrumbs(items = []) {
  return (Array.isArray(items) ? items : [])
    .map((item) => ({ name: cleanText(item.name), url: normalizeUrl(item.url) }))
    .filter((item) => item.name && item.url);
}

function normalizeCategory(category, serviceKey) {
  const raw = String(category || '').trim();
  if (raw) return raw;
  return BLOG_CATEGORY_BY_SERVICE[serviceKey]?.value || 'pest-control';
}

function normalizeTextArray(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.map(cleanText).filter(Boolean);
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) return normalizeTextArray(parsed);
    } catch { /* fall through */ }
    return value.split(',').map(cleanText).filter(Boolean);
  }
  return [];
}

function hasRequiredLink(links = [], reason) {
  return links.some((link) => link.reason === reason && link.required !== false);
}

function normalizeService(service) {
  const raw = String(service || '').toLowerCase().trim();
  if (raw === 'pest-control' || raw === 'pest control' || raw === 'general_pest_control') return 'pest';
  if (raw === 'lawn-care' || raw === 'lawn care') return 'lawn';
  if (raw === 'termite-control' || raw === 'termite control' || raw === 'termites') return 'termite';
  if (raw === 'mosquito-control' || raw === 'mosquito control' || raw === 'mosquitoes') return 'mosquito';
  if (raw === 'rodents') return 'rodent';
  return raw || 'pest';
}

function inferLinkReason(url) {
  const path = normalizeUrl(url);
  if (/\/contact\/|quote|estimate|calculator/.test(path)) return 'conversion';
  if (/^\/(?:pest-control|lawn-care|mosquito-control|termite-control|rodent-control)-[a-z0-9-]+-fl\/?$/.test(path)) return 'city';
  if (/\/blog\/|\/[a-z0-9-]+\/?$/.test(path) && !/control|care|inspection|services/.test(path)) return 'related_blog';
  if (/control|care|inspection|services|rodent|termite|mosquito|lawn/.test(path)) return 'service';
  return 'hub';
}

function extractMarkdownLinkItems(markdown = '') {
  const out = [];
  const seen = new Set();
  const re = /\[([^\]]+)\]\((\/[^)\s#?]+\/?)(?:[#?][^)]*)?\)/g;
  let match;
  while ((match = re.exec(String(markdown || ''))) !== null) {
    const url = normalizeUrl(match[2]);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    out.push({ anchorText: cleanText(match[1]), url });
  }
  return out;
}

function extractMarkdownLinks(markdown = '') {
  return extractMarkdownLinkItems(markdown).map((link) => link.url);
}

function normalizeSlug(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  return `/${raw.replace(/^https?:\/\/[^/]+/i, '').replace(/^\/+|\/+$/g, '')}/`;
}

function normalizeUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (/^https?:\/\//i.test(raw)) {
    try { return normalizeSlug(new URL(raw).pathname); } catch { return ''; }
  }
  if (!raw.startsWith('/')) return '';
  return normalizeSlug(raw);
}

function urlPath(value) {
  try { return new URL(String(value || '')).pathname; } catch { return value || ''; }
}

function cleanQuestion(value) {
  return cleanText(String(value || '').replace(/\*\*/g, '')).replace(/\s+#*$/, '');
}

function normalizeAnswer(value) {
  return cleanText(String(value || '')
    .replace(/```[\s\S]*?```/g, '')
    .replace(/!\[[^\]]*]\([^)]+\)/g, '')
    .replace(/\[[^\]]+]\([^)]+\)/g, (m) => m.replace(/\]\([^)]+\)/, ']')));
}

function cleanText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function firstValue(value) {
  return Array.isArray(value) ? value[0] : value;
}

function slugify(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9\s-]/g, '').trim().replace(/\s+/g, '-').replace(/-+/g, '-');
}

function labelForUrl(url) {
  const clean = normalizeUrl(url).replace(/^\/|\/$/g, '').replace(/-/g, ' ');
  return clean || 'internal link';
}

function matchSection(body, pattern) {
  const match = String(body || '').match(pattern);
  return match ? match[0] : '';
}

function collectSignals(body, terms) {
  const text = String(body || '');
  return terms.filter((term) => text.includes(term)).slice(0, 6);
}

function error(code, message) {
  return { code, message };
}

module.exports = {
  BLOG_CATEGORY_BY_SERVICE,
  SERVICE_TARGETS,
  CONTENT_CLUSTERS,
  REVIEW_FLAGS,
  INTERNAL_LINK_REASONS,
  buildSeoRequirements,
  buildBlogSeoContract,
  validateBlogSeoContract,
  extractVisibleFaqs,
  inferContentCluster,
  normalizeInternalLinks,
  pestPracticesComplete,
  _internals: {
    buildDefaultBlogBreadcrumbs,
    buildCityTarget,
    recommendationsFromBrief,
    resolveSchemaState,
    extractPestPractices,
    extractCtas,
    extractMarkdownLinkItems,
    extractMarkdownLinks,
    normalizeSlug,
    normalizeUrl,
    inferLinkReason,
  },
};
