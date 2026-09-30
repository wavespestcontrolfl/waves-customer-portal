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

const serviceRouter = express.Router({ mergeParams: true });
serviceRouter.use(adminAuthenticate, requireTechOrAdmin);
serviceRouter.use((req, res, next) => areas.propertyServiceAreasEnabled() ? next() : res.status(404).json({ enabled: false }));
serviceRouter.get('/', handler('read'));
serviceRouter.put('/', handler('save'));
serviceRouter.post('/lookup', handler('lookup'));

const propertyRouter = express.Router({ mergeParams: true });
propertyRouter.use(adminAuthenticate, requireAdmin);
propertyRouter.use((req, res, next) => areas.propertyServiceAreasEnabled() ? next() : res.status(404).json({ enabled: false }));
propertyRouter.get('/', handler('read'));
propertyRouter.put('/', handler('save'));
propertyRouter.post('/lookup', handler('lookup'));

module.exports = { serviceRouter, propertyRouter };
