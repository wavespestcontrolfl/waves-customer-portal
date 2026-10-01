const express = require('express');
const router = express.Router();
const { adminAuthenticate, requireTechOrAdmin } = require('../middleware/admin-auth');
const { listNeedsMe, decodeCursor } = require('../services/needs-me');
const { AREAS, WHO } = require('../services/admin-alert-compose');

// Technicians read their tech-visible slice (role scoping below), so the guard is tech-or-admin.
router.use(adminAuthenticate, requireTechOrAdmin);

// GET /api/admin/needs-me?who=claude|person|either&area=<Area>&limit=<n>
// Everything open, in the shape of docs/admin-notifications.md section 2. Scoped to the
// caller's role exactly as the bell list is (a technician sees tech-visible rows only).
router.get('/', async (req, res, next) => {
  try {
    const { who, area, limit } = req.query;
    // after: the `next` cursor a previous page returned.
    const after = req.query.after === undefined ? null : decodeCursor(req.query.after);
    if (req.query.after !== undefined && !after) return res.status(400).json({ error: 'after must be a cursor from a previous page' });
    if (who !== undefined && !WHO.includes(who)) return res.status(400).json({ error: `who must be one of: ${WHO.join(', ')}` });
    if (area !== undefined && !AREAS.includes(area)) return res.status(400).json({ error: `area must be one of: ${AREAS.join(', ')}` });
    res.set('Cache-Control', 'no-store');
    res.json(await listNeedsMe({ who, area, limit, after, role: req.techRole }));
  } catch (err) { next(err); }
});

module.exports = router;
