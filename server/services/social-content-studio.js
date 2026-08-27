const db = require('../models/db');
const { WAVES_LOCATIONS, CITY_TO_LOCATION, resolveLocation } = require('../config/locations');
const SocialMediaService = require('./social-media');
const {
  SOCIAL_FLAGS,
  isPausedByAdmin,
  validateContent,
  normalizeUrl,
} = require('./social-media');
const SocialCardRenderer = require('./social-card-renderer');
const CreativeEngine = require('./social-creative-engine');
const { runExclusive } = require('../utils/cron-lock');
const logger = require('./logger');
const { etParts } = require('../utils/datetime-et');

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

// "X vs Y" pest ID comparisons — the highest-repeat format across pest-industry
// social template catalogs (side-by-side ID posts). Facts here are standard
// entomology/turf diagnostics only: sizes, colors, nesting habits, visible
// evidence. No safety, timing, or pricing language (the compliance regexes in
// social-media.js reject those), and nothing framed as a field observation.
const PEST_VERSUS_PAIRS = [
  {
    key: 'carpenter_ant_vs_ghost_ant',
    service: 'general pest',
    left: { name: 'Carpenter Ant', points: ['Large: 1/4 to 1/2 inch', 'Nests in damp or damaged wood', 'Can hollow out wood over time'] },
    right: { name: 'Ghost Ant', points: ['Tiny, with pale legs', 'Dark head, see-through body', 'Trails to kitchens and baths'] },
    verdict: 'One can weaken wood. One is a kitchen nuisance.',
  },
  {
    key: 'subterranean_vs_drywood_termite',
    service: 'termite',
    left: { name: 'Subterranean Termite', points: ['Colonies live in the soil', 'Builds mud tubes up foundations', 'Needs ground moisture'] },
    right: { name: 'Drywood Termite', points: ['Lives inside dry wood', 'No mud tubes', 'Pushes out tiny pellet piles'] },
    verdict: 'Both eat wood. The clues they leave are different.',
  },
  {
    key: 'termite_swarmer_vs_winged_ant',
    service: 'termite',
    left: { name: 'Termite Swarmer', points: ['Straight antennae', 'Both wing pairs equal length', 'Thick, straight waist'] },
    right: { name: 'Winged Ant', points: ['Bent antennae', 'Front wings longer than back', 'Pinched waist'] },
    verdict: 'Wings on the windowsill? Check the waist first.',
  },
  {
    key: 'paper_wasp_vs_mud_dauber',
    service: 'general pest',
    left: { name: 'Paper Wasp', points: ['Open umbrella-shaped nest', 'Lives in small colonies', 'Nests under eaves and rails'] },
    right: { name: 'Mud Dauber', points: ['Builds mud tube nests', 'Solitary and docile', 'Hunts spiders'] },
    verdict: 'The nest shape tells you who built it.',
  },
  {
    // Customer-facing diagnostics stay cautious and UF/IFAS-consistent: chinch
    // bugs are confirmed by finding them (flotation test at the patch edge),
    // never by turf lifting out (that signals root loss — a different
    // problem); drought is a coverage/soil-moisture check, not a lawn-wide
    // pattern (uneven sprinklers show as localized dry spots per the lawn
    // report guidance). Neither side is presented as conclusive.
    key: 'chinch_bug_vs_drought_stress',
    service: 'lawn care',
    left: { name: 'Chinch Bug Damage', points: ['Starts along hot, sunny edges', 'Patches keep spreading outward', 'Float test at the edge finds the bugs'] },
    right: { name: 'Drought Stress', points: ['Dry spots where sprinklers miss', 'Blades fold; footprints linger', 'Soil is dry at the patch edge'] },
    verdict: 'Browning turf? Check sprinkler coverage first, then float-test the edge.',
  },
  {
    key: 'roof_rat_vs_norway_rat',
    service: 'rodent',
    left: { name: 'Roof Rat', points: ['Sleek body, extra-long tail', 'Climber: attics and trees', 'The common rat in SWFL'] },
    right: { name: 'Norway Rat', points: ['Heavier build, shorter tail', 'Burrows at ground level', 'Less common in Florida'] },
    verdict: 'In Southwest Florida, think up, not down.',
  },
];

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

// Competitor URLs are persisted then rendered as <a href> in the admin UI, and
// this router only requires tech/admin — so a lower-privileged actor could
// otherwise store a javascript:/data: URL another admin clicks. Accept only
// http(s) absolute URLs at the storage boundary; everything else becomes null.
function httpUrlOrNull(value, max = 1000) {
  const cleaned = cleanText(value, max);
  if (!cleaned) return null;
  try {
    const parsed = new URL(cleaned);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? cleaned : null;
  } catch {
    return null;
  }
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
  // Only omitted (null/undefined) defaults to all channels. An explicit value
  // fails closed: a non-array, or an empty/all-invalid/whitespace list, yields
  // NO channels — so a typo or a blank SOCIAL_AUTONOMOUS_CHANNELS can't blast
  // every platform. Mirrors normalizePublishChannels in social-media.js.
  if (channels == null) return [...CHANNELS];
  if (!Array.isArray(channels)) return [];
  return channels
    .map((p) => String(p || '').trim().toLowerCase())
    .filter((p) => CHANNELS.includes(p));
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

// Resolve an autonomous publish mode. Unset/blank → fallbackWhenUnset (the
// documented default). A set-but-invalid value fails CLOSED to 'draft' so a
// typo never silently routes into live publishing.
function normalizePublishMode(value, fallbackWhenUnset = 'publish') {
  if (value == null || String(value).trim() === '') return fallbackWhenUnset;
  const mode = String(value).trim().toLowerCase();
  return mode === 'publish' || mode === 'draft' ? mode : 'draft';
}

const AUTONOMOUS_FLAGS = {
  get enabled() { return boolEnv('SOCIAL_AUTONOMOUS_STUDIO_ENABLED', false); },
  // Distinct opt-in for the HOURLY scheduler. `enabled` turns the Studio on for
  // manual admin use (and gates writes via requireStudioEnabled); `cronEnabled`
  // is the SEPARATE consent to also run automatic publishing on a schedule.
  // Both must be true for the cron to fire, so enabling the Studio for manual
  // use never silently starts autonomous posting.
  get cronEnabled() { return boolEnv('SOCIAL_AUTONOMOUS_CRON_ENABLED', false); },
  get includeReviews() { return boolEnv('SOCIAL_AUTONOMOUS_INCLUDE_REVIEWS', true); },
  // Dark-ship: the "pest showdown" X-vs-Y ID lane is OFF until explicitly
  // enabled (kill switch = unset SOCIAL_AUTONOMOUS_INCLUDE_VERSUS).
  get includeVersus() { return boolEnv('SOCIAL_AUTONOMOUS_INCLUDE_VERSUS', false); },
  // Dark-ship: review-count milestone celebrations ("300 Google reviews") are
  // OFF until explicitly enabled (kill switch = unset).
  get includeMilestones() { return boolEnv('SOCIAL_AUTONOMOUS_INCLUDE_MILESTONES', false); },
  // CLAMPED below the minimum gap between two daily 6:30 AM ET ticks. This is a
  // same-day DEDUPE guard, NOT the schedule (the fixed once-daily cron is). Two
  // consecutive ET ticks are normally 24h apart but only 23h across the
  // spring-forward DST transition, so cap at 22 — a higher value (e.g. a stale
  // 24 copied from old config) could see <interval elapsed on the DST day and
  // skip the only daily fire. Default 20. To change frequency, change the cron.
  get intervalHours() { return Math.min(numberEnv('SOCIAL_AUTONOMOUS_INTERVAL_HOURS', 20), 22); },
  get mode() {
    return normalizePublishMode(process.env.SOCIAL_AUTONOMOUS_MODE, 'publish');
  },
  get channels() {
    // Only an UNSET env var defaults; a blank/whitespace value passes through so
    // it normalizes to [] (fail closed). Blanking SOCIAL_AUTONOMOUS_CHANNELS to
    // stop output must actually stop it, not fall back to every platform.
    const raw = process.env.SOCIAL_AUTONOMOUS_CHANNELS == null
      ? 'gbp,facebook,instagram'
      : String(process.env.SOCIAL_AUTONOMOUS_CHANNELS);
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

// Cadence/claim guard source: the most recent ATTEMPT, not just a successful
// run. Includes 'started' (in-flight: a run inserts its claim before publishing,
// so a crash after Meta/GBP accepts but before the run is marked complete still
// blocks the next tick from a duplicate with a fresh source_guid) AND 'failed'
// (a total publish failure still counts as an attempt — otherwise the hourly
// cron would ignore SOCIAL_AUTONOMOUS_INTERVAL_HOURS during a persistent outage
// and re-render/re-upload cards and hammer Meta/GBP every hour). Excludes
// 'skipped' (no attempt was made — a cadence/kill-switch/pause skip must not
// reset the clock). The advisory lock covers genuinely-concurrent runs; this
// covers crashed/failed runs whose lock was already released.
async function latestAutonomousClaim() {
  if (!(await hasTable('social_content_studio_runs'))) return null;
  return db('social_content_studio_runs')
    .where({ run_type: 'autonomous' })
    .whereIn('status', ['published', 'draft_created', 'dry_run', 'started', 'failed'])
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

// ── City grounding ──────────────────────────────────────────────────────────
// Campaign copy targets ONE city, but the fact sources (blog posts matched by
// an OR topic search, review text, service descriptions) can carry a different
// city's name — live example 07-03: a Venice-targeted Facebook post opened
// "around Venice" then said "Your Sarasota lawn" because a Sarasota blog post
// won the content search. Facts naming a different service-area city are
// dropped, and an AI draft naming one falls back to the (city-clean) template.
// The comparison is strict per city name, not per office: "around Venice …
// your Punta Gorda lawn" reads just as wrong to the reader even though both
// route to the Venice office.
// "palmetto bugs" / "saw palmetto" / "laurel oaks" are Florida vernacular, not
// the cities Palmetto / Laurel — scrub them before scanning.
const KNOWN_CITY_NAMES = Object.keys(CITY_TO_LOCATION);
// Longest name first, and each match is consumed from the haystack, so nested
// names can't double-read: "Bradenton Beach homeowners" is one mention of
// bradenton beach, NOT also a (foreign) mention of bradenton.
const KNOWN_CITIES_BY_LENGTH = [...KNOWN_CITY_NAMES].sort((a, b) => b.length - a.length);
const CITY_FALSE_POSITIVES = /\b(?:saw\s+palmetto|palmetto\s+bugs?|laurel\s+oaks?)\b/gi;

// A city shows up in prose ("Sarasota") or in the hashtag forms the Instagram
// prompt itself suggests ("#sarasotafl", "#lakewoodranch") — scan all of them.
function cityForms(name) {
  const compact = name.replace(/ /g, '');
  return Array.from(new Set([name, compact, `${compact}fl`]));
}

function citiesMentioned(text) {
  let haystack = ` ${String(text || '').toLowerCase().replace(CITY_FALSE_POSITIVES, ' ').replace(/[^a-z]+/g, ' ').trim()} `;
  const found = [];
  for (const name of KNOWN_CITIES_BY_LENGTH) {
    let hit = false;
    for (const form of cityForms(name)) {
      const needle = ` ${form} `;
      if (haystack.includes(needle)) {
        hit = true;
        haystack = haystack.split(needle).join('  ');
      }
    }
    if (hit) found.push(name);
  }
  return found;
}

function mentionsOtherCity(text, targetCity) {
  const target = String(targetCity || '').toLowerCase().trim();
  return citiesMentioned(text).some((name) => name !== target);
}

// Blog rows about a different city are excluded up front: content[0] feeds a
// draft fact AND suggestedLink, so a cross-city row means wrong-city copy plus
// a wrong-city link. A row is cross-city when its city tag names a different
// known city, OR — for untagged/region-tagged rows ("SWFL") — when its
// title/meta/keyword/slug text names one; the fact scrub alone can't fix
// suggestedLink, which reads the row, not the fact.
function contentRowMatchesCity(row, targetCity) {
  const target = String(targetCity || '').toLowerCase().trim();
  if (!target) return true;
  const rowCity = String(row?.city || '').toLowerCase().trim();
  if (rowCity && rowCity !== target && KNOWN_CITY_NAMES.includes(rowCity)) return false;
  const rowText = [row?.title, row?.meta_description, row?.keyword, row?.slug].filter(Boolean).join(' ');
  return !mentionsOtherCity(rowText, target);
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
        // Campaign facts/CTAs are public-facing, so never seed copy from a
        // service the customer site hides (internal-only or retired offerings).
        .where(function visibleServices() {
          this.where('customer_visible', true).orWhereNull('customer_visible');
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
        // suggestedLink turns context.content[0] into a public social CTA, so
        // only live posts may feed copy/links — never queued/draft/idea rows
        // (unapproved facts, 404 slugs).
        .where('status', 'published')
        .orderBy('publish_date', 'desc')
        // Rank relevance BEFORE capping: take a wider recency window so a
        // topic/service-relevant post that isn't in the 8 newest still wins,
        // then slice to 8 after the sort below.
        .limit(40);
      query = applySearch(query, ['title', 'keyword', 'tag', 'city', 'meta_description'], [topic, city, service]);
      const rows = await query;
      // The OR search also matches city-only posts; context.content[0] feeds
      // both a draft fact and the suggested link, so rank topic/service-
      // relevant posts ahead of city-only ones (stable sort keeps recency
      // within each tier) to avoid cross-service copy/links.
      const intentKeywords = serviceIntentKeywords({ topic, service });
      const matchesIntent = (row) => {
        if (!intentKeywords.length) return false;
        const text = [row.title, row.keyword, row.tag, row.meta_description]
          .map((v) => String(v || '').toLowerCase()).join(' ');
        return intentKeywords.some((kw) => text.includes(kw));
      };
      context.content = rows
        .filter((row) => contentRowMatchesCity(row, location.city))
        .map((row, index) => ({ row, index, relevant: matchesIntent(row) }))
        .sort((a, b) => (b.relevant - a.relevant) || (a.index - b.index))
        .map((entry) => entry.row)
        .slice(0, 8);
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
        // Never quote a review Google has removed in marketing content.
        .whereNull('missing_since')
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

function buildMilestoneCardInput(plan = {}) {
  return {
    variant: 'milestone',
    // Company-wide count — no city stamp (plan.city only routes the GBP location).
    city: null,
    service: 'Google reviews',
    count: plan.milestone,
    averageRating: plan.averageRating,
    thanks: 'Thank you, Southwest Florida.',
  };
}

function buildVersusCardInput(pair = {}, input = {}) {
  return {
    variant: 'versus',
    city: input.city,
    service: titleCase(input.service || pair.service || 'Pest ID'),
    left: pair.left,
    right: pair.right,
    verdict: pair.verdict,
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

async function uploadSocialCard(cardInput, filenameSeed, platform) {
  if (typeof SocialMediaService.uploadImageToS3 !== 'function') return null;
  try {
    const base64 = await SocialCardRenderer.renderSocialCardJpegBase64(cardInput, { platform });
    const suffix = platform && platform !== 'square' ? `-${platform}` : '';
    const filename = `${SocialCardRenderer.filenameSlug(filenameSeed)}${suffix}-${Date.now()}.jpg`;
    return await SocialMediaService.uploadImageToS3(base64, filename);
  } catch {
    return null;
  }
}

// platform: 'square' (default, Instagram/Facebook 1:1) or 'gbp' (4:3) — GBP can
// center-crop a square, clipping the logo/CTA, so it gets its own 4:3 render.
async function renderCampaignImageUrl(input, preview, platform) {
  return uploadSocialCard(
    buildCampaignCardInput(input, preview),
    `${preview?.inputs?.city || input.city}-${preview?.inputs?.topic || input.topic}`,
    platform
  );
}

async function renderMilestoneImageUrl(plan, platform) {
  return uploadSocialCard(buildMilestoneCardInput(plan), `milestone-${plan.milestone}-reviews`, platform);
}

async function renderVersusImageUrl(pair, input, platform) {
  return uploadSocialCard(
    buildVersusCardInput(pair, input),
    `versus-${pair.key || 'pest-id'}-${input.city || 'swfl'}`,
    platform
  );
}

async function renderReviewGraphicImageUrl(candidate, platform) {
  return uploadSocialCard(
    buildReviewCardInput(candidate),
    `review-${candidate.city || 'waves'}-${candidate.googleReviewId || Date.now()}`,
    platform
  );
}

function previewWithVisual(preview, { imageUrl, gbpImageUrl, variant, templateKey, creative, variants, videoUrl }) {
  if (!imageUrl) return preview;
  return {
    ...preview,
    visual: {
      imageUrl,
      variant,
      templateKey: templateKey || (variant === 'review' ? 'waves_clean_square' : 'waves_campaign_square'),
      // Creative-engine metadata: which scene concept made this image (feeds the
      // no-repeat rotation) and, on draft runs, the alternate variants the admin
      // can pick from in the approval queue. videoUrl records an approved Reel
      // (the primary imageUrl stays a still for thumbnails).
      // gbpImageUrl is the DETERMINISTIC GBP card for this run — persisted so
      // an approved draft's GBP post keeps its compliant image (publishToAll
      // never falls back to the shared image for GBP; no AI imagery on GBP).
      ...(gbpImageUrl ? { gbpImageUrl } : {}),
      ...(creative ? { creative } : {}),
      ...(Array.isArray(variants) && variants.length ? { variants } : {}),
      ...(videoUrl ? { videoUrl } : {}),
    },
  };
}

// Concept keys of recently PUBLISHED/chosen creative visuals — the engine skips
// these so back-to-back posts don't reuse a scene. Only the chosen concept
// counts (not every draft variant): the banks are ~5 deep per service, and
// excluding whole draft batches would exhaust a bank in two days and disable
// exclusion entirely (pickConcepts ignores an exhausted exclusion list).
async function recentCreativeConceptKeys(limit = 6) {
  if (!(await hasTable('social_content_studio_runs'))) return [];
  try {
    const rows = await db('social_content_studio_runs')
      .where({ run_type: 'autonomous' })
      .orderBy('started_at', 'desc')
      .limit(Math.max(1, Math.min(30, Number(limit) || 6)))
      .select('preview');
    const keys = [];
    for (const row of rows) {
      const conceptKey = toJson(row.preview, {})?.visual?.creative?.conceptKey;
      if (conceptKey) keys.push(conceptKey);
    }
    return Array.from(new Set(keys));
  } catch {
    return [];
  }
}

// AI-scene photo card variants for an autonomous run (creative engine). Returns
// [] when the engine is disabled or every variant fails, so callers keep the
// legacy SVG-card path as the fallback. Draft runs get the multi-variant batch
// for the approval queue; publish runs render exactly one.
// A Veo clip only ever publishes to Facebook/Instagram — publishToAll routes
// video to Meta while GBP keeps the still — so don't spend on a clip unless a
// REQUESTED channel can actually take it. E.g. SOCIAL_AUTONOMOUS_CHANNELS=gbp,
// or FB/IG disabled/missing credentials, would otherwise buy a clip that can
// never publish and put a misleading video option in the approval queue.
// Mirrors publishToAll's fbReady/igReady env checks.
function hasVideoCapableChannel(channels) {
  const list = Array.isArray(channels) ? channels : [];
  // Mirror publishToAll's readiness SPLIT exactly: its fbReady is CREDENTIALS-
  // only (page token + page id — IG Graph publishing rides those even with
  // Facebook posting off), while the SOCIAL_FACEBOOK_ENABLED / _INSTAGRAM_
  // flags each gate only their own platform entry. So an IG-only config with
  // Facebook disabled still earns a video, and one missing the page id doesn't.
  const pageCreds = !!process.env.FACEBOOK_ACCESS_TOKEN && !!process.env.FACEBOOK_PAGE_ID;
  const fbReady = SOCIAL_FLAGS.facebookEnabled && pageCreds;
  const igReady = SOCIAL_FLAGS.instagramEnabled && pageCreds && !!process.env.INSTAGRAM_ACCOUNT_ID;
  return (list.includes('facebook') && fbReady) || (list.includes('instagram') && igReady);
}

async function creativeVariantsForRun(plan, preview, { isReviewRun, wantsGbp, effectiveMode, now }) {
  if (!CreativeEngine.CREATIVE_FLAGS.enabled) return [];
  try {
    const cardInput = isReviewRun
      ? buildReviewCardInput(plan.reviewGraphic)
      : buildCampaignCardInput(plan, preview);
    const excludeConcepts = await recentCreativeConceptKeys();
    const variants = await CreativeEngine.generateVariants({
      cardInput,
      topic: plan.topic,
      service: plan.service,
      city: plan.city,
      variant: isReviewRun ? 'review' : 'campaign',
      count: effectiveMode === 'draft' ? CreativeEngine.CREATIVE_FLAGS.variantCount : 1,
      excludeConcepts,
      wantGbp: wantsGbp,
      now,
    });

    // Veo Reel option — DRAFT campaign runs only (approval required for video:
    // real cost per clip and the most public artifact the brand ships), on
    // every Nth ET day, and only when at least one image variant succeeded (a
    // video-only queue entry would leave GBP with no media and the runs list
    // with no thumbnail). Appended LAST so variants[0] — the run's primary
    // visual — stays a still.
    if (
      variants.length
      && !isReviewRun
      && effectiveMode === 'draft'
      && CreativeEngine.VIDEO_FLAGS.enabled
      && CreativeEngine.isVideoDay(now)
      && hasVideoCapableChannel(plan.channels)
    ) {
      const video = await CreativeEngine.generateVideoVariant({
        topic: plan.topic,
        service: plan.service,
        city: plan.city,
        excludeConcepts: [...excludeConcepts, ...variants.map((v) => v.conceptKey).filter(Boolean)],
        now,
      });
      if (video) variants.push(video);
    }

    return variants;
  } catch {
    return [];
  }
}

function selectAutonomousCampaign(now = new Date()) {
  // Anchor seasonal topic + city rotation to Eastern business dates, not UTC
  // (Railway runs TZ=UTC, which would flip topics a few hours early each day).
  const { month, day } = etParts(now);
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
  const { day } = etParts(now); // Eastern business date, not UTC (see selectAutonomousCampaign)
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

function buildVersusDrafts(pair, city) {
  const leftName = pair.left.name;
  const rightName = pair.right.name;
  // Neutral comparison hook — never assert the two LOOK similar (some pairs
  // differ visibly by the pair's own facts; an unconditional similarity claim
  // would contradict the card copy).
  const hook = `${leftName} or ${rightName}? Here is how ${city} homeowners can tell the difference.`;
  const leftLine = `${leftName}: ${pair.left.points.map((p) => p.toLowerCase()).join('; ')}.`;
  const rightLine = `${rightName}: ${pair.right.points.map((p) => p.toLowerCase()).join('; ')}.`;
  return {
    facebook: `${hook}\n\n${leftLine}\n${rightLine}\n\n${pair.verdict} Not sure which one you have? A quick inspection settles it.`,
    instagram: `${hook}\n\n${leftLine}\n${rightLine}\n\n${pair.verdict} Which one have you seen around the house?\n\n${hashtags({ topic: `${leftName} vs ${rightName}`, city, service: pair.service })}`,
    linkedin: `Correct pest ID changes the response. ${leftName} vs ${rightName}: ${pair.verdict} ${leftLine} ${rightLine} Waves turns local pest pressure and service data into practical homeowner guidance.`,
    // Both pests' facts: GBP can publish text-only (media retry path), so the
    // post must stand as a comparison without the card.
    gbp: `${city} homeowners: ${leftName.toLowerCase()} or ${rightName.toLowerCase()}? ${pair.verdict} ${leftLine} ${rightLine} ${ctaText('book inspection')}.`,
  };
}

// The "pest showdown" lane: a deterministic X-vs-Y pest ID comparison every 4th
// ET day (offset 2, so it never collides with the review lane's offset 0).
// Pure — no DB — so a selection failure can never block the campaign fallback.
function selectAutonomousVersusPlan(now = new Date()) {
  if (!AUTONOMOUS_FLAGS.includeVersus) return null;
  const { month, day } = etParts(now); // Eastern business date (see selectAutonomousCampaign)
  if (day % 4 !== 2) return null;

  const pair = PEST_VERSUS_PAIRS[(month * 7 + day) % PEST_VERSUS_PAIRS.length];
  const city = WAVES_LOCATIONS[day % WAVES_LOCATIONS.length]?.name || 'Sarasota';
  const topic = `${pair.left.name} vs ${pair.right.name}`;
  const drafts = buildVersusDrafts(pair, city);
  const channels = AUTONOMOUS_FLAGS.channels;
  return {
    topic,
    city,
    service: pair.service,
    angle: 'pest showdown',
    cta: 'book inspection',
    channels,
    versusPair: pair,
    preview: {
      inputs: { topic, city, service: pair.service, angle: 'pest showdown', cta: 'book inspection', channels },
      // CTA is "schedule an inspection" — the link (Facebook + GBP LEARN_MORE)
      // must land on the booking flow, not the blog index.
      suggestedLink: 'https://www.wavespestcontrol.com/book/',
      drafts: Object.fromEntries(channels.map((channel) => [channel, drafts[channel]]).filter(([, text]) => text)),
      validation: validateDrafts(drafts),
      sources: [{
        type: 'versus_pair',
        label: topic,
        detail: `${pair.verdict} ${pair.left.name}: ${pair.left.points.join('; ')}. ${pair.right.name}: ${pair.right.points.join('; ')}.`,
      }],
      fastestRisers: FASTEST_RISER_PROFILES.slice(0, 8),
    },
  };
}

// ── Review-count milestone lane ─────────────────────────────────────────────
// Celebrates crossing a round Google-review count (the single best-engaging
// organic format for local service brands). Company-wide count from Google's
// own per-location totals (see fleetReviewStats); fires ONCE per threshold and
// only while the count is within MILESTONE_WINDOW of it, so a lane enabled
// long after a threshold passed never posts a stale "we just hit 250".

const MILESTONE_ANGLE = 'review milestone';
const MILESTONE_WINDOW = 30;

// Highest ladder rung <= count: every 50 to 500, 250s to 2,000, 500s to
// 5,000, then every 1,000. Returns null below the first rung.
function milestoneThresholdFor(count) {
  const n = Math.floor(Number(count) || 0);
  if (n < 50) return null;
  if (n < 500) return Math.floor(n / 50) * 50;
  if (n < 2000) return Math.floor(n / 250) * 250;
  if (n < 5000) return Math.floor(n / 500) * 500;
  return Math.floor(n / 1000) * 1000;
}

// Authoritative count = Google's own per-location totals, which the Places
// stats sync stores as one '_stats' pseudo-row per location (review_text =
// {rating, totalReviews}). Same completeness/freshness rule as the admin
// dashboard and the BI review tool: EVERY configured location must have a
// row synced inside 24h with a finite totalReviews, else the snapshot is
// partial and this returns null — a public milestone claim never falls back
// to counting synced rows (incomplete, duplicable, may include retired
// locations). Rating = location ratings WEIGHTED by their review counts —
// stricter than the dashboard's simple mean, because this number is
// published: a 10-review 5.0 location must not lift a 300-review 4.6.
const STATS_FRESH_MS = 24 * 60 * 60 * 1000;

function fleetReviewStats(statsRows, locations = WAVES_LOCATIONS, now = Date.now()) {
  const fresh = {};
  for (const row of statsRows || []) {
    const t = new Date(row.synced_at).getTime();
    if (!(t > 0 && now - t <= STATS_FRESH_MS)) continue;
    try {
      const p = JSON.parse(row.review_text);
      if (p && typeof p === 'object' && Number.isFinite(p.totalReviews)) fresh[row.location_id] = p;
    } catch { /* unparseable stats payload — location stays incomplete */ }
  }
  if (!locations.length || !locations.every((loc) => fresh[loc.id])) return null;
  let count = 0;
  let weightedSum = 0;
  let weight = 0;
  for (const loc of locations) {
    const p = fresh[loc.id];
    count += p.totalReviews;
    if (p.rating && p.totalReviews > 0) { weightedSum += p.rating * p.totalReviews; weight += p.totalReviews; }
  }
  if (count <= 0) return null;
  return { count, average: weight ? Math.round((weightedSum / weight) * 10) / 10 : null };
}

async function reviewMilestoneStats() {
  if (!(await hasTable('google_reviews'))) return null;
  try {
    const rows = await db('google_reviews')
      .where({ reviewer_name: '_stats' })
      .whereIn('location_id', WAVES_LOCATIONS.map((loc) => loc.id))
      .select('location_id', 'review_text', 'synced_at');
    return fleetReviewStats(rows);
  } catch {
    return null;
  }
}

// Durable milestone ownership, independent of the run row. Written as
// 'claimed' under the fleet-stats leases BEFORE the external post and
// upgraded to 'published' after it — so neither an onFirstPlatformSuccess
// hook failure nor an audit-update crash that leaves the run 'failed' can
// let the next tick celebrate the same threshold again. Cleared only when
// the publish produced ZERO provider successes (nothing is live), so the
// threshold becomes selectable again for a retry.
function milestoneStampKey(threshold) {
  return `social.milestone.celebrated.${threshold}`;
}

async function stampMilestoneCelebrated(threshold, runId, state = 'published') {
  const now = new Date();
  const value = JSON.stringify({ threshold, runId: runId || null, state, at: now.toISOString() });
  await db('system_settings')
    .insert({
      key: milestoneStampKey(threshold),
      value,
      category: 'social',
      description: `Google review milestone ${threshold} celebrated on social`,
      created_at: now,
      updated_at: now,
    })
    .onConflict('key')
    .merge({ value, updated_at: now });
}

async function clearMilestoneStamp(threshold, runId) {
  const row = await db('system_settings').where({ key: milestoneStampKey(threshold) }).first('value').catch(() => null);
  if (!row) return;
  const parsed = toJson(row.value, {});
  // Only the owning run may release its own claim.
  if (parsed?.runId && runId && parsed.runId !== runId) return;
  await db('system_settings').where({ key: milestoneStampKey(threshold) }).del();
}

// A threshold is claimed by the durable stamp above (any state), or by any
// non-skipped run that carried it — including in-flight 'started' rows and
// approval-queue drafts — so a crash or a pending draft can't let the next
// tick mint a duplicate celebration.
async function milestoneAlreadyClaimed(threshold) {
  if (!(await hasTable('social_content_studio_runs'))) return true;
  const stamped = await db('system_settings')
    .where({ key: milestoneStampKey(threshold) })
    .first('key')
    .catch(() => null);
  if (stamped) return true;
  const row = await db('social_content_studio_runs')
    .where({ run_type: 'autonomous', angle: MILESTONE_ANGLE })
    .whereIn('status', ['started', 'published', 'draft_created'])
    .whereRaw("input->>'milestone' = ?", [String(threshold)])
    .first('id');
  return !!row;
}

// Copy states only what the snapshot proves: a count and a rating. No
// claims about who wrote the reviews (residents/homeowners/customers) and
// no recency ("just passed") — the window bounds the count, not the date.
function buildMilestoneDrafts({ threshold, average }) {
  const n = threshold.toLocaleString('en-US');
  const avgLine = average ? `Average rating: ${average.toFixed(1)} stars. ` : '';
  return {
    facebook: `${n} Google reviews. Thank you, Southwest Florida.\n\n${avgLine}We read every one, and they shape how we work.\n\nTo everyone who took a minute to share their experience: thank you.`,
    instagram: `${n} Google reviews. Thank you, Southwest Florida.\n\n${avgLine}We read every one, and they shape how we work.\n\n#wavespestcontrol #swfl #googlereviews #thankyou`,
    linkedin: `Waves Pest Control has reached ${n} Google reviews. ${avgLine}A small local team, one visit at a time. Thank you to everyone who took the time to share their experience.`,
    gbp: `${n} Google reviews and counting. Thank you to everyone in Southwest Florida who took a minute to share their experience. ${avgLine}We read every one.`,
  };
}

// Pure plan builder (DB-free) — selection reads stats + claims, then hands
// off here so the copy/preview shape is unit-testable.
function planMilestone({ threshold, count, average, city, channels }) {
  const topic = `${threshold.toLocaleString('en-US')} Google reviews`;
  const drafts = buildMilestoneDrafts({ threshold, average });
  return {
    topic,
    city,
    service: 'review proof',
    angle: MILESTONE_ANGLE,
    cta: 'read guide',
    channels,
    milestone: threshold,
    reviewCount: count,
    averageRating: average,
    preview: {
      inputs: { topic, city, service: 'review proof', angle: MILESTONE_ANGLE, cta: 'read guide', channels },
      suggestedLink: 'https://www.wavespestcontrol.com/reviews/',
      drafts: Object.fromEntries(channels.map((channel) => [channel, drafts[channel]]).filter(([, text]) => text)),
      validation: validateDrafts(drafts),
      sources: [{
        type: 'google_review_count',
        label: `${count} Google-reported reviews across all locations (fresh Places snapshot)`,
        detail: average ? `Average star rating ${average.toFixed(1)}; milestone threshold ${threshold}.` : `Milestone threshold ${threshold}.`,
      }],
      fastestRisers: FASTEST_RISER_PROFILES.slice(0, 8),
    },
  };
}

// Why a stored milestone plan may no longer be publishable: the count fell
// below the rung (reviews removed), advanced past the window (a stale
// "we just hit 300"), or the average the copy states has drifted. Pure —
// returns the reason string, or null when the plan still matches reality.
function milestoneDrift(plan, stats) {
  if (!stats) return 'review stats unavailable — milestone publish blocked';
  const threshold = Number(plan?.milestone);
  if (milestoneThresholdFor(stats.count) !== threshold) {
    return `review count is now ${stats.count}; the ${threshold} milestone no longer matches — reject this draft so the lane can regenerate`;
  }
  if (stats.count - threshold >= MILESTONE_WINDOW) {
    return `review count (${stats.count}) has moved past the ${threshold} milestone window — reject this draft so the lane can regenerate`;
  }
  const stated = plan?.averageRating == null ? null : Number(plan.averageRating);
  if ((stated ?? null) !== (stats.average ?? null)) {
    return `average rating changed (${stated ?? 'n/a'} → ${stats.average ?? 'n/a'}) since the copy was written — reject this draft so the lane can regenerate`;
  }
  return null;
}

// Re-read stats immediately before publication (direct run) or approval
// (draft) — the plan was built earlier and reviews/ratings move.
async function milestonePublishBlocker(plan) {
  return milestoneDrift(plan, await reviewMilestoneStats());
}

async function selectAutonomousMilestonePlan(now = new Date()) {
  if (!AUTONOMOUS_FLAGS.includeMilestones) return null;
  const stats = await reviewMilestoneStats();
  if (!stats) return null;
  const threshold = milestoneThresholdFor(stats.count);
  if (!threshold || stats.count - threshold >= MILESTONE_WINDOW) return null;
  if (await milestoneAlreadyClaimed(threshold)) return null;
  const { day } = etParts(now); // GBP location rotation only — the copy is company-wide
  const city = WAVES_LOCATIONS[day % WAVES_LOCATIONS.length]?.name || 'Sarasota';
  return planMilestone({
    threshold,
    count: stats.count,
    average: stats.average,
    city,
    channels: AUTONOMOUS_FLAGS.channels,
  });
}

async function selectAutonomousPlan(now = new Date()) {
  // One-shot celebration outranks the recurring lanes on the day it fires.
  const milestonePlan = await selectAutonomousMilestonePlan(now);
  if (milestonePlan) return milestonePlan;

  const reviewPlan = await selectAutonomousReviewPlan(now);
  if (reviewPlan) return reviewPlan;

  const versusPlan = selectAutonomousVersusPlan(now);
  if (versusPlan) return versusPlan;

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
  { match: ['tree', 'shrub', 'ornamental', 'palm', 'tree and shrub', 'tree & shrub'] },
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
  const targetCity = context?.location?.city || input.city;
  const serviceFact = firstSentence(relevantServices(context, input)[0]?.description);
  const contentFact = firstSentence(context.content[0]?.meta_description || context.content[0]?.title);
  const pestPressureFact = firstSentence(context.pestPressure?.explanation);
  const reviewFact = firstSentence(context.reviews[0]?.review_text, 160);
  return [serviceFact, contentFact, pestPressureFact, reviewFact]
    .filter(Boolean)
    // Review text and brand-wide sources can name any city regardless of the
    // row-level filters — drop cross-city facts rather than publish them.
    .filter((fact) => !mentionsOtherCity(fact, targetCity));
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

// Grounded fact pack for AI copy — the same context buildCampaignDrafts draws
// from, as a short bullet list the model may use (and must not exceed/invent
// beyond). Keeps the AI captions factual and local.
function campaignFactPack(context, input) {
  const targetCity = context?.location?.city || input?.city;
  const lines = [];
  const svc = relevantServices(context, input)[0];
  if (svc?.description) lines.push(svc.description);
  for (const f of (sourceFacts(context, input) || [])) lines.push(f);
  if (context?.pestPressure?.explanation) lines.push(context.pestPressure.explanation);
  return Array.from(new Set(lines.map((l) => cleanText(l, 400)).filter(Boolean)))
    // sourceFacts is already scrubbed; this catches the two lines pushed
    // directly (full service description, pest-pressure explanation).
    .filter((l) => !mentionsOtherCity(l, targetCity))
    .slice(0, 6)
    .map((l) => `- ${l}`)
    .join('\n');
}

// Brand-voice AI drafts grounded in the campaign context. Per-channel fall back
// to the deterministic template, so a Claude outage/invalid output never blocks
// a post and the copy is always present + length-valid.
async function buildCampaignDraftsAI(input, context) {
  const template = buildCampaignDrafts(input, context);
  try {
    if (typeof SocialMediaService.generateCampaignDrafts !== 'function' || !process.env.ANTHROPIC_API_KEY) {
      return template;
    }
    const channels = normalizeChannels(input.channels);
    if (!channels.length) return template;
    const svc = relevantServices(context, input)[0];
    const ai = await SocialMediaService.generateCampaignDrafts({
      topic: cleanText(input.topic, 200),
      facts: campaignFactPack(context, input),
      cta: ctaText(input.cta),
      city: context?.location?.city || input.city,
      service: svc?.name || svc?.short_name || input.service,
      channels,
    });
    const out = { ...template };
    const targetCity = context?.location?.city || input.city;
    // Belt and suspenders: even with a city-scrubbed fact pack the model can
    // still name a stray city. A cross-city draft falls back to the
    // (city-clean) template for that channel instead of publishing mixed-city
    // copy — the 07-03 live failure this grounding exists to prevent.
    for (const ch of channels) if (ai && ai[ch] && !mentionsOtherCity(ai[ch], targetCity)) out[ch] = ai[ch];
    return out;
  } catch {
    return template;
  }
}

async function previewCampaign(input) {
  const context = await getCampaignContext(input);
  const drafts = await buildCampaignDraftsAI(input, context);
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
  // image_url is persisted then rendered as <a href>/<img src> in the admin UI,
  // and both input.imageUrl and a caller-supplied preview.visual.imageUrl reach
  // here from req.body — so validate each to http(s) before trusting it, falling
  // back to the freshly rendered card (an https S3/CDN URL).
  const imageUrl = httpUrlOrNull(input.imageUrl)
    || httpUrlOrNull(preview.visual?.imageUrl)
    || await renderCampaignImageUrl(input, preview);
  // Preserve an existing visual's identity (photo-card runs pass a preview that
  // already carries variant/templateKey/creative/variants for the approval
  // queue) — only default the legacy campaign card when nothing is set.
  const finalPreview = previewWithVisual(preview, {
    imageUrl,
    variant: preview.visual?.variant || 'campaign',
    templateKey: preview.visual?.templateKey || 'waves_campaign_square',
    creative: preview.visual?.creative,
    variants: preview.visual?.variants,
  });
  const title = cleanText(input.title || `${preview.inputs.city}: ${preview.inputs.topic}`, 180);
  const [post] = await db('social_media_posts')
    .insert({
      title,
      description: cleanText(input.description || preview.inputs.service || preview.inputs.topic, 1000),
      // normalizeUrl canonicalizes (forces https, strips UTM) but its catch
      // fallback passes non-URL junk through and doesn't reject javascript:/
      // data: schemes — and source_url is later rendered as an admin link. Gate
      // the normalized value through httpUrlOrNull so only http(s) is stored.
      source_url: httpUrlOrNull(normalizeUrl(input.link || preview.suggestedLink)),
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

// Serialize the whole run behind a Postgres advisory lock: the cadence guard
// reads-then-writes and then calls external Meta/GBP APIs, so without this two
// concurrent triggers (double force-clicks, overlapping pods) could each pass
// the guard and double-post. If the lease is held elsewhere, this tick skips.
async function runAutonomous(opts = {}) {
  return runExclusive('social_autonomous_studio', () => runAutonomousLocked(opts));
}

async function runAutonomousLocked({ force = false, mode } = {}) {
  const startedAt = new Date();
  // Omitted → env default; an explicit but invalid mode fails closed to draft.
  const effectiveMode = mode == null || String(mode).trim() === ''
    ? AUTONOMOUS_FLAGS.mode
    : normalizePublishMode(mode, AUTONOMOUS_FLAGS.mode);

  // The studio-enable flag is the feature kill switch and is ALWAYS enforced —
  // even an admin "Run Draft/Run Publish" (force:true). force only bypasses the
  // cadence guard below, so a dark feature can't publish just because global
  // social automation happens to be on.
  if (!AUTONOMOUS_FLAGS.enabled) {
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

  // Fail closed if the audit/cadence table is missing. latestAutonomousRun()
  // and insertAutonomousRun() both no-op when social_content_studio_runs is
  // absent, so without this the cadence guard would see "no prior run" on every
  // tick and the hourly cron would publish each fire with no throttle and no
  // audit trail. Require the table before selecting/rendering/publishing.
  if (!(await hasTable('social_content_studio_runs'))) {
    return { skipped: true, reason: 'social_content_studio_runs table is unavailable' };
  }

  if (!force) {
    const latest = await latestAutonomousClaim();
    if (latest?.started_at) {
      const elapsedHours = (startedAt.getTime() - new Date(latest.started_at).getTime()) / 36e5;
      if (elapsedHours < AUTONOMOUS_FLAGS.intervalHours) {
        const reason = `cadence guard: ${elapsedHours.toFixed(1)}h since last autonomous run (status=${latest.status})`;
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
    let gbpImageUrl = null;
    let finalPreview = preview;
    const wantsGbp = Array.isArray(plan.channels) && plan.channels.includes('gbp');
    // Liveness protection derives from the source review id ALONE: hasTable
    // swallows transient schema-lookup failures as false, and letting it
    // into this classification reclassified a testimonial as an ordinary
    // campaign — skipping every source-liveness check on the publish path.
    // The fallible schema gate only decides whether the graphic can be
    // PERSISTED after a successful publish.
    const isReviewRun = !!plan.reviewGraphic?.googleReviewId;
    const canPersistGraphic = isReviewRun && await hasTable('review_graphics');
    // Versus runs are the deterministic split-panel ID card by design — an AI
    // photo scene can't render a two-pest comparison, so the creative engine is
    // skipped entirely (same "never block, never substitute" posture as GBP).
    const isVersusRun = !isReviewRun && !!plan.versusPair;
    // Milestone runs are the deterministic number card (same posture as versus).
    const isMilestoneRun = !isReviewRun && !isVersusRun && !!plan.milestone;

    // Creative engine first (AI photo scene + deterministic brand overlay,
    // gated by SOCIAL_CREATIVE_ENGINE_ENABLED). An empty result — engine off,
    // provider outage, upload failure — falls through to the legacy SVG brand
    // card below, so the engine can only ever upgrade a post, never block one.
    // GBP never posts AI imagery (owner rule): creative variants are AI photo
    // scenes, so the engine is asked for no GBP (4:3) scene at all — GBP takes
    // the deterministic card render below, same as the non-creative branches.
    // A GBP-ONLY run skips the engine entirely: nothing would consume the
    // square scenes, so generating them just burns paid image credits. For
    // an immediate publish, additionally require at least one non-GBP
    // channel to be actually publish-ready (creds/flags present) — otherwise
    // publishToAll skips Meta and every generated asset is discarded. Draft
    // runs keep generating regardless of readiness: their variants are the
    // approval queue's content and publish later, when readiness may differ.
    const hasNonGbpChannel = Array.isArray(plan.channels)
      && plan.channels.some((c) => c !== 'gbp');
    let creativeEligible = hasNonGbpChannel && !isVersusRun && !isMilestoneRun;
    if (creativeEligible && effectiveMode !== 'draft') {
      creativeEligible = false;
      for (const ch of plan.channels) {
        if (ch === 'gbp') continue;
         
        const readiness = await SocialMediaService.assertSocialPublishingReady(ch);
        if (readiness.ready) { creativeEligible = true; break; }
      }
    }
    const creativeVariants = creativeEligible
      ? await creativeVariantsForRun(plan, preview, {
        isReviewRun, wantsGbp: false, effectiveMode, now: startedAt,
      })
      : [];
    if (creativeVariants.length) {
      imageUrl = creativeVariants[0].imageUrl;
      if (wantsGbp) {
        gbpImageUrl = isReviewRun
          ? await renderReviewGraphicImageUrl(plan.reviewGraphic, 'gbp')
          : await renderCampaignImageUrl(plan, preview, 'gbp');
      }
      finalPreview = previewWithVisual(preview, {
        imageUrl,
        gbpImageUrl,
        variant: isReviewRun ? 'review' : 'campaign',
        templateKey: isReviewRun ? 'waves_photo_review_v1' : 'waves_photo_square_v1',
        creative: {
          conceptKey: creativeVariants[0].conceptKey,
          sceneModel: creativeVariants[0].sceneModel,
        },
        variants: creativeVariants,
      });
    } else if (isReviewRun) {
      // Render the review card for preview/publish, but do NOT persist or approve
      // the graphic yet. listReviewGraphicCandidates() excludes any review
      // already joined to review_graphics, so creating the row here would consume
      // the review from the candidate queue even on a dry run or a failed
      // publish. Persist + approve happens only after a confirmed successful
      // publish (below).
      imageUrl = await renderReviewGraphicImageUrl(plan.reviewGraphic);
      if (wantsGbp) gbpImageUrl = await renderReviewGraphicImageUrl(plan.reviewGraphic, 'gbp');
      finalPreview = previewWithVisual(preview, {
        imageUrl,
        gbpImageUrl,
        variant: 'review',
        templateKey: 'waves_clean_square',
      });
    } else if (isMilestoneRun) {
      imageUrl = await renderMilestoneImageUrl(plan);
      if (wantsGbp) gbpImageUrl = await renderMilestoneImageUrl(plan, 'gbp');
      finalPreview = previewWithVisual(preview, {
        imageUrl,
        gbpImageUrl,
        variant: 'milestone',
        templateKey: 'waves_milestone_square',
      });
    } else if (isVersusRun) {
      imageUrl = await renderVersusImageUrl(plan.versusPair, plan);
      if (wantsGbp) gbpImageUrl = await renderVersusImageUrl(plan.versusPair, plan, 'gbp');
      finalPreview = previewWithVisual(preview, {
        imageUrl,
        gbpImageUrl,
        variant: 'versus',
        templateKey: 'waves_versus_square',
      });
    } else {
      imageUrl = await renderCampaignImageUrl(plan, preview);
      if (wantsGbp) gbpImageUrl = await renderCampaignImageUrl(plan, preview, 'gbp');
      finalPreview = previewWithVisual(preview, {
        imageUrl,
        gbpImageUrl,
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

    // Pre-publish liveness gate (mirrors approveAutonomousRun): the candidate
    // was selected before the creative render/upload, and the hourly sync can
    // stamp the review missing inside that window. Re-read the source row so
    // a removed review never publishes as a "current Google review" — the
    // post-publish createReviewGraphic re-check is bookkeeping only and its
    // rejection is swallowed after the post is already live.
    if (isReviewRun && (await hasTable('google_reviews'))) {
      const srcReview = await db('google_reviews')
        .where({ id: plan.reviewGraphic.googleReviewId })
        .first()
        .catch(() => null);
      if (!srcReview || srcReview.missing_since) {
        const reason = srcReview
          ? 'source Google review has been removed from Google — testimonial publish blocked'
          : 'source Google review no longer exists — testimonial publish blocked';
        await updateAutonomousRun(run?.id, {
          status: 'failed',
          preview: finalPreview,
          skipReason: reason,
        });
        return { success: false, skipped: true, reason, mode: effectiveMode, preview: finalPreview };
      }
    }

    // Milestone counterpart of the liveness gate: the count/average were read
    // at selection, before render/upload — cheap re-check here; the lease
    // below re-checks again with the stats sync excluded.
    if (isMilestoneRun) {
      const reason = await milestonePublishBlocker(plan);
      if (reason) {
        await updateAutonomousRun(run?.id, { status: 'failed', preview: finalPreview, skipReason: reason });
        return { success: false, skipped: true, reason, mode: effectiveMode, preview: finalPreview };
      }
    }

    const guid = `${AUTONOMOUS_SOURCE}_${startedAt.toISOString()}`;
    // The snapshot gates above reject cheaply; the locks close their TOCTOU —
    // the reconcile cannot stamp the source row (review runs) and the stats
    // sync cannot move the fleet count (milestone runs) between here and the post.
    const publishFn = () => SocialMediaService.publishToAll({
        title: plan.topic,
        description: plan.service,
        link: finalPreview.suggestedLink,
        guid,
        source: AUTONOMOUS_SOURCE,
        customContent: finalPreview.drafts,
        channels: plan.channels,
        imageUrl,
        gbpImageUrl,
        gbpImageBranded: true, // deterministic card render — chrome carries the logo
        noAiImage: true, // brand card only — never a literal AI image
        gbpLocationIds: finalPreview.inputs?.locationId ? [finalPreview.inputs.locationId] : [locationForCity(plan.city).id],
        // Durable stamp at the FIRST provider success — a crash or stall in a
        // later provider call can no longer outlive the claim TTL with the
        // testimonial live externally but unrecorded. First-win: the
        // post-publish stamp below becomes a no-op backstop.
        onFirstPlatformSuccess: isReviewRun && !SOCIAL_FLAGS.dryRun
          ? () => recordTestimonialPublished(plan.reviewGraphic.googleReviewId, run?.id)
          : null,
      });
    const publishOutcome = isMilestoneRun
      ? await publishWithFleetStatsLease(plan, publishFn, run?.id)
      : await publishWithReviewLivenessLock(
        isReviewRun ? plan.reviewGraphic.googleReviewId : null,
        publishFn,
        { rejectConsumed: true },
      );
    if (publishOutcome.blocked) {
      const reason = publishOutcome.driftReason
        ? publishOutcome.driftReason
        : publishOutcome.lockBusy
        ? (isMilestoneRun
          ? 'review stats sync in progress — milestone publish deferred, retry the run'
          : 'review sync in progress for this location — testimonial publish deferred, retry the run')
        : publishOutcome.consumed
          ? 'source Google review was already published as a testimonial — candidate consumed'
          : publishOutcome.missing
            ? 'source Google review no longer exists — testimonial publish blocked'
            : 'source Google review has been removed from Google — testimonial publish blocked';
      await updateAutonomousRun(run?.id, {
        status: 'failed',
        preview: finalPreview,
        skipReason: reason,
      });
      return { success: false, skipped: true, reason, mode: effectiveMode, preview: finalPreview };
    }
    const publishResult = publishOutcome.result;
    // The claim is held through the durable published stamp below —
    // releasing it right after the publish would let a second draft run
    // referencing the same review acquire and double-publish in the
    // publish→stamp gap. If the STAMP fails after a live publish, the claim
    // is RETAINED and its release transfers to the detached recovery loop —
    // the finally must not release it (no durable record plus a cleared
    // claim IS the double-publish window).
    let claimRetained = false;
    try {

    const post = await db('social_media_posts')
      .where({ source_guid: guid })
      .orderBy('created_at', 'desc')
      .first()
      .catch(() => null);

    // Now that the post actually published, record + approve the review graphic,
    // which consumes the review from the candidate queue. A dry run
    // (publishResult.success === false) or a total publish failure leaves the
    // review available for a future run. Also require imageUrl: if the card
    // failed to render (no CDN/S3 or a sharp/S3 error) the post may still have
    // gone out as text, but consuming the review with a null-image graphic would
    // drop it from the candidate queue forever and it could never be rendered.
    // DURABLE published stamp on the FIRST successful external post — before
    // and independent of the review_graphics bookkeeping. Once it lands,
    // candidate selection and the publish-time consumed check both reject
    // this review permanently, so a bookkeeping failure (or a process crash
    // after this point) can no longer reopen a double-publish window. If
    // the stamp itself fails, RETAIN the claim and hand recovery to the
    // detached loop — releasing it with no durable record IS the window.
    if (isReviewRun && !SOCIAL_FLAGS.dryRun && publishResult.success) {
      try {
        await recordTestimonialPublished(plan.reviewGraphic.googleReviewId, run?.id);
      } catch (err) {
        logger.error(`[studio] testimonial-published stamp FAILED after publish (review ${plan.reviewGraphic.googleReviewId}): ${err.message} — claim retained, recovery loop will write the durable record`);
        claimRetained = true;
        // Intentional fire-and-forget — the helper attaches its own terminal
        // catch and the claim self-expires if the process dies mid-loop.
        void holdClaimUntilPublishRecorded({
          googleReviewId: plan.reviewGraphic.googleReviewId,
          record: () => recordTestimonialPublished(plan.reviewGraphic.googleReviewId, run?.id),
          claim: publishOutcome,
        });
      }
    }
    // Graphic bookkeeping — admin history and the saved-graphics list. The
    // durable stamp above already blocks reselection, so a failure here is
    // loud but does not need to hold the claim.
    if (canPersistGraphic && !SOCIAL_FLAGS.dryRun && publishResult.success && imageUrl) {
      await persistReviewGraphicWithRetry({
        googleReviewId: plan.reviewGraphic.googleReviewId,
        privacyMode: plan.reviewGraphic.privacyMode || 'first_name_city',
        // Follow the visual that actually published (photo card vs SVG card).
        templateKey: finalPreview.visual?.templateKey || 'waves_clean_square',
        channels: plan.channels,
        status: 'approved',
        imageUrl,
      }).catch((err) => {
        logger.error(`[studio] review-graphic bookkeeping FAILED after publish (review ${plan.reviewGraphic.googleReviewId}): ${err.message} — graphic record missing from admin history; reselection stays durably blocked by the published stamp`);
        return null;
      });
    } else if (isReviewRun && !canPersistGraphic && !SOCIAL_FLAGS.dryRun && publishResult.success) {
      logger.error(`[studio] review_graphics table unavailable — published review ${plan.reviewGraphic.googleReviewId} has no graphic bookkeeping row; reselection stays durably blocked by the published stamp`);
    }

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
    } finally {
      if (!claimRetained) await publishOutcome.releaseClaim();
    }
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

// ── Approval queue (draft_created runs) ─────────────────────────────────────
// A draft autonomous run holds everything needed to publish (channel drafts,
// suggested link, rendered visual + creative-engine variants) in its preview.
// Approve publishes the stored content with the admin's chosen variant and
// folds the outcome into the SAME run + draft post row; reject retires both.

// Resolve the publishable variant list for a run preview. Creative-engine runs
// carry preview.visual.variants; legacy single-card drafts collapse to a
// one-entry list so the same approve path serves both.
/**
 * Serialize a testimonial's liveness decision with the reconcile's stamping
 * UPDATE. The snapshot gates in runAutonomous/approveAutonomousRun are
 * TOCTOU: `_reconcileMissingReviews` can stamp the source review between
 * the read and publishToAll. FOR UPDATE on the source row makes the hourly
 * claim (an UPDATE on the same row) queue behind the publish, so "checked
 * live" and "published" are one atomic decision — a stamp that loses the
 * race lands after commit, where it is a genuinely concurrent removal (the
 * watchdog alert still fires and stamped rows drop off every surface).
 * The liveness DECISION runs under the per-location advisory lock the sync
 * holds across its whole fetch→reconcile cycle (gbp-review-sync:<loc>):
 * while the lock is held no cycle is in flight and no stamp is pending
 * (the reconcile is the only stamp writer and runs inside the same lock).
 * The decision is a CONDITIONAL CLAIM — one statement that verifies the
 * row is unstamped and stamps publish_claimed_until — and then the lock
 * (and its pooled connection) is released BEFORE the slow multi-provider
 * publish: holding it across provider stalls pinned a pool connection per
 * in-flight publish and could starve unrelated queries. The durable claim
 * covers the publish interval instead: the reconcile skips rows with an
 * unexpired claim, so no removal stamp can land mid-publication either.
 * The claim self-expires (PUBLISH_CLAIM_MS) and is cleared best-effort
 * afterwards, so a crashed publisher only defers that row's stamping to
 * the next hourly cycle. When a LIVE publish cannot get its DURABLE
 * published stamp written (recordTestimonialPublished), callers retain
 * the claim instead of releasing it and holdClaimUntilPublishRecorded
 * owns the release (see its doc).
 * Non-review publishes (no sourceReviewId) pass straight through.
 * FAIL CLOSED: no hasTable pre-check — a DB error rejects and the publish
 * fails loudly.
 */
const PUBLISH_CLAIM_MS = 10 * 60 * 1000;

const NOOP_RELEASE = async () => {};
const NOOP_ABANDON = () => {};

// Milestone counterpart of publishWithReviewLivenessLock, same shape as the
// review lane's release-before-publish design: the fleet snapshot is
// written by the Places stats sync under runExclusive
// `gbp-review-sync:<location>`, so EVERY configured location's lease is
// held (non-blocking try-locks, fixed order → no deadlock) only for the
// atomic part — the final drift re-check plus writing the durable 'claimed'
// stamp — and released BEFORE the external provider calls (which have no
// total deadline; holding four sync leases and pool connections across them
// would starve review sync fleet-wide). The stamp is what survives: a
// stats change during the publish itself can only shift the count by the
// handful of reviews that land in those seconds — the same staleness any
// published statistic has — and can never produce a second celebration.
// Any lease contention → { blocked, lockBusy } and the caller retries later.
async function publishWithFleetStatsLease(plan, publishFn, runId) {
  const ids = WAVES_LOCATIONS.map((loc) => loc.id).sort();
  const HELD = Symbol('held');
  const acquire = async (i) => {
    if (i >= ids.length) {
      const driftReason = await milestonePublishBlocker(plan);
      if (driftReason) return { [HELD]: true, blocked: true, driftReason };
      await stampMilestoneCelebrated(plan.milestone, runId, 'claimed');
      return { [HELD]: true, claimed: true };
    }
    return runExclusive(`gbp-review-sync:${ids[i]}`, () => acquire(i + 1), { recordHealth: false });
  };
  const gate = await acquire(0);
  if (!gate || !gate[HELD]) return { blocked: true, lockBusy: true };
  if (gate.blocked) return { blocked: true, driftReason: gate.driftReason };

  // Leases released — publish. Same { blocked, result, releaseClaim,
  // abandonClaim } outcome shape the callers already handle.
  // A thrown publish leaves the 'claimed' stamp in place on purpose: provider
  // state is unknown, and a duplicate celebration is worse than a missed one.
  const outcome = await publishWithReviewLivenessLock(null, publishFn);
  const anySuccess = !!outcome?.result?.success
    || (Array.isArray(outcome?.result?.platforms) && outcome.result.platforms.some((p) => p?.success));
  if (anySuccess) {
    await stampMilestoneCelebrated(plan.milestone, runId, 'published').catch((err) => {
      logger.error(`[studio] milestone ${plan.milestone} published but stamp upgrade failed (claim retained): ${err.message}`);
    });
  } else {
    await clearMilestoneStamp(plan.milestone, runId).catch(() => {});
  }
  return outcome;
}

async function publishWithReviewLivenessLock(sourceReviewId, publishFn, { rejectConsumed = false, allowConsumedByRunId = null } = {}) {
  if (!sourceReviewId) {
    return { blocked: false, result: await publishFn(), releaseClaim: NOOP_RELEASE, abandonClaim: NOOP_ABANDON };
  }
  const source = await db('google_reviews').where({ id: sourceReviewId }).first();
  if (!source || source.missing_since) {
    return { blocked: true, missing: !source };
  }
  // The claimed-until value doubles as the ownership token: acquisition is
  // serialized under the advisory lock, so exactly one publisher can win a
  // given claim window — and releaseClaim below releases ONLY a claim this
  // invocation owns, never a successor's.
  const claimUntil = new Date(Date.now() + PUBLISH_CLAIM_MS).toISOString();
  const decision = await runExclusive(`gbp-review-sync:${source.location_id}`, async () => {
    if (rejectConsumed) {
      // Two draft runs can reference the same review (drafts don't insert
      // review_graphics) — once one approval consumed the candidate, a
      // second acquisition must fail permanently, not just while the first
      // claim is live. FAIL CLOSED: duplicate prevention is the whole point
      // of these lookups, so a transient DB failure must abort the publish
      // (the error propagates and the run fails loudly) — swallowing it
      // would treat "couldn't check" as "not consumed" and re-publish a
      // testimonial another run already posted.
      const consumedRow = await db('review_graphics')
        .where({ google_review_id: sourceReviewId, status: 'approved' })
        .first();
      if (consumedRow) return { consumed: true };
      // The DURABLE published stamp — written on the first successful
      // external post, before and independent of review_graphics
      // bookkeeping, so it survives bookkeeping failures and process
      // crashes. Only the OWNING run (a partial approval retrying its
      // remaining channels) may publish past its own stamp; everyone
      // else is consumed. Fresh read inside the advisory lock.
      const currentSource = await db('google_reviews').where({ id: sourceReviewId }).first();
      if (currentSource?.testimonial_published_at
        && (allowConsumedByRunId == null
          || String(currentSource.testimonial_published_run) !== String(allowConsumedByRunId))) {
        return { consumed: true };
      }
    }
    const claimed = await db('google_reviews')
      .where({ id: sourceReviewId })
      .whereNull('missing_since')
      // Acquire only when unclaimed or expired — a live claim means another
      // publish of this review is in flight, and accepting anyway would
      // double-publish and let the first finisher erase the second's claim.
      .whereRaw('(publish_claimed_until IS NULL OR publish_claimed_until < ?)', [new Date().toISOString()])
      .update({ publish_claimed_until: claimUntil });
    return { claimed: (Array.isArray(claimed) ? claimed.length : claimed) > 0 };
  }, { recordHealth: false });
  if (decision?.skipped) {
    return { blocked: true, lockBusy: true };
  }
  if (decision.consumed) {
    return { blocked: true, consumed: true };
  }
  if (!decision.claimed) {
    // Zero rows: stamped/deleted, or another publisher holds a live claim.
    const fresh = await db('google_reviews').where({ id: sourceReviewId }).first();
    if (fresh && !fresh.missing_since) {
      return { blocked: true, lockBusy: true };
    }
    return { blocked: true, missing: !fresh };
  }
  // Heartbeat: provider requests carry no total deadline, so a stalled
  // publish could outlive the claim TTL and let the reconcile stamp the
  // review mid-publication. Renew the OWNED claim (token-matched, so a
  // successor's claim is never touched) at a third of the TTL. If a
  // renewal is still in flight when the release runs, the clear can miss
  // the rotated token — that orphan self-expires within one TTL and only
  // defers that row's stamping by one cycle.
  let currentClaim = claimUntil;
  const heartbeat = setInterval(async () => {
    try {
      const next = new Date(Date.now() + PUBLISH_CLAIM_MS).toISOString();
      const renewed = await db('google_reviews')
        .where({ id: sourceReviewId })
        .where('publish_claimed_until', currentClaim)
        .update({ publish_claimed_until: next });
      if ((Array.isArray(renewed) ? renewed.length : renewed) > 0) currentClaim = next;
    } catch { /* best-effort — the TTL still bounds the window */ }
  }, Math.floor(PUBLISH_CLAIM_MS / 3));
  heartbeat.unref?.();
  let released = false;
  const releaseClaim = async () => {
    if (released) return;
    released = true;
    clearInterval(heartbeat);
    await db('google_reviews')
      .where({ id: sourceReviewId })
      .where('publish_claimed_until', currentClaim)
      .update({ publish_claimed_until: null })
      .catch(() => null);
  };
  // Abandon = stop renewing but DELIBERATELY leave the claim standing, so it
  // self-expires within one TTL. Used when a live external publish could not
  // get its candidate consumption recorded: actively clearing the claim
  // would re-open reselection (and double-publish) immediately, while an
  // expiring claim never blocks the reconcile for longer than one TTL after
  // the heartbeat stops.
  const abandonClaim = () => {
    if (released) return;
    released = true;
    clearInterval(heartbeat);
  };
  try {
    const result = await publishFn();
    // The claim deliberately SURVIVES a successful publish: callers hold it
    // through their post-publish bookkeeping (candidate consumption, local
    // record) and release via releaseClaim() — otherwise a competitor could
    // acquire in the publish→consume gap and double-publish.
    return { blocked: false, result, releaseClaim, abandonClaim };
  } catch (err) {
    await releaseClaim();
    throw err;
  }
}

function runVariants(preview = {}) {
  const visual = preview.visual || {};
  if (Array.isArray(visual.variants) && visual.variants.length) return visual.variants;
  if (visual.imageUrl) {
    return [{
      imageUrl: visual.imageUrl,
      gbpImageUrl: null,
      conceptKey: visual.creative?.conceptKey || null,
      sceneModel: visual.creative?.sceneModel || null,
    }];
  }
  return [];
}

// Pure: merge a prior approval attempt's platform successes with the current
// attempt and decide whether the approval is COMPLETE. Rules:
// - success: any platform success across attempts (the post-level rule).
// - videoPosted: a video approval needs at least one reel/video success.
// - videoBlocked: a video approval stays incomplete while any REQUESTED Meta
//   channel has been attempted and failed without ever succeeding — so a
//   half-posted FB+IG pair keeps the run retryable for the missing platform.
//   A SKIP (platform not configured/enabled) doesn't block: it can never
//   succeed, and the capability gate means a video variant only exists when
//   at least one Meta channel was publish-ready.
// Exported for tests.
function assessApprovalPublish({ isVideoVariant, channels, priorPlatforms, current } = {}) {
  const priorSuccesses = (Array.isArray(priorPlatforms) ? priorPlatforms : []).filter((p) => p?.success);
  const platforms = [...priorSuccesses, ...((current && current.platforms) || [])];
  const success = platforms.some((p) => p?.success);
  const videoPosted = !isVideoVariant
    || platforms.some((p) => p?.success && (p.mediaType === 'reel' || p.mediaType === 'video'));
  const metaChannels = (channels || []).filter((c) => c === 'facebook' || c === 'instagram');
  // A requested Meta channel must be RESOLVED before a video approval can
  // finalize: a success (now or prior), or a channel-level skip in the current
  // attempt (unconfigured/disabled — can never succeed). A channel with no
  // entry at all stays blocking: prior failures are not carried into the merge,
  // so a retry that comes back with only a GLOBAL skip (automation disabled/
  // paused → one {platform:'all', skipped} row) must not let the prior
  // success finalize a run whose other Meta channel never got the video.
  const videoBlocked = !!isVideoVariant && metaChannels.some((channel) => {
    const entries = platforms.filter((p) => p?.platform === channel);
    if (entries.some((p) => p?.success)) return false;
    if (entries.length && entries.every((p) => p?.skipped)) return false; // channel-level skip
    return true; // failed, dry-run, or unresolved (global skip / never attempted)
  });
  return {
    success,
    videoPosted,
    videoBlocked,
    complete: success && videoPosted && !videoBlocked,
    mergedPublishResult: { ...(current || {}), success, platforms },
  };
}

async function approveAutonomousRun(runId, { variantIndex = 0 } = {}) {
  if (!(await hasTable('social_content_studio_runs'))) {
    return { ok: false, status: 503, error: 'social_content_studio_runs table is unavailable' };
  }
  // Per-run advisory lock: a double-clicked Approve (or two admin tabs) must
  // not publish twice. Non-blocking — the loser gets a 409, not a queue.
  const result = await runExclusive(`social_autonomous_approve_${runId}`, async () => {
    // .catch(null): a malformed :id (not a UUID) is a 404, not a 500.
    const run = await db('social_content_studio_runs')
      .where({ id: runId, run_type: 'autonomous' })
      .first()
      .catch(() => null);
    if (!run) return { ok: false, status: 404, error: 'autonomous run not found' };
    if (run.status !== 'draft_created') {
      return { ok: false, status: 409, error: `run is '${run.status}' — only draft_created runs can be approved` };
    }

    const preview = toJson(run.preview, {});
    const input = toJson(run.input, {});
    // A review-testimonial draft must not publish a review Google has since
    // removed — the stored draft copy would post as a "current Google
    // review". createReviewGraphic re-checks eligibility, but only AFTER a
    // successful publish (bookkeeping); this is the pre-publish gate. Also
    // blocks partial-publish retries: stopping further spread beats
    // completing the channel set with a removed review.
    const sourceReviewId = input.reviewGraphic?.googleReviewId || null;
    if (sourceReviewId && (await hasTable('google_reviews'))) {
      const srcReview = await db('google_reviews').where({ id: sourceReviewId }).first().catch(() => null);
      if (!srcReview) {
        return { ok: false, status: 409, error: 'source Google review no longer exists — testimonial cannot be published' };
      }
      if (srcReview.missing_since) {
        return { ok: false, status: 409, error: 'source Google review has been removed from Google — testimonial cannot be published' };
      }
    }
    // A milestone draft can sit in the queue for days; the stored copy and
    // card state a count/average that may no longer hold. Re-validate before
    // publishing (rejecting the draft releases the threshold claim).
    if (input.milestone) {
      const reason = await milestonePublishBlocker(input);
      if (reason) return { ok: false, status: 409, error: reason };
    }
    const variants = runVariants(preview);
    const priorRecordFull = toJson(run.publish_result, {});
    const priorHasSuccess = Array.isArray(priorRecordFull?.platforms)
      && priorRecordFull.platforms.some((p) => p?.success);
    let idx = Number(variantIndex ?? 0);
    // Once any platform has actually posted, the creative is LOCKED to the
    // variant that posted it: a retry (page refresh → variantIndex defaults to
    // 0) must finish the same publish, not post a DIFFERENT still/video to the
    // remaining channels while earlier channels carry the original.
    const lockedIdx = priorHasSuccess ? Number(priorRecordFull?.approval?.variantIndex) : NaN;
    if (Number.isInteger(lockedIdx) && lockedIdx >= 0 && lockedIdx < variants.length) {
      idx = lockedIdx;
    }
    if (!Number.isInteger(idx) || idx < 0 || idx >= variants.length) {
      return { ok: false, status: 400, error: variants.length ? `variantIndex must be 0..${variants.length - 1}` : 'run has no publishable image' };
    }
    const chosen = variants[idx];
    const isVideoVariant = chosen?.type === 'video';
    // Variants were persisted server-side at run time, but re-validate to http(s)
    // anyway — preview JSON is also reachable through admin save endpoints.
    const chosenVideoUrl = isVideoVariant ? httpUrlOrNull(chosen?.videoUrl) : null;
    if (isVideoVariant && !chosenVideoUrl) {
      return { ok: false, status: 400, error: 'selected variant has no hosted video' };
    }
    // The still that rides along with the publish: for an image approval it's
    // the chosen variant; for a video approval it's the run's first image
    // variant (GBP has no video ingestion, and the post row keeps an image
    // thumbnail). A video approval with no image variant just posts GBP
    // text-only — its CTA button still carries the link.
    const imageVariant = isVideoVariant
      ? variants.find((v) => v?.type !== 'video' && v?.imageUrl)
      : chosen;
    const chosenImageUrl = httpUrlOrNull(imageVariant?.imageUrl);
    if (!isVideoVariant && !chosenImageUrl) {
      return { ok: false, status: 400, error: 'selected variant has no hosted image' };
    }

    const channels = normalizeChannels(
      toJson(run.channels, null) ?? input.channels ?? preview.inputs?.channels
    );
    if (!channels.length) return { ok: false, status: 400, error: 'run has no publishable channels' };

    const city = run.city || preview.inputs?.city || input.city;
    const gbpLocationId = preview.inputs?.locationId || locationForCity(city).id;

    // Retry of a partially-published approval: channels that already posted in
    // a PRIOR attempt (recorded on the run's publish_result) are skipped this
    // time — a video failure after a GBP success retries WITHOUT double-posting
    // GBP, and a half-posted FB+IG pair retries only the missing platform. GBP
    // posts per-location but is treated as one channel: any location success
    // skips it (re-posting the succeeded locations would duplicate).
    const priorPlatforms = Array.isArray(priorRecordFull?.platforms) ? priorRecordFull.platforms : [];
    const alreadyPosted = new Set(priorPlatforms.filter((p) => p?.success).map((p) => p?.platform));
    const remainingChannels = channels.filter((channel) => !alreadyPosted.has(channel));

    // Nothing left to attempt → assess purely from the record (defensive; a
    // fully-posted run normally finalizes on the attempt that completed it).
    // The liveness gate above is a snapshot; the lock closes its TOCTOU
    // against the reconcile stamping the source review mid-approval.
    // allowConsumedByRunId: a PARTIAL prior attempt stamps this run as the
    // owner of the testimonial — only this run's retry may publish the
    // remaining channels past its own stamp; every other run is consumed.
    // Milestone drafts take the fleet-stats lease instead (see
    // publishWithFleetStatsLease) — the drift re-check and the post happen
    // with the stats sync excluded.
    const withPublishLock = (fn) => (input.milestone
      ? publishWithFleetStatsLease(input, fn, run.id)
      : publishWithReviewLivenessLock(sourceReviewId, fn, { rejectConsumed: true, allowConsumedByRunId: run.id }));
    const publishOutcome = remainingChannels.length
      ? await withPublishLock(() => SocialMediaService.publishToAll({
        title: run.topic || preview.inputs?.topic || 'Waves update',
        description: run.service || preview.inputs?.service || '',
        link: preview.suggestedLink,
        guid: `${AUTONOMOUS_SOURCE}_approved_${run.id}`,
        source: AUTONOMOUS_SOURCE,
        customContent: preview.drafts,
        channels: remainingChannels,
        imageUrl: chosenImageUrl,
        // ONLY the run-level deterministic GBP card — never the per-variant
        // gbpImageUrl. Post-deploy, creative variants carry no GBP URL at all
        // (wantsGbp:false), so a variant-level value can only be a LEGACY
        // pre-deploy AI 4:3 scene queued in an old draft — reading it would
        // publish AI imagery to GBP on approval. publishToAll posts GBP
        // text-only when the card is absent.
        gbpImageUrl: httpUrlOrNull(preview.visual?.gbpImageUrl),
        gbpImageBranded: true, // stored deterministic card — already logo'd
        videoUrl: chosenVideoUrl,
        noAiImage: true, // stored visual only — never a fresh literal AI image
        gbpLocationIds: [gbpLocationId],
        postId: run.social_media_post_id || null,
        // Durable stamp at the FIRST provider success — mirrors the
        // autonomous path; the post-publish stamp below is the no-op backstop.
        onFirstPlatformSuccess: input.reviewGraphic?.googleReviewId && !SOCIAL_FLAGS.dryRun
          ? () => recordTestimonialPublished(input.reviewGraphic.googleReviewId, run.id)
          : null,
      }))
      : { blocked: false, result: { success: false, platforms: [], note: 'all requested channels already posted in a prior attempt' }, releaseClaim: async () => {}, abandonClaim: () => {} };
    if (publishOutcome.blocked) {
      return {
        ok: false,
        status: 409,
        error: publishOutcome.driftReason
          ? publishOutcome.driftReason
          : publishOutcome.lockBusy
          ? (input.milestone
            ? 'review stats sync is in progress — approve again in a moment'
            : 'review sync is in progress for this location — approve again in a moment')
          : publishOutcome.consumed
            ? 'this review was already published as a testimonial by another run'
            : publishOutcome.missing
              ? 'source Google review no longer exists — testimonial cannot be published'
              : 'source Google review has been removed from Google — testimonial cannot be published',
      };
    }
    const publishResult = publishOutcome.result;
    // Claim held through the durable published stamp below (see
    // publishWithReviewLivenessLock) — released in the finally UNLESS the
    // stamp failed after a live publish, where the claim is retained and
    // the detached recovery loop owns its release.
    let claimRetained = false;
    try {

    // A VIDEO approval only finalizes when the video itself posted AND no
    // requested Meta channel is left attempted-but-failed (see
    // assessApprovalPublish) — a GBP-only success can't consume the draft, and
    // an FB-posted/IG-failed split stays retryable for Instagram alone.
    const assessment = assessApprovalPublish({
      isVideoVariant,
      channels,
      priorPlatforms,
      current: publishResult,
    });
    // Stamp the approval's variant identity onto the stored record — the lock
    // above reads it so retries can't switch creative mid-publish.
    assessment.mergedPublishResult.approval = {
      variantIndex: idx,
      type: isVideoVariant ? 'video' : 'image',
      conceptKey: chosen.conceptKey || null,
    };
    const published = assessment.complete && !SOCIAL_FLAGS.dryRun;

    // DURABLE published stamp on the FIRST successful external post — on
    // ANY success, not only completion: a partial attempt (Facebook posted,
    // Instagram failed) already put this testimonial live externally, and
    // without the stamp the review stayed selectable by other runs while
    // this run remained retryable. The stamp records THIS run as owner, so
    // only this run's retry passes the consumed check for its remaining
    // channels. Stamp failure retains the claim — recovery loop writes it.
    if (input.reviewGraphic?.googleReviewId && !SOCIAL_FLAGS.dryRun && assessment.mergedPublishResult.success) {
      try {
        await recordTestimonialPublished(input.reviewGraphic.googleReviewId, run.id);
      } catch (err) {
        logger.error(`[studio] testimonial-published stamp FAILED after approval publish (review ${input.reviewGraphic.googleReviewId}): ${err.message} — claim retained, recovery loop will write the durable record`);
        claimRetained = true;
        // Intentional fire-and-forget — the helper attaches its own terminal
        // catch and the claim self-expires if the process dies mid-loop.
        void holdClaimUntilPublishRecorded({
          googleReviewId: input.reviewGraphic.googleReviewId,
          record: () => recordTestimonialPublished(input.reviewGraphic.googleReviewId, run.id),
          claim: publishOutcome,
        });
      }
    }

    // publishToAll's postId update wrote only THIS attempt's results to the
    // post-history row; overwrite with the merged cross-attempt record so
    // admin history and the per-platform failure alerting keep the earlier
    // successes (e.g. attempt-1 Facebook video + retry Instagram Reel).
    if (run.social_media_post_id && remainingChannels.length && priorPlatforms.length) {
      const mergedContent = {};
      for (const p of assessment.mergedPublishResult.platforms) {
        if (p?.content) mergedContent[p.location ? `${p.platform}_${p.location}` : p.platform] = p.content;
      }
      await db('social_media_posts')
        .where({ id: run.social_media_post_id })
        .update({
          platforms_posted: JSON.stringify(assessment.mergedPublishResult.platforms),
          // publishToAll derived the row status from THIS attempt alone, so a
          // no-success retry (IG failed/skipped while attempt-1's FB video is
          // already live) just flipped a live post to 'failed'. Re-derive from
          // the merged record: any cross-attempt success = 'published' — the
          // same any-success rule publishToAll itself applies. (published_at
          // was already stamped by the attempt that first succeeded.)
          ...(assessment.mergedPublishResult.success ? { status: 'published' } : {}),
          ...(Object.keys(mergedContent).length ? { published_content: JSON.stringify(mergedContent) } : {}),
        })
        .catch(() => null);
    }

    // Graphic bookkeeping on completion — admin history and the saved-
    // graphics list. The durable stamp above already blocks reselection
    // from the first success, so a failure here is loud but does not need
    // to hold the claim. No hasTable pre-gate: createReviewGraphic fails
    // loudly when the table is unreachable instead of silently skipping.
    if (published && input.reviewGraphic?.googleReviewId) {
      await persistReviewGraphicWithRetry({
        googleReviewId: input.reviewGraphic.googleReviewId,
        privacyMode: input.reviewGraphic.privacyMode || 'first_name_city',
        templateKey: preview.visual?.templateKey || 'waves_clean_square',
        channels,
        status: 'approved',
        imageUrl: chosenImageUrl,
      }).catch((err) => {
        logger.error(`[studio] review-graphic bookkeeping FAILED after approval publish (review ${input.reviewGraphic.googleReviewId}): ${err.message} — graphic record missing from admin history; reselection stays durably blocked by the published stamp`);
        return null;
      });
    }

    // Promote the chosen variant to the run's primary visual so the audit list
    // shows what actually published. A failed/dry-run attempt keeps the run in
    // draft_created (still approvable once the blocker clears) but records the
    // attempt for the audit trail. For a video approval the primary imageUrl
    // stays the still (thumbnails/GBP) and videoUrl records the published Reel.
    const approvedPreview = previewWithVisual(preview, {
      imageUrl: chosenImageUrl || preview.visual?.imageUrl,
      // Carry the deterministic GBP card forward — a failed attempt stays
      // draft_created and a RETRY re-reads preview.visual.gbpImageUrl; losing
      // it here would demote the retry's GBP post to text-only. Run-level
      // ONLY: a per-variant gbpImageUrl is a legacy pre-deploy AI scene.
      gbpImageUrl: preview.visual?.gbpImageUrl || null,
      variant: preview.visual?.variant || 'campaign',
      templateKey: preview.visual?.templateKey,
      creative: chosen.conceptKey ? { conceptKey: chosen.conceptKey, sceneModel: chosen.sceneModel || null } : preview.visual?.creative,
      variants,
      // Only stamp the Reel onto the run's visual when it actually shipped —
      // the audit row renders visual.videoUrl as "the published Reel".
      videoUrl: published ? chosenVideoUrl : null,
    });
    const updated = await updateAutonomousRun(run.id, {
      status: published ? 'published' : 'draft_created',
      preview: approvedPreview,
      // The MERGED record (prior successes + this attempt) — the next retry's
      // channel narrowing and the audit trail both read from it.
      publishResult: assessment.mergedPublishResult,
      socialMediaPostId: run.social_media_post_id,
      skipReason: published ? null
        : SOCIAL_FLAGS.dryRun ? 'approve ran in dry-run mode — not published'
        : assessment.success && !assessment.complete
          ? 'approve publish incomplete: the video has not posted on every requested Meta channel — a retry publishes only the missing channels'
          : 'approve publish failed: all platforms skipped or failed',
    });

    return { ok: true, published, dryRun: SOCIAL_FLAGS.dryRun, publishResult: assessment.mergedPublishResult, run: updated };
    } finally {
      if (!claimRetained) await publishOutcome.releaseClaim();
    }
    // recordHealth: false — per-run approval lock, not a scheduled job.
  }, { recordHealth: false });

  if (result?.skipped) {
    return { ok: false, status: 409, error: 'an approval for this run is already in progress' };
  }
  return result;
}

async function rejectAutonomousRun(runId, { reason } = {}) {
  if (!(await hasTable('social_content_studio_runs'))) {
    return { ok: false, status: 503, error: 'social_content_studio_runs table is unavailable' };
  }
  // SAME per-run lock as approve: a reject racing an in-flight approve would
  // otherwise read stale draft_created and mark the run rejected while the
  // approve is mid-publish on Meta/GBP — the finishing approve then flips the
  // "rejected" run to published and a draft the admin rejected is live anyway.
  // Serializing on the shared lock means the reject either runs first (and the
  // approve 409s on the status guard) or arrives during a publish and 409s here.
  const result = await runExclusive(`social_autonomous_approve_${runId}`, async () => {
    const run = await db('social_content_studio_runs')
      .where({ id: runId, run_type: 'autonomous' })
      .first()
      .catch(() => null); // malformed :id → 404, not a 500
    if (!run) return { ok: false, status: 404, error: 'autonomous run not found' };
    if (run.status !== 'draft_created') {
      return { ok: false, status: 409, error: `run is '${run.status}' — only draft_created runs can be rejected` };
    }
    // A partially-published approval (some platform already posted, e.g. GBP
    // went out before the video failed) can NOT be rejected — marking it
    // rejected would hide LIVE external posts behind a rejected draft. The
    // path forward is retrying the approval (which narrows to the missing
    // channels) or removing the live posts manually first.
    const priorPlatforms = toJson(run.publish_result, {})?.platforms;
    const postedPlatforms = (Array.isArray(priorPlatforms) ? priorPlatforms : [])
      .filter((p) => p?.success)
      .map((p) => (p.location ? `${p.platform}/${p.location}` : p.platform));
    if (postedPlatforms.length) {
      return {
        ok: false,
        status: 409,
        error: `this run has already posted to ${Array.from(new Set(postedPlatforms)).join(', ')} — it cannot be rejected; retry the approval to finish publishing, or remove the live posts manually first`,
      };
    }
    const note = cleanText(reason, 300);
    const updated = await updateAutonomousRun(run.id, {
      status: 'rejected',
      skipReason: note ? `rejected by admin: ${note}` : 'rejected by admin',
      socialMediaPostId: run.social_media_post_id,
    });
    if (run.social_media_post_id) {
      await db('social_media_posts')
        .where({ id: run.social_media_post_id })
        .update({ status: 'rejected' })
        .catch(() => null);
    }
    return { ok: true, run: updated };
    // recordHealth: false — per-run approval lock, not a scheduled job.
  }, { recordHealth: false });
  if (result?.skipped) {
    return { ok: false, status: 409, error: 'an approval for this run is in progress — retry once it finishes' };
  }
  return result;
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
      // Never offer a review Google has removed as marketing material.
      .whereNull('gr.missing_since')
      // Never re-offer a review already published as a testimonial — the
      // durable stamp survives review_graphics bookkeeping failures, so
      // this exclusion holds even when no rg row exists.
      .whereNull('gr.testimonial_published_at')
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

/**
 * Post-publish bookkeeping wrapper: createReviewGraphic consumes the review
 * from the candidate queue, and a swallowed failure here means the
 * testimonial is live externally with nothing consuming the candidate — a
 * later autonomous run would publish the SAME review again. Lock contention
 * (a sync cycle holding the location lock right after publish) is the
 * expected transient, so retry through it; sync cycles run seconds, not
 * minutes. Non-busy errors propagate to the caller's handling.
 */
async function persistReviewGraphicWithRetry(input, { attempts = 6, delayMs = 10000 } = {}) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await createReviewGraphic(input);
    } catch (err) {
      if (err?.code !== 'SYNC_LOCK_BUSY' || attempt >= attempts) throw err;
      logger.info(`[studio] review-graphic persist deferred by location sync lock (attempt ${attempt}/${attempts}) — retrying in ${delayMs / 1000}s`);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

const CLAIM_RECOVERY_ATTEMPTS = 60;
const CLAIM_RECOVERY_DELAY_MS = 60 * 1000;

/**
 * Stamp the DURABLE testimonial-published marker on the source review —
 * first-win, one conditional UPDATE, executed the moment any external
 * channel successfully posts the review. This is the record that outlives
 * bookkeeping failures and process crashes: candidate selection excludes
 * stamped rows and the publish-time consumed check rejects them (except
 * the owning run retrying its remaining channels). Throws on DB failure —
 * the caller retains the publish claim and hands recovery to
 * holdClaimUntilPublishRecorded. Idempotent for the owner: an existing
 * own-run stamp is success; a FOREIGN stamp is logged loudly (it means
 * two publishers raced through a crash-expired claim) but still returns —
 * the durable protection is in place either way.
 */
async function recordTestimonialPublished(googleReviewId, runToken) {
  const stamped = await db('google_reviews')
    .where({ id: googleReviewId })
    .whereNull('testimonial_published_at')
    .update({
      testimonial_published_at: new Date().toISOString(),
      testimonial_published_run: runToken == null ? null : String(runToken),
    });
  if ((Array.isArray(stamped) ? stamped.length : stamped) > 0) return;
  const row = await db('google_reviews').where({ id: googleReviewId }).first();
  if (!row) return; // review row gone — nothing selectable remains to guard
  if (row.testimonial_published_at
    && String(row.testimonial_published_run) !== String(runToken == null ? null : runToken)) {
    logger.error(`[studio] testimonial-published stamp for review ${googleReviewId} already owned by run ${row.testimonial_published_run} (this publisher: ${runToken}) — two publishers posted this review; investigate the claim window`);
  }
}

/**
 * Detached post-publish recovery: the testimonial is LIVE externally but the
 * durable published stamp failed to write, so nothing durable stops a later
 * run from re-selecting and double-publishing the same review. The caller
 * RETAINS the publish claim (its heartbeat keeps renewing, which blocks
 * competitor acquisition and defers reconcile stamping) and this loop owns
 * the claim's release: it keeps retrying `record` until the durable record
 * lands, then releases. It releases early when the review is stamped
 * removed or deleted — stamped rows are excluded from every candidate and
 * approve surface, so no reselection risk remains. An unreadable review
 * keeps the claim held (never release on unverifiable state). If recovery
 * exhausts its attempts (~1h of a DB that cannot take one UPDATE), the
 * claim is ABANDONED rather than cleared: it self-expires within one TTL,
 * and was never actively released while unrecorded. Crash caveat (same as
 * the claim design itself): process death in the stamp-failed window lets
 * the claim expire with no durable record — the error logs are the
 * operator signal.
 */
function holdClaimUntilPublishRecorded({
  googleReviewId,
  record,
  claim,
  attempts = CLAIM_RECOVERY_ATTEMPTS,
  delayMs = CLAIM_RECOVERY_DELAY_MS,
}) {
  const loop = async () => {
    for (let attempt = 1; attempt <= attempts; attempt++) {
      await new Promise((resolve) => { const t = setTimeout(resolve, delayMs); t.unref?.(); });
      let review; let readOk = true;
      try {
        review = await db('google_reviews').where({ id: googleReviewId }).first();
      } catch { readOk = false; }
      if (readOk && (!review || review.missing_since)) {
        logger.info(`[studio] claim recovery: review ${googleReviewId} is ${review ? 'stamped removed' : 'deleted'} — excluded from every candidate surface, no reselection risk; releasing claim`);
        await claim.releaseClaim();
        return;
      }
      if (!readOk) continue; // can't verify liveness — keep holding, retry next tick
      try {
        await record();
        logger.info(`[studio] claim recovery: durable publish record landed for review ${googleReviewId} on attempt ${attempt} — releasing claim`);
        await claim.releaseClaim();
        return;
      } catch (err) {
        logger.warn(`[studio] claim recovery attempt ${attempt}/${attempts} for review ${googleReviewId} failed: ${err.message}`);
      }
    }
    logger.error(`[studio] claim recovery EXHAUSTED for review ${googleReviewId} — abandoning the claim (self-expires within ${Math.round(PUBLISH_CLAIM_MS / 60000)} minutes). The published testimonial has NO durable record and may be re-selected by a later run — investigate google_reviews writes`);
    claim.abandonClaim();
  };
  // Detached promise — never let a rejection escape unhandled.
  return loop().catch((err) => {
    logger.error(`[studio] claim recovery loop crashed for review ${googleReviewId}: ${err.message} — abandoning the claim`);
    claim.abandonClaim();
  });
}

async function createReviewGraphic(input) {
  if (!(await hasTable('review_graphics'))) throw new Error('review_graphics table is not available');
  const review = await db('google_reviews').where({ id: input.googleReviewId }).first();
  if (!review) throw new Error('Google review not found');
  // The card/copy is labeled a 5-star Google review, so enforce the same
  // eligibility the list endpoint uses — a caller can't render a misleading
  // graphic from a lower-rated, blank, or stats-sentinel review.
  if (Number(review.star_rating) !== 5
    || !String(review.review_text || '').trim()
    || review.reviewer_name === '_stats'
    // Mirror the candidate query: a review Google removed must not become a
    // "current Google review" marketing card, even by direct ID.
    || review.missing_since) {
    throw new Error('Review is not eligible for a 5-star graphic (requires star_rating=5, non-empty review text, and the review still live on Google)');
  }
  const candidate = buildReviewGraphicCandidate(review, input);
  // image_url is persisted then rendered as an <a href>/<img src> in the admin
  // UI, so a caller-supplied override must be an http(s) URL — never a
  // javascript:/data: link. Anything else falls back to the rendered card.
  const imageUrl = httpUrlOrNull(input.imageUrl) || await renderReviewGraphicImageUrl(candidate);
  // Refuse to create a graphic with no image. listReviewGraphicCandidates
  // excludes any review that already has a review_graphics row, so inserting a
  // null-image row (e.g. when S3/CDN/sharp render failed) would consume the
  // review from the candidate queue forever and leave an approvable-but-blank
  // draft. Fail loudly instead so the caller can retry once rendering works.
  if (!imageUrl) {
    throw new Error('Review graphic image could not be rendered (check S3/CDN config); refusing to create a graphic without an image');
  }
  const row = {
    google_review_id: candidate.googleReviewId,
    status: input.status || 'draft',
    privacy_mode: candidate.privacyMode,
    reviewer_display_name: candidate.reviewerDisplayName,
    location_id: candidate.locationId,
    city: candidate.city,
    // The excerpt is the verbatim review text rendered on a "5-star Google
    // review" card, so it MUST come from the stored review (candidate.excerpt
    // = reviewExcerpt(review.review_text)) — never a caller-supplied override,
    // which would let an admin paint arbitrary words as a real review.
    excerpt: cleanText(candidate.excerpt, 500),
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

  // The render/upload above can take seconds — long enough for the hourly
  // sync to stamp the review removed. Re-check and persist ATOMICALLY under
  // the per-location sync advisory lock: the row-level FOR UPDATE alone only
  // serializes against the stamping UPDATE, but a sync cycle that already
  // FETCHED a snapshot without this review could stamp it right after this
  // persist commits — and callers can pass status:'approved' directly, so
  // the persisted row would skip the advisory-locked approve gates. Sharing
  // gbp-review-sync:<loc> (the lock the sync holds across fetch→reconcile)
  // closes that window; a stamp committed first is seen here (abort), and a
  // busy lock defers the persist with a retryable error.
  const outcome = await runExclusive(`gbp-review-sync:${candidate.locationId}`, async () => db.transaction(async (trx) => {
    const fresh = await trx('google_reviews')
      .where({ id: input.googleReviewId })
      .forUpdate()
      .first();
    if (!fresh || fresh.missing_since) {
      throw new Error('Review was removed from Google while the graphic rendered — refusing to persist it');
    }
    const [saved] = await trx('review_graphics')
      .insert({ ...row, created_at: new Date() })
      .onConflict(['google_review_id', 'template_key'])
      .merge(row)
      .returning('*');
    return saved;
  }), { recordHealth: false });
  if (outcome?.skipped) {
    const busy = new Error('Review sync is in progress for this location — retry creating the graphic in a moment');
    busy.code = 'SYNC_LOCK_BUSY';
    throw busy;
  }
  const graphic = outcome;
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
      // Insert-only: never .merge() over an existing row. Re-running this must
      // not clobber admin edits to a seeded profile (rank/notes/active) — it
      // only backfills profiles that don't exist yet.
      .onConflict('company_name')
      .ignore();
  }
}

async function listCompetitorSwipeFile() {
  const hasProfiles = await hasTable('competitor_social_profiles');
  const hasPosts = await hasTable('competitor_social_posts');
  // Read-only endpoint: never write here. Seeding runs only on studio writes
  // (createCompetitorPost, gated by requireStudioEnabled), so the kill switch
  // truly blocks all studio DB writes. Until a row exists, fall back to the
  // in-memory seed list for display.
  let profiles = FASTEST_RISER_PROFILES;
  if (hasProfiles) {
    const rows = await db('competitor_social_profiles')
      .where({ active: true })
      .select('*')
      .orderBy('growth_pct', 'desc')
      .limit(50);
    if (rows.length) profiles = rows;
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
      profile_url: httpUrlOrNull(input.profileUrl),
      post_url: httpUrlOrNull(input.postUrl),
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
  publishWithReviewLivenessLock,
  holdClaimUntilPublishRecorded,
  recordTestimonialPublished,
  CHANNELS,
  DEFAULT_COMPETITOR_PATTERNS,
  FASTEST_RISER_PROFILES,
  PEST_VERSUS_PAIRS,
  SEASONAL_AUTONOMOUS_TOPICS,
  buildVersusCardInput,
  buildVersusDrafts,
  selectAutonomousVersusPlan,
  MILESTONE_WINDOW,
  buildMilestoneCardInput,
  buildMilestoneDrafts,
  milestoneThresholdFor,
  milestoneDrift,
  fleetReviewStats,
  planMilestone,
  selectAutonomousMilestonePlan,
  approveAutonomousRun,
  assessApprovalPublish,
  autonomousStatus,
  buildCampaignCardInput,
  buildCampaignDrafts,
  buildCampaignDraftsAI,
  campaignFactPack,
  buildReviewCardInput,
  buildReviewGraphicCandidate,
  normalizePublishMode,
  createCompetitorPost,
  createReviewGraphic,
  engagementScore,
  httpUrlOrNull,
  normalizeChannels,
  getCampaignContext,
  mentionsOtherCity,
  contentRowMatchesCity,
  listCompetitorSwipeFile,
  listAutonomousRuns,
  listReviewGraphicCandidates,
  previewCampaign,
  privacyDisplayName,
  recentCreativeConceptKeys,
  rejectAutonomousRun,
  reviewExcerpt,
  serviceIntentKeywords,
  runAutonomous,
  saveCampaignDraft,
  serializeAutonomousRun,
  selectAutonomousCampaign,
  validateDrafts,
};
