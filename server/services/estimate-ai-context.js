const fs = require('fs');
const path = require('path');
const logger = require('./logger');

const ROOT = path.resolve(__dirname, '..', '..');
const MAX_SEARCH_TERMS = 10;
const MAX_SNIPPET_CHARS = 520;

const SERVICE_KEYWORDS = {
  pest_control: ['pest', 'roach', 'ant', 'spider', 'perimeter', 'interior', 'exterior', 'waveguard'],
  lawn_care: ['lawn', 'turf', 'weed', 'fertilizer', 'fungus', 'chinch', 'st augustine', 'bermuda', 'zoysia'],
  mosquito: ['mosquito', 'mosquitoes', 'barrier', 'breeding', 'standing water'],
  tree_shrub: ['tree', 'shrub', 'ornamental', 'landscape', 'disease', 'mites', 'scale'],
  termite_bait: ['termite', 'bait', 'monitoring', 'station', 'wdo'],
  termite: ['termite', 'bait', 'monitoring', 'station', 'wdo'],
  palm_injection: ['palm', 'injection', 'lethal bronzing', 'nutrition', 'borer'],
  rodent_bait: ['rodent', 'rat', 'mouse', 'bait station', 'monitoring'],
  one_time_lawn: ['lawn', 'fungicide', 'weed', 'fertilization', 'follow-up'],
  one_time_mosquito: ['mosquito', 'event', 'one-time', 'barrier'],
};

const SERVICE_LABEL_PATTERNS = [
  ['pest_control', /\bpest|roach|ant|spider|perimeter\b/i],
  ['lawn_care', /\blawn|turf|weed|fertil|fungus|chinch|grass\b/i],
  ['mosquito', /\bmosquito|midge|no[-\s]?see[-\s]?um\b/i],
  ['tree_shrub', /\btree|shrub|ornamental|landscape plant\b/i],
  ['termite_bait', /\btermite|wdo|bait\b/i],
  ['palm_injection', /\bpalm|injection|lethal bronzing\b/i],
  ['rodent_bait', /\brodent|rat|mouse|bait station\b/i],
];

const REPO_CONTEXT_FILES = [
  'wiki/business-strategy/waveguard-tier-logic.md',
  'wiki/business-strategy/route-density-economics.md',
  'wiki/services/service-dispatch-rules.md',
  'wiki/protocols/routing-rules.md',
  'docs/pricing/POLICY.md',
  'docs/TERMITE-PRICING.md',
  'docs/editorial-policy-v2.md',
  'server/config/protocols.json',
  'server/services/pricing-engine/README.md',
];

const REPO_CONTEXT_DIRS = ['wiki', 'docs'];
const REPO_CONTEXT_FILE_LIMIT = 80;

const EXTERNAL_REFERENCES = {
  general: [
    {
      title: 'EPA pesticide label lookup',
      url: 'https://ordspub.epa.gov/ords/pesticides/f?p=PPLS:1',
      relevance: 'Product label, EPA registration, and label direction verification.',
    },
    {
      title: 'FDACS pest control program',
      url: 'https://www.fdacs.gov/Business-Services/Pest-Control',
      relevance: 'Florida pest control licensing and regulatory context.',
    },
    {
      title: 'UF/IFAS EDIS publications',
      url: 'https://edis.ifas.ufl.edu/',
      relevance: 'Florida extension research for pest biology, turf, fertilizer, and landscape care.',
    },
  ],
  lawn_care: [
    {
      title: 'Florida-Friendly Landscaping fertilizer resources',
      url: 'https://ffl.ifas.ufl.edu/resources/',
      relevance: 'Florida turf and fertilizer guidance, including local ordinance context.',
    },
    {
      title: 'FAWN current weather observations',
      url: 'https://fawn.ifas.ufl.edu/',
      relevance: 'Florida weather context for treatment timing and turf stress.',
    },
  ],
  mosquito: [
    {
      title: 'EPA mosquito control',
      url: 'https://www.epa.gov/mosquitocontrol',
      relevance: 'Mosquito control and pesticide safety overview.',
    },
  ],
  pest_control: [
    {
      title: 'EPA pesticides and pests',
      url: 'https://www.epa.gov/pesticides',
      relevance: 'Federal pesticide registration and safe-use reference.',
    },
  ],
  termite_bait: [
    {
      title: 'FDACS pest control forms and records',
      url: 'https://www.fdacs.gov/Business-Services/Pest-Control/Pest-Control-Forms',
      relevance: 'Florida termite/WDO documentation context.',
    },
  ],
};

function cleanText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function unique(values) {
  const seen = new Set();
  return values.filter((value) => {
    const key = cleanText(value).toLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function serviceKeyFromText(value) {
  const text = cleanText(value);
  for (const [key, pattern] of SERVICE_LABEL_PATTERNS) {
    if (pattern.test(text)) return key;
  }
  return null;
}

function serviceKeysFromContext(context = {}, question = '') {
  const keys = [];
  const serviceRows = [
    ...(Array.isArray(context.services) ? context.services : []),
    ...(Array.isArray(context.recurringServices) ? context.recurringServices : []),
    ...(Array.isArray(context.oneTime?.items) ? context.oneTime.items : []),
  ];

  for (const row of serviceRows) {
    const key = serviceKeyFromText([row.label, row.detail, row.summary].filter(Boolean).join(' '));
    if (key) keys.push(key);
  }

  const questionKey = serviceKeyFromText(question);
  if (questionKey) keys.unshift(questionKey);
  return unique(keys);
}

function searchTermsFromContext(context = {}, question = '') {
  const services = [
    ...(Array.isArray(context.services) ? context.services : []),
    ...(Array.isArray(context.recurringServices) ? context.recurringServices : []),
  ];
  const serviceLabels = services
    .flatMap((row) => [row.label, row.detail])
    .filter(Boolean);
  const keys = serviceKeysFromContext(context, question);
  const serviceTerms = keys.flatMap((key) => SERVICE_KEYWORDS[key] || []);
  const questionTerms = cleanText(question)
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((term) => term.length >= 4 && !['what', 'when', 'this', 'that', 'does', 'with', 'from', 'have', 'price', 'cost'].includes(term));

  const requiredContextTerms = unique([
    cleanText(context.waveGuardTier),
    'WaveGuard',
    'Southwest Florida',
  ]);
  const searchableTerms = unique([
    ...serviceLabels,
    ...serviceTerms,
    ...questionTerms,
  ]);
  const searchableBudget = Math.max(0, MAX_SEARCH_TERMS - requiredContextTerms.length);

  return unique([
    ...searchableTerms.slice(0, searchableBudget),
    ...requiredContextTerms,
  ]).slice(0, MAX_SEARCH_TERMS);
}

function trimSnippet(value) {
  const text = cleanText(value);
  if (text.length <= MAX_SNIPPET_CHARS) return text;
  return `${text.slice(0, MAX_SNIPPET_CHARS - 1).trim()}...`;
}

function rowSnippet(row = {}) {
  return trimSnippet(row.summary || row.content || row.body || '');
}

async function searchKnowledgeBase(db, terms) {
  if (!db || !terms.length) return [];
  try {
    const rows = await db('knowledge_base')
      .where(function activeKnowledge() {
        this.where({ active: true }).orWhereNull('active');
      })
      .where(function relevantKnowledge() {
        for (const term of terms) {
          const like = `%${term}%`;
          this.orWhere('title', 'ilike', like)
            .orWhere('summary', 'ilike', like)
            .orWhere('content', 'ilike', like)
            .orWhereRaw('tags::text ILIKE ?', [like])
            .orWhere('category', 'ilike', like);
        }
      })
      .select('path', 'title', 'summary', 'category', 'content')
      .limit(6);

    return rows.map((row) => ({
      source: 'knowledge_base',
      path: row.path,
      title: row.title,
      category: row.category || null,
      snippet: rowSnippet(row),
    })).filter((row) => row.snippet || row.title);
  } catch (err) {
    logger.warn(`[estimate-ai-context] knowledge_base lookup skipped: ${err.message}`);
    return [];
  }
}

async function searchAgronomicWiki(db, terms) {
  if (!db || !terms.length) return [];
  try {
    const rows = await db('knowledge_entries')
      .where(function freshWiki() {
        this.where({ stale_flag: false }).orWhereNull('stale_flag');
      })
      .where(function relevantWiki() {
        for (const term of terms) {
          const like = `%${term}%`;
          this.orWhere('title', 'ilike', like)
            .orWhere('summary', 'ilike', like)
            .orWhere('content', 'ilike', like)
            .orWhereRaw('tags::text ILIKE ?', [like])
            .orWhere('category', 'ilike', like);
        }
      })
      .select('slug', 'title', 'summary', 'category', 'content', 'confidence', 'data_point_count')
      .limit(5);

    return rows.map((row) => ({
      source: 'agronomic_wiki',
      path: row.slug,
      title: row.title,
      category: row.category || null,
      confidence: row.confidence || null,
      dataPointCount: row.data_point_count || 0,
      snippet: rowSnippet(row),
    })).filter((row) => row.snippet || row.title);
  } catch (err) {
    logger.warn(`[estimate-ai-context] knowledge_entries lookup skipped: ${err.message}`);
    return [];
  }
}

function parseJsonList(value) {
  if (Array.isArray(value)) return value.map(cleanText).filter(Boolean);
  if (value && typeof value === 'object') return Object.values(value).map(cleanText).filter(Boolean);
  if (typeof value !== 'string') return [];
  try {
    const parsed = JSON.parse(value);
    return parseJsonList(parsed);
  } catch {
    return value.split(',').map(cleanText).filter(Boolean);
  }
}

async function searchServiceLibrary(db, terms) {
  if (!db || !terms.length) return [];
  try {
    const rows = await db('services')
      .where(function activeServices() {
        this.where({ is_active: true }).orWhereNull('is_active');
      })
      .where(function relevantServices() {
        for (const term of terms) {
          const like = `%${term}%`;
          this.orWhere('service_key', 'ilike', like)
            .orWhere('name', 'ilike', like)
            .orWhere('short_name', 'ilike', like)
            .orWhere('description', 'ilike', like)
            .orWhere('category', 'ilike', like)
            .orWhereRaw('default_products::text ILIKE ?', [like]);
        }
      })
      .select('service_key', 'name', 'description', 'category', 'frequency', 'visits_per_year', 'default_products')
      .limit(6);

    return rows.map((row) => {
      const products = parseJsonList(row.default_products);
      const parts = [
        row.description,
        row.frequency ? `Frequency: ${row.frequency}` : '',
        row.visits_per_year ? `Visits per year: ${row.visits_per_year}` : '',
      ].filter(Boolean);
      return {
        source: 'admin_service_library',
        path: row.service_key,
        title: row.name || row.service_key,
        category: row.category || null,
        _productNames: products,
        snippet: trimSnippet(parts.join(' ')),
      };
    }).filter((row) => row.snippet || row.title);
  } catch (err) {
    logger.warn(`[estimate-ai-context] services lookup skipped: ${err.message}`);
    return [];
  }
}

async function searchProductCatalog(db, terms, productNames = []) {
  const lookupTerms = unique([...terms, ...productNames]).slice(0, 20);
  if (!db || !lookupTerms.length) return [];
  try {
    const rows = await db('products_catalog')
      .where(function activeProducts() {
        this.where({ active: true }).orWhereNull('active');
      })
      .where(function relevantProducts() {
        for (const term of lookupTerms) {
          const like = `%${term}%`;
          this.orWhere('name', 'ilike', like)
            .orWhere('category', 'ilike', like)
            .orWhere('active_ingredient', 'ilike', like)
            .orWhere('moa_group', 'ilike', like);
        }
      })
      .select('name', 'category', 'active_ingredient', 'moa_group', 'default_rate', 'default_unit', 'epa_reg_number', 'label_verified_by',
        'signal_word', 'ppe_text', 'rei_hours', 'rainfast_minutes', 'reentry_summary', 'reentry_text', 'irrigation_notes')
      .limit(8);

    return rows.map((row) => {
      // Label-verified safety facts (signal word, re-entry, rainfast,
      // irrigation timing) let Ask Waves answer "is it pet safe?" from the
      // product's own reviewed label instead of generic knowledge. Fail
      // closed: only label-verified rows may drive customer safety claims.
      // rei_hours = 0 is the owner-confirmed residential value ("until
      // sprays have dried"), NOT a zero-hour claim; null = unknown.
      const labelVerified = !!row.label_verified_by;
      const reentryText = labelVerified
        ? trimSnippet(row.reentry_summary || row.reentry_text || '')
          || (row.rei_hours == null ? '' : (Number(row.rei_hours) === 0
            ? 'Re-enter once sprays have dried'
            : `Re-entry after about ${Number(row.rei_hours)} hour${Number(row.rei_hours) === 1 ? '' : 's'}`))
        : '';
      const safetyParts = labelVerified ? [
        row.signal_word ? `Label signal word: ${row.signal_word}` : '',
        reentryText ? `Re-entry: ${reentryText}` : '',
        Number(row.rainfast_minutes) > 0 ? `Rainfast in about ${Number(row.rainfast_minutes)} minutes` : '',
        row.irrigation_notes ? `Rain/irrigation timing: ${trimSnippet(row.irrigation_notes)}` : '',
        row.ppe_text ? `Applicator PPE (worn by the technician): ${trimSnippet(row.ppe_text)}` : '',
      ] : [];
      const parts = [
        row.category,
        row.active_ingredient ? `Active ingredient: ${row.active_ingredient}` : '',
        row.moa_group ? `MOA: ${row.moa_group}` : '',
        row.epa_reg_number ? `EPA Reg. No. ${row.epa_reg_number}` : '',
        row.label_verified_by ? 'Label verified in admin catalog' : '',
        ...safetyParts,
      ].filter(Boolean);
      return {
        source: 'admin_product_catalog',
        path: row.active_ingredient || row.category || 'product_catalog',
        title: row.active_ingredient ? `${row.category || 'Product'} active ingredient` : (row.category || 'Product catalog entry'),
        category: row.category || null,
        activeIngredient: row.active_ingredient || null,
        epaRegNumber: row.epa_reg_number || null,
        labelVerified,
        signalWord: labelVerified ? (row.signal_word || null) : null,
        reentry: reentryText || null,
        rainfastMinutes: labelVerified && Number(row.rainfast_minutes) > 0 ? Number(row.rainfast_minutes) : null,
        snippet: trimSnippet(parts.join(' - ')),
      };
    }).filter((row) => row.snippet || row.title);
  } catch (err) {
    logger.warn(`[estimate-ai-context] products_catalog lookup skipped: ${err.message}`);
    return [];
  }
}

function scoreLine(line, terms) {
  const lower = line.toLowerCase();
  return terms.reduce((score, term) => score + (lower.includes(term.toLowerCase()) ? 1 : 0), 0);
}

function snippetFromFile(relativePath, terms) {
  const fullPath = path.join(ROOT, relativePath);
  if (!fullPath.startsWith(ROOT) || !fs.existsSync(fullPath)) return null;
  let text = '';
  try {
    text = fs.readFileSync(fullPath, 'utf8');
  } catch {
    return null;
  }
  const lines = text.split(/\r?\n/);
  let bestIndex = -1;
  let bestScore = 0;
  lines.forEach((line, index) => {
    const score = scoreLine(line, terms);
    if (score > bestScore) {
      bestScore = score;
      bestIndex = index;
    }
  });
  if (bestIndex < 0) return null;
  const start = Math.max(0, bestIndex - 2);
  const end = Math.min(lines.length, bestIndex + 5);
  return {
    source: 'repo_file',
    path: relativePath,
    line: bestIndex + 1,
    title: relativePath,
    snippet: trimSnippet(lines.slice(start, end).join(' ')),
  };
}

function loadRepoContext(terms) {
  if (!terms.length) return [];
  const discovered = [];
  for (const dir of REPO_CONTEXT_DIRS) {
    discovered.push(...discoverMarkdownFiles(dir));
  }
  return unique([...REPO_CONTEXT_FILES, ...discovered])
    .map((file) => snippetFromFile(file, terms))
    .filter(Boolean)
    .slice(0, 5);
}

function discoverMarkdownFiles(relativeDir) {
  const root = path.join(ROOT, relativeDir);
  if (!root.startsWith(ROOT) || !fs.existsSync(root)) return [];
  const out = [];
  const walk = (dir) => {
    if (out.length >= REPO_CONTEXT_FILE_LIMIT) return;
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (out.length >= REPO_CONTEXT_FILE_LIMIT) break;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile() && /\.mdx?$/i.test(entry.name)) {
        out.push(path.relative(ROOT, full));
      }
    }
  };
  walk(root);
  return out;
}

function externalReferencesFor(serviceKeys) {
  const refs = [
    ...(EXTERNAL_REFERENCES.general || []),
    ...serviceKeys.flatMap((key) => EXTERNAL_REFERENCES[key] || []),
  ];
  const seen = new Set();
  return refs.filter((ref) => {
    const key = ref.url;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 8);
}

async function loadEstimateAiSupportContext({ db, question, context } = {}) {
  const serviceKeys = serviceKeysFromContext(context, question);
  const searchTerms = searchTermsFromContext(context, question);

  const [knowledgeBase, agronomicWiki, serviceLibrary] = await Promise.all([
    searchKnowledgeBase(db, searchTerms),
    searchAgronomicWiki(db, searchTerms),
    searchServiceLibrary(db, searchTerms),
  ]);
  const serviceProductNames = serviceLibrary.flatMap((row) => row._productNames || []);
  const productCatalog = await searchProductCatalog(db, searchTerms, serviceProductNames);
  const publicServiceLibrary = serviceLibrary.map(({ _productNames, ...row }) => row);

  return {
    serviceKeys,
    searchTerms,
    knowledgeBase,
    agronomicWiki,
    serviceLibrary: publicServiceLibrary,
    productCatalog,
    repositoryFiles: loadRepoContext(searchTerms),
    externalSources: externalReferencesFor(serviceKeys),
  };
}

function loadPublicEstimateSupportSources({ question, context } = {}) {
  const serviceKeys = serviceKeysFromContext(context, question);
  return externalReferencesFor(serviceKeys);
}

module.exports = {
  loadEstimateAiSupportContext,
  loadPublicEstimateSupportSources,
  serviceKeysFromContext,
  searchTermsFromContext,
};
