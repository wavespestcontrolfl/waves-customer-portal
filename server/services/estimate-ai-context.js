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

// Family detection for free-text customer QUESTIONS. SERVICE_LABEL_PATTERNS
// stays deliberately loose for classifying service labels, but its unanchored
// alternates ("ant", "bait") substring-match inside question words ("plants"
// contains "ant") — and scoping label facts into the wrong family quotes the
// wrong product's safety guidance. These patterns require whole words.
const SERVICE_FAMILY_QUESTION_PATTERNS = [
  ['pest_control', /\b(?:pests?|roach(?:es)?|cockroach(?:es)?|ants?|spiders?|perimeter)\b/i],
  ['lawn_care', /\b(?:lawns?|turf|weeds?|fertil\w*|fungus|chinch|grass)\b/i],
  ['mosquito', /\b(?:mosquito(?:es)?|midges?|no[-\s]?see[-\s]?ums?)\b/i],
  ['tree_shrub', /\b(?:trees?|shrubs?|ornamentals?)\b/i],
  ['termite_bait', /\b(?:termites?|wdo)\b/i],
  ['palm_injection', /\b(?:palms?|lethal bronzing)\b/i],
  ['rodent_bait', /\b(?:rodents?|rats?|mice|mouse)\b/i],
];

// Customers say "bug spray" for pest control — but a bug/insect word that
// directly follows another family's qualifier ("chinch bug", "lawn insects")
// describes THAT family's insects, and adding pest_control there would scope
// perimeter-pest label facts into a lawn answer. An INDEPENDENT bug mention
// ("the lawn and bug spray") still counts as pest control.
const PEST_GENERIC_INSECT_PATTERN = /\b(?:bugs?|insects?)\b/i;
const QUALIFIED_INSECT_PATTERN = /\b(?:chinch|lawn|turf|grass|trees?|shrubs?|ornamental|palms?|mosquito)\s+(?:bugs?|insects?)\b/gi;

// interior/exterior/inside/outside read as pest control ONLY when tied to a
// treatment ("exterior spray", "treat the outside") — plain location words
// ("my outside plants") say nothing about which service is being asked
// about, and mis-scoping them starves the real family's label facts.
const PEST_PERIMETER_CONTEXT_PATTERN = /\b(?:interiors?|exteriors?|inside|outside)\s+(?:treat\w*|appl\w*|spray\w*|service|barrier|pest\w*)\b|\b(?:spray\w*|treat\w*|apply\w*|service)\s+(?:the\s+|my\s+|our\s+)?(?:interiors?|exteriors?|inside|outside)\b/i;

// "Safe for the lawn" / "will it hurt my shrubs" name the RECIPIENT of a
// treatment, not the treatment family the customer is asking about — strip
// these phrases before family matching so "is the mosquito spray safe for
// the lawn?" scopes to mosquito, not mosquito + lawn. The trailing negative
// lookahead protects TARGET phrasing: "for the lawn treatment/care/program"
// qualifies the treatment being asked about and must keep its family.
const AFFECTED_AREA_PATTERN = /\b(?:for|on|onto|near|around|hurt|harms?|damage|kills?|burn|stains?)\s+(?:the\s+|my\s+|our\s+)?(?:lawns?|turf|grass|yards?|trees?|shrubs?|plants?|palms?)\b(?!\s+(?:treat\w*|appl\w*|spray\w*|service|care|program|plan))/gi;

// ALL families a question names, not just the first — a bundle question like
// "are the lawn and mosquito treatments safe?" targets two families and the
// assistant must scope label facts to every one of them.
function serviceFamiliesFromText(value) {
  const text = cleanText(value);
  if (!text) return [];
  // Affected-area phrases name recipients, not target families.
  const targeted = text.replace(AFFECTED_AREA_PATTERN, ' ');
  const families = SERVICE_FAMILY_QUESTION_PATTERNS
    .filter(([, pattern]) => pattern.test(targeted))
    .map(([key]) => key);
  if (!families.includes('pest_control') && PEST_PERIMETER_CONTEXT_PATTERN.test(targeted)) {
    families.push('pest_control');
  }
  // Strip family-qualified insect phrases, so only INDEPENDENT bug/insect
  // wording reads as pest control — "the lawn and bug spray" adds
  // pest_control, "the chinch bug treatment" does not.
  const unqualified = targeted.replace(QUALIFIED_INSECT_PATTERN, ' ');
  if (!families.includes('pest_control') && PEST_GENERIC_INSECT_PATTERN.test(unqualified)) {
    families.push('pest_control');
  }
  return families;
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

  // Question-derived keys use the whole-word family matcher — the loose
  // label patterns substring-match free text ("plants" contains "ant"),
  // which would load the wrong family's products into the support context
  // before scoping ever runs. Labels themselves stay on the loose matcher.
  const questionFamilies = serviceFamiliesFromText(question);
  if (questionFamilies.length) keys.unshift(...questionFamilies);
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

// Name tokens too generic to identify a product — a product named "Lawn
// Fertilizer Pro" must not name-match every lawn question.
const GENERIC_NAME_TOKENS = new Set([
  'lawn', 'turf', 'weed', 'pest', 'mosquito', 'insect', 'herbicide', 'insecticide',
  'fungicide', 'fertilizer', 'granular', 'liquid', 'control', 'spray', 'concentrate',
  'professional', 'select', 'ultra', 'super', 'plus', 'max', 'pro',
]);

// Does the question name this product? Compared as normalized whole tokens
// (distinctive ones only: >=5 chars or containing a digit), so the row can
// carry a BOOLEAN — the product name itself never enters the support
// context; customer copy tells them to call for the exact product.
function questionNamesProduct(name, questionWords) {
  if (!questionWords.length) return false;
  const tokens = cleanText(name || '')
    .toLowerCase()
    .split(/\s+/)
    .map((token) => token.replace(/[^a-z0-9]+/g, ''))
    .filter((token) => (token.length >= 5 || /\d/.test(token))
      && token.length >= 2
      && !GENERIC_NAME_TOKENS.has(token));
  return tokens.some((token) => questionWords.includes(token));
}

// Returns {rows, truncated}: truncated=true when the query filled the row
// cap, meaning more matching products exist than were loaded — completeness
// claims ("every product is rainfast within N minutes") must not be made
// from a truncated slice.
async function searchProductCatalog(db, terms, productNames = [], productFamiliesByName = {}, question = '') {
  const lookupTerms = unique([...terms, ...productNames]).slice(0, 20);
  if (!db || !lookupTerms.length) return { rows: [], truncated: false };
  const questionWords = cleanText(question)
    .toLowerCase()
    .split(/\s+/)
    .map((word) => word.replace(/[^a-z0-9]+/g, ''))
    .filter(Boolean);
  // Attribute a catalog row to service families via the service library's
  // default_products linkage (real data, not a guessed category map), so the
  // assistant can scope family-specific safety questions to the right product.
  // Besides whole-string containment, aliases match TOKEN-WISE: the service
  // library may list "Advion Gel" while the catalog row is "Advion Cockroach
  // Gel" — an alias whose distinctive tokens all appear in the name still
  // attributes.
  const tokensOf = (value) => cleanText(value || '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 2);
  const familyEntries = Object.entries(productFamiliesByName)
    .filter(([name]) => name.length >= 4);
  const familiesForProduct = (name) => {
    const key = cleanText(name || '').toLowerCase();
    if (!key) return [];
    const nameTokens = new Set(tokensOf(key));
    return unique(familyEntries
      .filter(([productName]) => {
        if (key.includes(productName) || productName.includes(key)) return true;
        const aliasTokens = tokensOf(productName);
        if (!aliasTokens.length || !aliasTokens.some((token) => token.length >= 4 || /\d/.test(token))) {
          return false;
        }
        return aliasTokens.every((token) => nameTokens.has(token));
      })
      .flatMap(([, families]) => families));
  };
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
      .select('name', 'category', 'active_ingredient', 'moa_group', 'default_rate', 'default_unit', 'epa_reg_number', 'label_verified_by', 'label_verified_at', 'label_version',
        'signal_word', 'ppe_text', 'rei_hours', 'rainfast_minutes', 'reentry_summary', 'reentry_text', 'irrigation_notes')
      .limit(8);

    const shaped = rows.map((row) => {
      // Label-verified safety facts (signal word, re-entry, rainfast,
      // irrigation timing) let Ask Waves answer "is it pet safe?" from the
      // product's own reviewed label instead of generic knowledge. Fail
      // closed: only label-verified rows may drive customer safety claims.
      // A real verification stamp is label_verified_by (admin review) or
      // label_verified_at (the inventory readiness gate, admin-inventory
      // lawnFactReadiness; also what the seeded label-facts lane stamps).
      // label_version alone does NOT count — the inventory workflow lets it
      // be edited independently of verification, so a source-version-only
      // draft row must not drive customer safety claims.
      // rei_hours = 0 is the owner-confirmed residential value ("until
      // sprays have dried"), NOT a zero-hour claim; null = unknown.
      const labelVerified = !!(row.label_verified_by || row.label_verified_at);
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
        labelVerified ? 'Label verified in admin catalog' : '',
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
        irrigationNotes: labelVerified ? (trimSnippet(row.irrigation_notes || '') || null) : null,
        serviceKeys: familiesForProduct(row.name),
        questionNameMatch: questionNamesProduct(row.name, questionWords),
        snippet: trimSnippet(parts.join(' - ')),
      };
    }).filter((row) => row.snippet || row.title);
    return { rows: shaped, truncated: rows.length >= 8 };
  } catch (err) {
    logger.warn(`[estimate-ai-context] products_catalog lookup skipped: ${err.message}`);
    return { rows: [], truncated: false };
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
  // Map each service-library default product to the service family (via the
  // shared label patterns) so catalog rows can carry serviceKeys attribution.
  const productFamiliesByName = {};
  for (const row of serviceLibrary) {
    const family = serviceKeyFromText([row.path, row.title, row.category].filter(Boolean).join(' '));
    if (!family) continue;
    for (const name of row._productNames || []) {
      const key = cleanText(name).toLowerCase();
      if (!key) continue;
      productFamiliesByName[key] = unique([...(productFamiliesByName[key] || []), family]);
    }
  }
  const productCatalogResult = await searchProductCatalog(db, searchTerms, serviceProductNames, productFamiliesByName, question);
  const publicServiceLibrary = serviceLibrary.map(({ _productNames, ...row }) => row);

  return {
    serviceKeys,
    searchTerms,
    knowledgeBase,
    agronomicWiki,
    serviceLibrary: publicServiceLibrary,
    productCatalog: productCatalogResult.rows,
    productCatalogTruncated: productCatalogResult.truncated,
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
  serviceFamiliesFromText,
  searchTermsFromContext,
};
