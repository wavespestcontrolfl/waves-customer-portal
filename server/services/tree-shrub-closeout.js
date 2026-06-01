const TREE_SHRUB_CLOSEOUT_VERSION = 'tree_shrub_closeout_v1';

const TREE_SHRUB_SERVICE_LINES = new Set(['tree_shrub', 'palm']);
const BLACKOUT_ZONES = new Set(['sarasota_venice', 'manatee_parrish', 'other_unknown']);
const VALID_POLLINATOR_STATUSES = new Set([
  'no_blooms_or_no_bees',
  'blooming_no_bees',
  'blooming_bees_active',
  'no_insecticide_applied',
]);

function text(value) {
  return String(value || '').trim();
}

function compactText(value, max = 1000) {
  return text(value).replace(/\s+/g, ' ').slice(0, max);
}

function combinedText(...values) {
  return values
    .map((value) => {
      if (!value) return '';
      if (typeof value === 'object') return Object.values(value).join(' ');
      return String(value);
    })
    .join(' ')
    .toLowerCase();
}

function numberOrNull(value) {
  if (value === '' || value === null || value === undefined) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function nonnegativeIntegerOrNull(value) {
  if (value === '' || value === null || value === undefined) return null;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0) return null;
  return number;
}

function booleanValue(value) {
  if (value === true || value === false) return value;
  if (typeof value === 'string') {
    return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
  }
  return !!value;
}

function normalizeOrdinanceZone(value) {
  const raw = String(value || '').trim().toLowerCase();
  const normalized = raw.replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  if (!normalized) return '';
  if (normalized.includes('north_port')) return 'north_port';
  if (
    normalized.includes('manatee') ||
    normalized.includes('parrish') ||
    normalized.includes('bradenton') ||
    normalized.includes('palmetto') ||
    normalized.includes('ellenton') ||
    normalized.includes('lakewood_ranch')
  ) return 'manatee_parrish';
  if (
    normalized.includes('sarasota') ||
    normalized.includes('venice') ||
    normalized.includes('nokomis') ||
    normalized.includes('osprey') ||
    normalized.includes('englewood')
  ) return 'sarasota_venice';
  if (normalized.includes('other') || normalized.includes('unknown')) return 'other_unknown';
  return '';
}

function inferTreeShrubOrdinanceZone(service = {}) {
  const location = combinedText(
    service.city,
    service.municipality,
    service.county,
    service.address,
    service.address_line1,
    service.property_address,
    service.service_address,
  );
  if (/\bnorth\s*port\b/.test(location)) return 'north_port';
  if (/\b(parrish|manatee|bradenton|palmetto|ellenton|lakewood\s*ranch)\b/.test(location)) {
    return 'manatee_parrish';
  }
  if (/\b(sarasota|venice|nokomis|osprey|englewood)\b/.test(location)) return 'sarasota_venice';
  return 'other_unknown';
}

function normalizePollinatorStatus(value) {
  const normalized = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return VALID_POLLINATOR_STATUSES.has(normalized) ? normalized : '';
}

function normalizeTreeShrubCloseout(input = {}, service = {}) {
  const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const ordinanceZone = normalizeOrdinanceZone(source.ordinanceZone || source.ordinance_zone)
    || inferTreeShrubOrdinanceZone(service);
  const injectionRecord = source.injectionRecord && typeof source.injectionRecord === 'object'
    ? source.injectionRecord
    : {};

  return {
    version: TREE_SHRUB_CLOSEOUT_VERSION,
    ordinanceZone,
    bedSqft: numberOrNull(source.bedSqft ?? source.bed_sqft),
    palmCount: nonnegativeIntegerOrNull(source.palmCount ?? source.palm_count),
    palmRootZoneSqft: numberOrNull(source.palmRootZoneSqft ?? source.palm_root_zone_sqft),
    plantInventory: compactText(source.plantInventory ?? source.plant_inventory, 2000),
    pollinatorStatus: normalizePollinatorStatus(source.pollinatorStatus ?? source.pollinator_status),
    targetPestOrDisease: compactText(
      source.targetPestOrDisease ?? source.pestId ?? source.pest_id ?? source.target_pest_or_disease,
      240,
    ),
    pestLifeStage: compactText(
      source.pestLifeStage ?? source.pest_life_stage ?? source.lifeStage ?? source.life_stage,
      120,
    ),
    iracFracLogged: booleanValue(source.iracFracLogged ?? source.irac_frac_logged),
    snapshotAppliedYtd: nonnegativeIntegerOrNull(source.snapshotAppliedYtd ?? source.snapshot_applied_ytd),
    fertilizerAppliedYtd: compactText(source.fertilizerAppliedYtd ?? source.fertilizer_applied_ytd, 500),
    customerNote: compactText(source.customerNote ?? source.customer_note, 1000),
    injectionPerformed: booleanValue(source.injectionPerformed ?? source.injection_performed),
    injectionRecord: {
      plantSpecies: compactText(injectionRecord.plantSpecies ?? injectionRecord.plant_species, 180),
      sizeClassOrDbh: compactText(injectionRecord.sizeClassOrDbh ?? injectionRecord.size_class_or_dbh, 120),
      product: compactText(injectionRecord.product, 180),
      dose: compactText(injectionRecord.dose, 120),
      numberOfPorts: nonnegativeIntegerOrNull(injectionRecord.numberOfPorts ?? injectionRecord.number_of_ports),
      targetIssue: compactText(injectionRecord.targetIssue ?? injectionRecord.target_issue, 240),
      followUpDate: compactText(injectionRecord.followUpDate ?? injectionRecord.follow_up_date, 40),
    },
  };
}

function serviceDateOnly(value) {
  return value ? String(value instanceof Date ? value.toISOString() : value).slice(0, 10) : '';
}

function isSummerBlackoutForZone(serviceDate, ordinanceZone) {
  if (!BLACKOUT_ZONES.has(ordinanceZone)) return false;
  const dateOnly = serviceDateOnly(serviceDate);
  const match = dateOnly.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return false;
  const month = Number(match[2]);
  const day = Number(match[3]);
  return (month > 6 || (month === 6 && day >= 1)) && (month < 9 || (month === 9 && day <= 30));
}

function parseAnalysisFromText(value) {
  const match = String(value || '').match(/\b(\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)\b/);
  if (!match) return null;
  return { n: Number(match[1]), p: Number(match[2]), k: Number(match[3]) };
}

function parseFertilizerAnalysis(value) {
  if (!value) return null;
  if (typeof value === 'string') {
    try {
      return parseFertilizerAnalysis(JSON.parse(value));
    } catch {
      return parseAnalysisFromText(value);
    }
  }
  if (typeof value === 'object') {
    return {
      n: numberOrNull(value.n ?? value.N ?? value.nitrogen),
      p: numberOrNull(value.p ?? value.P ?? value.phosphorus),
      k: numberOrNull(value.k ?? value.K ?? value.potassium),
    };
  }
  return null;
}

function productName(productRef = {}) {
  return text(productRef?.catalog?.name || productRef?.input?.name || productRef?.name);
}

function productText(productRef = {}) {
  const catalog = productRef.catalog || productRef;
  const input = productRef.input || productRef;
  return combinedText(
    catalog.name,
    input.name,
    catalog.category,
    input.category,
    catalog.product_type,
    catalog.active_ingredient,
    catalog.moa_group,
    catalog.irac_group,
    catalog.frac_group,
    catalog.hrac_group,
    catalog.fertilizer_analysis,
  );
}

function productHasNpFertilizer(productRef = {}) {
  const catalog = productRef.catalog || productRef;
  const input = productRef.input || productRef;
  const nameText = combinedText(catalog.name, input.name, catalog.category, catalog.product_type);
  const textAnalysis = parseAnalysisFromText(nameText);
  if (textAnalysis) return Number(textAnalysis.n || 0) > 0 || Number(textAnalysis.p || 0) > 0;

  const structuredAnalysis = parseFertilizerAnalysis(catalog.fertilizer_analysis);
  if (structuredAnalysis) {
    return Number(structuredAnalysis.n || 0) > 0 || Number(structuredAnalysis.p || 0) > 0;
  }

  if (Number(catalog.analysis_n || 0) > 0 || Number(catalog.analysis_p || 0) > 0) return true;
  if (/\b0\s*-\s*0\s*-\s*\d+/.test(nameText) || /\b0\s*n\b|\b0\s*p\b/.test(nameText)) return false;
  return /\b(fertiliz|fertiliser|fertilizer|fert\b|palm\s*fert|alfalfa|13\s*-\s*0\s*-\s*13|8\s*-\s*2\s*-\s*12)\b/.test(nameText);
}

function isSnapshotProduct(productRef = {}) {
  return /\bsnapshot\b/.test(productText(productRef));
}

function isInjectionProduct(productRef = {}) {
  return /\b(palm[\s-]*jet|mn[\s-]*jet|ima[\s-]*jet|propizol|tree[\s-]*age|injection|injectable)\b/.test(productText(productRef));
}

function isInsectLikeProduct(productRef = {}) {
  const textValue = productText(productRef);
  return /\b(insect|miticide|igr|whitefly|scale|aphid|thrip|caterpillar|mite|neonic|imidacloprid|dinotefuran|bifenthrin|pyrethroid|merit|zylam|kontos|mainspring|distance|talus|suffoil|oil|conserve|floramite|talstar|sevin|azamax|ima[\s-]*jet)\b/.test(textValue);
}

function isFungicideLikeProduct(productRef = {}) {
  const textValue = productText(productRef);
  return /\b(fungicide|fungus|disease|phytophthora|kphite|phosphite|phosphonate|copper|headway|artavia|propizol|frac)\b/.test(textValue);
}

function productNeedsIracFracLog(productRef = {}) {
  const catalog = productRef.catalog || productRef;
  return !!catalog.irac_group || !!catalog.frac_group || isInsectLikeProduct(productRef) || isFungicideLikeProduct(productRef);
}

function buildProductRefs(products = [], productRows = []) {
  const byId = new Map((productRows || []).map((row) => [String(row.id), row]));
  return (products || [])
    .filter((input) => input && input.productId)
    .map((input) => ({
      input,
      catalog: byId.get(String(input.productId)) || {},
    }));
}

function missingProductActuals(productRef = {}) {
  const input = productRef.input || productRef;
  const amount = numberOrNull(input.totalAmount ?? input.total_amount);
  return !amount || amount <= 0 || !text(input.amountUnit ?? input.amount_unit);
}

function isNoneText(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return !normalized || ['none', 'none observed', 'none_observed', 'n/a', 'na'].includes(normalized);
}

function pushBlock(blocks, code, message, field = null) {
  blocks.push({ code, message, field, severity: 'block' });
}

function validateTreeShrubCloseout({
  service = {},
  serviceLine,
  serviceDate,
  completion,
  products = [],
  productRows = [],
  completionPhotos = [],
  customerRecap = '',
  technicianNotes = '',
} = {}) {
  const normalized = normalizeTreeShrubCloseout(completion, service);
  const blocks = [];
  const warnings = [];
  const productRefs = buildProductRefs(products, productRows);
  const productFlags = {
    hasInsectProduct: productRefs.some(isInsectLikeProduct),
    hasFungicideProduct: productRefs.some(isFungicideLikeProduct),
    needsIracFracLog: productRefs.some(productNeedsIracFracLog),
    hasSnapshot: productRefs.some(isSnapshotProduct),
    hasNpFertilizer: productRefs.some(productHasNpFertilizer),
    hasInjectionProduct: productRefs.some(isInjectionProduct),
    missingActuals: productRefs.filter(missingProductActuals).map(productName).filter(Boolean),
  };

  if (!TREE_SHRUB_SERVICE_LINES.has(serviceLine)) {
    return { ok: true, blocks: [], warnings: [], normalized: null, productFlags };
  }

  if (!normalized.ordinanceZone) {
    pushBlock(blocks, 'tree_shrub_ordinance_zone_required', 'Select the ordinance zone for this Tree/Shrub visit.', 'ordinanceZone');
  }
  if (!normalized.bedSqft || normalized.bedSqft <= 0) {
    pushBlock(blocks, 'tree_shrub_bed_sqft_required', 'Enter bed square footage before closeout.', 'bedSqft');
  }
  if (normalized.palmCount === null) {
    pushBlock(blocks, 'tree_shrub_palm_count_required', 'Enter palm count, even if it is 0.', 'palmCount');
  }
  if (Number(normalized.palmCount || 0) > 0 && (!normalized.palmRootZoneSqft || normalized.palmRootZoneSqft <= 0)) {
    pushBlock(blocks, 'tree_shrub_palm_root_zone_required', 'Enter palm canopy/root-zone square footage for palm accounts.', 'palmRootZoneSqft');
  }
  if (!normalized.plantInventory) {
    pushBlock(blocks, 'tree_shrub_plant_inventory_required', 'Record plant inventory before closeout.', 'plantInventory');
  }
  if (!normalized.pollinatorStatus) {
    pushBlock(blocks, 'tree_shrub_pollinator_status_required', 'Record flowering/pollinator status before closeout.', 'pollinatorStatus');
  }
  if (!normalized.targetPestOrDisease) {
    pushBlock(blocks, 'tree_shrub_pest_id_required', 'Record target pest, disease, or "none observed".', 'targetPestOrDisease');
  }
  if (!normalized.pestLifeStage) {
    pushBlock(blocks, 'tree_shrub_life_stage_required', 'Record pest life stage or "none".', 'pestLifeStage');
  }
  if (productFlags.hasInsectProduct && isNoneText(normalized.targetPestOrDisease)) {
    pushBlock(blocks, 'tree_shrub_insect_target_required', 'Insecticide/miticide/IGR applications require a target pest ID.', 'targetPestOrDisease');
  }
  if (productFlags.hasInsectProduct && isNoneText(normalized.pestLifeStage)) {
    pushBlock(blocks, 'tree_shrub_insect_life_stage_required', 'Insecticide/miticide/IGR applications require pest life stage.', 'pestLifeStage');
  }
  if (productFlags.hasInsectProduct && normalized.pollinatorStatus === 'blooming_bees_active') {
    pushBlock(blocks, 'tree_shrub_pollinator_block', 'Do not complete bee-sensitive insect/contact applications on blooming plants while bees are active.', 'pollinatorStatus');
  }
  if (productFlags.needsIracFracLog && !normalized.iracFracLogged) {
    pushBlock(blocks, 'tree_shrub_irac_frac_required', 'Confirm IRAC/FRAC history was checked and logged for pesticide applications.', 'iracFracLogged');
  }
  if (normalized.snapshotAppliedYtd === null) {
    pushBlock(blocks, 'tree_shrub_snapshot_ytd_required', 'Record Snapshot applications year-to-date.', 'snapshotAppliedYtd');
  } else if (normalized.snapshotAppliedYtd > 4) {
    pushBlock(blocks, 'tree_shrub_snapshot_ytd_limit', 'Snapshot applications year-to-date cannot exceed the quarterly program limit.', 'snapshotAppliedYtd');
  }
  if (!normalized.fertilizerAppliedYtd) {
    pushBlock(blocks, 'tree_shrub_fertilizer_ytd_required', 'Record fertilizer applied year-to-date or "none".', 'fertilizerAppliedYtd');
  }
  if (!normalized.customerNote && !text(customerRecap) && !text(technicianNotes)) {
    pushBlock(blocks, 'tree_shrub_customer_note_required', 'Enter a customer-facing note or technician closeout note.', 'customerNote');
  }
  if (!Array.isArray(completionPhotos) || completionPhotos.length < 2) {
    pushBlock(blocks, 'tree_shrub_photos_required', 'Attach at least 2 Tree/Shrub closeout photos.', 'completionPhotos');
  }
  if (productFlags.missingActuals.length) {
    pushBlock(
      blocks,
      'tree_shrub_product_actuals_required',
      `Enter actual product amount and unit before closeout: ${productFlags.missingActuals.join(', ')}.`,
      'products',
    );
  }
  if (
    productFlags.hasNpFertilizer &&
    isSummerBlackoutForZone(serviceDate || service.scheduled_date, normalized.ordinanceZone)
  ) {
    pushBlock(
      blocks,
      'tree_shrub_np_blackout',
      'N/P fertilizer is blocked for this Tree/Shrub ordinance zone from June 1 through September 30.',
      'ordinanceZone',
    );
  }

  const injectionRequired = normalized.injectionPerformed || productFlags.hasInjectionProduct;
  if (injectionRequired) {
    const injection = normalized.injectionRecord || {};
    if (!injection.plantSpecies) pushBlock(blocks, 'tree_shrub_injection_species_required', 'Injection record requires plant species.', 'injectionRecord.plantSpecies');
    if (!injection.sizeClassOrDbh) pushBlock(blocks, 'tree_shrub_injection_size_required', 'Injection record requires DBH or palm size class.', 'injectionRecord.sizeClassOrDbh');
    if (!injection.product) pushBlock(blocks, 'tree_shrub_injection_product_required', 'Injection record requires product.', 'injectionRecord.product');
    if (!injection.dose) pushBlock(blocks, 'tree_shrub_injection_dose_required', 'Injection record requires dose.', 'injectionRecord.dose');
    if (injection.numberOfPorts === null) pushBlock(blocks, 'tree_shrub_injection_ports_required', 'Injection record requires number of ports.', 'injectionRecord.numberOfPorts');
    if (!injection.targetIssue) pushBlock(blocks, 'tree_shrub_injection_target_required', 'Injection record requires target issue.', 'injectionRecord.targetIssue');
    if (!injection.followUpDate) pushBlock(blocks, 'tree_shrub_injection_follow_up_required', 'Injection record requires follow-up date.', 'injectionRecord.followUpDate');
  }

  if (normalized.ordinanceZone === 'other_unknown') {
    warnings.push({
      code: 'tree_shrub_unknown_zone_conservative',
      message: 'Unknown ordinance zone is treated as Sarasota/Manatee conservative blackout logic.',
    });
  }

  return {
    ok: blocks.length === 0,
    blocks,
    warnings,
    normalized: {
      ...normalized,
      productFlags,
    },
    productFlags,
  };
}

module.exports = {
  TREE_SHRUB_CLOSEOUT_VERSION,
  inferTreeShrubOrdinanceZone,
  isSummerBlackoutForZone,
  normalizeTreeShrubCloseout,
  productHasNpFertilizer,
  validateTreeShrubCloseout,
};
