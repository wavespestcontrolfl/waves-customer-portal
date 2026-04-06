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

function sectionHeader(doc, title, x, y, w) {
  const width = w || 512;
  doc.save();
  doc.roundedRect(x, y, width, 22, 3).fill(NAVY);
  doc.fontSize(9).font('Helvetica-Bold').fillColor('#fff').text(title.toUpperCase(), x + 10, y + 6, { width: width - 20 });
  doc.restore();
  return y + 28;
}

function infoRow(doc, label, value, x, y, labelW, valW) {
  doc.fontSize(9).font('Helvetica-Bold').fillColor('#555').text(label, x, y, { width: labelW });
  doc.font('Helvetica').fillColor('#222').text(value || '—', x + labelW, y, { width: valW });
  return y + 14;
}

// Map product categories to customer-friendly descriptions
function friendlyProductDescription(category) {
  const map = {
    'insecticide': 'Insect barrier treatment',
    'herbicide': 'Weed control',
    'fungicide': 'Fungus prevention',
    'fertilizer': 'Lawn nutrition',
    'larvicide': 'Mosquito breeding prevention',
    'rodenticide': 'Rodent control',
    'growth regulator': 'Growth regulation',
    'surfactant': 'Application enhancer',
    'adjuvant': 'Application enhancer',
  };
  if (!category) return '—';
  return map[category.toLowerCase()] || category;
}

// Get aftercare tips based on service type
function getAftercareTips(serviceType) {
  if (!serviceType) return 'Allow treated areas to dry completely before contact. Call us with any questions.';
  const st = serviceType.toLowerCase();
  if (st.includes('mosquito')) {
    return 'Barrier effective 21-30 days. Empty standing water weekly to reduce breeding sites. Reapplication recommended before outdoor events.';
  }
  if (st.includes('lawn') || st.includes('fertiliz') || st.includes('weed') || st.includes('turf')) {
    return 'Avoid mowing for 48 hours. Water as usual unless otherwise noted. Greening expected in 7-10 days. Weed yellowing begins in 5-7 days.';
  }
  // Default to pest
  return 'Treated areas dry in 30-45 min. Safe for pets and children once dry. Minor pest activity may continue 7-14 days as product takes full effect.';
}

// Calculate visit duration from available data
function getVisitDuration(service) {
  if (service.actual_duration_minutes) return service.actual_duration_minutes;
  if (service.check_in_time && service.check_out_time) {
    const inTime = new Date(service.check_in_time);
    const outTime = new Date(service.check_out_time);
    const diffMs = outTime - inTime;
    if (diffMs > 0) return Math.round(diffMs / 60000);
  }
  return null;
}

function generateServiceReportPDF(customer, service, products, res) {
  const doc = new PDFDocument({ size: 'LETTER', margin: 40 });

  // Build filename: Waves_FirstName_LastName_MonthDay_Year.pdf
  const svcDate = new Date(typeof service.service_date === 'string' ? service.service_date + 'T12:00:00' : service.service_date);
  const monthDay = `${String(svcDate.getMonth() + 1).padStart(2, '0')}${String(svcDate.getDate()).padStart(2, '0')}`;
  const year = svcDate.getFullYear();
  const fileName = `Waves_${customer.first_name}_${customer.last_name}_${monthDay}_${year}.pdf`;

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
  doc.pipe(res);

  const L = 40, R = 572, W = R - L;
  const customerName = `${customer.first_name} ${customer.last_name}`;
  const visitDuration = getVisitDuration(service);
  const isCallback = service.is_callback || (service.service_type && service.service_type.toLowerCase().includes('callback'));

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
  doc.text('Bradenton, FL', R - 150, 48, { width: 150, align: 'right' });
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

  // Visit duration
  if (visitDuration) {
    y2 = infoRow(doc, 'Time on site:', `${visitDuration} minutes`, colMid + 8, y2, 80, 170);
  }

  // WaveGuard tier if available
  if (customer.waveguard_tier) {
    y2 = infoRow(doc, 'Plan:', `WaveGuard ${customer.waveguard_tier}`, colMid + 8, y2, 80, 170);
  }

  y = Math.max(y, y2) + 12;

  // ══════════════════════════════════════════════════════
  // PROPERTY SNAPSHOT — light blue bar with key-value pairs
  // ══════════════════════════════════════════════════════
  const snapshotItems = [];
  if (customer.lawn_type) snapshotItems.push({ label: 'Lawn Type', value: customer.lawn_type });
  if (customer.property_sqft) snapshotItems.push({ label: 'Treated Area', value: `${Number(customer.property_sqft).toLocaleString()} sq ft` });
  if (customer.waveguard_tier) snapshotItems.push({ label: 'WaveGuard', value: customer.waveguard_tier });
  if (visitDuration) snapshotItems.push({ label: 'Visit Duration', value: `${visitDuration} min` });

  if (snapshotItems.length) {
    y = sectionHeader(doc, 'Property Snapshot', L, y);
    doc.save();
    doc.roundedRect(L, y, W, 24, 3).fill('#D6EAF8');
    const snapColW = W / snapshotItems.length;
    snapshotItems.forEach((item, i) => {
      const xPos = L + i * snapColW + 12;
      doc.fontSize(7).font('Helvetica').fillColor('#555').text(item.label, xPos, y + 3, { width: snapColW - 20 });
      doc.fontSize(10).font('Helvetica-Bold').fillColor(NAVY).text(item.value, xPos, y + 13, { width: snapColW - 20 });
    });
    doc.restore();
    y += 34;
  }

  // ══════════════════════════════════════════════════════
  // WAVEGUARD CALLBACK CALLOUT
  // ══════════════════════════════════════════════════════
  if (isCallback) {
    if (y > 680) { doc.addPage(); y = 50; }
    doc.save();
    doc.roundedRect(L, y, W, 30, 4).fill('#E8F5E9');
    doc.roundedRect(L, y, 4, 30, 2).fill(GREEN);
    doc.fontSize(9).font('Helvetica-Bold').fillColor('#2E7D32').text(
      'This callback visit was included at no additional charge with your WaveGuard membership.',
      L + 14, y + 9, { width: W - 28 }
    );
    doc.restore();
    y += 40;
  }

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
    doc.rect(L, y, W, 26).fill(LIGHT_BG);
    const mColW = W / measurements.length;
    measurements.forEach((m, i) => {
      doc.fontSize(8).font('Helvetica-Bold').fillColor('#555').text(m.label, L + i * mColW + 10, y + 2, { width: mColW - 20 });
      doc.fontSize(10).font('Helvetica-Bold').fillColor(NAVY).text(m.value, L + i * mColW + 10, y + 12, { width: mColW - 20 });
    });
    doc.restore();
    y += 34;
  }

  // ══════════════════════════════════════════════════════
  // PRODUCTS APPLIED — customer-friendly table
  // ══════════════════════════════════════════════════════
  if (products.length) {
    y = sectionHeader(doc, 'Products Applied', L, y);

    // Table header — customer-friendly columns
    const cols = [L + 4, L + 180, L + 350, L + 460];
    const colLabels = ['Product Name', 'What It Does', 'Area / Method', 'Rate'];

    doc.save();
    doc.rect(L, y, W, 16).fill('#E8EDF2');
    doc.fontSize(8).font('Helvetica-Bold').fillColor('#444');
    colLabels.forEach((lbl, i) => doc.text(lbl, cols[i], y + 4));
    doc.restore();
    y += 18;

    products.forEach((p, i) => {
      if (y > 680) { doc.addPage(); y = 50; }
      const rowH = p.active_ingredient ? 28 : 18;
      const bg = i % 2 === 0 ? '#fff' : LIGHT_BG;
      doc.save();
      doc.rect(L, y, W, rowH).fill(bg);
      // Product name (bold)
      doc.fontSize(8).font('Helvetica-Bold').fillColor('#333');
      doc.text(p.product_name || '', cols[0], y + 4, { width: 170 });
      // Active ingredient in small text below product name
      if (p.active_ingredient) {
        doc.fontSize(6.5).font('Helvetica').fillColor('#888');
        doc.text(`Active: ${p.active_ingredient}`, cols[0], y + 16, { width: 170 });
      }
      // What It Does — friendly description from category
      doc.fontSize(8).font('Helvetica').fillColor('#333');
      doc.text(friendlyProductDescription(p.product_category), cols[1], y + 4, { width: 165 });
      // Area / Method
      doc.text(p.application_method || p.target_area || '—', cols[2], y + 4, { width: 105 });
      // Rate
      doc.text(p.application_rate ? `${p.application_rate} ${p.rate_unit || ''}`.trim() : '—', cols[3], y + 4, { width: 80 });
      doc.restore();
      y += rowH;
    });
    y += 10;
  }

  // ══════════════════════════════════════════════════════
  // STRUCTURED TECH NOTES — What We Did / Found / Next
  // ══════════════════════════════════════════════════════
  const notes = (service.technician_notes || '').trim();
  let fieldObs = null;
  if (service.field_flags) {
    try {
      const parsed = typeof service.field_flags === 'string' ? JSON.parse(service.field_flags) : service.field_flags;
      if (Object.keys(parsed).length) fieldObs = parsed;
    } catch { /* ignore */ }
  }

  // "What We Did" section
  if (notes) {
    if (y > 620) { doc.addPage(); y = 50; }
    y = sectionHeader(doc, 'What We Did', L, y);
    // If notes are long (>= 100 chars), use first 2/3 for "What We Did"
    let whatWeDid = notes;
    if (notes.length >= 100) {
      const splitIdx = Math.floor(notes.length * 0.67);
      // Try to split at a sentence boundary
      const sentenceEnd = notes.lastIndexOf('.', splitIdx);
      whatWeDid = sentenceEnd > splitIdx * 0.5 ? notes.substring(0, sentenceEnd + 1) : notes.substring(0, splitIdx);
    }
    doc.fontSize(9).font('Helvetica').fillColor('#333').text(whatWeDid.trim(), L + 8, y, {
      width: W - 16, lineGap: 3,
    });
    y = doc.y + 12;
  }

  // "What We Found" section — from field_flags or remaining notes
  const hasObservations = fieldObs || (notes.length >= 100);
  if (hasObservations) {
    if (y > 660) { doc.addPage(); y = 50; }
    y = sectionHeader(doc, 'What We Found', L, y);
    if (fieldObs) {
      Object.entries(fieldObs).forEach(([key, val]) => {
        if (y > 700) { doc.addPage(); y = 50; }
        doc.fontSize(9).font('Helvetica-Bold').fillColor('#555').text(`${key}:`, L + 8, y, { width: 140, continued: false });
        doc.font('Helvetica').fillColor('#333').text(` ${val}`, L + 8 + doc.widthOfString(`${key}: `), y, { width: W - 30 });
        y += 14;
      });
    }
    // If notes were long, show the remainder here
    if (notes.length >= 100) {
      const splitIdx = Math.floor(notes.length * 0.67);
      const sentenceEnd = notes.lastIndexOf('.', splitIdx);
      const cutoff = sentenceEnd > splitIdx * 0.5 ? sentenceEnd + 1 : splitIdx;
      const remainder = notes.substring(cutoff).trim();
      if (remainder) {
        doc.fontSize(9).font('Helvetica').fillColor('#333').text(remainder, L + 8, y, {
          width: W - 16, lineGap: 3,
        });
        y = doc.y + 6;
      }
    }
    y += 6;
  }

  // "What's Next" section — aftercare tips based on service type
  if (y > 660) { doc.addPage(); y = 50; }
  y = sectionHeader(doc, "What's Next", L, y);
  doc.save();
  doc.roundedRect(L, y, W, 36, 3).fill('#F0FAF0');
  doc.roundedRect(L, y, 4, 36, 2).fill(GREEN);
  doc.fontSize(9).font('Helvetica').fillColor('#333').text(
    getAftercareTips(service.service_type),
    L + 14, y + 6, { width: W - 28, lineGap: 3 }
  );
  doc.restore();
  y += 46;

  // ══════════════════════════════════════════════════════
  // SAFETY NOTICE
  // ══════════════════════════════════════════════════════
  if (y > 680) { doc.addPage(); y = 50; }
  doc.save();
  doc.roundedRect(L, y, W, 28, 3).fill('#FFF8E1');
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
  // FOOTER — enhanced with full business details
  // ══════════════════════════════════════════════════════
  doc.save();
  doc.rect(0, 730, 612, 62).fill(NAVY);
  doc.fontSize(9).font('Helvetica-Bold').fillColor('#fff').text(
    'Waves Pest Control, LLC · FL License #JF336375',
    0, 738, { width: 612, align: 'center' }
  );
  doc.fontSize(7).font('Helvetica').fillColor('#ccc').text(
    '13649 Luxe Ave #110, Bradenton, FL 34211 · (941) 318-7612',
    0, 752, { width: 612, align: 'center' }
  );
  doc.text(
    'wavespestcontrol.com · View this report in your Waves portal',
    0, 763, { width: 612, align: 'center' }
  );
  doc.fontSize(7).fillColor('#999').text(
    'National Pest Emergency Poison Control: (800) 222-1222',
    0, 774, { width: 612, align: 'center' }
  );
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
