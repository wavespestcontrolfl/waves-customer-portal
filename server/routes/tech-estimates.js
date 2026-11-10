const express = require('express');
const router = express.Router();
const db = require('../models/db');
const { adminAuthenticate } = require('../middleware/admin-auth');
const featureGates = require('../config/feature-gates');

// The technician estimate tool (steps 1, 2a and 4): setup, a price preview, saving the quote as a draft, reading his own
// drafts and texting his own clean draft through the office's estimate send. GATE_TECH_ESTIMATES (owner 2026-11-09): the
// send texts customers and the preview runs the paid property lookup.
router.use(adminAuthenticate);

const OFF = { enabled: false };
// The setup read is the field workspace asking "is the tool on for this login?" on every load. Its "no" is a plain
// answer (200), so a browser logs no failed request while the tool is off. Every other route answers 404.
const off = (req, res) => (req.method === 'GET' && req.path === '/setup' ? res.json(OFF) : res.status(404).json(OFF));

// Gate off, or a technician whose own switch is off: the off answer before any customer read. An admin always passes.
router.use(async (req, res, next) => {
  try {
    if (!featureGates.techEstimatesLive()) return off(req, res);
    if (req.techRole === 'admin') return next();
    const row = await db('technicians').where({ id: req.technicianId }).first('can_create_estimates');
    if (!row || row.can_create_estimates !== true) return off(req, res);
    return next();
  } catch (err) { return next(err); }
});

// Any error that is not a refusal goes to the portal's error handler (middleware/errors.js), which logs an error's
// message and stack, and on to error monitoring. A database error's message holds the text of the failed statement, and
// the database's own words can repeat a value it refused; the estimate save writes a name, a phone and an address. So
// the handler gets a copy that keeps the error's code or class, the caller's id and the stack frames, and nothing else.
function safeError(err, req, label) {
  const safe = new Error(`[tech-estimates] ${label} failed for technician ${req.technicianId} (${String(err?.code || err?.name || 'error').slice(0, 40)})`);
  const frames = String(err?.stack || '').split('\n').filter((line) => /^\s+at /.test(line));
  safe.stack = [safe.message, ...frames].join('\n');
  return safe;
}

// Every route answers a refusal the same way: its status, a short message and, for some, a code.
async function answer(req, res, next, label, work) {
  const { PriceRefusal } = require('../services/tech-estimate-price');
  try {
    res.json(await work());
  } catch (err) {
    if (err instanceof PriceRefusal) return res.status(err.status).json({ error: err.message, ...err.extra });
    return next(safeError(err, req, label));
  }
}
const price = () => require('../services/tech-estimate-price');
const save = () => require('../services/tech-estimate-save');

/* GET /setup — the services this login may quote */
router.get('/setup', (req, res, next) => answer(req, res, next, 'setup', () => price().setupFor(req)));

/* POST /price — price a quote at list price; saves nothing. Answers a digest the create sends back. */
router.post('/price', (req, res, next) => answer(req, res, next, 'price', () => price().priceQuote(req, req.body || {})));

/* POST / — save the quote as a draft estimate (retry key clientDraftId; the price is tied to /price by digest) */
router.post('/', (req, res, next) => answer(req, res, next, 'create', () => save().createQuote(req, req.body || {})));

/* GET / — his own estimates, newest first */
router.get('/', (req, res, next) => answer(req, res, next, 'list', () => save().listOwn(req)));

/* POST /:id/send — text his own draft through the office's estimate send (409 office_first for a held one) */
router.post('/:id/send', (req, res, next) => answer(req, res, next, 'send', () => require('../services/tech-estimate-send').sendOwn(req, req.params.id, req.body)));

/* GET /:id — one of his own estimates (404 for any other id) */
router.get('/:id', (req, res, next) => answer(req, res, next, 'read', () => save().readOwn(req, req.params.id)));

module.exports = router;
