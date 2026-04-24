const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const PDFDocument = require('pdfkit');
const db = require('../models/db');
const logger = require('../services/logger');

// Rate-limit public report access to deter token brute-forcing.
const reportLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please try again in a minute.' },
});

router.use(reportLimiter);

// Token format: 32-char lowercase hex. Reject anything else immediately.
const TOKEN_RE = /^[a-f0-9]{32}$/;

// GET /api/reports/project/:token/data — project report JSON for the viewer page
router.get('/project/:token/data', async (req, res, next) => {
  if (!TOKEN_RE.test(req.params.token || '')) {
    return res.status(404).json({ error: 'Report not found' });
  }
  try {
    const project = await db('projects as p')
      .where({ 'p.report_token': req.params.token })
      .leftJoin('customers as c', 'p.customer_id', 'c.id')
      .leftJoin('technicians as t', 'p.created_by_tech_id', 't.id')
      .select(
        'p.*',
        'c.first_name', 'c.last_name', 'c.city', 'c.state',
        't.name as technician_name',
      )
      .first();
    if (!project) return res.status(404).json({ error: 'Report not found' });

    if (!project.report_viewed_at) {
      await db('projects').where({ id: project.id }).update({ report_viewed_at: db.fn.now() });
    }

    const photos = await db('project_photos')
      .where({ project_id: project.id })
      .orderBy(['visit', 'sort_order', 'created_at']);

    // Build presigned URLs — tokens already gate access, but the S3 objects
    // themselves are private so the viewer needs signed links.
    const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');
    const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
    const config = require('../config');
    const s3 = new S3Client({
      region: config.s3?.region,
      credentials: config.s3?.accessKeyId
        ? { accessKeyId: config.s3.accessKeyId, secretAccessKey: config.s3.secretAccessKey }
        : undefined,
    });
    const photosWithUrls = await Promise.all(photos.map(async (ph) => {
      let url = null;
      if (config.s3?.bucket && ph.s3_key) {
        try {
          url = await getSignedUrl(s3, new GetObjectCommand({ Bucket: config.s3.bucket, Key: ph.s3_key }), { expiresIn: 3600 });
        } catch { /* fall through — photo will render as missing */ }
      }
      return { id: ph.id, category: ph.category, caption: ph.caption, visit: ph.visit, url };
    }));

    res.json({
      projectType: project.project_type,
      status: project.status,
      title: project.title,
      customerName: `${project.first_name || ''} ${project.last_name || ''}`.trim(),
      cityState: `${project.city || ''}${project.state ? ', ' + project.state : ''}`.trim().replace(/^,\s*/, ''),
      technicianName: project.technician_name,
      sentAt: project.sent_at,
      findings: project.findings,
      recommendations: project.recommendations,
      followupDate: project.followup_date,
      followupFindings: project.followup_findings,
      followupCompletedAt: project.followup_completed_at,
      photos: photosWithUrls,
    });
  } catch (err) { next(err); }
});

// GET /api/reports/:token — public PDF access (no auth)
router.get('/:token', async (req, res, next) => {
  if (!TOKEN_RE.test(req.params.token || '')) {
    return res.status(404).json({ error: 'Report not found' });
  }
  try {
    // PDF includes a customer address header, so this query keeps address fields.
    // The /data JSON endpoint below intentionally does NOT return address.
    const service = await db('service_records')
      .where({ report_view_token: req.params.token })
      .leftJoin('customers', 'service_records.customer_id', 'customers.id')
      .leftJoin('technicians', 'service_records.technician_id', 'technicians.id')
      .select('service_records.*', 'customers.first_name', 'customers.last_name',
        'customers.address_line1', 'customers.city', 'customers.state', 'customers.zip',
        'technicians.name as technician_name')
      .first();

    if (!service) return res.status(404).json({ error: 'Report not found' });

    // Track first view
    if (!service.report_viewed_at) {
      await db('service_records').where({ id: service.id }).update({ report_viewed_at: db.fn.now() });
      await db('activity_log').insert({
        customer_id: service.customer_id,
        action: 'report_viewed',
        description: `${service.first_name} ${service.last_name} viewed service report for ${service.service_type}`,
      }).catch(() => {});
    }

    // Check if pre-generated PDF exists
    if (service.report_pdf_path) {
      const fullPath = path.join(__dirname, '..', '..', service.report_pdf_path);
      if (fs.existsSync(fullPath)) {
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `inline; filename="Waves-Report-${service.service_date}.pdf"`);
        return fs.createReadStream(fullPath).pipe(res);
      }
    }

    // Generate PDF on-the-fly
    const products = await db('service_products').where({ service_record_id: service.id });
    const weather = service.weather_data ? (typeof service.weather_data === 'string' ? JSON.parse(service.weather_data) : service.weather_data) : null;
    const dryTimes = service.dry_time_data ? (typeof service.dry_time_data === 'string' ? JSON.parse(service.dry_time_data) : service.dry_time_data) : null;
    const irrigation = service.irrigation_recommendation ? (typeof service.irrigation_recommendation === 'string' ? JSON.parse(service.irrigation_recommendation) : service.irrigation_recommendation) : null;

    generateReportPDF(service, products, weather, dryTimes, irrigation, res);
  } catch (err) { next(err); }
});

// GET /api/reports/:token/data — JSON report data (for the branded viewer page)
router.get('/:token/data', async (req, res, next) => {
  if (!TOKEN_RE.test(req.params.token || '')) {
    return res.status(404).json({ error: 'Report not found' });
  }
  try {
    // No address fields here — the viewer page does not need them, and leaking
    // a home address on a public (tokenized) URL widens the blast radius if the
    // token is shared or leaked.
    const service = await db('service_records')
      .where({ report_view_token: req.params.token })
      .leftJoin('customers', 'service_records.customer_id', 'customers.id')
      .leftJoin('technicians', 'service_records.technician_id', 'technicians.id')
      .select('service_records.*', 'customers.first_name', 'customers.last_name',
        'customers.city', 'customers.state',
        'technicians.name as technician_name')
      .first();

    if (!service) return res.status(404).json({ error: 'Report not found' });

    const products = await db('service_products').where({ service_record_id: service.id });

    res.json({
      serviceType: service.service_type,
      serviceDate: service.service_date,
      technicianName: service.technician_name,
      customerName: `${service.first_name} ${service.last_name}`,
      cityState: `${service.city || ''}${service.state ? ', ' + service.state : ''}`.trim().replace(/^,\s*/, ''),
      notes: service.technician_notes,
      products: products.map(p => ({
        name: p.product_name, category: p.product_category,
        activeIngredient: p.active_ingredient, moaGroup: p.moa_group,
        rate: p.application_rate, rateUnit: p.rate_unit,
      })),
      measurements: {
        soilTemp: service.soil_temp, thatch: service.thatch_measurement,
        soilPh: service.soil_ph, moisture: service.soil_moisture,
      },
      weather: service.weather_data,
      dryTimes: service.dry_time_data,
      irrigation: service.irrigation_recommendation,
      pdfUrl: `/api/reports/${req.params.token}`,
    });
  } catch (err) { next(err); }
});

function generateReportPDF(service, products, weather, dryTimes, irrigation, res) {
  const doc = new PDFDocument({ size: 'LETTER', margin: 50 });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="Waves-Report-${service.service_date}.pdf"`);
  doc.pipe(res);

  // Header — logo (centered) with license + contact lines beneath. Falls
  // back to the wordmark if the logo asset is missing in this deploy.
  const { getLogoBuffer } = require('../services/pdf/brand-logo');
  const logoBuf = getLogoBuffer();
  if (logoBuf) {
    doc.image(logoBuf, 281, doc.y, { width: 50, height: 50 });  // center of 612px letter page, 50px square
    doc.moveDown(3);
  } else {
    doc.fontSize(20).font('Helvetica-Bold').text('WAVES PEST CONTROL', { align: 'center' });
  }
  doc.fontSize(9).font('Helvetica').text('Licensed & Insured · FL Pest Control License', { align: 'center' });
  doc.text('(941) 318-7612 · wavespestcontrol.com', { align: 'center' });
  doc.moveDown(0.5);
  doc.moveTo(50, doc.y).lineTo(562, doc.y).strokeColor('#2196F3').lineWidth(2).stroke();
  doc.moveDown(1);

  doc.fontSize(14).font('Helvetica-Bold').fillColor('#1E1E2B').text('SERVICE REPORT');
  doc.moveDown(0.5);

  // Customer info
  doc.fontSize(10).font('Helvetica-Bold').fillColor('#333').text('Customer:');
  doc.font('Helvetica').text(`${service.first_name} ${service.last_name}`);
  doc.text(`${service.address_line1}, ${service.city}, ${service.state} ${service.zip}`);
  doc.moveDown(0.5);

  doc.font('Helvetica-Bold').text('Service Details:');
  doc.font('Helvetica');
  doc.text(`Date: ${new Date(typeof service.service_date === 'string' ? service.service_date + 'T12:00:00' : service.service_date).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'America/New_York' })}`);
  doc.text(`Type: ${service.service_type}`);
  doc.text(`Technician: ${service.technician_name || 'Waves Team'}`);
  doc.moveDown(1);

  // Weather conditions
  if (weather) {
    doc.fontSize(11).font('Helvetica-Bold').fillColor('#1E1E2B').text('CONDITIONS AT TIME OF SERVICE');
    doc.moveDown(0.3);
    doc.fontSize(10).font('Helvetica').fillColor('#333');
    doc.text(`Air Temp: ${weather.temp || '—'}°F  Humidity: ${weather.humidity || '—'}%  Wind: ${weather.wind || '—'}  Cloud Cover: ${weather.cloudCover || '—'}%`);
    if (service.soil_temp) doc.text(`Soil Temp: ${service.soil_temp}°F  Soil pH: ${service.soil_ph || '—'}  Thatch: ${service.thatch_measurement || '—'}"  Moisture: ${service.soil_moisture || '—'}`);
    doc.moveDown(1);
  }

  // Tech notes
  if (service.technician_notes) {
    doc.fontSize(11).font('Helvetica-Bold').fillColor('#1E1E2B').text('TECHNICIAN NOTES');
    doc.moveDown(0.3);
    doc.fontSize(10).font('Helvetica').fillColor('#333').text(service.technician_notes, { width: 512, lineGap: 3 });
    doc.moveDown(1);
  }

  // Products
  if (products.length) {
    doc.fontSize(11).font('Helvetica-Bold').fillColor('#1E1E2B').text('PRODUCTS APPLIED');
    doc.moveDown(0.3);
    const tTop = doc.y;
    doc.fontSize(9).font('Helvetica-Bold').fillColor('#666');
    doc.text('Product', 50, tTop); doc.text('Active Ingredient', 220, tTop);
    doc.text('MOA Group', 370, tTop); doc.text('Category', 470, tTop);
    doc.moveTo(50, tTop + 14).lineTo(562, tTop + 14).strokeColor('#ccc').lineWidth(0.5).stroke();
    let rY = tTop + 20;
    doc.font('Helvetica').fillColor('#333');
    products.forEach(p => {
      if (rY > 700) { doc.addPage(); rY = 50; }
      doc.fontSize(9).text(p.product_name || '', 50, rY, { width: 165 });
      doc.text(p.active_ingredient || '—', 220, rY, { width: 145 });
      doc.text(p.moa_group || '—', 370, rY, { width: 95 });
      doc.text(p.product_category || '—', 470, rY, { width: 90 });
      rY += 16;
    });
    doc.y = rY;
    doc.moveDown(1);
  }

  // Dry times
  if (dryTimes) {
    doc.fontSize(11).font('Helvetica-Bold').fillColor('#1E1E2B').text('ESTIMATED DRY TIMES');
    doc.moveDown(0.3);
    doc.fontSize(10).font('Helvetica').fillColor('#333');
    if (dryTimes.lawn) doc.text(`• Lawn treatment: ${dryTimes.lawn}`);
    if (dryTimes.foundation) doc.text(`• Foundation perimeter: ${dryTimes.foundation}`);
    if (dryTimes.interior) doc.text(`• Interior application: ${dryTimes.interior}`);
    if (dryTimes.rainAdvisory) doc.text(`Rain advisory: ${dryTimes.rainAdvisory}`);
    doc.moveDown(1);
  }

  // Irrigation
  if (irrigation) {
    doc.fontSize(11).font('Helvetica-Bold').fillColor('#1E1E2B').text('IRRIGATION RECOMMENDATIONS');
    doc.moveDown(0.3);
    doc.fontSize(10).font('Helvetica').fillColor('#333');
    if (irrigation.recommendation) doc.text(irrigation.recommendation, { width: 512, lineGap: 3 });
    if (irrigation.instructions?.length) {
      doc.moveDown(0.5);
      irrigation.instructions.forEach(inst => doc.text(`${inst.allowed ? '✓' : '✗'} ${inst.text}`));
    }
    doc.moveDown(1);
  }

  // Footer
  doc.moveDown(2);
  doc.moveTo(50, doc.y).lineTo(562, doc.y).strokeColor('#ccc').lineWidth(0.5).stroke();
  doc.moveDown(0.5);
  doc.fontSize(8).font('Helvetica').fillColor('#999');
  doc.text('This report is provided for your records. For questions contact Waves Pest Control at (941) 318-7612.', { align: 'center' });
  doc.text(`Generated ${new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'America/New_York' })}`, { align: 'center' });

  doc.end();
}

// Helper: generate a report token for a service record
async function ensureReportToken(serviceRecordId) {
  const service = await db('service_records').where({ id: serviceRecordId }).first();
  if (service.report_view_token) return service.report_view_token;

  const token = crypto.randomBytes(16).toString('hex');
  await db('service_records').where({ id: serviceRecordId }).update({
    report_view_token: token,
    report_generated_at: db.fn.now(),
  });
  return token;
}

module.exports = router;
module.exports.ensureReportToken = ensureReportToken;
