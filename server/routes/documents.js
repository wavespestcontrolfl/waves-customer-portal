const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const PDFDocument = require('pdfkit');
const db = require('../models/db');
const { authenticate } = require('../middleware/auth');
const logger = require('../services/logger');

// =========================================================================
// PDF GENERATION — builds a branded service report
// =========================================================================
function generateServiceReportPDF(customer, service, products, res) {
  const doc = new PDFDocument({ size: 'LETTER', margin: 50 });

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="Waves_Service_Report_${service.service_date}.pdf"`);
  doc.pipe(res);

  // Header
  doc.fontSize(20).font('Helvetica-Bold').text('WAVES PEST CONTROL', { align: 'center' });
  doc.fontSize(9).font('Helvetica').text('Licensed & Insured · FL Pest Control License #JB000000', { align: 'center' });
  doc.text('(941) 318-7612 · wavespestcontrol.com', { align: 'center' });
  doc.moveDown(0.5);
  doc.moveTo(50, doc.y).lineTo(562, doc.y).strokeColor('#1B2A4A').lineWidth(2).stroke();
  doc.moveDown(1);

  // Report title
  doc.fontSize(14).font('Helvetica-Bold').fillColor('#1B2A4A').text('SERVICE REPORT');
  doc.moveDown(0.5);

  // Customer & service info
  const infoY = doc.y;
  doc.fontSize(10).font('Helvetica-Bold').fillColor('#333').text('Customer:');
  doc.font('Helvetica').text(`${customer.first_name} ${customer.last_name}`);
  doc.text(`${customer.address_line1}`);
  doc.text(`${customer.city}, ${customer.state} ${customer.zip}`);
  doc.moveDown(0.5);

  doc.font('Helvetica-Bold').text('Service Details:');
  doc.font('Helvetica').text(`Date: ${formatDate(service.service_date)}`);
  doc.text(`Type: ${service.service_type}`);
  doc.text(`Technician: ${service.technician_name || 'Waves Team'}`);
  doc.text(`Status: ${service.status}`);
  doc.moveDown(1);

  // Technician Notes
  if (service.technician_notes) {
    doc.fontSize(11).font('Helvetica-Bold').fillColor('#1B2A4A').text('TECHNICIAN NOTES');
    doc.moveDown(0.3);
    doc.fontSize(10).font('Helvetica').fillColor('#333').text(service.technician_notes, {
      width: 512, lineGap: 3,
    });
    doc.moveDown(1);
  }

  // Measurements
  const measurements = [];
  if (service.soil_temp) measurements.push(`Soil Temperature: ${service.soil_temp}°F`);
  if (service.thatch_measurement) measurements.push(`Thatch Measurement: ${service.thatch_measurement}"`);
  if (service.soil_ph) measurements.push(`Soil pH: ${service.soil_ph}`);
  if (service.soil_moisture) measurements.push(`Soil Moisture: ${service.soil_moisture}`);

  if (measurements.length) {
    doc.fontSize(11).font('Helvetica-Bold').fillColor('#1B2A4A').text('MEASUREMENTS');
    doc.moveDown(0.3);
    measurements.forEach(m => {
      doc.fontSize(10).font('Helvetica').fillColor('#333').text(`• ${m}`);
    });
    doc.moveDown(1);
  }

  // Products Applied
  if (products.length) {
    doc.fontSize(11).font('Helvetica-Bold').fillColor('#1B2A4A').text('PRODUCTS APPLIED');
    doc.moveDown(0.3);

    // Table header
    const tableTop = doc.y;
    const col1 = 50, col2 = 220, col3 = 370, col4 = 470;

    doc.fontSize(9).font('Helvetica-Bold').fillColor('#666');
    doc.text('Product', col1, tableTop);
    doc.text('Active Ingredient', col2, tableTop);
    doc.text('MOA Group', col3, tableTop);
    doc.text('Category', col4, tableTop);

    doc.moveTo(50, tableTop + 14).lineTo(562, tableTop + 14).strokeColor('#ccc').lineWidth(0.5).stroke();

    let rowY = tableTop + 20;
    doc.font('Helvetica').fillColor('#333');
    products.forEach(p => {
      if (rowY > 700) {
        doc.addPage();
        rowY = 50;
      }
      doc.fontSize(9).text(p.product_name || '', col1, rowY, { width: 165 });
      doc.text(p.active_ingredient || '—', col2, rowY, { width: 145 });
      doc.text(p.moa_group || '—', col3, rowY, { width: 95 });
      doc.text(p.product_category || '—', col4, rowY, { width: 90 });
      rowY += 16;
    });
    doc.y = rowY;
    doc.moveDown(1);
  }

  // Field flags
  if (service.field_flags) {
    try {
      const flags = typeof service.field_flags === 'string' ? JSON.parse(service.field_flags) : service.field_flags;
      if (Object.keys(flags).length) {
        doc.fontSize(11).font('Helvetica-Bold').fillColor('#1B2A4A').text('FIELD OBSERVATIONS');
        doc.moveDown(0.3);
        Object.entries(flags).forEach(([key, val]) => {
          doc.fontSize(10).font('Helvetica').fillColor('#333').text(`• ${key}: ${val}`);
        });
        doc.moveDown(1);
      }
    } catch (e) { /* ignore parse errors */ }
  }

  // Footer
  doc.moveDown(2);
  doc.moveTo(50, doc.y).lineTo(562, doc.y).strokeColor('#ccc').lineWidth(0.5).stroke();
  doc.moveDown(0.5);
  doc.fontSize(8).font('Helvetica').fillColor('#999');
  doc.text('This report is provided for your records. For questions contact Waves Pest Control at (941) 318-7612.', { align: 'center' });
  doc.text(`Generated ${new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}`, { align: 'center' });

  doc.end();
}

function formatDate(d) {
  if (!d) return '—';
  const dt = new Date(typeof d === 'string' ? d + 'T12:00:00' : d);
  return dt.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
}

// =========================================================================
// GET /api/documents — all documents for authenticated customer
// =========================================================================
router.get('/', authenticate, async (req, res, next) => {
  try {
    // Get uploaded/static documents
    const docs = await db('customer_documents')
      .where({ customer_id: req.customerId })
      .orderBy('created_at', 'desc');

    // Get completed service records for auto-generated docs
    const services = await db('service_records')
      .where({ customer_id: req.customerId, status: 'completed' })
      .leftJoin('technicians', 'service_records.technician_id', 'technicians.id')
      .select('service_records.id', 'service_records.service_date', 'service_records.service_type', 'technicians.name as technician_name')
      .orderBy('service_records.service_date', 'desc');

    // Auto-generate pesticide_record and service_report entries for services
    // that don't already have linked documents
    const linkedServiceIds = new Set(docs.filter(d => d.linked_service_record_id).map(d => d.linked_service_record_id));

    const autoGenDocs = [];
    for (const svc of services) {
      // Pesticide Record
      if (!linkedServiceIds.has(svc.id) || !docs.find(d => d.linked_service_record_id === svc.id && d.document_type === 'pesticide_record')) {
        autoGenDocs.push({
          id: `auto_pesticide_${svc.id}`,
          documentType: 'pesticide_record',
          title: `Pesticide Application — ${svc.service_type}`,
          description: `Products applied during ${svc.service_type} by ${svc.technician_name || 'Waves Team'}`,
          fileName: `Pesticide_Record_${svc.service_date}.pdf`,
          uploadedBy: 'auto_generated',
          linkedServiceRecordId: svc.id,
          serviceDate: svc.service_date,
          createdAt: svc.service_date,
          isAutoGenerated: true,
          downloadUrl: `/api/documents/service-report/${svc.id}`,
        });
      }

      // Service Report
      if (!linkedServiceIds.has(svc.id) || !docs.find(d => d.linked_service_record_id === svc.id && d.document_type === 'service_report')) {
        autoGenDocs.push({
          id: `auto_report_${svc.id}`,
          documentType: 'service_report',
          title: `Visit Report — ${svc.service_type}`,
          description: `Full service summary for ${formatDate(svc.service_date)}`,
          fileName: `Service_Report_${svc.service_date}.pdf`,
          uploadedBy: 'auto_generated',
          linkedServiceRecordId: svc.id,
          serviceDate: svc.service_date,
          createdAt: svc.service_date,
          isAutoGenerated: true,
          downloadUrl: `/api/documents/service-report/${svc.id}`,
        });
      }
    }

    // Format uploaded docs
    const formattedDocs = docs.map(d => ({
      id: d.id,
      documentType: d.document_type,
      title: d.title,
      description: d.description,
      fileName: d.file_name,
      fileSizeBytes: d.file_size_bytes,
      uploadedBy: d.uploaded_by,
      linkedServiceRecordId: d.linked_service_record_id,
      expirationDate: d.expiration_date,
      isSharedWithThirdParty: d.is_shared_with_third_party,
      createdAt: d.created_at,
      isAutoGenerated: false,
      downloadUrl: `/api/documents/${d.id}/download`,
    }));

    // Group by type
    const allDocs = [...formattedDocs, ...autoGenDocs];
    const grouped = {};
    for (const d of allDocs) {
      if (!grouped[d.documentType]) grouped[d.documentType] = [];
      grouped[d.documentType].push(d);
    }

    res.json({ documents: grouped, total: allDocs.length });
  } catch (err) {
    next(err);
  }
});

// =========================================================================
// GET /api/documents/service-report/:serviceRecordId — auto-generate PDF
// =========================================================================
router.get('/service-report/:serviceRecordId', authenticate, async (req, res, next) => {
  try {
    const service = await db('service_records')
      .where({ 'service_records.id': req.params.serviceRecordId, 'service_records.customer_id': req.customerId })
      .leftJoin('technicians', 'service_records.technician_id', 'technicians.id')
      .select('service_records.*', 'technicians.name as technician_name')
      .first();

    if (!service) return res.status(404).json({ error: 'Service record not found' });

    const products = await db('service_products')
      .where({ service_record_id: service.id });

    const customer = req.customer;
    generateServiceReportPDF(customer, service, products, res);
  } catch (err) {
    next(err);
  }
});

// =========================================================================
// GET /api/documents/:id/download — download uploaded document
// =========================================================================
router.get('/:id/download', authenticate, async (req, res, next) => {
  try {
    const doc = await db('customer_documents')
      .where({ id: req.params.id, customer_id: req.customerId })
      .first();

    if (!doc) return res.status(404).json({ error: 'Document not found' });

    // For S3 docs, would generate presigned URL here
    // For now, return a placeholder response
    res.json({
      message: 'S3 download will be available when storage is connected',
      fileName: doc.file_name,
      documentType: doc.document_type,
    });
  } catch (err) {
    next(err);
  }
});

// =========================================================================
// POST /api/documents/share/:id — generate temp public link
// =========================================================================
router.post('/share/:id', authenticate, async (req, res, next) => {
  try {
    const docId = req.params.id;
    const isAutoGen = docId.startsWith('auto_');

    if (!isAutoGen) {
      const doc = await db('customer_documents')
        .where({ id: docId, customer_id: req.customerId })
        .first();
      if (!doc) return res.status(404).json({ error: 'Document not found' });

      // Mark as shared
      await db('customer_documents')
        .where({ id: docId })
        .update({ is_shared_with_third_party: true });
    }

    // Generate share token
    const shareToken = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date();
    expiresAt.setHours(expiresAt.getHours() + 24);

    await db('document_share_links').insert({
      document_id: isAutoGen ? null : docId,
      share_token: shareToken,
      expires_at: expiresAt,
    });

    // In production this would be a full URL to a public endpoint
    const shareLink = `https://portal.wavespestcontrol.com/shared/${shareToken}`;

    res.json({
      success: true,
      shareLink,
      expiresAt: expiresAt.toISOString(),
      expiresIn: '24 hours',
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
