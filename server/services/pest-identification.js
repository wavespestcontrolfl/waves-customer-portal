/**
 * Pest Identification Service
 *
 * Dual-vision (Claude + Gemini) species/category identification from prospect
 * photos, for the public pest-identifier funnel and the admin assessment view.
 *
 * Trust model mirrors the lawn diagnostic stack:
 *  - Model output NEVER reaches a prospect directly. Every customer-facing
 *    label, blurb, and safety flag comes from the fixed PEST_LIBRARY allowlist
 *    below; an unmatched identification degrades to a generic category label.
 *  - Confidence gates naming: only a high-confidence, library-matched,
 *    model-agreeing ID names a pest plainly; moderate reads "likely", low
 *    reads as a category ("an ant species") with an in-person confirm.
 *  - Termite/WDO photo ID is SUGGESTIVE ONLY: the library forces
 *    inspection_required and copy that routes to a free inspection. Photo ID
 *    must never read like a WDO inspection finding.
 *
 * Vision goes to MODELS.VISION (Claude) + the Gemini vision scorer directly —
 * the same pattern as lawn-assessment.js. Vision does NOT route through
 * llm/deep.js (DEEP is text-only lanes; VISION keeps temperature support).
 */

const logger = require('./logger');
const MODELS = require('../config/models');
const {
  safePublicFirstName,
  safePublicCity,
  sanitizePricingSnapshot,
} = require('../utils/public-report-egress');

let Anthropic;
try { Anthropic = require('@anthropic-ai/sdk'); } catch { Anthropic = null; }

const GEMINI_KEY = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '';
const GEMINI_VISION_MODEL = process.env.GEMINI_VISION_MODEL || MODELS.GEMINI_VISION_BEST;
const GEMINI_VISION_FALLBACK_MODEL = process.env.GEMINI_VISION_FALLBACK_MODEL || 'gemini-2.5-flash';

const CATEGORIES = ['insect', 'arachnid', 'rodent', 'wildlife', 'other', 'not_a_pest'];
const CONFIDENCES = ['low', 'moderate', 'high'];
const URGENCIES = ['low', 'moderate', 'high'];

// ── The customer-facing allowlist ───────────────────────────────────────────
// Every customer-visible label/blurb comes from here. service_key maps to the
// pricing-engine service the funnel can price ('pest' | 'mosquito' | 'flea' |
// 'lawnPestControl'); null service_key = inspection-first, never auto-priced.
// group → generic label used when the match is low-confidence or absent.

const GROUP_GENERIC = {
  ants: 'an ant species',
  roaches: 'a cockroach species',
  termites: 'signs consistent with termite activity',
  spiders: 'a spider',
  stinging: 'a stinging insect',
  mosquitoes: 'a mosquito',
  lawn_pests: 'a turf-damaging insect',
  fleas_ticks: 'a flea or tick',
  bed_bugs: 'signs consistent with bed bugs',
  occasional: 'an occasional invader',
  rodents: 'signs consistent with rodent activity',
  tree_shrub_pests: 'a plant-feeding insect',
  wildlife: 'a wildlife visitor',
};

const CATEGORY_GENERIC = {
  insect: 'an insect',
  arachnid: 'a spider or other arachnid',
  rodent: 'signs consistent with rodent activity',
  wildlife: 'a wildlife visitor',
  other: 'something we want a closer look at',
  not_a_pest: 'nothing to worry about',
};

function entry(slug, label, group, category, opts = {}) {
  return {
    slug,
    label,
    group,
    category,
    aliases: opts.aliases || [],
    service_line: opts.service_line || 'pest',
    service_key: opts.service_key !== undefined ? opts.service_key : 'pest',
    service_label: opts.service_label || 'General Pest Control',
    urgency: opts.urgency || 'moderate',
    safety: {
      stinging: !!opts.stinging,
      venomous: !!opts.venomous,
      disease_vector: !!opts.disease_vector,
      structural_threat: !!opts.structural,
    },
    inspection_required: !!opts.inspection_required,
    customer_blurb: opts.blurb || '',
    tech_notes: opts.tech_notes || '',
  };
}

const PEST_LIBRARY = [
  // Ants
  entry('ghost-ant', 'Ghost Ants', 'ants', 'insect', {
    aliases: ['ghost ant', 'sugar ant', 'tapinoma'],
    urgency: 'moderate',
    blurb: 'Ghost ants are tiny, fast-moving ants that trail to moisture and sweets indoors. They nest in wall voids and potted plants, and colonies split easily — which is why sprays alone usually make them worse.',
    tech_notes: 'Confirm pale abdomen/legs vs bigheaded. Baiting program, no repellent sprays. Locate moisture sources; check potted plants and window sills.',
  }),
  entry('fire-ant', 'Fire Ants', 'ants', 'insect', {
    aliases: ['red imported fire ant', 'rifa', 'fire ants'],
    stinging: true, venomous: true, urgency: 'high',
    blurb: 'Fire ants build mounds in sunny turf and sting in numbers when disturbed. Stings matter for kids and pets, so we treat these as a priority.',
    tech_notes: 'Confirm mound structure + two-node workers of varied size. Broadcast bait + mound drench per label. Flag electrical boxes/AC pads.',
  }),
  entry('carpenter-ant', 'Carpenter Ants', 'ants', 'insect', {
    aliases: ['carpenter ant', 'camponotus', 'bull ant'],
    structural: true, urgency: 'moderate', inspection_required: true,
    blurb: 'Carpenter ants are large ants that nest in damp or damaged wood. They don’t eat wood like termites, but a nest is a sign of a moisture problem worth finding.',
    tech_notes: 'Large, single node, evenly rounded thorax. Night-trail to nest; check frass kick-out, moisture-damaged wood, attic/soffit lines.',
  }),
  entry('bigheaded-ant', 'Bigheaded Ants', 'ants', 'insect', {
    aliases: ['big headed ant', 'big-headed ant', 'pheidole'],
    urgency: 'moderate',
    blurb: 'Bigheaded ants leave sandy trails along patios, driveways, and baseboards and are one of the most common ant invaders in Southwest Florida.',
    tech_notes: 'Dimorphic workers (major head). Soil/foam trails at slab edges. Granular bait + non-repellent perimeter.',
  }),
  // Roaches
  entry('american-roach', 'American Cockroaches (Palmetto Bugs)', 'roaches', 'insect', {
    aliases: ['american cockroach', 'palmetto bug', 'palmetto', 'waterbug', 'water bug'],
    disease_vector: true, urgency: 'moderate',
    blurb: 'The classic Florida "palmetto bug" — a large outdoor roach that wanders inside from mulch, palms, and drains. Occasional sightings respond very well to an exterior program.',
    tech_notes: 'Reddish, yellow pronotum band, strong flier. Source: mulch beds, palm boots, sewer/drain lines. Exterior-first program + dewebbing entry points.',
  }),
  entry('german-roach', 'German Cockroaches', 'roaches', 'insect', {
    aliases: ['german cockroach', 'blattella germanica'],
    disease_vector: true, urgency: 'high', inspection_required: true,
    service_label: 'German Roach Cleanout',
    service_key: null,
    blurb: 'German roaches breed indoors — kitchens and bathrooms — and multiply fast. This is one to treat quickly with a dedicated cleanout, not store-bought sprays that scatter them.',
    tech_notes: 'Two pronotum stripes, nymphs banded. Gel bait + IGR cleanout, no repellents. Grade infestation level for cleanout pricing — always quote after inspection.',
  }),
  // Termites — suggestive only, always inspection-first
  entry('subterranean-termite', 'Subterranean Termite Activity', 'termites', 'insect', {
    aliases: ['subterranean termite', 'termite', 'termites', 'mud tube', 'mud tubes', 'termite swarmer', 'swarmers'],
    structural: true, urgency: 'high', inspection_required: true,
    service_line: 'termite', service_key: null, service_label: 'Termite Protection',
    blurb: 'What we’re seeing is consistent with subterranean termite activity — mud tubes, swarmers, or wings. A photo can’t confirm termites; a free in-person inspection can, usually within a day or two.',
    tech_notes: 'Photo ID is SUGGESTIVE ONLY — never report as a WDO finding. Verify tubes/frass/wings on-site; distinguish ant vs termite swarmer (waist, wing pairs, antennae).',
  }),
  entry('drywood-termite', 'Drywood Termite Activity', 'termites', 'insect', {
    aliases: ['drywood termite', 'frass', 'termite pellets', 'kick-out holes'],
    structural: true, urgency: 'high', inspection_required: true,
    service_line: 'termite', service_key: null, service_label: 'Termite Protection',
    blurb: 'The photo shows signs consistent with drywood termites — often the tell is small piles of pellet-like frass. Only an in-person inspection can confirm it, and ours are free.',
    tech_notes: 'Photo ID is SUGGESTIVE ONLY. Six-sided pellets vs carpenter-ant frass (fibrous). Map kick-out holes; check fascia, window frames, furniture.',
  }),
  // Spiders
  entry('black-widow', 'Widow Spiders', 'spiders', 'arachnid', {
    aliases: ['black widow', 'brown widow', 'widow spider', 'latrodectus'],
    venomous: true, urgency: 'high',
    blurb: 'Widow spiders (black and brown) favor undisturbed corners — meter boxes, patio furniture, garage clutter. Their bite is medically significant, so don’t handle them.',
    tech_notes: 'Confirm hourglass (red = black widow, orange on tan = brown widow) + spiky egg sac for brown widow. Deweb + void treatment; advise on clutter/storage.',
  }),
  entry('wolf-spider', 'Wolf Spiders', 'spiders', 'arachnid', {
    aliases: ['wolf spider', 'hunting spider'],
    urgency: 'low',
    blurb: 'Wolf spiders look alarming but are harmless hunters that wander in from turf and mulch. Regular exterior service keeps them (and what they eat) outside.',
    tech_notes: 'Eye arrangement (large center pair), no web. Indicates outdoor insect pressure — check door sweeps and turf insect activity.',
  }),
  // Stinging
  entry('paper-wasp', 'Paper Wasps', 'stinging', 'insect', {
    aliases: ['paper wasp', 'wasp', 'umbrella wasp', 'polistes'],
    stinging: true, venomous: true, urgency: 'moderate',
    blurb: 'Paper wasps build open, umbrella-shaped nests under eaves and lanai frames. A few around flowers is normal; a nest by a doorway is worth removing professionally.',
    tech_notes: 'Open-cell nest, dangling legs in flight. Treat at dusk; remove nest after knockdown. Check soffits, shutters, playsets.',
  }),
  entry('yellow-jacket', 'Yellowjackets', 'stinging', 'insect', {
    aliases: ['yellowjacket', 'yellow jacket', 'hornet', 'ground wasp'],
    stinging: true, venomous: true, urgency: 'high',
    blurb: 'Yellowjackets nest in the ground or in voids and defend the nest aggressively. Ground-nest stings send more people to urgent care than any other pest here — leave this one to us.',
    tech_notes: 'Confirm in/out traffic point before treating. Ground/void nests can be large; full suit. Never seal an active void entrance.',
  }),
  entry('honey-bee', 'Honey Bees', 'stinging', 'insect', {
    aliases: ['honey bee', 'honeybee', 'bee swarm', 'bees'],
    stinging: true, urgency: 'moderate', inspection_required: true, service_key: null,
    service_label: 'Bee Assessment & Referral',
    blurb: 'Honey bees are protected pollinators. A resting swarm usually moves on within a day or two; an established colony in a wall needs a specialist — we’ll help you figure out which you have.',
    tech_notes: 'Swarm vs established colony (comb visible, steady traffic). Florida rules favor live removal/relocation for colonies — refer per current bee protocol; do not treat a resting swarm.',
  }),
  // Mosquitoes
  entry('mosquito', 'Mosquitoes', 'mosquitoes', 'insect', {
    aliases: ['mosquito', 'mosquitoes', 'aedes'],
    disease_vector: true, urgency: 'moderate',
    service_line: 'mosquito', service_key: 'mosquito', service_label: 'Mosquito Control',
    blurb: 'Southwest Florida mosquitoes breed in as little as a bottle-cap of standing water. A monthly barrier program plus breeding-site cleanup makes evenings outside livable again.',
    tech_notes: 'In2Care/barrier program per protocol. Walk property for container breeding, bromeliads, drains, plant saucers.',
  }),
  // Lawn pests
  entry('chinch-bug', 'Chinch Bugs', 'lawn_pests', 'insect', {
    aliases: ['chinch bug', 'chinch', 'blissus'],
    urgency: 'high',
    service_line: 'lawn', service_key: 'lawnPestControl', service_label: 'Lawn Pest Control',
    blurb: 'Chinch bugs kill St. Augustine grass in expanding yellow-to-brown patches, usually starting in the sunniest, driest spots. Caught early, the lawn recovers; left alone, patches merge fast.',
    tech_notes: 'Float test at patch margin (not center). Distinguish drought stress — check irrigation coverage first. Treat margins outward per protocol.',
  }),
  entry('sod-webworm', 'Sod Webworms / Armyworms', 'lawn_pests', 'insect', {
    aliases: ['sod webworm', 'armyworm', 'army worm', 'webworm', 'lawn caterpillar', 'tropical sod webworm'],
    urgency: 'high',
    service_line: 'lawn', service_key: 'lawnPestControl', service_label: 'Lawn Pest Control',
    blurb: 'Lawn caterpillars chew St. Augustine blades down to a ragged, scalped look almost overnight in late summer. The lawn usually recovers well once they’re stopped.',
    tech_notes: 'Notched/ragged blades, green frass, moths at dusk. Soap flush to confirm larvae. Treat late afternoon; re-check 10–14 days.',
  }),
  entry('white-grub', 'White Grubs', 'lawn_pests', 'insect', {
    aliases: ['grub', 'grubs', 'white grub', 'beetle larva', 'may beetle larva'],
    urgency: 'moderate',
    service_line: 'lawn', service_key: 'lawnPestControl', service_label: 'Lawn Pest Control',
    blurb: 'White grubs feed on grass roots, so turf browns and lifts like loose carpet. Armadillos and birds digging at night are often the first clue.',
    tech_notes: 'Tug test — roots sheared. Cut-and-peel count per sq ft; treat over threshold per label; water-in required.',
  }),
  // Fleas / ticks
  entry('flea', 'Fleas', 'fleas_ticks', 'insect', {
    aliases: ['flea', 'fleas', 'ctenocephalides'],
    disease_vector: true, urgency: 'high',
    service_key: 'flea', service_label: 'Flea Treatment',
    blurb: 'Fleas hitchhike in on pets and wildlife and breed in carpet and shaded turf. The fix is treating the home and yard together, paired with a vet-recommended pet treatment.',
    tech_notes: 'IGR + adulticide inside/out; customer prep sheet mandatory (vacuum, wash bedding, pet treatment same week).',
  }),
  entry('tick', 'Ticks', 'fleas_ticks', 'arachnid', {
    aliases: ['tick', 'ticks', 'lone star tick', 'dog tick'],
    disease_vector: true, urgency: 'moderate',
    service_key: 'flea', service_label: 'Flea & Tick Treatment',
    blurb: 'Ticks wait in taller grass and landscape edges for a host to walk by. Yard treatment plus keeping edges trimmed cuts encounters dramatically.',
    tech_notes: 'ID species if possible (photo scale). Treat transition zones, fence lines, pet runs.',
  }),
  // Bed bugs
  entry('bed-bug', 'Bed Bug Signs', 'bed_bugs', 'insect', {
    aliases: ['bed bug', 'bedbug', 'bed bugs', 'cimex'],
    urgency: 'high', inspection_required: true, service_key: null,
    service_label: 'Bed Bug Inspection',
    blurb: 'What’s in the photo is consistent with bed bugs, but look-alikes are common. An in-person inspection confirms it and scopes the right treatment — don’t start throwing furniture out yet.',
    tech_notes: 'Confirm live bug/eggs/fecal spotting at seams. Grade rooms for treatment scope; quote after inspection only.',
  }),
  // Occasional invaders
  entry('silverfish', 'Silverfish', 'occasional', 'insect', {
    aliases: ['silverfish', 'firebrat'], urgency: 'low',
    blurb: 'Silverfish like humid, quiet spots — closets, garages, bathrooms. They’re harmless to people and respond well to routine pest service plus a little dehumidifying.',
    tech_notes: 'Moisture-driven; check garage/attic humidity. Covered under general pest program.',
  }),
  entry('earwig', 'Earwigs', 'occasional', 'insect', {
    aliases: ['earwig', 'pincher bug'], urgency: 'low',
    blurb: 'Earwigs wander in from damp mulch and leaf litter. The pincers look dramatic but they’re harmless — exterior treatment and dry entryways keep them out.',
    tech_notes: 'Moisture harborage at slab edge; adjust mulch line; exterior perimeter covers it.',
  }),
  entry('millipede', 'Millipedes', 'occasional', 'other', {
    aliases: ['millipede', 'millipedes'], urgency: 'low',
    blurb: 'Millipedes migrate indoors after heavy rain and usually dry out within a day. Exterior barrier treatment and door sweeps handle the seasonal waves.',
    tech_notes: 'Rain-driven migrations; check thresholds and garage seals.',
  }),
  entry('centipede', 'Centipedes', 'occasional', 'other', {
    aliases: ['centipede', 'house centipede'], venomous: true, urgency: 'low',
    blurb: 'Centipedes hunt other insects, so seeing them usually means there’s prey around. They can pinch but rarely do; routine service handles them and their food source.',
    tech_notes: 'Indicator species — look for the prey population.',
  }),
  entry('stink-bug', 'Stink Bugs', 'occasional', 'insect', {
    aliases: ['stink bug', 'stinkbug', 'shield bug'], urgency: 'low',
    blurb: 'Stink bugs are harmless plant feeders that sun themselves on warm walls and slip inside around windows. Exterior service and screen checks keep them out.',
    tech_notes: 'Seasonal; exclusion advice beats chemical answers indoors.',
  }),
  // Rodents
  entry('rodent', 'Rodent Activity', 'rodents', 'rodent', {
    aliases: ['rat', 'mouse', 'mice', 'roof rat', 'norway rat', 'rodent droppings', 'rat droppings', 'mouse droppings'],
    disease_vector: true, structural: true, urgency: 'high', inspection_required: true,
    service_line: 'rodent', service_key: null, service_label: 'Rodent Inspection & Exclusion',
    blurb: 'Droppings, gnaw marks, or a sighting like this points to rodent activity. The right fix starts with an inspection to find entry points — trapping without exclusion is a treadmill.',
    tech_notes: 'Dropping size/shape → species. Full exclusion walk (roof returns, AC chase, garage corners). Quote trapping + exclusion after inspection.',
  }),
  // Tree & shrub
  entry('whitefly', 'Whiteflies', 'tree_shrub_pests', 'insect', {
    aliases: ['whitefly', 'white fly', 'ficus whitefly'], urgency: 'moderate',
    service_line: 'tree_shrub', service_key: null, service_label: 'Tree & Shrub Care',
    blurb: 'Whiteflies cluster under leaves — ficus hedges especially — and leave sticky honeydew and sooty mold. Systemic tree & shrub treatments knock them out season-long.',
    tech_notes: 'Check leaf undersides; sooty mold = active honeydew. Systemic drench program; count/measure hedges for quote.',
  }),
  entry('aphid-scale', 'Aphids / Scale Insects', 'tree_shrub_pests', 'insect', {
    aliases: ['aphid', 'aphids', 'scale', 'scale insect', 'mealybug', 'sooty mold'], urgency: 'moderate',
    service_line: 'tree_shrub', service_key: null, service_label: 'Tree & Shrub Care',
    blurb: 'Aphids and scale sap plant vigor and leave the sticky residue that grows black sooty mold. Ornamental treatments clear them and let plants push clean new growth.',
    tech_notes: 'ID crawler stage for scale timing. Horticultural oil vs systemic per plant/label.',
  }),
  // Not a pest
  entry('lovebug', 'Lovebugs', 'occasional', 'not_a_pest', {
    aliases: ['lovebug', 'love bug', 'love bugs'], urgency: 'low', service_key: null,
    service_label: 'No Treatment Needed',
    blurb: 'Lovebugs are a twice-a-year Florida nuisance that no treatment prevents — they drift in from miles around. The good news: they’re harmless and the swarm season is short.',
    tech_notes: 'No treatment; set expectations honestly.',
  }),
  entry('beneficial', 'A Beneficial Species', 'occasional', 'not_a_pest', {
    aliases: ['ladybug', 'lady beetle', 'lacewing', 'dragonfly', 'praying mantis', 'mantis', 'earthworm', 'butterfly', 'moth', 'firefly', 'anole', 'lizard', 'gecko', 'frog', 'toad'],
    urgency: 'low', service_key: null, service_label: 'No Treatment Needed',
    blurb: 'Good news — this one’s on your side. It eats the insects you don’t want around, so it’s worth leaving alone.',
    tech_notes: 'Beneficial/no-treat; educate.',
  }),
];

const LIBRARY_BY_SLUG = new Map(PEST_LIBRARY.map((e) => [e.slug, e]));

function normalizeName(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z\s-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const ALIAS_INDEX = new Map();
for (const item of PEST_LIBRARY) {
  ALIAS_INDEX.set(normalizeName(item.label), item.slug);
  for (const alias of item.aliases) ALIAS_INDEX.set(normalizeName(alias), item.slug);
}

/**
 * Resolve a model-supplied free-text name to a library entry, or null.
 * Exact alias match first, then a contained-alias scan (longest alias wins) so
 * "eastern lubber grasshopper" doesn't false-match on a stray substring.
 */
function resolveLibraryMatch(name) {
  const normalized = normalizeName(name);
  if (!normalized) return null;
  // Exact match, then naive singular/plural variants ("fire ant" ↔ "fire ants").
  const variants = [normalized, `${normalized}s`, normalized.replace(/s$/, '')];
  for (const variant of variants) {
    const direct = variant && ALIAS_INDEX.get(variant);
    if (direct) return LIBRARY_BY_SLUG.get(direct);
  }

  let best = null;
  let bestLen = 0;
  for (const [alias, slug] of ALIAS_INDEX.entries()) {
    if (alias.length < 4) continue;
    if (normalized.includes(alias) && alias.length > bestLen) {
      best = slug;
      bestLen = alias.length;
    }
  }
  return best ? LIBRARY_BY_SLUG.get(best) : null;
}

function clampEnum(value, allowed, fallback = null) {
  const key = String(value || '').toLowerCase();
  return allowed.includes(key) ? key : fallback;
}

const VISION_PROMPT = `You are a pest identification tool for a professional pest control company in Southwest Florida (Manatee/Sarasota/Charlotte counties). Analyze the photo and return ONLY a JSON object:

{
  "best_match": "most likely common name, as specific as the photo supports (e.g. 'ghost ant', 'american cockroach', 'subterranean termite swarmer')",
  "alternates": ["up to 3 plausible alternative common names"],
  "category": "insect" | "arachnid" | "rodent" | "wildlife" | "other" | "not_a_pest",
  "confidence": "low" | "moderate" | "high",
  "distinguishing_features": ["visible features that drove the ID"],
  "not_a_pest": true | false,
  "observations": "one concise paragraph on what is visible, including size cues and context (indoors/outdoors, on plant, droppings, damage)"
}

Rules:
- Only claim "high" confidence when diagnostic features are clearly visible at usable resolution.
- If the photo shows DAMAGE or SIGNS (droppings, mud tubes, frass, chewed blades) rather than the animal itself, identify the sign (e.g. "mud tubes", "rodent droppings") and say so in observations.
- Termites vs ants: check waist, antennae, and wing pairs before claiming either; if not visible, keep confidence low.
- If it is a beneficial or harmless species (ladybug, lacewing, anole, dragonfly), set not_a_pest true and name it.
- If the photo is too blurry/dark/distant to identify, use category "other", confidence "low", best_match "unidentifiable".
- Never invent species not plausible in Florida.`;

async function callClaudeVision(base64Image, mimeType) {
  if (!Anthropic || !process.env.ANTHROPIC_API_KEY) return null;
  try {
    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const response = await anthropic.messages.create({
      model: MODELS.VISION,
      max_tokens: 500,
      temperature: 0.2, // match Gemini's 0.2 so the dual-vision merge compares like-for-like
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mimeType, data: base64Image } },
          { type: 'text', text: VISION_PROMPT },
        ],
      }],
    });
    const text = response.content?.[0]?.text;
    if (!text) { logger.warn('[pest-identification] Claude returned empty content'); return null; }
    return JSON.parse(text.replace(/```json|```/g, '').trim());
  } catch (err) {
    logger.error(`Pest identification Claude vision failed: ${err.message}`);
    return null;
  }
}

async function geminiVisionAttempt(model, base64Image, mimeType) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_KEY}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{
        parts: [
          { inline_data: { mime_type: mimeType, data: base64Image } },
          { text: VISION_PROMPT },
        ],
      }],
      generationConfig: { temperature: 0.2, maxOutputTokens: 500 },
    }),
  });
  if (!response.ok) {
    logger.error(`Pest identification Gemini API ${response.status} (${model}): ${response.statusText}`);
    return null;
  }
  const data = await response.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) return null;
  return JSON.parse(text.replace(/```json|```/g, '').trim());
}

async function callGeminiVision(base64Image, mimeType) {
  if (!GEMINI_KEY) return null;
  const models = GEMINI_VISION_FALLBACK_MODEL && GEMINI_VISION_FALLBACK_MODEL !== GEMINI_VISION_MODEL
    ? [GEMINI_VISION_MODEL, GEMINI_VISION_FALLBACK_MODEL]
    : [GEMINI_VISION_MODEL];
  for (const model of models) {
    try {
      const parsed = await geminiVisionAttempt(model, base64Image, mimeType);
      if (parsed) return parsed;
    } catch (err) {
      logger.error(`Pest identification Gemini vision failed (${model}): ${err.message}`);
    }
  }
  return null;
}

const CONFIDENCE_RANK = { low: 0, moderate: 1, high: 2 };

function downgrade(confidence) {
  const rank = Math.max(0, (CONFIDENCE_RANK[confidence] ?? 0) - 1);
  return CONFIDENCES[rank];
}

function lowerConfidenceOf(a, b) {
  const ra = CONFIDENCE_RANK[a] ?? 0;
  const rb = CONFIDENCE_RANK[b] ?? 0;
  return CONFIDENCES[Math.min(ra, rb)];
}

/**
 * Merge one photo's two model results into a single per-photo identification.
 * Agreement (same library slug) keeps the ID at the models' LOWER confidence;
 * one-model-only results are downgraded a notch; slug disagreement collapses
 * to a category-level result at low confidence. Raw model text is preserved
 * only for the internal record, never for egress.
 */
function mergeModelResults(claude, gemini) {
  const results = [claude, gemini].filter(Boolean);
  if (!results.length) return null;

  const resolved = results.map((r) => ({
    raw: r,
    match: resolveLibraryMatch(r.best_match),
    confidence: clampEnum(r.confidence, CONFIDENCES, 'low'),
    category: clampEnum(r.category, CATEGORIES, 'other'),
    notAPest: r.not_a_pest === true || String(r.not_a_pest).toLowerCase() === 'true',
  }));

  const [a, b] = resolved;
  const observations = resolved.map((r) => r.raw.observations).filter(Boolean);
  const features = [...new Set(resolved.flatMap((r) => Array.isArray(r.raw.distinguishing_features) ? r.raw.distinguishing_features : []))].slice(0, 8);
  const alternates = [...new Set(resolved.flatMap((r) => Array.isArray(r.raw.alternates) ? r.raw.alternates : []))]
    .map((name) => resolveLibraryMatch(name))
    .filter(Boolean)
    .map((m) => m.slug);

  const base = { observations, distinguishing_features: features, alternate_slugs: alternates, model_count: resolved.length };

  if (resolved.length === 2) {
    if (a.match && b.match && a.match.slug === b.match.slug) {
      return { ...base, entry: a.match, confidence: lowerConfidenceOf(a.confidence, b.confidence), category: a.match.category, agreement: 'match' };
    }
    if (a.match && b.match) {
      // Same group (e.g. two different ant species) keeps the group at reduced
      // confidence; different groups entirely collapse to category-generic.
      if (a.match.group === b.match.group) {
        const preferred = CONFIDENCE_RANK[a.confidence] >= CONFIDENCE_RANK[b.confidence] ? a.match : b.match;
        return { ...base, entry: preferred, confidence: 'low', category: preferred.category, agreement: 'group' };
      }
      const category = a.category === b.category ? a.category : 'other';
      return { ...base, entry: null, confidence: 'low', category, agreement: 'conflict' };
    }
    const single = a.match ? a : (b.match ? b : null);
    if (single) {
      return { ...base, entry: single.match, confidence: downgrade(single.confidence), category: single.match.category, agreement: 'single_model' };
    }
    const category = a.category === b.category ? a.category : 'other';
    const notAPest = a.notAPest && b.notAPest;
    return { ...base, entry: null, confidence: 'low', category: notAPest ? 'not_a_pest' : category, agreement: 'unmatched' };
  }

  // One model only (the other unavailable): downgrade its confidence.
  const only = resolved[0];
  if (only.match) {
    return { ...base, entry: only.match, confidence: downgrade(only.confidence), category: only.match.category, agreement: 'single_model' };
  }
  return { ...base, entry: null, confidence: 'low', category: only.notAPest ? 'not_a_pest' : only.category, agreement: 'unmatched' };
}

/**
 * Cross-photo aggregation: the most-supported library entry wins the vote.
 * Unmatched photos count too — one that resolved to no entry but a
 * CONTRADICTING category (or not-a-pest) disputes the winner just like a
 * rival species vote (→ contested, which the egress layer collapses to a
 * generic label); an inconclusive photo (category 'other', or the winner's
 * own category — e.g. one sharp shot + one blurry one) doesn't dispute the
 * ID but caps confidence at moderate so a mixed upload can never publish a
 * plainly-named species.
 */
function aggregateIdentification(perPhoto) {
  const votes = new Map();
  for (const result of perPhoto) {
    if (!result.entry) continue;
    const tally = votes.get(result.entry.slug) || { entry: result.entry, count: 0, best: 'low' };
    tally.count += 1;
    if (CONFIDENCE_RANK[result.confidence] > CONFIDENCE_RANK[tally.best]) tally.best = result.confidence;
    votes.set(result.entry.slug, tally);
  }

  if (!votes.size) {
    const categories = perPhoto.map((r) => r.category);
    const notAPest = categories.every((c) => c === 'not_a_pest');
    return {
      entry: null,
      confidence: 'low',
      category: notAPest ? 'not_a_pest' : (categories.find((c) => c !== 'other') || 'other'),
      contested: false,
    };
  }

  const ranked = [...votes.values()].sort((x, y) => y.count - x.count || CONFIDENCE_RANK[y.best] - CONFIDENCE_RANK[x.best]);
  const winner = ranked[0];
  const unmatched = perPhoto.filter((result) => !result.entry);
  const contradicting = unmatched.some((result) => result.category === 'not_a_pest'
    || (result.category !== 'other' && result.category !== winner.entry.category));
  const inconclusive = unmatched.length > 0 && !contradicting;
  const contested = ranked.length > 1 || contradicting;
  return {
    entry: winner.entry,
    confidence: (contested || inconclusive) ? lowerConfidenceOf(winner.best, 'moderate') : winner.best,
    category: winner.entry.category,
    contested,
  };
}

/**
 * Identify from a set of photos (the funnel sends 1–5 of the same subject).
 * Per-photo dual-vision, then a cross-photo vote: the most-supported library
 * entry wins; cross-photo disagreement caps confidence at moderate.
 */
async function identifyPest(photos = []) {
  const usable = photos.filter((p) => p && p.data);
  if (!usable.length) return { ok: false, reason: 'no_photos' };

  const perPhoto = [];
  for (const photo of usable) {
    const [claudeResult, geminiResult] = await Promise.allSettled([
      callClaudeVision(photo.data, photo.mimeType || 'image/jpeg'),
      callGeminiVision(photo.data, photo.mimeType || 'image/jpeg'),
    ]);
    const merged = mergeModelResults(
      claudeResult.status === 'fulfilled' ? claudeResult.value : null,
      geminiResult.status === 'fulfilled' ? geminiResult.value : null,
    );
    if (merged) perPhoto.push(merged);
  }

  if (!perPhoto.length) return { ok: false, reason: 'vision_unavailable' };

  const identification = aggregateIdentification(perPhoto);

  return {
    ok: true,
    identification,
    perPhoto,
    observations: [...new Set(perPhoto.flatMap((r) => r.observations))].slice(0, 6),
    distinguishing_features: [...new Set(perPhoto.flatMap((r) => r.distinguishing_features))].slice(0, 10),
    alternate_slugs: [...new Set(perPhoto.flatMap((r) => r.alternate_slugs))].filter(
      (slug) => slug !== (identification.entry && identification.entry.slug),
    ).slice(0, 4),
  };
}

// ── Report contract (internal, stored in pest_identifications.report_contract) ──

function buildPestReportContract(result) {
  const { identification, observations, distinguishing_features: features, alternate_slugs: alternates } = result;
  const item = identification.entry;
  return {
    contract_version: 'pest_id_v1',
    identification: {
      slug: item ? item.slug : null,
      label: item ? item.label : null,
      group: item ? item.group : null,
      category: identification.category,
      confidence: identification.confidence,
      contested: !!identification.contested,
    },
    safety: item ? item.safety : { stinging: false, venomous: false, disease_vector: false, structural_threat: false },
    urgency: item ? item.urgency : 'low',
    service: item
      ? { line: item.service_line, key: item.service_key, label: item.service_label, inspection_required: item.inspection_required }
      : { line: 'pest', key: null, label: 'Pest Consultation', inspection_required: true },
    observations,
    distinguishing_features: features,
    alternate_slugs: alternates,
  };
}

// ── Public egress (mirrors buildPublicLawnReport's allowlist discipline) ──────

/**
 * Customer-facing display label, confidence-gated. `specificity` says whether
 * the label names the library entry ('named') or collapsed to a group/category
 * generic ('generic') — the report uses it to gate the species blurb so a
 * withheld ID never leaks through the descriptive copy.
 *   high + matched + uncontested → the library label, stated plainly
 *   moderate + matched           → "likely" phrasing (still named, hedged)
 *   contested / low / unmatched  → group- or category-generic
 * Inspection-first entries (termite/rodent/bed-bug style signs) stay hedged
 * at ANY confidence — a photo ID is suggestive, the inspection confirms; the
 * API must never invite confirmed/WDO-style rendering.
 */
function publicIdentificationLabel(contract) {
  const ident = (contract && contract.identification) || {};
  const item = ident.slug ? LIBRARY_BY_SLUG.get(ident.slug) : null;
  if (!item) {
    return { label: CATEGORY_GENERIC[ident.category] || CATEGORY_GENERIC.other, hedged: true, specificity: 'generic' };
  }
  // Conflicting cross-photo IDs never name a species, whatever the confidence.
  if (ident.contested) {
    return { label: GROUP_GENERIC[item.group] || CATEGORY_GENERIC[item.category] || CATEGORY_GENERIC.other, hedged: true, specificity: 'generic' };
  }
  if (ident.confidence === 'high') {
    return { label: item.label, hedged: item.inspection_required === true, specificity: 'named' };
  }
  if (ident.confidence === 'moderate') return { label: `Likely ${item.label}`, hedged: true, specificity: 'named' };
  return { label: GROUP_GENERIC[item.group] || CATEGORY_GENERIC[item.category] || CATEGORY_GENERIC.other, hedged: true, specificity: 'generic' };
}

const NEXT_STEPS = {
  high: 'This one is worth addressing quickly — request your quote below and we’ll get you on the schedule right away.',
  moderate: 'It’s worth getting ahead of this before it grows. Request your quote below and we’ll confirm everything in person on the first visit.',
  low: 'No emergency here — but if you’re seeing them regularly, a routine protection plan keeps them out for good.',
};

function parseJson(value, fallback = {}) {
  if (value == null) return fallback;
  if (typeof value === 'object') return value;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch {
    return fallback;
  }
}

/**
 * Whitelist a stored identification row into the customer-facing report.
 * Every string comes from the fixed library/templates — never model output.
 */
function buildPublicPestReport(row = {}) {
  const contract = parseJson(row.report_contract, {});
  const ident = contract.identification || {};
  const item = ident.slug ? LIBRARY_BY_SLUG.get(ident.slug) : null;
  const { label, hedged, specificity } = publicIdentificationLabel(contract);
  const urgency = clampEnum(contract.urgency, URGENCIES, 'low');
  const service = contract.service || {};
  const notAPest = ident.category === 'not_a_pest' || (item && item.category === 'not_a_pest');

  const safety = item ? item.safety : { stinging: false, venomous: false, disease_vector: false, structural_threat: false };
  const contact = parseJson(row.contact_snapshot, {});
  const address = parseJson(row.address_snapshot, {});
  const firstName = contact.first_name
    || (typeof contact.name === 'string' ? contact.name.trim().split(/\s+/)[0] : null)
    || null;

  return {
    // Derived/allowlisted at egress like the lawn report — snapshots accept
    // arbitrary strings at capture time.
    first_name: safePublicFirstName(firstName),
    city: safePublicCity(address.city),
    identified: {
      label,
      hedged,
      category: clampEnum(ident.category, CATEGORIES, 'other'),
      confidence: clampEnum(ident.confidence, CONFIDENCES, 'low'),
    },
    not_a_pest: !!notAPest,
    urgency,
    safety: {
      stinging: !!safety.stinging,
      venomous: !!safety.venomous,
      disease_vector: !!safety.disease_vector,
      structural_threat: !!safety.structural_threat,
    },
    // Library-authored, static copy — never model text. The species blurb is
    // shown ONLY when the label names the entry ('named'): when the label
    // collapsed to a generic ("an ant species"), the blurb must not leak the
    // withheld ID ("Ghost ants are…").
    about: item && specificity === 'named'
      ? item.customer_blurb
      : 'We want a closer look at this one — the photo doesn’t show enough detail for a confident ID, and our team reviews every submission personally.',
    next_step: notAPest ? null : NEXT_STEPS[urgency] || NEXT_STEPS.low,
    recommendation: notAPest ? null : {
      service_label: service.label || 'General Pest Control',
      inspection_required: service.inspection_required !== false && (service.inspection_required === true || !service.key),
      // Fixed, compliance-safe framing for inspection-first lines (termite/WDO
      // especially): a photo ID is suggestive, the inspection is the confirmation.
      note: (service.line === 'termite')
        ? 'A photo can suggest termite activity but only an in-person inspection can confirm it — ours are free and usually within a couple of days.'
        : (service.key ? null : 'We confirm this one in person first — the inspection is free and the quote comes from what we actually find.'),
    },
    // Server-computed at claim time by the pricing engine; re-clamped at egress.
    pricing: sanitizePricingSnapshot(parseJson(row.pricing_snapshot, null)),
  };
}

/**
 * Teaser payload: enough to prove the analysis is real, with the species
 * detail, guidance, and pricing withheld until contact capture. Uses the same
 * generic-label machinery so even the teaser never leaks an ungated ID.
 */
function buildPestTeaser(contract = {}) {
  const ident = contract.identification || {};
  const item = ident.slug ? LIBRARY_BY_SLUG.get(ident.slug) : null;
  const urgency = clampEnum(contract.urgency, URGENCIES, 'low');
  const category = clampEnum(ident.category, CATEGORIES, 'other');
  const generic = item
    ? (GROUP_GENERIC[item.group] || CATEGORY_GENERIC[item.category])
    : (CATEGORY_GENERIC[category] || CATEGORY_GENERIC.other);
  return {
    identified_teaser: `We identified ${generic}.`,
    identified_specific: Boolean(item && ident.confidence !== 'low'),
    category,
    urgency,
    safety_flag: Boolean(item && (item.safety.venomous || item.safety.stinging || item.safety.structural_threat || item.safety.disease_vector)),
  };
}

module.exports = {
  PEST_LIBRARY,
  CATEGORIES,
  CONFIDENCES,
  URGENCIES,
  resolveLibraryMatch,
  mergeModelResults,
  identifyPest,
  buildPestReportContract,
  buildPublicPestReport,
  buildPestTeaser,
  publicIdentificationLabel,
  _test: {
    normalizeName,
    lowerConfidenceOf,
    downgrade,
    aggregateIdentification,
    LIBRARY_BY_SLUG,
    GROUP_GENERIC,
    CATEGORY_GENERIC,
  },
};
