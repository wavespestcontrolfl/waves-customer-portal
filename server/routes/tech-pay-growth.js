const express = require('express');
const Joi = require('joi');
const { adminAuthenticate, requireTechOrAdmin, requireAdmin } = require('../middleware/admin-auth');
const { gateEnvValue } = require('../config/feature-gates');
const { etDateString } = require('../utils/datetime-et');
const { uuid, month, validate, reject } = require('../services/field-team-rules');
const program = require('../services/field-team-program');
const router = express.Router();

router.use(adminAuthenticate, requireTechOrAdmin);
router.use((req, res, next) => { res.set('Cache-Control', 'private, no-store'); next(); });
router.get('/availability', (req, res) => res.json({ available: gateEnvValue('GATE_FIELD_TEAM_PROGRAM') }));
router.use((req, res, next) => {
  if (!gateEnvValue('GATE_FIELD_TEAM_PROGRAM')) return res.status(404).json({ error: 'Pay and growth is unavailable.' });
  next();
});
const actor = req => ({ id: req.technicianId, role: req.techRole });
const handle = fn => async (req, res, next) => {
  try { await fn(req, res); }
  catch (error) {
    if (error.status) return res.status(error.status).json({ error: error.message });
    if (['23505', '40001', '40P01'].includes(error.code)) return res.status(409).json({ error: 'The record changed or was already saved. Reload before trying again.' });
    next(error);
  }
};
function selection(req) {
  validate(Joi.object({ technicianId: uuid, month }), req.query);
  const technicianId = req.query.technicianId || req.technicianId;
  if (req.techRole !== 'admin' && technicianId !== req.technicianId) reject('You can view only your own pay and growth records.', 403);
  return { technicianId, month: req.query.month || etDateString(new Date()).slice(0, 7) };
}

router.get('/', handle(async (req, res) => {
  const selected = selection(req);
  res.json({ ...await program.overview(selected.technicianId, selected.month), can_manage: req.techRole === 'admin' });
}));
router.get('/setup', requireAdmin, handle(async (req, res) => res.json(await program.setup())));
router.get('/visits', requireAdmin, handle(async (req, res) => {
  const selected = selection(req);
  res.json({ visits: await program.visitOptions(selected.technicianId, selected.month) });
}));
router.get('/estimates', requireAdmin, handle(async (req, res) => {
  const selected = selection(req);
  res.json({ estimates: await program.estimateOptions(selected.month) });
}));
router.get('/services/:id/evidence', requireAdmin, handle(async (req, res) => {
  validate(uuid.required(), req.params.id);
  res.json(await program.evidenceDetail(req.params.id));
}));
router.get('/services/:id/score', handle(async (req, res) => {
  validate(uuid.required(), req.params.id);
  res.json(await program.score(req.params.id, actor(req)));
}));
router.post('/rules', requireAdmin, handle(async (req, res) => res.status(201).json(await program.saveRule(req.body, actor(req)))));
router.post('/levels', requireAdmin, handle(async (req, res) => res.status(201).json(await program.saveLevel(req.body, actor(req)))));
router.post('/allocations', requireAdmin, handle(async (req, res) => res.status(201).json(await program.saveAllocation(req.body, actor(req)))));
router.post('/service-evidence', requireAdmin, handle(async (req, res) => res.status(201).json(await program.saveServiceEvidence(req.body, actor(req)))));
router.post('/new-business', requireAdmin, handle(async (req, res) => res.status(201).json(await program.saveBusinessEvidence(req.body, actor(req)))));
router.post('/assessments', requireAdmin, handle(async (req, res) => res.status(201).json(await program.saveAssessment(req.body, actor(req)))));
router.post('/statements', requireAdmin, handle(async (req, res) => {
  const data = validate(Joi.object({ technician_id: uuid.required(), month: month.required() }), req.body);
  res.status(201).json(await program.saveStatement(data.technician_id, data.month, actor(req)));
}));

module.exports = router;
