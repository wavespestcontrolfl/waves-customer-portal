const express = require('express');
const router = express.Router();
const { adminAuthenticate } = require('../middleware/admin-auth');
const { listNeedsMe } = require('../services/needs-me');
const { AREAS, WHO } = require('../services/admin-alert-compose');

router.use(adminAuthenticate);

// GET /api/admin/needs-me?who=claude|person|either&area=<Area>&limit=<n>
// Everything open, in the shape of docs/admin-notifications.md section 2. Scoped to the
// caller's role exactly as the bell list is (a technician sees tech-visible rows only).
router.get('/', async (req, res, next) => {
  try {
    const { who, area, limit } = req.query;
    if (who !== undefined && !WHO.includes(who)) return res.status(400).json({ error: `who must be one of: ${WHO.join(', ')}` });
    if (area !== undefined && !AREAS.includes(area)) return res.status(400).json({ error: `area must be one of: ${AREAS.join(', ')}` });
    res.set('Cache-Control', 'no-store');
    res.json(await listNeedsMe({ who, area, limit, role: req.techRole }));
  } catch (err) { next(err); }
});

module.exports = router;
