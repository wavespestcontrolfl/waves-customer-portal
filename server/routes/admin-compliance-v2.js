const express = require('express');
const router = express.Router();
const db = require('../models/db');
const logger = require('../services/logger');
const ComplianceService = require('../services/compliance');
const { adminAuthenticate, requireAdmin } = require('../middleware/admin-auth');
const { techTrainingDatesLive } = require('../config/feature-gates');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LICENSE_UPDATE_FIELDS = new Set([
  'fl_applicator_license',
  'license_expiry',
  'license_categories',
]);

const { validDateOnly } = require('../utils/date-only');
const { etDateString } = require('../utils/datetime-et');
const training = require('../services/technician-training-dates');

// GATE_TECH_TRAINING_DATES (dark): four more dates a license update may carry (F.S. 482.091; docs/gates-and-env.md).
const TRAINING_DATE_FIELDS = ['id_card_applied_on', 'id_card_issued_on', 'classroom_hours_done_on', 'renewal_training_done_on'];
const TRAINING_UPDATE_FIELDS = new Set([...LICENSE_UPDATE_FIELDS, ...TRAINING_DATE_FIELDS]);
const dateText = (column) => db.raw(`to_char(${column}, 'YYYY-MM-DD') as ${column}`);

function parseLicenseCategories(value) {
  if (value == null) return null;
  if (!Array.isArray(value) || value.length > 20) return undefined;
  const categories = [];
  for (const item of value) {
    if (typeof item !== 'string') return undefined;
    const category = item.trim();
    if (!category || category.length > 100) return undefined;
    if (!categories.includes(category)) categories.push(category);
  }
  return categories;
}

function licenseResponse(tech) {
  let licenseCategories = tech.license_categories;
  if (typeof licenseCategories === 'string') {
    try { licenseCategories = JSON.parse(licenseCategories); } catch { licenseCategories = null; }
  }
  return {
    id: tech.id,
    license: tech.fl_applicator_license,
    licenseExpiry: tech.license_expiry,
    licenseCategories,
  };
}

router.use(adminAuthenticate, requireAdmin);

// GET /api/admin/compliance-v2/applications — paginated with filters
router.get('/applications', async (req, res, next) => {
  try {
    const { startDate, endDate, technicianId, customerId, productName, limit, offset } = req.query;
    const result = await ComplianceService.getApplications({
      startDate, endDate, technicianId, customerId, productName,
      limit: parseInt(limit) || 50,
      offset: parseInt(offset) || 0,
    });
    res.json(result);
  } catch (err) { next(err); }
});

// GET /api/admin/compliance-v2/report — DACS compliance report
router.get('/report', async (req, res, next) => {
  try {
    const { startDate, endDate } = req.query;
    const report = await ComplianceService.getDacsReport(startDate, endDate);
    res.json(report);
  } catch (err) { next(err); }
});

// GET /api/admin/compliance-v2/report/export — CSV download
router.get('/report/export', async (req, res, next) => {
  try {
    const { startDate, endDate } = req.query;
    const csv = await ComplianceService.exportDacsCSV(startDate, endDate);
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="dacs-report-${startDate || 'ytd'}-to-${endDate || 'today'}.csv"`);
    res.send(csv);
  } catch (err) { next(err); }
});

// GET /api/admin/compliance-v2/product-limits — product limits for customer
router.get('/product-limits', async (req, res, next) => {
  try {
    const { customer_id } = req.query;
    if (!customer_id) return res.status(400).json({ error: 'customer_id required' });
    const result = await ComplianceService.getProductLimits(customer_id);
    res.json(result);
  } catch (err) { next(err); }
});

// GET /api/admin/compliance-v2/nitrogen-status — nitrogen blackout status
router.get('/nitrogen-status', async (req, res, next) => {
  try {
    const result = await ComplianceService.getNitrogenStatus();
    res.json(result);
  } catch (err) { next(err); }
});

// GET /api/admin/compliance-v2/dashboard — overview stats
router.get('/dashboard', async (req, res, next) => {
  try {
    const result = await ComplianceService.getDashboard();
    res.json(result);
  } catch (err) { next(err); }
});

// GATE_TECH_TRAINING_DATES: per technician with a hire date, the dates and statuses the Licenses tab shows
// (services/technician-training-dates.js). A technician with no hire date (the owner's row) gets nothing new.
async function trainingBlocksFor(ids) {
  const techs = await db('technicians').whereIn('id', ids).whereNotNull('hire_date')
    .select('id', ...['hire_date', 'license_expiry', ...TRAINING_DATE_FIELDS].map(dateText));
  const days = techs.length
    ? await db('technician_training_days').whereIn('technician_id', techs.map(t => t.id)).select('technician_id', 'hours', 'category', dateText('training_date'))
    : [];
  const today = etDateString();
  return new Map(techs.map(t => [t.id, training.technicianTrainingBlock(t, days.filter(d => d.technician_id === t.id), today)]));
}

// GET /api/admin/compliance-v2/licenses — technician license info
router.get('/licenses', async (req, res, next) => {
  try {
    const techs = await db('technicians')
      .select('id', 'name', 'email', 'phone', 'fl_applicator_license', 'license_expiry', 'license_categories', 'active');
    const now = new Date();
    const trainingBlocks = techTrainingDatesLive() ? await trainingBlocksFor(techs.map(t => t.id)) : new Map();
    res.json({
      technicians: techs.map(t => {
        let licenseStatus = 'none';
        if (t.fl_applicator_license) {
          if (!t.license_expiry) licenseStatus = 'active';
          else {
            const daysLeft = (new Date(t.license_expiry) - now) / 86400000;
            if (daysLeft < 0) licenseStatus = 'expired';
            else if (daysLeft <= 90) licenseStatus = 'expiring_soon';
            else licenseStatus = 'active';
          }
        }
        return {
          id: t.id,
          name: t.name,
          email: t.email,
          phone: t.phone,
          license: t.fl_applicator_license,
          licenseExpiry: t.license_expiry,
          licenseCategories: t.license_categories,
          licenseStatus,
          active: t.active,
          ...(trainingBlocks.get(t.id) || {}),
        };
      }),
    });
  } catch (err) { next(err); }
});

// GATE_TECH_TRAINING_DATES: the four dates on a license update (YYYY-MM-DD, or null / '' to clear).
function parseTrainingDates(body) {
  const updates = {};
  for (const field of TRAINING_DATE_FIELDS) {
    if (body[field] === undefined) continue;
    const day = body[field];
    if (day !== null && day !== '' && !validDateOnly(day)) return { error: `${field} must be a valid YYYY-MM-DD date or null` };
    updates[field] = day || null;
  }
  return { updates };
}

// The saved license plus the four dates. A reminder the entered date settled closes now, not at tomorrow's sweep (best effort:
// the daily sweep closes it otherwise).
async function trainingLicenseResponse(tech, techId) {
  try {
    await require('../services/technician-training-reminders').runTechnicianTrainingReminders({ technicianId: techId, closeOnly: true });
  } catch (err) {
    logger.warn(`[technician-training-reminders] closing after a license save failed: ${err.message}`);
  }
  return {
    ...licenseResponse(tech),
    idCardAppliedOn: tech.id_card_applied_on,
    idCardIssuedOn: tech.id_card_issued_on,
    classroomHoursDoneOn: tech.classroom_hours_done_on,
    renewalTrainingDoneOn: tech.renewal_training_done_on,
  };
}

// PUT /api/admin/compliance-v2/licenses/:techId — update tech license
async function updateLicense(req, res, next) {
  try {
    const techId = String(req.params.techId || '');
    if (!UUID_RE.test(techId)) {
      return res.status(400).json({ error: 'Invalid technician id' });
    }

    const body = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return res.status(400).json({ error: 'License update body must be an object' });
    }
    const trainingOn = techTrainingDatesLive();
    const allowedFields = trainingOn ? TRAINING_UPDATE_FIELDS : LICENSE_UPDATE_FIELDS;
    const fields = Object.keys(body);
    if (!fields.length || fields.some((field) => !allowedFields.has(field))) {
      return res.status(400).json({ error: 'Only license fields may be updated' });
    }

    const updates = {};
    if (body.fl_applicator_license !== undefined) {
      if (body.fl_applicator_license !== null && typeof body.fl_applicator_license !== 'string') {
        return res.status(400).json({ error: 'fl_applicator_license must be a string or null' });
      }
      const license = typeof body.fl_applicator_license === 'string'
        ? body.fl_applicator_license.trim()
        : '';
      if (license.length > 50) {
        return res.status(400).json({ error: 'fl_applicator_license must be 50 characters or fewer' });
      }
      updates.fl_applicator_license = license || null;
    }
    if (body.license_expiry !== undefined) {
      const expiry = body.license_expiry;
      if (expiry !== null && expiry !== '' && (typeof expiry !== 'string' || !validDateOnly(expiry))) {
        return res.status(400).json({ error: 'license_expiry must be a valid YYYY-MM-DD date or null' });
      }
      updates.license_expiry = expiry || null;
    }
    if (body.license_categories !== undefined) {
      const categories = parseLicenseCategories(body.license_categories);
      if (categories === undefined) {
        return res.status(400).json({ error: 'license_categories must be an array of short, non-empty strings or null' });
      }
      updates.license_categories = categories === null ? null : JSON.stringify(categories);
    }

    if (trainingOn) {
      const parsed = parseTrainingDates(body);
      if (parsed.error) return res.status(400).json({ error: parsed.error });
      Object.assign(updates, parsed.updates);
    }

    const [tech] = await db('technicians')
      .where({ id: techId })
      .update(updates)
      .returning(trainingOn
        ? ['id', 'fl_applicator_license', 'license_expiry', 'license_categories', ...TRAINING_DATE_FIELDS.map(dateText)]
        : ['id', 'fl_applicator_license', 'license_expiry', 'license_categories']);
    if (!tech) return res.status(404).json({ error: 'Technician not found' });

    if (trainingOn) return res.json({ success: true, technician: await trainingLicenseResponse(tech, techId) });

    res.json({ success: true, technician: licenseResponse(tech) });
  } catch (err) { next(err); }
}

router.put('/licenses/:techId', requireAdmin, updateLicense);

// ---- GATE_TECH_TRAINING_DATES (dark): the dated record of the initial five-day (40-hour) training ----
// Rule 5E-14.1421, F.A.C.: keep a written record of the initial training for 2 years (FDACS-13665, or a record of 40 hours
// with a written syllabus and the training materials). Off, these routes do not exist: the request falls through the router.
const TRAINING_DAY_FIELDS = new Set(['training_date', 'hours', 'category', 'topics', 'trainer_name', 'materials']);
const trainingGate = (req, res, next) => (techTrainingDatesLive() ? next() : next('router'));
const dayView = (row) => ({
  id: row.id,
  trainingDate: row.training_date,
  hours: Number(row.hours),
  category: row.category,
  topics: row.topics,
  trainerName: row.trainer_name,
  materials: row.materials,
  createdBy: row.created_by,
  createdAt: row.created_at,
});
const TRAINING_DAY_COLUMNS = ['id', 'hours', 'category', 'topics', 'trainer_name', 'materials', 'created_by', 'created_at'];
const trainingDayRows = (techId) => db('technician_training_days').where({ technician_id: techId })
  .select(...TRAINING_DAY_COLUMNS, dateText('training_date')).orderBy([{ column: 'training_date' }, { column: 'category' }]);

function techIdParam(req, res) {
  const techId = String(req.params.techId || '');
  if (UUID_RE.test(techId)) return techId;
  res.status(400).json({ error: 'Invalid technician id' });
  return null;
}

function boundedText(value, max, required) {
  if (value === undefined || value === null || value === '') return required ? undefined : null;
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  if (!text) return required ? undefined : null;
  return text.length > max ? undefined : text;
}

function parseTrainingDay(body, today) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: 'Training day body must be an object' };
  if (Object.keys(body).some((field) => !TRAINING_DAY_FIELDS.has(field))) return { error: 'Only training day fields may be sent' };
  if (!validDateOnly(body.training_date)) return { error: 'training_date must be a valid YYYY-MM-DD date' };
  if (body.training_date > today) return { error: 'training_date cannot be in the future' };
  const hours = typeof body.hours === 'number' ? body.hours : Number.NaN;
  if (!(hours > 0 && hours <= 16) || Math.abs(hours * 100 - Math.round(hours * 100)) > 1e-6) {
    return { error: 'hours must be more than 0 and at most 16, in hundredths' };
  }
  if (!training.TRAINING_CATEGORIES.includes(body.category)) return { error: `category must be one of ${training.TRAINING_CATEGORIES.join(', ')}` };
  const topics = boundedText(body.topics, 2000, true);
  if (topics === undefined) return { error: 'topics is required (2000 characters or fewer)' };
  const trainerName = boundedText(body.trainer_name, 200, true);
  if (trainerName === undefined) return { error: 'trainer_name is required (200 characters or fewer)' };
  const materials = boundedText(body.materials, 1000, false);
  if (materials === undefined) return { error: 'materials must be text of 1000 characters or fewer' };
  return {
    row: {
      training_date: body.training_date,
      hours: Math.round(hours * 100) / 100,
      category: body.category,
      topics,
      trainer_name: trainerName,
      materials,
    },
  };
}

// GET /api/admin/compliance-v2/licenses/:techId/training-days — the technician's dated training entries
router.get('/licenses/:techId/training-days', trainingGate, requireAdmin, async (req, res, next) => {
  try {
    const techId = techIdParam(req, res);
    if (!techId) return;
    const rows = await trainingDayRows(techId);
    res.json({ days: rows.map(dayView), summary: training.trainingSummary(rows) });
  } catch (err) { next(err); }
});

// POST /api/admin/compliance-v2/licenses/:techId/training-days — add a training day (one per technician, date and category)
router.post('/licenses/:techId/training-days', trainingGate, requireAdmin, async (req, res, next) => {
  try {
    const techId = techIdParam(req, res);
    if (!techId) return;
    const parsed = parseTrainingDay(req.body, etDateString());
    if (parsed.error) return res.status(400).json({ error: parsed.error });
    const tech = await db('technicians').where({ id: techId }).first('id');
    if (!tech) return res.status(404).json({ error: 'Technician not found' });
    // One entry per technician, date and category: a repeat inserts nothing (answered 409) and never errors the connection.
    const [row] = await db('technician_training_days')
      .insert({ ...parsed.row, technician_id: techId, created_by: req.technicianId && UUID_RE.test(String(req.technicianId)) ? req.technicianId : null })
      .onConflict(['technician_id', 'training_date', 'category']).ignore()
      .returning([...TRAINING_DAY_COLUMNS, dateText('training_date')]);
    if (!row) return res.status(409).json({ error: 'That technician already has a training day for this date and category' });
    res.status(201).json({ success: true, day: dayView(row) });
  } catch (err) { next(err); }
});

// DELETE /api/admin/compliance-v2/licenses/:techId/training-days/:dayId — remove an entry (delete and add again to correct one)
router.delete('/licenses/:techId/training-days/:dayId', trainingGate, requireAdmin, async (req, res, next) => {
  try {
    const techId = techIdParam(req, res);
    if (!techId) return;
    const dayId = String(req.params.dayId || '');
    if (!UUID_RE.test(dayId)) return res.status(400).json({ error: 'Invalid training day id' });
    const removed = await db('technician_training_days').where({ id: dayId, technician_id: techId }).del();
    if (!removed) return res.status(404).json({ error: 'Training day not found' });
    res.json({ success: true });
  } catch (err) { next(err); }
});

// GET /api/admin/compliance-v2/licenses/:techId/training-record — the printable 40-hour record
router.get('/licenses/:techId/training-record', trainingGate, requireAdmin, async (req, res, next) => {
  try {
    const techId = techIdParam(req, res);
    if (!techId) return;
    const tech = await db('technicians').where({ id: techId }).first('id', 'name', dateText('hire_date'), 'fl_applicator_license');
    if (!tech) return res.status(404).json({ error: 'Technician not found' });
    const rows = await trainingDayRows(techId);
    const totals = training.trainingSummary(rows);
    res.json({
      heading: 'Initial five-day (40-hour) pesticide applicator employee training record',
      authority: 'Rule 5E-14.1421, Florida Administrative Code; F.S. 482.091(3)',
      retention: 'Keep this record for 2 years.',
      technician: { id: tech.id, name: tech.name, hireDate: tech.hire_date },
      days: rows.map(dayView),
      totals: { days: totals.days, hours: totals.hours, categories: totals.categories, fiveDaysDone: totals.fiveDaysDone, fortyHoursDone: totals.fortyHoursDone },
      signatures: [{ role: 'Certified operator in charge', lines: ['Printed name', 'License number', 'Signature', 'Date'] }],
      generatedOn: etDateString(),
    });
  } catch (err) { next(err); }
});

module.exports = router;
module.exports._handlers = { updateLicense };
