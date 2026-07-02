// Florida pre-construction subterranean termite soil-treatment label rates
// for the products offered on the Pre-Treatment Certificate of Compliance
// (project type `pre_treatment_termite_certificate`). Used by the create-
// project form to auto-fill `concentration_pct` and `gallons_applied` from
// the treatment dimensions the tech already records.
//
// Rate basis (identical volume standard across the three soil-liquid labels):
//   - Horizontal barrier: 1 gallon of finished dilution per 10 sq ft.
//   - Vertical barrier (trench/rod): 4 gallons per 10 linear feet per foot
//     of depth.
// Concentration is each label's standard pre-construction dilution — the
// tech can overtype it when applying a label-permitted higher rate.
//
// Trelona ATBB is a bait system and Bora-Care is a direct wood treatment:
// neither has a finished-solution soil concentration or a soil gallons
// figure, so the calculator reports them as not applicable instead of
// guessing.

const HORIZONTAL_GAL_PER_SQFT = 1 / 10;
const VERTICAL_GAL_PER_LF_PER_FT_DEPTH = 4 / 10;
// 6 in / 0.5 ft is the label-standard residential trench depth — the same
// default the pricing engine's finished-gallons math uses
// (server/services/pricing-engine/constants.js defaultTrenchDepthFt), so a
// certificate never prints different chemistry than the priced work order.
const DEFAULT_TRENCH_DEPTH_FT = 0.5;

// The admin product catalog seeds the bait stations as "Trelona ATBS" (and
// "Trelona ATBS Bait Station", "Trelona ATBS RFID" — the prefix match picks
// those up); 'trelona atbb' is kept as a free-text alias so either spelling
// resolves to the same not-applicable entry.
const TRELONA_BAIT_RATE = {
  label: 'Trelona ATBS',
  kind: 'bait',
  note: 'Trelona ATBS is a bait system — finished-solution concentration and gallons do not apply.',
};

export const PRETREAT_PRODUCT_RATES = {
  'termidor sc': {
    label: 'Termidor SC',
    kind: 'soil_liquid',
    concentrationPct: '0.060',
  },
  'talstar p': {
    label: 'Talstar P',
    kind: 'soil_liquid',
    concentrationPct: '0.060',
  },
  'premise 2': {
    label: 'Premise 2',
    kind: 'soil_liquid',
    concentrationPct: '0.050',
  },
  'trelona atbs': TRELONA_BAIT_RATE,
  'trelona atbb': TRELONA_BAIT_RATE,
  'bora-care': {
    label: 'Bora-Care',
    kind: 'wood_treatment',
    note: 'Bora-Care is a direct wood treatment (1:1 dilution) — soil concentration and gallons do not apply.',
  },
};

export function lookupPretreatProduct(productName) {
  const key = String(productName || '').trim().toLowerCase().replace(/\s+/g, ' ');
  if (!key) return null;
  if (PRETREAT_PRODUCT_RATES[key]) return PRETREAT_PRODUCT_RATES[key];
  // Catalog entries often carry a formulation suffix ("Termidor SC 20 oz") —
  // match on a leading product name so those still resolve.
  for (const [name, rate] of Object.entries(PRETREAT_PRODUCT_RATES)) {
    if (key.startsWith(`${name} `)) return rate;
  }
  return null;
}

// "1,500 sq ft" / "220 LF" / "1.5" → 1500 / 220 / 1.5. Returns null when the
// field is blank or holds no leading number worth trusting.
function parseMeasure(value) {
  const raw = String(value ?? '').replace(/,/g, '').trim();
  if (!raw) return null;
  const match = raw.match(/-?\d+(?:\.\d+)?/);
  if (!match) return null;
  const n = Number(match[0]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// The depth field is labeled feet, but the label-standard trench is 6 inches
// and techs write it that way — "6 in", '6"', "6-inch" convert to feet; a
// bare number or an explicit ft stays feet.
function parseDepthFt(value) {
  const n = parseMeasure(value);
  if (n == null) return null;
  return /\d[\s-]*(?:"|in\b|inch)/i.test(String(value)) ? n / 12 : n;
}

function roundGallons(value) {
  return Math.round(value * 10) / 10;
}

function formatGallons(value) {
  const rounded = roundGallons(value);
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

/**
 * computePretreatChemistry — derive the certificate's finished-solution
 * concentration and gallons from the product + treatment dimensions.
 *
 * Returns one of:
 *   { status: 'unknown_product' }
 *     — product blank or not in the rate table; nothing to auto-fill.
 *   { status: 'not_applicable', kind, note }
 *     — bait / wood-treatment product; concentration & gallons don't apply.
 *   { status: 'ok', concentrationPct, gallons, gallonsText,
 *     horizontalGallons, verticalGallons, assumedDepth, note }
 *     — soil liquid. `gallons` is null when neither sq ft nor linear feet
 *       is filled in yet (concentration still applies). `assumedDepth` is
 *       true when linear feet were given without a trench depth and the
 *       0.5-ft label-standard depth was used.
 */
export function computePretreatChemistry({ productName, squareFootage, linearFeet, trenchDepthFt } = {}) {
  const product = lookupPretreatProduct(productName);
  if (!product) return { status: 'unknown_product' };
  if (product.kind !== 'soil_liquid') {
    return { status: 'not_applicable', kind: product.kind, note: product.note };
  }

  const sqFt = parseMeasure(squareFootage);
  const lf = parseMeasure(linearFeet);
  const depth = parseDepthFt(trenchDepthFt);
  const assumedDepth = Boolean(lf && !depth);
  const effectiveDepth = depth || DEFAULT_TRENCH_DEPTH_FT;

  const horizontalGallons = sqFt ? roundGallons(sqFt * HORIZONTAL_GAL_PER_SQFT) : 0;
  const verticalGallons = lf ? roundGallons(lf * VERTICAL_GAL_PER_LF_PER_FT_DEPTH * effectiveDepth) : 0;
  const total = horizontalGallons + verticalGallons;
  const gallons = sqFt || lf ? roundGallons(total) : null;

  const noteParts = [];
  if (sqFt) noteParts.push(`${formatGallons(horizontalGallons)} gal horizontal (1 gal / 10 sq ft)`);
  if (lf) {
    noteParts.push(
      `${formatGallons(verticalGallons)} gal vertical (4 gal / 10 LF per ft of depth${assumedDepth ? ', assuming the 0.5 ft label-standard depth' : ''})`,
    );
  }

  return {
    status: 'ok',
    concentrationPct: product.concentrationPct,
    gallons,
    gallonsText: gallons == null ? '' : formatGallons(gallons),
    horizontalGallons,
    verticalGallons,
    assumedDepth,
    note: noteParts.join(' + '),
  };
}
