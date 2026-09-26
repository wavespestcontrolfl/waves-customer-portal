const express = require('express');
const Joi = require('joi');
const { adminAuthenticate, requireAdmin } = require('../middleware/admin-auth');
const reviewStore = require('../services/customer-geocode-review');

const router = express.Router();
router.use(adminAuthenticate, requireAdmin);

const customerIdSchema = Joi.string().uuid().required();
const listSchema = Joi.object({
  limit: Joi.number().integer().min(1).max(100).default(25),
  offset: Joi.number().integer().min(0).default(0),
}).unknown(false);

function validate(schema, value) {
  const result = schema.validate(value, { abortEarly: true, convert: true });
  if (!result.error) return { value: result.value };
  return { error: result.error.details[0].message };
}

function enabledGet(res) {
  if (reviewStore.reviewEnabled()) return true;
  res.json({ enabled: false });
  return false;
}

router.get('/', async (req, res, next) => {
  if (!enabledGet(res)) return;
  const checked = validate(listSchema, req.query);
  if (checked.error) return res.status(400).json({ error: checked.error });
  try {
    const result = await reviewStore.listReviewQueue(checked.value);
    return res.json({ enabled: true, records: result.records, total: result.total });
  } catch (err) {
    return next(err);
  }
});

router.get('/:customerId', async (req, res, next) => {
  if (!enabledGet(res)) return;
  const checked = validate(customerIdSchema, req.params.customerId);
  if (checked.error) return res.status(400).json({ error: checked.error });
  try {
    const detail = await reviewStore.getReviewDetail(checked.value);
    if (!detail) return res.status(404).json({ error: 'Customer not found' });
    return res.json({ enabled: true, ...detail });
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
