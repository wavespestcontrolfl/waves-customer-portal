const express = require('express');
const Joi = require('joi');
const logger = require('../services/logger');
const { adminAuthenticate, requireAdmin } = require('../middleware/admin-auth');
const { KINDS, listBuilders, builderPermits } = require('../services/prospects/builder-list');
const { PERIODS, listRestaurants } = require('../services/prospects/restaurant-list');

// Prospects (admin only, read only). The Builders list: who pulls permits in unincorporated Manatee County, so the owner
// can pitch pre-slab termite treatment. The Restaurants list: new restaurants, new owners and pest findings from the
// state's public restaurant files. Nothing here sends a message, calls an AI service or writes a row.
const router = express.Router();
router.use(adminAuthenticate, requireAdmin);

const listSchema = Joi.object({ kind: Joi.string().valid(...KINDS).default('pool') }).unknown(false);
const permitsSchema = Joi.object({
  kind: Joi.string().valid(...KINDS).default('pool'),
  builder: Joi.string().trim().min(1).max(200).required(),
}).unknown(false);
const restaurantsSchema = Joi.object({ days: Joi.number().integer().valid(...PERIODS).default(PERIODS[0]) }).unknown(false);

function badRequest(res, error) {
  return res.status(400).json({ error: error.details[0].message });
}

// A knex error message carries the bound values (builder names, some of them a person's name), so logs get the code only.
const errorCode = (err) => String((err && (err.code || err.name)) || 'error').slice(0, 40);

router.get('/builders', async (req, res) => {
  const { error, value } = listSchema.validate(req.query);
  if (error) return badRequest(res, error);
  try {
    return res.json(await listBuilders({ kind: value.kind }));
  } catch (err) {
    logger.error(`[admin-prospects] builders list failed (${errorCode(err)})`);
    return res.status(500).json({ error: 'Could not load the builders list.' });
  }
});

router.get('/builders/permits', async (req, res) => {
  const { error, value } = permitsSchema.validate(req.query);
  if (error) return badRequest(res, error);
  try {
    return res.json({ permits: await builderPermits({ kind: value.kind, key: value.builder }) });
  } catch (err) {
    logger.error(`[admin-prospects] builder permits failed (${errorCode(err)})`);
    return res.status(500).json({ error: 'Could not load that builder’s permits.' });
  }
});

router.get('/restaurants', async (req, res) => {
  const { error, value } = restaurantsSchema.validate(req.query);
  if (error) return badRequest(res, error);
  try {
    return res.json(await listRestaurants({ days: value.days }));
  } catch (err) {
    logger.error(`[admin-prospects] restaurants list failed (${errorCode(err)})`);
    return res.status(500).json({ error: 'Could not load the restaurants list.' });
  }
});

module.exports = router;
