const express = require('express');
const router = express.Router();
const db = require('../models/db');
const { adminAuthenticate, requireTechOrAdmin } = require('../middleware/admin-auth');
const { etParts } = require('../utils/datetime-et');
const {
  buildMixOrder,
  calculateProductAmount,
  matchCatalogProduct,
  parseProtocolLines,
  isConditionalSelected,
} = require('../services/waveguard-plan-engine');

router.use(adminAuthenticate, requireTechOrAdmin);

const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const TRACK_MAP = {
  A_St_Aug_Sun: 'st_augustine',
  B_St_Aug_Shade: 'st_augustine',
  C1_Bermuda: 'bermuda',
  C2_Zoysia: 'zoysia',
  D_Bahia: 'bahia',
};

function monthAbbr(value) {
  const n = parseInt(value, 10);
  if (Number.isFinite(n) && n >= 1 && n <= 12) return MONTH_ABBR[n - 1];
  const raw = String(value || '').slice(0, 3).toLowerCase();
  return MONTH_ABBR.find((m) => m.toLowerCase() === raw) || MONTH_ABBR[etParts(new Date()).month - 1];
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

    const items = allLines.map((line) => {
      const product = matchCatalogProduct(line, products);
      const selected = isConditionalSelected({ ...line, product }, {
        selectedConditionalProductIds: req.query.selectedConditionalProductIds,
        selectedConditionalProductNames: req.query.selectedConditionalProductNames,
        selectedConditionalRaw: req.query.selectedConditionalRaw,
      });
      const carrier = calibrationExpired ? 0 : Number(calibration?.carrier_gal_per_1000 || 0);
      const jobMix = selected && product && carrier
        ? calculateProductAmount({ product, lawnSqft: areaSqft, carrierGalPer1000: carrier })
        : null;
      const tankCapacity = Number(calibration?.tank_capacity_gal || 0);
      const tankCoverageSqft = carrier && tankCapacity ? (tankCapacity / carrier) * 1000 : 0;
      const fullTankMix = selected && product && carrier && tankCoverageSqft
        ? calculateProductAmount({ product, lawnSqft: tankCoverageSqft, carrierGalPer1000: carrier })
        : null;

      return {
        raw: line.raw,
        role: line.role,
        conditional: line.conditional,
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

// GET /api/admin/protocols/programs — WaveGuard lawn + T&S protocols
router.get('/programs', async (req, res, next) => {
  try {
    const protocols = require('../config/protocols.json');
    const { track, program } = req.query;

    if (program === 'tree_shrub') {
      return res.json({ program: protocols.tree_shrub });
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
      tree_shrub: { name: protocols.tree_shrub.name, visits: protocols.tree_shrub.visits.length },
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
