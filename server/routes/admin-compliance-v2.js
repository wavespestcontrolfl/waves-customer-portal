const express = require('express');
const router = express.Router();
const db = require('../models/db');
const ComplianceService = require('../services/compliance');
const { adminAuthenticate, requireAdmin, requireTechOrAdmin } = require('../middleware/admin-auth');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LICENSE_UPDATE_FIELDS = new Set([
  'fl_applicator_license',
  'license_expiry',
  'license_categories',
]);

function validDateOnly(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year
    && parsed.getUTCMonth() === month - 1
    && parsed.getUTCDate() === day;
}

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

router.use(adminAuthenticate, requireTechOrAdmin);

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

// GET /api/admin/compliance-v2/licenses — technician license info
router.get('/licenses', async (req, res, next) => {
  try {
    const techs = await db('technicians')
      .select('id', 'name', 'email', 'phone', 'fl_applicator_license', 'license_expiry', 'license_categories', 'active');
    const now = new Date();
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
        };
      }),
    });
  } catch (err) { next(err); }
});

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
    const fields = Object.keys(body);
    if (!fields.length || fields.some((field) => !LICENSE_UPDATE_FIELDS.has(field))) {
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

    const [tech] = await db('technicians')
      .where({ id: techId })
      .update(updates)
      .returning(['id', 'fl_applicator_license', 'license_expiry', 'license_categories']);
    if (!tech) return res.status(404).json({ error: 'Technician not found' });

    res.json({ success: true, technician: licenseResponse(tech) });
  } catch (err) { next(err); }
}

router.put('/licenses/:techId', requireAdmin, updateLicense);

module.exports = router;
module.exports._handlers = { updateLicense };
