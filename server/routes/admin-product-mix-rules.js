// Mix safety rules (owner 2026-11-27): services/product-mix-rules.js. Reads are open to any staff login (a technician
// reads them for the tank; technician-scope.js lists the GET paths); every write is admin-only. A verdict is a warning
// only: nothing here blocks a visit or a product.
const express = require('express');
const router = express.Router();
const { adminAuthenticate, requireAdmin, requireTechOrAdmin } = require('../middleware/admin-auth');
const mixRules = require('../services/product-mix-rules');

router.use(adminAuthenticate, requireTechOrAdmin);

function sendError(res, next, err) {
  if (err && [400, 404, 409].includes(err.statusCode)) return res.status(err.statusCode).json({ error: err.message });
  return next(err);
}

// GET /api/admin/product-mix-rules — active rules, the product picker list and the groups.
router.get('/', async (req, res, next) => {
  try {
    const [rules, products] = await Promise.all([mixRules.listRules(), mixRules.listProducts()]);
    res.json({ rules, products, groups: mixRules.GROUPS, verdicts: mixRules.VERDICTS });
  } catch (err) { sendError(res, next, err); }
});

// GET /api/admin/product-mix-rules/check?productIds=a,b,c — the verdict for every pair in the list.
router.get('/check', async (req, res, next) => {
  try {
    const raw = Array.isArray(req.query.productIds) ? req.query.productIds.join(',') : String(req.query.productIds || '');
    const productIds = raw.split(',').map((v) => v.trim()).filter(Boolean);
    if (productIds.length < 2) return res.status(400).json({ error: 'Pick at least 2 products.' });
    if (productIds.length > mixRules.MAX_CHECK) return res.status(400).json({ error: `Pick at most ${mixRules.MAX_CHECK} products.` });
    return res.json(await mixRules.checkMix(productIds));
  } catch (err) { return sendError(res, next, err); }
});

// POST /api/admin/product-mix-rules — add a rule (or update the pair's existing row).
router.post('/', requireAdmin, async (req, res, next) => {
  try {
    res.status(201).json({ rule: await mixRules.upsertRule(req.body || {}, { actorId: req.technicianId }) });
  } catch (err) { sendError(res, next, err); }
});

// PUT /api/admin/product-mix-rules/:id — edit a rule.
router.put('/:id', requireAdmin, async (req, res, next) => {
  try {
    res.json({ rule: await mixRules.upsertRule(req.body || {}, { id: req.params.id, actorId: req.technicianId }) });
  } catch (err) { sendError(res, next, err); }
});

// DELETE /api/admin/product-mix-rules/:id — remove from the screen (soft: active = false).
router.delete('/:id', requireAdmin, async (req, res, next) => {
  try {
    const rule = await mixRules.deactivateRule(req.params.id, { actorId: req.technicianId });
    if (!rule) return res.status(404).json({ error: 'Rule not found' });
    return res.json({ rule });
  } catch (err) { return sendError(res, next, err); }
});

module.exports = router;
