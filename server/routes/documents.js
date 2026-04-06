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
// Waves brand colors
const NAVY = '#1B2A4A';
const TEAL = '#0ea5e9';
const GREEN = '#10b981';
const RED = '#A83B34';
const LIGHT_BG = '#F0F7FC';

function sectionHeader(doc, title, x, y) {
  const w = 512;
  doc.save();
  doc.roundedRect(x, y, w, 22, 3).fill(NAVY);
  doc.fontSize(9).font('Helvetica-Bold').fillColor('#fff').text(title.toUpperCase(), x + 10, y + 6, { width: w - 20 });
  doc.restore();
  return y + 28;
}

function infoRow(doc, label, value, x, y, labelW, valW) {
  doc.fontSize(9).font('Helvetica-Bold').fillColor('#555').text(label, x, y, { width: labelW });
  doc.font('Helvetica').fillColor('#222').text(value || '—', x + labelW, y, { width: valW });
  return y + 14;
}

function generateServiceReportPDF(customer, service, products, res) {
  const doc = new PDFDocument({ size: 'LETTER', margin: 40 });

  const customerName = `${customer.first_name} ${customer.last_name}`;
  const dateSlug = formatDate(service.service_date).replace(/[^a-zA-Z0-9]/g, '');
  const nameSlug = customerName.replace(/\s+/g, '_');
  const fileName = `Waves_${nameSlug}_${dateSlug}.pdf`;

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
  doc.pipe(res);

  const L = 40, R = 572, W = R - L;

  // ══════════════════════════════════════════════════════
  // HEADER BAR — navy background with white text
  // ══════════════════════════════════════════════════════
  doc.save();
  doc.rect(0, 0, 612, 80).fill(NAVY);
  doc.fontSize(22).font('Helvetica-Bold').fillColor('#fff').text('WAVES', L + 10, 18);
  doc.fontSize(9).font('Helvetica').fillColor(TEAL).text('LAWN & PEST CONTROL', L + 10, 42);
  doc.fontSize(8).fillColor('#ccc').text('Licensed & Insured | FL License #JF336375', L + 10, 56);

  // Right side — contact info
  doc.fontSize(9).font('Helvetica-Bold').fillColor('#fff').text('(941) 318-7612', R - 150, 22, { width: 150, align: 'right' });
  doc.fontSize(8).font('Helvetica').fillColor('#ccc').text('wavespestcontrol.com', R - 150, 36, { width: 150, align: 'right' });
  doc.text('Lakewood Ranch, FL', R - 150, 48, { width: 150, align: 'right' });
  doc.restore();

  // ══════════════════════════════════════════════════════
  // TITLE BAR
  // ══════════════════════════════════════════════════════
  doc.save();
  doc.rect(L, 90, W, 28).fill(TEAL);
  doc.fontSize(13).font('Helvetica-Bold').fillColor('#fff').text('SERVICE REPORT', L + 12, 96);
  doc.fontSize(9).font('Helvetica').fillColor('#ffffffcc').text(formatDate(service.service_date), R - 200, 98, { width: 188, align: 'right' });
  doc.restore();

  // ══════════════════════════════════════════════════════
  // CUSTOMER & SERVICE INFO — two-column grid
  // ══════════════════════════════════════════════════════
  let y = 130;
  const colMid = L + W / 2 + 10;

  // Left column — Customer
  y = sectionHeader(doc, 'Customer Information', L, y);
  y = infoRow(doc, 'Name:', customerName, L + 8, y, 70, 180);
  y = infoRow(doc, 'Address:', customer.address_line1 || '', L + 8, y, 70, 180);
  y = infoRow(doc, 'City:', `${customer.city || ''}, ${customer.state || 'FL'} ${customer.zip || ''}`, L + 8, y, 70, 180);
  y = infoRow(doc, 'Phone:', customer.phone || '', L + 8, y, 70, 180);
  if (customer.email) y = infoRow(doc, 'Email:', customer.email, L + 8, y, 70, 180);

  // Right column — Service (placed at same starting Y as customer)
  let y2 = 130;
  y2 = sectionHeader(doc, 'Service Information', colMid, y2);
  y2 = infoRow(doc, 'Date:', formatDate(service.service_date), colMid + 8, y2, 80, 170);
  y2 = infoRow(doc, 'Service:', service.service_type, colMid + 8, y2, 80, 170);
  y2 = infoRow(doc, 'Technician:', service.technician_name || 'Waves Team', colMid + 8, y2, 80, 170);
  y2 = infoRow(doc, 'Status:', service.status === 'completed' ? 'Completed' : service.status, colMid + 8, y2, 80, 170);

  // WaveGuard tier if available
  if (customer.waveguard_tier) {
    y2 = infoRow(doc, 'Plan:', `WaveGuard ${customer.waveguard_tier}`, colMid + 8, y2, 80, 170);
  }

  y = Math.max(y, y2) + 12;

  // ══════════════════════════════════════════════════════
  // MEASUREMENTS (if lawn)
  // ══════════════════════════════════════════════════════
  const measurements = [];
  if (service.soil_temp) measurements.push({ label: 'Soil Temp', value: `${service.soil_temp}°F` });
  if (service.thatch_measurement) measurements.push({ label: 'Thatch', value: `${service.thatch_measurement}"` });
  if (service.soil_ph) measurements.push({ label: 'Soil pH', value: `${service.soil_ph}` });
  if (service.soil_moisture) measurements.push({ label: 'Moisture', value: `${service.soil_moisture}` });

  if (measurements.length) {
    y = sectionHeader(doc, 'Lawn Measurements', L, y);
    doc.save();
    doc.rect(L, y, W, 20).fill(LIGHT_BG);
    const mColW = W / measurements.length;
    measurements.forEach((m, i) => {
      doc.fontSize(8).font('Helvetica-Bold').fillColor('#555').text(m.label, L + i * mColW + 10, y + 2, { width: mColW - 20 });
      doc.fontSize(10).font('Helvetica-Bold').fillColor(NAVY).text(m.value, L + i * mColW + 10, y + 12, { width: mColW - 20 });
    });
    doc.restore();
    y += 30;
  }

  // ══════════════════════════════════════════════════════
  // PRODUCTS APPLIED — styled table
  // ══════════════════════════════════════════════════════
  if (products.length) {
    y = sectionHeader(doc, 'Products Applied', L, y);

    // Table header
    const cols = [L + 4, L + 160, L + 310, L + 400, L + 470];
    const colLabels = ['Product', 'Active Ingredient', 'Rate', 'MOA Group', 'Method'];

    doc.save();
    doc.rect(L, y, W, 16).fill('#E8EDF2');
    doc.fontSize(8).font('Helvetica-Bold').fillColor('#444');
    colLabels.forEach((lbl, i) => doc.text(lbl, cols[i], y + 4));
    doc.restore();
    y += 18;

    products.forEach((p, i) => {
      if (y > 700) { doc.addPage(); y = 50; }
      const bg = i % 2 === 0 ? '#fff' : LIGHT_BG;
      doc.save();
      doc.rect(L, y, W, 16).fill(bg);
      doc.fontSize(8).font('Helvetica').fillColor('#333');
      doc.text(p.product_name || '', cols[0], y + 4, { width: 150 });
      doc.text(p.active_ingredient || '—', cols[1], y + 4, { width: 145 });
      doc.text(p.application_rate ? `${p.application_rate} ${p.rate_unit || ''}` : '—', cols[2], y + 4, { width: 85 });
      doc.text(p.moa_group || '—', cols[3], y + 4, { width: 65 });
      doc.text(p.product_category || '—', cols[4], y + 4, { width: 90 });
      doc.restore();
      y += 16;
    });
    y += 10;
  }

  // ══════════════════════════════════════════════════════
  // TECHNICIAN COMMENTS — the AI tactical debrief
  // ══════════════════════════════════════════════════════
  if (service.technician_notes) {
    if (y > 620) { doc.addPage(); y = 50; }
    y = sectionHeader(doc, 'Technician Comments', L, y);
    doc.fontSize(10).font('Helvetica').fillColor('#333').text(service.technician_notes, L + 8, y, {
      width: W - 16, lineGap: 4,
    });
    y = doc.y + 14;
  }

  // ══════════════════════════════════════════════════════
  // FIELD OBSERVATIONS
  // ══════════════════════════════════════════════════════
  if (service.field_flags) {
    try {
      const flags = typeof service.field_flags === 'string' ? JSON.parse(service.field_flags) : service.field_flags;
      if (Object.keys(flags).length) {
        if (y > 660) { doc.addPage(); y = 50; }
        y = sectionHeader(doc, 'Field Observations', L, y);
        Object.entries(flags).forEach(([key, val]) => {
          doc.fontSize(9).font('Helvetica').fillColor('#333').text(`${key}: ${val}`, L + 8, y);
          y += 14;
        });
        y += 6;
      }
    } catch { /* ignore */ }
  }

  // ══════════════════════════════════════════════════════
  // SAFETY NOTICE
  // ══════════════════════════════════════════════════════
  if (y > 680) { doc.addPage(); y = 50; }
  doc.save();
  doc.rect(L, y, W, 28).fill('#FFF8E1');
  doc.fontSize(8).font('Helvetica-Bold').fillColor('#B8860B').text(
    'SAFETY: Keep people and pets away from treated surfaces until dry. Do not contact treated surfaces until dry.',
    L + 10, y + 6, { width: W - 20 }
  );
  doc.fontSize(7).font('Helvetica').fillColor('#B8860B').text(
    'National Pest Emergency Poison Control: (800) 222-1222',
    L + 10, y + 18, { width: W - 20 }
  );
  doc.restore();
  y += 36;

  // ══════════════════════════════════════════════════════
  // FOOTER
  // ══════════════════════════════════════════════════════
  doc.save();
  doc.rect(0, 730, 612, 62).fill(NAVY);
  doc.fontSize(9).font('Helvetica-Bold').fillColor('#fff').text('Waves Lawn & Pest Control', L + 10, 740);
  doc.fontSize(7).font('Helvetica').fillColor('#aaa');
  doc.text('13649 Luxe Ave #110, Bradenton, FL 34211 | (941) 318-7612 | wavespestcontrol.com', L + 10, 754);
  doc.text('Questions or requests? Reply to your service text or call us anytime.', L + 10, 766);
  doc.fontSize(7).fillColor('#666').text('Thank you for choosing Waves!', R - 180, 754, { width: 168, align: 'right' });
  doc.restore();

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

    // Auto-generate service_report entries for completed services
    const linkedServiceIds = new Set(docs.filter(d => d.linked_service_record_id).map(d => d.linked_service_record_id));

    const autoGenDocs = [];
    for (const svc of services) {
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
