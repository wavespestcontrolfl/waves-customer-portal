const logger = require('./logger');
const { etParts } = require('../utils/datetime-et');
const SocialCardRenderer = require('./social-card-renderer');

// =============================================================================
// Social Creative Engine — AI photo scenes behind the deterministic brand layer.
//
// The autonomous studio's daily posts all render the SAME fixed SVG card with
// different text, which reads as stale after a week. This engine replaces the
// card's flat ground with a photoreal AI-generated scene picked from a rotating
// per-service concept library, then composites the brand layer (logo, headline,
// gold CTA) over it via social-card-renderer.renderPhotoCardJpegBase64 — so the
// visual changes every day while the brand marks stay pixel-deterministic.
//
// Fail-closed by design: the engine is OFF unless SOCIAL_CREATIVE_ENGINE_ENABLED
// is true, and generateVariants() NEVER throws — any provider/render/upload
// failure just yields fewer (possibly zero) variants and the caller falls back
// to the legacy SVG brand card, so a bad image-API day can not block a post.
// =============================================================================

function boolEnv(key, defaultValue = false) {
  const value = process.env[key];
  if (value == null || value === '') return defaultValue;
  return ['true', '1', 'yes', 'on'].includes(String(value).toLowerCase());
}

// Image-native Gemini first (best brand-consistency per dollar), then the
// OpenAI gpt-image chain, then the legacy Gemini text-model slug — resilience
// over any single provider/model ID.
const SOCIAL_DEFAULT_CHAIN = 'gemini-image-best,gemini-image,gpt-image-2,gpt-image-1.5,gpt-image-1,gemini';

const CREATIVE_FLAGS = {
  get enabled() { return boolEnv('SOCIAL_CREATIVE_ENGINE_ENABLED', false); },
  // Variants only apply to DRAFT runs (the approval queue); publish runs always
  // generate exactly one. Clamped so a typo can't burn 20 image generations.
  get variantCount() {
    const value = Number(process.env.SOCIAL_CREATIVE_VARIANTS);
    if (!Number.isFinite(value)) return 3;
    return Math.max(1, Math.min(4, Math.round(value)));
  },
  get chain() { return process.env.SOCIAL_IMAGE_PROVIDER || SOCIAL_DEFAULT_CHAIN; },
};

// ── Scene concept library ────────────────────────────────────────────────────
// Each concept is a photoreal scene fragment. Rules baked into buildScenePrompt
// (no text/logos/people, lower-third negative space) apply to every concept, so
// entries here only describe WHAT the camera sees. Keys are persisted into
// run previews (preview.visual.creative.conceptKey) for the no-repeat rotation.
const SCENE_LIBRARY = {
  termite: [
    { key: 'termite-swarmers-window', scene: 'winged termite swarmers clustered around a bright window frame at dusk, warm interior light glowing, discarded translucent wings scattered on the white sill' },
    { key: 'termite-mud-tubes', scene: 'close-up of pencil-width brown mud tubes climbing a pale concrete block foundation wall of a Florida home, morning light' },
    { key: 'termite-wood-grain', scene: 'extreme close-up of honeycombed, termite-damaged wood grain on a door frame corner, soft raking light' },
    { key: 'termite-inspection-light', scene: 'a bright flashlight beam sweeping across a wooden sill plate in a dim garage corner, dust motes visible in the beam' },
    { key: 'termite-discarded-wings', scene: 'a small scatter of discarded translucent insect wings on a windowsill beside a potted orchid, shallow depth of field' },
  ],
  mosquito: [
    { key: 'mosquito-lanai-dusk', scene: 'a screened lanai with a pool at blue-hour dusk, string lights on, lush tropical plants pressing against the screen from outside' },
    { key: 'mosquito-plant-saucer', scene: 'macro of rainwater standing in a terracotta plant saucer on a patio, the still surface catching light' },
    { key: 'mosquito-after-rain', scene: 'a Florida backyard right after an afternoon thunderstorm, wet St. Augustine grass, puddles reflecting palm trees and a dramatic clearing sky' },
    { key: 'mosquito-gutter', scene: 'close-up of a clogged house gutter holding stagnant water and leaves, bright blue sky behind the roofline' },
    { key: 'mosquito-birdbath', scene: 'a stone birdbath full of still water in a landscaped Southwest Florida yard, hibiscus flowers, late-afternoon golden light' },
  ],
  lawn: [
    { key: 'lawn-chinch-patch', scene: 'a St. Augustine grass lawn with an irregular straw-brown dead patch spreading beside lush green blades, bright midday Florida sun' },
    { key: 'lawn-blade-macro', scene: 'extreme macro of St. Augustine grass blades at soil level with the thatch layer visible, morning dew on the blades' },
    { key: 'lawn-fungus-rings', scene: 'brown circular patches on an otherwise green Florida lawn after summer rain, soft overcast light' },
    { key: 'lawn-property-line', scene: 'a property line where one lawn is thick deep-green St. Augustine and the neighboring side is patchy and yellowed, palm trees and blue sky' },
    { key: 'lawn-sprinkler-sunrise', scene: 'irrigation sprinklers running over a healthy green Florida lawn at sunrise, backlit water droplets and long shadows' },
  ],
  rodent: [
    { key: 'rodent-soffit-gap', scene: 'close-up of a small gnawed gap at the corner of a soffit and roofline on a stucco Florida home, bright daylight' },
    { key: 'rodent-attic-beam', scene: 'a flashlight beam illuminating rafters and blown-in insulation inside a dim residential attic' },
    { key: 'rodent-garage-seal', scene: 'the corner of a tidy garage where daylight glows through a small gap under the garage door weather seal' },
    { key: 'rodent-palm-roofline', scene: 'a Florida home tile roofline with an overhanging palm frond touching the roof, clear blue sky' },
  ],
  tree_shrub: [
    { key: 'shrub-hibiscus-curl', scene: 'close-up of a hibiscus shrub with curled yellowing leaves in a Southwest Florida landscape bed, bright sun' },
    { key: 'shrub-palm-browning', scene: 'a queen palm with browning lower fronds against a bright blue sky in a residential yard' },
    { key: 'shrub-ornamental-bed', scene: 'a manicured tropical landscape bed with crotons and ixora along a stucco home, morning light' },
    { key: 'shrub-sooty-mold', scene: 'macro of glossy green ornamental leaves dusted with black sooty mold, shallow depth of field' },
  ],
  general: [
    { key: 'pest-ants-lanai', scene: 'a thin trail of ants crossing lanai pavers toward a doorway, shallow depth of field, warm evening light' },
    { key: 'pest-kitchen-baseboard', scene: 'a clean bright kitchen corner photographed at baseboard level, morning light raking across the tile floor' },
    { key: 'pest-door-gap', scene: 'daylight glowing through the gap under an exterior door, photographed from inside a dim room' },
    { key: 'pest-mulch-wall', scene: 'close-up of landscape mulch and palmetto plants right up against a home stucco wall, dappled light' },
    { key: 'pest-porch-light', scene: 'a warm porch light glowing at night with small insects circling it, deep blue sky and tropical landscaping silhouettes' },
  ],
  review: [
    { key: 'review-home-curb', scene: 'a well-kept single-story Florida home with a clean driveway, green St. Augustine lawn and palm trees at golden hour' },
    { key: 'review-lanai-calm', scene: 'a peaceful screened lanai with patio furniture and a ceiling fan, bright tropical afternoon light outside' },
    { key: 'review-backyard-shade', scene: 'a lush green backyard lawn with a large shade tree, late-afternoon light, no people' },
    { key: 'review-front-entry', scene: 'a welcoming Florida front entry with potted plants and a clean walkway, soft morning light' },
    { key: 'review-coastal-street', scene: 'a quiet Southwest Florida residential street lined with palms and tidy lawns under a blue sky with puffy clouds' },
  ],
};

// Mirrors the studio's SERVICE_INTENT_KEYWORDS buckets (kept local so the
// engine has no studio import — the studio imports the engine, never the
// reverse). First match wins; anything unmatched gets the general pest bank.
const BUCKET_KEYWORDS = [
  { bucket: 'termite', match: ['termite', 'swarm', 'wdo', 'wood destroying'] },
  { bucket: 'mosquito', match: ['mosquito', 'standing water'] },
  { bucket: 'lawn', match: ['lawn', 'turf', 'grass', 'weed', 'fungus', 'fertil', 'chinch', 'st. augustine'] },
  { bucket: 'rodent', match: ['rodent', 'rat', 'rats', 'mouse', 'mice'] },
  { bucket: 'tree_shrub', match: ['tree', 'shrub', 'ornamental', 'palm'] },
];

function resolveSceneBucket({ service, topic, variant } = {}) {
  if (variant === 'review') return 'review';
  const text = `${service || ''} ${topic || ''}`.toLowerCase();
  for (const group of BUCKET_KEYWORDS) {
    if (group.match.some((keyword) => text.includes(keyword))) return group.bucket;
  }
  return 'general';
}

// Deterministic rotation seed anchored to the Eastern business date (matches
// selectAutonomousCampaign's ET anchoring) — no RNG, so a retried run on the
// same day picks the same concepts and tests are reproducible.
function rotationSeed(now = new Date()) {
  const { month, day } = etParts(now);
  return (Number(month) || 1) * 31 + (Number(day) || 1);
}

// Pick `count` distinct concepts from the bucket, starting at a seeded offset
// and skipping recently-used keys. If exclusions would exhaust the bank, they
// are ignored (a repeat beats no image).
function pickConcepts({ service, topic, variant, count = 1, excludeKeys = [], now = new Date() } = {}) {
  const bucket = resolveSceneBucket({ service, topic, variant });
  const bank = SCENE_LIBRARY[bucket] || SCENE_LIBRARY.general;
  const excluded = new Set((excludeKeys || []).map((key) => String(key || '')));
  const fresh = bank.filter((concept) => !excluded.has(concept.key));
  const pool = fresh.length ? fresh : bank;
  const start = rotationSeed(now) % pool.length;
  const picked = [];
  for (let i = 0; i < pool.length && picked.length < count; i += 1) {
    picked.push(pool[(start + i) % pool.length]);
  }
  return picked;
}

function buildScenePrompt({ topic, city, concept } = {}) {
  const cityLabel = String(city || 'Southwest Florida').replace(/[\r\n]+/g, ' ').slice(0, 80);
  const topicLabel = String(topic || 'seasonal pest pressure').replace(/[\r\n]+/g, ' ').slice(0, 160);
  return [
    `A high-quality photorealistic photograph for a Southwest Florida pest control & lawn care brand. Theme: ${topicLabel}.`,
    `Scene: ${concept?.scene || 'a well-kept Florida home exterior with tropical landscaping'}.`,
    `Setting: the ${cityLabel} area — characteristic SWFL residential detail (palm trees, St. Augustine grass, stucco homes, bright gulf-coast light).`,
    'Composition: square 1:1. Main subject in the upper two-thirds of the frame; keep the lower third simple and uncluttered with soft focus (a text overlay will be placed there).',
    // Brand palette is Waves Blue #009CDE + Gold #FFD700; the brand brief
    // explicitly forbids teal — steer the color grade, don't paint objects.
    'Style: crisp, editorial, natural. Sunny coastal grade with deep-blue sky tones and warm golden light (no teal color cast).',
    'Strictly NO text, letters, numbers, signage, logos, watermarks, people, faces, or brand marks anywhere in the image.',
  ].join(' ');
}

// Generate ONE scene per concept and composite the brand overlay at each
// requested size. Returns [{ imageUrl, gbpImageUrl, conceptKey, sceneModel }]
// with failed variants dropped; [] on total failure — never throws.
async function generateVariants({
  cardInput = {},
  topic,
  service,
  city,
  variant = 'campaign',
  count = 1,
  excludeConcepts = [],
  wantGbp = false,
  now = new Date(),
} = {}) {
  let uploadImageToS3;
  let ImageGenerator;
  try {
    ({ uploadImageToS3 } = require('./social-media'));
    ({ ImageGenerator } = require('./content/image-generator'));
  } catch (err) {
    logger.warn(`[social-creative] engine unavailable: ${err.message}`);
    return [];
  }

  const concepts = pickConcepts({
    service,
    topic,
    variant,
    count,
    excludeKeys: excludeConcepts,
    now,
  });
  if (!concepts.length) return [];

  const generator = new ImageGenerator({ envChain: CREATIVE_FLAGS.chain });
  const overlayVariant = variant === 'review' ? 'photo_review' : 'photo';
  const seedBase = SocialCardRenderer.filenameSlug(`${variant}-${city || 'waves'}-${topic || 'creative'}`);

  const results = await Promise.all(concepts.map(async (concept, index) => {
    try {
      const prompt = buildScenePrompt({ topic, city, concept });
      const generated = await generator.generate({ mode: 'social-square', prompt });
      const match = /^data:[^;]+;base64,(.+)$/.exec(generated?.dataUrl || '');
      if (!match) return null;
      const backgroundBase64 = match[1];

      const overlayInput = { ...cardInput, variant: overlayVariant };
      const squareBase64 = await SocialCardRenderer.renderPhotoCardJpegBase64(overlayInput, {
        platform: 'square',
        backgroundBase64,
      });
      const imageUrl = await uploadImageToS3(
        squareBase64,
        `${seedBase}-${concept.key}-v${index + 1}-${Date.now()}.jpg`
      );
      if (!imageUrl) return null;

      let gbpImageUrl = null;
      if (wantGbp) {
        const gbpBase64 = await SocialCardRenderer.renderPhotoCardJpegBase64(overlayInput, {
          platform: 'gbp',
          backgroundBase64,
        });
        gbpImageUrl = await uploadImageToS3(
          gbpBase64,
          `${seedBase}-${concept.key}-v${index + 1}-gbp-${Date.now()}.jpg`
        );
      }

      return { imageUrl, gbpImageUrl, conceptKey: concept.key, sceneModel: generated.model || null };
    } catch (err) {
      logger.warn(`[social-creative] variant ${concept.key} failed: ${err.message}`);
      return null;
    }
  }));

  const variants = results.filter(Boolean);
  if (!variants.length) {
    logger.warn('[social-creative] all variants failed — caller should fall back to the brand card');
  }
  return variants;
}

module.exports = {
  CREATIVE_FLAGS,
  SCENE_LIBRARY,
  SOCIAL_DEFAULT_CHAIN,
  buildScenePrompt,
  generateVariants,
  pickConcepts,
  resolveSceneBucket,
  rotationSeed,
};
