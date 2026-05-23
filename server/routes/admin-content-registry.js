const express = require('express');

const { adminAuthenticate, requireAdmin } = require('../middleware/admin-auth');
const registryAdmin = require('../services/content/content-registry-admin');

const router = express.Router();

router.use(adminAuthenticate, requireAdmin);

router.get('/', async (req, res, next) => {
  try {
    const result = await registryAdmin.listContentRegistry({ query: req.query });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
