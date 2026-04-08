const express = require('express');
const router = express.Router();
const db = require('../models/db');
const ComplianceService = require('../services/compliance');
const { adminAuthenticate, requireTechOrAdmin } = require('../middleware/admin-auth');

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
router.put('/licenses/:techId', async (req, res, next) => {
  try {
    const { fl_applicator_license, license_expiry, license_categories } = req.body;
    const updates = {};
    if (fl_applicator_license !== undefined) updates.fl_applicator_license = fl_applicator_license;
    if (license_expiry !== undefined) updates.license_expiry = license_expiry;
    if (license_categories !== undefined) updates.license_categories = JSON.stringify(license_categories);

    const [tech] = await db('technicians')
      .where({ id: req.params.techId })
      .update(updates)
      .returning('*');
    if (!tech) return res.status(404).json({ error: 'Technician not found' });

    res.json({ success: true, technician: tech });
  } catch (err) { next(err); }
});

module.exports = router;
