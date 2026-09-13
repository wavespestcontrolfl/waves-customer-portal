'use strict';

const express = require('express');
const { noStore } = require('../middleware/no-store');
const { reportLimiter } = require('./reports-public');
const { getVisitCompletionSummary } = require('../services/visit-completion-summary');

const router = express.Router();
router.use(noStore, reportLimiter);
router.get('/:token', async (req, res, next) => {
  try {
    // The reader format-gates before any DB read and projects only eligible
    // service reports. Creation gates never invalidate an issued link.
    const summary = await getVisitCompletionSummary(req.params.token);
    if (!summary) return res.status(404).json({ error: 'Visit summary not found.' });
    return res.json(summary);
  } catch (err) { return next(err); }
});

module.exports = router;
