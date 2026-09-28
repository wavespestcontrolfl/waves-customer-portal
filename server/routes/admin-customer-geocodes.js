const express = require('express');
const Joi = require('joi');
const { adminAuthenticate, requireAdmin } = require('../middleware/admin-auth');
const reviewStore = require('../services/customer-geocode-review');
const { resolveCustomerGeocodeReview } = require('../services/customer-geocode-review-actions');

const router = express.Router();
router.use(adminAuthenticate, requireAdmin);

const customerIdSchema = Joi.string().uuid().required();
const revision = Joi.string().trim().min(1).max(200).required();
const source = Joi.string().valid('county_records', 'customer_confirmation', 'site_visit');
const evidence = Joi.string().trim().min(1).max(2000);
const address = Joi.object({
  address_line1: Joi.string().trim().min(1).max(200).required(),
  address_line2: Joi.string().trim().max(100).allow('', null).required(),
  city: Joi.string().trim().min(1).max(50).required(),
  state: Joi.string().trim().uppercase().length(2).required(),
  zip: Joi.string().trim().pattern(/^\d{5}(?:-\d{4})?$/).required(),
}).unknown(false);

const resolveSchema = Joi.alternatives().try(
  Joi.object({
    revision,
    action: Joi.string().valid('verify_pin').required(),
    address,
    latitude: Joi.number().strict().min(-90).max(90).required(),
    longitude: Joi.number().strict().min(-180).max(180).required(),
    source: source.required(),
    evidence: evidence.required(),
    confirmed: Joi.boolean().strict().valid(true).required(),
  }).unknown(false),
  Joi.object({
    revision,
    action: Joi.string().valid('outside_service_area').required(),
    source,
    evidence: evidence.required(),
    confirmed: Joi.boolean().strict().valid(true).required(),
  }).unknown(false),
  Joi.object({
    revision,
    action: Joi.string().valid('retry', 'revoke').required(),
  }).unknown(false),
).match('one');

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

function enabledPost(res) {
  if (reviewStore.reviewEnabled()) return true;
  res.status(404).json({ enabled: false });
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

router.post('/:customerId/resolve', async (req, res, next) => {
  if (!enabledPost(res)) return;
  const id = validate(customerIdSchema, req.params.customerId);
  if (id.error) return res.status(400).json({ error: id.error });
  const body = validate(resolveSchema, req.body);
  if (body.error) return res.status(400).json({ error: body.error });
  try {
    const detail = await resolveCustomerGeocodeReview(id.value, body.value, req.technicianId);
    return res.json({ enabled: true, ...detail });
  } catch (err) {
    if (err?.statusCode === 404 || err?.statusCode === 409 || err?.statusCode === 400) {
      return res.status(err.statusCode).json({ error: err.message, code: err.code || null });
    }
    return next(err);
  }
});

module.exports = router;
