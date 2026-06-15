const db = require('../models/db');
const { WAVES_LOCATIONS, resolveLocation } = require('../config/locations');
const SocialMediaService = require('./social-media');
const {
  SOCIAL_FLAGS,
  isPausedByAdmin,
  validateContent,
  normalizeUrl,
} = require('./social-media');
const SocialCardRenderer = require('./social-card-renderer');

const FASTEST_RISER_PROFILES = [
  {
    companyName: 'Brooks Pest Solutions',
    pctRank: 64,
    revenueRank: 64,
    growthPct: 955,
    city: 'Orem',
    state: 'UT',
    strategicNotes: [
      'Fastest riser on the 2026 PCT Top 100 poster.',
      'Residential-heavy model with simple pest-service positioning.',
      'Use as a benchmark for short-form proof, neighborhood relevance, and aggressive review capture.',
    ],
  },
  {
    companyName: 'Proforce Pest Control',
    pctRank: 56,
    revenueRank: 56,
    growthPct: 500,
    city: 'Boca Raton',
    state: 'FL',
    profileUrls: { website: 'https://proforcepest.com/' },
    strategicNotes: [
      'Florida peer with the largest non-acquisition growth signal in the poster.',
      'Owned-site positioning emphasizes proof count, service accountability, local service pros, and seasonal pressure.',
      'Good pattern for Waves: local problem, proof, accountable next step.',
    ],
  },
  {
    companyName: 'Certus',
    pctRank: 15,
    revenueRank: 15,
    growthPct: 85,
    city: 'Tampa',
    state: 'FL',
    strategicNotes: [
      'High-growth Florida-based consolidator.',
      'Useful for studying multi-location brand consistency and branch-local adaptation.',
    ],
  },
  {
    companyName: 'Banner Pest Services',
    pctRank: 90,
    revenueRank: 90,
    growthPct: 63,
    city: 'San Jose',
    state: 'CA',
    strategicNotes: [
      'Fast riser with likely local-market lead-generation discipline.',
      'Track visible engagement on educational posts versus offer posts.',
    ],
  },
  {
    companyName: 'Best Home & Property Services',
    pctRank: 100,
    revenueRank: 100,
    growthPct: 60,
    city: 'Longs',
    state: 'SC',
    strategicNotes: [
      'New Top 100 entrant with broad home/property service mix.',
      'Watch cross-sell content where pest control is packaged with other home services.',
    ],
  },
  {
    companyName: 'Pest Control Consultants',
    pctRank: 89,
    revenueRank: 89,
    growthPct: 55,
    city: 'Dixon',
    state: 'IL',
    strategicNotes: [
      'New Top 100 entrant with strong growth.',
      'Useful benchmark for simple local authority posts and testimonial cadence.',
    ],
  },
  {
    companyName: 'Prodigy Pest Solutions',
    pctRank: 98,
    revenueRank: 98,
    growthPct: 52,
    city: 'Sarasota',
    state: 'FL',
    strategicNotes: [
      'Direct local competitor in Sarasota and one of the fastest risers.',
      'High-priority manual profile/post capture target for Waves.',
    ],
  },
  {
    companyName: 'Go-Forth Home Services',
    pctRank: 33,
    revenueRank: 33,
    growthPct: 40,
    city: 'High Point',
    state: 'NC',
    strategicNotes: [
      'Home services branding, not only pest control.',
      'Useful for studying community, commercial, and service-bundle posts.',
    ],
  },
  {
    companyName: 'Senske Family of Companies',
    pctRank: 10,
    revenueRank: 10,
    growthPct: 40,
    city: 'Dallas',
    state: 'TX',
    strategicNotes: [
      'Large multi-service brand with high growth.',
      'Good pattern source for lawn, pest, tree, and seasonal cross-sell content.',
    ],
  },
  {
    companyName: 'Mosquito Authority & Pest Authority',
    pctRank: 21,
    revenueRank: 21,
    growthPct: 30,
    city: 'Charlotte',
    state: 'NC',
    strategicNotes: [
      'New entrant with mosquito-first seasonal urgency.',
      'Good source for rain, standing water, outdoor-living, and recurring barrier messaging.',
    ],
  },
  {
    companyName: 'All U Need Pest Control',
    pctRank: 41,
    revenueRank: 41,
    growthPct: 33,
    city: 'Fort Myers',
    state: 'FL',
    profileUrls: { website: 'https://www.alluneedpest.com/' },
    strategicNotes: [
      'Southwest Florida peer with meaningful growth.',
      'Track review proof, local office/service-area content, and offer cadence.',
    ],
  },
  {
    companyName: 'Native Pest Management',
    pctRank: 63,
    revenueRank: 63,
    growthPct: 30,
    city: 'Tallahassee',
    state: 'FL',
    profileUrls: { website: 'https://www.nativepestmanagement.com/' },
    strategicNotes: [
      'Florida peer with strong review and trust positioning.',
      'Useful for family/pet-safe framing, inspection CTAs, and Florida-specific education.',
    ],
  },
];

const DEFAULT_COMPETITOR_PATTERNS = [
  {
    key: 'local_trigger_fact_cta',
    label: 'Local trigger + fact + soft CTA',
    copyablePattern: 'Name the city and trigger, give one specific pest fact, end with a low-pressure inspection or guide CTA.',
  },
  {
    key: 'proof_number',
    label: 'Proof number',
    copyablePattern: 'Lead with a concrete trust signal, then tie it to what the homeowner gets from the service.',
  },
  {
    key: 'review_card',
    label: 'Review card',
    copyablePattern: 'Turn a real 5-star review into a clean first-name/city graphic, then add a short caption about the service outcome.',
  },
  {
    key: 'technician_authority',
    label: 'Technician authority',
    copyablePattern: 'Show what a tech notices in seconds, then explain what it means for the homeowner.',
  },
  {
    key: 'seasonal_urgency',
    label: 'Seasonal urgency',
    copyablePattern: 'Tie pest pressure to rain, humidity, swarms, or turf stress without fearmongering.',
  },
  {
    key: 'service_carousel',
    label: 'Service carousel',
    copyablePattern: 'Use one slide/card per pest or symptom, each with a one-line diagnostic clue.',
  },
];

const CHANNELS = ['facebook', 'instagram', 'linkedin', 'gbp'];
const AUTONOMOUS_SOURCE = 'autonomous_studio';

const SEASONAL_AUTONOMOUS_TOPICS = {
  1: [
    { topic: 'winter pest pressure indoors', service: 'general pest', angle: 'signs to check', cta: 'book inspection' },
    { topic: 'winter weeds in St. Augustine lawns', service: 'lawn care', angle: 'what we are seeing', cta: 'request estimate' },
  ],
  2: [
    { topic: 'early termite swarm season', service: 'termite', angle: 'new Florida homeowner', cta: 'book inspection' },
    { topic: 'spring lawn green-up problems', service: 'lawn care', angle: 'signs to check', cta: 'request estimate' },
  ],
  3: [
    { topic: 'peak termite swarm month', service: 'termite', angle: 'do not ignore this', cta: 'book inspection' },
    { topic: 'chinch bug pressure starting early', service: 'lawn care', angle: 'myth/fact', cta: 'read guide' },
  ],
  4: [
    { topic: 'mosquito season starting after rain', service: 'mosquito', angle: 'what we are seeing', cta: 'request estimate' },
    { topic: 'Formosan termite swarmers', service: 'termite', angle: 'signs to check', cta: 'book inspection' },
  ],
  5: [
    { topic: 'rainy season mosquito pressure', service: 'mosquito', angle: 'what we are seeing', cta: 'request estimate' },
    { topic: 'ants moving around lanais', service: 'general pest', angle: 'signs to check', cta: 'book inspection' },
  ],
  6: [
    { topic: 'mosquito surge after afternoon storms', service: 'mosquito', angle: 'what we are seeing', cta: 'request estimate' },
    { topic: 'summer roaches moving indoors', service: 'general pest', angle: 'new Florida homeowner', cta: 'book inspection' },
    { topic: 'lawn fungus after rain', service: 'lawn care', angle: 'signs to check', cta: 'read guide' },
  ],
  7: [
    { topic: 'peak summer pest pressure', service: 'general pest', angle: 'what we are seeing', cta: 'book inspection' },
    { topic: 'chinch bug damage that looks like drought', service: 'lawn care', angle: 'myth/fact', cta: 'read guide' },
    { topic: 'mosquito pressure at maximum', service: 'mosquito', angle: 'do not ignore this', cta: 'request estimate' },
  ],
  8: [
    { topic: 'late-summer mosquito pressure', service: 'mosquito', angle: 'what we are seeing', cta: 'request estimate' },
    { topic: 'ants and roaches after heavy rain', service: 'general pest', angle: 'signs to check', cta: 'book inspection' },
  ],
  9: [
    { topic: 'last stretch of peak mosquito season', service: 'mosquito', angle: 'what we are seeing', cta: 'request estimate' },
    { topic: 'fall lawn recovery after summer stress', service: 'lawn care', angle: 'signs to check', cta: 'request estimate' },
  ],
  10: [
    { topic: 'fall lawn recovery season', service: 'lawn care', angle: 'what we are seeing', cta: 'request estimate' },
    { topic: 'rodent entry points before cooler weather', service: 'rodent', angle: 'signs to check', cta: 'book inspection' },
  ],
  11: [
    { topic: 'holiday guest pest prevention', service: 'general pest', angle: 'signs to check', cta: 'book inspection' },
    { topic: 'winter weed prevention', service: 'lawn care', angle: 'what we are seeing', cta: 'read guide' },
  ],
  12: [
    { topic: 'holiday-ready pest control', service: 'general pest', angle: 'new Florida homeowner', cta: 'book inspection' },
    { topic: 'winter lawn weed pressure', service: 'lawn care', angle: 'myth/fact', cta: 'request estimate' },
  ],
};

function toJson(value, fallback) {
  if (value == null) return fallback;
  if (Array.isArray(value) || typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function cleanText(value, max = 500) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function firstSentence(value, max = 220) {
  const text = cleanText(value, max * 2);
  if (!text) return '';
  const sentence = text.match(/^(.+?[.!?])\s/)?.[1] || text;
  return sentence.length > max ? `${sentence.slice(0, max - 3).trim()}...` : sentence;
}

function titleCase(value) {
  return cleanText(value)
    .toLowerCase()
    .replace(/\b[a-z]/g, (m) => m.toUpperCase());
}

function normalizeChannels(channels) {
  const selected = Array.isArray(channels) && channels.length ? channels : CHANNELS;
  return selected.filter((p) => CHANNELS.includes(p));
}

async function hasTable(table) {
  try {
    return await db.schema.hasTable(table);
  } catch {
    return false;
  }
}

async function hasColumn(table, column) {
  try {
    return await db.schema.hasColumn(table, column);
  } catch {
    return false;
  }
}

function boolEnv(key, defaultValue = false) {
  const value = process.env[key];
  if (value == null || value === '') return defaultValue;
  return ['true', '1', 'yes', 'on'].includes(String(value).toLowerCase());
}

function numberEnv(key, defaultValue) {
  const value = Number(process.env[key]);
  return Number.isFinite(value) && value > 0 ? value : defaultValue;
}

const AUTONOMOUS_FLAGS = {
  get enabled() { return boolEnv('SOCIAL_AUTONOMOUS_STUDIO_ENABLED', false); },
  get includeReviews() { return boolEnv('SOCIAL_AUTONOMOUS_INCLUDE_REVIEWS', true); },
  get intervalHours() { return numberEnv('SOCIAL_AUTONOMOUS_INTERVAL_HOURS', 24); },
  get mode() {
    const mode = String(process.env.SOCIAL_AUTONOMOUS_MODE || 'publish').toLowerCase();
    return ['publish', 'draft'].includes(mode) ? mode : 'publish';
  },
  get channels() {
    const raw = String(process.env.SOCIAL_AUTONOMOUS_CHANNELS || 'gbp,facebook,instagram');
    const selected = raw.split(',').map((item) => item.trim().toLowerCase()).filter(Boolean);
    return normalizeChannels(selected);
  },
};

async function latestAutonomousRun() {
  if (!(await hasTable('social_content_studio_runs'))) return null;
  return db('social_content_studio_runs')
    .where({ run_type: 'autonomous' })
    .whereIn('status', ['published', 'draft_created', 'dry_run'])
    .orderBy('started_at', 'desc')
    .first();
}

async function insertAutonomousRun(row) {
  if (!(await hasTable('social_content_studio_runs'))) return null;
  const [inserted] = await db('social_content_studio_runs')
    .insert({
      run_type: 'autonomous',
      status: row.status || 'started',
      mode: row.mode || null,
      topic: row.topic || null,
      city: row.city || null,
      service: row.service || null,
      angle: row.angle || null,
      channels: JSON.stringify(row.channels || []),
      input: JSON.stringify(row.input || {}),
      preview: JSON.stringify(row.preview || {}),
      publish_result: JSON.stringify(row.publishResult || {}),
      skip_reason: row.skipReason || null,
      social_media_post_id: row.socialMediaPostId || null,
      started_at: row.startedAt || new Date(),
      finished_at: row.finishedAt || null,
      created_at: new Date(),
      updated_at: new Date(),
    })
    .returning('*');
  return inserted;
}

async function updateAutonomousRun(id, patch) {
  if (!id || !(await hasTable('social_content_studio_runs'))) return null;
  const updates = {
    status: patch.status,
    skip_reason: patch.skipReason || null,
    social_media_post_id: patch.socialMediaPostId || null,
    finished_at: new Date(),
    updated_at: new Date(),
  };
  if (patch.preview) updates.preview = JSON.stringify(patch.preview);
  if (patch.publishResult) updates.publish_result = JSON.stringify(patch.publishResult);
  const [updated] = await db('social_content_studio_runs')
    .where({ id })
    .update(updates)
    .returning('*');
  return updated;
}

async function logAutonomousSkip(skipReason, input = {}) {
  return insertAutonomousRun({
    status: 'skipped',
    mode: AUTONOMOUS_FLAGS.mode,
    input,
    channels: AUTONOMOUS_FLAGS.channels,
    skipReason,
    startedAt: new Date(),
    finishedAt: new Date(),
  });
}

function applySearch(query, columns, values) {
  const terms = values.map(cleanText).filter(Boolean).slice(0, 4);
  if (!terms.length) return query;
  return query.where(function searchTerms() {
    for (const term of terms) {
      this.orWhere(function searchColumns() {
        for (const column of columns) {
          this.orWhereRaw(`LOWER(${column}) LIKE LOWER(?)`, [`%${term}%`]);
        }
      });
    }
  });
}

function locationForCity(city) {
  const resolved = resolveLocation(city);
  const label = cleanText(city, 80) || resolved?.name || 'Southwest Florida';
  return {
    id: resolved?.id || 'lakewood-ranch',
    name: resolved?.name || label,
    city: label,
  };
}

async function getCampaignContext({ topic, city, service }) {
  const location = locationForCity(city);
  const context = {
    location,
    services: [],
    content: [],
    recentSocials: [],
    pestPressure: null,
    reviews: [],
    competitorPatterns: DEFAULT_COMPETITOR_PATTERNS,
    fastestRisers: FASTEST_RISER_PROFILES.slice(0, 8),
  };

  if (await hasTable('services')) {
    try {
      let query = db('services')
        .select('id', 'service_key', 'name', 'short_name', 'description', 'category', 'subcategory', 'customer_visible')
        .where(function activeServices() {
          this.where('is_active', true).orWhereNull('is_active');
        })
        .limit(8);
      query = applySearch(query, ['name', 'short_name', 'description', 'category', 'subcategory'], [topic, service]);
      context.services = await query;
    } catch {
      context.services = [];
    }
  }

  if (await hasTable('blog_posts')) {
    try {
      let query = db('blog_posts')
        .select('id', 'title', 'slug', 'city', 'tag', 'keyword', 'meta_description', 'status', 'publish_date', 'source')
        .orderBy('publish_date', 'desc')
        .limit(8);
      query = applySearch(query, ['title', 'keyword', 'tag', 'city', 'meta_description'], [topic, city, service]);
      context.content = await query;
    } catch {
      context.content = [];
    }
  }

  if (await hasTable('social_media_posts')) {
    try {
      let query = db('social_media_posts')
        .select('id', 'title', 'description', 'source_url', 'source_type', 'status', 'created_at')
        .orderBy('created_at', 'desc')
        .limit(8);
      query = applySearch(query, ['title', 'description', 'source_type'], [topic, city, service]);
      context.recentSocials = await query;
    } catch {
      context.recentSocials = [];
    }
  }

  if (await hasTable('pest_pressure_configs')) {
    try {
      const row = await db('pest_pressure_configs')
        .where({ scope: 'global' })
        .select('enabled', 'labels', 'customer_explanation_text', 'calculation_version')
        .first();
      if (row) {
        context.pestPressure = {
          enabled: row.enabled,
          labels: toJson(row.labels, []),
          explanation: row.customer_explanation_text,
          calculationVersion: row.calculation_version,
        };
      }
    } catch {
      context.pestPressure = null;
    }
  }

  if (await hasTable('google_reviews')) {
    try {
      context.reviews = await db('google_reviews')
        .where('reviewer_name', '!=', '_stats')
        .where('star_rating', 5)
        .whereNotNull('review_text')
        .where(function activeLocations() {
          this.where('location_id', location.id).orWhereNull('location_id');
        })
        .select('id', 'reviewer_name', 'location_id', 'star_rating', 'review_text', 'review_created_at')
        .orderBy('review_created_at', 'desc')
        .limit(4);
    } catch {
      context.reviews = [];
    }
  }

  return context;
}

function suggestedLink(context) {
  const page = context.content.find((item) => item.slug || item.source_url);
  if (!page) return '';
  if (page.source_url) return normalizeUrl(page.source_url) || page.source_url;
  const slug = cleanText(page.slug, 200).replace(/^\/+/, '');
  return slug ? `https://www.wavespestcontrol.com/${slug}/` : '';
}

function sourceDetailForCard(preview) {
  const preferred = (preview?.sources || []).find((source) =>
    ['service', 'content', 'pest_pressure'].includes(source.type) && source.detail
  );
  if (preferred?.detail) return preferred.detail;
  const gbp = cleanText(preview?.drafts?.gbp, 320);
  if (gbp) return gbp;
  return 'Local pest pressure changes quickly with heat, rain, and property conditions.';
}

function buildCampaignCardInput(input = {}, preview = {}) {
  const inputs = preview.inputs || {};
  return {
    variant: 'campaign',
    city: inputs.city || input.city,
    topic: inputs.topic || input.topic,
    service: inputs.service || input.service,
    detail: sourceDetailForCard(preview),
    cta: ctaText(inputs.cta || input.cta),
  };
}

function buildReviewCardInput(candidate = {}) {
  return {
    variant: 'review',
    city: candidate.city,
    reviewerDisplayName: candidate.reviewerDisplayName,
    excerpt: candidate.excerpt,
    service: 'Google review',
  };
}

async function uploadSocialCard(cardInput, filenameSeed) {
  if (typeof SocialMediaService.uploadImageToS3 !== 'function') return null;
  try {
    const base64 = await SocialCardRenderer.renderSocialCardJpegBase64(cardInput);
    const filename = `${SocialCardRenderer.filenameSlug(filenameSeed)}-${Date.now()}.jpg`;
    return await SocialMediaService.uploadImageToS3(base64, filename);
  } catch {
    return null;
  }
}

async function renderCampaignImageUrl(input, preview) {
  return uploadSocialCard(
    buildCampaignCardInput(input, preview),
    `${preview?.inputs?.city || input.city}-${preview?.inputs?.topic || input.topic}`
  );
}

async function renderReviewGraphicImageUrl(candidate) {
  return uploadSocialCard(
    buildReviewCardInput(candidate),
    `review-${candidate.city || 'waves'}-${candidate.googleReviewId || Date.now()}`
  );
}

function previewWithVisual(preview, { imageUrl, variant, templateKey }) {
  if (!imageUrl) return preview;
  return {
    ...preview,
    visual: {
      imageUrl,
      variant,
      templateKey: templateKey || (variant === 'review' ? 'waves_clean_square' : 'waves_campaign_square'),
    },
  };
}

function selectAutonomousCampaign(now = new Date()) {
  const month = now.getMonth() + 1;
  const day = now.getDate();
  const city = WAVES_LOCATIONS[day % WAVES_LOCATIONS.length]?.name || 'Sarasota';
  const seasonal = SEASONAL_AUTONOMOUS_TOPICS[month] || SEASONAL_AUTONOMOUS_TOPICS[6];
  const topic = seasonal[day % seasonal.length];
  return {
    ...topic,
    city,
    channels: AUTONOMOUS_FLAGS.channels,
  };
}

async function selectAutonomousReviewPlan(now = new Date()) {
  if (!AUTONOMOUS_FLAGS.includeReviews) return null;
  const day = now.getDate();
  if (day % 4 !== 0) return null;

  const { candidates } = await listReviewGraphicCandidates({ limit: 10 });
  const candidate = candidates[0];
  if (!candidate) return null;

  const city = candidate.city || 'SWFL';
  const topic = `5-star review from ${city}`;
  const excerpt = reviewExcerpt(candidate.excerpt, 180);
  const drafts = {
    facebook: `"${excerpt}"\n\nA real 5-star Google review from ${candidate.reviewerDisplayName}. Local service, clear communication, and follow-through matter.`,
    instagram: `"${excerpt}"\n\nThanks for trusting Waves, ${city}.\n\n#wavespestcontrol #swfl #pestcontrol #googlereview`,
    linkedin: `Customer trust compounds when service teams communicate clearly and follow through. Recent 5-star feedback from ${city}: "${excerpt}"`,
    gbp: `A ${city} customer left Waves a 5-star Google review: "${excerpt}" Thanks for trusting our local team.`,
  };
  return {
    topic,
    city,
    service: 'review proof',
    angle: 'review highlight',
    cta: 'book inspection',
    channels: AUTONOMOUS_FLAGS.channels,
    reviewGraphic: candidate,
    preview: {
      inputs: {
        topic,
        city,
        service: 'review proof',
        angle: 'review highlight',
        cta: 'book inspection',
        channels: AUTONOMOUS_FLAGS.channels,
      },
      suggestedLink: 'https://www.wavespestcontrol.com/reviews/',
      drafts: Object.fromEntries(AUTONOMOUS_FLAGS.channels.map((channel) => [channel, drafts[channel]]).filter(([, text]) => text)),
      validation: validateDrafts(drafts),
      sources: [{
        type: 'google_review',
        label: candidate.reviewerDisplayName,
        detail: excerpt,
      }],
      fastestRisers: FASTEST_RISER_PROFILES.slice(0, 8),
    },
  };
}

async function selectAutonomousPlan(now = new Date()) {
  const reviewPlan = await selectAutonomousReviewPlan(now);
  if (reviewPlan) return reviewPlan;

  const input = selectAutonomousCampaign(now);
  const preview = await previewCampaign(input);
  return {
    ...input,
    preview,
  };
}

function ctaText(cta) {
  const key = cleanText(cta, 80).toLowerCase();
  if (key.includes('guide')) return 'Read the local guide';
  if (key.includes('estimate')) return 'Request an estimate';
  if (key.includes('call')) return 'Use the call button to reach Waves';
  return 'Schedule an inspection';
}

function angleHook({ topic, city, angle }) {
  const topicLabel = cleanText(topic, 100) || 'pest pressure';
  const cityLabel = cleanText(city, 80) || 'SWFL';
  const key = cleanText(angle, 80).toLowerCase();
  if (key.includes('sign')) return `${cityLabel} homeowners: here is what to check before this becomes a bigger ${topicLabel} problem.`;
  if (key.includes('myth')) return `Myth check: ${topicLabel} in ${cityLabel} is not just a one-day nuisance.`;
  if (key.includes('new')) return `New to Florida? ${topicLabel} in ${cityLabel} catches a lot of homeowners off guard.`;
  if (key.includes('seeing')) return `Here is what we are watching around ${cityLabel}: ${topicLabel}.`;
  return `${titleCase(topicLabel)} is showing up around ${cityLabel}.`;
}

function hashtags({ topic, city, service }) {
  const tags = ['#wavespestcontrol'];
  const cityKey = cleanText(city).toLowerCase().replace(/[^a-z]/g, '');
  if (cityKey.includes('sarasota')) tags.push('#sarasotafl');
  else if (cityKey.includes('bradenton')) tags.push('#bradentonfl');
  else if (cityKey.includes('venice')) tags.push('#venicefl');
  else tags.push('#swfl');

  const text = `${topic} ${service}`.toLowerCase();
  if (text.includes('termite')) tags.push('#termites');
  else if (text.includes('chinch')) tags.push('#chinchbugs', '#staugustinegrass');
  else if (text.includes('mosquito')) tags.push('#mosquitocontrol');
  else if (text.includes('lawn')) tags.push('#lawncare');
  else tags.push('#pestcontrol');

  return tags.slice(0, 5).join(' ');
}

const SERVICE_INTENT_KEYWORDS = [
  { match: ['lawn', 'turf', 'grass', 'weed', 'fungus', 'fertil', 'chinch', 'st. augustine'] },
  { match: ['termite', 'swarm', 'swarming', 'wdo', 'wood destroying'] },
  { match: ['mosquito', 'standing water'] },
  { match: ['rodent', 'rat', 'rats', 'mouse', 'mice'] },
  { match: ['roach', 'cockroach'] },
  { match: ['ant', 'ants'] },
  { match: ['flea', 'fleas'] },
  { match: ['bed bug', 'bedbug'] },
];

function serviceIntentKeywords(input = {}) {
  const requested = `${input.service || ''} ${input.topic || ''}`.toLowerCase();
  const matches = SERVICE_INTENT_KEYWORDS
    .filter((group) => group.match.some((keyword) => requested.includes(keyword)))
    .flatMap((group) => group.match);
  return Array.from(new Set(matches));
}

function serviceRowMatchesIntent(row = {}, input = {}) {
  const keywords = serviceIntentKeywords(input);
  if (!keywords.length) return false;
  const text = [
    row.name,
    row.short_name,
    row.service_key,
    row.description,
    row.category,
    row.subcategory,
  ].map((value) => String(value || '').toLowerCase()).join(' ');
  return keywords.some((keyword) => text.includes(keyword));
}

function relevantServices(context = {}, input = {}) {
  const services = Array.isArray(context.services) ? context.services : [];
  const matches = services.filter((service) => serviceRowMatchesIntent(service, input));
  return matches.length ? matches : [];
}

function sourceFacts(context, input = {}) {
  const serviceFact = firstSentence(relevantServices(context, input)[0]?.description);
  const contentFact = firstSentence(context.content[0]?.meta_description || context.content[0]?.title);
  const pestPressureFact = firstSentence(context.pestPressure?.explanation);
  const reviewFact = firstSentence(context.reviews[0]?.review_text, 160);
  return [serviceFact, contentFact, pestPressureFact, reviewFact].filter(Boolean);
}

function buildCampaignDrafts(input, context) {
  const city = context.location.city || cleanText(input.city, 80) || 'SWFL';
  const topic = cleanText(input.topic, 120) || 'seasonal pest pressure';
  const matchedService = relevantServices(context, input)[0];
  const serviceLabel = matchedService?.short_name || matchedService?.name || titleCase(input.service || 'pest control');
  const hook = angleHook({ topic, city, angle: input.angle });
  const facts = sourceFacts(context, input);
  const fact = facts[0] || `${serviceLabel} problems usually build where food, water, shelter, or weather pressure line up.`;
  const secondFact = facts[1] || 'A quick inspection can separate normal seasonal activity from a problem that needs treatment.';
  const cta = ctaText(input.cta);

  const drafts = {
    facebook: `${hook}\n\n${fact} ${secondFact}\n\n${cta}.`,
    instagram: `${hook}\n\n${fact} ${secondFact}\n\nWhat are you seeing around the house this week?\n\n${hashtags({ topic, city, service: input.service })}`,
    linkedin: `${titleCase(serviceLabel)} demand is seasonal in ${city}. ${fact} Waves is turning local pest pressure, field notes, and service data into practical homeowner guidance.`,
    gbp: `${city} homeowners: ${topic} can move fast when weather and property conditions line up. ${fact} ${cta}.`,
  };

  const selected = normalizeChannels(input.channels);
  return Object.fromEntries(selected.map((channel) => [channel, drafts[channel]]));
}

function validateDrafts(drafts) {
  return Object.fromEntries(Object.entries(drafts).map(([platform, text]) => [platform, validateContent(text, platform)]));
}

function buildSourcePanel(context, input = {}) {
  const rows = [];
  for (const service of relevantServices(context, input).slice(0, 4)) {
    rows.push({
      type: 'service',
      label: service.name,
      detail: firstSentence(service.description, 180),
    });
  }
  for (const item of context.content.slice(0, 4)) {
    rows.push({
      type: 'content',
      label: item.title,
      detail: [item.city, item.tag, item.status].filter(Boolean).join(' | '),
    });
  }
  for (const post of context.recentSocials.slice(0, 3)) {
    rows.push({
      type: 'recent_social',
      label: post.title,
      detail: [post.source_type, post.status].filter(Boolean).join(' | '),
    });
  }
  if (context.pestPressure?.explanation) {
    rows.push({
      type: 'pest_pressure',
      label: 'Pest pressure definition',
      detail: firstSentence(context.pestPressure.explanation, 220),
    });
  }
  for (const pattern of context.competitorPatterns.slice(0, 3)) {
    rows.push({
      type: 'competitor_pattern',
      label: pattern.label,
      detail: pattern.copyablePattern,
    });
  }
  return rows;
}

async function previewCampaign(input) {
  const context = await getCampaignContext(input);
  const drafts = buildCampaignDrafts(input, context);
  return {
    inputs: {
      topic: cleanText(input.topic, 120),
      city: context.location.city,
      locationId: context.location.id,
      service: cleanText(input.service, 120),
      angle: cleanText(input.angle, 80),
      cta: cleanText(input.cta, 80),
      channels: normalizeChannels(input.channels),
    },
    suggestedLink: suggestedLink(context),
    drafts,
    validation: validateDrafts(drafts),
    sources: buildSourcePanel(context, input),
    fastestRisers: context.fastestRisers,
  };
}

async function saveCampaignDraft(input) {
  if (!(await hasTable('social_media_posts'))) {
    throw new Error('social_media_posts table is not available');
  }
  const preview = input.preview || await previewCampaign(input);
  const imageUrl = cleanText(input.imageUrl || preview.visual?.imageUrl, 1000) || await renderCampaignImageUrl(input, preview);
  const finalPreview = previewWithVisual(preview, {
    imageUrl,
    variant: 'campaign',
    templateKey: 'waves_campaign_square',
  });
  const title = cleanText(input.title || `${preview.inputs.city}: ${preview.inputs.topic}`, 180);
  const [post] = await db('social_media_posts')
    .insert({
      title,
      description: cleanText(input.description || preview.inputs.service || preview.inputs.topic, 1000),
      source_url: normalizeUrl(input.link || preview.suggestedLink) || null,
      source_guid: `campaign_builder_${Date.now()}`,
      source_type: 'campaign_builder',
      platforms_posted: JSON.stringify(preview.inputs.channels || Object.keys(preview.drafts || {})),
      image_url: imageUrl || null,
      status: 'draft',
      publish_status: 'pending',
      custom_content: JSON.stringify(finalPreview.drafts || {}),
      published_content: JSON.stringify(finalPreview.drafts || {}),
      ai_model: 'template:v1',
      created_at: new Date(),
    })
    .returning('*');
  return { post, preview: finalPreview };
}

async function autonomousStatus() {
  const latest = await latestAutonomousRun();
  return {
    enabled: AUTONOMOUS_FLAGS.enabled,
    globalAutomationEnabled: SOCIAL_FLAGS.automationEnabled,
    paused: await isPausedByAdmin(),
    dryRun: SOCIAL_FLAGS.dryRun,
    mode: AUTONOMOUS_FLAGS.mode,
    intervalHours: AUTONOMOUS_FLAGS.intervalHours,
    channels: AUTONOMOUS_FLAGS.channels,
    includeReviews: AUTONOMOUS_FLAGS.includeReviews,
    latestRun: latest,
  };
}

function platformResultsFrom(runResult, postPlatforms) {
  if (Array.isArray(runResult?.platforms)) return runResult.platforms;
  if (Array.isArray(runResult?.results)) return runResult.results;
  if (Array.isArray(postPlatforms) && postPlatforms.some((item) => item && typeof item === 'object')) {
    return postPlatforms;
  }
  return [];
}

function serializeAutonomousRun(row = {}) {
  const input = toJson(row.input, {});
  const preview = toJson(row.preview, {});
  const publishResult = toJson(row.publish_result || row.publishResult, {});
  const postPlatforms = toJson(row.post_platforms_posted, []);
  const platformResults = platformResultsFrom(publishResult, postPlatforms);
  const previewInputs = preview.inputs || {};
  const rowChannels = toJson(row.channels, []);
  const channels = Array.from(new Set(normalizeChannels([
    ...(Array.isArray(rowChannels) ? rowChannels : []),
    ...(Array.isArray(input.channels) ? input.channels : []),
    ...(Array.isArray(previewInputs.channels) ? previewInputs.channels : []),
    ...platformResults.map((item) => item?.platform),
  ])));
  const socialMediaPostId = row.social_media_post_id || row.post_id || null;
  const imageUrl = cleanText(
    preview.visual?.imageUrl ||
    publishResult.imageUrl ||
    publishResult.draftImageUrl ||
    row.post_image_url,
    1000
  ) || null;

  return {
    id: row.id || null,
    runType: row.run_type || 'autonomous',
    status: row.status || 'unknown',
    mode: row.mode || input.mode || null,
    topic: row.topic || input.topic || previewInputs.topic || null,
    city: row.city || input.city || previewInputs.city || null,
    service: row.service || input.service || previewInputs.service || null,
    angle: row.angle || input.angle || previewInputs.angle || null,
    channels,
    input,
    preview,
    publishResult,
    platformResults,
    imageUrl,
    skipReason: row.skip_reason || null,
    socialMediaPostId,
    startedAt: row.started_at || null,
    finishedAt: row.finished_at || null,
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null,
    post: socialMediaPostId ? {
      id: socialMediaPostId,
      title: row.post_title || null,
      status: row.post_status || null,
      publishStatus: row.post_publish_status || null,
      sourceUrl: row.post_source_url || null,
      imageUrl: row.post_image_url || null,
      createdAt: row.post_created_at || null,
    } : null,
  };
}

async function listAutonomousRuns({ limit = 30 } = {}) {
  if (!(await hasTable('social_content_studio_runs'))) return { runs: [] };
  const safeLimit = Math.max(1, Math.min(100, Number(limit) || 30));
  const rows = await db('social_content_studio_runs as r')
    .leftJoin('social_media_posts as p', 'p.id', 'r.social_media_post_id')
    .where('r.run_type', 'autonomous')
    .select(
      'r.*',
      'p.id as post_id',
      'p.title as post_title',
      'p.status as post_status',
      'p.publish_status as post_publish_status',
      'p.source_url as post_source_url',
      'p.image_url as post_image_url',
      'p.platforms_posted as post_platforms_posted',
      'p.created_at as post_created_at'
    )
    .orderBy('r.started_at', 'desc')
    .limit(safeLimit);

  return {
    runs: rows.map((row) => serializeAutonomousRun(row)),
  };
}

function hasValidationFailure(preview) {
  return Object.entries(preview?.validation || {})
    .filter(([platform]) => (preview?.inputs?.channels || CHANNELS).includes(platform))
    .flatMap(([, result]) => result?.issues || [])
    .filter(Boolean);
}

async function runAutonomous({ force = false, mode } = {}) {
  const startedAt = new Date();
  const effectiveMode = mode || AUTONOMOUS_FLAGS.mode;

  if (!force && !AUTONOMOUS_FLAGS.enabled) {
    await logAutonomousSkip('SOCIAL_AUTONOMOUS_STUDIO_ENABLED is not true');
    return { skipped: true, reason: 'SOCIAL_AUTONOMOUS_STUDIO_ENABLED is not true' };
  }
  if (!SOCIAL_FLAGS.automationEnabled) {
    await logAutonomousSkip('SOCIAL_AUTOMATION_ENABLED is not true');
    return { skipped: true, reason: 'SOCIAL_AUTOMATION_ENABLED is not true' };
  }
  if (await isPausedByAdmin()) {
    await logAutonomousSkip('social automation is paused by admin');
    return { skipped: true, reason: 'social automation is paused by admin' };
  }

  if (!force) {
    const latest = await latestAutonomousRun();
    if (latest?.started_at) {
      const elapsedHours = (startedAt.getTime() - new Date(latest.started_at).getTime()) / 36e5;
      if (elapsedHours < AUTONOMOUS_FLAGS.intervalHours) {
        const reason = `cadence guard: ${elapsedHours.toFixed(1)}h since last autonomous run`;
        return { skipped: true, reason, latestRun: latest };
      }
    }
  }

  const plan = await selectAutonomousPlan(startedAt);
  const run = await insertAutonomousRun({
    status: 'started',
    mode: effectiveMode,
    topic: plan.topic,
    city: plan.city,
    service: plan.service,
    angle: plan.angle,
    channels: plan.channels,
    input: plan,
    startedAt,
  });

  try {
    const preview = plan.preview || await previewCampaign(plan);
    const validationIssues = hasValidationFailure(preview);
    if (validationIssues.length) {
      const reason = `validation failed: ${validationIssues[0]}`;
      await updateAutonomousRun(run?.id, {
        status: 'failed',
        preview,
        skipReason: reason,
      });
      return { success: false, skipped: true, reason, preview };
    }

    let imageUrl = null;
    let finalPreview = preview;

    if (plan.reviewGraphic?.googleReviewId && await hasTable('review_graphics')) {
      const graphic = await createReviewGraphic({
        googleReviewId: plan.reviewGraphic.googleReviewId,
        privacyMode: plan.reviewGraphic.privacyMode || 'first_name_city',
        templateKey: 'waves_clean_square',
        channels: plan.channels,
        status: 'approved',
      }).catch(() => null);
      imageUrl = graphic?.image_url || await renderReviewGraphicImageUrl(plan.reviewGraphic);
      finalPreview = previewWithVisual(preview, {
        imageUrl,
        variant: 'review',
        templateKey: 'waves_clean_square',
      });
    } else {
      imageUrl = await renderCampaignImageUrl(plan, preview);
      finalPreview = previewWithVisual(preview, {
        imageUrl,
        variant: 'campaign',
        templateKey: 'waves_campaign_square',
      });
    }

    if (effectiveMode === 'draft') {
      const saved = await saveCampaignDraft({
        ...plan,
        link: finalPreview.suggestedLink,
        preview: finalPreview,
        imageUrl,
        title: plan.topic,
        description: plan.service,
      });
      const updated = await updateAutonomousRun(run?.id, {
        status: 'draft_created',
        preview: finalPreview,
        publishResult: { draftId: saved.post?.id, imageUrl },
        socialMediaPostId: saved.post?.id,
      });
      return { success: true, mode: effectiveMode, post: saved.post, run: updated, preview: finalPreview };
    }

    const guid = `${AUTONOMOUS_SOURCE}_${startedAt.toISOString()}`;
    const publishResult = await SocialMediaService.publishToAll({
      title: plan.topic,
      description: plan.service,
      link: finalPreview.suggestedLink,
      guid,
      source: AUTONOMOUS_SOURCE,
      customContent: finalPreview.drafts,
      channels: plan.channels,
      imageUrl,
      gbpLocationIds: finalPreview.inputs?.locationId ? [finalPreview.inputs.locationId] : [locationForCity(plan.city).id],
    });

    const post = await db('social_media_posts')
      .where({ source_guid: guid })
      .orderBy('created_at', 'desc')
      .first()
      .catch(() => null);

    const status = SOCIAL_FLAGS.dryRun ? 'dry_run' : publishResult.success ? 'published' : 'failed';
    const updated = await updateAutonomousRun(run?.id, {
      status,
      preview: finalPreview,
      publishResult,
      socialMediaPostId: post?.id,
      skipReason: publishResult.success ? null : 'all platforms skipped or failed',
    });

    return {
      success: publishResult.success,
      dryRun: SOCIAL_FLAGS.dryRun,
      mode: effectiveMode,
      post,
      run: updated,
      preview: finalPreview,
      publishResult,
    };
  } catch (err) {
    await updateAutonomousRun(run?.id, {
      status: 'failed',
      skipReason: err.message,
    });
    throw err;
  }
}

function cityFromLocationId(locationId) {
  return WAVES_LOCATIONS.find((loc) => loc.id === locationId)?.name || 'SWFL';
}

function initials(name) {
  const parts = cleanText(name, 80).split(/\s+/).filter(Boolean);
  if (!parts.length) return 'W';
  return parts.slice(0, 2).map((part) => part[0]?.toUpperCase()).filter(Boolean).join('.');
}

function privacyDisplayName(reviewerName, city, privacyMode = 'first_name_city') {
  const cleanName = cleanText(reviewerName, 100);
  const firstName = cleanName.split(/\s+/).filter(Boolean)[0];
  if (privacyMode === 'anonymous') return `Waves customer in ${city}`;
  if (privacyMode === 'initials') return `${initials(cleanName)}., ${city}`;
  return `${firstName || 'Waves customer'}, ${city}`;
}

function reviewExcerpt(text, max = 180) {
  const clean = cleanText(text, max * 2);
  if (clean.length <= max) return clean;
  const slice = clean.slice(0, max - 3);
  const boundary = slice.lastIndexOf(' ');
  return `${slice.slice(0, boundary > 80 ? boundary : slice.length).trim()}...`;
}

function buildReviewGraphicCandidate(review, { privacyMode = 'first_name_city', templateKey = 'waves_clean_square', channels } = {}) {
  const locationId = review.location_id || review.locationId || null;
  const city = cityFromLocationId(locationId);
  const displayName = privacyDisplayName(review.reviewer_name || review.reviewerName, city, privacyMode);
  const excerpt = reviewExcerpt(review.review_text || review.reviewText || '');
  return {
    googleReviewId: review.id,
    locationId,
    city,
    starRating: review.star_rating || review.starRating || 5,
    reviewerDisplayName: displayName,
    privacyMode,
    reviewerPhotoAllowed: false,
    excerpt,
    caption: `A 5-star Google review from ${displayName}.`,
    templateKey,
    channels: normalizeChannels(channels || ['gbp', 'facebook', 'instagram']),
    reviewCreatedAt: review.review_created_at || review.reviewCreatedAt || null,
  };
}

async function listReviewGraphicCandidates({ limit = 30 } = {}) {
  if (!(await hasTable('google_reviews'))) return { candidates: [], saved: [] };
  const hasGraphics = await hasTable('review_graphics');
  const safeLimit = Math.max(1, Math.min(100, Number(limit) || 30));

  let rows = [];
  try {
    let query = db('google_reviews as gr')
      .where('gr.reviewer_name', '!=', '_stats')
      .where('gr.star_rating', 5)
      .whereNotNull('gr.review_text')
      .whereRaw("TRIM(gr.review_text) <> ''")
      .select('gr.id', 'gr.location_id', 'gr.reviewer_name', 'gr.star_rating', 'gr.review_text', 'gr.review_created_at')
      .orderBy('gr.review_created_at', 'desc')
      .limit(safeLimit);
    if (hasGraphics) {
      query = query.leftJoin('review_graphics as rg', 'rg.google_review_id', 'gr.id').whereNull('rg.id');
    }
    rows = await query;
  } catch {
    rows = [];
  }

  let saved = [];
  if (hasGraphics) {
    try {
      saved = await db('review_graphics')
        .select('*')
        .orderBy('created_at', 'desc')
        .limit(50);
    } catch {
      saved = [];
    }
  }

  return {
    candidates: rows.map((row) => buildReviewGraphicCandidate(row)),
    saved,
  };
}

async function createReviewGraphic(input) {
  if (!(await hasTable('review_graphics'))) throw new Error('review_graphics table is not available');
  const review = await db('google_reviews').where({ id: input.googleReviewId }).first();
  if (!review) throw new Error('Google review not found');
  const candidate = buildReviewGraphicCandidate(review, input);
  const imageUrl = cleanText(input.imageUrl, 1000) || await renderReviewGraphicImageUrl(candidate);
  const row = {
    google_review_id: candidate.googleReviewId,
    status: input.status || 'draft',
    privacy_mode: candidate.privacyMode,
    reviewer_display_name: candidate.reviewerDisplayName,
    location_id: candidate.locationId,
    city: candidate.city,
    excerpt: cleanText(input.excerpt || candidate.excerpt, 500),
    caption: cleanText(input.caption || candidate.caption, 1000),
    template_key: candidate.templateKey,
    channels: JSON.stringify(candidate.channels),
    render_settings: JSON.stringify({
      ...(input.renderSettings || {}),
      imageTemplate: 'svg:review:v1',
      imageUrl: imageUrl || null,
    }),
    updated_at: new Date(),
  };
  if (await hasColumn('review_graphics', 'image_url')) row.image_url = imageUrl || null;

  const [graphic] = await db('review_graphics')
    .insert({ ...row, created_at: new Date() })
    .onConflict(['google_review_id', 'template_key'])
    .merge(row)
    .returning('*');
  return { ...graphic, image_url: graphic.image_url || imageUrl || null };
}

async function ensureFastestRisersSeeded() {
  if (!(await hasTable('competitor_social_profiles'))) return;
  for (const profile of FASTEST_RISER_PROFILES) {
    await db('competitor_social_profiles')
      .insert({
        company_name: profile.companyName,
        pct_rank: profile.pctRank,
        revenue_rank: profile.revenueRank,
        growth_pct: profile.growthPct,
        city: profile.city,
        state: profile.state,
        source_label: 'PCT 2026 Top 100 poster',
        profile_urls: JSON.stringify(profile.profileUrls || {}),
        strategic_notes: JSON.stringify(profile.strategicNotes || []),
        active: true,
        created_at: new Date(),
        updated_at: new Date(),
      })
      .onConflict('company_name')
      .merge({
        pct_rank: profile.pctRank,
        revenue_rank: profile.revenueRank,
        growth_pct: profile.growthPct,
        city: profile.city,
        state: profile.state,
        source_label: 'PCT 2026 Top 100 poster',
        strategic_notes: JSON.stringify(profile.strategicNotes || []),
        active: true,
        updated_at: new Date(),
      });
  }
}

async function listCompetitorSwipeFile() {
  const hasProfiles = await hasTable('competitor_social_profiles');
  const hasPosts = await hasTable('competitor_social_posts');
  if (hasProfiles) await ensureFastestRisersSeeded();

  let profiles = FASTEST_RISER_PROFILES;
  if (hasProfiles) {
    profiles = await db('competitor_social_profiles')
      .where({ active: true })
      .select('*')
      .orderBy('growth_pct', 'desc')
      .limit(50);
  }

  let posts = [];
  if (hasPosts) {
    posts = await db('competitor_social_posts')
      .select('*')
      .orderBy('engagement_score', 'desc')
      .orderBy('created_at', 'desc')
      .limit(100);
  }

  return {
    profiles,
    posts,
    patterns: DEFAULT_COMPETITOR_PATTERNS,
    sourceNote: 'Growth figures come from the local 2026 PCT Top 100 poster PDF supplied by Waves.',
  };
}

function engagementScore({ likesCount = 0, commentsCount = 0, sharesCount = 0, viewsCount = 0 }) {
  return Math.round(
    (Number(likesCount) || 0)
    + ((Number(commentsCount) || 0) * 3)
    + ((Number(sharesCount) || 0) * 5)
    + ((Number(viewsCount) || 0) / 100)
  );
}

async function createCompetitorPost(input) {
  if (!(await hasTable('competitor_social_posts'))) throw new Error('competitor_social_posts table is not available');
  const companyName = cleanText(input.companyName, 180);
  const platform = cleanText(input.platform, 30).toLowerCase();
  if (!companyName) throw new Error('companyName is required');
  if (!platform) throw new Error('platform is required');

  let profile = null;
  if (await hasTable('competitor_social_profiles')) {
    await ensureFastestRisersSeeded();
    profile = await db('competitor_social_profiles').where({ company_name: companyName }).first();
  }

  const counts = {
    likesCount: Number(input.likesCount) || 0,
    commentsCount: Number(input.commentsCount) || 0,
    sharesCount: Number(input.sharesCount) || 0,
    viewsCount: Number(input.viewsCount) || 0,
  };

  const [post] = await db('competitor_social_posts')
    .insert({
      profile_id: profile?.id || null,
      company_name: companyName,
      platform,
      profile_url: cleanText(input.profileUrl, 1000) || null,
      post_url: cleanText(input.postUrl, 1000) || null,
      post_date: input.postDate || null,
      topic: cleanText(input.topic, 180) || null,
      hook_type: cleanText(input.hookType, 80) || null,
      creative_format: cleanText(input.creativeFormat, 80) || null,
      likes_count: counts.likesCount,
      comments_count: counts.commentsCount,
      shares_count: counts.sharesCount,
      views_count: counts.viewsCount,
      engagement_score: engagementScore(counts),
      visible_text: cleanText(input.visibleText, 2000) || null,
      why_it_worked: cleanText(input.whyItWorked, 2000) || null,
      copyable_pattern: cleanText(input.copyablePattern, 2000) || null,
      source: cleanText(input.source, 40) || 'manual',
      created_at: new Date(),
      updated_at: new Date(),
    })
    .returning('*');
  return post;
}

module.exports = {
  AUTONOMOUS_FLAGS,
  AUTONOMOUS_SOURCE,
  CHANNELS,
  DEFAULT_COMPETITOR_PATTERNS,
  FASTEST_RISER_PROFILES,
  SEASONAL_AUTONOMOUS_TOPICS,
  autonomousStatus,
  buildCampaignCardInput,
  buildCampaignDrafts,
  buildReviewCardInput,
  buildReviewGraphicCandidate,
  createCompetitorPost,
  createReviewGraphic,
  engagementScore,
  getCampaignContext,
  listCompetitorSwipeFile,
  listAutonomousRuns,
  listReviewGraphicCandidates,
  previewCampaign,
  privacyDisplayName,
  reviewExcerpt,
  runAutonomous,
  saveCampaignDraft,
  serializeAutonomousRun,
  selectAutonomousCampaign,
  validateDrafts,
};
