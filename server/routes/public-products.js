const express = require('express');
const router = express.Router();
const db = require('../models/db');

// GET / — Public product registry export
// Returns only products approved for public display, grouped by service line.
// No auth required. Consumed by Astro at build time for /products-and-safety/.
router.get('/', async (req, res, next) => {
  try {
    const products = await db('products_catalog')
      .where({
        active: true,
        customer_visibility: 'public',
        content_status: 'approved_for_public',
      })
      .select(
        'id', 'name', 'common_name', 'category', 'active_ingredient',
        'formulation', 'epa_reg_number', 'signal_word',
        'public_summary', 'customer_safety_summary', 'pet_kid_guidance_text',
        'target_pests', 'application_zones',
        'reentry_text', 'rainfast_minutes',
        'label_url', 'sds_url',
        'updated_at'
      )
      .orderBy('name');

    const usageMappings = await db('service_product_usage')
      .whereIn('product_id', products.map((p) => p.id))
      .select('product_id', 'service_type', 'is_primary');

    // Map product_id -> { service_type -> is_primary } so a product can be a
    // primary product for one service line and a secondary for another.
    const productServiceMap = {};
    for (const m of usageMappings) {
      if (!productServiceMap[m.product_id]) productServiceMap[m.product_id] = {};
      // If a duplicate (product, service_type) row exists, keep primary if any.
      productServiceMap[m.product_id][m.service_type] =
        productServiceMap[m.product_id][m.service_type] || Boolean(m.is_primary);
    }

    const serviceGroupMap = {};
    for (const p of products) {
      const serviceTypes = productServiceMap[p.id]
        ? Object.keys(productServiceMap[p.id])
        : ['General'];
      for (const st of serviceTypes) {
        if (!serviceGroupMap[st]) {
          serviceGroupMap[st] = {
            serviceType: st,
            slug: st.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-+$/, ''),
            products: [],
          };
        }
        serviceGroupMap[st].products.push({
          name: p.name,
          commonName: p.common_name || null,
          category: p.category,
          activeIngredient: p.active_ingredient,
          formulation: p.formulation,
          epaRegNumber: p.epa_reg_number || null,
          signalWord: p.signal_word || null,
          targetPests: p.target_pests || [],
          applicationZones: p.application_zones || [],
          publicSummary: p.public_summary || null,
          customerSafetySummary: p.customer_safety_summary || null,
          petKidGuidanceText: p.pet_kid_guidance_text || null,
          rainfastMinutes: p.rainfast_minutes || null,
          reentryText: p.reentry_text || null,
          labelUrl: p.label_url || null,
          sdsUrl: p.sds_url || null,
          isPrimary: (productServiceMap[p.id] && productServiceMap[p.id][st]) || false,
        });
      }
    }

    // Within each service line, list primary products first, then alphabetical.
    for (const group of Object.values(serviceGroupMap)) {
      group.products.sort(
        (a, b) => (b.isPrimary ? 1 : 0) - (a.isPrimary ? 1 : 0) || a.name.localeCompare(b.name)
      );
    }

    const latestUpdate = products.reduce((max, p) => {
      const d = new Date(p.updated_at);
      return d > max ? d : max;
    }, new Date(0));

    res.json({
      lastModified: latestUpdate.toISOString(),
      productCount: products.length,
      serviceGroups: Object.values(serviceGroupMap),
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
