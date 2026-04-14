const express = require('express');
const router = express.Router();
const db = require('../models/db');
const { adminAuthenticate, requireTechOrAdmin } = require('../middleware/admin-auth');

router.use(adminAuthenticate, requireTechOrAdmin);

async function ensureTable() {
  if (!(await db.schema.hasTable('pricing_config'))) {
    await db.schema.createTable('pricing_config', t => {
      t.uuid('id').primary().defaultTo(db.raw('gen_random_uuid()'));
      t.string('config_key', 80).unique().notNullable();
      t.string('name', 200).notNullable();
      t.string('category', 30).notNullable();
      t.jsonb('data').notNullable();
      t.text('description');
      t.integer('sort_order').defaultTo(100);
      t.timestamps(true, true);
    });
    const configs = [
      { config_key: 'pest_base', name: 'Pest Control Base Price', category: 'pest', sort_order: 1, data: JSON.stringify({ base: 117, floor: 89 }) },
      { config_key: 'pest_footprint', name: 'Pest Footprint Modifiers', category: 'pest', sort_order: 2, data: JSON.stringify({ breakpoints: [{sqft:800,adj:-20},{sqft:1200,adj:-12},{sqft:1500,adj:-6},{sqft:2000,adj:0},{sqft:2500,adj:6},{sqft:3000,adj:12},{sqft:4000,adj:20},{sqft:5500,adj:28}] }) },
      { config_key: 'pest_features', name: 'Pest Feature Modifiers', category: 'pest', sort_order: 3, data: JSON.stringify({ pool_cage:10,pool_no_cage:5,shrubs_heavy:10,shrubs_moderate:5,shrubs_light:-5,trees_heavy:10,trees_moderate:5,trees_light:-5,landscape_complex:5,near_water:5,large_driveway:5,indoor:10 }) },
      { config_key: 'pest_property_type', name: 'Pest Property Type', category: 'pest', sort_order: 4, data: JSON.stringify({ single_family:0,townhome_end:-8,townhome_interior:-15,duplex:-10,condo_ground:-20,condo_upper:-25 }) },
      { config_key: 'pest_service_costs', name: 'Pest Service Cost Breakdown', category: 'pest', sort_order: 5, data: JSON.stringify({ chemicals:{ taurus_sc:{ bottle_price:95.00, bottle_oz:78, oz_per_service:4, cost_per_service:4.87 }, talak:{ bottle_price:41.57, bottle_oz:128, oz_per_service:4, cost_per_service:1.30 }}, labor:{ spray_minutes:10, sweep_minutes:10, total_minutes:20, rate_per_hour:35, cost_per_service:11.67 }, total_cost_per_service:17.84 }), description: 'Per-service chemical cost + labor time breakdown' },
      { config_key: 'waveguard_tiers', name: 'WaveGuard Bundle Discounts', category: 'waveguard', sort_order: 10, data: JSON.stringify({ bronze:{min_services:1,discount:0},silver:{min_services:2,discount:0.10},gold:{min_services:3,discount:0.15},platinum:{min_services:4,discount:0.20} }) },
      { config_key: 'waveguard_membership', name: 'WaveGuard Membership Fee', category: 'waveguard', sort_order: 11, data: JSON.stringify({ fee:99, waived_with_prepay:true }) },
      { config_key: 'lawn_st_augustine', name: 'St. Augustine', category: 'lawn', sort_order: 20, data: JSON.stringify([[0,35,45,55,65],[3000,35,45,55,65],[3500,35,45,55,68],[4000,35,45,55,73],[5000,35,45,59,84],[6000,35,46,66,96],[7000,38,50,73,107],[8000,41,55,80,118],[10000,47,64,94,140],[12000,54,73,109,162],[15000,63,86,130,195],[20000,80,108,165,250]]) },
      // Zone multipliers
      { config_key: 'zone_multipliers', name: 'Service Zone Multipliers', category: 'zone', sort_order: 1, data: JSON.stringify({ A: { name: 'Manatee/Sarasota core', multiplier: 1.00 }, B: { name: 'Extended service area', multiplier: 1.05 }, C: { name: 'Charlotte outskirts', multiplier: 1.10 }, UNKNOWN: { name: 'Default', multiplier: 1.05 } }) },

      // Global constants
      { config_key: 'global_labor_rate', name: 'Loaded Labor Rate', category: 'global', sort_order: 1, data: JSON.stringify({ value: 35, unit: '$/hr', description: 'Wages + benefits + WC + vehicle + insurance' }) },
      { config_key: 'global_drive_time', name: 'Average Drive Time', category: 'global', sort_order: 2, data: JSON.stringify({ value: 20, unit: 'min', description: 'Average drive time per visit (Zone A)' }) },
      { config_key: 'global_admin_annual', name: 'Admin Cost Allocation', category: 'global', sort_order: 3, data: JSON.stringify({ value: 51, unit: '$/service/yr', description: 'Annual admin overhead per service line' }) },
      { config_key: 'global_margin_floor', name: 'Margin Floor', category: 'global', sort_order: 4, data: JSON.stringify({ value: 0.35, unit: 'ratio', description: 'Minimum acceptable contribution margin' }) },
      { config_key: 'global_margin_target_ts', name: 'T&S Margin Target', category: 'global', sort_order: 5, data: JSON.stringify({ value: 0.43, unit: 'ratio', description: 'Tree & Shrub margin target' }) },
      { config_key: 'global_conditional_ceiling', name: 'Conditional Material Ceiling', category: 'global', sort_order: 6, data: JSON.stringify({ value: 60, unit: '$/property/yr', description: 'Max conditional material spend before reprice flag' }) },

      // Tree & Shrub
      { config_key: 'ts_material_rates', name: 'T&S Material Rates per SqFt', category: 'tree_shrub', sort_order: 1, data: JSON.stringify({ '6x_standard': 0.110, '9x_enhanced': 0.190, '12x_premium': 0.220 }) },
      { config_key: 'ts_monthly_floors', name: 'T&S Monthly Floor Prices', category: 'tree_shrub', sort_order: 2, data: JSON.stringify({ standard: 50, enhanced: 65, premium: 80 }) },

      // Palm
      { config_key: 'palm_pricing', name: 'Palm Injection Tiered Pricing', category: 'palm', sort_order: 1, data: JSON.stringify({ nutrition: 35, preventive_insecticide: 45, combo: 55, fungal: 40, lethal_bronzing_floor: 125, tree_age_floor: 65 }) },

      // Mosquito
      { config_key: 'mosquito_lot_sizes', name: 'Mosquito Lot Size Categories', category: 'mosquito', sort_order: 1, data: JSON.stringify({ SMALL: { max_sqft: 5000 }, QUARTER: { max_sqft: 10890 }, THIRD: { max_sqft: 14520 }, HALF: { max_sqft: 21780 }, ACRE: { max_sqft: 43560 } }) },

      // Termite
      { config_key: 'termite_install', name: 'Termite Install Multiplier', category: 'termite', sort_order: 1, data: JSON.stringify({ multiplier: 1.75, advance_bait: 14, trelona_bait: 24, labor_per_station: 5.25, misc_per_station: 0.75 }) },
      { config_key: 'termite_monitoring', name: 'Termite Monitoring Monthly', category: 'termite', sort_order: 2, data: JSON.stringify({ basic: 35, premier: 65 }) },

      // Rodent
      { config_key: 'rodent_monthly', name: 'Rodent Monthly Tiers', category: 'rodent', sort_order: 1, data: JSON.stringify({ small: 75, medium: 89, large: 109 }) },
      { config_key: 'rodent_trapping', name: 'Rodent Trapping Base', category: 'rodent', sort_order: 2, data: JSON.stringify({ base: 350 }) },

      // One-time
      { config_key: 'onetime_urgency', name: 'Urgency Multipliers', category: 'one_time', sort_order: 1, data: JSON.stringify({ routine: 1.0, soon: 1.25, soon_after_hours: 1.50, urgent: 1.50, urgent_after_hours: 2.0 }) },
      { config_key: 'onetime_recurring_discount', name: 'Recurring Customer Discount', category: 'one_time', sort_order: 2, data: JSON.stringify({ multiplier: 0.85 }) },
      { config_key: 'onetime_trenching', name: 'Trenching Rates', category: 'one_time', sort_order: 3, data: JSON.stringify({ per_lf_dirt: 10, per_lf_concrete: 14, floor: 600 }) },
      { config_key: 'onetime_boracare', name: 'Bora-Care Constants', category: 'one_time', sort_order: 4, data: JSON.stringify({ bc_gal: 91.98, bc_cov: 275, bc_equip: 17.50 }) },
      { config_key: 'onetime_preslab', name: 'Pre-Slab Termidor', category: 'one_time', sort_order: 5, data: JSON.stringify({ ps_btl: 174.72, ps_cov: 1250, ps_equip: 15 }) },
      { config_key: 'onetime_exclusion', name: 'Exclusion Point Pricing', category: 'one_time', sort_order: 6, data: JSON.stringify({ simple: 37.50, moderate: 75, advanced: 150 }) },
    ];
    for (const c of configs) { await db('pricing_config').insert(c).onConflict('config_key').ignore(); }
  }
}

// GET / — all pricing configs
router.get('/', async (req, res, next) => {
  try {
    await ensureTable();
    const { category } = req.query;
    let query = db('pricing_config').orderBy('category').orderBy('sort_order');
    if (category) query = query.where({ category });
    const configs = await query;
    res.json({ configs: configs.map(c => ({ ...c, data: typeof c.data === 'string' ? JSON.parse(c.data) : c.data })) });
  } catch (err) { next(err); }
});

// --- Specific routes MUST come before /:key wildcard ---

// GET /lawn-brackets — all lawn_pricing_brackets grouped by grass_track
router.get('/lawn-brackets', async (req, res, next) => {
  try {
    const rows = await db('lawn_pricing_brackets').orderBy('grass_track').orderBy('sqft_bracket');
    const tracks = {};
    for (const r of rows) {
      if (!tracks[r.grass_track]) tracks[r.grass_track] = [];
      tracks[r.grass_track].push(r);
    }
    res.json({ tracks });
  } catch (err) {
    // Table may not exist yet
    res.json({ tracks: {} });
  }
});

// PUT /lawn-brackets/:track — update brackets for a track
router.put('/lawn-brackets/:track', async (req, res, next) => {
  try {
    const { brackets } = req.body; // array of { sqft_bracket, tier, monthly_price }
    for (const b of brackets) {
      await db('lawn_pricing_brackets')
        .where({ grass_track: req.params.track, sqft_bracket: b.sqft_bracket, tier: b.tier })
        .update({ monthly_price: b.monthly_price, updated_at: new Date() });
    }
    res.json({ success: true });
  } catch (err) { next(err); }
});

// GET /discount-rules — all service_discount_rules
router.get('/discount-rules', async (req, res, next) => {
  try {
    const rules = await db('service_discount_rules').orderBy('service_key');
    res.json({ rules });
  } catch (err) {
    res.json({ rules: [] });
  }
});

// PUT /discount-rules/:serviceKey — update a service discount rule
router.put('/discount-rules/:serviceKey', async (req, res, next) => {
  try {
    const updates = {};
    const allowed = ['tier_qualifier', 'max_discount_pct', 'flat_credit', 'flat_credit_min_tier', 'exclude_from_pct_discount', 'notes'];
    for (const k of allowed) {
      if (req.body[k] !== undefined) updates[k] = req.body[k];
    }
    updates.updated_at = new Date();
    await db('service_discount_rules').where({ service_key: req.params.serviceKey }).update(updates);
    res.json({ success: true });
  } catch (err) { next(err); }
});

// GET /audit-log — recent pricing config audit entries
router.get('/audit-log', async (req, res, next) => {
  try {
    const limit = parseInt(req.query.limit) || 50;
    const logs = await db('pricing_config_audit').orderBy('changed_at', 'desc').limit(limit);
    res.json({ logs });
  } catch (err) {
    res.json({ logs: [] });
  }
});

// --- Wildcard routes below ---

// GET /:key — single config by key
router.get('/:key', async (req, res, next) => {
  try {
    const config = await db('pricing_config').where({ config_key: req.params.key }).first();
    if (!config) return res.status(404).json({ error: 'Config not found' });
    config.data = typeof config.data === 'string' ? JSON.parse(config.data) : config.data;
    res.json(config);
  } catch (err) { next(err); }
});

// PUT /:key — update config data (with audit logging)
router.put('/:key', async (req, res, next) => {
  try {
    const { data, name, description, reason } = req.body;

    // Get old value for audit
    const oldConfig = await db('pricing_config').where({ config_key: req.params.key }).first();
    if (!oldConfig) return res.status(404).json({ error: 'Config not found' });

    const updates = { updated_at: new Date() };
    if (data !== undefined) updates.data = JSON.stringify(data);
    if (name !== undefined) updates.name = name;
    if (description !== undefined) updates.description = description;

    await db('pricing_config').where({ config_key: req.params.key }).update(updates);

    // Audit log
    if (data !== undefined) {
      try {
        await db('pricing_config_audit').insert({
          config_key: req.params.key,
          old_value: JSON.stringify(oldConfig.data),
          new_value: JSON.stringify(data),
          changed_by: req.admin?.name || 'admin',
          reason: reason || null
        });
      } catch { /* audit table may not exist */ }
    }

    res.json({ success: true });
  } catch (err) { next(err); }
});

module.exports = router;
