const express = require('express');
const { adminAuthenticate, requireTechOrAdmin, requireAdmin } = require('../middleware/admin-auth');
const areas = require('../services/property-service-areas');
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

function handler(operation) {
  return async (req, res, next) => {
    try {
      if (Object.values(req.params).some(value => !UUID.test(value))) return res.status(404).json({ error: 'Property not found.' });
      const scope = { serviceId: req.params.serviceId, customerId: req.params.customerId, propertyId: req.params.propertyId };
      const result = operation === 'save' ? await areas.saveAreaMeasurements(scope, req, req.body)
        : await areas.readAreaMeasurements(scope, req, { refresh: operation === 'lookup' });
      res.json(result);
    } catch (error) { next(error); }
  };
}

function areaRouter(adminOnly = false) {
  const router = express.Router({ mergeParams: true });
  router.use(adminAuthenticate, requireTechOrAdmin);
  if (adminOnly) router.use(requireAdmin);
  router.use((req, res, next) => areas.propertyServiceAreasEnabled() ? next() : res.status(404).json({ enabled: false }));
  router.get('/', handler('read'));
  router.put('/', handler('save'));
  router.post('/lookup', handler('lookup'));
  return router;
}

module.exports = { serviceRouter: areaRouter(), propertyRouter: areaRouter(true) };
