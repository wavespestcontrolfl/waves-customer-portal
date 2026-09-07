const express = require('express');
const Joi = require('joi');
const db = require('../models/db');
const { adminAuthenticate, requireTechOrAdmin, requireAdmin } = require('../middleware/admin-auth');
const { parseETDateTime, etParts, etDateString } = require('../utils/datetime-et');
const { validate, reject } = require('../services/staff-document-source');
const documents = require('../services/staff-documents');
const { gateEnvValue } = require('../config/feature-gates');
const router = express.Router();
router.use(adminAuthenticate, requireTechOrAdmin);
router.use((req, res, next) => { res.set('Cache-Control', 'private, no-store'); next(); });
router.get('/availability', (req, res) => res.json({ available: gateEnvValue('GATE_CONTROLLED_STAFF_DOCUMENTS') }));
router.use((req, res, next) => {
  if (!gateEnvValue('GATE_CONTROLLED_STAFF_DOCUMENTS')) return res.status(404).json({ error: 'Document not found' });
  next();
});

const uuid = Joi.string().uuid();
const actor = req => ({ id: req.technicianId, role: req.techRole });
const handle = fn => async (req, res, next) => {
  try { await fn(req, res); }
  catch (error) {
    if (error.status) return res.status(error.status).json({ error: error.message });
    if (error.code === '23505') return res.status(409).json({ error: 'This document key or revision already exists. Reload and try again.' });
    next(error);
  }
};

function instant(value, future = false) {
  validate(Joi.string().pattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/).required(), value);
  const parsed = parseETDateTime(value);
  if (!parsed || !Number.isFinite(parsed.getTime())) reject('Enter a valid Eastern date and time.');
  const parts = etParts(parsed);
  const roundTrip = `${etDateString(parsed)}T${String(parts.hour).padStart(2, '0')}:${String(parts.minute).padStart(2, '0')}`;
  if (roundTrip !== value) reject('Enter a real Eastern date and time, outside the daylight-saving gap.');
  if (future && parsed.getTime() < Date.now() - 60000) reject('Effective dates cannot be backdated.');
  return future ? new Date(Math.max(parsed.getTime(), Date.now())) : parsed;
}

router.get('/', handle(async (req, res) => {
  const at = req.query.at ? instant(req.query.at) : new Date();
  const search = validate(Joi.string().max(200).allow('').default(''), req.query.search);
  res.json({ documents: await documents.list(actor(req), { at, search, asOf: !!req.query.at }) });
}));
router.get('/people', handle(async (req, res) => {
  const people = await db('technicians').where({ employment_status: 'active' }).modify(q => {
    if (req.techRole !== 'admin') q.where('id', req.technicianId);
  }).select('id', 'name', 'role').orderBy('name');
  res.json({ people, self_id: req.technicianId, can_manage: req.techRole === 'admin' });
}));
router.get('/policy-values', requireAdmin, handle(async (req, res) => {
  res.json({ revisions: await db('policy_values').orderBy('revision', 'desc') });
}));
router.post('/policy-values', requireAdmin, handle(async (req, res) => {
  validate(Joi.object({ base_revision_id: uuid.allow(null).required(), values: Joi.object().required(), effective_at: Joi.string().required() }), req.body);
  res.status(201).json(await documents.updatePolicy(req.body, instant(req.body.effective_at, true), actor(req)));
}));
router.get('/starters', requireAdmin, handle(async (req, res) => {
  res.json({ starters: require('../services/staff-document-starters') });
}));
router.post('/drafts', requireAdmin, handle(async (req, res) => {
  validate(Joi.object({ id: uuid, base_version_id: uuid, key: Joi.string().max(80), kind: Joi.string(), access: Joi.string(), legacy_company_document_id: uuid.allow(null), source: Joi.object().required() }), req.body);
  res.status(201).json(await documents.saveDraft(req.body, actor(req)));
}));
router.get('/:id', handle(async (req, res) => {
  validate(uuid.required(), req.params.id);
  if (req.query.version) validate(uuid.required(), req.query.version);
  res.json(await documents.detail(req.params.id, actor(req), req.query.version, req.query.at ? instant(req.query.at) : null));
}));
router.post('/:id/preview', requireAdmin, handle(async (req, res) => {
  validate(uuid.required(), req.params.id);
  validate(Joi.object({ version_id: uuid.required(), effective_at: Joi.string().required() }), req.body);
  res.json(await documents.preview(req.params.id, req.body.version_id, instant(req.body.effective_at, true), actor(req)));
}));
router.post('/:id/issue', requireAdmin, handle(async (req, res) => {
  validate(uuid.required(), req.params.id);
  validate(Joi.object({ version_id: uuid.required(), effective_at: Joi.string().required(), preview_hash: Joi.string().hex().length(64).required() }), req.body);
  res.json({ version: await documents.publish(req.params.id, req.body.version_id, instant(req.body.effective_at, true), req.body.preview_hash, actor(req)) });
}));
router.post('/versions/:id/acknowledge', handle(async (req, res) => {
  validate(uuid.required(), req.params.id);
  validate(Joi.object({ content_hash: Joi.string().length(64).required(), signed_name: Joi.string().max(180).required(), accepted: Joi.boolean().required() }), req.body);
  res.json({ acknowledgment: await documents.acknowledge(req.params.id, req.body, actor(req)) });
}));
router.post('/versions/:id/records', handle(async (req, res) => {
  validate(uuid.required(), req.params.id);
  validate(Joi.object({ id: uuid, base_updated_at: Joi.string().isoDate(), content_hash: Joi.string().length(64).required(), owner_id: uuid.required(), due_at: Joi.string().required(), answers: Joi.object().required(), completed_steps: Joi.array().items(Joi.string()).max(80).required(), complete: Joi.boolean().required() }), req.body);
  res.json({ record: await documents.saveRecord(req.params.id, { ...req.body, due_at: instant(req.body.due_at) }, actor(req)) });
}));
router.get('/:id/pdf', handle(async (req, res) => {
  validate(uuid.required(), req.params.id);
  validate(uuid.required(), req.query.version);
  const detail = await documents.detail(req.params.id, actor(req), req.query.version);
  if (!detail.version.content_hash) {
    validate(Joi.string().hex().length(64).required(), req.query.preview_hash);
    const preview = await documents.preview(req.params.id, req.query.version, instant(req.query.effective_at, true), actor(req));
    if (preview.preview_hash !== req.query.preview_hash) reject('The wording changed since preview. Refresh the wording before exporting.', 409);
    detail.rendered = preview.rendered;
    detail.preview_effective_at = preview.effective_at;
  }
  let acknowledgment = null;
  let record = null;
  if (req.query.acknowledgment) {
    validate(uuid.required(), req.query.acknowledgment);
    acknowledgment = detail.acknowledgments.find(row => row.id === req.query.acknowledgment);
    if (!acknowledgment) reject('Acknowledgment not found', 404);
  }
  if (req.query.record) {
    validate(uuid.required(), req.query.record);
    record = detail.records.find(row => row.id === req.query.record);
    if (!record) reject('Record not found', 404);
  }
  const { renderStaffDocumentPdf } = require('../services/pdf/staff-document-pdf');
  const pdf = await renderStaffDocumentPdf(detail, { acknowledgment, record });
  res.type('application/pdf').set('Content-Disposition', 'attachment; filename="staff-document.pdf"').send(pdf);
}));

module.exports = router;
