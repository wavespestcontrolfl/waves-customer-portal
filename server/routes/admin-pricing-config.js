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
      { config_key: 'pest_features', name: 'Pest Feature Modifiers', category: 'pest', sort_order: 3, data: JSON.stringify({ pool_cage:10,pool_no_cage:5,shrubs_heavy:10,shrubs_moderate:5,trees_heavy:10,trees_moderate:5,landscape_complex:5,near_water:5,large_driveway:5 }) },
      { config_key: 'pest_property_type', name: 'Pest Property Type', category: 'pest', sort_order: 4, data: JSON.stringify({ single_family:0,townhome_end:-8,townhome_interior:-15,duplex:-10,condo_ground:-20,condo_upper:-25 }) },
      { config_key: 'waveguard_tiers', name: 'WaveGuard Bundle Discounts', category: 'waveguard', sort_order: 10, data: JSON.stringify({ bronze:{min_services:1,discount:0},silver:{min_services:2,discount:0.10},gold:{min_services:3,discount:0.15},platinum:{min_services:4,discount:0.20} }) },
      { config_key: 'waveguard_membership', name: 'WaveGuard Membership Fee', category: 'waveguard', sort_order: 11, data: JSON.stringify({ fee:99, waived_with_prepay:true }) },
      { config_key: 'lawn_track_a', name: 'Track A — St. Augustine Full Sun', category: 'lawn', sort_order: 20, data: JSON.stringify([[0,35,45,55,65],[3000,35,45,55,65],[3500,35,45,55,68],[4000,35,45,55,73],[5000,35,45,59,84],[6000,35,46,66,96],[7000,38,50,73,107],[8000,41,55,80,118],[10000,47,64,94,140],[12000,54,73,109,162],[15000,63,86,130,195],[20000,80,108,165,250]]) },
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

// GET /:key — single config by key
router.get('/:key', async (req, res, next) => {
  try {
    const config = await db('pricing_config').where({ config_key: req.params.key }).first();
    if (!config) return res.status(404).json({ error: 'Config not found' });
    config.data = typeof config.data === 'string' ? JSON.parse(config.data) : config.data;
    res.json(config);
  } catch (err) { next(err); }
});

// PUT /:key — update config data
router.put('/:key', async (req, res, next) => {
  try {
    const { data, name, description } = req.body;
    const updates = { updated_at: new Date() };
    if (data !== undefined) updates.data = JSON.stringify(data);
    if (name !== undefined) updates.name = name;
    if (description !== undefined) updates.description = description;
    const updated = await db('pricing_config').where({ config_key: req.params.key }).update(updates);
    if (!updated) return res.status(404).json({ error: 'Config not found' });
    res.json({ success: true });
  } catch (err) { next(err); }
});

module.exports = router;
