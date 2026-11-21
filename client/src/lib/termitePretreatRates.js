// Florida pre-construction subterranean termite soil-treatment label rates
// for the products offered on the Pre-Treatment Certificate of Compliance
// (project type `pre_treatment_termite_certificate`). Used by the create-
// project form to auto-fill `concentration_pct` and `gallons_applied` from
// the treatment dimensions the tech already records.
//
// Rate basis (identical volume standard across the four soil-liquid labels):
//   - Horizontal barrier: 1 gallon of finished dilution per 10 sq ft.
//   - Vertical barrier (trench/rod): 4 gallons per 10 linear feet per foot
//     of depth.
// Concentration is each label's standard pre-construction dilution — the
// tech can overtype it when applying a label-permitted higher rate. A label
// with a Volume Adjustment Chart (LESCO Crosscheck Plus) puts its stronger
// dilution on at the chart's reduced volume, so gallons follow the typed
// concentration for it; every other product keeps the standard volume.
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
  // The house bifenthrin since owner 2026-11-18 (EPA 10404-120). Label pages 29-32: a 0.06% dilution for subterranean
  // termites, 1 gal per 10 sq ft horizontal and 4 gal per 10 linear ft per foot of depth.
  'lesco crosscheck plus': {
    label: 'LESCO Crosscheck Plus',
    kind: 'soil_liquid',
    concentrationPct: '0.060',
    // Label page 31, Volume Adjustment Chart: the 0.12% dilution goes on at half the labeled volume (0.5 gal per 10 sq ft
    // horizontal, 2 gal per 10 linear ft vertical), the same active ingredient as the 0.06% volume. The pricing engine
    // halves its 0.12% trench the same way (server/services/pricing-engine/constants.js labelHalfVolumeOzPerFinishedGallon).
    volumeAdjustment: { concentrationPct: 0.12, label: '0.12%', volumeFactor: 0.5 },
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

// "1,500 sq ft" / "220 LF" / "1.5" / ".5" → 1500 / 220 / 1.5 / 0.5. Returns
// null when the field is blank or holds no leading number worth trusting.
function parseMeasure(value) {
  const raw = String(value ?? '').replace(/,/g, '').trim();
  if (!raw) return null;
  const match = raw.match(/-?(?:\d+(?:\.\d+)?|\.\d+)/);
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

// "0.12" / "0.120" / "0.12%" / ".12" → 0.12. Anything else → null: a
// Volume Adjustment Chart dilution matches only a bare percentage, so
// "0.12 fl oz/gal" or a range never takes the chart's reduced volume.
function parsePercent(value) {
  const match = String(value ?? '').trim().match(/^(\d*\.?\d+)\s*%?$/);
  return match ? Number(match[1]) : null;
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
 *     horizontalGallons, verticalGallons, assumedDepth, volumeAdjusted, note }
 *     — soil liquid. `gallons` is null when neither sq ft nor linear feet
 *       is filled in yet (concentration still applies). `assumedDepth` is
 *       true when linear feet were given without a trench depth and the
 *       0.5-ft label-standard depth was used. The returned
 *       `concentrationPct` is always the label standard (the value the forms
 *       auto-fill). The `concentrationPct` input is the dilution the form
 *       holds now: when it is the stronger dilution of the product's Volume
 *       Adjustment Chart, `volumeAdjusted` is true and the gallons are the
 *       chart's reduced volume.
 */
export function computePretreatChemistry({ productName, squareFootage, linearFeet, trenchDepthFt, concentrationPct } = {}) {
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
  const adjustment = product.volumeAdjustment;
  const volumeAdjusted = adjustment?.concentrationPct === parsePercent(concentrationPct);
  const volumeFactor = volumeAdjusted ? adjustment.volumeFactor : 1;
  const chartNote = volumeAdjusted ? `, the label's ${adjustment.label} volume adjustment` : '';

  const horizontalGallons = sqFt ? roundGallons(sqFt * HORIZONTAL_GAL_PER_SQFT * volumeFactor) : 0;
  const verticalGallons = lf ? roundGallons(lf * VERTICAL_GAL_PER_LF_PER_FT_DEPTH * effectiveDepth * volumeFactor) : 0;
  const total = horizontalGallons + verticalGallons;
  const gallons = sqFt || lf ? roundGallons(total) : null;

  const noteParts = [];
  if (sqFt) {
    noteParts.push(`${formatGallons(horizontalGallons)} gal horizontal (${formatGallons(10 * HORIZONTAL_GAL_PER_SQFT * volumeFactor)} gal / 10 sq ft${chartNote})`);
  }
  if (lf) {
    noteParts.push(
      `${formatGallons(verticalGallons)} gal vertical (${formatGallons(10 * VERTICAL_GAL_PER_LF_PER_FT_DEPTH * volumeFactor)} gal / 10 LF per ft of depth${chartNote}${assumedDepth ? ', assuming the 0.5 ft label-standard depth' : ''})`,
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
    volumeAdjusted,
    note: noteParts.join(' + '),
  };
}
