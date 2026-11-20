const express = require('express');
const Joi = require('joi');
const logger = require('../services/logger');
const { adminAuthenticate, requireAdmin } = require('../middleware/admin-auth');
const { KINDS, listBuilders, builderPermits } = require('../services/prospects/builder-list');

// Prospects (admin only, read only). The Builders list: who pulls permits in unincorporated Manatee County, so the owner
// can pitch pre-slab termite treatment. Nothing here sends a message, calls an AI service or writes a row.
const router = express.Router();
router.use(adminAuthenticate, requireAdmin);

const listSchema = Joi.object({ kind: Joi.string().valid(...KINDS).default('pool') }).unknown(false);
const permitsSchema = Joi.object({
  kind: Joi.string().valid(...KINDS).default('pool'),
  builder: Joi.string().trim().min(1).max(200).required(),
}).unknown(false);

function badRequest(res, error) {
  return res.status(400).json({ error: error.details[0].message });
}

router.get('/builders', async (req, res) => {
  const { error, value } = listSchema.validate(req.query);
  if (error) return badRequest(res, error);
  try {
    return res.json(await listBuilders({ kind: value.kind }));
  } catch (err) {
    logger.error(`[admin-prospects] builders list failed: ${err.message}`);
    return res.status(500).json({ error: 'Could not load the builders list.' });
  }
});

router.get('/builders/permits', async (req, res) => {
  const { error, value } = permitsSchema.validate(req.query);
  if (error) return badRequest(res, error);
  try {
    return res.json({ permits: await builderPermits({ kind: value.kind, key: value.builder }) });
  } catch (err) {
    logger.error(`[admin-prospects] builder permits failed: ${err.message}`);
    return res.status(500).json({ error: 'Could not load that builder’s permits.' });
  }
});

module.exports = router;
