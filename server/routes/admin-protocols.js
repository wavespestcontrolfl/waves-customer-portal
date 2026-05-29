const express = require('express');
const router = express.Router();
const db = require('../models/db');
const { adminAuthenticate, requireTechOrAdmin } = require('../middleware/admin-auth');
const { etParts } = require('../utils/datetime-et');
const {
  buildMixOrder,
  calculateProductAmount,
  effectiveAreaFactor,
  matchCatalogProduct,
  parseVisitNutrientTargets,
  parseProtocolLines,
  resolveProtocolItems,
  summarizeMaterialCost,
} = require('../services/waveguard-plan-engine');
const { matchServiceProtocol } = require('../services/protocol-matcher');

router.use(adminAuthenticate, requireTechOrAdmin);

const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const TRACK_MAP = {
  A_St_Aug_Sun: 'st_augustine',
  B_St_Aug_Shade: 'st_augustine',
  C1_Bermuda: 'bermuda',
  C2_Zoysia: 'zoysia',
  D_Bahia: 'bahia',
};
const PROGRAM_KEYS = ['tree_shrub', 'pest', 'termite'];

function programSummary(key, program) {
  if (!program) return null;
  return {
    key,
    name: program.name,
    visits: Array.isArray(program.visits) ? program.visits.length : 0,
    notes: Array.isArray(program.notes) ? program.notes.length : 0,
  };
}

function monthAbbr(value) {
  const n = parseInt(value, 10);
  if (Number.isFinite(n) && n >= 1 && n <= 12) return MONTH_ABBR[n - 1];
  const raw = String(value || '').slice(0, 3).toLowerCase();
  return MONTH_ABBR.find((m) => m.toLowerCase() === raw) || MONTH_ABBR[etParts(new Date()).month - 1];
}

function normalizeText(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function lawnTrackFromInput(value) {
  const text = normalizeText(value);
  if (text.includes('bermuda')) return 'bermuda';
  if (text.includes('zoysia')) return 'zoysia';
  if (text.includes('bahia')) return 'bahia';
  return 'st_augustine';
}

function actionKindForLine(line, product) {
  const text = normalizeText(`${line?.raw || ''} ${product?.name || ''} ${product?.category || ''}`);
  if (text.includes('pre emerg') || text.includes('prodiamine') || text.includes('stonewall')) return 'pre_emergent';
  if (text.includes('post emerg') || text.includes('celsius') || text.includes('sedge') || text.includes('dismiss') || text.includes('speedzone') || text.includes('weed')) return 'post_emergent';
  if (text.includes('slow release') || text.includes('polyplus') || text.includes('fert') || text.includes('nitrogen') || Number(product?.analysis_n || 0) > 0) return 'slow_release_fertilizer';
  if (text.includes('fungicide') || text.includes('frac') || text.includes('headway') || text.includes('medallion') || text.includes('armada') || text.includes('azoxy')) return 'fungicide';
  if (text.includes('insect') || text.includes('chinch') || text.includes('mole cricket') || text.includes('acelepryn') || text.includes('talstar') || text.includes('demand') || text.includes('alpine')) return 'insecticide';
  if (text.includes('bait')) return 'bait';
  if (text.includes('sweep') || text.includes('webster') || text.includes('de web')) return 'web_sweep';
  if (text.includes('inspect') || text.includes('scout') || text.includes('audit') || text.includes('sample') || text.includes('monitor')) return 'inspection';
  return 'service_action';
}

function actionLabel(kind, line, product) {
  const productName = product?.name || '';
  const raw = String(line?.raw || '').replace(/\s*\([^)]*\)\s*$/g, '').trim();
  if (kind === 'pre_emergent') return `Applied pre-emergent${productName ? ` - ${productName}` : ''}`;
  if (kind === 'post_emergent') return `Applied post-emergent${productName ? ` - ${productName}` : ''}`;
  if (kind === 'slow_release_fertilizer') return `Applied slow-release fertilizer${productName ? ` - ${productName}` : ''}`;
  if (kind === 'fungicide') return `Applied fungicide${productName ? ` - ${productName}` : ''}`;
  if (kind === 'insecticide') return `Applied insect control${productName ? ` - ${productName}` : ''}`;
  if (kind === 'bait') return raw || 'Placed bait';
  if (kind === 'web_sweep') return raw || 'Completed web sweep';
  if (kind === 'inspection') return raw || 'Completed inspection';
  return raw || productName || 'Completed protocol item';
}

// Interim scope classifier for protocol-derived actions (pest services show
// these instead of the generic chips). PR2 replaces this with explicit
// per-line metadata in protocols.json; until then this controlled keyword map
// is the fallback that lets an interior treatment fire the re-entry countdown.
function actionScopeForLine(line, product) {
  const text = normalizeText(`${line?.raw || ''} ${product?.name || ''} ${product?.category || ''}`);
  const interior = /\b(interior|inside|indoor|kitchen|bath|bathroom|baseboard|baseboards|bedroom|crack|crevice|void|voids|cabinet|pantry|closet|hinge|hinges|appliance|appliances|plumbing)\b/.test(text);
  const exterior = /\b(exterior|outside|outdoor|perimeter|foundation|eave|eaves|soffit|yard|lawn|landscape|mulch|bed|beds|lanai|patio|driveway|fence|window|windows|door|doors|entry)\b/.test(text);
  // Prioritize interior: a mixed/interior line should fire the re-entry window
  // (the conservative safety choice). Exterior is asserted by other actions/areas.
  if (interior) return 'interior';
  if (exterior) return 'exterior';
  return null;
}

function actionTreatmentApplied(kind, line) {
  if (kind === 'inspection') return false;
  const text = normalizeText(line?.raw || '');
  if (/\b(declin|no access|not treated|unavailable|skip|skipped|customer not home)\b/.test(text)) return false;
  return true;
}

function serializeProtocolProduct(product) {
  if (!product) return null;
  return {
    id: product.id,
    name: product.name,
    category: product.category,
    activeIngredient: product.active_ingredient || null,
    defaultRatePer1000: product.default_rate_per_1000 != null ? Number(product.default_rate_per_1000) : null,
    rateUnit: product.rate_unit || null,
    defaultUnit: product.rate_unit || null,
    maxLabelRatePer1000: product.max_label_rate_per_1000 != null ? Number(product.max_label_rate_per_1000) : null,
  };
}

function buildCompletionActions({ lines, products, programKey, visit }) {
  return lines.map((line, index) => {
    const product = matchCatalogProduct(line, products);
    const kind = actionKindForLine(line, product);
    const label = actionLabel(kind, line, product);
    return {
      id: `${programKey || 'protocol'}_${visit?.visit || 'visit'}_${index}`,
      kind,
      label,
      note: label,
      raw: line.raw,
      role: line.role,
      conditional: !!line.conditional,
      scope: actionScopeForLine(line, product),
      treatmentApplied: actionTreatmentApplied(kind, line),
      product: serializeProtocolProduct(product),
    };
  });
}

async function getProtocolProducts() {
  return db('products_catalog')
    .where(function () {
      this.where({ active: true }).orWhereNull('active');
    })
    .select(
      'id', 'name', 'category', 'active_ingredient', 'moa_group',
      'frac_group', 'irac_group', 'hrac_group',
      'analysis_n', 'analysis_p', 'analysis_k',
      'default_rate_per_1000', 'rate_unit',
      'best_price', 'cost_per_unit', 'cost_unit', 'container_size', 'unit_size_oz', 'needs_pricing',
      'mixing_order_category', 'mixing_instructions',
      'label_verified_at', 'rainfast_minutes', 'rei_hours',
      'labeled_turf_species', 'excluded_turf_species',
      'requires_surfactant', 'allows_surfactant',
      'label_source_note',
    )
    .catch(() => []);
}

async function getActiveCalibration(equipmentSystemId) {
  const query = db('equipment_calibrations as ec')
    .join('equipment_systems as es', 'ec.equipment_system_id', 'es.id')
    .where('ec.active', true)
    .where('es.active', true)
    .select(
      'ec.*',
      'es.name as system_name',
      'es.system_type',
      'es.tank_capacity_gal',
      'es.default_application_type',
    )
    .orderByRaw("case when es.name ilike '110-Gallon Spray Tank #1%' then 0 when es.system_type = 'tank' then 1 else 2 end")
    .orderBy('es.name', 'asc');

  if (equipmentSystemId) query.where('ec.equipment_system_id', equipmentSystemId);
  return query.first().catch(() => null);
}

// GET /api/admin/protocols/photos/relevant — context-aware photo references
router.get('/photos/relevant', async (req, res, next) => {
  try {
    const { serviceType, grassType, month } = req.query;
    const currentMonth = month ? parseInt(month) : new Date().getMonth() + 1;

    let query = db('protocol_photos').where({ active: true });

    if (serviceType) {
      const line = serviceType.toLowerCase().includes('lawn') ? 'lawn'
        : serviceType.toLowerCase().includes('tree') || serviceType.toLowerCase().includes('shrub') ? 'tree_shrub'
        : serviceType.toLowerCase().includes('pest') ? 'pest'
        : serviceType.toLowerCase().includes('mosquito') ? 'mosquito'
        : serviceType.toLowerCase().includes('termite') ? 'termite' : null;
      if (line) query = query.whereRaw("service_lines::text ILIKE ?", [`%${line}%`]);
    }

    const photos = await query.orderBy('sort_order');

    // Filter by month relevance
    const filtered = photos.filter(p => {
      const months = typeof p.months_relevant === 'string' ? JSON.parse(p.months_relevant) : p.months_relevant;
      if (!months || !Array.isArray(months)) return true;
      return months.includes(currentMonth);
    });

    res.json({ photos: filtered.map(p => ({
      id: p.id, category: p.category, name: p.name, description: p.description,
      photoUrl: p.photo_url, tags: p.tags, serviceLine: p.service_lines,
    }))});
  } catch (err) { next(err); }
});

// GET /api/admin/protocols/photos — all photos
router.get('/photos', async (req, res, next) => {
  try {
    const { category, tag } = req.query;
    let query = db('protocol_photos').where({ active: true }).orderBy('category').orderBy('sort_order');
    if (category) query = query.where({ category });
    if (tag) query = query.whereRaw("tags::text ILIKE ?", [`%${tag}%`]);
    const photos = await query;
    res.json({ photos });
  } catch (err) { next(err); }
});

// GET /api/admin/protocols/seasonal-index
router.get('/seasonal-index', async (req, res, next) => {
  try {
    const month = parseInt(req.query.month || new Date().getMonth() + 1);
    const { service_line } = req.query;
    let query = db('seasonal_pest_index').where({ month });
    if (service_line) query = query.where({ service_line });
    const index = await query.orderBy('sort_order');
    res.json({ month, pests: index });
  } catch (err) { next(err); }
});

// GET /api/admin/protocols/scripts
router.get('/scripts', async (req, res, next) => {
  try {
    const { scenario, service_line } = req.query;
    let query = db('communication_scripts').where({ active: true });
    if (scenario) query = query.where({ scenario });
    if (service_line) query = query.where(function () { this.where({ service_line }).orWhere({ service_line: 'general' }); });
    const scripts = await query.orderBy('sort_order');
    res.json({ scripts });
  } catch (err) { next(err); }
});

// GET /api/admin/protocols/equipment
router.get('/equipment', async (req, res, next) => {
  try {
    const { service_type, service_line } = req.query;
    let query = db('equipment_checklists');
    if (service_line) query = query.where({ service_line });
    if (service_type) query = query.whereILike('service_type', `%${service_type}%`);
    const checklists = await query;
    res.json({ checklists: checklists.map(c => ({
      ...c, checklist_items: typeof c.checklist_items === 'string' ? JSON.parse(c.checklist_items) : c.checklist_items,
    }))});
  } catch (err) { next(err); }
});

// GET /api/admin/protocols/match — best service template plus full program fallback.
router.get('/match', async (req, res, next) => {
  try {
    const protocols = require('../config/protocols.json');
    const serviceType = req.query.serviceType || req.query.service_type || '';
    const result = matchServiceProtocol(protocols, serviceType);

    if (!result.program) return res.status(404).json({ error: 'Protocol program not found' });

    res.json({
      serviceType,
      programKey: result.programKey,
      program: result.program,
      matchedVisit: result.matchedVisit,
      matched: result.matched,
      reason: result.reason,
    });
  } catch (err) { next(err); }
});

// GET /api/admin/protocols/lawn-mix — generic tech-facing protocol preview.
router.get('/lawn-mix', async (req, res, next) => {
  try {
    const protocols = require('../config/protocols.json');
    const trackKey = TRACK_MAP[req.query.track] || req.query.track || 'st_augustine';
    const track = protocols.lawn?.[trackKey];
    if (!track) return res.status(404).json({ error: 'Lawn protocol track not found' });

    const month = monthAbbr(req.query.month);
    const visit = track.visits?.find((v) => v.month === month);
    if (!visit) return res.status(404).json({ error: 'Protocol visit not found for month' });

    const areaSqft = Math.max(0, Number(req.query.lawnSqft || 10000));
    const calibration = await getActiveCalibration(req.query.equipmentSystemId || null);
    const calibrationExpired = !!(
      calibration?.expires_at && new Date(calibration.expires_at) < new Date()
    );
    const products = await getProtocolProducts();
    const baseLines = parseProtocolLines(visit.primary, 'base');
    const conditionalLines = parseProtocolLines(visit.secondary, 'conditional');
    const allLines = [...baseLines, ...conditionalLines];
    const nutrientTargets = parseVisitNutrientTargets(visit.notes);

    const resolvedLines = resolveProtocolItems(allLines, products, {
      selectedConditionalProductIds: req.query.selectedConditionalProductIds,
      selectedConditionalProductNames: req.query.selectedConditionalProductNames,
      selectedConditionalRaw: req.query.selectedConditionalRaw,
      soilPIndex: req.query.soilPIndex,
      plan: req.query.plan,
      conditionFlags: req.query.conditionFlags,
      propertyFlags: req.query.propertyFlags,
      includePremiumOnly: req.query.includePremiumOnly === 'true',
    });

    const items = resolvedLines.map((line) => {
      const product = line.product;
      const selected = line.selected;
      const carrier = calibrationExpired ? 0 : Number(calibration?.carrier_gal_per_1000 || 0);
      const areaFactor = effectiveAreaFactor(line, {
        plan: req.query.plan,
        weedPressure: req.query.weedPressure,
        conditionFlags: req.query.conditionFlags,
        propertyFlags: req.query.propertyFlags,
        includePremiumOnly: req.query.includePremiumOnly === 'true',
        isFirstYear: req.query.isFirstYear == null ? undefined : req.query.isFirstYear !== 'false',
      });
      const jobMix = selected && product && carrier
        ? calculateProductAmount({ product, lawnSqft: areaSqft, carrierGalPer1000: carrier, areaFactor, ...nutrientTargets })
        : null;
      const tankCapacity = Number(calibration?.tank_capacity_gal || 0);
      const tankCoverageSqft = carrier && tankCapacity ? (tankCapacity / carrier) * 1000 : 0;
      const fullTankMix = selected && product && carrier && tankCoverageSqft
        ? calculateProductAmount({ product, lawnSqft: tankCoverageSqft, carrierGalPer1000: carrier, ...nutrientTargets })
        : null;

      return {
        raw: line.raw,
        role: line.role,
        conditional: line.conditional,
        scope: line.scope,
        conditionFlag: line.conditionFlag,
        branchGroupId: line.branchGroupId,
        branch: line.branch || null,
        areaFactorDefault: line.areaFactorDefault,
        areaFactorClean: line.areaFactorClean,
        areaFactorHeavy: line.areaFactorHeavy,
        areaFactorBroadcast: line.areaFactorBroadcast,
        selectionReason: line.selectionReason,
        selected,
        matched: !!product,
        product: product ? {
          id: product.id,
          name: product.name,
          category: product.category,
          activeIngredient: product.active_ingredient,
          groups: {
            moa: product.moa_group || null,
            frac: product.frac_group || null,
            irac: product.irac_group || null,
            hrac: product.hrac_group || null,
          },
          labelVerifiedAt: product.label_verified_at || null,
          bestPrice: product.best_price != null ? Number(product.best_price) : null,
          costPerUnit: product.cost_per_unit != null ? Number(product.cost_per_unit) : null,
          costUnit: product.cost_unit || null,
          containerSize: product.container_size || null,
          unitSizeOz: product.unit_size_oz != null ? Number(product.unit_size_oz) : null,
          needsPricing: product.needs_pricing === true,
          rainfastMinutes: product.rainfast_minutes || null,
          reiHours: product.rei_hours || null,
          labeledTurfSpecies: product.labeled_turf_species || [],
          excludedTurfSpecies: product.excluded_turf_species || [],
          requiresSurfactant: product.requires_surfactant,
          allowsSurfactant: product.allows_surfactant,
          mixingOrderCategory: product.mixing_order_category,
          mixingInstructions: product.mixing_instructions,
          labelSourceNote: product.label_source_note,
        } : null,
        jobMix,
        fullTankMix,
      };
    });

    const selectedItems = items.filter((item) => item.selected);
    const materialCostSummary = summarizeMaterialCost(selectedItems.map((item) => ({
      selected: item.selected,
      product: item.product,
      mix: item.jobMix,
    })));
    const warnings = [];
    if (!calibration) {
      warnings.push({
        code: 'missing_calibration',
        message: 'No active calibration was found for the selected equipment. Mix amounts require a current carrier rate.',
      });
    }
    if (calibrationExpired) {
      warnings.push({
        code: 'expired_calibration',
        message: `Calibration for ${calibration.system_name || 'selected equipment'} is expired. Mix amounts are withheld until the rig is recalibrated.`,
      });
    }
    if (items.some((item) => !item.matched)) {
      warnings.push({
        code: 'unmatched_product',
        message: 'Some protocol lines do not match a product catalog row yet; label-rate math is unavailable for those lines.',
      });
    }

    res.json({
      track: { key: trackKey, name: track.name },
      month,
      visit: {
        visit: visit.visit,
        objective: visit.notes,
        primary: visit.primary,
        secondary: visit.secondary,
        tiers: visit.tiers,
      },
      equipment: calibration ? {
        equipmentSystemId: calibration.equipment_system_id,
        calibrationId: calibration.id,
        systemName: calibration.system_name,
        systemType: calibration.system_type,
        carrierGalPer1000: Number(calibration.carrier_gal_per_1000),
        tankCapacityGal: calibration.tank_capacity_gal ? Number(calibration.tank_capacity_gal) : null,
        tankCoverageSqft: calibration.tank_capacity_gal && calibration.carrier_gal_per_1000
          ? Math.round((Number(calibration.tank_capacity_gal) / Number(calibration.carrier_gal_per_1000)) * 1000)
          : null,
        expiresAt: calibration.expires_at || null,
      } : null,
      areaSqft,
      materialCostSummary,
      items,
      selectedItems,
      mixingOrder: buildMixOrder(selectedItems.map((item) => ({
        raw: item.raw,
        product: products.find((p) => String(p.id) === String(item.product?.id)) || null,
      }))),
      warnings,
    });
  } catch (err) { next(err); }
});

// GET /api/admin/protocols/completion-actions — targeted completion chips
// derived from the protocol program + matched product catalog rows.
router.get('/completion-actions', async (req, res, next) => {
  try {
    const protocols = require('../config/protocols.json');
    const serviceType = req.query.serviceType || req.query.service_type || '';
    const products = await getProtocolProducts();
    let programKey;
    let program;
    let visit;
    let track = null;
    let month = null;

    if (normalizeText(serviceType).includes('lawn')) {
      programKey = 'lawn';
      track = lawnTrackFromInput(req.query.lawnType || req.query.grassType || req.query.track);
      program = protocols.lawn?.[track] || protocols.lawn?.st_augustine;
      month = monthAbbr(req.query.month);
      visit = program?.visits?.find((v) => v.month === month) || program?.visits?.[0] || null;
    } else {
      const matched = matchServiceProtocol(protocols, serviceType);
      programKey = matched.programKey;
      program = matched.program;
      visit = matched.matchedVisit || program?.visits?.[0] || null;
    }

    if (!program || !visit) return res.status(404).json({ error: 'Protocol actions not found' });

    const baseLines = parseProtocolLines(visit.primary, 'base');
    const conditionalLines = parseProtocolLines(visit.secondary, 'conditional');
    const actions = buildCompletionActions({
      lines: [...baseLines, ...conditionalLines],
      products,
      programKey,
      visit,
    });

    res.json({
      serviceType,
      programKey,
      track,
      month,
      programName: program.name,
      visit: {
        visit: visit.visit,
        month: visit.month,
        objective: visit.notes,
      },
      actions,
    });
  } catch (err) { next(err); }
});

// GET /api/admin/protocols/product-label/:productId
router.get('/product-label/:productId', async (req, res, next) => {
  try {
    const product = await db('products_catalog').where({ id: req.params.productId }).first();
    if (!product) return res.status(404).json({ error: 'Product not found' });
    res.json({
      name: product.name, category: product.category,
      activeIngredient: product.active_ingredient, moaGroup: product.moa_group,
      signalWord: product.signal_word, reiHours: product.rei_hours,
      rainFreeHours: product.rain_free_hours, minTempF: product.min_temp_f,
      maxTempF: product.max_temp_f, maxWindMph: product.max_wind_mph,
      dilutionRate: product.dilution_rate, mixingInstructions: product.mixing_instructions,
      ppeRequired: product.ppe_required, restrictedUse: product.restricted_use,
      maximumAnnualRate: product.maximum_annual_rate,
      reapplicationIntervalDays: product.reapplication_interval_days,
      pollinatorPrecautions: product.pollinator_precautions,
      aquaticBufferFt: product.aquatic_buffer_ft,
      compatibilityNotes: product.compatibility_notes,
    });
  } catch (err) { next(err); }
});

// GET /api/admin/protocols/programs — WaveGuard lawn + service-line protocols
router.get('/programs', async (req, res, next) => {
  try {
    const protocols = require('../config/protocols.json');
    const { track, program } = req.query;

    if (program && PROGRAM_KEYS.includes(program) && protocols[program]) {
      return res.json({ program: protocols[program] });
    }

    // Backward compat: map old track letters to new keys
    const TRACK_MAP = { A_St_Aug_Sun: 'st_augustine', B_St_Aug_Shade: 'st_augustine', C1_Bermuda: 'bermuda', C2_Zoysia: 'zoysia', D_Bahia: 'bahia' };
    const resolvedTrack = TRACK_MAP[track] || track;
    if (resolvedTrack && protocols.lawn[resolvedTrack]) {
      return res.json({ track: protocols.lawn[resolvedTrack] });
    }

    // Return summary of all tracks
    const summary = Object.entries(protocols.lawn).map(([key, t]) => ({
      key, name: t.name, visits: t.visits.length, notes: t.notes.length,
    }));

    res.json({
      lawn: { tracks: summary },
      programs: PROGRAM_KEYS.map((key) => programSummary(key, protocols[key])).filter(Boolean),
      tree_shrub: programSummary('tree_shrub', protocols.tree_shrub),
      pest: programSummary('pest', protocols.pest),
      termite: programSummary('termite', protocols.termite),
    });
  } catch (err) { next(err); }
});

// GET /api/admin/protocols/programs/:track/visit/:num
router.get('/programs/:track/visit/:num', async (req, res, next) => {
  try {
    const protocols = require('../config/protocols.json');
    const { track, num } = req.params;

    if (track === 'tree_shrub') {
      const visit = protocols.tree_shrub.visits.find(v => v.visit === parseInt(num));
      return res.json({ visit, notes: protocols.tree_shrub.notes });
    }

    const VISIT_TRACK_MAP = { A_St_Aug_Sun: 'st_augustine', B_St_Aug_Shade: 'st_augustine', C1_Bermuda: 'bermuda', C2_Zoysia: 'zoysia', D_Bahia: 'bahia' };
    const resolvedVisitTrack = VISIT_TRACK_MAP[track] || track;
    const trackData = protocols.lawn[resolvedVisitTrack];
    if (!trackData) return res.status(404).json({ error: 'Track not found' });

    const visit = trackData.visits.find(v => v.visit === parseInt(num));
    res.json({ visit, trackName: trackData.name, notes: trackData.notes });
  } catch (err) { next(err); }
});

module.exports = router;
