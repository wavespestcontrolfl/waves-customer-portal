const express = require('express');
const router = express.Router();
const db = require('../models/db');
const { adminAuthenticate, requireTechOrAdmin } = require('../middleware/admin-auth');

router.use(adminAuthenticate, requireTechOrAdmin);

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

    if (track && protocols.lawn[track]) {
      return res.json({ track: protocols.lawn[track] });
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

    const trackData = protocols.lawn[track];
    if (!trackData) return res.status(404).json({ error: 'Track not found' });

    const visit = trackData.visits.find(v => v.visit === parseInt(num));
    res.json({ visit, trackName: trackData.name, notes: trackData.notes });
  } catch (err) { next(err); }
});

module.exports = router;
